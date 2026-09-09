import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, BarChart3, Clock3, Cpu, Download, FolderKanban, Gauge, Loader2, Play, RefreshCw, StopCircle, Trash2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { apiUrl } from '@/config/runtime';
import { useProjectContext } from '@/hooks/useProjectContext';
import { benchmarkApi, modelApi } from '@/services/api';
import {
  BENCHMARK_CALLS,
  BENCHMARK_SUITE_ID,
  BenchmarkAggregate,
  BenchmarkGpuSnapshot,
  BenchmarkPagination,
  BenchmarkResult,
  BenchmarkRunDetail,
  BenchmarkRunSummary,
  BenchmarkStatus,
  BenchmarkSuite,
  areBenchmarkRunsCompatible,
  benchmarkReport,
  benchmarkResumeKey,
  benchmarkScopeKey,
  buildBenchmarkRunPayload,
  effectiveBenchmarkProjectStatus,
  isBenchmarkScopeRequestCurrent,
  isTerminalBenchmarkRun,
  normalizeBenchmarkCallCompleted,
  normalizeBenchmarkCallStart,
  normalizeBenchmarkRunEvent,
  normalizeBenchmarkRunDeletion,
  normalizeBenchmarkRunDetail,
  normalizeBenchmarkRunPage,
  normalizeBenchmarkStatus,
  normalizeBenchmarkStreamError,
  normalizeBenchmarkSuites,
} from '@/services/benchmarkModel';
import { ModelCatalog, normalizeModelCatalog } from '@/services/modelManager';
import { PROJECT_ARCHIVED_MESSAGE } from '@/services/projectContext';
import { readableApiError } from '@/services/runtimeSettings';
import { getToken } from '@/utils/getToken';
import { readSseResponse } from '@/utils/sse';

const emptyPagination: BenchmarkPagination = { page: 1, pageSize: 25, total: 0, totalPages: 1, maxPages: 10 };
const emptyCatalog: ModelCatalog = { provider: 'unknown', modelScope: 'unknown', canPull: false, canDelete: false, models: [] };
const activeStatus = (value?: string) => value === 'queued' || value === 'running' || value === 'cancel-requested';
const statusText = (value: string) => value.replace(/[_-]/g, ' ');
const dateTime = (value?: string) => value ? new Date(value).toLocaleString() : 'Not reported';
const duration = (value?: number) => value === undefined ? 'Not reported' : value < 1_000 ? `${value.toLocaleString()} ms` : `${(value / 1_000).toFixed(2)} s`;
const bytes = (value?: number) => value === undefined ? 'Not reported' : `${value.toLocaleString()} B`;
class BenchmarkStreamContractError extends Error {}
class BenchmarkStreamTerminalError extends Error {}
interface ActiveRun { controller: AbortController; scope: string; request: number; revision: number; runId?: string }

const reconnectPause = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) {
    reject(new DOMException('The benchmark stream was closed.', 'AbortError'));
    return;
  }
  const onAbort = () => {
    window.clearTimeout(timeout);
    reject(new DOMException('The benchmark stream was closed.', 'AbortError'));
  };
  const timeout = window.setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolve();
  }, 750);
  signal.addEventListener('abort', onAbort, { once: true });
});
const requireEventStream = (response: Response, fallback: string): Response => {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) throw new BenchmarkStreamTerminalError(fallback);
  return response;
};

export default function BenchmarksPage() {
  const navigate = useNavigate();
  const { requested, context, loading: projectLoading, error: projectError } = useProjectContext();
  const projectId = context?.projectId;
  const projectValid = !requested || Boolean(context);
  const scopeKey = benchmarkScopeKey(requested, projectId);
  const scopeRef = useRef(scopeKey);
  const mountedRef = useRef(true);
  const refreshRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const streamRequestRef = useRef(0);
  const activeRunRef = useRef<ActiveRun>();
  const failedResumeRef = useRef<string>();

  const [status, setStatus] = useState<BenchmarkStatus>();
  const [suite, setSuite] = useState<BenchmarkSuite>();
  const [catalog, setCatalog] = useState<ModelCatalog>(emptyCatalog);
  const [model, setModel] = useState('');
  const [runs, setRuns] = useState<BenchmarkRunSummary[]>([]);
  const [pagination, setPagination] = useState<BenchmarkPagination>(emptyPagination);
  const [selected, setSelected] = useState<BenchmarkRunDetail>();
  const [comparison, setComparison] = useState<BenchmarkRunSummary>();
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string>();
  const [statusError, setStatusError] = useState<string>();
  const [suiteError, setSuiteError] = useState<string>();
  const [catalogError, setCatalogError] = useState<string>();
  const [historyError, setHistoryError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<BenchmarkRunSummary>();
  const [deleting, setDeleting] = useState(false);
  const projectStatus = context
    ? effectiveBenchmarkProjectStatus(context.status, status?.scope.type === 'project' ? status.scope.projectStatus : undefined)
    : undefined;
  const mutationsAllowed = projectValid && projectStatus !== 'archived';

  scopeRef.current = scopeKey;
  const requestCurrent = useCallback((requestScope: string, currentRequest: number, request: number) => mountedRef.current && isBenchmarkScopeRequestCurrent(scopeRef.current, requestScope, currentRequest, request), []);

  const loadRun = useCallback(async (runId: string) => {
    const requestScope = scopeRef.current;
    const request = ++detailRequestRef.current;
    setDetailLoading(true);
    setDetailError(undefined);
    try {
      const response = await benchmarkApi.getRun(runId);
      if (!requestCurrent(requestScope, detailRequestRef.current, request)) return;
      const detail = normalizeBenchmarkRunDetail(response.data);
      if (!detail || detail.id !== runId || detail.projectId !== projectId) throw new Error('The benchmark service returned an invalid run detail for this scope.');
      setSelected(detail);
      setComparison((current) => areBenchmarkRunsCompatible(detail, current) ? current : undefined);
    } catch (error) {
      if (requestCurrent(requestScope, detailRequestRef.current, request)) setDetailError(readableApiError(error, error instanceof Error ? error.message : 'Benchmark detail could not be loaded.'));
    } finally {
      if (requestCurrent(requestScope, detailRequestRef.current, request)) setDetailLoading(false);
    }
  }, [projectId, requestCurrent]);

  const refresh = useCallback(async (page = 1) => {
    const requestScope = scopeRef.current;
    const request = ++refreshRequestRef.current;
    if (!projectValid) {
      setStatus(undefined); setSuite(undefined); setCatalog(emptyCatalog); setRuns([]); setPagination(emptyPagination); setLoading(false);
      return;
    }
    setLoading(true);
    const [statusResult, suiteResult, catalogResult, historyResult] = await Promise.allSettled([
      benchmarkApi.getStatus(projectId), benchmarkApi.getSuites(), modelApi.getCatalog(), benchmarkApi.getRuns(page, projectId),
    ]);
    if (!requestCurrent(requestScope, refreshRequestRef.current, request)) return;
    if (statusResult.status === 'fulfilled') {
      const next = normalizeBenchmarkStatus(statusResult.value.data);
      setStatus(next); setStatusError(next ? undefined : 'The benchmark service returned an invalid status contract.');
    } else { setStatus(undefined); setStatusError(readableApiError(statusResult.reason, 'Benchmark execution status is unavailable.')); }
    if (suiteResult.status === 'fulfilled') {
      const next = normalizeBenchmarkSuites(suiteResult.value.data);
      setSuite(next?.[0]); setSuiteError(next ? undefined : 'The benchmark service returned an unsupported suite contract.');
    } else { setSuite(undefined); setSuiteError(readableApiError(suiteResult.reason, 'Benchmark suites are unavailable.')); }
    if (catalogResult.status === 'fulfilled') {
      const next = normalizeModelCatalog(catalogResult.value.data);
      setCatalog(next);
      setModel((current) => next.models.some((item) => item.id === current) ? current : next.models[0]?.id ?? '');
      setCatalogError(undefined);
    } else { setCatalog(emptyCatalog); setModel(''); setCatalogError(readableApiError(catalogResult.reason, 'The model catalog is unavailable.')); }
    if (historyResult.status === 'fulfilled') {
      const next = normalizeBenchmarkRunPage(historyResult.value.data);
      if (next) { setRuns(next.runs); setPagination(next.pagination); setHistoryError(undefined); }
      else { setRuns([]); setPagination(emptyPagination); setHistoryError('The benchmark service returned invalid run pagination.'); }
    } else { setRuns([]); setPagination(emptyPagination); setHistoryError(readableApiError(historyResult.reason, 'Benchmark history is unavailable.')); }
    setLoading(false);
  }, [projectId, projectValid, requestCurrent]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshRequestRef.current += 1; detailRequestRef.current += 1; streamRequestRef.current += 1;
      const active = activeRunRef.current;
      if (active) active.controller.abort();
    };
  }, []);

  useLayoutEffect(() => {
    const previous = activeRunRef.current;
    if (previous) previous.controller.abort();
    activeRunRef.current = undefined;
    failedResumeRef.current = undefined;
    refreshRequestRef.current += 1; detailRequestRef.current += 1; streamRequestRef.current += 1;
    setRunning(false); setProgress(undefined); setSelected(undefined); setComparison(undefined); setRuns([]); setPagination(emptyPagination);
    setDeleteTarget(undefined); setDeleting(false);
    setStatusError(undefined); setSuiteError(undefined); setCatalogError(undefined); setHistoryError(undefined); setDetailError(undefined);
    void refresh(1);
  }, [refresh, scopeKey]);

  const stopRun = async () => {
    const active = activeRunRef.current;
    if (!active?.runId) return;
    try {
      const response = await benchmarkApi.cancelRun(active.runId);
      const detail = normalizeBenchmarkRunDetail(response.data);
      if (!detail || detail.id !== active.runId || detail.projectId !== projectId) throw new Error('The benchmark service returned an invalid cancellation result.');
      if (activeRunRef.current === active) setProgress('Cancellation requested. The durable worker is stopping the run.');
    } catch (error) {
      toast.error(readableApiError(error, 'The cancellation request failed.'));
    }
  };

  const consumeStream = useCallback(async (response: Response, active: ActiveRun): Promise<boolean> => {
    let done = false;
    const isCurrent = () => activeRunRef.current === active && active.scope === scopeRef.current && active.request === streamRequestRef.current;
    await readSseResponse(response, (data, eventName, eventId) => {
      if (!isCurrent()) return;
      if (!eventName) {
        if (data !== '[DONE]' || eventId !== undefined) throw new BenchmarkStreamContractError('The benchmark stream returned an invalid completion sentinel.');
        done = true;
        return;
      }
      let payload: unknown;
      try { payload = JSON.parse(data) as unknown; }
      catch { throw new BenchmarkStreamContractError('The benchmark stream returned invalid JSON.'); }
      if (eventName === 'run' || eventName === 'completed') {
        const replayedTerminalRevision = eventName === 'completed' && eventId === String(active.revision);
        const event = normalizeBenchmarkRunEvent(payload, eventId, active.runId, replayedTerminalRevision ? active.revision - 1 : active.revision);
        if (!event || event.run.projectId !== projectId || (eventName === 'run' && isTerminalBenchmarkRun(event.run)) || (eventName === 'completed' && !isTerminalBenchmarkRun(event.run))) {
          throw new BenchmarkStreamContractError('The benchmark stream changed run identity, revision, state, or scope.');
        }
        active.runId = event.run.id;
        active.revision = event.revision;
        setSelected(event.run);
        setProgress(eventName === 'completed' ? 'Run reached a terminal state; loading canonical detail…' : `${event.run.completedCalls} of ${BENCHMARK_CALLS} calls completed.`);
      } else if (eventName === 'call-start') {
        const event = normalizeBenchmarkCallStart(payload, eventId, active.runId, active.revision);
        if (!event) throw new BenchmarkStreamContractError('The benchmark stream returned an invalid call identity or revision.');
        active.runId = event.runId;
        active.revision = event.revision;
        setProgress(`Running prompt ${event.promptIndex + 1}, repetition ${event.repetition} — call ${event.callIndex + 1} of ${BENCHMARK_CALLS}.`);
      } else if (eventName === 'call-completed') {
        const event = normalizeBenchmarkCallCompleted(payload, eventId, active.runId, active.revision);
        if (!event) throw new BenchmarkStreamContractError('The benchmark stream returned an invalid call result identity or revision.');
        active.runId = event.runId;
        active.revision = event.revision;
        setProgress(`Completed ${event.result.callIndex + 1} of ${BENCHMARK_CALLS} sequential calls.`);
      } else if (eventName === 'error') {
        const event = normalizeBenchmarkStreamError(payload, eventId, active.revision);
        if (!event) throw new BenchmarkStreamContractError('The benchmark stream returned an invalid error event or revision.');
        active.revision = event.revision;
        throw new BenchmarkStreamTerminalError(`${event.error} (${event.code})`);
      } else {
        throw new BenchmarkStreamContractError(`The benchmark stream returned an unsupported ${eventName} event.`);
      }
    });
    return done;
  }, [projectId]);

  const followDurableStream = useCallback(async (initialResponse: Response, active: ActiveRun, token: string) => {
    let response = initialResponse;
    const isCurrent = () => activeRunRef.current === active && active.scope === scopeRef.current && active.request === streamRequestRef.current;
    while (isCurrent()) {
      try {
        if (await consumeStream(response, active)) return;
      } catch (error) {
        if (error instanceof BenchmarkStreamContractError || error instanceof BenchmarkStreamTerminalError || (error as Error).name === 'AbortError') throw error;
      }
      if (!active.runId) throw new BenchmarkStreamContractError('The benchmark stream disconnected before reporting a run identity.');
      setProgress('Stream disconnected. Reconnecting to the durable run…');
      await reconnectPause(active.controller.signal);
      try {
        response = await fetch(apiUrl(`/benchmarks/runs/${active.runId}/stream`), {
          method: 'GET',
          headers: { Authorization: `Bearer ${getToken() ?? token}`, 'Last-Event-ID': String(active.revision) },
          signal: active.controller.signal,
        });
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        continue;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        throw new BenchmarkStreamTerminalError(readableApiError({ response: { data: payload } }, `Benchmark reconnect failed with HTTP ${response.status}.`));
      }
      requireEventStream(response, 'The benchmark reconnect returned an invalid content type.');
    }
  }, [consumeStream]);

  const settleStream = useCallback(async (active: ActiveRun) => {
    if (!mountedRef.current) return;
    if (activeRunRef.current === active) { activeRunRef.current = undefined; setRunning(false); }
    if (active.runId && active.scope === scopeRef.current) await loadRun(active.runId);
    if (active.scope === scopeRef.current) await refresh(1);
  }, [loadRun, refresh]);

  const resumeRun = useCallback(async (run: BenchmarkRunSummary) => {
    if (!activeStatus(run.status) || activeRunRef.current || run.projectId !== projectId) return;
    const token = getToken();
    if (!token) return;
    const controller = new AbortController();
    const active: ActiveRun = { controller, scope: scopeRef.current, request: ++streamRequestRef.current, runId: run.id, revision: run.revision };
    activeRunRef.current = active;
    setRunning(true);
    setProgress(run.status === 'queued' ? 'Reconnecting to the queued durable run…' : 'Reconnecting to the active durable run…');
    void loadRun(run.id);
    try {
      const response = await fetch(apiUrl(`/benchmarks/runs/${run.id}/stream`), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Last-Event-ID': String(run.revision) },
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        throw new BenchmarkStreamTerminalError(readableApiError({ response: { data: payload } }, `Benchmark reconnect failed with HTTP ${response.status}.`));
      }
      requireEventStream(response, 'The benchmark reconnect returned an invalid content type.');
      await followDurableStream(response, active, token);
    } catch (error) {
      if ((error as Error).name !== 'AbortError' && activeRunRef.current === active) {
        failedResumeRef.current = benchmarkResumeKey(active.scope, active.runId ?? run.id, active.revision);
        toast.error(error instanceof Error ? error.message : 'Benchmark reconnect failed.');
      }
    } finally {
      await settleStream(active);
    }
  }, [followDurableStream, loadRun, projectId, settleStream]);

  const startRun = async () => {
    if (!model || !suite || suite.id !== BENCHMARK_SUITE_ID || !status?.execution.workerAvailable || !mutationsAllowed || running) return;
    const token = getToken();
    if (!token) return toast.error('Authentication is required.');
    const controller = new AbortController();
    const active: ActiveRun = { controller, scope: scopeRef.current, request: ++streamRequestRef.current, revision: 0 };
    activeRunRef.current = active;
    setRunning(true); setSelected(undefined); setComparison(undefined); setDetailError(undefined); setProgress('Submitting the run to the durable shared benchmark queue…');
    try {
      const response = await fetch(apiUrl('/benchmarks/runs/stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(buildBenchmarkRunPayload(model, projectId)),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        throw new Error(readableApiError({ response: { data: payload } }, `Benchmark execution failed with HTTP ${response.status}.`));
      }
      requireEventStream(response, 'The benchmark execution endpoint returned an invalid content type.');
      await followDurableStream(response, active, token);
    } catch (error) {
      if ((error as Error).name !== 'AbortError' && activeRunRef.current === active) toast.error(error instanceof Error ? error.message : 'Benchmark execution failed.');
    } finally {
      await settleStream(active);
    }
  };

  useEffect(() => {
    if (!projectValid || activeRunRef.current) return;
    const active = selected && activeStatus(selected.status)
      ? selected
      : runs.find((run) => activeStatus(run.status));
    if (active && failedResumeRef.current !== benchmarkResumeKey(scopeKey, active.id, active.revision)) void resumeRun(active);
  }, [projectValid, resumeRun, runs, scopeKey, selected]);

  const manualRefresh = () => {
    failedResumeRef.current = undefined;
    void refresh(pagination.page);
  };

  const deleteRun = async () => {
    if (!deleteTarget || !mutationsAllowed || !isTerminalBenchmarkRun(deleteTarget)) return;
    setDeleting(true);
    try {
      const response = await benchmarkApi.deleteRun(deleteTarget.id);
      const deleted = normalizeBenchmarkRunDeletion(response.data);
      if (!deleted || deleted.runId !== deleteTarget.id) throw new Error('The benchmark service returned an invalid deletion result.');
      if (selected?.id === deleteTarget.id) setSelected(undefined);
      setComparison((current) => current?.id === deleteTarget.id ? undefined : current);
      const targetPage = runs.length === 1 && pagination.page > 1 ? pagination.page - 1 : pagination.page;
      setDeleteTarget(undefined);
      await refresh(targetPage);
      toast.success('Benchmark run deleted.');
    } catch (error) { toast.error(readableApiError(error, 'The benchmark run could not be deleted.')); }
    finally { setDeleting(false); }
  };

  const exportRun = () => {
    if (!selected) return;
    const blob = new Blob([`${JSON.stringify(benchmarkReport(selected), null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `kfive-benchmark-${selected.id}.json`; anchor.click();
    URL.revokeObjectURL(url);
  };

  const compatibleRuns = runs.filter((run) => areBenchmarkRunsCompatible(selected, run));
  const canStart = mutationsAllowed && Boolean(status?.execution.workerAvailable && suite && model && catalog.provider !== 'unknown') && !running;

  return <div className="mx-auto max-w-7xl space-y-6 p-6 md:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-3"><h1 className="flex items-center gap-3 text-3xl font-bold text-white"><Gauge className="text-primary" />Model Benchmarks</h1><span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-amber-200">Experimental</span></div><p className="mt-2 text-gray-400">Measured, durable chat-model runs in the workspace or a verified project.</p></div><button onClick={manualRefresh} disabled={loading || !projectValid} aria-label="Refresh benchmarks" className="rounded-xl border border-white/10 bg-white/5 p-2.5 text-gray-300 disabled:opacity-40"><RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} /></button></header>

    <div role="note" className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100"><AlertTriangle className="mr-2 inline h-4 w-4" />This is inference benchmarking, not ML training. The fixed suite runs 3 prompts twice, sequentially, through one durable shared benchmark worker. Submitted runs remain queued or running if this page disconnects; only Stop run requests cancellation. Remote providers may bill for six calls and receive the suite prompts; review their privacy terms before starting. GPU samples are before/after snapshots, not reliable peak VRAM measurements or exclusive attribution.</div>
    {projectLoading ? <Notice>Verifying project context…</Notice> : null}
    {projectError ? <ErrorNotice>{projectError} No unscoped benchmark request was made.</ErrorNotice> : null}
    {projectStatus === 'archived' ? <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">{PROJECT_ARCHIVED_MESSAGE} Benchmark history and export remain readable; new runs and deletion are disabled.</div> : null}
    {context ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3"><div className="flex min-w-0 items-center gap-3"><FolderKanban className="h-5 w-5 shrink-0 text-primary" /><div className="min-w-0"><p className="text-xs uppercase tracking-wide text-gray-500">Project benchmark scope</p><p className="truncate font-medium text-white">{context.projectName} <span className="text-xs capitalize text-gray-500">({projectStatus ?? context.status})</span></p></div></div><button onClick={() => navigate('/app/benchmarks', { replace: true, state: null })} className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-300"><X className="h-3.5 w-3.5" />Show workspace history</button></div> : null}

    <div className="grid gap-3">{statusError ? <ErrorNotice>{statusError}</ErrorNotice> : null}{suiteError ? <ErrorNotice>{suiteError}</ErrorNotice> : null}{catalogError ? <ErrorNotice>{catalogError}</ErrorNotice> : null}{historyError ? <ErrorNotice>{historyError}</ErrorNotice> : null}</div>

    <section className="rounded-2xl border border-white/10 bg-white/5 p-5"><div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end"><label className="block text-sm text-gray-300">Installed/configured model<select value={model} onChange={(event) => setModel(event.target.value)} disabled={running || !mutationsAllowed} className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-white disabled:opacity-50"><option value="">Choose a model</option>{catalog.models.map((item) => <option key={item.id} value={item.id}>{item.name} — {item.id}</option>)}</select><span className="mt-1 block text-xs text-gray-500">Provider: {catalog.provider} · catalog scope: {catalog.modelScope}</span></label><div className="rounded-xl border border-white/10 bg-black/20 p-3 text-sm"><p className="font-medium text-white">{suite?.title ?? 'Suite unavailable'}</p><p className="mt-1 text-gray-400">{suite ? `${suite.promptCount} prompts × ${suite.repetitions} sequential repetitions · ${suite.totalCalls} calls` : 'Suite metadata is required before a run.'}</p><p className="mt-1 text-xs text-gray-600">Temperature {suite?.parameters.temperature ?? '—'} · max output {suite?.parameters.maxOutputTokens ?? '—'} tokens · suite {BENCHMARK_SUITE_ID}</p></div>{running ? <button onClick={() => void stopRun()} className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-500/20 px-5 py-3 font-medium text-red-200"><StopCircle className="h-4 w-4" />Stop run</button> : <button onClick={() => void startRun()} disabled={!canStart} className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"><Play className="h-4 w-4" />Queue 6 calls</button>}</div>{progress ? <p aria-live="polite" className="mt-4 flex items-center gap-2 text-sm text-cyan-200">{running ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{progress}</p> : null}{status && !status.execution.workerAvailable ? <p role="alert" className="mt-3 text-sm text-red-200">The shared benchmark worker is unavailable. New runs are disabled until its heartbeat recovers; existing durable history remains readable.</p> : status?.execution.active && !running ? <p className="mt-3 text-sm text-amber-200">The shared benchmark worker is active. A new run may wait in the durable queue; this page can reconnect to an owned active run from history.</p> : null}</section>

    <div className="grid gap-6 xl:grid-cols-[310px_minmax(0,1fr)]">
      <aside className="h-fit rounded-2xl border border-white/10 bg-white/5 p-4"><div className="flex items-center justify-between"><h2 className="font-semibold text-white">Run history</h2><span className="text-xs text-gray-500">{pagination.total}</span></div><p className="mt-1 text-xs text-gray-600">25 per page · at most 10 pages shown · owner retention {status?.limits.retentionPerOwner ?? 'not reported'}</p><div className="mt-4 space-y-2">{loading ? <p className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p> : runs.map((run) => <div key={run.id} className={`flex rounded-xl border ${selected?.id === run.id ? 'border-primary/40 bg-primary/10' : 'border-white/5 bg-black/20'}`}><button onClick={() => void loadRun(run.id)} className="min-w-0 flex-1 p-3 text-left"><div className="flex items-center justify-between gap-2"><span className={`text-xs capitalize ${run.status === 'succeeded' ? 'text-emerald-300' : activeStatus(run.status) ? 'text-cyan-300' : 'text-amber-300'}`}>{statusText(run.status)}</span><span className="text-xs text-gray-500">{run.completedCalls}/{BENCHMARK_CALLS}</span></div><p className="mt-2 truncate text-sm text-gray-300">{run.provider ?? 'Provider pending'} · {run.model.actual?.id ?? run.model.requested.id}</p><p className="mt-1 text-xs text-gray-600">{dateTime(run.createdAt ?? run.queuedAt)}</p></button>{mutationsAllowed && isTerminalBenchmarkRun(run) ? <button onClick={() => setDeleteTarget(run)} aria-label={`Delete benchmark run ${run.id}`} className="m-2 rounded-lg p-1.5 text-gray-600 hover:bg-red-500/10 hover:text-red-300"><Trash2 className="h-3.5 w-3.5" /></button> : null}</div>)}{!loading && !runs.length && !historyError ? <p className="py-6 text-center text-sm text-gray-500">No benchmark runs in this scope.</p> : null}</div><div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3"><button onClick={() => void refresh(pagination.page - 1)} disabled={loading || pagination.page <= 1} className="rounded-lg border border-white/10 px-2 py-1 text-xs text-gray-300 disabled:opacity-30">Previous</button><span className="text-xs text-gray-500">{pagination.page} / {pagination.totalPages}</span><button onClick={() => void refresh(pagination.page + 1)} disabled={loading || pagination.page >= pagination.totalPages} className="rounded-lg border border-white/10 px-2 py-1 text-xs text-gray-300 disabled:opacity-30">Next</button></div></aside>

      <main className="min-w-0 space-y-6">{detailLoading ? <Notice><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading canonical run detail…</Notice> : detailError ? <ErrorNotice>{detailError}</ErrorNotice> : selected ? <>
        <section className="rounded-2xl border border-white/10 bg-white/5 p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold text-white">Run detail</h2><p className="mt-1 break-all font-mono text-xs text-gray-600">{selected.id}</p></div><div className="flex gap-2"><button onClick={() => void loadRun(selected.id)} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300"><RefreshCw className="h-4 w-4" />Reconnect detail</button><button onClick={exportRun} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300"><Download className="h-4 w-4" />Export JSON</button></div></div><div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Status" value={statusText(selected.status)} /><Metric label="Chosen provider" value={selected.provider ?? 'Pending'} /><Metric label="Requested model" value={selected.model.requested.id} /><Metric label="Actual model" value={selected.model.actual?.id ?? 'Pending'} /><Metric label="Wall duration" value={duration(selected.wallDurationMs)} /><Metric label="Passed" value={`${selected.passedCalls} / ${selected.suite.totalCalls}`} /><Metric label="Output" value={bytes(selected.outputBytes)} /><Metric label="Started" value={dateTime(selected.startedAt)} /></div>{selected.error ? <div role="alert" className="mt-4 rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{selected.error.message} <span className="font-mono text-xs">({selected.error.code})</span></div> : null}</section>

        {selected.aggregate ? <AggregatePanel aggregate={selected.aggregate} comparison={comparison?.aggregate} /> : <Notice>No aggregate metrics were reported for this run.</Notice>}

        <section className="rounded-2xl border border-white/10 bg-white/5 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-white">Compare compatible completed run</h2><p className="mt-1 text-xs text-gray-500">Only succeeded runs from the same fixed suite version are eligible.</p></div><select aria-label="Comparison run" value={comparison?.id ?? ''} onChange={(event) => setComparison(runs.find((run) => run.id === event.target.value))} disabled={selected.status !== 'succeeded' || !compatibleRuns.length} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white disabled:opacity-40"><option value="">No comparison</option>{compatibleRuns.map((run) => <option key={run.id} value={run.id}>{dateTime(run.completedAt)} · {run.provider} / {run.model.actual?.id}</option>)}</select></div>{comparison ? <div className="mt-4 grid gap-3 sm:grid-cols-2"><CompareCard label="Selected" run={selected} /><CompareCard label="Comparison" run={comparison} /></div> : null}</section>

        <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/5"><div className="p-5"><h2 className="font-semibold text-white">Sequential call results</h2><p className="mt-1 text-xs text-gray-500">Ordered call index is preserved. Output is rendered as inert text.</p></div><div className="overflow-x-auto"><table className="w-full min-w-[920px] text-left text-sm"><thead className="border-y border-white/10 bg-black/20 text-xs uppercase tracking-wide text-gray-500"><tr><th className="px-4 py-3">Call</th><th className="px-4 py-3">Prompt / repeat</th><th className="px-4 py-3">Result</th><th className="px-4 py-3">Duration</th><th className="px-4 py-3">TTFT</th><th className="px-4 py-3">Output</th><th className="px-4 py-3">Provider / model</th></tr></thead><tbody className="divide-y divide-white/5">{selected.results.map((result) => <ResultRow key={result.callIndex} result={result} />)}{!selected.results.length ? <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500">No completed calls were recorded.</td></tr> : null}</tbody></table></div></section>

        <section className="grid gap-4 md:grid-cols-2"><GpuCard label="GPU before" snapshot={selected.gpu.before} /><GpuCard label="GPU after" snapshot={selected.gpu.after} /></section>
        <section className="rounded-2xl border border-white/10 bg-white/5 p-5"><h2 className="font-semibold text-white">Timeline</h2><ol className="mt-4 space-y-2">{selected.timeline.map((event) => <li key={event.sequence} className="flex items-start gap-3 rounded-lg border border-white/5 bg-black/20 p-3 text-sm"><Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><div><p className="capitalize text-gray-200">{statusText(event.type)}{event.callIndex !== undefined ? ` · call ${event.callIndex + 1}` : ''}</p><p className="mt-1 text-xs text-gray-500">{dateTime(event.timestamp)}{event.provider ? ` · ${event.provider}` : ''}{event.model ? ` · ${event.model}` : ''}{event.code ? ` · ${event.code}` : ''}</p></div></li>)}</ol></section>
      </> : <section className="flex min-h-72 items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.03] text-center text-gray-500"><div><BarChart3 className="mx-auto h-10 w-10" /><p className="mt-3">Run the suite or select benchmark history.</p></div></section>}</main>
    </div>
    <ConfirmDialog isOpen={Boolean(deleteTarget)} title="Delete Benchmark Run" message="Delete this terminal benchmark report, including its call outputs, metrics, safe GPU samples, and timeline? This cannot be undone." confirmText={deleting ? 'Deleting…' : 'Delete Run'} isDestructive onConfirm={() => void deleteRun()} onCancel={() => { if (!deleting) setDeleteTarget(undefined); }} />
  </div>;
}

function Notice({ children }: { children: React.ReactNode }) { return <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-gray-400">{children}</div>; }
function ErrorNotice({ children }: { children: React.ReactNode }) { return <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">{children}</div>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-lg bg-black/20 p-3"><p className="text-xs text-gray-500">{label}</p><p className="mt-1 truncate text-white">{value}</p></div>; }

function AggregatePanel({ aggregate, comparison }: { aggregate: BenchmarkAggregate; comparison?: BenchmarkAggregate }) {
  const rows = [
    { label: 'Median duration', value: aggregate.medianDurationMs, compare: comparison?.medianDurationMs, text: duration },
    { label: 'Median TTFT', value: aggregate.medianTtftMs, compare: comparison?.medianTtftMs, text: duration },
    { label: 'Median output', value: aggregate.medianOutputBytes, compare: comparison?.medianOutputBytes, text: bytes },
    { label: 'Output throughput', value: aggregate.outputTokensPerSecond, compare: comparison?.outputTokensPerSecond, text: (value?: number) => value === undefined ? 'Not reported by provider' : `${value.toFixed(2)} tokens/s` },
  ];
  return <section className="rounded-2xl border border-white/10 bg-white/5 p-5"><h2 className="font-semibold text-white">Measured aggregates</h2><p className="mt-1 text-xs text-gray-500">Bars are scaled only against the displayed selected/comparison values; missing provider metrics stay missing.</p><div className="mt-5 space-y-5">{rows.map((row) => { const maximum = Math.max(row.value ?? 0, row.compare ?? 0); return <div key={row.label}><div className="flex justify-between gap-4 text-sm"><span className="text-gray-400">{row.label}</span><span className="text-white">{row.text(row.value)}</span></div>{row.value !== undefined && maximum > 0 ? <div role="meter" aria-label={row.label} aria-valuemin={0} aria-valuemax={maximum} aria-valuenow={row.value} className="mt-2 h-2 overflow-hidden rounded bg-white/5"><div className="h-full rounded bg-primary" style={{ width: `${(row.value / maximum) * 100}%` }} /></div> : null}{row.compare !== undefined ? <div className="mt-2 flex justify-between gap-4 text-xs"><span className="text-gray-600">Comparison</span><span className="text-cyan-200">{row.text(row.compare)}</span></div> : null}</div>; })}</div></section>;
}

function CompareCard({ label, run }: { label: string; run: BenchmarkRunSummary }) { return <article className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-xs uppercase tracking-wide text-gray-500">{label}</p><p className="mt-2 text-sm font-medium text-white">{run.provider} · {run.model.actual?.id}</p><dl className="mt-3 grid grid-cols-2 gap-3 text-xs"><div><dt className="text-gray-600">Passes</dt><dd className="mt-1 text-gray-200">{run.aggregate?.passCount ?? run.passedCalls} / {run.suite.totalCalls}</dd></div><div><dt className="text-gray-600">Wall duration</dt><dd className="mt-1 text-gray-200">{duration(run.wallDurationMs)}</dd></div><div><dt className="text-gray-600">Median duration</dt><dd className="mt-1 text-gray-200">{duration(run.aggregate?.medianDurationMs)}</dd></div><div><dt className="text-gray-600">Median TTFT</dt><dd className="mt-1 text-gray-200">{duration(run.aggregate?.medianTtftMs)}</dd></div></dl></article>; }

function ResultRow({ result }: { result: BenchmarkResult }) { return <tr className="align-top"><td className="px-4 py-3 text-white">{result.callIndex + 1}</td><td className="px-4 py-3 text-gray-300">{result.promptIndex + 1} / {result.repetition}<p className="mt-1 text-xs text-gray-600">{result.promptLength.toLocaleString()} chars</p></td><td className={`px-4 py-3 ${result.passed ? 'text-emerald-300' : 'text-amber-300'}`}>{result.passed ? 'Pass' : 'Fail'}<p className="mt-1 text-xs text-gray-600">{result.finishReason ? statusText(result.finishReason) : 'Finish reason not reported'}</p>{result.error ? <p className="mt-1 max-w-60 text-xs text-red-300">{result.error.message} ({result.error.code})</p> : null}</td><td className="px-4 py-3 text-gray-300">{duration(result.durationMs)}</td><td className="px-4 py-3 text-gray-300">{duration(result.ttftMs)}</td><td className="px-4 py-3 text-gray-300">{bytes(result.outputBytes)}{result.usage?.outputTokens !== undefined ? <p className="mt-1 text-xs text-gray-600">{result.usage.outputTokens.toLocaleString()} tokens</p> : null}<details className="mt-2 max-w-xs"><summary className="cursor-pointer text-xs text-primary">View inert output</summary><pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 text-xs text-gray-400">{result.output}</pre></details></td><td className="px-4 py-3 text-gray-300">{result.provider}<p className="mt-1 break-all text-xs text-gray-600">{result.model}</p></td></tr>; }

function GpuCard({ label, snapshot }: { label: string; snapshot?: BenchmarkGpuSnapshot }) { return <article className="rounded-2xl border border-white/10 bg-white/5 p-5"><h2 className="flex items-center gap-2 font-semibold text-white"><Cpu className="h-4 w-4 text-cyan-300" />{label}</h2>{snapshot ? <><p className="mt-2 text-xs text-gray-500">Sampled {dateTime(snapshot.sampledAt)} · {snapshot.available ? 'available' : snapshot.reason ?? 'unavailable'}</p><div className="mt-4 space-y-3">{snapshot.devices.map((device) => <div key={device.index} className="rounded-lg bg-black/20 p-3 text-sm"><p className="text-gray-200">{device.name} <span className="text-xs text-gray-600">driver {device.driverVersion}</span></p><p className="mt-1 text-xs text-gray-500">VRAM {device.memoryUsedMiB.toLocaleString()} / {device.memoryTotalMiB.toLocaleString()} MiB · free {device.memoryFreeMiB.toLocaleString()} MiB</p><p className="mt-1 text-xs text-gray-500">Utilization {device.utilizationPercent}% · {device.temperatureC}°C</p></div>)}{!snapshot.devices.length ? <p className="text-sm text-gray-500">No GPU devices were reported.</p> : null}</div></> : <p className="mt-3 text-sm text-gray-500">No snapshot was reported.</p>}</article>; }
