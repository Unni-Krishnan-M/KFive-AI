#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

if (!process.argv.includes('--allow-live-test')) {
  console.error('Refusing to alter the disposable kind collector without --allow-live-test.');
  process.exit(2);
}

function kubectl(...args) {
  return execFileSync('kubectl', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function kubectlApply(items) {
  const result = spawnSync('kubectl', ['apply', '-f', '-'], {
    input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items }),
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || `kubectl apply exited ${result.status}`);
}

function canI(...args) {
  const result = spawnSync('kubectl', ['auth', 'can-i', ...args,
    '--as=system:serviceaccount:kfive-observability:default'], { encoding: 'utf8' });
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || `kubectl auth can-i exited ${result.status}`);
  return result.stdout.trim();
}

function assertVerificationTargetsAbsent() {
  for (const resource of ['secret/kfive-datadog', 'service/datadog-receiver', 'deployment/datadog-receiver',
    'networkpolicy/allow-fluent-bit-datadog-egress', 'networkpolicy/allow-datadog-receiver']) {
    const result = spawnSync('kubectl', [
      '-n', 'kfive-observability', 'get', resource, '--ignore-not-found=true', '-o', 'name',
    ], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(result.stderr || `kubectl get ${resource} exited ${result.status}`);
    }
    if (result.stdout.trim()) {
      throw new Error(`Refusing to replace pre-existing Datadog verification resource: ${resource}`);
    }
  }
}

function request(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 8088, path, timeout: 10_000,
      headers: { Host: 'kfive.local', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('timeout', () => req.destroy(new Error(`Request timed out: ${path}`)));
    req.once('error', reject);
    req.end();
  });
}

async function retry(action, attempts = 90, delayMs = 1_000) {
  let error;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(); } catch (caught) { error = caught; }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw error;
}

function receiverSummary() {
  return JSON.parse(kubectl('-n', 'kfive-observability', 'exec', 'deployment/datadog-receiver', '--',
    'node', '-e', "fetch('http://127.0.0.1:8080/summary',{signal:AbortSignal.timeout(5000)}).then(async r=>{const body=await r.text();console.log(body);if(!r.ok)process.exitCode=1}).catch(e=>{console.error(e.message);process.exit(1)})"));
}

function receiverResources(apiKey, marker) {
  const receiver = String.raw`
const http=require('node:http');const zlib=require('node:zlib');
const state={count:0,deliveryAccepted:false,deliveries:[],paths:[],encodings:[]};
http.createServer((req,res)=>{if(req.method==='GET'&&req.url==='/summary'){res.setHeader('content-type','application/json');res.end(JSON.stringify(state));return;}
const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{let body=Buffer.concat(chunks);const encoding=String(req.headers['content-encoding']||'');if(encoding==='gzip'){try{body=zlib.gunzipSync(body)}catch{}}
const delivery={requestPath:req.url,encoding,credentialAccepted:Object.values(req.headers).includes(process.env.DD_API_KEY),markerFound:body.includes(process.env.MARKER)};
state.count+=1;state.deliveries.push(delivery);state.deliveryAccepted=state.deliveryAccepted||(delivery.requestPath==='/api/v2/logs'&&delivery.encoding==='gzip'&&delivery.credentialAccepted&&delivery.markerFound);state.paths.push(req.url);state.encodings.push(encoding);res.statusCode=200;res.end('{}');});}).listen(8080,'0.0.0.0');`;
  const labels = { 'app.kubernetes.io/name': 'datadog-receiver', 'app.kubernetes.io/part-of': 'kfive' };
  return [
    {
      apiVersion: 'v1', kind: 'Secret', metadata: { name: 'kfive-datadog', namespace: 'kfive-observability' },
      type: 'Opaque', stringData: { DD_API_KEY: apiKey },
    },
    {
      apiVersion: 'v1', kind: 'Service', metadata: { name: 'datadog-receiver', namespace: 'kfive-observability', labels },
      spec: { type: 'ClusterIP', selector: { 'app.kubernetes.io/name': 'datadog-receiver' }, ports: [{ name: 'http', port: 8080, targetPort: 'http' }] },
    },
    {
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'datadog-receiver', namespace: 'kfive-observability', labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: { 'app.kubernetes.io/name': 'datadog-receiver' } },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
            containers: [{
              name: 'receiver', image: 'kfive-ai-backend:latest', imagePullPolicy: 'IfNotPresent',
              command: ['node', '-e', receiver],
              env: [
                { name: 'DD_API_KEY', valueFrom: { secretKeyRef: { name: 'kfive-datadog', key: 'DD_API_KEY' } } },
                { name: 'MARKER', value: marker },
              ],
              ports: [{ name: 'http', containerPort: 8080 }],
              startupProbe: { httpGet: { path: '/summary', port: 'http' }, failureThreshold: 30, periodSeconds: 2 },
              readinessProbe: { httpGet: { path: '/summary', port: 'http' }, periodSeconds: 5 },
              livenessProbe: { httpGet: { path: '/summary', port: 'http' }, periodSeconds: 10 },
              resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '100m', memory: '96Mi' } },
              securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
              volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
            }],
            volumes: [{ name: 'tmp', emptyDir: { sizeLimit: '16Mi' } }],
          },
        },
      },
    },
  ];
}

function renderedTestOverlay() {
  const rendered = kubectl('kustomize', 'k8s/observability-datadog');
  const resources = yaml.loadAll(rendered).filter(Boolean);
  const daemonSet = resources.find((resource) => resource.kind === 'DaemonSet' && resource.metadata?.name === 'fluent-bit');
  assert.ok(daemonSet, 'rendered Fluent Bit DaemonSet missing');
  const env = daemonSet.spec.template.spec.containers[0].env;
  env.find((entry) => entry.name === 'DD_HOST').value = 'datadog-receiver.kfive-observability.svc.cluster.local';
  env.find((entry) => entry.name === 'DD_PORT').value = '8080';
  env.find((entry) => entry.name === 'DD_TLS').value = 'Off';
  return resources;
}

function cleanup() {
  try {
    kubectl('apply', '-k', 'k8s/observability');
    kubectl('-n', 'kfive-observability', 'rollout', 'restart', 'daemonset/fluent-bit');
    kubectl('-n', 'kfive-observability', 'rollout', 'status', 'daemonset/fluent-bit', '--timeout=240s');
  } finally {
    kubectl('-n', 'kfive-observability', 'delete', 'deployment/datadog-receiver', 'service/datadog-receiver',
      'secret/kfive-datadog', 'networkpolicy/allow-fluent-bit-datadog-egress',
      'networkpolicy/allow-datadog-receiver', '--ignore-not-found=true', '--wait=true');
  }
  assertCollectorRestored();
}

function assertCollectorRestored() {
  assertVerificationTargetsAbsent();
  const daemonSet = JSON.parse(kubectl('-n', 'kfive-observability', 'get', 'daemonset/fluent-bit', '-o', 'json'));
  const env = daemonSet.spec.template.spec.containers[0].env || [];
  assert.equal(env.some((entry) => entry.name.startsWith('DD_')), false,
    'Datadog environment remains on the restored collector');
  const optionalOutput = kubectl('-n', 'kfive-observability', 'get', 'configmap/fluent-bit-optional-output',
    '-o', 'jsonpath={.data.optional-output\\.conf}');
  assert.doesNotMatch(optionalOutput, /Name\s+datadog/i);
}

async function main() {
  assert.equal(kubectl('config', 'current-context'), 'kind-kfive');
  assertVerificationTargetsAbsent();
  const apiKey = crypto.randomBytes(24).toString('hex');
  const marker = `datadog-live-${Date.now()}`;
  let summary;
  try {
    kubectlApply(receiverResources(apiKey, marker));
    kubectl('-n', 'kfive-observability', 'rollout', 'status', 'deployment/datadog-receiver', '--timeout=240s');
    kubectlApply(renderedTestOverlay());
    kubectl('-n', 'kfive-observability', 'rollout', 'status', 'daemonset/fluent-bit', '--timeout=240s');

    const response = await request('/api/v1/health', { 'X-Request-ID': marker });
    assert.equal(response.status, 200, response.body);
    summary = await retry(() => {
      const current = receiverSummary();
      assert.ok(current.count > 0, 'receiver has no deliveries');
      assert.equal(current.deliveryAccepted, true,
        'no single /api/v2/logs delivery contained the marker, exact credential, and gzip encoding');
      assert.ok(current.deliveries.some((delivery) => delivery.requestPath === '/api/v2/logs'
        && delivery.encoding === 'gzip' && delivery.credentialAccepted && delivery.markerFound));
      return current;
    });

    await retry(async () => {
      const path = `/grafana/api/datasources/proxy/uid/kfive-loki/loki/api/v1/query_range?query=${encodeURIComponent(`{namespace="kfive",container="backend"} |= ${JSON.stringify(marker)}`)}&start=${String(BigInt(Date.now() - 120_000) * 1_000_000n)}&end=${String(BigInt(Date.now() + 5_000) * 1_000_000n)}&limit=20`;
      const result = await request(path);
      assert.equal(result.status, 200, result.body);
      assert.ok(JSON.parse(result.body).data.result.length > 0, 'Loki did not retain the dual-sink marker');
    });

    assert.equal(canI('get', 'secret/kfive-datadog', '-n', 'kfive-observability'), 'no');
    assert.equal(kubectl('-n', 'kfive-observability', 'get', 'service/datadog-receiver', '-o', 'jsonpath={.spec.type}'), 'ClusterIP');
  } finally {
    cleanup();
  }

  console.log(JSON.stringify({
    marker, deliveries: summary.count, credentialAccepted: true, gzip: true,
    requestPaths: [...new Set(summary.paths)], lokiDualDelivery: true,
    receiverExposure: 'ClusterIP only', collectorRestoredToDefault: true,
    externalDatadogContacted: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
