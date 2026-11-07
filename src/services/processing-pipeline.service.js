import { createParsingJob } from './parsing-job.service.js';
import { createEmbeddingJob } from './embedding-job.service.js';

export async function advanceRepositoryPipeline({ prisma, parsingQueue, embeddingQueue, indexingConfig, config, indexingJobId, parsingJobId }) {
  if (indexingJobId) {
    const indexing = await prisma.indexingJob.findUnique({ where: { id: indexingJobId } });
    if (indexing?.status === 'completed') {
      await createParsingJob({ prisma, queue: parsingQueue, repositoryId: indexing.repositoryId, userId: indexing.userId, indexingConfig, indexingJobId, automatic: true });
    }
  }
  if (parsingJobId) {
    const parsing = await prisma.parsingJob.findUnique({ where: { id: parsingJobId } });
    if (parsing && ['completed', 'completed_with_errors'].includes(parsing.status) && parsing.failedFiles === 0) {
      const imported = await prisma.repositoryImport.findFirst({ where: { repositoryId: parsing.repositoryId }, orderBy: { importedAt: 'asc' } });
      if (imported) await createEmbeddingJob({ prisma, queue: embeddingQueue, repositoryId: parsing.repositoryId, userId: imported.userId, config, parsingJobId, automatic: true });
    }
  }
}

export async function recoverRepositoryPipeline({ prisma, parsingQueue, embeddingQueue, indexingConfig, config }) {
  const indexes = await prisma.indexingJob.findMany({ where: { status: 'completed' }, orderBy: { completedAt: 'asc' } });
  for (const indexing of indexes) {
    const parsed = await prisma.parsingJob.findFirst({ where: { indexingJobId: indexing.id } });
    if (!parsed) await advanceRepositoryPipeline({ prisma, parsingQueue, embeddingQueue, indexingConfig, config, indexingJobId: indexing.id });
  }
  const parses = await prisma.parsingJob.findMany({ where: { status: { in: ['completed', 'completed_with_errors'] }, failedFiles: 0 }, orderBy: { completedAt: 'asc' } });
  for (const parsing of parses) {
    const embedded = await prisma.embeddingJob.findFirst({ where: { parsingJobId: parsing.id } });
    if (!embedded) await advanceRepositoryPipeline({ prisma, parsingQueue, embeddingQueue, indexingConfig, config, parsingJobId: parsing.id });
  }
}
