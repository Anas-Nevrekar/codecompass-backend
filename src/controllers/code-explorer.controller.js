import { HttpError } from '../lib/http-error.js';
import { buildCodeGraph, buildReadingGuide, CODE_EXPLORER_LIMITS, validateRepositoryFilePath } from '../services/code-explorer.service.js';

const completedParseStatuses = ['completed', 'completed_with_errors'];
const activeIndexingStatuses = ['queued', 'cloning', 'filtering', 'saving_inventory'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const readingStageIds = new Set(['repository-map', 'initialization', 'application-flow', 'core-functionality', 'data-architecture', 'dependencies', 'next-exploration']);
const readingStatuses = new Set(['not-started', 'in-progress', 'completed']);

function parsePositiveInteger(value, name) {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100000) throw new HttpError(400, 'INVALID_QUERY', `${name} must be an integer between 1 and 100000.`);
  return Number(value);
}

export function createCodeExplorerController({ prisma }) {
  async function getCurrentAnalysis(repositoryId, userId) {
    if (!UUID_PATTERN.test(repositoryId)) throw new HttpError(400, 'INVALID_REPOSITORY_ID', 'Provide a valid repository ID.');
    const imported = await prisma.repositoryImport.findFirst({ where: { repositoryId, userId }, select: { id: true } });
    if (!imported) throw new HttpError(404, 'REPOSITORY_NOT_FOUND', 'Imported repository was not found.');
    const indexingJob = await prisma.indexingJob.findFirst({ where: { repositoryId }, orderBy: { createdAt: 'desc' } });
    if (!indexingJob) return { status: 'not_indexed' };
    if (activeIndexingStatuses.includes(indexingJob.status)) return { status: 'indexing' };
    if (indexingJob.status !== 'completed') return { status: indexingJob.status === 'failed' ? 'failed' : 'not_indexed' };
    const parsingJob = await prisma.parsingJob.findFirst({ where: { repositoryId }, orderBy: { createdAt: 'desc' } });
    if (!parsingJob) return { status: 'not_parsed', indexingJob };
    if (parsingJob.indexingJobId !== indexingJob.id) return { status: 'stale', indexingJob, parsingJob };
    if (parsingJob.status === 'queued' || parsingJob.status === 'processing') return { status: 'parsing', indexingJob, parsingJob };
    if (parsingJob.status === 'failed') return { status: 'failed', indexingJob, parsingJob };
    if (!completedParseStatuses.includes(parsingJob.status)) return { status: 'stale', indexingJob, parsingJob };
    return { status: 'ready', indexingJob, parsingJob };
  }

  async function loadGraph(repositoryId, analysis) {
    const [files, chunks] = await Promise.all([
      prisma.repositoryFile.findMany({ where: { repositoryId, indexingJobId: analysis.indexingJob.id }, orderBy: { relativePath: 'asc' }, take: CODE_EXPLORER_LIMITS.FILE_LIMIT + 1,
        select: { id: true, relativePath: true, extension: true, category: true } }),
      prisma.codeChunk.findMany({ where: { repositoryId, parsingJobId: analysis.parsingJob.id }, orderBy: [{ relativePath: 'asc' }, { startLine: 'asc' }], take: CODE_EXPLORER_LIMITS.CHUNK_LIMIT + 1,
        select: { id: true, relativePath: true, language: true, structureType: true, symbolName: true, startLine: true, endLine: true, metadata: true } })
    ]);
    const truncated = files.length > CODE_EXPLORER_LIMITS.FILE_LIMIT || chunks.length > CODE_EXPLORER_LIMITS.CHUNK_LIMIT;
    return { files: files.slice(0, CODE_EXPLORER_LIMITS.FILE_LIMIT), chunks: chunks.slice(0, CODE_EXPLORER_LIMITS.CHUNK_LIMIT), truncated };
  }

  async function loadStorySources(repositoryId, analysis, chunks) {
    const paths = [...new Set(chunks.filter((chunk) => /(^|\/)(app|main|index|server|routes?|controllers?|handlers?|services?|components?|pages?|models?|schemas?|config|database|db|frontend|client|web|ui)(\/|\.|$)/i.test(chunk.relativePath))
      .map((chunk) => chunk.relativePath))]
      .sort((a, b) => {
        const score = (path) => (/(^|\/)(app|main|index|server)(\.|\/|$)/i.test(path) ? 0 : 0) + (/(^|\/)(routes?|controllers?|handlers?|services?|models?|schemas?|config|database|db)(\/|\.|$)/i.test(path) ? 1 : 0) + (/(^|\/)(frontend|client|web|ui)(\/|$)/i.test(path) ? 2 : 0);
        return score(a) - score(b) || a.localeCompare(b);
      }).slice(0, 80);
    if (!paths.length) return chunks;
    const sourceRows = await prisma.codeChunk.findMany({ where: { repositoryId, parsingJobId: analysis.parsingJob.id, relativePath: { in: paths } },
      orderBy: [{ relativePath: 'asc' }, { startLine: 'asc' }], take: 500, select: { id: true, source: true } });
    let remaining = 750_000;
    const sources = new Map();
    for (const row of sourceRows) {
      if (remaining <= 0) break;
      if (typeof row.source !== 'string') continue;
      const source = row.source.slice(0, remaining);
      remaining -= source.length;
      sources.set(row.id, source);
    }
    return chunks.map((chunk) => ({ ...chunk, source: sources.get(chunk.id) ?? '' }));
  }

  function notReady(repositoryId, analysis) {
    return { repositoryId, status: analysis.status, nodes: [], edges: [], metadata: { totalNodes: 0, totalEdges: 0, hasUncertainRelationships: false } };
  }

  return {
    async graph(req, res, next) {
      try {
        const analysis = await getCurrentAnalysis(req.params.repositoryId, req.auth.userId);
        if (analysis.status !== 'ready') return res.json(notReady(req.params.repositoryId, analysis));
        const data = await loadGraph(req.params.repositoryId, analysis);
        res.json(buildCodeGraph({ repositoryId: req.params.repositoryId, indexingJobId: analysis.indexingJob.id, parsingJob: analysis.parsingJob, ...data }));
      } catch (error) { next(error); }
    },
    async readingGuide(req, res, next) {
      try {
        const analysis = await getCurrentAnalysis(req.params.repositoryId, req.auth.userId);
        if (analysis.status !== 'ready') return res.json({ ...notReady(req.params.repositoryId, analysis), recommendations: [], metadata: { totalRecommendations: 0, method: 'static-analysis' } });
        const data = await loadGraph(req.params.repositoryId, analysis);
        const storyChunks = await loadStorySources(req.params.repositoryId, analysis, data.chunks);
        const graph = buildCodeGraph({ repositoryId: req.params.repositoryId, indexingJobId: analysis.indexingJob.id, parsingJob: analysis.parsingJob, ...data, chunks: storyChunks });
        res.json(buildReadingGuide({ repositoryId: req.params.repositoryId, ...data, chunks: storyChunks, graph }));
      } catch (error) { next(error); }
    },
    async readingProgress(req, res, next) {
      try {
        const analysis = await getCurrentAnalysis(req.params.repositoryId, req.auth.userId);
        if (analysis.status !== 'ready') return res.json({ repositoryId: req.params.repositoryId, status: analysis.status, parsingJobId: null, progress: null });
        const saved = await prisma.readingProgress.findUnique({ where: { userId_repositoryId: { userId: req.auth.userId, repositoryId: req.params.repositoryId } } });
        const progress = saved?.parsingJobId === analysis.parsingJob.id ? {
          parsingJobId: saved.parsingJobId, activeStageId: saved.activeStageId, statusByStage: saved.statusByStage
        } : null;
        res.json({ repositoryId: req.params.repositoryId, status: 'ready', parsingJobId: analysis.parsingJob.id, progress });
      } catch (error) { next(error); }
    },
    async saveReadingProgress(req, res, next) {
      try {
        const analysis = await getCurrentAnalysis(req.params.repositoryId, req.auth.userId);
        if (analysis.status !== 'ready') throw new HttpError(409, 'ANALYSIS_NOT_READY', 'Repository parsing is not ready for saving guide progress.');
        const { parsingJobId, activeStageId = null, statusByStage } = req.body ?? {};
        if (parsingJobId !== analysis.parsingJob.id) throw new HttpError(409, 'STALE_ANALYSIS', 'Guide progress must match the current parsing job.');
        if (activeStageId !== null && (typeof activeStageId !== 'string' || !readingStageIds.has(activeStageId))) throw new HttpError(400, 'INVALID_READING_PROGRESS', 'Provide a valid active guide stage.');
        if (!statusByStage || typeof statusByStage !== 'object' || Array.isArray(statusByStage) || Object.keys(statusByStage).some((stageId) => !readingStageIds.has(stageId) || !readingStatuses.has(statusByStage[stageId]))) {
          throw new HttpError(400, 'INVALID_READING_PROGRESS', 'Provide valid statuses for the supported guide stages.');
        }
        const saved = await prisma.readingProgress.upsert({
          where: { userId_repositoryId: { userId: req.auth.userId, repositoryId: req.params.repositoryId } },
          create: { userId: req.auth.userId, repositoryId: req.params.repositoryId, parsingJobId, activeStageId, statusByStage },
          update: { parsingJobId, activeStageId, statusByStage }
        });
        res.json({ repositoryId: req.params.repositoryId, status: 'ready', progress: {
          parsingJobId: saved.parsingJobId, activeStageId: saved.activeStageId, statusByStage: saved.statusByStage
        } });
      } catch (error) { next(error); }
    },
    async source(req, res, next) {
      try {
        const analysis = await getCurrentAnalysis(req.params.repositoryId, req.auth.userId);
        if (analysis.status !== 'ready') throw new HttpError(409, 'ANALYSIS_NOT_READY', 'Repository parsing is not ready for source navigation.');
        const filePath = req.query.filePath;
        if (!validateRepositoryFilePath(filePath)) throw new HttpError(400, 'INVALID_FILE_PATH', 'Provide a valid repository-relative file path.');
        const startLine = parsePositiveInteger(req.query.startLine, 'startLine');
        const endLine = parsePositiveInteger(req.query.endLine, 'endLine');
        if (req.query.chunkId !== undefined && !UUID_PATTERN.test(req.query.chunkId)) throw new HttpError(400, 'INVALID_CHUNK_ID', 'Provide a valid source chunk ID.');
        if (startLine && endLine && (endLine < startLine || endLine - startLine > 2000)) throw new HttpError(400, 'INVALID_LINE_RANGE', 'Line range must be ordered and no wider than 2000 lines.');
        const file = await prisma.repositoryFile.findFirst({ where: { repositoryId: req.params.repositoryId, indexingJobId: analysis.indexingJob.id, relativePath: filePath }, select: { id: true } });
        if (!file) throw new HttpError(404, 'SOURCE_NOT_FOUND', 'File was not found in the current repository inventory.');
        const chunks = req.query.chunkId
          ? [await prisma.codeChunk.findFirst({ where: { id: req.query.chunkId, repositoryId: req.params.repositoryId, parsingJobId: analysis.parsingJob.id, fileId: file.id },
            select: { id: true, relativePath: true, language: true, structureType: true, symbolName: true, startLine: true, endLine: true, source: true } })].filter(Boolean)
          : await prisma.codeChunk.findMany({ where: { repositoryId: req.params.repositoryId, parsingJobId: analysis.parsingJob.id, fileId: file.id,
          ...(req.query.symbolName ? { symbolName: req.query.symbolName } : {}),
          ...(startLine || endLine ? { startLine: { lte: endLine ?? 100000 }, endLine: { gte: startLine ?? 1 } } : {}) },
          orderBy: { startLine: 'asc' }, take: 200, select: { id: true, relativePath: true, language: true, structureType: true, symbolName: true, startLine: true, endLine: true, source: true } });
        if (!chunks.length) throw new HttpError(404, 'SOURCE_NOT_FOUND', 'No parsed source chunks matched this file and range.');
        res.json({ repositoryId: req.params.repositoryId, filePath, contentScope: 'parsed_chunks', chunks,
          metadata: { parsingJobId: analysis.parsingJob.id, isCompleteFile: false, note: 'Only AST chunks are retained by the backend; unparsed source lines are not available.' } });
      } catch (error) { next(error); }
    }
  };
}
