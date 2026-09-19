import { EnvironmentConfig } from '@/config/environment';
import axios from 'axios';
import { createAiProvider } from './factory';
import { OllamaProvider } from './providers/ollamaProvider';
import { OpenAiCompatibleProvider } from './providers/openAiCompatibleProvider';
import { AnthropicProvider } from './providers/anthropicProvider';

const baseConfig: EnvironmentConfig = {
  processKind: 'api',
  nodeEnv: 'test',
  port: 5000,
  apiVersion: 'v1',
  kfiveMode: 'local',
  aiProvider: 'ollama',
  aiDefaultModel: 'phi3',
  aiMaxOutputTokens: 2048,
  aiTimeoutMs: 30000,
  openAiCompatibleSupportsEmbeddings: false,
  openAiCompatibleSupportsStructuredOutput: false,
  customLlmSupportsEmbeddings: false,
  customLlmSupportsStructuredOutput: false,
  anthropicBaseUrl: 'https://api.anthropic.com',
  mongodbUrl: 'mongodb://localhost/kfive',
  redisUrl: 'redis://localhost',
  ollamaBaseUrl: 'http://localhost:11434',
  corsOrigins: ['http://localhost:3000'],
  jwtSecret: '01234567890123456789012345678901',
  jwtRefreshSecret: 'abcdefghijklmnopqrstuvwxyz123456',
  codeRunnerMode: 'disabled',
  notebookExecutionEnabled: false,
};

describe('createAiProvider', () => {
  it('passes the configured Ollama socket transport to its adapter', () => {
    const create = jest.spyOn(axios, 'create');
    try {
      createAiProvider({ ...baseConfig, ollamaSocketPath: '/run/kfive/ollama.sock' });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ socketPath: '/run/kfive/ollama.sock' }));
    } finally { create.mockRestore(); }
  });

  it('creates the selected Ollama adapter', () => {
    expect(createAiProvider(baseConfig)).toBeInstanceOf(OllamaProvider);
  });

  it('creates the selected Anthropic adapter without falling back', () => {
    const provider = createAiProvider({ ...baseConfig, aiProvider: 'anthropic', anthropicApiKey: 'key' });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.id).toBe('anthropic');
  });

  it('creates OpenAI and compatible adapters without an implicit provider fallback', () => {
    const openai = createAiProvider({ ...baseConfig, aiProvider: 'openai', openaiApiKey: 'key' });
    const compatible = createAiProvider({
      ...baseConfig,
      aiProvider: 'openai-compatible',
      openaiBaseUrl: 'http://compatible.test/v1',
    });
    expect(openai).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(openai.id).toBe('openai');
    expect(compatible).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(compatible.id).toBe('openai-compatible');
  });
});
