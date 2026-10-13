import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  createSessionToken,
  signOAuthState,
  verifyOAuthState
} from '../src/lib/session.js';

process.env.NODE_ENV = 'test';

const SECRET = 'phase-two-test-secret-with-more-than-32-bytes';

function config(overrides = {}) {
  return {
    nodeEnv: 'test',
    frontendUrl: 'http://localhost:5173',
    githubClientId: 'test-client-id',
    githubClientSecret: 'test-client-secret',
    githubCallbackUrl: 'http://localhost:3000/api/auth/github/callback',
    sessionSecret: SECRET,
    ...overrides
  };
}

function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers });
}

function cookiePair(setCookieHeader) {
  return setCookieHeader.split(';', 1)[0];
}

function profile() {
  return {
    id: 48,
    login: 'example-user',
    name: 'Example User',
    avatar_url: 'https://avatars.githubusercontent.com/u/48?v=4',
    html_url: 'https://github.com/example-user'
  };
}

function publicRepository(overrides = {}) {
  return {
    id: 123456,
    owner: { login: 'owner' },
    name: 'repository',
    full_name: 'owner/repository',
    html_url: 'https://github.com/owner/repository',
    private: false,
    visibility: 'public',
    description: 'Example repository',
    default_branch: 'main',
    language: 'JavaScript',
    stargazers_count: 27,
    forks_count: 3,
    created_at: '2021-05-06T12:30:00Z',
    ...overrides
  };
}

function memoryPrisma() {
  const users = new Map([['user-1', { id: 'user-1', githubUsername: 'first-user', displayName: 'First User', avatarUrl: null, profileUrl: 'https://github.com/first-user' }]]);
  const repositories = new Map();
  const imports = new Map();
  let sequence = 0;
  const prisma = {
    user: {
      async findUnique({ where }) { return users.get(where.id) ?? null; },
      async upsert({ where, create, update }) {
        let user = [...users.values()].find((row) => row.githubId === where.githubId);
        if (user) Object.assign(user, update);
        else {
          user = { id: `oauth-${where.githubId}`, ...create };
          users.set(user.id, user);
        }
        return {
          id: user.id,
          githubUsername: user.githubUsername,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          profileUrl: user.profileUrl
        };
      }
    },
    async $transaction(work) {
      return work({
        repository: {
          async upsert({ where, create, update }) {
            let repository = repositories.get(where.githubId.toString());
            if (repository) Object.assign(repository, update);
            else {
              repository = { id: `repository-${++sequence}`, ...create };
              repositories.set(where.githubId.toString(), repository);
            }
            return repository;
          }
        },
        repositoryImport: {
          async createMany({ data }) {
            let count = 0;
            for (const item of data) {
              const key = `${item.userId}:${item.repositoryId}`;
              if (!imports.has(key)) {
                imports.set(key, { ...item, importedAt: new Date() });
                count += 1;
              }
            }
            return { count };
          }
        }
      });
    },
    repositoryImport: {
      async findMany({ where }) {
        return [...imports.values()]
          .filter((item) => item.userId === where.userId)
          .map((item) => ({ ...item, repository: [...repositories.values()].find((repo) => repo.id === item.repositoryId) }))
          .sort((a, b) => b.importedAt - a.importedAt);
      }
    }
  };
  return { prisma, users, repositories, imports };
}

function makeApp({ prisma = memoryPrisma().prisma, config: appConfig = config(), fetchImpl = async () => response(publicRepository()) } = {}) {
  return createApp({ prisma, redis: {}, config: appConfig, fetchImpl });
}

async function sessionCookie(userId = 'user-1') {
  return `${SESSION_COOKIE}=${await createSessionToken(userId, SECRET)}`;
}

test('OAuth initiation redirects with minimal scope and a signed, HTTP-only state cookie', async () => {
  const response = await request(makeApp()).get('/api/auth/github');
  assert.equal(response.status, 302);
  const target = new URL(response.headers.location);
  assert.equal(target.origin, 'https://github.com');
  assert.equal(target.pathname, '/login/oauth/authorize');
  assert.equal(target.searchParams.get('scope'), 'read:user');
  assert.equal(target.searchParams.get('redirect_uri'), config().githubCallbackUrl);
  assert.ok(target.searchParams.get('state'));
  assert.match(response.headers['set-cookie'][0], /HttpOnly/i);
  assert.match(response.headers['set-cookie'][0], /SameSite=Lax/i);
  assert.match(response.headers['set-cookie'][0], /Path=\/api\/auth\/github\/callback/i);
});

test('OAuth endpoints report missing configuration without affecting health', async () => {
  const app = makeApp({ config: config({ githubClientId: '', githubClientSecret: '', sessionSecret: '' }) });
  const login = await request(app).get('/api/auth/github');
  assert.equal(login.status, 503);
  assert.equal(login.body.error.code, 'OAUTH_CONFIGURATION_ERROR');
  const health = await request(app).get('/api/health');
  assert.equal(health.status, 200);
  const callback = await request(app).get('/api/auth/github/callback');
  assert.equal(callback.status, 503);
  assert.equal(callback.body.error.code, 'OAUTH_CONFIGURATION_ERROR');
  assert.ok(callback.headers['set-cookie'].some((value) => /Max-Age=0/i.test(value)));
});

test('OAuth initiation is rate limited', async () => {
  const app = makeApp({ config: config({ githubClientId: '', githubClientSecret: '', sessionSecret: '' }) });
  let last;
  for (let index = 0; index < 11; index += 1) last = await request(app).get('/api/auth/github');
  assert.equal(last.status, 429);
  assert.equal(last.body.error.code, 'RATE_LIMITED');
});

test('OAuth callback rejects a missing or mismatched state', async () => {
  const response = await request(makeApp()).get('/api/auth/github/callback?code=abc&state=bad');
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.location).searchParams.get('code'), 'INVALID_OAUTH_STATE');
  assert.ok(response.headers['set-cookie'].some((value) => value.includes(`${OAUTH_STATE_COOKIE}=`) && /Max-Age=0/i.test(value)));
});

test('OAuth state signatures expire and reject modified cookies', () => {
  assert.equal(verifyOAuthState('some-state', signOAuthState('some-state', SECRET), SECRET), true);
  assert.equal(verifyOAuthState('other-state', signOAuthState('some-state', SECRET), SECRET), false);
  const expiredAt = Date.now() - 11 * 60 * 1000;
  const expiredSignature = createHmac('sha256', SECRET).update(`old-state.${expiredAt}`).digest('base64url');
  assert.equal(verifyOAuthState('old-state', `old-state.${expiredAt}.${expiredSignature}`, SECRET), false);
});

test('OAuth callback handles user cancellation after validating state', async () => {
  const state = 'opaque-state';
  const signed = signOAuthState(state, SECRET);
  const response = await request(makeApp())
    .get(`/api/auth/github/callback?error=access_denied&state=${state}`)
    .set('Cookie', `${OAUTH_STATE_COOKIE}=${signed}`);
  assert.equal(new URL(response.headers.location).searchParams.get('code'), 'OAUTH_DENIED');
});

test('OAuth callback exchanges credentials server-side, upserts the user, and sets a session cookie', async () => {
  const { prisma } = memoryPrisma();
  const requests = [];
  const app = makeApp({ prisma, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1 ? response({ access_token: 'github-token-secret', token_type: 'bearer' }) : response(profile());
  } });
  const login = await request(app).get('/api/auth/github');
  const state = new URL(login.headers.location).searchParams.get('state');
  const stateCookie = cookiePair(login.headers['set-cookie'][0]);
  const callback = await request(app)
    .get(`/api/auth/github/callback?code=authorization-code&state=${state}`)
    .set('Cookie', stateCookie);

  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, 'http://localhost:5173/dashboard');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://github.com/login/oauth/access_token');
  assert.equal(requests[1].url, 'https://api.github.com/user');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer github-token-secret');
  assert.equal(JSON.stringify(callback.body).includes('github-token-secret'), false);
  const sessionHeader = callback.headers['set-cookie'].find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  assert.match(sessionHeader, /HttpOnly/i);
  assert.match(sessionHeader, /SameSite=Lax/i);
  assert.match(sessionHeader, /Path=\/api(?:;|$)/i);
  const me = await request(app).get('/api/auth/me').set('Cookie', cookiePair(sessionHeader));
  assert.equal(me.status, 200);
  assert.deepEqual(me.body, {
    authenticated: true,
    user: {
      id: 'oauth-48', githubUsername: 'example-user', displayName: 'Example User',
      avatarUrl: 'https://avatars.githubusercontent.com/u/48?v=4', profileUrl: 'https://github.com/example-user'
    }
  });
});

test('authentication profile is 401 without a valid cookie; logout clears it with an exact origin', async () => {
  const app = makeApp();
  const unauthenticated = await request(app).get('/api/auth/me');
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.body.error.code, 'UNAUTHENTICATED');
  const logout = await request(app).post('/api/auth/logout').set('Origin', 'http://localhost:5173');
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.body, { success: true });
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/i);
  const blocked = await request(app).post('/api/auth/logout').set('Origin', 'https://attacker.example');
  assert.equal(blocked.status, 403);
});

test('OAuth provider failure returns a safe frontend error and never creates a session', async () => {
  const state = 'provider-failure-state';
  const app = makeApp({ fetchImpl: async () => response({ error: 'bad_verification_code' }, 400) });
  const callback = await request(app)
    .get(`/api/auth/github/callback?code=bad-code&state=${state}`)
    .set('Cookie', `${OAUTH_STATE_COOKIE}=${signOAuthState(state, SECRET)}`);
  assert.equal(new URL(callback.headers.location).searchParams.get('code'), 'OAUTH_PROVIDER_ERROR');
  assert.equal(callback.headers['set-cookie'].some((value) => value.startsWith(`${SESSION_COOKIE}=`)), false);
});

test('public repository imports are unique per user and listing is user scoped', async () => {
  const { prisma, users, imports } = memoryPrisma();
  users.set('user-2', { id: 'user-2', githubUsername: 'second-user' });
  const app = makeApp({ prisma });
  const firstCookie = await sessionCookie('user-1');
  const secondCookie = await sessionCookie('user-2');
  const payload = { url: 'https://github.com/owner/repository.git' };

  const first = await request(app).post('/api/repositories/import').set('Origin', 'http://localhost:5173').set('Cookie', firstCookie).send(payload);
  assert.equal(first.status, 201);
  assert.equal(first.body.code, 'REPOSITORY_IMPORTED');
  assert.equal(first.body.alreadyImported, false);
  assert.equal(first.body.repository.fullName, 'owner/repository');
  const duplicate = await request(app).post('/api/repositories/import').set('Origin', 'http://localhost:5173').set('Cookie', firstCookie).send(payload);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.code, 'REPOSITORY_ALREADY_IMPORTED');
  assert.equal(duplicate.body.alreadyImported, true);
  assert.equal(imports.size, 1);
  const secondUser = await request(app).post('/api/repositories/import').set('Origin', 'http://localhost:5173').set('Cookie', secondCookie).send(payload);
  assert.equal(secondUser.status, 201);
  assert.equal(imports.size, 2);

  const firstList = await request(app).get('/api/repositories').set('Cookie', firstCookie);
  const secondList = await request(app).get('/api/repositories').set('Cookie', secondCookie);
  assert.equal(firstList.body.repositories.length, 1);
  assert.equal(firstList.body.repositories[0].fullName, 'owner/repository');
  assert.equal(secondList.body.repositories.length, 1);
  const anonymous = await request(app).get('/api/repositories');
  assert.equal(anonymous.status, 401);
});

test('repository import validates URLs before calling GitHub and requires exact Origin', async () => {
  let called = false;
  const app = makeApp({ fetchImpl: async () => { called = true; return response(publicRepository()); } });
  const cookie = await sessionCookie();
  const invalid = await request(app).post('/api/repositories/import').set('Origin', 'http://localhost:5173').set('Cookie', cookie).send({ url: 'https://github.com/owner/repository/issues/3' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'INVALID_REPOSITORY_URL');
  assert.equal(called, false);
  const forgedUserId = await request(app).post('/api/repositories/import')
    .set('Origin', 'http://localhost:5173').set('Cookie', cookie)
    .send({ url: 'https://github.com/owner/repository', userId: 'user-2' });
  assert.equal(forgedUserId.status, 400);
  assert.equal(forgedUserId.body.error.code, 'INVALID_REPOSITORY_URL');
  const csrf = await request(app).post('/api/repositories/import').set('Origin', 'https://attacker.example').set('Cookie', cookie).send({ url: 'https://github.com/owner/repository' });
  assert.equal(csrf.status, 403);
  assert.equal(called, false);
});

test('repository import maps private, missing, rate-limited, and unavailable GitHub responses safely', async (t) => {
  const cases = [
    { name: 'private', upstream: response(publicRepository({ private: true, visibility: 'private' })), status: 403, code: 'PRIVATE_REPOSITORY_UNSUPPORTED' },
    { name: 'missing or inaccessible', upstream: response({ message: 'Not Found' }, 404), status: 404, code: 'REPOSITORY_NOT_FOUND_OR_INACCESSIBLE' },
    { name: 'rate limited', upstream: response({ message: 'rate limit' }, 403, { 'x-ratelimit-remaining': '0' }), status: 429, code: 'GITHUB_API_RATE_LIMIT' },
    { name: 'unavailable', upstream: new Error('timeout'), status: 503, code: 'GITHUB_UPSTREAM_UNAVAILABLE' }
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const app = makeApp({ fetchImpl: async () => {
        if (item.upstream instanceof Error) throw item.upstream;
        return item.upstream;
      } });
      const result = await request(app).post('/api/repositories/import')
        .set('Origin', 'http://localhost:5173').set('Cookie', await sessionCookie())
        .send({ url: 'https://github.com/owner/repository' });
      assert.equal(result.status, item.status);
      assert.equal(result.body.error.code, item.code);
    });
  }
});

test('repository persistence failure does not return success', async () => {
  const state = memoryPrisma();
  state.prisma.$transaction = async () => { throw new Error('database unavailable'); };
  const app = makeApp({ prisma: state.prisma });
  const result = await request(app).post('/api/repositories/import')
    .set('Origin', 'http://localhost:5173').set('Cookie', await sessionCookie())
    .send({ url: 'https://github.com/owner/repository' });
  assert.equal(result.status, 500);
  assert.equal(result.body.success, undefined);
});

test('user profile data is normalized and invalid GitHub identity responses are rejected', async () => {
  const state = memoryPrisma();
  const app = makeApp({ prisma: state.prisma, fetchImpl: async (_url, options) => {
    if (options.method === 'POST') return response({ access_token: 'token-secret-value' });
    return response({ ...profile(), id: 4.2 });
  } });
  const authState = 'bad-profile-state';
  const result = await request(app)
    .get(`/api/auth/github/callback?code=code&state=${authState}`)
    .set('Cookie', `${OAUTH_STATE_COOKIE}=${signOAuthState(authState, SECRET)}`);
  assert.equal(new URL(result.headers.location).searchParams.get('code'), 'OAUTH_PROVIDER_ERROR');
  assert.equal([...state.users.values()].length, 1);
});

test('malformed public repository metadata is rejected before it can be persisted', async () => {
  const { prisma, repositories } = memoryPrisma();
  const app = makeApp({ prisma, fetchImpl: async () => response(publicRepository({ html_url: 'https://github.com/another-owner/repository' })) });
  const invalid = await request(app).post('/api/repositories/import')
    .set('Origin', 'http://localhost:5173').set('Cookie', await sessionCookie())
    .send({ url: 'https://github.com/owner/repository' });
  assert.equal(invalid.status, 502);
  assert.equal(invalid.body.error.code, 'GITHUB_UPSTREAM_ERROR');
  assert.equal(repositories.size, 0);
});

test('invalid session JWTs are rejected', async () => {
  const response = await request(makeApp()).get('/api/auth/me').set('Cookie', `${SESSION_COOKIE}=not.a.jwt`);
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'UNAUTHENTICATED');
});
