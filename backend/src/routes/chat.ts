import { Router } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { Conversation } from '@/models/Conversation';
import { AppError } from '@/middleware/errorHandler';
import { getAuthenticatedUserId } from '@/middleware/auth';
import { projectService } from '@/services/projectService';

const router = Router();

// Get conversations
router.get('/conversations', asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;

  const userId = getAuthenticatedUserId(req);
  const project = await projectService.resolveOwnedProject(userId, req.query.projectId);
  const filter = { userId, ...(project ? { projectId: project._id } : {}) };

  const conversations = await Conversation.find(filter)
    .sort({ 'metadata.lastMessageAt': -1 })
    .skip((page - 1) * limit)
    .limit(limit);

  const total = await Conversation.countDocuments(filter);

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

  
  const userId = getAuthenticatedUserId(req);
  const conversation = await Conversation.findOne({ _id: req.params.id, userId });
  if (!conversation) throw new AppError('Conversation not found', 404);

  res.json({ success: true, data: conversation });
}));

// Create conversation
router.post('/conversations', asyncHandler(async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  
  const { title, messages, settings, agent, workspace, projectId } = req.body;
  const project = await projectService.resolveActiveProject(userId, projectId);
  
  const conversation = await Conversation.create({
    userId,
    ...(project ? { projectId: project._id } : {}),
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
  const userId = getAuthenticatedUserId(req);
  const conversation = await Conversation.findOne({ _id: req.params.id, userId });
  if (!conversation) throw new AppError('Conversation not found', 404);
  await projectService.resolveActiveProject(userId, conversation.projectId?.toString());

  const message = req.body;
  message.timestamp = message.timestamp || new Date();
  
  conversation.messages.push(message);
  await conversation.save();

  res.json({ success: true, data: conversation });
}));

import { AiMessage, getAiProvider } from '@/services/aiProvider';
import { aiLimiter } from '@/middleware/rateLimiter';
import { getEnvironment } from '@/config/environment';

// Stream chat completion
router.post('/conversations/:id/stream', aiLimiter, asyncHandler(async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  const conversation = await Conversation.findOne({ _id: req.params.id, userId });
  if (!conversation) throw new AppError('Conversation not found', 404);
  await projectService.resolveActiveProject(userId, conversation.projectId?.toString());

  const { message, model } = req.body;
  if (!message) throw new AppError('Message is required', 400);
  const environment = getEnvironment();
  const selectedModel = typeof model === 'string' && model.length <= 200
    ? model
    : conversation.settings?.model || environment.aiDefaultModel;

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
  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const formattedMessages: AiMessage[] = conversation.messages.map(msg => ({
      role: msg.role === 'system' ? 'system' : (msg.role === 'assistant' ? 'assistant' : 'user'),
      content: msg.content
    }));

    let fullResponse = '';

    const provider = getAiProvider();
    await provider.chatStream(
      {
        model: selectedModel,
        messages: formattedMessages,
        temperature: conversation.settings?.temperature,
      },
      (event) => {
        if (event.type === 'start') {
          res.write(`data: ${JSON.stringify({ provider: event.provider, model: event.model })}\n\n`);
        } else if (event.type === 'delta') {
          fullResponse += event.content;
          res.write(`data: ${JSON.stringify({ content: event.content })}\n\n`);
        } else if (event.type === 'usage') {
          res.write(`data: ${JSON.stringify({ usage: event.usage })}\n\n`);
        }
      },
      { signal: abortController.signal }
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
    if (!res.writableEnded && !res.destroyed) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }
}));

export default router;
