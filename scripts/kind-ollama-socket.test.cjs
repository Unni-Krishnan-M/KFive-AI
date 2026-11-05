const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { afterEach, test } = require('node:test');

const scratch = [];
afterEach(() => {
  for (const entry of scratch.splice(0)) fs.rmSync(entry, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kfive-socket-test-'));
  scratch.push(root);
  return { root, directory: path.join(root, 'socket') };
}

test('creates an owned private directory and stable identity marker', () => {
  const { prepareSocketDirectory } = require('./kind-ollama-socket.cjs');
  const f = fixture();
  const first = prepareSocketDirectory(f.directory, process.getuid());
  const second = prepareSocketDirectory(f.directory, process.getuid());
  assert.equal(second, first);
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.directory, '.kfive-owned')).mode & 0o777, 0o600);
});

test('rejects a symlink and unsafe pre-existing directory', () => {
  const { prepareSocketDirectory } = require('./kind-ollama-socket.cjs');
  const f = fixture();
  fs.mkdirSync(f.directory, { mode: 0o700 });
  const link = path.join(f.root, 'link');
  fs.symlinkSync(f.directory, link);
  assert.throws(() => prepareSocketDirectory(link, process.getuid()), /symbolic link/);
  assert.throws(() => prepareSocketDirectory(f.directory, process.getuid()), /identity marker/);
});

test('cleanup refuses a symlink and removes only verified owned entries', () => {
  const { cleanupSocketDirectory, prepareSocketDirectory } = require('./kind-ollama-socket.cjs');
  const f = fixture();
  prepareSocketDirectory(f.directory, process.getuid());
  fs.writeFileSync(path.join(f.directory, 'unrelated'), 'keep');
  assert.throws(() => cleanupSocketDirectory(f.directory, process.getuid()), /not empty/);
  assert.ok(fs.existsSync(path.join(f.directory, 'unrelated')));

  const link = path.join(f.root, 'link');
  fs.symlinkSync(f.directory, link);
  assert.throws(() => cleanupSocketDirectory(link, process.getuid()), /symbolic link/);
});

test('recognizes only an empty overflow-owned Docker restart orphan', () => {
  const { inspectDockerOrphan } = require('./kind-ollama-socket.cjs');
  const f = fixture();
  fs.mkdirSync(f.directory, { mode: 0o755 });
  inspectDockerOrphan(f.directory, process.getuid());
  fs.writeFileSync(path.join(f.directory, 'foreign'), 'keep');
  assert.throws(() => inspectDockerOrphan(f.directory, process.getuid()), /must be empty/);
  fs.unlinkSync(path.join(f.directory, 'foreign'));
  fs.chmodSync(f.directory, 0o700);
  assert.throws(() => inspectDockerOrphan(f.directory, process.getuid()), /mode 0755/);
});

test('kind teardown validates and removes the socket directory before deleting its mounted node', () => {
  const lifecycle = readFileSync('scripts/kfive-kind-down.sh', 'utf8');
  const cleanup = lifecycle.indexOf('kind-ollama-socket.cjs cleanup');
  const deleteCluster = lifecycle.indexOf('kind delete cluster');
  assert.ok(cleanup >= 0, 'socket cleanup command missing');
  assert.ok(deleteCluster >= 0, 'kind deletion command missing');
  assert.ok(cleanup < deleteCluster, 'mounted socket directory must be cleaned before deleting the kind node');
  assert.match(lifecycle, /Refusing to delete the kind node after unsafe socket cleanup/);
  assert.match(lifecycle, /inspect-docker-orphan.* 0/);
  assert.match(lifecycle, /orphan_valid=0[\s\S]*attempt in \{1\.\.5\}/);
  assert.match(lifecycle, /kind node lacks the exact read-only orphaned socket bind mount/);
  assert.match(lifecycle, /--user 0:0[\s\S]*--entrypoint \/bin\/rmdir/);
  assert.match(lifecycle, /orphan_remove_status=0[\s\S]*Docker orphan cleanup did not remove/);
});
