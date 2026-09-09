import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, X, Trash2, Bot, GripVertical } from 'lucide-react';
import { SlideOver } from '@/components/ui/SlideOver';
import { chatApi } from '@/services/api';
import { apiUrl } from '@/config/runtime';
import { getToken } from '@/utils/getToken';
import { readSseResponse } from '@/utils/sse';
import { readableApiError } from '@/services/runtimeSettings';
import { ChatStreamProtocol, validateChatPrompt } from '@/services/chatModel';

interface Task {
  id: string;
  title: string;
  description: string;
  column: 'todo' | 'in-progress' | 'done';
}

export default function WorkspacePage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [addingToColumn, setAddingToColumn] = useState<Task['column'] | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  
  // AI Modal
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiContextTask, setAiContextTask] = useState<Task | null>(null);
  const [aiStream, setAiStream] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string>();
  const [aiConversationId, setAiConversationId] = useState<string>();
  const [followUp, setFollowUp] = useState('');
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem('kfive-workspace-tasks');
    if (saved) {
      try {
        setTasks(JSON.parse(saved));
      } catch(e) {}
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('kfive-workspace-tasks', JSON.stringify(tasks));
  }, [tasks]);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  const addTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim() || !addingToColumn) return;
    
    const task: Task = {
      id: Date.now().toString(),
      title: newTaskTitle.trim(),
      description: '',
      column: addingToColumn
    };
    
    setTasks([...tasks, task]);
    setNewTaskTitle('');
    setAddingToColumn(null);
  };

  const deleteTask = (id: string) => {
    setTasks(tasks.filter(t => t.id !== id));
  };

  // Drag and Drop handlers
  const handleDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData('taskId', id);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent, column: Task['column']) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('taskId');
    setTasks(tasks.map(t => t.id === id ? { ...t, column } : t));
  };

  const streamPrompt = async (prompt: string, task: Task, existingConversationId?: string) => {
    const input = validateChatPrompt(prompt);
    if (!input.value || isAiLoading) {
      if (input.error) setAiError(input.error);
      return;
    }
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setAiError(undefined);
    setAiStream('');
    setIsAiLoading(true);

    try {
      let conversationId = existingConversationId;
      if (!conversationId) {
        const response = await chatApi.createConversation({ title: `Workspace: ${task.title}`.slice(0, 120) });
        conversationId = response.data?.data?._id;
        if (!conversationId) throw new Error('The AI conversation could not be created.');
        setAiConversationId(conversationId);
      }

      const token = getToken();
      if (!token) throw new Error('Your session is unavailable. Sign in again.');
      const response = await fetch(apiUrl(`/chat/conversations/${conversationId}/stream`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: input.value }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        throw new Error(readableApiError({ response: { data: payload } }, `AI request failed with HTTP ${response.status}.`));
      }
      if (!(response.headers.get('content-type') || '').toLowerCase().startsWith('text/event-stream')) {
        throw new Error('The chat endpoint returned a non-streaming response.');
      }
      const protocol = new ChatStreamProtocol();
      await readSseResponse(response, (dataString, eventName, eventId) => {
        const event = protocol.consume(dataString, eventName, eventId);
        if (event.type === 'delta') setAiStream((current) => current + event.content);
        else if (event.type === 'completed' && event.generation.error) setAiError(event.generation.error.message);
        else if (event.type === 'error') throw new Error(event.error.message);
      });
      protocol.finish();
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setAiError(readableApiError(error, 'The configured AI provider could not analyze this task.'));
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setIsAiLoading(false);
      }
    }
  };

  const askAI = (task: Task) => {
    setAiContextTask(task);
    setAiStream('');
    setAiError(undefined);
    setAiConversationId(undefined);
    setFollowUp('');
    setAiModalOpen(true);
    void streamPrompt(`Analyze this workspace task and propose concrete implementation and verification steps: ${task.title}`, task);
  };

  const askFollowUp = (event: React.FormEvent) => {
    event.preventDefault();
    if (!aiContextTask || !followUp.trim()) return;
    const prompt = followUp.trim();
    setFollowUp('');
    void streamPrompt(prompt, aiContextTask, aiConversationId);
  };

  const closeAi = () => {
    abortControllerRef.current?.abort();
    setAiModalOpen(false);
  };

  const columns: { id: Task['column'], title: string, color: string }[] = [
    { id: 'todo', title: 'To Do', color: 'border-blue-500/30 bg-blue-500/5' },
    { id: 'in-progress', title: 'In Progress', color: 'border-yellow-500/30 bg-yellow-500/5' },
    { id: 'done', title: 'Done', color: 'border-green-500/30 bg-green-500/5' },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="p-6 h-full flex flex-col"
    >
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-white mb-2 ml-2">Workspace Board</h1>
        <p className="text-gray-400 ml-2">Organize your tasks and use AI to break them down.</p>
      </div>

      <div className="flex-1 overflow-x-auto overflow-y-hidden pb-4">
        <div className="flex gap-6 h-full min-w-max px-2">
          {columns.map(col => (
            <div 
              key={col.id} 
              className={`w-80 flex flex-col rounded-2xl border ${col.color} backdrop-blur-xl`}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, col.id)}
            >
              <div className="p-4 border-b border-white/10 flex justify-between items-center group">
                <h2 className="font-semibold text-white">{col.title}</h2>
                <span className="bg-black/30 px-2 py-0.5 rounded-full text-xs font-medium text-gray-400 border border-white/5">
                  {tasks.filter(t => t.column === col.id).length}
                </span>
              </div>
              
              <div className="flex-1 p-3 overflow-y-auto space-y-3 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
                <AnimatePresence>
                  {tasks.filter(t => t.column === col.id).map(task => (
                    <motion.div
                      layout
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      key={task.id}
                      draggable
                      onDragStart={(e: any) => handleDragStart(e, task.id)}
                      className="bg-black/40 border border-white/10 p-4 rounded-xl cursor-grab active:cursor-grabbing hover:bg-black/60 transition-colors group relative"
                    >
                      <div className="absolute left-2 top-[18px] opacity-0 group-hover:opacity-40"><GripVertical size={16}/></div>
                      <div className="pl-4">
                        <div className="flex justify-between items-start mb-2">
                          <h3 className="text-sm font-medium text-gray-200">{task.title}</h3>
                          <button 
                            onClick={() => deleteTask(task.id)}
                            className="text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                            aria-label="Delete task"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                        {task.description && (
                          <p className="text-xs text-gray-500 line-clamp-2 mb-3">{task.description}</p>
                        )}
                        <button 
                          onClick={() => askAI(task)}
                          className="mt-2 text-xs flex items-center gap-1.5 px-2.5 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-lg transition-colors w-max font-medium"
                        >
                          <Bot size={14} /> Ask AI
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>

                {addingToColumn === col.id ? (
                  <form onSubmit={addTask} className="bg-black/40 border border-primary/50 p-3 rounded-xl">
                    <input
                      autoFocus
                      type="text"
                      value={newTaskTitle}
                      onChange={(e) => setNewTaskTitle(e.target.value)}
                      placeholder="Task title..."
                      className="w-full bg-transparent text-sm text-white focus:outline-none mb-3"
                    />
                    <div className="flex justify-end gap-2">
                      <button 
                        type="button" 
                        onClick={() => setAddingToColumn(null)}
                        className="p-1 text-gray-500 hover:text-gray-300"
                      >
                        <X size={16} />
                      </button>
                      <button 
                        type="submit"
                        className="px-3 py-1 bg-primary text-white text-xs font-medium rounded-lg hover:bg-primary/90"
                      >
                        Add
                      </button>
                    </div>
                  </form>
                ) : (
                  <button 
                    onClick={() => setAddingToColumn(col.id)}
                    className="w-full py-3 flex justify-center items-center gap-2 text-sm text-gray-500 hover:text-white hover:bg-white/5 border border-dashed border-white/10 hover:border-white/20 rounded-xl transition-all font-medium"
                  >
                    <Plus size={16} /> Add Task
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <SlideOver 
        isOpen={aiModalOpen} 
        onClose={closeAi}
        title="AI Assistant"
      >
        <div className="flex flex-col h-full">
          <div className="mb-6 p-4 bg-primary/10 border border-primary/20 rounded-xl">
            <p className="text-xs text-primary font-semibold mb-1 uppercase tracking-wider">Context</p>
            <p className="text-sm text-white">{aiContextTask?.title}</p>
          </div>
          
          <div className="flex-1 bg-black/40 border border-white/10 rounded-xl p-5 mb-4 relative overflow-y-auto w-full">
            <div className="prose prose-invert prose-sm max-w-none break-words">
              {aiError ? <span className="text-red-300">{aiError}</span> : aiStream || "Waiting for the configured AI provider…"}
              {isAiLoading && <span className="ml-1 inline-block w-2 h-4 bg-primary animate-pulse"/>}
            </div>
          </div>
          
          <form className="relative mt-auto" onSubmit={askFollowUp}>
            <input 
              type="text" 
              placeholder="Ask a follow-up question..." 
              value={followUp}
              onChange={(event) => setFollowUp(event.target.value)}
              className="w-full bg-black/40 border border-white/10 rounded-xl pl-4 pr-12 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-primary/50"
              disabled={isAiLoading || !aiConversationId}
            />
            <button 
              type="submit"
              className="absolute right-2 top-2 bottom-2 aspect-square bg-primary/20 text-primary hover:bg-primary hover:text-white rounded-lg flex items-center justify-center transition-colors disabled:opacity-50"
              disabled={isAiLoading || !aiConversationId || !followUp.trim()}
              aria-label="Send follow-up"
            >
              <Bot size={16} />
            </button>
          </form>
        </div>
      </SlideOver>
    </motion.div>
  );
}
