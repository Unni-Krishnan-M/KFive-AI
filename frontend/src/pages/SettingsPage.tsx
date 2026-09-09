import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertCircle, Brain, CheckCircle2, Cloud, Database, HardDrive, Laptop,
  Loader2, Network, RefreshCw, RotateCw, Server, Settings, ShieldCheck, XCircle,
} from 'lucide-react';
import { settingsApi } from '@/services/api';
import {
  ConnectionState, normalizeModels, normalizeRuntimeSettings, readableApiError,
  RuntimeService, RuntimeSettings, unwrapApiData,
} from '@/services/runtimeSettings';

type TestResult = { connected: boolean; message: string; latencyMs?: number };
const emptyRuntime: RuntimeSettings = normalizeRuntimeSettings({});

const statusStyles: Record<ConnectionState, string> = {
  online: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  offline: 'border-red-500/30 bg-red-500/10 text-red-300',
  degraded: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  disabled: 'border-gray-500/30 bg-gray-500/10 text-gray-400',
  unknown: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
};

function StatusBadge({ status }: { status: ConnectionState }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${statusStyles[status]}`}>
      {status === 'online' ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
      {status === 'offline' ? <XCircle className="h-3.5 w-3.5" /> : null}
      {status === 'unknown' || status === 'degraded' ? <AlertCircle className="h-3.5 w-3.5" /> : null}
      {status === 'disabled' ? <span className="h-2 w-2 rounded-full bg-current" /> : null}
      {status}
    </span>
  );
}

function LocationBadge({ location }: { location: RuntimeService['location'] }) {
  const Icon = location === 'remote' ? Cloud : location === 'local' ? Laptop : Network;
  return <span className="inline-flex items-center gap-1.5 text-xs font-medium capitalize text-gray-400"><Icon className="h-3.5 w-3.5" />{location}</span>;
}

function RestartBadge() {
  return <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-300"><RotateCw className="h-3 w-3" />Restart required</span>;
}

function responseRecord(payload: unknown): Record<string, unknown> {
  const value = unwrapApiData(payload);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export default function SettingsPage() {
  const [runtime, setRuntime] = useState<RuntimeSettings>(emptyRuntime);
  const [models, setModels] = useState<string[]>([]);
  const [providerStatus, setProviderStatus] = useState<ConnectionState>('unknown');
  const [loading, setLoading] = useState(true);
  const [runtimeError, setRuntimeError] = useState<string>();
  const [providerError, setProviderError] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult>();
  const loadRequestRef = useRef(0);

  const loadRuntime = useCallback(async () => {
    const request = ++loadRequestRef.current;
    const current = () => loadRequestRef.current === request;
    setLoading(true);
    setRuntimeError(undefined);
    setProviderError(undefined);
    setTestResult(undefined);
    const runtimeTask = settingsApi.getRuntime().then((response) => {
      if (!current()) return;
      const nextRuntime = normalizeRuntimeSettings(response.data);
      setRuntime(nextRuntime);
      setProviderStatus(nextRuntime.provider.status);
      setLoading(false);
    }).catch((error) => {
      if (!current()) return;
      setRuntime(emptyRuntime);
      setRuntimeError(readableApiError(error, 'Runtime configuration could not be loaded.'));
      setLoading(false);
    });
    const healthTask = settingsApi.getProviderHealth().then((response) => {
      if (!current()) return;
      const health = responseRecord(response.data);
      const rawStatus = typeof health.status === 'string' ? health.status.toLowerCase() : '';
      const healthy = rawStatus === 'healthy' || rawStatus === 'online' || rawStatus === 'connected';
      setProviderStatus(healthy ? 'online' : 'offline');
      if (!healthy) setProviderError('The configured AI provider reported that it is unavailable.');
    }).catch((error) => {
      if (!current()) return;
      setProviderStatus('offline');
      setProviderError(readableApiError(error, 'The configured AI provider is unavailable.'));
    });
    const modelsTask = settingsApi.getProviderModels().then((response) => {
      if (current()) setModels(normalizeModels(response.data));
    }).catch(() => {
      if (current()) setModels([]);
    });
    await Promise.allSettled([runtimeTask, healthTask, modelsTask]);
  }, []);

  useEffect(() => {
    void loadRuntime();
    return () => { loadRequestRef.current += 1; };
  }, [loadRuntime]);

  const testProvider = async () => {
    setTesting(true);
    setTestResult(undefined);
    try {
      const response = await settingsApi.testProvider();
      const result = responseRecord(response.data);
      const connected = result.connected === true || result.status === 'healthy';
      setTestResult({
        connected,
        latencyMs: typeof result.latencyMs === 'number' ? result.latencyMs : undefined,
        message: typeof result.message === 'string' ? result.message : connected ? 'Connection succeeded.' : 'Connection failed.',
      });
      setProviderStatus(connected ? 'online' : 'offline');
    } catch (error) {
      setProviderStatus('offline');
      setTestResult({ connected: false, message: readableApiError(error, 'Connection test failed.') });
    } finally {
      setTesting(false);
    }
  };

  const dependencyMessages = runtime.missingDependencies.length
    ? runtime.missingDependencies
    : Array.from(new Set([
      ...runtime.services.filter((service) => !service.configured).map((service) => `${service.name} is not configured.`),
      ...(!runtime.provider.configured ? [`${runtime.provider.name} is not configured.`] : []),
    ]));

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="mx-auto max-w-6xl space-y-8 p-6 md:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight text-white"><Settings className="h-8 w-8 text-primary" />Runtime settings</h1>
          <p className="max-w-2xl text-gray-400">Live deployment and dependency information reported by the KFive backend. Secrets are never displayed here.</p>
        </div>
        <button type="button" onClick={() => void loadRuntime()} disabled={loading} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 text-sm font-medium text-white transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh
        </button>
      </div>

      {runtimeError ? <div role="alert" className="flex gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-red-200"><AlertCircle className="mt-0.5 h-5 w-5 shrink-0" /><div><p className="font-medium">Backend runtime settings are unavailable</p><p className="mt-1 text-sm text-red-200/80">{runtimeError}</p></div></div> : null}

      <section className="grid gap-4 md:grid-cols-3">
        {(['local', 'hybrid', 'remote'] as const).map((mode) => {
          const Icon = mode === 'local' ? Laptop : mode === 'hybrid' ? Network : Cloud;
          const selected = runtime.mode === mode;
          return <div key={mode} className={`rounded-2xl border p-5 transition-colors ${selected ? 'border-primary/50 bg-primary/10' : 'border-white/10 bg-white/5'}`}>
            <div className="flex items-center justify-between"><Icon className={`h-6 w-6 ${selected ? 'text-primary' : 'text-gray-500'}`} />{selected ? <span className="rounded-full bg-primary/20 px-2.5 py-1 text-xs font-semibold text-primary">Active</span> : null}</div>
            <h2 className="mt-4 text-lg font-semibold capitalize text-white">{mode} mode</h2>
            <p className="mt-1 text-sm text-gray-400">{mode === 'local' ? 'Services are hosted on this machine.' : null}{mode === 'hybrid' ? 'Local and remote services are combined.' : null}{mode === 'remote' ? 'Services run independently of this machine.' : null}</p>
          </div>;
        })}
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="flex flex-col gap-5 border-b border-white/10 pb-5 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-3"><div className="rounded-xl bg-purple-500/10 p-2.5"><Brain className="h-6 w-6 text-purple-300" /></div><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-semibold text-white">AI provider</h2><StatusBadge status={providerStatus} /></div><p className="mt-1 text-sm text-gray-400">The backend-selected provider; no silent fallback is performed.</p></div></div>
          <button type="button" onClick={() => void testProvider()} disabled={testing || loading || !runtime.provider.configured} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50">{testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Network className="h-4 w-4" />}Test connection</button>
        </div>

        <dl className="grid gap-5 py-5 sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-xs uppercase tracking-wide text-gray-500">Provider</dt><dd className="mt-1 font-medium text-white">{runtime.provider.name}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-gray-500">Location</dt><dd className="mt-1"><LocationBadge location={runtime.provider.location} /></dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-gray-500">Endpoint</dt><dd className="mt-1 break-all text-sm text-gray-300">{runtime.provider.url ?? 'Not reported by backend'}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-gray-500">Configuration changes</dt><dd className="mt-1">{runtime.provider.restartRequired ? <RestartBadge /> : runtime.provider.liveSwitchSupported ? <span className="text-sm text-emerald-300">Live switching supported</span> : <span className="text-sm text-gray-400">Backend-controlled</span>}</dd></div>
        </dl>

        {providerError ? <p role="alert" className="mb-4 text-sm text-red-300">AI provider: {providerError}</p> : null}
        {testResult ? <div role="status" className={`mb-4 rounded-xl border p-3 text-sm ${testResult.connected ? statusStyles.online : statusStyles.offline}`}><span className="font-medium">{testResult.message}</span>{testResult.latencyMs !== undefined ? <span className="ml-2 opacity-80">({testResult.latencyMs} ms)</span> : null}</div> : null}

        <div className="rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="flex items-center justify-between gap-3"><h3 className="font-medium text-white">Available models</h3><span className="text-xs text-gray-500">Reported by {runtime.provider.name}</span></div>
          {models.length ? <div className="mt-3 flex flex-wrap gap-2">{models.map((model) => <span key={model} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-gray-200">{model}</span>)}</div> : <p className="mt-2 text-sm text-gray-400">No models were reported. Check the provider connection and model installation.</p>}
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="flex items-center gap-3 border-b border-white/10 pb-5"><Server className="h-6 w-6 text-cyan-300" /><div><h2 className="text-xl font-semibold text-white">Service topology</h2><p className="mt-1 text-sm text-gray-400">Configured infrastructure and whether each service is local or remote.</p></div></div>
        {runtime.services.length ? <div className="mt-5 grid gap-4 md:grid-cols-2">{runtime.services.map((service) => (
          <article key={service.id} className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="flex items-start justify-between gap-3"><div className="flex items-center gap-3"><div className="rounded-lg bg-cyan-500/10 p-2">{service.id.toLowerCase().includes('mongo') || service.id.toLowerCase().includes('redis') ? <Database className="h-5 w-5 text-cyan-300" /> : service.id.toLowerCase().includes('document') ? <HardDrive className="h-5 w-5 text-cyan-300" /> : <Server className="h-5 w-5 text-cyan-300" />}</div><div><h3 className="font-medium text-white">{service.name}</h3><LocationBadge location={service.location} /></div></div><StatusBadge status={service.status} /></div>
            <p className="mt-3 break-all text-sm text-gray-400">{service.url ?? (service.configured ? 'Endpoint hidden or not reported' : 'Not configured')}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">{service.restartRequired ? <RestartBadge /> : <span className="text-xs text-emerald-300">Live configuration</span>}{service.message ? <span className="text-xs text-gray-400">{service.message}</span> : null}</div>
          </article>
        ))}</div> : <p className="mt-5 rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-gray-400">The backend did not report any service topology.</p>}
      </section>

      {dependencyMessages.length ? <section role="alert" className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6"><div className="flex gap-3"><AlertCircle className="mt-0.5 h-6 w-6 shrink-0 text-amber-300" /><div><h2 className="text-lg font-semibold text-amber-100">Unavailable dependencies</h2><p className="mt-1 text-sm text-amber-100/70">Features remain unavailable until these exact dependencies are configured:</p><ul className="mt-3 space-y-2 text-sm text-amber-100">{dependencyMessages.map((dependency) => <li key={dependency}>• {dependency}</li>)}</ul></div></div></section> : null}

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6"><div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-emerald-300" /><div><h2 className="text-lg font-semibold text-white">Configuration source of truth</h2><p className="mt-1 text-sm text-gray-400">Runtime infrastructure is read from server environment variables. This page does not pretend to save server settings or reveal credentials.</p>{runtime.restartRequired.length ? <div className="mt-4"><p className="text-sm font-medium text-amber-200">Changing these fields requires a backend restart:</p><div className="mt-2 flex flex-wrap gap-2">{runtime.restartRequired.map((field) => <code key={field} className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-xs text-amber-200">{field}</code>)}</div></div> : null}{runtime.note ? <p className="mt-3 text-sm text-gray-500">{runtime.note}</p> : null}</div></div></section>
    </motion.div>
  );
}
