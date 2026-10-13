import { Queue } from 'bullmq';
import Redis from 'ioredis';

export const INDEXING_QUEUE_NAME = 'repository-indexing';

export function createIndexingQueue(redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379') {
  const connection = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 3000,
    commandTimeout: 3000,
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => Math.min(attempt * 250, 3000)
  });
  const queue = new Queue(INDEXING_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 100,
      removeOnFail: 500
    }
  });
  return { queue, connection };
}

export const bullmqJobIdForIndexingJob = (jobId) => `index-${jobId}`;
