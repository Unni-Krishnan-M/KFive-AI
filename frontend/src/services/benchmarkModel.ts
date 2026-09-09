import { unwrapApiData } from './runtimeSettings';

export const BENCHMARK_SUITE_ID = 'chat-core-v1' as const;
export const BENCHMARK_CALLS = 6;
export const BENCHMARK_PAGE_SIZE = 25;
export const BENCHMARK_MAX_PAGES = 10;
export const BENCHMARK_OUTPUT_BYTES_PER_CALL = 16_384;
export const BENCHMARK_OUTPUT_BYTES_PER_RUN = 131_072;

export type BenchmarkRunStatus = 'queued' | 'running' | 'cancel-requested' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'output_limit' | 'interrupted';
export type BenchmarkFinishReason = 'stop' | 'length' | 'error' | 'unknown';
export type BenchmarkTimelineType = 'created' | 'started' | 'provider_selected' | 'call_started' | 'call_completed' | 'cancel_requested' | 'completed' | 'failed' | 'cancelled';

export interface BenchmarkStatus {
  execution: { scope: 'shared-benchmark-worker'; globalLimit: 1; ownerLimit: 1; active: boolean; queueDurable: true; workerAvailable: boolean };
  limits: { retentionPerOwner: number; pageSize: 25; maxPages: 10; runTimeoutMs: number; outputBytesPerCall: 16_384; outputBytesPerRun: 131_072 };
  warnings: { multiReplicaCoordination: true; remoteProviderBillingAndPrivacy: true };
  scope: { type: 'workspace' } | { type: 'project'; projectId: string; projectStatus: 'active' | 'archived' };
}

export interface BenchmarkSuite {
  id: typeof BENCHMARK_SUITE_ID;
  title: string;
  version: 1;
  promptCount: 3;
  repetitions: 2;
  totalCalls: 6;
  parameters: { maxOutputTokens: 128; temperature: 0; topP: 1 };
}

export interface BenchmarkModelSnapshot {
  id: string;
  digest?: string;
  sizeBytes?: number;
  contextWindow?: number;
}

export interface BenchmarkUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalDurationMs?: number;
  loadDurationMs?: number;
}

export interface BenchmarkPublicError { code: string; message: string }

export interface BenchmarkResult {
  callIndex: number;
  promptIndex: number;
  repetition: number;
  promptLength: number;
  passed: boolean;
  output: string;
  outputBytes: number;
  durationMs: number;
  ttftMs?: number;
  usage?: BenchmarkUsage;
  finishReason?: BenchmarkFinishReason;
  provider: string;
  model: string;
  error?: BenchmarkPublicError;
}

export interface BenchmarkAggregate {
  passCount: number;
  totalCalls: 6;
  medianTtftMs?: number;
  medianDurationMs: number;
  medianOutputBytes: number;
  outputTokens?: number;
  outputTokensPerSecond?: number;
}

export interface BenchmarkGpuDevice {
  index: number;
  name: string;
  driverVersion: string;
  memoryTotalMiB: number;
  memoryUsedMiB: number;
  memoryFreeMiB: number;
  utilizationPercent: number;
  temperatureC: number;
}

export interface BenchmarkGpuSnapshot {
  available: boolean;
  reason?: string;
  sampledAt: string;
  devices: BenchmarkGpuDevice[];
  summary?: { deviceCount: number; totalVramMiB: number; usedVramMiB: number; freeVramMiB: number };
}

export interface BenchmarkTimelineEvent {
  sequence: number;
  revision: number;
  type: BenchmarkTimelineType;
  timestamp: string;
  callIndex?: number;
  provider?: string;
  model?: string;
  code?: string;
}

export interface BenchmarkRunSummary {
  id: string;
  revision: number;
  projectId?: string;
  status: BenchmarkRunStatus;
  suite: Omit<BenchmarkSuite, 'title' | 'parameters'>;
  provider?: string;
  model: { requested: BenchmarkModelSnapshot; actual?: BenchmarkModelSnapshot };
  completedCalls: number;
  passedCalls: number;
  outputBytes: number;
  wallDurationMs?: number;
  aggregate?: BenchmarkAggregate;
  error?: BenchmarkPublicError;
  queuedAt: string;
  startedAt?: string;
  cancelRequestedAt?: string;
  completedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface BenchmarkRunDetail extends BenchmarkRunSummary {
  results: BenchmarkResult[];
  gpu: { before?: BenchmarkGpuSnapshot; after?: BenchmarkGpuSnapshot };
  timeline: BenchmarkTimelineEvent[];
}

export interface BenchmarkPagination { page: number; pageSize: 25; total: number; totalPages: number; maxPages: 10 }
export interface BenchmarkRunPage { runs: BenchmarkRunSummary[]; pagination: BenchmarkPagination }
export interface BenchmarkRunDeletion { runId: string; deleted: true }
export interface BenchmarkRunPayload { model: string; suiteId: typeof BENCHMARK_SUITE_ID; projectId?: string }

type UnknownRecord = Record<string, unknown>;
const RUN_STATUSES = new Set<BenchmarkRunStatus>(['queued', 'running', 'cancel-requested', 'succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted']);
const FINISH_REASONS = new Set<BenchmarkFinishReason>(['stop', 'length', 'error', 'unknown']);
const TIMELINE_TYPES = new Set<BenchmarkTimelineType>(['created', 'started', 'provider_selected', 'call_started', 'call_completed', 'cancel_requested', 'completed', 'failed', 'cancelled']);
const FORBIDDEN_KEYS = new Set(['ownerId', 'userId', 'uuid', 'gpuUuid', 'internal', 'internalError', 'stack', 'cause', 'providerUrl']);
const unsafeTextCharacter = /[\p{Cc}\p{Cf}]/u;
const utf8 = new TextEncoder();

const object = (value: unknown): UnknownRecord | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined;
const integer = (value: unknown, maximum: number, minimum = 0): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
const finite = (value: unknown, maximum = Number.MAX_SAFE_INTEGER, minimum = 0): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
const dateText = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : undefined;
const objectId = (value: unknown): string | undefined => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value) ? value : undefined;
const safeText = (value: unknown, maximum: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized.length > maximum || [...normalized].some((character) => unsafeTextCharacter.test(character) || character.codePointAt(0) === 0xfffd)) return undefined;
  return normalized;
};
const exactKeys = (value: UnknownRecord, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
const hasForbiddenField = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasForbiddenField);
  const record = object(value);
  if (!record) return false;
  return Object.entries(record).some(([key, child]) => FORBIDDEN_KEYS.has(key) || hasForbiddenField(child));
};

function rootRecord(payload: unknown, child?: string): UnknownRecord | undefined {
  if (hasForbiddenField(payload)) return undefined;
  const unwrapped = object(unwrapApiData(payload));
  return child ? object(unwrapped?.[child]) : unwrapped;
}

function normalizeError(value: unknown): BenchmarkPublicError | undefined {
  const source = object(value);
  if (!source || !exactKeys(source, ['code', 'message'])) return undefined;
  const code = safeText(source.code, 100);
  const message = safeText(source.message, 300);
  return code && message ? { code, message } : undefined;
}

function normalizeModel(value: unknown): BenchmarkModelSnapshot | undefined {
  const source = object(value);
  if (!source || !exactKeys(source, ['id', 'digest', 'sizeBytes', 'contextWindow'])) return undefined;
  const id = safeText(source.id, 200);
  if (!id) return undefined;
  const digest = source.digest === undefined ? undefined : safeText(source.digest, 200);
  const sizeBytes = source.sizeBytes === undefined ? undefined : integer(source.sizeBytes, Number.MAX_SAFE_INTEGER);
  const contextWindow = source.contextWindow === undefined ? undefined : integer(source.contextWindow, 100_000_000);
  if ((source.digest !== undefined && !digest) || (source.sizeBytes !== undefined && sizeBytes === undefined) || (source.contextWindow !== undefined && contextWindow === undefined)) return undefined;
  return { id, ...(digest ? { digest } : {}), ...(sizeBytes !== undefined ? { sizeBytes } : {}), ...(contextWindow !== undefined ? { contextWindow } : {}) };
}

function normalizeSuiteSummary(value: unknown): BenchmarkRunSummary['suite'] | undefined {
  const suite = object(value);
  if (!suite || !exactKeys(suite, ['id', 'version', 'promptCount', 'repetitions', 'totalCalls']) || suite.id !== BENCHMARK_SUITE_ID || suite.version !== 1 || suite.promptCount !== 3 || suite.repetitions !== 2 || suite.totalCalls !== 6) return undefined;
  return { id: BENCHMARK_SUITE_ID, version: 1, promptCount: 3, repetitions: 2, totalCalls: 6 };
}

function normalizeUsage(value: unknown): BenchmarkUsage | undefined {
  const usage = object(value);
  const keys: Array<keyof BenchmarkUsage> = ['inputTokens', 'outputTokens', 'totalTokens', 'totalDurationMs', 'loadDurationMs'];
  if (!usage || !exactKeys(usage, keys)) return undefined;
  const normalized: BenchmarkUsage = {};
  for (const key of keys) {
    if (usage[key] === undefined) continue;
    const number = integer(usage[key], key.endsWith('Tokens') ? 100_000_000 : 86_400_000);
    if (number === undefined) return undefined;
    normalized[key] = number;
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeAggregate(value: unknown): BenchmarkAggregate | undefined {
  const aggregate = object(value);
  if (!aggregate || !exactKeys(aggregate, ['passCount', 'totalCalls', 'medianTtftMs', 'medianDurationMs', 'medianOutputBytes', 'outputTokens', 'outputTokensPerSecond'])) return undefined;
  const passCount = integer(aggregate.passCount, BENCHMARK_CALLS);
  const medianDurationMs = finite(aggregate.medianDurationMs, 180_000);
  const medianOutputBytes = finite(aggregate.medianOutputBytes, BENCHMARK_OUTPUT_BYTES_PER_CALL);
  if (passCount === undefined || aggregate.totalCalls !== BENCHMARK_CALLS || medianDurationMs === undefined || medianOutputBytes === undefined) return undefined;
  const medianTtftMs = aggregate.medianTtftMs === undefined ? undefined : finite(aggregate.medianTtftMs, 180_000);
  const outputTokens = aggregate.outputTokens === undefined ? undefined : integer(aggregate.outputTokens, 600_000_000);
  const outputTokensPerSecond = aggregate.outputTokensPerSecond === undefined ? undefined : finite(aggregate.outputTokensPerSecond, 1_000_000_000);
  if ((aggregate.medianTtftMs !== undefined && medianTtftMs === undefined) || (aggregate.outputTokens !== undefined && outputTokens === undefined) || (aggregate.outputTokensPerSecond !== undefined && outputTokensPerSecond === undefined)) return undefined;
  return { passCount, totalCalls: 6, medianDurationMs, medianOutputBytes, ...(medianTtftMs !== undefined ? { medianTtftMs } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(outputTokensPerSecond !== undefined ? { outputTokensPerSecond } : {}) };
}

function normalizeRunRecord(value: unknown): BenchmarkRunSummary | undefined {
  const run = object(value);
  if (!run || hasForbiddenField(run) || !exactKeys(run, ['id', 'revision', 'projectId', 'status', 'suite', 'provider', 'model', 'completedCalls', 'passedCalls', 'outputBytes', 'wallDurationMs', 'aggregate', 'error', 'queuedAt', 'startedAt', 'cancelRequestedAt', 'completedAt', 'createdAt', 'updatedAt', 'results', 'gpu', 'timeline'])) return undefined;
  const id = objectId(run.id);
  const revision = integer(run.revision, 1_000_000, 1);
  const projectId = run.projectId === undefined ? undefined : objectId(run.projectId);
  const status = typeof run.status === 'string' && RUN_STATUSES.has(run.status as BenchmarkRunStatus) ? run.status as BenchmarkRunStatus : undefined;
  const suite = normalizeSuiteSummary(run.suite);
  const modelContainer = object(run.model);
  if (!modelContainer || !exactKeys(modelContainer, ['requested', 'actual'])) return undefined;
  const requested = normalizeModel(modelContainer.requested);
  const actual = modelContainer.actual === undefined ? undefined : normalizeModel(modelContainer.actual);
  const provider = run.provider === undefined ? undefined : safeText(run.provider, 100);
  const completedCalls = integer(run.completedCalls, BENCHMARK_CALLS);
  const passedCalls = integer(run.passedCalls, BENCHMARK_CALLS);
  const outputBytes = integer(run.outputBytes, BENCHMARK_OUTPUT_BYTES_PER_RUN);
  const queuedAt = dateText(run.queuedAt);
  if (!id || !revision || (run.projectId !== undefined && !projectId) || !status || !suite || !requested || (modelContainer.actual !== undefined && !actual) || (run.provider !== undefined && !provider) || completedCalls === undefined || passedCalls === undefined || passedCalls > completedCalls || outputBytes === undefined || !queuedAt) return undefined;
  const mayBeUnclaimedCancellation = (status === 'cancel-requested' || status === 'cancelled') && completedCalls === 0;
  if (status !== 'queued' && (!provider || (!actual && !mayBeUnclaimedCancellation))) return undefined;
  const optionalDateKeys = ['startedAt', 'cancelRequestedAt', 'completedAt', 'createdAt', 'updatedAt'] as const;
  const dates: Partial<Record<typeof optionalDateKeys[number], string>> = {};
  for (const key of optionalDateKeys) {
    if (run[key] === undefined) continue;
    const date = dateText(run[key]);
    if (!date) return undefined;
    dates[key] = date;
  }
  const wallDurationMs = run.wallDurationMs === undefined ? undefined : integer(run.wallDurationMs, 180_000);
  const aggregate = run.aggregate === undefined ? undefined : normalizeAggregate(run.aggregate);
  const error = run.error === undefined ? undefined : normalizeError(run.error);
  if ((run.wallDurationMs !== undefined && wallDurationMs === undefined) || (run.aggregate !== undefined && !aggregate) || (aggregate && aggregate.passCount !== passedCalls) || (run.error !== undefined && !error)) return undefined;
  return {
    id, revision, ...(projectId ? { projectId } : {}), status, suite, ...(provider ? { provider } : {}), model: { requested, ...(actual ? { actual } : {}) }, completedCalls, passedCalls, outputBytes,
    ...(wallDurationMs !== undefined ? { wallDurationMs } : {}), ...(aggregate ? { aggregate } : {}), ...(error ? { error } : {}), queuedAt, ...dates,
  };
}

function normalizeResult(value: unknown): BenchmarkResult | undefined {
  const result = object(value);
  if (!result || !exactKeys(result, ['callIndex', 'promptIndex', 'repetition', 'promptLength', 'passed', 'output', 'outputBytes', 'durationMs', 'ttftMs', 'usage', 'finishReason', 'provider', 'model', 'error'])) return undefined;
  const callIndex = integer(result.callIndex, 5);
  const promptIndex = integer(result.promptIndex, 2);
  const repetition = integer(result.repetition, 2, 1);
  const promptLength = integer(result.promptLength, 16_384, 1);
  const outputBytes = integer(result.outputBytes, BENCHMARK_OUTPUT_BYTES_PER_CALL);
  const durationMs = integer(result.durationMs, 180_000);
  const ttftMs = result.ttftMs === undefined ? undefined : integer(result.ttftMs, 180_000);
  const provider = safeText(result.provider, 100);
  const model = safeText(result.model, 200);
  const usage = result.usage === undefined ? undefined : normalizeUsage(result.usage);
  const error = result.error === undefined ? undefined : normalizeError(result.error);
  const finishReason = result.finishReason === undefined ? undefined : typeof result.finishReason === 'string' && FINISH_REASONS.has(result.finishReason as BenchmarkFinishReason) ? result.finishReason as BenchmarkFinishReason : undefined;
  if (callIndex === undefined || promptIndex === undefined || repetition === undefined || callIndex !== promptIndex * 2 + repetition - 1 || promptLength === undefined || typeof result.passed !== 'boolean' || typeof result.output !== 'string' || outputBytes === undefined || utf8.encode(result.output).byteLength !== outputBytes || durationMs === undefined || (result.ttftMs !== undefined && ttftMs === undefined) || (result.finishReason !== undefined && !finishReason) || !provider || !model || (result.usage !== undefined && !usage) || (result.error !== undefined && !error)) return undefined;
  return { callIndex, promptIndex, repetition, promptLength, passed: result.passed, output: result.output, outputBytes, durationMs, ...(ttftMs !== undefined ? { ttftMs } : {}), ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}), provider, model, ...(error ? { error } : {}) };
}

function normalizeGpuDevice(value: unknown): BenchmarkGpuDevice | undefined {
  const device = object(value);
  if (!device || !exactKeys(device, ['index', 'name', 'driverVersion', 'memoryTotalMiB', 'memoryUsedMiB', 'memoryFreeMiB', 'utilizationPercent', 'temperatureC'])) return undefined;
  const index = integer(device.index, 128);
  const name = safeText(device.name, 200);
  const driverVersion = safeText(device.driverVersion, 100);
  const memoryTotalMiB = integer(device.memoryTotalMiB, 10_000_000);
  const memoryUsedMiB = integer(device.memoryUsedMiB, 10_000_000);
  const memoryFreeMiB = integer(device.memoryFreeMiB, 10_000_000);
  const utilizationPercent = finite(device.utilizationPercent, 100);
  const temperatureC = finite(device.temperatureC, 200, -100);
  if (index === undefined || !name || !driverVersion || memoryTotalMiB === undefined || memoryUsedMiB === undefined || memoryFreeMiB === undefined || memoryUsedMiB > memoryTotalMiB || memoryFreeMiB > memoryTotalMiB || !Number.isFinite(utilizationPercent) || !Number.isFinite(temperatureC)) return undefined;
  return { index, name, driverVersion, memoryTotalMiB, memoryUsedMiB, memoryFreeMiB, utilizationPercent: utilizationPercent as number, temperatureC: temperatureC as number };
}

function normalizeGpuSnapshot(value: unknown): BenchmarkGpuSnapshot | undefined {
  const snapshot = object(value);
  if (!snapshot || !exactKeys(snapshot, ['available', 'reason', 'sampledAt', 'devices', 'summary']) || typeof snapshot.available !== 'boolean' || !Array.isArray(snapshot.devices) || snapshot.devices.length > 8) return undefined;
  const sampledAt = dateText(snapshot.sampledAt);
  const reason = snapshot.reason === undefined ? undefined : safeText(snapshot.reason, 100);
  const devices = snapshot.devices.map(normalizeGpuDevice);
  if (!sampledAt || (snapshot.reason !== undefined && !reason) || devices.some((device) => !device)) return undefined;
  let summary: BenchmarkGpuSnapshot['summary'];
  if (snapshot.summary !== undefined) {
    const source = object(snapshot.summary);
    if (!source || !exactKeys(source, ['deviceCount', 'totalVramMiB', 'usedVramMiB', 'freeVramMiB'])) return undefined;
    const deviceCount = integer(source.deviceCount, 8); const totalVramMiB = integer(source.totalVramMiB, 10_000_000); const usedVramMiB = integer(source.usedVramMiB, 10_000_000); const freeVramMiB = integer(source.freeVramMiB, 10_000_000);
    if (deviceCount === undefined || totalVramMiB === undefined || usedVramMiB === undefined || freeVramMiB === undefined || deviceCount !== devices.length || usedVramMiB > totalVramMiB || freeVramMiB > totalVramMiB) return undefined;
    summary = { deviceCount, totalVramMiB, usedVramMiB, freeVramMiB };
  }
  if (!snapshot.available && (devices.length || summary)) return undefined;
  return { available: snapshot.available, ...(reason ? { reason } : {}), sampledAt, devices: devices as BenchmarkGpuDevice[], ...(summary ? { summary } : {}) };
}

function normalizeTimeline(value: unknown): BenchmarkTimelineEvent[] | undefined {
  if (!Array.isArray(value) || value.length > 50) return undefined;
  const events: BenchmarkTimelineEvent[] = [];
  for (const item of value) {
    const event = object(item);
    if (!event || !exactKeys(event, ['sequence', 'revision', 'type', 'timestamp', 'callIndex', 'provider', 'model', 'code'])) return undefined;
    const sequence = integer(event.sequence, 50, 1);
    const revision = integer(event.revision, 1_000_000, 1);
    const type = typeof event.type === 'string' && TIMELINE_TYPES.has(event.type as BenchmarkTimelineType) ? event.type as BenchmarkTimelineType : undefined;
    const timestamp = dateText(event.timestamp);
    const callIndex = event.callIndex === undefined ? undefined : integer(event.callIndex, 5);
    const provider = event.provider === undefined ? undefined : safeText(event.provider, 100);
    const model = event.model === undefined ? undefined : safeText(event.model, 200);
    const code = event.code === undefined ? undefined : safeText(event.code, 100);
    if (!sequence || !revision || (events.length > 0 && (sequence <= events[events.length - 1].sequence || revision < events[events.length - 1].revision)) || !type || !timestamp || (event.callIndex !== undefined && callIndex === undefined) || (event.provider !== undefined && !provider) || (event.model !== undefined && !model) || (event.code !== undefined && !code)) return undefined;
    events.push({ sequence, revision, type, timestamp, ...(callIndex !== undefined ? { callIndex } : {}), ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(code ? { code } : {}) });
  }
  return events;
}

export function normalizeBenchmarkStatus(payload: unknown): BenchmarkStatus | undefined {
  const root = rootRecord(payload);
  const execution = object(root?.execution); const limits = object(root?.limits); const warnings = object(root?.warnings); const scope = object(root?.scope);
  if (!root || !exactKeys(root, ['execution', 'limits', 'warnings', 'scope']) || !execution || !limits || !warnings || !scope || !exactKeys(execution, ['scope', 'globalLimit', 'ownerLimit', 'active', 'queueDurable', 'workerAvailable']) || !exactKeys(limits, ['retentionPerOwner', 'pageSize', 'maxPages', 'runTimeoutMs', 'outputBytesPerCall', 'outputBytesPerRun']) || !exactKeys(warnings, ['multiReplicaCoordination', 'remoteProviderBillingAndPrivacy'])) return undefined;
  if (execution.scope !== 'shared-benchmark-worker' || execution.globalLimit !== 1 || execution.ownerLimit !== 1 || typeof execution.active !== 'boolean' || execution.queueDurable !== true || typeof execution.workerAvailable !== 'boolean' || limits.pageSize !== 25 || limits.maxPages !== 10 || limits.outputBytesPerCall !== 16_384 || limits.outputBytesPerRun !== 131_072 || warnings.multiReplicaCoordination !== true || warnings.remoteProviderBillingAndPrivacy !== true) return undefined;
  const retentionPerOwner = integer(limits.retentionPerOwner, 250, 1); const runTimeoutMs = integer(limits.runTimeoutMs, 3_600_000, 1);
  if (retentionPerOwner === undefined || runTimeoutMs === undefined) return undefined;
  let normalizedScope: BenchmarkStatus['scope'];
  if (scope.type === 'workspace' && exactKeys(scope, ['type'])) normalizedScope = { type: 'workspace' };
  else if (scope.type === 'project' && exactKeys(scope, ['type', 'projectId', 'projectStatus'])) {
    const projectId = objectId(scope.projectId);
    if (!projectId || (scope.projectStatus !== 'active' && scope.projectStatus !== 'archived')) return undefined;
    normalizedScope = { type: 'project', projectId, projectStatus: scope.projectStatus };
  } else return undefined;
  return { execution: { scope: 'shared-benchmark-worker', globalLimit: 1, ownerLimit: 1, active: execution.active, queueDurable: true, workerAvailable: execution.workerAvailable }, limits: { retentionPerOwner, pageSize: 25, maxPages: 10, runTimeoutMs, outputBytesPerCall: 16_384, outputBytesPerRun: 131_072 }, warnings: { multiReplicaCoordination: true, remoteProviderBillingAndPrivacy: true }, scope: normalizedScope };
}

export function normalizeBenchmarkSuites(payload: unknown): BenchmarkSuite[] | undefined {
  const root = rootRecord(payload);
  if (!root || !exactKeys(root, ['suites']) || !Array.isArray(root.suites) || root.suites.length !== 1) return undefined;
  const suite = object(root.suites[0]); const parameters = object(suite?.parameters);
  if (!suite || !parameters || !exactKeys(suite, ['id', 'title', 'version', 'promptCount', 'repetitions', 'totalCalls', 'parameters']) || !exactKeys(parameters, ['maxOutputTokens', 'temperature', 'topP']) || suite.id !== BENCHMARK_SUITE_ID || suite.version !== 1 || suite.promptCount !== 3 || suite.repetitions !== 2 || suite.totalCalls !== 6 || parameters.maxOutputTokens !== 128 || parameters.temperature !== 0 || parameters.topP !== 1) return undefined;
  const title = safeText(suite.title, 120);
  return title ? [{ id: BENCHMARK_SUITE_ID, title, version: 1, promptCount: 3, repetitions: 2, totalCalls: 6, parameters: { maxOutputTokens: 128, temperature: 0, topP: 1 } }] : undefined;
}

export function normalizeBenchmarkRunSummary(payload: unknown): BenchmarkRunSummary | undefined {
  const candidate = rootRecord(payload, 'run') ?? rootRecord(payload);
  return normalizeRunRecord(candidate);
}

export function normalizeBenchmarkRunDetail(payload: unknown): BenchmarkRunDetail | undefined {
  const candidate = rootRecord(payload, 'run') ?? rootRecord(payload);
  const summary = normalizeRunRecord(candidate);
  const resultsRaw = candidate?.results; const gpu = object(candidate?.gpu); const timelineRaw = candidate?.timeline;
  if (!summary || !Array.isArray(resultsRaw) || resultsRaw.length > BENCHMARK_CALLS || !gpu || !exactKeys(gpu, ['before', 'after'])) return undefined;
  const results = resultsRaw.map(normalizeResult);
  const before = gpu.before === undefined ? undefined : normalizeGpuSnapshot(gpu.before);
  const after = gpu.after === undefined ? undefined : normalizeGpuSnapshot(gpu.after);
  const timeline = normalizeTimeline(timelineRaw);
  if (results.some((result) => !result) || results.some((result, index) => result?.callIndex !== index) || results.length !== summary.completedCalls || results.reduce((sum, result) => sum + (result?.outputBytes ?? 0), 0) !== summary.outputBytes || results.filter((result) => result?.passed).length !== summary.passedCalls || (gpu.before !== undefined && !before) || (gpu.after !== undefined && !after) || !timeline || timeline.some((event) => event.revision > summary.revision)) return undefined;
  if (summary.status === 'succeeded' && results.length !== BENCHMARK_CALLS) return undefined;
  return { ...summary, results: results as BenchmarkResult[], gpu: { ...(before ? { before } : {}), ...(after ? { after } : {}) }, timeline };
}

export function normalizeBenchmarkRunPage(payload: unknown): BenchmarkRunPage | undefined {
  const root = rootRecord(payload); const pagination = object(root?.pagination);
  if (!root || !exactKeys(root, ['runs', 'pagination']) || !Array.isArray(root.runs) || root.runs.length > BENCHMARK_PAGE_SIZE || !pagination || !exactKeys(pagination, ['page', 'pageSize', 'total', 'totalPages', 'maxPages'])) return undefined;
  const page = integer(pagination.page, BENCHMARK_MAX_PAGES, 1); const total = integer(pagination.total, BENCHMARK_PAGE_SIZE * BENCHMARK_MAX_PAGES); const totalPages = integer(pagination.totalPages, BENCHMARK_MAX_PAGES, 1);
  if (!page || pagination.pageSize !== BENCHMARK_PAGE_SIZE || total === undefined || !totalPages || page > totalPages || pagination.maxPages !== BENCHMARK_MAX_PAGES) return undefined;
  const runs = root.runs.map(normalizeRunRecord);
  return runs.some((run) => !run) ? undefined : { runs: runs as BenchmarkRunSummary[], pagination: { page, pageSize: 25, total, totalPages, maxPages: 10 } };
}

export function normalizeBenchmarkRunDeletion(payload: unknown): BenchmarkRunDeletion | undefined {
  const root = rootRecord(payload);
  if (!root || !exactKeys(root, ['runId', 'deleted'])) return undefined;
  const runId = objectId(root.runId);
  return runId && root.deleted === true ? { runId, deleted: true } : undefined;
}

export function normalizeBenchmarkEventRevision(eventId: unknown, payloadRevision: unknown, previousRevision = 0): number | undefined {
  if (typeof eventId !== 'string' || !/^(0|[1-9]\d*)$/.test(eventId)) return undefined;
  const revision = integer(payloadRevision, 1_000_000, 1);
  return revision !== undefined && eventId === String(revision) && revision > previousRevision ? revision : undefined;
}

export function normalizeBenchmarkRunEvent(payload: unknown, eventId: unknown, expectedRunId?: string, previousRevision = 0): { revision: number; run: BenchmarkRunDetail } | undefined {
  const root = object(payload);
  if (!root || hasForbiddenField(root) || !exactKeys(root, ['revision', 'run'])) return undefined;
  const revision = normalizeBenchmarkEventRevision(eventId, root.revision, previousRevision);
  const run = normalizeBenchmarkRunDetail(root.run);
  return revision && run && run.revision === revision && (!expectedRunId || run.id === expectedRunId) ? { revision, run } : undefined;
}

export function normalizeBenchmarkCallStart(payload: unknown, eventId: unknown, expectedRunId?: string, previousRevision = 0): { revision: number; runId: string; callIndex: number; promptIndex: number; repetition: number } | undefined {
  const root = object(payload);
  if (!root || hasForbiddenField(root) || !exactKeys(root, ['revision', 'runId', 'callIndex', 'promptIndex', 'repetition'])) return undefined;
  const revision = normalizeBenchmarkEventRevision(eventId, root.revision, previousRevision);
  const runId = objectId(root.runId); const callIndex = integer(root.callIndex, 5); const promptIndex = integer(root.promptIndex, 2); const repetition = integer(root.repetition, 2, 1);
  if (!revision || !runId || (expectedRunId && expectedRunId !== runId) || callIndex === undefined || promptIndex === undefined || repetition === undefined || callIndex !== promptIndex * 2 + repetition - 1) return undefined;
  return { revision, runId, callIndex, promptIndex, repetition };
}

export function normalizeBenchmarkCallCompleted(payload: unknown, eventId: unknown, expectedRunId?: string, previousRevision = 0): { revision: number; runId: string; result: BenchmarkResult } | undefined {
  const root = object(payload);
  if (!root || hasForbiddenField(root) || !exactKeys(root, ['revision', 'runId', 'result'])) return undefined;
  const revision = normalizeBenchmarkEventRevision(eventId, root.revision, previousRevision);
  const runId = objectId(root.runId); const result = normalizeResult(root.result);
  return revision && runId && (!expectedRunId || expectedRunId === runId) && result ? { revision, runId, result } : undefined;
}

export function normalizeBenchmarkStreamError(payload: unknown, eventId: unknown, previousRevision = 0): { revision: number; error: string; code: string } | undefined {
  const root = object(payload);
  if (!root || hasForbiddenField(root) || !exactKeys(root, ['revision', 'error', 'code'])) return undefined;
  const revision = normalizeBenchmarkEventRevision(eventId, root.revision, previousRevision);
  const error = safeText(root.error, 300);
  const code = safeText(root.code, 100);
  return revision && error && code ? { revision, error, code } : undefined;
}

export function buildBenchmarkRunPayload(model: string, projectId?: string): BenchmarkRunPayload {
  return { model: model.trim(), suiteId: BENCHMARK_SUITE_ID, ...(projectId ? { projectId } : {}) };
}

export function isTerminalBenchmarkRun(run: Pick<BenchmarkRunSummary, 'status'>): boolean {
  return !['queued', 'running', 'cancel-requested'].includes(run.status);
}

export function areBenchmarkRunsCompatible(left?: BenchmarkRunSummary, right?: BenchmarkRunSummary): boolean {
  return Boolean(left && right && left.id !== right.id && left.status === 'succeeded' && right.status === 'succeeded' && left.suite.id === right.suite.id && left.suite.version === right.suite.version && left.suite.promptCount === right.suite.promptCount && left.suite.repetitions === right.suite.repetitions && left.suite.totalCalls === right.suite.totalCalls);
}

export function benchmarkScopeKey(projectRequested: boolean, projectId?: string): string {
  return !projectRequested ? 'workspace' : projectId ? `project:${projectId}` : 'project:pending';
}

export function benchmarkResumeKey(scope: string, runId: string, revision: number): string {
  return `${scope}:${runId}:${revision}`;
}

export function effectiveBenchmarkProjectStatus(
  contextStatus?: string,
  backendStatus?: string
): 'active' | 'archived' | undefined {
  if (backendStatus === 'active' || backendStatus === 'archived') return backendStatus;
  return contextStatus === 'active' || contextStatus === 'archived' ? contextStatus : undefined;
}

export function isBenchmarkScopeRequestCurrent(currentScope: string, requestScope: string, currentRequest: number, request: number): boolean {
  return currentScope === requestScope && currentRequest === request;
}

export function benchmarkReport(run: BenchmarkRunDetail): BenchmarkRunDetail {
  return JSON.parse(JSON.stringify(run)) as BenchmarkRunDetail;
}
