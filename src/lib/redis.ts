import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

// One shared Redis connection (rate limits now; caching and job queues in later parts).
// Redis only holds short-lived data: losing it never loses business records.
export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
});

redis.on('error', (err) => logger.error({ err }, 'Redis error'));

export async function connectRedis(): Promise<void> {
  if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
  logger.info('Redis connected');
}

export async function disconnectRedis(): Promise<void> {
  if (redis.status !== 'end') await redis.quit();
}

export async function pingRedis(): Promise<boolean> {
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}
