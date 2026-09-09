import { describe, expect, it } from 'vitest';
import {
  CHAT_OUTPUT_BYTE_LIMIT,
  ChatStreamProtocol,
  normalizeChatConversation,
  validateChatPrompt,
} from './chatModel';

const requestId = 'request-1234';

function event(protocol: ChatStreamProtocol, name: string, value: Record<string, unknown>) {
  return protocol.consume(JSON.stringify({ requestId, ...value }), name, requestId);
}

describe('chat DTO normalization', () => {
  it('normalizes persisted terminal messages and generation metrics', () => {
    expect(normalizeChatConversation({
      _id: '64b000000000000000000101', title: 'Test', projectId: '64b000000000000000000201',
      updatedAt: '2026-09-02T00:00:00.000Z',
      messages: [{
        _id: '64b000000000000000000301', role: 'assistant', content: 'answer', requestId,
        status: 'succeeded', provider: 'ollama', model: 'phi3', durationMs: 120,
        timeToFirstTokenMs: 20, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      }],
      generation: {
        requestId, status: 'succeeded', userMessageId: '64b000000000000000000401',
        outputBytes: 6, provider: 'ollama', model: 'phi3', durationMs: 120,
        timeToFirstTokenMs: 20, usage: { totalTokens: 5 },
      },
    })).toMatchObject({
      title: 'Test',
      messages: [{ status: 'succeeded', provider: 'ollama', model: 'phi3', usage: { totalTokens: 5 } }],
      generation: { status: 'succeeded', outputBytes: 6, timeToFirstTokenMs: 20 },
    });
  });

  it.each([
    null,
    {},
    { _id: 'id', title: 'Test', messages: 'not-an-array' },
    { _id: 'id', title: 'Test', messages: [{ role: 'tool', content: 'bad' }] },
    { _id: 'id', title: 'Test', messages: [], generation: { requestId, status: 'unknown', outputBytes: 0 } },
  ])('rejects malformed conversation data %#', (value) => {
    expect(() => normalizeChatConversation(value)).toThrow();
  });
});

describe('chat prompt validation', () => {
  it('trims and accepts safe multiline Unicode input', () => {
    expect(validateChatPrompt('  hello 🙂\nworld  ')).toMatchObject({ value: 'hello 🙂\nworld' });
  });

  it('rejects empty, unsafe, and over-limit input', () => {
    expect(validateChatPrompt('   ').error).toBe('Enter a message.');
    expect(validateChatPrompt('hello\u202eworld').error).toContain('control');
    expect(validateChatPrompt('a'.repeat(4_001)).error).toContain('4,000');
  });
});

describe('ChatStreamProtocol', () => {
  it('accepts the complete named-event lifecycle', () => {
    const protocol = new ChatStreamProtocol();
    expect(event(protocol, 'generation', { status: 'running' })).toEqual({ type: 'generation', requestId });
    expect(event(protocol, 'start', { provider: 'ollama', model: 'phi3' })).toMatchObject({ type: 'start' });
    expect(event(protocol, 'delta', { content: 'hello' })).toEqual({ type: 'delta', requestId, content: 'hello' });
    expect(event(protocol, 'usage', { usage: { totalTokens: 4 } })).toMatchObject({ type: 'usage' });
    expect(event(protocol, 'completed', {
      generation: { requestId, status: 'succeeded', outputBytes: 5, provider: 'ollama', model: 'phi3' },
    })).toMatchObject({ type: 'completed', generation: { status: 'succeeded' } });
    expect(protocol.consume('[DONE]')).toEqual({ type: 'done', requestId });
    expect(() => protocol.finish()).not.toThrow();
  });

  it('accepts a fixed terminal error followed by DONE', () => {
    const protocol = new ChatStreamProtocol();
    event(protocol, 'generation', { status: 'running' });
    expect(event(protocol, 'error', { code: 'CHAT_STORAGE_UNAVAILABLE', message: 'Chat storage is unavailable.' }))
      .toMatchObject({ type: 'error', error: { code: 'CHAT_STORAGE_UNAVAILABLE' } });
    protocol.consume('[DONE]');
    expect(() => protocol.finish()).not.toThrow();
  });

  it('rejects malformed, reordered, identity-changing, duplicate, and incomplete streams', () => {
    expect(() => new ChatStreamProtocol().consume('{bad', 'generation', requestId)).toThrow('invalid JSON');
    expect(() => event(new ChatStreamProtocol(), 'delta', { content: 'early' })).toThrow('did not begin');

    const identity = new ChatStreamProtocol();
    event(identity, 'generation', { status: 'running' });
    expect(() => identity.consume(JSON.stringify({ requestId: 'other-id', provider: 'p', model: 'm' }), 'start', 'other-id'))
      .toThrow('identity changed');

    const duplicate = new ChatStreamProtocol();
    event(duplicate, 'generation', { status: 'running' });
    event(duplicate, 'error', { code: 'CHAT_GENERATION_FAILED', message: 'Failed.' });
    expect(() => event(duplicate, 'error', { code: 'CHAT_GENERATION_FAILED', message: 'Again.' })).toThrow('more than one');
    expect(() => duplicate.finish()).toThrow('before [DONE]');
  });

  it('enforces the aggregate streamed output cap', () => {
    const protocol = new ChatStreamProtocol();
    event(protocol, 'generation', { status: 'running' });
    event(protocol, 'start', { provider: 'test', model: 'model' });
    event(protocol, 'delta', { content: 'a'.repeat(CHAT_OUTPUT_BYTE_LIMIT) });
    expect(() => event(protocol, 'delta', { content: 'b' })).toThrow('output limit');
  });
});
