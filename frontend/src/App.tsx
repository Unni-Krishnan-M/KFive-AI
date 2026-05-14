import { Routes, Route, Navigate } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { useLocation } from 'react-router-dom';

// Pages
import LandingPage from '@/pages/LandingPage';
import LoginPage from '@/pages/auth/LoginPage';
import RegisterPage from '@/pages/auth/RegisterPage';
import DashboardPage from '@/pages/DashboardPage';
import WorkspacePage from '@/pages/WorkspacePage';
import ChatPage from '@/pages/ChatPage';
import AgentsPage from '@/pages/AgentsPage';
import DocumentsPage from '@/pages/DocumentsPage';
import CodeStudioPage from '@/pages/CodeStudioPage';
import VoiceAssistantPage from '@/pages/VoiceAssistantPage';
import SettingsPage from '@/pages/SettingsPage';
import ProfilePage from '@/pages/ProfilePage';
import NotFoundPage from '@/pages/NotFoundPage';
import FileActionsPage from '@/pages/FileActionsPage';

// Components
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AppLayout } from '@/components/layout/AppLayout';
import { LoadingScreen } from '@/components/ui/LoadingScreen';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';

// Hooks
import { useAuth } from '@/hooks/useAuth';

function App() {
  const location = useLocation();
  const { isLoading } = useAuth();

  if (isLoading) {
    return <LoadingScreen />;
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-background text-foreground transition-colors duration-300">
        <AnimatePresence mode="wait">
          <Routes location={location} key={location.pathname}>
            {/* Public Routes */}
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            
            {/* Protected Routes */}
            <Route
              path="/app/*"
              element={
                <ProtectedRoute>
                  <AppLayout>
                    <AnimatePresence mode="wait">
                      <Routes location={location} key={location.pathname}>
                        <Route index element={<Navigate to="/app/dashboard" replace />} />
                        <Route path="dashboard" element={<DashboardPage />} />
                        <Route path="workspace" element={<WorkspacePage />} />
                        <Route path="chat" element={<ChatPage />} />
                        <Route path="chat/:conversationId" element={<ChatPage />} />
                        <Route path="agents" element={<AgentsPage />} />
                        <Route path="documents" element={<DocumentsPage />} />
                        <Route path="code-studio" element={<CodeStudioPage />} />
                        <Route path="voice" element={<VoiceAssistantPage />} />
                        <Route path="settings" element={<SettingsPage />} />
                        <Route path="profile" element={<ProfilePage />} />
                        <Route path="files" element={<FileActionsPage />} />
                        <Route path="*" element={<Navigate to="/not-found" replace />} />
                      </Routes>
                    </AnimatePresence>
                  </AppLayout>
                </ProtectedRoute>
              }
            />
            
            {/* Catch all route - map to 404 Instead of Redirecting */}
            <Route path="/not-found" element={<NotFoundPage />} />
            <Route path="*" element={<Navigate to="/not-found" replace />} />
          </Routes>
        </AnimatePresence>
      </div>
    </ErrorBoundary>
  );
}

export default App;