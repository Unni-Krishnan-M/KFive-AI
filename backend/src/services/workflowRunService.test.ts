import { WorkflowDefinition } from '@/models/Workflow';
import { AiProviderClient, AiStreamEvent } from '@/services/ai/types';
import { AiProviderUnavailableError } from '@/services/ai/errors';
import { WorkflowRecord } from './workflowService';
import { resetWorkflowExecutionLeasesForTests } from './workflowExecutionLease';
import {
  WORKFLOW_RUN_LIMITS, WorkflowRunRecord, WorkflowRunRepository, WorkflowRunService, validateWorkflowRunInput,
} from './workflowRunService';

const ownerId = '64b000000000000000000001';
const otherOwnerId = '64b000000000000000000002';
const workflowId = '64b000000000000000000201';
const runId = '64b000000000000000000301';
const now = new Date('2026-08-26T00:00:00.000Z');

function definition(overrides: { template?: string; systemPrompt?: string; model?: string; temperature?: number } = {}): WorkflowDefinition {
  return {
    nodes: [
      { id: 'input', type: 'input', label: 'Input', position: { x: 0, y: 0 }, config: {} },
      { id: 'prompt', type: 'prompt', label: 'Prompt', position: { x: 320, y: 0 }, config: {
        template: overrides.template ?? 'Summarize: {{input}}', systemPrompt: overrides.systemPrompt ?? 'Be concise.',
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

const workflow: WorkflowRecord = {
  _id: workflowId, ownerId, name: 'Summary', description: '', schemaVersion: 1,
  revision: 3, definition: definition(),
};

function statefulRepository(overrides: Partial<WorkflowRunRepository> = {}): WorkflowRunRepository {
  const records = new Map<string, WorkflowRunRecord>();
  return {
    async create(value) { const record = { _id: runId, ...value } as WorkflowRunRecord; records.set(runId, record); return record; },
    async list(requestedOwner, requestedWorkflow) {
      return [...records.values()].filter((run) => String(run.ownerId) === requestedOwner && String(run.workflowId) === requestedWorkflow);
    },
    async countByOwnerWorkflow(requestedOwner, requestedWorkflow) {
      return [...records.values()].filter((run) => String(run.ownerId) === requestedOwner && String(run.workflowId) === requestedWorkflow).length;
    },
    async findByOwnerWorkflowAndId(requestedOwner, requestedWorkflow, requestedRun) {
      const run = records.get(requestedRun);
      return run && String(run.ownerId) === requestedOwner && String(run.workflowId) === requestedWorkflow ? run : null;
    },
    async countByOwner(requestedOwner) {
      return [...records.values()].filter((run) => String(run.ownerId) === requestedOwner).length;
    },
    async deleteTerminalByOwnerWorkflowAndId(requestedOwner, requestedWorkflow, requestedRun) {
      const run = records.get(requestedRun);
      if (!run || String(run.ownerId) !== requestedOwner || String(run.workflowId) !== requestedWorkflow
        || ['queued', 'running', 'cancel-requested'].includes(run.status)) return null;
      records.delete(requestedRun); return run;
    },
    async transition(requestedOwner, requestedRun, allowed, changes, events = []) {
      const current = records.get(requestedRun);
      if (!current || String(current.ownerId) !== requestedOwner || !allowed.includes(current.status)) return null;
      const updated = { ...current, ...changes, timeline: [...current.timeline, ...events].slice(-50) } as WorkflowRunRecord;
      records.set(requestedRun, updated); return updated;
    },
    async interruptActive() { return 0; },
    ...overrides,
  };
}

function workflows(overrides: Partial<Record<'getRecord' | 'getDeletableRecord' | 'getActiveRecord', jest.Mock>> = {}) {
  return {
    getRecord: jest.fn(async (owner: string, id: string) => {
      if (owner !== ownerId || id !== workflowId) throw Object.assign(new Error('Workflow not found.'), { code: 'WORKFLOW_NOT_FOUND' });
      return workflow;
    }),
    getDeletableRecord: jest.fn(async () => workflow),
    getActiveRecord: jest.fn(async (owner: string, id: string) => {
      if (owner !== ownerId || id !== workflowId) throw Object.assign(new Error('Workflow not found.'), { code: 'WORKFLOW_NOT_FOUND' });
      return workflow;
    }),
    ...overrides,
  };
}

function provider(stream: (emit: (event: AiStreamEvent) => void, signal?: AbortSignal) => Promise<void>): AiProviderClient {
  return {
    id: 'ollama', capabilities: { chat: true, streaming: true, embeddings: false, structuredOutput: false, modelListing: true },
    chatStream: jest.fn(async (_request, emit, options) => stream(emit, options?.signal)),
  } as unknown as AiProviderClient;
}

describe('workflow run validation', () => {
  it('accepts bounded input and rejects commands, Unicode controls, NUL and multibyte overflow', () => {
    expect(validateWorkflowRunInput({ input: '  safe input  ' })).toEqual({ input: 'safe input' });
    expect(() => validateWorkflowRunInput({ input: 'x', command: 'shell' })).toThrow('only an input string');
    expect(() => validateWorkflowRunInput({ input: 'bad\u200Btext' })).toThrow('safe UTF-8');
    expect(() => validateWorkflowRunInput({ input: 'bad\0text' })).toThrow('safe UTF-8');
    expect(() => validateWorkflowRunInput({ input: '😀'.repeat(5000) })).toThrow('16384');
  });
});

describe('WorkflowRunService', () => {
  beforeEach(() => resetWorkflowExecutionLeasesForTests());

  it('renders the fixed prompt, sends no tools, and persists shell/tool-looking provider text inertly', async () => {
    const inert = '```sh\nrm -rf /\n``` {"tool_call":{"name":"shell"}}';
    const ai = provider(async (emit) => {
      emit({ type: 'start', provider: 'ollama', model: 'phi3' });
      emit({ type: 'delta', provider: 'ollama', model: 'phi3', content: inert });
      emit({ type: 'usage', provider: 'ollama', model: 'phi3', usage: { inputTokens: 2, outputTokens: 5, totalTokens: 7 } });
      emit({ type: 'done', provider: 'ollama', model: 'phi3', finishReason: 'stop' });
    });
    const service = new WorkflowRunService(statefulRepository(), workflows() as any, () => ai, 30_000, () => now);
    const result = await service.execute(await service.prepare(ownerId, workflowId, { input: 'notes' }), () => undefined);
    expect(result).toMatchObject({ status: 'succeeded', output: inert, workflow: {
      name: 'Summary', revision: 3, requestedModel: 'phi3', temperature: 0,
    } });
    const request = (ai.chatStream as jest.Mock).mock.calls[0][0];
    expect(request).toEqual({
      model: 'phi3', messages: [
        { role: 'system', content: 'Be concise.' }, { role: 'user', content: 'Summarize: notes' },
      ], temperature: 0,
    });
    expect(request).not.toHaveProperty('tools');
    expect(JSON.stringify(request)).not.toContain('code-runner');
  });

  it('bounds the combined rendered prompt and supports near-limit UTF-8 input/template', async () => {
    const largeWorkflow = { ...workflow, definition: definition({ template: `${'a'.repeat(16_000)}{{input}}` }) };
    const access = workflows({ getActiveRecord: jest.fn().mockResolvedValue(largeWorkflow) });
    const ai = provider(async () => undefined);
    const service = new WorkflowRunService(statefulRepository(), access as any, () => ai, 30_000, () => now);
    await service.execute(await service.prepare(ownerId, workflowId, { input: 'b'.repeat(16_000) }), () => undefined);
    const rendered = (ai.chatStream as jest.Mock).mock.calls[0][0].messages[1].content;
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(WORKFLOW_RUN_LIMITS.renderedPromptBytes);
  });

  it('revalidates the persisted workflow after prepare and before creating a run', async () => {
    const invalid = { ...workflow, definition: { ...definition(), edges: [] } as any };
    const access = workflows();
    access.getActiveRecord.mockResolvedValueOnce(workflow).mockResolvedValueOnce(invalid);
    const create = jest.fn();
    const service = new WorkflowRunService(statefulRepository({ create }), access as any, () => provider(async () => undefined), 30_000, () => now);
    const prepared = await service.prepare(ownerId, workflowId, { input: 'notes' });
    await expect(service.execute(prepared, () => undefined)).rejects.toMatchObject({ code: 'WORKFLOW_RUN_CONFLICT' });
    expect(create).not.toHaveBeenCalled();
  });

  it('enforces owner retention before persistence', async () => {
    const create = jest.fn();
    const service = new WorkflowRunService(
      statefulRepository({ countByOwner: async () => 500, create }), workflows() as any,
      () => provider(async () => undefined), 30_000, () => now
    );
    await expect(service.execute(await service.prepare(ownerId, workflowId, { input: 'notes' }), () => undefined))
      .rejects.toMatchObject({ code: 'WORKFLOW_RUN_LIMIT_REACHED' });
    expect(create).not.toHaveBeenCalled();
  });

  it('does not append the overflowing provider chunk', async () => {
    const ai = provider(async (emit) => {
      emit({ type: 'delta', provider: 'ollama', model: 'phi3', content: 'x'.repeat(WORKFLOW_RUN_LIMITS.outputBytes + 1) });
    });
    const service = new WorkflowRunService(statefulRepository(), workflows() as any, () => ai, 30_000, () => now);
    await expect(service.execute(await service.prepare(ownerId, workflowId, { input: 'notes' }), () => undefined))
      .rejects.toMatchObject({ code: 'WORKFLOW_OUTPUT_LIMIT' });
    await expect(service.get(ownerId, workflowId, runId)).resolves.toMatchObject({
      status: 'output_limit', output: '', outputBytes: 0, outputTruncated: true,
    });
  });

  it('stores only fixed provider failure metadata', async () => {
    const ai = provider(async () => { throw new AiProviderUnavailableError('ollama', new Error('secret token')); });
    const service = new WorkflowRunService(statefulRepository(), workflows() as any, () => ai, 30_000, () => now);
    await expect(service.execute(await service.prepare(ownerId, workflowId, { input: 'notes' }), () => undefined))
      .rejects.toMatchObject({ code: 'WORKFLOW_PROVIDER_UNAVAILABLE' });
    const stored = await service.get(ownerId, workflowId, runId);
    expect(stored).toMatchObject({ error: { code: 'WORKFLOW_PROVIDER_UNAVAILABLE', message: 'The configured AI provider is unavailable.' } });
    expect(JSON.stringify(stored)).not.toContain('secret token');
  });

  it('cancels an active run and returns idempotent terminal cancellation', async () => {
    const ai = provider((_emit, signal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const service = new WorkflowRunService(statefulRepository(), workflows() as any, () => ai, 30_000, () => now);
    const execution = service.execute(await service.prepare(ownerId, workflowId, { input: 'notes' }), () => undefined);
    await Promise.resolve(); await Promise.resolve();
    await expect(service.cancel(ownerId, workflowId, runId)).resolves.toMatchObject({ run: { status: 'cancel-requested' }, idempotent: false });
    await expect(execution).rejects.toMatchObject({ code: 'WORKFLOW_RUN_CONFLICT' });
    await expect(service.cancel(ownerId, workflowId, runId)).resolves.toMatchObject({ run: { status: 'cancelled' }, idempotent: true });
  });

  it('times out even when a provider ignores AbortSignal and releases owner concurrency', async () => {
    const ai = provider(async () => new Promise<void>(() => undefined));
    const service = new WorkflowRunService(statefulRepository(), workflows() as any, () => ai, 5, () => now);
    await expect(service.execute(await service.prepare(ownerId, workflowId, { input: 'notes' }), () => undefined))
      .rejects.toMatchObject({ code: 'WORKFLOW_TIMEOUT' });
    await expect(service.prepare(ownerId, workflowId, { input: 'again' })).resolves.toMatchObject({ ownerId });
  });

  it('paginates summaries without private input/output/timeline/snapshot and owner-scopes details', async () => {
    const repository = statefulRepository();
    const service = new WorkflowRunService(repository, workflows() as any, () => provider(async (emit) => {
      emit({ type: 'delta', provider: 'ollama', model: 'phi3', content: 'answer' });
    }), 30_000, () => now);
    await service.execute(await service.prepare(ownerId, workflowId, { input: 'notes' }), () => undefined);
    const page = await service.list(ownerId, workflowId, '1');
    expect(page.pagination).toEqual({ page: 1, pageSize: 50, total: 1, totalPages: 1 });
    expect(page.runs[0]).not.toHaveProperty('input');
    expect(page.runs[0]).not.toHaveProperty('output');
    expect(page.runs[0]).not.toHaveProperty('timeline');
    expect(page.runs[0]).not.toHaveProperty('workflowSnapshot');
    await expect(service.get(otherOwnerId, workflowId, runId)).rejects.toMatchObject({ code: 'WORKFLOW_NOT_FOUND' });
  });

  it('deletes terminal runs only and recovers stale records', async () => {
    const repository = statefulRepository();
    const service = new WorkflowRunService(repository, workflows() as any, () => provider(async () => undefined), 30_000, () => now);
    await service.execute(await service.prepare(ownerId, workflowId, { input: 'notes' }), () => undefined);
    await expect(service.delete(ownerId, workflowId, runId)).resolves.toEqual({ runId, deleted: true });

    const interruptActive = jest.fn().mockResolvedValue(2);
    const recovery = new WorkflowRunService(statefulRepository({ interruptActive }), workflows() as any, () => provider(async () => undefined), 30_000, () => now);
    await expect(recovery.recoverInterrupted()).resolves.toBe(2);
    expect(interruptActive).toHaveBeenCalledWith(new Date(now.getTime() - 60_000), now);
  });
});
