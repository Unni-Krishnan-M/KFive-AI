import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { useLocation } from 'react-router-dom';

const LandingPage = lazy(() => import('@/pages/LandingPage'));
const LoginPage = lazy(() => import('@/pages/auth/LoginPage'));
const RegisterPage = lazy(() => import('@/pages/auth/RegisterPage'));
const DashboardPage = lazy(() => import('@/pages/DashboardPage'));
const WorkspacePage = lazy(() => import('@/pages/WorkspacePage'));
const ChatPage = lazy(() => import('@/pages/ChatPage'));
const AgentsPage = lazy(() => import('@/pages/AgentsPage'));
const DocumentsPage = lazy(() => import('@/pages/DocumentsPage'));
const VoiceAssistantPage = lazy(() => import('@/pages/VoiceAssistantPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const ModelsPage = lazy(() => import('@/pages/ModelsPage'));
const ProjectsPage = lazy(() => import('@/pages/ProjectsPage'));
const ProfilePage = lazy(() => import('@/pages/ProfilePage'));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage'));
const FileActionsPage = lazy(() => import('@/pages/FileActionsPage'));
const CodeLabPage = lazy(() => import('@/pages/CodeLabPage'));
const KnowledgePage = lazy(() => import('@/pages/KnowledgePage'));
const RepositoryAnalyzerPage = lazy(() => import('@/pages/RepositoryAnalyzerPage'));
const WorkflowsPage = lazy(() => import('@/pages/WorkflowsPage'));
const DatasetLabPage = lazy(() => import('@/pages/DatasetLabPage'));
const BenchmarksPage = lazy(() => import('@/pages/BenchmarksPage'));
const NotebookPage = lazy(() => import('@/pages/NotebookPage'));

// Components
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AppLayout } from '@/components/layout/AppLayout';
import { LoadingScreen } from '@/components/ui/LoadingScreen';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';

function App() {
  const location = useLocation();

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-background text-foreground transition-colors duration-300">
        <Suspense fallback={<LoadingScreen />}>
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
                        <Route path="voice" element={<VoiceAssistantPage />} />
                        <Route path="settings" element={<SettingsPage />} />
                        <Route path="models" element={<ModelsPage />} />
                        <Route path="projects" element={<ProjectsPage />} />
                        <Route path="profile" element={<ProfilePage />} />
                        <Route path="files" element={<FileActionsPage />} />
                        <Route path="code" element={<CodeLabPage />} />
                        <Route path="knowledge" element={<KnowledgePage />} />
                        <Route path="repositories" element={<RepositoryAnalyzerPage />} />
                        <Route path="workflows" element={<WorkflowsPage />} />
                        <Route path="datasets" element={<DatasetLabPage />} />
                        <Route path="benchmarks" element={<BenchmarksPage />} />
                        <Route path="notebooks" element={<NotebookPage />} />
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
        </Suspense>
      </div>
    </ErrorBoundary>
  );
}

export default App;
