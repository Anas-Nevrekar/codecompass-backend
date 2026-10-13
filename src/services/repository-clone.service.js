import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isValidGitHubOwner, isValidGitHubRepositoryName } from './github-repository-url.service.js';

const TEMP_PREFIX = 'codecompass-index-';
const activeDirectories = new Set();

export class IndexingError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'IndexingError';
    this.code = code;
    this.retryable = retryable;
  }
}

function assertSafeTempRoot(tempRoot) {
  const applicationRoot = path.resolve(process.cwd());
  const relative = path.relative(applicationRoot, tempRoot);
  const tempToApplication = path.relative(tempRoot, applicationRoot);
  if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) ||
      !tempToApplication.startsWith(`..${path.sep}`) || tempRoot === path.parse(tempRoot).root ||
      tempRoot === path.resolve(os.homedir())) {
    throw new Error('INDEXING_TEMP_DIR must be outside the application directory');
  }
}

export function resolveIndexingTempRoot(configuredPath = '') {
  const tempRoot = path.resolve(configuredPath || path.join(os.tmpdir(), 'codecompass-indexing'));
  assertSafeTempRoot(tempRoot);
  return tempRoot;
}

async function ensureTempRoot(tempRoot) {
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const details = await lstat(tempRoot);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Indexing temporary root must be a real directory');
  const canonicalRoot = await realpath(tempRoot);
  assertSafeTempRoot(canonicalRoot);
  return canonicalRoot;
}

export async function prepareIndexingTempRoot(configuredPath = '') {
  return ensureTempRoot(resolveIndexingTempRoot(configuredPath));
}

export async function measureDirectoryBytes(directory) {
  let total = 0;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) total += await measureDirectoryBytes(fullPath);
      else if (entry.isFile()) total += (await lstat(fullPath)).size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return total;
}

function stopProcess(child) {
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* The process may already have exited. */ }
  }
  const killTimer = setTimeout(() => {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch { /* The process may already have exited. */ }
  }, 1500);
  killTimer.unref();
  return killTimer;
}

function runGitClone({ repositoryUrl, destination, timeoutMs, maxRepositorySizeBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth', '1', '--no-tags', '--', repositoryUrl, destination], {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: process.platform !== 'win32',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    let settled = false;
    let checkingSize = false;
    let abortError = null;
    let killTimer;
    let stderr = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearInterval(sizeTimer);
      clearTimeout(killTimer);
      if (error) reject(error);
      else resolve(value);
    };
    child.stderr.on('data', (chunk) => { if (stderr.length < 2000) stderr += chunk.toString().slice(0, 2000 - stderr.length); });
    child.once('error', (error) => finish(new IndexingError(
      error.code === 'ENOENT' ? 'GIT_NOT_INSTALLED' : 'CLONE_FAILED',
      error.code === 'ENOENT' ? 'Git is not installed in the worker environment.' : 'Git could not start the repository clone.',
      { retryable: error.code !== 'ENOENT' }
    )));
    child.once('close', (code, signal) => {
      if (settled) return;
      if (abortError) return finish(abortError);
      if (code === 0) finish(null);
      else {
        const output = stderr.toLowerCase();
        const unavailable = output.includes('repository not found') || output.includes('does not exist');
        finish(new IndexingError(
          unavailable ? 'REPOSITORY_UNAVAILABLE' : 'CLONE_FAILED',
          unavailable ? 'The repository is no longer publicly accessible.' : 'The public repository could not be cloned.',
          { retryable: !unavailable }
        ));
      }
    });

    const timeoutTimer = setTimeout(() => {
      abortError = new IndexingError('CLONE_TIMEOUT', 'Repository cloning exceeded the configured time limit.', { retryable: true });
      killTimer = stopProcess(child);
    }, timeoutMs);
    const sizeTimer = setInterval(async () => {
      if (checkingSize || settled || abortError) return;
      checkingSize = true;
      try {
        const currentSize = await measureDirectoryBytes(destination);
        if (settled || abortError) return;
        if (currentSize > maxRepositorySizeBytes) {
          abortError = new IndexingError('REPOSITORY_SIZE_LIMIT_EXCEEDED', 'Repository checkout exceeds the configured size limit.');
          killTimer = stopProcess(child);
        }
      } catch {
        // The destination can briefly disappear while git is creating it; the final check handles lasting errors.
      } finally { checkingSize = false; }
    }, 1500);
    sizeTimer.unref();
  });
}

function getCommitSha(repositoryDirectory) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repositoryDirectory, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', () => reject(new IndexingError('CLONE_FAILED', 'Could not read the cloned commit.', { retryable: true })));
    child.once('close', (code) => {
      const sha = output.trim();
      if (code === 0 && /^[a-f0-9]{40,64}$/i.test(sha)) resolve(sha);
      else reject(new IndexingError('CLONE_FAILED', 'Could not read the cloned commit.', { retryable: true }));
    });
  });
}

export async function withClonedRepository({ repository, indexingConfig, work }) {
  if (repository.visibility !== 'public' || !isValidGitHubOwner(repository.owner) || !isValidGitHubRepositoryName(repository.name)) {
    throw new IndexingError('INVALID_REPOSITORY_METADATA', 'Stored repository metadata is not valid for public cloning.');
  }
  const tempRoot = await prepareIndexingTempRoot(indexingConfig.tempDir);
  const jobDirectory = await mkdtemp(path.join(tempRoot, TEMP_PREFIX));
  activeDirectories.add(jobDirectory);
  try {
    await writeFile(path.join(jobDirectory, '.active'), `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    const repositoryDirectory = path.join(jobDirectory, 'repository');
    const repositoryUrl = `https://github.com/${repository.owner}/${repository.name}.git`;
    await runGitClone({
      repositoryUrl,
      destination: repositoryDirectory,
      timeoutMs: indexingConfig.cloneTimeoutMs,
      maxRepositorySizeBytes: indexingConfig.maxRepositorySizeBytes
    });
    const checkoutSize = await measureDirectoryBytes(repositoryDirectory);
    if (checkoutSize > indexingConfig.maxRepositorySizeBytes) {
      throw new IndexingError('REPOSITORY_SIZE_LIMIT_EXCEEDED', 'Repository checkout exceeds the configured size limit.');
    }
    const commitSha = await getCommitSha(repositoryDirectory);
    return await work({ repositoryDirectory, commitSha, checkoutSize });
  } catch (error) {
    if (error instanceof IndexingError) throw error;
    throw new IndexingError('FILESYSTEM_ERROR', 'Repository indexing could not access its temporary files.', { retryable: true });
  } finally {
    try { await safeRemoveJobDirectory(tempRoot, jobDirectory); }
    catch { console.error('Could not clean an indexing temporary directory'); }
  }
}

async function safeRemoveJobDirectory(tempRoot, jobDirectory) {
  const parent = await realpath(tempRoot);
  const candidate = path.resolve(jobDirectory);
  if (path.dirname(candidate) !== parent || !path.basename(candidate).startsWith(TEMP_PREFIX)) {
    throw new Error('Refusing to remove a path outside the indexing temporary root');
  }
  const details = await lstat(candidate);
  if (details.isDirectory() && !details.isSymbolicLink()) await rm(candidate, { recursive: true, force: true });
  activeDirectories.delete(candidate);
}

export async function cleanStaleIndexingDirectories({ tempDir, staleAgeMs, now = Date.now() }) {
  const configuredRoot = resolveIndexingTempRoot(tempDir);
  let root;
  try { root = await ensureTempRoot(configuredRoot); }
  catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith(TEMP_PREFIX)) continue;
    const candidate = path.resolve(root, entry.name);
    if (path.dirname(candidate) !== root || activeDirectories.has(candidate)) continue;
    try {
      const details = await lstat(candidate);
      if (!details.isDirectory() || details.isSymbolicLink() || now - details.mtimeMs < staleAgeMs) continue;
      try {
        const ownerPid = Number((await readFile(path.join(candidate, '.active'), 'utf8')).trim());
        if (Number.isInteger(ownerPid) && ownerPid > 0) {
          try { process.kill(ownerPid, 0); continue; }
          catch (error) { if (error.code === 'EPERM') continue; }
        }
      } catch { /* A missing marker identifies a directory left before cloning began. */ }
      await rm(candidate, { recursive: true, force: true });
      removed += 1;
    } catch { console.error('Could not remove a stale indexing temporary directory'); }
  }
  return removed;
}
