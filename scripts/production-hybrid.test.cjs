'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { createSensitiveRedactor } = require('./production-verifier-lib.cjs');

test('hybrid diagnostics redact registered secrets and credential arguments', () => {
  const redact = createSensitiveRedactor(['sentinel-secret', '/tmp/private-fixture.env']);
  const message = 'docker run --env FIXTURE_BEARER_TOKEN=sentinel-secret mongosh --password sentinel-secret --env-file /tmp/private-fixture.env';
  const safe = redact(message);
  assert.doesNotMatch(safe, /sentinel-secret|private-fixture/);
  assert.match(safe, /FIXTURE_BEARER_TOKEN=\[REDACTED\]/);
  assert.match(safe, /--password \[REDACTED\]/);
});

test('hybrid acceptance verifier is opt-in, isolated, fail-closed, and exact-cleanup gated', () => {
  const verifier = readFileSync('scripts/verify-production-hybrid-live.cjs', 'utf8');

  assert.match(verifier, /--allow-live-test/);
  assert.match(verifier, /KFIVE_MODE=hybrid/);
  assert.match(verifier, /\/api\/v1\/runtime/);
  assert.match(verifier, /location.*remote|remote.*location/s);
  assert.match(verifier, /docker\(\['run'/);
  assert.match(verifier, /provider_egress/);
  assert.match(verifier, /docker\(\['stop'/);
  assert.match(verifier, /CHAT_PROVIDER_UNAVAILABLE/);
  assert.match(verifier, /function parseSse/);
  assert.match(verifier, /assertSuccessfulStream/);
  assert.match(verifier, /assertFailedClosedStream/);
  assert.match(verifier, /doesNotMatch\([^\n]+REMOTE_PROVIDER_VERIFIED/);
  assert.match(verifier, /docker\(\['start'/);
  assert.match(verifier, /compose\(\['restart', 'mongodb', 'backend'\]\)/);
  assert.match(verifier, /cleanupAuthorized = false/);
  assert.match(verifier, /if \(cleanupAuthorized\)/);
  assert.match(verifier, /protectedVolumes/);
  assert.match(verifier, /com\.docker\.compose\.project/);
  assert.match(verifier, /--entrypoint', 'mongosh'/);
  assert.doesNotMatch(verifier, /compose\(\['exec'/);
  assert.doesNotMatch(verifier, /down[^\n]*(?:-v|--volumes)|system[^\n]+prune/);
  assert.doesNotMatch(verifier, /docker-compose\.production\.acceptance\.yml/);
});

test('hybrid verifier is exposed as a production command and merge-gate contract', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(packageJson.scripts['production:verify:hybrid'], 'node scripts/verify-production-hybrid-live.cjs --allow-live-test');
  assert.match(packageJson.scripts['test:production'], /scripts\/production-hybrid\.test\.cjs/);
});
