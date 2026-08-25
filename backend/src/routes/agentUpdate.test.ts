import { Router } from 'express';
import { AgentService } from '@/services/agentService';
import { createAgentRouter } from './agent';

const ownerId = '64b000000000000000000001';
const agentId = '64b000000000000000000201';

function invoke(router: Router, body: unknown): Promise<{ status: number; body: any }> {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === '/:id' && entry.route.methods.patch);
  const handler = layer.route.stack[0].handle;
  return new Promise((resolve, reject) => {
    let status = 200;
    handler({
      body,
      params: { id: agentId },
      user: { userId: ownerId, email: 'owner@example.com', role: 'user' },
    }, {
      status(code: number) { status = code; return this; },
      json(responseBody: any) { resolve({ status, body: responseBody }); return this; },
    }, reject);
  });
}

describe('PATCH /agents/:id', () => {
  it('passes only authenticated owner/id/input to the update service', async () => {
    const updated = { _id: agentId, name: 'Updated' };
    const update = jest.fn().mockResolvedValue(updated);
    const router = createAgentRouter({ update } as unknown as AgentService);

    const response = await invoke(router, { name: 'Updated' });
    expect(update).toHaveBeenCalledWith(ownerId, agentId, { name: 'Updated' });
    expect(response).toEqual({ status: 200, body: { success: true, data: updated } });
  });
});

