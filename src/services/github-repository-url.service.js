import { HttpError } from '../lib/http-error.js';

const OWNER_PATTERN = /^(?:[A-Za-z0-9]|[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,37}[A-Za-z0-9])$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export function parsePublicGitHubRepositoryUrl(input) {
  
  const invalid = () => new HttpError(400, 'INVALID_REPOSITORY_URL', 'Provide a valid public GitHub repository URL.');

  if (typeof input !== 'string' || input.length > 2048 || input !== input.trim() || input.includes('?') || input.includes('#') || input.includes('%')) {
    throw invalid();
  }
  let url;
  
  try { 
    url = new URL(input); 
  } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash) {
    throw invalid();
  }
  
  const match = /^\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) throw invalid();
  const owner = match[1];
  let repository = match[2];
  if (repository.endsWith('.git')) repository = repository.slice(0, -4);
  if (!OWNER_PATTERN.test(owner) || !REPOSITORY_PATTERN.test(repository) || repository === '.' || repository === '..') {
    throw invalid();
  }
  return {
    owner,
    repository,
    canonicalUrl: `https://github.com/${owner}/${repository}`
  };
}

export const isValidGitHubOwner = (value) => typeof value === 'string' && OWNER_PATTERN.test(value);
export const isValidGitHubRepositoryName = (value) => typeof value === 'string' && REPOSITORY_PATTERN.test(value) && value !== '.' && value !== '..';
