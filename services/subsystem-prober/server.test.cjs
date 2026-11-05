'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { collectSubsystems, renderMetrics, TARGETS } = require('./server.cjs');

test('uses only the three fixed private subsystem targets', () => {
  assert.deepEqual(TARGETS, Object.freeze({
    mongodb: Object.freeze({ kind: 'tcp', host: 'mongodb.kfive.svc.cluster.local', port: 27017 }),
    redis: Object.freeze({ kind: 'tcp', host: 'redis.kfive.svc.cluster.local', port: 6379 }),
    chromadb: Object.freeze({ kind: 'http', host: 'chromadb.kfive.svc.cluster.local', port: 8000, path: '/api/v1/heartbeat' }),
  }));
});

test('collects fixed probes independently and fails errors closed', async () => {
  const results = await collectSubsystems({
    probeTcp: async (target) => target.port === 27017,
    probeHttp: async () => { throw new Error('secret diagnostic'); },
  });
  assert.deepEqual(results, { mongodb: true, redis: false, chromadb: false });
});

test('renders exactly three bounded series without target or diagnostic values', () => {
  const body = renderMetrics({ mongodb: true, redis: false, chromadb: true });
  assert.match(body, /kfive_subsystem_probe_success\{dependency="mongodb",probe="tcp"\} 1/);
  assert.match(body, /kfive_subsystem_probe_success\{dependency="redis",probe="tcp"\} 0/);
  assert.match(body, /kfive_subsystem_probe_success\{dependency="chromadb",probe="http"\} 1/);
  assert.equal((body.match(/^kfive_subsystem_probe_success\{/gm) || []).length, 3);
  assert.doesNotMatch(body, /cluster\.local|27017|6379|8000|secret|error/i);
});
