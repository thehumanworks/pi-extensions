import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Cron } from "croner";
import { checkName } from "./definitions.ts";
import { atomicWrite, readOptional, withLock } from "./storage.ts";

export type Schedule = { everyMs: number; cron?: never; timezone?: never } | { cron: string; timezone?: string; everyMs?: never };
export interface Loop {
  agent: string;
  name: string;
  task: string;
  schedule: Schedule;
  enabled: boolean;
  nextAt: number;
  revision: string;
  last?: { at: number; status: "started" | "completed" | "failed" | "busy"; error?: string; sessionFile?: string };
}
export function nextTime(schedule: Schedule, after: number): number {
  if (schedule.everyMs !== undefined) {
    if (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < 1000) throw new Error("everyMs must be an integer of at least 1000 milliseconds.");
    return after + schedule.everyMs;
  }
  if (!schedule.cron || ![5, 6].includes(schedule.cron.trim().split(/\s+/).length)) throw new Error("cron must have five or six fields.");
  const cron = new Cron(schedule.cron, { timezone: schedule.timezone ?? "UTC", paused: true });
  try {
    const next = cron.nextRun(new Date(after));
    if (!next) throw new Error("Schedule has no future occurrence.");
    return next.getTime();
  } finally { cron.stop(); }
}

export class LoopStore {
  readonly path: string;
  constructor(readonly root: string) { this.path = join(root, ".loops.json"); }
  async list(): Promise<Loop[]> { return JSON.parse(await readOptional(this.path) ?? "[]") as Loop[]; }
  private async change<T>(fn: (loops: Loop[]) => T): Promise<T> {
    return withLock(this.root, "loops", async () => {
      const loops = await this.list();
      const result = fn(loops);
      await atomicWrite(this.path, JSON.stringify(loops, null, 2));
      return result;
    }, 50);
  }
  async put(agent: string, name: string, task: string, schedule: Schedule, now = Date.now()): Promise<Loop> {
    checkName(agent); checkName(name);
    if (!task.trim()) throw new Error("A loop needs a nonempty task.");
    const loop: Loop = { agent, name, task, schedule, enabled: true, nextAt: nextTime(schedule, now), revision: randomUUID() };
    return this.change(loops => {
      const index = loops.findIndex(l => l.agent === agent && l.name === name);
      if (index === -1) loops.push(loop); else loops[index] = loop;
      return loop;
    });
  }
  async setEnabled(agent: string, name: string, enabled: boolean, now = Date.now()): Promise<void> {
    await this.change(loops => {
      const loop = loops.find(l => l.agent === agent && l.name === name);
      if (!loop) throw new Error("Unknown loop.");
      loop.enabled = enabled;
      loop.revision = randomUUID();
      if (enabled) loop.nextAt = nextTime(loop.schedule, now);
    });
  }
  async remove(agent: string, name?: string): Promise<void> {
    await this.change(loops => {
      for (let i = loops.length - 1; i >= 0; i--) if (loops[i].agent === agent && (name === undefined || loops[i].name === name)) loops.splice(i, 1);
    });
  }
  /** Commit the next deadline BEFORE dispatch. Missed ticks coalesce; uncertain executions never replay. */
  async claim(now: number, busyAgents: string[] = []): Promise<Loop[]> {
    return this.change(loops => {
      const selected = new Set(busyAgents);
      // Oldest first prevents a frequent loop from starving another loop on the same agent.
      const due = loops.filter(l => l.enabled && l.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt).filter(l => {
        if (selected.has(l.agent)) return false;
        selected.add(l.agent);
        return true;
      });
      for (const loop of due) {
        loop.last = { at: now, status: "started" };
        loop.nextAt = nextTime(loop.schedule, now);
        loop.revision = randomUUID();
      }
      return structuredClone(due);
    });
  }
  async deferBusy(claim: Loop, now: number): Promise<void> {
    await this.change(loops => {
      const loop = loops.find(l => l.agent === claim.agent && l.name === claim.name && l.revision === claim.revision);
      if (loop) {
        loop.nextAt = now + 1000;
        loop.last = { at: now, status: "busy", error: "Agent was busy before execution; deferred." };
      }
    });
  }
  async finish(claim: Loop, result: { sessionFile?: string; error?: string }): Promise<void> {
    await this.change(loops => {
      const loop = loops.find(l => l.agent === claim.agent && l.name === claim.name && l.revision === claim.revision);
      if (loop) loop.last = { at: claim.last!.at, status: result.error ? "failed" : "completed", ...result };
    });
  }
}

type RunLoop = (loop: Loop, signal: AbortSignal) => Promise<{ sessionFile?: string }>;
export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private controller = new AbortController();
  private scanning?: Promise<void>;
  private running = new Map<string, Promise<void>>();
  constructor(readonly store: LoopStore, private run: RunLoop, private report: (message: string) => void = () => {}) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    this.timer.unref();
  }
  tick(now = Date.now()): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    if (this.scanning) return this.scanning;
    this.scanning = this.dispatch(now).catch(e => this.report(`Loop scheduler: ${String(e)}`)).finally(() => { this.scanning = undefined; });
    return this.scanning;
  }
  private async dispatch(now: number): Promise<void> {
    // A long-running agent does not block deadlines belonging to other agents.
    if (!(await this.store.list()).some(l => l.enabled && l.nextAt <= now && !this.running.has(l.agent))) return;
    const due = await this.store.claim(now, [...this.running.keys()]);
    for (const loop of due) {
      const work = this.execute(loop).catch(e => this.report(`Loop ${loop.agent}/${loop.name}: ${String(e)}`)).finally(() => { this.running.delete(loop.agent); });
      this.running.set(loop.agent, work);
    }
  }
  private async execute(loop: Loop): Promise<void> {
    let result: { sessionFile?: string; error?: string };
    try {
      this.controller.signal.throwIfAborted();
      result = await this.run(loop, this.controller.signal);
    } catch (e) {
      // ELOCKED is an admission failure, not an uncertain in-flight execution. It is
      // safe to defer it, unlike provider/tool failures after a run was admitted.
      if ((e as NodeJS.ErrnoException).code === "ELOCKED") {
        await this.store.deferBusy(loop, Date.now());
        return;
      }
      result = { error: String(e) };
    }
    await this.store.finish(loop, result);
    this.report(`Loop ${loop.agent}/${loop.name}: ${result.error ?? "completed"}`);
  }
  async waitForIdle(): Promise<void> {
    await this.scanning;
    await Promise.allSettled([...this.running.values()]);
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller.abort(new Error("Scheduler stopped"));
    await this.waitForIdle();
  }
}
