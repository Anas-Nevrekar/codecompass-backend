import { HttpError } from '../lib/http-error.js';
import { createEmbeddingJob, embeddingJobResponse } from '../services/embedding-job.service.js';
import { hybridSearch } from '../services/hybrid-search.service.js';

export function createEmbeddingController({ prisma, embeddingQueue, embeddingService, config }) {
  return {
    async start(req, res, next) {
      try {
        const result = await createEmbeddingJob({ prisma, queue: embeddingQueue, repositoryId: req.params.repositoryId, userId: req.auth.userId, config });
        if (result.notFound) throw new HttpError(404, 'REPOSITORY_NOT_FOUND', 'Imported repository was not found.');
        if (result.parsingUnavailable) throw new HttpError(409, 'PARSING_REQUIRED', 'Complete repository parsing before generating embeddings.');
        res.status(result.alreadyRunning ? 200 : 202).json({ success: true, alreadyRunning: result.alreadyRunning, job: embeddingJobResponse(result.job) });
      } catch (error) { next(error); }
    },
    async status(req, res, next) {
      try {
        const job = await prisma.embeddingJob.findFirst({ where: { id: req.params.jobId, repository: { imports: { some: { userId: req.auth.userId } } } } });
        if (!job) throw new HttpError(404, 'EMBEDDING_JOB_NOT_FOUND', 'Embedding job was not found.');
        res.json({ job: embeddingJobResponse(job) });
      } catch (error) { next(error); }
    },
    async search(req, res, next) {
      try {
        const query = req.body?.query;
        const limit = req.body?.limit ?? config.search.defaultLimit;
        if (typeof query !== 'string' || !query.trim() || query.length > 1000) throw new HttpError(400, 'INVALID_QUERY', 'Query must contain between 1 and 1000 characters.');
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, 'INVALID_LIMIT', 'Limit must be an integer between 1 and 50.');
        const result = await hybridSearch({ prisma, embeddingService, config, repositoryId: req.params.repositoryId, userId: req.auth.userId, query: query.trim(), limit });
        if (result.notFound) throw new HttpError(404, 'REPOSITORY_NOT_FOUND', 'Imported repository was not found.');
        if (result.unavailable) throw new HttpError(409, 'PARSING_REQUIRED', 'Complete repository parsing before searching.');
        if (result.embeddingsMissing) throw new HttpError(409, 'EMBEDDINGS_NOT_READY', 'Generate embeddings for the latest parsing job before searching.');
        res.json({ repositoryId: req.params.repositoryId, query: query.trim(), parsingJobId: result.parsingJobId, results: result.results.map((item) => ({
          chunkId: item.chunkId, filePath: item.filePath, language: item.language, structureType: item.structureType,
          symbolName: item.symbolName, startLine: item.startLine, endLine: item.endLine, sourceCode: item.sourceCode,
          metadata: item.metadata, retrieval: { vectorRank: item.vectorRank, keywordRank: item.keywordRank,
            rrfScore: item.rrfScore, matchedBy: item.matchedBy, ...(item.distance == null ? {} : { cosineDistance: Number(item.distance) }) }
        })) });
      } catch (error) {
        if (error instanceof HttpError) return next(error);
        const provider = new HttpError(503, 'EMBEDDING_PROVIDER_UNAVAILABLE', error.message || 'The embedding provider is unavailable.');
        next(provider);
      }
    },
    async health(_req, res, next) {
      try { res.json({ success: true, provider: config.embedding.provider, embedding: await embeddingService.health() }); } catch (error) { next(new HttpError(503, 'EMBEDDING_PROVIDER_UNAVAILABLE', error.message)); }
    }
  };
}
