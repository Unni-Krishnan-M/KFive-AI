import { AiProviderClient } from './ai/types';
import {
  BENCHMARK_LIMITS,
  BenchmarkRunError,
  BenchmarkRunRecord,
  BenchmarkRunRepository,
  BenchmarkService,
  BenchmarkTimeline,
  benchmarkListFilter,
  validateBenchmarkRequest,
} from './benchmarkService';
import { BenchmarkQueueDispatcher, benchmarkJobId } from './benchmarkQueue';
import { ProjectMutationLease } from './projectMutationLease';

const ownerId = '64b000000000000000000001';
const projectId = '64b000000000000000000101';
const runId = '64b000000000000000000201';
const now = new Date('2026-08-27T00:00:00.000Z');

function record(overrides: Partial<BenchmarkRunRecord> = {}): BenchmarkRunRecord {
  return {
    _id: runId, ownerId, jobId: benchmarkJobId(runId), activeOwnerSlot: true, revision: 1,
    suite: { id: 'chat-core-v1', version: 1, promptCount: 3, repetitions: 2, totalCalls: 6 },
    provider: 'ollama', model: { requested: { id: 'phi3' } }, status: 'queued', results: [],
    completedCalls: 0, passedCalls: 0, outputBytes: 0,
    timeline: [{ revision: 1, sequence: 1, type: 'created', timestamp: now }],
    queuedAt: now, createdAt: now, updatedAt: now, ...overrides,
  };
}

function repository(seed: BenchmarkRunRecord[] = []): BenchmarkRunRepository & { records: BenchmarkRunRecord[] } {
  const records = seed.map((item) => structuredClone(item));
  return {
    records,
    async create(value) {
      const created = { ...structuredClone(value), _id: value._id ?? runId, createdAt: now, updatedAt: now } as BenchmarkRunRecord;
      records.push(created); return structuredClone(created);
    },
    async list(owner, project, offset, limit) {
      return records.filter((item) => String(item.ownerId) === owner
        && (project ? String(item.projectId) === project : item.projectId === undefined))
        .slice(offset, offset + limit).map((item) => structuredClone(item));
    },
    async count(owner, project) {
      return records.filter((item) => String(item.ownerId) === owner && (!project || String(item.projectId) === project)).length;
    },
    async countInScope(owner, project) {
      return records.filter((item) => String(item.ownerId) === owner
        && (project ? String(item.projectId) === project : item.projectId === undefined)).length;
    },
    async findByOwnerAndId(owner, id) {
      const found = records.find((item) => String(item.ownerId) === owner && String(item._id) === id);
      return found ? structuredClone(found) : null;
    },
    async findActive() {
      return records.filter((item) => ['queued', 'running', 'cancel-requested'].includes(item.status)).map((item) => structuredClone(item));
    },
    async deleteTerminalByOwnerAndId(owner, id) {
      const index = records.findIndex((item) => String(item.ownerId) === owner && String(item._id) === id
        && ['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted'].includes(item.status));
      return index < 0 ? null : structuredClone(records.splice(index, 1)[0]);
    },
    async transition(owner, id, allowed, changes, events: Array<Omit<BenchmarkTimeline, 'revision'>> = []) {
      const found = records.find((item) => String(item.ownerId) === owner && String(item._id) === id && allowed.includes(item.status));
      if (!found) return null;
      const revision = found.revision + 1;
      Object.assign(found, structuredClone(changes), { revision, updatedAt: now });
      if (changes.status && ['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted'].includes(changes.status)) delete found.activeOwnerSlot;
      found.timeline = [...found.timeline, ...events.map((event) => ({ ...structuredClone(event), revision }))].slice(-50);
      return structuredClone(found);
    },
    async reconcileDeletedProjects() { return { interrupted: 0, deleted: 0, runIds: [] }; },
  };
}

function provider(): AiProviderClient {
  return {
    id: 'ollama',
    capabilities: { chat: true, streaming: true, embeddings: false, structuredOutput: false, modelListing: true },
    listModels: jest.fn().mockResolvedValue([{
      id: 'phi3', name: 'phi3', provider: 'ollama', digest: 'sha256:abc', sizeBytes: 10,
      contextWindow: 8192, capabilities: { chat: true },
    }]),
  } as unknown as AiProviderClient;
}

function projects(status: 'active' | 'archived' = 'active') {
  return {
    resolveActiveProject: jest.fn().mockImplementation(async (_owner, id) => id ? ({ _id: id, status }) : undefined),
    resolveOwnedProject: jest.fn().mockImplementation(async (_owner, id) => id ? ({ _id: id, status }) : undefined),
  };
}

function dispatcher(overrides: Partial<BenchmarkQueueDispatcher> = {}): BenchmarkQueueDispatcher {
  return {
    enqueue: jest.fn().mockResolvedValue(undefined), wakeCancellation: jest.fn().mockResolvedValue(undefined),
    executionStatus: jest.fn().mockResolvedValue({ active: false, workerAvailable: true }),
    remove: jest.fn().mockResolvedValue(undefined), ...overrides,
  };
}

function service(repo = repository(), queue = dispatcher(), projectStore = projects()) {
  return {
    repo, queue, projects: projectStore,
    service: new BenchmarkService(repo, projectStore, provider, () => now, BENCHMARK_LIMITS.timeoutMs,
      new ProjectMutationLease(), queue, 1),
  };
}

describe('BenchmarkService durable queue control plane', () => {
  it('validates the immutable request and listed chat model without fallback', async () => {
    expect(validateBenchmarkRequest({ model: 'phi3', suiteId: 'chat-core-v1', projectId }))
      .toEqual({ model: 'phi3', suiteId: 'chat-core-v1', projectId });
    expect(() => validateBenchmarkRequest({ model: 'phi3', suiteId: 'other' })).toThrow(BenchmarkRunError);
    expect(() => validateBenchmarkRequest({ model: 'phi3', suiteId: 'chat-core-v1', temperature: 1 })).toThrow('exactly');
    const current = service();
    await expect(current.service.prepare(ownerId, { model: 'missing', suiteId: 'chat-core-v1' }))
      .rejects.toMatchObject({ code: 'BENCHMARK_MODEL_NOT_FOUND' });
  });

  it('reports the durable shared worker dependency explicitly', async () => {
    await expect(service().service.status(ownerId)).resolves.toMatchObject({
      execution: { scope: 'shared-benchmark-worker', globalLimit: 1, ownerLimit: 1,
        active: false, queueDurable: true, workerAvailable: true },
      scope: { type: 'workspace' },
      warnings: { multiReplicaCoordination: true },
    });
    await expect(service().service.status(ownerId, projectId)).resolves.toMatchObject({
      scope: { type: 'project', projectId, projectStatus: 'active' },
    });
  });

  it('keeps workspace and project history disjoint without weakening the global owner quota', async () => {
    expect(benchmarkListFilter(ownerId)).toEqual({ ownerId, projectId: { $exists: false } });
    expect(benchmarkListFilter(ownerId, projectId)).toEqual({ ownerId, projectId });
    const projectRunId = '64b000000000000000000202';
    const current = service(repository([
      record({ activeOwnerSlot: undefined, status: 'succeeded' }),
      record({ _id: projectRunId, projectId, activeOwnerSlot: undefined, status: 'succeeded' }),
    ]));
    await expect(current.service.list(ownerId)).resolves.toMatchObject({
      runs: [{ id: runId }], pagination: { total: 1 },
    });
    await expect(current.service.list(ownerId, undefined, projectId)).resolves.toMatchObject({
      runs: [{ id: projectRunId, projectId }], pagination: { total: 1 },
    });
    await expect(current.repo.count(ownerId)).resolves.toBe(2);
  });

  it('creates a Mongo run inside the project lease and enqueues only its opaque id', async () => {
    const current = service();
    const prepared = await current.service.prepare(ownerId, { model: 'phi3', suiteId: 'chat-core-v1', projectId });
    const started = await current.service.start(prepared);
    expect(started).toMatchObject({ revision: 1, status: 'queued', projectId, provider: 'ollama' });
    expect(current.repo.records[0]).toMatchObject({ ownerId, projectId, activeOwnerSlot: true, revision: 1,
      jobId: benchmarkJobId(started.id), model: { requested: { id: 'phi3', digest: 'sha256:abc' } } });
    expect(current.queue.enqueue).toHaveBeenCalledWith(started.id);
    expect(current.projects.resolveActiveProject).toHaveBeenCalledTimes(2);
  });

  it('terminalizes a created run when dispatch fails and returns a safe queue error', async () => {
    const current = service(repository(), dispatcher({ enqueue: jest.fn().mockRejectedValue(new Error('redis password')) }));
    const prepared = await current.service.prepare(ownerId, { model: 'phi3', suiteId: 'chat-core-v1' });
    await expect(current.service.start(prepared)).rejects.toMatchObject({ code: 'BENCHMARK_QUEUE_UNAVAILABLE', statusCode: 503 });
    expect(current.repo.records[0]).toMatchObject({ status: 'interrupted',
      error: { code: 'BENCHMARK_INTERRUPTED', message: 'The benchmark queue was unavailable before execution.' } });
    expect(JSON.stringify(current.repo.records[0])).not.toContain('redis password');
  });

  it('uses Mongo-first cancellation and remains durable when Pub/Sub is unavailable', async () => {
    const current = service(repository([record({ status: 'running', startedAt: now,
      execution: { fence: 1, leaseOwner: 'worker' } })]),
    dispatcher({ wakeCancellation: jest.fn().mockRejectedValue(new Error('redis down')) }));
    await expect(current.service.cancel(ownerId, runId)).resolves.toMatchObject({
      idempotent: false, run: { status: 'cancel-requested', revision: 2 },
    });
    expect(current.repo.records[0].timeline.at(-1)).toMatchObject({ type: 'cancel_requested', revision: 2, sequence: 49 });
    await expect(current.service.cancel(ownerId, runId)).resolves.toMatchObject({ idempotent: true });
  });

  it('terminalizes queued cancellation immediately even when no worker is available', async () => {
    const current = service(repository([record()]), dispatcher({
      executionStatus: jest.fn().mockResolvedValue({ active: false, workerAvailable: false }),
    }));
    await expect(current.service.cancel(ownerId, runId)).resolves.toMatchObject({
      idempotent: false, run: { status: 'cancelled', revision: 2 },
    });
    expect(current.repo.records[0].activeOwnerSlot).toBeUndefined();
    expect(current.repo.records[0].timeline.slice(-2)).toEqual([
      expect.objectContaining({ type: 'cancel_requested', revision: 2, sequence: 49 }),
      expect.objectContaining({ type: 'cancelled', revision: 2, sequence: 50 }),
    ]);
    expect(current.queue.remove).toHaveBeenCalledWith(runId);
  });

  it('reconnects terminal history as one canonical completed event', async () => {
    const terminal = record({ status: 'succeeded', activeOwnerSlot: undefined, revision: 15, completedCalls: 6, passedCalls: 6 });
    const current = service(repository([terminal])); const events: unknown[] = [];
    await expect(current.service.follow(ownerId, runId, (event) => events.push(event), undefined, 15))
      .resolves.toMatchObject({ status: 'succeeded', revision: 15 });
    expect(events).toEqual([expect.objectContaining({ type: 'completed', revision: 15,
      run: expect.objectContaining({ id: runId }) })]);
  });

  it('requeues canonical active records during reconciliation using ids only', async () => {
    const current = service(repository([record()]));
    await expect(current.service.recoverInterrupted()).resolves.toMatchObject({ interrupted: 0, requeued: 1 });
    expect(current.queue.enqueue).toHaveBeenCalledWith(runId);
  });

  it('deletes only terminal owner-scoped records and removes the transport hint', async () => {
    const current = service(repository([record({ status: 'failed', activeOwnerSlot: undefined, completedAt: now })]));
    await expect(current.service.delete(ownerId, runId)).resolves.toEqual({ runId, deleted: true });
    expect(current.queue.remove).toHaveBeenCalledWith(runId);
    expect(current.repo.records).toHaveLength(0);
  });
});
