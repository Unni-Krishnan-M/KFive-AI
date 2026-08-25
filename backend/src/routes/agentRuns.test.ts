import { EventEmitter } from 'events';
import { Router } from 'express';
import { AgentRunError, AgentRunService } from '@/services/agentRunService';
import { AgentService } from '@/services/agentService';
import { createAgentRouter } from './agent';

const ownerId = '64b000000000000000000001';
const agentId = '64b000000000000000000201';
const runId = '64b000000000000000000301';
const run = {
  id: runId, agentId, status: 'succeeded', agent: {
    name: 'Reviewer', requestedModel: 'phi3', temperature: 0, tools: [],
  }, outputBytes: 2, outputTruncated: false, queuedAt: new Date(),
};

function services() {
  const agents = {
    list: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({ id: agentId }),
    get: jest.fn().mockResolvedValue({ id: agentId }), update: jest.fn().mockResolvedValue({ id: agentId }),
    delete: jest.fn().mockResolvedValue({ agentId, deleted: true }),
  } as unknown as AgentService;
  const runs = {
    list: jest.fn().mockResolvedValue({ runs: [run], pagination: { page: 1, pageSize: 50, total: 1, totalPages: 1 } }),
    get: jest.fn().mockResolvedValue(run), cancel: jest.fn().mockResolvedValue({ run, idempotent: false }),
    delete: jest.fn().mockResolvedValue({ runId, deleted: true }),
    prepare: jest.fn().mockResolvedValue({ ownerId, agent: { _id: agentId }, prompt: 'Review' }),
    execute: jest.fn().mockImplementation(async (_prepared, emit) => {
      emit({ type: 'run', run: { ...run, status: 'queued' } });
      emit({ type: 'start', runId, provider: 'ollama', model: 'phi3' });
      emit({ type: 'delta', runId, content: 'ok' });
      emit({ type: 'completed', run });
      return run;
    }),
  } as unknown as AgentRunService;
  return { agents, runs };
}

function routeHandler(router: Router, method: 'get' | 'post' | 'delete', path: string) {
  const layer = (router as any).stack.find((item: any) => item.route?.path === path && item.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function invokeJson(router: Router, method: 'get' | 'post' | 'delete', path: string, values: Record<string, unknown> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
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
  response.writableEnded = false; response.destroyed = false;
  response.status = (code: number) => { statusCode = code; return response; };
  response.setHeader = (name: string, value: string) => { headers.set(name.toLowerCase(), value); return response; };
  response.flushHeaders = jest.fn(); response.flush = jest.fn();
  response.write = (chunk: string) => { body += chunk; return true; };
  return new Promise((resolve, reject) => {
    response.end = () => { response.writableEnded = true; resolve({ status: statusCode, headers, body }); return response; };
    routeHandler(router, 'post', '/:id/runs')({
      body: { prompt: 'Review' }, params: { id: agentId }, query: {},
      user: { userId: ownerId, email: 'owner@example.test', role: 'user' },
    }, response, reject);
  });
}

describe('agent run routes', () => {
  it('forwards owner-scoped pagination, detail, cancellation and terminal deletion', async () => {
    const { agents, runs } = services();
    const router = createAgentRouter(agents, runs);
    await expect(invokeJson(router, 'get', '/:id/runs', { params: { id: agentId }, query: { page: '2' } }))
      .resolves.toMatchObject({ status: 200, body: { success: true, data: { pagination: { page: 1 } } } });
    await expect(invokeJson(router, 'get', '/:id/runs/:runId', { params: { id: agentId, runId } }))
      .resolves.toMatchObject({ status: 200, body: { success: true, data: { run } } });
    await expect(invokeJson(router, 'post', '/:id/runs/:runId/cancel', { params: { id: agentId, runId } }))
      .resolves.toMatchObject({ status: 200, body: { success: true } });
    await expect(invokeJson(router, 'delete', '/:id/runs/:runId', { params: { id: agentId, runId } }))
      .resolves.toEqual({ status: 200, body: { success: true, data: { runId, deleted: true } } });
    expect(runs.list).toHaveBeenCalledWith(ownerId, agentId, '2');
    expect(runs.get).toHaveBeenCalledWith(ownerId, agentId, runId);
    expect(runs.cancel).toHaveBeenCalledWith(ownerId, agentId, runId);
    expect(runs.delete).toHaveBeenCalledWith(ownerId, agentId, runId);
  });

  it('streams named bounded events and a terminal marker', async () => {
    const { agents, runs } = services();
    const response = await invokeSse(createAgentRouter(agents, runs));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.body).toContain(`event: run\ndata: {"run"`);
    expect(response.body).toContain(`event: delta\ndata: {"runId":"${runId}","content":"ok"}`);
    expect(response.body).toContain('event: completed');
    expect(response.body).toContain('data: [DONE]');
    expect(runs.prepare).toHaveBeenCalledWith(ownerId, agentId, { prompt: 'Review' });
  });

  it('never emits an unexpected raw execution error', async () => {
    const { agents, runs } = services();
    (runs.execute as jest.Mock).mockRejectedValue(new Error('secret provider URL and token'));
    const response = await invokeSse(createAgentRouter(agents, runs));
    expect(response.body).toContain('AGENT_EXECUTION_FAILED');
    expect(response.body).not.toContain('secret provider');
  });

  it('emits only the fixed operational AgentRun error', async () => {
    const { agents, runs } = services();
    (runs.execute as jest.Mock).mockRejectedValue(new AgentRunError('The configured AI provider is unavailable.', 'AGENT_PROVIDER_UNAVAILABLE', 503));
    const response = await invokeSse(createAgentRouter(agents, runs));
    expect(response.body).toContain('AGENT_PROVIDER_UNAVAILABLE');
    expect(response.body).toContain('The configured AI provider is unavailable.');
  });
});
