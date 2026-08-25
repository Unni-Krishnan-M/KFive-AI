import { RunnerCoordinator } from './coordinator';
import { CODE_RUN_JOB, CODE_RUN_QUEUE, QueueJobLike, QueueWorkerFactory, QueueWorkerHandle } from './queueWorker';
import { ExecutionResult, RunnerValidationError } from './types';

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface ExecutionEngine {
  execute(request: unknown, cancellation?: AbortSignal): Promise<ExecutionResult>;
}

export interface WorkerHostOptions {
  concurrency: number;
  heartbeatIntervalMs?: number;
  heartbeatTtlSeconds?: number;
  now?: () => Date;
  onError?: (event: string) => void;
}

function readRunId(job: QueueJobLike): string {
  if (job.name !== CODE_RUN_JOB) throw new RunnerValidationError(`Unsupported queue job '${job.name}'.`);
  if (!job.data || typeof job.data !== 'object' || Array.isArray(job.data)) {
    throw new RunnerValidationError('Code-run job data must be an object.');
  }
  const runId = (job.data as Record<string, unknown>).runId;
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new RunnerValidationError('Code-run job has an invalid runId.');
  }
  if (job.id !== undefined && job.id !== runId) {
    throw new RunnerValidationError('BullMQ job id must equal the code-run runId.');
  }
  return runId;
}

export class CodeRunnerWorkerHost {
  private readonly active = new Map<string, AbortController>();
  private readonly now: () => Date;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTtlSeconds: number;
  private readonly onError: (event: string) => void;
  private worker?: QueueWorkerHandle;
  private heartbeatTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    private readonly workerFactory: QueueWorkerFactory,
    private readonly coordinator: RunnerCoordinator,
    private readonly executor: ExecutionEngine,
    options: WorkerHostOptions
  ) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) {
      throw new RunnerValidationError('Worker concurrency must be an integer between 1 and 8.');
    }
    this.now = options.now ?? (() => new Date());
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.heartbeatTtlSeconds = options.heartbeatTtlSeconds ?? 15;
    this.onError = options.onError ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.worker || this.stopping) throw new Error('Code-runner worker host cannot be started twice.');
    await this.coordinator.connect((runId) => this.cancelActive(runId));
    try {
      this.worker = await this.workerFactory.create(CODE_RUN_QUEUE, (job) => this.process(job));
      await this.writeHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        void this.writeHeartbeat().catch(() => this.onError('heartbeat-write-error'));
      }, this.heartbeatIntervalMs);
      this.heartbeatTimer.unref();
    } catch (error) {
      await this.worker?.close().catch(() => undefined);
      this.worker = undefined;
      await this.coordinator.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const controller of this.active.values()) controller.abort();
    await this.worker?.close().catch(() => undefined);
    await this.coordinator.clearHeartbeat().catch(() => undefined);
    await this.coordinator.close();
    this.worker = undefined;
  }

  private cancelActive(runId: string): void {
    if (!RUN_ID_PATTERN.test(runId)) return;
    this.active.get(runId)?.abort();
  }

  private async process(job: QueueJobLike): Promise<ExecutionResult> {
    if (this.stopping) throw new Error('Code-runner worker is shutting down.');
    const runId = readRunId(job);
    const controller = new AbortController();
    this.active.set(runId, controller);
    try {
      if (await this.coordinator.isCancellationRequested(runId)) controller.abort();
      await job.updateProgress({ status: controller.signal.aborted ? 'cancelled' : 'running' });
      return await this.executor.execute(job.data, controller.signal);
    } finally {
      this.active.delete(runId);
      await this.coordinator.clearCancellation(runId).catch(() => undefined);
    }
  }

  private async writeHeartbeat(): Promise<void> {
    await this.coordinator.writeHeartbeat(this.now().getTime(), this.heartbeatTtlSeconds);
  }
}

export { readRunId };
