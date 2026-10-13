import { Router } from 'express';
import { healthController } from '../controllers/health.controller.js';

export function createHealthRouter(dependencies) {
  const router = Router();
  const controller = healthController(dependencies);
  router.get('/health', controller.health);
  router.get('/ready', controller.ready);
  return router;
}
