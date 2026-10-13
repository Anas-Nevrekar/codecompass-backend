import { checkReadiness } from '../services/readiness.service.js';

export function healthController(dependencies) {
  return {
    health(_req, res) {
      res.status(200).json({ status: 'ok', service: 'codecompass-api' });
    },
    async ready(_req, res, next) {
      try {
        const result = await checkReadiness(dependencies);
        res.status(result.statusCode).json(result.body);
      } catch (error) {
        next(error);
      }
    }
  };
}
