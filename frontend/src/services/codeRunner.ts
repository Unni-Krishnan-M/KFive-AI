import { unwrapApiData } from './runtimeSettings';

export type CodeLanguage = 'python' | 'javascript';
export type CodeRunStatus =
  | 'queued'
  | 'running'
  | 'cancel-requested'
  | 'succeeded'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out'
  | 'resource-exceeded'
  | 'output-limit'
  | 'internal-error'
  | 'unknown';

export interface CodeRuntime {
  language: CodeLanguage;
  label: string;
  version?: string;
  available: boolean;
  message?: string;
}

export interface CodeRuntimeCatalog {
  enabled: boolean;
  available: boolean;
  runtimes: CodeRuntime[];
  message?: string;
}

export interface CodeRun {
  id: string;
  language: CodeLanguage;
  status: CodeRunStatus;
  source?: string;
  stdin?: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  durationMs?: number;
  memoryBytes?: number;
  runtimeVersion?: string;
  createdAt?: string;
  message?: string;
  outputTruncated?: boolean;
  signal?: string;
  oomKilled?: boolean;
  errorCode?: string;
}

type UnknownRecord = Record<string, unknown>;
const asRecord = (value: unknown): UnknownRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const boolean = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined;

function language(value: unknown): CodeLanguage | undefined {
  const candidate = text(value)?.toLowerCase();
  if (candidate === 'python' || candidate === 'python3') return 'python';
  if (candidate === 'javascript' || candidate === 'node' || candidate === 'nodejs') return 'javascript';
  return undefined;
}

function status(value: unknown): CodeRunStatus {
  const candidate = text(value)?.toLowerCase();
  if (candidate === 'queued' || candidate === 'running' || candidate === 'succeeded' || candidate === 'completed' || candidate === 'failed') return candidate;
  if (candidate === 'cancel-requested' || candidate === 'cancel_requested') return 'cancel-requested';
  if (candidate === 'cancelled' || candidate === 'canceled') return 'cancelled';
  if (candidate === 'timed-out' || candidate === 'timed_out' || candidate === 'timeout') return 'timed-out';
  if (candidate === 'resource-exceeded' || candidate === 'resource_exceeded') return 'resource-exceeded';
  if (candidate === 'output-limit' || candidate === 'output_limit') return 'output-limit';
  if (candidate === 'internal-error' || candidate === 'internal_error') return 'internal-error';
  return 'unknown';
}

function runtimeItem(value: unknown): CodeRuntime | undefined {
  const item = asRecord(value);
  const runtimeLanguage = language(item?.language ?? item?.id ?? item?.name);
  if (!item || !runtimeLanguage) return undefined;
  return {
    language: runtimeLanguage,
    label: text(item.label) || (runtimeLanguage === 'python' ? 'Python' : 'JavaScript'),
    version: text(item.version ?? item.runtimeVersion),
    available: typeof item.available === 'boolean' ? item.available : item.enabled !== false,
    message: text(item.message ?? item.reason),
  };
}

export function normalizeCodeRuntimes(payload: unknown): CodeRuntime[] {
  return normalizeCodeRuntimeCatalog(payload).runtimes;
}

export function normalizeCodeRuntimeCatalog(payload: unknown): CodeRuntimeCatalog {
  const value = unwrapApiData(payload);
  const root = asRecord(value);
  const items = Array.isArray(value) ? value : Array.isArray(root?.runtimes) ? root.runtimes : [];
  const enabled = root?.enabled !== false;
  const available = enabled && root?.available !== false;
  const message = text(root?.message ?? root?.reason);
  const runtimes = items.map(runtimeItem).filter((item): item is CodeRuntime => Boolean(item)).map((runtime) => ({
    ...runtime,
    available: available && runtime.available,
    message: runtime.message || (!available ? message : undefined),
  }));
  return { enabled, available, runtimes, message };
}

export function normalizeCodeRun(payload: unknown): CodeRun | undefined {
  const value = unwrapApiData(payload);
  const root = asRecord(value);
  const run = asRecord(root?.run) ?? root;
  if (!run) return undefined;
  const id = text(run.id ?? run._id);
  const runLanguage = language(run.language);
  if (!id || !runLanguage) return undefined;
  const metrics = asRecord(run.metrics) ?? {};
  const result = asRecord(run.result) ?? {};
  return {
    id,
    language: runLanguage,
    status: status(run.status),
    source: text(run.source),
    stdin: text(run.stdin),
    stdout: text(result.stdout ?? run.stdout) || '',
    stderr: text(result.stderr ?? run.stderr) || '',
    exitCode: number(result.exitCode ?? run.exitCode),
    durationMs: number(result.executionTimeMs ?? run.durationMs ?? run.executionTimeMs ?? metrics.durationMs),
    memoryBytes: number(result.memoryUsedBytes ?? run.memoryBytes ?? run.memoryUsageBytes ?? run.memoryUsedBytes ?? metrics.memoryBytes),
    runtimeVersion: text(run.runtimeVersion ?? run.version),
    createdAt: text(run.createdAt),
    message: text(result.errorMessage ?? run.message ?? run.error),
    outputTruncated: boolean(result.outputTruncated ?? run.outputTruncated),
    signal: text(result.signal ?? run.signal),
    oomKilled: boolean(result.oomKilled ?? run.oomKilled),
    errorCode: text(result.errorCode ?? run.errorCode),
  };
}

export function normalizeCodeRunList(payload: unknown): CodeRun[] {
  const value = unwrapApiData(payload);
  const root = asRecord(value);
  const items = Array.isArray(value) ? value : Array.isArray(root?.runs) ? root.runs : [];
  return items.map(normalizeCodeRun).filter((run): run is CodeRun => Boolean(run));
}

export const isPendingCodeRun = (run?: CodeRun): boolean =>
  run?.status === 'queued' || run?.status === 'running' || run?.status === 'cancel-requested';

export function nextCodePollRetryDelay(failureCount: number): number | undefined {
  if (!Number.isInteger(failureCount) || failureCount < 1 || failureCount > 5) return undefined;
  return Math.min(750 * (2 ** (failureCount - 1)), 6_000);
}

export function codeRunnerError(error: unknown, fallback: string): string {
  const candidate = asRecord(error);
  const response = asRecord(candidate?.response);
  const responseData = asRecord(response?.data);
  const errorValue = responseData?.error;
  const nestedError = asRecord(errorValue);
  const nestedData = asRecord(responseData?.data);
  return text(nestedError?.message)
    || text(errorValue)
    || text(nestedData?.message)
    || text(responseData?.message)
    || text(candidate?.message)
    || fallback;
}
