#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createSensitiveRedactor } = require('./production-verifier-lib.cjs');

if (!process.argv.includes('--allow-live-test')) {
  console.error('Refusing the disposable production hybrid drill without --allow-live-test.');
  process.exit(2);
}

const MIB = 1024 * 1024;
const nonce = crypto.randomBytes(6).toString('hex');
const project = `kfive-hybrid-test-${nonce}`;
const backendImage = `kfive-ai-backend:hybrid-${nonce}`;
const fixtureImage = `kfive-ai-provider-fixture:hybrid-${nonce}`;
const fixtureContainer = `${project}-external-provider`;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kfive-hybrid-live-'));
const envFile = path.join(tempRoot, 'hybrid.env');
const overrideFile = path.join(tempRoot, 'hybrid-override.yml');
const composeFiles = ['docker-compose.production.yml', overrideFile];
const redactDiagnostic = createSensitiveRedactor([tempRoot, envFile, overrideFile]);
const volumeNames = ['mongodb_data', 'redis_data', 'chromadb_data', 'backend_uploads', 'backend_logs']
  .map((suffix) => `${project}_${suffix}`);
const protectedVolumes = [
  'kfive-ai_mongodb_data', 'kfive-ai_redis_data', 'kfive-ai_chromadb_data',
  'kfive-ai_backend_uploads', 'kfive-ai_backend_logs', 'kfive-ai_ollama_bridge_socket',
];
const cleanupErrors = [];

function docker(args, options = {}) {
  const output = execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 180_000,
    maxBuffer: 64 * MIB,
  });
  return typeof output === 'string' ? output.trim() : '';
}

function compose(args, options = {}) {
  return docker([
    'compose', '--env-file', envFile, '-p', project,
    ...composeFiles.flatMap((file) => ['-f', file]), ...args,
  ], options);
}

function errorText(error) {
  return redactDiagnostic(`${String(error.stderr || '')}\n${String(error.stdout || '')}\n${String(error.message || error)}`);
}

function request(port, route, { method = 'GET', body, token, timeout = 10_000 } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method, timeout,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('timeout', () => req.destroy(new Error(`${method} ${route} timed out`)));
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function json(response) { return JSON.parse(response.body); }

function parseSse(body) {
  const blocks = body.replace(/\r\n/g, '\n').split('\n\n').filter(Boolean);
  return blocks.map((block) => {
    const record = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) record.id = line.slice(4);
      else if (line.startsWith('event: ')) record.event = line.slice(7);
      else if (line.startsWith('data: ')) {
        assert.equal(record.rawData, undefined, 'SSE block has duplicate data fields');
        record.rawData = line.slice(6);
      } else if (line.length !== 0 && !line.startsWith(':')) {
        throw new Error(`Malformed SSE line: ${line}`);
      }
    }
    assert.notEqual(record.rawData, undefined, 'SSE block has no data');
    if (record.rawData === '[DONE]') return { done: true };
    assert.ok(record.id, 'Named SSE event has no request id');
    assert.ok(record.event, 'Named SSE event has no event name');
    return { id: record.id, event: record.event, data: JSON.parse(record.rawData) };
  });
}

function assertSuccessfulStream(response) {
  assert.equal(response.status, 200, response.body);
  const records = parseSse(response.body);
  assert.deepEqual(records.at(-1), { done: true });
  assert.equal(records.filter((record) => record.done).length, 1, 'SSE stream has duplicate terminal markers');
  const named = records.filter((record) => !record.done);
  assert.ok(named.every((record) => ['generation', 'start', 'delta', 'usage', 'completed'].includes(record.event)), 'SSE stream has an unexpected event');
  assert.ok(named.every((record) => record.data.requestId === record.id), 'SSE data request id does not match event id');
  const ids = new Set(named.map((record) => record.id));
  assert.equal(ids.size, 1, 'SSE request ids are inconsistent');
  assert.equal(named.filter((record) => record.event === 'generation' && record.data.status === 'running').length, 1);
  assert.equal(named.filter((record) => record.event === 'start'
    && record.data.provider === 'openai-compatible' && record.data.model === 'remote-chat').length, 1);
  assert.equal(named.filter((record) => record.event === 'error').length, 0);
  assert.equal(named.filter((record) => record.event === 'completed').length, 1);
  const deltas = named.filter((record) => record.event === 'delta').map((record) => record.data.content).join('');
  assert.equal(deltas, 'REMOTE_PROVIDER_VERIFIED');
  const completed = named.find((record) => record.event === 'completed').data.generation;
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.provider, 'openai-compatible');
  assert.equal(completed.model, 'remote-chat');
  return records;
}

function assertFailedClosedStream(response) {
  assert.equal(response.status, 200, response.body);
  const records = parseSse(response.body);
  assert.deepEqual(records.at(-1), { done: true });
  assert.equal(records.filter((record) => record.done).length, 1, 'SSE stream has duplicate terminal markers');
  const named = records.filter((record) => !record.done);
  assert.ok(named.every((record) => ['generation', 'completed'].includes(record.event)), 'Failed SSE stream has an unexpected event');
  assert.ok(named.every((record) => record.data.requestId === record.id), 'SSE data request id does not match event id');
  assert.equal(new Set(named.map((record) => record.id)).size, 1, 'SSE request ids are inconsistent');
  assert.equal(named.filter((record) => record.event === 'generation' && record.data.status === 'running').length, 1);
  assert.equal(named.filter((record) => record.event === 'start').length, 0);
  assert.equal(named.filter((record) => record.event === 'delta').length, 0);
  assert.equal(named.filter((record) => record.event === 'error').length, 0);
  assert.equal(named.filter((record) => record.event === 'completed').length, 1);
  const completed = named.find((record) => record.event === 'completed').data.generation;
  assert.equal(completed.status, 'failed');
  assert.deepEqual(completed.error, {
    code: 'CHAT_PROVIDER_UNAVAILABLE',
    message: 'The configured AI provider is unavailable.',
  });
  assert.equal(completed.content ?? '', '');
  assert.equal(completed.outputBytes, 0);
  assert.notEqual(completed.provider, 'ollama');
  assert.doesNotMatch(response.body, /REMOTE_PROVIDER_VERIFIED/);
  return records;
}

async function retry(action, attempts = 60, delayMs = 1_000) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw lastError;
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
  try {
    docker(['image', 'inspect', name]);
    throw new Error(`refusing pre-existing image ${name}`);
  } catch (error) {
    if (!/no such image/i.test(errorText(error))) throw error;
  }
}

function assertContainerAbsent(name) {
  try {
    docker(['inspect', name]);
    throw new Error(`refusing pre-existing container ${name}`);
  } catch (error) {
    if (!/no such object|no such container/i.test(errorText(error))) throw error;
  }
}

function assertProjectAbsent() {
  assert.equal(docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]), '');
  assert.equal(docker(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '');
  assert.deepEqual(volumeIdentity(volumeNames), {});
  assertContainerAbsent(fixtureContainer);
  assertImageAbsent(backendImage);
  assertImageAbsent(fixtureImage);
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

function removeOwnedContainer() {
  try {
    const item = inspect(fixtureContainer);
    assert.equal(item.Config?.Labels?.['kfive.verifier'], project, 'refusing foreign provider container');
    docker(['rm', '-f', fixtureContainer]);
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

function networkMembers(network) {
  return Object.keys(JSON.parse(docker(['network', 'inspect', `${project}_${network}`]))[0].Containers || {}).sort();
}

function assertNoPublishedPorts(item, label) {
  assert.ok(Object.values(item.NetworkSettings.Ports || {}).every((bindings) => bindings === null), `${label} published a host port`);
}

async function streamChat(port, token, conversationId, message) {
  return request(port, `/api/v1/chat/conversations/${conversationId}/stream`, {
    method: 'POST', token, timeout: 30_000, body: { message, model: 'remote-chat' },
  });
}

async function main() {
  const port = crypto.randomInt(15_000, 55_000);
  const protectedBefore = volumeIdentity(protectedVolumes);
  const preExistingVolumes = volumeIdentity(docker(['volume', 'ls', '-q']).split(/\r?\n/).filter(Boolean));
  const secrets = {
    root: `r${crypto.randomBytes(18).toString('base64url')}`,
    app: `a${crypto.randomBytes(18).toString('base64url')}`,
    redis: `d${crypto.randomBytes(18).toString('base64url')}`,
    jwt: crypto.randomBytes(32).toString('base64url'),
    refresh: crypto.randomBytes(32).toString('base64url'),
    provider: crypto.randomBytes(24).toString('base64url'),
  };
  const email = `hybrid-${nonce}@example.invalid`;
  const password = `Kf!${crypto.randomBytes(18).toString('base64url')}`;
  redactDiagnostic.add([...Object.values(secrets), password]);
  fs.writeFileSync(envFile, [
    `KFIVE_PRODUCTION_PROJECT=${project}`,
    `KFIVE_VOLUME_PREFIX=${project}`,
    'KFIVE_EDGE_BIND_ADDRESS=127.0.0.1',
    `KFIVE_EDGE_HTTP_PORT=${port}`,
    'KFIVE_MODE=hybrid',
    `PUBLIC_BASE_URL=http://127.0.0.1:${port}`,
    `CORS_ORIGIN=http://127.0.0.1:${port}`,
    'TRUST_PROXY_HOPS=1',
    'AI_PROVIDER=openai-compatible',
    'AI_DEFAULT_MODEL=remote-chat',
    'AI_TIMEOUT_MS=3000',
    'OPENAI_BASE_URL=http://hybrid-provider.example.test:4010/v1',
    `OPENAI_API_KEY=${secrets.provider}`,
    'OPENAI_COMPATIBLE_SUPPORTS_EMBEDDINGS=false',
    'OPENAI_COMPATIBLE_SUPPORTS_STRUCTURED_OUTPUT=false',
    'MONGO_ROOT_USERNAME=kfive_root',
    `MONGO_ROOT_PASSWORD=${secrets.root}`,
    'MONGO_DATABASE=kfive_ai',
    'MONGO_APP_USERNAME=kfive',
    `MONGO_APP_PASSWORD=${secrets.app}`,
    `REDIS_PASSWORD=${secrets.redis}`,
    `JWT_SECRET=${secrets.jwt}`,
    `JWT_REFRESH_SECRET=${secrets.refresh}`,
    `KFIVE_BACKEND_IMAGE=${backendImage}`,
    'KFIVE_FRONTEND_IMAGE=kfive-ai-frontend',
    'KFIVE_MONGODB_IMAGE=mongo:7.0',
    'KFIVE_REDIS_IMAGE=redis:7.2-alpine',
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
  let userId;
  try {
    assertProjectAbsent();
    cleanupAuthorized = true;
    for (const image of ['kfive-ai-frontend', 'mongo:7.0', 'redis:7.2-alpine', 'chromadb/chroma:0.4.24']) {
      docker(['image', 'inspect', image]);
    }
    docker(['build', '--label', `kfive.verifier=${project}`, '-t', backendImage, '-f', 'backend/Dockerfile', '.'], {
      stdio: 'inherit', timeout: 600_000,
    });
    docker(['build', '--label', `kfive.verifier=${project}`, '-t', fixtureImage, '-f', 'services/remote-provider-fixture/Dockerfile', '.'], {
      stdio: 'inherit', timeout: 300_000,
    });
    compose(['up', '-d', 'mongodb', 'redis', 'chromadb'], { stdio: 'inherit' });
    compose(['create', 'backend', 'benchmark-worker', 'frontend'], { stdio: 'inherit' });
    docker(['run', '-d', '--name', fixtureContainer,
      '--label', `kfive.verifier=${project}`,
      '--network', `${project}_provider_egress`, '--network-alias', 'hybrid-provider.example.test',
      '--env', `FIXTURE_BEARER_TOKEN=${secrets.provider}`,
      '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=8m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--pids-limit', '32', '--memory', '64m', '--cpus', '0.25',
      fixtureImage]);
    compose(['up', '-d'], { stdio: 'inherit' });

    const publicHealth = await retry(async () => {
      const result = await request(port, '/api/v1/health');
      assert.equal(result.status, 200, result.body);
      assert.equal(json(result).status, 'healthy');
      assert.equal(json(result).mode, 'hybrid');
      return result;
    });
    assert.equal(publicHealth.status, 200);
    const unauthenticatedRuntime = await request(port, '/api/v1/settings/runtime');
    assert.equal(unauthenticatedRuntime.status, 401, unauthenticatedRuntime.body);

    const registration = await retry(async () => {
      const result = await request(port, '/api/v1/auth/register', {
        method: 'POST', body: { email, username: `hybrid_${nonce}`, password, firstName: 'Hybrid', lastName: 'Verifier' },
      });
      assert.equal(result.status, 201, result.body);
      return result;
    });
    const identity = json(registration).data;
    userId = identity.user._id;
    let accessToken = identity.accessToken;

    const runtime = await request(port, '/api/v1/runtime', { token: accessToken });
    assert.equal(runtime.status, 200, runtime.body);
    const runtimeData = json(runtime).data;
    assert.equal(runtimeData.mode, 'hybrid');
    assert.equal(runtimeData.apiVersion, 'v1');
    assert.deepEqual(runtimeData.provider, {
      id: 'openai-compatible', configured: true, location: 'remote', transport: 'http',
      liveSwitchSupported: false, restartRequired: true,
    });
    for (const id of ['mongodb', 'redis', 'chromadb']) {
      const service = runtimeData.services.find((entry) => entry.id === id);
      assert.equal(service?.configured, true);
      assert.equal(service?.location, 'local');
    }
    for (const id of ['code-runner', 'document-processor', 'ocr']) {
      const service = runtimeData.services.find((entry) => entry.id === id);
      assert.equal(service?.configured, false);
      assert.equal(service?.location, 'disabled');
    }
    for (const secret of [...Object.values(secrets), envFile, 'hybrid-provider.example.test', 'mongodb:27017', 'redis:6379']) {
      assert.doesNotMatch(runtime.body, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }

    const frontend = inspectService('frontend');
    assert.deepEqual(frontend.NetworkSettings.Ports['8080/tcp'].map(({ HostIp, HostPort }) => ({ HostIp, HostPort })), [
      { HostIp: '127.0.0.1', HostPort: String(port) },
    ]);
    const services = ['backend', 'benchmark-worker', 'mongodb', 'redis', 'chromadb'];
    const serviceIds = Object.fromEntries(services.map((service) => [service, inspectService(service).Id]));
    const fixture = inspect(fixtureContainer);
    assert.equal(fixture.Config.Labels['kfive.verifier'], project);
    assert.equal(fixture.Config.Labels['com.docker.compose.project'], undefined);
    assert.deepEqual(Object.keys(fixture.NetworkSettings.Networks), [`${project}_provider_egress`]);
    assertNoPublishedPorts(fixture, 'external provider fixture');
    assert.equal(fixture.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(fixture.HostConfig.CapDrop, ['ALL']);
    assert.ok(fixture.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    assert.equal(fixture.HostConfig.PidsLimit, 32);
    assert.equal(fixture.HostConfig.Memory, 64 * MIB);
    assert.equal(fixture.HostConfig.NanoCpus, 250_000_000);
    assert.notEqual(fixture.HostConfig.NetworkMode, 'host');
    for (const service of services) {
      const item = inspectService(service);
      assertNoPublishedPorts(item, service);
      assert.ok(item.HostConfig.PidsLimit > 0);
      assert.ok(item.HostConfig.Memory > 0);
      assert.ok(item.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    }
    assert.equal(JSON.parse(docker(['network', 'inspect', `${project}_app_internal`]))[0].Internal, true);
    assert.equal(JSON.parse(docker(['network', 'inspect', `${project}_data_internal`]))[0].Internal, true);
    assert.deepEqual(networkMembers('edge'), [frontend.Id].sort());
    assert.deepEqual(networkMembers('app_internal'), [frontend.Id, serviceIds.backend].sort());
    assert.deepEqual(networkMembers('data_internal'), [serviceIds.backend, serviceIds['benchmark-worker'], serviceIds.mongodb, serviceIds.redis, serviceIds.chromadb].sort());
    assert.deepEqual(networkMembers('provider_egress'), [serviceIds.backend, serviceIds['benchmark-worker'], fixture.Id].sort());

    const models = await request(port, '/api/v1/models', { token: accessToken });
    assert.equal(models.status, 200, models.body);
    assert.equal(json(models).data.provider.id, 'openai-compatible');
    assert.ok(json(models).data.models.some((model) => model.id === 'remote-chat'));
    const providerHealthy = await request(port, '/api/v1/provider/status', { token: accessToken });
    assert.equal(providerHealthy.status, 200, providerHealthy.body);

    const conversation = await request(port, '/api/v1/chat/conversations', {
      method: 'POST', token: accessToken, body: { title: 'hybrid acceptance' },
    });
    assert.equal(conversation.status, 201, conversation.body);
    const conversationId = json(conversation).data._id;
    const firstStream = await streamChat(port, accessToken, conversationId, 'Return the remote verification marker.');
    assertSuccessfulStream(firstStream);

    const fixtureId = fixture.Id;
    docker(['stop', '--time', '5', fixtureContainer]);
    assert.equal(inspect(fixtureContainer).State.Running, false);
    const modelsDown = await retry(async () => {
      const result = await request(port, '/api/v1/models', { token: accessToken });
      assert.equal(result.status, 503, result.body);
      assert.equal(json(result).success, false);
      assert.equal(json(result).error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(json(result).error.provider, 'openai-compatible');
      assert.equal(json(result).error.retryable, true);
      for (const secret of Object.values(secrets)) assert.doesNotMatch(result.body, new RegExp(secret));
      return result;
    }, 15, 500);
    assert.equal(modelsDown.status, 503);
    const failedStream = await streamChat(port, accessToken, conversationId, 'Do not use a local fallback.');
    assertFailedClosedStream(failedStream);
    const failedConversation = await request(port, `/api/v1/chat/conversations/${conversationId}`, { token: accessToken });
    assert.equal(failedConversation.status, 200, failedConversation.body);
    assert.match(failedConversation.body, /CHAT_PROVIDER_UNAVAILABLE/);
    assert.doesNotMatch(failedConversation.body, /"provider":"ollama"/);

    docker(['start', fixtureContainer]);
    assert.equal(inspect(fixtureContainer).Id, fixtureId);
    await retry(async () => {
      const result = await request(port, '/api/v1/provider/status', { token: accessToken });
      assert.equal(result.status, 200, result.body);
    }, 30, 500);
    const recoveredStream = await streamChat(port, accessToken, conversationId, 'Return the marker after recovery.');
    assertSuccessfulStream(recoveredStream);

    const volumesBeforeRestart = volumeIdentity(volumeNames);
    compose(['restart', 'mongodb', 'backend']);
    const login = await retry(async () => {
      const result = await request(port, '/api/v1/auth/login', { method: 'POST', body: { email, password } });
      assert.equal(result.status, 200, result.body);
      return result;
    });
    assert.equal(json(login).data.user._id, userId);
    accessToken = json(login).data.accessToken;
    const persisted = await request(port, `/api/v1/chat/conversations/${conversationId}`, { token: accessToken });
    assert.equal(persisted.status, 200, persisted.body);
    assert.equal(json(persisted).data._id, conversationId);
    assert.match(persisted.body, /REMOTE_PROVIDER_VERIFIED/);
    assert.match(persisted.body, /CHAT_PROVIDER_UNAVAILABLE/);
    assert.deepEqual(volumeIdentity(volumeNames), volumesBeforeRestart);
    const runtimeAfterRestart = await request(port, '/api/v1/runtime', { token: accessToken });
    assert.equal(runtimeAfterRestart.status, 200, runtimeAfterRestart.body);
    assert.equal(json(runtimeAfterRestart).data.mode, 'hybrid');
    const postRestartConversation = await request(port, '/api/v1/chat/conversations', {
      method: 'POST', token: accessToken, body: { title: 'hybrid post-restart inference' },
    });
    assert.equal(postRestartConversation.status, 201, postRestartConversation.body);
    const postRestartConversationId = json(postRestartConversation).data._id;
    assertSuccessfulStream(await streamChat(port, accessToken, postRestartConversationId, 'Verify inference after restart.'));

    const cleanup = `const userId=ObjectId('${userId}');const conversations=db.conversations.deleteMany({userId});const users=db.users.deleteOne({_id:userId});print(JSON.stringify({conversations:conversations.deletedCount,users:users.deletedCount,remainingConversations:db.conversations.countDocuments({userId}),remainingUsers:db.users.countDocuments({_id:userId})}))`;
    const cleanupResult = JSON.parse(docker(['run', '--rm',
      '--network', `${project}_data_internal`, '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--entrypoint', 'mongosh', 'mongo:7.0',
      '--quiet', '--host', 'mongodb', '--username', 'kfive_root', '--password', secrets.root,
      '--authenticationDatabase', 'admin', 'kfive_ai', '--eval', cleanup]).split('\n').at(-1));
    assert.equal(cleanupResult.conversations, 2);
    assert.equal(cleanupResult.users, 1);
    assert.equal(cleanupResult.remainingConversations, 0);
    assert.equal(cleanupResult.remainingUsers, 0);

    console.log(JSON.stringify({
      nonce,
      mode: 'hybrid',
      localPersistence: ['mongodb', 'redis', 'chromadb', 'backend uploads', 'backend logs'],
      provider: { id: 'openai-compatible', classifiedLocation: 'remote', independentlyManagedFixture: true },
      initialRemoteChat: true,
      providerOutage: { detected: true, failClosedWithoutOllamaFallback: true },
      providerRecovery: true,
      mongoBackendRestartPersistence: true,
      volumeObjectsUnchangedAcrossRestart: true,
      topology: 'loopback frontend; private API and stores; external fixture attached only to provider-egress',
      verificationRecordsCleaned: true,
    }, null, 2));
  } finally {
    if (cleanupAuthorized) {
      try { removeOwnedContainer(); } catch (error) { cleanupErrors.push(errorText(error)); }
      try { compose(['down', '--remove-orphans']); } catch (error) { cleanupErrors.push(errorText(error)); }
      try { removeOwnedVolumes(); } catch (error) { cleanupErrors.push(errorText(error)); }
      try { removeOwnedImage(backendImage); } catch (error) { cleanupErrors.push(errorText(error)); }
      try { removeOwnedImage(fixtureImage); } catch (error) { cleanupErrors.push(errorText(error)); }
      try {
        assert.equal(docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]), '');
        assert.equal(docker(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '');
        assert.deepEqual(volumeIdentity(volumeNames), {});
        assertContainerAbsent(fixtureContainer);
      } catch (error) { cleanupErrors.push(errorText(error)); }
    }
    try { assert.deepEqual(volumeIdentity(protectedVolumes), protectedBefore); } catch (error) { cleanupErrors.push(errorText(error)); }
    try { assert.deepEqual(volumeIdentity(Object.keys(preExistingVolumes)), preExistingVolumes); } catch (error) { cleanupErrors.push(errorText(error)); }
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (cleanupErrors.length) throw new Error(`Hybrid verifier cleanup failed:\n${cleanupErrors.join('\n')}`);
  }
}

main().catch((error) => {
  console.error(errorText(error));
  process.exitCode = 1;
});
