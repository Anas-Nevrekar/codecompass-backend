import { HttpError } from '../lib/http-error.js';
import { isValidGitHubOwner } from './github-repository-url.service.js';

const GITHUB_API_VERSION = '2022-11-28';

function providerError() {
  return new HttpError(502, 'OAUTH_PROVIDER_ERROR', 'GitHub sign-in could not be completed. Try again.');
}

function isHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

export function normalizeGitHubProfile(profile) {
  if (!profile || typeof profile !== 'object' || !Number.isSafeInteger(profile.id) || profile.id <= 0 ||
      !isValidGitHubOwner(profile.login) ||
      (profile.name !== null && profile.name !== undefined && typeof profile.name !== 'string') ||
      !isHttpsUrl(profile.avatar_url) || typeof profile.html_url !== 'string') {
    throw providerError();
  }
  let profileUrl;
  try { profileUrl = new URL(profile.html_url); } catch { throw providerError(); }
  if (profileUrl.protocol !== 'https:' || profileUrl.hostname !== 'github.com' || profileUrl.username || profileUrl.password ||
      profileUrl.port || profileUrl.search || profileUrl.hash ||
      profileUrl.pathname.toLowerCase() !== `/${profile.login.toLowerCase()}`) {
    throw providerError();
  }
  return {
    githubId: BigInt(profile.id),
    githubUsername: profile.login,
    displayName: profile.name ?? null,
    avatarUrl: profile.avatar_url,
    profileUrl: `https://github.com/${profile.login}`
  };
}

async function parseJson(response) {
  try { return await response.json(); } catch { throw providerError(); }
}

export async function fetchGitHubProfile({ code, config, fetchImpl = globalThis.fetch }) {
  let tokenResponse;
  try {
    const response = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.githubClientId,
        client_secret: config.githubClientSecret,
        code,
        redirect_uri: config.githubCallbackUrl
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw providerError();
    tokenResponse = await parseJson(response);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw providerError();
  }
  if (typeof tokenResponse?.access_token !== 'string' || tokenResponse.access_token.length < 10 ||
      (tokenResponse.token_type && tokenResponse.token_type.toLowerCase() !== 'bearer') || tokenResponse.error) {
    throw providerError();
  }

  try {
    const response = await fetchImpl('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${tokenResponse.access_token}`,
        'User-Agent': 'CodeCompass',
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw providerError();
    return normalizeGitHubProfile(await parseJson(response));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw providerError();
  }
}

export async function upsertGitHubUser(prisma, profile) {
  return prisma.user.upsert({
    where: { githubId: profile.githubId },
    create: profile,
    update: {
      githubUsername: profile.githubUsername,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      profileUrl: profile.profileUrl
    },
    select: {
      id: true,
      githubUsername: true,
      displayName: true,
      avatarUrl: true,
      profileUrl: true
    }
  });
}
