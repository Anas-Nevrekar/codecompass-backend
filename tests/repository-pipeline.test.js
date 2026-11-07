import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepositoryController } from '../src/controllers/repository.controller.js';

const userId = '2467b15f-0908-4810-965c-baf00bf41812';
const repository = { id: 'a295e921-e353-4718-8405-9dc060622017', owner: 'owner', name: 'repository', fullName: 'owner/repository', htmlUrl: 'https://github.com/owner/repository' };
const metadata = { id: 123, full_name: 'owner/repository', name: 'repository', owner: { login: 'owner' }, private: false,
  html_url: repository.htmlUrl, description: null, default_branch: 'main', language: 'JavaScript',
  stargazers_count: 0, forks_count: 0, created_at: '2024-01-01T00:00:00.000Z' };

test('repository import automatically queues one idempotent indexing pipeline', async () => {
  let imported = false;
  let indexJob = null;
  const queueCalls = [];
  const prisma = {
    $transaction: async (work) => work({
      repository: { upsert: async () => repository },
      repositoryImport: { createMany: async () => { if (imported) return { count: 0 }; imported = true; return { count: 1 }; } }
    }),
    repositoryImport: { findFirst: async () => ({ repository }) },
    indexingJob: {
      findFirst: async () => indexJob,
      create: async ({ data }) => { indexJob = { ...data, status: 'queued', progress: 0, createdAt: new Date() }; return indexJob; }
    }
  };
  const controller = createRepositoryController({
    prisma, fetchImpl: async () => ({ ok: true, status: 200, json: async () => metadata }),
    indexingQueue: { add: async (...args) => queueCalls.push(args) }
  });
  async function invoke() {
    let responseCode = 200;
    let body;
    const response = { status(code) { responseCode = code; return this; }, json(value) { body = value; return this; } };
    await controller.import({ body: { url: repository.htmlUrl }, auth: { userId } }, response, (error) => { throw error; });
    return { responseCode, body };
  }
  const first = await invoke();
  assert.equal(first.responseCode, 201);
  assert.equal(first.body.processing.currentStage, 'indexing');
  assert.equal(queueCalls.length, 1);
  assert.equal(queueCalls[0][0], 'index-repository');
  const duplicate = await invoke();
  assert.equal(duplicate.responseCode, 200);
  assert.equal(duplicate.body.alreadyImported, true);
  assert.equal(queueCalls.length, 1);
});
