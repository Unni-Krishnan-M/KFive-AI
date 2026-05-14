import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { logger } from '@/utils/logger';

export function setupSocketHandlers(io: Server): void {
  // Authentication middleware
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
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
    socket.on('chat:join', (conversationId: string) => {
      socket.join(`conversation:${conversationId}`);
      logger.debug(`User ${userId} joined conversation ${conversationId}`);
    });

    socket.on('chat:leave', (conversationId: string) => {
      socket.leave(`conversation:${conversationId}`);
      logger.debug(`User ${userId} left conversation ${conversationId}`);
    });

    socket.on('chat:typing', (data: { conversationId: string; isTyping: boolean }) => {
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
    socket.on('workspace:join', (workspaceId: string) => {
      socket.join(`workspace:${workspaceId}`);
      logger.debug(`User ${userId} joined workspace ${workspaceId}`);
    });

    socket.on('workspace:leave', (workspaceId: string) => {
      socket.leave(`workspace:${workspaceId}`);
      logger.debug(`User ${userId} left workspace ${workspaceId}`);
    });

    // Handle agent events
    socket.on('agent:thinking', (data: { conversationId: string; agentId: string }) => {
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