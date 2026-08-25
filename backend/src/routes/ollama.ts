import { Router } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { getAiProvider } from '@/services/aiProvider';

const router = Router();

// Health check
router.get('/health', asyncHandler(async (req, res) => {
  const provider = getAiProvider();
  const isHealthy = await provider.healthCheck();
  res.json({ 
    success: true, 
    data: { 
      status: isHealthy ? 'healthy' : 'unhealthy',
      provider: provider.id,
      timestamp: new Date().toISOString()
    }
  });
}));

// Get available models
router.get('/models', asyncHandler(async (req, res) => {
  const provider = getAiProvider();
  const models = await provider.listModels();
  res.json({ success: true, data: models, provider: provider.id });
}));

export default router;
