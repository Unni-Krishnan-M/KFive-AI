import { Types } from 'mongoose';
import { analyzeDataset, parseDataset } from '@/services/datasetAnalysis';
import { DatasetModel } from './Dataset';

function validDataset() {
  const id = new Types.ObjectId();
  return new DatasetModel({
    _id: id,
    ownerId: new Types.ObjectId(),
    rootDatasetId: id,
    generation: 0,
    kind: 'original',
    name: 'Scores',
    originalName: 'scores.csv',
    format: 'csv',
    mimeType: 'text/csv',
    byteCount: 15,
    sha256: 'a'.repeat(64),
    storageKey: 'originals/123e4567-e89b-12d3-a456-426614174000.csv',
    transform: {
      trimStrings: false,
      dropDuplicateRows: false,
      dropRowsWithMissingValues: false,
      escapeSpreadsheetFormulas: false,
    },
    analysis: analyzeDataset(parseDataset(Buffer.from('name,score\nAda,10\n'), 'csv')),
  });
}

describe('Dataset model', () => {
  it('validates a bounded immutable dataset record', async () => {
    await expect(validDataset().validate()).resolves.toBeUndefined();
  });

  it('rejects unsafe metadata and analysis outside persisted bounds', async () => {
    const invalidHash = validDataset();
    invalidHash.sha256 = 'not-a-hash';
    await expect(invalidHash.validate()).rejects.toThrow('is invalid');

    const invalidPreview = validDataset();
    invalidPreview.analysis!.preview = Array.from({ length: 51 }, () => ({ name: 'Ada', score: '10' }));
    await expect(invalidPreview.validate()).rejects.toThrow('Dataset preview is invalid');

    const invalidCoefficient = validDataset();
    invalidCoefficient.analysis!.correlations = [{ left: 'a', right: 'b', coefficient: 2, pairedRows: 2 }] as any;
    await expect(invalidCoefficient.validate()).rejects.toThrow('more than maximum allowed value');

    const oversizedPreviewCell = validDataset();
    oversizedPreviewCell.analysis!.preview = [{ name: 'x'.repeat(501), score: '10' }];
    await expect(oversizedPreviewCell.validate()).rejects.toThrow('Dataset preview is invalid');

    const inconsistentShape = validDataset();
    inconsistentShape.analysis!.columnCount = 1;
    await expect(inconsistentShape.validate()).rejects.toThrow('Dataset analysis shape is inconsistent');
  });

  it('rejects inconsistent source metadata and original/derived lineage', async () => {
    const wrongRoot = validDataset();
    wrongRoot.rootDatasetId = new Types.ObjectId();
    await expect(wrongRoot.validate()).rejects.toThrow('Original dataset lineage is invalid');

    const wrongMime = validDataset();
    wrongMime.mimeType = 'application/json';
    await expect(wrongMime.validate()).rejects.toThrow('Dataset format metadata is inconsistent');

    const derivedWithoutTransform = validDataset();
    derivedWithoutTransform.kind = 'derived';
    derivedWithoutTransform.parentDatasetId = new Types.ObjectId();
    derivedWithoutTransform.rootDatasetId = new Types.ObjectId();
    derivedWithoutTransform.generation = 1;
    await expect(derivedWithoutTransform.validate()).rejects.toThrow('Derived dataset lineage is invalid');
  });

  it('keeps storage private and declares owner/project/lineage indexes', () => {
    expect(DatasetModel.schema.path('storageKey').options.select).toBe(false);
    for (const field of ['ownerId', 'projectId', 'parentDatasetId', 'rootDatasetId', 'kind', 'sha256', 'storageKey']) {
      expect(DatasetModel.schema.path(field).options.immutable).toBe(true);
    }
    expect(DatasetModel.schema.indexes().map(([fields]) => fields)).toEqual(expect.arrayContaining([
      { ownerId: 1, createdAt: -1 },
      { ownerId: 1, projectId: 1, createdAt: -1 },
      { ownerId: 1, parentDatasetId: 1, createdAt: -1 },
    ]));
  });
});
