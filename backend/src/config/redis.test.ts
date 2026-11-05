jest.mock('redis', () => ({ createClient: jest.fn(() => ({
  on: jest.fn(), connect: jest.fn().mockResolvedValue(undefined),
  quit: jest.fn().mockResolvedValue(undefined), isReady: true,
})) }));
jest.mock('@/utils/logger', () => ({ logger: { info: jest.fn(), error: jest.fn() } }));
jest.mock('./environment', () => ({ getEnvironment: () => ({ redisUrl: 'redis://cache:6379/0' }) }));

import { createClient } from 'redis';
import { connectRedis, disconnectRedis, getRedisClient, getQueueRedisClient, getQueueRedisUrl } from './redis';
import { getQueueConnection } from './queues';

describe('Code Lab queue Redis configuration', () => {
  const original = process.env.QUEUE_REDIS_URL;
  afterEach(async () => {
    await disconnectRedis();
    if (original === undefined) delete process.env.QUEUE_REDIS_URL;
    else process.env.QUEUE_REDIS_URL = original;
    jest.clearAllMocks();
  });

  it('shares the cache connection when no queue override is supplied', async () => {
    delete process.env.QUEUE_REDIS_URL;
    await connectRedis();
    expect(getQueueRedisClient()).toBe(getRedisClient());
    expect(getQueueRedisUrl()).toBe('redis://cache:6379/0');
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('uses the same separate database for BullMQ and heartbeat/cancellation and closes both clients', async () => {
    process.env.QUEUE_REDIS_URL = 'rediss://runner:p%40ss@queue:6380/3';
    await connectRedis();
    expect(createClient).toHaveBeenNthCalledWith(2, expect.objectContaining({ url: process.env.QUEUE_REDIS_URL }));
    expect(getQueueRedisClient()).not.toBe(getRedisClient());
    expect(getQueueConnection()).toMatchObject({ host: 'queue', port: 6380, db: 3, username: 'runner', password: 'p@ss', tls: {} });
    const cache = getRedisClient();
    const queue = getQueueRedisClient();
    await disconnectRedis();
    expect(cache.quit).toHaveBeenCalledTimes(1);
    expect(queue.quit).toHaveBeenCalledTimes(1);
  });
});
