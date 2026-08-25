export type SupportedLanguage = 'python' | 'javascript';

export interface ExecutionRequest {
  runId: string;
  language: SupportedLanguage;
  source: string;
  stdin?: string;
}

export interface RunnerLimits {
  sourceBytes: number;
  stdinBytes: number;
  outputBytes: number;
  timeoutMs: number;
  memoryBytes: number;
  cpuCores: number;
  processes: number;
  temporaryBytes: number;
}

export type ExecutionStatus =
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'output_limit'
  | 'resource_exceeded'
  | 'internal_error';

export interface ExecutionResult {
  runId: string;
  language: SupportedLanguage;
  runtimeVersion: string;
  status: ExecutionStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  outputTruncated: boolean;
  oomKilled: boolean;
  errorCode?: 'TIMEOUT' | 'CANCELLED' | 'OUTPUT_LIMIT' | 'OOM_KILLED' | 'RUNNER_INTERNAL_ERROR';
}

export class RunnerValidationError extends Error {
  readonly code = 'INVALID_EXECUTION_REQUEST';
}

export const DEFAULT_RUNNER_LIMITS: Readonly<RunnerLimits> = Object.freeze({
  sourceBytes: 64 * 1024,
  stdinBytes: 16 * 1024,
  outputBytes: 1024 * 1024,
  timeoutMs: 5_000,
  memoryBytes: 256 * 1024 * 1024,
  cpuCores: 1,
  processes: 32,
  temporaryBytes: 16 * 1024 * 1024,
});
