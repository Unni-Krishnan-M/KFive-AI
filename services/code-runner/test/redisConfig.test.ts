import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CoordinatorRedisClient,
  CoordinatorRedisSubscriber,
  RedisRunnerCoordinator,
  RUNNER_CANCEL_CHANNEL,
  RUNNER_CANCEL_KEY_PREFIX,
  RUNNER_CANCEL_TTL_SECONDS,
  RUNNER_HEARTBEAT_KEY,
} from '../src/coordinator';
import { parseRedisUrl } from '../src/redisConfig';

class FakeCommandClient implements CoordinatorRedisClient {
  isOpen = false;
  readonly sets: Array<[string, string, { EX: number }]> = [];
  readonly deleted: string[] = [];
  readonly existing = new Set<string>();
  on(): unknown { return this; }
  async connect(): Promise<void> { this.isOpen = true; }
  async quit(): Promise<void> { this.isOpen = false; }
  async exists(key: string): Promise<number> { return this.existing.has(key) ? 1 : 0; }
  async del(key: string): Promise<void> { this.deleted.push(key); this.existing.delete(key); }
  async set(key: string, value: string, options: { EX: number }): Promise<void> {
    this.sets.push([key, value, options]);
  }
}

class FakeSubscriberClient implements CoordinatorRedisSubscriber {
  isOpen = false;
  channel?: string;
  handler?: (message: string) => void;
  on(): unknown { return this; }
  async connect(): Promise<void> { this.isOpen = true; }
  async quit(): Promise<void> { this.isOpen = false; }
  async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    this.channel = channel;
    this.handler = handler;
  }
  async unsubscribe(): Promise<void> { this.channel = undefined; this.handler = undefined; }
}

test('parses Redis credentials without retaining the original credential-bearing URL', () => {
  const parsed = parseRedisUrl('rediss://runner:p%40ssword@redis.internal:6380/3');
  assert.deepEqual(parsed, {
    host: 'redis.internal',
    port: 6380,
    db: 3,
    username: 'runner',
    password: 'p@ssword',
    tls: {},
    maxRetriesPerRequest: null,
  });
  assert.equal(JSON.stringify(parsed).includes('rediss://'), false);
});

test('configuration errors do not echo secrets', () => {
  const secret = 'do-not-log-this';
  assert.throws(
    () => parseRedisUrl(`https://user:${secret}@redis.internal/0`),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(secret), false);
      return true;
    }
  );
});

test('exports the exact backend heartbeat and cancellation contract', () => {
  assert.equal(RUNNER_HEARTBEAT_KEY, 'kfive:code-runner:heartbeat');
  assert.equal(RUNNER_CANCEL_CHANNEL, 'kfive:code-runner:cancel');
  assert.equal(RUNNER_CANCEL_KEY_PREFIX, 'kfive:code-runner:cancel:');
  assert.equal(RUNNER_CANCEL_TTL_SECONDS, 60);
});

test('Redis coordinator applies the canonical numeric heartbeat and cancellation keys', async () => {
  const command = new FakeCommandClient();
  const subscriber = new FakeSubscriberClient();
  const coordinator = new RedisRunnerCoordinator(
    parseRedisUrl('redis://localhost:6379/0'),
    () => undefined,
    { command, subscriber }
  );
  let cancelled = '';
  await coordinator.connect((runId) => { cancelled = runId; });
  assert.equal(subscriber.channel, RUNNER_CANCEL_CHANNEL);
  subscriber.handler?.('64b000000000000000000401');
  assert.equal(cancelled, '64b000000000000000000401');

  command.existing.add(`${RUNNER_CANCEL_KEY_PREFIX}64b000000000000000000401`);
  assert.equal(await coordinator.isCancellationRequested('64b000000000000000000401'), true);
  await coordinator.writeHeartbeat(1_787_529_600_000, 15);
  assert.deepEqual(command.sets, [[RUNNER_HEARTBEAT_KEY, '1787529600000', { EX: 15 }]]);
  await coordinator.clearCancellation('64b000000000000000000401');
  await coordinator.clearHeartbeat();
  assert.deepEqual(command.deleted, [
    `${RUNNER_CANCEL_KEY_PREFIX}64b000000000000000000401`,
    RUNNER_HEARTBEAT_KEY,
  ]);
  await coordinator.close();
  assert.equal(command.isOpen, false);
  assert.equal(subscriber.isOpen, false);
});
