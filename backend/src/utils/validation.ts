import { getEnvironment } from '@/config/environment';
import { logger } from './logger';

export function validateEnvironment(): void {
  const config = getEnvironment();
  logger.info('Environment validation passed', {
    mode: config.kfiveMode,
    provider: config.aiProvider,
    codeRunnerMode: config.codeRunnerMode,
  });
}
