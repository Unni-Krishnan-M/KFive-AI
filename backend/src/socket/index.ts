import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { logger } from '@/utils/logger';
import { Conversation } from '@/models/Conversation';
import { isValidObjectId } from 'mongoose';

export function setupSocketHandlers(io: Server): void {
  // Authentication middleware
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET!, {
        algorithms: ['HS256'],
        issuer: 'kfive-ai',
        audience: 'kfive-web',
      });
      if (typeof decoded === 'string' || typeof decoded.userId !== 'string' || typeof decoded.email !== 'string') {
        return next(new Error('Authentication error: Invalid token payload'));
      }
      socket.data.userId = decoded.userId;
      socket.data.email = decoded.email;
      
      next();
    } catch (error) {
      logger.error('Socket authentication error:', error);
      next(new Error('Authentication error: Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    logger.info(`User ${userId} connected via WebSocket`);

    // Join user-specific room
    socket.join(`user:${userId}`);

    // Handle chat events
    socket.on('chat:join', async (conversationId: string) => {
      if (!isValidObjectId(conversationId)) {
        socket.emit('chat:error', { message: 'Conversation not found' });
        return;
      }
      const ownsConversation = await Conversation.exists({ _id: conversationId, userId });
      if (!ownsConversation) {
        socket.emit('chat:error', { message: 'Conversation not found' });
        return;
      }
      await socket.join(`conversation:${conversationId}`);
      logger.debug(`User ${userId} joined conversation ${conversationId}`);
    });

    socket.on('chat:leave', (conversationId: string) => {
      socket.leave(`conversation:${conversationId}`);
      logger.debug(`User ${userId} left conversation ${conversationId}`);
    });

    socket.on('chat:typing', async (data: { conversationId: string; isTyping: boolean }) => {
      if (!isValidObjectId(data.conversationId)) {
        socket.emit('chat:error', { message: 'Conversation not found' });
        return;
      }
      const ownsConversation = await Conversation.exists({ _id: data.conversationId, userId });
      if (!ownsConversation) {
        socket.emit('chat:error', { message: 'Conversation not found' });
        return;
      }
      socket.to(`conversation:${data.conversationId}`).emit('chat:user-typing', {
        userId,
        isTyping: data.isTyping
      });
    });

    socket.on('voice:start', () => {
      socket.emit('voice:ready');
      logger.debug(`Voice session started for user ${userId}`);
    });

    socket.on('voice:audio_chunk', (data: Buffer) => {
      // Stub receiver for audio binary blobs preventing crashes 
      // if generic frontend audio API multiplexes to socket pipeline.
      logger.debug(`Received audio chunk (${data.byteLength} bytes) for user ${userId}`);
    });

    socket.on('voice:end', () => {
      socket.emit('voice:stopped');
      logger.debug(`Voice session ended for user ${userId}`);
    });

    // Handle workspace events
    socket.on('workspace:join', () => {
      socket.emit('workspace:error', { message: 'Workspace rooms are unavailable until project authorization is implemented' });
    });

    socket.on('workspace:leave', (workspaceId: string) => {
      socket.leave(`workspace:${workspaceId}`);
      logger.debug(`User ${userId} left workspace ${workspaceId}`);
    });

    // Handle agent events
    socket.on('agent:thinking', async (data: { conversationId: string; agentId: string }) => {
      if (!isValidObjectId(data.conversationId)) {
        socket.emit('chat:error', { message: 'Conversation not found' });
        return;
      }
      const ownsConversation = await Conversation.exists({ _id: data.conversationId, userId });
      if (!ownsConversation) {
        socket.emit('chat:error', { message: 'Conversation not found' });
        return;
      }
      socket.to(`conversation:${data.conversationId}`).emit('agent:status', {
        agentId: data.agentId,
        status: 'thinking'
      });
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      logger.info(`User ${userId} disconnected: ${reason}`);
    });

    // Error handling
    socket.on('error', (error) => {
      logger.error(`Socket error for user ${userId}:`, error);
    });
  });

  logger.info('✅ Socket.IO handlers initialized');
}
