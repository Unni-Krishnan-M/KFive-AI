import { Router } from 'express';
import fs from 'fs';
import { DocumentModel } from '@/models/Document';
import { logger } from '@/utils/logger';
import { ProjectError, projectService } from '@/services/projectService';
import { errorHandler } from '@/middleware/errorHandler';
import documentRouter, {
  DOCUMENT_PROCESSOR_UNAVAILABLE_MESSAGE,
  DocumentRouteError,
  markDocumentProcessorUnavailable,
  markOcrServiceUnavailable,
  persistUploadedDocument,
  persistUploadedDocumentWithProjectLease,
  publicDocumentRecord,
  removeDocumentStorageFile,
  resolveDocumentStoragePath,
} from './document';
import { ProjectMutationLease } from '@/services/projectMutationLease';

const ownerId = '64b000000000000000000001';
const documentId = '64b000000000000000000501';

function invoke(
  router: Router,
  method: 'get' | 'post' | 'delete',
  routePath: string,
  values: { body?: unknown; query?: unknown; params?: unknown } = {}
): Promise<{ status: number; body: unknown }> {
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === routePath && entry.route.methods[method]
  );
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  return new Promise((resolve, reject) => {
    let status = 200;
    handler({
      body: values.body || {},
      query: values.query || {},
      params: values.params || {},
      user: { userId: ownerId, email: 'owner@example.com', role: 'user' },
    }, {
      status(code: number) { status = code; return this; },
      json(body: unknown) { resolve({ status, body }); return this; },
    }, reject);
  });
}

describe('document route safety stabilization', () => {
  afterEach(() => jest.restoreAllMocks());

  it('disables conversion before multipart middleware can create temporary files', async () => {
    const layer = (documentRouter as any).stack.find(
      (entry: any) => entry.route?.path === '/convert' && entry.route.methods.post
    );
    expect(layer.route.stack).toHaveLength(1);
    await expect(invoke(documentRouter, 'post', '/convert')).rejects.toMatchObject({
      code: 'DOCUMENT_PROCESSOR_UNAVAILABLE',
      statusCode: 503,
      isOperational: true,
    });

    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
    errorHandler(new DocumentRouteError(
      'Document conversion is unavailable until a separate document processor is configured',
      'DOCUMENT_PROCESSOR_UNAVAILABLE',
      503
    ), {
      url: '/api/v1/documents/convert',
      originalUrl: '/api/v1/documents/convert',
      method: 'POST',
      ip: '127.0.0.1',
      get: () => undefined,
    } as any, { status, json } as any, jest.fn());
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'DOCUMENT_PROCESSOR_UNAVAILABLE',
        message: 'Document conversion is unavailable until a separate document processor is configured',
      },
    });
  });

  it('projects only public document fields for list responses', async () => {
    jest.spyOn(projectService, 'resolveOwnedProject').mockResolvedValue(undefined);
    jest.spyOn(DocumentModel, 'find').mockReturnValue({
      sort: () => Promise.resolve([{
        _id: documentId,
        userId: ownerId,
        originalName: 'report.pdf',
        filename: 'private-random-name.pdf',
        path: '/private/uploads/private-random-name.pdf',
        content: 'private extracted content',
        mimeType: 'application/pdf',
        size: 123,
        status: 'completed',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }]),
    } as any);

    const response = await invoke(documentRouter, 'get', '/');
    expect(response).toMatchObject({
      status: 200,
      body: { success: true, data: [{ _id: documentId, originalName: 'report.pdf', status: 'completed' }] },
    });
    const serialized = (response.body as any).data[0];
    expect(serialized).not.toHaveProperty('filename');
    expect(serialized).not.toHaveProperty('path');
    expect(serialized).not.toHaveProperty('content');
    expect(serialized).not.toHaveProperty('userId');
  });

  it('returns extracted text only from an owner-scoped completed detail record', async () => {
    const findOne = jest.spyOn(DocumentModel, 'findOne').mockResolvedValue({
      _id: documentId,
      userId: ownerId,
      originalName: 'report.pdf',
      filename: 'private-random-name.pdf',
      path: '/private/uploads/private-random-name.pdf',
      content: 'owner-visible extracted text',
      pageCount: 2,
      mimeType: 'application/pdf',
      size: 123,
      status: 'completed',
    } as any);

    const response = await invoke(documentRouter, 'get', '/:id', { params: { id: documentId } });
    expect(findOne).toHaveBeenCalledWith({ _id: documentId, userId: ownerId });
    expect(response).toMatchObject({
      status: 200,
      body: { success: true, data: { _id: documentId, content: 'owner-visible extracted text', pageCount: 2 } },
    });
    expect((response.body as any).data).not.toHaveProperty('path');
    expect((response.body as any).data).not.toHaveProperty('filename');
    expect((response.body as any).data).not.toHaveProperty('userId');
  });

  it('rejects owner-scoped active deletion before touching storage', async () => {
    const deleteOne = jest.fn();
    const findOne = jest.spyOn(DocumentModel, 'findOne').mockResolvedValue({
      _id: documentId,
      status: 'processing',
      path: '/tmp/should-not-be-touched',
      deleteOne,
    } as any);

    await expect(invoke(documentRouter, 'delete', '/:id', { params: { id: documentId } }))
      .rejects.toMatchObject({ code: 'DOCUMENT_PROCESSING_ACTIVE', statusCode: 409 });
    expect(findOne).toHaveBeenCalledWith({ _id: documentId, userId: ownerId });
    expect(deleteOne).not.toHaveBeenCalled();
  });

  it('keeps archived project documents read-only before touching storage or MongoDB', async () => {
    const projectId = '64b000000000000000000101';
    const deleteOne = jest.fn();
    jest.spyOn(DocumentModel, 'findOne').mockResolvedValue({
      _id: documentId,
      projectId,
      status: 'completed',
      path: '/etc/passwd',
      deleteOne,
    } as any);
    const resolveProject = jest.spyOn(projectService, 'resolveActiveProject').mockRejectedValue(new ProjectError(
      'Project is archived. Restore it before adding or changing project content.',
      'PROJECT_ARCHIVED',
      409
    ));

    await expect(invoke(documentRouter, 'delete', '/:id', { params: { id: documentId } }))
      .rejects.toMatchObject({ code: 'PROJECT_ARCHIVED', statusCode: 409 });
    expect(resolveProject).toHaveBeenCalledWith(ownerId, projectId);
    expect(deleteOne).not.toHaveBeenCalled();
  });

  it('allows cleanup of a retained document after its project was deleted', async () => {
    const projectId = '64b000000000000000000101';
    const deleteOne = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(DocumentModel, 'findOne').mockResolvedValue({
      _id: documentId,
      projectId,
      status: 'completed',
      path: `${process.cwd()}/uploads/orphan.pdf`,
      deleteOne,
    } as any);
    jest.spyOn(projectService, 'resolveActiveProject').mockRejectedValue(new ProjectError(
      'Project not found.',
      'PROJECT_NOT_FOUND',
      404
    ));
    const unlink = jest.spyOn(fs.promises, 'unlink').mockResolvedValue(undefined);

    const response = await invoke(documentRouter, 'delete', '/:id', { params: { id: documentId } });

    expect(response).toEqual({ status: 200, body: { success: true, message: 'Deleted' } });
    expect(unlink).toHaveBeenCalledWith(`${process.cwd()}/uploads/orphan.pdf`);
    expect(deleteOne).toHaveBeenCalledTimes(1);
  });

  it('rejects an unsafe stored deletion path with a fixed error', async () => {
    const deleteOne = jest.fn();
    jest.spyOn(DocumentModel, 'findOne').mockResolvedValue({
      _id: documentId,
      status: 'failed',
      path: '/etc/passwd',
      deleteOne,
    } as any);

    await expect(invoke(documentRouter, 'delete', '/:id', { params: { id: documentId } }))
      .rejects.toMatchObject({
        code: 'DOCUMENT_STORAGE_INVALID',
        message: 'Document storage record is invalid',
        statusCode: 500,
      });
    expect(deleteOne).not.toHaveBeenCalled();
  });
});

describe('document safety helpers', () => {
  afterEach(() => jest.restoreAllMocks());

  it('never exposes internal storage or extracted content fields', () => {
    expect(publicDocumentRecord({
      _id: documentId,
      userId: ownerId,
      originalName: 'report.pdf',
      filename: 'private.pdf',
      path: '/private/private.pdf',
      content: 'secret extraction',
      mimeType: 'application/pdf',
      size: 10,
      status: 'failed',
      errorMessage: '/private/parser failed',
    })).toEqual({
      _id: documentId,
      originalName: 'report.pdf',
      mimeType: 'application/pdf',
      size: 10,
      status: 'failed',
      errorMessage: 'Document processing failed',
    });
  });

  it('cleans the uploaded file when database creation fails', async () => {
    const databaseError = new Error('database unavailable');
    const removeFile = jest.fn().mockResolvedValue(undefined);
    const file = {
      path: '/tmp/random-upload.pdf',
      originalname: 'report.pdf',
      filename: 'random-upload.pdf',
      mimetype: 'application/pdf',
      size: 100,
    } as Express.Multer.File;

    await expect(persistUploadedDocument(
      ownerId,
      file,
      undefined,
      async () => { throw databaseError; },
      removeFile
    )).rejects.toBe(databaseError);
    expect(removeFile).toHaveBeenCalledWith(file.path);
  });

  it('revalidates a project inside its mutation lease before publishing an upload', async () => {
    const projectId = '64b000000000000000000101';
    const lease = new ProjectMutationLease();
    let release!: () => void;
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const blocker = lease.run(projectId, () => {
      markReady();
      return new Promise<void>((resolve) => { release = resolve; });
    });
    await ready;
    const archived = new ProjectError('Project is archived.', 'PROJECT_ARCHIVED', 409);
    const resolveProject = jest.fn()
      .mockResolvedValueOnce({ _id: projectId, name: 'Active', status: 'active' })
      .mockRejectedValueOnce(archived);
    const createDocument = jest.fn();
    const removeFile = jest.fn().mockResolvedValue(undefined);
    const file = {
      path: '/tmp/project-race.pdf', originalname: 'race.pdf', filename: 'race.pdf',
      mimetype: 'application/pdf', size: 100,
    } as Express.Multer.File;

    const upload = persistUploadedDocumentWithProjectLease(
      ownerId, projectId, file, resolveProject, createDocument, removeFile, lease
    );
    release();

    await expect(upload).rejects.toBe(archived);
    await blocker;
    expect(resolveProject).toHaveBeenCalledTimes(2);
    expect(createDocument).not.toHaveBeenCalled();
    expect(removeFile).toHaveBeenCalledWith(file.path);
  });

  it('persists the fixed unavailable state without sending untrusted documents to an API worker', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const save = jest.fn().mockResolvedValue(undefined);
    const document = {
      _id: documentId,
      originalName: 'report.pdf',
      mimeType: 'application/pdf',
      size: 100,
      status: 'pending' as const,
      save,
    };

    await markDocumentProcessorUnavailable(document);

    expect(document).toMatchObject({
      status: 'failed',
      errorMessage: DOCUMENT_PROCESSOR_UNAVAILABLE_MESSAGE,
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Document processor unavailable', { documentId });
  });

  it('persists a distinct OCR dependency error for image uploads', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const save = jest.fn().mockResolvedValue(undefined);
    const document = {
      _id: documentId,
      originalName: 'scan.png',
      mimeType: 'image/png',
      size: 100,
      status: 'pending' as const,
      save,
    };

    await markOcrServiceUnavailable(document);

    expect(document).toMatchObject({ status: 'failed', errorMessage: 'OCR service is unavailable' });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('allows only resolved files below the upload root and uses async deletion', async () => {
    const root = '/tmp/kfive-upload-root';
    const safe = `${root}/random.pdf`;
    expect(resolveDocumentStoragePath(safe, root)).toBe(safe);
    expect(() => resolveDocumentStoragePath('/tmp/outside.pdf', root)).toThrow(DocumentRouteError);
    expect(() => resolveDocumentStoragePath(root, root)).toThrow(DocumentRouteError);

    const removeFile = jest.fn().mockResolvedValue(undefined);
    await removeDocumentStorageFile(safe, root, removeFile);
    expect(removeFile).toHaveBeenCalledWith(safe);
  });

  it('treats a missing file as deleted but hides other filesystem errors', async () => {
    const root = '/tmp/kfive-upload-root';
    const safe = `${root}/random.pdf`;
    await expect(removeDocumentStorageFile(
      safe,
      root,
      async () => { throw Object.assign(new Error('/private/path missing'), { code: 'ENOENT' }); }
    )).resolves.toBeUndefined();
    await expect(removeDocumentStorageFile(
      safe,
      root,
      async () => { throw new Error('/private/path permission denied'); }
    )).rejects.toMatchObject({
      code: 'DOCUMENT_DELETE_FAILED',
      message: 'Document file could not be deleted safely',
      statusCode: 500,
    });
  });
});
