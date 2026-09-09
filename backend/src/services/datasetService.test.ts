import fs from 'fs';
import { createHash } from 'crypto';
import { Types } from 'mongoose';
import { DATASET_DERIVED_OUTPUT_BYTES, DATASET_OWNER_RETENTION } from '@/models/Dataset';
import { analyzeDataset, DatasetInputError, parseDataset } from './datasetAnalysis';
import {
  DatasetRecord,
  DatasetRepository,
  DatasetService,
  DatasetServiceError,
  DatasetStorage,
  FileDatasetStorage,
  datasetListFilter,
  resolveDatasetStoragePath,
} from './datasetService';
import { ProjectError } from './projectService';

const ownerId = '64b000000000000000000001';
const otherOwnerId = '64b000000000000000000002';
const projectId = '64b000000000000000000101';
const datasetId = '64b000000000000000000201';
const childId = '64b000000000000000000202';
const original = Buffer.from('name,value\n Ada ,=2+3\n Ada ,=2+3\nBob,\n');

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function record(overrides: Partial<DatasetRecord> = {}): DatasetRecord {
  return {
    _id: datasetId,
    ownerId,
    projectId,
    rootDatasetId: datasetId,
    generation: 0,
    kind: 'original',
    name: 'Scores',
    originalName: 'scores.csv',
    format: 'csv',
    mimeType: 'text/csv',
    byteCount: original.length,
    sha256: sha256(original),
    storageKey: 'originals/123e4567-e89b-12d3-a456-426614174000.csv',
    transform: {
      trimStrings: false,
      dropDuplicateRows: false,
      dropRowsWithMissingValues: false,
      escapeSpreadsheetFormulas: false,
    },
    analysis: analyzeDataset(parseDataset(original, 'csv')),
    ...overrides,
  };
}

function repository(overrides: Partial<DatasetRepository> = {}): DatasetRepository {
  return {
    list: jest.fn().mockResolvedValue([record()]),
    countByOwner: jest.fn().mockResolvedValue(0),
    create: jest.fn(async (data) => data as unknown as DatasetRecord),
    findByOwnerAndId: jest.fn().mockResolvedValue(record()),
    countChildren: jest.fn().mockResolvedValue(0),
    deleteByOwnerAndId: jest.fn().mockResolvedValue(record()),
    ...overrides,
  };
}

function storage(initial: Record<string, Buffer> = { [record().storageKey]: original }): DatasetStorage & { files: Map<string, Buffer> } {
  const files = new Map(Object.entries(initial).map(([key, value]) => [key, Buffer.from(value)]));
  return {
    files,
    write: jest.fn(async (key: string, buffer: Buffer) => {
      if (files.has(key)) throw new Error('exists');
      files.set(key, Buffer.from(buffer));
    }),
    read: jest.fn(async (key: string) => {
      const value = files.get(key);
      if (!value) throw new DatasetServiceError('Dataset storage is unavailable.', 'DATASET_STORAGE_UNAVAILABLE', 503);
      return Buffer.from(value);
    }),
    remove: jest.fn(async (key: string) => { files.delete(key); }),
  };
}

function projects(status: 'active' | 'archived' = 'active') {
  const project = { _id: projectId, ownerId, status, name: 'Project', description: '', tags: [] };
  return {
    resolveActiveProject: jest.fn(async (_owner: string, value: unknown) => value ? project : undefined),
    resolveOwnedProject: jest.fn(async (_owner: string, value: unknown) => value ? project : undefined),
  };
}

describe('DatasetService', () => {
  it('keeps workspace and project Mongo list filters disjoint', () => {
    expect(datasetListFilter(ownerId)).toEqual({ ownerId, projectId: { $exists: false } });
    expect(datasetListFilter(ownerId, projectId)).toEqual({ ownerId, projectId });
  });

  it('persists an analyzed immutable original under active project scope without exposing storage fields', async () => {
    const repo = repository();
    const files = storage({});
    const projectResolver = projects();
    const service = new DatasetService(repo, projectResolver, files, () => true, () => new Types.ObjectId(datasetId));
    const result = await service.create(ownerId, { name: ' Scores ', projectId }, {
      buffer: original, originalname: 'scores.csv', mimetype: 'text/csv', size: original.length,
    });

    expect(projectResolver.resolveActiveProject).toHaveBeenCalledWith(ownerId, projectId);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
      ownerId, projectId, rootDatasetId: expect.any(Types.ObjectId), kind: 'original', generation: 0,
      name: 'Scores', sha256: sha256(original), analysis: expect.objectContaining({ duplicateRowCount: 1 }),
    }));
    expect(files.write).toHaveBeenCalledWith(expect.stringMatching(/^originals\/.*\.csv$/), original);
    expect(result).toMatchObject({ id: datasetId, projectId, name: 'Scores', kind: 'original' });
    expect(result).not.toHaveProperty('ownerId');
    expect(result).not.toHaveProperty('storageKey');
    expect(JSON.stringify(result)).not.toContain('originals/');
  });

  it('requires exact extension/MIME pairs and preserves bounded parser errors', async () => {
    const files = storage({});
    const service = new DatasetService(repository(), projects(), files);
    await expect(service.create(ownerId, {}, {
      buffer: original, originalname: 'scores.csv', mimetype: 'application/json', size: original.length,
    })).rejects.toMatchObject({ code: 'INVALID_DATASET_INPUT', statusCode: 400 });
    await expect(service.create(ownerId, {}, {
      buffer: Buffer.from('a,b\n1\n'), originalname: 'bad.csv', mimetype: 'text/csv', size: 6,
    })).rejects.toBeInstanceOf(DatasetInputError);
    expect(files.write).not.toHaveBeenCalled();
  });

  it('cleans the original file when Mongo creation fails', async () => {
    const files = storage({});
    const service = new DatasetService(repository({ create: jest.fn().mockRejectedValue(new Error('db down')) }), projects(), files);
    await expect(service.create(ownerId, {}, {
      buffer: original, originalname: 'scores.csv', mimetype: 'text/csv', size: original.length,
    })).rejects.toMatchObject({ code: 'DATASET_STORAGE_UNAVAILABLE', statusCode: 503 });
    expect(files.files.size).toBe(0);
    expect(files.remove).toHaveBeenCalledTimes(1);
  });

  it('creates a child with exact lineage and transformations without modifying source bytes', async () => {
    const files = storage();
    const repo = repository({
      create: jest.fn(async (data) => ({ ...data, _id: childId }) as unknown as DatasetRecord),
    });
    const service = new DatasetService(repo, projects(), files, () => true, () => new Types.ObjectId(childId));
    const result = await service.derive(ownerId, datasetId, {
      name: 'Clean scores',
      transform: {
        trimStrings: true,
        dropDuplicateRows: true,
        dropRowsWithMissingValues: true,
        escapeSpreadsheetFormulas: true,
      },
    });

    expect(files.files.get(record().storageKey)).toEqual(original);
    const created = (repo.create as jest.Mock).mock.calls[0][0];
    expect(created).toMatchObject({
      ownerId, projectId, parentDatasetId: datasetId, rootDatasetId: datasetId,
      generation: 1, kind: 'derived', name: 'Clean scores',
    });
    expect(created.storageKey).toMatch(/^derived\/.*\.csv$/);
    expect(files.files.get(created.storageKey)?.toString()).toBe("name,value\nAda,'=2+3\n");
    expect(result).toMatchObject({ id: childId, parentDatasetId: datasetId, rootDatasetId: datasetId, generation: 1 });
  });

  it('rejects unsupported, non-boolean, empty, and empty-result transformations before persistence', async () => {
    const files = storage();
    const service = new DatasetService(repository(), projects(), files);
    await expect(service.derive(ownerId, datasetId, { transform: { eval: 'rm -rf' } }))
      .rejects.toMatchObject({ code: 'INVALID_DATASET_INPUT' });
    await expect(service.derive(ownerId, datasetId, { transform: { trimStrings: 'yes' } }))
      .rejects.toMatchObject({ code: 'INVALID_DATASET_INPUT' });
    await expect(service.derive(ownerId, datasetId, { transform: {} }))
      .rejects.toMatchObject({ code: 'INVALID_DATASET_INPUT' });
    await expect(service.derive(ownerId, datasetId, { transform: { dropRowsWithMissingValues: true } }))
      .resolves.toMatchObject({ kind: 'derived' });

    const json = Buffer.from('[{"name":"Ada"}]');
    const jsonSource = record({
      originalName: 'scores.json',
      format: 'json',
      mimeType: 'application/json',
      byteCount: json.length,
      sha256: sha256(json),
      analysis: analyzeDataset(parseDataset(json, 'json')),
    });
    const jsonService = new DatasetService(repository({ findByOwnerAndId: jest.fn().mockResolvedValue(jsonSource) }), projects(), storage());
    await expect(jsonService.derive(ownerId, datasetId, { transform: { escapeSpreadsheetFormulas: true } }))
      .rejects.toMatchObject({ code: 'INVALID_DATASET_INPUT', statusCode: 400 });
  });

  it('enforces owner retention before parsing or writing', async () => {
    const files = storage({});
    const repo = repository({ countByOwner: jest.fn().mockResolvedValue(DATASET_OWNER_RETENTION) });
    const service = new DatasetService(repo, projects(), files);
    await expect(service.create(ownerId, {}, {
      buffer: original, originalname: 'scores.csv', mimetype: 'text/csv', size: original.length,
    })).rejects.toMatchObject({ code: 'DATASET_LIMIT_REACHED', statusCode: 409 });
    expect(files.write).not.toHaveBeenCalled();
  });

  it('keeps list/detail/download owner scoped, bounded, private, and integrity checked', async () => {
    const repo = repository();
    const files = storage();
    const service = new DatasetService(repo, projects(), files);
    const listed = await service.list(ownerId, projectId);
    expect(repo.list).toHaveBeenCalledWith(ownerId, projectId);
    expect(listed[0]).not.toHaveProperty('analysis');
    expect(listed[0]).not.toHaveProperty('storageKey');
    await expect(service.get(otherOwnerId, datasetId)).resolves.toMatchObject({ id: datasetId });
    expect(repo.findByOwnerAndId).toHaveBeenLastCalledWith(otherOwnerId, datasetId);
    await expect(service.download(ownerId, datasetId)).resolves.toMatchObject({
      buffer: original, fileName: 'scores.csv', mimeType: 'text/csv', sha256: sha256(original),
    });

    files.files.set(record().storageKey, Buffer.from('tampered'));
    await expect(service.download(ownerId, datasetId)).rejects.toMatchObject({ code: 'DATASET_STORAGE_UNAVAILABLE', statusCode: 503 });
  });

  it('allows archived reads but blocks derive/delete, while a deleted-project orphan can be deleted', async () => {
    const archived = new ProjectError('Project is archived.', 'PROJECT_ARCHIVED', 409);
    const archivedProjects = projects('archived');
    archivedProjects.resolveActiveProject.mockRejectedValue(archived);
    const first = new DatasetService(repository(), archivedProjects, storage());
    await expect(first.get(ownerId, datasetId)).resolves.toMatchObject({ id: datasetId });
    await expect(first.download(ownerId, datasetId)).resolves.toMatchObject({ buffer: original });
    await expect(first.derive(ownerId, datasetId, { transform: { trimStrings: true } })).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
    await expect(first.delete(ownerId, datasetId)).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });

    const missingProjects = projects();
    missingProjects.resolveActiveProject.mockRejectedValue(new ProjectError('Project not found.', 'PROJECT_NOT_FOUND', 404));
    const repo = repository();
    const orphanFiles = storage();
    await expect(new DatasetService(repo, missingProjects, orphanFiles).delete(ownerId, datasetId)).resolves.toBeUndefined();
    expect(repo.deleteByOwnerAndId).toHaveBeenCalledWith(ownerId, datasetId);
    expect(orphanFiles.files.size).toBe(0);
  });

  it('blocks parent deletion while derived children exist and restores bytes after a database failure', async () => {
    const files = storage();
    const childRepo = repository({ countChildren: jest.fn().mockResolvedValue(1) });
    await expect(new DatasetService(childRepo, projects(), files).delete(ownerId, datasetId))
      .rejects.toMatchObject({ code: 'DATASET_HAS_DERIVED_CHILDREN', statusCode: 409 });
    expect(files.remove).not.toHaveBeenCalled();

    const failedRepo = repository({ deleteByOwnerAndId: jest.fn().mockRejectedValue(new Error('db down')) });
    const restored = storage();
    await expect(new DatasetService(failedRepo, projects(), restored).delete(ownerId, datasetId))
      .rejects.toMatchObject({ code: 'DATASET_STORAGE_UNAVAILABLE', statusCode: 503 });
    expect(restored.files.get(record().storageKey)).toEqual(original);
  });

  it('reports Mongo/project availability and all immutable bounds', async () => {
    const service = new DatasetService(repository(), projects('archived'), storage(), () => false);
    await expect(service.status(ownerId, projectId)).resolves.toMatchObject({
      available: false,
      canUpload: false,
      scope: { type: 'project', projectId, projectStatus: 'archived' },
      dependencies: [{ id: 'mongodb', status: 'unavailable', message: 'MongoDB is unavailable.' }],
      limits: { uploadBytes: 5 * 1024 * 1024, derivedBytes: DATASET_DERIVED_OUTPUT_BYTES, datasetsPerOwner: 100 },
    });

    const full = new DatasetService(
      repository({ countByOwner: jest.fn().mockResolvedValue(DATASET_OWNER_RETENTION) }),
      projects(),
      storage(),
      () => true
    );
    await expect(full.status(ownerId)).resolves.toMatchObject({
      available: true,
      canUpload: false,
      retention: { used: DATASET_OWNER_RETENTION, maximum: DATASET_OWNER_RETENTION, limitReached: true },
    });
  });

  it('rejects path traversal and maps ENOSPC to a fixed 507 error', async () => {
    expect(() => resolveDatasetStoragePath('../../etc/passwd', '/tmp/kfive-datasets'))
      .toThrow(expect.objectContaining({ code: 'DATASET_STORAGE_UNAVAILABLE', statusCode: 503 }));
    const mkdir = jest.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
    const write = jest.spyOn(fs.promises, 'writeFile').mockRejectedValue(Object.assign(new Error('full'), { code: 'ENOSPC' }));
    await expect(new FileDatasetStorage('/tmp/kfive-datasets-test').write(
      'originals/123e4567-e89b-12d3-a456-426614174000.csv',
      original
    )).rejects.toMatchObject({ code: 'DATASET_STORAGE_FULL', statusCode: 507 });
    mkdir.mockRestore();
    write.mockRestore();
  });

  it('never removes an existing file when an exclusive storage write collides', async () => {
    const mkdir = jest.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
    const write = jest.spyOn(fs.promises, 'writeFile').mockRejectedValue(Object.assign(new Error('exists'), { code: 'EEXIST' }));
    const unlink = jest.spyOn(fs.promises, 'unlink').mockResolvedValue(undefined);
    await expect(new FileDatasetStorage('/tmp/kfive-datasets-test').write(
      'originals/123e4567-e89b-12d3-a456-426614174000.csv',
      original
    )).rejects.toMatchObject({ code: 'DATASET_STORAGE_UNAVAILABLE', statusCode: 503 });
    expect(unlink).not.toHaveBeenCalled();
    mkdir.mockRestore();
    write.mockRestore();
    unlink.mockRestore();
  });
});
