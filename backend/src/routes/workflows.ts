import { Response, Router } from 'express';
import { getAuthenticatedUserId } from '@/middleware/auth';
import { asyncHandler } from '@/middleware/errorHandler';
import { aiLimiter } from '@/middleware/rateLimiter';
import { WorkflowService, workflowService } from '@/services/workflowService';
import { WorkflowRunError, WorkflowRunService, WorkflowRunStreamEvent, workflowRunService } from '@/services/workflowRunService';

function writeSse(res: Response, event: string, value: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  res.flush?.();
}

export function createWorkflowsRouter(
  service: WorkflowService = workflowService,
  runs: WorkflowRunService = workflowRunService
): Router {
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const workflows = await service.list(getAuthenticatedUserId(req), req.query.projectId);
    res.json({ success: true, data: { workflows, count: workflows.length } });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const workflow = await service.create(getAuthenticatedUserId(req), req.body);
    res.status(201).json({ success: true, data: { workflow } });
  }));

  router.get('/:id/runs', asyncHandler(async (req, res) => {
    const records = await runs.list(getAuthenticatedUserId(req), req.params.id, req.query.page);
    res.json({ success: true, data: records });
  }));

  router.get('/:id/runs/:runId', asyncHandler(async (req, res) => {
    const run = await runs.get(getAuthenticatedUserId(req), req.params.id, req.params.runId);
    res.json({ success: true, data: { run } });
  }));

  router.post('/:id/runs/:runId/cancel', asyncHandler(async (req, res) => {
    const result = await runs.cancel(getAuthenticatedUserId(req), req.params.id, req.params.runId);
    res.json({ success: true, data: result });
  }));

  router.delete('/:id/runs/:runId', asyncHandler(async (req, res) => {
    const result = await runs.delete(getAuthenticatedUserId(req), req.params.id, req.params.runId);
    res.json({ success: true, data: result });
  }));

  router.post('/:id/runs', aiLimiter, asyncHandler(async (req, res) => {
    const prepared = await runs.prepare(getAuthenticatedUserId(req), req.params.id, req.body);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const connection = new AbortController();
    res.once('close', () => { if (!res.writableEnded) connection.abort(); });
    const emit = (event: WorkflowRunStreamEvent): void => {
      if (event.type === 'run') writeSse(res, 'run', { run: event.run });
      else if (event.type === 'start') writeSse(res, 'start', { runId: event.runId, provider: event.provider, model: event.model });
      else if (event.type === 'delta') writeSse(res, 'delta', { runId: event.runId, content: event.content });
      else if (event.type === 'usage') writeSse(res, 'usage', { runId: event.runId, usage: event.usage });
      else writeSse(res, 'completed', { run: event.run });
    };
    try {
      await runs.execute(prepared, emit, connection.signal);
      if (!res.writableEnded && !res.destroyed) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } catch (error) {
      if (!res.writableEnded && !res.destroyed) {
        const safe = error instanceof WorkflowRunError
          ? { code: error.code, message: error.message }
          : { code: 'WORKFLOW_EXECUTION_FAILED', message: 'The workflow run failed.' };
        writeSse(res, 'error', { error: safe.message, code: safe.code });
        res.end();
      }
    }
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const workflow = await service.get(getAuthenticatedUserId(req), req.params.id);
    res.json({ success: true, data: { workflow } });
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const workflow = await service.update(getAuthenticatedUserId(req), req.params.id, req.body);
    res.json({ success: true, data: { workflow } });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const result = await service.delete(getAuthenticatedUserId(req), req.params.id);
    res.json({ success: true, data: result });
  }));

  return router;
}

export default createWorkflowsRouter();
