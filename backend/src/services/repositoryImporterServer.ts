import { Stats } from 'fs';
import { lstat, chmod, unlink } from 'fs/promises';
import net, { Server, Socket } from 'net';
import path from 'path';
import { REPOSITORY_LIMITS, RepositoryArchiveError, RepositoryArchiveReport } from './repositoryArchiveAnalyzer';
import { createIsolatedRepositoryZipAnalyzer } from './repositoryArchiveIsolation';
import {
  REPOSITORY_ARCHIVE_METADATA_BYTES,
  REPOSITORY_ARCHIVE_REQUEST_MAGIC,
  REPOSITORY_IMPORTER_HEALTH_REQUEST,
  REPOSITORY_IMPORTER_HEALTH_RESPONSE,
  decodeRepositoryArchiveRequest,
  encodeRepositoryArchiveFailure,
  encodeRepositoryArchiveSuccess,
} from './repositoryArchiveIsolationProtocol';
import { validateRepositoryImporterSocketPath } from './repositoryImporterClient';

const MAXIMUM_REQUEST_BYTES = 12 + REPOSITORY_ARCHIVE_METADATA_BYTES + REPOSITORY_LIMITS.archiveBytes;

type AbortableRepositoryAnalyzer = (
  buffer: Buffer, originalName: string, mimeType: string, signal?: AbortSignal,
) => Promise<RepositoryArchiveReport>;

export interface RepositoryImporterServerOptions {
  socketPath: string;
  analyzer?: AbortableRepositoryAnalyzer;
  expectedUid?: number;
  expectedGid?: number;
  parentMode?: number;
  inputTimeoutMs?: number;
  maxActive?: number;
  maxConnections?: number;
  setSocketMode?: (socketPath: string, mode: number) => Promise<void>;
}

export interface RepositoryImporterServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

interface SocketIdentity { dev: number; ino: number; uid: number; gid: number; mode: number }

type FrameAssembly = { state: 'pending' | 'invalid' } | { state: 'complete'; input: Buffer };

class RepositoryImporterFrameAssembler {
  private input = Buffer.allocUnsafe(12);
  private inputBytes = 0;
  private expectedBytes: number | undefined;

  append(chunk: Buffer): FrameAssembly {
    if (chunk.length === 0) return { state: 'pending' };
    if (this.inputBytes + chunk.length > MAXIMUM_REQUEST_BYTES) return { state: 'invalid' };
    let sourceOffset = 0;
    while (sourceOffset < chunk.length) {
      const boundary = this.expectedBytes ?? (this.inputBytes < 4 ? 4 : 12);
      const take = Math.min(chunk.length - sourceOffset, boundary - this.inputBytes);
      chunk.copy(this.input, this.inputBytes, sourceOffset, sourceOffset + take);
      this.inputBytes += take; sourceOffset += take;
      if (this.inputBytes === 4 && this.expectedBytes === undefined) {
        const prefix = this.input.subarray(0, 4);
        if (prefix.equals(REPOSITORY_IMPORTER_HEALTH_REQUEST)) {
          return sourceOffset === chunk.length
            ? { state: 'complete', input: Buffer.from(REPOSITORY_IMPORTER_HEALTH_REQUEST) }
            : { state: 'invalid' };
        }
        if (!prefix.equals(REPOSITORY_ARCHIVE_REQUEST_MAGIC)) return { state: 'invalid' };
      }
      if (this.inputBytes === 12 && this.expectedBytes === undefined) {
        const metadataBytes = this.input.readUInt32BE(4); const archiveBytes = this.input.readUInt32BE(8);
        if (metadataBytes === 0 || metadataBytes > REPOSITORY_ARCHIVE_METADATA_BYTES || archiveBytes === 0
          || archiveBytes > REPOSITORY_LIMITS.archiveBytes) return { state: 'invalid' };
        this.expectedBytes = 12 + metadataBytes + archiveBytes;
        const frame = Buffer.allocUnsafe(this.expectedBytes);
        this.input.copy(frame, 0, 0, 12); this.input = frame;
      }
      if (this.expectedBytes !== undefined && this.inputBytes === this.expectedBytes) {
        return sourceOffset === chunk.length
          ? { state: 'complete', input: this.input }
          : { state: 'invalid' };
      }
    }
    return { state: 'pending' };
  }
}

function identity(stat: Stats): SocketIdentity {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
}

function sameIdentity(left: SocketIdentity, right: SocketIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.gid === right.gid && left.mode === right.mode;
}

async function probeExistingSocket(socketPath: string, timeoutMs = 250): Promise<'active' | 'stale'> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath }); let settled = false;
    const finish = (result?: 'active' | 'stale', error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(result as 'active' | 'stale');
    };
    const timer = setTimeout(() => finish(undefined, new Error('Repository importer socket probe was ambiguous.')), timeoutMs);
    socket.once('connect', () => finish('active'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') return finish('stale');
      finish(undefined, new Error('Repository importer socket probe was ambiguous.'));
    });
  });
}

async function prepareSocketPath(
  socketPath: string, expectedUid: number, expectedGid: number, parentMode?: number,
): Promise<void> {
  const parent = await lstat(path.dirname(socketPath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== expectedUid || parent.gid !== expectedGid
    || (parentMode !== undefined && (parent.mode & 0o777) !== parentMode)) {
    throw new Error('Repository importer socket directory is unsafe.');
  }
  let existing: Stats;
  try { existing = await lstat(socketPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Repository importer socket path is unsafe.');
  }
  if (!existing.isSocket() || existing.uid !== expectedUid || existing.gid !== expectedGid
    || (existing.mode & 0o777) !== 0o660) throw new Error('Repository importer socket path is unsafe.');
  const before = identity(existing);
  if (await probeExistingSocket(socketPath) === 'active') throw new Error('Repository importer socket is already active.');
  let current: Stats;
  try { current = await lstat(socketPath); }
  catch { throw new Error('Repository importer socket changed during startup.'); }
  if (!current.isSocket() || !sameIdentity(before, identity(current))) {
    throw new Error('Repository importer socket changed during startup.');
  }
  await unlink(socketPath);
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError); server.once('listening', onListening); server.listen(socketPath);
  });
}

function closeListener(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function startRepositoryImporterServer(options: RepositoryImporterServerOptions): Promise<RepositoryImporterServer> {
  const socketPath = validateRepositoryImporterSocketPath(options.socketPath);
  const expectedUid = options.expectedUid ?? process.getuid?.() ?? -1;
  const expectedGid = options.expectedGid ?? process.getgid?.() ?? -1;
  const inputTimeoutMs = options.inputTimeoutMs ?? 2_000;
  const maxActive = options.maxActive ?? 2;
  const maxConnections = options.maxConnections ?? 4;
  if (!Number.isSafeInteger(inputTimeoutMs) || inputTimeoutMs < 10 || inputTimeoutMs > 10_000
    || !Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 2
    || !Number.isSafeInteger(maxConnections) || maxConnections < maxActive || maxConnections > 4) {
    throw new Error('Repository importer server limits are invalid.');
  }
  await prepareSocketPath(socketPath, expectedUid, expectedGid, options.parentMode);
  const analyzer = options.analyzer ?? createIsolatedRepositoryZipAnalyzer();
  const sockets = new Set<Socket>(); const active = new Set<AbortController>(); let closing = false;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (closing) { socket.destroy(); return; }
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => undefined);
    const assembler = new RepositoryImporterFrameAssembler(); let responded = false; let handling = false;
    const inputTimer = setTimeout(() => socket.destroy(), inputTimeoutMs);
    const handleRequest = async (input: Buffer) => {
      handling = true; clearTimeout(inputTimer);
      if (input.equals(REPOSITORY_IMPORTER_HEALTH_REQUEST)) {
        responded = true; socket.end(REPOSITORY_IMPORTER_HEALTH_RESPONSE); return;
      }
      if (active.size >= maxActive) { responded = true; socket.end(encodeRepositoryArchiveFailure('BUSY')); return; }
      let request;
      try { request = decodeRepositoryArchiveRequest(input); }
      catch { responded = true; socket.end(encodeRepositoryArchiveFailure('INTERNAL')); return; }
      const controller = new AbortController(); active.add(controller);
      const abort = () => { if (!responded) controller.abort(); };
      socket.once('close', abort);
      try {
        const report = await analyzer(request.buffer, request.originalName, request.mimeType, controller.signal);
        if (!socket.destroyed) { responded = true; socket.end(encodeRepositoryArchiveSuccess(report)); }
      } catch (error) {
        if (!socket.destroyed) {
          responded = true;
          socket.end(encodeRepositoryArchiveFailure(error instanceof RepositoryArchiveError ? error.code : 'INTERNAL'));
        }
      } finally {
        active.delete(controller); socket.off('close', abort);
      }
    };
    socket.on('data', (chunk: Buffer) => {
      if (handling) { socket.destroy(); return; }
      const assembled = assembler.append(chunk);
      if (assembled.state === 'invalid') { clearTimeout(inputTimer); socket.destroy(); return; }
      if (assembled.state === 'complete') void handleRequest(assembled.input);
    });
    socket.once('end', () => {
      if (!responded) socket.destroy();
    });
    socket.once('close', () => {
      clearTimeout(inputTimer);
      if (!responded && !handling) {
        socket.destroy();
      }
    });
  });
  server.maxConnections = maxConnections;
  await listen(server, socketPath);
  let createdIdentity: SocketIdentity | undefined;
  let bound: Stats;
  try {
    const created = await lstat(socketPath);
    if (!created.isSocket() || created.uid !== expectedUid || created.gid !== expectedGid) {
      throw new Error('Repository importer socket attributes are unsafe.');
    }
    createdIdentity = identity(created);
    await (options.setSocketMode ?? chmod)(socketPath, 0o660);
    bound = await lstat(socketPath);
    if (!bound.isSocket() || bound.dev !== created.dev || bound.ino !== created.ino
      || bound.uid !== expectedUid || bound.gid !== expectedGid || (bound.mode & 0o777) !== 0o660) {
      throw new Error('Repository importer socket attributes are unsafe.');
    }
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await closeListener(server);
    if (createdIdentity) {
      try {
        const current = await lstat(socketPath);
        if (current.isSocket() && current.dev === createdIdentity.dev && current.ino === createdIdentity.ino
          && current.uid === createdIdentity.uid && current.gid === createdIdentity.gid) await unlink(socketPath);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error('Repository importer socket cleanup failed.');
        }
      }
    }
    throw error;
  }
  const boundIdentity = identity(bound);
  return {
    socketPath,
    async close() {
      if (closing) return; closing = true;
      for (const controller of active) controller.abort();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 2_000);
        server.close(() => { clearTimeout(timer); resolve(); });
      });
      let current: Stats;
      try { current = await lstat(socketPath); } catch { return; }
      if (current.isSocket() && sameIdentity(boundIdentity, identity(current))) await unlink(socketPath);
    },
  };
}
