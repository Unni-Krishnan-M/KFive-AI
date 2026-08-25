export type AiProviderId = 'ollama' | 'openai' | 'anthropic' | 'openai-compatible' | 'custom';

export type AiMessageRole = 'system' | 'user' | 'assistant';

export interface AiMessage {
  role: AiMessageRole;
  content: string;
}

export interface AiProviderCapabilities {
  chat: boolean;
  streaming: boolean;
  embeddings: boolean;
  structuredOutput: boolean;
  modelListing: boolean;
  /** Whether KFive can install models through this provider adapter. */
  modelPull?: boolean;
  /** Whether KFive can remove models through this provider adapter. */
  modelDelete?: boolean;
}

export interface AiModelCapabilities {
  chat?: boolean;
  embeddings?: boolean;
  structuredOutput?: boolean;
  vision?: boolean;
  tools?: boolean;
}

/** Provider-neutral model information. Legacy aliases keep existing API clients working. */
export interface AiModel {
  id: string;
  name: string;
  provider: string;
  sizeBytes?: number;
  modifiedAt?: string;
  contextWindow?: number;
  capabilities?: AiModelCapabilities;
  metadata?: Record<string, unknown>;
  /** @deprecated Use sizeBytes. */
  size?: number;
  /** Provider checksum, retained for the legacy Ollama models route. */
  digest?: string;
  /** @deprecated Use modifiedAt. */
  modified_at?: string;
}

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalDurationMs?: number;
  loadDurationMs?: number;
}

export interface AiChatRequest {
  model?: string;
  messages: AiMessage[];
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stop?: string[];
  structuredOutput?: boolean;
}

export interface AiChatResponse {
  provider: string;
  model: string;
  content: string;
  finishReason: 'stop' | 'length' | 'error' | 'unknown';
  usage?: AiUsage;
  raw?: unknown;
}

interface AiStreamBase {
  provider: string;
  model: string;
}

export type AiStreamEvent =
  | (AiStreamBase & { type: 'start' })
  | (AiStreamBase & { type: 'delta'; content: string })
  | (AiStreamBase & { type: 'usage'; usage: AiUsage })
  | (AiStreamBase & { type: 'done'; finishReason: AiChatResponse['finishReason']; usage?: AiUsage });

export interface AiEmbeddingRequest {
  model?: string;
  input: string | string[];
}

export interface AiEmbeddingResponse {
  provider: string;
  model: string;
  embeddings: number[][];
  usage?: AiUsage;
}

export interface AiRequestOptions {
  signal?: AbortSignal;
}

export interface AiModelPullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  percent?: number;
}

export interface AiProviderConnectionTest {
  connected: boolean;
  supported: boolean;
  latencyMs: number;
  message: string;
}

export interface AiProviderClient {
  readonly id: string;
  readonly capabilities: AiProviderCapabilities;
  healthCheck(options?: AiRequestOptions): Promise<boolean>;
  connectionTest(options?: AiRequestOptions): Promise<AiProviderConnectionTest>;
  listModels(options?: AiRequestOptions): Promise<AiModel[]>;
  pullModel?(
    model: string,
    onProgress: (progress: AiModelPullProgress) => void,
    options?: AiRequestOptions
  ): Promise<void>;
  deleteModel?(model: string, options?: AiRequestOptions): Promise<void>;
  chat(request: AiChatRequest, options?: AiRequestOptions): Promise<AiChatResponse>;
  chatStream(
    request: AiChatRequest,
    onEvent: (event: AiStreamEvent) => void,
    options?: AiRequestOptions
  ): Promise<void>;
  embed(request: AiEmbeddingRequest, options?: AiRequestOptions): Promise<AiEmbeddingResponse>;
}
