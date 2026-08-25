import { describe, expect, it } from 'vitest';
import { apiBaseUrl, apiUrl } from './runtime';

describe('browser runtime endpoints', () => {
  it('uses same-origin API routes when no build-time origin is configured', () => {
    expect(apiBaseUrl).toBe('/api/v1');
    expect(apiUrl('health')).toBe('/api/v1/health');
    expect(apiUrl('/chat/conversations')).toBe('/api/v1/chat/conversations');
  });
});
