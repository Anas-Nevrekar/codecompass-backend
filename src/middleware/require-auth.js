import { getCookie, SESSION_COOKIE, verifySessionToken } from '../lib/session.js';
import { HttpError } from '../lib/http-error.js';

export function requireAuth({ prisma, config }) {
  return async (req, _res, next) => {
    try {
      if (!config.sessionSecret) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      const token = getCookie(req, SESSION_COOKIE);
      const userId = token ? await verifySessionToken(token, config.sessionSecret) : null;
      if (!userId) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      req.auth = { userId: user.id };
      next();
    } catch (error) {
      if (error instanceof HttpError) return next(error);
      if (error?.code?.startsWith?.('ERR_JWT_') || error?.code === 'ERR_JWS_INVALID' || error?.name === 'JWTExpired') {
        return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.'));
      }
      if (error?.name === 'JWTClaimValidationFailed' || error?.name === 'JWSSignatureVerificationFailed') {
        return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.'));
      }
      return next(error);
    }
  };
}
