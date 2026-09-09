import { BenchmarkRunModel } from '@/models/BenchmarkRun';
import { AiProviderClient, AiStreamEvent, AiUsage } from './ai/types';
import { AiProviderError } from './ai/errors';
import { getAiProvider } from './aiProvider';
import { getGpuStatus, GpuStatus } from './gpuStatus';
import {
  BENCHMARK_LIMITS,
  BenchmarkAggregate,
  BenchmarkCallResult,
  BenchmarkGpuSnapshot,
  BenchmarkRunRecord,
  CHAT_CORE_PROMPTS,
  normalizeBenchmarkDuration,
  normalizeBenchmarkUsage,
  safeBenchmarkLabel,
  sanitizeGpuSnapshot,
  TERMINAL_BENCHMARK_STATUSES,
} from './benchmarkService';
import { BenchmarkLeaseHandle } from './benchmarkResourceLease';

const terminalStatus = ['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted'] as const;

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right); const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function aggregateBenchmarkResults(results: BenchmarkCallResult[], wallDurationMs: number): BenchmarkAggregate {
  const ttfts = results.flatMap((result) => result.ttftMs === undefined ? [] : [result.ttftMs]);
  const tokens = results.flatMap((result) => result.usage?.outputTokens === undefined ? [] : [result.usage.outputTokens]);
  const total = results.length === 6 && tokens.length === 6 ? tokens.reduce((sum, value) => sum + value, 0) : undefined;
  return { passCount: results.filter((result) => result.passed).length, totalCalls: 6,
    ...(median(ttfts) !== undefined ? { medianTtftMs: median(ttfts) } : {}),
    medianDurationMs: median(results.map((result) => result.durationMs)) ?? 0,
    medianOutputBytes: median(results.map((result) => result.outputBytes)) ?? 0,
    ...(total !== undefined ? { outputTokens: total,
      outputTokensPerSecond: wallDurationMs > 0 ? Math.round((total / (wallDurationMs / 1000)) * 1000) / 1000 : 0 } : {}) };
}

export const BENCHMARK_WORKER_SHUTDOWN_REASON = 'kfive-benchmark-worker-shutdown';

interface AbortState { cancelled: boolean; shutdown: boolean; timedOut: boolean; outputLimit: boolean; leaseLost: boolean }

export class BenchmarkExecutor {
  constructor(
    private readonly provider: () => AiProviderClient = getAiProvider,
    private readonly probeGpu: () => Promise<GpuStatus> = getGpuStatus,
    private readonly now: () => Date = () => new Date(),
    private readonly monotonic: () => number = () => Number(process.hrtime.bigint()) / 1_000_000,
    private readonly timeoutMs = BENCHMARK_LIMITS.timeoutMs
  ) {}

  async execute(runId: string, lease: BenchmarkLeaseHandle, cancellationSignal: AbortSignal): Promise<void> {
    let run = await this.load(runId);
    if (!run || TERMINAL_BENCHMARK_STATUSES.has(run.status)) return;
    if (run.status === 'cancel-requested') { await this.cancel(run, lease); return; }
    if (run.status === 'running' && run.execution?.inFlightCallIndex !== undefined) {
      await this.interruptUncertain(run, lease); return;
    }

    let client: AiProviderClient;
    try {
      client = this.provider();
    } catch {
      await this.failBeforeCall(run, lease, 'BENCHMARK_PROVIDER_UNAVAILABLE',
        'The configured provider could not be initialized; no fallback was attempted.');
      return;
    }
    const providerId = safeBenchmarkLabel(client.id, 100, 'configured');
    if (providerId !== run.provider || !client.capabilities.chat || !client.capabilities.streaming) {
      await this.failBeforeCall(run, lease, 'BENCHMARK_PROVIDER_UNAVAILABLE',
        'The configured provider changed or is unavailable; no fallback was attempted.');
      return;
    }

    const startedAt = run.startedAt ?? this.now();
    const claimed = await this.claim(run, lease, startedAt);
    if (!claimed) return;
    run = claimed;
    let gpuBefore = run.gpu?.before ?? await this.safeGpuProbe();
    if (gpuBefore && !run.gpu?.before) {
      run = await this.fencedPatch(run, lease, { gpu: { before: gpuBefore } }) ?? run;
    }

    const state: AbortState = { cancelled: false, shutdown: false, timedOut: false, outputLimit: false, leaseLost: false };
    const controller = new AbortController();
    const abortCancellation = () => {
      if (cancellationSignal.reason === BENCHMARK_WORKER_SHUTDOWN_REASON) state.shutdown = true;
      else state.cancelled = true;
      controller.abort();
    };
    const abortLease = () => { state.leaseLost = true; controller.abort(); };
    if (cancellationSignal.aborted) abortCancellation();
    else cancellationSignal.addEventListener('abort', abortCancellation, { once: true });
    if (lease.signal.aborted) abortLease();
    else lease.signal.addEventListener('abort', abortLease, { once: true });
    const remaining = Math.max(1, this.timeoutMs - Math.max(0, this.now().getTime() - startedAt.getTime()));
    const timer = setTimeout(() => { state.timedOut = true; controller.abort(); }, remaining); timer.unref();
    try {
      for (let callIndex = run.completedCalls; callIndex < 6; callIndex += 1) {
        if (state.leaseLost || state.shutdown || state.cancelled || state.timedOut) throw new Error('aborted');
        run = await this.load(runId) ?? run;
        if (run.status === 'cancel-requested') { state.cancelled = true; controller.abort(); throw new Error('cancelled'); }
        if (run.status !== 'running' || run.execution?.fence !== lease.fence) return;
        const marked = await this.markCallStarted(run, lease, callIndex);
        if (!marked) return;
        run = marked;
        const result = await this.callProvider(client, run, callIndex, controller, state);
        if (state.leaseLost) return;
        const current = await this.load(runId);
        if (!current) return;
        if (current.status === 'cancel-requested') { state.cancelled = true; throw new Error('cancelled'); }
        if (state.timedOut || state.outputLimit || state.cancelled || state.shutdown) throw new Error('aborted');
        const checkpointed = await this.checkpoint(current, lease, result);
        if (!checkpointed) return;
        run = checkpointed;
      }
      const gpuAfter = await this.safeGpuProbe();
      const wallDurationMs = normalizeBenchmarkDuration(this.now().getTime() - startedAt.getTime());
      const aggregate = aggregateBenchmarkResults(run.results, wallDurationMs);
      const completedAt = this.now(); const succeeded = aggregate.passCount === 6;
      await this.terminal(run, lease, succeeded ? 'succeeded' : 'failed', {
        provider: run.provider, results: run.results, completedCalls: 6, passedCalls: aggregate.passCount,
        outputBytes: run.outputBytes, wallDurationMs, aggregate,
        gpu: { ...(gpuBefore ? { before: gpuBefore } : {}), ...(gpuAfter ? { after: gpuAfter } : {}) }, completedAt,
        ...(!succeeded ? { error: { code: 'BENCHMARK_CALL_FAILED', message: 'One or more benchmark calls failed.' } } : {}),
      }, succeeded ? 'completed' : 'failed', succeeded ? undefined : 'BENCHMARK_CALL_FAILED');
    } catch {
      if (state.leaseLost) return;
      run = await this.load(runId) ?? run;
      const gpuAfter = await this.safeGpuProbe();
      const wallDurationMs = normalizeBenchmarkDuration(this.now().getTime() - startedAt.getTime()); const completedAt = this.now();
      if (state.cancelled || run.status === 'cancel-requested') {
        await this.terminal(run, lease, 'cancelled', { completedAt, cancelRequestedAt: run.cancelRequestedAt ?? completedAt,
          wallDurationMs, gpu: { ...(gpuBefore ? { before: gpuBefore } : {}), ...(gpuAfter ? { after: gpuAfter } : {}) } }, 'cancelled');
      } else if (state.timedOut) {
        await this.terminal(run, lease, 'timed_out', { completedAt, wallDurationMs,
          error: { code: 'BENCHMARK_TIMEOUT', message: 'The benchmark run timed out.' },
          gpu: { ...(gpuBefore ? { before: gpuBefore } : {}), ...(gpuAfter ? { after: gpuAfter } : {}) } }, 'failed', 'BENCHMARK_TIMEOUT');
      } else if (state.outputLimit) {
        await this.terminal(run, lease, 'output_limit', { completedAt, wallDurationMs,
          error: { code: 'BENCHMARK_OUTPUT_LIMIT', message: 'Benchmark output exceeded its byte limit.' },
          gpu: { ...(gpuBefore ? { before: gpuBefore } : {}), ...(gpuAfter ? { after: gpuAfter } : {}) } }, 'failed', 'BENCHMARK_OUTPUT_LIMIT');
      } else {
        await this.terminal(run, lease, 'interrupted', { completedAt, wallDurationMs,
          error: { code: 'BENCHMARK_INTERRUPTED', message: 'The benchmark stopped after a provider call began; the call was not retried.' } },
        'failed', 'BENCHMARK_INTERRUPTED');
      }
    } finally {
      clearTimeout(timer); cancellationSignal.removeEventListener('abort', abortCancellation); lease.signal.removeEventListener('abort', abortLease);
    }
  }

  private async callProvider(client: AiProviderClient, run: BenchmarkRunRecord, callIndex: number,
    controller: AbortController, state: AbortState): Promise<BenchmarkCallResult> {
    const promptIndex = Math.floor(callIndex / 2); const repetition = (callIndex % 2) + 1; const prompt = CHAT_CORE_PROMPTS[promptIndex];
    const callStarted = this.monotonic(); let firstToken: number | undefined; let output = ''; let usage: AiUsage | undefined;
    let finishReason: BenchmarkCallResult['finishReason'] = 'unknown'; let done = false; let provider = run.provider ?? 'configured';
    let model = run.model.actual?.id ?? run.model.requested.id; let callError: BenchmarkCallResult['error'];
    try {
      const request = client.chatStream({ model: run.model.requested.id, messages: [{ role: 'user', content: prompt }],
        temperature: 0, topP: 1, maxOutputTokens: 128 }, (event: AiStreamEvent) => {
        provider = safeBenchmarkLabel(event.provider, 100, provider); model = safeBenchmarkLabel(event.model, 200, model);
        if (event.type === 'delta' && typeof event.content === 'string') {
          if (firstToken === undefined && Buffer.byteLength(event.content, 'utf8') > 0) firstToken = this.monotonic();
          const next = output + event.content; const bytes = Buffer.byteLength(next, 'utf8');
          if (bytes > BENCHMARK_LIMITS.outputBytesPerCall || run.outputBytes + bytes > BENCHMARK_LIMITS.outputBytesPerRun) {
            state.outputLimit = true; controller.abort(); return;
          }
          output = next;
        } else if (event.type === 'usage') usage = normalizeBenchmarkUsage(event.usage);
        else if (event.type === 'done') { done = true; usage = normalizeBenchmarkUsage(event.usage) ?? usage; finishReason = event.finishReason; }
      }, { signal: controller.signal });
      const aborted = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new Error('aborted'));
        if (controller.signal.aborted) abort(); else controller.signal.addEventListener('abort', abort, { once: true });
      });
      await Promise.race([request, aborted]);
      if (!done) { callError = { code: 'BENCHMARK_CALL_FAILED', message: 'The benchmark provider call ended without a completion event.' }; finishReason = 'error'; }
    } catch (error) {
      if (state.cancelled || state.shutdown || state.timedOut || state.outputLimit || state.leaseLost) throw error;
      callError = error instanceof AiProviderError && error.code === 'PROVIDER_UNAVAILABLE'
        ? { code: 'BENCHMARK_PROVIDER_UNAVAILABLE', message: 'The configured AI provider was unavailable for this call.' }
        : { code: 'BENCHMARK_CALL_FAILED', message: 'The benchmark provider call failed.' };
      finishReason = 'error';
    }
    const durationMs = normalizeBenchmarkDuration(this.monotonic() - callStarted); const outputBytes = Buffer.byteLength(output, 'utf8');
    return { callIndex, promptIndex, repetition, promptLength: [...prompt].length, passed: callError === undefined,
      output, outputBytes, durationMs, ...(firstToken !== undefined ? { ttftMs: normalizeBenchmarkDuration(firstToken - callStarted) } : {}),
      provider, model, ...(usage ? { usage } : {}), finishReason, ...(callError ? { error: callError } : {}) };
  }

  private async claim(run: BenchmarkRunRecord, lease: BenchmarkLeaseHandle, startedAt: Date) {
    const revision = run.revision + 1; const now = this.now();
    const initial = run.status === 'queued';
    return BenchmarkRunModel.findOneAndUpdate(
      { _id: run._id, revision: run.revision, status: run.status, $or: [{ 'execution.inFlightCallIndex': { $exists: false } }, { 'execution.inFlightCallIndex': null }] },
      { $set: { status: 'running', startedAt, provider: run.provider, 'model.actual': run.model.actual ?? run.model.requested,
        execution: { fence: lease.fence, leaseOwner: lease.owner, heartbeatAt: now } }, $inc: { revision: 1 },
        ...(initial ? { $push: { timeline: { $each: [{ revision, sequence: 2, type: 'started', timestamp: now },
          { revision, sequence: 3, type: 'provider_selected', timestamp: now, provider: run.provider, model: run.model.requested.id }], $slice: -50 } } } : {}) },
      { new: true, runValidators: true }
    ).lean<BenchmarkRunRecord>();
  }
  private async markCallStarted(run: BenchmarkRunRecord, lease: BenchmarkLeaseHandle, callIndex: number) {
    const revision = run.revision + 1; const timestamp = this.now();
    return BenchmarkRunModel.findOneAndUpdate(
      { _id: run._id, revision: run.revision, status: 'running', completedCalls: callIndex, 'execution.fence': lease.fence,
        'execution.leaseOwner': lease.owner,
        'execution.inFlightCallIndex': { $exists: false } },
      { $set: { 'execution.inFlightCallIndex': callIndex, 'execution.heartbeatAt': timestamp }, $inc: { revision: 1 },
        $push: { timeline: { revision, sequence: 4 + callIndex * 2, type: 'call_started', timestamp, callIndex } } },
      { new: true, runValidators: true }
    ).lean<BenchmarkRunRecord>();
  }
  private async checkpoint(run: BenchmarkRunRecord, lease: BenchmarkLeaseHandle, result: BenchmarkCallResult) {
    const revision = run.revision + 1; const timestamp = this.now();
    return BenchmarkRunModel.findOneAndUpdate(
      { _id: run._id, revision: run.revision, status: 'running', completedCalls: result.callIndex,
        'execution.fence': lease.fence, 'execution.leaseOwner': lease.owner, 'execution.inFlightCallIndex': result.callIndex },
      { $push: { results: result, timeline: { revision, sequence: 5 + result.callIndex * 2, type: 'call_completed', timestamp, callIndex: result.callIndex } },
        $inc: { revision: 1, completedCalls: 1, passedCalls: result.passed ? 1 : 0, outputBytes: result.outputBytes },
        $set: { provider: result.provider, 'model.actual': { id: result.model }, 'execution.heartbeatAt': timestamp },
        $unset: { 'execution.inFlightCallIndex': '' } }, { new: true, runValidators: true }
    ).lean<BenchmarkRunRecord>();
  }
  private async terminal(run: BenchmarkRunRecord, lease: BenchmarkLeaseHandle, status: typeof terminalStatus[number], changes: Record<string, unknown>,
    type: 'completed' | 'failed' | 'cancelled', code?: string) {
    let candidate = run; let targetStatus = status; let targetChanges = changes; let targetType = type; let targetCode = code;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const timestamp = this.now(); const revision = candidate.revision + 1;
      const updated = await BenchmarkRunModel.findOneAndUpdate(
        { _id: candidate._id, revision: candidate.revision, status: { $in: ['running', 'cancel-requested'] },
          'execution.fence': lease.fence, 'execution.leaseOwner': lease.owner },
        { $set: { ...targetChanges, status: targetStatus }, $unset: { activeOwnerSlot: '', 'execution.inFlightCallIndex': '' },
          $inc: { revision: 1 }, $push: { timeline: { revision, sequence: 50, type: targetType, timestamp,
            ...(targetCode ? { code: targetCode } : {}) } } },
        { new: true, runValidators: true }
      ).lean<BenchmarkRunRecord>();
      if (updated) return updated;
      const latest = await this.load(String(candidate._id));
      if (!latest || TERMINAL_BENCHMARK_STATUSES.has(latest.status)
        || latest.execution?.fence !== lease.fence || latest.execution?.leaseOwner !== lease.owner) return null;
      candidate = latest;
      if (latest.status === 'cancel-requested' && targetStatus !== 'cancelled') {
        targetStatus = 'cancelled'; targetType = 'cancelled'; targetCode = undefined;
        targetChanges = {
          completedAt: targetChanges.completedAt ?? this.now(),
          cancelRequestedAt: latest.cancelRequestedAt ?? this.now(),
          ...(targetChanges.wallDurationMs !== undefined ? { wallDurationMs: targetChanges.wallDurationMs } : {}),
          ...(targetChanges.gpu !== undefined ? { gpu: targetChanges.gpu } : {}),
        };
      }
    }
    return null;
  }
  private async cancel(run: BenchmarkRunRecord, lease: BenchmarkLeaseHandle) {
    const claimed = await BenchmarkRunModel.findOneAndUpdate({ _id: run._id, revision: run.revision, status: 'cancel-requested' },
      { $set: { 'execution.fence': lease.fence, 'execution.leaseOwner': lease.owner }, $inc: { revision: 1 } },
      { new: true }).lean<BenchmarkRunRecord>();
    if (claimed) await this.terminal(claimed, lease, 'cancelled', { completedAt: this.now() }, 'cancelled');
  }
  private async interruptUncertain(run: BenchmarkRunRecord, lease: BenchmarkLeaseHandle) {
    const claimed = await BenchmarkRunModel.findOneAndUpdate({ _id: run._id, revision: run.revision, status: 'running' },
      { $set: { 'execution.fence': lease.fence, 'execution.leaseOwner': lease.owner }, $inc: { revision: 1 } }, { new: true }).lean<BenchmarkRunRecord>();
    if (claimed) await this.terminal(claimed, lease, 'interrupted', { completedAt: this.now(),
      error: { code: 'BENCHMARK_INTERRUPTED', message: 'A worker stopped after this provider call began; the call was not retried.' } },
    'failed', 'BENCHMARK_INTERRUPTED');
  }
  private async failBeforeCall(run: BenchmarkRunRecord, lease: BenchmarkLeaseHandle, code: string, message: string) {
    const claimed = await this.claim(run, lease, this.now()); if (!claimed) return;
    await this.terminal(claimed, lease, 'failed', { completedAt: this.now(), error: { code, message } }, 'failed', code);
  }
  private async fencedPatch(run: BenchmarkRunRecord, lease: BenchmarkLeaseHandle, changes: Record<string, unknown>) {
    return BenchmarkRunModel.findOneAndUpdate({ _id: run._id, revision: run.revision, status: 'running',
      'execution.fence': lease.fence, 'execution.leaseOwner': lease.owner },
      { $set: changes, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean<BenchmarkRunRecord>();
  }
  private async load(runId: string) { return BenchmarkRunModel.findById(runId).lean<BenchmarkRunRecord>(); }
  private async safeGpuProbe(): Promise<BenchmarkGpuSnapshot | undefined> { try { return sanitizeGpuSnapshot(await this.probeGpu()); } catch { return undefined; } }
}
