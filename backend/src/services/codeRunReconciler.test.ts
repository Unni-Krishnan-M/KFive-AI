import { EventEmitter } from 'events';
import { QueueEvents } from 'bullmq';
import {
  attachCodeRunQueueEvents,
  CodeRunReconciler,
  CodeRunReconciliationRepository,
  normalizeExecutionResult,
} from './codeRunReconciler';

const runId = '64b000000000000000000401';
const now = new Date('2026-01-01T00:00:00.000Z');

function result(overrides: Record<string, unknown> = {}) {
  return {
    runId,
    language: 'python',
    runtimeVersion: '3.12',
    status: 'succeeded',
    stdout: 'hello\n',
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 15,
    outputTruncated: false,
    oomKilled: false,
    ...overrides,
  };
}

function repository(overrides: Partial<CodeRunReconciliationRepository> = {}): CodeRunReconciliationRepository {
  return {
    listPending: async () => [],
    findExpected: async () => ({ _id: runId, language: 'python', runtimeVersion: '3.12' }),
    markActive: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    ...overrides,
  };
}

describe('runner result normalization', () => {
  it('validates the typed result and preserves audit fields', () => {
    expect(normalizeExecutionResult(runId, JSON.stringify(result({
      status: 'resource_exceeded', signal: 'SIGKILL', oomKilled: true, errorCode: 'MEMORY_LIMIT',
    })))).toMatchObject({
      runId,
      language: 'python',
      status: 'resource_exceeded',
      signal: 'SIGKILL',
      durationMs: 15,
      oomKilled: true,
      errorCode: 'MEMORY_LIMIT',
      backendTruncated: false,
    });
  });

  it('rejects a mismatched run id or non-terminal result', () => {
    expect(() => normalizeExecutionResult(runId, result({ runId: '64b000000000000000000499' }))).toThrow('runId mismatch');
    expect(() => normalizeExecutionResult(runId, result({ status: 'running' }))).toThrow('terminal status');
  });

  it('bounds unexpectedly oversized worker output and marks it truncated', () => {
    const normalized = normalizeExecutionResult(runId, result({ stdout: 'x'.repeat(1_048_577) }));
    expect(Buffer.byteLength(normalized.stdout, 'utf8')).toBeLessThanOrEqual(1_048_576);
    expect(normalized.outputTruncated).toBe(true);
    expect(normalized.backendTruncated).toBe(true);
  });
});

describe('CodeRunReconciler', () => {
  it('persists active and completed transitions with UI/audit result fields', async () => {
    const markActive = jest.fn().mockResolvedValue(undefined);
    const complete = jest.fn().mockResolvedValue(undefined);
    const reconciler = new CodeRunReconciler(repository({ markActive, complete }), () => now);
    await reconciler.active(runId);
    await reconciler.completed(runId, result({ outputTruncated: true, signal: 'SIGTERM' }));

    expect(markActive).toHaveBeenCalledWith(runId, now);
    expect(complete).toHaveBeenCalledWith(runId, 'succeeded', {
      stdout: 'hello\n',
      stderr: '',
      exitCode: 0,
      signal: 'SIGTERM',
      executionTimeMs: 15,
      outputTruncated: true,
      oomKilled: false,
    }, now);
  });

  it('uses bounded internal_error reconciliation for malformed or failed jobs', async () => {
    const fail = jest.fn().mockResolvedValue(undefined);
    const reconciler = new CodeRunReconciler(repository({ fail }), () => now);
    await expect(reconciler.completed(runId, '{not json')).rejects.toThrow('Invalid runner result JSON');
    expect(fail).toHaveBeenNthCalledWith(
      1,
      runId,
      'INVALID_RUNNER_RESULT',
      'The isolated runner returned an invalid result.',
      now
    );

    await reconciler.failed(runId);
    expect(fail).toHaveBeenNthCalledWith(
      2,
      runId,
      'RUNNER_INTERNAL_ERROR',
      'The isolated code runner job failed.',
      now
    );
  });

  it.each([
    ['language', result({ language: 'javascript', stdout: 'untrusted language output' }), { _id: runId, language: 'python', runtimeVersion: '3.12' }],
    ['runtime version', result({ runtimeVersion: '99-malicious', stdout: 'untrusted runtime output' }), { _id: runId, language: 'python', runtimeVersion: '3.12' }],
    ['persisted run id', result({ stdout: 'untrusted identity output' }), { _id: '64b000000000000000000499', language: 'python', runtimeVersion: '3.12' }],
  ])('rejects a %s integrity mismatch without persisting untrusted result fields', async (_label, returned, expected) => {
    const complete = jest.fn().mockResolvedValue(undefined);
    const fail = jest.fn().mockResolvedValue(undefined);
    const findExpected = jest.fn().mockResolvedValue(expected);
    const reconciler = new CodeRunReconciler(repository({ findExpected, complete, fail }), () => now);

    await reconciler.completed(runId, returned);

    expect(findExpected).toHaveBeenCalledWith(runId);
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      runId,
      'RUNNER_RESULT_MISMATCH',
      'The isolated runner result did not match the queued code run.',
      now
    );
    expect(JSON.stringify(fail.mock.calls)).not.toContain('untrusted');
  });

  it('durably sweeps retained terminal/active jobs and bounds missing old records', async () => {
    const completedId = runId;
    const failedId = '64b000000000000000000402';
    const activeId = '64b000000000000000000403';
    const missingOldId = '64b000000000000000000404';
    const missingYoungId = '64b000000000000000000405';
    const waitingId = '64b000000000000000000406';
    const listPending = jest.fn().mockResolvedValue([
      { _id: completedId, status: 'running', queuedAt: new Date(now.getTime() - 120_000) },
      { _id: failedId, status: 'running', queuedAt: new Date(now.getTime() - 120_000) },
      { _id: activeId, status: 'queued', queuedAt: new Date(now.getTime() - 120_000) },
      { _id: missingOldId, status: 'queued', queuedAt: new Date(now.getTime() - 120_000) },
      { _id: missingYoungId, status: 'queued', queuedAt: new Date(now.getTime() - 1_000) },
      { _id: waitingId, status: 'queued', queuedAt: new Date(now.getTime() - 120_000) },
    ]);
    const complete = jest.fn().mockResolvedValue(undefined);
    const markActive = jest.fn().mockResolvedValue(undefined);
    const fail = jest.fn().mockResolvedValue(undefined);
    const queue = {
      getJob: jest.fn(async (id: string) => {
        if (id === completedId) return { getState: async (): Promise<string> => 'completed', returnvalue: result({ runId: completedId }) };
        if (id === failedId) return { getState: async (): Promise<string> => 'failed' };
        if (id === activeId) return { getState: async (): Promise<string> => 'active' };
        if (id === waitingId) return { getState: async (): Promise<string> => 'waiting' };
        return null;
      }),
    };
    const reconciler = new CodeRunReconciler(repository({ listPending, complete, markActive, fail }), () => now);

    await expect(reconciler.sweep(queue)).resolves.toEqual({
      examined: 6,
      reconciled: 4,
      deferred: 2,
      errors: 0,
    });
    expect(listPending).toHaveBeenCalledWith(1000);
    expect(complete).toHaveBeenCalledWith(completedId, 'succeeded', expect.any(Object), now);
    expect(markActive).toHaveBeenCalledWith(activeId, now);
    expect(fail).toHaveBeenCalledWith(failedId, 'RUNNER_INTERNAL_ERROR', 'The isolated code runner job failed.', now);
    expect(fail).toHaveBeenCalledWith(
      missingOldId,
      'RECONCILIATION_MISSED',
      'The isolated code runner result could not be reconciled.',
      now
    );
    expect(fail).not.toHaveBeenCalledWith(missingYoungId, expect.anything(), expect.anything(), expect.anything());
  });

  it('attaches active/completed/failed queue listeners', async () => {
    const events = new EventEmitter() as QueueEvents;
    const active = jest.fn().mockResolvedValue(undefined);
    const completed = jest.fn().mockResolvedValue(undefined);
    const failed = jest.fn().mockResolvedValue(undefined);
    attachCodeRunQueueEvents(events, { active, completed, failed } as unknown as CodeRunReconciler);
    const emitter = events as unknown as EventEmitter;
    emitter.emit('active', { jobId: runId });
    emitter.emit('completed', { jobId: runId, returnvalue: JSON.stringify(result()) });
    emitter.emit('failed', { jobId: runId, failedReason: 'failed' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(active).toHaveBeenCalledWith(runId);
    expect(completed).toHaveBeenCalledWith(runId, JSON.stringify(result()));
    expect(failed).toHaveBeenCalledWith(runId);
  });
});
