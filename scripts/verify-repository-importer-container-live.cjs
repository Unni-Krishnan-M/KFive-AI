#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { deflateRawSync } = require('node:zlib');

if (!process.argv.includes('--allow-live-test')) {
  console.error('Refusing the repository importer container check without --allow-live-test.');
  process.exit(2);
}

const baseUrl = new URL(process.env.KFIVE_LIVE_BASE_URL || 'http://127.0.0.1:3002/api/v1');
assert.equal(baseUrl.protocol, 'http:', 'The local verifier requires loopback HTTP.');
assert.ok(['127.0.0.1', 'localhost'].includes(baseUrl.hostname), 'The local verifier requires a loopback host.');
assert.equal(baseUrl.pathname.replace(/\/$/, ''), '/api/v1', 'The local verifier requires the /api/v1 base path.');
assert.equal(baseUrl.username, ''); assert.equal(baseUrl.password, '');
assert.equal(baseUrl.search, ''); assert.equal(baseUrl.hash, '');
const base = baseUrl.href.replace(/\/$/, '');
const nonce = crypto.randomBytes(8).toString('hex');
const protectedVolumes = [
  'kfive-ai_mongodb_data', 'kfive-ai_redis_data', 'kfive-ai_chromadb_data',
  'kfive-ai_backend_uploads', 'kfive-ai_backend_logs', 'kfive-ai_ollama_bridge_socket',
];
const identities = [];
const analyses = [];
let importerStopped = false;
let importerRestartPolicyChanged = false;
let cleanupComplete = false;

function docker(args, timeout = 60_000) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 8 * 1024 * 1024,
    }).trim();
  } catch {
    throw new Error('Docker verifier operation failed (details suppressed).');
  }
}

function compose(args, timeout) { return docker(['compose', ...args], timeout); }
function dockerCombined(args, timeout = 60_000) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw new Error('Docker verifier operation failed (details suppressed).');
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}
function inspect(id) { return JSON.parse(docker(['inspect', id]))[0]; }
function containerId(service) {
  const id = compose(['ps', '--all', '-q', service]);
  assert.match(id, /^[a-f0-9]{12,64}$/, `${service} Compose container was not found.`);
  return id;
}
function volumeIdentities() {
  return Object.fromEntries(protectedVolumes.map((name) => [name,
    docker(['volume', 'inspect', name, '--format', '{{.Name}}|{{.CreatedAt}}|{{.Mountpoint}}']),
  ]));
}

async function waitFor(operation, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await operation()) return; } catch { /* retry bounded transient state */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not reach the required state.`);
}

async function request(route, { method = 'GET', token, body, expected = 200, timeoutMs = 45_000 } = {}) {
  const response = await fetch(`${base}${route}`, {
    method, body, signal: AbortSignal.timeout(timeoutMs),
    headers: {
      ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${result.error?.code || 'unexpected response'}`);
  return result;
}

function crc32(content) {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipFiles(files) {
  const localParts = []; const centralParts = []; let localOffset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name); const content = Buffer.from(file.content); const compressed = deflateRawSync(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(file.flags || 0, 6);
    local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(content), 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(file.flags || 0, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc32(content), 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(localOffset, 42);
    localParts.push(local, name, compressed); centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }
  const centralBytes = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes, 12); end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function analysisForm(name, archive, filename) {
  const form = new FormData();
  form.append('name', name);
  form.append('archive', new Blob([archive], { type: 'application/zip' }), filename);
  return form;
}

async function register(label) {
  const email = `repository-importer-${label}-${nonce}@example.invalid`;
  const password = `Kf!${crypto.randomBytes(24).toString('base64url')}`;
  const result = await request('/auth/register', {
    method: 'POST', expected: 201,
    body: JSON.stringify({ email, username: `${label}_${nonce}`, password, firstName: 'Repository', lastName: 'Verifier' }),
  });
  const identity = { email, password, userId: result.data.user._id, token: result.data.accessToken };
  assert.match(identity.userId, /^[a-f0-9]{24}$/);
  identities.push(identity);
  return identity;
}

function assertContainerBoundary(importerId, backendId) {
  const importer = inspect(importerId); const backend = inspect(backendId);
  assert.equal(importer.Config.User, '10001:10002');
  assert.equal(importer.HostConfig.NetworkMode, 'none');
  const importerNetworks = importer.NetworkSettings.Networks || {};
  assert.ok(Object.keys(importerNetworks).every((name) => name === 'none'));
  for (const attachment of Object.values(importerNetworks)) {
    assert.equal(attachment.IPAddress, ''); assert.equal(attachment.GlobalIPv6Address, '');
    assert.equal(attachment.Gateway, ''); assert.equal(attachment.IPv6Gateway, '');
    assert.equal(attachment.Aliases, null); assert.equal(attachment.Links, null);
  }
  assert.deepEqual(importer.HostConfig.PortBindings || {}, {});
  assert.equal(importer.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(importer.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(importer.HostConfig.SecurityOpt, ['no-new-privileges:true']);
  assert.equal(importer.HostConfig.PidsLimit, 48);
  assert.equal(importer.HostConfig.Memory, 512 * 1024 * 1024);
  assert.equal(importer.HostConfig.NanoCpus, 1_000_000_000);
  assert.equal(importer.HostConfig.Init, true);
  assert.equal(importer.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.equal(importer.HostConfig.Ulimits.find(({ Name }) => Name === 'core')?.Hard, 0);
  assert.equal(importer.HostConfig.Tmpfs['/tmp'], 'rw,noexec,nosuid,nodev,size=32m');
  const importerMounts = importer.Mounts.map(({ Type, Name, Destination, RW }) => ({ Type, Name, Destination, RW }));
  assert.equal(importerMounts.length, 1);
  assert.deepEqual(importerMounts[0], {
    Type: 'volume', Name: importerMounts[0].Name, Destination: '/run/kfive-repository-importer', RW: true,
  });
  assert.match(importerMounts[0].Name, /^kfive-ai_repository_importer_socket$/);
  const importerEnvironment = Object.fromEntries(importer.Config.Env.map((entry) => entry.split(/=(.*)/s).slice(0, 2)));
  assert.equal(importerEnvironment.NODE_ENV, 'production');
  assert.equal(importerEnvironment.REPOSITORY_IMPORTER_SOCKET_PATH, '/run/kfive-repository-importer/importer.sock');
  const allowedEnvironment = new Set(['NODE_ENV', 'REPOSITORY_IMPORTER_SOCKET_PATH', 'PATH', 'NODE_VERSION', 'YARN_VERSION']);
  assert.deepEqual(Object.keys(importerEnvironment).filter((key) => !allowedEnvironment.has(key)), []);
  assert.ok(!Object.keys(importerEnvironment).some((key) => /SECRET|PASSWORD|TOKEN|API_KEY|_URL$|MONGO|REDIS|CHROMA|OLLAMA|OPENAI|ANTHROPIC|CUSTOM|JWT/i.test(key)));

  const backendSocket = backend.Mounts.find(({ Destination }) => Destination === '/run/kfive-repository-importer');
  assert.ok(backendSocket); assert.equal(backendSocket.Type, 'volume'); assert.equal(backendSocket.RW, false);
  assert.equal(backendSocket.Name, importerMounts[0].Name);
  assert.ok(backend.HostConfig.GroupAdd.includes('10002'));
  assert.ok(!backend.Mounts.some(({ Source, Destination }) => Source === '/var/run/docker.sock' || Destination === '/var/run/docker.sock'));

  for (const protocol of ['tcp', 'tcp6']) {
    const table = readFileSync(`/proc/${importer.State.Pid}/net/${protocol}`, 'utf8').trim().split('\n').slice(1);
    assert.ok(!table.some((line) => line.trim().split(/\s+/)[3] === '0A'), `importer must not listen on ${protocol}`);
  }
  return { importer, socketVolume: importerMounts[0].Name };
}

function assertSocketIdentity(importer, socketVolume) {
  const script = "const s=require('node:fs').lstatSync('/run/kfive-repository-importer/importer.sock');console.log(JSON.stringify({uid:s.uid,gid:s.gid,mode:s.mode&511,socket:s.isSocket()}))";
  const output = docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--user', '10001:10002',
    '--mount', `type=volume,src=${socketVolume},dst=/run/kfive-repository-importer,readonly`,
    importer.Config.Image, 'node', '-e', script]);
  assert.deepEqual(JSON.parse(output), { uid: 10001, gid: 10002, mode: 0o660, socket: true });
}

async function status(token) { return (await request('/repositories/status', { token })).data; }
function importerDependency(value) { return value.dependencies.find(({ id }) => id === 'repository-importer'); }

async function uploadWithProcessObservation(identity, archive) {
  const importerId = containerId('repository-importer'); const backendId = containerId('backend');
  let finished = false; let sawImporterWorker = false; let sawBackendWorker = false;
  const pending = request('/repositories/analyses', {
    method: 'POST', token: identity.token, expected: 201, timeoutMs: 60_000,
    body: analysisForm(`Recovery ${nonce}`, archive, `recovery-${nonce}.zip`),
  }).finally(() => { finished = true; });
  const deadline = Date.now() + 15_000;
  while (!finished && Date.now() < deadline) {
    const importerTop = docker(['top', importerId, '-eo', 'pid,ppid,args']);
    const backendTop = docker(['top', backendId, '-eo', 'pid,ppid,args']);
    sawImporterWorker ||= /repositoryArchiveWorkerMain\.js/.test(importerTop);
    sawBackendWorker ||= /repositoryArchiveWorkerMain\.js/.test(backendTop);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const result = await pending;
  assert.equal(sawImporterWorker, true, 'transient parser child was not observed under the importer');
  assert.equal(sawBackendWorker, false, 'parser child appeared in the backend container');
  assert.doesNotMatch(docker(['top', importerId, '-eo', 'pid,args']), /repositoryArchiveWorkerMain\.js/);
  assert.doesNotMatch(docker(['top', backendId, '-eo', 'pid,args']), /repositoryArchiveWorkerMain\.js/);
  return result;
}

function cleanupMongo() {
  const targets = identities.filter(({ userId }) => userId).map(({ userId, email }) => {
    assert.match(userId, /^[a-f0-9]{24}$/);
    assert.match(email, /^repository-importer-(primary|recovery)-[a-f0-9]{16}@example\.invalid$/);
    return { userId, email };
  });
  if (!targets.length) return { matchedUsers: 0, reportsAfter: 0, usersAfter: 0 };
  const mongoId = containerId('mongodb');
  const networks = JSON.parse(docker(['inspect', mongoId, '--format', '{{json .NetworkSettings.Networks}}']));
  const networkNames = Object.keys(networks);
  assert.equal(networkNames.length, 1); assert.match(networkNames[0], /^kfive-ai_[a-zA-Z0-9_.-]+$/);
  const encodedTargets = JSON.stringify(targets);
  const script = [
    `const targets=${encodedTargets};`,
    'let matchedUsers=0;for(const target of targets){const id=ObjectId(target.userId);const user=db.users.findOne({_id:id,email:target.email},{_id:1});if(!user)throw new Error("guarded verifier user not found");matchedUsers+=1;db.repositoryanalyses.deleteMany({ownerId:id});db.users.deleteOne({_id:id,email:target.email});}',
    'const ids=targets.map((target)=>ObjectId(target.userId));',
    'print(JSON.stringify({matchedUsers,reportsAfter:db.repositoryanalyses.countDocuments({ownerId:{$in:ids}}),usersAfter:db.users.countDocuments({_id:{$in:ids}})}));',
  ].join('');
  const output = docker(['run', '--rm', '--network', networkNames[0], '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--env-file', '.env', '-e', `KFIVE_CLEANUP_EVAL=${script}`,
    'mongo:7.0', 'sh', '-ceu',
    'mongosh --quiet --host mongodb --username "$MONGO_ROOT_USERNAME" --password "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin "${MONGO_DATABASE:-kfive_ai}" --eval "$KFIVE_CLEANUP_EVAL"',
  ]);
  const result = JSON.parse(output.split('\n').at(-1));
  assert.deepEqual(result, { matchedUsers: targets.length, reportsAfter: 0, usersAfter: 0 });
  cleanupComplete = true;
  return result;
}

async function main() {
  const volumesBefore = volumeIdentities();
  const readiness = await request('/readiness'); assert.equal(readiness.status, 'ready');
  const importerId = containerId('repository-importer'); const backendId = containerId('backend');
  const boundary = assertContainerBoundary(importerId, backendId);
  assertSocketIdentity(boundary.importer, boundary.socketVolume);
  const socketVolumeBefore = docker(['volume', 'inspect', boundary.socketVolume, '--format', '{{.Name}}|{{.CreatedAt}}|{{.Mountpoint}}']);

  try {
    const primary = await register('primary'); const recovery = await register('recovery');
    const validArchive = zipFiles([{ name: 'package.json', content: JSON.stringify({ name: `valid-${nonce}`, dependencies: { express: '^5.1.0' } }) }]);
    const validSha = crypto.createHash('sha256').update(validArchive).digest('hex');
    const created = await request('/repositories/analyses', {
      method: 'POST', token: primary.token, expected: 201,
      body: analysisForm(`Primary ${nonce}`, validArchive, `primary-${nonce}.zip`),
    });
    const primaryId = created.data.analysis._id || created.data.analysis.id;
    assert.match(primaryId, /^[a-f0-9]{24}$/); assert.equal(created.data.analysis.source.sha256, validSha);
    analyses.push({ id: primaryId, identity: primary });

    docker(['update', '--restart=no', importerId]); importerRestartPolicyChanged = true;
    docker(['kill', '--signal', 'SIGKILL', importerId]); importerStopped = true;
    await waitFor(() => inspect(importerId).State.Running === false, 'forced importer stop');
    assertSocketIdentity(boundary.importer, boundary.socketVolume);
    await waitFor(async () => {
      const current = await status(primary.token);
      return current.canAnalyze === false && importerDependency(current)?.status === 'unavailable';
    }, 'repository importer unavailable status');
    const unavailable = await request('/repositories/analyses', {
      method: 'POST', token: primary.token, expected: 503,
      body: analysisForm(`Unavailable ${nonce}`, validArchive, `unavailable-${nonce}.zip`),
    });
    assert.deepEqual(unavailable.error, { code: 'REPOSITORY_ANALYZER_UNAVAILABLE', message: 'Repository importer is unavailable.' });
    const primaryList = await request('/repositories/analyses', { token: primary.token });
    assert.equal(primaryList.data.pagination.total, 1);
    assert.equal((await request(`/repositories/analyses/${primaryId}`, { token: primary.token })).data.analysis.source.sha256, validSha);

    docker(['update', '--restart=unless-stopped', importerId]); importerRestartPolicyChanged = false;
    compose(['start', 'repository-importer']); importerStopped = false;
    await waitFor(async () => {
      const current = await status(primary.token);
      return current.canAnalyze === true && importerDependency(current)?.status === 'available';
    }, 'repository importer recovery');
    const recoveredImporter = inspect(containerId('repository-importer'));
    const recoveredBoundary = assertContainerBoundary(recoveredImporter.Id, backendId);
    assertSocketIdentity(recoveredBoundary.importer, recoveredBoundary.socketVolume);

    const encryptedArchive = zipFiles([{ name: 'secret.txt', content: 'encrypted-log-sentinel', flags: 1 }]);
    const encrypted = await request('/repositories/analyses', {
      method: 'POST', token: recovery.token, expected: 400,
      body: analysisForm(`Encrypted ${nonce}`, encryptedArchive, `encrypted-${nonce}.zip`),
    });
    assert.deepEqual(encrypted.error, { code: 'REPOSITORY_ARCHIVE_ENCRYPTED', message: 'Encrypted ZIP entries are not supported.' });
    assert.equal((await request('/repositories/analyses', { token: recovery.token })).data.pagination.total, 0);

    const manyFiles = Array.from({ length: 2_000 }, (_, index) => ({
      name: `src/f${String(index).padStart(5, '0')}.txt`, content: 'container-isolation-proof',
    }));
    const recoveryArchive = zipFiles(manyFiles);
    const recovered = await uploadWithProcessObservation(recovery, recoveryArchive);
    const recoveryId = recovered.data.analysis._id || recovered.data.analysis.id;
    assert.match(recoveryId, /^[a-f0-9]{24}$/); assert.equal(recovered.data.analysis.summary.fileCount, 2_000);
    analyses.push({ id: recoveryId, identity: recovery });

    compose(['restart', 'backend', 'repository-importer'], 90_000);
    await waitFor(async () => (await request('/readiness')).status === 'ready', 'backend readiness after restart', 90_000);
    await waitFor(async () => importerDependency(await status(primary.token))?.status === 'available', 'importer after joint restart');
    assert.equal((await request(`/repositories/analyses/${primaryId}`, { token: primary.token })).data.analysis.source.sha256, validSha);
    assert.equal((await request(`/repositories/analyses/${recoveryId}`, { token: recovery.token })).data.analysis.summary.fileCount, 2_000);

    const logs = `${dockerCombined(['logs', containerId('backend')])}\n${dockerCombined(['logs', containerId('repository-importer')])}`;
    assert.doesNotMatch(logs, new RegExp(nonce, 'i'));
    assert.doesNotMatch(logs, /encrypted-log-sentinel|container-isolation-proof/);

    for (const item of analyses.splice(0)) {
      const deleted = await request(`/repositories/analyses/${item.id}`, { method: 'DELETE', token: item.identity.token });
      assert.equal(deleted.data.deleted, true);
    }
    const cleanup = cleanupMongo();
    assert.deepEqual(volumeIdentities(), volumesBefore);
    assert.equal(docker(['volume', 'inspect', boundary.socketVolume, '--format', '{{.Name}}|{{.CreatedAt}}|{{.Mountpoint}}']), socketVolumeBefore);
    console.log(JSON.stringify({
      mode: 'loopback frontend proxy -> backend -> read-only Unix socket -> networkless importer -> one-shot parser child',
      importerBoundary: { uid: 10001, gid: 10002, networkMode: 'none', readOnlyRoot: true, socketMode: '0660' },
      validPersisted: true, encryptedRejectedWithoutPersistence: true,
      unavailableStatusAndFixed503: true, existingReportReadableWhileImporterStopped: true,
      staleSocketRestartRecovery: true, parserChildObservedOnlyInImporter: true,
      backendAndImporterRestartPersistence: true, protectedVolumesUnchanged: true,
      socketVolumeIdentityUnchanged: true, logsExcludedArchiveMetadataAndContent: true, cleanup,
    }, null, 2));
  } finally {
    if (importerRestartPolicyChanged) {
      try { docker(['update', '--restart=unless-stopped', containerId('repository-importer')]); importerRestartPolicyChanged = false; } catch { /* surface original failure */ }
    }
    if (importerStopped) {
      try { compose(['start', 'repository-importer']); importerStopped = false; } catch { /* surface original failure */ }
    }
    if (!cleanupComplete && identities.length) {
      try { cleanupMongo(); } catch { /* guarded cleanup failure is reported by the primary error */ }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
