import express from 'express';
import cors from 'cors';
import { createHealthRouter } from './routes/health.routes.js';
import { notFound } from './middleware/not-found.js';
import { errorHandler } from './middleware/error-handler.js';
import { createAuthRouter } from './routes/auth.routes.js';
import { createRepositoryRouter } from './routes/repository.routes.js';
import { createIndexingJobRouter } from './routes/indexing-job.routes.js';
import { createParsingRouter } from './routes/parsing.routes.js';
import { createEmbeddingRouter } from './routes/embedding.routes.js';
import { createOllamaEmbeddingService } from './services/ollama-embedding.service.js';
import { createAskRouter } from './routes/ask.routes.js';
import { createGeminiLlmService } from './services/gemini-llm.service.js';

export function createApp({
  prisma,
  redis,
  indexingQueue,
  parsingQueue,
  embeddingQueue,
  embeddingService,
  llmService,
  config = {},
  fetchImpl = globalThis.fetch,
  frontendUrl = 'http://localhost:5173',
  nodeEnv = 'development'
}) {
  frontendUrl = config.frontendUrl ?? frontendUrl;
  nodeEnv = config.nodeEnv ?? nodeEnv;
  const app = express();

  app.disable('x-powered-by');

  app.use(cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || origin === frontendUrl) 
        return callback(null, true);
      
      const error = new Error('Origin is not allowed by CORS');
      error.status = 403;
      error.code = 'CORS_ORIGIN_DENIED';
      return callback(error);
    }
  }));
  app.use(express.json({ limit: '1mb' }));
  if (nodeEnv === 'development') {
    app.use((req, _res, next) => {
      console.info(`${req.method} ${req.path}`);
      next();
    });
  }
  app.use('/api', createHealthRouter({ prisma, redis }));
  app.use('/api/auth', createAuthRouter({ prisma, config: { ...config, frontendUrl, nodeEnv }, fetchImpl }));
  app.use('/api/repositories', createRepositoryRouter({ prisma, indexingQueue, config: { ...config, frontendUrl, nodeEnv }, fetchImpl }));
  app.use('/api/indexing-jobs', createIndexingJobRouter({ prisma, config: { ...config, frontendUrl, nodeEnv } }));
  app.use('/api', createParsingRouter({ prisma, parsingQueue, config: { ...config, frontendUrl, nodeEnv } }));
  if (!embeddingService && config.embedding) embeddingService = createOllamaEmbeddingService({ config: config.embedding, fetchImpl });
  if (!llmService && config.llm) llmService = createGeminiLlmService({ config: config.llm });
  if (config.embedding && config.search) {
    const dependencies = { prisma, embeddingQueue, embeddingService, llmService, config: { ...config, frontendUrl, nodeEnv } };
    app.use('/api', createEmbeddingRouter(dependencies));
    if (config.llm && config.rag) app.use('/api', createAskRouter(dependencies));
  }
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
