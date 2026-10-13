import { HttpError } from '../lib/http-error.js';
import { createIndexingJob } from '../services/indexing-job.service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jobResponse(job) {
  return {
    id: job.id,
    repositoryId: job.repositoryId,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    message: job.message,
    discoveredFileCount: job.discoveredFileCount,
    eligibleFileCount: job.eligibleFileCount,
    excludedFileCount: job.excludedFileCount,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    error: job.errorCode ? { code: job.errorCode, message: job.errorMessage } : null,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

export function createIndexingController({ prisma, indexingQueue }) {
  return {
    async start(req, res, next) {
      try {
        const { repositoryId } = req.params;
        if (!UUID_PATTERN.test(repositoryId)) throw new HttpError(400, 'INVALID_REPOSITORY_ID', 'Provide a valid repository ID.');
        let result;
        try {
          result = await createIndexingJob({ prisma, indexingQueue, repositoryId, userId: req.auth.userId });
        } catch (error) {
          if (error.code === 'P2002') {
            const existing = await prisma.indexingJob.findFirst({ where: { repositoryId, status: { in: ['queued', 'cloning', 'filtering', 'saving_inventory'] } }, orderBy: { createdAt: 'desc' } });
            if (existing) result = { job: existing, alreadyRunning: true };
            else throw error;
          } else throw error;
        }
        if (result.notFound) throw new HttpError(404, 'REPOSITORY_NOT_FOUND', 'Repository was not found in your imports.');
        res.status(result.alreadyRunning ? 200 : 202).json({
          success: true,
          alreadyRunning: result.alreadyRunning,
          job: jobResponse(result.job)
        });
      } catch (error) { next(error); }
    },

    async getJob(req, res, next) {
      try {
        const { jobId } = req.params;
        if (!UUID_PATTERN.test(jobId)) throw new HttpError(404, 'INDEXING_JOB_NOT_FOUND', 'Indexing job was not found.');
        const job = await prisma.indexingJob.findFirst({
          where: { id: jobId, repository: { imports: { some: { userId: req.auth.userId } } } }
        });
        if (!job) throw new HttpError(404, 'INDEXING_JOB_NOT_FOUND', 'Indexing job was not found.');
        res.json({ job: jobResponse(job) });
      } catch (error) { next(error); }
    },

    async repositoryStatus(req, res, next) {
      try {
        const { repositoryId } = req.params;
        if (!UUID_PATTERN.test(repositoryId)) throw new HttpError(400, 'INVALID_REPOSITORY_ID', 'Provide a valid repository ID.');
        const imported = await prisma.repositoryImport.findFirst({
          where: { repositoryId, userId: req.auth.userId },
          include: { repository: true }
        });
        if (!imported) throw new HttpError(404, 'REPOSITORY_NOT_FOUND', 'Repository was not found in your imports.');
        const latestJob = await prisma.indexingJob.findFirst({ where: { repositoryId }, orderBy: { createdAt: 'desc' } });
        res.json({
          repositoryId,
          latestJob: latestJob ? jobResponse(latestJob) : null,
          lastSuccessfulIndex: imported.repository.lastIndexedAt ? {
            commitSha: imported.repository.lastIndexedCommitSha,
            indexedAt: imported.repository.lastIndexedAt,
            eligibleFileCount: imported.repository.lastIndexedFileCount
          } : null
        });
      } catch (error) { next(error); }
    }
  };
}

export { jobResponse };
