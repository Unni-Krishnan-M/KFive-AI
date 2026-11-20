#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  MIB, buildZip, createHostileFixtures, createNearMaximumFixture, createMultipartParts,
  parseCgroupPath, parseCounterFile, parseCpuMax, parseLimit, validateLoopbackApiUrl,
} = require('./repository-importer-resource-lib.cjs');

if (!process.argv.includes('--allow-live-test')) {
  console.error('Refusing the repository importer resource check without --allow-live-test.');
  process.exit(2);
}

const apiUrl = validateLoopbackApiUrl(process.env.KFIVE_LIVE_BASE_URL || 'http://127.0.0.1:3002/api/v1');
const base = apiUrl.href.replace(/\/$/, ''); const nonce = crypto.randomBytes(8).toString('hex');
const directBackend = validateLoopbackApiUrl('http://127.0.0.1:5000/api/v1').href.replace(/\/$/, '');
const protectedVolumes = ['kfive-ai_mongodb_data', 'kfive-ai_redis_data', 'kfive-ai_chromadb_data',
  'kfive-ai_backend_uploads', 'kfive-ai_backend_logs', 'kfive-ai_ollama_bridge_socket'];
const identities = []; const reports = []; let cleanupComplete = false;

function docker(args, timeout = 90_000) {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 16 * MIB }).trim(); }
  catch { throw new Error('Docker verifier operation failed (details suppressed).'); }
}
function dockerCombined(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000, maxBuffer: 16 * MIB });
  if (result.status !== 0 || result.error) throw new Error('Docker verifier operation failed (details suppressed).');
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}
function dockerWithEnvironment(args, environment) {
  const result = spawnSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000, maxBuffer: 16 * MIB,
    env: { PATH: process.env.PATH, ...environment } });
  if (result.status !== 0 || result.error) throw new Error('Docker verifier operation failed (details suppressed).');
  return (result.stdout || '').trim();
}
function containerId(service) { const id = docker(['compose', 'ps', '--all', '-q', service]); assert.match(id, /^[a-f0-9]{12,64}$/); return id; }
function inspect(id) { return JSON.parse(docker(['inspect', id]))[0]; }
function volumeIdentity(name) { return docker(['volume', 'inspect', name, '--format', '{{.Name}}|{{.CreatedAt}}|{{.Mountpoint}}']); }
function protectedIdentities() { return Object.fromEntries(protectedVolumes.map((name) => [name, volumeIdentity(name)])); }

async function request(route, { method = 'GET', token, body, expected = 200, timeoutMs = 90_000 } = {}) {
  const response = await fetch(`${base}${route}`, { method, body, signal: AbortSignal.timeout(timeoutMs), headers: {
    ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}),
  } });
  const result = await response.json(); assert.equal(response.status, expected, `${method} ${route}: ${result.error?.code || 'unexpected response'}`); return result;
}
async function register(label) {
  const email = `repository-resource-${label}-${nonce}@example.invalid`; const password = `Kf!${crypto.randomBytes(24).toString('base64url')}`;
  const result = await request('/auth/register', { method: 'POST', expected: 201,
    body: JSON.stringify({ email, username: `${label}_${nonce}`, password, firstName: 'Resource', lastName: 'Verifier' }) });
  const identity = { label, email, userId: result.data.user._id, token: result.data.accessToken }; assert.match(identity.userId, /^[a-f0-9]{24}$/);
  identities.push(identity); return identity;
}
function responseBody(response) { return new Promise((resolve, reject) => { const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.once('error', reject); response.once('end', () => {
  try { resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { reject(error); }
}); }); }
function holdMultipart(identity, archive, label) {
  const multipart = createMultipartParts({ name: `Resource ${label}`, filename: `resource-${label}.zip`, archive });
  // Nginx deliberately buffers request bodies. Hold the two admitted bodies on
  // the separately loopback-bound backend port, then exercise the third/busy
  // and all completed requests through the normal frontend proxy.
  const requestUrl = new URL(`${directBackend}/repositories/analyses`);
  let responseResolve; let responseReject; const response = new Promise((resolve, reject) => { responseResolve = resolve; responseReject = reject; });
  const req = http.request({ hostname: requestUrl.hostname, port: requestUrl.port, path: requestUrl.pathname, method: 'POST', timeout: 90_000,
    headers: { authorization: `Bearer ${identity.token}`, 'content-type': multipart.contentType, 'content-length': multipart.contentLength } },
  (incoming) => responseBody(incoming).then(responseResolve, responseReject));
  req.once('timeout', () => req.destroy(new Error('Held multipart request timed out.'))); req.once('error', responseReject); req.write(multipart.prefix);
  return { release: () => { req.write(archive); req.end(multipart.suffix); }, destroy: () => req.destroy(), response };
}
function archiveForm(name, archive, filename) { const form = new FormData(); form.append('name', name); form.append('archive', new Blob([archive], { type: 'application/zip' }), filename); return form; }

function cgroupDirectory(pid) {
  const relative = parseCgroupPath(fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8')); const root = fs.realpathSync('/sys/fs/cgroup');
  const directory = fs.realpathSync(path.join(root, relative.slice(1))); if (directory !== root && !directory.startsWith(`${root}${path.sep}`)) throw new Error('Unsafe cgroup path.'); return directory;
}
function readCgroup(directory, file) { return fs.readFileSync(path.join(directory, file), 'utf8'); }
function snapshot(directory) {
  return { memoryCurrent: parseLimit(readCgroup(directory, 'memory.current')), memoryMax: parseLimit(readCgroup(directory, 'memory.max')),
    memoryPeak: parseLimit(readCgroup(directory, 'memory.peak')), memoryEvents: parseCounterFile(readCgroup(directory, 'memory.events')),
    swapCurrent: parseLimit(readCgroup(directory, 'memory.swap.current')), swapMax: parseLimit(readCgroup(directory, 'memory.swap.max')),
    pidsCurrent: parseLimit(readCgroup(directory, 'pids.current')), pidsMax: parseLimit(readCgroup(directory, 'pids.max')),
    pidsPeak: parseLimit(readCgroup(directory, 'pids.peak')), pidsEvents: parseCounterFile(readCgroup(directory, 'pids.events')),
    cpuMax: parseCpuMax(readCgroup(directory, 'cpu.max')), cpuStat: parseCounterFile(readCgroup(directory, 'cpu.stat')) };
}
function commandLines(directory) {
  const output = [];
  for (const value of readCgroup(directory, 'cgroup.procs').trim().split(/\s+/)) {
    if (!/^[0-9]+$/.test(value)) continue;
    try { output.push(fs.readFileSync(`/proc/${value}/cmdline`).toString('utf8').replaceAll('\0', ' ')); } catch { /* process exited during sample */ }
  }
  return output;
}
function startSampler(importerDirectory, backendDirectory) {
  const samples = []; let error; let running = false;
  const timer = setInterval(() => { if (running || error) return; running = true; try {
    const current = snapshot(importerDirectory); const importerCommands = commandLines(importerDirectory); const backendCommands = commandLines(backendDirectory);
    samples.push({ memory: current.memoryCurrent, swap: current.swapCurrent, pids: current.pidsCurrent,
      importerWorkers: importerCommands.filter((value) => /repositoryArchiveWorkerMain\.js/.test(value)).length,
      backendWorkers: backendCommands.filter((value) => /repositoryArchiveWorkerMain\.js/.test(value)).length });
  } catch (caught) { error = caught; } finally { running = false; } }, 5);
  return { samples, stop: async () => { clearInterval(timer); while (running) await new Promise((resolve) => setTimeout(resolve, 1)); if (error) throw error; } };
}
async function waitForSamples(sampler, count, timeoutMs = 5_000) { const deadline = Date.now() + timeoutMs; while (sampler.samples.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10)); assert.ok(sampler.samples.length >= count, 'cgroup sampler did not start'); }

async function expectRejected(identity, fixture, code) {
  const result = await request('/repositories/analyses', { method: 'POST', token: identity.token, expected: 413,
    body: archiveForm(`Rejected ${identity.label}`, fixture.archive, `${identity.label}.zip`) });
  assert.equal(result.error.code, code); const list = await request('/repositories/analyses', { token: identity.token }); assert.equal(list.data.pagination.total, 0);
}
function cleanupMongo() {
  if (!identities.length) return { matchedUsers: 0, reportsAfter: 0, usersAfter: 0 };
  const targets = identities.map(({ userId, email, label }) => { assert.match(userId, /^[a-f0-9]{24}$/); assert.match(email, new RegExp(`^repository-resource-${label}-[a-f0-9]{16}@example\\.invalid$`)); return { userId, email }; });
  const mongoId = containerId('mongodb'); const mongo = inspect(mongoId); const sourceEnvironment = new Map();
  for (const entry of mongo.Config.Env || []) { const separator = entry.indexOf('='); if (separator > 0) sourceEnvironment.set(entry.slice(0, separator), entry.slice(separator + 1)); }
  const environment = {};
  for (const [source, target] of [['MONGO_INITDB_ROOT_USERNAME', 'MONGO_ROOT_USERNAME'], ['MONGO_INITDB_ROOT_PASSWORD', 'MONGO_ROOT_PASSWORD'], ['MONGO_INITDB_DATABASE', 'MONGO_DATABASE']]) {
    const value = sourceEnvironment.get(source); assert.equal(typeof value, 'string'); assert.doesNotMatch(value, /[\r\n\0]/); environment[target] = value;
  }
  const networks = Object.keys(mongo.NetworkSettings.Networks || {}); assert.equal(networks.length, 1); assert.match(networks[0], /^kfive-ai_[A-Za-z0-9_.-]+$/);
  const script = [`const targets=${JSON.stringify(targets)};`,
    'const validated=targets.map((target)=>{const id=ObjectId(target.userId);if(!db.users.findOne({_id:id,email:target.email},{_id:1}))throw new Error("guarded user missing");return{id,email:target.email};});',
    'const matchedUsers=validated.length;for(const target of validated){db.repositoryanalyses.deleteMany({ownerId:target.id});db.users.deleteOne({_id:target.id,email:target.email});}',
    'const ids=validated.map((target)=>target.id);print(JSON.stringify({matchedUsers,reportsAfter:db.repositoryanalyses.countDocuments({ownerId:{$in:ids}}),usersAfter:db.users.countDocuments({_id:{$in:ids}})}));'].join('');
  environment.KFIVE_CLEANUP_EVAL = script;
  const output = dockerWithEnvironment(['run', '--rm', '--network', networks[0], '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '-e', 'MONGO_ROOT_USERNAME', '-e', 'MONGO_ROOT_PASSWORD', '-e', 'MONGO_DATABASE', '-e', 'KFIVE_CLEANUP_EVAL',
    'mongo:7.0', 'sh', '-ceu', 'mongosh --quiet --host mongodb --username "$MONGO_ROOT_USERNAME" --password "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin "$MONGO_DATABASE" --eval "$KFIVE_CLEANUP_EVAL"'], environment);
  const result = JSON.parse(output.split('\n').at(-1)); assert.deepEqual(result, { matchedUsers: targets.length, reportsAfter: 0, usersAfter: 0 }); cleanupComplete = true; return result;
}

async function main() {
  const volumesBefore = protectedIdentities(); const importerId = containerId('repository-importer'); const backendId = containerId('backend');
  const importerBefore = inspect(importerId); const backendBefore = inspect(backendId); const socketMount = importerBefore.Mounts.find(({ Destination }) => Destination === '/run/kfive-repository-importer');
  assert.ok(socketMount); const socketVolumeIdentity = volumeIdentity(socketMount.Name);
  assert.equal(importerBefore.HostConfig.Memory, 512 * MIB); assert.equal(importerBefore.HostConfig.MemorySwap, 512 * MIB);
  assert.equal(importerBefore.HostConfig.NanoCpus, 1_000_000_000); assert.equal(importerBefore.HostConfig.PidsLimit, 48); assert.notEqual(importerBefore.HostConfig.OomKillDisable, true);
  const importerDirectory = cgroupDirectory(importerBefore.State.Pid); const backendDirectory = cgroupDirectory(backendBefore.State.Pid); const before = snapshot(importerDirectory);
  assert.equal(before.memoryMax, 512 * MIB); assert.equal(before.swapMax, 0); assert.equal(before.swapCurrent, 0); assert.equal(before.pidsMax, 48);
  assert.deepEqual(before.cpuMax, { quota: 100_000, period: 100_000 });
  let sampler; const held = [];
  try {
    const identityLabels = ['first', 'second', 'busy', 'entries', 'ratio', 'manifests', 'canary'];
    const registered = [];
    // The auth limiter counts in-flight attempts until successful responses
    // finish. Register sequentially so this verifier respects that contract.
    for (const label of identityLabels) registered.push(await register(label));
    const [first, second, busy, entryUser, ratioUser, manifestUser, canaryUser] = registered;
    const maximum = createNearMaximumFixture(); const hostile = createHostileFixtures(); sampler = startSampler(importerDirectory, backendDirectory); await waitForSamples(sampler, 2);
    held.push(holdMultipart(first, maximum.archive, 'first'), holdMultipart(second, maximum.archive, 'second'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const busyResult = await request('/repositories/analyses', { method: 'POST', token: busy.token, expected: 429,
      body: archiveForm('Busy rejection', buildZip([{ name: 'safe.txt', content: 'safe' }]).archive, 'busy.zip') });
    assert.equal(busyResult.error.code, 'REPOSITORY_ANALYZER_BUSY'); held.forEach((item) => item.release());
    const accepted = await Promise.all(held.map((item) => item.response));
    for (const [index, result] of accepted.entries()) {
      assert.equal(result.status, 201, result.json.error?.code); const analysis = result.json.data.analysis; const identity = index === 0 ? first : second;
      assert.equal(analysis.summary.fileCount, 2_000); assert.equal(analysis.summary.packageManifestCount, 20); assert.equal(analysis.source.compressedBytes, maximum.archive.length);
      const id = analysis._id || analysis.id; assert.match(id, /^[a-f0-9]{24}$/); reports.push({ id, identity });
    }
    await expectRejected(entryUser, hostile.entryLimit, 'REPOSITORY_ENTRY_LIMIT_EXCEEDED');
    await expectRejected(ratioUser, hostile.ratioBomb, 'REPOSITORY_UNCOMPRESSED_LIMIT_EXCEEDED');
    await expectRejected(manifestUser, hostile.manifestLimit, 'REPOSITORY_MANIFEST_LIMIT_EXCEEDED');
    const canaryArchive = buildZip([{ name: 'canary.txt', content: 'resource-canary' }]).archive;
    const canary = await request('/repositories/analyses', { method: 'POST', token: canaryUser.token, expected: 201,
      body: archiveForm('Recovery canary', canaryArchive, 'canary.zip') });
    const canaryId = canary.data.analysis._id || canary.data.analysis.id; reports.push({ id: canaryId, identity: canaryUser });
    const status = await request('/repositories/status', { token: canaryUser.token }); assert.equal(status.data.canAnalyze, true);
    assert.equal(status.data.dependencies.find(({ id }) => id === 'repository-importer')?.status, 'available');
    for (const item of reports) assert.match((await request(`/repositories/analyses/${item.id}`, { token: item.identity.token })).data.analysis._id || item.id, /^[a-f0-9]{24}$/);
    await sampler.stop(); const samples = sampler.samples; sampler = undefined; const after = snapshot(importerDirectory); const importerAfter = inspect(importerId);
    assert.ok(samples.some(({ importerWorkers }) => importerWorkers === 2), 'two concurrent importer children were not sampled');
    assert.ok(samples.every(({ importerWorkers, backendWorkers }) => importerWorkers <= 2 && backendWorkers === 0));
    assert.ok(samples.every(({ memory, swap, pids }) => memory <= before.memoryMax && swap === 0 && pids <= before.pidsMax));
    assert.equal(after.memoryEvents.max, before.memoryEvents.max); assert.equal(after.memoryEvents.oom, before.memoryEvents.oom); assert.equal(after.memoryEvents.oom_kill, before.memoryEvents.oom_kill);
    assert.equal(after.pidsEvents.max, before.pidsEvents.max); assert.ok(after.cpuStat.usage_usec > before.cpuStat.usage_usec);
    assert.ok((after.cpuStat.nr_throttled || 0) > (before.cpuStat.nr_throttled || 0), 'the one-CPU cgroup did not record throttling under concurrent maximum work');
    assert.equal(importerAfter.Id, importerBefore.Id); assert.equal(importerAfter.State.Pid, importerBefore.State.Pid); assert.equal(importerAfter.RestartCount, importerBefore.RestartCount);
    assert.equal(importerAfter.State.Running, true); assert.equal(importerAfter.State.OOMKilled, false);
    assert.equal(commandLines(importerDirectory).filter((value) => /repositoryArchiveWorkerMain\.js/.test(value)).length, 0);
    const logs = `${dockerCombined(['logs', importerId])}\n${dockerCombined(['logs', backendId])}`;
    assert.doesNotMatch(logs, new RegExp(nonce, 'i')); assert.doesNotMatch(logs, /resource-canary|blob-a\.bin|package\.json/);
    for (const item of reports.splice(0)) { const deleted = await request(`/repositories/analyses/${item.id}`, { method: 'DELETE', token: item.identity.token }); assert.equal(deleted.data.deleted, true); }
    const cleanup = cleanupMongo(); assert.deepEqual(protectedIdentities(), volumesBefore); assert.equal(volumeIdentity(socketMount.Name), socketVolumeIdentity);
    assert.equal((await request('/readiness')).status, 'ready');
    console.log(JSON.stringify({ fixture: { archiveBytes: maximum.archive.length, entries: maximum.entryCount, manifests: maximum.manifestCount,
      declaredBytes: maximum.declaredBytes, maximumPathBytes: maximum.maximumPathBytes }, concurrentSuccesses: 2, fixedBusyRejection: true,
      hostileRejections: ['entry-limit', 'compression-ratio', 'manifest-limit'], sampled: { count: samples.length,
        maximumMemoryBytes: Math.max(...samples.map(({ memory }) => memory)), maximumPids: Math.max(...samples.map(({ pids }) => pids), 0),
        maximumImporterChildren: Math.max(...samples.map(({ importerWorkers }) => importerWorkers), 0), memoryPeak: after.memoryPeak, pidsPeak: after.pidsPeak,
        cpuUsageDeltaUsec: after.cpuStat.usage_usec - before.cpuStat.usage_usec, throttledDelta: (after.cpuStat.nr_throttled || 0) - (before.cpuStat.nr_throttled || 0) },
      controls: { memoryBytes: before.memoryMax, swapBytes: before.swapMax, pidLimit: before.pidsMax, cpuMax: before.cpuMax },
      oomEventsUnchanged: true, pidMaxEventsUnchanged: true, noRestartOrOomKill: true, recoveryCanary: true,
      protectedVolumesUnchanged: true, socketVolumeIdentityUnchanged: true, cleanup }, null, 2));
  } finally {
    for (const item of held) item.destroy(); if (sampler) { try { await sampler.stop(); } catch { /* preserve primary failure */ } }
    if (!cleanupComplete && identities.length) { try { cleanupMongo(); } catch { /* guarded cleanup failure cannot broaden deletion */ } }
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
