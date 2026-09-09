import { Queue } from 'bullmq';
import { getBenchmarkRunsQueue } from '@/config/queues';
import { getRedisClient } from '@/config/redis';

export const BENCHMARK_QUEUE_NAME = 'benchmark-runs';
export const BENCHMARK_JOB_NAME = 'execute';
export const BENCHMARK_JOB_PREFIX = 'benchmark-';
export const BENCHMARK_CANCEL_CHANNEL = 'kfive:benchmark:cancel';
export const BENCHMARK_RESOURCE_LEASE_KEY = 'kfive:benchmark:resource-lease';
export const BENCHMARK_RESOURCE_FENCE_KEY = 'kfive:benchmark:resource-fence';
export const BENCHMARK_WORKER_HEARTBEAT_KEY = 'kfive:benchmark:worker-heartbeat';

export interface BenchmarkJobPayload { runId: string }

export interface BenchmarkQueueDispatcher {
  enqueue(runId: string): Promise<void>;
  wakeCancellation(runId: string): Promise<void>;
  executionStatus(): Promise<{ active: boolean; workerAvailable: boolean }>;
  remove(runId: string): Promise<void>;
}

interface MinimalRedis {
  publish(channel: string, message: string): Promise<number>;
  get(key: string): Promise<string | null>;
}

export function benchmarkJobId(runId: string): string {
  return `${BENCHMARK_JOB_PREFIX}${runId}`;
}

export class BullMqBenchmarkQueueDispatcher implements BenchmarkQueueDispatcher {
  constructor(
    private readonly queue: () => Queue = getBenchmarkRunsQueue,
    private readonly redis: () => MinimalRedis = getRedisClient,
    private readonly now: () => number = Date.now
  ) {}

  async enqueue(runId: string): Promise<void> {
    const queue = this.queue();
    const jobId = benchmarkJobId(runId);
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== 'completed' && state !== 'failed') return;
      try {
        await existing.remove();
      } catch (error) {
        // A second dispatcher may have removed the retained terminal job first.
        // Only suppress that race; a still-present job means Redis removal failed.
        if (await queue.getJob(jobId)) throw error;
      }
    }
    await queue.add(BENCHMARK_JOB_NAME, { runId } satisfies BenchmarkJobPayload, {
      jobId,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  }

  async wakeCancellation(runId: string): Promise<void> {
    await this.redis().publish(BENCHMARK_CANCEL_CHANNEL, runId);
  }

  async executionStatus(): Promise<{ active: boolean; workerAvailable: boolean }> {
    const [lease, heartbeat] = await Promise.all([
      this.redis().get(BENCHMARK_RESOURCE_LEASE_KEY),
      this.redis().get(BENCHMARK_WORKER_HEARTBEAT_KEY),
    ]);
    const heartbeatAt = heartbeat === null ? Number.NaN : Number(heartbeat);
    return { active: lease !== null, workerAvailable: Number.isFinite(heartbeatAt) && this.now() - heartbeatAt <= 15_000 };
  }

  async remove(runId: string): Promise<void> {
    const job = await this.queue().getJob(benchmarkJobId(runId));
    if (job) await job.remove();
  }
}

export const benchmarkQueueDispatcher = new BullMqBenchmarkQueueDispatcher();
