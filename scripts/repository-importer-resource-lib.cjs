'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { deflateRawSync } = require('node:zlib');

const MIB = 1024 * 1024;

function crc32(content) {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  assert.ok(Array.isArray(entries) && entries.length > 0 && entries.length <= 65_535);
  const localParts = []; const centralParts = []; let offset = 0; let declaredBytes = 0;
  let maximumEntryBytes = 0; let maximumPathBytes = 0; let compressedPayloadBytes = 0; let manifestCount = 0; let manifestBytes = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'); const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content || '');
    assert.ok(name.length > 0 && name.length <= 512); assert.ok(content.length <= 5 * MIB);
    const method = entry.method ?? 0; assert.ok(method === 0 || method === 8);
    const compressed = method === 8 ? deflateRawSync(content) : content;
    const local = Buffer.alloc(30); const central = Buffer.alloc(46); const checksum = crc32(content);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    localParts.push(local, name, compressed); centralParts.push(central, name); offset += local.length + name.length + compressed.length;
    declaredBytes += content.length; compressedPayloadBytes += compressed.length; maximumEntryBytes = Math.max(maximumEntryBytes, content.length);
    maximumPathBytes = Math.max(maximumPathBytes, name.length);
    if (path.posix.basename(entry.name) === 'package.json') { manifestCount += 1; manifestBytes += content.length; }
  }
  const centralBytes = centralParts.reduce((sum, part) => sum + part.length, 0); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes, 12); end.writeUInt32LE(offset, 16);
  return { archive: Buffer.concat([...localParts, ...centralParts, end]), entryCount: entries.length, manifestCount, manifestBytes,
    declaredBytes, maximumEntryBytes, maximumPathBytes, compressedPayloadBytes };
}

function longPath(index, basename) {
  return `src/${String(index).padStart(4, '0')}/${'p'.repeat(380)}/${basename}`;
}

function manifest(index) {
  const dependencies = {};
  for (let item = 0; item < 80; item += 1) {
    const digest = crypto.createHash('sha256').update(`manifest-${index}-dependency-${item}`).digest('hex');
    dependencies[`dep-${index}-${item}-${digest.slice(0, 16)}`] = `git+https://example.invalid/${digest}.git#${digest}`;
  }
  return Buffer.from(JSON.stringify({ name: `resource-${index}`, dependencies }));
}

function createNearMaximumFixture() {
  const target = Math.floor(9.25 * MIB); const entries = [];
  for (let index = 0; index < 20; index += 1) entries.push({ name: longPath(index, 'package.json'), content: manifest(index), method: 0 });
  for (let index = 20; index < 1_998; index += 1) entries.push({ name: longPath(index, `f-${index}.txt`), content: '', method: 0 });
  entries.push({ name: longPath(1_998, 'blob-a.bin'), content: '', method: 0 });
  entries.push({ name: longPath(1_999, 'blob-b.bin'), content: '', method: 0 });
  const empty = buildZip(entries); const required = target - empty.archive.length;
  assert.ok(required > 0 && Math.ceil(required / 2) <= 5 * MIB);
  entries[1_998].content = Buffer.alloc(Math.floor(required / 2), 0x61);
  entries[1_999].content = Buffer.alloc(Math.ceil(required / 2), 0x62);
  return buildZip(entries);
}

function createHostileFixtures() {
  const entryLimit = buildZip(Array.from({ length: 2_001 }, (_, index) => ({ name: `e/${index}.txt`, content: '' })));
  const ratioBomb = buildZip([{ name: 'ratio.txt', content: Buffer.alloc(2 * MIB, 0x61), method: 8 }]);
  const manifestLimit = buildZip(Array.from({ length: 21 }, (_, index) => ({ name: `${index}/package.json`, content: '{}' })));
  return { entryLimit, ratioBomb, manifestLimit };
}

function createMultipartParts({ name, filename, archive, boundary = `kfive-${crypto.randomBytes(12).toString('hex')}` }) {
  assert.match(boundary, /^kfive-[a-f0-9]+$/); assert.ok(Buffer.isBuffer(archive));
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, prefix, suffix, contentType: `multipart/form-data; boundary=${boundary}`, contentLength: prefix.length + archive.length + suffix.length };
}

function parseCgroupPath(input) {
  const lines = input.trim().split(/\r?\n/); if (lines.length !== 1) throw new Error('Invalid cgroup path.');
  const match = /^0::(\/[A-Za-z0-9_.\-/]+)$/.exec(lines[0]); if (!match || match[1].includes('..')) throw new Error('Invalid cgroup path.');
  return match[1];
}

function parseCounterFile(input) {
  const output = {};
  for (const line of input.trim().split(/\r?\n/)) {
    const match = /^([a-z_][a-z0-9_.]*) ([0-9]+)$/.exec(line); if (!match || Object.hasOwn(output, match[1])) throw new Error('Invalid cgroup counter file.');
    const value = Number(match[2]); if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid cgroup counter file.'); output[match[1]] = value;
  }
  return output;
}

function parseLimit(input) {
  const value = input.trim(); if (value === 'max') return Infinity;
  if (!/^[0-9]+$/.test(value)) throw new Error('Invalid cgroup limit.'); const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid cgroup limit.'); return parsed;
}

function parseCpuMax(input) {
  const match = /^([0-9]+) ([0-9]+)$/.exec(input.trim()); if (!match) throw new Error('CPU maximum must be finite.');
  const quota = Number(match[1]); const period = Number(match[2]); if (!Number.isSafeInteger(quota) || !Number.isSafeInteger(period) || quota <= 0 || period <= 0) throw new Error('CPU maximum must be finite.');
  return { quota, period };
}

function validateLoopbackApiUrl(value) {
  const url = new URL(value); const pathname = url.pathname.replace(/\/$/, '');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || pathname !== '/api/v1'
    || url.username || url.password || url.search || url.hash) throw new Error('The verifier requires a loopback API URL.');
  return url;
}

module.exports = { MIB, buildZip, createHostileFixtures, createNearMaximumFixture, createMultipartParts,
  parseCgroupPath, parseCounterFile, parseCpuMax, parseLimit, validateLoopbackApiUrl };
