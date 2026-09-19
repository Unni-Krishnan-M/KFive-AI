/** Serial sweeps revisit orphans that were too young during broker startup. */
export class ReaperLoop {
  private stopped = true;
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;

  constructor(
    private readonly sweep: () => Promise<unknown>,
    private readonly onError: (event: string) => void,
    private readonly intervalMs = 30_000
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('Invalid sweep interval.');
  }

  start(): void {
    if (!this.stopped || this.active) return;
    this.stopped = false;
    this.tick();
  }

  private tick(): void {
    this.active = Promise.resolve().then(() => this.sweep()).then(() => undefined)
      .catch(() => { this.onError('stale-container-sweep-failed'); })
      .finally(() => {
        this.active = undefined;
        if (!this.stopped) {
          this.timer = setTimeout(() => this.tick(), this.intervalMs);
          this.timer.unref();
        }
      });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }
}
