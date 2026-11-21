#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { buildZip, createNearMaximumFixture, createHostileFixtures } = require('./repository-importer-resource-lib.cjs');

if (!process.argv.includes('--allow-live-test')) {
  console.error('Refusing Kubernetes importer acceptance without --allow-live-test.');
  process.exit(2);
}
const context = ['--context', 'kind-kfive'];
const nonce = crypto.randomBytes(8).toString('hex');
const identities = [];
let importerScaledDown = false;
let sampler;
const socketPath = '/run/kfive-repository-importer/importer.sock';

function command(program, args, timeout = 60_000) {
  try { return execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 8 * 1024 * 1024 }).trim(); }
  catch { throw new Error(`${program} acceptance operation failed (details suppressed).`); }
}
function kubectl(...args) { return command('kubectl', [...context, ...args], 260_000); }
function pod(name) {
  const items = JSON.parse(kubectl('-n', 'kfive', 'get', 'pods', '-l', `app.kubernetes.io/name=${name}`, '-o', 'json')).items
    .filter((p) => !p.metadata.deletionTimestamp && p.status.phase === 'Running');
  assert.equal(items.length, 1); return items[0];
}
function runNode(name, script, ...args) {
  return kubectl('-n', 'kfive', 'exec', `deployment/${name}`, '--', 'node', '-e', script, ...args);
}
function protectedObjects() {
  return Object.fromEntries(['pvc', 'secret'].map((kind) => [kind,
    JSON.parse(kubectl('-n', 'kfive', 'get', kind, '-o', 'json')).items.map((r) => [r.metadata.name, r.metadata.uid]).sort(),
  ]));
}
function protectedVolumes() {
  const names = ['mongodb_data', 'redis_data', 'chromadb_data', 'backend_uploads', 'backend_logs', 'ollama_bridge_socket', 'repository_importer_socket'];
  return Object.fromEntries(names.map((name) => [name,
    command('docker', ['volume', 'inspect', `kfive-ai_${name}`, '--format', '{{.Name}}|{{.CreatedAt}}|{{.Mountpoint}}']),
  ]));
}
async function request(route, { method = 'GET', token, body, expected = 200 } = {}) {
  // Native HTTP preserves the virtual Host header on all supported Node versions.
  // Request is used only for standard FormData serialization, never for transport.
  const prepared = new Request(`http://127.0.0.1:8088/api/v1${route}`, {
    method, body, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}),
    },
  });
  const bytes = body === undefined ? undefined : Buffer.from(await prepared.arrayBuffer());
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 8088, path: `/api/v1${route}`, method,
      signal: AbortSignal.timeout(90_000), headers: { ...Object.fromEntries(prepared.headers), Host: 'kfive.local',
        ...(bytes ? { 'content-length': bytes.length } : {}) } }, (response) => {
      const chunks = []; let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > 8 * 1024 * 1024) response.destroy(new Error('API response exceeds bound.')); else chunks.push(chunk); });
      response.once('error', reject);
      response.once('end', () => {
        try { assert.equal(response.statusCode, expected, `${method} ${route} returned ${response.statusCode}`);
          resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8'))); } catch (error) { reject(error); }
      });
    });
    req.once('error', reject); req.end(bytes);
  });
}
async function register(label) {
  const email = `repository-kind-${label}-${nonce}@example.invalid`;
  const result = await request('/auth/register', { method: 'POST', expected: 201,
    body: JSON.stringify({ email, username: `${label}_${nonce}`, password: `Kf!${crypto.randomBytes(24).toString('base64url')}`,
      firstName: 'Importer', lastName: 'Verification' }) });
  const identity = { email, userId: result.data.user._id, token: result.data.accessToken };
  assert.match(identity.userId, /^[a-f0-9]{24}$/); identities.push(identity); return identity;
}
function form(archive) {
  const body = new FormData(); body.append('name', 'Kubernetes importer acceptance');
  body.append('archive', new Blob([archive], { type: 'application/zip' }), 'kind-acceptance.zip'); return body;
}
function cleanup() {
  if (!identities.length) return;
  const targets = identities.map(({ userId, email }) => {
    assert.match(userId, /^[a-f0-9]{24}$/);
    assert.match(email, new RegExp(`^repository-kind-[a-z]+-${nonce}@example\\.invalid$`));
    return { userId, email };
  });
  const script = `const mongoose=require('mongoose');(async()=>{
    await mongoose.connect(process.env.MONGODB_URL);
    const db=mongoose.connection.db;const targets=${JSON.stringify(targets)};
    const checked=[];for(const t of targets){const id=new mongoose.Types.ObjectId(t.userId);
      if(!await db.collection('users').findOne({_id:id,email:t.email}))throw new Error('identity guard');checked.push({...t,id});}
    for(const t of checked){await db.collection('repositoryanalyses').deleteMany({ownerId:t.id});
      await db.collection('users').deleteOne({_id:t.id,email:t.email});}
    const ids=checked.map(t=>t.id);
    if(await db.collection('users').countDocuments({_id:{$in:ids}})||await db.collection('repositoryanalyses').countDocuments({ownerId:{$in:ids}}))throw new Error('cleanup incomplete');
    await mongoose.disconnect();console.log('KFIVE_CLEANUP_OK');
  })().catch(()=>{console.error('Guarded cleanup failed');process.exit(1)});`;
  assert.equal(runNode('backend', script), 'KFIVE_CLEANUP_OK');
}
function boundary() {
  const importer = pod('repository-importer'); const backend = pod('backend');
  assert.notEqual(importer.metadata.uid, backend.metadata.uid);
  assert.equal(importer.spec.nodeName, backend.spec.nodeName);
  assert.equal(importer.spec.nodeName, 'kfive-control-plane');
  assert.equal(importer.spec.automountServiceAccountToken, false);
  const container = importer.spec.containers[0];
  assert.equal(importer.spec.securityContext.runAsUser, 10001);
  assert.equal(importer.spec.securityContext.runAsGroup, 10002);
  assert.equal(container.envFrom, undefined);
  assert.deepEqual(container.resources.limits, { cpu: '1', memory: '512Mi' });
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  assert.deepEqual(container.volumeMounts.map((m) => m.mountPath).sort(), ['/run/kfive-repository-importer', '/tmp']);
  const observation = JSON.parse(runNode('repository-importer', `const fs=require('fs');const s=fs.lstatSync(${JSON.stringify(socketPath)});
    console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),socket:s.isSocket(),socketUid:s.uid,socketGid:s.gid,mode:s.mode&511,
      memory:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),swap:fs.readFileSync('/sys/fs/cgroup/memory.swap.max','utf8').trim(),
      cpu:fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim(),token:fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token'),
      zeroCore:/Max core file size\\s+0\\s+0\\s+bytes/.test(fs.readFileSync('/proc/1/limits','utf8'))}));`));
  assert.deepEqual(observation, { uid: 10001, gid: 10002, socket: true, socketUid: 10001, socketGid: 10002,
    mode: 0o660, memory: '536870912', swap: '0', cpu: '100000 100000', token: false, zeroCore: true });
  assert.equal(runNode('backend', `const fs=require('fs');let code;try{fs.writeFileSync('/run/kfive-repository-importer/forbidden','x',{flag:'wx'});}catch(e){code=e.code;}
    if(code!=='EROFS')process.exit(1);console.log('KFIVE_SOCKET_READONLY');`), 'KFIVE_SOCKET_READONLY');
  const containerId = importer.status.containerStatuses[0].containerID.replace(/^containerd:\/\//, '');
  assert.match(containerId, /^[a-f0-9]{64}$/);
  const runtime = JSON.parse(command('docker', ['exec', 'kfive-control-plane', 'crictl', 'inspect', containerId]));
  const pid = runtime.info.pid; assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const cgroup = command('docker', ['exec', 'kfive-control-plane', 'cat', `/proc/${pid}/cgroup`]);
  const match = /^0::(\/[A-Za-z0-9_./-]+)$/.exec(cgroup); assert.ok(match); assert.ok(!match[1].includes('..'));
  const podCgroup = `/sys/fs/cgroup${path.posix.dirname(match[1])}`;
  const podPidsMax = command('docker', ['exec', 'kfive-control-plane', 'cat', `${podCgroup}/pids.max`]);
  assert.equal(podPidsMax, '256');
  return { importerUid: importer.metadata.uid, node: importer.spec.nodeName, podPidsMax: Number(podPidsMax), ...observation };
}
function probe(name, host, port) {
  return runNode(name, `const net=require('net');console.log('KFIVE_PROBE_STARTED');
    const s=net.connect({host:process.argv[1],port:Number(process.argv[2])});
    const t=setTimeout(()=>{console.log('DENIED');s.destroy();},1500);
    s.on('connect',()=>{clearTimeout(t);console.log('ALLOWED');s.destroy();});
    s.on('error',()=>{clearTimeout(t);console.log('DENIED');});`, host, String(port));
}
function networkDenial() {
  const targets = [['mongodb', 27017], ['redis', 6379], ['chromadb', 8000]];
  for (const [name, port] of targets) {
    const ip = kubectl('-n', 'kfive', 'get', `service/${name}`, '-o', 'jsonpath={.spec.clusterIP}');
    assert.equal(probe('backend', ip, port), 'KFIVE_PROBE_STARTED\nALLOWED', `${name} positive control`);
    for (let pass = 0; pass < 3; pass += 1) assert.equal(probe('repository-importer', ip, port), 'KFIVE_PROBE_STARTED\nDENIED');
  }
  const dns = kubectl('-n', 'kube-system', 'get', 'service/kube-dns', '-o', 'jsonpath={.spec.clusterIP}');
  assert.equal(probe('backend', dns, 53), 'KFIVE_PROBE_STARTED\nALLOWED');
  assert.equal(probe('repository-importer', dns, 53), 'KFIVE_PROBE_STARTED\nDENIED');
  return { datastoreDenials: 9, dnsTcpDenied: true, positiveControls: 4 };
}
function sampleWorkers() {
  const script = `const fs=require('fs');let peak=0,samples=0;const timer=setInterval(()=>{
    let workers=0;for(const p of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){if(Number(p)===process.pid)continue;
      try{const args=fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0');if(args.some(a=>a.endsWith('/repositoryArchiveWorkerMain.js')))workers++;}catch{}}
    peak=Math.max(peak,workers);samples++;},5);setTimeout(()=>{clearInterval(timer);console.log(JSON.stringify({peak,samples}));},8000);`;
  const child = spawn('kubectl', [...context, '-n', 'kfive', 'exec', 'deployment/repository-importer', '--', 'node', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.resume();
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => { try { assert.equal(code, 0); resolve(JSON.parse(out)); } catch { reject(new Error('Importer child sampling failed.')); } });
  });
  done.catch(() => undefined); return { child, done };
}
function restoreImporter() {
  kubectl('-n', 'kfive', 'scale', 'deployment/repository-importer', '--replicas=1');
  kubectl('-n', 'kfive', 'rollout', 'status', 'deployment/repository-importer', '--timeout=240s');
  importerScaledDown = false;
}
async function waitForImporterExit() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const pods = JSON.parse(kubectl('-n', 'kfive', 'get', 'pods', '-l', 'app.kubernetes.io/name=repository-importer', '-o', 'json')).items;
    if (pods.every((p) => (p.status.containerStatuses || []).length > 0
      && p.status.containerStatuses.every((c) => c.state.terminated))) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Importer containers did not terminate.');
}

async function main() {
  assert.equal(kubectl('get', 'node', 'kfive-control-plane', '-o', 'jsonpath={.metadata.labels.kubernetes\\.io/hostname}'), 'kfive-control-plane');
  const objectsBefore = protectedObjects(); const volumesBefore = protectedVolumes();
  const initialBoundary = boundary();
  console.log('Runtime boundary verified; checking network denial.');
  const network = networkDenial();
  try {
    for (const label of ['first', 'second', 'entries', 'ratio', 'manifests', 'offline', 'recovery']) await register(label);
    const [first, second, entries, ratio, manifests, offline, recovery] = identities;
    const maximum = createNearMaximumFixture(); sampler = sampleWorkers();
    // Allow the in-pod sampler to begin before sending the archives.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const results = await Promise.all([first, second].map((user) => request('/repositories/analyses', {
      method: 'POST', token: user.token, body: form(maximum.archive), expected: 201,
    })));
    const workerSamples = await sampler.done; sampler = undefined;
    assert.ok(workerSamples.peak >= 1 && workerSamples.peak <= 2); assert.ok(workerSamples.samples > 0);
    for (const result of results) { assert.equal(result.data.analysis.summary.fileCount, 2000); assert.equal(result.data.analysis.summary.packageManifestCount, 20); }
    const id = results[0].data.analysis._id || results[0].data.analysis.id; assert.match(id, /^[a-f0-9]{24}$/);
    await request(`/repositories/analyses/${id}`, { token: second.token, expected: 404 });
    const hostile = createHostileFixtures();
    for (const [user, fixture, code] of [[entries, hostile.entryLimit, 'REPOSITORY_ENTRY_LIMIT_EXCEEDED'],
      [ratio, hostile.ratioBomb, 'REPOSITORY_UNCOMPRESSED_LIMIT_EXCEEDED'], [manifests, hostile.manifestLimit, 'REPOSITORY_MANIFEST_LIMIT_EXCEEDED']]) {
      const result = await request('/repositories/analyses', { method: 'POST', token: user.token, body: form(fixture.archive), expected: 413 });
      assert.equal(result.error.code, code);
      assert.equal((await request('/repositories/analyses', { token: user.token })).data.pagination.total, 0);
    }
    console.log('Uploads, owner isolation, and hostile rejection passed; checking outage and recovery.');
    importerScaledDown = true;
    kubectl('-n', 'kfive', 'scale', 'deployment/repository-importer', '--replicas=0');
    await waitForImporterExit();
    assert.equal((await request('/repositories/status', { token: offline.token })).data.canAnalyze, false);
    const small = buildZip([{ name: 'safe.txt', content: 'safe' }]).archive;
    const unavailable = await request('/repositories/analyses', { method: 'POST', token: offline.token, body: form(small), expected: 503 });
    assert.equal(unavailable.error.code, 'REPOSITORY_ANALYZER_UNAVAILABLE');
    assert.equal((await request('/repositories/analyses', { token: offline.token })).data.pagination.total, 0);
    await request(`/repositories/analyses/${id}`, { token: first.token });
    restoreImporter();
    await request('/repositories/analyses', { method: 'POST', token: recovery.token, body: form(small), expected: 201 });
    kubectl('-n', 'kfive', 'rollout', 'restart', 'deployment/backend');
    kubectl('-n', 'kfive', 'rollout', 'status', 'deployment/backend', '--timeout=240s');
    const stored = await request(`/repositories/analyses/${id}`, { token: first.token });
    assert.equal(stored.data.analysis.source.sha256, results[0].data.analysis.source.sha256);
    boundary();
    cleanup(); identities.length = 0;
    assert.deepEqual(protectedObjects(), objectsBefore); assert.deepEqual(protectedVolumes(), volumesBefore);
    console.log(JSON.stringify({ boundary: initialBoundary, network, concurrentImports: 2, workerSamples,
      hostileRejections: 3, ownerIsolation: true, unavailableReadAndRecovery: true, backendRestartPersistence: true,
      cleanup: 'seven exact identities and their reports', protectedObjectsUnchanged: true, composeVolumesUnchanged: true }, null, 2));
  } finally {
    if (sampler) { sampler.child.kill(); await sampler.done.catch(() => undefined); }
    if (importerScaledDown) restoreImporter();
    if (identities.length) cleanup();
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : 'Kubernetes importer acceptance failed.'); process.exitCode = 1; });
