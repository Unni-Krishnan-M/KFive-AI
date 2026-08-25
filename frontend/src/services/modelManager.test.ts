import { describe, expect, it } from 'vitest';
import { formatBytes, normalizeModelCatalog } from './modelManager';

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
});
