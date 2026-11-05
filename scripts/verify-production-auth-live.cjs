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
  console.error('Refusing the disposable authentication drill without --allow-live-test.');
  process.exit(2);
}

const nonce = crypto.randomBytes(6).toString('hex');
const project = `kfive-auth-test-${nonce}`;
const backendImage = `kfive-ai-backend:auth-${nonce}`;
const fixtureImage = `kfive-ai-provider-fixture:auth-${nonce}`;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kfive-auth-live-'));
const envFile = path.join(tempRoot, 'auth.env');
const healthOverride = path.join(tempRoot, 'no-exec-healthchecks.yml');
const composeFiles = ['docker-compose.production.yml', 'docker-compose.production.acceptance.yml', healthOverride];
const volumeNames = ['mongodb_data', 'redis_data', 'chromadb_data', 'backend_uploads', 'backend_logs'].map((suffix) => `${project}_${suffix}`);
const protectedVolumes = ['kfive-ai_mongodb_data', 'kfive-ai_redis_data', 'kfive-ai_chromadb_data', 'kfive-ai_backend_uploads', 'kfive-ai_backend_logs', 'kfive-ai_ollama_bridge_socket'];
const cleanupErrors = [];
const redactDiagnostic = createSensitiveRedactor([tempRoot, envFile, healthOverride]);

function docker(args, options = {}) {
  const output = execFileSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return typeof output === 'string' ? output.trim() : '';
}

function compose(args, options = {}) {
  return docker(['compose', '--env-file', envFile, '-p', project, ...composeFiles.flatMap((file) => ['-f', file]), ...args], options);
}

function errorText(error) {
  return redactDiagnostic(`${String(error.stderr || '')}\n${String(error.stdout || '')}\n${String(error.message || error)}`);
}

function observeResponseSecrets(response) {
  const setCookies = response?.headers?.['set-cookie'];
  if (Array.isArray(setCookies)) redactDiagnostic.add(setCookies);
  try {
    const data = JSON.parse(response?.body || '{}')?.data || {};
    redactDiagnostic.add([data.accessToken, data.refreshToken, data.csrfToken]);
  } catch {}
}

function assertStatus(response, expected) {
  observeResponseSecrets(response);
  assert.equal(response.status, expected, redactDiagnostic(response.body));
}

function existingVolumeIdentity(names) {
  const identities = {};
  for (const name of names) {
    try {
      const volume = JSON.parse(docker(['volume', 'inspect', name]))[0];
      identities[name] = `${volume.Name}:${volume.CreatedAt}:${volume.Mountpoint}`;
    } catch (error) {
      if (!/no such volume/i.test(errorText(error))) throw error;
    }
  }
  return identities;
}

function request(port, route, { method = 'GET', body, headers = {} } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method, timeout: 30_000,
      headers: { ...headers, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
    }, (response) => {
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

function json(response) {
  return JSON.parse(response.body);
}

function hashRefreshTokenForEvidence(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function jwtExpirySeconds(token) {
  const parts = token.split('.');
  assert.equal(parts.length, 3, 'expected a compact JWT');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  assert.ok(Number.isSafeInteger(payload.iat), 'expected an integer JWT issue time');
  assert.ok(Number.isSafeInteger(payload.exp), 'expected an integer JWT expiry');
  assert.equal(payload.exp - payload.iat, 4, 'expected the isolated four-second access lifetime');
  assert.equal(payload.type, 'access');
  assert.equal(payload.iss, 'kfive-ai');
  assert.equal(payload.aud, 'kfive-web');
  return payload.exp;
}

async function waitForJwtExpiry(token) {
  const delayMs = (jwtExpirySeconds(token) * 1000) - Date.now() + 250;
  assert.ok(delayMs > 0 && delayMs <= 10_000, 'unexpected verifier access-token lifetime');
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function refreshExpirySeconds(token) {
  const parts = token.split('.');
  assert.equal(parts.length, 3, 'expected a compact refresh JWT');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  assert.ok(Number.isSafeInteger(payload.iat), 'expected an integer refresh issue time');
  assert.ok(Number.isSafeInteger(payload.exp), 'expected an integer refresh expiry');
  assert.equal(payload.exp - payload.iat, 60, 'expected the isolated 60-second refresh lifetime');
  assert.equal(payload.type, 'refresh');
  assert.equal(payload.iss, 'kfive-ai');
  assert.equal(payload.aud, 'kfive-web');
  return payload.exp;
}

async function waitForRefreshExpiry(token) {
  const delayMs = (refreshExpirySeconds(token) * 1000) - Date.now() + 250;
  assert.ok(delayMs > 0 && delayMs <= 70_000, 'unexpected verifier refresh-token lifetime');
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function exactCookie(response, name) {
  observeResponseSecrets(response);
  const values = response.headers['set-cookie'];
  assert.ok(Array.isArray(values) && values.length === 1, `expected one ${name} Set-Cookie header`);
  assert.ok(new RegExp(`^${name}=[A-Za-z0-9._~-]+; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800$`).test(values[0]), `invalid ${name} cookie policy`);
  return values[0].split(';', 1)[0];
}

async function retry(action, attempts = 50) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw lastError;
}

function mongoEval(rootUser, rootPassword, source) {
  const output = docker([
    'run', '--rm', '--network', `${project}_data_internal`, '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '-e', 'MONGO_ROOT_PASSWORD', '-e', 'MONGO_EVAL',
    '--entrypoint', 'sh', 'mongo:7.0', '-ceu',
    'exec mongosh --quiet --host mongodb --username kfive_root --password "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin kfive_ai --eval "$MONGO_EVAL"',
  ], { env: { MONGO_ROOT_PASSWORD: rootPassword, MONGO_EVAL: source } });
  return JSON.parse(output.split('\n').at(-1));
}

function removeOwnedVolumes() {
  for (const name of volumeNames) {
    try {
      const volume = JSON.parse(docker(['volume', 'inspect', name]))[0];
      assert.equal(volume.Labels?.['com.docker.compose.project'], project, `refusing foreign volume ${name}`);
      docker(['volume', 'rm', name]);
    } catch (error) {
      if (!/no such volume/i.test(errorText(error))) throw error;
    }
  }
}

function removeExactImage(name) {
  try {
    const image = JSON.parse(docker(['image', 'inspect', name]))[0];
    assert.ok((image.RepoTags || []).includes(name), `refusing unexpected image ${name}`);
    docker(['image', 'rm', name]);
  } catch (error) {
    if (!/no such image/i.test(errorText(error))) throw error;
  }
}

async function main() {
  const protectedBefore = existingVolumeIdentity(protectedVolumes);
  const port = crypto.randomInt(15_000, 55_000);
  const rootUser = 'kfive_root';
  const rootPassword = `r${crypto.randomBytes(18).toString('base64url')}`;
  const secrets = {
    mongoApp: `a${crypto.randomBytes(18).toString('base64url')}`,
    redis: `d${crypto.randomBytes(18).toString('base64url')}`,
    jwt: crypto.randomBytes(32).toString('base64url'),
    refresh: crypto.randomBytes(32).toString('base64url'),
    provider: crypto.randomBytes(24).toString('base64url'),
  };
  const environment = [
    `KFIVE_PRODUCTION_PROJECT=${project}`, `KFIVE_VOLUME_PREFIX=${project}`,
    'KFIVE_EDGE_BIND_ADDRESS=127.0.0.1', `KFIVE_EDGE_HTTP_PORT=${port}`,
    `KFIVE_FIXTURE_IMAGE=${fixtureImage}`, `KFIVE_FIXTURE_BEARER_TOKEN=${secrets.provider}`,
    'KFIVE_MODE=remote', `PUBLIC_BASE_URL=http://127.0.0.1:${port}`, `CORS_ORIGIN=http://127.0.0.1:${port}`, 'TRUST_PROXY_HOPS=1',
    'AI_PROVIDER=openai-compatible', 'AI_DEFAULT_MODEL=remote-chat', 'OPENAI_BASE_URL=http://remote-provider-fixture:4010/v1', `OPENAI_API_KEY=${secrets.provider}`,
    'OPENAI_COMPATIBLE_SUPPORTS_EMBEDDINGS=false', 'OPENAI_COMPATIBLE_SUPPORTS_STRUCTURED_OUTPUT=false',
    `MONGO_ROOT_USERNAME=${rootUser}`, `MONGO_ROOT_PASSWORD=${rootPassword}`, 'MONGO_DATABASE=kfive_ai', 'MONGO_APP_USERNAME=kfive', `MONGO_APP_PASSWORD=${secrets.mongoApp}`,
    `REDIS_PASSWORD=${secrets.redis}`, `JWT_SECRET=${secrets.jwt}`, `JWT_REFRESH_SECRET=${secrets.refresh}`,
    `KFIVE_BACKEND_IMAGE=${backendImage}`, 'KFIVE_FRONTEND_IMAGE=kfive-ai-frontend',
    'KFIVE_MONGODB_IMAGE=mongo:7.0', 'KFIVE_REDIS_IMAGE=redis:7.2-alpine', 'KFIVE_CHROMADB_IMAGE=chromadb/chroma:0.4.24',
  ];
  fs.writeFileSync(envFile, `${environment.join('\n')}\n`, { mode: 0o600 });
  fs.writeFileSync(healthOverride, `services:\n  mongodb:\n    healthcheck: {disable: true}\n  redis:\n    healthcheck: {disable: true}\n  chromadb:\n    healthcheck: {disable: true}\n  remote-provider-fixture:\n    healthcheck: {disable: true}\n  backend:\n    healthcheck: {disable: true}\n    environment:\n      JWT_EXPIRES_IN: 4s\n      JWT_REFRESH_EXPIRES_IN: 60s\n    depends_on:\n      mongodb: {condition: service_started}\n      redis: {condition: service_started}\n      chromadb: {condition: service_started}\n      remote-provider-fixture: {condition: service_started}\n  benchmark-worker:\n    depends_on:\n      mongodb: {condition: service_started}\n      redis: {condition: service_started}\n  frontend:\n    healthcheck: {disable: true}\n    depends_on:\n      backend: {condition: service_started}\n`, { mode: 0o600 });

  const email = `auth-${nonce}@example.invalid`;
  const username = `auth_${nonce}`;
  const replacementEmail = `auth-replacement-${nonce}@example.invalid`;
  const replacementUsername = `auth_replacement_${nonce}`;
  const password = `Kf!${crypto.randomBytes(18).toString('base64url')}`;
  redactDiagnostic.add([...Object.values(secrets), rootPassword, password]);
  let userId;
  try {
    docker(['build', '--label', `kfive.verifier=${project}`, '-t', backendImage, '-f', 'backend/Dockerfile', '.'], { stdio: 'inherit' });
    compose(['build', 'remote-provider-fixture'], { stdio: 'inherit' });
    compose(['up', '-d'], { stdio: 'inherit' });

    const oversized = await retry(async () => {
      const result = await request(port, '/api/v1/auth/register', {
        method: 'POST', body: { email: `oversized-${nonce}@example.invalid`, username: `oversized_${nonce}`, password: 'é'.repeat(37) },
      });
      assertStatus(result, 400);
      return result;
    });
    assert.match(oversized.body, /8 and 72 UTF-8 bytes/);

    const registration = await request(port, '/api/v1/auth/register', {
      method: 'POST', body: { email, username, password },
    });
    assertStatus(registration, 201);
    userId = json(registration).data.user._id;

    const loginRefreshTokens = [];
    for (let index = 0; index < 12; index += 1) {
      const login = await request(port, '/api/v1/auth/login', { method: 'POST', body: { email, password } });
      assertStatus(login, 200);
      loginRefreshTokens.push(json(login).data.refreshToken);
    }

    const afterLogins = mongoEval(rootUser, rootPassword, `const u=db.users.findOne({_id:ObjectId('${userId}')},{refreshTokens:1});print(JSON.stringify({count:u.refreshTokens.length}))`);
    assert.equal(afterLogins.count, 10);

    const evicted = await request(port, '/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: loginRefreshTokens[0] } });
    assertStatus(evicted, 401);

    const reused = loginRefreshTokens.at(-1);
    const races = await Promise.all([
      request(port, '/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: reused } }),
      request(port, '/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: reused } }),
    ]);
    assert.deepEqual(races.map(({ status }) => status).sort(), [200, 401]);
    const winningRefresh = json(races.find(({ status }) => status === 200)).data.refreshToken;

    compose(['restart', 'backend']);
    const afterRestart = await retry(async () => {
      const result = await request(port, '/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: winningRefresh } });
      assertStatus(result, 200);
      return result;
    });
    const postRestartRefresh = json(afterRestart).data.refreshToken;

    const logout = await request(port, '/api/v1/auth/logout', { method: 'POST', body: { refreshToken: postRestartRefresh } });
    assertStatus(logout, 200);
    const revoked = await request(port, '/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: postRestartRefresh } });
    assertStatus(revoked, 401);

    const browserHeaders = {
      origin: `http://127.0.0.1:${port}`,
      'x-kfive-auth-transport': 'cookie',
    };
    const browserLogin = await request(port, '/api/v1/auth/login', {
      method: 'POST', headers: browserHeaders, body: { email, password },
    });
    assertStatus(browserLogin, 200);
    assert.equal(browserLogin.headers['cache-control'], 'no-store');
    assert.equal(Object.hasOwn(json(browserLogin).data, 'refreshToken'), false);
    let browserCookie = exactCookie(browserLogin, '__Host-kfive-refresh');
    let csrfToken = json(browserLogin).data.csrfToken;
    let browserAccessToken = json(browserLogin).data.accessToken;
    assert.match(csrfToken, /^[A-Za-z0-9_-]{43}$/);
    const loginPredecessorCookie = browserCookie;
    const loginPredecessorCsrf = csrfToken;
    const loginPredecessorToken = loginPredecessorCookie.slice(loginPredecessorCookie.indexOf('=') + 1);
    const loginPredecessorHash = hashRefreshTokenForEvidence(loginPredecessorToken);
    redactDiagnostic.add([loginPredecessorCookie, loginPredecessorCsrf, loginPredecessorToken, loginPredecessorHash]);
    const replacementLogin = await request(port, '/api/v1/auth/login', {
      method: 'POST', headers: { ...browserHeaders, cookie: loginPredecessorCookie }, body: { email, password },
    });
    assertStatus(replacementLogin, 200);
    browserCookie = exactCookie(replacementLogin, '__Host-kfive-refresh');
    csrfToken = json(replacementLogin).data.csrfToken;
    browserAccessToken = json(replacementLogin).data.accessToken;
    const loginSuccessorToken = browserCookie.slice(browserCookie.indexOf('=') + 1);
    const loginSuccessorHash = hashRefreshTokenForEvidence(loginSuccessorToken);
    redactDiagnostic.add([browserCookie, csrfToken, loginSuccessorToken, loginSuccessorHash]);
    const loginReplacementState = mongoEval(rootUser, rootPassword, `const u=db.users.findOne({_id:ObjectId('${userId}')},{refreshTokens:1});const h=u.refreshTokens||[];print(JSON.stringify({predecessor:h.filter(v=>v==='${loginPredecessorHash}').length,successor:h.filter(v=>v==='${loginSuccessorHash}').length}))`);
    assert.deepEqual(loginReplacementState, { predecessor: 0, successor: 1 });
    const replacedLoginReplay = await request(port, '/api/v1/auth/refresh', {
      method: 'POST', headers: { ...browserHeaders, cookie: loginPredecessorCookie, 'x-kfive-csrf': loginPredecessorCsrf }, body: {},
    });
    assertStatus(replacedLoginReplay, 401);
    assert.equal(replacedLoginReplay.headers['set-cookie'], undefined, 'revoked login predecessor must not clear the successor cookie');
    const browserRemainingSeconds = jwtExpirySeconds(browserAccessToken) - Math.floor(Date.now() / 1000);
    assert.ok(browserRemainingSeconds >= 3 && browserRemainingSeconds <= 4, 'expected a fresh four-second browser access token');

    const preExpiryAccess = await request(port, '/api/v1/user/profile', {
      headers: { authorization: `Bearer ${browserAccessToken}` },
    });
    assertStatus(preExpiryAccess, 200);
    assert.equal(json(preExpiryAccess).data._id, userId);

    const hostileOrigin = await request(port, '/api/v1/auth/refresh', {
      method: 'POST', headers: { ...browserHeaders, origin: 'https://attacker.example.invalid', cookie: browserCookie, 'x-kfive-csrf': csrfToken }, body: {},
    });
    assertStatus(hostileOrigin, 403);
    const missingCsrf = await request(port, '/api/v1/auth/refresh', {
      method: 'POST', headers: { ...browserHeaders, cookie: browserCookie }, body: {},
    });
    assertStatus(missingCsrf, 403);
    const ambiguous = await request(port, '/api/v1/auth/refresh', {
      method: 'POST', headers: { ...browserHeaders, cookie: browserCookie, 'x-kfive-csrf': csrfToken }, body: { refreshToken: 'ambiguous' },
    });
    assertStatus(ambiguous, 400);

    await waitForJwtExpiry(browserAccessToken);
    const expiredAccess = await request(port, '/api/v1/user/profile', {
      headers: { authorization: `Bearer ${browserAccessToken}` },
    });
    assertStatus(expiredAccess, 401);
    assert.equal(json(expiredAccess).error.message, 'Token expired');

    const postExpiryRefresh = await request(port, '/api/v1/auth/refresh', {
      method: 'POST', headers: { ...browserHeaders, cookie: browserCookie, 'x-kfive-csrf': csrfToken }, body: {},
    });
    assertStatus(postExpiryRefresh, 200);
    assert.equal(Object.hasOwn(json(postExpiryRefresh).data, 'refreshToken'), false);
    const predecessorCookie = browserCookie;
    const predecessorCsrf = csrfToken;
    const predecessorExpiry = jwtExpirySeconds(browserAccessToken);
    browserCookie = exactCookie(postExpiryRefresh, '__Host-kfive-refresh');
    csrfToken = json(postExpiryRefresh).data.csrfToken;
    browserAccessToken = json(postExpiryRefresh).data.accessToken;
    assert.notEqual(hashRefreshTokenForEvidence(browserCookie), hashRefreshTokenForEvidence(predecessorCookie));
    assert.notEqual(csrfToken, predecessorCsrf);
    assert.ok(jwtExpirySeconds(browserAccessToken) > predecessorExpiry);
    const recoveredAccess = await request(port, '/api/v1/user/profile', {
      headers: { authorization: `Bearer ${browserAccessToken}` },
    });
    assertStatus(recoveredAccess, 200);
    assert.equal(json(recoveredAccess).data._id, userId);

    const replay = await request(port, '/api/v1/auth/refresh', {
      method: 'POST', headers: { ...browserHeaders, cookie: predecessorCookie, 'x-kfive-csrf': predecessorCsrf }, body: {},
    });
    assertStatus(replay, 401);
    assert.equal(replay.headers['set-cookie'], undefined, 'stale replay must not clear a concurrently rotated cookie');

    compose(['restart', 'backend']);
    const cookieAfterRestart = await retry(async () => {
      const result = await request(port, '/api/v1/auth/refresh', {
        method: 'POST', headers: { ...browserHeaders, cookie: browserCookie, 'x-kfive-csrf': csrfToken }, body: {},
      });
      assertStatus(result, 200);
      return result;
    });
    browserCookie = exactCookie(cookieAfterRestart, '__Host-kfive-refresh');
    csrfToken = json(cookieAfterRestart).data.csrfToken;
    browserAccessToken = json(cookieAfterRestart).data.accessToken;

    const cookieLogout = await request(port, '/api/v1/auth/logout', {
      method: 'POST', headers: { ...browserHeaders, cookie: browserCookie, 'x-kfive-csrf': csrfToken }, body: {},
    });
    assertStatus(cookieLogout, 200);
    assert.ok(/^__Host-kfive-refresh=; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=0;/.test(cookieLogout.headers['set-cookie']?.[0] || ''), 'logout must clear the browser refresh cookie');
    const postLogoutAccess = await request(port, '/api/v1/user/profile', {
      headers: { authorization: `Bearer ${browserAccessToken}` },
    });
    assertStatus(postLogoutAccess, 200);
    await waitForJwtExpiry(browserAccessToken);
    const postLogoutExpired = await request(port, '/api/v1/user/profile', {
      headers: { authorization: `Bearer ${browserAccessToken}` },
    });
    assertStatus(postLogoutExpired, 401);
    assert.equal(json(postLogoutExpired).error.message, 'Token expired');
    const idempotentLogout = await request(port, '/api/v1/auth/logout', {
      method: 'POST', headers: { ...browserHeaders, 'x-kfive-csrf': csrfToken }, body: {},
    });
    assertStatus(idempotentLogout, 200);
    const cookieRevoked = await request(port, '/api/v1/auth/refresh', {
      method: 'POST', headers: { ...browserHeaders, cookie: browserCookie, 'x-kfive-csrf': csrfToken }, body: {},
    });
    assertStatus(cookieRevoked, 401);

    const sentinelLogin = await request(port, '/api/v1/auth/login', {
      method: 'POST', body: { email, password },
    });
    assertStatus(sentinelLogin, 200);
    const sentinelRefreshToken = json(sentinelLogin).data.refreshToken;

    const expiringLogin = await request(port, '/api/v1/auth/login', {
      method: 'POST', headers: browserHeaders, body: { email, password },
    });
    assertStatus(expiringLogin, 200);
    const expiringCookie = exactCookie(expiringLogin, '__Host-kfive-refresh');
    const expiringRefreshToken = expiringCookie.slice(expiringCookie.indexOf('=') + 1);
    const expiringCsrf = json(expiringLogin).data.csrfToken;
    const targetHash = hashRefreshTokenForEvidence(expiringRefreshToken);
    const sentinelHash = hashRefreshTokenForEvidence(sentinelRefreshToken);
    redactDiagnostic.add([expiringRefreshToken, expiringCookie, expiringCsrf, targetHash, sentinelRefreshToken, sentinelHash]);
    refreshExpirySeconds(expiringRefreshToken);

    const refreshSessionState = () => mongoEval(rootUser, rootPassword, `const u=db.users.findOne({_id:ObjectId('${userId}')},{refreshTokens:1});const h=u.refreshTokens||[];print(JSON.stringify({target:h.filter(v=>v==='${targetHash}').length,sentinel:h.filter(v=>v==='${sentinelHash}').length,total:h.length}))`);
    const beforeRefreshExpiry = refreshSessionState();
    assert.equal(beforeRefreshExpiry.target, 1);
    assert.equal(beforeRefreshExpiry.sentinel, 1);

    await waitForRefreshExpiry(expiringRefreshToken);
    const afterNaturalExpiryBeforeUse = refreshSessionState();
    assert.deepEqual(afterNaturalExpiryBeforeUse, beforeRefreshExpiry, 'elapsed time alone must not mutate stored sessions');

    const expiredRefresh = await request(port, '/api/v1/auth/refresh', {
      method: 'POST', headers: { ...browserHeaders, cookie: expiringCookie, 'x-kfive-csrf': expiringCsrf }, body: {},
    });
    assertStatus(expiredRefresh, 401);
    assert.equal(json(expiredRefresh).error.message, 'Invalid or expired refresh token');
    assert.equal(expiredRefresh.headers['cache-control'], 'no-store');
    assert.ok(/^__Host-kfive-refresh=; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT$/.test(expiredRefresh.headers['set-cookie']?.[0] || ''), 'stored expired session must clear its matching browser cookie');
    assert.equal(Object.hasOwn(json(expiredRefresh), 'data'), false);
    const afterExpiredCleanup = refreshSessionState();
    assert.equal(afterExpiredCleanup.target, 0);
    assert.equal(afterExpiredCleanup.sentinel, 1);
    assert.equal(afterExpiredCleanup.total, beforeRefreshExpiry.total - 1);

    const expiredReplay = await request(port, '/api/v1/auth/refresh', {
      method: 'POST', headers: { ...browserHeaders, cookie: expiringCookie, 'x-kfive-csrf': expiringCsrf }, body: {},
    });
    assertStatus(expiredReplay, 401);
    assert.equal(expiredReplay.headers['set-cookie'], undefined, 'absent expired predecessor must not clear a successor cookie');
    assert.deepEqual(refreshSessionState(), afterExpiredCleanup);

    const [badHeader, badPayload, goodSignature] = expiringRefreshToken.split('.');
    const badSignatureToken = `${badHeader}.${badPayload}.${goodSignature.startsWith('A') ? 'B' : 'A'}${goodSignature.slice(1)}`;
    const badSignatureCookie = `__Host-kfive-refresh=${badSignatureToken}`;
    const badSignatureCsrf = crypto.createHmac('sha256', secrets.refresh)
      .update('kfive-browser-refresh-csrf-v1\0').update(badSignatureToken).digest('base64url');
    redactDiagnostic.add([badSignatureToken, badSignatureCookie, badSignatureCsrf]);
    const beforeBadSignature = refreshSessionState();
    const badSignature = await request(port, '/api/v1/auth/refresh', {
      method: 'POST', headers: { ...browserHeaders, cookie: badSignatureCookie, 'x-kfive-csrf': badSignatureCsrf }, body: {},
    });
    assertStatus(badSignature, 401);
    assert.equal(badSignature.headers['set-cookie'], undefined);
    const afterBadSignature = refreshSessionState();
    assert.equal(afterBadSignature.total, beforeBadSignature.total);
    assert.deepEqual(afterBadSignature, beforeBadSignature);

    compose(['restart', 'backend']);
    await retry(async () => {
      const state = refreshSessionState();
      assert.deepEqual(state, afterExpiredCleanup);
      return state;
    });

    const stored = mongoEval(rootUser, rootPassword, `const u=db.users.findOne({_id:ObjectId('${userId}')},{refreshTokens:1});print(JSON.stringify({count:u.refreshTokens.length,oversizedUsers:db.users.countDocuments({email:'oversized-${nonce}@example.invalid'})}))`);
    assert.ok(stored.count <= 10);
    assert.equal(stored.oversizedUsers, 0);

    const registrationPredecessor = await request(port, '/api/v1/auth/login', {
      method: 'POST', headers: browserHeaders, body: { email, password },
    });
    assertStatus(registrationPredecessor, 200);
    const registrationPredecessorCookie = exactCookie(registrationPredecessor, '__Host-kfive-refresh');
    const registrationPredecessorCsrf = json(registrationPredecessor).data.csrfToken;
    const registrationPredecessorToken = registrationPredecessorCookie.slice(registrationPredecessorCookie.indexOf('=') + 1);
    const registrationPredecessorHash = hashRefreshTokenForEvidence(registrationPredecessorToken);
    redactDiagnostic.add([registrationPredecessorCookie, registrationPredecessorCsrf, registrationPredecessorToken, registrationPredecessorHash]);
    const sentinelBeforeReplacement = refreshSessionState().sentinel;
    const replacementRegistration = await request(port, '/api/v1/auth/register', {
      method: 'POST', headers: { ...browserHeaders, cookie: registrationPredecessorCookie },
      body: { email: replacementEmail, username: replacementUsername, password },
    });
    assertStatus(replacementRegistration, 201);
    const replacementUserId = json(replacementRegistration).data.user._id;
    const registrationSuccessorCookie = exactCookie(replacementRegistration, '__Host-kfive-refresh');
    const registrationSuccessorCsrf = json(replacementRegistration).data.csrfToken;
    const registrationSuccessorToken = registrationSuccessorCookie.slice(registrationSuccessorCookie.indexOf('=') + 1);
    const registrationSuccessorHash = hashRefreshTokenForEvidence(registrationSuccessorToken);
    redactDiagnostic.add([replacementUserId, registrationSuccessorCookie, registrationSuccessorCsrf, registrationSuccessorToken, registrationSuccessorHash]);
    const registrationReplacementState = mongoEval(rootUser, rootPassword, `const a=db.users.findOne({_id:ObjectId('${userId}')},{refreshTokens:1});const b=db.users.findOne({_id:ObjectId('${replacementUserId}')},{refreshTokens:1});const ah=a.refreshTokens||[];const bh=b.refreshTokens||[];print(JSON.stringify({predecessor:ah.filter(v=>v==='${registrationPredecessorHash}').length,successor:bh.filter(v=>v==='${registrationSuccessorHash}').length,sentinel:ah.filter(v=>v==='${sentinelHash}').length}))`);
    assert.deepEqual(registrationReplacementState, { predecessor: 0, successor: 1, sentinel: sentinelBeforeReplacement });
    const replacedRegistrationReplay = await request(port, '/api/v1/auth/refresh', {
      method: 'POST', headers: { ...browserHeaders, cookie: registrationPredecessorCookie, 'x-kfive-csrf': registrationPredecessorCsrf }, body: {},
    });
    assertStatus(replacedRegistrationReplay, 401);
    assert.equal(replacedRegistrationReplay.headers['set-cookie'], undefined, 'revoked registration predecessor must not clear the successor cookie');
    const replacementSuccessorRefresh = await request(port, '/api/v1/auth/refresh', {
      method: 'POST', headers: { ...browserHeaders, cookie: registrationSuccessorCookie, 'x-kfive-csrf': registrationSuccessorCsrf }, body: {},
    });
    assertStatus(replacementSuccessorRefresh, 200);

    console.log(JSON.stringify({
      nonce,
      passwordUtf8BoundaryRejected: true,
      oversizedRegistrationPersisted: false,
      retainedSessionLimit: 10,
      oldestSessionEvicted: true,
      concurrentRefreshStatuses: [200, 401],
      singleUseRefreshRotation: true,
      refreshSurvivedBackendRestart: true,
      logoutRevocation: true,
      browserCookieTransport: '__Host-kfive-refresh; HttpOnly; Secure; SameSite=Strict; Path=/',
      refreshTokenAbsentFromBrowserJson: true,
      csrfBoundRotation: true,
      hostileOriginAndMissingCsrfRejected: true,
      predecessorCookieReplayRejected: true,
      cookieRefreshSurvivedBackendRestart: true,
      cookieLogoutRevocationAndClear: true,
      realAccessExpiryRejected: true,
      expiredAccessRecoveredViaCookieRotation: true,
      logoutDoesNotRevokeAccessBeforeExpiry: true,
      postLogoutAccessRejectedAtExpiry: true,
      expiredRefreshSessionRemoved: true,
      unrelatedRefreshSessionPreserved: true,
      expiredRefreshReplayDidNotClearSuccessor: true,
      invalidSignatureDidNotMutateSessions: true,
      refreshCleanupSurvivedBackendRestart: true,
      loginReplacementRevokedPredecessor: true,
      registrationReplacementRevokedPredecessor: true,
      replacementPreservedUnrelatedSession: true,
      replacementSuccessorUsable: true,
      storedSessionsAfterLogout: stored.count,
      topology: 'loopback edge; private API and datastores',
    }, null, 2));
  } finally {
    try { compose(['down', '--remove-orphans']); } catch (error) { cleanupErrors.push(errorText(error)); }
    try { removeOwnedVolumes(); } catch (error) { cleanupErrors.push(errorText(error)); }
    try { removeExactImage(backendImage); } catch (error) { cleanupErrors.push(errorText(error)); }
    try { removeExactImage(fixtureImage); } catch (error) { cleanupErrors.push(errorText(error)); }
    try {
      assert.equal(docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]), '');
      assert.equal(docker(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '');
      assert.deepEqual(existingVolumeIdentity(volumeNames), {});
      assert.deepEqual(existingVolumeIdentity(protectedVolumes), protectedBefore);
    } catch (error) { cleanupErrors.push(errorText(error)); }
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (cleanupErrors.length) throw new Error(`Authentication verifier cleanup failed:\n${cleanupErrors.join('\n')}`);
  }
}

main().catch((error) => {
  console.error(errorText(error));
  process.exitCode = 1;
});
