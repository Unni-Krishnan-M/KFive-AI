export type AiProviderErrorCode =
  | 'PROVIDER_UNAVAILABLE'
  | 'REQUEST_ABORTED'
  | 'REQUEST_TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'UNSUPPORTED_CAPABILITY'
  | 'PROVIDER_ERROR';

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly code: AiProviderErrorCode,
    readonly provider: string,
    readonly retryable: boolean,
    options?: { cause?: unknown }
  ) {
    super(message);
    this.name = 'AiProviderError';
    if (options?.cause !== undefined) (this as Error & { cause?: unknown }).cause = options.cause;
  }
}

export class AiProviderUnavailableError extends AiProviderError {
  constructor(provider: string, cause?: unknown) {
    super(`The configured AI provider '${provider}' is unavailable.`, 'PROVIDER_UNAVAILABLE', provider, true, { cause });
    this.name = 'AiProviderUnavailableError';
  }
}

export class AiProviderAbortedError extends AiProviderError {
  constructor(provider: string, cause?: unknown) {
    super(`The ${provider} request was cancelled.`, 'REQUEST_ABORTED', provider, false, { cause });
    this.name = 'AiProviderAbortedError';
  }
}

export class AiProviderTimeoutError extends AiProviderError {
  constructor(provider: string, cause?: unknown) {
    super(`The ${provider} request timed out.`, 'REQUEST_TIMEOUT', provider, true, { cause });
    this.name = 'AiProviderTimeoutError';
  }
}

export class AiProviderResponseError extends AiProviderError {
  constructor(provider: string, message: string, cause?: unknown) {
    super(message, 'INVALID_RESPONSE', provider, false, { cause });
    this.name = 'AiProviderResponseError';
  }
}

export class AiProviderUnsupportedError extends AiProviderError {
  constructor(provider: string, capability?: string) {
    const detail = capability ? ` for '${capability}'` : '';
    super(
      `The configured AI provider '${provider}' has no installed KFive adapter${detail}. No fallback was attempted.`,
      'UNSUPPORTED_CAPABILITY',
      provider,
      false
    );
    this.name = 'AiProviderUnsupportedError';
  }
}
