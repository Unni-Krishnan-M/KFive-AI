import { RagSourceModel } from './RagSource';
import { mongooseRagSourceRepository } from '@/services/ragService';

describe('RagSource model', () => {
  it('enforces owner/project indexes and bounded safe metadata fields', () => {
    const indexes = RagSourceModel.schema.indexes().map(([fields]) => fields);
    expect(indexes).toEqual(expect.arrayContaining([
      { ownerId: 1, projectId: 1, createdAt: -1 },
      { ownerId: 1, status: 1, updatedAt: -1 },
      { ownerId: 1, contentHash: 1, embeddingProvider: 1, embeddingModel: 1 },
    ]));
    expect(RagSourceModel.schema.path('ownerId').options.immutable).toBe(true);
    expect(RagSourceModel.schema.path('chunkCount').options.max).toBe(64);
    expect(RagSourceModel.schema.path('byteCount').options.max).toBe(65_536);
    expect(RagSourceModel.schema.path('chunkingVersion').options.enum).toEqual([1]);
    expect(RagSourceModel.schema.path('content')).toBeUndefined();
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
