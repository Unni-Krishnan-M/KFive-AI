const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, writeFile, rm, unlink, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_OCR_PAGES = 25;
const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_RASTER_BYTES = 16 * 1024 * 1024;
const execute = promisify(execFile);

class ProcessingError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function extractPdf(bytes, { temporaryRoot = tmpdir(), run = execute, signal } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES) throw new ProcessingError('FILE_TOO_LARGE');
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new ProcessingError('INVALID_PDF');
  const directory = await mkdtemp(join(temporaryRoot, 'kfive-document-'));
  const file = join(directory, 'input.pdf');
  const started = Date.now();
  const options = maxBuffer => ({
    encoding: 'utf8', maxBuffer, timeout: Math.max(1, 15000 - (Date.now() - started)),
    killSignal: 'SIGKILL', signal, env: { PATH: '/usr/bin:/bin', LANG: 'C', HOME: directory },
  });
  try {
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    const metadata = await run('pdfinfo', [file], options(64 * 1024));
    if (/^Encrypted:\s+yes/m.test(metadata.stdout)) throw new ProcessingError('ENCRYPTED_PDF');
    const pageCount = Number(/^Pages:\s+(\d+)\s*$/m.exec(metadata.stdout)?.[1]);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new ProcessingError('INVALID_PDF');
    if (pageCount > 500) throw new ProcessingError('PAGE_LIMIT');
    const extracted = await run('pdftotext', ['-enc', 'UTF-8', '-layout', file, '-'], options(MAX_TEXT_BYTES));
    if (Buffer.byteLength(extracted.stdout, 'utf8') > MAX_TEXT_BYTES) throw new ProcessingError('TEXT_LIMIT');
    return { text: extracted.stdout, pageCount };
  } catch (error) {
    if (error instanceof ProcessingError) throw error;
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new ProcessingError('TEXT_LIMIT');
    if (error.killed || signal?.aborted) throw new ProcessingError('PROCESSING_TIMEOUT');
    throw new ProcessingError('INVALID_PDF');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function imageExtension(bytes, mimeType) {
  if (mimeType === 'image/png'
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (mimeType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') throw new ProcessingError('UNSUPPORTED_TYPE');
  throw new ProcessingError('INVALID_IMAGE');
}

function imageDimensions(bytes, mimeType) {
  let width;
  let height;
  if (mimeType === 'image/png' && bytes.length >= 24) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (mimeType === 'image/jpeg') {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = bytes.readUInt16BE(offset + 5);
        width = bytes.readUInt16BE(offset + 7);
        break;
      }
      offset += length + 2;
    }
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 10000 || height > 10000 || width * height > MAX_IMAGE_PIXELS) {
    throw new ProcessingError('IMAGE_DIMENSIONS');
  }
}

function ocrOptions(started, signal, maxBuffer = MAX_TEXT_BYTES, home = '/tmp') {
  return {
    encoding: 'utf8', maxBuffer, timeout: Math.max(1, 60000 - (Date.now() - started)),
    killSignal: 'SIGKILL', signal, env: { PATH: '/usr/bin:/bin', LANG: 'C', HOME: home },
  };
}

function mapOcrError(error, signal) {
  if (error instanceof ProcessingError) return error;
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new ProcessingError('TEXT_LIMIT');
  if (error.killed || signal?.aborted) return new ProcessingError('PROCESSING_TIMEOUT');
  return new ProcessingError('OCR_FAILED');
}

async function ocrImage(bytes, mimeType, { temporaryRoot = tmpdir(), run = execute, signal } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES) throw new ProcessingError('FILE_TOO_LARGE');
  const extension = imageExtension(bytes, mimeType);
  imageDimensions(bytes, mimeType);
  const directory = await mkdtemp(join(temporaryRoot, 'kfive-document-'));
  const file = join(directory, `input${extension}`);
  const started = Date.now();
  try {
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    const result = await run('tesseract', [file, 'stdout', '-l', 'eng', '--oem', '1', '--psm', '6'], ocrOptions(started, signal, MAX_TEXT_BYTES, directory));
    if (Buffer.byteLength(result.stdout, 'utf8') > MAX_TEXT_BYTES) throw new ProcessingError('TEXT_LIMIT');
    return { text: result.stdout, pageCount: 1, ocr: true };
  } catch (error) {
    throw mapOcrError(error, signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function ocrPdf(bytes, { temporaryRoot = tmpdir(), run = execute, signal } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES) throw new ProcessingError('FILE_TOO_LARGE');
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new ProcessingError('INVALID_PDF');
  const directory = await mkdtemp(join(temporaryRoot, 'kfive-document-'));
  const file = join(directory, 'input.pdf');
  const started = Date.now();
  try {
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    const metadata = await run('pdfinfo', [file], ocrOptions(started, signal, 64 * 1024, directory));
    if (/^Encrypted:\s+yes/m.test(metadata.stdout)) throw new ProcessingError('ENCRYPTED_PDF');
    const pageCount = Number(/^Pages:\s+(\d+)\s*$/m.exec(metadata.stdout)?.[1]);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new ProcessingError('INVALID_PDF');
    if (pageCount > MAX_OCR_PAGES) throw new ProcessingError('OCR_PAGE_LIMIT');
    const pages = [];
    let textBytes = 0;
    for (let page = 1; page <= pageCount; page += 1) {
      const prefix = join(directory, `page-${page}`);
      const image = `${prefix}.png`;
      await run('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '2500', '-gray', '-png', file, prefix], ocrOptions(started, signal, 64 * 1024, directory));
      try {
        const raster = await stat(image);
        if (!raster.isFile() || raster.size > MAX_RASTER_BYTES) throw new ProcessingError('IMAGE_DIMENSIONS');
        const result = await run('tesseract', [image, 'stdout', '-l', 'eng', '--oem', '1', '--psm', '6'], ocrOptions(started, signal, MAX_TEXT_BYTES - textBytes, directory));
        textBytes += Buffer.byteLength(result.stdout, 'utf8');
        if (textBytes > MAX_TEXT_BYTES) throw new ProcessingError('TEXT_LIMIT');
        pages.push(result.stdout);
      } finally {
        await unlink(image).catch(() => undefined);
      }
    }
    return { text: pages.join('\n\f\n'), pageCount, ocr: true };
  } catch (error) {
    throw mapOcrError(error, signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

module.exports = { extractPdf, ocrImage, ocrPdf, ProcessingError, MAX_FILE_BYTES, MAX_TEXT_BYTES, MAX_OCR_PAGES, MAX_IMAGE_PIXELS };
