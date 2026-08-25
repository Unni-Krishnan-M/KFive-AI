import { createHash } from 'crypto';
import { AgentRunModel, AgentRunStatus, AgentRunTimelineType } from '@/models/AgentRun';
import { AiProviderClient, AiStreamEvent, AiUsage } from '@/services/ai/types';
import { AiProviderError } from '@/services/ai/errors';
import { getAiProvider } from '@/services/aiProvider';
import { AgentError, AgentRecord, AgentService, agentService } from './agentService';
import { ProjectError } from './projectService';
import { releaseAgentExecutionLease, tryAcquireAgentExecutionLease } from './agentExecutionLease';

export const AGENT_RUN_LIMITS = Object.freeze({ promptBytes: 16 * 1024, outputBytes: 256 * 1024, list: 50, ownerRetention: 500, ownerConcurrency: 1 });

export type AgentRunErrorCode =
  | 'INVALID_AGENT_RUN_INPUT'
  | 'AGENT_RUN_NOT_FOUND'
  | 'AGENT_RUN_BUSY'
  | 'AGENT_RUN_CONFLICT'
  | 'AGENT_RUN_LIMIT_REACHED'
  | 'AGENT_RUN_STORAGE_UNAVAILABLE'
  | 'AGENT_PROVIDER_UNAVAILABLE'
  | 'AGENT_TIMEOUT'
  | 'AGENT_EXECUTION_FAILED'
  | 'AGENT_OUTPUT_LIMIT'
  | 'AGENT_INTERRUPTED';

export class AgentRunError extends Error {
  readonly isOperational = true;
  constructor(message: string, readonly code: AgentRunErrorCode, readonly statusCode: number) {
    super(message);
    this.name = 'AgentRunError';
  }
}

export interface AgentRunTimeline {
  sequence: number;
  type: AgentRunTimelineType;
  timestamp: Date;
  provider?: string;
  model?: string;
  code?: string;
}

export interface AgentRunRecord {
  _id: unknown;
  ownerId: unknown;
  projectId?: unknown;
  agentId: unknown;
  agentSnapshot: { name: string; systemPromptHash: string; requestedModel: string; temperature: number; tools: string[] };
  prompt: string;
  status: AgentRunStatus;
  provider?: string;
  model?: string;
  output: string;
  outputBytes: number;
  outputTruncated: boolean;
  usage?: AiUsage;
  finishReason?: 'stop' | 'length' | 'error' | 'unknown';
  error?: { code?: string; message?: string };
  timeline: AgentRunTimeline[];
  queuedAt: Date;
  startedAt?: Date;
  cancelRequestedAt?: Date;
  completedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  [key: string]: unknown;
}

export type AgentRunCreateData = Omit<AgentRunRecord, '_id' | 'createdAt' | 'updatedAt'>;
export type AgentRunChanges = Partial<Omit<AgentRunRecord, '_id' | 'ownerId' | 'agentId' | 'projectId' | 'agentSnapshot' | 'prompt' | 'queuedAt' | 'timeline'>>;

export interface AgentRunRepository {
  create(value: AgentRunCreateData): Promise<AgentRunRecord>;
  list(ownerId: string, agentId: string, offset: number, limit: number): Promise<AgentRunRecord[]>;
  countByOwnerAgent(ownerId: string, agentId: string): Promise<number>;
  findByOwnerAgentAndId(ownerId: string, agentId: string, runId: string): Promise<AgentRunRecord | null>;
  countByOwner(ownerId: string): Promise<number>;
  deleteTerminalByOwnerAgentAndId(ownerId: string, agentId: string, runId: string): Promise<AgentRunRecord | null>;
  transition(
    ownerId: string,
    runId: string,
    allowed: AgentRunStatus[],
    changes: AgentRunChanges,
    events?: AgentRunTimeline[]
  ): Promise<AgentRunRecord | null>;
  interruptActive(before: Date, completedAt: Date): Promise<number>;
}

export const mongooseAgentRunRepository: AgentRunRepository = {
  async create(value) { return AgentRunModel.create(value) as unknown as Promise<AgentRunRecord>; },
  async list(ownerId, agentId, offset, limit) {
    return AgentRunModel.find({ ownerId, agentId }).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).lean() as unknown as Promise<AgentRunRecord[]>;
  },
  async countByOwnerAgent(ownerId, agentId) { return AgentRunModel.countDocuments({ ownerId, agentId }); },
  async findByOwnerAgentAndId(ownerId, agentId, runId) {
    return AgentRunModel.findOne({ _id: runId, ownerId, agentId }).lean() as unknown as Promise<AgentRunRecord | null>;
  },
  async countByOwner(ownerId) { return AgentRunModel.countDocuments({ ownerId }); },
  async deleteTerminalByOwnerAgentAndId(ownerId, agentId, runId) {
    return AgentRunModel.findOneAndDelete({
      _id: runId, ownerId, agentId,
      status: { $in: ['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted'] },
    }).lean() as unknown as Promise<AgentRunRecord | null>;
  },
  async transition(ownerId, runId, allowed, changes, events = []) {
    return AgentRunModel.findOneAndUpdate(
      { _id: runId, ownerId, status: { $in: allowed } },
      { $set: changes, ...(events.length ? { $push: { timeline: { $each: events, $slice: -50 } } } : {}) },
      { new: true, runValidators: true }
    ).lean() as unknown as Promise<AgentRunRecord | null>;
  },
  async interruptActive(before, completedAt) {
    const result = await AgentRunModel.updateMany(
      { status: { $in: ['queued', 'running', 'cancel-requested'] }, updatedAt: { $lt: before } },
      {
        $set: {
          status: 'interrupted', completedAt,
          error: { code: 'AGENT_INTERRUPTED', message: 'The agent run was interrupted before completion.' },
        },
        $push: { timeline: { sequence: 50, type: 'failed', timestamp: completedAt, code: 'AGENT_INTERRUPTED' } },
      }
    );
    return result.modifiedCount;
  },
};

export interface PublicAgentRun {
  id: string;
  agentId: string;
  projectId?: string;
  status: AgentRunStatus;
  agent: { name: string; requestedModel: string; temperature: number; tools: string[] };
  provider?: string;
  model?: string;
  usage?: AiUsage;
  finishReason?: string;
  outputBytes: number;
  outputTruncated: boolean;
  error?: { code: string; message: string };
  queuedAt: Date;
  startedAt?: Date;
  cancelRequestedAt?: Date;
  completedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  prompt?: string;
  output?: string;
  timeline?: AgentRunTimeline[];
}

export interface PublicAgentRunPage {
  runs: PublicAgentRun[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

function serializeRun(record: AgentRunRecord, detail: boolean): PublicAgentRun {
  return {
    id: String(record._id), agentId: String(record.agentId), ...(record.projectId ? { projectId: String(record.projectId) } : {}),
    status: record.status,
    agent: {
      name: record.agentSnapshot.name,
      requestedModel: record.agentSnapshot.requestedModel,
      temperature: record.agentSnapshot.temperature,
      tools: [],
    },
    ...(record.provider ? { provider: record.provider } : {}), ...(record.model ? { model: record.model } : {}),
    ...(record.usage ? { usage: record.usage } : {}), ...(record.finishReason ? { finishReason: record.finishReason } : {}),
    outputBytes: record.outputBytes, outputTruncated: record.outputTruncated,
    ...(record.error?.code && record.error.message ? { error: { code: record.error.code, message: record.error.message } } : {}),
    queuedAt: record.queuedAt, ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.cancelRequestedAt ? { cancelRequestedAt: record.cancelRequestedAt } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.createdAt ? { createdAt: record.createdAt } : {}), ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    ...(detail ? { prompt: record.prompt, output: record.output, timeline: record.timeline } : {}),
  };
}

function requireObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new AgentRunError(`${label} is invalid.`, 'INVALID_AGENT_RUN_INPUT', 400);
  return value;
}

function requirePage(value: unknown): number {
  if (value === undefined || value === null || value === '') return 1;
  const page = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  const maximumPage = Math.ceil(AGENT_RUN_LIMITS.ownerRetention / AGENT_RUN_LIMITS.list);
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > maximumPage) {
    throw new AgentRunError(`Agent run page must be an integer from 1 to ${maximumPage}.`, 'INVALID_AGENT_RUN_INPUT', 400);
  }
  return page;
}

export function validateAgentRunInput(value: unknown): { prompt: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentRunError('Agent run input must be a JSON object.', 'INVALID_AGENT_RUN_INPUT', 400);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'prompt') || typeof input.prompt !== 'string') {
    throw new AgentRunError('Agent run input must contain only a prompt string.', 'INVALID_AGENT_RUN_INPUT', 400);
  }
  const prompt = input.prompt.normalize('NFC').trim();
  const unsafe = [...prompt].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point === 0xfffd || /\p{Cf}/u.test(character) || (point < 32 && point !== 9 && point !== 10)
      || (point >= 127 && point <= 159);
  });
  if (!prompt || Buffer.byteLength(prompt, 'utf8') > AGENT_RUN_LIMITS.promptBytes || unsafe) {
    throw new AgentRunError('Agent prompt must contain 1 to 16384 safe UTF-8 bytes.', 'INVALID_AGENT_RUN_INPUT', 400);
  }
  return { prompt };
}

function normalizeUsage(value: AiUsage | undefined): AiUsage | undefined {
  if (!value) return undefined;
  const output: AiUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'totalDurationMs', 'loadDurationMs'] as const) {
    const item = value[key];
    if (item !== undefined && Number.isFinite(item) && item >= 0) {
      const maximum = key === 'totalTokens' ? 200_000_000
        : key === 'inputTokens' || key === 'outputTokens' ? 100_000_000
          : 86_400_000;
      output[key] = Math.min(Math.floor(item), maximum);
    }
  }
  return Object.keys(output).length ? output : undefined;
}

function safeRuntimeLabel(value: unknown, maximum: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.normalize('NFC').trim();
  const unsafe = [...normalized].some((character) => character.codePointAt(0) === 0xfffd || /[\p{Cc}\p{Cf}]/u.test(character));
  return normalized && Buffer.byteLength(normalized, 'utf8') <= maximum && !unsafe ? normalized : fallback;
}

interface ActiveRun { ownerId: string; controller: AbortController; cancelRequested: boolean; timedOut: boolean; outputLimit: boolean }

export interface PreparedAgentRun { ownerId: string; agent: AgentRecord; prompt: string }
export type AgentRunStreamEvent =
  | { type: 'run'; run: PublicAgentRun }
  | { type: 'start'; runId: string; provider: string; model: string }
  | { type: 'delta'; runId: string; content: string }
  | { type: 'usage'; runId: string; usage: AiUsage }
  | { type: 'completed'; run: PublicAgentRun };

const TERMINAL = new Set<AgentRunStatus>(['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted']);

export class AgentRunService {
  private readonly activeByRun = new Map<string, ActiveRun>();
  private readonly activeByOwner = new Map<string, string>();

  constructor(
    private readonly repository: AgentRunRepository = mongooseAgentRunRepository,
    private readonly agents: Pick<AgentService, 'getRecord' | 'getDeletableRecord' | 'getExecutableRecord'> = agentService,
    private readonly provider: () => AiProviderClient = getAiProvider,
    private readonly timeoutMs = 30_000,
    private readonly now: () => Date = () => new Date()
  ) {}

  async prepare(ownerIdValue: unknown, agentIdValue: unknown, inputValue: unknown): Promise<PreparedAgentRun> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const agentId = requireObjectId(agentIdValue, 'Agent id');
    const input = validateAgentRunInput(inputValue);
    const agent = await this.agents.getExecutableRecord(ownerId, agentId);
    if (this.activeByOwner.has(ownerId)) throw new AgentRunError('Only one agent run may execute at a time for this user.', 'AGENT_RUN_BUSY', 429);
    return { ownerId, agent, prompt: input.prompt };
  }

  async execute(
    prepared: PreparedAgentRun,
    onEvent: (event: AgentRunStreamEvent) => void,
    externalSignal?: AbortSignal
  ): Promise<PublicAgentRun> {
    if (this.activeByOwner.has(prepared.ownerId)) throw new AgentRunError('Only one agent run may execute at a time for this user.', 'AGENT_RUN_BUSY', 429);
    const agentId = String(prepared.agent._id);
    if (!tryAcquireAgentExecutionLease(prepared.ownerId, agentId)) {
      throw new AgentRunError('The agent is currently being changed or executed.', 'AGENT_RUN_CONFLICT', 409);
    }
    this.activeByOwner.set(prepared.ownerId, 'pending');
    let executionAgent: AgentRecord;
    try {
      // Re-read while holding the execution/delete lease. A valid prepare result must
      // not allow a run to start after the agent was deleted or archived.
      executionAgent = await this.agents.getExecutableRecord(prepared.ownerId, agentId);
    } catch (error) {
      this.activeByOwner.delete(prepared.ownerId);
      releaseAgentExecutionLease(prepared.ownerId, agentId);
      if (error instanceof AgentError && error.code === 'AGENT_STORAGE_UNAVAILABLE') {
        throw new AgentRunError('Agent storage is unavailable.', 'AGENT_RUN_STORAGE_UNAVAILABLE', 503);
      }
      if (error instanceof AgentError || error instanceof ProjectError) {
        throw new AgentRunError('The agent is no longer available for execution.', 'AGENT_RUN_CONFLICT', 409);
      }
      throw new AgentRunError('Agent run storage is unavailable.', 'AGENT_RUN_STORAGE_UNAVAILABLE', 503);
    }
    let ownerRunCount: number;
    try { ownerRunCount = await this.repository.countByOwner(prepared.ownerId); }
    catch {
      this.activeByOwner.delete(prepared.ownerId);
      releaseAgentExecutionLease(prepared.ownerId, agentId);
      throw new AgentRunError('Agent run storage is unavailable.', 'AGENT_RUN_STORAGE_UNAVAILABLE', 503);
    }
    if (ownerRunCount >= AGENT_RUN_LIMITS.ownerRetention) {
      this.activeByOwner.delete(prepared.ownerId);
      releaseAgentExecutionLease(prepared.ownerId, agentId);
      throw new AgentRunError('The saved agent run limit has been reached. Delete terminal runs before starting another.', 'AGENT_RUN_LIMIT_REACHED', 409);
    }
    const queuedAt = this.now();
    let run: AgentRunRecord;
    try {
      run = await this.repository.create({
        ownerId: prepared.ownerId,
        ...(executionAgent.projectId ? { projectId: executionAgent.projectId } : {}),
        agentId: executionAgent._id,
        agentSnapshot: {
          name: executionAgent.name,
          systemPromptHash: createHash('sha256').update(executionAgent.systemPrompt).digest('hex'),
          requestedModel: executionAgent.aiModel,
          temperature: executionAgent.temperature,
          tools: [],
        },
        prompt: prepared.prompt,
        status: 'queued', output: '', outputBytes: 0, outputTruncated: false,
        timeline: [{ sequence: 1, type: 'created', timestamp: queuedAt }], queuedAt,
      });
    } catch {
      this.activeByOwner.delete(prepared.ownerId);
      releaseAgentExecutionLease(prepared.ownerId, agentId);
      throw new AgentRunError('Agent run storage is unavailable.', 'AGENT_RUN_STORAGE_UNAVAILABLE', 503);
    }
    const runId = String(run._id);
    this.activeByOwner.set(prepared.ownerId, runId);
    const active: ActiveRun = { ownerId: prepared.ownerId, controller: new AbortController(), cancelRequested: false, timedOut: false, outputLimit: false };
    this.activeByRun.set(runId, active);
    const externalAbort = (): void => { active.cancelRequested = true; active.controller.abort(); };
    const timer = setTimeout(() => { active.timedOut = true; active.controller.abort(); }, this.timeoutMs);
    timer.unref();
    let output = '';
    let providerId = 'configured';
    let actualModel = executionAgent.aiModel;
    let usage: AiUsage | undefined;
    let finishReason: 'stop' | 'length' | 'error' | 'unknown' = 'unknown';
    let selectedAt: Date | undefined;
    let acceptingProviderEvents = true;

    try {
      onEvent({ type: 'run', run: serializeRun(run, true) });
      if (externalSignal?.aborted) externalAbort();
      else externalSignal?.addEventListener('abort', externalAbort, { once: true });
      const startedAt = this.now();
      run = await this.safeTransition(prepared.ownerId, runId, ['queued'], { status: 'running', startedAt }, [
        { sequence: 2, type: 'started', timestamp: startedAt },
      ]);
      const provider = this.provider();
      providerId = safeRuntimeLabel(provider.id, 100, 'configured');
      const providerRequest = provider.chatStream({
        model: executionAgent.aiModel,
        messages: [{ role: 'system', content: executionAgent.systemPrompt }, { role: 'user', content: prepared.prompt }],
        temperature: executionAgent.temperature,
      }, (event: AiStreamEvent) => {
        if (!acceptingProviderEvents) return;
        providerId = safeRuntimeLabel(event.provider, 100, providerId);
        actualModel = safeRuntimeLabel(event.model, 200, actualModel);
        if (event.type === 'start') {
          selectedAt = this.now();
          onEvent({ type: 'start', runId, provider: providerId, model: actualModel });
        } else if (event.type === 'delta') {
          if (typeof event.content !== 'string') return;
          const next = output + event.content;
          if (Buffer.byteLength(next, 'utf8') > AGENT_RUN_LIMITS.outputBytes) {
            active.outputLimit = true; active.controller.abort();
            throw new AgentRunError('Agent output exceeded 256 KiB.', 'AGENT_OUTPUT_LIMIT', 413);
          }
          output = next;
          onEvent({ type: 'delta', runId, content: event.content });
        } else if (event.type === 'usage') {
          usage = normalizeUsage(event.usage);
          if (usage) onEvent({ type: 'usage', runId, usage });
        } else if (event.type === 'done') {
          usage = normalizeUsage(event.usage) ?? usage;
          finishReason = event.finishReason;
        }
      }, { signal: active.controller.signal });
      void providerRequest.catch(() => undefined);
      let rejectAbort!: (error: AgentRunError) => void;
      const aborted = new Promise<void>((_resolve, reject) => { rejectAbort = reject; });
      const abortRace = (): void => rejectAbort(new AgentRunError('The agent run was stopped.', 'AGENT_RUN_CONFLICT', 409));
      if (active.controller.signal.aborted) abortRace();
      else active.controller.signal.addEventListener('abort', abortRace, { once: true });
      try { await Promise.race([providerRequest, aborted]); }
      finally { active.controller.signal.removeEventListener('abort', abortRace); }

      if (active.cancelRequested) throw new AgentRunError('Agent run was cancelled.', 'AGENT_RUN_CONFLICT', 409);
      if (active.timedOut) throw new AgentRunError('Agent run timed out.', 'AGENT_TIMEOUT', 408);
      if (active.outputLimit) throw new AgentRunError('Agent output exceeded 256 KiB.', 'AGENT_OUTPUT_LIMIT', 413);
      const completedAt = this.now();
      const events: AgentRunTimeline[] = [
        ...(selectedAt ? [{ sequence: 3, type: 'provider_selected' as const, timestamp: selectedAt, provider: providerId, model: actualModel }] : []),
        { sequence: selectedAt ? 4 : 3, type: 'completed', timestamp: completedAt },
      ];
      const completed = await this.safeTransition(prepared.ownerId, runId, ['running'], {
        status: 'succeeded', provider: providerId, model: actualModel, output,
        outputBytes: Buffer.byteLength(output, 'utf8'), outputTruncated: false,
        ...(usage ? { usage } : {}), finishReason, completedAt,
      }, events);
      const result = serializeRun(completed, true);
      onEvent({ type: 'completed', run: result });
      return result;
    } catch (error) {
      acceptingProviderEvents = false;
      const completedAt = this.now();
      const classification = active.outputLimit
        ? { status: 'output_limit' as const, code: 'AGENT_OUTPUT_LIMIT', message: 'Agent output exceeded the 256 KiB limit.' }
        : active.timedOut
          ? { status: 'timed_out' as const, code: 'AGENT_TIMEOUT', message: 'The agent run timed out.' }
          : active.cancelRequested
            ? { status: 'cancelled' as const, code: undefined, message: undefined }
            : error instanceof AiProviderError && error.code === 'PROVIDER_UNAVAILABLE'
              ? { status: 'failed' as const, code: 'AGENT_PROVIDER_UNAVAILABLE', message: 'The configured AI provider is unavailable.' }
              : { status: 'failed' as const, code: 'AGENT_EXECUTION_FAILED', message: 'The agent run failed.' };
      const terminalEvents: AgentRunTimeline[] = [
        ...(selectedAt ? [{ sequence: 3, type: 'provider_selected' as const, timestamp: selectedAt, provider: providerId, model: actualModel }] : []),
        {
          sequence: 50,
          type: classification.status === 'cancelled' ? 'cancelled' as const : 'failed' as const,
          timestamp: completedAt,
          ...(classification.code ? { code: classification.code } : {}),
        },
      ];
      await this.safeTransition(prepared.ownerId, runId, ['queued', 'running', 'cancel-requested'], {
        status: classification.status, provider: providerId, model: actualModel, output,
        outputBytes: Buffer.byteLength(output, 'utf8'), outputTruncated: active.outputLimit,
        ...(usage ? { usage } : {}), finishReason: 'error', completedAt,
        ...(classification.code && classification.message ? { error: { code: classification.code, message: classification.message } } : {}),
      }, terminalEvents);
      if (classification.status === 'cancelled') throw new AgentRunError('Agent run was cancelled.', 'AGENT_RUN_CONFLICT', 409);
      throw new AgentRunError(classification.message ?? 'The agent run failed.', classification.code as AgentRunErrorCode, classification.status === 'timed_out' ? 408 : classification.status === 'output_limit' ? 413 : 503);
    } finally {
      acceptingProviderEvents = false;
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', externalAbort);
      this.activeByRun.delete(runId);
      if (this.activeByOwner.get(prepared.ownerId) === runId) this.activeByOwner.delete(prepared.ownerId);
      releaseAgentExecutionLease(prepared.ownerId, agentId);
    }
  }

  async list(ownerIdValue: unknown, agentIdValue: unknown, pageValue?: unknown): Promise<PublicAgentRunPage> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const agentId = requireObjectId(agentIdValue, 'Agent id');
    const page = requirePage(pageValue);
    await this.agents.getRecord(ownerId, agentId);
    try {
      const [records, total] = await Promise.all([
        this.repository.list(ownerId, agentId, (page - 1) * AGENT_RUN_LIMITS.list, AGENT_RUN_LIMITS.list),
        this.repository.countByOwnerAgent(ownerId, agentId),
      ]);
      return {
        runs: records.map((run) => serializeRun(run, false)),
        pagination: {
          page, pageSize: AGENT_RUN_LIMITS.list, total,
          totalPages: Math.max(1, Math.ceil(total / AGENT_RUN_LIMITS.list)),
        },
      };
    }
    catch { throw new AgentRunError('Agent run storage is unavailable.', 'AGENT_RUN_STORAGE_UNAVAILABLE', 503); }
  }

  async get(ownerIdValue: unknown, agentIdValue: unknown, runIdValue: unknown): Promise<PublicAgentRun> {
    return serializeRun(await this.getRecord(ownerIdValue, agentIdValue, runIdValue), true);
  }

  async cancel(ownerIdValue: unknown, agentIdValue: unknown, runIdValue: unknown): Promise<{ run: PublicAgentRun; idempotent: boolean }> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const agentId = requireObjectId(agentIdValue, 'Agent id');
    const runId = requireObjectId(runIdValue, 'Agent run id');
    const current = await this.getRecord(ownerId, agentId, runId);
    if (TERMINAL.has(current.status) || current.status === 'cancel-requested') return { run: serializeRun(current, true), idempotent: true };
    const timestamp = this.now();
    let requested: AgentRunRecord;
    try {
      requested = await this.safeTransition(ownerId, runId, ['queued', 'running'], {
        status: 'cancel-requested', cancelRequestedAt: timestamp,
      }, [{ sequence: 49, type: 'cancel_requested', timestamp }]);
    } catch (error) {
      if (!(error instanceof AgentRunError) || error.code !== 'AGENT_RUN_CONFLICT') throw error;
      const latest = await this.getRecord(ownerId, agentId, runId);
      if (TERMINAL.has(latest.status) || latest.status === 'cancel-requested') {
        return { run: serializeRun(latest, true), idempotent: true };
      }
      throw error;
    }
    const active = this.activeByRun.get(runId);
    if (active) {
      active.cancelRequested = true;
      active.controller.abort();
      return { run: serializeRun(requested, true), idempotent: false };
    }
    const completedAt = this.now();
    const interrupted = await this.safeTransition(ownerId, runId, ['cancel-requested'], {
      status: 'interrupted', completedAt,
      error: { code: 'AGENT_INTERRUPTED', message: 'The agent run was interrupted before cancellation could be delivered.' },
    }, [{ sequence: 50, type: 'failed', timestamp: completedAt, code: 'AGENT_INTERRUPTED' }]);
    return { run: serializeRun(interrupted, true), idempotent: false };
  }

  async delete(ownerIdValue: unknown, agentIdValue: unknown, runIdValue: unknown): Promise<{ runId: string; deleted: true }> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const agentId = requireObjectId(agentIdValue, 'Agent id');
    const runId = requireObjectId(runIdValue, 'Agent run id');
    await this.agents.getDeletableRecord(ownerId, agentId);
    const current = await this.getRecord(ownerId, agentId, runId);
    if (!TERMINAL.has(current.status)) {
      throw new AgentRunError('Only terminal agent runs can be deleted.', 'AGENT_RUN_CONFLICT', 409);
    }
    let deleted: AgentRunRecord | null;
    try { deleted = await this.repository.deleteTerminalByOwnerAgentAndId(ownerId, agentId, runId); }
    catch { throw new AgentRunError('Agent run storage is unavailable.', 'AGENT_RUN_STORAGE_UNAVAILABLE', 503); }
    if (!deleted) throw new AgentRunError('The agent run changed state concurrently.', 'AGENT_RUN_CONFLICT', 409);
    return { runId, deleted: true };
  }

  async recoverInterrupted(maxAgeMs = Math.max(this.timeoutMs * 2, 60_000)): Promise<number> {
    const now = this.now();
    try { return await this.repository.interruptActive(new Date(now.getTime() - maxAgeMs), now); }
    catch { throw new AgentRunError('Agent run recovery could not access storage.', 'AGENT_RUN_STORAGE_UNAVAILABLE', 503); }
  }

  private async getRecord(ownerIdValue: unknown, agentIdValue: unknown, runIdValue: unknown): Promise<AgentRunRecord> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const agentId = requireObjectId(agentIdValue, 'Agent id');
    const runId = requireObjectId(runIdValue, 'Agent run id');
    await this.agents.getRecord(ownerId, agentId);
    let run: AgentRunRecord | null;
    try { run = await this.repository.findByOwnerAgentAndId(ownerId, agentId, runId); }
    catch { throw new AgentRunError('Agent run storage is unavailable.', 'AGENT_RUN_STORAGE_UNAVAILABLE', 503); }
    if (!run) throw new AgentRunError('Agent run not found.', 'AGENT_RUN_NOT_FOUND', 404);
    return run;
  }

  private async safeTransition(
    ownerId: string,
    runId: string,
    allowed: AgentRunStatus[],
    changes: AgentRunChanges,
    events?: AgentRunTimeline[]
  ): Promise<AgentRunRecord> {
    let run: AgentRunRecord | null;
    try { run = await this.repository.transition(ownerId, runId, allowed, changes, events); }
    catch { throw new AgentRunError('Agent run storage is unavailable.', 'AGENT_RUN_STORAGE_UNAVAILABLE', 503); }
    if (!run) throw new AgentRunError('The agent run changed state concurrently.', 'AGENT_RUN_CONFLICT', 409);
    return run;
  }
}

export const agentRunService = new AgentRunService();
