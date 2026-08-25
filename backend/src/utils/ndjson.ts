export class NdjsonParser<T> {
  private buffer = '';

  push(chunk: Buffer | string): T[] {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return this.parseLines(lines);
  }

  finish(): T[] {
    const remainder = this.buffer;
    this.buffer = '';
    return this.parseLines([remainder]);
  }

  private parseLines(lines: string[]): T[] {
    return lines
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  }
}
