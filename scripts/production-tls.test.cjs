'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { assertCertificateCurrentlyValid, productionTlsContainerOptions, renderProductionTlsConfig } = require('./production-tls-config.cjs');

function generateCertificate(directory, domain, stem = 'leaf', days = 30) {
  const caKey = path.join(directory, `${stem}-ca.key`);
  const caCert = path.join(directory, `${stem}-ca.crt`);
  const key = path.join(directory, `${stem}.key`);
  const csr = path.join(directory, `${stem}.csr`);
  const cert = path.join(directory, `${stem}.crt`);
  const extensions = path.join(directory, `${stem}.ext`);
  fs.writeFileSync(extensions, `subjectAltName=DNS:${domain}\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', String(days),
    '-subj', `/CN=${stem} CA`, '-keyout', caKey, '-out', caCert], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${domain}`,
    '-keyout', key, '-out', csr], { stdio: 'ignore' });
  execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey,
    '-CAcreateserial', '-days', String(days), '-extfile', extensions, '-out', cert], { stdio: 'ignore' });
  fs.chmodSync(key, 0o600);
  return { cert, key };
}

test('TLS renderer validates identity and creates a fixed-origin hardened config', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kfive-tls-unit-'));
  fs.chmodSync(directory, 0o700);
  try {
    const domain = 'kfive.acceptance.invalid';
    const { cert, key } = generateCertificate(directory, domain);
    const output = path.join(directory, 'nginx.conf');
    const runtime = productionTlsContainerOptions(`https://${domain}:18443`);
    assert.deepEqual(runtime, {
      httpListenPort: 8080, tlsListenPort: 8443, upstreamHost: 'frontend', upstreamPort: 8080,
      publicHttpPort: 80, publicTlsPort: 18443,
    });
    const result = renderProductionTlsConfig({
      publicBaseUrl: `https://${domain}:18443`, ...runtime,
      certificateFile: cert, privateKeyFile: key, outputFile: output,
    });
    assert.deepEqual(result, { domain, publicOrigin: `https://${domain}:18443`, httpListenPort: 8080, tlsListenPort: 8443, outputFile: output });
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    const config = fs.readFileSync(output, 'utf8');
    assert.match(config, /listen 8080 default_server/);
    assert.match(config, /listen 8443 ssl default_server/);
    assert.match(config, /return 308 https:\/\/kfive\.acceptance\.invalid:18443\$request_uri/);
    assert.match(config, /proxy_pass http:\/\/frontend:8080/);
    assert.match(config, /ssl_protocols TLSv1\.2 TLSv1\.3/);
    assert.match(config, /Strict-Transport-Security/);
    assert.match(config, /proxy_set_header X-Forwarded-For \$remote_addr/);
    assert.doesNotMatch(config, /\$proxy_add_x_forwarded_for|__KFIVE_/);
    assert.throws(() => renderProductionTlsConfig({
      publicBaseUrl: `https://${domain}:18443`, edgeHttpPort: 18080,
      certificateFile: cert, privateKeyFile: key, outputFile: output,
    }), /already exists/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('TLS renderer rejects unsafe origin, identity, key, and output inputs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kfive-tls-reject-'));
  fs.chmodSync(directory, 0o700);
  try {
    const good = generateCertificate(directory, 'kfive.acceptance.invalid', 'good');
    const other = generateCertificate(directory, 'other.acceptance.invalid', 'other');
    const base = { edgeHttpPort: 18080, certificateFile: good.cert, privateKeyFile: good.key };
    assert.throws(() => renderProductionTlsConfig({ ...base, publicBaseUrl: 'http://kfive.acceptance.invalid', outputFile: path.join(directory, 'http.conf') }), /HTTPS origin/);
    assert.throws(() => renderProductionTlsConfig({ ...base, publicBaseUrl: 'https://localhost', outputFile: path.join(directory, 'localhost.conf') }), /DNS-shaped hostname/);
    assert.throws(() => renderProductionTlsConfig({ ...base, publicBaseUrl: 'https://127.0.0.1', outputFile: path.join(directory, 'ip.conf') }), /DNS-shaped hostname/);
    assert.throws(() => renderProductionTlsConfig({ ...base, publicBaseUrl: 'https://kfive.acceptance.invalid:80', outputFile: path.join(directory, 'listeners.conf') }), /listeners must be distinct/);
    assert.throws(() => renderProductionTlsConfig({ ...base, privateKeyFile: other.key, publicBaseUrl: 'https://kfive.acceptance.invalid', outputFile: path.join(directory, 'mismatch.conf') }), /does not match/);
    assert.throws(() => renderProductionTlsConfig({ ...base, certificateFile: other.cert, publicBaseUrl: 'https://kfive.acceptance.invalid', outputFile: path.join(directory, 'san.conf') }), /hostname/);
    fs.chmodSync(good.key, 0o644);
    assert.throws(() => renderProductionTlsConfig({ ...base, publicBaseUrl: 'https://kfive.acceptance.invalid', outputFile: path.join(directory, 'permissions.conf') }), /private key permissions/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('TLS certificate validity rejects a not-before time in the future', () => {
  assert.doesNotThrow(() => assertCertificateCurrentlyValid('notBefore=Oct 24 00:00:00 2026 GMT', Date.parse('2026-10-25T00:00:00Z')));
  assert.throws(() => assertCertificateCurrentlyValid('notBefore=Oct 26 00:00:00 2026 GMT', Date.parse('2026-10-25T00:00:00Z')), /not valid yet/);
  assert.throws(() => assertCertificateCurrentlyValid('notBefore=invalid', Date.parse('2026-10-25T00:00:00Z')), /notBefore/);
});

test('TLS template, live verifier, and package commands preserve the trust boundary', () => {
  const template = fs.readFileSync('deploy/tls/nginx.conf.template', 'utf8');
  assert.match(template, /return 421/);
  assert.match(template, /listen __KFIVE_HTTP_LISTEN_PORT__ default_server/);
  assert.match(template, /listen __KFIVE_TLS_LISTEN_PORT__ ssl default_server/);
  assert.match(template, /return 308 __KFIVE_PUBLIC_ORIGIN__\$request_uri/);
  assert.match(template, /ssl_reject_handshake on/);
  assert.match(template, /proxy_buffering off/);
  assert.match(template, /proxy_hide_header Strict-Transport-Security/);
  assert.match(template, /proxy_hide_header X-Content-Type-Options/);
  assert.match(template, /proxy_set_header Forwarded ""/);
  assert.match(template, /proxy_set_header X-Forwarded-Host ""/);
  assert.match(template, /proxy_set_header X-Forwarded-Port ""/);
  assert.doesNotMatch(template, /return 30[1278][^\n]*\$host|\$proxy_add_x_forwarded_for/);

  const verifier = fs.readFileSync('scripts/verify-production-tls-live.cjs', 'utf8');
  assert.match(verifier, /--allow-live-test/);
  assert.match(verifier, /rejectUnauthorized: true/);
  assert.match(verifier, /options\.all/);
  assert.doesNotMatch(verifier, /rejectUnauthorized:\s*false|--insecure|ignore-certificate-errors/);
  assert.match(verifier, /TRUST_PROXY_HOPS=2/);
  assert.match(verifier, /AUTH_RATE_LIMIT_EXCEEDED/);
  assert.match(verifier, /--no-healthcheck/);
  assert.match(verifier, /Healthcheck\?\.Test, \['NONE'\]/);
  assert.match(verifier, /State\.Health, undefined/);
  assert.match(verifier, /cleanupAuthorized = false/);
  assert.match(verifier, /if \(cleanupAuthorized\)/);
  assert.doesNotMatch(verifier, /down[^\n]*(?:-v|--volumes)|system[^\n]+prune/);

  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(packageJson.scripts['production:tls:render'], 'node scripts/production-tls-config.cjs');
  assert.equal(packageJson.scripts['production:verify:tls'], 'node scripts/verify-production-tls-live.cjs --allow-live-test');
  assert.match(packageJson.scripts['test:production'], /scripts\/production-tls\.test\.cjs/);
});
