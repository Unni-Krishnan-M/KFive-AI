import { Router } from 'express';
import { getEnvironment } from '@/config/environment';
import { getAuthenticatedUserId } from '@/middleware/auth';
import { asyncHandler } from '@/middleware/errorHandler';
import { CodeRunService } from '@/services/codeRunService';

export function createCodeRouter(service: CodeRunService = new CodeRunService(getEnvironment().codeRunnerMode)): Router {
  const router = Router();

  router.get('/runtimes', asyncHandler(async (_req, res) => {
    res.json({ success: true, data: await service.getRuntimeCatalog() });
  }));

  router.post('/runs', asyncHandler(async (req, res) => {
    const { run } = await service.create(getAuthenticatedUserId(req), req.body);
    res.status(202).json({ success: true, data: { run } });
  }));

  router.get('/runs', asyncHandler(async (req, res) => {
    const runs = await service.list(getAuthenticatedUserId(req), req.query.projectId);
    res.json({ success: true, data: { runs, count: runs.length } });
  }));

  router.get('/runs/:id', asyncHandler(async (req, res) => {
    const run = await service.get(getAuthenticatedUserId(req), req.params.id);
    res.json({ success: true, data: { run } });
  }));

  router.post('/runs/:id/cancel', asyncHandler(async (req, res) => {
    const result = await service.cancel(getAuthenticatedUserId(req), req.params.id);
    res.json({ success: true, data: result });
  }));

  return router;
}

export default createCodeRouter();
