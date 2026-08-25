import mongoose from 'mongoose';
import { EnvironmentConfig } from './environment';
import { isRedisReady } from './redis';

export function getLiveness(config: EnvironmentConfig) {
  return {
    status: 'healthy' as const,
    mode: config.kfiveMode,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  };
}

export function getReadiness(config: EnvironmentConfig) {
  const dependencies = {
    mongodb: mongoose.connection.readyState === 1 ? 'available' : 'unavailable',
    redis: isRedisReady() ? 'available' : 'unavailable',
    aiProvider: { name: config.aiProvider, status: 'not-checked' },
    chromadb: config.chromaUrl ? 'not-checked' : 'not-configured',
    codeRunner: config.codeRunnerMode === 'container' ? 'not-checked' : 'not-configured',
    documentProcessor: config.documentProcessorUrl ? 'not-checked' : 'not-configured',
    ocr: config.ocrServiceUrl ? 'not-checked' : 'not-configured',
  };
  const ready = dependencies.mongodb === 'available' && dependencies.redis === 'available';
  return {
    statusCode: ready ? 200 : 503,
    body: {
      status: ready ? 'ready' : 'not-ready',
      mode: config.kfiveMode,
      dependencies,
      timestamp: new Date().toISOString(),
    },
  };
}
