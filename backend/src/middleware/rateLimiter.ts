import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';

// General API rate limiting
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    success: false,
    error: {
      message: 'Too many requests from this IP, please try again later.',
      type: 'RATE_LIMIT_EXCEEDED'
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limiting for auth endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 auth requests per windowMs
  message: {
    success: false,
    error: {
      message: 'Too many authentication attempts, please try again later.',
      type: 'AUTH_RATE_LIMIT_EXCEEDED'
    }
  },
  skipSuccessfulRequests: true,
});

// AI endpoint rate limiting
export const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // Limit each IP to 10 AI requests per minute
  message: {
    success: false,
    error: {
      message: 'Too many AI requests, please wait before trying again.',
      type: 'AI_RATE_LIMIT_EXCEEDED'
    }
  },
});