import { unwrapApiData } from './runtimeSettings';

export const WORKFLOW_INPUT_BYTES = 16 * 1024;
export const WORKFLOW_PROMPT_BYTES = 16 * 1024;
export const WORKFLOW_OUTPUT_BYTES = 256 * 1024;
export const WORKFLOW_RUN_HISTORY_LIMIT = 50;
export const WORKFLOW_RUN_MAX_PAGES = 10;
export const WORKFLOW_RUN_OWNER_RETENTION = WORKFLOW_RUN_HISTORY_LIMIT * WORKFLOW_RUN_MAX_PAGES;

export type WorkflowNodeType = 'input' | 'prompt' | 'llm' | 'output';
export type WorkflowRunStatus = 'queued' | 'running' | 'cancel-requested' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'output_limit' | 'interrupted';
export type WorkflowTimelineType = 'created' | 'started' | 'provider_selected' | 'cancel_requested' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowNode {
  id: WorkflowNodeType;
  type: WorkflowNodeType;
  label: 'Input' | 'Prompt' | 'LLM' | 'Output';
  position: { x: number; y: 0 };
  config: Record<string, never> | { template: string; systemPrompt: string } | { model: string; temperature: number };
}

export interface WorkflowEdge {
  id: 'input-to-prompt' | 'prompt-to-llm' | 'llm-to-output';
  source: WorkflowNodeType;
  target: WorkflowNodeType;
}

export interface WorkflowDefinition {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowView {
  id: string;
  projectId?: string;
  name: string;
  description: string;
  schemaVersion: 1;
  revision: number;
  definition: WorkflowDefinition;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDraft {
  name: string;
  description: string;
  template: string;
  systemPrompt: string;
  model: string;
  temperature: number;
}

export interface WorkflowPayload {
  name: string;
  description: string;
  definition: WorkflowDefinition;
  projectId?: string;
}

export interface WorkflowRunUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalDurationMs?: number;
  loadDurationMs?: number;
}

export interface WorkflowTimelineEvent {
  sequence: number;
  type: WorkflowTimelineType;
  timestamp: string;
  provider?: string;
  model?: string;
  code?: string;
}

export interface WorkflowRunSummary {
  id: string;
  workflowId: string;
  projectId?: string;
  status: WorkflowRunStatus;
  workflow: { name: string; revision: number; requestedModel: string; temperature: number };
  provider?: string;
  model?: string;
  usage?: WorkflowRunUsage;
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

export interface WorkflowRunDetail extends WorkflowRunSummary {
  input: string;
  output: string;
  timeline: WorkflowTimelineEvent[];
}

export interface WorkflowRunPagination {
  page: number;
  pageSize: 50;
  total: number;
  totalPages: number;
}

export interface WorkflowRunPage {
  runs: WorkflowRunSummary[];
  pagination: WorkflowRunPagination;
}

export interface WorkflowRunDeletion { runId: string; deleted: true }

type UnknownRecord = Record<string, unknown>;
const utf8 = new TextEncoder();
const RUN_STATUSES = new Set<WorkflowRunStatus>(['queued', 'running', 'cancel-requested', 'succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted']);
const TIMELINE_TYPES = new Set<WorkflowTimelineType>(['created', 'started', 'provider_selected', 'cancel_requested', 'completed', 'failed', 'cancelled']);
const FINISH_REASONS = new Set(['stop', 'length', 'error', 'unknown'] as const);
const FORMAT_OR_REPLACEMENT = /[\p{Cf}\uFFFD]/u;
const NODE_CONTRACT = [
  { id: 'input', type: 'input', label: 'Input', x: 0 },
  { id: 'prompt', type: 'prompt', label: 'Prompt', x: 320 },
  { id: 'llm', type: 'llm', label: 'LLM', x: 640 },
  { id: 'output', type: 'output', label: 'Output', x: 960 },
] as const;
const EDGE_CONTRACT = [
  { id: 'input-to-prompt', source: 'input', target: 'prompt' },
  { id: 'prompt-to-llm', source: 'prompt', target: 'llm' },
  { id: 'llm-to-output', source: 'llm', target: 'output' },
] as const;

const isRecordValue = (value: unknown): value is UnknownRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
const record = (value: unknown): UnknownRecord => isRecordValue(value) ? value : {};
const hasUnsafeText = (value: string): boolean => FORMAT_OR_REPLACEMENT.test(value) || [...value].some((character) => {
  const code = character.charCodeAt(0);
  return (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159);
});
const boundedString = (value: unknown, maximum: number, minimum = 1): string | undefined =>
  typeof value === 'string' && value.length >= minimum && value.length <= maximum && utf8.encode(value).byteLength <= maximum && !hasUnsafeText(value) ? value : undefined;
const boundedContent = (value: unknown, maximum: number, minimum = 1): string | undefined =>
  typeof value === 'string' && value.length >= minimum && utf8.encode(value).byteLength <= maximum ? value : undefined;
const boundedInteger = (value: unknown, maximum: number, minimum = 0): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum ? value : undefined;
const dateString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : undefined;
const objectId = (value: unknown): string | undefined => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value) ? value : undefined;
const exactKeys = (value: UnknownRecord, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const hasOneInputMarker = (template: string): boolean => template.split('{{input}}').length === 2;

export function buildWorkflowDefinition(draft: Pick<WorkflowDraft, 'template' | 'systemPrompt' | 'model' | 'temperature'>): WorkflowDefinition {
  return {
    nodes: [
      { id: 'input', type: 'input', label: 'Input', position: { x: 0, y: 0 }, config: {} },
      { id: 'prompt', type: 'prompt', label: 'Prompt', position: { x: 320, y: 0 }, config: { template: draft.template.trim(), systemPrompt: draft.systemPrompt.trim() } },
      { id: 'llm', type: 'llm', label: 'LLM', position: { x: 640, y: 0 }, config: { model: draft.model, temperature: draft.temperature } },
      { id: 'output', type: 'output', label: 'Output', position: { x: 960, y: 0 }, config: {} },
    ],
    edges: EDGE_CONTRACT.map((edge) => ({ ...edge })),
  };
}

export function buildWorkflowPayload(draft: WorkflowDraft, projectId?: string): WorkflowPayload {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    definition: buildWorkflowDefinition(draft),
    ...(projectId ? { projectId } : {}),
  };
}

export function workflowDraftError(draft: WorkflowDraft): string | undefined {
  const name = draft.name.trim();
  const description = draft.description.trim();
  const template = draft.template.trim();
  const systemPrompt = draft.systemPrompt.trim();
  if (!boundedString(name, 120)) return 'Name must contain 1–120 safe UTF-8 bytes.';
  if (boundedString(description, 2000, 0) === undefined) return 'Description must be 2,000 safe UTF-8 bytes or fewer.';
  if (!boundedString(template, WORKFLOW_PROMPT_BYTES)) return 'Prompt template must contain 1–16,384 safe UTF-8 bytes.';
  if (!hasOneInputMarker(template)) return 'Prompt template must contain {{input}} exactly once.';
  if (!boundedString(systemPrompt, WORKFLOW_PROMPT_BYTES)) return 'System prompt must contain 1–16,384 safe UTF-8 bytes.';
  if (!boundedString(draft.model, 200)) return 'Choose a provider-reported model.';
  if (!Number.isFinite(draft.temperature) || draft.temperature < 0 || draft.temperature > 2) return 'Temperature must be between 0 and 2.';
  return undefined;
}

export function normalizeWorkflowDefinition(value: unknown): WorkflowDefinition | undefined {
  if (!isRecordValue(value)) return undefined;
  const definition = record(value);
  if (!exactKeys(definition, ['nodes', 'edges'])) return undefined;
  if (!Array.isArray(definition.nodes) || definition.nodes.length !== NODE_CONTRACT.length
    || !Array.isArray(definition.edges) || definition.edges.length !== EDGE_CONTRACT.length) return undefined;
  const nodes: WorkflowNode[] = [];
  for (let index = 0; index < NODE_CONTRACT.length; index += 1) {
    const expected = NODE_CONTRACT[index];
    if (!isRecordValue(definition.nodes[index])) return undefined;
    const node = record(definition.nodes[index]);
    if (!isRecordValue(node.position) || !isRecordValue(node.config)) return undefined;
    const position = record(node.position);
    const config = record(node.config);
    if (!exactKeys(node, ['id', 'type', 'label', 'position', 'config']) || !exactKeys(position, ['x', 'y'])
      || node.id !== expected.id || node.type !== expected.type || node.label !== expected.label || position.x !== expected.x || position.y !== 0) return undefined;
    if (expected.type === 'prompt') {
      const template = boundedString(config.template, WORKFLOW_PROMPT_BYTES);
      const systemPrompt = boundedString(config.systemPrompt, WORKFLOW_PROMPT_BYTES);
      if (!exactKeys(config, ['template', 'systemPrompt']) || !template || !systemPrompt || !hasOneInputMarker(template)) return undefined;
      nodes.push({ id: expected.id, type: expected.type, label: expected.label, position: { x: expected.x, y: 0 }, config: { template, systemPrompt } });
    } else if (expected.type === 'llm') {
      const model = boundedString(config.model, 200);
      const temperature = config.temperature;
      if (!exactKeys(config, ['model', 'temperature']) || !model || typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) return undefined;
      nodes.push({ id: expected.id, type: expected.type, label: expected.label, position: { x: expected.x, y: 0 }, config: { model, temperature } });
    } else {
      if (!exactKeys(config, [])) return undefined;
      nodes.push({ id: expected.id, type: expected.type, label: expected.label, position: { x: expected.x, y: 0 }, config: {} });
    }
  }
  const edges: WorkflowEdge[] = [];
  for (let index = 0; index < EDGE_CONTRACT.length; index += 1) {
    const expected = EDGE_CONTRACT[index];
    if (!isRecordValue(definition.edges[index])) return undefined;
    const edge = record(definition.edges[index]);
    if (!exactKeys(edge, ['id', 'source', 'target']) || edge.id !== expected.id || edge.source !== expected.source || edge.target !== expected.target) return undefined;
    edges.push({ ...expected });
  }
  return { nodes, edges };
}

function workflowCandidate(value: unknown): UnknownRecord {
  const root = record(unwrapApiData(value));
  return Object.keys(record(root.workflow)).length ? record(root.workflow) : root;
}

export function normalizeWorkflow(value: unknown): WorkflowView | undefined {
  const workflow = workflowCandidate(value);
  const id = objectId(workflow.id);
  const projectId = workflow.projectId === undefined ? undefined : objectId(workflow.projectId);
  const name = boundedString(workflow.name, 120);
  const description = boundedString(workflow.description, 2000, 0);
  const revision = boundedInteger(workflow.revision, 1_000_000, 1);
  const definition = normalizeWorkflowDefinition(workflow.definition);
  const createdAt = dateString(workflow.createdAt);
  const updatedAt = dateString(workflow.updatedAt);
  if (!id || (workflow.projectId !== undefined && !projectId) || !name || description === undefined || workflow.schemaVersion !== 1 || !revision || !definition || !createdAt || !updatedAt) return undefined;
  return { id, ...(projectId ? { projectId } : {}), name, description, schemaVersion: 1, revision, definition, createdAt, updatedAt };
}

export function normalizeWorkflows(value: unknown): WorkflowView[] | undefined {
  const root = record(unwrapApiData(value));
  if (!Array.isArray(root.workflows) || root.workflows.length > 100) return undefined;
  const workflows = root.workflows.map(normalizeWorkflow);
  return workflows.some((workflow) => !workflow) ? undefined : workflows as WorkflowView[];
}

export function workflowDraftFromView(workflow: WorkflowView): WorkflowDraft {
  const prompt = workflow.definition.nodes[1].config as { template: string; systemPrompt: string };
  const llm = workflow.definition.nodes[2].config as { model: string; temperature: number };
  return { name: workflow.name, description: workflow.description, template: prompt.template, systemPrompt: prompt.systemPrompt, model: llm.model, temperature: llm.temperature };
}

export function normalizeWorkflowRunUsage(value: unknown): WorkflowRunUsage | undefined {
  const usage = record(value);
  const result: WorkflowRunUsage = {};
  const limits: Record<keyof WorkflowRunUsage, number> = { inputTokens: 100_000_000, outputTokens: 100_000_000, totalTokens: 200_000_000, totalDurationMs: 86_400_000, loadDurationMs: 86_400_000 };
  for (const key of Object.keys(limits) as Array<keyof WorkflowRunUsage>) {
    if (usage[key] === undefined) continue;
    const normalized = boundedInteger(usage[key], limits[key]);
    if (normalized === undefined) return undefined;
    result[key] = normalized;
  }
  return Object.keys(result).length ? result : undefined;
}

export function normalizeWorkflowTimeline(value: unknown): WorkflowTimelineEvent[] | undefined {
  if (!Array.isArray(value) || value.length > WORKFLOW_RUN_HISTORY_LIMIT) return undefined;
  const result: WorkflowTimelineEvent[] = [];
  for (const item of value) {
    const event = record(item);
    const sequence = boundedInteger(event.sequence, WORKFLOW_RUN_HISTORY_LIMIT, 1);
    const type = typeof event.type === 'string' && TIMELINE_TYPES.has(event.type as WorkflowTimelineType) ? event.type as WorkflowTimelineType : undefined;
    const timestamp = dateString(event.timestamp);
    const provider = event.provider === undefined ? undefined : boundedString(event.provider, 100);
    const model = event.model === undefined ? undefined : boundedString(event.model, 200);
    const code = event.code === undefined ? undefined : boundedString(event.code, 100);
    if (!sequence || !type || !timestamp || (event.provider !== undefined && !provider) || (event.model !== undefined && !model) || (event.code !== undefined && !code)) return undefined;
    result.push({ sequence, type, timestamp, ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(code ? { code } : {}) });
  }
  return result;
}

function runCandidate(value: unknown): UnknownRecord {
  const root = record(unwrapApiData(value));
  return Object.keys(record(root.run)).length ? record(root.run) : root;
}

export function normalizeWorkflowRunSummary(value: unknown): WorkflowRunSummary | undefined {
  const run = runCandidate(value);
  const workflow = record(run.workflow);
  const id = objectId(run.id);
  const workflowId = objectId(run.workflowId);
  const projectId = run.projectId === undefined ? undefined : objectId(run.projectId);
  const status = typeof run.status === 'string' && RUN_STATUSES.has(run.status as WorkflowRunStatus) ? run.status as WorkflowRunStatus : undefined;
  const name = boundedString(workflow.name, 120);
  const revision = boundedInteger(workflow.revision, 1_000_000, 1);
  const requestedModel = boundedString(workflow.requestedModel, 200);
  const temperature = workflow.temperature;
  const outputBytes = boundedInteger(run.outputBytes, WORKFLOW_OUTPUT_BYTES);
  const queuedAt = dateString(run.queuedAt);
  if (!id || !workflowId || (run.projectId !== undefined && !projectId) || !status || !name || !revision || !requestedModel
    || typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2
    || outputBytes === undefined || typeof run.outputTruncated !== 'boolean' || !queuedAt) return undefined;
  const provider = run.provider === undefined ? undefined : boundedString(run.provider, 100);
  const model = run.model === undefined ? undefined : boundedString(run.model, 200);
  const usage = run.usage === undefined ? undefined : normalizeWorkflowRunUsage(run.usage);
  const finishReason = typeof run.finishReason === 'string' && FINISH_REASONS.has(run.finishReason as 'stop' | 'length' | 'error' | 'unknown') ? run.finishReason as WorkflowRunSummary['finishReason'] : undefined;
  const error = record(run.error);
  const errorCode = run.error === undefined ? undefined : boundedString(error.code, 100);
  const errorMessage = run.error === undefined ? undefined : boundedString(error.message, 300);
  if ((run.provider !== undefined && !provider) || (run.model !== undefined && !model) || (run.usage !== undefined && !usage)
    || (run.finishReason !== undefined && !finishReason) || (run.error !== undefined && (!errorCode || !errorMessage))) return undefined;
  const dates: Partial<Pick<WorkflowRunSummary, 'startedAt' | 'cancelRequestedAt' | 'completedAt' | 'createdAt' | 'updatedAt'>> = {};
  for (const key of ['startedAt', 'cancelRequestedAt', 'completedAt', 'createdAt', 'updatedAt'] as const) {
    if (run[key] === undefined) continue;
    const normalized = dateString(run[key]);
    if (!normalized) return undefined;
    dates[key] = normalized;
  }
  return {
    id, workflowId, ...(projectId ? { projectId } : {}), status,
    workflow: { name, revision, requestedModel, temperature },
    ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}),
    outputBytes, outputTruncated: run.outputTruncated, ...(errorCode && errorMessage ? { error: { code: errorCode, message: errorMessage } } : {}), queuedAt, ...dates,
  };
}

export function normalizeWorkflowRunDetail(value: unknown): WorkflowRunDetail | undefined {
  const run = runCandidate(value);
  const summary = normalizeWorkflowRunSummary(run);
  const input = boundedContent(run.input, WORKFLOW_INPUT_BYTES);
  const output = boundedContent(run.output, WORKFLOW_OUTPUT_BYTES, 0);
  const timeline = normalizeWorkflowTimeline(run.timeline);
  if (!summary || !input || output === undefined || !timeline) return undefined;
  return { ...summary, input, output, timeline };
}

export function normalizeWorkflowRunPage(value: unknown): WorkflowRunPage | undefined {
  const root = record(unwrapApiData(value));
  const pagination = record(root.pagination);
  const page = boundedInteger(pagination.page, WORKFLOW_RUN_MAX_PAGES, 1);
  const pageSize = boundedInteger(pagination.pageSize, WORKFLOW_RUN_HISTORY_LIMIT, 1);
  const total = boundedInteger(pagination.total, WORKFLOW_RUN_OWNER_RETENTION);
  const totalPages = boundedInteger(pagination.totalPages, WORKFLOW_RUN_MAX_PAGES, 1);
  if (!page || pageSize !== WORKFLOW_RUN_HISTORY_LIMIT || total === undefined || !totalPages
    || totalPages !== Math.max(1, Math.ceil(total / pageSize)) || !Array.isArray(root.runs) || root.runs.length > pageSize) return undefined;
  const runs = root.runs.map(normalizeWorkflowRunSummary);
  if (runs.some((run) => !run)) return undefined;
  return { runs: runs as WorkflowRunSummary[], pagination: { page, pageSize: WORKFLOW_RUN_HISTORY_LIMIT, total, totalPages } };
}

export function normalizeWorkflowRunDeletion(value: unknown): WorkflowRunDeletion | undefined {
  const root = record(unwrapApiData(value));
  const runId = objectId(root.runId);
  return runId && root.deleted === true ? { runId, deleted: true } : undefined;
}

export const isActiveWorkflowRun = (run?: WorkflowRunSummary): boolean => Boolean(run && (run.status === 'queued' || run.status === 'running' || run.status === 'cancel-requested'));
export const isTerminalWorkflowRun = (run?: WorkflowRunSummary): boolean => Boolean(run && !isActiveWorkflowRun(run));
export function normalizeWorkflowStreamIdentity(provider: unknown, model: unknown): { provider: string; model: string } | undefined {
  const safeProvider = boundedString(provider, 100);
  const safeModel = boundedString(model, 200);
  return safeProvider && safeModel ? { provider: safeProvider, model: safeModel } : undefined;
}
export const workflowScopeKey = (requested: boolean, projectId?: string): string => requested ? (projectId ? `project:${projectId}` : 'project:pending') : 'workspace';
export const isWorkflowScopeRequestCurrent = (currentScope: string, requestedScope: string, currentGeneration: number, requestGeneration: number): boolean => currentScope === requestedScope && currentGeneration === requestGeneration;
