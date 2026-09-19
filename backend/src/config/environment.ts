import dotenv from 'dotenv';
import Joi from 'joi';

dotenv.config();

export type KFiveMode = 'local' | 'hybrid' | 'remote';
export type AiProvider = 'ollama' | 'openai' | 'anthropic' | 'openai-compatible' | 'custom';

export interface EnvironmentConfig {
  processKind: 'api' | 'benchmark-worker' | 'notebook-worker';
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  apiVersion: string;
  kfiveMode: KFiveMode;
  aiProvider: AiProvider;
  aiDefaultModel: string;
  aiEmbeddingModel?: string;
  aiMaxOutputTokens: number;
  aiTimeoutMs: number;
  mongodbUrl: string;
  redisUrl: string;
  chromaUrl?: string;
  ollamaBaseUrl?: string;
  ollamaSocketPath?: string;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  openAiCompatibleSupportsEmbeddings: boolean;
  openAiCompatibleSupportsStructuredOutput: boolean;
  anthropicBaseUrl: string;
  anthropicApiKey?: string;
  customLlmBaseUrl?: string;
  customLlmApiKey?: string;
  customLlmSupportsEmbeddings: boolean;
  customLlmSupportsStructuredOutput: boolean;
  publicBaseUrl?: string;
  corsOrigins: string[];
  jwtSecret: string;
  jwtRefreshSecret: string;
  codeRunnerMode: 'disabled' | 'container';
  notebookExecutionEnabled: boolean;
  notebookRuntimeImage?: string;
  notebookVerifierImage?: string;
  documentProcessorUrl?: string;
  ocrServiceUrl?: string;
}

const schema = Joi.object({
  KFIVE_PROCESS: Joi.string().valid('api', 'benchmark-worker', 'notebook-worker').default('api'),
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(5000),
  API_VERSION: Joi.string().pattern(/^v\d+$/).default('v1'),
  KFIVE_MODE: Joi.string().valid('local', 'hybrid', 'remote').default('local'),
  AI_PROVIDER: Joi.string().valid('ollama', 'local-ollama', 'remote-ollama', 'openai', 'anthropic', 'openai-compatible', 'custom').default('ollama'),
  AI_DEFAULT_MODEL: Joi.string().trim().max(200).allow(''),
  AI_EMBEDDING_MODEL: Joi.string().trim().max(200).allow(''),
  OLLAMA_CHAT_MODEL: Joi.string().trim().max(200).allow(''),
  AI_MAX_OUTPUT_TOKENS: Joi.number().integer().min(1).max(131072).default(2048),
  AI_TIMEOUT_MS: Joi.number().integer().min(100).max(600000).default(30000),
  MONGODB_URL: Joi.string().uri({ scheme: ['mongodb', 'mongodb+srv'] }),
  MONGODB_URI: Joi.string().uri({ scheme: ['mongodb', 'mongodb+srv'] }),
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).required(),
  CHROMA_URL: Joi.string().uri({ scheme: ['http', 'https'] }).allow(''),
  OLLAMA_BASE_URL: Joi.string().uri({ scheme: ['http', 'https'] }).allow(''),
  OLLAMA_SOCKET_PATH: Joi.string().max(100).allow('').custom((value, helpers) => {
    // sockaddr_un limits are bytes, not JavaScript characters. Reject ambiguous paths.
    if (!value.startsWith('/') || Buffer.byteLength(value, 'utf8') > 100
      || [...value].some((character: string) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      || value.slice(1).split('/').some((part: string) => !part || part === '.' || part === '..')) {
      return helpers.error('any.custom', { message: 'OLLAMA_SOCKET_PATH must be an absolute normalized Unix socket path of at most 100 bytes without control characters' });
    }
    return value;
  }),
  OPENAI_BASE_URL: Joi.string().uri({ scheme: ['http', 'https'] }).allow(''),
  OPENAI_API_KEY: Joi.string().allow(''),
  OPENAI_COMPATIBLE_SUPPORTS_EMBEDDINGS: Joi.boolean().truthy('true').falsy('false').default(false),
  OPENAI_COMPATIBLE_SUPPORTS_STRUCTURED_OUTPUT: Joi.boolean().truthy('true').falsy('false').default(false),
  ANTHROPIC_BASE_URL: Joi.string().uri({ scheme: ['http', 'https'] }).default('https://api.anthropic.com'),
  ANTHROPIC_API_KEY: Joi.string().allow(''),
  CUSTOM_LLM_BASE_URL: Joi.string().uri({ scheme: ['http', 'https'] }).allow(''),
  CUSTOM_LLM_API_KEY: Joi.string().allow(''),
  CUSTOM_LLM_SUPPORTS_EMBEDDINGS: Joi.boolean().truthy('true').falsy('false').default(false),
  CUSTOM_LLM_SUPPORTS_STRUCTURED_OUTPUT: Joi.boolean().truthy('true').falsy('false').default(false),
  PUBLIC_BASE_URL: Joi.string().uri({ scheme: ['http', 'https'] }).allow(''),
  CORS_ORIGIN: Joi.string().default('http://localhost:3000'),
  JWT_SECRET: Joi.when('KFIVE_PROCESS', {
    is: 'api', then: Joi.string().min(32).required(),
    otherwise: Joi.string().min(32).default('kfive-worker-no-http-authentication-00000001'),
  }),
  JWT_REFRESH_SECRET: Joi.when('KFIVE_PROCESS', {
    is: 'api', then: Joi.string().min(32).required(),
    otherwise: Joi.string().min(32).default('kfive-worker-no-refresh-authentication-0001'),
  }),
  CODE_RUNNER_MODE: Joi.string().valid('disabled', 'container').default('disabled'),
  NOTEBOOK_EXECUTION_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  NOTEBOOK_RUNTIME_IMAGE: Joi.string().trim().max(500).allow(''),
  NOTEBOOK_VERIFIER_IMAGE: Joi.string().trim().max(500).allow(''),
  DOCUMENT_PROCESSOR_URL: Joi.string().uri({ scheme: ['http', 'https'] }).allow(''),
  OCR_SERVICE_URL: Joi.string().uri({ scheme: ['http', 'https'] }).allow(''),
}).unknown(true).custom((value, helpers) => {
  if (!value.MONGODB_URL && !value.MONGODB_URI) {
    return helpers.error('any.custom', { message: 'MONGODB_URL is required' });
  }

  const corsOrigins: string[] = [];
  for (const rawOrigin of value.CORS_ORIGIN.split(',')) {
    const origin = rawOrigin.trim().replace(/\/$/, '');
    if (!origin) continue;
    try {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
        return helpers.error('any.custom', {
          message: `CORS_ORIGIN entries must be HTTP(S) origins without credentials, paths, queries, or fragments: ${origin}`,
        });
      }
      corsOrigins.push(origin);
    } catch {
      return helpers.error('any.custom', { message: `CORS_ORIGIN contains an invalid origin: ${origin}` });
    }
  }
  if (corsOrigins.length === 0) {
    return helpers.error('any.custom', { message: 'CORS_ORIGIN must contain at least one HTTP(S) origin' });
  }
  value.CORS_ORIGIN = corsOrigins.join(',');

  if (value.PUBLIC_BASE_URL) {
    const publicOrigin = new URL(value.PUBLIC_BASE_URL).origin;
    if (!corsOrigins.includes(publicOrigin)) {
      return helpers.error('any.custom', {
        message: `CORS_ORIGIN must include the PUBLIC_BASE_URL origin ${publicOrigin}`,
      });
    }
  }

  const provider = value.AI_PROVIDER;
  if (value.OLLAMA_SOCKET_PATH && !['ollama', 'local-ollama', 'remote-ollama'].includes(provider)) {
    return helpers.error('any.custom', { message: 'OLLAMA_SOCKET_PATH is only supported by the Ollama provider' });
  }
  for (const key of ['OLLAMA_BASE_URL', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'CUSTOM_LLM_BASE_URL']) {
    const raw = value[key];
    if (raw) {
      const parsed = new URL(raw);
      if (parsed.username || parsed.password) {
        return helpers.error('any.custom', { message: `${key} must not contain embedded credentials` });
      }
    }
  }
  if (['ollama', 'local-ollama', 'remote-ollama'].includes(provider) && !value.OLLAMA_BASE_URL) {
    return helpers.error('any.custom', { message: 'OLLAMA_BASE_URL is required for the Ollama provider' });
  }
  if (provider === 'openai' && !value.OPENAI_API_KEY) {
    return helpers.error('any.custom', { message: 'OPENAI_API_KEY is required for the OpenAI provider' });
  }
  if (provider === 'anthropic' && !value.ANTHROPIC_API_KEY) {
    return helpers.error('any.custom', { message: 'ANTHROPIC_API_KEY is required for the Anthropic provider' });
  }
  if (provider === 'openai-compatible' && !value.OPENAI_BASE_URL) {
    return helpers.error('any.custom', { message: 'OPENAI_BASE_URL is required for an OpenAI-compatible provider' });
  }
  if (provider === 'custom' && !value.CUSTOM_LLM_BASE_URL) {
    return helpers.error('any.custom', { message: 'CUSTOM_LLM_BASE_URL is required for a custom provider' });
  }
  if (value.NODE_ENV === 'production') {
    const unsafeSecret = (secret: string) => /change|example|replace|secret/i.test(secret);
    if (value.KFIVE_PROCESS === 'api' && (unsafeSecret(value.JWT_SECRET) || unsafeSecret(value.JWT_REFRESH_SECRET))) {
      return helpers.error('any.custom', { message: 'Production JWT secrets must not use example/default values' });
    }
    if (provider === 'openai' && value.OPENAI_BASE_URL && !value.OPENAI_BASE_URL.startsWith('https://')) {
      return helpers.error('any.custom', { message: 'OPENAI_BASE_URL must use HTTPS for the OpenAI provider in production' });
    }
    if (provider === 'anthropic' && !value.ANTHROPIC_BASE_URL.startsWith('https://')) {
      return helpers.error('any.custom', { message: 'ANTHROPIC_BASE_URL must use HTTPS in production' });
    }
  }
  if (value.NOTEBOOK_EXECUTION_ENABLED && (!value.NOTEBOOK_RUNTIME_IMAGE || !value.NOTEBOOK_VERIFIER_IMAGE)) {
    return helpers.error('any.custom', { message: 'NOTEBOOK_RUNTIME_IMAGE and NOTEBOOK_VERIFIER_IMAGE are required when notebook execution is enabled' });
  }
  if (value.NOTEBOOK_RUNTIME_IMAGE && value.NOTEBOOK_RUNTIME_IMAGE === value.NOTEBOOK_VERIFIER_IMAGE) {
    return helpers.error('any.custom', { message: 'Notebook runtime and verifier images must be distinct' });
  }
  return value;
}, 'cross-field environment validation');

const cleanOptional = (value?: string): string | undefined => value || undefined;

export function parseEnvironment(source: NodeJS.ProcessEnv): EnvironmentConfig {
  const { value, error } = schema.validate(source, { abortEarly: false, convert: true });
  if (error) {
    const details = error.details.map((detail) => detail.context?.message || detail.message).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const provider: AiProvider = ['local-ollama', 'remote-ollama'].includes(value.AI_PROVIDER)
    ? 'ollama'
    : value.AI_PROVIDER;

  return {
    processKind: value.KFIVE_PROCESS,
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    apiVersion: value.API_VERSION,
    kfiveMode: value.KFIVE_MODE,
    aiProvider: provider,
    aiDefaultModel: cleanOptional(value.AI_DEFAULT_MODEL) || cleanOptional(value.OLLAMA_CHAT_MODEL) || 'phi3',
    aiEmbeddingModel: cleanOptional(value.AI_EMBEDDING_MODEL),
    aiMaxOutputTokens: value.AI_MAX_OUTPUT_TOKENS,
    aiTimeoutMs: value.AI_TIMEOUT_MS,
    mongodbUrl: value.MONGODB_URL || value.MONGODB_URI,
    redisUrl: value.REDIS_URL,
    chromaUrl: cleanOptional(value.CHROMA_URL),
    ollamaBaseUrl: cleanOptional(value.OLLAMA_BASE_URL),
    ollamaSocketPath: cleanOptional(value.OLLAMA_SOCKET_PATH),
    openaiBaseUrl: cleanOptional(value.OPENAI_BASE_URL),
    openaiApiKey: cleanOptional(value.OPENAI_API_KEY),
    openAiCompatibleSupportsEmbeddings: value.OPENAI_COMPATIBLE_SUPPORTS_EMBEDDINGS,
    openAiCompatibleSupportsStructuredOutput: value.OPENAI_COMPATIBLE_SUPPORTS_STRUCTURED_OUTPUT,
    anthropicBaseUrl: value.ANTHROPIC_BASE_URL,
    anthropicApiKey: cleanOptional(value.ANTHROPIC_API_KEY),
    customLlmBaseUrl: cleanOptional(value.CUSTOM_LLM_BASE_URL),
    customLlmApiKey: cleanOptional(value.CUSTOM_LLM_API_KEY),
    customLlmSupportsEmbeddings: value.CUSTOM_LLM_SUPPORTS_EMBEDDINGS,
    customLlmSupportsStructuredOutput: value.CUSTOM_LLM_SUPPORTS_STRUCTURED_OUTPUT,
    publicBaseUrl: cleanOptional(value.PUBLIC_BASE_URL),
    corsOrigins: value.CORS_ORIGIN.split(',').map((origin: string) => origin.trim()).filter(Boolean),
    jwtSecret: value.JWT_SECRET,
    jwtRefreshSecret: value.JWT_REFRESH_SECRET,
    codeRunnerMode: value.CODE_RUNNER_MODE,
    notebookExecutionEnabled: value.NOTEBOOK_EXECUTION_ENABLED,
    notebookRuntimeImage: cleanOptional(value.NOTEBOOK_RUNTIME_IMAGE),
    notebookVerifierImage: cleanOptional(value.NOTEBOOK_VERIFIER_IMAGE),
    documentProcessorUrl: cleanOptional(value.DOCUMENT_PROCESSOR_URL),
    ocrServiceUrl: cleanOptional(value.OCR_SERVICE_URL),
  };
}

let cachedEnvironment: EnvironmentConfig | undefined;

export function getEnvironment(): EnvironmentConfig {
  if (!cachedEnvironment) {
    cachedEnvironment = parseEnvironment(process.env);
  }
  return cachedEnvironment;
}

export function resetEnvironmentForTests(): void {
  cachedEnvironment = undefined;
}
