import { unwrapApiData } from './runtimeSettings';

type UnknownRecord = Record<string, unknown>;
export const REPOSITORY_ARCHIVE_LIMIT_BYTES = 10 * 1024 * 1024;

export interface RepositoryDependencyStatus { id: string; status: string; message?: string }
export interface RepositoryStatus {
  available?: boolean; canAnalyze: boolean;
  scope?: { type?: string; projectId?: string; projectStatus?: string };
  dependencies: RepositoryDependencyStatus[]; limits?: { maxArchiveBytes?: number };
}
export interface RepositoryLanguage { name: string; files: number; declaredBytes: number }
export interface RepositoryManifest { path: string; packageName?: string; packageManager: string; dependencyCount: number; scriptNames: string[] }
export interface RepositoryDependency { manifestPath: string; name: string; version: string; kind: string }
export interface RepositoryFramework { name: string; dependency: string; manifestPath: string }
export interface RepositorySignal { kind: string; path: string; severity?: string }
export interface RepositoryWarning { code: string; message: string; path?: string }
export interface RepositoryTreeEntry { path: string; type: 'file' | 'directory'; declaredBytes?: number; language?: string }
export interface RepositoryAnalysis {
  id: string; projectId?: string; name: string; status: 'completed'; analyzerVersion?: number;
  source: { kind: 'zip'; originalName: string; mimeType?: string; compressedBytes: number; sha256: string };
  summary: { fileCount: number; directoryCount: number; declaredUncompressedBytes: number; maxDepth: number; packageManifestCount: number; testFileCount: number };
  languages: RepositoryLanguage[]; frameworks: RepositoryFramework[]; manifests: RepositoryManifest[];
  dependencies: RepositoryDependency[]; signals: RepositorySignal[]; tree: RepositoryTreeEntry[];
  warnings: RepositoryWarning[]; createdAt?: string; updatedAt?: string;
}
export type RepositoryAnalysisSummary = Omit<RepositoryAnalysis, 'languages' | 'frameworks' | 'manifests' | 'dependencies' | 'signals' | 'tree' | 'warnings'>;

export function repositoryAnalysisScopeKey(projectRequested: boolean, projectId?: string): string {
  if (!projectRequested) return 'workspace';
  return projectId ? `project:${projectId}` : 'project:pending';
}

export function isRepositoryScopeRequestCurrent(
  currentScopeKey: string,
  requestScopeKey: string,
  currentRequestId: number,
  requestId: number,
): boolean {
  return currentScopeKey === requestScopeKey && currentRequestId === requestId;
}

const object = (value: unknown): UnknownRecord | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined;
const unsafeTextCharacter = /[\p{Cc}\p{Cf}]/u;
const safeString = (value: unknown, maximum: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  const unsafe = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint === 0xfffd || unsafeTextCharacter.test(character);
  });
  return normalized && normalized.length <= maximum && !unsafe ? normalized : undefined;
};
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function normalizeRepositoryStatus(payload: unknown): RepositoryStatus {
  const root = object(unwrapApiData(payload)) ?? {}; const scope = object(root.scope); const limits = object(root.limits);
  const dependencies = Array.isArray(root.dependencies) ? root.dependencies.slice(0, 20).flatMap((item) => {
    const value = object(item); const id = value ? safeString(value.id, 80) : undefined; const status = value ? safeString(value.status, 40) : undefined;
    return id && status ? [{ id, status, message: safeString(value?.message, 500) }] : [];
  }) : [];
  return {
    available: typeof root.available === 'boolean' ? root.available : undefined, canAnalyze: root.canAnalyze === true,
    scope: scope ? { type: safeString(scope.type, 40), projectId: safeString(scope.projectId, 64), projectStatus: safeString(scope.projectStatus, 40) } : undefined,
    dependencies, limits: limits ? { maxArchiveBytes: count(limits.maxArchiveBytes ?? limits.archiveBytes) } : undefined,
  };
}

function normalizeLanguages(value: unknown): RepositoryLanguage[] {
  return Array.isArray(value) ? value.slice(0, 100).flatMap((item) => {
    const entry = object(item); const name = entry ? safeString(entry.name, 40) : undefined; const files = entry ? count(entry.files) : undefined; const declaredBytes = entry ? count(entry.declaredBytes) : undefined;
    return name && files !== undefined && declaredBytes !== undefined ? [{ name, files, declaredBytes }] : [];
  }) : [];
}
function normalizeManifests(value: unknown): RepositoryManifest[] {
  return Array.isArray(value) ? value.slice(0, 20).flatMap((item) => {
    const entry = object(item); const path = entry ? safeString(entry.path, 512) : undefined; const packageManager = entry ? safeString(entry.packageManager, 40) : undefined; const dependencyCount = entry ? count(entry.dependencyCount) : undefined;
    if (!entry || !path || !packageManager || dependencyCount === undefined) return [];
    const scriptNames = Array.isArray(entry.scriptNames) ? entry.scriptNames.slice(0, 100).flatMap((name) => { const safe = safeString(name, 100); return safe ? [safe] : []; }) : [];
    return [{ path, packageName: safeString(entry.packageName, 214), packageManager, dependencyCount, scriptNames }];
  }) : [];
}
function normalizeDependencies(value: unknown): RepositoryDependency[] {
  const allowed = new Set(['runtime', 'development', 'peer', 'optional']);
  return Array.isArray(value) ? value.slice(0, 500).flatMap((item) => {
    const entry = object(item); const manifestPath = entry ? safeString(entry.manifestPath, 512) : undefined; const name = entry ? safeString(entry.name, 214) : undefined; const version = entry ? safeString(entry.version, 300) : undefined; const kind = entry ? safeString(entry.kind, 40) : undefined;
    return manifestPath && name && version && kind && allowed.has(kind) ? [{ manifestPath, name, version, kind }] : [];
  }) : [];
}
function normalizeFrameworks(value: unknown): RepositoryFramework[] {
  return Array.isArray(value) ? value.slice(0, 100).flatMap((item) => {
    const entry = object(item); const name = entry ? safeString(entry.name, 80) : undefined; const dependency = entry ? safeString(entry.dependency, 214) : undefined; const manifestPath = entry ? safeString(entry.manifestPath, 512) : undefined;
    return name && dependency && manifestPath ? [{ name, dependency, manifestPath }] : [];
  }) : [];
}
function normalizeSignals(value: unknown): RepositorySignal[] {
  const kinds = new Set(['tests', 'docker', 'compose', 'ci', 'kubernetes', 'security']);
  return Array.isArray(value) ? value.slice(0, 100).flatMap((item) => {
    const entry = object(item); const kind = entry ? safeString(entry.kind, 40) : undefined; const path = entry ? safeString(entry.path, 512) : undefined; const severity = entry ? safeString(entry.severity, 20) : undefined;
    return kind && kinds.has(kind) && path && (!severity || severity === 'info' || severity === 'warning') ? [{ kind, path, severity }] : [];
  }) : [];
}
function normalizeWarnings(value: unknown): RepositoryWarning[] {
  return Array.isArray(value) ? value.slice(0, 100).flatMap((item) => {
    const entry = object(item); const code = entry ? safeString(entry.code, 80) : undefined; const message = entry ? safeString(entry.message, 300) : undefined;
    return code && message ? [{ code, message, path: safeString(entry?.path, 512) }] : [];
  }) : [];
}
function normalizeTree(value: unknown): RepositoryTreeEntry[] {
  return Array.isArray(value) ? value.slice(0, 2000).flatMap((item) => {
    const entry = object(item); const path = entry ? safeString(entry.path, 512) : undefined; const type = entry?.type;
    return path && (type === 'file' || type === 'directory') ? [{ path, type, declaredBytes: count(entry?.declaredBytes), language: safeString(entry?.language, 40) }] : [];
  }) : [];
}

function normalizeRepositoryAnalysisSummaryRecord(payload: unknown): RepositoryAnalysisSummary | undefined {
  const envelope = object(unwrapApiData(payload)); const root = object(envelope?.analysis) ?? envelope; const source = object(root?.source); const summary = object(root?.summary);
  const id = root ? safeString(root.id ?? root._id, 64) : undefined; const name = root ? safeString(root.name, 200) : undefined;
  const originalName = source ? safeString(source.originalName, 255) : undefined; const compressedBytes = source ? count(source.compressedBytes) : undefined; const sha256 = source ? safeString(source.sha256, 64) : undefined;
  const fileCount = summary ? count(summary.fileCount) : undefined; const directoryCount = summary ? count(summary.directoryCount) : undefined; const declaredUncompressedBytes = summary ? count(summary.declaredUncompressedBytes) : undefined; const maxDepth = summary ? count(summary.maxDepth) : undefined; const packageManifestCount = summary ? count(summary.packageManifestCount) : undefined; const testFileCount = summary ? count(summary.testFileCount) : undefined;
  if (!root || !id || !name || root.status !== 'completed' || source?.kind !== 'zip' || !originalName || compressedBytes === undefined || !sha256 || !/^[a-f0-9]{64}$/i.test(sha256) || fileCount === undefined || directoryCount === undefined || declaredUncompressedBytes === undefined || maxDepth === undefined || packageManifestCount === undefined || testFileCount === undefined) return undefined;
  return {
    id, projectId: safeString(root.projectId, 64), name, status: 'completed', analyzerVersion: count(root.analyzerVersion),
    source: { kind: 'zip', originalName, mimeType: safeString(source.mimeType, 100), compressedBytes, sha256 },
    summary: { fileCount, directoryCount, declaredUncompressedBytes, maxDepth, packageManifestCount, testFileCount },
    createdAt: safeString(root.createdAt, 64), updatedAt: safeString(root.updatedAt, 64),
  };
}
export function normalizeRepositoryAnalysis(payload: unknown): RepositoryAnalysis | undefined {
  const envelope = object(unwrapApiData(payload)); const root = object(envelope?.analysis) ?? envelope;
  const summary = normalizeRepositoryAnalysisSummaryRecord(payload);
  if (!root || !summary || !Array.isArray(root.languages) || !Array.isArray(root.frameworks) || !Array.isArray(root.manifests)
    || !Array.isArray(root.dependencies) || !Array.isArray(root.signals) || !Array.isArray(root.tree) || !Array.isArray(root.warnings)) return undefined;
  return { ...summary, languages: normalizeLanguages(root.languages), frameworks: normalizeFrameworks(root.frameworks), manifests: normalizeManifests(root.manifests), dependencies: normalizeDependencies(root.dependencies), signals: normalizeSignals(root.signals), tree: normalizeTree(root.tree), warnings: normalizeWarnings(root.warnings) };
}
export function normalizeRepositoryAnalyses(payload: unknown): RepositoryAnalysisSummary[] {
  const root = object(unwrapApiData(payload));
  return root && Array.isArray(root.analyses) ? root.analyses.flatMap((analysis) => { const normalized = normalizeRepositoryAnalysisSummaryRecord(analysis); return normalized ? [normalized] : []; }) : [];
}
export function validateRepositoryArchive(file: Pick<File, 'name' | 'type' | 'size'>, maximumBytes = REPOSITORY_ARCHIVE_LIMIT_BYTES): string | undefined {
  if (!file.name.toLowerCase().endsWith('.zip')) return 'Choose a ZIP archive.';
  if (file.type && !['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(file.type)) return 'Choose a ZIP archive.';
  if (file.size === 0) return 'The ZIP archive is empty.';
  if (file.size > maximumBytes) return `The ZIP archive must be ${formatBytes(maximumBytes)} or smaller.`;
  return undefined;
}
export async function validateRepositoryZipSignature(file: Pick<File, 'slice'>): Promise<string | undefined> {
  const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const valid = bytes.length === 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));
  return valid ? undefined : 'The selected file does not have a valid ZIP signature.';
}
export function canCreateRepositoryAnalysis(projectStatus?: string, projectContextValid = true, backendCanAnalyze = false): boolean { return projectContextValid && projectStatus !== 'archived' && backendCanAnalyze; }
export function canDeleteRepositoryAnalysis(projectStatus?: string, projectContextValid = true): boolean { return projectContextValid && projectStatus !== 'archived'; }
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'Not reported'; if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB']; let amount = value; let index = -1; do { amount /= 1024; index += 1; } while (amount >= 1024 && index < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[index]}`;
}
