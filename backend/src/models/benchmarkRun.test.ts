import { Types } from 'mongoose';
import { BenchmarkRunModel } from './BenchmarkRun';

function validRun() {
  return new BenchmarkRunModel({
    ownerId: new Types.ObjectId(),
    jobId: 'benchmark-64b000000000000000000201',
    revision: 1,
    suite: { id: 'chat-core-v1', version: 1, promptCount: 3, repetitions: 2, totalCalls: 6 },
    model: { requested: { id: 'phi3', digest: 'sha256:abc', sizeBytes: 10, contextWindow: 8192 } },
    status: 'queued', results: [], completedCalls: 0, passedCalls: 0, outputBytes: 0,
    timeline: [{ sequence: 1, revision: 1, type: 'created', timestamp: new Date() }],
  });
}

describe('BenchmarkRun model', () => {
  it('accepts the fixed suite and bounded lifecycle record', async () => {
    await expect(validRun().validate()).resolves.toBeUndefined();
  });

  it('rejects a mutable suite, too many calls, oversized output, and a UUID-bearing GPU device', async () => {
    const suite = validRun();
    suite.suite!.id = 'custom-suite' as any;
    await expect(suite.validate()).rejects.toThrow('not a valid enum value');

    const calls = validRun();
    calls.results = Array.from({ length: 7 }, (_, callIndex) => ({
      callIndex, promptIndex: 0, repetition: 1, promptLength: 2, passed: true,
      output: 'ok', outputBytes: 2, durationMs: 1, provider: 'ollama', model: 'phi3', finishReason: 'stop',
    })) as any;
    await expect(calls.validate()).rejects.toThrow('too many call results');

    const output = validRun();
    output.results = [{
      callIndex: 0, promptIndex: 0, repetition: 1, promptLength: 2, passed: true,
      output: 'x'.repeat(16_385), outputBytes: 16_384, durationMs: 1, provider: 'ollama', model: 'phi3',
    }] as any;
    await expect(output.validate()).rejects.toThrow('longer than the maximum allowed length');

    const gpu = validRun();
    gpu.set('gpu.before', {
      available: true, sampledAt: new Date().toISOString(),
      devices: [{
        index: 0, name: 'GPU', uuid: 'GPU-secret', driverVersion: '1', memoryTotalMiB: 1,
        memoryUsedMiB: 0, memoryFreeMiB: 1, utilizationPercent: 0, temperatureC: 20,
      }],
    });
    await expect(gpu.validate()).rejects.toThrow('StrictModeError');
  });

  it('declares owner/project history and stale lifecycle indexes', () => {
    const indexes = BenchmarkRunModel.schema.indexes().map(([fields]) => fields);
    expect(indexes).toEqual(expect.arrayContaining([
      { ownerId: 1, createdAt: -1 },
      { ownerId: 1, projectId: 1, createdAt: -1 },
      { status: 1, updatedAt: 1 },
      { ownerId: 1 },
    ]));
    expect(BenchmarkRunModel.schema.path('ownerId').options.immutable).toBe(true);
    expect(BenchmarkRunModel.schema.path('projectId').options.immutable).toBe(true);
  });
});
