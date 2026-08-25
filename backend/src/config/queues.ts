import { ConnectionOptions, Queue, QueueEvents, Worker } from 'bullmq';
import { logger } from '@/utils/logger';
import { getEnvironment } from './environment';
import { attachCodeRunQueueEvents, CodeRunReconciler } from '@/services/codeRunReconciler';

let aiProcessingQueue: Queue;
let documentProcessingQueue: Queue;
let codeRunsQueue: Queue;
let codeRunQueueEvents: QueueEvents;
let codeRunReconciliationTimer: NodeJS.Timeout | undefined;
let codeRunReconciliationInProgress = false;
const workers: Worker[] = [];
const CODE_RUN_RECONCILIATION_INTERVAL_MS = 10_000;

function getQueueConnection(): ConnectionOptions {
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

    // Document Processing Queue
    documentProcessingQueue = new Queue('document-processing', {
      connection,
      defaultJobOptions: {
        removeOnComplete: 50,
        removeOnFail: 25,
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 1000,
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

  // Document Processing Worker
  const documentWorker = new Worker('document-processing', async (job) => {
    // To avoid cyclical dependencies in prompt setup we dynamically require Mongoose
    const mongoose = require('mongoose');
    const DocumentModel = mongoose.model('Document');
    
    // Fallback extraction for direct job matches or legacy structure
    const docId = job.data?.documentId;
    if (!docId) {
      throw new Error('Document processing job is missing documentId');
    }

    try {
      const doc = await DocumentModel.findById(docId);
      if (!doc) {
        throw new Error(`Document ${docId} no longer exists`);
      }

      doc.status = 'processing';
      await doc.save();

      const fs = require('fs');
      if (fs.existsSync(doc.path)) {
        doc.status = 'failed';
        doc.errorMessage = 'Document processor is not configured';
      } else {
        doc.status = 'failed';
        doc.errorMessage = 'File not found on disk';
      }

      await doc.save();
      throw new Error(doc.errorMessage);
    } catch (e: any) {
      logger.error('Document processing job failed', { documentId: docId, error: e.message });
      if (docId) {
        await DocumentModel.findByIdAndUpdate(docId, { status: 'failed', errorMessage: e.message });
      }
      throw e;
    }
  }, {
    connection,
    concurrency: 3,
  });

  workers.push(aiWorker, documentWorker);
}

export async function closeQueues(): Promise<void> {
  if (codeRunReconciliationTimer) clearInterval(codeRunReconciliationTimer);
  codeRunReconciliationTimer = undefined;
  codeRunReconciliationInProgress = false;
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  await Promise.all([
    aiProcessingQueue?.close(),
    documentProcessingQueue?.close(),
    codeRunsQueue?.close(),
    codeRunQueueEvents?.close(),
  ].filter((operation): operation is Promise<void> => Boolean(operation)));
}

export function getAiProcessingQueue(): Queue {
  if (!aiProcessingQueue) {
    throw new Error('AI processing queue not initialized');
  }
  return aiProcessingQueue;
}

export function getDocumentProcessingQueue(): Queue {
  if (!documentProcessingQueue) {
    throw new Error('Document processing queue not initialized');
  }
  return documentProcessingQueue;
}

export function getCodeRunsQueue(): Queue {
  if (!codeRunsQueue) {
    throw new Error('Code runs queue not initialized');
  }
  return codeRunsQueue;
}
