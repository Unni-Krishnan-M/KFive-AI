import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Box, CheckCircle2, Cpu, Download, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiUrl } from '@/config/runtime';
import { getToken } from '@/utils/getToken';
import { modelApi } from '@/services/api';
import { formatBytes, ModelCatalog, normalizeModelCatalog } from '@/services/modelManager';
import { readableApiError, unwrapApiData } from '@/services/runtimeSettings';

interface GpuInfo {
  available: boolean;
  reason?: string;
  message?: string;
  gpus: Array<{ index: number; name: string; memoryTotalMiB?: number; memoryUsedMiB?: number; memoryFreeMiB?: number; utilizationPercent?: number; temperatureC?: number }>;
}

const emptyCatalog: ModelCatalog = { provider: 'unknown', modelScope: 'unknown', canPull: false, canDelete: false, models: [] };

export default function ModelsPage() {
  const [catalog, setCatalog] = useState<ModelCatalog>(emptyCatalog);
  const [gpu, setGpu] = useState<GpuInfo>({ available: false, gpus: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [pullModel, setPullModel] = useState('');
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<string>();
  const [deleteRequest, setDeleteRequest] = useState<{ model: string; token: string }>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    const [modelsResult, gpuResult] = await Promise.allSettled([modelApi.getCatalog(), modelApi.getGpuStatus()]);
    if (modelsResult.status === 'fulfilled') setCatalog(normalizeModelCatalog(modelsResult.value.data));
    else setError(readableApiError(modelsResult.reason, 'Model catalog is unavailable.'));
    if (gpuResult.status === 'fulfilled') {
      const data = unwrapApiData(gpuResult.value.data) as GpuInfo;
      setGpu({ available: data?.available === true, reason: data?.reason, message: data?.message, gpus: Array.isArray(data?.gpus) ? data.gpus : [] });
    } else {
      setGpu({ available: false, reason: 'probe-failed', message: readableApiError(gpuResult.reason, 'GPU status is unavailable.'), gpus: [] });
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const startPull = async () => {
    if (!pullModel.trim()) return;
    setPulling(true);
    setPullProgress('Starting pull…');
    try {
      const response = await fetch(apiUrl('/models/pull'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ model: pullModel.trim() }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error?.message || body?.message || `Pull failed with HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines.filter(Boolean)) {
          const event = JSON.parse(line);
          const progress = event.data || {};
          setPullProgress(progress.percent !== undefined ? `${progress.status || 'Downloading'} — ${progress.percent}%` : progress.status || event.type);
        }
        if (done) break;
      }
      toast.success(`Model ${pullModel.trim()} installed`);
      setPullModel('');
      await load();
    } catch (pullError) {
      toast.error(pullError instanceof Error ? pullError.message : 'Model pull failed');
    } finally {
      setPulling(false);
    }
  };

  const requestDelete = async (model: string) => {
    try {
      const response = await modelApi.requestDeleteConfirmation(model);
      const data = unwrapApiData(response.data) as { confirmationToken?: string };
      if (!data?.confirmationToken) throw new Error('Backend did not return a confirmation token.');
      setDeleteRequest({ model, token: data.confirmationToken });
    } catch (deleteError) {
      toast.error(readableApiError(deleteError, 'Delete confirmation failed.'));
    }
  };

  const confirmDelete = async () => {
    if (!deleteRequest) return;
    try {
      await modelApi.deleteModel(deleteRequest.model, deleteRequest.token);
      toast.success(`Deleted ${deleteRequest.model}`);
      setDeleteRequest(undefined);
      await load();
    } catch (deleteError) {
      toast.error(readableApiError(deleteError, 'Model deletion failed.'));
    }
  };

  return <div className="mx-auto max-w-6xl space-y-6 p-6 md:p-8">
    <div className="flex items-start justify-between gap-4">
      <div><h1 className="flex items-center gap-3 text-3xl font-bold text-white"><Box className="text-primary" />Models</h1><p className="mt-2 text-gray-400">Provider-reported models and measured local GPU availability. No hardware capability is assumed.</p></div>
      <button onClick={() => void load()} disabled={loading} className="rounded-xl border border-white/10 bg-white/5 p-2.5 text-gray-300 hover:bg-white/10"><RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} /></button>
    </div>

    {error ? <div role="alert" className="flex gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-red-200"><AlertCircle />{error}</div> : null}

    <section className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold text-white">Provider catalog</h2><p className="text-sm text-gray-400">{catalog.provider} · {catalog.modelScope} models</p></div><span className="rounded-full border border-white/10 px-3 py-1 text-xs text-gray-300">{catalog.models.length} models</span></div>
      {catalog.canPull ? <div className="mt-5 flex flex-col gap-3 rounded-xl border border-white/10 bg-black/20 p-4 sm:flex-row"><input value={pullModel} onChange={(event) => setPullModel(event.target.value)} placeholder="Model name, e.g. qwen2.5-coder:7b" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white" /><button onClick={() => void startPull()} disabled={pulling || !pullModel.trim()} className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 font-medium text-white disabled:opacity-50">{pulling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Pull model</button>{pullProgress ? <span className="self-center text-sm text-gray-400">{pullProgress}</span> : null}</div> : null}
      <div className="mt-5 grid gap-4 md:grid-cols-2">{catalog.models.map((model) => <article key={model.id} className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-white">{model.name}</h3><p className="mt-1 text-xs text-gray-500">{model.id}</p></div>{catalog.canDelete ? <button onClick={() => void requestDelete(model.id)} aria-label={`Delete ${model.name}`} className="rounded-lg p-2 text-gray-500 hover:bg-red-500/10 hover:text-red-300"><Trash2 className="h-4 w-4" /></button> : null}</div><dl className="mt-4 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-gray-500">Size</dt><dd className="text-gray-200">{formatBytes(model.sizeBytes)}</dd></div><div><dt className="text-gray-500">Context</dt><dd className="text-gray-200">{model.contextWindow?.toLocaleString() ?? 'Unavailable'}</dd></div></dl>{model.capabilities.length ? <div className="mt-3 flex flex-wrap gap-2">{model.capabilities.map((capability) => <span key={capability} className="rounded-md bg-primary/10 px-2 py-1 text-xs text-primary">{capability}</span>)}</div> : null}</article>)}</div>
      {!loading && !catalog.models.length ? <p className="mt-5 rounded-xl border border-white/10 p-4 text-sm text-gray-400">The configured provider reported no models.</p> : null}
    </section>

    <section className="rounded-2xl border border-white/10 bg-white/5 p-5"><h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Cpu className="text-cyan-300" />GPU status</h2>{gpu.available ? <div className="mt-4 grid gap-3 md:grid-cols-2">{gpu.gpus.map((item) => <div key={item.index} className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4"><div className="flex items-center gap-2 text-emerald-300"><CheckCircle2 className="h-4 w-4" />{item.name}</div><p className="mt-2 text-sm text-gray-300">VRAM {item.memoryUsedMiB ?? '?'} / {item.memoryTotalMiB ?? '?'} MiB · Free {item.memoryFreeMiB ?? '?'} MiB</p><p className="mt-1 text-xs text-gray-500">Utilization {item.utilizationPercent ?? '?'}% · Temperature {item.temperatureC ?? '?'}°C</p></div>)}</div> : <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-200">{gpu.message || `GPU unavailable${gpu.reason ? `: ${gpu.reason}` : ''}`}</div>}</section>

    {deleteRequest ? <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"><div className="max-w-md rounded-2xl border border-red-500/30 bg-[#11131d] p-6"><h2 className="text-xl font-semibold text-white">Delete model?</h2><p className="mt-2 text-sm text-gray-400">This will permanently remove <strong className="text-white">{deleteRequest.model}</strong> from the configured provider.</p><div className="mt-5 flex justify-end gap-3"><button onClick={() => setDeleteRequest(undefined)} className="rounded-lg border border-white/10 px-4 py-2 text-gray-300">Cancel</button><button onClick={() => void confirmDelete()} className="rounded-lg bg-red-600 px-4 py-2 font-medium text-white">Confirm delete</button></div></div></div> : null}
  </div>;
}
