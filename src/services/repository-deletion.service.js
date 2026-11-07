import { HttpError } from '../lib/http-error.js';
import { removeRetainedClone } from './retained-repository-storage.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function removeQueuedJobs(queue, jobIds) {
  if (!queue) return;
  for (const id of jobIds) {
    try {
      const job = await queue.getJob(id);
      if (!job) continue;
      const state = await job.getState();
      if (state !== 'active') await job.remove();
    } catch {
      // A job may become active between state lookup and removal; its database row is invalidated below.
    }
  }
}

export async function deleteRepositoryForUser({ prisma, repositoryId, userId, queues = [], storageDir }) {
  if (typeof repositoryId !== 'string' || !UUID.test(repositoryId)) {
    throw new HttpError(404, 'REPOSITORY_NOT_FOUND', 'Repository was not found in your imports.');
  }
  const initial = await prisma.$transaction(async (tx) => {
    const owned = await tx.repositoryImport.findFirst({
      where: { repositoryId, userId },
      include: { repository: true }
    });
    if (!owned) throw new HttpError(404, 'REPOSITORY_NOT_FOUND', 'Repository was not found in your imports.');

    // Serialize last-owner deletion with imports and other deletion requests for this repository.
    await tx.$queryRawUnsafe('SELECT "id" FROM "Repository" WHERE "id" = $1::uuid FOR UPDATE', repositoryId);
    const imports = await tx.repositoryImport.count({ where: { repositoryId } });
    if (imports > 1) {
      await tx.repositoryImport.delete({ where: { userId_repositoryId: { userId, repositoryId } } });
      return { shared: true };
    }

    const repository = await tx.repository.findUnique({ where: { id: repositoryId } });
    if (!repository) throw new HttpError(404, 'REPOSITORY_NOT_FOUND', 'Repository was not found in your imports.');
    await tx.repository.update({ where: { id: repositoryId }, data: { deletionRequestedAt: repository.deletionRequestedAt ?? new Date() } });
    const [indexing, parsing, embeddings] = await Promise.all([
      tx.indexingJob.findMany({ where: { repositoryId }, select: { bullmqJobId: true } }),
      tx.parsingJob.findMany({ where: { repositoryId }, select: { bullmqJobId: true } }),
      tx.embeddingJob.findMany({ where: { repositoryId }, select: { bullmqJobId: true } })
    ]);
    return { shared: false, storagePath: repository.retainedStoragePath, jobIds: [indexing, parsing, embeddings].map((jobs) => jobs.map((job) => job.bullmqJobId)) };
  });

  if (initial.shared) return { deleted: false, detached: true };

  try {
    for (let i = 0; i < queues.length; i++) await removeQueuedJobs(queues[i], initial.jobIds[i] ?? []);
    if (initial.storagePath) await removeRetainedClone({ storageDir, storagePath: initial.storagePath });
    await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "Repository" WHERE "id" = $1::uuid FOR UPDATE', repositoryId);
      const deleted = await tx.repository.deleteMany({ where: { id: repositoryId, deletionRequestedAt: { not: null } } });
      if (!deleted.count && await tx.repository.findUnique({ where: { id: repositoryId } })) {
        throw new Error('Repository deletion marker was not present');
      }
    });
    return { deleted: true, detached: false };
  } catch (error) {
    throw new HttpError(503, 'REPOSITORY_DELETE_INCOMPLETE', 'Repository cleanup could not be completed. Retry deletion to finish removing it.');
  }
}
