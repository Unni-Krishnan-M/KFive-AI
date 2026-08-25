import { createServer } from 'http';
import { Server } from 'socket.io';
import { createApp } from './app';
import { connectDatabase, disconnectDatabase } from './config/database';
import { getEnvironment } from './config/environment';
import { closeQueues, initializeQueues } from './config/queues';
import { connectRedis, disconnectRedis } from './config/redis';
import { setupSocketHandlers } from './socket';
import { logger } from './utils/logger';
import { validateEnvironment } from './utils/validation';
import { agentRunService } from './services/agentRunService';
import { workflowRunService } from './services/workflowRunService';

const config = getEnvironment();
validateEnvironment();

const app = createApp(config);
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  },
});

setupSocketHandlers(io);

let shuttingDown = false;
let recoveringAgentRuns = false;
let agentRunRecoveryTimer: NodeJS.Timeout | undefined;
let recoveringWorkflowRuns = false;
let workflowRunRecoveryTimer: NodeJS.Timeout | undefined;

function startAgentRunRecoveryLoop(): void {
  agentRunRecoveryTimer = setInterval(() => {
    if (recoveringAgentRuns || shuttingDown) return;
    recoveringAgentRuns = true;
    void agentRunService.recoverInterrupted()
      .then((count) => {
        if (count > 0) logger.warn('Recovered interrupted agent runs', { count });
      })
      .catch(() => logger.error('Agent run recovery check failed'))
      .finally(() => { recoveringAgentRuns = false; });
  }, 30_000);
  agentRunRecoveryTimer.unref();
}

function startWorkflowRunRecoveryLoop(): void {
  workflowRunRecoveryTimer = setInterval(() => {
    if (recoveringWorkflowRuns || shuttingDown) return;
    recoveringWorkflowRuns = true;
    void workflowRunService.recoverInterrupted()
      .then((count) => {
        if (count > 0) logger.warn('Recovered interrupted workflow runs', { count });
      })
      .catch(() => logger.error('Workflow run recovery check failed'))
      .finally(() => { recoveringWorkflowRuns = false; });
  }, 30_000);
  workflowRunRecoveryTimer.unref();
}

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Graceful shutdown started', { signal });

  const forceTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out');
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  try {
    if (agentRunRecoveryTimer) clearInterval(agentRunRecoveryTimer);
    if (workflowRunRecoveryTimer) clearInterval(workflowRunRecoveryTimer);
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await closeQueues();
    await disconnectRedis();
    await disconnectDatabase();
    clearTimeout(forceTimer);
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Graceful shutdown failed', { error });
    process.exit(1);
  }
}

process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
process.once('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason });
  void gracefulShutdown('unhandledRejection');
});
process.once('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
  void gracefulShutdown('uncaughtException');
});

async function startServer(): Promise<void> {
  try {
    await connectDatabase();
    const interruptedAgentRuns = await agentRunService.recoverInterrupted();
    if (interruptedAgentRuns > 0) logger.warn('Recovered interrupted agent runs', { count: interruptedAgentRuns });
    const interruptedWorkflowRuns = await workflowRunService.recoverInterrupted();
    if (interruptedWorkflowRuns > 0) logger.warn('Recovered interrupted workflow runs', { count: interruptedWorkflowRuns });
    await connectRedis();
    await initializeQueues();
    startAgentRunRecoveryLoop();
    startWorkflowRunRecoveryLoop();
    server.listen(config.port, () => {
      logger.info('KFive AI backend started', {
        port: config.port,
        mode: config.kfiveMode,
        provider: config.aiProvider,
      });
    });
  } catch (error) {
    logger.error('Failed to start server', { error });
    await gracefulShutdown('startup-failure');
  }
}

void startServer();

export { app, io, server };
