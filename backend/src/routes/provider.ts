import { RequestHandler, Router } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AiProviderClient, getAiProvider } from '@/services/aiProvider';

export function createProviderRouter(resolveProvider: () => AiProviderClient = getAiProvider): Router {
  const router = Router();

  const statusHandler: RequestHandler = asyncHandler(async (_req, res) => {
    const provider = resolveProvider();
    const healthy = await provider.healthCheck();
    res.status(healthy ? 200 : 503).json({
      success: healthy,
      data: {
        provider: provider.id,
        status: healthy ? 'healthy' : 'unavailable',
        capabilities: provider.capabilities,
        timestamp: new Date().toISOString(),
      },
    });
  });

  router.get('/models', asyncHandler(async (_req, res) => {
    const provider = resolveProvider();
    const models = await provider.listModels();
    res.json({ success: true, data: models, provider: provider.id });
  }));

  const connectionTestHandler: RequestHandler = asyncHandler(async (_req, res) => {
    const provider = resolveProvider();
    const result = await provider.connectionTest();
    res.status(result.connected ? 200 : 503).json({
      success: result.connected,
      data: { provider: provider.id, ...result },
    });
  });

  router.get('/status', statusHandler);
  router.get('/health', statusHandler);
  router.post('/connection-test', connectionTestHandler);
  router.post('/test', connectionTestHandler);

  return router;
}

export default createProviderRouter();
