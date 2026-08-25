import { PDFDocument, degrees } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_PDF_AGGREGATE_BYTES,
  MAX_PDF_FILE_BYTES,
  MAX_PDF_OUTPUT_BYTES,
  PdfInput,
  PdfToolError,
  extractPdfPages,
  mergePdfs,
  parsePageSelection,
  rotatePdfPages,
} from './pdfTools';

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
