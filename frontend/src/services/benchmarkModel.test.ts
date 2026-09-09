import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_SUITE_ID,
  areBenchmarkRunsCompatible,
  benchmarkResumeKey,
  benchmarkScopeKey,
  buildBenchmarkRunPayload,
  effectiveBenchmarkProjectStatus,
  isBenchmarkScopeRequestCurrent,
  isTerminalBenchmarkRun,
  normalizeBenchmarkCallCompleted,
  normalizeBenchmarkCallStart,
  normalizeBenchmarkEventRevision,
  normalizeBenchmarkRunEvent,
  normalizeBenchmarkRunDeletion,
  normalizeBenchmarkRunDetail,
  normalizeBenchmarkRunPage,
  normalizeBenchmarkStatus,
  normalizeBenchmarkStreamError,
  normalizeBenchmarkSuites,
} from './benchmarkModel';

const runId = '507f1f77bcf86cd799439011';
const projectId = '507f1f77bcf86cd799439012';
const queuedAt = '2026-08-26T10:00:00.000Z';
const result = (callIndex: number) => ({
  callIndex,
  promptIndex: Math.floor(callIndex / 2),
  repetition: (callIndex % 2) + 1,
  promptLength: 120 + callIndex,
  passed: true,
  output: `answer ${callIndex}`,
  outputBytes: new TextEncoder().encode(`answer ${callIndex}`).byteLength,
  durationMs: 500 + callIndex,
  ttftMs: 100 + callIndex,
  usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24, totalDurationMs: 500, loadDurationMs: 5 },
  finishReason: 'stop',
  provider: 'ollama',
  model: 'phi3',
});
const results = Array.from({ length: 6 }, (_, index) => result(index));
const outputBytes = results.reduce((sum, item) => sum + item.outputBytes, 0);
const run = {
  id: runId,
  revision: 16,
  projectId,
  status: 'succeeded',
  suite: { id: BENCHMARK_SUITE_ID, version: 1, promptCount: 3, repetitions: 2, totalCalls: 6 },
  provider: 'ollama',
  model: { requested: { id: 'phi3' }, actual: { id: 'phi3', digest: 'sha256:abcd', sizeBytes: 2_000_000, contextWindow: 8_192 } },
  completedCalls: 6,
  passedCalls: 6,
  outputBytes,
  wallDurationMs: 3_100,
  aggregate: { passCount: 6, totalCalls: 6, medianTtftMs: 102.5, medianDurationMs: 502.5, medianOutputBytes: 8, outputTokens: 24, outputTokensPerSecond: 7.74 },
  queuedAt,
  startedAt: queuedAt,
  completedAt: '2026-08-26T10:00:03.100Z',
  createdAt: queuedAt,
  updatedAt: '2026-08-26T10:00:03.100Z',
};
const detail = {
  ...run,
  results,
  gpu: {
    before: {
      available: true,
      sampledAt: queuedAt,
      devices: [{ index: 0, name: 'Test GPU', driverVersion: '600.1', memoryTotalMiB: 16_384, memoryUsedMiB: 1_024, memoryFreeMiB: 15_360, utilizationPercent: 5, temperatureC: 40 }],
      summary: { deviceCount: 1, totalVramMiB: 16_384, usedVramMiB: 1_024, freeVramMiB: 15_360 },
    },
    after: { available: false, reason: 'probe-unavailable', sampledAt: '2026-08-26T10:00:03.100Z', devices: [] },
  },
  timeline: [
    { sequence: 1, revision: 1, type: 'created', timestamp: queuedAt },
    { sequence: 2, revision: 2, type: 'started', timestamp: queuedAt },
    { sequence: 3, revision: 2, type: 'provider_selected', timestamp: queuedAt, provider: 'ollama', model: 'phi3' },
    ...results.flatMap((item) => [
      { sequence: 4 + item.callIndex * 2, revision: 3 + item.callIndex * 2, type: 'call_started', timestamp: queuedAt, callIndex: item.callIndex },
      { sequence: 5 + item.callIndex * 2, revision: 4 + item.callIndex * 2, type: 'call_completed', timestamp: queuedAt, callIndex: item.callIndex },
    ]),
    { sequence: 16, revision: 15, type: 'completed', timestamp: '2026-08-26T10:00:03.100Z' },
  ],
};

describe('benchmark frontend contract', () => {
  it('accepts only the bounded status and fixed suite contract', () => {
    const status = {
      execution: { scope: 'shared-benchmark-worker', globalLimit: 1, ownerLimit: 1, active: false, queueDurable: true, workerAvailable: true },
      limits: { retentionPerOwner: 100, pageSize: 25, maxPages: 10, runTimeoutMs: 180_000, outputBytesPerCall: 16_384, outputBytesPerRun: 131_072 },
      warnings: { multiReplicaCoordination: true, remoteProviderBillingAndPrivacy: true },
      scope: { type: 'workspace' },
    };
    expect(normalizeBenchmarkStatus({ success: true, data: status })).toEqual(status);
    expect(normalizeBenchmarkStatus({ data: { ...status, ownerId: projectId } })).toBeUndefined();
    expect(normalizeBenchmarkStatus({ data: { ...status, execution: { ...status.execution, globalLimit: 2 } } })).toBeUndefined();
    expect(normalizeBenchmarkStatus({ data: { ...status, execution: { ...status.execution, workerAvailable: 'yes' } } })).toBeUndefined();
    expect(normalizeBenchmarkStatus({ data: { ...status, scope: { type: 'project', projectId, projectStatus: 'archived' } } })?.scope)
      .toEqual({ type: 'project', projectId, projectStatus: 'archived' });
    expect(normalizeBenchmarkStatus({ data: { ...status, scope: { type: 'project', projectId, projectStatus: 'unknown' } } })).toBeUndefined();
    expect(effectiveBenchmarkProjectStatus('active', 'archived')).toBe('archived');
    expect(effectiveBenchmarkProjectStatus('archived', 'active')).toBe('active');

    const suite = { id: BENCHMARK_SUITE_ID, title: 'Chat Core', version: 1, promptCount: 3, repetitions: 2, totalCalls: 6, parameters: { maxOutputTokens: 128, temperature: 0, topP: 1 } };
    expect(normalizeBenchmarkSuites({ data: { suites: [suite] } })).toEqual([suite]);
    expect(normalizeBenchmarkSuites({ data: { suites: [{ ...suite, promptCount: 4 }] } })).toBeUndefined();
    expect(buildBenchmarkRunPayload(' phi3 ', projectId)).toEqual({ model: 'phi3', suiteId: 'chat-core-v1', projectId });
    expect(benchmarkResumeKey(`project:${projectId}`, runId, 7)).toBe(`project:${projectId}:${runId}:7`);
  });

  it('normalizes ordered six-call detail without inventing missing metrics', () => {
    const normalized = normalizeBenchmarkRunDetail({ data: { run: detail } });
    expect(normalized).toMatchObject({
      id: runId,
      completedCalls: 6,
      aggregate: { medianDurationMs: 502.5, outputTokensPerSecond: 7.74 },
      gpu: { before: { devices: [{ name: 'Test GPU' }] }, after: { available: false } },
    });
    expect(normalized?.results.slice(0, 2)).toMatchObject([{ callIndex: 0, promptIndex: 0, repetition: 1 }, { callIndex: 1, promptIndex: 0, repetition: 2 }]);
    const withoutOptionalProviderMetrics = {
      ...detail,
      aggregate: { passCount: 6, totalCalls: 6, medianDurationMs: 502.5, medianOutputBytes: 8 },
      results: results.map(({ ttftMs: _ttftMs, usage: _usage, ...item }) => item),
    };
    expect(normalizeBenchmarkRunDetail(withoutOptionalProviderMetrics)?.aggregate).toEqual({ passCount: 6, totalCalls: 6, medianDurationMs: 502.5, medianOutputBytes: 8 });

    const cancelled = {
      ...detail,
      status: 'cancelled',
      completedCalls: 0,
      passedCalls: 0,
      outputBytes: 0,
      results: [],
      aggregate: undefined,
      cancelRequestedAt: queuedAt,
      timeline: [
        { sequence: 1, revision: 1, type: 'created', timestamp: queuedAt },
        { sequence: 2, revision: 2, type: 'started', timestamp: queuedAt },
        { sequence: 3, revision: 3, type: 'provider_selected', timestamp: queuedAt, provider: 'ollama', model: 'phi3' },
        { sequence: 4, revision: 4, type: 'call_started', timestamp: queuedAt, callIndex: 0 },
        { sequence: 49, revision: 15, type: 'cancel_requested', timestamp: queuedAt },
        { sequence: 50, revision: 16, type: 'cancelled', timestamp: queuedAt },
      ],
    };
    expect(normalizeBenchmarkRunDetail(cancelled)?.timeline.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 49, 50]);
  });

  it('rejects owner identities, GPU UUIDs, internal errors, reordered calls, and byte mismatches', () => {
    expect(normalizeBenchmarkRunDetail({ ...detail, ownerId: projectId })).toBeUndefined();
    expect(normalizeBenchmarkRunDetail({ ...detail, gpu: { ...detail.gpu, before: { ...detail.gpu.before, devices: [{ ...detail.gpu.before.devices[0], uuid: 'GPU-secret' }] } } })).toBeUndefined();
    expect(normalizeBenchmarkRunDetail({ ...detail, error: { code: 'failed', message: 'Public failure', stack: 'private stack' } })).toBeUndefined();
    expect(normalizeBenchmarkRunDetail({ ...detail, results: [results[1], results[0], ...results.slice(2)] })).toBeUndefined();
    expect(normalizeBenchmarkRunDetail({ ...detail, results: results.map((item, index) => index === 0 ? { ...item, outputBytes: item.outputBytes + 1 } : item) })).toBeUndefined();
  });

  it('normalizes fixed pagination and terminal deletion', () => {
    expect(normalizeBenchmarkRunPage({ data: { runs: [run], pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1, maxPages: 10 } } })).toMatchObject({ runs: [{ id: runId }], pagination: { page: 1, pageSize: 25 } });
    const cancelledBeforeClaim = { ...run, status: 'cancelled', completedCalls: 0, passedCalls: 0, outputBytes: 0,
      model: { requested: run.model.requested }, aggregate: undefined };
    expect(normalizeBenchmarkRunPage({ data: { runs: [cancelledBeforeClaim], pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1, maxPages: 10 } } }))
      .toMatchObject({ runs: [{ id: runId, status: 'cancelled', model: { requested: { id: 'phi3' } } }] });
    expect(normalizeBenchmarkRunPage({ data: { runs: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1, maxPages: 10 } } })).toBeUndefined();
    expect(normalizeBenchmarkRunPage({ data: { runs: [], pagination: { page: 1, pageSize: 25, total: 101, totalPages: 5, maxPages: 10 } } })?.pagination.total).toBe(101);
    expect(normalizeBenchmarkRunDeletion({ data: { runId, deleted: true } })).toEqual({ runId, deleted: true });
    expect(normalizeBenchmarkRunDeletion({ data: { runId, deleted: false } })).toBeUndefined();
  });

  it('pins every SSE progress result to one run and deterministic call identity', () => {
    expect(normalizeBenchmarkCallStart({ revision: 4, runId, callIndex: 3, promptIndex: 1, repetition: 2 }, '4', runId, 3)).toEqual({ revision: 4, runId, callIndex: 3, promptIndex: 1, repetition: 2 });
    expect(normalizeBenchmarkCallStart({ revision: 4, runId, callIndex: 4, promptIndex: 1, repetition: 2 }, '4', runId, 3)).toBeUndefined();
    expect(normalizeBenchmarkCallStart({ revision: 4, runId, callIndex: 0, promptIndex: 0, repetition: 1 }, '4', '507f1f77bcf86cd799439099', 3)).toBeUndefined();
    expect(normalizeBenchmarkCallCompleted({ revision: 5, runId, result: result(0) }, '5', runId, 4)).toMatchObject({ revision: 5, runId, result: { callIndex: 0 } });
    expect(normalizeBenchmarkCallCompleted({ revision: 5, runId: '507f1f77bcf86cd799439099', result: result(0) }, '5', runId, 4)).toBeUndefined();
    expect(normalizeBenchmarkCallCompleted({ data: { revision: 5, runId, result: result(0) } }, '5', runId, 4)).toBeUndefined();
    expect(normalizeBenchmarkEventRevision('05', 5, 4)).toBeUndefined();
    expect(normalizeBenchmarkEventRevision('5', 6, 4)).toBeUndefined();
    expect(normalizeBenchmarkEventRevision('4', 4, 4)).toBeUndefined();
    expect(normalizeBenchmarkRunEvent({ revision: 16, run: detail }, '16', runId, 15)).toMatchObject({ revision: 16, run: { id: runId } });
    expect(normalizeBenchmarkRunEvent({ revision: 15, run: detail }, '15', runId, 14)).toBeUndefined();
    expect(normalizeBenchmarkStreamError({ revision: 17, error: 'Worker failed safely.', code: 'BENCHMARK_EXECUTION_FAILED' }, '17', 16)).toEqual({ revision: 17, error: 'Worker failed safely.', code: 'BENCHMARK_EXECUTION_FAILED' });
    expect(normalizeBenchmarkStreamError({ revision: 17, error: 'Worker failed safely.', code: 'BENCHMARK_EXECUTION_FAILED', stack: 'private' }, '17', 16)).toBeUndefined();
  });

  it('guards stale scopes and compares only succeeded matching suite snapshots', () => {
    expect(benchmarkScopeKey(false)).toBe('workspace');
    expect(benchmarkScopeKey(true)).toBe('project:pending');
    expect(benchmarkScopeKey(true, projectId)).toBe(`project:${projectId}`);
    expect(isBenchmarkScopeRequestCurrent(`project:${projectId}`, `project:${projectId}`, 4, 4)).toBe(true);
    expect(isBenchmarkScopeRequestCurrent('workspace', `project:${projectId}`, 4, 4)).toBe(false);
    expect(isBenchmarkScopeRequestCurrent(`project:${projectId}`, `project:${projectId}`, 5, 4)).toBe(false);
    expect(isTerminalBenchmarkRun(run as never)).toBe(true);
    expect(isTerminalBenchmarkRun({ ...run, status: 'running' } as never)).toBe(false);
    expect(areBenchmarkRunsCompatible(run as never, { ...run, id: '507f1f77bcf86cd799439099' } as never)).toBe(true);
    expect(areBenchmarkRunsCompatible(run as never, { ...run, id: '507f1f77bcf86cd799439099', status: 'failed' } as never)).toBe(false);
    expect(areBenchmarkRunsCompatible(run as never, { ...run, id: '507f1f77bcf86cd799439099', suite: { ...run.suite, version: 2 } } as never)).toBe(false);
  });
});
