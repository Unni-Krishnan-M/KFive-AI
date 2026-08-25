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
    const tokens = { accessToken: 'access', refreshToken: 'refresh' };

    publishRefreshedAuthTokens(tokens);
    publishClearedAuthSession();

    expect(updateTokens).toHaveBeenCalledWith(tokens);
    expect(clear).toHaveBeenCalledOnce();

    unregister();
    publishClearedAuthSession();
    expect(clear).toHaveBeenCalledOnce();
  });
});
