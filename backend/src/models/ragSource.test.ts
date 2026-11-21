import { RagSourceModel } from './RagSource';
import { mongooseRagSourceRepository } from '@/services/ragService';

describe('RagSource model', () => {
  it('keeps recovery text private and bounds bytes rather than UTF-16 character length', () => {
    expect(RagSourceModel.schema.path('contentSnapshot').options.select).toBe(false);
    const accepted = new RagSourceModel({ contentSnapshot: 'é'.repeat(32_768) }).validateSync();
    expect(accepted?.errors.contentSnapshot).toBeUndefined();
    const rejected = new RagSourceModel({ contentSnapshot: 'é'.repeat(32_769) }).validateSync();
    expect(rejected?.errors.contentSnapshot).toBeDefined();
  });

  it('enforces owner/project indexes and bounded safe metadata fields', () => {
    const indexes = RagSourceModel.schema.indexes().map(([fields]) => fields);
    expect(indexes).toEqual(expect.arrayContaining([
      { ownerId: 1, projectId: 1, createdAt: -1 },
      { ownerId: 1, status: 1, updatedAt: -1 },
      { ownerId: 1, contentHash: 1, embeddingProvider: 1, embeddingModel: 1 },
      { ownerId: 1, documentId: 1 },
    ]));
    expect(RagSourceModel.schema.path('ownerId').options.immutable).toBe(true);
    expect(RagSourceModel.schema.path('chunkCount').options.max).toBe(64);
    expect(RagSourceModel.schema.path('byteCount').options.max).toBe(65_536);
    expect(RagSourceModel.schema.path('chunkingVersion').options.enum).toEqual([1]);
    expect(RagSourceModel.schema.path('documentId').options.immutable).toBe(true);
    expect(RagSourceModel.schema.path('sourceKind').options.enum).toEqual(['text', 'document']);
    expect(RagSourceModel.schema.path('content')).toBeUndefined();
  });

  it('removes private retry text atomically with ready publication', async () => {
    const update = jest.spyOn(RagSourceModel, 'findOneAndUpdate').mockReturnValue({ lean: jest.fn().mockResolvedValue(null) } as any);
    try {
      await mongooseRagSourceRepository.markReady('64b000000000000000000001', '64b000000000000000000002', {
        chunkCount: 1, embeddingDimension: 2, collectionId: 'collection', collectionName: 'name', indexedAt: new Date(),
      });
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'indexing' }),
        expect.objectContaining({ $set: expect.objectContaining({ status: 'ready' }), $unset: { errorCode: 1, contentSnapshot: 1 } }),
        { new: true, runValidators: true });
    } finally { update.mockRestore(); }
  });

  it('keeps an omitted project filter in the global workspace only', async () => {
    const lean = jest.fn().mockResolvedValue([]);
    const limit = jest.fn().mockReturnValue({ lean });
    const sort = jest.fn().mockReturnValue({ limit });
    const find = jest.spyOn(RagSourceModel, 'find').mockReturnValue({ sort } as any);
    await mongooseRagSourceRepository.list('64b000000000000000000001');
    expect(find).toHaveBeenCalledWith({
      ownerId: '64b000000000000000000001',
      projectId: { $exists: false },
    });
  });
});
