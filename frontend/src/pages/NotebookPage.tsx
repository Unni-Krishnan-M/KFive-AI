import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Braces,
  FilePlus2,
  FolderKanban,
  Loader2,
  Plus,
  Play,
  Save,
  ShieldAlert,
  Square,
  Trash2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useProjectContext } from '@/hooks/useProjectContext';
import { notebookApi } from '@/services/api';
import {
  buildNotebookCreatePayload,
  buildNotebookUpdatePayload,
  isNotebookScopeRequestCurrent,
  isNotebookRunActive,
  normalizeNotebook,
  normalizeNotebookPage,
  normalizeNotebookRun,
  normalizeNotebookRunPage,
  normalizeNotebookStatus,
  notebookScopeKey,
  NotebookCell,
  NotebookCellType,
  NotebookDraft,
  NotebookStatus,
  NotebookView,
  NotebookRunView,
  type NotebookPage as NotebookPageResult,
  validateNotebookDraft,
} from '@/services/notebookModel';
import { PROJECT_ARCHIVED_MESSAGE } from '@/services/projectContext';
import { readableApiError } from '@/services/runtimeSettings';

const newCellId = (): string => {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '')
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `cell_${random.slice(0, 20)}`;
};
const emptyDraft = (): NotebookDraft => ({
  title: 'Untitled notebook',
  cells: [{ id: newCellId(), type: 'code', source: '', tags: [] }],
  cellTimeoutSeconds: 10,
});
const notebookDraft = (notebook: NotebookView): NotebookDraft => ({
  title: notebook.title,
  cells: notebook.cells.map((cell) => ({ ...cell, tags: [...cell.tags] })),
  cellTimeoutSeconds: notebook.cellTimeoutSeconds,
});
const draftFingerprint = (draft: NotebookDraft): string => JSON.stringify(draft);
const emptyPagination: NotebookPageResult['pagination'] = { page: 1, pageSize: 25, total: 0, totalPages: 1, maxPages: 10 };
const errorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return undefined;
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  const apiError = (data as { error?: unknown }).error;
  return apiError && typeof apiError === 'object' && typeof (apiError as { code?: unknown }).code === 'string'
    ? (apiError as { code: string }).code : undefined;
};

function CellOutputs({ run, cellId }: { run?: NotebookRunView; cellId: string }) {
  const cell = run?.executedNotebook?.cells.find((item) => item.id === cellId);
  if (!cell || cell.outputs.length === 0) return null;
  return <div className="space-y-2 border-t border-white/10 bg-black/30 p-3" aria-label={`Output for ${cellId}`}>
    {cell.outputs.map((output, index) => {
      if (output.outputType === 'stream') return <pre key={index} className={`overflow-auto whitespace-pre-wrap break-words rounded p-3 text-xs ${output.name === 'stderr' ? 'bg-red-950/40 text-red-200' : 'bg-black/40 text-gray-200'}`}>{output.text}</pre>;
      if (output.outputType === 'error') return <pre key={index} className="overflow-auto whitespace-pre-wrap break-words rounded bg-red-950/40 p-3 text-xs text-red-200">{output.traceback.join('\n')}</pre>;
      return <div key={index} className="space-y-2 rounded bg-black/40 p-3 text-xs text-gray-200">
        {output.text !== undefined ? <pre className="overflow-auto whitespace-pre-wrap break-words">{output.text}</pre> : null}
        {output.json !== undefined ? <pre className="overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(output.json, null, 2)}</pre> : null}
        {output.png ? <img src={`data:image/png;base64,${output.png}`} alt="Verified notebook PNG output" className="max-h-[520px] max-w-full rounded object-contain" /> : null}
        {output.jpeg ? <img src={`data:image/jpeg;base64,${output.jpeg}`} alt="Verified notebook JPEG output" className="max-h-[520px] max-w-full rounded object-contain" /> : null}
      </div>;
    })}
  </div>;
}

export default function NotebookPage() {
  const { requested, context, loading: projectLoading, error: projectError } = useProjectContext();
  const scope = notebookScopeKey(requested, context?.projectId);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const previousScopeRef = useRef(scope);
  const loadRequestRef = useRef(0);
  const mutationRequestRef = useRef(0);
  const runRequestRef = useRef(0);
  const runMutationRequestRef = useRef(0);
  const [status, setStatus] = useState<NotebookStatus>();
  const [notebooks, setNotebooks] = useState<NotebookView[]>([]);
  const [pagination, setPagination] = useState<NotebookPageResult['pagination']>(emptyPagination);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<NotebookView>();
  const [draft, setDraft] = useState<NotebookDraft>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string>();
  const [statusError, setStatusError] = useState<string>();
  const [mutation, setMutation] = useState<'create' | 'save' | 'delete'>();
  const [deleteTarget, setDeleteTarget] = useState<NotebookView>();
  const [pendingSelection, setPendingSelection] = useState<NotebookView>();
  const [conflict, setConflict] = useState(false);
  const [runs, setRuns] = useState<NotebookRunView[]>([]);
  const [selectedRun, setSelectedRun] = useState<NotebookRunView>();
  const [runLoading, setRunLoading] = useState(false);
  const [runError, setRunError] = useState<string>();
  const [runMutation, setRunMutation] = useState<'start' | 'cancel' | 'delete'>();
  const [deleteRunTarget, setDeleteRunTarget] = useState<NotebookRunView>();

  useLayoutEffect(() => {
    if (previousScopeRef.current === scope) return;
    previousScopeRef.current = scope;
    loadRequestRef.current += 1;
    mutationRequestRef.current += 1;
    runRequestRef.current += 1;
    runMutationRequestRef.current += 1;
    setStatus(undefined); setNotebooks([]); setPagination(emptyPagination); setPage(1);
    setSelected(undefined); setDraft(emptyDraft()); setDeleteTarget(undefined); setPendingSelection(undefined);
    setMutation(undefined); setConflict(false); setPageError(undefined); setStatusError(undefined); setLoading(true);
    setRuns([]); setSelectedRun(undefined); setRunLoading(false); setRunError(undefined); setRunMutation(undefined); setDeleteRunTarget(undefined);
  }, [scope]);

  const mutationsAllowed = !projectLoading && !projectError && (!requested || context?.status === 'active')
    && status?.editing.available === true && status.editing.persistent === true && !mutation && !runMutation;
  const baseline = selected ? draftFingerprint(notebookDraft(selected)) : undefined;
  const dirty = selected ? draftFingerprint(draft) !== baseline : false;
  const validationError = validateNotebookDraft(draft);
  const activeRun = runs.find((run) => isNotebookRunActive(run.status));
  const runAllowed = Boolean(selected && !dirty && !validationError && !mutation && !runMutation && !activeRun
    && (!requested || context?.status === 'active') && status?.execution.available);
  const mutating = Boolean(mutation || runMutation);

  const selectNotebook = useCallback((notebook?: NotebookView) => {
    runRequestRef.current += 1;
    setSelected(notebook);
    setDraft(notebook ? notebookDraft(notebook) : emptyDraft());
    setConflict(false);
    setRuns([]); setSelectedRun(undefined); setRunError(undefined); setDeleteRunTarget(undefined);
  }, []);

  const requestSelection = (notebook: NotebookView) => {
    if (mutation || notebook.id === selected?.id) return;
    if (dirty) setPendingSelection(notebook);
    else selectNotebook(notebook);
  };

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const load = useCallback(async (targetPage: number) => {
    if (projectLoading) return;
    const requestScope = notebookScopeKey(requested, context?.projectId);
    const request = ++loadRequestRef.current;
    setLoading(true);
    setPageError(undefined);
    setStatusError(undefined);
    setStatus(undefined);
    setNotebooks([]);
    setPagination(emptyPagination);
    selectNotebook(undefined);
    if (projectError || (requested && !context)) {
      setPageError(projectError ?? 'Project context could not be verified.');
      setLoading(false);
      return;
    }
    const [statusResult, listResult] = await Promise.allSettled([
      notebookApi.getStatus(),
      notebookApi.list(targetPage, context?.projectId),
    ]);
    if (!isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, loadRequestRef.current)) return;
    if (statusResult.status === 'fulfilled') {
      const value = normalizeNotebookStatus(statusResult.value.data);
      if (value) setStatus(value);
      else { setStatus(undefined); setStatusError('The notebook service returned an invalid availability contract.'); }
    } else {
      setStatus(undefined);
      setStatusError(readableApiError(statusResult.reason, 'Notebook availability could not be checked.'));
    }
    if (listResult.status === 'fulfilled') {
      const value = normalizeNotebookPage(listResult.value.data, context?.projectId ?? null);
      if (value) {
        setNotebooks(value.notebooks);
        setPagination(value.pagination);
        selectNotebook(value.notebooks[0]);
      } else setPageError('The notebook service returned an invalid document list.');
    } else setPageError(readableApiError(listResult.reason, 'Notebooks could not be loaded.'));
    setLoading(false);
  }, [context, projectError, projectLoading, requested, selectNotebook]);

  useEffect(() => { void load(page); }, [load, page]);

  const loadRuns = useCallback(async (notebook: NotebookView) => {
    const requestScope = scopeRef.current; const request = ++runRequestRef.current;
    setRunLoading(true); setRunError(undefined); setRuns([]); setSelectedRun(undefined);
    try {
      const response = await notebookApi.listRuns(notebook.id, 1);
      const pageResult = normalizeNotebookRunPage(response.data, notebook);
      if (!pageResult) throw new Error('The notebook service returned an invalid run history.');
      if (!isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runRequestRef.current)
        || notebook.id !== selected?.id) return;
      setRuns(pageResult.runs);
      if (pageResult.runs[0]) {
        const detailResponse = await notebookApi.getRun(notebook.id, pageResult.runs[0].id);
        const detail = normalizeNotebookRun(detailResponse.data, notebook, true);
        if (!detail || detail.id !== pageResult.runs[0].id) throw new Error('The notebook service returned an invalid run detail.');
        if (!isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runRequestRef.current)
          || notebook.id !== selected?.id) return;
        setSelectedRun(detail);
      }
    } catch (error) {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runRequestRef.current)
        && notebook.id === selected?.id) setRunError(readableApiError(error,
        error instanceof Error ? error.message : 'Notebook run history could not be loaded.'));
    } finally {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runRequestRef.current)
        && notebook.id === selected?.id) setRunLoading(false);
    }
  }, [selected?.id]);

  useEffect(() => {
    if (selected) void loadRuns(selected);
  }, [loadRuns, selected]);

  useEffect(() => {
    if (!selected || !selectedRun || !isNotebookRunActive(selectedRun.status)) return;
    const notebook = selected; const runId = selectedRun.id; const requestScope = scopeRef.current;
    const request = ++runRequestRef.current;
    const timer = window.setTimeout(() => {
      void notebookApi.getRun(notebook.id, runId).then((response) => {
        const detail = normalizeNotebookRun(response.data, notebook, true);
        if (!detail || detail.id !== runId) throw new Error('The notebook service returned an invalid active run.');
        if (!isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runRequestRef.current)
          || notebook.id !== selected?.id) return;
        setSelectedRun(detail);
        setRuns((current) => current.map((item) => item.id === detail.id ? { ...detail, executedNotebook: undefined, snapshot: undefined } : item));
      }).catch((error) => {
        if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runRequestRef.current))
          setRunError(readableApiError(error, error instanceof Error ? error.message : 'Active notebook run could not be refreshed.'));
      });
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [selected, selectedRun]);

  const startRun = async () => {
    if (!selected || !runAllowed) return;
    const notebook = selected; const requestScope = scopeRef.current; const request = ++runMutationRequestRef.current;
    setRunMutation('start'); setRunError(undefined);
    try {
      const response = await notebookApi.startRun(notebook.id, notebook.revision);
      const run = normalizeNotebookRun(response.data, notebook, true);
      if (!run || run.notebookRevision !== notebook.revision || !isNotebookRunActive(run.status))
        throw new Error('The notebook service returned an invalid queued run.');
      if (!isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runMutationRequestRef.current)
        || notebook.id !== selected?.id) return;
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)].slice(0, 25));
      setSelectedRun(run); toast.success('Notebook run queued.');
    } catch (error) {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runMutationRequestRef.current))
        setRunError(readableApiError(error, error instanceof Error ? error.message : 'Notebook run could not be started.'));
    } finally {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runMutationRequestRef.current)) setRunMutation(undefined);
    }
  };

  const cancelRun = async () => {
    if (!selected || !selectedRun || !isNotebookRunActive(selectedRun.status) || runMutation) return;
    const notebook = selected; const runId = selectedRun.id; const requestScope = scopeRef.current;
    const request = ++runMutationRequestRef.current; setRunMutation('cancel'); setRunError(undefined);
    try {
      const response = await notebookApi.cancelRun(notebook.id, runId);
      const run = normalizeNotebookRun(response.data, notebook, true);
      if (!run || run.id !== runId) throw new Error('The notebook service returned an invalid cancellation result.');
      if (!isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runMutationRequestRef.current)) return;
      setSelectedRun(run); setRuns((current) => current.map((item) => item.id === run.id
        ? { ...run, executedNotebook: undefined, snapshot: undefined } : item));
      toast.success(run.status === 'cancel-requested' ? 'Cancellation requested.' : 'Notebook run cancelled.');
    } catch (error) {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runMutationRequestRef.current))
        setRunError(readableApiError(error, 'Notebook run could not be cancelled.'));
    } finally {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runMutationRequestRef.current)) setRunMutation(undefined);
    }
  };

  const deleteRun = async () => {
    if (!selected || !deleteRunTarget || isNotebookRunActive(deleteRunTarget.status) || runMutation) return;
    const notebook = selected; const target = deleteRunTarget; const requestScope = scopeRef.current;
    const request = ++runMutationRequestRef.current; setRunMutation('delete');
    try {
      const response = await notebookApi.deleteRun(notebook.id, target.id);
      if (response.data.data?.deleted !== true || response.data.data.runId !== target.id)
        throw new Error('The notebook service returned an invalid run deletion result.');
      if (!isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runMutationRequestRef.current)) return;
      setDeleteRunTarget(undefined); await loadRuns(notebook); toast.success('Notebook run deleted.');
    } catch (error) {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runMutationRequestRef.current))
        setRunError(readableApiError(error, 'Notebook run could not be deleted.'));
    } finally {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runMutationRequestRef.current)) setRunMutation(undefined);
    }
  };

  const openRun = async (summary: NotebookRunView) => {
    if (!selected || runMutation || summary.id === selectedRun?.id) return;
    const notebook = selected; const requestScope = scopeRef.current; const request = ++runRequestRef.current;
    setRunLoading(true); setRunError(undefined);
    try {
      const response = await notebookApi.getRun(notebook.id, summary.id);
      const detail = normalizeNotebookRun(response.data, notebook, true);
      if (!detail || detail.id !== summary.id) throw new Error('The notebook service returned an invalid run detail.');
      if (!isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runRequestRef.current)
        || notebook.id !== selected?.id) return;
      setSelectedRun(detail);
    } catch (error) {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runRequestRef.current))
        setRunError(readableApiError(error, error instanceof Error ? error.message : 'Notebook run detail could not be loaded.'));
    } finally {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, runRequestRef.current)) setRunLoading(false);
    }
  };

  const createNotebook = async () => {
    if (!mutationsAllowed) return;
    const requestScope = scopeRef.current;
    const request = ++mutationRequestRef.current;
    const initial = emptyDraft();
    setMutation('create');
    setPageError(undefined);
    try {
      const response = await notebookApi.create(buildNotebookCreatePayload(initial, context?.projectId));
      const created = normalizeNotebook(response.data, context?.projectId ?? null);
      if (!created) throw new Error('The notebook service returned an invalid saved document.');
      if (!isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, mutationRequestRef.current)) return;
      if (page === 1) {
        setNotebooks((current) => [created, ...current.filter((item) => item.id !== created.id)].slice(0, 25));
        setPagination((current) => ({ ...current, total: current.total + 1,
          totalPages: Math.max(1, Math.min(10, Math.ceil((current.total + 1) / 25))) }));
        selectNotebook(created);
      } else setPage(1);
      toast.success('Notebook created.');
    } catch (error) {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, mutationRequestRef.current)) {
        const message = readableApiError(error, error instanceof Error ? error.message : 'The notebook could not be created.');
        setPageError(message);
        toast.error(message);
      }
    } finally {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, mutationRequestRef.current)) setMutation(undefined);
    }
  };

  const saveNotebook = async () => {
    if (!selected || !mutationsAllowed || validationError) return;
    const requestScope = scopeRef.current;
    const request = ++mutationRequestRef.current;
    const targetId = selected.id;
    const targetProjectId = selected.projectId;
    setMutation('save');
    try {
      const response = await notebookApi.update(selected.id, buildNotebookUpdatePayload(draft, selected.revision));
      const saved = normalizeNotebook(response.data, targetProjectId ?? null);
      if (!saved || saved.id !== targetId || saved.revision !== selected.revision + 1)
        throw new Error('The notebook service returned an invalid saved revision.');
      if (!isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, mutationRequestRef.current)) return;
      setNotebooks((current) => current.map((item) => item.id === saved.id ? saved : item));
      if (selected.id === targetId) selectNotebook(saved);
      toast.success('Notebook saved.');
    } catch (error) {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, mutationRequestRef.current)) {
        if (errorCode(error) === 'NOTEBOOK_REVISION_CONFLICT') setConflict(true);
        toast.error(readableApiError(error, error instanceof Error ? error.message : 'The notebook could not be saved.'));
      }
    } finally {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, mutationRequestRef.current)) setMutation(undefined);
    }
  };

  const deleteNotebook = async () => {
    if (!deleteTarget || !mutationsAllowed) return;
    const target = deleteTarget;
    const requestScope = scopeRef.current;
    const request = ++mutationRequestRef.current;
    setMutation('delete');
    try {
      const response = await notebookApi.delete(target.id, target.revision);
      const result = response.data.data;
      if (result?.deleted !== true || result.notebookId !== target.id) throw new Error('The notebook service returned an invalid deletion result.');
      if (!isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, mutationRequestRef.current)) return;
      setDeleteTarget(undefined);
      if (notebooks.length === 1 && page > 1) setPage((current) => current - 1);
      else await load(page);
      toast.success('Notebook deleted.');
    } catch (error) {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, mutationRequestRef.current)) {
        if (errorCode(error) === 'NOTEBOOK_REVISION_CONFLICT') setConflict(true);
        toast.error(readableApiError(error, 'The notebook could not be deleted.'));
      }
    } finally {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, mutationRequestRef.current)) setMutation(undefined);
    }
  };

  const reloadLatest = async () => {
    if (!selected || mutation) return;
    const target = selected;
    const requestScope = scopeRef.current; const request = ++mutationRequestRef.current;
    setMutation('save');
    try {
      const response = await notebookApi.get(target.id);
      const latest = normalizeNotebook(response.data, target.projectId ?? null);
      if (!latest || latest.id !== target.id) throw new Error('The notebook service returned an invalid current revision.');
      if (!isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, mutationRequestRef.current)) return;
      setNotebooks((current) => current.map((item) => item.id === latest.id ? latest : item));
      selectNotebook(latest);
      toast.success('Latest notebook revision loaded.');
    } catch (error) {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, mutationRequestRef.current))
        toast.error(readableApiError(error, 'The latest notebook revision could not be loaded.'));
    } finally {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, mutationRequestRef.current)) setMutation(undefined);
    }
  };

  const saveConflictAsNew = async () => {
    if (!mutationsAllowed || !conflict || validationError) return;
    const requestScope = scopeRef.current; const request = ++mutationRequestRef.current;
    setMutation('create');
    try {
      const response = await notebookApi.create(buildNotebookCreatePayload({ ...draft, title: `${draft.title} copy` }, context?.projectId));
      const created = normalizeNotebook(response.data, context?.projectId ?? null);
      if (!created) throw new Error('The notebook service returned an invalid saved document.');
      if (!isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, mutationRequestRef.current)) return;
      setPage(1); setNotebooks((current) => [created, ...current.filter((item) => item.id !== created.id)].slice(0, 25));
      selectNotebook(created); toast.success('Draft saved as a new notebook.');
    } catch (error) {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, mutationRequestRef.current))
        toast.error(readableApiError(error, error instanceof Error ? error.message : 'The draft could not be saved as a new notebook.'));
    } finally {
      if (isNotebookScopeRequestCurrent(requestScope, scopeRef.current, request, mutationRequestRef.current)) setMutation(undefined);
    }
  };

  const updateCell = (index: number, changes: Partial<NotebookCell>) => setDraft((current) => ({
    ...current,
    cells: current.cells.map((cell, cellIndex) => cellIndex === index ? { ...cell, ...changes } : cell),
  }));
  const addCell = (type: NotebookCellType) => setDraft((current) => current.cells.length >= 32 ? current : ({
    ...current,
    cells: [...current.cells, { id: newCellId(), type, source: '', tags: [] }],
  }));
  const removeCell = (index: number) => setDraft((current) => current.cells.length <= 1 ? current : ({
    ...current,
    cells: current.cells.filter((_cell, cellIndex) => cellIndex !== index),
  }));
  const moveCell = (index: number, direction: -1 | 1) => setDraft((current) => {
    const destination = index + direction;
    if (destination < 0 || destination >= current.cells.length) return current;
    const cells = [...current.cells];
    [cells[index], cells[destination]] = [cells[destination], cells[index]];
    return { ...current, cells };
  });

  const scopeLabel = requested ? (context?.projectName ?? 'Project notebooks') : 'Workspace notebooks';
  const executionMessage = status?.execution.message ?? 'Notebook execution status is unavailable.';

  return <div className="mx-auto max-w-[1500px] space-y-5 p-4 md:p-6">
    <ConfirmDialog isOpen={Boolean(deleteTarget)} title="Delete Notebook" message={`Delete ${deleteTarget?.title || 'this notebook'}? This removes the persisted document and cannot be undone.`} confirmText={mutation === 'delete' ? 'Deleting…' : 'Delete Notebook'} isDestructive onConfirm={() => void deleteNotebook()} onCancel={() => { if (mutation !== 'delete') setDeleteTarget(undefined); }} />
    <ConfirmDialog isOpen={Boolean(deleteRunTarget)} title="Delete Notebook Run" message="Delete this terminal run and its verified outputs, metrics, and artifacts? This cannot be undone." confirmText={runMutation === 'delete' ? 'Deleting…' : 'Delete Run'} isDestructive onConfirm={() => void deleteRun()} onCancel={() => { if (runMutation !== 'delete') setDeleteRunTarget(undefined); }} />
    <ConfirmDialog isOpen={Boolean(pendingSelection)} title="Discard unsaved changes?" message="Opening another notebook will discard the unsaved changes in this editor. Cancel to return and save them first." confirmText="Discard and Open" isDestructive onConfirm={() => { const target = pendingSelection; setPendingSelection(undefined); if (target) selectNotebook(target); }} onCancel={() => setPendingSelection(undefined)} />
    <header className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="flex items-center gap-2 text-sm text-primary"><BookOpen className="h-4 w-4" /> Notebook Mode</div>
        <h1 className="mt-1 text-2xl font-semibold text-white">Persistent notebook documents</h1>
        <p className="mt-1 text-sm text-gray-400">Edit bounded Python and Markdown cells without exposing a shell or Jupyter server.</p>
      </div>
      <button onClick={() => void createNotebook()} disabled={!mutationsAllowed} className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">
        {mutation === 'create' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FilePlus2 className="h-4 w-4" />} New notebook
      </button>
    </header>

    {requested ? <div className={`flex items-start gap-3 rounded-xl border p-4 text-sm ${context?.status === 'archived' ? 'border-amber-400/30 bg-amber-400/10 text-amber-100' : 'border-primary/30 bg-primary/10 text-gray-200'}`}>
      <FolderKanban className="mt-0.5 h-4 w-4 shrink-0" /><div><strong>{scopeLabel}</strong>{context?.status === 'archived' ? <p className="mt-1">{PROJECT_ARCHIVED_MESSAGE}</p> : <p className="mt-1 text-gray-400">New notebooks are attached to this project.</p>}</div>
    </div> : null}

    <div className={`flex items-start gap-3 rounded-xl border p-4 text-sm ${status?.execution.available ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100' : 'border-amber-400/25 bg-amber-400/10 text-amber-100'}`} role="status">
      <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" /><div><strong>{status?.execution.available ? 'Isolated execution available' : 'Execution unavailable'}</strong><p className="mt-1 opacity-80">{executionMessage}</p></div>
    </div>
    {statusError ? <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-100"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" /><div><strong>Notebook editing unavailable.</strong> {statusError}<button disabled={mutating} onClick={() => void load(page)} className="ml-3 underline disabled:opacity-40">Retry</button></div></div> : null}
    {pageError ? <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-100"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" /><div>{pageError}<button disabled={mutating} onClick={() => void load(page)} className="ml-3 underline disabled:opacity-40">Retry</button></div></div> : null}

    <div className="grid min-h-[620px] gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
        <div className="flex items-center justify-between px-2 py-2"><h2 className="font-medium text-white">{scopeLabel}</h2><span className="text-xs text-gray-500">{pagination.total}/100</span></div>
        {loading || projectLoading ? <div className="flex items-center gap-2 px-2 py-8 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading notebooks…</div>
          : notebooks.length === 0 ? <p className="px-2 py-8 text-sm text-gray-500">No saved notebooks in this scope.</p>
          : <div className="space-y-1">{notebooks.map((notebook) => <button key={notebook.id} disabled={mutating} onClick={() => requestSelection(notebook)} className={`w-full rounded-lg px-3 py-3 text-left transition disabled:opacity-50 ${selected?.id === notebook.id ? 'bg-primary/20 text-white' : 'text-gray-300 hover:bg-white/5'}`}>
            <span className="block truncate font-medium">{notebook.title}</span><span className="mt-1 block text-xs text-gray-500">{notebook.cells.length} cells · revision {notebook.revision}</span>
          </button>)}</div>}
        <div className="mt-3 flex items-center justify-between border-t border-white/10 px-2 pt-3 text-xs text-gray-400"><button disabled={mutating || page <= 1} onClick={() => setPage((current) => current - 1)} className="rounded px-2 py-1 hover:bg-white/5 disabled:opacity-30">Previous</button><span>Page {pagination.page} / {pagination.totalPages}</span><button disabled={mutating || page >= pagination.totalPages} onClick={() => setPage((current) => current + 1)} className="rounded px-2 py-1 hover:bg-white/5 disabled:opacity-30">Next</button></div>
      </aside>

      <main className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] p-4 md:p-5">
        {!selected ? <div className="flex min-h-[560px] items-center justify-center text-center text-gray-500"><div><BookOpen className="mx-auto h-10 w-10" /><p className="mt-3">Create or select a notebook to edit it.</p></div></div>
          : <div className="space-y-4">
            <div className="flex flex-col gap-3 border-b border-white/10 pb-4 xl:flex-row xl:items-end">
              <label className="min-w-0 flex-1 text-sm text-gray-400">Title<input value={draft.title} disabled={!mutationsAllowed} onChange={(event) => setDraft({ ...draft, title: event.target.value })} className="mt-1 w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-white outline-none focus:border-primary/60 disabled:opacity-50" /></label>
              <label className="w-40 text-sm text-gray-400">Cell timeout<input type="number" min={1} max={30} value={draft.cellTimeoutSeconds} disabled={!mutationsAllowed} onChange={(event) => setDraft({ ...draft, cellTimeoutSeconds: Number(event.target.value) })} className="mt-1 w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-white outline-none focus:border-primary/60 disabled:opacity-50" /></label>
              <div className="flex gap-2">
                <button onClick={() => setDeleteTarget(selected)} disabled={!mutationsAllowed} aria-label="Delete notebook" className="rounded-lg border border-red-400/20 p-2.5 text-red-300 hover:bg-red-500/10 disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>
                {activeRun ? <button onClick={() => void cancelRun()} disabled={Boolean(runMutation)} className="inline-flex items-center gap-2 rounded-lg border border-amber-400/30 px-4 py-2.5 text-sm font-medium text-amber-100 hover:bg-amber-400/10 disabled:opacity-40">{runMutation === 'cancel' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}Stop</button>
                  : status?.execution.available ? <button onClick={() => void startRun()} disabled={!runAllowed} title={dirty ? 'Save this notebook before running it.' : undefined} className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/30 px-4 py-2.5 text-sm font-medium text-emerald-100 hover:bg-emerald-400/10 disabled:opacity-40">{runMutation === 'start' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Run</button> : null}
                <button onClick={() => void saveNotebook()} disabled={!mutationsAllowed || !dirty || Boolean(validationError)} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40">{mutation === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{mutation === 'save' ? 'Saving…' : 'Save'}</button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs"><span className={`rounded-full px-2 py-1 ${dirty ? 'bg-amber-400/15 text-amber-200' : 'bg-emerald-400/15 text-emerald-200'}`}>{dirty ? 'Unsaved changes' : `Saved revision ${selected.revision}`}</span><span className="text-gray-500">{draft.cells.length}/32 cells</span>{validationError ? <span className="text-red-300">{validationError}</span> : null}</div>
            {conflict ? <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100"><span className="flex-1">This notebook changed after you opened it. Reload the latest revision or preserve this draft as a new notebook.</span><button disabled={mutating} onClick={() => void reloadLatest()} className="rounded border border-white/10 px-3 py-1.5 disabled:opacity-40">Reload latest</button><button disabled={mutating || Boolean(validationError)} onClick={() => void saveConflictAsNew()} className="rounded bg-primary px-3 py-1.5 text-white disabled:opacity-40">Save as new</button></div> : null}

            <div className="space-y-4">{draft.cells.map((cell, index) => <section key={cell.id} className="overflow-hidden rounded-xl border border-white/10 bg-black/20">
              <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
                <select aria-label={`Cell ${index + 1} type`} value={cell.type} disabled={!mutationsAllowed} onChange={(event) => updateCell(index, { type: event.target.value as NotebookCellType })} className="rounded-md border border-white/10 bg-[#11131b] px-2 py-1 text-xs text-gray-200"><option value="code">Python</option><option value="markdown">Markdown</option></select>
                <span className="text-xs text-gray-500">Cell {index + 1}</span><span className="flex-1" />
                <button onClick={() => moveCell(index, -1)} disabled={!mutationsAllowed || index === 0} aria-label={`Move cell ${index + 1} up`} className="rounded p-1.5 text-gray-400 hover:bg-white/10 disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
                <button onClick={() => moveCell(index, 1)} disabled={!mutationsAllowed || index === draft.cells.length - 1} aria-label={`Move cell ${index + 1} down`} className="rounded p-1.5 text-gray-400 hover:bg-white/10 disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
                <button onClick={() => removeCell(index)} disabled={!mutationsAllowed || draft.cells.length === 1} aria-label={`Remove cell ${index + 1}`} className="rounded p-1.5 text-red-300 hover:bg-red-500/10 disabled:opacity-30"><Trash2 className="h-4 w-4" /></button>
              </div>
              <textarea value={cell.source} disabled={!mutationsAllowed} onChange={(event) => updateCell(index, { source: event.target.value })} rows={cell.type === 'code' ? 8 : 5} spellCheck={cell.type === 'markdown'} aria-label={`Cell ${index + 1} ${cell.type} source`} className={`block w-full resize-y bg-transparent p-4 text-sm text-gray-100 outline-none disabled:opacity-50 ${cell.type === 'code' ? 'font-mono' : ''}`} placeholder={cell.type === 'code' ? 'print("Hello from KFive")' : '## Notes'} />
              <CellOutputs run={!dirty && selectedRun?.notebookRevision === selected.revision ? selectedRun : undefined} cellId={cell.id} />
            </section>)}</div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => addCell('code')} disabled={!mutationsAllowed || draft.cells.length >= 32} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 hover:bg-white/5 disabled:opacity-40"><Plus className="h-4 w-4" /><Braces className="h-4 w-4" /> Python cell</button>
              <button onClick={() => addCell('markdown')} disabled={!mutationsAllowed || draft.cells.length >= 32} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 hover:bg-white/5 disabled:opacity-40"><Plus className="h-4 w-4" /><BookOpen className="h-4 w-4" /> Markdown cell</button>
            </div>
            <section className="rounded-xl border border-white/10 bg-black/20 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-medium text-white">Execution history</h2><p className="mt-1 text-xs text-gray-500">Saved revision snapshots only; untrusted HTML, SVG, and JavaScript outputs are never rendered.</p></div>{runLoading ? <span className="inline-flex items-center gap-2 text-xs text-gray-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</span> : null}</div>
              {runError ? <div role="alert" className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{runError}<button disabled={runLoading} onClick={() => selected && void loadRuns(selected)} className="ml-3 underline disabled:opacity-40">Retry</button></div> : null}
              {runs.length === 0 && !runLoading ? <p className="mt-4 text-sm text-gray-500">No retained runs for this notebook.</p> : <div className="mt-4 grid gap-3 xl:grid-cols-[260px_minmax(0,1fr)]">
                <div className="space-y-1">{runs.map((run) => <button key={run.id} onClick={() => void openRun(run)} disabled={Boolean(runMutation)} className={`w-full rounded-lg px-3 py-2 text-left text-sm ${selectedRun?.id === run.id ? 'bg-primary/20 text-white' : 'text-gray-300 hover:bg-white/5'} disabled:opacity-40`}><span className="block font-medium">{run.status.replace('-', ' ')}</span><span className="mt-1 block text-xs text-gray-500">revision {run.notebookRevision} · {new Date(run.queuedAt).toLocaleString()}</span></button>)}</div>
                {selectedRun ? <div className="min-w-0 rounded-lg border border-white/10 p-3 text-sm text-gray-300">
                  <div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-white/10 px-2 py-1 text-xs uppercase tracking-wide">{selectedRun.status.replace('-', ' ')}</span>{selectedRun.result?.durationMs !== undefined ? <span className="text-xs text-gray-500">{selectedRun.result.durationMs} ms</span> : null}<span className="text-xs text-gray-500">snapshot {selectedRun.snapshotSha256.slice(0, 12)}…</span></div>
                  {selectedRun.error?.message ? <p className="mt-3 rounded bg-red-950/40 p-3 text-red-200">{selectedRun.error.message}{selectedRun.error.cellIndex !== undefined ? ` Cell ${selectedRun.error.cellIndex + 1}.` : ''}</p> : null}
                  {selectedRun.metrics.length > 0 ? <div className="mt-3"><strong className="text-xs text-gray-400">Metrics</strong><div className="mt-1 space-y-1">{selectedRun.metrics.map((metric, index) => <div key={`${metric.name}-${index}`} className="font-mono text-xs">{metric.name}{metric.step !== undefined ? `[${metric.step}]` : ''} = {metric.value}</div>)}</div></div> : null}
                  {selectedRun.artifacts.length > 0 ? <div className="mt-3"><strong className="text-xs text-gray-400">Verified artifacts</strong><div className="mt-1 space-y-1">{selectedRun.artifacts.map((artifact) => <div key={artifact.index} className="truncate text-xs" title={artifact.path}>{artifact.path} · {artifact.bytes} bytes</div>)}</div></div> : null}
                  {!isNotebookRunActive(selectedRun.status) ? <button onClick={() => setDeleteRunTarget(selectedRun)} disabled={Boolean(runMutation)} className="mt-4 inline-flex items-center gap-2 rounded border border-red-400/20 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" />Delete run</button> : <button onClick={() => void cancelRun()} disabled={Boolean(runMutation)} className="mt-4 inline-flex items-center gap-2 rounded border border-amber-400/20 px-3 py-1.5 text-xs text-amber-200 disabled:opacity-40"><Square className="h-3.5 w-3.5" />Stop run</button>}
                </div> : null}
              </div>}
            </section>
          </div>}
      </main>
    </div>
  </div>;
}
