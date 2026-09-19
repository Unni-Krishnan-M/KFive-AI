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
  storage.set('kfive-auth', JSON.stringify({ state: { accessToken: 'old-access', refreshToken: 'old-refresh' } }));
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
        expect(JSON.parse(config.data)).toEqual({ refreshToken: 'old-refresh' });
        return { ...response, data: { data: { accessToken: 'new-access', refreshToken: 'new-refresh' } } };
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
      expect(JSON.parse(storage.get('kfive-auth')!).state).toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    } finally { axios.defaults.adapter = original; }
  });
});
