import { randomUUID } from 'crypto';
import { Job, Worker } from 'bullmq';
import { RedisClientType } from 'redis';
import { BenchmarkRunModel } from '@/models/BenchmarkRun';
import { getQueueConnection } from '@/config/queues';
import { getRedisClient } from '@/config/redis';
import { logger } from '@/utils/logger';
import { BENCHMARK_WORKER_SHUTDOWN_REASON, BenchmarkExecutor } from '@/services/benchmarkExecutor';
import {
  BENCHMARK_CANCEL_CHANNEL,
  BENCHMARK_QUEUE_NAME,
  BENCHMARK_WORKER_HEARTBEAT_KEY,
  BenchmarkJobPayload,
} from '@/services/benchmarkQueue';
import { BenchmarkResourceLease } from '@/services/benchmarkResourceLease';

const objectId = /^[a-f\d]{24}$/i;

export class BenchmarkWorkerRuntime {
  private readonly instanceId = randomUUID();
  private readonly active = new Map<string, AbortController>();
  private readonly stopping = new AbortController();

  constructor(
    private readonly redis: RedisClientType = getRedisClient(),
    private readonly executor = new BenchmarkExecutor(),
    private readonly retryMs = 250,
    private readonly leaseFactory: () => Pick<BenchmarkResourceLease, 'tryAcquire'> = () => new BenchmarkResourceLease(this.redis)
  ) {}

  async process(job: Job<BenchmarkJobPayload>): Promise<void> {
    const keys = job.data && typeof job.data === 'object' ? Object.keys(job.data) : [];
    if (keys.length !== 1 || keys[0] !== 'runId' || typeof job.data.runId !== 'string' || !objectId.test(job.data.runId)) {
      throw new Error('Benchmark queue job must contain exactly one runId.');
    }
    const runId = job.data.runId;
    while (!this.stopping.signal.aborted) {
      const run = await BenchmarkRunModel.findById(runId).select({ status: 1 }).lean<{ status: string }>();
      if (!run || ['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted'].includes(run.status)) return;
      const lease = await this.leaseFactory().tryAcquire(this.instanceId);
      if (!lease) { await this.waitForLeaseRetry(); continue; }
      if (this.stopping.signal.aborted) { await lease.release(); return; }
      const controller = new AbortController(); this.active.set(runId, controller);
      try { await this.executor.execute(runId, lease, controller.signal); }
      finally { this.active.delete(runId); await lease.release(); }
      return;
    }
  }

  cancel(runId: string): void { this.active.get(runId)?.abort('user-cancelled'); }
  stop(): void {
    this.stopping.abort(BENCHMARK_WORKER_SHUTDOWN_REASON);
    for (const controller of this.active.values()) controller.abort(BENCHMARK_WORKER_SHUTDOWN_REASON);
  }

  private async waitForLeaseRetry(): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return; settled = true; clearTimeout(timer);
        this.stopping.signal.removeEventListener('abort', finish); resolve();
      };
      const timer = setTimeout(finish, this.retryMs);
      if (this.stopping.signal.aborted) finish();
      else this.stopping.signal.addEventListener('abort', finish, { once: true });
    });
  }
}

export interface BenchmarkWorkerHandle {
  worker: Worker<BenchmarkJobPayload>;
  subscriber: RedisClientType;
  close(): Promise<void>;
}

export async function startBenchmarkWorker(): Promise<BenchmarkWorkerHandle> {
  const redis = getRedisClient(); const runtime = new BenchmarkWorkerRuntime(redis);
  const subscriber = redis.duplicate(); await subscriber.connect();
  await subscriber.subscribe(BENCHMARK_CANCEL_CHANNEL, (runId) => { if (objectId.test(runId)) runtime.cancel(runId); });
  const worker = new Worker<BenchmarkJobPayload>(BENCHMARK_QUEUE_NAME, (job) => runtime.process(job), {
    connection: getQueueConnection(), concurrency: 1, maxStalledCount: 0, lockDuration: 60_000,
  });
  await worker.waitUntilReady();
  const heartbeat = async () => redis.set(BENCHMARK_WORKER_HEARTBEAT_KEY, String(Date.now()), { PX: 15_000 });
  await heartbeat();
  const timer = setInterval(() => void heartbeat().catch(() => logger.error('Benchmark worker heartbeat failed')), 5_000); timer.unref();
  worker.on('failed', (job, error) => logger.error('Benchmark queue job failed', { runId: job?.data.runId, error: error.message }));
  return { worker, subscriber, close: async () => {
    clearInterval(timer); runtime.stop(); await worker.close(); await subscriber.unsubscribe(BENCHMARK_CANCEL_CHANNEL); await subscriber.quit();
  } };
}
