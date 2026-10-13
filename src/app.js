import express from 'express';
import cors from 'cors';
import { createHealthRouter } from './routes/health.routes.js';
import { notFound } from './middleware/not-found.js';
import { errorHandler } from './middleware/error-handler.js';

export function createApp(
  { 
    prisma, 
    redis, 
    frontendUrl = 'http://localhost:5173', 
    nodeEnv = 'development' 
  }) {
  
  const app = express();

  app.disable('x-powered-by');

  app.use(cors({
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
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
