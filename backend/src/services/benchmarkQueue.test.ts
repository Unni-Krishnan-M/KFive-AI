import { BullMqBenchmarkQueueDispatcher, benchmarkJobId } from './benchmarkQueue';

const runId = '64b000000000000000000201';

describe('BullMqBenchmarkQueueDispatcher', () => {
  it('uses a safe deterministic prefixed job id and an ids-only payload with no retry', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const dispatcher = new BullMqBenchmarkQueueDispatcher(
      () => ({ add, getJob: jest.fn().mockResolvedValue(undefined) } as any),
      () => ({ publish: jest.fn(), get: jest.fn() }),
      () => 1_000
    );
    await dispatcher.enqueue(runId);
    expect(benchmarkJobId(runId)).toBe(`benchmark-${runId}`);
    expect(add).toHaveBeenCalledWith('execute', { runId }, expect.objectContaining({
      jobId: `benchmark-${runId}`, attempts: 1,
    }));
    expect(JSON.stringify(add.mock.calls[0][1])).toBe(`{"runId":"${runId}"}`);
  });

  it('keeps an existing active or waiting delivery instead of duplicating it', async () => {
    for (const state of ['active', 'waiting']) {
      const add = jest.fn();
      const getState = jest.fn().mockResolvedValue(state);
      const dispatcher = new BullMqBenchmarkQueueDispatcher(
        () => ({ add, getJob: jest.fn().mockResolvedValue({ getState }) } as any),
        () => ({ publish: jest.fn(), get: jest.fn() }),
      );
      await dispatcher.enqueue(runId);
      expect(add).not.toHaveBeenCalled();
    }
  });

  it.each(['completed', 'failed'])('removes a retained %s delivery before recovery redispatch', async (state) => {
    const add = jest.fn().mockResolvedValue(undefined);
    const remove = jest.fn().mockResolvedValue(undefined);
    const getJob = jest.fn().mockResolvedValue({ getState: jest.fn().mockResolvedValue(state), remove });
    const dispatcher = new BullMqBenchmarkQueueDispatcher(
      () => ({ add, getJob } as any),
      () => ({ publish: jest.fn(), get: jest.fn() }),
    );
    await dispatcher.enqueue(runId);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith('execute', { runId }, expect.objectContaining({ jobId: `benchmark-${runId}` }));
  });

  it('does not hide a failed retained-job removal while the job still exists', async () => {
    const retained = { getState: jest.fn().mockResolvedValue('failed'), remove: jest.fn().mockRejectedValue(new Error('redis down')) };
    const dispatcher = new BullMqBenchmarkQueueDispatcher(
      () => ({ add: jest.fn(), getJob: jest.fn().mockResolvedValue(retained) } as any),
      () => ({ publish: jest.fn(), get: jest.fn() }),
    );
    await expect(dispatcher.enqueue(runId)).rejects.toThrow('redis down');
  });

  it('reports lease activity and a fresh worker heartbeat without exposing either value', async () => {
    const get = jest.fn().mockImplementation(async (key: string) => key.endsWith('resource-lease') ? 'private-fence-owner' : '995');
    const dispatcher = new BullMqBenchmarkQueueDispatcher(
      () => ({} as any),
      () => ({ publish: jest.fn(), get }),
      () => 1_000
    );
    await expect(dispatcher.executionStatus()).resolves.toEqual({ active: true, workerAvailable: true });
    expect(JSON.stringify(await dispatcher.executionStatus())).not.toContain('private-fence-owner');
  });

  it('publishes only the run id for cancellation and removes only the deterministic job', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const getJob = jest.fn().mockResolvedValue({ remove });
    const publish = jest.fn().mockResolvedValue(1);
    const dispatcher = new BullMqBenchmarkQueueDispatcher(
      () => ({ getJob } as any),
      () => ({ publish, get: jest.fn() }),
    );
    await dispatcher.wakeCancellation(runId);
    expect(publish).toHaveBeenCalledWith('kfive:benchmark:cancel', runId);
    await dispatcher.remove(runId);
    expect(getJob).toHaveBeenCalledWith(`benchmark-${runId}`);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
