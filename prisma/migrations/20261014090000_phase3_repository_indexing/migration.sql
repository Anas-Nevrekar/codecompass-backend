CREATE TYPE "IndexingStatus" AS ENUM ('queued', 'cloning', 'filtering', 'saving_inventory', 'completed', 'failed');

ALTER TABLE "Repository" ADD COLUMN "lastIndexedCommitSha" TEXT;
ALTER TABLE "Repository" ADD COLUMN "lastIndexedAt" TIMESTAMP(3);
ALTER TABLE "Repository" ADD COLUMN "lastIndexedFileCount" INTEGER;

CREATE TABLE "IndexingJob" (
    "id" UUID NOT NULL,
    "repositoryId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "activeRepositoryId" UUID,
    "status" "IndexingStatus" NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "message" TEXT NOT NULL DEFAULT 'Waiting to start',
    "discoveredFileCount" INTEGER NOT NULL DEFAULT 0,
    "eligibleFileCount" INTEGER NOT NULL DEFAULT 0,
    "excludedFileCount" INTEGER NOT NULL DEFAULT 0,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "bullmqJobId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IndexingJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RepositoryFile" (
    "id" UUID NOT NULL,
    "repositoryId" UUID NOT NULL,
    "indexingJobId" UUID NOT NULL,
    "relativePath" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RepositoryFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IndexingJob_activeRepositoryId_key" ON "IndexingJob"("activeRepositoryId");
CREATE UNIQUE INDEX "IndexingJob_bullmqJobId_key" ON "IndexingJob"("bullmqJobId");
CREATE INDEX "IndexingJob_status_createdAt_idx" ON "IndexingJob"("status", "createdAt");
CREATE INDEX "IndexingJob_repositoryId_createdAt_idx" ON "IndexingJob"("repositoryId", "createdAt");
CREATE INDEX "IndexingJob_userId_createdAt_idx" ON "IndexingJob"("userId", "createdAt");

CREATE UNIQUE INDEX "RepositoryFile_repositoryId_relativePath_key" ON "RepositoryFile"("repositoryId", "relativePath");
CREATE INDEX "RepositoryFile_repositoryId_idx" ON "RepositoryFile"("repositoryId");
CREATE INDEX "RepositoryFile_indexingJobId_idx" ON "RepositoryFile"("indexingJobId");
CREATE INDEX "RepositoryFile_extension_idx" ON "RepositoryFile"("extension");
CREATE INDEX "RepositoryFile_category_idx" ON "RepositoryFile"("category");

ALTER TABLE "IndexingJob" ADD CONSTRAINT "IndexingJob_repositoryId_fkey"
  FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IndexingJob" ADD CONSTRAINT "IndexingJob_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepositoryFile" ADD CONSTRAINT "RepositoryFile_repositoryId_fkey"
  FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepositoryFile" ADD CONSTRAINT "RepositoryFile_indexingJobId_fkey"
  FOREIGN KEY ("indexingJobId") REFERENCES "IndexingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
