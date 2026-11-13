import net from 'net';
import path from 'path';
import { REPOSITORY_LIMITS, RepositoryArchiveError, RepositoryArchiveReport } from './repositoryArchiveAnalyzer';
import {
  REPOSITORY_ARCHIVE_RESPONSE_BYTES,
  REPOSITORY_IMPORTER_HEALTH_REQUEST,
  REPOSITORY_IMPORTER_HEALTH_RESPONSE,
  REPOSITORY_IMPORTER_SOCKET_PATH,
  RepositoryArchiveProtocolError,
  decodeRepositoryArchiveResponse,
  encodeRepositoryArchiveRequest,
} from './repositoryArchiveIsolationProtocol';

export { REPOSITORY_IMPORTER_SOCKET_PATH } from './repositoryArchiveIsolationProtocol';

export interface RepositoryImporterAnalyzer {
  (buffer: Buffer, originalName: string, mimeType: string): Promise<RepositoryArchiveReport>;
  isAvailable: () => Promise<boolean>;
}

export interface RepositoryImporterClientOptions {
  socketPath: string;
  connectTimeoutMs?: number;
  timeoutMs?: number;
}

export class RepositoryImporterUnavailableError extends Error {
  constructor() { super('Repository importer is unavailable.'); this.name = 'RepositoryImporterUnavailableError'; }
}

export class RepositoryImporterBusyError extends Error {
  constructor() { super('Repository importer is busy.'); this.name = 'RepositoryImporterBusyError'; }
}

export class RepositoryImporterProtocolError extends Error {
  constructor() { super('Repository importer response is invalid.'); this.name = 'RepositoryImporterProtocolError'; }
}

export function validateRepositoryImporterSocketPath(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value
    || Buffer.byteLength(value, 'utf8') > 100 || [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0; return code < 32 || code === 127;
    }) || value.slice(1).split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Repository importer socket path is invalid.');
  }
  return value;
}

function healthProbe(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    const chunks: Buffer[] = []; let total = 0; let settled = false;
    const finish = (available: boolean) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(available);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => socket.write(REPOSITORY_IMPORTER_HEALTH_REQUEST));
    socket.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > REPOSITORY_IMPORTER_HEALTH_RESPONSE.length) return finish(false);
      chunks.push(chunk);
    });
    socket.once('end', () => finish(Buffer.concat(chunks, total).equals(REPOSITORY_IMPORTER_HEALTH_RESPONSE)));
    socket.once('error', () => finish(false));
  });
}

export function createRepositoryImporterAnalyzer(options: RepositoryImporterClientOptions): RepositoryImporterAnalyzer {
  const socketPath = validateRepositoryImporterSocketPath(options.socketPath);
  const connectTimeoutMs = options.connectTimeoutMs ?? 500;
  const timeoutMs = options.timeoutMs ?? REPOSITORY_LIMITS.timeoutMs + 3_000;
  if (!Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 10 || connectTimeoutMs > 5_000
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60_000) {
    throw new Error('Repository importer client timeout is invalid.');
  }

  const analyze = (async (buffer: Buffer, originalName: string, mimeType: string): Promise<RepositoryArchiveReport> => {
    const request = { buffer, originalName, mimeType };
    const frame = encodeRepositoryArchiveRequest(request);
    return new Promise<RepositoryArchiveReport>((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath });
      const chunks: Buffer[] = []; let outputBytes = 0; let settled = false; let connected = false;
      const finish = (error?: Error, report?: RepositoryArchiveReport) => {
        if (settled) return; settled = true; clearTimeout(connectTimer); clearTimeout(deadline); socket.destroy();
        error ? reject(error) : resolve(report as RepositoryArchiveReport);
      };
      const connectTimer = setTimeout(() => finish(new RepositoryImporterUnavailableError()), connectTimeoutMs);
      const deadline = setTimeout(() => finish(new RepositoryArchiveError(
        'Repository analysis timed out.', 'REPOSITORY_ANALYSIS_TIMEOUT', 408,
      )), timeoutMs);
      socket.once('connect', () => { connected = true; clearTimeout(connectTimer); socket.write(frame); });
      socket.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > REPOSITORY_ARCHIVE_RESPONSE_BYTES) return finish(new RepositoryImporterProtocolError());
        chunks.push(chunk);
      });
      socket.once('end', () => {
        try { finish(undefined, decodeRepositoryArchiveResponse(Buffer.concat(chunks, outputBytes), request)); }
        catch (error) {
          if (error instanceof RepositoryArchiveError) return finish(error);
          if (error instanceof RepositoryArchiveProtocolError && error.reason === 'busy') return finish(new RepositoryImporterBusyError());
          return finish(new RepositoryImporterProtocolError());
        }
      });
      socket.once('error', () => finish(new RepositoryImporterUnavailableError()));
      socket.once('close', (hadError) => {
        if (!settled && !hadError && connected) finish(new RepositoryImporterUnavailableError());
      });
    });
  }) as RepositoryImporterAnalyzer;
  analyze.isAvailable = () => healthProbe(socketPath, connectTimeoutMs);
  return analyze;
}

export function repositoryImporterAnalyzerFromEnvironment(source: NodeJS.ProcessEnv): RepositoryImporterAnalyzer | undefined {
  const mode = source.REPOSITORY_IMPORTER_MODE || 'process';
  if (mode === 'process') return undefined;
  if (mode !== 'socket' || source.REPOSITORY_IMPORTER_SOCKET_PATH !== REPOSITORY_IMPORTER_SOCKET_PATH) {
    throw new Error('Repository importer socket mode requires the fixed socket path.');
  }
  return createRepositoryImporterAnalyzer({ socketPath: REPOSITORY_IMPORTER_SOCKET_PATH });
}
