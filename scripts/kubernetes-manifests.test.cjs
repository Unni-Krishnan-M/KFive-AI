const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const yaml = require('js-yaml');

function render() {
  const output = execFileSync('kubectl', ['kustomize', 'k8s/base'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return yaml.loadAll(output).filter(Boolean);
}

function named(resources, kind, name, namespace) {
  return resources.find((resource) => resource.kind === kind
    && resource.metadata?.name === name
    && (!namespace || resource.metadata?.namespace === namespace));
}

function podSpec(resource) {
  return resource.spec?.template?.spec;
}

test('renders the bounded KFive core and observability namespaces', () => {
  const resources = render();
  assert.ok(named(resources, 'Namespace', 'kfive'));
  assert.ok(named(resources, 'Namespace', 'kfive-observability'));

  for (const name of ['mongodb', 'redis', 'chromadb']) {
    assert.ok(named(resources, 'StatefulSet', name, 'kfive'), `${name} StatefulSet is required`);
    assert.ok(named(resources, 'PersistentVolumeClaim', `${name}-data`, 'kfive'), `${name} PVC is required`);
    const service = named(resources, 'Service', name, 'kfive');
    assert.ok(service, `${name} Service is required`);
    assert.notEqual(service.spec.type, 'NodePort');
    assert.notEqual(service.spec.type, 'LoadBalancer');
  }

  const chromadb = named(resources, 'StatefulSet', 'chromadb', 'kfive');
  const chromaContainer = podSpec(chromadb).containers[0];
  assert.ok(chromaContainer.volumeMounts.some((mount) => mount.name === 'data' && mount.mountPath === '/chroma/chroma'));
  assert.ok(chromaContainer.volumeMounts.some((mount) => mount.name === 'log-config' && mount.mountPath === '/etc/chroma/log_config.yml' && mount.readOnly));
  assert.ok(chromaContainer.env.some((entry) => entry.name === 'CHROMA_LOG_CONFIG' && entry.value === '/etc/chroma/log_config.yml'));
  assert.ok(named(resources, 'ConfigMap', 'chroma-log-config', 'kfive'));

  for (const name of ['backend', 'frontend', 'traefik']) {
    assert.ok(named(resources, 'Deployment', name, 'kfive'), `${name} Deployment is required`);
  }
  assert.ok(named(resources, 'PersistentVolumeClaim', 'backend-uploads', 'kfive'));
});

test('keeps secrets external and supplies non-secret runtime topology through ConfigMap', () => {
  const resources = render();
  assert.equal(resources.some((resource) => resource.kind === 'Secret'), false, 'committed manifests must not contain a Secret payload');

  const config = named(resources, 'ConfigMap', 'kfive-config', 'kfive');
  assert.ok(config);
  assert.equal(config.data.KFIVE_MODE, 'local');
  assert.equal(config.data.MONGODB_HOST, 'mongodb');
  assert.equal(config.data.REDIS_HOST, 'redis');
  assert.equal(config.data.CHROMA_URL, 'http://chromadb:8000');
  assert.equal(config.data.OLLAMA_SOCKET_PATH, '/run/ollama-bridge/ollama.sock');
  assert.equal(named(resources, 'Service', 'ollama-host', 'kfive'), undefined,
    'the host-only provider bridge must not be exposed as a Kubernetes Service');

  const backend = named(resources, 'Deployment', 'backend', 'kfive');
  const backendSpec = podSpec(backend);
  const backendContainer = backendSpec.containers[0];
  const envFrom = backendContainer.envFrom;
  assert.ok(envFrom.some((entry) => entry.configMapRef?.name === 'kfive-config'));
  assert.ok(envFrom.some((entry) => entry.secretRef?.name === 'kfive-secrets'));
  assert.ok(backendContainer.volumeMounts.some((mount) => mount.name === 'ollama-socket'
    && mount.mountPath === '/run/ollama-bridge' && mount.readOnly
    && mount.subPath === undefined && mount.mountPropagation === undefined));
  assert.ok(backendSpec.volumes.some((volume) => volume.name === 'ollama-socket'
    && volume.hostPath?.path === '/run/kfive-host-ollama'
    && volume.hostPath?.type === 'Directory'));
});

test('sets probes, resource bounds, and non-root security for every workload', () => {
  const resources = render();
  const workloads = resources.filter((resource) => ['Deployment', 'StatefulSet'].includes(resource.kind));
  assert.ok(workloads.length >= 6);

  for (const workload of workloads) {
    assert.equal(workload.metadata.labels?.['app.kubernetes.io/part-of'], 'kfive');
    const spec = podSpec(workload);
    assert.equal(spec.securityContext?.runAsNonRoot, true, `${workload.metadata.name} pod must run non-root`);
    assert.equal(spec.securityContext?.seccompProfile?.type, 'RuntimeDefault', `${workload.metadata.name} needs runtime-default seccomp`);
    if (workload.metadata.name !== 'traefik') {
      assert.equal(spec.automountServiceAccountToken, false, `${workload.metadata.name} must not receive a Kubernetes API token`);
    }
    for (const container of spec.containers) {
      assert.ok(container.resources?.requests?.cpu, `${workload.metadata.name} needs CPU request`);
      assert.ok(container.resources?.requests?.memory, `${workload.metadata.name} needs memory request`);
      assert.ok(container.resources?.limits?.cpu, `${workload.metadata.name} needs CPU limit`);
      assert.ok(container.resources?.limits?.memory, `${workload.metadata.name} needs memory limit`);
      assert.ok(container.readinessProbe, `${workload.metadata.name} needs readiness probe`);
      assert.ok(container.livenessProbe, `${workload.metadata.name} needs liveness probe`);
      assert.equal(container.securityContext?.allowPrivilegeEscalation, false, `${workload.metadata.name} must block privilege escalation`);
      assert.deepEqual(container.securityContext?.capabilities?.drop, ['ALL'], `${workload.metadata.name} must drop capabilities`);
      assert.equal(container.securityContext?.readOnlyRootFilesystem, true, `${workload.metadata.name} needs a read-only root`);
    }
  }

  const hostPaths = workloads.flatMap((workload) => podSpec(workload).volumes || [])
    .filter((volume) => volume.hostPath);
  assert.deepEqual(hostPaths, [{
    name: 'ollama-socket',
    hostPath: { path: '/run/kfive-host-ollama', type: 'Directory' },
  }]);
});

test('routes the local host through tokenless Traefik and leaves databases unexposed', () => {
  const resources = render();
  assert.equal(resources.some((resource) => resource.kind === 'Ingress'), false);
  assert.equal(resources.some((resource) => ['Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding']
    .includes(resource.kind) && resource.metadata?.name === 'kfive-traefik'), false);
  const routing = yaml.load(named(resources, 'ConfigMap', 'traefik-dynamic', 'kfive').data['core.yaml']);
  assert.match(routing.http.routers['kfive-api'].rule, /Host\(`kfive\.local`\)/);
  assert.match(routing.http.routers['kfive-api'].rule, /PathPrefix\(`\/api`\)/);
  assert.match(routing.http.routers['kfive-api'].rule, /PathPrefix\(`\/socket\.io`\)/);
  assert.equal(routing.http.routers['kfive-api'].service, 'backend');
  assert.equal(routing.http.routers['kfive-frontend'].service, 'frontend');
  assert.equal(routing.http.services.backend.loadBalancer.servers[0].url,
    'http://backend.kfive.svc.cluster.local:5000');
  assert.equal(routing.http.services.frontend.loadBalancer.servers[0].url,
    'http://frontend.kfive.svc.cluster.local:8080');

  const traefik = named(resources, 'Deployment', 'traefik', 'kfive');
  assert.equal(podSpec(traefik).automountServiceAccountToken, false);
  assert.ok(podSpec(traefik).containers[0].args.includes('--providers.file.directory=/etc/traefik/dynamic'));
  assert.ok(podSpec(traefik).containers[0].args.includes('--accesslog.fields.names.RequestPath=drop'),
    'durable access logs must not retain raw query strings');
  assert.equal(podSpec(traefik).containers[0].args.some((arg) => arg.includes('kubernetesingress')), false);

  const externalServices = resources.filter((resource) => resource.kind === 'Service'
    && ['NodePort', 'LoadBalancer'].includes(resource.spec?.type));
  assert.deepEqual(externalServices.map((service) => service.metadata.name), ['traefik']);
});

test('kind deployment script injects secrets without committing or echoing them', () => {
  const script = readFileSync('scripts/kfive-kind-up.sh', 'utf8');
  const downScript = readFileSync('scripts/kfive-kind-down.sh', 'utf8');
  const kindConfig = yaml.load(readFileSync('k8s/kind-config.yaml', 'utf8'));
  assert.match(script, /mktemp -d/);
  assert.match(script, /--from-file/);
  assert.match(script, /docker image save --platform linux\/amd64/);
  assert.match(script, /ctr --namespace=k8s\.io images import/);
  assert.doesNotMatch(script, /kind load docker-image/);
  assert.match(script, /kubectl apply -k k8s\/base/);
  assert.match(script, /--network host/);
  assert.match(script, /--mount type=bind/);
  assert.match(script, /OLLAMA_SOCKET_PATH/);
  assert.match(script, /com\.kfive\.kind\.cluster/);
  assert.match(script, /kind-ollama-socket\.cjs prepare/);
  assert.match(script, /kind-ollama-socket\.cjs verify-socket/);
  assert.match(script, /cmp - /);
  assert.match(script, /Mounts/);
  assert.match(script, /--cap-drop ALL/);
  assert.match(script, /--read-only/);
  assert.doesNotMatch(script, /OLLAMA_TCP_LISTEN_HOST/);
  assert.doesNotMatch(script, /kind: EndpointSlice/);
  assert.doesNotMatch(script, /source\s+.*\.env/);
  assert.doesNotMatch(script, /--from-literal/);
  assert.doesNotMatch(script, /set\s+-x/);
  assert.deepEqual(kindConfig.nodes[0].extraMounts, [{
    hostPath: '/tmp/kfive-kind-ollama',
    containerPath: '/run/kfive-host-ollama',
    readOnly: true,
  }]);
  assert.match(downScript, /com\.kfive\.kind\.cluster/);
  assert.match(downScript, /kind-ollama-socket\.cjs cleanup/);
  assert.doesNotMatch(downScript, /rm\s+-rf/);
});

test('default-denies the application namespace and permits only the declared service graph', () => {
  const resources = render();
  const policies = resources.filter((resource) => resource.kind === 'NetworkPolicy'
    && resource.metadata?.namespace === 'kfive');
  const policy = (name) => named(policies, 'NetworkPolicy', name, 'kfive');
  assert.deepEqual(policy('default-deny').spec, {
    podSelector: {}, policyTypes: ['Ingress', 'Egress'],
  });
  const dns = policy('allow-dns-egress');
  assert.deepEqual(dns.spec.podSelector, {});
  assert.deepEqual(dns.spec.policyTypes, ['Egress']);
  assert.deepEqual(dns.spec.egress[0].to, [{
    namespaceSelector: {matchLabels: {'kubernetes.io/metadata.name': 'kube-system'}},
    podSelector: {matchLabels: {'k8s-app': 'kube-dns'}},
  }, {ipBlock: {cidr: '10.96.0.10/32'}}]);
  assert.deepEqual(dns.spec.egress[0].ports.map((port) => [port.protocol, port.port]),
    [['UDP', 53], ['TCP', 53]]);
  const kindConfig = yaml.load(readFileSync('k8s/kind-config.yaml', 'utf8'));
  assert.equal(kindConfig.networking.serviceSubnet, '10.96.0.0/16');
  for (const name of ['traefik', 'frontend', 'backend', 'mongodb', 'redis', 'chromadb']) {
    const resource = policy(`allow-${name}`);
    assert.ok(resource, `allow-${name} policy is required`);
    assert.deepEqual(resource.spec.podSelector.matchLabels, {'app.kubernetes.io/name': name});
  }
  assert.equal(JSON.stringify(policy('allow-mongodb')).includes('27017'), true);
  assert.equal(JSON.stringify(policy('allow-redis')).includes('6379'), true);
  assert.equal(JSON.stringify(policy('allow-chromadb')).includes('8000'), true);
  const backend = JSON.stringify(policy('allow-backend'));
  assert.match(backend, /kfive-observability/);
  assert.match(backend, /prometheus/);
  assert.match(backend, /27017/);
  assert.match(backend, /6379/);
  assert.match(backend, /8000/);
  const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(rootPackage.scripts['kind:verify:network-policies'],
    'node scripts/verify-network-policies-live.cjs --allow-live-test');
});
