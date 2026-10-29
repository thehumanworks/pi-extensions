import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

/** Best-effort Unix descendant cleanup, not a sandbox against deliberate process escape. */
export class WorkerProcessTree {
  private readonly known = new Map<number, string>();
  constructor(private readonly pid: number) {}
  private stat(pid: number): { parent: number; group: number; start: string } | undefined {
    try {
      const value = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
      return { parent: Number(fields[1]), group: Number(fields[2]), start: fields[19] };
    } catch { return undefined; }
  }
  signal(signal: NodeJS.Signals): boolean {
    if (!Number.isSafeInteger(this.pid) || this.pid < 2) return false;
    // Capture descendants before terminating the leader, including tools that start their own group.
    // Start-time checks prevent a late SIGKILL from targeting a reused descendant PID.
    if (process.platform === "linux") {
      const all = new Map<number, ReturnType<WorkerProcessTree["stat"]>>();
      try { for (const name of readdirSync("/proc")) if (/^\d+$/.test(name)) { const pid = Number(name); all.set(pid, this.stat(pid)); } } catch { /* group fallback */ }
      const selected = new Set([this.pid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, stat] of all) if (stat && !selected.has(pid) && (selected.has(stat.parent) || stat.group === this.pid)) {
          selected.add(pid); this.known.set(pid, stat.start); changed = true;
        }
      }
    }
    let sent = false;
    for (const [pid, start] of [...this.known].reverse()) {
      if (this.stat(pid)?.start !== start) { this.known.delete(pid); continue; }
      try { process.kill(pid, signal); sent = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    try {
      if (process.platform === "win32") {
        const result = spawnSync("taskkill", ["/pid", String(this.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { stdio: "ignore", timeout: 500 });
        return sent || result.status === 0;
      }
      process.kill(-this.pid, signal); return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return sent;
      throw error;
    }
  }
}
