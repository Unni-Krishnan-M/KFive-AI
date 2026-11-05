#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');

if (!process.argv.includes('--allow-live-test')) {
  console.error('Refusing to restart the disposable kind Fluent Bit DaemonSet without --allow-live-test.');
  process.exit(2);
}

function kubectl(...args) {
  return execFileSync('kubectl', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function canI(...args) {
  const result = spawnSync('kubectl', ['auth', 'can-i', ...args,
    '--as=system:serviceaccount:kfive-observability:fluent-bit'], { encoding: 'utf8' });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr || `kubectl auth can-i exited ${result.status}`);
  }
  return result.stdout.trim();
}

function request(marker) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 8088, path: '/api/v1/health', timeout: 10_000,
      headers: { Host: 'kfive.local', 'X-Request-ID': marker },
    }, (res) => {
      res.resume();
      res.once('end', () => res.statusCode === 200
        ? resolve() : reject(new Error(`Health request returned ${res.statusCode}`)));
    });
    req.once('timeout', () => req.destroy(new Error('Health request timed out')));
    req.once('error', reject);
    req.end();
  });
}

function records() {
  return kubectl('-n', 'kfive-observability', 'logs', 'daemonset/fluent-bit', '--since=45s')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
}

async function retry(action, attempts = 20) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return action(); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw lastError;
}

async function assertMarker(marker) {
  await request(marker);
  return retry(() => {
    const output = records();
    assert.ok(output.length > 0, 'Fluent Bit emitted no JSON records.');
    assert.ok(output.every((record) => record.kubernetes?.namespace_name === 'kfive'));
    assert.ok(output.every((record) => record.kubernetes?.container_name !== 'fluent-bit'));
    const backend = output.find((record) => record.structured?.requestId === marker);
    assert.ok(backend, `Missing backend marker ${marker}.`);
    assert.equal(backend.structured.service, 'kfive-ai-backend');
    assert.equal(backend.structured.path, '/api/v1/health');
    assert.equal(backend.kubernetes.namespace_name, 'kfive');
    assert.equal(backend.kubernetes.container_name, 'backend');
    assert.equal(backend.kubernetes.labels['app.kubernetes.io/part-of'], 'kfive');
    assert.equal(backend.stream, 'stdout');
    assert.ok(output.some((record) => record.kubernetes?.container_name === 'traefik'
      && record.structured?.RequestPath === '/api/v1/health'));
    return backend;
  });
}

async function main() {
  assert.equal(kubectl('config', 'current-context'), 'kind-kfive');
  const daemonSet = JSON.parse(kubectl('-n', 'kfive-observability', 'get', 'daemonset/fluent-bit', '-o', 'json'));
  const podTemplate = daemonSet.spec.template.spec;
  const container = podTemplate.containers[0];
  assert.equal(container.image, 'fluent/fluent-bit:5.1.2');
  assert.ok(container.volumeMounts.filter((mount) => ['container-logs', 'pod-logs'].includes(mount.name))
    .every((mount) => mount.readOnly === true));
  assert.deepEqual(podTemplate.volumes.find((volume) => volume.name === 'state').emptyDir.sizeLimit, '64Mi');
  const imageId = kubectl('-n', 'kfive-observability', 'get', 'pods', '-l', 'app.kubernetes.io/name=fluent-bit',
    '-o', 'jsonpath={.items[0].status.containerStatuses[0].imageID}');
  assert.match(imageId, /@sha256:[a-f0-9]{64}$/);

  assert.equal(canI('get', 'pods', '-n', 'kfive'), 'yes');
  assert.equal(canI('list', 'pods', '-n', 'kfive'), 'yes');
  assert.equal(canI('get', 'secrets', '-n', 'kfive'), 'no');
  assert.equal(canI('get', 'pods', '-n', 'kfive-observability'), 'no');
  const service = spawnSync('kubectl', ['-n', 'kfive-observability', 'get', 'service', 'fluent-bit'],
    { encoding: 'utf8' });
  assert.notEqual(service.status, 0, 'Fluent Bit must not have a Service.');

  const first = await assertMarker(`fluent-bit-before-${Date.now()}`);
  const uidBefore = kubectl('-n', 'kfive-observability', 'get', 'pods', '-l', 'app.kubernetes.io/name=fluent-bit',
    '-o', 'jsonpath={.items[0].metadata.uid}');
  kubectl('-n', 'kfive-observability', 'rollout', 'restart', 'daemonset/fluent-bit');
  kubectl('-n', 'kfive-observability', 'rollout', 'status', 'daemonset/fluent-bit', '--timeout=240s');
  const uidAfter = kubectl('-n', 'kfive-observability', 'get', 'pods', '-l', 'app.kubernetes.io/name=fluent-bit',
    '-o', 'jsonpath={.items[0].metadata.uid}');
  assert.notEqual(uidAfter, uidBefore);
  const second = await assertMarker(`fluent-bit-after-${Date.now()}`);

  console.log(JSON.stringify({
    image: container.image, imageId, rbac: 'namespace-scoped', serviceExposure: 'none',
    firstMarker: first.structured.requestId, restartCollection: second.structured.requestId,
    jsonParsing: 'passed', kubernetesMetadata: 'passed', namespaceBoundary: 'passed',
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
