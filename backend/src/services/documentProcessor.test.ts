import { extractDocumentOcr, extractDocumentPdf, processStoredDocument, validateExtraction } from './documentProcessor';

describe('isolated document processor adapter', () => {
  it('validates bounded text/page count rather than trusting processor output', () => {
    expect(validateExtraction({ text: 'hello', pageCount: 2 })).toEqual({ text: 'hello', pageCount: 2 });
    for (const value of [{ text: 1, pageCount: 1 }, { text: 'x', pageCount: 501 }, { text: 'x'.repeat(1048577), pageCount: 1 }]) {
      expect(() => validateExtraction(value)).toThrow();
    }
  });
  it('reports missing configuration without reading files or parsing in API', async () => {
    await expect(extractDocumentPdf('/unreadable', undefined)).rejects.toThrow('Document processor is unavailable');
    await expect(extractDocumentOcr('/unreadable', 'image/png', undefined)).rejects.toThrow('OCR service is unavailable');
  });

  it('uses independently configured OCR for PDFs when text extraction is unavailable', async () => {
    const pdf = jest.fn();
    const ocr = jest.fn().mockResolvedValue({ text: 'scan', pageCount: 1 });
    await expect(processStoredDocument('/scan.pdf', 'application/pdf', undefined, 'http://ocr', pdf, ocr))
      .resolves.toEqual({ text: 'scan', pageCount: 1, ocrApplied: true });
    expect(pdf).not.toHaveBeenCalled();
    expect(ocr).toHaveBeenCalledWith('/scan.pdf', 'application/pdf', 'http://ocr');
  });

  it('requires OCR explicitly when configured PDF extraction returns no text', async () => {
    const pdf = jest.fn().mockResolvedValue({ text: '  ', pageCount: 1 });
    const ocr = jest.fn();
    await expect(processStoredDocument('/scan.pdf', 'application/pdf', 'http://pdf', undefined, pdf, ocr))
      .rejects.toThrow('OCR service is unavailable');
    expect(ocr).not.toHaveBeenCalled();
  });

  it('keeps text PDFs on the extraction path and falls back to OCR only when empty', async () => {
    const pdf = jest.fn()
      .mockResolvedValueOnce({ text: 'native text', pageCount: 2 })
      .mockResolvedValueOnce({ text: '', pageCount: 1 });
    const ocr = jest.fn().mockResolvedValue({ text: 'scan text', pageCount: 1 });
    await expect(processStoredDocument('/text.pdf', 'application/pdf', 'http://pdf', 'http://ocr', pdf, ocr))
      .resolves.toEqual({ text: 'native text', pageCount: 2, ocrApplied: false });
    await expect(processStoredDocument('/scan.pdf', 'application/pdf', 'http://pdf', 'http://ocr', pdf, ocr))
      .resolves.toEqual({ text: 'scan text', pageCount: 1, ocrApplied: true });
    expect(ocr).toHaveBeenCalledTimes(1);
  });
});
