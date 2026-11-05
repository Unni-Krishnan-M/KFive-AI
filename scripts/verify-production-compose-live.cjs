#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (!process.argv.includes('--allow-live-test')) {
  console.error('Refusing to create the disposable production Compose acceptance stack without --allow-live-test.');
  process.exit(2);
}

const nonce = crypto.randomBytes(6).toString('hex');
const project = `kfive-production-test-${nonce}`;
const volumePrefix = project;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kfive-production-'));
const envFile = path.join(tempRoot, 'acceptance.env');
const composeFiles = ['docker-compose.production.yml', 'docker-compose.production.acceptance.yml'];
const volumeNames = ['mongodb_data', 'redis_data', 'chromadb_data', 'backend_uploads', 'backend_logs']
  .map((suffix) => `${volumePrefix}_${suffix}`);

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8', stdio: options.stdio || ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function compose(args, options = {}) {
  const fileArgs = composeFiles.flatMap((file) => ['-f', file]);
  return docker(['compose', '--env-file', envFile, '-p', project, ...fileArgs, ...args], options);
}

function request(port, route, { method = 'GET', body, token, timeout = 30_000 } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method, timeout,
      headers: {
        ...(payload ? {'content-type': 'application/json', 'content-length': payload.length} : {}),
        ...(token ? {authorization: `Bearer ${token}`} : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({status: response.statusCode, body: Buffer.concat(chunks).toString('utf8')}));
    });
    req.once('timeout', () => req.destroy(new Error(`${method} ${route} timed out`)));
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parsed(response) { return JSON.parse(response.body); }

async function retry(action, attempts = 30, delayMs = 1000) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw lastError;
}

function inspectService(service) {
  const id = compose(['ps', '-q', service]);
  assert.match(id, /^[a-f0-9]{12,64}$/, `${service} is not running`);
  return JSON.parse(docker(['inspect', id]))[0];
}

function removeFixtureVolumes() {
  for (const volume of volumeNames) {
    try {
      const inspected = JSON.parse(docker(['volume', 'inspect', volume]))[0];
      assert.equal(inspected.Labels?.['com.docker.compose.project'], project, `refusing foreign volume ${volume}`);
      docker(['volume', 'rm', volume]);
    } catch (error) {
      if (!String(error.stderr || error.message).includes('No such volume')) throw error;
    }
  }
}

async function main() {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : crypto.randomInt(10_240, 60_000);
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, '--port must be an unprivileged TCP port');
  const mongoPassword = `m${crypto.randomBytes(18).toString('base64url')}`;
  const mongoRootUsername = 'kfive_root';
  const redisPassword = `r${crypto.randomBytes(18).toString('base64url')}`;
  const jwt = crypto.randomBytes(32).toString('base64url');
  const refresh = crypto.randomBytes(32).toString('base64url');
  const providerToken = crypto.randomBytes(24).toString('base64url');
  const email = `remote-${nonce}@example.invalid`;
  const password = `Kf!${crypto.randomBytes(18).toString('base64url')}`;
  const username = `remote_${nonce}`;
  const environment = [
    `KFIVE_PRODUCTION_PROJECT=${project}`,
    `KFIVE_VOLUME_PREFIX=${volumePrefix}`,
    'KFIVE_EDGE_BIND_ADDRESS=127.0.0.1',
    `KFIVE_EDGE_HTTP_PORT=${port}`,
    `KFIVE_FIXTURE_IMAGE=kfive-ai-remote-provider-fixture:${project}`,
    `KFIVE_FIXTURE_BEARER_TOKEN=${providerToken}`,
    'KFIVE_MODE=remote',
    `PUBLIC_BASE_URL=http://127.0.0.1:${port}`,
    `CORS_ORIGIN=http://127.0.0.1:${port}`,
    'TRUST_PROXY_HOPS=1',
    'AI_PROVIDER=openai-compatible',
    'AI_DEFAULT_MODEL=remote-chat',
    'AI_EMBEDDING_MODEL=',
    'OPENAI_BASE_URL=http://remote-provider-fixture:4010/v1',
    `OPENAI_API_KEY=${providerToken}`,
    'OPENAI_COMPATIBLE_SUPPORTS_EMBEDDINGS=false',
    'OPENAI_COMPATIBLE_SUPPORTS_STRUCTURED_OUTPUT=false',
    `MONGO_ROOT_USERNAME=${mongoRootUsername}`,
    `MONGO_ROOT_PASSWORD=${mongoPassword}`,
    'MONGO_DATABASE=kfive_ai',
    'MONGO_APP_USERNAME=kfive',
    `MONGO_APP_PASSWORD=a${crypto.randomBytes(18).toString('base64url')}`,
    `REDIS_PASSWORD=${redisPassword}`,
    `JWT_SECRET=${jwt}`,
    `JWT_REFRESH_SECRET=${refresh}`,
    'KFIVE_BACKEND_IMAGE=kfive-ai-backend',
    'KFIVE_FRONTEND_IMAGE=kfive-ai-frontend',
    'KFIVE_MONGODB_IMAGE=mongo:7.0',
    'KFIVE_REDIS_IMAGE=redis:7.2-alpine',
    'KFIVE_CHROMADB_IMAGE=chromadb/chroma:0.4.24',
  ];
  fs.writeFileSync(envFile, `${environment.join('\n')}\n`, {mode: 0o600});

  for (const image of ['kfive-ai-backend', 'kfive-ai-frontend', 'mongo:7.0', 'redis:7.2-alpine', 'chromadb/chroma:0.4.24']) {
    docker(['image', 'inspect', image]);
  }

  let userId;
  let volumeIdentity;
  try {
    compose(['build', 'remote-provider-fixture'], {stdio: 'inherit'});
    compose(['up', '-d', '--wait'], {stdio: 'inherit'});

    const frontendInspect = inspectService('frontend');
    const published = frontendInspect.NetworkSettings.Ports['8080/tcp'];
    assert.deepEqual(published.map(({HostIp, HostPort}) => ({HostIp, HostPort})), [{HostIp: '127.0.0.1', HostPort: String(port)}]);
    for (const service of ['backend', 'benchmark-worker', 'mongodb', 'redis', 'chromadb', 'remote-provider-fixture']) {
      const ports = inspectService(service).NetworkSettings.Ports || {};
      assert.ok(Object.values(ports).every((bindings) => bindings === null), `${service} published a host port`);
    }
    assert.equal(JSON.parse(docker(['network', 'inspect', `${project}_app_internal`]))[0].Internal, true);
    assert.equal(JSON.parse(docker(['network', 'inspect', `${project}_data_internal`]))[0].Internal, true);
    const serviceIds = Object.fromEntries(
      ['frontend', 'backend', 'benchmark-worker', 'mongodb', 'redis', 'chromadb', 'remote-provider-fixture']
        .map((service) => [service, compose(['ps', '-q', service])]),
    );
    const networkMembers = (network) => Object.keys(JSON.parse(docker(['network', 'inspect', `${project}_${network}`]))[0].Containers || {}).sort();
    assert.deepEqual(networkMembers('edge'), [serviceIds.frontend].sort());
    assert.deepEqual(networkMembers('app_internal'), [serviceIds.frontend, serviceIds.backend].sort());
    assert.deepEqual(networkMembers('data_internal'), [serviceIds.backend, serviceIds['benchmark-worker'], serviceIds.mongodb, serviceIds.redis, serviceIds.chromadb].sort());
    assert.deepEqual(networkMembers('provider_egress'), [serviceIds.backend, serviceIds['benchmark-worker'], serviceIds['remote-provider-fixture']].sort());

    const frontend = await request(port, '/');
    assert.equal(frontend.status, 200);
    assert.match(frontend.body, /<title>KFive AI(?: - AI Workspace)?<\/title>/);
    const readiness = await request(port, '/api/v1/readiness');
    assert.equal(readiness.status, 200, readiness.body);
    assert.equal(parsed(readiness).dependencies.mongodb, 'available');
    assert.equal(parsed(readiness).dependencies.redis, 'available');

    const registration = await request(port, '/api/v1/auth/register', {
      method: 'POST', body: {email, username, password, firstName: 'Remote', lastName: 'Verifier'},
    });
    assert.equal(registration.status, 201, registration.body);
    const identity = parsed(registration).data;
    userId = identity.user._id;

    const models = await request(port, '/api/v1/models', {token: identity.accessToken});
    assert.equal(models.status, 200, models.body);
    assert.equal(parsed(models).data.provider.id, 'openai-compatible');
    assert.ok(parsed(models).data.models.some((model) => model.id === 'remote-chat'));

    const conversation = await request(port, '/api/v1/chat/conversations', {
      method: 'POST', token: identity.accessToken, body: {title: 'remote production acceptance'},
    });
    assert.equal(conversation.status, 201, conversation.body);
    const conversationId = parsed(conversation).data._id;
    const stream = await request(port, `/api/v1/chat/conversations/${conversationId}/stream`, {
      method: 'POST', token: identity.accessToken, timeout: 60_000,
      body: {message: 'Return the verification marker.', model: 'remote-chat'},
    });
    assert.equal(stream.status, 200, stream.body);
    assert.match(stream.body, /REMOTE_PROVIDER_VERIFIED/);
    assert.match(stream.body, /"provider":"openai-compatible"/);
    assert.match(stream.body, /event: completed/);
    assert.doesNotMatch(stream.body, /event: error/);

    volumeIdentity = Object.fromEntries(volumeNames.map((volume) => {
      const inspected = JSON.parse(docker(['volume', 'inspect', volume]))[0];
      return [volume, `${inspected.Name}:${inspected.CreatedAt}`];
    }));

    compose(['restart', 'mongodb', 'backend']);
    compose(['up', '-d', '--wait'], {stdio: 'inherit'});
    await retry(async () => {
      const login = await request(port, '/api/v1/auth/login', {method: 'POST', body: {email, password}});
      assert.equal(login.status, 200, login.body);
      assert.equal(parsed(login).data.user._id, userId);
    });

    compose(['down']);
    compose(['up', '-d', '--wait'], {stdio: 'inherit'});
    const loginAfterRecreate = await retry(async () => {
      const login = await request(port, '/api/v1/auth/login', {method: 'POST', body: {email, password}});
      assert.equal(login.status, 200, login.body);
      return login;
    });
    assert.equal(parsed(loginAfterRecreate).data.user._id, userId);
    assert.deepEqual(Object.fromEntries(volumeNames.map((volume) => {
      const inspected = JSON.parse(docker(['volume', 'inspect', volume]))[0];
      return [volume, `${inspected.Name}:${inspected.CreatedAt}`];
    })), volumeIdentity);

    const cleanup = `const userId=ObjectId('${userId}');const conversations=db.conversations.deleteMany({userId});const users=db.users.deleteOne({_id:userId});print(JSON.stringify({conversations:conversations.deletedCount,users:users.deletedCount,remainingConversations:db.conversations.countDocuments({userId}),remainingUsers:db.users.countDocuments({_id:userId})}))`;
    const cleanupResult = JSON.parse(compose(['exec', '-T', 'mongodb', 'mongosh', '--quiet', '--username', mongoRootUsername, '--password', mongoPassword,
      '--authenticationDatabase', 'admin', 'kfive_ai', '--eval', cleanup]).split('\n').at(-1));
    assert.equal(cleanupResult.conversations, 1);
    assert.equal(cleanupResult.users, 1);
    assert.equal(cleanupResult.remainingConversations, 0);
    assert.equal(cleanupResult.remainingUsers, 0);

    console.log(JSON.stringify({
      topology: 'loopback edge; private API/datastores/provider fixture',
      provider: 'openai-compatible/authenticated', model: 'remote-chat', chatStream: 'passed',
      hostOllamaDependency: false, mongoBackendRestartPersistence: true,
      mongoIdentityAfterContainerRecreate: true, volumeObjectsUnchanged: true, fixtureCleaned: true,
    }, null, 2));
  } finally {
    try { compose(['down', '--remove-orphans']); } catch (error) { console.error(String(error.stderr || error.message)); }
    try { removeFixtureVolumes(); } catch (error) { console.error(String(error.stderr || error.message)); process.exitCode = 1; }
    fs.rmSync(tempRoot, {recursive: true, force: true});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
