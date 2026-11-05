import { ALLOWED_CORS_HEADERS, ALLOWED_CORS_METHODS, corsOriginError, createApp } from './app';
import { parseEnvironment } from './config/environment';
import { logger } from './utils/logger';

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

  it('allows the explicit browser authentication transport and CSRF headers', () => {
    expect(ALLOWED_CORS_HEADERS).toContain('X-KFive-Auth-Transport');
    expect(ALLOWED_CORS_HEADERS).toContain('X-KFive-CSRF');
  });

  it('uses the explicitly bounded proxy-hop contract', () => {
    expect(createApp(config).get('trust proxy')).toBe(config.trustedProxyHops);
    const twoProxyConfig = parseEnvironment({
      NODE_ENV: 'production', KFIVE_MODE: 'remote', AI_PROVIDER: 'openai-compatible',
      AI_DEFAULT_MODEL: 'remote-chat', OPENAI_BASE_URL: 'https://provider.example.com/v1',
      MONGODB_URL: 'mongodb://localhost:27017/kfive_test', REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: '01234567890123456789012345678901',
      JWT_REFRESH_SECRET: 'abcdefghijklmnopqrstuvwxyz123456',
      TRUST_PROXY_HOPS: '2', CORS_ORIGIN: 'https://kfive.example.com',
      PUBLIC_BASE_URL: 'https://kfive.example.com',
    });
    expect(createApp(twoProxyConfig).get('trust proxy')).toBe(2);
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

describe('application health endpoints', () => {
  it('never rate limits Kubernetes readiness probes', async () => {
    const previousMax = process.env.RATE_LIMIT_MAX_REQUESTS;
    const previousWindow = process.env.RATE_LIMIT_WINDOW_MS;
    process.env.RATE_LIMIT_MAX_REQUESTS = '1';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    const server = createApp(config).listen(0);

    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind to TCP.');
      const url = `http://127.0.0.1:${address.port}/api/v1/readiness`;
      const first = await fetch(url);
      const second = await fetch(url);
      expect(first.status).toBe(503);
      expect(second.status).toBe(503);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (previousMax === undefined) delete process.env.RATE_LIMIT_MAX_REQUESTS;
      else process.env.RATE_LIMIT_MAX_REQUESTS = previousMax;
      if (previousWindow === undefined) delete process.env.RATE_LIMIT_WINDOW_MS;
      else process.env.RATE_LIMIT_WINDOW_MS = previousWindow;
    }
  });

  it('exports bounded Prometheus HTTP and process metrics without request data', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const server = createApp(config).listen(0);
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind to TCP.');
      const origin = `http://127.0.0.1:${address.port}`;
      await fetch(`${origin}/api/v1/health?secret=must-not-appear`, {
        headers: { authorization: 'Bearer must-not-appear' },
      });
      await fetch(`${origin}/missing?secret=must-not-appear`);
      await fetch(`${origin}/missing/must-not-appear-in-path`);
      await Promise.all(Array.from({ length: 300 }, (_, index) => fetch(`${origin}/random-metric-path-${index}`)));
      const response = await fetch(`${origin}/metrics`);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/^text\/plain;.*version=0\.0\.4/);
      expect(body).toContain('kfive_http_requests_total{method="GET",path="/api/v1/health",status_code="200"} 1');
      expect(body).toMatch(/kfive_http_request_duration_seconds_count\{method="GET",path="\/api\/v1\/health"\} 1/);
      expect(body).toMatch(/process_resident_memory_bytes \d+/);
      expect(body).toContain('path="/not-found"');
      expect((body.match(/^kfive_http_requests_total\{/gm) || []).length).toBeLessThanOrEqual(250);
      expect((body.match(/^kfive_http_request_duration_seconds_count\{/gm) || []).length).toBeLessThanOrEqual(250);
      expect(body).not.toContain('must-not-appear');
      expect(JSON.stringify(info.mock.calls)).not.toContain('must-not-appear');
      expect(JSON.stringify(error.mock.calls)).not.toContain('must-not-appear');
    } finally {
      info.mockRestore();
      error.mockRestore();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
