import { createHmac, timingSafeEqual } from 'crypto';
import { AppError } from '@/middleware/errorHandler';
import { isAcceptedRefreshToken } from './authPolicy';

type NodeEnvironment = 'development' | 'test' | 'production';

const COOKIE_HEADER_MAX_BYTES = 8192;
const COOKIE_PART_LIMIT = 64;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
const REFRESH_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const CSRF_CONTEXT = 'kfive-browser-refresh-csrf-v1\0';

export function browserCookieName(nodeEnv: NodeEnvironment): string {
  return nodeEnv === 'production' ? '__Host-kfive-refresh' : 'kfive-refresh';
}

function cookiePolicy(nodeEnv: NodeEnvironment): string {
  return `Path=/; HttpOnly${nodeEnv === 'production' ? '; Secure' : ''}; SameSite=Strict`;
}

export function serializeRefreshCookie(token: string, nodeEnv: NodeEnvironment): string {
  if (!isAcceptedRefreshToken(token) || !/^[A-Za-z0-9._~-]+$/.test(token)) {
    throw new AppError('Invalid refresh token for browser cookie', 500);
  }
  return `${browserCookieName(nodeEnv)}=${token}; ${cookiePolicy(nodeEnv)}; Max-Age=${REFRESH_MAX_AGE_SECONDS}`;
}

export function clearRefreshCookie(nodeEnv: NodeEnvironment): string {
  return `${browserCookieName(nodeEnv)}=; ${cookiePolicy(nodeEnv)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function parseRefreshCookie(header: string | undefined, nodeEnv: NodeEnvironment): string | undefined {
  if (header === undefined || header === '') return undefined;
  if (Buffer.byteLength(header, 'utf8') > COOKIE_HEADER_MAX_BYTES) throw new AppError('Cookie header is too large', 400);
  const parts = header.split(';');
  if (parts.length > COOKIE_PART_LIMIT) throw new AppError('Cookie header has too many entries', 400);
  const target = browserCookieName(nodeEnv);
  let result: string | undefined;
  for (const rawPart of parts) {
    const part = rawPart.trim();
    const separator = part.indexOf('=');
    if (separator < 1 || hasControlCharacter(part)) throw new AppError('Malformed Cookie header', 400);
    const name = part.slice(0, separator);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new AppError('Malformed Cookie header', 400);
    if (name !== target) continue;
    if (result !== undefined) throw new AppError('Duplicate refresh cookie', 400);
    result = part.slice(separator + 1);
  }
  if (result !== undefined && (!isAcceptedRefreshToken(result) || !/^[A-Za-z0-9._~-]+$/.test(result))) {
    throw new AppError('Invalid refresh cookie', 400);
  }
  return result;
}

export function deriveCookieCsrf(refreshToken: string, refreshSecret: string): string {
  if (!isAcceptedRefreshToken(refreshToken)) throw new AppError('Invalid refresh token', 400);
  return createHmac('sha256', refreshSecret).update(CSRF_CONTEXT).update(refreshToken).digest('base64url');
}

export function assertCookieCsrf(refreshToken: string, supplied: unknown, refreshSecret: string): void {
  const expected = deriveCookieCsrf(refreshToken, refreshSecret);
  if (typeof supplied !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) {
    throw new AppError('Valid browser CSRF token required', 403);
  }
  const expectedBuffer = Buffer.from(expected, 'ascii');
  const suppliedBuffer = Buffer.from(supplied, 'ascii');
  if (!timingSafeEqual(expectedBuffer, suppliedBuffer)) throw new AppError('Valid browser CSRF token required', 403);
}
