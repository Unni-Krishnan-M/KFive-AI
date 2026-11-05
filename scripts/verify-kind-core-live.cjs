#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

if (!process.argv.includes('--allow-live-test')) {
  console.error('Refusing to mutate the disposable kind test deployment without --allow-live-test.');
  process.exit(2);
}

function request(path, { method = 'GET', body, token, timeout = 150_000 } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 8088, path, method, timeout,
      headers: {
        Host: 'kfive.local',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.once('timeout', () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function json(response) {
  return JSON.parse(response.body);
}

function kubectl(...args) {
  return execFileSync('kubectl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function retry(action, attempts = 20) {
  let error;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(); } catch (caught) { error = caught; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw error;
}

async function main() {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const email = `kind-${nonce}@example.invalid`;
  const username = `kind_${nonce.slice(0, 20)}`;
  const password = `Kf!${crypto.randomBytes(18).toString('base64url')}`;
  let userId;
  try {
    const frontend = await request('/');
    assert.equal(frontend.status, 200);
    assert.match(frontend.body, /<title>KFive AI(?: - AI Workspace)?<\/title>/);

    const readiness = await request('/api/v1/readiness');
    assert.equal(readiness.status, 200);
    assert.deepEqual(json(readiness).dependencies.mongodb, 'available');
    assert.deepEqual(json(readiness).dependencies.redis, 'available');

    const socketHandshake = await request(`/socket.io/?EIO=4&transport=polling&t=${Date.now()}`);
    assert.equal(socketHandshake.status, 200);
    assert.match(socketHandshake.body, /^0\{"sid":"/);

    const registration = await request('/api/v1/auth/register', {
      method: 'POST', body: { email, username, password, firstName: 'Kind', lastName: 'Verifier' },
    });
    assert.equal(registration.status, 201, registration.body);
    const registered = json(registration).data;
    userId = registered.user._id;
    assert.match(userId, /^[a-f\d]{24}$/);

    const models = await request('/api/v1/models', { token: registered.accessToken });
    assert.equal(models.status, 200, models.body);
    const modelData = json(models).data;
    assert.equal(modelData.provider.id, 'ollama');
    assert.ok(modelData.models.some((model) => model.id === 'phi3:latest' || model.name === 'phi3:latest'));

    const conversationResponse = await request('/api/v1/chat/conversations', {
      method: 'POST', token: registered.accessToken, body: { title: 'kind live verification' },
    });
    assert.equal(conversationResponse.status, 201, conversationResponse.body);
    const conversationId = json(conversationResponse).data._id;
    const stream = await request(`/api/v1/chat/conversations/${conversationId}/stream`, {
      method: 'POST', token: registered.accessToken,
      body: { message: 'Reply briefly with: KFive kind verified.', model: 'phi3:latest' },
    });
    assert.equal(stream.status, 200, stream.body);
    assert.match(stream.body, /event: start/);
    assert.match(stream.body, /"provider":"ollama"/);
    assert.match(stream.body, /"model":"phi3:latest"/);
    assert.match(stream.body, /event: completed/);
    assert.doesNotMatch(stream.body, /event: error/);

    execFileSync('docker', ['restart', 'kfive-kind-ollama-bridge'], { stdio: 'ignore' });
    await retry(async () => {
      const response = await request('/api/v1/models', { token: registered.accessToken, timeout: 10_000 });
      assert.equal(response.status, 200, response.body);
      return response;
    });

    kubectl('-n', 'kfive', 'rollout', 'restart', 'statefulset/mongodb');
    kubectl('-n', 'kfive', 'rollout', 'status', 'statefulset/mongodb', '--timeout=240s');
    kubectl('-n', 'kfive', 'rollout', 'restart', 'deployment/backend');
    kubectl('-n', 'kfive', 'rollout', 'status', 'deployment/backend', '--timeout=240s');

    const login = await retry(async () => {
      const response = await request('/api/v1/auth/login', { method: 'POST', body: { email, password }, timeout: 10_000 });
      assert.equal(response.status, 200, response.body);
      return response;
    });
    assert.equal(json(login).data.user._id, userId);

    console.log(JSON.stringify({
      frontend: 'passed', readiness: 'passed', socketIo: 'passed', providerModels: 'passed',
      chatStream: 'passed', bridgeRestart: 'passed', mongoBackendRestartPersistence: 'passed', userId,
    }, null, 2));
  } finally {
    if (userId) {
      const cleanup = `db.conversations.deleteMany({userId:ObjectId('${userId}')});db.users.deleteOne({_id:ObjectId('${userId}')})`;
      kubectl('-n', 'kfive', 'exec', 'statefulset/mongodb', '--', 'sh', '-c',
        `mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin kfive_ai --eval "${cleanup}" >/dev/null`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
