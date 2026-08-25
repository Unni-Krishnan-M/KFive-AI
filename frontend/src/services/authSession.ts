export interface RefreshedAuthTokens {
  accessToken: string;
  refreshToken: string;
}

interface AuthSessionObserver {
  updateTokens(tokens: RefreshedAuthTokens): void;
  clear(): void;
}

let observer: AuthSessionObserver | undefined;

export function registerAuthSessionObserver(nextObserver: AuthSessionObserver): () => void {
  observer = nextObserver;
  return () => {
    if (observer === nextObserver) observer = undefined;
  };
}

export function publishRefreshedAuthTokens(tokens: RefreshedAuthTokens): void {
  observer?.updateTokens(tokens);
}

export function publishClearedAuthSession(): void {
  observer?.clear();
}
