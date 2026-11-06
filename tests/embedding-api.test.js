import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { validateEnv } from '../src/config/env.js';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/session.js';

const userId = '11111111-1111-4111-8111-111111111111';
const repositoryId = '22222222-2222-4222-8222-222222222222';
const secret = 'test-secret-that-is-long-enough-to-pass';
const config = validateEnv({ NODE_ENV: 'test', SESSION_SECRET: secret });

function appFor(prisma, embeddingService = { embedOne: async () => Array(1024).fill(0.1) }) {
  return createApp({ prisma, config, embeddingService, nodeEnv: 'test', frontendUrl: config.frontendUrl });
}

async function cookie() { return `${SESSION_COOKIE}=${await createSessionToken(userId, secret)}`; }

test('search API requires authentication', async () => {
  const response = await request(appFor({})).post(`/api/repositories/${repositoryId}/search`).set('Origin', config.frontendUrl).send({ query: 'auth' });
  assert.equal(response.status, 401);
});

test('search API prevents access to repositories not imported by the user', async () => {
  const prisma = { user: { findUnique: async () => ({ id: userId }) }, repositoryImport: { findFirst: async () => null } };
  const response = await request(appFor(prisma)).post(`/api/repositories/${repositoryId}/search`).set('Cookie', await cookie()).set('Origin', config.frontendUrl).send({ query: 'auth' });
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'REPOSITORY_NOT_FOUND');
});

test('search API validates query and missing-embedding state', async () => {
  const prisma = { user: { findUnique: async () => ({ id: userId }) }, repositoryImport: { findFirst: async () => ({ id: 'import' }) },
    parsingJob: { findFirst: async () => ({ id: 'parse' }) }, codeEmbedding: { count: async () => 0 } };
  const app = appFor(prisma);
  const invalid = await request(app).post(`/api/repositories/${repositoryId}/search`).set('Cookie', await cookie()).set('Origin', config.frontendUrl).send({ query: '   ' });
  assert.equal(invalid.status, 400);
  const absent = await request(app).post(`/api/repositories/${repositoryId}/search`).set('Cookie', await cookie()).set('Origin', config.frontendUrl).send({ query: 'auth' });
  assert.equal(absent.status, 409);
  assert.equal(absent.body.error.code, 'EMBEDDINGS_NOT_READY');
});

test('search API returns merged ranked chunks without embedding vectors', async () => {
  let generatedQuery = '';
  let queryCount = 0;
  const prisma = { user: { findUnique: async () => ({ id: userId }) }, repositoryImport: { findFirst: async () => ({ id: 'import' }) },
    parsingJob: { findFirst: async () => ({ id: 'parse' }) }, codeEmbedding: { count: async () => 1 },
    $queryRaw() {
      queryCount++;
      const chunk = { chunkId: 'chunk-1', filePath: 'src/auth.js', language: 'javascript', structureType: 'function', symbolName: 'authenticate', startLine: 1, endLine: 3, sourceCode: 'function authenticate() {}', metadata: {} };
      return Promise.resolve(queryCount === 1 ? [{ ...chunk, distance: 0.1 }] : [chunk]);
    } };
  const response = await request(appFor(prisma, { embedOne: async (text) => { generatedQuery = text; return Array(1024).fill(0.1); } }))
    .post(`/api/repositories/${repositoryId}/search`).set('Cookie', await cookie()).set('Origin', config.frontendUrl).send({ query: 'authenticate' });
  assert.equal(response.status, 200);
  assert.match(generatedQuery, /Given a question/);
  assert.deepEqual(response.body.results[0].retrieval.matchedBy, ['vector', 'keyword']);
  assert.equal(response.body.results[0].retrieval.vectorRank, 1);
  assert.equal('embedding' in response.body.results[0], false);
});

test('embedding API queues one job for the latest successful parse', async () => {
  const job = { id: 'job-1', repositoryId, parsingJobId: 'parse-latest', status: 'queued', stage: 'queued', progress: 0,
    totalChunks: 0, processedChunks: 0, embeddedChunks: 0, skippedChunks: 0, failedChunks: 0, errorMessage: null, startedAt: null, completedAt: null };
  const prisma = { user: { findUnique: async () => ({ id: userId }) }, repositoryImport: { findFirst: async () => ({ id: 'import' }) },
    parsingJob: { findFirst: async () => ({ id: 'parse-latest' }) }, embeddingJob: { findFirst: async () => null, create: async ({ data }) => ({ ...job, id: data.id, parsingJobId: data.parsingJobId }) } };
  const added = [];
  const embeddingQueue = { add: async (...args) => { added.push(args); } };
  const response = await request(createApp({ prisma, embeddingQueue, config, nodeEnv: 'test' }))
    .post(`/api/repositories/${repositoryId}/embeddings`).set('Cookie', await cookie()).set('Origin', config.frontendUrl).send({});
  assert.equal(response.status, 202);
  assert.equal(response.body.job.parsingJobId, 'parse-latest');
  assert.equal(added.length, 1);
  assert.deepEqual(added[0][1], { embeddingJobId: response.body.job.id });
});
