import { UnrecoverableError } from 'bullmq';
import { IndexingError, withClonedRepository } from './repository-clone.service.js';
import { discoverRepositoryFiles } from './repository-file-discovery.service.js';
import { replaceRepositoryInventory } from './repository-inventory.service.js';

export async function markIndexingJobFailed(prisma, indexingJobId, error) {
  const code = error instanceof IndexingError ? error.code : 'INDEXING_FAILED';
  const message = error instanceof IndexingError ? error.message : 'Repository indexing failed unexpectedly.';
  await prisma.indexingJob.updateMany({
    where: { id: indexingJobId, status: { notIn: ['completed', 'failed'] } },
    data: {
      status: 'failed', stage: 'failed', message: 'Indexing failed',
      errorCode: code, errorMessage: message, completedAt: new Date(), activeRepositoryId: null
    }
  });
}

export function createIndexingProcessor({
  prisma,
  indexingConfig,
  cloneRepository = withClonedRepository,
  discoverFiles = discoverRepositoryFiles,
  persistInventory = replaceRepositoryInventory,
  logger = console
}) {
  async function updateProgress(indexingJobId, data) {
    const current = await prisma.indexingJob.findUnique({ where: { id: indexingJobId }, select: { progress: true } });
    if (!current) throw new IndexingError('INDEXING_JOB_NOT_FOUND', 'Indexing job no longer exists.');
    await prisma.indexingJob.update({
      where: { id: indexingJobId },
      data: { ...data, progress: Math.max(current.progress, data.progress ?? current.progress) }
    });
  }

  return async function processIndexingJob(queueJob) {
    const indexingJobId = queueJob.data?.indexingJobId;
    if (typeof indexingJobId !== 'string') throw new UnrecoverableError('Invalid indexing job payload');
    const job = await prisma.indexingJob.findUnique({ where: { id: indexingJobId }, include: { repository: true } });
    if (!job || ['completed', 'failed'].includes(job.status)) return;
    const attemptCount = Math.max(job.attemptCount, queueJob.attemptsMade) + 1;
    await updateProgress(indexingJobId, {
      status: 'cloning', stage: 'cloning', message: 'Cloning the public repository', progress: 10,
      attemptCount, errorCode: null, errorMessage: null, completedAt: null,
      ...(job.startedAt ? {} : { startedAt: new Date() })
    });
    try {
      await cloneRepository({ repository: job.repository, indexingConfig, work: async ({ repositoryDirectory, commitSha }) => {
        await updateProgress(indexingJobId, { status: 'filtering', stage: 'filtering', message: 'Discovering eligible files', progress: 70 });
        const counts = await discoverFiles(repositoryDirectory, { maxFileSizeBytes: indexingConfig.maxFileSizeBytes });
        await updateProgress(indexingJobId, {
          status: 'saving_inventory', stage: 'saving_inventory', message: 'Saving the file inventory', progress: 90,
          discoveredFileCount: counts.discoveredFileCount,
          eligibleFileCount: counts.eligibleFileCount,
          excludedFileCount: counts.excludedFileCount
        });
        await persistInventory({ prisma, indexingJobId, repositoryId: job.repositoryId, files: counts.files, counts, commitSha });
        logger.info('Repository indexing completed', { jobId: indexingJobId, fileCount: counts.eligibleFileCount });
      } });
    } catch (originalError) {
      const error = originalError instanceof IndexingError ? originalError : new IndexingError('INDEXING_FAILED', 'Repository indexing failed unexpectedly.', { retryable: true });
      const exhausted = attemptCount >= job.maxAttempts;
      if (!error.retryable || exhausted) {
        await markIndexingJobFailed(prisma, indexingJobId, error);
      } else {
        await prisma.indexingJob.updateMany({
          where: { id: indexingJobId, status: { notIn: ['completed', 'failed'] } },
          data: {
            status: 'queued', stage: 'queued', message: 'A temporary problem occurred; retrying shortly',
            attemptCount, errorCode: null, errorMessage: null, completedAt: null
          }
        });
      }
      logger.warn('Repository indexing attempt failed', { jobId: indexingJobId, code: error.code, attemptCount, retryable: error.retryable });
      if (!error.retryable) throw new UnrecoverableError(error.message);
      throw error;
    }
  };
}
