import test from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaEmbeddingService, formatCodeChunk, formatSearchQuery } from '../src/services/ollama-embedding.service.js';
import { fuseRankedResults, keywordSearch, vectorSearch } from '../src/services/hybrid-search.service.js';

const config = { baseUrl: 'http://localhost:11434', model: 'qwen3-embedding:0.6b', dimensions: 1024, requestTimeoutMs: 1000 };
const vector = (n = 1024) => Array.from({ length: n }, (_, i) => i / n);

test('Ollama sends native input array and returns validated vectors in order', async () => {
  let request;
  const service = createOllamaEmbeddingService({ config, fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body); return Response.json({ embeddings: [vector(), vector()] });
  } });
  const result = await service.embed(['first', 'second']);
  assert.deepEqual(request, { model: config.model, input: ['first', 'second'] });
  assert.equal(result.length, 2); assert.equal(result[0][20], 20 / 1024);
});

test('Ollama rejects incorrect counts, dimensions, malformed values, and empty text', async () => {
  const invalid = [[], [vector(2)], [[...vector().slice(0, 1023), NaN]]];
  for (const embeddings of invalid) {
    const service = createOllamaEmbeddingService({ config, fetchImpl: async () => Response.json({ embeddings }) });
    await assert.rejects(service.embed('code'), /embedding/i);
  }
  const service = createOllamaEmbeddingService({ config, fetchImpl: async () => Response.json({ embeddings: [] }) });
  await assert.rejects(service.embed('  '), /non-empty/i);
  assert.deepEqual(await service.embed([]), []);
});

test('Ollama provides useful missing model and connection errors', async () => {
  const missing = createOllamaEmbeddingService({ config, fetchImpl: async () => new Response(JSON.stringify({ error: 'model not found' }), { status: 404 }) });
  await assert.rejects(missing.embed('text'), /ollama pull qwen3-embedding:0.6b/i);
  const offline = createOllamaEmbeddingService({ config, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(offline.embed('text'), /Could not connect to Ollama/);
});

test('formats code documents and instruction-aware query text consistently', () => {
  assert.match(formatCodeChunk({ language: 'js', structureType: 'function', symbolName: 'f', relativePath: 'src/f.js', source: 'function f() {}' }), /File: src\/f.js/);
  assert.equal(formatSearchQuery(' find auth '), 'Instruct: Given a question, retrieve relevant code snippets\nQuery: find auth');
});

test('RRF merges duplicate chunks and computes expected scores and unique limit', () => {
  const result = fuseRankedResults([{ chunkId: 'a', sourceCode: 'A' }, { chunkId: 'b' }], [{ chunkId: 'b' }, { chunkId: 'a' }, { chunkId: 'c' }], { k: 60, limit: 2 });
  assert.deepEqual(result.map((item) => item.chunkId), ['a', 'b']);
  assert.equal(result[0].rrfScore, 1 / 61 + 1 / 62);
  assert.deepEqual(result[0].matchedBy, ['vector', 'keyword']);
  assert.equal(result[1].rrfScore, 1 / 62 + 1 / 61);
  assert.equal(fuseRankedResults([], [], {}).length, 0);
});

test('RRF drops duplicate IDs inside an input list and ranks only unique chunks', () => {
  const result = fuseRankedResults([{ id: 'x' }, { id: 'x' }, { id: 'y' }], [], { limit: 10 });
  assert.equal(result.length, 2); assert.equal(result[0].vectorRank, 1); assert.equal(result[1].vectorRank, 3);
});

test('vector and keyword queries scope by repository and parsing job with parameterized inputs', async () => {
  const calls = [];
  const prisma = {
    $queryRaw(strings, ...values) { calls.push({ sql: strings.join('?'), values }); return Promise.resolve([]); }
  };
  await vectorSearch({ prisma, repositoryId: 'repo', parsingJobId: 'parse', model: 'model', dimensions: 1024, vector: vector(), limit: 20 });
  await keywordSearch({ prisma, repositoryId: 'repo', parsingJobId: 'parse', query: "'; DROP TABLE CodeChunk; --", limit: 20 });
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /parsingJobId/); assert.ok(calls[0].values.includes('repo'));
  assert.match(calls[1].sql, /websearch_to_tsquery/); assert.ok(calls[1].values.includes("'; DROP TABLE CodeChunk; --"));
});
