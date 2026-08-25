import { Router } from 'express';
import { createSystemRouter } from './system';

function invoke(router: Router, path: string): Promise<{ status: number; body: any }> {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === path && entry.route.methods.get);
  const handler = layer.route.stack[0].handle;
  return new Promise((resolve, reject) => {
    let status = 200;
    handler({}, {
      status(code: number) { status = code; return this; },
      json(body: any) { resolve({ status, body }); return this; },
    }, reject);
  });
}

describe('system routes', () => {
  it('returns injected GPU status', async () => {
    const gpu = {
      available: true,
      message: 'GPU available.',
      gpus: [],
      summary: { deviceCount: 1, totalVramMiB: 8192, usedVramMiB: 1024, freeVramMiB: 7168 },
      sampledAt: '2026-01-01T00:00:00.000Z',
    };
    const response = await invoke(createSystemRouter(async () => gpu), '/gpu');
    expect(response).toEqual({ status: 200, body: { success: true, data: gpu } });
  });

  it('uses 503 with a concrete unavailability reason', async () => {
    const gpu = {
      available: false,
      reason: 'nvidia-smi-not-found' as const,
      message: 'nvidia-smi is not installed.',
      gpus: [],
      sampledAt: '2026-01-01T00:00:00.000Z',
    };
    const response = await invoke(createSystemRouter(async () => gpu), '/gpu');
    expect(response).toEqual({ status: 503, body: { success: false, data: gpu } });
  });
});

