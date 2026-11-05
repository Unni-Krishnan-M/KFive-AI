#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { MAX_ARTIFACT_BYTES, assertDistinctPrefixes, resolveAllVolumeNames, validateArchiveMemberNames, verifyManifest } = require('./production-backup-lib.cjs');
const { parseEnvironmentFile, validateProductionEnvironment } = require('./production-environment.cjs');

function option(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
function docker(args, options = {}) {
  const stdio = options.stdio || (options.stdinFd !== undefined ? [options.stdinFd, 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']);
  return execFileSync('docker', args, {encoding: 'utf8', env: {...process.env, ...options.env}, maxBuffer: 64 * 1024 * 1024, stdio});
}
const envFile = option('--env-file');
const backupDirectory = option('--backup');
const composeOverride = option('--compose-override');
if (!process.argv.includes('--allow-new-volume-restore') || !envFile || !backupDirectory) {
  console.error('Usage: production-restore.cjs --allow-new-volume-restore --env-file <new-production.env> --backup <directory>');
  process.exit(2);
}
const environment = parseEnvironmentFile(envFile);
if (!process.argv.includes('--allow-live-test')) validateProductionEnvironment(environment);
const directory = path.resolve(backupDirectory);
const stat = fs.lstatSync(directory);
if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Backup path must be a private real directory');
const manifestPath = path.join(directory, 'manifest.json');
const manifestStat = fs.lstatSync(manifestPath);
if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 1024 * 1024) throw new Error('Manifest must be a bounded regular file');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assertDistinctPrefixes(manifest.source.volumePrefix, environment.KFIVE_VOLUME_PREFIX);
if (manifest.source.project === environment.KFIVE_PRODUCTION_PROJECT) throw new Error('Destination Compose project must differ from the backup source project');
if (manifest.source.database !== environment.MONGO_DATABASE) throw new Error('Mongo database name mismatch');

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'kfive-restore-stage-'));
fs.chmodSync(staging, 0o700);
process.once('exit', () => fs.rmSync(staging, {recursive: true, force: true}));
try {
  let stagedBytes = 0;
  for (const artifact of Object.values(manifest.artifacts || {})) {
    if (!artifact || typeof artifact.file !== 'string') throw new Error('Manifest artifact is invalid');
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > MAX_ARTIFACT_BYTES) throw new Error('Manifest artifact size is outside restore limits');
    stagedBytes += artifact.bytes;
    if (!Number.isSafeInteger(stagedBytes) || stagedBytes > MAX_ARTIFACT_BYTES * 4) throw new Error('Backup bundle exceeds the restore limit');
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(artifact.file) || artifact.file.includes('..')) throw new Error('Manifest artifact filename is unsafe');
    const sourcePath = path.join(directory, artifact.file);
    const sourceFd = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const targetFd = fs.openSync(path.join(staging, artifact.file), 'wx', 0o400);
    try {
      const sourceStat = fs.fstatSync(sourceFd);
      if (!sourceStat.isFile() || sourceStat.size !== artifact.bytes) throw new Error(`Artifact changed while staging: ${artifact.file}`);
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let count;
      while ((count = fs.readSync(sourceFd, buffer, 0, buffer.length, null)) > 0) fs.writeSync(targetFd, buffer, 0, count);
    } finally { fs.closeSync(sourceFd); fs.closeSync(targetFd); }
  }
  verifyManifest(staging, manifest, {mongodb: environment.KFIVE_MONGODB_IMAGE, redis: environment.KFIVE_REDIS_IMAGE, chromadb: environment.KFIVE_CHROMADB_IMAGE});
} catch (error) { fs.rmSync(staging, {recursive: true, force: true}); throw error; }

const project = environment.KFIVE_PRODUCTION_PROJECT;
const volumes = resolveAllVolumeNames(environment.KFIVE_VOLUME_PREFIX);
if (docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]).trim()) throw new Error('Destination Compose project already has containers');
if (docker(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]).trim()) throw new Error('Destination Compose project already has networks');
for (const volume of Object.values(volumes)) {
  try { docker(['volume', 'inspect', volume]); throw new Error(`Restore target volume already exists: ${volume}`); }
  catch (error) {
    const detail = `${String(error.stderr || '')}\n${String(error.stdout || '')}\n${String(error.message || error)}`;
    if (!/no such volume/i.test(detail)) throw error;
  }
}

function validateTar(artifact) {
  const archive = path.join(staging, artifact.file);
  const limits = ['--memory', '512m', '--pids-limit', '128', '--cpus', '2'];
  const members = docker(['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--entrypoint', 'tar', '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH', '--security-opt', 'no-new-privileges:true',
    ...limits, '--mount', `type=bind,src=${archive},dst=/backup/archive.tar,readonly`, environment.KFIVE_MONGODB_IMAGE, '-tf', '/backup/archive.tar']).split(/\r?\n/).filter(Boolean);
  validateArchiveMemberNames(members);
  const verbose = docker(['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--entrypoint', 'tar', '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH', '--security-opt', 'no-new-privileges:true',
    ...limits, '--mount', `type=bind,src=${archive},dst=/backup/archive.tar,readonly`, environment.KFIVE_MONGODB_IMAGE, '-tvf', '/backup/archive.tar']).split(/\r?\n/).filter(Boolean);
  if (verbose.some((line) => !['-', 'd'].includes(line[0]))) throw new Error('Archive contains a link or special file');
  let expandedBytes = 0;
  for (const line of verbose) {
    const match = line.match(/^[\-d][rwxStTs-]{9}\s+\S+\s+(\d+)\s/);
    if (!match) throw new Error('Archive metadata format is not safely parseable');
    expandedBytes += Number(match[1]);
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > 8 * 1024 * 1024 * 1024) throw new Error('Archive expands beyond the restore limit');
  }
}
for (const component of ['redis', 'chromadb', 'uploads']) validateTar(manifest.artifacts[component]);

if (composeOverride && !process.argv.includes('--allow-live-test')) throw new Error('--compose-override is reserved for the isolated live verifier');
const composeFile = path.resolve(__dirname, '..', 'docker-compose.production.yml');
const composeStat = fs.lstatSync(composeFile);
if (!composeStat.isFile() || composeStat.isSymbolicLink()) throw new Error('Production Compose definition must be a regular repository file');
const composeBase = ['compose', '--env-file', path.resolve(envFile), '-p', project, '-f', composeFile,
  ...(composeOverride ? ['-f', path.resolve(composeOverride)] : [])];
const compose = (args, options = {}) => docker([...composeBase, ...args], options).trim();
const restoreToken = crypto.randomUUID();
const created = [];
let mongoId;
let succeeded = false;
try {
  for (const [component, volume] of Object.entries(volumes)) {
    docker(['volume', 'create', '--label', `com.docker.compose.project=${project}`, '--label', 'com.kfive.restore=new-volume-only', '--label', `com.kfive.restore.token=${restoreToken}`, volume]);
    const inspected = JSON.parse(docker(['volume', 'inspect', volume]))[0];
    if (inspected.Name !== volume || inspected.Labels?.['com.docker.compose.project'] !== project || inspected.Labels?.['com.kfive.restore.token'] !== restoreToken) {
      throw new Error(`Restore target race or ownership mismatch: ${volume}`);
    }
    created.push(volume);
    if (component === 'logs' || component === 'mongodb') continue;
    const archive = path.join(staging, manifest.artifacts[component].file);
    docker(['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--entrypoint', 'tar', '--memory', '512m', '--pids-limit', '128', '--cpus', '2', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
      '--security-opt', 'no-new-privileges:true', '--mount', `type=volume,src=${volume},dst=/target`,
      '--mount', `type=bind,src=${archive},dst=/backup/archive.tar,readonly`, environment.KFIVE_MONGODB_IMAGE,
      '-xpf', '/backup/archive.tar', '-C', '/target']);
  }
  compose(['up', '-d', '--wait', 'mongodb']);
  mongoId = compose(['ps', '-q', 'mongodb']);
  if (!/^[a-f0-9]{12,64}$/.test(mongoId)) throw new Error('Restored Mongo container did not start');
  const mongoArchive = path.join(staging, manifest.artifacts.mongodb.file);
  const archiveFd = fs.openSync(mongoArchive, 'r');
  try { docker(['run', '--rm', '-i', '--network', `${project}_data_internal`, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m', '--memory', '512m', '--pids-limit', '128', '--cpus', '2', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-e', 'MONGO_DATABASE', '-e', 'MONGO_APP_USERNAME', '-e', 'MONGO_APP_PASSWORD', environment.KFIVE_MONGODB_IMAGE, 'sh', '-ceu',
    'mongorestore --quiet --archive --gzip --drop --nsInclude "$MONGO_DATABASE.*" --host mongodb --username "$MONGO_APP_USERNAME" --password "$MONGO_APP_PASSWORD" --authenticationDatabase "$MONGO_DATABASE"'],
    {stdinFd: archiveFd, env: {MONGO_DATABASE: environment.MONGO_DATABASE, MONGO_APP_USERNAME: environment.MONGO_APP_USERNAME, MONGO_APP_PASSWORD: environment.MONGO_APP_PASSWORD}});
  } finally { fs.closeSync(archiveFd); }
  docker(['stop', mongoId]);
  mongoId = undefined;
  succeeded = true;
} catch (error) {
  try { compose(['down', '--remove-orphans']); } catch (cleanupError) { error.cleanupError = String(cleanupError); }
  for (const volume of created.reverse()) {
    try {
      const inspected = JSON.parse(docker(['volume', 'inspect', volume]))[0];
      if (inspected.Labels?.['com.kfive.restore.token'] !== restoreToken) throw new Error(`Refusing cleanup of unowned volume ${volume}`);
      docker(['volume', 'rm', volume]);
    } catch (cleanupError) { error.cleanupError = `${error.cleanupError || ''}; ${String(cleanupError)}`; }
  }
  throw error;
} finally {
  if (!succeeded && mongoId) { try { docker(['stop', mongoId]); } catch {} }
}
console.log(`Restored KFive backup ${manifest.backupId} into fresh prefix ${environment.KFIVE_VOLUME_PREFIX}; start the destination stack after queue-state review.`);
