import { Types } from 'mongoose';
import { WorkflowDefinition, WorkflowModel } from './Workflow';
import { WorkflowRunModel } from './WorkflowRun';

export function validWorkflowDefinition(overrides: { template?: string; systemPrompt?: string; model?: string; temperature?: number } = {}): WorkflowDefinition {
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

describe('Workflow models', () => {
  it('validates a real hydrated exact workflow and run snapshot', async () => {
    const ownerId = new Types.ObjectId();
    const workflowId = new Types.ObjectId();
    const definition = validWorkflowDefinition();
    const workflow = new WorkflowModel({
      ownerId, name: 'Summary', description: '', schemaVersion: 1, revision: 1, definition,
    });
    await expect(workflow.validate()).resolves.toBeUndefined();

    const run = new WorkflowRunModel({
      ownerId, workflowId, workflowSnapshot: { name: 'Summary', schemaVersion: 1, revision: 1, definition },
      input: 'Text', status: 'queued', output: '', outputBytes: 0, outputTruncated: false,
      timeline: [{ sequence: 1, type: 'created', timestamp: new Date() }], queuedAt: new Date(),
    });
    await expect(run.validate()).resolves.toBeUndefined();
  });

  it('rejects noncanonical graphs and invalid snapshots at model level', async () => {
    const bad = validWorkflowDefinition();
    bad.edges[0] = { id: 'input-to-prompt', source: 'input', target: 'output' };
    await expect(new WorkflowModel({
      ownerId: new Types.ObjectId(), name: 'Bad', schemaVersion: 1, revision: 1, definition: bad,
    }).validate()).rejects.toThrow('exact supported linear graph');

    const repeated = validWorkflowDefinition({ template: '{{input}} {{input}}' });
    await expect(new WorkflowRunModel({
      ownerId: new Types.ObjectId(), workflowId: new Types.ObjectId(),
      workflowSnapshot: { name: 'Bad', schemaVersion: 1, revision: 1, definition: repeated },
      input: 'x', status: 'queued', outputBytes: 0, outputTruncated: false, queuedAt: new Date(),
    }).validate()).rejects.toThrow('snapshot is invalid');
  });

  it('declares owner/project/history indexes and immutable ownership', () => {
    expect(WorkflowModel.schema.indexes().map(([fields]) => fields)).toEqual(expect.arrayContaining([
      { ownerId: 1, updatedAt: -1 }, { ownerId: 1, projectId: 1, updatedAt: -1 },
    ]));
    expect(WorkflowRunModel.schema.indexes().map(([fields]) => fields)).toEqual(expect.arrayContaining([
      { ownerId: 1, projectId: 1, createdAt: -1 },
      { ownerId: 1, workflowId: 1, createdAt: -1 }, { status: 1, updatedAt: 1 },
    ]));
    expect(WorkflowModel.schema.path('ownerId').options.immutable).toBe(true);
    expect(WorkflowModel.schema.path('projectId').options.immutable).toBe(true);
    expect(WorkflowRunModel.schema.path('workflowId').options.immutable).toBe(true);
  });
});
