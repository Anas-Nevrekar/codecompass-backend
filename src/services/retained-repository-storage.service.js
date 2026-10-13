import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIX = 'repositories';

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolveRepositoryStorageRoot(configuredPath = '') {
  const root = path.resolve(configuredPath || path.resolve(process.cwd(), '..', 'codecompass-repository-storage'));
  const applicationRoot = path.resolve(process.cwd());
  if (root === path.parse(root).root || root === path.resolve(os.homedir()) || isWithin(applicationRoot, root)) {
    throw new Error('INDEXING_REPOSITORY_STORAGE_DIR must be a dedicated directory outside the application directory');
  }
  return root;
}

export async function prepareRepositoryStorageRoot(configuredPath = '', tempDir = '') {
  const root = resolveRepositoryStorageRoot(configuredPath);
  const tempRoot = path.resolve(tempDir || path.join(os.tmpdir(), 'codecompass-indexing'));
  if (isWithin(root, tempRoot) || isWithin(tempRoot, root)) {
    throw new Error('Retained repository storage and temporary indexing storage must be separate');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const details = await lstat(root);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Repository storage root must be a real directory');
  const canonical = await realpath(root);
  if (canonical === path.parse(canonical).root || isWithin(path.resolve(process.cwd()), canonical)) {
    throw new Error('Repository storage root must be outside the application directory');
  }
  const canonicalTempRoot = await realpath(tempRoot).catch((error) => error.code === 'ENOENT' ? tempRoot : Promise.reject(error));
  if (isWithin(canonical, canonicalTempRoot) || isWithin(canonicalTempRoot, canonical)) {
    throw new Error('Retained repository storage and temporary indexing storage must be separate');
  }
  const repositoriesRoot = path.join(canonical, PREFIX);
  await mkdir(repositoriesRoot, { recursive: true, mode: 0o700 });
  const repositoriesDetails = await lstat(repositoriesRoot);
  if (!repositoriesDetails.isDirectory() || repositoriesDetails.isSymbolicLink() || !isWithin(canonical, await realpath(repositoriesRoot))) {
    throw new Error('Repository storage directory must remain within its configured root');
  }
  return canonical;
}

function relativeStoragePath(repositoryId, jobId) {
  if (!UUID.test(repositoryId) || !UUID.test(jobId)) throw new Error('Invalid internal repository or indexing job ID');
  return path.posix.join(PREFIX, repositoryId.toLowerCase(), jobId.toLowerCase());
}

function resolveStoredPath(root, storedPath) {
  if (typeof storedPath !== 'string') return null;
  const parts = storedPath.split(/[\\/]/);
  if (parts.length !== 3 || parts[0] !== PREFIX || !UUID.test(parts[1]) || !UUID.test(parts[2])) return null;
  const resolved = path.resolve(root, ...parts);
  return isWithin(root, resolved) && resolved !== root ? resolved : null;
}

function activeMarker(candidate) {
  return path.join(path.dirname(candidate), `.${path.basename(candidate)}.active`);
}

export async function prepareRetainedClone({ storageDir, repositoryId, indexingJobId, sourceDirectory }) {
  const root = await prepareRepositoryStorageRoot(storageDir);
  const storagePath = relativeStoragePath(repositoryId, indexingJobId);
  const destination = resolveStoredPath(root, storagePath);
  const repositoryParent = path.dirname(destination);
  await mkdir(repositoryParent, { recursive: true, mode: 0o700 });
  const parentDetails = await lstat(repositoryParent);
  if (!parentDetails.isDirectory() || parentDetails.isSymbolicLink()) throw new Error('Repository storage path is not a real directory');
  const parentCanonical = await realpath(repositoryParent);
  if (!isWithin(root, parentCanonical)) throw new Error('Repository storage path escaped its configured root');
  await rm(destination, { recursive: true, force: true });
  try {
    await rename(sourceDirectory, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await cp(sourceDirectory, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
    await rm(sourceDirectory, { recursive: true, force: true });
  }
  await writeFile(activeMarker(destination), `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  return { storagePath, absolutePath: destination };
}

export async function removeRetainedClone({ storageDir, storagePath }) {
  const root = await prepareRepositoryStorageRoot(storageDir);
  const candidate = resolveStoredPath(root, storagePath);
  if (!candidate) return false;
  const parent = await realpath(path.dirname(candidate)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!parent || !isWithin(root, parent)) return false;
  const details = await lstat(candidate).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!details) return false;
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Refusing to remove a non-directory retained clone');
  await rm(candidate, { recursive: true, force: true });
  await unlink(activeMarker(candidate)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  return true;
}

export async function finalizeRetainedClone({ storageDir, storagePath, previousStoragePath }) {
  const root = await prepareRepositoryStorageRoot(storageDir);
  const current = resolveStoredPath(root, storagePath);
  if (!current) throw new Error('Invalid retained repository storage reference');
  await unlink(activeMarker(current)).catch(() => console.error('Could not clear retained repository activity marker'));
  if (previousStoragePath && previousStoragePath !== storagePath) {
    try { await removeRetainedClone({ storageDir, storagePath: previousStoragePath }); }
    catch { console.error('Could not remove a superseded retained repository clone'); }
  }
}

export async function cleanUnreferencedRetainedClones({ prisma, storageDir, staleAgeMs, now = Date.now() }) {
  const root = await prepareRepositoryStorageRoot(storageDir);
  const currentPaths = await prisma.repository.findMany({
    where: { retainedStoragePath: { not: null } }, select: { retainedStoragePath: true }
  });
  const current = new Set(currentPaths.map((row) => row.retainedStoragePath));
  const repositoriesRoot = path.join(root, PREFIX);
  let removed = 0;
  for (const repositoryEntry of await readdir(repositoriesRoot, { withFileTypes: true })) {
    if (!repositoryEntry.isDirectory() || repositoryEntry.isSymbolicLink() || !UUID.test(repositoryEntry.name)) continue;
    const repositoryPath = path.join(repositoriesRoot, repositoryEntry.name);
    for (const cloneEntry of await readdir(repositoryPath, { withFileTypes: true })) {
      if (!cloneEntry.isDirectory() || cloneEntry.isSymbolicLink() || !UUID.test(cloneEntry.name)) continue;
      const storedPath = path.posix.join(PREFIX, repositoryEntry.name, cloneEntry.name);
      if (current.has(storedPath)) continue;
      const candidate = path.join(repositoryPath, cloneEntry.name);
      const details = await lstat(candidate);
      if (now - details.mtimeMs < staleAgeMs) continue;
      try {
        const ownerPid = Number((await readFile(activeMarker(candidate), 'utf8')).trim());
        if (Number.isInteger(ownerPid) && ownerPid > 0) {
          try { process.kill(ownerPid, 0); continue; }
          catch (error) { if (error.code === 'EPERM') continue; }
        }
      } catch { /* Marker absent or unreadable; age and database reference checks still apply. */ }
      await removeRetainedClone({ storageDir: root, storagePath: storedPath });
      removed += 1;
    }
  }
  return removed;
}
