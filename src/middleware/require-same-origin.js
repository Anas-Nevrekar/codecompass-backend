import { HttpError } from '../lib/http-error.js';

export function requireSameOrigin(frontendUrl) {
  const expectedOrigin = new URL(frontendUrl).origin;
  return (req, _res, next) => {
    if (req.get('origin') !== expectedOrigin) {
      return next(new HttpError(403, 'ORIGIN_FORBIDDEN', 'This request origin is not allowed.'));
    }
    next();
  };
}
