import { FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, Bot, Boxes, Braces, Clock3, Edit2, FolderKanban, GitBranch, Loader2, LockKeyhole, Network, Play, Plus, RefreshCw, Route, Save, StopCircle, Trash2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SlideOver } from '@/components/ui/SlideOver';
import { apiUrl } from '@/config/runtime';
import { useProjectContext } from '@/hooks/useProjectContext';
import { modelApi, workflowApi } from '@/services/api';
import { ModelCatalog, normalizeModelCatalog } from '@/services/modelManager';
import { PROJECT_ARCHIVED_MESSAGE } from '@/services/projectContext';
import { readableApiError, unwrapApiData } from '@/services/runtimeSettings';
import {
  WORKFLOW_INPUT_BYTES,
  WORKFLOW_OUTPUT_BYTES,
  WORKFLOW_RUN_OWNER_RETENTION,
  WorkflowDraft,
  WorkflowRunDetail,
  WorkflowRunPagination,
  WorkflowRunSummary,
  WorkflowView,
  buildWorkflowPayload,
  isTerminalWorkflowRun,
  isWorkflowScopeRequestCurrent,
  normalizeWorkflow,
  normalizeWorkflowRunDeletion,
  normalizeWorkflowRunDetail,
  normalizeWorkflowRunPage,
  normalizeWorkflowRunUsage,
  normalizeWorkflowStreamIdentity,
  normalizeWorkflows,
  workflowDraftError,
  workflowDraftFromView,
  workflowScopeKey,
} from '@/services/workflowModel';
import { getToken } from '@/utils/getToken';
import { readSseResponse } from '@/utils/sse';

const emptyCatalog: ModelCatalog = { provider: 'unknown', modelScope: 'unknown', canPull: false, canDelete: false, models: [] };
const emptyPagination: WorkflowRunPagination = { page: 1, pageSize: 50, total: 0, totalPages: 1 };
const emptyDraft = (model = ''): WorkflowDraft => ({
  name: '', description: '', template: '{{input}}', systemPrompt: 'You are a helpful assistant.', model, temperature: 0.7,
});
const plannedNodes = ['Smart Model Router', 'RAG', 'Document', 'PDF Extract', 'OCR', 'Structured Extract', 'Code Runner', 'Agent', 'Condition', 'Transform', 'Dataset'] as const;
const utf8 = new TextEncoder();
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const dateTime = (value?: string) => value ? new Date(value).toLocaleString() : 'Pending';
const statusLabel = (value: string) => value.replace(/[_-]/g, ' ');
const activeStatus = (value?: string) => value === 'queued' || value === 'running' || value === 'cancel-requested';
const objectId = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);

interface ActiveExecution {
  workflowId: string;
  scope: string;
  generation: number;
  controller: AbortController;
  runId?: string;
  hasRunRecord?: boolean;
}

export default function WorkflowsPage() {
  const navigate = useNavigate();
  const { requested, context, loading: projectLoading, error: projectError } = useProjectContext();
  const projectId = context?.projectId;
  const projectValid = !requested || Boolean(context);
  const mutationsAllowed = projectValid && context?.status !== 'archived';
  const scopeKey = workflowScopeKey(requested, projectId);
  const scopeRef = useRef(scopeKey);
  const mountedRef = useRef(true);
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const runListRequestRef = useRef(0);
  const runDetailRequestRef = useRef(0);
  const mutationRequestRef = useRef(0);
  const executionGenerationRef = useRef(0);
  const selectedWorkflowRef = useRef<string>();
  const activeExecutionRef = useRef<ActiveExecution>();
  const streamedOutputRef = useRef('');

  const [workflows, setWorkflows] = useState<WorkflowView[]>([]);
  const [selected, setSelected] = useState<WorkflowView>();
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState<string>();
  const [catalog, setCatalog] = useState<ModelCatalog>(emptyCatalog);
  const [catalogError, setCatalogError] = useState<string>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowView>();
  const [draft, setDraft] = useState<WorkflowDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [workflowToDelete, setWorkflowToDelete] = useState<WorkflowView>();
  const [deletingWorkflow, setDeletingWorkflow] = useState(false);
  const [input, setInput] = useState('');
  const [executing, setExecuting] = useState(false);
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [pagination, setPagination] = useState<WorkflowRunPagination>(emptyPagination);
  const [runsLoading, setRunsLoading] = useState(false);
  const [selectedRun, setSelectedRun] = useState<WorkflowRunDetail>();
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [runToDelete, setRunToDelete] = useState<WorkflowRunSummary>();
  const [deletingRun, setDeletingRun] = useState(false);

  const requestIsCurrent = useCallback((requestedScope: string, currentGeneration: number, generation: number) => (
    mountedRef.current && isWorkflowScopeRequestCurrent(scopeRef.current, requestedScope, currentGeneration, generation)
  ), []);

  const cancelForScopeChange = useCallback(() => {
    const active = activeExecutionRef.current;
    if (!active) return;
    activeExecutionRef.current = undefined;
    executionGenerationRef.current += 1;
    setExecuting(false);
    if (active.runId) void workflowApi.cancelRun(active.workflowId, active.runId).finally(() => active.controller.abort());
    else active.controller.abort();
  }, []);

  const refresh = useCallback(async () => {
    const requestedScope = scopeKey;
    const generation = ++listRequestRef.current;
    if (!projectValid) {
      setWorkflows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setPageError(undefined);
    try {
      const response = await workflowApi.getWorkflows(projectId);
      if (!requestIsCurrent(requestedScope, listRequestRef.current, generation)) return;
      const normalized = normalizeWorkflows(response.data);
      if (!normalized || (projectId && normalized.some((workflow) => workflow.projectId !== projectId))) throw new Error('The workflow service returned invalid or cross-project definitions.');
      setWorkflows(normalized);
      setSelected((current) => current && normalized.some((workflow) => workflow.id === current.id) ? current : undefined);
    } catch (error) {
      if (requestIsCurrent(requestedScope, listRequestRef.current, generation)) {
        setWorkflows([]);
        setSelected(undefined);
        setPageError(readableApiError(error, 'Workflows could not be loaded.'));
      }
    } finally {
      if (requestIsCurrent(requestedScope, listRequestRef.current, generation)) setLoading(false);
    }
  }, [projectId, projectValid, requestIsCurrent, scopeKey]);

  useEffect(() => {
    let current = true;
    void modelApi.getCatalog().then((response) => {
      if (!current) return;
      const next = normalizeModelCatalog(response.data);
      setCatalog(next);
      setCatalogError(next.models.length ? undefined : 'The configured provider reported no models. Workflow creation and execution are unavailable.');
    }).catch((error) => {
      if (!current) return;
      setCatalog(emptyCatalog);
      setCatalogError(readableApiError(error, 'The model catalog could not be loaded.'));
    });
    return () => { current = false; };
  }, []);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      listRequestRef.current += 1;
      detailRequestRef.current += 1;
      runListRequestRef.current += 1;
      runDetailRequestRef.current += 1;
      mutationRequestRef.current += 1;
      cancelForScopeChange();
    };
  }, [cancelForScopeChange]);

  useLayoutEffect(() => {
    scopeRef.current = scopeKey;
    listRequestRef.current += 1;
    detailRequestRef.current += 1;
    runListRequestRef.current += 1;
    runDetailRequestRef.current += 1;
    mutationRequestRef.current += 1;
    selectedWorkflowRef.current = undefined;
    cancelForScopeChange();
    setWorkflows([]);
    setSelected(undefined);
    setSelectedRun(undefined);
    setRuns([]);
    setPagination(emptyPagination);
    setInput('');
    setPageError(undefined);
    setEditorOpen(false);
    setWorkflowToDelete(undefined);
    setRunToDelete(undefined);
    setLoading(false);
    void refresh();
  }, [cancelForScopeChange, refresh, scopeKey]);

  const loadRuns = async (workflowId: string, page = 1) => {
    const requestedScope = scopeRef.current;
    const generation = ++runListRequestRef.current;
    setRunsLoading(true);
    try {
      const response = await workflowApi.getRuns(workflowId, page);
      const normalized = normalizeWorkflowRunPage(response.data);
      if (!normalized) throw new Error('The workflow service returned invalid run pagination.');
      if (!requestIsCurrent(requestedScope, runListRequestRef.current, generation) || selectedWorkflowRef.current !== workflowId) return;
      if (normalized.runs.some((run) => run.workflowId !== workflowId || (projectId && run.projectId !== projectId))) throw new Error('The workflow service returned cross-scope run history.');
      setRuns(normalized.runs);
      setPagination(normalized.pagination);
    } catch (error) {
      if (requestIsCurrent(requestedScope, runListRequestRef.current, generation) && selectedWorkflowRef.current === workflowId) {
        toast.error(readableApiError(error, 'Workflow run history is unavailable.'));
      }
    } finally {
      if (requestIsCurrent(requestedScope, runListRequestRef.current, generation)) setRunsLoading(false);
    }
  };

  const loadRunDetail = async (workflowId: string, runId: string) => {
    const requestedScope = scopeRef.current;
    const generation = ++runDetailRequestRef.current;
    setRunDetailLoading(true);
    try {
      const response = await workflowApi.getRun(workflowId, runId);
      const normalized = normalizeWorkflowRunDetail(response.data);
      if (!normalized || normalized.workflowId !== workflowId || normalized.id !== runId || (projectId && normalized.projectId !== projectId)) throw new Error('The workflow service returned an invalid run.');
      if (!requestIsCurrent(requestedScope, runDetailRequestRef.current, generation) || selectedWorkflowRef.current !== workflowId) return;
      setSelectedRun(normalized);
    } catch (error) {
      if (requestIsCurrent(requestedScope, runDetailRequestRef.current, generation) && selectedWorkflowRef.current === workflowId) toast.error(readableApiError(error, 'Workflow run details are unavailable.'));
    } finally {
      if (requestIsCurrent(requestedScope, runDetailRequestRef.current, generation)) setRunDetailLoading(false);
    }
  };

  const openWorkflow = async (candidate: WorkflowView) => {
    cancelForScopeChange();
    selectedWorkflowRef.current = candidate.id;
    detailRequestRef.current += 1;
    runListRequestRef.current += 1;
    runDetailRequestRef.current += 1;
    setSelected(undefined);
    setSelectedRun(undefined);
    setRuns([]);
    setPagination(emptyPagination);
    setInput('');
    const requestedScope = scopeRef.current;
    const generation = ++detailRequestRef.current;
    try {
      const response = await workflowApi.getWorkflow(candidate.id);
      const normalized = normalizeWorkflow(response.data);
      if (!normalized || normalized.id !== candidate.id || (projectId && normalized.projectId !== projectId)) throw new Error('The workflow service returned an invalid or cross-project definition.');
      if (!requestIsCurrent(requestedScope, detailRequestRef.current, generation) || selectedWorkflowRef.current !== candidate.id) return;
      setSelected(normalized);
      void loadRuns(normalized.id, 1);
    } catch (error) {
      if (requestIsCurrent(requestedScope, detailRequestRef.current, generation) && selectedWorkflowRef.current === candidate.id) {
        setPageError(readableApiError(error, 'The workflow could not be loaded.'));
      }
    }
  };

  const openEditor = (workflow?: WorkflowView) => {
    if (!mutationsAllowed) return;
    setEditing(workflow);
    setDraft(workflow ? workflowDraftFromView(workflow) : emptyDraft(catalog.models[0]?.id ?? ''));
    setEditorOpen(true);
  };

  const saveWorkflow = async (event: FormEvent) => {
    event.preventDefault();
    if (!mutationsAllowed || saving) return;
    const validationError = workflowDraftError(draft);
    if (validationError) return toast.error(validationError);
    const requestedScope = scopeRef.current;
    const generation = ++mutationRequestRef.current;
    setSaving(true);
    try {
      const payload = buildWorkflowPayload(draft, projectId);
      const response = editing
        ? await workflowApi.updateWorkflow(editing.id, { name: payload.name, description: payload.description, definition: payload.definition })
        : await workflowApi.createWorkflow(payload);
      const normalized = normalizeWorkflow(response.data);
      if (!normalized || (editing && normalized.id !== editing.id) || (projectId && normalized.projectId !== projectId)) throw new Error('The workflow service returned an invalid saved definition.');
      if (!requestIsCurrent(requestedScope, mutationRequestRef.current, generation)) return;
      setEditorOpen(false);
      setEditing(undefined);
      toast.success(editing ? 'Workflow updated.' : 'Workflow created.');
      await refresh();
      if (requestIsCurrent(requestedScope, mutationRequestRef.current, generation)) void openWorkflow(normalized);
    } catch (error) {
      if (requestIsCurrent(requestedScope, mutationRequestRef.current, generation)) toast.error(readableApiError(error, 'The workflow could not be saved.'));
    } finally {
      if (requestIsCurrent(requestedScope, mutationRequestRef.current, generation)) setSaving(false);
    }
  };

  const deleteWorkflow = async () => {
    const target = workflowToDelete;
    if (!target || !mutationsAllowed || deletingWorkflow) return;
    const requestedScope = scopeRef.current;
    const generation = ++mutationRequestRef.current;
    setDeletingWorkflow(true);
    try {
      const response = await workflowApi.deleteWorkflow(target.id);
      const result = record(unwrapApiData(response.data));
      if (result.deleted !== true || result.workflowId !== target.id) throw new Error('The workflow service returned an invalid deletion result.');
      if (!requestIsCurrent(requestedScope, mutationRequestRef.current, generation)) return;
      if (selectedWorkflowRef.current === target.id) {
        selectedWorkflowRef.current = undefined;
        setSelected(undefined);
        setSelectedRun(undefined);
        setRuns([]);
      }
      setWorkflowToDelete(undefined);
      toast.success('Workflow deleted.');
      await refresh();
    } catch (error) {
      if (requestIsCurrent(requestedScope, mutationRequestRef.current, generation)) toast.error(readableApiError(error, 'The workflow could not be deleted. Delete its retained terminal runs first.'));
    } finally {
      if (requestIsCurrent(requestedScope, mutationRequestRef.current, generation)) setDeletingWorkflow(false);
    }
  };

  const cancelExecution = async (active: ActiveExecution) => {
    try {
      if (active.runId) await workflowApi.cancelRun(active.workflowId, active.runId);
    } catch (error) {
      if (activeExecutionRef.current === active) toast.error(readableApiError(error, 'The workflow cancellation request failed.'));
    } finally {
      active.controller.abort();
      if (activeExecutionRef.current === active) {
        activeExecutionRef.current = undefined;
        executionGenerationRef.current += 1;
        setExecuting(false);
      }
    }
  };

  const execute = async () => {
    if (!selected || !input.trim() || !mutationsAllowed || executing) return;
    if (utf8.encode(input).byteLength > WORKFLOW_INPUT_BYTES) return toast.error('Workflow input must be 16 KiB or smaller.');
    const token = getToken();
    if (!token) return toast.error('Authentication is required.');
    const controller = new AbortController();
    const active: ActiveExecution = { workflowId: selected.id, scope: scopeRef.current, generation: ++executionGenerationRef.current, controller };
    activeExecutionRef.current = active;
    streamedOutputRef.current = '';
    setExecuting(true);
    setSelectedRun(undefined);
    const isCurrent = () => mountedRef.current && activeExecutionRef.current === active && executionGenerationRef.current === active.generation
      && scopeRef.current === active.scope && selectedWorkflowRef.current === active.workflowId;
    try {
      const response = await fetch(apiUrl(`/workflows/${active.workflowId}/runs`), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ input }), signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        throw new Error(readableApiError({ response: { data: payload } }, `Workflow execution failed with HTTP ${response.status}.`));
      }
      await readSseResponse(response, (data, eventName) => {
        if (!isCurrent()) return;
        if (!eventName && data === '[DONE]') return;
        if (!eventName) throw new Error('The workflow stream returned an unnamed event.');
        const payload = JSON.parse(data) as unknown;
        const event = record(payload);
        if (eventName === 'run' || eventName === 'completed') {
          const detail = normalizeWorkflowRunDetail(payload);
          if (!detail || detail.workflowId !== active.workflowId || (active.runId && active.runId !== detail.id)) throw new Error('The workflow stream returned an invalid run record.');
          active.runId = detail.id;
          active.hasRunRecord = true;
          streamedOutputRef.current = detail.output;
          setSelectedRun(detail);
        } else if (eventName === 'start') {
          const identity = normalizeWorkflowStreamIdentity(event.provider, event.model);
          if (!objectId(event.runId) || !identity) throw new Error('The workflow stream returned invalid provider metadata.');
          if (active.runId && active.runId !== event.runId) throw new Error('The workflow stream changed run identifiers.');
          active.runId = event.runId;
          setSelectedRun((current) => current && current.id === event.runId ? { ...current, status: 'running', ...identity } : current);
        } else if (eventName === 'delta') {
          if (!active.hasRunRecord || event.runId !== active.runId || typeof event.content !== 'string') throw new Error('The workflow stream returned an invalid output chunk.');
          const output = streamedOutputRef.current + event.content;
          const outputBytes = utf8.encode(output).byteLength;
          if (outputBytes > WORKFLOW_OUTPUT_BYTES) {
            void cancelExecution(active);
            throw new Error('Workflow output exceeded the 256 KiB client limit.');
          }
          streamedOutputRef.current = output;
          setSelectedRun((current) => current && current.id === event.runId ? { ...current, output, outputBytes } : current);
        } else if (eventName === 'usage') {
          if (event.runId !== active.runId) throw new Error('The usage event referenced a different run.');
          const usage = normalizeWorkflowRunUsage(event.usage);
          if (!usage) throw new Error('The workflow stream returned invalid usage data.');
          setSelectedRun((current) => current ? { ...current, usage } : current);
        } else if (eventName === 'error') {
          const message = typeof event.error === 'string' && event.error.length <= 300 ? event.error : typeof event.message === 'string' && event.message.length <= 300 ? event.message : 'Workflow execution failed.';
          throw new Error(message);
        } else {
          throw new Error(`The workflow stream returned an unsupported ${eventName} event.`);
        }
      });
      if (active.runId && isCurrent()) await loadRunDetail(active.workflowId, active.runId);
    } catch (error) {
      if ((error as Error).name !== 'AbortError' && isCurrent()) toast.error(error instanceof Error ? error.message : 'Workflow execution failed.');
      if (active.runId && scopeRef.current === active.scope && selectedWorkflowRef.current === active.workflowId) await loadRunDetail(active.workflowId, active.runId).catch(() => undefined);
    } finally {
      if (activeExecutionRef.current === active) {
        activeExecutionRef.current = undefined;
        setExecuting(false);
      }
      if (scopeRef.current === active.scope && selectedWorkflowRef.current === active.workflowId) await loadRuns(active.workflowId, 1);
    }
  };

  const deleteRun = async () => {
    const workflowId = selectedWorkflowRef.current;
    const target = runToDelete;
    if (!workflowId || !target || !isTerminalWorkflowRun(target) || !mutationsAllowed || deletingRun) return;
    const requestedScope = scopeRef.current;
    const generation = ++mutationRequestRef.current;
    setDeletingRun(true);
    try {
      const response = await workflowApi.deleteRun(workflowId, target.id);
      const result = normalizeWorkflowRunDeletion(response.data);
      if (!result || result.runId !== target.id) throw new Error('The workflow service returned an invalid run deletion result.');
      if (!requestIsCurrent(requestedScope, mutationRequestRef.current, generation) || selectedWorkflowRef.current !== workflowId) return;
      if (selectedRun?.id === target.id) setSelectedRun(undefined);
      const targetPage = runs.length === 1 && pagination.page > 1 ? pagination.page - 1 : pagination.page;
      setRunToDelete(undefined);
      toast.success('Workflow run deleted.');
      await loadRuns(workflowId, targetPage);
    } catch (error) {
      if (requestIsCurrent(requestedScope, mutationRequestRef.current, generation)) toast.error(readableApiError(error, 'The workflow run could not be deleted.'));
    } finally {
      if (requestIsCurrent(requestedScope, mutationRequestRef.current, generation)) setDeletingRun(false);
    }
  };

  const llmConfig = selected?.definition.nodes[2].config as { model: string; temperature: number } | undefined;
  const promptConfig = selected?.definition.nodes[1].config as { template: string; systemPrompt: string } | undefined;
  const currentModelMissing = Boolean(draft.model && !catalog.models.some((model) => model.id === draft.model));

  return <div className="mx-auto max-w-7xl space-y-6 p-6 md:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-3"><h1 className="flex items-center gap-3 text-3xl font-bold text-white"><GitBranch className="text-primary" />Workflows</h1><span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-amber-200">Experimental</span></div><p className="mt-2 text-gray-400">Build and execute the supported fixed linear workflow with durable history.</p></div><div className="flex gap-2"><button onClick={() => void refresh()} disabled={loading || !projectValid} aria-label="Refresh workflows" className="rounded-xl border border-white/10 bg-white/5 p-2.5 text-gray-300 disabled:opacity-40"><RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} /></button><button onClick={() => openEditor()} disabled={!mutationsAllowed || !catalog.models.length} className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"><Plus className="h-4 w-4" />New workflow</button></div></header>

    <div role="alert" className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-100"><LockKeyhole className="mr-2 inline h-4 w-4" />Workflow prompt templates, system prompts, immutable definition snapshots, run inputs, generated output, provider metadata, and timelines are persisted. Do not include passwords, tokens, or other secrets.</div>
    {projectLoading ? <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-gray-400">Verifying project context…</div> : null}
    {projectError ? <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">{projectError} No unscoped workflow request was made.</div> : null}
    {context?.status === 'archived' ? <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">{PROJECT_ARCHIVED_MESSAGE} Definitions and run history remain readable.</div> : null}
    {context ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3"><div className="flex min-w-0 items-center gap-3"><FolderKanban className="h-5 w-5 shrink-0 text-primary" /><div className="min-w-0"><p className="text-xs uppercase tracking-wide text-gray-500">Project workflows</p><p className="truncate font-medium text-white">{context.projectName} <span className="text-xs capitalize text-gray-500">({context.status})</span></p></div></div><button onClick={() => navigate('/app/workflows', { replace: true, state: null })} className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-300"><X className="h-3.5 w-3.5" />Show workspace workflows</button></div> : null}
    {catalogError ? <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-200">{catalogError}</div> : <p className="text-xs text-gray-500">Models reported by {catalog.provider} · {catalog.modelScope}</p>}
    {pageError ? <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">{pageError}</div> : null}

    <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="h-fit rounded-2xl border border-white/10 bg-white/5 p-4"><div className="flex items-center justify-between"><h2 className="font-semibold text-white">Saved workflows</h2><span className="text-xs text-gray-500">{workflows.length}</span></div><div className="mt-4 space-y-2">{workflows.map((workflow) => <div key={workflow.id} className={`flex rounded-xl border ${selected?.id === workflow.id ? 'border-primary/40 bg-primary/10' : 'border-white/5 bg-black/20'}`}><button onClick={() => void openWorkflow(workflow)} className="min-w-0 flex-1 p-3 text-left"><p className="truncate text-sm font-medium text-white">{workflow.name}</p><p className="mt-1 line-clamp-2 text-xs text-gray-500">{workflow.description || 'No description'}</p><p className="mt-2 text-[10px] text-gray-600">Revision {workflow.revision} · {dateTime(workflow.updatedAt)}</p></button><button onClick={() => setWorkflowToDelete(workflow)} disabled={!mutationsAllowed} aria-label={`Delete ${workflow.name}`} className="m-2 rounded-lg p-1.5 text-gray-600 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-30"><Trash2 className="h-3.5 w-3.5" /></button></div>)}{!loading && !workflows.length && !pageError ? <p className="rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-gray-500">No saved workflows in this scope.</p> : null}</div></aside>

      <main className="min-w-0 space-y-6">{selected ? <>
        <section className="rounded-2xl border border-white/10 bg-white/5 p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold text-white">{selected.name}</h2><p className="mt-1 text-sm text-gray-500">Schema 1 · revision {selected.revision} · updated {dateTime(selected.updatedAt)}</p></div><button onClick={() => openEditor(selected)} disabled={!mutationsAllowed || executing} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-200 disabled:opacity-40"><Edit2 className="h-4 w-4" />Edit definition</button></div>{selected.description ? <p className="mt-4 text-sm text-gray-400">{selected.description}</p> : null}
          <div className="mt-5 overflow-x-auto pb-2"><div className="grid min-w-[900px] grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] items-stretch gap-3">
            <NodeCard icon={<Braces className="h-5 w-5" />} title="Input" detail="Bounded text supplied for each run." />
            <Connector />
            <NodeCard icon={<Route className="h-5 w-5" />} title="Prompt" detail={promptConfig?.template || ''} metadata={promptConfig?.systemPrompt} />
            <Connector />
            <NodeCard icon={<Bot className="h-5 w-5" />} title="LLM" detail={llmConfig?.model || 'No model'} metadata={`Temperature ${llmConfig?.temperature ?? '?'}`} />
            <Connector />
            <NodeCard icon={<Boxes className="h-5 w-5" />} title="Output" detail="Persisted bounded model response." />
          </div></div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-5"><div><h2 className="font-semibold text-white">Run workflow</h2><p className="mt-1 text-sm text-gray-500">The prompt template receives this value at its single <code>{'{{input}}'}</code> marker.</p></div><textarea value={input} onChange={(event) => setInput(event.target.value)} maxLength={WORKFLOW_INPUT_BYTES} disabled={!mutationsAllowed || executing} placeholder={mutationsAllowed ? 'Enter workflow input…' : 'Archived projects are read-only.'} className="mt-4 min-h-28 w-full resize-y rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-white disabled:opacity-50" /><div className="mt-3 flex justify-end">{executing ? <button onClick={() => { const active = activeExecutionRef.current; if (active) void cancelExecution(active); }} className="inline-flex items-center gap-2 rounded-lg bg-red-500/20 px-4 py-2 text-sm font-medium text-red-200"><StopCircle className="h-4 w-4" />Cancel run</button> : <button onClick={() => void execute()} disabled={!mutationsAllowed || !input.trim()} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40"><Play className="h-4 w-4" />Run workflow</button>}</div></section>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
          <section className="min-w-0 rounded-2xl border border-white/10 bg-white/5 p-5"><h2 className="font-semibold text-white">Run detail</h2>{runDetailLoading ? <p className="mt-5 flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />Loading run details…</p> : selectedRun ? <div className="mt-4 space-y-4"><div className="grid gap-3 text-sm sm:grid-cols-4"><Metric label="Status" value={statusLabel(selectedRun.status)} /><Metric label="Provider" value={selectedRun.provider ?? 'Pending'} /><Metric label="Model" value={selectedRun.model ?? selectedRun.workflow.requestedModel} /><Metric label="Usage" value={selectedRun.usage?.totalTokens !== undefined ? `${selectedRun.usage.totalTokens.toLocaleString()} tokens` : 'Unavailable'} /></div>{selectedRun.error ? <div role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{selectedRun.error.message} <span className="font-mono text-xs">({selectedRun.error.code})</span></div> : null}<div className="rounded-xl border border-white/5 bg-black/50 p-4"><p className="text-xs uppercase tracking-wide text-gray-500">Output · {selectedRun.outputBytes.toLocaleString()} bytes{selectedRun.outputTruncated ? ' · truncated' : ''}</p><pre className="mt-3 whitespace-pre-wrap break-words font-mono text-sm text-gray-200">{selectedRun.output || (executing ? 'Waiting for output…' : 'No output was recorded.')}</pre></div><div><h3 className="text-sm font-medium text-gray-300">Timeline</h3><ol className="mt-2 space-y-2">{selectedRun.timeline.map((event) => <li key={`${event.sequence}:${event.type}`} className="flex items-start gap-3 rounded-lg border border-white/5 bg-black/20 p-3 text-sm"><Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><div><p className="capitalize text-gray-200">{statusLabel(event.type)}</p><p className="mt-1 text-xs text-gray-500">{dateTime(event.timestamp)}{event.provider ? ` · ${event.provider}` : ''}{event.model ? ` · ${event.model}` : ''}{event.code ? ` · ${event.code}` : ''}</p></div></li>)}</ol></div></div> : <p className="mt-6 rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-gray-500">Run the workflow or select a historical run.</p>}</section>
          <aside className="h-fit rounded-2xl border border-white/10 bg-white/5 p-4"><div><div className="flex items-center justify-between"><h2 className="font-semibold text-white">Run history</h2><span className="text-xs text-gray-500">{pagination.total}</span></div><p className="mt-1 text-xs text-gray-600">Owner retention cap: {WORKFLOW_RUN_OWNER_RETENTION}. Delete terminal runs to reclaim capacity.</p></div><div className="mt-4 space-y-2">{runsLoading ? <p className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p> : runs.map((run) => <div key={run.id} className={`flex rounded-xl border ${selectedRun?.id === run.id ? 'border-primary/40 bg-primary/10' : 'border-white/5 bg-black/20'}`}><button onClick={() => void loadRunDetail(selected.id, run.id)} className="min-w-0 flex-1 p-3 text-left"><div className="flex items-center justify-between gap-2"><span className="truncate text-[10px] text-gray-600">{run.id}</span><span className={`text-xs capitalize ${activeStatus(run.status) ? 'text-cyan-300' : run.status === 'succeeded' ? 'text-emerald-300' : 'text-amber-300'}`}>{statusLabel(run.status)}</span></div><p className="mt-2 text-xs text-gray-400">{dateTime(run.createdAt ?? run.queuedAt)}</p><p className="mt-1 truncate text-xs text-gray-500">{run.provider ?? 'Provider pending'} · {run.model ?? run.workflow.requestedModel}</p></button>{mutationsAllowed && isTerminalWorkflowRun(run) ? <button onClick={() => setRunToDelete(run)} aria-label={`Delete run ${run.id}`} className="m-2 rounded-lg p-1.5 text-gray-600 hover:bg-red-500/10 hover:text-red-300"><Trash2 className="h-3.5 w-3.5" /></button> : null}</div>)}{!runsLoading && !runs.length ? <p className="py-5 text-center text-sm text-gray-500">No runs on this page.</p> : null}</div><div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3"><button onClick={() => void loadRuns(selected.id, pagination.page - 1)} disabled={runsLoading || pagination.page <= 1} className="rounded-lg border border-white/10 px-2 py-1 text-xs text-gray-300 disabled:opacity-30">Previous</button><span className="text-xs text-gray-500">{pagination.page} / {pagination.totalPages}</span><button onClick={() => void loadRuns(selected.id, pagination.page + 1)} disabled={runsLoading || pagination.page >= pagination.totalPages} className="rounded-lg border border-white/10 px-2 py-1 text-xs text-gray-300 disabled:opacity-30">Next</button></div></aside>
        </div>
      </> : <section className="flex min-h-80 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-center text-gray-500"><div><Network className="mx-auto h-10 w-10" /><p className="mt-3">Select or create a workflow.</p></div></section>}

        <section className="rounded-2xl border border-white/10 bg-white/5 p-5"><h2 className="font-semibold text-white">Planned nodes</h2><p className="mt-1 text-sm text-gray-500">These Phase 10 node types are unavailable in this bounded slice. They cannot be added or executed.</p><div className="mt-4 flex flex-wrap gap-2">{plannedNodes.map((node) => <button key={node} type="button" disabled className="cursor-not-allowed rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-gray-500"><span>{node}</span><span className="ml-2 rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase">Planned</span></button>)}</div></section>
      </main>
    </div>

    <SlideOver isOpen={editorOpen} onClose={() => { if (!saving) setEditorOpen(false); }} title={editing ? 'Edit workflow' : 'Create workflow'}><form onSubmit={saveWorkflow} className="space-y-5"><label className="block text-sm text-gray-300">Name<input required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white" /></label><label className="block text-sm text-gray-300">Description<textarea maxLength={2000} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} className="mt-1 min-h-20 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white" /></label><label className="block text-sm text-gray-300">System prompt<textarea required maxLength={16384} value={draft.systemPrompt} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} className="mt-1 min-h-28 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-white" /></label><label className="block text-sm text-gray-300">Prompt template<textarea required maxLength={16384} value={draft.template} onChange={(event) => setDraft({ ...draft, template: event.target.value })} className="mt-1 min-h-28 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-white" /><span className="mt-1 block text-xs text-gray-500">Must contain <code>{'{{input}}'}</code> exactly once.</span></label><label className="block text-sm text-gray-300">Model<select required value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white"><option value="">Choose a model</option>{currentModelMissing ? <option value={draft.model}>{draft.model} (current, not reported)</option> : null}{catalog.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select><span className="mt-1 block text-xs text-gray-500">{catalog.provider} · no silent model or provider fallback</span></label><label className="block text-sm text-gray-300"><span className="flex justify-between"><span>Temperature</span><span className="text-primary">{draft.temperature}</span></span><input type="range" min="0" max="2" step="0.1" value={draft.temperature} onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })} className="mt-3 w-full accent-primary" /></label><button disabled={saving || !mutationsAllowed} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 font-medium text-white disabled:opacity-40">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{saving ? 'Saving…' : 'Save workflow'}</button></form></SlideOver>
    <ConfirmDialog isOpen={Boolean(workflowToDelete)} title="Delete Workflow" message="Delete this workflow definition? The backend will refuse while retained run history exists. Delete terminal runs first so audit records are not orphaned." confirmText={deletingWorkflow ? 'Deleting…' : 'Delete Workflow'} isDestructive onConfirm={() => void deleteWorkflow()} onCancel={() => { if (!deletingWorkflow) setWorkflowToDelete(undefined); }} />
    <ConfirmDialog isOpen={Boolean(runToDelete)} title="Delete Workflow Run" message="Delete this terminal run and its persisted input, output, provider metadata, usage, and timeline? This cannot be undone." confirmText={deletingRun ? 'Deleting…' : 'Delete Run'} isDestructive onConfirm={() => void deleteRun()} onCancel={() => { if (!deletingRun) setRunToDelete(undefined); }} />
  </div>;
}

function NodeCard({ icon, title, detail, metadata }: { icon: JSX.Element; title: string; detail: string; metadata?: string }) {
  return <article className="min-w-0 rounded-xl border border-primary/20 bg-black/30 p-4"><div className="flex items-center gap-2 text-primary">{icon}<h3 className="font-semibold text-white">{title}</h3></div><p className="mt-3 line-clamp-3 break-words text-xs text-gray-400">{detail}</p>{metadata ? <p className="mt-2 line-clamp-2 break-words text-[11px] text-gray-600">{metadata}</p> : null}</article>;
}

function Connector() {
  return <div className="flex items-center justify-center text-primary"><ArrowRight className="hidden h-5 w-5 lg:block" /><ArrowDown className="h-5 w-5 lg:hidden" /></div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-lg bg-black/20 p-3"><p className="text-xs text-gray-500">{label}</p><p className="mt-1 truncate capitalize text-white">{value}</p></div>;
}
