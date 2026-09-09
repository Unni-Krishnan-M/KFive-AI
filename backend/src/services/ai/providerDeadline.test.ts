import { AiProviderTimeoutError } from './errors';
import { withProviderDiscoveryDeadline } from './providerDeadline';

describe('provider discovery deadline', () => {
  it('passes one live abort signal and preserves successful results', async () => {
    await expect(withProviderDiscoveryDeadline('ollama', async ({ signal }) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      return 'ready';
    }, 100)).resolves.toBe('ready');
  });

  it('turns an expired discovery request into a fixed provider timeout', async () => {
    await expect(withProviderDiscoveryDeadline('ollama', ({ signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('internal endpoint detail')), { once: true });
    }), 1)).rejects.toBeInstanceOf(AiProviderTimeoutError);
  });

  it('does not rewrite an immediate provider error', async () => {
    const error = new Error('provider rejected input');
    await expect(withProviderDiscoveryDeadline('ollama', async () => { throw error; }, 100)).rejects.toBe(error);
  });
});
