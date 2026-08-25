import { Job, Worker } from 'bullmq';
import { ExecutionResult } from './types';
import { ParsedRedisConfig } from './redisConfig';

export const CODE_RUN_QUEUE = 'code-runs';
export const CODE_RUN_JOB = 'execute';

export interface QueueJobLike {
  id?: string;
  name: string;
  data: unknown;
  updateProgress(progress: object): Promise<void>;
}

export type QueueProcessor = (job: QueueJobLike) => Promise<ExecutionResult>;

export interface QueueWorkerHandle {
  close(): Promise<void>;
}

export interface QueueWorkerFactory {
  create(queueName: string, processor: QueueProcessor): Promise<QueueWorkerHandle>;
}

export class BullMqWorkerFactory implements QueueWorkerFactory {
  constructor(
    private readonly connection: ParsedRedisConfig,
    private readonly concurrency: number,
    private readonly onError: (event: string) => void = () => undefined
  ) {}

  async create(queueName: string, processor: QueueProcessor): Promise<QueueWorkerHandle> {
    const worker = new Worker<unknown, ExecutionResult>(
      queueName,
      async (job: Job<unknown>) => processor({
        id: job.id,
        name: job.name,
        data: job.data,
        updateProgress: (progress) => job.updateProgress(progress),
      }),
      {
        connection: this.connection,
        concurrency: this.concurrency,
        lockDuration: 60_000,
      }
    );
    worker.on('error', () => this.onError('bullmq-worker-error'));
    try {
      await worker.waitUntilReady();
    } catch {
      await worker.close(true).catch(() => undefined);
      throw new Error('The code-runner queue worker could not become ready.');
    }
    return { close: () => worker.close(false) };
  }
}
