import jwt from 'jsonwebtoken';
import { authenticateToken } from './auth';

const secret = '01234567890123456789012345678901';
const payload = { userId: '507f1f77bcf86cd799439011', email: 'user@example.invalid', role: 'user' };

describe('access-token type boundary', () => {
  const previousSecret = process.env.JWT_SECRET;

  beforeAll(() => { process.env.JWT_SECRET = secret; });
  afterAll(() => { process.env.JWT_SECRET = previousSecret; });

  it('accepts only an explicitly typed access token', () => {
    const token = jwt.sign({ ...payload, type: 'access' }, secret, {
      algorithm: 'HS256', issuer: 'kfive-ai', audience: 'kfive-web', expiresIn: '15m',
    });
    const request = { headers: { authorization: `Bearer ${token}` } } as any;
    const next = jest.fn();
    expect(() => authenticateToken(request, {} as any, next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
    expect(request.user).toEqual(payload);
  });

  it('rejects a refresh token even when it is signed with the access key', () => {
    const token = jwt.sign({ ...payload, type: 'refresh' }, secret, {
      algorithm: 'HS256', issuer: 'kfive-ai', audience: 'kfive-web', expiresIn: '7d',
    });
    const request = { headers: { authorization: `Bearer ${token}` } } as any;
    expect(() => authenticateToken(request, {} as any, jest.fn())).toThrow('Invalid token');
  });
});
