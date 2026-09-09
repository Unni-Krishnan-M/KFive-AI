import { connectDatabase, disconnectDatabase } from './config/database';
import { connectRedis, disconnectRedis } from './config/redis';
import { logger } from './utils/logger';
import { validateEnvironment } from './utils/validation';
import { startBenchmarkWorker } from './workers/benchmarkWorker';

validateEnvironment();
let closing = false;
let handle: Awaited<ReturnType<typeof startBenchmarkWorker>> | undefined;

async function shutdown(signal: string): Promise<void> {
  if (closing) return; closing = true; logger.info('Benchmark worker shutdown started', { signal });
  try { await handle?.close(); await disconnectRedis(); await disconnectDatabase(); process.exit(0); }
  catch (error) { logger.error('Benchmark worker shutdown failed', { error }); process.exit(1); }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('uncaughtException', (error) => { logger.error('Benchmark worker uncaught exception', { error }); void shutdown('uncaughtException'); });
process.once('unhandledRejection', (error) => { logger.error('Benchmark worker unhandled rejection', { error }); void shutdown('unhandledRejection'); });

async function start(): Promise<void> {
  try { await connectDatabase(); await connectRedis(); handle = await startBenchmarkWorker(); logger.info('KFive benchmark worker started'); }
  catch (error) { logger.error('Benchmark worker startup failed', { error }); await shutdown('startup-failure'); }
}
void start();
