import { createHash } from 'crypto';
import { parse as parseCsv } from 'csv-parse/sync';

export const DATASET_LIMITS = Object.freeze({
  uploadBytes: 5 * 1024 * 1024,
  derivedBytes: 10 * 1024 * 1024,
  rows: 10_000,
  columns: 100,
  headerCharacters: 120,
  cellBytes: 16 * 1024,
  previewRows: 50,
  previewCellCharacters: 500,
  categoryValues: 10,
  correlationColumns: 20,
  suggestionCharacters: 500,
});

export type DatasetFormat = 'csv' | 'json';
export type DatasetCell = string | number | boolean | null;

export interface ParsedDataset {
  format: DatasetFormat;
  columns: string[];
  rows: DatasetCell[][];
}

export interface DatasetColumnAnalysis {
  name: string;
  inferredType: 'empty' | 'integer' | 'number' | 'boolean' | 'date' | 'string' | 'mixed';
  missingCount: number;
  nonMissingCount: number;
  uniqueCount: number;
  numeric?: { min: number; max: number; mean: number; standardDeviation: number };
  categories: Array<{ value: string; count: number }>;
  outlierCount?: number;
}

export interface DatasetAnalysis {
  schemaVersion: 1;
  rowCount: number;
  columnCount: number;
  duplicateRowCount: number;
  missingCellCount: number;
  columns: DatasetColumnAnalysis[];
  correlations: Array<{ left: string; right: string; coefficient: number; pairedRows: number }>;
  preview: Array<Record<string, DatasetCell>>;
  previewTruncatedCellCount: number;
  suggestions: string[];
}

export class DatasetInputError extends Error {
  readonly isOperational = true;

  constructor(
    message: string,
    readonly code: 'INVALID_DATASET_FILE' | 'DATASET_TOO_LARGE' | 'DATASET_LIMIT_EXCEEDED',
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'DatasetInputError';
  }
}

const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const isoDate = /^\d{4}-\d{2}-\d{2}(?:[Tt][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:[Zz]|[+-][0-2]\d:[0-5]\d)?)?$/;
const unsafeHeaderCharacter = /[\p{Cc}\p{Cf}]/u;

function inputError(message: string): DatasetInputError {
  return new DatasetInputError(message, 'INVALID_DATASET_FILE', 400);
}

function limitError(message: string): DatasetInputError {
  return new DatasetInputError(message, 'DATASET_LIMIT_EXCEEDED', 413);
}

function decodeUtf8(buffer: Buffer, maximumBytes: number): string {
  if (!buffer.length) throw inputError('The dataset file is empty.');
  if (buffer.length > maximumBytes) {
    throw new DatasetInputError(`Dataset files must be at most ${maximumBytes / (1024 * 1024)} MiB.`, 'DATASET_TOO_LARGE', 413);
  }
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (value.includes('\0')) throw inputError('Dataset files must not contain null bytes.');
    return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
  } catch (error) {
    if (error instanceof DatasetInputError) throw error;
    throw inputError('Dataset files must contain valid UTF-8 text.');
  }
}

function assertColumns(columns: string[]): string[] {
  if (!columns.length || columns.length > DATASET_LIMITS.columns) {
    throw limitError(`Datasets must contain between 1 and ${DATASET_LIMITS.columns} columns.`);
  }
  const normalized = columns.map((column) => {
    if (typeof column !== 'string') throw inputError('Every column name must be a string.');
    const name = column.normalize('NFC').trim();
    if (!name || name.length > DATASET_LIMITS.headerCharacters || [...name].some((character) => character === '\ufffd' || unsafeHeaderCharacter.test(character))) {
      throw inputError(`Column names must contain 1 to ${DATASET_LIMITS.headerCharacters} visible characters.`);
    }
    if (forbiddenKeys.has(name)) throw inputError(`The column name "${name}" is not allowed.`);
    return name;
  });
  if (new Set(normalized).size !== normalized.length) throw inputError('Dataset column names must be unique.');
  return normalized;
}

function assertCell(value: unknown): DatasetCell {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw inputError('Dataset numbers must be finite.');
    return value;
  }
  if (typeof value !== 'string') throw inputError('JSON dataset values must be strings, finite numbers, booleans, or null.');
  if (Buffer.byteLength(value, 'utf8') > DATASET_LIMITS.cellBytes) throw limitError('Dataset cells must contain at most 16 KiB of UTF-8 data.');
  return value;
}

function parseCsvText(text: string): ParsedDataset {
  let recordCount = 0;
  let table: string[][];
  try {
    table = parseCsv(text, {
      bom: true,
      delimiter: ',',
      encoding: 'utf8',
      max_record_size: (DATASET_LIMITS.cellBytes + 1) * DATASET_LIMITS.columns,
      relax_column_count: false,
      relax_quotes: false,
      skip_empty_lines: true,
      on_record(record: unknown) {
        recordCount += 1;
        if (recordCount > DATASET_LIMITS.rows + 1) throw limitError(`Datasets must contain at most ${DATASET_LIMITS.rows} data rows.`);
        if (!Array.isArray(record) || record.some((cell) => typeof cell !== 'string')) throw inputError('CSV records must contain text fields.');
        if (record.length > DATASET_LIMITS.columns) throw limitError(`Datasets must contain at most ${DATASET_LIMITS.columns} columns.`);
        if (record.some((cell) => Buffer.byteLength(cell, 'utf8') > DATASET_LIMITS.cellBytes)) {
          throw limitError('Dataset cells must contain at most 16 KiB of UTF-8 data.');
        }
        return record;
      },
    }) as string[][];
  } catch (error) {
    if (error instanceof DatasetInputError) throw error;
    throw inputError('The CSV file is malformed or has inconsistent row lengths.');
  }
  if (!table.length) throw inputError('The CSV file does not contain a header row.');

  const columns = assertColumns(table[0]);
  const rows = table.slice(1);
  for (const current of rows) {
    if (current.length !== columns.length) throw inputError('Every CSV row must contain the same number of fields as the header.');
  }
  return { format: 'csv', columns, rows };
}

function parseJsonText(text: string): ParsedDataset {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw inputError('The JSON dataset is malformed.'); }
  if (!Array.isArray(value) || !value.length) throw inputError('JSON datasets must be a non-empty array of flat objects.');
  if (value.length > DATASET_LIMITS.rows) throw limitError(`Datasets must contain at most ${DATASET_LIMITS.rows} data rows.`);
  const first = value[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) throw inputError('JSON datasets must be an array of flat objects.');
  const rawColumns = Object.keys(first);
  const columns = assertColumns(rawColumns);
  if (rawColumns.some((column, index) => column !== columns[index])) {
    throw inputError('JSON column names must already be trimmed and Unicode-normalized.');
  }
  const rows = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw inputError('JSON datasets must be an array of flat objects.');
    const object = entry as Record<string, unknown>;
    const keys = Object.keys(object);
    if (keys.length !== columns.length || keys.some((key) => !columns.includes(key))) {
      throw inputError('Every JSON row must contain exactly the same columns.');
    }
    return columns.map((column) => assertCell(object[column]));
  });
  return { format: 'json', columns, rows };
}

export function parseDataset(buffer: Buffer, format: DatasetFormat, maximumBytes = DATASET_LIMITS.uploadBytes): ParsedDataset {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > DATASET_LIMITS.derivedBytes) {
    throw new DatasetInputError('The dataset byte limit is invalid.', 'INVALID_DATASET_FILE', 400);
  }
  const text = decodeUtf8(buffer, maximumBytes);
  return format === 'csv' ? parseCsvText(text) : parseJsonText(text);
}

function missing(value: DatasetCell): boolean {
  return value === null || (typeof value === 'string' && value.trim() === '');
}

function typeOf(value: DatasetCell): Exclude<DatasetColumnAnalysis['inferredType'], 'empty' | 'mixed'> {
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  const normalized = String(value).trim();
  if (/^[+-]?\d+$/.test(normalized) && Number.isSafeInteger(Number(normalized))) return 'integer';
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized) && Number.isFinite(Number(normalized))) return 'number';
  if (/^(?:true|false)$/i.test(normalized)) return 'boolean';
  if (isoDate.test(normalized) && Number.isFinite(Date.parse(normalized))) return 'date';
  return 'string';
}

function stableCell(value: DatasetCell): string {
  return `${value === null ? 'null' : typeof value}:${String(value)}`;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function numericValue(value: DatasetCell): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const upperWeight = index - lower;
  return sorted[lower] * (1 - upperWeight) + sorted[upper] * upperWeight;
}

function normalizedNumericSummary(numbers: number[]): { min: number; max: number; mean: number; standardDeviation: number; outlierCount: number } {
  const scale = Math.max(...numbers.map((value) => Math.abs(value)));
  const normalized = scale === 0 ? numbers.map(() => 0) : numbers.map((value) => value / scale);
  const normalizedMean = normalized.reduce((sum, value) => sum + value, 0) / normalized.length;
  const normalizedDeviation = Math.sqrt(normalized.reduce((sum, value) => sum + ((value - normalizedMean) ** 2), 0) / normalized.length);
  const sorted = [...normalized].sort((left, right) => left - right);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;
  return {
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    mean: rounded(Math.max(-1, Math.min(1, normalizedMean)) * scale),
    standardDeviation: rounded(Math.min(1, normalizedDeviation) * scale),
    outlierCount: iqr === 0 ? 0 : normalized.filter((value) => value < q1 - 1.5 * iqr || value > q3 + 1.5 * iqr).length,
  };
}

export function analyzeDataset(parsed: ParsedDataset): DatasetAnalysis {
  const rowKeys = new Map<string, number>();
  for (const row of parsed.rows) {
    const key = createHash('sha256').update(JSON.stringify(row.map(stableCell))).digest('hex');
    rowKeys.set(key, (rowKeys.get(key) || 0) + 1);
  }
  const duplicateRowCount = [...rowKeys.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  let missingCellCount = 0;
  const numericColumns: Array<{ index: number; name: string }> = [];
  const columns = parsed.columns.map((name, columnIndex): DatasetColumnAnalysis => {
    const values = parsed.rows.map((row) => row[columnIndex]);
    const present = values.filter((value) => !missing(value));
    const missingCount = values.length - present.length;
    missingCellCount += missingCount;
    const kinds = new Set(present.map(typeOf));
    let inferredType: DatasetColumnAnalysis['inferredType'];
    if (!kinds.size) inferredType = 'empty';
    else if ([...kinds].every((kind) => kind === 'integer')) inferredType = 'integer';
    else if ([...kinds].every((kind) => kind === 'integer' || kind === 'number')) inferredType = 'number';
    else inferredType = kinds.size === 1 ? [...kinds][0] : 'mixed';
    const counts = new Map<string, number>();
    for (const value of present) {
      const label = String(value);
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    const categories = [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, DATASET_LIMITS.categoryValues)
      .map(([value, count]) => ({ value: value.slice(0, 200), count }));
    const result: DatasetColumnAnalysis = {
      name, inferredType, missingCount, nonMissingCount: present.length, uniqueCount: counts.size, categories,
    };
    if (inferredType === 'integer' || inferredType === 'number') {
      const numbers = present.map(numericValue).filter((value): value is number => value !== undefined);
      if (numbers.length) {
        const summary = normalizedNumericSummary(numbers);
        result.numeric = { min: summary.min, max: summary.max, mean: summary.mean, standardDeviation: summary.standardDeviation };
        result.outlierCount = summary.outlierCount;
        if (numericColumns.length < DATASET_LIMITS.correlationColumns) numericColumns.push({ index: columnIndex, name });
      }
    }
    return result;
  });

  const correlations: DatasetAnalysis['correlations'] = [];
  for (let leftIndex = 0; leftIndex < numericColumns.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < numericColumns.length; rightIndex += 1) {
      const left = numericColumns[leftIndex];
      const right = numericColumns[rightIndex];
      const pairs = parsed.rows.map((row) => [numericValue(row[left.index]), numericValue(row[right.index])] as const)
        .filter((pair): pair is readonly [number, number] => pair[0] !== undefined && pair[1] !== undefined);
      if (pairs.length < 2) continue;
      const leftScale = Math.max(...pairs.map((pair) => Math.abs(pair[0])));
      const rightScale = Math.max(...pairs.map((pair) => Math.abs(pair[1])));
      const scaledPairs = pairs.map((pair) => [leftScale === 0 ? 0 : pair[0] / leftScale, rightScale === 0 ? 0 : pair[1] / rightScale] as const);
      const leftMean = scaledPairs.reduce((sum, pair) => sum + pair[0], 0) / scaledPairs.length;
      const rightMean = scaledPairs.reduce((sum, pair) => sum + pair[1], 0) / scaledPairs.length;
      const numerator = scaledPairs.reduce((sum, pair) => sum + (pair[0] - leftMean) * (pair[1] - rightMean), 0);
      const denominator = Math.sqrt(
        scaledPairs.reduce((sum, pair) => sum + ((pair[0] - leftMean) ** 2), 0)
        * scaledPairs.reduce((sum, pair) => sum + ((pair[1] - rightMean) ** 2), 0)
      );
      if (denominator > 0) correlations.push({ left: left.name, right: right.name, coefficient: rounded(numerator / denominator), pairedRows: pairs.length });
    }
  }

  const suggestions: string[] = [];
  if (missingCellCount) suggestions.push(`${missingCellCount} missing cell${missingCellCount === 1 ? '' : 's'} detected; review a missing-value strategy before training.`);
  if (duplicateRowCount) suggestions.push(`${duplicateRowCount} duplicate row${duplicateRowCount === 1 ? '' : 's'} detected; create a derived copy to remove duplicates.`);
  const outliers = columns.filter((column) => (column.outlierCount || 0) > 0);
  if (outliers.length) suggestions.push(`Potential IQR outliers were detected in: ${outliers.map((column) => column.name).join(', ')}.`);
  if (!suggestions.length) suggestions.push('No missing values, duplicate rows, or IQR outliers were detected within the analyzed limits.');

  let previewTruncatedCellCount = 0;
  const preview = parsed.rows.slice(0, DATASET_LIMITS.previewRows).map((row) => Object.fromEntries(parsed.columns.map((column, index) => {
    const value = row[index];
    if (typeof value === 'string' && value.length > DATASET_LIMITS.previewCellCharacters) {
      previewTruncatedCellCount += 1;
      return [column, value.slice(0, DATASET_LIMITS.previewCellCharacters)];
    }
    return [column, value];
  })));

  return {
    schemaVersion: 1,
    rowCount: parsed.rows.length,
    columnCount: parsed.columns.length,
    duplicateRowCount,
    missingCellCount,
    columns,
    correlations,
    preview,
    previewTruncatedCellCount,
    suggestions: suggestions.map((suggestion) => suggestion.slice(0, DATASET_LIMITS.suggestionCharacters)),
  };
}

function escapeCsvCell(value: DatasetCell, spreadsheetSafe: boolean): string {
  let text = value === null ? '' : String(value);
  if (spreadsheetSafe && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function spreadsheetSafeCell(value: DatasetCell): DatasetCell {
  return typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export interface DatasetTransform {
  trimStrings: boolean;
  dropDuplicateRows: boolean;
  dropRowsWithMissingValues: boolean;
  escapeSpreadsheetFormulas: boolean;
}

export function deriveDataset(parsed: ParsedDataset, transform: DatasetTransform): { parsed: ParsedDataset; buffer: Buffer } {
  const seen = new Set<string>();
  const rows: DatasetCell[][] = [];
  for (const sourceRow of parsed.rows) {
    const row = sourceRow.map((value) => transform.trimStrings && typeof value === 'string' ? value.trim() : value);
    if (transform.dropRowsWithMissingValues && row.some(missing)) continue;
    const key = JSON.stringify(row.map(stableCell));
    if (transform.dropDuplicateRows && seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  const escapedColumns = parsed.format === 'csv' && transform.escapeSpreadsheetFormulas
    ? parsed.columns.map((column) => String(spreadsheetSafeCell(column)))
    : [...parsed.columns];
  if (new Set(escapedColumns).size !== escapedColumns.length) {
    throw inputError('Spreadsheet-formula escaping would create duplicate column names.');
  }
  const derived: ParsedDataset = {
    format: parsed.format,
    columns: escapedColumns,
    rows: parsed.format === 'csv' && transform.escapeSpreadsheetFormulas
      ? rows.map((row) => row.map(spreadsheetSafeCell))
      : rows,
  };
  if (parsed.format === 'json') {
    return { parsed: derived, buffer: Buffer.from(`${JSON.stringify(rows.map((row) => Object.fromEntries(parsed.columns.map((column, index) => [column, row[index]]))))}\n`, 'utf8') };
  }
  const lines = [derived.columns.map((value) => escapeCsvCell(value, false)).join(',')];
  for (const row of derived.rows) lines.push(row.map((value) => escapeCsvCell(value, false)).join(','));
  return { parsed: derived, buffer: Buffer.from(`${lines.join('\n')}\n`, 'utf8') };
}
