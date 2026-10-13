import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const FILE_TYPES = new Map([
  ['.js', 'source'], ['.jsx', 'source'], ['.mjs', 'source'], ['.cjs', 'source'],
  ['.ts', 'source'], ['.tsx', 'source'], ['.mts', 'source'], ['.cts', 'source'],
  ['.py', 'source'], ['.json', 'configuration'], ['.html', 'markup'],
  ['.css', 'style'], ['.md', 'documentation'], ['.yml', 'configuration'],
  ['.yaml', 'configuration']
]);
const EXCLUDED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'vendor', '.venv', 'venv', 'env', '.tox', 'site-packages', '__pycache__',
  'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.cache', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.parcel-cache',
  'target', 'bin', 'obj', 'bower_components'
]);
const EXCLUDED_FILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lockb', 'composer.lock', 'cargo.lock', 'poetry.lock', 'pipfile.lock'
]);

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isGeneratedFile(name) {
  return /(?:\.min|\.bundle|\.generated|\.g)\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i.test(name) ||
    /(?:^|\.)generated\.(?:js|jsx|ts|tsx)$/i.test(name);
}

export async function discoverRepositoryFiles(repositoryRoot, { maxFileSizeBytes }) {
  const root = await realpath(repositoryRoot);
  const files = [];
  let discoveredFileCount = 0;
  let excludedFileCount = 0;

  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (!insideRoot(root, absolutePath)) continue;
      if (entry.isSymbolicLink()) {
        excludedFileCount += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      discoveredFileCount += 1;
      const extension = path.extname(entry.name).toLowerCase();
      const category = FILE_TYPES.get(extension);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      if (!category || EXCLUDED_FILES.has(entry.name.toLowerCase()) || isGeneratedFile(entry.name)) {
        excludedFileCount += 1;
        continue;
      }
      let details;
      try { details = await lstat(absolutePath); }
      catch { excludedFileCount += 1; continue; }
      if (!details.isFile() || details.isSymbolicLink() || details.size > maxFileSizeBytes) {
        excludedFileCount += 1;
        continue;
      }
      files.push({ relativePath, extension, category, sizeBytes: BigInt(details.size) });
    }
  }

  await walk(root);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { files, discoveredFileCount, eligibleFileCount: files.length, excludedFileCount };
}
