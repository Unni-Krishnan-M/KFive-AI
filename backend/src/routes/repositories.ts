import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { getAuthenticatedUserId } from '@/middleware/auth';
import { asyncHandler } from '@/middleware/errorHandler';
import { ProjectError } from '@/services/projectService';
import { RepositoryArchiveError, REPOSITORY_LIMITS } from '@/services/repositoryArchiveAnalyzer';
import { RepositoryAnalysisError, RepositoryAnalysisService, repositoryAnalysisService } from '@/services/repositoryAnalysisService';

const upload = multer({
  storage: multer.memoryStorage(),
  // Busboy emits partsLimit when the count reaches the limit, including the
  // final boundary. Permit three actual parts; files/fields remain bounded.
  limits: { fileSize: REPOSITORY_LIMITS.archiveBytes, files: 1, fields: 2, parts: 4, fieldNameSize: 50, fieldSize: 500 },
});

const repositoryAnalysisLimiter = rateLimit({
  windowMs: 60_000,
  limit: 2,
  keyGenerator: (req) => getAuthenticatedUserId(req),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({
    success: false,
    error: { code: 'REPOSITORY_ANALYSIS_RATE_LIMITED', message: 'Too many repository analyses. Try again shortly.' },
  }),
});

let activeRepositoryUploads = 0;
function repositoryUploadAdmission(_req: Request, res: Response, next: NextFunction): void {
  if (activeRepositoryUploads >= 2) {
    res.status(429).json({ success: false, error: { code: 'REPOSITORY_ANALYZER_BUSY', message: 'The repository analyzer is busy. Try again shortly.' } });
    return;
  }
  activeRepositoryUploads += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    activeRepositoryUploads -= 1;
  };
  res.once('finish', release);
  res.once('close', release);
  next();
}

export function repositoryUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single('archive')(req, res, (error: unknown) => {
    if (!error) return next();
    const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      success: false,
      error: {
        code: tooLarge ? 'REPOSITORY_ARCHIVE_TOO_LARGE' : 'INVALID_REPOSITORY_INPUT',
        message: tooLarge ? 'Repository ZIP must be at most 10 MiB.' : 'The repository upload is invalid.',
      },
    });
  });
}

function handleRepositoryError(res: Response, error: unknown): boolean {
  if (!(error instanceof RepositoryAnalysisError) && !(error instanceof RepositoryArchiveError) && !(error instanceof ProjectError)) return false;
  res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
  return true;
}

export function createRepositoriesRouter(service: RepositoryAnalysisService = repositoryAnalysisService): Router {
  const router = Router();

  router.get('/status', asyncHandler(async (req, res) => {
    try {
      const status = await service.status(getAuthenticatedUserId(req), req.query.projectId);
      res.json({ success: true, data: status });
    } catch (error) { if (!handleRepositoryError(res, error)) throw error; }
  }));

  router.get('/analyses', asyncHandler(async (req, res) => {
    try {
      const analyses = await service.list(getAuthenticatedUserId(req), req.query.projectId, req.query.scope);
      res.json({ success: true, data: { analyses, count: analyses.length } });
    } catch (error) { if (!handleRepositoryError(res, error)) throw error; }
  }));

  router.get('/analyses/:id', asyncHandler(async (req, res) => {
    try {
      const analysis = await service.get(getAuthenticatedUserId(req), req.params.id);
      res.json({ success: true, data: { analysis } });
    } catch (error) { if (!handleRepositoryError(res, error)) throw error; }
  }));

  router.delete('/analyses/:id', asyncHandler(async (req, res) => {
    try {
      const ownerId = getAuthenticatedUserId(req);
      await service.delete(ownerId, req.params.id);
      res.json({ success: true, data: { analysisId: req.params.id, deleted: true } });
    } catch (error) { if (!handleRepositoryError(res, error)) throw error; }
  }));

  router.post('/analyses', repositoryAnalysisLimiter, repositoryUploadAdmission, repositoryUpload, asyncHandler(async (req, res) => {
    try {
      const allowedMimeTypes = new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream']);
      if (!req.file || !allowedMimeTypes.has(req.file.mimetype) || !req.file.originalname.toLowerCase().endsWith('.zip')) {
        throw new RepositoryAnalysisError('A ZIP file with a supported MIME type is required.', 'INVALID_REPOSITORY_INPUT', 400);
      }
      const analysis = await service.create(getAuthenticatedUserId(req), req.body, req.file);
      res.status(201).json({ success: true, data: { analysis } });
    } catch (error) { if (!handleRepositoryError(res, error)) throw error; }
  }));

  return router;
}

export default createRepositoriesRouter();
