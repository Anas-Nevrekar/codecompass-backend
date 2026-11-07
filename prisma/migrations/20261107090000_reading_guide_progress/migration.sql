CREATE TABLE "ReadingProgress" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "repositoryId" UUID NOT NULL,
  "parsingJobId" UUID NOT NULL,
  "activeStageId" TEXT,
  "statusByStage" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReadingProgress_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReadingProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReadingProgress_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ReadingProgress_userId_repositoryId_key" ON "ReadingProgress"("userId", "repositoryId");
CREATE INDEX "ReadingProgress_repositoryId_parsingJobId_idx" ON "ReadingProgress"("repositoryId", "parsingJobId");
