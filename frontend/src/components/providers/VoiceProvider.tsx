/// <reference types="@types/dom-speech-recognition" />
import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

interface VoiceContextType {
  isListening: boolean;
  isSupported: boolean;
  startListening: () => void;
  stopListening: () => void;
  speak: (text: string) => void;
  stopSpeaking: () => void;
}

const VoiceContext = createContext<VoiceContextType>({
  isListening: false,
  isSupported: false,
  startListening: () => {},
  stopListening: () => {},
  speak: () => {},
  stopSpeaking: () => {},
});

export function VoiceProvider({ children }: { children: ReactNode }) {
  const [isListening, setIsListening] = useState(false);
  const [recognition, setRecognition] = useState<SpeechRecognition | null>(null);
  const [synthesis] = useState(() => window.speechSynthesis);

  const isSupported = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;

  const startListening = useCallback(() => {
    if (!isSupported) return;

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognition() as SpeechRecognition;
    
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      setIsListening(true);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognition.onresult = (event: typeof window.SpeechRecognitionEvent extends undefined ? any : SpeechRecognitionEvent) => {
      // Handle speech recognition results
      console.log('Speech recognition result:', event);
    };

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event);
      setIsListening(false);
    };

    recognition.start();
    setRecognition(recognition);
  }, [isSupported]);

  const stopListening = useCallback(() => {
    if (recognition) {
      recognition.stop();
      setRecognition(null);
    }
    setIsListening(false);
  }, [recognition]);

  const speak = useCallback((text: string) => {
    if (!synthesis) return;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9;
    utterance.pitch = 1;
    utterance.volume = 0.8;

    synthesis.speak(utterance);
  }, [synthesis]);

  const stopSpeaking = useCallback(() => {
    if (synthesis) {
      synthesis.cancel();
    }
  }, [synthesis]);

  const value: VoiceContextType = {
    isListening,
    isSupported,
    startListening,
    stopListening,
    speak,
    stopSpeaking,
  };

  return (
    <VoiceContext.Provider value={value}>
      {children}
    </VoiceContext.Provider>
  );
}

export const useVoice = () => {
  const context = useContext(VoiceContext);
  if (!context) {
    throw new Error('useVoice must be used within a VoiceProvider');
  }
  return context;
};