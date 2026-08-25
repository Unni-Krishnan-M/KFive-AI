import axios, { AxiosError, AxiosInstance } from 'axios';
import {
  AiProviderAbortedError,
  AiProviderError,
  AiProviderResponseError,
  AiProviderTimeoutError,
  AiProviderUnavailableError,
  AiProviderUnsupportedError,
} from '../errors';
import { SseParser } from '../sseParser';
import {
  AiChatRequest, AiChatResponse, AiEmbeddingRequest, AiEmbeddingResponse, AiModel,
  AiProviderCapabilities, AiProviderClient, AiProviderConnectionTest, AiRequestOptions,
  AiStreamEvent, AiUsage,
} from '../types';

export interface AnthropicProviderConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

interface AnthropicUsage { input_tokens?: number; output_tokens?: number }
interface AnthropicResponse {
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string | null;
  usage?: AnthropicUsage;
}

function usageFrom(value?: AnthropicUsage): AiUsage | undefined {
  if (!value) return undefined;
  const usage = { inputTokens: value.input_tokens, outputTokens: value.output_tokens };
  return { ...usage, totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) };
}

function reasonFrom(value?: string | null): AiChatResponse['finishReason'] {
  if (value === 'max_tokens') return 'length';
  if (value === 'end_turn' || value === 'stop_sequence' || value === 'tool_use') return 'stop';
  return 'unknown';
}

export class AnthropicProvider implements AiProviderClient {
  readonly id = 'anthropic';
  readonly capabilities: AiProviderCapabilities = {
    chat: true, streaming: true, embeddings: false, structuredOutput: false, modelListing: true,
  };
  private readonly client: AxiosInstance;

  constructor(private readonly config: AnthropicProviderConfig, client?: AxiosInstance) {
    this.client = client || axios.create({
      baseURL: config.baseUrl.replace(/\/$/, ''),
      timeout: config.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
  }

  async healthCheck(options: AiRequestOptions = {}): Promise<boolean> {
    try {
      const response = await this.client.get('/v1/models', { params: { limit: 1 }, signal: options.signal });
      return response.status === 200;
    } catch { return false; }
  }

  async connectionTest(options: AiRequestOptions = {}): Promise<AiProviderConnectionTest> {
    const startedAt = Date.now();
    const connected = await this.healthCheck(options);
    return {
      connected, supported: true, latencyMs: Date.now() - startedAt,
      message: connected ? 'Connected to the configured Anthropic provider.' : 'The configured Anthropic provider is unavailable.',
    };
  }

  async listModels(options: AiRequestOptions = {}): Promise<AiModel[]> {
    try {
      const response = await this.client.get('/v1/models', { params: { limit: 100 }, signal: options.signal });
      const records = Array.isArray(response.data?.data) ? response.data.data : [];
      return records.map((record: { id?: string; display_name?: string; created_at?: string }) => {
        if (!record.id) throw new AiProviderResponseError(this.id, 'Anthropic returned a model without an id.');
        return { id: record.id, name: record.display_name || record.id, provider: this.id, modifiedAt: record.created_at };
      });
    } catch (error) { throw this.normalizeError(error); }
  }

  async chat(request: AiChatRequest, options: AiRequestOptions = {}): Promise<AiChatResponse> {
    const model = request.model || this.config.defaultModel;
    if (request.structuredOutput) throw new AiProviderUnsupportedError(this.id, 'structured output');
    try {
      const response = await this.client.post<AnthropicResponse>(
        '/v1/messages', this.toRequest(request, model, false), { signal: options.signal }
      );
      const content = (response.data.content || []).filter((block) => block.type === 'text').map((block) => block.text || '').join('');
      if (!content) throw new AiProviderResponseError(this.id, 'Anthropic returned a response without text content.');
      return {
        provider: this.id, model: response.data.model || model, content,
        finishReason: reasonFrom(response.data.stop_reason), usage: usageFrom(response.data.usage),
      };
    } catch (error) { throw this.normalizeError(error); }
  }

  async chatStream(
    request: AiChatRequest,
    onEvent: (event: AiStreamEvent) => void,
    options: AiRequestOptions = {}
  ): Promise<void> {
    const model = request.model || this.config.defaultModel;
    if (request.structuredOutput) throw new AiProviderUnsupportedError(this.id, 'structured output');
    if (options.signal?.aborted) throw new AiProviderAbortedError(this.id);
    try {
      const response = await this.client.post(
        '/v1/messages', this.toRequest(request, model, true),
        { responseType: 'stream', signal: options.signal }
      );
      onEvent({ type: 'start', provider: this.id, model });
      await this.consumeStream(response.data as NodeJS.ReadableStream, model, onEvent, options.signal);
    } catch (error) { throw this.normalizeError(error); }
  }

  async embed(_request: AiEmbeddingRequest, _options: AiRequestOptions = {}): Promise<AiEmbeddingResponse> {
    throw new AiProviderUnsupportedError(this.id, 'embeddings');
  }

  private toRequest(request: AiChatRequest, model: string, stream: boolean): Record<string, unknown> {
    const system = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    return {
      model,
      stream,
      max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
      messages: request.messages.filter((message) => message.role !== 'system'),
      ...(system ? { system } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { top_p: request.topP } : {}),
      ...(request.stop !== undefined ? { stop_sequences: request.stop } : {}),
    };
  }

  private consumeStream(
    stream: NodeJS.ReadableStream,
    model: string,
    onEvent: (event: AiStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const parser = new SseParser();
    return new Promise((resolve, reject) => {
      let settled = false;
      let completed = false;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let finishReason: AiChatResponse['finishReason'] = 'unknown';
      const cleanup = (): void => signal?.removeEventListener('abort', abort);
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        error ? reject(error) : resolve();
      };
      const abort = (): void => {
        (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        finish(new AiProviderAbortedError(this.id));
      };
      const consume = (events: ReturnType<SseParser['push']>): void => {
        for (const event of events) {
          let data: any;
          try { data = JSON.parse(event.data); } catch {
            throw new AiProviderResponseError(this.id, 'Anthropic returned malformed streaming data.');
          }
          const eventType = event.event || data.type;
          if (eventType === 'message_start') inputTokens = data.message?.usage?.input_tokens;
          if (eventType === 'content_block_delta' && data.delta?.type === 'text_delta' && data.delta.text) {
            onEvent({ type: 'delta', provider: this.id, model, content: data.delta.text });
          }
          if (eventType === 'message_delta') {
            outputTokens = data.usage?.output_tokens ?? outputTokens;
            finishReason = reasonFrom(data.delta?.stop_reason);
          }
          if (eventType === 'message_stop') {
            completed = true;
            const usage = usageFrom({ input_tokens: inputTokens, output_tokens: outputTokens });
            if (usage) onEvent({ type: 'usage', provider: this.id, model, usage });
            onEvent({ type: 'done', provider: this.id, model, finishReason, usage });
            finish();
            return;
          }
          if (eventType === 'error') throw new AiProviderError('Anthropic reported a streaming error.', 'PROVIDER_ERROR', this.id, false);
        }
      };

      signal?.addEventListener('abort', abort, { once: true });
      stream.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        try { consume(parser.push(chunk)); } catch (error) { finish(error instanceof Error ? error : undefined); }
      });
      stream.on('error', (error: Error) => finish(error));
      stream.on('end', () => {
        if (settled) return;
        try {
          consume(parser.finish());
          if (!completed) finish(new AiProviderResponseError(this.id, 'Anthropic stream ended before completion.'));
        } catch (error) { finish(error instanceof Error ? error : undefined); }
      });
    });
  }

  private normalizeError(error: unknown): AiProviderError {
    if (error instanceof AiProviderError) return error;
    const axiosError = error as AxiosError;
    if (axios.isCancel(error) || axiosError.code === 'ERR_CANCELED') return new AiProviderAbortedError(this.id, error);
    if (axiosError.code === 'ECONNABORTED' || axiosError.code === 'ETIMEDOUT') return new AiProviderTimeoutError(this.id, error);
    if (!axiosError.response || ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(axiosError.code || '')) return new AiProviderUnavailableError(this.id, error);
    return new AiProviderError(
      'Anthropic rejected the request.', 'PROVIDER_ERROR', this.id,
      Boolean(axiosError.response && (axiosError.response.status === 429 || axiosError.response.status >= 500)),
      { cause: error }
    );
  }
}
