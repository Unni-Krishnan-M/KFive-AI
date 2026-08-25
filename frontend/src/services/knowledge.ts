import { unwrapApiData } from './runtimeSettings';

type UnknownRecord = Record<string, unknown>;

export type KnowledgeDependencyStatus = 'available' | 'degraded' | 'unavailable' | 'not-configured' | 'disabled' | 'unknown';
export type KnowledgeSourceStatus = 'queued' | 'indexing' | 'ready' | 'failed' | 'unknown';

export interface KnowledgeDependency {
  id: string;
  status: KnowledgeDependencyStatus;
  message?: string;
}

export interface KnowledgeStatus {
  available?: boolean;
  canIngest: boolean;
  canQuery: boolean;
  scope?: string;
  dependencies: KnowledgeDependency[];
  readySourceCount: number;
  capabilities: Record<string, boolean>;
}

export interface KnowledgeSource {
  id: string;
  projectId?: string;
  name: string;
  mediaType: string;
  status: KnowledgeSourceStatus;
  characterCount?: number;
  chunkCount?: number;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  errorMessage?: string;
  errorCode?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface KnowledgeReference {
  referenceId?: string;
  marker?: string;
  sourceId: string;
  sourceName: string;
  chunkId?: string;
  mediaType?: string;
  projectId?: string;
  chunkIndex: number;
  excerpt: string;
  distance?: number;
}

export interface KnowledgeQueryResult {
  answer: string;
  provider: string;
  model: string;
  references: KnowledgeReference[];
}

export const KNOWLEDGE_FILE_LIMIT_BYTES = 64 * 1024;
export const KNOWLEDGE_REFERENCE_LIMIT = 50;
export const KNOWLEDGE_EXCERPT_LIMIT = 4000;

const record = (value: unknown): UnknownRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const bool = (value: unknown): boolean => value === true;
const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function dependencyStatus(value: unknown): KnowledgeDependencyStatus {
  const normalized = text(value)?.toLowerCase().replace(/_/g, '-');
  if (normalized === 'available' || normalized === 'ready' || normalized === 'healthy' || normalized === 'online') return 'available';
  if (normalized === 'degraded') return 'degraded';
  if (normalized === 'unavailable' || normalized === 'offline' || normalized === 'failed') return 'unavailable';
  if (normalized === 'not-configured' || normalized === 'unconfigured') return 'not-configured';
  if (normalized === 'disabled') return 'disabled';
  return 'unknown';
}

function normalizeDependency(id: string, value: unknown): KnowledgeDependency | undefined {
  const item = record(value);
  if (!item) return undefined;
  let status = dependencyStatus(item.status);
  if (status === 'unknown') {
    if (item.configured === false) status = 'not-configured';
    else if (item.embeddingsSupported === false || item.available === false) status = 'unavailable';
    else if (item.available === true || item.configured === true) status = 'available';
  }
  return { id, status, message: text(item.message ?? item.code) };
}

function sourceStatus(value: unknown): KnowledgeSourceStatus {
  const normalized = text(value)?.toLowerCase().replace(/_/g, '-');
  if (normalized === 'queued' || normalized === 'pending') return 'queued';
  if (normalized === 'indexing' || normalized === 'processing') return 'indexing';
  if (normalized === 'ready' || normalized === 'completed') return 'ready';
  if (normalized === 'failed' || normalized === 'error') return 'failed';
  return 'unknown';
}

export function normalizeKnowledgeStatus(payload: unknown): KnowledgeStatus {
  const root = record(unwrapApiData(payload)) ?? {};
  const scopeValue = record(root.scope);
  const dependencyValue = root.dependencies;
  const dependencies = Array.isArray(dependencyValue) ? dependencyValue.flatMap((item) => {
    const value = record(item);
    const id = value ? text(value.id) : undefined;
    if (!value || !id) return [];
    return [{ id, status: dependencyStatus(value.status), message: text(value.message ?? value.code) }];
  }) : Object.entries(record(dependencyValue) ?? {}).flatMap(([id, value]) => {
    const normalized = normalizeDependency(id, value);
    return normalized ? [normalized] : [];
  });
  const rawCapabilities = record(root.capabilities) ?? {};
  const capabilities = Object.fromEntries(
    Object.entries(rawCapabilities).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
  );

  return {
    available: typeof root.available === 'boolean' ? root.available : undefined,
    canIngest: bool(root.canIngest),
    canQuery: bool(root.canQuery),
    scope: text(root.scope) ?? text(scopeValue?.type),
    dependencies,
    readySourceCount: nonNegativeInteger(root.readySourceCount) ?? 0,
    capabilities,
  };
}

export function normalizeKnowledgeSources(payload: unknown): KnowledgeSource[] {
  const root = record(unwrapApiData(payload));
  if (!root || !Array.isArray(root.sources)) return [];

  return root.sources.flatMap((item) => {
    const value = record(item);
    const id = value ? text(value.id ?? value._id) : undefined;
    const name = value ? text(value.name) : undefined;
    const mediaType = value ? text(value.mediaType) : undefined;
    if (!value || !id || !name || !mediaType) return [];
    const embedding = record(value.embedding);
    return [{
      id,
      projectId: text(value.projectId),
      name,
      mediaType,
      status: sourceStatus(value.status),
      characterCount: nonNegativeInteger(value.characterCount),
      chunkCount: nonNegativeInteger(value.chunkCount),
      embeddingProvider: text(value.embeddingProvider ?? embedding?.provider),
      embeddingModel: text(value.embeddingModel ?? embedding?.model),
      embeddingDimension: nonNegativeInteger(value.embeddingDimension ?? embedding?.dimension),
      errorMessage: text(value.errorMessage),
      errorCode: text(value.errorCode),
      createdAt: text(value.createdAt),
      updatedAt: text(value.updatedAt),
    }];
  });
}

export function normalizeKnowledgeQuery(payload: unknown): KnowledgeQueryResult | undefined {
  const root = record(unwrapApiData(payload));
  const answer = root ? text(root.answer) : undefined;
  const provider = root ? text(root.provider) : undefined;
  const model = root ? text(root.model) : undefined;
  if (!root || !answer || !provider || !model) return undefined;

  const references = Array.isArray(root.references) ? root.references.slice(0, KNOWLEDGE_REFERENCE_LIMIT).flatMap((item) => {
    const value = record(item);
    const referenceId = value ? text(value.referenceId) : undefined;
    const marker = value ? text(value.marker) : undefined;
    const sourceId = value ? text(value.sourceId) : undefined;
    const sourceName = value ? text(value.sourceName) : undefined;
    const chunkId = value ? text(value.chunkId) : undefined;
    const chunkIndex = value ? nonNegativeInteger(value.chunkIndex) : undefined;
    const excerpt = value ? text(value.excerpt ?? value.snippet) : undefined;
    if (!value || (!referenceId && !marker) || !sourceId || !sourceName || chunkIndex === undefined || !excerpt) return [];
    return [{
      referenceId,
      marker,
      sourceId,
      sourceName,
      chunkId,
      mediaType: text(value.mediaType),
      projectId: text(value.projectId),
      chunkIndex,
      excerpt: excerpt.slice(0, KNOWLEDGE_EXCERPT_LIMIT),
      distance: finiteNumber(value.distance),
    }];
  }) : [];

  return { answer, provider, model, references };
}

export function knowledgeProjectPayload<T extends object>(payload: T, projectId?: string): T & { projectId?: string } {
  return projectId ? { ...payload, projectId } : payload;
}

export function canMutateKnowledge(projectStatus?: string, projectContextValid = true): boolean {
  return projectContextValid && projectStatus !== 'archived';
}

export function validateKnowledgeFile(file: Pick<File, 'name' | 'type' | 'size'>): string | undefined {
  const extension = file.name.toLowerCase().split('.').pop();
  if (!['txt', 'md', 'markdown'].includes(extension ?? '')) return 'Choose a TXT or Markdown file.';
  if (file.type && !['text/plain', 'text/markdown'].includes(file.type)) return 'Choose a TXT or Markdown file.';
  if (file.size > KNOWLEDGE_FILE_LIMIT_BYTES) return 'The source must be 64 KiB or smaller.';
  if (file.size === 0) return 'The source file is empty.';
  return undefined;
}

export function sourceMediaType(fileName: string): 'text/plain' | 'text/markdown' {
  return /\.(md|markdown)$/i.test(fileName) ? 'text/markdown' : 'text/plain';
}

export function nextKnowledgeRefreshDelay(attempt: number): number | undefined {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 6) return undefined;
  return Math.min(1000 * (2 ** (attempt - 1)), 8000);
}
