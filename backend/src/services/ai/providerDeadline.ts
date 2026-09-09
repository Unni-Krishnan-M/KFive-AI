import { AiProviderTimeoutError } from './errors';
import { AiRequestOptions } from './types';

export const PROVIDER_DISCOVERY_TIMEOUT_MS = 5_000;

export async function withProviderDiscoveryDeadline<T>(
  providerId: string,
  operation: (options: AiRequestOptions) => Promise<T>,
  timeoutMs = PROVIDER_DISCOVERY_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  try {
    return await operation({ signal: controller.signal });
  } catch (error) {
    if (expired) throw new AiProviderTimeoutError(providerId, error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
