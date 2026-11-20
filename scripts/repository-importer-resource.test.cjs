'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  MIB,
  buildZip,
  createHostileFixtures,
  createNearMaximumFixture,
  createMultipartParts,
  parseCgroupPath,
  parseCounterFile,
  parseCpuMax,
  parseLimit,
  validateLoopbackApiUrl,
} = require('./repository-importer-resource-lib.cjs');

test('near-maximum fixture is deterministic and stays inside every admitted ZIP bound', () => {
  const first = createNearMaximumFixture();
  const second = createNearMaximumFixture();
  assert.equal(first.archive.equals(second.archive), true);
  assert.equal(first.entryCount, 2_000);
  assert.equal(first.manifestCount, 20);
  assert.ok(first.manifestBytes > 0 && first.manifestBytes < MIB);
  assert.ok(first.declaredBytes < 25 * MIB);
  assert.ok(first.maximumEntryBytes <= 5 * MIB);
  assert.ok(first.maximumPathBytes <= 512);
  assert.ok(first.archive.length >= 9 * MIB && first.archive.length <= 9.5 * MIB, first.archive.length);
  assert.equal(first.archive.readUInt32LE(first.archive.length - 22), 0x06054b50);
  assert.equal(first.archive.readUInt16LE(first.archive.length - 22 + 10), 2_000);
});

test('hostile fixtures encode the exact entry, ratio, and manifest boundaries', () => {
  const hostile = createHostileFixtures();
  assert.equal(hostile.entryLimit.entryCount, 2_001);
  assert.equal(hostile.manifestLimit.manifestCount, 21);
  assert.ok(hostile.ratioBomb.declaredBytes / hostile.ratioBomb.compressedPayloadBytes > 100);
  for (const fixture of Object.values(hostile)) assert.ok(fixture.archive.length < 10 * MIB);
  const one = buildZip([{ name: 'safe.txt', content: 'safe', method: 0 }]);
  assert.equal(one.archive.readUInt32LE(0), 0x04034b50);
  assert.equal(one.archive.readUInt32LE(one.archive.length - 22), 0x06054b50);
});

test('multipart helper accounts for the exact held prefix, archive and suffix', () => {
  const archive = Buffer.from('unique-payload-sentinel');
  const multipart = createMultipartParts({ name: 'Bounded report', filename: 'bounded.zip', archive });
  assert.equal(multipart.contentLength, multipart.prefix.length + archive.length + multipart.suffix.length);
  assert.match(multipart.contentType, /^multipart\/form-data; boundary=kfive-[a-f0-9]+$/);
  assert.match(multipart.prefix.toString('utf8'), /name="archive"; filename="bounded\.zip"/);
  assert.match(multipart.suffix.toString('utf8'), /--kfive-[a-f0-9]+--/);
  assert.equal(multipart.prefix.includes(archive), false);
});

test('cgroup parsers accept exact v2 controls and reject ambiguity', () => {
  assert.equal(parseCgroupPath('0::/system.slice/docker-safe.scope\n'), '/system.slice/docker-safe.scope');
  for (const value of ['0::/../../etc\n', '1:name:/x\n', '0::relative\n', '0::/a\n0::/b\n']) {
    assert.throws(() => parseCgroupPath(value), /cgroup/);
  }
  assert.deepEqual(parseCounterFile('usage_usec 10\nuser_usec 4\nsystem_usec 6\ncore_sched.force_idle_usec 0\n'), {
    usage_usec: 10,
    user_usec: 4,
    system_usec: 6,
    'core_sched.force_idle_usec': 0,
  });
  assert.throws(() => parseCounterFile('oom 1\noom 2\n'), /counter/);
  assert.throws(() => parseCounterFile('oom -1\n'), /counter/);
  assert.equal(parseLimit('536870912\n'), 536_870_912);
  assert.equal(parseLimit('max\n'), Infinity);
  assert.deepEqual(parseCpuMax('100000 100000\n'), { quota: 100_000, period: 100_000 });
  assert.throws(() => parseCpuMax('max 100000\n'), /finite/);
});

test('API URL validation permits only the local HTTP v1 proxy path', () => {
  assert.equal(validateLoopbackApiUrl('http://127.0.0.1:3002/api/v1').href, 'http://127.0.0.1:3002/api/v1');
  assert.equal(validateLoopbackApiUrl('http://localhost:3002/api/v1/').pathname, '/api/v1/');
  for (const value of ['https://127.0.0.1:3002/api/v1', 'http://example.test/api/v1', 'http://user@localhost/api/v1', 'http://localhost/api/v2', 'http://localhost/api/v1?q=x']) {
    assert.throws(() => validateLoopbackApiUrl(value), /loopback/);
  }
});

test('live verifier is opt-in, cgroup-aware, bounded, volume-preserving, and cleanup-aware', () => {
  const source = readFileSync(path.join(__dirname, 'verify-repository-importer-resources-live.cjs'), 'utf8');
  assert.match(source, /--allow-live-test/);
  assert.match(source, /memory\.current/);
  assert.match(source, /memory\.events/);
  assert.match(source, /pids\.current/);
  assert.match(source, /cpu\.stat/);
  assert.match(source, /REPOSITORY_ANALYZER_BUSY/);
  assert.match(source, /REPOSITORY_ENTRY_LIMIT_EXCEEDED/);
  assert.match(source, /REPOSITORY_UNCOMPRESSED_LIMIT_EXCEEDED/);
  assert.match(source, /REPOSITORY_MANIFEST_LIMIT_EXCEEDED/);
  assert.match(source, /protectedVolumes/);
  assert.match(source, /socketVolumeIdentity/);
  assert.match(source, /cleanupMongo/);
  assert.match(source, /for \(const label of identityLabels\) registered\.push\(await register\(label\)\)/);
  assert.match(source, /const validated=targets\.map/);
  assert.doesNotMatch(source, /--env-file/);
  assert.doesNotMatch(source, /docker\(\['(?:rm|volume', 'rm)/);
  assert.doesNotMatch(source, /compose\(\['down'/);
  assert.doesNotMatch(source, /latency|throughput|requestsPerSecond/i);
});
