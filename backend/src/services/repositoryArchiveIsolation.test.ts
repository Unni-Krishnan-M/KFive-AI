import { deflateRawSync } from 'zlib';
import { createIsolatedRepositoryZipAnalyzer } from './repositoryArchiveIsolation';
import { decodeRepositoryArchiveRequest, encodeRepositoryArchiveRequest } from './repositoryArchiveIsolationProtocol';

function crc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(name = 'readme.md', content = 'safe', flags = 0): Buffer {
  const nameBytes = Buffer.from(name);
  const source = Buffer.from(content);
  const compressed = deflateRawSync(source);
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

describe('isolated repository ZIP analyzer', () => {
  it('returns a provenance-checked report through the real child process', async () => {
    const zip = makeZip();
    const analyze = createIsolatedRepositoryZipAnalyzer();
    await expect(analyze(zip, 'repo.zip', 'application/zip')).resolves.toMatchObject({
      source: { originalName: 'repo.zip', mimeType: 'application/zip', compressedBytes: zip.length },
      summary: { fileCount: 1 }, tree: [{ path: 'readme.md', type: 'file' }],
    });
  });

  it('reconstructs allowlisted archive errors without trusting child text', async () => {
    const analyze = createIsolatedRepositoryZipAnalyzer();
    await expect(analyze(makeZip('secret.txt', 'safe', 1), 'repo.zip', 'application/zip')).rejects.toMatchObject({
      code: 'REPOSITORY_ARCHIVE_ENCRYPTED', statusCode: 400,
    });
  });

  it('does not pass arbitrary parent environment variables to a child', async () => {
    process.env.KFIVE_IMPORTER_TEST_SECRET = 'must-not-cross';
    const script = `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({v:1,ok:false,code:process.env.KFIVE_IMPORTER_TEST_SECRET?'INTERNAL':'INVALID_REPOSITORY_ARCHIVE'})))`;
    const analyze = createIsolatedRepositoryZipAnalyzer({ args: ['-e', script] });
    try {
      await expect(analyze(makeZip(), 'repo.zip', 'application/zip')).rejects.toMatchObject({ code: 'INVALID_REPOSITORY_ARCHIVE' });
    } finally {
      delete process.env.KFIVE_IMPORTER_TEST_SECRET;
    }
  });

  it('fails safely on a child crash without exposing diagnostics', async () => {
    const analyze = createIsolatedRepositoryZipAnalyzer({ args: ['-e', "process.stderr.write('raw secret');process.exit(7)"] });
    await expect(analyze(makeZip(), 'repo.zip', 'application/zip')).rejects.toThrow('Repository ZIP isolation failed.');
  });

  it('rejects malformed, untrusted, and oversized worker output', async () => {
    const cases = [
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('{broken'))",
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({v:1,ok:true,report:{}})))",
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({v:1,ok:false,code:'INVALID_REPOSITORY_ARCHIVE',message:'raw secret'})))",
      `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('x'.repeat(${4 * 1024 * 1024 + 1})))`,
    ];
    for (const script of cases) {
      const analyze = createIsolatedRepositoryZipAnalyzer({ args: ['-e', script] });
      await expect(analyze(makeZip(), 'repo.zip', 'application/zip')).rejects.toThrow('Repository ZIP isolation failed.');
    }
  });

  it('fails safely when the fixed executable cannot be started', async () => {
    const analyze = createIsolatedRepositoryZipAnalyzer({ executable: '/definitely/missing/kfive-node' });
    await expect(analyze(makeZip(), 'repo.zip', 'application/zip')).rejects.toThrow('Repository ZIP isolation failed.');
  });

  it('kills a hung child at the hard deadline', async () => {
    const analyze = createIsolatedRepositoryZipAnalyzer({ args: ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], timeoutMs: 50 });
    await expect(analyze(makeZip(), 'repo.zip', 'application/zip')).rejects.toMatchObject({
      code: 'REPOSITORY_ANALYSIS_TIMEOUT', statusCode: 408,
    });
  });

  it('kills the child and fails safely when the spawn observer throws', async () => {
    let pid: number | undefined;
    const analyze = createIsolatedRepositoryZipAnalyzer({
      args: ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'],
      onSpawn: (spawnedPid) => {
        pid = spawnedPid;
        throw new Error('observer failure must not escape');
      },
    });
    try {
      await expect(analyze(makeZip(), 'repo.zip', 'application/zip')).rejects.toMatchObject({
        name: 'RepositoryArchiveIsolationError', reason: 'spawn', message: 'Repository ZIP isolation failed.',
      });
      expect(pid).toBeDefined();
      expect(() => process.kill(pid as number, 0)).toThrow();
    } finally {
      if (pid !== undefined) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already terminated */ }
      }
    }
  });

  it('kills the child when its importer request is aborted', async () => {
    let pid: number | undefined;
    const controller = new AbortController();
    const analyze = createIsolatedRepositoryZipAnalyzer({
      args: ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'],
      onSpawn: (spawnedPid) => { pid = spawnedPid; },
    });
    const pending = analyze(makeZip(), 'repo.zip', 'application/zip', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: 'RepositoryArchiveIsolationError', reason: 'aborted', message: 'Repository ZIP isolation failed.',
    });
    expect(pid).toBeDefined();
    expect(() => process.kill(pid as number, 0)).toThrow();
  });

  it('requires one exact bounded binary request frame', () => {
    const request = { buffer: makeZip(), originalName: 'repo.zip', mimeType: 'application/zip' };
    expect(decodeRepositoryArchiveRequest(encodeRepositoryArchiveRequest(request))).toEqual(request);
    const trailing = Buffer.concat([encodeRepositoryArchiveRequest(request), Buffer.from([0])]);
    expect(() => decodeRepositoryArchiveRequest(trailing)).toThrow('Invalid repository archive frame.');
    expect(() => decodeRepositoryArchiveRequest(Buffer.from('KFR1'))).toThrow('Invalid repository archive frame.');
  });
});
