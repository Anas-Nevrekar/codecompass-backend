import { Queue } from 'bullmq';
import Redis from 'ioredis';
export const PARSING_QUEUE_NAME = 'repository-parsing';
export const bullmqJobIdForParsingJob = (id) => `parse-${id}`;
export function createParsingQueue(redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379') {
  const connection = new Redis(redisUrl, { lazyConnect: true, connectTimeout: 3000, commandTimeout: 3000, maxRetriesPerRequest: null });
  return { queue: new Queue(PARSING_QUEUE_NAME, { connection }), connection };
}
