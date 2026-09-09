import { parseEnvironment } from './environment';

const baseEnvironment = {
  NODE_ENV: 'test',
  KFIVE_MODE: 'local',
  AI_PROVIDER: 'ollama',
  MONGODB_URL: 'mongodb://localhost:27017/kfive_test',
  REDIS_URL: 'redis://localhost:6379',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  JWT_SECRET: '01234567890123456789012345678901',
  JWT_REFRESH_SECRET: 'abcdefghijklmnopqrstuvwxyz123456',
};

describe('parseEnvironment', () => {
  it('parses local Ollama configuration', () => {
    const config = parseEnvironment(baseEnvironment);
    expect(config.kfiveMode).toBe('local');
    expect(config.processKind).toBe('api');
    expect(config.aiProvider).toBe('ollama');
    expect(config.mongodbUrl).toBe(baseEnvironment.MONGODB_URL);
    expect(config.aiDefaultModel).toBe('phi3');
    expect(config.aiEmbeddingModel).toBeUndefined();
    expect(config.aiMaxOutputTokens).toBe(2048);
    expect(config.aiTimeoutMs).toBe(30000);
  });

  it('keeps the embedding model separate from the chat model', () => {
    const config = parseEnvironment({
      ...baseEnvironment,
      AI_DEFAULT_MODEL: 'chat-model',
      AI_EMBEDDING_MODEL: 'embedding-model',
    });
    expect(config.aiDefaultModel).toBe('chat-model');
    expect(config.aiEmbeddingModel).toBe('embedding-model');
  });

  it('parses provider-neutral generation limits and model selection', () => {
    const config = parseEnvironment({
      ...baseEnvironment,
      AI_DEFAULT_MODEL: 'qwen3:4b',
      AI_MAX_OUTPUT_TOKENS: '4096',
      AI_TIMEOUT_MS: '45000',
    });
    expect(config.aiDefaultModel).toBe('qwen3:4b');
    expect(config.aiMaxOutputTokens).toBe(4096);
    expect(config.aiTimeoutMs).toBe(45000);
  });

  it('accepts OLLAMA_CHAT_MODEL as a legacy default-model alias', () => {
    const config = parseEnvironment({ ...baseEnvironment, OLLAMA_CHAT_MODEL: 'legacy-model' });
    expect(config.aiDefaultModel).toBe('legacy-model');
  });

  it('rejects unsafe AI resource limits', () => {
    expect(() => parseEnvironment({ ...baseEnvironment, AI_MAX_OUTPUT_TOKENS: '0' })).toThrow(/AI_MAX_OUTPUT_TOKENS/);
    expect(() => parseEnvironment({ ...baseEnvironment, AI_TIMEOUT_MS: '50' })).toThrow(/AI_TIMEOUT_MS/);
  });

  it('rejects credentials embedded in provider URLs', () => {
    expect(() => parseEnvironment({
      ...baseEnvironment,
      OLLAMA_BASE_URL: 'http://user:password@localhost:11434',
    })).toThrow(/must not contain embedded credentials/);
  });

  it('requires the public browser origin to be allowed by CORS', () => {
    expect(() => parseEnvironment({
      ...baseEnvironment,
      PUBLIC_BASE_URL: 'http://localhost:3002/app',
      CORS_ORIGIN: 'http://localhost:3000,http://127.0.0.1:3002',
    })).toThrow(/CORS_ORIGIN must include.*http:\/\/localhost:3002/);

    const config = parseEnvironment({
      ...baseEnvironment,
      PUBLIC_BASE_URL: 'http://localhost:3002/app',
      CORS_ORIGIN: 'http://localhost:3002,http://127.0.0.1:3002',
    });
    expect(config.corsOrigins).toEqual(['http://localhost:3002', 'http://127.0.0.1:3002']);
  });

  it('normalizes root slashes and rejects non-origin CORS entries', () => {
    const config = parseEnvironment({ ...baseEnvironment, CORS_ORIGIN: 'http://localhost:3000/' });
    expect(config.corsOrigins).toEqual(['http://localhost:3000']);
    expect(() => parseEnvironment({ ...baseEnvironment, CORS_ORIGIN: 'http://localhost:3000/app' }))
      .toThrow(/without credentials, paths, queries, or fragments/);
    expect(() => parseEnvironment({ ...baseEnvironment, CORS_ORIGIN: 'http://user:secret@localhost:3000' }))
      .toThrow(/without credentials, paths, queries, or fragments/);
  });

  it('accepts the deprecated MongoDB URI alias during migration', () => {
    const { MONGODB_URL: _removed, ...legacyEnvironment } = baseEnvironment;
    const config = parseEnvironment({ ...legacyEnvironment, MONGODB_URI: baseEnvironment.MONGODB_URL });
    expect(config.mongodbUrl).toBe(baseEnvironment.MONGODB_URL);
  });

  it('requires provider-specific Ollama configuration', () => {
    const { OLLAMA_BASE_URL: _removed, ...invalidEnvironment } = baseEnvironment;
    expect(() => parseEnvironment(invalidEnvironment)).toThrow(/OLLAMA_BASE_URL is required/);
  });

  it('rejects example secrets in production', () => {
    expect(() => parseEnvironment({
      ...baseEnvironment,
      NODE_ENV: 'production',
      JWT_SECRET: 'replace-this-example-secret-123456789',
    })).toThrow(/Production JWT secrets/);
  });

  it('does not require API signing secrets in the portless benchmark worker', () => {
    const { JWT_SECRET: _jwt, JWT_REFRESH_SECRET: _refresh, ...workerEnvironment } = baseEnvironment;
    const config = parseEnvironment({ ...workerEnvironment, NODE_ENV: 'production', KFIVE_PROCESS: 'benchmark-worker' });
    expect(config.processKind).toBe('benchmark-worker');
    expect(config.jwtSecret).toBe('kfive-worker-no-http-authentication-00000001');
    expect(config.jwtRefreshSecret).toBe('kfive-worker-no-refresh-authentication-0001');
  });

  it('requires distinct configured images before notebook execution can be enabled', () => {
    expect(() => parseEnvironment({ ...baseEnvironment, NOTEBOOK_EXECUTION_ENABLED: 'true' }))
      .toThrow(/NOTEBOOK_RUNTIME_IMAGE and NOTEBOOK_VERIFIER_IMAGE/);
    expect(() => parseEnvironment({ ...baseEnvironment, NOTEBOOK_EXECUTION_ENABLED: 'true',
      NOTEBOOK_RUNTIME_IMAGE: 'same:image', NOTEBOOK_VERIFIER_IMAGE: 'same:image' })).toThrow(/must be distinct/);
    const config = parseEnvironment({ ...baseEnvironment, KFIVE_PROCESS: 'notebook-worker',
      NOTEBOOK_EXECUTION_ENABLED: 'true', NOTEBOOK_RUNTIME_IMAGE: 'runtime:test', NOTEBOOK_VERIFIER_IMAGE: 'verifier:test' });
    expect(config).toMatchObject({ processKind: 'notebook-worker', notebookExecutionEnabled: true,
      notebookRuntimeImage: 'runtime:test', notebookVerifierImage: 'verifier:test' });
  });

  it('does not require API signing secrets in the portless notebook worker', () => {
    const { JWT_SECRET: _jwt, JWT_REFRESH_SECRET: _refresh, ...workerEnvironment } = baseEnvironment;
    const config = parseEnvironment({ ...workerEnvironment, NODE_ENV: 'production', KFIVE_PROCESS: 'notebook-worker',
      NOTEBOOK_EXECUTION_ENABLED: 'true', NOTEBOOK_RUNTIME_IMAGE: 'runtime:test', NOTEBOOK_VERIFIER_IMAGE: 'verifier:test' });
    expect(config.jwtSecret).toBe('kfive-worker-no-http-authentication-00000001');
  });
});
