import assert from 'node:assert/strict';
import test from 'node:test';
import { RunnerCoordinator } from '../src/coordinator';
import { CODE_RUN_QUEUE, QueueJobLike, QueueProcessor, QueueWorkerFactory, QueueWorkerHandle } from '../src/queueWorker';
import { ExecutionEngine, CodeRunnerWorkerHost } from '../src/workerHost';
import { ExecutionResult, RunnerValidationError } from '../src/types';

class FakeCoordinator implements RunnerCoordinator {
  cancellationHandler?: (runId: string) => void;
  readonly cancelled = new Set<string>();
  readonly cleared: string[] = [];
  readonly heartbeats: Array<{ value: number; ttl: number }> = [];
  connected = false;
  heartbeatCleared = false;
  closed = false;

  async connect(handler: (runId: string) => void): Promise<void> {
    this.connected = true;
    this.cancellationHandler = handler;
  }

  async isCancellationRequested(runId: string): Promise<boolean> {
    return this.cancelled.has(runId);
  }

  async clearCancellation(runId: string): Promise<void> {
    this.cleared.push(runId);
    this.cancelled.delete(runId);
  }

  async writeHeartbeat(value: number, ttl: number): Promise<void> {
    this.heartbeats.push({ value, ttl });
  }

  async clearHeartbeat(): Promise<void> {
    this.heartbeatCleared = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  cancel(runId: string): void {
    this.cancellationHandler?.(runId);
  }
}

class FakeWorkerFactory implements QueueWorkerFactory {
  queueName?: string;
  processor?: QueueProcessor;
  closed = false;

  async create(queueName: string, processor: QueueProcessor): Promise<QueueWorkerHandle> {
    this.queueName = queueName;
    this.processor = processor;
    return { close: async () => { this.closed = true; } };
  }

  async run(job: QueueJobLike): Promise<ExecutionResult> {
    if (!this.processor) throw new Error('Worker has not started.');
    return this.processor(job);
  }
}

class FakeExecutor implements ExecutionEngine {
  readonly calls: Array<{ request: unknown; signal?: AbortSignal }> = [];

  constructor(
    private readonly handler: (request: unknown, signal?: AbortSignal) => Promise<ExecutionResult>
      = async (request) => successfulResult((request as { runId: string }).runId)
  ) {}

  execute(request: unknown, signal?: AbortSignal): Promise<ExecutionResult> {
    this.calls.push({ request, signal });
    return this.handler(request, signal);
  }
}

function successfulResult(runId: string, overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    runId,
    language: 'python',
    runtimeVersion: '3.12',
    status: 'succeeded',
    stdout: 'ok\n',
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 1,
    outputTruncated: false,
    oomKilled: false,
    ...overrides,
  };
}

function job(runId: string, overrides: Partial<QueueJobLike> = {}): QueueJobLike & { progress: object[] } {
  const progress: object[] = [];
  return {
    id: runId,
    name: 'execute',
    data: { runId, language: 'python', source: 'print(1)', stdin: '' },
    updateProgress: async (value) => { progress.push(value); },
    progress,
    ...overrides,
  };
}

function host(
  factory: FakeWorkerFactory,
  coordinator: FakeCoordinator,
  executor: ExecutionEngine
): CodeRunnerWorkerHost {
  return new CodeRunnerWorkerHost(factory, coordinator, executor, {
    concurrency: 2,
    heartbeatIntervalMs: 60_000,
    heartbeatTtlSeconds: 15,
    now: () => new Date('2026-08-24T00:00:00.000Z'),
  });
}

test('starts only the code-runs queue, writes a TTL heartbeat, and returns typed results', async () => {
  const factory = new FakeWorkerFactory();
  const coordinator = new FakeCoordinator();
  const executor = new FakeExecutor();
  const workerHost = host(factory, coordinator, executor);
  await workerHost.start();

  const queuedJob = job('run-1');
  const result = await factory.run(queuedJob);

  assert.equal(factory.queueName, CODE_RUN_QUEUE);
  assert.equal(coordinator.connected, true);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(queuedJob.progress, [{ status: 'running' }]);
  assert.deepEqual(coordinator.cleared, ['run-1']);
  assert.deepEqual(coordinator.heartbeats[0], { ttl: 15, value: 1_787_529_600_000 });
  await workerHost.stop();
});

test('rejects unknown job names and a BullMQ id that differs from runId', async () => {
  const factory = new FakeWorkerFactory();
  const coordinator = new FakeCoordinator();
  const executor = new FakeExecutor();
  const workerHost = host(factory, coordinator, executor);
  await workerHost.start();

  await assert.rejects(factory.run(job('one', { name: 'shell' })), RunnerValidationError);
  await assert.rejects(factory.run(job('one', { id: 'two' })), /job id must equal/);
  assert.equal(executor.calls.length, 0);
  await workerHost.stop();
});

test('honors a cancellation key before execution starts', async () => {
  const factory = new FakeWorkerFactory();
  const coordinator = new FakeCoordinator();
  coordinator.cancelled.add('pre-cancel');
  const executor = new FakeExecutor(async (request, signal) => successfulResult(
    (request as { runId: string }).runId,
    {
      status: signal?.aborted ? 'cancelled' : 'succeeded',
      exitCode: null,
      errorCode: signal?.aborted ? 'CANCELLED' : undefined,
    }
  ));
  const workerHost = host(factory, coordinator, executor);
  await workerHost.start();

  const queuedJob = job('pre-cancel');
  const result = await factory.run(queuedJob);

  assert.equal(result.status, 'cancelled');
  assert.equal(executor.calls[0].signal?.aborted, true);
  assert.deepEqual(queuedJob.progress, [{ status: 'cancelled' }]);
  assert.deepEqual(coordinator.cleared, ['pre-cancel']);
  await workerHost.stop();
});

test('maps cancellation channel messages to the active run AbortController', async () => {
  const factory = new FakeWorkerFactory();
  const coordinator = new FakeCoordinator();
  const executor = new FakeExecutor(async (request, signal) => new Promise((resolve) => {
    signal?.addEventListener('abort', () => resolve(successfulResult(
      (request as { runId: string }).runId,
      { status: 'cancelled', exitCode: null, errorCode: 'CANCELLED' }
    )), { once: true });
  }));
  const workerHost = host(factory, coordinator, executor);
  await workerHost.start();

  const running = factory.run(job('active-cancel'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  coordinator.cancel('active-cancel');
  const result = await running;

  assert.equal(result.status, 'cancelled');
  assert.equal(executor.calls[0].signal?.aborted, true);
  assert.deepEqual(coordinator.cleared, ['active-cancel']);
  await workerHost.stop();
});

test('graceful shutdown aborts active execution and clears worker/heartbeat/coordinator', async () => {
  const factory = new FakeWorkerFactory();
  const coordinator = new FakeCoordinator();
  const executor = new FakeExecutor(async (request, signal) => new Promise((resolve) => {
    signal?.addEventListener('abort', () => resolve(successfulResult(
      (request as { runId: string }).runId,
      { status: 'cancelled', exitCode: null, errorCode: 'CANCELLED' }
    )), { once: true });
  }));
  const workerHost = host(factory, coordinator, executor);
  await workerHost.start();
  const running = factory.run(job('shutdown-run'));
  await new Promise<void>((resolve) => setImmediate(resolve));

  await workerHost.stop();
  const result = await running;

  assert.equal(result.status, 'cancelled');
  assert.equal(factory.closed, true);
  assert.equal(coordinator.heartbeatCleared, true);
  assert.equal(coordinator.closed, true);
});

test('rejects unsafe worker concurrency before connecting', () => {
  assert.throws(
    () => new CodeRunnerWorkerHost(
      new FakeWorkerFactory(),
      new FakeCoordinator(),
      new FakeExecutor(),
      { concurrency: 9 }
    ),
    /concurrency/
  );
});
