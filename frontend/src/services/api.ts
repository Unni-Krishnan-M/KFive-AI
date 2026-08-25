import axios, { AxiosInstance, AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { getToken } from '@/utils/getToken';
import { apiBaseUrl } from '@/config/runtime';
import { publishClearedAuthSession, publishRefreshedAuthTokens } from './authSession';
import type { AgentPayload, AgentRunDeletion, AgentRunDetail, AgentRunPage, AgentView } from './agentModel';
import type { WorkflowPayload, WorkflowRunDeletion, WorkflowRunDetail, WorkflowRunPage, WorkflowView } from './workflowModel';

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

// Create axios instance
export const apiClient: AxiosInstance = axios.create({
  baseURL: apiBaseUrl,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

const refreshClient = axios.create({ baseURL: apiBaseUrl, timeout: 30000 });
let refreshPromise: Promise<{ accessToken: string; refreshToken: string }> | null = null;

// Request interceptor to add auth token
apiClient.interceptors.request.use(
  (config) => {
    const token = getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor to handle token refresh
apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as any;

    if (error.response?.status === 401 && !originalRequest._retry && originalRequest.url !== '/auth/refresh') {
      originalRequest._retry = true;

      try {
        // Get refresh token from localStorage
        const authData = localStorage.getItem('kfive-auth');
        if (authData) {
          const { state } = JSON.parse(authData);
          if (state?.refreshToken) {
            refreshPromise ??= refreshClient.post('/auth/refresh', {
              refreshToken: state.refreshToken,
            }).then((response) => response.data.data).finally(() => {
              refreshPromise = null;
            });
            const tokens = await refreshPromise;
            
            // Update tokens in localStorage
            const newAuthData = {
              ...JSON.parse(authData),
              state: {
                ...state,
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
              }
            };
            localStorage.setItem('kfive-auth', JSON.stringify(newAuthData));
            
            // Retry original request with new token
            publishRefreshedAuthTokens(tokens);
            originalRequest.headers.Authorization = `Bearer ${tokens.accessToken}`;
            return apiClient(originalRequest);
          }
        }
      } catch (refreshError) {
        // Refresh failed, clear auth data and redirect to login
        publishClearedAuthSession();
        localStorage.removeItem('kfive-auth');
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    if (error.response?.status && error.response.status >= 500) {
      const settings = localStorage.getItem('kfive-settings');
      let showToast = true;
      if (settings) {
        try {
          const { toastsEnabled } = JSON.parse(settings);
          if (toastsEnabled === false) showToast = false;
        } catch(e) {}
      }
      if (showToast) {
        toast.error('Server error occurred. Please try again later.');
      }
    }

    return Promise.reject(error);
  }
);

// API service functions
export const authApi = {
  login: (email: string, password: string) =>
    apiClient.post('/auth/login', { email, password }),
  
  register: (userData: any) =>
    apiClient.post('/auth/register', userData),
  
  refresh: (refreshToken: string) =>
    apiClient.post('/auth/refresh', { refreshToken }),
  
  logout: (refreshToken?: string | null) =>
    apiClient.post('/auth/logout', { refreshToken }),
};

export const chatApi = {
  getConversations: (page = 1, limit = 20, projectId?: string) =>
    apiClient.get('/chat/conversations', { params: { page, limit, ...(projectId ? { projectId } : {}) } }),
  
  getConversation: (id: string) =>
    apiClient.get(`/chat/conversations/${id}`),
  
  createConversation: (data: any) =>
    apiClient.post('/chat/conversations', data),
  
  updateConversation: (id: string, data: any) =>
    apiClient.put(`/chat/conversations/${id}`, data),
  
  deleteConversation: (id: string) =>
    apiClient.delete(`/chat/conversations/${id}`),
  
  sendMessage: (conversationId: string, message: any) =>
    apiClient.post(`/chat/conversations/${conversationId}/messages`, message),
};

export const agentApi = {
  getAgents: (projectId?: string) => apiClient.get<ApiEnvelope<AgentView[]>>('/agents', { params: projectId ? { projectId } : undefined }),
  createAgent: (data: AgentPayload) => apiClient.post<ApiEnvelope<AgentView>>('/agents', data),
  updateAgent: (id: string, data: AgentPayload) => apiClient.patch<ApiEnvelope<AgentView>>(`/agents/${id}`, data),
  deleteAgent: (id: string) => apiClient.delete<ApiEnvelope<{ deleted: true }>>(`/agents/${id}`),
  getRuns: (id: string, page = 1) => apiClient.get<ApiEnvelope<AgentRunPage>>(`/agents/${id}/runs`, { params: { page } }),
  getRun: (id: string, runId: string) => apiClient.get<ApiEnvelope<{ run: AgentRunDetail }>>(`/agents/${id}/runs/${runId}`),
  cancelRun: (id: string, runId: string) => apiClient.post<ApiEnvelope<{ run: AgentRunDetail; idempotent: boolean }>>(`/agents/${id}/runs/${runId}/cancel`),
  deleteRun: (id: string, runId: string) => apiClient.delete<ApiEnvelope<AgentRunDeletion>>(`/agents/${id}/runs/${runId}`),
};

export const userApi = {
  getProfile: () =>
    apiClient.get('/user/profile'),
  
  updateProfile: (data: any) =>
    apiClient.put('/user/profile', data),
  
  updatePreferences: (preferences: any) =>
    apiClient.put('/user/preferences', preferences),
  
  getUsage: () =>
    apiClient.get('/user/usage'),
    
  getActivity: () => 
    apiClient.get('/user/activity'),
};

export const ollamaApi = {
  getModels: () =>
    apiClient.get('/ollama/models'),
  
  healthCheck: () =>
    apiClient.get('/ollama/health'),
};

export const settingsApi = {
  getRuntime: () => apiClient.get('/settings/runtime'),
  testProvider: () => apiClient.post('/settings/providers/test', {}, { validateStatus: (status) => (status >= 200 && status < 300) || status === 503 }),
  getProviderHealth: () => apiClient.get('/settings/providers/health', { validateStatus: (status) => (status >= 200 && status < 300) || status === 503 }),
  getProviderModels: () => apiClient.get('/settings/providers/models'),
};

export const modelApi = {
  getCatalog: () => apiClient.get('/models'),
  getGpuStatus: () => apiClient.get('/system/gpu'),
  requestDeleteConfirmation: (model: string) => apiClient.post('/models/delete-confirmation', { model }),
  deleteModel: (model: string, confirmationToken: string) =>
    apiClient.delete('/models', { data: { model, confirmationToken } }),
  routeModel: (task: string, preferredModel?: string) =>
    apiClient.post('/models/route', { task, preferredModel }),
};

export const projectApi = {
  list: (status: 'active' | 'archived' | 'all' = 'active') => apiClient.get(`/projects?status=${status}`),
  create: (data: { name: string; description?: string; tags?: string[] }) => apiClient.post('/projects', data),
  get: (id: string) => apiClient.get(`/projects/${id}`),
  update: (id: string, data: { name?: string; description?: string; tags?: string[]; status?: 'active' | 'archived' }) => apiClient.patch(`/projects/${id}`, data),
  archive: (id: string) => apiClient.post(`/projects/${id}/archive`),
  restore: (id: string) => apiClient.post(`/projects/${id}/restore`),
  requestDeleteConfirmation: (id: string) => apiClient.post(`/projects/${id}/delete-confirmation`),
  delete: (id: string, confirmationToken: string) => apiClient.delete(`/projects/${id}`, { data: { confirmationToken } }),
};

export const documentApi = {
  getDocuments: (projectId?: string) => apiClient.get('/documents', { params: projectId ? { projectId } : undefined }),
  uploadDocument: (formData: FormData, projectId?: string) => {
    if (projectId) formData.set('projectId', projectId);
    return (
    apiClient.post('/documents', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    }));
  },
  deleteDocument: (id: string) => apiClient.delete(`/documents/${id}`)
};

export const knowledgeApi = {
  getStatus: (projectId?: string) =>
    apiClient.get('/knowledge/status', { params: projectId ? { projectId } : undefined }),
  getSources: (projectId?: string) =>
    apiClient.get('/knowledge/sources', { params: projectId ? { projectId } : undefined }),
  createSource: (data: {
    name: string;
    mediaType: 'text/plain' | 'text/markdown';
    content: string;
    projectId?: string;
  }) => apiClient.post('/knowledge/sources', data),
  deleteSource: (id: string) => apiClient.delete(`/knowledge/sources/${id}`),
  query: (data: { question: string; projectId?: string; topK?: number }) =>
    apiClient.post('/knowledge/query', data),
};

export const repositoryApi = {
  getStatus: (projectId?: string) =>
    apiClient.get('/repositories/status', { params: projectId ? { projectId } : undefined }),
  getAnalyses: (projectId?: string) =>
    apiClient.get('/repositories/analyses', { params: projectId ? { projectId } : undefined }),
  getAnalysis: (id: string) => apiClient.get(`/repositories/analyses/${id}`),
  deleteAnalysis: (id: string) => apiClient.delete(`/repositories/analyses/${id}`),
  createAnalysis: (archive: File, options: { name?: string; projectId?: string } = {}) => {
    const data = new FormData();
    data.append('archive', archive);
    if (options.name) data.append('name', options.name);
    if (options.projectId) data.append('projectId', options.projectId);
    return apiClient.post('/repositories/analyses', data, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
};

export const codeApi = {
  getRuntimes: () => apiClient.get('/code/runtimes'),
  createRun: (data: { language: 'python' | 'javascript'; source: string; stdin: string; projectId?: string }) =>
    apiClient.post('/code/runs', data),
  getRun: (id: string) => apiClient.get(`/code/runs/${id}`),
  getRuns: (projectId?: string) => apiClient.get('/code/runs', { params: projectId ? { projectId } : undefined }),
  cancelRun: (id: string) => apiClient.post(`/code/runs/${id}/cancel`),
};

export const workflowApi = {
  getWorkflows: (projectId?: string) => apiClient.get<ApiEnvelope<{ workflows: WorkflowView[] }>>('/workflows', { params: projectId ? { projectId } : undefined }),
  getWorkflow: (id: string) => apiClient.get<ApiEnvelope<{ workflow: WorkflowView }>>(`/workflows/${id}`),
  createWorkflow: (data: WorkflowPayload) => apiClient.post<ApiEnvelope<{ workflow: WorkflowView }>>('/workflows', data),
  updateWorkflow: (id: string, data: Omit<WorkflowPayload, 'projectId'>) => apiClient.patch<ApiEnvelope<{ workflow: WorkflowView }>>(`/workflows/${id}`, data),
  deleteWorkflow: (id: string) => apiClient.delete<ApiEnvelope<{ workflowId: string; deleted: true }>>(`/workflows/${id}`),
  getRuns: (id: string, page = 1) => apiClient.get<ApiEnvelope<WorkflowRunPage>>(`/workflows/${id}/runs`, { params: { page } }),
  getRun: (id: string, runId: string) => apiClient.get<ApiEnvelope<{ run: WorkflowRunDetail }>>(`/workflows/${id}/runs/${runId}`),
  cancelRun: (id: string, runId: string) => apiClient.post<ApiEnvelope<{ run: WorkflowRunDetail; idempotent: boolean }>>(`/workflows/${id}/runs/${runId}/cancel`),
  deleteRun: (id: string, runId: string) => apiClient.delete<ApiEnvelope<WorkflowRunDeletion>>(`/workflows/${id}/runs/${runId}`),
};
