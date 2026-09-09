import { NotebookRunRecord, NotebookRunRepository, NotebookRunService } from './notebookRunService';
import { ProjectMutationLease } from './projectMutationLease';

const ownerId = '64b000000000000000000001';
const otherOwner = '64b000000000000000000002';
const projectId = '64b000000000000000000101';
const notebookId = '64b000000000000000000201';
const runId = '64b000000000000000000301';
const now = new Date('2026-09-01T00:00:00.000Z');
const notebook = { id: notebookId, projectId, title: 'Analysis', revision: 3, cellTimeoutSeconds: 10,
  cells: [{ id: 'cell_one', type: 'code' as const, source: 'print(1)', tags: [] }] };

function run(overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord {
  return { _id: runId, ownerId, notebookId, projectId, notebookRevision: 3, snapshotSha256: 'a'.repeat(64),
    cells: structuredClone(notebook.cells), cellTimeoutSeconds: 10, jobId: `notebook-${runId}`, status: 'queued',
    activeOwnerSlot: true, revision: 1, metrics: [], artifacts: [], timeline: [
      { revision: 1, sequence: 1, type: 'created', timestamp: now },
    ], queuedAt: now, createdAt: now, updatedAt: now, ...overrides };
}

function repository(seed: NotebookRunRecord[] = []): NotebookRunRepository & { records: NotebookRunRecord[] } {
  const records = seed.map((item) => structuredClone(item));
  return {
    records,
    async countAll(owner) { return records.filter((item) => String(item.ownerId) === owner).length; },
    async create(data) { const created = { ...structuredClone(data), _id: runId, createdAt: now, updatedAt: now };
      records.push(created); return structuredClone(created); },
    async list(owner, notebookValue, offset, limit) { return records.filter((item) => String(item.ownerId) === owner
      && String(item.notebookId) === notebookValue).slice(offset, offset + limit).map((item) => structuredClone(item)); },
    async countNotebook(owner, notebookValue) { return records.filter((item) => String(item.ownerId) === owner
      && String(item.notebookId) === notebookValue).length; },
    async findOwned(owner, notebookValue, id) { const found = records.find((item) => String(item.ownerId) === owner
      && String(item.notebookId) === notebookValue && String(item._id) === id); return found ? structuredClone(found) : null; },
    async cancelQueued(owner, notebookValue, id, at) { const found = records.find((item) => String(item.ownerId) === owner
      && String(item.notebookId) === notebookValue && String(item._id) === id && item.status === 'queued');
      if (!found) return null; Object.assign(found, { status: 'cancelled', activeOwnerSlot: false, completedAt: at, revision: 2 });
      return structuredClone(found); },
    async requestCancel(owner, notebookValue, id, at) { const found = records.find((item) => String(item.ownerId) === owner
      && String(item.notebookId) === notebookValue && String(item._id) === id && ['running', 'verifying'].includes(item.status));
      if (!found) return null; Object.assign(found, { status: 'cancel-requested', cancelRequestedAt: at, revision: 2 });
      return structuredClone(found); },
    async markEnqueueFailure(owner, id, at) { const found = records.find((item) => String(item.ownerId) === owner && String(item._id) === id);
      if (found) Object.assign(found, { status: 'interrupted', activeOwnerSlot: false, completedAt: at }); },
    async deleteTerminal(owner, notebookValue, id) { const index = records.findIndex((item) => String(item.ownerId) === owner
      && String(item.notebookId) === notebookValue && String(item._id) === id
      && ['succeeded', 'failed', 'cancelled', 'timed_out', 'resource_exceeded', 'interrupted'].includes(item.status));
      return index < 0 ? null : structuredClone(records.splice(index, 1)[0]); },
    async recoverStale(cutoff, at) { let count = 0; for (const item of records) {
      if (['running', 'verifying', 'cancel-requested'].includes(item.status) && item.activeOwnerSlot
        && (item.execution?.heartbeatAt ?? item.updatedAt ?? item.queuedAt) < cutoff) {
        Object.assign(item, { status: 'interrupted', activeOwnerSlot: false, completedAt: at }); count += 1;
      }
    } return count; },
  };
}

function fixture(seed: NotebookRunRecord[] = [], enabled = true) {
  const repo = repository(seed);
  const notebooks = { get: jest.fn().mockImplementation(async (owner: string) => {
    if (owner !== ownerId) { const error: any = new Error('not found'); error.code = 'NOTEBOOK_NOT_FOUND'; error.statusCode = 404; error.isOperational = true; throw error; }
    return structuredClone(notebook);
  }) };
  const projects = { resolveActiveProject: jest.fn().mockResolvedValue({ _id: projectId, status: 'active' }) };
  const queue = { executionStatus: jest.fn().mockResolvedValue({ workerAvailable: true, isolationVerified: true,
    runtimeImageId: 'a'.repeat(64), verifierImageId: 'b'.repeat(64) }),
  enqueue: jest.fn().mockResolvedValue(undefined), remove: jest.fn().mockResolvedValue(undefined),
  wakeCancellation: jest.fn().mockResolvedValue(undefined) };
  return { repo, notebooks, projects, queue, service: new NotebookRunService(repo, notebooks as any, projects as any, queue,
    new ProjectMutationLease(), () => now, () => enabled, () => runId) };
}

describe('NotebookRunService', () => {
  it('reports editing independently and never claims disabled execution is available', async () => {
    await expect(fixture([], false).service.status()).resolves.toMatchObject({ editing: { available: true, persistent: true },
      execution: { enabled: false, available: false, isolationVerified: false } });
  });

  it('queues only the authenticated saved revision with an immutable snapshot', async () => {
    const current = fixture();
    const created = await current.service.start(ownerId, notebookId, { expectedRevision: 3 });
    expect(created).toMatchObject({ notebookId, notebookRevision: 3, status: 'queued' });
    expect(created.snapshotSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(current.repo.records[0]).toMatchObject({ ownerId, projectId, cells: notebook.cells, activeOwnerSlot: true });
    expect(current.queue.enqueue).toHaveBeenCalledWith(runId);
    await expect(current.service.start(ownerId, notebookId, { expectedRevision: 2 }))
      .rejects.toMatchObject({ code: 'NOTEBOOK_RUN_CONFLICT', statusCode: 409 });
    await expect(current.service.start(ownerId, notebookId, { expectedRevision: 3, source: 'changed' }))
      .rejects.toMatchObject({ code: 'INVALID_NOTEBOOK_RUN_INPUT', statusCode: 400 });
  });

  it('does not create work when the verified worker boundary is unavailable', async () => {
    const current = fixture(); current.queue.executionStatus.mockResolvedValue({ workerAvailable: true, isolationVerified: false });
    await expect(current.service.start(ownerId, notebookId, { expectedRevision: 3 }))
      .rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_UNAVAILABLE', statusCode: 503 });
    expect(current.repo.records).toHaveLength(0);
  });

  it('terminalizes queue admission failure and releases the owner slot', async () => {
    const current = fixture(); current.queue.enqueue.mockRejectedValue(new Error('redis offline'));
    await expect(current.service.start(ownerId, notebookId, { expectedRevision: 3 }))
      .rejects.toMatchObject({ code: 'NOTEBOOK_RUN_QUEUE_UNAVAILABLE', statusCode: 503 });
    expect(current.repo.records[0]).toMatchObject({ status: 'interrupted', activeOwnerSlot: false });
  });

  it('cancels queued work canonically before best-effort queue removal', async () => {
    const current = fixture([run()]);
    await expect(current.service.cancel(ownerId, notebookId, runId)).resolves.toMatchObject({
      run: { status: 'cancelled' }, idempotent: false,
    });
    expect(current.queue.remove).toHaveBeenCalledWith(runId);
    await expect(current.service.cancel(ownerId, notebookId, runId)).resolves.toMatchObject({ idempotent: true });
  });

  it('requests cross-process cancellation for running work and enforces owner scope', async () => {
    const current = fixture([run({ status: 'running' })]);
    await expect(current.service.cancel(ownerId, notebookId, runId)).resolves.toMatchObject({
      run: { status: 'cancel-requested' }, idempotent: false,
    });
    expect(current.queue.wakeCancellation).toHaveBeenCalledWith(runId);
    await expect(current.service.get(otherOwner, notebookId, runId)).rejects.toMatchObject({ code: 'NOTEBOOK_RUN_NOT_FOUND' });
  });

  it('lists metadata and only deletes terminal runs', async () => {
    const current = fixture([run({ status: 'succeeded', activeOwnerSlot: false, executedNotebookJson: '{"cells":[]}' })]);
    const page = await current.service.list(ownerId, notebookId, 1);
    expect(page).toMatchObject({ runs: [expect.objectContaining({ id: runId, status: 'succeeded' })], pagination: { total: 1 } });
    expect(page.runs[0]).not.toHaveProperty('executedNotebook');
    await expect(current.service.get(ownerId, notebookId, runId)).resolves.toMatchObject({ executedNotebook: { cells: [] } });
    await expect(current.service.delete(ownerId, notebookId, runId)).resolves.toEqual({ runId, deleted: true });
  });

  it('recovers only stale uncertain active work without retrying it', async () => {
    const stale = new Date(now.getTime() - 180_000); const current = fixture([
      run({ status: 'running', updatedAt: stale, execution: { workerId: 'lost', heartbeatAt: stale } }),
      run({ _id: '64b000000000000000000302', status: 'queued', updatedAt: stale }),
    ]);
    await expect(current.service.recoverInterrupted()).resolves.toBe(1);
    expect(current.repo.records.map((item) => item.status)).toEqual(['interrupted', 'queued']);
  });
});
