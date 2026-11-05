#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildManifest, createPrivateBackupDirectory, resolveVolumeNames } = require('./production-backup-lib.cjs');
const { parseEnvironmentFile, validateProductionEnvironment } = require('./production-environment.cjs');

function option(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
function docker(args, options = {}) {
  const stdio = options.stdio || (options.stdoutFd !== undefined ? ['ignore', options.stdoutFd, 'pipe'] : ['ignore', 'pipe', 'pipe']);
  return execFileSync('docker', args, {encoding: 'utf8', env: {...process.env, ...options.env}, maxBuffer: 64 * 1024 * 1024, stdio});
}

const envFile = option('--env-file');
const output = option('--output');
if (!process.argv.includes('--allow-maintenance-backup') || !envFile || !output) {
  console.error('Usage: production-backup.cjs --allow-maintenance-backup --env-file <production.env> --output <new-directory>');
  process.exit(2);
}

const environment = parseEnvironmentFile(envFile);
if (!process.argv.includes('--allow-live-test')) validateProductionEnvironment(environment);
const project = environment.KFIVE_PRODUCTION_PROJECT;
const prefix = environment.KFIVE_VOLUME_PREFIX;
const composeFile = path.resolve(__dirname, '..', 'docker-compose.production.yml');
const composeStat = fs.lstatSync(composeFile);
if (!composeStat.isFile() || composeStat.isSymbolicLink()) throw new Error('Production Compose definition must be a regular repository file');
const composeBase = ['compose', '--env-file', path.resolve(envFile), '-p', project, '-f', composeFile];
const compose = (args) => docker([...composeBase, ...args]).trim();
const ids = Object.fromEntries(['frontend', 'backend', 'benchmark-worker', 'mongodb', 'redis', 'chromadb'].map((service) => [service, compose(['ps', '-q', service])]));
for (const [service, id] of Object.entries(ids)) if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error(`${service} must be running before backup`);
const volumes = resolveVolumeNames(prefix);
for (const [component, volume] of Object.entries(volumes)) {
  const inspected = JSON.parse(docker(['volume', 'inspect', volume]))[0];
  if (inspected.Name !== volume || inspected.Labels?.['com.docker.compose.project'] !== project) throw new Error(`Refusing unexpected ${component} volume ${volume}`);
}
const expected = {
  mongodb: {image: environment.KFIVE_MONGODB_IMAGE, mounts: {'/data/db': volumes.mongodb}},
  redis: {image: environment.KFIVE_REDIS_IMAGE, mounts: {'/data': volumes.redis}},
  chromadb: {image: environment.KFIVE_CHROMADB_IMAGE, mounts: {'/chroma/chroma': volumes.chromadb}},
  backend: {image: environment.KFIVE_BACKEND_IMAGE, mounts: {'/app/uploads': volumes.uploads, '/app/logs': `${prefix}_backend_logs`}},
  'benchmark-worker': {image: environment.KFIVE_BACKEND_IMAGE, mounts: {}}, frontend: {image: environment.KFIVE_FRONTEND_IMAGE, mounts: {}},
};
for (const [service, contract] of Object.entries(expected)) {
  const inspected = JSON.parse(docker(['inspect', ids[service]]))[0];
  if (inspected.State?.Running !== true || inspected.Config?.Image !== contract.image
    || inspected.Config?.Labels?.['com.docker.compose.project'] !== project
    || inspected.Config?.Labels?.['com.docker.compose.service'] !== service) throw new Error(`Source ${service} container does not match the validated Compose project/image`);
  for (const [destination, name] of Object.entries(contract.mounts)) {
    if (!inspected.Mounts.some((mount) => mount.Type === 'volume' && mount.Name === name && mount.Destination === destination)) {
      throw new Error(`Source ${service} does not mount expected volume ${name} at ${destination}`);
    }
  }
}

const directory = createPrivateBackupDirectory(output);
const files = {mongodb: 'mongodb.archive.gz', redis: 'redis.tar', chromadb: 'chromadb.tar', uploads: 'uploads.tar'};
const stopped = [];
const startedAt = new Date().toISOString();
function stop(service) { docker(['stop', ids[service]]); stopped.push(service); }
function writePrivateFromDocker(filename, args, options = {}) {
  const target = path.join(directory, filename);
  const descriptor = fs.openSync(target, 'wx', 0o600);
  try { docker(args, {...options, stdoutFd: descriptor}); }
  catch (error) { fs.closeSync(descriptor); fs.unlinkSync(target); throw error; }
  fs.closeSync(descriptor);
}
const helperLimits = ['--memory', '512m', '--pids-limit', '128', '--cpus', '2'];
const MAX_SOURCE_BYTES = 7 * 1024 * 1024 * 1024;
for (const [component, volume] of Object.entries(volumes)) {
  const measured = Number(docker(['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--entrypoint', 'du', ...helperLimits, '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH', '--security-opt', 'no-new-privileges:true',
    '--mount', `type=volume,src=${volume},dst=/source,readonly`, environment.KFIVE_MONGODB_IMAGE, '-sb', '/source']).trim().split(/\s+/)[0]);
  if (!Number.isSafeInteger(measured) || measured < 0 || measured > MAX_SOURCE_BYTES) throw new Error(`${component} source volume exceeds the 7 GiB backup limit`);
}
function archiveVolume(volume, filename) {
  writePrivateFromDocker(filename, ['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--entrypoint', 'tar', ...helperLimits, '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH', '--security-opt', 'no-new-privileges:true',
    '--mount', `type=volume,src=${volume},dst=/source,readonly`, environment.KFIVE_MONGODB_IMAGE, '-C', '/source', '-cf', '-', '.']);
}

let operationError;
const restartErrors = [];
try {
  for (const service of ['frontend', 'backend', 'benchmark-worker']) stop(service);
  docker(['run', '--rm', '--network', `${project}_data_internal`, '--read-only', ...helperLimits, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-e', 'REDIS_PASSWORD', environment.KFIVE_REDIS_IMAGE, 'sh', '-ceu',
    'for queue in benchmark-runs notebook-runs code-runs ai-processing; do count="$(redis-cli -h redis -a "$REDIS_PASSWORD" --no-auth-warning LLEN "bull:${queue}:active")"; [ "$count" = 0 ] || { echo "Refusing backup while ${queue} has active work" >&2; exit 1; }; done'],
  {env: {REDIS_PASSWORD: environment.REDIS_PASSWORD}});
  writePrivateFromDocker(files.mongodb, ['run', '--rm', '--network', `${project}_data_internal`, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m', ...helperLimits, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-e', 'MONGO_DATABASE', '-e', 'MONGO_APP_USERNAME', '-e', 'MONGO_APP_PASSWORD', environment.KFIVE_MONGODB_IMAGE, 'sh', '-ceu',
    'mongodump --quiet --archive --gzip --host mongodb --db "$MONGO_DATABASE" --username "$MONGO_APP_USERNAME" --password "$MONGO_APP_PASSWORD" --authenticationDatabase "$MONGO_DATABASE"'],
  {env: {MONGO_DATABASE: environment.MONGO_DATABASE, MONGO_APP_USERNAME: environment.MONGO_APP_USERNAME, MONGO_APP_PASSWORD: environment.MONGO_APP_PASSWORD}});
  docker(['run', '--rm', '--network', `${project}_data_internal`, '--read-only', ...helperLimits, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-e', 'REDIS_PASSWORD', environment.KFIVE_REDIS_IMAGE, 'sh', '-ceu', 'redis-cli -h redis -a "$REDIS_PASSWORD" --no-auth-warning SAVE >/dev/null'],
  {env: {REDIS_PASSWORD: environment.REDIS_PASSWORD}});
  stop('redis');
  stop('chromadb');
  archiveVolume(volumes.redis, files.redis);
  archiveVolume(volumes.chromadb, files.chromadb);
  archiveVolume(volumes.uploads, files.uploads);
  const manifest = buildManifest({
    directory, sourceProject: project, sourcePrefix: prefix, database: environment.MONGO_DATABASE,
    images: {mongodb: environment.KFIVE_MONGODB_IMAGE, redis: environment.KFIVE_REDIS_IMAGE, chromadb: environment.KFIVE_CHROMADB_IMAGE},
    files, startedAt, completedAt: new Date().toISOString(),
  });
  const temporary = path.join(directory, '.manifest.json.tmp');
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
  fs.renameSync(temporary, path.join(directory, 'manifest.json'));
  console.log(`Created quiesced KFive application backup ${manifest.backupId} at ${directory}.`);
} catch (error) {
  operationError = error;
} finally {
  for (const service of ['chromadb', 'redis', 'benchmark-worker', 'backend', 'frontend']) {
    if (stopped.includes(service)) {
      try {
        docker(['start', ids[service]]);
        const state = JSON.parse(docker(['inspect', ids[service], '--format', '{{json .State.Running}}']));
        if (state !== true) throw new Error(`${service} did not return to running state`);
      } catch (error) { restartErrors.push(error); }
    }
  }
}
if (operationError) {
  if (restartErrors.length) operationError.restartErrors = restartErrors.map(String);
  throw operationError;
}
if (restartErrors.length) throw new AggregateError(restartErrors, 'Backup completed but source services did not all restart');
