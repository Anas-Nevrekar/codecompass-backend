import 'dotenv/config';
import assert from 'node:assert/strict';
import { validateEnv } from '../src/config/env.js';
import { createOllamaEmbeddingService } from '../src/services/ollama-embedding.service.js';

const config = validateEnv();
const service = createOllamaEmbeddingService({ config: config.embedding });
const health = await service.health();
const embedding = await service.embedOne('A small function that authenticates a user.');
assert.equal(embedding.length, config.embedding.dimensions);
assert.ok(embedding.every(Number.isFinite));
console.info(`Ollama ${health.model} is reachable; embedding dimensions: ${embedding.length}`);
