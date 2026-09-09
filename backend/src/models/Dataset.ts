import { Schema, model } from 'mongoose';
import { DATASET_LIMITS, DatasetFormat, DatasetTransform } from '@/services/datasetAnalysis';

export const DATASET_ANALYSIS_VERSION = 1 as const;
export const DATASET_OWNER_RETENTION = 100 as const;
export const DATASET_DERIVED_OUTPUT_BYTES = DATASET_LIMITS.derivedBytes;

const categorySchema = new Schema({
  value: { type: String, required: true, maxlength: 200 },
  count: { type: Number, required: true, min: 1, max: DATASET_LIMITS.rows },
}, { _id: false, strict: 'throw' });

const numericSchema = new Schema({
  min: { type: Number, required: true },
  max: { type: Number, required: true },
  mean: { type: Number, required: true },
  standardDeviation: { type: Number, required: true, min: 0 },
}, { _id: false, strict: 'throw' });

const columnSchema = new Schema({
  name: { type: String, required: true, minlength: 1, maxlength: DATASET_LIMITS.headerCharacters },
  inferredType: {
    type: String,
    required: true,
    enum: ['empty', 'integer', 'number', 'boolean', 'date', 'string', 'mixed'],
  },
  missingCount: { type: Number, required: true, min: 0, max: DATASET_LIMITS.rows },
  nonMissingCount: { type: Number, required: true, min: 0, max: DATASET_LIMITS.rows },
  uniqueCount: { type: Number, required: true, min: 0, max: DATASET_LIMITS.rows },
  numeric: { type: numericSchema },
  categories: {
    type: [categorySchema],
    default: [],
    validate: [(values: unknown[]) => values.length <= DATASET_LIMITS.categoryValues, 'Too many category values.'],
  },
  outlierCount: { type: Number, min: 0, max: DATASET_LIMITS.rows },
}, { _id: false, strict: 'throw' });

const correlationSchema = new Schema({
  left: { type: String, required: true, maxlength: DATASET_LIMITS.headerCharacters },
  right: { type: String, required: true, maxlength: DATASET_LIMITS.headerCharacters },
  coefficient: { type: Number, required: true, min: -1, max: 1 },
  pairedRows: { type: Number, required: true, min: 2, max: DATASET_LIMITS.rows },
}, { _id: false, strict: 'throw' });

function validPreview(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > DATASET_LIMITS.previewRows) return false;
  return value.every((row) => row && typeof row === 'object' && !Array.isArray(row)
    && Object.keys(row).length <= DATASET_LIMITS.columns
    && Object.values(row).every((cell) => cell === null || (typeof cell === 'string' && cell.length <= DATASET_LIMITS.previewCellCharacters)
      || typeof cell === 'boolean' || (typeof cell === 'number' && Number.isFinite(cell))));
}

function validAnalysisShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const analysis = value as {
    columnCount?: unknown;
    columns?: Array<{ name?: unknown }>;
    preview?: Array<Record<string, unknown>>;
  };
  if (!Number.isInteger(analysis.columnCount) || !Array.isArray(analysis.columns)
    || analysis.columns.length !== analysis.columnCount || !Array.isArray(analysis.preview)) return false;
  const names = analysis.columns.map((column) => column?.name);
  if (names.some((name) => typeof name !== 'string') || new Set(names).size !== names.length) return false;
  return analysis.preview.every((row) => row && typeof row === 'object' && !Array.isArray(row)
    && Object.keys(row).length === names.length
    && names.every((name) => Object.prototype.hasOwnProperty.call(row, name as string)));
}

const analysisSchema = new Schema({
  schemaVersion: { type: Number, required: true, enum: [DATASET_ANALYSIS_VERSION] },
  rowCount: { type: Number, required: true, min: 0, max: DATASET_LIMITS.rows },
  columnCount: { type: Number, required: true, min: 1, max: DATASET_LIMITS.columns },
  duplicateRowCount: { type: Number, required: true, min: 0, max: DATASET_LIMITS.rows },
  missingCellCount: {
    type: Number,
    required: true,
    min: 0,
    max: DATASET_LIMITS.rows * DATASET_LIMITS.columns,
  },
  columns: {
    type: [columnSchema],
    required: true,
    validate: [(values: unknown[]) => values.length >= 1 && values.length <= DATASET_LIMITS.columns, 'Invalid column count.'],
  },
  correlations: {
    type: [correlationSchema],
    default: [],
    validate: [(values: unknown[]) => values.length <= 190, 'Too many correlations.'],
  },
  preview: {
    type: [Schema.Types.Mixed],
    default: [],
    validate: { validator: validPreview, message: 'Dataset preview is invalid.' },
  },
  previewTruncatedCellCount: {
    type: Number,
    required: true,
    min: 0,
    max: DATASET_LIMITS.previewRows * DATASET_LIMITS.columns,
  },
  suggestions: {
    type: [{ type: String, maxlength: DATASET_LIMITS.suggestionCharacters }],
    default: [],
    validate: [(values: unknown[]) => values.length <= 20, 'Too many suggestions.'],
  },
}, { _id: false, strict: 'throw' });

const transformSchema = new Schema<DatasetTransform>({
  trimStrings: { type: Boolean, required: true, default: false },
  dropDuplicateRows: { type: Boolean, required: true, default: false },
  dropRowsWithMissingValues: { type: Boolean, required: true, default: false },
  escapeSpreadsheetFormulas: { type: Boolean, required: true, default: false },
}, { _id: false, strict: 'throw' });

const datasetSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', immutable: true, index: true },
  parentDatasetId: { type: Schema.Types.ObjectId, ref: 'Dataset', immutable: true, index: true },
  rootDatasetId: { type: Schema.Types.ObjectId, ref: 'Dataset', required: true, immutable: true, index: true },
  generation: { type: Number, required: true, immutable: true, min: 0, max: 100 },
  kind: { type: String, required: true, immutable: true, enum: ['original', 'derived'] },
  name: { type: String, required: true, immutable: true, minlength: 1, maxlength: 200 },
  originalName: { type: String, required: true, immutable: true, minlength: 5, maxlength: 255 },
  format: { type: String, required: true, immutable: true, enum: ['csv', 'json'] satisfies DatasetFormat[] },
  mimeType: { type: String, required: true, immutable: true, enum: ['text/csv', 'application/json'] },
  byteCount: { type: Number, required: true, immutable: true, min: 1, max: DATASET_LIMITS.derivedBytes },
  sha256: { type: String, required: true, immutable: true, match: /^[a-f\d]{64}$/ },
  storageKey: { type: String, required: true, immutable: true, unique: true, select: false, maxlength: 128 },
  transform: { type: transformSchema, required: true, immutable: true },
  analysis: {
    type: analysisSchema,
    required: true,
    immutable: true,
    validate: { validator: validAnalysisShape, message: 'Dataset analysis shape is inconsistent.' },
  },
}, { timestamps: true, strict: 'throw' });

datasetSchema.pre('validate', function validateDatasetInvariants() {
  const record = this as unknown as {
    _id?: unknown;
    parentDatasetId?: unknown;
    rootDatasetId?: unknown;
    generation?: number;
    kind?: 'original' | 'derived';
    format?: DatasetFormat;
    mimeType?: string;
    originalName?: string;
    byteCount?: number;
    transform?: DatasetTransform;
    invalidate(path: string, message: string): void;
  };
  const id = String(record._id ?? '');
  const parentId = record.parentDatasetId ? String(record.parentDatasetId) : undefined;
  const rootId = String(record.rootDatasetId ?? '');
  const transformEnabled = Boolean(record.transform && (
    record.transform.trimStrings
    || record.transform.dropDuplicateRows
    || record.transform.dropRowsWithMissingValues
    || record.transform.escapeSpreadsheetFormulas
  ));
  if (record.kind === 'original') {
    if (parentId || rootId !== id || record.generation !== 0 || transformEnabled || (record.byteCount ?? 0) > DATASET_LIMITS.uploadBytes) {
      record.invalidate('kind', 'Original dataset lineage is invalid.');
    }
  } else if (record.kind === 'derived') {
    if (!parentId || parentId === id || !rootId || rootId === id || !record.generation || record.generation < 1 || !transformEnabled) {
      record.invalidate('kind', 'Derived dataset lineage is invalid.');
    }
  }
  const expectedMime = record.format === 'csv' ? 'text/csv' : record.format === 'json' ? 'application/json' : undefined;
  if (expectedMime && (record.mimeType !== expectedMime || !record.originalName?.toLowerCase().endsWith(`.${record.format}`))) {
    record.invalidate('mimeType', 'Dataset format metadata is inconsistent.');
  }
});

datasetSchema.index({ ownerId: 1, createdAt: -1 });
datasetSchema.index({ ownerId: 1, projectId: 1, createdAt: -1 });
datasetSchema.index({ ownerId: 1, parentDatasetId: 1, createdAt: -1 });

export const DatasetModel = model('Dataset', datasetSchema);
