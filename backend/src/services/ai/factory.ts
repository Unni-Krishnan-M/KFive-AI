import { EnvironmentConfig, getEnvironment } from '@/config/environment';
import { AiProviderUnsupportedError } from './errors';
import { OllamaProvider } from './providers/ollamaProvider';
import { OpenAiCompatibleProvider } from './providers/openAiCompatibleProvider';
import { AnthropicProvider } from './providers/anthropicProvider';
import {
  AiChatRequest,
  AiChatResponse,
  AiEmbeddingRequest,
  AiEmbeddingResponse,
  AiModel,
  AiProviderCapabilities,
  AiProviderClient,
  AiProviderConnectionTest,
  AiRequestOptions,
  AiStreamEvent,
} from './types';

class UnsupportedProvider implements AiProviderClient {
  readonly capabilities: AiProviderCapabilities = {
    chat: false,
    streaming: false,
    embeddings: false,
    structuredOutput: false,
    modelListing: false,
  };

  constructor(readonly id: string) {}

  async healthCheck(_options?: AiRequestOptions): Promise<boolean> { return false; }

  async connectionTest(_options?: AiRequestOptions): Promise<AiProviderConnectionTest> {
    return { connected: false, supported: false, latencyMs: 0, message: this.error().message };
  }

  async listModels(_options?: AiRequestOptions): Promise<AiModel[]> { throw this.error('model listing'); }
  async chat(_request: AiChatRequest, _options?: AiRequestOptions): Promise<AiChatResponse> { throw this.error('chat'); }
  async chatStream(
    _request: AiChatRequest,
    _onEvent: (event: AiStreamEvent) => void,
    _options?: AiRequestOptions
  ): Promise<void> { throw this.error('streaming chat'); }
  async embed(_request: AiEmbeddingRequest, _options?: AiRequestOptions): Promise<AiEmbeddingResponse> {
    throw this.error('embeddings');
  }

  private error(capability?: string): AiProviderUnsupportedError {
    return new AiProviderUnsupportedError(this.id, capability);
  }
}

export function createAiProvider(config: EnvironmentConfig = getEnvironment()): AiProviderClient {
  switch (config.aiProvider) {
    case 'ollama':
      return new OllamaProvider({
        baseUrl: config.ollamaBaseUrl || '',
        socketPath: config.ollamaSocketPath,
        defaultModel: config.aiDefaultModel,
        maxOutputTokens: config.aiMaxOutputTokens,
        timeoutMs: config.aiTimeoutMs,
      });
    case 'openai':
      return new OpenAiCompatibleProvider({
        id: 'openai',
        baseUrl: config.openaiBaseUrl || 'https://api.openai.com/v1',
        apiKey: config.openaiApiKey,
        defaultModel: config.aiDefaultModel,
        maxOutputTokens: config.aiMaxOutputTokens,
        timeoutMs: config.aiTimeoutMs,
        supportsEmbeddings: true,
        supportsStructuredOutput: true,
      });
    case 'openai-compatible':
      return new OpenAiCompatibleProvider({
        id: 'openai-compatible',
        baseUrl: config.openaiBaseUrl || '',
        apiKey: config.openaiApiKey,
        defaultModel: config.aiDefaultModel,
        maxOutputTokens: config.aiMaxOutputTokens,
        timeoutMs: config.aiTimeoutMs,
        supportsEmbeddings: config.openAiCompatibleSupportsEmbeddings,
        supportsStructuredOutput: config.openAiCompatibleSupportsStructuredOutput,
      });
    case 'custom':
      return new OpenAiCompatibleProvider({
        id: 'custom',
        baseUrl: config.customLlmBaseUrl || '',
        apiKey: config.customLlmApiKey,
        defaultModel: config.aiDefaultModel,
        maxOutputTokens: config.aiMaxOutputTokens,
        timeoutMs: config.aiTimeoutMs,
        supportsEmbeddings: config.customLlmSupportsEmbeddings,
        supportsStructuredOutput: config.customLlmSupportsStructuredOutput,
      });
    case 'anthropic':
      return new AnthropicProvider({
        baseUrl: config.anthropicBaseUrl,
        apiKey: config.anthropicApiKey || '',
        defaultModel: config.aiDefaultModel,
        maxOutputTokens: config.aiMaxOutputTokens,
        timeoutMs: config.aiTimeoutMs,
      });
    default: {
      const exhaustive: never = config.aiProvider;
      return new UnsupportedProvider(exhaustive);
    }
  }
}

let provider: AiProviderClient | undefined;

export function getAiProvider(): AiProviderClient {
  if (!provider) provider = createAiProvider();
  return provider;
}

export function resetAiProviderForTests(): void { provider = undefined; }
