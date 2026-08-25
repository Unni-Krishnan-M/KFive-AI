import { Router } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { getGpuStatus, GpuStatus } from '@/services/gpuStatus';

export function createSystemRouter(probeGpu: () => Promise<GpuStatus> = getGpuStatus): Router {
  const router = Router();

  router.get('/gpu', asyncHandler(async (_req, res) => {
    const status = await probeGpu();
    res.status(status.available ? 200 : 503).json({ success: status.available, data: status });
  }));

  return router;
}

export default createSystemRouter();

