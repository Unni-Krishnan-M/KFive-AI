import { EventEmitter } from 'events';
import { Readable } from 'stream';
import { Express, Router } from 'express';
import { parseEnvironment } from '@/config/environment';
import { authenticateToken } from '@/middleware/auth';
import { DatasetInputError } from '@/services/datasetAnalysis';
import { DatasetService } from '@/services/datasetService';
import { setupRoutes } from './index';
import { createDatasetsRouter, datasetResourceAdmission } from './datasets';

const ownerId = '64b000000000000000000001';
const datasetId = '64b000000000000000000201';
const projectId = '64b000000000000000000101';
const bytes = Buffer.from('name,score\nAda,10\n');
const dataset = {
  id: datasetId,
  projectId,
  rootDatasetId: datasetId,
  generation: 0,
  kind: 'original',
  name: 'Scores',
  format: 'csv',
  source: { originalName: 'scores.csv', mimeType: 'text/csv', bytes: bytes.length, sha256: 'a'.repeat(64) },
  transforms: {
    trimStrings: false,
    dropDuplicateRows: false,
    dropRowsWithMissingValues: false,
    escapeSpreadsheetFormulas: false,
  },
  quality: { rowCount: 1, columnCount: 2, duplicateRowCount: 0, missingCellCount: 0 },
};

function service(): DatasetService {
  return {
    status: jest.fn().mockResolvedValue({ available: true, canUpload: true }),
    list: jest.fn().mockResolvedValue([dataset]),
    create: jest.fn().mockResolvedValue({ ...dataset, analysis: {} }),
    get: jest.fn().mockResolvedValue({ ...dataset, analysis: {} }),
    derive: jest.fn().mockResolvedValue({ ...dataset, id: '64b000000000000000000202', kind: 'derived' }),
    download: jest.fn().mockResolvedValue({
      buffer: bytes, fileName: 'folder/résults.csv', mimeType: 'text/csv', sha256: 'a'.repeat(64),
    }),
    delete: jest.fn().mockResolvedValue(undefined),
  } as unknown as DatasetService;
}

function handler(router: Router, method: 'get' | 'post' | 'delete', routePath: string) {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === routePath && entry.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function invokeJson(
  router: Router,
  method: 'get' | 'post' | 'delete',
  routePath: string,
  values: Record<string, unknown> = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    handler(router, method, routePath)({
      body: values.body ?? {}, query: values.query ?? {}, params: values.params ?? {}, file: values.file,
      user: { userId: ownerId, email: 'owner@example.test', role: 'user' },
    }, {
      status(code: number) { statusCode = code; return this; },
      json(body: unknown) { resolve({ status: statusCode, body }); return this; },
    }, reject);
  });
}

function invokeDownload(router: Router): Promise<{ status: number; headers: Map<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    const headers = new Map<string, string>();
    handler(router, 'get', '/:id/download')({
      params: { id: datasetId }, query: {}, body: {},
      user: { userId: ownerId, email: 'owner@example.test', role: 'user' },
    }, {
      status(code: number) { status = code; return this; },
      setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); return this; },
      send(body: Buffer) { resolve({ status, headers, body }); return this; },
    }, reject);
  });
}

function invokeFullUpload(
  router: Router,
  payload: Buffer,
  contentType: string,
  authenticatedOwnerId = ownerId
): Promise<{ status: number; body: any }> {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === '/' && entry.route.methods.post);
  const request = Readable.from([payload]) as any;
  request.headers = { 'content-type': contentType, 'content-length': String(payload.length) };
  request.method = 'POST'; request.ip = '127.0.0.1'; request.socket = { remoteAddress: '127.0.0.1' };
  request.app = { get: () => false }; request.query = {}; request.params = {};
  request.user = { userId: authenticatedOwnerId, email: 'owner@example.test', role: 'user' };
  const response = new EventEmitter() as any;
  const headers = new Map<string, unknown>();
  let statusCode = 200;
  response.setHeader = (name: string, value: unknown) => { headers.set(name.toLowerCase(), value); return response; };
  response.getHeader = (name: string) => headers.get(name.toLowerCase());
  response.removeHeader = (name: string) => headers.delete(name.toLowerCase());
  response.status = (code: number) => { statusCode = code; return response; };
  return new Promise((resolve, reject) => {
    response.json = (body: unknown) => { resolve({ status: statusCode, body }); response.emit('finish'); return response; };
    let index = 0;
    const next = (error?: unknown): void => {
      if (error) { reject(error); return; }
      const middleware = layer.route.stack[index++]?.handle;
      if (!middleware) { reject(new Error('Dataset route chain ended without a response.')); return; }
      middleware(request, response, next);
    };
    next();
  });
}

describe('dataset routes', () => {
  it('mounts datasets behind authentication', () => {
    const get = jest.fn();
    const use = jest.fn();
    setupRoutes({ get, use } as unknown as Express, parseEnvironment(process.env));
    expect(use).toHaveBeenCalledWith('/api/v1/datasets', authenticateToken, expect.any(Function));
  });

  it('returns exact owner-scoped status/list/detail/derive/delete envelopes', async () => {
    const api = service();
    const router = createDatasetsRouter(api);
    await expect(invokeJson(router, 'get', '/status', { query: { projectId } }))
      .resolves.toEqual({ status: 200, body: { success: true, data: { available: true, canUpload: true } } });
    await expect(invokeJson(router, 'get', '/', { query: { projectId } }))
      .resolves.toEqual({ status: 200, body: { success: true, data: { datasets: [dataset], count: 1 } } });
    await expect(invokeJson(router, 'get', '/:id', { params: { id: datasetId } })).resolves.toMatchObject({ status: 200 });
    await expect(invokeJson(router, 'post', '/:id/derive', {
      params: { id: datasetId }, body: { transform: { trimStrings: true } },
    })).resolves.toMatchObject({ status: 201, body: { data: { dataset: { kind: 'derived' } } } });
    await expect(invokeJson(router, 'delete', '/:id', { params: { id: datasetId } }))
      .resolves.toEqual({ status: 200, body: { success: true, data: { datasetId, deleted: true } } });
    expect(api.status).toHaveBeenCalledWith(ownerId, projectId);
    expect(api.list).toHaveBeenCalledWith(ownerId, projectId);
    expect(api.get).toHaveBeenCalledWith(ownerId, datasetId);
    expect(api.derive).toHaveBeenCalledWith(ownerId, datasetId, { transform: { trimStrings: true } });
    expect(api.delete).toHaveBeenCalledWith(ownerId, datasetId);
  });

  it('sets safe private attachment and integrity headers on downloads', async () => {
    const api = service();
    const result = await invokeDownload(createDatasetsRouter(api));
    expect(result.status).toBe(200);
    expect(result.body).toEqual(bytes);
    expect(result.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(result.headers.get('content-length')).toBe(String(bytes.length));
    expect(result.headers.get('content-disposition')).toContain('filename="folder_r_sults.csv"');
    expect(result.headers.get('content-disposition')).toContain("filename*=UTF-8''folder%2Fr%C3%A9sults.csv");
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');
    expect(result.headers.get('digest')).toMatch(/^sha-256=/);
    expect(api.download).toHaveBeenCalledWith(ownerId, datasetId);
  });

  it('executes the limiter, admission, Multer memory upload, and create handler chain', async () => {
    const api = service();
    const router = createDatasetsRouter(api);
    const boundary = 'kfive-dataset-boundary';
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nScores\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="projectId"\r\n\r\n${projectId}\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="dataset"; filename="scores.csv"\r\nContent-Type: text/csv\r\n\r\n`
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const result = await invokeFullUpload(router, Buffer.concat([prefix, bytes, suffix]), `multipart/form-data; boundary=${boundary}`);
    expect(result).toEqual({ status: 201, body: { success: true, data: { dataset: { ...dataset, analysis: {} } } } });
    expect(api.create).toHaveBeenCalledWith(ownerId, { name: 'Scores', projectId }, expect.objectContaining({
      buffer: bytes, originalname: 'scores.csv', mimetype: 'text/csv', size: bytes.length,
    }));
  });

  it('preserves safe parser errors from the service', async () => {
    const api = service();
    (api.create as jest.Mock).mockRejectedValue(new DatasetInputError(
      'The CSV file is malformed or has inconsistent row lengths.',
      'INVALID_DATASET_FILE',
      400
    ));
    await expect(invokeJson(createDatasetsRouter(api), 'post', '/', { file: {}, body: {} })).resolves.toEqual({
      status: 400,
      body: { success: false, error: {
        code: 'INVALID_DATASET_FILE', message: 'The CSV file is malformed or has inconsistent row lengths.',
      } },
    });
  });

  it('rejects a third concurrent admitted analysis with a fixed error', () => {
    const first = new EventEmitter() as any;
    const second = new EventEmitter() as any;
    const third = new EventEmitter() as any;
    for (const response of [first, second, third]) {
      response.statusCode = 200;
      response.status = (code: number) => { response.statusCode = code; return response; };
      response.json = jest.fn();
    }
    const next = jest.fn();
    datasetResourceAdmission({} as any, first, next);
    datasetResourceAdmission({} as any, second, next);
    datasetResourceAdmission({} as any, third, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(third.statusCode).toBe(429);
    expect(third.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'DATASET_LAB_BUSY', message: 'Dataset Lab is busy. Try again shortly.' },
    });
    first.emit('finish');
    second.emit('finish');
  });
});
