import { connectDatabase, disconnectDatabase } from './config/database';
import { getEnvironment } from './config/environment';
import { connectRedis, disconnectRedis } from './config/redis';
import { DockerNotebookExecutor, NotebookIsolationError } from './services/notebookExecution';
import { logger } from './utils/logger';
import { validateEnvironment } from './utils/validation';
import { startNotebookWorker } from './workers/notebookWorker';

validateEnvironment();
const config = getEnvironment();
let closing = false;
let handle: Awaited<ReturnType<typeof startNotebookWorker>> | undefined;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (closing) return; closing = true; logger.info('Notebook worker shutdown started', { signal });
  try { await handle?.close(); await disconnectRedis(); await disconnectDatabase(); process.exit(exitCode); }
  catch (error) { logger.error('Notebook worker shutdown failed', { error }); process.exit(1); }
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('uncaughtException', (error) => { logger.error('Notebook worker uncaught exception', { error }); void shutdown('uncaughtException', 1); });
process.once('unhandledRejection', (error) => { logger.error('Notebook worker unhandled rejection', { error }); void shutdown('unhandledRejection', 1); });

async function start(): Promise<void> {
  try {
    if (config.processKind !== 'notebook-worker' || !config.notebookExecutionEnabled
      || !config.notebookRuntimeImage || !config.notebookVerifierImage)
      throw new Error('Notebook worker configuration is disabled or incomplete.');
    await connectDatabase(); await connectRedis();
    const executor = new DockerNotebookExecutor(undefined, {
      runtimeImage: config.notebookRuntimeImage, verifierImage: config.notebookVerifierImage,
      requireAppArmor: process.env.NOTEBOOK_REQUIRE_APPARMOR !== 'false',
    });
    handle = await startNotebookWorker(executor, (error) => {
      logger.error('Notebook worker lost execution authority', { reason: error.message });
      void shutdown('execution-authority-lost', 1);
    });
    logger.info('KFive notebook worker started after isolation self-check');
  } catch (error) {
    logger.error('Notebook worker startup failed', {
      code: error instanceof NotebookIsolationError ? error.code : 'NOTEBOOK_WORKER_STARTUP_FAILED',
      reason: error instanceof Error ? error.message : 'Unknown startup failure.',
    });
    await shutdown('startup-failure', 1);
  }
}
void start();
