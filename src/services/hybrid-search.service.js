import { formatSearchQuery } from './ollama-embedding.service.js';

export function fuseRankedResults(vectorResults, keywordResults, { k = 60, limit = 10 } = {}) {
  const combined = new Map();
  function add(rows, source) {
    const seen = new Set();
    rows.forEach((row, index) => {
      const id = row.chunkId ?? row.id;
      if (seen.has(id)) return;
      seen.add(id);
      let item = combined.get(id);
      if (!item) { item = { ...row, chunkId: id, vectorRank: null, keywordRank: null, rrfScore: 0, matchedBy: [] }; combined.set(id, item); }
      const rank = index + 1;
      item[`${source}Rank`] = rank;
      item.rrfScore += 1 / (k + rank);
      item.matchedBy.push(source);
    });
  }
  add(vectorResults, 'vector'); add(keywordResults, 'keyword');
  return [...combined.values()].sort((a, b) => b.rrfScore - a.rrfScore || a.chunkId.localeCompare(b.chunkId)).slice(0, limit);
}

export async function vectorSearch({ prisma, repositoryId, parsingJobId, model, dimensions, vector, limit }) {
  const value = `[${vector.join(',')}]`;
  return prisma.$queryRaw`
    SELECT c."id" AS "chunkId", c."relativePath" AS "filePath", c."language", c."structureType", c."symbolName", c."startLine", c."endLine", c."source" AS "sourceCode", c."metadata", e."embedding" <=> ${value}::vector AS distance
    FROM "CodeEmbedding" e JOIN "CodeChunk" c ON c."id" = e."codeChunkId"
    WHERE e."repositoryId" = ${repositoryId}::uuid AND e."embeddingModel" = ${model} AND e."embeddingDimensions" = ${dimensions}
      AND c."repositoryId" = ${repositoryId}::uuid AND c."parsingJobId" = ${parsingJobId}::uuid
    ORDER BY e."embedding" <=> ${value}::vector LIMIT ${limit}`;
}

export async function keywordSearch({ prisma, repositoryId, parsingJobId, query, limit }) {
  return prisma.$queryRaw`
    WITH terms AS (SELECT websearch_to_tsquery('simple', ${query}) AS tsq)
    SELECT c."id" AS "chunkId", c."relativePath" AS "filePath", c."language", c."structureType", c."symbolName", c."startLine", c."endLine", c."source" AS "sourceCode", c."metadata"
    FROM "CodeChunk" c CROSS JOIN terms
    WHERE c."repositoryId" = ${repositoryId}::uuid AND c."parsingJobId" = ${parsingJobId}::uuid AND (
      to_tsvector('simple', concat_ws(' ', c."symbolName", c."relativePath", c."language", c."structureType", c."source")) @@ terms.tsq
      OR strpos(lower(concat_ws(' ', c."symbolName", c."relativePath", c."source")), lower(${query})) > 0
    )
    ORDER BY CASE WHEN lower(coalesce(c."symbolName", '')) = lower(${query}) THEN 0
                  WHEN strpos(lower(concat_ws(' ', c."symbolName", c."relativePath")), lower(${query})) > 0 THEN 1 ELSE 2 END,
             ts_rank_cd(to_tsvector('simple', concat_ws(' ', c."symbolName", c."relativePath", c."language", c."structureType", c."source")), terms.tsq) DESC,
             c."relativePath", c."startLine"
    LIMIT ${limit}`;
}

export async function hybridSearch({ prisma, embeddingService, config, repositoryId, userId, query, limit }) {
  const imported = await prisma.repositoryImport.findFirst({ where: { repositoryId, userId } });
  if (!imported) return { notFound: true };
  const parsingJob = await prisma.parsingJob.findFirst({ where: { repositoryId, status: { in: ['completed', 'completed_with_errors'] } }, orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }] });
  if (!parsingJob) return { unavailable: true };
  const embeddingCount = await prisma.codeEmbedding.count({ where: { repositoryId, embeddingModel: config.embedding.model, embeddingDimensions: config.embedding.dimensions, codeChunk: { parsingJobId: parsingJob.id } } });
  if (!embeddingCount) return { embeddingsMissing: true };
  const queryVector = await embeddingService.embedOne(formatSearchQuery(query));
  const [vectors, keywords] = await Promise.all([
    vectorSearch({ prisma, repositoryId, parsingJobId: parsingJob.id, model: config.embedding.model, dimensions: config.embedding.dimensions, vector: queryVector, limit: config.search.vectorLimit }),
    keywordSearch({ prisma, repositoryId, parsingJobId: parsingJob.id, query, limit: config.search.keywordLimit })
  ]);
  return { results: fuseRankedResults(vectors, keywords, { k: config.search.rrfK, limit }), parsingJobId: parsingJob.id };
}
