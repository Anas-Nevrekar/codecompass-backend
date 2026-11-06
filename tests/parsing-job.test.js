import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createParsingJob, finalizeParsingRun } from '../src/services/parsing-job.service.js';

const repositoryId = 'a295e921-e353-4718-8405-9dc060622017';
const indexingJobId = '6d8b8074-f58a-4be7-99a2-f875439fd6e5';

test('new parsing jobs are published to the parsing queue with their stable job ID', async (t) => {
  const storageDir = await mkdtemp(path.join(os.tmpdir(), 'codecompass-parsing-test-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  await mkdir(path.join(storageDir, 'repositories', repositoryId, indexingJobId), { recursive: true });

  const queueCalls = [];
  const job = {
    id: 'parse-job-id', repositoryId, status: 'queued', stage: 'queued', progress: 0,
    totalFiles: 0, processedFiles: 0, parsedFiles: 0, skippedFiles: 0,
    failedFiles: 0, totalChunks: 0, errorMessage: null, startedAt: null, completedAt: null,
    bullmqJobId: 'parse-parse-job-id'
  };
  const prisma = {
    repositoryImport: { findFirst: async () => ({ repository: { retainedStoragePath: `repositories/${repositoryId}/${indexingJobId}` } }) },
    indexingJob: { findFirst: async () => ({ id: indexingJobId }) },
    parsingJob: {
      findFirst: async () => null,
      create: async ({ data }) => ({ ...job, ...data })
    }
  };
  const queue = { add: async (...args) => { queueCalls.push(args); } };

  const result = await createParsingJob({
    prisma, queue, repositoryId, userId: 'user-id',
    indexingConfig: { repositoryStorageDir: storageDir }
  });

  assert.equal(result.job.status, 'queued');
  assert.equal(result.alreadyRunning, false);
  assert.equal(queueCalls.length, 1);
  assert.equal(queueCalls[0][0], 'parse-repository');
  assert.deepEqual(queueCalls[0][1], { parsingJobId: result.job.id });
  assert.deepEqual(queueCalls[0][2], {
    jobId: `parse-${result.job.id}`, attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 100, removeOnFail: 500
  });
});

test('a successful parse atomically replaces prior inventory results, while file failures preserve them', async () => {
  const job = { id: 'parse-new', repositoryId, indexingJobId };
  for (const failedFiles of [0, 1]) {
    const operations = [];
    const prisma = {
      async $transaction(work) {
        await work({
          parsingJob: { update: async ({ data }) => operations.push(['job', data.status]) },
          repositoryFile: { deleteMany: async ({ where }) => operations.push(['old-files', where]) }
        });
      }
    };
    await finalizeParsingRun({
      prisma, job, terminal: failedFiles ? 'completed_with_errors' : 'completed',
      parsedFiles: 2, skippedFiles: 0, failedFiles, processedFiles: 2, totalChunks: 3
    });
    assert.deepEqual(operations[0], ['job', failedFiles ? 'completed_with_errors' : 'completed']);
    if (failedFiles) assert.equal(operations.length, 1);
    else assert.deepEqual(operations[1], ['old-files', { repositoryId, indexingJobId: { not: indexingJobId } }]);
  }
});
