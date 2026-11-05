const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { PDFDocument } = require('pdf-lib');

const execute = promisify(execFile);

async function register(base, prefix) {
  const name = `${prefix}_${randomBytes(6).toString('hex')}`;
  const response = await fetch(`${base}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, email: `${name}@example.test`, password: randomBytes(24).toString('hex') }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).data.accessToken;
}

async function upload(base, token, bytes, type, filename) {
  const form = new FormData();
  form.append('document', new Blob([bytes], { type }), filename);
  const response = await fetch(`${base}/documents`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  if (response.status !== 201) throw new Error(`Upload failed (${response.status}): ${await response.text()}`);
  const record = (await response.json()).data;
  assert.equal(record.status, 'completed', JSON.stringify(record));
  return record._id;
}

async function detail(base, token, id) {
  const response = await fetch(`${base}/documents/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

async function main() {
  assert.ok(process.argv.includes('--allow-live-test'), 'Pass --allow-live-test to create dedicated OCR fixtures.');
  const base = 'http://127.0.0.1:3002/api/v1';
  const directory = await mkdtemp(join(tmpdir(), 'kfive-ocr-live-'));
  const pngPath = join(directory, 'scan.png');
  const jpegPath = join(directory, 'scan.jpg');
  const marker = 'KFIVE OCR 92026';
  const ids = [];
  let ownerToken;
  try {
    await execute('convert', ['-size', '2400x700', 'xc:white', '-fill', 'black', '-font', 'DejaVu-Sans', '-pointsize', '120', '-gravity', 'center', '-annotate', '0', marker, '-define', 'png:compression-level=0', pngPath], { timeout: 10000 });
    await execute('convert', [pngPath, '-quality', '92', jpegPath], { timeout: 10000 });
    const png = await readFile(pngPath);
    const jpeg = await readFile(jpegPath);
    assert.ok(png.length > 1024 * 1024, `PNG fixture must exercise the production proxy body limit (${png.length} bytes)`);
    const pdf = await PDFDocument.create();
    const embedded = await pdf.embedPng(png);
    const page = pdf.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    const scannedPdf = Buffer.from(await pdf.save());

    ownerToken = await register(base, 'ocr_owner');
    const otherToken = await register(base, 'ocr_other');
    ids.push(await upload(base, ownerToken, png, 'image/png', 'ocr-image.png'));
    ids.push(await upload(base, ownerToken, jpeg, 'image/jpeg', 'ocr-image.jpg'));
    ids.push(await upload(base, ownerToken, scannedPdf, 'application/pdf', 'ocr-scanned.pdf'));

    for (const id of ids) {
      const record = await detail(base, ownerToken, id);
      assert.equal(record.ocrApplied, true);
      assert.equal(record.pageCount, 1);
      assert.match(record.content.replace(/\s+/g, ' ').trim(), /KFIVE OCR 92026/i);
      assert.equal((await fetch(`${base}/documents/${id}`, { headers: { Authorization: `Bearer ${otherToken}` } })).status, 404);
    }
    console.log(JSON.stringify({
      passed: true,
      pngBytes: png.length,
      pngDocumentId: ids[0],
      jpegDocumentId: ids[1],
      scannedPdfDocumentId: ids[2],
      marker,
    }));
  } finally {
    if (ownerToken) {
      for (const id of ids) await fetch(`${base}/documents/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ownerToken}` } });
    }
    await rm(directory, { recursive: true, force: true });
  }
  console.log('PASS: >1 MiB PNG OCR + JPEG OCR + raster-only PDF OCR -> persisted owner detail -> cross-owner denial -> cleanup.');
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
