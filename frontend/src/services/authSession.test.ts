import { describe, expect, it, vi } from 'vitest';
import {
  publishClearedAuthSession,
  publishRefreshedAuthTokens,
  registerAuthSessionObserver,
} from './authSession';

describe('auth session observer', () => {
  it('updates and clears the in-memory auth store without importing it into the API client', () => {
    const updateTokens = vi.fn();
    const clear = vi.fn();
    const unregister = registerAuthSessionObserver({ updateTokens, clear });
    const tokens = { accessToken: 'access', csrfToken: 'csrf' };

    publishRefreshedAuthTokens(tokens);
    publishClearedAuthSession();

    expect(updateTokens).toHaveBeenCalledWith(tokens);
    expect(clear).toHaveBeenCalledOnce();

    unregister();
    publishClearedAuthSession();
    expect(clear).toHaveBeenCalledOnce();
  });
});

describe('auth store failure contracts', () => {
  it('does not let a stale login continuation overwrite a newer coordinated session', async () => {
    vi.resetModules();
    const storage = new Map<string, string>([['kfive-auth', JSON.stringify({
      version: 4,
      state: {
        epoch: 1, sessionId: 'session-a', phase: 'active',
        user: { _id: 'user-a', email: 'a@example.invalid' },
        accessToken: 'access-a', csrfToken: 'csrf-a', isAuthenticated: true,
      },
    })]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    let resolveLogin!: (value: any) => void;
    const loginResult = new Promise((resolve) => { resolveLogin = resolve; });
    vi.doMock('@/services/api', () => ({
      authApi: {
        login: () => loginResult,
        register: vi.fn(), logout: vi.fn(), finishLogout: vi.fn(), refresh: vi.fn(),
      },
      isAuthSessionSuperseded: () => false,
    }));
    try {
      const { useAuth } = await import('@/hooks/useAuth');
      const { getBrowserAuthCoordinator } = await import('@/services/authCoordination');
      const pending = useAuth.getState().login('old@example.invalid', 'password');
      getBrowserAuthCoordinator().replaceSnapshot({
        epoch: 2,
        sessionId: 'session-newer',
        phase: 'active',
        user: { _id: 'user-newer', email: 'newer@example.invalid' },
        accessToken: 'newer-access',
        csrfToken: 'newer-csrf',
        isAuthenticated: true,
      });
      resolveLogin({ data: { data: {
        user: { _id: 'user-old-result', email: 'old-result@example.invalid' },
        accessToken: 'old-result-access',
        csrfToken: 'old-result-csrf',
      } } });
      await pending;

      expect(useAuth.getState()).toMatchObject({
        epoch: 2,
        sessionId: 'session-newer',
        user: { _id: 'user-newer' },
        accessToken: 'newer-access',
        csrfToken: 'newer-csrf',
        isAuthenticated: true,
      });
    } finally {
      vi.doUnmock('@/services/api');
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('does not let a stale refresh failure clear a newer coordinated session', async () => {
    vi.resetModules();
    const storage = new Map<string, string>([['kfive-auth', JSON.stringify({
      version: 4,
      state: {
        epoch: 1, sessionId: 'session-a', phase: 'active',
        user: { _id: 'user-a', email: 'a@example.invalid' },
        accessToken: 'access-a', csrfToken: 'csrf-a', isAuthenticated: true,
      },
    })]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    let rejectRefresh!: (reason: unknown) => void;
    const refreshResult = new Promise((_resolve, reject) => { rejectRefresh = reject; });
    vi.doMock('@/services/api', () => ({
      authApi: {
        login: vi.fn(), register: vi.fn(), logout: vi.fn(), finishLogout: vi.fn(),
        refresh: () => refreshResult,
      },
      isAuthSessionSuperseded: () => false,
    }));
    try {
      const { useAuth } = await import('@/hooks/useAuth');
      const { getBrowserAuthCoordinator } = await import('@/services/authCoordination');
      const pending = useAuth.getState().refreshAuth();
      getBrowserAuthCoordinator().replaceSnapshot({
        epoch: 2,
        sessionId: 'session-newer',
        phase: 'active',
        user: { _id: 'user-newer', email: 'newer@example.invalid' },
        accessToken: 'newer-access',
        csrfToken: 'newer-csrf',
        isAuthenticated: true,
      });
      rejectRefresh(new Error('older refresh failed'));
      await expect(pending).rejects.toThrow('older refresh failed');

      expect(useAuth.getState()).toMatchObject({
        epoch: 2,
        sessionId: 'session-newer',
        user: { _id: 'user-newer' },
        accessToken: 'newer-access',
        csrfToken: 'newer-csrf',
        isAuthenticated: true,
      });
    } finally {
      vi.doUnmock('@/services/api');
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('does not let a stale Zustand write replace a newer cross-tab epoch', async () => {
    vi.resetModules();
    const newerRecord = JSON.stringify({
      state: {
        epoch: 7,
        sessionId: 'session-a',
        phase: 'active',
        user: { _id: 'user-1', email: 'user@example.invalid' },
        accessToken: 'newer-access',
        csrfToken: 'newer-csrf',
        isAuthenticated: true,
      },
      version: 4,
    });
    const storage = new Map<string, string>([['kfive-auth', newerRecord]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    try {
      const { useAuth } = await import('@/hooks/useAuth');
      useAuth.setState({ epoch: 6, accessToken: 'stale-access', csrfToken: 'stale-csrf' });

      expect(JSON.parse(storage.get('kfive-auth')!)).toEqual(JSON.parse(newerRecord));
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('upgrades an active version-3 record with one new session lineage', async () => {
    vi.resetModules();
    const storage = new Map<string, string>([['kfive-auth', JSON.stringify({
      state: {
        epoch: 4,
        phase: 'active',
        user: { _id: 'user-1', email: 'user@example.invalid' },
        accessToken: 'existing-access',
        csrfToken: 'existing-csrf',
        isAuthenticated: true,
      },
      version: 3,
    })]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    try {
      const { useAuth } = await import('@/hooks/useAuth');
      const state = useAuth.getState();
      expect(state).toMatchObject({
        epoch: 4,
        phase: 'active',
        accessToken: 'existing-access',
        csrfToken: 'existing-csrf',
        isAuthenticated: true,
      });
      expect(state.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      const persisted = JSON.parse(storage.get('kfive-auth')!);
      expect(persisted).toMatchObject({ version: 4, state: { epoch: 4, sessionId: state.sessionId } });
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('preserves the browser session proof when server logout fails', async () => {
    vi.resetModules();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    storage.set('kfive-auth', JSON.stringify({
      state: {
        epoch: 1,
        sessionId: 'session-a',
        phase: 'active',
        user: { _id: 'user-1', email: 'user@example.invalid' },
        accessToken: 'access',
        csrfToken: 'csrf',
        isAuthenticated: true,
      },
      version: 4,
    }));
    const { default: axios, AxiosError } = await import('axios');
    const original = axios.defaults.adapter;
    axios.defaults.adapter = async config => {
      const response = { status: 503, statusText: 'Unavailable', data: {}, headers: {}, config };
      throw new AxiosError('fixture unavailable', 'ERR_BAD_RESPONSE', config, undefined, response);
    };
    try {
      const { useAuth } = await import('@/hooks/useAuth');
      await expect(useAuth.getState().logout()).rejects.toBeInstanceOf(AxiosError);
      expect(useAuth.getState()).toMatchObject({ accessToken: 'access', csrfToken: 'csrf', isAuthenticated: true });
    } finally {
      axios.defaults.adapter = original;
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('drops a legacy persisted refresh token during the v2 migration', async () => {
    vi.resetModules();
    const storage = new Map<string, string>([[
      'kfive-auth',
      JSON.stringify({ state: { accessToken: 'legacy-access', refreshToken: 'legacy-refresh', isAuthenticated: true }, version: 1 }),
    ]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    try {
      const { useAuth } = await import('@/hooks/useAuth');
      expect(useAuth.getState()).toMatchObject({ accessToken: null, csrfToken: null, isAuthenticated: false });
      expect(storage.get('kfive-auth')).not.toContain('legacy-refresh');
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
