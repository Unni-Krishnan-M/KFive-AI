import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Bot, Plus, Play, Trash2, Settings, Terminal, Search, Edit2 } from 'lucide-react';
import { agentApi } from '@/services/api';
import toast from 'react-hot-toast';
import { SlideOver } from '@/components/ui/SlideOver';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

interface Agent {
  _id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  temperature: number;
}

const TEMPLATES = [
  {
    name: 'Code Reviewer',
    description: 'Expert developer that reviews code for bugs and best practices.',
    systemPrompt: 'You are an expert software engineer. Review the provided code for bugs, anti-patterns, security issues, and performance bottlenecks. Suggest improvements.',
    model: 'deepseek-coder',
    temperature: 0.2,
  },
  {
    name: 'Technical Writer',
    description: 'Creates clear, concise documentation from technical specs.',
    systemPrompt: 'You are a professional technical writer. Transform technical notes and code into clear, well-structured documentation suitable for developers.',
    model: 'llama3',
    temperature: 0.5,
  },
  {
    name: 'Data Analyst',
    description: 'Analyzes data structures and suggests insights.',
    systemPrompt: 'You are a data analyst AI. Analyze the provided data structures or datasets. Identify patterns, anomalies, and provide actionable insights.',
    model: 'mistral',
    temperature: 0.3,
  },
];

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  
  const [isSlideOverOpen, setIsSlideOverOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Partial<Agent> | null>(null);
  
  const [isExecuteModalOpen, setIsExecuteModalOpen] = useState(false);
  const [executingAgent, setExecutingAgent] = useState<Agent | null>(null);
  const [executePrompt, setExecutePrompt] = useState('');
  const [executeResult, setExecuteResult] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [agentToDelete, setAgentToDelete] = useState<string | null>(null);

  useEffect(() => {
    fetchAgents();
  }, []);

  const fetchAgents = async () => {
    try {
      const res = await agentApi.getAgents();
      if (res.data.success) {
        setAgents(res.data.data);
      }
    } catch (error) {
      toast.error('Failed to fetch agents');
    }
  };

  const handleSaveAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAgent?.name || !editingAgent?.systemPrompt) {
      toast.error('Name and System Prompt are required');
      return;
    }
    
    try {
      if (editingAgent._id) {
        // Mock update API since it's not in api.ts
        // await agentApi.updateAgent(editingAgent._id, editingAgent);
        toast.success(`Updated agent: ${editingAgent.name}. (Update API mock)`);
        setAgents(prev => prev.map(a => a._id === editingAgent._id ? editingAgent as Agent : a));
      } else {
        await agentApi.createAgent(editingAgent);
        toast.success('Agent created successfully');
        fetchAgents();
      }
      setIsSlideOverOpen(false);
    } catch (error) {
      toast.error('Failed to save agent');
    }
  };

  const handleCreateFromTemplate = async (template: typeof TEMPLATES[0]) => {
    // Show confirm dialog first or just create? Prompt: "templates only create blindly without confirmation" -> We must add confirmation.
    // Actually the prompt says "templates only create blindly without confirmation" in "CURRENT PROBLEMS TO FIX".
    // So we need to fix it by showing a form prefilled, NOT confirming blindly.
    setEditingAgent({
      name: template.name,
      description: template.description,
      systemPrompt: template.systemPrompt,
      model: template.model,
      temperature: template.temperature
    });
    setIsSlideOverOpen(true);
  };

  const handleDeleteClick = (id: string) => {
    setAgentToDelete(id);
    setDeleteConfirmOpen(true);
  };

  const confirmDelete = async () => {
    if (!agentToDelete) return;
    try {
      await agentApi.deleteAgent(agentToDelete);
      toast.success('Agent deleted');
      setAgents(agents.filter((a) => a._id !== agentToDelete));
    } catch (error) {
      toast.error('Failed to delete agent');
    } finally {
      setDeleteConfirmOpen(false);
      setAgentToDelete(null);
    }
  };

  const handleExecute = async () => {
    if (!executingAgent || !executePrompt) return;
    
    setIsExecuting(true);
    setExecuteResult('');
    try {
      const res = await agentApi.executeAgent(executingAgent._id, executePrompt);
      if (res.data.success) {
        // Simulated streaming inline
        const text = res.data.data.response || 'Success!';
        for(let i=0; i<=text.length; i+=3) {
          await new Promise(r => setTimeout(r, 10));
          setExecuteResult(text.substring(0, i));
        }
        setExecuteResult(text);
      }
    } catch (error) {
      setExecuteResult('Error executing agent.');
    } finally {
      setIsExecuting(false);
    }
  };

  const filteredAgents = agents.filter(a => a.name.toLowerCase().includes(searchQuery.toLowerCase()));

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="p-6 md:p-8 space-y-8"
    >
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white flex items-center gap-3">
            <Bot className="w-8 h-8 text-primary" />
            AI Agents
          </h1>
          <p className="text-gray-400 mt-1">Create and manage specialized AI assistants.</p>
        </div>
        
        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="relative flex-1 md:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input 
              type="text"
              placeholder="Search agents..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-black/40 border border-white/10 rounded-xl pl-9 pr-4 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
            />
          </div>
          <button
            onClick={() => {
              setEditingAgent({ name: '', description: '', systemPrompt: '', model: 'llama3', temperature: 0.7 });
              setIsSlideOverOpen(true);
            }}
            className="flex items-center space-x-2 px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-xl transition-colors font-medium shadow-lg shadow-primary/20"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Create Agent</span>
          </button>
        </div>
      </div>

      <div className="space-y-6">
        <h2 className="text-xl font-semibold text-white">Your Agents</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredAgents.length === 0 ? (
            <div className="col-span-full py-12 flex flex-col items-center justify-center bg-white/5 border border-white/10 rounded-2xl border-dashed">
              <Bot className="w-12 h-12 text-gray-500 mb-4 opacity-50" />
              <p className="text-gray-400">No agents found matching your criteria.</p>
            </div>
          ) : (
            filteredAgents.map((agent) => (
              <motion.div
                key={agent._id}
                layout
                className="bg-white/5 border border-white/10 p-6 rounded-2xl glass-card relative group hover:border-primary/30 transition-all"
              >
                <div className="absolute top-4 right-4 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button 
                    onClick={() => {
                      setEditingAgent(agent);
                      setIsSlideOverOpen(true);
                    }}
                    className="p-1.5 text-gray-400 hover:text-white bg-black/40 hover:bg-primary/20 rounded border border-white/10 hover:border-primary/30 transition-colors"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={() => handleDeleteClick(agent._id)}
                    className="p-1.5 text-gray-400 hover:text-red-400 bg-black/40 hover:bg-red-500/20 rounded border border-white/10 hover:border-red-500/30 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                
                <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mb-4">
                  <Bot className="w-6 h-6 text-primary" />
                </div>
                <h3 className="text-lg font-semibold text-white mb-2">{agent.name}</h3>
                <p className="text-sm text-gray-400 mb-6 line-clamp-2">{agent.description}</p>
                
                <div className="flex items-center space-x-2 text-xs text-gray-500 mb-4 bg-black/20 p-2 rounded-lg border border-white/5">
                  <Settings className="w-4 h-4" />
                  <span>{agent.model}</span>
                  <span>•</span>
                  <span>Temp: {agent.temperature}</span>
                </div>
                
                <button 
                  onClick={() => {
                    setExecutingAgent(agent);
                    setExecutePrompt('');
                    setExecuteResult('');
                    setIsExecuteModalOpen(true);
                  }}
                  className="w-full flex items-center justify-center space-x-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 text-white rounded-xl transition-all group-hover:border-primary/30 group-hover:text-primary font-medium"
                >
                  <Play className="w-4 h-4" />
                  <span>Execute Agent</span>
                </button>
              </motion.div>
            ))
          )}
        </div>
      </div>

      <div className="space-y-6 pt-8 border-t border-white/10 mt-8">
        <h2 className="text-xl font-semibold text-white">Starter Templates</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {TEMPLATES.map((template) => (
            <div
              key={template.name}
              className="bg-[#0f121d] border border-white/10 p-6 rounded-2xl hover:border-cyan-500/30 transition-all group cursor-pointer relative"
              onClick={() => handleCreateFromTemplate(template)}
            >
              {/* Tooltip implementation */}
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-3 bg-[#1a1d27] border border-white/10 rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10 pointer-events-none">
                <p className="text-xs text-gray-300 italic line-clamp-4">"{template.systemPrompt}"</p>
                <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-4 h-4 bg-[#1a1d27] border-b border-r border-white/10 transform rotate-45"></div>
              </div>

              <div className="w-10 h-10 bg-cyan-500/10 rounded-xl flex items-center justify-center mb-4 group-hover:bg-cyan-500/20 transition-colors">
                <Terminal className="w-5 h-5 text-cyan-400" />
              </div>
              <h3 className="text-white font-medium mb-2">{template.name}</h3>
              <p className="text-sm text-gray-500">{template.description}</p>
            </div>
          ))}
        </div>
      </div>

      {/* SlideOver for Editing/Creating Agent */}
      <SlideOver 
        isOpen={isSlideOverOpen} 
        onClose={() => setIsSlideOverOpen(false)} 
        title={editingAgent?._id ? "Edit Agent" : "Create Agent"}
      >
        <form onSubmit={handleSaveAgent} className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">Name</label>
            <input 
              type="text" 
              required
              value={editingAgent?.name || ''}
              onChange={e => setEditingAgent({...editingAgent, name: e.target.value})}
              className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-primary/50"
              placeholder="e.g. Code Reviewer"
            />
          </div>
          
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">Description</label>
            <input 
              type="text" 
              value={editingAgent?.description || ''}
              onChange={e => setEditingAgent({...editingAgent, description: e.target.value})}
              className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-primary/50"
              placeholder="What does this agent do?"
            />
          </div>
          
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">System Prompt</label>
            <textarea 
              required
              rows={6}
              value={editingAgent?.systemPrompt || ''}
              onChange={e => setEditingAgent({...editingAgent, systemPrompt: e.target.value})}
              className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary/50 resize-none font-mono text-sm leading-relaxed"
              placeholder="You are an expert..."
            />
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-300">Model</label>
              <select 
                value={editingAgent?.model || 'llama3'}
                onChange={e => setEditingAgent({...editingAgent, model: e.target.value})}
                className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-primary/50"
              >
                <option value="llama3">Llama 3</option>
                <option value="mistral">Mistral</option>
                <option value="deepseek-coder">DeepSeek</option>
              </select>
            </div>
            
            <div className="space-y-2 flex flex-col justify-center">
              <div className="flex justify-between items-end">
                <label className="text-sm font-medium text-gray-300">Temperature</label>
                <span className="text-xs text-primary font-medium">{editingAgent?.temperature ?? 0.7}</span>
              </div>
              <input 
                type="range" 
                min="0" max="1" step="0.1"
                value={editingAgent?.temperature ?? 0.7}
                onChange={e => setEditingAgent({...editingAgent, temperature: parseFloat(e.target.value)})}
                className="w-full h-2 bg-black/40 rounded-lg appearance-none cursor-pointer accent-primary mt-2"
              />
            </div>
          </div>
          
          <div className="pt-6 border-t border-white/10">
            <button 
              type="submit"
              className="w-full py-3 bg-primary hover:bg-primary/90 text-white rounded-xl font-medium transition-colors"
            >
              Save Agent
            </button>
          </div>
        </form>
      </SlideOver>

      {/* Execute Modal Overlay */}
      {isExecuteModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/60 backdrop-blur-sm">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-[#09090B] border border-white/10 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]"
          >
            <div className="p-4 border-b border-white/10 flex justify-between items-center bg-white/5">
              <h3 className="font-semibold text-white flex items-center gap-2">
                <Play className="w-4 h-4 text-green-400" />
                Execute: {executingAgent?.name}
              </h3>
              <button 
                onClick={() => setIsExecuteModalOpen(false)}
                className="text-gray-500 hover:text-white"
              >
                <Trash2 className="w-5 h-5 hidden" /> {/* spacer */}
                <span className="text-2xl leading-none">&times;</span>
              </button>
            </div>
            
            <div className="p-6 flex-1 overflow-y-auto flex flex-col gap-4">
              <div>
                <label className="text-sm font-medium text-gray-400 mb-2 block">Prompt Input</label>
                <textarea 
                  rows={4}
                  value={executePrompt}
                  onChange={e => setExecutePrompt(e.target.value)}
                  placeholder="Enter input for the agent..."
                  className="w-full bg-black/40 border border-white/10 rounded-xl p-4 text-white focus:outline-none focus:border-green-500/50 resize-none"
                />
                <div className="mt-3 flex justify-end">
                  <button 
                    onClick={handleExecute}
                    disabled={isExecuting || !executePrompt.trim()}
                    className="px-6 py-2.5 bg-green-500/20 text-green-400 hover:bg-green-500 hover:text-white rounded-xl font-medium transition-all disabled:opacity-50 flex items-center gap-2"
                  >
                    {isExecuting ? <Terminal className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                    Run Agent
                  </button>
                </div>
              </div>
              
              {(executeResult || isExecuting) && (
                <div className="bg-black/60 border border-white/5 rounded-xl p-5 flex-1 min-h-[150px] font-mono text-sm text-gray-300 whitespace-pre-wrap mt-4 relative">
                  {isExecuting && !executeResult && <span className="animate-pulse flex h-2 w-2 rounded-full bg-green-500 absolute top-4 left-4"></span>}
                  {executeResult}
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}

      {/* Confirm Delete */}
      <ConfirmDialog 
        isOpen={deleteConfirmOpen}
        title="Delete Agent"
        message="Are you sure you want to delete this agent? This action cannot be undone."
        confirmText="Delete"
        isDestructive={true}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteConfirmOpen(false)}
      />

    </motion.div>
  );
}