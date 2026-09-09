import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { getEnvironment } from '@/config/environment';
import { NOTEBOOK_RUN_LIMITS, NotebookRunModel, NotebookRunStatus } from '@/models/NotebookRun';
import { NotebookCell } from '@/models/Notebook';
import { ProjectService, projectService } from './projectService';
import { NotebookService, notebookService } from './notebookService';
import { NotebookQueueDispatcher, notebookJobId, notebookQueueDispatcher } from './notebookQueue';
import { ProjectMutationLease, projectMutationLease } from './projectMutationLease';

export type NotebookRunErrorCode =
  | 'INVALID_NOTEBOOK_RUN_INPUT'
  | 'NOTEBOOK_RUN_NOT_FOUND'
  | 'NOTEBOOK_RUN_CONFLICT'
  | 'NOTEBOOK_RUN_BUSY'
  | 'NOTEBOOK_RUN_LIMIT_REACHED'
  | 'NOTEBOOK_EXECUTION_UNAVAILABLE'
  | 'NOTEBOOK_RUN_STORAGE_UNAVAILABLE'
  | 'NOTEBOOK_RUN_QUEUE_UNAVAILABLE';

export class NotebookRunError extends Error {
  readonly isOperational = true;
  constructor(message: string, readonly code: NotebookRunErrorCode, readonly statusCode: number) {
    super(message); this.name = 'NotebookRunError';
  }
}

export interface NotebookRunRecord {
  _id: unknown;
  ownerId: unknown;
  notebookId: unknown;
  projectId?: unknown;
  notebookRevision: number;
  snapshotSha256: string;
  cells: NotebookCell[];
  cellTimeoutSeconds: number;
  jobId: string;
  status: NotebookRunStatus;
  activeOwnerSlot?: boolean;
  revision: number;
  executedNotebookJson?: string;
  metrics?: Array<{ name: string; value: number; step?: number }>;
  artifacts?: Array<{ path: string; kind: string; mimeType: string; bytes: number; sha256: string; data?: Buffer }>;
  result?: { durationMs?: number; runtimeImageId?: string; verifierImageId?: string };
  error?: { code?: string; message?: string; cellIndex?: number };
  timeline: Array<{ revision: number; sequence: number; type: string; timestamp: Date; code?: string }>;
  queuedAt: Date;
  startedAt?: Date;
  verificationStartedAt?: Date;
  cancelRequestedAt?: Date;
  completedAt?: Date;
  execution?: { workerId?: string; heartbeatAt?: Date; runtimeContainerId?: string };
  createdAt?: Date;
  updatedAt?: Date;
}

interface NotebookRunCreateData extends Omit<NotebookRunRecord, '_id' | 'createdAt' | 'updatedAt'> { _id: string }
export interface NotebookRunRepository {
  countAll(ownerId: string): Promise<number>;
  create(data: NotebookRunCreateData): Promise<NotebookRunRecord>;
  list(ownerId: string, notebookId: string, offset: number, limit: number): Promise<NotebookRunRecord[]>;
  countNotebook(ownerId: string, notebookId: string): Promise<number>;
  findOwned(ownerId: string, notebookId: string, runId: string): Promise<NotebookRunRecord | null>;
  cancelQueued(ownerId: string, notebookId: string, runId: string, at: Date): Promise<NotebookRunRecord | null>;
  requestCancel(ownerId: string, notebookId: string, runId: string, at: Date): Promise<NotebookRunRecord | null>;
  markEnqueueFailure(ownerId: string, runId: string, at: Date): Promise<void>;
  deleteTerminal(ownerId: string, notebookId: string, runId: string): Promise<NotebookRunRecord | null>;
  recoverStale(cutoff: Date, at: Date): Promise<number>;
}

const terminal: NotebookRunStatus[] = ['succeeded', 'failed', 'cancelled', 'timed_out', 'resource_exceeded', 'interrupted'];

export const mongooseNotebookRunRepository: NotebookRunRepository = {
  async countAll(ownerId) { return NotebookRunModel.countDocuments({ ownerId }); },
  async create(data) { return NotebookRunModel.create(data) as unknown as Promise<NotebookRunRecord>; },
  async list(ownerId, notebookId, offset, limit) {
    return NotebookRunModel.find({ ownerId, notebookId }).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit)
      .select('-cells -executedNotebookJson -artifacts.data').lean() as unknown as Promise<NotebookRunRecord[]>;
  },
  async countNotebook(ownerId, notebookId) { return NotebookRunModel.countDocuments({ ownerId, notebookId }); },
  async findOwned(ownerId, notebookId, runId) {
    return NotebookRunModel.findOne({ _id: runId, ownerId, notebookId }).lean() as unknown as Promise<NotebookRunRecord | null>;
  },
  async cancelQueued(ownerId, notebookId, runId, at) {
    return NotebookRunModel.findOneAndUpdate(
      { _id: runId, ownerId, notebookId, status: 'queued', activeOwnerSlot: true },
      {
        $set: { status: 'cancelled', activeOwnerSlot: false, cancelRequestedAt: at, completedAt: at },
        $inc: { revision: 1 },
        $push: { timeline: { revision: 2, sequence: 2, type: 'cancelled', timestamp: at } },
      },
      { new: true, runValidators: true }
    ).lean() as unknown as Promise<NotebookRunRecord | null>;
  },
  async requestCancel(ownerId, notebookId, runId, at) {
    const current = await NotebookRunModel.findOne({ _id: runId, ownerId, notebookId,
      status: { $in: ['running', 'verifying'] }, activeOwnerSlot: true }).lean() as unknown as NotebookRunRecord | null;
    if (!current) return null;
    return NotebookRunModel.findOneAndUpdate(
      { _id: runId, ownerId, notebookId, status: current.status, activeOwnerSlot: true, revision: current.revision },
      {
        $set: { status: 'cancel-requested', cancelRequestedAt: at },
        $inc: { revision: 1 },
        $push: { timeline: { revision: current.revision + 1, sequence: current.timeline.length + 1,
          type: 'cancel_requested', timestamp: at } },
      },
      { new: true, runValidators: true }
    ).lean() as unknown as Promise<NotebookRunRecord | null>;
  },
  async markEnqueueFailure(ownerId, runId, at) {
    await NotebookRunModel.updateOne(
      { _id: runId, ownerId, status: 'queued', activeOwnerSlot: true },
      {
        $set: { status: 'interrupted', activeOwnerSlot: false, completedAt: at,
          error: { code: 'NOTEBOOK_QUEUE_UNAVAILABLE', message: 'Notebook execution could not be queued.' } },
        $inc: { revision: 1 },
        $push: { timeline: { revision: 2, sequence: 2, type: 'interrupted', timestamp: at, code: 'NOTEBOOK_QUEUE_UNAVAILABLE' } },
      },
      { runValidators: true }
    );
  },
  async deleteTerminal(ownerId, notebookId, runId) {
    return NotebookRunModel.findOneAndDelete({ _id: runId, ownerId, notebookId, status: { $in: terminal }, activeOwnerSlot: false })
      .lean() as unknown as Promise<NotebookRunRecord | null>;
  },
  async recoverStale(cutoff, at) {
    const records = await NotebookRunModel.find({ status: { $in: ['running', 'verifying', 'cancel-requested'] },
      activeOwnerSlot: true, $or: [{ 'execution.heartbeatAt': { $lt: cutoff } },
        { 'execution.heartbeatAt': { $exists: false }, updatedAt: { $lt: cutoff } }] }).limit(100).lean() as unknown as NotebookRunRecord[];
    let recovered = 0;
    for (const current of records) {
      const updated = await NotebookRunModel.updateOne(
        { _id: current._id, status: current.status, activeOwnerSlot: true, revision: current.revision },
        { $set: { status: 'interrupted', activeOwnerSlot: false, completedAt: at,
          error: { code: 'NOTEBOOK_WORKER_LOST', message: 'Notebook execution was interrupted safely.' } },
        $unset: { 'execution.runtimeContainerId': 1 }, $inc: { revision: 1 },
        $push: { timeline: { revision: current.revision + 1, sequence: current.timeline.length + 1,
          type: 'interrupted', timestamp: at, code: 'NOTEBOOK_WORKER_LOST' } } }, { runValidators: true });
      recovered += updated.modifiedCount;
    }
    return recovered;
  },
};

const OBJECT_ID = /^[a-f\d]{24}$/i;
function objectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value))
    throw new NotebookRunError(`${label} is invalid.`, 'INVALID_NOTEBOOK_RUN_INPUT', 400);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new NotebookRunError('Notebook run input must be a JSON object.', 'INVALID_NOTEBOOK_RUN_INPUT', 400);
  return value as Record<string, unknown>;
}
function exactExpectedRevision(value: unknown): number {
  const input = object(value);
  if (Object.keys(input).length !== 1 || !('expectedRevision' in input)
    || typeof input.expectedRevision !== 'number' || !Number.isInteger(input.expectedRevision)
    || input.expectedRevision < 1 || input.expectedRevision > 999_999)
    throw new NotebookRunError('Notebook run input must contain only a valid expectedRevision.', 'INVALID_NOTEBOOK_RUN_INPUT', 400);
  return input.expectedRevision;
}
function page(value: unknown): number {
  const result = value === undefined ? 1 : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isInteger(result) || result < 1 || result > NOTEBOOK_RUN_LIMITS.maxPages)
    throw new NotebookRunError('page must be an integer from 1 through 10.', 'INVALID_NOTEBOOK_RUN_INPUT', 400);
  return result;
}
function snapshotHash(notebook: { revision: number; cells: NotebookCell[]; cellTimeoutSeconds: number }): string {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: 'kfive.notebook-snapshot.v1', revision: notebook.revision,
    cellTimeoutSeconds: notebook.cellTimeoutSeconds, cells: notebook.cells,
  })).digest('hex');
}

export interface PublicNotebookRun {
  id: string;
  notebookId: string;
  projectId?: string;
  notebookRevision: number;
  snapshotSha256: string;
  status: NotebookRunStatus;
  revision: number;
  metrics: Array<{ name: string; value: number; step?: number }>;
  artifacts: Array<{ index: number; path: string; kind: string; mimeType: string; bytes: number; sha256: string }>;
  result?: NotebookRunRecord['result'];
  error?: NotebookRunRecord['error'];
  timeline: NotebookRunRecord['timeline'];
  queuedAt: Date;
  startedAt?: Date;
  verificationStartedAt?: Date;
  cancelRequestedAt?: Date;
  completedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  executedNotebook?: unknown;
  snapshot?: { cells: NotebookCell[]; cellTimeoutSeconds: number };
}

function serialize(record: NotebookRunRecord, detail = false): PublicNotebookRun {
  let executedNotebook: unknown;
  if (detail && record.status === 'succeeded') {
    if (typeof record.executedNotebookJson !== 'string')
      throw new NotebookRunError('Notebook run output is unavailable.', 'NOTEBOOK_RUN_STORAGE_UNAVAILABLE', 503);
    try { executedNotebook = JSON.parse(record.executedNotebookJson); }
    catch { throw new NotebookRunError('Notebook run output is invalid.', 'NOTEBOOK_RUN_STORAGE_UNAVAILABLE', 503); }
  }
  return {
    id: String(record._id), notebookId: String(record.notebookId),
    ...(record.projectId ? { projectId: String(record.projectId) } : {}),
    notebookRevision: record.notebookRevision, snapshotSha256: record.snapshotSha256,
    status: record.status, revision: record.revision, metrics: record.metrics ?? [],
    artifacts: (record.artifacts ?? []).map((artifact, index) => ({ index, path: artifact.path, kind: artifact.kind,
      mimeType: artifact.mimeType, bytes: artifact.bytes, sha256: artifact.sha256 })),
    ...(record.result ? { result: record.result } : {}), ...(record.error?.code ? { error: record.error } : {}),
    timeline: record.timeline, queuedAt: record.queuedAt,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.verificationStartedAt ? { verificationStartedAt: record.verificationStartedAt } : {}),
    ...(record.cancelRequestedAt ? { cancelRequestedAt: record.cancelRequestedAt } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.createdAt ? { createdAt: record.createdAt } : {}), ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    ...(executedNotebook !== undefined ? { executedNotebook } : {}),
    ...(detail ? { snapshot: { cells: record.cells, cellTimeoutSeconds: record.cellTimeoutSeconds } } : {}),
  };
}

export class NotebookRunService {
  constructor(
    private readonly repository: NotebookRunRepository = mongooseNotebookRunRepository,
    private readonly notebooks: NotebookService = notebookService,
    private readonly projects: ProjectService = projectService,
    private readonly queue: NotebookQueueDispatcher = notebookQueueDispatcher,
    private readonly lease: ProjectMutationLease = projectMutationLease,
    private readonly now: () => Date = () => new Date(),
    private readonly enabled: () => boolean = () => getEnvironment().notebookExecutionEnabled,
    private readonly newId: () => string = () => new Types.ObjectId().toHexString()
  ) {}

  async status() {
    if (!this.enabled()) return { editing: { available: true, persistent: true }, execution: {
      enabled: false, available: false, queueDurable: false, workerAvailable: false, isolationVerified: false,
      message: 'Notebook execution is disabled. Configure the trusted broker and verified runtime images to enable it.',
    }, limits: { cells: 32, sourceBytesPerCell: 65_536, sourceBytesPerNotebook: 262_144, cellTimeoutSeconds: 30 } };
    try {
      const worker = await this.queue.executionStatus();
      const available = worker.workerAvailable && worker.isolationVerified;
      return { editing: { available: true, persistent: true }, execution: {
        enabled: true, available, queueDurable: true, workerAvailable: worker.workerAvailable,
        isolationVerified: worker.isolationVerified,
        message: available ? 'Notebook execution is available through the isolated broker and verifier.'
          : worker.workerAvailable ? 'Notebook worker is online, but its isolation self-check is not verified.'
            : 'Notebook execution is enabled, but the trusted worker is offline.',
      }, limits: { cells: 32, sourceBytesPerCell: 65_536, sourceBytesPerNotebook: 262_144, cellTimeoutSeconds: 30 } };
    } catch {
      return { editing: { available: true, persistent: true }, execution: {
        enabled: true, available: false, queueDurable: false, workerAvailable: false, isolationVerified: false,
        message: 'Notebook execution queue status is unavailable.',
      }, limits: { cells: 32, sourceBytesPerCell: 65_536, sourceBytesPerNotebook: 262_144, cellTimeoutSeconds: 30 } };
    }
  }

  async list(ownerValue: unknown, notebookValue: unknown, pageValue?: unknown) {
    const ownerId = objectId(ownerValue, 'Owner id'); const notebookId = objectId(notebookValue, 'Notebook id');
    await this.notebooks.get(ownerId, notebookId);
    const currentPage = page(pageValue);
    try {
      const [records, total] = await Promise.all([
        this.repository.list(ownerId, notebookId, (currentPage - 1) * NOTEBOOK_RUN_LIMITS.pageSize, NOTEBOOK_RUN_LIMITS.pageSize),
        this.repository.countNotebook(ownerId, notebookId),
      ]);
      return { runs: records.map((record) => serialize(record)), pagination: { page: currentPage,
        pageSize: 25 as const, total, totalPages: Math.max(1, Math.min(10, Math.ceil(total / 25))), maxPages: 10 as const } };
    } catch (error) {
      if (error instanceof NotebookRunError) throw error;
      throw new NotebookRunError('Notebook run storage is unavailable.', 'NOTEBOOK_RUN_STORAGE_UNAVAILABLE', 503);
    }
  }

  async get(ownerValue: unknown, notebookValue: unknown, runValue: unknown): Promise<PublicNotebookRun> {
    return serialize(await this.record(ownerValue, notebookValue, runValue), true);
  }

  async start(ownerValue: unknown, notebookValue: unknown, value: unknown): Promise<PublicNotebookRun> {
    const ownerId = objectId(ownerValue, 'Owner id'); const notebookId = objectId(notebookValue, 'Notebook id');
    const expectedRevision = exactExpectedRevision(value);
    const status = await this.status();
    if (!status.execution.available)
      throw new NotebookRunError(status.execution.message, 'NOTEBOOK_EXECUTION_UNAVAILABLE', 503);
    return this.lease.run(`notebook-run-owner-${ownerId}`, async () => {
      const notebook = await this.notebooks.get(ownerId, notebookId);
      if (notebook.revision !== expectedRevision)
        throw new NotebookRunError('Notebook changed since this run was requested. Save or reload before running.', 'NOTEBOOK_RUN_CONFLICT', 409);
      await this.projects.resolveActiveProject(ownerId, notebook.projectId);
      const runId = this.newId(); const at = this.now();
      let created: NotebookRunRecord;
      try {
        if (await this.repository.countAll(ownerId) >= NOTEBOOK_RUN_LIMITS.retainedPerOwner)
          throw new NotebookRunError('The retained notebook run limit has been reached.', 'NOTEBOOK_RUN_LIMIT_REACHED', 409);
        created = await this.repository.create({
          _id: runId, ownerId, notebookId, ...(notebook.projectId ? { projectId: notebook.projectId } : {}),
          notebookRevision: notebook.revision, snapshotSha256: snapshotHash(notebook), cells: notebook.cells,
          cellTimeoutSeconds: notebook.cellTimeoutSeconds, jobId: notebookJobId(runId), status: 'queued',
          activeOwnerSlot: true, revision: 1, metrics: [], artifacts: [],
          timeline: [{ revision: 1, sequence: 1, type: 'created', timestamp: at }], queuedAt: at,
        });
      } catch (error) {
        if (error instanceof NotebookRunError) throw error;
        if ((error as { code?: number })?.code === 11000)
          throw new NotebookRunError('Another notebook run is already active for this owner.', 'NOTEBOOK_RUN_BUSY', 409);
        throw new NotebookRunError('Notebook run storage is unavailable.', 'NOTEBOOK_RUN_STORAGE_UNAVAILABLE', 503);
      }
      try { await this.queue.enqueue(runId); }
      catch {
        await this.repository.markEnqueueFailure(ownerId, runId, this.now()).catch(() => undefined);
        throw new NotebookRunError('Notebook execution queue is unavailable.', 'NOTEBOOK_RUN_QUEUE_UNAVAILABLE', 503);
      }
      return serialize(created, true);
    });
  }

  async cancel(ownerValue: unknown, notebookValue: unknown, runValue: unknown) {
    const ownerId = objectId(ownerValue, 'Owner id'); const notebookId = objectId(notebookValue, 'Notebook id');
    const runId = objectId(runValue, 'Run id'); const current = await this.record(ownerId, notebookId, runId);
    if (terminal.includes(current.status)) return { run: serialize(current, true), idempotent: true };
    if (current.status === 'cancel-requested') return { run: serialize(current, true), idempotent: true };
    const at = this.now();
    if (current.status === 'queued') {
      const cancelled = await this.repository.cancelQueued(ownerId, notebookId, runId, at);
      if (cancelled) {
        await this.queue.remove(runId).catch(() => undefined);
        return { run: serialize(cancelled, true), idempotent: false };
      }
    }
    const requested = await this.repository.requestCancel(ownerId, notebookId, runId, at);
    if (requested) {
      await this.queue.wakeCancellation(runId).catch(() => undefined);
      return { run: serialize(requested, true), idempotent: false };
    }
    const latest = await this.record(ownerId, notebookId, runId);
    if (terminal.includes(latest.status) || latest.status === 'cancel-requested')
      return { run: serialize(latest, true), idempotent: true };
    throw new NotebookRunError('Notebook run changed while cancellation was requested.', 'NOTEBOOK_RUN_CONFLICT', 409);
  }

  async delete(ownerValue: unknown, notebookValue: unknown, runValue: unknown) {
    const ownerId = objectId(ownerValue, 'Owner id'); const notebookId = objectId(notebookValue, 'Notebook id');
    const runId = objectId(runValue, 'Run id');
    const deleted = await this.repository.deleteTerminal(ownerId, notebookId, runId);
    if (deleted) return { runId, deleted: true as const };
    const current = await this.record(ownerId, notebookId, runId);
    if (!terminal.includes(current.status))
      throw new NotebookRunError('Active notebook runs cannot be deleted.', 'NOTEBOOK_RUN_CONFLICT', 409);
    throw new NotebookRunError('Notebook run changed while deletion was requested.', 'NOTEBOOK_RUN_CONFLICT', 409);
  }

  async recoverInterrupted(staleMs = 120_000): Promise<number> {
    const at = this.now();
    if (!Number.isSafeInteger(staleMs) || staleMs < 30_000 || staleMs > 3_600_000)
      throw new NotebookRunError('Notebook recovery interval is invalid.', 'INVALID_NOTEBOOK_RUN_INPUT', 400);
    try { return await this.repository.recoverStale(new Date(at.getTime() - staleMs), at); }
    catch { throw new NotebookRunError('Notebook run recovery is unavailable.', 'NOTEBOOK_RUN_STORAGE_UNAVAILABLE', 503); }
  }

  private async record(ownerValue: unknown, notebookValue: unknown, runValue: unknown): Promise<NotebookRunRecord> {
    const ownerId = objectId(ownerValue, 'Owner id'); const notebookId = objectId(notebookValue, 'Notebook id');
    const runId = objectId(runValue, 'Run id');
    try {
      const result = await this.repository.findOwned(ownerId, notebookId, runId);
      if (!result) throw new NotebookRunError('Notebook run not found.', 'NOTEBOOK_RUN_NOT_FOUND', 404);
      return result;
    } catch (error) {
      if (error instanceof NotebookRunError) throw error;
      throw new NotebookRunError('Notebook run storage is unavailable.', 'NOTEBOOK_RUN_STORAGE_UNAVAILABLE', 503);
    }
  }
}

export const notebookRunService = new NotebookRunService();
