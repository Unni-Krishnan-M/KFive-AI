export class SseDataParser {
  private buffer = '';
  private event: string | undefined;
  private id: string | undefined;
  private data: string[] = [];

  private readonly encoder = new TextEncoder();

  constructor(
    private readonly onData: (data: string, event?: string, id?: string) => void,
    private readonly maximumEventBytes = 512 * 1024
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    this.assertBounded(this.buffer);
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.processLine(line);
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  finish(): void {
    if (this.buffer) this.processLine(this.buffer.replace(/\r$/, ''));
    this.buffer = '';
    this.dispatch();
  }

  private processLine(line: string): void {
    if (!line) {
      this.dispatch();
    } else if (line.startsWith('event:')) {
      this.event = line.slice(6).trimStart();
    } else if (line.startsWith('id:')) {
      this.id = line.slice(3).trimStart();
    } else if (line.startsWith('data:')) {
      this.data.push(line.slice(5).trimStart());
      this.assertBounded(this.data.join('\n'));
    }
  }

  private dispatch(): void {
    if (this.data.length) this.onData(this.data.join('\n'), this.event, this.id);
    this.data = [];
    this.event = undefined;
    this.id = undefined;
  }

  private assertBounded(value: string): void {
    if (this.encoder.encode(value).byteLength > this.maximumEventBytes) {
      throw new Error(`SSE event exceeds the ${this.maximumEventBytes}-byte limit.`);
    }
  }
}

export async function readSseResponse(
  response: Response,
  onData: (data: string, event?: string, id?: string) => void,
  maximumEventBytes = 512 * 1024
): Promise<void> {
  if (!response.body) throw new Error('Streaming response body is unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseDataParser(onData, maximumEventBytes);

  try {
    let streamComplete = false;
    while (!streamComplete) {
      const { done, value } = await reader.read();
      streamComplete = done;
      if (done) continue;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.finish();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
