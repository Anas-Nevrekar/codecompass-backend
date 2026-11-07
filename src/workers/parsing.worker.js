import 'dotenv/config';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { prisma } from '../lib/prisma.js';
import { PARSING_QUEUE_NAME } from '../lib/parsing-queue.js';
import { validateEnv } from '../config/env.js';
import { createParsingProcessor, recoverQueuedParsingJobs } from '../services/parsing-job.service.js';
import { createEmbeddingQueue } from '../lib/embedding-queue.js';
import { advanceRepositoryPipeline } from '../services/processing-pipeline.service.js';

const config = validateEnv();
const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null, retryStrategy: (attempt) => Math.min(attempt * 250, 3000) });
const { queue: embeddingQueue, connection: embeddingRedis } = createEmbeddingQueue(config.redisUrl);
const worker = new Worker(PARSING_QUEUE_NAME, createParsingProcessor({ prisma, indexingConfig: config.indexing, maxFileSizeBytes: config.indexing.maxFileSizeBytes }), { connection, concurrency: 2, lockDuration: 120000 });
const recoveryQueue = new Queue(PARSING_QUEUE_NAME, { connection: connection.duplicate() });
await recoverQueuedParsingJobs({ prisma, queue: recoveryQueue }).catch((error) => console.error('Initial parsing queue recovery will retry later', { code: error.code ?? 'RECOVERY_ERROR' }));
const recoveryTimer = setInterval(() => {
  void recoverQueuedParsingJobs({ prisma, queue: recoveryQueue }).catch((error) => console.error('Parsing queue recovery will retry later', { code: error.code ?? 'RECOVERY_ERROR' }));
}, config.indexing.recoveryIntervalMs);
recoveryTimer.unref();
worker.on('ready', () => console.info('Repository parsing worker is ready'));
worker.on('completed', (job) => {
  console.info('Parsing job completed', { queueJobId: job.id });
  void advanceRepositoryPipeline({ prisma, embeddingQueue, config, parsingJobId: job.data.parsingJobId })
    .catch((error) => console.error('Could not advance repository processing after parsing', { code: error.code ?? 'PIPELINE_ERROR' }));
});
worker.on('failed', async (job, error) => {
  if (!job) return;
  console.warn('Parsing queue attempt failed', { queueJobId: job.id });
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await prisma.parsingJob.updateMany({ where: { id: job.data.parsingJobId, status: { in: ['queued', 'processing'] } }, data: { status: 'failed', stage: 'failed', errorMessage: 'Parsing could not be completed. The retained repository is available for recovery.', completedAt: new Date() } }).catch(() => {});
  }
});
worker.on('error', (error) => console.error('Parsing worker error', { code: error.code ?? 'WORKER_ERROR' }));
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.info(`Stopping parsing worker after ${signal}`);
  clearInterval(recoveryTimer);
  await Promise.allSettled([worker.close(), recoveryQueue.close(), connection.quit(), embeddingQueue.close(), embeddingRedis.quit(), prisma.$disconnect()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
