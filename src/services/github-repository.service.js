import { HttpError } from '../lib/http-error.js';
import { isValidGitHubOwner, isValidGitHubRepositoryName } from './github-repository-url.service.js';

const GITHUB_API_VERSION = '2022-11-28';

function upstreamUnavailable() {
  return new HttpError(503, 'GITHUB_UPSTREAM_UNAVAILABLE', 'GitHub is temporarily unavailable. Try again shortly.');
}

function invalidMetadata() {
  return new HttpError(502, 'GITHUB_UPSTREAM_ERROR', 'GitHub returned an unexpected repository response.');
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function normalizeGitHubRepository(data) {
  if (!data || typeof data !== 'object' || !Number.isSafeInteger(data.id) || data.id <= 0 ||
      !data.owner || typeof data.owner !== 'object' || !isValidGitHubOwner(data.owner.login) ||
      !isValidGitHubRepositoryName(data.name) || typeof data.private !== 'boolean' ||
      typeof data.html_url !== 'string' ||
      (data.description !== null && data.description !== undefined && typeof data.description !== 'string') ||
      (data.default_branch !== null && data.default_branch !== undefined && typeof data.default_branch !== 'string') ||
      (data.language !== null && data.language !== undefined && typeof data.language !== 'string') ||
      !nonNegativeInteger(data.stargazers_count) || !nonNegativeInteger(data.forks_count) ||
      typeof data.created_at !== 'string' || Number.isNaN(Date.parse(data.created_at))) {
    throw invalidMetadata();
  }
  if (data.private || (data.visibility !== undefined && data.visibility !== 'public')) {
    throw new HttpError(403, 'PRIVATE_REPOSITORY_UNSUPPORTED', 'Only public GitHub repositories can be imported.');
  }
  const fullName = `${data.owner.login}/${data.name}`;
  if (typeof data.full_name !== 'string' || data.full_name.toLowerCase() !== fullName.toLowerCase()) throw invalidMetadata();
  let htmlUrl;
  try { htmlUrl = new URL(data.html_url); } catch { throw invalidMetadata(); }
  if (htmlUrl.protocol !== 'https:' || htmlUrl.hostname !== 'github.com' || htmlUrl.username || htmlUrl.password ||
      htmlUrl.port || htmlUrl.search || htmlUrl.hash || htmlUrl.pathname.toLowerCase() !== `/${fullName}`.toLowerCase()) {
    throw invalidMetadata();
  }
  return {
    githubId: BigInt(data.id),
    owner: data.owner.login,
    name: data.name,
    fullName,
    htmlUrl: `https://github.com/${fullName}`,
    description: data.description ?? null,
    defaultBranch: data.default_branch ?? null,
    language: data.language ?? null,
    visibility: 'public',
    starsCount: data.stargazers_count,
    forksCount: data.forks_count,
    githubCreatedAt: new Date(data.created_at),
    metadataUpdatedAt: new Date()
  };
}

async function parseBody(response) {
  try { return await response.json(); } catch { throw invalidMetadata(); }
}

export async function fetchPublicRepository({ owner, repository, fetchImpl = globalThis.fetch }) {
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'CodeCompass',
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      },
      signal: AbortSignal.timeout(8000)
    });
  } catch { throw upstreamUnavailable(); }
  
  if (response.status === 404) {
    throw new HttpError(404, 'REPOSITORY_NOT_FOUND_OR_INACCESSIBLE', 'Repository was not found or is not publicly accessible.');
  }
  
  if (response.status === 429 || (response.status === 403 && response.headers?.get?.('x-ratelimit-remaining') === '0')) {
    throw new HttpError(429, 'GITHUB_API_RATE_LIMIT', 'GitHub API rate limit reached. Try again later.');
  }
  if (!response.ok) throw new HttpError(502, 'GITHUB_UPSTREAM_ERROR', 'GitHub could not provide repository metadata.');
  return normalizeGitHubRepository(await parseBody(response));
}

export async function importRepositoryForUser({ prisma, userId, metadata }) {
  return prisma.$transaction(async (tx) => {
    const repository = await tx.repository.upsert({
      where: { githubId: metadata.githubId },
      create: metadata,
      update: {
        owner: metadata.owner,
        name: metadata.name,
        fullName: metadata.fullName,
        htmlUrl: metadata.htmlUrl,
        description: metadata.description,
        defaultBranch: metadata.defaultBranch,
        language: metadata.language,
        visibility: metadata.visibility,
        starsCount: metadata.starsCount,
        forksCount: metadata.forksCount,
        githubCreatedAt: metadata.githubCreatedAt,
        metadataUpdatedAt: metadata.metadataUpdatedAt
      }
    });
    const insertion = await tx.repositoryImport.createMany({
      data: [{ userId, repositoryId: repository.id }],
      skipDuplicates: true
    });
    return { repository, alreadyImported: insertion.count === 0 };
  });
}

export async function listRepositoriesForUser(prisma, userId) {
  return prisma.repositoryImport.findMany({
    where: { userId },
    include: { repository: { include: { indexingJobs: { orderBy: { createdAt: 'desc' }, take: 1 } } } },
    orderBy: { importedAt: 'desc' }
  });
}
