import { Request, RequestHandler } from 'express';
import { getGpuStatus, GpuStatus, GpuUnavailableReason } from '@/services/gpuStatus';

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
export const MAX_HTTP_METRIC_SERIES = 250;
export const MAX_GPU_METRIC_DEVICES = 8;
const MEBIBYTE = 1024 * 1024;
const MAX_GPU_MEMORY_MIB = 16 * 1024 * 1024;
const GPU_CACHE_MS = 15_000;
const SAFE_METRIC_MOUNTS = new Set([
  '', '/api/:version/auth', '/api/:version/chat', '/api/:version/user', '/api/:version/ollama',
  '/api/:version/provider', '/api/:version/runtime', '/api/:version/settings/providers',
  '/api/:version/settings/runtime', '/api/:version/agents', '/api/:version/documents',
  '/api/:version/models', '/api/:version/system', '/api/:version/projects', '/api/:version/code',
  '/api/:version/knowledge', '/api/:version/repositories', '/api/:version/workflows',
  '/api/:version/datasets', '/api/:version/benchmarks', '/api/:version/notebooks',
]);
const GPU_REASONS = new Set<GpuUnavailableReason>([
  'nvidia-smi-not-found', 'probe-timeout', 'driver-unavailable', 'malformed-output', 'no-nvidia-gpu',
]);

type DependencyName = 'mongodb' | 'redis';
type GpuMetricReason = GpuUnavailableReason | 'probe-failed';

export interface MetricsOptions {
  collectDependencies?: () => Partial<Record<DependencyName, boolean>>;
  probeGpu?: () => Promise<GpuStatus>;
  gpuCacheMs?: number;
  now?: () => number;
}

interface GpuMetricSample {
  available: boolean;
  reason?: GpuMetricReason;
  gpus: GpuStatus['gpus'];
}

interface DurationMetric {
  count: number;
  sum: number;
  buckets: number[];
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function boundedKey<T>(values: Map<string, T>, candidate: string, overflow: string): string {
  if (values.has(candidate) || values.size < MAX_HTTP_METRIC_SERIES - 1) return candidate;
  return overflow;
}

export function normalizeMetricPath(value: string): string {
  if (!value.startsWith('/') || value.length > 200) return '/unknown';
  const normalized = value.split('/').map((segment) => {
    if (/^[a-f\d]{24}$/i.test(segment)
      || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)
      || /^\d+$/.test(segment)) return ':id';
    return segment;
  }).join('/');
  return /^[\x20-\x7e]*$/.test(normalized) ? normalized : '/unknown';
}

export function metricRequestPath(req: Request, statusCode: number): string {
  if (statusCode === 404) return '/not-found';
  const routePath = req.route?.path;
  if (typeof routePath !== 'string' || !routePath.startsWith('/')) return '/unknown';
  const originalSegments = req.originalUrl.split('?')[0].split('/').filter(Boolean);
  const routeSegments = routePath.split('/').filter(Boolean);
  if (routeSegments.length > originalSegments.length) return '/unknown';
  const mount = `/${originalSegments.slice(0, originalSegments.length - routeSegments.length).join('/')}`
    .replace(/^\/$/, '');
  const allowlistMount = mount.replace(/^\/api\/v\d+(?=\/|$)/, '/api/:version');
  if (!SAFE_METRIC_MOUNTS.has(allowlistMount)) return '/unknown';
  const safeRoute = routeSegments.map((segment) => {
    if (segment.startsWith(':')) return ':id';
    return /^[a-z0-9._-]+$/i.test(segment) ? segment : undefined;
  });
  if (safeRoute.some((segment) => segment === undefined)) return '/unknown';
  const value = `${mount}/${safeRoute.join('/')}`.replace(/\/+/g, '/');
  return value.length <= 200 ? value : '/unknown';
}

function validGpuSample(status: GpuStatus): GpuMetricSample {
  if (!status.available) {
    const reason = status.reason && GPU_REASONS.has(status.reason) ? status.reason : 'probe-failed';
    return { available: false, reason, gpus: [] };
  }
  const indices = new Set<number>();
  const valid = status.gpus.length > 0 && status.gpus.length <= MAX_GPU_METRIC_DEVICES
    && status.gpus.every((gpu) => {
      const numbers = [gpu.memoryTotalMiB, gpu.memoryUsedMiB, gpu.memoryFreeMiB,
        gpu.utilizationPercent, gpu.temperatureC];
      const indexValid = Number.isInteger(gpu.index) && gpu.index >= 0 && gpu.index < MAX_GPU_METRIC_DEVICES
        && !indices.has(gpu.index);
      indices.add(gpu.index);
      return indexValid && numbers.every(Number.isFinite)
        && gpu.memoryTotalMiB > 0 && gpu.memoryUsedMiB >= 0
        && gpu.memoryTotalMiB <= MAX_GPU_MEMORY_MIB
        && gpu.memoryUsedMiB <= gpu.memoryTotalMiB
        && gpu.memoryFreeMiB === gpu.memoryTotalMiB - gpu.memoryUsedMiB
        && gpu.utilizationPercent >= 0 && gpu.utilizationPercent <= 100
        && gpu.temperatureC >= 0 && gpu.temperatureC <= 150;
    });
  return valid
    ? { available: true, gpus: [...status.gpus].sort((left, right) => left.index - right.index) }
    : { available: false, reason: 'malformed-output', gpus: [] };
}

export function createMetrics(options: MetricsOptions = {}): { middleware: RequestHandler; handler: RequestHandler } {
  const requests = new Map<string, number>();
  const durations = new Map<string, DurationMetric>();
  const collectDependencies = options.collectDependencies ?? (() => ({}));
  const probeGpu = options.probeGpu ?? getGpuStatus;
  const cacheMs = options.gpuCacheMs ?? GPU_CACHE_MS;
  const now = options.now ?? Date.now;
  let gpuCache: { expiresAt: number; sample: GpuMetricSample } | undefined;
  let gpuInFlight: Promise<GpuMetricSample> | undefined;

  const sampleGpu = async (): Promise<GpuMetricSample> => {
    const time = now();
    if (gpuCache && gpuCache.expiresAt > time) return gpuCache.sample;
    if (!gpuInFlight) {
      gpuInFlight = Promise.resolve()
        .then(() => probeGpu())
        .then(validGpuSample)
        .catch(() => ({ available: false, reason: 'probe-failed' as const, gpus: [] }))
        .then((sample) => {
          gpuCache = { expiresAt: now() + Math.max(1_000, cacheMs), sample };
          return sample;
        })
        .finally(() => { gpuInFlight = undefined; });
    }
    return gpuInFlight;
  };

  const middleware: RequestHandler = (req, res, next) => {
    if (req.path === '/metrics') return next();
    const started = process.hrtime.bigint();
    res.once('finish', () => {
      const method = METHODS.has(req.method) ? req.method : 'OTHER';
      const path = metricRequestPath(req, res.statusCode);
      const status = String(res.statusCode);
      const requestKey = boundedKey(
        requests,
        JSON.stringify([method, path, status]),
        JSON.stringify(['OTHER', '/overflow', 'other'])
      );
      requests.set(requestKey, (requests.get(requestKey) ?? 0) + 1);
      const durationKey = boundedKey(
        durations,
        JSON.stringify([method, path]),
        JSON.stringify(['OTHER', '/overflow'])
      );
      const metric = durations.get(durationKey) ?? { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
      const seconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
      metric.count += 1;
      metric.sum += seconds;
      BUCKETS.forEach((limit, index) => { if (seconds <= limit) metric.buckets[index] += 1; });
      durations.set(durationKey, metric);
    });
    next();
  };

  const handler: RequestHandler = (_req, res, next) => { void (async () => {
    const lines = [
      '# HELP kfive_http_requests_total Completed HTTP requests.',
      '# TYPE kfive_http_requests_total counter',
    ];
    for (const [key, value] of [...requests].sort(([left], [right]) => left.localeCompare(right))) {
      const [method, path, status] = JSON.parse(key) as string[];
      lines.push(`kfive_http_requests_total{method="${escapeLabel(method)}",path="${escapeLabel(path)}",status_code="${status}"} ${value}`);
    }
    lines.push('# HELP kfive_http_request_duration_seconds HTTP request duration.', '# TYPE kfive_http_request_duration_seconds histogram');
    for (const [key, metric] of [...durations].sort(([left], [right]) => left.localeCompare(right))) {
      const [method, path] = JSON.parse(key) as string[];
      const labels = `method="${escapeLabel(method)}",path="${escapeLabel(path)}"`;
      BUCKETS.forEach((limit, index) => lines.push(`kfive_http_request_duration_seconds_bucket{${labels},le="${limit}"} ${metric.buckets[index]}`));
      lines.push(`kfive_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${metric.count}`);
      lines.push(`kfive_http_request_duration_seconds_sum{${labels}} ${metric.sum}`);
      lines.push(`kfive_http_request_duration_seconds_count{${labels}} ${metric.count}`);
    }
    const memory = process.memoryUsage();
    let dependencies: Partial<Record<DependencyName, boolean>> = {};
    try { dependencies = collectDependencies(); } catch { dependencies = {}; }
    lines.push(
      '# HELP kfive_dependency_available Whether a backend dependency is currently available to this process.',
      '# TYPE kfive_dependency_available gauge',
      `kfive_dependency_available{dependency="mongodb"} ${dependencies.mongodb === true ? 1 : 0}`,
      `kfive_dependency_available{dependency="redis"} ${dependencies.redis === true ? 1 : 0}`
    );
    const gpu = await sampleGpu();
    lines.push(
      '# HELP kfive_gpu_probe_available Whether the backend process can currently sample a supported NVIDIA GPU.',
      '# TYPE kfive_gpu_probe_available gauge',
      `kfive_gpu_probe_available ${gpu.available ? 1 : 0}`,
      '# HELP kfive_gpu_devices Number of validated GPU devices visible to the backend process.',
      '# TYPE kfive_gpu_devices gauge',
      `kfive_gpu_devices ${gpu.gpus.length}`
    );
    if (!gpu.available) {
      lines.push(
        '# HELP kfive_gpu_probe_status Fixed reason for an unavailable GPU probe.',
        '# TYPE kfive_gpu_probe_status gauge',
        `kfive_gpu_probe_status{reason="${gpu.reason ?? 'probe-failed'}"} 1`
      );
    } else {
      const totals = gpu.gpus.reduce((value, item) => ({
        total: value.total + item.memoryTotalMiB,
        used: value.used + item.memoryUsedMiB,
        free: value.free + item.memoryFreeMiB,
      }), { total: 0, used: 0, free: 0 });
      lines.push(
        '# HELP kfive_gpu_vram_bytes Aggregate validated GPU memory visible to the backend process.',
        '# TYPE kfive_gpu_vram_bytes gauge',
        `kfive_gpu_vram_bytes{state="total"} ${totals.total * MEBIBYTE}`,
        `kfive_gpu_vram_bytes{state="used"} ${totals.used * MEBIBYTE}`,
        `kfive_gpu_vram_bytes{state="free"} ${totals.free * MEBIBYTE}`,
        '# HELP kfive_gpu_memory_bytes Validated memory for a bounded numeric GPU index.',
        '# TYPE kfive_gpu_memory_bytes gauge',
        '# HELP kfive_gpu_utilization_ratio Validated utilization ratio for a bounded numeric GPU index.',
        '# TYPE kfive_gpu_utilization_ratio gauge',
        '# HELP kfive_gpu_temperature_celsius Validated temperature for a bounded numeric GPU index.',
        '# TYPE kfive_gpu_temperature_celsius gauge'
      );
      for (const item of gpu.gpus) {
        lines.push(
          `kfive_gpu_memory_bytes{gpu="${item.index}",state="total"} ${item.memoryTotalMiB * MEBIBYTE}`,
          `kfive_gpu_memory_bytes{gpu="${item.index}",state="used"} ${item.memoryUsedMiB * MEBIBYTE}`,
          `kfive_gpu_memory_bytes{gpu="${item.index}",state="free"} ${item.memoryFreeMiB * MEBIBYTE}`,
          `kfive_gpu_utilization_ratio{gpu="${item.index}"} ${item.utilizationPercent / 100}`,
          `kfive_gpu_temperature_celsius{gpu="${item.index}"} ${item.temperatureC}`
        );
      }
    }
    lines.push(
      '# HELP process_resident_memory_bytes Resident memory size in bytes.',
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${memory.rss}`,
      '# HELP process_heap_used_bytes Process heap used in bytes.',
      '# TYPE process_heap_used_bytes gauge',
      `process_heap_used_bytes ${memory.heapUsed}`,
      '# HELP process_uptime_seconds Process uptime in seconds.',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${process.uptime()}`,
      ''
    );
    res.status(200).type('text/plain; version=0.0.4; charset=utf-8').send(lines.join('\n'));
  })().catch(next); };

  return { middleware, handler };
}
