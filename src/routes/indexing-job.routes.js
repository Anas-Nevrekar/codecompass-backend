import { Router } from 'express';
import { createIndexingController } from '../controllers/indexing.controller.js';
import { requireAuth } from '../middleware/require-auth.js';

export function createIndexingJobRouter(dependencies) {
  const router = Router();
  const controller = createIndexingController(dependencies);
  const auth = requireAuth(dependencies);
  router.get('/:jobId', auth, controller.getJob);
  return router;
}
