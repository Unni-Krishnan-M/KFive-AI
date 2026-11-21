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
      if (req.query.cursor !== undefined) {
        const page = await service.listPage(getAuthenticatedUserId(req), req.query.projectId, req.query.scope, req.query.cursor);
        res.json({ success: true, data: page });
        return;
      }
      const sources = await service.list(getAuthenticatedUserId(req), req.query.projectId, req.query.scope);
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

  router.post('/sources/from-document', aiLimiter, asyncHandler(async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1 || !Object.prototype.hasOwnProperty.call(body, 'documentId')) {
        throw new RagServiceError(
          'Document knowledge input must contain only documentId.',
          'INVALID_RAG_INPUT',
          400
        );
      }
      const result = await service.ingestDocument(getAuthenticatedUserId(req), body.documentId);
      res.status(result.created ? 201 : 200).json({ success: true, data: result });
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
