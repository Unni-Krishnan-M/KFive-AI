import { EventEmitter } from 'events';
import { Router } from 'express';
import { AiProviderClient } from '@/services/aiProvider';
import { InMemoryModelDeletionConfirmationStore } from '@/services/modelManagement';
import { createModelsRouter } from './models';

const models = [{
  id: 'phi3:latest',
  name: 'phi3:latest',
  provider: 'ollama',
  sizeBytes: 2_000_000_000,
  capabilities: { chat: true },
}];

function fakeProvider(overrides: Partial<AiProviderClient> = {}): AiProviderClient {
  return {
    id: 'ollama',
    capabilities: {
      chat: true,
      streaming: true,
      embeddings: true,
      structuredOutput: true,
      modelListing: true,
      modelPull: true,
      modelDelete: true,
    },
    healthCheck: async () => true,
    connectionTest: async () => ({ connected: true, supported: true, latencyMs: 1, message: 'Connected.' }),
    listModels: async () => models,
    pullModel: async (_model, onProgress) => {
      onProgress({ status: 'pulling manifest' });
      onProgress({ status: 'success', total: 100, completed: 100, percent: 100 });
    },
    deleteModel: async () => undefined,
    chat: async () => ({ provider: 'ollama', model: 'phi3', content: 'ok', finishReason: 'stop' }),
    chatStream: async () => undefined,
    embed: async () => ({ provider: 'ollama', model: 'embed', embeddings: [[1]] }),
    ...overrides,
  };
}

interface InvokeResult {
  status: number;
  body?: any;
  chunks: string[];
  headers: Record<string, string>;
}

function invoke(
  router: Router,
  method: 'get' | 'post' | 'delete',
  path: string,
  values: { body?: any; query?: any; user?: any } = {}
): Promise<InvokeResult> {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === path && entry.route.methods[method]);
  const handler = layer.route.stack[0].handle;
  return new Promise((resolve, reject) => {
    let status = 200;
    let ended = false;
    const chunks: string[] = [];
    const headers: Record<string, string> = {};
    const request = Object.assign(new EventEmitter(), {
      body: values.body || {},
      query: values.query || {},
      user: values.user || { userId: 'user-1', email: 'test@example.com', role: 'user' },
    });
    const response = Object.assign(new EventEmitter(), {
      get writableEnded() { return ended; },
      status(code: number) { status = code; return this; },
      setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
      flushHeaders() { return this; },
      write(value: string) { chunks.push(value); return true; },
      end(value?: string) {
        if (value) chunks.push(value);
        ended = true;
        resolve({ status, chunks, headers });
        return this;
      },
      json(body: any) {
        ended = true;
        resolve({ status, body, chunks, headers });
        return this;
      },
    });
    handler(request, response, reject);
  });
}

describe('models routes', () => {
  it('lists normalized models with explicit provider management metadata', async () => {
    const result = await invoke(createModelsRouter(() => fakeProvider()), 'get', '/');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      success: true,
      data: {
        provider: {
          id: 'ollama',
          management: { pull: true, delete: true },
          modelScope: 'installed',
        },
        models,
      },
    });
  });

  it('streams model pull progress as NDJSON', async () => {
    const result = await invoke(createModelsRouter(() => fakeProvider()), 'post', '/pull', {
      body: { model: 'phi3:latest' },
    });
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('application/x-ndjson');
    const records = result.chunks.join('').trim().split('\n').map((line) => JSON.parse(line));
    expect(records).toEqual([
      { type: 'progress', data: { status: 'pulling manifest' } },
      { type: 'progress', data: { status: 'success', total: 100, completed: 100, percent: 100 } },
      { type: 'done', data: { provider: 'ollama', model: 'phi3:latest' } },
    ]);
  });

  it('reports unsupported management without changing providers', async () => {
    const provider = fakeProvider({
      id: 'openai',
      capabilities: {
        chat: true, streaming: true, embeddings: true, structuredOutput: true, modelListing: true,
        modelPull: false, modelDelete: false,
      },
      pullModel: undefined,
      deleteModel: undefined,
    });
    const result = await invoke(createModelsRouter(() => provider), 'post', '/pull', { body: { model: 'gpt-5' } });
    expect(result).toMatchObject({
      status: 501,
      body: {
        success: false,
        error: { code: 'UNSUPPORTED_MODEL_OPERATION', message: expect.stringContaining('No provider fallback') },
      },
    });
  });

  it('requires a scoped one-use token before deleting an installed model', async () => {
    const deleteModel = jest.fn().mockResolvedValue(undefined);
    const provider = fakeProvider({ deleteModel });
    const confirmations = new InMemoryModelDeletionConfirmationStore(
      60_000,
      () => Date.parse('2026-01-01T00:00:00.000Z'),
      () => 'c'.repeat(32)
    );
    const router = createModelsRouter(() => provider, confirmations);
    const issued = await invoke(router, 'post', '/delete-confirmation', { body: { model: 'phi3:latest' } });
    expect(issued.status).toBe(200);

    const firstDelete = await invoke(router, 'delete', '/', {
      body: { model: 'phi3:latest', confirmationToken: issued.body.data.confirmationToken },
    });
    expect(firstDelete.body).toMatchObject({ success: true, data: { model: 'phi3:latest', deleted: true } });
    expect(deleteModel).toHaveBeenCalledWith('phi3:latest');

    const repeatedDelete = await invoke(router, 'delete', '/', {
      body: { model: 'phi3:latest', confirmationToken: issued.body.data.confirmationToken },
    });
    expect(repeatedDelete).toMatchObject({
      status: 409,
      body: { error: { code: 'INVALID_CONFIRMATION_TOKEN' } },
    });
    expect(deleteModel).toHaveBeenCalledTimes(1);
  });

  it('routes within the configured provider using injected GPU status', async () => {
    const provider = fakeProvider({
      listModels: async () => [
        ...models,
        { id: 'qwen-coder:7b', name: 'qwen-coder:7b', provider: 'ollama', sizeBytes: 4_000_000_000 },
      ],
    });
    const result = await invoke(createModelsRouter(
      () => provider,
      new InMemoryModelDeletionConfirmationStore(),
      async () => ({
        available: true,
        message: 'GPU available.',
        gpus: [],
        summary: { deviceCount: 1, totalVramMiB: 8192, usedVramMiB: 1024, freeVramMiB: 7168 },
        sampledAt: '2026-01-01T00:00:00.000Z',
      }),
      'phi3:latest'
    ), 'post', '/route', { body: { task: 'coding' } });
    expect(result.body).toMatchObject({
      success: true,
      data: { provider: 'ollama', model: 'qwen-coder:7b', task: 'coding', reasons: expect.any(Array) },
    });
  });
});

