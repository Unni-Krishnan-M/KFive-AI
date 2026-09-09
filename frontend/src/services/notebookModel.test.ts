import { describe, expect, it } from 'vitest';
import {
  buildNotebookCreatePayload,
  buildNotebookUpdatePayload,
  isNotebookScopeRequestCurrent,
  normalizeNotebook,
  normalizeNotebookPage,
  normalizeNotebookRun,
  normalizeNotebookRunPage,
  normalizeNotebookStatus,
  notebookScopeKey,
  type NotebookDraft,
  type NotebookView,
  validateNotebookDraft,
} from './notebookModel';

const id = '507f1f77bcf86cd799439011';
const projectId = '507f1f77bcf86cd799439012';
const notebook: NotebookView = {
  id, projectId, title: 'Experiment', revision: 2, cellTimeoutSeconds: 10,
  cells: [{ id: 'imports', type: 'code', source: 'print("hello")', tags: ['setup'] }],
  createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:01:00.000Z',
};
const status = {
  editing: { available: true, persistent: true },
  execution: {
    enabled: false, available: false, queueDurable: false, workerAvailable: false, isolationVerified: false,
    message: 'Notebook execution is unavailable until the trusted verifier is configured.',
  },
  limits: { cells: 32, sourceBytesPerCell: 65_536, sourceBytesPerNotebook: 262_144, cellTimeoutSeconds: 30 },
};

describe('notebook frontend contract', () => {
  it('normalizes bounded notebook documents and pagination', () => {
    expect(normalizeNotebook({ success: true, data: { notebook } })).toEqual(notebook);
    expect(normalizeNotebookPage({ data: { notebooks: [notebook], pagination: {
      page: 1, pageSize: 25, total: 1, totalPages: 1, maxPages: 10,
    } } }, projectId)).toMatchObject({ notebooks: [{ id }], pagination: { total: 1 } });
    expect(normalizeNotebookPage({ data: { notebooks: [notebook], pagination: {
      page: 1, pageSize: 50, total: 1, totalPages: 1, maxPages: 10,
    } } })).toBeUndefined();
  });

  it('rejects malformed identifiers, duplicate cells, unsafe text, unknown fields, and byte overflow', () => {
    expect(normalizeNotebook({ ...notebook, ownerId: projectId })).toBeUndefined();
    expect(normalizeNotebook({ ...notebook, projectId: 'bad' })).toBeUndefined();
    expect(normalizeNotebook({ ...notebook, cells: [...notebook.cells, notebook.cells[0]] })).toBeUndefined();
    expect(normalizeNotebook({ ...notebook, cells: [{ ...notebook.cells[0], source: 'safe\u202Eevil' }] })).toBeUndefined();
    expect(validateNotebookDraft({ ...notebook, title: '🔥'.repeat(31) })).toContain('120');
    expect(validateNotebookDraft({ ...notebook, cells: [{ ...notebook.cells[0], source: 'x'.repeat(65_537) }] })).toContain('invalid');
    expect(normalizeNotebook(notebook, null)).toBeUndefined();
    expect(normalizeNotebook({ ...notebook, projectId: undefined }, null)?.id).toBe(id);
    expect(normalizeNotebook(notebook, '507f1f77bcf86cd799439099')).toBeUndefined();
  });

  it('does not advertise execution unless every isolation dependency is true', () => {
    expect(normalizeNotebookStatus({ data: status })).toEqual(status);
    expect(normalizeNotebookStatus({ data: { ...status, execution: { ...status.execution, available: true } } })).toBeUndefined();
    expect(normalizeNotebookStatus({ data: { ...status, limits: { ...status.limits, cells: 64 } } })).toBeUndefined();
    expect(normalizeNotebookStatus({ data: { ...status, execution: { ...status.execution, stack: 'private' } } })).toBeUndefined();
    expect(normalizeNotebookStatus({ data: { ...status, editing: { available: true, persistent: false } } })).toBeUndefined();
  });

  it('builds normalized optimistic-concurrency payloads', () => {
    const draft: NotebookDraft = { title: ' Experiment ', cells: notebook.cells, cellTimeoutSeconds: 10 };
    expect(buildNotebookCreatePayload(draft, projectId)).toEqual({ ...draft, title: 'Experiment', projectId });
    expect(buildNotebookUpdatePayload(draft, 2)).toEqual({ ...draft, title: 'Experiment', expectedRevision: 2 });
    expect(() => buildNotebookUpdatePayload(draft, 0)).toThrow('revision');
  });

  it('fences async results to one workspace or canonical project scope', () => {
    expect(notebookScopeKey(false)).toBe('workspace');
    expect(notebookScopeKey(true)).toBe('project:pending');
    expect(notebookScopeKey(true, projectId)).toBe(`project:${projectId}`);
    expect(isNotebookScopeRequestCurrent(`project:${projectId}`, `project:${projectId}`, 3, 3)).toBe(true);
    expect(isNotebookScopeRequestCurrent('workspace', `project:${projectId}`, 3, 3)).toBe(false);
    expect(isNotebookScopeRequestCurrent(`project:${projectId}`, `project:${projectId}`, 2, 3)).toBe(false);
  });

  it('normalizes owner-scoped run metadata without accepting output in list responses', () => {
    const run = {
      id: '507f1f77bcf86cd799439021', notebookId: id, projectId, notebookRevision: 2,
      snapshotSha256: 'a'.repeat(64), status: 'queued', revision: 1, metrics: [], artifacts: [],
      timeline: [{ revision: 1, sequence: 1, type: 'created', timestamp: '2026-09-01T00:00:00.000Z' }],
      queuedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    };
    expect(normalizeNotebookRun({ data: { run } }, notebook)).toMatchObject({ id: run.id, status: 'queued' });
    expect(normalizeNotebookRunPage({ data: { runs: [run], pagination: {
      page: 1, pageSize: 25, total: 1, totalPages: 1, maxPages: 10,
    } } }, notebook)).toMatchObject({ runs: [{ id: run.id }], pagination: { total: 1 } });
    expect(normalizeNotebookRun({ ...run, executedNotebook: { cells: [] } }, notebook)).toBeUndefined();
    expect(normalizeNotebookRun({ ...run, notebookId: projectId }, notebook)).toBeUndefined();
  });

  it('accepts only inert verifier output that preserves the saved cell identity', () => {
    const run = {
      id: '507f1f77bcf86cd799439021', notebookId: id, projectId, notebookRevision: 2,
      snapshotSha256: 'a'.repeat(64), status: 'succeeded', revision: 4, metrics: [], artifacts: [],
      result: { durationMs: 12, runtimeImageId: 'b'.repeat(64), verifierImageId: 'c'.repeat(64) },
      timeline: [{ revision: 1, sequence: 1, type: 'created', timestamp: '2026-09-01T00:00:00.000Z' }],
      queuedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:00:00.012Z',
      snapshot: { cells: notebook.cells, cellTimeoutSeconds: 10 },
      executedNotebook: { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{
        cell_type: 'code', id: 'imports', metadata: { tags: ['setup'] }, source: 'print("hello")', execution_count: 1,
        outputs: [{ output_type: 'stream', name: 'stdout', text: 'hello\n' },
          { output_type: 'display_data', data: { 'text/plain': '2' }, metadata: {} }],
      }] },
    };
    const normalized = normalizeNotebookRun({ data: { run } }, notebook, true);
    expect(normalized?.executedNotebook?.cells[0].outputs).toEqual([
      { outputType: 'stream', name: 'stdout', text: 'hello\n' }, { outputType: 'display', text: '2' },
    ]);
    expect(normalizeNotebookRun({ ...run, executedNotebook: { ...run.executedNotebook, cells: [
      { ...run.executedNotebook.cells[0], source: 'print("forged")' },
    ] } }, notebook, true)).toBeUndefined();
    expect(normalizeNotebookRun({ ...run, executedNotebook: { ...run.executedNotebook, cells: [
      { ...run.executedNotebook.cells[0], outputs: [{ output_type: 'display_data', data: { 'text/html': '<script />' }, metadata: {} }] },
    ] } }, notebook, true)).toBeUndefined();
  });
});
