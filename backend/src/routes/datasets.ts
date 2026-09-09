import { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { getAuthenticatedUserId } from '@/middleware/auth';
import { asyncHandler } from '@/middleware/errorHandler';
import { DATASET_LIMITS, DatasetInputError } from '@/services/datasetAnalysis';
import { DatasetService, DatasetServiceError, datasetService } from '@/services/datasetService';
import { ProjectError } from '@/services/projectService';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: DATASET_LIMITS.uploadBytes,
    files: 1,
    fields: 2,
    parts: 4,
    fieldNameSize: 50,
    fieldSize: 500,
  },
});

const datasetMutationLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  keyGenerator: (req) => getAuthenticatedUserId(req),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({
    success: false,
    error: { code: 'DATASET_RATE_LIMITED', message: 'Too many dataset operations. Try again shortly.' },
  }),
});

let activeDatasetOperations = 0;
export function datasetResourceAdmission(_req: Request, res: Response, next: NextFunction): void {
  if (activeDatasetOperations >= 2) {
    res.status(429).json({
      success: false,
      error: { code: 'DATASET_LAB_BUSY', message: 'Dataset Lab is busy. Try again shortly.' },
    });
    return;
  }
  activeDatasetOperations += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    activeDatasetOperations -= 1;
  };
  res.once('finish', release);
  res.once('close', release);
  next();
}

export function datasetUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single('dataset')(req, res, (error: unknown) => {
    if (!error) return next();
    const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      success: false,
      error: {
        code: tooLarge ? 'DATASET_TOO_LARGE' : 'INVALID_DATASET_INPUT',
        message: tooLarge ? 'Dataset files must be at most 5 MiB.' : 'The dataset upload is invalid.',
      },
    });
  });
}

function handleDatasetError(res: Response, error: unknown): boolean {
  if (!(error instanceof DatasetServiceError)
    && !(error instanceof DatasetInputError)
    && !(error instanceof ProjectError)) return false;
  res.status(error.statusCode).json({
    success: false,
    error: { code: error.code, message: error.message },
  });
  return true;
}

function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\/]/g, '_') || 'dataset';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function createDatasetsRouter(service: DatasetService = datasetService): Router {
  const router = Router();

  router.get('/status', asyncHandler(async (req, res) => {
    try {
      const status = await service.status(getAuthenticatedUserId(req), req.query.projectId);
      res.json({ success: true, data: status });
    } catch (error) { if (!handleDatasetError(res, error)) throw error; }
  }));

  router.get('/', asyncHandler(async (req, res) => {
    try {
      const datasets = await service.list(getAuthenticatedUserId(req), req.query.projectId);
      res.json({ success: true, data: { datasets, count: datasets.length } });
    } catch (error) { if (!handleDatasetError(res, error)) throw error; }
  }));

  router.post(
    '/',
    datasetMutationLimiter,
    datasetResourceAdmission,
    datasetUpload,
    asyncHandler(async (req, res) => {
      try {
        const dataset = await service.create(getAuthenticatedUserId(req), req.body, req.file);
        res.status(201).json({ success: true, data: { dataset } });
      } catch (error) { if (!handleDatasetError(res, error)) throw error; }
    })
  );

  router.get('/:id/download', datasetResourceAdmission, asyncHandler(async (req, res) => {
    try {
      const download = await service.download(getAuthenticatedUserId(req), req.params.id);
      res.status(200);
      res.setHeader('Content-Type', `${download.mimeType}; charset=utf-8`);
      res.setHeader('Content-Length', String(download.buffer.length));
      res.setHeader('Content-Disposition', contentDisposition(download.fileName));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Digest', `sha-256=${Buffer.from(download.sha256, 'hex').toString('base64')}`);
      res.send(download.buffer);
    } catch (error) { if (!handleDatasetError(res, error)) throw error; }
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    try {
      const dataset = await service.get(getAuthenticatedUserId(req), req.params.id);
      res.json({ success: true, data: { dataset } });
    } catch (error) { if (!handleDatasetError(res, error)) throw error; }
  }));

  router.post('/:id/derive', datasetMutationLimiter, datasetResourceAdmission, asyncHandler(async (req, res) => {
    try {
      const dataset = await service.derive(getAuthenticatedUserId(req), req.params.id, req.body);
      res.status(201).json({ success: true, data: { dataset } });
    } catch (error) { if (!handleDatasetError(res, error)) throw error; }
  }));

  router.delete('/:id', datasetResourceAdmission, asyncHandler(async (req, res) => {
    try {
      const ownerId = getAuthenticatedUserId(req);
      await service.delete(ownerId, req.params.id);
      res.json({ success: true, data: { datasetId: req.params.id, deleted: true } });
    } catch (error) { if (!handleDatasetError(res, error)) throw error; }
  }));

  return router;
}

export default createDatasetsRouter();
