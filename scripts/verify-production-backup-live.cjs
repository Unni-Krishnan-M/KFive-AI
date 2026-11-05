#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

if (!process.argv.includes('--allow-live-test')) {
  console.error('Refusing the disposable backup/restore drill without --allow-live-test.');
  process.exit(2);
}

const nonce = crypto.randomBytes(6).toString('hex');
const sourceProject = `kfive-backup-source-${nonce}`;
const restoreProject = `kfive-backup-restore-${nonce}`;
const corruptProject = `kfive-backup-corrupt-${nonce}`;
const rollbackProject = `kfive-backup-rollback-${nonce}`;
const foreignProject = `kfive-backup-foreign-${nonce}`;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kfive-backup-live-'));
const backupDirectory = path.join(tempRoot, 'bundle');
const sourceEnv = path.join(tempRoot, 'source.env');
const restoreEnv = path.join(tempRoot, 'restore.env');
const healthOverride = path.join(tempRoot, 'no-exec-healthchecks.yml');
const restoreHealthOverride = path.join(tempRoot, 'restore-no-exec-healthcheck.yml');
const composeFiles = ['docker-compose.production.yml', 'docker-compose.production.acceptance.yml', healthOverride];
const suffixes = ['mongodb_data', 'redis_data', 'chromadb_data', 'backend_uploads', 'backend_logs'];
const protectedVolumes = ['kfive-ai_mongodb_data', 'kfive-ai_redis_data', 'kfive-ai_chromadb_data', 'kfive-ai_backend_uploads', 'kfive-ai_backend_logs', 'kfive-ai_ollama_bridge_socket'];
let cleanupErrors = [];
let foreignVolumeCreated = false;

function docker(args, options = {}) {
  const output = execFileSync('docker', args, {encoding: 'utf8', input: options.input, env: {...process.env, ...options.env}, stdio: options.stdio || (options.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']), maxBuffer: 1024 * 1024 * 1024});
  return typeof output === 'string' ? output.trim() : '';
}
function errorText(error) { return `${String(error.stderr || '')}\n${String(error.stdout || '')}\n${String(error.message || error)}`; }
function compose(project, envFile, args, options = {}) {
  return docker(['compose', '--env-file', envFile, '-p', project, ...composeFiles.flatMap((file) => ['-f', file]), ...args], options);
}
function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024});
  if (result.status !== 0) throw new Error(`${script} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function volumeNames(prefix) { return suffixes.map((suffix) => `${prefix}_${suffix}`); }
function existingVolumeIdentity(names) {
  const result = {};
  for (const name of names) {
    try { const item = JSON.parse(docker(['volume', 'inspect', name]))[0]; result[name] = `${item.Name}:${item.CreatedAt}:${item.Mountpoint}`; }
    catch (error) { if (!/no such volume/i.test(errorText(error))) throw error; }
  }
  return result;
}
function removeOwnedVolumes(project) {
  for (const volume of volumeNames(project)) {
    try {
      const inspected = JSON.parse(docker(['volume', 'inspect', volume]))[0];
      assert.equal(inspected.Labels?.['com.docker.compose.project'], project, `refusing foreign volume ${volume}`);
      docker(['volume', 'rm', volume]);
    } catch (error) { if (!/no such volume/i.test(errorText(error))) throw error; }
  }
}
function request(port, route, {method = 'GET', body, rawBody, headers = {}, token} = {}) {
  const payload = rawBody || (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
  return new Promise((resolve, reject) => {
    const req = http.request({hostname: '127.0.0.1', port, path: route, method, timeout: 30_000,
      headers: {...(body === undefined ? {} : {'content-type': 'application/json'}), ...(payload ? {'content-length': payload.length} : {}), ...(token ? {authorization: `Bearer ${token}`} : {}), ...headers}},
    (res) => { const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers})); });
    req.once('error', reject); req.once('timeout', () => req.destroy(new Error(`${method} ${route} timed out`))); if (payload) req.write(payload); req.end();
  });
}
function json(response) { return JSON.parse(response.body.toString('utf8')); }
async function retry(action, attempts = 40) { let last; for (let i = 0; i < attempts; i += 1) { try { return await action(); } catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 1000)); } } throw last; }
function envContents(project, port, secrets) {
  return [
    `KFIVE_PRODUCTION_PROJECT=${project}`, `KFIVE_VOLUME_PREFIX=${project}`, 'KFIVE_EDGE_BIND_ADDRESS=127.0.0.1', `KFIVE_EDGE_HTTP_PORT=${port}`,
    `KFIVE_FIXTURE_IMAGE=kfive-ai-remote-provider-fixture:${sourceProject}`, `KFIVE_FIXTURE_BEARER_TOKEN=${secrets.provider}`,
    'KFIVE_MODE=remote', `PUBLIC_BASE_URL=http://127.0.0.1:${port}`, `CORS_ORIGIN=http://127.0.0.1:${port}`, 'TRUST_PROXY_HOPS=1',
    'AI_PROVIDER=openai-compatible', 'AI_DEFAULT_MODEL=remote-chat', 'OPENAI_BASE_URL=http://remote-provider-fixture:4010/v1', `OPENAI_API_KEY=${secrets.provider}`,
    'OPENAI_COMPATIBLE_SUPPORTS_EMBEDDINGS=false', 'OPENAI_COMPATIBLE_SUPPORTS_STRUCTURED_OUTPUT=false',
    'MONGO_ROOT_USERNAME=kfive_root', `MONGO_ROOT_PASSWORD=${secrets.mongoRoot}`, 'MONGO_DATABASE=kfive_ai', 'MONGO_APP_USERNAME=kfive', `MONGO_APP_PASSWORD=${secrets.mongoApp}`,
    `REDIS_PASSWORD=${secrets.redis}`, `JWT_SECRET=${secrets.jwt}`, `JWT_REFRESH_SECRET=${secrets.refresh}`,
    'KFIVE_BACKEND_IMAGE=kfive-ai-backend', 'KFIVE_FRONTEND_IMAGE=kfive-ai-frontend', 'KFIVE_MONGODB_IMAGE=mongo:7.0', 'KFIVE_REDIS_IMAGE=redis:7.2-alpine', 'KFIVE_CHROMADB_IMAGE=chromadb/chroma:0.4.24',
  ].join('\n') + '\n';
}
function backendEval(project, source) {
  return docker(['run', '--rm', '--network', `${project}_data_internal`, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-e', 'CHROMA_URL=http://chromadb:8000', 'kfive-ai-backend', 'node', '-e', source]);
}
function redisCommand(project, password, command) {
  return docker(['run', '--rm', '--network', `${project}_data_internal`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-e', 'REDIS_PASSWORD', 'redis:7.2-alpine', 'sh', '-ceu', `redis-cli -h redis -a "$REDIS_PASSWORD" --no-auth-warning ${command}`], {env: {REDIS_PASSWORD: password}});
}

async function main() {
  const protectedBefore = existingVolumeIdentity(protectedVolumes);
  const sourcePort = crypto.randomInt(15_000, 30_000);
  const restorePort = crypto.randomInt(30_001, 55_000);
  const secrets = {provider: crypto.randomBytes(24).toString('base64url'), mongoRoot: `r${crypto.randomBytes(18).toString('base64url')}`, mongoApp: `a${crypto.randomBytes(18).toString('base64url')}`, redis: `d${crypto.randomBytes(18).toString('base64url')}`, jwt: crypto.randomBytes(32).toString('base64url'), refresh: crypto.randomBytes(32).toString('base64url')};
  fs.writeFileSync(sourceEnv, envContents(sourceProject, sourcePort, secrets), {mode: 0o600});
  fs.writeFileSync(restoreEnv, envContents(restoreProject, restorePort, secrets), {mode: 0o600});
  fs.writeFileSync(healthOverride, `services:\n  mongodb:\n    healthcheck: {disable: true}\n  redis:\n    healthcheck: {disable: true}\n  chromadb:\n    healthcheck: {disable: true}\n  remote-provider-fixture:\n    healthcheck: {disable: true}\n  backend:\n    healthcheck: {disable: true}\n    depends_on:\n      mongodb: {condition: service_started}\n      redis: {condition: service_started}\n      chromadb: {condition: service_started}\n      remote-provider-fixture: {condition: service_started}\n  benchmark-worker:\n    depends_on:\n      mongodb: {condition: service_started}\n      redis: {condition: service_started}\n  frontend:\n    healthcheck: {disable: true}\n    depends_on:\n      backend: {condition: service_started}\n`, {mode: 0o600});
  fs.writeFileSync(restoreHealthOverride, 'services:\n  mongodb:\n    healthcheck: {disable: true}\n', {mode: 0o600});
  const email = `backup-${nonce}@example.invalid`;
  const password = `Kf!${crypto.randomBytes(18).toString('base64url')}`;
  const dataset = Buffer.from(`name,value\nrecovery-marker,${nonce}\n`);
  const datasetSha = crypto.createHash('sha256').update(dataset).digest('hex');
  const redisKey = `kfive:backup:${nonce}`;
  const chromaCollection = `backup_${nonce}`;
  let userId;
  let datasetId;
  try {
    compose(sourceProject, sourceEnv, ['build', 'remote-provider-fixture'], {stdio: 'inherit'});
    compose(sourceProject, sourceEnv, ['up', '-d'], {stdio: 'inherit'});
    const registration = await retry(async () => { const result = await request(sourcePort, '/api/v1/auth/register', {method: 'POST', body: {email, username: `backup_${nonce}`, password, firstName: 'Backup', lastName: 'Verifier'}}); assert.equal(result.status, 201, result.body.toString()); return result; });
    const identity = json(registration).data; userId = identity.user._id;
    const boundary = `----kfive${nonce}`;
    const multipart = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nRecovery dataset\r\n--${boundary}\r\nContent-Disposition: form-data; name="dataset"; filename="recovery.csv"\r\nContent-Type: text/csv\r\n\r\n`), dataset, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const upload = await request(sourcePort, '/api/v1/datasets', {method: 'POST', rawBody: multipart, token: identity.accessToken, headers: {'content-type': `multipart/form-data; boundary=${boundary}`}});
    assert.equal(upload.status, 201, upload.body.toString()); datasetId = json(upload).data.dataset._id || json(upload).data.dataset.id;
    assert.match(datasetId, /^[a-f0-9]{24}$/);
    redisCommand(sourceProject, secrets.redis, `SET '${redisKey}' '${nonce}' >/dev/null`);
    backendEval(sourceProject, `(async()=>{const base=process.env.CHROMA_URL+'/api/v1';let r=await fetch(base+'/collections',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'${chromaCollection}'})});if(!r.ok)throw new Error(await r.text());const c=await r.json();r=await fetch(base+'/collections/'+c.id+'/add',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:['marker'],embeddings:[[0.1,0.2,0.3]],documents:['chroma-${nonce}'],metadatas:[{kind:'recovery'}]})});if(!r.ok)throw new Error(await r.text())})().catch(e=>{console.error(e);process.exit(1)})`);

    const activeSentinel = `active-${nonce}`;
    redisCommand(sourceProject, secrets.redis, `LPUSH 'bull:benchmark-runs:active' '${activeSentinel}' >/dev/null`);
    const blockedOutput = path.join(tempRoot, 'blocked-active-work');
    const blockedBackup = spawnSync(process.execPath, ['scripts/production-backup.cjs', '--allow-maintenance-backup', '--allow-live-test', '--env-file', sourceEnv, '--output', blockedOutput], {encoding: 'utf8'});
    assert.notEqual(blockedBackup.status, 0); assert.match(`${blockedBackup.stderr}\n${blockedBackup.stdout}`, /Refusing backup while benchmark-runs has active work/);
    assert.equal(fs.existsSync(path.join(blockedOutput, 'manifest.json')), false);
    assert.equal(redisCommand(sourceProject, secrets.redis, `LREM 'bull:benchmark-runs:active' 1 '${activeSentinel}'`), '1');
    const loginAfterRefusal = await retry(async () => { const result = await request(sourcePort, '/api/v1/auth/login', {method: 'POST', body: {email, password}}); assert.equal(result.status, 200, result.body.toString()); return result; });
    assert.equal(json(loginAfterRefusal).data.user._id, userId);

    runNode('scripts/production-backup.cjs', ['--allow-maintenance-backup', '--allow-live-test', '--env-file', sourceEnv, '--output', backupDirectory]);
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDirectory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.quiesced, true); assert.equal(manifest.policy.logs, 'excluded'); assert.equal(fs.statSync(backupDirectory).mode & 0o777, 0o700);
    const sourceLoginAfterBackup = await retry(async () => { const result = await request(sourcePort, '/api/v1/auth/login', {method: 'POST', body: {email, password}}); assert.equal(result.status, 200, result.body.toString()); return result; });
    const sourceTokenAfterBackup = json(sourceLoginAfterBackup).data.accessToken;
    const sourceDownloadAfterBackup = await request(sourcePort, `/api/v1/datasets/${datasetId}/download`, {token: sourceTokenAfterBackup});
    assert.equal(sourceDownloadAfterBackup.status, 200, sourceDownloadAfterBackup.body.toString()); assert.equal(crypto.createHash('sha256').update(sourceDownloadAfterBackup.body).digest('hex'), datasetSha);
    assert.equal(redisCommand(sourceProject, secrets.redis, `GET '${redisKey}'`), nonce);
    assert.equal(backendEval(sourceProject, `(async()=>{const base=process.env.CHROMA_URL+'/api/v1';const c=await (await fetch(base+'/collections/${chromaCollection}')).json();const x=await (await fetch(base+'/collections/'+c.id+'/get',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:['marker'],include:['documents']})})).json();if(x.documents[0]!=='chroma-${nonce}')throw new Error(JSON.stringify(x));console.log(x.documents[0])})().catch(e=>{console.error(e);process.exit(1)})`), `chroma-${nonce}`);

    const corruptRoot = path.join(tempRoot, 'corrupt'); fs.cpSync(backupDirectory, corruptRoot, {recursive: true}); fs.appendFileSync(path.join(corruptRoot, manifest.artifacts.redis.file), 'corrupt');
    const corruptEnv = path.join(tempRoot, 'corrupt.env'); fs.writeFileSync(corruptEnv, envContents(corruptProject, crypto.randomInt(55_001, 60_000), secrets), {mode: 0o600});
    const corrupt = spawnSync(process.execPath, ['scripts/production-restore.cjs', '--allow-new-volume-restore', '--allow-live-test', '--env-file', corruptEnv, '--backup', corruptRoot], {encoding: 'utf8'});
    assert.notEqual(corrupt.status, 0); assert.deepEqual(existingVolumeIdentity(volumeNames(corruptProject)), {});

    const rollbackRoot = path.join(tempRoot, 'rollback'); fs.cpSync(backupDirectory, rollbackRoot, {recursive: true});
    const rollbackManifestPath = path.join(rollbackRoot, 'manifest.json'); const rollbackManifest = JSON.parse(fs.readFileSync(rollbackManifestPath, 'utf8'));
    const badMongo = Buffer.from('valid-manifest-invalid-mongo-archive'); const badMongoPath = path.join(rollbackRoot, rollbackManifest.artifacts.mongodb.file); fs.writeFileSync(badMongoPath, badMongo, {mode: 0o600});
    rollbackManifest.artifacts.mongodb.bytes = badMongo.length; rollbackManifest.artifacts.mongodb.sha256 = crypto.createHash('sha256').update(badMongo).digest('hex'); fs.writeFileSync(rollbackManifestPath, `${JSON.stringify(rollbackManifest, null, 2)}\n`, {mode: 0o600});
    const rollbackEnv = path.join(tempRoot, 'rollback.env'); fs.writeFileSync(rollbackEnv, envContents(rollbackProject, crypto.randomInt(10_240, 14_999), secrets), {mode: 0o600});
    const rollback = spawnSync(process.execPath, ['scripts/production-restore.cjs', '--allow-new-volume-restore', '--allow-live-test', '--compose-override', restoreHealthOverride, '--env-file', rollbackEnv, '--backup', rollbackRoot], {encoding: 'utf8'});
    assert.notEqual(rollback.status, 0); assert.deepEqual(existingVolumeIdentity(volumeNames(rollbackProject)), {}); assert.equal(docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${rollbackProject}`]), ''); assert.equal(docker(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${rollbackProject}`]), '');

    const foreignEnv = path.join(tempRoot, 'foreign.env'); fs.writeFileSync(foreignEnv, envContents(foreignProject, crypto.randomInt(10_240, 14_999), secrets), {mode: 0o600});
    const foreignVolume = `${foreignProject}_redis_data`; docker(['volume', 'create', '--label', 'owner=foreign-sentinel', foreignVolume]); foreignVolumeCreated = true;
    const foreign = spawnSync(process.execPath, ['scripts/production-restore.cjs', '--allow-new-volume-restore', '--allow-live-test', '--env-file', foreignEnv, '--backup', backupDirectory], {encoding: 'utf8'});
    assert.notEqual(foreign.status, 0); assert.equal(JSON.parse(docker(['volume', 'inspect', foreignVolume]))[0].Labels.owner, 'foreign-sentinel'); docker(['volume', 'rm', foreignVolume]); foreignVolumeCreated = false;

    compose(sourceProject, sourceEnv, ['down', '--remove-orphans']); removeOwnedVolumes(sourceProject); assert.deepEqual(existingVolumeIdentity(volumeNames(sourceProject)), {});
    runNode('scripts/production-restore.cjs', ['--allow-new-volume-restore', '--allow-live-test', '--compose-override', restoreHealthOverride, '--env-file', restoreEnv, '--backup', backupDirectory]);
    compose(restoreProject, restoreEnv, ['up', '-d'], {stdio: 'inherit'});
    const login = await retry(async () => { const result = await request(restorePort, '/api/v1/auth/login', {method: 'POST', body: {email, password}}); assert.equal(result.status, 200, result.body.toString()); return result; });
    const restoredIdentity = json(login).data; assert.equal(restoredIdentity.user._id, userId);
    const download = await request(restorePort, `/api/v1/datasets/${datasetId}/download`, {token: restoredIdentity.accessToken});
    assert.equal(download.status, 200, download.body.toString()); assert.equal(crypto.createHash('sha256').update(download.body).digest('hex'), datasetSha);
    assert.equal(redisCommand(restoreProject, secrets.redis, `GET '${redisKey}'`), nonce);
    const chroma = backendEval(restoreProject, `(async()=>{const base=process.env.CHROMA_URL+'/api/v1';let r=await fetch(base+'/collections/${chromaCollection}');if(!r.ok)throw new Error(await r.text());const c=await r.json();r=await fetch(base+'/collections/'+c.id+'/get',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:['marker'],include:['documents','metadatas']})});if(!r.ok)throw new Error(await r.text());const x=await r.json();if(x.documents[0]!=='chroma-${nonce}')throw new Error(JSON.stringify(x));console.log(x.documents[0])})().catch(e=>{console.error(e);process.exit(1)})`);
    assert.equal(chroma, `chroma-${nonce}`);
    compose(restoreProject, restoreEnv, ['restart', 'mongodb', 'redis', 'chromadb', 'backend']); compose(restoreProject, restoreEnv, ['up', '-d'], {stdio: 'inherit'});
    const loginAgain = await retry(async () => { const result = await request(restorePort, '/api/v1/auth/login', {method: 'POST', body: {email, password}}); assert.equal(result.status, 200, result.body.toString()); return result; });
    const restartedIdentity = json(loginAgain).data; assert.equal(restartedIdentity.user._id, userId);
    const downloadAgain = await request(restorePort, `/api/v1/datasets/${datasetId}/download`, {token: restartedIdentity.accessToken});
    assert.equal(downloadAgain.status, 200, downloadAgain.body.toString()); assert.equal(crypto.createHash('sha256').update(downloadAgain.body).digest('hex'), datasetSha);
    assert.equal(redisCommand(restoreProject, secrets.redis, `GET '${redisKey}'`), nonce);
    assert.equal(backendEval(restoreProject, `(async()=>{const base=process.env.CHROMA_URL+'/api/v1';const c=await (await fetch(base+'/collections/${chromaCollection}')).json();const x=await (await fetch(base+'/collections/'+c.id+'/get',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:['marker'],include:['documents']})})).json();if(x.documents[0]!=='chroma-${nonce}')throw new Error(JSON.stringify(x));console.log(x.documents[0])})().catch(e=>{console.error(e);process.exit(1)})`), `chroma-${nonce}`);
    assert.deepEqual(existingVolumeIdentity(protectedVolumes), protectedBefore);
    console.log(JSON.stringify({mode: 'offline same-datastore-image production Compose application recovery', activeWorkRefusedAndSourceRecovered: true, sourceUsableAfterBackup: true, mongoIdentity: true, uploadsDatasetSha256: datasetSha, redisPersistentState: true, chromaRawRecord: true, postRestartAllComponents: true, corruptBundleRejectedBeforeMutation: true, postMutationRollback: true, foreignVolumeRefused: true, protectedVolumesUnchanged: true, logs: 'excluded'}, null, 2));
  } finally {
    if (foreignVolumeCreated) {
      try { const item = JSON.parse(docker(['volume', 'inspect', `${foreignProject}_redis_data`]))[0]; assert.equal(item.Labels?.owner, 'foreign-sentinel'); docker(['volume', 'rm', item.Name]); foreignVolumeCreated = false; } catch (error) { if (!/no such volume/i.test(errorText(error))) cleanupErrors.push(error); }
    }
    for (const [project, env] of [[sourceProject, sourceEnv], [restoreProject, restoreEnv], [corruptProject, path.join(tempRoot, 'corrupt.env')], [rollbackProject, path.join(tempRoot, 'rollback.env')], [foreignProject, path.join(tempRoot, 'foreign.env')]]) {
      try { if (fs.existsSync(env)) compose(project, env, ['down', '--remove-orphans']); } catch (error) { cleanupErrors.push(error); }
      try { removeOwnedVolumes(project); } catch (error) { cleanupErrors.push(error); }
    }
    for (const project of [sourceProject, restoreProject, corruptProject, rollbackProject, foreignProject]) {
      try { assert.deepEqual(existingVolumeIdentity(volumeNames(project)), {}); } catch (error) { cleanupErrors.push(error); }
    }
    try { assert.deepEqual(existingVolumeIdentity(protectedVolumes), protectedBefore); } catch (error) { cleanupErrors.push(error); }
    fs.rmSync(tempRoot, {recursive: true, force: true});
    if (cleanupErrors.length) {
      for (const error of cleanupErrors) console.error(`Cleanup failure: ${String(error.stderr || error.stack || error.message || error)}`);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
