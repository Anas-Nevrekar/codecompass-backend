export async function replaceRepositoryInventory({ prisma, indexingJobId, repositoryId, files, counts, commitSha }) {
  return prisma.$transaction(async (tx) => {
    await tx.repositoryFile.deleteMany({ where: { repositoryId } });
    for (let offset = 0; offset < files.length; offset += 500) {
      await tx.repositoryFile.createMany({
        data: files.slice(offset, offset + 500).map((file) => ({
          ...file,
          repositoryId,
          indexingJobId
        }))
      });
    }
    const indexedAt = new Date();
    await tx.repository.update({
      where: { id: repositoryId },
      data: { lastIndexedCommitSha: commitSha, lastIndexedAt: indexedAt, lastIndexedFileCount: counts.eligibleFileCount }
    });
    await tx.indexingJob.update({
      where: { id: indexingJobId },
      data: {
        status: 'completed', stage: 'completed', message: 'Repository inventory is ready', progress: 100,
        discoveredFileCount: counts.discoveredFileCount,
        eligibleFileCount: counts.eligibleFileCount,
        excludedFileCount: counts.excludedFileCount,
        errorCode: null, errorMessage: null, completedAt: indexedAt, activeRepositoryId: null
      }
    });
  }, { maxWait: 10000, timeout: 120000 });
}
