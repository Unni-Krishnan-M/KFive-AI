import jwt from 'jsonwebtoken';

export const MIN_PASSWORD_BYTES = 8;
export const MAX_PASSWORD_BYTES = 72;
export const MAX_REFRESH_TOKEN_BYTES = 4096;
export const MAX_ACCESS_TOKEN_BYTES = 4096;
export const AUTH_SESSION_LIMIT = 10;

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');

export function isAcceptedPassword(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const bytes = byteLength(value);
  return bytes >= MIN_PASSWORD_BYTES && bytes <= MAX_PASSWORD_BYTES;
}

export function isAcceptedRefreshToken(value: unknown): value is string {
  return typeof value === 'string'
    && byteLength(value) > 0
    && byteLength(value) <= MAX_REFRESH_TOKEN_BYTES;
}

export function isAcceptedAccessToken(value: unknown): value is string {
  return typeof value === 'string'
    && byteLength(value) > 0
    && byteLength(value) <= MAX_ACCESS_TOKEN_BYTES;
}

export function shouldRemoveRejectedRefreshToken(error: unknown): boolean {
  return error instanceof jwt.TokenExpiredError;
}

export function buildRefreshRotationPipeline(oldHash: string, newHash: string) {
  return [
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
                    cond: { $ne: ['$$tokenHash', oldHash] },
                  },
                },
                [newHash],
              ],
            },
            -AUTH_SESSION_LIMIT,
          ],
        },
      },
    },
  ];
}
