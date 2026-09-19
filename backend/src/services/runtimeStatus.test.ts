import { parseEnvironment } from '@/config/environment';
import { buildRuntimeStatus } from './runtimeStatus';

describe('runtime transport status', () => {
  it('reports the local Unix bridge without exposing its filesystem path', () => {
    const config = parseEnvironment({ ...process.env, AI_PROVIDER: 'ollama',
      OLLAMA_BASE_URL: 'https://remote.example', OLLAMA_SOCKET_PATH: '/private/kfive/ollama.sock' });
    const status = buildRuntimeStatus(config);
    expect(status.provider).toMatchObject({ location: 'local', transport: 'unix-socket' });
    expect(status.restartRequiredFields).toContain('OLLAMA_SOCKET_PATH');
    expect(JSON.stringify(status)).not.toContain('/private/');
  });

  it('continues to classify TCP providers from their configured URL', () => {
    const config = parseEnvironment({ ...process.env, AI_PROVIDER: 'ollama',
      OLLAMA_BASE_URL: 'https://remote.example', OLLAMA_SOCKET_PATH: '' });
    expect(buildRuntimeStatus(config).provider).toMatchObject({ location: 'remote', transport: 'http' });
  });
});
