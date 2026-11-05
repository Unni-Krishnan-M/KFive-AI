import {
  assertCookieCsrf,
  browserCookieName,
  clearRefreshCookie,
  deriveCookieCsrf,
  parseRefreshCookie,
  serializeRefreshCookie,
} from './authCookie';

const secret = 'abcdefghijklmnopqrstuvwxyz123456';
const token = 'header.payload.signature';

describe('browser refresh cookie security contract', () => {
  it('emits an exact production host cookie and matching clear policy', () => {
    expect(browserCookieName('production')).toBe('__Host-kfive-refresh');
    const cookie = serializeRefreshCookie(token, 'production');
    expect(cookie).toContain('__Host-kfive-refresh=header.payload.signature');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Max-Age=604800');
    expect(cookie).not.toMatch(/Domain=/i);
    expect(clearRefreshCookie('production')).toContain('__Host-kfive-refresh=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  });

  it('uses a clearly bounded non-Secure local-development cookie', () => {
    expect(browserCookieName('development')).toBe('kfive-refresh');
    const cookie = serializeRefreshCookie(token, 'development');
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('parses only one bounded exact cookie and rejects malformed ambiguity', () => {
    expect(parseRefreshCookie(`theme=dark; ${browserCookieName('production')}=${token}`, 'production')).toBe(token);
    expect(() => parseRefreshCookie(`${browserCookieName('production')}=${token}; ${browserCookieName('production')}=other`, 'production')).toThrow(/duplicate/i);
    expect(() => parseRefreshCookie('malformed', 'production')).toThrow(/malformed/i);
    expect(() => parseRefreshCookie(`x=${'a'.repeat(8193)}`, 'production')).toThrow(/too large/i);
    expect(() => parseRefreshCookie(`${browserCookieName('production')}=${'a'.repeat(4097)}`, 'production')).toThrow(/invalid/i);
  });

  it('derives a domain-separated CSRF value and compares it safely', () => {
    const csrf = deriveCookieCsrf(token, secret);
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deriveCookieCsrf(token, secret)).toBe(csrf);
    expect(deriveCookieCsrf(`${token}x`, secret)).not.toBe(csrf);
    expect(() => assertCookieCsrf(token, csrf, secret)).not.toThrow();
    expect(() => assertCookieCsrf(token, `${csrf.slice(0, -1)}x`, secret)).toThrow(/CSRF/i);
    expect(() => assertCookieCsrf(token, 'short', secret)).toThrow(/CSRF/i);
    expect(() => assertCookieCsrf(token, 'é'.repeat(csrf.length), secret)).toThrow(/CSRF/i);
    const asciiTruncationAlias = [...csrf]
      .map((character) => String.fromCharCode(character.charCodeAt(0) + 256))
      .join('');
    expect(() => assertCookieCsrf(token, asciiTruncationAlias, secret)).toThrow(/CSRF/i);
  });
});
