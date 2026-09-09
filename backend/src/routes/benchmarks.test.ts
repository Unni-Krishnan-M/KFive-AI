import { EventEmitter } from 'events';
import { Express, Router } from 'express';
import { BenchmarkRunError, BenchmarkService } from '@/services/benchmarkService';
import { authenticateToken } from '@/middleware/auth';
import { parseEnvironment } from '@/config/environment';
import { createBenchmarksRouter } from './benchmarks';
import { setupRoutes } from './index';

const ownerId = '64b000000000000000000001';
const runId = '64b000000000000000000201';
const terminalRun = {
  id: runId,
  revision: 15,
  status: 'succeeded',
  suite: { id: 'chat-core-v1', version: 1, promptCount: 3, repetitions: 2, totalCalls: 6 },
  provider: 'ollama',
  model: { requested: { id: 'phi3' }, actual: { id: 'phi3' } },
  completedCalls: 6,
  passedCalls: 6,
  outputBytes: 12,
  queuedAt: new Date(),
};

function mockService(): BenchmarkService {
  return {
    status: jest.fn().mockResolvedValue({
      execution: { scope: 'shared-benchmark-worker', globalLimit: 1, ownerLimit: 1, active: false, queueDurable: true, workerAvailable: true },
      limits: {
        retentionPerOwner: 100, pageSize: 25, maxPages: 10, runTimeoutMs: 180000,
        outputBytesPerCall: 16384, outputBytesPerRun: 131072,
      },
      warnings: { multiReplicaCoordination: true, remoteProviderBillingAndPrivacy: true },
      scope: { type: 'workspace' },
    }),
    suites: jest.fn().mockReturnValue([{
      id: 'chat-core-v1', title: 'Chat Core', version: 1, promptCount: 3, repetitions: 2, totalCalls: 6,
      parameters: { maxOutputTokens: 128, temperature: 0, topP: 1 },
    }]),
    list: jest.fn().mockResolvedValue({
      runs: [terminalRun], pagination: { page: 2, pageSize: 25, total: 26, totalPages: 2, maxPages: 10 },
    }),
    get: jest.fn().mockResolvedValue(terminalRun),
    cancel: jest.fn().mockResolvedValue({ run: terminalRun, idempotent: false }),
    delete: jest.fn().mockResolvedValue({ runId, deleted: true }),
    prepare: jest.fn().mockResolvedValue({ ownerId, providerId: 'ollama', requestedModel: { id: 'phi3' } }),
    start: jest.fn().mockResolvedValue({ ...terminalRun, status: 'queued', revision: 1 }),
    follow: jest.fn().mockImplementation(async (_owner, _runId, emit) => {
      emit({ type: 'run', revision: 1, run: { ...terminalRun, status: 'queued', revision: 1 } });
      emit({ type: 'call-start', revision: 3, runId, callIndex: 0, promptIndex: 0, repetition: 1 });
      emit({
        type: 'call-completed', revision: 4, runId,
        result: {
          callIndex: 0, promptIndex: 0, repetition: 1, promptLength: 10, passed: true,
          output: '<script>inert()</script>', outputBytes: 24, durationMs: 10, ttftMs: 2,
          provider: 'ollama', model: 'phi3', finishReason: 'stop',
        },
      });
      emit({ type: 'completed', revision: 15, run: terminalRun });
      return terminalRun;
    }),
  } as unknown as BenchmarkService;
}

function routeHandler(router: Router, method: 'get' | 'post' | 'delete', path: string) {
  const layer = (router as any).stack.find((item: any) => item.route?.path === path && item.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function invokeJson(
  router: Router,
  method: 'get' | 'post' | 'delete',
  path: string,
  values: Record<string, any> = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const req = {
      body: values.body ?? {}, query: values.query ?? {}, params: values.params ?? {},
      user: { userId: ownerId, email: 'owner@example.test', role: 'user' },
    };
    const res = {
      status(code: number) { statusCode = code; return this; },
      json(body: unknown) { resolve({ status: statusCode, body }); return this; },
    };
    routeHandler(router, method, path)(req, res, reject);
  });
}

function invokeSse(router: Router): Promise<{ status: number; headers: Map<string, string>; body: string }> {
  const response = new EventEmitter() as any;
  const headers = new Map<string, string>();
  let statusCode = 200;
  let body = '';
  response.writableEnded = false;
  response.destroyed = false;
  response.status = (code: number) => { statusCode = code; return response; };
  response.setHeader = (name: string, value: string) => { headers.set(name.toLowerCase(), value); return response; };
  response.flushHeaders = jest.fn();
  response.flush = jest.fn();
  response.write = (chunk: string) => { body += chunk; return true; };
  return new Promise((resolve, reject) => {
    response.end = () => { response.writableEnded = true; resolve({ status: statusCode, headers, body }); return response; };
    routeHandler(router, 'post', '/runs/stream')({
      body: { model: 'phi3', suiteId: 'chat-core-v1' }, params: {}, query: {}, get: () => undefined,
      user: { userId: ownerId, email: 'owner@example.test', role: 'user' },
    }, response, reject);
  });
}

describe('benchmark routes', () => {
  it('mounts the benchmark API behind bearer authentication', () => {
    const get = jest.fn();
    const use = jest.fn();
    setupRoutes({ get, use } as unknown as Express, parseEnvironment(process.env));
    expect(use).toHaveBeenCalledWith('/api/v1/benchmarks', authenticateToken, expect.any(Function));
  });

  it('returns fixed status and suite discovery shapes', async () => {
    const service = mockService();
    const router = createBenchmarksRouter(service);
    await expect(invokeJson(router, 'get', '/status')).resolves.toMatchObject({
      status: 200,
      body: { success: true, data: { execution: { scope: 'shared-benchmark-worker', globalLimit: 1, queueDurable: true, workerAvailable: true } } },
    });
    expect(service.status).toHaveBeenCalledWith(ownerId, undefined);
    await expect(invokeJson(router, 'get', '/suites')).resolves.toMatchObject({
      body: { data: { suites: [{ id: 'chat-core-v1', totalCalls: 6, parameters: { maxOutputTokens: 128 } }] } },
    });
  });

  it('forwards owner/project pagination, detail, cancellation, and terminal deletion', async () => {
    const service = mockService();
    const router = createBenchmarksRouter(service);
    await expect(invokeJson(router, 'get', '/runs', { query: { page: '2', projectId: '64b000000000000000000101' } }))
      .resolves.toMatchObject({ body: { success: true, data: { pagination: { page: 2, pageSize: 25, maxPages: 10 } } } });
    await expect(invokeJson(router, 'get', '/runs/:runId', { params: { runId } }))
      .resolves.toMatchObject({ body: { success: true, data: { run: terminalRun } } });
    await expect(invokeJson(router, 'post', '/runs/:runId/cancel', { params: { runId } }))
      .resolves.toMatchObject({ body: { success: true, data: { idempotent: false } } });
    await expect(invokeJson(router, 'delete', '/runs/:runId', { params: { runId } }))
      .resolves.toEqual({ status: 200, body: { success: true, data: { runId, deleted: true } } });
    expect(service.list).toHaveBeenCalledWith(ownerId, '2', '64b000000000000000000101');
    expect(service.get).toHaveBeenCalledWith(ownerId, runId);
    expect(service.cancel).toHaveBeenCalledWith(ownerId, runId);
    expect(service.delete).toHaveBeenCalledWith(ownerId, runId);
  });

  it('streams named progress events, JSON-encodes inert output, and terminates persistently', async () => {
    const service = mockService();
    const response = await invokeSse(createBenchmarksRouter(service));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.body).toContain('event: run');
    expect(response.body).toContain('id: 1');
    expect(response.body).toContain('event: call-start');
    expect(response.body).toContain('event: call-completed');
    expect(response.body).toContain('\\u003cscript');
    expect(response.body).toContain('event: completed');
    expect(response.body).toContain('data: [DONE]');
    expect(service.prepare).toHaveBeenCalledWith(ownerId, { model: 'phi3', suiteId: 'chat-core-v1' });
  });

  it('never emits an unexpected raw provider error', async () => {
    const service = mockService();
    (service.follow as jest.Mock).mockRejectedValue(new Error('secret remote URL and billing token'));
    const response = await invokeSse(createBenchmarksRouter(service));
    expect(response.body).toContain('BENCHMARK_EXECUTION_FAILED');
    expect(response.body).not.toContain('secret remote');
  });

  it('emits only fixed operational benchmark errors', async () => {
    const service = mockService();
    (service.follow as jest.Mock).mockRejectedValue(
      new BenchmarkRunError('The benchmark run timed out.', 'BENCHMARK_TIMEOUT', 408)
    );
    const response = await invokeSse(createBenchmarksRouter(service));
    expect(response.body).toContain('BENCHMARK_TIMEOUT');
    expect(response.body).toContain('The benchmark run timed out.');
  });
});
