import 'dotenv/config';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { prisma } from '../lib/prisma.js';
import { INDEXING_QUEUE_NAME } from '../lib/indexing-queue.js';
import { cleanStaleIndexingDirectories, prepareIndexingTempRoot } from '../services/repository-clone.service.js';
import { recoverQueuedIndexingJobs } from '../services/indexing-job.service.js';
import { createIndexingProcessor, markIndexingJobFailed } from '../services/indexing-worker.service.js';
import { cleanUnreferencedRetainedClones, prepareRepositoryStorageRoot } from '../services/retained-repository-storage.service.js';
import { validateEnv } from '../config/env.js';

const config = validateEnv();
const indexingConfig = config.indexing;
await prepareIndexingTempRoot(indexingConfig.tempDir);
await prepareRepositoryStorageRoot(indexingConfig.repositoryStorageDir, indexingConfig.tempDir);
const connection = new Redis(config.redisUrl, {
  lazyConnect: true,
  connectTimeout: 3000,
  maxRetriesPerRequest: null,
  retryStrategy: (attempt) => Math.min(attempt * 250, 3000)
});

const processIndexingJob = createIndexingProcessor({ prisma, indexingConfig });

await cleanStaleIndexingDirectories({ tempDir: indexingConfig.tempDir, staleAgeMs: indexingConfig.staleTempDirAgeMs })
  .then((removed) => { if (removed) console.info('Removed stale indexing temporary directories', { removed }); })
  .catch(() => console.error('Stale indexing temporary directory cleanup failed'));
await cleanUnreferencedRetainedClones({ prisma, storageDir: indexingConfig.repositoryStorageDir, staleAgeMs: indexingConfig.staleTempDirAgeMs })
  .then((removed) => { if (removed) console.info('Removed abandoned retained repository clones', { removed }); })
  .catch(() => console.error('Abandoned retained repository cleanup failed'));

const worker = new Worker(INDEXING_QUEUE_NAME, processIndexingJob, {
  connection,
  concurrency: indexingConfig.workerConcurrency,
  lockDuration: Math.max(indexingConfig.cloneTimeoutMs + 60000, 90000),
  stalledInterval: 30000,
  maxStalledCount: 2
});

worker.on('ready', () => console.info('Repository indexing worker is ready', { concurrency: indexingConfig.workerConcurrency }));
worker.on('completed', (job) => console.info('Indexing queue job completed', { queueJobId: job.id }));
worker.on('failed', async (job, error) => {
  if (!job) return;
  console.warn('Indexing queue job failed', { queueJobId: job.id, attempt: job.attemptsMade });
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    try { await markIndexingJobFailed(prisma, job.data.indexingJobId, error); }
    catch { console.error('Could not persist the final indexing job failure', { queueJobId: job.id }); }
  }
});
worker.on('error', (error) => console.error('Indexing worker error', { code: error.code ?? 'WORKER_ERROR' }));

const recoveryQueue = new Queue(INDEXING_QUEUE_NAME, { connection: connection.duplicate() });
await recoverQueuedIndexingJobs({ prisma, queue: recoveryQueue }).catch((error) => {
  console.error('Initial indexing queue recovery will retry later', { code: error.code ?? 'RECOVERY_ERROR' });
});
const recoveryTimer = setInterval(() => {
  void recoverQueuedIndexingJobs({ prisma, queue: recoveryQueue }).catch((error) => {
    console.error('Indexing queue recovery will retry later', { code: error.code ?? 'RECOVERY_ERROR' });
  });
  void cleanStaleIndexingDirectories({ tempDir: indexingConfig.tempDir, staleAgeMs: indexingConfig.staleTempDirAgeMs })
    .catch(() => console.error('Stale indexing temporary directory cleanup failed'));
}, indexingConfig.recoveryIntervalMs);
recoveryTimer.unref();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Stopping indexing worker after ${signal}`);
  clearInterval(recoveryTimer);
  await Promise.allSettled([worker.close(), recoveryQueue.close(), connection.quit(), prisma.$disconnect()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
