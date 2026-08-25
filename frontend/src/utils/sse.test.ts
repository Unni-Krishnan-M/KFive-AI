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
    const events: Array<{ name?: string; data: string }> = [];
    const parser = new SseDataParser((data, name) => events.push({ name, data }));
    parser.push('event: delta\ndata: first\ndata: second\n\nevent: completed\ndata: {}\n\n');
    expect(events).toEqual([
      { name: 'delta', data: 'first\nsecond' },
      { name: 'completed', data: '{}' },
    ]);
  });
});
