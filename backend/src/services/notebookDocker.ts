import { execFile, ExecFileException } from 'node:child_process';

export interface NotebookDockerOptions {
  signal?: AbortSignal;
  maxOutputBytes?: number;
  timeoutMs?: number;
  input?: Buffer;
}
export interface NotebookDockerResult { stdout: string; stderr: string; exitCode: number; signal: NodeJS.Signals | null }
export interface NotebookDockerClient { run(args: readonly string[], options?: NotebookDockerOptions): Promise<NotebookDockerResult> }

export class NotebookDockerAbortedError extends Error {}
export class NotebookDockerOutputLimitError extends Error {}

const buffer = (value: string | Buffer): Buffer => Buffer.isBuffer(value) ? value : Buffer.from(value);

export class ExecFileNotebookDockerClient implements NotebookDockerClient {
  constructor(private readonly binary = 'docker') {}

  run(args: readonly string[], options: NotebookDockerOptions = {}): Promise<NotebookDockerResult> {
    const maximum = options.maxOutputBytes ?? 256 * 1024;
    if (!Number.isSafeInteger(maximum) || maximum < 1) return Promise.reject(new Error('Docker output limit is invalid.'));
    return new Promise((resolve, reject) => {
      try {
        const child = execFile(this.binary, [...args], {
          encoding: null, windowsHide: true, maxBuffer: maximum,
          timeout: options.timeoutMs, killSignal: 'SIGKILL', signal: options.signal,
        }, (error: ExecFileException | null, stdoutValue: string | Buffer, stderrValue: string | Buffer) => {
          const stdout = buffer(stdoutValue); const stderr = buffer(stderrValue);
          if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || stdout.length + stderr.length > maximum) {
            reject(new NotebookDockerOutputLimitError('Docker command output exceeded its limit.')); return;
          }
          if (options.signal?.aborted || (error?.killed === true && options.timeoutMs !== undefined)) {
            reject(new NotebookDockerAbortedError('Docker command was aborted.')); return;
          }
          if (error && typeof error.code !== 'number') { reject(error); return; }
          resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'),
            exitCode: typeof error?.code === 'number' ? error.code : 0, signal: error?.signal ?? null });
        });
        child.stdin?.end(options.input);
      } catch (error) { reject(error); }
    });
  }
}
