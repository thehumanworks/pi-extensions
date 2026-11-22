import { Board, type Job, type Outcome } from "./board.ts";

export class Scheduler {
  private active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private closed = false;
  private retry?: NodeJS.Timeout;
  private scheduled?: NodeJS.Immediate;
  constructor(
    readonly board: Board,
    private run: (j: Job, s: AbortSignal) => Promise<Outcome>,
    private changed: () => void,
    private error: (e: unknown) => void,
    private retryDelayMs = 1000,
  ) {}
  wake() {
    if (this.closed || this.scheduled) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      try {
        while (this.active.size < this.board.limits().concurrency) {
          const j = this.board.claim();
          if (!j) break;
          const abort = new AbortController();
          const promise = Promise.resolve()
            .then(() => this.execute(j, abort.signal))
            .catch((e) => {
              this.error(e);
            });
          this.active.set(j.id, { abort, promise });
        }
        clearTimeout(this.retry);
        if (this.active.size < this.board.limits().concurrency) {
          const at = this.board.nextRetry();
          if (at !== undefined) this.retry = setTimeout(() => this.wake(), Math.max(1, at - Date.now()));
        }
        this.changed();
      } catch (e) {
        this.error(e);
      }
    });
  }
  private async execute(j: Job, signal: AbortSignal) {
    try {
      const outcome = await this.run(j, signal);
      signal.throwIfAborted();
      this.board.finish(j.id, outcome);
    } catch (e) {
      if (signal.aborted) this.board.pause(j.id);
      else this.board.fail(j.id, e instanceof Error ? e.message : String(e), this.retryDelayMs);
    } finally {
      this.active.delete(j.id);
      this.wake();
    }
  }
  async close() {
    this.closed = true;
    clearTimeout(this.retry);
    if (this.scheduled) clearImmediate(this.scheduled);
    const running = [...this.active.values()];
    for (const r of running) r.abort.abort();
    await Promise.all(running.map((r) => r.promise));
    this.board.close();
  }
}
