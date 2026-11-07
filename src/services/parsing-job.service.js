import { randomUUID, createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { bullmqJobIdForParsingJob } from '../lib/parsing-queue.js';
import { parseSource, languageForExtension } from './ast-parser.service.js';
import { resolveRepositoryStorageRoot } from './retained-repository-storage.service.js';

const ACTIVE = ['queued', 'processing'];
const within = (base, file) => { const rel = path.relative(base, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };

export async function createParsingJob(options) {
  const { prisma, queue, repositoryId, userId, indexingJobId: requestedIndexingJobId, automatic = false } = options;
  if (queue && prisma.$transaction && !options.inTransaction) {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT 1 FROM pg_advisory_xact_lock(hashtext($1))', 'codecompass:parse:' + repositoryId);
      return createParsingJob({ ...options, prisma: tx, queue: null, inTransaction: true });
    });
    if (result.job && !result.alreadyRunning && !result.alreadyProcessed) {
      try { await queue.add('parse-repository', { parsingJobId: result.job.id }, { jobId: result.job.bullmqJobId, attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 100, removeOnFail: 500 }); }
      catch (error) { console.error('Parsing job saved for queue recovery', { jobId: result.job.id, code: error?.code ?? 'QUEUE_UNAVAILABLE' }); }
    }
    return result;
  }
  const { indexingConfig } = options;
  const imported = await prisma.repositoryImport.findFirst({ where: { repositoryId, userId }, include: { repository: true } });
  if (!imported || imported.repository?.deletionRequestedAt) return { notFound: true };
  const indexingJob = requestedIndexingJobId
    ? await prisma.indexingJob.findFirst({ where: { id: requestedIndexingJobId, repositoryId, status: 'completed' } })
    : await prisma.indexingJob.findFirst({ where: { repositoryId, status: 'completed' }, orderBy: { completedAt: 'desc' } });
  if (!indexingJob || !imported.repository.retainedStoragePath) return { unavailable: true };
  if (automatic) {
    const existingForSnapshot = await prisma.parsingJob.findFirst({ where: { repositoryId, indexingJobId: indexingJob.id } });
    if (existingForSnapshot) return { job: existingForSnapshot, alreadyRunning: ACTIVE.includes(existingForSnapshot.status), alreadyProcessed: true };
  }
  const root = resolveRepositoryStorageRoot(indexingConfig.repositoryStorageDir);
  const parts = imported.repository.retainedStoragePath.split(/[\\/]/);
  if (parts.length !== 3 || parts[0] !== 'repositories' || parts[1] !== repositoryId || parts[2] !== indexingJob.id) return { unavailable: true };
  const candidate = path.resolve(root, ...parts);
  if (!within(root, candidate) || candidate === root) return { unavailable: true };
  try {
    const canonicalRoot = await realpath(root);
    const canonicalClone = await realpath(candidate);
    const details = await lstat(canonicalClone);
    if (!within(canonicalRoot, canonicalClone) || !details.isDirectory() || details.isSymbolicLink()) return { unavailable: true };
  } catch { return { unavailable: true }; }
  const active = await prisma.parsingJob.findFirst({ where: { repositoryId, status: { in: ACTIVE } }, orderBy: { createdAt: 'desc' } });
  if (active) return { job: active, alreadyRunning: true };
  const id = randomUUID();
  let job;
  try { job = await prisma.parsingJob.create({ data: { id, repositoryId, indexingJobId: indexingJob.id, bullmqJobId: bullmqJobIdForParsingJob(id) } }); }
  catch (error) {
    if (error.code !== 'P2002') throw error;
    const raced = await prisma.parsingJob.findFirst({ where: { repositoryId, status: { in: ACTIVE } }, orderBy: { createdAt: 'desc' } });
    if (raced) return { job: raced, alreadyRunning: true };
    throw error;
  }
  if (queue) {
    try { await queue.add('parse-repository', { parsingJobId: id }, { jobId: job.bullmqJobId, attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 100, removeOnFail: 500 }); }
    catch (error) { console.error('Parsing job saved for queue recovery', { jobId: id, code: error?.code ?? 'QUEUE_UNAVAILABLE' }); }
  }
  return { job, alreadyRunning: false };
}

export function parsingJobResponse(job) {
  return { id: job.id, repositoryId: job.repositoryId, status: job.status, stage: job.stage, progress: job.progress,
    totalFiles: job.totalFiles, processedFiles: job.processedFiles, parsedFiles: job.parsedFiles,
    skippedFiles: job.skippedFiles, failedFiles: job.failedFiles, totalChunks: job.totalChunks,
    errorMessage: job.errorMessage, startedAt: job.startedAt, completedAt: job.completedAt };
}

export async function finalizeParsingRun({ prisma, job, terminal, parsedFiles, skippedFiles, failedFiles, processedFiles, totalChunks }) {
  await prisma.$transaction(async (tx) => {
    await tx.parsingJob.update({ where: { id: job.id }, data: {
      status: terminal, stage: 'completed', progress: 100, completedAt: new Date(),
      parsedFiles, skippedFiles, failedFiles, processedFiles, totalChunks
    } });
    if (failedFiles === 0) {
      await tx.repositoryFile.deleteMany({
        where: { repositoryId: job.repositoryId, indexingJobId: { not: job.indexingJobId } }
      });
    }
  });
}

export async function recoverQueuedParsingJobs({ prisma, queue, now = Date.now() }) {
  const staleBefore = new Date(now - 5 * 60 * 1000);
  const jobs = await prisma.parsingJob.findMany({ where: { status: { in: ACTIVE } }, orderBy: { createdAt: 'asc' } });
  let enqueued = 0;
  for (const job of jobs) {
    const bullJob = await queue.getJob(job.bullmqJobId);
    if (bullJob) {
      const state = await bullJob.getState();
      if (['waiting', 'waiting-children', 'delayed', 'active', 'prioritized'].includes(state)) continue;
      if (job.status === 'processing' && job.updatedAt > staleBefore) continue;
      if (state === 'failed' && bullJob.attemptsMade >= (bullJob.opts?.attempts ?? 3)) {
        await prisma.parsingJob.updateMany({ where: { id: job.id, status: { in: ACTIVE } }, data: { status: 'failed', stage: 'failed', errorMessage: 'Parsing attempts were exhausted. The retained repository is available for recovery.', completedAt: new Date(now) } });
        continue;
      }
      await bullJob.remove();
    } else if (job.status === 'processing' && job.updatedAt > staleBefore) continue;
    if (job.status === 'processing') {
      const changed = await prisma.parsingJob.updateMany({ where: { id: job.id, status: 'processing', updatedAt: { lt: staleBefore } }, data: { status: 'queued', stage: 'queued', errorMessage: null } });
      if (!changed.count) continue;
    }
    await queue.add('parse-repository', { parsingJobId: job.id }, { jobId: job.bullmqJobId, attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 100, removeOnFail: 500 });
    enqueued++;
  }
  return enqueued;
}

export function createParsingProcessor({ prisma, indexingConfig, maxFileSizeBytes = 2 * 1024 * 1024, maxFiles = 10000 }) {
  return async ({ data }) => {
    const job = await prisma.parsingJob.findUnique({ where: { id: data?.parsingJobId }, include: { repository: true } });
    if (!job || job.repository?.deletionRequestedAt || ['completed', 'completed_with_errors'].includes(job.status)) return;
    const root = await realpath(resolveRepositoryStorageRoot(indexingConfig.repositoryStorageDir));
    const stored = job.repository.retainedStoragePath;
    const parts = typeof stored === 'string' ? stored.split(/[\\/]/) : [];
    if (parts.length !== 3 || parts[0] !== 'repositories' || parts[1] !== job.repositoryId || parts[2] !== job.indexingJobId) throw new Error('The retained repository clone reference is invalid.');
    const clone = path.resolve(root, ...parts);
    if (!within(root, clone) || clone === root) throw new Error('The retained repository clone reference is invalid.');
    const canonicalClone = await realpath(clone);
    if (!within(root, canonicalClone)) throw new Error('The retained repository clone is outside the storage root.');
    const cloneStats = await lstat(canonicalClone);
    if (!cloneStats.isDirectory() || cloneStats.isSymbolicLink()) throw new Error('The retained repository clone is unavailable.');
    const files = await prisma.repositoryFile.findMany({ where: { repositoryId: job.repositoryId, indexingJobId: job.indexingJobId }, orderBy: { relativePath: 'asc' } });
    const selected = files.slice(0, maxFiles);
    await prisma.parsingJob.update({ where: { id: job.id }, data: { status: 'processing', stage: 'parsing', totalFiles: selected.length, startedAt: job.startedAt ?? new Date(), errorMessage: null } });
    await prisma.codeChunk.deleteMany({ where: { parsingJobId: job.id } });
    await prisma.parsingFileResult.deleteMany({ where: { parsingJobId: job.id } });
    let parsedFiles = 0, skippedFiles = files.length - selected.length, failedFiles = 0, totalChunks = 0, processedFiles = 0;
    for (const file of selected) {
      const currentRepository = prisma.repository?.findUnique ? await prisma.repository.findUnique({ where: { id: job.repositoryId }, select: { deletionRequestedAt: true } }) : null;
      if (prisma.repository?.findUnique && (!currentRepository || currentRepository.deletionRequestedAt)) return;
      let status = 'parsed', errorMessage = null, chunks = [];
      try {
        const language = languageForExtension(file.extension);
        if (!language) { status = 'skipped'; skippedFiles++; }
        else if (Number(file.sizeBytes) > maxFileSizeBytes) { status = 'skipped'; skippedFiles++; errorMessage = 'File exceeds the parsing size limit.'; }
        else {
          const candidate = path.resolve(canonicalClone, file.relativePath);
          if (!within(canonicalClone, candidate)) throw new Error('File path escaped repository directory.');
          const canonicalFile = await realpath(candidate);
          if (!within(canonicalClone, canonicalFile)) throw new Error('File path escaped repository directory.');
          const content = await readFile(canonicalFile);
          if (content.includes(0)) throw new Error('File is not valid text.');
          const result = parseSource(content.toString('utf8'), file.extension);
          chunks = result.chunks;
          parsedFiles++;
          if (result.hasErrors) { status = 'parsed_with_errors'; errorMessage = 'Source contains syntax errors; recoverable structures were retained.'; }
        }
      } catch (error) { status = 'failed'; failedFiles++; errorMessage = error.message === 'File path escaped repository directory.' ? error.message : 'File could not be read or parsed.'; }
      if (chunks.length) {
        await prisma.codeChunk.createMany({ data: chunks.map((chunk) => ({ parsingJobId: job.id, repositoryId: job.repositoryId, fileId: file.id, relativePath: file.relativePath, language: languageForExtension(file.extension), ...chunk, sourceHash: createHash('sha256').update(chunk.source).digest('hex') })), skipDuplicates: true });
        totalChunks += chunks.length;
      }
      await prisma.parsingFileResult.upsert({ where: { parsingJobId_fileId: { parsingJobId: job.id, fileId: file.id } }, create: { parsingJobId: job.id, fileId: file.id, status, errorMessage, chunkCount: chunks.length }, update: { status, errorMessage, chunkCount: chunks.length } });
      processedFiles++;
      await prisma.parsingJob.update({ where: { id: job.id }, data: { processedFiles, parsedFiles, skippedFiles, failedFiles, totalChunks, progress: selected.length ? Math.floor(processedFiles * 95 / selected.length) : 95, stage: 'parsing' } });
    }
    const terminal = failedFiles || skippedFiles ? 'completed_with_errors' : 'completed';
    await finalizeParsingRun({ prisma, job, terminal, parsedFiles, skippedFiles, failedFiles, processedFiles, totalChunks });
    if (failedFiles === 0) {
      const { removeRetainedClone } = await import('./retained-repository-storage.service.js');
      const removed = await removeRetainedClone({ storageDir: indexingConfig.repositoryStorageDir, storagePath: stored });
      if (removed) {
        await prisma.repository.updateMany({ where: { id: job.repositoryId, retainedStoragePath: stored }, data: { retainedStoragePath: null } });
      }
    }
  };
}
