'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  APPLICATION_COMPONENTS,
  assertDistinctPrefixes,
  buildManifest,
  createPrivateBackupDirectory,
  resolveVolumeNames,
  validateArchiveMemberNames,
  verifyManifest,
} = require('./production-backup-lib.cjs');

test('application backup is a fixed four-component consistency set', () => {
  assert.deepEqual(APPLICATION_COMPONENTS.map(({name}) => name), ['mongodb', 'redis', 'chromadb', 'uploads']);
  assert.deepEqual(resolveVolumeNames('restore-01'), {
    mongodb: 'restore-01_mongodb_data', redis: 'restore-01_redis_data',
    chromadb: 'restore-01_chromadb_data', uploads: 'restore-01_backend_uploads',
  });
  assert.throws(() => resolveVolumeNames('../user-data'));
  assert.throws(() => assertDistinctPrefixes('same', 'same'));
});

test('backup destination is new, private, and cannot be a symlink', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kfive-backup-contract-'));
  try {
    const destination = path.join(root, 'bundle');
    createPrivateBackupDirectory(destination);
    assert.equal(fs.statSync(destination).mode & 0o777, 0o700);
    assert.throws(() => createPrivateBackupDirectory(destination));
    const link = path.join(root, 'link');
    fs.symlinkSync(destination, link);
    assert.throws(() => createPrivateBackupDirectory(link));
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('manifest binds every artifact by size and sha256 and contains no secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kfive-backup-manifest-'));
  try {
    const files = {};
    for (const component of APPLICATION_COMPONENTS) {
      const filename = `${component.name}.archive`;
      fs.writeFileSync(path.join(root, filename), `fixture:${component.name}`, {mode: 0o600});
      files[component.name] = filename;
    }
    const manifest = buildManifest({
      directory: root, sourceProject: 'source-01', sourcePrefix: 'source-01',
      database: 'kfive_ai', images: {mongodb: 'mongo@sha256:' + 'a'.repeat(64), redis: 'redis@sha256:' + 'b'.repeat(64), chromadb: 'chroma@sha256:' + 'c'.repeat(64)}, files,
      startedAt: '2026-10-24T00:00:00.000Z', completedAt: '2026-10-24T00:01:00.000Z',
    });
    assert.equal(manifest.policy.secrets, 'excluded');
    assert.doesNotMatch(JSON.stringify(manifest), /mongo-password|redis-password|provider-token/i);
    verifyManifest(root, manifest, manifest.images);
    fs.appendFileSync(path.join(root, files.redis), 'corrupt');
    assert.throws(() => verifyManifest(root, manifest, manifest.images), /integrity/i);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('restore archive member-name validation rejects traversal and ambiguous names', () => {
  validateArchiveMemberNames(['./', './safe/', './safe/file.txt']);
  for (const members of [
    ['../escape'], ['/absolute'], ['./safe/../../escape'], ['C:\\escape'], ['./bad\u0001name'],
  ]) assert.throws(() => validateArchiveMemberNames(members));
  assert.throws(() => validateArchiveMemberNames(['./duplicate', './duplicate']));
});

test('operator entrypoints are explicit, offline, and never delete volumes', () => {
  const backup = fs.readFileSync('scripts/production-backup.cjs', 'utf8');
  const restore = fs.readFileSync('scripts/production-restore.cjs', 'utf8');
  assert.match(backup, /--allow-maintenance-backup/);
  assert.match(restore, /--allow-new-volume-restore/);
  assert.match(backup, /frontend.*backend.*benchmark-worker/s);
  assert.match(backup, /bull:\$\{queue\}:active/);
  assert.doesNotMatch(`${backup}\n${restore}`, /down\s+(?:-v|--volumes)/);
  assert.match(restore, /com\.kfive\.restore\.token/);
  assert.match(restore, /Destination Compose project must differ/);
  assert.match(restore, /Refusing cleanup of unowned volume/);
  assert.doesNotMatch(`${backup}\n${restore}`, /docker\.sock/);
  assert.ok(crypto.createHash('sha256').update(backup + restore).digest('hex'));
});
