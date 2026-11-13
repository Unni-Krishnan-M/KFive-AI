'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { analyzeRepositoryZip } = require('../backend/dist/services/repositoryArchiveAnalyzer.js');

function makeHostileEndRecordCandidates() {
  const centralEntries = 65_534;
  const candidates = 2_978;
  const centralOffset = 4;
  const centralBytes = centralEntries * 46;
  const buffer = Buffer.alloc(centralOffset + centralBytes + 1 + candidates * 22);
  buffer.writeUInt32LE(0x04034b50, 0);
  for (let index = 0; index < centralEntries; index += 1) {
    buffer.writeUInt32LE(0x02014b50, centralOffset + index * 46);
  }
  const candidateStart = centralOffset + centralBytes + 1;
  for (let index = 0; index < candidates; index += 1) {
    const offset = candidateStart + index * 22;
    buffer.writeUInt32LE(0x06054b50, offset);
    buffer.writeUInt16LE(centralEntries, offset + 8);
    buffer.writeUInt16LE(centralEntries, offset + 10);
    buffer.writeUInt32LE(offset - centralOffset, offset + 12);
    buffer.writeUInt32LE(centralOffset, offset + 16);
    buffer.writeUInt16LE(buffer.length - offset - 22, offset + 20);
  }
  return { buffer, centralEntries, candidates };
}

async function main() {
  const fixture = makeHostileEndRecordCandidates();
  const started = performance.now();
  const timerLag = new Promise((resolve) => setTimeout(() => resolve(performance.now() - started), 0));
  let code;
  try {
    await analyzeRepositoryZip(fixture.buffer, 'hostile-end-records.zip', 'application/zip');
  } catch (error) {
    code = error && typeof error === 'object' ? error.code : undefined;
  }
  const analysisElapsedMs = performance.now() - started;
  const timerLagMs = await timerLag;
  assert.equal(code, 'INVALID_REPOSITORY_ARCHIVE');
  assert.ok(analysisElapsedMs < 250, `analysis blocked for ${analysisElapsedMs.toFixed(2)} ms`);
  assert.ok(timerLagMs < 250, `event loop blocked for ${timerLagMs.toFixed(2)} ms`);
  console.log(JSON.stringify({
    inputBytes: fixture.buffer.length,
    centralEntries: fixture.centralEntries,
    candidates: fixture.candidates,
    resultCode: code,
    analysisElapsedMs: Number(analysisElapsedMs.toFixed(3)),
    timerLagMs: Number(timerLagMs.toFixed(3)),
    ceilingMs: 250,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'verification failed');
  process.exitCode = 1;
});
