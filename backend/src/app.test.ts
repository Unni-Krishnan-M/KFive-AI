import { ALLOWED_CORS_METHODS } from './app';

describe('application CORS policy', () => {
  it('allows the PATCH method used by project updates', () => {
    expect(ALLOWED_CORS_METHODS).toContain('PATCH');
  });
});
