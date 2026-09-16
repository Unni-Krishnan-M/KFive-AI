import { ChangeEvent, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, Download, FileArchive, FileCode2, FolderKanban, GitBranch, Loader2, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useProjectContext } from '@/hooks/useProjectContext';
import { repositoryApi } from '@/services/api';
import {
  REPOSITORY_ARCHIVE_LIMIT_BYTES,
  RepositoryAnalysis,
  RepositoryAnalysisSummary,
  RepositoryStatus,
  canCreateRepositoryAnalysis,
  canDeleteRepositoryAnalysis,
  effectiveRepositoryProjectStatus,
  formatBytes,
  isRepositoryScopeRequestCurrent,
  normalizeRepositoryAnalyses,
  normalizeRepositoryAnalysis,
  normalizeRepositoryStatus,
  repositoryAnalysisScopeKey,
  repositoryHistoryScope,
  validateRepositoryArchive,
  validateRepositoryZipSignature,
} from '@/services/repositoryAnalyzer';
import { PROJECT_ARCHIVED_MESSAGE } from '@/services/projectContext';
import { readableApiError } from '@/services/runtimeSettings';

function reportFilename(analysis: RepositoryAnalysis): string {
  const safe = analysis.name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'repository';
  return `${safe}-analysis.json`;
}

export default function RepositoryAnalyzerPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const fileSelectionRef = useRef(0);
  const detailRequestRef = useRef(0);
  const uploadRequestRef = useRef(0);
  const deleteRequestRef = useRef(0);
  const { requested, context, loading: projectLoading, error: projectError } = useProjectContext();
  const historyScope = repositoryHistoryScope(location.search, requested);
  const invalidScope = historyScope === 'invalid';
  const projectValid = !invalidScope && (!requested || Boolean(context));
  const projectId = context?.projectId;
  const orphaned = historyScope === 'orphaned';
  const scopeKey = invalidScope ? 'invalid-scope' : repositoryAnalysisScopeKey(requested, projectId, orphaned);
  const scopeKeyRef = useRef(scopeKey);
  const mountedRef = useRef(true);
  const [status, setStatus] = useState<RepositoryStatus>();
  const [analyses, setAnalyses] = useState<RepositoryAnalysisSummary[]>([]);
  const [selected, setSelected] = useState<RepositoryAnalysis>();
  const [loading, setLoading] = useState(false);
  const [statusError, setStatusError] = useState<string>();
  const [historyError, setHistoryError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [archive, setArchive] = useState<File>();
  const [analysisName, setAnalysisName] = useState('');
  const [archiveError, setArchiveError] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const maximumBytes = Math.min(status?.limits?.maxArchiveBytes ?? REPOSITORY_ARCHIVE_LIMIT_BYTES, REPOSITORY_ARCHIVE_LIMIT_BYTES);
  const projectStatus = context
    ? effectiveRepositoryProjectStatus(context.status, status?.scope?.type === 'project' ? status.scope.projectStatus : undefined)
    : undefined;
  const createAllowed = !orphaned && canCreateRepositoryAnalysis(projectStatus, projectValid, status?.canAnalyze === true);
  const deleteAllowed = canDeleteRepositoryAnalysis(projectStatus, projectValid);

  const requestIsCurrent = useCallback((requestScopeKey: string, currentRequestId: number, requestId: number): boolean => (
    mountedRef.current && isRepositoryScopeRequestCurrent(scopeKeyRef.current, requestScopeKey, currentRequestId, requestId)
  ), []);

  const refresh = useCallback(async () => {
    const requestScopeKey = scopeKey;
    const requestId = ++requestRef.current;
    if (!projectValid) {
      setStatus(undefined);
      setAnalyses([]);
      setSelected(undefined);
      setStatusError(undefined);
      setHistoryError(undefined);
      setLoading(false);
      return;
    }
    setLoading(true);
    const [statusResult, historyResult] = await Promise.allSettled([
      repositoryApi.getStatus(projectId),
      repositoryApi.getAnalyses(projectId, orphaned ? 'orphaned' : undefined),
    ]);
    if (!requestIsCurrent(requestScopeKey, requestRef.current, requestId)) return;
    if (statusResult.status === 'fulfilled') {
      setStatus(normalizeRepositoryStatus(statusResult.value.data));
      setStatusError(undefined);
    } else {
      setStatus(undefined);
      setStatusError(readableApiError(statusResult.reason, 'Repository Analyzer availability could not be checked.'));
    }
    if (historyResult.status === 'fulfilled') {
      const next = normalizeRepositoryAnalyses(historyResult.value.data);
      setAnalyses(next);
      setSelected((current) => current && next.some((item) => item.id === current.id) ? current : undefined);
      setHistoryError(undefined);
    } else {
      setAnalyses([]);
      setSelected(undefined);
      setHistoryError(readableApiError(historyResult.reason, 'Repository analyses could not be loaded.'));
    }
    setLoading(false);
  }, [orphaned, projectId, projectValid, requestIsCurrent, scopeKey]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      detailRequestRef.current += 1;
      uploadRequestRef.current += 1;
      deleteRequestRef.current += 1;
      fileSelectionRef.current += 1;
    };
  }, []);

  useLayoutEffect(() => {
    scopeKeyRef.current = scopeKey;
    requestRef.current += 1;
    detailRequestRef.current += 1;
    uploadRequestRef.current += 1;
    deleteRequestRef.current += 1;
    fileSelectionRef.current += 1;
    setStatus(undefined);
    setAnalyses([]);
    setSelected(undefined);
    setStatusError(undefined);
    setHistoryError(undefined);
    setDetailError(undefined);
    setArchive(undefined);
    setAnalysisName('');
    setArchiveError(undefined);
    setLoading(false);
    setUploading(false);
    setDeleting(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    void refresh();
  }, [refresh, scopeKey]);

  const selectArchive = async (event: ChangeEvent<HTMLInputElement>) => {
    const requestScopeKey = scopeKey;
    const selectionId = ++fileSelectionRef.current;
    const file = event.target.files?.[0];
    setArchive(undefined);
    setArchiveError(undefined);
    if (!file) return;
    const metadataError = validateRepositoryArchive(file, maximumBytes);
    if (metadataError) {
      setArchiveError(metadataError);
      event.target.value = '';
      return;
    }
    try {
      const signatureError = await validateRepositoryZipSignature(file);
      if (!requestIsCurrent(requestScopeKey, fileSelectionRef.current, selectionId)) return;
      if (signatureError) {
        setArchiveError(signatureError);
        event.target.value = '';
        return;
      }
      setArchive(file);
      setAnalysisName(file.name.replace(/\.zip$/i, '').slice(0, 200));
    } catch {
      if (!requestIsCurrent(requestScopeKey, fileSelectionRef.current, selectionId)) return;
      setArchiveError('The ZIP signature could not be read in this browser.');
      event.target.value = '';
    }
  };

  const analyze = async () => {
    if (!archive || !createAllowed) return;
    const requestScopeKey = scopeKey;
    const requestId = ++uploadRequestRef.current;
    setUploading(true);
    setArchiveError(undefined);
    try {
      const metadataError = validateRepositoryArchive(archive, maximumBytes);
      const signatureError = metadataError ? undefined : await validateRepositoryZipSignature(archive);
      if (!requestIsCurrent(requestScopeKey, uploadRequestRef.current, requestId)) return;
      if (metadataError || signatureError) throw new Error(metadataError || signatureError);
      const response = await repositoryApi.createAnalysis(archive, {
        name: analysisName.trim() || undefined,
        projectId,
      });
      if (!requestIsCurrent(requestScopeKey, uploadRequestRef.current, requestId)) return;
      const normalized = normalizeRepositoryAnalysis(response.data);
      if (!normalized) throw new Error('The repository service returned an invalid analysis report.');
      detailRequestRef.current += 1;
      setSelected(normalized);
      setArchive(undefined);
      setAnalysisName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      toast.success('Repository analysis completed.');
      await refresh();
      if (!requestIsCurrent(requestScopeKey, uploadRequestRef.current, requestId)) return;
      setSelected(normalized);
    } catch (error) {
      if (requestIsCurrent(requestScopeKey, uploadRequestRef.current, requestId)) {
        setArchiveError(readableApiError(error, error instanceof Error ? error.message : 'Repository analysis failed.'));
      }
    } finally {
      if (requestIsCurrent(requestScopeKey, uploadRequestRef.current, requestId)) setUploading(false);
    }
  };

  const openAnalysis = async (analysis: RepositoryAnalysisSummary) => {
    const requestScopeKey = scopeKey;
    const requestId = ++detailRequestRef.current;
    setSelected(undefined);
    setDetailError(undefined);
    try {
      const response = await repositoryApi.getAnalysis(analysis.id);
      if (!requestIsCurrent(requestScopeKey, detailRequestRef.current, requestId)) return;
      const normalized = normalizeRepositoryAnalysis(response.data);
      if (!normalized) throw new Error('The repository service returned an invalid analysis report.');
      setSelected(normalized);
    } catch (error) {
      if (requestIsCurrent(requestScopeKey, detailRequestRef.current, requestId)) setDetailError(readableApiError(error, 'The repository analysis could not be loaded.'));
    }
  };

  const downloadReport = () => {
    if (!selected) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(selected, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = reportFilename(selected);
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const deleteAnalysis = async () => {
    if (!selected || !deleteAllowed || !window.confirm(`Delete saved repository analysis "${selected.name}"?`)) return;
    const requestScopeKey = scopeKey;
    const requestId = ++deleteRequestRef.current;
    detailRequestRef.current += 1;
    setDeleting(true);
    try {
      await repositoryApi.deleteAnalysis(selected.id);
      if (!requestIsCurrent(requestScopeKey, deleteRequestRef.current, requestId)) return;
      setSelected(undefined);
      await refresh();
      if (!requestIsCurrent(requestScopeKey, deleteRequestRef.current, requestId)) return;
      toast.success('Repository analysis deleted.');
    } catch (error) {
      if (requestIsCurrent(requestScopeKey, deleteRequestRef.current, requestId)) {
        toast.error(readableApiError(error, 'The repository analysis could not be deleted.'));
      }
    } finally {
      if (requestIsCurrent(requestScopeKey, deleteRequestRef.current, requestId)) setDeleting(false);
    }
  };

  const reportSections = useMemo(() => selected ? {
    languages: selected.languages,
    frameworks: selected.frameworks,
    manifests: selected.manifests,
    dependencies: selected.dependencies,
    signals: selected.signals,
  } : undefined, [selected]);

  return <div className="mx-auto max-w-7xl space-y-6 p-6 md:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="flex items-center gap-3 text-3xl font-bold text-white"><GitBranch className="text-primary" />Repository Analyzer</h1><p className="mt-2 text-gray-400">Upload a bounded ZIP and inspect the deterministic report returned by KFive.</p></div><button onClick={() => void refresh()} disabled={loading || !projectValid} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-200 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button></header>

    <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4 text-sm text-cyan-100"><ShieldCheck className="mr-2 inline h-4 w-4" />Analysis is read-only: KFive inventories the uploaded ZIP without modifying its source files. It does not clone repositories, execute code, install packages, or generate an AI report.</div>
    {projectLoading ? <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-gray-400">Verifying project context…</div> : null}
    {projectError ? <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">{projectError} No unscoped repository request was made.</div> : null}
    {invalidScope ? <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">Invalid repository history scope. Choose workspace history or deleted-project history; recovery history cannot be combined with a project. No repository request was made.<button onClick={() => navigate('/app/repositories', { replace: true, state: null })} className="ml-3 underline">Show workspace analyses</button></div> : null}
    {!requested ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 p-4 text-sm text-gray-300"><p>{orphaned ? 'Reports from deleted projects remain available here. Open, export, or delete a report to recover storage capacity.' : 'Workspace reports. Reports from deleted projects have a separate recovery history.'}</p><button onClick={() => navigate(orphaned ? '/app/repositories' : '/app/repositories?scope=orphaned', { replace: true, state: null })} className="rounded-lg border border-white/20 px-3 py-2 text-white">{orphaned ? 'Show workspace analyses' : 'Reports from deleted projects'}</button></div> : null}
    {projectStatus === 'archived' ? <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">{PROJECT_ARCHIVED_MESSAGE} Saved analyses remain readable.</div> : null}
    {context ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3"><div className="flex items-center gap-3"><FolderKanban className="h-5 w-5 text-primary" /><div><p className="text-xs uppercase tracking-wide text-gray-500">Project repository analyses</p><p className="font-medium text-white">{context.projectName} <span className="text-xs capitalize text-gray-500">({projectStatus ?? context.status})</span></p></div></div><button onClick={() => navigate('/app/repositories', { replace: true, state: null })} className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-300"><X className="h-3.5 w-3.5" />Show workspace analyses</button></div> : null}

    <section className="rounded-2xl border border-white/10 bg-white/5 p-5"><h2 className="font-semibold text-white">Analyzer status</h2>{statusError ? <p role="alert" className="mt-3 rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{statusError}</p> : null}{status ? <div className="mt-4 grid gap-3 md:grid-cols-3"><div className="rounded-xl border border-white/10 bg-black/20 p-3"><p className="text-xs text-gray-500">Service</p><p className={status.available === true ? 'mt-1 text-emerald-300' : status.available === false ? 'mt-1 text-red-300' : 'mt-1 text-gray-400'}>{status.available === true ? 'Available' : status.available === false ? 'Unavailable' : 'Not reported'}</p></div>{status.dependencies.map((dependency) => <div key={dependency.id} className="rounded-xl border border-white/10 bg-black/20 p-3"><p className="font-medium text-white">{dependency.id}</p><p className="mt-1 text-xs capitalize text-gray-400">{dependency.status.replace(/[-_]/g, ' ')}</p>{dependency.message ? <p className="mt-2 text-xs text-gray-500">{dependency.message}</p> : null}</div>)}</div> : null}</section>

    <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
      <aside className="space-y-5">
        <section className="rounded-2xl border border-white/10 bg-white/5 p-5"><h2 className="font-semibold text-white">Analyze ZIP</h2><p className="mt-2 text-sm text-gray-500">One ZIP, up to {formatBytes(maximumBytes)}. The archive is sent to the KFive backend.</p><input ref={fileInputRef} type="file" accept=".zip,application/zip,application/x-zip-compressed,application/octet-stream" onChange={(event) => void selectArchive(event)} disabled={!createAllowed || uploading} className="hidden" /><button onClick={() => fileInputRef.current?.click()} disabled={!createAllowed || uploading} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-gray-200 disabled:cursor-not-allowed disabled:opacity-40"><FileArchive className="h-4 w-4" />Choose ZIP</button>{archive ? <div className="mt-3 space-y-3"><p className="truncate text-sm text-white">{archive.name} <span className="text-gray-500">({formatBytes(archive.size)})</span></p><label className="block text-xs text-gray-400">Report name<input value={analysisName} onChange={(event) => setAnalysisName(event.target.value)} maxLength={200} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white" /></label><button onClick={() => void analyze()} disabled={!createAllowed || uploading} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}{uploading ? 'Analyzing…' : 'Analyze repository'}</button></div> : null}{projectStatus === 'archived' ? <p className="mt-3 text-sm text-amber-300">{PROJECT_ARCHIVED_MESSAGE}</p> : status && !status.canAnalyze ? <p className="mt-3 text-sm text-amber-300">New analyses are unavailable. Check the status above.</p> : null}{archiveError ? <p role="alert" className="mt-3 rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{archiveError}</p> : null}</section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-5"><h2 className="font-semibold text-white">Saved reports</h2>{historyError ? <p role="alert" className="mt-3 text-sm text-red-300">{historyError}</p> : null}<div className="mt-3 space-y-2">{analyses.map((analysis) => <button key={analysis.id} onClick={() => void openAnalysis(analysis)} disabled={deleting} className={`w-full rounded-xl border p-3 text-left disabled:cursor-not-allowed disabled:opacity-50 ${selected?.id === analysis.id ? 'border-primary/50 bg-primary/10' : 'border-white/10 bg-black/20'}`}><p className="truncate text-sm font-medium text-white">{analysis.name}</p><p className="mt-1 truncate text-xs text-gray-500">{analysis.source.originalName}</p><p className="mt-1 text-xs capitalize text-emerald-300">{analysis.status}</p></button>)}{!loading && !analyses.length && !historyError ? <p className="py-6 text-center text-sm text-gray-500">No saved analyses in this scope.</p> : null}</div></section>
      </aside>

      <main className="rounded-2xl border border-white/10 bg-white/5 p-5">{detailError ? <p role="alert" className="mb-4 rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{detailError}</p> : null}{selected && reportSections ? <div className="space-y-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold text-white">{selected.name}</h2><p className="mt-1 text-sm text-gray-500">{selected.source.originalName} · SHA-256 {selected.source.sha256}</p></div><div className="flex flex-wrap gap-2"><button onClick={downloadReport} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-200"><Download className="h-4 w-4" />Download JSON</button><button onClick={() => void deleteAnalysis()} disabled={!deleteAllowed || deleting} className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-200 disabled:cursor-not-allowed disabled:opacity-40">{deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Delete report</button></div></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[['Files', selected.summary.fileCount], ['Directories', selected.summary.directoryCount], ['Uncompressed', formatBytes(selected.summary.declaredUncompressedBytes)], ['Maximum depth', selected.summary.maxDepth], ['Package manifests', selected.summary.packageManifestCount], ['Test files', selected.summary.testFileCount]].map(([label, value]) => <div key={label} className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-xs text-gray-500">{label}</p><p className="mt-1 text-lg font-semibold text-white">{value}</p></div>)}</div>
        {selected.warnings.length ? <section><h3 className="font-semibold text-white">Warnings</h3><ul className="mt-2 space-y-2 text-sm text-amber-200">{selected.warnings.map((warning, index) => <li key={`${warning.code}:${warning.path ?? index}`} className="rounded-lg bg-amber-500/10 p-3"><span className="font-mono text-xs">{warning.code}</span> — {warning.message}{warning.path ? <span className="block text-xs text-amber-300/70">{warning.path}</span> : null}</li>)}</ul></section> : null}
        <div className="grid gap-5 md:grid-cols-2"><section><h3 className="font-semibold text-white">Languages</h3><div className="mt-2 space-y-2">{reportSections.languages.map((language) => <div key={language.name} className="rounded-lg bg-black/20 p-3 text-sm text-gray-300"><span className="font-medium text-white">{language.name}</span> · {language.files} files · {formatBytes(language.declaredBytes)}</div>)}{!reportSections.languages.length ? <p className="text-sm text-gray-500">None reported.</p> : null}</div></section><section><h3 className="font-semibold text-white">Frameworks and tools</h3><div className="mt-2 space-y-2">{reportSections.frameworks.map((framework) => <div key={`${framework.name}:${framework.manifestPath}`} className="rounded-lg bg-black/20 p-3"><p className="text-sm font-medium text-white">{framework.name}</p><p className="mt-1 text-xs text-gray-500">{framework.dependency} in {framework.manifestPath}</p></div>)}{!reportSections.frameworks.length ? <p className="text-sm text-gray-500">None reported.</p> : null}</div></section></div>
        <section><h3 className="font-semibold text-white">Package manifests</h3><div className="mt-2 space-y-2">{reportSections.manifests.map((manifest) => <div key={manifest.path} className="rounded-lg bg-black/20 p-3"><p className="text-sm font-medium text-white">{manifest.path} <span className="ml-2 text-xs text-gray-500">{manifest.packageManager}</span></p><p className="mt-1 text-xs text-gray-400">{manifest.packageName ? `${manifest.packageName} · ` : ''}{manifest.dependencyCount} declared dependencies</p>{manifest.scriptNames.length ? <p className="mt-1 text-xs text-gray-500">Script names: {manifest.scriptNames.join(', ')}</p> : null}</div>)}{!reportSections.manifests.length ? <p className="text-sm text-gray-500">None reported.</p> : null}</div></section>
        <section><h3 className="font-semibold text-white">Declared dependencies</h3><div className="mt-2 max-h-80 space-y-1 overflow-auto rounded-xl border border-white/10 bg-black/20 p-3">{reportSections.dependencies.map((dependency, index) => <p key={`${dependency.manifestPath}:${dependency.name}:${dependency.kind}:${index}`} className="break-words text-xs text-gray-400"><span className="font-medium text-white">{dependency.name}</span> {dependency.version} · {dependency.kind} · {dependency.manifestPath}</p>)}{!reportSections.dependencies.length ? <p className="text-sm text-gray-500">None reported.</p> : null}</div></section>
        <section><h3 className="font-semibold text-white">Repository signals</h3><div className="mt-2 grid gap-2 sm:grid-cols-2">{reportSections.signals.map((signal, index) => <div key={`${signal.kind}:${signal.path}:${index}`} className="rounded-lg bg-black/20 p-3"><p className="text-xs uppercase tracking-wide text-primary">{signal.kind}{signal.severity ? ` · ${signal.severity}` : ''}</p><p className="mt-1 break-all text-sm text-gray-300">{signal.path}</p></div>)}{!reportSections.signals.length ? <p className="text-sm text-gray-500">None reported.</p> : null}</div></section>
        <section><h3 className="font-semibold text-white">Repository tree</h3><div className="mt-2 max-h-96 overflow-auto rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-xs text-gray-400">{selected.tree.map((entry, index) => <p key={`${entry.path}:${index}`} className="flex gap-2 py-0.5"><FileCode2 className="mt-0.5 h-3 w-3 shrink-0" /><span className="break-all">{entry.path}{entry.language ? ` · ${entry.language}` : ''}</span>{entry.declaredBytes !== undefined ? <span className="ml-auto shrink-0 text-gray-600">{formatBytes(entry.declaredBytes)}</span> : null}</p>)}{!selected.tree.length ? <p>No tree entries reported.</p> : null}</div></section>
      </div> : <div className="flex min-h-80 items-center justify-center text-center text-gray-500"><div><GitBranch className="mx-auto h-10 w-10" /><p className="mt-3">Select or create a repository analysis.</p></div></div>}</main>
    </div>
  </div>;
}
