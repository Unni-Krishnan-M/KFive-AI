import { NdjsonParser } from './ndjson';

describe('NdjsonParser', () => {
  it('buffers JSON split across network chunks', () => {
    const parser = new NdjsonParser<{ response: string; done: boolean }>();

    expect(parser.push('{"response":"hel')).toEqual([]);
    expect(parser.push('lo","done":false}\n{"response":"!","done":tr')).toEqual([
      { response: 'hello', done: false },
    ]);
    expect(parser.push('ue}\n')).toEqual([{ response: '!', done: true }]);
    expect(parser.finish()).toEqual([]);
  });

  it('parses a final record without a trailing newline', () => {
    const parser = new NdjsonParser<{ done: boolean }>();
    parser.push('{"done":true}');
    expect(parser.finish()).toEqual([{ done: true }]);
  });

  it('rejects malformed complete records instead of silently dropping them', () => {
    const parser = new NdjsonParser();
    expect(() => parser.push('{not-json}\n')).toThrow(SyntaxError);
  });
});
