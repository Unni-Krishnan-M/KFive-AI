import { Router } from 'express';
import { EnvironmentConfig } from '@/config/environment';
import { buildRuntimeStatus } from '@/services/runtimeStatus';

export function createRuntimeRouter(config: EnvironmentConfig): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ success: true, data: buildRuntimeStatus(config) });
  });

  return router;
}
