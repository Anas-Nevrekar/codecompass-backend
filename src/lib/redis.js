import Redis from 'ioredis';

export function createRedisConnection(url = process.env.REDIS_URL ?? 'redis://localhost:6379') {
  return new Redis(url, {
    lazyConnect: true,
    connectTimeout: 3000,
    commandTimeout: 3000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => attempt <= 2 ? 250 : null
  });
}

export const redis = createRedisConnection();
