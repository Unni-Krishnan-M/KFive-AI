import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Bot, User, Send, StopCircle, Check, Copy, MessageSquare, Plus, Brain, AlertCircle, FolderKanban, Mic, X } from 'lucide-react';
import { chatApi, modelApi } from '@/services/api';
import toast from 'react-hot-toast';
import { useParams, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { getToken } from '@/utils/getToken';
import { apiUrl } from '@/config/runtime';
import { readSseResponse } from '@/utils/sse';
import { chatModelOptions, ModelInfo, normalizeModelCatalog } from '@/services/modelManager';
import { readableApiError, unwrapApiData } from '@/services/runtimeSettings';
import { PROJECT_ARCHIVED_MESSAGE, projectContextPath, projectNavigationState } from '@/services/projectContext';
import { useProjectContext } from '@/hooks/useProjectContext';
import {
  ChatConversation,
  ChatGeneration,
  ChatMessage,
  ChatStreamProtocol,
  ChatUsage,
  chatGenerationLabel,
  normalizeChatConversation,
  validateChatPrompt,
} from '@/services/chatModel';

const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

interface PendingChatRequest {
  controller: AbortController;
  conversationId?: string;
  requestId?: string;
  assistantId: string;
  scope: string;
  stopping: boolean;
}

export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const { requested: projectRequested, context: projectContext, loading: projectLoading, error: projectError } = useProjectContext();
  const projectId = projectContext?.projectId;
  const projectScopeReady = !projectRequested || Boolean(projectContext);
  const projectMutationsAllowed = projectScopeReady && projectContext?.status !== 'archived';
  
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [generation, setGeneration] = useState<ChatGeneration>();
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [streamUsage, setStreamUsage] = useState<ChatUsage>();
  const [selectedModel, setSelectedModel] = useState(localStorage.getItem('kfive-default-model') || '');
  const [modelOptions, setModelOptions] = useState<ModelInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('provider');
  const [taskType, setTaskType] = useState('general-chat');
  const [smartRouting, setSmartRouting] = useState(true);
  const [routingDecision, setRoutingDecision] = useState<{ provider: string; model: string; reasons?: string[] }>();
  const [lastSelection, setLastSelection] = useState<{ provider: string; model: string; reasons?: string[] }>();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string>();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeRequestRef = useRef<PendingChatRequest | null>(null);
  const detailRequestRef = useRef(0);
  const scope = `${projectId || 'global'}:${conversationId || 'new'}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    if (SpeechRecognitionAPI && !recognitionRef.current) {
      const recognition = new SpeechRecognitionAPI();
      recognition.continuous = true;
      recognition.interimResults = true;
      
      recognition.onresult = (event: any) => {
        let currentFinal = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            currentFinal += event.results[i][0].transcript + ' ';
          }
        }
        if (currentFinal) {
          setInput(prev => prev + currentFinal);
        }
      };

      recognition.onerror = (event: any) => {
        if (event.error === 'not-allowed') {
          toast.error('Microphone access denied.');
        }
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, []);

  useEffect(() => {
    modelApi.getCatalog().then((response) => {
      const catalog = normalizeModelCatalog(response.data);
      const options = chatModelOptions(catalog.models);
      setModelOptions(options);
      setSelectedProvider(catalog.provider);
      setSelectedModel((current) => options.some((model) => model.id === current) ? current : '');
    }).catch(() => {
      setModelOptions([]);
      setSelectedProvider('provider');
    });
  }, []);

  const toggleListening = () => {
    if (!SpeechRecognitionAPI) {
      toast.error('Browser does not support Speech Recognition.');
      return;
    }
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    } else {
      try {
        recognitionRef.current?.start();
        setIsListening(true);
      } catch (err) {}
    }
  };

  useEffect(() => {
    if (!projectScopeReady) {
      setConversations([]);
      return;
    }
    void fetchConversations();
  }, [conversationId, projectId, projectScopeReady]);

  useEffect(() => {
    const active = activeRequestRef.current;
    const continuingRequest = Boolean(active && active.scope === scope);
    if (active && active.scope !== scope) {
      active.controller.abort();
      activeRequestRef.current = null;
      setIsLoading(false);
      setIsStopping(false);
    }
    if (!continuingRequest) {
      setLastSelection(undefined);
      setRoutingDecision(undefined);
      setStreamUsage(undefined);
      setPageError(undefined);
    }
    if (conversationId && projectScopeReady) {
      if (!activeRequestRef.current || activeRequestRef.current.conversationId !== conversationId) {
        void loadConversationContext(conversationId);
      }
    } else {
      setMessages([]);
      setGeneration(undefined);
    }
  }, [scope, conversationId, projectScopeReady]);

  useEffect(() => () => {
    activeRequestRef.current?.controller.abort();
    activeRequestRef.current = null;
  }, []);

  const fetchConversations = async () => {
    const expectedProject = projectId || 'global';
    try {
      const res = await chatApi.getConversations(1, 20, projectId);
      if (!scopeRef.current.startsWith(`${expectedProject}:`) || !Array.isArray(res.data?.data)) return;
      setConversations(res.data.data.map(normalizeChatConversation));
    } catch(error) { setPageError(readableApiError(error, 'Conversations could not be loaded.')); }
  };

  const loadConversationContext = async (id: string, force = false) => {
    const expectedScope = `${projectId || 'global'}:${id}`;
    const serial = ++detailRequestRef.current;
    if (!force && activeRequestRef.current?.conversationId === id) return;
    try {
      const res = await chatApi.getConversation(id);
      if (serial !== detailRequestRef.current || scopeRef.current !== expectedScope) return;
      const conversation = normalizeChatConversation(res.data?.data);
      if (projectId && String(conversation.projectId || '') !== projectId) {
        setMessages([]);
        setGeneration(undefined);
        setPageError('This conversation does not belong to the selected project. Project-scoped actions are disabled.');
        return;
      }
      setMessages(conversation.messages);
      setGeneration(conversation.generation);
      const lastAssistant = [...conversation.messages].reverse().find((message) => message.role === 'assistant');
      if (lastAssistant?.provider && lastAssistant.model) {
        setLastSelection({ provider: lastAssistant.provider, model: lastAssistant.model });
      } else if (conversation.generation?.provider && conversation.generation.model) {
        setLastSelection({ provider: conversation.generation.provider, model: conversation.generation.model });
      }
      setStreamUsage(lastAssistant?.usage ?? conversation.generation?.usage);
      if (conversation.generation?.error) setPageError(conversation.generation.error.message);
    } catch(error) { setPageError(readableApiError(error, 'Conversation could not be loaded.')); }
  };

  // Scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };
  useEffect(() => { scrollToBottom(); }, [messages]);

  // Handle Model change
  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedModel(e.target.value);
    localStorage.setItem('kfive-default-model', e.target.value);
  };

  // Auto-resize textarea
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const stopGeneration = async () => {
    const active = activeRequestRef.current;
    if (!active || active.stopping) return;
    active.stopping = true;
    setIsStopping(true);
    if (!active.conversationId || !active.requestId) {
      active.controller.abort();
      return;
    }
    try {
      await chatApi.cancelGeneration(active.conversationId, active.requestId);
    } catch (error) {
      active.controller.abort();
      if (activeRequestRef.current === active) {
        setPageError(readableApiError(error, 'The generation could not be stopped cleanly.'));
      }
    }
  };

  const sendPayload = async (text: string) => {
    const prompt = validateChatPrompt(text);
    if (isLoading) return;
    if (!prompt.value) {
      setPageError(prompt.error);
      return;
    }
    if (!projectMutationsAllowed) {
      const message = projectError || PROJECT_ARCHIVED_MESSAGE;
      setPageError(message);
      toast.error(message);
      return;
    }
    
    const assistantId = `${Date.now()}-assistant`;
    const active: PendingChatRequest = {
      controller: new AbortController(),
      conversationId,
      assistantId,
      scope,
      stopping: false,
    };
    activeRequestRef.current = active;
    setPageError(undefined);
    setGeneration(undefined);
    setStreamUsage(undefined);
    setLastSelection(undefined);
    const userMessage: ChatMessage = { id: `${Date.now()}-user`, role: 'user', content: prompt.value };
    setMessages((previous) => [...previous, userMessage, { id: assistantId, role: 'assistant', content: '' }]);
    setInput('');
    setIsLoading(true);
    setIsStopping(false);
    
    if (textareaRef.current) {
      textareaRef.current.style.height = '56px'; // reset roughly
    }

    let activeConversationId = conversationId;

    try {
      const token = getToken();
      if (!token) throw new Error('Your session is unavailable. Sign in again.');
      let requestModel = selectedModel || undefined;
      if (smartRouting) {
        const routingResponse = await modelApi.routeModel(taskType, requestModel);
        const decision = unwrapApiData(routingResponse.data) as { provider: string; model: string; reasons?: string[] };
        if (!decision?.provider || !decision?.model) throw new Error('The model router returned an invalid decision.');
        requestModel = decision.model;
        if (activeRequestRef.current === active) setRoutingDecision(decision);
      }
      if (active.stopping || activeRequestRef.current !== active) throw new DOMException('Stopped', 'AbortError');

      if (!activeConversationId) {
        const title = [...prompt.value].slice(0, 30).join('') + ([...prompt.value].length > 30 ? '...' : '');
        const res = await chatApi.createConversation({ title, ...(projectId ? { projectId } : {}) });
        const created = normalizeChatConversation(res.data?.data);
        activeConversationId = created._id;
        if (!activeConversationId) throw new Error('The conversation could not be created.');
        active.conversationId = activeConversationId;
        active.scope = `${projectId || 'global'}:${activeConversationId}`;
        setConversations((previous) => [created, ...previous.filter((item) => item._id !== created._id)]);
        if (projectContext) {
          navigate(projectContextPath(`/app/chat/${activeConversationId}`, projectContext), {
            replace: true,
            state: projectNavigationState(projectContext),
          });
        } else {
          navigate(`/app/chat/${activeConversationId}`, { replace: true });
        }
      }

      const response = await fetch(apiUrl(`/chat/conversations/${activeConversationId}/stream`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ message: prompt.value, ...(requestModel ? { model: requestModel } : {}) }),
        signal: active.controller.signal,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        throw new Error(readableApiError({ response: { data: payload } }, `Chat request failed with HTTP ${response.status}.`));
      }
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().startsWith('text/event-stream')) {
        throw new Error('The chat endpoint returned a non-streaming response.');
      }
      const protocol = new ChatStreamProtocol();
      await readSseResponse(response, (dataString, eventName, eventId) => {
        if (activeRequestRef.current !== active || scopeRef.current !== active.scope) return;
        const event = protocol.consume(dataString, eventName, eventId);
        if (event.type === 'generation') {
          active.requestId = event.requestId;
        } else if (event.type === 'start') {
          setLastSelection({ provider: event.provider, model: event.model });
        } else if (event.type === 'delta') {
          setMessages((previous) => previous.map((message) => message.id === assistantId
            ? { ...message, content: message.content + event.content }
            : message));
        } else if (event.type === 'usage') {
          setStreamUsage(event.usage);
        } else if (event.type === 'completed') {
          setGeneration(event.generation);
          if (event.generation.error) setPageError(event.generation.error.message);
        } else if (event.type === 'error') {
          setPageError(event.error.message);
        }
      });
      protocol.finish();
    } catch (error: unknown) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      if (!aborted && activeRequestRef.current === active) {
        const message = readableApiError(error, 'Failed to get response.');
        setPageError(message);
        toast.error(message);
      }
    } finally {
      if (active.conversationId && scopeRef.current === active.scope) {
        await loadConversationContext(active.conversationId, true);
        await fetchConversations();
      } else if (!active.conversationId && activeRequestRef.current === active) {
        setMessages((previous) => previous.filter((message) => message.id !== userMessage.id && message.id !== assistantId));
      }
      if (activeRequestRef.current === active) {
        activeRequestRef.current = null;
        setIsLoading(false);
        setIsStopping(false);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPayload(input);
    }
  };

  const handleSuggestion = (prompt: string) => {
    sendPayload(prompt);
  };

  const activeTitle = conversations.find((conversation) => conversation._id === conversationId)?.title;
  const inputValidation = validateChatPrompt(input);

  return (
    <div className="flex h-full w-full bg-[#09090B]">
      {/* Left Sidebar - Conversation History */}
      <div className="hidden md:flex flex-col w-[280px] border-r border-white/10 bg-[#0a0d1a] h-full shrink-0">
        <div className="p-4 border-b border-white/10 shrink-0">
          <button 
            onClick={() => projectContext
              ? navigate(projectContextPath('/app/chat', projectContext), { state: projectNavigationState(projectContext) })
              : navigate('/app/chat')}
            disabled={!projectMutationsAllowed || projectLoading}
            className="w-full flex items-center justify-center gap-2 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 text-white rounded-xl transition-all font-medium disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={18} /> New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1 scrollbar-thin scrollbar-thumb-white/10">
          <div className="text-xs font-semibold text-gray-500 mb-2 px-2 uppercase tracking-wider">Recent</div>
          {conversations.map(conv => {
            const isActive = conv._id === conversationId;
            return (
              <div 
                key={conv._id}
                onClick={() => projectContext
                  ? navigate(projectContextPath(`/app/chat/${conv._id}`, projectContext), { state: projectNavigationState(projectContext) })
                  : navigate(`/app/chat/${conv._id}`)}
                className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-colors group ${isActive ? 'bg-primary/20 text-white border border-primary/20' : 'text-gray-400 hover:bg-white/5 hover:text-white border border-transparent'}`}
              >
                <MessageSquare size={16} className={isActive ? 'text-primary' : 'text-gray-500 group-hover:text-gray-300'} />
                <div className="flex-1 min-w-0 pr-2">
                  <div className="text-sm font-medium truncate">{conv.title || 'New Conversation'}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col h-full min-w-0 relative">
        {/* Header */}
        <div className="h-16 border-b border-white/10 flex items-center justify-between px-6 bg-[#09090B]/95 backdrop-blur-xl shrink-0 z-10">
          <div className="flex flex-col items-start min-w-0 pr-4">
             <div className="font-semibold text-white truncate w-full text-lg">{activeTitle || 'New Conversation'}</div>
             <div className="flex flex-wrap items-center gap-2 text-xs font-medium">{projectLoading ? <span className="text-gray-500">Verifying project…</span> : projectContext ? <span className="flex items-center gap-1 text-primary"><FolderKanban size={11} />{projectContext.projectName} <span className="capitalize text-gray-500">({projectContext.status})</span><button onClick={() => navigate('/app/chat', { replace: true, state: null })} className="ml-1 text-gray-500 hover:text-white" aria-label="Leave project context"><X size={11} /></button></span> : <span className="text-gray-500">No project context</span>}</div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <label className="flex items-center gap-1.5 text-xs text-gray-500"><span>Model routing task</span><select value={taskType} onChange={(event) => setTaskType(event.target.value)} disabled={!smartRouting} aria-label="Model routing task" className="bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-gray-300 disabled:opacity-50">
              <option value="general-chat">General chat</option><option value="coding">Coding</option><option value="reasoning">Reasoning</option><option value="document-analysis">Document</option><option value="repository-analysis">Repository</option><option value="structured-extraction">Extraction</option><option value="workflow">Workflow</option>
            </select></label>
            <select 
              value={selectedModel}
              onChange={handleModelChange}
              className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-300 font-medium focus:outline-none focus:ring-1 focus:ring-primary appearance-none cursor-pointer hover:bg-white/5 transition-colors"
            >
              <option value="">{selectedProvider} default</option>
              {modelOptions.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-gray-400"><input type="checkbox" checked={smartRouting} onChange={(event) => setSmartRouting(event.target.checked)} />Smart route</label>
          </div>
        </div>
        {projectError ? <div role="alert" className="border-b border-red-500/20 bg-red-500/10 px-6 py-2 text-xs text-red-200">{projectError} Project-scoped actions are disabled.</div> : null}
        {projectContext?.status === 'archived' ? <div role="alert" className="border-b border-amber-500/20 bg-amber-500/10 px-6 py-2 text-xs text-amber-200">{PROJECT_ARCHIVED_MESSAGE}</div> : null}
        {pageError ? <div role="alert" className="border-b border-amber-500/20 bg-amber-500/10 px-6 py-2 text-xs text-amber-200">{pageError}</div> : null}
        {generation?.status === 'running' && !isLoading ? <div role="status" className="border-b border-amber-500/20 bg-amber-500/10 px-6 py-2 text-xs text-amber-200">A previously started generation is still being reconciled by the backend.</div> : null}
        {routingDecision ? <div className="border-b border-white/10 bg-white/[0.02] px-6 py-1.5 text-xs text-gray-500">Router recommendation <span className="font-medium text-gray-300">{routingDecision.provider} / {routingDecision.model}</span>{routingDecision.reasons?.length ? ` — ${routingDecision.reasons.join(' ')}` : ''}</div> : null}
        {lastSelection ? <div className="border-b border-white/10 bg-primary/5 px-6 py-2 text-xs text-gray-400">Actual selection <span className="font-medium text-primary">{lastSelection.provider} / {lastSelection.model}</span>{streamUsage?.totalTokens !== undefined ? ` — ${streamUsage.totalTokens} tokens` : ''}</div> : null}

        {/* Message Thread */}
        <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 px-4 md:px-8 py-6">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col justify-center items-center max-w-2xl mx-auto text-center space-y-8 animate-in fade-in duration-500">
              <div className="relative">
                <div className="absolute inset-0 bg-primary/20 blur-3xl rounded-full"></div>
                <Brain className="w-20 h-20 text-primary relative z-10" />
              </div>
              <div>
                <h2 className="text-2xl font-bold text-white mb-2">How can I help you today?</h2>
                <p className="text-gray-400 max-w-md mx-auto">Ask a question, request code generation, or draft an email. The AI is ready to assist.</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 w-full">
                {[
                  "Explain quantum computing simply",
                  "Write a React script for a timer",
                  "Draft an email to my team about..."
                ].map((prompt, i) => (
                  <button 
                    key={i} 
                    onClick={() => handleSuggestion(prompt)}
                    disabled={!projectMutationsAllowed}
                    className="p-4 bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/20 rounded-2xl text-sm text-left transition-all group"
                  >
                    <span className="text-gray-300 group-hover:text-white line-clamp-2">{prompt}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="max-w-4xl mx-auto space-y-6">
              {messages.map((msg, index) => {
                const isUser = msg.role === 'user';
                const key = msg._id || msg.id || index;
                const isPendingAssistant = !isUser && msg.id === activeRequestRef.current?.assistantId && isLoading;
                const outputTokens = msg.usage?.outputTokens;
                const tokensPerSecond = outputTokens !== undefined && msg.durationMs && msg.durationMs > 0
                  ? (outputTokens / (msg.durationMs / 1000)).toFixed(1)
                  : undefined;
                
                return (
                  <motion.div
                    key={key}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                    className={`flex gap-4 ${isUser ? 'flex-row-reverse' : ''}`}
                  >
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-1 ${isUser ? 'bg-gradient-to-br from-cyan-500 to-blue-600' : 'bg-primary/20 border border-primary/30'}`}>
                      {isUser ? <User className="w-5 h-5 text-white" /> : <Bot className="w-5 h-5 text-primary" />}
                    </div>
                    
                    <div className={`max-w-[85%] sm:max-w-[75%] flex flex-col group ${isUser ? 'items-end' : 'items-start'}`}>
                      <div className={`rounded-2xl px-5 py-3 ${
                        isUser 
                          ? 'bg-primary text-white rounded-tr-sm' 
                          : 'bg-white/5 border border-white/10 text-gray-200 rounded-tl-sm'
                      }`}>
                        {isUser ? (
                           <div className="whitespace-pre-wrap text-[15px]">{msg.content}</div>
                        ) : (
                           <div className="prose prose-invert prose-p:leading-relaxed max-w-none text-[15px]">
                            {msg.content === '' && isPendingAssistant ? (
                              <span className="flex items-center gap-1 my-2">
                                <span className="w-2 h-2 rounded-full bg-primary animate-bounce"></span>
                                <span className="w-2 h-2 rounded-full bg-primary animate-bounce delay-100"></span>
                                <span className="w-2 h-2 rounded-full bg-primary animate-bounce delay-200"></span>
                              </span>
                            ) : (
                              <ReactMarkdown
                                components={{
                                  code({node: _node, inline, className, children, ...props}: any) {
                                    const match = /language-(\w+)/.exec(className || '')
                                    return !inline && match ? (
                                      <div className="relative mt-4 mb-4 rounded-lg overflow-hidden group/code border border-white/10">
                                        <div className="flex items-center justify-between px-4 py-1.5 bg-black/60 text-xs text-gray-400">
                                          <span>{match[1]}</span>
                                          <button 
                                            onClick={() => handleCopy(String(children).replace(/\n$/, ''), key + 'code')}
                                            className="hover:text-white flex items-center gap-1 transition-colors"
                                          >
                                            {copiedId === (key + 'code') ? <Check size={14} className="text-green-500"/> : <Copy size={14}/>}
                                          </button>
                                        </div>
                                        <SyntaxHighlighter
                                          {...props}
                                          children={String(children).replace(/\n$/, '')}
                                          style={atomDark}
                                          language={match[1]}
                                          PreTag="div"
                                          customStyle={{margin: 0, padding: '1rem', background: '#0a0d1a'}}
                                        />
                                      </div>
                                    ) : (
                                      <code {...props} className="bg-black/30 text-purple-300 px-1.5 py-0.5 rounded text-sm font-mono break-words">
                                        {children}
                                      </code>
                                    )
                                  }
                                }}
                              >
                                {msg.content}
                              </ReactMarkdown>
                            )}
                            
                            {msg.status && msg.status !== 'succeeded' ? (
                              <div className="mt-3 flex flex-col gap-1 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                                <span className="inline-flex items-center gap-2 font-medium"><AlertCircle size={14} />{chatGenerationLabel(msg.status)}</span>
                                {msg.error?.message ? <span>{msg.error.message}</span> : null}
                              </div>
                            ) : null}
                           </div>
                        )}
                      </div>

                      {!isUser && (msg.provider || msg.model || msg.durationMs !== undefined || msg.timeToFirstTokenMs !== undefined) ? (
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 px-1 text-[11px] text-gray-500">
                          {msg.provider && msg.model ? <span>{msg.provider} / {msg.model}</span> : null}
                          {msg.timeToFirstTokenMs !== undefined ? <span>TTFT {msg.timeToFirstTokenMs} ms</span> : null}
                          {msg.durationMs !== undefined ? <span>Latency {msg.durationMs} ms</span> : null}
                          {msg.usage?.totalTokens !== undefined ? <span>{msg.usage.totalTokens} tokens</span> : null}
                          {tokensPerSecond ? <span>{tokensPerSecond} tok/s</span> : null}
                        </div>
                      ) : null}
                      
                      {/* Message Actions */}
                      {!isUser && msg.content && (
                         <div className="flex items-center gap-2 mt-2 ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
                           <button 
                             onClick={() => handleCopy(msg.content, String(key))}
                             className="p-1.5 text-gray-500 hover:text-white rounded bg-white/5 hover:bg-white/10 transition-colors"
                             title="Copy message"
                           >
                             {copiedId === String(key) ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                           </button>
                         </div>
                      )}
                    </div>
                  </motion.div>
                );
              })}
              <div ref={messagesEndRef} className="h-4" />
            </div>
          )}
        </div>

        {/* Input Area */}
        <div className="p-4 md:p-6 bg-gradient-to-t from-[#09090B] pb-8 pt-4">
          <div className="max-w-4xl mx-auto relative group">
            <div className="absolute inset-0 bg-gradient-to-r from-primary/30 to-cyan-500/30 rounded-2xl blur-md opacity-20 group-focus-within:opacity-50 transition-opacity pointer-events-none"></div>
            <div className="relative bg-[#0f121d] border border-white/10 rounded-2xl flex flex-col p-2 pb-0 sm:pb-2 focus-within:border-primary/50 transition-colors shadow-2xl">
               
               <div className="flex items-end flex-1">
                 <textarea
                   ref={textareaRef}
                   value={input}
                   onChange={handleInput}
                   onKeyDown={handleKeyDown}
                   placeholder="Ask KFive AI anything..."
                   className="flex-1 bg-transparent text-white px-2 py-3 pb-4 resize-none max-h-48 min-h-[56px] focus:outline-none scrollbar-thin scrollbar-thumb-white/10 leading-relaxed text-[15px]"
                   style={{ height: '56px' }}
                   disabled={isLoading || !projectMutationsAllowed}
                 />
               
               <div className="p-2 shrink-0 self-end mb-1 flex items-center gap-2">
                 <button
                   onClick={toggleListening}
                   className={`p-3 rounded-xl transition-all border ${
                     isListening 
                       ? 'bg-red-500/20 text-red-400 border-red-500/30' 
                       : 'bg-white/5 text-gray-400 hover:text-white hover:bg-white/10 border-transparent'
                   }`}
                   title={isListening ? "Stop listening" : "Start Voice Input"}
                 >
                   <Mic className={`w-5 h-5 ${isListening ? 'animate-pulse text-red-500' : ''}`} />
                 </button>

                 {isLoading ? (
                    <button 
                      onClick={() => void stopGeneration()}
                      disabled={isStopping}
                      aria-label={isStopping ? 'Stopping generation' : 'Stop generation'}
                      className="p-3 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors border border-red-500/20"
                    >
                      <StopCircle className="w-5 h-5 fill-red-500/20" />
                    </button>
                 ) : (
                    <button 
                      onClick={() => sendPayload(input)}
                     disabled={!inputValidation.value || !projectMutationsAllowed}
                      className="p-3 rounded-xl bg-gradient-to-br from-primary to-cyan-500 text-white disabled:opacity-50 transition-all hover:opacity-90 shadow-[0_0_15px_rgba(139,92,246,0.5)] disabled:shadow-none"
                    >
                      <Send className="w-5 h-5" />
                    </button>
                 )}
               </div>
               </div>
            </div>
            
            {/* Character counter / Help text */}
            <div className="flex justify-between mt-2 px-1 text-xs text-gray-500">
              <span className={inputValidation.error && input ? 'text-amber-400' : 'opacity-0'}>{input && inputValidation.error ? inputValidation.error : 'Press Enter to send'}</span>
              <span>{inputValidation.characters} / 4000</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
