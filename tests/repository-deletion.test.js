import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deleteRepositoryForUser } from '../src/services/repository-deletion.service.js';
import { createRepositoryController } from '../src/controllers/repository.controller.js';
import { createIndexingProcessor } from '../src/services/indexing-worker.service.js';
import { createParsingProcessor } from '../src/services/parsing-job.service.js';
import { createEmbeddingProcessor } from '../src/services/embedding-job.service.js';

const userId = '2467b15f-0908-4810-965c-baf00bf41812';
const otherUserId = 'a467b15f-0908-4810-965c-baf00bf41812';
const repositoryId = 'a295e921-e353-4718-8405-9dc060622017';
const indexingId = '84fef64d-aeb8-43ec-a8db-5f84dba56388';
const storedPath = `repositories/${repositoryId}/${indexingId}`;

function database({ imports = 1, owner = userId, pathValue = null, data = {} } = {}) {
  const state = { imports, marker: null, deleted: false, detached: false, data, pathValue };
  const tx = {
    $queryRawUnsafe: async () => [],
    repositoryImport: {
      findFirst: async () => owner === userId ? { repository: { id: repositoryId, deletionRequestedAt: state.marker, retainedStoragePath: state.pathValue } } : null,
      count: async () => state.imports,
      delete: async () => { state.imports--; state.detached = true; }
    },
    repository: {
      findUnique: async () => ({ id: repositoryId, deletionRequestedAt: state.marker, retainedStoragePath: state.pathValue }),
      update: async ({ data: update }) => { state.marker = update.deletionRequestedAt; },
      deleteMany: async () => { if (state.marker) { state.deleted = true; state.data = {}; return { count: 1 }; } return { count: 0 }; }
    },
    indexingJob: { findMany: async () => [{ bullmqJobId: 'indexing-job' }] },
    parsingJob: { findMany: async () => [{ bullmqJobId: 'parsing-job' }] },
    embeddingJob: { findMany: async () => [{ bullmqJobId: 'embedding-job' }] }
  };
  return { state, tx, prisma: { $transaction: async (fn) => fn(tx) } };
}

test('deleting one of several imports detaches only that user and preserves shared processing data', async () => {
  const { prisma, state } = database({ imports: 2, data: { chunks: 3, embeddings: 3 } });
  const result = await deleteRepositoryForUser({ prisma, repositoryId, userId, queues: [] });
  assert.deepEqual(result, { deleted: false, detached: true });
  assert.equal(state.imports, 1);
  assert.equal(state.deleted, false);
  assert.deepEqual(state.data, { chunks: 3, embeddings: 3 });
});

test('rejects an import not owned by the authenticated user', async () => {
  const { prisma } = database({ owner: otherUserId });
  await assert.rejects(deleteRepositoryForUser({ prisma, repositoryId, userId: 'not-owner' }), { code: 'REPOSITORY_NOT_FOUND' });
});

test('last-owner deletion removes queued jobs, clone storage, and cascaded repository data', async (t) => {
  const storageDir = await mkdtemp(path.join(os.tmpdir(), 'codecompass-delete-test-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  const clone = path.join(storageDir, storedPath);
  await mkdir(clone, { recursive: true });
  await writeFile(path.join(clone, 'README.md'), 'repository data');
  const { prisma, state } = database({ pathValue: storedPath, data: { files: 2, chunks: 4, embeddings: 4 } });
  const removed = [];
  const queues = ['indexing-job', 'parsing-job', 'embedding-job'].map((id) => ({
    getJob: async (jobId) => ({ getState: async () => 'waiting', remove: async () => removed.push(jobId) })
  }));
  const result = await deleteRepositoryForUser({ prisma, repositoryId, userId, queues, storageDir });
  assert.deepEqual(result, { deleted: true, detached: false });
  assert.deepEqual(removed, ['indexing-job', 'parsing-job', 'embedding-job']);
  await assert.rejects(readFile(path.join(clone, 'README.md')));
  assert.equal(state.deleted, true);
  assert.deepEqual(state.data, {});
});

test('controller preserves not-found errors and returns successful deletion contract', async () => {
  const { prisma } = database();
  const controller = createRepositoryController({ prisma });
  let responseBody;
  const res = { json(body) { responseBody = body; } };
  await controller.remove({ params: { repositoryId }, auth: { userId } }, res, (error) => { throw error; });
  assert.deepEqual(responseBody, { success: true, deleted: true, detached: false });
});

test('a database cleanup failure leaves the deletion marker for safe retry and returns a clear API error', async () => {
  const { prisma, tx, state } = database();
  tx.repository.deleteMany = async () => { throw new Error('database unavailable'); };
  await assert.rejects(deleteRepositoryForUser({ prisma, repositoryId, userId }), { code: 'REPOSITORY_DELETE_INCOMPLETE', status: 503 });
  assert.ok(state.marker instanceof Date);
  assert.equal(state.deleted, false);
});

test('indexing, parsing, and embedding workers stop when deletion has been requested', async () => {
  const indexingProcessor = createIndexingProcessor({
    prisma: { indexingJob: { findUnique: async () => ({ id: 'index-job', repository: { deletionRequestedAt: new Date() } }) } },
    indexingConfig: {}
  });
  await indexingProcessor({ data: { indexingJobId: 'index-job' } });

  const parsingProcessor = createParsingProcessor({
    prisma: { parsingJob: { findUnique: async () => ({ id: 'parse-job', status: 'queued', repository: { deletionRequestedAt: new Date() } }) } },
    indexingConfig: {}
  });
  await parsingProcessor({ data: { parsingJobId: 'parse-job' } });

  const embeddingProcessor = createEmbeddingProcessor({
    prisma: {
      embeddingJob: { findUnique: async () => ({ id: 'embedding-job', repositoryId, parsingJobId: 'parse-job', status: 'queued' }), update: async () => { throw new Error('should not update a deleting job'); } },
      repository: { findUnique: async () => ({ deletionRequestedAt: new Date() }) }
    },
    embeddingService: {}, config: { embedding: {} }
  });
  await embeddingProcessor({ data: { embeddingJobId: 'embedding-job' } });
});
