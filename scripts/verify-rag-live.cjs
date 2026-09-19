#!/usr/bin/env node
// Explicit opt-in, host-loopback integration test. Requires running Compose
// Mongo/Chroma and host Ollama. Never imports server.js or changes .env.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const requireBackend = createRequire(path.resolve(__dirname, '../backend/package.json'));
const runId = randomBytes(8).toString('hex');
const databaseName = `kfive_rag_verify_${runId}`;
let server;
let mongoose;
let base;
let collections = [];
let ownsDatabase = false;
let testMongoUrl;
const reportPath = path.resolve(__dirname, `../output/verification/rag-live-${runId}.json`);
const report = { runId, database: databaseName, startedAt: new Date().toISOString(), status: 'running', checkpoints: [] };
function evidence(value) {
  report.checkpoints.push(value);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(value));
}

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0) throw new Error('Docker preflight failed (details suppressed to protect credentials).');
  return result.stdout.trim();
}
function address(service) {
  const id = docker(['compose', 'ps', '-q', service]);
  assert.match(id, /^[a-f0-9]+$/);
  const networks = JSON.parse(docker(['inspect', id, '--format', '{{json .NetworkSettings.Networks}}']));
  const entries = Object.values(networks).filter(n => n.IPAddress);
  assert.equal(entries.length, 1, 'Use a single-network local Compose stack for this verifier.');
  return { id, ip: entries[0].IPAddress };
}
async function request(method, route, token, body, expected = 200) {
  const response = await fetch(base + route, {
    method, signal: AbortSignal.timeout(150000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${result.error?.code || 'unexpected response'}`);
  return result.data;
}
async function listen(createApp, config) {
  server = await new Promise(resolve => {
    const instance = createApp(config).listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
}
async function close() {
  if (server) { await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); server = undefined; }
}
async function main() {
  if (!process.argv.includes('--allow-live-test')) throw new Error('Pass --allow-live-test: creates then removes isolated test database/vector collections and calls real local models.');
  const backend = address('backend');
  const mongo = address('mongodb');
  const chroma = address('chromadb');
  const inherited = JSON.parse(docker(['exec', backend.id, 'node', '-e', 'process.stdout.write(JSON.stringify({mongo:process.env.MONGODB_URL,chroma:process.env.CHROMA_URL}))']));
  const mongoUrl = new URL(inherited.mongo);
  mongoUrl.hostname = mongo.ip;
  mongoUrl.pathname = `/${databaseName}`;
  const chromaUrl = new URL(inherited.chroma);
  chromaUrl.hostname = chroma.ip;
  Object.assign(process.env, {
    NODE_ENV: 'test', KFIVE_MODE: 'local', MONGODB_URL: mongoUrl.href,
    REDIS_URL: 'redis://127.0.0.1:1', CHROMA_URL: chromaUrl.href,
    JWT_SECRET: randomBytes(48).toString('hex'), JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
    AI_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    AI_DEFAULT_MODEL: 'phi3:latest', AI_EMBEDDING_MODEL: 'all-minilm:22m',
    AI_TIMEOUT_MS: '120000', AI_MAX_OUTPUT_TOKENS: '128',
    CODE_RUNNER_MODE: 'disabled', NOTEBOOK_EXECUTION_ENABLED: 'false',
    LOG_FILE: '', LOG_LEVEL: 'error', PUBLIC_BASE_URL: '', CORS_ORIGIN: 'http://127.0.0.1',
  });
  mongoose = requireBackend('mongoose');
  const { getEnvironment } = requireBackend('./dist/config/environment');
  const config = getEnvironment();
  testMongoUrl = config.mongodbUrl;
  await mongoose.connect(config.mongodbUrl, { serverSelectionTimeoutMS: 10000 });
  assert.equal(mongoose.connection.name, databaseName);
  assert.equal((await mongoose.connection.db.listCollections().toArray()).length, 0, 'Test database already exists.');
  ownsDatabase = true;
  evidence({ checkpoint: 'isolated-database-created', database: databaseName, inference: 'host-loopback Ollama; device selection is not certified by this verifier' });
  const { createApp } = requireBackend('./dist/app');
  const { RagSourceModel } = requireBackend('./dist/models/RagSource');
  const { ChromaClient } = requireBackend('./dist/services/chromaClient');
  await listen(createApp, config);
  const register = key => request('POST', '/auth/register', undefined, {
    email: `${runId}-${key}@example.test`, username: `rag_${runId}_${key}`, password: randomBytes(24).toString('hex'),
  }, 201);
  const a = await register('a');
  const b = await register('b');
  const token = a.accessToken;
  const project = (await request('POST', '/projects', token, { name: 'Live RAG verification' }, 201)).project;
  const projectId = project._id || project.id;
  assert.ok(projectId);
  const status = await request('GET', `/knowledge/status?projectId=${projectId}`, token);
  assert.equal(status.canIngest, true);
  const content = 'The Cedar research station uses access code VIOLET-739. Its inventory audit is scheduled for Thursday. No birthdates are recorded in this document.';
  const source = (await request('POST', '/knowledge/sources', token, {
    projectId, name: 'Cedar station facts', mediaType: 'text/plain', content,
  }, 201)).source;
  assert.equal(source.status, 'ready');
  assert.equal(source.embedding.model, 'all-minilm:22m');
  const stored = await RagSourceModel.findById(source.id).lean();
  collections.push({ id: stored.collectionId, name: stored.collectionName });
  const vectors = new ChromaClient({ baseUrl: config.chromaUrl });
  const where = { $and: [{ ownerId: a.user._id }, { sourceId: source.id }] };
  const embedded = await fetch('http://127.0.0.1:11434/api/embed', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'all-minilm:22m', input: 'Cedar access code' }), signal: AbortSignal.timeout(120000),
  }).then(r => r.json());
  assert.equal(embedded.embeddings[0].length, source.embedding.dimension);
  assert.equal((await vectors.query(stored.collectionId, { embedding: embedded.embeddings[0], nResults: 1, where })).ids.length, 1);
  const answer = await request('POST', '/knowledge/query', token, { projectId, question: 'What is the Cedar station access code? Answer in one sentence.' });
  assert.match(answer.answer, /VIOLET-739/i);
  assert.match(answer.answer, /\[S1\]/);
  assert.equal(answer.references[0].sourceId, source.id);
  assert.ok(answer.references[0].snippet.includes('VIOLET-739'));
  const unknown = await request('POST', '/knowledge/query', token, { projectId, question: 'What is the station author’s exact date of birth? If absent, say unknown.' });
  assert.match(unknown.answer, /unknown|not (?:provided|recorded|mentioned|specified|available)|does not|no .*birth/i);
  assert.equal((await request('GET', '/knowledge/sources', token)).count, 0);
  await request('GET', `/knowledge/sources?projectId=${projectId}`, b.accessToken, undefined, 404);
  await request('POST', '/knowledge/query', b.accessToken, { projectId, question: 'What is the access code?' }, 404);
  await request('DELETE', `/knowledge/sources/${source.id}`, b.accessToken, undefined, 404);
  await request('PATCH', `/projects/${projectId}`, token, { status: 'archived' });
  await request('DELETE', `/knowledge/sources/${source.id}`, token, undefined, 409);
  evidence({ checkpoint: 'real-ingestion-query', embeddingModel: source.embedding.model, dimension: source.embedding.dimension, answer: answer.answer, unknownAnswer: unknown.answer, references: answer.references.length, scopeAndOwnerIsolation: true });
  await close();
  await mongoose.disconnect();
  await mongoose.connect(config.mongodbUrl, { serverSelectionTimeoutMS: 10000 });
  await listen(createApp, config);
  assert.equal((await request('GET', `/knowledge/sources?projectId=${projectId}`, token)).sources[0].id, source.id);
  const confirmation = await request('POST', `/projects/${projectId}/delete-confirmation`, token);
  await request('DELETE', `/projects/${projectId}`, token, { confirmationToken: confirmation.confirmationToken });
  assert.equal((await request('GET', '/knowledge/sources?scope=orphaned', token)).sources[0].id, source.id);
  await request('DELETE', `/knowledge/sources/${source.id}`, token);
  assert.equal(await RagSourceModel.countDocuments({ _id: source.id }), 0);
  assert.deepEqual((await vectors.query(stored.collectionId, { embedding: embedded.embeddings[0], nResults: 1, where })).ids, []);
  evidence({ checkpoint: 'reconnect-recovery-cleanup', mongoReconnectPersistence: true, vectorDeletion: true, limitations: 'Standalone loopback API; no Compose-provider routing, browser, GPU, process-crash or distributed proof.' });
  report.status = 'checks-passed-cleanup-pending';
}
async function cleanup() {
  await close();
  if (ownsDatabase) {
    if (mongoose.connection.readyState !== 1) await mongoose.connect(testMongoUrl, { serverSelectionTimeoutMS: 10000 });
    assert.equal(mongoose.connection.name, databaseName, 'Refusing cleanup of any other database.');
    // Only collections recorded in this randomly named, isolated test database.
    const leftovers = await mongoose.connection.db.collection('ragsources').find({}).toArray();
    for (const item of leftovers) if (item.collectionId && item.collectionName) collections.push({ id: item.collectionId, name: item.collectionName });
    for (const item of new Map(collections.map(c => [c.name, c])).values()) {
      assert.match(item.name, /^kfive-rag-v1-[a-f0-9]{32}$/);
      const found = await fetch(new URL(`/api/v1/collections/${item.name}`, process.env.CHROMA_URL), { signal: AbortSignal.timeout(10000) }).then(r => r.json());
      assert.equal(found.id, item.id);
      const removed = await fetch(new URL(`/api/v1/collections/${item.name}`, process.env.CHROMA_URL), { method: 'DELETE', signal: AbortSignal.timeout(10000) });
      assert.ok(removed.ok);
    }
    assert.match(databaseName, /^kfive_rag_verify_[a-f0-9]{16}$/);
    await mongoose.connection.db.dropDatabase();
    report.status = process.exitCode ? 'failed-cleaned' : 'passed';
    evidence({ cleanup: 'isolated test database and recorded vector collections removed' });
  }
  await mongoose?.disconnect();
}
main().catch(error => {
  report.status = 'failed';
  const failure = { failed: true, kind: error.name, code: error.code || 'LIVE_RAG_CHECK_FAILED', assertion: error.name === 'AssertionError' ? error.message : undefined };
  if (ownsDatabase) evidence(failure);
  else console.error(JSON.stringify(failure));
  process.exitCode = 1;
}).finally(() => cleanup().catch(async () => {
  report.status = 'cleanup-failed';
  evidence({ cleanupFailed: true, database: databaseName, message: 'Inspect only this isolated test database and its recorded collections before retrying.' });
  process.exitCode = 1;
  await mongoose?.disconnect();
}));
