import { Router } from 'express';
import { CodeRunService } from '@/services/codeRunService';
import { createCodeRouter } from './code';

const ownerId = '64b000000000000000000001';
const projectId = '64b000000000000000000101';
const runId = '64b000000000000000000401';
const run = { _id: runId, userId: ownerId, language: 'python', source: 'print(1)', stdin: '', status: 'queued' };

function fakeService(overrides: Partial<Record<keyof CodeRunService, jest.Mock>> = {}): CodeRunService {
  return {
    getRuntimeCatalog: jest.fn().mockResolvedValue({ enabled: true, available: true, runtimes: [], limits: {} }),
    create: jest.fn().mockResolvedValue({ run }),
    list: jest.fn().mockResolvedValue([run]),
    get: jest.fn().mockResolvedValue(run),
    cancel: jest.fn().mockResolvedValue({ run: { ...run, status: 'cancelled' }, idempotent: false }),
    ...overrides,
  } as unknown as CodeRunService;
}

function invoke(
  router: Router,
  method: 'get' | 'post',
  path: string,
  values: { body?: any; query?: any; params?: any } = {}
): Promise<{ status: number; body: any }> {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === path && entry.route.methods[method]);
  const handler = layer.route.stack[0].handle;
  return new Promise((resolve, reject) => {
    let status = 200;
    handler({
      body: values.body || {},
      query: values.query || {},
      params: values.params || {},
      user: { userId: ownerId, email: 'owner@example.com', role: 'user' },
    }, {
      status(code: number) { status = code; return this; },
      json(responseBody: any) { resolve({ status, body: responseBody }); return this; },
    }, reject);
  });
}

describe('code routes', () => {
  it('returns server-owned runtime metadata', async () => {
    const service = fakeService();
    const response = await invoke(createCodeRouter(service), 'get', '/runtimes');
    expect(response).toEqual({
      status: 200,
      body: { success: true, data: { enabled: true, available: true, runtimes: [], limits: {} } },
    });
  });

  it('accepts a run as 202 and forwards authenticated owner plus unmodified input', async () => {
    const service = fakeService();
    const input = { language: 'python', source: 'print(1)', projectId };
    const response = await invoke(createCodeRouter(service), 'post', '/runs', { body: input });
    expect(service.create).toHaveBeenCalledWith(ownerId, input);
    expect(response).toEqual({ status: 202, body: { success: true, data: { run } } });
  });

  it('owner-scopes list/get/cancel calls and returns idempotence metadata', async () => {
    const service = fakeService();
    const router = createCodeRouter(service);
    await invoke(router, 'get', '/runs', { query: { projectId } });
    await invoke(router, 'get', '/runs/:id', { params: { id: runId } });
    const cancelled = await invoke(router, 'post', '/runs/:id/cancel', { params: { id: runId } });

    expect(service.list).toHaveBeenCalledWith(ownerId, projectId);
    expect(service.get).toHaveBeenCalledWith(ownerId, runId);
    expect(service.cancel).toHaveBeenCalledWith(ownerId, runId);
    expect(cancelled).toMatchObject({
      status: 200,
      body: { success: true, data: { run: { status: 'cancelled' }, idempotent: false } },
    });
  });
});
