import { createClient, RedisClientType } from 'redis';
import { logger } from '@/utils/logger';
import { getEnvironment } from './environment';

let redisClient: RedisClientType | undefined;
let queueRedisClient: RedisClientType | undefined;

export function getQueueRedisUrl(): string {
  return process.env.QUEUE_REDIS_URL || getEnvironment().redisUrl;
}

export async function connectRedis(): Promise<RedisClientType> {
  try {
    const redisUrl = getEnvironment().redisUrl;

    redisClient = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 5000,
      },
    });

    redisClient.on('error', (error) => {
      logger.error('Redis connection error:', error);
    });

    redisClient.on('connect', () => {
      logger.info('✅ Connected to Redis');
    });

    redisClient.on('reconnecting', () => {
      logger.info('Reconnecting to Redis...');
    });

    redisClient.on('ready', () => {
      logger.info('Redis client ready');
    });

    await redisClient.connect();

    const queueUrl = getQueueRedisUrl();
    if (queueUrl === redisUrl) {
      queueRedisClient = redisClient;
    } else {
      queueRedisClient = createClient({ url: queueUrl, socket: { connectTimeout: 5000 } });
      // Do not include connection errors: they may contain credentials.
      queueRedisClient.on('error', () => logger.error('Queue Redis connection error'));
      await queueRedisClient.connect();
    }
    
    return redisClient;
    
  } catch (error) {
    logger.error('Failed to connect to Redis:', error);
    throw error;
  }
}

export function getRedisClient(): RedisClientType {
  if (!redisClient) {
    throw new Error('Redis client not initialized. Call connectRedis() first.');
  }
  return redisClient;
}

export function isRedisReady(): boolean {
  return Boolean(redisClient?.isReady);
}

export function getQueueRedisClient(): RedisClientType {
  if (!queueRedisClient) throw new Error('Queue Redis client not initialized. Call connectRedis() first.');
  return queueRedisClient;
}

export async function disconnectRedis(): Promise<void> {
  try {
    const clients = [...new Set([redisClient, queueRedisClient].filter((client): client is RedisClientType => Boolean(client)))];
    redisClient = undefined;
    queueRedisClient = undefined;
    if (clients.length) {
      await Promise.all(clients.map((client) => client.quit()));
      logger.info('Disconnected from Redis');
    }
  } catch (error) {
    logger.error('Error disconnecting from Redis:', error);
    throw error;
  }
}
