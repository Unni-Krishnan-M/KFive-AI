import { RagSourceModel } from '@/models/RagSource';
import { RagIndexingClaim, RagIndexingLease, RAG_INDEXING_MAX_ATTEMPTS } from './ragIndexingLease';

export interface RagIndexingWorkStore {
  candidates(): Promise<string[]>;
  claim(id: string): Promise<RagIndexingClaim | undefined>;
  renew(claim: RagIndexingClaim): Promise<boolean>;
}

const lease = new RagIndexingLease();
export const mongooseRagIndexingWorkStore: RagIndexingWorkStore = {
  async candidates() {
    // Only queued rows and previously claimed rows belong to this worker.
    // Never steal legacy synchronous indexing, which has no lease token.
    const eligible = {
      $or: [{ status: 'queued' }, { status: 'indexing', 'indexingLease.token': { $exists: true } }],
      $expr: { $lte: [{ $ifNull: ['$indexingLease.expiresAt', new Date(0)] }, '$$NOW'] },
    };
    const rows = await RagSourceModel.find(eligible).sort({ updatedAt: 1, _id: 1 })
      .limit(20).select({ _id: 1, contentSnapshot: 1, indexingLease: 1 }).lean();
    const result: string[] = [];
    for (const row of rows) {
      if (!row.contentSnapshot || (row.indexingLease?.attempt ?? 0) >= RAG_INDEXING_MAX_ATTEMPTS) {
        await RagSourceModel.updateOne({ _id: row._id, ...eligible }, {
          $set: { status: 'failed', errorCode: 'RAG_INGESTION_FAILED' },
        });
      } else result.push(String(row._id));
    }
    return result;
  },
  claim: (id) => lease.claim(id),
  renew: (claim) => lease.renew(claim),
};

// Mongo is the durable queue. Polling rediscovers work after process death;
// per-source server-time leases arbitrate concurrent API processes.
export class RagIndexingWorker {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = true;

  constructor(
    private readonly execute: (claim: RagIndexingClaim) => Promise<void>,
    private readonly reportFailure: () => void,
    private readonly store: RagIndexingWorkStore = mongooseRagIndexingWorkStore,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, 2000);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  private tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.processBatch().catch(() => this.reportFailure()).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async processBatch(): Promise<void> {
    for (const id of await this.store.candidates()) {
      if (this.stopped) break;
      const claim = await this.store.claim(id);
      if (!claim) continue;
      let renewing = false;
      let lost = false;
      let renewal: Promise<void> | undefined;
      const heartbeat = setInterval(() => {
        if (renewing || lost) return;
        renewing = true;
        renewal = this.store.renew(claim).then((owned) => { lost = !owned; })
          .catch(() => { lost = true; })
          .finally(() => { renewing = false; });
      }, 10_000);
      heartbeat.unref();
      try { await this.execute(claim); }
      catch { this.reportFailure(); }
      finally { clearInterval(heartbeat); await renewal; }
    }
  }
}
