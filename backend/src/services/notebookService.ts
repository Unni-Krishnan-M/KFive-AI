import { NOTEBOOK_LIMITS, NotebookCell, NotebookModel } from '@/models/Notebook';
import { ProjectError, ProjectService, projectService } from './projectService';
import { ProjectMutationLease, projectMutationLease } from './projectMutationLease';
import { NotebookRunModel } from '@/models/NotebookRun';
import { logger } from '@/utils/logger';

export type NotebookErrorCode =
  | 'INVALID_NOTEBOOK_ID' | 'INVALID_NOTEBOOK_INPUT' | 'NOTEBOOK_NOT_FOUND'
  | 'NOTEBOOK_REVISION_CONFLICT' | 'NOTEBOOK_REVISION_LIMIT_REACHED'
  | 'NOTEBOOK_LIMIT_REACHED' | 'NOTEBOOK_HAS_RUN_HISTORY' | 'NOTEBOOK_STORAGE_UNAVAILABLE';

export class NotebookError extends Error {
  readonly isOperational = true;
  constructor(message: string, readonly code: NotebookErrorCode, readonly statusCode: number) {
    super(message); this.name = 'NotebookError';
  }
}

export interface NotebookRecord {
  _id: unknown; ownerId: unknown; projectId?: unknown; title: string; cells: NotebookCell[];
  cellTimeoutSeconds: number; revision: number; createdAt?: Date; updatedAt?: Date;
}
export interface PublicNotebook {
  id: string; projectId?: string; title: string; cells: NotebookCell[]; cellTimeoutSeconds: number;
  revision: number; createdAt?: Date; updatedAt?: Date;
}
export interface PublicNotebookPage {
  notebooks: PublicNotebook[];
  pagination: { page: number; pageSize: 25; total: number; totalPages: number; maxPages: 10 };
}
interface NotebookCreateData {
  ownerId: string; projectId?: unknown; title: string; cells: NotebookCell[]; cellTimeoutSeconds: number; revision: 1;
}
interface NotebookUpdateData { title: string; cells: NotebookCell[]; cellTimeoutSeconds: number }
export interface NotebookRepository {
  list(ownerId: string, projectId: unknown, offset: number, limit: number): Promise<NotebookRecord[]>;
  countScope(ownerId: string, projectId?: unknown): Promise<number>;
  countAll(ownerId: string): Promise<number>;
  create(data: NotebookCreateData): Promise<NotebookRecord>;
  findByOwnerAndId(ownerId: string, notebookId: string): Promise<NotebookRecord | null>;
  updateByRevision(ownerId: string, notebookId: string, revision: number, changes: NotebookUpdateData): Promise<NotebookRecord | null>;
  deleteByRevision(ownerId: string, notebookId: string, revision: number): Promise<NotebookRecord | null>;
}
export interface NotebookRunHistory {
  exists(ownerId: string, notebookId: string): Promise<boolean>;
}
const mongooseNotebookRunHistory: NotebookRunHistory = {
  async exists(ownerId, notebookId) { return Boolean(await NotebookRunModel.exists({ ownerId, notebookId })); },
};

export const mongooseNotebookRepository: NotebookRepository = {
  async list(ownerId, projectId, offset, limit) {
    return NotebookModel.find({ ownerId, ...(projectId ? { projectId } : { projectId: { $exists: false } }) }).sort({ updatedAt: -1, _id: -1 })
      .skip(offset).limit(limit).lean() as unknown as Promise<NotebookRecord[]>;
  },
  async countScope(ownerId, projectId) {
    return NotebookModel.countDocuments({ ownerId, ...(projectId ? { projectId } : { projectId: { $exists: false } }) });
  },
  async countAll(ownerId) { return NotebookModel.countDocuments({ ownerId }); },
  async create(data) { return NotebookModel.create(data) as unknown as Promise<NotebookRecord>; },
  async findByOwnerAndId(ownerId, notebookId) {
    return NotebookModel.findOne({ _id: notebookId, ownerId }).lean() as unknown as Promise<NotebookRecord | null>;
  },
  async updateByRevision(ownerId, notebookId, revision, changes) {
    return NotebookModel.findOneAndUpdate({ _id: notebookId, ownerId, revision },
      { $set: changes, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean() as unknown as Promise<NotebookRecord | null>;
  },
  async deleteByRevision(ownerId, notebookId, revision) {
    return NotebookModel.findOneAndDelete({ _id: notebookId, ownerId, revision }).lean() as unknown as Promise<NotebookRecord | null>;
  },
};

const OBJECT_ID = /^[a-f\d]{24}$/i;
const CELL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TAG = /^[A-Za-z0-9_.:-]{1,64}$/;

function requireObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value))
    throw new NotebookError(`${label} is invalid.`, 'INVALID_NOTEBOOK_ID', 400);
  return value;
}
function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new NotebookError(`${label} must be a JSON object.`, 'INVALID_NOTEBOOK_INPUT', 400);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !(key in value)))
    throw new NotebookError('Notebook input keys do not match the supported contract.', 'INVALID_NOTEBOOK_INPUT', 400);
}
function unsafeText(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point === 0xfffd || /\p{Cf}/u.test(character)
      || (point < 32 && point !== 9 && point !== 10) || (point >= 127 && point <= 159);
  });
}
function title(value: unknown): string {
  if (typeof value !== 'string') throw new NotebookError('Notebook title must be a string.', 'INVALID_NOTEBOOK_INPUT', 400);
  const result = value.normalize('NFC').trim();
  if (!result || Buffer.byteLength(result, 'utf8') > NOTEBOOK_LIMITS.titleBytes || unsafeText(result))
    throw new NotebookError('Notebook title must contain 1 to 120 safe UTF-8 bytes.', 'INVALID_NOTEBOOK_INPUT', 400);
  return result;
}
function timeout(value: unknown): number {
  const result = value === undefined ? 10 : value;
  if (typeof result !== 'number' || !Number.isInteger(result) || result < 1 || result > NOTEBOOK_LIMITS.timeoutSeconds)
    throw new NotebookError('cellTimeoutSeconds must be an integer from 1 through 30.', 'INVALID_NOTEBOOK_INPUT', 400);
  return result;
}
export function normalizeNotebookCells(value: unknown): NotebookCell[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > NOTEBOOK_LIMITS.cells)
    throw new NotebookError('Notebook must contain 1 through 32 cells.', 'INVALID_NOTEBOOK_INPUT', 400);
  const ids = new Set<string>(); let total = 0;
  return value.map((item) => {
    const cell = plainObject(item, 'Notebook cell'); exactKeys(cell, ['id', 'type', 'source', 'tags'], ['id', 'type', 'source']);
    if (typeof cell.id !== 'string' || !CELL_ID.test(cell.id) || ids.has(cell.id))
      throw new NotebookError('Notebook cell ids must be safe and unique.', 'INVALID_NOTEBOOK_INPUT', 400);
    ids.add(cell.id);
    if (cell.type !== 'code' && cell.type !== 'markdown')
      throw new NotebookError("Notebook cell type must be 'code' or 'markdown'.", 'INVALID_NOTEBOOK_INPUT', 400);
    if (typeof cell.source !== 'string' || unsafeText(cell.source))
      throw new NotebookError('Notebook cell source must be safe UTF-8 text.', 'INVALID_NOTEBOOK_INPUT', 400);
    const sourceBytes = Buffer.byteLength(cell.source, 'utf8'); total += sourceBytes;
    if (sourceBytes > NOTEBOOK_LIMITS.cellSourceBytes || total > NOTEBOOK_LIMITS.totalSourceBytes)
      throw new NotebookError('Notebook source exceeds its UTF-8 byte limit.', 'INVALID_NOTEBOOK_INPUT', 400);
    const tags = cell.tags === undefined ? [] : cell.tags;
    if (!Array.isArray(tags) || tags.length > NOTEBOOK_LIMITS.tagsPerCell || tags.some((tag) => typeof tag !== 'string' || !TAG.test(tag))
      || new Set(tags).size !== tags.length)
      throw new NotebookError('Notebook cell tags are invalid or duplicated.', 'INVALID_NOTEBOOK_INPUT', 400);
    return { id: cell.id, type: cell.type, source: cell.source.normalize('NFC'), tags: [...tags] };
  });
}
function page(value: unknown): number {
  const result = value === undefined ? 1 : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isInteger(result) || result < 1 || result > NOTEBOOK_LIMITS.maxPages)
    throw new NotebookError('page must be an integer from 1 through 10.', 'INVALID_NOTEBOOK_INPUT', 400);
  return result;
}
function expectedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 999_999)
    throw new NotebookError('expectedRevision must be a positive integer.', 'INVALID_NOTEBOOK_INPUT', 400);
  return value;
}
function serialize(record: NotebookRecord): PublicNotebook {
  const cells = record.cells.map((cell) => ({
    id: String(cell.id), type: cell.type, source: String(cell.source), tags: Array.from(cell.tags ?? [], String),
  }));
  try {
    const normalizedTitle = title(record.title); const normalizedTimeout = timeout(record.cellTimeoutSeconds);
    const revision = expectedRevision(record.revision);
    return { id: String(record._id), ...(record.projectId ? { projectId: String(record.projectId) } : {}),
      title: normalizedTitle, cells: normalizeNotebookCells(cells), cellTimeoutSeconds: normalizedTimeout,
      revision, ...(record.createdAt ? { createdAt: record.createdAt } : {}),
      ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}) };
  } catch {
    throw new NotebookError('Notebook storage contains an invalid record.', 'NOTEBOOK_STORAGE_UNAVAILABLE', 503);
  }
}

export class NotebookService {
  constructor(
    private readonly repository: NotebookRepository = mongooseNotebookRepository,
    private readonly projects: ProjectService = projectService,
    private readonly lease: ProjectMutationLease = projectMutationLease,
    private readonly runHistory: NotebookRunHistory = mongooseNotebookRunHistory
  ) {}

  status() {
    return { editing: { available: true, persistent: true }, execution: { enabled: false, available: false,
      queueDurable: false, workerAvailable: false, isolationVerified: false,
      message: 'Notebook execution is unavailable until the disposable broker and trusted post-execution verifier are configured.' },
    limits: { cells: 32, sourceBytesPerCell: 65_536, sourceBytesPerNotebook: 262_144, cellTimeoutSeconds: 30 } };
  }
  async list(ownerValue: unknown, pageValue?: unknown, projectValue?: unknown): Promise<PublicNotebookPage> {
    const ownerId = requireObjectId(ownerValue, 'Owner id'); const currentPage = page(pageValue);
    const project = await this.projects.resolveOwnedProject(ownerId, projectValue);
    try {
      const [records, total] = await Promise.all([this.repository.list(ownerId, project?._id, (currentPage - 1) * 25, 25),
        this.repository.countScope(ownerId, project?._id)]);
      return { notebooks: records.map(serialize), pagination: { page: currentPage, pageSize: 25, total,
        totalPages: Math.max(1, Math.min(10, Math.ceil(total / 25))), maxPages: 10 } };
    } catch { throw new NotebookError('Notebook storage is unavailable.', 'NOTEBOOK_STORAGE_UNAVAILABLE', 503); }
  }
  async create(ownerValue: unknown, value: unknown): Promise<PublicNotebook> {
    const ownerId = requireObjectId(ownerValue, 'Owner id'); const input = plainObject(value, 'Notebook input');
    exactKeys(input, ['title', 'cells', 'cellTimeoutSeconds', 'projectId'], ['title', 'cells']);
    const projectId = input.projectId === undefined ? undefined : requireObjectId(input.projectId, 'Project id');
    return this.lease.run(`notebook-owner-${ownerId}`, async () => this.lease.run(projectId ?? `notebook-workspace-${ownerId}`, async () => {
      const project = await this.projects.resolveActiveProject(ownerId, projectId);
      try {
        if (await this.repository.countAll(ownerId) >= NOTEBOOK_LIMITS.retainedPerOwner)
          throw new NotebookError('The saved notebook limit has been reached.', 'NOTEBOOK_LIMIT_REACHED', 409);
        return serialize(await this.repository.create({ ownerId, ...(project ? { projectId: project._id } : {}),
          title: title(input.title), cells: normalizeNotebookCells(input.cells),
          cellTimeoutSeconds: timeout(input.cellTimeoutSeconds), revision: 1 }));
      } catch (error) {
        if (error instanceof NotebookError || error instanceof ProjectError) throw error;
        const details = error && typeof error === 'object' ? error as {
          name?: unknown; code?: unknown; errors?: unknown;
        } : undefined;
        const validationPaths = details?.errors && typeof details.errors === 'object'
          ? Object.keys(details.errors).slice(0, 16) : undefined;
        logger.error('Notebook storage create failed', {
          operation: 'create',
          errorName: typeof details?.name === 'string' ? details.name : 'unknown',
          ...(typeof details?.code === 'string' || typeof details?.code === 'number' ? { code: details.code } : {}),
          ...(validationPaths?.length ? { validationPaths } : {}),
        });
        throw new NotebookError('Notebook storage is unavailable.', 'NOTEBOOK_STORAGE_UNAVAILABLE', 503);
      }
    }));
  }
  async get(ownerValue: unknown, notebookValue: unknown): Promise<PublicNotebook> { return serialize(await this.record(ownerValue, notebookValue)); }
  async update(ownerValue: unknown, notebookValue: unknown, value: unknown): Promise<PublicNotebook> {
    const ownerId = requireObjectId(ownerValue, 'Owner id'); const notebookId = requireObjectId(notebookValue, 'Notebook id');
    const input = plainObject(value, 'Notebook update');
    exactKeys(input, ['title', 'cells', 'cellTimeoutSeconds', 'expectedRevision'], ['title', 'cells', 'expectedRevision']);
    const current = await this.record(ownerId, notebookId); const revision = expectedRevision(input.expectedRevision);
    if (current.revision === 999_999 && revision === 999_999)
      throw new NotebookError('Notebook revision limit reached. Save the draft as a new notebook.', 'NOTEBOOK_REVISION_LIMIT_REACHED', 409);
    return this.lease.run(current.projectId ? String(current.projectId) : `owner-${ownerId}`, async () => {
      await this.projects.resolveActiveProject(ownerId, current.projectId ? String(current.projectId) : undefined);
      let updated: NotebookRecord | null;
      try { updated = await this.repository.updateByRevision(ownerId, notebookId, revision,
        { title: title(input.title), cells: normalizeNotebookCells(input.cells), cellTimeoutSeconds: timeout(input.cellTimeoutSeconds) }); }
      catch { throw new NotebookError('Notebook storage is unavailable.', 'NOTEBOOK_STORAGE_UNAVAILABLE', 503); }
      if (!updated) {
        let latest: NotebookRecord | null;
        try { latest = await this.repository.findByOwnerAndId(ownerId, notebookId); }
        catch { throw new NotebookError('Notebook storage is unavailable.', 'NOTEBOOK_STORAGE_UNAVAILABLE', 503); }
        if (!latest) throw new NotebookError('Notebook not found.', 'NOTEBOOK_NOT_FOUND', 404);
        throw new NotebookError('Notebook changed since it was opened. Reload before saving.', 'NOTEBOOK_REVISION_CONFLICT', 409);
      }
      return serialize(updated);
    });
  }
  async delete(ownerValue: unknown, notebookValue: unknown, value: unknown) {
    const ownerId = requireObjectId(ownerValue, 'Owner id'); const notebookId = requireObjectId(notebookValue, 'Notebook id');
    const input = plainObject(value, 'Notebook deletion');
    exactKeys(input, ['expectedRevision'], ['expectedRevision']);
    const current = await this.record(ownerId, notebookId); const revision = expectedRevision(input.expectedRevision);
    return this.lease.run(current.projectId ? String(current.projectId) : `owner-${ownerId}`, async () => {
      await this.projects.resolveActiveProject(ownerId, current.projectId ? String(current.projectId) : undefined);
      try {
        if (await this.runHistory.exists(ownerId, notebookId))
          throw new NotebookError('Delete retained notebook runs before deleting this notebook.', 'NOTEBOOK_HAS_RUN_HISTORY', 409);
      } catch (error) {
        if (error instanceof NotebookError) throw error;
        throw new NotebookError('Notebook run history could not be checked.', 'NOTEBOOK_STORAGE_UNAVAILABLE', 503);
      }
      let deleted: NotebookRecord | null;
      try { deleted = await this.repository.deleteByRevision(ownerId, notebookId, revision); }
      catch { throw new NotebookError('Notebook storage is unavailable.', 'NOTEBOOK_STORAGE_UNAVAILABLE', 503); }
      if (!deleted) {
        let latest: NotebookRecord | null;
        try { latest = await this.repository.findByOwnerAndId(ownerId, notebookId); }
        catch { throw new NotebookError('Notebook storage is unavailable.', 'NOTEBOOK_STORAGE_UNAVAILABLE', 503); }
        if (!latest) throw new NotebookError('Notebook not found.', 'NOTEBOOK_NOT_FOUND', 404);
        throw new NotebookError('Notebook changed since it was opened. Reload before deleting.', 'NOTEBOOK_REVISION_CONFLICT', 409);
      }
      return { notebookId, deleted: true as const };
    });
  }
  private async record(ownerValue: unknown, notebookValue: unknown): Promise<NotebookRecord> {
    const ownerId = requireObjectId(ownerValue, 'Owner id'); const notebookId = requireObjectId(notebookValue, 'Notebook id');
    let result: NotebookRecord | null;
    try { result = await this.repository.findByOwnerAndId(ownerId, notebookId); }
    catch { throw new NotebookError('Notebook storage is unavailable.', 'NOTEBOOK_STORAGE_UNAVAILABLE', 503); }
    if (!result) throw new NotebookError('Notebook not found.', 'NOTEBOOK_NOT_FOUND', 404);
    return result;
  }
}

export const notebookService = new NotebookService();
