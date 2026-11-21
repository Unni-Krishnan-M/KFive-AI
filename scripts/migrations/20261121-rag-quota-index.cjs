'use strict';
// Additive schema migration. No source records are rewritten or deleted.
const { MongoClient } = require('mongoose').mongo;
const name = 'rag_owner_quota_slot_unique_v1';
const key = { ownerId: 1, quotaSlot: 1 };
const options = { name, unique: true, partialFilterExpression: { quotaSlot: { $type: 'number' } } };
async function migrate(db, apply = false) {
  const collection = db.collection('ragsources');
  if (apply) await collection.createIndex(key, options);
  const indexes = await collection.listIndexes().toArray().catch(error => {
    if (error.code === 26) return []; throw error;
  });
  const index = indexes.find(item => item.name === name);
  const valid = Boolean(index?.unique && JSON.stringify(index.key) === JSON.stringify(key)
    && JSON.stringify(index.partialFilterExpression) === JSON.stringify(options.partialFilterExpression));
  return { migration: name, applied: apply, valid, dataChanged: false };
}
module.exports = { migrate };
if (require.main === module) {
  (async () => {
    if (!process.env.MONGODB_URL) throw new Error('Set MONGODB_URL through the approved environment');
    if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Supported option: --apply (default is read-only inspection)');
    const client = new MongoClient(process.env.MONGODB_URL);
    try { await client.connect(); const result = await migrate(client.db(), process.argv.includes('--apply')); console.log(JSON.stringify(result)); if (!result.valid) process.exitCode = 1; }
    finally { await client.close(); }
  })().catch(() => { console.error('RAG quota migration failed; no source data was modified by this migration'); process.exitCode = 1; });
}
