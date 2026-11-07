import { createHash } from 'node:crypto';

const FILE_LIMIT = 1000;
const CHUNK_LIMIT = 5000;
const extensions = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.py'];

function stableId(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function fileNodeId(filePath) { return `file-${stableId(filePath)}`; }
function basenameForPath(filePath) { return filePath.split('/').filter(Boolean).at(-1) || filePath; }
function humanList(items, conjunction = 'and') {
  if (items.length < 2) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, ${conjunction} ${items.at(-1)}`;
}
function chunkNodeId(chunk) {
  return `symbol-${stableId(`${chunk.relativePath}:${chunk.structureType}:${chunk.symbolName ?? ''}:${chunk.startLine}:${chunk.endLine}`)}`;
}

function moduleForPath(filePath, depth = 2) {
  const directories = filePath.split('/').slice(0, -1);
  if (directories.length <= 1) return directories.join('/') || '.';
  return directories.slice(0, depth).join('/');
}

function buildModules(files, chunks, edges) {
  let depth = 2;
  let paths = files.map((file) => moduleForPath(file.relativePath, depth));
  if (new Set(paths).size > 24) {
    depth = 1;
    paths = files.map((file) => moduleForPath(file.relativePath, depth));
  }
  const collapseModules = new Set(paths).size > 24;
  const modules = new Map();
  const moduleByFile = new Map();
  for (const file of files) {
    const path = collapseModules ? '.' : moduleForPath(file.relativePath, depth);
    if (!modules.has(path)) modules.set(path, { id: `module-${stableId(path)}`, path, name: path === '.' ? 'Root files' : path.split('/').at(-1),
      fileCount: 0, symbolCount: 0, filePaths: [], fileNodeIds: [], dependencies: new Map() });
    const module = modules.get(path);
    module.fileCount += 1;
    module.symbolCount += chunks.filter((chunk) => chunk.relativePath === file.relativePath).length;
    module.filePaths.push(file.relativePath);
    module.fileNodeIds.push(fileNodeId(file.relativePath));
    moduleByFile.set(file.relativePath, path);
  }
  for (const edge of edges.filter((item) => item.type === 'IMPORTS')) {
    const sourceFile = files.find((file) => fileNodeId(file.relativePath) === edge.source);
    const targetFile = files.find((file) => fileNodeId(file.relativePath) === edge.target);
    if (!sourceFile || !targetFile) continue;
    const sourceModule = modules.get(moduleByFile.get(sourceFile.relativePath));
    const targetPath = moduleByFile.get(targetFile.relativePath);
    if (sourceModule && targetPath !== sourceModule.path) sourceModule.dependencies.set(targetPath, (sourceModule.dependencies.get(targetPath) ?? 0) + 1);
  }
  return [...modules.values()].sort((a, b) => a.path.localeCompare(b.path)).map((module) => ({ ...module,
    dependencies: [...module.dependencies.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, importCount]) => ({ moduleId: modules.get(path).id, modulePath: path, importCount })) }));
}

function resolveImport(importer, moduleName, filePaths) {
  if (!moduleName) return null;
  let base;
  if (moduleName.startsWith('.')) {
    const parts = importer.split('/');
    parts.pop();
    for (const part of moduleName.split('/')) {
      if (part === '.' || !part) continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    base = parts.join('/');
  } else if (/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(moduleName)) {
    base = moduleName.replaceAll('.', '/');
  } else return null;
  const candidates = [base, ...extensions.map((extension) => `${base}${extension}`), ...extensions.map((extension) => `${base}/index${extension}`), `${base}/__init__.py`];
  const matches = candidates.filter((candidate) => filePaths.has(candidate));
  return matches.length === 1 ? matches[0] : null;
}

export function buildCodeGraph({ repositoryId, indexingJobId, parsingJob, files, chunks, truncated = false }) {
  const nodes = [];
  const edges = [];
  const filePaths = new Set(files.map((file) => file.relativePath));
  const nodeIdsByChunk = new Map();
  const edgeKeys = new Set();
  const edge = (source, target, type, evidence) => {
    const key = `${source}:${target}:${type}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ id: `edge-${stableId(key)}`, source, target, type, certainty: 'high', isInferred: false, evidence });
  };

  for (const file of files) {
    const id = fileNodeId(file.relativePath);
    nodes.push({ id, type: 'file', name: file.relativePath.split('/').at(-1), filePath: file.relativePath,
      language: chunks.find((chunk) => chunk.relativePath === file.relativePath)?.language ?? null, extension: file.extension ?? null, category: file.category ?? null });
  }
  for (const chunk of chunks) {
    const id = chunkNodeId(chunk);
    nodeIdsByChunk.set(chunk, id);
    nodes.push({ id, type: chunk.structureType, name: chunk.symbolName || (chunk.structureType === 'import' ? chunk.metadata?.moduleName || 'import' : chunk.structureType),
      filePath: chunk.relativePath, language: chunk.language, symbolName: chunk.symbolName, startLine: chunk.startLine, endLine: chunk.endLine,
      metadata: chunk.structureType === 'import' ? { moduleName: chunk.metadata?.moduleName ?? null, importedIdentifiers: chunk.metadata?.importedIdentifiers ?? [] } : {} });
  }

  for (const file of files) {
    const contained = chunks.filter((chunk) => chunk.relativePath === file.relativePath).sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
    for (const chunk of contained) {
      const parent = contained.filter((candidate) => candidate !== chunk && candidate.startLine <= chunk.startLine && candidate.endLine >= chunk.endLine &&
        (candidate.startLine < chunk.startLine || candidate.endLine > chunk.endLine))
        .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
      edge(parent ? nodeIdsByChunk.get(parent) : fileNodeId(file.relativePath), nodeIdsByChunk.get(chunk), 'CONTAINS',
        { filePath: chunk.relativePath, startLine: chunk.startLine, endLine: chunk.endLine });
      const literalRequires = typeof chunk.source === 'string' ? [...chunk.source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]) : [];
      const importNames = [...new Set([...(chunk.structureType === 'import' ? [chunk.metadata?.moduleName].filter(Boolean) : chunk.metadata?.moduleNames ?? []), ...literalRequires])];
      for (const moduleName of importNames) {
        const targetPath = resolveImport(chunk.relativePath, moduleName, filePaths);
        if (targetPath && targetPath !== chunk.relativePath) {
          edge(fileNodeId(chunk.relativePath), fileNodeId(targetPath), 'IMPORTS', { filePath: chunk.relativePath, startLine: chunk.startLine, endLine: chunk.endLine, moduleName, importKind: chunk.metadata?.importKind ?? 'module-import' });
        }
      }
    }
  }
  const modules = buildModules(files, chunks, edges);
  return { repositoryId, status: 'ready', nodes, edges, metadata: { indexingJobId, parsingJobId: parsingJob.id, modules,
    totalNodes: nodes.length, totalEdges: edges.length, hasUncertainRelationships: false, isComplete: !truncated && parsingJob.status === 'completed',
    truncated, parseStatus: parsingJob.status, unsupportedRelationships: ['CALLS', 'EXPORTS', 'EXTENDS', 'IMPLEMENTS'] } };
}

export function buildReadingGuide({ repositoryId, files, chunks, graph, limit = 30 }) {
  const entries = [];
  const add = (file, chunk, reason, certainty, isInferred) => {
    const key = `${file.relativePath}:${chunk?.symbolName ?? ''}:${chunk?.startLine ?? ''}`;
    if (entries.some((item) => item.key === key)) return;
    entries.push({ key, filePath: file.relativePath, symbolName: chunk?.symbolName ?? null, startLine: chunk?.startLine ?? null,
      endLine: chunk?.endLine ?? null, reason, certainty, isInferred,
      graphNodeId: chunk ? chunkNodeId(chunk) : fileNodeId(file.relativePath) });
  };
  const entryPattern = /(^|\/)(index|main|server|app|__main__)(\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|py))$/i;
  const conventionalEntryFiles = [];
  for (const file of files) {
    if (!entryPattern.test(file.relativePath)) continue;
    conventionalEntryFiles.push(file.relativePath);
    const chunk = chunks.find((item) => item.relativePath === file.relativePath && item.structureType === 'function');
    add(file, chunk, 'The filename matches a conventional application entry name; confirm it against the repository start command.', 'medium', true);
  }
  const inbound = new Map();
  for (const edge of graph.edges.filter((item) => item.type === 'IMPORTS')) inbound.set(edge.target, (inbound.get(edge.target) ?? 0) + 1);
  const imported = files.map((file) => ({ file, count: inbound.get(fileNodeId(file.relativePath)) ?? 0 }))
    .filter((item) => item.count > 0).sort((a, b) => b.count - a.count || a.file.relativePath.localeCompare(b.file.relativePath));
  for (const item of imported) {
    const chunk = chunks.find((value) => value.relativePath === item.file.relativePath && ['class', 'function'].includes(value.structureType));
    add(item.file, chunk, `Directly imported by ${item.count} analyzed file${item.count === 1 ? '' : 's'}.`, 'high', false);
  }
  if (!entries.length && !imported.length) {
    for (const file of files) {
      const chunk = chunks.find((item) => item.relativePath === file.relativePath && ['class', 'function'].includes(item.structureType));
      if (chunk) add(file, chunk, 'Fallback: this is a parsed file with a class or function; no conventional entry name or local import relationships were found.', 'low', true);
    }
  }
  const stageFile = (file, chunk = chunks.find((item) => item.relativePath === file.relativePath)) => ({ filePath: file.relativePath,
    graphNodeId: chunk ? chunkNodeId(chunk) : fileNodeId(file.relativePath), symbolName: chunk?.symbolName ?? null,
    startLine: chunk?.startLine ?? null, endLine: chunk?.endLine ?? null,
    language: chunk?.language ?? null, structureType: chunk?.structureType ?? null, sourceAvailable: chunks.some((item) => item.relativePath === file.relativePath) });
  const item = (title, explanation, why, fileRows, options = {}) => ({ title, explanation, why,
    files: fileRows.map((file) => stageFile(file, options.chunkForFile?.(file))),
    symbols: fileRows.flatMap((file) => chunks.filter((chunk) => chunk.relativePath === file.relativePath && chunk.symbolName)
      .slice(0, 3).map((chunk) => stageFile(file, chunk))),
    relationships: options.relationships ?? [], relatedGraphNodeIds: options.relatedGraphNodeIds ?? [],
    relatedGraphNodes: (options.relatedGraphNodeIds ?? []).map((id) => graph.nodes.find((node) => node.id === id) ||
      (graph.metadata.modules ?? []).find((module) => module.id === id)).filter(Boolean).map((node) => ({ id: node.id,
      name: node.name || node.symbolName || node.path, type: node.type || 'module', filePath: node.filePath || null })),
    prerequisites: options.prerequisites ?? [], expectedOutcome: options.expectedOutcome,
    certainty: options.certainty ?? 'high', evidenceType: options.evidenceType ?? 'static-analysis' });
  const stages = [];
  const addStage = (id, title, summary, recommendations, expectedOutcome, options = {}) => stages.push({ id, order: stages.length + 1,
    title, summary, expectedOutcome, prerequisites: options.prerequisites ?? [], recommendations,
    certainty: options.certainty ?? 'high', evidenceType: options.evidenceType ?? 'static-analysis' });

  const modules = graph.metadata.modules ?? [];
  const moduleRecommendations = modules.map((module) => {
    const moduleFiles = files.filter((file) => module.filePaths.includes(file.relativePath));
    const dependencies = module.dependencies.map((dependency) => dependency.modulePath);
    return item(module.name, `This directory group contains ${module.fileCount} indexed files and ${module.symbolCount} parsed code chunks.`,
      'Directory membership is directly visible in the indexed paths; names alone do not establish runtime responsibilities.', moduleFiles.slice(0, 5),
      { relatedGraphNodeIds: module.fileNodeIds, relationships: dependencies.map((path) => ({ type: 'IMPORTS', modulePath: path, certainty: 'high' })),
        expectedOutcome: `Recognize the files grouped under ${module.path} and how this group directly imports other indexed groups.`, certainty: 'high' });
  });
  addStage('repository-map', 'Understand the repository layout', 'Start with directory groups and the analysis coverage before drawing conclusions about architecture.', moduleRecommendations,
    'Identify the main path groups, supported languages, and what the current parse did and did not analyze.');

  const entryRecommendations = entries.slice(0, limit).map((entry) => {
    const file = files.find((candidate) => candidate.relativePath === entry.filePath);
    return item(entry.symbolName || entry.filePath.split('/').at(-1), entry.reason,
      'Inspect the parsed initialization code and confirm the filename heuristic against the actual run command.', file ? [file] : [],
      { chunkForFile: (candidate) => chunks.find((chunk) => chunk.relativePath === candidate.relativePath && chunk.symbolName === entry.symbolName) ?? chunks.find((chunk) => chunk.relativePath === candidate.relativePath),
        relatedGraphNodeIds: [entry.graphNodeId], prerequisites: ['Repository layout'], expectedOutcome: 'Understand what the candidate startup file initializes, based on its source.', certainty: entry.certainty,
        evidenceType: entry.isInferred ? 'filename-heuristic' : 'static-analysis' });
  });
  addStage('initialization', 'Understand application initialization', 'Inspect files whose names or direct parse evidence suggest a startup role. Verify the runtime command in project configuration.', entryRecommendations,
    'Find the actual startup path or learn that this analysis cannot establish one.', { certainty: entryRecommendations.some((value) => value.certainty !== 'high') ? 'medium' : 'high', evidenceType: 'mixed' });

  const flowPattern = /(^|\/)(routes?|controllers?|middleware|services?|pages?|components?|api|handlers?|views?)(\/|$)/i;
  const flowFiles = files.filter((file) => flowPattern.test(file.relativePath)).slice(0, 16);
  const flowRecommendations = flowFiles.map((file) => {
    const outgoing = graph.edges.filter((edge) => edge.type === 'IMPORTS' && edge.source === fileNodeId(file.relativePath));
    const incoming = graph.edges.filter((edge) => edge.type === 'IMPORTS' && edge.target === fileNodeId(file.relativePath));
    return item(file.relativePath, `The path contains a structural segment such as routes, controllers, services, pages, or components.`,
      'Use the file source and direct import edges to trace connections; directory names are clues, not proof of request execution.', [file],
      { relationships: [...incoming, ...outgoing].map((edge) => ({ type: edge.type, source: edge.source, target: edge.target, evidence: edge.evidence })),
        relatedGraphNodeIds: [...new Set([...incoming.map((edge) => edge.source), ...outgoing.map((edge) => edge.target)])],
        prerequisites: ['Repository layout', 'Application initialization'], expectedOutcome: 'Trace only the imports and code that are present in the parsed source.', certainty: 'medium', evidenceType: 'path-structure-plus-imports' });
  });
  addStage('application-flow', 'Trace the application flow', 'Use directory clues and parser-backed imports to inspect likely route, handler, service, page, and component boundaries where present.', flowRecommendations,
    'Understand which source files are connected by direct imports, without treating that as a proven runtime call sequence.', { certainty: 'medium', evidenceType: 'path-structure-plus-imports', prerequisites: ['Application initialization'] });

  const coreRecommendations = imported.slice(0, limit).map(({ file, count }) => {
    const chunk = chunks.find((value) => value.relativePath === file.relativePath && ['class', 'function'].includes(value.structureType));
    return item(chunk?.symbolName || file.relativePath, `Directly imported by ${count} analyzed file${count === 1 ? '' : 's'}.`,
      'Inspect this module and its importers to see which parsed code structures are reused.', [file],
      { chunkForFile: () => chunk, relatedGraphNodeIds: [fileNodeId(file.relativePath), ...graph.edges.filter((edge) => edge.type === 'IMPORTS' && edge.target === fileNodeId(file.relativePath)).map((edge) => edge.source)],
        relationships: [{ type: 'IMPORTS', incomingFileCount: count }], prerequisites: ['Repository layout'], expectedOutcome: `Understand the parsed structures in this file and its ${count} direct importer${count === 1 ? '' : 's'}.` });
  });
  addStage('core-functionality', 'Inspect shared code structures', 'Review files that other indexed files import directly.', coreRecommendations,
    'Recognize the symbols and direct import relationships with the most incoming references.');

  const dataPattern = /(^|\/)(schema|schemas|models?|database|db|persistence|repositories)(\/|\.|$)/i;
  const dataFiles = files.filter((file) => dataPattern.test(file.relativePath) && chunks.some((chunk) => chunk.relativePath === file.relativePath)).slice(0, 12);
  const dataRecommendations = dataFiles.map((file) => item(file.relativePath,
    'The path or filename matches a common data/schema naming pattern; inspect the contents to confirm what it defines.',
    'Names are heuristic evidence only. This parser may not extract schema definitions or database relationships.', [file],
    { prerequisites: ['Repository layout'], expectedOutcome: 'Determine from the source whether this file actually defines or accesses persisted data.', certainty: 'medium', evidenceType: 'filename-heuristic' }));
  addStage('data-architecture', 'Inspect data and persistence clues', 'Review files with schema, model, database, or persistence path names when such files exist.', dataRecommendations,
    dataRecommendations.length ? 'Confirm which files define or access data by reading their source.' : 'The indexed paths contain no matching parsed data or persistence filenames.',
    { certainty: dataRecommendations.length ? 'medium' : 'unknown', evidenceType: 'filename-heuristic' });

  const dependencyRecommendations = modules.filter((module) => module.dependencies.length).sort((a, b) =>
    b.dependencies.reduce((sum, edge) => sum + edge.importCount, 0) - a.dependencies.reduce((sum, edge) => sum + edge.importCount, 0) || a.path.localeCompare(b.path)).slice(0, 12)
    .map((module) => item(module.path, `This directory group has ${module.dependencies.reduce((sum, edge) => sum + edge.importCount, 0)} direct imports into other indexed groups.`,
      'The links represent resolved source imports, not function calls or runtime execution order.', files.filter((file) => module.filePaths.includes(file.relativePath)).slice(0, 4),
      { relationships: module.dependencies.map((dependency) => ({ type: 'IMPORTS', modulePath: dependency.modulePath, importCount: dependency.importCount, certainty: 'high' })),
        relatedGraphNodeIds: module.fileNodeIds, prerequisites: ['Repository layout'], expectedOutcome: 'Identify the directly imported module groups and follow those source links in the graph.' }));
  addStage('dependencies', 'Explore important module dependencies', 'Follow direct, unambiguously resolved imports between directory groups.', dependencyRecommendations,
    'Understand which module groups have direct import links to other groups.');

  const alreadyRecommended = new Set([...entries.map((entry) => entry.filePath), ...flowFiles.map((file) => file.relativePath), ...dataFiles.map((file) => file.relativePath)]);
  const nextFiles = files.filter((file) => chunks.some((chunk) => chunk.relativePath === file.relativePath) && !alreadyRecommended.has(file.relativePath))
    .map((file) => ({ file, count: chunks.filter((chunk) => chunk.relativePath === file.relativePath).length }))
    .sort((a, b) => b.count - a.count || a.file.relativePath.localeCompare(b.file.relativePath)).slice(0, 12);
  const nextRecommendations = nextFiles.map(({ file, count }) => item(file.relativePath,
    `The parser extracted ${count} code chunk${count === 1 ? '' : 's'} from this file.`,
    'Use this as a next exploration target after the stronger entry, path, and import signals above.', [file],
    { prerequisites: ['Repository layout'], expectedOutcome: 'Inspect additional parsed functions, classes, imports, or variables not already emphasized in earlier steps.', certainty: 'low', evidenceType: 'coverage-based' }));
  addStage('next-exploration', 'Choose what to explore next', 'Continue into other parsed files with code structures after following the stronger repository signals.', nextRecommendations,
    nextRecommendations.length ? 'Build familiarity with the remaining parsed code.' : 'No additional parsed files remain outside the earlier suggestions.', { certainty: 'low', evidenceType: 'coverage-based' });

  const parsedPaths = new Set(chunks.map((chunk) => chunk.relativePath));
  const languages = [...new Set(chunks.map((chunk) => chunk.language).filter(Boolean))].sort();
  const directories = modules.map((module) => ({ id: module.id, path: module.path, name: module.name,
    fileCount: module.fileCount, parsedFileCount: module.filePaths.filter((path) => parsedPaths.has(path)).length,
    categories: [...new Set(files.filter((file) => module.filePaths.includes(file.relativePath)).map((file) => file.category).filter(Boolean))].sort(),
    entryPoints: entries.filter((entry) => module.filePaths.includes(entry.filePath)).map((entry) => ({ filePath: entry.filePath, evidenceType: entry.isInferred ? 'filename-heuristic' : 'static-analysis', certainty: entry.certainty })),
    filePaths: module.filePaths, dependencies: module.dependencies.map((dependency) => ({ ...dependency, relationship: 'direct-import', certainty: 'high' })),
    explanation: `This indexed path group contains ${module.fileCount} files${module.symbolCount ? ` and ${module.symbolCount} parsed code structures` : ''}. Its name is a path clue; source behavior should be confirmed by opening the files.`,
    evidenceType: 'path-grouping', certainty: 'high' })).sort((a, b) => b.parsedFileCount - a.parsedFileCount || b.fileCount - a.fileCount || a.path.localeCompare(b.path));
  for (const stage of stages) {
    const paths = new Set(stage.recommendations.flatMap((recommendation) => recommendation.files.map((file) => file.filePath)));
    const flowEdges = graph.edges.filter((edge) => edge.type === 'IMPORTS' && paths.has(graph.nodes.find((node) => node.id === edge.source)?.filePath) && paths.has(graph.nodes.find((node) => node.id === edge.target)?.filePath));
    const flowNodeIds = new Set(flowEdges.flatMap((edge) => [edge.source, edge.target]));
    stage.narrative = stage.recommendations.length
      ? `${stage.summary} The files below are selected from this repository's current indexed and parsed snapshot.`
      : `${stage.summary} The current analysis did not find matching files, so this chapter cannot make a file-specific claim.`;
    stage.learningObjective = stage.expectedOutcome;
    stage.flow = { nodes: graph.nodes.filter((node) => flowNodeIds.has(node.id) && node.type === 'file').map((node) => ({ id: node.id, label: node.name, filePath: node.filePath, current: false })),
      edges: flowEdges.map((edge) => ({ source: edge.source, target: edge.target, label: 'imports', certainty: 'high', evidenceType: 'static-analysis' })),
      limitation: 'Arrows show resolved source imports only; they do not establish runtime order or function calls.' };
    stage.followFlow = flowEdges.length ? 'Follow a resolved import to inspect the connected file.' : 'No direct import path between this chapter’s selected files was established.';
  }
  const architectureAreas = directories.filter((directory) => directory.dependencies.length || directory.parsedFileCount)
    .slice(0, 8).map(({ path, fileCount, parsedFileCount, dependencies }) => ({ path, fileCount, parsedFileCount,
      directImportGroups: dependencies.map((dependency) => dependency.modulePath), evidenceType: 'path-grouping-and-imports' }));
  const roleFor = (filePath) => {
    const path = filePath.toLowerCase();
    if (/(^|\/)(routes?|handlers?)(\/|\.|$)/.test(path)) return { role: 'Request entry points', kind: 'route', evidenceType: 'path-heuristic', certainty: 'medium' };
    if (/(^|\/)(controllers?)(\/|\.|$)/.test(path)) return { role: 'Request handling code', kind: 'controller', evidenceType: 'path-heuristic', certainty: 'medium' };
    if (/(^|\/)(services?|utils?)(\/|\.|$)/.test(path)) return { role: 'Shared application logic', kind: 'service', evidenceType: 'path-heuristic', certainty: 'medium' };
    if (/(^|\/)(models?|schemas?|database|db|repositories)(\/|\.|$)/.test(path)) return { role: 'Data definitions or database access', kind: 'data', evidenceType: 'path-heuristic', certainty: 'medium' };
    if (/(^|\/)(components?|pages?|views?)(\/|\.|$)/.test(path)) return { role: 'Screen or interface code', kind: 'ui', evidenceType: 'path-heuristic', certainty: 'medium' };
    if (/(^|\/)(tests?|__tests__)(\/|\.|$)/.test(path)) return { role: 'Checks for the application', kind: 'test', evidenceType: 'path-heuristic', certainty: 'medium' };
    if (/(^|\/)(frontend|client|web|ui)(\/|$)/.test(path)) return { role: 'Browser-facing application code', kind: 'frontend', evidenceType: 'path-heuristic', certainty: 'medium' };
    if (/(^|\/)(backend|server|api)(\/|$)/.test(path)) return { role: 'Server-side application code', kind: 'backend', evidenceType: 'path-heuristic', certainty: 'medium' };
    return { role: 'Application source code', kind: 'source', evidenceType: 'static-analysis', certainty: 'high' };
  };
  const sourceRef = (filePath, why) => {
    const fileChunks = chunks.filter((chunk) => chunk.relativePath === filePath).sort((a, b) => a.startLine - b.startLine);
    const symbol = fileChunks.find((chunk) => ['function', 'class', 'variable'].includes(chunk.structureType));
    const role = roleFor(filePath);
    return { filePath, symbolName: symbol?.symbolName ?? null, startLine: symbol?.startLine ?? null, endLine: symbol?.endLine ?? null,
      graphNodeId: symbol ? chunkNodeId(symbol) : fileNodeId(filePath), why, role: role.role, evidenceType: role.evidenceType, certainty: role.certainty,
      sourceAvailable: Boolean(fileChunks.length) };
  };
  const sourceRefForChunk = (chunk, why) => ({ ...sourceRef(chunk.relativePath, why), symbolName: chunk.symbolName ?? null,
    startLine: chunk.startLine, endLine: chunk.endLine, graphNodeId: chunkNodeId(chunk), sourceAvailable: true });
  const relationEdges = graph.edges.filter((edge) => edge.type === 'IMPORTS');
  const pathOf = (id) => graph.nodes.find((node) => node.id === id)?.filePath;
  const topEntryFiles = conventionalEntryFiles.slice(0, 8);
  const importantFlowFiles = files.filter((file) => /(^|\/)(routes?|handlers?|controllers?|services?|components?|pages?|api|models?|schemas?|database|db)(\/|\.|$)/i.test(file.relativePath))
    .map((file) => file.relativePath);
  const focusPaths = new Set([...topEntryFiles, ...importantFlowFiles]);
  let frontier = new Set(topEntryFiles);
  for (let depth = 0; depth < 3; depth += 1) {
    const next = new Set();
    for (const edge of relationEdges) {
      const sourcePath = pathOf(edge.source); const targetPath = pathOf(edge.target);
      if (frontier.has(sourcePath) && targetPath && !focusPaths.has(targetPath) && focusPaths.size < 36) next.add(targetPath);
    }
    for (const filePath of next) focusPaths.add(filePath);
    frontier = next;
  }
  const relationshipPriority = (edge) => {
    const sourceRole = roleFor(pathOf(edge.source)).kind;
    const targetRole = roleFor(pathOf(edge.target)).kind;
    if (sourceRole === 'route' && targetRole === 'controller') return 0;
    if (sourceRole === 'controller' && ['data', 'service'].includes(targetRole)) return 1;
    if (topEntryFiles.includes(pathOf(edge.source))) return 2;
    if (sourceRole === 'frontend' || sourceRole === 'ui') return 3;
    return 4;
  };
  const focusEdges = relationEdges.filter((edge) => focusPaths.has(pathOf(edge.source)) && focusPaths.has(pathOf(edge.target)))
    .sort((a, b) => relationshipPriority(a) - relationshipPriority(b) || `${pathOf(a.source)}:${pathOf(a.target)}`.localeCompare(`${pathOf(b.source)}:${pathOf(b.target)}`)).slice(0, 40);
  const sourceChunks = chunks.filter((chunk) => typeof chunk.source === 'string' && chunk.source.length);
  const dataPaths = files.filter((file) => /(^|\/)(models?|schemas?|database|db|repositories)(\/|\.|$)/i.test(file.relativePath) || /(^|\/)(database|schema|model|repository)[^/]*\.(js|jsx|ts|tsx|py)$/i.test(file.relativePath))
    .filter((file) => parsedPaths.has(file.relativePath)).slice(0, 12).map((file) => file.relativePath);
  const indexedFilePaths = new Set(files.map((file) => file.relativePath));
  const integrationPaths = chunks.flatMap((chunk) => {
    const literalRequires = typeof chunk.source === 'string' ? [...chunk.source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]) : [];
    const moduleNames = [...new Set([...(chunk.structureType === 'import' ? [chunk.metadata?.moduleName] : chunk.metadata?.importKind === 'commonjs-require' ? chunk.metadata.moduleNames : []), ...literalRequires])];
    return moduleNames.filter((moduleName) => moduleName && !moduleName.startsWith('.') && !resolveImport(chunk.relativePath, moduleName, indexedFilePaths) &&
      !/(^|\/)(configs?|tests?|__tests__|scripts?)(\/|$)|\.config\.[^/]+$/i.test(chunk.relativePath))
      .map((moduleName) => ({ filePath: chunk.relativePath, moduleName, startLine: chunk.startLine, endLine: chunk.endLine }));
  });
  const frameworkByPackage = new Map([['react', 'React'], ['react-dom', 'React'], ['express', 'Express'], ['fastify', 'Fastify'], ['koa', 'Koa'], ['vue', 'Vue'], ['@angular/core', 'Angular'], ['next', 'Next.js'], ['django', 'Django'], ['flask', 'Flask'], ['fastapi', 'FastAPI']]);
  const frameworks = [...new Set(integrationPaths.map((item) => frameworkByPackage.get(item.moduleName)).filter(Boolean))].sort();
  const hasAuthStory = sourceChunks.some((chunk) => /\/api\/auth\/(?:login|register)/i.test(chunk.source) && /axios\.(?:post|get)|fetch\s*\(/i.test(chunk.source));
  const hasPaymentStory = sourceChunks.some((chunk) => /\/api\/payment\//i.test(chunk.source) && /axios\.post\s*\(/i.test(chunk.source)) && sourceChunks.some((chunk) => /Order\.create\s*\(/i.test(chunk.source) && /axios\.post\s*\(/i.test(chunk.source));
  const hasTransactionStory = sourceChunks.some((chunk) => /\/api\/transactions\//i.test(chunk.source) && /axios\.get\s*\(/i.test(chunk.source));
  const dataEvidence = dataPaths.map((filePath) => {
    const text = chunks.filter((chunk) => chunk.relativePath === filePath).map((chunk) => chunk.source).join('\n');
    const signals = [];
    if (/mongoose\.Schema|new\s+Schema\s*\(/i.test(text)) signals.push('parsed source contains a schema declaration');
    if (/mongoose\.connect\s*\(/i.test(text)) signals.push('parsed source contains a database connection call');
    if (/\.find(?:One|ById)?\s*\(|\.create\s*\(|\.save\s*\(/i.test(text)) signals.push('parsed source contains a data read or write method');
    return { filePath, signals, evidenceType: signals.length ? 'parsed-source-pattern' : 'path-heuristic', certainty: signals.length ? 'medium' : 'low' };
  });
  const dataOperationEvidence = [...new Map(chunks.filter((chunk) => /\b(?:mongoose\.connect|\.find(?:One|ById)?|\.create|\.save|\.update(?:One|Many)?|\.deleteOne)\s*\(/i.test(chunk.source))
    .map((chunk) => [chunk.relativePath, { filePath: chunk.relativePath, startLine: chunk.startLine, endLine: chunk.endLine,
      signal: chunk.source.match(/\b(?:mongoose\.connect|\.find(?:One|ById)?|\.create|\.save|\.update(?:One|Many)?|\.deleteOne)\s*\(/i)?.[0]?.trim() || 'data operation pattern', evidenceType: 'parsed-source-pattern' }])).values()];
  const storyChapters = [];
  const chapter = (id, title, paragraphs, refs = [], options = {}) => {
    if (!paragraphs.length && !refs.length) return;
    storyChapters.push({ id, order: storyChapters.length + 1, title, paragraphs, files: refs,
      relationships: options.relationships ?? [], diagram: options.diagram ?? { nodes: [], edges: [] }, details: options.details ?? [],
      evidenceType: options.evidenceType ?? 'static-analysis', certainty: options.certainty ?? 'high' });
  };
  const topDirectories = directories.slice(0, 8);
  const areas = topDirectories.map((item) => item.path).filter((name) => name !== '.');
  const hasFrontendPaths = files.some((file) => /(^|\/)(frontend|client|web|ui)(\/|$)/i.test(file.relativePath));
  const hasBackendPaths = files.some((file) => /(^|\/)(backend|server|api)(\/|$)/i.test(file.relativePath));
  const applicationParts = [hasFrontendPaths && 'browser-facing part', hasBackendPaths && 'server-side part'].filter(Boolean);
  const languageLabels = languages.map((language) => ({ javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python' }[language] || language));
  const technologyDescriptions = frameworks.map((name) => name === 'React' ? 'React for the screens people use in the browser' : name === 'Express' ? 'Express for handling requests on the server' : `${name} for building application features`);
  const activities = [hasAuthStory && 'signing in or registering', hasPaymentStory && 'creating payment links', hasTransactionStory && 'checking transactions'].filter(Boolean);
  const purposeText = activities.length
    ? `From the code we could read, this application appears to let people ${humanList(activities)}.`
    : 'We can identify parts of the application, but we have not found enough source to confidently describe what people can do with it yet.';
  const overviewText = `Let's start with the shape of the project. ${purposeText} We could read ${parsedPaths.size} of its ${files.length} files${languageLabels.length ? `, and the code we could read is written in ${humanList(languageLabels)}` : ''}. ${technologyDescriptions.length ? `It uses ${humanList(technologyDescriptions)}.` : 'The available files do not yet give us a reliable picture of its main technology.'} ${applicationParts.length ? `Its folders include areas that look like ${humanList(applicationParts.map((part) => `a ${part}`))}.` : 'We have not yet confirmed whether it has separate browser and server parts.'} ${areas.length ? `As we continue, we'll look at ${humanList(areas)}.` : 'Next, we will look for the files that help us understand how it starts.'} The links in this guide open the code, so you can check each explanation as we go.`;
  chapter('overview', 'What are we looking at?', [overviewText], [], { details: topDirectories.map((item) => ({ label: item.path, text: `${item.fileCount} indexed files, ${item.parsedFileCount} parsed`, evidenceType: 'path-grouping' })) });
  if (topEntryFiles.length) {
    const entryRefs = topEntryFiles.map((filePath) => sourceRef(filePath, 'Its name makes it a useful place to look for the application startup code.'));
    const frontendEntries = topEntryFiles.filter((filePath) => /(^|\/)(frontend|client|web|ui)(\/|$)/i.test(filePath));
    const backendEntries = topEntryFiles.filter((filePath) => /(^|\/)(backend|server|api)(\/|$)/i.test(filePath));
    const candidateEdges = relationEdges.filter((edge) => topEntryFiles.includes(pathOf(edge.source)) || topEntryFiles.includes(pathOf(edge.target)));
    const importsApp = candidateEdges.find((edge) => /(^|\/)(main|index)\./i.test(pathOf(edge.source) || '') && /(^|\/)(app)\./i.test(pathOf(edge.target) || ''));
    const importsDatabase = candidateEdges.find((edge) => /(^|\/)(app|server)\./i.test(pathOf(edge.source) || '') && /(^|\/)(db|database)\./i.test(pathOf(edge.target) || ''));
    const intro = `Every application has a place where it gets going. Here are the best starting-point candidates we found${frontendEntries.length ? ` for the browser: ${frontendEntries.join(', ')}` : ''}${backendEntries.length ? `${frontendEntries.length ? ';' : ''} for the server: ${backendEntries.join(', ')}` : ''}. Their names and links make them good places to begin, but we have not checked the launch command, so treat them as candidates until you inspect the project setup.`;
    const edges = relationEdges.filter((edge) => topEntryFiles.includes(pathOf(edge.source)) || topEntryFiles.includes(pathOf(edge.target))).slice(0, 20);
    const entryStory = [];
    if (importsApp) entryStory.push(`${pathOf(importsApp.source)} brings in ${pathOf(importsApp.target)}. This connects the browser's setup file to the main screen component.`);
    if (importsDatabase) entryStory.push(`${pathOf(importsDatabase.source)} brings in ${pathOf(importsDatabase.target)}, linking the server setup to the code that opens its database connection.`);
    chapter('beginning', 'Where does the application begin?', [intro,
      ...entryStory,
      ...(edges.length && !entryStory.length ? [`These files also bring in code from nearby project files. An import is one file saying, “I need something defined over there.” It helps us follow the project, though it does not tell us the exact order in which code runs.`] : []),
      ...(!edges.length ? ['We have not confirmed which other project files these starting-point candidates use.'] : [])], entryRefs,
      { relationships: edges.map((edge) => ({ sourcePath: pathOf(edge.source), targetPath: pathOf(edge.target), label: 'imports', certainty: 'high', evidenceType: 'static-analysis' })),
        diagram: { nodes: [...new Set(edges.flatMap((edge) => [pathOf(edge.source), pathOf(edge.target)]))].filter(Boolean).map((filePath) => ({ filePath, label: basenameForPath(filePath) })),
          edges: edges.map((edge) => ({ sourcePath: pathOf(edge.source), targetPath: pathOf(edge.target), label: 'imports', certainty: 'high' })) }, evidenceType: 'mixed', certainty: 'medium' });
  }
  if (topDirectories.length) {
    const dirRefs = topDirectories.flatMap((item) => item.filePaths.slice(0, 2).map((filePath) => sourceRef(filePath, `A useful example of the code kept in ${item.path}.`))).slice(0, 8);
    const dirParagraphs = topDirectories.slice(0, 6).map((item) => {
      const ownFiles = files.filter((file) => item.filePaths.includes(file.relativePath));
      const has = (pattern) => ownFiles.some((file) => pattern.test(file.relativePath));
      const roles = [];
      if (has(/(^|\/)(routes?|handlers?)(\/|\.|$)/i)) roles.push('request entry points');
      if (has(/(^|\/)(controllers?)(\/|\.|$)/i)) roles.push('request handling code');
      if (has(/(^|\/)(models?|schemas?)(\/|\.|$)/i)) roles.push('data definitions');
      if (has(/(^|\/)(components?|pages?|views?)(\/|\.|$)/i)) roles.push('screens and interface code');
      if (has(/(^|\/)(config|configs)(\/|$)/i)) roles.push('setup and connection settings');
      if (has(/(^|\/)(services?|utils?)(\/|\.|$)/i)) roles.push('shared helper code');
      const sample = ownFiles.slice(0, 2).map((file) => file.relativePath);
      const first = roles.length ? `${item.path} contains ${roles.join(' and ')}.` : `${item.path} keeps files such as ${sample.join(' and ')} together.`;
      const connection = item.dependencies.length
        ? ` Code here also uses code from ${item.dependencies.slice(0, 3).map((dependency) => dependency.modulePath).join(', ')}.`
        : ' We have not confirmed how this part connects to the others yet; opening the linked files is the best next step.';
      return `${first}${connection} This map gives you a good place to look when you want to understand ${roles.length ? roles[0] : 'this part of the project'}.`;
    });
    chapter('organization', 'How is the code organized?', dirParagraphs, dirRefs, { evidenceType: 'path-grouping-and-imports', certainty: 'medium' });
  }
  if (focusPaths.size) {
    const flowRefs = [...focusPaths].filter((filePath) => files.some((file) => file.relativePath === filePath)).slice(0, 12)
      .map((filePath) => sourceRef(filePath, `Included because its path matches a common application boundary and/or it participates in a resolved local import.`));
    const edgeStories = focusEdges.slice(0, 5).map((edge) => {
      const sourcePath = pathOf(edge.source); const targetPath = pathOf(edge.target);
      const sourceRole = roleFor(sourcePath).role.toLowerCase(); const targetRole = roleFor(targetPath).role.toLowerCase();
      return `${sourcePath} brings in code from ${targetPath}. Their folder names suggest this connects ${sourceRole} with ${targetRole}. That gives us a useful trail to follow; it does not by itself prove that one file calls the other.`;
    });
    const httpClientFiles = [...new Set(chunks.filter((chunk) => /\b(?:axios\.(?:get|post|put|patch|delete)|fetch\s*\()/i.test(chunk.source)).map((chunk) => chunk.relativePath))];
    const frontendBackendStory = hasFrontendPaths && hasBackendPaths
      ? httpClientFiles.length
        ? `The project has folders that look like both a frontend and a backend. We also found web-request code in ${httpClientFiles.slice(0, 4).join(', ')}. These requests are a common way for the browser and server to talk, but we have not matched a particular request to a particular server route yet.`
        : 'The project has folders that look like both a frontend and a backend, but we have not confirmed how a browser action reaches the server.'
      : '';
    const flowParagraphs = focusEdges.length
      ? [`Now let's follow a few trails through the code. When one file imports another, it means the first file uses something defined in the second. That helps us see which parts belong together, even though these links alone cannot show every step of a user's action.`, ...edgeStories, ...(frontendBackendStory ? [frontendBackendStory] : [])]
      : ['We have not yet found clear links between the main application files. Open the linked examples to see what each one does; the available code does not show a complete user journey yet.'];
    const authScreen = sourceChunks.find((chunk) => /(^|\/)(auth|login|signin|sign-in)\.(jsx?|tsx?)$/i.test(chunk.relativePath) && /axios\.(?:post|get)|fetch\s*\(/i.test(chunk.source) && /\/api\/auth\/(?:login|register)/i.test(chunk.source));
    const authController = sourceChunks.find((chunk) => /(^|\/)controllers?\/[^/]*auth/i.test(chunk.relativePath) && /User\.findOne\s*\(|bcrypt\.compare\s*\(/i.test(chunk.source));
    const registrationController = sourceChunks.find((chunk) => /(^|\/)controllers?\/[^/]*auth/i.test(chunk.relativePath) && /new\s+User\s*\(|newUser\.save\s*\(/i.test(chunk.source));
    const authRouteEdge = relationEdges.find((edge) => /(^|\/)routes?\/[^/]*auth/i.test(pathOf(edge.source) || '') && /(^|\/)controllers?\/[^/]*auth/i.test(pathOf(edge.target) || ''));
    const authJourneys = [];
    const authRefs = [];
    if (authScreen) {
      const authEndpoints = [...new Set([...authScreen.source.matchAll(/\/api\/auth\/[A-Za-z0-9_/-]+/g)].map((match) => match[0]))];
      authJourneys.push(`Let's look at signing in. In ${authScreen.relativePath}, the sign-in screen sends the entered details to ${authEndpoints.length ? humanList(authEndpoints, 'or') : 'the address shown in the code'}. After the request succeeds, the screen takes the person to the dashboard.`);
      authRefs.push(sourceRefForChunk(authScreen, 'This screen sends the sign-in or registration request and moves to the dashboard after success.'));
      if (authController) {
        authJourneys.push(`On the server side, ${authController.relativePath} looks up the user and compares the submitted password with the saved one. When the check succeeds, this code sets a sign-in cookie and returns user information. The authentication route imports this controller${authRouteEdge ? ', so we can confirm they are connected' : ''}; the saved code does not include the route registration line, so it does not show exactly which URL selects this handler.`);
        authRefs.push(sourceRefForChunk(authController, 'This server code looks up a user, checks the password, and responds after sign-in.'));
      }
      if (registrationController) {
        authJourneys.push(`The same screen also has a registration path. Its server code checks whether a user already exists, prepares a password hash, saves a new user, and then sets a sign-in cookie. The linked files show these steps, while the exact route-to-handler mapping is not present in the saved source.`);
        authRefs.push(sourceRefForChunk(registrationController, 'This server code checks for an existing user and saves a new account.'));
      }
    }
    const paymentScreen = sourceChunks.find((chunk) => /(^|\/)(createpayment|payment|checkout)[^/]*\.(jsx?|tsx?)$/i.test(chunk.relativePath) && /axios\.post\s*\(/i.test(chunk.source) && /\/api\/payment\//i.test(chunk.source));
    const paymentController = sourceChunks.find((chunk) => roleFor(chunk.relativePath).kind === 'controller' && /Order\.create\s*\(/i.test(chunk.source) && /axios\.post\s*\(/i.test(chunk.source));
    const paymentUrl = paymentController?.source.match(/https:\/\/[^/'"`\s]+/i)?.[0];
    let paymentHost = null;
    try { paymentHost = paymentUrl ? new URL(paymentUrl).hostname : null; } catch { paymentHost = null; }
    const paymentRouteEdge = relationEdges.find((edge) => roleFor(pathOf(edge.source)).kind === 'route' && pathOf(edge.target) === paymentController?.relativePath);
    const paymentRefs = [];
    if (paymentScreen && paymentController) {
      const paymentEndpoints = [...new Set([...paymentScreen.source.matchAll(/\/api\/payment\/[A-Za-z0-9_/-]+/g)].map((match) => match[0]))];
      flowParagraphs.push(`Here's a more complete journey: creating a payment. In ${paymentScreen.relativePath}, the person fills out payment details and the screen sends them to ${humanList(paymentEndpoints, 'or')}. When the server reports success, the screen displays the payment link it receives.`);
      flowParagraphs.push(`The server-side payment code in ${paymentController.relativePath} saves an order, sends a request${paymentHost ? ` to ${paymentHost}` : ' to the payment provider'}, records a pending status, and starts a status watcher before returning the payment link. The payment route imports this controller${paymentRouteEdge ? ', confirming they are connected' : ''}. The saved analysis does not include the route registration line, so it cannot confirm the exact URL-to-handler match.`);
      paymentRefs.push(sourceRefForChunk(paymentScreen, 'This screen validates payment details, sends the request, and displays the returned payment link.'));
      paymentRefs.push(sourceRefForChunk(paymentController, 'This server code creates an order, contacts the payment provider, records a pending status, and returns a payment link.'));
    }
    const guidedFiles = [...new Map([...flowRefs, ...authRefs, ...paymentRefs].map((file) => [`${file.filePath}:${file.startLine}`, file])).values()].slice(0, 18);
    chapter('application-flow', 'How does the application work?', [...flowParagraphs, ...authJourneys], guidedFiles,
      { relationships: focusEdges.map((edge) => ({ sourcePath: pathOf(edge.source), targetPath: pathOf(edge.target), label: 'imports', certainty: 'high', evidenceType: 'static-analysis' })),
        diagram: { nodes: [...new Set(focusEdges.flatMap((edge) => [pathOf(edge.source), pathOf(edge.target)]))].filter(Boolean).map((filePath) => ({ filePath, label: basenameForPath(filePath) })),
          edges: focusEdges.map((edge) => ({ sourcePath: pathOf(edge.source), targetPath: pathOf(edge.target), label: 'imports', certainty: 'high' })) }, evidenceType: 'mixed', certainty: 'medium' });
  }
  if (dataPaths.length || integrationPaths.length || dataOperationEvidence.length) {
    const dataRefs = [...new Set([...dataPaths, ...dataOperationEvidence.map((item) => item.filePath), ...integrationPaths.map((item) => item.filePath)])].slice(0, 10)
      .map((filePath) => sourceRef(filePath, dataPaths.includes(filePath) ? 'The path or parsed source contains a data/persistence clue; inspect the source to confirm how it is used.' : dataOperationEvidence.some((item) => item.filePath === filePath) ? 'A parsed source chunk contains a data-operation pattern; read it to confirm the exact behavior.' : 'This file imports a package-like module; its role must be confirmed in the source.'));
    const paragraphs = [];
    const connectionChunks = sourceChunks.filter((chunk) => /mongoose\.connect\s*\(|MongoClient\s*\(|createConnection\s*\(/i.test(chunk.source));
    const schemaChunks = sourceChunks.filter((chunk) => /(?:mongoose\.)?Schema\s*\(|new\s+Schema\s*\(/i.test(chunk.source));
    if (connectionChunks.length) {
      const connectionNames = [...new Set(connectionChunks.map((chunk) => chunk.relativePath))];
      const databaseName = connectionChunks.some((chunk) => /mongoose\.connect/i.test(chunk.source)) ? 'MongoDB, through the Mongoose library' : 'its configured database';
      paragraphs.push(`We found the database connection code in ${humanList(connectionNames)}. It connects the server to ${databaseName}, so this is where the application opens its connection to saved information.`);
      dataRefs.push(...connectionChunks.map((chunk) => sourceRefForChunk(chunk, 'This code opens the application database connection.')));
    }
    if (schemaChunks.length) {
      const modelNames = [...new Set(schemaChunks.map((chunk) => basenameForPath(chunk.relativePath)))].slice(0, 6);
      paragraphs.push(`The project also describes the information it saves in files such as ${humanList(modelNames)}. Think of these as forms that say what a saved user or order can contain. The linked code shows the actual fields.`);
      dataRefs.push(...schemaChunks.slice(0, 6).map((chunk) => sourceRefForChunk(chunk, 'This file defines the shape of information stored by the application.')));
    } else if (dataPaths.length) paragraphs.push(`An application often needs to remember information between visits. Files such as ${dataPaths.slice(0, 5).join(', ')} are kept in folders commonly used for data definitions or database access. The folder names are a helpful clue; open the links to confirm what information they describe.`);
    if (dataOperationEvidence.length) paragraphs.push(`We also found code for connecting to a database or reading and saving records in ${dataOperationEvidence.slice(0, 5).map((item) => item.filePath).join(', ')}. These links take you to the places where you can see what information the application reads or changes.`);
    if (integrationPaths.length) {
      const externalNames = [...new Set(integrationPaths.map((item) => item.moduleName))].slice(0, 8);
      paragraphs.push(`Some files also use outside software packages such as ${externalNames.join(', ')}. These are tools the project depends on; the linked code shows where each one is used.`);
    }
    const uniqueDataRefs = [...new Map(dataRefs.map((file) => [`${file.filePath}:${file.startLine}`, file])).values()].slice(0, 12);
    chapter('data-integrations', 'Where does data go?', paragraphs, uniqueDataRefs, { details: dataEvidence, evidenceType: 'mixed', certainty: 'medium' });
  }
  const summaryLinks = focusEdges.slice(0, 4).map((edge) => `${pathOf(edge.source)} imports ${pathOf(edge.target)}`);
  const previouslyReferenced = new Set(storyChapters.flatMap((item) => item.files.map((file) => file.filePath)));
  const summaryFiles = [...new Set([...topEntryFiles, ...[...focusPaths].slice(0, 4), ...dataPaths])].filter((filePath) => !previouslyReferenced.has(filePath)).slice(0, 4);
  chapter('summary', 'Putting the pieces together', [
    `Now we can see the project as a set of parts: start with files that look like the entry point, use the folder map to find the screens and server code, then follow the links to learn how a feature is put together. If the project stores information or uses outside services, the links above show where to continue reading.`,
    ...(summaryLinks.length ? [`For example, ${summaryLinks.slice(0, 3).join('; ')}. These links tell us which files use code from other files; the full sequence of a user's action may need to be confirmed by reading them.`] : ['We have not confirmed direct links between the files yet, so use the examples above to explore each part and build the picture as you read.']),
    graph.metadata.isComplete ? 'We could examine all files supported by this analysis. Some file types and the exact order of actions may still need to be checked in the project itself.' : `We could examine ${parsedPaths.size} of ${files.length} indexed files, so some parts of the application may be missing from this walkthrough.`,
    'You now have the basic mental model of this codebase.'
  ], summaryFiles
    .map((filePath) => sourceRef(filePath, 'Useful source to reopen while exploring the connected repository story.')),
  { evidenceType: graph.metadata.isComplete ? 'static-analysis' : 'partial-analysis', certainty: graph.metadata.isComplete ? 'medium' : 'low' });
  return { repositoryId, status: 'ready', recommendations: entries.slice(0, limit).map(({ key, ...item }, index) => ({ order: index + 1, ...item })),
    onboarding: { overview: { indexedFiles: files.length, parsedFiles: parsedPaths.size, languages, frameworks,
      mainDirectories: directories.slice(0, 8).map(({ path, fileCount }) => ({ path, fileCount })), architectureAreas,
      introduction: `This repository snapshot contains ${files.length} indexed files, of which ${parsedPaths.size} contain parsed code. The analysis detected ${languages.length ? languages.join(', ') : 'no supported language labels'}. Follow the chapters to inspect the available source evidence.`,
      limitations: graph.metadata.unsupportedRelationships }, directories, chapters: storyChapters, next: stages.at(-1)?.recommendations ?? [] },
    stages, metadata: { totalRecommendations: Math.min(entries.length, limit), totalStages: stages.length, method: 'static-analysis', isComplete: graph.metadata.isComplete,
      parsingJobId: graph.metadata.parsingJobId, indexingJobId: graph.metadata.indexingJobId,
      coverage: { indexedFiles: files.length, parsedFiles: parsedPaths.size, chunks: chunks.length, truncated: Boolean(graph.metadata.truncated) } } };
}

export function validateRepositoryFilePath(filePath) {
  return typeof filePath === 'string' && filePath.length > 0 && filePath.length <= 500 &&
    !filePath.startsWith('/') && !filePath.startsWith('\\') && !/^[a-zA-Z]:/.test(filePath) &&
    !filePath.includes('\\') && filePath.split('/').every((part) => part && part !== '.' && part !== '..');
}

export const CODE_EXPLORER_LIMITS = { FILE_LIMIT, CHUNK_LIMIT };
