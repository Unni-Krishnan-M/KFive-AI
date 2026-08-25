import { matchesFileSignature, sanitizeOriginalFilename } from './documentSecurity';

describe('document upload security helpers', () => {
  it('removes traversal and control characters from display filenames', () => {
    expect(sanitizeOriginalFilename('../../invoice\u0000.pdf')).toBe('invoice.pdf');
  });

  it('validates common signatures instead of trusting MIME alone', () => {
    expect(matchesFileSignature(Buffer.from('%PDF-1.7'), 'application/pdf')).toBe(true);
    expect(matchesFileSignature(Buffer.from('not a pdf'), 'application/pdf')).toBe(false);
    expect(matchesFileSignature(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
  });
});
