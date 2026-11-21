'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const yaml = require('js-yaml');
const read = (file) => readFileSync(file, 'utf8');

test('Notebook lock contains unique exact versions and wheel hashes for every direct requirement', () => {
  const lock = read('services/notebook-runtime/requirements.lock');
  const records = new Map();
  for (const line of lock.split('\n').filter((s) => s && !s.startsWith('#'))) {
    const match = /^([a-z0-9-]+)==([A-Za-z0-9.!+_-]+) --hash=sha256:([a-f0-9]{64})$/.exec(line);
    assert.ok(match, 'all dependencies must have an exact version and local SHA-256');
    assert.ok(!records.has(match[1]), 'duplicate distribution');
    records.set(match[1], match[2]);
  }
  assert.ok(records.size > 10, 'include the transitive graph');
  for (const line of read('services/notebook-runtime/requirements.in').split('\n').filter((s) => s && !s.startsWith('#'))) {
    const [name, version] = line.split('==');
    assert.equal(records.get(name.toLowerCase().replace(/[_\.]+/g, '-')), version);
  }
  const dockerfile = read('services/notebook-runtime/Dockerfile');
  assert.match(dockerfile, /--require-hashes --only-binary=:all:/);
  assert.match(dockerfile, /-r requirements\.lock/);
  assert.doesNotMatch(dockerfile, /-r requirements\.in/);
  assert.match(dockerfile, /python:3\.12\.[0-9]+-slim-bookworm@sha256:[a-f0-9]{64}/);
});

test('direct Compose has no mutable notebook fallback and startup exports exact IDs', () => {
  const compose = yaml.load(read('docker-compose.yml'));
  for (const service of ['backend', 'notebook-worker']) {
    for (const key of ['NOTEBOOK_RUNTIME_IMAGE', 'NOTEBOOK_VERIFIER_IMAGE']) {
      assert.equal(compose.services[service].environment[key], '${' + key + ':-}');
    }
  }
  const script = read('scripts/kfive-up.sh');
  assert.match(script, /export NOTEBOOK_RUNTIME_IMAGE="\$runtime_id" NOTEBOOK_VERIFIER_IMAGE="\$verifier_id"/);
  assert.match(script, /\^sha256:\[a-f0-9\]\{64\}\$/);
  assert.match(script, /\$notebook_runtime_image != sha256:/);
  assert.match(script, /\$notebook_verifier_image != sha256:/);
});
