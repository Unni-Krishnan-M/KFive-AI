import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { LoadingScreen } from '@/components/ui/LoadingScreen';

interface AuthContextType {
  // Context will use the zustand store directly
}

const AuthContext = createContext<AuthContextType>({});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { refreshAuth } = useAuth();
  const [bootstrapping, setBootstrapping] = useState(() => Boolean(useAuth.getState().csrfToken));

  useEffect(() => {
    // The refresh credential is HttpOnly. The persisted CSRF proof indicates
    // that a cookie-backed browser session may be resumed.
    const csrfToken = useAuth.getState().csrfToken;
    if (csrfToken) {
      refreshAuth()
        .catch(() => {
          // refreshAuth clears local state without recursively calling logout.
        })
        .finally(() => setBootstrapping(false));
    } else {
      setBootstrapping(false);
    }
  }, []);

  if (bootstrapping) return <LoadingScreen />;

  return (
    <AuthContext.Provider value={{}}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuthContext = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuthContext must be used within an AuthProvider');
  }
  return context;
};
