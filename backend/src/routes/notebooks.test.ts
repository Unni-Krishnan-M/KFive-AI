import { Express, Router } from 'express';
import { parseEnvironment } from '@/config/environment';
import { authenticateToken } from '@/middleware/auth';
import { NotebookService } from '@/services/notebookService';
import { NotebookRunService } from '@/services/notebookRunService';
import { setupRoutes } from './index';
import { createNotebooksRouter } from './notebooks';

const ownerId = '64b000000000000000000001';
const notebookId = '64b000000000000000000201';
const notebook = { id: notebookId, title: 'Analysis', cells: [{ id: 'one', type: 'code', source: '1 + 1', tags: [] }],
  cellTimeoutSeconds: 10, revision: 1 };

function service(): NotebookService {
  return {
    status: jest.fn().mockReturnValue({ editing: { available: true }, execution: { available: false } }),
    list: jest.fn().mockResolvedValue({ notebooks: [notebook], pagination: { page: 1 } }),
    create: jest.fn().mockResolvedValue(notebook), get: jest.fn().mockResolvedValue(notebook),
    update: jest.fn().mockResolvedValue({ ...notebook, revision: 2 }),
    delete: jest.fn().mockResolvedValue({ notebookId, deleted: true }),
  } as unknown as NotebookService;
}
function runService(): NotebookRunService {
  const run = { id: '64b000000000000000000301', notebookId, notebookRevision: 1, snapshotSha256: 'a'.repeat(64),
    status: 'queued', revision: 1, metrics: [], artifacts: [], timeline: [], queuedAt: new Date() };
  return {
    status: jest.fn().mockResolvedValue({ editing: { available: true, persistent: true },
      execution: { enabled: false, available: false } }),
    list: jest.fn().mockResolvedValue({ runs: [run], pagination: { page: 1 } }),
    start: jest.fn().mockResolvedValue(run), get: jest.fn().mockResolvedValue(run),
    cancel: jest.fn().mockResolvedValue({ run: { ...run, status: 'cancelled' }, idempotent: false }),
    delete: jest.fn().mockResolvedValue({ runId: run.id, deleted: true }),
  } as unknown as NotebookRunService;
}

function handler(router: Router, method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === path && entry.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function invoke(router: Router, method: 'get' | 'post' | 'patch' | 'delete', path: string, values: any = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    let status = 200;
    handler(router, method, path)({ body: values.body ?? {}, query: values.query ?? {}, params: values.params ?? {},
      user: { userId: ownerId, email: 'owner@example.test', role: 'user' } }, {
      status(code: number) { status = code; return this; },
      json(body: unknown) { resolve({ status, body }); return this; },
    }, reject);
  });
}

describe('notebook routes', () => {
  it('mounts notebooks behind authentication', () => {
    const use = jest.fn(); setupRoutes({ get: jest.fn(), use } as unknown as Express, parseEnvironment(process.env));
    expect(use).toHaveBeenCalledWith('/api/v1/notebooks', authenticateToken, expect.any(Function));
  });

  it('returns exact authenticated editing envelopes without fake execution', async () => {
    const api = service(); const runs = runService(); const router = createNotebooksRouter(api, runs);
    const body = { title: 'Analysis', cells: notebook.cells };
    await expect(invoke(router, 'get', '/status')).resolves.toMatchObject({ body: { success: true,
      data: { editing: { available: true }, execution: { available: false } } } });
    await expect(invoke(router, 'get', '/', { query: { page: '1' } })).resolves.toMatchObject({ body: { success: true,
      data: { notebooks: [notebook] } } });
    await expect(invoke(router, 'post', '/', { body })).resolves.toMatchObject({ status: 201, body: { data: { notebook } } });
    await expect(invoke(router, 'get', '/:id', { params: { id: notebookId } })).resolves.toMatchObject({ body: { data: { notebook } } });
    await expect(invoke(router, 'patch', '/:id', { params: { id: notebookId }, body: { ...body, expectedRevision: 1 } }))
      .resolves.toMatchObject({ body: { data: { notebook: { revision: 2 } } } });
    await expect(invoke(router, 'delete', '/:id', { params: { id: notebookId }, body: { expectedRevision: 1 } }))
      .resolves.toEqual({ status: 200, body: { success: true, data: { notebookId, deleted: true } } });
    expect(api.create).toHaveBeenCalledWith(ownerId, body);
    expect(api.delete).toHaveBeenCalledWith(ownerId, notebookId, { expectedRevision: 1 });
  });

  it('exposes owner-scoped durable run lifecycle routes', async () => {
    const runs = runService(); const router = createNotebooksRouter(service(), runs);
    const currentRunId = '64b000000000000000000301';
    await expect(invoke(router, 'get', '/:id/runs', { params: { id: notebookId }, query: { page: '1' } }))
      .resolves.toMatchObject({ body: { data: { runs: [expect.objectContaining({ id: currentRunId })] } } });
    await expect(invoke(router, 'post', '/:id/runs', { params: { id: notebookId }, body: { expectedRevision: 1 } }))
      .resolves.toMatchObject({ status: 202, body: { data: { run: { id: currentRunId } } } });
    await expect(invoke(router, 'get', '/:id/runs/:runId', { params: { id: notebookId, runId: currentRunId } }))
      .resolves.toMatchObject({ body: { data: { run: { id: currentRunId } } } });
    await expect(invoke(router, 'post', '/:id/runs/:runId/cancel', { params: { id: notebookId, runId: currentRunId } }))
      .resolves.toMatchObject({ body: { data: { run: { status: 'cancelled' } } } });
    await expect(invoke(router, 'delete', '/:id/runs/:runId', { params: { id: notebookId, runId: currentRunId } }))
      .resolves.toMatchObject({ body: { data: { runId: currentRunId, deleted: true } } });
    expect(runs.start).toHaveBeenCalledWith(ownerId, notebookId, { expectedRevision: 1 });
  });
});
