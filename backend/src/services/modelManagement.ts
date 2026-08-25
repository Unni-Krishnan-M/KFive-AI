import { createHash, randomBytes } from 'crypto';

export type ModelManagementErrorCode =
  | 'INVALID_MODEL_NAME'
  | 'INVALID_TASK_TYPE'
  | 'MODEL_NOT_FOUND'
  | 'UNSUPPORTED_MODEL_OPERATION'
  | 'INVALID_CONFIRMATION_TOKEN'
  | 'EXPIRED_CONFIRMATION_TOKEN';

export class ModelManagementError extends Error {
  constructor(
    message: string,
    readonly code: ModelManagementErrorCode,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'ModelManagementError';
  }
}

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

export function validateModelName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ModelManagementError('A model name is required.', 'INVALID_MODEL_NAME', 400);
  }
  const model = value.trim();
  if (
    !model
    || model.length > 200
    || !MODEL_NAME.test(model)
    || model.endsWith('/')
    || model.includes('//')
    || model.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new ModelManagementError(
      'The model name is invalid. Use a provider model name containing only letters, numbers, dots, underscores, slashes, hyphens, and an optional tag.',
      'INVALID_MODEL_NAME',
      400
    );
  }
  return model;
}

export interface ModelDeletionClaims {
  userId: string;
  provider: string;
  model: string;
}

export interface ModelDeletionConfirmation {
  confirmationToken: string;
  expiresAt: string;
}

interface StoredConfirmation extends ModelDeletionClaims {
  expiresAtMs: number;
}

export interface ModelDeletionConfirmationStore {
  issue(claims: ModelDeletionClaims): ModelDeletionConfirmation;
  consume(token: unknown, claims: ModelDeletionClaims): void;
}

/**
 * Short-lived, one-use delete confirmations. Only a SHA-256 token digest is retained.
 * The store is intentionally process-local; callers must request a new token after restart.
 */
export class InMemoryModelDeletionConfirmationStore implements ModelDeletionConfirmationStore {
  private readonly records = new Map<string, StoredConfirmation>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly createToken: () => string = () => randomBytes(32).toString('base64url')
  ) {}

  issue(claims: ModelDeletionClaims): ModelDeletionConfirmation {
    this.pruneExpired();
    const confirmationToken = this.createToken();
    const expiresAtMs = this.now() + this.ttlMs;
    this.records.set(this.digest(confirmationToken), { ...claims, expiresAtMs });
    return { confirmationToken, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  consume(token: unknown, claims: ModelDeletionClaims): void {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
      throw new ModelManagementError('A valid model deletion confirmation token is required.', 'INVALID_CONFIRMATION_TOKEN', 409);
    }
    const digest = this.digest(token);
    const record = this.records.get(digest);
    if (!record) {
      throw new ModelManagementError('The model deletion confirmation token is invalid or was already used.', 'INVALID_CONFIRMATION_TOKEN', 409);
    }
    if (record.expiresAtMs <= this.now()) {
      this.records.delete(digest);
      throw new ModelManagementError('The model deletion confirmation token has expired.', 'EXPIRED_CONFIRMATION_TOKEN', 409);
    }
    if (record.userId !== claims.userId || record.provider !== claims.provider || record.model !== claims.model) {
      throw new ModelManagementError('The model deletion confirmation token does not match this request.', 'INVALID_CONFIRMATION_TOKEN', 409);
    }
    this.records.delete(digest);
  }

  private pruneExpired(): void {
    const currentTime = this.now();
    for (const [digest, record] of this.records) {
      if (record.expiresAtMs <= currentTime) this.records.delete(digest);
    }
  }

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
