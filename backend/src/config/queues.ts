import { ConnectionOptions, Queue, QueueEvents, Worker } from 'bullmq';
import { logger } from '@/utils/logger';
import { getEnvironment } from './environment';
import { attachCodeRunQueueEvents, CodeRunReconciler } from '@/services/codeRunReconciler';

let aiProcessingQueue: Queue;
let codeRunsQueue: Queue;
let codeRunQueueEvents: QueueEvents;
let benchmarkRunsQueue: Queue;
let notebookRunsQueue: Queue;
let codeRunReconciliationTimer: NodeJS.Timeout | undefined;
let codeRunReconciliationInProgress = false;
const workers: Worker[] = [];
const CODE_RUN_RECONCILIATION_INTERVAL_MS = 10_000;

export function getQueueConnection(): ConnectionOptions {
  const parsed = new URL(process.env.QUEUE_REDIS_URL || getEnvironment().redisUrl);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
  };
}

export async function initializeQueues(codeRunReconciler: CodeRunReconciler = new CodeRunReconciler()): Promise<void> {
  try {
    const connection = getQueueConnection();
    
    // AI Processing Queue
    aiProcessingQueue = new Queue('ai-processing', {
      connection,
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    });

    // Producer-only queue. Code execution workers run in the isolated code-runner service.
    codeRunsQueue = new Queue('code-runs', {
      connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    });
    // Producer only. A dedicated benchmark-worker process owns provider execution.
    benchmarkRunsQueue = new Queue('benchmark-runs', {
      connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    });
    // Producer only. Notebook code is never executed by the API process.
    notebookRunsQueue = new Queue('notebook-runs', {
      connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    });
    codeRunQueueEvents = new QueueEvents('code-runs', { connection, lastEventId: '0-0' });
    attachCodeRunQueueEvents(codeRunQueueEvents, codeRunReconciler);
    await codeRunQueueEvents.waitUntilReady();
    await codeRunReconciler.sweep(codeRunsQueue);
    codeRunReconciliationTimer = setInterval(() => {
      if (codeRunReconciliationInProgress) return;
      codeRunReconciliationInProgress = true;
      void codeRunReconciler.sweep(codeRunsQueue)
        .catch(() => logger.error('Periodic code run reconciliation failed', { event: 'periodic-sweep' }))
        .finally(() => { codeRunReconciliationInProgress = false; });
    }, CODE_RUN_RECONCILIATION_INTERVAL_MS);
    codeRunReconciliationTimer.unref();

    // Initialize workers
    initializeWorkers(connection);

    logger.info('✅ Background queues initialized');
  } catch (error) {
    logger.error('Failed to initialize queues:', error);
    throw error;
  }
}

function initializeWorkers(connection: ConnectionOptions): void {
  // AI Processing Worker
  const aiWorker = new Worker('ai-processing', async (job) => {
    const { type } = job.data;
    
    switch (type) {
      case 'generate-response':
      case 'generate-embeddings':
        throw new Error(`AI queue job ${type} is not implemented`);
      default:
        throw new Error(`Unknown AI processing job type: ${type}`);
    }
  }, {
    connection,
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY || '5'),
  });

  // Document processing must run only in a separate constrained service. The API
  // process deliberately owns no document worker while that service is unavailable.
  workers.push(aiWorker);
}

export async function closeQueues(): Promise<void> {
  if (codeRunReconciliationTimer) clearInterval(codeRunReconciliationTimer);
  codeRunReconciliationTimer = undefined;
  codeRunReconciliationInProgress = false;
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  await Promise.all([
    aiProcessingQueue?.close(),
    codeRunsQueue?.close(),
    benchmarkRunsQueue?.close(),
    notebookRunsQueue?.close(),
    codeRunQueueEvents?.close(),
  ].filter((operation): operation is Promise<void> => Boolean(operation)));
}

export function getAiProcessingQueue(): Queue {
  if (!aiProcessingQueue) {
    throw new Error('AI processing queue not initialized');
  }
  return aiProcessingQueue;
}

export function getCodeRunsQueue(): Queue {
  if (!codeRunsQueue) {
    throw new Error('Code runs queue not initialized');
  }
  return codeRunsQueue;
}

export function getBenchmarkRunsQueue(): Queue {
  if (!benchmarkRunsQueue) throw new Error('Benchmark runs queue not initialized');
  return benchmarkRunsQueue;
}

export function getNotebookRunsQueue(): Queue {
  if (!notebookRunsQueue) throw new Error('Notebook runs queue not initialized');
  return notebookRunsQueue;
}
