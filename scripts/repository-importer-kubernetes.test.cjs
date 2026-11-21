'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const yaml = require('js-yaml');

const socketDirectory = '/run/kfive-repository-importer';
const render = () => yaml.loadAll(execFileSync('kubectl', ['kustomize', 'k8s/base'], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
})).filter(Boolean);
const named = (resources, kind, name) => resources.find((r) => r.kind === kind && r.metadata.name === name);

test('Kubernetes importer has a separate tokenless pod with only the socket and bounded scratch', () => {
  const resources = render();
  const deployment = named(resources, 'Deployment', 'repository-importer');
  assert.ok(deployment, 'dedicated importer Deployment required');
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy.type, 'Recreate');
  const pod = deployment.spec.template.spec;
  assert.deepEqual(pod.nodeSelector, { 'kubernetes.io/hostname': 'kfive-control-plane' });
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.hostNetwork, undefined);
  assert.equal(pod.hostPID, undefined);
  assert.equal(pod.shareProcessNamespace, undefined);
  assert.equal(pod.securityContext.runAsUser, 10001);
  assert.equal(pod.securityContext.runAsGroup, 10002);
  assert.equal(pod.securityContext.fsGroup, undefined, 'do not change socket hostPath ownership');
  assert.equal(pod.containers.length, 1);
  const container = pod.containers[0];
  assert.deepEqual(container.command, ['/bin/sh', '-ec',
    'ulimit -c 0; exec node --max-old-space-size=128 backend/dist/repositoryImporterServerMain.js']);
  assert.equal(container.envFrom, undefined);
  assert.deepEqual(container.env, [
    { name: 'NODE_ENV', value: 'production' },
    { name: 'REPOSITORY_IMPORTER_SOCKET_PATH', value: `${socketDirectory}/importer.sock` },
  ]);
  assert.deepEqual(container.resources.limits, { cpu: '1', memory: '512Mi' });
  assert.equal(container.ports, undefined);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  for (const name of ['startupProbe', 'readinessProbe', 'livenessProbe']) {
    assert.deepEqual(container[name].exec.command, ['node', 'backend/dist/repositoryImporterHealthMain.js']);
  }
  assert.deepEqual(pod.volumes, [
    { name: 'repository-importer-socket', hostPath: { path: socketDirectory, type: 'Directory' } },
    { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '32Mi' } },
  ]);
  assert.deepEqual(container.volumeMounts, [
    { name: 'repository-importer-socket', mountPath: socketDirectory },
    { name: 'tmp', mountPath: '/tmp' },
  ]);
  assert.equal(resources.some((r) => r.kind === 'Service' && r.metadata.name === 'repository-importer'), false);
});

test('backend requires socket mode and receives only read-only socket access on the same node', () => {
  const resources = render();
  const pod = named(resources, 'Deployment', 'backend').spec.template.spec;
  assert.deepEqual(pod.nodeSelector, { 'kubernetes.io/hostname': 'kfive-control-plane' });
  assert.deepEqual(pod.securityContext.supplementalGroups, [10002]);
  assert.equal(pod.containers.length, 1, 'importer must not share the backend network namespace');
  const env = named(resources, 'ConfigMap', 'kfive-config').data;
  assert.equal(env.REPOSITORY_IMPORTER_MODE, 'socket');
  assert.equal(env.REPOSITORY_IMPORTER_SOCKET_PATH, `${socketDirectory}/importer.sock`);
  assert.ok(pod.containers[0].volumeMounts.some((m) => m.name === 'repository-importer-socket'
    && m.mountPath === socketDirectory && m.readOnly === true && m.mountPropagation === undefined));
});

test('no policy permits importer ingress or egress, including the general DNS policy', () => {
  const resources = render();
  const policies = resources.filter((r) => r.kind === 'NetworkPolicy' && r.metadata.namespace === 'kfive');
  const labels = named(resources, 'Deployment', 'repository-importer').spec.template.metadata.labels;
  const matches = (selector) => Object.entries(selector.matchLabels || {}).every(([k, v]) => labels[k] === v)
    && (selector.matchExpressions || []).every((e) => e.operator === 'NotIn'
      ? !e.values.includes(labels[e.key]) : e.operator === 'In' && e.values.includes(labels[e.key]));
  const selected = policies.filter((p) => matches(p.spec.podSelector));
  assert.ok(selected.some((p) => p.spec.policyTypes.includes('Ingress') && p.spec.policyTypes.includes('Egress')));
  for (const policy of selected) {
    assert.equal((policy.spec.ingress || []).length, 0, `${policy.metadata.name} permits importer ingress`);
    assert.equal((policy.spec.egress || []).length, 0, `${policy.metadata.name} permits importer egress`);
  }
});

test('kind node bounds PIDs and provisions the socket before workloads without application volume changes', () => {
  const config = yaml.load(readFileSync('k8s/kind-config.yaml', 'utf8'));
  const kubelet = config.nodes[0].kubeadmConfigPatches.map((patch) => yaml.load(patch))
    .find((patch) => patch.kind === 'KubeletConfiguration');
  assert.equal(kubelet.podPidsLimit, 256);
  assert.equal(kubelet.memorySwap.swapBehavior, 'NoSwap');
  const script = readFileSync('scripts/kfive-kind-up.sh', 'utf8');
  assert.ok(script.indexOf('scripts/kind-repository-socket.sh') < script.indexOf('kubectl apply -k k8s/base'));
  assert.match(script, /deployment\/repository-importer/);
  const prepare = readFileSync('scripts/kind-repository-socket.sh', 'utf8');
  assert.match(prepare, /noexec,nosuid,nodev/);
  assert.match(prepare, /size=1m/);
  assert.match(prepare, /10001:10002:770/);
  assert.doesNotMatch(prepare, /rm -|chown -R|chmod -R/);
});
