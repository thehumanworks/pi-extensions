import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";

import type { FileEntry } from "@earendil-works/pi-coding-agent";

export type State = "queued" | "running" | "waiting" | "blocked" | "failed" | "done";
export type WorkerConfig = {
  provider: string;
  model: string;
  reasoningEffort?: ThinkingLevel;
  systemPrompt?: string;
};
export type Job = WorkerConfig & {
  id: string;
  parent: string | null;
  depth: number;
  state: State;
  task: string;
  prompt: string;
  history: AgentMessage[];
  entries?: FileEntry[];
  readyAt?: number;
  attempts: number;
  dirty: boolean;
  note: string;
  revision: number;
};
export type Outcome = {
  kind: "done" | "blocked" | "delegate";
  text: string;
  history: AgentMessage[];
  entries?: FileEntry[];
};
export type Limits = { concurrency: number; depth: number };

export function checkLimits({ concurrency, depth }: Limits) {
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32 ||
    !Number.isInteger(depth) ||
    depth < 0 ||
    depth > 8
  )
    throw new Error("Concurrency must be 1–32 and depth 0–8 (0 disables new tasks).");
}

export class Board {
  private db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, "board.sqlite"));
    try {
      // SQLite retains this OS lock across commits; process death releases it.
      this.db.exec(
        "PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS config(value TEXT NOT NULL); COMMIT;",
      );
      for (const j of this.list("running")) this.interrupt(j);
    } catch (err) {
      this.db.close();
      throw err;
    }
  }
  close() {
    this.db.close();
  }
  limits(): Limits {
    const row = this.db.prepare("SELECT value FROM config").get();
    return row ? JSON.parse(String(row.value)) : { concurrency: 3, depth: 1 };
  }
  configure(limits: Limits) {
    checkLimits(limits);
    this.db.prepare("INSERT OR REPLACE INTO config(rowid,value) VALUES(1,?)").run(JSON.stringify(limits));
  }
  list(state?: State): Job[] {
    const rows = state
      ? this.db.prepare("SELECT data FROM jobs WHERE state=? ORDER BY rowid").all(state)
      : this.db.prepare("SELECT data FROM jobs ORDER BY rowid").all();
    return rows.map((r) => JSON.parse(String(r.data)));
  }
  summaries() {
    return this.db
      .prepare(
        `SELECT id,state,json_extract(data,'$.parent') parent,
      json_extract(data,'$.revision') revision,substr(json_extract(data,'$.task'),1,180) task,
      substr(json_extract(data,'$.note'),1,1200) note FROM jobs ORDER BY rowid`,
      )
      .all() as {
      id: string;
      state: State;
      parent: string | null;
      revision: number;
      task: string;
      note: string;
    }[];
  }
  get(id: string): Job {
    const row = this.db.prepare("SELECT data FROM jobs WHERE id=?").get(id);
    if (!row) throw new Error("Unknown subagent task: " + id);
    return JSON.parse(String(row.data));
  }
  private save(j: Job) {
    j.revision++;
    this.db
      .prepare(
        "INSERT INTO jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data",
      )
      .run(j.id, j.state, JSON.stringify(j));
  }
  add(task: string, config: WorkerConfig) {
    return this.enqueue(task, config, null, 1);
  }
  private enqueue(
    task: string,
    { provider, model, reasoningEffort, systemPrompt }: WorkerConfig,
    parent: string | null,
    depth: number,
  ) {
    if (!task.trim()) throw new Error("Task cannot be empty.");
    if (depth > this.limits().depth) throw new Error("Delegation depth limit reached.");
    const j: Job = {
      id: randomUUID(),
      parent,
      depth,
      task,
      provider,
      model,
      reasoningEffort,
      systemPrompt,
      state: "queued",
      history: [],
      prompt: task,
      note: "",
      attempts: 0,
      dirty: false,
      revision: 0,
    };
    this.save(j);
    return j;
  }
  nextRetry(): number | undefined {
    const row = this.db
      .prepare("SELECT min(json_extract(data,'$.readyAt')) at FROM jobs WHERE state='queued'")
      .get();
    return typeof row?.at === "number" ? row.at : undefined;
  }
  claim() {
    const row = this.db
      .prepare(
        "SELECT data FROM jobs WHERE state='queued' AND coalesce(json_extract(data,'$.readyAt'),0)<=? ORDER BY rowid LIMIT 1",
      )
      .get(Date.now());
    if (!row) return;
    const j: Job = JSON.parse(String(row.data));
    j.state = "running";
    delete j.readyAt;
    j.attempts++;
    this.save(j);
    return j;
  }
  checkpoint(id: string, history: AgentMessage[], entries?: FileEntry[]) {
    const j = this.get(id);
    j.history = history;
    j.entries = entries;
    j.prompt = "";
    j.dirty = false;
    j.note = "";
    this.save(j);
  }
  markMutation(id: string, tool: string) {
    const j = this.get(id);
    j.dirty = true;
    j.note = tool + " may have produced external effects.";
    this.save(j);
  }
  private interrupt(j: Job, error = "Lead session interrupted") {
    j.state = j.dirty ? "blocked" : j.attempts >= 3 ? "failed" : "queued";
    j.note = error + (j.dirty ? ". " + j.note + " Verify the outcome before resuming." : "");
    this.save(j);
  }
  pause(id: string) {
    const j = this.get(id);
    j.attempts = Math.max(0, j.attempts - 1);
    this.interrupt(j, "Lead session closed");
  }
  fail(id: string, reason: string, delayMs = 1000) {
    const j = this.get(id);
    j.readyAt = Date.now() + delayMs * 2 ** Math.max(0, j.attempts - 1);
    this.interrupt(j, reason);
  }
  resume(id: string, input: string) {
    const j = this.get(id);
    if (!["blocked", "failed"].includes(j.state) || !input.trim())
      throw new Error("Supply instructions for a blocked or failed task.");
    j.prompt += "\nWorker status: " + j.note + "\nLead response: " + input;
    delete j.readyAt;
    j.attempts = 0;
    j.dirty = false;
    j.state = "queued";
    j.note = "";
    this.save(j);
  }
  finish(id: string, outcome: Outcome) {
    this.db.exec("BEGIN");
    try {
      const j = this.get(id);
      j.history = outcome.history;
      j.entries = outcome.entries;
      j.prompt = "";
      j.note = outcome.text;
      j.dirty = false;
      if (outcome.kind === "delegate" && j.depth < this.limits().depth) {
        const child = this.enqueue(outcome.text, j, j.id, j.depth + 1);
        j.state = "waiting";
        j.note = "Waiting for " + child.id;
      } else {
        j.state = outcome.kind === "done" ? "done" : "blocked";
        if (outcome.kind === "delegate") j.note = "Depth limit reached. Requested: " + outcome.text;
        if (j.parent && j.state === "done") {
          const parent = this.get(j.parent);
          parent.state = "queued";
          parent.attempts = 0;
          parent.prompt = "Child task " + j.id + " returned:\n" + outcome.text;
          this.save(parent);
        }
      }
      this.save(j);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
