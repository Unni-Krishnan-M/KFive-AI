const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { mkdtemp, readdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { extractPdf, ocrImage, ocrPdf } = require('./processor.cjs');

test('extracts actual PDF text and removes temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kfive-pdf-test-'));
  try {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText('KFive isolated extraction', { font });
    const result = await extractPdf(Buffer.from(await pdf.save()), { temporaryRoot: root });
    assert.equal(result.pageCount, 1);
    assert.match(result.text, /KFive isolated extraction/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects invalid signatures and oversize input before launching a parser', async () => {
  const run = async () => { throw Error('parser must not run'); };
  await assert.rejects(extractPdf(Buffer.from('not pdf'), { run }), { code: 'INVALID_PDF' });
  await assert.rejects(extractPdf(Buffer.alloc(25 * 1024 * 1024 + 1), { run }), { code: 'FILE_TOO_LARGE' });
});

test('bounds pages, rejects encryption, and cleans files on parser failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kfive-pdf-test-'));
  try {
    for (const [metadata, code] of [
      ['Pages: 501\nEncrypted: no\n', 'PAGE_LIMIT'],
      ['Pages: 1\nEncrypted: yes\n', 'ENCRYPTED_PDF'],
      ['invalid metadata', 'INVALID_PDF'],
    ]) {
      await assert.rejects(extractPdf(Buffer.from('%PDF-test'), {
        temporaryRoot: root, run: async () => ({ stdout: metadata }),
      }), { code });
      assert.deepEqual(await readdir(root), []);
    }
    await assert.rejects(extractPdf(Buffer.from('%PDF-test'), {
      temporaryRoot: root, run: async () => { throw Object.assign(Error('private path'), { killed: true }); },
    }), { code: 'PROCESSING_TIMEOUT' });
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('OCR accepts only bounded PNG/JPEG input and invokes fixed Tesseract arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kfive-ocr-test-'));
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    return { stdout: 'KFive image OCR\n' };
  };
  try {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(100, 16); png.writeUInt32BE(40, 20);
    assert.deepEqual(await ocrImage(png, 'image/png', { temporaryRoot: root, run }), {
      text: 'KFive image OCR\n', pageCount: 1, ocr: true,
    });
    assert.equal(calls[0].command, 'tesseract');
    assert.deepEqual(calls[0].args.slice(1), ['stdout', '-l', 'eng', '--oem', '1', '--psm', '6']);
    await assert.rejects(ocrImage(Buffer.from('not an image'), 'image/png', { temporaryRoot: root, run }), { code: 'INVALID_IMAGE' });
    await assert.rejects(ocrImage(png, 'image/gif', { temporaryRoot: root, run }), { code: 'UNSUPPORTED_TYPE' });
    const oversized = Buffer.from(png);
    oversized.writeUInt32BE(10000, 16); oversized.writeUInt32BE(10000, 20);
    await assert.rejects(ocrImage(oversized, 'image/png', { temporaryRoot: root, run }), { code: 'IMAGE_DIMENSIONS' });
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('OCR validates JPEG dimensions and maps parser failures to fixed codes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kfive-ocr-errors-'));
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    0x00, 0x28, 0x00, 0x64, 0x01, 0x01, 0x11, 0x00,
  ]);
  try {
    assert.equal((await ocrImage(jpeg, 'image/jpeg', { temporaryRoot: root, run: async () => ({ stdout: 'JPEG OCR' }) })).text, 'JPEG OCR');
    await assert.rejects(ocrImage(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg', { temporaryRoot: root, run: async () => ({ stdout: '' }) }), { code: 'IMAGE_DIMENSIONS' });
    for (const [error, code] of [
      [Object.assign(Error('timeout'), { killed: true }), 'PROCESSING_TIMEOUT'],
      [Object.assign(Error('large'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'TEXT_LIMIT'],
      [Error('private parser failure'), 'OCR_FAILED'],
    ]) {
      await assert.rejects(ocrImage(jpeg, 'image/jpeg', {
        temporaryRoot: root, run: async () => { throw error; },
      }), { code });
    }
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('OCR renders scanned PDF pages sequentially with bounded fixed arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kfive-ocr-pdf-test-'));
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (command === 'pdfinfo') return { stdout: 'Pages: 2\nEncrypted: no\n' };
    if (command === 'pdftoppm') {
      await writeFile(`${args.at(-1)}.png`, 'bounded raster');
      return { stdout: '' };
    }
    return { stdout: `OCR page ${calls.filter(call => call.command === 'tesseract').length}\n` };
  };
  try {
    const result = await ocrPdf(Buffer.from('%PDF-scanned'), { temporaryRoot: root, run });
    assert.deepEqual(result, { text: 'OCR page 1\n\n\f\nOCR page 2\n', pageCount: 2, ocr: true });
    const renders = calls.filter(call => call.command === 'pdftoppm');
    assert.equal(renders.length, 2);
    assert.deepEqual(renders.map(call => call.args.slice(0, 8)), [
      ['-f', '1', '-l', '1', '-singlefile', '-scale-to', '2500', '-gray'],
      ['-f', '2', '-l', '2', '-singlefile', '-scale-to', '2500', '-gray'],
    ]);
    assert.equal(calls.filter(call => call.command === 'tesseract').length, 2);
    assert.deepEqual(await readdir(root), []);
    await assert.rejects(ocrPdf(Buffer.from('%PDF-scanned'), {
      temporaryRoot: root,
      run: async command => ({ stdout: command === 'pdfinfo' ? 'Pages: 26\nEncrypted: no\n' : '' }),
    }), { code: 'OCR_PAGE_LIMIT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('OCR rejects encrypted and invalid PDF metadata before rendering', async () => {
  for (const [stdout, code] of [
    ['Pages: 1\nEncrypted: yes\n', 'ENCRYPTED_PDF'],
    ['Encrypted: no\n', 'INVALID_PDF'],
  ]) {
    await assert.rejects(ocrPdf(Buffer.from('%PDF-scan'), {
      run: async command => ({ stdout: command === 'pdfinfo' ? stdout : '' }),
    }), { code });
  }
});
