import { PDFDocument, degrees } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_PDF_AGGREGATE_BYTES,
  MAX_PDF_FILE_BYTES,
  MAX_PDF_OUTPUT_BYTES,
  MAX_PDF_PAGE_SELECTION_CHARS,
  PdfInput,
  PdfToolError,
  extractPdfPages,
  deletePdfPages,
  mergePdfs,
  pdfOutputFilename,
  parsePageSelection,
  publicPdfToolError,
  readBrowserPdfInputs,
  rotatePdfPages,
  reorderPdfPages,
  duplicatePdfPages,
} from './pdfTools';

describe('duplicate PDF pages', () => {
  it('adds one independent adjacent copy per selected page and preserves input', async () => {
    const input = await makePdf('source.pdf', [[100, 200], [200, 300], [300, 400]], [90, 0, 180]);
    const original = Uint8Array.from(input.bytes);
    const result = await duplicatePdfPages(input, '3,1,1');
    const pdf = await PDFDocument.load(result.bytes);
    expect(result.pageCount).toBe(5);
    expect(pdf.getPages().map(page => [page.getWidth(), page.getRotation().angle])).toEqual([[100, 90], [100, 90], [200, 0], [300, 180], [300, 180]]);
    pdf.getPage(1).setRotation(degrees(270));
    expect(pdf.getPage(0).getRotation().angle).toBe(90);
    expect(input.bytes).toEqual(original);
  });

  it('supports all and rejects invalid or oversized selections', async () => {
    const input = await makePdf('source.pdf', [[100, 200]]);
    expect((await duplicatePdfPages(input, 'all')).pageCount).toBe(2);
    for (const selection of ['', '0', '2', '1,'.repeat(3000)]) {
      await expect(duplicatePdfPages(input, selection)).rejects.toBeInstanceOf(PdfToolError);
    }
    expect(pdfOutputFilename('duplicate', '../source.pdf')).toBe('-source-duplicated.pdf');
  });

  it('enforces the resulting page limit before copying', async () => {
    const input = await makePdf('source.pdf', Array.from({ length: 500 }, () => [10, 10] as const));
    const copy = vi.spyOn(PDFDocument.prototype, 'copyPages');
    try {
      await expect(duplicatePdfPages(input, '1')).rejects.toMatchObject({ code: 'PAGE_LIMIT_EXCEEDED' });
      expect(copy).not.toHaveBeenCalled();
    } finally { copy.mockRestore(); }
  });

  it('allows exactly 500 output pages', async () => {
    const input = await makePdf('source.pdf', Array.from({ length: 250 }, () => [10, 10] as const));
    const result = await duplicatePdfPages(input, 'all');
    expect(result.pageCount).toBe(500);
    expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(500);
  });
});

describe('reorder PDF pages', () => {
  it('copies every page exactly once in the requested order without changing input', async () => {
    const input = await makePdf('source.pdf', [[100, 200], [200, 300], [300, 400]], [0, 90, 180]);
    const original = Uint8Array.from(input.bytes);
    const result = await reorderPdfPages(input, '3,1-2');
    const reopened = await PDFDocument.load(result.bytes);
    expect(result.pageCount).toBe(3);
    expect(reopened.getPages().map(page => [page.getWidth(), page.getRotation().angle])).toEqual([[300, 180], [100, 0], [200, 90]]);
    expect(input.bytes).toEqual(original);
  });

  it('rejects missing, duplicated, and overlapping pages rather than silently extracting', async () => {
    const input = await makePdf('source.pdf', [[100, 200], [200, 300], [300, 400]]);
    for (const order of ['1,2', '1,2,3,1', '1-3,2', 'all,1']) {
      await expect(reorderPdfPages(input, order)).rejects.toBeInstanceOf(PdfToolError);
    }
  });

  it('supports unchanged all order and rejects invalid or excessive expressions', async () => {
    const input = await makePdf('source.pdf', [[100, 200]]);
    expect((await reorderPdfPages(input, 'all')).pageCount).toBe(1);
    for (const order of ['', '0', '2', '2-1', '1,'.repeat(3000)]) {
      await expect(reorderPdfPages(input, order)).rejects.toBeInstanceOf(PdfToolError);
    }
    expect(pdfOutputFilename('reorder', '../source.pdf')).toBe('-source-reordered.pdf');
  });
});

async function makePdf(
  name: string,
  pageSizes: ReadonlyArray<readonly [number, number]>,
  rotations: ReadonlyArray<number> = []
): Promise<PdfInput> {
  const document = await PDFDocument.create();
  pageSizes.forEach(([width, height], index) => {
    const page = document.addPage([width, height]);
    if (rotations[index] !== undefined) page.setRotation(degrees(rotations[index]));
  });
  return {
    name,
    mimeType: 'application/pdf',
    bytes: Uint8Array.from(await document.save({ useObjectStreams: false })),
  };
}

async function reload(bytes: Uint8Array): Promise<PDFDocument> {
  return await PDFDocument.load(Uint8Array.from(bytes));
}

function expectCode(code: PdfToolError['code']): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    expect(error).toBeInstanceOf(PdfToolError);
    expect((error as PdfToolError).code).toBe(code);
    return true;
  };
}

function expectSyncCode(action: () => unknown, code: PdfToolError['code']): void {
  try {
    action();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expectCode(code)(error);
  }
}

function replaceAscii(bytes: Uint8Array, before: string, after: string): Uint8Array {
  const encoder = new TextEncoder();
  const needle = encoder.encode(before);
  const replacement = encoder.encode(after);
  const index = bytes.findIndex((_, candidateIndex) =>
    candidateIndex + needle.length <= bytes.length
      && needle.every((value, offset) => bytes[candidateIndex + offset] === value));
  if (index < 0) throw new Error('Expected PDF trailer marker was not found.');
  const output = new Uint8Array(bytes.length - needle.length + replacement.length);
  output.set(bytes.subarray(0, index), 0);
  output.set(replacement, index);
  output.set(bytes.subarray(index + needle.length), index + replacement.length);
  return output;
}

describe('delete PDF pages', () => {
  it('applies signature validation and selection bounds before producing output', async () => {
    await expect(deletePdfPages({ name: 'bad.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) }, '1'))
      .rejects.toMatchObject({ code: 'INVALID_PDF_SIGNATURE' });
    const input = await makePdf('source.pdf', [[100, 200], [200, 300]]);
    await expect(deletePdfPages(input, '1'.repeat(MAX_PDF_PAGE_SELECTION_CHARS + 1)))
      .rejects.toMatchObject({ code: 'PAGE_SELECTION_TOO_LARGE' });
  });

  it('uses a safe descriptive filename and keeps the remaining boundary page', async () => {
    expect(pdfOutputFilename('delete', '../secret.pdf')).toBe('-secret-pages-removed.pdf');
    const result = await deletePdfPages(await makePdf('source.pdf', [[100, 200], [200, 300], [300, 400]]), '1-2');
    expect((await reload(result.bytes)).getPages().map(page => page.getWidth())).toEqual([300]);
  });

  it('removes selected pages while preserving remaining order, rotation and input bytes', async () => {
    const input = await makePdf('source.pdf', [[100, 200], [200, 300], [300, 400], [400, 500]], [90, 0, 180, 270]);
    const original = Uint8Array.from(input.bytes);
    const result = await deletePdfPages(input, '4,2,2');
    const document = await reload(result.bytes);
    expect(result.pageCount).toBe(2);
    expect(document.getPages().map(page => page.getWidth())).toEqual([100, 300]);
    expect(document.getPages().map(page => page.getRotation().angle)).toEqual([90, 180]);
    expect(input.bytes).toEqual(original);
  });

  it('rejects deleting every page, including a one-page source', async () => {
    const input = await makePdf('source.pdf', [[100, 200], [200, 300]]);
    await expect(deletePdfPages(input, 'all')).rejects.toMatchObject({ code: 'EMPTY_OUTPUT' });
    await expect(deletePdfPages(input, '2,1')).rejects.toMatchObject({ code: 'EMPTY_OUTPUT' });
    await expect(deletePdfPages(await makePdf('one.pdf', [[100, 200]]), '1')).rejects.toMatchObject({ code: 'EMPTY_OUTPUT' });
  });

  it('rejects invalid, out-of-range and empty selections', async () => {
    const input = await makePdf('source.pdf', [[100, 200], [200, 300]]);
    for (const selection of ['', '0', '3', '2-1', '1,,2']) {
      await expect(deletePdfPages(input, selection)).rejects.toBeInstanceOf(PdfToolError);
    }
  });
});

describe('page selection parsing', () => {
  it('supports all, ordered ranges, whitespace, and stable de-duplication', () => {
    expect(parsePageSelection('all', 4)).toEqual([0, 1, 2, 3]);
    expect(parsePageSelection(' 3, 1-2, 3, 2-4 ', 4)).toEqual([2, 0, 1, 3]);
  });

  it('rejects malformed, descending, zero, and out-of-range selections', () => {
    expectSyncCode(() => parsePageSelection('', 3), 'INVALID_PAGE_SELECTION');
    expectSyncCode(() => parsePageSelection('3-1', 3), 'INVALID_PAGE_SELECTION');
    expectSyncCode(() => parsePageSelection('1,,2', 3), 'INVALID_PAGE_SELECTION');
    expectSyncCode(() => parsePageSelection('0', 3), 'PAGE_OUT_OF_RANGE');
    expectSyncCode(() => parsePageSelection('4', 3), 'PAGE_OUT_OF_RANGE');
    expectSyncCode(() => parsePageSelection('1'.repeat(MAX_PDF_PAGE_SELECTION_CHARS + 1), 3), 'PAGE_SELECTION_TOO_LARGE');
    expectSyncCode(() => parsePageSelection(Array.from({ length: 501 }, () => '1').join(','), 3), 'PAGE_SELECTION_TOO_LARGE');
  });
});

describe('browser file preflight and public presentation', () => {
  const file = (overrides: Partial<{ name: string; type: string; size: number }> = {}) => ({
    name: 'input.pdf',
    type: 'application/pdf',
    size: 1024,
    arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode('%PDF-fixture').buffer),
    ...overrides,
  });

  it('rejects per-file and aggregate metadata before reading any bytes', async () => {
    const oversized = file({ size: MAX_PDF_FILE_BYTES + 1 });
    await expect(readBrowserPdfInputs([oversized], 'single')).rejects.toSatisfy(expectCode('FILE_TOO_LARGE'));
    expect(oversized.arrayBuffer).not.toHaveBeenCalled();

    const aggregateFiles = Array.from({ length: 4 }, (_, index) => file({
      name: `part-${index}.pdf`,
      size: Math.floor(MAX_PDF_AGGREGATE_BYTES / 4) + 1,
    }));
    await expect(readBrowserPdfInputs(aggregateFiles, 'merge')).rejects.toSatisfy(expectCode('AGGREGATE_TOO_LARGE'));
    aggregateFiles.forEach((candidate) => expect(candidate.arrayBuffer).not.toHaveBeenCalled());
  });

  it('reads accepted files sequentially and returns fresh byte views', async () => {
    const order: string[] = [];
    const first = file({ name: 'first.pdf' });
    const second = file({ name: 'second.pdf' });
    first.arrayBuffer.mockImplementation(async () => { order.push('first'); return new Uint8Array([1]).buffer; });
    second.arrayBuffer.mockImplementation(async () => { order.push('second'); return new Uint8Array([2]).buffer; });

    const inputs = await readBrowserPdfInputs([first, second], 'merge');

    expect(order).toEqual(['first', 'second']);
    expect(inputs.map((input) => [...input.bytes])).toEqual([[1], [2]]);
  });

  it('never exposes unexpected internal errors and sanitizes download names', () => {
    expect(publicPdfToolError(new Error('/private/path parser detail'))).toBe(
      'The PDF operation could not be completed. Try another valid PDF.'
    );
    expect(publicPdfToolError(new PdfToolError('INVALID_FILE', 'Safe public error.'))).toBe('Safe public error.');
    const filename = pdfOutputFilename('extract', '../unsafe\\name\n\u202eevil.pdf');
    expect(filename).toBe('-unsafe-nameevil-extracted.pdf');
    expect(filename).not.toMatch(/[\\/\n\u202e]/);
    expect(pdfOutputFilename('rotate', '.pdf')).toBe('document-rotated.pdf');
    expect(pdfOutputFilename('merge', '../ignored.pdf')).toBe('kfive-merged.pdf');
    expect(Array.from(pdfOutputFilename('extract', `${'a'.repeat(200)}.pdf`)).length).toBeLessThanOrEqual(94);
  });
});

describe('browser-local PDF operations', () => {
  it('merges files and pages in input order without mutating caller bytes', async () => {
    const first = await makePdf('first.pdf', [[100, 200], [110, 210]]);
    const second = await makePdf('second.pdf', [[300, 400]]);
    second.mimeType = '';
    const originalFirst = Uint8Array.from(first.bytes);
    const originalSecond = Uint8Array.from(second.bytes);

    const result = await mergePdfs([first, second]);
    const output = await reload(result.bytes);

    expect(result.pageCount).toBe(3);
    expect(output.getPages().map((page) => page.getSize())).toEqual([
      { width: 100, height: 200 },
      { width: 110, height: 210 },
      { width: 300, height: 400 },
    ]);
    expect(first.bytes).toEqual(originalFirst);
    expect(second.bytes).toEqual(originalSecond);
  });

  it('extracts selected pages in expression order and reloads the result', async () => {
    const input = await makePdf('source.pdf', [[100, 100], [200, 200], [300, 300]]);
    const original = Uint8Array.from(input.bytes);

    const result = await extractPdfPages(input, '3,1');
    const output = await reload(result.bytes);

    expect(result.pageCount).toBe(2);
    expect(output.getPages().map((page) => page.getWidth())).toEqual([300, 100]);
    expect(input.bytes).toEqual(original);
  });

  it('rotates only selected pages and normalizes existing rotation', async () => {
    const input = await makePdf('rotate.pdf', [[100, 100], [200, 200], [300, 300]], [270, 0, 90]);
    const original = Uint8Array.from(input.bytes);

    const result = await rotatePdfPages(input, '1,3', 90);
    const output = await reload(result.bytes);

    expect(result.pageCount).toBe(3);
    expect(output.getPages().map((page) => page.getRotation().angle)).toEqual([0, 0, 180]);
    expect(input.bytes).toEqual(original);
    await expect(rotatePdfPages(input, 'all', 45 as 90)).rejects.toSatisfy(expectCode('INVALID_ROTATION'));
  });
});

describe('PDF validation and safety limits', () => {
  it('rejects merge file-count, filename, MIME, signature, file-size, and aggregate-size violations', async () => {
    const valid = await makePdf('valid.pdf', [[100, 100]]);
    await expect(mergePdfs([valid])).rejects.toSatisfy(expectCode('MERGE_FILE_COUNT'));
    await expect(mergePdfs(Array.from({ length: 11 }, () => valid))).rejects.toSatisfy(expectCode('MERGE_FILE_COUNT'));
    await expect(mergePdfs([{ ...valid, name: 'valid.txt' }, valid])).rejects.toSatisfy(expectCode('UNSUPPORTED_FILE_TYPE'));
    await expect(mergePdfs([{ ...valid, mimeType: 'text/plain' }, valid])).rejects.toSatisfy(expectCode('UNSUPPORTED_FILE_TYPE'));
    await expect(mergePdfs([{ ...valid, bytes: new Uint8Array([1, 2, 3, 4, 5]) }, valid])).rejects.toSatisfy(expectCode('INVALID_PDF_SIGNATURE'));

    const oversized = new Uint8Array(MAX_PDF_FILE_BYTES + 1);
    oversized.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
    await expect(mergePdfs([{ ...valid, bytes: oversized }, valid])).rejects.toSatisfy(expectCode('FILE_TOO_LARGE'));

    const shared = new Uint8Array(Math.floor(MAX_PDF_AGGREGATE_BYTES / 4) + 1);
    shared.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
    await expect(mergePdfs(Array.from({ length: 4 }, (_, index) => ({
      name: `large-${index}.pdf`, mimeType: 'application/pdf', bytes: shared,
    })))).rejects.toSatisfy(expectCode('AGGREGATE_TOO_LARGE'));
  });

  it('rejects operations over 500 pages', async () => {
    const manyPages = await makePdf(
      'many.pdf',
      Array.from({ length: 501 }, (_, index) => [100 + (index % 3), 100] as const)
    );
    const valid = await makePdf('valid.pdf', [[100, 100]]);
    await expect(mergePdfs([manyPages, valid])).rejects.toSatisfy(expectCode('PAGE_LIMIT_EXCEEDED'));
  });

  it('rejects generated output over 100 MiB without allocating a large fixture', async () => {
    const first = await makePdf('first.pdf', [[100, 100]]);
    const second = await makePdf('second.pdf', [[200, 200]]);
    const save = vi.spyOn(PDFDocument.prototype, 'save').mockResolvedValue({
      byteLength: MAX_PDF_OUTPUT_BYTES + 1,
    } as Uint8Array);
    try {
      await expect(mergePdfs([first, second])).rejects.toSatisfy(expectCode('OUTPUT_TOO_LARGE'));
    } finally {
      save.mockRestore();
    }
  });

  it('returns generic actionable errors for malformed and encrypted PDFs', async () => {
    const valid = await makePdf('valid.pdf', [[100, 100]]);
    const malformed = {
      name: 'broken.pdf',
      mimeType: 'application/pdf',
      bytes: new TextEncoder().encode('%PDF-this-is-not-a-document'),
    };
    await expect(mergePdfs([malformed, valid])).rejects.toSatisfy((error: unknown) => {
      expectCode('MALFORMED_PDF')(error);
      expect((error as Error).message).toBe('This PDF is malformed or unreadable. Choose a valid PDF and try again.');
      expect((error as Error).message).not.toContain('PDFDocument.load');
      return true;
    });

    const encrypted = {
      ...valid,
      name: 'protected.pdf',
      bytes: replaceAscii(valid.bytes, '/Info 3 0 R\n>>', '/Info 3 0 R\n/Encrypt 3 0 R\n>>'),
    };
    await expect(mergePdfs([encrypted, valid])).rejects.toSatisfy((error: unknown) => {
      expectCode('ENCRYPTED_PDF')(error);
      expect((error as Error).message).toContain('Remove the password');
      expect((error as Error).message).not.toContain('ignoreEncryption');
      return true;
    });
  });
});
