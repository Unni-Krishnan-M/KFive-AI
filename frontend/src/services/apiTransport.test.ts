import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function setup() {
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
      accessToken: 'old-access',
      csrfToken: 'old-csrf',
      isAuthenticated: true,
    },
    version: 4,
  }));
  const { default: axios, AxiosError } = await import('axios');
  return { storage, axios, AxiosError };
}

describe('API Axios transport contract', () => {
  it('preserves bearer credentials and multipart data through request transforms', async () => {
    await setup();
    const { apiClient, documentApi } = await import('./api');
    const original = apiClient.defaults.adapter;
    let captured: InternalAxiosRequestConfig | undefined;
    apiClient.defaults.adapter = async config => {
      captured = config;
      return { status: 200, statusText: 'OK', data: { success: true }, headers: {}, config };
    };
    try {
      const data = new FormData();
      data.set('document', new Blob(['fixture'], { type: 'text/plain' }), 'fixture.txt');
      await documentApi.uploadDocument(data, 'project-fixture');
      expect(captured?.headers.get('Authorization')).toBe('Bearer old-access');
      expect(captured?.headers.get('Content-Type')).toBe('multipart/form-data');
      expect(captured?.data).toBe(data);
      expect(data.get('projectId')).toBe('project-fixture');
      expect(captured?.url).toBe('/documents');
      expect(captured?.timeout).toBe(90000);
    } finally { apiClient.defaults.adapter = original; }
  });

  it('refreshes an expired token and retries with the new bearer credential', async () => {
    const { axios, AxiosError, storage } = await setup();
    const original = axios.defaults.adapter;
    const requests: Array<{ url?: string; auth: unknown }> = [];
    const adapter: AxiosAdapter = async config => {
      requests.push({ url: config.url, auth: config.headers.get('Authorization') });
      const response = { status: 200, statusText: 'OK', data: {}, headers: {}, config };
      if (config.url === '/auth/refresh') {
        expect(JSON.parse(config.data)).toEqual({});
        expect(config.withCredentials).toBe(true);
        expect(config.headers.get('X-KFive-Auth-Transport')).toBe('cookie');
        expect(config.headers.get('X-KFive-CSRF')).toBe('old-csrf');
        return { ...response, data: { data: { accessToken: 'new-access', csrfToken: 'new-csrf' } } };
      }
      if (config.headers.get('Authorization') === 'Bearer old-access') {
        throw new AxiosError('fixture expired', 'ERR_BAD_REQUEST', config, undefined, { ...response, status: 401 });
      }
      return response;
    };
    axios.defaults.adapter = adapter;
    try {
      const { apiClient } = await import('./api');
      await expect(apiClient.get('/projects')).resolves.toMatchObject({ status: 200 });
      expect(requests).toEqual([
        { url: '/projects', auth: 'Bearer old-access' },
        { url: '/auth/refresh', auth: undefined },
        { url: '/projects', auth: 'Bearer new-access' },
      ]);
      expect(JSON.parse(storage.get('kfive-auth')!).state).toMatchObject({
        epoch: 2, phase: 'active', accessToken: 'new-access', csrfToken: 'new-csrf', isAuthenticated: true,
      });
    } finally { axios.defaults.adapter = original; }
  });

  it('coalesces concurrent protected 401 responses into one cookie rotation', async () => {
    const { axios, AxiosError, storage } = await setup();
    const original = axios.defaults.adapter;
    let refreshRequests = 0;
    const protectedAttempts = new Map<string, number>();
    let releaseRefresh!: () => void;
    const refreshRelease = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const adapter: AxiosAdapter = async config => {
      const response = { status: 200, statusText: 'OK', data: {}, headers: {}, config };
      if (config.url === '/auth/refresh') {
        refreshRequests += 1;
        await refreshRelease;
        return { ...response, data: { data: { accessToken: 'new-access', csrfToken: 'new-csrf' } } };
      }
      const attempts = (protectedAttempts.get(config.url || '') || 0) + 1;
      protectedAttempts.set(config.url || '', attempts);
      if (config.headers.get('Authorization') === 'Bearer old-access') {
        throw new AxiosError('fixture expired', 'ERR_BAD_REQUEST', config, undefined, { ...response, status: 401 });
      }
      expect(config.headers.get('Authorization')).toBe('Bearer new-access');
      return response;
    };
    axios.defaults.adapter = adapter;
    try {
      const { apiClient } = await import('./api');
      const first = apiClient.get('/projects');
      const second = apiClient.get('/user/usage');
      await vi.waitFor(() => expect(refreshRequests).toBe(1));
      releaseRefresh();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(refreshRequests).toBe(1);
      expect(Object.fromEntries(protectedAttempts)).toEqual({ '/projects': 2, '/user/usage': 2 });
      expect(JSON.parse(storage.get('kfive-auth')!).state).toMatchObject({
        epoch: 2, phase: 'active', accessToken: 'new-access', csrfToken: 'new-csrf', isAuthenticated: true,
      });
    } finally { axios.defaults.adapter = original; }
  });

  it('coalesces direct bootstrap and interceptor refresh into one cookie rotation', async () => {
    const { axios, AxiosError } = await setup();
    const original = axios.defaults.adapter;
    let refreshRequests = 0;
    let protectedRequests = 0;
    let releaseRefresh!: () => void;
    const refreshRelease = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    axios.defaults.adapter = async config => {
      const response = { status: 200, statusText: 'OK', data: {}, headers: {}, config };
      if (config.url === '/auth/refresh') {
        refreshRequests += 1;
        await refreshRelease;
        return { ...response, data: { data: { accessToken: 'new-access', csrfToken: 'new-csrf' } } };
      }
      protectedRequests += 1;
      if (config.headers.get('Authorization') === 'Bearer old-access') {
        throw new AxiosError('fixture expired', 'ERR_BAD_REQUEST', config, undefined, { ...response, status: 401 });
      }
      return response;
    };
    try {
      const { apiClient, authApi } = await import('./api');
      const bootstrap = authApi.refresh('old-csrf');
      const intercepted = apiClient.get('/projects');
      await vi.waitFor(() => expect(protectedRequests).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(refreshRequests).toBe(1);
      releaseRefresh();
      await expect(bootstrap).resolves.toMatchObject({ data: { data: { accessToken: 'new-access' } } });
      await expect(intercepted).resolves.toMatchObject({ status: 200 });
      expect(refreshRequests).toBe(1);
    } finally { axios.defaults.adapter = original; }
  });

  it('waits for an in-flight rotation and logs out with the successor CSRF proof', async () => {
    const { axios } = await setup();
    const original = axios.defaults.adapter;
    let releaseRefresh!: () => void;
    const refreshRelease = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const requests: Array<{ url?: string; csrf: unknown }> = [];
    axios.defaults.adapter = async config => {
      requests.push({ url: config.url, csrf: config.headers.get('X-KFive-CSRF') });
      if (config.url === '/auth/refresh') {
        await refreshRelease;
        return { status: 200, statusText: 'OK', data: { data: { accessToken: 'new-access', csrfToken: 'new-csrf' } }, headers: {}, config };
      }
      return { status: 200, statusText: 'OK', data: { success: true }, headers: {}, config };
    };
    try {
      const { authApi } = await import('./api');
      const refresh = authApi.refresh('old-csrf');
      const logout = authApi.logout('old-csrf');
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      releaseRefresh();
      await Promise.all([refresh, logout]);
      authApi.finishLogout();
      expect(requests).toEqual([
        { url: '/auth/refresh', csrf: 'old-csrf' },
        { url: '/auth/logout', csrf: 'new-csrf' },
      ]);
    } finally { axios.defaults.adapter = original; }
  });

  it('blocks a late protected-request refresh after logout has begun', async () => {
    const { axios, AxiosError } = await setup();
    const original = axios.defaults.adapter;
    let releaseProtected!: () => void;
    let releaseLogout!: () => void;
    const protectedRelease = new Promise<void>((resolve) => { releaseProtected = resolve; });
    const logoutRelease = new Promise<void>((resolve) => { releaseLogout = resolve; });
    let protectedStarted = false;
    let logoutStarted = false;
    let refreshRequests = 0;
    axios.defaults.adapter = async config => {
      const response = { status: 200, statusText: 'OK', data: {}, headers: {}, config };
      if (config.url === '/projects') {
        protectedStarted = true;
        await protectedRelease;
        throw new AxiosError('fixture expired', 'ERR_BAD_REQUEST', config, undefined, { ...response, status: 401 });
      }
      if (config.url === '/auth/logout') {
        logoutStarted = true;
        await logoutRelease;
        return { ...response, data: { success: true } };
      }
      if (config.url === '/auth/refresh') refreshRequests += 1;
      return { ...response, data: { data: { accessToken: 'unexpected', csrfToken: 'unexpected' } } };
    };
    try {
      const { apiClient, authApi } = await import('./api');
      const protectedRequest = apiClient.get('/projects');
      await vi.waitFor(() => expect(protectedStarted).toBe(true));
      const logout = authApi.logout('old-csrf');
      await vi.waitFor(() => expect(logoutStarted).toBe(true));
      releaseProtected();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(refreshRequests).toBe(0);
      releaseLogout();
      await logout;
      await expect(protectedRequest).rejects.toBeInstanceOf(AxiosError);
      authApi.finishLogout();
      expect(refreshRequests).toBe(0);
    } finally { axios.defaults.adapter = original; }
  });

  it('does not replay a stale protected request under a replacement login', async () => {
    const { axios, AxiosError, storage } = await setup();
    const original = axios.defaults.adapter;
    let releaseProtected!: () => void;
    const protectedRelease = new Promise<void>((resolve) => { releaseProtected = resolve; });
    let protectedRequests = 0;
    let refreshRequests = 0;
    axios.defaults.adapter = async config => {
      const response = { status: 200, statusText: 'OK', data: {}, headers: {}, config };
      if (config.url === '/projects') {
        protectedRequests += 1;
        await protectedRelease;
        throw new AxiosError('fixture expired', 'ERR_BAD_REQUEST', config, undefined, { ...response, status: 401 });
      }
      if (config.url === '/auth/login') {
        return {
          ...response,
          data: { data: {
            user: { _id: 'user-2', email: 'other@example.invalid' },
            accessToken: 'other-access',
            csrfToken: 'other-csrf',
          } },
        };
      }
      if (config.url === '/auth/refresh') refreshRequests += 1;
      return response;
    };
    try {
      const { apiClient, authApi } = await import('./api');
      const staleRequest = apiClient.get('/projects');
      await vi.waitFor(() => expect(protectedRequests).toBe(1));
      await authApi.login('other@example.invalid', 'password');
      releaseProtected();

      await expect(staleRequest).rejects.toBeInstanceOf(AxiosError);
      expect(protectedRequests).toBe(1);
      expect(refreshRequests).toBe(0);
      expect(JSON.parse(storage.get('kfive-auth')!).state).toMatchObject({
        user: { _id: 'user-2' }, accessToken: 'other-access', phase: 'active',
      });
    } finally { axios.defaults.adapter = original; }
  });

  it('does not erase a replacement session after an older refresh fails', async () => {
    const { axios, AxiosError, storage } = await setup();
    let installedReplacement = false;
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
        const state = JSON.parse(value)?.state;
        if (!installedReplacement && state?.phase === 'signed-out') {
          installedReplacement = true;
          storage.set('kfive-auth', JSON.stringify({
            version: 4,
            state: {
              epoch: state.epoch + 1,
              sessionId: 'replacement-session',
              phase: 'active',
              user: { _id: 'user-2', email: 'other@example.invalid' },
              accessToken: 'replacement-access',
              csrfToken: 'replacement-csrf',
              isAuthenticated: true,
            },
          }));
        }
      },
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubGlobal('window', { location: { href: '/app/projects' } });
    const original = axios.defaults.adapter;
    axios.defaults.adapter = async config => {
      const response = { status: 401, statusText: 'Unauthorized', data: {}, headers: {}, config };
      if (config.url === '/auth/refresh') {
        throw new AxiosError('refresh failed', 'ERR_BAD_RESPONSE', config, undefined, response);
      }
      throw new AxiosError('access expired', 'ERR_BAD_REQUEST', config, undefined, response);
    };
    try {
      const { apiClient } = await import('./api');
      await expect(apiClient.get('/projects')).rejects.toBeInstanceOf(AxiosError);
      expect(installedReplacement).toBe(true);
      expect(JSON.parse(storage.get('kfive-auth')!).state).toMatchObject({
        sessionId: 'replacement-session',
        phase: 'active',
        user: { _id: 'user-2' },
        accessToken: 'replacement-access',
      });
      expect(window.location.href).toBe('/app/projects');
    } finally {
      axios.defaults.adapter = original;
    }
  });

  it('clears an unrecoverable authenticated state when no CSRF proof remains', async () => {
    const { axios, AxiosError, storage } = await setup();
    storage.set('kfive-auth', JSON.stringify({
      state: { epoch: 1, sessionId: 'session-a', phase: 'active', user: { _id: 'user-1' }, accessToken: 'old-access', csrfToken: null, isAuthenticated: true },
      version: 4,
    }));
    vi.stubGlobal('window', { location: { href: '/app/dashboard' } });
    const original = axios.defaults.adapter;
    axios.defaults.adapter = async config => {
      const response = { status: 401, statusText: 'Unauthorized', data: {}, headers: {}, config };
      throw new AxiosError('fixture expired', 'ERR_BAD_REQUEST', config, undefined, response);
    };
    try {
      const { apiClient } = await import('./api');
      await expect(apiClient.get('/projects')).rejects.toBeInstanceOf(AxiosError);
      expect(JSON.parse(storage.get('kfive-auth')!).state).toMatchObject({ phase: 'signed-out', isAuthenticated: false });
      expect(window.location.href).toBe('/login');
    } finally { axios.defaults.adapter = original; }
  });

  it('uses cookie mode for browser login and logout without sending refresh credentials', async () => {
    const { axios, storage } = await setup();
    const original = axios.defaults.adapter;
    const captured: InternalAxiosRequestConfig[] = [];
    axios.defaults.adapter = async config => {
      captured.push(config);
      if (config.url === '/auth/login') {
        return {
          status: 200, statusText: 'OK',
          data: { data: { user: { _id: 'user-1', email: 'user@example.invalid' }, accessToken: 'login-access', csrfToken: 'login-csrf' } },
          headers: {}, config,
        };
      }
      return { status: 200, statusText: 'OK', data: { success: true }, headers: {}, config };
    };
    try {
      const { authApi } = await import('./api');
      await authApi.login('user@example.invalid', 'password');
      await authApi.logout('csrf-fixture');
      expect(captured).toHaveLength(2);
      expect(captured[0].withCredentials).toBe(true);
      expect(captured[0].headers.get('X-KFive-Auth-Transport')).toBe('cookie');
      expect(captured[0].headers.get('Authorization')).toBeUndefined();
      expect(JSON.parse(captured[0].data as string)).toEqual({ email: 'user@example.invalid', password: 'password' });
      expect(captured[1].headers.get('X-KFive-CSRF')).toBe('login-csrf');
      expect(JSON.parse(captured[1].data as string)).toEqual({});
      expect(storage.get('kfive-auth')).not.toContain('refresh');
    } finally { axios.defaults.adapter = original; }
  });

  it('does not attempt cookie refresh after an authentication endpoint rejects credentials', async () => {
    const { axios, AxiosError } = await setup();
    const original = axios.defaults.adapter;
    const requests: string[] = [];
    axios.defaults.adapter = async config => {
      requests.push(config.url || '');
      const response = { status: 401, statusText: 'Unauthorized', data: {}, headers: {}, config };
      throw new AxiosError('fixture rejected', 'ERR_BAD_REQUEST', config, undefined, response);
    };
    try {
      const { authApi } = await import('./api');
      await expect(authApi.login('missing@example.invalid', 'WrongPassword!')).rejects.toBeInstanceOf(AxiosError);
      expect(requests).toEqual(['/auth/login']);
    } finally { axios.defaults.adapter = original; }
  });

  it('indexes a stored document without sending browser-derived content or scope', async () => {
    await setup();
    const { apiClient, documentApi } = await import('./api');
    const original = apiClient.defaults.adapter;
    let captured: InternalAxiosRequestConfig | undefined;
    apiClient.defaults.adapter = async config => {
      captured = config;
      return { status: 201, statusText: 'Created', data: { success: true }, headers: {}, config };
    };
    try {
      await documentApi.addToKnowledge('doc/id');
      expect(captured?.url).toBe('/knowledge/sources/from-document');
      expect(JSON.parse(captured?.data as string)).toEqual({ documentId: 'doc/id' });
      expect(captured?.headers.get('Authorization')).toBe('Bearer old-access');
    } finally { apiClient.defaults.adapter = original; }
  });
});
