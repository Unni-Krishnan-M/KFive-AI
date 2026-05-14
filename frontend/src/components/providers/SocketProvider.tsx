import React, { createContext, useContext, useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'react-hot-toast';

interface SocketContextType {
  socket: Socket | null;
  isConnected: boolean;
  joinConversation: (conversationId: string) => void;
  leaveConversation: (conversationId: string) => void;
  emitTyping: (conversationId: string, isTyping: boolean) => void;
}

const SocketContext = createContext<SocketContextType>({
  socket: null,
  isConnected: false,
  joinConversation: () => {},
  leaveConversation: () => {},
  emitTyping: () => {},
});

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const { accessToken, isAuthenticated } = useAuth();

  useEffect(() => {
    if (!isAuthenticated || !accessToken) {
      if (socket) {
        socket.disconnect();
        setSocket(null);
        setIsConnected(false);
      }
      return;
    }

    const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';
    
    const newSocket = io(WS_URL, {
      auth: {
        token: accessToken,
      },
      transports: ['websocket'],
      upgrade: true,
    });

    newSocket.on('connect', () => {
      console.log('Connected to WebSocket server');
      setIsConnected(true);
      toast.success('Connected to KFive AI');
    });

    newSocket.on('disconnect', (reason) => {
      console.log('Disconnected from WebSocket server:', reason);
      setIsConnected(false);
      
      if (reason === 'io server disconnect') {
        // Server disconnected, try to reconnect
        newSocket.connect();
      }
    });

    newSocket.on('connect_error', (error) => {
      console.error('WebSocket connection error:', error);
      setIsConnected(false);
      if (error.message.includes('Authentication')) {
        toast.error('Authentication failed. Please login again.');
      } else {
        toast.error('Connection failed. Retrying...');
      }
    });

    // Chat event listeners
    newSocket.on('chat:message', (data) => {
      // Handle incoming chat messages
      console.log('Received chat message:', data);
    });

    newSocket.on('chat:stream', (data) => {
      // Handle streaming AI responses
      console.log('Received stream chunk:', data);
    });

    newSocket.on('chat:user-typing', (data) => {
      // Handle typing indicators
      console.log('User typing:', data);
    });

    // Agent event listeners
    newSocket.on('agent:status', (data) => {
      // Handle agent status updates
      console.log('Agent status:', data);
    });

    newSocket.on('agent:thinking', (data) => {
      // Handle agent thinking state
      console.log('Agent thinking:', data);
    });

    // Voice event listeners
    newSocket.on('voice:ready', () => {
      console.log('Voice session ready');
    });

    newSocket.on('voice:stopped', () => {
      console.log('Voice session stopped');
    });

    // Notification listeners
    newSocket.on('notification:new', (data) => {
      toast.success(data.message);
    });

    setSocket(newSocket);

    return () => {
      newSocket.close();
    };
  }, [accessToken, isAuthenticated]);

  const joinConversation = (conversationId: string) => {
    if (socket) {
      socket.emit('chat:join', conversationId);
    }
  };

  const leaveConversation = (conversationId: string) => {
    if (socket) {
      socket.emit('chat:leave', conversationId);
    }
  };

  const emitTyping = (conversationId: string, isTyping: boolean) => {
    if (socket) {
      socket.emit('chat:typing', { conversationId, isTyping });
    }
  };

  const value: SocketContextType = {
    socket,
    isConnected,
    joinConversation,
    leaveConversation,
    emitTyping,
  };

  return (
    <SocketContext.Provider value={value}>
      {children}
    </SocketContext.Provider>
  );
}

export const useSocket = () => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
};