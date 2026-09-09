import { ChangeEvent, useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Database,
  Download,
  FileJson,
  FileSpreadsheet,
  FolderKanban,
  GitBranchPlus,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useProjectContext } from '@/hooks/useProjectContext';
import { datasetApi } from '@/services/api';
import {
  DATASET_UPLOAD_LIMIT_BYTES,
  DatasetCell,
  DatasetDetail,
  DatasetStatus,
  DatasetSummary,
  DatasetTransforms,
  buildDatasetDerivePayload,
  canMutateDatasets,
  datasetScopeKey,
  effectiveDatasetProjectStatus,
  formatDatasetBytes,
  isDatasetScopeRequestCurrent,
  normalizeDataset,
  normalizeDatasetList,
  normalizeDatasetStatus,
  validateDatasetFile,
} from '@/services/datasetLab';
import { PROJECT_ARCHIVED_MESSAGE } from '@/services/projectContext';
import { readableApiError } from '@/services/runtimeSettings';

const transformsForFormat = (format?: 'csv' | 'json'): DatasetTransforms => ({
  trimStrings: true,
  dropDuplicateRows: false,
  dropRowsWithMissingValues: false,
  escapeSpreadsheetFormulas: format !== 'json',
});

const dateTime = (value?: string): string => value ? new Date(value).toLocaleString() : 'Time not reported';
const cellText = (value: DatasetCell): string => value === null ? 'Missing' : typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);

export default function DatasetLabPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const scopeKeyRef = useRef('workspace');
  const refreshRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const uploadRequestRef = useRef(0);
  const deriveRequestRef = useRef(0);
  const deleteRequestRef = useRef(0);
  const downloadRequestRef = useRef(0);
  const { requested, context, loading: projectLoading, error: projectError } = useProjectContext();
  const projectValid = !requested || Boolean(context);
  const projectId = context?.projectId;
  const scopeKey = datasetScopeKey(requested, projectId);
  const [status, setStatus] = useState<DatasetStatus>();
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [selected, setSelected] = useState<DatasetDetail>();
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [statusError, setStatusError] = useState<string>();
  const [listError, setListError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [file, setFile] = useState<File>();
  const [name, setName] = useState('');
  const [uploadError, setUploadError] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [deriveName, setDeriveName] = useState('');
  const [transforms, setTransforms] = useState<DatasetTransforms>(() => transformsForFormat());
  const [deriveError, setDeriveError] = useState<string>();
  const [deriving, setDeriving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DatasetDetail>();
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const maximumBytes = Math.min(status?.limits.uploadBytes ?? DATASET_UPLOAD_LIMIT_BYTES, DATASET_UPLOAD_LIMIT_BYTES);
  const projectStatus = context
    ? effectiveDatasetProjectStatus(context.status, status?.scope?.projectStatus)
    : undefined;
  const mutationsAllowed = canMutateDatasets(projectStatus, projectValid, status?.available !== false);
  const uploadAllowed = canMutateDatasets(projectStatus, projectValid, status?.canUpload === true);
  const hasSelectedTransform = Object.values(transforms).some(Boolean);

  const requestIsCurrent = useCallback((requestScope: string, currentRequestId: number, requestId: number): boolean => (
    mountedRef.current && isDatasetScopeRequestCurrent(scopeKeyRef.current, requestScope, currentRequestId, requestId)
  ), []);

  const refresh = useCallback(async () => {
    const requestScope = scopeKey;
    const requestId = ++refreshRequestRef.current;
    if (!projectValid) {
      setStatus(undefined);
      setDatasets([]);
      setSelected(undefined);
      setStatusError(undefined);
      setListError(undefined);
      setLoading(false);
      return;
    }
    setLoading(true);
    const [statusResult, listResult] = await Promise.allSettled([
      datasetApi.getStatus(projectId),
      datasetApi.list(projectId),
    ]);
    if (!requestIsCurrent(requestScope, refreshRequestRef.current, requestId)) return;
    if (statusResult.status === 'fulfilled') {
      setStatus(normalizeDatasetStatus(statusResult.value.data));
      setStatusError(undefined);
    } else {
      setStatus(undefined);
      setStatusError(readableApiError(statusResult.reason, 'Dataset Lab availability could not be checked.'));
    }
    if (listResult.status === 'fulfilled') {
      const next = normalizeDatasetList(listResult.value.data);
      setDatasets(next);
      setSelected((current) => current && next.some((item) => item.id === current.id) ? current : undefined);
      setListError(undefined);
    } else {
      setDatasets([]);
      setSelected(undefined);
      setListError(readableApiError(listResult.reason, 'Datasets could not be loaded.'));
    }
    setLoading(false);
  }, [projectId, projectValid, requestIsCurrent, scopeKey]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshRequestRef.current += 1;
      detailRequestRef.current += 1;
      uploadRequestRef.current += 1;
      deriveRequestRef.current += 1;
      deleteRequestRef.current += 1;
      downloadRequestRef.current += 1;
    };
  }, []);

  useLayoutEffect(() => {
    scopeKeyRef.current = scopeKey;
    refreshRequestRef.current += 1;
    detailRequestRef.current += 1;
    uploadRequestRef.current += 1;
    deriveRequestRef.current += 1;
    deleteRequestRef.current += 1;
    downloadRequestRef.current += 1;
    setStatus(undefined);
    setDatasets([]);
    setSelected(undefined);
    setStatusError(undefined);
    setListError(undefined);
    setDetailError(undefined);
    setFile(undefined);
    setName('');
    setUploadError(undefined);
    setUploading(false);
    setDeriveName('');
    setTransforms(transformsForFormat());
    setDeriveError(undefined);
    setDeriving(false);
    setDeleteTarget(undefined);
    setDeleting(false);
    setDownloading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    void refresh();
  }, [refresh, scopeKey]);

  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    setFile(undefined);
    setName('');
    setUploadError(undefined);
    if (!selectedFile) return;
    const validationError = validateDatasetFile(selectedFile, maximumBytes);
    if (validationError) {
      setUploadError(validationError);
      event.target.value = '';
      return;
    }
    setFile(selectedFile);
    setName(selectedFile.name.replace(/\.(csv|json)$/i, '').slice(0, 200));
  };

  const upload = async () => {
    if (!file || !name.trim() || !uploadAllowed) return;
    const requestScope = scopeKey;
    const requestId = ++uploadRequestRef.current;
    setUploading(true);
    setUploadError(undefined);
    try {
      const validationError = validateDatasetFile(file, maximumBytes);
      if (validationError) throw new Error(validationError);
      const response = await datasetApi.upload(file, { name: name.trim(), projectId });
      if (!requestIsCurrent(requestScope, uploadRequestRef.current, requestId)) return;
      const created = normalizeDataset(response.data);
      if (!created) throw new Error('The dataset service returned an invalid dataset record.');
      setFile(undefined);
      setName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      toast.success('Dataset uploaded and analyzed.');
      await refresh();
      if (!requestIsCurrent(requestScope, uploadRequestRef.current, requestId)) return;
      setSelected(created);
      setDeriveName(`${created.name} cleaned`.slice(0, 200));
      setTransforms(transformsForFormat(created.format));
    } catch (error) {
      if (requestIsCurrent(requestScope, uploadRequestRef.current, requestId)) {
        setUploadError(readableApiError(error, error instanceof Error ? error.message : 'The dataset could not be uploaded.'));
      }
    } finally {
      if (requestIsCurrent(requestScope, uploadRequestRef.current, requestId)) setUploading(false);
    }
  };

  const openDataset = async (summary: DatasetSummary) => {
    const requestScope = scopeKey;
    const requestId = ++detailRequestRef.current;
    setDetailLoading(true);
    setDetailError(undefined);
    setSelected(undefined);
    try {
      const response = await datasetApi.get(summary.id);
      if (!requestIsCurrent(requestScope, detailRequestRef.current, requestId)) return;
      const detail = normalizeDataset(response.data);
      if (!detail) throw new Error('The dataset service returned an invalid dataset detail.');
      setSelected(detail);
      setDeriveName(`${detail.name} cleaned`.slice(0, 200));
      setTransforms(transformsForFormat(detail.format));
    } catch (error) {
      if (requestIsCurrent(requestScope, detailRequestRef.current, requestId)) {
        setDetailError(readableApiError(error, 'The selected dataset could not be loaded.'));
      }
    } finally {
      if (requestIsCurrent(requestScope, detailRequestRef.current, requestId)) setDetailLoading(false);
    }
  };

  const derive = async () => {
    if (!selected || !deriveName.trim() || !mutationsAllowed || !hasSelectedTransform) return;
    const requestScope = scopeKey;
    const requestId = ++deriveRequestRef.current;
    setDeriving(true);
    setDeriveError(undefined);
    try {
      const response = await datasetApi.derive(selected.id, buildDatasetDerivePayload(deriveName, transforms));
      if (!requestIsCurrent(requestScope, deriveRequestRef.current, requestId)) return;
      const derived = normalizeDataset(response.data);
      if (!derived) throw new Error('The dataset service returned an invalid derived dataset.');
      toast.success('Derived dataset created.');
      await refresh();
      if (!requestIsCurrent(requestScope, deriveRequestRef.current, requestId)) return;
      setSelected(derived);
      setDeriveName(`${derived.name} cleaned`.slice(0, 200));
    } catch (error) {
      if (requestIsCurrent(requestScope, deriveRequestRef.current, requestId)) {
        setDeriveError(readableApiError(error, 'The derived dataset could not be created.'));
      }
    } finally {
      if (requestIsCurrent(requestScope, deriveRequestRef.current, requestId)) setDeriving(false);
    }
  };

  const download = async () => {
    if (!selected) return;
    const requestScope = scopeKey;
    const requestId = ++downloadRequestRef.current;
    setDownloading(true);
    try {
      const response = await datasetApi.download(selected.id);
      if (!requestIsCurrent(requestScope, downloadRequestRef.current, requestId)) return;
      const blob = response.data instanceof Blob ? response.data : new Blob([response.data], { type: selected.source.mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const safeName = selected.name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'dataset';
      link.download = `${safeName}.${selected.format}`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (requestIsCurrent(requestScope, downloadRequestRef.current, requestId)) {
        toast.error(readableApiError(error, 'The dataset could not be downloaded.'));
      }
    } finally {
      if (requestIsCurrent(requestScope, downloadRequestRef.current, requestId)) setDownloading(false);
    }
  };

  const deleteDataset = async () => {
    if (!deleteTarget || !mutationsAllowed) return;
    const requestScope = scopeKey;
    const requestId = ++deleteRequestRef.current;
    setDeleting(true);
    try {
      await datasetApi.delete(deleteTarget.id);
      if (!requestIsCurrent(requestScope, deleteRequestRef.current, requestId)) return;
      setDeleteTarget(undefined);
      setSelected(undefined);
      await refresh();
      if (!requestIsCurrent(requestScope, deleteRequestRef.current, requestId)) return;
      toast.success('Dataset deleted.');
    } catch (error) {
      if (requestIsCurrent(requestScope, deleteRequestRef.current, requestId)) {
        toast.error(readableApiError(error, 'The dataset could not be deleted.'));
      }
    } finally {
      if (requestIsCurrent(requestScope, deleteRequestRef.current, requestId)) setDeleting(false);
    }
  };

  return <div className="mx-auto max-w-7xl space-y-6 p-6 md:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="flex flex-wrap items-center gap-3"><h1 className="flex items-center gap-3 text-3xl font-bold text-white"><Database className="text-primary" />Dataset Lab</h1><span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-amber-200">Experimental</span></div><p className="mt-2 text-gray-400">Inspect bounded CSV or JSON datasets and create deterministic cleaned copies.</p></div>
      <button onClick={() => void refresh()} disabled={loading || !projectValid} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-200 disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button>
    </header>

    <div role="note" className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4 text-sm text-cyan-100"><ShieldCheck className="mr-2 inline h-4 w-4" />Analysis is deterministic and bounded. Dataset Lab does not execute dataset content, start notebooks, train models, run benchmarks, or submit GPU jobs.</div>
    <div role="alert" className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-100"><AlertTriangle className="mr-2 inline h-4 w-4" />Uploaded and derived dataset content is persisted for later download. Do not upload passwords, access tokens, or data you are not authorized to store.</div>
    {projectLoading ? <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-gray-400">Verifying project context…</div> : null}
    {projectError ? <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">{projectError} No unscoped dataset request was made.</div> : null}
    {projectStatus === 'archived' ? <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">{PROJECT_ARCHIVED_MESSAGE} Saved datasets remain readable and downloadable.</div> : null}
    {context ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3"><div className="flex min-w-0 items-center gap-3"><FolderKanban className="h-5 w-5 shrink-0 text-primary" /><div className="min-w-0"><p className="text-xs uppercase tracking-wide text-gray-500">Project datasets</p><p className="truncate font-medium text-white">{context.projectName} <span className="text-xs capitalize text-gray-500">({projectStatus ?? context.status})</span></p></div></div><button onClick={() => navigate('/app/datasets', { replace: true, state: null })} className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-300"><X className="h-3.5 w-3.5" />Show workspace datasets</button></div> : null}

    <section className="rounded-2xl border border-white/10 bg-white/5 p-5" aria-labelledby="dataset-status-heading">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="dataset-status-heading" className="font-semibold text-white">Dataset service</h2><p className="mt-1 text-sm text-gray-500">Backend-advertised availability and enforced limits.</p></div>{status ? <span className={`rounded-full px-3 py-1 text-xs ${status.available === true ? 'bg-emerald-500/10 text-emerald-300' : status.available === false ? 'bg-red-500/10 text-red-300' : 'bg-gray-500/10 text-gray-400'}`}>{status.available === true ? 'Available' : status.available === false ? 'Unavailable' : 'Availability not reported'}</span> : null}</div>
      {statusError ? <p role="alert" className="mt-3 rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{statusError}</p> : null}
      {status ? <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6"><Metric label="Upload" value={formatDatasetBytes(maximumBytes)} /><Metric label="Derived file" value={status.limits.derivedBytes === undefined ? 'Not reported' : formatDatasetBytes(status.limits.derivedBytes)} /><Metric label="Rows" value={(status.limits.rows ?? 10_000).toLocaleString()} /><Metric label="Columns" value={(status.limits.columns ?? 100).toLocaleString()} /><Metric label="Preview rows" value={(status.limits.previewRows ?? 50).toLocaleString()} /><Metric label="Saved" value={status.retention ? `${status.retention.used.toLocaleString()} / ${status.retention.maximum.toLocaleString()}` : 'Not reported'} /></dl> : null}
    </section>

    <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
      <aside className="space-y-5">
        <section className="rounded-2xl border border-white/10 bg-white/5 p-5" aria-labelledby="dataset-upload-heading"><h2 id="dataset-upload-heading" className="font-semibold text-white">Upload dataset</h2><p className="mt-2 text-sm text-gray-500">One UTF-8 CSV or flat-object JSON file, up to {formatDatasetBytes(maximumBytes)}.</p><input ref={fileInputRef} type="file" accept=".csv,.json,text/csv,application/json" onChange={selectFile} disabled={!uploadAllowed || uploading} className="hidden" aria-describedby={uploadError ? 'dataset-upload-error' : undefined} /><button onClick={() => fileInputRef.current?.click()} disabled={!uploadAllowed || uploading} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-gray-200 disabled:cursor-not-allowed disabled:opacity-40"><Upload className="h-4 w-4" />Choose CSV or JSON</button>{file ? <div className="mt-4 space-y-3"><p className="truncate text-sm text-white">{file.name} <span className="text-gray-500">({formatDatasetBytes(file.size)})</span></p><label className="block text-xs text-gray-400">Dataset name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white" /></label><button onClick={() => void upload()} disabled={uploading || !name.trim()} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-40">{uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />}{uploading ? 'Uploading and analyzing…' : 'Upload and analyze'}</button></div> : null}{projectStatus === 'archived' ? <p className="mt-3 text-sm text-amber-300">{PROJECT_ARCHIVED_MESSAGE}</p> : status && !status.canUpload ? <p className="mt-3 text-sm text-amber-300">Uploads are unavailable. Check service availability and owner limits.</p> : null}{uploadError ? <p id="dataset-upload-error" role="alert" className="mt-3 rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{uploadError}</p> : null}</section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-5" aria-labelledby="saved-datasets-heading"><div className="flex items-center justify-between"><h2 id="saved-datasets-heading" className="font-semibold text-white">Saved datasets</h2><span className="text-xs text-gray-500">{datasets.length}</span></div>{listError ? <p role="alert" className="mt-3 text-sm text-red-300">{listError}</p> : null}<div className="mt-3 space-y-2">{datasets.map((dataset) => <button key={dataset.id} onClick={() => void openDataset(dataset)} disabled={detailLoading || deleting} className={`w-full rounded-xl border p-3 text-left disabled:opacity-50 ${selected?.id === dataset.id ? 'border-primary/50 bg-primary/10' : 'border-white/10 bg-black/20'}`}><div className="flex items-center gap-2">{dataset.format === 'csv' ? <FileSpreadsheet className="h-4 w-4 text-emerald-300" /> : <FileJson className="h-4 w-4 text-cyan-300" />}<p className="min-w-0 flex-1 truncate text-sm font-medium text-white">{dataset.name}</p><span className="text-[10px] uppercase text-gray-500">{dataset.kind}</span></div><p className="mt-2 truncate text-xs text-gray-500">{dataset.source.originalName} · {formatDatasetBytes(dataset.source.bytes)}</p><p className="mt-1 text-xs text-gray-600">{dateTime(dataset.createdAt)}</p></button>)}{loading ? <p className="flex items-center justify-center gap-2 py-6 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />Loading datasets…</p> : !datasets.length && !listError ? <p className="py-6 text-center text-sm text-gray-500">No saved datasets in this scope.</p> : null}</div></section>
      </aside>

      <main className="min-w-0 rounded-2xl border border-white/10 bg-white/5 p-5">
        {detailError ? <p role="alert" className="mb-4 rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{detailError}</p> : null}
        {detailLoading ? <div className="flex min-h-80 items-center justify-center gap-2 text-gray-500"><Loader2 className="h-5 w-5 animate-spin" />Loading dataset detail…</div> : selected ? <div className="space-y-7">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-semibold text-white">{selected.name}</h2><span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] uppercase text-primary">{selected.kind} · {selected.format}</span></div><p className="mt-1 text-sm text-gray-500">{selected.source.originalName} · {formatDatasetBytes(selected.source.bytes)} · SHA-256 <span className="font-mono">{selected.source.sha256.slice(0, 12)}…</span></p>{selected.parentDatasetId ? <p className="mt-1 text-xs text-gray-600">Derived from dataset <span className="font-mono">{selected.parentDatasetId}</span></p> : null}</div><div className="flex gap-2"><button onClick={() => void download()} disabled={downloading} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-200 disabled:opacity-40">{downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Download</button><button onClick={() => setDeleteTarget(selected)} disabled={!mutationsAllowed || deleting} className="rounded-lg border border-red-500/20 p-2 text-red-300 disabled:opacity-30" aria-label={`Delete ${selected.name}`}><Trash2 className="h-4 w-4" /></button></div></div>

          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Rows" value={selected.analysis.rowCount.toLocaleString()} /><Metric label="Columns" value={selected.analysis.columnCount.toLocaleString()} /><Metric label="Missing cells" value={selected.analysis.missingCellCount.toLocaleString()} /><Metric label="Duplicate rows" value={selected.analysis.duplicateRowCount.toLocaleString()} /></dl>

          <section aria-labelledby="dataset-columns-heading"><h3 id="dataset-columns-heading" className="font-semibold text-white">Column profile</h3><div className="mt-3 overflow-x-auto rounded-xl border border-white/10"><table className="min-w-full divide-y divide-white/10 text-left text-sm"><caption className="sr-only">Profile of columns in {selected.name}</caption><thead className="bg-black/30 text-xs uppercase tracking-wide text-gray-500"><tr><th scope="col" className="px-3 py-3">Column</th><th scope="col" className="px-3 py-3">Type</th><th scope="col" className="px-3 py-3 text-right">Missing</th><th scope="col" className="px-3 py-3 text-right">Unique</th><th scope="col" className="px-3 py-3">Numeric range</th><th scope="col" className="px-3 py-3 text-right">Outliers</th></tr></thead><tbody className="divide-y divide-white/5">{selected.analysis.columns.map((column) => <tr key={column.name}><th scope="row" className="whitespace-nowrap px-3 py-3 font-medium text-white">{column.name}</th><td className="px-3 py-3 capitalize text-gray-300">{column.inferredType}</td><td className="px-3 py-3 text-right text-gray-400">{column.missingCount.toLocaleString()}</td><td className="px-3 py-3 text-right text-gray-400">{column.uniqueCount.toLocaleString()}</td><td className="whitespace-nowrap px-3 py-3 text-gray-400">{column.numeric ? `${column.numeric.min} – ${column.numeric.max}` : 'Not numeric'}</td><td className="px-3 py-3 text-right text-gray-400">{column.outlierCount ?? '—'}</td></tr>)}</tbody></table></div></section>

          <section aria-labelledby="dataset-preview-heading"><div className="flex flex-wrap items-end justify-between gap-2"><div><h3 id="dataset-preview-heading" className="font-semibold text-white">Bounded preview</h3><p className="mt-1 text-xs text-gray-500">Showing {selected.analysis.preview.length} of {selected.analysis.rowCount.toLocaleString()} rows. Cells are rendered as inert text.</p></div>{selected.analysis.previewTruncatedCellCount ? <span className="text-xs text-amber-300">{selected.analysis.previewTruncatedCellCount} preview cells truncated</span> : null}</div><div className="mt-3 max-h-[480px] overflow-auto rounded-xl border border-white/10"><table className="min-w-max divide-y divide-white/10 text-left text-sm"><caption className="sr-only">Bounded data preview for {selected.name}</caption><thead className="sticky top-0 z-10 bg-[#11131d] text-xs text-gray-400"><tr><th scope="col" className="px-3 py-3 text-right">#</th>{selected.analysis.columns.map((column) => <th key={column.name} scope="col" className="max-w-80 px-3 py-3 font-semibold text-white">{column.name}</th>)}</tr></thead><tbody className="divide-y divide-white/5">{selected.analysis.preview.map((row, rowIndex) => <tr key={rowIndex}><th scope="row" className="bg-black/20 px-3 py-3 text-right font-normal text-gray-600">{rowIndex + 1}</th>{selected.analysis.columns.map((column) => <td key={column.name} className={`max-w-80 whitespace-pre-wrap break-words px-3 py-3 align-top ${row[column.name] === null ? 'italic text-gray-600' : 'text-gray-300'}`}>{cellText(row[column.name])}</td>)}</tr>)}</tbody></table>{!selected.analysis.preview.length ? <p className="p-6 text-center text-sm text-gray-500">This dataset has no data rows to preview.</p> : null}</div></section>

          <div className="grid gap-5 xl:grid-cols-2"><section className="rounded-xl border border-white/10 bg-black/20 p-4" aria-labelledby="dataset-suggestions-heading"><h3 id="dataset-suggestions-heading" className="font-semibold text-white">Quality suggestions</h3><ul className="mt-3 space-y-2 text-sm text-gray-400">{selected.analysis.suggestions.map((suggestion, index) => <li key={`${index}:${suggestion}`} className="flex gap-2"><span aria-hidden="true" className="text-primary">•</span><span>{suggestion}</span></li>)}{!selected.analysis.suggestions.length ? <li>No suggestions were returned.</li> : null}</ul></section><section className="rounded-xl border border-white/10 bg-black/20 p-4" aria-labelledby="dataset-correlations-heading"><h3 id="dataset-correlations-heading" className="font-semibold text-white">Numeric correlations</h3><div className="mt-3 space-y-2">{selected.analysis.correlations.map((correlation) => <div key={`${correlation.left}:${correlation.right}`} className="flex items-center justify-between gap-3 rounded-lg bg-white/5 p-3 text-sm"><span className="min-w-0 truncate text-gray-300">{correlation.left} ↔ {correlation.right}</span><span className="shrink-0 font-mono text-cyan-300">{correlation.coefficient.toFixed(3)}</span></div>)}{!selected.analysis.correlations.length ? <p className="text-sm text-gray-500">No supported numeric correlations were reported.</p> : null}</div></section></div>

          <section className="rounded-xl border border-primary/20 bg-primary/5 p-5" aria-labelledby="derive-dataset-heading"><div><h3 id="derive-dataset-heading" className="flex items-center gap-2 font-semibold text-white"><GitBranchPlus className="h-4 w-4 text-primary" />Create a derived copy</h3><p className="mt-1 text-sm text-gray-500">The source remains unchanged. A new owner-scoped dataset and analysis record will be created.</p></div><label className="mt-4 block text-sm text-gray-300">Derived dataset name<input value={deriveName} onChange={(event) => setDeriveName(event.target.value)} maxLength={200} disabled={!mutationsAllowed || deriving} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white disabled:opacity-50" /></label><fieldset disabled={!mutationsAllowed || deriving} className="mt-4 grid gap-3 sm:grid-cols-2"><legend className="sr-only">Dataset cleanup transforms</legend><TransformCheckbox label="Trim surrounding whitespace in strings" checked={transforms.trimStrings} onChange={(checked) => setTransforms({ ...transforms, trimStrings: checked })} /><TransformCheckbox label="Drop duplicate rows" checked={transforms.dropDuplicateRows} onChange={(checked) => setTransforms({ ...transforms, dropDuplicateRows: checked })} /><TransformCheckbox label="Drop rows with missing values" checked={transforms.dropRowsWithMissingValues} onChange={(checked) => setTransforms({ ...transforms, dropRowsWithMissingValues: checked })} />{selected.format === 'csv' ? <TransformCheckbox label="Escape spreadsheet formulas in CSV" checked={transforms.escapeSpreadsheetFormulas} onChange={(checked) => setTransforms({ ...transforms, escapeSpreadsheetFormulas: checked })} /> : <p className="rounded-lg border border-white/10 bg-black/20 p-3 text-sm text-gray-500">Spreadsheet-formula escaping applies only to CSV files.</p>}</fieldset>{!hasSelectedTransform ? <p className="mt-3 text-sm text-amber-300">Select at least one cleanup transform.</p> : null}{deriveError ? <p role="alert" className="mt-3 rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{deriveError}</p> : null}<div className="mt-4 flex justify-end"><button onClick={() => void derive()} disabled={!mutationsAllowed || deriving || !deriveName.trim() || !hasSelectedTransform} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40">{deriving ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitBranchPlus className="h-4 w-4" />}{deriving ? 'Creating…' : 'Create derived dataset'}</button></div></section>
        </div> : <div className="flex min-h-80 items-center justify-center text-center text-gray-500"><div><Database className="mx-auto h-10 w-10" /><p className="mt-3">Select a saved dataset or upload a new one.</p></div></div>}
      </main>
    </div>

    <ConfirmDialog isOpen={Boolean(deleteTarget)} title="Delete Dataset" message={`Delete ${deleteTarget?.name || 'this dataset'} and its persisted file and analysis? The backend may refuse if another retained dataset depends on it. This cannot be undone.`} confirmText={deleting ? 'Deleting…' : 'Delete Dataset'} isDestructive onConfirm={() => void deleteDataset()} onCancel={() => { if (!deleting) setDeleteTarget(undefined); }} />
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-white/10 bg-black/20 p-3"><dt className="text-xs text-gray-500">{label}</dt><dd className="mt-1 font-medium text-white">{value}</dd></div>;
}

function TransformCheckbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex items-start gap-3 rounded-lg border border-white/10 bg-black/20 p-3 text-sm text-gray-300"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" /><span>{label}</span></label>;
}
