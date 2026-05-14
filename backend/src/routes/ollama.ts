import { Router } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { ollamaService } from '@/services/ollama';

const router = Router();

// Health check
router.get('/health', asyncHandler(async (req, res) => {
  const isHealthy = await ollamaService.healthCheck();
  res.json({ 
    success: true, 
    data: { 
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString()
    }
  });
}));

// Get available models
router.get('/models', asyncHandler(async (req, res) => {
  const models = await ollamaService.listModels();
  res.json({ success: true, data: models });
}));

export default router;