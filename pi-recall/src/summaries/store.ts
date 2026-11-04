import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_KEY = /^[0-9a-f]{64}$/;

export const summarySchema = Type.Object({
  v: Type.Literal(1),
  id: Type.String({ pattern: ID.source }),
  project: Type.String(),
  scope: Type.Union([
    Type.Object({ kind: Type.Literal("session"), sessionId: Type.String() }),
    Type.Object({ kind: Type.Literal("project") }),
  ]),
  requesterSessionId: Type.String(),
  requestedBy: Type.Union([Type.Literal("user"), Type.Literal("agent")]),
  requestedAt: Type.String(),
  completedAt: Type.String(),
  model: Type.Object({ provider: Type.String(), id: Type.String() }),
  sources: Type.Array(Type.Object({
    sessionId: Type.String(),
    /** Entries supplied to the model; IDs are local to this source session. */
    entryIds: Type.Array(Type.String()),
    /** Conversation messages which can unlock a later request. */
    messageIds: Type.Array(Type.String()),
  })),
  text: Type.String({ minLength: 1 }),
});

export type StoredSummary = Static<typeof summarySchema>;
export type SummaryScope = StoredSummary["scope"];

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Independent of session files: summaries survive deletion of their source/requesting sessions. */
export class SummaryStore {
  constructor(readonly root = join(getAgentDir(), "pi-recall", "summaries")) {}

  projectDir(project: string): string {
    return join(this.root, createHash("sha256").update(resolve(project)).digest("hex"));
  }

  private async readFile(path: string): Promise<StoredSummary> {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!Check(summarySchema, value)) throw new Error(`Invalid saved summary: ${path}`);
    return value;
  }

  /** Newest first. Corrupt records are errors, never silently discarded checkpoints. */
  async records(project?: string): Promise<StoredSummary[]> {
    const dirs = project === undefined
      ? (await names(this.root)).filter((name) => PROJECT_KEY.test(name)).map((name) => join(this.root, name))
      : [this.projectDir(project)];
    const records: StoredSummary[] = [];
    for (const dir of dirs) {
      for (const name of await names(dir)) {
        if (!name.endsWith(".json") || !ID.test(name.slice(0, -5))) continue;
        const record = await this.readFile(join(dir, name));
        if (record.id !== name.slice(0, -5) || this.projectDir(record.project) !== dir) {
          throw new Error(`Saved summary identity does not match its file: ${join(dir, name)}`);
        }
        records.push(record);
      }
    }
    return records.sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.id.localeCompare(a.id));
  }

  async get(id: string): Promise<StoredSummary> {
    if (!ID.test(id)) throw new Error("Pass a complete summary id from recall_summary list");
    // Read only this id, not every summary body (or unrelated corrupt records) on the machine.
    for (const name of (await names(this.root)).filter((name) => PROJECT_KEY.test(name))) {
      const dir = join(this.root, name);
      const path = join(dir, `${id}.json`);
      let record: StoredSummary;
      try {
        record = await this.readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (record.id !== id || this.projectDir(record.project) !== dir) throw new Error(`Saved summary identity does not match its file: ${path}`);
      return record;
    }
    throw new Error(`No saved summary ${id}`);
  }

  /** The summary and its checkpoint become visible together, never as a partial JSON file. */
  async save(record: StoredSummary, signal?: AbortSignal): Promise<void> {
    if (!Check(summarySchema, record)) throw new Error("Invalid summary record");
    const dir = this.projectDir(record.project);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${record.id}.json`);
    await withFileMutationQueue(path, async () => {
      const temporary = join(dir, `.${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        signal?.throwIfAborted();
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  /** No queue/retry: competing callers fail before spending tokens, even in another Pi process. */
  async exclusive<T>(project: string, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const dir = this.projectDir(project);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const compromised = new AbortController();
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(dir, {
        retries: 0,
        stale: 30_000,
        update: 10_000,
        onCompromised: (error) => compromised.abort(error),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
        throw new Error("A summary is already being generated for this project. Wait for it to finish; requests are not queued.");
      }
      throw error;
    }
    const combined = AbortSignal.any([compromised.signal, ...(signal ? [signal] : [])]);
    try {
      combined.throwIfAborted();
      return await work(combined);
    } finally {
      // A compromised lock is already released by proper-lockfile; never remove a replacement owner's lock.
      if (!compromised.signal.aborted) await release();
    }
  }
}

export function summaryMetadata(record: StoredSummary) {
  const { text, sources, v, ...metadata } = record;
  return {
    ...metadata,
    sessionCount: sources.length,
    messageCount: sources.reduce((n, source) => n + source.messageIds.length, 0),
    entryCount: sources.reduce((n, source) => n + source.entryIds.length, 0),
  };
}
