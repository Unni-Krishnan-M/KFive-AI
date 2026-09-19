import { AiModel } from './types';
import { ModelRoutingError, routeModel } from './modelRouter';

const models: AiModel[] = [
  { id: 'general:4b', name: 'general:4b', provider: 'ollama', sizeBytes: 3_000 * 1024 * 1024, contextWindow: 8192 },
  { id: 'qwen-coder:7b', name: 'qwen-coder:7b', provider: 'ollama', sizeBytes: 5_000 * 1024 * 1024, contextWindow: 32768 },
  { id: 'reason-r1:14b', name: 'reason-r1:14b', provider: 'ollama', sizeBytes: 10_000 * 1024 * 1024, contextWindow: 65536 },
];

describe('routeModel', () => {
  it('always honors an installed explicit preference and reports it', () => {
    expect(routeModel({ provider: 'ollama', models, task: 'coding', preferredModel: 'general:4b' }))
      .toMatchObject({ provider: 'ollama', model: 'general:4b', reasons: [expect.stringContaining('user preference')] });
  });

  it('selects a coding model from truthful provider metadata', () => {
    expect(routeModel({ provider: 'ollama', models, task: 'coding' }))
      .toMatchObject({ model: 'qwen-coder:7b', task: 'coding', evaluatedModels: 3 });
  });

  it('penalizes a model that exceeds conservative free VRAM', () => {
    const decision = routeModel({
      provider: 'ollama', models, task: 'reasoning',
      gpu: { available: true, freeVramMiB: 6000, totalVramMiB: 8192 },
    });
    expect(decision.model).not.toBe('reason-r1:14b');
    expect(decision.reasons).toContain('Model size fits the conservative free-VRAM budget.');
  });

  it('fails clearly without switching providers when no chat model exists', () => {
    expect(() => routeModel({
      provider: 'custom', task: 'rag',
      models: [{ id: 'embed', name: 'embed', provider: 'custom', capabilities: { chat: false } }],
    })).toThrow(ModelRoutingError);
  });

  it('does not silently replace an unavailable preferred model', () => {
    expect(() => routeModel({
      provider: 'ollama', models, task: 'coding', preferredModel: 'missing:latest',
    })).toThrow('No model or provider fallback was attempted');
  });

  it('distinguishes a listed embedding-only preference from an absent model', () => {
    const embedding: AiModel = { id: 'all-minilm:22m', name: 'all-minilm:22m', provider: 'ollama', capabilities: { chat: false, embeddings: true } };
    for (const catalog of [[embedding], [...models, embedding]]) {
      expect(() => routeModel({ provider: 'ollama', models: catalog, task: 'general-chat', preferredModel: embedding.id }))
        .toThrow('does not support chat');
    }
    expect(routeModel({ provider: 'ollama', models: [...models, embedding], task: 'general-chat' }).model).not.toBe(embedding.id);
  });
});
