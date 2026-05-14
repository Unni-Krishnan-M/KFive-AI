import { Express } from 'express';
import authRoutes from './auth';
import chatRoutes from './chat';
import userRoutes from './user';
import ollamaRoutes from './ollama';
import agentRoutes from './agent';
import documentRoutes from './document';
import { authenticateToken } from '@/middleware/auth';

export function setupRoutes(app: Express): void {
  const apiVersion = process.env.API_VERSION || 'v1';
  const basePath = `/api/${apiVersion}`;

  // Health check
  app.get(`${basePath}/health`, (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: apiVersion,
      uptime: process.uptime()
    });
  });

  // API Routes
  // Public API Routes
  app.use(`${basePath}/auth`, authRoutes);

  // Protected API Routes
  app.use(`${basePath}/chat`, authenticateToken, chatRoutes);
  app.use(`${basePath}/user`, authenticateToken, userRoutes);
  app.use(`${basePath}/ollama`, authenticateToken, ollamaRoutes);
  app.use(`${basePath}/agents`, authenticateToken, agentRoutes);
  app.use(`${basePath}/documents`, authenticateToken, documentRoutes);
}