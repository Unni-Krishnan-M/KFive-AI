import { RedisRunnerCoordinator } from './coordinator';
import { ExecFileDockerAdapter } from './dockerCli';
import { DockerCodeExecutor } from './executor';
import { BullMqWorkerFactory } from './queueWorker';
import { parseRedisUrl } from './redisConfig';
import { StaleCodeRunReaper } from './reaper';
import { CodeRunnerWorkerHost } from './workerHost';

function log(level: 'info' | 'error', event: string): void {
  const line = JSON.stringify({ level, service: 'code-runner', event, timestamp: new Date().toISOString() });
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

function parseConcurrency(raw: string | undefined): number {
  const value = raw === undefined ? 2 : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 8) {
    throw new Error('CODE_RUNNER_CONCURRENCY must be an integer between 1 and 8.');
  }
  return value;
}

async function main(): Promise<void> {
  const redis = parseRedisUrl(process.env.REDIS_URL);
  const concurrency = parseConcurrency(process.env.CODE_RUNNER_CONCURRENCY);
  const onError = (event: string): void => log('error', event);
  const coordinator = new RedisRunnerCoordinator(redis, onError);
  const workerFactory = new BullMqWorkerFactory(redis, concurrency, onError);
  const docker = new ExecFileDockerAdapter(process.env.DOCKER_CLI_PATH || 'docker');
  const executor = new DockerCodeExecutor(docker);
  const host = new CodeRunnerWorkerHost(workerFactory, coordinator, executor, { concurrency, onError });
  const reaper = new StaleCodeRunReaper(docker, { onError });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', `shutdown-${signal.toLowerCase()}`);
    await host.stop();
  };
  const requestShutdown = (signal: string): void => {
    void shutdown(signal).catch(() => {
      log('error', 'worker-shutdown-failed');
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', () => requestShutdown('SIGTERM'));
  process.once('SIGINT', () => requestShutdown('SIGINT'));

  await reaper.reap();
  await host.start();
  log('info', 'worker-ready');
}

void main().catch(() => {
  log('error', 'worker-start-failed');
  process.exitCode = 1;
});

export { main, parseConcurrency };
