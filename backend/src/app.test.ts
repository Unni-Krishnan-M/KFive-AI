import { ALLOWED_CORS_METHODS, corsOriginError, createApp } from './app';
import { parseEnvironment } from './config/environment';

const config = parseEnvironment({
  NODE_ENV: 'test', KFIVE_MODE: 'local', AI_PROVIDER: 'ollama',
  MONGODB_URL: 'mongodb://localhost:27017/kfive_test', REDIS_URL: 'redis://localhost:6379',
  OLLAMA_BASE_URL: 'http://localhost:11434', JWT_SECRET: '01234567890123456789012345678901',
  JWT_REFRESH_SECRET: 'abcdefghijklmnopqrstuvwxyz123456',
});

describe('application CORS policy', () => {
  it('allows the PATCH method used by project updates', () => {
    expect(ALLOWED_CORS_METHODS).toContain('PATCH');
  });

  it('trusts exactly one supported frontend or ingress proxy hop', () => {
    expect(createApp(config).get('trust proxy')).toBe(1);
  });

  it('classifies a rejected browser origin as an operational forbidden request', () => {
    expect(corsOriginError(undefined, config.corsOrigins)).toBeUndefined();
    expect(corsOriginError('http://localhost:3000', config.corsOrigins)).toBeUndefined();
    expect(corsOriginError('http://127.0.0.1:3002', config.corsOrigins)).toMatchObject({
      statusCode: 403,
      isOperational: true,
      message: 'Origin http://127.0.0.1:3002 is not allowed by CORS',
    });
  });

});
