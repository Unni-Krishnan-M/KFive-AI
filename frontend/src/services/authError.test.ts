import { describe, expect, it } from 'vitest';
import { readableAuthError } from './authError';

describe('readableAuthError', () => {
  it('preserves structured authentication errors', () => {
    expect(readableAuthError({ response: { data: { error: { message: 'Email is already registered.' } } } }, 'registration'))
      .toBe('Email is already registered.');
  });

  it('turns a browser network or CORS failure into an actionable dependency error', () => {
    expect(readableAuthError({ message: 'Network Error' }, 'login'))
      .toBe('KFive backend could not be reached from this browser. Check service health and the allowed browser origin.');
  });
});
