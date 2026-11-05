#!/usr/bin/env node
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');

if (!process.argv.includes('--allow-live-test')) {
  process.stderr.write('Refusing live mutation without --allow-live-test.\n');
  process.exit(2);
}

const sourceRoot = '/tmp/kfive-kind-gitops';
const work = `${sourceRoot}/work`;
const bare = `${sourceRoot}/repo.git`;

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function kubectl(args) { return run('kubectl', args); }
function appJson(name) { return JSON.parse(kubectl(['-n', 'argocd', 'get', 'application', name, '-o', 'json'])); }
function refresh(name) { kubectl(['-n', 'argocd', 'annotate', 'application', name, 'argocd.argoproj.io/refresh=hard', '--overwrite']); }

async function waitFor(description, check, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function waitForApp(name, revision) {
  await waitFor(`${name} Synced/Healthy at ${revision}`, () => {
    const app = appJson(name);
    return app.status?.sync?.status === 'Synced'
      && app.status?.health?.status === 'Healthy'
      && app.status?.sync?.revision === revision;
  }, 360000);
}

function commit(message) {
  run('git', ['-C', work, 'add', 'k8s']);
  run('git', ['-C', work, 'commit', '-m', message]);
  const revision = run('git', ['-C', work, 'rev-parse', 'HEAD']);
  run('git', ['-C', work, 'push', '--force', 'origin', 'gitops-live']);
  run('git', ['-C', bare, 'update-server-info']);
  return revision;
}

function pvcSnapshot() {
  const list = JSON.parse(kubectl(['-n', 'kfive', 'get', 'pvc', '-o', 'json']));
  return Object.fromEntries(list.items.map((item) => [item.metadata.name, item.metadata.uid]));
}

function secretFingerprint() {
  const secret = JSON.parse(kubectl(['-n', 'kfive', 'get', 'secret', 'kfive-secrets', '-o', 'json']));
  const stable = Object.entries(secret.data || {}).sort(([a], [b]) => a.localeCompare(b));
  return { uid: secret.metadata.uid, digest: crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex') };
}

(async () => {
  const expectedRevision = fs.readFileSync(`${sourceRoot}/expected-revision`, 'utf8').trim();
  assert.match(expectedRevision, /^[a-f0-9]{40}$/);
  await waitForApp('kfive-infrastructure', expectedRevision);
  await waitForApp('kfive-application', expectedRevision);

  const pvcBefore = pvcSnapshot();
  assert.equal(Object.keys(pvcBefore).length, 5);
  const secretBefore = secretFingerprint();

  const services = JSON.parse(kubectl(['get', 'services', '-A', '-o', 'json']));
  for (const service of services.items) {
    if (service.metadata.namespace === 'argocd') assert.equal(service.spec.type || 'ClusterIP', 'ClusterIP');
  }
  const argoIngresses = JSON.parse(kubectl(['-n', 'argocd', 'get', 'ingress', '-o', 'json']));
  assert.equal(argoIngresses.items.length, 0);
  const privateExposure = true;

  const frontendFile = `${work}/k8s/base/frontend.yaml`;
  const originalFrontend = fs.readFileSync(frontendFile, 'utf8');
  fs.appendFileSync(frontendFile, `\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: kfive-gitops-prune-canary\n  namespace: kfive\n  labels:\n    app.kubernetes.io/part-of: kfive\ndata:\n  marker: disposable\n`);
  const canaryRevision = commit('Add disposable GitOps prune canary');
  kubectl(['-n', 'argocd', 'patch', 'application', 'kfive-application', '--type=merge',
    '-p', JSON.stringify({ spec: { source: { targetRevision: canaryRevision } } })]);
  refresh('kfive-application');
  await waitForApp('kfive-application', canaryRevision);
  await waitFor('GitOps canary creation', () => {
    try { return kubectl(['-n', 'kfive', 'get', 'configmap', 'kfive-gitops-prune-canary', '-o', 'name']) === 'configmap/kfive-gitops-prune-canary'; }
    catch { return false; }
  });

  fs.writeFileSync(frontendFile, originalFrontend);
  const pruneRevision = commit('Remove disposable GitOps prune canary');
  kubectl(['-n', 'argocd', 'patch', 'application', 'kfive-application', '--type=merge',
    '-p', JSON.stringify({ spec: { source: { targetRevision: pruneRevision } } })]);
  refresh('kfive-application');
  await waitForApp('kfive-application', pruneRevision);
  await waitFor('automatic canary prune', () => {
    try { kubectl(['-n', 'kfive', 'get', 'configmap', 'kfive-gitops-prune-canary']); return false; }
    catch { return true; }
  });
  const prune = true;

  kubectl(['-n', 'kfive', 'patch', 'deployment', 'frontend', '--type=merge', '-p', '{"spec":{"replicas":2}}']);
  await waitFor('frontend replica self-heal', () => kubectl(['-n', 'kfive', 'get', 'deployment', 'frontend', '-o', 'jsonpath={.spec.replicas}']) === '1');
  const selfHeal = true;

  kubectl(['-n', 'argocd', 'rollout', 'restart', 'statefulset/argocd-application-controller']);
  kubectl(['-n', 'argocd', 'rollout', 'status', 'statefulset/argocd-application-controller', '--timeout=300s']);
  kubectl(['-n', 'argocd', 'rollout', 'restart', 'deployment/argocd-repo-server']);
  kubectl(['-n', 'argocd', 'rollout', 'status', 'deployment/argocd-repo-server', '--timeout=300s']);
  const controllerRestart = true;

  kubectl(['-n', 'argocd', 'patch', 'application', 'kfive-application', '--type=merge',
    '-p', JSON.stringify({ spec: { source: { targetRevision: pruneRevision } } })]);
  refresh('kfive-application');
  await waitForApp('kfive-application', pruneRevision);

  const pvcUidsUnchanged = JSON.stringify(pvcSnapshot()) === JSON.stringify(pvcBefore);
  const secretAfter = secretFingerprint();
  const secretUnchanged = secretAfter.uid === secretBefore.uid && secretAfter.digest === secretBefore.digest;
  assert.equal(pvcUidsUnchanged, true);
  assert.equal(secretUnchanged, true);
  const secretAccess = spawnSync('kubectl', [
    'auth', 'can-i', '--as=system:serviceaccount:kfive:traefik', 'list', 'secrets', '--all-namespaces',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(secretAccess.status, 1);
  assert.equal(secretAccess.stdout.trim(), 'no');
  await waitFor('all core workloads ready', () => {
    const pods = JSON.parse(kubectl(['-n', 'kfive', 'get', 'pods', '-o', 'json']));
    return pods.items.length === 6 && pods.items.every((pod) => pod.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'));
  });

  process.stdout.write(`${JSON.stringify({
    expectedRevision,
    finalRevision: pruneRevision,
    infrastructure: 'Synced/Healthy',
    application: 'Synced/Healthy',
    selfHeal,
    prune,
    pvcUidsUnchanged,
    secretUnchanged,
    controllerRestart,
    privateExposure,
  }, null, 2)}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
