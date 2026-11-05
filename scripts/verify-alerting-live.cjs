#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const NAMESPACE = 'kfive-observability';
const HARNESS = 'kfive-alert-receiver';

function kubectl(...args) {
  return execFileSync('kubectl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim();
}

function kubectlInput(input, ...args) {
  return execFileSync('kubectl', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim();
}

function exists(resource) {
  return spawnSync('kubectl', ['-n', NAMESPACE, 'get', resource, HARNESS], { encoding: 'utf8', stdio: 'ignore' }).status === 0;
}

function request(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 8088, path, timeout: 10_000, headers: { Host: 'kfive.local' } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '', body: Buffer.concat(chunks).toString('utf8') }));
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

async function query(expression) { return prometheus(`/api/v1/query?query=${encodeURIComponent(expression)}`); }

async function alertRule() {
  const groups = (await prometheus('/api/v1/rules?type=alert')).groups || [];
  const rule = groups.flatMap((group) => group.rules || []).find((candidate) => candidate.name === 'KFiveBackendUnavailable');
  assert.ok(rule, 'KFiveBackendUnavailable rule was not loaded');
  assert.equal(rule.health, 'ok');
  return rule;
}

function renderedBaseline() {
  const documents = yaml.loadAll(kubectl('kustomize', 'k8s/observability')).filter(Boolean);
  return documents.find((document) => document.kind === 'ConfigMap' && document.metadata?.name === 'alertmanager-config').data['alertmanager.yml'];
}

function receiverScript() {
  return `'use strict';
const fs = require('node:fs');
const http = require('node:http');
const expected = fs.readFileSync('/receiver-secret/token', 'utf8').trim();
const events = [];
function authorized(req) { return req.headers.authorization === 'Bearer ' + expected; }
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (!authorized(req)) { res.writeHead(401); res.end(); return; }
  if (req.method === 'GET' && req.url === '/events') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(events)); return; }
  if (req.method !== 'POST' || req.url !== '/alerts') { res.writeHead(404); res.end(); return; }
  let size = 0; const chunks = [];
  req.on('data', (chunk) => { size += chunk.length; if (size > 65536) req.destroy(); else chunks.push(chunk); });
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const alerts = Array.isArray(body.alerts) ? body.alerts.slice(0, 4) : [];
      events.push({ receiver: body.receiver, status: body.status, alerts: alerts.map((alert) => ({ status: alert.status, endsAt: alert.endsAt, fingerprint: alert.fingerprint, alertname: alert.labels?.alertname, severity: alert.labels?.severity, component: alert.labels?.component })) });
      if (events.length > 20) events.shift();
      res.writeHead(200); res.end('ok');
    } catch { res.writeHead(400); res.end(); }
  });
}).listen(8080, '0.0.0.0');`;
}

function harnessResources(token) {
  const labels = { 'app.kubernetes.io/name': HARNESS, 'app.kubernetes.io/part-of': 'kfive-test' };
  return { apiVersion: 'v1', kind: 'List', items: [
    { apiVersion: 'v1', kind: 'Secret', metadata: { name: HARNESS, namespace: NAMESPACE }, type: 'Opaque', data: { token: Buffer.from(token).toString('base64') } },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: HARNESS, namespace: NAMESPACE }, data: { 'server.cjs': receiverScript() } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: HARNESS, namespace: NAMESPACE, labels }, spec: { type: 'ClusterIP', selector: labels, ports: [{ name: 'http', port: 8080, targetPort: 'http' }] } },
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: HARNESS, namespace: NAMESPACE, labels }, spec: {
      podSelector: { matchLabels: labels }, policyTypes: ['Ingress'], ingress: [{
        from: [{ podSelector: { matchLabels: { 'app.kubernetes.io/name': 'alertmanager' } } }],
        ports: [{ protocol: 'TCP', port: 8080 }],
      }],
    } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: HARNESS, namespace: NAMESPACE, labels }, spec: { replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{ name: 'receiver', image: 'kfive-ai-backend:latest', imagePullPolicy: 'IfNotPresent', command: ['node', '/receiver/server.cjs'], ports: [{ name: 'http', containerPort: 8080 }],
        readinessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 2 }, livenessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 10 },
        resources: { requests: { cpu: '10m', memory: '24Mi' }, limits: { cpu: '100m', memory: '64Mi' } },
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        volumeMounts: [{ name: 'script', mountPath: '/receiver', readOnly: true }, { name: 'secret', mountPath: '/receiver-secret', readOnly: true }, { name: 'tmp', mountPath: '/tmp' }] }],
      volumes: [{ name: 'script', configMap: { name: HARNESS } }, { name: 'secret', secret: { secretName: HARNESS } }, { name: 'tmp', emptyDir: { sizeLimit: '8Mi' } }],
    } } } },
  ] };
}

function deliveryConfig(receiverName) {
  return yaml.dump({
    global: { resolve_timeout: '1m' },
    route: { receiver: 'null', group_by: ['alertname', 'component'], group_wait: '1s', group_interval: '5s', repeat_interval: '12h', routes: [{ receiver: receiverName, matchers: ['alertname="KFiveBackendUnavailable"'] }] },
    receivers: [{ name: 'null' }, { name: receiverName, webhook_configs: [{
      url: `http://${HARNESS}.${NAMESPACE}.svc.cluster.local:8080/alerts`, send_resolved: true, max_alerts: 1,
      http_config: { authorization: { type: 'Bearer', credentials_file: '/receiver-secret/token' } },
    }] }],
  }, { lineWidth: -1, noRefs: true });
}

function patchAlertmanagerConfig(config) {
  kubectl('-n', NAMESPACE, 'patch', 'configmap/alertmanager-config', '--type=merge', '-p', JSON.stringify({ data: { 'alertmanager.yml': config } }));
}

function restartAlertmanager() {
  kubectl('-n', NAMESPACE, 'rollout', 'restart', 'deployment/alertmanager');
  kubectl('-n', NAMESPACE, 'rollout', 'status', 'deployment/alertmanager', '--timeout=240s');
}

function removeReceiverSecretMount() {
  kubectl('-n', NAMESPACE, 'patch', 'deployment/alertmanager', '--type=strategic', '-p', JSON.stringify({ spec: { template: { spec: {
    containers: [{ name: 'alertmanager', volumeMounts: [{ name: 'receiver-secret', mountPath: '/receiver-secret', $patch: 'delete' }] }],
    volumes: [{ name: 'receiver-secret', $patch: 'delete' }],
  } } } }));
}

function assertReceiverSecretMountAbsent() {
  const deployment = JSON.parse(kubectl('-n', NAMESPACE, 'get', 'deployment/alertmanager', '-o', 'json'));
  const pod = deployment.spec.template.spec;
  const container = pod.containers.find((candidate) => candidate.name === 'alertmanager');
  assert.ok(container, 'Alertmanager container missing');
  assert.equal((container.volumeMounts || []).some((mount) => mount.name === 'receiver-secret'), false,
    'temporary receiver Secret mount remains on Alertmanager');
  assert.equal((pod.volumes || []).some((volume) => volume.name === 'receiver-secret'), false,
    'temporary receiver Secret volume remains on Alertmanager');
}

async function activeAlertmanager() {
  await retry(async () => {
    const targets = await prometheus('/api/v1/alertmanagers');
    assert.ok((targets.activeAlertmanagers || []).some((target) => /alertmanager.*:9093/.test(target.url)));
  });
}

function receiverEvents() {
  const program = "const fs=require('fs');fetch('http://127.0.0.1:8080/events',{headers:{authorization:'Bearer '+fs.readFileSync('/receiver-secret/token','utf8').trim()}}).then(async r=>{if(!r.ok)throw Error(String(r.status));console.log(await r.text())})";
  return JSON.parse(kubectl('-n', NAMESPACE, 'exec', `deployment/${HARNESS}`, '--', 'node', '-e', program));
}

async function main() {
  if (!process.argv.includes('--allow-live-test')) throw new Error('Refusing to scale disposable kind workloads without --allow-live-test.');
  assert.equal(kubectl('config', 'current-context'), 'kind-kfive');
  assert.equal(kubectl('-n', 'kfive', 'get', 'deployment/backend', '-o', 'jsonpath={.spec.replicas}'), '1');
  for (const resource of ['secret', 'configmap', 'service', 'deployment', 'networkpolicy']) assert.equal(exists(resource), false, `Refusing to replace pre-existing ${resource}/${HARNESS}`);

  const baseline = renderedBaseline().trim();
  const liveBaseline = kubectl('-n', NAMESPACE, 'get', 'configmap/alertmanager-config', '-o', 'jsonpath={.data.alertmanager\\.yml}');
  assert.equal(liveBaseline, baseline, 'Alertmanager must start from the rendered null-receiver baseline');
  const baselineHash = crypto.createHash('sha256').update(baseline).digest('hex');
  const pvcUid = kubectl('-n', NAMESPACE, 'get', 'pvc/alertmanager-data', '-o', 'jsonpath={.metadata.uid}');
  assert.equal(kubectl('-n', NAMESPACE, 'get', 'service/alertmanager', '-o', 'jsonpath={.spec.type}'), 'ClusterIP');
  assert.equal(kubectl('-n', NAMESPACE, 'get', 'service/alertmanager', '-o', 'jsonpath={.spec.ports[0].port}'), '9093');
  assertReceiverSecretMountAbsent();

  const publicStatus = await request('/alertmanager/api/v2/status');
  assert.equal(publicStatus.status, 200);
  assert.match(publicStatus.contentType, /^text\/html/);
  assert.doesNotMatch(publicStatus.body, /KFiveBackendUnavailable|alertmanagerConfig/);
  await activeAlertmanager();
  await retry(async () => {
    assert.equal((await alertRule()).state, 'inactive');
    assert.ok((await query('up{job="kfive-backend"}')).result.some((series) => series.value?.[1] === '1'));
  });

  const marker = `kfive-test-${crypto.randomBytes(8).toString('hex')}`;
  const token = crypto.randomBytes(32).toString('hex');
  let harnessCreated = false;
  let backendScaled = false;
  let firingObservedAt;
  let resolvedObservedAt;
  let firingFingerprint;
  let scenarioError;
  try {
    kubectlInput(JSON.stringify(harnessResources(token)), 'apply', '-f', '-');
    harnessCreated = true;
    kubectl('-n', NAMESPACE, 'rollout', 'status', `deployment/${HARNESS}`, '--timeout=240s');
    assert.equal(kubectl('-n', NAMESPACE, 'get', `service/${HARNESS}`, '-o', 'jsonpath={.spec.type}'), 'ClusterIP');

    kubectl('-n', NAMESPACE, 'patch', 'deployment/alertmanager', '--type=strategic', '-p', JSON.stringify({ spec: { template: { spec: {
      containers: [{ name: 'alertmanager', volumeMounts: [{ name: 'receiver-secret', mountPath: '/receiver-secret', readOnly: true }] }],
      volumes: [{ name: 'receiver-secret', secret: { secretName: HARNESS } }],
    } } } }));
    patchAlertmanagerConfig(deliveryConfig(marker));
    restartAlertmanager();
    await activeAlertmanager();

    kubectl('-n', NAMESPACE, 'scale', 'deployment/alertmanager', '--replicas=0');
    await retry(() => assert.equal(kubectl('-n', NAMESPACE, 'get', 'deployment/alertmanager', '-o', 'jsonpath={.status.replicas}'), ''), 60);
    kubectl('-n', 'kfive', 'scale', 'deployment/backend', '--replicas=0');
    backendScaled = true;
    await retry(async () => {
      const rule = await alertRule();
      assert.equal(rule.state, 'firing');
      assert.equal(rule.labels.severity, 'critical');
      assert.ok((await query('ALERTS{alertname="KFiveBackendUnavailable",alertstate="firing"}')).result.length > 0);
    });

    kubectl('-n', NAMESPACE, 'scale', 'deployment/alertmanager', '--replicas=1');
    kubectl('-n', NAMESPACE, 'rollout', 'status', 'deployment/alertmanager', '--timeout=240s');
    await activeAlertmanager();
    await retry(() => {
      const alerts = receiverEvents().filter((event) => event.receiver === marker && event.status === 'firing');
      const delivered = alerts.flatMap((event) => event.alerts).find((alert) => alert.status === 'firing' && alert.alertname === 'KFiveBackendUnavailable' && alert.severity === 'critical' && alert.component === 'backend');
      assert.match(delivered?.fingerprint || '', /^[0-9a-f]+$/);
      firingFingerprint = delivered.fingerprint;
      firingObservedAt = new Date().toISOString();
    });

    kubectl('-n', 'kfive', 'scale', 'deployment/backend', '--replicas=1');
    kubectl('-n', 'kfive', 'rollout', 'status', 'deployment/backend', '--timeout=240s');
    backendScaled = false;
    await retry(async () => {
      assert.equal((await alertRule()).state, 'inactive');
      assert.equal((await query('ALERTS{alertname="KFiveBackendUnavailable"}')).result.length, 0);
      const events = receiverEvents().filter((event) => event.receiver === marker && event.status === 'resolved');
      assert.ok(events.some((event) => event.alerts.some((alert) => alert.status === 'resolved' && alert.alertname === 'KFiveBackendUnavailable' && alert.fingerprint === firingFingerprint && Date.parse(alert.endsAt) > 0)));
      resolvedObservedAt = new Date().toISOString();
    });
  } catch (error) {
    scenarioError = error;
  } finally {
    const cleanupErrors = [];
    if (backendScaled) {
      try { kubectl('-n', 'kfive', 'scale', 'deployment/backend', '--replicas=1'); kubectl('-n', 'kfive', 'rollout', 'status', 'deployment/backend', '--timeout=240s'); } catch (error) { cleanupErrors.push(error); }
    }
    try {
      kubectl('apply', '-k', 'k8s/observability');
      removeReceiverSecretMount();
      restartAlertmanager();
      assertReceiverSecretMountAbsent();
    } catch (error) { cleanupErrors.push(error); }
    if (harnessCreated) {
      try { kubectl('-n', NAMESPACE, 'delete', 'deployment,service,configmap,secret,networkpolicy', HARNESS, '--ignore-not-found=true', '--wait=true'); } catch (error) { cleanupErrors.push(error); }
    }
    if (!scenarioError && cleanupErrors.length) scenarioError = cleanupErrors[0];
  }

  if (scenarioError) throw scenarioError;
  for (const resource of ['secret', 'configmap', 'service', 'deployment', 'networkpolicy']) assert.equal(exists(resource), false);
  const restored = kubectl('-n', NAMESPACE, 'get', 'configmap/alertmanager-config', '-o', 'jsonpath={.data.alertmanager\\.yml}');
  assert.equal(crypto.createHash('sha256').update(restored).digest('hex'), baselineHash);
  assert.equal(kubectl('-n', NAMESPACE, 'get', 'pvc/alertmanager-data', '-o', 'jsonpath={.metadata.uid}'), pvcUid);
  assertReceiverSecretMountAbsent();
  await activeAlertmanager();
  await retry(async () => { assert.equal((await alertRule()).state, 'inactive'); assert.equal((await query('ALERTS{alertname="KFiveBackendUnavailable"}')).result.length, 0); });
  const health = await request('/api/v1/health');
  assert.equal(health.status, 200, health.body);
  console.log(JSON.stringify({ rule: 'KFiveBackendUnavailable', alertmanager: 'active/private', receiverAuthentication: 'bearer-file', firingObservedAt, resolvedObservedAt, correlatedFingerprint: true, outageRecovery: true, sendResolved: true, baselineRestored: true, receiverRemoved: true, pvcUidUnchanged: true, backendRestored: true, prometheusExposure: 'ClusterIP only', alertmanagerExposure: 'ClusterIP only' }, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });

module.exports = { deliveryConfig, harnessResources, receiverScript };
