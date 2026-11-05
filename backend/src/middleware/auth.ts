import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from './errorHandler';
import { isAcceptedAccessToken } from '@/security/authPolicy';

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    email: string;
    role: string;
  };
}

export interface AuthenticatedIdentity {
  userId: string;
  email: string;
  role: string;
}

export function verifyAccessToken(token: unknown): AuthenticatedIdentity {
  if (!isAcceptedAccessToken(token)) throw new AppError('Access token required', 401);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!, {
      algorithms: ['HS256'],
      issuer: 'kfive-ai',
      audience: 'kfive-web',
    });
    if (typeof decoded === 'string'
      || decoded.type !== 'access'
      || typeof decoded.userId !== 'string'
      || typeof decoded.email !== 'string'
      || typeof decoded.role !== 'string') {
      throw new jwt.JsonWebTokenError('Invalid token payload');
    }
    return { userId: decoded.userId, email: decoded.email, role: decoded.role };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) throw new AppError('Token expired', 401);
    if (error instanceof jwt.JsonWebTokenError) throw new AppError('Invalid token', 401);
    if (error instanceof AppError) throw error;
    throw new AppError('Authentication failed', 401);
  }
}

export function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const match = typeof authHeader === 'string' ? /^Bearer ([^\s]+)$/.exec(authHeader) : null;
  const token = match?.[1];

  req.user = verifyAccessToken(token);
  next();
}

export function getAuthenticatedUserId(req: Request): string {
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) throw new AppError('Authentication required', 401);
  return userId;
}

export function requireRole(roles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw new AppError('Authentication required', 401);
    }

    if (!roles.includes(req.user.role)) {
      throw new AppError('Insufficient permissions', 403);
    }

    next();
  };
}
