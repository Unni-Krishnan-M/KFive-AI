import { Readable } from 'stream';
import { AxiosInstance } from 'axios';
import { AiProviderUnsupportedError } from '../errors';
import { AiStreamEvent } from '../types';
import { OpenAiCompatibleProvider } from './openAiCompatibleProvider';

function createClient() {
  return { get: jest.fn(), post: jest.fn() };
}

function createProvider(
  client: ReturnType<typeof createClient>,
  overrides: Partial<ConstructorParameters<typeof OpenAiCompatibleProvider>[0]> = {}
): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    id: 'openai-compatible',
    baseUrl: 'http://compatible.test/v1',
    defaultModel: 'test-model',
    maxOutputTokens: 1024,
    timeoutMs: 30_000,
    supportsEmbeddings: false,
    supportsStructuredOutput: false,
    ...overrides,
  }, client as unknown as AxiosInstance);
}

describe('OpenAiCompatibleProvider', () => {
  it('normalizes model listing without inventing capabilities', async () => {
    const client = createClient();
    client.get.mockResolvedValue({ status: 200, data: { data: [
      { id: 'coder-model', created: 1_700_000_000, owned_by: 'local' },
    ] } });

    await expect(createProvider(client).listModels()).resolves.toEqual([
      expect.objectContaining({ id: 'coder-model', name: 'coder-model', provider: 'openai-compatible' }),
    ]);
  });

  it('buffers fragmented SSE and emits normalized delta, usage, and completion events', async () => {
    const client = createClient();
    client.post.mockResolvedValue({ data: Readable.from([
      'data: {"model":"test-model","choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\r\n\r\n',
      'data: {"model":"test-model","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n',
      '\ndata: {"model":"test-model","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
      'data: [DO',
      'NE]\n\n',
    ]) });
    const events: AiStreamEvent[] = [];

    await createProvider(client).chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      (event) => events.push(event)
    );

    expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'delta', 'usage', 'done']);
    expect(events[1]).toMatchObject({ content: 'Hel', provider: 'openai-compatible' });
    expect(events[4]).toMatchObject({ finishReason: 'stop', usage: { totalTokens: 3 } });
    expect(client.post).toHaveBeenCalledWith('/chat/completions', expect.objectContaining({
      model: 'test-model', stream: true, max_tokens: 1024, stream_options: { include_usage: true },
    }), expect.objectContaining({ responseType: 'stream' }));
  });

  it('does not advertise or call embeddings unless explicitly enabled', async () => {
    const client = createClient();
    await expect(createProvider(client).embed({ input: 'hello' })).rejects.toBeInstanceOf(AiProviderUnsupportedError);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('maps compatible embedding results when the capability is explicitly enabled', async () => {
    const client = createClient();
    client.post.mockResolvedValue({ data: {
      model: 'embed-model', data: [{ embedding: [0.1, 0.2] }], usage: { total_tokens: 4 },
    } });
    const provider = createProvider(client, { supportsEmbeddings: true });

    await expect(provider.embed({ model: 'embed-model', input: 'hello' })).resolves.toEqual({
      provider: 'openai-compatible',
      model: 'embed-model',
      embeddings: [[0.1, 0.2]],
      usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: 4 },
    });
  });

  it('orders multi-input embeddings by their validated response index', async () => {
    const client = createClient();
    client.post.mockResolvedValue({ data: {
      model: 'embed-model',
      data: [
        { index: 1, embedding: [0.3, 0.4] },
        { index: 0, embedding: [0.1, 0.2] },
      ],
    } });
    const provider = createProvider(client, { supportsEmbeddings: true });
    await expect(provider.embed({ model: 'embed-model', input: ['first', 'second'] })).resolves.toMatchObject({
      embeddings: [[0.1, 0.2], [0.3, 0.4]],
    });
  });

  it('rejects missing, duplicate, or incomplete multi-input embedding indexes', async () => {
    const client = createClient();
    const provider = createProvider(client, { supportsEmbeddings: true });
    client.post.mockResolvedValueOnce({ data: { data: [
      { embedding: [0.1] }, { embedding: [0.2] },
    ] } });
    await expect(provider.embed({ input: ['first', 'second'] })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    client.post.mockResolvedValueOnce({ data: { data: [
      { index: 0, embedding: [0.1] }, { index: 0, embedding: [0.2] },
    ] } });
    await expect(provider.embed({ input: ['first', 'second'] })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    client.post.mockResolvedValueOnce({ data: { data: [{ index: 0, embedding: [0.1] }] } });
    await expect(provider.embed({ input: ['first', 'second'] })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
