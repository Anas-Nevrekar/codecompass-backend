import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { createApp } from '../src/app.js';
import { validateEnv } from '../src/config/env.js';
import { errorHandler } from '../src/middleware/error-handler.js';

process.env.NODE_ENV = 'test';

const healthyDependencies = {
  prisma: { $queryRaw: async () => [{ '?column?': 1 }] },
  redis: { ping: async () => 'PONG' }
};

test('GET /api/health returns the process status without infrastructure checks', async () => {
  const app = createApp({ prisma: {}, redis: {}, nodeEnv: 'test' });
  const response = await request(app).get('/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok', service: 'codecompass-api' });
});

test('unknown routes return a JSON 404', async () => {
  const response = await request(createApp({ ...healthyDependencies, nodeEnv: 'test' })).get('/nope');
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
});

test('CORS allows only the configured frontend origin', async () => {
  const app = createApp({ ...healthyDependencies, frontendUrl: 'http://localhost:5173', nodeEnv: 'test' });
  const allowed = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
  assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:5173');
  const denied = await request(app).get('/api/health').set('Origin', 'https://other.example');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'CORS_ORIGIN_DENIED');
});

test('error middleware returns a consistent JSON error response', async () => {
  const app = express();
  app.get('/failure', (_req, _res, next) => next(new Error('secret detail')));
  app.use(errorHandler);
  const response = await request(app).get('/failure');
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred' } });
});

test('GET /api/ready succeeds when PostgreSQL and Redis checks succeed', async () => {
  const response = await request(createApp({ ...healthyDependencies, nodeEnv: 'test' })).get('/api/ready');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok', dependencies: { postgres: 'ok', redis: 'ok' } });
});

test('GET /api/ready reports each failed dependency', async (t) => {
  await t.test('PostgreSQL unavailable', async () => {
    const dependencies = { ...healthyDependencies, prisma: { $queryRaw: async () => { throw new Error('offline'); } } };
    const response = await request(createApp({ ...dependencies, nodeEnv: 'test' })).get('/api/ready');
    assert.equal(response.status, 503);
    assert.deepEqual(response.body.dependencies, { postgres: 'error', redis: 'ok' });
  });
  await t.test('Redis unavailable', async () => {
    const dependencies = { ...healthyDependencies, redis: { ping: async () => { throw new Error('offline'); } } };
    const response = await request(createApp({ ...dependencies, nodeEnv: 'test' })).get('/api/ready');
    assert.equal(response.status, 503);
    assert.deepEqual(response.body.dependencies, { postgres: 'ok', redis: 'error' });
  });
});

test('environment validation accepts defaults and rejects invalid required values', () => {
  assert.equal(validateEnv({}).port, 3000);
  assert.equal(validateEnv({ NODE_ENV: 'production' }).githubCallbackUrl, '');
  assert.throws(() => validateEnv({ PORT: '70000' }), /PORT/);
  assert.throws(() => validateEnv({ DATABASE_URL: 'not-a-url' }), /DATABASE_URL/);
  assert.throws(() => validateEnv({ REDIS_URL: 'http://localhost' }), /REDIS_URL/);
  assert.throws(() => validateEnv({ FRONTEND_URL: 'https://example.com/path' }), /FRONTEND_URL/);
  assert.throws(() => validateEnv({ SESSION_SECRET: 'too-short' }), /SESSION_SECRET/);
  assert.throws(() => validateEnv({ GITHUB_CALLBACK_URL: 'https://example.com/wrong-path' }), /GITHUB_CALLBACK_URL/);
  assert.equal(validateEnv({ FRONTEND_URL: 'https://example.com/' }).frontendUrl, 'https://example.com');
});
