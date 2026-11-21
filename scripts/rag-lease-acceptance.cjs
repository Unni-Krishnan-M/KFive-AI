'use strict';
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { RagIndexingLease } = require('../backend/dist/services/ragIndexingLease');

async function verify(url) {
  await mongoose.connect(url);
  try {
    const collection = mongoose.connection.collection('ragsources');
    const id = new mongoose.Types.ObjectId();
    await collection.insertOne({ _id: id, status: 'queued', contentSnapshot: 'private retry input' });
    const lease = new RagIndexingLease(1000);
    const contenders = await Promise.all(Array.from({ length: 8 }, () => lease.claim(String(id))));
    const winners = contenders.filter(Boolean); assert.equal(winners.length, 1);
    const first = winners[0]; assert.equal(first.attempt, 1); assert.equal(first.content, 'private retry input');
    assert.equal(await lease.renew(first), true);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(await lease.renew(first), false, 'expired ownership cannot be resurrected');
    const second = await lease.claim(String(id)); assert.equal(second.attempt, 2); assert.notEqual(second.token, first.token);
    const model = require('../backend/dist/models/RagSource').RagSourceModel;
    const stale = await model.updateOne(lease.ownershipFilter(first), { $set: { status: 'ready' } });
    assert.equal(stale.matchedCount, 0, 'stale token cannot publish over replacement');
    await new Promise(resolve => setTimeout(resolve, 1100));
    const third = await lease.claim(String(id)); assert.equal(third.attempt, 3);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(await lease.claim(String(id)), undefined, 'retry budget is finite');
    await collection.deleteOne({ _id: id });
  } finally { await mongoose.disconnect(); }
}
module.exports = { verify };
