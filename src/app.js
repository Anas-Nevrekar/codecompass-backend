import express from 'express';
import cors from 'cors';
import { createHealthRouter } from './routes/health.routes.js';
import { notFound } from './middleware/not-found.js';
import { errorHandler } from './middleware/error-handler.js';
import { createAuthRouter } from './routes/auth.routes.js';
import { createRepositoryRouter } from './routes/repository.routes.js';
import { createIndexingJobRouter } from './routes/indexing-job.routes.js';

export function createApp({
  prisma,
  redis,
  indexingQueue,
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
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
