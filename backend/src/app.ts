import compression from 'compression';
import cors from 'cors';
import express, { Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { randomUUID } from 'crypto';
import { EnvironmentConfig } from './config/environment';
import { errorHandler, notFound } from './middleware/errorHandler';
import { setupRoutes } from './routes';
import { logger } from './utils/logger';
import { getLiveness } from './config/health';

export const ALLOWED_CORS_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export function createApp(config: EnvironmentConfig): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const requestId = req.header('x-request-id') || randomUUID();
    res.setHeader('x-request-id', requestId);
    const startedAt = Date.now();
    res.on('finish', () => {
      logger.info('HTTP request', {
        requestId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  });

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
  }));

  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
    methods: [...ALLOWED_CORS_METHODS],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-refresh-token', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
  }));

  app.use('/api/', rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 900_000),
    max: Number(process.env.RATE_LIMIT_MAX_REQUESTS || 100),
    message: { success: false, error: { message: 'Too many requests from this IP' } },
    standardHeaders: true,
    legacyHeaders: false,
  }));

  app.use(compression());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json(getLiveness(config));
  });

  setupRoutes(app, config);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
