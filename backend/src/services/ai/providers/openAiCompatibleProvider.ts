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
  AiUsage,
} from '../types';

export interface OpenAiCompatibleProviderConfig {
  id: 'openai' | 'openai-compatible' | 'custom';
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  maxOutputTokens: number;
  timeoutMs: number;
  supportsEmbeddings: boolean;
  supportsStructuredOutput: boolean;
}

interface CompatibleModelRecord { id?: string; created?: number; owned_by?: string }
interface CompatibleUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
interface CompatibleChoice {
  message?: { content?: string };
  delta?: { content?: string };
  finish_reason?: string | null;
}
interface CompatibleResponse { model?: string; choices?: CompatibleChoice[]; usage?: CompatibleUsage }

function normalizeUsage(usage?: CompatibleUsage): AiUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

function normalizeFinishReason(reason?: string | null): AiChatResponse['finishReason'] {
  if (reason === 'stop') return 'stop';
  if (reason === 'length') return 'length';
  if (reason) return 'unknown';
  return 'unknown';
}

export class OpenAiCompatibleProvider implements AiProviderClient {
  readonly id: string;
  readonly capabilities: AiProviderCapabilities;
  private readonly client: AxiosInstance;

  constructor(private readonly config: OpenAiCompatibleProviderConfig, client?: AxiosInstance) {
    this.id = config.id;
    this.capabilities = {
      chat: true,
      streaming: true,
      embeddings: config.supportsEmbeddings,
      structuredOutput: config.supportsStructuredOutput,
      modelListing: true,
    };
    this.client = client || axios.create({
      baseURL: config.baseUrl.replace(/\/$/, ''),
      timeout: config.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
    });
  }

  async healthCheck(options: AiRequestOptions = {}): Promise<boolean> {
    try {
      const response = await this.client.get('/models', { signal: options.signal });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async connectionTest(options: AiRequestOptions = {}): Promise<AiProviderConnectionTest> {
    const startedAt = Date.now();
    const connected = await this.healthCheck(options);
    return {
      connected,
      supported: true,
      latencyMs: Date.now() - startedAt,
      message: connected ? `Connected to the configured ${this.id} provider.` : `The configured ${this.id} provider is unavailable.`,
    };
  }

  async listModels(options: AiRequestOptions = {}): Promise<AiModel[]> {
    try {
      const response = await this.client.get('/models', { signal: options.signal });
      const records = Array.isArray(response.data?.data) ? response.data.data as CompatibleModelRecord[] : [];
      return records.map((record) => {
        if (!record.id) throw new AiProviderResponseError(this.id, `${this.id} returned a model without an id.`);
        return {
          id: record.id,
          name: record.id,
          provider: this.id,
          modifiedAt: typeof record.created === 'number' ? new Date(record.created * 1000).toISOString() : undefined,
          metadata: record.owned_by ? { ownedBy: record.owned_by } : undefined,
        };
      });
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  async chat(request: AiChatRequest, options: AiRequestOptions = {}): Promise<AiChatResponse> {
    const model = request.model || this.config.defaultModel;
    try {
      const response = await this.client.post<CompatibleResponse>(
        '/chat/completions',
        this.toRequest(request, model, false),
        { signal: options.signal }
      );
      const choice = response.data?.choices?.[0];
      if (typeof choice?.message?.content !== 'string') {
        throw new AiProviderResponseError(this.id, `${this.id} returned a chat response without message content.`);
      }
      return {
        provider: this.id,
        model: response.data.model || model,
        content: choice.message.content,
        finishReason: normalizeFinishReason(choice.finish_reason),
        usage: normalizeUsage(response.data.usage),
      };
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  async chatStream(
    request: AiChatRequest,
    onEvent: (event: AiStreamEvent) => void,
    options: AiRequestOptions = {}
  ): Promise<void> {
    const model = request.model || this.config.defaultModel;
    if (options.signal?.aborted) throw new AiProviderAbortedError(this.id);
    try {
      const response = await this.client.post(
        '/chat/completions',
        this.toRequest(request, model, true),
        { responseType: 'stream', signal: options.signal }
      );
      onEvent({ type: 'start', provider: this.id, model });
      await this.consumeStream(response.data as NodeJS.ReadableStream, model, onEvent, options.signal);
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  async embed(request: AiEmbeddingRequest, options: AiRequestOptions = {}): Promise<AiEmbeddingResponse> {
    if (!this.capabilities.embeddings) throw new AiProviderUnsupportedError(this.id, 'embeddings');
    const model = request.model || this.config.defaultModel;
    try {
      const response = await this.client.post('/embeddings', { model, input: request.input }, { signal: options.signal });
      const inputCount = Array.isArray(request.input) ? request.input.length : 1;
      const records = Array.isArray(response.data?.data) ? response.data.data as Array<{ embedding?: unknown; index?: unknown }> : [];
      if (records.length !== inputCount) {
        throw new AiProviderResponseError(this.id, `${this.id} returned an unexpected number of embeddings.`);
      }
      const ordered = inputCount === 1 && records[0]?.index === undefined
        ? records
        : records.slice().sort((left, right) => {
          if (!Number.isInteger(left.index) || !Number.isInteger(right.index)) return 0;
          return (left.index as number) - (right.index as number);
        });
      if (ordered.some((record, index) => record.index !== undefined && record.index !== index)
        || (inputCount > 1 && ordered.some((record) => !Number.isInteger(record.index)))) {
        throw new AiProviderResponseError(this.id, `${this.id} returned invalid embedding indexes.`);
      }
      const embeddings = ordered.map((record) => {
        if (!Array.isArray(record.embedding)) throw new AiProviderResponseError(this.id, `${this.id} returned invalid embedding data.`);
        return record.embedding as number[];
      });
      return { provider: this.id, model: response.data?.model || model, embeddings, usage: normalizeUsage(response.data?.usage) };
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private toRequest(request: AiChatRequest, model: string, stream: boolean): Record<string, unknown> {
    if (request.structuredOutput && !this.capabilities.structuredOutput) {
      throw new AiProviderUnsupportedError(this.id, 'structured output');
    }
    return {
      model,
      messages: request.messages,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { top_p: request.topP } : {}),
      ...(request.stop !== undefined ? { stop: request.stop } : {}),
      ...(request.structuredOutput ? { response_format: { type: 'json_object' } } : {}),
    };
  }

  private consumeStream(
    stream: NodeJS.ReadableStream,
    fallbackModel: string,
    onEvent: (event: AiStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const parser = new SseParser();
    return new Promise((resolve, reject) => {
      let settled = false;
      let completed = false;
      let lastReason: AiChatResponse['finishReason'] = 'unknown';
      let lastUsage: AiUsage | undefined;
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
          if (event.data === '[DONE]') {
            completed = true;
            onEvent({ type: 'done', provider: this.id, model: fallbackModel, finishReason: lastReason, usage: lastUsage });
            finish();
            return;
          }
          let record: CompatibleResponse;
          try { record = JSON.parse(event.data) as CompatibleResponse; } catch {
            throw new AiProviderResponseError(this.id, `${this.id} returned malformed streaming data.`);
          }
          const eventModel = record.model || fallbackModel;
          for (const choice of record.choices || []) {
            if (choice.delta?.content) onEvent({ type: 'delta', provider: this.id, model: eventModel, content: choice.delta.content });
            if (choice.finish_reason) lastReason = normalizeFinishReason(choice.finish_reason);
          }
          const usage = normalizeUsage(record.usage);
          if (usage) {
            lastUsage = usage;
            onEvent({ type: 'usage', provider: this.id, model: eventModel, usage });
          }
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
          if (!completed) finish(new AiProviderResponseError(this.id, `${this.id} stream ended before completion.`));
        } catch (error) { finish(error instanceof Error ? error : undefined); }
      });
    });
  }

  private normalizeError(error: unknown): AiProviderError {
    if (error instanceof AiProviderError) return error;
    const axiosError = error as AxiosError;
    if (axios.isCancel(error) || axiosError.code === 'ERR_CANCELED') return new AiProviderAbortedError(this.id, error);
    if (axiosError.code === 'ECONNABORTED' || axiosError.code === 'ETIMEDOUT') return new AiProviderTimeoutError(this.id, error);
    if (!axiosError.response || ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(axiosError.code || '')) {
      return new AiProviderUnavailableError(this.id, error);
    }
    return new AiProviderError(
      `${this.id} rejected the request.`,
      'PROVIDER_ERROR',
      this.id,
      Boolean(axiosError.response && (axiosError.response.status === 429 || axiosError.response.status >= 500)),
      { cause: error }
    );
  }
}
