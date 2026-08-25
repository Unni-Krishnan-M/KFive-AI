import axios, { AxiosInstance } from 'axios';
import {
  CHROMA_MAX_DOCUMENT_LENGTH,
  CHROMA_MAX_EMBEDDING_DIMENSION,
  CHROMA_MAX_RECORDS,
  ChromaClient,
  ChromaClientError,
  ChromaUpsertRecord,
} from './chromaClient';

const COLLECTION_ID = '123e4567-e89b-12d3-a456-426614174000';

function createTransport() {
  return {
    get: jest.fn(),
    post: jest.fn(),
  };
}

function createClient(transport: ReturnType<typeof createTransport>, overrides = {}) {
  return new ChromaClient(
    { baseUrl: 'http://chromadb.test:8000', ...overrides },
    transport as unknown as AxiosInstance
  );
}

function expectCode(action: Promise<unknown>, code: ChromaClientError['code']) {
  return expect(action).rejects.toMatchObject({ name: 'ChromaClientError', code });
}

describe('ChromaClient', () => {
  it('creates a bounded credential-free Axios transport when one is not injected', () => {
    const transport = createTransport();
    const create = jest.spyOn(axios, 'create').mockReturnValue(transport as unknown as AxiosInstance);

    new ChromaClient({ baseUrl: 'https://vectors.example.test/api/v1/' });

    expect(create).toHaveBeenCalledWith({
      baseURL: 'https://vectors.example.test',
      timeout: 5_000,
      maxContentLength: 4 * 1024 * 1024,
      maxBodyLength: 4 * 1024 * 1024,
      headers: { 'Content-Type': 'application/json' },
    });
    create.mockRestore();
  });

  it('validates the pinned v1 heartbeat and pre-flight contracts', async () => {
    const transport = createTransport();
    transport.get
      .mockResolvedValueOnce({ data: { 'nanosecond heartbeat': 1_724_000_000_000_000_000 } })
      .mockResolvedValueOnce({ data: { max_batch_size: 41_666 } });
    const client = createClient(transport);

    await expect(client.healthCheck()).resolves.toBe(true);
    await expect(client.getMaxBatchSize()).resolves.toBe(41_666);
    expect(transport.get.mock.calls).toEqual([
      ['/api/v1/heartbeat'],
      ['/api/v1/pre-flight-checks'],
    ]);
  });

  it('sends explicit tenant/database defaults when creating or getting a collection', async () => {
    const transport = createTransport();
    const response = {
      id: COLLECTION_ID,
      name: 'project.docs',
      metadata: { 'hnsw:space': 'cosine', schema: 1 },
      tenant: 'default_tenant',
      database: 'default_database',
    };
    transport.post.mockResolvedValue({ data: response });
    transport.get.mockResolvedValue({ data: response });
    const client = createClient(transport);

    await expect(client.getOrCreateCollection('project.docs', {
      'hnsw:space': 'cosine',
      schema: 1,
    })).resolves.toEqual(response);
    await expect(client.getCollection('project.docs')).resolves.toEqual(response);

    expect(transport.post).toHaveBeenCalledWith(
      '/api/v1/collections',
      {
        name: 'project.docs',
        metadata: { 'hnsw:space': 'cosine', schema: 1 },
        get_or_create: true,
      },
      { params: { tenant: 'default_tenant', database: 'default_database' } }
    );
    expect(transport.get).toHaveBeenCalledWith(
      '/api/v1/collections/project.docs',
      { params: { tenant: 'default_tenant', database: 'default_database' } }
    );
  });

  it('uses configured tenant/database and normalizes a base URL already ending in api/v1', async () => {
    const transport = createTransport();
    transport.get.mockResolvedValue({ data: {
      id: COLLECTION_ID,
      name: 'safe-name',
      metadata: null,
    } });
    const client = new ChromaClient({
      baseUrl: 'https://vectors.example.test/api/v1/',
      tenant: 'tenant-a',
      database: 'database-a',
    }, transport as unknown as AxiosInstance);

    await client.getCollection('safe-name');
    expect(transport.get).toHaveBeenCalledWith(
      '/api/v1/collections/safe-name',
      { params: { tenant: 'tenant-a', database: 'database-a' } }
    );
  });

  it('maps records to the exact column-oriented 0.4.24 upsert payload', async () => {
    const transport = createTransport();
    transport.post.mockResolvedValue({ data: null });
    const client = createClient(transport);
    const records: ChromaUpsertRecord[] = [
      { id: 'chunk-1', embedding: [0.1, 0.2], document: 'First', metadata: { page: 1 } },
      { id: 'chunk-2', embedding: [0.3, 0.4], document: 'Second' },
    ];

    await expect(client.upsert(COLLECTION_ID, records)).resolves.toBeUndefined();
    expect(transport.post).toHaveBeenCalledWith(
      `/api/v1/collections/${COLLECTION_ID}/upsert`,
      {
        ids: ['chunk-1', 'chunk-2'],
        embeddings: [[0.1, 0.2], [0.3, 0.4]],
        metadatas: [{ page: 1 }, null],
        documents: ['First', 'Second'],
        uris: null,
      }
    );
    expect(records[0].embedding).toEqual([0.1, 0.2]);
  });

  it('sends a single raw embedding query and strictly flattens its first result set', async () => {
    const transport = createTransport();
    transport.post.mockResolvedValue({ data: {
      ids: [['chunk-2', 'chunk-1']],
      documents: [['Second', null]],
      metadatas: [[{ page: 2 }, null]],
      distances: [[0.04, 0.2]],
    } });
    const client = createClient(transport);

    await expect(client.query(COLLECTION_ID, {
      embedding: [0.1, 0.2],
      nResults: 2,
      where: { projectId: 'project-1' },
    })).resolves.toEqual({
      ids: ['chunk-2', 'chunk-1'],
      documents: ['Second', null],
      metadatas: [{ page: 2 }, null],
      distances: [0.04, 0.2],
    });
    expect(transport.post).toHaveBeenCalledWith(
      `/api/v1/collections/${COLLECTION_ID}/query`,
      {
        query_embeddings: [[0.1, 0.2]],
        n_results: 2,
        where: { projectId: 'project-1' },
        where_document: {},
        include: ['documents', 'metadatas', 'distances'],
      }
    );
  });

  it('deletes only through an explicit where selector and validates returned IDs', async () => {
    const transport = createTransport();
    transport.post.mockResolvedValue({ data: null });
    const client = createClient(transport);

    await expect(client.deleteWhere(COLLECTION_ID, { documentId: 'doc-1' }))
      .resolves.toBeUndefined();
    expect(transport.post).toHaveBeenCalledWith(
      `/api/v1/collections/${COLLECTION_ID}/delete`,
      { ids: null, where: { documentId: 'doc-1' }, where_document: null }
    );
    await expectCode(client.deleteWhere(COLLECTION_ID, {}), 'INVALID_ARGUMENT');

    transport.post.mockResolvedValueOnce({ data: ['chunk-1'] });
    await expect(client.deleteWhere(COLLECTION_ID, { documentId: 'doc-2' }))
      .resolves.toBeUndefined();
  });

  it('rejects unsafe names, IDs, URLs, collection IDs, and metadata before transport', async () => {
    const transport = createTransport();
    const client = createClient(transport);

    await expectCode(client.getOrCreateCollection('../unsafe'), 'INVALID_ARGUMENT');
    await expectCode(client.upsert('not-a-uuid', [{ id: 'ok', embedding: [1], document: '' }]), 'INVALID_ARGUMENT');
    await expectCode(client.upsert(COLLECTION_ID, [
      { id: 'bad\nidentifier', embedding: [1], document: '' },
    ]), 'INVALID_ARGUMENT');
    await expectCode(client.upsert(COLLECTION_ID, [
      { id: 'ok', embedding: [1], document: '', metadata: { nested: {} as unknown as string } },
    ]), 'INVALID_ARGUMENT');
    expect(() => new ChromaClient({ baseUrl: 'http://user:secret@chromadb.test:8000' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('enforces record, document, dimension, finite number, uniqueness, and result bounds', async () => {
    const transport = createTransport();
    const client = createClient(transport);
    const record = (id: string, embedding = [1]): ChromaUpsertRecord => ({ id, embedding, document: '' });

    await expectCode(client.upsert(COLLECTION_ID,
      Array.from({ length: CHROMA_MAX_RECORDS + 1 }, (_, index) => record(`id-${index}`))
    ), 'INVALID_ARGUMENT');
    await expectCode(client.upsert(COLLECTION_ID, [
      { ...record('one'), document: 'x'.repeat(CHROMA_MAX_DOCUMENT_LENGTH + 1) },
    ]), 'INVALID_ARGUMENT');
    await expectCode(client.upsert(COLLECTION_ID, [
      record('one', new Array(CHROMA_MAX_EMBEDDING_DIMENSION + 1).fill(1)),
    ]), 'INVALID_ARGUMENT');
    await expectCode(client.upsert(COLLECTION_ID, [record('one', [Number.NaN])]), 'INVALID_ARGUMENT');
    await expectCode(client.upsert(COLLECTION_ID, [record('same'), record('same')]), 'INVALID_ARGUMENT');
    await expectCode(client.upsert(COLLECTION_ID, [record('one', [1]), record('two', [1, 2])]), 'INVALID_ARGUMENT');
    await expectCode(client.query(COLLECTION_ID, { embedding: [1], nResults: 101 }), 'INVALID_ARGUMENT');
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('rejects a malformed heartbeat response', async () => {
    const transport = createTransport();
    transport.get.mockResolvedValue({ data: { 'nanosecond heartbeat': 'not-a-number' } });
    await expectCode(createClient(transport).healthCheck(), 'INVALID_RESPONSE');
  });

  it('rejects malformed collection, batch-size, query, and delete responses', async () => {
    const transport = createTransport();
    const client = createClient(transport);

    transport.get.mockResolvedValueOnce({ data: { max_batch_size: 0 } });
    await expectCode(client.getMaxBatchSize(), 'INVALID_RESPONSE');

    transport.get.mockResolvedValueOnce({ data: { max_batch_size: Number.MAX_SAFE_INTEGER + 1 } });
    await expectCode(client.getMaxBatchSize(), 'INVALID_RESPONSE');

    transport.post.mockResolvedValueOnce({ data: { id: 'bad', name: 'safe-name', metadata: null } });
    await expectCode(client.getOrCreateCollection('safe-name'), 'INVALID_RESPONSE');

    transport.post.mockResolvedValueOnce({ data: {
      ids: [['one']], documents: [['doc']], metadatas: [[null]], distances: [[]],
    } });
    await expectCode(client.query(COLLECTION_ID, { embedding: [1], nResults: 1 }), 'INVALID_RESPONSE');

    transport.post.mockResolvedValueOnce({ data: { ids: ['not-an-array'] } });
    await expectCode(client.deleteWhere(COLLECTION_ID, { documentId: 'one' }), 'INVALID_RESPONSE');
  });

  it('rejects oversized query rows and documents from a hostile vector store', async () => {
    const transport = createTransport();
    const client = createClient(transport);

    transport.post.mockResolvedValueOnce({ data: {
      ids: [['one', 'two']],
      documents: [['one', 'two']],
      metadatas: [[null, null]],
      distances: [[0.1, 0.2]],
    } });
    await expectCode(client.query(COLLECTION_ID, { embedding: [1], nResults: 1 }), 'INVALID_RESPONSE');

    transport.post.mockResolvedValueOnce({ data: {
      ids: [['one']],
      documents: [['x'.repeat(CHROMA_MAX_DOCUMENT_LENGTH + 1)]],
      metadatas: [[null]],
      distances: [[0.1]],
    } });
    await expectCode(client.query(COLLECTION_ID, { embedding: [1], nResults: 1 }), 'INVALID_RESPONSE');
  });

  it('normalizes Axios failures without leaking credentials, URLs, or response bodies', async () => {
    const transport = createTransport();
    transport.get.mockRejectedValue({
      isAxiosError: true,
      message: 'request to http://user:secret@private.test failed',
      response: { status: 500, data: { error: 'database-password' } },
    });

    const action = createClient(transport).healthCheck();
    await expectCode(action, 'REQUEST_REJECTED');
    await action.catch((error: ChromaClientError) => {
      expect(error.message).toBe('The Chroma service rejected the request.');
      expect(error.message).not.toMatch(/secret|private|password/i);
    });
  });
});
