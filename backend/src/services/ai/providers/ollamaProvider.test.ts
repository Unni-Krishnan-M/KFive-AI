import { Readable } from 'stream';
import { createServer } from 'http';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import axios, { AxiosInstance } from 'axios';
import { AiProviderAbortedError, AiProviderResponseError, AiProviderUnavailableError } from '../errors';
import { AiStreamEvent } from '../types';
import { OllamaProvider } from './ollamaProvider';

function createClient() {
  return {
    get: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
  };
}

function createProvider(client: ReturnType<typeof createClient>): OllamaProvider {
  return new OllamaProvider({
    baseUrl: 'http://ollama.test:11434',
    defaultModel: 'phi3',
    maxOutputTokens: 2048,
    timeoutMs: 30_000,
  }, client as unknown as AxiosInstance);
}

describe('OllamaProvider', () => {
  it('performs real Unix-socket requests and rejects redirects without escaping to TCP', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kfive-ollama-'));
    const socketPath = join(directory, 'http.sock');
    let redirect = false;
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url || '');
      if (redirect) {
        response.writeHead(302, { Location: 'http://127.0.0.1:1/escape' });
        response.end();
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ models: [{ name: 'socket-model', capabilities: ['completion'] }] }));
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      const provider = new OllamaProvider({ baseUrl: 'https://unused.invalid', socketPath,
        defaultModel: 'socket-model', maxOutputTokens: 32, timeoutMs: 1000 });
      await expect(provider.listModels()).resolves.toEqual([expect.objectContaining({ id: 'socket-model' })]);
      redirect = true;
      await expect(provider.listModels()).rejects.toMatchObject({
        code: 'PROVIDER_ERROR', cause: { response: { status: 302 } },
      });
      expect(requests).toEqual(['/api/tags', '/api/tags']);
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('pins Unix socket requests to HTTP without environment proxies or redirects', () => {
    const create = jest.spyOn(axios, 'create');
    try {
      new OllamaProvider({ baseUrl: 'https://remote.invalid/prefix', socketPath: '/run/kfive/ollama.sock',
        defaultModel: 'phi3', maxOutputTokens: 32, timeoutMs: 1000 });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        baseURL: 'http://localhost', socketPath: '/run/kfive/ollama.sock', proxy: false, maxRedirects: 0,
      }));
    } finally { create.mockRestore(); }
  });

  it('retains the configured TCP origin when no socket is configured', () => {
    const create = jest.spyOn(axios, 'create');
    try {
      new OllamaProvider({ baseUrl: 'https://remote.invalid/prefix/',
        defaultModel: 'phi3', maxOutputTokens: 32, timeoutMs: 1000 });
      expect(create.mock.calls[0][0]).toMatchObject({ baseURL: 'https://remote.invalid/prefix' });
      expect(create.mock.calls[0][0]).not.toHaveProperty('socketPath');
    } finally { create.mockRestore(); }
  });

  it('normalizes model records while retaining legacy Ollama aliases', async () => {
    const client = createClient();
    client.get.mockResolvedValue({
      status: 200,
      data: { models: [{
        name: 'phi3:latest', size: 123, digest: 'abc', modified_at: '2026-01-01T00:00:00Z',
        details: { context_length: 8192, family: 'phi3' }, capabilities: ['completion'],
      }] },
    });

    await expect(createProvider(client).listModels()).resolves.toEqual([expect.objectContaining({
      id: 'phi3:latest',
      name: 'phi3:latest',
      provider: 'ollama',
      sizeBytes: 123,
      size: 123,
      digest: 'abc',
      modifiedAt: '2026-01-01T00:00:00Z',
      modified_at: '2026-01-01T00:00:00Z',
      contextWindow: 8192,
      capabilities: expect.objectContaining({ chat: true }),
    })]);
  });

  it('applies provider-neutral generation settings to a non-streaming chat', async () => {
    const client = createClient();
    client.post.mockResolvedValue({ data: {
      model: 'phi3', message: { role: 'assistant', content: 'Hello' }, done: true,
      prompt_eval_count: 2, eval_count: 3, total_duration: 5_000_000,
    } });

    const response = await createProvider(client).chat({
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.2,
      topP: 0.8,
      structuredOutput: true,
    });

    expect(client.post).toHaveBeenCalledWith('/api/chat', expect.objectContaining({
      model: 'phi3',
      stream: false,
      format: 'json',
      options: expect.objectContaining({ num_predict: 2048, temperature: 0.2, top_p: 0.8 }),
    }), { signal: undefined });
    expect(response).toMatchObject({
      provider: 'ollama', model: 'phi3', content: 'Hello', finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, totalDurationMs: 5 },
    });
  });

  it('normalizes fragmented NDJSON into start, delta, usage, and done events', async () => {
    const client = createClient();
    client.post.mockResolvedValue({ data: Readable.from([
      '{"model":"phi3","message":{"content":"Hel"},"done":false}\n{"model":"phi3",',
      '"message":{"content":"lo"},"done":false}\n',
      '{"model":"phi3","message":{"content":""},"done":true,"prompt_eval_count":2,"eval_count":1}\n',
    ]) });
    const events: AiStreamEvent[] = [];

    await createProvider(client).chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      (event) => events.push(event)
    );

    expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'delta', 'usage', 'done']);
    expect(events[1]).toMatchObject({ type: 'delta', provider: 'ollama', model: 'phi3', content: 'Hel' });
    expect(events[4]).toMatchObject({ type: 'done', finishReason: 'stop', usage: { totalTokens: 3 } });
  });

  it('rejects a stream that ends without a completion record', async () => {
    const client = createClient();
    client.post.mockResolvedValue({ data: Readable.from([
      '{"model":"phi3","message":{"content":"partial"},"done":false}\n',
    ]) });

    await expect(createProvider(client).chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      () => undefined
    )).rejects.toBeInstanceOf(AiProviderResponseError);
  });

  it('honors an already-aborted request', async () => {
    const client = createClient();
    const controller = new AbortController();
    controller.abort();

    await expect(createProvider(client).chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      () => undefined,
      { signal: controller.signal }
    )).rejects.toBeInstanceOf(AiProviderAbortedError);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('returns a stable unavailable error for connection failures', async () => {
    const client = createClient();
    client.get.mockRejectedValue(Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }));

    await expect(createProvider(client).listModels()).rejects.toBeInstanceOf(AiProviderUnavailableError);
  });

  it('streams normalized pull progress and deletes through argument-safe HTTP requests', async () => {
    const client = createClient();
    client.post.mockResolvedValue({ data: Readable.from([
      '{"status":"pulling manifest"}\n',
      '{"status":"downloading","digest":"sha256:abc","total":100,"completed":50}\n',
      '{"status":"success","total":100,"completed":100}\n',
    ]) });
    client.delete.mockResolvedValue({ status: 200 });
    const progress: Array<{ status: string; percent?: number }> = [];
    const provider = createProvider(client);

    await provider.pullModel('phi3:latest', (event) => progress.push(event));
    await provider.deleteModel('phi3:latest');

    expect(client.post).toHaveBeenCalledWith(
      '/api/pull',
      { name: 'phi3:latest', stream: true },
      { responseType: 'stream', signal: undefined }
    );
    expect(progress).toEqual([
      { status: 'pulling manifest', digest: undefined, total: undefined, completed: undefined, percent: undefined },
      { status: 'downloading', digest: 'sha256:abc', total: 100, completed: 50, percent: 50 },
      { status: 'success', digest: undefined, total: 100, completed: 100, percent: 100 },
    ]);
    expect(client.delete).toHaveBeenCalledWith('/api/delete', {
      data: { name: 'phi3:latest' },
      signal: undefined,
    });
  });

  it('rejects a model pull stream that never reports success', async () => {
    const client = createClient();
    client.post.mockResolvedValue({ data: Readable.from(['{"status":"pulling manifest"}\n']) });
    await expect(createProvider(client).pullModel('phi3', () => undefined))
      .rejects.toBeInstanceOf(AiProviderResponseError);
  });
});
