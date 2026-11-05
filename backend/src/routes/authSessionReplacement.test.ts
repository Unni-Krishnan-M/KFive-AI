import { createHash, randomUUID } from 'crypto';
import express from 'express';
import jwt, { SignOptions } from 'jsonwebtoken';
import { Types } from 'mongoose';
import { AddressInfo } from 'net';
import { parseEnvironment } from '@/config/environment';
import { errorHandler } from '@/middleware/errorHandler';
import { User } from '@/models/User';
import { closeHttpServerIfListening } from '@/utils/httpServer';
import { createAuthRouter } from './auth';

jest.mock('@/utils/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const origin = 'https://auth-replacement.example.invalid';
const config = parseEnvironment({
  NODE_ENV: 'production',
  MONGODB_URL: 'mongodb://localhost/kfive_auth_replacement_test',
  REDIS_URL: 'redis://localhost:6379',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  CORS_ORIGIN: origin,
  JWT_SECRET: 'access-key-0123456789-abcdefghijklmnopqrstuvwxyz',
  JWT_REFRESH_SECRET: 'refresh-key-0123456789-abcdefghijklmnopqrstuvwx',
});

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

function refreshToken(userId: Types.ObjectId, secret = config.jwtRefreshSecret, expiresIn: string | number = '1h'): string {
  return jwt.sign({ userId: userId.toString(), email: 'predecessor@example.invalid', role: 'user', type: 'refresh' }, secret, {
    algorithm: 'HS256', issuer: 'kfive-ai', audience: 'kfive-web', expiresIn: expiresIn as SignOptions['expiresIn'], jwtid: randomUUID(),
  });
}

function userFixture(id: Types.ObjectId, successor = 'successor.refresh.token') {
  return {
    _id: id,
    email: 'target@example.invalid',
    username: 'target_user',
    comparePassword: jest.fn().mockResolvedValue(true),
    generateTokens: jest.fn().mockReturnValue({ accessToken: 'successor.access.token', refreshToken: successor }),
  };
}

async function request(path: '/login' | '/register', body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRouter(config));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    return await fetch(`http://127.0.0.1:${port}/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } finally {
    await closeHttpServerIfListening(server);
  }
}

const browserHeaders = (token: string) => ({
  origin,
  'x-kfive-auth-transport': 'cookie',
  cookie: `__Host-kfive-refresh=${token}`,
});

afterEach(() => jest.restoreAllMocks());

describe('browser session replacement', () => {
  it('revokes the presented predecessor before appending a login successor', async () => {
    const predecessorOwner = new Types.ObjectId();
    const targetId = new Types.ObjectId();
    const predecessor = refreshToken(predecessorOwner);
    const successor = 'successor.login.token';
    const user = userFixture(targetId, successor);
    jest.spyOn(User, 'findOne').mockReturnValue({ select: jest.fn().mockResolvedValue(user) } as never);
    const update = jest.spyOn(User, 'updateOne').mockResolvedValue({ matchedCount: 1, modifiedCount: 1 } as never);

    const response = await request('/login', { email: user.email, password: 'ValidPassword!' }, browserHeaders(predecessor));

    expect(response.status).toBe(200);
    expect(update).toHaveBeenNthCalledWith(1,
      { _id: predecessorOwner, refreshTokens: hash(predecessor) },
      { $pull: { refreshTokens: hash(predecessor) } },
    );
    expect(update).toHaveBeenNthCalledWith(2,
      { _id: targetId },
      { $push: { refreshTokens: { $each: [hash(successor)], $slice: -10 } } },
    );
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[1]);
    expect(response.headers.get('set-cookie')).toMatch(/^__Host-kfive-refresh=successor\.login\.token;/);
  });

  it('revokes a presented predecessor before appending a registration successor', async () => {
    const predecessorOwner = new Types.ObjectId();
    const targetId = new Types.ObjectId();
    const predecessor = refreshToken(predecessorOwner);
    const successor = 'successor.registration.token';
    const user = userFixture(targetId, successor);
    jest.spyOn(User, 'findOne').mockResolvedValue(null);
    jest.spyOn(User, 'create').mockResolvedValue(user as never);
    const update = jest.spyOn(User, 'updateOne').mockResolvedValue({ matchedCount: 1, modifiedCount: 1 } as never);

    const response = await request('/register', {
      email: user.email, username: user.username, password: 'ValidPassword!',
    }, browserHeaders(predecessor));

    expect(response.status).toBe(201);
    expect(update).toHaveBeenNthCalledWith(1,
      { _id: predecessorOwner, refreshTokens: hash(predecessor) },
      { $pull: { refreshTokens: hash(predecessor) } },
    );
    expect(update).toHaveBeenNthCalledWith(2,
      { _id: targetId },
      { $push: { refreshTokens: { $each: [hash(successor)], $slice: -10 } } },
    );
  });

  it('uses the same revoke-before-append ordering for same-account login replacement', async () => {
    const userId = new Types.ObjectId();
    const predecessor = refreshToken(userId);
    const user = userFixture(userId);
    jest.spyOn(User, 'findOne').mockReturnValue({ select: jest.fn().mockResolvedValue(user) } as never);
    const update = jest.spyOn(User, 'updateOne').mockResolvedValue({ matchedCount: 1, modifiedCount: 1 } as never);

    const response = await request('/login', { email: user.email, password: 'ValidPassword!' }, browserHeaders(predecessor));

    expect(response.status).toBe(200);
    expect(update).toHaveBeenNthCalledWith(1,
      { _id: userId, refreshTokens: hash(predecessor) },
      { $pull: { refreshTokens: hash(predecessor) } },
    );
    expect(update).toHaveBeenNthCalledWith(2, { _id: userId }, expect.objectContaining({ $push: expect.any(Object) }));
  });

  it('does not revoke a predecessor when login credentials fail', async () => {
    jest.spyOn(User, 'findOne').mockReturnValue({ select: jest.fn().mockResolvedValue(null) } as never);
    const update = jest.spyOn(User, 'updateOne');

    const response = await request('/login', {
      email: 'missing@example.invalid', password: 'ValidPassword!',
    }, browserHeaders(refreshToken(new Types.ObjectId())));

    expect(response.status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it('does not revoke a predecessor when registration is rejected as duplicate', async () => {
    jest.spyOn(User, 'findOne').mockResolvedValue({ _id: new Types.ObjectId() } as never);
    const update = jest.spyOn(User, 'updateOne');

    const response = await request('/register', {
      email: 'duplicate@example.invalid', username: 'duplicate_user', password: 'ValidPassword!',
    }, browserHeaders(refreshToken(new Types.ObjectId())));

    expect(response.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('removes an exact expired predecessor hash before appending the successor', async () => {
    const targetId = new Types.ObjectId();
    const predecessor = refreshToken(new Types.ObjectId(), config.jwtRefreshSecret, -1);
    const user = userFixture(targetId);
    jest.spyOn(User, 'findOne').mockReturnValue({ select: jest.fn().mockResolvedValue(user) } as never);
    const update = jest.spyOn(User, 'updateOne').mockResolvedValue({ matchedCount: 1, modifiedCount: 1 } as never);

    const response = await request('/login', { email: user.email, password: 'ValidPassword!' }, browserHeaders(predecessor));

    expect(response.status).toBe(200);
    expect(update).toHaveBeenNthCalledWith(1,
      { refreshTokens: hash(predecessor) },
      { $pull: { refreshTokens: hash(predecessor) } },
    );
    expect(update).toHaveBeenNthCalledWith(2, { _id: targetId }, expect.objectContaining({ $push: expect.any(Object) }));
  });

  it('fails closed before successor append when predecessor revocation errors', async () => {
    const targetId = new Types.ObjectId();
    const user = userFixture(targetId);
    jest.spyOn(User, 'findOne').mockReturnValue({ select: jest.fn().mockResolvedValue(user) } as never);
    const update = jest.spyOn(User, 'updateOne').mockRejectedValue(new Error('datastore unavailable'));

    const response = await request('/login', {
      email: user.email, password: 'ValidPassword!',
    }, browserHeaders(refreshToken(new Types.ObjectId())));

    expect(response.status).toBe(500);
    expect(update).toHaveBeenCalledTimes(1);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('ignores an untrusted predecessor signature and appends only the successor', async () => {
    const targetId = new Types.ObjectId();
    const user = userFixture(targetId);
    const untrusted = refreshToken(new Types.ObjectId(), 'different-refresh-key-0123456789-abcdefghijklmnop');
    jest.spyOn(User, 'findOne').mockReturnValue({ select: jest.fn().mockResolvedValue(user) } as never);
    const update = jest.spyOn(User, 'updateOne').mockResolvedValue({ matchedCount: 1, modifiedCount: 1 } as never);

    const response = await request('/login', { email: user.email, password: 'ValidPassword!' }, browserHeaders(untrusted));

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ _id: targetId }, expect.objectContaining({ $push: expect.any(Object) }));
  });

  it('overwrites a malformed predecessor on successful login without mutating another session', async () => {
    const targetId = new Types.ObjectId();
    const user = userFixture(targetId);
    jest.spyOn(User, 'findOne').mockReturnValue({ select: jest.fn().mockResolvedValue(user) } as never);
    const update = jest.spyOn(User, 'updateOne').mockResolvedValue({ matchedCount: 1, modifiedCount: 1 } as never);

    const response = await request('/login', { email: user.email, password: 'ValidPassword!' }, browserHeaders('malformed token'));

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ _id: targetId }, expect.objectContaining({ $push: expect.any(Object) }));
    expect(response.headers.get('set-cookie')).toMatch(/^__Host-kfive-refresh=successor\.refresh\.token;/);
  });

  it('keeps legacy JSON login multi-session behavior even when a Cookie header is present', async () => {
    const targetId = new Types.ObjectId();
    const user = userFixture(targetId);
    jest.spyOn(User, 'findOne').mockReturnValue({ select: jest.fn().mockResolvedValue(user) } as never);
    const update = jest.spyOn(User, 'updateOne').mockResolvedValue({ matchedCount: 1, modifiedCount: 1 } as never);

    const response = await request('/login', { email: user.email, password: 'ValidPassword!' }, {
      cookie: `__Host-kfive-refresh=${refreshToken(new Types.ObjectId())}`,
    });

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ _id: targetId }, expect.objectContaining({ $push: expect.any(Object) }));
    expect((await response.json() as any).data.refreshToken).toBe('successor.refresh.token');
  });
});
