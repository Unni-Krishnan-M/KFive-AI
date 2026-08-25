import axios, { AxiosInstance } from 'axios';
import { logger } from '@/utils/logger';
import { getEnvironment } from '@/config/environment';
import { NdjsonParser } from '@/utils/ndjson';

export interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
}

export interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  system?: string;
  template?: string;
  context?: number[];
  stream?: boolean;
  raw?: boolean;
  format?: 'json';
  options?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    repeat_penalty?: number;
    seed?: number;
    num_predict?: number;
    stop?: string[];
  };
}

export interface OllamaGenerateResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: string[];
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream?: boolean;
  format?: 'json';
  options?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    repeat_penalty?: number;
    seed?: number;
    num_predict?: number;
    stop?: string[];
  };
}

export interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: OllamaChatMessage;
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface OllamaEmbeddingRequest {
  model: string;
  prompt: string;
}

export interface OllamaEmbeddingResponse {
  embedding: number[];
}

function consumeOllamaStream<T extends { done: boolean }>(
  stream: NodeJS.ReadableStream,
  onChunk: (chunk: T) => void,
  label: string
): Promise<void> {
  const parser = new NdjsonParser<T>();

  return new Promise((resolve, reject) => {
    let settled = false;

    const consume = (records: T[]): void => {
      for (const record of records) {
        onChunk(record);
        if (record.done) {
          settled = true;
          resolve();
          return;
        }
      }
    };

    stream.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      try {
        consume(parser.push(chunk));
      } catch {
        settled = true;
        reject(new Error(`${label} returned malformed streaming data`));
      }
    });

    stream.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });

    stream.on('end', () => {
      if (settled) return;
      try {
        consume(parser.finish());
        if (!settled) {
          settled = true;
          reject(new Error(`${label} stream ended before a completion record was received`));
        }
      } catch {
        settled = true;
        reject(new Error(`${label} returned malformed streaming data`));
      }
    });
  });
}

class OllamaService {
  private client: AxiosInstance;
  private baseUrl: string;

  constructor() {
    this.baseUrl = getEnvironment().ollamaBaseUrl || '';
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: parseInt(process.env.AI_TIMEOUT_MS || '30000'),
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Request interceptor for logging
    this.client.interceptors.request.use(
      (config) => {
        logger.debug(`Ollama request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        logger.error('Ollama request error:', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor for logging
    this.client.interceptors.response.use(
      (response) => {
        logger.debug(`Ollama response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        logger.error('Ollama response error:', error.response?.data || error.message);
        return Promise.reject(error);
      }
    );
  }

  /**
   * Check if Ollama is running and accessible
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.get('/api/tags');
      return response.status === 200;
    } catch (error) {
      logger.error('Ollama health check failed:', error);
      return false;
    }
  }

  /**
   * List available models
   */
  async listModels(): Promise<OllamaModel[]> {
    try {
      const response = await this.client.get('/api/tags');
      return response.data.models || [];
    } catch (error) {
      logger.error('Failed to list Ollama models:', error);
      throw new Error('Failed to connect to Ollama. Please ensure Ollama is running.');
    }
  }

  /**
   * Generate text completion
   */
  async generate(request: OllamaGenerateRequest): Promise<OllamaGenerateResponse> {
    try {
      const response = await this.client.post('/api/generate', request);
      return response.data;
    } catch (error: any) {
      logger.error('Ollama generate error:', error);
      throw new Error(`Ollama generation failed: ${error.response?.data?.error || error.message}`);
    }
  }

  /**
   * Generate streaming text completion
   */
  async generateStream(
    request: OllamaGenerateRequest,
    onChunk: (chunk: OllamaGenerateResponse) => void
  ): Promise<void> {
    try {
      const response = await this.client.post('/api/generate', 
        { ...request, stream: true },
        { responseType: 'stream' }
      );

      return consumeOllamaStream<OllamaGenerateResponse>(response.data, onChunk, 'Ollama generate');
    } catch (error: any) {
      logger.error('Ollama generate stream error:', error);
      throw new Error(`Ollama streaming failed: ${error.response?.data?.error || error.message}`);
    }
  }

  /**
   * Chat completion
   */
  async chat(request: OllamaChatRequest): Promise<OllamaChatResponse> {
    try {
      const response = await this.client.post('/api/chat', request);
      return response.data;
    } catch (error: any) {
      logger.error('Ollama chat error:', error);
      throw new Error(`Ollama chat failed: ${error.response?.data?.error || error.message}`);
    }
  }

  /**
   * Streaming chat completion
   */
  async chatStream(
    request: OllamaChatRequest,
    onChunk: (chunk: OllamaChatResponse) => void
  ): Promise<void> {
    try {
      const response = await this.client.post('/api/chat',
        { ...request, stream: true },
        { responseType: 'stream' }
      );

      return consumeOllamaStream<OllamaChatResponse>(response.data, onChunk, 'Ollama chat');
    } catch (error: any) {
      logger.error('Ollama chat stream error:', error.message || error);
      throw new Error(`Ollama chat streaming failed: ${error.response?.data?.error || error.message}`);
    }
  }

  /**
   * Generate embeddings
   */
  async embeddings(request: OllamaEmbeddingRequest): Promise<number[]> {
    try {
      const response = await this.client.post('/api/embeddings', request);
      return response.data.embedding;
    } catch (error: any) {
      logger.error('Ollama embeddings error:', error);
      throw new Error(`Ollama embeddings failed: ${error.response?.data?.error || error.message}`);
    }
  }

  /**
   * Pull a model
   */
  async pullModel(modelName: string): Promise<void> {
    try {
      await this.client.post('/api/pull', { name: modelName });
    } catch (error: any) {
      logger.error('Ollama pull model error:', error);
      throw new Error(`Failed to pull model ${modelName}: ${error.response?.data?.error || error.message}`);
    }
  }

  /**
   * Delete a model
   */
  async deleteModel(modelName: string): Promise<void> {
    try {
      await this.client.delete('/api/delete', { data: { name: modelName } });
    } catch (error: any) {
      logger.error('Ollama delete model error:', error);
      throw new Error(`Failed to delete model ${modelName}: ${error.response?.data?.error || error.message}`);
    }
  }
}

export const ollamaService = new OllamaService();
