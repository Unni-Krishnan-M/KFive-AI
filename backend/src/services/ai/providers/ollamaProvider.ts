import axios, { AxiosError, AxiosInstance } from 'axios';
import { NdjsonParser } from '@/utils/ndjson';
import {
  AiProviderAbortedError,
  AiProviderError,
  AiProviderResponseError,
  AiProviderTimeoutError,
  AiProviderUnavailableError,
} from '../errors';
import {
  AiChatRequest,
  AiChatResponse,
  AiEmbeddingRequest,
  AiEmbeddingResponse,
  AiModel,
  AiModelPullProgress,
  AiProviderCapabilities,
  AiProviderClient,
  AiProviderConnectionTest,
  AiRequestOptions,
  AiStreamEvent,
  AiUsage,
} from '../types';

export interface OllamaProviderConfig {
  baseUrl: string;
  defaultModel: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

interface OllamaModelRecord {
  name: string;
  model?: string;
  size?: number;
  digest?: string;
  modified_at?: string;
  details?: Record<string, unknown> & { context_length?: number };
  capabilities?: string[];
}

interface OllamaChatRecord {
  model: string;
  message?: { role?: string; content?: string };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaPullRecord {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

function durationMs(nanoseconds?: number): number | undefined {
  return typeof nanoseconds === 'number' ? nanoseconds / 1_000_000 : undefined;
}

function usageFrom(record: OllamaChatRecord): AiUsage | undefined {
  const usage: AiUsage = {
    inputTokens: record.prompt_eval_count,
    outputTokens: record.eval_count,
    totalDurationMs: durationMs(record.total_duration),
    loadDurationMs: durationMs(record.load_duration),
  };
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    usage.totalTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
  }
  return Object.values(usage).some((value) => value !== undefined) ? usage : undefined;
}

function finishReason(record: OllamaChatRecord): AiChatResponse['finishReason'] {
  if (record.done_reason === 'length') return 'length';
  if (record.done) return 'stop';
  return 'unknown';
}

export class OllamaProvider implements AiProviderClient {
  readonly id = 'ollama';
  readonly capabilities: AiProviderCapabilities = {
    chat: true,
    streaming: true,
    embeddings: true,
    structuredOutput: true,
    modelListing: true,
    modelPull: true,
    modelDelete: true,
  };

  private readonly client: AxiosInstance;

  constructor(private readonly config: OllamaProviderConfig, client?: AxiosInstance) {
    this.client = client || axios.create({
      baseURL: config.baseUrl.replace(/\/$/, ''),
      timeout: config.timeoutMs,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async healthCheck(options: AiRequestOptions = {}): Promise<boolean> {
    try {
      const response = await this.client.get('/api/tags', { signal: options.signal });
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
      message: connected
        ? 'Connected to the configured Ollama provider.'
        : 'The configured Ollama provider is unavailable.',
    };
  }

  async listModels(options: AiRequestOptions = {}): Promise<AiModel[]> {
    try {
      const response = await this.client.get('/api/tags', { signal: options.signal });
      const records = Array.isArray(response.data?.models) ? response.data.models as OllamaModelRecord[] : [];
      return records.map((record) => this.normalizeModel(record));
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  async pullModel(
    model: string,
    onProgress: (progress: AiModelPullProgress) => void,
    options: AiRequestOptions = {}
  ): Promise<void> {
    if (options.signal?.aborted) throw new AiProviderAbortedError(this.id);
    try {
      const response = await this.client.post(
        '/api/pull',
        { name: model, stream: true },
        { responseType: 'stream', signal: options.signal }
      );
      await this.consumePullStream(response.data as NodeJS.ReadableStream, onProgress, options.signal);
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  async deleteModel(model: string, options: AiRequestOptions = {}): Promise<void> {
    try {
      await this.client.delete('/api/delete', { data: { name: model }, signal: options.signal });
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  async chat(request: AiChatRequest, options: AiRequestOptions = {}): Promise<AiChatResponse> {
    const model = request.model || this.config.defaultModel;
    try {
      const response = await this.client.post<OllamaChatRecord>(
        '/api/chat',
        this.toOllamaChatRequest(request, model, false),
        { signal: options.signal }
      );
      const record = response.data;
      if (!record || typeof record.message?.content !== 'string') {
        throw new AiProviderResponseError(this.id, 'Ollama returned a chat response without message content.');
      }
      return {
        provider: this.id,
        model: record.model || model,
        content: record.message.content,
        finishReason: finishReason(record),
        usage: usageFrom(record),
        raw: record,
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
        '/api/chat',
        this.toOllamaChatRequest(request, model, true),
        { responseType: 'stream', signal: options.signal }
      );
      onEvent({ type: 'start', provider: this.id, model });
      await this.consumeChatStream(response.data as NodeJS.ReadableStream, model, onEvent, options.signal);
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  async embed(request: AiEmbeddingRequest, options: AiRequestOptions = {}): Promise<AiEmbeddingResponse> {
    const model = request.model || this.config.defaultModel;
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    try {
      const embeddings = await Promise.all(inputs.map(async (input) => {
        const response = await this.client.post(
          '/api/embeddings',
          { model, prompt: input },
          { signal: options.signal }
        );
        if (!Array.isArray(response.data?.embedding)) {
          throw new AiProviderResponseError(this.id, 'Ollama returned an invalid embedding response.');
        }
        return response.data.embedding as number[];
      }));
      return { provider: this.id, model, embeddings };
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private normalizeModel(record: OllamaModelRecord): AiModel {
    const name = record.name || record.model;
    if (!name) throw new AiProviderResponseError(this.id, 'Ollama returned a model without a name.');
    const capabilities = new Set(record.capabilities || []);
    return {
      id: name,
      name,
      provider: this.id,
      sizeBytes: record.size,
      modifiedAt: record.modified_at,
      contextWindow: record.details?.context_length,
      capabilities: {
        chat: capabilities.has('completion'),
        embeddings: capabilities.has('embedding'),
        vision: capabilities.has('vision'),
        tools: capabilities.has('tools'),
      },
      metadata: record.details,
      size: record.size,
      digest: record.digest,
      modified_at: record.modified_at,
    };
  }

  private toOllamaChatRequest(request: AiChatRequest, model: string, stream: boolean): Record<string, unknown> {
    return {
      model,
      messages: request.messages,
      stream,
      ...(request.structuredOutput ? { format: 'json' } : {}),
      options: {
        num_predict: request.maxOutputTokens ?? this.config.maxOutputTokens,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { top_p: request.topP } : {}),
        ...(request.stop !== undefined ? { stop: request.stop } : {}),
      },
    };
  }

  private consumeChatStream(
    stream: NodeJS.ReadableStream,
    fallbackModel: string,
    onEvent: (event: AiStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const parser = new NdjsonParser<OllamaChatRecord>();
    return new Promise((resolve, reject) => {
      let settled = false;
      let completed = false;
      const cleanup = (): void => signal?.removeEventListener('abort', abort);
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        error ? reject(error) : resolve();
      };
      const abort = (): void => {
        const destroyable = stream as NodeJS.ReadableStream & { destroy?: (error?: Error) => void };
        destroyable.destroy?.();
        finish(new AiProviderAbortedError(this.id));
      };
      const consume = (records: OllamaChatRecord[]): void => {
        for (const record of records) {
          if (!record || typeof record.done !== 'boolean') {
            throw new AiProviderResponseError(this.id, 'Ollama returned malformed streaming data.');
          }
          const eventModel = record.model || fallbackModel;
          const content = record.message?.content;
          if (content) onEvent({ type: 'delta', provider: this.id, model: eventModel, content });
          if (record.done) {
            completed = true;
            const usage = usageFrom(record);
            if (usage) onEvent({ type: 'usage', provider: this.id, model: eventModel, usage });
            onEvent({ type: 'done', provider: this.id, model: eventModel, finishReason: finishReason(record), usage });
            finish();
            return;
          }
        }
      };

      signal?.addEventListener('abort', abort, { once: true });
      stream.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        try { consume(parser.push(chunk)); } catch (error) {
          finish(error instanceof Error ? error : new AiProviderResponseError(this.id, 'Ollama returned malformed streaming data.'));
        }
      });
      stream.on('error', (error: Error) => finish(error));
      stream.on('end', () => {
        if (settled) return;
        try {
          consume(parser.finish());
          if (!completed) finish(new AiProviderResponseError(this.id, 'Ollama stream ended before completion.'));
        } catch (error) {
          finish(error instanceof Error ? error : new AiProviderResponseError(this.id, 'Ollama returned malformed streaming data.'));
        }
      });
    });
  }

  private consumePullStream(
    stream: NodeJS.ReadableStream,
    onProgress: (progress: AiModelPullProgress) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const parser = new NdjsonParser<OllamaPullRecord>();
    return new Promise((resolve, reject) => {
      let settled = false;
      let completed = false;
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
      const consume = (records: OllamaPullRecord[]): void => {
        for (const record of records) {
          if (record.error) throw new AiProviderError(record.error, 'PROVIDER_ERROR', this.id, false);
          if (typeof record.status !== 'string') {
            throw new AiProviderResponseError(this.id, 'Ollama returned malformed model-pull progress.');
          }
          const percent = typeof record.total === 'number' && record.total > 0 && typeof record.completed === 'number'
            ? Math.min(100, Math.round((record.completed / record.total) * 100))
            : undefined;
          onProgress({
            status: record.status,
            digest: record.digest,
            total: record.total,
            completed: record.completed,
            percent,
          });
          if (record.status === 'success') completed = true;
        }
      };

      signal?.addEventListener('abort', abort, { once: true });
      stream.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        try { consume(parser.push(chunk)); } catch (error) {
          finish(error instanceof Error ? error : new AiProviderResponseError(this.id, 'Ollama returned malformed model-pull progress.'));
        }
      });
      stream.on('error', (error: Error) => finish(error));
      stream.on('end', () => {
        if (settled) return;
        try {
          consume(parser.finish());
          if (!completed) finish(new AiProviderResponseError(this.id, 'Ollama model-pull stream ended before success.'));
          else finish();
        } catch (error) {
          finish(error instanceof Error ? error : new AiProviderResponseError(this.id, 'Ollama returned malformed model-pull progress.'));
        }
      });
    });
  }

  private normalizeError(error: unknown): AiProviderError {
    if (error instanceof AiProviderError) return error;
    const axiosError = error as AxiosError;
    if (axios.isCancel(error) || axiosError.code === 'ERR_CANCELED') {
      return new AiProviderAbortedError(this.id, error);
    }
    if (axiosError.code === 'ECONNABORTED' || axiosError.code === 'ETIMEDOUT') {
      return new AiProviderTimeoutError(this.id, error);
    }
    if (!axiosError.response || ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(axiosError.code || '')) {
      return new AiProviderUnavailableError(this.id, error);
    }
    const providerMessage = (axiosError.response?.data as { error?: string } | undefined)?.error;
    return new AiProviderError(
      providerMessage || 'Ollama rejected the request.',
      'PROVIDER_ERROR',
      this.id,
      Boolean(axiosError.response && axiosError.response.status >= 500),
      { cause: error }
    );
  }
}
