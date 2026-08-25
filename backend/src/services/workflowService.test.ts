import { WorkflowDefinition } from '@/models/Workflow';
import {
  WorkflowError, WorkflowRecord, WorkflowRepository, WorkflowService,
  normalizeWorkflowDefinition, validateWorkflowCreateInput, validateWorkflowUpdateInput,
} from './workflowService';
import { ProjectError } from './projectService';

const ownerId = '64b000000000000000000001';
const otherOwnerId = '64b000000000000000000002';
const projectId = '64b000000000000000000101';
const workflowId = '64b000000000000000000201';
function validWorkflowDefinition(overrides: { template?: string; systemPrompt?: string; model?: string; temperature?: number } = {}): WorkflowDefinition {
  return {
    nodes: [
      { id: 'input', type: 'input', label: 'Input', position: { x: 0, y: 0 }, config: {} },
      { id: 'prompt', type: 'prompt', label: 'Prompt', position: { x: 320, y: 0 }, config: {
        template: overrides.template ?? 'Summarize:\n{{input}}', systemPrompt: overrides.systemPrompt ?? 'Be concise.',
      } },
      { id: 'llm', type: 'llm', label: 'LLM', position: { x: 640, y: 0 }, config: {
        model: overrides.model ?? 'phi3', temperature: overrides.temperature ?? 0,
      } },
      { id: 'output', type: 'output', label: 'Output', position: { x: 960, y: 0 }, config: {} },
    ],
    edges: [
      { id: 'input-to-prompt', source: 'input', target: 'prompt' },
      { id: 'prompt-to-llm', source: 'prompt', target: 'llm' },
      { id: 'llm-to-output', source: 'llm', target: 'output' },
    ],
  };
}
const existing: WorkflowRecord = {
  _id: workflowId, ownerId, projectId, name: 'Summary', description: '', schemaVersion: 1,
  revision: 1, definition: validWorkflowDefinition(),
};

function repository(overrides: Partial<WorkflowRepository> = {}): WorkflowRepository {
  return {
    list: async () => [existing], countByOwner: async () => 0,
    create: async (value) => ({ _id: workflowId, ...value }),
    findByOwnerAndId: async (owner, id) => owner === ownerId && id === workflowId ? existing : null,
    updateByOwnerAndId: async (_owner, _id, changes) => ({ ...existing, ...changes, revision: existing.revision + 1 }),
    deleteByOwnerAndId: async () => existing, hasActiveRuns: async () => false, hasRuns: async () => false,
    ...overrides,
  };
}

describe('workflow validation', () => {
  it('accepts only the exact canonical definition and normalizes safe values', () => {
    expect(validateWorkflowCreateInput({ name: ' Summary ', definition: validWorkflowDefinition() }))
      .toMatchObject({ name: 'Summary', description: '', definition: validWorkflowDefinition() });
    const wrongPosition = validWorkflowDefinition();
    wrongPosition.nodes[2].position.x = 641;
    expect(() => normalizeWorkflowDefinition(wrongPosition)).toThrow('exactly Input -> Prompt -> LLM -> Output');
    expect(() => validateWorkflowCreateInput({ name: 'Bad', definition: validWorkflowDefinition(), command: 'sh' }))
      .toThrow('unsupported fields');
  });

  it('rejects unsupported nodes, unknown nested config, repeated token, Unicode Cf and graph attacks', () => {
    const cases: unknown[] = [];
    const code = validWorkflowDefinition();
    (code.nodes[2] as any).type = 'code-runner'; cases.push(code);
    const config = validWorkflowDefinition();
    (config.nodes[2].config as any).tools = ['shell']; cases.push(config);
    cases.push(validWorkflowDefinition({ template: '{{input}} {{input}}' }));
    cases.push(validWorkflowDefinition({ systemPrompt: 'bad\u200Bprompt' }));
    const cycle = validWorkflowDefinition(); cycle.edges[2].target = 'input'; cases.push(cycle);
    const fanout = validWorkflowDefinition(); fanout.edges[1].source = 'input'; cases.push(fanout);
    const duplicate = validWorkflowDefinition(); duplicate.nodes[1] = duplicate.nodes[0] as any; cases.push(duplicate);
    for (const definition of cases) expect(() => normalizeWorkflowDefinition(definition)).toThrow(WorkflowError);
  });

  it('enforces project immutability and editable-only patches', () => {
    expect(() => validateWorkflowUpdateInput({ projectId: '64b000000000000000000199' }, projectId))
      .toThrow('cannot be moved');
    expect(() => validateWorkflowUpdateInput({}, projectId)).toThrow('at least one');
    expect(validateWorkflowUpdateInput({ name: ' New ' }, projectId)).toEqual({ name: 'New' });
  });
});

describe('WorkflowService', () => {
  it('creates/lists with owner scope, active project validation, revision one and a 100-workflow cap', async () => {
    const create = jest.fn(repository().create);
    const list = jest.fn(repository().list);
    const resolveActive = jest.fn().mockResolvedValue({ _id: projectId, status: 'active' });
    const resolveOwned = jest.fn().mockResolvedValue(undefined);
    const service = new WorkflowService(repository({ create, list }), resolveActive, resolveOwned);
    await service.create(ownerId, { name: 'Summary', definition: validWorkflowDefinition(), projectId });
    await service.list(ownerId);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ ownerId, projectId, schemaVersion: 1, revision: 1 }));
    expect(list).toHaveBeenCalledWith(ownerId, undefined);

    const capped = new WorkflowService(repository({ countByOwner: async () => 100 }), resolveActive, resolveOwned);
    await expect(capped.create(ownerId, { name: 'No', definition: validWorkflowDefinition() }))
      .rejects.toMatchObject({ code: 'WORKFLOW_LIMIT_REACHED' });
  });

  it('returns identical not-found behavior for missing and cross-owner workflows', async () => {
    const service = new WorkflowService(repository(), jest.fn(), jest.fn());
    await expect(service.get(otherOwnerId, workflowId)).rejects.toMatchObject({ code: 'WORKFLOW_NOT_FOUND', statusCode: 404 });
    await expect(service.get(ownerId, '64b000000000000000000299')).rejects.toMatchObject({ code: 'WORKFLOW_NOT_FOUND', statusCode: 404 });
  });

  it('allows archived reads but blocks update/run resolution and preserves immutable project scope', async () => {
    const archived = new ProjectError('Project is archived.', 'PROJECT_ARCHIVED', 409);
    const service = new WorkflowService(repository(), jest.fn().mockRejectedValue(archived), jest.fn().mockResolvedValue({ _id: projectId, status: 'archived' }));
    await expect(service.list(ownerId, projectId)).resolves.toHaveLength(1);
    await expect(service.get(ownerId, workflowId)).resolves.toMatchObject({ id: workflowId });
    await expect(service.update(ownerId, workflowId, { name: 'Blocked' })).rejects.toBe(archived);
    await expect(service.getActiveRecord(ownerId, workflowId)).rejects.toBe(archived);
  });

  it('blocks deletion with active/history runs, but allows run-free orphan cleanup', async () => {
    await expect(new WorkflowService(repository({ hasActiveRuns: async () => true }), jest.fn().mockResolvedValue(undefined))
      .delete(ownerId, workflowId)).rejects.toMatchObject({ code: 'WORKFLOW_HAS_ACTIVE_RUNS' });
    await expect(new WorkflowService(repository({ hasRuns: async () => true }), jest.fn().mockResolvedValue(undefined))
      .delete(ownerId, workflowId)).rejects.toMatchObject({ code: 'WORKFLOW_HAS_RUN_HISTORY' });
    const remove = jest.fn(repository().deleteByOwnerAndId);
    const orphan = new WorkflowService(repository({ deleteByOwnerAndId: remove }), jest.fn().mockRejectedValue(
      new ProjectError('Project not found.', 'PROJECT_NOT_FOUND', 404)
    ));
    await expect(orphan.delete(ownerId, workflowId)).resolves.toEqual({ workflowId, deleted: true });
    expect(remove).toHaveBeenCalledWith(ownerId, workflowId);
  });
});
