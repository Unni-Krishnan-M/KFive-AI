import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const captured = vi.hoisted(() => ({ options: undefined as any }));
vi.mock('vite-plugin-pwa', () => ({
  VitePWA: (options: unknown) => { captured.options = options; return []; },
}));

// Load at test runtime without crossing the app's separate TypeScript build
// project reference for vite.config.ts (which does not emit declarations).
const configModule = '../../vite.config';
await import(configModule);

describe('PWA private-data boundary', () => {
  it('never installs a runtime response cache for authenticated APIs', () => {
    expect(captured.options.workbox.runtimeCaching ?? []).toEqual([]);
  });

  it('preserves static precaching and the offline app shell', () => {
    expect(captured.options.workbox.globPatterns).toContain('**/*.{js,css,html,ico,png,svg}');
    expect(captured.options.registerType).toBe('autoUpdate');
  });

  it('does not serve the cached app shell for API or socket navigations', () => {
    const excluded: RegExp[] = captured.options.workbox.navigateFallbackDenylist ?? [];
    for (const path of ['/api', '/api/v1/user/profile', '/socket.io', '/socket.io/']) {
      expect(excluded.some((pattern) => pattern.test(path)), path).toBe(true);
    }
    expect(excluded.some((pattern) => pattern.test('/projects'))).toBe(false);
  });

  it('loads same-origin legacy-cache cleanup from the generated worker', () => {
    expect(captured.options.workbox.importScripts).toContain('/sw-private-cache-cleanup.js');
  });

  it.each([false, true])('only deletes the legacy API cache; cleanup failure=%s does not break activation', async (fails) => {
    const handlers: Record<string, (event: { waitUntil: (promise: Promise<unknown>) => void }) => void> = {};
    const remove = vi.fn(() => fails ? Promise.reject(new Error('unavailable')) : Promise.resolve(true));
    const warn = vi.fn();
    runInNewContext(readFileSync(new URL('../../public/sw-private-cache-cleanup.js', import.meta.url), 'utf8'), {
      self: { addEventListener: (name: string, handler: typeof handlers[string]) => { handlers[name] = handler; } },
      caches: { delete: remove },
      console: { warn },
    });
    let completion: Promise<unknown> | undefined;
    handlers.activate({ waitUntil: (promise) => { completion = promise; } });
    expect(completion).toBeDefined();
    await completion;
    expect(remove.mock.calls).toEqual([['api-cache']]);
    expect(warn).toHaveBeenCalledTimes(fails ? 1 : 0);
  });
});
