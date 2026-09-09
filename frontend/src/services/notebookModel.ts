import { unwrapApiData } from './runtimeSettings';

type UnknownRecord = Record<string, unknown>;

export const NOTEBOOK_LIMITS = {
  titleBytes: 120,
  cells: 32,
  sourceBytesPerCell: 65_536,
  sourceBytesPerNotebook: 262_144,
  tagsPerCell: 16,
  tagCharacters: 64,
  cellTimeoutSeconds: 30,
  pageSize: 25,
  maxPages: 10,
} as const;

export type NotebookCellType = 'code' | 'markdown';
export interface NotebookCell { id: string; type: NotebookCellType; source: string; tags: string[] }
export interface NotebookView {
  id: string;
  projectId?: string;
  title: string;
  cells: NotebookCell[];
  cellTimeoutSeconds: number;
  revision: number;
  createdAt?: string;
  updatedAt?: string;
}
export interface NotebookPage {
  notebooks: NotebookView[];
  pagination: { page: number; pageSize: 25; total: number; totalPages: number; maxPages: 10 };
}
export interface NotebookStatus {
  editing: { available: boolean; persistent: boolean };
  execution: {
    enabled: boolean;
    available: boolean;
    queueDurable: boolean;
    workerAvailable: boolean;
    isolationVerified: boolean;
    message: string;
  };
  limits: {
    cells: 32;
    sourceBytesPerCell: 65_536;
    sourceBytesPerNotebook: 262_144;
    cellTimeoutSeconds: 30;
  };
}
export interface NotebookDraft {
  title: string;
  cells: NotebookCell[];
  cellTimeoutSeconds: number;
}
export interface NotebookCreatePayload extends NotebookDraft { projectId?: string }
export interface NotebookUpdatePayload extends NotebookDraft { expectedRevision: number }
export type NotebookRunStatus = 'queued' | 'running' | 'verifying' | 'cancel-requested' | 'succeeded' | 'failed'
  | 'cancelled' | 'timed_out' | 'resource_exceeded' | 'interrupted';
export type NotebookOutput =
  | { outputType: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { outputType: 'error'; traceback: string[] }
  | { outputType: 'display'; executionCount?: number; text?: string; json?: unknown; png?: string; jpeg?: string };
export interface ExecutedNotebookCell extends NotebookCell { executionCount?: number; outputs: NotebookOutput[] }
export interface NotebookRunView {
  id: string;
  notebookId: string;
  projectId?: string;
  notebookRevision: number;
  snapshotSha256: string;
  status: NotebookRunStatus;
  revision: number;
  metrics: Array<{ name: string; value: number; step?: number }>;
  artifacts: Array<{ index: number; path: string; kind: 'text' | 'json' | 'png' | 'jpeg'; mimeType: string; bytes: number; sha256: string }>;
  result?: { durationMs?: number; runtimeImageId?: string; verifierImageId?: string };
  error?: { code?: string; message?: string; cellIndex?: number };
  timeline: Array<{ revision: number; sequence: number; type: string; timestamp: string; code?: string }>;
  queuedAt: string;
  startedAt?: string;
  verificationStartedAt?: string;
  cancelRequestedAt?: string;
  completedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  executedNotebook?: { cells: ExecutedNotebookCell[] };
  snapshot?: { cells: NotebookCell[]; cellTimeoutSeconds: number };
}
export interface NotebookRunPage {
  runs: NotebookRunView[];
  pagination: { page: number; pageSize: 25; total: number; totalPages: number; maxPages: 10 };
}

const object = (value: unknown): UnknownRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined;
const exactKeys = (value: UnknownRecord, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));
const objectId = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-f\d]{24}$/i.test(value) ? value : undefined;
const integer = (value: unknown, minimum: number, maximum: number): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
const dateText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : undefined;
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const unsafeText = (value: string): boolean => [...value].some((character) => {
  const point = character.codePointAt(0) ?? 0;
  return point === 0xfffd || /\p{Cf}/u.test(character)
    || (point < 32 && point !== 9 && point !== 10) || (point >= 127 && point <= 159);
});

function normalizeTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = value.normalize('NFC').trim();
  return result && utf8Bytes(result) <= NOTEBOOK_LIMITS.titleBytes && !unsafeText(result) ? result : undefined;
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > NOTEBOOK_LIMITS.tagsPerCell) return undefined;
  const tags = value.filter((tag): tag is string => typeof tag === 'string');
  if (tags.length !== value.length || new Set(tags).size !== tags.length
    || tags.some((tag) => !/^[A-Za-z0-9_.:-]{1,64}$/.test(tag))) return undefined;
  return tags;
}

function normalizeCells(value: unknown): NotebookCell[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > NOTEBOOK_LIMITS.cells) return undefined;
  const cells: NotebookCell[] = [];
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const item of value) {
    const cell = object(item);
    if (!cell || !exactKeys(cell, ['id', 'type', 'source', 'tags'])
      || typeof cell.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(cell.id) || ids.has(cell.id)
      || (cell.type !== 'code' && cell.type !== 'markdown') || typeof cell.source !== 'string'
      || unsafeText(cell.source)) return undefined;
    const source = cell.source.normalize('NFC');
    const bytes = utf8Bytes(source);
    totalBytes += bytes;
    const tags = normalizeTags(cell.tags);
    if (!tags || bytes > NOTEBOOK_LIMITS.sourceBytesPerCell || totalBytes > NOTEBOOK_LIMITS.sourceBytesPerNotebook) return undefined;
    ids.add(cell.id);
    cells.push({ id: cell.id, type: cell.type, source, tags });
  }
  return cells;
}

function normalizeNotebookRecord(payload: unknown, expectedProjectId?: string | null): NotebookView | undefined {
  const envelope = object(unwrapApiData(payload));
  const root = object(envelope?.notebook) ?? envelope;
  if (!root || !exactKeys(root, ['id', 'projectId', 'title', 'cells', 'cellTimeoutSeconds', 'revision', 'createdAt', 'updatedAt'])) return undefined;
  const id = objectId(root.id);
  const projectId = root.projectId === undefined ? undefined : objectId(root.projectId);
  const title = normalizeTitle(root.title);
  const cells = normalizeCells(root.cells);
  const cellTimeoutSeconds = integer(root.cellTimeoutSeconds, 1, NOTEBOOK_LIMITS.cellTimeoutSeconds);
  const revision = integer(root.revision, 1, 999_999);
  const createdAt = root.createdAt === undefined ? undefined : dateText(root.createdAt);
  const updatedAt = root.updatedAt === undefined ? undefined : dateText(root.updatedAt);
  if (!id || (root.projectId !== undefined && !projectId) || !title || !cells || cellTimeoutSeconds === undefined
    || revision === undefined || (root.createdAt !== undefined && !createdAt) || (root.updatedAt !== undefined && !updatedAt)) return undefined;
  if ((expectedProjectId === null && projectId !== undefined)
    || (typeof expectedProjectId === 'string' && projectId !== expectedProjectId)) return undefined;
  return { id, projectId, title, cells, cellTimeoutSeconds, revision, createdAt, updatedAt };
}

export const normalizeNotebook = (payload: unknown, expectedProjectId?: string | null): NotebookView | undefined =>
  normalizeNotebookRecord(payload, expectedProjectId);

export function normalizeNotebookPage(payload: unknown, expectedProjectId?: string | null): NotebookPage | undefined {
  const root = object(unwrapApiData(payload));
  const pagination = object(root?.pagination);
  if (!root || !pagination || !exactKeys(root, ['notebooks', 'pagination'])
    || !exactKeys(pagination, ['page', 'pageSize', 'total', 'totalPages', 'maxPages']) || !Array.isArray(root.notebooks)) return undefined;
  const page = integer(pagination.page, 1, NOTEBOOK_LIMITS.maxPages);
  const total = integer(pagination.total, 0, NOTEBOOK_LIMITS.pageSize * NOTEBOOK_LIMITS.maxPages);
  const totalPages = integer(pagination.totalPages, 1, NOTEBOOK_LIMITS.maxPages);
  if (page === undefined || total === undefined || totalPages === undefined || pagination.pageSize !== 25 || pagination.maxPages !== 10
    || totalPages !== Math.max(1, Math.min(10, Math.ceil(total / 25))) || page > totalPages || root.notebooks.length > 25) return undefined;
  const notebooks = root.notebooks.map((item) => normalizeNotebookRecord(item, expectedProjectId));
  if (notebooks.some((item) => !item) || new Set(notebooks.map((item) => item!.id)).size !== notebooks.length) return undefined;
  return { notebooks: notebooks as NotebookView[], pagination: { page, pageSize: 25, total, totalPages, maxPages: 10 } };
}

export function normalizeNotebookStatus(payload: unknown): NotebookStatus | undefined {
  const root = object(unwrapApiData(payload));
  const editing = object(root?.editing); const execution = object(root?.execution); const limits = object(root?.limits);
  if (!root || !editing || !execution || !limits || !exactKeys(root, ['editing', 'execution', 'limits'])
    || !exactKeys(editing, ['available', 'persistent'])
    || !exactKeys(execution, ['enabled', 'available', 'queueDurable', 'workerAvailable', 'isolationVerified', 'message'])
    || !exactKeys(limits, ['cells', 'sourceBytesPerCell', 'sourceBytesPerNotebook', 'cellTimeoutSeconds'])
    || typeof editing.available !== 'boolean' || typeof editing.persistent !== 'boolean'
    || editing.available !== editing.persistent
    || typeof execution.enabled !== 'boolean' || typeof execution.available !== 'boolean'
    || typeof execution.queueDurable !== 'boolean' || typeof execution.workerAvailable !== 'boolean'
    || typeof execution.isolationVerified !== 'boolean' || typeof execution.message !== 'string'
    || !execution.message.trim() || unsafeText(execution.message) || utf8Bytes(execution.message) > 1_000
    || limits.cells !== 32 || limits.sourceBytesPerCell !== 65_536 || limits.sourceBytesPerNotebook !== 262_144
    || limits.cellTimeoutSeconds !== 30) return undefined;
  if (execution.available && (!execution.enabled || !execution.queueDurable || !execution.workerAvailable || !execution.isolationVerified)) return undefined;
  return {
    editing: { available: editing.available, persistent: editing.persistent },
    execution: {
      enabled: execution.enabled, available: execution.available, queueDurable: execution.queueDurable,
      workerAvailable: execution.workerAvailable, isolationVerified: execution.isolationVerified,
      message: execution.message.normalize('NFC').trim(),
    },
    limits: { cells: 32, sourceBytesPerCell: 65_536, sourceBytesPerNotebook: 262_144, cellTimeoutSeconds: 30 },
  };
}

const runStatuses = new Set<NotebookRunStatus>(['queued', 'running', 'verifying', 'cancel-requested', 'succeeded', 'failed',
  'cancelled', 'timed_out', 'resource_exceeded', 'interrupted']);
const activeRunStatuses = new Set<NotebookRunStatus>(['queued', 'running', 'verifying', 'cancel-requested']);
const sha256 = (value: unknown): string | undefined => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;

function boundedJson(value: unknown, depth = 0, state = { nodes: 0 }): unknown | undefined {
  state.nodes += 1;
  if (state.nodes > 10_000 || depth > 16) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return utf8Bytes(value) <= 65_536 && !unsafeText(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items = value.map((item) => boundedJson(item, depth + 1, state));
    return items.some((item, index) => item === undefined && value[index] !== undefined) ? undefined : items;
  }
  const record = object(value);
  if (!record || Object.keys(record).length > 1_000) return undefined;
  const result: UnknownRecord = {};
  for (const [key, item] of Object.entries(record)) {
    if (utf8Bytes(key) > 1_024 || unsafeText(key)) return undefined;
    const normalized = boundedJson(item, depth + 1, state);
    if (normalized === undefined && item !== undefined) return undefined;
    result[key] = normalized;
  }
  return result;
}

function normalizeOutput(value: unknown): NotebookOutput | undefined {
  const output = object(value);
  if (!output || typeof output.output_type !== 'string') return undefined;
  if (output.output_type === 'stream') {
    if (!exactKeys(output, ['output_type', 'name', 'text']) || (output.name !== 'stdout' && output.name !== 'stderr')
      || typeof output.text !== 'string' || unsafeText(output.text) || utf8Bytes(output.text) > 524_288) return undefined;
    return { outputType: 'stream', name: output.name, text: output.text };
  }
  if (output.output_type === 'error') {
    if (!exactKeys(output, ['output_type', 'ename', 'evalue', 'traceback']) || output.ename !== 'CellExecutionError'
      || output.evalue !== 'Notebook cell execution failed.' || !Array.isArray(output.traceback) || output.traceback.length > 64
      || output.traceback.some((line) => typeof line !== 'string' || unsafeText(line) || utf8Bytes(line) > 65_536)) return undefined;
    return { outputType: 'error', traceback: output.traceback as string[] };
  }
  if (output.output_type !== 'display_data' && output.output_type !== 'execute_result') return undefined;
  const expected = output.output_type === 'execute_result' ? ['output_type', 'data', 'metadata', 'execution_count'] : ['output_type', 'data', 'metadata'];
  const metadata = object(output.metadata); const data = object(output.data);
  if (!exactKeys(output, expected) || !metadata || Object.keys(metadata).length !== 0 || !data
    || !exactKeys(data, ['text/plain', 'application/json', 'image/png', 'image/jpeg'])) return undefined;
  const executionCount = output.output_type === 'execute_result'
    ? (output.execution_count === null ? undefined : integer(output.execution_count, 0, Number.MAX_SAFE_INTEGER)) : undefined;
  if (output.output_type === 'execute_result' && output.execution_count !== null && executionCount === undefined) return undefined;
  const text = data['text/plain']; const json = data['application/json']; const png = data['image/png']; const jpeg = data['image/jpeg'];
  if (text !== undefined && (typeof text !== 'string' || unsafeText(text) || utf8Bytes(text) > 524_288)) return undefined;
  const normalizedJson = json === undefined ? undefined : boundedJson(json);
  if (json !== undefined && normalizedJson === undefined) return undefined;
  for (const image of [png, jpeg]) if (image !== undefined && (typeof image !== 'string' || image.length > 1_500_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image))) return undefined;
  if (text === undefined && json === undefined && png === undefined && jpeg === undefined) return undefined;
  return { outputType: 'display', ...(executionCount !== undefined ? { executionCount } : {}),
    ...(typeof text === 'string' ? { text } : {}), ...(normalizedJson !== undefined ? { json: normalizedJson } : {}),
    ...(typeof png === 'string' ? { png } : {}), ...(typeof jpeg === 'string' ? { jpeg } : {}) };
}

function normalizeExecutedNotebook(value: unknown, expected?: NotebookView): { cells: ExecutedNotebookCell[] } | undefined {
  const root = object(value); const metadata = object(root?.metadata);
  if (!root || !exactKeys(root, ['nbformat', 'nbformat_minor', 'metadata', 'cells']) || root.nbformat !== 4 || root.nbformat_minor !== 5
    || !metadata || !Array.isArray(root.cells) || root.cells.length < 1 || root.cells.length > 32
    || (expected && root.cells.length !== expected.cells.length)) return undefined;
  const cells: ExecutedNotebookCell[] = [];
  for (let index = 0; index < root.cells.length; index += 1) {
    const item = object(root.cells[index]); const cellMetadata = object(item?.metadata);
    if (!item || !cellMetadata || (item.cell_type !== 'code' && item.cell_type !== 'markdown')
      || typeof item.id !== 'string' || typeof item.source !== 'string') return undefined;
    const tags = cellMetadata.tags === undefined ? [] : normalizeTags(cellMetadata.tags);
    if (!tags || (expected && (item.id !== expected.cells[index].id || item.source !== expected.cells[index].source
      || item.cell_type !== expected.cells[index].type || JSON.stringify(tags) !== JSON.stringify(expected.cells[index].tags)))) return undefined;
    if (item.cell_type === 'markdown') {
      if (!exactKeys(item, ['cell_type', 'id', 'metadata', 'source'])) return undefined;
      cells.push({ id: item.id, type: 'markdown', source: item.source, tags, outputs: [] }); continue;
    }
    if (!exactKeys(item, ['cell_type', 'id', 'metadata', 'source', 'execution_count', 'outputs']) || !Array.isArray(item.outputs)
      || item.outputs.length > 100) return undefined;
    const executionCount = item.execution_count === null ? undefined : integer(item.execution_count, 0, Number.MAX_SAFE_INTEGER);
    if (item.execution_count !== null && executionCount === undefined) return undefined;
    const outputs = item.outputs.map(normalizeOutput); if (outputs.some((output) => !output)) return undefined;
    cells.push({ id: item.id, type: 'code', source: item.source, tags, ...(executionCount !== undefined ? { executionCount } : {}),
      outputs: outputs as NotebookOutput[] });
  }
  return { cells };
}

export function normalizeNotebookRun(payload: unknown, expectedNotebook?: NotebookView, detail = false): NotebookRunView | undefined {
  const envelope = object(unwrapApiData(payload)); const root = object(envelope?.run) ?? envelope;
  const allowed = ['id', 'notebookId', 'projectId', 'notebookRevision', 'snapshotSha256', 'status', 'revision', 'metrics', 'artifacts',
    'result', 'error', 'timeline', 'queuedAt', 'startedAt', 'verificationStartedAt', 'cancelRequestedAt', 'completedAt', 'createdAt', 'updatedAt',
    'executedNotebook', 'snapshot'];
  if (!root || !exactKeys(root, allowed)) return undefined;
  const id = objectId(root.id); const notebookId = objectId(root.notebookId); const projectId = root.projectId === undefined ? undefined : objectId(root.projectId);
  const notebookRevision = integer(root.notebookRevision, 1, 999_999); const hash = sha256(root.snapshotSha256);
  const status = typeof root.status === 'string' && runStatuses.has(root.status as NotebookRunStatus) ? root.status as NotebookRunStatus : undefined;
  const revision = integer(root.revision, 1, 1_000_000); const queuedAt = dateText(root.queuedAt);
  if (!id || !notebookId || !notebookRevision || !hash || !status || !revision || !queuedAt
    || (expectedNotebook && (notebookId !== expectedNotebook.id || projectId !== expectedNotebook.projectId))) return undefined;
  if (!Array.isArray(root.metrics) || root.metrics.length > 1_000 || !Array.isArray(root.artifacts) || root.artifacts.length > 20
    || !Array.isArray(root.timeline) || root.timeline.length > 32) return undefined;
  const metrics = root.metrics.map((item) => { const metric = object(item); if (!metric || !exactKeys(metric, ['name', 'value', 'step'])
    || typeof metric.name !== 'string' || typeof metric.value !== 'number' || !Number.isFinite(metric.value)) return undefined;
  const step = metric.step === undefined ? undefined : integer(metric.step, 0, Number.MAX_SAFE_INTEGER); if (metric.step !== undefined && step === undefined) return undefined;
  return { name: metric.name, value: metric.value, ...(step !== undefined ? { step } : {}) }; });
  if (metrics.some((item) => !item)) return undefined;
  const artifacts = root.artifacts.map((item) => { const artifact = object(item); if (!artifact || !exactKeys(artifact,
    ['index', 'path', 'kind', 'mimeType', 'bytes', 'sha256'])) return undefined;
  const index = integer(artifact.index, 0, 19); const bytes = integer(artifact.bytes, 0, 1_048_576); const digest = sha256(artifact.sha256);
  if (index === undefined || bytes === undefined || !digest || typeof artifact.path !== 'string' || !/^artifacts\//.test(artifact.path)
    || !['text', 'json', 'png', 'jpeg'].includes(String(artifact.kind)) || typeof artifact.mimeType !== 'string') return undefined;
  return { index, path: artifact.path, kind: artifact.kind as 'text' | 'json' | 'png' | 'jpeg', mimeType: artifact.mimeType, bytes, sha256: digest }; });
  if (artifacts.some((item) => !item)) return undefined;
  const timeline = root.timeline.map((item) => { const event = object(item); if (!event || !exactKeys(event, ['revision', 'sequence', 'type', 'timestamp', 'code'])) return undefined;
  const eventRevision = integer(event.revision, 1, 1_000_000); const sequence = integer(event.sequence, 1, 32); const timestamp = dateText(event.timestamp);
  if (!eventRevision || !sequence || !timestamp || typeof event.type !== 'string') return undefined;
  return { revision: eventRevision, sequence, type: event.type, timestamp, ...(typeof event.code === 'string' ? { code: event.code } : {}) }; });
  if (timeline.some((item) => !item)) return undefined;
  const optionalDates = ['startedAt', 'verificationStartedAt', 'cancelRequestedAt', 'completedAt', 'createdAt', 'updatedAt'] as const;
  const dates: Record<string, string> = {}; for (const key of optionalDates) { if (root[key] !== undefined) { const value = dateText(root[key]); if (!value) return undefined; dates[key] = value; } }
  const rawSnapshot = object(root.snapshot); let snapshot: NotebookRunView['snapshot'];
  if (root.snapshot !== undefined) {
    if (!detail || !rawSnapshot || !exactKeys(rawSnapshot, ['cells', 'cellTimeoutSeconds'])) return undefined;
    const cells = normalizeCells(rawSnapshot.cells); const cellTimeoutSeconds = integer(rawSnapshot.cellTimeoutSeconds, 1, 30);
    if (!cells || !cellTimeoutSeconds) return undefined; snapshot = { cells, cellTimeoutSeconds };
  }
  if (detail && !snapshot || !detail && root.snapshot !== undefined) return undefined;
  const snapshotNotebook: NotebookView | undefined = snapshot ? { id: notebookId, ...(projectId ? { projectId } : {}), title: 'snapshot',
    cells: snapshot.cells, cellTimeoutSeconds: snapshot.cellTimeoutSeconds, revision: notebookRevision } : undefined;
  let executedNotebook: { cells: ExecutedNotebookCell[] } | undefined;
  if (root.executedNotebook !== undefined) { if (!detail || status !== 'succeeded') return undefined;
    executedNotebook = normalizeExecutedNotebook(root.executedNotebook, snapshotNotebook); if (!executedNotebook) return undefined; }
  if (detail && status === 'succeeded' && !executedNotebook) return undefined;
  if (!detail && root.executedNotebook !== undefined) return undefined;
  const rawResult = object(root.result); if (root.result !== undefined && (!rawResult
    || !exactKeys(rawResult, ['durationMs', 'runtimeImageId', 'verifierImageId']))) return undefined;
  let result: NotebookRunView['result'];
  if (rawResult) {
    const durationMs = rawResult.durationMs === undefined ? undefined : integer(rawResult.durationMs, 0, 3_600_000);
    const runtimeImageId = rawResult.runtimeImageId === undefined ? undefined : sha256(rawResult.runtimeImageId);
    const verifierImageId = rawResult.verifierImageId === undefined ? undefined : sha256(rawResult.verifierImageId);
    if ((rawResult.durationMs !== undefined && durationMs === undefined) || (rawResult.runtimeImageId !== undefined && !runtimeImageId)
      || (rawResult.verifierImageId !== undefined && !verifierImageId) || (runtimeImageId && runtimeImageId === verifierImageId)) return undefined;
    result = { ...(durationMs !== undefined ? { durationMs } : {}), ...(runtimeImageId ? { runtimeImageId } : {}),
      ...(verifierImageId ? { verifierImageId } : {}) };
  }
  const rawError = object(root.error); if (root.error !== undefined && (!rawError || !exactKeys(rawError, ['code', 'message', 'cellIndex']))) return undefined;
  let error: NotebookRunView['error'];
  if (rawError) {
    const cellIndex = rawError.cellIndex === undefined ? undefined : integer(rawError.cellIndex, 0, 31);
    if (typeof rawError.code !== 'string' || !/^[A-Z0-9_]{1,100}$/.test(rawError.code)
      || typeof rawError.message !== 'string' || !rawError.message.trim() || unsafeText(rawError.message)
      || utf8Bytes(rawError.message) > 300 || (rawError.cellIndex !== undefined && cellIndex === undefined)) return undefined;
    error = { code: rawError.code, message: rawError.message, ...(cellIndex !== undefined ? { cellIndex } : {}) };
  }
  if (status === 'succeeded' && (error || !result) || status !== 'succeeded' && (metrics.length > 0 || artifacts.length > 0)) return undefined;
  return { id, notebookId, ...(projectId ? { projectId } : {}), notebookRevision, snapshotSha256: hash, status, revision,
    metrics: metrics as NotebookRunView['metrics'], artifacts: artifacts as NotebookRunView['artifacts'],
    ...(result ? { result } : {}), ...(error ? { error } : {}),
    timeline: timeline as NotebookRunView['timeline'], queuedAt, ...dates, ...(snapshot ? { snapshot } : {}),
    ...(executedNotebook ? { executedNotebook } : {}) };
}

export function normalizeNotebookRunPage(payload: unknown, expectedNotebook: NotebookView): NotebookRunPage | undefined {
  const root = object(unwrapApiData(payload)); const pagination = object(root?.pagination);
  if (!root || !pagination || !exactKeys(root, ['runs', 'pagination']) || !Array.isArray(root.runs)
    || !exactKeys(pagination, ['page', 'pageSize', 'total', 'totalPages', 'maxPages'])) return undefined;
  const page = integer(pagination.page, 1, 10); const total = integer(pagination.total, 0, 100); const totalPages = integer(pagination.totalPages, 1, 10);
  if (!page || total === undefined || !totalPages || pagination.pageSize !== 25 || pagination.maxPages !== 10
    || totalPages !== Math.max(1, Math.min(10, Math.ceil(total / 25))) || page > totalPages || root.runs.length > 25) return undefined;
  const runs = root.runs.map((item) => normalizeNotebookRun(item, expectedNotebook, false));
  if (runs.some((item) => !item) || new Set(runs.map((item) => item!.id)).size !== runs.length) return undefined;
  return { runs: runs as NotebookRunView[], pagination: { page, pageSize: 25, total, totalPages, maxPages: 10 } };
}

export const isNotebookRunActive = (status: NotebookRunStatus): boolean => activeRunStatuses.has(status);

export function validateNotebookDraft(value: NotebookDraft): string | undefined {
  if (!normalizeTitle(value.title)) return 'Title must contain 1 to 120 safe UTF-8 bytes.';
  if (!normalizeCells(value.cells)) return 'Notebook cells are invalid or exceed their count or UTF-8 byte limits.';
  if (integer(value.cellTimeoutSeconds, 1, NOTEBOOK_LIMITS.cellTimeoutSeconds) === undefined)
    return 'Cell timeout must be an integer from 1 through 30 seconds.';
  return undefined;
}

function normalizedDraft(value: NotebookDraft): NotebookDraft {
  const error = validateNotebookDraft(value);
  if (error) throw new Error(error);
  return { title: value.title.normalize('NFC').trim(), cells: normalizeCells(value.cells)!, cellTimeoutSeconds: value.cellTimeoutSeconds };
}

export function buildNotebookCreatePayload(value: NotebookDraft, projectId?: string): NotebookCreatePayload {
  const draft = normalizedDraft(value);
  if (projectId !== undefined && !objectId(projectId)) throw new Error('Project id is invalid.');
  return { ...draft, ...(projectId ? { projectId } : {}) };
}

export function buildNotebookUpdatePayload(value: NotebookDraft, expectedRevision: number): NotebookUpdatePayload {
  const draft = normalizedDraft(value);
  if (integer(expectedRevision, 1, 999_999) === undefined) throw new Error('Notebook revision is invalid.');
  return { ...draft, expectedRevision };
}

export const notebookScopeKey = (requested: boolean, projectId?: string): string =>
  requested ? (projectId ? `project:${projectId}` : 'project:pending') : 'workspace';

export const isNotebookScopeRequestCurrent = (requestScope: string, currentScope: string, request: number, currentRequest: number): boolean =>
  requestScope === currentScope && request === currentRequest;
