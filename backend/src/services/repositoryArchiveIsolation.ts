import { spawn } from 'child_process';
import path from 'path';
import {
  REPOSITORY_ARCHIVE_RESPONSE_BYTES,
  RepositoryArchiveProtocolError,
  decodeRepositoryArchiveResponse,
  encodeRepositoryArchiveRequest,
} from './repositoryArchiveIsolationProtocol';
import { REPOSITORY_LIMITS, RepositoryArchiveError, RepositoryArchiveReport } from './repositoryArchiveAnalyzer';

export interface RepositoryArchiveIsolationOptions {
  args?: string[];
  executable?: string;
  onSpawn?: (pid: number) => void;
  timeoutMs?: number;
}

export function repositoryArchiveWorkerArgs(): string[] {
  const memory = ['--max-old-space-size=96', '--max-semi-space-size=8'];
  if (__filename.endsWith('.ts')) {
    return [...memory, '-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', path.resolve(__dirname, '../repositoryArchiveWorkerMain.ts')];
  }
  return [...memory, path.resolve(__dirname, '../repositoryArchiveWorkerMain.js')];
}

export class RepositoryArchiveIsolationError extends Error {
  constructor(
    readonly reason: 'spawn' | 'stdin' | 'output' | 'exit' | 'json' | 'envelope' | 'report' | 'worker' | 'aborted',
    readonly diagnostic?: { outputBytes: number; chunks: number; startsObject: boolean; endsObject: boolean },
  ) {
    super('Repository ZIP isolation failed.');
    this.name = 'RepositoryArchiveIsolationError';
  }
}
function genericIsolationError(
  reason: RepositoryArchiveIsolationError['reason'],
  diagnostic?: RepositoryArchiveIsolationError['diagnostic'],
): RepositoryArchiveIsolationError {
  return new RepositoryArchiveIsolationError(reason, diagnostic);
}

export function createIsolatedRepositoryZipAnalyzer(options: RepositoryArchiveIsolationOptions = {}) {
  return async (buffer: Buffer, originalName: string, mimeType: string, signal?: AbortSignal): Promise<RepositoryArchiveReport> => {
    const request = { buffer, originalName, mimeType };
    const frame = encodeRepositoryArchiveRequest(request);
    return new Promise<RepositoryArchiveReport>((resolve, reject) => {
      const child = spawn(options.executable ?? process.execPath, options.args ?? repositoryArchiveWorkerArgs(), {
        cwd: path.resolve(__dirname, '../..'), env: { NODE_ENV: 'production' }, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = []; let outputBytes = 0; let settled = false; let timedOut = false; let forcedError: Error | undefined;
      const finish = (error?: Error, report?: RepositoryArchiveReport) => {
        if (settled) return; settled = true; clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(report as RepositoryArchiveReport);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs ?? REPOSITORY_LIMITS.timeoutMs + 2_000);
      child.stderr.resume();
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > REPOSITORY_ARCHIVE_RESPONSE_BYTES) {
          forcedError = genericIsolationError('output'); child.kill('SIGKILL'); return;
        }
        chunks.push(chunk);
      });
      child.once('error', () => finish(genericIsolationError('spawn')));
      child.stdin.once('error', () => { forcedError = genericIsolationError('stdin'); child.kill('SIGKILL'); });
      child.once('close', (code, signal) => {
        if (timedOut) return finish(new RepositoryArchiveError('Repository analysis timed out.', 'REPOSITORY_ANALYSIS_TIMEOUT', 408));
        if (forcedError || code !== 0 || signal) return finish(forcedError ?? genericIsolationError('exit'));
        const output = Buffer.concat(chunks, outputBytes).toString('utf8');
        try { return finish(undefined, decodeRepositoryArchiveResponse(Buffer.from(output), request)); }
        catch (error) {
          if (error instanceof RepositoryArchiveError) return finish(error);
          if (error instanceof RepositoryArchiveProtocolError) {
            const reason = error.reason === 'busy' ? 'envelope' : error.reason;
            return finish(genericIsolationError(reason, reason === 'json' ? {
              outputBytes, chunks: chunks.length, startsObject: output.startsWith('{'), endsObject: output.endsWith('}'),
            } : undefined));
          }
          return finish(genericIsolationError('envelope'));
        }
      });
      const abort = () => { forcedError = genericIsolationError('aborted'); child.kill('SIGKILL'); };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      if (child.pid !== undefined && options.onSpawn) {
        try { options.onSpawn(child.pid); } catch {
          forcedError = genericIsolationError('spawn');
          child.kill('SIGKILL');
          return;
        }
      }
      child.stdin.end(frame);
    });
  };
}

export const analyzeRepositoryZipIsolated = createIsolatedRepositoryZipAnalyzer();
