import { lstat, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import net from 'net';
import { deflateRawSync } from 'zlib';
import {
  REPOSITORY_IMPORTER_SOCKET_PATH,
  createRepositoryImporterAnalyzer,
  repositoryImporterAnalyzerFromEnvironment,
  RepositoryImporterBusyError,
  RepositoryImporterProtocolError,
  RepositoryImporterUnavailableError,
} from './repositoryImporterClient';
import { startRepositoryImporterServer } from './repositoryImporterServer';
import { analyzeRepositoryZip, RepositoryArchiveReport } from './repositoryArchiveAnalyzer';

function crc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(name = 'package.json', content = '{"name":"socket-test"}', flags = 0): Buffer {
  const nameBytes = Buffer.from(name); const source = Buffer.from(content); const compressed = deflateRawSync(source);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(source), 14); local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(source.length, 22); local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc32(source), 16);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(source.length, 24); central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12); end.writeUInt32LE(local.length + nameBytes.length + compressed.length, 16);
  return Buffer.concat([local, nameBytes, compressed, central, nameBytes, end]);
}

describe('repository importer Unix-socket boundary', () => {
  let directory: string;
  let socketPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'kfive-importer-'));
    socketPath = path.join(directory, 'importer.sock');
  });

  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('selects socket mode explicitly and never silently falls back', () => {
    expect(repositoryImporterAnalyzerFromEnvironment({ REPOSITORY_IMPORTER_MODE: 'process' })).toBeUndefined();
    expect(repositoryImporterAnalyzerFromEnvironment({ REPOSITORY_IMPORTER_MODE: 'socket',
      REPOSITORY_IMPORTER_SOCKET_PATH })).toEqual(expect.any(Function));
    expect(() => repositoryImporterAnalyzerFromEnvironment({ REPOSITORY_IMPORTER_MODE: 'socket' }))
      .toThrow('Repository importer socket mode requires the fixed socket path.');
  });

  it('analyzes through the real daemon and one-shot parser child', async () => {
    const importer = await startRepositoryImporterServer({ socketPath });
    try {
      const analyze = createRepositoryImporterAnalyzer({ socketPath });
      const zip = makeZip();
      await expect(analyze(zip, 'repository.zip', 'application/zip')).resolves.toMatchObject({
        source: { originalName: 'repository.zip', compressedBytes: zip.length },
        summary: { fileCount: 1 },
        tree: [{ path: 'package.json', type: 'file' }],
      });
      await expect(analyze(makeZip('secret.txt', 'secret', 1), 'encrypted.zip', 'application/zip')).rejects.toMatchObject({
        code: 'REPOSITORY_ARCHIVE_ENCRYPTED', statusCode: 400,
      });
      await expect(analyze.isAvailable?.()).resolves.toBe(true);
    } finally {
      await importer.close();
    }
  });

  it('fails closed when the importer is absent without falling back', async () => {
    const analyze = createRepositoryImporterAnalyzer({ socketPath, connectTimeoutMs: 50 });
    await expect(analyze(makeZip(), 'repository.zip', 'application/zip')).rejects.toBeInstanceOf(RepositoryImporterUnavailableError);
    await expect(analyze.isAvailable?.()).resolves.toBe(false);
  });

  it('refuses an ordinary file and a second daemon on an active socket', async () => {
    await writeFile(socketPath, 'foreign');
    await expect(startRepositoryImporterServer({ socketPath })).rejects.toThrow('Repository importer socket path is unsafe.');
    await rm(socketPath);
    const first = await startRepositoryImporterServer({ socketPath });
    try {
      await expect(startRepositoryImporterServer({ socketPath })).rejects.toThrow('Repository importer socket is already active.');
    } finally {
      await first.close();
    }
  });

  it('closes and removes its exact socket when post-bind hardening fails', async () => {
    await expect(startRepositoryImporterServer({
      socketPath,
      setSocketMode: async () => { throw new Error('injected chmod failure'); },
    })).rejects.toThrow('injected chmod failure');
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const recovered = await startRepositoryImporterServer({ socketPath });
    await recovered.close();
  });

  it('bounds daemon concurrency and returns a typed busy result for the third request', async () => {
    const zip = makeZip();
    const report = await analyzeRepositoryZip(zip, 'repository.zip', 'application/zip');
    let release!: () => void;
    const blocked = new Promise<RepositoryArchiveReport>((resolve) => { release = () => resolve(report); });
    let starts = 0; let twoStarted!: () => void;
    const started = new Promise<void>((resolve) => { twoStarted = resolve; });
    const importer = await startRepositoryImporterServer({ socketPath, analyzer: async () => {
      starts += 1; if (starts === 2) twoStarted(); return blocked;
    } });
    try {
      const analyze = createRepositoryImporterAnalyzer({ socketPath });
      const first = analyze(zip, 'repository.zip', 'application/zip');
      const second = analyze(zip, 'repository.zip', 'application/zip');
      await started;
      await expect(analyze(zip, 'repository.zip', 'application/zip')).rejects.toBeInstanceOf(RepositoryImporterBusyError);
      release(); await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    } finally { await importer.close(); }
  });

  it('aborts importer work when the backend deadline disconnects and serves the next request', async () => {
    const zip = makeZip(); let aborted!: () => void; let calls = 0;
    const observedAbort = new Promise<void>((resolve) => { aborted = resolve; });
    const importer = await startRepositoryImporterServer({ socketPath, analyzer: async (buffer, name, type, signal) => {
      calls += 1;
      if (calls > 1) return analyzeRepositoryZip(buffer, name, type);
      return new Promise<RepositoryArchiveReport>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { aborted(); reject(new Error('aborted')); }, { once: true });
      });
    } });
    try {
      const analyze = createRepositoryImporterAnalyzer({ socketPath, timeoutMs: 50 });
      await expect(analyze(zip, 'repository.zip', 'application/zip')).rejects.toMatchObject({
        code: 'REPOSITORY_ANALYSIS_TIMEOUT', statusCode: 408,
      });
      await observedAbort;
      const recovered = createRepositoryImporterAnalyzer({ socketPath });
      await expect(recovered(zip, 'repository.zip', 'application/zip')).resolves.toMatchObject({ summary: { fileCount: 1 } });
    } finally { await importer.close(); }
  });

  it('rejects malformed, untrusted, and oversized daemon responses', async () => {
    const responses = [
      Buffer.from('{broken'),
      Buffer.from(JSON.stringify({ v: 1, ok: false, code: 'INVALID_REPOSITORY_ARCHIVE', message: 'raw secret' })),
      Buffer.alloc(4 * 1024 * 1024 + 1, 0x78),
    ];
    for (const [index, response] of responses.entries()) {
      const fakePath = path.join(directory, `fake-${index}.sock`);
      const server = net.createServer((socket) => {
        socket.on('error', () => undefined);
        socket.once('data', () => socket.end(response));
      });
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(fakePath, resolve); });
      try {
        const analyze = createRepositoryImporterAnalyzer({ socketPath: fakePath });
        await expect(analyze(makeZip(), 'repository.zip', 'application/zip')).rejects.toBeInstanceOf(RepositoryImporterProtocolError);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
});
