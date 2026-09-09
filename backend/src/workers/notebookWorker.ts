import { randomBytes } from 'node:crypto';
import { Job, Worker } from 'bullmq';
import { RedisClientType } from 'redis';
import { getQueueConnection } from '@/config/queues';
import { getRedisClient } from '@/config/redis';
import { NotebookRunModel } from '@/models/NotebookRun';
import {
  DockerNotebookExecutor,
  NotebookExecutionRequest,
  NotebookExecutionResult,
  NotebookIsolationError,
} from '@/services/notebookExecution';
import {
  NOTEBOOK_CANCEL_CHANNEL,
  NOTEBOOK_JOB_NAME,
  NOTEBOOK_QUEUE_NAME,
  NOTEBOOK_WORKER_HEARTBEAT_KEY,
  NOTEBOOK_WORKER_LEASE_KEY,
  NotebookJobPayload,
  notebookJobId,
} from '@/services/notebookQueue';
import { NotebookRunRecord } from '@/services/notebookRunService';
import { logger } from '@/utils/logger';

const OBJECT_ID = /^[a-f\d]{24}$/i;
const ACTIVE = ['running', 'verifying', 'cancel-requested'] as const;

export interface NotebookWorkerRepository {
  find(runId: string): Promise<NotebookRunRecord | null>;
  claim(runId: string, workerId: string, at: Date): Promise<NotebookRunRecord | null>;
  heartbeat(runId: string, workerId: string, at: Date): Promise<NotebookRunRecord | null>;
  beginVerification(runId: string, workerId: string, at: Date): Promise<NotebookRunRecord | null>;
  complete(runId: string, workerId: string, result: NotebookExecutionResult, at: Date): Promise<NotebookRunRecord | null>;
  interrupt(runId: string, workerId: string, code: string, at: Date): Promise<void>;
}

function timeline(record: NotebookRunRecord, type: string, at: Date, code?: string) {
  return { revision: record.revision + 1, sequence: record.timeline.length + 1, type, timestamp: at, ...(code ? { code } : {}) };
}

export const mongooseNotebookWorkerRepository: NotebookWorkerRepository = {
  async find(runId) {
    return NotebookRunModel.findById(runId).lean() as unknown as Promise<NotebookRunRecord | null>;
  },
  async claim(runId, workerId, at) {
    const current = await this.find(runId); if (!current || current.status !== 'queued' || !current.activeOwnerSlot) return null;
    return NotebookRunModel.findOneAndUpdate(
      { _id: runId, status: 'queued', activeOwnerSlot: true, revision: current.revision },
      { $set: { status: 'running', startedAt: at, 'execution.workerId': workerId, 'execution.heartbeatAt': at },
        $inc: { revision: 1 }, $push: { timeline: timeline(current, 'started', at) } },
      { new: true, runValidators: true }
    ).lean() as unknown as Promise<NotebookRunRecord | null>;
  },
  async heartbeat(runId, workerId, at) {
    return NotebookRunModel.findOneAndUpdate(
      { _id: runId, status: { $in: ACTIVE }, activeOwnerSlot: true, 'execution.workerId': workerId },
      { $set: { 'execution.heartbeatAt': at } },
      { new: true, runValidators: true }
    ).lean() as unknown as Promise<NotebookRunRecord | null>;
  },
  async beginVerification(runId, workerId, at) {
    const current = await this.find(runId);
    if (!current || current.status !== 'running' || current.execution?.workerId !== workerId) return null;
    return NotebookRunModel.findOneAndUpdate(
      { _id: runId, status: 'running', activeOwnerSlot: true, revision: current.revision, 'execution.workerId': workerId },
      { $set: { status: 'verifying', verificationStartedAt: at, 'execution.heartbeatAt': at },
        $inc: { revision: 1 }, $push: { timeline: timeline(current, 'verification_started', at) } },
      { new: true, runValidators: true }
    ).lean() as unknown as Promise<NotebookRunRecord | null>;
  },
  async complete(runId, workerId, result, at) {
    const current = await this.find(runId);
    if (!current || !current.activeOwnerSlot || current.execution?.workerId !== workerId || !ACTIVE.includes(current.status as typeof ACTIVE[number])) return null;
    const cancellation = current.status === 'cancel-requested' || result.status === 'cancelled';
    const status = cancellation ? 'cancelled' : result.status;
    const type = status === 'succeeded' ? 'completed' : status === 'cancelled' ? 'cancelled' : status === 'interrupted' ? 'interrupted' : 'failed';
    const error = result.error ?? (status === 'timed_out'
      ? { code: 'NOTEBOOK_TIMEOUT', message: 'Notebook execution exceeded its wall-clock limit.' }
      : status === 'resource_exceeded' ? { code: 'NOTEBOOK_RESOURCE_LIMIT', message: 'Notebook exceeded its resource limit.' }
        : status === 'interrupted' ? { code: 'NOTEBOOK_INTERRUPTED', message: 'Notebook execution was interrupted safely.' } : undefined);
    const update: Record<string, unknown> = {
      status, activeOwnerSlot: false, completedAt: at,
      result: { durationMs: result.durationMs, runtimeImageId: result.runtimeImageId, verifierImageId: result.verifierImageId },
      metrics: status === 'succeeded' ? result.metrics : [], artifacts: status === 'succeeded' ? result.artifacts : [],
      ...(status === 'succeeded' ? { executedNotebookJson: result.executedNotebookJson } : {}),
      ...(error && status !== 'cancelled' ? { error } : {}),
      'execution.heartbeatAt': at,
    };
    return NotebookRunModel.findOneAndUpdate(
      { _id: runId, status: current.status, activeOwnerSlot: true, revision: current.revision, 'execution.workerId': workerId },
      { $set: update, $unset: { 'execution.runtimeContainerId': 1 }, $inc: { revision: 1 },
        $push: { timeline: timeline(current, type, at, error?.code) } },
      { new: true, runValidators: true }
    ).lean() as unknown as Promise<NotebookRunRecord | null>;
  },
  async interrupt(runId, workerId, code, at) {
    const current = await this.find(runId);
    if (!current || !current.activeOwnerSlot || current.execution?.workerId !== workerId || !ACTIVE.includes(current.status as typeof ACTIVE[number])) return;
    await NotebookRunModel.updateOne(
      { _id: runId, status: current.status, activeOwnerSlot: true, revision: current.revision, 'execution.workerId': workerId },
      { $set: { status: 'interrupted', activeOwnerSlot: false, completedAt: at,
        error: { code, message: 'Notebook execution was interrupted safely.' }, 'execution.heartbeatAt': at },
      $unset: { 'execution.runtimeContainerId': 1 }, $inc: { revision: 1 },
      $push: { timeline: timeline(current, 'interrupted', at, code) } }, { runValidators: true });
  },
};

export interface NotebookExecutionEngine {
  reapOwnedContainers(): Promise<number>;
  verifyHostSecurity(): Promise<void>;
  imageIdentities(): Promise<{ runtimeImageId: string; verifierImageId: string }>;
  execute(request: NotebookExecutionRequest, cancellation?: AbortSignal,
    lifecycle?: { runtimeRemoved(): Promise<void> }): Promise<NotebookExecutionResult>;
}

type NotebookAbortReason = 'user-cancel' | 'shutdown' | 'lease-lost' | 'heartbeat-lost';

class NotebookWorkerAuthorityError extends Error {
  constructor(readonly code: 'NOTEBOOK_WORKER_LEASE_LOST' | 'NOTEBOOK_WORKER_HEARTBEAT_LOST' | 'NOTEBOOK_WORKER_SHUTDOWN') {
    super('Notebook worker authority was lost during execution.');
    this.name = 'NotebookWorkerAuthorityError';
  }
}

interface ActiveNotebookExecution { controller: AbortController; reason?: NotebookAbortReason }

export class NotebookWorkerRuntime {
  private readonly active = new Map<string, ActiveNotebookExecution>();
  private stopping = false;
  private leaseLost = false;
  constructor(
    private readonly repository: NotebookWorkerRepository,
    private readonly executor: NotebookExecutionEngine,
    private readonly workerId: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  async selfCheck(): Promise<{ runtimeImageId: string; verifierImageId: string }> {
    await this.executor.reapOwnedContainers();
    await this.executor.verifyHostSecurity();
    const identity = await this.executor.imageIdentities();
    const canaryId = randomBytes(12).toString('hex');
    const result = await this.executor.execute({ runId: canaryId, cellTimeoutSeconds: 10,
      cells: [{ id: 'self_check', type: 'code', source: "print('kfive-notebook-self-check')", tags: [] }] });
    if (result.status !== 'succeeded' || result.runtimeImageId !== identity.runtimeImageId || result.verifierImageId !== identity.verifierImageId)
      throw new NotebookIsolationError('Notebook isolation self-check failed.');
    return identity;
  }

  async process(job: Pick<Job<NotebookJobPayload>, 'id' | 'name' | 'data'>): Promise<{ runId: string; status: string }> {
    if (this.stopping) throw new Error('Notebook worker is stopping.');
    const runId = job.data?.runId;
    if (job.name !== NOTEBOOK_JOB_NAME || typeof runId !== 'string' || !OBJECT_ID.test(runId) || job.id !== notebookJobId(runId))
      throw new Error('Notebook queue job contract is invalid.');
    const claimed = await this.repository.claim(runId, this.workerId, this.now());
    if (!claimed) {
      const current = await this.repository.find(runId);
      if (!current || current.status === 'cancelled' || !current.activeOwnerSlot) return { runId, status: current?.status ?? 'missing' };
      throw new Error('Notebook run could not be claimed safely.');
    }
    const controller = new AbortController(); this.active.set(runId, { controller });
    const heartbeat = setInterval(() => void this.repository.heartbeat(runId, this.workerId, this.now())
      .then((current) => {
        if (!current) this.abort(runId, 'heartbeat-lost');
        else if (current.status === 'cancel-requested') this.abort(runId, 'user-cancel');
      }).catch(() => this.abort(runId, 'heartbeat-lost')), 5_000); heartbeat.unref();
    try {
      const result = await this.executor.execute({ runId, cells: claimed.cells, cellTimeoutSeconds: claimed.cellTimeoutSeconds },
        controller.signal, { runtimeRemoved: async () => {
          this.assertAuthority(runId);
          const verifying = await this.repository.beginVerification(runId, this.workerId, this.now());
          if (!verifying) { controller.abort(); throw new NotebookIsolationError('Notebook verification transition was rejected.'); }
        } });
      this.assertAuthority(runId);
      const completed = await this.repository.complete(runId, this.workerId, result, this.now());
      if (!completed) throw new Error('Notebook terminal transition was rejected.');
      return { runId, status: completed.status };
    } catch (error) {
      const code = error instanceof NotebookWorkerAuthorityError ? error.code
        : error instanceof NotebookIsolationError ? error.code : 'NOTEBOOK_WORKER_INTERRUPTED';
      await this.repository.interrupt(runId, this.workerId, code, this.now()).catch(() => undefined);
      throw error;
    } finally {
      clearInterval(heartbeat); this.active.delete(runId);
    }
  }

  private abort(runId: string, reason: NotebookAbortReason): void {
    const active = this.active.get(runId); if (!active) return;
    if (!active.reason || reason === 'lease-lost') active.reason = reason;
    active.controller.abort();
  }

  private assertAuthority(runId: string): void {
    const reason = this.active.get(runId)?.reason;
    if (this.leaseLost || reason === 'lease-lost') throw new NotebookWorkerAuthorityError('NOTEBOOK_WORKER_LEASE_LOST');
    if (reason === 'heartbeat-lost') throw new NotebookWorkerAuthorityError('NOTEBOOK_WORKER_HEARTBEAT_LOST');
    if (reason === 'shutdown') throw new NotebookWorkerAuthorityError('NOTEBOOK_WORKER_SHUTDOWN');
  }

  cancel(runId: string): void { this.abort(runId, 'user-cancel'); }
  stop(reason: 'shutdown' | 'lease-lost' = 'shutdown'): void {
    this.stopping = true; if (reason === 'lease-lost') this.leaseLost = true;
    for (const runId of this.active.keys()) this.abort(runId, reason);
  }
}

export interface NotebookWorkerHandle { worker: Worker<NotebookJobPayload>; subscriber: RedisClientType; close(): Promise<void> }

export async function startNotebookWorker(
  executor: DockerNotebookExecutor,
  onFatal: (error: Error) => void = (error) => logger.error('Notebook worker fatal error', { error: error.message })
): Promise<NotebookWorkerHandle> {
  const redis = getRedisClient(); const workerId = `notebook-worker-${randomBytes(12).toString('hex')}`;
  const leaseToken = randomBytes(24).toString('hex');
  const acquired = await redis.set(NOTEBOOK_WORKER_LEASE_KEY, leaseToken, { NX: true, PX: 15_000 });
  if (acquired !== 'OK') throw new Error('Another notebook worker owns the global execution lease.');
  const renewLease = async () => {
    const renewed = await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      { keys: [NOTEBOOK_WORKER_LEASE_KEY], arguments: [leaseToken, '15000'] }
    );
    if (renewed !== 1) throw new Error('Notebook worker lost its global execution lease.');
  };
  const runtime = new NotebookWorkerRuntime(mongooseNotebookWorkerRepository, executor, workerId);
  let bootstrapLeaseLost = false;
  const bootstrapLeaseTimer = setInterval(() => void renewLease().catch(() => {
    bootstrapLeaseLost = true; runtime.stop('lease-lost');
  }), 5_000);
  bootstrapLeaseTimer.unref();
  let identities: { runtimeImageId: string; verifierImageId: string };
  try {
    identities = await runtime.selfCheck();
    if (bootstrapLeaseLost) throw new Error('Notebook worker lost its global lease during isolation self-check.');
    await renewLease();
  } catch (error) {
    clearInterval(bootstrapLeaseTimer);
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      { keys: [NOTEBOOK_WORKER_LEASE_KEY], arguments: [leaseToken] }).catch(() => undefined);
    throw error;
  }
  clearInterval(bootstrapLeaseTimer);
  const subscriber = redis.duplicate(); await subscriber.connect();
  await subscriber.subscribe(NOTEBOOK_CANCEL_CHANNEL, (runId) => { if (OBJECT_ID.test(runId)) runtime.cancel(runId); });
  const worker = new Worker<NotebookJobPayload>(NOTEBOOK_QUEUE_NAME, (job) => runtime.process(job), {
    connection: getQueueConnection(), concurrency: 1, maxStalledCount: 0, lockDuration: 360_000,
  });
  await worker.waitUntilReady();
  let lastHeartbeatValue: string | undefined;
  const heartbeat = async () => {
    const value = JSON.stringify({ timestamp: Date.now(), workerId, isolationVerified: true, ...identities });
    await redis.set(NOTEBOOK_WORKER_HEARTBEAT_KEY, value, { PX: 15_000 }); lastHeartbeatValue = value;
  };
  const deleteOwnedHeartbeat = async () => {
    if (!lastHeartbeatValue) return;
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      { keys: [NOTEBOOK_WORKER_HEARTBEAT_KEY], arguments: [lastHeartbeatValue] }
    ).catch(() => undefined);
  };
  await heartbeat(); const timer = setInterval(() => void heartbeat().catch(() => logger.error('Notebook worker heartbeat failed')), 5_000);
  timer.unref();
  let closed = false;
  let leaseTimer: NodeJS.Timeout;
  const closeResources = async (force: boolean, releaseLease: boolean) => {
    if (closed) return; closed = true; clearInterval(timer); clearInterval(leaseTimer);
    runtime.stop(force ? 'lease-lost' : 'shutdown'); await worker.close(force); await deleteOwnedHeartbeat();
    if (releaseLease) await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      { keys: [NOTEBOOK_WORKER_LEASE_KEY], arguments: [leaseToken] }
    ).catch(() => undefined);
    await subscriber.unsubscribe(NOTEBOOK_CANCEL_CHANNEL).catch(() => undefined);
    await subscriber.quit().catch(() => undefined);
  };
  leaseTimer = setInterval(() => void renewLease().catch((cause) => {
    const error = cause instanceof Error ? cause : new Error('Notebook worker lost its global execution lease.');
    logger.error('Notebook worker lease renewal failed', { error: error.message });
    void closeResources(true, false).finally(() => onFatal(error));
  }), 5_000); leaseTimer.unref();
  worker.on('failed', (job, error) => logger.error('Notebook queue job failed', { runId: job?.data.runId, error: error.message }));
  return { worker, subscriber, close: () => closeResources(false, true) };
}
