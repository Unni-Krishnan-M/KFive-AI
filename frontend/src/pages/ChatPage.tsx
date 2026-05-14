import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Bot, User, Send, StopCircle, Check, Copy, RefreshCw, MessageSquare, Plus, Brain, AlertCircle, FileText, Mic, X } from 'lucide-react';
import { chatApi } from '@/services/api';
import toast from 'react-hot-toast';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { getToken } from '@/utils/getToken';

const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

interface Message {
  _id?: string;
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  isStreamingError?: boolean;
}

interface Conversation {
  _id?: string;
  id?: string;
  title: string;
  updatedAt: string;
  messages?: Message[];
}

export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const linkedDocumentId = location.state?.documentId;
  
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState(localStorage.getItem('kfive-default-model') || 'llama3');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachedFile, setAttachedFile] = useState<File | null>(null);

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
    fetchConversations();
  }, [conversationId]);

  useEffect(() => {
    if (conversationId) {
      loadConversationContext(conversationId);
    } else {
      setMessages([]);
    }
  }, [conversationId]);

  const fetchConversations = async () => {
    try {
      const res = await chatApi.getConversations(1, 20);
      if (res.data?.data?.conversations) {
        setConversations(res.data.data.conversations);
      }
    } catch(e) {}
  };

  const loadConversationContext = async (id: string) => {
    try {
      const res = await chatApi.getConversation(id);
      if (res.data?.data?.messages) {
        setMessages(res.data.data.messages);
      }
    } catch {}
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

  const stopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  };

  const sendPayload = async (text: string) => {
    if (!text.trim() || isLoading) return;
    
    // Stop any ongoing stream just in case
    stopGeneration();
    abortControllerRef.current = new AbortController();

    const userMessage: Message = { id: Date.now().toString(), role: 'user', content: text };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setAttachedFile(null);
    setIsLoading(true);
    
    if (textareaRef.current) {
      textareaRef.current.style.height = '56px'; // reset roughly
    }

    let activeConversationId = conversationId;

    try {
      if (!activeConversationId) {
        const title = text.slice(0, 30) + (text.length > 30 ? '...' : '');
        const res = await chatApi.createConversation({ title });
        activeConversationId = res.data?.data?._id;
        navigate(`/app/chat/${activeConversationId}`, { replace: true });
        // Update history
        fetchConversations();
      }

      const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const token = getToken();

      const aiMsgId = Date.now().toString() + 'ai';
      setMessages(prev => [...prev, { id: aiMsgId, role: 'assistant', content: '' }]);

      const response = await fetch(`${API_URL}/api/v1/chat/conversations/${activeConversationId}/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ 
          message: text, 
          model: selectedModel,
          documentId: linkedDocumentId 
        }),
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) throw new Error('API request failed');

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.replace('data: ', '').trim();
              if (dataStr === '[DONE]') break;
              try {
                const data = JSON.parse(dataStr);
                if (data.content) {
                  setMessages(prev => prev.map(m => m.id === aiMsgId ? { ...m, content: m.content + data.content } : m));
                }
              } catch(e) {}
            }
          }
        }
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        const errorMsgId = Date.now().toString() + 'err';
        setMessages(prev => {
          const last = prev[prev.length - 1];
          // If chunking failed mid-stream, append error to it
          if (last && last.role === 'assistant') {
            return prev.map(m => m.id === last.id ? { ...m, isStreamingError: true } : m);
          }
          return [...prev, { id: errorMsgId, role: 'assistant', content: 'Sorry, I encountered an error. Please try again.', isStreamingError: true }];
        });
        toast.error('Failed to get response');
      }
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
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

  const activeTitle = conversations.find(c => c._id === conversationId || c.id === conversationId)?.title;

  return (
    <div className="flex h-full w-full bg-[#09090B]">
      {/* Left Sidebar - Conversation History */}
      <div className="hidden md:flex flex-col w-[280px] border-r border-white/10 bg-[#0a0d1a] h-full shrink-0">
        <div className="p-4 border-b border-white/10 shrink-0">
          <button 
            onClick={() => navigate('/app/chat')}
            className="w-full flex items-center justify-center gap-2 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 text-white rounded-xl transition-all font-medium"
          >
            <Plus size={18} /> New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1 scrollbar-thin scrollbar-thumb-white/10">
          <div className="text-xs font-semibold text-gray-500 mb-2 px-2 uppercase tracking-wider">Recent</div>
          {conversations.map(conv => {
            const isActive = conv._id === conversationId || conv.id === conversationId;
            return (
              <div 
                key={conv._id || conv.id} 
                onClick={() => navigate(`/app/chat/${conv._id || conv.id}`)}
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
             {linkedDocumentId && <div className="text-xs text-primary font-medium flex items-center gap-1"><FileText size={10}/> Analyzing Document</div>}
          </div>
          <div className="flex items-center">
            <select 
              value={selectedModel}
              onChange={handleModelChange}
              className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-300 font-medium focus:outline-none focus:ring-1 focus:ring-primary appearance-none cursor-pointer hover:bg-white/5 transition-colors"
            >
              <option value="llama3">Llama 3 (8B)</option>
              <option value="mistral">Mistral (7B)</option>
              <option value="deepseek-coder">DeepSeek Coder</option>
              <option value="phi3">Phi-3 Mini</option>
            </select>
          </div>
        </div>

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
                            {msg.content === '' && isLoading ? (
                              <span className="flex items-center gap-1 my-2">
                                <span className="w-2 h-2 rounded-full bg-primary animate-bounce"></span>
                                <span className="w-2 h-2 rounded-full bg-primary animate-bounce delay-100"></span>
                                <span className="w-2 h-2 rounded-full bg-primary animate-bounce delay-200"></span>
                              </span>
                            ) : (
                              <ReactMarkdown
                                components={{
                                  code({node, inline, className, children, ...props}: any) {
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
                            
                            {msg.isStreamingError && (
                              <div className="mt-3 inline-flex items-center gap-2 bg-red-500/10 text-red-400 px-3 py-1.5 rounded-lg border border-red-500/20 text-xs font-medium">
                                <AlertCircle size={14} /> Response interrupted
                              </div>
                            )}
                           </div>
                        )}
                      </div>
                      
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
                           {index === messages.length - 1 && (
                             <button 
                               onClick={() => {
                                 // Simple logic to regenerate last user prompt
                                 const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
                                 if (lastUserMsg) sendPayload(lastUserMsg.content);
                               }}
                               className="p-1.5 text-gray-500 hover:text-white rounded bg-white/5 hover:bg-white/10 transition-colors"
                               title="Regenerate response"
                             >
                                <RefreshCw size={14} />
                             </button>
                           )}
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
               
               {attachedFile && (
                 <div className="px-3 pt-2 pb-1 flex items-center">
                   <div className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 flex items-center gap-2 text-sm text-gray-300">
                     <FileText size={14} className="text-cyan-400" />
                     <span className="truncate max-w-[200px]">{attachedFile.name}</span>
                     <button onClick={() => setAttachedFile(null)} className="text-gray-500 hover:text-red-400 transition-colors ml-1">
                       <X size={14} />
                     </button>
                   </div>
                 </div>
               )}

               <div className="flex items-end flex-1">
                 <input 
                   type="file" 
                   ref={fileInputRef} 
                   className="hidden" 
                   onChange={(e) => setAttachedFile(e.target.files?.[0] || null)} 
                   accept=".pdf,.doc,.docx,.txt,.csv"
                 />
                 <div className="p-2 shrink-0 self-end mb-1">
                   <button 
                     onClick={() => fileInputRef.current?.click()}
                     className="p-3 rounded-xl bg-white/5 text-gray-400 hover:text-white hover:bg-white/10 transition-colors border border-transparent"
                     title="Attach document"
                   >
                     <Plus className="w-5 h-5 opacity-80" />
                   </button>
                 </div>
                 
                 <textarea
                   ref={textareaRef}
                   value={input}
                   onChange={handleInput}
                   onKeyDown={handleKeyDown}
                   placeholder="Ask KFive AI anything..."
                   className="flex-1 bg-transparent text-white px-2 py-3 pb-4 resize-none max-h-48 min-h-[56px] focus:outline-none scrollbar-thin scrollbar-thumb-white/10 leading-relaxed text-[15px]"
                   style={{ height: '56px' }}
                   disabled={isLoading}
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
                      onClick={stopGeneration}
                      className="p-3 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors border border-red-500/20"
                    >
                      <StopCircle className="w-5 h-5 fill-red-500/20" />
                    </button>
                 ) : (
                    <button 
                      onClick={() => sendPayload(input)}
                      disabled={!input.trim()}
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
              <span className="opacity-0">Press Cmd+Enter to send</span>
              <span>{input.length} / 4000</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}