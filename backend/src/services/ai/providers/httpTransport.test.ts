import { createServer } from 'http';
import { AddressInfo } from 'net';
import axios from 'axios';
import { OpenAiCompatibleProvider } from './openAiCompatibleProvider';
import { AiStreamEvent } from '../types';

describe('provider real HTTP transport', () => {
  it('preserves authorization and SSE completion, and aborts an active stream', async () => {
    const requests: Array<{ url?: string; authorization?: string; body: string }> = [];
    let holdOpen = false;
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        requests.push({ url: request.url, authorization: request.headers.authorization, body });
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
        if (!holdOpen) response.end('data: [DONE]\n\n');
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      // Real HTTP adapter, with ambient proxies disabled for this loopback fixture.
      const client = axios.create({ baseURL: baseUrl, proxy: false, timeout: 2000,
        headers: { Authorization: 'Bearer synthetic-test-key' } });
      const provider = new OpenAiCompatibleProvider({ id: 'openai-compatible', baseUrl,
        defaultModel: 'fixture', maxOutputTokens: 32, timeoutMs: 2000,
        supportsEmbeddings: false, supportsStructuredOutput: false }, client);
      const events: AiStreamEvent[] = [];
      await provider.chatStream({ messages: [{ role: 'user', content: 'test' }] }, event => events.push(event));
      expect(events.map(event => event.type)).toEqual(['start', 'delta', 'done']);
      expect(events[1]).toMatchObject({ content: 'hello' });
      holdOpen = true;
      const controller = new AbortController();
      await expect(provider.chatStream({ messages: [{ role: 'user', content: 'cancel' }] }, event => {
        if (event.type === 'delta') controller.abort();
      }, { signal: controller.signal })).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.url).toBe('/v1/chat/completions');
        expect(request.authorization).toBe('Bearer synthetic-test-key');
        expect(JSON.parse(request.body)).toMatchObject({ model: 'fixture', stream: true });
      }
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
