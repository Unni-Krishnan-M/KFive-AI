'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createSensitiveRedactor } = require('./production-verifier-lib.cjs');

const root = path.resolve(__dirname, '..');

test('production auth verifier is opt-in and inert by default', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/verify-production-auth-live.cjs'), 'utf8');
  assert.match(source, /process\.argv\.includes\('--allow-live-test'\)/);
  assert.match(source, /process\.exit\(2\)/);
  assert.match(source, /Refusing the disposable authentication drill/);
  assert.match(source, /typeof output === 'string' \? output\.trim\(\) : ''/);
  assert.doesNotMatch(source, /compose\(\['exec'/);
  assert.match(source, /'run', '--rm', '--network'/);
  assert.match(source, /'-e', 'MONGO_ROOT_PASSWORD'/);
  assert.match(source, /env: \{ MONGO_ROOT_PASSWORD: rootPassword, MONGO_EVAL: source \}/);
  assert.doesNotMatch(source, /'--password', rootPassword/);
  assert.match(source, /__Host-kfive-refresh/);
  assert.match(source, /HttpOnly; Secure; SameSite=Strict; Max-Age=604800/);
  assert.match(source, /'x-kfive-auth-transport': 'cookie'/);
  assert.match(source, /'x-kfive-csrf': csrfToken/);
  assert.match(source, /Object\.hasOwn\(json\(browserLogin\)\.data, 'refreshToken'\), false/);
  assert.match(source, /assertStatus\(hostileOrigin, 403\)/);
  assert.match(source, /assertStatus\(missingCsrf, 403\)/);
  assert.match(source, /assertStatus\(replay, 401\)/);
  assert.match(source, /assertStatus\(cookieLogout, 200\)/);
  assert.match(source, /createSensitiveRedactor/);
  assert.match(source, /observeResponseSecrets/);
  assert.match(source, /console\.error\(errorText\(error\)\)/);
  assert.match(source, /assert\.deepEqual\(existingVolumeIdentity\(protectedVolumes\), protectedBefore\)/);
  assert.match(source, /JWT_EXPIRES_IN: 4s/);
  assert.match(source, /function jwtExpirySeconds/);
  assert.match(source, /assertStatus\(expiredAccess, 401\)/);
  assert.match(source, /Token expired/);
  assert.match(source, /assertStatus\(postExpiryRefresh, 200\)/);
  assert.match(source, /assertStatus\(postLogoutAccess, 200\)/);
  assert.match(source, /assertStatus\(postLogoutExpired, 401\)/);
  assert.match(source, /JWT_REFRESH_EXPIRES_IN: 60s/);
  assert.match(source, /function refreshExpirySeconds/);
  assert.match(source, /assertStatus\(expiredRefresh, 401\)/);
  assert.match(source, /Invalid or expired refresh token/);
  assert.match(source, /assert\.equal\(expiredRefresh\.headers\['cache-control'\], 'no-store'\)/);
  assert.match(source, /assert\.equal\(afterExpiredCleanup\.target, 0\)/);
  assert.match(source, /assert\.equal\(afterExpiredCleanup\.sentinel, 1\)/);
  assert.match(source, /assert\.equal\(expiredReplay\.headers\['set-cookie'\], undefined/);
  assert.match(source, /assert\.equal\(afterBadSignature\.total, beforeBadSignature\.total\)/);
  assert.match(source, /expiredRefreshSessionRemoved: true/);
  assert.match(source, /loginReplacementRevokedPredecessor: true/);
  assert.match(source, /registrationReplacementRevokedPredecessor: true/);
  assert.match(source, /replacementPreservedUnrelatedSession: true/);
  assert.match(source, /replacementSuccessorUsable: true/);
  assert.match(source, /revoked login predecessor must not clear the successor cookie/);
  assert.match(source, /revoked registration predecessor must not clear the successor cookie/);
});

test('authentication verifier diagnostics redact generated credentials and response capabilities', () => {
  const values = [
    'eyJhbGciOiJIUzI1NiJ9.access.signature',
    'eyJhbGciOiJIUzI1NiJ9.refresh.signature',
    '__Host-kfive-refresh=eyJhbGciOiJIUzI1NiJ9.refresh.signature; Path=/',
    'fixture-password',
    '/tmp/kfive-auth-private/auth.env',
  ];
  const redact = createSensitiveRedactor(values);
  const safe = redact(`failure ${values.join(' ')} --password fixture-password --env-file /tmp/kfive-auth-private/auth.env`);
  for (const value of values) assert.equal(safe.includes(value), false);
  assert.match(safe, /\[REDACTED\]/);
});
