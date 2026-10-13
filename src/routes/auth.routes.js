import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createAuthController } from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requireSameOrigin } from '../middleware/require-same-origin.js';

function limiter(max, windowMs) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    handler(_req, res) {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' } });
    }
  });
}

export function createAuthRouter(dependencies) {
  const router = Router();
  const controller = createAuthController(dependencies);
  const originCheck = requireSameOrigin(dependencies.config.frontendUrl);
  const loginLimit = limiter(10, 15 * 60 * 1000);
  const callbackLimit = limiter(30, 15 * 60 * 1000);
  router.get('/github', loginLimit, controller.initiate);
  router.get('/github/callback', callbackLimit, controller.callback);
  router.get('/me', requireAuth(dependencies), controller.me);
  router.post('/logout', originCheck, controller.logout);
  return router;
}
