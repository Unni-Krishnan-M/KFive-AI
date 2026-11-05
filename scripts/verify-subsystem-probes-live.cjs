#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

if (!process.argv.includes('--allow-live-test')) {
  console.error('Refusing to scale the disposable kind ChromaDB without --allow-live-test.');
  process.exit(2);
}

function kubectl(...args) {
  return execFileSync('kubectl', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function request(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 8088, path, timeout: 10_000, headers: { Host: 'kfive.local' },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode,
        contentType: res.headers['content-type'] || '', body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('timeout', () => req.destroy(new Error(`Request timed out: ${path}`)));
    req.once('error', reject);
    req.end();
  });
}

async function retry(action, attempts = 180, delayMs = 1_000) {
  let error;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(); } catch (caught) { error = caught; }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw error;
}

async function prometheus(path) {
  const response = await request(`/grafana/api/datasources/proxy/uid/kfive-prometheus${path}`);
  assert.equal(response.status, 200, response.body);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.status, 'success', response.body);
  return parsed.data;
}

async function query(expression) {
  return prometheus(`/api/v1/query?query=${encodeURIComponent(expression)}`);
}

async function probeStates() {
  const data = await query('kfive_subsystem_probe_success');
  return Object.fromEntries(data.result.map((series) => [series.metric.dependency, Number(series.value[1])]));
}

async function subsystemRule() {
  const groups = (await prometheus('/api/v1/rules?type=alert')).groups || [];
  const rule = groups.flatMap((group) => group.rules || [])
    .find((candidate) => candidate.name === 'KFiveSubsystemUnavailable');
  assert.ok(rule, 'KFiveSubsystemUnavailable rule was not loaded');
  assert.equal(rule.health, 'ok');
  return rule;
}

async function main() {
  assert.equal(kubectl('config', 'current-context'), 'kind-kfive');
  assert.equal(kubectl('-n', 'kfive', 'get', 'statefulset/chromadb', '-o', 'jsonpath={.spec.replicas}'), '1');
  assert.equal(kubectl('-n', 'kfive-observability', 'get', 'service/subsystem-prober', '-o', 'jsonpath={.spec.type}'), 'ClusterIP');
  const pvcUid = kubectl('-n', 'kfive', 'get', 'pvc/chromadb-data', '-o', 'jsonpath={.metadata.uid}');

  const publicMetrics = await request('/subsystem-prober/metrics');
  assert.equal(publicMetrics.status, 200);
  assert.match(publicMetrics.contentType, /^text\/html/);
  assert.doesNotMatch(publicMetrics.body, /kfive_subsystem_probe_success/);

  const dashboardResponse = await request('/grafana/api/dashboards/uid/kfive-overview');
  assert.equal(dashboardResponse.status, 200, dashboardResponse.body);
  const dashboard = JSON.parse(dashboardResponse.body).dashboard;
  const panel = dashboard.panels.find((candidate) => candidate.title === 'Independent subsystem probes');
  assert.equal(panel.targets[0].expr, 'kfive_subsystem_probe_success');

  await retry(async () => {
    assert.deepEqual(await probeStates(), { chromadb: 1, mongodb: 1, redis: 1 });
    assert.equal((await subsystemRule()).state, 'inactive');
    const up = await query('up{job="kfive-subsystem-probes"}');
    assert.ok(up.result.some((series) => series.value?.[1] === '1'));
  });

  let firingObservedAt;
  let chromaScaled = false;
  kubectl('-n', 'kfive', 'scale', 'statefulset/chromadb', '--replicas=0');
  chromaScaled = true;
  try {
    await retry(() => assert.match(kubectl('-n', 'kfive', 'get', 'statefulset/chromadb',
      '-o', 'jsonpath={.status.replicas}'), /^(?:|0)$/), 60);
    await retry(async () => {
      assert.deepEqual(await probeStates(), { chromadb: 0, mongodb: 1, redis: 1 });
      const rule = await subsystemRule();
      assert.equal(rule.state, 'firing');
      const alerts = await query('ALERTS{alertname="KFiveSubsystemUnavailable",alertstate="firing",dependency="chromadb"}');
      assert.ok(alerts.result.length > 0);
      firingObservedAt = new Date().toISOString();
    });
  } finally {
    if (chromaScaled) {
      kubectl('-n', 'kfive', 'scale', 'statefulset/chromadb', '--replicas=1');
      kubectl('-n', 'kfive', 'rollout', 'status', 'statefulset/chromadb', '--timeout=240s');
    }
  }

  await retry(async () => {
    assert.deepEqual(await probeStates(), { chromadb: 1, mongodb: 1, redis: 1 });
    assert.equal((await subsystemRule()).state, 'inactive');
    assert.equal((await query('ALERTS{alertname="KFiveSubsystemUnavailable"}')).result.length, 0);
  });
  assert.equal(kubectl('-n', 'kfive', 'get', 'pvc/chromadb-data', '-o', 'jsonpath={.metadata.uid}'), pvcUid);
  const health = await request('/api/v1/health');
  assert.equal(health.status, 200, health.body);

  console.log(JSON.stringify({
    probes: { mongodb: 'tcp/available', redis: 'tcp/available', chromadb: 'http/available' },
    alert: 'KFiveSubsystemUnavailable', firingDependency: 'chromadb', firingObservedAt,
    recovered: true, chromaRestored: true, chromaPvcUidUnchanged: true,
    proberExposure: 'ClusterIP only', publicMetricsDenied: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
