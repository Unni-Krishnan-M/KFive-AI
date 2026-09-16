import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_EXCERPT_LIMIT,
  canMutateKnowledge,
  canDeleteKnowledgeSource,
  effectiveKnowledgeProjectStatus,
  knowledgeHistoryScope,
  isKnowledgeRequestCurrent,
  knowledgeProjectPayload,
  nextKnowledgeRefreshDelay,
  normalizeKnowledgeQuery,
  normalizeKnowledgeSources,
  normalizeKnowledgeStatus,
  sourceMediaType,
  validateKnowledgeFile,
} from './knowledge';

describe('knowledge contract normalization', () => {
  it('accepts recovery only without any project or duplicate scope', () => {
    expect(knowledgeHistoryScope('', false)).toBe('workspace');
    expect(knowledgeHistoryScope('?scope=orphaned', false)).toBe('orphaned');
    for (const search of ['?scope=unknown', '?scope=', '?scope=orphaned&scope=orphaned', '?scope=orphaned&projectId=p1', '?scope=orphaned&projectId=', '?projectId=p1&projectId=p2']) {
      expect(knowledgeHistoryScope(search, false)).toBe('invalid');
    }
    expect(knowledgeHistoryScope('?scope=orphaned', true)).toBe('invalid');
  });

  it('rejects callbacks from earlier mounted scopes, including navigation back', () => {
    expect(isKnowledgeRequestCurrent(0, 0)).toBe(true);
    expect(isKnowledgeRequestCurrent(1, 0)).toBe(false);
    expect(isKnowledgeRequestCurrent(2, 0)).toBe(false);
    expect(isKnowledgeRequestCurrent(2, 2)).toBe(true);
  });

  it('does not invent dependency availability or capabilities', () => {
    expect(normalizeKnowledgeStatus({ data: {
      available: true,
      canIngest: true,
      canQuery: false,
      readySourceCount: 2,
      scope: 'project',
      capabilities: { ingest: true, query: false, claimed: 'yes' },
      dependencies: [
        { id: 'chromadb', status: 'healthy', message: 'Connected' },
        { status: 'ready' },
      ],
    } })).toEqual({
      available: true,
      canIngest: true,
      canQuery: false,
      readySourceCount: 2,
      scope: 'project',
      projectId: undefined,
      projectStatus: undefined,
      capabilities: { ingest: true, query: false },
      dependencies: [{ id: 'chromadb', status: 'available', message: 'Connected' }],
    });
    expect(normalizeKnowledgeStatus({ data: {} })).toMatchObject({ available: undefined, canIngest: false, canQuery: false });
  });

  it('normalizes the live nested dependency contract without inventing messages', () => {
    const normalized = normalizeKnowledgeStatus({ data: {
      canIngest: true, canQuery: true,
      scope: { type: 'project', projectId: 'project-1', projectStatus: 'active' },
      dependencies: {
        embeddingModel: { configured: true, model: 'nomic-embed-text' },
        provider: { id: 'ollama', embeddingsSupported: true, available: true },
        chroma: { configured: false, available: false, code: 'RAG_VECTOR_STORE_UNAVAILABLE' },
      },
    } });
    expect(normalized.scope).toBe('project');
    expect(normalized.projectId).toBe('project-1');
    expect(normalized.projectStatus).toBe('active');
    expect(normalized.dependencies).toEqual([
      { id: 'embeddingModel', status: 'available', message: undefined },
      { id: 'provider', status: 'available', message: undefined },
      { id: 'chroma', status: 'not-configured', message: 'RAG_VECTOR_STORE_UNAVAILABLE' },
    ]);
  });

  it('drops malformed sources and preserves exact failure details', () => {
    expect(normalizeKnowledgeSources({ data: { sources: [
      { id: 'one', projectId: 'project-1', name: 'notes.md', mediaType: 'text/markdown', status: 'processing', characterCount: 20, chunkCount: 0, embedding: { provider: 'ollama', model: 'embed', dimension: 768 } },
      { _id: 'two', name: 'bad.txt', mediaType: 'text/plain', status: 'failed', errorMessage: 'Embedding provider is unavailable', errorCode: 'RAG_PROVIDER_UNAVAILABLE' },
      { id: 'missing-fields' },
    ] } })).toEqual([
      expect.objectContaining({ id: 'one', projectId: 'project-1', status: 'indexing', characterCount: 20, chunkCount: 0, embeddingProvider: 'ollama', embeddingModel: 'embed', embeddingDimension: 768 }),
      expect.objectContaining({ id: 'two', status: 'failed', errorMessage: 'Embedding provider is unavailable', errorCode: 'RAG_PROVIDER_UNAVAILABLE' }),
    ]);
  });

  it('bounds references and requires their source fields', () => {
    const result = normalizeKnowledgeQuery({ data: {
      answer: 'Backend answer', provider: 'ollama', model: 'phi3', references: [
        { referenceId: 'r1', sourceId: 's1', sourceName: 'a.txt', chunkId: 'c1', chunkIndex: 0, excerpt: 'x'.repeat(KNOWLEDGE_EXCERPT_LIMIT + 5), distance: 0.2 },
        { referenceId: 'invalid', excerpt: 'not enough fields' },
      ],
    } });
    expect(result?.references).toHaveLength(1);
    expect(result?.references[0].excerpt).toHaveLength(KNOWLEDGE_EXCERPT_LIMIT);
    expect(result?.references[0].distance).toBe(0.2);
    expect(normalizeKnowledgeQuery({ data: { answer: 'No provider' } })).toBeUndefined();
  });

  it('normalizes backend marker/snippet references without manufacturing chunk ids', () => {
    expect(normalizeKnowledgeQuery({ data: {
      answer: 'See [S1].', provider: 'ollama', model: 'phi3', references: [
        { marker: '[S1]', sourceId: 's1', sourceName: 'a.txt', mediaType: 'text/plain', chunkIndex: 0, snippet: 'source text', distance: 0.1 },
      ],
    } })?.references[0]).toEqual({
      referenceId: undefined, marker: '[S1]', sourceId: 's1', sourceName: 'a.txt', chunkId: undefined,
      mediaType: 'text/plain', projectId: undefined, chunkIndex: 0, excerpt: 'source text', distance: 0.1,
    });
  });

  it('gates archived/invalid project mutations and scopes payloads', () => {
    expect(canMutateKnowledge('active', true)).toBe(true);
    expect(canMutateKnowledge('archived', true)).toBe(false);
    expect(canMutateKnowledge('active', false)).toBe(false);
    expect(knowledgeProjectPayload({ question: 'Hi' }, 'p1')).toEqual({ question: 'Hi', projectId: 'p1' });
    expect(knowledgeProjectPayload({ question: 'Hi' })).toEqual({ question: 'Hi' });
  });

  it('accepts only bounded TXT/Markdown sources', () => {
    expect(validateKnowledgeFile({ name: 'notes.md', type: 'text/markdown', size: 8 })).toBeUndefined();
    expect(validateKnowledgeFile({ name: 'notes.pdf', type: 'application/pdf', size: 8 })).toBe('Choose a TXT or Markdown file.');
    expect(validateKnowledgeFile({ name: 'large.txt', type: 'text/plain', size: 65537 })).toBe('The source must be 64 KiB or smaller.');
    expect(sourceMediaType('README.markdown')).toBe('text/markdown');
  });

  it('uses fresh server archive state only for the matching project', () => {
    const archived = normalizeKnowledgeStatus({ data: { scope: {
      type: 'project', projectId: 'p1', projectStatus: 'archived',
    } } });
    expect(effectiveKnowledgeProjectStatus('active', 'p1', archived)).toBe('archived');
    expect(canMutateKnowledge(effectiveKnowledgeProjectStatus('active', 'p1', archived))).toBe(false);
    expect(effectiveKnowledgeProjectStatus('active', 'p2', archived)).toBe('active');
    expect(effectiveKnowledgeProjectStatus(undefined, undefined, archived)).toBeUndefined();
    const active = normalizeKnowledgeStatus({ scope: { type: 'project', projectId: 'p1', projectStatus: 'active' } });
    expect(effectiveKnowledgeProjectStatus('archived', 'p1', active)).toBe('active');
    const malformed = normalizeKnowledgeStatus({ scope: { type: 'project', projectId: 'p1', projectStatus: 'unexpected' } });
    expect(malformed.projectStatus).toBeUndefined();
    expect(effectiveKnowledgeProjectStatus('archived', 'p1', malformed)).toBe('archived');
    expect(effectiveKnowledgeProjectStatus('archived', 'p1', { ...active, scope: 'workspace' })).toBe('archived');
  });

  it('allows deletion only for terminal sources in a mutable scope', () => {
    expect(canDeleteKnowledgeSource('queued', true)).toBe(false);
    expect(canDeleteKnowledgeSource('indexing', true)).toBe(false);
    expect(canDeleteKnowledgeSource('unknown', true)).toBe(false);
    expect(canDeleteKnowledgeSource('ready', true)).toBe(true);
    expect(canDeleteKnowledgeSource('failed', true)).toBe(true);
    expect(canDeleteKnowledgeSource('ready', false)).toBe(false);
    expect(canDeleteKnowledgeSource('failed', false)).toBe(false);
  });

  it('bounds automatic source refresh with backoff', () => {
    expect([1, 2, 3, 4, 5, 6].map(nextKnowledgeRefreshDelay)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    expect(nextKnowledgeRefreshDelay(7)).toBeUndefined();
  });
});
