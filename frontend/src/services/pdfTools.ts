import { PDFDocument, degrees } from 'pdf-lib';

export const MIN_PDF_MERGE_FILES = 2;
export const MAX_PDF_MERGE_FILES = 10;
export const MAX_PDF_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PDF_AGGREGATE_BYTES = 75 * 1024 * 1024;
export const MAX_PDF_OUTPUT_BYTES = 100 * 1024 * 1024;
export const MAX_PDF_PAGE_COUNT = 500;
export const MAX_PDF_PAGE_SELECTION_CHARS = 4096;
export const MAX_PDF_PAGE_SELECTION_TOKENS = 500;
export const PDF_TOOL_GENERIC_ERROR = 'The PDF operation could not be completed. Try another valid PDF.';

export const PDF_TOOL_LIMITS = Object.freeze({
  minMergeFiles: MIN_PDF_MERGE_FILES,
  maxMergeFiles: MAX_PDF_MERGE_FILES,
  maxFileBytes: MAX_PDF_FILE_BYTES,
  maxAggregateBytes: MAX_PDF_AGGREGATE_BYTES,
  maxOutputBytes: MAX_PDF_OUTPUT_BYTES,
  maxPageCount: MAX_PDF_PAGE_COUNT,
  maxPageSelectionChars: MAX_PDF_PAGE_SELECTION_CHARS,
  maxPageSelectionTokens: MAX_PDF_PAGE_SELECTION_TOKENS,
});

export interface PdfInput {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface PdfToolResult {
  bytes: Uint8Array;
  pageCount: number;
}

export type PdfToolErrorCode =
  | 'INVALID_PAGE_SELECTION'
  | 'PAGE_SELECTION_TOO_LARGE'
  | 'PAGE_OUT_OF_RANGE'
  | 'INVALID_FILE'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'INVALID_PDF_SIGNATURE'
  | 'FILE_TOO_LARGE'
  | 'AGGREGATE_TOO_LARGE'
  | 'MERGE_FILE_COUNT'
  | 'PAGE_LIMIT_EXCEEDED'
  | 'OUTPUT_TOO_LARGE'
  | 'MALFORMED_PDF'
  | 'ENCRYPTED_PDF'
  | 'INVALID_ROTATION'
  | 'PROCESSING_FAILED';

export class PdfToolError extends Error {
  readonly name = 'PdfToolError';

  constructor(
    readonly code: PdfToolErrorCode,
    message: string
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(code: PdfToolErrorCode, message: string): never {
  throw new PdfToolError(code, message);
}

export interface BrowserPdfFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type BrowserPdfReadMode = 'merge' | 'single';

export function validateBrowserPdfFilesBeforeRead(
  files: readonly BrowserPdfFile[],
  mode: BrowserPdfReadMode
): void {
  if (!Array.isArray(files)) fail('INVALID_FILE', 'Choose a valid PDF file and try again.');
  if (mode === 'merge') {
    if (files.length < MIN_PDF_MERGE_FILES || files.length > MAX_PDF_MERGE_FILES) {
      fail('MERGE_FILE_COUNT', 'Choose between 2 and 10 PDF files to merge.');
    }
  } else if (files.length !== 1) {
    fail('INVALID_FILE', 'Choose one valid PDF file and try again.');
  }

  let aggregateBytes = 0;
  for (const file of files) {
    if (!file || typeof file.name !== 'string' || typeof file.type !== 'string'
      || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.arrayBuffer !== 'function') {
      fail('INVALID_FILE', 'Choose a valid PDF file and try again.');
    }
    if (!/\.pdf$/i.test(file.name) || (file.type !== '' && file.type.toLowerCase() !== 'application/pdf')) {
      fail('UNSUPPORTED_FILE_TYPE', 'Only files named .pdf with the PDF media type are supported.');
    }
    if (file.size > MAX_PDF_FILE_BYTES) {
      fail('FILE_TOO_LARGE', 'Each PDF must be 25 MiB or smaller.');
    }
    aggregateBytes += file.size;
    if (mode === 'merge' && aggregateBytes > MAX_PDF_AGGREGATE_BYTES) {
      fail('AGGREGATE_TOO_LARGE', 'The combined PDF input size must be 75 MiB or smaller.');
    }
  }
}

export async function readBrowserPdfInputs(
  files: readonly BrowserPdfFile[],
  mode: BrowserPdfReadMode
): Promise<PdfInput[]> {
  validateBrowserPdfFilesBeforeRead(files, mode);
  const inputs: PdfInput[] = [];
  for (const file of files) {
    try {
      inputs.push({
        name: file.name,
        mimeType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
    } catch {
      fail('INVALID_FILE', 'The selected PDF could not be read. Choose the file again and retry.');
    }
  }
  return inputs;
}

export function publicPdfToolError(error: unknown): string {
  return error instanceof PdfToolError ? error.message : PDF_TOOL_GENERIC_ERROR;
}

export function pdfOutputFilename(tool: 'merge' | 'extract' | 'rotate', inputName?: string): string {
  if (tool === 'merge') return 'kfive-merged.pdf';
  const rawBase = typeof inputName === 'string' ? inputName.replace(/\.pdf$/i, '') : '';
  const withoutControls = Array.from(rawBase.normalize('NFC'))
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return !(
        codePoint <= 0x1f
        || (codePoint >= 0x7f && codePoint <= 0x9f)
        || (codePoint >= 0x202a && codePoint <= 0x202e)
        || (codePoint >= 0x2066 && codePoint <= 0x2069)
      );
    })
    .join('');
  const normalized = withoutControls
    .replace(/[\\/]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  const base = Array.from(normalized || 'document').slice(0, 80).join('');
  return `${base}-${tool === 'extract' ? 'extracted' : 'rotated'}.pdf`;
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 5
    && bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46
    && bytes[4] === 0x2d;
}

function validateInput(input: PdfInput): void {
  if (!input || typeof input.name !== 'string' || typeof input.mimeType !== 'string'
    || !(input.bytes instanceof Uint8Array)) {
    fail('INVALID_FILE', 'Choose a valid PDF file and try again.');
  }
  if (!/\.pdf$/i.test(input.name) || (input.mimeType !== '' && input.mimeType.toLowerCase() !== 'application/pdf')) {
    fail('UNSUPPORTED_FILE_TYPE', 'Only files named .pdf with the PDF media type are supported.');
  }
  if (input.bytes.byteLength > MAX_PDF_FILE_BYTES) {
    fail('FILE_TOO_LARGE', 'Each PDF must be 25 MiB or smaller.');
  }
  if (!hasPdfSignature(input.bytes)) {
    fail('INVALID_PDF_SIGNATURE', 'The selected file does not have a valid PDF signature.');
  }
}

async function loadPdf(input: PdfInput): Promise<PDFDocument> {
  validateInput(input);
  const bytes = Uint8Array.from(input.bytes);
  try {
    const document = await PDFDocument.load(bytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    if (document.isEncrypted) {
      fail('ENCRYPTED_PDF', 'Password-protected PDFs are not supported. Remove the password and try again.');
    }
    const pageCount = document.getPageCount();
    if (pageCount < 1) {
      fail('MALFORMED_PDF', 'This PDF has no readable pages. Choose a valid PDF and try again.');
    }
    if (pageCount > MAX_PDF_PAGE_COUNT) {
      fail('PAGE_LIMIT_EXCEEDED', 'A PDF operation can include at most 500 pages.');
    }
    return document;
  } catch (error) {
    if (error instanceof PdfToolError) throw error;
    try {
      const encryptionProbe = await PDFDocument.load(Uint8Array.from(input.bytes), {
        ignoreEncryption: true,
        updateMetadata: false,
        throwOnInvalidObject: true,
      });
      if (encryptionProbe.isEncrypted) {
        fail('ENCRYPTED_PDF', 'Password-protected PDFs are not supported. Remove the password and try again.');
      }
    } catch (probeError) {
      if (probeError instanceof PdfToolError) throw probeError;
    }
    fail('MALFORMED_PDF', 'This PDF is malformed or unreadable. Choose a valid PDF and try again.');
  }
}

async function saveResult(document: PDFDocument, pageCount: number): Promise<PdfToolResult> {
  try {
    const bytes = await document.save();
    if (bytes.byteLength > MAX_PDF_OUTPUT_BYTES) {
      fail('OUTPUT_TOO_LARGE', 'The generated PDF exceeds the 100 MiB output limit.');
    }
    return { bytes: Uint8Array.from(bytes), pageCount };
  } catch (error) {
    if (error instanceof PdfToolError) throw error;
    fail('PROCESSING_FAILED', 'The PDF could not be processed. Try another valid PDF.');
  }
}

export function parsePageSelection(expression: string, pageCount: number): number[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_PDF_PAGE_COUNT) {
    fail('PAGE_OUT_OF_RANGE', 'The PDF page count is outside the supported range.');
  }
  if (typeof expression !== 'string') {
    fail('INVALID_PAGE_SELECTION', 'Enter page numbers such as 1,3-5 or all.');
  }
  if (expression.length > MAX_PDF_PAGE_SELECTION_CHARS) {
    fail('PAGE_SELECTION_TOO_LARGE', 'The page selection is too long. Use at most 4096 characters.');
  }
  const normalized = expression.trim().toLowerCase();
  if (normalized === 'all') return Array.from({ length: pageCount }, (_, index) => index);
  if (!normalized || normalized.includes('all')) {
    fail('INVALID_PAGE_SELECTION', 'Enter page numbers such as 1,3-5 or all.');
  }

  const orderedPages: number[] = [];
  const seen = new Set<number>();
  const tokens = normalized.split(',');
  if (tokens.length > MAX_PDF_PAGE_SELECTION_TOKENS) {
    fail('PAGE_SELECTION_TOO_LARGE', 'The page selection contains too many items. Use at most 500 items.');
  }
  for (const rawToken of tokens) {
    const token = rawToken.trim();
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token);
    if (!match) fail('INVALID_PAGE_SELECTION', 'Enter page numbers such as 1,3-5 or all.');
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < 1
      || start > pageCount || end > pageCount) {
      fail('PAGE_OUT_OF_RANGE', `Choose pages between 1 and ${pageCount}.`);
    }
    if (end < start) {
      fail('INVALID_PAGE_SELECTION', 'Page ranges must be written from lower to higher page numbers.');
    }
    for (let page = start; page <= end; page += 1) {
      const zeroBasedPage = page - 1;
      if (!seen.has(zeroBasedPage)) {
        seen.add(zeroBasedPage);
        orderedPages.push(zeroBasedPage);
      }
    }
  }
  return orderedPages;
}

export async function mergePdfs(inputs: readonly PdfInput[]): Promise<PdfToolResult> {
  if (!Array.isArray(inputs) || inputs.length < MIN_PDF_MERGE_FILES || inputs.length > MAX_PDF_MERGE_FILES) {
    fail('MERGE_FILE_COUNT', 'Choose between 2 and 10 PDF files to merge.');
  }
  inputs.forEach(validateInput);
  const aggregateBytes = inputs.reduce((total, input) => total + input.bytes.byteLength, 0);
  if (aggregateBytes > MAX_PDF_AGGREGATE_BYTES) {
    fail('AGGREGATE_TOO_LARGE', 'The combined PDF input size must be 75 MiB or smaller.');
  }

  const output = await PDFDocument.create();
  let pageCount = 0;
  try {
    for (const input of inputs) {
      const source = await loadPdf(input);
      const sourcePageCount = source.getPageCount();
      if (pageCount + sourcePageCount > MAX_PDF_PAGE_COUNT) {
        fail('PAGE_LIMIT_EXCEEDED', 'A merged PDF can include at most 500 pages.');
      }
      const pages = await output.copyPages(source, source.getPageIndices());
      pages.forEach((page) => output.addPage(page));
      pageCount += sourcePageCount;
    }
    return await saveResult(output, pageCount);
  } catch (error) {
    if (error instanceof PdfToolError) throw error;
    fail('PROCESSING_FAILED', 'The PDFs could not be merged. Try other valid PDF files.');
  }
}

export async function extractPdfPages(input: PdfInput, selection: string): Promise<PdfToolResult> {
  const source = await loadPdf(input);
  const pages = parsePageSelection(selection, source.getPageCount());
  const output = await PDFDocument.create();
  try {
    const copiedPages = await output.copyPages(source, pages);
    copiedPages.forEach((page) => output.addPage(page));
    return await saveResult(output, copiedPages.length);
  } catch (error) {
    if (error instanceof PdfToolError) throw error;
    fail('PROCESSING_FAILED', 'The selected pages could not be extracted. Try another valid PDF.');
  }
}

export async function rotatePdfPages(
  input: PdfInput,
  selection: string,
  angle: 90 | 180 | 270
): Promise<PdfToolResult> {
  if (angle !== 90 && angle !== 180 && angle !== 270) {
    fail('INVALID_ROTATION', 'Rotation must be 90, 180, or 270 degrees.');
  }
  const document = await loadPdf(input);
  const selectedPages = parsePageSelection(selection, document.getPageCount());
  try {
    for (const index of selectedPages) {
      const page = document.getPage(index);
      const existingAngle = ((page.getRotation().angle % 360) + 360) % 360;
      page.setRotation(degrees((existingAngle + angle) % 360));
    }
    return await saveResult(document, document.getPageCount());
  } catch (error) {
    if (error instanceof PdfToolError) throw error;
    fail('PROCESSING_FAILED', 'The selected pages could not be rotated. Try another valid PDF.');
  }
}
