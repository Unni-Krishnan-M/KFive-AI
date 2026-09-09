import { Response, Router } from 'express';
import { Conversation } from '@/models/Conversation';
import { AppError, asyncHandler } from '@/middleware/errorHandler';
import { getAuthenticatedUserId } from '@/middleware/auth';
import { aiLimiter } from '@/middleware/rateLimiter';
import { projectService } from '@/services/projectService';
import { ChatError, ChatService, ChatStreamEvent, chatService } from '@/services/chatService';

const PAGE_MAXIMUM = 10_000;
const LIMIT_MAXIMUM = 50;

function exactInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new AppError(`${label} must be an integer from 1 to ${maximum}.`, 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AppError(`${label} must be an integer from 1 to ${maximum}.`, 400);
  }
  return parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unsafeText(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point === 0xfffd || /\p{Cf}/u.test(character)
      || (point < 32 && point !== 9 && point !== 10) || (point >= 127 && point <= 159);
  });
}

export function validateConversationCreateInput(value: unknown): { title: string; projectId?: unknown } {
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== 'title' && key !== 'projectId')) {
    throw new AppError('Conversation input may contain only title and projectId.', 400);
  }
  const titleValue = value.title === undefined ? 'New Conversation' : value.title;
  if (typeof titleValue !== 'string') throw new AppError('Conversation title must be text.', 400);
  const title = titleValue.normalize('NFC').trim();
  if (!title || [...title].length > 200 || Buffer.byteLength(title, 'utf8') > 800 || unsafeText(title)) {
    throw new AppError('Conversation title must contain 1 to 200 safe characters.', 400);
  }
  return { title, ...(value.projectId !== undefined ? { projectId: value.projectId } : {}) };
}

function writeSse(res: Response, event: string, requestId: string, value: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`id: ${requestId}\nevent: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  res.flush?.();
}

export function createChatRouter(generations: ChatService = chatService): Router {
  const router = Router();

  router.get('/conversations', asyncHandler(async (req, res) => {
    const page = exactInteger(req.query.page, 1, PAGE_MAXIMUM, 'Conversation page');
    const limit = exactInteger(req.query.limit, 20, LIMIT_MAXIMUM, 'Conversation limit');
    const userId = getAuthenticatedUserId(req);
    const project = await projectService.resolveOwnedProject(userId, req.query.projectId);
    const filter = { userId, ...(project ? { projectId: project._id } : {}) };
    const query = Conversation.find(filter)
      .select('title projectId settings metadata generation createdAt updatedAt')
      .sort({ 'metadata.lastMessageAt': -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
    const [conversations, total] = await Promise.all([query, Conversation.countDocuments(filter)]);
    res.json({
      success: true,
      data: conversations,
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  }));

  router.get('/conversations/:id', asyncHandler(async (req, res) => {
    const userId = getAuthenticatedUserId(req);
    const conversation = await Conversation.findOne({ _id: req.params.id, userId }).lean();
    if (!conversation) throw new AppError('Conversation not found', 404);
    res.json({ success: true, data: conversation });
  }));

  router.post('/conversations', asyncHandler(async (req, res) => {
    const userId = getAuthenticatedUserId(req);
    const input = validateConversationCreateInput(req.body);
    const project = await projectService.resolveActiveProject(userId, input.projectId);
    const conversation = await Conversation.create({
      userId,
      ...(project ? { projectId: project._id } : {}),
      title: input.title,
      messages: [],
      metadata: {
        totalTokens: 0,
        messageCount: 0,
        lastMessageAt: new Date(),
        isArchived: false,
        isPinned: false,
        tags: [],
      },
    });
    res.status(201).json({ success: true, data: conversation });
  }));

  router.post('/conversations/:id/generation/cancel', asyncHandler(async (req, res) => {
    if (!isPlainObject(req.body) || Object.keys(req.body).length !== 1 || !('requestId' in req.body)) {
      throw new AppError('Cancellation input must contain only requestId.', 400);
    }
    const result = generations.cancel(getAuthenticatedUserId(req), req.params.id, req.body.requestId);
    res.json({ success: true, data: result });
  }));

  router.post('/conversations/:id/stream', aiLimiter, asyncHandler(async (req, res) => {
    const prepared = await generations.prepare(getAuthenticatedUserId(req), req.params.id, req.body);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.flushHeaders?.();
    const connection = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) connection.abort();
    });
    const emit = (event: ChatStreamEvent): void => {
      if (event.type === 'generation') {
        writeSse(res, 'generation', event.requestId, { requestId: event.requestId, status: event.status });
      } else if (event.type === 'start') {
        writeSse(res, 'start', event.requestId, {
          requestId: event.requestId,
          provider: event.provider,
          model: event.model,
        });
      } else if (event.type === 'delta') {
        writeSse(res, 'delta', event.requestId, { requestId: event.requestId, content: event.content });
      } else if (event.type === 'usage') {
        writeSse(res, 'usage', event.requestId, { requestId: event.requestId, usage: event.usage });
      } else {
        writeSse(res, 'completed', event.requestId, {
          requestId: event.requestId,
          generation: event.generation,
        });
      }
    };
    try {
      await generations.execute(prepared, emit, connection.signal);
      if (!res.writableEnded && !res.destroyed) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } catch (error) {
      if (!res.writableEnded && !res.destroyed) {
        const safe = error instanceof ChatError
          ? { code: error.code, message: error.message }
          : { code: 'CHAT_GENERATION_FAILED', message: 'The chat generation failed.' };
        writeSse(res, 'error', prepared.requestId, { requestId: prepared.requestId, ...safe });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  }));

  return router;
}

export default createChatRouter();
