import {
  InMemoryModelDeletionConfirmationStore,
  ModelManagementError,
  validateModelName,
} from './modelManagement';

describe('model management validation and confirmations', () => {
  it('accepts provider model names and rejects unsafe or malformed input', () => {
    expect(validateModelName('library/qwen2.5-coder:7b')).toBe('library/qwen2.5-coder:7b');
    expect(() => validateModelName('../model')).toThrow(ModelManagementError);
    expect(() => validateModelName('model name; command')).toThrow(ModelManagementError);
  });

  it('issues a scoped one-use confirmation', () => {
    const store = new InMemoryModelDeletionConfirmationStore(60_000, () => 1_000, () => 'a'.repeat(32));
    const claims = { userId: 'user-1', provider: 'ollama', model: 'phi3:latest' };
    const confirmation = store.issue(claims);

    expect(confirmation).toEqual({
      confirmationToken: 'a'.repeat(32),
      expiresAt: new Date(61_000).toISOString(),
    });
    expect(() => store.consume(confirmation.confirmationToken, { ...claims, userId: 'user-2' }))
      .toThrow('does not match');
    expect(() => store.consume(confirmation.confirmationToken, claims)).not.toThrow();
    expect(() => store.consume(confirmation.confirmationToken, claims)).toThrow('invalid or was already used');
  });

  it('rejects an expired confirmation', () => {
    let now = 1_000;
    const store = new InMemoryModelDeletionConfirmationStore(100, () => now, () => 'b'.repeat(32));
    const claims = { userId: 'user-1', provider: 'ollama', model: 'phi3' };
    const { confirmationToken } = store.issue(claims);
    now = 1_101;
    expect(() => store.consume(confirmationToken, claims)).toThrow('expired');
  });
});

