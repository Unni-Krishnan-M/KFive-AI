import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { 
  Brain, 
  MessageSquare, 
  FileText, 
  Zap, 
  Clock,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  ChevronRight,
  Bot
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { userApi, chatApi, ollamaApi } from '@/services/api';
import { SkeletonLoader } from '@/components/ui/SkeletonLoader';

export default function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [ollamaStatus, setOllamaStatus] = useState<any>(null);
  const [recentConversations, setRecentConversations] = useState<any[]>([]);
  const [usageData, setUsageData] = useState({
    conversationsCount: 0,
    documentsUploaded: 0,
    tokensUsed: 0
  });
  const [recentActivity, setRecentActivity] = useState<any[]>([]);

  useEffect(() => {
    async function fetchData() {
      try {
        const [res, actRes, chatRes, healthRes] = await Promise.allSettled([
          userApi.getUsage(),
          userApi.getActivity(),
          chatApi.getConversations(1, 3),
          ollamaApi.healthCheck()
        ]);

        if (res.status === 'fulfilled' && res.value.data?.success) {
          setUsageData(res.value.data.data);
        }
        if (actRes.status === 'fulfilled' && actRes.value.data?.success) {
          setRecentActivity(actRes.value.data.data);
        }
        if (chatRes.status === 'fulfilled' && chatRes.value.data?.data?.conversations) {
          setRecentConversations(chatRes.value.data.data.conversations.slice(0, 3));
        }
        if (healthRes.status === 'fulfilled' && healthRes.value.data) {
          setOllamaStatus(healthRes.value.data);
        } else {
          setOllamaStatus({ status: 'offline' });
        }
      } catch (err) {
        console.error("Failed to load dashboard data", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  const stats = [
    {
      name: 'AI Conversations',
      value: usageData.conversationsCount.toString(),
      change: 'Active',
      changeType: usageData.conversationsCount > 0 ? 'positive' : 'neutral',
      icon: MessageSquare,
    },
    {
      name: 'Documents Processed',
      value: usageData.documentsUploaded.toString(),
      change: 'Active',
      changeType: usageData.documentsUploaded > 0 ? 'positive' : 'neutral',
      icon: FileText,
    },
    {
      name: 'Tokens Used',
      value: usageData.tokensUsed.toString(),
      change: 'Active',
      changeType: usageData.tokensUsed > 0 ? 'positive' : 'neutral',
      icon: Brain,
    },
    {
      name: 'Response Time',
      value: 'Live',
      change: 'Optimized',
      changeType: 'positive',
      icon: Zap,
    },
  ];

  return (
    <motion.div 
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="p-6 md:p-8 space-y-8"
    >
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight text-white">
          Welcome back, {user?.firstName || user?.username}!
        </h1>
        <p className="text-gray-400">
          Here's what's happening with your AI workspace today.
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {stats.map((stat, index) => (
          <div key={stat.name} className="bg-white/5 border border-white/10 p-6 rounded-2xl glass-card relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <div className="flex items-center justify-between relative z-10">
              <div>
                <p className="text-sm font-medium text-gray-400">{stat.name}</p>
                {loading ? (
                  <SkeletonLoader className="w-16 h-8 mt-1" />
                ) : (
                  <p className="text-2xl font-bold text-white mt-1">{stat.value}</p>
                )}
              </div>
              <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center">
                <stat.icon className="w-6 h-6 text-primary" />
              </div>
            </div>
            {!loading && (
              <div className="mt-4 flex items-center relative z-10">
                {stat.changeType === 'positive' && <ArrowUpRight className="w-4 h-4 text-green-500 mr-1" />}
                {stat.changeType === 'negative' && <ArrowDownRight className="w-4 h-4 text-red-500 mr-1" />}
                <span className={`text-sm font-medium ${
                  stat.changeType === 'positive' ? 'text-green-500' : 
                  stat.changeType === 'negative' ? 'text-red-500' : 'text-gray-500'
                }`}>
                  {stat.change}
                </span>
                <span className="text-sm text-gray-500 ml-2">from last week</span>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Activity */}
        <div className="bg-white/5 border border-white/10 p-6 rounded-2xl glass-card flex flex-col">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-white">Recent Activity</h2>
            <Clock className="w-5 h-5 text-gray-400" />
          </div>
          <div className="space-y-4 flex-1">
            {loading ? (
               Array(3).fill(0).map((_, i) => (
                 <div key={i} className="flex items-start space-x-3">
                   <SkeletonLoader className="w-8 h-8 rounded-lg" />
                   <div className="flex-1 space-y-2 py-1">
                     <SkeletonLoader className="w-3/4 h-3" />
                     <SkeletonLoader className="w-1/2 h-3" />
                   </div>
                 </div>
               ))
            ) : recentActivity.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center py-6">
                <Activity className="w-8 h-8 text-gray-500 mb-2 opacity-50" />
                <p className="text-sm text-gray-400">No recent activity to display.</p>
              </div>
            ) : (
              recentActivity.map((activity) => {
                const IconComponent = typeof activity.icon === 'string' ? Activity : (activity.icon || Activity);
                return (
                  <div key={activity.id} className="flex items-start space-x-3 group">
                    <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center flex-shrink-0 group-hover:bg-primary/20 transition-colors">
                      <IconComponent className="w-4 h-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-200">{activity.title}</p>
                      <p className="text-xs text-gray-500">{activity.time}</p>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Quick Actions */}
        <div className="bg-white/5 border border-white/10 p-6 rounded-2xl glass-card">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-white">Quick Actions</h2>
            <Zap className="w-5 h-5 text-gray-400" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <button 
              onClick={() => navigate('/app/chat')}
              className="p-4 bg-primary/10 hover:bg-primary/20 border border-primary/10 hover:border-primary/30 rounded-xl transition-all text-left group"
            >
              <MessageSquare className="w-6 h-6 text-primary mb-3 group-hover:scale-110 transition-transform" />
              <p className="font-medium text-gray-200">New Chat</p>
              <p className="text-xs text-gray-400 mt-1">Start AI conversation</p>
            </button>
            <button 
              onClick={() => navigate('/app/documents')}
              className="p-4 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/10 hover:border-cyan-500/30 rounded-xl transition-all text-left group"
            >
              <FileText className="w-6 h-6 text-cyan-500 mb-3 group-hover:scale-110 transition-transform" />
              <p className="font-medium text-gray-200">Upload Doc</p>
              <p className="text-xs text-gray-400 mt-1">Process document</p>
            </button>
            <button 
              onClick={() => navigate('/app/agents')}
              className="p-4 bg-green-500/10 hover:bg-green-500/20 border border-green-500/10 hover:border-green-500/30 rounded-xl transition-all text-left group"
            >
              <Bot className="w-6 h-6 text-green-500 mb-3 group-hover:scale-110 transition-transform" />
              <p className="font-medium text-gray-200">Run Agent</p>
              <p className="text-xs text-gray-400 mt-1">Execute AI task</p>
            </button>
            <button 
              onClick={() => navigate('/app/voice')}
              className="p-4 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/10 hover:border-purple-500/30 rounded-xl transition-all text-left group"
            >
              <Activity className="w-6 h-6 text-purple-500 mb-3 group-hover:scale-110 transition-transform" />
              <p className="font-medium text-gray-200">Voice AI</p>
              <p className="text-xs text-gray-400 mt-1">Start voice session</p>
            </button>
          </div>
        </div>
      </div>

      {/* Recent Conversations */}
      <div className="bg-white/5 border border-white/10 p-6 rounded-2xl glass-card">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-white">Recent Conversations</h2>
          <button 
            onClick={() => navigate('/app/chat')}
            className="text-sm text-primary hover:text-primary/80 flex items-center gap-1 font-medium"
          >
            View All <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        
        <div className="space-y-3">
          {loading ? (
             Array(3).fill(0).map((_, i) => (
               <SkeletonLoader key={i} className="w-full h-16 rounded-xl" />
             ))
          ) : recentConversations.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No recent conversations.</p>
          ) : (
            recentConversations.map((conv) => (
              <div key={conv._id || conv.id} className="flex items-center justify-between p-4 bg-black/20 hover:bg-black/40 border border-white/5 rounded-xl transition-colors group">
                <div className="flex items-center gap-4 overflow-hidden">
                  <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center flex-shrink-0">
                    <MessageSquare className="w-5 h-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-200 truncate">{conv.title || 'Untitled Conversation'}</p>
                    <p className="text-xs text-gray-500 truncate mt-0.5">{new Date(conv.updatedAt || Date.now()).toLocaleDateString()}</p>
                  </div>
                </div>
                <button 
                  onClick={() => navigate(`/app/chat/${conv._id || conv.id}`)}
                  className="px-4 py-2 bg-white/5 hover:bg-white/10 text-white text-sm font-medium rounded-lg opacity-0 group-hover:opacity-100 transition-opacity focus:opacity-100"
                >
                  Continue
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* AI Status */}
      <div className="bg-white/5 border border-white/10 p-6 rounded-2xl glass-card">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-white">AI System Status</h2>
          {loading ? (
             <SkeletonLoader className="w-32 h-6" />
          ) : (
            <div className="flex items-center space-x-2 bg-black/20 px-3 py-1.5 rounded-full border border-white/5">
              <div className={`w-2 h-2 rounded-full ${ollamaStatus?.status === 'offline' ? 'bg-red-500 animate-pulse' : 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]'}`}></div>
              <span className="text-xs font-medium text-gray-300">
                {ollamaStatus?.status === 'offline' ? 'Systems Offline' : 'Systems Operational'}
              </span>
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 bg-black/20 border border-white/5 rounded-xl">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-300">Ollama Models</span>
              {loading ? <SkeletonLoader className="w-10 h-4" /> : (
                <span className={`text-xs font-medium px-2 py-0.5 rounded ${ollamaStatus?.status === 'offline' ? 'bg-red-500/10 text-red-400' : 'bg-green-500/10 text-green-400'}`}>
                  {ollamaStatus?.status === 'offline' ? 'Offline' : 'Online'}
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500" title={ollamaStatus?.version}>
              {ollamaStatus?.status === 'offline' ? 'Connection failed' : `Ollama ${ollamaStatus?.version || 'Active'}`}
            </p>
          </div>
          <div className="p-4 bg-black/20 border border-white/5 rounded-xl">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-300">Vector Database</span>
              <span className="text-xs font-medium px-2 py-0.5 rounded bg-green-500/10 text-green-400">Connected</span>
            </div>
            <p className="text-xs text-gray-500">ChromaDB operational</p>
          </div>
          <div className="p-4 bg-black/20 border border-white/5 rounded-xl">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-300">Real-time Sync</span>
              <span className="text-xs font-medium px-2 py-0.5 rounded bg-green-500/10 text-green-400">Active</span>
            </div>
            <p className="text-xs text-gray-500">WebSocket connected</p>
          </div>
        </div>
      </div>
    </motion.div>
  );
}