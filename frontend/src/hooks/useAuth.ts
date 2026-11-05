import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { authApi } from '@/services/api';
import { registerAuthSessionObserver } from '@/services/authSession';
import { createBrowserSessionId, getBrowserAuthCoordinator, type AuthPhase } from '@/services/authCoordination';

interface User {
  _id: string;
  email: string;
  username: string;
  firstName?: string;
  lastName?: string;
  avatar?: string;
  role: 'user' | 'admin' | 'premium';
  preferences: {
    theme: 'light' | 'dark' | 'auto';
    language: string;
    ai: {
      defaultModel: string;
      voiceEnabled: boolean;
    };
  };
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  csrfToken: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  epoch: number;
  sessionId: string | null;
  phase: AuthPhase;
  login: (email: string, password: string) => Promise<void>;
  register: (userData: RegisterData) => Promise<void>;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<void>;
  updateUser: (userData: Partial<User>) => Promise<void>;
}

interface RegisterData {
  email: string;
  username: string;
  password: string;
  firstName?: string;
  lastName?: string;
}

const monotonicAuthStorage: StateStorage = {
  getItem: (name) => localStorage.getItem(name),
  removeItem: (name) => localStorage.removeItem(name),
  setItem: (name, value) => {
    try {
      const nextEpoch = JSON.parse(value)?.state?.epoch;
      const currentRaw = localStorage.getItem(name);
      const currentEpoch = currentRaw ? JSON.parse(currentRaw)?.state?.epoch : -1;
      if (Number.isSafeInteger(currentEpoch) && (!Number.isSafeInteger(nextEpoch) || nextEpoch < currentEpoch)) return;
    } catch {
      return;
    }
    localStorage.setItem(name, value);
  },
};

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      csrfToken: null,
      isLoading: false,
      isAuthenticated: false,
      epoch: 0,
      sessionId: null,
      phase: 'signed-out',

      login: async (email: string, password: string) => {
        set({ isLoading: true });
        try {
          await authApi.login(email, password);
          set({ isLoading: false });
        } catch (error) {
          set({ isLoading: false });
          throw error;
        }
      },

      register: async (userData: RegisterData) => {
        set({ isLoading: true });
        try {
          await authApi.register(userData);
          set({ isLoading: false });
        } catch (error) {
          set({ isLoading: false });
          throw error;
        }
      },

      logout: async () => {
        const csrfToken = get().csrfToken;
        if (!csrfToken) throw new Error('No browser session proof available');
        try {
          await authApi.logout(csrfToken);
        } finally {
          authApi.finishLogout();
        }
      },

      refreshAuth: async () => {
        const { csrfToken } = get();
        if (!csrfToken) {
          throw new Error('No browser session available');
        }

        await authApi.refresh(csrfToken);
      },

      updateUser: async (userData: Partial<User>) => {
        const currentUser = get().user;
        if (currentUser) {
          set({ user: { ...currentUser, ...userData } });
        }
      },
    }),
    {
      name: 'kfive-auth',
      storage: createJSONStorage(() => monotonicAuthStorage),
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        csrfToken: state.csrfToken,
        isAuthenticated: state.isAuthenticated,
        epoch: state.epoch,
        sessionId: state.sessionId,
        phase: state.phase,
      }),
      version: 4,
      migrate: (persisted: any, version) => {
        if (version < 2 || persisted?.refreshToken) {
          return {
            user: null, accessToken: null, csrfToken: null, isAuthenticated: false,
            isLoading: false, epoch: 0, sessionId: null, phase: 'signed-out',
          };
        }
        let next = persisted;
        if (version < 3) {
          next = {
            ...next,
            epoch: 0,
            phase: next?.isAuthenticated ? 'active' : 'signed-out',
          };
        }
        if (version < 4) {
          return {
            ...next,
            sessionId: next?.isAuthenticated ? createBrowserSessionId() : null,
          };
        }
        return next;
      },
    }
  )
);

registerAuthSessionObserver({
  updateTokens: ({ accessToken, csrfToken }) => {
    useAuth.setState({ accessToken, csrfToken });
  },
  clear: () => {
    useAuth.setState({
      user: null,
      accessToken: null,
      csrfToken: null,
      isAuthenticated: false,
      phase: 'signed-out',
    });
  },
});

if (typeof localStorage !== 'undefined') {
  getBrowserAuthCoordinator().subscribe((snapshot) => {
    useAuth.setState({
      user: snapshot.user as User | null,
      accessToken: snapshot.accessToken,
      csrfToken: snapshot.csrfToken,
      isAuthenticated: snapshot.isAuthenticated,
      epoch: snapshot.epoch,
      sessionId: snapshot.sessionId,
      phase: snapshot.phase,
      isLoading: snapshot.phase === 'logout-pending',
    });
  });
}
