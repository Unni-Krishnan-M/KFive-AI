import { Readable } from 'stream';
import { EventEmitter } from 'events';
import { Router } from 'express';
import { authenticateToken } from '@/middleware/auth';
import { RepositoryAnalysisService } from '@/services/repositoryAnalysisService';
import { createRepositoriesRouter, repositoryUpload } from './repositories';

const ownerId = '64b000000000000000000001';
const projectId = '64b000000000000000000101';
const analysis = {
  id: '64b000000000000000000201', projectId, name: 'Repo', status: 'completed', analyzerVersion: 1,
  source: { kind: 'zip', originalName: 'repo.zip', mimeType: 'application/zip', compressedBytes: 22, sha256: 'a'.repeat(64) },
  summary: { fileCount: 0, directoryCount: 0, declaredUncompressedBytes: 0, maxDepth: 0, packageManifestCount: 0, testFileCount: 0 },
  tree: [], languages: [], manifests: [], dependencies: [], frameworks: [], signals: [], warnings: [],
};
const analysisSummary = Object.fromEntries(Object.entries(analysis).filter(([key]) =>
  !['tree', 'languages', 'manifests', 'dependencies', 'frameworks', 'signals', 'warnings'].includes(key)));
const status = {
  available: true, canAnalyze: true, scope: { type: 'project', projectId, projectStatus: 'active' },
  capabilities: { zip: true, githubUrl: false, localPath: false, extraction: false, execution: false, network: false },
  dependencies: [{ id: 'mongodb', status: 'available' }], limits: { archiveBytes: 10_485_760 },
};

function fakeService(): RepositoryAnalysisService {
  return {
    status: jest.fn().mockResolvedValue(status), list: jest.fn().mockResolvedValue([analysisSummary]),
    get: jest.fn().mockResolvedValue(analysis), create: jest.fn().mockResolvedValue(analysis), delete: jest.fn().mockResolvedValue(undefined),
  } as unknown as RepositoryAnalysisService;
}

function invoke(router: Router, method: 'get' | 'post' | 'delete', routePath: string, values: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === routePath && entry.route.methods[method]);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const req = {
      body: values.body ?? {}, query: values.query ?? {}, params: values.params ?? {}, file: values.file,
      user: { userId: ownerId, email: 'user@example.test', role: 'user' },
    };
    const res = { status(code: number) { statusCode = code; return this; }, json(body: any) { resolve({ status: statusCode, body }); return this; } };
    handler(req, res, reject);
  });
}

function invokeFullPostChain(
  router: Router,
  payload: Buffer,
  contentType: string,
  ip = '127.0.0.1',
  authenticatedOwnerId = ownerId
): Promise<{ status: number; body: any }> {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === '/analyses' && entry.route.methods.post);
  const request = Readable.from([payload]) as any;
  request.headers = { 'content-type': contentType, 'content-length': String(payload.length) };
  request.method = 'POST'; request.ip = ip; request.socket = { remoteAddress: ip };
  request.app = { get: () => false }; request.query = {}; request.params = {};
  request.user = { userId: authenticatedOwnerId, email: 'user@example.test', role: 'user' };
  const emitter = new EventEmitter() as any;
  const headers = new Map<string, unknown>();
  let statusCode = 200;
  emitter.setHeader = (name: string, value: unknown) => { headers.set(name.toLowerCase(), value); };
  emitter.getHeader = (name: string) => headers.get(name.toLowerCase());
  emitter.removeHeader = (name: string) => headers.delete(name.toLowerCase());
  emitter.status = (code: number) => { statusCode = code; return emitter; };
  return new Promise((resolve, reject) => {
    emitter.json = (body: any) => { resolve({ status: statusCode, body }); emitter.emit('finish'); return emitter; };
    let index = 0;
    const next = (error?: unknown): void => {
      if (error) { reject(error); return; }
      const middleware = layer.route.stack[index++]?.handle;
      if (!middleware) { reject(new Error('Route chain ended without a response.')); return; }
      middleware(request, emitter, next);
    };
    next();
  });
}

describe('repository analysis routes', () => {
  it('is intended to remain behind authentication', () => {
    expect(() => authenticateToken({ headers: {} } as any, {} as any, jest.fn())).toThrow('Access token required');
  });

  it('returns exact status/list/detail envelopes and owner scope', async () => {
    const service = fakeService();
    const router = createRepositoriesRouter(service);
    await expect(invoke(router, 'get', '/status', { query: { projectId } })).resolves.toEqual({ status: 200, body: { success: true, data: status } });
    await expect(invoke(router, 'get', '/analyses', { query: { projectId } })).resolves.toEqual({ status: 200, body: { success: true, data: { analyses: [analysisSummary], count: 1 } } });
    await expect(invoke(router, 'get', '/analyses/:id', { params: { id: analysis.id } })).resolves.toEqual({ status: 200, body: { success: true, data: { analysis } } });
    await expect(invoke(router, 'delete', '/analyses/:id', { params: { id: analysis.id } })).resolves.toEqual({
      status: 200, body: { success: true, data: { analysisId: analysis.id, deleted: true } },
    });
    expect(service.status).toHaveBeenCalledWith(ownerId, projectId);
    expect(service.list).toHaveBeenCalledWith(ownerId, projectId, undefined);
    await invoke(router, 'get', '/analyses', { query: { scope: 'orphaned' } });
    expect(service.list).toHaveBeenLastCalledWith(ownerId, undefined, 'orphaned');
    expect(service.get).toHaveBeenCalledWith(ownerId, analysis.id);
    expect(service.delete).toHaveBeenCalledWith(ownerId, analysis.id);
  });

  it('returns the synchronous create envelope with exact file and input forwarding', async () => {
    const service = fakeService();
    const file = { buffer: Buffer.from('PK'), originalname: 'repo.zip', mimetype: 'application/zip', size: 2 };
    await expect(invoke(createRepositoriesRouter(service), 'post', '/analyses', { body: { name: 'Repo', projectId }, file }))
      .resolves.toEqual({ status: 201, body: { success: true, data: { analysis } } });
    expect(service.create).toHaveBeenCalledWith(ownerId, { name: 'Repo', projectId }, file);
  });

  it('uses Multer 2 memory parsing and returns a fixed unsupported-field error', async () => {
    const boundary = 'kfive-test-boundary';
    const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="wrong"; filename="repo.zip"\r\nContent-Type: application/zip\r\n\r\nPK\u0005\u0006\r\n--${boundary}--\r\n`, 'binary');
    const req = Readable.from([payload]) as any;
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(payload.length) };
    req.method = 'POST';
    const result = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      let code = 200;
      const res = { status(value: number) { code = value; return this; }, json(body: any) { resolve({ status: code, body }); return this; } };
      repositoryUpload(req, res as any, (error?: unknown) => error ? reject(error) : reject(new Error('Unexpected upload acceptance')));
    });
    expect(result).toEqual({ status: 400, body: { success: false, error: { code: 'INVALID_REPOSITORY_INPUT', message: 'The repository upload is invalid.' } } });
  });

  it('executes the complete limiter, admission, Multer, MIME and create route chain', async () => {
    const service = fakeService();
    const router = createRepositoriesRouter(service);
    const boundary = 'kfive-full-chain';
    const emptyZip = Buffer.alloc(22); emptyZip.writeUInt32LE(0x06054b50, 0);
    const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nRepo\r\n--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="repo.zip"\r\nContent-Type: application/zip\r\n\r\n`);
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    await expect(invokeFullPostChain(router, Buffer.concat([prefix, emptyZip, suffix]), `multipart/form-data; boundary=${boundary}`))
      .resolves.toEqual({ status: 201, body: { success: true, data: { analysis } } });
    expect(service.create).toHaveBeenCalledWith(ownerId, { name: 'Repo' }, expect.objectContaining({
      originalname: 'repo.zip', mimetype: 'application/zip', buffer: emptyZip,
    }));

    const projectOwner = '64b000000000000000000004';
    const projectPrefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="repo.zip"\r\nContent-Type: application/zip\r\n\r\n`);
    const projectFields = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nProject Repo\r\n--${boundary}\r\nContent-Disposition: form-data; name="projectId"\r\n\r\n${projectId}`);
    await expect(invokeFullPostChain(
      router,
      Buffer.concat([projectPrefix, emptyZip, projectFields, suffix]),
      `multipart/form-data; boundary=${boundary}`,
      '127.0.0.4',
      projectOwner,
    )).resolves.toEqual({ status: 201, body: { success: true, data: { analysis } } });
    expect(service.create).toHaveBeenLastCalledWith(projectOwner, { name: 'Project Repo', projectId }, expect.objectContaining({
      originalname: 'repo.zip', mimetype: 'application/zip', buffer: emptyZip,
    }));

    const extraField = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="extra"\r\n\r\nunexpected`);
    await expect(invokeFullPostChain(router, Buffer.concat([projectPrefix, emptyZip, projectFields, extraField, suffix]),
      `multipart/form-data; boundary=${boundary}`, '127.0.0.5', '64b000000000000000000005'))
      .resolves.toMatchObject({ status: 400, body: { error: { code: 'INVALID_REPOSITORY_INPUT' } } });

    const badMimePrefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="repo.zip"\r\nContent-Type: text/plain\r\n\r\n`);
    await expect(invokeFullPostChain(router, Buffer.concat([badMimePrefix, emptyZip, suffix]), `multipart/form-data; boundary=${boundary}`, '127.0.0.2', '64b000000000000000000002'))
      .resolves.toEqual({ status: 400, body: { success: false, error: {
        code: 'INVALID_REPOSITORY_INPUT', message: 'A ZIP file with a supported MIME type is required.',
      } } });

    const huge = Buffer.alloc(10 * 1024 * 1024 + 1);
    const hugePrefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="repo.zip"\r\nContent-Type: application/zip\r\n\r\n`);
    await expect(invokeFullPostChain(router, Buffer.concat([hugePrefix, huge, suffix]), `multipart/form-data; boundary=${boundary}`, '127.0.0.3', '64b000000000000000000003'))
      .resolves.toEqual({ status: 413, body: { success: false, error: {
        code: 'REPOSITORY_ARCHIVE_TOO_LARGE', message: 'Repository ZIP must be at most 10 MiB.',
      } } });
  });

  it('rate limits by authenticated owner rather than proxy IP', async () => {
    const router = createRepositoriesRouter(fakeService());
    const boundary = 'kfive-owner-rate-limit';
    const emptyZip = Buffer.alloc(22); emptyZip.writeUInt32LE(0x06054b50, 0);
    const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="repo.zip"\r\nContent-Type: application/zip\r\n\r\n`);
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([prefix, emptyZip, suffix]);
    const contentType = `multipart/form-data; boundary=${boundary}`;
    const limitedOwner = '64b000000000000000000011';
    const otherOwner = '64b000000000000000000012';

    await expect(invokeFullPostChain(router, payload, contentType, '127.0.0.10', limitedOwner)).resolves.toMatchObject({ status: 201 });
    await expect(invokeFullPostChain(router, payload, contentType, '127.0.0.11', limitedOwner)).resolves.toMatchObject({ status: 201 });
    await expect(invokeFullPostChain(router, payload, contentType, '127.0.0.12', limitedOwner)).resolves.toMatchObject({
      status: 429, body: { error: { code: 'REPOSITORY_ANALYSIS_RATE_LIMITED' } },
    });
    await expect(invokeFullPostChain(router, payload, contentType, '127.0.0.10', otherOwner)).resolves.toMatchObject({ status: 201 });
  });
});
