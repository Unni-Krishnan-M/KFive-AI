import { Router } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { Agent } from '@/models/Agent';
import { AppError } from '@/middleware/errorHandler';
import { ollamaService } from '@/services/ollama';

const router = Router();

// Get user agents
router.get('/', asyncHandler(async (req, res) => {
  const userId = (req as any).user?.userId || 'default-user-id';
  const agents = await Agent.find({ userId }).sort({ updatedAt: -1 });

  res.json({
    success: true,
    data: agents
  });
}));

// Create an agent
router.post('/', asyncHandler(async (req, res) => {
  const userId = (req as any).user?.userId || 'default-user-id';
  const { name, description, systemPrompt, aiModel, temperature, tools } = req.body;

  if (!name || !systemPrompt) {
    throw new AppError('Name and system prompt are required', 400);
  }

  const agent = await Agent.create({
    userId,
    name,
    description: description || 'A helpful AI Agent',
    systemPrompt,
    aiModel: aiModel || process.env.OLLAMA_CHAT_MODEL || 'phi3',
    temperature: temperature || 0.7,
    tools: tools || []
  });

  res.status(201).json({ success: true, data: agent });
}));

// Execute agent logic
router.post('/:id/execute', asyncHandler(async (req, res) => {
  const agent = await Agent.findById(req.params.id);
  if (!agent) throw new AppError('Agent not found', 404);

  const { prompt } = req.body;
  if (!prompt) throw new AppError('Prompt required for execution', 400);

  // For SSE Execution
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const formattedMessages = [
      { role: 'system', content: agent.systemPrompt },
      { role: 'user', content: prompt }
    ];

    let fullResponse = '';

    await ollamaService.chatStream(
      {
        model: agent.aiModel,
        messages: formattedMessages as any,
        options: {
          temperature: agent.temperature
        }
      },
      (chunk) => {
        fullResponse += chunk.message.content;
        res.write(`data: ${JSON.stringify({ content: chunk.message.content })}\n\n`);
      }
    );

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error: any) {
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
}));

// Delete agent
router.delete('/:id', asyncHandler(async (req, res) => {
  const agent = await Agent.findByIdAndDelete(req.params.id);
  if (!agent) throw new AppError('Agent not found', 404);

  res.json({ success: true, data: agent });
}));

export default router;
