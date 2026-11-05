import axios from 'axios';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';

export interface PdfExtraction { text: string; pageCount: number }
export interface ProcessedDocument extends PdfExtraction { ocrApplied: boolean }
type SupportedDocumentMime = 'application/pdf' | 'image/png' | 'image/jpeg';
type PdfExtractor = typeof extractDocumentPdf;
type OcrExtractor = typeof extractDocumentOcr;

export function validateExtraction(value: unknown): PdfExtraction {
  const result = value as Partial<PdfExtraction> | null;
  if (!result || typeof result.text !== 'string' || Buffer.byteLength(result.text, 'utf8') > 1048576
    || !Number.isInteger(result.pageCount) || result.pageCount! < 1 || result.pageCount! > 500) {
    throw new Error('Document processor returned an invalid response');
  }
  return { text: result.text, pageCount: result.pageCount! };
}

export async function extractDocumentOcr(
  filePath: string,
  mimeType: 'application/pdf' | 'image/png' | 'image/jpeg',
  baseUrl?: string
): Promise<PdfExtraction> {
  if (!baseUrl) throw new Error('OCR service is unavailable');
  const file = await stat(filePath);
  if (!file.isFile() || file.size > 25 * 1024 * 1024) throw new Error('OCR input exceeds the 25 MiB processing limit');
  const stream = createReadStream(filePath);
  try {
    const response = await axios.post(`${baseUrl.replace(/\/$/, '')}/ocr`, stream, {
      headers: { 'Content-Type': mimeType, 'Content-Length': String(file.size) },
      timeout: 65000, maxRedirects: 0, maxBodyLength: 25 * 1024 * 1024,
      maxContentLength: 7 * 1024 * 1024, proxy: false,
    });
    return validateExtraction(response.data);
  } finally { stream.destroy(); }
}

export async function extractDocumentPdf(filePath: string, baseUrl?: string): Promise<PdfExtraction> {
  if (!baseUrl) throw new Error('Document processor is unavailable');
  const file = await stat(filePath);
  if (!file.isFile() || file.size > 25 * 1024 * 1024) throw new Error('PDF exceeds the 25 MiB processing limit');
  const stream = createReadStream(filePath);
  try {
    const response = await axios.post(`${baseUrl.replace(/\/$/, '')}/extract`, stream, {
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(file.size) },
      timeout: 20000, maxRedirects: 0, maxBodyLength: 25 * 1024 * 1024,
      maxContentLength: 7 * 1024 * 1024, proxy: false,
    });
    return validateExtraction(response.data);
  } finally { stream.destroy(); }
}

export async function processStoredDocument(
  filePath: string,
  mimeType: SupportedDocumentMime,
  documentProcessorUrl?: string,
  ocrServiceUrl?: string,
  extractPdf: PdfExtractor = extractDocumentPdf,
  extractOcr: OcrExtractor = extractDocumentOcr
): Promise<ProcessedDocument> {
  if (mimeType !== 'application/pdf') {
    const result = await extractOcr(filePath, mimeType, ocrServiceUrl);
    return { ...result, ocrApplied: true };
  }

  if (documentProcessorUrl) {
    const result = await extractPdf(filePath, documentProcessorUrl);
    if (result.text.trim()) return { ...result, ocrApplied: false };
    if (!ocrServiceUrl) throw new Error('OCR service is unavailable');
  } else if (!ocrServiceUrl) {
    throw new Error('Document processor is unavailable');
  }

  const result = await extractOcr(filePath, 'application/pdf', ocrServiceUrl);
  return { ...result, ocrApplied: true };
}
