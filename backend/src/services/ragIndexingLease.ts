import { randomUUID } from 'crypto';
import { RagSourceModel } from '@/models/RagSource';

export const RAG_INDEXING_MAX_ATTEMPTS = 3;
export interface RagIndexingClaim { sourceId: string; token: string; attempt: number; content: string }

// Mongo server time governs expiry, so worker clock skew cannot extend ownership.
export class RagIndexingLease {
  constructor(private readonly ttlMs = 30_000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300_000) throw new Error('Invalid indexing lease duration');
  }

  async claim(sourceId: string): Promise<RagIndexingClaim | undefined> {
    this.validateId(sourceId);
    const token = randomUUID();
    const record = await RagSourceModel.findOneAndUpdate({
      _id: sourceId, status: { $in: ['queued', 'indexing'] }, contentSnapshot: { $type: 'string' },
      $expr: { $and: [
        { $lt: [{ $ifNull: ['$indexingLease.attempt', 0] }, RAG_INDEXING_MAX_ATTEMPTS] },
        { $lte: [{ $ifNull: ['$indexingLease.expiresAt', new Date(0)] }, '$$NOW'] },
      ] },
    }, [{ $set: {
      status: 'indexing', 'indexingLease.token': token,
      'indexingLease.attempt': { $add: [{ $ifNull: ['$indexingLease.attempt', 0] }, 1] },
      'indexingLease.expiresAt': { $add: ['$$NOW', this.ttlMs] }, updatedAt: '$$NOW',
    } }], { new: true }).select('+contentSnapshot +indexingLease').lean<{
      contentSnapshot: string; indexingLease: { attempt: number };
    }>();
    return record ? { sourceId, token, attempt: record.indexingLease.attempt, content: record.contentSnapshot } : undefined;
  }

  ownershipFilter(claim: Pick<RagIndexingClaim, 'sourceId' | 'token'>) {
    this.validateId(claim.sourceId);
    if (!/^[a-f\d-]{36}$/.test(claim.token)) throw new Error('Invalid indexing lease token');
    return { _id: claim.sourceId, status: 'indexing', 'indexingLease.token': claim.token,
      $expr: { $gt: ['$indexingLease.expiresAt', '$$NOW'] } };
  }

  async renew(claim: RagIndexingClaim): Promise<boolean> {
    const result = await RagSourceModel.updateOne(this.ownershipFilter(claim), [
      { $set: { 'indexingLease.expiresAt': { $add: ['$$NOW', this.ttlMs] }, updatedAt: '$$NOW' } },
    ]);
    return result.matchedCount === 1;
  }

  private validateId(sourceId: string): void {
    if (typeof sourceId !== 'string' || !/^[a-f\d]{24}$/i.test(sourceId)) throw new Error('Invalid indexing source id');
  }
}
