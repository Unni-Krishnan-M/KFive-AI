import {
  DockerCommandAbortedError,
  DockerCommandAdapter,
  DockerCommandResult,
  DockerOutputLimitError,
} from './dockerCli';
import { getRuntime, RuntimeDefinition, sourceArguments } from './runtimeRegistry';
import {
  DEFAULT_RUNNER_LIMITS,
  ExecutionRequest,
  ExecutionResult,
  RunnerLimits,
  RunnerValidationError,
  SupportedLanguage,
} from './types';

const REQUEST_KEYS = new Set(['runId', 'language', 'source', 'stdin']);
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface DockerState {
  ExitCode?: number;
  OOMKilled?: boolean;
  Error?: string;
}

function validateLimits(input: RunnerLimits): RunnerLimits {
  const integers: Array<keyof Omit<RunnerLimits, 'cpuCores'>> = [
    'sourceBytes', 'stdinBytes', 'outputBytes', 'timeoutMs',
    'memoryBytes', 'processes', 'temporaryBytes',
  ];
  for (const key of integers) {
    if (!Number.isSafeInteger(input[key]) || input[key] <= 0) {
      throw new RunnerValidationError(`Runner limit '${key}' must be a positive safe integer.`);
    }
  }
  if (!Number.isFinite(input.cpuCores) || input.cpuCores < 0.1 || input.cpuCores > 2) {
    throw new RunnerValidationError('Runner CPU limit must be between 0.1 and 2 cores.');
  }
  if (input.sourceBytes > 256 * 1024) throw new RunnerValidationError('Source limit exceeds the safety maximum.');
  if (input.stdinBytes > 64 * 1024) throw new RunnerValidationError('stdin limit exceeds the safety maximum.');
  if (input.outputBytes > 4 * 1024 * 1024) throw new RunnerValidationError('Output limit exceeds the safety maximum.');
  if (input.timeoutMs > 30_000) throw new RunnerValidationError('Timeout exceeds the safety maximum.');
  if (input.memoryBytes < 32 * 1024 * 1024 || input.memoryBytes > 1024 * 1024 * 1024) {
    throw new RunnerValidationError('Memory limit is outside the safe range.');
  }
  if (input.processes < 8 || input.processes > 128) {
    throw new RunnerValidationError('Process limit is outside the safe range.');
  }
  if (input.temporaryBytes > 64 * 1024 * 1024) {
    throw new RunnerValidationError('Temporary storage limit exceeds the safety maximum.');
  }
  return Object.freeze({ ...input });
}

function validateRequest(value: unknown, limits: RunnerLimits): ExecutionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunnerValidationError('Execution request must be an object.');
  }
  const input = value as Record<string, unknown>;
  const unknownKeys = Object.keys(input).filter((key) => !REQUEST_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new RunnerValidationError(`Unknown execution fields: ${unknownKeys.join(', ')}.`);
  }
  if (typeof input.runId !== 'string' || !RUN_ID_PATTERN.test(input.runId)) {
    throw new RunnerValidationError('runId must contain only 1-64 letters, numbers, underscores, or hyphens.');
  }
  if (typeof input.language !== 'string') throw new RunnerValidationError('language is required.');
  getRuntime(input.language);
  if (typeof input.source !== 'string' || input.source.includes('\0')) {
    throw new RunnerValidationError('source must be text without NUL bytes.');
  }
  const sourceBytes = Buffer.byteLength(input.source, 'utf8');
  if (sourceBytes < 1 || sourceBytes > limits.sourceBytes) {
    throw new RunnerValidationError('Source must contain at least one byte and stay within the configured byte limit.');
  }
  if (input.stdin !== undefined && typeof input.stdin !== 'string') {
    throw new RunnerValidationError('stdin must be text.');
  }
  const stdin = input.stdin as string | undefined;
  if (stdin !== undefined && (stdin.includes('\0') || Buffer.byteLength(stdin, 'utf8') > limits.stdinBytes)) {
    throw new RunnerValidationError('stdin exceeds the configured byte limit or contains NUL bytes.');
  }
  return {
    runId: input.runId,
    language: input.language as SupportedLanguage,
    source: input.source,
    stdin,
  };
}

function requireSuccess(result: DockerCommandResult, operation: string): DockerCommandResult {
  if (result.exitCode !== 0) throw new Error(`Docker ${operation} failed.`);
  return result;
}

function createArguments(runtime: RuntimeDefinition, runId: string, limits: RunnerLimits, source: string): string[] {
  const memory = String(limits.memoryBytes);
  return [
    'create',
    '--interactive',
    '--pull', 'never',
    '--name', `kfive-run-${runId}`,
    '--label', 'com.kfive.code-run=true',
    '--label', `com.kfive.run-id=${runId}`,
    '--user', '65532:65532',
    '--read-only',
    '--network', 'none',
    '--ipc', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--pids-limit', String(limits.processes),
    '--cpus', String(limits.cpuCores),
    '--memory', memory,
    '--memory-swap', memory,
    '--ulimit', 'nofile=64:64',
    '--ulimit', `nproc=${limits.processes}:${limits.processes}`,
    '--ulimit', `fsize=${limits.outputBytes}:${limits.outputBytes}`,
    '--ulimit', 'core=0:0',
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${limits.temporaryBytes}`,
    '--workdir', '/workspace',
    '--hostname', 'kfive-run',
    '--env', 'HOME=/tmp',
    '--env', 'LANG=C.UTF-8',
    '--env', `PATH=${runtime.path}`,
    '--log-driver', 'none',
    '--stop-timeout', '1',
    '--init',
    runtime.image,
    ...runtime.command,
    ...sourceArguments(source),
  ];
}

function emptyResult(request: ExecutionRequest, runtime: RuntimeDefinition, startedAt: number): ExecutionResult {
  return {
    runId: request.runId,
    language: request.language,
    runtimeVersion: runtime.version,
    status: 'internal_error',
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    durationMs: Math.max(0, Date.now() - startedAt),
    outputTruncated: false,
    oomKilled: false,
  };
}

export class DockerCodeExecutor {
  readonly limits: RunnerLimits;

  constructor(
    private readonly docker: DockerCommandAdapter,
    limits: RunnerLimits = DEFAULT_RUNNER_LIMITS
  ) {
    this.limits = validateLimits(limits);
  }

  async execute(value: unknown, cancellation?: AbortSignal): Promise<ExecutionResult> {
    const request = validateRequest(value, this.limits);
    const runtime = getRuntime(request.language);
    const startedAt = Date.now();
    const result = emptyResult(request, runtime, startedAt);
    if (cancellation?.aborted) {
      return { ...result, status: 'cancelled', errorCode: 'CANCELLED' };
    }

    let containerId: string | undefined;
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const cancel = (): void => {
      cancelled = true;
      controller.abort();
    };
    cancellation?.addEventListener('abort', cancel, { once: true });
    if (cancellation?.aborted) cancel();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.limits.timeoutMs);
    timer.unref();

    try {
      const created = requireSuccess(await this.docker.run(
        createArguments(runtime, request.runId, this.limits, request.source),
        { signal: controller.signal, maxOutputBytes: 64 * 1024 }
      ), 'create');
      containerId = created.stdout.trim();
      if (!/^[a-f0-9]{12,64}$/i.test(containerId)) throw new Error('Docker returned an invalid container identifier.');

      const executed = await this.docker.run(
        ['start', '--attach', '--interactive', containerId],
        {
          stdin: request.stdin ?? '',
          signal: controller.signal,
          maxOutputBytes: this.limits.outputBytes,
        }
      );
      result.stdout = executed.stdout;
      result.stderr = executed.stderr;
      result.signal = executed.signal;

      const inspected = requireSuccess(await this.docker.run(
        ['inspect', '--format', '{{json .State}}', containerId],
        { maxOutputBytes: 64 * 1024, timeoutMs: 5_000 }
      ), 'inspect');
      const state = JSON.parse(inspected.stdout) as DockerState;
      result.exitCode = Number.isInteger(state.ExitCode) ? state.ExitCode as number : executed.exitCode;
      result.oomKilled = state.OOMKilled === true;
      if (result.oomKilled) {
        result.status = 'resource_exceeded';
        result.errorCode = 'OOM_KILLED';
      } else {
        result.status = result.exitCode === 0 ? 'succeeded' : 'failed';
      }
    } catch (error) {
      if (error instanceof DockerOutputLimitError) {
        result.status = 'output_limit';
        result.errorCode = 'OUTPUT_LIMIT';
        result.outputTruncated = true;
        result.stdout = error.stdout;
        result.stderr = error.stderr;
      } else if (error instanceof DockerCommandAbortedError && (timedOut || cancelled)) {
        result.status = cancelled ? 'cancelled' : 'timed_out';
        result.errorCode = cancelled ? 'CANCELLED' : 'TIMEOUT';
        result.stdout = error.stdout;
        result.stderr = error.stderr;
      } else {
        result.status = 'internal_error';
        result.errorCode = 'RUNNER_INTERNAL_ERROR';
      }
    } finally {
      clearTimeout(timer);
      cancellation?.removeEventListener('abort', cancel);
      if (containerId) {
        await this.docker.run(['kill', containerId], { maxOutputBytes: 64 * 1024, timeoutMs: 5_000 }).catch(() => undefined);
        await this.docker.run(
          ['rm', '--force', '--volumes', containerId],
          { maxOutputBytes: 64 * 1024, timeoutMs: 5_000 }
        ).catch(() => undefined);
      }
      result.durationMs = Math.max(0, Date.now() - startedAt);
    }

    return result;
  }
}

export { createArguments, validateLimits, validateRequest };
