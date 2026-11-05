import express from 'express';
import { createMetrics, metricRequestPath } from './metrics';
import { GpuStatus } from '@/services/gpuStatus';
import { Request } from 'express';

async function scrape(options: Parameters<typeof createMetrics>[0]): Promise<string> {
  const app = express();
  const metrics = createMetrics(options);
  app.use(metrics.middleware);
  app.get('/metrics', metrics.handler);
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to TCP.');
    const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    expect(response.status).toBe(200);
    return response.text();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('subsystem and GPU Prometheus metrics', () => {
  it('retains safe route templates for every supported numeric API version', () => {
    const request = {
      originalUrl: '/api/v2/auth/login?token=must-not-appear',
      route: { path: '/login' },
    } as Request;

    expect(metricRequestPath(request, 401)).toBe('/api/v2/auth/login');
  });

  it('exports bounded dependency states and an explicit unavailable GPU reason', async () => {
    const gpu: GpuStatus = {
      available: false,
      reason: 'nvidia-smi-not-found',
      message: 'not installed',
      gpus: [],
      sampledAt: new Date(0).toISOString(),
    };
    const body = await scrape({
      collectDependencies: () => ({ mongodb: true, redis: false }),
      probeGpu: async () => gpu,
    });

    expect(body).toContain('kfive_dependency_available{dependency="mongodb"} 1');
    expect(body).toContain('kfive_dependency_available{dependency="redis"} 0');
    expect(body).toContain('kfive_gpu_probe_available 0');
    expect(body).toContain('kfive_gpu_devices 0');
    expect(body).toContain('kfive_gpu_probe_status{reason="nvidia-smi-not-found"} 1');
    expect(body).not.toContain('not installed');
    expect((body.match(/^kfive_dependency_available\{/gm) || [])).toHaveLength(2);
    expect(body).not.toContain('kfive_gpu_utilization_ratio{');
  });

  it('exports aggregate and per-index GPU utilization, temperature, and VRAM without identity labels', async () => {
    const gpu: GpuStatus = {
      available: true,
      message: 'available',
      sampledAt: new Date(0).toISOString(),
      gpus: [{
        index: 0, name: 'Secret model name', uuid: 'GPU-secret-uuid', driverVersion: 'secret-driver',
        memoryTotalMiB: 8192, memoryUsedMiB: 2048, memoryFreeMiB: 6144,
        utilizationPercent: 37, temperatureC: 55,
      }],
      summary: { deviceCount: 1, totalVramMiB: 8192, usedVramMiB: 2048, freeVramMiB: 6144 },
    };
    const body = await scrape({ collectDependencies: () => ({}), probeGpu: async () => gpu });

    expect(body).toContain('kfive_gpu_probe_available 1');
    expect(body).toContain('kfive_gpu_devices 1');
    expect(body).toContain('kfive_gpu_utilization_ratio{gpu="0"} 0.37');
    expect(body).toContain('kfive_gpu_temperature_celsius{gpu="0"} 55');
    expect(body).toContain('kfive_gpu_memory_bytes{gpu="0",state="used"} 2147483648');
    expect(body).toContain('kfive_gpu_vram_bytes{state="free"} 6442450944');
    expect(body).not.toContain('Secret model name');
    expect(body).not.toContain('GPU-secret-uuid');
    expect(body).not.toContain('secret-driver');
  });

  it('single-flights overlapping GPU probes, caches them, and refreshes after expiry', async () => {
    let currentTime = 1_000;
    let resolveFirst!: (status: GpuStatus) => void;
    let signalProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => { signalProbeStarted = resolve; });
    const firstProbe = new Promise<GpuStatus>((resolve) => { resolveFirst = resolve; });
    const unavailable: GpuStatus = {
      available: false, reason: 'no-nvidia-gpu', message: 'none', gpus: [],
      sampledAt: new Date(0).toISOString(),
    };
    const probeGpu = jest.fn()
      .mockImplementationOnce(() => {
        signalProbeStarted();
        return firstProbe;
      })
      .mockResolvedValue(unavailable);
    const app = express();
    const metrics = createMetrics({ probeGpu, gpuCacheMs: 60_000, now: () => currentTime });
    app.get('/metrics', metrics.handler);
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind to TCP.');
      const url = `http://127.0.0.1:${address.port}/metrics`;
      const pending = [fetch(url), fetch(url), fetch(url)];
      await probeStarted;
      expect(probeGpu).toHaveBeenCalledTimes(1);
      resolveFirst(unavailable);
      const responses = await Promise.all(pending);
      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(probeGpu).toHaveBeenCalledTimes(1);
      expect((await fetch(url)).status).toBe(200);
      expect(probeGpu).toHaveBeenCalledTimes(1);
      currentTime += 60_001;
      expect((await fetch(url)).status).toBe(200);
      expect(probeGpu).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('fails malformed and rejected probes closed without exposing raw diagnostics', async () => {
    const rejected = await scrape({
      probeGpu: async () => { throw new Error('secret raw probe diagnostic'); },
    });
    expect(rejected).toContain('kfive_gpu_probe_available 0');
    expect(rejected).toContain('kfive_gpu_probe_status{reason="probe-failed"} 1');
    expect(rejected).not.toContain('secret raw probe diagnostic');

    const malformed = await scrape({ probeGpu: async () => ({
      available: true, message: 'bad', sampledAt: new Date(0).toISOString(),
      summary: { deviceCount: 1, totalVramMiB: 1, usedVramMiB: 2, freeVramMiB: 0 },
      gpus: [{ index: 99, name: 'secret', uuid: 'secret', driverVersion: 'secret',
        memoryTotalMiB: 1, memoryUsedMiB: 2, memoryFreeMiB: 0, utilizationPercent: 101, temperatureC: 999 }],
    }) });
    expect(malformed).toContain('kfive_gpu_probe_status{reason="malformed-output"} 1');
    expect(malformed).not.toContain('kfive_gpu_memory_bytes{');
    expect(malformed).not.toContain('secret');

    const overflowing = await scrape({ probeGpu: async () => ({
      available: true, message: 'overflow', sampledAt: new Date(0).toISOString(),
      summary: { deviceCount: 1, totalVramMiB: 1e308, usedVramMiB: 0, freeVramMiB: 1e308 },
      gpus: [{ index: 0, name: 'gpu', uuid: 'uuid', driverVersion: 'driver',
        memoryTotalMiB: 1e308, memoryUsedMiB: 0, memoryFreeMiB: 1e308,
        utilizationPercent: 0, temperatureC: 0 }],
    }) });
    expect(overflowing).toContain('kfive_gpu_probe_status{reason="malformed-output"} 1');
    expect(overflowing).not.toContain('Infinity');
  });
});
