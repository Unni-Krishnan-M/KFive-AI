import { analyzeRepositoryZip, RepositoryArchiveError } from './repositoryArchiveAnalyzer';
import { deflateRawSync } from 'zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});
function crc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipInput { name: string; content?: string | Buffer; flags?: number; method?: number; mode?: number; host?: number; dosAttributes?: number; declaredSize?: number; crc?: number }
function makeZip(inputs: ZipInput[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const input of inputs) {
    const name = Buffer.from(input.name);
    const content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content ?? '');
    const storedContent = input.method === 8 ? deflateRawSync(content) : content;
    const crc = input.crc ?? crc32(content);
    const size = input.declaredSize ?? content.length;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); localHeader.writeUInt16LE(20, 4); localHeader.writeUInt16LE(input.flags ?? 0, 6);
    localHeader.writeUInt16LE(input.method ?? 0, 8); localHeader.writeUInt32LE(crc, 14); localHeader.writeUInt32LE(storedContent.length, 18);
    localHeader.writeUInt32LE(size, 22); localHeader.writeUInt16LE(name.length, 26);
    local.push(localHeader, name, storedContent);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(((input.host ?? 3) << 8) | 20, 4); header.writeUInt16LE(20, 6);
    header.writeUInt16LE(input.flags ?? 0, 8); header.writeUInt16LE(input.method ?? 0, 10); header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(storedContent.length, 20); header.writeUInt32LE(size, 24); header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((((input.mode ?? (input.name.endsWith('/') ? 0o040755 : 0o100644)) << 16) >>> 0) | (input.dosAttributes ?? 0)) >>> 0, 38);
    header.writeUInt32LE(offset, 42); central.push(header, name);
    offset += localHeader.length + name.length + storedContent.length;
  }
  const centralSize = central.reduce((total, item) => total + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(inputs.length, 8); end.writeUInt16LE(inputs.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

async function expectCode(zip: Buffer, code: string): Promise<void> {
  await expect(analyzeRepositoryZip(zip, 'repo.zip', 'application/zip')).rejects.toMatchObject({ code });
}

describe('repository ZIP analyzer', () => {
  it('produces deterministic bounded evidence without script content', async () => {
    const packageJson = JSON.stringify({
      name: 'safe-app', scripts: { test: 'SECRET command', build: 'another command', ' padded ': 'third command', 'bad\u0085name': 'fourth command' },
      dependencies: { react: '^19.0.0', express: '^5.0.0' }, devDependencies: { typescript: '^5.0.0' },
    });
    const report = await analyzeRepositoryZip(makeZip([
      { name: 'package.json', content: packageJson }, { name: 'src/index.ts', content: 'const x = 1;' },
      { name: 'tests/app.test.ts', content: 'test()' }, { name: 'Dockerfile', content: 'FROM scratch' },
      { name: '.github/workflows/ci.yml', content: 'name: ci' }, { name: '.env', content: 'SECRET=value' },
    ]), 'repo.zip', 'application/zip');
    expect(report.summary).toMatchObject({ fileCount: 6, packageManifestCount: 1, testFileCount: 1 });
    expect(report.languages).toContainEqual({ name: 'TypeScript', files: 2, declaredBytes: 18 });
    expect(report.manifests[0]).toMatchObject({ packageName: 'safe-app', scriptNames: ['build', 'padded', 'test'], dependencyCount: 3 });
    expect(report.frameworks.map((item) => item.name)).toEqual(['Express', 'React', 'TypeScript']);
    expect(report.signals).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'security', path: '.env' })]));
    expect(JSON.stringify(report)).not.toContain('SECRET command');
    expect(JSON.stringify(report)).not.toContain('third command');
    expect(JSON.stringify(report)).not.toContain('fourth command');
    expect(JSON.stringify(report)).not.toContain('SECRET=value');
  });

  it.each([
    ['../secret.txt', 'REPOSITORY_ENTRY_INVALID'], ['/etc/passwd', 'REPOSITORY_ENTRY_INVALID'],
    ['C:/secret.txt', 'REPOSITORY_ENTRY_INVALID'], ['a\\b.txt', 'REPOSITORY_ENTRY_INVALID'],
    [' leading/file.txt', 'REPOSITORY_ENTRY_INVALID'], ['trailing./file.txt', 'REPOSITORY_ENTRY_INVALID'],
    ['nested.zip', 'REPOSITORY_NESTED_ARCHIVE_UNSUPPORTED'],
  ])('rejects unsafe path %s', async (name, code) => expectCode(makeZip([{ name }]), code));

  it('rejects case/NFC collisions, file-prefix conflicts, symlinks and encryption', async () => {
    await expectCode(makeZip([{ name: 'Readme.md' }, { name: 'README.md' }]), 'REPOSITORY_ENTRY_INVALID');
    await expectCode(makeZip([{ name: 'cafe\u0301.txt', flags: 1 << 11 }, { name: 'caf\u00e9.txt', flags: 1 << 11 }]), 'REPOSITORY_ENTRY_INVALID');
    await expectCode(makeZip([{ name: 'folder' }, { name: 'folder/file.txt' }]), 'REPOSITORY_ENTRY_INVALID');
    await expectCode(makeZip([{ name: 'link', mode: 0o120777 }]), 'REPOSITORY_ENTRY_INVALID');
    await expectCode(makeZip([{ name: 'mac-link', mode: 0o120777, host: 19 }]), 'REPOSITORY_ENTRY_INVALID');
    await expectCode(makeZip([{ name: 'volume', host: 0, mode: 0, dosAttributes: 0x08 }]), 'REPOSITORY_ENTRY_INVALID');
    await expectCode(makeZip([{ name: 'not-directory', host: 0, mode: 0, dosAttributes: 0x10 }]), 'REPOSITORY_ENTRY_INVALID');
    await expectCode(makeZip([{ name: 'secret.txt', flags: 1 }]), 'REPOSITORY_ARCHIVE_ENCRYPTED');
  });

  it('rejects unsafe Unicode, non-empty directories and excess entry count', async () => {
    await expectCode(makeZip([{ name: `bad\u2060name.txt`, flags: 1 << 11 }]), 'REPOSITORY_ENTRY_INVALID');
    await expectCode(makeZip([{ name: `bad\ufffdname.txt`, flags: 1 << 11 }]), 'REPOSITORY_ENTRY_INVALID');
    await expectCode(makeZip([{ name: `folder/\u0085/file.txt`, flags: 1 << 11 }]), 'REPOSITORY_ENTRY_INVALID');
    await expectCode(makeZip([{ name: 'folder/', content: 'x' }]), 'REPOSITORY_ENTRY_INVALID');
    await expectCode(makeZip(Array.from({ length: 2001 }, (_, index) => ({ name: `f${index}.txt` }))), 'REPOSITORY_ENTRY_LIMIT_EXCEEDED');
  });

  it('rejects corrupt selected manifests and high declared expansion ratios', async () => {
    await expectCode(makeZip([{ name: 'package.json', content: '{}', crc: 123 }]), 'INVALID_REPOSITORY_ARCHIVE');
    await expectCode(makeZip([{ name: 'large.txt', content: 'x'.repeat(10_000), method: 8 }]), 'REPOSITORY_UNCOMPRESSED_LIMIT_EXCEEDED');
  });

  it('rejects unsupported methods, flags and excessive manifest counts', async () => {
    await expectCode(makeZip([{ name: 'a.txt', method: 9 }]), 'REPOSITORY_COMPRESSION_UNSUPPORTED');
    await expectCode(makeZip([{ name: 'a.txt', flags: 1 << 13 }]), 'REPOSITORY_ENTRY_INVALID');
    await expectCode(makeZip(Array.from({ length: 21 }, (_, index) => ({ name: `${index}/package.json`, content: '{}' }))), 'REPOSITORY_MANIFEST_LIMIT_EXCEEDED');
  });

  it('bounds actual manifest reads and dependency evidence without prototype confusion', async () => {
    await expectCode(makeZip([{ name: 'package.json', content: Buffer.alloc(128 * 1024 + 1, 0x20) }]), 'REPOSITORY_ENTRY_INVALID');
    const dependencies = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`dep-${index}`, '1.0.0']));
    Object.assign(dependencies, { constructor: '1.0.0' });
    const report = await analyzeRepositoryZip(makeZip([{ name: 'package.json', content: JSON.stringify({ dependencies }) }]), 'repo.zip', 'application/zip');
    expect(report.dependencies).toHaveLength(500);
    expect(report.frameworks).not.toEqual(expect.arrayContaining([expect.objectContaining({ dependency: 'constructor' })]));
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'DEPENDENCY_LIMIT_REACHED' }));
  });

  it('omits credential-bearing dependency specifications without leaking their values', async () => {
    const content = JSON.stringify({
      dependencies: {
        safe: '^1.0.0',
        ssh: 'git+ssh://git@github.com/example/repository.git',
        basic: 'https://user:password-secret@example.test/archive.tgz',
        token: 'git+https://oauth-token-secret@github.com/example/private.git',
        query: 'https://example.test/archive.tgz?access_token=query-secret',
        legacy: '//registry.example.test/:_authToken=legacy-secret',
        signed: 'https://example.test/archive.tgz?AWSAccessKeyId=access-key-secret',
      },
    });
    const report = await analyzeRepositoryZip(makeZip([{ name: 'package.json', content }]), 'repo.zip', 'application/zip');
    expect(report.manifests[0]).toMatchObject({ dependencyCount: 7 });
    expect(report.dependencies).toEqual([
      expect.objectContaining({ name: 'safe', version: '^1.0.0' }),
      expect.objectContaining({ name: 'ssh', version: 'git+ssh://git@github.com/example/repository.git' }),
    ]);
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'SENSITIVE_DEPENDENCY_SPEC_OMITTED', path: 'package.json' }));
    expect(JSON.stringify(report)).not.toMatch(/password-secret|oauth-token-secret|query-secret|legacy-secret|access-key-secret/);
  });

  it('uses the injected clock for a stable timeout', async () => {
    let clock = 0;
    await expect(analyzeRepositoryZip(makeZip([{ name: 'file.txt' }]), 'repo.zip', 'application/zip', () => {
      clock += 16_000; return clock;
    })).rejects.toMatchObject({ code: 'REPOSITORY_ANALYSIS_TIMEOUT' });
  });

  it('ignores a fake EOCD signature embedded in a valid ZIP comment', async () => {
    const base = makeZip([{ name: 'readme.md', content: 'safe' }]);
    const comment = Buffer.alloc(30);
    comment.writeUInt32LE(0x06054b50, 8);
    const withComment = Buffer.concat([base, comment]);
    withComment.writeUInt16LE(comment.length, base.length - 2);
    await expect(analyzeRepositoryZip(withComment, 'repo.zip', 'application/zip')).resolves.toMatchObject({ summary: { fileCount: 1 } });
  });

  it('maps malformed archives to a safe stable error', async () => {
    await expect(analyzeRepositoryZip(Buffer.from('PK\x03\x04broken'), 'repo.zip', 'application/zip'))
      .rejects.toEqual(expect.objectContaining({ code: 'INVALID_REPOSITORY_ARCHIVE' } as Partial<RepositoryArchiveError>));
  });
});
