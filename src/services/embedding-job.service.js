import { randomUUID } from 'node:crypto';
import { bullmqJobIdForEmbeddingJob } from '../lib/embedding-queue.js';
import { formatCodeChunk } from './ollama-embedding.service.js';

const ACTIVE = ['queued', 'processing'];
const SUCCESSFUL_PARSE = ['completed', 'completed_with_errors'];

export function embeddingJobResponse(job) {
  return { id: job.id, repositoryId: job.repositoryId, parsingJobId: job.parsingJobId, status: job.status, stage: job.stage,
    progress: job.progress, totalChunks: job.totalChunks, processedChunks: job.processedChunks,
    embeddedChunks: job.embeddedChunks, skippedChunks: job.skippedChunks, failedChunks: job.failedChunks,
    errorMessage: job.errorMessage, startedAt: job.startedAt, completedAt: job.completedAt };
}

export async function createEmbeddingJob({ prisma, queue, repositoryId, userId, config }) {
  const imported = await prisma.repositoryImport.findFirst({ where: { repositoryId, userId } });
  if (!imported) return { notFound: true };
  const parsingJob = await prisma.parsingJob.findFirst({ where: { repositoryId, status: { in: SUCCESSFUL_PARSE } }, orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }] });
  if (!parsingJob) return { parsingUnavailable: true };
  const active = await prisma.embeddingJob.findFirst({ where: { repositoryId, status: { in: ACTIVE } }, orderBy: { createdAt: 'desc' } });
  if (active) return { job: active, alreadyRunning: true };
  const id = randomUUID();
  let job;
  try { job = await prisma.embeddingJob.create({ data: { id, repositoryId, parsingJobId: parsingJob.id, bullmqJobId: bullmqJobIdForEmbeddingJob(id) } }); }
  catch (error) {
    if (error.code !== 'P2002' && error.code !== 'P2010') throw error;
    const raced = await prisma.embeddingJob.findFirst({ where: { repositoryId, status: { in: ACTIVE } }, orderBy: { createdAt: 'desc' } });
    if (raced) return { job: raced, alreadyRunning: true };
    throw error;
  }
  if (queue) {
    try { await queue.add('embed-repository', { embeddingJobId: id }, { jobId: job.bullmqJobId, attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 100, removeOnFail: 500 }); }
    catch (error) { console.error('Embedding job saved for queue recovery', { jobId: id, code: error?.code ?? 'QUEUE_UNAVAILABLE' }); }
  }
  return { job, alreadyRunning: false, model: config.embedding.model };
}

export async function recoverQueuedEmbeddingJobs({ prisma, queue, now = Date.now() }) {
  const staleBefore = new Date(now - 5 * 60 * 1000);
  const jobs = await prisma.embeddingJob.findMany({ where: { status: { in: ACTIVE } }, orderBy: { createdAt: 'asc' } });
  let enqueued = 0;
  for (const job of jobs) {
    const queued = await queue.getJob(job.bullmqJobId);
    if (queued) {
      const state = await queued.getState();
      if (['waiting', 'waiting-children', 'delayed', 'active', 'prioritized'].includes(state)) continue;
      if (job.status === 'processing' && job.updatedAt > staleBefore) continue;
      if (state === 'failed' && queued.attemptsMade >= (queued.opts?.attempts ?? 3)) {
        await prisma.embeddingJob.updateMany({ where: { id: job.id, status: { in: ACTIVE } }, data: { status: 'failed', stage: 'failed', errorMessage: 'Embedding attempts were exhausted. Start a new embedding job to retry.', completedAt: new Date(now) } });
        continue;
      }
      await queued.remove();
    } else if (job.status === 'processing' && job.updatedAt > staleBefore) continue;
    if (job.status === 'processing') await prisma.embeddingJob.updateMany({ where: { id: job.id, status: 'processing', updatedAt: { lt: staleBefore } }, data: { status: 'queued', stage: 'queued', errorMessage: null } });
    await queue.add('embed-repository', { embeddingJobId: job.id }, { jobId: job.bullmqJobId, attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 100, removeOnFail: 500 });
    enqueued++;
  }
  return enqueued;
}

export function createEmbeddingProcessor({ prisma, embeddingService, config }) {
  return async ({ data }) => {
    const job = await prisma.embeddingJob.findUnique({ where: { id: data?.embeddingJobId } });
    if (!job || ['completed', 'completed_with_errors'].includes(job.status)) return;
    await prisma.embeddingJob.update({ where: { id: job.id }, data: { status: 'processing', stage: 'loading_chunks', startedAt: job.startedAt ?? new Date(), errorMessage: null } });
    const totalChunks = await prisma.codeChunk.count({ where: { parsingJobId: job.parsingJobId } });
    await prisma.embeddingJob.update({ where: { id: job.id }, data: { totalChunks } });
    let cursor;
    let processedChunks = 0, embeddedChunks = 0, skippedChunks = 0, failedChunks = 0;
    while (true) {
      const chunks = await prisma.codeChunk.findMany({ where: { parsingJobId: job.parsingJobId, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take: config.embedding.batchSize, include: { embeddings: { where: { embeddingModel: config.embedding.model, embeddingDimensions: config.embedding.dimensions }, select: { id: true } } } });
      if (!chunks.length) break;
      cursor = chunks.at(-1).id;
      const candidates = chunks.filter((chunk) => chunk.source.trim() && !chunk.embeddings.length);
      skippedChunks += chunks.length - candidates.length;
      const pending = [];
      for (const chunk of candidates) {
        const reused = await prisma.$executeRaw`INSERT INTO "CodeEmbedding" ("id", "codeChunkId", "repositoryId", "embeddingModel", "embeddingDimensions", "embedding", "createdAt", "updatedAt")
          SELECT ${randomUUID()}::uuid, ${chunk.id}::uuid, ${job.repositoryId}::uuid, ${config.embedding.model}, ${config.embedding.dimensions}, prior_embedding."embedding", NOW(), NOW()
          FROM "CodeChunk" prior_chunk JOIN "CodeEmbedding" prior_embedding ON prior_embedding."codeChunkId" = prior_chunk."id"
          WHERE prior_chunk."repositoryId" = ${job.repositoryId}::uuid AND prior_chunk."id" <> ${chunk.id}::uuid
            AND prior_chunk."sourceHash" = ${chunk.sourceHash} AND prior_chunk."relativePath" = ${chunk.relativePath}
            AND prior_chunk."language" = ${chunk.language} AND prior_chunk."structureType" = ${chunk.structureType}
            AND prior_chunk."symbolName" IS NOT DISTINCT FROM ${chunk.symbolName}
            AND prior_embedding."embeddingModel" = ${config.embedding.model} AND prior_embedding."embeddingDimensions" = ${config.embedding.dimensions}
          ORDER BY prior_chunk."createdAt" DESC LIMIT 1
          ON CONFLICT ("codeChunkId", "embeddingModel", "embeddingDimensions") DO NOTHING`;
        if (reused) embeddedChunks++;
        else if (formatCodeChunk(chunk).length <= config.embedding.maxInputChars) pending.push(chunk);
        else failedChunks++;
      }
      if (pending.length) {
        await prisma.embeddingJob.update({ where: { id: job.id }, data: { stage: 'generating_embeddings' } });
        try {
          const vectors = await embeddingService.embed(pending.map(formatCodeChunk));
          await prisma.embeddingJob.update({ where: { id: job.id }, data: { stage: 'saving_embeddings' } });
          for (let i = 0; i < pending.length; i++) {
            const vector = `[${vectors[i].join(',')}]`;
            await prisma.$executeRaw`INSERT INTO "CodeEmbedding" ("id", "codeChunkId", "repositoryId", "embeddingModel", "embeddingDimensions", "embedding", "createdAt", "updatedAt") VALUES (${randomUUID()}::uuid, ${pending[i].id}::uuid, ${job.repositoryId}::uuid, ${config.embedding.model}, ${config.embedding.dimensions}, ${vector}::vector, NOW(), NOW()) ON CONFLICT ("codeChunkId", "embeddingModel", "embeddingDimensions") DO NOTHING`;
            embeddedChunks++;
          }
        } catch (error) {
          if (error.retryable) throw error;
          failedChunks += pending.length;
          console.error('Embedding batch failed', { jobId: job.id, code: error.code ?? 'EMBEDDING_ERROR' });
        }
      }
      processedChunks += chunks.length;
      await prisma.embeddingJob.update({ where: { id: job.id }, data: { processedChunks, embeddedChunks, skippedChunks, failedChunks, progress: totalChunks ? Math.floor(processedChunks * 99 / totalChunks) : 99 } });
    }
    const status = failedChunks ? (embeddedChunks || skippedChunks ? 'completed_with_errors' : 'failed') : 'completed';
    await prisma.embeddingJob.update({ where: { id: job.id }, data: { status, stage: status === 'failed' ? 'failed' : 'completed', progress: 100, embeddedChunks, skippedChunks, failedChunks, completedAt: new Date(), errorMessage: failedChunks ? `${failedChunks} chunks could not be embedded.` : null } });
  };
}
