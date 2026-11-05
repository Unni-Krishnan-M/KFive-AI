const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const yaml = require('js-yaml');

function render(path) {
  return yaml.loadAll(execFileSync('kubectl', ['kustomize', path], {
    cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })).filter(Boolean);
}

function named(resources, kind, name) {
  return resources.find((resource) => resource.kind === kind && resource.metadata?.name === name);
}

test('keeps Datadog forwarding opt-in and its API key external to Git', () => {
  const base = render('k8s/observability');
  assert.equal(base.some((resource) => resource.kind === 'Secret'), false);
  assert.equal(JSON.stringify(base).includes('Name        datadog'), false);

  const resources = render('k8s/observability-datadog');
  assert.equal(resources.some((resource) => resource.kind === 'Secret'), false);
  const optional = named(resources, 'ConfigMap', 'fluent-bit-optional-output');
  const output = optional.data['optional-output.conf'];
  assert.match(output, /Name\s+datadog/);
  assert.match(output, /Host\s+\$\{DD_HOST\}/);
  assert.match(output, /Port\s+\$\{DD_PORT\}/);
  assert.match(output, /TLS\s+\$\{DD_TLS\}/i);
  assert.match(output, /Apikey\s+\$\{DD_API_KEY\}/i);
  assert.match(output, /Compress\s+gzip/i);
  assert.match(output, /Retry_Limit\s+5/);
  assert.match(output, /storage\.total_limit_size\s+16M/);
  assert.doesNotMatch(output, /[a-f0-9]{32}/i);

  const daemonSet = named(resources, 'DaemonSet', 'fluent-bit');
  const container = daemonSet.spec.template.spec.containers[0];
  const env = Object.fromEntries(container.env.map((entry) => [entry.name, entry]));
  assert.equal(env.DD_HOST.value, 'http-intake.logs.datadoghq.com');
  assert.equal(env.DD_PORT.value, '443');
  assert.equal(env.DD_TLS.value, 'On');
  assert.deepEqual(env.DD_API_KEY.valueFrom.secretKeyRef,
    { name: 'kfive-datadog', key: 'DD_API_KEY' });
  assert.ok(container.volumeMounts.some((mount) => mount.name === 'optional-output'
    && mount.mountPath === '/fluent-bit/etc/optional-output.conf'
    && mount.readOnly === true));

  const mainConfig = named(resources, 'ConfigMap', 'fluent-bit-config').data['fluent-bit.conf'];
  const optionalConfig = named(resources, 'ConfigMap', 'fluent-bit-optional-output').data['optional-output.conf'];
  assert.match(mainConfig, /Name\s+loki/);
  assert.match(mainConfig, /@INCLUDE\s+\/fluent-bit\/etc\/optional-output\.conf/);
  assert.match(optionalConfig, /net\.dns\.resolver\s+LEGACY/);
  assert.match(optionalConfig, /net\.dns\.prefer_ipv4\s+On/);
  const egress = named(resources, 'NetworkPolicy', 'allow-fluent-bit-datadog-egress');
  const receiver = named(resources, 'NetworkPolicy', 'allow-datadog-receiver');
  assert.ok(egress.spec.egress.some((rule) => rule.ports?.some((port) => port.port === 443)));
  assert.ok(egress.spec.egress.some((rule) => rule.ports?.some((port) => port.port === 53)
    && rule.to?.some((peer) => peer.ipBlock?.cidr === '10.96.0.10/32')));
  assert.match(JSON.stringify(egress), /datadog-receiver/);
  assert.match(JSON.stringify(receiver), /fluent-bit/);
});

test('creates the opt-in key from private file input and has a private live verifier', () => {
  const lifecycle = readFileSync('scripts/kfive-kind-up.sh', 'utf8');
  assert.match(lifecycle, /--with-datadog/);
  assert.match(lifecycle, /k8s\/observability-datadog/);
  assert.match(lifecycle, /create secret generic kfive-datadog/);
  assert.match(lifecycle, /--from-file=DD_API_KEY=/);
  assert.doesNotMatch(lifecycle, /echo.*DD_API_KEY/);
  assert.match(readFileSync('.env.example', 'utf8'), /DD_API_KEY=\s*(?:\n|$)/);

  const verifier = readFileSync('scripts/verify-datadog-live.cjs', 'utf8');
  assert.match(verifier, /datadog-receiver/);
  assert.match(verifier, /kfive-datadog/);
  assert.match(verifier, /DD_API_KEY/);
  assert.match(verifier, /finally[\s\S]*(?:delete|cleanup)/);
  assert.match(verifier, /Refusing to replace pre-existing Datadog verification resource/);
  assert.match(verifier, /exec[\s\S]*deployment\/datadog-receiver[\s\S]*127\.0\.0\.1:8080\/summary/);
  assert.doesNotMatch(verifier, /deployment\/backend[\s\S]*datadog-receiver/);
  assert.match(verifier, /networkpolicy\/allow-fluent-bit-datadog-egress/);
  assert.match(verifier, /networkpolicy\/allow-datadog-receiver/);
  assert.match(verifier, /deliveryAccepted/);
  assert.match(verifier, /requestPath === '\/api\/v2\/logs'/);
  assert.match(verifier, /assertCollectorRestored\(\)/);
  assert.doesNotMatch(verifier, /console\.log\([^\n]*apiKey/i);
});
