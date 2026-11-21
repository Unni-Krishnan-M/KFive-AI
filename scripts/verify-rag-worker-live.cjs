'use strict';
// Dedicated disposable database only; real Mongo leases, synthetic embedding/vector adapters.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const mongoose = require('mongoose');
const url = process.argv[2];
assert.match(url || '', /^mongodb:\/\/127\.0\.0\.1:\d+\/rag_worker_acceptance$/);
Object.assign(process.env, { NODE_ENV: 'test', MONGODB_URL: url, REDIS_URL: 'redis://127.0.0.1:6379',
  AI_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  JWT_SECRET: crypto.randomBytes(48).toString('hex'), JWT_REFRESH_SECRET: crypto.randomBytes(48).toString('hex') });
const { RagSourceModel } = require('../backend/dist/models/RagSource');
const { RagIndexingLease } = require('../backend/dist/services/ragIndexingLease');
const { RagIndexingWorker, mongooseRagIndexingWorkStore } = require('../backend/dist/services/ragIndexingWorker');
const { RagService, mongooseRagSourceRepository } = require('../backend/dist/services/ragService');
const checks = [];
const ids = [];
const workers = [];
const ownerId = String(new mongoose.Types.ObjectId());
const vectors = new Map();
let release;
let entered;
const blocked = new Promise(resolve => { entered = resolve; });
let block = false;
const ai = { id: 'ollama', capabilities: { embeddings: true }, healthCheck: async () => true,
  embed: async ({ input, model }) => {
    if (block) { block = false; entered(); await new Promise(resolve => { release = resolve; }); }
    return { provider: 'ollama', model, embeddings: input.map(() => [1, 0.5]) };
  } };
const vectorStore = { healthCheck: async () => true, getMaxBatchSize: async () => 8,
  getOrCreateCollection: async (name, metadata) => ({ id: 'fixture', name, metadata }),
  upsert: async (_id, rows) => rows.forEach(row => vectors.set(row.id, row)),
  deleteWhere: async (_id, where) => {
    const generation = where.$and?.find(part => part.indexingGeneration)?.indexingGeneration.$eq;
    for (const [id, row] of vectors) if (row.metadata.indexingGeneration === generation) vectors.delete(id);
  } };
const config = { aiEmbeddingModel: 'fixture', ragBackgroundIndexingEnabled: true };
const service = new RagService(mongooseRagSourceRepository, ai, vectorStore, config,
  async () => undefined, async () => undefined);
async function create() {
  const row = await service.ingest(ownerId, { name: 'Acceptance', mediaType: 'text/plain', content: 'Durable snapshot' });
  ids.push(row.id); assert.equal(row.status, 'queued'); return row.id;
}
async function until(predicate) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Timed out waiting for worker');
}
(async () => {
  await mongoose.connect(url);
  try {
    const id = await create();
    const lease = new RagIndexingLease();
    const first = await lease.claim(id);
    block = true;
    const obsolete = service.executeIndexingClaim(first).catch(() => undefined);
    await blocked;
    await RagSourceModel.updateOne({ _id: id }, { $set: { 'indexingLease.expiresAt': new Date(0) } });
    const second = await lease.claim(id);
    assert.equal(second.attempt, 2);
    await service.executeIndexingClaim(second);
    release(); await obsolete;
    const ready = await RagSourceModel.findById(id).select('+contentSnapshot').lean();
    assert.equal(ready.status, 'ready'); assert.equal(ready.indexingGeneration, second.token);
    assert.equal(ready.contentSnapshot, undefined);
    assert.ok([...vectors.values()].every(row => row.metadata.indexingGeneration === second.token));
    checks.push('Replacement publishes; delayed expired worker cannot publish or remove replacement vectors; private snapshot removed');
    const abandoned = await create();
    const dead = await lease.claim(abandoned);
    await RagSourceModel.updateOne({ _id: abandoned }, { $set: { 'indexingLease.expiresAt': new Date(0) } });
    const pending = await mongooseRagIndexingWorkStore.candidates();
    assert.ok(pending.includes(abandoned), 'abandoned source is discoverable');
    let calls = 0;
    for (let i = 0; i < 2; i++) {
      const worker = new RagIndexingWorker(async claim => { calls++; await service.executeIndexingClaim(claim); }, () => {});
      workers.push(worker); worker.start();
    }
    await until(async () => (await RagSourceModel.findById(abandoned).lean()).status === 'ready');
    await Promise.all(workers.map(worker => worker.stop()));
    assert.equal(calls, 1);
    assert.equal(await lease.renew(dead), false);
    checks.push('Two workers discover abandoned persisted claim; exactly one executes and publishes');
    const exhausted = await create();
    await RagSourceModel.updateOne({ _id: exhausted }, { $set: { status: 'indexing', indexingLease: {
      token: crypto.randomUUID(), attempt: 3, expiresAt: new Date(0) } } });
    const legacy = await create();
    await RagSourceModel.updateOne({ _id: legacy }, { $set: { status: 'indexing' } });
    await mongooseRagIndexingWorkStore.candidates();
    assert.equal((await RagSourceModel.findById(exhausted).lean()).status, 'failed');
    assert.equal((await RagSourceModel.findById(legacy).lean()).status, 'indexing');
    checks.push('Expired final attempt terminalizes; unclaimed legacy synchronous indexing is not stolen');
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    await RagSourceModel.deleteMany({ _id: { $in: ids }, ownerId });
    assert.equal(await RagSourceModel.countDocuments({ ownerId }), 0);
    await mongoose.disconnect();
  }
  const result = { topology: 'isolated real MongoDB, synthetic provider/vector adapters', checks, cleanup: 'exact source ids and owner; no existing application data accessed' };
  fs.writeFileSync('output/verification/rag-worker-live.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
