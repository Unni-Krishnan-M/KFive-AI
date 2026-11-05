import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { asyncHandler } from '@/middleware/errorHandler';
import { DocumentModel } from '@/models/Document';
import { AppError } from '@/middleware/errorHandler';
import { getAuthenticatedUserId } from '@/middleware/auth';
import { randomUUID } from 'crypto';
import { isAllowedDocumentMime, matchesFileSignature, sanitizeOriginalFilename } from '@/utils/documentSecurity';
import { ProjectError, ProjectRecord, projectService } from '@/services/projectService';
import { projectMutationLease } from '@/services/projectMutationLease';
import { logger } from '@/utils/logger';
import { getEnvironment } from '@/config/environment';
import { processStoredDocument } from '@/services/documentProcessor';

const router = Router();

export const uploadDir = path.resolve(process.cwd(), 'uploads');
export const DOCUMENT_PROCESSOR_UNAVAILABLE_MESSAGE = 'Document processor is unavailable';
export const OCR_SERVICE_UNAVAILABLE_MESSAGE = 'OCR service is unavailable';

export class DocumentRouteError extends AppError {
  constructor(message: string, readonly code: string, statusCode: number) {
    super(message, statusCode);
    this.name = 'DocumentRouteError';
  }
}

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const safeExtension = path.extname(sanitizeOriginalFilename(file.originalname)).toLowerCase().slice(0, 10);
    cb(null, `${randomUUID()}${safeExtension}`);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, callback) => {
    callback(null, isAllowedDocumentMime(file.mimetype));
  },
});

async function assertValidSignature(file: Express.Multer.File): Promise<void> {
  const handle = await fs.promises.open(file.path, 'r');
  try {
    const bytes = Buffer.alloc(512);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (!matchesFileSignature(bytes.subarray(0, bytesRead), file.mimetype)) {
      throw new AppError('Uploaded file signature does not match its declared type', 400);
    }
  } finally {
    await handle.close();
  }
}

export async function resolveUploadedProjectContext(
  userId: string,
  projectId: unknown,
  uploadedPath: string,
  resolveProject: (ownerId: string, value: unknown) => Promise<ProjectRecord | undefined> =
    (ownerId, value) => projectService.resolveActiveProject(ownerId, value),
  removeFile: (filePath: string) => Promise<void> = fs.promises.unlink
): Promise<ProjectRecord | undefined> {
  try {
    return await resolveProject(userId, projectId);
  } catch (error) {
    await removeFile(uploadedPath).catch(() => undefined);
    throw error;
  }
}

export function documentRecordFromUpload(
  userId: string,
  file: Express.Multer.File,
  project?: ProjectRecord
): Record<string, unknown> {
  return {
    userId,
    ...(project ? { projectId: project._id } : {}),
    originalName: sanitizeOriginalFilename(file.originalname),
    filename: file.filename,
    mimeType: file.mimetype,
    size: file.size,
    path: file.path,
    status: 'pending',
  };
}

interface ProcessableDocument {
  _id: unknown;
  projectId?: unknown;
  originalName: string;
  mimeType: string;
  size: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  errorMessage?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  save(): Promise<unknown>;
  [key: string]: unknown;
}

interface DeletableDocument {
  _id: unknown;
  projectId?: unknown;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  path: string;
  deleteOne(): Promise<unknown>;
}

export function publicDocumentRecord(document: Record<string, unknown>): Record<string, unknown> {
  return {
    _id: String(document._id),
    ...(document.projectId ? { projectId: String(document.projectId) } : {}),
    originalName: document.originalName,
    mimeType: document.mimeType,
    size: document.size,
    status: document.status,
    ...(document.status === 'failed' ? {
      errorMessage: document.errorMessage === DOCUMENT_PROCESSOR_UNAVAILABLE_MESSAGE
        ? DOCUMENT_PROCESSOR_UNAVAILABLE_MESSAGE
        : document.errorMessage === OCR_SERVICE_UNAVAILABLE_MESSAGE
          ? OCR_SERVICE_UNAVAILABLE_MESSAGE
        : 'Document processing failed',
    } : {}),
    ...(document.createdAt ? { createdAt: document.createdAt } : {}),
    ...(document.updatedAt ? { updatedAt: document.updatedAt } : {}),
  };
}

export async function persistUploadedDocument(
  userId: string,
  file: Express.Multer.File,
  project?: ProjectRecord,
  createDocument: (data: Record<string, unknown>) => Promise<ProcessableDocument> =
    (data) => DocumentModel.create(data) as unknown as Promise<ProcessableDocument>,
  removeFile: (filePath: string) => Promise<void> = fs.promises.unlink
): Promise<ProcessableDocument> {
  try {
    return await createDocument(documentRecordFromUpload(userId, file, project));
  } catch (error) {
    await removeFile(file.path).catch(() => undefined);
    throw error;
  }
}

export async function persistUploadedDocumentWithProjectLease(
  userId: string,
  projectId: unknown,
  file: Express.Multer.File,
  resolveProject: (ownerId: string, value: unknown) => Promise<ProjectRecord | undefined> =
    (ownerId, value) => projectService.resolveActiveProject(ownerId, value),
  createDocument: (data: Record<string, unknown>) => Promise<ProcessableDocument> =
    (data) => DocumentModel.create(data) as unknown as Promise<ProcessableDocument>,
  removeFile: (filePath: string) => Promise<void> = fs.promises.unlink,
  lease: Pick<typeof projectMutationLease, 'run'> = projectMutationLease
): Promise<ProcessableDocument> {
  const initialProject = await resolveUploadedProjectContext(
    userId, projectId, file.path, resolveProject, removeFile
  );
  if (!initialProject) return persistUploadedDocument(userId, file, undefined, createDocument, removeFile);

  return lease.run(String(initialProject._id), async () => {
    // Project archive/delete uses the same lease. Re-read after acquiring it so
    // a queued upload cannot publish into a project that changed meanwhile.
    const activeProject = await resolveUploadedProjectContext(
      userId, projectId, file.path, resolveProject, removeFile
    );
    return persistUploadedDocument(userId, file, activeProject, createDocument, removeFile);
  });
}

export async function markDocumentProcessorUnavailable(document: ProcessableDocument): Promise<void> {
  document.status = 'failed';
  document.errorMessage = DOCUMENT_PROCESSOR_UNAVAILABLE_MESSAGE;
  await document.save();
  logger.warn('Document processor unavailable', { documentId: String(document._id) });
}

export async function markOcrServiceUnavailable(document: ProcessableDocument): Promise<void> {
  document.status = 'failed';
  document.errorMessage = OCR_SERVICE_UNAVAILABLE_MESSAGE;
  await document.save();
  logger.warn('OCR service unavailable', { documentId: String(document._id) });
}

export function resolveDocumentStoragePath(storedPath: unknown, rootDirectory = uploadDir): string {
  if (typeof storedPath !== 'string' || !storedPath) {
    throw new DocumentRouteError('Document storage record is invalid', 'DOCUMENT_STORAGE_INVALID', 500);
  }
  const root = path.resolve(rootDirectory);
  const candidate = path.resolve(storedPath);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new DocumentRouteError('Document storage record is invalid', 'DOCUMENT_STORAGE_INVALID', 500);
  }
  return candidate;
}

export async function removeDocumentStorageFile(
  storedPath: unknown,
  rootDirectory = uploadDir,
  removeFile: (filePath: string) => Promise<void> = fs.promises.unlink
): Promise<void> {
  const safePath = resolveDocumentStoragePath(storedPath, rootDirectory);
  try {
    await removeFile(safePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new DocumentRouteError('Document file could not be deleted safely', 'DOCUMENT_DELETE_FAILED', 500);
  }
}

// Upload and index a document
router.post('/', upload.single('document'), asyncHandler(async (req, res) => {
  const userId = getAuthenticatedUserId(req);

  if (!req.file) {
    throw new AppError('No file uploaded', 400);
  }

  try {
    await assertValidSignature(req.file);
  } catch (error) {
    await fs.promises.unlink(req.file.path).catch(() => undefined);
    throw error;
  }
  const doc = await persistUploadedDocumentWithProjectLease(userId, req.body.projectId, req.file);
  const environment = getEnvironment();
  const processorUrl = environment.documentProcessorUrl;
  const ocrUrl = environment.ocrServiceUrl;
  const isPdf = req.file.mimetype === 'application/pdf';
  const isImage = req.file.mimetype === 'image/png' || req.file.mimetype === 'image/jpeg';
  if (isPdf && !processorUrl && !ocrUrl) {
    await markDocumentProcessorUnavailable(doc);
  } else if (isImage && !ocrUrl) {
    await markOcrServiceUnavailable(doc);
  } else if (!isPdf && !isImage) {
    await markDocumentProcessorUnavailable(doc);
  } else {
    doc.status = 'processing';
    await doc.save();
    try {
      const safePath = resolveDocumentStoragePath(req.file.path);
      const result = await processStoredDocument(
        safePath,
        req.file.mimetype as 'application/pdf' | 'image/png' | 'image/jpeg',
        processorUrl,
        ocrUrl
      );
      doc.content = result.text;
      doc.pageCount = result.pageCount;
      doc.ocrApplied = result.ocrApplied;
      doc.status = 'completed';
      doc.errorMessage = undefined;
    } catch (error) {
      doc.status = 'failed';
      doc.errorMessage = error instanceof Error && [
        DOCUMENT_PROCESSOR_UNAVAILABLE_MESSAGE,
        OCR_SERVICE_UNAVAILABLE_MESSAGE,
      ].includes(error.message) ? error.message : 'Document processing failed';
    }
    await doc.save();
  }

  res.status(201).json({ success: true, data: publicDocumentRecord(doc) });
}));

// Native document parsers must never run inside the API process.
router.post('/convert', asyncHandler(async () => {
  throw new DocumentRouteError(
    'Document conversion is unavailable until a separate document processor is configured',
    'DOCUMENT_PROCESSOR_UNAVAILABLE',
    503
  );
}));

// Get all documents for user
router.get('/', asyncHandler(async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  const project = await projectService.resolveOwnedProject(userId, req.query.projectId);
  const docs = await DocumentModel.find({ userId, ...(project ? { projectId: project._id } : {}) })
    .sort({ createdAt: -1 });

  res.json({ success: true, data: docs.map((document) => publicDocumentRecord(document as unknown as Record<string, unknown>)) });
}));

// Delete a document
router.get('/:id', asyncHandler(async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw new DocumentRouteError('Document not found', 'DOCUMENT_NOT_FOUND', 404);
  const doc = await DocumentModel.findOne({ _id: req.params.id, userId: getAuthenticatedUserId(req) });
  if (!doc) throw new DocumentRouteError('Document not found', 'DOCUMENT_NOT_FOUND', 404);
  res.json({ success: true, data: {
    ...publicDocumentRecord(doc as unknown as Record<string, unknown>),
    ...(doc.status === 'completed' ? { content: doc.content, pageCount: doc.pageCount } : {}),
    ...(doc.status === 'completed' ? { ocrApplied: doc.ocrApplied === true } : {}),
  } });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  const doc = await DocumentModel.findOne({ _id: req.params.id, userId }) as unknown as DeletableDocument | null;

  if (!doc) throw new DocumentRouteError('Document not found', 'DOCUMENT_NOT_FOUND', 404);

  const deleteRecord = async () => {
    if (doc.projectId) {
      try {
        await projectService.resolveActiveProject(userId, String(doc.projectId));
      } catch (error) {
        // Project deletion intentionally does not cascade. Retained orphaned documents
        // must remain removable, while an existing archived Project stays read-only.
        if (!(error instanceof ProjectError) || error.code !== 'PROJECT_NOT_FOUND') throw error;
      }
    }
    if (doc.status === 'processing') {
      throw new DocumentRouteError(
        'Document cannot be deleted while processing is active',
        'DOCUMENT_PROCESSING_ACTIVE',
        409
      );
    }

    await removeDocumentStorageFile(doc.path);
    await doc.deleteOne();
  };

  if (doc.projectId) {
    await projectMutationLease.run(String(doc.projectId), deleteRecord);
  } else {
    await deleteRecord();
  }

  res.json({ success: true, message: 'Deleted' });
}));

export default router;
