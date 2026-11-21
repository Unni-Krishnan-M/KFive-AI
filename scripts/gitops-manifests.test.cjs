const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const yaml = require('js-yaml');

const ORIGIN = 'https://github.com/Unni-Krishnan-M/KFive-AI.git';

function load(path) {
  return yaml.load(readFileSync(path, 'utf8'));
}

function loadAll(path) {
  return yaml.loadAll(readFileSync(path, 'utf8')).filter(Boolean);
}

function application(name) {
  const resource = load(`k8s/gitops/${name}-application.yaml`);
  assert.equal(resource.kind, 'Application');
  return resource;
}

function includedFiles(resource) {
  const include = resource.spec.source.directory.include;
  assert.match(include, /^\{[^{}]+\}$/);
  return new Set(include.slice(1, -1).split(','));
}

test('separates infrastructure and application ownership without gaps', () => {
  const infrastructure = application('infrastructure');
  const app = application('application');
  const infrastructureFiles = includedFiles(infrastructure);
  const applicationFiles = includedFiles(app);

  assert.deepEqual([...infrastructureFiles].sort(), [
    'chromadb.yaml', 'config.yaml', 'mongodb.yaml', 'namespaces.yaml', 'network-policies.yaml',
    'redis.yaml', 'storage.yaml', 'traefik-rbac.yaml', 'traefik.yaml',
  ]);
  assert.deepEqual([...applicationFiles].sort(), [
    'application-storage.yaml', 'backend.yaml', 'frontend.yaml', 'repository-importer.yaml',
  ]);
  assert.deepEqual([...infrastructureFiles].filter((file) => applicationFiles.has(file)), []);

  const aggregate = load('k8s/base/kustomization.yaml').resources
    .filter((path) => path.endsWith('.yaml') && path !== 'kustomization.yaml');
  assert.deepEqual(new Set([...infrastructureFiles, ...applicationFiles]), new Set(aggregate));
});

test('uses bounded projects and safe automated reconciliation policies', () => {
  const projects = loadAll('k8s/gitops/projects.yaml');
  const infrastructureProject = projects.find((item) => item.metadata.name === 'kfive-infrastructure');
  const applicationProject = projects.find((item) => item.metadata.name === 'kfive-application');
  assert.ok(infrastructureProject);
  assert.ok(applicationProject);

  for (const project of projects) {
    assert.deepEqual(project.spec.sourceRepos, [ORIGIN]);
    assert.equal(project.metadata.namespace, 'argocd');
    assert.equal(project.spec.destinations.some((item) => item.server === '*'
      || item.namespace === '*'), false);
    const allRules = [
      ...(project.spec.clusterResourceWhitelist || []),
      ...(project.spec.namespaceResourceWhitelist || []),
    ];
    assert.equal(allRules.some((rule) => rule.group === '*' || rule.kind === '*'), false);
    assert.deepEqual(project.spec.namespaceResourceBlacklist, [{ group: '', kind: 'Secret' }]);
  }
  assert.deepEqual(applicationProject.spec.destinations, [{
    namespace: 'kfive', server: 'https://kubernetes.default.svc',
  }]);
  assert.deepEqual(applicationProject.spec.clusterResourceWhitelist, []);
  assert.ok(infrastructureProject.spec.namespaceResourceWhitelist.some((rule) =>
    rule.group === 'networking.k8s.io' && rule.kind === 'NetworkPolicy'));
  assert.equal(applicationProject.spec.namespaceResourceWhitelist.some((rule) =>
    rule.kind === 'NetworkPolicy'), false);

  const infrastructure = application('infrastructure');
  const app = application('application');
  for (const resource of [infrastructure, app]) {
    assert.equal(resource.metadata.namespace, 'argocd');
    assert.equal(resource.metadata.finalizers, undefined, 'Applications must not cascade-delete managed resources');
    assert.equal(resource.spec.source.repoURL, ORIGIN);
    assert.equal(resource.spec.source.targetRevision, 'main');
    assert.equal(resource.spec.source.path, 'k8s/base');
    assert.equal(resource.spec.destination.server, 'https://kubernetes.default.svc');
    assert.equal(resource.spec.destination.namespace, 'kfive');
    assert.equal(resource.spec.syncPolicy.automated.selfHeal, true);
    assert.equal(resource.spec.syncPolicy.automated.allowEmpty, false);
    assert.ok(resource.spec.syncPolicy.syncOptions.includes('PruneLast=true'));
    assert.ok(resource.spec.syncPolicy.syncOptions.includes('ApplyOutOfSyncOnly=true'));
    assert.ok(resource.spec.syncPolicy.syncOptions.includes('CreateNamespace=false'));
  }
  assert.equal(infrastructure.spec.syncPolicy.automated.prune, false,
    'stateful infrastructure requires deliberate pruning');
  assert.equal(app.spec.syncPolicy.automated.prune, true,
    'stateless application resources should prune automatically');
});

test('protects namespaces and persistent claims and never commits the runtime Secret', () => {
  for (const resource of [
    ...loadAll('k8s/base/namespaces.yaml'),
    ...loadAll('k8s/base/storage.yaml'),
    ...loadAll('k8s/base/application-storage.yaml'),
  ]) {
    const options = resource.metadata.annotations?.['argocd.argoproj.io/sync-options'] || '';
    assert.match(options, /(?:^|,)Prune=confirm(?:,|$)/);
    assert.match(options, /(?:^|,)Delete=false(?:,|$)/);
  }

  const managedFiles = [
    'k8s/base/namespaces.yaml', 'k8s/base/config.yaml', 'k8s/base/storage.yaml', 'k8s/base/application-storage.yaml',
    'k8s/base/mongodb.yaml', 'k8s/base/redis.yaml', 'k8s/base/chromadb.yaml',
    'k8s/base/backend.yaml', 'k8s/base/frontend.yaml', 'k8s/base/traefik-rbac.yaml',
    'k8s/base/traefik.yaml', 'k8s/base/ingress.yaml',
    'k8s/base/network-policies.yaml',
  ];
  const resources = managedFiles.flatMap(loadAll);
  assert.equal(resources.some((resource) => resource.kind === 'Secret'), false);
  const backend = resources.find((resource) => resource.kind === 'Deployment'
    && resource.metadata.name === 'backend');
  assert.ok(backend.spec.template.spec.containers[0].envFrom
    .some((entry) => entry.secretRef?.name === 'kfive-secrets'));
});

test('keeps the Argo CD API private and the install source pinned', () => {
  const config = load('k8s/gitops/install.yaml');
  assert.equal(config.data.ARGOCD_VERSION, 'v3.5.3');
  assert.match(config.data.INSTALL_MANIFEST_URL,
    /^https:\/\/raw\.githubusercontent\.com\/argoproj\/argo-cd\/v3\.5\.3\/manifests\/install\.yaml$/);
  assert.match(config.data.INSTALL_MANIFEST_SHA256, /^[a-f0-9]{64}$/);

  const bootstrapResources = [
    ...loadAll('k8s/gitops/projects.yaml'),
    application('infrastructure'),
    application('application'),
  ];
  assert.equal(bootstrapResources.some((resource) => ['Ingress', 'Service'].includes(resource.kind)), false);
});

test('keeps Traefik independent of Kubernetes API credentials', () => {
  const resources = loadAll('k8s/base/traefik-rbac.yaml');
  assert.deepEqual(resources.map((resource) => resource.kind), ['ServiceAccount']);
  assert.equal(resources[0].automountServiceAccountToken, false);
});

test('uses an isolated exact-commit Git source and verifies reconciliation safely', () => {
  const bootstrap = readFileSync('scripts/kfive-argocd-bootstrap.sh', 'utf8');
  assert.match(bootstrap, /\/tmp\/kfive-kind-gitops/);
  assert.match(bootstrap, /git -C "\$gitops_dir\/work" init --initial-branch=gitops-live/);
  assert.match(bootstrap, /git clone --bare/);
  assert.match(bootstrap, /update-server-info/);
  assert.match(bootstrap, /--network kind/);
  assert.match(bootstrap, /--read-only/);
  assert.match(bootstrap, /--cap-drop ALL/);
  assert.match(bootstrap, /--security-opt no-new-privileges/);
  assert.doesNotMatch(bootstrap, /(?:^|\s)(?:-p|--publish)(?:\s|=)/m);
  assert.doesNotMatch(bootstrap, /\.git(?:\/|\s)/, 'the shared Git metadata must never be copied');
  assert.match(bootstrap, /INSTALL_MANIFEST_SHA256/);
  assert.match(bootstrap, /kfive-infrastructure/);
  assert.match(bootstrap, /kfive-application/);
  assert.match(bootstrap, /trap cleanup_failed_bootstrap EXIT/,
    'explicit validation exits must clean the disposable source and snapshot');
  assert.match(bootstrap, /kind-gitops-source\.cjs cleanup/);

  const teardown = readFileSync('scripts/kfive-kind-down.sh', 'utf8');
  assert.match(teardown, /cleanup_status=0/);
  assert.match(teardown, /kind-ollama-socket\.cjs cleanup[^\n]+\|\| cleanup_status=\$\?/);
  assert.match(teardown, /kind-gitops-source\.cjs cleanup[^\n]+\|\| cleanup_status=\$\?/);

  const lifecycle = readFileSync('scripts/kfive-kind-up.sh', 'utf8');
  assert.match(lifecycle, /quay\.io\/argoproj\/argocd:v3\.5\.3/);
  assert.match(lifecycle, /ghcr\.io\/dexidp\/dex:v2\.45\.1/);
  assert.match(lifecycle, /public\.ecr\.aws\/docker\/library\/redis:8\.2\.3-alpine/);

  const verifier = readFileSync('scripts/verify-argocd-live.cjs', 'utf8');
  for (const marker of [
    'expectedRevision', 'selfHeal', 'prune', 'pvcUidsUnchanged',
    'secretUnchanged', 'controllerRestart', 'privateExposure',
  ]) {
    assert.match(verifier, new RegExp(marker));
  }
});
