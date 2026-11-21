#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, fork, spawn } = require('node:child_process');
const knowledgeMode = process.argv.includes('--knowledge-pagination');
const contractMode = process.argv.includes('--provider-contract') || knowledgeMode;

if (!process.argv.includes('--allow-live-test')) {
  console.error('Requires --allow-live-test: starts isolated datastores; default runs installed phi3:latest, --provider-contract uses a loopback fault fixture.');
  process.exit(2);
}
const root = path.resolve(__dirname, '..');
const nonce = crypto.randomBytes(8).toString('hex');
const label = `kfive-benchmark-${nonce}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
const containers = [];
const children = new Set();
const model = contractMode ? 'acceptance-fixture' : 'phi3:latest';
const report = { topology: `native API/worker, ${contractMode ? 'loopback synthetic Ollama protocol fixture' : 'loopback host Ollama'}, isolated Docker MongoDB/Redis`, model, checks: [] };
let api, worker, base, env;
let originalVolumes;
let providerFixture;
let browserFixture;
const accounts = new Map();

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024 }).trim();
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(250); }
  throw new Error(`Timed out: ${label}`);
}
function launchStore(name, image, port, mount, command) {
  const directory = path.join(scratch, name); fs.mkdirSync(directory, { mode: 0o700 });
  const id = docker('run', '-d', '--name', `${label}-${name}`, '--label', `kfive.acceptance=${nonce}`,
    '--network', label, '--user', `${process.getuid()}:${process.getgid()}`, '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '1g', '--memory-swap', '1g',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=32m',
    ...(name === 'mongo' ? ['--tmpfs', `/data/configdb:rw,nosuid,nodev,size=1m,uid=${process.getuid()},gid=${process.getgid()}`] : []),
    '--mount', `type=bind,src=${directory},dst=${mount}`, '--entrypoint', command[0], image, ...command.slice(1));
  containers.push(id);
  const info = JSON.parse(docker('inspect', id))[0];
  assert.equal(info.Config.Labels['kfive.acceptance'], nonce);
  const address = info.NetworkSettings.Networks[label]?.IPAddress;
  if (!address) {
    fs.writeFileSync(path.join(scratch, `${name}-startup.log`), docker('logs', id), { mode: 0o600 });
    throw new Error(`${name} has no private address (state ${info.State.Status}); see ${scratch}`);
  }
  assert.match(address, /^\d+\.\d+\.\d+\.\d+$/);
  return `${address}:${port}`;
}
function childLog(name) { return fs.openSync(path.join(scratch, `${name}.log`), 'a', 0o600); }
function track(child) { children.add(child); child.once('exit', () => children.delete(child)); return child; }
async function stop(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill(signal);
  await until(() => child.exitCode !== null || child.signalCode, 'child shutdown', 20_000);
}
async function startApi() {
  const fd = childLog('api');
  api = track(fork(path.join(__dirname, 'benchmark-acceptance-api.cjs'), [], {
    cwd: scratch, env: { ...env, KFIVE_PROCESS: 'api' }, stdio: ['ignore', fd, fd, 'ipc'],
  }));
  fs.closeSync(fd);
  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`API startup timed out; see ${scratch}`)), 30_000);
    api.once('message', (value) => { clearTimeout(timer); resolve(value); });
    api.once('exit', () => { clearTimeout(timer); reject(new Error(`API exited; see ${scratch}`)); });
  });
  base = `http://127.0.0.1:${message.port}/api/v1`;
}
async function startWorker(token) {
  const fd = childLog('worker');
  worker = track(spawn(process.execPath, [path.join(root, 'backend/dist/benchmarkWorkerMain.js')], {
    cwd: scratch, env: { ...env, KFIVE_PROCESS: 'benchmark-worker' }, stdio: ['ignore', fd, fd],
  })); fs.closeSync(fd);
  await until(async () => (await request('/benchmarks/status', token)).data.execution.workerAvailable, 'worker heartbeat');
}
async function request(route, token, method = 'GET', body, expected = 200) {
  const response = await fetch(`${base}${route}`, { method, signal: AbortSignal.timeout(15_000),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
  return data;
}
async function register(name) {
  const account = {
    email: `${name}-${nonce}@example.invalid`, username: `${name}_${nonce}`,
    password: `Kf!${crypto.randomBytes(24).toString('base64url')}`, firstName: 'Benchmark', lastName: 'Acceptance',
  };
  const token = (await request('/auth/register', undefined, 'POST', account, 201)).data.accessToken;
  accounts.set(token, account);
  return token;
}
async function stream(route, token, options = {}) {
  const response = await fetch(`${base}${route}`, { method: options.start ? 'POST' : 'GET',
    signal: AbortSignal.timeout(210_000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      ...(options.cursor === undefined ? {} : { 'Last-Event-ID': String(options.cursor) }) },
    ...(options.start ? { body: JSON.stringify({ model, suiteId: 'chat-core-v1' }) } : {}) });
  if (options.allowRejectedStart && response.status !== 200) return { status: response.status, body: await response.json() };
  assert.equal(response.status, 200, `Stream returned ${response.status}`);
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = '', bytes = 0, previous = options.cursor ?? 0; const events = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; assert.ok(bytes < 4 * 1024 * 1024, 'bounded SSE response');
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const raw = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
        if (!raw || raw === '[DONE]') continue;
        const event = JSON.parse(raw);
        assert.ok(event.revision >= previous, 'monotonic SSE revision'); previous = event.revision;
        events.push(event);
        if (options.first && event.run) return { status: 200, run: event.run, revision: event.revision };
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
  assert.ok(events.at(-1)?.run, 'stream returns canonical terminal record');
  return { run: events.at(-1).run, events };
}
const get = async (id, token) => (await request(`/benchmarks/runs/${id}`, token)).data.run;
function cleanPublic(value) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /"(?:uuid|ownerId|leaseOwner|execution|activeOwnerSlot)"|GPU-[a-f0-9-]{20}/i);
}
function success(run) {
  assert.equal(run.status, 'succeeded'); assert.equal(run.completedCalls, 6); assert.equal(run.passedCalls, 6);
  assert.deepEqual(run.results.map((r) => r.callIndex), [0, 1, 2, 3, 4, 5]);
  assert.equal(new Set(run.timeline.filter((e) => e.type === 'call_completed').map((e) => e.callIndex)).size, 6);
  cleanPublic(run);
}
async function captureProviderEvidence(run) {
  const ps = await (await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(5000) })).json();
  const loaded = ps.models.filter((item) => item.name === model || item.model === model)
    .map((item) => ({ name: item.name, digest: item.digest, size: item.size, sizeVram: item.size_vram }));
  const sample = { runId: run.id, loaded, wallDurationMs: run.wallDurationMs,
    providerDurationMs: run.results.reduce((sum, result) => sum + (result.usage?.totalDurationMs ?? 0), 0) };
  try {
    sample.computeProcesses = execFileSync('nvidia-smi', [
      '--query-compute-apps=process_name,used_gpu_memory', '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 }).trim().split('\n')
      .filter((line) => /ollama|llama-server/.test(line));
  } catch { sample.computeProcesses = []; }
  sample.gpuOffloadObserved = loaded.some((item) => item.sizeVram > 0) && sample.computeProcesses.length > 0;
  report.providerEvidence ??= []; report.providerEvidence.push(sample);
}
async function main() {
  assert.ok(fs.existsSync(path.join(root, 'backend/dist/benchmarkWorkerMain.js')), 'Build backend first');
  if (contractMode) providerFixture = await require('./benchmark-provider-contract.cjs').createFixture(model);
  const providerUrl = providerFixture?.url ?? 'http://127.0.0.1:11434';
  const catalog = await (await fetch(`${providerUrl}/api/tags`, { signal: AbortSignal.timeout(5000) })).json();
  const selected = catalog.models.find((m) => m.name === model); assert.ok(selected, 'phi3:latest must already be installed');
  report.modelDigest = selected.digest;
  originalVolumes = volumeIdentities();
  docker('network', 'create', '--internal', '--label', `kfive.acceptance=${nonce}`, label);
  const mongoPort = launchStore('mongo', 'mongo:7', 27017, '/data/db', ['mongod', '--bind_ip_all']);
  const redisPort = launchStore('redis', 'redis:7.2-alpine', 6379, '/data',
    ['redis-server', '--bind', '0.0.0.0', '--protected-mode', 'no', '--appendonly', 'yes']);
  env = { PATH: process.env.PATH, NODE_ENV: 'production', KFIVE_BENCHMARK_ACCEPTANCE: nonce,
    KFIVE_MODE: 'local', AI_PROVIDER: 'ollama', AI_DEFAULT_MODEL: model, AI_TIMEOUT_MS: '180000',
    OLLAMA_BASE_URL: providerUrl, MONGODB_URL: `mongodb://${mongoPort}/benchmark_acceptance`,
    REDIS_URL: `redis://${redisPort}`, JWT_SECRET: crypto.randomBytes(48).toString('hex'),
    JWT_REFRESH_SECRET: crypto.randomBytes(48).toString('hex'), CORS_ORIGIN: 'http://127.0.0.1',
    TRUST_PROXY_HOPS: '0', RATE_LIMIT_MAX_REQUESTS: '5000', LOG_LEVEL: 'warn', NOTEBOOK_EXECUTION_ENABLED: 'false' };
  if (process.argv.includes('--browser')) {
    browserFixture = await require('./benchmark-browser-acceptance.cjs').createFrontend({ getBase: () => base, root });
    env.CORS_ORIGIN = browserFixture.url;
  }
  await startApi();
  const owner = await register('owner'); const stranger = await register('stranger');
  if (knowledgeMode) {
    report.topology = 'native API, isolated Docker MongoDB/Redis; no worker or inference';
    delete report.model; delete report.modelDigest;
    await require('./knowledge-pagination-acceptance.cjs').verify({ request, owner, stranger,
      ownerEmail: accounts.get(owner).email, strangerEmail: accounts.get(stranger).email,
      frontend: browserFixture, account: accounts.get(owner), scratch,
      env, report, stop, startApi, getApi: () => api });
    assert.equal(providerFixture.calls.length, 0, 'Pagination must not invoke inference');
    return;
  }
  if (contractMode) {
    await require('./benchmark-provider-contract.cjs').verify({ fixture: providerFixture, model, owner, stranger,
      request, stream, get, until, stop, startWorker, startApi, report, env,
      getWorker: () => worker, getApi: () => api, success });
    return;
  }
  await startWorker(owner);
  const first = await stream('/benchmarks/runs/stream', owner, { start: true, first: true });
  const resumed = await stream(`/benchmarks/runs/${first.run.id}/stream`, owner, { cursor: first.revision });
  success(resumed.run);
  await captureProviderEvidence(resumed.run);
  report.checks.push('SSE disconnect/reconnect preserves durable six-call run and monotonic revisions');
  const second = await stream('/benchmarks/runs/stream', owner, { start: true }); success(second.run);
  await captureProviderEvidence(second.run);
  assert.deepEqual(second.run.suite, resumed.run.suite); assert.deepEqual(second.run.model.requested, resumed.run.model.requested);
  if (process.argv.includes('--browser')) {
    await require('./benchmark-browser-acceptance.cjs').verify({ frontend: browserFixture, account: accounts.get(owner), runs: [resumed.run, second.run], scratch });
    report.checks.push('Chromium renders real run comparison and exports canonical six-call detail at desktop/tablet/mobile widths');
  }
  report.runs = [resumed.run, second.run].map((run) => ({ id: run.id, status: run.status,
    wallDurationMs: run.wallDurationMs, aggregate: run.aggregate, gpu: run.gpu }));
  report.checks.push('Two compatible successful real host Ollama runs');
  const other = await request('/benchmarks/runs', stranger); assert.deepEqual(other.data.runs, []);
  for (const [suffix, method] of [['', 'GET'], ['/stream', 'GET'], ['/cancel', 'POST'], ['', 'DELETE']]) {
    await request(`/benchmarks/runs/${first.run.id}${suffix}`, stranger, method, undefined, 404);
  }
  report.checks.push('Second user cannot list, read/export, reconnect, cancel, or delete owner record');
  await stop(worker);
  const queued = await stream('/benchmarks/runs/stream', owner, { start: true, first: true }); assert.equal(queued.run.status, 'queued');
  const cancelled = await request(`/benchmarks/runs/${queued.run.id}/cancel`, owner, 'POST');
  assert.equal(cancelled.data.run.status, 'cancelled'); assert.equal(cancelled.data.run.completedCalls, 0);
  report.checks.push('Queued cancellation while worker offline executes zero calls');
  const pending = await stream('/benchmarks/runs/stream', owner, { start: true, first: true });
  const before = JSON.stringify(await get(first.run.id, owner));
  await stop(api);
  for (const id of containers) docker('restart', id);
  await startApi();
  assert.equal(JSON.stringify(await get(first.run.id, owner)), before, 'completed record exact across datastore/API restart');
  assert.equal((await get(pending.run.id, owner)).status, 'queued');
  await startWorker(owner);
  const recovered = await stream(`/benchmarks/runs/${pending.run.id}/stream`, owner, { cursor: pending.revision }); success(recovered.run);
  report.checks.push('MongoDB/Redis/API/worker restart preserves complete record and safely dispatches queued run');
  const active = await stream('/benchmarks/runs/stream', owner, { start: true, first: true });
  await until(async () => (await get(active.run.id, owner)).timeline.some((e) => e.type === 'call_started'), 'in-flight call');
  await request(`/benchmarks/runs/${active.run.id}/cancel`, owner, 'POST');
  const stopped = await stream(`/benchmarks/runs/${active.run.id}/stream`, owner);
  assert.equal(stopped.run.status, 'cancelled'); cleanPublic(stopped.run);
  report.checks.push('Running cancellation terminalizes through MongoDB and worker Pub/Sub; provider resource cancellation not inferred');
  const crashed = await stream('/benchmarks/runs/stream', owner, { start: true, first: true });
  await until(async () => (await get(crashed.run.id, owner)).timeline.some((e) => e.type === 'call_started'), 'call before abrupt worker stop');
  await stop(worker, 'SIGKILL');
  const { MongoClient, ObjectId } = require('mongoose').mongo;
  const mongo = new MongoClient(env.MONGODB_URL);
  await mongo.connect();
  try {
    const collection = mongo.db().collection('benchmarkruns');
    const raw = await collection.findOne({ _id: new ObjectId(crashed.run.id) });
    assert.ok(Number.isInteger(raw.execution?.inFlightCallIndex), 'kill caught an uncertain in-flight call');
    const completedCalls = raw.completedCalls;
    const startedCalls = raw.timeline.filter((e) => e.type === 'call_started').length;
    await until(async () => (await get(crashed.run.id, owner)).status === 'interrupted', 'expired lease reconciliation', 80_000);
    await stop(api); await startApi(); await startWorker(owner);
    const interrupted = await get(crashed.run.id, owner);
    assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.completedCalls, completedCalls);
    assert.equal(interrupted.timeline.filter((e) => e.type === 'call_started').length, startedCalls);
    assert.equal(interrupted.error.code, 'BENCHMARK_INTERRUPTED');
    for (const run of await collection.find({}).toArray()) {
      assert.doesNotMatch(JSON.stringify(run.gpu ?? {}), /"uuid"|GPU-[a-f0-9-]{20}/i);
    }
    report.checks.push('SIGKILL during a provider call, natural lease expiry, reconciliation and restart interrupt without another call-start');
    report.checks.push('Persisted and public benchmark GPU snapshots contain no UUID fields');
  } finally { await mongo.close(); }
  const ps = await (await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(5000) })).json();
  report.providerLoadedModel = ps.models.filter((m) => m.name === model).map((m) => ({ name: m.name, size: m.size, sizeVram: m.size_vram }));
}

function volumeIdentities() {
  const names = docker('volume', 'ls', '-q').split('\n').filter(Boolean);
  if (!names.length) return {};
  return Object.fromEntries(JSON.parse(docker('volume', 'inspect', ...names))
    .map((volume) => [volume.Name, { created: volume.CreatedAt, mountpoint: volume.Mountpoint }]));
}

(async () => {
  let failure;
  try { await main(); }
  catch (error) { failure = error; }
  finally {
    for (const child of [...children]) {
      try { await stop(child); } catch { child.kill('SIGKILL'); }
    }
    if (providerFixture) await providerFixture.close();
    if (browserFixture) await browserFixture.close();
    for (const id of containers.reverse()) {
      try {
        const info = JSON.parse(docker('inspect', id))[0]; assert.equal(info.Config.Labels['kfive.acceptance'], nonce);
        docker('rm', '-f', '-v', id);
      } catch (error) { failure ??= error; }
    }
    try {
      const info = JSON.parse(docker('network', 'inspect', label))[0]; assert.equal(info.Labels['kfive.acceptance'], nonce);
      docker('network', 'rm', label);
    } catch (error) { failure ??= error; }
    try {
      assert.equal(docker('ps', '-aq', '--filter', `label=kfive.acceptance=${nonce}`), '');
      assert.equal(docker('network', 'ls', '-q', '--filter', `label=kfive.acceptance=${nonce}`), '');
      const after = volumeIdentities();
      for (const [name, identity] of Object.entries(originalVolumes ?? {})) assert.deepEqual(after[name], identity);
      report.checks.push('Exact fixture containers/network removed; existing volume identities unchanged');
    } catch (error) { failure ??= error; }
  }
  report.status = failure ? 'FAIL' : 'PASS'; report.scratch = scratch;
  // Retain only disposable fixture data/logs here for diagnosis; no existing volumes are mounted.
  fs.writeFileSync(path.join(scratch, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (failure) { console.error(failure.message); process.exitCode = 1; }
})();
