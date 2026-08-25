import path from 'path';

const allowedMimeTypes = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/markdown',
  'text/csv',
  'image/jpeg',
  'image/png',
]);

export function isAllowedDocumentMime(mimeType: string): boolean {
  return allowedMimeTypes.has(mimeType);
}

export function sanitizeOriginalFilename(filename: string): string {
  const basename = [...path.basename(filename)]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join('')
    .trim();
  return (basename || 'document').slice(0, 200);
}

export function matchesFileSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType.startsWith('application/vnd.openxmlformats-officedocument.')) {
    return bytes[0] === 0x50 && bytes[1] === 0x4b;
  }
  if (mimeType.startsWith('text/')) return !bytes.subarray(0, 512).includes(0);
  return false;
}
