import { AiProviderClient, AiStreamEvent } from '@/services/ai/types';
import { AiProviderUnavailableError } from '@/services/ai/errors';
import { AgentError, AgentRecord } from './agentService';
import { ProjectError } from './projectService';
import {
  AGENT_RUN_LIMITS,
  AgentRunRecord,
  AgentRunRepository,
  AgentRunService,
  validateAgentRunInput,
} from './agentRunService';

const ownerId = '64b000000000000000000001';
const otherOwnerId = '64b000000000000000000002';
const agentId = '64b000000000000000000201';
const runId = '64b000000000000000000301';
const now = new Date('2026-08-24T00:00:00.000Z');
const agent: AgentRecord = {
  _id: agentId, userId: ownerId, name: 'Reviewer', description: '', systemPrompt: 'Review safely.',
  aiModel: 'phi3', temperature: 0, tools: [],
};

function statefulRepository(overrides: Partial<AgentRunRepository> = {}): AgentRunRepository {
  const records = new Map<string, AgentRunRecord>();
  return {
    async create(value) {
      const record = { _id: runId, ...value } as AgentRunRecord;
      records.set(runId, record); return record;
    },
    async list(requestedOwner, requestedAgent) {
      return [...records.values()].filter((run) => String(run.ownerId) === requestedOwner && String(run.agentId) === requestedAgent);
    },
    async findByOwnerAgentAndId(requestedOwner, requestedAgent, requestedRun) {
      const run = records.get(requestedRun);
      return run && String(run.ownerId) === requestedOwner && String(run.agentId) === requestedAgent ? run : null;
    },
    async countByOwner(requestedOwner) {
      return [...records.values()].filter((run) => String(run.ownerId) === requestedOwner).length;
    },
    async countByOwnerAgent(requestedOwner, requestedAgent) {
      return [...records.values()].filter((run) => String(run.ownerId) === requestedOwner && String(run.agentId) === requestedAgent).length;
    },
    async deleteTerminalByOwnerAgentAndId(requestedOwner, requestedAgent, requestedRun) {
      const run = records.get(requestedRun);
      if (!run || String(run.ownerId) !== requestedOwner || String(run.agentId) !== requestedAgent
        || ['queued', 'running', 'cancel-requested'].includes(run.status)) return null;
      records.delete(requestedRun);
      return run;
    },
    async transition(requestedOwner, requestedRun, allowed, changes, events = []) {
      const current = records.get(requestedRun);
      if (!current || String(current.ownerId) !== requestedOwner || !allowed.includes(current.status)) return null;
      const updated = { ...current, ...changes, timeline: [...current.timeline, ...events] } as AgentRunRecord;
      records.set(requestedRun, updated); return updated;
    },
    async interruptActive() { return 0; },
    ...overrides,
  };
}

function agents() {
  return {
    getRecord: jest.fn(async (owner: string, id: string) => {
      if (owner !== ownerId || id !== agentId) throw Object.assign(new Error('Agent not found.'), { code: 'AGENT_NOT_FOUND', statusCode: 404 });
      return agent;
    }),
    getDeletableRecord: jest.fn(async (owner: string, id: string) => {
      if (owner !== ownerId || id !== agentId) throw new Error('not found');
      return agent;
    }),
    getExecutableRecord: jest.fn(async (owner: string, id: string) => {
      if (owner !== ownerId || id !== agentId) throw Object.assign(new Error('Agent not found.'), { code: 'AGENT_NOT_FOUND', statusCode: 404 });
      return agent;
    }),
  };
}

function provider(stream: (emit: (event: AiStreamEvent) => void, signal?: AbortSignal) => Promise<void>): AiProviderClient {
  return {
    id: 'ollama', capabilities: { chat: true, streaming: true, embeddings: false, structuredOutput: false, modelListing: true },
    chatStream: jest.fn(async (_request, emit, options) => stream(emit, options?.signal)),
  } as unknown as AiProviderClient;
}

describe('agent run validation', () => {
  it('accepts bounded text and rejects unsupported, multibyte overflow, C1 and NUL input', () => {
    expect(validateAgentRunInput({ prompt: '  review this  ' })).toEqual({ prompt: 'review this' });
    expect(() => validateAgentRunInput({ prompt: 'x', command: 'shell' })).toThrow('only a prompt');
    expect(() => validateAgentRunInput({ prompt: '😀'.repeat(5000) })).toThrow('16384');
    expect(() => validateAgentRunInput({ prompt: 'bad\u0085text' })).toThrow('safe UTF-8');
    expect(() => validateAgentRunInput({ prompt: 'bad\0text' })).toThrow('safe UTF-8');
  });
});

describe('AgentRunService', () => {
  it('paginates every retained run so older audit records remain discoverable', async () => {
    const list = jest.fn().mockResolvedValue([]);
    const countByOwnerAgent = jest.fn().mockResolvedValue(120);
    const service = new AgentRunService(
      statefulRepository({ list, countByOwnerAgent }), agents() as any,
      () => provider(async () => undefined), 30_000, () => now
    );

    await expect(service.list(ownerId, agentId, '2')).resolves.toEqual({
      runs: [], pagination: { page: 2, pageSize: 50, total: 120, totalPages: 3 },
    });
    expect(list).toHaveBeenCalledWith(ownerId, agentId, 50, 50);
    await expect(service.list(ownerId, agentId, '11')).rejects.toMatchObject({ code: 'INVALID_AGENT_RUN_INPUT' });
  });

  it('persists a successful bounded run timeline, provider/model, output and normalized usage', async () => {
    const repository = statefulRepository();
    const ai = provider(async (emit) => {
      emit({ type: 'start', provider: 'ollama', model: 'phi3' });
      emit({ type: 'delta', provider: 'ollama', model: 'phi3', content: 'Safe answer' });
      emit({ type: 'usage', provider: 'ollama', model: 'phi3', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } });
      emit({ type: 'done', provider: 'ollama', model: 'phi3', finishReason: 'stop' });
    });
    const service = new AgentRunService(repository, agents() as any, () => ai, 30_000, () => now);
    const prepared = await service.prepare(ownerId, agentId, { prompt: 'Review' });
    const events: unknown[] = [];
    const result = await service.execute(prepared, (event) => events.push(event));
    expect(result).toMatchObject({
      id: runId, status: 'succeeded', provider: 'ollama', model: 'phi3', output: 'Safe answer',
      outputBytes: 11, usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    });
    expect(result.timeline?.map((event) => event.type)).toEqual(['created', 'started', 'provider_selected', 'completed']);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'delta', content: 'Safe answer' })]));
    expect(ai.chatStream).toHaveBeenCalledWith(expect.objectContaining({
      model: 'phi3', temperature: 0,
      messages: [{ role: 'system', content: 'Review safely.' }, { role: 'user', content: 'Review' }],
    }), expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect((ai.chatStream as jest.Mock).mock.calls[0][0]).not.toHaveProperty('tools');
  });

  it('stores fixed provider failure metadata and never exposes the raw cause', async () => {
    const repository = statefulRepository();
    const ai = provider(async () => { throw new AiProviderUnavailableError('ollama', new Error('secret host and token')); });
    const service = new AgentRunService(repository, agents() as any, () => ai, 30_000, () => now);
    const prepared = await service.prepare(ownerId, agentId, { prompt: 'Review' });
    await expect(service.execute(prepared, () => undefined)).rejects.toMatchObject({
      code: 'AGENT_PROVIDER_UNAVAILABLE', message: 'The configured AI provider is unavailable.',
    });
    const stored = await service.get(ownerId, agentId, runId);
    expect(stored).toMatchObject({ status: 'failed', error: {
      code: 'AGENT_PROVIDER_UNAVAILABLE', message: 'The configured AI provider is unavailable.',
    } });
    expect(JSON.stringify(stored)).not.toContain('secret host');
  });

  it('normalizes usage to the exact AgentRun schema bounds', async () => {
    const service = new AgentRunService(statefulRepository(), agents() as any, () => provider(async (emit) => {
      emit({ type: 'usage', provider: 'ollama', model: 'phi3', usage: {
        inputTokens: 150_000_000, outputTokens: 160_000_000, totalTokens: 400_000_000,
        totalDurationMs: 100_000_000, loadDurationMs: 100_000_000,
      } });
    }), 30_000, () => now);

    await expect(service.execute(await service.prepare(ownerId, agentId, { prompt: 'Review' }), () => undefined))
      .resolves.toMatchObject({ usage: {
        inputTokens: 100_000_000, outputTokens: 100_000_000, totalTokens: 200_000_000,
        totalDurationMs: 86_400_000, loadDurationMs: 86_400_000,
      } });
  });

  it('never persists unsafe or oversized provider/model labels', async () => {
    const service = new AgentRunService(statefulRepository(), agents() as any, () => provider(async (emit) => {
      emit({ type: 'start', provider: 'bad\u0085provider', model: 'x'.repeat(201) });
    }), 30_000, () => now);

    await expect(service.execute(await service.prepare(ownerId, agentId, { prompt: 'Review' }), () => undefined))
      .resolves.toMatchObject({ provider: 'ollama', model: 'phi3' });
  });

  it('enforces bounded owner retention and allows explicit deletion of terminal runs', async () => {
    const atLimit = statefulRepository({ countByOwner: jest.fn().mockResolvedValue(AGENT_RUN_LIMITS.ownerRetention) });
    const limited = new AgentRunService(atLimit, agents() as any, () => provider(async () => undefined), 30_000, () => now);
    await expect(limited.execute(await limited.prepare(ownerId, agentId, { prompt: 'Review' }), () => undefined))
      .rejects.toMatchObject({ code: 'AGENT_RUN_LIMIT_REACHED', statusCode: 409 });

    const repository = statefulRepository();
    const service = new AgentRunService(repository, agents() as any, () => provider(async () => undefined), 30_000, () => now);
    await service.execute(await service.prepare(ownerId, agentId, { prompt: 'Review' }), () => undefined);
    await expect(service.delete(ownerId, agentId, runId)).resolves.toEqual({ runId, deleted: true });
    await expect(service.get(ownerId, agentId, runId)).rejects.toMatchObject({ code: 'AGENT_RUN_NOT_FOUND' });
  });

  it('enforces archived-project read-only state before deleting retained runs', async () => {
    const deleteTerminalByOwnerAgentAndId = jest.fn();
    const repository = statefulRepository({ deleteTerminalByOwnerAgentAndId });
    const archivedAgents = {
      ...agents(),
      getDeletableRecord: jest.fn().mockRejectedValue(
        new ProjectError('Project is archived.', 'PROJECT_ARCHIVED', 409)
      ),
    };
    const service = new AgentRunService(repository, archivedAgents as any, () => provider(async () => undefined), 30_000, () => now);

    await expect(service.delete(ownerId, agentId, runId)).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
    expect(deleteTerminalByOwnerAgentAndId).not.toHaveBeenCalled();
  });

  it('enforces the output byte limit and stores only bounded output', async () => {
    const repository = statefulRepository();
    const ai = provider(async (emit) => {
      emit({ type: 'start', provider: 'ollama', model: 'phi3' });
      emit({ type: 'delta', provider: 'ollama', model: 'phi3', content: 'x'.repeat(256 * 1024 + 1) });
    });
    const service = new AgentRunService(repository, agents() as any, () => ai, 30_000, () => now);
    await expect(service.execute(await service.prepare(ownerId, agentId, { prompt: 'Review' }), () => undefined))
      .rejects.toMatchObject({ code: 'AGENT_OUTPUT_LIMIT' });
    await expect(service.get(ownerId, agentId, runId)).resolves.toMatchObject({
      status: 'output_limit', output: '', outputBytes: 0, outputTruncated: true,
    });
  });

  it('cancels an active run, persists the race-safe terminal state, and is idempotent', async () => {
    const repository = statefulRepository();
    const ai = provider((_emit, signal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })), { once: true });
    }));
    const service = new AgentRunService(repository, agents() as any, () => ai, 30_000, () => now);
    const execution = service.execute(await service.prepare(ownerId, agentId, { prompt: 'Review' }), () => undefined);
    await Promise.resolve(); await Promise.resolve();
    const cancellation = await service.cancel(ownerId, agentId, runId);
    expect(cancellation).toMatchObject({ run: { status: 'cancel-requested' }, idempotent: false });
    await expect(execution).rejects.toMatchObject({ code: 'AGENT_RUN_CONFLICT' });
    await expect(service.cancel(ownerId, agentId, runId)).resolves.toMatchObject({ run: { status: 'cancelled' }, idempotent: true });
  });

  it('treats a concurrent terminal transition during cancellation as idempotent', async () => {
    const running: AgentRunRecord = {
      _id: runId, ownerId, agentId, agentSnapshot: {
        name: agent.name, systemPromptHash: 'a'.repeat(64), requestedModel: agent.aiModel,
        temperature: agent.temperature, tools: [],
      },
      prompt: 'Review', status: 'running', output: '', outputBytes: 0,
      outputTruncated: false, timeline: [], queuedAt: now,
    };
    let reads = 0;
    const repository = statefulRepository({
      findByOwnerAgentAndId: jest.fn(async () => {
        reads += 1;
        return reads === 1 ? running : { ...running, status: 'succeeded' as const, completedAt: now };
      }),
      transition: jest.fn().mockResolvedValue(null),
    });
    const service = new AgentRunService(repository, agents() as any, () => provider(async () => undefined), 30_000, () => now);

    await expect(service.cancel(ownerId, agentId, runId)).resolves.toMatchObject({
      run: { status: 'succeeded' }, idempotent: true,
    });
  });

  it('enforces one active run per owner', async () => {
    const repository = statefulRepository();
    const ai = provider((_emit, signal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const service = new AgentRunService(repository, agents() as any, () => ai, 30_000, () => now);
    const controller = new AbortController();
    const execution = service.execute(await service.prepare(ownerId, agentId, { prompt: 'First' }), () => undefined, controller.signal);
    await Promise.resolve(); await Promise.resolve();
    await expect(service.prepare(ownerId, agentId, { prompt: 'Second' })).rejects.toMatchObject({ code: 'AGENT_RUN_BUSY' });
    controller.abort();
    await expect(execution).rejects.toMatchObject({ code: 'AGENT_RUN_CONFLICT' });
  });

  it('terminalizes and releases concurrency when a provider ignores AbortSignal', async () => {
    const repository = statefulRepository();
    const ai = provider(async () => new Promise<void>(() => undefined));
    const service = new AgentRunService(repository, agents() as any, () => ai, 5, () => now);
    const execution = service.execute(await service.prepare(ownerId, agentId, { prompt: 'First' }), () => undefined);
    await expect(execution).rejects.toMatchObject({ code: 'AGENT_TIMEOUT', message: 'The agent run timed out.' });
    await expect(service.get(ownerId, agentId, runId)).resolves.toMatchObject({
      status: 'timed_out', error: { code: 'AGENT_TIMEOUT', message: 'The agent run timed out.' },
    });
    await expect(service.prepare(ownerId, agentId, { prompt: 'Second' })).resolves.toMatchObject({ ownerId });
  });

  it('cleans owner concurrency after provider accessor and initial-transition failures', async () => {
    const repository = statefulRepository();
    const service = new AgentRunService(repository, agents() as any, () => { throw new Error('raw accessor'); }, 30_000, () => now);
    await expect(service.execute(await service.prepare(ownerId, agentId, { prompt: 'First' }), () => undefined))
      .rejects.toMatchObject({ code: 'AGENT_EXECUTION_FAILED' });
    await expect(service.prepare(ownerId, agentId, { prompt: 'Second' })).resolves.toMatchObject({ ownerId });

    let transitions = 0;
    const flaky = statefulRepository({
      transition: jest.fn(async (_owner, _run, _allowed, changes) => {
        transitions += 1;
        if (transitions === 1) throw new Error('db transition');
        return { _id: runId, ownerId, agentId, agentSnapshot: {
          name: agent.name, systemPromptHash: 'a'.repeat(64), requestedModel: agent.aiModel, temperature: 0, tools: [],
        }, prompt: 'First', status: changes.status ?? 'failed', output: '', outputBytes: 0, outputTruncated: false,
        timeline: [], queuedAt: now, ...changes } as unknown as AgentRunRecord;
      }),
    });
    const flakyService = new AgentRunService(flaky, agents() as any, () => provider(async () => undefined), 30_000, () => now);
    await expect(flakyService.execute(await flakyService.prepare(ownerId, agentId, { prompt: 'First' }), () => undefined))
      .rejects.toMatchObject({ code: 'AGENT_EXECUTION_FAILED' });
    await expect(flakyService.prepare(ownerId, agentId, { prompt: 'Second' })).resolves.toMatchObject({ ownerId });
  });

  it('revalidates the agent while holding the execution lease before persisting a run', async () => {
    const repository = statefulRepository({ create: jest.fn() });
    const access = agents();
    access.getExecutableRecord
      .mockResolvedValueOnce(agent)
      .mockRejectedValueOnce(new AgentError('Agent not found.', 'AGENT_NOT_FOUND', 404))
      .mockResolvedValue(agent);
    const service = new AgentRunService(repository, access as any, () => provider(async () => undefined), 30_000, () => now);

    const prepared = await service.prepare(ownerId, agentId, { prompt: 'First' });
    await expect(service.execute(prepared, () => undefined)).rejects.toMatchObject({
      code: 'AGENT_RUN_CONFLICT', message: 'The agent is no longer available for execution.',
    });
    expect(repository.create).not.toHaveBeenCalled();
    await expect(service.prepare(ownerId, agentId, { prompt: 'Second' })).resolves.toMatchObject({ ownerId });
  });

  it('owner-scopes run reads and recovers stale records with a bounded fixed outcome', async () => {
    const interruptActive = jest.fn().mockResolvedValue(2);
    const service = new AgentRunService(statefulRepository({ interruptActive }), agents() as any, () => provider(async () => undefined), 30_000, () => now);
    await expect(service.get(otherOwnerId, agentId, runId)).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    await expect(service.recoverInterrupted()).resolves.toBe(2);
    expect(interruptActive).toHaveBeenCalledWith(new Date(now.getTime() - 60_000), now);
  });
});
