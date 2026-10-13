const DEFAULTS = {
  NODE_ENV: 'development',
  PORT: '3000',
  FRONTEND_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/codecompass',
  REDIS_URL: 'redis://localhost:6379',
  GITHUB_CLIENT_ID: '',
  GITHUB_CLIENT_SECRET: '',
  GITHUB_CALLBACK_URL: '',
  SESSION_SECRET: '',
  INDEXING_CLONE_TIMEOUT_MS: '120000',
  INDEXING_MAX_REPOSITORY_SIZE_MB: '500',
  INDEXING_MAX_FILE_SIZE_MB: '2',
  INDEXING_WORKER_CONCURRENCY: '2',
  INDEXING_TEMP_DIR: '',
  INDEXING_REPOSITORY_STORAGE_DIR: '',
  INDEXING_STALE_TEMP_DIR_AGE_HOURS: '24',
  INDEXING_RECOVERY_INTERVAL_MS: '30000'
};

function positiveInteger(value, name, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new Error(`${name} must be a positive integer no greater than ${max}`);
  }
  return number;
}

export function validateEnv(source = process.env) {
  const values = { ...DEFAULTS, ...source };
  const port = Number(values.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  for (const [key, protocols] of Object.entries({
    FRONTEND_URL: ['http:', 'https:'],
    DATABASE_URL: ['postgres:', 'postgresql:'],
    REDIS_URL: ['redis:', 'rediss:']
  })) {
    let parsed;
    try { parsed = new URL(values[key]); } catch {
      throw new Error(`${key} must be a valid URL`);
    }
    if (!protocols.includes(parsed.protocol)) {
      throw new Error(`${key} must use ${protocols.join(' or ')}`);
    }
    if (key === 'FRONTEND_URL' && (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash)) {
      throw new Error('FRONTEND_URL must be an origin without a path, query, or fragment');
    }
  }
  if (!['development', 'test', 'production'].includes(values.NODE_ENV)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }
  if (values.SESSION_SECRET && Buffer.byteLength(values.SESSION_SECRET, 'utf8') < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 bytes when configured');
  }
  const indexing = {
    cloneTimeoutMs: positiveInteger(values.INDEXING_CLONE_TIMEOUT_MS, 'INDEXING_CLONE_TIMEOUT_MS', 3600000),
    maxRepositorySizeBytes: positiveInteger(values.INDEXING_MAX_REPOSITORY_SIZE_MB, 'INDEXING_MAX_REPOSITORY_SIZE_MB', 102400) * 1024 * 1024,
    maxFileSizeBytes: positiveInteger(values.INDEXING_MAX_FILE_SIZE_MB, 'INDEXING_MAX_FILE_SIZE_MB', 1024) * 1024 * 1024,
    workerConcurrency: positiveInteger(values.INDEXING_WORKER_CONCURRENCY, 'INDEXING_WORKER_CONCURRENCY', 32),
    tempDir: values.INDEXING_TEMP_DIR,
    repositoryStorageDir: values.INDEXING_REPOSITORY_STORAGE_DIR,
    staleTempDirAgeMs: positiveInteger(values.INDEXING_STALE_TEMP_DIR_AGE_HOURS, 'INDEXING_STALE_TEMP_DIR_AGE_HOURS', 720) * 60 * 60 * 1000,
    recoveryIntervalMs: positiveInteger(values.INDEXING_RECOVERY_INTERVAL_MS, 'INDEXING_RECOVERY_INTERVAL_MS', 3600000)
  };
  if (values.GITHUB_CALLBACK_URL) {
    let callbackUrl;
    try { callbackUrl = new URL(values.GITHUB_CALLBACK_URL); } catch {
      throw new Error('GITHUB_CALLBACK_URL must be a valid URL');
    }
    const localHttp = values.NODE_ENV !== 'production' && callbackUrl.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(callbackUrl.hostname);
    if (callbackUrl.protocol !== 'https:' && !localHttp) {
      throw new Error('GITHUB_CALLBACK_URL must use HTTPS (HTTP is allowed for local development)');
    }
    if (callbackUrl.username || callbackUrl.password || callbackUrl.search || callbackUrl.hash ||
        callbackUrl.pathname !== '/api/auth/github/callback') {
      throw new Error('GITHUB_CALLBACK_URL must use /api/auth/github/callback and contain no credentials, query, or fragment');
    }
  }
  return Object.freeze({
    nodeEnv: values.NODE_ENV,
    port,
    frontendUrl: new URL(values.FRONTEND_URL).origin,
    databaseUrl: values.DATABASE_URL,
    redisUrl: values.REDIS_URL,
    githubClientId: values.GITHUB_CLIENT_ID,
    githubClientSecret: values.GITHUB_CLIENT_SECRET,
    githubCallbackUrl: values.GITHUB_CALLBACK_URL,
    sessionSecret: values.SESSION_SECRET,
    indexing
  });
}
