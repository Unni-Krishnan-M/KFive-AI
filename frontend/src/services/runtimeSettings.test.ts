import { describe, expect, it } from 'vitest';
import {
  normalizeModels,
  normalizeRuntimeSettings,
  readableApiError,
  sanitizeServiceUrl,
} from './runtimeSettings';

describe('runtime settings normalization', () => {
  it('accepts the settings API envelope and preserves truthful topology metadata', () => {
    const runtime = normalizeRuntimeSettings({
      success: true,
      data: {
        mode: 'hybrid',
        provider: {
          id: 'ollama',
          configured: true,
          location: 'remote',
          liveSwitchSupported: false,
          restartRequired: true,
        },
        services: [
          { id: 'mongodb', configured: true, location: 'local', restartRequired: true },
          { id: 'ocr', configured: false, location: 'disabled', restartRequired: true },
        ],
        restartRequiredFields: ['KFIVE_MODE', 'MONGODB_URL'],
        note: 'Environment-backed configuration.',
      },
    });

    expect(runtime.mode).toBe('hybrid');
    expect(runtime.provider).toMatchObject({
      id: 'ollama',
      name: 'Ollama',
      configured: true,
      location: 'remote',
      restartRequired: true,
      liveSwitchSupported: false,
    });
    expect(runtime.services).toEqual([
      expect.objectContaining({ id: 'mongodb', configured: true, location: 'local', status: 'unknown' }),
      expect.objectContaining({ id: 'ocr', configured: false, location: 'disabled', status: 'disabled' }),
    ]);
    expect(runtime.restartRequired).toEqual(['KFIVE_MODE', 'MONGODB_URL']);
    expect(runtime.note).toBe('Environment-backed configuration.');
  });

  it('removes credentials, query strings, and fragments from displayed service URLs', () => {
    expect(sanitizeServiceUrl('mongodb://admin:super-secret@mongo.example:27017/kfive?authSource=admin'))
      .toBe('mongodb://mongo.example:27017/kfive');
    expect(sanitizeServiceUrl('https://token@example.com/v1?api_key=hidden#section'))
      .toBe('https://example.com/v1');
  });

  it('normalizes provider model objects without inventing models', () => {
    expect(normalizeModels({ success: true, data: [
      { name: 'phi3:latest' },
      { model: 'qwen2.5-coder:7b' },
      { size: 42 },
    ] })).toEqual(['phi3:latest', 'qwen2.5-coder:7b']);
    expect(normalizeModels({ success: true, data: { provider: 'custom' } })).toEqual([]);
  });

  it('surfaces a dependency-specific API error from a failed response', () => {
    expect(readableApiError({
      response: { data: { success: false, data: { message: 'Ollama is unavailable at the configured endpoint.' } } },
    }, 'Connection failed.')).toBe('Ollama is unavailable at the configured endpoint.');
    expect(readableApiError({
      response: { data: { success: false, error: { code: 'PROJECT_ARCHIVED', message: 'Project is archived.' } } },
    }, 'Operation failed.')).toBe('Project is archived.');
  });
});
