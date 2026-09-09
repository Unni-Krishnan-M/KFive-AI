import { NotebookRunModel } from './NotebookRun';

const ownerId = '64b000000000000000000001';
const notebookId = '64b000000000000000000201';
const now = new Date('2026-09-01T00:00:00.000Z');

function valid(overrides: Record<string, unknown> = {}) {
  return {
    ownerId, notebookId, notebookRevision: 1, snapshotSha256: 'a'.repeat(64),
    cells: [{ id: 'cell_one', type: 'code', source: 'print(1)', tags: [] }],
    cellTimeoutSeconds: 10, jobId: `notebook-${notebookId}`, status: 'queued', activeOwnerSlot: true,
    revision: 1, metrics: [], artifacts: [], timeline: [{ revision: 1, sequence: 1, type: 'created', timestamp: now }],
    queuedAt: now, ...overrides,
  };
}

describe('NotebookRun model', () => {
  it('accepts the bounded immutable run snapshot', async () => {
    await expect(new NotebookRunModel(valid()).validate()).resolves.toBeUndefined();
  });

  it('rejects unsafe states, oversized artifacts, and an invalid image identity', async () => {
    await expect(new NotebookRunModel(valid({ status: 'invented' })).validate()).rejects.toThrow();
    await expect(new NotebookRunModel(valid({ artifacts: [{ path: 'artifacts/a.txt', kind: 'text', mimeType: 'text/plain',
      bytes: 1_048_577, sha256: 'b'.repeat(64), data: Buffer.alloc(1) }] })).validate()).rejects.toThrow();
    await expect(new NotebookRunModel(valid({ execution: { runtimeContainerId: '../../socket' } })).validate()).rejects.toThrow();
  });

  it('defines one distributed active run slot per owner', () => {
    expect(NotebookRunModel.schema.indexes()).toContainEqual([
      { ownerId: 1 },
      expect.objectContaining({ unique: true, partialFilterExpression: { activeOwnerSlot: true },
        name: 'one_active_notebook_run_per_owner' }),
    ]);
  });
});
