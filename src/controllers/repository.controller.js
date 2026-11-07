import { HttpError } from '../lib/http-error.js';
import { parsePublicGitHubRepositoryUrl } from '../services/github-repository-url.service.js';
import { createIndexingController, jobResponse } from './indexing.controller.js';
import { createIndexingJob } from '../services/indexing-job.service.js';
import { deleteRepositoryForUser } from '../services/repository-deletion.service.js';
import {
  fetchPublicRepository,
  importRepositoryForUser,
  listRepositoriesForUser
} from '../services/github-repository.service.js';

function repositoryResponse(repository) {
  const latestJob = repository.indexingJobs?.[0] ?? null;
  return {
    id: repository.id,
    owner: repository.owner,
    name: repository.name,
    fullName: repository.fullName,
    htmlUrl: repository.htmlUrl,
    description: repository.description,
    defaultBranch: repository.defaultBranch,
    language: repository.language,
    visibility: repository.visibility,
    starsCount: repository.starsCount,
    forksCount: repository.forksCount,
    githubCreatedAt: repository.githubCreatedAt,
    metadataUpdatedAt: repository.metadataUpdatedAt,
    latestIndexingStatus: latestJob?.status ?? null,
    latestIndexingJobId: latestJob?.id ?? null,
    lastIndexedCommitSha: repository.lastIndexedCommitSha ?? null,
    lastIndexedAt: repository.lastIndexedAt ?? null,
    eligibleFileCount: repository.lastIndexedFileCount ?? null
  };
}

export function createRepositoryController({ prisma, fetchImpl, indexingQueue, parsingQueue, embeddingQueue, config }) {
  const indexingController = createIndexingController({ prisma, indexingQueue });
  return {
    startIndexing: indexingController.start,
    indexingStatus: indexingController.repositoryStatus,
    async import(req, res, next) {
      try {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
            Object.keys(req.body).some((key) => key !== 'url') || typeof req.body.url !== 'string') {
          throw new HttpError(400, 'INVALID_REPOSITORY_URL', 'Provide a valid public GitHub repository URL.');
        }
        const parsed = parsePublicGitHubRepositoryUrl(req.body.url);
        const metadata = await fetchPublicRepository({ ...parsed, fetchImpl });
        const result = await importRepositoryForUser({ prisma, userId: req.auth.userId, metadata });
        const latestIndex = prisma.indexingJob?.findFirst
          ? await prisma.indexingJob.findFirst({ where: { repositoryId: result.repository.id }, orderBy: { createdAt: 'desc' } })
          : null;
        let processing = null;
        if (!latestIndex && prisma.indexingJob?.create && prisma.repositoryImport?.findFirst) {
          const indexed = await createIndexingJob({ prisma, indexingQueue, repositoryId: result.repository.id, userId: req.auth.userId });
          processing = { currentStage: 'indexing', status: indexed.alreadyRunning ? 'processing' : 'queued' };
        }
        res.status(result.alreadyImported ? 200 : 201).json({
          success: true,
          code: result.alreadyImported ? 'REPOSITORY_ALREADY_IMPORTED' : 'REPOSITORY_IMPORTED',
          alreadyImported: result.alreadyImported,
          repository: repositoryResponse(result.repository),
          ...(processing ? { processing } : {})
        });
      } catch (error) { next(error); }
    },

    async list(req, res, next) {
      try {
        const imports = await listRepositoriesForUser(prisma, req.auth.userId);
        res.json({
          repositories: imports.map((item) => ({
            ...repositoryResponse(item.repository),
            importedAt: item.importedAt
          }))
        });
      } catch (error) { next(error); }
    },
    async remove(req, res, next) {
      try {
        const result = await deleteRepositoryForUser({
          prisma,
          repositoryId: req.params.repositoryId,
          userId: req.auth.userId,
          queues: [indexingQueue, parsingQueue, embeddingQueue],
          storageDir: config?.indexing?.repositoryStorageDir
        });
        res.json({ success: true, ...result });
      } catch (error) { next(error); }
    },
    async processingStatus(req, res, next) {
      try {
        const repositoryId = req.params.repositoryId;
        const imported = await prisma.repositoryImport.findFirst({ where: { repositoryId, userId: req.auth.userId }, include: { repository: true } });
        if (!imported) throw new HttpError(404, 'REPOSITORY_NOT_FOUND', 'Repository was not found in your imports.');
        const [indexingJob, parsingJob, embeddingJob] = await Promise.all([
          prisma.indexingJob.findFirst({ where: { repositoryId }, orderBy: { createdAt: 'desc' } }),
          prisma.parsingJob?.findFirst ? prisma.parsingJob.findFirst({ where: { repositoryId }, orderBy: { createdAt: 'desc' } }) : null,
          prisma.embeddingJob?.findFirst ? prisma.embeddingJob.findFirst({ where: { repositoryId }, orderBy: { createdAt: 'desc' } }) : null
        ]);
        const indexFailed = indexingJob?.status === 'failed';
        const parseMatchesIndex = Boolean(indexingJob?.status === 'completed' && parsingJob?.indexingJobId === indexingJob.id);
        const parsingFailed = parseMatchesIndex && (parsingJob.status === 'failed' || parsingJob.status === 'completed_with_errors' && parsingJob.failedFiles > 0);
        const embeddingMatchesParse = Boolean(parseMatchesIndex && ['completed', 'completed_with_errors'].includes(parsingJob?.status) && parsingJob?.failedFiles === 0 && embeddingJob?.parsingJobId === parsingJob.id);
        const embeddingsFailed = embeddingMatchesParse && (embeddingJob.status === 'failed' || embeddingJob.status === 'completed_with_errors' && embeddingJob.failedChunks > 0);
        const failed = indexFailed ? ['indexing', indexingJob] : parsingFailed ? ['parsing', parsingJob] : embeddingsFailed ? ['embeddings', embeddingJob] : null;
        const current = !indexingJob || indexingJob.status !== 'completed' ? 'indexing'
          : !parseMatchesIndex || !['completed', 'completed_with_errors'].includes(parsingJob.status) || parsingJob.failedFiles > 0 ? 'parsing'
            : !embeddingMatchesParse || embeddingJob.status !== 'completed' ? 'embeddings' : null;
        const ready = !current && !failed;
        res.json({ repositoryId, latestJob: indexingJob ? jobResponse(indexingJob) : null, lastSuccessfulIndex: imported.repository?.lastIndexedAt ? { commitSha: imported.repository.lastIndexedCommitSha, indexedAt: imported.repository.lastIndexedAt, eligibleFileCount: imported.repository.lastIndexedFileCount } : null,
          status: ready ? 'ready' : failed ? 'failed' : current ? 'processing' : 'queued', currentStage: ready ? 'ready' : failed?.[0] ?? current,
          retryAvailable: Boolean(failed), stages: {
            indexing: indexingJob ? { status: indexingJob.status, progress: indexingJob.progress, completed: indexingJob.status === 'completed', discoveredFiles: indexingJob.discoveredFileCount, eligibleFiles: indexingJob.eligibleFileCount, excludedFiles: indexingJob.excludedFileCount, error: indexingJob.errorMessage ?? null } : null,
            parsing: parsingJob ? { status: parsingJob.status, progress: parsingJob.progress, completed: ['completed','completed_with_errors'].includes(parsingJob.status) && parsingJob.failedFiles === 0, processedFiles: parsingJob.processedFiles, totalFiles: parsingJob.totalFiles, chunks: parsingJob.totalChunks, error: parsingJob.errorMessage ?? null } : null,
            embeddings: embeddingJob ? { status: embeddingJob.status, progress: embeddingJob.progress, completed: embeddingJob.status === 'completed', processedChunks: embeddingJob.processedChunks, totalChunks: embeddingJob.totalChunks, embeddedChunks: embeddingJob.embeddedChunks, error: embeddingJob.errorMessage ?? null } : null
          } });
      } catch (error) { next(error); }
    }
  };
}
