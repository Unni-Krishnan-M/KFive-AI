import { unwrapApiData } from './runtimeSettings';

type UnknownRecord = Record<string, unknown>;

export const DATASET_UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024;
export const DATASET_DERIVED_LIMIT_BYTES = 10 * 1024 * 1024;
export const DATASET_ROW_LIMIT = 10_000;
export const DATASET_COLUMN_LIMIT = 100;
export const DATASET_PREVIEW_ROW_LIMIT = 50;
export const DATASET_PREVIEW_CELL_LIMIT = 500;

export type DatasetFormat = 'csv' | 'json';
export type DatasetKind = 'original' | 'derived';
export type DatasetCell = string | number | boolean | null;
export type DatasetColumnType = 'empty' | 'integer' | 'number' | 'boolean' | 'date' | 'string' | 'mixed';

export interface DatasetLimits {
  uploadBytes?: number;
  derivedBytes?: number;
  rows?: number;
  columns?: number;
  headerCharacters?: number;
  cellBytes?: number;
  previewRows?: number;
  previewCellCharacters?: number;
  datasetsPerOwner?: number;
}

export interface DatasetStatus {
  available?: boolean;
  canUpload: boolean;
  scope?: { type?: string; projectId?: string; projectStatus?: string };
  retention?: { used: number; maximum: number; limitReached: boolean };
  limits: DatasetLimits;
}

export interface DatasetSource {
  originalName: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}

export interface DatasetColumnAnalysis {
  name: string;
  inferredType: DatasetColumnType;
  missingCount: number;
  nonMissingCount: number;
  uniqueCount: number;
  numeric?: { min: number; max: number; mean: number; standardDeviation: number };
  categories: Array<{ value: string; count: number }>;
  outlierCount?: number;
}

export interface DatasetCorrelation {
  left: string;
  right: string;
  coefficient: number;
  pairedRows: number;
}

export interface DatasetAnalysis {
  schemaVersion: 1;
  rowCount: number;
  columnCount: number;
  duplicateRowCount: number;
  missingCellCount: number;
  columns: DatasetColumnAnalysis[];
  correlations: DatasetCorrelation[];
  preview: Array<Record<string, DatasetCell>>;
  previewTruncatedCellCount: number;
  suggestions: string[];
}

export interface DatasetTransforms {
  trimStrings: boolean;
  dropDuplicateRows: boolean;
  dropRowsWithMissingValues: boolean;
  escapeSpreadsheetFormulas: boolean;
}

export interface DatasetDerivePayload {
  name: string;
  transform: DatasetTransforms;
}

export interface DatasetSummary {
  id: string;
  name: string;
  kind: DatasetKind;
  format: DatasetFormat;
  projectId?: string;
  parentDatasetId?: string;
  rootDatasetId: string;
  generation: number;
  source: DatasetSource;
  transforms: DatasetTransforms;
  createdAt?: string;
  updatedAt?: string;
}

export interface DatasetDetail extends DatasetSummary {
  analysis: DatasetAnalysis;
}

const object = (value: unknown): UnknownRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined;
const count = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const objectId = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-f\d]{24}$/i.test(value) ? value : undefined;
const unsafeTextCharacter = /[\p{Cc}\p{Cf}]/u;
const safeText = (value: unknown, maximum: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized.length > maximum || [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint === 0xfffd || unsafeTextCharacter.test(character);
  })) return undefined;
  return normalized;
};
const dateText = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
};

function normalizeLimits(value: unknown): DatasetLimits {
  const limits = object(value) ?? {};
  return {
    uploadBytes: count(limits.uploadBytes ?? limits.maxUploadBytes, DATASET_UPLOAD_LIMIT_BYTES),
    derivedBytes: count(limits.derivedBytes ?? limits.maxDerivedBytes, DATASET_DERIVED_LIMIT_BYTES),
    rows: count(limits.rows ?? limits.maxRows, DATASET_ROW_LIMIT),
    columns: count(limits.columns ?? limits.maxColumns, DATASET_COLUMN_LIMIT),
    headerCharacters: count(limits.headerCharacters, 10_000),
    cellBytes: count(limits.cellBytes, 1_000_000),
    previewRows: count(limits.previewRows, DATASET_PREVIEW_ROW_LIMIT),
    previewCellCharacters: count(limits.previewCellCharacters, DATASET_PREVIEW_CELL_LIMIT),
    datasetsPerOwner: count(limits.datasetsPerOwner ?? limits.ownerRetention, 100_000),
  };
}

export function normalizeDatasetStatus(payload: unknown): DatasetStatus {
  const root = object(unwrapApiData(payload)) ?? {};
  const scope = object(root.scope);
  const retention = object(root.retention);
  const retainedCount = count(retention?.used, 100_000);
  const retentionMaximum = count(retention?.maximum, 100_000);
  const normalizedRetention = retainedCount !== undefined && retentionMaximum !== undefined
    && retentionMaximum > 0 && retainedCount <= retentionMaximum && typeof retention?.limitReached === 'boolean'
    ? { used: retainedCount, maximum: retentionMaximum, limitReached: retention.limitReached }
    : undefined;
  return {
    available: typeof root.available === 'boolean' ? root.available : undefined,
    canUpload: root.canUpload === true,
    scope: scope ? {
      type: safeText(scope.type, 40),
      projectId: objectId(scope.projectId),
      projectStatus: safeText(scope.projectStatus, 40),
    } : undefined,
    ...(normalizedRetention ? { retention: normalizedRetention } : {}),
    limits: normalizeLimits(root.limits),
  };
}

function normalizeTransforms(value: unknown): DatasetTransforms | undefined {
  const transform = object(value);
  if (!transform) return undefined;
  const keys = ['trimStrings', 'dropDuplicateRows', 'dropRowsWithMissingValues', 'escapeSpreadsheetFormulas'];
  if (keys.some((key) => typeof transform[key] !== 'boolean')) return undefined;
  return {
    trimStrings: transform.trimStrings as boolean,
    dropDuplicateRows: transform.dropDuplicateRows as boolean,
    dropRowsWithMissingValues: transform.dropRowsWithMissingValues as boolean,
    escapeSpreadsheetFormulas: transform.escapeSpreadsheetFormulas as boolean,
  };
}

function normalizeDatasetSummaryRecord(payload: unknown): DatasetSummary | undefined {
  const envelope = object(unwrapApiData(payload));
  const root = object(envelope?.dataset) ?? envelope;
  const source = object(root?.source);
  const id = objectId(root?.id ?? root?._id);
  const name = safeText(root?.name, 200);
  const originalName = safeText(source?.originalName, 255);
  const mimeType = safeText(source?.mimeType, 100);
  const bytes = count(source?.bytes, root?.kind === 'derived' ? DATASET_DERIVED_LIMIT_BYTES : DATASET_UPLOAD_LIMIT_BYTES);
  const sha256 = safeText(source?.sha256, 64);
  if (!root || !id || !name || (root.kind !== 'original' && root.kind !== 'derived')
    || (root.format !== 'csv' && root.format !== 'json') || !source || !originalName || !mimeType
    || bytes === undefined || !sha256 || !/^[a-f\d]{64}$/i.test(sha256)) return undefined;
  const projectId = root.projectId === undefined || root.projectId === null ? undefined : objectId(root.projectId);
  const parentDatasetId = root.parentDatasetId === undefined || root.parentDatasetId === null ? undefined : objectId(root.parentDatasetId);
  const rootDatasetId = objectId(root.rootDatasetId);
  const generation = count(root.generation, 100);
  const expectedMimeType = root.format === 'csv' ? 'text/csv' : 'application/json';
  if ((root.projectId !== undefined && root.projectId !== null && !projectId)
    || (root.parentDatasetId !== undefined && root.parentDatasetId !== null && !parentDatasetId)
    || !rootDatasetId || generation === undefined || mimeType !== expectedMimeType
    || !originalName.toLowerCase().endsWith(`.${root.format}`)
    || (root.kind === 'original' && (parentDatasetId || rootDatasetId !== id || generation !== 0))
    || (root.kind === 'derived' && (!parentDatasetId || rootDatasetId === id || generation < 1))) return undefined;
  const transforms = normalizeTransforms(root.transforms);
  if (!transforms) return undefined;
  const transformEnabled = Object.values(transforms).some(Boolean);
  if ((root.kind === 'original' && transformEnabled) || (root.kind === 'derived' && !transformEnabled)) return undefined;
  return {
    id,
    name,
    kind: root.kind,
    format: root.format,
    projectId,
    parentDatasetId,
    rootDatasetId,
    generation,
    source: { originalName, mimeType, bytes, sha256 },
    transforms,
    createdAt: dateText(root.createdAt),
    updatedAt: dateText(root.updatedAt),
  };
}

function normalizeCell(value: unknown): DatasetCell | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.length <= DATASET_PREVIEW_CELL_LIMIT) return value;
  return undefined;
}

function normalizeColumn(value: unknown, rowCount: number): DatasetColumnAnalysis | undefined {
  const column = object(value);
  const name = safeText(column?.name, 120);
  const allowedTypes = new Set<DatasetColumnType>(['empty', 'integer', 'number', 'boolean', 'date', 'string', 'mixed']);
  const missingCount = count(column?.missingCount, rowCount);
  const nonMissingCount = count(column?.nonMissingCount, rowCount);
  const uniqueCount = count(column?.uniqueCount, rowCount);
  if (!column || !name || !allowedTypes.has(column.inferredType as DatasetColumnType)
    || missingCount === undefined || nonMissingCount === undefined || uniqueCount === undefined
    || missingCount + nonMissingCount !== rowCount) return undefined;
  const categories = Array.isArray(column.categories) ? column.categories.slice(0, 10).flatMap((item) => {
    const category = object(item);
    const categoryValue = category ? safeText(category.value, 200) : undefined;
    const categoryCount = category ? count(category.count, rowCount) : undefined;
    return categoryValue !== undefined && categoryCount !== undefined ? [{ value: categoryValue, count: categoryCount }] : [];
  }) : [];
  let numeric: DatasetColumnAnalysis['numeric'];
  if (column.numeric !== undefined) {
    const source = object(column.numeric);
    const min = finite(source?.min); const max = finite(source?.max); const mean = finite(source?.mean); const standardDeviation = finite(source?.standardDeviation);
    if (!source || min === undefined || max === undefined || mean === undefined || standardDeviation === undefined
      || min > max || mean < min || mean > max || standardDeviation < 0) return undefined;
    numeric = { min, max, mean, standardDeviation };
  }
  const outlierCount = column.outlierCount === undefined ? undefined : count(column.outlierCount, nonMissingCount);
  if (column.outlierCount !== undefined && outlierCount === undefined) return undefined;
  return {
    name,
    inferredType: column.inferredType as DatasetColumnType,
    missingCount,
    nonMissingCount,
    uniqueCount,
    numeric,
    categories,
    outlierCount,
  };
}

function normalizeAnalysis(value: unknown): DatasetAnalysis | undefined {
  const analysis = object(value);
  const rowCount = count(analysis?.rowCount, DATASET_ROW_LIMIT);
  const columnCount = count(analysis?.columnCount, DATASET_COLUMN_LIMIT);
  const duplicateRowCount = count(analysis?.duplicateRowCount, rowCount);
  const missingCellCount = count(analysis?.missingCellCount, rowCount === undefined || columnCount === undefined ? 0 : rowCount * columnCount);
  const previewTruncatedCellCount = count(analysis?.previewTruncatedCellCount);
  if (!analysis || analysis.schemaVersion !== 1 || rowCount === undefined || columnCount === undefined || columnCount < 1
    || duplicateRowCount === undefined || missingCellCount === undefined || previewTruncatedCellCount === undefined
    || !Array.isArray(analysis.columns) || analysis.columns.length !== columnCount) return undefined;
  const columns = analysis.columns.map((column) => normalizeColumn(column, rowCount));
  if (columns.some((column) => !column)) return undefined;
  const columnNames = columns.map((column) => column!.name);
  if (new Set(columnNames).size !== columnNames.length) return undefined;
  if (!Array.isArray(analysis.preview) || analysis.preview.length > DATASET_PREVIEW_ROW_LIMIT) return undefined;
  const preview: Array<Record<string, DatasetCell>> = [];
  for (const item of analysis.preview) {
    const row = object(item);
    if (!row || Object.keys(row).length !== columnNames.length || Object.keys(row).some((key) => !columnNames.includes(key))) return undefined;
    const normalizedRow: Record<string, DatasetCell> = {};
    for (const column of columnNames) {
      const cell = normalizeCell(row[column]);
      if (cell === undefined && row[column] !== null) return undefined;
      normalizedRow[column] = cell as DatasetCell;
    }
    preview.push(normalizedRow);
  }
  const rawCorrelations = analysis.correlations;
  if (!Array.isArray(rawCorrelations)) return undefined;
  const correlations = rawCorrelations.slice(0, 190).flatMap((item) => {
    const correlation = object(item);
    const left = correlation ? safeText(correlation.left, 120) : undefined;
    const right = correlation ? safeText(correlation.right, 120) : undefined;
    const coefficient = correlation ? finite(correlation.coefficient) : undefined;
    const pairedRows = correlation ? count(correlation.pairedRows, rowCount) : undefined;
    return left && right && columnNames.includes(left) && columnNames.includes(right) && left !== right
      && coefficient !== undefined && coefficient >= -1 && coefficient <= 1 && pairedRows !== undefined
      ? [{ left, right, coefficient, pairedRows }] : [];
  });
  if (!Array.isArray(analysis.suggestions)) return undefined;
  const suggestions = analysis.suggestions.slice(0, 20).flatMap((item) => {
    const suggestion = safeText(item, 1000);
    return suggestion ? [suggestion] : [];
  });
  return {
    schemaVersion: 1,
    rowCount,
    columnCount,
    duplicateRowCount,
    missingCellCount,
    columns: columns as DatasetColumnAnalysis[],
    correlations,
    preview,
    previewTruncatedCellCount,
    suggestions,
  };
}

export function normalizeDataset(payload: unknown): DatasetDetail | undefined {
  const envelope = object(unwrapApiData(payload));
  const root = object(envelope?.dataset) ?? envelope;
  const summary = normalizeDatasetSummaryRecord(payload);
  const analysis = normalizeAnalysis(root?.analysis);
  return summary && analysis ? { ...summary, analysis } : undefined;
}

export function normalizeDatasetList(payload: unknown): DatasetSummary[] {
  const root = object(unwrapApiData(payload));
  return root && Array.isArray(root.datasets) ? root.datasets.flatMap((item) => {
    const normalized = normalizeDatasetSummaryRecord(item);
    return normalized ? [normalized] : [];
  }) : [];
}

export function datasetScopeKey(projectRequested: boolean, projectId?: string): string {
  if (!projectRequested) return 'workspace';
  return projectId ? `project:${projectId}` : 'project:pending';
}

export function isDatasetScopeRequestCurrent(currentScopeKey: string, requestScopeKey: string, currentRequestId: number, requestId: number): boolean {
  return currentScopeKey === requestScopeKey && currentRequestId === requestId;
}

export function effectiveDatasetProjectStatus(
  contextStatus?: string,
  backendStatus?: string
): 'active' | 'archived' | undefined {
  if (backendStatus === 'active' || backendStatus === 'archived') return backendStatus;
  return contextStatus === 'active' || contextStatus === 'archived' ? contextStatus : undefined;
}

export function canMutateDatasets(projectStatus?: string, projectContextValid = true, backendAllows = true): boolean {
  return projectContextValid && projectStatus !== 'archived' && backendAllows;
}

export function buildDatasetDerivePayload(name: string, transform: DatasetTransforms): DatasetDerivePayload {
  return {
    name: name.trim(),
    transform: {
      trimStrings: transform.trimStrings,
      dropDuplicateRows: transform.dropDuplicateRows,
      dropRowsWithMissingValues: transform.dropRowsWithMissingValues,
      escapeSpreadsheetFormulas: transform.escapeSpreadsheetFormulas,
    },
  };
}

export function validateDatasetFile(file: Pick<File, 'name' | 'type' | 'size'>, maximumBytes = DATASET_UPLOAD_LIMIT_BYTES): string | undefined {
  const extension = file.name.toLowerCase().split('.').pop();
  if (extension !== 'csv' && extension !== 'json') return 'Choose a CSV or JSON dataset.';
  const expectedMimeType = extension === 'csv' ? 'text/csv' : 'application/json';
  if (file.type.toLowerCase() !== expectedMimeType) return `The selected file must be reported as ${expectedMimeType}.`;
  if (file.size === 0) return 'The dataset file is empty.';
  if (file.size > maximumBytes) return `The dataset file must be ${formatDatasetBytes(maximumBytes)} or smaller.`;
  return undefined;
}

export function formatDatasetBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'Not reported';
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let amount = value; let index = -1;
  do { amount /= 1024; index += 1; } while (amount >= 1024 && index < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[index]}`;
}
