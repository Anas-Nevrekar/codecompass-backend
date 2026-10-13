import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/session.js';
import { validateEnv } from '../src/config/env.js';
import { createIndexingJob, recoverQueuedIndexingJobs } from '../src/services/indexing-job.service.js';
import { replaceRepositoryInventory } from '../src/services/repository-inventory.service.js';
import { createIndexingProcessor } from '../src/services/indexing-worker.service.js';
import { discoverRepositoryFiles } from '../src/services/repository-file-discovery.service.js';
import { cleanStaleIndexingDirectories, IndexingError, resolveIndexingTempRoot, withClonedRepository } from '../src/services/repository-clone.service.js';
import { cleanUnreferencedRetainedClones, finalizeRetainedClone, prepareRetainedClone, removeRetainedClone, resolveRepositoryStorageRoot } from '../src/services/retained-repository-storage.service.js';

process.env.NODE_ENV = 'test';

const userId = '8b81a6dc-818a-4c09-8e43-153dd0c14ab0';
const repositoryId = '4bcf1fd5-df1c-4da0-b495-e25a10f8b2cb';
const workerJobId = '3b942a20-8d10-4bbd-a4c7-287f8c15e401';
const secret = 'indexing-test-secret-with-at-least-32-bytes';

function memoryApi() {
  const jobs = new Map();
  const imported = {
    repositoryId,
    userId,
    repository: { id: repositoryId, owner: 'owner', name: 'repo', visibility: 'public' }
  };
  const prisma = {
    user: { async findUnique({ where }) { return where.id === userId ? { id: userId } : null; } },
    repositoryImport: {
      async findFirst({ where }) { return where.userId === userId && where.repositoryId === repositoryId ? imported : null; },
      async findMany() { return [{ ...imported, repository: { ...imported.repository, indexingJobs: [] } }]; }
    },
    indexingJob: {
      async findFirst({ where }) {
        if (where.id) return jobs.get(where.id) ?? null;
        return [...jobs.values()].find((job) => job.repositoryId === where.repositoryId && ['queued', 'cloning', 'filtering', 'saving_inventory'].includes(job.status)) ?? null;
      },
      async create({ data }) {
        if ([...jobs.values()].some((job) => job.activeRepositoryId === data.repositoryId)) {
          const error = new Error('unique'); error.code = 'P2002'; throw error;
        }
        const job = { ...data, progress: 0, discoveredFileCount: 0, eligibleFileCount: 0, excludedFileCount: 0, attemptCount: 0, maxAttempts: 3, errorCode: null, errorMessage: null, startedAt: null, completedAt: null, createdAt: new Date(), updatedAt: new Date() };
        jobs.set(job.id, job);
        return job;
      }
    },
    $transaction: async (fn) => fn(prisma)
  };
  return { prisma, jobs };
}

async function cookie() {
  return `${SESSION_COOKIE}=${await createSessionToken(userId, secret)}`;
}

async function withFakeGit(mode, work) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'cc-fake-git-'));
  const bin = path.join(parent, 'bin');
  const tempDir = path.join(parent, 'index-temp');
  await mkdir(bin);
  const fakeGit = `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);if(args[0]==='clone'){const destination=args.at(-1);fs.mkdirSync(path.join(destination,'.git'),{recursive:true});if(process.env.FAKE_GIT_MODE==='hang'){setInterval(()=>{},1000);}else if(process.env.FAKE_GIT_MODE==='fail'){process.exit(1);}else{fs.writeFileSync(path.join(destination,'README.md'),'ready');if(process.env.FAKE_GIT_MODE==='oversized')fs.writeFileSync(path.join(destination,'large.bin'),Buffer.alloc(4096));}}else if(args[0]==='-C'){process.stdout.write('${'a'.repeat(40)}\\n');}else{process.exit(2);}`;
  await writeFile(path.join(bin, 'git'), fakeGit);
  await chmod(path.join(bin, 'git'), 0o755);
  const oldPath = process.env.PATH;
  const oldMode = process.env.FAKE_GIT_MODE;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  process.env.FAKE_GIT_MODE = mode;
  try { return await work({ parent, tempDir }); }
  finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldMode === undefined) delete process.env.FAKE_GIT_MODE; else process.env.FAKE_GIT_MODE = oldMode;
    await rm(parent, { recursive: true, force: true });
  }
}

test('repository indexing request is authenticated, ownership checked, and queued asynchronously', async () => {
  const { prisma, jobs } = memoryApi();
  const enqueued = [];
  const app = createApp({
    prisma, redis: {}, indexingQueue: { add: async (...args) => enqueued.push(args) }, nodeEnv: 'test',
    config: { nodeEnv: 'test', frontendUrl: 'http://localhost:5173', sessionSecret: secret }
  });
  const unauthenticated = await request(app).post(`/api/repositories/${repositoryId}/index`).set('Origin', 'http://localhost:5173');
  assert.equal(unauthenticated.status, 401);
  const response = await request(app).post(`/api/repositories/${repositoryId}/index`).set('Origin', 'http://localhost:5173').set('Cookie', await cookie());
  assert.equal(response.status, 202);
  assert.equal(response.body.job.status, 'queued');
  assert.equal(jobs.size, 1);
  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0][1], { indexingJobId: response.body.job.id });
  const status = await request(app).get(`/api/indexing-jobs/${response.body.job.id}`).set('Cookie', await cookie());
  assert.equal(status.status, 200);
  assert.equal(status.body.job.status, 'queued');
  const repositoryStatus = await request(app).get(`/api/repositories/${repositoryId}/indexing-status`).set('Cookie', await cookie());
  assert.equal(repositoryStatus.status, 200);
  assert.equal(repositoryStatus.body.latestJob.id, response.body.job.id);
  assert.equal(Object.hasOwn(repositoryStatus.body, 'retainedStoragePath'), false);
  const repositoryList = await request(app).get('/api/repositories').set('Cookie', await cookie());
  assert.equal(repositoryList.status, 200);
  assert.equal(JSON.stringify(repositoryList.body).includes('retainedStoragePath'), false);
  assert.equal(JSON.stringify(repositoryList.body).includes('codecompass-repository-storage'), false);
  const repeated = await request(app).post(`/api/repositories/${repositoryId}/index`).set('Origin', 'http://localhost:5173').set('Cookie', await cookie());
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.alreadyRunning, true);
  assert.equal(jobs.size, 1);
  const forbidden = await request(app).post('/api/repositories/00000000-0000-4000-8000-000000000001/index').set('Origin', 'http://localhost:5173').set('Cookie', await cookie());
  assert.equal(forbidden.status, 404);
});

test('indexing environment defaults and bounds are validated', () => {
  const indexing = validateEnv({}).indexing;
  assert.equal(indexing.cloneTimeoutMs, 120000);
  assert.equal(indexing.maxRepositorySizeBytes, 500 * 1024 * 1024);
  assert.equal(indexing.maxFileSizeBytes, 2 * 1024 * 1024);
  assert.equal(indexing.workerConcurrency, 2);
  assert.throws(() => validateEnv({ INDEXING_WORKER_CONCURRENCY: '0' }), /INDEXING_WORKER_CONCURRENCY/);
  assert.throws(() => validateEnv({ INDEXING_CLONE_TIMEOUT_MS: 'n/a' }), /INDEXING_CLONE_TIMEOUT_MS/);
});

test('queue recovery re-enqueues missing jobs once and leaves jobs intact when Redis fails', async () => {
  const records = [
    { id: 'job-one', bullmqJobId: 'index-job-one', status: 'queued', updatedAt: new Date() },
    { id: 'job-two', bullmqJobId: 'index-job-two', status: 'queued', updatedAt: new Date() },
    { id: 'job-active', bullmqJobId: 'index-job-active', status: 'cloning', updatedAt: new Date() },
    { id: 'job-complete', bullmqJobId: 'index-job-complete', status: 'completed', updatedAt: new Date() }
  ];
  const prisma = { indexingJob: { async findMany({ where }) { return records.filter((job) => where.status.in.includes(job.status)); }, async updateMany() { throw new Error('not expected'); } } };
  const queued = new Map();
  queued.set('index-job-active', { async getState() { return 'active'; } });
  const queue = {
    async getJob(id) { return queued.get(id) ?? null; },
    async add(name, data, options) {
      if (!queued.has(options.jobId)) queued.set(options.jobId, { name, data, options, async getState() { return 'waiting'; } });
      return queued.get(options.jobId);
    }
  };
  assert.equal(await recoverQueuedIndexingJobs({ prisma, queue }), 2);
  assert.equal(await recoverQueuedIndexingJobs({ prisma, queue }), 0);
  assert.equal(queued.size, 3);
  assert.ok(!queued.has('index-job-complete'));
  const offlineQueue = { async getJob() { throw new Error('Redis offline'); } };
  await assert.rejects(recoverQueuedIndexingJobs({ prisma, queue: offlineQueue }), /Redis offline/);
  assert.equal(records[0].status, 'queued');
});

test('queue publication failure leaves the PostgreSQL job queued for recovery', async () => {
  const { prisma, jobs } = memoryApi();
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await createIndexingJob({ prisma, repositoryId, userId, indexingQueue: { async add() { throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }); } } });
    assert.equal(result.job.status, 'queued');
    assert.equal(jobs.size, 1);
  } finally { console.error = originalError; }
});

test('inventory replacement commits the latest files atomically and preserves the old inventory on failure', async () => {
  const state = {
    files: [{ repositoryId, indexingJobId: 'old-job', relativePath: 'old.js', extension: '.js', category: 'source', sizeBytes: 3n }],
    repository: { lastIndexedCommitSha: 'old-commit', lastIndexedFileCount: 1, retainedStoragePath: `repositories/${repositoryId}/84fef64d-aeb8-43ec-a8db-5f84dba56388` },
    job: { status: 'saving_inventory', progress: 90 }
  };
  let failInsert = false;
  const prisma = {
    async $transaction(work) {
      const working = structuredClone(state);
      const tx = {
        repositoryFile: {
          async deleteMany() { working.files = []; },
          async createMany({ data }) {
            if (failInsert) throw new Error('simulated insert failure');
            working.files.push(...data);
          }
        },
        repository: { async update({ data }) { Object.assign(working.repository, data); } },
        indexingJob: { async update({ data }) { Object.assign(working.job, data); } }
      };
      const result = await work(tx);
      Object.assign(state, working);
      return result;
    }
  };
  const files = [
    { relativePath: 'src/new.js', extension: '.js', category: 'source', sizeBytes: 12n },
    { relativePath: 'README.md', extension: '.md', category: 'documentation', sizeBytes: 4n }
  ];
  const counts = { discoveredFileCount: 3, eligibleFileCount: 2, excludedFileCount: 1 };
  const newStoragePath = `repositories/${repositoryId}/7168c9df-f906-4f00-af5b-19da0c0838af`;
  await replaceRepositoryInventory({ prisma, indexingJobId: 'new-job', repositoryId, files, counts, commitSha: 'new-commit', retainedStoragePath: newStoragePath });
  assert.deepEqual(state.files.map((file) => file.relativePath).sort(), ['README.md', 'src/new.js']);
  assert.ok(state.files.every((file) => !Object.hasOwn(file, 'contents')));
  assert.equal(state.repository.lastIndexedCommitSha, 'new-commit');
  assert.equal(state.repository.retainedStoragePath, newStoragePath);
  assert.equal(state.job.status, 'completed');
  assert.equal(state.job.progress, 100);

  const committedState = structuredClone(state);
  failInsert = true;
  await assert.rejects(replaceRepositoryInventory({ prisma, indexingJobId: 'failed-job', repositoryId, files, counts, commitSha: 'failed-commit' }), /simulated insert failure/);
  assert.deepEqual(state, committedState);
});

test('stale in-progress jobs are returned to the queue only after the reconciliation threshold', async () => {
  const staleJob = { id: 'stale-job', bullmqJobId: 'index-stale-job', status: 'cloning', attemptCount: 1, maxAttempts: 3, updatedAt: new Date(0) };
  const prisma = {
    indexingJob: {
      async findMany() { return [staleJob]; },
      async updateMany({ where, data }) {
        assert.equal(where.id, staleJob.id);
        Object.assign(staleJob, data);
        return { count: 1 };
      }
    }
  };
  let published = 0;
  const queue = { async getJob() { return null; }, async add() { published += 1; } };
  assert.equal(await recoverQueuedIndexingJobs({ prisma, queue, now: Date.now() }), 1);
  assert.equal(staleJob.status, 'queued');
  assert.equal(published, 1);
});

test('worker processor persists stages, counts, completion, and bounded retry or failure states', async (t) => {
  async function setup(makeCloneRepository, { persistFails = false, previousStoragePath = null } = {}) {
    const filesystemRoot = await mkdtemp(path.join(os.tmpdir(), 'cc-worker-retention-'));
    t.after(() => rm(filesystemRoot, { recursive: true, force: true }));
    const cloneRepository = makeCloneRepository(filesystemRoot);
    const state = {
      id: workerJobId, repositoryId, status: 'queued', attemptCount: 0, maxAttempts: 3,
      progress: 0, startedAt: null, errorCode: null, errorMessage: null,
      repository: { id: repositoryId, owner: 'owner', name: 'repo', visibility: 'public', retainedStoragePath: previousStoragePath }
    };
    const history = [];
    const prisma = {
      indexingJob: {
        async findUnique({ select }) { return select ? { progress: state.progress } : state; },
        async update({ data }) { Object.assign(state, data); history.push({ status: data.status, progress: state.progress }); return state; },
        async updateMany({ where, data }) {
          if (where.status?.notIn?.includes(state.status)) return { count: 0 };
          Object.assign(state, data); history.push({ status: data.status, progress: state.progress }); return { count: 1 };
        }
      }
    };
    const persisted = [];
    const processor = createIndexingProcessor({
      prisma,
      indexingConfig: { maxFileSizeBytes: 1024, repositoryStorageDir: path.join(filesystemRoot, 'retained') },
      cloneRepository,
      discoverFiles: async () => ({
        files: [{ relativePath: 'README.md', extension: '.md', category: 'documentation', sizeBytes: 4n }],
        discoveredFileCount: 2, eligibleFileCount: 1, excludedFileCount: 1
      }),
      persistInventory: async (input) => {
        if (persistFails) throw new Error('simulated inventory transaction failure');
        persisted.push(input);
        Object.assign(state, { status: 'completed', stage: 'completed', progress: 100, eligibleFileCount: input.counts.eligibleFileCount, completedAt: new Date() });
        state.repository.retainedStoragePath = input.retainedStoragePath;
        history.push({ status: state.status, progress: state.progress });
      },
      logger: { info() {}, warn() {} }
    });
    return { state, history, persisted, processor, filesystemRoot };
  }

  await t.test('successful indexing reaches completed at 100 percent with discovered counts', async () => {
    const context = await setup((root) => async ({ work }) => {
      const repositoryDirectory = path.join(root, 'temporary-repo');
      await mkdir(repositoryDirectory);
      await writeFile(path.join(repositoryDirectory, 'README.md'), 'source files stay on disk');
      return work({ repositoryDirectory, commitSha: 'c'.repeat(40) });
    });
    await context.processor({ data: { indexingJobId: workerJobId }, attemptsMade: 0 });
    assert.deepEqual(context.history.map((item) => item.status), ['cloning', 'filtering', 'saving_inventory', 'completed']);
    assert.equal(context.state.progress, 100);
    assert.equal(context.state.eligibleFileCount, 1);
    assert.equal(context.persisted[0].commitSha, 'c'.repeat(40));
    assert.match(context.persisted[0].retainedStoragePath, /^repositories\/[0-9a-f-]+\/[0-9a-f-]+$/);
    assert.equal(await readFile(path.join(context.filesystemRoot, 'retained', context.persisted[0].retainedStoragePath, 'README.md'), 'utf8'), 'source files stay on disk');
    assert.ok(context.history.every((item, index, list) => index === 0 || item.progress >= list[index - 1].progress));
    await rm(context.filesystemRoot, { recursive: true, force: true });
  });

  await t.test('transient failure is queued for a bounded retry, then exhausted safely', async () => {
    const context = await setup(() => async () => { throw new IndexingError('CLONE_TIMEOUT', 'Clone timed out.', { retryable: true }); });
    await assert.rejects(context.processor({ data: { indexingJobId: workerJobId }, attemptsMade: 0 }), /Clone timed out/);
    assert.equal(context.state.status, 'queued');
    assert.equal(context.state.attemptCount, 1);
    assert.ok(context.state.progress >= 10);

    await assert.rejects(context.processor({ data: { indexingJobId: workerJobId }, attemptsMade: 2 }));
    assert.equal(context.state.status, 'failed');
    assert.equal(context.state.errorCode, 'CLONE_TIMEOUT');
  });

  await t.test('permanent errors fail immediately without spending retry attempts', async () => {
    const context = await setup(() => async () => { throw new IndexingError('REPOSITORY_UNAVAILABLE', 'Repository is not public.'); });
    await assert.rejects(context.processor({ data: { indexingJobId: workerJobId }, attemptsMade: 0 }), (error) => error.name === 'UnrecoverableError');
    assert.equal(context.state.status, 'failed');
    assert.equal(context.state.errorCode, 'REPOSITORY_UNAVAILABLE');
    assert.equal(context.state.attemptCount, 1);
    await rm(context.filesystemRoot, { recursive: true, force: true });
  });

  await t.test('a failed clone creates no retained directory', async () => {
    const context = await setup(() => async () => { throw new IndexingError('CLONE_FAILED', 'Clone failed.', { retryable: true }); });
    await assert.rejects(context.processor({ data: { indexingJobId: workerJobId }, attemptsMade: 0 }));
    assert.equal(context.state.repository.retainedStoragePath, null);
    await assert.rejects(readdir(path.join(context.filesystemRoot, 'retained', 'repositories')), { code: 'ENOENT' });
  });

  await t.test('failed re-index persistence removes only the candidate and preserves the previous clone', async () => {
    const previousStoragePath = `repositories/${repositoryId}/a3d81555-1c25-4a16-b2dd-3812a09b2702`;
    const context = await setup((root) => async ({ work }) => {
      const repositoryDirectory = path.join(root, 'candidate');
      await mkdir(repositoryDirectory);
      await writeFile(path.join(repositoryDirectory, 'README.md'), 'replacement candidate');
      return work({ repositoryDirectory, commitSha: 'd'.repeat(40) });
    }, { persistFails: true, previousStoragePath });
    const previousDirectory = path.join(context.filesystemRoot, 'retained', previousStoragePath);
    await mkdir(previousDirectory, { recursive: true });
    await writeFile(path.join(previousDirectory, 'README.md'), 'previous clone');
    await assert.rejects(context.processor({ data: { indexingJobId: workerJobId }, attemptsMade: 0 }), (error) => error.code === 'INDEXING_FAILED' && error.retryable);
    assert.equal(context.state.repository.retainedStoragePath, previousStoragePath);
    assert.equal(await readFile(path.join(previousDirectory, 'README.md'), 'utf8'), 'previous clone');
    assert.deepEqual(await readdir(path.dirname(previousDirectory)), [path.basename(previousDirectory)]);
    await rm(context.filesystemRoot, { recursive: true, force: true });
  });
});

test('file discovery records only eligible relative paths and excludes symlinks, lockfiles, output, and oversized files', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'cc-index-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'repo');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app.ts'), 'source');
  await writeFile(path.join(root, 'README.md'), 'docs');
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  await writeFile(path.join(root, 'src', 'large.py'), '123456789');
  await writeFile(path.join(root, 'node_modules', 'pkg', 'ignored.js'), 'ignored');
  await writeFile(path.join(root, 'dist', 'bundle.min.js'), 'ignored');
  await symlink(path.join(parent, 'outside.ts'), path.join(root, 'src', 'linked.ts'));
  const inventory = await discoverRepositoryFiles(root, { maxFileSizeBytes: 8 });
  assert.deepEqual(inventory.files.map((file) => file.relativePath), ['README.md', 'src/app.ts']);
  assert.deepEqual(inventory.files.map((file) => [file.extension, file.category]), [['.md', 'documentation'], ['.ts', 'source']]);
  assert.ok(inventory.files.every((file) => typeof file.sizeBytes === 'bigint'));
  assert.equal(inventory.eligibleFileCount, 2);
  assert.ok(inventory.excludedFileCount >= 3);
  assert.ok(!Object.hasOwn(inventory.files[0], 'contents'));
});

test('clone runs with bounded resources, returns the commit, and cleans its temporary checkout', async () => {
  await withFakeGit('success', async ({ tempDir }) => {
    const result = await withClonedRepository({
      repository: { owner: 'owner', name: 'repo', visibility: 'public' },
      indexingConfig: { tempDir, cloneTimeoutMs: 1000, maxRepositorySizeBytes: 1024 },
      work: async ({ repositoryDirectory, commitSha, checkoutSize }) => ({ repositoryDirectory, commitSha, checkoutSize })
    });
    assert.equal(result.commitSha, 'a'.repeat(40));
    assert.ok(result.checkoutSize > 0);
    assert.deepEqual(await readdir(tempDir), []);
  });
});

test('clone timeout and checkout size limits fail safely and still clean temporary directories', async (t) => {
  await t.test('Git failure is classified as retryable', async () => {
    await withFakeGit('fail', async ({ tempDir }) => {
      await assert.rejects(withClonedRepository({
        repository: { owner: 'owner', name: 'repo', visibility: 'public' },
        indexingConfig: { tempDir, cloneTimeoutMs: 1000, maxRepositorySizeBytes: 1024 }, work: async () => {}
      }), (error) => error instanceof IndexingError && error.code === 'CLONE_FAILED' && error.retryable);
      assert.deepEqual(await readdir(tempDir), []);
    });
  });
  await t.test('timeout terminates the clone attempt', async () => {
    await withFakeGit('hang', async ({ tempDir }) => {
      await assert.rejects(withClonedRepository({
        repository: { owner: 'owner', name: 'repo', visibility: 'public' },
        indexingConfig: { tempDir, cloneTimeoutMs: 50, maxRepositorySizeBytes: 1024 }, work: async () => {}
      }), (error) => error instanceof IndexingError && error.code === 'CLONE_TIMEOUT');
      assert.deepEqual(await readdir(tempDir), []);
    });
  });
  await t.test('oversized checkout is rejected before inventory is handed off', async () => {
    await withFakeGit('oversized', async ({ tempDir }) => {
      await assert.rejects(withClonedRepository({
        repository: { owner: 'owner', name: 'repo', visibility: 'public' },
        indexingConfig: { tempDir, cloneTimeoutMs: 1000, maxRepositorySizeBytes: 512 }, work: async () => assert.fail('oversized checkout must not reach inventory')
      }), (error) => error instanceof IndexingError && error.code === 'REPOSITORY_SIZE_LIMIT_EXCEEDED');
      assert.deepEqual(await readdir(tempDir), []);
    });
  });
});

test('stale cleanup removes only old CodeCompass-owned child directories', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'cc-index-cleanup-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'temp-root');
  const stale = path.join(root, 'codecompass-index-stale');
  const active = path.join(root, 'codecompass-index-active');
  const fresh = path.join(root, 'codecompass-index-fresh');
  const unrelated = path.join(root, 'keep-me');
  await Promise.all([mkdir(stale, { recursive: true }), mkdir(active, { recursive: true }), mkdir(fresh, { recursive: true }), mkdir(unrelated, { recursive: true })]);
  await writeFile(path.join(active, '.active'), `${process.pid}\n`);
  const old = new Date(Date.now() - 5000);
  await Promise.all([utimes(stale, old, old), utimes(active, old, old)]);
  assert.equal(await cleanStaleIndexingDirectories({ tempDir: root, staleAgeMs: 1000 }), 1);
  const remaining = await readdir(root);
  assert.deepEqual(remaining.sort(), ['codecompass-index-active', 'codecompass-index-fresh', 'keep-me']);
  assert.throws(() => resolveIndexingTempRoot(process.cwd()), /outside the application directory/);
});

test('retained clones survive restart, failed replacement, and cleanup while successful replacement switches safely', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'cc-retained-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const storageDir = path.join(parent, 'persistent-repositories');
  const sourceV1 = path.join(parent, 'source-v1');
  await mkdir(sourceV1);
  await writeFile(path.join(sourceV1, 'app.js'), 'version one');
  const first = await prepareRetainedClone({ storageDir, repositoryId, indexingJobId: '84fef64d-aeb8-43ec-a8db-5f84dba56388', sourceDirectory: sourceV1 });
  let databaseRepository = { retainedStoragePath: first.storagePath, lastIndexedCommitSha: 'a'.repeat(40) };
  await finalizeRetainedClone({ storageDir, storagePath: first.storagePath });

  // A new helper invocation models a worker restart: the database's relative reference resolves to the same files.
  assert.equal(await readFile(path.join(resolveRepositoryStorageRoot(storageDir), databaseRepository.retainedStoragePath, 'app.js'), 'utf8'), 'version one');
  const sourceFailed = path.join(parent, 'source-failed');
  await mkdir(sourceFailed);
  await writeFile(path.join(sourceFailed, 'app.js'), 'failed candidate');
  const failed = await prepareRetainedClone({ storageDir, repositoryId, indexingJobId: '5f008150-b643-4e02-87ba-77b57073bf53', sourceDirectory: sourceFailed });
  await removeRetainedClone({ storageDir, storagePath: failed.storagePath });
  assert.equal(databaseRepository.retainedStoragePath, first.storagePath);
  assert.equal(await readFile(path.join(resolveRepositoryStorageRoot(storageDir), first.storagePath, 'app.js'), 'utf8'), 'version one');

  const sourceV2 = path.join(parent, 'source-v2');
  await mkdir(sourceV2);
  await writeFile(path.join(sourceV2, 'app.js'), 'version two');
  const second = await prepareRetainedClone({ storageDir, repositoryId, indexingJobId: '7168c9df-f906-4f00-af5b-19da0c0838af', sourceDirectory: sourceV2 });
  const txState = { files: [], repository: { ...databaseRepository }, job: {} };
  const prisma = {
    async $transaction(work) {
      const draft = structuredClone(txState);
      const tx = {
        repositoryFile: { async deleteMany() { draft.files = []; }, async createMany({ data }) { draft.files.push(...data); } },
        repository: { async update({ data }) { Object.assign(draft.repository, data); } },
        indexingJob: { async update({ data }) { Object.assign(draft.job, data); } }
      };
      await work(tx);
      Object.assign(txState, draft);
    },
    repository: { async findMany() { return [{ retainedStoragePath: txState.repository.retainedStoragePath }]; } }
  };
  await replaceRepositoryInventory({
    prisma, repositoryId, indexingJobId: '7168c9df-f906-4f00-af5b-19da0c0838af',
    files: [{ relativePath: 'app.js', extension: '.js', category: 'source', sizeBytes: 11n }],
    counts: { discoveredFileCount: 1, eligibleFileCount: 1, excludedFileCount: 0 },
    commitSha: 'b'.repeat(40), retainedStoragePath: second.storagePath
  });
  databaseRepository = txState.repository;
  await finalizeRetainedClone({ storageDir, storagePath: second.storagePath, previousStoragePath: first.storagePath });
  assert.equal(databaseRepository.lastIndexedCommitSha, 'b'.repeat(40));
  assert.equal(databaseRepository.retainedStoragePath, second.storagePath);
  assert.equal(txState.files[0].relativePath, 'app.js');
  assert.equal(await readFile(path.join(resolveRepositoryStorageRoot(storageDir), second.storagePath, 'app.js'), 'utf8'), 'version two');
  await assert.rejects(readFile(path.join(resolveRepositoryStorageRoot(storageDir), first.storagePath, 'app.js'), 'utf8'));
  assert.equal(await cleanUnreferencedRetainedClones({ prisma, storageDir, staleAgeMs: 0 }), 0);
  assert.throws(() => resolveRepositoryStorageRoot(process.cwd()), /outside the application directory/);

  const unsafeRoot = path.join(parent, 'unsafe-storage');
  const outside = path.join(parent, 'outside');
  await mkdir(unsafeRoot);
  await mkdir(outside);
  await symlink(outside, path.join(unsafeRoot, 'repositories'));
  await assert.rejects(prepareRetainedClone({
    storageDir: unsafeRoot, repositoryId, indexingJobId: 'b34e37a4-4a51-41e9-b017-3dbbdd9ef216', sourceDirectory: sourceV1
  }), /Repository storage directory must remain within its configured root/);
});
