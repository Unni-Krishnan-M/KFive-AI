#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');

const CANARY = 'network-policy-canary';
const FOREIGN_NAMESPACE = 'kfive-network-policy-test';

if (!process.argv.includes('--allow-live-test')) {
  console.error('Refusing to create disposable network-policy probes without --allow-live-test.');
  process.exit(2);
}

function kubectl(...args) {
  return execFileSync('kubectl', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function kubectlApply(resource) {
  execFileSync('kubectl', ['apply', '-f', '-'], {
    input: JSON.stringify(resource), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function exists(...args) {
  try { kubectl(...args); return true; } catch { return false; }
}

function request(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 8088, path, timeout: 10_000,
      headers: { Host: 'kfive.local' },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: res.headers['content-type'] || '',
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

function uidSnapshot(namespace, kind) {
  const resources = JSON.parse(kubectl('-n', namespace, 'get', kind, '-o', 'json')).items;
  return Object.fromEntries(resources.map((resource) => [resource.metadata.name, resource.metadata.uid]));
}

function serviceIp(namespace, name) {
  return kubectl('-n', namespace, 'get', `service/${name}`, '-o', 'jsonpath={.spec.clusterIP}');
}

function probe(namespace, workload, host, port) {
  const program = [
    "const net=require('node:net');",
    "const socket=net.connect({host:process.argv[1],port:Number(process.argv[2])});",
    "const timer=setTimeout(()=>{console.log('KFive_PROBE_DENIED:timeout');socket.destroy();},1500);",
    "socket.once('connect',()=>{clearTimeout(timer);console.log('KFive_PROBE_ALLOWED');socket.destroy();});",
    "socket.once('error',()=>{clearTimeout(timer);console.log('KFive_PROBE_DENIED:error');});",
  ].join('');
  const result = spawnSync('kubectl', ['-n', namespace, 'exec', `deployment/${workload}`, '--',
    'node', '-e', program, host, String(port)], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `kubectl exec probe exited ${result.status}`);
  const output = result.stdout.trim();
  if (output === 'KFive_PROBE_ALLOWED') return true;
  if (/^KFive_PROBE_DENIED:(?:timeout|error)$/.test(output)) return false;
  throw new Error(`Unrecognized probe response from ${namespace}/${workload}: ${JSON.stringify(output)}`);
}

function assertCanaryAlive(namespace, workload) {
  assert.equal(kubectl('-n', namespace, 'exec', `deployment/${workload}`, '--',
    'node', '-e', "console.log('KFive_PROBE_ALIVE')"), 'KFive_PROBE_ALIVE');
}

function assertCanariesAbsent() {
  for (const namespace of ['kfive', 'kfive-observability']) {
    assert.equal(kubectl('-n', namespace, 'get', `deployment/${CANARY}`,
      '--ignore-not-found=true', '-o', 'name'), '');
  }
  assert.equal(kubectl('get', `namespace/${FOREIGN_NAMESPACE}`,
    '--ignore-not-found=true', '-o', 'name'), '');
}

async function assertRepeatedlyDenied(namespace, workload, targets) {
  for (let pass = 0; pass < 3; pass += 1) {
    for (const target of targets) {
      assert.equal(probe(namespace, workload, target.ip, target.port), false,
        `${namespace}/${workload} unexpectedly reached ${target.name}:${target.port}`);
    }
    assertCanaryAlive(namespace, workload);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

function canaryDeployment(namespace) {
  const labels = {
    'app.kubernetes.io/name': CANARY,
    'app.kubernetes.io/part-of': 'kfive-test',
  };
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: CANARY, namespace, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [{
            name: 'canary', image: 'kfive-ai-backend:latest', imagePullPolicy: 'IfNotPresent',
            command: ['node', '-e', 'setInterval(()=>{},60000)'],
            resources: {
              requests: { cpu: '5m', memory: '16Mi' },
              limits: { cpu: '50m', memory: '48Mi' },
            },
            securityContext: {
              allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'] },
            },
            volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
          }],
          volumes: [{ name: 'tmp', emptyDir: { sizeLimit: '8Mi' } }],
        },
      },
    },
  };
}

async function prometheus(path) {
  const response = await request(`/grafana/api/datasources/proxy/uid/kfive-prometheus${path}`);
  assert.equal(response.status, 200, response.body);
  const body = JSON.parse(response.body);
  assert.equal(body.status, 'success', response.body);
  return body.data;
}

async function main() {
  assert.equal(kubectl('config', 'current-context'), 'kind-kfive');
  assert.ok(exists('-n', 'kube-system', 'get', 'daemonset/kindnet'),
    'kindnet NetworkPolicy controller is required');
  for (const namespace of ['kfive', 'kfive-observability']) {
    assert.equal(exists('-n', namespace, 'get', `deployment/${CANARY}`), false,
      `Refusing to replace pre-existing ${namespace}/deployment/${CANARY}`);
    assert.ok(exists('-n', namespace, 'get', 'networkpolicy/default-deny'));
    assert.ok(exists('-n', namespace, 'get', 'networkpolicy/allow-dns-egress'));
  }
  assert.equal(exists('get', `namespace/${FOREIGN_NAMESPACE}`), false,
    `Refusing to replace pre-existing namespace/${FOREIGN_NAMESPACE}`);

  const pvcBefore = {
    kfive: uidSnapshot('kfive', 'pvc'),
    observability: uidSnapshot('kfive-observability', 'pvc'),
  };
  const secretUid = kubectl('-n', 'kfive', 'get', 'secret/kfive-secrets', '-o', 'jsonpath={.metadata.uid}');
  let created = false;
  let scenarioError;
  let summary;
  try {
    kubectlApply({
      apiVersion: 'v1', kind: 'Namespace',
      metadata: {
        name: FOREIGN_NAMESPACE,
        labels: {'app.kubernetes.io/part-of': 'kfive-test'},
      },
    });
    created = true;
    kubectlApply(canaryDeployment('kfive'));
    kubectlApply(canaryDeployment('kfive-observability'));
    kubectlApply(canaryDeployment(FOREIGN_NAMESPACE));
    for (const namespace of ['kfive', 'kfive-observability', FOREIGN_NAMESPACE]) {
      kubectl('-n', namespace, 'rollout', 'status', `deployment/${CANARY}`, '--timeout=180s');
      assert.equal(kubectl('-n', namespace, 'exec', `deployment/${CANARY}`, '--',
        'node', '-e', "require('node:dns').lookup('kubernetes.default.svc',e=>process.exit(e?1:0))"), '');
    }

    // kindnet historically needed a short reconciliation window for new pods.
    await new Promise((resolve) => setTimeout(resolve, 12_000));

    const appTargets = ['mongodb', 'redis', 'chromadb', 'backend', 'frontend']
      .map((name) => ({ name, ip: serviceIp('kfive', name),
        port: { mongodb: 27017, redis: 6379, chromadb: 8000, backend: 5000, frontend: 8080 }[name] }));
    const observabilityTargets = ['prometheus', 'loki', 'grafana', 'alertmanager']
      .map((name) => ({ name, ip: serviceIp('kfive-observability', name),
        port: { prometheus: 9090, loki: 3100, grafana: 3000, alertmanager: 9093 }[name] }));

    await assertRepeatedlyDenied('kfive', CANARY, [...appTargets, ...observabilityTargets]);
    await assertRepeatedlyDenied('kfive-observability', CANARY, [...appTargets, ...observabilityTargets]);
    await assertRepeatedlyDenied(FOREIGN_NAMESPACE, CANARY, [...appTargets, ...observabilityTargets]);
    assert.equal(probe('kfive', 'backend', serviceIp('kfive-observability', 'prometheus'), 9090), false,
      'backend must not have undeclared observability egress');

    for (const target of appTargets.slice(0, 3)) {
      assert.equal(probe('kfive', 'backend', target.ip, target.port), true,
        `backend could not reach declared ${target.name} flow`);
    }

    const readiness = await request('/api/v1/readiness');
    assert.equal(readiness.status, 200, readiness.body);
    const readinessBody = JSON.parse(readiness.body);
    assert.equal(readinessBody.dependencies.mongodb, 'available');
    assert.equal(readinessBody.dependencies.redis, 'available');
    const frontend = await request('/');
    assert.equal(frontend.status, 200, frontend.body);
    assert.match(frontend.contentType, /^text\/html/);
    const grafana = await request('/grafana/api/health');
    assert.equal(grafana.status, 200, grafana.body);

    await retry(async () => {
      const backendUp = await prometheus('/api/v1/query?query=up%7Bjob%3D%22kfive-backend%22%7D');
      assert.ok(backendUp.result.some((series) => series.value?.[1] === '1'));
      const proberUp = await prometheus('/api/v1/query?query=up%7Bjob%3D%22kfive-subsystem-probes%22%7D');
      assert.ok(proberUp.result.some((series) => series.value?.[1] === '1'));
      const probes = await prometheus('/api/v1/query?query=kfive_subsystem_probe_success');
      assert.deepEqual(Object.fromEntries(probes.result.map((series) =>
        [series.metric.dependency, Number(series.value[1])])), { chromadb: 1, mongodb: 1, redis: 1 });
      const alertmanagers = await prometheus('/api/v1/alertmanagers');
      assert.ok((alertmanagers.activeAlertmanagers || []).some((entry) => /alertmanager.*:9093/.test(entry.url)));
    });
    const loki = await request('/grafana/api/datasources/proxy/uid/kfive-loki/loki/api/v1/labels');
    assert.equal(loki.status, 200, loki.body);
    assert.equal(JSON.parse(loki.body).status, 'success');

    summary = {
      networkPolicyController: 'kindnet',
      namespacesDefaultDenied: ['kfive', 'kfive-observability'],
      deniedCanaries: ['same-namespace-application', 'same-namespace-observability', 'foreign-namespace'],
      deniedTargets: [...appTargets, ...observabilityTargets].map((target) => `${target.name}:${target.port}`),
      allowed: {
        edgeRoutes: true,
        backendDatastores: true,
        prometheusBackendAndProber: true,
        prometheusAlertmanager: true,
        traefikGrafana: true,
        grafanaPrometheusAndLoki: true,
      },
      repeatedDenials: 3,
      secretUidUnchanged: true,
      pvcUidsUnchanged: true,
    };
  } catch (error) {
    scenarioError = error;
  } finally {
    const cleanupErrors = [];
    if (created) {
      for (const namespace of ['kfive', 'kfive-observability']) {
        try { kubectl('-n', namespace, 'delete', `deployment/${CANARY}`, '--wait=true', '--timeout=60s'); } catch (error) { cleanupErrors.push(error); }
      }
      try { kubectl('delete', `namespace/${FOREIGN_NAMESPACE}`, '--wait=true', '--timeout=60s'); } catch (error) { cleanupErrors.push(error); }
    }
    try { assertCanariesAbsent(); } catch (error) { cleanupErrors.push(error); }
    try { assert.deepEqual(uidSnapshot('kfive', 'pvc'), pvcBefore.kfive); } catch (error) { cleanupErrors.push(error); }
    try { assert.deepEqual(uidSnapshot('kfive-observability', 'pvc'), pvcBefore.observability); } catch (error) { cleanupErrors.push(error); }
    try {
      assert.equal(kubectl('-n', 'kfive', 'get', 'secret/kfive-secrets', '-o', 'jsonpath={.metadata.uid}'), secretUid);
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) {
      scenarioError = new AggregateError(scenarioError ? [scenarioError, ...cleanupErrors] : cleanupErrors,
        'NetworkPolicy verification and/or cleanup failed');
    }
  }
  if (scenarioError) throw scenarioError;
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
