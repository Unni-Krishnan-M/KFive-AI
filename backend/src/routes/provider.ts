import { RequestHandler, Router } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AiProviderClient, getAiProvider } from '@/services/aiProvider';
import { withProviderDiscoveryDeadline } from '@/services/ai/providerDeadline';
import { AiProviderError } from '@/services/ai/errors';

function providerErrorStatus(error: AiProviderError): number {
  if (error.code === 'UNSUPPORTED_CAPABILITY') return 501;
  if (error.code === 'PROVIDER_ERROR' && !error.retryable) return 502;
  return 503;
}

export function createProviderRouter(resolveProvider: () => AiProviderClient = getAiProvider): Router {
  const router = Router();

  const statusHandler: RequestHandler = asyncHandler(async (_req, res) => {
    const provider = resolveProvider();
    const healthy = await withProviderDiscoveryDeadline(provider.id, (options) => provider.healthCheck(options));
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
    try {
      const models = await withProviderDiscoveryDeadline(provider.id, (options) => provider.listModels(options));
      res.json({ success: true, data: models, provider: provider.id });
    } catch (error) {
      if (!(error instanceof AiProviderError)) throw error;
      res.status(providerErrorStatus(error)).json({
        success: false,
        error: { code: error.code, provider: error.provider, retryable: error.retryable, message: error.message },
      });
    }
  }));

  const connectionTestHandler: RequestHandler = asyncHandler(async (_req, res) => {
    const provider = resolveProvider();
    const result = await withProviderDiscoveryDeadline(provider.id, (options) => provider.connectionTest(options));
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
