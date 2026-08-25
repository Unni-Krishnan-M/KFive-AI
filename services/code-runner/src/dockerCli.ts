import { execFile, ExecFileException } from 'node:child_process';

export interface DockerCommandOptions {
  stdin?: string;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
}

export interface DockerCommandAdapter {
  run(args: readonly string[], options?: DockerCommandOptions): Promise<DockerCommandResult>;
}

export class DockerCommandError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(message);
  }
}

export class DockerCommandAbortedError extends DockerCommandError {}
export class DockerOutputLimitError extends DockerCommandError {}

function asBuffer(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export class ExecFileDockerAdapter implements DockerCommandAdapter {
  constructor(private readonly dockerBinary = 'docker') {}

  run(args: readonly string[], options: DockerCommandOptions = {}): Promise<DockerCommandResult> {
    const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
      return Promise.reject(new Error('maxOutputBytes must be a positive safe integer.'));
    }

    return new Promise((resolve, reject) => {
      let child;
      const callback = (error: ExecFileException | null, stdoutValue: string | Buffer, stderrValue: string | Buffer): void => {
        const rawStdout = asBuffer(stdoutValue);
        const rawStderr = asBuffer(stderrValue);
        const stdoutBytes = Math.min(rawStdout.length, maxOutputBytes);
        const stderrBytes = Math.min(rawStderr.length, maxOutputBytes - stdoutBytes);
        const out = rawStdout.subarray(0, stdoutBytes).toString('utf8');
        const err = rawStderr.subarray(0, stderrBytes).toString('utf8');
        const maxBufferExceeded = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        if (maxBufferExceeded || rawStdout.length + rawStderr.length > maxOutputBytes) {
          reject(new DockerOutputLimitError('Docker command output limit exceeded.', out, err));
          return;
        }
        if (options.signal?.aborted || (error?.killed === true && options.timeoutMs !== undefined)) {
          reject(new DockerCommandAbortedError('Docker command was aborted.', out, err));
          return;
        }
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolve({
          stdout: out,
          stderr: err,
          exitCode: typeof error?.code === 'number' ? error.code : 0,
          signal: error?.signal ?? null,
        });
      };

      try {
        child = execFile(this.dockerBinary, [...args], {
          encoding: null,
          windowsHide: true,
          maxBuffer: maxOutputBytes,
          timeout: options.timeoutMs,
          killSignal: 'SIGKILL',
          signal: options.signal,
        }, callback);
      } catch (error) {
        reject(error);
        return;
      }

      if (options.stdin !== undefined) child.stdin?.end(options.stdin);
      else child.stdin?.end();
    });
  }
}
