import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from './errorHandler';

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    email: string;
    role: string;
  };
}

export function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    throw new AppError('Access token required', 401);
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!, {
      algorithms: ['HS256'],
      issuer: 'kfive-ai',
      audience: 'kfive-web',
    });

    if (typeof decoded === 'string' || typeof decoded.userId !== 'string' || typeof decoded.email !== 'string' || typeof decoded.role !== 'string') {
      throw new jwt.JsonWebTokenError('Invalid token payload');
    }

    req.user = { userId: decoded.userId, email: decoded.email, role: decoded.role };
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AppError('Token expired', 401);
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new AppError('Invalid token', 401);
    } else {
      throw new AppError('Authentication failed', 401);
    }
  }
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
