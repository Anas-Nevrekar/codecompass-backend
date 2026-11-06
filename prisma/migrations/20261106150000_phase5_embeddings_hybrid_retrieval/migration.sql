CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "EmbeddingStatus" AS ENUM ('queued', 'processing', 'completed', 'completed_with_errors', 'failed');

CREATE TABLE "EmbeddingJob" (
  "id" UUID NOT NULL,
  "repositoryId" UUID NOT NULL,
  "parsingJobId" UUID NOT NULL,
  "status" "EmbeddingStatus" NOT NULL DEFAULT 'queued',
  "stage" TEXT NOT NULL DEFAULT 'queued',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "totalChunks" INTEGER NOT NULL DEFAULT 0,
  "processedChunks" INTEGER NOT NULL DEFAULT 0,
  "embeddedChunks" INTEGER NOT NULL DEFAULT 0,
  "skippedChunks" INTEGER NOT NULL DEFAULT 0,
  "failedChunks" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" TEXT,
  "bullmqJobId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmbeddingJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmbeddingJob_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EmbeddingJob_parsingJobId_fkey" FOREIGN KEY ("parsingJobId") REFERENCES "ParsingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmbeddingJob_bullmqJobId_key" ON "EmbeddingJob"("bullmqJobId");
CREATE INDEX "EmbeddingJob_repositoryId_createdAt_idx" ON "EmbeddingJob"("repositoryId", "createdAt");
CREATE INDEX "EmbeddingJob_status_createdAt_idx" ON "EmbeddingJob"("status", "createdAt");
CREATE UNIQUE INDEX "EmbeddingJob_one_active_per_repository" ON "EmbeddingJob"("repositoryId") WHERE "status" IN ('queued', 'processing');

CREATE TABLE "CodeEmbedding" (
  "id" UUID NOT NULL,
  "codeChunkId" UUID NOT NULL,
  "repositoryId" UUID NOT NULL,
  "embeddingModel" TEXT NOT NULL,
  "embeddingDimensions" INTEGER NOT NULL,
  "embedding" vector(1024) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CodeEmbedding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CodeEmbedding_codeChunkId_fkey" FOREIGN KEY ("codeChunkId") REFERENCES "CodeChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CodeEmbedding_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CodeEmbedding_dimensions_check" CHECK ("embeddingDimensions" = 1024)
);
CREATE UNIQUE INDEX "CodeEmbedding_chunk_model_dimensions_key" ON "CodeEmbedding"("codeChunkId", "embeddingModel", "embeddingDimensions");
CREATE INDEX "CodeEmbedding_repository_model_dimensions_idx" ON "CodeEmbedding"("repositoryId", "embeddingModel", "embeddingDimensions");
