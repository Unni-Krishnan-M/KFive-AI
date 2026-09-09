import { BenchmarkResourceLease, LeaseRedis } from './benchmarkResourceLease';

function redis(overrides: Partial<LeaseRedis> = {}): LeaseRedis {
  return {
    incr: jest.fn().mockResolvedValue(7),
    set: jest.fn().mockResolvedValue('OK'),
    eval: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
}

describe('BenchmarkResourceLease', () => {
  it('acquires a fenced NX/PX lease, renews by token, and releases by token', async () => {
    jest.useFakeTimers();
    const store = redis();
    const lease = await new BenchmarkResourceLease(store, 30_000, 10_000).tryAcquire('worker-a');
    expect(lease).toMatchObject({ fence: 7, owner: expect.stringMatching(/^7-worker-a-/) });
    expect(store.set).toHaveBeenCalledWith('kfive:benchmark:resource-lease', lease?.owner, { NX: true, PX: 30_000 });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(store.eval).toHaveBeenCalledWith(expect.stringContaining('PEXPIRE'), {
      keys: ['kfive:benchmark:resource-lease'], arguments: [lease?.owner, '30000'],
    });
    await lease?.release();
    expect(store.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('DEL'"), {
      keys: ['kfive:benchmark:resource-lease'], arguments: [lease?.owner],
    });
    jest.useRealTimers();
  });

  it('returns no handle when another worker owns the resource', async () => {
    const store = redis({ set: jest.fn().mockResolvedValue(null) });
    await expect(new BenchmarkResourceLease(store).tryAcquire('worker-b')).resolves.toBeUndefined();
  });

  it('aborts the fence when compare-token renewal fails', async () => {
    jest.useFakeTimers();
    const store = redis({ eval: jest.fn().mockResolvedValue(0) });
    const lease = await new BenchmarkResourceLease(store, 30_000, 10_000).tryAcquire('worker-c');
    await jest.advanceTimersByTimeAsync(10_000);
    await expect(lease?.lost).resolves.toBeUndefined();
    expect(lease?.signal.aborted).toBe(true);
    await lease?.release();
    jest.useRealTimers();
  });
});
