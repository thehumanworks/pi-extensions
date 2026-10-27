export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly reservations = new Set<string>();
  readonly limit: number;
  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Concurrency must be a positive integer.");
    this.limit = limit;
  }

  reserve(identity: string): void {
    if (this.reservations.has(identity)) return;
    this.reservations.add(identity); this.active++;
  }
  releaseReservation(identity: string): void {
    if (this.reservations.delete(identity)) this.release();
  }
  async acquire(signal: AbortSignal, identity?: string): Promise<() => void> {
    signal.throwIfAborted();
    if (identity && this.reservations.delete(identity)) return this.releaseOnce();
    if (this.active < this.limit) {
      this.active++;
      return this.releaseOnce();
    }
    await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener("abort", abort); resolve(); };
      const abort = () => {
        const index = this.waiting.indexOf(ready);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push(ready);
    });
    if (signal.aborted) { this.release(); signal.throwIfAborted(); }
    return this.releaseOnce();
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => { if (!released) { released = true; this.release(); } };
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}
