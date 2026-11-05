#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

if (!process.argv.includes('--allow-live-test')) {
  console.error('Refusing to restart the disposable kind observability deployment without --allow-live-test.');
  process.exit(2);
}

function request(path, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 8088, path, timeout,
      headers: { Host: 'kfive.local' },
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

function json(response) {
  return JSON.parse(response.body);
}

function kubectl(...args) {
  return execFileSync('kubectl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function podFetch(url) {
  const code = [
    "fetch(process.argv[1]).then(async response => {",
    "  const body = await response.text();",
    "  console.log(JSON.stringify({status: response.status, contentType: response.headers.get('content-type'), body}));",
    "  if (!response.ok) process.exitCode = 1;",
    "}).catch(error => { console.error(error.message); process.exit(1); });",
  ].join('\n');
  return JSON.parse(kubectl('-n', 'kfive', 'exec', 'deployment/backend', '--', 'node', '-e', code, url));
}

function podUid(namespace, name) {
  return kubectl('-n', namespace, 'get', 'pods', '-l', `app.kubernetes.io/name=${name}`,
    '-o', 'jsonpath={.items[0].metadata.uid}');
}

function assertRunningImage(namespace, name, expectedImage) {
  const deploymentImage = kubectl('-n', namespace, 'get', `deployment/${name}`,
    '-o', 'jsonpath={.spec.template.spec.containers[0].image}');
  const podImage = kubectl('-n', namespace, 'get', 'pods', '-l', `app.kubernetes.io/name=${name}`,
    '-o', 'jsonpath={.items[0].spec.containers[0].image}');
  const imageId = kubectl('-n', namespace, 'get', 'pods', '-l', `app.kubernetes.io/name=${name}`,
    '-o', 'jsonpath={.items[0].status.containerStatuses[0].imageID}');
  assert.equal(deploymentImage, expectedImage);
  assert.equal(podImage, expectedImage);
  assert.match(imageId, /@sha256:[a-f0-9]{64}$/);
  return imageId;
}

async function retry(action, attempts = 60, delayMs = 1_000) {
  let error;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(); } catch (caught) { error = caught; }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw error;
}

async function grafanaGet(path) {
  const response = await request(`/grafana${path}`);
  assert.equal(response.status, 200, response.body);
  return json(response);
}

async function prometheusQuery(expression, time) {
  const suffix = time === undefined ? '' : `&time=${encodeURIComponent(String(time))}`;
  const response = await request(`/grafana/api/datasources/proxy/uid/kfive-prometheus/api/v1/query?query=${encodeURIComponent(expression)}${suffix}`);
  assert.equal(response.status, 200, response.body);
  const parsed = json(response);
  assert.equal(parsed.status, 'success', response.body);
  return parsed.data.result;
}

async function assertProvisioning() {
  const health = await grafanaGet('/api/health');
  assert.equal(health.database, 'ok');
  const datasource = await grafanaGet('/api/datasources/uid/kfive-prometheus');
  assert.equal(datasource.uid, 'kfive-prometheus');
  assert.equal(datasource.url, 'http://prometheus:9090');
  assert.equal(datasource.access, 'proxy');
  const dashboard = await grafanaGet('/api/dashboards/uid/kfive-overview');
  assert.equal(dashboard.dashboard.uid, 'kfive-overview');
  assert.equal(dashboard.dashboard.title, 'KFive Overview');
  assert.equal(dashboard.dashboard.editable, false);
  for (const title of ['Subsystem availability', 'GPU probe availability', 'GPU VRAM utilization', 'GPU temperature']) {
    assert.ok(dashboard.dashboard.panels.some((panel) => panel.title === title), `missing dashboard panel: ${title}`);
  }
}

async function assertSubsystemTelemetry() {
  for (const dependency of ['mongodb', 'redis']) {
    const result = await prometheusQuery(`kfive_dependency_available{dependency="${dependency}"}`);
    assert.equal(result.length, 1);
    assert.equal(result[0].value[1], '1');
  }
  const available = await prometheusQuery('kfive_gpu_probe_available');
  assert.equal(available.length, 1);
  assert.equal(available[0].value[1], '0');
  const devices = await prometheusQuery('kfive_gpu_devices');
  assert.equal(devices.length, 1);
  assert.equal(devices[0].value[1], '0');
  const reason = await prometheusQuery('kfive_gpu_probe_status{reason="nvidia-smi-not-found"}');
  assert.equal(reason.length, 1);
  assert.equal(reason[0].value[1], '1');
  assert.deepEqual(await prometheusQuery('kfive_gpu_temperature_celsius'), []);
}

async function main() {
  assert.equal(kubectl('config', 'current-context'), 'kind-kfive');
  assert.equal(kubectl('-n', 'kfive-observability', 'get', 'pvc', 'prometheus-data', '-o', 'jsonpath={.status.phase}'), 'Bound');
  assert.equal(kubectl('-n', 'kfive-observability', 'get', 'pvc', 'grafana-data', '-o', 'jsonpath={.status.phase}'), 'Bound');
  const prometheusImageId = assertRunningImage('kfive-observability', 'prometheus', 'prom/prometheus:v3.14.0');
  const grafanaImageId = assertRunningImage('kfive-observability', 'grafana', 'grafana/grafana:13.2.2');

  const internalMetrics = podFetch('http://127.0.0.1:5000/metrics');
  assert.equal(internalMetrics.status, 200);
  assert.match(internalMetrics.contentType, /^text\/plain;.*version=0\.0\.4/);
  assert.match(internalMetrics.body, /kfive_http_requests_total/);
  assert.match(internalMetrics.body, /process_resident_memory_bytes/);
  assert.match(internalMetrics.body, /kfive_dependency_available\{dependency="mongodb"\} 1/);
  assert.match(internalMetrics.body, /kfive_dependency_available\{dependency="redis"\} 1/);
  assert.match(internalMetrics.body, /kfive_gpu_probe_available 0/);
  assert.match(internalMetrics.body, /kfive_gpu_probe_status\{reason="nvidia-smi-not-found"\} 1/);
  assert.doesNotMatch(internalMetrics.body, /^kfive_gpu_temperature_celsius\{/m);

  const externalMetrics = await request('/metrics');
  assert.equal(externalMetrics.status, 200);
  assert.match(externalMetrics.headers['content-type'] || '', /^text\/html/);
  assert.doesNotMatch(externalMetrics.body, /kfive_http_requests_total/);

  for (let requestNumber = 0; requestNumber < 5; requestNumber += 1) {
    const response = await request('/api/v1/health');
    assert.equal(response.status, 200, response.body);
  }

  await retry(assertProvisioning);
  await retry(async () => {
    const result = await prometheusQuery('up{job="kfive-backend"}');
    assert.ok(result.some((series) => series.value?.[1] === '1'));
  });
  await retry(assertSubsystemTelemetry);

  const expression = 'sum(kfive_http_requests_total{method="GET",path="/api/v1/health",status_code="200"})';
  const before = await retry(async () => {
    const result = await prometheusQuery(expression);
    assert.equal(result.length, 1);
    assert.ok(Number(result[0].value[1]) >= 5);
    return result[0].value;
  });
  const sampleTime = Number(before[0]);
  const sampleValue = before[1];

  const prometheusUidBefore = podUid('kfive-observability', 'prometheus');
  kubectl('-n', 'kfive-observability', 'rollout', 'restart', 'deployment/prometheus');
  kubectl('-n', 'kfive-observability', 'rollout', 'status', 'deployment/prometheus', '--timeout=240s');
  const prometheusUidAfter = podUid('kfive-observability', 'prometheus');
  assert.notEqual(prometheusUidAfter, prometheusUidBefore);

  await retry(async () => {
    const historical = await prometheusQuery(expression, sampleTime);
    assert.equal(historical.length, 1);
    assert.equal(historical[0].value[1], sampleValue);
  });
  await retry(async () => {
    const result = await prometheusQuery('up{job="kfive-backend"}');
    assert.ok(result.some((series) => series.value?.[1] === '1'));
  });
  await retry(assertSubsystemTelemetry);

  const grafanaUidBefore = podUid('kfive-observability', 'grafana');
  const grafanaPersistenceMarker = `kfive-observability-${Date.now()}`;
  kubectl('-n', 'kfive-observability', 'exec', 'deployment/grafana', '--', 'sh', '-c',
    'printf %s "$1" > /var/lib/grafana/.kfive-live-persistence', 'sh', grafanaPersistenceMarker);
  kubectl('-n', 'kfive-observability', 'rollout', 'restart', 'deployment/grafana');
  kubectl('-n', 'kfive-observability', 'rollout', 'status', 'deployment/grafana', '--timeout=240s');
  const grafanaUidAfter = podUid('kfive-observability', 'grafana');
  assert.notEqual(grafanaUidAfter, grafanaUidBefore);
  assert.equal(kubectl('-n', 'kfive-observability', 'exec', 'deployment/grafana', '--',
    'cat', '/var/lib/grafana/.kfive-live-persistence'), grafanaPersistenceMarker);
  await retry(assertProvisioning);
  await retry(async () => {
    const result = await prometheusQuery('up{job="kfive-backend"}');
    assert.ok(result.some((series) => series.value?.[1] === '1'));
  });

  console.log(JSON.stringify({
    backendMetrics: 'passed', externalMetricsPrivate: 'passed', prometheusTarget: 'up',
    subsystemAvailability: { mongodb: 1, redis: 1 },
    gpuProbe: { available: 0, devices: 0, reason: 'nvidia-smi-not-found', perDeviceSeries: 0 },
    grafanaHealth: 'passed', datasource: 'kfive-prometheus', dashboard: 'kfive-overview',
    prometheusRestartHistoricalSample: { timestamp: sampleTime, value: sampleValue },
    grafanaRestartProvisioning: 'passed', grafanaRestartPersistentMarker: 'passed',
    images: { prometheus: prometheusImageId, grafana: grafanaImageId },
    persistentClaims: ['prometheus-data', 'grafana-data'],
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
