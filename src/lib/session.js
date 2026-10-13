import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parse, serialize } from 'cookie';
import { SignJWT, jwtVerify } from 'jose';

export const SESSION_COOKIE = 'codecompass_session';
export const OAUTH_STATE_COOKIE = 'codecompass_oauth_state';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
export const OAUTH_STATE_TTL_SECONDS = 60 * 10;

function secretBytes(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Session signing secret is not configured securely');
  }
  return new TextEncoder().encode(secret);
}

export function newOAuthState() {
  return randomBytes(32).toString('base64url');
}

export function signOAuthState(state, secret) {
  const issuedAt = Date.now();
  const signature = createHmac('sha256', secretBytes(secret)).update(`${state}.${issuedAt}`).digest('base64url');
  return `${state}.${issuedAt}.${signature}`;
}

export function verifyOAuthState(state, signedCookie, secret) {
  if (typeof state !== 'string' || typeof signedCookie !== 'string') return false;
  const parts = signedCookie.split('.');
  if (parts.length !== 3 || !/^\d+$/.test(parts[1])) return false;
  const [cookieState, issuedAtText, encodedSignature] = parts;
  const issuedAt = Number(issuedAtText);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > Date.now() + 30_000 || Date.now() - issuedAt > OAUTH_STATE_TTL_SECONDS * 1000) return false;
  const suppliedSignature = Buffer.from(encodedSignature);
  const expectedSignature = Buffer.from(createHmac('sha256', secretBytes(secret)).update(`${cookieState}.${issuedAtText}`).digest('base64url'));
  if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) return false;
  const stateBytes = Buffer.from(state);
  const cookieStateBytes = Buffer.from(cookieState);
  return stateBytes.length === cookieStateBytes.length && timingSafeEqual(stateBytes, cookieStateBytes);
}

export function getCookie(req, name) {
  try { return parse(req.headers.cookie ?? '')[name]; } catch { return undefined; }
}

function cookieOptions(config, path, maxAge) {
  return {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax',
    path,
    maxAge
  };
}

export function setOAuthStateCookie(res, signedState, config) {
  res.append('Set-Cookie', serialize(OAUTH_STATE_COOKIE, signedState,
    cookieOptions(config, '/api/auth/github/callback', OAUTH_STATE_TTL_SECONDS)));
}

export function clearOAuthStateCookie(res, config) {
  res.append('Set-Cookie', serialize(OAUTH_STATE_COOKIE, '', {
    ...cookieOptions(config, '/api/auth/github/callback', 0), expires: new Date(0)
  }));
}

export async function createSessionToken(userId, secret) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer('codecompass-api')
    .setAudience('codecompass-web')
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretBytes(secret));
}

export async function verifySessionToken(token, secret) {
  const { payload } = await jwtVerify(token, secretBytes(secret), {
    algorithms: ['HS256'],
    issuer: 'codecompass-api',
    audience: 'codecompass-web'
  });
  return typeof payload.sub === 'string' ? payload.sub : null;
}

export function setSessionCookie(res, token, config) {
  res.append('Set-Cookie', serialize(SESSION_COOKIE, token,
    cookieOptions(config, '/api', SESSION_TTL_SECONDS)));
}

export function clearSessionCookie(res, config) {
  res.append('Set-Cookie', serialize(SESSION_COOKIE, '', {
    ...cookieOptions(config, '/api', 0), expires: new Date(0)
  }));
}
