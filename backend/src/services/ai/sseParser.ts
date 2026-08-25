export interface ParsedSseEvent {
  event?: string;
  data: string;
}

export class SseParser {
  private buffer = '';

  push(chunk: Buffer | string): ParsedSseEvent[] {
    this.buffer = `${this.buffer}${chunk.toString()}`.replace(/\r\n/g, '\n');
    const frames = this.buffer.split('\n\n');
    this.buffer = frames.pop() ?? '';
    return frames.map((frame) => this.parseFrame(frame)).filter((event): event is ParsedSseEvent => Boolean(event));
  }

  finish(): ParsedSseEvent[] {
    const frame = this.buffer.replace(/\r\n/g, '\n');
    this.buffer = '';
    const event = this.parseFrame(frame);
    return event ? [event] : [];
  }

  private parseFrame(frame: string): ParsedSseEvent | undefined {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return data.length ? { event, data: data.join('\n') } : undefined;
  }
}
