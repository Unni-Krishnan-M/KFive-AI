#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { deflateRawSync } = require('node:zlib');

if (!process.argv.includes('--allow-live-test')) {
  console.error('Refusing the disposable repository importer API check without --allow-live-test.');
  process.exit(2);
}

const baseUrl = new URL(process.env.KFIVE_LIVE_BASE_URL || 'http://127.0.0.1:3002/api/v1');
assert.equal(baseUrl.protocol, 'http:', 'The local verifier requires loopback HTTP.');
assert.ok(baseUrl.hostname === '127.0.0.1' || baseUrl.hostname === 'localhost', 'The local verifier requires a loopback host.');
assert.equal(baseUrl.pathname.replace(/\/$/, ''), '/api/v1', 'The local verifier requires the /api/v1 base path.');
assert.equal(baseUrl.username, ''); assert.equal(baseUrl.password, '');
assert.equal(baseUrl.search, ''); assert.equal(baseUrl.hash, '');
const base = baseUrl.href.replace(/\/$/, '');
const nonce = crypto.randomBytes(8).toString('hex');
const email = `repository-importer-live-${nonce}@example.invalid`;
const username = `ri_${nonce}`;
const password = `Kf!${crypto.randomBytes(24).toString('base64url')}`;
const protectedVolumes = [
  'kfive-ai_mongodb_data', 'kfive-ai_redis_data', 'kfive-ai_chromadb_data',
  'kfive-ai_backend_uploads', 'kfive-ai_backend_logs', 'kfive-ai_ollama_bridge_socket',
];
let userId;
let analysisId;
let cleanupComplete = false;

function docker(args) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    }).trim();
  } catch {
    throw new Error('Docker verifier operation failed (details suppressed).');
  }
}

function volumeIdentities() {
  return Object.fromEntries(protectedVolumes.map((name) => [name,
    docker(['volume', 'inspect', name, '--format', '{{.Name}}|{{.CreatedAt}}|{{.Mountpoint}}']),
  ]));
}

function crc32(content) {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipFile(name, content, flags = 0) {
  const nameBytes = Buffer.from(name);
  const source = Buffer.from(content);
  const compressed = deflateRawSync(source);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(source), 14); local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(source.length, 22); local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc32(source), 16);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(source.length, 24); central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(local.length + nameBytes.length + compressed.length, 16);
  return Buffer.concat([local, nameBytes, compressed, central, nameBytes, end]);
}

async function request(route, { method = 'GET', token, body, expected = 200 } = {}) {
  const response = await fetch(`${base}${route}`, {
    method, body, signal: AbortSignal.timeout(30_000),
    headers: {
      ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${result.error?.code || 'unexpected response'}`);
  return result;
}

function cleanupMongo() {
  if (!userId) return { matchedUsers: 0, reportsBefore: 0, reportsAfter: 0, usersAfter: 0 };
  assert.match(userId, /^[a-f0-9]{24}$/);
  assert.match(email, /^repository-importer-live-[a-f0-9]{16}@example\.invalid$/);
  const mongoId = docker(['compose', 'ps', '-q', 'mongodb']);
  assert.match(mongoId, /^[a-f0-9]+$/, 'MongoDB Compose container was not found.');
  const networks = JSON.parse(docker(['inspect', mongoId, '--format', '{{json .NetworkSettings.Networks}}']));
  const networkNames = Object.keys(networks);
  assert.equal(networkNames.length, 1, 'Refusing cleanup through an ambiguous MongoDB network.');
  assert.match(networkNames[0], /^kfive-ai_[a-zA-Z0-9_.-]+$/);
  const script = [
    `const id=ObjectId(${JSON.stringify(userId)});`,
    `const email=${JSON.stringify(email)};`,
    'const user=db.users.findOne({_id:id,email},{_id:1,email:1});',
    'const reportsBefore=db.repositoryanalyses.countDocuments({ownerId:id});',
    'if(!user){throw new Error("guarded verifier user not found")}',
    'db.repositoryanalyses.deleteMany({ownerId:id});',
    'db.users.deleteOne({_id:id,email});',
    'print(JSON.stringify({matchedUsers:1,reportsBefore,reportsAfter:db.repositoryanalyses.countDocuments({ownerId:id}),usersAfter:db.users.countDocuments({_id:id})}));',
  ].join('');
  const output = docker(['run', '--rm', '--network', networkNames[0], '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--env-file', '.env', '-e', `KFIVE_CLEANUP_EVAL=${script}`,
    'mongo:7.0', 'sh', '-ceu',
    'mongosh --quiet --host mongodb --username "$MONGO_ROOT_USERNAME" --password "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin "${MONGO_DATABASE:-kfive_ai}" --eval "$KFIVE_CLEANUP_EVAL"',
  ]);
  const result = JSON.parse(output.split('\n').at(-1));
  assert.deepEqual(result, { matchedUsers: 1, reportsBefore: 0, reportsAfter: 0, usersAfter: 0 });
  cleanupComplete = true;
  return result;
}

async function main() {
  const volumesBefore = volumeIdentities();
  const readinessBefore = await request('/readiness');
  assert.equal(readinessBefore.status, 'ready');

  try {
    const registration = await request('/auth/register', {
      method: 'POST', expected: 201,
      body: JSON.stringify({ email, username, password, firstName: 'Repository', lastName: 'Verifier' }),
    });
    const identity = registration.data;
    userId = identity.user._id;
    const token = identity.accessToken;
    assert.match(userId, /^[a-f0-9]{24}$/);

    const validZip = zipFile('package.json', JSON.stringify({ name: `verified-${nonce}`, dependencies: { express: '^5.1.0' } }));
    const expectedSha256 = crypto.createHash('sha256').update(validZip).digest('hex');
    const validForm = new FormData();
    validForm.append('name', `Importer process live ${nonce}`);
    validForm.append('archive', new Blob([validZip], { type: 'application/zip' }), 'repository.zip');
    const created = await request('/repositories/analyses', { method: 'POST', token, body: validForm, expected: 201 });
    const analysis = created.data.analysis;
    analysisId = analysis._id || analysis.id;
    assert.match(analysisId, /^[a-f0-9]{24}$/);
    assert.equal(analysis.source.sha256, expectedSha256);
    assert.equal(analysis.source.originalName, 'repository.zip');
    assert.equal(analysis.summary.fileCount, 1);
    assert.deepEqual(analysis.tree.map(({ path, type }) => ({ path, type })), [{ path: 'package.json', type: 'file' }]);

    const detail = await request(`/repositories/analyses/${analysisId}`, { token });
    assert.equal((detail.data.analysis._id || detail.data.analysis.id), analysisId);
    assert.equal(detail.data.analysis.source.sha256, expectedSha256);

    const encryptedZip = zipFile('secret.txt', 'encrypted-marker', 1);
    const encryptedForm = new FormData();
    encryptedForm.append('name', `Encrypted rejection ${nonce}`);
    encryptedForm.append('archive', new Blob([encryptedZip], { type: 'application/zip' }), 'encrypted.zip');
    const encrypted = await request('/repositories/analyses', { method: 'POST', token, body: encryptedForm, expected: 400 });
    assert.equal(encrypted.success, false);
    assert.deepEqual(encrypted.error, {
      code: 'REPOSITORY_ARCHIVE_ENCRYPTED', message: 'Encrypted ZIP entries are not supported.',
    });

    const listed = await request('/repositories/analyses', { token });
    assert.equal(listed.data.pagination.total, 1);
    assert.equal(listed.data.count, 1);
    assert.equal((listed.data.analyses[0]._id || listed.data.analyses[0].id), analysisId);
    const deleted = await request(`/repositories/analyses/${analysisId}`, { method: 'DELETE', token });
    assert.equal(deleted.data.deleted, true);
    analysisId = undefined;
    const empty = await request('/repositories/analyses', { token });
    assert.equal(empty.data.pagination.total, 0);
    assert.equal(empty.data.count, 0);

    const cleanup = cleanupMongo();
    const processTable = docker(['top', 'kfive-ai-backend-1', '-eo', 'pid,args']);
    assert.doesNotMatch(processTable, /repositoryArchiveWorkerMain/);
    const readinessAfter = await request('/readiness');
    assert.equal(readinessAfter.status, 'ready');
    assert.deepEqual(volumeIdentities(), volumesBefore);
    console.log(JSON.stringify({
      mode: 'real Compose frontend proxy -> authenticated backend API -> isolated repository parser child -> MongoDB',
      validArchivePersistedAndRetrieved: true,
      reportSha256: expectedSha256,
      encryptedArchiveRejected: true,
      encryptedAttemptPersistedReports: 0,
      cleanup,
      remainingImporterChildren: 0,
      readinessBefore: readinessBefore.status,
      readinessAfter: readinessAfter.status,
      protectedVolumesUnchanged: true,
      protectedVolumeNames: protectedVolumes,
    }, null, 2));
  } finally {
    if (analysisId && userId) {
      try {
        const login = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
        await request(`/repositories/analyses/${analysisId}`, { method: 'DELETE', token: login.data.accessToken });
        analysisId = undefined;
      } catch { /* guarded Mongo cleanup below removes only this verifier user's reports */ }
    }
    if (userId && !cleanupComplete) cleanupMongo();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
