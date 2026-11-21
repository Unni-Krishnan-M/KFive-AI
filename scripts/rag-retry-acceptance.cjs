'use strict';
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

// Run only against the caller's isolated acceptance database.
async function verify() {
  const { RagIndexingLease } = require('../backend/dist/services/ragIndexingLease');
  const { mongooseRagSourceRepository: repository } = require('../backend/dist/services/ragService');
  const collection = mongoose.connection.collection('ragsources');
  const ownerId = new mongoose.Types.ObjectId();
  const id = new mongoose.Types.ObjectId();
  const lease = new RagIndexingLease();
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fail = (claim, retryable = true, owner = String(ownerId)) => repository.markFailed(
    owner, String(id), 'RAG_PROVIDER_UNAVAILABLE', undefined, claim, retryable);
  try {
    await collection.insertOne({ _id: id, ownerId, status: 'queued', contentSnapshot: 'retry fixture' });
    const first = await lease.claim(String(id)); assert.equal(first.attempt, 1);
    await fail(first, true, String(new mongoose.Types.ObjectId()));
    assert.equal((await collection.findOne({ _id: id })).status, 'indexing', 'owner fence');
    await fail(first);
    let row = await collection.findOne({ _id: id });
    assert.equal(row.status, 'queued'); assert.equal(row.contentSnapshot, 'retry fixture');
    assert.equal(row.indexingLease.expiresAt - row.updatedAt, 5000);
    assert.equal(await lease.renew(first), false, 'late heartbeat cannot remove backoff');
    assert.equal(await lease.claim(String(id)), undefined, 'cannot retry before delay');
    await delay(5100);
    const second = await lease.claim(String(id)); assert.equal(second.attempt, 2);
    await fail(first);
    assert.equal((await collection.findOne({ _id: id })).status, 'indexing', 'stale attempt cannot requeue winner');
    await fail(second);
    row = await collection.findOne({ _id: id });
    assert.equal(row.indexingLease.expiresAt - row.updatedAt, 10000);
    assert.equal(await lease.claim(String(id)), undefined);
    await delay(10100);
    const third = await lease.claim(String(id)); assert.equal(third.attempt, 3);
    await fail(third);
    assert.equal((await collection.findOne({ _id: id })).status, 'failed');
    assert.equal(await lease.claim(String(id)), undefined, 'no fourth attempt');
    // A terminal adapter failure on the first attempt never enters backoff.
    await collection.updateOne({ _id: id }, { $set: { status: 'queued' }, $unset: { indexingLease: 1 } });
    await fail(await lease.claim(String(id)), false);
    assert.equal((await collection.findOne({ _id: id })).status, 'failed');
    return 'Real Mongo retry policy: server-time 5s/10s backoff, owner and stale-token fences, late heartbeat rejection, three-attempt cap, immediate terminal failure';
  } finally { await collection.deleteOne({ _id: id, ownerId }); }
}
module.exports = { verify };
