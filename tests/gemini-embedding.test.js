import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiEmbeddingService } from '../src/services/gemini-embedding.service.js';
import { createEmbeddingProcessor } from '../src/services/embedding-job.service.js';
import { hybridSearch, fuseRankedResults } from '../src/services/hybrid-search.service.js';
import { validateEnv } from '../src/config/env.js';
import { readFile } from 'node:fs/promises';
import { createAskController } from '../src/controllers/ask.controller.js';

const config = { apiKey: 'test-gemini-key', model: 'gemini-embedding-001', dimensions: 768, requestTimeoutMs: 1000 };
const rawVector = () => Array(768).fill(3);
const responseFor = (contents) => ({ embeddings: contents.map(() => ({ values: rawVector() })) });

test('Gemini embedding batches use configured model, document task type, reduced dimensions, and unit-normalize', async () => {
  let request;
  const service = createGeminiEmbeddingService({ config, client: { models: { embedContent: async (value) => { request = value; return responseFor(value.contents); } } } });
  const vectors = await service.embed(['code one', 'code two']);
  assert.equal(request.model, 'gemini-embedding-001');
  assert.deepEqual(request.contents, ['code one', 'code two']);
  assert.deepEqual(request.config, { taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 768, abortSignal: request.config.abortSignal });
  assert.equal(vectors.length, 2);
  assert.equal(vectors[0].length, 768);
  assert.ok(Math.abs(Math.hypot(...vectors[0]) - 1) < 1e-12);
});

test('Gemini query embeddings use CODE_RETRIEVAL_QUERY and the same model and dimensions', async () => {
  let request;
  const service = createGeminiEmbeddingService({ config, client: { models: { embedContent: async (value) => { request = value; return responseFor(value.contents); } } } });
  const vector = await service.embedOne('where is login handled?', { taskType: 'CODE_RETRIEVAL_QUERY' });
  assert.equal(request.model, config.model);
  assert.equal(request.config.taskType, 'CODE_RETRIEVAL_QUERY');
  assert.equal(request.config.outputDimensionality, 768);
  assert.equal(vector.length, 768);
});

test('Gemini embedding validates count, dimensions, finite values, and rejects zero vectors', async () => {
  for (const embeddings of [[], [{ values: [1] }], [{ values: [...rawVector().slice(0, 767), Number.NaN] }], [{ values: Array(768).fill(0) }]]) {
    const service = createGeminiEmbeddingService({ config, client: { models: { embedContent: async () => ({ embeddings }) } } });
    await assert.rejects(service.embed('some source'), /embedding/i);
  }
});

test('Gemini maps rate limits and transient failures as retryable without exposing provider details', async () => {
  const rateLimit = createGeminiEmbeddingService({ config, client: { models: { embedContent: async () => { const error = new Error('provider detail and test-gemini-key'); error.status = 429; throw error; } } } });
  await assert.rejects(rateLimit.embed('code'), (error) => error.retryable === true && error.status === 429 && !error.message.includes(config.apiKey));
  const transient = createGeminiEmbeddingService({ config, client: { models: { embedContent: async () => { const error = new Error('temporary'); error.status = 503; throw error; } } } });
  await assert.rejects(transient.embed('code'), (error) => error.retryable === true && error.status === 503);
  const network = createGeminiEmbeddingService({ config, client: { models: { embedContent: async () => { throw new TypeError('fetch failed'); } } } });
  await assert.rejects(network.embed('code'), (error) => error.retryable === true);
  const timeout = createGeminiEmbeddingService({ config: { ...config, requestTimeoutMs: 5 }, client: { models: { embedContent: async ({ config: requestConfig }) => new Promise((_resolve, reject) => requestConfig.abortSignal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true })) } } });
  await assert.rejects(timeout.embed('code'), (error) => error.retryable === true && error.code === 'GEMINI_EMBEDDING_TIMEOUT');
  const auth = createGeminiEmbeddingService({ config, client: { models: { embedContent: async () => { const error = new Error('private provider content'); error.status = 403; throw error; } } } });
  await assert.rejects(auth.embed('code'), (error) => error.retryable === false && !error.message.includes('private provider content'));
});

test('embedding worker persists valid vectors and marks progress using the document task', async () => {
  const calls = [];
  const updates = [];
  const job = { id: 'embedding-job', repositoryId: 'repository', parsingJobId: 'parse-job', status: 'queued' };
  const chunks = [
    { id: 'chunk-a', source: 'const a = 1', sourceHash: 'ha', relativePath: 'a.js', language: 'javascript', structureType: 'variable', symbolName: 'a' },
    { id: 'chunk-b', source: 'const b = 2', sourceHash: 'hb', relativePath: 'b.js', language: 'javascript', structureType: 'variable', symbolName: 'b' }
  ];
  const prisma = {
    embeddingJob: { findUnique: async () => job, update: async ({ data }) => updates.push(data) },
    codeChunk: { count: async () => chunks.length, findMany: async ({ where }) => where.id ? [] : chunks.map((chunk) => ({ ...chunk, embeddings: [] })) },
    async $executeRaw(strings, ...values) { calls.push({ sql: strings.join('?'), values }); return 0; }
  };
  const embeddingService = { embed: async (texts, options) => { assert.equal(texts.length, 2); assert.equal(options.taskType, 'RETRIEVAL_DOCUMENT'); return [rawVector().map(() => 1 / Math.sqrt(768)), rawVector().map(() => 1 / Math.sqrt(768))]; } };
  await createEmbeddingProcessor({ prisma, embeddingService, config: { embedding: { model: config.model, dimensions: 768, batchSize: 10, maxInputChars: 10000 } } })({ data: { embeddingJobId: job.id } });
  assert.equal(calls.filter(({ sql }) => sql.includes('VALUES')).length, 2);
  assert.equal(updates.at(-1).status, 'completed');
  assert.equal(updates.at(-1).embeddedChunks, 2);
});

test('embedding worker rejects a wrong vector dimension before SQL insertion', async () => {
  const written = [];
  const job = { id: 'job', repositoryId: 'repo', parsingJobId: 'parse', status: 'queued' };
  const chunk = { id: 'chunk', source: 'x()', sourceHash: 'hash', relativePath: 'x.js', language: 'javascript', structureType: 'function', embeddings: [] };
  const prisma = {
    embeddingJob: { findUnique: async () => job, update: async () => {} },
    codeChunk: { count: async () => 1, findMany: async ({ where }) => where.id ? [] : [chunk] },
    async $executeRaw(strings) { written.push(strings.join('?')); return 0; }
  };
  const service = { embed: async () => [Array(767).fill(1)] };
  await createEmbeddingProcessor({ prisma, embeddingService: service, config: { embedding: { model: config.model, dimensions: 768, batchSize: 10, maxInputChars: 10000 } } })({ data: { embeddingJobId: job.id } });
  assert.equal(written.filter((sql) => sql.includes('VALUES')).length, 0);
});

test('hybrid vector retrieval uses Gemini query embeddings and preserves keyword RRF', async () => {
  let taskType;
  const prisma = {
    repositoryImport: { findFirst: async () => ({ id: 'import' }) },
    parsingJob: { findFirst: async () => ({ id: 'parse-job' }) },
    codeEmbedding: { count: async () => 1 },
    async $queryRaw(strings) {
      const sql = strings.join('');
      return sql.includes('vector') ? [{ chunkId: 'chunk', filePath: 'src/a.js', sourceCode: 'A' }] : [{ chunkId: 'chunk', filePath: 'src/a.js', sourceCode: 'A' }];
    }
  };
  const embeddingService = { embedOne: async (_query, options) => { taskType = options.taskType; return rawVector().map(() => 1 / Math.sqrt(768)); } };
  const config = { embedding: { model: 'gemini-embedding-001', dimensions: 768 }, search: { vectorLimit: 20, keywordLimit: 20, rrfK: 60 } };
  const result = await hybridSearch({ prisma, embeddingService, config, repositoryId: 'repo', userId: 'user', query: 'find login', limit: 5 });
  assert.equal(taskType, 'CODE_RETRIEVAL_QUERY');
  assert.equal(result.results[0].chunkId, 'chunk');
  assert.deepEqual(result.results[0].matchedBy, ['vector', 'keyword']);
  assert.equal(fuseRankedResults([], [], {}).length, 0);
});

test('environment supports hosted Gemini and preserves local Ollama defaults', () => {
  const local = validateEnv({ NODE_ENV: 'test', EMBEDDING_PROVIDER: 'ollama' });
  assert.equal(local.embedding.provider, 'ollama');
  assert.equal(local.embedding.dimensions, 1024);
  const hosted = validateEnv({ NODE_ENV: 'test', EMBEDDING_PROVIDER: 'gemini', EMBEDDING_MODEL: 'gemini-embedding-001', EMBEDDING_DIMENSIONS: '768', GEMINI_API_KEY: 'private-key' });
  assert.equal(hosted.embedding.provider, 'gemini');
  assert.equal(hosted.embedding.model, 'gemini-embedding-001');
  assert.equal(hosted.embedding.dimensions, 768);
  assert.equal(hosted.llm.apiKey, 'private-key');
  assert.equal('baseUrl' in hosted.embedding, false);
});


test('768D migration invalidates embeddings only and schedules replacement jobs for parsed chunks', async () => {
  const migration = await readFile(new URL('../prisma/migrations/20261108140000_gemini_embeddings_768/migration.sql', import.meta.url), 'utf8');
  assert.match(migration, /DELETE FROM \"CodeEmbedding\"/);
  assert.match(migration, /USING hnsw \(\"embedding\" vector_cosine_ops\)/);
  assert.match(migration, /INSERT INTO \"EmbeddingJob\"/);
  assert.match(migration, /FROM \"ParsingJob\" p/);
  assert.doesNotMatch(migration, /DELETE FROM \"CodeChunk\"|DELETE FROM \"RepositoryFile\"|DELETE FROM \"Repository\"/);
});


test('RAG answers from database chunks retrieved with Gemini code-query embeddings', async () => {
  let providerRequest;
  const embeddingService = createGeminiEmbeddingService({ config, client: { models: { embedContent: async (request) => { providerRequest = request; return responseFor(request.contents); } } } });
  const chunk = { chunkId: 'chunk-1', filePath: 'src/auth.js', language: 'javascript', structureType: 'function', symbolName: 'validateToken', startLine: 1, endLine: 4, sourceCode: 'function validateToken(token) { return Boolean(token); }', metadata: {} };
  const prisma = {
    repositoryImport: { findFirst: async () => ({ id: 'import' }) },
    parsingJob: { findFirst: async () => ({ id: 'parse-job' }) },
    codeEmbedding: { count: async () => 1 },
    async $queryRaw(strings) { return strings.join('').includes('vector') ? [{ ...chunk, distance: 0.1 }] : [chunk]; }
  };
  let generatedPrompt;
  const llmService = { generateJson: async (prompt) => { generatedPrompt = prompt; return { answer: 'Token validation is in [[S1]].', citations: [], insufficientEvidence: false }; } };
  const ask = createAskController({ prisma, embeddingService, llmService, config: {
    embedding: { model: config.model, dimensions: 768 },
    search: { vectorLimit: 20, keywordLimit: 20, rrfK: 60 },
    rag: { maxQuestionLength: 1000, enableStreaming: false, retrievalLimit: 10, maxContextTokens: 4000 },
    llm: { requestTimeoutMs: 5000, apiKey: '' }
  } });
  let response;
  let nextError;
  await ask.ask({ params: { repositoryId: '22222222-2222-4222-8222-222222222222' }, body: { question: 'Where is the token validated?' }, auth: { userId: '11111111-1111-4111-8111-111111111111' } }, { json(value) { response = value; } }, (error) => { nextError = error; });
  assert.equal(nextError, undefined);
  assert.equal(providerRequest.model, 'gemini-embedding-001');
  assert.equal(providerRequest.config.taskType, 'CODE_RETRIEVAL_QUERY');
  assert.equal(providerRequest.config.outputDimensionality, 768);
  assert.match(generatedPrompt, /validateToken/);
  assert.equal(response.answer, 'Token validation is in [[S1]].');
  assert.equal(response.citations[0].chunkId, 'chunk-1');
});


test('embedding worker ignores jobs invalidated by a migration before processing', async () => {
  let updated = false;
  const prisma = {
    embeddingJob: { findUnique: async () => ({ status: 'failed' }), update: async () => { updated = true; } }
  };
  await createEmbeddingProcessor({ prisma, embeddingService: {}, config: { embedding: {} } })({ data: { embeddingJobId: 'invalidated-job' } });
  assert.equal(updated, false);
});
