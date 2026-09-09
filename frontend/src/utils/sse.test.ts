import { describe, expect, it } from 'vitest';
import { SseDataParser } from './sse';

describe('SseDataParser', () => {
  it('preserves events split across transport chunks', () => {
    const events: string[] = [];
    const parser = new SseDataParser((data) => events.push(data));

    parser.push('data: {"content":"hel');
    parser.push('lo"}\n\ndata: [DO');
    parser.push('NE]\n\n');
    parser.finish();

    expect(events).toEqual(['{"content":"hello"}', '[DONE]']);
  });

  it('ignores comments and non-data fields', () => {
    const events: string[] = [];
    const parser = new SseDataParser((data) => events.push(data));
    parser.push(': keepalive\nevent: message\ndata: payload\n');
    parser.finish();
    expect(events).toEqual(['payload']);
  });

  it('reports named events and joins multiline data', () => {
    const events: Array<{ name?: string; id?: string; data: string }> = [];
    const parser = new SseDataParser((data, name, id) => events.push({ name, id, data }));
    parser.push('event: delta\nid: 3\ndata: first\ndata: second\n\nevent: completed\nid: 4\ndata: {}\n\n');
    expect(events).toEqual([
      { name: 'delta', id: '3', data: 'first\nsecond' },
      { name: 'completed', id: '4', data: '{}' },
    ]);
  });

  it('rejects an event whose buffered bytes exceed the configured limit', () => {
    const parser = new SseDataParser(() => undefined, 8);
    expect(() => parser.push('data: 123456789')).toThrow('SSE event exceeds the 8-byte limit.');
  });
});
