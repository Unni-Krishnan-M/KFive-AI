'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { parseDockerByteSize, percentile, parsePrometheusSample, runBounded, stripAnsiControls } = require('./production-performance-lib.cjs');

test('percentile uses deterministic nearest rank', () => {
  const samples = [5, 1, 4, 2, 3];
  assert.equal(percentile(samples, 0.5), 3);
  assert.equal(percentile(samples, 0.95), 5);
  assert.equal(percentile(samples, 0.99), 5);
  assert.throws(() => percentile([], 0.95), /samples/);
});

test('Prometheus parser requires one exact finite sample and supports an absent zero baseline', () => {
  const metric = 'kfive_http_requests_total{method="GET",path="/api/v1/user/profile",status_code="200"}';
  assert.equal(parsePrometheusSample(`${metric} 240\n`, metric), 240);
  assert.equal(parsePrometheusSample('# no match\n', metric, { absentValue: 0 }), 0);
  assert.throws(() => parsePrometheusSample(`${metric} 1\n${metric} 2\n`, metric), /duplicate/);
  assert.throws(() => parsePrometheusSample(`${metric} NaN\n`, metric), /finite/);
});

test('bounded runner visits every input once without exceeding concurrency', async () => {
  let active = 0;
  let peak = 0;
  const visited = [];
  const inputs = Array.from({ length: 31 }, (_, index) => index);
  const results = await runBounded(inputs, 4, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    visited.push(value);
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 4);
  assert.deepEqual([...visited].sort((a, b) => a - b), inputs);
  assert.deepEqual(results, inputs.map((value) => value * 2));
});

test('Docker byte parser accepts bounded binary units and rejects ambiguous values', () => {
  assert.equal(parseDockerByteSize('512B'), 512);
  assert.equal(parseDockerByteSize('1.5MiB'), 1.5 * 1024 * 1024);
  assert.equal(parseDockerByteSize('2GiB'), 2 * 1024 * 1024 * 1024);
  assert.throws(() => parseDockerByteSize('12 MB'), /Docker byte size/);
  assert.throws(() => parseDockerByteSize('InfinityGiB'), /Docker byte size/);
});

test('Docker stats ANSI cursor controls are removed before JSON parsing', () => {
  assert.equal(stripAnsiControls('\u001b[H{"PIDs":"12"}\u001b[K'), '{"PIDs":"12"}');
});

test('live verifier is opt-in, private, bounded, and cleanup-aware', () => {
  const source = fs.readFileSync(path.join(__dirname, 'verify-production-performance-live.cjs'), 'utf8');
  assert.match(source, /--allow-live-test/);
  assert.match(source, /const REQUESTS = 240/);
  assert.match(source, /const CONCURRENCY = 12/);
  assert.match(source, /RATE_LIMIT_MAX_REQUESTS: "1000"/);
  assert.match(source, /process_resident_memory_bytes/);
  assert.match(source, /docker', \['stats'/);
  assert.match(source, /waitForSampleAfter/);
  assert.match(source, /maxSampledContainerBytes/);
  assert.doesNotMatch(source, /peakContainerBytes/);
  assert.doesNotMatch(source, /compose\(\['exec'/);
  assert.match(source, /protectedVolumes/);
  assert.match(source, /assertProjectAbsent\(\)/);
  assert.match(source, /let cleanupAuthorized = false/);
  assert.match(source, /assertProjectAbsent\(\);\n    cleanupAuthorized = true/);
  assert.match(source, /if \(cleanupAuthorized\) \{/);
  assert.match(source, /removeExactImage\(fixtureImage, true\)/);
});
