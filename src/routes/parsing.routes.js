import { Router } from 'express';
import { createParsingController } from '../controllers/parsing.controller.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requireSameOrigin } from '../middleware/require-same-origin.js';
export function createParsingRouter(dependencies) {
  const router = Router();
  const controller = createParsingController(dependencies);
  router.post('/repositories/:repositoryId/parse', requireSameOrigin(dependencies.config.frontendUrl), requireAuth(dependencies), controller.start);
  router.get('/parsing-jobs/:jobId', requireAuth(dependencies), controller.status);
  return router;
}
