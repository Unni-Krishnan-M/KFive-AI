import { BullMqNotebookQueueDispatcher, notebookJobId, parseHeartbeat } from './notebookQueue';

describe('notebook queue dispatcher', () => {
  it('uses an opaque deterministic job id and a single-attempt job', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const queue = { getJob: jest.fn().mockResolvedValue(null), add };
    const dispatcher = new BullMqNotebookQueueDispatcher(() => queue as any, () => ({ publish: jest.fn(), get: jest.fn() }) as any);
    await dispatcher.enqueue('64b000000000000000000301');
    expect(notebookJobId('64b000000000000000000301')).toBe('notebook-64b000000000000000000301');
    expect(add).toHaveBeenCalledWith('execute', { runId: '64b000000000000000000301' },
      expect.objectContaining({ jobId: 'notebook-64b000000000000000000301', attempts: 1 }));
  });

  it('does not duplicate a retained active job', async () => {
    const existing = { getState: jest.fn().mockResolvedValue('active'), remove: jest.fn() };
    const queue = { getJob: jest.fn().mockResolvedValue(existing), add: jest.fn() };
    await new BullMqNotebookQueueDispatcher(() => queue as any, () => ({}) as any).enqueue('64b000000000000000000301');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('accepts only fresh, distinct, verified image identities', () => {
    const value = JSON.stringify({ timestamp: 10_000, isolationVerified: true,
      runtimeImageId: 'a'.repeat(64), verifierImageId: 'b'.repeat(64) });
    expect(parseHeartbeat(value, 20_000)).toMatchObject({ workerAvailable: true, isolationVerified: true });
    expect(parseHeartbeat(value, 30_001)).toMatchObject({ workerAvailable: false, isolationVerified: false });
    expect(parseHeartbeat(JSON.stringify({ timestamp: 10_000, isolationVerified: true,
      runtimeImageId: 'a'.repeat(64), verifierImageId: 'a'.repeat(64) }), 10_001))
      .toMatchObject({ workerAvailable: true, isolationVerified: false });
    expect(parseHeartbeat('{bad', 10_001)).toEqual({ workerAvailable: false, isolationVerified: false });
  });
});
