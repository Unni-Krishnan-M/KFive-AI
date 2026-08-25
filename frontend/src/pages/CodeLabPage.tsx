import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, Clock3, Code2, FolderKanban, Loader2, MemoryStick, Play, RefreshCw, RotateCcw, Square, Terminal, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { codeApi } from '@/services/api';
import {
  CodeLanguage,
  CodeRun,
  CodeRuntime,
  codeRunnerError,
  isPendingCodeRun,
  nextCodePollRetryDelay,
  normalizeCodeRun,
  normalizeCodeRunList,
  normalizeCodeRuntimeCatalog,
} from '@/services/codeRunner';
import { useProjectContext } from '@/hooks/useProjectContext';
import { PROJECT_ARCHIVED_MESSAGE } from '@/services/projectContext';

const STARTERS: Record<CodeLanguage, string> = {
  python: `import sys

name = sys.stdin.read().strip() or "world"
print(f"Hello, {name}!")
`,
  javascript: `const fs = require('node:fs');

const name = fs.readFileSync(0, 'utf8').trim() || 'world';
console.log(\`Hello, \${name}!\`);
`,
};

const languageLabel = (language: CodeLanguage) => language === 'python' ? 'Python' : 'JavaScript';
const formatDuration = (milliseconds?: number) => milliseconds === undefined ? 'Not reported' : `${milliseconds} ms`;
const formatMemory = (bytes?: number) => bytes === undefined ? 'Not reported' : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

const statusStyle: Record<CodeRun['status'], string> = {
  queued: 'bg-amber-500/10 text-amber-300',
  running: 'bg-cyan-500/10 text-cyan-300',
  'cancel-requested': 'bg-amber-500/10 text-amber-300',
  succeeded: 'bg-emerald-500/10 text-emerald-300',
  completed: 'bg-emerald-500/10 text-emerald-300',
  failed: 'bg-red-500/10 text-red-300',
  cancelled: 'bg-gray-500/10 text-gray-300',
  'timed-out': 'bg-orange-500/10 text-orange-300',
  'resource-exceeded': 'bg-orange-500/10 text-orange-300',
  'output-limit': 'bg-orange-500/10 text-orange-300',
  'internal-error': 'bg-red-500/10 text-red-300',
  unknown: 'bg-gray-500/10 text-gray-400',
};

export default function CodeLabPage() {
  const navigate = useNavigate();
  const { requested: projectRequested, context: projectContext, loading: projectLoading, error: projectError } = useProjectContext();
  const projectId = projectContext?.projectId;
  const projectScopeReady = !projectRequested || Boolean(projectContext);
  const projectMutationsAllowed = projectScopeReady && projectContext?.status !== 'archived';
  const [language, setLanguage] = useState<CodeLanguage>('python');
  const [source, setSource] = useState(STARTERS.python);
  const [stdin, setStdin] = useState('KFive');
  const [runtimes, setRuntimes] = useState<CodeRuntime[]>([]);
  const [runnerEnabled, setRunnerEnabled] = useState<boolean>();
  const [history, setHistory] = useState<CodeRun[]>([]);
  const [currentRun, setCurrentRun] = useState<CodeRun>();
  const [loadingRuntimes, setLoadingRuntimes] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const selectedRuntime = useMemo(
    () => runtimes.find((runtime) => runtime.language === language),
    [language, runtimes],
  );

  useEffect(() => {
    setCurrentRun(undefined);
  }, [projectId, projectScopeReady]);

  const loadHistory = useCallback(async () => {
    if (!projectScopeReady) {
      setHistory([]);
      setLoadingHistory(false);
      return;
    }
    setLoadingHistory(true);
    try {
      const response = await codeApi.getRuns(projectId);
      setHistory(normalizeCodeRunList(response.data));
    } catch (historyError) {
      setError(codeRunnerError(historyError, 'Code run history is unavailable.'));
    } finally {
      setLoadingHistory(false);
    }
  }, [projectId, projectScopeReady]);

  useEffect(() => {
    let active = true;
    setLoadingRuntimes(true);
    codeApi.getRuntimes().then((response) => {
      if (!active) return;
      const catalog = normalizeCodeRuntimeCatalog(response.data);
      setRunnerEnabled(catalog.enabled);
      setRuntimes(catalog.runtimes);
      const firstAvailable = catalog.runtimes.find((runtime) => runtime.available);
      if (firstAvailable && !catalog.runtimes.some((runtime) => runtime.language === language && runtime.available)) {
        setLanguage(firstAvailable.language);
        setSource(STARTERS[firstAvailable.language]);
      }
      if (!catalog.available) setError(catalog.message || (catalog.enabled
        ? 'The isolated code runner is unavailable.'
        : 'The isolated code runner is disabled. Set CODE_RUNNER_MODE=container and restart KFive.'));
    }).catch((runtimeError) => {
      if (!active) return;
      setRunnerEnabled(false);
      setRuntimes([]);
      setError(codeRunnerError(runtimeError, 'Code runner runtime information is unavailable.'));
    }).finally(() => {
      if (active) setLoadingRuntimes(false);
    });
    void loadHistory();
    return () => { active = false; };
  }, [loadHistory]);

  useEffect(() => {
    if (!isPendingCodeRun(currentRun)) return;
    let active = true;
    let timer: number | undefined;
    let failureCount = 0;

    const poll = async () => {
      try {
        const response = await codeApi.getRun(currentRun!.id);
        if (!active) return;
        const nextRun = normalizeCodeRun(response.data);
        if (!nextRun) throw new Error('The runner returned an invalid run record.');
        failureCount = 0;
        setError(undefined);
        setCurrentRun(nextRun);
        if (isPendingCodeRun(nextRun)) timer = window.setTimeout(poll, 750);
        else void loadHistory();
      } catch (pollError) {
        if (!active) return;
        failureCount += 1;
        const message = codeRunnerError(pollError, 'The current run could not be refreshed.');
        const retryDelay = nextCodePollRetryDelay(failureCount);
        setError(retryDelay === undefined ? `${message} Automatic polling stopped; use Refresh run to try again.` : `${message} Retrying run status…`);
        if (retryDelay !== undefined) timer = window.setTimeout(poll, retryDelay);
      }
    };

    timer = window.setTimeout(poll, 500);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [currentRun?.id, currentRun?.status, loadHistory]);

  const chooseLanguage = (nextLanguage: CodeLanguage) => {
    setLanguage(nextLanguage);
    setSource(STARTERS[nextLanguage]);
    setCurrentRun(undefined);
    setError(undefined);
  };

  const runCode = async () => {
    if (!source.trim() || submitting || isPendingCodeRun(currentRun)) return;
    if (!projectMutationsAllowed) {
      setError(projectError || PROJECT_ARCHIVED_MESSAGE);
      return;
    }
    if (runnerEnabled === false) {
      setError('The isolated code runner is disabled. Set CODE_RUNNER_MODE=container and restart KFive.');
      return;
    }
    if (!selectedRuntime?.available) {
      setError(selectedRuntime?.message || `${languageLabel(language)} runtime is unavailable.`);
      return;
    }

    setSubmitting(true);
    setError(undefined);
    try {
      const response = await codeApi.createRun({ language, source, stdin, ...(projectId ? { projectId } : {}) });
      const run = normalizeCodeRun(response.data);
      if (!run) throw new Error('The runner accepted the request but did not return a valid run record.');
      setCurrentRun(run);
      setHistory((existing) => [run, ...existing.filter((item) => item.id !== run.id)]);
    } catch (runError) {
      setError(codeRunnerError(runError, 'Code execution could not be started.'));
    } finally {
      setSubmitting(false);
    }
  };

  const stopRun = async () => {
    if (!currentRun || !isPendingCodeRun(currentRun)) return;
    try {
      const response = await codeApi.cancelRun(currentRun.id);
      const cancelled = normalizeCodeRun(response.data);
      if (cancelled) setCurrentRun(cancelled);
      else {
        const refreshed = await codeApi.getRun(currentRun.id);
        const run = normalizeCodeRun(refreshed.data);
        if (run) setCurrentRun(run);
      }
      void loadHistory();
    } catch (cancelError) {
      setError(codeRunnerError(cancelError, 'The code run could not be cancelled.'));
    }
  };

  const openHistoryRun = async (run: CodeRun) => {
    setError(undefined);
    try {
      const response = await codeApi.getRun(run.id);
      const details = normalizeCodeRun(response.data);
      if (!details) throw new Error('The runner returned an invalid run record.');
      setCurrentRun(details);
      setLanguage(details.language);
      if (details.source !== undefined) setSource(details.source);
      if (details.stdin !== undefined) setStdin(details.stdin);
    } catch (historyError) {
      setError(codeRunnerError(historyError, 'The selected run could not be loaded.'));
    }
  };

  const refreshCurrentRun = async () => {
    if (!currentRun) return;
    setError(undefined);
    try {
      const response = await codeApi.getRun(currentRun.id);
      const run = normalizeCodeRun(response.data);
      if (!run) throw new Error('The runner returned an invalid run record.');
      setCurrentRun(run);
      if (!isPendingCodeRun(run)) void loadHistory();
    } catch (refreshError) {
      setError(codeRunnerError(refreshError, 'The current run could not be refreshed.'));
    }
  };

  const reset = () => {
    setSource(STARTERS[language]);
    setStdin('KFive');
    setCurrentRun(undefined);
    setError(undefined);
  };

  return <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="h-full overflow-y-auto p-5 md:p-8">
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="flex items-center gap-3 text-3xl font-bold text-white"><Code2 className="text-primary" />Code Lab</h1><p className="mt-2 text-gray-400">Run small programs in an isolated online compiler playground.</p></div><div className="flex gap-2"><button onClick={reset} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-300 hover:text-white"><RotateCcw className="h-4 w-4" />Reset</button>{isPendingCodeRun(currentRun) ? <button onClick={() => void stopRun()} disabled={currentRun?.status === 'cancel-requested'} className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"><Square className="h-4 w-4" />{currentRun?.status === 'cancel-requested' ? 'Stopping…' : 'Stop'}</button> : <button onClick={() => void runCode()} disabled={submitting || loadingRuntimes || projectLoading || !projectMutationsAllowed || !source.trim() || !selectedRuntime?.available} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Run</button>}</div></header>

      {projectLoading ? <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-gray-400">Verifying project context…</div> : null}
      {projectError ? <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">{projectError} Project-scoped actions are disabled.</div> : null}
      {projectContext?.status === 'archived' ? <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">{PROJECT_ARCHIVED_MESSAGE}</div> : null}
      {projectContext ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3"><div className="flex min-w-0 items-center gap-3"><FolderKanban className="h-5 w-5 shrink-0 text-primary" /><div className="min-w-0"><p className="text-xs uppercase tracking-wide text-gray-500">Project code session</p><p className="truncate font-medium text-white">{projectContext.projectName} <span className="text-xs capitalize text-gray-500">({projectContext.status})</span></p></div></div><button onClick={() => navigate('/app/code', { replace: true, state: null })} className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-300 hover:text-white"><X className="h-3.5 w-3.5" />Leave project</button></div> : null}
      {error ? <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div> : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3"><div className="flex gap-2">{(['python', 'javascript'] as const).map((item) => { const runtime = runtimes.find((candidate) => candidate.language === item); return <button key={item} onClick={() => chooseLanguage(item)} disabled={loadingRuntimes || runtime?.available === false} title={runtime?.message} className={`rounded-lg px-3 py-1.5 text-sm ${language === item ? 'bg-primary text-white' : 'bg-black/20 text-gray-400'} disabled:cursor-not-allowed disabled:opacity-40`}>{languageLabel(item)}</button>; })}</div><span className="text-xs text-gray-500">Runtime: {selectedRuntime?.version || (loadingRuntimes ? 'Loading…' : 'Version not reported')}</span></div>
            <label className="block"><span className="sr-only">Source code</span><textarea value={source} onChange={(event) => setSource(event.target.value)} spellCheck={false} className="min-h-[360px] w-full resize-y bg-[#090b12] p-5 font-mono text-sm leading-6 text-gray-200 outline-none" aria-label="Source code" /></label>
          </section>
          <section className="rounded-2xl border border-white/10 bg-white/5 p-4"><label className="text-sm font-medium text-gray-300">Standard input<textarea value={stdin} onChange={(event) => setStdin(event.target.value)} placeholder="Optional stdin" className="mt-2 min-h-24 w-full resize-y rounded-xl border border-white/10 bg-black/30 p-3 font-mono text-sm text-gray-200 outline-none focus:border-primary/50" /></label></section>

          <section className="rounded-2xl border border-white/10 bg-white/5 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 font-semibold text-white"><Terminal className="h-5 w-5 text-cyan-400" />Run result</h2><div className="flex items-center gap-2">{currentRun ? <><button onClick={() => void refreshCurrentRun()} className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-white" aria-label="Refresh run"><RefreshCw className="h-3.5 w-3.5" /></button><span className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${statusStyle[currentRun.status]}`}>{currentRun.status.replace('-', ' ')}</span></> : <span className="text-xs text-gray-500">No run selected</span>}</div></div>{currentRun ? <><div className="mt-4 grid gap-3 text-xs sm:grid-cols-4"><div className="rounded-lg bg-black/20 p-3 text-gray-400">Exit code<p className="mt-1 font-mono text-white">{currentRun.exitCode ?? 'Not reported'}</p></div><div className="rounded-lg bg-black/20 p-3 text-gray-400"><span className="flex items-center gap-1"><Clock3 className="h-3 w-3" />Duration</span><p className="mt-1 font-mono text-white">{formatDuration(currentRun.durationMs)}</p></div><div className="rounded-lg bg-black/20 p-3 text-gray-400"><span className="flex items-center gap-1"><MemoryStick className="h-3 w-3" />Memory</span><p className="mt-1 font-mono text-white">{formatMemory(currentRun.memoryBytes)}</p></div><div className="rounded-lg bg-black/20 p-3 text-gray-400">Runtime<p className="mt-1 font-mono text-white">{currentRun.runtimeVersion || selectedRuntime?.version || 'Not reported'}</p></div></div>{currentRun.signal || currentRun.errorCode || currentRun.oomKilled !== undefined ? <div className="mt-3 grid gap-3 text-xs sm:grid-cols-3">{currentRun.signal ? <div className="rounded-lg bg-black/20 p-3 text-gray-400">Signal<p className="mt-1 font-mono text-white">{currentRun.signal}</p></div> : null}{currentRun.errorCode ? <div className="rounded-lg bg-black/20 p-3 text-gray-400">Error code<p className="mt-1 font-mono text-white">{currentRun.errorCode}</p></div> : null}{currentRun.oomKilled !== undefined ? <div className="rounded-lg bg-black/20 p-3 text-gray-400">Out of memory<p className="mt-1 font-mono text-white">{currentRun.oomKilled ? 'Yes' : 'No'}</p></div> : null}</div> : null}{currentRun.message ? <p className="mt-3 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-200">{currentRun.message}</p> : null}{currentRun.outputTruncated ? <p className="mt-3 rounded-lg bg-orange-500/10 p-3 text-sm text-orange-200">Output was truncated at the configured runner limit.</p> : null}<div className="mt-4 grid gap-4 lg:grid-cols-2"><div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">stdout</h3><pre className="min-h-32 overflow-auto rounded-xl bg-black/50 p-4 font-mono text-sm text-emerald-200">{currentRun.stdout || 'No stdout reported.'}</pre></div><div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">stderr</h3><pre className="min-h-32 overflow-auto rounded-xl bg-black/50 p-4 font-mono text-sm text-red-200">{currentRun.stderr || 'No stderr reported.'}</pre></div></div></> : <p className="mt-6 text-sm text-gray-500">Submit code or select a historical run to see actual runner output.</p>}</section>
        </div>

        <aside className="h-fit rounded-2xl border border-white/10 bg-white/5 p-4"><div className="flex items-center justify-between"><h2 className="font-semibold text-white">Run history</h2><button onClick={() => void loadHistory()} disabled={loadingHistory} className="rounded-lg p-2 text-gray-400 hover:bg-white/5 hover:text-white" aria-label="Refresh run history"><RefreshCw className={`h-4 w-4 ${loadingHistory ? 'animate-spin' : ''}`} /></button></div><p className="mt-1 text-xs text-gray-500">{projectContext ? `Runs in ${projectContext.projectName}` : 'Your recent runs'}</p><div className="mt-4 space-y-2">{history.map((run) => <button key={run.id} onClick={() => void openHistoryRun(run)} className={`w-full rounded-xl border p-3 text-left transition ${currentRun?.id === run.id ? 'border-primary/40 bg-primary/10' : 'border-white/5 bg-black/20 hover:border-white/10'}`}><div className="flex items-center justify-between gap-2"><span className="text-sm font-medium text-white">{languageLabel(run.language)}</span><span className={`rounded-full px-2 py-0.5 text-[10px] capitalize ${statusStyle[run.status]}`}>{run.status.replace('-', ' ')}</span></div><p className="mt-2 truncate font-mono text-xs text-gray-500">{run.source?.split('\n')[0] || run.id}</p><p className="mt-1 text-[10px] text-gray-600">{run.createdAt ? new Date(run.createdAt).toLocaleString() : 'Time not reported'}</p></button>)}{!loadingHistory && !history.length ? <p className="rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-gray-500">No code runs found.</p> : null}</div></aside>
      </div>
    </div>
  </motion.div>;
}
