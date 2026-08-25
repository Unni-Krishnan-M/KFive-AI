import {
  InMemoryProjectDeletionConfirmationStore,
  ProjectError,
  ProjectRecord,
  ProjectRepository,
  ProjectService,
  validateProjectCreateInput,
  validateProjectUpdateInput,
} from './projectService';

const ownerId = '64b000000000000000000001';
const otherOwnerId = '64b000000000000000000002';
const projectId = '64b000000000000000000101';
const timestamp = new Date('2026-01-01T00:00:00.000Z');

const existing: ProjectRecord = {
  _id: projectId,
  ownerId,
  name: 'Original',
  description: '',
  tags: [],
  status: 'active',
};

function repository(overrides: Partial<ProjectRepository> = {}): ProjectRepository {
  return {
    list: async () => [existing],
    create: async (data) => ({ _id: projectId, ...data }),
    findByOwnerAndId: async (requestedOwner, requestedId) => (
      requestedOwner === ownerId && requestedId === projectId ? existing : null
    ),
    updateByOwnerAndId: async (_owner, _id, changes) => ({ ...existing, ...changes }),
    deleteByOwnerAndId: async (requestedOwner, requestedId) => (
      requestedOwner === ownerId && requestedId === projectId ? existing : null
    ),
    ...overrides,
  };
}

describe('project input validation', () => {
  it('normalizes create/update fields and rejects unknown fields', () => {
    expect(validateProjectCreateInput({ name: '  Project  ', tags: [' local ', 'AI'] }))
      .toEqual({ name: 'Project', description: '', tags: ['local', 'AI'] });
    expect(validateProjectUpdateInput({ description: ' Updated ', status: 'archived' }))
      .toEqual({ description: 'Updated', status: 'archived' });
    expect(() => validateProjectCreateInput({ name: 'Project', ownerId: otherOwnerId })).toThrow('unsupported fields');
    expect(() => validateProjectUpdateInput({})).toThrow('at least one supported field');
    expect(() => validateProjectCreateInput({ name: 'Project', tags: ['AI', 'ai'] })).toThrow('unique');
  });
});

describe('ProjectService', () => {
  it('separates optional owned reads from active writes for archived projects', async () => {
    const findByOwnerAndId = jest.fn(repository().findByOwnerAndId);
    const service = new ProjectService(repository({ findByOwnerAndId }));
    await expect(service.resolveOwnedProject(ownerId, undefined)).resolves.toBeUndefined();
    expect(findByOwnerAndId).not.toHaveBeenCalled();
    await expect(service.resolveOwnedProject(ownerId, projectId)).resolves.toEqual(existing);
    await expect(service.resolveActiveProject(ownerId, projectId)).resolves.toEqual(existing);

    const archived = new ProjectService(repository({
      findByOwnerAndId: async () => ({ ...existing, status: 'archived' }),
    }));
    await expect(archived.resolveOwnedProject(ownerId, projectId)).resolves.toMatchObject({ status: 'archived' });
    await expect(archived.resolveActiveProject(ownerId, projectId)).rejects.toMatchObject({
      code: 'PROJECT_ARCHIVED',
      statusCode: 409,
      isOperational: true,
    });
  });

  it('returns the same not-found result for missing and cross-owner active context', async () => {
    const service = new ProjectService(repository());
    await expect(service.resolveOwnedProject(otherOwnerId, projectId)).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND', message: 'Project not found.', statusCode: 404,
    });
    await expect(service.resolveOwnedProject(ownerId, '64b000000000000000000199')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND', message: 'Project not found.', statusCode: 404,
    });
  });

  it('creates an owner-scoped project with initial activity', async () => {
    const create = jest.fn(repository().create);
    const service = new ProjectService(repository({ create }), () => timestamp);
    const project = await service.create(ownerId, { name: 'Project', description: 'Description', tags: ['tag'] });

    expect(project).toMatchObject({ ownerId, name: 'Project', status: 'active' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      ownerId,
      activity: [{ type: 'created', timestamp, actorId: ownerId }],
      lastActivityAt: timestamp,
    }));
  });

  it('always scopes reads and lists to the authenticated owner', async () => {
    const list = jest.fn(repository().list);
    const findByOwnerAndId = jest.fn(repository().findByOwnerAndId);
    const service = new ProjectService(repository({ list, findByOwnerAndId }));

    await service.list(ownerId, 'archived');
    await service.get(ownerId, projectId);
    expect(list).toHaveBeenCalledWith(ownerId, 'archived');
    expect(findByOwnerAndId).toHaveBeenCalledWith(ownerId, projectId);
    await expect(service.get(otherOwnerId, projectId)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  });

  it('records rename and archive events in a single owner-scoped update', async () => {
    const updateByOwnerAndId = jest.fn(repository().updateByOwnerAndId);
    const service = new ProjectService(repository({ updateByOwnerAndId }), () => timestamp);

    await service.update(ownerId, projectId, { name: 'Renamed', status: 'archived', tags: ['phase-4'] });
    expect(updateByOwnerAndId).toHaveBeenCalledWith(
      ownerId,
      projectId,
      { name: 'Renamed', status: 'archived', tags: ['phase-4'] },
      [
        { type: 'renamed', timestamp, actorId: ownerId, changes: { from: 'Original', to: 'Renamed' } },
        { type: 'archived', timestamp, actorId: ownerId },
        { type: 'updated', timestamp, actorId: ownerId, changes: { tags: true } },
      ],
      timestamp
    );
  });

  it('does not reveal a project owned by another user during deletion', async () => {
    const remove = jest.fn(repository().deleteByOwnerAndId);
    const service = new ProjectService(repository({ deleteByOwnerAndId: remove }));
    await expect(service.delete(otherOwnerId, projectId)).rejects.toBeInstanceOf(ProjectError);
    expect(remove).toHaveBeenCalledWith(otherOwnerId, projectId);
  });
});

describe('project deletion confirmations', () => {
  it('binds a one-use token to owner and project and enforces expiry', () => {
    let now = 1_000;
    const store = new InMemoryProjectDeletionConfirmationStore(100, () => now, () => 'p'.repeat(32));
    const claims = { ownerId, projectId };
    const confirmation = store.issue(claims);
    expect(() => store.consume(confirmation.confirmationToken, { ownerId: otherOwnerId, projectId })).toThrow('does not match');
    expect(() => store.consume(confirmation.confirmationToken, claims)).not.toThrow();
    expect(() => store.consume(confirmation.confirmationToken, claims)).toThrow('already used');

    const expiring = store.issue(claims);
    now = 1_101;
    expect(() => store.consume(expiring.confirmationToken, claims)).toThrow('expired');
  });
});
