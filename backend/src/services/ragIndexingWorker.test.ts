import { RagIndexingWorker, RagIndexingWorkStore } from './ragIndexingWorker';

const claim = { sourceId: '64b000000000000000000201', token: '12345678-1234-1234-1234-123456789abc', attempt: 1, content: 'private' };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('RagIndexingWorker', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup(execute = jest.fn().mockResolvedValue(undefined)) {
    const store: RagIndexingWorkStore = {
      candidates: jest.fn().mockResolvedValue([claim.sourceId]),
      claim: jest.fn().mockResolvedValue(claim),
      renew: jest.fn().mockResolvedValue(true),
    };
    const report = jest.fn();
    const worker = new RagIndexingWorker(execute, report, store);
    return { worker, store, report, execute };
  }

  it('claims persisted work on startup and never executes a losing claim', async () => {
    const { worker, store, execute } = setup();
    (store.claim as jest.Mock).mockResolvedValueOnce(undefined);
    worker.start();
    await flush();
    expect(execute).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2000);
    expect(execute).toHaveBeenCalledWith(claim);
    await worker.stop();
    await jest.advanceTimersByTimeAsync(4000);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('serializes long calls, renews ownership, and drains before stopping', async () => {
    let finish!: () => void;
    const execute = jest.fn().mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { worker, store } = setup(execute);
    worker.start();
    worker.start();
    await flush();
    await jest.advanceTimersByTimeAsync(21_000);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.renew).toHaveBeenCalledTimes(2);
    let stopped = false;
    const drain = worker.stop().then(() => { stopped = true; });
    await flush();
    expect(stopped).toBe(false);
    finish();
    await drain;
    await jest.advanceTimersByTimeAsync(20_000);
    expect(store.renew).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('stops heartbeats after ownership loss while publication remains service-fenced', async () => {
    let finish!: () => void;
    const { worker, store } = setup(jest.fn().mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; })));
    (store.renew as jest.Mock).mockResolvedValue(false);
    worker.start();
    await flush();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(store.renew).toHaveBeenCalledTimes(1);
    const drain = worker.stop();
    finish();
    await drain;
  });

  it('recovers polling after database and execution errors without logging private input', async () => {
    const { worker, store, report, execute } = setup(jest.fn().mockRejectedValue(new Error('private input')));
    (store.candidates as jest.Mock).mockRejectedValueOnce(new Error('private database URI'));
    worker.start();
    await flush();
    await jest.advanceTimersByTimeAsync(2000);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(2);
    await worker.stop();
  });
});
