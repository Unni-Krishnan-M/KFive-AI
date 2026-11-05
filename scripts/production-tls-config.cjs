#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseEnvironmentFile, validateProductionEnvironment } = require('./production-environment.cjs');

const TEMPLATE = path.resolve(__dirname, '..', 'deploy', 'tls', 'nginx.conf.template');
const MINIMUM_CERTIFICATE_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const TOKEN = /__KFIVE_[A-Z_]+__/g;

function exactPort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} must be a TCP port`);
  return port;
}

function publicOrigin(raw) {
  let value;
  try { value = new URL(raw); } catch { throw new Error('PUBLIC_BASE_URL must be an exact HTTPS origin'); }
  if (value.protocol !== 'https:' || value.username || value.password || value.hash || value.search
    || (value.pathname !== '/' && value.pathname !== '')) {
    throw new Error('PUBLIC_BASE_URL must be an exact HTTPS origin');
  }
  const domain = value.hostname.toLowerCase();
  const labels = domain.split('.');
  if (net.isIP(domain) || domain === 'localhost' || domain.endsWith('.localhost') || domain.endsWith('.local')
    || labels.length < 2 || domain.length > 253
    || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('PUBLIC_BASE_URL must use a DNS-shaped hostname');
  }
  return { domain, origin: value.origin, port: exactPort(value.port || '443', 'PUBLIC_BASE_URL port') };
}

function regularAbsoluteFile(file, label, { privatePermissions = false } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file || /[\x00-\x1f\x7f]/.test(file)) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if (privatePermissions && (stat.mode & 0o077) !== 0) throw new Error('TLS private key permissions must exclude group and other access');
  return file;
}

function safeConfigPath(file, label) {
  if (typeof file !== 'string' || !path.posix.isAbsolute(file) || path.posix.normalize(file) !== file
    || /[\s;{}$`"'\\\x00-\x1f\x7f]/.test(file)) {
    throw new Error(`${label} is unsafe for Nginx configuration`);
  }
  return file;
}

function upstream(host, port) {
  if (typeof host !== 'string' || host.length > 253 || net.isIP(host) && host !== '127.0.0.1'
    || (!net.isIP(host) && host.split('.').some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))) {
    throw new Error('TLS upstream host is unsafe');
  }
  return `${host}:${exactPort(port, 'TLS upstream port')}`;
}

function openssl(args) {
  return execFileSync('openssl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim();
}

function assertCertificateCurrentlyValid(output, now = Date.now()) {
  const match = /^notBefore=(.+)$/m.exec(output);
  const notBefore = match ? Date.parse(match[1]) : Number.NaN;
  if (!Number.isFinite(notBefore)) throw new Error('TLS certificate notBefore date is invalid');
  if (notBefore > now) throw new Error('TLS certificate is not valid yet');
}

function verifyCertificate(certificateFile, privateKeyFile, domain) {
  try {
    openssl(['x509', '-in', certificateFile, '-noout', '-checkhost', domain]);
  } catch { throw new Error(`TLS certificate hostname does not match ${domain}`); }
  try {
    openssl(['x509', '-in', certificateFile, '-noout', '-checkend', String(MINIMUM_CERTIFICATE_LIFETIME_SECONDS)]);
  } catch { throw new Error('TLS certificate is expired or expires within seven days'); }
  try {
    assertCertificateCurrentlyValid(openssl(['x509', '-in', certificateFile, '-noout', '-startdate']));
  } catch (error) {
    if (error instanceof Error && /notBefore|not valid yet/.test(error.message)) throw error;
    throw new Error('TLS certificate notBefore date is invalid');
  }
  let certificateKey;
  let privateKey;
  try {
    certificateKey = openssl(['x509', '-in', certificateFile, '-pubkey', '-noout']);
    privateKey = openssl(['pkey', '-in', privateKeyFile, '-pubout']);
  } catch { throw new Error('TLS certificate or private key is invalid'); }
  if (certificateKey !== privateKey) throw new Error('TLS certificate does not match the private key');
}

function createOutput(outputFile, content) {
  if (typeof outputFile !== 'string' || !path.isAbsolute(outputFile) || path.normalize(outputFile) !== outputFile
    || /[\x00-\x1f\x7f]/.test(outputFile)) {
    throw new Error('TLS output must be a normalized absolute path');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(outputFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error && error.code === 'EEXIST') throw new Error(`TLS output already exists: ${outputFile}`);
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function productionTlsContainerOptions(publicBaseUrl) {
  const { port: publicTlsPort } = publicOrigin(publicBaseUrl);
  return {
    httpListenPort: 8080,
    tlsListenPort: 8443,
    upstreamHost: 'frontend',
    upstreamPort: 8080,
    publicHttpPort: 80,
    publicTlsPort,
  };
}

function renderProductionTlsConfig(options) {
  const { domain, origin, port: publicTlsPort } = publicOrigin(options.publicBaseUrl);
  const certificateFile = regularAbsoluteFile(options.certificateFile, 'TLS certificate');
  const privateKeyFile = regularAbsoluteFile(options.privateKeyFile, 'TLS private key', { privatePermissions: true });
  verifyCertificate(certificateFile, privateKeyFile, domain);
  const outputFile = path.normalize(options.outputFile);
  const httpListenPort = exactPort(options.httpListenPort || 80, 'TLS edge HTTP listener');
  const tlsListenPort = exactPort(options.tlsListenPort || publicTlsPort, 'TLS edge HTTPS listener');
  if (httpListenPort === tlsListenPort) throw new Error('TLS edge HTTP and HTTPS listeners must be distinct');
  const values = {
    __KFIVE_DOMAIN__: domain,
    __KFIVE_PUBLIC_ORIGIN__: origin,
    __KFIVE_HTTP_LISTEN_PORT__: String(httpListenPort),
    __KFIVE_TLS_LISTEN_PORT__: String(tlsListenPort),
    __KFIVE_UPSTREAM__: upstream(options.upstreamHost || '127.0.0.1', options.upstreamPort || options.edgeHttpPort),
    __KFIVE_CERTIFICATE_FILE__: safeConfigPath(options.allowRuntimePathOverrides ? options.certificateConfigPath : certificateFile, 'TLS certificate path'),
    __KFIVE_PRIVATE_KEY_FILE__: safeConfigPath(options.allowRuntimePathOverrides ? options.privateKeyConfigPath : privateKeyFile, 'TLS private key path'),
  };
  let rendered = fs.readFileSync(TEMPLATE, 'utf8');
  for (const [token, value] of Object.entries(values)) rendered = rendered.split(token).join(value);
  if (TOKEN.test(rendered)) throw new Error('TLS template contains unresolved tokens');
  createOutput(outputFile, rendered);
  return { domain, publicOrigin: origin, httpListenPort, tlsListenPort, outputFile };
}

function cliArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--env-file', '--certificate', '--private-key', '--output'].includes(key) || !value) {
      throw new Error('Usage: production-tls-config.cjs --env-file <path> --certificate <path> --private-key <path> --output <path>');
    }
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate argument ${key}`);
    result[key] = value;
  }
  if (Object.keys(result).length !== 4) throw new Error('Usage: production-tls-config.cjs --env-file <path> --certificate <path> --private-key <path> --output <path>');
  return result;
}

if (require.main === module) {
  try {
    const args = cliArguments(process.argv.slice(2));
    const environment = parseEnvironmentFile(args['--env-file']);
    validateProductionEnvironment(environment);
    const runtime = productionTlsContainerOptions(environment.PUBLIC_BASE_URL);
    const result = renderProductionTlsConfig({
      publicBaseUrl: environment.PUBLIC_BASE_URL,
      ...runtime,
      certificateFile: path.resolve(args['--certificate']),
      privateKeyFile: path.resolve(args['--private-key']),
      certificateConfigPath: '/run/kfive-tls/certificate.crt',
      privateKeyConfigPath: '/run/kfive-tls/private.key',
      allowRuntimePathOverrides: true,
      outputFile: path.resolve(args['--output']),
    });
    process.stdout.write(`Created private TLS edge configuration for ${result.publicOrigin} at ${result.outputFile}; publish host ${runtime.publicHttpPort}->${result.httpListenPort} and ${runtime.publicTlsPort}->${result.tlsListenPort}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

module.exports = { assertCertificateCurrentlyValid, productionTlsContainerOptions, renderProductionTlsConfig };
