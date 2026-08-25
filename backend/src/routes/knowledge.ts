import { Response, Router } from 'express';
import { getAuthenticatedUserId } from '@/middleware/auth';
import { asyncHandler } from '@/middleware/errorHandler';
import { aiLimiter } from '@/middleware/rateLimiter';
import { RagChunkError } from '@/services/ragChunker';
import { RagService, RagServiceError, ragService } from '@/services/ragService';
import { ProjectError } from '@/services/projectService';

function handleKnowledgeError(res: Response, error: unknown): boolean {
  if (!(error instanceof RagServiceError)
    && !(error instanceof RagChunkError)
    && !(error instanceof ProjectError)) return false;
  res.status(error.statusCode).json({
    success: false,
    error: { code: error.code, message: error.message },
  });
  return true;
}

export function createKnowledgeRouter(service: RagService = ragService): Router {
  const router = Router();

  router.get('/status', asyncHandler(async (req, res) => {
    try {
      const status = await service.status(getAuthenticatedUserId(req), req.query.projectId);
      res.json({ success: true, data: status });
    } catch (error) {
      if (!handleKnowledgeError(res, error)) throw error;
    }
  }));

  router.get('/sources', asyncHandler(async (req, res) => {
    try {
      const sources = await service.list(getAuthenticatedUserId(req), req.query.projectId);
      res.json({ success: true, data: { sources, count: sources.length } });
    } catch (error) {
      if (!handleKnowledgeError(res, error)) throw error;
    }
  }));

  router.post('/sources', aiLimiter, asyncHandler(async (req, res) => {
    try {
      const source = await service.ingest(getAuthenticatedUserId(req), req.body);
      res.status(201).json({ success: true, data: { source } });
    } catch (error) {
      if (!handleKnowledgeError(res, error)) throw error;
    }
  }));

  router.delete('/sources/:id', asyncHandler(async (req, res) => {
    try {
      const ownerId = getAuthenticatedUserId(req);
      await service.delete(ownerId, req.params.id);
      res.json({ success: true, data: { sourceId: req.params.id, deleted: true } });
    } catch (error) {
      if (!handleKnowledgeError(res, error)) throw error;
    }
  }));

  router.post('/query', aiLimiter, asyncHandler(async (req, res) => {
    try {
      const result = await service.query(getAuthenticatedUserId(req), req.body);
      res.json({ success: true, data: result });
    } catch (error) {
      if (!handleKnowledgeError(res, error)) throw error;
    }
  }));

  return router;
}

export default createKnowledgeRouter();
