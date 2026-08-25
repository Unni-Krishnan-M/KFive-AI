import { describe, expect, it } from 'vitest';
import { codeRunnerError, isPendingCodeRun, nextCodePollRetryDelay, normalizeCodeRun, normalizeCodeRunList, normalizeCodeRuntimeCatalog, normalizeCodeRuntimes } from './codeRunner';

describe('code runner contract normalization', () => {
  it('normalizes supported runtimes without inventing missing versions', () => {
    expect(normalizeCodeRuntimes({ data: { runtimes: [
      { language: 'python', label: 'Python', version: '3.12.4', available: true },
      { id: 'nodejs', enabled: false, reason: 'Runtime disabled' },
      { language: 'rust', version: '1.80' },
    ] } })).toEqual([
      { language: 'python', label: 'Python', version: '3.12.4', available: true, message: undefined },
      { language: 'javascript', label: 'JavaScript', version: undefined, available: false, message: 'Runtime disabled' },
    ]);
  });

  it('honors the top-level runner enabled flag', () => {
    expect(normalizeCodeRuntimeCatalog({ data: { enabled: false, message: 'Runner disabled', runtimes: [{ language: 'python', version: '3.12' }] } }))
      .toMatchObject({ enabled: false, available: false, runtimes: [{ language: 'python', available: false, message: 'Runner disabled' }] });
    expect(normalizeCodeRuntimeCatalog({ data: { enabled: true, available: false, message: 'Runner heartbeat is stale.', runtimes: [{ language: 'python', version: '3.12' }] } }))
      .toMatchObject({ enabled: true, available: false, runtimes: [{ language: 'python', available: false, message: 'Runner heartbeat is stale.' }] });
  });

  it('normalizes submitted and historical runs plus polling state', () => {
    const run = normalizeCodeRun({ data: { run: {
      _id: 'run-1', language: 'python3', status: 'running', result: {
        stdout: 'hello', executionTimeMs: 12, memoryUsedBytes: 4096, outputTruncated: true,
        signal: 'SIGKILL', oomKilled: true, errorCode: 'MEMORY_LIMIT',
      },
    } } });
    expect(run).toMatchObject({
      id: 'run-1', language: 'python', status: 'running', stdout: 'hello', durationMs: 12,
      memoryBytes: 4096, outputTruncated: true, signal: 'SIGKILL', oomKilled: true, errorCode: 'MEMORY_LIMIT',
    });
    expect(isPendingCodeRun(run)).toBe(true);
    expect(isPendingCodeRun({ ...run!, status: 'succeeded' })).toBe(false);
    expect(normalizeCodeRunList({ data: { runs: [{ id: 'run-2', language: 'javascript', status: 'canceled' }] } })[0].status).toBe('cancelled');
    expect(normalizeCodeRun({ data: { id: 'run-3', language: 'python', status: 'resource_exceeded' } })?.status).toBe('resource-exceeded');
    expect(isPendingCodeRun(normalizeCodeRun({ data: { id: 'run-4', language: 'python', status: 'cancel-requested' } }))).toBe(true);
  });

  it('preserves the backend runner-disabled message', () => {
    expect(codeRunnerError({ response: { data: { error: { message: 'Code runner is disabled by CODE_RUNNER_MODE.' } } } }, 'Unavailable'))
      .toBe('Code runner is disabled by CODE_RUNNER_MODE.');
  });

  it('uses bounded polling backoff and stops after five transient failures', () => {
    expect([1, 2, 3, 4, 5].map(nextCodePollRetryDelay)).toEqual([750, 1500, 3000, 6000, 6000]);
    expect(nextCodePollRetryDelay(6)).toBeUndefined();
  });
});
