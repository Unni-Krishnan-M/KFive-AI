import { NotebookExecutionResult } from '@/services/notebookExecution';
import { NotebookRunRecord } from '@/services/notebookRunService';
import { NotebookExecutionEngine, NotebookWorkerRepository, NotebookWorkerRuntime } from './notebookWorker';

const runId = '64b000000000000000000301';
const ownerId = '64b000000000000000000001';
const notebookId = '64b000000000000000000201';
const now = new Date('2026-09-01T00:00:00.000Z');
const success: NotebookExecutionResult = { status: 'succeeded', durationMs: 10,
  runtimeImageId: 'a'.repeat(64), verifierImageId: 'b'.repeat(64), executedNotebookJson: '{"cells":[]}', metrics: [], artifacts: [] };

function record(overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord {
  return { _id: runId, ownerId, notebookId, notebookRevision: 1, snapshotSha256: 'c'.repeat(64),
    cells: [{ id: 'cell_one', type: 'code', source: 'print(1)', tags: [] }], cellTimeoutSeconds: 10,
    jobId: `notebook-${runId}`, status: 'queued', activeOwnerSlot: true, revision: 1,
    timeline: [{ revision: 1, sequence: 1, type: 'created', timestamp: now }], queuedAt: now, ...overrides };
}

function fixture(output: NotebookExecutionResult = success) {
  let current = record(); const events: string[] = [];
  const repository: NotebookWorkerRepository = {
    find: jest.fn(async () => structuredClone(current)),
    claim: jest.fn(async (_runId, workerId) => { events.push('claim'); current = { ...current, status: 'running', revision: 2,
      execution: { workerId, heartbeatAt: now } }; return structuredClone(current); }),
    heartbeat: jest.fn(async () => structuredClone(current)),
    beginVerification: jest.fn(async () => { events.push('verifying'); current = { ...current, status: 'verifying', revision: 3 };
      return structuredClone(current); }),
    complete: jest.fn(async (_runId, _workerId, result) => { events.push('complete'); current = { ...current,
      status: result.status === 'succeeded' ? 'succeeded' : result.status, revision: 4, activeOwnerSlot: false };
      return structuredClone(current); }),
    interrupt: jest.fn(async () => { events.push('interrupt'); current = { ...current, status: 'interrupted', activeOwnerSlot: false }; }),
  };
  const executor: NotebookExecutionEngine = {
    reapOwnedContainers: jest.fn(async () => 0),
    verifyHostSecurity: jest.fn(async () => undefined),
    imageIdentities: jest.fn(async () => ({ runtimeImageId: 'a'.repeat(64), verifierImageId: 'b'.repeat(64) })),
    execute: jest.fn(async (_request, _signal, lifecycle) => {
      events.push('runtime'); await lifecycle?.runtimeRemoved(); events.push('verifier'); return output;
    }),
  };
  return { repository, executor, events, runtime: new NotebookWorkerRuntime(repository, executor, 'worker-one', () => now),
    current: () => current };
}

describe('NotebookWorkerRuntime', () => {
  it('executes only the exact opaque BullMQ contract and persists verification ordering', async () => {
    const current = fixture();
    await expect(current.runtime.process({ id: `notebook-${runId}`, name: 'execute', data: { runId } }))
      .resolves.toEqual({ runId, status: 'succeeded' });
    expect(current.events).toEqual(['claim', 'runtime', 'verifying', 'verifier', 'complete']);
    expect(current.repository.complete).toHaveBeenCalledWith(runId, 'worker-one', success, now);
    await expect(current.runtime.process({ id: runId, name: 'execute', data: { runId } })).rejects.toThrow('contract');
    await expect(current.runtime.process({ id: `notebook-${runId}`, name: 'other', data: { runId } })).rejects.toThrow('contract');
  });

  it('skips a queue residue after canonical queued cancellation', async () => {
    const current = fixture();
    (current.repository.claim as jest.Mock).mockResolvedValue(null);
    (current.repository.find as jest.Mock).mockResolvedValue(record({ status: 'cancelled', activeOwnerSlot: false }));
    await expect(current.runtime.process({ id: `notebook-${runId}`, name: 'execute', data: { runId } }))
      .resolves.toEqual({ runId, status: 'cancelled' });
    expect(current.executor.execute).not.toHaveBeenCalled();
  });

  it('interrupts canonical state when isolation or terminal CAS fails', async () => {
    const current = fixture();
    (current.executor.execute as jest.Mock).mockRejectedValue(new Error('daemon lost'));
    await expect(current.runtime.process({ id: `notebook-${runId}`, name: 'execute', data: { runId } }))
      .rejects.toThrow('daemon lost');
    expect(current.repository.interrupt).toHaveBeenCalledWith(runId, 'worker-one', 'NOTEBOOK_WORKER_INTERRUPTED', now);
  });

  it('never commits a result after the worker loses its global lease', async () => {
    const current = fixture();
    let finish: ((value: NotebookExecutionResult) => void) | undefined;
    (current.executor.execute as jest.Mock).mockImplementation(() => new Promise<NotebookExecutionResult>((resolve) => { finish = resolve; }));
    const processing = current.runtime.process({ id: `notebook-${runId}`, name: 'execute', data: { runId } });
    await Promise.resolve();
    current.runtime.stop('lease-lost'); finish?.(success);
    await expect(processing).rejects.toThrow('authority');
    expect(current.repository.complete).not.toHaveBeenCalled();
    expect(current.repository.interrupt).toHaveBeenCalledWith(runId, 'worker-one', 'NOTEBOOK_WORKER_LEASE_LOST', now);
  });

  it('observes canonical cancellation even when the Redis notification is missed', async () => {
    jest.useFakeTimers();
    try {
      const current = fixture();
      (current.repository.heartbeat as jest.Mock).mockResolvedValue(record({ status: 'cancel-requested', revision: 3,
        execution: { workerId: 'worker-one', heartbeatAt: now } }));
      (current.executor.execute as jest.Mock).mockImplementation((_request, signal: AbortSignal) =>
        new Promise<NotebookExecutionResult>((resolve) => signal.addEventListener('abort', () => resolve({
          ...success, status: 'cancelled', executedNotebookJson: undefined,
        }), { once: true })));
      const processing = current.runtime.process({ id: `notebook-${runId}`, name: 'execute', data: { runId } });
      await jest.advanceTimersByTimeAsync(5_000);
      await expect(processing).resolves.toEqual({ runId, status: 'cancelled' });
      expect(current.repository.complete).toHaveBeenCalledWith(runId, 'worker-one',
        expect.objectContaining({ status: 'cancelled' }), now);
    } finally { jest.useRealTimers(); }
  });

  it('runs a real two-stage canary contract before advertising readiness', async () => {
    const current = fixture();
    await expect(current.runtime.selfCheck()).resolves.toEqual({ runtimeImageId: 'a'.repeat(64), verifierImageId: 'b'.repeat(64) });
    expect(current.executor.verifyHostSecurity).toHaveBeenCalled();
    expect(current.executor.reapOwnedContainers).toHaveBeenCalled();
    expect(current.executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      runId: expect.stringMatching(/^[a-f0-9]{24}$/), cells: [expect.objectContaining({ id: 'self_check' })],
    }));
  });

  it('does not self-certify a failed canary', async () => {
    const current = fixture({ ...success, status: 'failed', executedNotebookJson: undefined,
      error: { code: 'CELL_EXECUTION_FAILED', message: 'Notebook cell execution failed.' } });
    await expect(current.runtime.selfCheck()).rejects.toThrow('self-check');
  });
});
