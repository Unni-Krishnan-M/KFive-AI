import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import mongoose, { Types } from 'mongoose';
import path from 'path';
import { DATASET_OWNER_RETENTION, DatasetModel } from '@/models/Dataset';
import {
  DATASET_LIMITS,
  DatasetAnalysis,
  DatasetFormat,
  DatasetInputError,
  DatasetTransform,
  analyzeDataset,
  deriveDataset,
  parseDataset,
} from './datasetAnalysis';
import { ProjectError, ProjectService, projectService } from './projectService';
import { projectMutationLease } from './projectMutationLease';

const OBJECT_ID = /^[a-f\d]{24}$/i;
const STORAGE_KEY = /^(?:originals|derived)\/[a-f\d-]{36}\.(?:csv|json)$/;
const EMPTY_TRANSFORM: DatasetTransform = Object.freeze({
  trimStrings: false,
  dropDuplicateRows: false,
  dropRowsWithMissingValues: false,
  escapeSpreadsheetFormulas: false,
});

export const DATASET_STORAGE_ROOT = path.resolve(process.cwd(), 'uploads', 'datasets');

export type DatasetServiceErrorCode =
  | 'INVALID_DATASET_INPUT'
  | 'DATASET_NOT_FOUND'
  | 'DATASET_LIMIT_REACHED'
  | 'DATASET_HAS_DERIVED_CHILDREN'
  | 'DATASET_MUTATION_ACTIVE'
  | 'DATASET_STORAGE_UNAVAILABLE'
  | 'DATASET_STORAGE_FULL';

export class DatasetServiceError extends Error {
  readonly isOperational = true;

  constructor(
    message: string,
    readonly code: DatasetServiceErrorCode,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'DatasetServiceError';
  }
}

export interface DatasetUpload {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface DatasetRecord {
  _id: unknown;
  ownerId: unknown;
  projectId?: unknown;
  parentDatasetId?: unknown;
  rootDatasetId: unknown;
  generation: number;
  kind: 'original' | 'derived';
  name: string;
  originalName: string;
  format: DatasetFormat;
  mimeType: 'text/csv' | 'application/json';
  byteCount: number;
  sha256: string;
  storageKey: string;
  transform: DatasetTransform;
  analysis: DatasetAnalysis;
  createdAt?: Date;
  updatedAt?: Date;
  toObject?: () => DatasetRecord;
}

export interface DatasetCreateData extends Omit<DatasetRecord, '_id' | 'toObject' | 'createdAt' | 'updatedAt'> {
  _id: unknown;
}

export interface DatasetRepository {
  list(ownerId: string, projectId?: string): Promise<DatasetRecord[]>;
  countByOwner(ownerId: string): Promise<number>;
  create(data: DatasetCreateData): Promise<DatasetRecord>;
  findByOwnerAndId(ownerId: string, datasetId: string): Promise<DatasetRecord | null>;
  countChildren(ownerId: string, datasetId: string): Promise<number>;
  deleteByOwnerAndId(ownerId: string, datasetId: string): Promise<DatasetRecord | null>;
}

export function datasetListFilter(ownerId: string, projectId?: string): Record<string, unknown> {
  return {
    ownerId,
    ...(projectId ? { projectId } : { projectId: { $exists: false } }),
  };
}

export const mongooseDatasetRepository: DatasetRepository = {
  async list(ownerId, projectId) {
    return DatasetModel.find(datasetListFilter(ownerId, projectId))
      .select('+storageKey')
      .sort({ createdAt: -1, _id: -1 })
      .limit(DATASET_OWNER_RETENTION)
      .lean() as unknown as Promise<DatasetRecord[]>;
  },
  async countByOwner(ownerId) {
    return DatasetModel.countDocuments({ ownerId });
  },
  async create(data) {
    return DatasetModel.create(data) as unknown as Promise<DatasetRecord>;
  },
  async findByOwnerAndId(ownerId, datasetId) {
    return DatasetModel.findOne({ _id: datasetId, ownerId })
      .select('+storageKey')
      .lean() as unknown as Promise<DatasetRecord | null>;
  },
  async countChildren(ownerId, datasetId) {
    return DatasetModel.countDocuments({ ownerId, parentDatasetId: datasetId });
  },
  async deleteByOwnerAndId(ownerId, datasetId) {
    return DatasetModel.findOneAndDelete({ _id: datasetId, ownerId })
      .select('+storageKey')
      .lean() as unknown as Promise<DatasetRecord | null>;
  },
};

export interface DatasetStorage {
  write(storageKey: string, buffer: Buffer): Promise<void>;
  read(storageKey: string): Promise<Buffer>;
  remove(storageKey: string): Promise<void>;
}

export function resolveDatasetStoragePath(storageKey: unknown, root = DATASET_STORAGE_ROOT): string {
  if (typeof storageKey !== 'string' || !STORAGE_KEY.test(storageKey)) {
    throw new DatasetServiceError('Dataset storage is unavailable.', 'DATASET_STORAGE_UNAVAILABLE', 503);
  }
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, storageKey);
  const relative = path.relative(resolvedRoot, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new DatasetServiceError('Dataset storage is unavailable.', 'DATASET_STORAGE_UNAVAILABLE', 503);
  }
  return candidate;
}

function storageFailure(error: unknown): DatasetServiceError {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new DatasetServiceError('Dataset storage is full.', 'DATASET_STORAGE_FULL', 507);
  }
  return new DatasetServiceError('Dataset storage is unavailable.', 'DATASET_STORAGE_UNAVAILABLE', 503);
}

export class FileDatasetStorage implements DatasetStorage {
  constructor(private readonly root = DATASET_STORAGE_ROOT) {}

  async write(storageKey: string, buffer: Buffer): Promise<void> {
    const filePath = resolveDatasetStoragePath(storageKey, this.root);
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(filePath, buffer, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        await fs.promises.unlink(filePath).catch(() => undefined);
      }
      throw storageFailure(error);
    }
  }

  async read(storageKey: string): Promise<Buffer> {
    const filePath = resolveDatasetStoragePath(storageKey, this.root);
    let handle: fs.promises.FileHandle | undefined;
    try {
      const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
      handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > DATASET_LIMITS.derivedBytes) throw new Error('invalid-size');
      return await handle.readFile();
    } catch (error) {
      if (error instanceof DatasetServiceError) throw error;
      throw storageFailure(error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async remove(storageKey: string): Promise<void> {
    const filePath = resolveDatasetStoragePath(storageKey, this.root);
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw storageFailure(error);
    }
  }
}

export interface PublicDatasetSummary {
  id: string;
  projectId?: string;
  parentDatasetId?: string;
  rootDatasetId: string;
  generation: number;
  kind: 'original' | 'derived';
  name: string;
  format: DatasetFormat;
  source: {
    originalName: string;
    mimeType: 'text/csv' | 'application/json';
    bytes: number;
    sha256: string;
  };
  transforms: DatasetTransform;
  quality: Pick<DatasetAnalysis, 'rowCount' | 'columnCount' | 'duplicateRowCount' | 'missingCellCount'>;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PublicDataset extends PublicDatasetSummary {
  analysis: DatasetAnalysis;
}

export interface DatasetDownload {
  buffer: Buffer;
  fileName: string;
  mimeType: 'text/csv' | 'application/json';
  sha256: string;
}

function materialize(record: DatasetRecord): DatasetRecord {
  return typeof record.toObject === 'function' ? record.toObject() : record;
}

function publicSummary(record: DatasetRecord): PublicDatasetSummary {
  const value = materialize(record);
  return {
    id: String(value._id),
    ...(value.projectId ? { projectId: String(value.projectId) } : {}),
    ...(value.parentDatasetId ? { parentDatasetId: String(value.parentDatasetId) } : {}),
    rootDatasetId: String(value.rootDatasetId),
    generation: value.generation,
    kind: value.kind,
    name: value.name,
    format: value.format,
    source: {
      originalName: value.originalName,
      mimeType: value.mimeType,
      bytes: value.byteCount,
      sha256: value.sha256,
    },
    transforms: value.transform,
    quality: {
      rowCount: value.analysis.rowCount,
      columnCount: value.analysis.columnCount,
      duplicateRowCount: value.analysis.duplicateRowCount,
      missingCellCount: value.analysis.missingCellCount,
    },
    ...(value.createdAt ? { createdAt: value.createdAt } : {}),
    ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
  };
}

function publicDataset(record: DatasetRecord): PublicDataset {
  return { ...publicSummary(record), analysis: materialize(record).analysis };
}

function requireObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) {
    throw new DatasetServiceError(`${label} is invalid.`, 'INVALID_DATASET_INPUT', 400);
  }
  return value;
}

function safeText(value: unknown, fallback: string, label: string, maximum: number): string {
  const selected = value === undefined || value === '' ? fallback : value;
  if (typeof selected !== 'string') {
    throw new DatasetServiceError(`${label} is invalid.`, 'INVALID_DATASET_INPUT', 400);
  }
  const normalized = selected.normalize('NFC').trim();
  if (!normalized || normalized.length > maximum || [...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 0xfffd || /[\p{Cc}\p{Cf}]/u.test(character);
  })) {
    throw new DatasetServiceError(`${label} must contain 1 to ${maximum} safe characters.`, 'INVALID_DATASET_INPUT', 400);
  }
  return normalized;
}

function validateOriginalName(value: unknown): { originalName: string; format: DatasetFormat; mimeType: 'text/csv' | 'application/json' } {
  if (typeof value !== 'string') throw new DatasetServiceError('Dataset filename is invalid.', 'INVALID_DATASET_INPUT', 400);
  const originalName = safeText(path.basename(value.replace(/\\/g, '/')), 'dataset', 'Dataset filename', 255);
  const extension = path.extname(originalName).toLowerCase();
  if (extension === '.csv') return { originalName, format: 'csv', mimeType: 'text/csv' };
  if (extension === '.json') return { originalName, format: 'json', mimeType: 'application/json' };
  throw new DatasetServiceError('Dataset files must use a .csv or .json extension.', 'INVALID_DATASET_INPUT', 400);
}

function validateUpload(upload?: DatasetUpload): {
  buffer: Buffer;
  originalName: string;
  format: DatasetFormat;
  mimeType: 'text/csv' | 'application/json';
} {
  if (!upload || !Buffer.isBuffer(upload.buffer) || upload.size !== upload.buffer.length
    || upload.buffer.length < 1 || upload.buffer.length > DATASET_LIMITS.uploadBytes) {
    throw new DatasetServiceError('A dataset file of at most 5 MiB is required.', 'INVALID_DATASET_INPUT', 400);
  }
  const identity = validateOriginalName(upload.originalname);
  if (upload.mimetype !== identity.mimeType) {
    throw new DatasetServiceError(`The ${identity.format.toUpperCase()} filename and MIME type do not match.`, 'INVALID_DATASET_INPUT', 400);
  }
  return { buffer: upload.buffer, ...identity };
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DatasetServiceError(`${label} must be a JSON object.`, 'INVALID_DATASET_INPUT', 400);
  }
  return value as Record<string, unknown>;
}

function validateCreateInput(value: unknown): { name?: string; projectId?: string } {
  const input = requirePlainObject(value, 'Dataset input');
  if (Object.keys(input).some((key) => !['name', 'projectId'].includes(key))) {
    throw new DatasetServiceError('Dataset input contains unsupported fields.', 'INVALID_DATASET_INPUT', 400);
  }
  return {
    ...(input.name !== undefined ? { name: safeText(input.name, '', 'Dataset name', 200) } : {}),
    ...(input.projectId !== undefined && input.projectId !== '' ? { projectId: requireObjectId(input.projectId, 'Project id') } : {}),
  };
}

function validateDeriveInput(value: unknown, fallbackName: string): { name: string; transform: DatasetTransform } {
  const input = requirePlainObject(value, 'Derived dataset input');
  if (Object.keys(input).some((key) => !['name', 'transform'].includes(key))) {
    throw new DatasetServiceError('Derived dataset input contains unsupported fields.', 'INVALID_DATASET_INPUT', 400);
  }
  const supplied = requirePlainObject(input.transform, 'Dataset transform');
  const keys = ['trimStrings', 'dropDuplicateRows', 'dropRowsWithMissingValues', 'escapeSpreadsheetFormulas'] as const;
  if (Object.keys(supplied).some((key) => !keys.includes(key as typeof keys[number]))) {
    throw new DatasetServiceError('Dataset transform contains unsupported fields.', 'INVALID_DATASET_INPUT', 400);
  }
  const transform = Object.fromEntries(keys.map((key) => {
    const setting = supplied[key] === undefined ? false : supplied[key];
    if (typeof setting !== 'boolean') {
      throw new DatasetServiceError(`Dataset transform ${key} must be boolean.`, 'INVALID_DATASET_INPUT', 400);
    }
    return [key, setting];
  })) as unknown as DatasetTransform;
  if (!Object.values(transform).some(Boolean)) {
    throw new DatasetServiceError('At least one dataset transformation must be enabled.', 'INVALID_DATASET_INPUT', 400);
  }
  return { name: safeText(input.name, fallbackName, 'Dataset name', 200), transform };
}

function checksum(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function storageKey(kind: 'originals' | 'derived', format: DatasetFormat): string {
  return `${kind}/${randomUUID()}.${format}`;
}

export class DatasetService {
  private readonly activeMutations = new Set<string>();

  constructor(
    private readonly repository: DatasetRepository = mongooseDatasetRepository,
    private readonly projects: Pick<ProjectService, 'resolveActiveProject' | 'resolveOwnedProject'> = projectService,
    private readonly storage: DatasetStorage = new FileDatasetStorage(),
    private readonly databaseAvailable: () => boolean = () => mongoose.connection.readyState === 1,
    private readonly createId: () => Types.ObjectId = () => new Types.ObjectId()
  ) {}

  async status(ownerIdValue: unknown, projectIdValue?: unknown): Promise<Record<string, unknown>> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const project = await this.projects.resolveOwnedProject(ownerId, projectIdValue);
    const available = this.databaseAvailable();
    let retainedCount: number | undefined;
    if (available) {
      try { retainedCount = await this.repository.countByOwner(ownerId); }
      catch { throw new DatasetServiceError('Dataset storage is unavailable.', 'DATASET_STORAGE_UNAVAILABLE', 503); }
    }
    const atCapacity = retainedCount !== undefined && retainedCount >= DATASET_OWNER_RETENTION;
    return {
      available,
      canUpload: available && !atCapacity && (!project || project.status === 'active'),
      scope: project
        ? { type: 'project', projectId: String(project._id), projectStatus: project.status }
        : { type: 'workspace' },
      dependencies: [{
        id: 'mongodb', status: available ? 'available' : 'unavailable',
        ...(!available ? { message: 'MongoDB is unavailable.' } : {}),
      }],
      capabilities: { csv: true, json: true, derive: true, notebook: false, training: false, arbitraryCode: false },
      retention: { used: retainedCount, maximum: DATASET_OWNER_RETENTION, limitReached: atCapacity },
      limits: {
        ...DATASET_LIMITS,
        derivedBytes: DATASET_LIMITS.derivedBytes,
        datasetsPerOwner: DATASET_OWNER_RETENTION,
        concurrentOperations: 2,
      },
    };
  }

  async list(ownerIdValue: unknown, projectIdValue?: unknown): Promise<PublicDatasetSummary[]> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    let projectId: string | undefined;
    if (projectIdValue !== undefined && projectIdValue !== null && projectIdValue !== '') {
      projectId = requireObjectId(projectIdValue, 'Project id');
      await this.projects.resolveOwnedProject(ownerId, projectId);
    }
    try {
      return (await this.repository.list(ownerId, projectId)).map(publicSummary);
    } catch {
      throw new DatasetServiceError('Dataset storage is unavailable.', 'DATASET_STORAGE_UNAVAILABLE', 503);
    }
  }

  async get(ownerIdValue: unknown, datasetIdValue: unknown): Promise<PublicDataset> {
    return publicDataset(await this.requireRecord(ownerIdValue, datasetIdValue));
  }

  async create(ownerIdValue: unknown, value: unknown, upload?: DatasetUpload): Promise<PublicDataset> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const input = validateCreateInput(value);
    const file = validateUpload(upload);
    const project = await this.projects.resolveActiveProject(ownerId, input.projectId);
    await this.assertCapacity(ownerId);
    const parsed = parseDataset(file.buffer, file.format);
    const analysis = analyzeDataset(parsed);
    const id = this.createId();
    const key = storageKey('originals', file.format);
    const fallbackName = file.originalName.slice(0, -(file.format.length + 1));
    const record: DatasetCreateData = {
      _id: id,
      ownerId,
      ...(project ? { projectId: project._id } : {}),
      rootDatasetId: id,
      generation: 0,
      kind: 'original',
      name: input.name || safeText(fallbackName, 'dataset', 'Dataset name', 200),
      originalName: file.originalName,
      format: file.format,
      mimeType: file.mimeType,
      byteCount: file.buffer.length,
      sha256: checksum(file.buffer),
      storageKey: key,
      transform: { ...EMPTY_TRANSFORM },
      analysis,
    };
    const publish = async (): Promise<PublicDataset> => {
      if (project) await this.projects.resolveActiveProject(ownerId, String(project._id));
      return publicDataset(await this.persistWithFile(record, file.buffer));
    };
    return project ? projectMutationLease.run(String(project._id), publish) : publish();
  }

  async derive(ownerIdValue: unknown, datasetIdValue: unknown, value: unknown): Promise<PublicDataset> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const datasetId = requireObjectId(datasetIdValue, 'Dataset id');
    return this.withMutation(datasetId, async () => {
      const source = await this.requireRecord(ownerId, datasetId);
      await this.projects.resolveActiveProject(ownerId, source.projectId ? String(source.projectId) : undefined);
      const input = validateDeriveInput(value, `${source.name} cleaned`);
      if (source.format === 'json' && input.transform.escapeSpreadsheetFormulas) {
        throw new DatasetServiceError(
          'Spreadsheet-formula escaping is available only for CSV datasets.',
          'INVALID_DATASET_INPUT',
          400
        );
      }
      await this.assertCapacity(ownerId);
      const originalBuffer = await this.readVerified(source);
      const sourceByteLimit = source.kind === 'derived' ? DATASET_LIMITS.derivedBytes : DATASET_LIMITS.uploadBytes;
      const derived = deriveDataset(parseDataset(originalBuffer, source.format, sourceByteLimit), input.transform);
      if (!derived.parsed.rows.length) {
        throw new DatasetInputError('The selected transformations would produce an empty dataset.', 'INVALID_DATASET_FILE', 400);
      }
      if (derived.buffer.length > DATASET_LIMITS.derivedBytes) {
        throw new DatasetInputError('The derived dataset exceeds the 10 MiB output limit.', 'DATASET_LIMIT_EXCEEDED', 413);
      }
      const id = this.createId();
      const key = storageKey('derived', source.format);
      const extension = source.format;
      const record: DatasetCreateData = {
        _id: id,
        ownerId,
        ...(source.projectId ? { projectId: source.projectId } : {}),
        parentDatasetId: source._id,
        rootDatasetId: source.rootDatasetId,
        generation: source.generation + 1,
        kind: 'derived',
        name: input.name,
        originalName: `${input.name}.${extension}`,
        format: source.format,
        mimeType: source.mimeType,
        byteCount: derived.buffer.length,
        sha256: checksum(derived.buffer),
        storageKey: key,
        transform: input.transform,
        analysis: analyzeDataset(derived.parsed),
      };
      const publish = async (): Promise<PublicDataset> => {
        if (source.projectId) await this.projects.resolveActiveProject(ownerId, String(source.projectId));
        return publicDataset(await this.persistWithFile(record, derived.buffer));
      };
      return source.projectId ? projectMutationLease.run(String(source.projectId), publish) : publish();
    });
  }

  async download(ownerIdValue: unknown, datasetIdValue: unknown): Promise<DatasetDownload> {
    const source = await this.requireRecord(ownerIdValue, datasetIdValue);
    return {
      buffer: await this.readVerified(source),
      fileName: source.originalName,
      mimeType: source.mimeType,
      sha256: source.sha256,
    };
  }

  async delete(ownerIdValue: unknown, datasetIdValue: unknown): Promise<void> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const datasetId = requireObjectId(datasetIdValue, 'Dataset id');
    await this.withMutation(datasetId, async () => {
      const record = await this.requireRecord(ownerId, datasetId);
      if (record.projectId) {
        try {
          await this.projects.resolveActiveProject(ownerId, String(record.projectId));
        } catch (error) {
          if (!(error instanceof ProjectError) || error.code !== 'PROJECT_NOT_FOUND') throw error;
        }
      }
      let childCount: number;
      try { childCount = await this.repository.countChildren(ownerId, datasetId); }
      catch { throw new DatasetServiceError('Dataset storage is unavailable.', 'DATASET_STORAGE_UNAVAILABLE', 503); }
      if (childCount > 0) {
        throw new DatasetServiceError(
          'Delete derived child datasets before deleting their parent.',
          'DATASET_HAS_DERIVED_CHILDREN',
          409
        );
      }
      const buffer = await this.readVerified(record);
      const remove = async (): Promise<void> => {
        if (record.projectId) {
          try {
            await this.projects.resolveActiveProject(ownerId, String(record.projectId));
          } catch (error) {
            if (!(error instanceof ProjectError) || error.code !== 'PROJECT_NOT_FOUND') throw error;
          }
        }
        await this.storage.remove(record.storageKey);
        try {
          const deleted = await this.repository.deleteByOwnerAndId(ownerId, datasetId);
          if (!deleted) {
            await this.storage.write(record.storageKey, buffer).catch(() => undefined);
            throw new DatasetServiceError('Dataset not found.', 'DATASET_NOT_FOUND', 404);
          }
        } catch (error) {
          if (error instanceof DatasetServiceError) throw error;
          await this.storage.write(record.storageKey, buffer).catch(() => undefined);
          throw new DatasetServiceError('Dataset storage is unavailable.', 'DATASET_STORAGE_UNAVAILABLE', 503);
        }
      };
      if (record.projectId) await projectMutationLease.run(String(record.projectId), remove);
      else await remove();
    });
  }

  private async requireRecord(ownerIdValue: unknown, datasetIdValue: unknown): Promise<DatasetRecord> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const datasetId = requireObjectId(datasetIdValue, 'Dataset id');
    let record: DatasetRecord | null;
    try { record = await this.repository.findByOwnerAndId(ownerId, datasetId); }
    catch { throw new DatasetServiceError('Dataset storage is unavailable.', 'DATASET_STORAGE_UNAVAILABLE', 503); }
    if (!record) throw new DatasetServiceError('Dataset not found.', 'DATASET_NOT_FOUND', 404);
    return record;
  }

  private async assertCapacity(ownerId: string): Promise<void> {
    let count: number;
    try { count = await this.repository.countByOwner(ownerId); }
    catch { throw new DatasetServiceError('Dataset storage is unavailable.', 'DATASET_STORAGE_UNAVAILABLE', 503); }
    if (count >= DATASET_OWNER_RETENTION) {
      throw new DatasetServiceError('The saved dataset limit has been reached.', 'DATASET_LIMIT_REACHED', 409);
    }
  }

  private async persistWithFile(record: DatasetCreateData, buffer: Buffer): Promise<DatasetRecord> {
    await this.storage.write(record.storageKey, buffer);
    try {
      return await this.repository.create(record);
    } catch {
      await this.storage.remove(record.storageKey).catch(() => undefined);
      throw new DatasetServiceError('Dataset storage is unavailable.', 'DATASET_STORAGE_UNAVAILABLE', 503);
    }
  }

  private async readVerified(record: DatasetRecord): Promise<Buffer> {
    const buffer = await this.storage.read(record.storageKey);
    if (buffer.length !== record.byteCount || checksum(buffer) !== record.sha256) {
      throw new DatasetServiceError('Dataset storage is unavailable.', 'DATASET_STORAGE_UNAVAILABLE', 503);
    }
    return buffer;
  }

  private async withMutation<T>(datasetId: string, action: () => Promise<T>): Promise<T> {
    if (this.activeMutations.has(datasetId)) {
      throw new DatasetServiceError('A dataset mutation is already active.', 'DATASET_MUTATION_ACTIVE', 409);
    }
    this.activeMutations.add(datasetId);
    try { return await action(); }
    finally { this.activeMutations.delete(datasetId); }
  }
}

export const datasetService = new DatasetService();
