'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, fork } = require('node:child_process');
const mongoose = require('mongoose');
const root = path.resolve(__dirname, '..');
const template = { sourceKind: 'text', name: 'Quota acceptance', mediaType: 'text/plain', status: 'queued',
  characterCount: 5, byteCount: 5, chunkCount: 0, chunkingVersion: 1, contentHash: 'a'.repeat(64), contentSnapshot: 'hello',
  embeddingProvider: 'ollama', embeddingModel: 'fixture' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, title, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${title}`);
}
if (process.argv.includes('--child')) {
  process.once('message', async ({ ownerId, count, pause }) => {
    try {
      await mongoose.connect(process.env.MONGODB_URL);
      const { mongooseRagSourceRepository: repository } = require('../backend/dist/services/ragService');
      const results = [];
      for (let i = 0; i < count; i++) {
        try { const row = await repository.create({ ...template, ownerId }); results.push({ id: String(row._id) }); }
        catch (error) { if (error.code !== 'RAG_SOURCE_LIMIT_EXCEEDED') throw error; results.push({ rejected: true }); }
      }
      if (!pause) await mongoose.disconnect();
      process.send({ results });
      if (!pause) process.disconnect();
    } catch (error) { process.send({ failure: error.message }); await mongoose.disconnect(); process.disconnect(); process.exitCode = 1; }
  });
} else {
  assert.ok(process.argv.includes('--allow-live-test'), 'Requires --allow-live-test');
  const nonce = crypto.randomBytes(8).toString('hex');
  const label = `kfive-rag-quota-${nonce}`;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), label));
  const children = new Set();
  const report = { status: 'RUNNING', topology: 'isolated real MongoDB, production repository in independent Node processes; no provider calls', checks: [] };
  let container, network, beforeVolumes, childEnv;
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000 }).trim();
  function volumes() {
    const names = docker('volume', 'ls', '-q').split('\n').filter(Boolean);
    return names.length ? Object.fromEntries(JSON.parse(docker('volume', 'inspect', ...names)).map(v => [v.Name, [v.CreatedAt, v.Mountpoint]])) : {};
  }
  async function child(ownerId, count, pause = false) {
    const process = fork(__filename, ['--child'], { cwd: scratch, env: childEnv, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    children.add(process); process.once('exit', () => children.delete(process));
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Quota contender timeout')), 60000);
      process.once('message', message => { clearTimeout(timer); message.failure ? reject(new Error(message.failure)) : resolve(message.results); });
      process.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('Quota contender failed')); });
    });
    process.send({ ownerId, count, pause });
    return { process, results: await response };
  }
  async function main() {
    beforeVolumes = volumes();
    network = docker('network', 'create', '--internal', '--label', `kfive.acceptance=${nonce}`, label);
    const directory = path.join(scratch, 'mongo'); fs.mkdirSync(directory, { mode: 0o700 });
    container = docker('run', '-d', '--init', '--name', label, '--label', `kfive.acceptance=${nonce}`, '--network', label,
      '--user', `${process.getuid()}:${process.getgid()}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '128',
      '--mount', `type=bind,src=${directory},dst=/data/db`, '--entrypoint', 'mongod', 'mongo:7', '--bind_ip_all');
    const ip = JSON.parse(docker('inspect', container))[0].NetworkSettings.Networks[label].IPAddress;
    childEnv = { PATH: process.env.PATH, NODE_ENV: 'test', MONGODB_URL: `mongodb://${ip}:27017/rag_quota_acceptance`, REDIS_URL: 'redis://127.0.0.1:1',
      AI_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'http://127.0.0.1:1', JWT_SECRET: crypto.randomBytes(48).toString('hex'), JWT_REFRESH_SECRET: crypto.randomBytes(48).toString('hex') };
    Object.assign(process.env, childEnv);
    await mongoose.connect(childEnv.MONGODB_URL);
    const collection = mongoose.connection.collection('ragsources');
    const ownerId = new mongoose.Types.ObjectId(); const otherOwner = new mongoose.Types.ObjectId();
    const legacy = Array.from({ length: 196 }, (_, i) => ({ _id: new mongoose.Types.ObjectId(), ...template,
      ownerId, status: ['queued', 'indexing', 'ready', 'failed'][i % 4], ...(i % 2 ? { projectId: new mongoose.Types.ObjectId() } : {}) }));
    await collection.insertMany(legacy);
    const { migrate } = require('./migrations/20261121-rag-quota-index.cjs');
    assert.equal((await migrate(mongoose.connection.db)).valid, false);
    assert.equal((await migrate(mongoose.connection.db, true)).valid, true);
    assert.equal((await migrate(mongoose.connection.db, true)).valid, true);
    assert.deepEqual(await collection.find({ ownerId }).toArray(), legacy);
    report.checks.push('Read-only inspection and idempotent additive index migration preserve 196 legacy records across scopes/statuses');
    const { RagSourceModel, RAG_QUOTA_INDEX_NAME } = require('../backend/dist/models/RagSource');
    const { mongooseRagSourceRepository: repository } = require('../backend/dist/services/ragService');
    await RagSourceModel.init();
    report.checks.push(await require('./rag-retry-acceptance.cjs').verify());
    const contenders = await Promise.all(Array.from({ length: 8 }, () => child(String(ownerId), 4)));
    const results = contenders.flatMap(row => row.results);
    assert.equal(results.filter(row => row.id).length, 4); assert.equal(results.filter(row => row.rejected).length, 28);
    assert.equal(await collection.countDocuments({ ownerId }), 200);
    const rows = await collection.find({ ownerId, quotaSlot: { $exists: true } }).toArray();
    assert.deepEqual(rows.map(row => row.quotaSlot).sort((a, b) => a - b), [196, 197, 198, 199]);
    assert.deepEqual(await collection.find({ _id: { $in: legacy.map(row => row._id) } }).toArray(), legacy);
    report.checks.push('Eight independent Node processes contend for four remaining slots: exactly four admits, 28 quota rejections, all legacy data unchanged');
    await repository.deleteByOwnerAndId(String(ownerId), String(rows[0]._id));
    const crashed = await child(String(ownerId), 1, true); assert.ok(crashed.results[0].id);
    crashed.process.kill('SIGKILL'); await until(() => crashed.process.signalCode !== null, 'crashed writer exit');
    assert.equal(await collection.countDocuments({ ownerId }), 200);
    await assert.rejects(() => repository.create({ ...template, ownerId: String(ownerId) }), { code: 'RAG_SOURCE_LIMIT_EXCEEDED' });
    await repository.deleteByOwnerAndId(String(ownerId), String(legacy[0]._id));
    const reclaimed = await repository.create({ ...template, ownerId: String(ownerId) });
    assert.equal(reclaimed.quotaSlot, 195); assert.equal(await collection.countDocuments({ ownerId }), 200);
    report.checks.push('Deletion releases capacity; writer SIGKILL after insertion leaves one counted durable source; deleting legacy data opens exactly one additional slot');
    const other = await Promise.all(Array.from({ length: 8 }, () => child(String(otherOwner), 25)));
    assert.equal(other.flatMap(row => row.results).filter(row => row.id).length, 200);
    assert.equal(await collection.countDocuments({ ownerId: otherOwner }), 200);
    assert.equal(new Set((await collection.find({ ownerId: otherOwner }).toArray()).map(row => row.quotaSlot)).size, 200);
    assert.ok((await child(String(otherOwner), 1)).results[0].rejected);
    report.checks.push('Independent owner fills 200 unique slots under eight-process contention and rejects source 201');
    const excessOwner = new mongoose.Types.ObjectId();
    await collection.insertMany(Array.from({ length: 201 }, () => ({ ...template, ownerId: excessOwner })));
    await assert.rejects(() => repository.create({ ...template, ownerId: String(excessOwner) }), { code: 'RAG_SOURCE_LIMIT_EXCEEDED' });
    assert.equal(await collection.countDocuments({ ownerId: excessOwner }), 201);
    report.checks.push('Pre-existing over-limit owner retains all 201 records and cannot admit another source');
    const freshOwner = new mongoose.Types.ObjectId(); const documentId = new mongoose.Types.ObjectId();
    await repository.create({ ...template, ownerId: String(freshOwner), sourceKind: 'document', documentId: String(documentId) });
    await assert.rejects(() => repository.create({ ...template, ownerId: String(freshOwner), sourceKind: 'document', documentId: String(documentId) }), { code: 11000 });
    assert.equal(await collection.countDocuments({ ownerId: freshOwner }), 1);
    await collection.dropIndex(RAG_QUOTA_INDEX_NAME);
    await assert.rejects(() => repository.create({ ...template, ownerId: String(freshOwner) }), /quota index/);
    assert.equal(await collection.countDocuments({ ownerId: freshOwner }), 1);
    await migrate(mongoose.connection.db, true);
    const publicRows = await repository.list(String(ownerId));
    assert.ok(publicRows.every(row => row.quotaSlot === undefined));
    report.checks.push('Document duplicate consumes no extra slot; missing quota index fails closed; private slots are absent from default list projection');
    await mongoose.disconnect(); docker('restart', container); await mongoose.connect(childEnv.MONGODB_URL);
    await assert.rejects(() => repository.create({ ...template, ownerId: String(ownerId) }), { code: 'RAG_SOURCE_LIMIT_EXCEEDED' });
    assert.equal((await migrate(mongoose.connection.db)).valid, true);
    report.checks.push('Mongo restart preserves source totals and enforcing unique index');
    const cleanup = await mongoose.connection.collection('ragsources').deleteMany({ ownerId: { $in: [ownerId, otherOwner, excessOwner, freshOwner] } });
    assert.equal(cleanup.deletedCount, 602);
    assert.equal(await mongoose.connection.collection('ragsources').countDocuments({}), 0);
    report.checks.push('Exact four fixture owners cleaned; no application database was accessed');
  }
  (async () => {
    let failure;
    try { await main(); } catch (error) { failure = error; }
    finally {
      for (const process of children) process.kill('SIGKILL');
      await mongoose.disconnect();
      try {
        if (container) { assert.equal(JSON.parse(docker('inspect', container))[0].Config.Labels['kfive.acceptance'], nonce); docker('rm', '-f', '-v', container); }
        if (network) docker('network', 'rm', network);
        const after = volumes(); for (const [name, identity] of Object.entries(beforeVolumes ?? {})) assert.deepEqual(after[name], identity);
        assert.equal(docker('ps', '-aq', '--filter', `label=kfive.acceptance=${nonce}`), '');
        report.checks.push('Exact temporary container/network removed; pre-existing volume identities unchanged');
      } catch (error) { failure ??= error; }
    }
    report.status = failure ? 'FAIL' : 'PASS'; report.scratch = scratch;
    fs.writeFileSync(path.join(root, 'output/verification/rag-quota-live.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2)); if (failure) { console.error(failure); process.exitCode = 1; }
  })();
}
