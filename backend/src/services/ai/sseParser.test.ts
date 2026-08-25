import { SseParser } from './sseParser';

describe('SseParser', () => {
  it('buffers fragmented CRLF and multi-line SSE frames', () => {
    const parser = new SseParser();
    expect(parser.push('event: message\r\ndata: {"value":')).toEqual([]);
    expect(parser.push('1}\r\n\r\ndata: first\ndata: second\n')).toEqual([
      { event: 'message', data: '{"value":1}' },
    ]);
    expect(parser.push('\n')).toEqual([{ event: undefined, data: 'first\nsecond' }]);
  });

  it('parses a final frame without a blank terminator and ignores comments', () => {
    const parser = new SseParser();
    parser.push(': keepalive\ndata: [DONE]');
    expect(parser.finish()).toEqual([{ event: undefined, data: '[DONE]' }]);
  });
});
