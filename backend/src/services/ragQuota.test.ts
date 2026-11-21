import { RagSourceModel, RAG_QUOTA_INDEX_NAME } from '@/models/RagSource';
import { mongooseRagSourceRepository, RagSourceCreateData } from './ragService';

const ownerId = '64b000000000000000000001';
const data: RagSourceCreateData = {
  ownerId, sourceKind: 'text', name: 'Quota fixture', mediaType: 'text/plain', status: 'queued',
  characterCount: 5, byteCount: 5, chunkCount: 0, chunkingVersion: 1, contentHash: 'a'.repeat(64),
  contentSnapshot: 'hello', embeddingProvider: 'ollama', embeddingModel: 'fixture',
};
const index = { name: RAG_QUOTA_INDEX_NAME, unique: true, key: { ownerId: 1, quotaSlot: 1 },
  partialFilterExpression: { quotaSlot: { $type: 'number' } } };

describe('atomic Knowledge quota admission', () => {
  afterEach(() => jest.restoreAllMocks());
  function setup(legacy = 0, slots: number[] = []) {
    jest.spyOn(RagSourceModel, 'init').mockResolvedValue(undefined as any);
    const indexes = jest.spyOn(RagSourceModel.collection, 'indexes').mockResolvedValue([index]);
    const find = jest.spyOn(RagSourceModel, 'find').mockImplementation((filter?: any) => ({
      select: () => ({ limit: () => ({ lean: async () => filter.quotaSlot.$exists
        ? slots.map(quotaSlot => ({ quotaSlot })) : Array.from({ length: legacy }, () => ({ _id: 'legacy' })) }) }),
    }) as any);
    const create = jest.spyOn(RagSourceModel, 'create').mockImplementation(async (row: any) => row);
    return { indexes, find, create };
  }

  it('reserves legacy capacity and retries only slot contention', async () => {
    const { create } = setup(197, [197]);
    create.mockRejectedValueOnce({ code: 11000, keyPattern: { ownerId: 1, quotaSlot: 1 } });
    await expect(mongooseRagSourceRepository.create(data)).resolves.toMatchObject({ quotaSlot: 199 });
    expect(create.mock.calls.map(args => (args[0] as any).quotaSlot)).toEqual([198, 199]);
  });

  it.each([200, 201])('preserves %i legacy sources and rejects new admissions', async legacy => {
    const { create } = setup(legacy);
    await expect(mongooseRagSourceRepository.create(data)).rejects.toMatchObject({ code: 'RAG_SOURCE_LIMIT_EXCEEDED', statusCode: 409 });
    expect(create).not.toHaveBeenCalled();
  });

  it('counts slots across every project and status and rejects a full owner', async () => {
    const { create, find } = setup(0, Array.from({ length: 200 }, (_, i) => i));
    await expect(mongooseRagSourceRepository.create(data)).rejects.toMatchObject({ code: 'RAG_SOURCE_LIMIT_EXCEEDED' });
    expect(create).not.toHaveBeenCalled();
    expect(find).toHaveBeenCalledWith({ ownerId, quotaSlot: { $exists: true } });
  });

  it.each([
    { code: 11000, keyPattern: { ownerId: 1, documentId: 1 } },
    { code: 11000 }, new Error('ambiguous write failure'),
  ])('does not retry document uniqueness or ambiguous writes', async error => {
    const { create } = setup(); create.mockRejectedValueOnce(error);
    await expect(mongooseRagSourceRepository.create(data)).rejects.toEqual(error);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([{ supplied: [] }, { supplied: [{ ...index, unique: false }] }, { supplied: [{ ...index, partialFilterExpression: { quotaSlot: { $type: 'number' }, status: 'ready' } }] }])(
    'fails closed without the exact enforcing index', async ({ supplied }) => {
    const { indexes, create } = setup(); indexes.mockResolvedValue(supplied);
    await expect(mongooseRagSourceRepository.create(data)).rejects.toThrow('quota index');
    expect(create).not.toHaveBeenCalled();
  });

  it('validates private immutable integer slots', () => {
    expect(RagSourceModel.schema.path('quotaSlot').options).toMatchObject({ select: false, immutable: true });
    for (const quotaSlot of [-1, 200, 0.5]) {
      expect(new RagSourceModel({ ...data, quotaSlot }).validateSync()?.errors.quotaSlot).toBeDefined();
    }
    expect(new RagSourceModel({ ...data, quotaSlot: 199 }).validateSync()).toBeUndefined();
  });
});
