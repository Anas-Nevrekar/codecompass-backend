CREATE TYPE "ParsingStatus" AS ENUM ('queued', 'processing', 'completed', 'completed_with_errors', 'failed');

CREATE TABLE "ParsingJob" (
  "id" UUID NOT NULL,
  "repositoryId" UUID NOT NULL,
  "indexingJobId" UUID NOT NULL,
  "status" "ParsingStatus" NOT NULL DEFAULT 'queued',
  "stage" TEXT NOT NULL DEFAULT 'queued',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "totalFiles" INTEGER NOT NULL DEFAULT 0,
  "processedFiles" INTEGER NOT NULL DEFAULT 0,
  "parsedFiles" INTEGER NOT NULL DEFAULT 0,
  "skippedFiles" INTEGER NOT NULL DEFAULT 0,
  "failedFiles" INTEGER NOT NULL DEFAULT 0,
  "totalChunks" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" TEXT,
  "bullmqJobId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ParsingJob_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CodeChunk" (
  "id" UUID NOT NULL,
  "parsingJobId" UUID NOT NULL,
  "repositoryId" UUID NOT NULL,
  "fileId" UUID NOT NULL,
  "relativePath" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "structureType" TEXT NOT NULL,
  "symbolName" TEXT,
  "startLine" INTEGER NOT NULL,
  "endLine" INTEGER NOT NULL,
  "source" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "sourceHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CodeChunk_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ParsingFileResult" (
  "id" UUID NOT NULL,
  "parsingJobId" UUID NOT NULL,
  "fileId" UUID NOT NULL,
  "status" TEXT NOT NULL,
  "errorMessage" TEXT,
  "chunkCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ParsingFileResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ParsingJob_bullmqJobId_key" ON "ParsingJob"("bullmqJobId");
CREATE INDEX "ParsingJob_repositoryId_createdAt_idx" ON "ParsingJob"("repositoryId", "createdAt");
CREATE INDEX "ParsingJob_status_createdAt_idx" ON "ParsingJob"("status", "createdAt");
CREATE UNIQUE INDEX "ParsingJob_one_active_per_repository_idx" ON "ParsingJob"("repositoryId") WHERE "status" IN ('queued', 'processing');
CREATE UNIQUE INDEX "CodeChunk_parsingJobId_fileId_structureType_startLine_endLine_sourceHash_key" ON "CodeChunk"("parsingJobId", "fileId", "structureType", "startLine", "endLine", "sourceHash");
CREATE INDEX "CodeChunk_repositoryId_parsingJobId_idx" ON "CodeChunk"("repositoryId", "parsingJobId");
CREATE INDEX "CodeChunk_fileId_idx" ON "CodeChunk"("fileId");
CREATE UNIQUE INDEX "ParsingFileResult_parsingJobId_fileId_key" ON "ParsingFileResult"("parsingJobId", "fileId");
ALTER TABLE "ParsingJob" ADD CONSTRAINT "ParsingJob_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ParsingJob" ADD CONSTRAINT "ParsingJob_indexingJobId_fkey" FOREIGN KEY ("indexingJobId") REFERENCES "IndexingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeChunk" ADD CONSTRAINT "CodeChunk_parsingJobId_fkey" FOREIGN KEY ("parsingJobId") REFERENCES "ParsingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeChunk" ADD CONSTRAINT "CodeChunk_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeChunk" ADD CONSTRAINT "CodeChunk_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "RepositoryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ParsingFileResult" ADD CONSTRAINT "ParsingFileResult_parsingJobId_fkey" FOREIGN KEY ("parsingJobId") REFERENCES "ParsingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ParsingFileResult" ADD CONSTRAINT "ParsingFileResult_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "RepositoryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
