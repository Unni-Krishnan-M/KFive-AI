import { describe, expect, it } from 'vitest';
import {
  DATASET_DERIVED_LIMIT_BYTES,
  DATASET_UPLOAD_LIMIT_BYTES,
  buildDatasetDerivePayload,
  canMutateDatasets,
  datasetScopeKey,
  effectiveDatasetProjectStatus,
  isDatasetScopeRequestCurrent,
  normalizeDataset,
  normalizeDatasetList,
  normalizeDatasetStatus,
  validateDatasetFile,
} from './datasetLab';

const datasetId = '507f1f77bcf86cd799439011';
const projectId = '507f1f77bcf86cd799439012';
const parentDatasetId = '507f1f77bcf86cd799439013';

const complete = {
  id: datasetId,
  projectId,
  parentDatasetId,
  rootDatasetId: parentDatasetId,
  generation: 1,
  name: 'Clean customers',
  kind: 'derived',
  format: 'csv',
  source: {
    originalName: 'customers-clean.csv',
    mimeType: 'text/csv',
    bytes: 128,
    sha256: 'a'.repeat(64),
  },
  transforms: {
    trimStrings: true,
    dropDuplicateRows: true,
    dropRowsWithMissingValues: false,
    escapeSpreadsheetFormulas: true,
  },
  analysis: {
    schemaVersion: 1,
    rowCount: 2,
    columnCount: 3,
    duplicateRowCount: 0,
    missingCellCount: 1,
    columns: [
      { name: 'name', inferredType: 'string', missingCount: 0, nonMissingCount: 2, uniqueCount: 2, categories: [{ value: 'Ada', count: 1 }] },
      { name: 'score', inferredType: 'number', missingCount: 0, nonMissingCount: 2, uniqueCount: 2, categories: [{ value: '10.5', count: 1 }], numeric: { min: 10.5, max: 20, mean: 15.25, standardDeviation: 4.75 }, outlierCount: 0 },
      { name: 'active', inferredType: 'boolean', missingCount: 1, nonMissingCount: 1, uniqueCount: 1, categories: [{ value: 'true', count: 1 }] },
    ],
    correlations: [],
    preview: [
      { name: 'Ada', score: 10.5, active: true },
      { name: 'Linus', score: 20, active: null },
    ],
    previewTruncatedCellCount: 0,
    suggestions: ['Review one missing value before training.'],
  },
  createdAt: '2026-08-26T10:00:00.000Z',
  updatedAt: '2026-08-26T10:01:00.000Z',
};

describe('Dataset Lab frontend contract', () => {
  it('normalizes status and server-advertised limits without inventing upload permission', () => {
    expect(normalizeDatasetStatus({ data: {
      available: true,
      canUpload: true,
      scope: { type: 'project', projectId, projectStatus: 'active' },
      retention: { used: 4, maximum: 100, limitReached: false },
      limits: { uploadBytes: DATASET_UPLOAD_LIMIT_BYTES, rows: 10_000, columns: 100, previewRows: 50 },
    } })).toEqual({
      available: true,
      canUpload: true,
      scope: { type: 'project', projectId, projectStatus: 'active' },
      retention: { used: 4, maximum: 100, limitReached: false },
      limits: {
        uploadBytes: DATASET_UPLOAD_LIMIT_BYTES,
        derivedBytes: undefined,
        rows: 10_000,
        columns: 100,
        headerCharacters: undefined,
        cellBytes: undefined,
        previewRows: 50,
        previewCellCharacters: undefined,
        datasetsPerOwner: undefined,
      },
    });
    expect(normalizeDatasetStatus({ data: {} })).toMatchObject({ available: undefined, canUpload: false });
  });

  it('normalizes strict detail, typed preview cells, transforms, and correlations', () => {
    const normalized = normalizeDataset({ data: { dataset: {
      ...complete,
      analysis: {
        ...complete.analysis,
        correlations: [{ left: 'score', right: 'active', coefficient: 0.5, pairedRows: 1 }],
      },
    } } });
    expect(normalized).toMatchObject({
      id: datasetId,
      kind: 'derived',
      parentDatasetId,
      transforms: { trimStrings: true, escapeSpreadsheetFormulas: true },
      analysis: {
        rowCount: 2,
        preview: [{ name: 'Ada', score: 10.5, active: true }, { name: 'Linus', score: 20, active: null }],
        correlations: [{ left: 'score', right: 'active', coefficient: 0.5, pairedRows: 1 }],
      },
    });
    expect(normalizeDataset({
      ...complete,
      analysis: { ...complete.analysis, correlations: undefined, corrrelations: [] },
    })).toBeUndefined();
  });

  it('normalizes summaries from the list while requiring detail analysis separately', () => {
    const summary = Object.fromEntries(Object.entries(complete).filter(([key]) => key !== 'analysis'));
    expect(normalizeDatasetList({ data: { datasets: [summary, { id: 'bad' }] } })).toEqual([
      expect.objectContaining({ id: datasetId, name: 'Clean customers', source: expect.objectContaining({ bytes: 128 }) }),
    ]);
    expect(normalizeDataset(summary)).toBeUndefined();
  });

  it('rejects malformed identities, ancestry, digests, schemas, cells, and inconsistent counts', () => {
    expect(normalizeDataset({ ...complete, id: 'dataset-1' })).toBeUndefined();
    expect(normalizeDataset({ ...complete, kind: 'original' })).toBeUndefined();
    expect(normalizeDataset({ ...complete, source: { ...complete.source, sha256: 'bad' } })).toBeUndefined();
    expect(normalizeDataset({ ...complete, analysis: { ...complete.analysis, columnCount: 4 } })).toBeUndefined();
    expect(normalizeDataset({ ...complete, analysis: { ...complete.analysis, columns: complete.analysis.columns.map((column, index) => index ? column : { ...column, missingCount: 2 }) } })).toBeUndefined();
    expect(normalizeDataset({ ...complete, analysis: { ...complete.analysis, preview: [{ name: '<script>', score: Number.NaN, active: true }] } })).toBeUndefined();
  });

  it('allows the advertised derived-file expansion without relaxing original upload size', () => {
    expect(normalizeDataset({ ...complete, source: { ...complete.source, bytes: DATASET_DERIVED_LIMIT_BYTES } })).toBeDefined();
    expect(normalizeDataset({
      ...complete,
      kind: 'original',
      parentDatasetId: undefined,
      rootDatasetId: datasetId,
      generation: 0,
      transforms: {
        trimStrings: false,
        dropDuplicateRows: false,
        dropRowsWithMissingValues: false,
        escapeSpreadsheetFormulas: false,
      },
      source: { ...complete.source, bytes: DATASET_UPLOAD_LIMIT_BYTES + 1 },
    })).toBeUndefined();
  });

  it('validates bounded CSV/JSON metadata before upload', () => {
    expect(validateDatasetFile({ name: 'customers.csv', type: 'text/csv', size: 100 })).toBeUndefined();
    expect(validateDatasetFile({ name: 'customers.json', type: 'application/json', size: 100 })).toBeUndefined();
    expect(validateDatasetFile({ name: 'customers.exe', type: 'application/octet-stream', size: 100 })).toBe('Choose a CSV or JSON dataset.');
    expect(validateDatasetFile({ name: 'customers.csv', type: 'application/json', size: 100 })).toContain('text/csv');
    expect(validateDatasetFile({ name: 'customers.json', type: '', size: 100 })).toContain('application/json');
    expect(validateDatasetFile({ name: 'customers.csv', type: 'text/csv', size: DATASET_UPLOAD_LIMIT_BYTES + 1 })).toContain('smaller');
    expect(validateDatasetFile({ name: 'customers.csv', type: 'text/csv', size: 0 })).toContain('empty');
  });

  it('gates mutations and invalidates stale scope generations', () => {
    expect(canMutateDatasets('active', true, true)).toBe(true);
    expect(canMutateDatasets('archived', true, true)).toBe(false);
    expect(canMutateDatasets('active', false, true)).toBe(false);
    expect(canMutateDatasets('active', true, false)).toBe(false);
    expect(datasetScopeKey(false)).toBe('workspace');
    expect(datasetScopeKey(true)).toBe('project:pending');
    expect(datasetScopeKey(true, projectId)).toBe(`project:${projectId}`);
    expect(isDatasetScopeRequestCurrent(`project:${projectId}`, `project:${projectId}`, 2, 2)).toBe(true);
    expect(isDatasetScopeRequestCurrent('workspace', `project:${projectId}`, 2, 2)).toBe(false);
    expect(isDatasetScopeRequestCurrent(`project:${projectId}`, `project:${projectId}`, 3, 2)).toBe(false);
    expect(effectiveDatasetProjectStatus('active', 'archived')).toBe('archived');
    expect(effectiveDatasetProjectStatus('archived', 'active')).toBe('active');
    expect(effectiveDatasetProjectStatus('archived', 'unexpected')).toBe('archived');
  });

  it('builds the exact nested derive request without adding fields', () => {
    expect(buildDatasetDerivePayload(' Clean copy ', complete.transforms)).toEqual({
      name: 'Clean copy',
      transform: {
        trimStrings: true,
        dropDuplicateRows: true,
        dropRowsWithMissingValues: false,
        escapeSpreadsheetFormulas: true,
      },
    });
  });
});
