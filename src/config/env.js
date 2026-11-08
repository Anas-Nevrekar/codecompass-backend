const DEFAULTS = {
  NODE_ENV: 'development',
  PORT: '3000',
  FRONTEND_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://localhost:5432/codecompass',
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
  INDEXING_RECOVERY_INTERVAL_MS: '30000',
  EMBEDDING_PROVIDER: 'ollama', EMBEDDING_BASE_URL: 'http://localhost:11434',
  EMBEDDING_MODEL: 'qwen3-embedding:0.6b', EMBEDDING_DIMENSIONS: '1024', EMBEDDING_BATCH_SIZE: '16',
  GEMINI_API_KEY: '',
  EMBEDDING_MAX_INPUT_CHARS: '100000',
  EMBEDDING_WORKER_CONCURRENCY: '1', EMBEDDING_REQUEST_TIMEOUT_MS: '120000',
  HYBRID_SEARCH_VECTOR_LIMIT: '20', HYBRID_SEARCH_KEYWORD_LIMIT: '20',
  HYBRID_SEARCH_DEFAULT_LIMIT: '10', HYBRID_SEARCH_RRF_K: '60',
  LLM_PROVIDER: 'gemini', LLM_API_KEY: '', LLM_MODEL: 'gemini-3.8-flash',
  LLM_MAX_OUTPUT_TOKENS: '1500', LLM_REQUEST_TIMEOUT_MS: '60000',
  RAG_RETRIEVAL_LIMIT: '10', RAG_MAX_CONTEXT_TOKENS: '12000',
  RAG_MAX_QUESTION_LENGTH: '2000', RAG_ENABLE_STREAMING: 'true'
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
  if (!['ollama', 'gemini'].includes(values.EMBEDDING_PROVIDER)) throw new Error('EMBEDDING_PROVIDER must be ollama or gemini');
  let embeddingBaseUrl = '';
  if (values.EMBEDDING_PROVIDER === 'ollama') {
    try { embeddingBaseUrl = new URL(values.EMBEDDING_BASE_URL); } catch { throw new Error('EMBEDDING_BASE_URL must be a valid URL'); }
    if (!['http:', 'https:'].includes(embeddingBaseUrl.protocol) || embeddingBaseUrl.username || embeddingBaseUrl.password || embeddingBaseUrl.search || embeddingBaseUrl.hash) throw new Error('EMBEDDING_BASE_URL must be an HTTP(S) base URL without credentials, query, or fragment');
  }
  const geminiApiKey = values.GEMINI_API_KEY || values.LLM_API_KEY;
  const embedding = {
    provider: values.EMBEDDING_PROVIDER,
    ...(values.EMBEDDING_PROVIDER === 'ollama' ? { baseUrl: embeddingBaseUrl.origin + embeddingBaseUrl.pathname.replace(/\/$/, '') } : { apiKey: geminiApiKey }),
    model: values.EMBEDDING_MODEL,
    dimensions: positiveInteger(values.EMBEDDING_DIMENSIONS, 'EMBEDDING_DIMENSIONS', 4096),
    batchSize: positiveInteger(values.EMBEDDING_BATCH_SIZE, 'EMBEDDING_BATCH_SIZE', 128),
    maxInputChars: positiveInteger(values.EMBEDDING_MAX_INPUT_CHARS, 'EMBEDDING_MAX_INPUT_CHARS', 1000000),
    workerConcurrency: positiveInteger(values.EMBEDDING_WORKER_CONCURRENCY, 'EMBEDDING_WORKER_CONCURRENCY', 8),
    requestTimeoutMs: positiveInteger(values.EMBEDDING_REQUEST_TIMEOUT_MS, 'EMBEDDING_REQUEST_TIMEOUT_MS', 600000)
  };
  if (!embedding.model.trim()) throw new Error('EMBEDDING_MODEL must not be empty');
  const search = {
    vectorLimit: positiveInteger(values.HYBRID_SEARCH_VECTOR_LIMIT, 'HYBRID_SEARCH_VECTOR_LIMIT', 100),
    keywordLimit: positiveInteger(values.HYBRID_SEARCH_KEYWORD_LIMIT, 'HYBRID_SEARCH_KEYWORD_LIMIT', 100),
    defaultLimit: positiveInteger(values.HYBRID_SEARCH_DEFAULT_LIMIT, 'HYBRID_SEARCH_DEFAULT_LIMIT', 50),
    rrfK: positiveInteger(values.HYBRID_SEARCH_RRF_K, 'HYBRID_SEARCH_RRF_K', 1000)
  };
  if (values.LLM_PROVIDER !== 'gemini') throw new Error('LLM_PROVIDER must be gemini');
  const llm = {
    provider: values.LLM_PROVIDER,
    apiKey: geminiApiKey,
    model: values.LLM_MODEL,
    maxOutputTokens: positiveInteger(values.LLM_MAX_OUTPUT_TOKENS, 'LLM_MAX_OUTPUT_TOKENS', 8192),
    requestTimeoutMs: positiveInteger(values.LLM_REQUEST_TIMEOUT_MS, 'LLM_REQUEST_TIMEOUT_MS', 300000)
  };
  if (!llm.model.trim()) throw new Error('LLM_MODEL must not be empty');
  if (typeof values.RAG_ENABLE_STREAMING !== 'string' || !['true', 'false'].includes(values.RAG_ENABLE_STREAMING.toLowerCase())) throw new Error('RAG_ENABLE_STREAMING must be true or false');
  const rag = {
    retrievalLimit: positiveInteger(values.RAG_RETRIEVAL_LIMIT, 'RAG_RETRIEVAL_LIMIT', 50),
    maxContextTokens: positiveInteger(values.RAG_MAX_CONTEXT_TOKENS, 'RAG_MAX_CONTEXT_TOKENS', 100000),
    maxQuestionLength: positiveInteger(values.RAG_MAX_QUESTION_LENGTH, 'RAG_MAX_QUESTION_LENGTH', 10000),
    enableStreaming: values.RAG_ENABLE_STREAMING.toLowerCase() === 'true'
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
    indexing, embedding, search, llm, rag
  });
}
