import { BenchmarkRunModel } from '@/models/BenchmarkRun';
import { BENCHMARK_WORKER_SHUTDOWN_REASON } from '@/services/benchmarkExecutor';
import { BenchmarkWorkerRuntime } from './benchmarkWorker';

const runId = '64b000000000000000000201';

function mockCanonicalStatus(status = 'queued') {
  jest.spyOn(BenchmarkRunModel, 'findById').mockReturnValue({
    select: () => ({ lean: async () => ({ status }) }),
  } as any);
}

function lease() {
  const controller = new AbortController();
  return {
    fence: 1,
    owner: '1-worker-token',
    signal: controller.signal,
    lost: new Promise<void>(() => undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
}

describe('BenchmarkWorkerRuntime', () => {
  afterEach(() => jest.restoreAllMocks());

  it('rejects every queue payload except exactly one object id', async () => {
    const runtime = new BenchmarkWorkerRuntime({} as any, {} as any, 1, () => ({ tryAcquire: jest.fn() }));
    await expect(runtime.process({ data: { runId, ownerId: runId } } as any)).rejects.toThrow('exactly one runId');
    await expect(runtime.process({ data: { runId: 'not-an-id' } } as any)).rejects.toThrow('exactly one runId');
  });

  it('acquires one fenced resource slot, executes by opaque id, and releases it', async () => {
    mockCanonicalStatus();
    const handle = lease();
    const execute = jest.fn().mockResolvedValue(undefined);
    const tryAcquire = jest.fn().mockResolvedValue(handle);
    const runtime = new BenchmarkWorkerRuntime({} as any, { execute } as any, 1, () => ({ tryAcquire }));
    await runtime.process({ data: { runId } } as any);
    expect(tryAcquire).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(runId, handle, expect.any(AbortSignal));
    expect(handle.release).toHaveBeenCalledTimes(1);
  });

  it('delivers cross-replica Pub/Sub cancellation to the active executor signal', async () => {
    mockCanonicalStatus();
    const handle = lease();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const execute = jest.fn().mockImplementation(async (_runId, _lease, signal: AbortSignal) => {
      started();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const runtime = new BenchmarkWorkerRuntime({} as any, { execute } as any, 1,
      () => ({ tryAcquire: jest.fn().mockResolvedValue(handle) }));
    const processing = runtime.process({ data: { runId } } as any);
    await ready;
    runtime.cancel(runId);
    await processing;
    expect(handle.release).toHaveBeenCalledTimes(1);
  });

  it('marks graceful shutdown separately from user cancellation', async () => {
    mockCanonicalStatus();
    const handle = lease();
    let observedReason: unknown;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const execute = jest.fn().mockImplementation(async (_runId, _lease, signal: AbortSignal) => {
      started();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => {
        observedReason = signal.reason; resolve();
      }, { once: true }));
    });
    const runtime = new BenchmarkWorkerRuntime({} as any, { execute } as any, 1,
      () => ({ tryAcquire: jest.fn().mockResolvedValue(handle) }));
    const processing = runtime.process({ data: { runId } } as any);
    await ready;
    runtime.stop();
    await processing;
    expect(observedReason).toBe(BENCHMARK_WORKER_SHUTDOWN_REASON);
  });

  it('stops promptly while waiting for the shared resource lease', async () => {
    mockCanonicalStatus();
    const execute = jest.fn();
    const runtime = new BenchmarkWorkerRuntime({} as any, { execute } as any, 60_000,
      () => ({ tryAcquire: jest.fn().mockResolvedValue(undefined) }));
    const processing = runtime.process({ data: { runId } } as any);
    await new Promise((resolve) => setImmediate(resolve));
    runtime.stop();
    await processing;
    expect(execute).not.toHaveBeenCalled();
  });
});
