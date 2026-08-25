import {
  chunkRagContent,
  normalizeRagContent,
  RAG_CHUNK_CHARACTERS,
  RAG_CHUNK_OVERLAP,
  RAG_MAX_CHUNKS,
  RAG_MAX_SOURCE_BYTES,
} from './ragChunker';

describe('RAG chunker', () => {
  it('normalizes line endings and creates deterministic bounded overlapping chunks', () => {
    const content = `${'alpha '.repeat(260)}\r\n\r\n${'beta '.repeat(260)}`;
    const first = chunkRagContent(content);
    const second = chunkRagContent(content);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(1);
    expect(first.length).toBeLessThanOrEqual(RAG_MAX_CHUNKS);
    expect(first.every((chunk) => chunk.text.length <= RAG_CHUNK_CHARACTERS)).toBe(true);
    expect(first[1].startCharacter).toBeLessThanOrEqual(first[0].endCharacter);
    expect(first[0].endCharacter - first[1].startCharacter).toBeLessThanOrEqual(RAG_CHUNK_OVERLAP);
  });

  it('enforces the UTF-8 byte limit, including multibyte input', () => {
    expect(() => normalizeRagContent('a'.repeat(RAG_MAX_SOURCE_BYTES + 1))).toThrow(/UTF-8 bytes/);
    expect(() => normalizeRagContent('😀'.repeat(Math.floor(RAG_MAX_SOURCE_BYTES / 4) + 1))).toThrow(/UTF-8 bytes/);
  });

  it('rejects NUL and disallowed C0 controls while preserving tab and newline', () => {
    expect(() => normalizeRagContent('safe\0unsafe')).toThrow(/NUL/);
    expect(() => normalizeRagContent('safe\u0001unsafe')).toThrow(/control/);
    expect(normalizeRagContent('safe\ttext\nnext')).toBe('safe\ttext\nnext');
  });
});
