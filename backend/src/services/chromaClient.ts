import axios, { AxiosError, AxiosInstance } from 'axios';

export const CHROMA_DEFAULT_TENANT = 'default_tenant';
export const CHROMA_DEFAULT_DATABASE = 'default_database';
export const CHROMA_MAX_RECORDS = 256;
export const CHROMA_MAX_EMBEDDING_DIMENSION = 65_536;
export const CHROMA_MAX_DOCUMENT_LENGTH = 5_000;

const CHROMA_MAX_ID_LENGTH = 512;
const CHROMA_MAX_QUERY_RESULTS = 100;
const CHROMA_API_PREFIX = '/api/v1';
const CHROMA_MAX_HTTP_BYTES = 4 * 1024 * 1024;

export type ChromaPrimitive = string | number | boolean;
export type ChromaMetadata = Record<string, ChromaPrimitive>;
export type ChromaWhere = Record<string, unknown>;

export interface ChromaCollection {
  id: string;
  name: string;
  metadata: ChromaMetadata | null;
  tenant?: string;
  database?: string;
}

export interface ChromaUpsertRecord {
  id: string;
  embedding: number[];
  document: string;
  metadata?: ChromaMetadata;
}

export interface ChromaQueryRequest {
  embedding: number[];
  nResults: number;
  where?: ChromaWhere;
}

export interface ChromaQueryResult {
  ids: string[];
  documents: Array<string | null>;
  metadatas: Array<ChromaMetadata | null>;
  distances: number[];
}

export interface ChromaClientConfig {
  baseUrl: string;
  tenant?: string;
  database?: string;
  timeoutMs?: number;
}

export type ChromaClientErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNAVAILABLE'
  | 'REQUEST_TIMEOUT'
  | 'REQUEST_ABORTED'
  | 'NOT_FOUND'
  | 'REQUEST_REJECTED'
  | 'INVALID_RESPONSE';

export class ChromaClientError extends Error {
  constructor(
    message: string,
    readonly code: ChromaClientErrorCode,
    readonly retryable: boolean = false
  ) {
    super(message);
    this.name = 'ChromaClientError';
  }
}

function invalidArgument(message: string): never {
  throw new ChromaClientError(message, 'INVALID_ARGUMENT');
}

function invalidResponse(message: string): never {
  throw new ChromaClientError(message, 'INVALID_RESPONSE');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function validateCollectionName(name: string): void {
  if (
    typeof name !== 'string'
    || name.length < 3
    || name.length > 63
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$/.test(name)
    || name.includes('..')
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name)
  ) {
    invalidArgument('Chroma collection names must satisfy the pinned server naming rules.');
  }
}

function validateNamespace(value: string, label: string): void {
  if (!value || value.length > 128 || containsControlCharacter(value) || value.includes('/') || value.includes('\\')) {
    invalidArgument(`${label} is invalid.`);
  }
}

function validateCollectionId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    invalidArgument('Chroma collection ID must be a UUID.');
  }
}

function validateRecordId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > CHROMA_MAX_ID_LENGTH
    || containsControlCharacter(value)
  ) {
    invalidArgument(`Record IDs must contain 1-${CHROMA_MAX_ID_LENGTH} safe characters.`);
  }
}

function validateEmbedding(value: unknown): asserts value is number[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > CHROMA_MAX_EMBEDDING_DIMENSION
    || !value.every((item) => typeof item === 'number' && Number.isFinite(item))
  ) {
    invalidArgument(`Embeddings must contain 1-${CHROMA_MAX_EMBEDDING_DIMENSION} finite numbers.`);
  }
}

function validateMetadata(value: unknown, allowEmpty = false): asserts value is ChromaMetadata {
  if (!isPlainObject(value) || (!allowEmpty && Object.keys(value).length === 0)) {
    invalidArgument('Chroma metadata must be a non-empty plain object.');
  }

  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 128 || key === 'chroma:document') {
      invalidArgument('Chroma metadata contains an invalid or reserved key.');
    }
    if (
      !['string', 'number', 'boolean'].includes(typeof item)
      || (typeof item === 'number' && !Number.isFinite(item))
    ) {
      invalidArgument('Chroma metadata values must be finite primitive values.');
    }
  }
}

function validateWhere(value: unknown, requireSelector: boolean): asserts value is ChromaWhere {
  if (!isPlainObject(value) || (requireSelector && Object.keys(value).length === 0)) {
    invalidArgument('A non-empty Chroma where selector is required.');
  }
  if (!requireSelector && Object.keys(value).length === 0) return;
  validateWhereValue(value, 0);
}

function validateWhereValue(value: unknown, depth: number): void {
  if (depth > 8) invalidArgument('Chroma where selector nesting is too deep.');
  if (typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidArgument('Chroma where selector numbers must be finite.');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > CHROMA_MAX_RECORDS) {
      invalidArgument('Chroma where selector arrays must be non-empty and bounded.');
    }
    value.forEach((item) => validateWhereValue(item, depth + 1));
    return;
  }
  if (!isPlainObject(value)) invalidArgument('Chroma where selector contains an unsupported value.');
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > CHROMA_MAX_RECORDS) {
    invalidArgument('Chroma where selector objects must be non-empty and bounded.');
  }
  for (const [key, item] of entries) {
    if (!key || key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key)) {
      invalidArgument('Chroma where selector contains an invalid key.');
    }
    validateWhereValue(item, depth + 1);
  }
}

function normalizeBaseUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      return invalidArgument('CHROMA_URL must be a credential-free HTTP(S) URL.');
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return invalidArgument('CHROMA_URL must be a valid HTTP(S) URL.');
  }
}

function normalizeCollection(value: unknown): ChromaCollection {
  if (!isPlainObject(value)) invalidResponse('Chroma returned an invalid collection response.');
  const { id, name, metadata, tenant, database } = value;
  if (
    typeof id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    || typeof name !== 'string'
    || !Object.prototype.hasOwnProperty.call(value, 'metadata')
  ) {
    invalidResponse('Chroma returned an invalid collection response.');
  }
  if (metadata !== null) {
    try {
      validateMetadata(metadata);
    } catch {
      invalidResponse('Chroma returned invalid collection metadata.');
    }
  }
  if (tenant !== undefined && typeof tenant !== 'string') {
    invalidResponse('Chroma returned an invalid collection tenant.');
  }
  if (database !== undefined && typeof database !== 'string') {
    invalidResponse('Chroma returned an invalid collection database.');
  }
  return {
    id,
    name,
    metadata: metadata as ChromaMetadata | null,
    ...(typeof tenant === 'string' ? { tenant } : {}),
    ...(typeof database === 'string' ? { database } : {}),
  };
}

function normalizeResponseMetadata(value: unknown): ChromaMetadata | null {
  if (value === null) return null;
  try {
    validateMetadata(value);
    return value;
  } catch {
    return invalidResponse('Chroma returned invalid result metadata.');
  }
}

export class ChromaClient {
  private readonly client: AxiosInstance;
  private readonly tenant: string;
  private readonly database: string;

  constructor(config: ChromaClientConfig, client?: AxiosInstance) {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const timeoutMs = config.timeoutMs ?? 5_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      invalidArgument('Chroma timeout must be between 100 and 120000 milliseconds.');
    }
    this.tenant = config.tenant ?? CHROMA_DEFAULT_TENANT;
    this.database = config.database ?? CHROMA_DEFAULT_DATABASE;
    validateNamespace(this.tenant, 'Chroma tenant');
    validateNamespace(this.database, 'Chroma database');
    this.client = client ?? axios.create({
      baseURL: baseUrl,
      timeout: timeoutMs,
      maxContentLength: CHROMA_MAX_HTTP_BYTES,
      maxBodyLength: CHROMA_MAX_HTTP_BYTES,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async healthCheck(): Promise<boolean> {
    return this.run(async () => {
      const response = await this.client.get(`${CHROMA_API_PREFIX}/heartbeat`);
      const heartbeat = response.data?.['nanosecond heartbeat'];
      if (typeof heartbeat !== 'number' || !Number.isFinite(heartbeat) || heartbeat <= 0) {
        invalidResponse('Chroma returned an invalid heartbeat response.');
      }
      return true;
    });
  }

  async getMaxBatchSize(): Promise<number> {
    return this.run(async () => {
      const response = await this.client.get(`${CHROMA_API_PREFIX}/pre-flight-checks`);
      const maxBatchSize = response.data?.max_batch_size;
      if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize <= 0) {
        invalidResponse('Chroma returned an invalid maximum batch size.');
      }
      return maxBatchSize as number;
    });
  }

  async getOrCreateCollection(name: string, metadata?: ChromaMetadata): Promise<ChromaCollection> {
    validateCollectionName(name);
    if (metadata !== undefined) validateMetadata(metadata);
    return this.run(async () => {
      const response = await this.client.post(
        `${CHROMA_API_PREFIX}/collections`,
        { name, metadata: metadata ?? null, get_or_create: true },
        { params: this.namespaceParams() }
      );
      return normalizeCollection(response.data);
    });
  }

  async getCollection(name: string): Promise<ChromaCollection> {
    validateCollectionName(name);
    return this.run(async () => {
      const response = await this.client.get(
        `${CHROMA_API_PREFIX}/collections/${encodeURIComponent(name)}`,
        { params: this.namespaceParams() }
      );
      return normalizeCollection(response.data);
    });
  }

  async upsert(collectionId: string, records: ChromaUpsertRecord[]): Promise<void> {
    validateCollectionId(collectionId);
    if (!Array.isArray(records) || records.length === 0 || records.length > CHROMA_MAX_RECORDS) {
      invalidArgument(`Chroma upserts must contain 1-${CHROMA_MAX_RECORDS} records.`);
    }

    let dimension: number | undefined;
    const seenIds = new Set<string>();
    for (const record of records) {
      if (!isPlainObject(record)) invalidArgument('Each Chroma upsert record must be an object.');
      validateRecordId(record.id);
      if (seenIds.has(record.id)) invalidArgument('Chroma upsert record IDs must be unique.');
      seenIds.add(record.id);
      validateEmbedding(record.embedding);
      dimension ??= record.embedding.length;
      if (record.embedding.length !== dimension) {
        invalidArgument('All embeddings in a Chroma upsert must have the same dimension.');
      }
      if (typeof record.document !== 'string' || record.document.length > CHROMA_MAX_DOCUMENT_LENGTH) {
        invalidArgument(`Chroma documents must be at most ${CHROMA_MAX_DOCUMENT_LENGTH} characters.`);
      }
      if (record.metadata !== undefined) validateMetadata(record.metadata);
    }

    const hasMetadata = records.some((record) => record.metadata !== undefined);
    await this.run(async () => {
      await this.client.post(
        `${CHROMA_API_PREFIX}/collections/${encodeURIComponent(collectionId)}/upsert`,
        {
          ids: records.map((record) => record.id),
          embeddings: records.map((record) => [...record.embedding]),
          metadatas: hasMetadata ? records.map((record) => record.metadata ?? null) : null,
          documents: records.map((record) => record.document),
          uris: null,
        }
      );
    });
  }

  async query(collectionId: string, request: ChromaQueryRequest): Promise<ChromaQueryResult> {
    validateCollectionId(collectionId);
    if (!isPlainObject(request)) invalidArgument('A Chroma query request is required.');
    validateEmbedding(request.embedding);
    if (!Number.isInteger(request.nResults) || request.nResults < 1 || request.nResults > CHROMA_MAX_QUERY_RESULTS) {
      invalidArgument(`Chroma nResults must be between 1 and ${CHROMA_MAX_QUERY_RESULTS}.`);
    }
    const where = request.where ?? {};
    if (request.where !== undefined) validateWhere(request.where, false);

    return this.run(async () => {
      const response = await this.client.post(
        `${CHROMA_API_PREFIX}/collections/${encodeURIComponent(collectionId)}/query`,
        {
          query_embeddings: [[...request.embedding]],
          n_results: request.nResults,
          where,
          where_document: {},
          include: ['documents', 'metadatas', 'distances'],
        }
      );
      return this.normalizeSingleQuery(response.data, request.nResults);
    });
  }

  async deleteWhere(collectionId: string, where: ChromaWhere): Promise<void> {
    validateCollectionId(collectionId);
    validateWhere(where, true);
    return this.run(async () => {
      const response = await this.client.post(
        `${CHROMA_API_PREFIX}/collections/${encodeURIComponent(collectionId)}/delete`,
        { ids: null, where, where_document: null }
      );
      // The 0.4.24 REST implementation returns deleted IDs, while some compatible
      // clients/proxies normalize this write response to null. KFive does not rely
      // on either representation.
      if (response.data !== null && response.data !== undefined) {
        if (!Array.isArray(response.data)) invalidResponse('Chroma returned an invalid delete response.');
        response.data.forEach((id: unknown) => {
          try {
            validateRecordId(id);
          } catch {
            invalidResponse('Chroma returned an invalid deleted record ID.');
          }
        });
      }
    });
  }

  private normalizeSingleQuery(value: unknown, requestedResults: number): ChromaQueryResult {
    if (!isPlainObject(value)) invalidResponse('Chroma returned an invalid query response.');
    const ids = this.firstNestedArray(value.ids, 'ids');
    const documents = this.firstNestedArray(value.documents, 'documents');
    const metadatas = this.firstNestedArray(value.metadatas, 'metadatas');
    const distances = this.firstNestedArray(value.distances, 'distances');
    if (documents.length !== ids.length || metadatas.length !== ids.length || distances.length !== ids.length) {
      invalidResponse('Chroma returned query result columns with different lengths.');
    }
    if (ids.length > requestedResults || ids.length > CHROMA_MAX_QUERY_RESULTS) {
      invalidResponse('Chroma returned more query results than requested.');
    }

    ids.forEach((id) => {
      if (typeof id !== 'string') invalidResponse('Chroma returned an invalid result ID.');
    });
    documents.forEach((document) => {
      if (
        document !== null
        && (typeof document !== 'string' || document.length > CHROMA_MAX_DOCUMENT_LENGTH)
      ) {
        invalidResponse('Chroma returned an invalid result document.');
      }
    });
    const normalizedMetadatas = metadatas.map(normalizeResponseMetadata);
    distances.forEach((distance) => {
      if (typeof distance !== 'number' || !Number.isFinite(distance)) {
        invalidResponse('Chroma returned an invalid result distance.');
      }
    });

    return {
      ids: ids as string[],
      documents: documents as Array<string | null>,
      metadatas: normalizedMetadatas,
      distances: distances as number[],
    };
  }

  private firstNestedArray(value: unknown, field: string): unknown[] {
    if (!Array.isArray(value) || value.length !== 1 || !Array.isArray(value[0])) {
      invalidResponse(`Chroma returned an invalid nested ${field} result.`);
    }
    return value[0] as unknown[];
  }

  private namespaceParams(): { tenant: string; database: string } {
    return { tenant: this.tenant, database: this.database };
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private normalizeError(error: unknown): ChromaClientError {
    if (error instanceof ChromaClientError) return error;
    const axiosError = error as AxiosError;
    if (axios.isCancel(error) || axiosError?.code === 'ERR_CANCELED') {
      return new ChromaClientError('The Chroma request was cancelled.', 'REQUEST_ABORTED');
    }
    if (axiosError?.code === 'ECONNABORTED' || axiosError?.code === 'ETIMEDOUT') {
      return new ChromaClientError('The Chroma request timed out.', 'REQUEST_TIMEOUT', true);
    }
    if (axios.isAxiosError(error)) {
      if (!axiosError.response) {
        return new ChromaClientError('The configured Chroma service is unavailable.', 'UNAVAILABLE', true);
      }
      if (axiosError.response.status === 404) {
        return new ChromaClientError('The requested Chroma resource was not found.', 'NOT_FOUND');
      }
      return new ChromaClientError('The Chroma service rejected the request.', 'REQUEST_REJECTED');
    }
    return new ChromaClientError('The configured Chroma service is unavailable.', 'UNAVAILABLE', true);
  }
}
