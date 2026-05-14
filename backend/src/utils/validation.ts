import { logger } from './logger';

interface RequiredEnvVars {
  [key: string]: string | undefined;
}

export function validateEnvironment(): void {
  const requiredVars: RequiredEnvVars = {
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT,
    MONGODB_URI: process.env.MONGODB_URI,
    REDIS_URL: process.env.REDIS_URL,
    JWT_SECRET: process.env.JWT_SECRET,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
  };

  const missingVars: string[] = [];

  for (const [key, value] of Object.entries(requiredVars)) {
    if (!value) {
      missingVars.push(key);
    }
  }

  if (missingVars.length > 0) {
    logger.error(`Missing required environment variables: ${missingVars.join(', ')}`);
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }

  // Validate JWT secrets are not default values
  if (process.env.JWT_SECRET === 'your-super-secret-jwt-key-change-in-production') {
    logger.warn('JWT_SECRET is using default value. Please change it in production!');
  }

  if (process.env.JWT_REFRESH_SECRET === 'your-super-secret-refresh-key-change-in-production') {
    logger.warn('JWT_REFRESH_SECRET is using default value. Please change it in production!');
  }

  logger.info('✅ Environment validation passed');
}