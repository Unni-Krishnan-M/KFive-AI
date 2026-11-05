'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 100_000;
const APPLICATION_COMPONENTS = Object.freeze([
  {name: 'mongodb', suffix: 'mongodb_data', format: 'mongodb-archive-gzip'},
  {name: 'redis', suffix: 'redis_data', format: 'tar'},
  {name: 'chromadb', suffix: 'chromadb_data', format: 'tar'},
  {name: 'uploads', suffix: 'backend_uploads', format: 'tar'},
]);

function assertIdentifier(value, label = 'identifier') {
  if (!IDENTIFIER.test(value || '')) throw new Error(`${label} must be a 1-63 character safe identifier`);
  return value;
}

function resolveVolumeNames(prefix) {
  assertIdentifier(prefix, 'volume prefix');
  return Object.fromEntries(APPLICATION_COMPONENTS.map(({name, suffix}) => [name, `${prefix}_${suffix}`]));
}

function resolveAllVolumeNames(prefix) {
  return {...resolveVolumeNames(prefix), logs: `${prefix}_backend_logs`};
}

function assertDistinctPrefixes(source, destination) {
  assertIdentifier(source, 'source volume prefix');
  assertIdentifier(destination, 'destination volume prefix');
  if (source === destination) throw new Error('Source and destination volume prefixes must be distinct');
}

function createPrivateBackupDirectory(directory) {
  const resolved = path.resolve(directory);
  if (fs.existsSync(resolved)) throw new Error('Backup destination must not already exist');
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('Backup parent must be a real directory');
  fs.mkdirSync(resolved, {mode: 0o700});
  fs.chmodSync(resolved, 0o700);
  return resolved;
}

function sha256File(filename) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filename, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

function safeArtifactName(filename) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(filename) || filename.includes('..')) {
    throw new Error(`Unsafe artifact filename: ${filename}`);
  }
  return filename;
}

function buildManifest({directory, sourceProject, sourcePrefix, database, images, files, startedAt, completedAt}) {
  assertIdentifier(sourceProject, 'source project');
  assertIdentifier(sourcePrefix, 'source volume prefix');
  assertIdentifier(database, 'Mongo database');
  const artifacts = {};
  for (const component of APPLICATION_COMPONENTS) {
    const filename = safeArtifactName(files[component.name]);
    const fullPath = path.join(directory, filename);
    const stat = fs.lstatSync(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_ARTIFACT_BYTES) throw new Error(`${component.name} artifact must be a bounded non-empty regular file`);
    fs.chmodSync(fullPath, 0o600);
    artifacts[component.name] = {file: filename, format: component.format, bytes: stat.size, sha256: sha256File(fullPath)};
  }
  return {
    schema: 'kfive-production-application-backup/v1',
    backupId: crypto.randomUUID(), startedAt, completedAt, quiesced: true,
    source: {project: sourceProject, volumePrefix: sourcePrefix, database},
    images: {mongodb: images.mongodb, redis: images.redis, chromadb: images.chromadb},
    artifacts,
    policy: {logs: 'excluded', secrets: 'excluded', restore: 'new-volumes-only'},
  };
}

function verifyManifest(directory, manifest, expectedImages) {
  if (!manifest || manifest.schema !== 'kfive-production-application-backup/v1' || manifest.quiesced !== true) {
    throw new Error('Unsupported or non-quiesced backup manifest');
  }
  assertIdentifier(manifest.source?.project, 'manifest source project');
  assertIdentifier(manifest.source?.volumePrefix, 'manifest source prefix');
  assertIdentifier(manifest.source?.database, 'manifest database');
  for (const key of ['mongodb', 'redis', 'chromadb']) {
    if (typeof manifest.images?.[key] !== 'string' || !manifest.images[key]) throw new Error(`Manifest image missing: ${key}`);
    if (expectedImages && manifest.images[key] !== expectedImages[key]) throw new Error(`${key} image mismatch; same-version restore is required`);
  }
  const expectedNames = new Set(APPLICATION_COMPONENTS.map(({name}) => name));
  if (Object.keys(manifest.artifacts || {}).length !== expectedNames.size) throw new Error('Manifest component set is incomplete');
  for (const component of APPLICATION_COMPONENTS) {
    const artifact = manifest.artifacts?.[component.name];
    if (!artifact || artifact.format !== component.format || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > MAX_ARTIFACT_BYTES || !SHA256.test(artifact.sha256 || '')) {
      throw new Error(`Invalid ${component.name} manifest entry`);
    }
    const filename = safeArtifactName(artifact.file);
    const fullPath = path.join(path.resolve(directory), filename);
    const stat = fs.lstatSync(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.bytes || sha256File(fullPath) !== artifact.sha256) {
      throw new Error(`${component.name} backup integrity check failed`);
    }
    expectedNames.delete(component.name);
  }
  if (expectedNames.size) throw new Error('Manifest component set is incomplete');
  return manifest;
}

function validateArchiveMemberNames(members) {
  if (members.length > MAX_ARCHIVE_MEMBERS) throw new Error('Archive contains too many members');
  const seen = new Set();
  for (const raw of members) {
    if (!raw) continue;
    if (/^[A-Za-z]:[\\/]/.test(raw) || raw.includes('\\') || /[\x00-\x1f\x7f]/.test(raw) || path.posix.isAbsolute(raw)) {
      throw new Error(`Unsafe archive member: ${JSON.stringify(raw)}`);
    }
    const normalized = path.posix.normalize(raw.replace(/^\.\//, ''));
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error(`Archive traversal: ${raw}`);
    if (normalized !== '.' && seen.has(normalized)) throw new Error(`Duplicate archive member: ${raw}`);
    if (normalized !== '.') seen.add(normalized);
  }
}

module.exports = {
  APPLICATION_COMPONENTS, MAX_ARTIFACT_BYTES, MAX_ARCHIVE_MEMBERS, assertDistinctPrefixes, assertIdentifier, buildManifest,
  createPrivateBackupDirectory, resolveAllVolumeNames, resolveVolumeNames,
  sha256File, validateArchiveMemberNames, verifyManifest,
};
