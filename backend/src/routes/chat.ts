import { Router } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { Conversation } from '@/models/Conversation';
import { AppError } from '@/middleware/errorHandler';

const router = Router();

// Get conversations
router.get('/conversations', asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;

  // Temporary fix for auth since the frontend might not pass valid tokens yet if not strictly logged in
  // Usually this would use req.user.userId
  const userId = (req as any).user?.userId || 'default-user-id';

  const conversations = await Conversation.find({ userId })
    .sort({ 'metadata.lastMessageAt': -1 })
    .skip((page - 1) * limit)
    .limit(limit);

  const total = await Conversation.countDocuments({ userId });

  res.json({
    success: true,
    data: conversations,
    meta: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  });
}));

// Get specific conversation
router.get('/conversations/:id', asyncHandler(async (req, res) => {

  
  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) throw new AppError('Conversation not found', 404);

  res.json({ success: true, data: conversation });
}));

// Create conversation
router.post('/conversations', asyncHandler(async (req, res) => {
  const userId = (req as any).user?.userId || 'default-user-id';
  
  const { title, messages, settings, agent, workspace } = req.body;
  
  const conversation = await Conversation.create({
    userId,
    title: title || 'New Conversation',
    messages: messages || [],
    settings: settings || {},
    agent,
    workspace,
    metadata: {
      totalTokens: 0,
      messageCount: messages ? messages.length : 0,
      lastMessageAt: new Date(),
      isArchived: false,
      isPinned: false,
      tags: []
    }
  });

  res.status(201).json({ success: true, data: conversation });
}));

// Send message
router.post('/conversations/:id/messages', asyncHandler(async (req, res) => {
  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) throw new AppError('Conversation not found', 404);

  const message = req.body;
  message.timestamp = message.timestamp || new Date();
  
  conversation.messages.push(message);
  await conversation.save();

  res.json({ success: true, data: conversation });
}));

import { ollamaService } from '@/services/ollama';

// Stream chat completion
router.post('/conversations/:id/stream', asyncHandler(async (req, res) => {
  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) throw new AppError('Conversation not found', 404);

  const { message } = req.body;
  if (!message) throw new AppError('Message is required', 400);

  // Add user message to conversation
  conversation.messages.push({
    role: 'user',
    content: message,
    timestamp: new Date()
  } as any);

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const formattedMessages = conversation.messages.map(msg => ({
      role: msg.role === 'system' ? 'system' : (msg.role === 'assistant' ? 'assistant' : 'user'),
      content: msg.content
    }));

    let fullResponse = '';

    await ollamaService.chatStream(
      {
        model: conversation.settings?.model || 'phi3', // Optimized for lower RAM environments than llama3
        messages: formattedMessages as any,
      },
      (chunk) => {
        fullResponse += chunk.message.content;
        res.write(`data: ${JSON.stringify({ content: chunk.message.content })}\n\n`);
      }
    );

    // Save AI message to DB
    conversation.messages.push({
      role: 'assistant',
      content: fullResponse,
      timestamp: new Date()
    } as any);
    await conversation.save();

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error: any) {
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
}));

export default router;