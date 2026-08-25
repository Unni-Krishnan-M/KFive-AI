import { createClient } from 'redis';
import { ParsedRedisConfig } from './redisConfig';

export const RUNNER_HEARTBEAT_KEY = 'kfive:code-runner:heartbeat';
export const RUNNER_CANCEL_CHANNEL = 'kfive:code-runner:cancel';
export const RUNNER_CANCEL_KEY_PREFIX = 'kfive:code-runner:cancel:';
export const RUNNER_CANCEL_TTL_SECONDS = 60;

export interface RunnerCoordinator {
  connect(onCancellation: (runId: string) => void): Promise<void>;
  isCancellationRequested(runId: string): Promise<boolean>;
  clearCancellation(runId: string): Promise<void>;
  writeHeartbeat(timestampMs: number, ttlSeconds: number): Promise<void>;
  clearHeartbeat(): Promise<void>;
  close(): Promise<void>;
}

export interface CoordinatorRedisClient {
  readonly isOpen: boolean;
  on(event: 'error', handler: () => void): unknown;
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  exists(key: string): Promise<number>;
  del(key: string): Promise<unknown>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
}

export interface CoordinatorRedisSubscriber {
  readonly isOpen: boolean;
  on(event: 'error', handler: () => void): unknown;
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  subscribe(channel: string, handler: (message: string) => void): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
}

export interface CoordinatorRedisClients {
  command: CoordinatorRedisClient;
  subscriber: CoordinatorRedisSubscriber;
}

export function redisClientOptions(config: ParsedRedisConfig) {
  return {
    username: config.username,
    password: config.password,
    database: config.db,
    socket: {
      host: config.host,
      port: config.port,
      tls: config.tls !== undefined,
    },
  };
}

function createCoordinatorClients(config: ParsedRedisConfig): CoordinatorRedisClients {
  const command = createClient(redisClientOptions(config));
  return {
    command: command as unknown as CoordinatorRedisClient,
    subscriber: command.duplicate() as unknown as CoordinatorRedisSubscriber,
  };
}

export class RedisRunnerCoordinator implements RunnerCoordinator {
  private readonly command;
  private readonly subscriber;
  private connected = false;

  constructor(
    config: ParsedRedisConfig,
    onError: (event: string) => void = () => undefined,
    clients: CoordinatorRedisClients = createCoordinatorClients(config)
  ) {
    this.command = clients.command;
    this.subscriber = clients.subscriber;
    this.command.on('error', () => onError('redis-command-error'));
    this.subscriber.on('error', () => onError('redis-subscriber-error'));
  }

  async connect(onCancellation: (runId: string) => void): Promise<void> {
    if (this.connected) throw new Error('Runner coordinator is already connected.');
    try {
      await this.command.connect();
      await this.subscriber.connect();
      await this.subscriber.subscribe(RUNNER_CANCEL_CHANNEL, onCancellation);
      this.connected = true;
    } catch {
      await this.close();
      throw new Error('The code-runner could not connect to Redis.');
    }
  }

  async isCancellationRequested(runId: string): Promise<boolean> {
    return await this.command.exists(`${RUNNER_CANCEL_KEY_PREFIX}${runId}`) > 0;
  }

  async clearCancellation(runId: string): Promise<void> {
    await this.command.del(`${RUNNER_CANCEL_KEY_PREFIX}${runId}`);
  }

  async writeHeartbeat(timestampMs: number, ttlSeconds: number): Promise<void> {
    await this.command.set(RUNNER_HEARTBEAT_KEY, String(timestampMs), { EX: ttlSeconds });
  }

  async clearHeartbeat(): Promise<void> {
    if (this.command.isOpen) await this.command.del(RUNNER_HEARTBEAT_KEY);
  }

  async close(): Promise<void> {
    if (this.subscriber.isOpen) {
      await this.subscriber.unsubscribe(RUNNER_CANCEL_CHANNEL).catch(() => undefined);
      await this.subscriber.quit().catch(() => undefined);
    }
    if (this.command.isOpen) await this.command.quit().catch(() => undefined);
    this.connected = false;
  }
}
