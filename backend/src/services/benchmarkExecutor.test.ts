import { AiProviderClient } from './ai/types';
import { BenchmarkRunModel } from '@/models/BenchmarkRun';
import { BenchmarkExecutor } from './benchmarkExecutor';
import { BenchmarkLeaseHandle } from './benchmarkResourceLease';
import { BenchmarkRunRecord } from './benchmarkService';

const runId = '64b000000000000000000201';
const startedAt = new Date('2026-08-27T00:00:00.000Z');

function queuedRun(overrides: Partial<BenchmarkRunRecord> = {}): BenchmarkRunRecord {
  return {
    _id: runId,
    ownerId: '64b000000000000000000001',
    jobId: `benchmark-${runId}`,
    activeOwnerSlot: true,
    revision: 1,
    suite: { id: 'chat-core-v1', version: 1, promptCount: 3, repetitions: 2, totalCalls: 6 },
    provider: 'ollama',
    model: { requested: { id: 'phi3' } },
    status: 'queued',
    results: [],
    completedCalls: 0,
    passedCalls: 0,
    outputBytes: 0,
    timeline: [{ revision: 1, sequence: 1, type: 'created', timestamp: startedAt }],
    queuedAt: startedAt,
    ...overrides,
  };
}

function lease(): BenchmarkLeaseHandle {
  return {
    fence: 7,
    owner: '7-worker',
    signal: new AbortController().signal,
    lost: new Promise<void>(() => undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
}

function provider(chatStream: jest.Mock): AiProviderClient {
  return {
    id: 'ollama',
    capabilities: { chat: true, streaming: true, embeddings: false, structuredOutput: false, modelListing: true },
    chatStream,
  } as unknown as AiProviderClient;
}

function unavailableGpu() {
  return Promise.resolve({
    available: false as const,
    reason: 'no-nvidia-gpu' as const,
    message: 'No test GPU.',
    sampledAt: startedAt.toISOString(),
    gpus: [],
  });
}

function installMemoryStore(executor: BenchmarkExecutor, initial: BenchmarkRunRecord) {
  let current = structuredClone(initial);
  const subject = executor as any;
  subject.load = jest.fn(async () => structuredClone(current));
  subject.claim = jest.fn(async (_run: BenchmarkRunRecord, handle: BenchmarkLeaseHandle, when: Date) => {
    current = { ...current, revision: current.revision + 1, status: 'running', startedAt: when,
      model: { ...current.model, actual: current.model.actual ?? current.model.requested },
      execution: { fence: handle.fence, leaseOwner: handle.owner, heartbeatAt: when } };
    return structuredClone(current);
  });
  subject.fencedPatch = jest.fn(async (_run: BenchmarkRunRecord, _fence: number, changes: Partial<BenchmarkRunRecord>) => {
    current = { ...current, ...structuredClone(changes), revision: current.revision + 1 };
    return structuredClone(current);
  });
  subject.markCallStarted = jest.fn(async (_run: BenchmarkRunRecord, handle: BenchmarkLeaseHandle, callIndex: number) => {
    current = { ...current, revision: current.revision + 1,
      execution: { ...current.execution, fence: handle.fence, inFlightCallIndex: callIndex } };
    return structuredClone(current);
  });
  subject.checkpoint = jest.fn(async (_run: BenchmarkRunRecord, _handle: BenchmarkLeaseHandle, result: any) => {
    const execution = { ...current.execution }; delete execution.inFlightCallIndex;
    current = { ...current, revision: current.revision + 1, execution,
      provider: result.provider, model: { ...current.model, actual: { id: result.model } },
      results: [...current.results, structuredClone(result)], completedCalls: current.completedCalls + 1,
      passedCalls: current.passedCalls + (result.passed ? 1 : 0), outputBytes: current.outputBytes + result.outputBytes };
    return structuredClone(current);
  });
  subject.terminal = jest.fn(async (_run: BenchmarkRunRecord, _fence: number, status: string, changes: Partial<BenchmarkRunRecord>) => {
    current = { ...current, ...structuredClone(changes), status, revision: current.revision + 1 } as BenchmarkRunRecord;
    delete current.activeOwnerSlot;
    return structuredClone(current);
  });
  return { get: () => structuredClone(current), subject };
}

describe('BenchmarkExecutor durable execution path', () => {
  afterEach(() => jest.restoreAllMocks());
  it('executes exactly six sequential fixed-suite calls and checkpoints before terminal success', async () => {
    let active = 0; let maximumActive = 0; let monotonic = 0;
    const chatStream = jest.fn(async (_request, onEvent) => {
      active += 1; maximumActive = Math.max(maximumActive, active);
      onEvent({ type: 'start', provider: 'ollama', model: 'phi3' });
      onEvent({ type: 'delta', provider: 'ollama', model: 'phi3', content: 'ok' });
      onEvent({ type: 'usage', provider: 'ollama', model: 'phi3', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } });
      onEvent({ type: 'done', provider: 'ollama', model: 'phi3', finishReason: 'stop', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } });
      active -= 1;
    });
    let clock = 0;
    const executor = new BenchmarkExecutor(() => provider(chatStream), unavailableGpu,
      () => new Date(startedAt.getTime() + (clock += 100)), () => (monotonic += 10));
    const memory = installMemoryStore(executor, queuedRun());

    await executor.execute(runId, lease(), new AbortController().signal);

    const finished = memory.get();
    expect(chatStream).toHaveBeenCalledTimes(6);
    expect(maximumActive).toBe(1);
    expect(memory.subject.markCallStarted).toHaveBeenCalledTimes(6);
    expect(memory.subject.checkpoint).toHaveBeenCalledTimes(6);
    expect(memory.subject.terminal).toHaveBeenCalledTimes(1);
    expect(finished).toMatchObject({ status: 'succeeded', completedCalls: 6, passedCalls: 6,
      aggregate: { passCount: 6, totalCalls: 6, outputTokens: 12 } });
    expect(finished.results.map((result) => [result.promptIndex, result.repetition]))
      .toEqual([[0, 1], [0, 2], [1, 1], [1, 2], [2, 1], [2, 2]]);
    for (const [request] of chatStream.mock.calls) {
      expect(request).toMatchObject({ model: 'phi3', temperature: 0, topP: 1, maxOutputTokens: 128 });
      expect(request.messages).toHaveLength(1);
    }
  });

  it('never retries an uncertain in-flight call after worker recovery', async () => {
    const chatStream = jest.fn();
    const executor = new BenchmarkExecutor(() => provider(chatStream));
    const uncertain = queuedRun({ status: 'running', startedAt, execution: { fence: 4, leaseOwner: 'old', inFlightCallIndex: 2 } });
    const subject = executor as any;
    subject.load = jest.fn().mockResolvedValue(uncertain);
    subject.interruptUncertain = jest.fn().mockResolvedValue(undefined);

    await executor.execute(runId, lease(), new AbortController().signal);

    expect(subject.interruptUncertain).toHaveBeenCalledWith(uncertain, expect.objectContaining({ fence: 7 }));
    expect(chatStream).not.toHaveBeenCalled();
  });

  it('re-fences a checkpointed running run without replaying start timeline events', async () => {
    const lean = jest.fn().mockResolvedValue(queuedRun({ status: 'running', revision: 8, completedCalls: 2 }));
    const findOneAndUpdate = jest.spyOn(BenchmarkRunModel, 'findOneAndUpdate').mockReturnValue({ lean } as any);
    const executor = new BenchmarkExecutor(() => provider(jest.fn()), unavailableGpu, () => startedAt);
    const running = queuedRun({ status: 'running', revision: 7, startedAt, completedCalls: 2,
      execution: { fence: 3, leaseOwner: 'old-worker' } });

    await (executor as any).claim(running, lease(), startedAt);

    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect(update).toBeDefined();
    expect(filter).toMatchObject({ revision: 7, status: 'running' });
    expect(update).toMatchObject({ $set: { 'model.actual': { id: 'phi3' }, execution: { fence: 7, leaseOwner: '7-worker' } }, $inc: { revision: 1 } });
    expect(update!.$set).not.toHaveProperty('model');
    expect(update).not.toHaveProperty('$push');
  });

  it('uses revision CAS and lets a concurrent Mongo cancellation win terminalization', async () => {
    const running = queuedRun({ status: 'running', revision: 5, startedAt,
      execution: { fence: 7, leaseOwner: '7-worker' } });
    const cancelled = queuedRun({ status: 'cancel-requested', revision: 6, startedAt, cancelRequestedAt: startedAt,
      execution: { fence: 7, leaseOwner: '7-worker' } });
    const terminal = queuedRun({ status: 'cancelled', revision: 7, startedAt, completedAt: startedAt,
      execution: { fence: 7, leaseOwner: '7-worker' } });
    const firstLean = jest.fn().mockResolvedValue(null);
    const secondLean = jest.fn().mockResolvedValue(terminal);
    const findOneAndUpdate = jest.spyOn(BenchmarkRunModel, 'findOneAndUpdate')
      .mockReturnValueOnce({ lean: firstLean } as any).mockReturnValueOnce({ lean: secondLean } as any);
    jest.spyOn(BenchmarkRunModel, 'findById').mockReturnValue({ lean: jest.fn().mockResolvedValue(cancelled) } as any);
    const executor = new BenchmarkExecutor(() => provider(jest.fn()), unavailableGpu, () => startedAt);

    await (executor as any).terminal(running, lease(), 'succeeded', { completedAt: startedAt }, 'completed');

    expect(findOneAndUpdate.mock.calls[0][0]).toMatchObject({ revision: 5, 'execution.leaseOwner': '7-worker' });
    expect(findOneAndUpdate.mock.calls[1][0]).toMatchObject({ revision: 6, status: { $in: ['running', 'cancel-requested'] } });
    expect(findOneAndUpdate.mock.calls[1][1]).toMatchObject({
      $set: { status: 'cancelled' },
      $push: { timeline: { revision: 7, type: 'cancelled' } },
    });
  });

  it('terminalizes provider factory failure before any provider call can start', async () => {
    const executor = new BenchmarkExecutor(() => { throw new Error('provider secret'); });
    const memory = installMemoryStore(executor, queuedRun());
    memory.subject.failBeforeCall = jest.fn().mockResolvedValue(undefined);

    await executor.execute(runId, lease(), new AbortController().signal);

    expect(memory.subject.failBeforeCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ owner: '7-worker' }),
      'BENCHMARK_PROVIDER_UNAVAILABLE', expect.stringContaining('no fallback'));
  });

  it('terminalizes oversized provider output without checkpointing the overflowing call', async () => {
    const chatStream = jest.fn(async (_request, onEvent, options) => {
      onEvent({ type: 'delta', provider: 'ollama', model: 'phi3', content: 'x'.repeat(16 * 1024 + 1) });
      if (options.signal.aborted) throw new Error('aborted');
    });
    const executor = new BenchmarkExecutor(() => provider(chatStream), unavailableGpu);
    const memory = installMemoryStore(executor, queuedRun());

    await executor.execute(runId, lease(), new AbortController().signal);

    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(memory.subject.checkpoint).not.toHaveBeenCalled();
    expect(memory.get()).toMatchObject({ status: 'output_limit', completedCalls: 0,
      error: { code: 'BENCHMARK_OUTPUT_LIMIT' } });
  });
});
