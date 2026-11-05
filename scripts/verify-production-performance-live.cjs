#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { parseDockerByteSize, percentile, parsePrometheusSample, runBounded, stripAnsiControls } = require('./production-performance-lib.cjs');

if (!process.argv.includes('--allow-live-test')) {
  console.error('Refusing the disposable production performance drill without --allow-live-test.');
  process.exit(2);
}

const REQUESTS = 240;
const CONCURRENCY = 12;
const WARMUPS = 24;
const MIB = 1024 * 1024;
const nonce = crypto.randomBytes(6).toString('hex');
const project = `kfive-performance-test-${nonce}`;
const backendImage = `kfive-ai-backend:performance-${nonce}`;
const fixtureImage = `kfive-ai-provider-fixture:performance-${nonce}`;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kfive-performance-live-'));
const envFile = path.join(tempRoot, 'performance.env');
const overrideFile = path.join(tempRoot, 'performance-override.yml');
const composeFiles = ['docker-compose.production.yml', 'docker-compose.production.acceptance.yml', overrideFile];
const volumeNames = ['mongodb_data', 'redis_data', 'chromadb_data', 'backend_uploads', 'backend_logs'].map((suffix) => `${project}_${suffix}`);
const protectedVolumes = ['kfive-ai_mongodb_data', 'kfive-ai_redis_data', 'kfive-ai_chromadb_data', 'kfive-ai_backend_uploads', 'kfive-ai_backend_logs', 'kfive-ai_ollama_bridge_socket'];
const cleanupErrors = [];

function docker(args, options = {}) {
  const output = execFileSync('docker', args, { encoding: 'utf8', stdio: options.stdio || ['ignore', 'pipe', 'pipe'], timeout: options.timeout || 180_000, maxBuffer: 64 * MIB });
  return typeof output === 'string' ? output.trim() : '';
}
function compose(args, options = {}) { return docker(['compose', '--env-file', envFile, '-p', project, ...composeFiles.flatMap((file) => ['-f', file]), ...args], options); }
function errorText(error) { return `${String(error.stderr || '')}\n${String(error.stdout || '')}\n${String(error.message || error)}`; }
function request(port, route, { method = 'GET', body, token, agent, timeout = 10_000 } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, timeout, agent,
      headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } },
    (response) => { const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), durationMs: Number(process.hrtime.bigint() - started) / 1e6 })); });
    req.once('timeout', () => req.destroy(new Error(`${method} ${route} timed out`))); req.once('error', reject); if (payload) req.write(payload); req.end();
  });
}
function json(response) { return JSON.parse(response.body); }
async function retry(action, attempts = 50) { let last; for (let i = 0; i < attempts; i += 1) { try { return await action(); } catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 1000)); } } throw last; }
function existingVolumeIdentity(names) { const result = {}; for (const name of names) { try { const item = JSON.parse(docker(['volume', 'inspect', name]))[0]; result[name] = `${item.Name}:${item.CreatedAt}:${item.Mountpoint}`; } catch (error) { if (!/no such volume/i.test(errorText(error))) throw error; } } return result; }
function removeOwnedVolumes() { for (const name of volumeNames) { try { const item = JSON.parse(docker(['volume', 'inspect', name]))[0]; assert.equal(item.Labels?.['com.docker.compose.project'], project, `refusing foreign volume ${name}`); docker(['volume', 'rm', name]); } catch (error) { if (!/no such volume/i.test(errorText(error))) throw error; } } }
function removeExactImage(name, requireLabel = false) { try { const item = JSON.parse(docker(['image', 'inspect', name]))[0]; assert.ok((item.RepoTags || []).includes(name)); if (requireLabel) assert.equal(item.Config?.Labels?.['kfive.verifier'], project); docker(['image', 'rm', name]); } catch (error) { if (!/no such image/i.test(errorText(error))) throw error; } }
function assertImageAbsent(name) { try { docker(['image', 'inspect', name]); throw new Error(`refusing pre-existing image ${name}`); } catch (error) { if (!/no such image/i.test(errorText(error))) throw error; } }
function assertProjectAbsent() {
  assert.equal(docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]), '', 'refusing pre-existing project containers');
  assert.equal(docker(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '', 'refusing pre-existing project networks');
  assert.deepEqual(existingVolumeIdentity(volumeNames), {}, 'refusing pre-existing project volumes');
  assertImageAbsent(backendImage); assertImageAbsent(fixtureImage);
}
function inspectBackend() { const id = compose(['ps', '-q', 'backend']); assert.match(id, /^[a-f0-9]{12,64}$/); return JSON.parse(docker(['inspect', id]))[0]; }
function assertBackendLimits(item) {
  assert.equal(item.HostConfig.Memory, 1024 ** 3); assert.equal(item.HostConfig.NanoCpus, 2_000_000_000); assert.equal(item.HostConfig.PidsLimit, 192);
  assert.equal(item.HostConfig.ReadonlyRootfs, true); assert.deepEqual(item.HostConfig.CapDrop, ['ALL']); assert.ok(item.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  assert.ok(Object.values(item.NetworkSettings.Ports || {}).every((bindings) => bindings === null)); assert.equal(item.Config.Env.includes('RATE_LIMIT_MAX_REQUESTS=1000'), true);
}
function scrapeMetrics() {
  return docker(['run', '--rm', '--network', `${project}_app_internal`, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=8m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--entrypoint', 'node', backendImage, '-e',
    "fetch('http://backend:5000/metrics').then(async r=>{if(!r.ok)throw new Error(String(r.status));process.stdout.write(await r.text())}).catch(e=>{console.error(e);process.exit(1)})"]);
}
function metricSnapshot(body) {
  const requestSample = 'kfive_http_requests_total{method="GET",path="/api/v1/user/profile",status_code="200"}';
  const durationSample = 'kfive_http_request_duration_seconds_count{method="GET",path="/api/v1/user/profile"}';
  const allStatuses = body.split(/\r?\n/).filter((line) => line.startsWith('kfive_http_requests_total{method="GET",path="/api/v1/user/profile",status_code="'))
    .reduce((sum, line) => { const value = Number(line.slice(line.lastIndexOf(' ') + 1)); assert.ok(Number.isFinite(value)); return sum + value; }, 0);
  return { success: parsePrometheusSample(body, requestSample, { absentValue: 0 }), allStatuses,
    durations: parsePrometheusSample(body, durationSample, { absentValue: 0 }), rss: parsePrometheusSample(body, 'process_resident_memory_bytes'), heap: parsePrometheusSample(body, 'process_heap_used_bytes') };
}
async function startStats(containerId) {
  const child = spawn('docker', ['stats', '--format', '{{json .}}', containerId], { stdio: ['ignore', 'pipe', 'pipe'] });
  const samples = []; let buffer = ''; let stderr = ''; let streamError;
  let resolveFirst; let rejectFirst;
  const firstSample = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', (error) => { streamError = error; rejectFirst(error); });
  child.stdout.on('data', (chunk) => { try { buffer += chunk; let index; while ((index = buffer.indexOf('\n')) >= 0) { const line = stripAnsiControls(buffer.slice(0, index)).trim(); buffer = buffer.slice(index + 1); if (line) { const item = JSON.parse(line); const sample = { memoryBytes: parseDockerByteSize(item.MemUsage.split(' / ')[0]), pids: Number(item.PIDs), cpu: item.CPUPerc }; assert.ok(Number.isInteger(sample.pids) && sample.pids >= 0); samples.push(sample); resolveFirst(); } } } catch (error) { streamError = error; rejectFirst(error); child.kill('SIGTERM'); } });
  await Promise.race([firstSample, new Promise((_, reject) => setTimeout(() => reject(new Error(`docker stats did not sample: ${stderr}`)), 5000))]);
  return {
    samples,
    waitForSampleAfter: async (previousCount) => {
      const started = Date.now();
      while (samples.length <= previousCount) {
        if (streamError) throw streamError;
        if (Date.now() - started > 5000) throw new Error(`docker stats did not produce a post-start sample: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    stop: async () => { child.kill('SIGTERM'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]); if (streamError) throw streamError; },
  };
}

async function main() {
  const protectedBefore = existingVolumeIdentity(protectedVolumes); const port = crypto.randomInt(15_000, 55_000);
  const secrets = { root: `r${crypto.randomBytes(18).toString('base64url')}`, app: `a${crypto.randomBytes(18).toString('base64url')}`, redis: `d${crypto.randomBytes(18).toString('base64url')}`, jwt: crypto.randomBytes(32).toString('base64url'), refresh: crypto.randomBytes(32).toString('base64url'), provider: crypto.randomBytes(24).toString('base64url') };
  fs.writeFileSync(envFile, [`KFIVE_PRODUCTION_PROJECT=${project}`, `KFIVE_VOLUME_PREFIX=${project}`, 'KFIVE_EDGE_BIND_ADDRESS=127.0.0.1', `KFIVE_EDGE_HTTP_PORT=${port}`, `KFIVE_FIXTURE_IMAGE=${fixtureImage}`, `KFIVE_FIXTURE_BEARER_TOKEN=${secrets.provider}`, 'KFIVE_MODE=remote', `PUBLIC_BASE_URL=http://127.0.0.1:${port}`, `CORS_ORIGIN=http://127.0.0.1:${port}`, 'TRUST_PROXY_HOPS=1', 'AI_PROVIDER=openai-compatible', 'AI_DEFAULT_MODEL=remote-chat', 'OPENAI_BASE_URL=http://remote-provider-fixture:4010/v1', `OPENAI_API_KEY=${secrets.provider}`, 'OPENAI_COMPATIBLE_SUPPORTS_EMBEDDINGS=false', 'OPENAI_COMPATIBLE_SUPPORTS_STRUCTURED_OUTPUT=false', 'MONGO_ROOT_USERNAME=kfive_root', `MONGO_ROOT_PASSWORD=${secrets.root}`, 'MONGO_DATABASE=kfive_ai', 'MONGO_APP_USERNAME=kfive', `MONGO_APP_PASSWORD=${secrets.app}`, `REDIS_PASSWORD=${secrets.redis}`, `JWT_SECRET=${secrets.jwt}`, `JWT_REFRESH_SECRET=${secrets.refresh}`, `KFIVE_BACKEND_IMAGE=${backendImage}`, 'KFIVE_FRONTEND_IMAGE=kfive-ai-frontend', 'KFIVE_MONGODB_IMAGE=mongo:7.0', 'KFIVE_REDIS_IMAGE=redis:7.2-alpine', 'KFIVE_CHROMADB_IMAGE=chromadb/chroma:0.4.24'].join('\n') + '\n', { mode: 0o600 });
  fs.writeFileSync(overrideFile, `services:\n  mongodb:\n    healthcheck: {disable: true}\n  redis:\n    healthcheck: {disable: true}\n  chromadb:\n    healthcheck: {disable: true}\n  remote-provider-fixture:\n    build:\n      labels:\n        kfive.verifier: ${project}\n    healthcheck: {disable: true}\n  backend:\n    environment:\n      RATE_LIMIT_MAX_REQUESTS: "1000"\n    healthcheck: {disable: true}\n    depends_on:\n      mongodb: {condition: service_started}\n      redis: {condition: service_started}\n      chromadb: {condition: service_started}\n      remote-provider-fixture: {condition: service_started}\n  benchmark-worker:\n    depends_on:\n      mongodb: {condition: service_started}\n      redis: {condition: service_started}\n  frontend:\n    healthcheck: {disable: true}\n    depends_on:\n      backend: {condition: service_started}\n`, { mode: 0o600 });
  const email = `performance-${nonce}@example.invalid`; const password = `Kf!${crypto.randomBytes(18).toString('base64url')}`; const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY, maxFreeSockets: CONCURRENCY }); let stats; let cleanupAuthorized = false;
  try {
    assertProjectAbsent();
    cleanupAuthorized = true;
    docker(['build', '--label', `kfive.verifier=${project}`, '-t', backendImage, '-f', 'backend/Dockerfile', '.'], { stdio: 'inherit', timeout: 600_000 }); compose(['build', 'remote-provider-fixture'], { stdio: 'inherit', timeout: 300_000 }); compose(['up', '-d'], { stdio: 'inherit' });
    const registration = await retry(async () => { const result = await request(port, '/api/v1/auth/register', { method: 'POST', body: { email, username: `performance_${nonce}`, password }, agent }); assert.equal(result.status, 201, result.body); return result; });
    const identity = json(registration).data; const userId = identity.user._id; const validate = (result) => { assert.equal(result.status, 200, result.body); const body = json(result); assert.equal(body.success, true); assert.equal(body.data._id, userId); assert.equal(body.data.email, email); assert.equal(Object.hasOwn(body.data, 'password'), false); assert.equal(Object.hasOwn(body.data, 'refreshTokens'), false); return result.durationMs; };
    await runBounded(Array.from({ length: WARMUPS }), CONCURRENCY, async () => validate(await request(port, '/api/v1/user/profile', { token: identity.accessToken, agent })));
    const backendBefore = inspectBackend(); assertBackendLimits(backendBefore); assert.equal(backendBefore.State.OOMKilled, false); const containerId = backendBefore.Id; const volumesBefore = existingVolumeIdentity(volumeNames); const baseline = metricSnapshot(scrapeMetrics());
    stats = await startStats(containerId); const samplesBeforeWorkload = stats.samples.length; const wallStart = process.hrtime.bigint();
    const durations = await runBounded(Array.from({ length: REQUESTS }), CONCURRENCY, async () => validate(await request(port, '/api/v1/user/profile', { token: identity.accessToken, agent })));
    const elapsedSeconds = Number(process.hrtime.bigint() - wallStart) / 1e9; await stats.waitForSampleAfter(samplesBeforeWorkload); await stats.stop(); const samples = stats.samples; stats = undefined;
    const post = metricSnapshot(scrapeMetrics()); assert.equal(post.success - baseline.success, REQUESTS); assert.equal(post.allStatuses - baseline.allStatuses, REQUESTS); assert.equal(post.durations - baseline.durations, REQUESTS);
    const throughput = REQUESTS / elapsedSeconds; const p50 = percentile(durations, 0.5); const p95 = percentile(durations, 0.95); const p99 = percentile(durations, 0.99); const max = Math.max(...durations);
    assert.ok(throughput >= 20, `throughput ${throughput}`); assert.ok(p95 <= 750, `p95 ${p95}`); assert.ok(p99 <= 1500, `p99 ${p99}`);
    assert.ok(post.rss - baseline.rss <= 128 * MIB); assert.ok(post.heap - baseline.heap <= 64 * MIB); assert.ok(post.rss <= 384 * MIB); assert.ok(post.heap <= 256 * MIB);
    assert.ok(samples.length >= 2); const maxSampledMemory = Math.max(...samples.map((item) => item.memoryBytes)); const maxSampledPids = Math.max(...samples.map((item) => item.pids)); assert.ok(maxSampledMemory <= 512 * MIB); assert.ok(maxSampledPids <= 192);
    const preRestart = inspectBackend(); assert.equal(preRestart.Id, containerId); assert.equal(preRestart.State.Running, true); assert.equal(preRestart.State.OOMKilled, false);
    compose(['restart', 'backend']); await retry(async () => { const ready = await request(port, '/api/v1/readiness', { agent }); assert.equal(ready.status, 200, ready.body); const body = json(ready); assert.equal(body.dependencies.mongodb, 'available'); assert.equal(body.dependencies.redis, 'available'); });
    const login = await request(port, '/api/v1/auth/login', { method: 'POST', body: { email, password }, agent }); assert.equal(login.status, 200, login.body); assert.equal(json(login).data.user._id, userId); validate(await request(port, '/api/v1/user/profile', { token: json(login).data.accessToken, agent }));
    const restarted = inspectBackend(); assertBackendLimits(restarted); assert.equal(restarted.State.OOMKilled, false); assert.deepEqual(existingVolumeIdentity(volumeNames), volumesBefore);
    console.log(JSON.stringify({ nonce, workload: { requests: REQUESTS, concurrency: CONCURRENCY, warmups: WARMUPS }, latencyMs: { p50, p95, p99, max }, throughputPerSecond: throughput, prometheusExactDelta: REQUESTS, memory: { baselineRss: baseline.rss, postRss: post.rss, rssGrowth: post.rss - baseline.rss, baselineHeap: baseline.heap, postHeap: post.heap, heapGrowth: post.heap - baseline.heap, dockerStatsSamples: samples.length, maxSampledContainerBytes: maxSampledMemory, maxSampledPids, cpuSamples: samples.map((item) => item.cpu) }, resourceLimitsEnforced: true, oomKilled: false, restartReadinessLoginProfile: true, volumeObjectsUnchanged: true, topology: 'loopback edge; private API/datastores/metrics helper' }, null, 2));
  } finally {
    agent.destroy(); if (stats) { try { await stats.stop(); } catch (error) { cleanupErrors.push(errorText(error)); } }
    if (cleanupAuthorized) {
      try { compose(['down', '--remove-orphans']); } catch (error) { cleanupErrors.push(errorText(error)); }
      try { removeOwnedVolumes(); } catch (error) { cleanupErrors.push(errorText(error)); }
      try { removeExactImage(backendImage, true); } catch (error) { cleanupErrors.push(errorText(error)); }
      try { removeExactImage(fixtureImage, true); } catch (error) { cleanupErrors.push(errorText(error)); }
      try { assert.equal(docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]), ''); assert.equal(docker(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), ''); assert.deepEqual(existingVolumeIdentity(volumeNames), {}); } catch (error) { cleanupErrors.push(errorText(error)); }
    }
    try { assert.deepEqual(existingVolumeIdentity(protectedVolumes), protectedBefore); } catch (error) { cleanupErrors.push(errorText(error)); }
    fs.rmSync(tempRoot, { recursive: true, force: true }); if (cleanupErrors.length) throw new Error(`Performance verifier cleanup failed:\n${cleanupErrors.join('\n')}`);
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
