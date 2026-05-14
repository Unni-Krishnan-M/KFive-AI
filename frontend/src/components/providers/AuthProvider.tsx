import React, { createContext, useContext, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';

interface AuthContextType {
  // Context will use the zustand store directly
}

const AuthContext = createContext<AuthContextType>({});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, refreshAuth } = useAuth();

  useEffect(() => {
    // Try to refresh auth on app start if we have tokens
    const refreshToken = useAuth.getState().refreshToken;
    if (refreshToken && !isAuthenticated) {
      refreshAuth().catch(() => {
        // Refresh failed, user will need to login again
        useAuth.getState().logout();
      });
    }
  }, []);

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