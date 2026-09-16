import { createHash } from 'crypto';
import path from 'path';
import { Readable } from 'stream';
import { Entry, ZipFile, fromBuffer } from 'yauzl';

export const REPOSITORY_LIMITS = Object.freeze({
  archiveBytes: 10 * 1024 * 1024,
  entries: 2000,
  declaredBytes: 25 * 1024 * 1024,
  entryBytes: 5 * 1024 * 1024,
  pathBytes: 512,
  pathDepth: 30,
  manifestBytes: 128 * 1024,
  totalReadBytes: 1024 * 1024,
  packageManifests: 20,
  dependencies: 500,
  treeEntries: 2000,
  timeoutMs: 15_000,
});

export type RepositoryArchiveErrorCode =
  | 'INVALID_REPOSITORY_ARCHIVE'
  | 'REPOSITORY_ARCHIVE_TOO_LARGE'
  | 'REPOSITORY_ENTRY_LIMIT_EXCEEDED'
  | 'REPOSITORY_UNCOMPRESSED_LIMIT_EXCEEDED'
  | 'REPOSITORY_ENTRY_INVALID'
  | 'REPOSITORY_ARCHIVE_ENCRYPTED'
  | 'REPOSITORY_COMPRESSION_UNSUPPORTED'
  | 'REPOSITORY_NESTED_ARCHIVE_UNSUPPORTED'
  | 'REPOSITORY_MANIFEST_LIMIT_EXCEEDED'
  | 'REPOSITORY_ANALYSIS_TIMEOUT';

export class RepositoryArchiveError extends Error {
  readonly isOperational = true;
  constructor(message: string, readonly code: RepositoryArchiveErrorCode, readonly statusCode: number) {
    super(message);
    this.name = 'RepositoryArchiveError';
  }
}

export interface RepositoryTreeEntry { path: string; type: 'file' | 'directory'; declaredBytes?: number; language?: string }
export interface RepositoryLanguage { name: string; files: number; declaredBytes: number }
export interface RepositoryManifest { path: string; packageName?: string; packageManager: 'npm'; dependencyCount: number; scriptNames: string[] }
export interface RepositoryDependency { manifestPath: string; name: string; version: string; kind: 'runtime' | 'development' | 'peer' | 'optional' }
export interface RepositoryFramework { name: string; dependency: string; manifestPath: string }
export interface RepositorySignal { kind: 'tests' | 'docker' | 'compose' | 'ci' | 'kubernetes' | 'security'; path: string; severity?: 'info' | 'warning' }
export interface RepositoryWarning { code: string; message: string; path?: string }

export interface RepositoryArchiveReport {
  source: { kind: 'zip'; originalName: string; mimeType: string; compressedBytes: number; sha256: string };
  summary: { fileCount: number; directoryCount: number; declaredUncompressedBytes: number; maxDepth: number; packageManifestCount: number; testFileCount: number };
  tree: RepositoryTreeEntry[];
  languages: RepositoryLanguage[];
  manifests: RepositoryManifest[];
  dependencies: RepositoryDependency[];
  frameworks: RepositoryFramework[];
  signals: RepositorySignal[];
  warnings: RepositoryWarning[];
}

const EXTENSIONS: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.java': 'Java', '.go': 'Go', '.rs': 'Rust', '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++', '.hpp': 'C++',
  '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.kt': 'Kotlin', '.kts': 'Kotlin', '.scala': 'Scala',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.vue': 'Vue', '.svelte': 'Svelte', '.sh': 'Shell', '.sql': 'SQL',
};

const FRAMEWORKS: Readonly<Record<string, string>> = Object.freeze({
  react: 'React', next: 'Next.js', vue: 'Vue', '@angular/core': 'Angular', express: 'Express', fastify: 'Fastify',
  '@nestjs/core': 'NestJS', mongoose: 'Mongoose', jest: 'Jest', vitest: 'Vitest', vite: 'Vite', typescript: 'TypeScript',
});

const NESTED_ARCHIVE = /\.(?:zip|tar|tgz|gz|bz2|xz|7z|rar|jar|war|apk)$/i;
const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i;
function containsUnsafeText(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point === 0xfffd || /[\p{Cc}\p{Cf}]/u.test(character);
  });
}

const SENSITIVE_DEPENDENCY_QUERY_KEY = /^(?:_?auth(?:token)?|access[_-]?token|api[_-]?key|awsaccesskeyid|client[_-]?secret|credential|deploy[_-]?token|googleaccessid|id[_-]?token|key|password|passwd|private[_-]?token|refresh[_-]?token|secret|signature|sig|token|x-amz-(?:credential|signature|security-token)|x-goog-(?:credential|signature))$/i;

function containsSensitiveDependencySpec(value: string): boolean {
  if (/(?:^|[^a-z\d_-])(?:_?auth(?:token)?|access[_-]?token|api[_-]?key|awsaccesskeyid|client[_-]?secret|deploy[_-]?token|googleaccessid|id[_-]?token|password|passwd|private[_-]?token|refresh[_-]?token|secret|signature|token)\s*[:=]/i.test(value)) {
    return true;
  }
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    const httpFamily = /^(?:https?|git\+https?):$/i.test(parsed.protocol);
    if (parsed.password || (httpFamily && parsed.username)) return true;
    return [...parsed.searchParams.keys()].some((key) => SENSITIVE_DEPENDENCY_QUERY_KEY.test(key));
  } catch {
    return false;
  }
}

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

function zipFromBuffer(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    fromBuffer(buffer, {
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: true,
      decodeStrings: true,
      autoClose: true,
    }, (error, zip) => error ? reject(error) : resolve(zip));
  });
}

function safeZipReadError(error: unknown): RepositoryArchiveError {
  const message = error instanceof Error ? error.message : '';
  if (/file ?name|invalid relative path|backslash|absolute path|drive/i.test(message)) {
    return new RepositoryArchiveError('The ZIP contains an unsafe entry path.', 'REPOSITORY_ENTRY_INVALID', 400);
  }
  if (/encrypt/i.test(message)) return new RepositoryArchiveError('Encrypted ZIP entries are not supported.', 'REPOSITORY_ARCHIVE_ENCRYPTED', 400);
  return new RepositoryArchiveError('The uploaded ZIP could not be safely read.', 'INVALID_REPOSITORY_ARCHIVE', 400);
}

function hasEncryptedCentralEntry(buffer: Buffer): boolean {
  const minimumEocd = 22;
  const searchStart = Math.max(0, buffer.length - 65_557);
  for (let eocd = buffer.length - minimumEocd; eocd >= searchStart; eocd -= 1) {
    if (buffer.readUInt32LE(eocd) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(eocd + 20);
    const countOnDisk = buffer.readUInt16LE(eocd + 8);
    const count = buffer.readUInt16LE(eocd + 10);
    const centralSize = buffer.readUInt32LE(eocd + 12);
    const centralOffset = buffer.readUInt32LE(eocd + 16);
    if (eocd + minimumEocd + commentLength !== buffer.length || buffer.readUInt16LE(eocd + 4) !== 0
      || buffer.readUInt16LE(eocd + 6) !== 0 || countOnDisk !== count
      || centralOffset > eocd || centralSize > eocd - centralOffset || centralOffset + centralSize !== eocd) continue;
    let cursor = centralOffset;
    let encrypted = false;
    let valid = true;
    for (let index = 0; index < count; index += 1) {
      if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) { valid = false; break; }
      if ((buffer.readUInt16LE(cursor + 8) & 1) !== 0) encrypted = true;
      const next = cursor + 46 + buffer.readUInt16LE(cursor + 28) + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
      if (!Number.isSafeInteger(next) || next > eocd) { valid = false; break; }
      cursor = next;
    }
    if (valid && cursor === eocd) return encrypted;
  }
  return false;
}

function sanitizeZipComment(buffer: Buffer): Buffer {
  const minimumEocd = 22;
  const searchStart = Math.max(0, buffer.length - 65_557);
  for (let eocd = buffer.length - minimumEocd; eocd >= searchStart; eocd -= 1) {
    if (buffer.readUInt32LE(eocd) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(eocd + 20);
    const centralSize = buffer.readUInt32LE(eocd + 12);
    const centralOffset = buffer.readUInt32LE(eocd + 16);
    if (eocd + minimumEocd + commentLength !== buffer.length || buffer.readUInt16LE(eocd + 4) !== 0
      || buffer.readUInt16LE(eocd + 6) !== 0 || buffer.readUInt16LE(eocd + 8) !== buffer.readUInt16LE(eocd + 10)
      || centralOffset > eocd || centralSize > eocd - centralOffset || centralOffset + centralSize !== eocd) continue;
    if (commentLength === 0) return buffer;
    const sanitized = Buffer.from(buffer);
    sanitized.fill(0, eocd + minimumEocd);
    return sanitized;
  }
  throw new RepositoryArchiveError('The uploaded file is not a valid ZIP archive.', 'INVALID_REPOSITORY_ARCHIVE', 400);
}

function readEntryContent(
  zip: ZipFile,
  entry: Entry,
  limit: number,
  deadline: number,
  trackStream: (stream?: Readable) => void,
  now: () => number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (openError, stream) => {
      if (openError) return reject(openError);
      trackStream(stream);
      const chunks: Buffer[] = [];
      let read = 0;
      stream.on('data', (chunk: Buffer) => {
        if (now() > deadline || read + chunk.length > limit) {
          stream.destroy(new RepositoryArchiveError(
            now() > deadline ? 'Repository analysis timed out.' : 'A selected repository manifest exceeds its read limit.',
            now() > deadline ? 'REPOSITORY_ANALYSIS_TIMEOUT' : 'REPOSITORY_ENTRY_INVALID',
            now() > deadline ? 408 : 413
          ));
          return;
        }
        chunks.push(chunk);
        read += chunk.length;
      });
      stream.once('error', (error) => { trackStream(); reject(error); });
      stream.once('end', () => {
        trackStream();
        const content = Buffer.concat(chunks, read);
        if (crc32(content) !== (entry.crc32 >>> 0)) {
          reject(new RepositoryArchiveError('A selected manifest failed its integrity check.', 'INVALID_REPOSITORY_ARCHIVE', 400));
        } else resolve(content);
      });
    });
  });
}

function validatePath(raw: string, collisions: Map<string, 'file' | 'directory'>): { canonical: string; directory: boolean; depth: number } {
  if (!raw || raw.length > REPOSITORY_LIMITS.pathBytes || raw.includes('\\')
    || containsUnsafeText(raw) || raw.startsWith('/') || /^[a-z]:/i.test(raw)) {
    throw new RepositoryArchiveError('The ZIP contains an unsafe entry path.', 'REPOSITORY_ENTRY_INVALID', 400);
  }
  const directory = raw.endsWith('/');
  const withoutSlash = directory ? raw.slice(0, -1) : raw;
  const segments = withoutSlash.split('/');
  if (!withoutSlash || segments.length > REPOSITORY_LIMITS.pathDepth || segments.some((segment) =>
    !segment || segment === '.' || segment === '..' || segment !== segment.trim() || /[. ]$/.test(segment))) {
    throw new RepositoryArchiveError('The ZIP contains an unsafe entry path.', 'REPOSITORY_ENTRY_INVALID', 400);
  }
  const normalizedSegments = segments.map((segment) => segment.normalize('NFC'));
  const canonical = normalizedSegments.join('/') + (directory ? '/' : '');
  if (Buffer.byteLength(canonical, 'utf8') > REPOSITORY_LIMITS.pathBytes) {
    throw new RepositoryArchiveError('The ZIP contains an unsafe entry path.', 'REPOSITORY_ENTRY_INVALID', 400);
  }
  const collisionKey = (directory ? canonical.slice(0, -1) : canonical).toLowerCase();
  const parentKeys = normalizedSegments.slice(0, -1).map((_, index) => normalizedSegments.slice(0, index + 1).join('/').toLowerCase());
  if (collisions.has(collisionKey) || parentKeys.some((key) => collisions.get(key) === 'file')
    || (!directory && [...collisions.keys()].some((key) => key.startsWith(`${collisionKey}/`)))) {
    throw new RepositoryArchiveError('The ZIP contains colliding entry paths.', 'REPOSITORY_ENTRY_INVALID', 400);
  }
  collisions.set(collisionKey, directory ? 'directory' : 'file');
  return { canonical, directory, depth: segments.length };
}

function validateEntryType(entry: Entry, directory: boolean): void {
  const host = (entry.versionMadeBy >>> 8) & 0xff;
  const dosAttributes = entry.externalFileAttributes & 0xff;
  if ((dosAttributes & 0x08) !== 0) throw new RepositoryArchiveError('The ZIP contains a volume entry.', 'REPOSITORY_ENTRY_INVALID', 400);
  if (host === 3 || host === 19) {
    const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
    const kind = mode & 0o170000;
    if (kind !== 0 && kind !== 0o100000 && kind !== 0o040000) {
      throw new RepositoryArchiveError('The ZIP contains a non-regular filesystem entry.', 'REPOSITORY_ENTRY_INVALID', 400);
    }
    if ((kind === 0o040000) !== directory && kind !== 0) {
      throw new RepositoryArchiveError('The ZIP contains inconsistent entry metadata.', 'REPOSITORY_ENTRY_INVALID', 400);
    }
  } else if (((dosAttributes & 0x10) !== 0) !== directory) {
    throw new RepositoryArchiveError('The ZIP contains inconsistent entry metadata.', 'REPOSITORY_ENTRY_INVALID', 400);
  }
}

function signalFor(filePath: string): RepositorySignal[] {
  const lower = filePath.toLowerCase();
  const base = path.posix.basename(lower);
  const signals: RepositorySignal[] = [];
  if (/(^|\/)(__tests__|test|tests|spec)(\/|$)/.test(lower) || /\.(?:test|spec)\.[^.]+$/.test(lower)) signals.push({ kind: 'tests', path: filePath });
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) signals.push({ kind: 'docker', path: filePath });
  if (/^(?:docker-)?compose(?:\.[a-z0-9_-]+)?\.ya?ml$/.test(base)) signals.push({ kind: 'compose', path: filePath });
  if (/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(lower) || base === '.gitlab-ci.yml') signals.push({ kind: 'ci', path: filePath });
  if (/(^|\/)(k8s|kubernetes)(\/|$)/.test(lower) && /\.ya?ml$/.test(lower)) signals.push({ kind: 'kubernetes', path: filePath });
  if ((base === '.env' || (base.startsWith('.env.') && !base.endsWith('.example'))) || /\.(?:pem|key|p12|pfx)$/.test(base)) {
    signals.push({ kind: 'security', path: filePath, severity: 'warning' });
  }
  return signals;
}

function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max && !containsUnsafeText(trimmed) ? trimmed : undefined;
}

function parsePackageManifest(
  manifestPath: string,
  content: Buffer,
  dependencies: RepositoryDependency[],
  frameworks: RepositoryFramework[],
  warnings: RepositoryWarning[]
): RepositoryManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(content.toString('utf8')); } catch {
    warnings.push({ code: 'INVALID_PACKAGE_MANIFEST', message: 'A package.json file could not be parsed.', path: manifestPath });
    return { path: manifestPath, packageManager: 'npm', dependencyCount: 0, scriptNames: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push({ code: 'INVALID_PACKAGE_MANIFEST', message: 'A package.json file is not a JSON object.', path: manifestPath });
    return { path: manifestPath, packageManager: 'npm', dependencyCount: 0, scriptNames: [] };
  }
  const record = parsed as Record<string, unknown>;
  const scriptObject = record.scripts && typeof record.scripts === 'object' && !Array.isArray(record.scripts)
    ? record.scripts as Record<string, unknown> : {};
  const scriptNames = Object.keys(scriptObject).flatMap((name) => {
    const normalized = safeText(name, 100);
    return normalized ? [normalized] : [];
  }).sort().slice(0, 100);
  const kinds = [
    ['dependencies', 'runtime'], ['devDependencies', 'development'], ['peerDependencies', 'peer'], ['optionalDependencies', 'optional'],
  ] as const;
  const initialDependencyLength = dependencies.length;
  let dependencyCount = 0;
  let retainableDependencyCount = 0;
  for (const [field, kind] of kinds) {
    const group = record[field];
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
    for (const [name, versionValue] of Object.entries(group as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      const version = safeText(versionValue, 300);
      if (!SAFE_PACKAGE_NAME.test(name) || !version) continue;
      dependencyCount += 1;
      if (containsSensitiveDependencySpec(version)) {
        if (!warnings.some((warning) => warning.code === 'SENSITIVE_DEPENDENCY_SPEC_OMITTED' && warning.path === manifestPath)) {
          warnings.push({
            code: 'SENSITIVE_DEPENDENCY_SPEC_OMITTED',
            message: 'A credential-bearing dependency specification was omitted from the report.',
            path: manifestPath,
          });
        }
        continue;
      }
      retainableDependencyCount += 1;
      if (dependencies.length < REPOSITORY_LIMITS.dependencies) {
        dependencies.push({ manifestPath, name, version, kind });
        const framework = Object.prototype.hasOwnProperty.call(FRAMEWORKS, name) ? FRAMEWORKS[name] : undefined;
        if (framework && frameworks.length < 100 && !frameworks.some((item) => item.name === framework && item.manifestPath === manifestPath)) {
          frameworks.push({ name: framework, dependency: name, manifestPath });
        }
      }
    }
  }
  if (retainableDependencyCount > dependencies.length - initialDependencyLength
    && !warnings.some((warning) => warning.code === 'DEPENDENCY_LIMIT_REACHED')) {
    warnings.push({ code: 'DEPENDENCY_LIMIT_REACHED', message: 'Dependency evidence was limited to 500 entries.', path: manifestPath });
  }
  return {
    path: manifestPath,
    ...(safeText(record.name, 214) ? { packageName: safeText(record.name, 214) } : {}),
    packageManager: 'npm', dependencyCount: Math.min(dependencyCount, REPOSITORY_LIMITS.dependencies), scriptNames,
  };
}

export async function analyzeRepositoryZip(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  now: () => number = Date.now
): Promise<RepositoryArchiveReport> {
  if (!buffer.length || buffer.length > REPOSITORY_LIMITS.archiveBytes) {
    throw new RepositoryArchiveError('Repository ZIP must be at most 10 MiB.', 'REPOSITORY_ARCHIVE_TOO_LARGE', 413);
  }
  const signature = buffer.subarray(0, 4).toString('hex');
  if (signature !== '504b0304' && signature !== '504b0506') {
    throw new RepositoryArchiveError('The uploaded file is not a valid ZIP archive.', 'INVALID_REPOSITORY_ARCHIVE', 400);
  }
  if (hasEncryptedCentralEntry(buffer)) {
    throw new RepositoryArchiveError('Encrypted ZIP entries are not supported.', 'REPOSITORY_ARCHIVE_ENCRYPTED', 400);
  }
  const deadline = now() + REPOSITORY_LIMITS.timeoutMs;
  let zip: ZipFile;
  try { zip = await zipFromBuffer(sanitizeZipComment(buffer)); } catch (error) {
    throw safeZipReadError(error);
  }
  if (zip.entryCount > REPOSITORY_LIMITS.entries) {
    zip.close();
    throw new RepositoryArchiveError('The ZIP contains more than 2000 entries.', 'REPOSITORY_ENTRY_LIMIT_EXCEEDED', 413);
  }

  const tree: RepositoryTreeEntry[] = [];
  const manifests: RepositoryManifest[] = [];
  const dependencies: RepositoryDependency[] = [];
  const frameworks: RepositoryFramework[] = [];
  const signals: RepositorySignal[] = [];
  const warnings: RepositoryWarning[] = [];
  const languages = new Map<string, { files: number; declaredBytes: number }>();
  const collisions = new Map<string, 'file' | 'directory'>();
  let totalDeclared = 0;
  let totalRead = 0;
  let fileCount = 0;
  let directoryCount = 0;
  let maxDepth = 0;
  let testFileCount = 0;
  let activeStream: Readable | undefined;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new RepositoryArchiveError('Repository analysis timed out.', 'REPOSITORY_ANALYSIS_TIMEOUT', 408)), REPOSITORY_LIMITS.timeoutMs);
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeStream?.destroy(error instanceof Error ? error : new Error('Repository analysis ended.'));
      activeStream = undefined;
      try { zip.close(); } catch { /* already closed */ }
      error ? reject(error) : resolve();
    };
    zip.once('error', (error) => finish(safeZipReadError(error)));
    zip.on('entry', (entry: Entry) => {
      void (async () => {
        if (now() > deadline) throw new RepositoryArchiveError('Repository analysis timed out.', 'REPOSITORY_ANALYSIS_TIMEOUT', 408);
        if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 1) !== 0) {
          throw new RepositoryArchiveError('Encrypted ZIP entries are not supported.', 'REPOSITORY_ARCHIVE_ENCRYPTED', 400);
        }
        if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
          throw new RepositoryArchiveError('The ZIP uses an unsupported compression method.', 'REPOSITORY_COMPRESSION_UNSUPPORTED', 400);
        }
        const allowedFlags = entry.compressionMethod === 8 ? ((1 << 1) | (1 << 2) | (1 << 3) | (1 << 11)) : ((1 << 3) | (1 << 11));
        if ((entry.generalPurposeBitFlag & ~allowedFlags) !== 0) {
          throw new RepositoryArchiveError('The ZIP contains unsupported entry flags.', 'REPOSITORY_ENTRY_INVALID', 400);
        }
        const validated = validatePath(entry.fileName, collisions);
        validateEntryType(entry, validated.directory);
        if (validated.directory && (entry.uncompressedSize !== 0 || entry.compressedSize !== 0)) {
          throw new RepositoryArchiveError('A ZIP directory entry has invalid size metadata.', 'REPOSITORY_ENTRY_INVALID', 400);
        }
        if (!validated.directory && NESTED_ARCHIVE.test(validated.canonical)) {
          throw new RepositoryArchiveError('Nested archives are not supported.', 'REPOSITORY_NESTED_ARCHIVE_UNSUPPORTED', 400);
        }
        if (!Number.isSafeInteger(entry.uncompressedSize) || !Number.isSafeInteger(entry.compressedSize)
          || entry.uncompressedSize < 0 || entry.compressedSize < 0 || entry.uncompressedSize > REPOSITORY_LIMITS.entryBytes) {
          throw new RepositoryArchiveError('A ZIP entry exceeds 5 MiB.', 'REPOSITORY_UNCOMPRESSED_LIMIT_EXCEEDED', 413);
        }
        if (!validated.directory && entry.uncompressedSize > 0
          && (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > 100)) {
          throw new RepositoryArchiveError('A ZIP entry exceeds the allowed compression ratio.', 'REPOSITORY_UNCOMPRESSED_LIMIT_EXCEEDED', 413);
        }
        if (totalDeclared > REPOSITORY_LIMITS.declaredBytes - entry.uncompressedSize) {
          throw new RepositoryArchiveError('The ZIP expands beyond 25 MiB.', 'REPOSITORY_UNCOMPRESSED_LIMIT_EXCEEDED', 413);
        }
        totalDeclared += entry.uncompressedSize;
        if (totalDeclared > REPOSITORY_LIMITS.declaredBytes) {
          throw new RepositoryArchiveError('The ZIP expands beyond 25 MiB.', 'REPOSITORY_UNCOMPRESSED_LIMIT_EXCEEDED', 413);
        }
        maxDepth = Math.max(maxDepth, validated.depth);
        if (validated.directory) {
          directoryCount += 1;
          tree.push({ path: validated.canonical, type: 'directory' });
        } else {
          fileCount += 1;
          const extension = path.posix.extname(validated.canonical).toLowerCase();
          const language = EXTENSIONS[extension];
          tree.push({ path: validated.canonical, type: 'file', declaredBytes: entry.uncompressedSize, ...(language ? { language } : {}) });
          if (language) {
            const current = languages.get(language) ?? { files: 0, declaredBytes: 0 };
            current.files += 1; current.declaredBytes += entry.uncompressedSize; languages.set(language, current);
          }
          const foundSignals = signalFor(validated.canonical);
          signals.push(...foundSignals.slice(0, Math.max(0, 100 - signals.length)));
          if (foundSignals.some((signal) => signal.kind === 'tests')) testFileCount += 1;
          if (path.posix.basename(validated.canonical).toLowerCase() === 'package.json') {
            if (manifests.length >= REPOSITORY_LIMITS.packageManifests) {
              throw new RepositoryArchiveError('The ZIP contains more than 20 package manifests.', 'REPOSITORY_MANIFEST_LIMIT_EXCEEDED', 413);
            }
            if (entry.uncompressedSize > REPOSITORY_LIMITS.manifestBytes || totalRead + entry.uncompressedSize > REPOSITORY_LIMITS.totalReadBytes) {
              throw new RepositoryArchiveError('Selected repository manifests exceed the read limit.', 'REPOSITORY_ENTRY_INVALID', 413);
            }
            const content = await readEntryContent(
              zip, entry, Math.min(REPOSITORY_LIMITS.manifestBytes, REPOSITORY_LIMITS.totalReadBytes - totalRead), deadline,
              (stream) => { activeStream = stream; }, now
            );
            totalRead += content.length;
            manifests.push(parsePackageManifest(validated.canonical, content, dependencies, frameworks, warnings));
          }
        }
        if (!settled) zip.readEntry();
      })().catch(finish);
    });
    zip.once('end', () => finish());
    zip.readEntry();
  });

  return {
    source: { kind: 'zip', originalName, mimeType, compressedBytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') },
    summary: { fileCount, directoryCount, declaredUncompressedBytes: totalDeclared, maxDepth, packageManifestCount: manifests.length, testFileCount },
    tree,
    languages: [...languages.entries()].map(([name, value]) => ({ name, ...value })).sort((a, b) => a.name.localeCompare(b.name)),
    manifests, dependencies, frameworks: frameworks.sort((a, b) => a.name.localeCompare(b.name)), signals, warnings,
  };
}
