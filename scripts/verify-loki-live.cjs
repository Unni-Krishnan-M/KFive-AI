#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');

if (!process.argv.includes('--allow-live-test')) {
  console.error('Refusing to restart disposable kind logging workloads without --allow-live-test.');
  process.exit(2);
}

function kubectl(...args) {
  return execFileSync('kubectl', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function exists(...args) {
  try { kubectl(...args); return true; } catch { return false; }
}

function canI(...args) {
  const result = spawnSync('kubectl', ['auth', 'can-i', ...args,
    '--as=system:serviceaccount:kfive-observability:default'], { encoding: 'utf8' });
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || `kubectl auth can-i exited ${result.status}`);
  return result.stdout.trim();
}

function request(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 8088, path, timeout: 10_000,
      headers: { Host: 'kfive.local', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('timeout', () => req.destroy(new Error(`Request timed out: ${path}`)));
    req.once('error', reject);
    req.end();
  });
}

async function retry(action, attempts = 60, delayMs = 1_000) {
  let error;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(); } catch (caught) { error = caught; }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw error;
}

function queryPath(expression, startMs) {
  const start = String(BigInt(startMs) * 1_000_000n);
  const end = String(BigInt(Date.now() + 5_000) * 1_000_000n);
  return `/grafana/api/datasources/proxy/uid/kfive-loki/loki/api/v1/query_range?query=${encodeURIComponent(expression)}&start=${start}&end=${end}&limit=100&direction=backward`;
}

async function lokiQuery(expression, startMs) {
  const response = await request(queryPath(expression, startMs));
  assert.equal(response.status, 200, response.body);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.status, 'success', response.body);
  return parsed.data.result;
}

async function markerRecord(marker, startMs) {
  return retry(async () => {
    const result = await lokiQuery(`{namespace="kfive",container="backend"} |= ${JSON.stringify(marker)}`, startMs);
    assert.ok(result.length > 0, `Loki has not indexed ${marker}`);
    for (const stream of result) {
      assert.deepEqual(Object.keys(stream.stream).sort(), ['container', 'job', 'namespace']);
      assert.equal(stream.stream.namespace, 'kfive');
      assert.equal(stream.stream.container, 'backend');
      for (const [, line] of stream.values) {
        const record = JSON.parse(line);
        if (record.structured?.requestId === marker) return record;
      }
    }
    assert.fail(`No structured backend record matched ${marker}`);
  });
}

async function streamMarker(container, marker, startMs) {
  return retry(async () => {
    const result = await lokiQuery(
      `{namespace="kfive",container=${JSON.stringify(container)}} |= ${JSON.stringify(marker)}`,
      startMs,
    );
    assert.ok(result.some((stream) => stream.values.some(([, line]) => line.includes(marker))),
      `Loki has not indexed ${container} watermark ${marker}`);
  });
}

async function emitMarker(marker, path = '/api/v1/health', headers = {}) {
  const response = await request(path, { 'X-Request-ID': marker, ...headers });
  assert.equal(response.status, 200, response.body);
}

function podUid(name) {
  return kubectl('-n', 'kfive-observability', 'get', 'pods', '-l', `app.kubernetes.io/name=${name}`,
    '-o', 'jsonpath={.items[0].metadata.uid}');
}

async function main() {
  assert.equal(kubectl('config', 'current-context'), 'kind-kfive');
  const startedAt = Date.now() - 10_000;
  const pvcUid = kubectl('-n', 'kfive-observability', 'get', 'pvc/loki-data', '-o', 'jsonpath={.metadata.uid}');
  assert.equal(kubectl('-n', 'kfive-observability', 'get', 'pvc/loki-data', '-o', 'jsonpath={.status.phase}'), 'Bound');
  assert.equal(kubectl('-n', 'kfive-observability', 'get', 'service/loki', '-o', 'jsonpath={.spec.type}'), 'ClusterIP');
  const image = kubectl('-n', 'kfive-observability', 'get', 'deployment/loki', '-o', 'jsonpath={.spec.template.spec.containers[0].image}');
  const imageId = kubectl('-n', 'kfive-observability', 'get', 'pods', '-l', 'app.kubernetes.io/name=loki',
    '-o', 'jsonpath={.items[0].status.containerStatuses[0].imageID}');
  assert.equal(image, 'grafana/loki:3.7.8');
  assert.match(imageId, /@sha256:[a-f0-9]{64}$/);
  assert.equal(kubectl('-n', 'kfive-observability', 'get', 'deployment/loki',
    '-o', 'jsonpath={.spec.template.spec.automountServiceAccountToken}'), 'false');

  const publicLoki = await request('/loki/api/v1/status/buildinfo');
  assert.equal(publicLoki.status, 200);
  assert.match(publicLoki.headers['content-type'] || '', /^text\/html/);
  assert.doesNotMatch(publicLoki.body, /"version"\s*:/);

  await retry(async () => {
    const response = await request('/grafana/api/datasources/uid/kfive-loki');
    assert.equal(response.status, 200, response.body);
    const datasource = JSON.parse(response.body);
    assert.equal(datasource.type, 'loki');
    assert.equal(datasource.url, 'http://loki:3100');
    assert.equal(datasource.readOnly, true);
  });

  const firstMarker = `loki-before-${Date.now()}`;
  await emitMarker(firstMarker);
  const first = await markerRecord(firstMarker, startedAt);
  assert.equal(first.structured.service, 'kfive-ai-backend');
  assert.equal(first.structured.path, '/api/v1/health');
  assert.match(first.kubernetes.pod_name, /^backend-/);
  assert.match(first.kubernetes.docker_id, /^[a-f0-9]{64}$/);
  assert.equal(first.kubernetes.labels, undefined);
  assert.equal(first.kubernetes.container_image, undefined);

  const secretMarker = `must-not-log-${Date.now()}`;
  await emitMarker(`loki-redaction-${Date.now()}`, `/api/v1/health?token=${secretMarker}`, {
    Authorization: `Bearer ${secretMarker}`,
  });
  const redactionWatermark = `loki-redaction-watermark-${Date.now()}`;
  await emitMarker(redactionWatermark);
  await markerRecord(redactionWatermark, startedAt);
  const traefikWatermark = `loki-watermark-${Date.now()}.invalid`;
  const watermarkResponse = await request('/api/v1/health', { Host: traefikWatermark });
  assert.equal(watermarkResponse.status, 404, watermarkResponse.body);
  await streamMarker('traefik', traefikWatermark, startedAt);
  assert.deepEqual(await lokiQuery(`{namespace="kfive"} |= ${JSON.stringify(secretMarker)}`, startedAt), []);

  const lokiUidBefore = podUid('loki');
  kubectl('-n', 'kfive-observability', 'rollout', 'restart', 'deployment/loki');
  kubectl('-n', 'kfive-observability', 'rollout', 'status', 'deployment/loki', '--timeout=240s');
  assert.notEqual(podUid('loki'), lokiUidBefore);
  assert.equal(kubectl('-n', 'kfive-observability', 'get', 'pvc/loki-data', '-o', 'jsonpath={.metadata.uid}'), pvcUid);
  await markerRecord(firstMarker, startedAt);

  const outageMarker = `loki-outage-${Date.now()}`;
  kubectl('-n', 'kfive-observability', 'scale', 'deployment/loki', '--replicas=0');
  try {
    await retry(() => {
      assert.equal(kubectl('-n', 'kfive-observability', 'get', 'deployment/loki',
        '-o', 'jsonpath={.status.replicas}'), '');
    }, 30);
    await emitMarker(outageMarker);
  } finally {
    kubectl('-n', 'kfive-observability', 'scale', 'deployment/loki', '--replicas=1');
    kubectl('-n', 'kfive-observability', 'rollout', 'status', 'deployment/loki', '--timeout=240s');
  }
  await markerRecord(outageMarker, startedAt);

  const fluentUidBefore = podUid('fluent-bit');
  kubectl('-n', 'kfive-observability', 'rollout', 'restart', 'daemonset/fluent-bit');
  kubectl('-n', 'kfive-observability', 'rollout', 'status', 'daemonset/fluent-bit', '--timeout=240s');
  assert.notEqual(podUid('fluent-bit'), fluentUidBefore);
  const afterCollectorMarker = `loki-after-collector-${Date.now()}`;
  await emitMarker(afterCollectorMarker);
  await markerRecord(afterCollectorMarker, startedAt);
  await markerRecord(firstMarker, startedAt);

  assert.equal(kubectl('-n', 'kfive-observability', 'get', 'daemonset/fluent-bit',
    '-o', 'jsonpath={.spec.template.spec.automountServiceAccountToken}'), 'false');
  assert.equal(kubectl('-n', 'kfive-observability', 'get', 'daemonset/fluent-bit',
    '-o', 'jsonpath={.spec.template.spec.serviceAccountName}'), 'default');
  assert.equal(exists('-n', 'kfive-observability', 'get', 'serviceaccount/fluent-bit'), false);
  assert.equal(exists('-n', 'kfive', 'get', 'role/kfive-fluent-bit'), false);
  assert.equal(exists('-n', 'kfive', 'get', 'rolebinding/kfive-fluent-bit'), false);
  assert.equal(canI('list', 'pods', '-n', 'kfive'), 'no');
  assert.equal(canI('get', 'secrets', '-n', 'kfive'), 'no');
  assert.equal(canI('get', 'pods', '-n', 'kfive-observability'), 'no');

  console.log(JSON.stringify({
    image, imageId, serviceExposure: 'ClusterIP only', grafanaDatasource: 'kfive-loki',
    firstMarker, lokiRestartPersistence: true, pvcUidUnchanged: true,
    bufferedSinkOutageMarker: outageMarker, collectorRestartMarker: afterCollectorMarker,
    structuredJson: true, boundedLabels: ['container', 'job', 'namespace'],
    sensitiveHeaderAndQueryMarkerAbsent: true,
    redactionIngestionWatermarks: ['backend', 'traefik'],
    kubernetesMetadata: 'tag-derived; no API token or RBAC',
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
