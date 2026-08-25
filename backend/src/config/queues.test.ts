jest.mock('bullmq', () => {
  const Queue = jest.fn().mockImplementation(() => ({ close: jest.fn().mockResolvedValue(undefined) }));
  const Worker = jest.fn().mockImplementation(() => ({ close: jest.fn().mockResolvedValue(undefined) }));
  const QueueEvents = jest.fn().mockImplementation(() => {
    const instance = {
      on: jest.fn(),
      waitUntilReady: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    instance.on.mockReturnValue(instance);
    return instance;
  });
  return { Queue, Worker, QueueEvents };
});
jest.mock('@/utils/logger', () => ({ logger: { info: jest.fn(), error: jest.fn() } }));

import { Queue, QueueEvents, Worker } from 'bullmq';
import { CodeRunReconciler } from '@/services/codeRunReconciler';
import { closeQueues, getCodeRunsQueue, initializeQueues } from './queues';

describe('queue lifecycle', () => {
  it('initializes and closes a producer-only code-runs queue with QueueEvents', async () => {
    const sweep = jest.fn().mockResolvedValue({ examined: 0, reconciled: 0, deferred: 0, errors: 0 });
    await initializeQueues({ sweep } as unknown as CodeRunReconciler);

    const QueueMock = Queue as unknown as jest.Mock;
    const WorkerMock = Worker as unknown as jest.Mock;
    const QueueEventsMock = QueueEvents as unknown as jest.Mock;
    expect(QueueMock).toHaveBeenCalledWith('code-runs', expect.objectContaining({
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    }));
    expect(WorkerMock).toHaveBeenCalledTimes(2);
    expect(WorkerMock.mock.calls.map((call) => call[0])).not.toContain('code-runs');
    expect(QueueEventsMock).toHaveBeenCalledWith('code-runs', expect.objectContaining({
      connection: expect.any(Object),
      lastEventId: '0-0',
    }));
    expect(getCodeRunsQueue()).toBe(QueueMock.mock.results[2].value);
    expect(sweep).toHaveBeenCalledWith(QueueMock.mock.results[2].value);

    const queueInstances = QueueMock.mock.results.map((result) => result.value);
    const workerInstances = WorkerMock.mock.results.map((result) => result.value);
    const eventInstance = QueueEventsMock.mock.results[0].value;
    await closeQueues();
    for (const instance of [...queueInstances, ...workerInstances, eventInstance]) {
      expect(instance.close).toHaveBeenCalled();
    }
  });
});
