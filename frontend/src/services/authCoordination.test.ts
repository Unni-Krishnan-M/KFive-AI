import { describe, expect, it, vi } from 'vitest';
import {
  AuthCoordinationSupersededError,
  AuthCoordinator,
  type AuthSnapshot,
  type ExclusiveRunner,
} from './authCoordination';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function sharedExclusiveRunner(): ExclusiveRunner {
  let tail = Promise.resolve<unknown>(undefined);
  return async <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

function activeSnapshot(): AuthSnapshot {
  return {
    epoch: 1,
    sessionId: 'session-a',
    phase: 'active',
    user: { _id: 'user-1', email: 'user@example.invalid' },
    accessToken: 'old-access',
    csrfToken: 'old-csrf',
    isAuthenticated: true,
  };
}

function setup() {
  const storage = new MemoryStorage();
  const runExclusive = sharedExclusiveRunner();
  const first = new AuthCoordinator({ storage, runExclusive });
  const second = new AuthCoordinator({ storage, runExclusive });
  first.replaceSnapshot(activeSnapshot());
  return { storage, first, second };
}

describe('cross-tab auth coordinator', () => {
  it('coalesces two tab refreshes and makes both adopt one successor', async () => {
    const { first, second } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const request = vi.fn(async (csrfToken: string) => {
      expect(csrfToken).toBe('old-csrf');
      await gate;
      return { accessToken: 'new-access', csrfToken: 'new-csrf' };
    });

    const expected = { epoch: 1, sessionId: 'session-a', accessToken: 'old-access' };
    const one = first.refresh(expected, request);
    const two = second.refresh(expected, request);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    release();

    await expect(Promise.all([one, two])).resolves.toEqual([
      { accessToken: 'new-access', csrfToken: 'new-csrf' },
      { accessToken: 'new-access', csrfToken: 'new-csrf' },
    ]);
    expect(request).toHaveBeenCalledOnce();
    expect(first.readSnapshot()).toMatchObject({ epoch: 2, phase: 'active', accessToken: 'new-access', csrfToken: 'new-csrf' });
  });

  it('does not let a stale request from one login adopt a replacement session', async () => {
    const { first, second } = setup();
    await first.replaceSession(
      async () => ({ ok: true }),
      () => ({
        user: { _id: 'user-2', email: 'other@example.invalid' },
        tokens: { accessToken: 'other-access', csrfToken: 'other-csrf' },
      }),
    );
    const refreshRequest = vi.fn(async () => ({ accessToken: 'unexpected', csrfToken: 'unexpected' }));

    await expect(second.refresh(
      { epoch: 1, sessionId: 'session-a', accessToken: 'old-access' },
      refreshRequest,
    )).rejects.toBeInstanceOf(AuthCoordinationSupersededError);
    expect(refreshRequest).not.toHaveBeenCalled();
  });

  it('fails closed when an authentication response cannot form a valid session', async () => {
    const { first } = setup();

    await expect(first.replaceSession(
      async () => ({ ok: true }),
      () => ({ user: null, tokens: { accessToken: '', csrfToken: '' } }),
    )).rejects.toThrow('Invalid browser authentication response');
    expect(first.readSnapshot()).toMatchObject({
      phase: 'signed-out',
      isAuthenticated: false,
      accessToken: null,
      csrfToken: null,
    });
  });

  it('orders refresh before logout and revokes with the successor proof', async () => {
    const { first, second } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const refresh = first.refresh({ epoch: 1, sessionId: 'session-a', accessToken: 'old-access' }, async () => {
      await gate;
      return { accessToken: 'new-access', csrfToken: 'new-csrf' };
    });
    const logoutRequest = vi.fn(async () => undefined);
    const logout = second.logout(logoutRequest);
    release();

    await refresh;
    await logout;
    expect(logoutRequest).toHaveBeenCalledWith('new-csrf');
    expect(first.readSnapshot()).toMatchObject({ phase: 'signed-out', isAuthenticated: false, accessToken: null, csrfToken: null });
  });

  it('orders logout before refresh and blocks the later rotation', async () => {
    const { first, second } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const logout = first.logout(async () => { await gate; });
    const refreshRequest = vi.fn(async () => ({ accessToken: 'unexpected', csrfToken: 'unexpected' }));
    const refresh = second.refresh({ epoch: 1, sessionId: 'session-a', accessToken: 'old-access' }, refreshRequest);
    release();

    await logout;
    await expect(refresh).rejects.toBeInstanceOf(AuthCoordinationSupersededError);
    expect(refreshRequest).not.toHaveBeenCalled();
  });

  it('rolls back a failed logout without losing retryable credentials', async () => {
    const { first } = setup();
    await expect(first.logout(async () => { throw new Error('unavailable'); })).rejects.toThrow('unavailable');
    expect(first.readSnapshot()).toMatchObject({
      epoch: 3,
      phase: 'active',
      accessToken: 'old-access',
      csrfToken: 'old-csrf',
      isAuthenticated: true,
    });
  });

  it('fails closed when refresh rotation is ambiguous', async () => {
    const { first } = setup();
    await expect(first.refresh(
      { epoch: 1, sessionId: 'session-a', accessToken: 'old-access' },
      async () => { throw new Error('network lost after rotation'); },
    )).rejects.toThrow('network lost after rotation');
    expect(first.readSnapshot()).toMatchObject({ phase: 'signed-out', isAuthenticated: false, accessToken: null, csrfToken: null });
  });
});
