import { EventEmitter } from 'events';
import { Router } from 'express';
import { WorkflowService } from '@/services/workflowService';
import { WorkflowRunError, WorkflowRunService } from '@/services/workflowRunService';
import { createWorkflowsRouter } from './workflows';

const ownerId = '64b000000000000000000001';
const workflowId = '64b000000000000000000201';
const runId = '64b000000000000000000301';
const workflow = { id: workflowId, name: 'Summary', revision: 1 };
const run = {
  id: runId, workflowId, status: 'succeeded', workflow: {
    name: 'Summary', revision: 1, requestedModel: 'phi3', temperature: 0,
  }, outputBytes: 2, outputTruncated: false, queuedAt: new Date(),
};

function services() {
  const workflows = {
    list: jest.fn().mockResolvedValue([workflow]), create: jest.fn().mockResolvedValue(workflow),
    get: jest.fn().mockResolvedValue(workflow), update: jest.fn().mockResolvedValue(workflow),
    delete: jest.fn().mockResolvedValue({ workflowId, deleted: true }),
  } as unknown as WorkflowService;
  const runs = {
    list: jest.fn().mockResolvedValue({ runs: [run], pagination: { page: 1, pageSize: 50, total: 1, totalPages: 1 } }),
    get: jest.fn().mockResolvedValue(run), cancel: jest.fn().mockResolvedValue({ run, idempotent: false }),
    delete: jest.fn().mockResolvedValue({ runId, deleted: true }),
    prepare: jest.fn().mockResolvedValue({ ownerId, workflow: { _id: workflowId }, input: 'notes', renderedPrompt: 'notes' }),
    execute: jest.fn().mockImplementation(async (_prepared, emit) => {
      emit({ type: 'run', run: { ...run, status: 'queued' } });
      emit({ type: 'start', runId, provider: 'ollama', model: 'phi3' });
      emit({ type: 'delta', runId, content: 'ok' });
      emit({ type: 'usage', runId, usage: { totalTokens: 2 } });
      emit({ type: 'completed', run });
      return run;
    }),
  } as unknown as WorkflowRunService;
  return { workflows, runs };
}

function handler(router: Router, method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  const layer = (router as any).stack.find((item: any) => item.route?.path === path && item.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function invokeJson(
  router: Router,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  values: { body?: unknown; query?: unknown; params?: unknown } = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    handler(router, method, path)({
      body: values.body ?? {}, query: values.query ?? {}, params: values.params ?? {},
      user: { userId: ownerId, email: 'owner@example.test', role: 'user' },
    }, {
      status(code: number) { status = code; return this; },
      json(body: unknown) { resolve({ status, body }); return this; },
    }, reject);
  });
}

function invokeSse(router: Router): Promise<{ status: number; headers: Map<string, string>; body: string }> {
  const response = new EventEmitter() as any;
  const headers = new Map<string, string>();
  let status = 200;
  let body = '';
  response.writableEnded = false; response.destroyed = false;
  response.status = (code: number) => { status = code; return response; };
  response.setHeader = (name: string, value: string) => { headers.set(name.toLowerCase(), value); return response; };
  response.flushHeaders = jest.fn(); response.flush = jest.fn();
  response.write = (chunk: string) => { body += chunk; return true; };
  return new Promise((resolve, reject) => {
    response.end = () => { response.writableEnded = true; resolve({ status, headers, body }); return response; };
    handler(router, 'post', '/:id/runs')({
      body: { input: 'notes' }, params: { id: workflowId }, query: {},
      user: { userId: ownerId, email: 'owner@example.test', role: 'user' },
    }, response, reject);
  });
}

describe('workflow routes', () => {
  it('forwards owner-scoped CRUD and project filtering', async () => {
    const { workflows, runs } = services();
    const router = createWorkflowsRouter(workflows, runs);
    await expect(invokeJson(router, 'get', '/', { query: { projectId: 'project' } }))
      .resolves.toMatchObject({ status: 200, body: { data: { count: 1 } } });
    await expect(invokeJson(router, 'post', '/', { body: { name: 'Summary' } })).resolves.toMatchObject({ status: 201 });
    await invokeJson(router, 'get', '/:id', { params: { id: workflowId } });
    await invokeJson(router, 'patch', '/:id', { params: { id: workflowId }, body: { name: 'New' } });
    await invokeJson(router, 'delete', '/:id', { params: { id: workflowId } });
    expect(workflows.list).toHaveBeenCalledWith(ownerId, 'project');
    expect(workflows.create).toHaveBeenCalledWith(ownerId, { name: 'Summary' });
    expect(workflows.get).toHaveBeenCalledWith(ownerId, workflowId);
    expect(workflows.update).toHaveBeenCalledWith(ownerId, workflowId, { name: 'New' });
    expect(workflows.delete).toHaveBeenCalledWith(ownerId, workflowId);
  });

  it('forwards owner-scoped history, detail, cancellation and terminal deletion', async () => {
    const { workflows, runs } = services();
    const router = createWorkflowsRouter(workflows, runs);
    const params = { id: workflowId, runId };
    await invokeJson(router, 'get', '/:id/runs', { params, query: { page: '2' } });
    await invokeJson(router, 'get', '/:id/runs/:runId', { params });
    await invokeJson(router, 'post', '/:id/runs/:runId/cancel', { params });
    await invokeJson(router, 'delete', '/:id/runs/:runId', { params });
    expect(runs.list).toHaveBeenCalledWith(ownerId, workflowId, '2');
    expect(runs.get).toHaveBeenCalledWith(ownerId, workflowId, runId);
    expect(runs.cancel).toHaveBeenCalledWith(ownerId, workflowId, runId);
    expect(runs.delete).toHaveBeenCalledWith(ownerId, workflowId, runId);
  });

  it('streams the exact named events and terminal marker', async () => {
    const { workflows, runs } = services();
    const result = await invokeSse(createWorkflowsRouter(workflows, runs));
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('text/event-stream');
    expect(result.body).toContain('event: run');
    expect(result.body).toContain(`event: start\ndata: {"runId":"${runId}","provider":"ollama","model":"phi3"}`);
    expect(result.body).toContain(`event: delta\ndata: {"runId":"${runId}","content":"ok"}`);
    expect(result.body).toContain('event: usage');
    expect(result.body).toContain('event: completed');
    expect(result.body).toContain('data: [DONE]');
    expect(runs.prepare).toHaveBeenCalledWith(ownerId, workflowId, { input: 'notes' });
  });

  it('never streams raw unexpected errors and preserves fixed operational errors', async () => {
    const first = services();
    (first.runs.execute as jest.Mock).mockRejectedValue(new Error('secret provider URL'));
    const unexpected = await invokeSse(createWorkflowsRouter(first.workflows, first.runs));
    expect(unexpected.body).toContain('WORKFLOW_EXECUTION_FAILED');
    expect(unexpected.body).not.toContain('secret provider');

    const second = services();
    (second.runs.execute as jest.Mock).mockRejectedValue(
      new WorkflowRunError('The configured AI provider is unavailable.', 'WORKFLOW_PROVIDER_UNAVAILABLE', 503)
    );
    const operational = await invokeSse(createWorkflowsRouter(second.workflows, second.runs));
    expect(operational.body).toContain('WORKFLOW_PROVIDER_UNAVAILABLE');
    expect(operational.body).toContain('The configured AI provider is unavailable.');
  });
});
