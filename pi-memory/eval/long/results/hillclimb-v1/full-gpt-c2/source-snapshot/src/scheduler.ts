import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** An idle-only model task, independent of capture, compaction and shutdown. */
export class IdleScheduler<T> {
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private running?: Promise<void>;
  private generation = 0;
  private disposed = false;
  private scheduling = false;
  constructor(private options: {
    statePath: string;
    idleDelayMs: number;
    backoffMs: number;
    canRun: (context: T) => boolean;
    run: (context: T, signal: AbortSignal) => Promise<unknown>;
    onError: (error: unknown) => void;
    now?: () => number;
  }) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private async nextEligible(): Promise<number> {
    try {
      const value = JSON.parse(await readFile(this.options.statePath, "utf8"));
      if (!Number.isFinite(value.nextEligibleAt)) throw new Error("Invalid background-memory scheduler state");
      return value.nextEligibleAt;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  }
  private async checkpoint(): Promise<void> {
    await mkdir(dirname(this.options.statePath), { recursive: true, mode: 0o700 });
    const nextEligibleAt = Math.max(await this.nextEligible(), this.now() + this.options.backoffMs);
    const tmp = `${this.options.statePath}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify({ nextEligibleAt }), { mode: 0o600 });
    await rename(tmp, this.options.statePath);
  }
  async schedule(context: T): Promise<boolean> {
    if (this.disposed || this.scheduling || this.timer || this.running || !this.options.canRun(context)) return false;
    this.scheduling = true;
    const generation = this.generation;
    try {
      const earliest = await this.nextEligible();
      if (this.disposed || generation !== this.generation || this.timer || this.running) return false;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.disposed || this.running || generation !== this.generation || !this.options.canRun(context)) return;
        const controller = new AbortController(); this.controller = controller;
        this.running = (async () => {
          // Backoff is durable BEFORE inference, including after crashes or cancellation.
          await this.checkpoint();
          controller.signal.throwIfAborted();
          await this.options.run(context, controller.signal);
        })().catch(error => { if (!controller.signal.aborted) this.options.onError(error); })
          .finally(() => { this.running = undefined; this.controller = undefined; });
      }, Math.max(this.options.idleDelayMs, earliest - this.now()));
      this.timer.unref();
      return true;
    } finally { this.scheduling = false; }
  }
  async cancel(): Promise<void> {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.running;
  }
  async dispose(): Promise<void> { this.disposed = true; await this.cancel(); }
}
