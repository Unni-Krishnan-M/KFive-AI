import {
  AgentError,
  AgentRecord,
  AgentRepository,
  AgentService,
  validateAgentCreateInput,
  validateAgentUpdateInput,
} from './agentService';
import { ProjectError } from './projectService';

const ownerId = '64b000000000000000000001';
const otherOwnerId = '64b000000000000000000002';
const agentId = '64b000000000000000000201';
const projectId = '64b000000000000000000101';
const existing: AgentRecord = {
  _id: agentId,
  userId: ownerId,
  projectId,
  name: 'Reviewer',
  description: '',
  systemPrompt: 'Review code.',
  aiModel: 'phi3',
  temperature: 0.7,
  tools: [],
};

function repository(overrides: Partial<AgentRepository> = {}): AgentRepository {
  return {
    list: async () => [existing],
    create: async (value) => ({ _id: agentId, ...value }),
    findByOwnerAndId: async (requestedOwner, requestedId) => (
      requestedOwner === ownerId && requestedId === agentId ? existing : null
    ),
    updateByOwnerAndId: async (_owner, _id, changes) => ({ ...existing, ...changes }),
    deleteByOwnerAndId: async () => existing,
    hasActiveRuns: async () => false,
    hasRuns: async () => false,
    ...overrides,
  };
}

describe('agent update validation', () => {
  it('strictly validates create input, preserves temperature zero and rejects tools/C1 controls', () => {
    expect(validateAgentCreateInput({
      name: 'Reviewer', systemPrompt: 'Review.', temperature: 0, tools: [],
    }, 'phi3')).toMatchObject({ aiModel: 'phi3', temperature: 0, tools: [] });
    expect(() => validateAgentCreateInput({ name: 'Bad\u0085name', systemPrompt: 'Review.' }, 'phi3')).toThrow('safe UTF-8');
    expect(() => validateAgentCreateInput({ name: 'Reviewer', systemPrompt: 'Review.', tools: ['shell'] }, 'phi3')).toThrow('not enabled');
    expect(() => validateAgentCreateInput({ name: 'Reviewer', systemPrompt: 'Review.', command: 'id' }, 'phi3')).toThrow('unsupported');
  });

  it('normalizes editable fields and allows an unchanged project id', () => {
    expect(validateAgentUpdateInput({
      name: '  Updated Reviewer ',
      description: '',
      systemPrompt: ' Be precise. ',
      aiModel: ' phi3 ',
      temperature: 0,
      tools: [],
      projectId,
    }, projectId)).toEqual({
      name: 'Updated Reviewer',
      description: '',
      systemPrompt: 'Be precise.',
      aiModel: 'phi3',
      temperature: 0,
      tools: [],
    });
  });

  it('rejects empty, unsupported, invalid, and project-moving patches', () => {
    expect(() => validateAgentUpdateInput({}, projectId)).toThrow('at least one editable field');
    expect(() => validateAgentUpdateInput({ userId: otherOwnerId }, projectId)).toThrow('unsupported fields');
    expect(() => validateAgentUpdateInput({ temperature: 3 }, projectId)).toThrow('0 to 2');
    expect(() => validateAgentUpdateInput({ tools: ['shell'] }, projectId)).toThrow('not enabled');
    expect(() => validateAgentUpdateInput({ name: 'Move', projectId: '64b000000000000000000199' }, projectId))
      .toThrow('cannot be moved');
  });
});

describe('AgentService update', () => {
  it('creates and lists explicit public records while an unscoped list retains all owner agents', async () => {
    const list = jest.fn().mockResolvedValue([existing]);
    const create = jest.fn(repository().create);
    const resolveActive = jest.fn().mockResolvedValue({ _id: projectId, status: 'active' });
    const resolveOwned = jest.fn().mockResolvedValue(undefined);
    const service = new AgentService(repository({ list, create }), resolveActive, resolveOwned, () => 'phi3');
    const created = await service.create(ownerId, { name: 'Reviewer', systemPrompt: 'Review.', temperature: 0, projectId });
    const records = await service.list(ownerId);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, projectId, temperature: 0, tools: [] }));
    expect(list).toHaveBeenCalledWith(ownerId, undefined);
    expect(created).toMatchObject({ id: agentId, temperature: 0 });
    expect(created).not.toHaveProperty('_id');
    expect(created).toMatchObject({ tools: [], toolState: 'disabled' });
    expect(records[0]).not.toHaveProperty('userId');
  });

  it('uses owner-scoped lookup/update and active project validation', async () => {
    const findByOwnerAndId = jest.fn(repository().findByOwnerAndId);
    const updateByOwnerAndId = jest.fn(repository().updateByOwnerAndId);
    const resolveActiveProject = jest.fn().mockResolvedValue({ _id: projectId, status: 'active' });
    const service = new AgentService(repository({ findByOwnerAndId, updateByOwnerAndId }), resolveActiveProject);

    await expect(service.update(ownerId, agentId, { name: 'Updated' })).resolves.toMatchObject({ name: 'Updated' });
    expect(findByOwnerAndId).toHaveBeenCalledWith(ownerId, agentId);
    expect(resolveActiveProject).toHaveBeenCalledWith(ownerId, projectId);
    expect(updateByOwnerAndId).toHaveBeenCalledWith(ownerId, agentId, { name: 'Updated' });
  });

  it('returns the same 404 for missing and cross-owner agents', async () => {
    const service = new AgentService(repository(), jest.fn());
    await expect(service.update(otherOwnerId, agentId, { name: 'Nope' })).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND', message: 'Agent not found.', statusCode: 404,
    });
    await expect(service.update(ownerId, '64b000000000000000000299', { name: 'Nope' })).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND', message: 'Agent not found.', statusCode: 404,
    });
  });

  it('does not update when the project is archived or the project id changes', async () => {
    const updateByOwnerAndId = jest.fn(repository().updateByOwnerAndId);
    const archived = new ProjectError('Project is archived.', 'PROJECT_ARCHIVED', 409);
    const archivedService = new AgentService(
      repository({ updateByOwnerAndId }),
      jest.fn().mockRejectedValue(archived)
    );
    await expect(archivedService.update(ownerId, agentId, { name: 'Blocked' })).rejects.toBe(archived);
    expect(updateByOwnerAndId).not.toHaveBeenCalled();

    const activeService = new AgentService(repository({ updateByOwnerAndId }), jest.fn().mockResolvedValue(undefined));
    await expect(activeService.update(ownerId, agentId, {
      name: 'Move', projectId: '64b000000000000000000199',
    })).rejects.toBeInstanceOf(AgentError);
    expect(updateByOwnerAndId).not.toHaveBeenCalled();
  });

  it('allows legacy unsafe tools to be cleared but rejects execution until remediated', async () => {
    const legacy = { ...existing, tools: ['shell'] };
    const service = new AgentService(repository({
      findByOwnerAndId: async () => legacy,
      updateByOwnerAndId: async (_owner, _id, changes) => ({ ...legacy, ...changes }),
    }), jest.fn().mockResolvedValue(undefined));
    await expect(service.get(ownerId, agentId)).resolves.toMatchObject({ tools: [], toolState: 'legacy-blocked' });
    await expect(service.getExecutableRecord(ownerId, agentId)).rejects.toMatchObject({ code: 'AGENT_TOOL_UNAVAILABLE' });
    await expect(service.update(ownerId, agentId, { tools: [] })).resolves.toMatchObject({ tools: [] });
  });

  it('blocks deletion for active or historical runs so timelines cannot be orphaned', async () => {
    const active = new AgentService(repository({ hasActiveRuns: async () => true }), jest.fn().mockResolvedValue(undefined));
    await expect(active.delete(ownerId, agentId)).rejects.toMatchObject({ code: 'AGENT_HAS_ACTIVE_RUNS' });
    const historical = new AgentService(repository({ hasRuns: async () => true }), jest.fn().mockResolvedValue(undefined));
    await expect(historical.delete(ownerId, agentId)).rejects.toMatchObject({ code: 'AGENT_HAS_RUN_HISTORY' });
  });

  it('allows an owner to delete a run-free agent whose project was deleted, but not one in an archived project', async () => {
    const remove = jest.fn(repository().deleteByOwnerAndId);
    const missingProject = new AgentService(repository({ deleteByOwnerAndId: remove }), jest.fn().mockRejectedValue(
      new ProjectError('Project not found.', 'PROJECT_NOT_FOUND', 404)
    ));
    await expect(missingProject.delete(ownerId, agentId)).resolves.toEqual({ agentId, deleted: true });
    expect(remove).toHaveBeenCalledWith(ownerId, agentId);

    const archived = new AgentService(repository(), jest.fn().mockRejectedValue(
      new ProjectError('Project is archived.', 'PROJECT_ARCHIVED', 409)
    ));
    await expect(archived.delete(ownerId, agentId)).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
  });
});
