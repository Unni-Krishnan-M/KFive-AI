import { Queue } from 'bullmq';
import { getCodeRunsQueue } from '@/config/queues';
import { getRedisClient } from '@/config/redis';
import { CodeLanguage, CodeRunModel, CodeRunStatus } from '@/models/CodeRun';
import { ProjectRecord, projectService } from './projectService';

export const CODE_RUNTIMES = Object.freeze({
  python: Object.freeze({ language: 'python' as const, version: '3.12' }),
  javascript: Object.freeze({ language: 'javascript' as const, version: '22' }),
});

export const CODE_RUN_LIMITS = Object.freeze({
  timeoutMs: 5_000,
  memoryBytes: 256 * 1024 * 1024,
  cpus: 1,
  pids: 32,
  outputBytes: 1024 * 1024,
  networkEnabled: false as const,
});

export type CodeRunErrorCode =
  | 'INVALID_CODE_RUN_ID'
  | 'INVALID_CODE_RUN_INPUT'
  | 'CODE_RUN_NOT_FOUND'
  | 'RUNNER_DISABLED'
  | 'RUNNER_UNAVAILABLE';

export class CodeRunError extends Error {
  readonly isOperational = true;

  constructor(
    message: string,
    readonly code: CodeRunErrorCode,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'CodeRunError';
  }
}

export interface CodeRunRecord {
  _id: unknown;
  userId: unknown;
  projectId?: unknown;
  language: CodeLanguage;
  runtimeVersion: string;
  source: string;
  stdin: string;
  status: CodeRunStatus;
  [key: string]: unknown;
}

export interface CodeRunCreateData {
  userId: string;
  projectId?: unknown;
  language: CodeLanguage;
  runtimeVersion: string;
  source: string;
  stdin: string;
  status: 'queued';
  limits: typeof CODE_RUN_LIMITS;
  queuedAt: Date;
}

export interface CodeRunRepository {
  create(data: CodeRunCreateData): Promise<CodeRunRecord>;
  list(ownerId: string, projectId?: unknown): Promise<CodeRunRecord[]>;
  findByOwnerAndId(ownerId: string, runId: string): Promise<CodeRunRecord | null>;
  transition(
    ownerId: string,
    runId: string,
    from: CodeRunStatus[],
    changes: Record<string, unknown>
  ): Promise<CodeRunRecord | null>;
}

export const mongooseCodeRunRepository: CodeRunRepository = {
  async create(data) {
    return CodeRunModel.create(data) as unknown as Promise<CodeRunRecord>;
  },
  async list(ownerId, projectId) {
    return CodeRunModel.find({ userId: ownerId, ...(projectId ? { projectId } : {}) })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean() as unknown as Promise<CodeRunRecord[]>;
  },
  async findByOwnerAndId(ownerId, runId) {
    return CodeRunModel.findOne({ _id: runId, userId: ownerId }) as unknown as Promise<CodeRunRecord | null>;
  },
  async transition(ownerId, runId, from, changes) {
    return CodeRunModel.findOneAndUpdate(
      { _id: runId, userId: ownerId, status: { $in: from } },
      { $set: changes },
      { new: true, runValidators: true }
    ) as unknown as Promise<CodeRunRecord | null>;
  },
};

export type DispatchCancelResult = 'removed' | 'active' | 'missing' | 'terminal';

export const CODE_RUNNER_HEARTBEAT_KEY = 'kfive:code-runner:heartbeat';
export const CODE_RUNNER_CANCEL_KEY_PREFIX = 'kfive:code-runner:cancel:';
export const CODE_RUNNER_CANCEL_CHANNEL = 'kfive:code-runner:cancel';
export const CODE_RUNNER_HEARTBEAT_MAX_AGE_MS = 15_000;

export interface CodeRunnerRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
}

export interface CodeRunDispatchPayload {
  runId: string;
  language: CodeLanguage;
  source: string;
  stdin: string;
}

export interface CodeRunDispatcher {
  availability(): Promise<CodeRunnerAvailability>;
  dispatch(payload: CodeRunDispatchPayload): Promise<void>;
  cancel(runId: string): Promise<DispatchCancelResult>;
}

export interface CodeRunnerAvailability {
  available: boolean;
  message?: string;
}

export class BullMqCodeRunDispatcher implements CodeRunDispatcher {
  constructor(
    private readonly resolveQueue: () => Queue = getCodeRunsQueue,
    private readonly resolveRedis: () => CodeRunnerRedis = () => getRedisClient() as unknown as CodeRunnerRedis,
    private readonly now: () => number = Date.now,
    private readonly heartbeatMaxAgeMs = CODE_RUNNER_HEARTBEAT_MAX_AGE_MS
  ) {}

  async availability(): Promise<CodeRunnerAvailability> {
    try {
      await this.assertRunnerAvailable();
      return { available: true };
    } catch (error) {
      if (error instanceof CodeRunError) {
        return { available: false, message: error.message };
      }
      return { available: false, message: 'The isolated code runner queue is unavailable.' };
    }
  }

  async dispatch(payload: CodeRunDispatchPayload): Promise<void> {
    try {
      const availability = await this.availability();
      if (!availability.available) {
        throw new CodeRunError(
          availability.message || 'The isolated code runner is unavailable.',
          'RUNNER_UNAVAILABLE',
          503
        );
      }
      await this.resolveQueue().add('execute', payload, {
        jobId: payload.runId,
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      });
    } catch (error) {
      if (error instanceof CodeRunError) throw error;
      throw new CodeRunError(
        'The isolated code runner queue is unavailable.',
        'RUNNER_UNAVAILABLE',
        503
      );
    }
  }

  async cancel(runId: string): Promise<DispatchCancelResult> {
    try {
      await this.signalCancellation(runId);
      const job = await this.resolveQueue().getJob(runId);
      if (!job) return 'missing';
      const state = await job.getState();
      if (state === 'active') return 'active';
      if (state === 'completed' || state === 'failed') return 'terminal';
      await job.remove();
      return 'removed';
    } catch (error) {
      if (error instanceof CodeRunError) throw error;
      throw new CodeRunError(
        'The isolated code runner queue is unavailable.',
        'RUNNER_UNAVAILABLE',
        503
      );
    }
  }

  private async assertRunnerAvailable(): Promise<void> {
    const heartbeat = await this.resolveRedis().get(CODE_RUNNER_HEARTBEAT_KEY);
    let heartbeatAt = heartbeat === null ? NaN : Number(heartbeat);
    if (heartbeat !== null && !Number.isFinite(heartbeatAt)) {
      try {
        const parsed = JSON.parse(heartbeat) as { status?: unknown; updatedAt?: unknown; languages?: unknown };
        if (
          parsed.status === 'ready'
          && typeof parsed.updatedAt === 'string'
          && Array.isArray(parsed.languages)
          && parsed.languages.includes('python')
          && parsed.languages.includes('javascript')
        ) {
          heartbeatAt = Date.parse(parsed.updatedAt);
        }
      } catch {
        heartbeatAt = NaN;
      }
    }
    const age = this.now() - heartbeatAt;
    if (!Number.isFinite(heartbeatAt) || age < -5_000 || age > this.heartbeatMaxAgeMs) {
      throw new CodeRunError(
        'The isolated code runner is unavailable or has a stale heartbeat.',
        'RUNNER_UNAVAILABLE',
        503
      );
    }
  }

  private async signalCancellation(runId: string): Promise<void> {
    const redis = this.resolveRedis();
    const key = `${CODE_RUNNER_CANCEL_KEY_PREFIX}${runId}`;
    await redis.set(key, '1', { EX: 60 });
    await redis.publish(CODE_RUNNER_CANCEL_CHANNEL, runId);
  }
}

interface ValidatedCodeRunInput {
  language: CodeLanguage;
  source: string;
  stdin: string;
  projectId?: unknown;
}

const OBJECT_ID = /^[a-f\d]{24}$/i;
const TERMINAL = new Set<CodeRunStatus>([
  'succeeded', 'failed', 'timed_out', 'cancelled',
  'resource_exceeded', 'output_limit', 'internal_error',
]);

function requireObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) {
    throw new CodeRunError(`${label} is invalid.`, 'INVALID_CODE_RUN_ID', 400);
  }
  return value;
}

export function validateCodeRunInput(value: unknown): ValidatedCodeRunInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodeRunError('Code run input must be a JSON object.', 'INVALID_CODE_RUN_INPUT', 400);
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(['language', 'source', 'stdin', 'projectId']);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new CodeRunError(
      'Code run input contains unsupported fields. Runtime images, commands, and resource limits are server-controlled.',
      'INVALID_CODE_RUN_INPUT',
      400
    );
  }
  if (input.language !== 'python' && input.language !== 'javascript') {
    throw new CodeRunError("language must be 'python' or 'javascript'.", 'INVALID_CODE_RUN_INPUT', 400);
  }
  if (
    typeof input.source !== 'string'
    || input.source.includes('\0')
    || Buffer.byteLength(input.source, 'utf8') < 1
    || Buffer.byteLength(input.source, 'utf8') > 65_536
  ) {
    throw new CodeRunError('source must contain 1 to 65536 UTF-8 bytes and no NUL bytes.', 'INVALID_CODE_RUN_INPUT', 400);
  }
  const stdin = input.stdin === undefined ? '' : input.stdin;
  if (typeof stdin !== 'string' || stdin.includes('\0') || Buffer.byteLength(stdin, 'utf8') > 16_384) {
    throw new CodeRunError('stdin must contain at most 16384 UTF-8 bytes and no NUL bytes.', 'INVALID_CODE_RUN_INPUT', 400);
  }
  return {
    language: input.language,
    source: input.source,
    stdin,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
  };
}

export interface CodeRunCreationResult { run: CodeRunRecord }
export interface CodeRunCancellationResult { run: CodeRunRecord; idempotent: boolean }

export class CodeRunService {
  constructor(
    private readonly mode: 'disabled' | 'container',
    private readonly repository: CodeRunRepository = mongooseCodeRunRepository,
    private readonly dispatcher: CodeRunDispatcher = new BullMqCodeRunDispatcher(),
    private readonly resolveActiveProject: (ownerId: string, projectId: unknown) => Promise<ProjectRecord | undefined> =
      (ownerId, projectId) => projectService.resolveActiveProject(ownerId, projectId),
    private readonly resolveOwnedProject: (ownerId: string, projectId: unknown) => Promise<ProjectRecord | undefined> =
      (ownerId, projectId) => projectService.resolveOwnedProject(ownerId, projectId),
    private readonly now: () => Date = () => new Date()
  ) {}

  async getRuntimeCatalog(): Promise<{
    enabled: boolean;
    available: boolean;
    message?: string;
    runtimes: Array<{ language: CodeLanguage; version: string; available: boolean; message?: string }>;
    limits: Record<string, number | boolean>;
  }> {
    const enabled = this.mode === 'container';
    const availability: CodeRunnerAvailability = enabled
      ? await this.dispatcher.availability()
      : {
        available: false,
        message: 'The isolated code runner is disabled. Set CODE_RUNNER_MODE=container and restart KFive.',
      };
    return {
      enabled,
      available: enabled && availability.available,
      ...(!availability.available && availability.message ? { message: availability.message } : {}),
      runtimes: Object.values(CODE_RUNTIMES).map((runtime) => ({
        ...runtime,
        available: enabled && availability.available,
        ...(!availability.available && availability.message ? { message: availability.message } : {}),
      })),
      limits: {
        timeoutMs: CODE_RUN_LIMITS.timeoutMs,
        memoryMiB: CODE_RUN_LIMITS.memoryBytes / (1024 * 1024),
        cpus: CODE_RUN_LIMITS.cpus,
        pids: CODE_RUN_LIMITS.pids,
        outputBytes: CODE_RUN_LIMITS.outputBytes,
        networkEnabled: CODE_RUN_LIMITS.networkEnabled,
      },
    };
  }

  async create(ownerIdValue: unknown, value: unknown): Promise<CodeRunCreationResult> {
    this.assertEnabled();
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const input = validateCodeRunInput(value);
    const project = await this.resolveActiveProject(ownerId, input.projectId);
    const queuedAt = this.now();
    const run = await this.repository.create({
      userId: ownerId,
      ...(project ? { projectId: project._id } : {}),
      language: input.language,
      runtimeVersion: CODE_RUNTIMES[input.language].version,
      source: input.source,
      stdin: input.stdin,
      status: 'queued',
      limits: CODE_RUN_LIMITS,
      queuedAt,
    });
    const runId = String(run._id);
    try {
      await this.dispatcher.dispatch({
        runId,
        language: input.language,
        source: input.source,
        stdin: input.stdin,
      });
    } catch (error) {
      await this.repository.transition(ownerId, runId, ['queued'], {
        status: 'failed',
        completedAt: this.now(),
        result: { errorCode: 'RUNNER_UNAVAILABLE', errorMessage: 'The isolated code runner queue is unavailable.' },
      }).catch(() => undefined);
      if (error instanceof CodeRunError) throw error;
      throw new CodeRunError('The isolated code runner queue is unavailable.', 'RUNNER_UNAVAILABLE', 503);
    }
    return { run };
  }

  async list(ownerIdValue: unknown, projectIdValue?: unknown): Promise<CodeRunRecord[]> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const project = await this.resolveOwnedProject(ownerId, projectIdValue);
    return this.repository.list(ownerId, project?._id);
  }

  async get(ownerIdValue: unknown, runIdValue: unknown): Promise<CodeRunRecord> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const runId = requireObjectId(runIdValue, 'Code run id');
    const run = await this.repository.findByOwnerAndId(ownerId, runId);
    if (!run) throw new CodeRunError('Code run not found.', 'CODE_RUN_NOT_FOUND', 404);
    return run;
  }

  async cancel(ownerIdValue: unknown, runIdValue: unknown): Promise<CodeRunCancellationResult> {
    this.assertEnabled();
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const runId = requireObjectId(runIdValue, 'Code run id');
    const current = await this.get(ownerId, runId);
    if (TERMINAL.has(current.status) || current.status === 'cancel-requested') {
      return { run: current, idempotent: true };
    }

    const dispatchResult = await this.dispatcher.cancel(runId);
    const timestamp = this.now();
    const status: CodeRunStatus = dispatchResult === 'removed' || dispatchResult === 'missing'
      ? 'cancelled'
      : dispatchResult === 'terminal'
        ? 'internal_error'
        : 'cancel-requested';
    const run = await this.repository.transition(ownerId, runId, ['queued', 'running'], {
      status,
      cancelRequestedAt: timestamp,
      ...(status === 'cancelled' || status === 'internal_error' ? { completedAt: timestamp } : {}),
      ...(status === 'internal_error' ? {
        result: {
          errorCode: 'RECONCILIATION_MISSED',
          errorMessage: 'The runner job finished before its result could be reconciled.',
        },
      } : {}),
    });
    if (run) return { run, idempotent: false };
    const latest = await this.get(ownerId, runId);
    return { run: latest, idempotent: TERMINAL.has(latest.status) || latest.status === 'cancel-requested' };
  }

  private assertEnabled(): void {
    if (this.mode !== 'container') {
      throw new CodeRunError(
        'The isolated code runner is disabled. Set CODE_RUNNER_MODE=container and restart KFive.',
        'RUNNER_DISABLED',
        503
      );
    }
  }
}
