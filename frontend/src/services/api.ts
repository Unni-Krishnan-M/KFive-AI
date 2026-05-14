import axios, { AxiosInstance, AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { getToken } from '@/utils/getToken';const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Create axios instance
export const apiClient: AxiosInstance = axios.create({
  baseURL: `${API_URL}/api/v1`,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

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

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        // Get refresh token from localStorage
        const authData = localStorage.getItem('kfive-auth');
        if (authData) {
          const { state } = JSON.parse(authData);
          if (state?.refreshToken) {
            const response = await apiClient.post('/auth/refresh', { 
              refreshToken: state.refreshToken 
            });
            
            // Update tokens in localStorage
            const newAuthData = {
              ...JSON.parse(authData),
              state: {
                ...state,
                accessToken: response.data.data.accessToken,
                refreshToken: response.data.data.refreshToken,
              }
            };
            localStorage.setItem('kfive-auth', JSON.stringify(newAuthData));
            
            // Retry original request with new token
            originalRequest.headers.Authorization = `Bearer ${response.data.data.accessToken}`;
            return apiClient(originalRequest);
          }
        }
      } catch (refreshError) {
        // Refresh failed, clear auth data and redirect to login
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
  
  logout: () =>
    apiClient.post('/auth/logout'),
};

export const chatApi = {
  getConversations: (page = 1, limit = 20) =>
    apiClient.get(`/chat/conversations?page=${page}&limit=${limit}`),
  
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
  getAgents: () => apiClient.get('/agents'),
  createAgent: (data: any) => apiClient.post('/agents', data),
  executeAgent: (id: string, prompt: string) => apiClient.post(`/agents/${id}/execute`, { prompt }),
  deleteAgent: (id: string) => apiClient.delete(`/agents/${id}`)
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

export const documentApi = {
  getDocuments: () => apiClient.get('/documents'),
  uploadDocument: (formData: FormData) => 
    apiClient.post('/documents', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    }),
  deleteDocument: (id: string) => apiClient.delete(`/documents/${id}`)
};