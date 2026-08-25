import { unwrapApiData } from './runtimeSettings';

export const AGENT_RUN_OUTPUT_BYTES = 256 * 1024;
export const AGENT_RUN_PROMPT_BYTES = 16 * 1024;
export const AGENT_RUN_HISTORY_LIMIT = 50;
export const AGENT_RUN_MAX_PAGES = 10;
export const AGENT_RUN_OWNER_RETENTION = AGENT_RUN_HISTORY_LIMIT * AGENT_RUN_MAX_PAGES;

export interface AgentView {
  id: string;
  projectId?: string;
  name: string;
  description: string;
  systemPrompt: string;
  aiModel: string;
  temperature: number;
  tools: [];
  toolState: 'disabled' | 'legacy-blocked';
}

export type AgentDraft = Partial<AgentView> & { model?: string };

export interface AgentPayload {
  name?: string;
  description: string;
  systemPrompt?: string;
  aiModel?: string;
  temperature?: number;
  tools: [];
  projectId?: string;
}

export type AgentRunStatus = 'queued' | 'running' | 'cancel-requested' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'output_limit' | 'interrupted';
export type AgentRunTimelineType = 'created' | 'started' | 'provider_selected' | 'cancel_requested' | 'completed' | 'failed' | 'cancelled';

export interface AgentRunUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalDurationMs?: number;
  loadDurationMs?: number;
}

export interface AgentRunTimelineEvent {
  sequence: number;
  type: AgentRunTimelineType;
  timestamp: string;
  provider?: string;
  model?: string;
  code?: string;
}

export interface AgentRunSummary {
  id: string;
  agentId: string;
  projectId?: string;
  status: AgentRunStatus;
  agent: { name: string; requestedModel: string; temperature: number; tools: [] };
  provider?: string;
  model?: string;
  usage?: AgentRunUsage;
  finishReason?: 'stop' | 'length' | 'error' | 'unknown';
  outputBytes: number;
  outputTruncated: boolean;
  error?: { code: string; message: string };
  queuedAt: string;
  startedAt?: string;
  cancelRequestedAt?: string;
  completedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentRunDetail extends AgentRunSummary {
  prompt: string;
  output: string;
  timeline: AgentRunTimelineEvent[];
}

export interface AgentRunPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AgentRunPage {
  runs: AgentRunSummary[];
  pagination: AgentRunPagination;
}

export interface AgentRunDeletion {
  runId: string;
  deleted: true;
}

type RecordValue = Record<string, unknown>;
const RUN_STATUSES = new Set<AgentRunStatus>(['queued', 'running', 'cancel-requested', 'succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted']);
const TIMELINE_TYPES = new Set<AgentRunTimelineType>(['created', 'started', 'provider_selected', 'cancel_requested', 'completed', 'failed', 'cancelled']);
const FINISH_REASONS = new Set(['stop', 'length', 'error', 'unknown'] as const);
const utf8 = new TextEncoder();

const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const boundedString = (value: unknown, maximum: number, minimum = 1): string | undefined =>
  typeof value === 'string' && value.length >= minimum && value.length <= maximum && utf8.encode(value).byteLength <= maximum ? value : undefined;
const boundedInteger = (value: unknown, maximum: number): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum ? value : undefined;
const dateString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : undefined;

export function normalizeAgent(value: unknown): AgentView | undefined {
  const agent = record(value);
  const id = boundedString(agent.id, 128) ?? boundedString(agent._id, 128);
  const name = boundedString(agent.name, 100);
  const systemPrompt = boundedString(agent.systemPrompt, 20_000);
  if (!id || !name || !systemPrompt || (agent.tools !== undefined && (!Array.isArray(agent.tools) || agent.tools.length !== 0))) return undefined;
  const aiModel = boundedString(agent.aiModel, 200) ?? boundedString(agent.model, 200) ?? '';
  const description = boundedString(agent.description, 1000, 0);
  const temperature = agent.temperature === undefined ? 0.7 : agent.temperature;
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) return undefined;
  const projectId = boundedString(agent.projectId, 128);
  const toolState = agent.toolState === 'legacy-blocked' ? 'legacy-blocked' : 'disabled';
  return { id, ...(projectId ? { projectId } : {}), name, description: description ?? '', systemPrompt, aiModel, temperature, tools: [], toolState };
}

export function buildAgentPayload(draft: AgentDraft, projectId?: string): AgentPayload {
  const aiModel = draft.aiModel || draft.model;
  return {
    name: draft.name?.trim(), description: draft.description?.trim() || '', systemPrompt: draft.systemPrompt?.trim(),
    aiModel: aiModel || undefined, temperature: draft.temperature, tools: [], ...(projectId ? { projectId } : {}),
  };
}

export function normalizeAgentRunUsage(value: unknown): AgentRunUsage | undefined {
  const usage = record(value);
  const result: AgentRunUsage = {};
  const limits: Record<keyof AgentRunUsage, number> = { inputTokens: 100_000_000, outputTokens: 100_000_000, totalTokens: 200_000_000, totalDurationMs: 86_400_000, loadDurationMs: 86_400_000 };
  for (const key of Object.keys(limits) as Array<keyof AgentRunUsage>) {
    if (usage[key] === undefined) continue;
    const normalized = boundedInteger(usage[key], limits[key]);
    if (normalized === undefined) return undefined;
    result[key] = normalized;
  }
  return Object.keys(result).length ? result : undefined;
}

export function normalizeAgentRunTimeline(value: unknown): AgentRunTimelineEvent[] | undefined {
  if (!Array.isArray(value) || value.length > AGENT_RUN_HISTORY_LIMIT) return undefined;
  const result: AgentRunTimelineEvent[] = [];
  for (const item of value) {
    const event = record(item);
    const sequence = boundedInteger(event.sequence, AGENT_RUN_HISTORY_LIMIT);
    const type = typeof event.type === 'string' && TIMELINE_TYPES.has(event.type as AgentRunTimelineType) ? event.type as AgentRunTimelineType : undefined;
    const timestamp = dateString(event.timestamp);
    if (!sequence || !type || !timestamp) return undefined;
    const provider = event.provider === undefined ? undefined : boundedString(event.provider, 100);
    const model = event.model === undefined ? undefined : boundedString(event.model, 200);
    const code = event.code === undefined ? undefined : boundedString(event.code, 100);
    if ((event.provider !== undefined && !provider) || (event.model !== undefined && !model) || (event.code !== undefined && !code)) return undefined;
    result.push({ sequence, type, timestamp, ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(code ? { code } : {}) });
  }
  return result;
}

function runCandidate(value: unknown): RecordValue {
  const root = record(unwrapApiData(value));
  return Object.keys(record(root.run)).length ? record(root.run) : root;
}

export function normalizeAgentRunSummary(value: unknown): AgentRunSummary | undefined {
  const run = runCandidate(value);
  const agent = record(run.agent);
  const id = boundedString(run.id, 128);
  const agentId = boundedString(run.agentId, 128);
  const status = typeof run.status === 'string' && RUN_STATUSES.has(run.status as AgentRunStatus) ? run.status as AgentRunStatus : undefined;
  const name = boundedString(agent.name, 100);
  const requestedModel = boundedString(agent.requestedModel, 200);
  const temperature = agent.temperature;
  const outputBytes = boundedInteger(run.outputBytes, AGENT_RUN_OUTPUT_BYTES);
  const queuedAt = dateString(run.queuedAt);
  if (!id || !agentId || !status || !name || !requestedModel || typeof temperature !== 'number' || !Number.isFinite(temperature)
    || temperature < 0 || temperature > 2 || !Array.isArray(agent.tools) || agent.tools.length !== 0
    || outputBytes === undefined || typeof run.outputTruncated !== 'boolean' || !queuedAt) return undefined;

  const provider = run.provider === undefined ? undefined : boundedString(run.provider, 100);
  const model = run.model === undefined ? undefined : boundedString(run.model, 200);
  const projectId = run.projectId === undefined ? undefined : boundedString(run.projectId, 128);
  const usage = run.usage === undefined ? undefined : normalizeAgentRunUsage(run.usage);
  const finishReason = typeof run.finishReason === 'string' && FINISH_REASONS.has(run.finishReason as 'stop' | 'length' | 'error' | 'unknown') ? run.finishReason as AgentRunSummary['finishReason'] : undefined;
  const error = record(run.error);
  const errorCode = run.error === undefined ? undefined : boundedString(error.code, 100);
  const errorMessage = run.error === undefined ? undefined : boundedString(error.message, 300);
  if ((run.provider !== undefined && !provider) || (run.model !== undefined && !model) || (run.projectId !== undefined && !projectId)
    || (run.usage !== undefined && !usage) || (run.finishReason !== undefined && !finishReason) || (run.error !== undefined && (!errorCode || !errorMessage))) return undefined;

  const optionalDates = ['startedAt', 'cancelRequestedAt', 'completedAt', 'createdAt', 'updatedAt'] as const;
  const dates: Partial<Record<typeof optionalDates[number], string>> = {};
  for (const key of optionalDates) {
    if (run[key] === undefined) continue;
    const normalized = dateString(run[key]);
    if (!normalized) return undefined;
    dates[key] = normalized;
  }
  return {
    id, agentId, ...(projectId ? { projectId } : {}), status, agent: { name, requestedModel, temperature, tools: [] },
    ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}),
    outputBytes, outputTruncated: run.outputTruncated, ...(errorCode && errorMessage ? { error: { code: errorCode, message: errorMessage } } : {}), queuedAt, ...dates,
  };
}

export function normalizeAgentRunDetail(value: unknown): AgentRunDetail | undefined {
  const run = runCandidate(value);
  const summary = normalizeAgentRunSummary(run);
  const prompt = boundedString(run.prompt, AGENT_RUN_PROMPT_BYTES);
  const output = boundedString(run.output, AGENT_RUN_OUTPUT_BYTES, 0);
  const timeline = normalizeAgentRunTimeline(run.timeline);
  if (!summary || !prompt || output === undefined || !timeline) return undefined;
  return { ...summary, prompt, output, timeline };
}

export function normalizeAgentRunList(value: unknown): AgentRunSummary[] {
  const root = record(unwrapApiData(value));
  const items = Array.isArray(root.runs) ? root.runs.slice(0, AGENT_RUN_HISTORY_LIMIT) : [];
  return items.map(normalizeAgentRunSummary).filter((run): run is AgentRunSummary => Boolean(run));
}

export function normalizeAgentRunPage(value: unknown): AgentRunPage | undefined {
  const root = record(unwrapApiData(value));
  const pagination = record(root.pagination);
  const page = boundedInteger(pagination.page, AGENT_RUN_MAX_PAGES);
  const pageSize = boundedInteger(pagination.pageSize, AGENT_RUN_HISTORY_LIMIT);
  const total = boundedInteger(pagination.total, AGENT_RUN_OWNER_RETENTION);
  const totalPages = boundedInteger(pagination.totalPages, AGENT_RUN_MAX_PAGES);
  if (!page || pageSize !== AGENT_RUN_HISTORY_LIMIT || total === undefined || !totalPages
    || totalPages !== Math.max(1, Math.ceil(total / pageSize)) || !Array.isArray(root.runs) || root.runs.length > pageSize) return undefined;
  const runs = root.runs.map(normalizeAgentRunSummary);
  if (runs.some((run) => !run)) return undefined;
  return { runs: runs as AgentRunSummary[], pagination: { page, pageSize, total, totalPages } };
}

export function normalizeAgentRunDeletion(value: unknown): AgentRunDeletion | undefined {
  const root = record(unwrapApiData(value));
  const runId = boundedString(root.runId, 128);
  return runId && root.deleted === true ? { runId, deleted: true } : undefined;
}

export function isActiveAgentRun(run: AgentRunSummary | undefined): boolean {
  return Boolean(run && (run.status === 'queued' || run.status === 'running' || run.status === 'cancel-requested'));
}

export function isTerminalAgentRun(run: AgentRunSummary | undefined): boolean {
  return Boolean(run && !isActiveAgentRun(run));
}
