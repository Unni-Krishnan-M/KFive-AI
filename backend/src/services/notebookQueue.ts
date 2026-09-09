import { Queue } from 'bullmq';
import { getNotebookRunsQueue } from '@/config/queues';
import { getRedisClient } from '@/config/redis';

export const NOTEBOOK_QUEUE_NAME = 'notebook-runs';
export const NOTEBOOK_JOB_NAME = 'execute';
export const NOTEBOOK_JOB_PREFIX = 'notebook-';
export const NOTEBOOK_CANCEL_CHANNEL = 'kfive:notebook:cancel';
export const NOTEBOOK_WORKER_HEARTBEAT_KEY = 'kfive:notebook:worker-heartbeat';
export const NOTEBOOK_WORKER_LEASE_KEY = 'kfive:notebook:worker-lease';

export interface NotebookJobPayload { runId: string }
export interface NotebookWorkerStatus {
  workerAvailable: boolean;
  isolationVerified: boolean;
  runtimeImageId?: string;
  verifierImageId?: string;
}

export interface NotebookQueueDispatcher {
  enqueue(runId: string): Promise<void>;
  remove(runId: string): Promise<void>;
  wakeCancellation(runId: string): Promise<void>;
  executionStatus(): Promise<NotebookWorkerStatus>;
}

interface MinimalRedis {
  publish(channel: string, message: string): Promise<number>;
  get(key: string): Promise<string | null>;
}

export function notebookJobId(runId: string): string {
  return `${NOTEBOOK_JOB_PREFIX}${runId}`;
}

function parseHeartbeat(value: string | null, now: number): NotebookWorkerStatus {
  if (!value) return { workerAvailable: false, isolationVerified: false };
  try {
    const input = JSON.parse(value) as Record<string, unknown>;
    const timestamp = typeof input.timestamp === 'number' ? input.timestamp : Number.NaN;
    const runtimeImageId = typeof input.runtimeImageId === 'string' && /^[a-f0-9]{64}$/.test(input.runtimeImageId)
      ? input.runtimeImageId : undefined;
    const verifierImageId = typeof input.verifierImageId === 'string' && /^[a-f0-9]{64}$/.test(input.verifierImageId)
      ? input.verifierImageId : undefined;
    const workerAvailable = Number.isFinite(timestamp) && now - timestamp >= 0 && now - timestamp <= 15_000;
    const isolationVerified = workerAvailable && input.isolationVerified === true
      && runtimeImageId !== undefined && verifierImageId !== undefined && runtimeImageId !== verifierImageId;
    return { workerAvailable, isolationVerified, runtimeImageId, verifierImageId };
  } catch {
    return { workerAvailable: false, isolationVerified: false };
  }
}

export class BullMqNotebookQueueDispatcher implements NotebookQueueDispatcher {
  constructor(
    private readonly queue: () => Queue = getNotebookRunsQueue,
    private readonly redis: () => MinimalRedis = getRedisClient,
    private readonly now: () => number = Date.now
  ) {}

  async enqueue(runId: string): Promise<void> {
    const queue = this.queue();
    const jobId = notebookJobId(runId);
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== 'completed' && state !== 'failed') return;
      try { await existing.remove(); }
      catch (error) { if (await queue.getJob(jobId)) throw error; }
    }
    await queue.add(NOTEBOOK_JOB_NAME, { runId } satisfies NotebookJobPayload, {
      jobId, attempts: 1, removeOnComplete: 100, removeOnFail: 100,
    });
  }

  async remove(runId: string): Promise<void> {
    const job = await this.queue().getJob(notebookJobId(runId));
    if (job) await job.remove();
  }

  async wakeCancellation(runId: string): Promise<void> {
    await this.redis().publish(NOTEBOOK_CANCEL_CHANNEL, runId);
  }

  async executionStatus(): Promise<NotebookWorkerStatus> {
    return parseHeartbeat(await this.redis().get(NOTEBOOK_WORKER_HEARTBEAT_KEY), this.now());
  }
}

export const notebookQueueDispatcher = new BullMqNotebookQueueDispatcher();
export { parseHeartbeat };
