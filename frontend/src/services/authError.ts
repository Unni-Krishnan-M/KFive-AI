import { readableApiError } from './runtimeSettings';

export function readableAuthError(error: unknown, action: 'login' | 'registration'): string {
  const fallback = action === 'login'
    ? 'Login failed. Check your details and try again.'
    : 'Registration failed. Check your details and try again.';
  const message = readableApiError(error, fallback);
  if (message === 'Network Error') {
    return 'KFive backend could not be reached from this browser. Check service health and the allowed browser origin.';
  }
  return message;
}
