import { Response, Router } from 'express';
import { getAuthenticatedUserId } from '@/middleware/auth';
import { asyncHandler } from '@/middleware/errorHandler';
import {
  InMemoryProjectDeletionConfirmationStore,
  ProjectDeletionConfirmationStore,
  ProjectError,
  ProjectService,
  projectService,
} from '@/services/projectService';

const deletionConfirmations = new InMemoryProjectDeletionConfirmationStore();

function handleProjectError(res: Response, error: unknown): boolean {
  if (!(error instanceof ProjectError)) return false;
  res.status(error.statusCode).json({
    success: false,
    error: { code: error.code, message: error.message },
  });
  return true;
}

export function createProjectsRouter(
  service: ProjectService = projectService,
  confirmations: ProjectDeletionConfirmationStore = deletionConfirmations
): Router {
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    try {
      const projects = await service.list(getAuthenticatedUserId(req), req.query.status);
      res.json({ success: true, data: { projects, count: projects.length } });
    } catch (error) {
      if (!handleProjectError(res, error)) throw error;
    }
  }));

  router.post('/', asyncHandler(async (req, res) => {
    try {
      const project = await service.create(getAuthenticatedUserId(req), req.body);
      res.status(201).json({ success: true, data: { project } });
    } catch (error) {
      if (!handleProjectError(res, error)) throw error;
    }
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    try {
      const project = await service.get(getAuthenticatedUserId(req), req.params.id);
      res.json({ success: true, data: { project } });
    } catch (error) {
      if (!handleProjectError(res, error)) throw error;
    }
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    try {
      const project = await service.update(getAuthenticatedUserId(req), req.params.id, req.body);
      res.json({ success: true, data: { project } });
    } catch (error) {
      if (!handleProjectError(res, error)) throw error;
    }
  }));

  router.post('/:id/archive', asyncHandler(async (req, res) => {
    try {
      const project = await service.update(getAuthenticatedUserId(req), req.params.id, { status: 'archived' });
      res.json({ success: true, data: { project } });
    } catch (error) {
      if (!handleProjectError(res, error)) throw error;
    }
  }));

  router.post('/:id/restore', asyncHandler(async (req, res) => {
    try {
      const project = await service.update(getAuthenticatedUserId(req), req.params.id, { status: 'active' });
      res.json({ success: true, data: { project } });
    } catch (error) {
      if (!handleProjectError(res, error)) throw error;
    }
  }));

  router.post('/:id/delete-confirmation', asyncHandler(async (req, res) => {
    try {
      const ownerId = getAuthenticatedUserId(req);
      const project = await service.get(ownerId, req.params.id);
      const projectId = String(project._id);
      const confirmation = confirmations.issue({ ownerId, projectId });
      res.json({ success: true, data: { projectId, ...confirmation } });
    } catch (error) {
      if (!handleProjectError(res, error)) throw error;
    }
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    try {
      const ownerId = getAuthenticatedUserId(req);
      const projectId = req.params.id;
      confirmations.consume(req.body?.confirmationToken, { ownerId, projectId });
      await service.delete(ownerId, projectId);
      res.json({ success: true, data: { projectId, deleted: true } });
    } catch (error) {
      if (!handleProjectError(res, error)) throw error;
    }
  }));

  return router;
}

export default createProjectsRouter();

