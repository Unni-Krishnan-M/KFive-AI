import { QueueEvents } from 'bullmq';
import { CodeLanguage, CodeRunModel, CodeRunStatus } from '@/models/CodeRun';
import { logger } from '@/utils/logger';
import { CODE_RUN_LIMITS } from './codeRunService';

export type ExecutionTerminalStatus = Extract<
  CodeRunStatus,
  'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'resource_exceeded' | 'output_limit' | 'internal_error'
>;

export interface ExecutionResult {
  runId: string;
  language: CodeLanguage;
  runtimeVersion: string;
  status: ExecutionTerminalStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  outputTruncated: boolean;
  oomKilled: boolean;
  errorCode?: string;
}

export interface CodeRunReconciliationRepository {
  listPending(limit: number): Promise<PendingCodeRun[]>;
  findExpected(runId: string): Promise<ExpectedCodeRun | null>;
  markActive(runId: string, startedAt: Date): Promise<void>;
  complete(runId: string, status: ExecutionTerminalStatus, result: Record<string, unknown>, completedAt: Date): Promise<void>;
  fail(runId: string, errorCode: string, errorMessage: string, completedAt: Date): Promise<void>;
}

export interface ExpectedCodeRun {
  _id: unknown;
  language: CodeLanguage;
  runtimeVersion: string;
}

export interface PendingCodeRun {
  _id: unknown;
  status: Extract<CodeRunStatus, 'queued' | 'running' | 'cancel-requested'>;
  queuedAt: Date;
}

export interface ReconciliationQueueJob {
  returnvalue?: unknown;
  getState(): Promise<string>;
}

export interface ReconciliationQueue {
  getJob(runId: string): Promise<ReconciliationQueueJob | null | undefined>;
}

export const CODE_RUN_RECONCILIATION_GRACE_MS = 60_000;
export const CODE_RUN_RECONCILIATION_SCAN_LIMIT = 1_000;
const GENERIC_JOB_FAILURE = 'The isolated code runner job failed.';
const MISSED_RESULT_MESSAGE = 'The isolated code runner result could not be reconciled.';
const RESULT_MISMATCH_MESSAGE = 'The isolated runner result did not match the queued code run.';

export const mongooseCodeRunReconciliationRepository: CodeRunReconciliationRepository = {
  async listPending(limit) {
    return CodeRunModel.find({ status: { $in: ['queued', 'running', 'cancel-requested'] } })
      .select({ _id: 1, status: 1, queuedAt: 1 })
      .sort({ queuedAt: 1 })
      .limit(limit)
      .lean() as unknown as Promise<PendingCodeRun[]>;
  },
  async findExpected(runId) {
    return CodeRunModel.findOne({
      _id: runId,
      status: { $in: ['queued', 'running', 'cancel-requested'] },
    })
      .select({ _id: 1, language: 1, runtimeVersion: 1 })
      .lean() as unknown as Promise<ExpectedCodeRun | null>;
  },
  async markActive(runId, startedAt) {
    await CodeRunModel.updateOne(
      { _id: runId, status: 'queued' },
      { $set: { status: 'running', startedAt } }
    );
  },
  async complete(runId, status, result, completedAt) {
    await CodeRunModel.updateOne(
      { _id: runId, status: { $in: ['queued', 'running', 'cancel-requested'] } },
      { $set: { status, result, completedAt } },
      { runValidators: true }
    );
  },
  async fail(runId, errorCode, errorMessage, completedAt) {
    await CodeRunModel.updateOne(
      { _id: runId, status: { $in: ['queued', 'running', 'cancel-requested'] } },
      {
        $set: {
          status: 'internal_error',
          completedAt,
          result: { errorCode, errorMessage },
        },
      },
      { runValidators: true }
    );
  },
};

const OBJECT_ID = /^[a-f\d]{24}$/i;
const TERMINAL = new Set<ExecutionTerminalStatus>([
  'succeeded', 'failed', 'timed_out', 'cancelled',
  'resource_exceeded', 'output_limit', 'internal_error',
]);

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid runner result');
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, maxBytes: number): { value: string; truncated: boolean } {
  if (typeof value !== 'string') throw new Error('Invalid runner text output');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value, truncated: false };
  let result = Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
  if (result.endsWith('\uFFFD')) result = result.slice(0, -1);
  return { value: result, truncated: true };
}

export function normalizeExecutionResult(jobId: string, raw: unknown): ExecutionResult & { backendTruncated: boolean } {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { throw new Error('Invalid runner result JSON'); }
  }
  const value = requireObject(parsed);
  if (typeof value.runId !== 'string' || !OBJECT_ID.test(value.runId) || value.runId !== jobId) {
    throw new Error('Runner result runId mismatch');
  }
  if (value.language !== 'python' && value.language !== 'javascript') throw new Error('Invalid runner result language');
  if (typeof value.runtimeVersion !== 'string' || !value.runtimeVersion || value.runtimeVersion.length > 50) {
    throw new Error('Invalid runner runtime version');
  }
  if (typeof value.status !== 'string' || !TERMINAL.has(value.status as ExecutionTerminalStatus)) {
    throw new Error('Invalid runner terminal status');
  }
  if (value.exitCode !== null && (typeof value.exitCode !== 'number' || !Number.isInteger(value.exitCode))) {
    throw new Error('Invalid runner exit code');
  }
  if (value.signal !== null && (typeof value.signal !== 'string' || value.signal.length > 50)) {
    throw new Error('Invalid runner signal');
  }
  if (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0) {
    throw new Error('Invalid runner duration');
  }
  if (typeof value.outputTruncated !== 'boolean' || typeof value.oomKilled !== 'boolean') {
    throw new Error('Invalid runner result flags');
  }
  if (value.errorCode !== undefined && (typeof value.errorCode !== 'string' || value.errorCode.length > 100)) {
    throw new Error('Invalid runner error code');
  }
  const stdout = boundedText(value.stdout, CODE_RUN_LIMITS.outputBytes);
  const stderr = boundedText(value.stderr, CODE_RUN_LIMITS.outputBytes);
  return {
    runId: value.runId,
    language: value.language,
    runtimeVersion: value.runtimeVersion,
    status: value.status as ExecutionTerminalStatus,
    stdout: stdout.value,
    stderr: stderr.value,
    exitCode: value.exitCode,
    signal: value.signal,
    durationMs: value.durationMs,
    outputTruncated: value.outputTruncated || stdout.truncated || stderr.truncated,
    oomKilled: value.oomKilled,
    ...(value.errorCode ? { errorCode: value.errorCode } : {}),
    backendTruncated: stdout.truncated || stderr.truncated,
  };
}

export class CodeRunReconciler {
  constructor(
    private readonly repository: CodeRunReconciliationRepository = mongooseCodeRunReconciliationRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  async active(jobId: string): Promise<void> {
    if (!OBJECT_ID.test(jobId)) return;
    await this.repository.markActive(jobId, this.now());
  }

  async completed(jobId: string, returnValue: unknown): Promise<void> {
    if (!OBJECT_ID.test(jobId)) return;
    const expected = await this.repository.findExpected(jobId);
    if (!expected) return;

    let normalized: ExecutionResult & { backendTruncated: boolean };
    try {
      normalized = normalizeExecutionResult(jobId, returnValue);
    } catch (error) {
      await this.repository.fail(
        jobId,
        'INVALID_RUNNER_RESULT',
        'The isolated runner returned an invalid result.',
        this.now()
      );
      throw error;
    }

    if (
      normalized.runId !== String(expected._id)
      || normalized.language !== expected.language
      || normalized.runtimeVersion !== expected.runtimeVersion
    ) {
      await this.repository.fail(jobId, 'RUNNER_RESULT_MISMATCH', RESULT_MISMATCH_MESSAGE, this.now());
      return;
    }

    await this.repository.complete(jobId, normalized.status, {
      stdout: normalized.stdout,
      stderr: normalized.stderr,
      exitCode: normalized.exitCode,
      signal: normalized.signal,
      executionTimeMs: normalized.durationMs,
      outputTruncated: normalized.outputTruncated,
      oomKilled: normalized.oomKilled,
      ...(normalized.errorCode ? { errorCode: normalized.errorCode } : {}),
    }, this.now());
  }

  async failed(jobId: string): Promise<void> {
    if (!OBJECT_ID.test(jobId)) return;
    await this.repository.fail(jobId, 'RUNNER_INTERNAL_ERROR', GENERIC_JOB_FAILURE, this.now());
  }

  async sweep(
    queue: ReconciliationQueue,
    graceMs = CODE_RUN_RECONCILIATION_GRACE_MS
  ): Promise<{ examined: number; reconciled: number; deferred: number; errors: number }> {
    const pending = await this.repository.listPending(CODE_RUN_RECONCILIATION_SCAN_LIMIT);
    const summary = { examined: pending.length, reconciled: 0, deferred: 0, errors: 0 };
    const now = this.now();

    for (const record of pending) {
      const jobId = String(record._id);
      if (!OBJECT_ID.test(jobId)) continue;
      try {
        const job = await queue.getJob(jobId);
        if (!job) {
          const queuedAt = record.queuedAt instanceof Date ? record.queuedAt.getTime() : NaN;
          if (Number.isFinite(queuedAt) && now.getTime() - queuedAt >= graceMs) {
            await this.repository.fail(jobId, 'RECONCILIATION_MISSED', MISSED_RESULT_MESSAGE, now);
            summary.reconciled += 1;
          } else {
            summary.deferred += 1;
          }
          continue;
        }

        const state = await job.getState();
        if (state === 'completed') {
          await this.completed(jobId, job.returnvalue);
          summary.reconciled += 1;
        } else if (state === 'failed') {
          await this.failed(jobId);
          summary.reconciled += 1;
        } else if (state === 'active') {
          await this.active(jobId);
          summary.reconciled += 1;
        } else {
          summary.deferred += 1;
        }
      } catch {
        summary.errors += 1;
        logger.error('Code run startup reconciliation failed', { event: 'startup-sweep', jobId });
      }
    }
    return summary;
  }
}

export function attachCodeRunQueueEvents(
  events: QueueEvents,
  reconciler: CodeRunReconciler = new CodeRunReconciler()
): void {
  const handle = (event: string, jobId: string, operation: () => Promise<void>): void => {
    void operation().catch(() => logger.error('Code run queue reconciliation failed', { event, jobId }));
  };
  events.on('active', ({ jobId }) => handle('active', jobId, () => reconciler.active(jobId)));
  events.on('completed', ({ jobId, returnvalue }) => handle('completed', jobId, () => reconciler.completed(jobId, returnvalue)));
  events.on('failed', ({ jobId }) => handle('failed', jobId, () => reconciler.failed(jobId)));
  events.on('error', () => logger.error('Code run queue event listener error', { event: 'queue-events-error' }));
}
