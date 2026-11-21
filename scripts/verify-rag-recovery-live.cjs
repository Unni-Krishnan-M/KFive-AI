'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');
const { MongoClient, ObjectId } = require('mongoose').mongo;
assert.ok(process.argv.includes('--allow-live-test'), 'Requires --allow-live-test; runs installed Ollama models and isolated stores');
const root = path.resolve(__dirname, '..');
const nonce = crypto.randomBytes(8).toString('hex');
const label = `kfive-rag-recovery-${nonce}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), label));
const containers = [];
const children = new Set();
const report = { status: 'RUNNING', topology: 'production native API/worker, real host Ollama, isolated MongoDB/Redis/Chroma, Chroma response-delay proxy', checks: [] };
let api, base, env, mongo, frontend, proxy, gate, chromaUrl, initialVolumes;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }).trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, title, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(250); }
  throw new Error(`Timed out: ${title}`);
}
function volumes() {
  const names = docker('volume', 'ls', '-q').split('\n').filter(Boolean);
  return names.length ? Object.fromEntries(JSON.parse(docker('volume', 'inspect', ...names)).map(v => [v.Name, [v.CreatedAt, v.Mountpoint]])) : {};
}
function launch(name, image, port, mount, command = [], extra = []) {
  const directory = path.join(scratch, name); fs.mkdirSync(directory, { mode: 0o700 });
  const id = docker('run', '-d', '--init', '--name', `${label}-${name}`, '--label', `kfive.acceptance=${nonce}`,
    '--network', label, '--user', `${process.getuid()}:${process.getgid()}`, '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '256', '--memory', '1g', '--memory-swap', '1g',
    '--mount', `type=bind,src=${directory},dst=${mount}`, ...extra,
    ...(command.length ? ['--entrypoint', command[0]] : []), image, ...command.slice(1));
  containers.push(id);
  const info = JSON.parse(docker('inspect', id))[0];
  assert.equal(info.Config.Labels['kfive.acceptance'], nonce);
  const ip = info.NetworkSettings.Networks[label].IPAddress; assert.ok(ip);
  return `${ip}:${port}`;
}
async function freePort() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function startApi() {
  const port = await freePort(); const fd = fs.openSync(path.join(scratch, 'api.log'), 'a', 0o600);
  api = spawn(process.execPath, [path.join(root, 'backend/dist/server.js')], {
    cwd: scratch, env: { ...env, PORT: String(port) }, stdio: ['ignore', fd, fd],
  }); fs.closeSync(fd); children.add(api); api.once('exit', () => children.delete(api));
  base = `http://127.0.0.1:${port}/api/v1`;
  await until(async () => {
    if (api.exitCode !== null) throw new Error(`API exited: ${scratch}/api.log`);
    return fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok).catch(() => false);
  }, 'API health');
}
async function stop(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill(signal); await until(() => child.exitCode !== null || child.signalCode, 'API shutdown', 20_000);
}
async function request(route, token, method = 'GET', body, expected = 200) {
  const response = await fetch(`${base}${route}`, { method, signal: AbortSignal.timeout(210_000),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`); return data.data;
}
function arm() {
  assert.ok(!gate); let release;
  gate = { observed: false, wait: new Promise(resolve => { release = resolve; }), release: () => { release(); gate = undefined; } };
  return gate;
}
async function chroma(route, body) {
  const response = await fetch(`${chromaUrl}/api/v1${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
}
async function main() {
  const catalog = await (await fetch('http://127.0.0.1:11434/api/tags')).json();
  report.models = ['all-minilm:22m', 'phi3:latest'].map(name => {
    const model = catalog.models.find(row => row.name === name); assert.ok(model, `${name} must be installed`); return { name, digest: model.digest };
  });
  initialVolumes = volumes(); docker('network', 'create', '--internal', '--label', `kfive.acceptance=${nonce}`, label);
  const mongoAddress = launch('mongo', 'mongo:7', 27017, '/data/db', ['mongod', '--bind_ip_all']);
  const redisAddress = launch('redis', 'redis:7.2-alpine', 6379, '/data', ['redis-server', '--bind', '0.0.0.0', '--protected-mode', 'no']);
  chromaUrl = `http://${launch('chroma', 'chromadb/chroma:0.4.24', 8000, '/chroma/chroma', ['uvicorn', 'chromadb.app:app', '--host', '0.0.0.0', '--port', '8000'], ['-e', 'ANONYMIZED_TELEMETRY=false', '-e', 'IS_PERSISTENT=true', '-e', 'PERSIST_DIRECTORY=/chroma/chroma'])}`;
  await until(() => fetch(`${chromaUrl}/api/v1/heartbeat`).then(r => r.ok).catch(() => false), 'Chroma readiness');
  proxy = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const upstream = await fetch(`${chromaUrl}${req.url}`, { method: req.method, headers: { 'content-type': 'application/json' },
        ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
      const data = Buffer.from(await upstream.arrayBuffer());
      const current = gate;
      if (current && req.url.endsWith('/upsert') && upstream.ok) { current.observed = true; await current.wait; }
      res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(data);
    } catch { res.writeHead(502); res.end('{}'); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  frontend = await require('./benchmark-browser-acceptance.cjs').createFrontend({ getBase: () => base, root });
  env = { PATH: process.env.PATH, NODE_ENV: 'production', KFIVE_MODE: 'local', AI_PROVIDER: 'ollama',
    AI_DEFAULT_MODEL: 'phi3:latest', AI_EMBEDDING_MODEL: 'all-minilm:22m', AI_TIMEOUT_MS: '180000',
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434', CHROMA_URL: `http://127.0.0.1:${proxy.address().port}`,
    MONGODB_URL: `mongodb://${mongoAddress}/rag_recovery_acceptance`, REDIS_URL: `redis://${redisAddress}`,
    JWT_SECRET: crypto.randomBytes(48).toString('hex'), JWT_REFRESH_SECRET: crypto.randomBytes(48).toString('hex'),
    CORS_ORIGIN: frontend.url, RAG_BACKGROUND_INDEXING_ENABLED: 'true', LOG_LEVEL: 'warn', RATE_LIMIT_MAX_REQUESTS: '5000' };
  await startApi();
  mongo = new MongoClient(env.MONGODB_URL); await mongo.connect();
  const db = mongo.db(); const sources = db.collection('ragsources');
  const account = { email: `${nonce}@example.invalid`, username: `rag_${nonce}`, password: `Kf!${crypto.randomBytes(24).toString('hex')}`, firstName: 'RAG', lastName: 'Acceptance' };
  const owner = (await request('/auth/register', undefined, 'POST', account, 201)).accessToken;
  const other = (await request('/auth/register', undefined, 'POST', { ...account, email: `other-${account.email}`, username: `other_${nonce}` }, 201)).accessToken;
  const create = async name => (await request('/knowledge/sources', owner, 'POST', { name, mediaType: 'text/plain', content: 'The observatory launch code is cobalt. The telescope opens at dusk.' }, 201)).source;
  const blocked = arm();
  const source = await create('Crash recovery'); assert.equal(source.status, 'queued');
  await until(() => blocked.observed, 'real embedding and durable vector write');
  const interrupted = await sources.findOne({ _id: new ObjectId(source.id) });
  assert.equal(interrupted.status, 'indexing'); assert.equal(interrupted.indexingLease.attempt, 1);
  await request(`/knowledge/sources/${source.id}`, owner, 'DELETE', undefined, 409);
  await stop(api, 'SIGKILL'); blocked.release();
  await startApi();
  await until(async () => (await sources.findOne({ _id: interrupted._id })).status === 'ready', 'natural lease expiry and recovery', 100_000);
  const ready = await sources.findOne({ _id: interrupted._id });
  assert.equal(ready.indexingLease.attempt, 2); assert.notEqual(ready.indexingGeneration, interrupted.indexingLease.token);
  assert.equal(ready.contentSnapshot, undefined);
  report.checks.push('Real Ollama embedding/Chroma upsert followed by SIGKILL before publication; production API restart resumes after natural 30-second lease expiry and publishes generation 2');
  const records = await chroma(`/collections/${ready.collectionId}/get`, { where: { sourceId: source.id }, include: ['embeddings', 'documents', 'metadatas'] });
  assert.ok(records.ids.some(id => id.includes(interrupted.indexingLease.token)), 'real abandoned vectors remain for saturation check');
  const liveIndex = records.metadatas.findIndex(row => row.indexingGeneration === ready.indexingGeneration); assert.ok(liveIndex >= 0);
  await chroma(`/collections/${ready.collectionId}/upsert`, { ids: Array.from({ length: 100 }, (_, i) => `${source.id}:stale:${i}`),
    embeddings: Array.from({ length: 100 }, () => records.embeddings[liveIndex]), documents: Array.from({ length: 100 }, () => 'STALE GENERATION MUST NEVER BE RETRIEVED'),
    metadatas: Array.from({ length: 100 }, (_, i) => ({ ...records.metadatas[liveIndex], indexingGeneration: interrupted.indexingLease.token, chunkIndex: i })) });
  const result = await request('/knowledge/query', owner, 'POST', { question: 'What is the observatory launch code?', topK: 3 });
  assert.ok(result.references.length > 0); assert.ok(result.references.every(ref => ref.sourceId === source.id && !ref.snippet.includes('STALE')));
  assert.ok(result.answer.length > 0);
  const filtered = await chroma(`/collections/${ready.collectionId}/query`, { query_embeddings: [records.embeddings[liveIndex]], n_results: 12,
    where: { $and: [{ sourceId: source.id }, { indexingGeneration: ready.indexingGeneration }] }, include: ['metadatas'] });
  assert.ok(filtered.metadatas[0].every(row => row.indexingGeneration === ready.indexingGeneration));
  await request(`/knowledge/sources/${source.id}`, other, 'DELETE', undefined, 404);
  assert.deepEqual((await request('/knowledge/sources?cursor=', other)).sources, []);
  report.checks.push('Real Chroma excludes 100 stale vectors before ranking; real Phi3 answer cites only the recovered source; second user cannot read/delete it');
  await browserAcceptance(account, sources);
  await stop(api);
  for (const id of containers) docker('restart', id);
  await until(() => fetch(`${chromaUrl}/api/v1/heartbeat`).then(r => r.ok).catch(() => false), 'restarted Chroma');
  await startApi();
  assert.equal((await sources.findOne({ _id: ready._id })).indexingGeneration, ready.indexingGeneration);
  assert.ok((await request('/knowledge/sources?cursor=', owner)).sources.some(row => row.id === source.id && row.status === 'ready'));
  const after = await chroma(`/collections/${ready.collectionId}/get`, { where: { indexingGeneration: ready.indexingGeneration }, include: ['metadatas'] });
  assert.ok(after.ids.length > 0);
  report.checks.push('MongoDB/Redis/Chroma and production API restart preserve published source/generation and actual vectors');
  for (const row of (await request('/knowledge/sources?cursor=', owner)).sources) await request(`/knowledge/sources/${row.id}`, owner, 'DELETE');
  const remaining = await chroma(`/collections/${ready.collectionId}/get`, { where: { ownerId: String(ready.ownerId) }, include: ['metadatas'] });
  assert.equal(remaining.ids.length, 0); assert.equal(await sources.countDocuments({}), 0);
  await db.collection('users').deleteMany({ email: { $in: [account.email, `other-${account.email}`] } });
  report.checks.push('Owner deletion removes current and abandoned vectors; exact two test accounts removed');
}
async function browserAcceptance(account, sources) {
  assert.ok(process.env.KFIVE_PLAYWRIGHT_MODULE, 'Set installed Playwright module path');
  const { chromium } = require(process.env.KFIVE_PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${frontend.url}/login`); await page.locator('input[type="email"]').fill(account.email);
    await page.locator('input[type="password"]').fill(account.password); await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/app/**'); await page.goto(`${frontend.url}/app/knowledge`);
    await page.getByRole('button', { name: 'Choose source', exact: true }).waitFor();
    const blocked = arm();
    await page.locator('input[type="file"]').setInputFiles({ name: 'browser-recovery.txt', mimeType: 'text/plain', buffer: Buffer.from('The observatory telescope opens at dusk.') });
    await page.getByRole('button', { name: 'Index browser-recovery.txt', exact: true }).click();
    await until(() => blocked.observed, 'browser real indexing started');
    const card = page.locator('article').filter({ hasText: 'browser-recovery.txt' });
    await card.getByText(/^(queued|indexing)$/).waitFor();
    assert.equal(await card.getByRole('button', { name: 'Delete browser-recovery.txt' }).isDisabled(), true);
    blocked.release();
    await card.getByText('ready', { exact: true }).waitFor({ timeout: 60_000 });
    assert.equal(await card.getByRole('button', { name: 'Delete browser-recovery.txt' }).isEnabled(), true);
    await page.reload(); await card.getByText('ready', { exact: true }).waitFor();
    assert.equal((await sources.findOne({ name: 'browser-recovery.txt' })).status, 'ready');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(root, 'output/verification/rag-recovery-browser.png'), fullPage: true });
    report.checks.push('Real Chrome login/upload shows pending state and disabled deletion, auto-refreshes to ready after real indexing, and retains ready state on reload');
    const existing = await sources.find({}).toArray();
    const ownerId = existing[0].ownerId;
    const occupied = new Set(existing.map(row => row.quotaSlot));
    const fillers = Array.from({ length: 200 }, (_, quotaSlot) => quotaSlot).filter(slot => !occupied.has(slot))
      .map(quotaSlot => ({ _id: new ObjectId(), ownerId, quotaSlot, name: `Quota filler ${quotaSlot}`, sourceKind: 'text',
        mediaType: 'text/plain', status: 'failed', errorCode: 'RAG_INGESTION_FAILED', characterCount: 1, byteCount: 1,
        chunkCount: 0, chunkingVersion: 1, contentHash: 'a'.repeat(64) }));
    try {
      await sources.insertMany(fillers);
      const rejected = page.waitForResponse(response => response.url().endsWith('/knowledge/sources') && response.request().method() === 'POST');
      await page.locator('input[type="file"]').setInputFiles({ name: 'over-quota.txt', mimeType: 'text/plain', buffer: Buffer.from('This must not be admitted.') });
      await page.getByRole('button', { name: 'Index over-quota.txt', exact: true }).click();
      const response = await rejected;
      assert.equal(response.status(), 409); assert.equal((await response.json()).error.code, 'RAG_SOURCE_LIMIT_EXCEEDED');
      await page.getByRole('alert').filter({ hasText: 'Knowledge source limit reached (200 per account)' }).waitFor();
      assert.equal(await sources.countDocuments({ ownerId }), 200);
      assert.equal(await sources.countDocuments({ name: 'over-quota.txt' }), 0);
      assert.deepEqual(errors, []);
      report.checks.push('Production API and Chrome reject source 201 with stable 409 quota error and visible recovery guidance; no source is created');
    } finally { await sources.deleteMany({ _id: { $in: fillers.map(row => row._id) }, ownerId }); }

  } finally { gate?.release(); await browser.close(); }
}
(async () => {
  let failure;
  try { await main(); } catch (error) { failure = error; }
  finally {
    gate?.release();
    for (const child of children) { try { await stop(child); } catch { child.kill('SIGKILL'); } }
    if (mongo) await mongo.close();
    if (frontend) await frontend.close();
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
    for (const id of containers.reverse()) {
      try { assert.equal(JSON.parse(docker('inspect', id))[0].Config.Labels['kfive.acceptance'], nonce); docker('rm', '-f', '-v', id); }
      catch (error) { failure ??= error; }
    }
    try {
      assert.equal(JSON.parse(docker('network', 'inspect', label))[0].Labels['kfive.acceptance'], nonce); docker('network', 'rm', label);
      assert.equal(docker('ps', '-aq', '--filter', `label=kfive.acceptance=${nonce}`), '');
      const after = volumes(); for (const [name, identity] of Object.entries(initialVolumes ?? {})) assert.deepEqual(after[name], identity);
      report.checks.push('Exact fixture containers/network removed; pre-existing volume identities unchanged');
    } catch (error) { failure ??= error; }
  }
  report.status = failure ? 'FAIL' : 'PASS'; report.scratch = scratch;
  fs.writeFileSync(path.join(root, 'output/verification/rag-recovery-live.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2)); if (failure) { console.error(failure); process.exitCode = 1; }
})();
