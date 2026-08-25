import { createClient, RedisClientType } from 'redis';
import { logger } from '@/utils/logger';
import { getEnvironment } from './environment';

let redisClient: RedisClientType;

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

export async function disconnectRedis(): Promise<void> {
  try {
    if (redisClient) {
      await redisClient.quit();
      logger.info('Disconnected from Redis');
    }
  } catch (error) {
    logger.error('Error disconnecting from Redis:', error);
    throw error;
  }
}
