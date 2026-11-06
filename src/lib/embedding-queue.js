import { Queue } from 'bullmq';
import Redis from 'ioredis';
export const EMBEDDING_QUEUE_NAME = 'repository-embeddings';
export const bullmqJobIdForEmbeddingJob = (id) => `embed-${id}`;
export function createEmbeddingQueue(redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379') {
  const connection = new Redis(redisUrl, { lazyConnect: true, connectTimeout: 3000, commandTimeout: 3000, maxRetriesPerRequest: null });
  return { queue: new Queue(EMBEDDING_QUEUE_NAME, { connection }), connection };
}
