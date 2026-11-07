import { createGeminiEmbeddingService } from './gemini-embedding.service.js';
import { createOllamaEmbeddingService } from './ollama-embedding.service.js';

export function createEmbeddingService({ config, fetchImpl, client } = {}) {
  if (config?.provider === 'gemini') return createGeminiEmbeddingService({ config, client });
  if (config?.provider === 'ollama') return createOllamaEmbeddingService({ config, fetchImpl });
  throw new Error(`Unsupported embedding provider: ${config?.provider ?? '(unset)'}`);
}
