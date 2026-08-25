import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_OUTPUT_BYTES,
  buildWorkflowDefinition,
  buildWorkflowPayload,
  isTerminalWorkflowRun,
  isWorkflowScopeRequestCurrent,
  normalizeWorkflow,
  normalizeWorkflowDefinition,
  normalizeWorkflowRunDeletion,
  normalizeWorkflowRunDetail,
  normalizeWorkflowRunPage,
  normalizeWorkflowStreamIdentity,
  workflowDraftError,
  workflowDraftFromView,
  workflowScopeKey,
} from './workflowModel';

const draft = {
  name: ' Summarizer ', description: ' A fixed linear workflow ', template: 'Summarize:\n{{input}}',
  systemPrompt: 'Be concise.', model: 'phi3', temperature: 0.2,
};
const workflowId = '507f1f77bcf86cd799439011';
const projectId = '507f1f77bcf86cd799439012';
const runId = '507f1f77bcf86cd799439013';
const definition = buildWorkflowDefinition(draft);
const workflow = {
  id: workflowId, projectId, name: 'Summarizer', description: 'A fixed linear workflow',
  schemaVersion: 1, revision: 2, definition, createdAt: '2026-08-26T10:00:00.000Z', updatedAt: '2026-08-26T10:01:00.000Z',
};
const run = {
  id: runId, workflowId, projectId, status: 'succeeded',
  workflow: { name: 'Summarizer', revision: 2, requestedModel: 'phi3', temperature: 0.2 },
  provider: 'ollama', model: 'phi3', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
  outputBytes: 7, outputTruncated: false, queuedAt: '2026-08-26T10:02:00.000Z', completedAt: '2026-08-26T10:02:01.000Z',
};

describe('workflow frontend contract', () => {
  it('builds only the fixed Input to Prompt to LLM to Output graph', () => {
    expect(definition.nodes.map((node) => [node.id, node.type, node.label, node.position])).toEqual([
      ['input', 'input', 'Input', { x: 0, y: 0 }],
      ['prompt', 'prompt', 'Prompt', { x: 320, y: 0 }],
      ['llm', 'llm', 'LLM', { x: 640, y: 0 }],
      ['output', 'output', 'Output', { x: 960, y: 0 }],
    ]);
    expect(definition.edges).toEqual([
      { id: 'input-to-prompt', source: 'input', target: 'prompt' },
      { id: 'prompt-to-llm', source: 'prompt', target: 'llm' },
      { id: 'llm-to-output', source: 'llm', target: 'output' },
    ]);
  });

  it('builds trimmed project payloads and restores editable drafts', () => {
    expect(buildWorkflowPayload(draft, projectId)).toMatchObject({ name: 'Summarizer', description: 'A fixed linear workflow', projectId, definition });
    const normalized = normalizeWorkflow({ data: { workflow } });
    expect(normalized).toEqual(workflow);
    expect(workflowDraftFromView(normalized!)).toEqual({ ...draft, name: 'Summarizer', description: 'A fixed linear workflow' });
  });

  it('rejects reordered, repositioned, extended, and malformed graphs', () => {
    expect(normalizeWorkflowDefinition({ ...definition, nodes: [definition.nodes[1], definition.nodes[0], ...definition.nodes.slice(2)] })).toBeUndefined();
    expect(normalizeWorkflowDefinition({ ...definition, nodes: definition.nodes.map((node) => node.id === 'llm' ? { ...node, position: { x: 641, y: 0 } } : node) })).toBeUndefined();
    expect(normalizeWorkflowDefinition({ ...definition, nodes: [...definition.nodes, { id: 'rag', type: 'rag' }] })).toBeUndefined();
    expect(normalizeWorkflowDefinition({ ...definition, edges: definition.edges.slice().reverse() })).toBeUndefined();
    expect(normalizeWorkflowDefinition({ ...definition, invented: true })).toBeUndefined();
    expect(normalizeWorkflowDefinition({ ...definition, nodes: definition.nodes.map((node) => node.id === 'input' ? { ...node, invented: true } : node) })).toBeUndefined();
    expect(normalizeWorkflowDefinition({ ...definition, nodes: definition.nodes.map((node) => node.id === 'input' ? { ...node, position: { ...node.position, z: 1 } } : node) })).toBeUndefined();
    expect(normalizeWorkflowDefinition({ ...definition, nodes: definition.nodes.map((node) => node.id === 'output' ? { ...node, config: { invented: true } } : node) })).toBeUndefined();
    expect(normalizeWorkflowDefinition({ ...definition, edges: definition.edges.map((edge) => edge.id === 'input-to-prompt' ? { ...edge, invented: true } : edge) })).toBeUndefined();
    expect(normalizeWorkflow({ ...workflow, schemaVersion: 2 })).toBeUndefined();
  });

  it('requires one input marker, a model, safe text, and server-aligned field bounds', () => {
    const promptConfig = (template: string) => ({ ...definition, nodes: definition.nodes.map((node) => node.id === 'prompt' ? { ...node, config: { ...node.config, template } } : node) });
    const modelConfig = (model: string) => ({ ...definition, nodes: definition.nodes.map((node) => node.id === 'llm' ? { ...node, config: { ...node.config, model } } : node) });
    expect(normalizeWorkflowDefinition(promptConfig('No marker'))).toBeUndefined();
    expect(normalizeWorkflowDefinition(promptConfig('{{input}} then {{input}}'))).toBeUndefined();
    expect(normalizeWorkflowDefinition(promptConfig('Read {{input}}\u0000'))).toBeUndefined();
    expect(normalizeWorkflowDefinition(promptConfig('Read {{input}}\u200B'))).toBeUndefined();
    expect(normalizeWorkflowDefinition(modelConfig(''))).toBeUndefined();
    expect(normalizeWorkflow({ ...workflow, name: 'x'.repeat(120) })).toBeDefined();
    expect(normalizeWorkflow({ ...workflow, name: 'x'.repeat(121) })).toBeUndefined();
    expect(normalizeWorkflow({ ...workflow, description: 'x'.repeat(2000) })).toBeDefined();
    expect(normalizeWorkflow({ ...workflow, description: 'x'.repeat(2001) })).toBeUndefined();
    expect(normalizeWorkflow({ ...workflow, revision: 1_000_000 })).toBeDefined();
    expect(normalizeWorkflow({ ...workflow, revision: 1_000_001 })).toBeUndefined();
    expect(normalizeWorkflow({ ...workflow, id: 'workflow-1' })).toBeUndefined();
    expect(normalizeWorkflowRunDetail({ ...run, id: 'run-1', input: 'Article', output: 'Summary', timeline: [] })).toBeUndefined();
    expect(workflowDraftError(draft)).toBeUndefined();
    expect(workflowDraftError({ ...draft, template: '{{input}} twice {{input}}' })).toContain('exactly once');
    expect(workflowDraftError({ ...draft, model: '' })).toContain('model');
  });

  it('normalizes bounded run detail and fixed pagination', () => {
    expect(normalizeWorkflowRunDetail({ data: { run: {
      ...run, input: 'Article', output: 'Summary', timeline: [
        { sequence: 1, type: 'created', timestamp: run.queuedAt },
        { sequence: 2, type: 'provider_selected', timestamp: run.queuedAt, provider: 'ollama', model: 'phi3' },
      ],
    } } })).toMatchObject({ id: runId, input: 'Article', output: 'Summary', workflow: { revision: 2 }, usage: { totalTokens: 14 } });
    expect(normalizeWorkflowRunPage({ data: { runs: [run], pagination: { page: 1, pageSize: 50, total: 51, totalPages: 2 } } })).toEqual({
      runs: [expect.objectContaining({ id: runId })], pagination: { page: 1, pageSize: 50, total: 51, totalPages: 2 },
    });
    expect(normalizeWorkflowRunDetail({ ...run, input: 'binary\u0000input', output: 'provider\u200Boutput\uFFFD', timeline: [] }))
      .toMatchObject({ input: 'binary\u0000input', output: 'provider\u200Boutput\uFFFD' });
    expect(normalizeWorkflowStreamIdentity('ollama', 'phi3')).toEqual({ provider: 'ollama', model: 'phi3' });
    expect(normalizeWorkflowStreamIdentity('olla\u0000ma', 'phi3')).toBeUndefined();
    expect(normalizeWorkflowStreamIdentity('ollama', 'phi\u200B3')).toBeUndefined();
  });

  it('rejects oversized output, invalid pagination, and false deletions', () => {
    expect(normalizeWorkflowRunDetail({ ...run, input: 'input', output: 'x'.repeat(WORKFLOW_OUTPUT_BYTES + 1), timeline: [] })).toBeUndefined();
    expect(normalizeWorkflowRunPage({ data: { runs: [], pagination: { page: 11, pageSize: 50, total: 500, totalPages: 10 } } })).toBeUndefined();
    expect(normalizeWorkflowRunPage({ data: { runs: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 } } })).toBeUndefined();
    expect(normalizeWorkflowRunDeletion({ data: { runId, deleted: false } })).toBeUndefined();
    expect(normalizeWorkflowRunDeletion({ data: { runId, deleted: true } })).toEqual({ runId, deleted: true });
  });

  it('gates terminal actions and invalidates stale scope generations', () => {
    expect(isTerminalWorkflowRun(run as never)).toBe(true);
    expect(isTerminalWorkflowRun({ ...run, status: 'running' } as never)).toBe(false);
    expect(workflowScopeKey(false)).toBe('workspace');
    expect(workflowScopeKey(true)).toBe('project:pending');
    expect(workflowScopeKey(true, projectId)).toBe(`project:${projectId}`);
    expect(isWorkflowScopeRequestCurrent(`project:${projectId}`, `project:${projectId}`, 3, 3)).toBe(true);
    expect(isWorkflowScopeRequestCurrent('project:507f1f77bcf86cd799439014', `project:${projectId}`, 3, 3)).toBe(false);
    expect(isWorkflowScopeRequestCurrent(`project:${projectId}`, `project:${projectId}`, 4, 3)).toBe(false);
  });
});
