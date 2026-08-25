import { Express } from 'express';
import { parseEnvironment } from '@/config/environment';
import { authenticateToken } from '@/middleware/auth';
import { setupRoutes } from './index';

describe('models route authentication', () => {
  it('mounts model and GPU endpoints behind authentication', () => {
    const get = jest.fn();
    const use = jest.fn();
    setupRoutes({ get, use } as unknown as Express, parseEnvironment(process.env));

    expect(use).toHaveBeenCalledWith('/api/v1/models', authenticateToken, expect.any(Function));
    expect(use).toHaveBeenCalledWith('/api/v1/system', authenticateToken, expect.any(Function));
    expect(use).toHaveBeenCalledWith('/api/v1/projects', authenticateToken, expect.any(Function));
    expect(use).toHaveBeenCalledWith('/api/v1/agents', authenticateToken, expect.any(Function));
    expect(use).toHaveBeenCalledWith('/api/v1/documents', authenticateToken, expect.any(Function));
    expect(use).toHaveBeenCalledWith('/api/v1/code', authenticateToken, expect.any(Function));
    expect(use).toHaveBeenCalledWith('/api/v1/knowledge', authenticateToken, expect.any(Function));
    expect(use).toHaveBeenCalledWith('/api/v1/repositories', authenticateToken, expect.any(Function));
    expect(use).toHaveBeenCalledWith('/api/v1/workflows', authenticateToken, expect.any(Function));
  });
});
