import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { validateEnv } from '../src/config/env.js';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/session.js';
import { buildCodeGraph, buildReadingGuide, validateRepositoryFilePath } from '../src/services/code-explorer.service.js';

const userId = '11111111-1111-4111-8111-111111111111';
const repositoryId = '22222222-2222-4222-8222-222222222222';
const secret = 'test-secret-that-is-long-enough-to-pass';
const config = validateEnv({ NODE_ENV: 'test', SESSION_SECRET: secret });
const files = [{ id: 'file1', relativePath: 'src/index.js' }, { id: 'file2', relativePath: 'src/auth.js' }];
const chunks = [
  { id: 'chunk1', relativePath: 'src/index.js', language: 'javascript', structureType: 'import', symbolName: null, startLine: 1, endLine: 1, metadata: { moduleName: './auth', importedIdentifiers: ['login'] } },
  { id: 'chunk2', relativePath: 'src/index.js', language: 'javascript', structureType: 'function', symbolName: 'start', startLine: 3, endLine: 8, metadata: {} },
  { id: 'chunk3', relativePath: 'src/auth.js', language: 'javascript', structureType: 'function', symbolName: 'login', startLine: 1, endLine: 4, metadata: {} }
];
const parsingJob = { id: 'parse1', status: 'completed' };

async function cookie() { return `${SESSION_COOKIE}=${await createSessionToken(userId, secret)}`; }

function appFor({ owned = true, parseStatus = 'completed', parseIndexingJobId = 'index1' } = {}) {
  let savedReadingProgress = null;
  const prisma = {
    user: { findUnique: async () => ({ id: userId }) },
    repositoryImport: { findFirst: async () => owned ? ({ id: 'import1' }) : null },
    indexingJob: { findFirst: async () => ({ id: 'index1', status: 'completed', createdAt: new Date() }) },
    parsingJob: { findFirst: async () => ({ ...parsingJob, status: parseStatus, indexingJobId: parseIndexingJobId }) },
    readingProgress: {
      findUnique: async () => savedReadingProgress,
      upsert: async ({ create, update }) => { savedReadingProgress = { id: 'saved-progress', ...(savedReadingProgress ? update : create) }; return savedReadingProgress; }
    },
    repositoryFile: { findMany: async () => files, findFirst: async ({ where }) => files.find((file) => file.relativePath === where.relativePath) ?? null },
    codeChunk: { findFirst: async ({ where }) => where.id === '33333333-3333-4333-8333-333333333333' && where.fileId === 'file1' ? ({ ...chunks[1], id: where.id, source: 'function start() {}' }) : null,
      findMany: async ({ where }) => {
      if (where.fileId) return [{ ...chunks[1], source: 'function start() {}' }].filter((chunk) => !where.symbolName || chunk.symbolName === where.symbolName);
      return chunks.filter((chunk) => !where.parsingJobId || where.parsingJobId === 'parse1');
    } }
  };
  return createApp({ prisma, config, nodeEnv: 'test', frontendUrl: config.frontendUrl });
}

test('graph builds stable file, symbol, containment and locally resolved import relationships only', () => {
  const first = buildCodeGraph({ repositoryId, indexingJobId: 'index1', parsingJob, files, chunks });
  const second = buildCodeGraph({ repositoryId, indexingJobId: 'index1', parsingJob, files, chunks });
  assert.deepEqual(first, second);
  assert.deepEqual([...new Set(first.nodes.map((node) => node.type))].sort(), ['file', 'function', 'import']);
  assert.equal(first.edges.filter((edge) => edge.type === 'CONTAINS').length, 3);
  assert.equal(first.edges.filter((edge) => edge.type === 'IMPORTS').length, 1);
  assert.equal(first.edges.some((edge) => ['CALLS', 'EXPORTS'].includes(edge.type)), false);
  assert.equal(first.metadata.hasUncertainRelationships, false);
  assert.equal(first.metadata.modules.length, 1);
  assert.equal(first.metadata.modules[0].fileCount, 2);
});

test('graph groups by repository paths and reports only direct cross-module imports', () => {
  const moduleFiles = [
    { id: 'a', relativePath: 'src/controllers/auth.js', extension: '.js' },
    { id: 'b', relativePath: 'src/services/session.js', extension: '.js' }
  ];
  const moduleChunks = [
    { ...chunks[0], relativePath: 'src/controllers/auth.js', metadata: { moduleName: '../services/session', importedIdentifiers: ['createSession'] } },
    { ...chunks[1], relativePath: 'src/controllers/auth.js' },
    { ...chunks[2], relativePath: 'src/services/session.js' }
  ];
  const graph = buildCodeGraph({ repositoryId, indexingJobId: 'index1', parsingJob, files: moduleFiles, chunks: moduleChunks });
  assert.deepEqual(graph.metadata.modules.map((module) => module.path), ['src/controllers', 'src/services']);
  assert.equal(graph.metadata.modules[0].dependencies[0].modulePath, 'src/services');
  assert.equal(graph.metadata.modules[0].dependencies[0].importCount, 1);
});

test('graph resolves literal CommonJS require dependencies from parsed declarations', () => {
  const commonJsFiles = [
    { id: 'route', relativePath: 'backend/routes/auth.js', extension: '.js' },
    { id: 'controller', relativePath: 'backend/controllers/auth.js', extension: '.js' }
  ];
  const commonJsChunks = [{ relativePath: 'backend/routes/auth.js', language: 'javascript', structureType: 'variable', symbolName: 'controller', startLine: 2, endLine: 2,
    metadata: { moduleNames: ['../controllers/auth'], importKind: 'commonjs-require' } }];
  const graph = buildCodeGraph({ repositoryId, indexingJobId: 'index1', parsingJob, files: commonJsFiles, chunks: commonJsChunks });
  const edge = graph.edges.find((item) => item.type === 'IMPORTS');
  assert.ok(edge);
  assert.equal(graph.nodes.find((node) => node.id === edge.target).filePath, 'backend/controllers/auth.js');
  assert.equal(edge.evidence.importKind, 'commonjs-require');
});

test('graph keeps its overview bounded for repositories with many top-level directories', () => {
  const manyFiles = Array.from({ length: 30 }, (_, index) => ({ id: `file-${index}`, relativePath: `src${index}/index.js`, extension: '.js' }));
  const graph = buildCodeGraph({ repositoryId, indexingJobId: 'index1', parsingJob, files: manyFiles, chunks: [] });
  assert.ok(graph.metadata.modules.length <= 24);
  assert.equal(graph.metadata.modules[0].path, '.');
  assert.equal(graph.metadata.modules[0].fileCount, 30);
  assert.equal(graph.nodes[0].id, buildCodeGraph({ repositoryId, indexingJobId: 'index2', parsingJob, files: manyFiles, chunks: [] }).nodes[0].id);
});

test('reading guide is deterministic, explains conventional entrypoint as inferred, and falls back to parsed symbols', () => {
  const graph = buildCodeGraph({ repositoryId, indexingJobId: 'index1', parsingJob, files, chunks });
  const guide = buildReadingGuide({ repositoryId, files, chunks, graph });
  assert.equal(guide.recommendations[0].filePath, 'src/index.js');
  assert.equal(guide.recommendations[0].certainty, 'medium');
  assert.equal(guide.recommendations[0].isInferred, true);
  assert.match(guide.recommendations[0].reason, /confirm it against/);
  assert.deepEqual(guide, buildReadingGuide({ repositoryId, files, chunks, graph }));
  assert.deepEqual(guide.stages.map((stage) => stage.id), ['repository-map', 'initialization', 'application-flow', 'core-functionality', 'data-architecture', 'dependencies', 'next-exploration']);
  assert.ok(guide.stages.every((stage) => stage.title && stage.summary && stage.expectedOutcome && Array.isArray(stage.prerequisites)));
  assert.equal(guide.onboarding.overview.indexedFiles, files.length);
  assert.equal(guide.onboarding.overview.parsedFiles, new Set(chunks.map((chunk) => chunk.relativePath)).size);
  assert.ok(Array.isArray(guide.onboarding.directories));
  assert.ok(guide.stages.every((stage) => stage.narrative && stage.learningObjective && stage.flow && stage.flow.limitation));
  assert.ok(guide.onboarding.directories.every((directory) => directory.evidenceType === 'path-grouping'));
  assert.ok(guide.stages.flatMap((stage) => stage.flow.edges).every((edge) => edge.label === 'imports' && edge.certainty === 'high'));
  assert.ok(guide.onboarding.chapters.length >= 3);
  assert.equal(guide.onboarding.chapters.at(-1).title, 'Putting the pieces together');
  assert.match(guide.onboarding.chapters[0].paragraphs[0], /Let's start with the shape of the project/);
  assert.doesNotMatch(guide.onboarding.chapters[0].paragraphs[0], /parser|snapshot|cross-group|indexed files/i);
  assert.ok(guide.onboarding.chapters.find((chapter) => chapter.id === 'application-flow').paragraphs[0].includes('Now let\'s follow'));
  assert.ok(guide.onboarding.chapters.flatMap((chapter) => chapter.files).every((file) => files.some((candidate) => candidate.relativePath === file.filePath)));
  assert.ok(guide.onboarding.chapters.flatMap((chapter) => chapter.relationships).every((edge) => edge.label === 'imports' && edge.evidenceType === 'static-analysis'));
  assert.ok(guide.stages[0].recommendations[0].files[0].graphNodeId);
  const fallback = buildReadingGuide({ repositoryId, files: [{ relativePath: 'lib/core.js' }], chunks: [{ ...chunks[2], relativePath: 'lib/core.js' }], graph: { ...graph, edges: [], metadata: graph.metadata } });
  assert.equal(fallback.recommendations[0].certainty, 'low');
  assert.match(fallback.recommendations[0].reason, /Fallback/);
});

test('reading guide traces verified sign-in and payment behavior from retained source with clickable line references', () => {
  const featureFiles = [
    'frontend/src/main.jsx', 'frontend/src/App.jsx', 'frontend/src/Auth.jsx', 'frontend/src/CreatePayment.jsx',
    'backend/app.js', 'backend/config/db.js', 'backend/routes/auth.route.js', 'backend/controllers/auth.controller.js',
    'backend/routes/payement_gateway.route.js', 'backend/controllers/payement_gateway.controller.js',
    'backend/models/User.js', 'backend/models/Order.js'
  ].map((relativePath) => ({ relativePath, extension: '.js' }));
  const sourceChunk = (relativePath, startLine, symbolName, source, metadata = {}, structureType = 'function') => ({
    relativePath, startLine, endLine: startLine + source.split('\n').length - 1, symbolName, source, metadata, structureType, language: 'javascript'
  });
  const featureChunks = [
    sourceChunk('frontend/src/main.jsx', 1, null, "import App from './App';", { moduleName: './App' }, 'import'),
    sourceChunk('frontend/src/App.jsx', 1, null, "import Auth from './Auth';", { moduleName: './Auth' }, 'import'),
    sourceChunk('frontend/src/Auth.jsx', 8, 'handleSubmit', "const url = mode === 'login' ? `${API_BASE}/api/auth/login` : `${API_BASE}/api/auth/register`; await axios.post(url, payload); navigate('/dashboard');"),
    sourceChunk('backend/routes/auth.route.js', 1, 'authController', "const { handleLogin, handleRegister } = require('../controllers/auth.controller');", { moduleNames: ['../controllers/auth.controller'], importKind: 'commonjs-require' }, 'variable'),
    sourceChunk('backend/controllers/auth.controller.js', 8, 'login', 'const user = await User.findOne({ username }); const ok = await bcrypt.compare(password, user.password); res.cookie("session", token);'),
    sourceChunk('backend/controllers/auth.controller.js', 35, 'register', 'const newUser = new User({ username, email }); await newUser.save(); res.cookie("session", token);'),
    sourceChunk('frontend/src/CreatePayment.jsx', 24, 'handleSubmit', 'await axios.post(`${API_BASE}/api/payment/create-payment`, payload); setShowSuccessModal(true);'),
    sourceChunk('backend/routes/payement_gateway.route.js', 1, 'paymentController', 'const { createPayment } = require("../controllers/payement_gateway.controller");', { moduleNames: ['../controllers/payement_gateway.controller'], importKind: 'commonjs-require' }, 'variable'),
    sourceChunk('backend/controllers/payement_gateway.controller.js', 12, 'createPayment', 'const order = await Order.create(payload); const response = await axios.post("https://payments.example.test/create", payload); await OrderStatus.create({ status: "PENDING" }); startPaymentWatcher(id); return res.json({ payment_url: response.data.url });'),
    sourceChunk('backend/config/db.js', 3, 'connectDB', 'await mongoose.connect(process.env.MONGO_URI);'),
    sourceChunk('backend/models/User.js', 2, 'userSchema', 'const userSchema = new mongoose.Schema({ username: String, email: String, password: String });', {}, 'variable'),
    sourceChunk('backend/models/Order.js', 2, 'orderSchema', 'const orderSchema = new mongoose.Schema({ school_id: String, amount: Number });', {}, 'variable')
  ];
  const graph = buildCodeGraph({ repositoryId, indexingJobId: 'index1', parsingJob, files: featureFiles, chunks: featureChunks });
  const guide = buildReadingGuide({ repositoryId, files: featureFiles, chunks: featureChunks, graph });
  const story = guide.onboarding.chapters;
  const overview = story.find((chapter) => chapter.id === 'overview').paragraphs.join(' ');
  const entry = story.find((chapter) => chapter.id === 'beginning');
  const flows = story.find((chapter) => chapter.id === 'application-flow');
  const data = story.find((chapter) => chapter.id === 'data-integrations');
  assert.match(overview, /signing in or registering/);
  assert.match(overview, /creating payment links/);
  assert.match(entry.paragraphs.join(' '), /frontend\/src\/main\.jsx.*frontend\/src\/App\.jsx/);
  assert.match(flows.paragraphs.join(' '), /\/api\/auth\/login/);
  assert.match(flows.paragraphs.join(' '), /compares the submitted password/);
  assert.match(flows.paragraphs.join(' '), /\/api\/payment\/create-payment/);
  assert.match(flows.paragraphs.join(' '), /records a pending status/);
  assert.ok(flows.files.some((file) => file.filePath === 'backend/controllers/payement_gateway.controller.js' && file.startLine === 12));
  assert.match(data.paragraphs.join(' '), /database connection code/);
  assert.match(data.paragraphs.join(' '), /User\.js and Order\.js/);
});

test('repository-relative path validation rejects absolute paths and traversal', () => {
  assert.equal(validateRepositoryFilePath('src/auth.js'), true);
  for (const path of ['/etc/passwd', '../secret', 'src/../secret', 'C:\\secret', 'src\\auth.js']) assert.equal(validateRepositoryFilePath(path), false);
});

test('graph API requires authentication and checks repository ownership', async () => {
  assert.equal((await request(appFor()).get(`/api/repositories/${repositoryId}/graph`)).status, 401);
  const response = await request(appFor({ owned: false })).get(`/api/repositories/${repositoryId}/graph`).set('Cookie', await cookie());
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'REPOSITORY_NOT_FOUND');
});

test('graph API returns current parsed graph and refuses stale/unavailable analysis mixing', async () => {
  const ready = await request(appFor()).get(`/api/repositories/${repositoryId}/graph`).set('Cookie', await cookie());
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, 'ready');
  assert.equal(ready.body.edges.some((edge) => edge.type === 'IMPORTS'), true);
  const stale = await request(appFor({ parseIndexingJobId: 'old-index' })).get(`/api/repositories/${repositoryId}/graph`).set('Cookie', await cookie());
  assert.equal(stale.body.status, 'stale');
  assert.deepEqual(stale.body.nodes, []);
  const parsing = await request(appFor({ parseStatus: 'processing' })).get(`/api/repositories/${repositoryId}/graph`).set('Cookie', await cookie());
  assert.equal(parsing.body.status, 'parsing');
});

test('source API returns only stored parsed chunks with trusted line data and rejects traversal', async () => {
  const app = appFor();
  const invalid = await request(app).get(`/api/repositories/${repositoryId}/source?filePath=..%2Fsecret`).set('Cookie', await cookie());
  assert.equal(invalid.status, 400);
  const valid = await request(app).get(`/api/repositories/${repositoryId}/source?filePath=src%2Findex.js&startLine=3&endLine=8`).set('Cookie', await cookie());
  assert.equal(valid.status, 200);
  assert.equal(valid.body.contentScope, 'parsed_chunks');
  assert.equal(valid.body.chunks[0].source, 'function start() {}');
  assert.equal(valid.body.chunks[0].startLine, 3);
  assert.equal(valid.body.metadata.isCompleteFile, false);
  const citation = await request(app).get(`/api/repositories/${repositoryId}/source?filePath=src%2Findex.js&chunkId=33333333-3333-4333-8333-333333333333`).set('Cookie', await cookie());
  assert.equal(citation.status, 200);
  assert.equal(citation.body.chunks[0].id, '33333333-3333-4333-8333-333333333333');
});

test('reading guide endpoint returns a stable, explainable static-analysis guide', async () => {
  const response = await request(appFor()).get(`/api/repositories/${repositoryId}/reading-guide`).set('Cookie', await cookie());
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ready');
  assert.equal(response.body.metadata.method, 'static-analysis');
  assert.match(response.body.recommendations[0].reason, /conventional application entry/);
  assert.ok(response.body.onboarding.chapters.length >= 3);
  assert.equal(response.body.onboarding.chapters.at(-1).title, 'Putting the pieces together');
});

test('reading progress is authenticated, repository scoped, and tied to the current parse snapshot', async () => {
  const app = appFor();
  const session = await cookie();
  const origin = { Origin: config.frontendUrl };
  const empty = await request(app).get(`/api/repositories/${repositoryId}/reading-progress`).set('Cookie', session);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.parsingJobId, 'parse1');
  assert.equal(empty.body.progress, null);

  const payload = { parsingJobId: 'parse1', activeStageId: 'initialization', statusByStage: { 'repository-map': 'completed', initialization: 'in-progress' } };
  const saved = await request(app).put(`/api/repositories/${repositoryId}/reading-progress`).set('Cookie', session).set(origin).send(payload);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.progress, payload);
  const restored = await request(app).get(`/api/repositories/${repositoryId}/reading-progress`).set('Cookie', session);
  assert.deepEqual(restored.body.progress, payload);

  const stale = await request(app).put(`/api/repositories/${repositoryId}/reading-progress`).set('Cookie', session).set(origin).send({ ...payload, parsingJobId: 'old-parse' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'STALE_ANALYSIS');
  const invalid = await request(app).put(`/api/repositories/${repositoryId}/reading-progress`).set('Cookie', session).set(origin).send({ ...payload, statusByStage: { initialization: 'visited' } });
  assert.equal(invalid.status, 400);
  const forbiddenOrigin = await request(app).put(`/api/repositories/${repositoryId}/reading-progress`).set('Cookie', session).set('Origin', 'https://attacker.example').send(payload);
  assert.equal(forbiddenOrigin.status, 403);
});

test('reading progress rejects unauthenticated and unowned repository access', async () => {
  assert.equal((await request(appFor()).get(`/api/repositories/${repositoryId}/reading-progress`)).status, 401);
  const response = await request(appFor({ owned: false })).get(`/api/repositories/${repositoryId}/reading-progress`).set('Cookie', await cookie());
  assert.equal(response.status, 404);
});
