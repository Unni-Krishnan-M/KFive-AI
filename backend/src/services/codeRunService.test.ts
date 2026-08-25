import {
  BullMqCodeRunDispatcher,
  CODE_RUNNER_CANCEL_CHANNEL,
  CODE_RUNNER_CANCEL_KEY_PREFIX,
  CODE_RUNNER_HEARTBEAT_KEY,
  CODE_RUN_LIMITS,
  CodeRunDispatcher,
  CodeRunError,
  CodeRunRecord,
  CodeRunRepository,
  CodeRunService,
  validateCodeRunInput,
} from './codeRunService';

const ownerId = '64b000000000000000000001';
const otherOwnerId = '64b000000000000000000002';
const projectId = '64b000000000000000000101';
const runId = '64b000000000000000000401';
const now = new Date('2026-01-01T00:00:00.000Z');
const queued: CodeRunRecord = {
  _id: runId,
  userId: ownerId,
  projectId,
  language: 'python',
  runtimeVersion: '3.12',
  source: 'print("hello")',
  stdin: '',
  status: 'queued',
};

function repository(overrides: Partial<CodeRunRepository> = {}): CodeRunRepository {
  return {
    create: async (data) => ({ _id: runId, ...data }),
    list: async () => [queued],
    findByOwnerAndId: async (requestedOwner, requestedId) => (
      requestedOwner === ownerId && requestedId === runId ? queued : null
    ),
    transition: async (_owner, _id, _from, changes) => ({ ...queued, ...changes }),
    ...overrides,
  };
}

function dispatcher(overrides: Partial<CodeRunDispatcher> = {}): CodeRunDispatcher {
  return {
    availability: async () => ({ available: true }),
    dispatch: async () => undefined,
    cancel: async () => 'removed',
    ...overrides,
  };
}

describe('code run input validation', () => {
  it('accepts only Python/JavaScript source, stdin, and optional project', () => {
    expect(validateCodeRunInput({ language: 'python', source: 'print(1)', stdin: '', projectId }))
      .toEqual({ language: 'python', source: 'print(1)', stdin: '', projectId });
    expect(validateCodeRunInput({ language: 'javascript', source: 'console.log(1)' }))
      .toEqual({ language: 'javascript', source: 'console.log(1)', stdin: '' });
  });

  it('rejects unsupported languages, byte overflow, and browser-controlled runtime fields', () => {
    expect(() => validateCodeRunInput({ language: 'rust', source: 'fn main() {}' })).toThrow("'python' or 'javascript'");
    expect(() => validateCodeRunInput({ language: 'python', source: 'x'.repeat(65_537) })).toThrow('65536');
    expect(() => validateCodeRunInput({ language: 'python', source: 'print(1)', stdin: 'x'.repeat(16_385) })).toThrow('16384');
    expect(() => validateCodeRunInput({ language: 'python', source: 'print(1)\0' })).toThrow('no NUL bytes');
    expect(() => validateCodeRunInput({ language: 'python', source: 'print(1)', stdin: 'bad\0input' })).toThrow('no NUL bytes');
    for (const forbidden of [
      { image: 'host/image' },
      { command: ['sh', '-c', 'id'] },
      { limits: { memoryBytes: 1 } },
      { runtimeVersion: 'custom' },
    ]) {
      expect(() => validateCodeRunInput({ language: 'python', source: 'print(1)', ...forbidden }))
        .toThrow('server-controlled');
    }
  });
});

describe('CodeRunService', () => {
  it('reports configured and live runner availability separately', async () => {
    const unavailable = new CodeRunService(
      'container',
      repository(),
      dispatcher({ availability: async () => ({ available: false, message: 'The runner heartbeat is stale.' }) })
    );
    await expect(unavailable.getRuntimeCatalog()).resolves.toMatchObject({
      enabled: true,
      available: false,
      message: 'The runner heartbeat is stale.',
      runtimes: [
        { language: 'python', available: false, message: 'The runner heartbeat is stale.' },
        { language: 'javascript', available: false, message: 'The runner heartbeat is stale.' },
      ],
    });

    const disabled = new CodeRunService('disabled', repository(), dispatcher({
      availability: async () => { throw new Error('must not probe'); },
    }));
    await expect(disabled.getRuntimeCatalog()).resolves.toMatchObject({
      enabled: false,
      available: false,
      message: expect.stringContaining('CODE_RUNNER_MODE=container'),
    });
  });

  it('reports RUNNER_DISABLED before persistence', async () => {
    const create = jest.fn(repository().create);
    const service = new CodeRunService('disabled', repository({ create }), dispatcher());
    await expect(service.create(ownerId, { language: 'python', source: 'print(1)' })).rejects.toMatchObject({
      code: 'RUNNER_DISABLED', statusCode: 503, isOperational: true,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('persists server-selected runtime/limits and dispatches only by run id', async () => {
    const create = jest.fn(repository().create);
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const resolveActive = jest.fn().mockResolvedValue({ _id: projectId, status: 'active' });
    const service = new CodeRunService(
      'container', repository({ create }), dispatcher({ dispatch }), resolveActive, jest.fn(), () => now
    );

    await expect(service.create(ownerId, {
      language: 'python', source: 'print("hello")', stdin: 'input', projectId,
    })).resolves.toEqual({ run: expect.objectContaining({ _id: runId, status: 'queued' }) });
    expect(resolveActive).toHaveBeenCalledWith(ownerId, projectId);
    expect(create).toHaveBeenCalledWith({
      userId: ownerId,
      projectId,
      language: 'python',
      runtimeVersion: '3.12',
      source: 'print("hello")',
      stdin: 'input',
      status: 'queued',
      limits: CODE_RUN_LIMITS,
      queuedAt: now,
    });
    expect(dispatch).toHaveBeenCalledWith({
      runId,
      language: 'python',
      source: 'print("hello")',
      stdin: 'input',
    });
  });

  it('marks the record failed and reports RUNNER_UNAVAILABLE when dispatch fails', async () => {
    const transition = jest.fn(repository().transition);
    const service = new CodeRunService(
      'container',
      repository({ transition }),
      dispatcher({ dispatch: async () => { throw new Error('redis secret detail'); } }),
      jest.fn().mockResolvedValue(undefined),
      jest.fn(),
      () => now
    );
    await expect(service.create(ownerId, { language: 'javascript', source: 'console.log(1)' })).rejects.toMatchObject({
      code: 'RUNNER_UNAVAILABLE', statusCode: 503,
    });
    expect(transition).toHaveBeenCalledWith(ownerId, runId, ['queued'], {
      status: 'failed',
      completedAt: now,
      result: {
        errorCode: 'RUNNER_UNAVAILABLE',
        errorMessage: 'The isolated code runner queue is unavailable.',
      },
    });
  });

  it('owner-scopes list/get and permits archived owned project filters', async () => {
    const list = jest.fn(repository().list);
    const resolveOwned = jest.fn().mockResolvedValue({ _id: projectId, status: 'archived' });
    const service = new CodeRunService(
      'container', repository({ list }), dispatcher(), jest.fn(), resolveOwned
    );
    await service.list(ownerId, projectId);
    expect(resolveOwned).toHaveBeenCalledWith(ownerId, projectId);
    expect(list).toHaveBeenCalledWith(ownerId, projectId);
    await expect(service.get(otherOwnerId, runId)).rejects.toMatchObject({
      code: 'CODE_RUN_NOT_FOUND', message: 'Code run not found.', statusCode: 404,
    });
    await expect(service.get(ownerId, '64b000000000000000000499')).rejects.toMatchObject({
      code: 'CODE_RUN_NOT_FOUND', message: 'Code run not found.', statusCode: 404,
    });
  });

  it('cancels queued/running work with idempotent terminal behavior', async () => {
    const transition = jest.fn(repository().transition);
    const cancel = jest.fn().mockResolvedValue('removed');
    const queuedService = new CodeRunService(
      'container', repository({ transition }), dispatcher({ cancel }), jest.fn(), jest.fn(), () => now
    );
    const first = await queuedService.cancel(ownerId, runId);
    expect(first).toMatchObject({ run: { status: 'cancelled' }, idempotent: false });
    expect(transition).toHaveBeenCalledWith(ownerId, runId, ['queued', 'running'], {
      status: 'cancelled', cancelRequestedAt: now, completedAt: now,
    });

    const terminalService = new CodeRunService('container', repository({
      findByOwnerAndId: async () => ({ ...queued, status: 'cancelled' }),
    }), dispatcher({ cancel }));
    await expect(terminalService.cancel(ownerId, runId)).resolves.toMatchObject({
      run: { status: 'cancelled' }, idempotent: true,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    'succeeded', 'failed', 'timed_out', 'cancelled',
    'resource_exceeded', 'output_limit', 'internal_error',
  ] as const)('treats %s as an idempotent terminal cancellation', async (status) => {
    const cancel = jest.fn();
    const service = new CodeRunService('container', repository({
      findByOwnerAndId: async () => ({ ...queued, status }),
    }), dispatcher({ cancel }));
    await expect(service.cancel(ownerId, runId)).resolves.toMatchObject({
      run: { status }, idempotent: true,
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('records a cancel request rather than claiming an active run stopped', async () => {
    const transition = jest.fn(repository().transition);
    const service = new CodeRunService(
      'container', repository({
        findByOwnerAndId: async () => ({ ...queued, status: 'running' }),
        transition,
      }), dispatcher({ cancel: async () => 'active' }), jest.fn(), jest.fn(), () => now
    );
    await expect(service.cancel(ownerId, runId)).resolves.toMatchObject({
      run: { status: 'cancel-requested' }, idempotent: false,
    });
    expect(transition).toHaveBeenCalledWith(ownerId, runId, ['queued', 'running'], {
      status: 'cancel-requested', cancelRequestedAt: now,
    });
  });

  it('treats a missing queued job as cancelled because it cannot execute', async () => {
    const transition = jest.fn(repository().transition);
    const service = new CodeRunService(
      'container', repository({ transition }), dispatcher({ cancel: async () => 'missing' }), jest.fn(), jest.fn(), () => now
    );
    await expect(service.cancel(ownerId, runId)).resolves.toMatchObject({
      run: { status: 'cancelled' }, idempotent: false,
    });
    expect(transition).toHaveBeenCalledWith(ownerId, runId, ['queued', 'running'], {
      status: 'cancelled', cancelRequestedAt: now, completedAt: now,
    });
  });

  it('uses a deterministic internal_error when a terminal queue job missed reconciliation', async () => {
    const transition = jest.fn(repository().transition);
    const service = new CodeRunService(
      'container', repository({ transition }), dispatcher({ cancel: async () => 'terminal' }), jest.fn(), jest.fn(), () => now
    );
    await expect(service.cancel(ownerId, runId)).resolves.toMatchObject({
      run: { status: 'internal_error' }, idempotent: false,
    });
    expect(transition).toHaveBeenCalledWith(ownerId, runId, ['queued', 'running'], {
      status: 'internal_error',
      cancelRequestedAt: now,
      completedAt: now,
      result: {
        errorCode: 'RECONCILIATION_MISSED',
        errorMessage: 'The runner job finished before its result could be reconciled.',
      },
    });
  });
});

describe('BullMqCodeRunDispatcher', () => {
  it('reports heartbeat availability without exposing Redis errors', async () => {
    const live = new BullMqCodeRunDispatcher(
      () => ({}) as any,
      () => ({ get: async () => '1000', set: jest.fn(), publish: jest.fn() }),
      () => 1001
    );
    await expect(live.availability()).resolves.toEqual({ available: true });

    const broken = new BullMqCodeRunDispatcher(
      () => ({}) as any,
      () => ({ get: async () => { throw new Error('redis://:secret@host'); }, set: jest.fn(), publish: jest.fn() })
    );
    await expect(broken.availability()).resolves.toEqual({
      available: false,
      message: 'The isolated code runner queue is unavailable.',
    });
  });

  it('enqueues only the typed server-created execution payload with fixed non-retrying bounded retention', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const redis = {
      get: jest.fn().mockResolvedValue('1000'),
      set: jest.fn(),
      publish: jest.fn(),
    };
    const dispatcher = new BullMqCodeRunDispatcher(() => ({ add } as any), () => redis, () => 1001);
    const payload = { runId, language: 'python' as const, source: 'print(1)', stdin: '' };
    await dispatcher.dispatch(payload);
    expect(add).toHaveBeenCalledWith('execute', payload, {
      jobId: runId,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  });

  it('rejects absent/stale heartbeats before enqueueing', async () => {
    const add = jest.fn();
    const redis = { get: jest.fn(), set: jest.fn(), publish: jest.fn() };
    const missing = new BullMqCodeRunDispatcher(
      () => ({ add } as any), () => ({ ...redis, get: jest.fn().mockResolvedValue(null) }), () => 20_000
    );
    const stale = new BullMqCodeRunDispatcher(
      () => ({ add } as any), () => ({ ...redis, get: jest.fn().mockResolvedValue('1000') }), () => 20_000
    );
    const payload = { runId, language: 'python' as const, source: 'print(1)', stdin: '' };
    await expect(missing.dispatch(payload)).rejects.toMatchObject({ code: 'RUNNER_UNAVAILABLE' });
    await expect(stale.dispatch(payload)).rejects.toMatchObject({ code: 'RUNNER_UNAVAILABLE' });
    expect(add).not.toHaveBeenCalled();
  });

  it('uses canonical Redis cancel key TTL and channel before queue removal', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const redis = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue('OK'),
      publish: jest.fn().mockResolvedValue(1),
    };
    const queue = { getJob: jest.fn().mockResolvedValue({ getState: async () => 'waiting', remove }) };
    const dispatcher = new BullMqCodeRunDispatcher(() => queue as any, () => redis);
    await expect(dispatcher.cancel(runId)).resolves.toBe('removed');
    expect(redis.set).toHaveBeenCalledWith(`${CODE_RUNNER_CANCEL_KEY_PREFIX}${runId}`, '1', { EX: 60 });
    expect(redis.publish).toHaveBeenCalledWith(CODE_RUNNER_CANCEL_CHANNEL, runId);
    expect(remove).toHaveBeenCalled();
  });

  it('reads the canonical heartbeat key', async () => {
    const redis = { get: jest.fn().mockResolvedValue('1000'), set: jest.fn(), publish: jest.fn() };
    const add = jest.fn().mockResolvedValue(undefined);
    const dispatcher = new BullMqCodeRunDispatcher(() => ({ add } as any), () => redis, () => 1001);
    await dispatcher.dispatch({ runId, language: 'python', source: 'print(1)', stdin: '' });
    expect(redis.get).toHaveBeenCalledWith(CODE_RUNNER_HEARTBEAT_KEY);
  });

  it('accepts the typed worker heartbeat while enforcing its updatedAt freshness', async () => {
    const heartbeat = JSON.stringify({
      status: 'ready',
      instanceId: 'runner-1',
      version: '0.1.0',
      languages: ['python', 'javascript'],
      concurrency: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:10.000Z',
    });
    const redis = { get: jest.fn().mockResolvedValue(heartbeat), set: jest.fn(), publish: jest.fn() };
    const add = jest.fn().mockResolvedValue(undefined);
    const dispatcher = new BullMqCodeRunDispatcher(
      () => ({ add } as any), () => redis, () => Date.parse('2026-01-01T00:00:11.000Z')
    );
    await expect(dispatcher.dispatch({ runId, language: 'python', source: 'print(1)', stdin: '' })).resolves.toBeUndefined();
    expect(add).toHaveBeenCalled();
  });

  it('returns explicit queue unavailability without leaking internal errors', async () => {
    const redis = { get: jest.fn().mockResolvedValue(String(Date.now())), set: jest.fn(), publish: jest.fn() };
    const dispatcher = new BullMqCodeRunDispatcher(() => { throw new Error('redis password'); }, () => redis);
    await expect(dispatcher.dispatch({ runId, language: 'python', source: 'print(1)', stdin: '' })).rejects.toEqual(expect.objectContaining({
      code: 'RUNNER_UNAVAILABLE', message: 'The isolated code runner queue is unavailable.',
    }));
    await expect(dispatcher.cancel(runId)).rejects.toBeInstanceOf(CodeRunError);
  });
});
