import { GoogleGenAI } from '@google/genai';

const DEFAULT_DOCUMENT_TASK = 'RETRIEVAL_DOCUMENT';
const DEFAULT_QUERY_TASK = 'CODE_RETRIEVAL_QUERY';

function validateVectors(vectors, expectedCount, dimensions) {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new Error('Gemini returned an unexpected number of embeddings.');
  }
  return vectors.map((vector) => {
    const values = vector?.values;
    if (!Array.isArray(values) || values.length !== dimensions || !values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error(`Gemini returned an invalid embedding; expected ${dimensions} finite numbers.`);
    }
    const norm = Math.hypot(...values);
    if (!Number.isFinite(norm) || norm === 0) throw new Error('Gemini returned a zero or invalid embedding.');
    // gemini-embedding-001 requires manual normalization when dimensions are reduced.
    return values.map((value) => value / norm);
  });
}

function safeProviderError(error, apiKey) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  const timeout = ['AbortError', 'TimeoutError'].includes(error?.name) || error?.code === 'ETIMEDOUT';
  const networkCode = error?.code ?? error?.cause?.code;
  const transientNetwork = error instanceof TypeError || ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(networkCode);
  const retryable = timeout || transientNetwork || status === 429 || status >= 500;
  const result = new Error(timeout
    ? 'Gemini embedding request timed out.'
    : status === 429
      ? 'Gemini embedding rate limit or quota was reached.'
      : status === 401 || status === 403
        ? 'Gemini embedding authentication failed. Check GEMINI_API_KEY.'
        : status === 400 || status === 404
          ? 'Gemini rejected the embedding request. Check the model and input configuration.'
          : 'Gemini embedding provider is temporarily unavailable.');
  result.retryable = retryable;
  result.status = timeout ? 504 : Number.isFinite(status) ? status : 503;
  result.code = timeout ? 'GEMINI_EMBEDDING_TIMEOUT' : status === 429 ? 'GEMINI_EMBEDDING_RATE_LIMITED' : status === 401 || status === 403 ? 'GEMINI_EMBEDDING_AUTH_FAILED' : 'GEMINI_EMBEDDING_UNAVAILABLE';
  if (apiKey && result.message.includes(apiKey)) result.message = result.message.split(apiKey).join('[REDACTED]');
  return result;
}

export function createGeminiEmbeddingService({ config, client } = {}) {
  const apiKey = config?.apiKey ?? '';
  const ai = client ?? (apiKey ? new GoogleGenAI({ apiKey }) : null);

  async function embed(input, { taskType = DEFAULT_DOCUMENT_TASK } = {}) {
    const inputs = Array.isArray(input) ? input : [input];
    if (!inputs.length) return [];
    if (inputs.some((text) => typeof text !== 'string' || !text.trim())) throw new Error('Embedding input must contain non-empty text.');
    if (!ai) {
      const error = new Error('Gemini embeddings are not configured. Set GEMINI_API_KEY.');
      error.code = 'GEMINI_EMBEDDING_NOT_CONFIGURED';
      throw error;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await ai.models.embedContent({
        model: config.model,
        contents: inputs,
        config: { taskType, outputDimensionality: config.dimensions, abortSignal: controller.signal }
      });
      return validateVectors(response?.embeddings, inputs.length, config.dimensions);
    } catch (error) {
      if (error instanceof Error && /unexpected number|invalid embedding|zero or invalid|non-empty/.test(error.message)) throw error;
      if (controller.signal.aborted) {
        const timeout = new Error('Gemini embedding request timed out.');
        timeout.retryable = true;
        timeout.code = 'GEMINI_EMBEDDING_TIMEOUT';
        timeout.status = 504;
        throw timeout;
      }
      throw safeProviderError(error, apiKey);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    embed,
    embedOne: async (text, options = {}) => (await embed(text, options))[0],
    health: async () => {
      if (!ai) throw new Error('Gemini embeddings are not configured. Set GEMINI_API_KEY.');
      return { available: true, provider: 'gemini', model: config.model, dimensions: config.dimensions };
    }
  };
}

export { DEFAULT_DOCUMENT_TASK, DEFAULT_QUERY_TASK };
