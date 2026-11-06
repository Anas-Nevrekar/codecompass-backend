import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareEvidence, buildRagPrompt, RAG_SYSTEM_INSTRUCTION, validateAnswer, citationsFromStream } from '../src/services/rag-context.service.js';
import { createGeminiLlmService } from '../src/services/gemini-llm.service.js';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { validateEnv } from '../src/config/env.js';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/session.js';

const rows = [
  { chunkId: 'trusted-chunk', filePath: 'src/auth.js', language: 'javascript', structureType: 'function', symbolName: 'login', startLine: 3, endLine: 7, sourceCode: 'function login() {\n  return true;\n}' },
  { chunkId: 'other-chunk', filePath: '../private.js', startLine: 1, endLine: 2, sourceCode: 'const secret = false;' }
];
const userId = '11111111-1111-4111-8111-111111111111';
const repositoryId = '22222222-2222-4222-8222-222222222222';
const secret = 'test-secret-that-is-long-enough-to-pass';
const apiConfig = validateEnv({ NODE_ENV: 'test', SESSION_SECRET: secret });
const resultChunk = { chunkId: rows[0].chunkId, filePath: rows[0].filePath, language: rows[0].language, structureType: rows[0].structureType, symbolName: rows[0].symbolName, startLine: rows[0].startLine, endLine: rows[0].endLine, sourceCode: rows[0].sourceCode };
function apiApp({ results = [resultChunk], llmService, config = apiConfig } = {}) {
  let query = 0;
  const prisma = {
    user: { findUnique: async () => ({ id: userId }) },
    repositoryImport: { findFirst: async () => ({ id: 'import' }) },
    parsingJob: { findFirst: async () => ({ id: 'parse' }) },
    codeEmbedding: { count: async () => 1 },
    $queryRaw() { query++; return Promise.resolve(query === 1 ? results.map((item) => ({ ...item, distance: 0.1 })) : results); }
  };
  return createApp({ prisma, config, embeddingService: { embedOne: async () => Array(1024).fill(0.1) }, llmService, nodeEnv: 'test' });
}
async function authCookie() { return `${SESSION_COOKIE}=${await createSessionToken(userId, secret)}`; }

test('context preserves source and trusted metadata and prioritizes ranked chunks under budget', () => {
  const context = prepareEvidence(rows, 100);
  assert.equal(context.evidence[0].evidenceId, 'S1');
  assert.equal(context.evidence[0].sourceCode, rows[0].sourceCode);
  assert.match(context.context, /Lines: 3-7/);
  const limited = prepareEvidence(rows, Math.ceil(context.context.split('\n\n')[0].length / 4));
  assert.equal(limited.evidence.length, 1);
  assert.equal(limited.evidence[0].chunkId, 'trusted-chunk');
});

test('prompt treats repository text as untrusted and asks for evidence-only claims', () => {
  const prompt = buildRagPrompt('Where is login?', prepareEvidence(rows, 100).context);
  assert.match(RAG_SYSTEM_INSTRUCTION, /only supplied evidence/i);
  assert.match(RAG_SYSTEM_INSTRUCTION, /untrusted data/i);
  assert.match(prompt, /Where is login/);
  assert.match(prompt, /\[S1\]/);
});

test('citation IDs in the answer map to trusted evidence in first-reference order and deduplicate', () => {
  const evidence = prepareEvidence(rows, 100).evidence;
  const second = { ...evidence[0], evidenceId: 'S2', chunkId: 'second-chunk', filePath: 'src/session.js', startLine: 20, endLine: 24 };
  const answer = validateAnswer({ answer: 'First [[S2]], then [S1], then [[S2]].', insufficientEvidence: false, citations: [
    { evidenceId: 'S2', explanation: 'Second source.' },
    { evidenceId: 'S1', filePath: '/forged', startLine: 1000, explanation: 'Valid.' },
    { evidenceId: 'S1', explanation: 'Duplicate' }
  ] }, [evidence[0], second]);
  assert.deepEqual(answer.citations.map(({ id }) => id), ['S2', 'S1']);
  assert.deepEqual(answer.citations.map(({ chunkId }) => chunkId), ['second-chunk', 'trusted-chunk']);
  assert.equal(answer.citations[0].filePath, 'src/session.js');
  assert.equal(answer.citations[0].startLine, 20);
  assert.equal(answer.citations[1].filePath, 'src/auth.js');
  assert.equal(answer.citations[1].startLine, 3);
});

test('missing model citations are reconstructed from known inline references; unknown IDs are rejected', () => {
  const evidence = prepareEvidence(rows, 100).evidence;
  const answer = validateAnswer({ answer: 'Login is [[S1]].', insufficientEvidence: false, citations: [] }, evidence);
  assert.deepEqual(answer.citations.map(({ id }) => id), ['S1']);
  assert.throws(() => validateAnswer({ answer: 'Login is [[S404]].', insufficientEvidence: false, citations: [] }, evidence), /unknown evidence/);
  assert.throws(() => validateAnswer({ answer: 'Login is present.', insufficientEvidence: false, citations: [{ evidenceId: 'S404' }] }, evidence), /unknown citation/);
  const modelSelectedSource = validateAnswer({ answer: 'Login is handled in the authentication controller.', insufficientEvidence: false, citations: [{ evidenceId: 'S1' }] }, evidence);
  assert.match(modelSelectedSource.answer, /\[\[S1\]\]/);
  assert.deepEqual(modelSelectedSource.citations.map(({ id }) => id), ['S1']);
});

test('a response without inline or model citations becomes insufficient evidence and malformed output is rejected', () => {
  const evidence = prepareEvidence(rows, 100).evidence;
  assert.equal(validateAnswer({ answer: 'Guess', insufficientEvidence: false, citations: [] }, evidence).insufficientEvidence, true);
  assert.throws(() => validateAnswer({ answer: 1 }, evidence), /Malformed/);
});

test('stream citations preserve valid IDs in first-reference order and reject unknown IDs', () => {
  const evidence = prepareEvidence(rows, 100).evidence;
  const citations = citationsFromStream('Uses [[S1]], [S1], then [[S1]].', evidence);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].chunkId, 'trusted-chunk');
  assert.throws(() => citationsFromStream('Uses [[S404]].', evidence), /unknown evidence/);
});

test('streaming and non-streaming validation produce the same source IDs for the same answer', () => {
  const evidence = prepareEvidence([
    resultChunk,
    { ...resultChunk, chunkId: 'second-chunk', filePath: 'src/session.js', startLine: 12, endLine: 15 }
  ], 1000).evidence;
  const answer = 'Session handling uses [S2], authentication uses [[S1]], and repeats [S2].';
  const nonStreaming = validateAnswer({ answer, insufficientEvidence: false, citations: [] }, evidence);
  const streaming = citationsFromStream(answer, evidence);
  assert.deepEqual(streaming.map(({ id }) => id), nonStreaming.citations.map(({ id }) => id));
});

test('citation IDs are scoped to each request evidence set', () => {
  const firstEvidence = prepareEvidence([resultChunk], 100).evidence;
  const secondEvidence = prepareEvidence([{ ...resultChunk, filePath: 'src/session.js', chunkId: 'new-chunk' }], 100).evidence;
  const first = validateAnswer({ answer: 'See [[S1]].', insufficientEvidence: false, citations: [] }, firstEvidence);
  const second = validateAnswer({ answer: 'See [[S1]].', insufficientEvidence: false, citations: [] }, secondEvidence);
  assert.equal(first.citations[0].filePath, 'src/auth.js');
  assert.equal(second.citations[0].filePath, 'src/session.js');
});

test('Gemini service uses configured model and structured JSON mode, and parses response', async () => {
  let request;
  const service = createGeminiLlmService({ config: { model: 'configured-model', maxOutputTokens: 200, requestTimeoutMs: 1000 }, client: { models: { async generateContent(value) { request = value; return { text: '{"answer":"yes","citations":[],"insufficientEvidence":true}' }; } } } });
  const result = await service.generateJson('prompt');
  assert.equal(request.model, 'configured-model');
  assert.equal(request.config.responseMimeType, 'application/json');
  assert.equal(result.answer, 'yes');
});

test('Gemini provider failures map to safe quota and malformed response errors', async () => {
  const rateLimited = createGeminiLlmService({ config: { model: 'm', maxOutputTokens: 10 }, client: { models: { async generateContent() { const error = new Error('secret provider detail'); error.status = 429; throw error; } } } });
  await assert.rejects(rateLimited.generateJson('p'), (error) => error.status === 429 && !error.message.includes('secret'));
  const malformed = createGeminiLlmService({ config: { model: 'm', maxOutputTokens: 10 }, client: { models: { async generateContent() { return { text: 'not json' }; } } } });
  await assert.rejects(malformed.generateJson('p'), (error) => error.code === 'LLM_INVALID_RESPONSE');
});

test('Gemini native stream yields provider text deltas', async () => {
  const service = createGeminiLlmService({ config: { model: 'm', maxOutputTokens: 10 }, client: { models: { async *generateContentStream() { yield { text: 'hello ' }; yield { text: 'world' }; } } } });
  const values = [];
  for await (const value of service.streamText('p')) values.push(value);
  assert.deepEqual(values, ['hello ', 'world']);
});

test('ask API requires authentication and validates question input', async () => {
  const app = apiApp({ llmService: { generateJson: async () => ({}) } });
  const unauthenticated = await request(app).post(`/api/repositories/${repositoryId}/ask`).set('Origin', apiConfig.frontendUrl).send({ question: 'Where?' });
  assert.equal(unauthenticated.status, 401);
  const invalid = await request(app).post(`/api/repositories/${repositoryId}/ask`).set('Cookie', await authCookie()).set('Origin', apiConfig.frontendUrl).send({ question: ' ' });
  assert.equal(invalid.status, 400);
});

test('ask API reuses repository-scoped hybrid results and returns validated citations', async () => {
  let generatedPrompt;
  const app = apiApp({ llmService: { generateJson: async (prompt) => { generatedPrompt = prompt; return { answer: 'Login is a function [[S1]].', insufficientEvidence: false, citations: [{ evidenceId: 'S1', filePath: '/forged', startLine: 100 }] }; } } });
  const response = await request(app).post(`/api/repositories/${repositoryId}/ask`).set('Cookie', await authCookie()).set('Origin', apiConfig.frontendUrl).send({ question: 'Where is login?' });
  assert.equal(response.status, 200);
  assert.match(generatedPrompt, /Where is login/);
  assert.equal(response.body.citations[0].filePath, 'src/auth.js');
  assert.equal(response.body.citations[0].startLine, 3);
  assert.equal(response.body.parsingJobId, 'parse');
});

test('ask API returns a trusted source for every inline citation even if Gemini omitted it from citations', async () => {
  const app = apiApp({ llmService: { generateJson: async () => ({ answer: 'Auth is handled in [[S1]].', insufficientEvidence: false, citations: [] }) } });
  const response = await request(app).post(`/api/repositories/${repositoryId}/ask`).set('Cookie', await authCookie()).set('Origin', apiConfig.frontendUrl).send({ question: 'Where is auth?' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.citations.map(({ id }) => id), ['S1']);
  assert.equal(response.body.citations[0].filePath, 'src/auth.js');
});

test('ask API rejects an unknown inline citation instead of returning a broken answer', async () => {
  const app = apiApp({ llmService: { generateJson: async () => ({ answer: 'Auth is in [[S404]].', insufficientEvidence: false, citations: [] }) } });
  const response = await request(app).post(`/api/repositories/${repositoryId}/ask`).set('Cookie', await authCookie()).set('Origin', apiConfig.frontendUrl).send({ question: 'Where is auth?' });
  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'LLM_INVALID_RESPONSE');
});

test('ask API returns insufficient evidence without calling Gemini when retrieval is empty', async () => {
  let called = false;
  const app = apiApp({ results: [], llmService: { generateJson: async () => { called = true; } } });
  const response = await request(app).post(`/api/repositories/${repositoryId}/ask`).set('Cookie', await authCookie()).set('Origin', apiConfig.frontendUrl).send({ question: 'Where?' });
  assert.equal(response.status, 200);
  assert.equal(response.body.insufficientEvidence, true);
  assert.deepEqual(response.body.citations, []);
  assert.equal(called, false);
});

test('ask API streams answer deltas and validated citations over SSE', async () => {
  const app = apiApp({ llmService: { async *streamText() { yield 'Login uses [[S1]].'; } } });
  const response = await request(app).post(`/api/repositories/${repositoryId}/ask`).set('Cookie', await authCookie()).set('Origin', apiConfig.frontendUrl).send({ question: 'Where?', stream: true });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/event-stream/);
  assert.match(response.text, /event: start/);
  assert.match(response.text, /event: token/);
  assert.match(response.text, /event: citations/);
  assert.match(response.text, /"filePath":"src\/auth.js"/);
  assert.match(response.text, /event: complete/);
});

test('ask API rejects unknown streaming citation IDs without completing the answer', async () => {
  const app = apiApp({ llmService: { async *streamText() { yield 'Auth is in [[S404]].'; } } });
  const response = await request(app).post(`/api/repositories/${repositoryId}/ask`).set('Cookie', await authCookie()).set('Origin', apiConfig.frontendUrl).send({ question: 'Where is auth?', stream: true });
  assert.equal(response.status, 200);
  assert.match(response.text, /event: error\ndata: \{"code":"LLM_INVALID_RESPONSE"/);
  assert.doesNotMatch(response.text, /event: citations/);
  assert.doesNotMatch(response.text, /event: complete/);
});

test('ask API retries a citationless stream with structured generation and replaces the partial answer', async () => {
  let fallbackPrompt = '';
  const app = apiApp({ llmService: {
    async *streamText() { yield 'Authentication uses a backend controller.'; },
    async generateJson(prompt) {
      fallbackPrompt = prompt;
      return { answer: 'Authentication is handled in the backend controller.', insufficientEvidence: false, citations: [{ evidenceId: 'S1', explanation: 'The controller implements auth.' }] };
    }
  } });
  const response = await request(app).post(`/api/repositories/${repositoryId}/ask`).set('Cookie', await authCookie()).set('Origin', apiConfig.frontendUrl).send({ question: 'Where is authentication handled?', stream: true });
  assert.equal(response.status, 200);
  assert.match(fallbackPrompt, /cite every repository-specific claim/i);
  assert.match(response.text, /event: answer\ndata: \{"answer":"Authentication is handled in the backend controller\. \[\[S1\]\]"\}/);
  assert.match(response.text, /event: citations/);
  assert.match(response.text, /"filePath":"src\/auth.js"/);
  assert.match(response.text, /event: complete/);
  assert.doesNotMatch(response.text, /"insufficientEvidence":true/);
});

test('ask API reports LLM timeouts as an SSE error instead of ending silently', async () => {
  const timeoutConfig = validateEnv({ NODE_ENV: 'test', SESSION_SECRET: secret, LLM_REQUEST_TIMEOUT_MS: '10' });
  const app = apiApp({
    config: timeoutConfig,
    llmService: {
      async *streamText(_prompt, signal) {
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
    }
  });
  const response = await request(app).post(`/api/repositories/${repositoryId}/ask`).set('Cookie', await authCookie()).set('Origin', timeoutConfig.frontendUrl).send({ question: 'Where?', stream: true });
  assert.equal(response.status, 200);
  assert.match(response.text, /event: start/);
  assert.match(response.text, /event: error\ndata: \{"code":"LLM_TIMEOUT".*"status":504\}/);
  assert.doesNotMatch(response.text, /event: complete/);
});

test('ask API logs sanitized original provider diagnostics for non-streaming failures', async () => {
  const apiKey = 'AIza_TEST_SECRET_12345678901234567890';
  const config = validateEnv({ NODE_ENV: 'test', SESSION_SECRET: secret, LLM_API_KEY: apiKey });
  const llmService = createGeminiLlmService({ config: config.llm, client: { models: { async generateContent() {
    const error = new Error(`Invalid API key ${apiKey}`);
    error.name = 'APIError';
    error.status = 401;
    error.code = 'UNAUTHENTICATED';
    error.response = { data: { error: { code: 401, status: 'UNAUTHENTICATED', message: `Invalid API key ${apiKey}` } } };
    throw error;
  } } } });
  const app = apiApp({ config, llmService });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  let response;
  try {
    response = await request(app).post(`/api/repositories/${repositoryId}/ask`).set('Cookie', await authCookie()).set('Origin', config.frontendUrl).send({ question: 'Where?' });
  } finally { console.warn = originalWarn; }
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'LLM_AUTHENTICATION_FAILED');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'RAG answer provider failed');
  assert.equal(warnings[0][1].category, 'authentication');
  assert.equal(warnings[0][1].name, 'APIError');
  assert.equal(warnings[0][1].code, 'UNAUTHENTICATED');
  assert.equal(warnings[0][1].status, 401);
  assert.match(warnings[0][1].providerResponse.error_status, /UNAUTHENTICATED/);
  assert.doesNotMatch(JSON.stringify(warnings), new RegExp(apiKey));
  assert.doesNotMatch(response.text, new RegExp(apiKey));
});

test('ask API logs sanitized original provider diagnostics for streaming failures', async () => {
  const providerFailure = Object.assign(new Error('Gemini quota exhausted for project'), {
    name: 'APIError', safe: true, status: 429, code: 'LLM_RATE_LIMITED', message: 'The answer provider is temporarily rate limited.',
    providerDiagnostics: { category: 'quota_or_rate_limit', name: 'APIError', message: 'Gemini quota exhausted for project', code: 'RESOURCE_EXHAUSTED', status: 429, response: { status: 'RESOURCE_EXHAUSTED' } }
  });
  const app = apiApp({ llmService: { async *streamText() { throw providerFailure; } } });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  let response;
  try {
    response = await request(app).post(`/api/repositories/${repositoryId}/ask`).set('Cookie', await authCookie()).set('Origin', apiConfig.frontendUrl).send({ question: 'Where?', stream: true });
  } finally { console.warn = originalWarn; }
  assert.equal(response.status, 200);
  assert.match(response.text, /event: error/);
  assert.match(response.text, /LLM_RATE_LIMITED/);
  assert.doesNotMatch(response.text, /RESOURCE_EXHAUSTED/);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'RAG answer provider failed');
  assert.equal(warnings[0][1].category, 'quota_or_rate_limit');
  assert.equal(warnings[0][1].message, 'Gemini quota exhausted for project');
  assert.equal(warnings[0][1].status, 429);
});
