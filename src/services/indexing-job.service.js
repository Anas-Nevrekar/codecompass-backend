import { bullmqJobIdForIndexingJob } from '../lib/indexing-queue.js';
import { randomUUID } from 'node:crypto';

const ACTIVE_STATUSES = ['queued', 'cloning', 'filtering', 'saving_inventory'];
const RECOVERY_STALE_MS = 5 * 60 * 1000;

export async function createIndexingJob({ prisma, indexingQueue, repositoryId, userId }) {
  const importedRepository = await prisma.repositoryImport.findFirst({
    where: { repositoryId, userId },
    include: { repository: true }
  });
  if (!importedRepository) return { notFound: true };

  const existing = await prisma.indexingJob.findFirst({
    where: { repositoryId, status: { in: ACTIVE_STATUSES } },
    orderBy: { createdAt: 'desc' }
  });
  if (existing) return { job: existing, alreadyRunning: true };

  const id = randomUUID();
  const job = await prisma.indexingJob.create({
    data: {
      id,
      repositoryId,
      userId,
      activeRepositoryId: repositoryId,
      status: 'queued',
      stage: 'queued',
      message: 'Waiting to start',
      bullmqJobId: bullmqJobIdForIndexingJob(id)
    }
  });
  if (indexingQueue) {
    try { await enqueueIndexingJob(indexingQueue, job); }
    catch (error) { console.error('Indexing job saved for queue recovery', { jobId: job.id, code: error?.code ?? 'QUEUE_UNAVAILABLE' }); }
  }
  return { job, alreadyRunning: false };
}

export async function enqueueIndexingJob(queue, job) {
  const remainingAttempts = Math.max(1, (job.maxAttempts ?? 3) - (job.attemptCount ?? 0));
  return queue.add('index-repository', { indexingJobId: job.id }, {
    jobId: job.bullmqJobId,
    attempts: remainingAttempts,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 500
  });
}

export async function recoverQueuedIndexingJobs({ prisma, queue, now = Date.now() }) {
  const jobs = await prisma.indexingJob.findMany({
    where: { status: { in: ACTIVE_STATUSES } },
    orderBy: { createdAt: 'asc' }
  });
  let enqueued = 0;
  for (const job of jobs) {
    if (job.attemptCount >= job.maxAttempts) {
      await prisma.indexingJob.updateMany({
        where: { id: job.id, status: { in: ACTIVE_STATUSES } },
        data: {
          status: 'failed', stage: 'failed', message: 'Worker retries were exhausted',
          errorCode: 'WORKER_RETRIES_EXHAUSTED', errorMessage: 'The worker could not complete indexing after the allowed attempts.',
          completedAt: new Date(now), activeRepositoryId: null
        }
      });
      continue;
    }
    const bullJob = await queue.getJob(job.bullmqJobId);
    if (bullJob) {
      const state = await bullJob.getState();
      if (['waiting', 'waiting-children', 'delayed', 'active', 'prioritized'].includes(state)) continue;
      if (!['completed', 'failed'].includes(state)) continue;
      if (job.status !== 'queued' && now - new Date(job.updatedAt).getTime() < RECOVERY_STALE_MS) continue;
      if (state === 'failed' && bullJob.attemptsMade >= (bullJob.opts?.attempts ?? job.maxAttempts)) {
        await prisma.indexingJob.updateMany({
          where: { id: job.id, status: { in: ACTIVE_STATUSES } },
          data: {
            status: 'failed', stage: 'failed', message: 'Worker retries were exhausted',
            errorCode: 'WORKER_RETRIES_EXHAUSTED', errorMessage: 'The worker could not complete indexing after the allowed attempts.',
            completedAt: new Date(now), activeRepositoryId: null
          }
        });
        continue;
      }
      if (bullJob.attemptsMade > job.attemptCount) {
        await prisma.indexingJob.updateMany({
          where: { id: job.id, status: { in: ACTIVE_STATUSES } },
          data: { attemptCount: bullJob.attemptsMade }
        });
        job.attemptCount = bullJob.attemptsMade;
      }
      await bullJob.remove();
    } else if (job.status !== 'queued') {
      if (now - new Date(job.updatedAt).getTime() < RECOVERY_STALE_MS) continue;
      const changed = await prisma.indexingJob.updateMany({
        where: { id: job.id, status: { in: ['cloning', 'filtering', 'saving_inventory'] }, updatedAt: { lt: new Date(now - RECOVERY_STALE_MS) } },
        data: { status: 'queued', stage: 'queued', message: 'Recovered after an interrupted worker attempt' }
      });
      if (changed.count === 0) continue;
      job.status = 'queued';
    }
    await enqueueIndexingJob(queue, job);
    enqueued += 1;
    console.info('Recovered queued indexing job', { jobId: job.id });
  }
  return enqueued;
}

export function isActiveIndexingStatus(status) {
  return ACTIVE_STATUSES.includes(status);
}
