import { Router } from 'express';
import { authenticateToken } from '@/middleware/auth';
import { ProjectError } from '@/services/projectService';
import { RagService, RagServiceError } from '@/services/ragService';
import { createKnowledgeRouter } from './knowledge';

const ownerId = '64b000000000000000000001';
const projectId = '64b000000000000000000101';
const sourceId = '64b000000000000000000201';
const source = {
  id: sourceId,
  projectId,
  name: 'Notes',
  mediaType: 'text/markdown' as const,
  status: 'ready' as const,
  characterCount: 12,
  byteCount: 12,
  chunkCount: 1,
  embedding: { provider: 'ollama', model: 'embed-model', dimension: 2 },
};
const status = {
  available: true,
  canIngest: true,
  canQuery: true,
  readySourceCount: 1,
  scope: { type: 'project' as const, projectId, projectStatus: 'active' as const },
  dependencies: {
    embeddingModel: { configured: true, model: 'embed-model' },
    provider: { id: 'ollama', embeddingsSupported: true, available: true },
    chroma: { configured: true, available: true },
  },
  limits: { maxSourceBytes: 65_536, maxChunks: 64, maxTopK: 10 },
};

function fakeService(overrides: Partial<Record<keyof RagService, jest.Mock>> = {}): RagService {
  return {
    status: jest.fn().mockResolvedValue(status),
    list: jest.fn().mockResolvedValue([source]),
    ingest: jest.fn().mockResolvedValue(source),
    delete: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue({
      answer: 'Answer [S1]',
      provider: 'ollama',
      model: 'chat-model',
      references: [{
        marker: '[S1]', sourceId, sourceName: 'Notes', mediaType: 'text/markdown', projectId,
        chunkIndex: 0, snippet: 'retrieved text', distance: 0.2,
      }],
    }),
    ...overrides,
  } as unknown as RagService;
}

function invoke(
  router: Router,
  method: 'get' | 'post' | 'delete',
  path: string,
  values: { body?: unknown; query?: unknown; params?: unknown; userId?: string } = {}
): Promise<{ status: number; body: any }> {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === path && entry.route.methods[method]);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  return new Promise((resolve, reject) => {
    let responseStatus = 200;
    const request = {
      body: values.body || {},
      query: values.query || {},
      params: values.params || {},
      user: { userId: values.userId || ownerId, email: 'user@example.test', role: 'user' },
    };
    const response = {
      status(code: number) { responseStatus = code; return this; },
      json(body: any) { resolve({ status: responseStatus, body }); return this; },
    };
    handler(request, response, reject);
  });
}

describe('knowledge routes', () => {
  it('rejects an unauthenticated request before the protected knowledge router', () => {
    expect(() => authenticateToken(
      { headers: {} } as any,
      {} as any,
      jest.fn()
    )).toThrow('Access token required');
  });

  it('returns owner/project-scoped status and source envelopes', async () => {
    const service = fakeService();
    const router = createKnowledgeRouter(service);
    const statusResult = await invoke(router, 'get', '/status', { query: { projectId } });
    const listResult = await invoke(router, 'get', '/sources', { query: { projectId } });
    expect(statusResult).toEqual({ status: 200, body: { success: true, data: status } });
    expect(listResult).toEqual({
      status: 200,
      body: { success: true, data: { sources: [source], count: 1 } },
    });
    expect(service.status).toHaveBeenCalledWith(ownerId, projectId);
    expect(service.list).toHaveBeenCalledWith(ownerId, projectId, undefined);
  });

  it('forwards recovery and mixed query scopes without silently broadening them', async () => {
    const service = fakeService();
    await invoke(createKnowledgeRouter(service), 'get', '/sources', { query: { scope: 'orphaned' } });
    expect(service.list).toHaveBeenCalledWith(ownerId, undefined, 'orphaned');
    const invalid = fakeService({ list: jest.fn().mockRejectedValue(new RagServiceError('Invalid scope.', 'INVALID_RAG_INPUT', 400)) });
    const result = await invoke(createKnowledgeRouter(invalid), 'get', '/sources', { query: { scope: 'orphaned', projectId: '' } });
    expect(invalid.list).toHaveBeenCalledWith(ownerId, '', 'orphaned');
    expect(result).toMatchObject({ status: 400, body: { error: { code: 'INVALID_RAG_INPUT' } } });
  });

  it('returns synchronous ingestion, query references, and deletion envelopes', async () => {
    const service = fakeService();
    const router = createKnowledgeRouter(service);
    const input = { name: 'Notes', mediaType: 'text/markdown', content: '# Notes', projectId };
    const ingested = await invoke(router, 'post', '/sources', { body: input });
    const queried = await invoke(router, 'post', '/query', { body: { question: 'What?', projectId, topK: 3 } });
    const deleted = await invoke(router, 'delete', '/sources/:id', { params: { id: sourceId } });
    expect(ingested).toEqual({ status: 201, body: { success: true, data: { source } } });
    expect(queried.body.data).toMatchObject({
      answer: 'Answer [S1]',
      provider: 'ollama',
      model: 'chat-model',
      references: [expect.objectContaining({ marker: '[S1]', snippet: 'retrieved text', distance: 0.2 })],
    });
    expect(deleted).toEqual({
      status: 200,
      body: { success: true, data: { sourceId, deleted: true } },
    });
    expect(service.ingest).toHaveBeenCalledWith(ownerId, input);
    expect(service.query).toHaveBeenCalledWith(ownerId, { question: 'What?', projectId, topK: 3 });
    expect(service.delete).toHaveBeenCalledWith(ownerId, sourceId);
  });

  it('returns a structured conflict when deletion races an indexing source', async () => {
    const busy = fakeService({
      delete: jest.fn().mockRejectedValue(new RagServiceError(
        'Knowledge source is still indexing.', 'RAG_SOURCE_BUSY', 409
      )),
    });
    const result = await invoke(createKnowledgeRouter(busy), 'delete', '/sources/:id', { params: { id: sourceId } });
    expect(result).toEqual({ status: 409, body: { success: false, error: {
      code: 'RAG_SOURCE_BUSY', message: 'Knowledge source is still indexing.',
    } } });
  });

  it('returns fixed dependency and project ownership errors without raw details', async () => {
    const unavailable = fakeService({
      ingest: jest.fn().mockRejectedValue(new RagServiceError(
        'The configured vector store is unavailable.', 'RAG_VECTOR_STORE_UNAVAILABLE', 503
      )),
    });
    const result = await invoke(createKnowledgeRouter(unavailable), 'post', '/sources', { body: {} });
    expect(result).toEqual({
      status: 503,
      body: { success: false, error: {
        code: 'RAG_VECTOR_STORE_UNAVAILABLE', message: 'The configured vector store is unavailable.',
      } },
    });

    const hidden = fakeService({
      list: jest.fn().mockRejectedValue(new ProjectError('Project not found.', 'PROJECT_NOT_FOUND', 404)),
    });
    const hiddenResult = await invoke(createKnowledgeRouter(hidden), 'get', '/sources', { query: { projectId } });
    expect(hiddenResult).toMatchObject({ status: 404, body: { error: { code: 'PROJECT_NOT_FOUND' } } });
  });
});
