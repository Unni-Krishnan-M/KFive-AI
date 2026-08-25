import { Router } from 'express';
import { AiProviderClient } from '@/services/aiProvider';
import { createProviderRouter } from './provider';

const models = [{
  id: 'phi3:latest', name: 'phi3:latest', provider: 'ollama', sizeBytes: 2_000_000_000,
  size: 2_000_000_000, digest: 'digest', modified_at: '2026-01-01T00:00:00Z',
}];

function fakeProvider(overrides: Partial<AiProviderClient> = {}): AiProviderClient {
  return {
    id: 'ollama',
    capabilities: { chat: true, streaming: true, embeddings: false, structuredOutput: true, modelListing: true },
    healthCheck: async () => true,
    connectionTest: async () => ({ connected: true, supported: true, latencyMs: 3, message: 'Connected.' }),
    listModels: async () => models,
    chat: async () => ({ provider: 'ollama', model: 'phi3', content: 'ok', finishReason: 'stop' }),
    chatStream: async () => undefined,
    embed: async () => ({ provider: 'ollama', model: 'embed', embeddings: [[1]] }),
    ...overrides,
  };
}

function invoke(router: Router, method: 'get' | 'post', path: string): Promise<{ status: number; body: any }> {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === path && entry.route.methods[method]);
  const handler = layer.route.stack[0].handle;
  return new Promise((resolve, reject) => {
    let status = 200;
    const response = {
      status(code: number) { status = code; return this; },
      json(body: any) { resolve({ status, body }); return this; },
    };
    handler({}, response, reject);
  });
}

describe('provider routes', () => {
  it('reports provider status and capabilities', async () => {
    const { status, body } = await invoke(createProviderRouter(() => fakeProvider()), 'get', '/status');
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ provider: 'ollama', status: 'healthy' });
    expect(body.data.capabilities.streaming).toBe(true);
  });

  it('lists models through the shared provider abstraction', async () => {
    const { status, body } = await invoke(createProviderRouter(() => fakeProvider()), 'get', '/models');
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, provider: 'ollama', data: models });
  });

  it('returns a clear unavailable result when a connection test fails', async () => {
    const provider = fakeProvider({
      connectionTest: async () => ({ connected: false, supported: true, latencyMs: 7, message: 'Provider unavailable.' }),
    });
    const { status, body } = await invoke(createProviderRouter(() => provider), 'post', '/connection-test');
    expect(status).toBe(503);
    expect(body).toEqual({
      success: false,
      data: {
        provider: 'ollama',
        connected: false,
        supported: true,
        latencyMs: 7,
        message: 'Provider unavailable.',
      },
    });
  });
});
