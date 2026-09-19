import { describe, expect, it } from 'vitest';
import { chatModelOptions, formatBytes, normalizeModelCatalog } from './modelManager';

describe('model catalog normalization', () => {
  it('normalizes provider metadata and model capabilities', () => {
    expect(normalizeModelCatalog({ success: true, data: {
      provider: { id: 'ollama', modelScope: 'installed', management: { pull: true, delete: true } },
      models: [{ id: 'phi3', name: 'Phi 3', sizeBytes: 2 * 1024 ** 3, capabilities: { chat: true, vision: false } }],
    } })).toEqual({
      provider: 'ollama', modelScope: 'installed', canPull: true, canDelete: true,
      models: [expect.objectContaining({ id: 'phi3', capabilities: ['chat'] })],
    });
  });

  it('does not invent management capabilities or models', () => {
    expect(normalizeModelCatalog({ data: { provider: { id: 'anthropic' } } }))
      .toMatchObject({ provider: 'anthropic', canPull: false, canDelete: false, models: [] });
    expect(formatBytes(undefined)).toBe('Size unavailable');
  });

  it('excludes explicitly non-chat models without hiding unknown legacy capabilities', () => {
    const catalog = normalizeModelCatalog({ models: [
      { id: 'phi3', capabilities: { chat: true } },
      { id: 'all-minilm:22m', capabilities: { chat: false, embeddings: true } },
      { id: 'legacy' },
      { id: 'unknown', capabilities: { embeddings: true } },
      { id: 'malformed', capabilities: { chat: 'false' } },
    ] });

    expect(catalog.models.map((model) => model.chatSupported)).toEqual([true, false, undefined, undefined, undefined]);
    expect(catalog.models[1].capabilities).toEqual(['embeddings']);
    expect(chatModelOptions(catalog.models).map((model) => model.id)).toEqual(['phi3', 'legacy', 'unknown', 'malformed']);
    expect(catalog.models).toHaveLength(5);
  });

  it('returns no chat choices for an embedding-only catalog', () => {
    const catalog = normalizeModelCatalog({ models: [{ id: 'embed', capabilities: { chat: false } }] });
    expect(chatModelOptions(catalog.models)).toEqual([]);
  });
});
