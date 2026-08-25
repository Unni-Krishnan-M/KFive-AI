import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, FileText, FolderKanban, Loader2, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useProjectContext } from '@/hooks/useProjectContext';
import { knowledgeApi } from '@/services/api';
import {
  KnowledgeQueryResult,
  KnowledgeSource,
  KnowledgeStatus,
  canMutateKnowledge,
  knowledgeProjectPayload,
  nextKnowledgeRefreshDelay,
  normalizeKnowledgeQuery,
  normalizeKnowledgeSources,
  normalizeKnowledgeStatus,
  sourceMediaType,
  validateKnowledgeFile,
} from '@/services/knowledge';
import { PROJECT_ARCHIVED_MESSAGE } from '@/services/projectContext';
import { readableApiError } from '@/services/runtimeSettings';

const statusStyle: Record<KnowledgeSource['status'], string> = {
  queued: 'bg-amber-500/10 text-amber-300',
  indexing: 'bg-cyan-500/10 text-cyan-300',
  ready: 'bg-emerald-500/10 text-emerald-300',
  failed: 'bg-red-500/10 text-red-300',
  unknown: 'bg-gray-500/10 text-gray-300',
};

export default function KnowledgePage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const refreshRequestRef = useRef(0);
  const { requested, context, loading: projectLoading, error: projectError } = useProjectContext();
  const projectId = context?.projectId;
  const projectValid = !requested || Boolean(context);
  const mutationsAllowed = canMutateKnowledge(context?.status, projectValid);
  const [status, setStatus] = useState<KnowledgeStatus>();
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [statusError, setStatusError] = useState<string>();
  const [sourcesError, setSourcesError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File>();
  const [fileError, setFileError] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string>();
  const [question, setQuestion] = useState('');
  const [topK, setTopK] = useState(5);
  const [querying, setQuerying] = useState(false);
  const [queryError, setQueryError] = useState<string>();
  const [result, setResult] = useState<KnowledgeQueryResult>();
  const [refreshAttempt, setRefreshAttempt] = useState(0);

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestRef.current;
    if (!projectValid) {
      setStatus(undefined);
      setSources([]);
      setStatusError(undefined);
      setSourcesError(undefined);
      setLoading(false);
      return;
    }
    setLoading(true);
    const [statusResult, sourcesResult] = await Promise.allSettled([
      knowledgeApi.getStatus(projectId),
      knowledgeApi.getSources(projectId),
    ]);
    if (requestId !== refreshRequestRef.current) return;
    if (statusResult.status === 'fulfilled') {
      setStatus(normalizeKnowledgeStatus(statusResult.value.data));
      setStatusError(undefined);
    } else {
      setStatus(undefined);
      setStatusError(readableApiError(statusResult.reason, 'Knowledge dependencies could not be checked.'));
    }
    if (sourcesResult.status === 'fulfilled') {
      setSources(normalizeKnowledgeSources(sourcesResult.value.data));
      setSourcesError(undefined);
    } else {
      setSources([]);
      setSourcesError(readableApiError(sourcesResult.reason, 'Knowledge sources could not be loaded.'));
    }
    setLoading(false);
  }, [projectId, projectValid]);

  useEffect(() => {
    setResult(undefined);
    setQueryError(undefined);
    setRefreshAttempt(0);
    void refresh();
  }, [refresh]);

  const hasPendingSources = sources.some((source) => source.status === 'queued' || source.status === 'indexing');
  useEffect(() => {
    if (!hasPendingSources) return;
    const nextAttempt = refreshAttempt + 1;
    const delay = nextKnowledgeRefreshDelay(nextAttempt);
    if (delay === undefined) return;
    const timer = window.setTimeout(() => {
      setRefreshAttempt(nextAttempt);
      void refresh();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [hasPendingSources, refresh, refreshAttempt]);

  const readySources = useMemo(() => sources.filter((source) => source.status === 'ready'), [sources]);
  const queryAllowed = projectValid && status?.canQuery === true && readySources.length > 0;
  const ingestAllowed = mutationsAllowed && status?.canIngest === true;

  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setSelectedFile(undefined);
    setFileError(undefined);
    if (!file) return;
    const validationError = validateKnowledgeFile(file);
    if (validationError) {
      setFileError(validationError);
      event.target.value = '';
      return;
    }
    setSelectedFile(file);
  };

  const ingest = async () => {
    if (!selectedFile || !ingestAllowed) return;
    setUploading(true);
    setFileError(undefined);
    try {
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(await selectedFile.arrayBuffer());
      } catch {
        throw new Error('The source is not valid UTF-8 text. Save it as UTF-8 and try again.');
      }
      if (!content.trim()) throw new Error('The source file contains no readable text.');
      await knowledgeApi.createSource(knowledgeProjectPayload({
        name: selectedFile.name,
        mediaType: sourceMediaType(selectedFile.name),
        content,
      }, projectId));
      toast.success('Knowledge source indexed.');
      setSelectedFile(undefined);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setRefreshAttempt(0);
      await refresh();
    } catch (error) {
      setFileError(readableApiError(error, error instanceof Error ? error.message : 'The source could not be ingested.'));
    } finally {
      setUploading(false);
    }
  };

  const deleteSource = async (source: KnowledgeSource) => {
    if (!mutationsAllowed || !window.confirm(`Delete knowledge source "${source.name}"?`)) return;
    setDeletingId(source.id);
    try {
      await knowledgeApi.deleteSource(source.id);
      if (result?.references.some((reference) => reference.sourceId === source.id)) setResult(undefined);
      toast.success('Knowledge source deleted.');
      await refresh();
    } catch (error) {
      toast.error(readableApiError(error, 'The knowledge source could not be deleted.'));
    } finally {
      setDeletingId(undefined);
    }
  };

  const submitQuery = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || !queryAllowed) return;
    setQuerying(true);
    setQueryError(undefined);
    setResult(undefined);
    try {
      const response = await knowledgeApi.query(knowledgeProjectPayload({ question: trimmedQuestion, topK }, projectId));
      const normalized = normalizeKnowledgeQuery(response.data);
      if (!normalized) throw new Error('The knowledge service returned an invalid query result.');
      setResult(normalized);
    } catch (error) {
      setQueryError(readableApiError(error, error instanceof Error ? error.message : 'The knowledge query failed.'));
    } finally {
      setQuerying(false);
    }
  };

  return <div className="mx-auto max-w-7xl space-y-6 p-6 md:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="flex items-center gap-3 text-3xl font-bold text-white"><BookOpen className="text-primary" />Knowledge / RAG</h1><p className="mt-2 text-gray-400">Index small text sources, retrieve relevant chunks, and inspect the sources returned by the backend.</p></div>
      <button onClick={() => { setRefreshAttempt(0); void refresh(); }} disabled={loading || !projectValid} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-200 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button>
    </header>

    {projectLoading ? <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-gray-400">Verifying project context…</div> : null}
    {projectError ? <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">{projectError} No unscoped knowledge request was made.</div> : null}
    {context?.status === 'archived' ? <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">{PROJECT_ARCHIVED_MESSAGE} Existing sources and queries remain available when the backend reports they are ready.</div> : null}
    {context ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3"><div className="flex items-center gap-3"><FolderKanban className="h-5 w-5 text-primary" /><div><p className="text-xs uppercase tracking-wide text-gray-500">Project knowledge</p><p className="font-medium text-white">{context.projectName} <span className="text-xs capitalize text-gray-500">({context.status})</span></p></div></div><button onClick={() => navigate('/app/knowledge', { replace: true, state: null })} className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-300"><X className="h-3.5 w-3.5" />Show workspace knowledge</button></div> : null}

    <section className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-white">Dependencies</h2><p className="mt-1 text-sm text-gray-500">Availability and messages are reported by the backend.</p></div>{status?.scope ? <span className="rounded-lg bg-black/30 px-3 py-1 text-xs text-gray-400">Scope: {status.scope}</span> : null}</div>
      {statusError ? <p role="alert" className="mt-4 rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{statusError}</p> : null}
      {status ? <div className="mt-4 grid gap-3 md:grid-cols-3"><div className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-xs text-gray-500">Service</p><p className={status.available === true ? 'mt-1 text-emerald-300' : status.available === false ? 'mt-1 text-red-300' : 'mt-1 text-gray-400'}>{status.available === true ? 'Available' : status.available === false ? 'Unavailable' : 'Not reported'}</p></div>{status.dependencies.map((dependency) => <div key={dependency.id} className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-sm font-medium text-white">{dependency.id}</p><p className="mt-1 text-xs capitalize text-gray-400">{dependency.status.replace('-', ' ')}</p>{dependency.message ? <p className="mt-2 text-xs text-gray-500">{dependency.message}</p> : null}</div>)}</div> : null}
    </section>

    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)]">
      <section className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-5">
        <div><h2 className="font-semibold text-white">Knowledge sources</h2><p className="mt-1 text-sm text-gray-500">TXT or Markdown only, up to 64 KiB. Text is sent to the configured backend for indexing.</p></div>
        <input ref={fileInputRef} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={selectFile} disabled={!ingestAllowed || uploading} className="hidden" />
        <div className="flex flex-wrap gap-2"><button onClick={() => fileInputRef.current?.click()} disabled={!ingestAllowed || uploading} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-gray-200 disabled:cursor-not-allowed disabled:opacity-40"><Upload className="h-4 w-4" />Choose source</button>{selectedFile ? <button onClick={() => void ingest()} disabled={uploading} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Index {selectedFile.name}</button> : null}</div>
        {!mutationsAllowed && projectValid ? <p className="text-sm text-amber-300">{PROJECT_ARCHIVED_MESSAGE}</p> : null}
        {mutationsAllowed && status && !status.canIngest ? <p className="text-sm text-amber-300">Ingestion is unavailable. Check the dependency messages above.</p> : null}
        {fileError ? <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{fileError}</p> : null}
        {sourcesError ? <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{sourcesError}</p> : null}
        <div className="space-y-3">{sources.map((source) => <article key={source.id} className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-medium text-white"><FileText className="mr-2 inline h-4 w-4 text-primary" />{source.name}</p><p className="mt-1 text-xs text-gray-500">{source.mediaType}{source.characterCount !== undefined ? ` · ${source.characterCount.toLocaleString()} characters` : ''}{source.chunkCount !== undefined ? ` · ${source.chunkCount} chunks` : ''}</p></div><div className="flex items-center gap-2"><span className={`rounded-full px-2 py-1 text-xs capitalize ${statusStyle[source.status]}`}>{source.status}</span><button aria-label={`Delete ${source.name}`} onClick={() => void deleteSource(source)} disabled={!mutationsAllowed || deletingId === source.id} className="p-1.5 text-gray-500 hover:text-red-300 disabled:opacity-30">{deletingId === source.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}</button></div></div>{source.embeddingProvider || source.embeddingModel ? <p className="mt-2 text-xs text-gray-500">Embedding: {[source.embeddingProvider, source.embeddingModel, source.embeddingDimension ? `${source.embeddingDimension} dimensions` : undefined].filter(Boolean).join(' / ')}</p> : null}{source.errorMessage || source.errorCode ? <div role="alert" className="mt-2 text-sm text-red-300">{source.errorMessage ? <p>{source.errorMessage}</p> : null}{source.errorCode ? <p className="mt-1 font-mono text-xs">{source.errorCode}</p> : null}</div> : null}</article>)}{!loading && !sources.length && !sourcesError ? <p className="rounded-xl border border-dashed border-white/10 p-8 text-center text-sm text-gray-500">No knowledge sources in this scope.</p> : null}</div>
        {hasPendingSources && nextKnowledgeRefreshDelay(refreshAttempt + 1) === undefined ? <p className="text-xs text-amber-300">Automatic refresh stopped after bounded retries. Use Refresh to check again.</p> : null}
      </section>

      <section className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-5">
        <div><h2 className="font-semibold text-white">Ask indexed knowledge</h2><p className="mt-1 text-sm text-gray-500">Answers and retrieved excerpts come from the configured backend.</p></div>
        <form onSubmit={submitQuery} className="space-y-3"><textarea value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={2000} placeholder="Ask a question about ready sources…" className="min-h-28 w-full rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-white placeholder:text-gray-600" /><label className="flex items-center gap-2 text-xs text-gray-400">Retrieved chunks<select value={topK} onChange={(event) => setTopK(Number(event.target.value))} className="rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-white">{[3, 5, 8, 10].map((value) => <option key={value}>{value}</option>)}</select></label><button disabled={!queryAllowed || !question.trim() || querying} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">{querying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}Ask</button></form>
        {!status?.canQuery ? <p className="text-sm text-amber-300">Querying is unavailable. Check the dependency messages above.</p> : readySources.length === 0 ? <p className="text-sm text-amber-300">No ready knowledge source is available yet.</p> : null}
        {queryError ? <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{queryError}</p> : null}
        {result ? <div className="space-y-4 border-t border-white/10 pt-4"><div><p className="whitespace-pre-wrap text-sm leading-6 text-gray-200">{result.answer}</p><p className="mt-2 text-xs text-gray-500">Generated by {result.provider} / {result.model}</p></div><div><h3 className="text-sm font-semibold text-white">Retrieved sources</h3>{result.references.length ? <div className="mt-2 space-y-2">{result.references.map((reference) => <article key={`${reference.referenceId ?? reference.marker ?? reference.chunkId ?? 'reference'}:${reference.sourceId}:${reference.chunkIndex}`} className="rounded-lg border border-white/10 bg-black/20 p-3"><p className="text-xs font-medium text-primary">{reference.marker ?? (reference.referenceId ? `[${reference.referenceId}]` : '')} {reference.sourceName} · chunk {reference.chunkIndex + 1}</p><p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-gray-400">{reference.excerpt}</p>{reference.distance !== undefined ? <p className="mt-2 text-[11px] text-gray-600">Distance (lower is closer): {reference.distance}</p> : null}</article>)}</div> : <p className="mt-2 text-xs text-gray-500">The backend returned no source references.</p>}</div></div> : null}
      </section>
    </div>
  </div>;
}
