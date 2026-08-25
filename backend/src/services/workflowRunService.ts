import { WorkflowDefinition, WORKFLOW_TEMPLATE_TOKEN } from '@/models/Workflow';
import { WorkflowRunModel, WorkflowRunStatus, WorkflowRunTimelineType } from '@/models/WorkflowRun';
import { AiProviderClient, AiStreamEvent, AiUsage } from '@/services/ai/types';
import { AiProviderError } from '@/services/ai/errors';
import { getAiProvider } from '@/services/aiProvider';
import { ProjectError } from './projectService';
import { WorkflowError, WorkflowRecord, WorkflowService, normalizeWorkflowDefinition, workflowService } from './workflowService';
import { releaseWorkflowExecutionLease, tryAcquireWorkflowExecutionLease } from './workflowExecutionLease';

export const WORKFLOW_RUN_LIMITS = Object.freeze({
  inputBytes: 16 * 1024,
  renderedPromptBytes: 32 * 1024,
  outputBytes: 256 * 1024,
  list: 50,
  ownerRetention: 500,
  ownerConcurrency: 1,
});

export type WorkflowRunErrorCode =
  | 'INVALID_WORKFLOW_RUN_INPUT'
  | 'WORKFLOW_RUN_NOT_FOUND'
  | 'WORKFLOW_RUN_BUSY'
  | 'WORKFLOW_RUN_CONFLICT'
  | 'WORKFLOW_RUN_LIMIT_REACHED'
  | 'WORKFLOW_RUN_STORAGE_UNAVAILABLE'
  | 'WORKFLOW_PROVIDER_UNAVAILABLE'
  | 'WORKFLOW_TIMEOUT'
  | 'WORKFLOW_EXECUTION_FAILED'
  | 'WORKFLOW_OUTPUT_LIMIT'
  | 'WORKFLOW_INTERRUPTED';

export class WorkflowRunError extends Error {
  readonly isOperational = true;
  constructor(message: string, readonly code: WorkflowRunErrorCode, readonly statusCode: number) {
    super(message);
    this.name = 'WorkflowRunError';
  }
}

export interface WorkflowRunTimeline {
  sequence: number;
  type: WorkflowRunTimelineType;
  timestamp: Date;
  provider?: string;
  model?: string;
  code?: string;
}

export interface WorkflowRunRecord {
  _id: unknown;
  ownerId: unknown;
  projectId?: unknown;
  workflowId: unknown;
  workflowSnapshot: { name: string; schemaVersion: 1; revision: number; definition: WorkflowDefinition };
  input: string;
  status: WorkflowRunStatus;
  provider?: string;
  model?: string;
  output: string;
  outputBytes: number;
  outputTruncated: boolean;
  usage?: AiUsage;
  finishReason?: 'stop' | 'length' | 'error' | 'unknown';
  error?: { code?: string; message?: string };
  timeline: WorkflowRunTimeline[];
  queuedAt: Date;
  startedAt?: Date;
  cancelRequestedAt?: Date;
  completedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  [key: string]: unknown;
}

export type WorkflowRunCreateData = Omit<WorkflowRunRecord, '_id' | 'createdAt' | 'updatedAt'>;
export type WorkflowRunChanges = Partial<Omit<WorkflowRunRecord,
  '_id' | 'ownerId' | 'workflowId' | 'projectId' | 'workflowSnapshot' | 'input' | 'queuedAt' | 'timeline'>>;

export interface WorkflowRunRepository {
  create(value: WorkflowRunCreateData): Promise<WorkflowRunRecord>;
  list(ownerId: string, workflowId: string, offset: number, limit: number): Promise<WorkflowRunRecord[]>;
  countByOwnerWorkflow(ownerId: string, workflowId: string): Promise<number>;
  findByOwnerWorkflowAndId(ownerId: string, workflowId: string, runId: string): Promise<WorkflowRunRecord | null>;
  countByOwner(ownerId: string): Promise<number>;
  deleteTerminalByOwnerWorkflowAndId(ownerId: string, workflowId: string, runId: string): Promise<WorkflowRunRecord | null>;
  transition(
    ownerId: string,
    runId: string,
    allowed: WorkflowRunStatus[],
    changes: WorkflowRunChanges,
    events?: WorkflowRunTimeline[]
  ): Promise<WorkflowRunRecord | null>;
  interruptActive(before: Date, completedAt: Date): Promise<number>;
}

export const mongooseWorkflowRunRepository: WorkflowRunRepository = {
  async create(value) { return WorkflowRunModel.create(value) as unknown as Promise<WorkflowRunRecord>; },
  async list(ownerId, workflowId, offset, limit) {
    return WorkflowRunModel.find({ ownerId, workflowId }).sort({ createdAt: -1, _id: -1 })
      .skip(offset).limit(limit).lean() as unknown as Promise<WorkflowRunRecord[]>;
  },
  async countByOwnerWorkflow(ownerId, workflowId) { return WorkflowRunModel.countDocuments({ ownerId, workflowId }); },
  async findByOwnerWorkflowAndId(ownerId, workflowId, runId) {
    return WorkflowRunModel.findOne({ _id: runId, ownerId, workflowId }).lean() as unknown as Promise<WorkflowRunRecord | null>;
  },
  async countByOwner(ownerId) { return WorkflowRunModel.countDocuments({ ownerId }); },
  async deleteTerminalByOwnerWorkflowAndId(ownerId, workflowId, runId) {
    return WorkflowRunModel.findOneAndDelete({
      _id: runId, ownerId, workflowId,
      status: { $in: ['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted'] },
    }).lean() as unknown as Promise<WorkflowRunRecord | null>;
  },
  async transition(ownerId, runId, allowed, changes, events = []) {
    return WorkflowRunModel.findOneAndUpdate(
      { _id: runId, ownerId, status: { $in: allowed } },
      { $set: changes, ...(events.length ? { $push: { timeline: { $each: events, $slice: -50 } } } : {}) },
      { new: true, runValidators: true }
    ).lean() as unknown as Promise<WorkflowRunRecord | null>;
  },
  async interruptActive(before, completedAt) {
    const result = await WorkflowRunModel.updateMany(
      { status: { $in: ['queued', 'running', 'cancel-requested'] }, updatedAt: { $lt: before } },
      {
        $set: {
          status: 'interrupted', completedAt,
          error: { code: 'WORKFLOW_INTERRUPTED', message: 'The workflow run was interrupted before completion.' },
        },
        $push: { timeline: { $each: [{ sequence: 50, type: 'failed', timestamp: completedAt, code: 'WORKFLOW_INTERRUPTED' }], $slice: -50 } },
      }
    );
    return result.modifiedCount;
  },
};

export interface PublicWorkflowRun {
  id: string;
  workflowId: string;
  projectId?: string;
  status: WorkflowRunStatus;
  workflow: { name: string; revision: number; requestedModel: string; temperature: number };
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
  input?: string;
  output?: string;
  timeline?: WorkflowRunTimeline[];
}

export interface PublicWorkflowRunPage {
  runs: PublicWorkflowRun[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

function llmConfig(definition: WorkflowDefinition): { model: string; temperature: number } {
  const node = definition.nodes[2];
  if (node.type !== 'llm') throw new WorkflowRunError('The workflow definition is invalid.', 'WORKFLOW_RUN_CONFLICT', 409);
  return node.config;
}

function promptConfig(definition: WorkflowDefinition): { template: string; systemPrompt: string } {
  const node = definition.nodes[1];
  if (node.type !== 'prompt') throw new WorkflowRunError('The workflow definition is invalid.', 'WORKFLOW_RUN_CONFLICT', 409);
  return node.config;
}

function serializeRun(record: WorkflowRunRecord, detail: boolean): PublicWorkflowRun {
  const requested = llmConfig(record.workflowSnapshot.definition);
  return {
    id: String(record._id), workflowId: String(record.workflowId),
    ...(record.projectId ? { projectId: String(record.projectId) } : {}), status: record.status,
    workflow: {
      name: record.workflowSnapshot.name, revision: record.workflowSnapshot.revision,
      requestedModel: requested.model, temperature: requested.temperature,
    },
    ...(record.provider ? { provider: record.provider } : {}), ...(record.model ? { model: record.model } : {}),
    ...(record.usage ? { usage: record.usage } : {}), ...(record.finishReason ? { finishReason: record.finishReason } : {}),
    outputBytes: record.outputBytes, outputTruncated: record.outputTruncated,
    ...(record.error?.code && record.error.message ? { error: { code: record.error.code, message: record.error.message } } : {}),
    queuedAt: record.queuedAt, ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.cancelRequestedAt ? { cancelRequestedAt: record.cancelRequestedAt } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.createdAt ? { createdAt: record.createdAt } : {}), ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    ...(detail ? { input: record.input, output: record.output, timeline: record.timeline } : {}),
  };
}

function requireObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) {
    throw new WorkflowRunError(`${label} is invalid.`, 'INVALID_WORKFLOW_RUN_INPUT', 400);
  }
  return value;
}

function requirePage(value: unknown): number {
  if (value === undefined || value === null || value === '') return 1;
  const page = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  const maximumPage = Math.ceil(WORKFLOW_RUN_LIMITS.ownerRetention / WORKFLOW_RUN_LIMITS.list);
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > maximumPage) {
    throw new WorkflowRunError(`Workflow run page must be an integer from 1 to ${maximumPage}.`, 'INVALID_WORKFLOW_RUN_INPUT', 400);
  }
  return page;
}

export function validateWorkflowRunInput(value: unknown): { input: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new WorkflowRunError('Workflow run input must be a JSON object.', 'INVALID_WORKFLOW_RUN_INPUT', 400);
  }
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some((key) => key !== 'input') || typeof request.input !== 'string') {
    throw new WorkflowRunError('Workflow run input must contain only an input string.', 'INVALID_WORKFLOW_RUN_INPUT', 400);
  }
  const input = request.input.normalize('NFC').trim();
  const unsafe = [...input].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point === 0xfffd || /\p{Cf}/u.test(character)
      || (point < 32 && point !== 9 && point !== 10) || (point >= 127 && point <= 159);
  });
  if (!input || Buffer.byteLength(input, 'utf8') > WORKFLOW_RUN_LIMITS.inputBytes || unsafe) {
    throw new WorkflowRunError('Workflow input must contain 1 to 16384 safe UTF-8 bytes.', 'INVALID_WORKFLOW_RUN_INPUT', 400);
  }
  return { input };
}

function renderPrompt(definition: WorkflowDefinition, input: string): string {
  const prompt = promptConfig(definition).template.split(WORKFLOW_TEMPLATE_TOKEN).join(input);
  if (Buffer.byteLength(prompt, 'utf8') > WORKFLOW_RUN_LIMITS.renderedPromptBytes) {
    throw new WorkflowRunError('The rendered workflow prompt exceeds 32768 UTF-8 bytes.', 'INVALID_WORKFLOW_RUN_INPUT', 413);
  }
  return prompt;
}

function normalizeUsage(value: AiUsage | undefined): AiUsage | undefined {
  if (!value) return undefined;
  const output: AiUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'totalDurationMs', 'loadDurationMs'] as const) {
    const item = value[key];
    if (item !== undefined && Number.isFinite(item) && item >= 0) {
      const maximum = key === 'totalTokens' ? 200_000_000
        : key === 'inputTokens' || key === 'outputTokens' ? 100_000_000 : 86_400_000;
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
export interface PreparedWorkflowRun { ownerId: string; workflow: WorkflowRecord; input: string; renderedPrompt: string }
export type WorkflowRunStreamEvent =
  | { type: 'run'; run: PublicWorkflowRun }
  | { type: 'start'; runId: string; provider: string; model: string }
  | { type: 'delta'; runId: string; content: string }
  | { type: 'usage'; runId: string; usage: AiUsage }
  | { type: 'completed'; run: PublicWorkflowRun };

const TERMINAL = new Set<WorkflowRunStatus>(['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted']);

export class WorkflowRunService {
  private readonly activeByRun = new Map<string, ActiveRun>();
  private readonly activeByOwner = new Map<string, string>();

  constructor(
    private readonly repository: WorkflowRunRepository = mongooseWorkflowRunRepository,
    private readonly workflows: Pick<WorkflowService, 'getRecord' | 'getDeletableRecord' | 'getActiveRecord'> = workflowService,
    private readonly provider: () => AiProviderClient = getAiProvider,
    private readonly timeoutMs = 30_000,
    private readonly now: () => Date = () => new Date()
  ) {}

  async prepare(ownerIdValue: unknown, workflowIdValue: unknown, inputValue: unknown): Promise<PreparedWorkflowRun> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const workflowId = requireObjectId(workflowIdValue, 'Workflow id');
    const input = validateWorkflowRunInput(inputValue).input;
    const workflow = await this.workflows.getActiveRecord(ownerId, workflowId);
    const definition = normalizeWorkflowDefinition(workflow.definition);
    if (this.activeByOwner.has(ownerId)) {
      throw new WorkflowRunError('Only one workflow run may execute at a time for this user.', 'WORKFLOW_RUN_BUSY', 429);
    }
    return { ownerId, workflow, input, renderedPrompt: renderPrompt(definition, input) };
  }

  async execute(
    prepared: PreparedWorkflowRun,
    onEvent: (event: WorkflowRunStreamEvent) => void,
    externalSignal?: AbortSignal
  ): Promise<PublicWorkflowRun> {
    if (this.activeByOwner.has(prepared.ownerId)) {
      throw new WorkflowRunError('Only one workflow run may execute at a time for this user.', 'WORKFLOW_RUN_BUSY', 429);
    }
    const workflowId = String(prepared.workflow._id);
    if (!tryAcquireWorkflowExecutionLease(prepared.ownerId, workflowId)) {
      throw new WorkflowRunError('The workflow is currently being changed or executed.', 'WORKFLOW_RUN_CONFLICT', 409);
    }
    this.activeByOwner.set(prepared.ownerId, 'pending');
    let executionWorkflow: WorkflowRecord;
    let definition: WorkflowDefinition;
    let renderedPrompt: string;
    try {
      executionWorkflow = await this.workflows.getActiveRecord(prepared.ownerId, workflowId);
      definition = normalizeWorkflowDefinition(executionWorkflow.definition);
      renderedPrompt = renderPrompt(definition, prepared.input);
    } catch (error) {
      this.activeByOwner.delete(prepared.ownerId);
      releaseWorkflowExecutionLease(prepared.ownerId, workflowId);
      if (error instanceof WorkflowError && error.code === 'WORKFLOW_STORAGE_UNAVAILABLE') {
        throw new WorkflowRunError('Workflow storage is unavailable.', 'WORKFLOW_RUN_STORAGE_UNAVAILABLE', 503);
      }
      if (error instanceof WorkflowError || error instanceof ProjectError || error instanceof WorkflowRunError) {
        throw new WorkflowRunError('The workflow is no longer available for execution.', 'WORKFLOW_RUN_CONFLICT', 409);
      }
      throw new WorkflowRunError('Workflow run storage is unavailable.', 'WORKFLOW_RUN_STORAGE_UNAVAILABLE', 503);
    }
    let ownerRunCount: number;
    try { ownerRunCount = await this.repository.countByOwner(prepared.ownerId); }
    catch {
      this.activeByOwner.delete(prepared.ownerId);
      releaseWorkflowExecutionLease(prepared.ownerId, workflowId);
      throw new WorkflowRunError('Workflow run storage is unavailable.', 'WORKFLOW_RUN_STORAGE_UNAVAILABLE', 503);
    }
    if (ownerRunCount >= WORKFLOW_RUN_LIMITS.ownerRetention) {
      this.activeByOwner.delete(prepared.ownerId);
      releaseWorkflowExecutionLease(prepared.ownerId, workflowId);
      throw new WorkflowRunError('The saved workflow run limit has been reached. Delete terminal runs before starting another.', 'WORKFLOW_RUN_LIMIT_REACHED', 409);
    }
    const queuedAt = this.now();
    let run: WorkflowRunRecord;
    try {
      run = await this.repository.create({
        ownerId: prepared.ownerId, ...(executionWorkflow.projectId ? { projectId: executionWorkflow.projectId } : {}),
        workflowId: executionWorkflow._id,
        workflowSnapshot: {
          name: executionWorkflow.name, schemaVersion: 1, revision: executionWorkflow.revision,
          definition: normalizeWorkflowDefinition(definition),
        },
        input: prepared.input, status: 'queued', output: '', outputBytes: 0, outputTruncated: false,
        timeline: [{ sequence: 1, type: 'created', timestamp: queuedAt }], queuedAt,
      });
    } catch {
      this.activeByOwner.delete(prepared.ownerId);
      releaseWorkflowExecutionLease(prepared.ownerId, workflowId);
      throw new WorkflowRunError('Workflow run storage is unavailable.', 'WORKFLOW_RUN_STORAGE_UNAVAILABLE', 503);
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
    const requested = llmConfig(definition);
    const prompt = promptConfig(definition);
    let actualModel = requested.model;
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
        model: requested.model,
        messages: [{ role: 'system', content: prompt.systemPrompt }, { role: 'user', content: renderedPrompt }],
        temperature: requested.temperature,
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
          if (Buffer.byteLength(next, 'utf8') > WORKFLOW_RUN_LIMITS.outputBytes) {
            active.outputLimit = true;
            active.controller.abort();
            throw new WorkflowRunError('Workflow output exceeded 256 KiB.', 'WORKFLOW_OUTPUT_LIMIT', 413);
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
      let rejectAbort!: (error: WorkflowRunError) => void;
      const aborted = new Promise<void>((_resolve, reject) => { rejectAbort = reject; });
      const abortRace = (): void => rejectAbort(new WorkflowRunError('The workflow run was stopped.', 'WORKFLOW_RUN_CONFLICT', 409));
      if (active.controller.signal.aborted) abortRace();
      else active.controller.signal.addEventListener('abort', abortRace, { once: true });
      try { await Promise.race([providerRequest, aborted]); }
      finally { active.controller.signal.removeEventListener('abort', abortRace); }

      if (active.cancelRequested) throw new WorkflowRunError('Workflow run was cancelled.', 'WORKFLOW_RUN_CONFLICT', 409);
      if (active.timedOut) throw new WorkflowRunError('Workflow run timed out.', 'WORKFLOW_TIMEOUT', 408);
      if (active.outputLimit) throw new WorkflowRunError('Workflow output exceeded 256 KiB.', 'WORKFLOW_OUTPUT_LIMIT', 413);
      const completedAt = this.now();
      const events: WorkflowRunTimeline[] = [
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
        ? { status: 'output_limit' as const, code: 'WORKFLOW_OUTPUT_LIMIT', message: 'Workflow output exceeded the 256 KiB limit.' }
        : active.timedOut
          ? { status: 'timed_out' as const, code: 'WORKFLOW_TIMEOUT', message: 'The workflow run timed out.' }
          : active.cancelRequested
            ? { status: 'cancelled' as const, code: undefined, message: undefined }
            : error instanceof AiProviderError && error.code === 'PROVIDER_UNAVAILABLE'
              ? { status: 'failed' as const, code: 'WORKFLOW_PROVIDER_UNAVAILABLE', message: 'The configured AI provider is unavailable.' }
              : { status: 'failed' as const, code: 'WORKFLOW_EXECUTION_FAILED', message: 'The workflow run failed.' };
      const terminalEvents: WorkflowRunTimeline[] = [
        ...(selectedAt ? [{ sequence: 3, type: 'provider_selected' as const, timestamp: selectedAt, provider: providerId, model: actualModel }] : []),
        {
          sequence: 50, type: classification.status === 'cancelled' ? 'cancelled' as const : 'failed' as const,
          timestamp: completedAt, ...(classification.code ? { code: classification.code } : {}),
        },
      ];
      await this.safeTransition(prepared.ownerId, runId, ['queued', 'running', 'cancel-requested'], {
        status: classification.status, provider: providerId, model: actualModel, output,
        outputBytes: Buffer.byteLength(output, 'utf8'), outputTruncated: active.outputLimit,
        ...(usage ? { usage } : {}), finishReason: 'error', completedAt,
        ...(classification.code && classification.message ? { error: { code: classification.code, message: classification.message } } : {}),
      }, terminalEvents);
      if (classification.status === 'cancelled') throw new WorkflowRunError('Workflow run was cancelled.', 'WORKFLOW_RUN_CONFLICT', 409);
      throw new WorkflowRunError(
        classification.message ?? 'The workflow run failed.', classification.code as WorkflowRunErrorCode,
        classification.status === 'timed_out' ? 408 : classification.status === 'output_limit' ? 413 : 503
      );
    } finally {
      acceptingProviderEvents = false;
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', externalAbort);
      this.activeByRun.delete(runId);
      if (this.activeByOwner.get(prepared.ownerId) === runId) this.activeByOwner.delete(prepared.ownerId);
      releaseWorkflowExecutionLease(prepared.ownerId, workflowId);
    }
  }

  async list(ownerIdValue: unknown, workflowIdValue: unknown, pageValue?: unknown): Promise<PublicWorkflowRunPage> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const workflowId = requireObjectId(workflowIdValue, 'Workflow id');
    const page = requirePage(pageValue);
    await this.workflows.getRecord(ownerId, workflowId);
    try {
      const [records, total] = await Promise.all([
        this.repository.list(ownerId, workflowId, (page - 1) * WORKFLOW_RUN_LIMITS.list, WORKFLOW_RUN_LIMITS.list),
        this.repository.countByOwnerWorkflow(ownerId, workflowId),
      ]);
      return {
        runs: records.map((run) => serializeRun(run, false)),
        pagination: { page, pageSize: WORKFLOW_RUN_LIMITS.list, total, totalPages: Math.max(1, Math.ceil(total / WORKFLOW_RUN_LIMITS.list)) },
      };
    } catch { throw new WorkflowRunError('Workflow run storage is unavailable.', 'WORKFLOW_RUN_STORAGE_UNAVAILABLE', 503); }
  }

  async get(ownerIdValue: unknown, workflowIdValue: unknown, runIdValue: unknown): Promise<PublicWorkflowRun> {
    return serializeRun(await this.getRecord(ownerIdValue, workflowIdValue, runIdValue), true);
  }

  async cancel(ownerIdValue: unknown, workflowIdValue: unknown, runIdValue: unknown): Promise<{ run: PublicWorkflowRun; idempotent: boolean }> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const workflowId = requireObjectId(workflowIdValue, 'Workflow id');
    const runId = requireObjectId(runIdValue, 'Workflow run id');
    const current = await this.getRecord(ownerId, workflowId, runId);
    if (TERMINAL.has(current.status) || current.status === 'cancel-requested') return { run: serializeRun(current, true), idempotent: true };
    const timestamp = this.now();
    let requested: WorkflowRunRecord;
    try {
      requested = await this.safeTransition(ownerId, runId, ['queued', 'running'], {
        status: 'cancel-requested', cancelRequestedAt: timestamp,
      }, [{ sequence: 49, type: 'cancel_requested', timestamp }]);
    } catch (error) {
      if (!(error instanceof WorkflowRunError) || error.code !== 'WORKFLOW_RUN_CONFLICT') throw error;
      const latest = await this.getRecord(ownerId, workflowId, runId);
      if (TERMINAL.has(latest.status) || latest.status === 'cancel-requested') return { run: serializeRun(latest, true), idempotent: true };
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
      error: { code: 'WORKFLOW_INTERRUPTED', message: 'The workflow run was interrupted before cancellation could be delivered.' },
    }, [{ sequence: 50, type: 'failed', timestamp: completedAt, code: 'WORKFLOW_INTERRUPTED' }]);
    return { run: serializeRun(interrupted, true), idempotent: false };
  }

  async delete(ownerIdValue: unknown, workflowIdValue: unknown, runIdValue: unknown): Promise<{ runId: string; deleted: true }> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const workflowId = requireObjectId(workflowIdValue, 'Workflow id');
    const runId = requireObjectId(runIdValue, 'Workflow run id');
    await this.workflows.getDeletableRecord(ownerId, workflowId);
    const current = await this.getRecord(ownerId, workflowId, runId);
    if (!TERMINAL.has(current.status)) throw new WorkflowRunError('Only terminal workflow runs can be deleted.', 'WORKFLOW_RUN_CONFLICT', 409);
    let deleted: WorkflowRunRecord | null;
    try { deleted = await this.repository.deleteTerminalByOwnerWorkflowAndId(ownerId, workflowId, runId); }
    catch { throw new WorkflowRunError('Workflow run storage is unavailable.', 'WORKFLOW_RUN_STORAGE_UNAVAILABLE', 503); }
    if (!deleted) throw new WorkflowRunError('The workflow run changed state concurrently.', 'WORKFLOW_RUN_CONFLICT', 409);
    return { runId, deleted: true };
  }

  async recoverInterrupted(maxAgeMs = Math.max(this.timeoutMs * 2, 60_000)): Promise<number> {
    const now = this.now();
    try { return await this.repository.interruptActive(new Date(now.getTime() - maxAgeMs), now); }
    catch { throw new WorkflowRunError('Workflow run recovery could not access storage.', 'WORKFLOW_RUN_STORAGE_UNAVAILABLE', 503); }
  }

  private async getRecord(ownerIdValue: unknown, workflowIdValue: unknown, runIdValue: unknown): Promise<WorkflowRunRecord> {
    const ownerId = requireObjectId(ownerIdValue, 'Owner id');
    const workflowId = requireObjectId(workflowIdValue, 'Workflow id');
    const runId = requireObjectId(runIdValue, 'Workflow run id');
    await this.workflows.getRecord(ownerId, workflowId);
    let run: WorkflowRunRecord | null;
    try { run = await this.repository.findByOwnerWorkflowAndId(ownerId, workflowId, runId); }
    catch { throw new WorkflowRunError('Workflow run storage is unavailable.', 'WORKFLOW_RUN_STORAGE_UNAVAILABLE', 503); }
    if (!run) throw new WorkflowRunError('Workflow run not found.', 'WORKFLOW_RUN_NOT_FOUND', 404);
    return run;
  }

  private async safeTransition(
    ownerId: string,
    runId: string,
    allowed: WorkflowRunStatus[],
    changes: WorkflowRunChanges,
    events?: WorkflowRunTimeline[]
  ): Promise<WorkflowRunRecord> {
    let run: WorkflowRunRecord | null;
    try { run = await this.repository.transition(ownerId, runId, allowed, changes, events); }
    catch { throw new WorkflowRunError('Workflow run storage is unavailable.', 'WORKFLOW_RUN_STORAGE_UNAVAILABLE', 503); }
    if (!run) throw new WorkflowRunError('The workflow run changed state concurrently.', 'WORKFLOW_RUN_CONFLICT', 409);
    return run;
  }
}

export const workflowRunService = new WorkflowRunService();
