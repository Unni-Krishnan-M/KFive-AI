import { Router } from 'express';
import { parseEnvironment } from '@/config/environment';
import { authenticateToken } from '@/middleware/auth';
import { createRuntimeRouter } from './runtime';

const testConfig = parseEnvironment({
  NODE_ENV: 'test',
  KFIVE_MODE: 'hybrid',
  AI_PROVIDER: 'ollama',
  MONGODB_URL: 'mongodb://mongodb:27017/kfive?authSource=admin',
  REDIS_URL: 'redis://:do-not-return@redis:6379',
  CHROMA_URL: 'https://vectors.example.test',
  OLLAMA_BASE_URL: 'http://host.docker.internal:11434',
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
});

function invokeGet(router: Router, path: string): Promise<{ status: number; body: any }> {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === path && entry.route.methods.get);
  const handler = layer.route.stack[0].handle;
  return new Promise((resolve, reject) => {
    let status = 200;
    const response = {
      status(code: number) { status = code; return this; },
      json(body: any) { resolve({ status, body }); return this; },
    };
    handler({}, response, reject);
  });
}

describe('runtime configuration route', () => {
  it('requires authentication at its mounted boundary', () => {
    expect(() => authenticateToken({ headers: {} } as any, {} as any, jest.fn())).toThrow('Access token required');
  });

  it('returns classifications and restart metadata without exposing secrets or URLs', async () => {
    const { status, body } = await invokeGet(createRuntimeRouter(testConfig), '/');
    const serialized = JSON.stringify(body);

    expect(status).toBe(200);
    expect(body.data.mode).toBe('hybrid');
    expect(body.data.provider).toMatchObject({ id: 'ollama', location: 'local', restartRequired: true });
    expect(body.data.services).toContainEqual(expect.objectContaining({ id: 'chromadb', location: 'remote' }));
    expect(body.data.missingDependencies).toEqual(expect.arrayContaining([
      'Code Runner is not configured.',
      'Document Processor is not configured.',
      'OCR service is not configured.',
    ]));
    expect(body.data.restartRequiredFields).toContain('AI_PROVIDER');
    expect(serialized).not.toContain('do-not-return');
    expect(serialized).not.toContain('vectors.example.test');
    expect(serialized).not.toContain('host.docker.internal');
    expect(serialized).not.toContain(process.env.JWT_SECRET);
  });
});
