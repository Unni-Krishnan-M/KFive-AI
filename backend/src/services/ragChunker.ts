export const RAG_MAX_SOURCE_BYTES = 65_536;
export const RAG_MAX_CHUNKS = 64;
export const RAG_CHUNK_CHARACTERS = 1_400;
export const RAG_CHUNK_OVERLAP = 200;

export interface RagChunk {
  index: number;
  text: string;
  startCharacter: number;
  endCharacter: number;
}

export class RagChunkError extends Error {
  readonly code = 'RAG_SOURCE_LIMIT_EXCEEDED';
  readonly statusCode = 413;
  readonly isOperational = true;

  constructor(message: string) {
    super(message);
    this.name = 'RagChunkError';
  }
}

export function normalizeRagContent(value: unknown): string {
  if (typeof value !== 'string') {
    throw new RagChunkError('Knowledge source content must be a string.');
  }
  if (value.includes('\0')) {
    throw new RagChunkError('Knowledge source content must not contain NUL bytes.');
  }
  const normalized = value.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  if (!normalized) throw new RagChunkError('Knowledge source content must not be empty.');
  if ([...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 && codePoint !== 9 && codePoint !== 10;
  })) {
    throw new RagChunkError('Knowledge source content contains unsupported control characters.');
  }
  if (Buffer.byteLength(normalized, 'utf8') > RAG_MAX_SOURCE_BYTES) {
    throw new RagChunkError(`Knowledge source content must contain at most ${RAG_MAX_SOURCE_BYTES} UTF-8 bytes.`);
  }
  return normalized;
}

function chooseBoundary(content: string, start: number, hardEnd: number): number {
  if (hardEnd === content.length) return hardEnd;
  const minimum = Math.min(hardEnd, start + Math.floor(RAG_CHUNK_CHARACTERS * 0.6));
  const paragraph = content.lastIndexOf('\n\n', hardEnd);
  if (paragraph >= minimum) return paragraph + 2;
  const line = content.lastIndexOf('\n', hardEnd);
  if (line >= minimum) return line + 1;
  const space = content.lastIndexOf(' ', hardEnd);
  return space >= minimum ? space + 1 : hardEnd;
}

export function chunkRagContent(value: unknown): RagChunk[] {
  const content = normalizeRagContent(value);
  const chunks: RagChunk[] = [];
  let start = 0;

  while (start < content.length) {
    const hardEnd = Math.min(content.length, start + RAG_CHUNK_CHARACTERS);
    const end = chooseBoundary(content, start, hardEnd);
    const text = content.slice(start, end).trim();
    if (text) chunks.push({ index: chunks.length, text, startCharacter: start, endCharacter: end });
    if (chunks.length > RAG_MAX_CHUNKS) {
      throw new RagChunkError(`Knowledge source content must produce at most ${RAG_MAX_CHUNKS} chunks.`);
    }
    if (end >= content.length) break;
    const nextStart = Math.max(start + 1, end - RAG_CHUNK_OVERLAP);
    start = nextStart;
  }

  return chunks;
}
