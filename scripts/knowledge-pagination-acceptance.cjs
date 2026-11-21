'use strict';

const assert = require('node:assert/strict');
const { MongoClient, ObjectId } = require('mongoose').mongo;

async function verify({ request, owner, stranger, ownerEmail, strangerEmail, env, report, stop, startApi, getApi, frontend, account, scratch }) {
  const mongo = new MongoClient(env.MONGODB_URL); await mongo.connect();
  try {
    const db = mongo.db();
    const users = db.collection('users');
    const ownerId = (await users.findOne({ email: ownerEmail }))._id;
    const strangerId = (await users.findOne({ email: strangerEmail }))._id;
    const project = new ObjectId(); const deleted = new ObjectId();
    await db.collection('projects').insertOne({ _id: project, ownerId, name: 'Pagination fixture', status: 'active', tags: [], activity: [], lastActivityAt: new Date() });
    const sources = db.collection('ragsources'); const timestamp = new Date('2026-01-01T00:00:00Z');
    const records = [];
    for (const [scope, count, user, projectId] of [
      ['workspace', 217, ownerId], ['project', 103, ownerId, project],
      ['orphaned', 57, ownerId, deleted], ['stranger', 11, strangerId],
    ]) {
      for (let i = 0; i < count; i += 1) records.push({ _id: new ObjectId(), ownerId: user,
        ...(projectId ? { projectId } : {}), name: `${scope}-${i}`, sourceKind: 'text', mediaType: 'text/plain',
        status: 'failed', errorCode: 'RAG_INGESTION_FAILED', characterCount: 10, byteCount: 10, chunkCount: 0,
        chunkingVersion: 1, contentHash: 'a'.repeat(64), createdAt: timestamp, updatedAt: timestamp });
    }
    await sources.insertMany(records);
    const traverse = async (token, suffix = '') => {
      const ids = []; let cursor = ''; let pages = 0;
      do {
        const result = (await request(`/knowledge/sources?cursor=${cursor}${suffix}`, token)).data;
        assert.ok(++pages <= 10, 'finite traversal');
        assert.equal(result.count, result.sources.length); assert.ok(result.count <= 50);
        assert.equal(result.pagination.pageSize, 50);
        for (const source of result.sources) {
          assert.ok(!cursor || source.id < cursor);
          assert.doesNotMatch(JSON.stringify(source), /"(?:ownerId|collectionId|contentHash)"/);
          ids.push(source.id);
        }
        const next = result.pagination.nextCursor;
        if (next !== null) {
          assert.equal(result.count, 50); assert.equal(next, result.sources[49].id);
        }
        cursor = next;
      } while (cursor !== null);
      assert.equal(ids.length, new Set(ids).size);
      assert.deepEqual(ids, [...ids].sort().reverse());
      return ids;
    };
    for (const [prefix, token, suffix] of [['workspace', owner, ''], ['project', owner, `&projectId=${project}`],
      ['orphaned', owner, '&scope=orphaned'], ['stranger', stranger, '']]) {
      const actual = await traverse(token, suffix);
      const expected = records.filter(row => row.name.startsWith(`${prefix}-`)).map(row => String(row._id)).sort().reverse();
      assert.deepEqual(actual, expected);
      report.checks.push(`${prefix}: exact ${actual.length}-record traversal with tied timestamps and no duplicates`);
    }
    await request(`/knowledge/sources?cursor=&projectId=${project}`, stranger, 'GET', undefined, 404);
    assert.deepEqual(await traverse(stranger, '&scope=orphaned'), []);
    for (const suffix of ['cursor=bad', 'cursor[$gt]=', 'cursor=a&cursor=b', `cursor=&scope=orphaned&projectId=${project}`]) {
      await request(`/knowledge/sources?${suffix}`, owner, 'GET', undefined, 400);
    }
    const first = (await request('/knowledge/sources?cursor=', owner)).data;
    const cursor = first.pagination.nextCursor;
    await sources.deleteOne({ _id: new ObjectId(cursor), ownerId });
    const fresh = { ...records[0], _id: new ObjectId(), name: 'new-after-first-page' };
    await sources.insertOne(fresh);
    const continuation = (await request(`/knowledge/sources?cursor=${cursor}`, owner)).data;
    assert.equal(continuation.sources.length, 50);
    assert.ok(continuation.sources.every(row => row.id < cursor));
    const beforeRestart = await traverse(owner);
    await stop(getApi()); await startApi();
    assert.deepEqual(await traverse(owner), beforeRestart);
    assert.equal((await request('/knowledge/sources', owner)).data.count, 200, 'legacy route remains bounded');
    report.checks.push('Cross-owner project access, malformed/mixed cursors, deleted cursor record, concurrent new insertion, and API restart pass');
    if (frontend) {
      await require('./knowledge-browser-acceptance.cjs').verify({ frontend, account, project: String(project), scratch });
      report.checks.push('Chrome real login, five workspace pages, project/recovery scope switches, Previous/Next, and empty final Next controls pass');
    }
    await require('./rag-lease-acceptance.cjs').verify(env.MONGODB_URL);
    report.checks.push('Mongo lease primitive: eight-way claim race, server-time expiry, stale renewal/publication rejection, and three-attempt limit pass with a one-second test lease');
    report.fixtureRecords = records.length;
    report.scope = 'Seeded history metadata; real compiled API and MongoDB; no ingestion or inference claims';
  } finally { await mongo.close(); }
}

module.exports = { verify };
