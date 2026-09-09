import { Router } from 'express';
import { getAuthenticatedUserId } from '@/middleware/auth';
import { asyncHandler } from '@/middleware/errorHandler';
import { NotebookService, notebookService } from '@/services/notebookService';
import { NotebookRunService, notebookRunService } from '@/services/notebookRunService';

export function createNotebooksRouter(
  service: NotebookService = notebookService,
  runs: NotebookRunService = notebookRunService
): Router {
  const router = Router();
  router.get('/status', asyncHandler(async (_req, res) => res.json({ success: true, data: await runs.status() })));
  router.get('/', asyncHandler(async (req, res) => res.json({ success: true,
    data: await service.list(getAuthenticatedUserId(req), req.query.page, req.query.projectId) })));
  router.post('/', asyncHandler(async (req, res) => res.status(201).json({ success: true,
    data: { notebook: await service.create(getAuthenticatedUserId(req), req.body) } })));
  router.get('/:id', asyncHandler(async (req, res) => res.json({ success: true,
    data: { notebook: await service.get(getAuthenticatedUserId(req), req.params.id) } })));
  router.patch('/:id', asyncHandler(async (req, res) => res.json({ success: true,
    data: { notebook: await service.update(getAuthenticatedUserId(req), req.params.id, req.body) } })));
  router.delete('/:id', asyncHandler(async (req, res) => res.json({ success: true,
    data: await service.delete(getAuthenticatedUserId(req), req.params.id, req.body) })));
  router.get('/:id/runs', asyncHandler(async (req, res) => res.json({ success: true,
    data: await runs.list(getAuthenticatedUserId(req), req.params.id, req.query.page) })));
  router.post('/:id/runs', asyncHandler(async (req, res) => res.status(202).json({ success: true,
    data: { run: await runs.start(getAuthenticatedUserId(req), req.params.id, req.body) } })));
  router.get('/:id/runs/:runId', asyncHandler(async (req, res) => res.json({ success: true,
    data: { run: await runs.get(getAuthenticatedUserId(req), req.params.id, req.params.runId) } })));
  router.post('/:id/runs/:runId/cancel', asyncHandler(async (req, res) => res.json({ success: true,
    data: await runs.cancel(getAuthenticatedUserId(req), req.params.id, req.params.runId) })));
  router.delete('/:id/runs/:runId', asyncHandler(async (req, res) => res.json({ success: true,
    data: await runs.delete(getAuthenticatedUserId(req), req.params.id, req.params.runId) })));
  return router;
}

export default createNotebooksRouter();
