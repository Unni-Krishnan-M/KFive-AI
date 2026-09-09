import { NotebookCell } from '@/models/Notebook';
import {
  NotebookError,
  NotebookRecord,
  NotebookRepository,
  NotebookService,
  normalizeNotebookCells,
} from './notebookService';
import { ProjectMutationLease } from './projectMutationLease';

const ownerId = '64b000000000000000000001';
const otherOwner = '64b000000000000000000002';
const projectId = '64b000000000000000000101';
const notebookId = '64b000000000000000000201';
const now = new Date('2026-08-28T00:00:00.000Z');
const cells: NotebookCell[] = [
  { id: 'setup', type: 'code', source: 'x = 2', tags: [] },
  { id: 'result', type: 'code', source: 'print(x + 3)', tags: ['result'] },
];

function record(overrides: Partial<NotebookRecord> = {}): NotebookRecord {
  return { _id: notebookId, ownerId, projectId, title: 'Analysis', cells: structuredClone(cells),
    cellTimeoutSeconds: 10, revision: 1, createdAt: now, updatedAt: now, ...overrides };
}

function repository(seed: NotebookRecord[] = []): NotebookRepository & { records: NotebookRecord[] } {
  const records = seed.map((item) => structuredClone(item));
  return {
    records,
    async list(owner, project, offset, limit) {
      return records.filter((item) => String(item.ownerId) === owner && (project
        ? String(item.projectId) === String(project) : item.projectId === undefined))
        .slice(offset, offset + limit).map((item) => structuredClone(item));
    },
    async countScope(owner, project) {
      return records.filter((item) => String(item.ownerId) === owner && (project
        ? String(item.projectId) === String(project) : item.projectId === undefined)).length;
    },
    async countAll(owner) { return records.filter((item) => String(item.ownerId) === owner).length; },
    async create(data) {
      const created = { ...structuredClone(data), _id: notebookId, createdAt: now, updatedAt: now } as NotebookRecord;
      records.push(created); return structuredClone(created);
    },
    async findByOwnerAndId(owner, id) {
      const found = records.find((item) => String(item.ownerId) === owner && String(item._id) === id);
      return found ? structuredClone(found) : null;
    },
    async updateByRevision(owner, id, revision, changes) {
      const found = records.find((item) => String(item.ownerId) === owner && String(item._id) === id && item.revision === revision);
      if (!found) return null;
      Object.assign(found, structuredClone(changes), { revision: revision + 1, updatedAt: now });
      return structuredClone(found);
    },
    async deleteByRevision(owner, id, revision) {
      const index = records.findIndex((item) => String(item.ownerId) === owner && String(item._id) === id && item.revision === revision);
      return index < 0 ? null : structuredClone(records.splice(index, 1)[0]);
    },
  };
}

function projects(status: 'active' | 'archived' = 'active') {
  return {
    resolveActiveProject: jest.fn().mockImplementation(async (_owner, value) => {
      if (value && status === 'archived') {
        const error: any = new Error('Project is archived.'); error.code = 'PROJECT_ARCHIVED'; error.statusCode = 409; error.isOperational = true;
        throw error;
      }
      return value ? { _id: value, status } : undefined;
    }),
    resolveOwnedProject: jest.fn().mockImplementation(async (_owner, value) => value ? { _id: value, status } : undefined),
  };
}

function service(repo = repository(), projectStore = projects()) {
  const runHistory = { exists: jest.fn().mockResolvedValue(false) };
  return { repo, projectStore, runHistory,
    service: new NotebookService(repo, projectStore as any, new ProjectMutationLease(), runHistory) };
}

describe('NotebookService document editing slice', () => {
  it('validates exact cells with byte limits, unique ids, tags, and safe text', () => {
    expect(normalizeNotebookCells(cells)).toEqual(cells);
    expect(() => normalizeNotebookCells([{ ...cells[0], source: 'é'.repeat(32_769) }])).toThrow('byte limit');
    expect(() => normalizeNotebookCells([cells[0], { ...cells[1], id: cells[0].id }])).toThrow('unique');
    expect(() => normalizeNotebookCells([{ ...cells[0], tags: ['same', 'same'] }])).toThrow('duplicated');
    expect(() => normalizeNotebookCells([{ ...cells[0], source: 'safe\u202Ehidden' }])).toThrow('safe UTF-8');
    expect(() => normalizeNotebookCells([{ ...cells[0], html: '<script>' } as any])).toThrow('keys');
  });

  it('reports persistent editing separately from deliberately gated execution', () => {
    expect(service().service.status()).toEqual(expect.objectContaining({
      editing: { available: true, persistent: true },
      execution: expect.objectContaining({ enabled: false, available: false, isolationVerified: false }),
    }));
  });

  it('creates and lists owner/project-scoped notebooks with immutable scope', async () => {
    const current = service();
    const created = await current.service.create(ownerId, { title: ' Analysis ', cells, projectId, cellTimeoutSeconds: 12 });
    expect(created).toMatchObject({ id: notebookId, projectId, title: 'Analysis', revision: 1, cellTimeoutSeconds: 12 });
    expect(current.projectStore.resolveActiveProject).toHaveBeenCalledWith(ownerId, projectId);
    await expect(current.service.list(ownerId, 1, projectId)).resolves.toMatchObject({
      notebooks: [expect.objectContaining({ id: notebookId })], pagination: { page: 1, total: 1 },
    });
    await expect(current.service.list(otherOwner, 1, projectId)).resolves.toMatchObject({ notebooks: [], pagination: { total: 0 } });
  });

  it('uses optimistic revision CAS for full saves and rejects stale editors', async () => {
    const current = service(repository([record()]));
    await expect(current.service.update(ownerId, notebookId, {
      title: 'Updated', cells: [cells[0]], cellTimeoutSeconds: 5, expectedRevision: 1,
    })).resolves.toMatchObject({ title: 'Updated', revision: 2, cells: [cells[0]] });
    await expect(current.service.update(ownerId, notebookId, {
      title: 'Stale', cells, expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_REVISION_CONFLICT', statusCode: 409 });
  });

  it('keeps archived notebooks readable but blocks create, save, and delete', async () => {
    const current = service(repository([record()]), projects('archived'));
    await expect(current.service.get(ownerId, notebookId)).resolves.toMatchObject({ id: notebookId });
    await expect(current.service.list(ownerId, 1, projectId)).resolves.toMatchObject({ notebooks: [expect.anything()] });
    await expect(current.service.create(ownerId, { title: 'New', cells, projectId })).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
    await expect(current.service.update(ownerId, notebookId, { title: 'No', cells, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
    await expect(current.service.delete(ownerId, notebookId, { expectedRevision: 1 })).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
  });

  it('deletes only the owner record at the expected revision', async () => {
    const current = service(repository([record()]));
    await expect(current.service.delete(otherOwner, notebookId, { expectedRevision: 1 })).rejects.toMatchObject({ code: 'NOTEBOOK_NOT_FOUND' });
    await expect(current.service.delete(ownerId, notebookId, { expectedRevision: 2 })).rejects.toBeInstanceOf(NotebookError);
    await expect(current.service.delete(ownerId, notebookId, { expectedRevision: 1 })).resolves.toEqual({ notebookId, deleted: true });
    expect(current.repo.records).toHaveLength(0);
  });

  it('does not orphan retained execution history', async () => {
    const current = service(repository([record()])); current.runHistory.exists.mockResolvedValue(true);
    await expect(current.service.delete(ownerId, notebookId, { expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'NOTEBOOK_HAS_RUN_HISTORY', statusCode: 409 });
    expect(current.repo.records).toHaveLength(1);
  });

  it('does not misreport storage failures as revision conflicts or missing records', async () => {
    const updateRepo = repository([record()]);
    updateRepo.updateByRevision = jest.fn().mockRejectedValue(new Error('database offline'));
    await expect(service(updateRepo).service.update(ownerId, notebookId, {
      title: 'Updated', cells, expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_STORAGE_UNAVAILABLE', statusCode: 503 });

    const deleteRepo = repository([record()]);
    deleteRepo.deleteByRevision = jest.fn().mockRejectedValue(new Error('database offline'));
    await expect(service(deleteRepo).service.delete(ownerId, notebookId, { expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'NOTEBOOK_STORAGE_UNAVAILABLE', statusCode: 503 });
  });

  it('keeps workspace listings unscoped and validates exact delete input', async () => {
    const workspace = record({ _id: '64b000000000000000000202', projectId: undefined });
    const current = service(repository([record(), workspace]));
    await expect(current.service.list(ownerId, 1)).resolves.toMatchObject({
      notebooks: [expect.objectContaining({ id: '64b000000000000000000202' })], pagination: { total: 1 },
    });
    await expect(current.service.delete(ownerId, notebookId, { expectedRevision: 1, ignored: true }))
      .rejects.toMatchObject({ code: 'INVALID_NOTEBOOK_INPUT', statusCode: 400 });
  });

  it('rejects the terminal revision before a database mutation', async () => {
    const repo = repository([record({ revision: 999_999 })]);
    repo.updateByRevision = jest.fn(repo.updateByRevision);
    await expect(service(repo).service.update(ownerId, notebookId, {
      title: 'No wraparound', cells, expectedRevision: 999_999,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_REVISION_LIMIT_REACHED', statusCode: 409 });
    expect(repo.updateByRevision).not.toHaveBeenCalled();
  });
});
