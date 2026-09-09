import { AiProviderClient, AiStreamEvent } from '@/services/ai/types';
import { AiProviderUnavailableError } from '@/services/ai/errors';
import {
  buildProviderMessages,
  CHAT_LIMITS,
  ChatConversationRecord,
  ChatRepository,
  ChatService,
  ChatTerminalData,
  validateChatStreamInput,
} from './chatService';

const ownerId = '64b000000000000000000001';
const conversationId = '64b000000000000000000101';

function repository(seed?: Partial<ChatConversationRecord>): ChatRepository & { record: ChatConversationRecord } {
  const record: ChatConversationRecord = {
    _id: conversationId,
    userId: ownerId,
    messages: [],
    settings: { model: 'phi3', temperature: 0.4 },
    metadata: { messageCount: 0, totalTokens: 0, lastMessageAt: new Date(0) },
    ...seed,
  };
  return {
    record,
    async findByOwnerAndId(requestOwner, requestConversation) {
      return requestOwner === ownerId && requestConversation === conversationId ? record : null;
    },
    async begin(requestOwner, requestConversation, message, generation) {
      if (requestOwner !== ownerId || requestConversation !== conversationId
        || record.generation?.status === 'running'
        || (record.metadata?.messageCount ?? record.messages.length) >= CHAT_LIMITS.messageRetention - 1) return null;
      record.messages.push(message);
      record.generation = generation;
      record.metadata = {
        ...record.metadata,
        messageCount: (record.metadata?.messageCount ?? 0) + 1,
        lastMessageAt: message.timestamp,
      };
      return record;
    },
    async markStarted(requestOwner, requestConversation, requestId, provider, model, timeToFirstTokenMs) {
      if (requestOwner !== ownerId || requestConversation !== conversationId
        || record.generation?.requestId !== requestId || record.generation.status !== 'running') return false;
      Object.assign(record.generation, {
        provider,
        model,
        ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
      });
      return true;
    },
    async finish(requestOwner, requestConversation, requestId, terminal: ChatTerminalData) {
      if (requestOwner !== ownerId || requestConversation !== conversationId
        || record.generation?.requestId !== requestId || record.generation.status !== 'running') return null;
      record.messages.push({
        role: 'assistant', content: terminal.content, timestamp: terminal.completedAt,
        requestId, status: terminal.status, provider: terminal.provider, model: terminal.model,
        ...(terminal.usage ? { usage: terminal.usage } : {}),
        ...(terminal.error ? { error: terminal.error } : {}),
        durationMs: terminal.durationMs,
        ...(terminal.timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs: terminal.timeToFirstTokenMs } : {}),
      });
      Object.assign(record.generation, terminal);
      record.metadata = {
        ...record.metadata,
        messageCount: (record.metadata?.messageCount ?? 0) + 1,
        totalTokens: (record.metadata?.totalTokens ?? 0) + (terminal.usage?.totalTokens ?? 0),
        lastMessageAt: terminal.completedAt,
      };
      return record;
    },
    async interruptActive(before, completedAt) {
      if (record.generation?.status !== 'running') return 0;
      const deadline = record.generation.deadlineAt;
      if ((deadline && deadline >= completedAt) || (!deadline && record.generation.startedAt >= before)) return 0;
      Object.assign(record.generation, {
        status: 'interrupted', completedAt,
        error: { code: 'CHAT_INTERRUPTED', message: 'The chat generation was interrupted before completion.' },
      });
      return 1;
    },
  };
}

function projects() {
  return { resolveActiveProject: jest.fn(async () => undefined) };
}

function provider(run: (emit: (event: AiStreamEvent) => void, signal?: AbortSignal) => Promise<void>): AiProviderClient {
  return {
    id: 'test',
    capabilities: { chat: true, streaming: true, embeddings: false, structuredOutput: false, modelListing: false },
    healthCheck: jest.fn(), connectionTest: jest.fn(), listModels: jest.fn(), chat: jest.fn(), embed: jest.fn(),
    chatStream: jest.fn(async (_request, emit, options) => run(emit, options?.signal)),
  };
}

describe('chat input validation', () => {
  it('normalizes a safe prompt and optional model', () => {
    expect(validateChatStreamInput({ message: '  hello\nworld  ', model: ' phi3 ' }))
      .toEqual({ message: 'hello\nworld', model: 'phi3' });
  });

  it.each([
    null,
    [],
    { message: 'ok', projectId: conversationId },
    { message: '' },
    { message: '\u202esecret' },
    { message: 'ok', model: '\u0000bad' },
  ])('rejects invalid or ambiguous input %#', (value) => {
    expect(() => validateChatStreamInput(value)).toThrow(expect.objectContaining({ code: 'INVALID_CHAT_INPUT' }));
  });

  it('enforces the UTF-8 byte boundary', () => {
    expect(() => validateChatStreamInput({ message: 'a'.repeat(CHAT_LIMITS.promptCharacters) })).not.toThrow();
    expect(() => validateChatStreamInput({ message: 'a'.repeat(CHAT_LIMITS.promptCharacters + 1) }))
      .toThrow(expect.objectContaining({ code: 'INVALID_CHAT_INPUT' }));
    expect(() => validateChatStreamInput({ message: '🙂'.repeat(CHAT_LIMITS.promptCharacters) })).not.toThrow();
    expect(() => validateChatStreamInput({ message: '界'.repeat(CHAT_LIMITS.promptCharacters) + '🙂'.repeat(1_100) }))
      .toThrow(expect.objectContaining({ code: 'INVALID_CHAT_INPUT' }));
  });
});

describe('provider context construction', () => {
  it('keeps the newest complete messages inside the byte limit and preserves order', () => {
    const large = 'a'.repeat(600 * 1024);
    expect(buildProviderMessages([
      { role: 'user', content: large },
      { role: 'assistant', content: large },
      { role: 'user', content: 'latest' },
    ])).toEqual([
      { role: 'assistant', content: large },
      { role: 'user', content: 'latest' },
    ]);
  });
});

describe('ChatService generation lifecycle', () => {
  const start = new Date('2026-09-02T00:00:00.000Z');
  let tick = 0;
  const now = () => new Date(start.getTime() + (tick += 10));

  beforeEach(() => { tick = 0; });

  it('persists the user turn before invoking the provider, then stores actual runtime metadata', async () => {
    const repo = repository();
    const observedMessageCounts: number[] = [];
    const client = provider(async (emit) => {
      observedMessageCounts.push(repo.record.messages.length);
      emit({ type: 'start', provider: 'remote-ollama', model: 'phi3' });
      emit({ type: 'delta', provider: 'remote-ollama', model: 'phi3', content: 'forty two' });
      emit({ type: 'usage', provider: 'remote-ollama', model: 'phi3', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
      emit({ type: 'done', provider: 'remote-ollama', model: 'phi3', finishReason: 'stop', usage: { totalTokens: 5 } });
    });
    const service = new ChatService(repo, projects(), () => client, 30_000, now, () => 'request-1234');
    const prepared = await service.prepare(ownerId, conversationId, { message: 'What is six times seven?' });
    expect(repo.record.messages).toHaveLength(1);
    expect(repo.record.generation).toMatchObject({ requestId: 'request-1234', status: 'running' });
    const events: unknown[] = [];
    await expect(service.execute(prepared, (event) => events.push(event))).resolves.toMatchObject({
      status: 'succeeded', provider: 'remote-ollama', model: 'phi3', outputBytes: 9,
    });
    expect(observedMessageCounts).toEqual([1]);
    expect(repo.record.messages[1]).toMatchObject({
      role: 'assistant', content: 'forty two', status: 'succeeded', provider: 'remote-ollama', model: 'phi3',
    });
    expect(repo.record.metadata).toMatchObject({ messageCount: 2, totalTokens: 5 });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'generation', requestId: 'request-1234' }),
      expect.objectContaining({ type: 'completed', requestId: 'request-1234' }),
    ]));
  });

  it('stores a fixed safe provider-unavailable error without leaking the cause', async () => {
    const repo = repository();
    const client = provider(async () => {
      throw new AiProviderUnavailableError('custom', new Error('secret-key=do-not-leak'));
    });
    const service = new ChatService(repo, projects(), () => client, 30_000, now, () => 'request-2345');
    const prepared = await service.prepare(ownerId, conversationId, { message: 'hello' });
    await expect(service.execute(prepared, jest.fn())).resolves.toMatchObject({
      status: 'failed', error: { code: 'CHAT_PROVIDER_UNAVAILABLE', message: 'The configured AI provider is unavailable.' },
    });
    expect(JSON.stringify(repo.record)).not.toContain('do-not-leak');
  });

  it('fails closed when a provider resolves without a done event', async () => {
    const repo = repository();
    const client = provider(async (emit) => {
      emit({ type: 'start', provider: 'test', model: 'model' });
      emit({ type: 'delta', provider: 'test', model: 'model', content: 'partial' });
    });
    const service = new ChatService(repo, projects(), () => client, 30_000, now, () => 'request-3456');
    const prepared = await service.prepare(ownerId, conversationId, { message: 'hello' });
    await expect(service.execute(prepared, jest.fn())).resolves.toMatchObject({
      status: 'failed', error: { code: 'CHAT_GENERATION_FAILED' }, outputBytes: 7,
    });
    expect(repo.record.messages[1]).toMatchObject({ content: 'partial', status: 'failed' });
  });

  it('terminalizes promptly when Stop targets a provider that ignores AbortSignal', async () => {
    const repo = repository();
    const client = provider(async () => new Promise<void>(() => undefined));
    const service = new ChatService(repo, projects(), () => client, 30_000, now, () => 'request-4567');
    const prepared = await service.prepare(ownerId, conversationId, { message: 'hello' });
    const executed = service.execute(prepared, (event) => {
      if (event.type === 'generation') service.cancel(ownerId, conversationId, event.requestId);
    });
    await expect(executed).resolves.toMatchObject({
      status: 'cancelled', error: { code: 'CHAT_CANCELLED', message: 'Generation was stopped.' },
    });
  });

  it('caps output on a Unicode boundary and records output_limit', async () => {
    const repo = repository();
    const client = provider(async (emit) => {
      emit({ type: 'start', provider: 'test', model: 'model' });
      emit({
        type: 'delta', provider: 'test', model: 'model',
        content: `${'a'.repeat(CHAT_LIMITS.outputBytes - 1)}🙂`,
      });
      await new Promise<void>(() => undefined);
    });
    const service = new ChatService(repo, projects(), () => client, 30_000, now, () => 'request-5678');
    const prepared = await service.prepare(ownerId, conversationId, { message: 'hello' });
    await expect(service.execute(prepared, jest.fn())).resolves.toMatchObject({
      status: 'output_limit', outputBytes: CHAT_LIMITS.outputBytes - 1,
      error: { code: 'CHAT_OUTPUT_LIMIT' },
    });
    expect(repo.record.messages[1].content.endsWith('�')).toBe(false);
  });

  it('rejects a second begin while a durable generation is running', async () => {
    const repo = repository();
    const service = new ChatService(repo, projects(), () => provider(async () => undefined), 30_000, now, () => 'request-6789');
    await service.prepare(ownerId, conversationId, { message: 'first' });
    await expect(service.prepare(ownerId, conversationId, { message: 'second' }))
      .rejects.toMatchObject({ code: 'CHAT_BUSY', statusCode: 409 });
  });

  it('reserves space for both sides of the final retained turn', async () => {
    const messages = Array.from({ length: CHAT_LIMITS.messageRetention - 1 }, (_, index) => ({
      role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `message ${index}`,
      timestamp: start,
    }));
    const repo = repository({ messages, metadata: { messageCount: messages.length, totalTokens: 0 } });
    const service = new ChatService(repo, projects(), () => provider(async () => undefined));
    await expect(service.prepare(ownerId, conversationId, { message: 'one more' }))
      .rejects.toMatchObject({ code: 'CHAT_LIMIT_REACHED', statusCode: 409 });
  });

  it('recovers generations whose persisted deadline elapsed', async () => {
    const repo = repository({
      generation: {
        requestId: 'request-old', status: 'running', userMessageId: '64b000000000000000000201',
        outputBytes: 0, startedAt: new Date(start.getTime() - 300_000), deadlineAt: new Date(start.getTime() - 1),
      },
    });
    const service = new ChatService(repo, projects(), () => provider(async () => undefined), 30_000, () => start);
    await expect(service.recoverInterrupted()).resolves.toBe(1);
    expect(repo.record.generation).toMatchObject({ status: 'interrupted', error: { code: 'CHAT_INTERRUPTED' } });
  });
});
