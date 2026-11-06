import { Router } from 'express';
import { createEmbeddingController } from '../controllers/embedding.controller.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requireSameOrigin } from '../middleware/require-same-origin.js';

export function createEmbeddingRouter(dependencies) {
  const router = Router();
  const controller = createEmbeddingController(dependencies);
  router.post('/repositories/:repositoryId/embeddings', requireSameOrigin(dependencies.config.frontendUrl), requireAuth(dependencies), controller.start);
  router.get('/embedding-jobs/:jobId', requireAuth(dependencies), controller.status);
  router.post('/repositories/:repositoryId/search', requireSameOrigin(dependencies.config.frontendUrl), requireAuth(dependencies), controller.search);
  router.get('/embeddings/health', requireAuth(dependencies), controller.health);
  return router;
}
