export const QUERY_INSTRUCTION = 'Instruct: Given a question, retrieve relevant code snippets\nQuery: ';

export function formatCodeChunk(chunk) {
  return `Language: ${chunk.language}\nStructure: ${chunk.structureType}\nSymbol: ${chunk.symbolName || 'N/A'}\nFile: ${chunk.relativePath}\n\nSource code:\n${chunk.source}`;
}

export function formatSearchQuery(query) { return `${QUERY_INSTRUCTION}${query.trim()}`; }

function validateVectors(vectors, expectedCount, dimensions) {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) throw new Error('Ollama returned an unexpected number of embeddings.');
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error(`Ollama returned an invalid embedding; expected ${dimensions} finite numbers.`);
    }
  }
  return vectors;
}

export function createOllamaEmbeddingService({ config, fetchImpl = globalThis.fetch }) {
  async function embed(input) {
    const inputs = Array.isArray(input) ? input : [input];
    if (!inputs.length || inputs.some((text) => typeof text !== 'string' || !text.trim())) {
      if (!inputs.length) return [];
      throw new Error('Embedding input must contain non-empty text.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetchImpl(`${config.baseUrl}/api/embed`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.model, input: inputs }), signal: controller.signal
      });
      let body;
      try { body = await response.json(); } catch { throw new Error('Ollama returned an unreadable response.'); }
      if (!response.ok) {
        const text = `${body?.error ?? ''}`;
        if (/not found|pull|model/i.test(text)) throw new Error(`Ollama model ${config.model} is unavailable. Install it with: ollama pull ${config.model}`);
        const error = new Error(`Ollama embedding request failed with status ${response.status}.`);
        error.retryable = response.status >= 500 || response.status === 429;
        throw error;
      }
      return validateVectors(body?.embeddings, inputs.length, config.dimensions);
    } catch (error) {
      if (error.name === 'AbortError') { const timeout = new Error('Ollama embedding request timed out.'); timeout.retryable = true; throw timeout; }
      if (error instanceof TypeError) { const connection = new Error(`Could not connect to Ollama at ${config.baseUrl}.`); connection.retryable = true; throw connection; }
      throw error;
    } finally { clearTimeout(timer); }
  }
  return { embed, embedOne: async (text) => (await embed(text))[0], health: async () => {
    const response = await fetchImpl(`${config.baseUrl}/api/tags`);
    if (!response.ok) throw new Error(`Ollama health check failed with status ${response.status}.`);
    const body = await response.json();
    const models = (body.models ?? []).map((item) => item.name);
    if (!models.some((name) => name === config.model || name.startsWith(`${config.model}:`))) throw new Error(`Ollama model ${config.model} is unavailable. Install it with: ollama pull ${config.model}`);
    return { available: true, model: config.model };
  } };
}
