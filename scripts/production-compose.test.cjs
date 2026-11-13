'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const yaml = require('js-yaml');
const { parseEnvironmentFile, validateProductionEnvironment } = require('./production-environment.cjs');

const validEnvironment = Object.freeze({
  KFIVE_PRODUCTION_PROJECT: 'kfive-production',
  KFIVE_VOLUME_PREFIX: 'kfive-production',
  KFIVE_EDGE_BIND_ADDRESS: '127.0.0.1',
  KFIVE_EDGE_HTTP_PORT: '8080',
  KFIVE_MODE: 'remote',
  PUBLIC_BASE_URL: 'https://kfive.example.com',
  CORS_ORIGIN: 'https://kfive.example.com',
  AI_PROVIDER: 'openai-compatible',
  AI_DEFAULT_MODEL: 'remote-chat',
  TRUST_PROXY_HOPS: '2',
  OPENAI_BASE_URL: 'https://provider.example.com/v1',
  OPENAI_API_KEY: 'pk-live-0123456789abcdef',
  MONGO_ROOT_USERNAME: 'kfive_root',
  MONGO_ROOT_PASSWORD: 'mongo-password-0123456789',
  MONGO_DATABASE: 'kfive_ai',
  MONGO_APP_USERNAME: 'kfive',
  MONGO_APP_PASSWORD: 'app-password-9876543210',
  REDIS_PASSWORD: 'redis-password-0123456789',
  JWT_SECRET: '0123456789abcdefghijklmnopqrstuvwxyzAB',
  JWT_REFRESH_SECRET: 'refresh-0123456789abcdefghijklmnopqrstuv',
  JWT_EXPIRES_IN: '15m',
  JWT_REFRESH_EXPIRES_IN: '7d',
  KFIVE_BACKEND_IMAGE: `registry.example.com/kfive/backend@sha256:${'123456789abcdef0'.repeat(4)}`,
  KFIVE_FRONTEND_IMAGE: `registry.example.com/kfive/frontend@sha256:${'23456789abcdef01'.repeat(4)}`,
  KFIVE_MONGODB_IMAGE: `mongo@sha256:${'3456789abcdef012'.repeat(4)}`,
  KFIVE_REDIS_IMAGE: `redis@sha256:${'456789abcdef0123'.repeat(4)}`,
  KFIVE_CHROMADB_IMAGE: `chromadb/chroma@sha256:${'56789abcdef01234'.repeat(4)}`,
});

test('production template is tracked while secret environment files stay outside Docker contexts', () => {
  assert.throws(() => execFileSync('git', ['check-ignore', '-q', '.env.production.example']));
  assert.ok(readFileSync('.env.production.example', 'utf8').includes('KFIVE_MODE=remote'));
  const dockerIgnore = readFileSync('.dockerignore', 'utf8');
  assert.match(dockerIgnore, /^\.env\.\*$/m);
  assert.match(dockerIgnore, /^!\.env\.production\.example$/m);
  for (const pattern of ['core', 'core.*', '*.core']) {
    assert.ok(dockerIgnore.split(/\r?\n/).includes(pattern), `${pattern} must stay outside Docker contexts`);
  }
});

test('production environment requires remote HTTPS topology and immutable images', () => {
  assert.deepEqual(validateProductionEnvironment(validEnvironment), {
    mode: 'remote', provider: 'openai-compatible', publicOrigin: 'https://kfive.example.com',
  });
  for (const patch of [
    { KFIVE_MODE: 'local' },
    { PUBLIC_BASE_URL: 'http://kfive.example.com', CORS_ORIGIN: 'http://kfive.example.com' },
    { CORS_ORIGIN: 'https://other.example.com' },
    { KFIVE_EDGE_BIND_ADDRESS: '0.0.0.0' },
    { KFIVE_EDGE_HTTP_PORT: '80' },
    { TRUST_PROXY_HOPS: '1' },
    { OPENAI_BASE_URL: 'http://provider.example.com/v1' },
    { MONGO_APP_USERNAME: validEnvironment.MONGO_ROOT_USERNAME },
    { MONGO_APP_PASSWORD: validEnvironment.MONGO_ROOT_PASSWORD },
    { JWT_SECRET: validEnvironment.JWT_REFRESH_SECRET },
    { JWT_EXPIRES_IN: '120' },
    { JWT_EXPIRES_IN: '25h' },
    { JWT_REFRESH_EXPIRES_IN: '30s' },
    { JWT_REFRESH_EXPIRES_IN: '31d' },
    { KFIVE_BACKEND_IMAGE: 'registry.example.com/kfive/backend:latest' },
  ]) {
    assert.throws(() => validateProductionEnvironment({ ...validEnvironment, ...patch }));
  }
});

test('production environment file rejects Compose interpolation and ambiguous syntax', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'kfive-production-env-'));
  try {
    for (const value of ['${HOST_SECRET}', '"quoted-value"', 'value with spaces', 'value\\with-escape']) {
      const file = path.join(directory, `case-${cryptoSafeName(value)}.env`);
      writeFileSync(file, `JWT_SECRET=${value}\n`, {mode: 0o600});
      assert.throws(() => parseEnvironmentFile(file));
    }
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

function cryptoSafeName(value) {
  return Buffer.from(value).toString('hex');
}

test('production compose publishes only a loopback frontend and isolates persistent data', () => {
  const model = yaml.load(readFileSync('docker-compose.production.yml', 'utf8'));
  assert.deepEqual(Object.keys(model.services).sort(), ['backend', 'benchmark-worker', 'chromadb', 'frontend', 'mongodb', 'redis', 'repository-importer']);
  assert.deepEqual(model.services.frontend.ports, ['${KFIVE_EDGE_BIND_ADDRESS:-127.0.0.1}:${KFIVE_EDGE_HTTP_PORT:-8080}:8080']);
  for (const service of ['backend', 'benchmark-worker', 'mongodb', 'redis', 'chromadb', 'repository-importer']) {
    assert.equal(model.services[service].ports, undefined, `${service} must not publish a host port`);
  }
  assert.equal(model.networks['data-internal'].internal, true);
  assert.equal(model.networks['app-internal'].internal, true);
  assert.notEqual(model.networks.edge.internal, true);
  assert.deepEqual(model.services.frontend.networks.slice().sort(), ['app-internal', 'edge']);
  assert.deepEqual(model.services.mongodb.networks, ['data-internal']);
  assert.match(model.services.backend.environment.MONGODB_URL, /MONGO_APP_USERNAME/);
  assert.equal(model.services.backend.environment.JWT_EXPIRES_IN, '${JWT_EXPIRES_IN:-15m}');
  assert.equal(model.services.backend.environment.JWT_REFRESH_EXPIRES_IN, '${JWT_REFRESH_EXPIRES_IN:-7d}');
  assert.doesNotMatch(model.services.backend.environment.MONGODB_URL, /MONGO_ROOT_USERNAME/);
  assert.match(model.services['benchmark-worker'].environment.MONGODB_URL, /MONGO_APP_USERNAME/);
  assert.deepEqual(model.services.redis.networks, ['data-internal']);
  assert.deepEqual(model.services.chromadb.networks, ['data-internal']);
  assert.deepEqual(model.services.backend.networks.slice().sort(), ['app-internal', 'data-internal', 'provider-egress']);
  assert.deepEqual(model.services['benchmark-worker'].networks.slice().sort(), ['data-internal', 'provider-egress']);
  assert.equal(Object.values(model.services).filter((service) => service.networks?.includes('edge')).length, 1);
  for (const service of Object.values(model.services)) {
    assert.equal(service.restart, 'unless-stopped');
    assert.ok(service.deploy?.resources?.limits?.memory, 'every production service needs a memory limit');
    assert.ok(service.pids_limit > 0, 'every production service needs a PID limit');
    assert.deepEqual(service.security_opt, ['no-new-privileges:true']);
    assert.deepEqual(service.logging, {'driver': 'local', 'options': {'max-size': '10m', 'max-file': '5'}});
  }
  assert.deepEqual(Object.keys(model.volumes).sort(), ['backend-logs', 'backend-uploads', 'chromadb-data', 'mongodb-data', 'redis-data', 'repository-importer-socket']);
  for (const name of ['backend-logs', 'backend-uploads', 'chromadb-data', 'mongodb-data', 'redis-data']) {
    assert.match(model.volumes[name].name, /^\$\{KFIVE_VOLUME_PREFIX/);
  }
  assert.equal(model.volumes['repository-importer-socket'].name, '${KFIVE_PRODUCTION_PROJECT:-kfive-production}_repository_importer_socket');
  assert.deepEqual(model.volumes['repository-importer-socket'].labels, {'com.kfive.ephemeral': 'true'});

  const importer = model.services['repository-importer'];
  assert.equal(importer.image, model.services.backend.image);
  assert.equal(importer.user, '10001:10002');
  assert.deepEqual(importer.command, ['node', '--max-old-space-size=128', 'backend/dist/repositoryImporterServerMain.js']);
  assert.deepEqual(importer.environment, {
    NODE_ENV: 'production',
    REPOSITORY_IMPORTER_SOCKET_PATH: '/run/kfive-repository-importer/importer.sock',
  });
  assert.deepEqual(importer.volumes, ['repository-importer-socket:/run/kfive-repository-importer']);
  assert.equal(importer.network_mode, 'none');
  assert.equal(importer.networks, undefined);
  assert.equal(importer.read_only, true);
  assert.deepEqual(importer.tmpfs, ['/tmp:rw,noexec,nosuid,nodev,size=32m']);
  assert.equal(importer.init, true);
  assert.equal(importer.pids_limit, 48);
  assert.equal(importer.deploy.resources.limits.cpus, '1.0');
  assert.equal(importer.deploy.resources.limits.memory, '512M');
  assert.deepEqual(importer.cap_drop, ['ALL']);
  assert.deepEqual(importer.ulimits, {core: 0});
  assert.equal(importer.stop_grace_period, '5s');
  assert.deepEqual(importer.healthcheck.test, ['CMD', 'node', 'backend/dist/repositoryImporterHealthMain.js']);
  for (const forbidden of ['ports', 'secrets', 'configs', 'extra_hosts', 'depends_on']) {
    assert.equal(importer[forbidden], undefined, `repository importer must not declare ${forbidden}`);
  }

  const backend = model.services.backend;
  assert.equal(backend.environment.REPOSITORY_IMPORTER_MODE, 'socket');
  assert.equal(backend.environment.REPOSITORY_IMPORTER_SOCKET_PATH, '/run/kfive-repository-importer/importer.sock');
  assert.deepEqual(backend.depends_on['repository-importer'], {condition: 'service_started'});
  assert.ok(backend.volumes.includes('repository-importer-socket:/run/kfive-repository-importer:ro'));
  assert.deepEqual(backend.group_add, ['10002']);

  const backupSources = [
    readFileSync('scripts/production-backup.cjs', 'utf8'),
    readFileSync('scripts/production-backup-lib.cjs', 'utf8'),
    readFileSync('scripts/production-restore.cjs', 'utf8'),
  ].join('\n');
  assert.doesNotMatch(backupSources, /repository[-_]importer/i, 'ephemeral importer socket must stay outside backup and restore sets');
  const mongoInitializer = readFileSync('deploy/mongodb/init-app-user.js', 'utf8');
  assert.match(mongoInitializer, /createUser/);
  assert.match(mongoInitializer, /role: 'readWrite'/);
  const acceptance = yaml.load(readFileSync('docker-compose.production.acceptance.yml', 'utf8'));
  assert.match(acceptance.services['remote-provider-fixture'].environment.FIXTURE_BEARER_TOKEN, /KFIVE_FIXTURE_BEARER_TOKEN/);
  assert.match(acceptance.services.backend.environment.OPENAI_API_KEY, /KFIVE_FIXTURE_BEARER_TOKEN/);
  assert.doesNotMatch(acceptance.services['remote-provider-fixture'].environment.FIXTURE_BEARER_TOKEN, /OPENAI_API_KEY/);
});

test('production lifecycle validates configuration and live verifier is explicitly destructive', () => {
  const up = readFileSync('scripts/kfive-production-up.sh', 'utf8');
  assert.match(up, /production-environment\.cjs/);
  assert.match(up, /docker-compose\.production\.yml/);
  assert.doesNotMatch(up, /--remove-orphans|down -v|down --volumes/);
  const verifier = readFileSync('scripts/verify-production-compose-live.cjs', 'utf8');
  assert.match(verifier, /--allow-live-test/);
  assert.match(verifier, /openai-compatible/);
  assert.match(verifier, /TRUST_PROXY_HOPS=1/);
  assert.match(verifier, /restart/);
  assert.match(verifier, /finally/);
});

