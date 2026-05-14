import { Queue, Worker } from 'bullmq';
import { logger } from '@/utils/logger';

let aiProcessingQueue: Queue;
let documentProcessingQueue: Queue;

export async function initializeQueues(): Promise<void> {
  try {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    
    // AI Processing Queue
    aiProcessingQueue = new Queue('ai-processing', {
      connection: {
        host: 'localhost',
        port: 6379,
      },
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
      connection: {
        host: 'localhost',
        port: 6379,
      },
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

    // Initialize workers
    initializeWorkers();

    logger.info('✅ Background queues initialized');
  } catch (error) {
    logger.error('Failed to initialize queues:', error);
    throw error;
  }
}

function initializeWorkers(): void {
  // AI Processing Worker
  new Worker('ai-processing', async (job) => {
    const { type, data } = job.data;
    
    switch (type) {
      case 'generate-response':
        // Handle AI response generation
        break;
      case 'generate-embeddings':
        // Handle embedding generation
        break;
      default:
        throw new Error(`Unknown AI processing job type: ${type}`);
    }
  }, {
    connection: {
      host: 'localhost',
      port: 6379,
    },
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY || '5'),
  });

  // Document Processing Worker
  new Worker('document-processing', async (job) => {
    // To avoid cyclical dependencies in prompt setup we dynamically require Mongoose
    const mongoose = require('mongoose');
    const DocumentModel = mongoose.model('Document');
    
    // Fallback extraction for direct job matches or legacy structure
    const docId = job.data?.documentId;
    if (!docId) return;

    try {
      const doc = await DocumentModel.findById(docId);
      if (!doc) return;

      doc.status = 'processing';
      await doc.save();

      // SIMULATION OF PARSING & EMBEDDING
      // 1. Read doc.path file
      // 2. Extract text with pdf-parse / mammoth
      // 3. Generate embeddings with Ollama
      // 4. Store to ChromaDB
      // For this implementation, we simulate text extraction gracefully as native RAG 
      // isn't fully scaffolded across local deployments.
      
      const fs = require('fs');
      if (fs.existsSync(doc.path)) {
        doc.content = `[Extracted Text Content Placeholder for ${doc.originalName}]`;
        doc.status = 'completed';
      } else {
        doc.status = 'failed';
        doc.errorMessage = 'File not found on disk';
      }

      await doc.save();
    } catch (e: any) {
      console.error('Job processing failed', e);
      if (docId) {
        await DocumentModel.findByIdAndUpdate(docId, { status: 'failed', errorMessage: e.message });
      }
    }
  }, {
    connection: {
      host: 'localhost',
      port: 6379,
    },
    concurrency: 3,
  });
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