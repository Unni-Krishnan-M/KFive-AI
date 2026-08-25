import { Router } from 'express';
import {
  InMemoryProjectDeletionConfirmationStore,
  ProjectError,
  ProjectRecord,
  ProjectService,
} from '@/services/projectService';
import { createProjectsRouter } from './projects';

const ownerId = '64b000000000000000000001';
const projectId = '64b000000000000000000101';
const project: ProjectRecord = {
  _id: projectId,
  ownerId,
  name: 'KFive',
  description: '',
  tags: [],
  status: 'active',
};

function fakeService(overrides: Partial<Record<keyof ProjectService, jest.Mock>> = {}): ProjectService {
  return {
    list: jest.fn().mockResolvedValue([project]),
    create: jest.fn().mockResolvedValue(project),
    get: jest.fn().mockResolvedValue(project),
    update: jest.fn().mockResolvedValue(project),
    delete: jest.fn().mockResolvedValue(project),
    ...overrides,
  } as unknown as ProjectService;
}

function invoke(
  router: Router,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  values: { body?: any; query?: any; params?: any; userId?: string } = {}
): Promise<{ status: number; body: any }> {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === path && entry.route.methods[method]);
  const handler = layer.route.stack[0].handle;
  return new Promise((resolve, reject) => {
    let status = 200;
    const request = {
      body: values.body || {},
      query: values.query || {},
      params: values.params || {},
      user: { userId: values.userId || ownerId, email: 'user@example.com', role: 'user' },
    };
    const response = {
      status(code: number) { status = code; return this; },
      json(body: any) { resolve({ status, body }); return this; },
    };
    handler(request, response, reject);
  });
}

describe('projects routes', () => {
  it('lists and creates projects for the authenticated owner', async () => {
    const service = fakeService();
    const router = createProjectsRouter(service);
    const listed = await invoke(router, 'get', '/', { query: { status: 'active' } });
    const created = await invoke(router, 'post', '/', { body: { name: 'KFive' } });

    expect(listed).toEqual({ status: 200, body: { success: true, data: { projects: [project], count: 1 } } });
    expect(created).toEqual({ status: 201, body: { success: true, data: { project } } });
    expect(service.list).toHaveBeenCalledWith(ownerId, 'active');
    expect(service.create).toHaveBeenCalledWith(ownerId, { name: 'KFive' });
  });

  it('gets, renames, archives, and restores only through owner-scoped service calls', async () => {
    const service = fakeService();
    const router = createProjectsRouter(service);
    const params = { id: projectId };

    await invoke(router, 'get', '/:id', { params });
    await invoke(router, 'patch', '/:id', { params, body: { name: 'Renamed' } });
    await invoke(router, 'post', '/:id/archive', { params });
    await invoke(router, 'post', '/:id/restore', { params });

    expect(service.get).toHaveBeenCalledWith(ownerId, projectId);
    expect(service.update).toHaveBeenNthCalledWith(1, ownerId, projectId, { name: 'Renamed' });
    expect(service.update).toHaveBeenNthCalledWith(2, ownerId, projectId, { status: 'archived' });
    expect(service.update).toHaveBeenNthCalledWith(3, ownerId, projectId, { status: 'active' });
  });

  it('returns a stable 404 without exposing cross-owner project details', async () => {
    const service = fakeService({
      get: jest.fn().mockRejectedValue(new ProjectError('Project not found.', 'PROJECT_NOT_FOUND', 404)),
    });
    const result = await invoke(createProjectsRouter(service), 'get', '/:id', { params: { id: projectId } });
    expect(result).toEqual({
      status: 404,
      body: { success: false, error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found.' } },
    });
  });

  it('requires a matching one-use confirmation before deletion', async () => {
    const service = fakeService();
    const confirmations = new InMemoryProjectDeletionConfirmationStore(
      60_000,
      () => Date.parse('2026-01-01T00:00:00.000Z'),
      () => 'd'.repeat(32)
    );
    const router = createProjectsRouter(service, confirmations);
    const params = { id: projectId };
    const issued = await invoke(router, 'post', '/:id/delete-confirmation', { params });
    const token = issued.body.data.confirmationToken;

    const deleted = await invoke(router, 'delete', '/:id', { params, body: { confirmationToken: token } });
    expect(deleted).toEqual({
      status: 200,
      body: { success: true, data: { projectId, deleted: true } },
    });
    expect(service.delete).toHaveBeenCalledWith(ownerId, projectId);

    const repeated = await invoke(router, 'delete', '/:id', { params, body: { confirmationToken: token } });
    expect(repeated).toMatchObject({
      status: 409,
      body: { error: { code: 'INVALID_PROJECT_DELETE_CONFIRMATION' } },
    });
    expect(service.delete).toHaveBeenCalledTimes(1);
  });
});

