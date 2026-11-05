import jwt from 'jsonwebtoken';
import {
  AUTH_SESSION_LIMIT,
  MAX_PASSWORD_BYTES,
  MAX_REFRESH_TOKEN_BYTES,
  buildRefreshRotationPipeline,
  isAcceptedPassword,
  isAcceptedRefreshToken,
  shouldRemoveRejectedRefreshToken,
} from './authPolicy';

describe('authentication policy', () => {
  it('enforces the bcrypt password boundary in UTF-8 bytes', () => {
    expect(isAcceptedPassword('12345678')).toBe(true);
    expect(isAcceptedPassword('1234567')).toBe(false);
    expect(isAcceptedPassword('a'.repeat(MAX_PASSWORD_BYTES))).toBe(true);
    expect(isAcceptedPassword('a'.repeat(MAX_PASSWORD_BYTES + 1))).toBe(false);
    expect(isAcceptedPassword('é'.repeat(MAX_PASSWORD_BYTES / 2))).toBe(true);
    expect(isAcceptedPassword(`a${'é'.repeat(MAX_PASSWORD_BYTES / 2)}`)).toBe(false);
    expect(isAcceptedPassword(12345678)).toBe(false);
  });

  it('bounds refresh-token input before hashing or verification', () => {
    expect(isAcceptedRefreshToken('a')).toBe(true);
    expect(isAcceptedRefreshToken('a'.repeat(MAX_REFRESH_TOKEN_BYTES))).toBe(true);
    expect(isAcceptedRefreshToken('a'.repeat(MAX_REFRESH_TOKEN_BYTES + 1))).toBe(false);
    expect(isAcceptedRefreshToken('')).toBe(false);
    expect(isAcceptedRefreshToken(null)).toBe(false);
  });

  it('builds a one-use rotation that removes the consumed hash and retains ten sessions', () => {
    const pipeline = buildRefreshRotationPipeline('old-hash', 'new-hash');

    expect(AUTH_SESSION_LIMIT).toBe(10);
    expect(pipeline).toEqual([
      {
        $set: {
          refreshTokens: {
            $slice: [
              {
                $concatArrays: [
                  {
                    $filter: {
                      input: { $ifNull: ['$refreshTokens', []] },
                      as: 'tokenHash',
                      cond: { $ne: ['$$tokenHash', 'old-hash'] },
                    },
                  },
                  ['new-hash'],
                ],
              },
              -AUTH_SESSION_LIMIT,
            ],
          },
        },
      },
    ]);
  });

  it('only cleans up a rejected token after authenticated expiry', () => {
    expect(shouldRemoveRejectedRefreshToken(new jwt.TokenExpiredError('expired', new Date()))).toBe(true);
    expect(shouldRemoveRejectedRefreshToken(new jwt.JsonWebTokenError('bad signature'))).toBe(false);
    expect(shouldRemoveRejectedRefreshToken(new Error('untrusted input'))).toBe(false);
  });
});
