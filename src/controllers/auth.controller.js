import { HttpError } from '../lib/http-error.js';
import {
  clearOAuthStateCookie,
  clearSessionCookie,
  createSessionToken,
  getCookie,
  newOAuthState,
  OAUTH_STATE_COOKIE,
  setOAuthStateCookie,
  setSessionCookie,
  signOAuthState,
  verifyOAuthState
} from '../lib/session.js';
import { fetchGitHubProfile, upsertGitHubUser } from '../services/github-oauth.service.js';

function oauthReady(config) {
  return Boolean(config.githubClientId && config.githubClientSecret && config.githubCallbackUrl && config.sessionSecret);
}

function configurationError(res, config) {
  if (oauthReady(config)) return false;
  res.status(503).json({ error: { code: 'OAUTH_CONFIGURATION_ERROR', message: 'GitHub sign-in is not configured.' } });
  return true;
}

function frontendErrorUrl(frontendUrl, code) {
  const target = new URL('/auth/error', frontendUrl);
  target.searchParams.set('code', code);
  return target.toString();
}

export function createAuthController({ prisma, config, fetchImpl }) {
  return {
    initiate(_req, res) {
      if (configurationError(res, config)) return;
      const state = newOAuthState();
      setOAuthStateCookie(res, signOAuthState(state, config.sessionSecret), config);
      const authorizationUrl = new URL('https://github.com/login/oauth/authorize');
      authorizationUrl.searchParams.set('client_id', config.githubClientId);
      authorizationUrl.searchParams.set('redirect_uri', config.githubCallbackUrl);
      authorizationUrl.searchParams.set('scope', 'read:user');
      authorizationUrl.searchParams.set('state', state);
      authorizationUrl.searchParams.set('allow_signup', 'true');
      res.redirect(302, authorizationUrl.toString());
    },

    async callback(req, res) {
      if (!oauthReady(config)) {
        clearOAuthStateCookie(res, config);
        res.status(503).json({ error: { code: 'OAUTH_CONFIGURATION_ERROR', message: 'GitHub sign-in is not configured.' } });
        return;
      }
      const state = req.query.state;
      const signedState = getCookie(req, OAUTH_STATE_COOKIE);
      if (!verifyOAuthState(state, signedState, config.sessionSecret)) {
        clearOAuthStateCookie(res, config);
        res.redirect(302, frontendErrorUrl(config.frontendUrl, 'INVALID_OAUTH_STATE'));
        return;
      }
      clearOAuthStateCookie(res, config);
      if (req.query.error || typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 2048) {
        const errorCode = req.query.error === 'access_denied' ? 'OAUTH_DENIED' : 'OAUTH_PROVIDER_ERROR';
        res.redirect(302, frontendErrorUrl(config.frontendUrl, errorCode));
        return;
      }
      try {
        const profile = await fetchGitHubProfile({ code: req.query.code, config, fetchImpl });
        const user = await upsertGitHubUser(prisma, profile);
        const token = await createSessionToken(user.id, config.sessionSecret);
        setSessionCookie(res, token, config);
        res.redirect(302, new URL('/dashboard', config.frontendUrl).toString());
      } catch (error) {
        const code = error instanceof HttpError ? error.code : 'INTERNAL_SERVER_ERROR';
        res.redirect(302, frontendErrorUrl(config.frontendUrl, code));
      }
    },

    async me(req, res, next) {
      try {
        const user = await prisma.user.findUnique({
          where: { id: req.auth.userId },
          select: { id: true, githubUsername: true, displayName: true, avatarUrl: true, profileUrl: true }
        });
        if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
        res.json({
          authenticated: true,
          user: {
            id: user.id,
            githubUsername: user.githubUsername,
            displayName: user.displayName,
            avatarUrl: user.avatarUrl,
            profileUrl: user.profileUrl
          }
        });
      } catch (error) { next(error); }
    },

    logout(_req, res) {
      clearSessionCookie(res, config);
      res.json({ success: true });
    }
  };
}
