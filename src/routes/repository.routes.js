import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createRepositoryController } from '../controllers/repository.controller.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requireSameOrigin } from '../middleware/require-same-origin.js';

export function createRepositoryRouter(dependencies) {
  const router = Router();
  const controller = createRepositoryController(dependencies);
  const auth = requireAuth(dependencies);
  const originCheck = requireSameOrigin(dependencies.config.frontendUrl);
  const importLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler(_req, res) {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' } });
    }
  });
  router.post('/import', originCheck, auth, importLimit, controller.import);
  router.get('/', auth, controller.list);
  return router;
}
