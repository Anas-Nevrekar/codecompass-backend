import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { advanceRepositoryPipeline } from '../src/services/processing-pipeline.service.js';

const repositoryId = 'a295e921-e353-4718-8405-9dc060622017';
const indexingJobId = '6d8b8074-f58a-4be7-99a2-f875439fd6e5';
const parsingJobId = '4d1d0bc4-75df-4cd2-a4c1-9d6601a1138b';
const userId = '2467b15f-0908-4810-965c-baf00bf41812';

test('successful indexing automatically queues parsing against its retained clone', async (t) => {
  const storageDir = await mkdtemp(path.join(os.tmpdir(), 'codecompass-pipeline-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  await mkdir(path.join(storageDir, 'repositories', repositoryId, indexingJobId), { recursive: true });
  const calls = [];
  let createdParsingJob;
  const prisma = {
    indexingJob: { findUnique: async () => ({ id: indexingJobId, repositoryId, userId, status: 'completed' }), findFirst: async () => ({ id: indexingJobId }) },
    repositoryImport: { findFirst: async () => ({ repository: { retainedStoragePath: 'repositories/' + repositoryId + '/' + indexingJobId } }) },
    parsingJob: { findFirst: async () => null, create: async ({ data }) => { createdParsingJob = { ...data }; return { ...data, status: 'queued', bullmqJobId: 'parse-' + data.id }; } }
  };
  const parsingQueue = { add: async (...args) => calls.push(args) };
  await advanceRepositoryPipeline({ prisma, parsingQueue, indexingConfig: { repositoryStorageDir: storageDir }, indexingJobId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'parse-repository');
  assert.deepEqual(calls[0][1], { parsingJobId: createdParsingJob.id });
});

test('a failed index or partial parse does not start the next stage', async () => {
  let parseCalls = 0;
  const failedIndex = { indexingJob: { findUnique: async () => ({ repositoryId, userId, status: 'failed' }) } };
  await advanceRepositoryPipeline({ prisma: failedIndex, parsingQueue: { add: async () => { parseCalls++; } }, indexingJobId });
  assert.equal(parseCalls, 0);
  let embeddingCalls = 0;
  const partialParse = {
    parsingJob: { findUnique: async () => ({ repositoryId, status: 'completed_with_errors', failedFiles: 2 }) },
    repositoryImport: { findFirst: async () => ({ userId }) }
  };
  await advanceRepositoryPipeline({ prisma: partialParse, embeddingQueue: { add: async () => { embeddingCalls++; } }, parsingJobId, config: { embedding: { model: 'test' } } });
  assert.equal(embeddingCalls, 0);
});

test('successful parsing automatically queues embeddings for the same parsing snapshot', async () => {
  const calls = [];
  let createdEmbeddingJob;
  const prisma = {
    parsingJob: {
      findUnique: async () => ({ id: parsingJobId, repositoryId, status: 'completed', failedFiles: 0 }),
      findFirst: async () => ({ id: parsingJobId, repositoryId, status: 'completed', failedFiles: 0 })
    },
    repositoryImport: { findFirst: async () => ({ userId }) },
    embeddingJob: {
      findFirst: async () => null,
      create: async ({ data }) => { createdEmbeddingJob = { ...data }; return { ...data, status: 'queued', bullmqJobId: 'embed-' + data.id }; }
    }
  };
  const embeddingQueue = { add: async (...args) => calls.push(args) };
  await advanceRepositoryPipeline({ prisma, embeddingQueue, parsingJobId, config: { embedding: { model: 'test', dimensions: 1024 } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'embed-repository');
  assert.deepEqual(calls[0][1], { embeddingJobId: createdEmbeddingJob.id });
});
