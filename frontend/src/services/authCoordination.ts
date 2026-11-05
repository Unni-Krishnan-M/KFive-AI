export const AUTH_STORAGE_KEY = 'kfive-auth';
export const AUTH_RECORD_VERSION = 4;
const AUTH_LOCK_NAME = 'kfive-auth-mutation-v1';
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 4096;
const MAX_SESSION_ID_LENGTH = 128;

export type AuthPhase = 'active' | 'logout-pending' | 'signed-out';

export interface AuthTokens {
  accessToken: string;
  csrfToken: string;
}

export interface AuthExpectation {
  epoch: number;
  sessionId: string | null;
  accessToken: string | null;
}

export interface AuthSnapshot {
  epoch: number;
  sessionId: string | null;
  phase: AuthPhase;
  user: unknown | null;
  accessToken: string | null;
  csrfToken: string | null;
  isAuthenticated: boolean;
}

interface PersistedAuthRecord {
  version: typeof AUTH_RECORD_VERSION;
  state: AuthSnapshot;
}

export type ExclusiveRunner = <T>(task: () => Promise<T>) => Promise<T>;

interface AuthCoordinatorOptions {
  storage: Storage;
  runExclusive: ExclusiveRunner;
  crossTabSupported?: boolean;
  newSessionId?: () => string;
}

export class AuthCoordinationSupersededError extends Error {
  constructor() {
    super('Browser authentication session changed');
    this.name = 'AuthCoordinationSupersededError';
  }
}

function signedOut(epoch = 0): AuthSnapshot {
  return {
    epoch,
    sessionId: null,
    phase: 'signed-out',
    user: null,
    accessToken: null,
    csrfToken: null,
    isAuthenticated: false,
  };
}

function boundedToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH;
}

function boundedSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH;
}

export function createBrowserSessionId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('Secure browser session identity is unavailable');
  }
  return crypto.randomUUID();
}

function normalizeSnapshot(value: unknown, fallbackEpoch = 0): AuthSnapshot {
  if (!value || typeof value !== 'object') return signedOut(fallbackEpoch);
  const state = value as Partial<AuthSnapshot>;
  const epoch = Number.isSafeInteger(state.epoch) && Number(state.epoch) >= 0 ? Number(state.epoch) : fallbackEpoch;
  const phase: AuthPhase = state.phase === 'active' || state.phase === 'logout-pending' || state.phase === 'signed-out'
    ? state.phase : (state.isAuthenticated ? 'active' : 'signed-out');
  if ((phase === 'active' || phase === 'logout-pending')
    && state.isAuthenticated === true
    && boundedSessionId(state.sessionId)
    && state.user && typeof state.user === 'object'
    && boundedToken(state.accessToken)
    && boundedToken(state.csrfToken)) {
    return {
      epoch,
      sessionId: state.sessionId,
      phase,
      user: state.user,
      accessToken: state.accessToken,
      csrfToken: state.csrfToken,
      isAuthenticated: true,
    };
  }
  return signedOut(epoch);
}

export class AuthCoordinator {
  private readonly storage: Storage;
  private readonly runExclusive: ExclusiveRunner;
  private readonly newSessionId: () => string;
  private readonly listeners = new Set<(snapshot: AuthSnapshot) => void>();
  private observedEpoch = -1;
  readonly crossTabSupported: boolean;

  constructor(options: AuthCoordinatorOptions) {
    this.storage = options.storage;
    this.runExclusive = options.runExclusive;
    this.newSessionId = options.newSessionId ?? createBrowserSessionId;
    this.crossTabSupported = options.crossTabSupported ?? true;
  }

  readSnapshot(): AuthSnapshot {
    try {
      const raw = this.storage.getItem(AUTH_STORAGE_KEY);
      if (!raw || raw.length > MAX_RECORD_BYTES) return signedOut();
      const record = JSON.parse(raw);
      if (record?.version === AUTH_RECORD_VERSION) return normalizeSnapshot(record.state);
      return signedOut();
    } catch {
      return signedOut();
    }
  }

  replaceSnapshot(snapshot: AuthSnapshot): void {
    this.persist(normalizeSnapshot(snapshot, snapshot.epoch));
  }

  subscribe(listener: (snapshot: AuthSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.readSnapshot());
    return () => this.listeners.delete(listener);
  }

  synchronizeFromStorage(): void {
    const snapshot = this.readSnapshot();
    if (snapshot.epoch < this.observedEpoch) return;
    this.observedEpoch = snapshot.epoch;
    for (const listener of this.listeners) listener(snapshot);
  }

  async refresh(
    expected: AuthExpectation,
    request: (csrfToken: string) => Promise<AuthTokens>,
  ): Promise<AuthTokens> {
    return this.runExclusive(async () => {
      const current = this.readSnapshot();
      if (current.phase !== 'active' || !current.isAuthenticated || !current.csrfToken || !current.accessToken) {
        throw new AuthCoordinationSupersededError();
      }
      if (current.sessionId !== expected.sessionId) {
        throw new AuthCoordinationSupersededError();
      }
      if (current.epoch !== expected.epoch || current.accessToken !== expected.accessToken) {
        return { accessToken: current.accessToken, csrfToken: current.csrfToken };
      }
      try {
        const tokens = await request(current.csrfToken);
        if (!boundedToken(tokens.accessToken) || !boundedToken(tokens.csrfToken)) {
          throw new Error('Invalid browser refresh response');
        }
        this.persist({ ...current, ...tokens, epoch: current.epoch + 1, phase: 'active' });
        return tokens;
      } catch (error) {
        // A response can be lost after the browser applies Set-Cookie. Without
        // the successor CSRF proof, every tab must fail closed rather than loop.
        this.persist(signedOut(current.epoch + 1));
        throw error;
      }
    });
  }

  async logout(request: (csrfToken: string) => Promise<unknown>): Promise<void> {
    return this.runExclusive(async () => {
      const current = this.readSnapshot();
      if (current.phase !== 'active' || !current.isAuthenticated || !current.csrfToken) {
        throw new AuthCoordinationSupersededError();
      }
      const pending: AuthSnapshot = { ...current, epoch: current.epoch + 1, phase: 'logout-pending' };
      this.persist(pending);
      try {
        await request(current.csrfToken);
        this.persist(signedOut(pending.epoch + 1));
      } catch (error) {
        this.persist({ ...current, epoch: pending.epoch + 1, phase: 'active' });
        throw error;
      }
    });
  }

  async replaceSession<T>(
    request: () => Promise<T>,
    select: (result: T) => { user: unknown; tokens: AuthTokens },
  ): Promise<T> {
    return this.runExclusive(async () => {
      const result = await request();
      const current = this.readSnapshot();
      let selected: { user: unknown; tokens: AuthTokens };
      let sessionId: string;
      try {
        selected = select(result);
        sessionId = this.newSessionId();
        if (!selected.user || typeof selected.user !== 'object'
          || !boundedToken(selected.tokens.accessToken) || !boundedToken(selected.tokens.csrfToken)
          || !boundedSessionId(sessionId)) {
          throw new Error('Invalid browser authentication response');
        }
      } catch (error) {
        this.persist(signedOut(current.epoch + 1));
        throw error;
      }
      this.persist({
        epoch: current.epoch + 1,
        sessionId,
        phase: 'active',
        user: selected.user,
        accessToken: selected.tokens.accessToken,
        csrfToken: selected.tokens.csrfToken,
        isAuthenticated: true,
      });
      return result;
    });
  }

  async signOutIfCurrent(expected: AuthExpectation): Promise<boolean> {
    return this.runExclusive(async () => {
      const current = this.readSnapshot();
      if (current.epoch !== expected.epoch
        || current.sessionId !== expected.sessionId
        || current.accessToken !== expected.accessToken) {
        return false;
      }
      this.persist(signedOut(current.epoch + 1));
      return true;
    });
  }

  private persist(snapshot: AuthSnapshot): void {
    const record: PersistedAuthRecord = { version: AUTH_RECORD_VERSION, state: snapshot };
    const serialized = JSON.stringify(record);
    if (serialized.length > MAX_RECORD_BYTES) throw new Error('Browser authentication record is too large');
    this.storage.setItem(AUTH_STORAGE_KEY, serialized);
    this.observedEpoch = Math.max(this.observedEpoch, snapshot.epoch);
    for (const listener of this.listeners) listener(snapshot);
  }
}

function localExclusiveRunner(): ExclusiveRunner {
  let tail = Promise.resolve<unknown>(undefined);
  return async <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

function browserExclusiveRunner(): { runExclusive: ExclusiveRunner; supported: boolean } {
  const manager = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (manager?.request) {
    return {
      supported: true,
      runExclusive: <T>(task: () => Promise<T>) => manager.request(
        AUTH_LOCK_NAME,
        { mode: 'exclusive' },
        () => task(),
      ) as unknown as Promise<T>,
    };
  }
  return { supported: false, runExclusive: localExclusiveRunner() };
}

let browserCoordinator: AuthCoordinator | undefined;
let removeStorageListener: (() => void) | undefined;

export function getBrowserAuthCoordinator(): AuthCoordinator {
  if (browserCoordinator) return browserCoordinator;
  if (typeof localStorage === 'undefined') throw new Error('Browser authentication storage is unavailable');
  const { runExclusive, supported } = browserExclusiveRunner();
  browserCoordinator = new AuthCoordinator({ storage: localStorage, runExclusive, crossTabSupported: supported });
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const listener = (event: StorageEvent) => {
      if (event.key === AUTH_STORAGE_KEY) browserCoordinator?.synchronizeFromStorage();
    };
    window.addEventListener('storage', listener);
    removeStorageListener = () => window.removeEventListener('storage', listener);
  }
  return browserCoordinator;
}

export function resetBrowserAuthCoordinatorForTests(): void {
  removeStorageListener?.();
  removeStorageListener = undefined;
  browserCoordinator = undefined;
}
