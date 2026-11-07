import { Router } from 'express';
import { createCodeExplorerController } from '../controllers/code-explorer.controller.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requireSameOrigin } from '../middleware/require-same-origin.js';

export function createCodeExplorerRouter(dependencies) {
  const router = Router();
  const controller = createCodeExplorerController(dependencies);
  router.get('/repositories/:repositoryId/graph', requireAuth(dependencies), controller.graph);
  router.get('/repositories/:repositoryId/reading-guide', requireAuth(dependencies), controller.readingGuide);
  router.get('/repositories/:repositoryId/reading-progress', requireAuth(dependencies), controller.readingProgress);
  router.put('/repositories/:repositoryId/reading-progress', requireSameOrigin(dependencies.config?.frontendUrl ?? 'http://localhost:5173'), requireAuth(dependencies), controller.saveReadingProgress);
  router.get('/repositories/:repositoryId/source', requireAuth(dependencies), controller.source);
  return router;
}
