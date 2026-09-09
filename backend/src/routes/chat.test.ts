import { Router } from 'express';
import { ChatService, PreparedChatGeneration } from '@/services/chatService';
import { createChatRouter, validateConversationCreateInput } from './chat';

const ownerId = '64b000000000000000000001';
const conversationId = '64b000000000000000000101';

function service(overrides: Partial<ChatService> = {}): ChatService {
  return {
    prepare: jest.fn(),
    execute: jest.fn(),
    cancel: jest.fn(),
    recoverInterrupted: jest.fn(),
    ...overrides,
  } as unknown as ChatService;
}

interface InvokeResult {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  output: string;
}

function invoke(
  router: Router,
  method: 'get' | 'post',
  path: string,
  values: { body?: unknown; query?: unknown; params?: unknown } = {}
): Promise<InvokeResult> {
  const layer = (router as unknown as { stack: Array<Record<string, any>> }).stack
    .find((entry) => entry.route?.path === path && entry.route.methods[method]);
  const handler = layer?.route.stack[layer.route.stack.length - 1].handle;
  if (!handler) throw new Error(`Missing route ${method} ${path}`);
  return new Promise((resolve, reject) => {
    let status = 200;
    let output = '';
    const headers: Record<string, string> = {};
    let settled = false;
    const finish = (body?: unknown): void => {
      if (settled) return;
      settled = true;
      resolve({ status, headers, body, output });
    };
    const response = {
      writableEnded: false,
      destroyed: false,
      status(code: number) { status = code; return this; },
      setHeader(name: string, value: string) { headers[name] = value; },
      flushHeaders: jest.fn(),
      flush: jest.fn(),
      once: jest.fn(),
      write(value: string) { output += value; return true; },
      end() { this.writableEnded = true; finish(); },
      json(body: unknown) { finish(body); return this; },
    };
    handler({
      body: values.body ?? {}, query: values.query ?? {}, params: values.params ?? {},
      user: { userId: ownerId, email: 'owner@example.com', role: 'user' },
    }, response, reject);
  });
}

describe('conversation request validation', () => {
  it('accepts a normalized title and project reference', () => {
    expect(validateConversationCreateInput({ title: '  Test chat  ', projectId: conversationId }))
      .toEqual({ title: 'Test chat', projectId: conversationId });
  });

  it.each([
    null,
    [],
    { title: '' },
    { title: 'ok', messages: [{ role: 'assistant', content: 'injected' }] },
    { title: `bad\u202etitle` },
  ])('rejects injected or unsafe create input %#', (value) => {
    expect(() => validateConversationCreateInput(value)).toThrow();
  });

  it('rejects junk and unbounded pagination before querying storage', async () => {
    const router = createChatRouter(service());
    await expect(invoke(router, 'get', '/conversations', { query: { page: '1junk' } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(invoke(router, 'get', '/conversations', { query: { limit: '51' } })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('chat SSE route', () => {
  const prepared: PreparedChatGeneration = {
    ownerId,
    conversationId,
    requestId: 'request-1234',
    model: 'phi3',
    messages: [{ role: 'user', content: 'hello' }],
    startedAt: new Date('2026-09-02T00:00:00Z'),
  };

  it('emits named request-scoped events only after prepare succeeds', async () => {
    const prepare = jest.fn().mockResolvedValue(prepared);
    const execute = jest.fn(async (_prepared, emit) => {
      emit({ type: 'generation', requestId: 'request-1234', status: 'running' });
      emit({ type: 'start', requestId: 'request-1234', provider: 'ollama', model: 'phi3' });
      emit({ type: 'delta', requestId: 'request-1234', content: 'hello' });
      const generation = {
        requestId: 'request-1234', status: 'succeeded' as const, userMessageId: conversationId,
        provider: 'ollama', model: 'phi3', outputBytes: 5,
        startedAt: prepared.startedAt, completedAt: new Date(),
      };
      emit({
        type: 'completed', requestId: 'request-1234',
        generation,
      });
      return generation;
    });
    const result = await invoke(createChatRouter(service({ prepare, execute })), 'post', '/conversations/:id/stream', {
      params: { id: conversationId }, body: { message: 'hello' },
    });
    expect(prepare).toHaveBeenCalledWith(ownerId, conversationId, { message: 'hello' });
    expect(result.headers).toMatchObject({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    expect(result.output).toContain('id: request-1234\nevent: generation');
    expect(result.output).toContain('event: start');
    expect(result.output).toContain('event: delta');
    expect(result.output).toContain('event: completed');
    expect(result.output).toContain('data: [DONE]');
  });

  it('replaces unexpected execution errors with a fixed public SSE error', async () => {
    const router = createChatRouter(service({
      prepare: jest.fn().mockResolvedValue(prepared),
      execute: jest.fn().mockRejectedValue(new Error('provider secret https://internal.invalid?key=abc')),
    }));
    const result = await invoke(router, 'post', '/conversations/:id/stream', {
      params: { id: conversationId }, body: { message: 'hello' },
    });
    expect(result.output).toContain('"code":"CHAT_GENERATION_FAILED"');
    expect(result.output).toContain('"message":"The chat generation failed."');
    expect(result.output).not.toContain('internal.invalid');
  });

  it('validates the exact cancellation envelope', async () => {
    const cancel = jest.fn().mockReturnValue({ requestId: 'request-1234', cancelRequested: true });
    const router = createChatRouter(service({ cancel }));
    await expect(invoke(router, 'post', '/conversations/:id/generation/cancel', {
      params: { id: conversationId }, body: { requestId: 'request-1234', extra: true },
    })).rejects.toMatchObject({ statusCode: 400 });
    const result = await invoke(router, 'post', '/conversations/:id/generation/cancel', {
      params: { id: conversationId }, body: { requestId: 'request-1234' },
    });
    expect(result.status).toBe(200);
    expect(cancel).toHaveBeenCalledWith(ownerId, conversationId, 'request-1234');
  });
});
