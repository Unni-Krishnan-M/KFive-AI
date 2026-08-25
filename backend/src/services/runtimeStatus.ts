import { EnvironmentConfig } from '@/config/environment';

export type ServiceLocation = 'local' | 'remote' | 'disabled' | 'unknown';

export interface RuntimeServiceStatus {
  id: string;
  configured: boolean;
  location: ServiceLocation;
  restartRequired: boolean;
}

const localHostnames = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'host.docker.internal',
  'mongodb',
  'redis',
  'chromadb',
  'document-processor',
  'ocr',
]);

function classifyUrl(url: string | undefined): ServiceLocation {
  if (!url) return 'disabled';

  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return localHostnames.has(hostname) || hostname.endsWith('.local') ? 'local' : 'remote';
  } catch {
    return 'unknown';
  }
}

function providerLocation(config: EnvironmentConfig): ServiceLocation {
  switch (config.aiProvider) {
    case 'ollama':
      return classifyUrl(config.ollamaBaseUrl);
    case 'openai':
    case 'anthropic':
      return 'remote';
    case 'openai-compatible':
      return classifyUrl(config.openaiBaseUrl);
    case 'custom':
      return classifyUrl(config.customLlmBaseUrl);
  }
}

export function buildRuntimeStatus(config: EnvironmentConfig) {
  const services: RuntimeServiceStatus[] = [
    { id: 'mongodb', configured: Boolean(config.mongodbUrl), location: classifyUrl(config.mongodbUrl), restartRequired: true },
    { id: 'redis', configured: Boolean(config.redisUrl), location: classifyUrl(config.redisUrl), restartRequired: true },
    { id: 'chromadb', configured: Boolean(config.chromaUrl), location: classifyUrl(config.chromaUrl), restartRequired: true },
    { id: 'code-runner', configured: config.codeRunnerMode !== 'disabled', location: config.codeRunnerMode === 'disabled' ? 'disabled' : 'local', restartRequired: true },
    { id: 'document-processor', configured: Boolean(config.documentProcessorUrl), location: classifyUrl(config.documentProcessorUrl), restartRequired: true },
    { id: 'ocr', configured: Boolean(config.ocrServiceUrl), location: classifyUrl(config.ocrServiceUrl), restartRequired: true },
  ];

  const serviceLabels: Record<string, string> = {
    chromadb: 'ChromaDB',
    'code-runner': 'Code Runner',
    'document-processor': 'Document Processor',
    ocr: 'OCR service',
  };
  const missingDependencies = services
    .filter((service) => !service.configured)
    .map((service) => `${serviceLabels[service.id] ?? service.id} is not configured.`);

  return {
    mode: config.kfiveMode,
    apiVersion: config.apiVersion,
    provider: {
      id: config.aiProvider,
      configured: true,
      location: providerLocation(config),
      liveSwitchSupported: false,
      restartRequired: true,
    },
    services,
    missingDependencies,
    restartRequiredFields: [
      'KFIVE_MODE',
      'AI_PROVIDER',
      'OLLAMA_BASE_URL',
      'OPENAI_BASE_URL',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'CUSTOM_LLM_BASE_URL',
      'CUSTOM_LLM_API_KEY',
      'MONGODB_URL',
      'REDIS_URL',
      'CHROMA_URL',
      'CODE_RUNNER_MODE',
      'DOCUMENT_PROCESSOR_URL',
      'OCR_SERVICE_URL',
    ],
    note: 'Runtime configuration is read-only. Change environment configuration and restart KFive to apply these fields.',
  };
}
