import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, AlertCircle, Bot, Loader2, Volume2, Square, VolumeX, History, Globe } from 'lucide-react';
import { chatApi } from '@/services/api';
import toast from 'react-hot-toast';
import { getToken } from '@/utils/getToken';

const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

interface HistoryItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export default function VoiceAssistantPage() {
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [language, setLanguage] = useState('en-US');
  
  const recognitionRef = useRef<any>(null);
  const synthRef = useRef<SpeechSynthesis | null>(null);

  useEffect(() => {
    if ('speechSynthesis' in window) {
       synthRef.current = window.speechSynthesis;
    }

    if (SpeechRecognitionAPI && !recognitionRef.current) {
      const recognition = new SpeechRecognitionAPI();
      recognition.continuous = true;
      recognition.interimResults = true;
      
      recognition.onresult = (event: any) => {
        let currentTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcriptPiece = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            currentTranscript += transcriptPiece + ' ';
            handleSendToAI(transcriptPiece);
          } else {
            currentTranscript += transcriptPiece;
          }
        }
        setTranscript(currentTranscript);
      };

      recognition.onerror = (event: any) => {
        if (event.error === 'not-allowed') {
          toast.error('Microphone access denied. Please allow permissions.');
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
      if (synthRef.current) {
        synthRef.current.cancel();
      }
    };
  }, []); // Fix: removed conversationId to prevent re-init loop

  // Update language on ref
  useEffect(() => {
    if (recognitionRef.current) {
      recognitionRef.current.lang = language;
    }
  }, [language]);

  const toggleListening = () => {
    if (!SpeechRecognitionAPI) {
      toast.error('Browser does not support Speech Recognition. Please use Chrome/Edge.');
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    } else {
      if (synthRef.current) synthRef.current.cancel(); 
      setTranscript('');
      try {
        recognitionRef.current?.start();
        setIsListening(true);
      } catch (err) {
        console.error('Start error', err);
      }
    }
  };

  const speakText = (text: string) => {
    if (synthRef.current && !isMuted) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = volume;
      
      const voices = synthRef.current.getVoices();
      const preferredVoices = voices.filter(v => v.lang.startsWith(language.split('-')[0]));
      const selected = preferredVoices.find(v => v.name.includes('Google') || v.name.includes('Samantha') || v.name.includes('Natural')) || preferredVoices[0] || voices[0];
      
      if (selected) {
        utterance.voice = selected;
      }
      
      synthRef.current.speak(utterance);
    }
  };

  const handleSendToAI = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    
    if (recognitionRef.current) recognitionRef.current.stop();
    setIsListening(false);
    setIsProcessing(true);
    
    const userMsgId = Date.now().toString();
    setHistory(prev => [...prev, { id: userMsgId, role: 'user', content: trimmed }]);

    try {
      let chatId = conversationId;
      if (!chatId) {
        // mock API or realistic
        chatId = 'voice-' + Date.now();
        setConversationId(chatId);
      }

      const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const token = getToken();

      const response = await fetch(`${API_URL}/api/v1/chat/conversations/${chatId}/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ message: trimmed })
      });

      if (!response.ok) {
        // Fallback demo for UI demonstration if NO backend exists
        throw new Error('API Error');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      
      const aiMsgId = (Date.now() + 1).toString();
      setHistory(prev => [...prev, { id: aiMsgId, role: 'assistant', content: '' }]);

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
                  fullText += data.content;
                  setHistory(prev => prev.map(m => m.id === aiMsgId ? { ...m, content: m.content + data.content } : m));
                }
              } catch(e) {}
            }
          }
        }
      }

      speakText(fullText);

    } catch (error) {
      // Demo Fallback Mode
      const aiMsgId = (Date.now() + 1).toString();
      const demoResponse = `I heard: ${trimmed}. Since backends are mostly offline, I'm just acknowledging you.`;
      setHistory(prev => [...prev, { id: aiMsgId, role: 'assistant', content: demoResponse }]);
      speakText(demoResponse);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleInterrupt = () => {
    if (synthRef.current) {
      synthRef.current.cancel();
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row h-full">
      {/* Left Area - Main Interaction */}
      <div className="flex-1 flex flex-col p-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center justify-between mb-8"
        >
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-3 text-white">
              <Volume2 className="w-8 h-8 text-primary" />
              Voice Assistant
            </h1>
            <p className="text-gray-400 mt-1">
              Hands-free conversational AI.
            </p>
          </div>
          
          <div className="flex items-center gap-4 bg-white/5 p-2 rounded-xl border border-white/10">
            <div className="flex items-center gap-2 pr-3 border-r border-white/10">
              <Globe className="w-4 h-4 text-gray-400" />
              <select 
                value={language}
                onChange={e => setLanguage(e.target.value)}
                className="bg-transparent text-sm text-gray-300 focus:outline-none appearance-none"
              >
                <option value="en-US">English (US)</option>
                <option value="es-ES">Spanish</option>
                <option value="fr-FR">French</option>
                <option value="de-DE">German</option>
              </select>
            </div>
            
            <div className="flex items-center gap-3 pr-2">
              <button 
                onClick={() => setIsMuted(!isMuted)} 
                className="text-gray-400 hover:text-white"
                aria-label={isMuted ? "Unmute" : "Mute"}
              >
                {isMuted ? <VolumeX className="w-5 h-5 text-red-400" /> : <Volume2 className="w-5 h-5 text-cyan-400" />}
              </button>
              <input 
                type="range" 
                min="0" max="1" step="0.1" 
                value={volume} 
                onChange={e => setVolume(parseFloat(e.target.value))}
                className="w-20 h-1.5 bg-black/40 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />
            </div>
          </div>
        </motion.div>

        <div className="flex-1 flex flex-col items-center justify-center -mt-10">
          {/* Core interaction sphere */}
          <div className="relative flex items-center justify-center h-72 w-72 mb-10">
             {isListening && (
                <motion.div 
                  className="absolute inset-0 bg-primary/20 rounded-full blur-xl"
                  animate={{ scale: [1, 1.25, 1], opacity: [0.5, 0.8, 0.5] }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
                />
             )}
             {isProcessing && (
                <motion.div 
                  className="absolute inset-0 bg-purple-500/20 rounded-full blur-xl"
                  animate={{ rotate: 360, scale: [1, 1.1, 1] }}
                  transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
                />
             )}
             
             <button
               onClick={toggleListening}
               disabled={isProcessing}
               className={`relative z-10 w-36 h-36 rounded-full flex items-center justify-center transition-all ${
                 isListening ? 'bg-red-500 hover:bg-red-600 shadow-[0_0_60px_rgba(239,68,68,0.5)]' :
                 isProcessing ? 'bg-purple-500 cursor-wait shadow-[0_0_60px_rgba(168,85,247,0.5)]' :
                 'bg-gradient-to-br from-primary to-cyan-500 hover:opacity-90 shadow-[0_0_50px_rgba(6,182,212,0.4)]'
               }`}
             >
               {isListening ? (
                 <Square className="w-12 h-12 text-white fill-white" />
               ) : isProcessing ? (
                 <Loader2 className="w-14 h-14 text-white animate-spin" />
               ) : (
                 <Mic className="w-14 h-14 text-white" />
               )}
             </button>
          </div>

          {/* Status text */}
          <div className="text-center space-y-3 h-24 max-w-xl">
            <h2 className="text-2xl font-medium text-white">
              {isListening ? "Listening to you..." : 
               isProcessing ? "AI is processing..." : 
               "Tap the microphone to speak"}
            </h2>
            <p className="text-gray-400 text-lg opacity-90 h-10 overflow-hidden text-ellipsis italic">
              {transcript && isListening ? `"${transcript}"` : ""}
            </p>
          </div>

          <AnimatePresence>
            {window.speechSynthesis?.speaking && (
              <motion.button 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9 }}
                onClick={handleInterrupt}
                className="mt-4 px-6 py-2.5 text-sm font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 rounded-full flex items-center gap-2 transition-all shadow-lg backdrop-blur-sm"
              >
                <Square className="w-4 h-4 fill-current" /> Stop Audio
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Right Area - History Sidebar */}
      <div className="w-full lg:w-96 bg-[#0a0d1a] border-l border-white/10 flex flex-col">
        <div className="p-4 border-b border-white/10 flex items-center gap-2 bg-black/20">
          <History className="w-5 h-5 text-purple-400" />
          <h2 className="font-semibold text-white">Conversation History</h2>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin scrollbar-thumb-white/10">
          {history.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-gray-500 opacity-60">
              <Bot className="w-12 h-12 mb-3 text-gray-600" />
              <p>No messages yet.</p>
            </div>
          ) : (
            history.map((msg, i) => (
              <motion.div 
                key={msg.id}
                initial={{ opacity: 0, x: msg.role === 'user' ? 20 : -20 }}
                animate={{ opacity: 1, x: 0 }}
                className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div className={`text-xs text-gray-500 mb-1 flex gap-1 items-center ${msg.role === 'user' && 'flex-row-reverse'}`}>
                  {msg.role === 'assistant' && <Bot size={12} className="text-primary"/>}
                  {msg.role === 'user' ? 'You' : 'KFive AI'}
                </div>
                <div className={`px-4 py-2.5 rounded-2xl max-w-[85%] text-sm ${msg.role === 'user' ? 'bg-primary text-white rounded-tr-sm' : 'bg-white/10 text-gray-200 border border-white/5 rounded-tl-sm'}`}>
                  {msg.content || <span className="animate-pulse flex h-1.5 w-1.5 rounded-full bg-primary mx-2"></span>}
                </div>
              </motion.div>
            ))
          )}
        </div>
      </div>
      
      {/* Warning if Speech API is unavailable */}
      {!SpeechRecognitionAPI && (
        <div className="absolute bottom-6 left-6 max-w-sm p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-xl flex items-start gap-3 backdrop-blur-md shadow-xl z-50">
          <AlertCircle className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />
          <div className="text-sm text-yellow-200 text-left">
            <strong>Browser Compatibility Warning:</strong> Native SpeechRecognition is not fully supported in your browser. 
            Please use Google Chrome or Microsoft Edge.
          </div>
        </div>
      )}
    </div>
  );
}