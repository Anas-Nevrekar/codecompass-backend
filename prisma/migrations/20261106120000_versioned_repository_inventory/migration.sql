DROP INDEX "RepositoryFile_repositoryId_relativePath_key";

CREATE UNIQUE INDEX "RepositoryFile_repositoryId_indexingJobId_relativePath_key"
ON "RepositoryFile"("repositoryId", "indexingJobId", "relativePath");
