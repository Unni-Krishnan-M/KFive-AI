#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { renderProductionTlsConfig } = require('./production-tls-config.cjs');
const { createSensitiveRedactor } = require('./production-verifier-lib.cjs');

if (!process.argv.includes('--allow-live-test')) {
  console.error('Refusing the disposable production TLS drill without --allow-live-test.');
  process.exit(2);
}

const MIB = 1024 * 1024;
const nonce = crypto.randomBytes(6).toString('hex');
const project = `kfive-tls-test-${nonce}`;
const backendImage = `kfive-ai-backend:tls-${nonce}`;
const frontendImage = `kfive-ai-frontend:tls-${nonce}`;
const fixtureImage = `kfive-ai-provider-fixture:tls-${nonce}`;
const providerContainer = `${project}-external-provider`;
const proxyContainer = `${project}-tls-edge`;
const domain = `tls-${nonce}.acceptance.invalid`;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kfive-tls-live-'));
fs.chmodSync(tempRoot, 0o700);
const envFile = path.join(tempRoot, 'tls.env');
const overrideFile = path.join(tempRoot, 'tls-override.yml');
const nginxConfig = path.join(tempRoot, 'nginx.conf');
const caKey = path.join(tempRoot, 'ca.key');
const caCert = path.join(tempRoot, 'ca.crt');
const leafKey = path.join(tempRoot, 'leaf.key');
const leafCsr = path.join(tempRoot, 'leaf.csr');
const leafCert = path.join(tempRoot, 'leaf.crt');
const leafExtensions = path.join(tempRoot, 'leaf.ext');
const composeFiles = ['docker-compose.production.yml', overrideFile];
const volumeNames = ['mongodb_data', 'redis_data', 'chromadb_data', 'backend_uploads', 'backend_logs']
  .map((suffix) => `${project}_${suffix}`);
const cleanupErrors = [];
const redactDiagnostic = createSensitiveRedactor([
  tempRoot, envFile, overrideFile, nginxConfig, caKey, caCert, leafKey, leafCsr, leafCert, leafExtensions,
]);

function docker(args, options = {}) {
  const output = execFileSync('docker', args, {
    encoding: 'utf8', stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 180_000, maxBuffer: 64 * MIB,
  });
  return typeof output === 'string' ? output.trim() : '';
}

function compose(args, options = {}) {
  return docker(['compose', '--env-file', envFile, '-p', project,
    ...composeFiles.flatMap((file) => ['-f', file]), ...args], options);
}

function errorText(error) {
  return redactDiagnostic(`${String(error.stderr || '')}\n${String(error.stdout || '')}\n${String(error.message || error)}`);
}

function inspect(name) { return JSON.parse(docker(['inspect', name]))[0]; }

function inspectService(service) {
  const id = compose(['ps', '-q', service]);
  assert.match(id, /^[a-f0-9]{12,64}$/, `${service} is not running`);
  return inspect(id);
}

function volumeIdentity(names) {
  const result = {};
  for (const name of names) {
    try {
      const item = JSON.parse(docker(['volume', 'inspect', name]))[0];
      result[name] = `${item.Name}:${item.CreatedAt}:${item.Mountpoint}`;
    } catch (error) {
      if (!/no such volume/i.test(errorText(error))) throw error;
    }
  }
  return result;
}

function assertImageAbsent(name) {
  try { docker(['image', 'inspect', name]); throw new Error(`refusing pre-existing image ${name}`); }
  catch (error) { if (!/no such image/i.test(errorText(error))) throw error; }
}

function assertContainerAbsent(name) {
  try { docker(['inspect', name]); throw new Error(`refusing pre-existing container ${name}`); }
  catch (error) { if (!/no such object|no such container/i.test(errorText(error))) throw error; }
}

function assertProjectAbsent() {
  assert.equal(docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]), '');
  assert.equal(docker(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '');
  assert.deepEqual(volumeIdentity(volumeNames), {});
  assertContainerAbsent(providerContainer);
  assertContainerAbsent(proxyContainer);
  for (const image of [backendImage, frontendImage, fixtureImage]) assertImageAbsent(image);
}

function removeOwnedContainer(name) {
  try {
    const item = inspect(name);
    assert.equal(item.Config?.Labels?.['kfive.verifier'], project, `refusing foreign container ${name}`);
    docker(['rm', '-f', name]);
  } catch (error) {
    if (!/no such object|no such container/i.test(errorText(error))) throw error;
  }
}

function removeOwnedImage(name) {
  try {
    const item = JSON.parse(docker(['image', 'inspect', name]))[0];
    assert.ok((item.RepoTags || []).includes(name));
    assert.equal(item.Config?.Labels?.['kfive.verifier'], project, `refusing foreign image ${name}`);
    docker(['image', 'rm', name]);
  } catch (error) {
    if (!/no such image/i.test(errorText(error))) throw error;
  }
}

function removeOwnedVolumes() {
  for (const name of volumeNames) {
    try {
      const item = JSON.parse(docker(['volume', 'inspect', name]))[0];
      assert.equal(item.Labels?.['com.docker.compose.project'], project, `refusing foreign volume ${name}`);
      docker(['volume', 'rm', name]);
    } catch (error) {
      if (!/no such volume/i.test(errorText(error))) throw error;
    }
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function plainRequest(port, route, { method = 'GET', body, headers = {}, timeout = 10_000 } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, timeout,
      headers: { ...headers, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } },
    (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('timeout', () => req.destroy(new Error(`${method} ${route} timed out`)));
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function tlsRequest(port, route, ca, { method = 'GET', body, token, origin, headers = {}, servername = domain, hostHeader = `${domain}:${port}`, timeout = 15_000 } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: servername, servername, port, path: route, method, timeout,
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [{ address: '127.0.0.1', family: 4 }])
        : callback(null, '127.0.0.1', 4),
      ca, rejectUnauthorized: true,
      headers: {
        host: hostHeader, ...headers,
        ...(origin ? { origin } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (response) => {
      const chunks = [];
      const peer = response.socket.getPeerCertificate();
      const protocol = response.socket.getProtocol();
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'), protocol, peer }));
    });
    req.once('timeout', () => req.destroy(new Error(`${method} ${route} timed out`)));
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function json(response) { return JSON.parse(response.body); }

async function retry(action, attempts = 60, delayMs = 1_000) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw lastError;
}

function parseSse(body) {
  return body.replace(/\r\n/g, '\n').split('\n\n').filter(Boolean).map((block) => {
    const record = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) record.id = line.slice(4);
      else if (line.startsWith('event: ')) record.event = line.slice(7);
      else if (line.startsWith('data: ')) {
        assert.equal(record.rawData, undefined, 'duplicate SSE data field');
        record.rawData = line.slice(6);
      } else if (line && !line.startsWith(':')) throw new Error(`Malformed SSE line: ${line}`);
    }
    assert.notEqual(record.rawData, undefined, 'SSE block has no data');
    if (record.rawData === '[DONE]') return { done: true };
    assert.ok(record.id && record.event);
    return { id: record.id, event: record.event, data: JSON.parse(record.rawData) };
  });
}

function assertSuccessfulStream(response) {
  assert.equal(response.status, 200, response.body);
  const records = parseSse(response.body);
  assert.deepEqual(records.at(-1), { done: true });
  assert.equal(records.filter((record) => record.done).length, 1);
  const named = records.filter((record) => !record.done);
  assert.equal(new Set(named.map((record) => record.id)).size, 1);
  assert.ok(named.every((record) => record.data.requestId === record.id));
  assert.equal(named.filter((record) => record.event === 'generation' && record.data.status === 'running').length, 1);
  assert.equal(named.filter((record) => record.event === 'start' && record.data.provider === 'openai-compatible'
    && record.data.model === 'remote-chat').length, 1);
  assert.equal(named.filter((record) => record.event === 'completed' && record.data.generation.status === 'succeeded').length, 1);
  assert.equal(named.filter((record) => record.event === 'error').length, 0);
  assert.equal(named.filter((record) => record.event === 'delta').map((record) => record.data.content).join(''), 'REMOTE_PROVIDER_VERIFIED');
}

function generateCertificates() {
  fs.writeFileSync(leafExtensions, `subjectAltName=DNS:${domain}\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
    '-subj', '/CN=KFive acceptance CA', '-keyout', caKey, '-out', caCert], { stdio: 'ignore', timeout: 30_000 });
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${domain}`,
    '-keyout', leafKey, '-out', leafCsr], { stdio: 'ignore', timeout: 30_000 });
  execFileSync('openssl', ['x509', '-req', '-in', leafCsr, '-CA', caCert, '-CAkey', caKey,
    '-CAcreateserial', '-days', '30', '-extfile', leafExtensions, '-out', leafCert], { stdio: 'ignore', timeout: 30_000 });
  fs.chmodSync(caKey, 0o600);
  fs.chmodSync(leafKey, 0o600);
}

function assertNoPublishedPorts(item, label) {
  assert.ok(Object.values(item.NetworkSettings.Ports || {}).every((bindings) => bindings === null), `${label} published a host port`);
}

async function main() {
  const [innerPort, httpPort, tlsPort] = await Promise.all([freePort(), freePort(), freePort()]);
  assert.equal(new Set([innerPort, httpPort, tlsPort]).size, 3, 'allocated ports must be distinct');
  const publicOrigin = `https://${domain}:${tlsPort}`;
  const preExistingVolumes = volumeIdentity(docker(['volume', 'ls', '-q']).split(/\r?\n/).filter(Boolean));
  const secrets = {
    root: `r${crypto.randomBytes(18).toString('base64url')}`,
    app: `a${crypto.randomBytes(18).toString('base64url')}`,
    redis: `d${crypto.randomBytes(18).toString('base64url')}`,
    jwt: crypto.randomBytes(32).toString('base64url'),
    refresh: crypto.randomBytes(32).toString('base64url'),
    provider: crypto.randomBytes(24).toString('base64url'),
  };
  const email = `tls-${nonce}@example.invalid`;
  const password = `Kf!${crypto.randomBytes(18).toString('base64url')}`;
  redactDiagnostic.add([...Object.values(secrets), password]);
  fs.writeFileSync(envFile, [
    `KFIVE_PRODUCTION_PROJECT=${project}`, `KFIVE_VOLUME_PREFIX=${project}`,
    'KFIVE_EDGE_BIND_ADDRESS=127.0.0.1', `KFIVE_EDGE_HTTP_PORT=${innerPort}`,
    'KFIVE_MODE=remote', `PUBLIC_BASE_URL=${publicOrigin}`, `CORS_ORIGIN=${publicOrigin}`,
    'TRUST_PROXY_HOPS=2', 'AI_PROVIDER=openai-compatible', 'AI_DEFAULT_MODEL=remote-chat',
    'AI_TIMEOUT_MS=3000', 'OPENAI_BASE_URL=http://tls-provider.example.test:4010/v1',
    `OPENAI_API_KEY=${secrets.provider}`, 'OPENAI_COMPATIBLE_SUPPORTS_EMBEDDINGS=false',
    'OPENAI_COMPATIBLE_SUPPORTS_STRUCTURED_OUTPUT=false', 'MONGO_ROOT_USERNAME=kfive_root',
    `MONGO_ROOT_PASSWORD=${secrets.root}`, 'MONGO_DATABASE=kfive_ai', 'MONGO_APP_USERNAME=kfive',
    `MONGO_APP_PASSWORD=${secrets.app}`, `REDIS_PASSWORD=${secrets.redis}`,
    `JWT_SECRET=${secrets.jwt}`, `JWT_REFRESH_SECRET=${secrets.refresh}`,
    `KFIVE_BACKEND_IMAGE=${backendImage}`, `KFIVE_FRONTEND_IMAGE=${frontendImage}`,
    'KFIVE_MONGODB_IMAGE=mongo:7.0', 'KFIVE_REDIS_IMAGE=redis:7.2-alpine',
    'KFIVE_CHROMADB_IMAGE=chromadb/chroma:0.4.24',
  ].join('\n') + '\n', { mode: 0o600 });
  fs.writeFileSync(overrideFile, `services:
  mongodb:
    healthcheck: {disable: true}
  redis:
    healthcheck: {disable: true}
  chromadb:
    healthcheck: {disable: true}
  backend:
    healthcheck: {disable: true}
    depends_on:
      mongodb: {condition: service_started}
      redis: {condition: service_started}
      chromadb: {condition: service_started}
  benchmark-worker:
    depends_on:
      mongodb: {condition: service_started}
      redis: {condition: service_started}
  frontend:
    healthcheck: {disable: true}
    depends_on:
      backend: {condition: service_started}
`, { mode: 0o600 });

  let cleanupAuthorized = false;
  let proxyStarted = false;
  let userId;
  try {
    assertProjectAbsent();
    cleanupAuthorized = true;
    for (const image of ['mongo:7.0', 'redis:7.2-alpine', 'chromadb/chroma:0.4.24']) docker(['image', 'inspect', image]);
    generateCertificates();
    renderProductionTlsConfig({
      publicBaseUrl: publicOrigin, edgeHttpPort: 8080, upstreamHost: 'frontend', upstreamPort: 8080,
      httpListenPort: 8080, tlsListenPort: 8443,
      certificateFile: leafCert, privateKeyFile: leafKey,
      allowRuntimePathOverrides: true,
      certificateConfigPath: '/run/kfive-tls/leaf.crt', privateKeyConfigPath: '/run/kfive-tls/leaf.key',
      outputFile: nginxConfig,
    });
    for (const [image, dockerfile] of [[backendImage, 'backend/Dockerfile'], [frontendImage, 'frontend/Dockerfile'], [fixtureImage, 'services/remote-provider-fixture/Dockerfile']]) {
      docker(['build', '--label', `kfive.verifier=${project}`, '-t', image, '-f', dockerfile, '.'], { stdio: 'inherit', timeout: 900_000 });
    }
    compose(['up', '-d', 'mongodb', 'redis', 'chromadb'], { stdio: 'inherit' });
    compose(['create', 'backend', 'benchmark-worker', 'frontend'], { stdio: 'inherit' });
    docker(['run', '-d', '--name', providerContainer, '--label', `kfive.verifier=${project}`,
      '--network', `${project}_provider_egress`, '--network-alias', 'tls-provider.example.test',
      '--env', `FIXTURE_BEARER_TOKEN=${secrets.provider}`, '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=8m', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--pids-limit', '32', '--memory', '64m', '--cpus', '0.25',
      fixtureImage]);
    compose(['up', '-d'], { stdio: 'inherit' });
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
    docker(['run', '-d', '--name', proxyContainer, '--label', `kfive.verifier=${project}`,
      '--user', `${uid}:${gid}`, '--network', `${project}_edge`,
      '--publish', `127.0.0.1:${httpPort}:8080`, '--publish', `127.0.0.1:${tlsPort}:8443`,
      '--read-only', '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=16m,uid=${uid},gid=${gid},mode=0700`,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '32',
      '--memory', '64m', '--cpus', '0.25',
      '--no-healthcheck',
      '--mount', `type=bind,src=${nginxConfig},dst=/run/kfive-tls/nginx.conf,readonly`,
      '--mount', `type=bind,src=${leafCert},dst=/run/kfive-tls/leaf.crt,readonly`,
      '--mount', `type=bind,src=${leafKey},dst=/run/kfive-tls/leaf.key,readonly`,
      '--entrypoint', 'nginx', frontendImage, '-c', '/run/kfive-tls/nginx.conf', '-g', 'daemon off;']);
    proxyStarted = true;

    const ca = fs.readFileSync(caCert);
    const health = await retry(async () => {
      const result = await tlsRequest(tlsPort, '/api/v1/health', ca);
      assert.equal(result.status, 200, result.body);
      assert.equal(json(result).status, 'healthy');
      const proxyState = inspect(proxyContainer);
      assert.deepEqual(proxyState.Config.Healthcheck?.Test, ['NONE']);
      assert.equal(proxyState.State.Health, undefined);
      return result;
    });
    assert.ok(['TLSv1.2', 'TLSv1.3'].includes(health.protocol), `unexpected protocol ${health.protocol}`);
    assert.match(health.peer.subjectaltname || '', new RegExp(`DNS:${domain.replace(/\./g, '\\.')}`));
    assert.equal(health.peer.issuer.CN, 'KFive acceptance CA');
    assert.match(health.peer.fingerprint256, /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/);
    const leafFingerprint = health.peer.fingerprint256;
    assert.equal(health.headers['strict-transport-security'], 'max-age=31536000');
    assert.equal(health.headers['x-content-type-options'], 'nosniff');

    await assert.rejects(() => tlsRequest(tlsPort, '/api/v1/health', undefined), /self-signed|unable to verify|certificate/i);
    await assert.rejects(() => tlsRequest(tlsPort, '/api/v1/health', ca, {
      servername: 'wrong.acceptance.invalid', hostHeader: 'wrong.acceptance.invalid',
    }), /certificate|hostname|handshake|socket disconnected|unrecognized name/i);
    const redirect = await plainRequest(httpPort, '/path?q=1', { headers: { host: `${domain}:${httpPort}` } });
    assert.equal(redirect.status, 308, redirect.body);
    assert.equal(redirect.headers.location, `${publicOrigin}/path?q=1`);
    assert.equal(redirect.headers['strict-transport-security'], undefined);
    const hostileRedirect = await plainRequest(httpPort, '/', { headers: { host: 'attacker.invalid' } });
    assert.equal(hostileRedirect.status, 421, hostileRedirect.body);
    assert.equal(hostileRedirect.headers.location, undefined);
    const hostileTlsHost = await tlsRequest(tlsPort, '/', ca, { hostHeader: 'attacker.invalid' });
    assert.equal(hostileTlsHost.status, 421, hostileTlsHost.body);

    const corsAllowed = await tlsRequest(tlsPort, '/api/v1/health', ca, {
      method: 'OPTIONS', origin: publicOrigin,
      headers: { 'access-control-request-method': 'GET' },
    });
    assert.equal(corsAllowed.status, 204, corsAllowed.body);
    assert.equal(corsAllowed.headers['access-control-allow-origin'], publicOrigin);
    const corsDenied = await tlsRequest(tlsPort, '/api/v1/health', ca, {
      method: 'OPTIONS', origin: 'https://attacker.invalid',
      headers: { 'access-control-request-method': 'GET' },
    });
    assert.equal(corsDenied.status, 403, corsDenied.body);
    assert.equal(corsDenied.headers['access-control-allow-origin'], undefined);

    const registration = await tlsRequest(tlsPort, '/api/v1/auth/register', ca, {
      method: 'POST', origin: publicOrigin,
      body: { email, username: `tls_${nonce}`, password, firstName: 'TLS', lastName: 'Verifier' },
    });
    assert.equal(registration.status, 201, registration.body);
    const identity = json(registration).data;
    userId = identity.user._id;
    let accessToken = identity.accessToken;
    const models = await tlsRequest(tlsPort, '/api/v1/models', ca, { token: accessToken, origin: publicOrigin });
    assert.equal(models.status, 200, models.body);
    assert.equal(json(models).data.provider.id, 'openai-compatible');
    assert.ok(json(models).data.models.some((model) => model.id === 'remote-chat'));
    const conversation = await tlsRequest(tlsPort, '/api/v1/chat/conversations', ca, {
      method: 'POST', token: accessToken, origin: publicOrigin, body: { title: 'TLS acceptance' },
    });
    assert.equal(conversation.status, 201, conversation.body);
    const conversationId = json(conversation).data._id;
    assertSuccessfulStream(await tlsRequest(tlsPort, `/api/v1/chat/conversations/${conversationId}/stream`, ca, {
      method: 'POST', token: accessToken, origin: publicOrigin, timeout: 30_000,
      body: { message: 'Return the TLS verification marker.', model: 'remote-chat' },
    }));

    const volumeBefore = volumeIdentity(volumeNames);
    const backendId = inspectService('backend').Id;
    const proxyId = inspect(proxyContainer).Id;
    compose(['restart', 'backend']);
    docker(['restart', proxyContainer]);
    const healthAfterRestart = await retry(async () => {
      const result = await tlsRequest(tlsPort, '/api/v1/readiness', ca);
      assert.equal(result.status, 200, result.body);
      assert.equal(json(result).dependencies.mongodb, 'available');
      assert.equal(json(result).dependencies.redis, 'available');
      return result;
    });
    assert.equal(healthAfterRestart.peer.fingerprint256, leafFingerprint);
    assert.equal(inspectService('backend').Id, backendId);
    assert.equal(inspect(proxyContainer).Id, proxyId);
    const login = await tlsRequest(tlsPort, '/api/v1/auth/login', ca, {
      method: 'POST', origin: publicOrigin, body: { email, password },
    });
    assert.equal(login.status, 200, login.body);
    assert.equal(json(login).data.user._id, userId);
    accessToken = json(login).data.accessToken;
    const persisted = await tlsRequest(tlsPort, `/api/v1/chat/conversations/${conversationId}`, ca, { token: accessToken, origin: publicOrigin });
    assert.equal(persisted.status, 200, persisted.body);
    assert.match(persisted.body, /REMOTE_PROVIDER_VERIFIED/);
    assert.deepEqual(volumeIdentity(volumeNames), volumeBefore);

    const limiterStatuses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await tlsRequest(tlsPort, '/api/v1/auth/login', ca, {
        method: 'POST', origin: publicOrigin,
        headers: {
          'x-forwarded-for': `198.51.100.${attempt + 1}`,
          forwarded: `for=203.0.113.${attempt + 1};proto=http`,
          'x-forwarded-host': `attacker-${attempt}.invalid`,
          'x-forwarded-proto': 'http',
        },
        body: { email: `missing-${nonce}@example.invalid`, password: 'Wrong!password-123' },
      });
      limiterStatuses.push(result.status);
      if (attempt < 5) assert.equal(result.status, 401, result.body);
      else {
        assert.equal(result.status, 429, result.body);
        assert.equal(json(result).error.type, 'AUTH_RATE_LIMIT_EXCEEDED');
      }
    }
    assert.deepEqual(limiterStatuses, [401, 401, 401, 401, 401, 429]);

    const proxy = inspect(proxyContainer);
    assert.equal(proxy.Config.Labels['kfive.verifier'], project);
    assert.equal(proxy.Config.Labels['com.docker.compose.project'], undefined);
    assert.deepEqual(Object.keys(proxy.NetworkSettings.Networks), [`${project}_edge`]);
    assert.equal(proxy.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(proxy.HostConfig.CapDrop, ['ALL']);
    assert.ok(proxy.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    assert.equal(proxy.HostConfig.PidsLimit, 32);
    assert.equal(proxy.HostConfig.Memory, 64 * MIB);
    assert.equal(proxy.HostConfig.NanoCpus, 250_000_000);
    assert.deepEqual(proxy.Mounts.map((mount) => ({ destination: mount.Destination, rw: mount.RW })).sort((a, b) => a.destination.localeCompare(b.destination)), [
      { destination: '/run/kfive-tls/leaf.crt', rw: false },
      { destination: '/run/kfive-tls/leaf.key', rw: false },
      { destination: '/run/kfive-tls/nginx.conf', rw: false },
    ]);
    const published = Object.entries(proxy.NetworkSettings.Ports).flatMap(([containerPort, bindings]) =>
      (bindings || []).map((binding) => ({ containerPort, hostIp: binding.HostIp, hostPort: binding.HostPort })));
    assert.deepEqual(published.sort((a, b) => a.containerPort.localeCompare(b.containerPort)), [
      { containerPort: '8080/tcp', hostIp: '127.0.0.1', hostPort: String(httpPort) },
      { containerPort: '8443/tcp', hostIp: '127.0.0.1', hostPort: String(tlsPort) },
    ]);
    assert.ok(!proxy.Config.Env.some((entry) => /JWT|PASSWORD|TOKEN|API_KEY/.test(entry)));
    const frontend = inspectService('frontend');
    assert.deepEqual(frontend.NetworkSettings.Ports['8080/tcp'].map(({ HostIp, HostPort }) => ({ HostIp, HostPort })), [
      { HostIp: '127.0.0.1', HostPort: String(innerPort) },
    ]);
    for (const service of ['backend', 'benchmark-worker', 'mongodb', 'redis', 'chromadb']) assertNoPublishedPorts(inspectService(service), service);
    assertNoPublishedPorts(inspect(providerContainer), 'provider fixture');

    const cleanup = `const userId=ObjectId('${userId}');const conversations=db.conversations.deleteMany({userId});const users=db.users.deleteOne({_id:userId});print(JSON.stringify({conversations:conversations.deletedCount,users:users.deletedCount,remainingConversations:db.conversations.countDocuments({userId}),remainingUsers:db.users.countDocuments({_id:userId})}))`;
    const cleanupResult = JSON.parse(docker(['run', '--rm', '--network', `${project}_data_internal`, '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--entrypoint', 'mongosh', 'mongo:7.0', '--quiet', '--host', 'mongodb', '--username', 'kfive_root',
      '--password', secrets.root, '--authenticationDatabase', 'admin', 'kfive_ai', '--eval', cleanup]).split('\n').at(-1));
    assert.deepEqual(cleanupResult, { conversations: 1, users: 1, remainingConversations: 0, remainingUsers: 0 });

    console.log(JSON.stringify({
      nonce, domain, publicOrigin, tlsProtocol: health.protocol, certificateFingerprint: leafFingerprint,
      strictCaAndHostnameValidation: true, fixedOriginRedirect: true, unknownHostRejected: true,
      hsts: health.headers['strict-transport-security'], exactCors: true,
      authenticatedRemoteProviderStream: true, forwardingSpoofRateLimitStatuses: limiterStatuses,
      backendAndTlsProxyRestartRecovery: true, mongoChatPersistence: true,
      volumeObjectsUnchangedAcrossRestart: true,
      topology: 'loopback HTTP/TLS edge; loopback inner frontend; private API/datastores/provider',
      verificationRecordsCleaned: true,
    }, null, 2));
  } finally {
    let proxyRemoved = !proxyStarted;
    if (cleanupAuthorized) {
      try { removeOwnedContainer(proxyContainer); assertContainerAbsent(proxyContainer); proxyRemoved = true; }
      catch (error) { cleanupErrors.push(errorText(error)); }
      try { removeOwnedContainer(providerContainer); } catch (error) { cleanupErrors.push(errorText(error)); }
      try { compose(['down', '--remove-orphans']); } catch (error) { cleanupErrors.push(errorText(error)); }
      try { removeOwnedVolumes(); } catch (error) { cleanupErrors.push(errorText(error)); }
      for (const image of [backendImage, frontendImage, fixtureImage]) {
        try { removeOwnedImage(image); } catch (error) { cleanupErrors.push(errorText(error)); }
      }
      try {
        assert.equal(docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]), '');
        assert.equal(docker(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '');
        assert.deepEqual(volumeIdentity(volumeNames), {});
        assertContainerAbsent(providerContainer);
        assertContainerAbsent(proxyContainer);
      } catch (error) { cleanupErrors.push(errorText(error)); }
    }
    try { assert.deepEqual(volumeIdentity(Object.keys(preExistingVolumes)), preExistingVolumes); }
    catch (error) { cleanupErrors.push(errorText(error)); }
    if (proxyRemoved) fs.rmSync(tempRoot, { recursive: true, force: true });
    else cleanupErrors.push(`TLS private directory retained because proxy removal was not proven: ${redactDiagnostic(tempRoot)}`);
    if (cleanupErrors.length) throw new Error(`TLS verifier cleanup failed:\n${cleanupErrors.join('\n')}`);
  }
}

main().catch((error) => {
  console.error(errorText(error));
  process.exitCode = 1;
});
