import 'dotenv/config';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { prisma } from '../lib/prisma.js';
import { EMBEDDING_QUEUE_NAME } from '../lib/embedding-queue.js';
import { validateEnv } from '../config/env.js';
import { createOllamaEmbeddingService } from '../services/ollama-embedding.service.js';
import { createEmbeddingProcessor, recoverQueuedEmbeddingJobs } from '../services/embedding-job.service.js';

const config = validateEnv();
const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null, retryStrategy: (attempt) => Math.min(attempt * 250, 3000) });
const embeddingService = createOllamaEmbeddingService({ config: config.embedding });
const worker = new Worker(EMBEDDING_QUEUE_NAME, createEmbeddingProcessor({ prisma, embeddingService, config }), { connection, concurrency: config.embedding.workerConcurrency, lockDuration: config.embedding.requestTimeoutMs + 30000 });
const recoveryQueue = new Queue(EMBEDDING_QUEUE_NAME, { connection: connection.duplicate() });
await recoverQueuedEmbeddingJobs({ prisma, queue: recoveryQueue }).catch(() => console.error('Initial embedding queue recovery will retry later'));
const recoveryTimer = setInterval(() => { void recoverQueuedEmbeddingJobs({ prisma, queue: recoveryQueue }).catch(() => console.error('Embedding queue recovery will retry later')); }, config.indexing.recoveryIntervalMs);
recoveryTimer.unref();
worker.on('ready', () => console.info('Repository embedding worker is ready'));
worker.on('completed', (job) => console.info('Embedding job completed', { queueJobId: job.id }));
worker.on('failed', async (job) => {
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  await prisma.embeddingJob.updateMany({ where: { id: job.data.embeddingJobId, status: { in: ['queued', 'processing'] } }, data: { status: 'failed', stage: 'failed', errorMessage: 'Embedding could not be completed. Check Ollama and start a new embedding job to retry.', completedAt: new Date() } }).catch(() => {});
});
worker.on('error', (error) => console.error('Embedding worker error', { code: error.code ?? 'WORKER_ERROR' }));
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.info(`Stopping embedding worker after ${signal}`);
  clearInterval(recoveryTimer);
  await Promise.allSettled([worker.close(), recoveryQueue.close(), connection.quit(), prisma.$disconnect()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
