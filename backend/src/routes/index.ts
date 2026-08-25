import { Express } from 'express';
import authRoutes from './auth';
import chatRoutes from './chat';
import userRoutes from './user';
import ollamaRoutes from './ollama';
import agentRoutes from './agent';
import documentRoutes from './document';
import { authenticateToken } from '@/middleware/auth';
import { EnvironmentConfig } from '@/config/environment';
import { getReadiness } from '@/config/health';
import { authLimiter } from '@/middleware/rateLimiter';
import providerRoutes from './provider';
import { createRuntimeRouter } from './runtime';
import modelsRoutes from './models';
import systemRoutes from './system';
import projectsRoutes from './projects';
import codeRoutes from './code';
import knowledgeRoutes from './knowledge';
import repositoriesRoutes from './repositories';
import workflowsRoutes from './workflows';

export function setupRoutes(app: Express, config: EnvironmentConfig): void {
  const apiVersion = config.apiVersion;
  const basePath = `/api/${apiVersion}`;

  // Health check
  app.get(`${basePath}/health`, (req, res) => {
    res.json({
      status: 'healthy',
      mode: config.kfiveMode,
      timestamp: new Date().toISOString(),
      version: apiVersion,
      uptime: process.uptime()
    });
  });

  app.get(`${basePath}/readiness`, (_req, res) => {
    const readiness = getReadiness(config);
    res.status(readiness.statusCode).json(readiness.body);
  });

  // API Routes
  // Public API Routes
  app.use(`${basePath}/auth`, authLimiter, authRoutes);

  // Protected API Routes
  app.use(`${basePath}/chat`, authenticateToken, chatRoutes);
  app.use(`${basePath}/user`, authenticateToken, userRoutes);
  app.use(`${basePath}/ollama`, authenticateToken, ollamaRoutes);
  app.use(`${basePath}/provider`, authenticateToken, providerRoutes);
  app.use(`${basePath}/runtime`, authenticateToken, createRuntimeRouter(config));
  app.use(`${basePath}/settings/providers`, authenticateToken, providerRoutes);
  app.use(`${basePath}/settings/runtime`, authenticateToken, createRuntimeRouter(config));
  app.use(`${basePath}/agents`, authenticateToken, agentRoutes);
  app.use(`${basePath}/documents`, authenticateToken, documentRoutes);
  app.use(`${basePath}/models`, authenticateToken, modelsRoutes);
  app.use(`${basePath}/system`, authenticateToken, systemRoutes);
  app.use(`${basePath}/projects`, authenticateToken, projectsRoutes);
  app.use(`${basePath}/code`, authenticateToken, codeRoutes);
  app.use(`${basePath}/knowledge`, authenticateToken, knowledgeRoutes);
  app.use(`${basePath}/repositories`, authenticateToken, repositoriesRoutes);
  app.use(`${basePath}/workflows`, authenticateToken, workflowsRoutes);
}
