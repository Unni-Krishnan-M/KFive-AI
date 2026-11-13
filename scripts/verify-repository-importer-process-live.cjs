'use strict';

const assert = require('node:assert/strict');
const { deflateRawSync } = require('node:zlib');
const { analyzeRepositoryZip } = require('../backend/dist/services/repositoryArchiveAnalyzer.js');
const { createIsolatedRepositoryZipAnalyzer } = require('../backend/dist/services/repositoryArchiveIsolation.js');
const { validateRepositoryArchiveReport } = require('../backend/dist/services/repositoryArchiveIsolationProtocol.js');
let currentStage = 'startup';

function crc32(content) {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(name, content, flags = 0) {
  const nameBytes = Buffer.from(name); const source = Buffer.from(content); const compressed = deflateRawSync(source);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(source), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(source.length, 22); local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(source), 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(source.length, 24); central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12); end.writeUInt32LE(local.length + nameBytes.length + compressed.length, 16);
  return Buffer.concat([local, nameBytes, compressed, central, nameBytes, end]);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error && error.code !== 'ESRCH'; }
}

async function main() {
  currentStage = 'fixture';
  const zip = makeZip('package.json', JSON.stringify({ name: 'isolated-proof', dependencies: { react: '^19.0.0' } }));
  currentStage = 'direct';
  const direct = await analyzeRepositoryZip(zip, 'proof.zip', 'application/zip');
  assert.ok(validateRepositoryArchiveReport(direct, { buffer: zip, originalName: 'proof.zip', mimeType: 'application/zip' }), 'direct report failed isolation validation');
  const childPids = [];
  const isolated = createIsolatedRepositoryZipAnalyzer({ onSpawn: (pid) => childPids.push(pid) });
  let heartbeatTicks = 0;
  const heartbeat = setInterval(() => { heartbeatTicks += 1; }, 1);
  currentStage = 'concurrent-isolated';
  let first; let second;
  try {
    [first, second] = await Promise.all([
      isolated(zip, 'proof.zip', 'application/zip'),
      isolated(zip, 'proof.zip', 'application/zip'),
    ]);
  } finally { clearInterval(heartbeat); }
  currentStage = 'comparison';
  assert.deepEqual(first, direct); assert.deepEqual(second, direct);
  assert.equal(childPids.length, 2); assert.equal(new Set(childPids).size, 2);
  assert.ok(childPids.every((pid) => pid !== process.pid));
  assert.ok(heartbeatTicks > 0, 'parent event-loop heartbeat did not run');

  let encryptedCode;
  currentStage = 'encrypted';
  try { await isolated(makeZip('secret.txt', 'safe', 1), 'encrypted.zip', 'application/zip'); }
  catch (error) { encryptedCode = error && error.code; }
  assert.equal(encryptedCode, 'REPOSITORY_ARCHIVE_ENCRYPTED');
  await new Promise((resolve) => setTimeout(resolve, 25));
  currentStage = 'cleanup';
  assert.ok(childPids.every((pid) => !isAlive(pid)), 'an analyzer child remained after completion');

  console.log(JSON.stringify({
    parentPid: process.pid,
    childCount: childPids.length,
    distinctChildPids: new Set(childPids).size,
    heartbeatTicks,
    reportsMatchDirectAnalyzer: true,
    encryptedErrorPreserved: true,
    remainingChildren: childPids.filter(isAlive).length,
  }, null, 2));
}

main().catch((error) => {
  const reason = error && typeof error === 'object' && typeof error.reason === 'string' ? ` (${error.reason})` : '';
  const diagnostic = error && typeof error === 'object' && error.diagnostic ? ` ${JSON.stringify(error.diagnostic)}` : '';
  console.error(`${currentStage}: ${error instanceof Error ? error.message : 'verification failed'}${reason}${diagnostic}`);
  process.exitCode = 1;
});
