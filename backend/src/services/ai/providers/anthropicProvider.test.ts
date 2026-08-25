import { Readable } from 'stream';
import { AxiosInstance } from 'axios';
import { AiProviderUnsupportedError } from '../errors';
import { AiStreamEvent } from '../types';
import { AnthropicProvider } from './anthropicProvider';

function createClient() { return { get: jest.fn(), post: jest.fn() }; }
function createProvider(client: ReturnType<typeof createClient>): AnthropicProvider {
  return new AnthropicProvider({
    baseUrl: 'https://anthropic.test', apiKey: 'test-key', defaultModel: 'claude-test',
    maxOutputTokens: 1024, timeoutMs: 30_000,
  }, client as unknown as AxiosInstance);
}

describe('AnthropicProvider', () => {
  it('moves system content to the top-level Anthropic field', async () => {
    const client = createClient();
    client.post.mockResolvedValue({ data: {
      model: 'claude-test', content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 },
    } });

    await expect(createProvider(client).chat({ messages: [
      { role: 'system', content: 'Be concise.' }, { role: 'user', content: 'Hi' },
    ] })).resolves.toMatchObject({ content: 'Hello', finishReason: 'stop', usage: { totalTokens: 3 } });
    expect(client.post).toHaveBeenCalledWith('/v1/messages', expect.objectContaining({
      system: 'Be concise.', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1024,
    }), { signal: undefined });
  });

  it('normalizes fragmented Anthropic streaming events and usage', async () => {
    const client = createClient();
    client.post.mockResolvedValue({ data: Readable.from([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel',
      'lo"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]) });
    const events: AiStreamEvent[] = [];

    await createProvider(client).chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      (event) => events.push(event)
    );

    expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'usage', 'done']);
    expect(events[1]).toMatchObject({ content: 'Hello', provider: 'anthropic' });
    expect(events[3]).toMatchObject({ finishReason: 'stop', usage: { totalTokens: 3 } });
  });

  it('reports embeddings unsupported without network activity', async () => {
    const client = createClient();
    await expect(createProvider(client).embed({ input: 'hello' })).rejects.toBeInstanceOf(AiProviderUnsupportedError);
    expect(client.post).not.toHaveBeenCalled();
  });
});
