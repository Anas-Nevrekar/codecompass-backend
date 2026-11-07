-- Replace incompatible Qwen embeddings while preserving all parsed code chunks.
-- The guard makes the data migration safe to re-run after Gemini vectors exist.
DO $$
DECLARE
  has_legacy_embeddings BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM "CodeEmbedding"
    WHERE "embeddingDimensions" <> 768 OR "embeddingModel" <> 'gemini-embedding-001'
  ) INTO has_legacy_embeddings;

  DELETE FROM "CodeEmbedding"
  WHERE "embeddingDimensions" <> 768 OR "embeddingModel" <> 'gemini-embedding-001';

  ALTER TABLE "CodeEmbedding" DROP CONSTRAINT IF EXISTS "CodeEmbedding_dimensions_check";
  ALTER TABLE "CodeEmbedding" ALTER COLUMN "embedding" TYPE vector(768);
  ALTER TABLE "CodeEmbedding" ADD CONSTRAINT "CodeEmbedding_dimensions_check" CHECK ("embeddingDimensions" = 768);

  -- No vector index existed on the previous schema. Create cosine HNSW for search.
  CREATE INDEX IF NOT EXISTS "CodeEmbedding_embedding_hnsw_idx"
    ON "CodeEmbedding" USING hnsw ("embedding" vector_cosine_ops);

  IF has_legacy_embeddings THEN
    -- Stop old queued work and schedule only the latest successful parse for each repository.
    UPDATE "EmbeddingJob"
    SET "status" = 'failed', "stage" = 'failed',
        "errorMessage" = 'Embedding vectors were invalidated during the Gemini provider migration; a replacement job was scheduled.',
        "completedAt" = NOW(), "updatedAt" = NOW()
    WHERE "status" IN ('queued', 'processing');

    WITH latest_parses AS (
      SELECT DISTINCT ON (p."repositoryId") p."id", p."repositoryId", p."totalChunks"
      FROM "ParsingJob" p
      WHERE p."status" IN ('completed', 'completed_with_errors')
        AND p."failedFiles" = 0 AND p."totalChunks" > 0
      ORDER BY p."repositoryId", p."completedAt" DESC NULLS LAST, p."createdAt" DESC
    )
    UPDATE "EmbeddingJob" j
    SET "bullmqJobId" = 'embed-' || generated."queueId"::text,
        "status" = 'queued', "stage" = 'queued', "progress" = 0,
        "totalChunks" = p."totalChunks", "processedChunks" = 0,
        "embeddedChunks" = 0, "skippedChunks" = 0, "failedChunks" = 0,
        "errorMessage" = NULL, "startedAt" = NULL, "completedAt" = NULL,
        "updatedAt" = NOW()
    FROM latest_parses p
    CROSS JOIN LATERAL (SELECT gen_random_uuid() AS "queueId") generated
    WHERE j."id" = (
      SELECT previous."id" FROM "EmbeddingJob" previous
      WHERE previous."parsingJobId" = p."id"
      ORDER BY previous."createdAt" DESC LIMIT 1
    );

    WITH latest_parses AS (
      SELECT DISTINCT ON (p."repositoryId") p."id", p."repositoryId", p."totalChunks"
      FROM "ParsingJob" p
      WHERE p."status" IN ('completed', 'completed_with_errors')
        AND p."failedFiles" = 0 AND p."totalChunks" > 0
      ORDER BY p."repositoryId", p."completedAt" DESC NULLS LAST, p."createdAt" DESC
    )
    INSERT INTO "EmbeddingJob" (
      "id", "repositoryId", "parsingJobId", "status", "stage", "progress",
      "totalChunks", "bullmqJobId", "createdAt", "updatedAt"
    )
    SELECT gen_random_uuid(), p."repositoryId", p."id", 'queued', 'queued', 0,
           p."totalChunks", 'embed-' || gen_random_uuid()::text, NOW(), NOW()
    FROM latest_parses p
    WHERE NOT EXISTS (SELECT 1 FROM "EmbeddingJob" j WHERE j."parsingJobId" = p."id");
  END IF;
END $$;
