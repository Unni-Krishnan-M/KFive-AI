const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const yaml = require('js-yaml');

function render() {
  return yaml.loadAll(execFileSync('kubectl', ['kustomize', 'k8s/observability'], {
    cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })).filter(Boolean);
}

function named(resources, kind, name) {
  return resources.find((resource) => resource.kind === kind && resource.metadata?.name === name);
}

test('provisions a private bounded Prometheus backend scrape', () => {
  const resources = render();
  assert.equal(resources.some((resource) => resource.kind === 'Secret'), false);
  const config = named(resources, 'ConfigMap', 'prometheus-config');
  const prometheusConfig = yaml.load(config.data['prometheus.yml']);
  assert.equal(prometheusConfig.global.scrape_interval, '5s');
  assert.equal(prometheusConfig.global.scrape_timeout, '4s');
  assert.equal(prometheusConfig.scrape_configs[0].metrics_path, '/metrics');
  assert.deepEqual(prometheusConfig.scrape_configs[0].static_configs[0].targets,
    ['backend.kfive.svc.cluster.local:5000']);
  const deployment = named(resources, 'Deployment', 'prometheus');
  const container = deployment.spec.template.spec.containers[0];
  assert.equal(container.image, 'prom/prometheus:v3.14.0');
  assert.ok(container.args.includes('--storage.tsdb.retention.time=24h'));
  assert.ok(container.args.includes('--storage.tsdb.retention.size=512MB'));
  assert.equal(container.args.some((argument) => argument.startsWith('--web.enable-lifecycle')), false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(deployment.spec.template.spec.securityContext.runAsNonRoot, true);
  assert.equal(deployment.spec.template.spec.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.ok(container.resources.requests.cpu && container.resources.requests.memory
    && container.resources.limits.cpu && container.resources.limits.memory);
  assert.equal(container.startupProbe.httpGet.path, '/-/ready');
  assert.equal(container.readinessProbe.httpGet.path, '/-/ready');
  assert.equal(container.livenessProbe.httpGet.path, '/-/healthy');
  const claim = named(resources, 'PersistentVolumeClaim', 'prometheus-data');
  assert.deepEqual(claim.spec.accessModes, ['ReadWriteOnce']);
  assert.equal(claim.spec.resources.requests.storage, '2Gi');
  assert.ok(container.volumeMounts.some((mount) => mount.name === 'data' && mount.mountPath === '/prometheus'));
  assert.equal(named(resources, 'Service', 'prometheus').spec.type, 'ClusterIP');
  assert.equal(resources.some((resource) => resource.kind === 'Ingress'
    && resource.spec?.rules?.some((rule) => rule.http?.paths?.some((path) => path.backend?.service?.name === 'prometheus'))), false);
});

test('provisions Grafana datasource and one read-only local backend dashboard', () => {
  const resources = render();
  const datasource = named(resources, 'ConfigMap', 'grafana-datasource');
  assert.match(datasource.data['datasource.yaml'], /url: http:\/\/prometheus:9090/);
  assert.match(datasource.data['datasource.yaml'], /uid: kfive-prometheus/);
  const dashboard = named(resources, 'ConfigMap', 'grafana-dashboard');
  const parsedDashboard = JSON.parse(dashboard.data['kfive-overview.json']);
  assert.equal(parsedDashboard.uid, 'kfive-overview');
  assert.ok(parsedDashboard.panels.some((panel) => JSON.stringify(panel).includes('kfive_http_requests_total')));
  assert.ok(parsedDashboard.panels.some((panel) => JSON.stringify(panel).includes('process_resident_memory_bytes')));
  const subsystem = parsedDashboard.panels.find((panel) => panel.title === 'Subsystem availability');
  const gpu = parsedDashboard.panels.find((panel) => panel.title === 'GPU probe availability');
  const vram = parsedDashboard.panels.find((panel) => panel.title === 'GPU VRAM utilization');
  const temperature = parsedDashboard.panels.find((panel) => panel.title === 'GPU temperature');
  assert.equal(subsystem.targets[0].expr, 'kfive_dependency_available');
  assert.equal(gpu.targets[0].expr, 'max(kfive_gpu_probe_available) or vector(0)');
  assert.equal(vram.targets[0].expr,
    'sum(kfive_gpu_vram_bytes{state="used"}) / sum(kfive_gpu_vram_bytes{state="total"})');
  assert.equal(temperature.targets[0].expr, 'kfive_gpu_temperature_celsius');
  assert.doesNotMatch(JSON.stringify([subsystem, gpu, vram, temperature]), /uuid|driver|model|owner|project|request_id/i);

  const deployment = named(resources, 'Deployment', 'grafana');
  const container = deployment.spec.template.spec.containers[0];
  assert.equal(container.image, 'grafana/grafana:13.2.2');
  assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(deployment.spec.template.spec.securityContext.runAsNonRoot, true);
  assert.equal(deployment.spec.template.spec.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  assert.ok(container.env.some((entry) => entry.name === 'GF_AUTH_ANONYMOUS_ORG_ROLE' && entry.value === 'Viewer'));
  assert.ok(container.env.some((entry) => entry.name === 'GF_AUTH_BASIC_ENABLED' && entry.value === 'false'));
  assert.ok(container.env.some((entry) => entry.name === 'GF_PLUGINS_PREINSTALL_AUTO_UPDATE' && entry.value === 'false'));
  assert.ok(container.env.some((entry) => entry.name === 'GF_PLUGINS_PLUGIN_ADMIN_ENABLED' && entry.value === 'false'));
  assert.ok(container.env.some((entry) => entry.name === 'GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES' && entry.value === 'false'));
  assert.ok(container.env.some((entry) => entry.name === 'GF_ANALYTICS_CHECK_FOR_UPDATES' && entry.value === 'false'));
  assert.ok(container.env.some((entry) => entry.name === 'GF_ANALYTICS_REPORTING_ENABLED' && entry.value === 'false'));
  assert.equal(container.startupProbe.httpGet.path, '/grafana/api/health');
  assert.equal(container.readinessProbe.httpGet.path, '/grafana/api/health');
  assert.equal(container.livenessProbe.httpGet.path, '/grafana/api/health');
  assert.ok(container.resources.requests.cpu && container.resources.requests.memory
    && container.resources.limits.cpu && container.resources.limits.memory);
  assert.equal(container.resources.requests.memory, '192Mi');
  assert.equal(container.resources.limits.memory, '768Mi');
  const claim = named(resources, 'PersistentVolumeClaim', 'grafana-data');
  assert.deepEqual(claim.spec.accessModes, ['ReadWriteOnce']);
  assert.equal(claim.spec.resources.requests.storage, '512Mi');
  assert.ok(container.volumeMounts.some((mount) => mount.name === 'data' && mount.mountPath === '/var/lib/grafana'));
  assert.equal(named(resources, 'Service', 'grafana').spec.type, 'ClusterIP');

  assert.equal(resources.some((resource) => resource.kind === 'Ingress'), false);
  const route = named(resources, 'ConfigMap', 'traefik-observability-dynamic');
  assert.equal(route.metadata.namespace, 'kfive');
  const dynamic = yaml.load(route.data['observability.yaml']);
  assert.match(dynamic.http.routers.grafana.rule, /Host\(`kfive\.local`\)/);
  assert.match(dynamic.http.routers.grafana.rule, /PathPrefix\(`\/grafana`\)/);
  assert.equal(dynamic.http.routers.grafana.service, 'grafana');
  assert.equal(dynamic.http.services.grafana.loadBalancer.servers[0].url,
    'http://grafana.kfive-observability.svc.cluster.local:3000');
});

test('keeps observability opt-in in the local kind lifecycle', () => {
  const script = readFileSync('scripts/kfive-kind-up.sh', 'utf8');
  assert.match(script, /--with-observability/);
  assert.match(script, /kubectl apply -k k8s\/observability/);
  assert.match(script, /prom\/prometheus:v3\.14\.0/);
  assert.match(script, /grafana\/grafana:13\.2\.2/);
  assert.match(script, /rollout restart deployment\/prometheus/);
  assert.match(script, /rollout restart deployment\/grafana/);
  assert.match(script, /fluent\/fluent-bit:5\.1\.2/);
  assert.match(script, /rollout status daemonset\/fluent-bit/);
});

test('collects local kfive container logs with bounded Fluent Bit storage', () => {
  const resources = render();
  assert.equal(named(resources, 'ServiceAccount', 'fluent-bit'), undefined);
  assert.equal(named(resources, 'Role', 'kfive-fluent-bit'), undefined);
  assert.equal(named(resources, 'RoleBinding', 'kfive-fluent-bit'), undefined);
  const fluentBitConfig = named(resources, 'ConfigMap', 'fluent-bit-config').data;
  const config = fluentBitConfig['fluent-bit.conf'];
  assert.match(config, /Path\s+\/var\/log\/containers\/\*_kfive_\*\.log/);
  assert.match(config, /Mem_Buf_Limit\s+10MB/);
  assert.match(config, /Buffer_Max_Size\s+64KB/);
  assert.match(config, /storage\.type\s+filesystem/);
  assert.match(config, /Name\s+kubernetes/);
  assert.match(config, /Use_Tag_For_Meta\s+On/);
  assert.doesNotMatch(config, /Kube_URL|Kube_CA_File|Kube_Token_File/);
  assert.match(config, /Merge_Log\s+On/);
  assert.match(config, /Parser\s+kfive_cri/);
  assert.match(fluentBitConfig['parsers.conf'], /Name\s+kfive_cri/);
  assert.match(fluentBitConfig['parsers.conf'], /\?<log>/);
  assert.match(config, /Annotations\s+Off/);
  assert.match(config, /Labels\s+Off/);
  assert.doesNotMatch(config, /Name\s+stdout/);
  assert.match(config, /Name\s+loki/);
  assert.match(config, /Host\s+loki/);
  assert.match(config, /labels\s+job=kfive,namespace=\$kubernetes\['namespace_name'\],container=\$kubernetes\['container_name'\]/);
  assert.match(config, /line_format\s+json/);
  assert.doesNotMatch(config, /datadog/i);

  const daemonSet = named(resources, 'DaemonSet', 'fluent-bit');
  const pod = daemonSet.spec.template.spec;
  const container = pod.containers[0];
  assert.equal(container.image, 'fluent/fluent-bit:5.1.2');
  assert.equal(pod.serviceAccountName, 'default');
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.deepEqual(pod.securityContext.supplementalGroups, [0]);
  assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  assert.ok(container.resources.requests.cpu && container.resources.requests.memory
    && container.resources.limits.cpu && container.resources.limits.memory);
  assert.equal(container.readinessProbe.httpGet.path, '/api/v1/health');
  assert.equal(container.livenessProbe.httpGet.path, '/api/v1/health');
  assert.ok(container.volumeMounts.some((mount) => mount.name === 'container-logs'
    && mount.mountPath === '/var/log/containers' && mount.readOnly === true));
  assert.ok(container.volumeMounts.some((mount) => mount.name === 'pod-logs'
    && mount.mountPath === '/var/log/pods' && mount.readOnly === true));
  assert.ok(container.volumeMounts.some((mount) => mount.name === 'state'
    && mount.mountPath === '/fluent-bit/state'));
  assert.equal(resources.some((resource) => resource.kind === 'Service'
    && resource.metadata?.name === 'fluent-bit'), false);
});

test('waits for backend and Traefik ingestion watermarks before asserting redaction', () => {
  const verifier = readFileSync('scripts/verify-loki-live.cjs', 'utf8');
  assert.match(verifier, /await markerRecord\(redactionWatermark/);
  assert.match(verifier, /await streamMarker\('traefik', traefikWatermark/);
  assert.doesNotMatch(verifier, /setTimeout\(resolve, 2_000\)/);
});

test('live verifier requires honest subsystem and CPU-only GPU telemetry', () => {
  const verifier = readFileSync('scripts/verify-observability-live.cjs', 'utf8');
  assert.match(verifier, /kfive_dependency_available/);
  assert.match(verifier, /\['mongodb', 'redis'\]/);
  assert.match(verifier, /kfive_gpu_probe_available/);
  assert.match(verifier, /nvidia-smi-not-found/);
  assert.match(verifier, /kfive_gpu_temperature_celsius/);
});

test('provisions private persistent Loki with bounded local retention and Grafana search', () => {
  const resources = render();
  const config = named(resources, 'ConfigMap', 'loki-config');
  const lokiConfig = yaml.load(config.data['loki.yaml']);
  assert.equal(lokiConfig.auth_enabled, false);
  assert.equal(lokiConfig.common.replication_factor, 1);
  assert.equal(lokiConfig.schema_config.configs[0].store, 'tsdb');
  assert.equal(lokiConfig.schema_config.configs[0].object_store, 'filesystem');
  assert.equal(lokiConfig.schema_config.configs[0].schema, 'v13');
  assert.equal(lokiConfig.schema_config.configs[0].index.period, '24h');
  assert.equal(lokiConfig.compactor.retention_enabled, true);
  assert.equal(lokiConfig.compactor.delete_request_store, 'filesystem');
  assert.equal(lokiConfig.limits_config.retention_period, '24h');
  assert.equal(lokiConfig.limits_config.discover_log_levels, false);
  assert.deepEqual(lokiConfig.limits_config.discover_service_name, []);
  assert.ok(lokiConfig.limits_config.max_entries_limit_per_query <= 1000);
  assert.equal(lokiConfig.analytics.reporting_enabled, false);

  const deployment = named(resources, 'Deployment', 'loki');
  const container = deployment.spec.template.spec.containers[0];
  assert.equal(container.image, 'grafana/loki:3.7.8');
  assert.equal(deployment.spec.strategy.type, 'Recreate');
  assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(deployment.spec.template.spec.securityContext.runAsNonRoot, true);
  assert.equal(deployment.spec.template.spec.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  assert.ok(container.resources.requests.cpu && container.resources.requests.memory
    && container.resources.limits.cpu && container.resources.limits.memory);
  assert.equal(container.readinessProbe.httpGet.path, '/ready');
  assert.equal(container.livenessProbe.httpGet.path, '/ready');
  assert.ok(container.volumeMounts.some((mount) => mount.name === 'data' && mount.mountPath === '/var/loki'));

  const claim = named(resources, 'PersistentVolumeClaim', 'loki-data');
  assert.deepEqual(claim.spec.accessModes, ['ReadWriteOnce']);
  assert.equal(claim.spec.resources.requests.storage, '2Gi');
  const service = named(resources, 'Service', 'loki');
  assert.equal(service.spec.type, 'ClusterIP');
  assert.equal(resources.some((resource) => resource.kind === 'Ingress'
    && JSON.stringify(resource).includes('loki')), false);

  const datasource = named(resources, 'ConfigMap', 'grafana-datasource').data['datasource.yaml'];
  assert.match(datasource, /name: Loki/);
  assert.match(datasource, /uid: kfive-loki/);
  assert.match(datasource, /url: http:\/\/loki:3100/);
  const dashboard = JSON.parse(named(resources, 'ConfigMap', 'grafana-dashboard').data['kfive-overview.json']);
  const logsPanel = dashboard.panels.find((panel) => panel.type === 'logs');
  assert.ok(logsPanel && JSON.stringify(logsPanel).includes('kfive-loki'));
  assert.equal(logsPanel.targets[0].expr, '{namespace="kfive",container="backend"} | json');
  assert.equal(logsPanel.targets[0].maxLines, 100);
  assert.equal(dashboard.refresh, '10s');

  const lifecycle = readFileSync('scripts/kfive-kind-up.sh', 'utf8');
  assert.match(lifecycle, /grafana\/loki:3\.7\.8/);
  assert.match(lifecycle, /rollout status deployment\/loki/);
});

test('provisions bounded backend availability alert evaluation and Grafana visibility', () => {
  const resources = render();
  const prometheusConfig = yaml.load(named(resources, 'ConfigMap', 'prometheus-config').data['prometheus.yml']);
  assert.ok(prometheusConfig.alerting, 'Prometheus must configure Alertmanager delivery');
  assert.deepEqual(prometheusConfig.rule_files, ['/etc/prometheus/rules/*.yml']);

  const rulesResource = named(resources, 'ConfigMap', 'prometheus-rules');
  const rules = yaml.load(rulesResource.data['kfive.rules.yml']);
  assert.equal(rules.groups.length, 1);
  assert.equal(rules.groups[0].name, 'kfive.rules');
  const availability = rules.groups[0].rules.find((rule) => rule.alert === 'KFiveBackendUnavailable');
  assert.ok(availability);
  assert.equal(availability.expr,
    'up{job="kfive-backend"} == 0 or absent(up{job="kfive-backend"})');
  assert.equal(availability.for, '30s');
  assert.equal(availability.labels.severity, 'critical');
  assert.match(availability.annotations.runbook_url, /^https:\/\/github\.com\/.*#kfivebackendunavailable$/);

  const prometheus = named(resources, 'Deployment', 'prometheus');
  assert.ok(prometheus.spec.template.spec.containers[0].volumeMounts.some((mount) =>
    mount.name === 'rules' && mount.mountPath === '/etc/prometheus/rules' && mount.readOnly === true));
  assert.ok(prometheus.spec.template.spec.volumes.some((volume) =>
    volume.name === 'rules' && volume.configMap?.name === 'prometheus-rules'));

  const dashboard = JSON.parse(named(resources, 'ConfigMap', 'grafana-dashboard').data['kfive-overview.json']);
  const alertPanel = dashboard.panels.find((panel) => panel.title === 'Firing alerts');
  assert.ok(alertPanel);
  assert.equal(alertPanel.type, 'stat');
  assert.equal(alertPanel.targets[0].expr,
    'sum(ALERTS{alertname="KFiveBackendUnavailable",alertstate="firing"}) or vector(0)');

  const verifier = readFileSync('scripts/verify-alerting-live.cjs', 'utf8');
  assert.match(verifier, /scale.*deployment\/backend.*--replicas=0/s);
  assert.match(verifier, /finally[\s\S]*scale.*deployment\/backend.*--replicas=1/);
  assert.match(verifier, /KFiveBackendUnavailable/);
});

test('provisions private Alertmanager plumbing and a bounded resolved-notification verifier', () => {
  const resources = render();
  const prometheusConfig = yaml.load(named(resources, 'ConfigMap', 'prometheus-config').data['prometheus.yml']);
  assert.deepEqual(prometheusConfig.alerting.alertmanagers[0].static_configs[0].targets,
    ['alertmanager:9093']);

  const config = named(resources, 'ConfigMap', 'alertmanager-config');
  const parsed = yaml.load(config.data['alertmanager.yml']);
  assert.equal(parsed.route.receiver, 'null');
  assert.equal(parsed.route.group_wait, '1s');
  assert.deepEqual(parsed.receivers, [{ name: 'null' }]);
  assert.doesNotMatch(config.data['alertmanager.yml'], /https?:\/\//);

  const service = named(resources, 'Service', 'alertmanager');
  assert.equal(service.spec.type, 'ClusterIP');
  assert.deepEqual(service.spec.ports.map((port) => port.port), [9093]);
  assert.equal(resources.some((resource) => resource.kind === 'Ingress'
    && resource.spec?.rules?.some((rule) => rule.http?.paths?.some((path) =>
      path.backend?.service?.name === 'alertmanager'))), false);
  assert.doesNotMatch(named(resources, 'ConfigMap', 'traefik-observability-dynamic').data['observability.yaml'], /alertmanager/i);

  const deployment = named(resources, 'Deployment', 'alertmanager');
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  assert.equal(container.image, 'prom/alertmanager:v0.29.0');
  assert.equal(deployment.spec.strategy.type, 'Recreate');
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  assert.ok(container.args.includes('--data.retention=24h'));
  assert.ok(container.args.includes('--cluster.listen-address='));
  assert.ok(container.resources.requests.cpu && container.resources.requests.memory
    && container.resources.limits.cpu && container.resources.limits.memory);
  assert.equal(container.startupProbe.httpGet.path, '/-/ready');
  assert.equal(container.readinessProbe.httpGet.path, '/-/ready');
  assert.equal(container.livenessProbe.httpGet.path, '/-/healthy');
  assert.ok(container.volumeMounts.some((mount) =>
    mount.name === 'data' && mount.mountPath === '/alertmanager'));
  assert.ok(container.volumeMounts.some((mount) =>
    mount.name === 'config' && mount.mountPath === '/etc/alertmanager/alertmanager.yml' && mount.readOnly));
  assert.ok(pod.volumes.some((volume) => volume.name === 'config'
    && volume.configMap?.name === 'alertmanager-config'));
  const claim = named(resources, 'PersistentVolumeClaim', 'alertmanager-data');
  assert.deepEqual(claim.spec.accessModes, ['ReadWriteOnce']);
  assert.equal(claim.spec.resources.requests.storage, '512Mi');

  const lifecycle = readFileSync('scripts/kfive-kind-up.sh', 'utf8');
  assert.match(lifecycle, /prom\/alertmanager:v0\.29\.0/);
  assert.match(lifecycle, /rollout status deployment\/alertmanager/);

  const verifier = readFileSync('scripts/verify-alerting-live.cjs', 'utf8');
  const { deliveryConfig, harnessResources } = require('./verify-alerting-live.cjs');
  const delivery = yaml.load(deliveryConfig('kfive-test-marker'));
  const webhook = delivery.receivers.find((receiver) => receiver.name === 'kfive-test-marker').webhook_configs[0];
  assert.equal(webhook.url,
    'http://kfive-alert-receiver.kfive-observability.svc.cluster.local:8080/alerts');
  assert.equal(webhook.send_resolved, true);
  assert.equal(webhook.max_alerts, 1);
  assert.equal(delivery.route.group_interval, '5s');
  assert.equal(delivery.route.repeat_interval, '12h');
  assert.equal(webhook.http_config.authorization.credentials_file, '/receiver-secret/token');
  assert.deepEqual(delivery.route.routes[0].matchers, ['alertname="KFiveBackendUnavailable"']);
  const harness = harnessResources('test-token').items;
  const receiverService = harness.find((resource) => resource.kind === 'Service');
  const receiverPod = harness.find((resource) => resource.kind === 'Deployment').spec.template.spec;
  const receiverPolicy = harness.find((resource) => resource.kind === 'NetworkPolicy');
  assert.equal(receiverService.spec.type, 'ClusterIP');
  assert.equal(receiverPod.automountServiceAccountToken, false);
  assert.equal(receiverPod.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(receiverPod.containers[0].securityContext.capabilities.drop, ['ALL']);
  assert.deepEqual(receiverPolicy.spec.podSelector.matchLabels,
    { 'app.kubernetes.io/name': 'kfive-alert-receiver', 'app.kubernetes.io/part-of': 'kfive-test' });
  assert.deepEqual(receiverPolicy.spec.ingress[0].from[0].podSelector.matchLabels,
    { 'app.kubernetes.io/name': 'alertmanager' });
  assert.deepEqual(receiverPolicy.spec.ingress[0].ports, [{ protocol: 'TCP', port: 8080 }]);
  assert.match(verifier, /kfive-alert-receiver/);
  assert.match(verifier, /send_resolved:\s*true/);
  assert.match(verifier, /status.*firing/s);
  assert.match(verifier, /status.*resolved/s);
  assert.match(verifier, /fingerprint === firingFingerprint/);
  assert.match(verifier, /finally[\s\S]*delete[\s\S]*HARNESS/);
  assert.match(verifier, /volumeMounts:\s*\[\{ name: 'receiver-secret', mountPath: '\/receiver-secret', \$patch: 'delete' \}\]/);
  assert.match(verifier, /volumes:\s*\[\{ name: 'receiver-secret', \$patch: 'delete' \}\]/);
  assert.match(verifier, /assertReceiverSecretMountAbsent\(\)/);
  assert.match(verifier, /service\/alertmanager/);
});

test('provisions a fixed-target private subsystem prober, dashboard, rule, and live verifier', () => {
  const resources = render();
  const service = named(resources, 'Service', 'subsystem-prober');
  assert.equal(service.spec.type, 'ClusterIP');
  assert.deepEqual(service.spec.ports.map((port) => port.port), [9116]);
  assert.equal(resources.some((resource) => resource.kind === 'Ingress'
    && resource.spec?.rules?.some((rule) => rule.http?.paths?.some((path) =>
      path.backend?.service?.name === 'subsystem-prober'))), false);
  assert.doesNotMatch(named(resources, 'ConfigMap', 'traefik-observability-dynamic').data['observability.yaml'], /subsystem-prober/i);

  const deployment = named(resources, 'Deployment', 'subsystem-prober');
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  assert.equal(container.image, 'kfive-ai-subsystem-prober:latest');
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  assert.ok(container.resources.requests.cpu && container.resources.requests.memory
    && container.resources.limits.cpu && container.resources.limits.memory);
  assert.equal(container.startupProbe.httpGet.path, '/health');
  assert.equal(container.readinessProbe.httpGet.path, '/health');
  assert.equal(container.livenessProbe.httpGet.path, '/health');

  const prometheus = yaml.load(named(resources, 'ConfigMap', 'prometheus-config').data['prometheus.yml']);
  const scrape = prometheus.scrape_configs.find((job) => job.job_name === 'kfive-subsystem-probes');
  assert.deepEqual(scrape.static_configs[0].targets, ['subsystem-prober:9116']);
  assert.equal(scrape.metrics_path, '/metrics');
  assert.equal(scrape.params, undefined, 'fixed-target prober must not accept scrape-selected targets');

  const rules = yaml.load(named(resources, 'ConfigMap', 'prometheus-rules').data['kfive.rules.yml']);
  const alert = rules.groups[0].rules.find((rule) => rule.alert === 'KFiveSubsystemUnavailable');
  assert.equal(alert.expr, 'kfive_subsystem_probe_success == 0');
  assert.equal(alert.for, '30s');
  assert.equal(alert.labels.severity, 'warning');

  const dashboard = JSON.parse(named(resources, 'ConfigMap', 'grafana-dashboard').data['kfive-overview.json']);
  const panel = dashboard.panels.find((candidate) => candidate.title === 'Independent subsystem probes');
  assert.equal(panel.targets[0].expr, 'kfive_subsystem_probe_success');
  assert.doesNotMatch(JSON.stringify(panel), /host|port|url|owner|project|request/i);

  const lifecycle = readFileSync('scripts/kfive-kind-up.sh', 'utf8');
  assert.match(lifecycle, /kfive-ai-subsystem-prober:latest/);
  assert.match(lifecycle, /rollout status deployment\/subsystem-prober/);
  const verifier = readFileSync('scripts/verify-subsystem-probes-live.cjs', 'utf8');
  assert.match(verifier, /statefulset\/chromadb.*--replicas=0/s);
  assert.match(verifier, /finally[\s\S]*statefulset\/chromadb.*--replicas=1/);
  assert.match(verifier, /KFiveSubsystemUnavailable/);
  assert.match(verifier, /pvc\/chromadb-data/);
});

test('default-denies observability and permits only declared scrape, dashboard, log, and alert flows', () => {
  const resources = render();
  const policies = resources.filter((resource) => resource.kind === 'NetworkPolicy');
  const policy = (name) => named(policies, 'NetworkPolicy', name);
  assert.deepEqual(policy('default-deny').spec, {
    podSelector: {}, policyTypes: ['Ingress', 'Egress'],
  });
  for (const name of ['dns-egress', 'prometheus', 'alertmanager', 'subsystem-prober', 'grafana', 'loki', 'fluent-bit']) {
    assert.ok(policy(`allow-${name}`), `allow-${name} policy is required`);
  }
  const prometheus = JSON.stringify(policy('allow-prometheus'));
  assert.match(prometheus, /backend/);
  assert.match(prometheus, /subsystem-prober/);
  assert.match(prometheus, /alertmanager/);
  const grafana = JSON.stringify(policy('allow-grafana'));
  assert.match(grafana, /traefik/);
  assert.match(grafana, /prometheus/);
  assert.match(grafana, /loki/);
  assert.match(JSON.stringify(policy('allow-alertmanager')), /kfive-alert-receiver/);
  const dns = policy('allow-dns-egress');
  assert.deepEqual(dns.spec.egress[0].to, [{
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
    podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
  }, { ipBlock: { cidr: '10.96.0.10/32' } }]);
  assert.deepEqual(dns.spec.egress[0].ports, [
    { protocol: 'UDP', port: 53 },
    { protocol: 'TCP', port: 53 },
  ]);
  const fluentBit = policy('allow-fluent-bit');
  assert.match(JSON.stringify(fluentBit), /loki/);
  assert.equal(fluentBit.spec.egress.length, 2);
  assert.deepEqual(fluentBit.spec.egress[1], dns.spec.egress[0]);
  assert.equal(JSON.stringify(fluentBit).includes('0.0.0.0/0'), false);
  const kindConfig = yaml.load(readFileSync('k8s/kind-config.yaml', 'utf8'));
  assert.equal(kindConfig.networking.serviceSubnet, '10.96.0.0/16');
  const verifier = readFileSync('scripts/verify-network-policies-live.cjs', 'utf8');
  assert.match(verifier, /--allow-live-test/);
  assert.match(verifier, /network-policy-canary/);
  assert.match(verifier, /KFive_PROBE_DENIED/);
  assert.match(verifier, /KFive_PROBE_ALIVE/);
  assert.match(verifier, /spawnSync\('kubectl'/);
  assert.match(verifier, /assertCanariesAbsent\(\)/);
  assert.match(verifier, /AggregateError/);
  assert.match(verifier, /finally/);
});
