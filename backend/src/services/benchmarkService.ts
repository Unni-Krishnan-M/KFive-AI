import { BenchmarkRunModel, BenchmarkRunStatus, BenchmarkTimelineType } from '@/models/BenchmarkRun';
import { ProjectModel } from '@/models/Project';
import { AiModel, AiProviderClient, AiUsage } from '@/services/ai/types';
import { withProviderDiscoveryDeadline } from '@/services/ai/providerDeadline';
import { getAiProvider } from '@/services/aiProvider';
import { ProjectError, ProjectService, projectService } from './projectService';
import { ProjectMutationLease, projectMutationLease } from './projectMutationLease';
import { BenchmarkQueueDispatcher, benchmarkJobId, benchmarkQueueDispatcher } from './benchmarkQueue';
import { GpuStatus, GpuUnavailableReason } from './gpuStatus';

export const BENCHMARK_LIMITS = Object.freeze({
  repetitions: 2, calls: 6, outputBytesPerCall: 16 * 1024, outputBytesPerRun: 128 * 1024,
  timeoutMs: 180_000, retentionPerOwner: 100, pageSize: 25, maxPages: 10, timeline: 50,
  revision: 1_000_000, globalConcurrency: 1, ownerConcurrency: 1,
});
export const CHAT_CORE_PROMPTS = Object.freeze([
  'In one sentence, explain why clear variable names help software maintenance.',
  'List three practical ways to make a team meeting more effective.',
  'Write a friendly two-sentence reminder to drink water during the day.',
] as const);
export const CHAT_CORE_SUITE = Object.freeze({
  id: 'chat-core-v1' as const, title: 'Chat Core', version: 1 as const, promptCount: 3 as const,
  repetitions: 2 as const, totalCalls: 6 as const,
  parameters: Object.freeze({ maxOutputTokens: 128 as const, temperature: 0 as const, topP: 1 as const }),
});

export type BenchmarkRunErrorCode =
  | 'INVALID_BENCHMARK_INPUT' | 'BENCHMARK_RUN_NOT_FOUND' | 'BENCHMARK_BUSY' | 'BENCHMARK_CONFLICT'
  | 'BENCHMARK_LIMIT_REACHED' | 'BENCHMARK_STORAGE_UNAVAILABLE' | 'BENCHMARK_QUEUE_UNAVAILABLE'
  | 'BENCHMARK_PROVIDER_UNAVAILABLE' | 'BENCHMARK_MODEL_NOT_FOUND' | 'BENCHMARK_MODEL_UNSUPPORTED'
  | 'BENCHMARK_TIMEOUT' | 'BENCHMARK_EXECUTION_FAILED' | 'BENCHMARK_OUTPUT_LIMIT' | 'BENCHMARK_INTERRUPTED';

export class BenchmarkRunError extends Error {
  readonly isOperational = true;
  constructor(message: string, readonly code: BenchmarkRunErrorCode, readonly statusCode: number) {
    super(message); this.name = 'BenchmarkRunError';
  }
}

export interface BenchmarkModelIdentity { id: string; digest?: string; sizeBytes?: number; contextWindow?: number }
export interface BenchmarkCallResult {
  callIndex: number; promptIndex: number; repetition: number; promptLength: number; passed: boolean;
  output: string; outputBytes: number; durationMs: number; ttftMs?: number; provider: string; model: string;
  usage?: AiUsage; finishReason?: 'stop' | 'length' | 'error' | 'unknown'; error?: { code: string; message: string };
}
export interface BenchmarkGpuSnapshot {
  available: boolean; reason?: GpuUnavailableReason; sampledAt: string;
  devices: Array<{ index: number; name: string; driverVersion: string; memoryTotalMiB: number; memoryUsedMiB: number;
    memoryFreeMiB: number; utilizationPercent: number; temperatureC: number }>;
  summary?: { deviceCount: number; totalVramMiB: number; usedVramMiB: number; freeVramMiB: number };
}
export interface BenchmarkTimeline {
  revision: number; sequence: number; type: BenchmarkTimelineType; timestamp: Date; callIndex?: number;
  provider?: string; model?: string; code?: string;
}
export interface BenchmarkAggregate {
  passCount: number; totalCalls: 6; medianTtftMs?: number; medianDurationMs: number;
  medianOutputBytes: number; outputTokens?: number; outputTokensPerSecond?: number;
}
export interface BenchmarkRunRecord {
  _id: unknown; ownerId: unknown; projectId?: unknown; jobId: string; activeOwnerSlot?: boolean; revision: number;
  suite: { id: 'chat-core-v1'; version: 1; promptCount: 3; repetitions: 2; totalCalls: 6 };
  provider?: string; model: { requested: BenchmarkModelIdentity; actual?: BenchmarkModelIdentity }; status: BenchmarkRunStatus;
  results: BenchmarkCallResult[]; completedCalls: number; passedCalls: number; outputBytes: number;
  wallDurationMs?: number; aggregate?: BenchmarkAggregate; gpu?: { before?: BenchmarkGpuSnapshot; after?: BenchmarkGpuSnapshot };
  error?: { code?: string; message?: string }; timeline: BenchmarkTimeline[]; queuedAt: Date; startedAt?: Date;
  cancelRequestedAt?: Date; completedAt?: Date;
  execution?: { fence?: number; leaseOwner?: string; heartbeatAt?: Date; inFlightCallIndex?: number };
  createdAt?: Date; updatedAt?: Date;
}
export type BenchmarkRunCreateData = Omit<BenchmarkRunRecord, '_id' | 'createdAt' | 'updatedAt'> & { _id?: string };
export type BenchmarkRunChanges = Partial<Omit<BenchmarkRunRecord, '_id' | 'ownerId' | 'projectId' | 'suite' | 'queuedAt' | 'timeline' | 'revision' | 'jobId'>>;
export interface BenchmarkRunRepository {
  create(value: BenchmarkRunCreateData): Promise<BenchmarkRunRecord>;
  list(ownerId: string, projectId: string | undefined, offset: number, limit: number): Promise<BenchmarkRunRecord[]>;
  count(ownerId: string, projectId?: string): Promise<number>;
  countInScope(ownerId: string, projectId?: string): Promise<number>;
  findByOwnerAndId(ownerId: string, runId: string): Promise<BenchmarkRunRecord | null>;
  findActive(): Promise<BenchmarkRunRecord[]>;
  deleteTerminalByOwnerAndId(ownerId: string, runId: string): Promise<BenchmarkRunRecord | null>;
  transition(ownerId: string, runId: string, allowed: BenchmarkRunStatus[], changes: BenchmarkRunChanges,
    events?: Array<Omit<BenchmarkTimeline, 'revision'>>): Promise<BenchmarkRunRecord | null>;
  reconcileDeletedProjects(completedAt: Date): Promise<{ interrupted: number; deleted: number; runIds: string[] }>;
}
export const TERMINAL_BENCHMARK_STATUSES = new Set<BenchmarkRunStatus>([
  'succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted',
]);
export const ACTIVE_BENCHMARK_STATUSES = ['queued', 'running', 'cancel-requested'] satisfies BenchmarkRunStatus[];

export function benchmarkListFilter(ownerId: string, projectId?: string): Record<string, unknown> {
  return projectId
    ? { ownerId, projectId }
    : { ownerId, projectId: { $exists: false } };
}

export const mongooseBenchmarkRunRepository: BenchmarkRunRepository = {
  async create(value) { return BenchmarkRunModel.create(value) as unknown as Promise<BenchmarkRunRecord>; },
  async list(ownerId, projectId, offset, limit) {
    return BenchmarkRunModel.find(benchmarkListFilter(ownerId, projectId)).sort({ createdAt: -1, _id: -1 })
      .skip(offset).limit(limit).lean() as unknown as Promise<BenchmarkRunRecord[]>;
  },
  async count(ownerId, projectId) { return BenchmarkRunModel.countDocuments({ ownerId, ...(projectId ? { projectId } : {}) }); },
  async countInScope(ownerId, projectId) { return BenchmarkRunModel.countDocuments(benchmarkListFilter(ownerId, projectId)); },
  async findByOwnerAndId(ownerId, runId) {
    return BenchmarkRunModel.findOne({ _id: runId, ownerId }).lean() as unknown as Promise<BenchmarkRunRecord | null>;
  },
  async findActive() {
    return BenchmarkRunModel.find({ status: { $in: ACTIVE_BENCHMARK_STATUSES } }).lean() as unknown as Promise<BenchmarkRunRecord[]>;
  },
  async deleteTerminalByOwnerAndId(ownerId, runId) {
    return BenchmarkRunModel.findOneAndDelete({ _id: runId, ownerId, status: { $in: [...TERMINAL_BENCHMARK_STATUSES] } })
      .lean() as unknown as Promise<BenchmarkRunRecord | null>;
  },
  async transition(ownerId, runId, allowed, changes, events = []) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await BenchmarkRunModel.findOne({ _id: runId, ownerId, status: { $in: allowed } })
        .select({ revision: 1 }).lean<{ revision: number }>();
      if (!current) return null;
      const revision = current.revision + 1;
      const terminal = changes.status !== undefined && TERMINAL_BENCHMARK_STATUSES.has(changes.status);
      const updated = await BenchmarkRunModel.findOneAndUpdate(
        { _id: runId, ownerId, status: { $in: allowed }, revision: current.revision },
        { $set: changes, $inc: { revision: 1 },
          ...(terminal ? { $unset: { activeOwnerSlot: '', 'execution.inFlightCallIndex': '' } } : {}),
          ...(events.length ? { $push: { timeline: { $each: events.map((event) => ({ ...event, revision })), $slice: -50 } } } : {}) },
        { new: true, runValidators: true }
      ).lean() as unknown as BenchmarkRunRecord | null;
      if (updated) return updated;
    }
    return null;
  },
  async reconcileDeletedProjects(completedAt) {
    const projectIds = await BenchmarkRunModel.distinct('projectId', { projectId: { $exists: true } });
    if (!projectIds.length) return { interrupted: 0, deleted: 0, runIds: [] };
    const existingIds = new Set((await ProjectModel.find({ _id: { $in: projectIds } }).distinct('_id')).map(String));
    const missing = projectIds.filter((id) => !existingIds.has(String(id)));
    if (!missing.length) return { interrupted: 0, deleted: 0, runIds: [] };
    const active = await BenchmarkRunModel.find({ projectId: { $in: missing }, status: { $in: ACTIVE_BENCHMARK_STATUSES } })
      .select({ _id: 1 }).lean();
    const deleted = await BenchmarkRunModel.deleteMany({ projectId: { $in: missing }, status: { $in: [...TERMINAL_BENCHMARK_STATUSES] } });
    let interrupted = 0;
    for (const item of active) {
      const run = await BenchmarkRunModel.findById(item._id).lean<BenchmarkRunRecord>();
      if (!run) continue;
      const result = await BenchmarkRunModel.updateOne(
        { _id: item._id, revision: run.revision, status: { $in: ACTIVE_BENCHMARK_STATUSES } },
        { $set: { status: 'interrupted', completedAt, error: { code: 'BENCHMARK_INTERRUPTED', message: 'The benchmark project was deleted during execution.' } },
          $unset: { activeOwnerSlot: '', 'execution.inFlightCallIndex': '' }, $inc: { revision: 1 },
          $push: { timeline: { revision: run.revision + 1, sequence: 50, type: 'failed', timestamp: completedAt, code: 'BENCHMARK_INTERRUPTED' } } }
      );
      interrupted += result.modifiedCount;
    }
    return { interrupted, deleted: deleted.deletedCount, runIds: active.map((run) => String(run._id)) };
  },
};

export interface PublicBenchmarkRun {
  id: string; projectId?: string; revision: number; status: BenchmarkRunStatus; suite: BenchmarkRunRecord['suite'];
  provider?: string; model: BenchmarkRunRecord['model']; completedCalls: number; passedCalls: number; outputBytes: number;
  wallDurationMs?: number; aggregate?: BenchmarkAggregate; error?: { code: string; message: string }; queuedAt: Date;
  startedAt?: Date; cancelRequestedAt?: Date; completedAt?: Date; createdAt?: Date; updatedAt?: Date;
  results?: BenchmarkCallResult[]; gpu?: { before?: BenchmarkGpuSnapshot; after?: BenchmarkGpuSnapshot }; timeline?: BenchmarkTimeline[];
}
export interface PublicBenchmarkRunPage { runs: PublicBenchmarkRun[]; pagination: { page: number; pageSize: 25; total: number; totalPages: number; maxPages: 10 } }
export type BenchmarkStreamEvent =
  | { type: 'run'; revision: number; run: PublicBenchmarkRun }
  | { type: 'call-start'; revision: number; runId: string; callIndex: number; promptIndex: number; repetition: number }
  | { type: 'call-completed'; revision: number; runId: string; result: BenchmarkCallResult }
  | { type: 'completed'; revision: number; run: PublicBenchmarkRun };
export interface PreparedBenchmarkRun { ownerId: string; projectId?: string; providerId: string; requestedModel: BenchmarkModelIdentity }

export function requireBenchmarkObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new BenchmarkRunError(`${label} is invalid.`, 'INVALID_BENCHMARK_INPUT', 400);
  return value;
}
function requirePage(value: unknown): number {
  if (value === undefined || value === null || value === '') return 1;
  const page = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > 10) throw new BenchmarkRunError('Benchmark page must be an integer from 1 to 10.', 'INVALID_BENCHMARK_INPUT', 400);
  return page;
}
export function safeBenchmarkLabel(value: unknown, maximum: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.normalize('NFC').trim();
  const unsafe = [...normalized].some((character) => character.codePointAt(0) === 0xfffd || /[\p{Cc}\p{Cf}]/u.test(character));
  return normalized && Buffer.byteLength(normalized, 'utf8') <= maximum && !unsafe ? normalized : fallback;
}
export function finiteBenchmarkInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), maximum) : undefined;
}
export function benchmarkModelIdentity(model: AiModel): BenchmarkModelIdentity {
  const sizeBytes = finiteBenchmarkInteger(model.sizeBytes ?? model.size, Number.MAX_SAFE_INTEGER);
  const contextWindow = finiteBenchmarkInteger(model.contextWindow, 100_000_000);
  const digest = model.digest === undefined ? undefined : safeBenchmarkLabel(model.digest, 200, '');
  return { id: safeBenchmarkLabel(model.id, 200, safeBenchmarkLabel(model.name, 200, 'configured-model')),
    ...(digest ? { digest } : {}), ...(sizeBytes !== undefined ? { sizeBytes } : {}), ...(contextWindow !== undefined ? { contextWindow } : {}) };
}
export function normalizeBenchmarkUsage(value: AiUsage | undefined): AiUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const output: AiUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'totalDurationMs', 'loadDurationMs'] as const) {
    const max = key === 'totalTokens' ? 200_000_000 : key === 'inputTokens' || key === 'outputTokens' ? 100_000_000 : 86_400_000;
    const item = finiteBenchmarkInteger(value[key], max); if (item !== undefined) output[key] = item;
  }
  return Object.keys(output).length ? output : undefined;
}
export function normalizeBenchmarkDuration(value: number): number {
  return Math.min(BENCHMARK_LIMITS.timeoutMs, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
}
export function sanitizeGpuSnapshot(status: GpuStatus): BenchmarkGpuSnapshot {
  const devices = (Array.isArray(status.gpus) ? status.gpus : []).slice(0, 8).map((gpu, position) => ({
    index: finiteBenchmarkInteger(gpu.index, 1024) ?? position, name: safeBenchmarkLabel(gpu.name, 120, 'NVIDIA GPU'),
    driverVersion: safeBenchmarkLabel(gpu.driverVersion, 80, 'unknown'), memoryTotalMiB: finiteBenchmarkInteger(gpu.memoryTotalMiB, 10_000_000) ?? 0,
    memoryUsedMiB: finiteBenchmarkInteger(gpu.memoryUsedMiB, 10_000_000) ?? 0, memoryFreeMiB: finiteBenchmarkInteger(gpu.memoryFreeMiB, 10_000_000) ?? 0,
    utilizationPercent: finiteBenchmarkInteger(gpu.utilizationPercent, 100) ?? 0, temperatureC: finiteBenchmarkInteger(gpu.temperatureC, 300) ?? 0,
  }));
  const sampledAt = typeof status.sampledAt === 'string' && !Number.isNaN(Date.parse(status.sampledAt)) ? new Date(status.sampledAt).toISOString() : new Date(0).toISOString();
  const summary = status.summary ? { deviceCount: Math.min(devices.length, finiteBenchmarkInteger(status.summary.deviceCount, 8) ?? devices.length),
    totalVramMiB: finiteBenchmarkInteger(status.summary.totalVramMiB, 10_000_000) ?? 0,
    usedVramMiB: finiteBenchmarkInteger(status.summary.usedVramMiB, 10_000_000) ?? 0,
    freeVramMiB: finiteBenchmarkInteger(status.summary.freeVramMiB, 10_000_000) ?? 0 } : undefined;
  return { available: status.available === true, ...(status.reason ? { reason: status.reason } : {}), sampledAt, devices, ...(summary ? { summary } : {}) };
}
export function validateBenchmarkRequest(value: unknown): { model: string; suiteId: 'chat-core-v1'; projectId?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new BenchmarkRunError('Benchmark input must be a JSON object.', 'INVALID_BENCHMARK_INPUT', 400);
  const input = value as Record<string, unknown>; const allowed = new Set(['model', 'suiteId', 'projectId']);
  if (Object.keys(input).some((key) => !allowed.has(key)) || typeof input.model !== 'string' || input.suiteId !== 'chat-core-v1')
    throw new BenchmarkRunError("Benchmark input must contain exactly model, suiteId 'chat-core-v1', and optional projectId.", 'INVALID_BENCHMARK_INPUT', 400);
  const model = input.model.normalize('NFC').trim();
  if (!model || Buffer.byteLength(model, 'utf8') > 200 || /[\p{Cc}\p{Cf}]/u.test(model)) throw new BenchmarkRunError('Benchmark model is invalid.', 'INVALID_BENCHMARK_INPUT', 400);
  const projectId = input.projectId === undefined ? undefined : requireBenchmarkObjectId(input.projectId, 'Project id');
  return { model, suiteId: 'chat-core-v1', ...(projectId ? { projectId } : {}) };
}
export function serializeBenchmarkRun(record: BenchmarkRunRecord, detail: boolean): PublicBenchmarkRun {
  return { id: String(record._id), ...(record.projectId ? { projectId: String(record.projectId) } : {}), revision: record.revision,
    status: record.status, suite: record.suite, ...(record.provider ? { provider: record.provider } : {}), model: record.model,
    completedCalls: record.completedCalls, passedCalls: record.passedCalls, outputBytes: record.outputBytes,
    ...(record.wallDurationMs !== undefined ? { wallDurationMs: record.wallDurationMs } : {}), ...(record.aggregate ? { aggregate: record.aggregate } : {}),
    ...(record.error?.code && record.error.message ? { error: { code: record.error.code, message: record.error.message } } : {}),
    queuedAt: record.queuedAt, ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.cancelRequestedAt ? { cancelRequestedAt: record.cancelRequestedAt } : {}), ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.createdAt ? { createdAt: record.createdAt } : {}), ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    ...(detail ? { results: record.results, gpu: record.gpu ?? {}, timeline: record.timeline } : {}) };
}
function duplicateOwner(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 11000;
}

export class BenchmarkService {
  constructor(
    private readonly repository: BenchmarkRunRepository = mongooseBenchmarkRunRepository,
    private readonly projects: Pick<ProjectService, 'resolveActiveProject' | 'resolveOwnedProject'> = projectService,
    private readonly provider: () => AiProviderClient = getAiProvider,
    private readonly now: () => Date = () => new Date(),
    private readonly timeoutMs: number = BENCHMARK_LIMITS.timeoutMs,
    private readonly projectLease: Pick<ProjectMutationLease, 'run'> = projectMutationLease,
    private readonly dispatcher: BenchmarkQueueDispatcher = benchmarkQueueDispatcher,
    private readonly pollMs = 250
  ) {}

  async status(ownerIdValue: unknown, projectIdValue?: unknown) {
    const ownerId = requireBenchmarkObjectId(ownerIdValue, 'Owner id');
    const projectId = projectIdValue === undefined || projectIdValue === ''
      ? undefined
      : requireBenchmarkObjectId(projectIdValue, 'Project id');
    let project: Awaited<ReturnType<ProjectService['resolveOwnedProject']>>;
    if (projectId) {
      try { project = await this.projects.resolveOwnedProject(ownerId, projectId); } catch (error) {
        if (error instanceof ProjectError) throw error;
        throw new BenchmarkRunError('Project storage is unavailable.', 'BENCHMARK_STORAGE_UNAVAILABLE', 503);
      }
    }
    let execution = { active: false, workerAvailable: false };
    try { execution = await this.dispatcher.executionStatus(); } catch { /* explicit false state */ }
    return { execution: { scope: 'shared-benchmark-worker' as const, globalLimit: 1 as const, ownerLimit: 1 as const, queueDurable: true as const, ...execution },
      limits: { retentionPerOwner: 100 as const, pageSize: 25 as const, maxPages: 10 as const, runTimeoutMs: this.timeoutMs,
        outputBytesPerCall: BENCHMARK_LIMITS.outputBytesPerCall, outputBytesPerRun: BENCHMARK_LIMITS.outputBytesPerRun },
      warnings: { multiReplicaCoordination: true as const, remoteProviderBillingAndPrivacy: true as const },
      scope: project
        ? { type: 'project' as const, projectId: String(project._id), projectStatus: project.status }
        : { type: 'workspace' as const } };
  }
  suites(): readonly [typeof CHAT_CORE_SUITE] { return [CHAT_CORE_SUITE]; }
  async prepare(ownerIdValue: unknown, inputValue: unknown): Promise<PreparedBenchmarkRun> {
    const ownerId = requireBenchmarkObjectId(ownerIdValue, 'Owner id'); const input = validateBenchmarkRequest(inputValue);
    let project: Awaited<ReturnType<ProjectService['resolveActiveProject']>>;
    try { project = await this.projects.resolveActiveProject(ownerId, input.projectId); } catch (error) {
      if (error instanceof ProjectError) throw error; throw new BenchmarkRunError('Project storage is unavailable.', 'BENCHMARK_STORAGE_UNAVAILABLE', 503);
    }
    let provider: AiProviderClient;
    try { provider = this.provider(); } catch { throw new BenchmarkRunError('The configured AI provider is unavailable.', 'BENCHMARK_PROVIDER_UNAVAILABLE', 503); }
    if (!provider.capabilities.chat || !provider.capabilities.streaming || !provider.capabilities.modelListing)
      throw new BenchmarkRunError('The configured provider does not support streamed chat benchmarks.', 'BENCHMARK_MODEL_UNSUPPORTED', 409);
    let models: AiModel[];
    try { models = await withProviderDiscoveryDeadline(provider.id, (options) => provider.listModels(options)); }
    catch { throw new BenchmarkRunError('The configured AI provider is unavailable.', 'BENCHMARK_PROVIDER_UNAVAILABLE', 503); }
    const selected = models.find((candidate) => candidate.id === input.model || candidate.name === input.model);
    if (!selected) throw new BenchmarkRunError('The requested model was not reported by the configured provider. No pull or fallback was attempted.', 'BENCHMARK_MODEL_NOT_FOUND', 404);
    if (selected.capabilities?.chat === false) throw new BenchmarkRunError('The requested model does not support chat.', 'BENCHMARK_MODEL_UNSUPPORTED', 409);
    return { ownerId, ...(project ? { projectId: String(project._id) } : {}), providerId: safeBenchmarkLabel(provider.id, 100, 'configured'), requestedModel: benchmarkModelIdentity(selected) };
  }
  async start(prepared: PreparedBenchmarkRun): Promise<PublicBenchmarkRun> {
    let count: number;
    try { count = await this.repository.count(prepared.ownerId); } catch { throw new BenchmarkRunError('Benchmark storage is unavailable.', 'BENCHMARK_STORAGE_UNAVAILABLE', 503); }
    if (count >= 100) throw new BenchmarkRunError('The saved benchmark limit has been reached. Delete terminal runs before starting another.', 'BENCHMARK_LIMIT_REACHED', 409);
    const queuedAt = this.now(); let run: BenchmarkRunRecord;
    try {
      const create = async () => {
        if (prepared.projectId) await this.projects.resolveActiveProject(prepared.ownerId, prepared.projectId);
        const pendingId = new BenchmarkRunModel()._id.toString();
        return this.repository.create({ _id: pendingId, ownerId: prepared.ownerId, ...(prepared.projectId ? { projectId: prepared.projectId } : {}),
          jobId: benchmarkJobId(pendingId), activeOwnerSlot: true, revision: 1,
          suite: { id: 'chat-core-v1', version: 1, promptCount: 3, repetitions: 2, totalCalls: 6 }, provider: prepared.providerId,
          model: { requested: prepared.requestedModel }, status: 'queued', results: [], completedCalls: 0, passedCalls: 0, outputBytes: 0,
          timeline: [{ revision: 1, sequence: 1, type: 'created', timestamp: queuedAt }], queuedAt });
      };
      run = prepared.projectId ? await this.projectLease.run(prepared.projectId, create) : await create();
    } catch (error) {
      if (duplicateOwner(error)) throw new BenchmarkRunError('Only one active benchmark is allowed per owner.', 'BENCHMARK_BUSY', 429);
      if (error instanceof ProjectError) throw new BenchmarkRunError('The project is no longer available for a new benchmark.', 'BENCHMARK_CONFLICT', 409);
      throw new BenchmarkRunError('Benchmark storage is unavailable.', 'BENCHMARK_STORAGE_UNAVAILABLE', 503);
    }
    try { await this.dispatcher.enqueue(String(run._id)); } catch {
      const completedAt = this.now();
      await this.repository.transition(prepared.ownerId, String(run._id), ['queued'], { status: 'interrupted', completedAt,
        error: { code: 'BENCHMARK_INTERRUPTED', message: 'The benchmark queue was unavailable before execution.' } },
      [{ sequence: 50, type: 'failed', timestamp: completedAt, code: 'BENCHMARK_INTERRUPTED' }]).catch(() => undefined);
      throw new BenchmarkRunError('The benchmark queue is unavailable.', 'BENCHMARK_QUEUE_UNAVAILABLE', 503);
    }
    return serializeBenchmarkRun(run, true);
  }
  async follow(ownerIdValue: unknown, runIdValue: unknown, onEvent: (event: BenchmarkStreamEvent) => void,
    signal?: AbortSignal, cursorValue?: unknown): Promise<PublicBenchmarkRun | undefined> {
    const ownerId = requireBenchmarkObjectId(ownerIdValue, 'Owner id'); const runId = requireBenchmarkObjectId(runIdValue, 'Benchmark run id');
    let cursor = this.requireCursor(cursorValue); let run = await this.getRecord(ownerId, runId);
    if (cursor > run.revision) throw new BenchmarkRunError('Benchmark stream cursor is ahead of canonical state.', 'INVALID_BENCHMARK_INPUT', 400);
    if (TERMINAL_BENCHMARK_STATUSES.has(run.status)) { const item = serializeBenchmarkRun(run, true); onEvent({ type: 'completed', revision: run.revision, run: item }); return item; }
    if (cursor < run.revision) { onEvent({ type: 'run', revision: run.revision, run: serializeBenchmarkRun(run, true) }); cursor = run.revision; }
    while (!signal?.aborted) {
      await this.wait(signal); if (signal?.aborted) return undefined; run = await this.getRecord(ownerId, runId);
      if (run.revision <= cursor) continue; this.emitTransitions(run, cursor, onEvent); cursor = run.revision;
      if (TERMINAL_BENCHMARK_STATUSES.has(run.status)) return serializeBenchmarkRun(run, true);
    }
    return undefined;
  }
  async list(ownerIdValue: unknown, pageValue?: unknown, projectIdValue?: unknown): Promise<PublicBenchmarkRunPage> {
    const ownerId = requireBenchmarkObjectId(ownerIdValue, 'Owner id'); const page = requirePage(pageValue);
    const projectId = projectIdValue === undefined || projectIdValue === '' ? undefined : requireBenchmarkObjectId(projectIdValue, 'Project id');
    if (projectId) try { await this.projects.resolveOwnedProject(ownerId, projectId); } catch (error) {
      if (error instanceof ProjectError) throw error; throw new BenchmarkRunError('Project storage is unavailable.', 'BENCHMARK_STORAGE_UNAVAILABLE', 503);
    }
    try { const [records, total] = await Promise.all([this.repository.list(ownerId, projectId, (page - 1) * 25, 25), this.repository.countInScope(ownerId, projectId)]);
      return { runs: records.map((record) => serializeBenchmarkRun(record, false)), pagination: { page, pageSize: 25, total,
        totalPages: Math.max(1, Math.min(10, Math.ceil(total / 25))), maxPages: 10 } };
    } catch { throw new BenchmarkRunError('Benchmark storage is unavailable.', 'BENCHMARK_STORAGE_UNAVAILABLE', 503); }
  }
  async get(ownerIdValue: unknown, runIdValue: unknown) { return serializeBenchmarkRun(await this.getRecord(ownerIdValue, runIdValue), true); }
  async cancel(ownerIdValue: unknown, runIdValue: unknown) {
    const ownerId = requireBenchmarkObjectId(ownerIdValue, 'Owner id'); const runId = requireBenchmarkObjectId(runIdValue, 'Benchmark run id');
    let current = await this.getRecord(ownerId, runId);
    if (TERMINAL_BENCHMARK_STATUSES.has(current.status) || current.status === 'cancel-requested') return { run: serializeBenchmarkRun(current, true), idempotent: true };
    const timestamp = this.now();
    if (current.status === 'queued') {
      const cancelled = await this.repository.transition(ownerId, runId, ['queued'],
        { status: 'cancelled', cancelRequestedAt: timestamp, completedAt: timestamp }, [
          { sequence: 49, type: 'cancel_requested', timestamp },
          { sequence: 50, type: 'cancelled', timestamp },
        ]);
      if (cancelled) {
        await this.dispatcher.remove(runId).catch(() => undefined);
        return { run: serializeBenchmarkRun(cancelled, true), idempotent: false };
      }
      current = await this.getRecord(ownerId, runId);
      if (TERMINAL_BENCHMARK_STATUSES.has(current.status) || current.status === 'cancel-requested')
        return { run: serializeBenchmarkRun(current, true), idempotent: true };
    }
    const requested = await this.repository.transition(ownerId, runId, ['running'],
      { status: 'cancel-requested', cancelRequestedAt: timestamp }, [{ sequence: 49, type: 'cancel_requested', timestamp }]);
    if (!requested) { const latest = await this.getRecord(ownerId, runId);
      if (TERMINAL_BENCHMARK_STATUSES.has(latest.status) || latest.status === 'cancel-requested') return { run: serializeBenchmarkRun(latest, true), idempotent: true };
      throw new BenchmarkRunError('The benchmark run changed state concurrently.', 'BENCHMARK_CONFLICT', 409); }
    try { await this.dispatcher.wakeCancellation(runId); } catch { /* Mongo-first cancellation remains durable. */ }
    return { run: serializeBenchmarkRun(requested, true), idempotent: false };
  }
  async delete(ownerIdValue: unknown, runIdValue: unknown) {
    const ownerId = requireBenchmarkObjectId(ownerIdValue, 'Owner id'); const runId = requireBenchmarkObjectId(runIdValue, 'Benchmark run id');
    const current = await this.getRecord(ownerId, runId);
    if (!TERMINAL_BENCHMARK_STATUSES.has(current.status)) throw new BenchmarkRunError('Only terminal benchmark runs can be deleted.', 'BENCHMARK_CONFLICT', 409);
    if (current.projectId) { const project = await this.projects.resolveOwnedProject(ownerId, String(current.projectId));
      if (project?.status === 'archived') throw new BenchmarkRunError('Restore the archived project before deleting benchmark history.', 'BENCHMARK_CONFLICT', 409); }
    const deleted = await this.repository.deleteTerminalByOwnerAndId(ownerId, runId);
    if (!deleted) throw new BenchmarkRunError('The benchmark run changed state concurrently.', 'BENCHMARK_CONFLICT', 409);
    await this.dispatcher.remove(runId).catch(() => undefined); return { runId, deleted: true as const };
  }
  async recoverInterrupted() {
    const now = this.now();
    try { const orphaned = await this.repository.reconcileDeletedProjects(now); const active = await this.repository.findActive();
      const execution = await this.dispatcher.executionStatus().catch(() => ({ active: false, workerAvailable: false }));
      let interrupted = 0; let requeued = 0;
      for (const run of active) {
        if (run.status === 'running' && run.execution?.inFlightCallIndex !== undefined && !execution.active && !execution.workerAvailable) {
          if (await this.repository.transition(String(run.ownerId), String(run._id), ['running'], { status: 'interrupted', completedAt: now,
            error: { code: 'BENCHMARK_INTERRUPTED', message: 'The benchmark worker stopped during a provider call; the call was not retried.' } },
          [{ sequence: 50, type: 'failed', timestamp: now, code: 'BENCHMARK_INTERRUPTED' }])) interrupted += 1;
          continue;
        }
        if (run.status === 'cancel-requested') await this.dispatcher.wakeCancellation(String(run._id)).catch(() => undefined);
        await this.dispatcher.enqueue(String(run._id)); requeued += 1;
      }
      return { interrupted, orphaned: orphaned.interrupted, deleted: orphaned.deleted, requeued };
    } catch { throw new BenchmarkRunError('Benchmark recovery could not access storage or queue.', 'BENCHMARK_STORAGE_UNAVAILABLE', 503); }
  }
  private emitTransitions(run: BenchmarkRunRecord, after: number, onEvent: (event: BenchmarkStreamEvent) => void) {
    const groups = new Map<number, BenchmarkTimeline[]>();
    for (const event of run.timeline.filter((item) => item.revision > after)) groups.set(event.revision, [...(groups.get(event.revision) ?? []), event]);
    for (const revision of [...groups.keys()].sort((a, b) => a - b)) {
      const events = groups.get(revision) ?? [];
      if (events.some((event) => ['completed', 'failed', 'cancelled'].includes(event.type))) { onEvent({ type: 'completed', revision, run: serializeBenchmarkRun(run, true) }); continue; }
      const completed = events.find((event) => event.type === 'call_completed');
      if (completed?.callIndex !== undefined) { const result = run.results.find((item) => item.callIndex === completed.callIndex);
        if (result) onEvent({ type: 'call-completed', revision, runId: String(run._id), result }); continue; }
      const started = events.find((event) => event.type === 'call_started');
      if (started?.callIndex !== undefined) { onEvent({ type: 'call-start', revision, runId: String(run._id), callIndex: started.callIndex,
        promptIndex: Math.floor(started.callIndex / 2), repetition: (started.callIndex % 2) + 1 }); continue; }
      onEvent({ type: 'run', revision, run: serializeBenchmarkRun(run, true) });
    }
  }
  private requireCursor(value: unknown) {
    if (value === undefined || value === null || value === '') return 0;
    const cursor = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > 1_000_000)
      throw new BenchmarkRunError('Last-Event-ID must be an integer from 0 to 1000000.', 'INVALID_BENCHMARK_INPUT', 400);
    return cursor;
  }
  private async wait(signal?: AbortSignal) { await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve();
    };
    const timer = setTimeout(finish, this.pollMs);
    if (signal?.aborted) finish(); else signal?.addEventListener('abort', finish, { once: true });
  }); }
  private async getRecord(ownerIdValue: unknown, runIdValue: unknown) {
    const ownerId = requireBenchmarkObjectId(ownerIdValue, 'Owner id'); const runId = requireBenchmarkObjectId(runIdValue, 'Benchmark run id');
    let run: BenchmarkRunRecord | null;
    try { run = await this.repository.findByOwnerAndId(ownerId, runId); } catch { throw new BenchmarkRunError('Benchmark storage is unavailable.', 'BENCHMARK_STORAGE_UNAVAILABLE', 503); }
    if (!run) throw new BenchmarkRunError('Benchmark run not found.', 'BENCHMARK_RUN_NOT_FOUND', 404); return run;
  }
}
export const benchmarkService = new BenchmarkService();
