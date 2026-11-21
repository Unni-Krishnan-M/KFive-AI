#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');

if (!process.argv.includes('--allow-live-test')) {
  console.error('Refusing the real Notebook AppArmor canary without --allow-live-test.');
  process.exit(2);
}
const { DockerNotebookExecutor } = require('../backend/dist/services/notebookExecution.js');

function docker(args) {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 64 * 1024 }).trim(); }
  catch { throw new Error('Docker canary operation failed (details suppressed).'); }
}
function ownedContainers() {
  return ['runtime', 'verifier'].map((role) => docker(['ps', '-aq', '--filter', `label=com.kfive.notebook-${role}=true`])).join('|');
}
async function main() {
  const runtimeImage = docker(['image', 'inspect', '--format', '{{.Id}}', 'kfive-notebook-runtime:locked']);
  const verifierImage = docker(['image', 'inspect', '--format', '{{.Id}}', 'kfive-notebook-verifier:locked']);
  assert.match(runtimeImage, /^sha256:[a-f0-9]{64}$/); assert.match(verifierImage, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(runtimeImage, verifierImage);
  const before = ownedContainers();
  const executor = new DockerNotebookExecutor(undefined, { runtimeImage, verifierImage, requireAppArmor: true, wallTimeoutMs: 60_000 });
  await executor.verifyHostSecurity();
  try {
    const output = await executor.execute({ runId: randomBytes(12).toString('hex'), cellTimeoutSeconds: 10,
      cells: [{ id: 'locked_canary', type: 'code', source: 'print("KFIVE_LOCKED_APPARMOR_OK")', tags: [] }] });
    assert.equal(output.status, 'succeeded'); assert.match(output.executedNotebookJson, /KFIVE_LOCKED_APPARMOR_OK/);
    console.log(JSON.stringify({ status: output.status, requireAppArmor: true, runtimeImage, verifierImage,
      runtimeImageId: output.runtimeImageId, verifierImageId: output.verifierImageId }));
  } finally {
    assert.equal(ownedContainers(), before, 'Notebook container cleanup changed the baseline set');
    console.log('EXACT_CONTAINER_CLEANUP_OK');
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : 'Notebook canary failed.'); process.exitCode = 1; });
