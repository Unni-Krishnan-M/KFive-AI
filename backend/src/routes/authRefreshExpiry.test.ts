import { createHash, randomUUID } from 'crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import { parseEnvironment } from '@/config/environment';
import { errorHandler } from '@/middleware/errorHandler';
import { User } from '@/models/User';
import { deriveCookieCsrf } from '@/security/authCookie';
import { closeHttpServerIfListening } from '@/utils/httpServer';
import { createAuthRouter } from './auth';

jest.mock('@/utils/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const origin = 'https://auth-expiry.example.invalid';
const config = parseEnvironment({
  NODE_ENV: 'production',
  MONGODB_URL: 'mongodb://localhost/kfive_auth_expiry_test',
  REDIS_URL: 'redis://localhost:6379',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  CORS_ORIGIN: origin,
  JWT_SECRET: 'access-key-0123456789-abcdefghijklmnopqrstuvwxyz',
  JWT_REFRESH_SECRET: 'refresh-key-0123456789-abcdefghijklmnopqrstuvwx',
});

function expiredRefreshToken(secret = config.jwtRefreshSecret): string {
  return jwt.sign({
    userId: '507f1f77bcf86cd799439011',
    email: 'expiry@example.invalid',
    role: 'user',
    type: 'refresh',
  }, secret, {
    algorithm: 'HS256',
    issuer: 'kfive-ai',
    audience: 'kfive-web',
    expiresIn: -1,
    jwtid: randomUUID(),
  });
}

async function requestRefresh(token: string) {
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRouter(config));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    return await fetch(`http://127.0.0.1:${port}/auth/refresh`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        'x-kfive-auth-transport': 'cookie',
        'x-kfive-csrf': deriveCookieCsrf(token, config.jwtRefreshSecret),
        cookie: `__Host-kfive-refresh=${token}`,
      },
      body: '{}',
    });
  } finally {
    await closeHttpServerIfListening(server);
  }
}

afterEach(() => jest.restoreAllMocks());

describe('expired refresh session cleanup', () => {
  it('atomically removes a stored expired hash and clears that browser cookie', async () => {
    const token = expiredRefreshToken();
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const update = jest.spyOn(User, 'updateOne').mockResolvedValue({ matchedCount: 1, modifiedCount: 1 } as never);

    const response = await requestRefresh(token);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { message: 'Invalid or expired refresh token' } });
    expect(response.headers.get('set-cookie')).toMatch(/^__Host-kfive-refresh=; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=0;/);
    expect(update).toHaveBeenCalledWith(
      { refreshTokens: tokenHash },
      { $pull: { refreshTokens: tokenHash } },
    );
  });

  it('does not let an expired stale predecessor clear a successor cookie when its hash is absent', async () => {
    const token = expiredRefreshToken();
    jest.spyOn(User, 'updateOne').mockResolvedValue({ matchedCount: 0, modifiedCount: 0 } as never);

    const response = await requestRefresh(token);

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('does not write session state for a bad refresh signature', async () => {
    const token = expiredRefreshToken('different-refresh-key-0123456789-abcdefghijklmnop');
    const update = jest.spyOn(User, 'updateOne').mockResolvedValue({ matchedCount: 0, modifiedCount: 0 } as never);

    const response = await requestRefresh(token);

    expect(response.status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });
});
