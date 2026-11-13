'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const yaml = require('js-yaml');

const SOCKET_PATH = '/run/kfive-repository-importer/importer.sock';
const SOCKET_MOUNT = '/run/kfive-repository-importer';

function assertImporter(service, socketVolume, production = false) {
  assert.equal(service.user, '10001:10002');
  assert.deepEqual(service.command, ['node', '--max-old-space-size=128', 'backend/dist/repositoryImporterServerMain.js']);
  assert.deepEqual(service.environment, {
    NODE_ENV: 'production',
    REPOSITORY_IMPORTER_SOCKET_PATH: SOCKET_PATH,
  });
  assert.deepEqual(service.volumes, [`${socketVolume}:${SOCKET_MOUNT}`]);
  assert.equal(service.network_mode, 'none');
  assert.equal(service.networks, undefined);
  assert.equal(service.ports, undefined);
  assert.equal(service.read_only, true);
  assert.deepEqual(service.tmpfs, ['/tmp:rw,noexec,nosuid,nodev,size=32m']);
  assert.equal(service.pids_limit, 48);
  assert.deepEqual(service.cap_drop, ['ALL']);
  assert.deepEqual(service.security_opt, ['no-new-privileges:true']);
  assert.deepEqual(service.ulimits, { core: 0 });
  assert.equal(service.stop_grace_period, '5s');
  assert.equal(service.restart, 'unless-stopped');
  assert.equal(service.init, true);
  assert.deepEqual(service.healthcheck.test, ['CMD', 'node', 'backend/dist/repositoryImporterHealthMain.js']);
  for (const forbidden of ['ports', 'secrets', 'configs', 'extra_hosts', 'depends_on', 'env_file']) {
    assert.equal(service[forbidden], undefined, `repository importer must not declare ${forbidden}`);
  }
  if (production) {
    assert.equal(service.deploy.resources.limits.cpus, '1.0');
    assert.equal(service.deploy.resources.limits.memory, '512M');
  } else {
    assert.equal(service.cpus, 1);
    assert.equal(service.mem_limit, '512m');
    assert.equal(service.build.target, 'repository-importer');
  }
}

function assertBackendSocket(service, socketVolume) {
  assert.equal(service.environment.REPOSITORY_IMPORTER_MODE, 'socket');
  assert.equal(service.environment.REPOSITORY_IMPORTER_SOCKET_PATH, SOCKET_PATH);
  assert.deepEqual(service.depends_on['repository-importer'], { condition: 'service_started' });
  assert.ok(service.volumes.includes(`${socketVolume}:${SOCKET_MOUNT}:ro`));
  assert.deepEqual(service.group_add, ['10002']);
  assert.ok(!service.volumes.some((mount) => String(mount).includes('/var/run/docker.sock')));
}

test('local Compose confines repository parsing to a networkless importer and a socket-only volume', () => {
  const model = yaml.load(readFileSync('docker-compose.yml', 'utf8'));
  assertImporter(model.services['repository-importer'], 'repository_importer_socket');
  assertBackendSocket(model.services.backend, 'repository_importer_socket');
  assert.deepEqual(model.volumes.repository_importer_socket, null);

  const dockerfile = readFileSync('backend/Dockerfile', 'utf8');
  assert.match(dockerfile, /groupadd --gid 10002 kfive-importer-socket/);
  assert.match(dockerfile, /useradd --uid 10001 --gid 10002[^\n]+kfive-importer/);
  assert.match(dockerfile, /chown 10001:10002 \/run\/kfive-repository-importer/);
  assert.match(dockerfile, /chmod 0770 \/run\/kfive-repository-importer/);
  assert.match(dockerfile, /FROM app-runtime AS repository-importer\s+USER 10001:10002\s+HEALTHCHECK NONE/);
});

test('production Compose keeps the importer socket ephemeral and outside backup data', () => {
  const model = yaml.load(readFileSync('docker-compose.production.yml', 'utf8'));
  assertImporter(model.services['repository-importer'], 'repository-importer-socket', true);
  assertBackendSocket(model.services.backend, 'repository-importer-socket');
  assert.equal(model.services['repository-importer'].image, model.services.backend.image);
  assert.deepEqual(model.volumes['repository-importer-socket'].labels, { 'com.kfive.ephemeral': 'true' });

  const backupSources = [
    'scripts/production-backup.cjs',
    'scripts/production-backup-lib.cjs',
    'scripts/production-restore.cjs',
  ].map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(backupSources, /repository[-_]importer/i);
});
