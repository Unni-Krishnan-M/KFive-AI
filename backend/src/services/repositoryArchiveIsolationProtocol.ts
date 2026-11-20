import { createHash } from 'crypto';
import {
  REPOSITORY_LIMITS,
  RepositoryArchiveError,
  RepositoryArchiveErrorCode,
  RepositoryArchiveReport,
} from './repositoryArchiveAnalyzer';

export const REPOSITORY_ARCHIVE_REQUEST_MAGIC = Buffer.from('KFR1');
export const REPOSITORY_IMPORTER_SOCKET_PATH = '/run/kfive-repository-importer/importer.sock';
export const REPOSITORY_IMPORTER_HEALTH_REQUEST = Buffer.from('KFH1');
export const REPOSITORY_IMPORTER_HEALTH_RESPONSE = Buffer.from('KFH1OK');
export const REPOSITORY_ARCHIVE_METADATA_BYTES = 1024;
export const REPOSITORY_ARCHIVE_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface RepositoryArchiveRequest {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}
function exact(value: RecordValue, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value).sort();
  const allowed = [...required, ...optional];
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && keys.every((key) => allowed.includes(key));
}
function forbiddenTextCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) as number;
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
    || (codePoint >= 0x200b && codePoint <= 0x200f) || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2060 && codePoint <= 0x206f) || codePoint === 0xfeff || codePoint === 0xfffd;
}
function text(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0)
    && !Array.from(value).some(forbiddenTextCharacter);
}
function integer(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}
function pathText(value: unknown): value is string {
  return text(value, REPOSITORY_LIMITS.pathBytes) && Buffer.byteLength(value) <= REPOSITORY_LIMITS.pathBytes
    && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some((part) => !part || part === '.' || part === '..');
}

export function encodeRepositoryArchiveRequest(request: RepositoryArchiveRequest): Buffer {
  if (!Buffer.isBuffer(request.buffer) || request.buffer.length === 0 || request.buffer.length > REPOSITORY_LIMITS.archiveBytes
    || !text(request.originalName, 255) || !text(request.mimeType, 100)) throw new Error('Repository archive request is invalid.');
  const metadata = Buffer.from(JSON.stringify({ v: 1, originalName: request.originalName, mimeType: request.mimeType }), 'utf8');
  if (metadata.length > REPOSITORY_ARCHIVE_METADATA_BYTES) throw new Error('Repository archive request is invalid.');
  const header = Buffer.alloc(12);
  REPOSITORY_ARCHIVE_REQUEST_MAGIC.copy(header); header.writeUInt32BE(metadata.length, 4); header.writeUInt32BE(request.buffer.length, 8);
  return Buffer.concat([header, metadata, request.buffer]);
}

export function decodeRepositoryArchiveRequest(input: Buffer): RepositoryArchiveRequest {
  if (!Buffer.isBuffer(input) || input.length < 12 || !input.subarray(0, 4).equals(REPOSITORY_ARCHIVE_REQUEST_MAGIC)) throw new Error('Invalid repository archive frame.');
  const metadataLength = input.readUInt32BE(4); const archiveLength = input.readUInt32BE(8);
  if (metadataLength === 0 || metadataLength > REPOSITORY_ARCHIVE_METADATA_BYTES || archiveLength === 0
    || archiveLength > REPOSITORY_LIMITS.archiveBytes || input.length !== 12 + metadataLength + archiveLength) {
    throw new Error('Invalid repository archive frame.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(input.subarray(12, 12 + metadataLength).toString('utf8')); } catch { throw new Error('Invalid repository archive frame.'); }
  const metadata = record(parsed);
  if (!metadata || !exact(metadata, ['v', 'originalName', 'mimeType']) || metadata.v !== 1
    || !text(metadata.originalName, 255) || !text(metadata.mimeType, 100)) throw new Error('Invalid repository archive frame.');
  return { originalName: metadata.originalName, mimeType: metadata.mimeType, buffer: input.subarray(12 + metadataLength) };
}

const ERROR_CONTRACT: Record<RepositoryArchiveErrorCode, { message: string; statusCode: number }> = {
  INVALID_REPOSITORY_ARCHIVE: { message: 'The uploaded ZIP could not be safely read.', statusCode: 400 },
  REPOSITORY_ARCHIVE_TOO_LARGE: { message: 'Repository ZIP must be at most 10 MiB.', statusCode: 413 },
  REPOSITORY_ENTRY_LIMIT_EXCEEDED: { message: 'The ZIP contains more than 2000 entries.', statusCode: 413 },
  REPOSITORY_UNCOMPRESSED_LIMIT_EXCEEDED: { message: 'The ZIP exceeds the allowed expansion limits.', statusCode: 413 },
  REPOSITORY_ENTRY_INVALID: { message: 'The ZIP contains invalid entry metadata.', statusCode: 400 },
  REPOSITORY_ARCHIVE_ENCRYPTED: { message: 'Encrypted ZIP entries are not supported.', statusCode: 400 },
  REPOSITORY_COMPRESSION_UNSUPPORTED: { message: 'The ZIP uses an unsupported compression method.', statusCode: 400 },
  REPOSITORY_NESTED_ARCHIVE_UNSUPPORTED: { message: 'Nested archives are not supported.', statusCode: 400 },
  REPOSITORY_MANIFEST_LIMIT_EXCEEDED: { message: 'The ZIP contains more than 20 package manifests.', statusCode: 413 },
  REPOSITORY_ANALYSIS_TIMEOUT: { message: 'Repository analysis timed out.', statusCode: 408 },
};

export function repositoryArchiveErrorFromCode(value: unknown): RepositoryArchiveError | undefined {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(ERROR_CONTRACT, value)) return undefined;
  const code = value as RepositoryArchiveErrorCode; const contract = ERROR_CONTRACT[code];
  return new RepositoryArchiveError(contract.message, code, contract.statusCode);
}

export type RepositoryArchiveProtocolErrorReason = 'json' | 'envelope' | 'report' | 'worker' | 'busy';

export class RepositoryArchiveProtocolError extends Error {
  constructor(readonly reason: RepositoryArchiveProtocolErrorReason) {
    super('Repository archive protocol failed.');
    this.name = 'RepositoryArchiveProtocolError';
  }
}

function encodeRepositoryArchiveEnvelope(value: Record<string, unknown>): Buffer {
  const output = Buffer.from(JSON.stringify(value), 'utf8');
  if (output.length === 0 || output.length > REPOSITORY_ARCHIVE_RESPONSE_BYTES) {
    throw new RepositoryArchiveProtocolError('envelope');
  }
  return output;
}

export function encodeRepositoryArchiveSuccess(report: RepositoryArchiveReport): Buffer {
  return encodeRepositoryArchiveEnvelope({ v: 1, ok: true, report });
}

export function encodeRepositoryArchiveFailure(code: RepositoryArchiveErrorCode | 'INTERNAL' | 'BUSY'): Buffer {
  return encodeRepositoryArchiveEnvelope({ v: 1, ok: false, code });
}

export function decodeRepositoryArchiveResponse(input: Buffer, request: RepositoryArchiveRequest): RepositoryArchiveReport {
  if (!Buffer.isBuffer(input) || input.length === 0 || input.length > REPOSITORY_ARCHIVE_RESPONSE_BYTES) {
    throw new RepositoryArchiveProtocolError('envelope');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(input.toString('utf8')); } catch { throw new RepositoryArchiveProtocolError('json'); }
  const envelope = record(parsed);
  if (!envelope || envelope.v !== 1 || typeof envelope.ok !== 'boolean') throw new RepositoryArchiveProtocolError('envelope');
  if (envelope.ok) {
    if (!exact(envelope, ['v', 'ok', 'report'])) throw new RepositoryArchiveProtocolError('envelope');
    const report = validateRepositoryArchiveReport(envelope.report, request);
    if (!report) throw new RepositoryArchiveProtocolError('report');
    return report;
  }
  if (!exact(envelope, ['v', 'ok', 'code'])) throw new RepositoryArchiveProtocolError('envelope');
  if (envelope.code === 'INTERNAL') throw new RepositoryArchiveProtocolError('worker');
  if (envelope.code === 'BUSY') throw new RepositoryArchiveProtocolError('busy');
  throw repositoryArchiveErrorFromCode(envelope.code) ?? new RepositoryArchiveProtocolError('envelope');
}

export function validateRepositoryArchiveReport(
  value: unknown,
  request: RepositoryArchiveRequest,
): RepositoryArchiveReport | undefined {
  const root = record(value);
  if (!root || !exact(root, ['source', 'summary', 'tree', 'languages', 'manifests', 'dependencies', 'frameworks', 'signals', 'warnings'])) return undefined;
  const source = record(root.source); const summary = record(root.summary);
  if (!source || !exact(source, ['kind', 'originalName', 'mimeType', 'compressedBytes', 'sha256']) || source.kind !== 'zip'
    || source.originalName !== request.originalName || source.mimeType !== request.mimeType || source.compressedBytes !== request.buffer.length
    || typeof source.sha256 !== 'string' || source.sha256 !== createHash('sha256').update(request.buffer).digest('hex')) return undefined;
  if (!summary || !exact(summary, ['fileCount', 'directoryCount', 'declaredUncompressedBytes', 'maxDepth', 'packageManifestCount', 'testFileCount'])
    || !integer(summary.fileCount, REPOSITORY_LIMITS.entries) || !integer(summary.directoryCount, REPOSITORY_LIMITS.entries)
    || summary.fileCount + summary.directoryCount > REPOSITORY_LIMITS.entries
    || !integer(summary.declaredUncompressedBytes, REPOSITORY_LIMITS.declaredBytes) || !integer(summary.maxDepth, REPOSITORY_LIMITS.pathDepth)
    || !integer(summary.packageManifestCount, REPOSITORY_LIMITS.packageManifests) || !integer(summary.testFileCount, summary.fileCount)) return undefined;
  if (!Array.isArray(root.tree) || root.tree.length > REPOSITORY_LIMITS.treeEntries
    || !root.tree.every((item) => { const entry = record(item); return !!entry && exact(entry, ['path', 'type'], ['declaredBytes', 'language'])
      && pathText(entry.path) && (entry.type === 'file' || entry.type === 'directory')
      && (entry.declaredBytes === undefined || integer(entry.declaredBytes, REPOSITORY_LIMITS.entryBytes))
      && (entry.language === undefined || text(entry.language, 50)); })) return undefined;
  if (!Array.isArray(root.languages) || root.languages.length > 100 || !root.languages.every((item) => { const entry = record(item); return !!entry
    && exact(entry, ['name', 'files', 'declaredBytes']) && text(entry.name, 50) && integer(entry.files, REPOSITORY_LIMITS.entries)
    && integer(entry.declaredBytes, REPOSITORY_LIMITS.declaredBytes); })) return undefined;
  if (!Array.isArray(root.manifests) || root.manifests.length > REPOSITORY_LIMITS.packageManifests || !root.manifests.every((item) => {
    const entry = record(item); return !!entry && exact(entry, ['path', 'packageManager', 'dependencyCount', 'scriptNames'], ['packageName'])
      && pathText(entry.path) && entry.packageManager === 'npm' && integer(entry.dependencyCount, REPOSITORY_LIMITS.dependencies)
      && (entry.packageName === undefined || text(entry.packageName, 214)) && Array.isArray(entry.scriptNames) && entry.scriptNames.length <= 100
      && entry.scriptNames.every((script) => text(script, 100));
  }) || summary.packageManifestCount !== root.manifests.length) return undefined;
  const dependencyKinds = new Set(['runtime', 'development', 'peer', 'optional']);
  if (!Array.isArray(root.dependencies) || root.dependencies.length > REPOSITORY_LIMITS.dependencies || !root.dependencies.every((item) => {
    const entry = record(item); return !!entry && exact(entry, ['manifestPath', 'name', 'version', 'kind']) && pathText(entry.manifestPath)
      && text(entry.name, 214) && text(entry.version, 300) && typeof entry.kind === 'string' && dependencyKinds.has(entry.kind);
  })) return undefined;
  if (!Array.isArray(root.frameworks) || root.frameworks.length > 100 || !root.frameworks.every((item) => { const entry = record(item); return !!entry
    && exact(entry, ['name', 'dependency', 'manifestPath']) && text(entry.name, 100) && text(entry.dependency, 214) && pathText(entry.manifestPath); })) return undefined;
  const signalKinds = new Set(['tests', 'docker', 'compose', 'ci', 'kubernetes', 'security']);
  if (!Array.isArray(root.signals) || root.signals.length > 100 || !root.signals.every((item) => { const entry = record(item); return !!entry
    && exact(entry, ['kind', 'path'], ['severity']) && typeof entry.kind === 'string' && signalKinds.has(entry.kind) && pathText(entry.path)
    && (entry.severity === undefined || entry.severity === 'info' || entry.severity === 'warning'); })) return undefined;
  if (!Array.isArray(root.warnings) || root.warnings.length > 100 || !root.warnings.every((item) => { const entry = record(item); return !!entry
    && exact(entry, ['code', 'message'], ['path']) && text(entry.code, 100) && text(entry.message, 300)
    && (entry.path === undefined || pathText(entry.path)); })) return undefined;
  return root as unknown as RepositoryArchiveReport;
}
