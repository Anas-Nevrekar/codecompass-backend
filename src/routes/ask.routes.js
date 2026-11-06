import { Router } from 'express';
import { createAskController } from '../controllers/ask.controller.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requireSameOrigin } from '../middleware/require-same-origin.js';

export function createAskRouter(dependencies) {
  const router = Router();
  const controller = createAskController(dependencies);
  router.post('/repositories/:repositoryId/ask', requireSameOrigin(dependencies.config.frontendUrl), requireAuth(dependencies), controller.ask);
  return router;
}
