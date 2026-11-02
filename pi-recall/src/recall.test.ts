import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { recall } from "./recall.ts";
import { context, project } from "./testing.ts";

type Result = Awaited<ReturnType<typeof recall>>;

/** The text or summary of each message. */
const clips = (result: Result) =>
  result.sessions.flatMap((s) => s.entries.map((e) => (e as { text?: string; summary?: string }).text ?? (e as { summary?: string }).summary));
const sessionIds = (result: Result) => result.sessions.map((s) => s.sessionId);

describe("recall across sessions", () => {
  test("a fresh session returns the end of the previous session", async () => {
    const p = await project();
    p.session(["old 1", "old 2"]);
    const prev = p.session(["prev 1", "prev 2", "prev 3"]);
    const current = p.session();
    const result = await recall(context(current), { limit: 2 });
    expect(clips(result)).toEqual(["prev 2", "prev 3"]);
    expect(sessionIds(result)).toEqual([prev.getSessionId()]);
    expect(result.newer).toBeNull();
    expect(result.older).toBe(`${prev.getSessionId()}/${result.sessions[0]!.entries[0]!.id}`);
  });

  test("pages back across session boundaries, grouping oldest first, and forward again", async () => {
    const p = await project();
    const a = p.session(["a1", "a2"]);
    const b = p.session(["b1", "b2"]);
    const ctx = context(p.session());

    const first = await recall(ctx, { limit: 3 });
    expect(clips(first)).toEqual(["a2", "b1", "b2"]);
    expect(sessionIds(first)).toEqual([a.getSessionId(), b.getSessionId()]);

    const second = await recall(ctx, { limit: 3, before: first.older! });
    expect(clips(second)).toEqual(["a1"]);
    expect(second.older).toBeNull();

    const forward = await recall(ctx, { limit: 2, from: second.newer! });
    expect(clips(forward)).toEqual(["a2", "b1"]);
    const rest = await recall(ctx, { limit: 2, from: forward.newer! });
    expect(clips(rest)).toEqual(["b2"]);
    expect(rest.newer).toBeNull();
  });

  test("orders sessions by last activity, not creation", async () => {
    const p = await project();
    const early = p.session(["early"]);
    p.session(["middle"]);
    p.user(early, "resumed");
    const result = await recall(context(p.session()), { limit: 3 });
    expect(clips(result)).toEqual(["middle", "early", "resumed"]);
  });

  test("sessionId reads one session", async () => {
    const p = await project();
    const a = p.session(["a1", "a2"]);
    p.session(["b1"]);
    const ctx = context(p.session());
    const result = await recall(ctx, { sessionId: a.getSessionId() });
    expect(clips(result)).toEqual(["a1", "a2"]);
    expect(result.older).toBeNull();
    expect(result.newer).toBeNull();
    const bare = await recall(ctx, { sessionId: a.getSessionId(), from: result.sessions[0]!.entries[1]!.id, limit: 1 });
    expect(clips(bare)).toEqual(["a2"]);
  });

  test("distinguishes the same entry id in two sessions", async () => {
    const p = await project();
    const write = (id: string, time: number, text: string) =>
      writeFile(
        join(p.sessionDir, `t${time}_${id}.jsonl`),
        [
          { type: "session", version: 3, id, timestamp: new Date(time).toISOString(), cwd: p.cwd },
          { type: "message", id: "same", parentId: null, timestamp: new Date(time).toISOString(),
            message: { role: "user", content: text, timestamp: time } },
        ].map((line) => JSON.stringify(line)).join("\n") + "\n",
      );
    const current = p.session();
    await write("s1", 1000, "first");
    await write("s2", 2000, "second");
    const ctx = context(current);
    expect(clips(await recall(ctx, { from: "s1/same", limit: 1 }))).toEqual(["first"]);
    expect(clips(await recall(ctx, { from: "s2/same", limit: 1 }))).toEqual(["second"]);
    expect(clips(await recall(ctx, { before: "s2/same" }))).toEqual(["first"]);
  });

  test("does not modify other sessions' files", async () => {
    const p = await project();
    const prev = p.session(["kept"]);
    const before = await readFile(prev.getSessionFile()!, "utf8");
    await recall(context(p.session()));
    expect(await readFile(prev.getSessionFile()!, "utf8")).toBe(before);
  });
});

describe("the current session", () => {
  test("skips entries in context, returns what compaction removed, and includeContext returns all", async () => {
    const p = await project();
    p.session(["prev"]);
    const current = p.session(["c1", "c2", "c3"]);
    const kept = current.getBranch().find((e) => e.type === "message" && e.message.role === "user" && e.message.content === "c3")!;
    const compaction = current.appendCompaction("Summary of c1 and c2", kept.id, 100);
    p.user(current, "c4");
    const ctx = context(current);

    const result = await recall(ctx);
    expect(clips(result)).toEqual(["prev", "c1", "c2"]);
    expect(result.sessions.at(-1)!.current).toBe(true);
    expect(result.newer).toBeNull();

    const all = await recall(ctx, { includeContext: true });
    expect(clips(all)).toEqual(["prev", "c1", "c2", "c3", "Summary of c1 and c2", "c4"]);
    await expect(recall(ctx, { from: compaction, limit: 1 })).rejects.toThrow("includeContext");
  });

  test("returns entries removed or replaced by a context edit, marked", async () => {
    const p = await project();
    const current = p.session(["keep", "drop", "swap"]);
    const [keep, drop, swap] = current.getBranch().map((e) => e.id);
    current.appendContextEdit(drop!, null);
    current.appendContextEdit(swap!, { content: "swapped" });
    const result = await recall(context(current));
    expect(result.sessions[0]!.entries).toMatchObject([
      { id: drop, contextEdit: "removed" },
      { id: swap, contextEdit: "replaced" },
    ]);
    expect(result.sessions[0]!.entries.map((e) => e.id)).not.toContain(keep);
  });

  test("a current session not yet saved is still read", async () => {
    const p = await project();
    p.session(["prev"]);
    const current = p.session();
    current.appendModelChange("test", "model");
    const result = await recall(context(current), { includeContext: true });
    expect(clips(result)).toEqual(["prev"]);
  });
});

describe("entry types", () => {
  test("returns messages and summaries, attaches labels and names, and leaves out the rest", async () => {
    const p = await project();
    const prev = p.session(["start"]);
    const start = prev.getLeafId()!;
    p.user(prev, "abandoned");
    prev.branchWithSummary(start, "Tried something else");
    prev.appendModelChange("test", "model");
    prev.appendThinkingLevelChange("high");
    prev.appendCustomEntry("state", { big: "x" });
    prev.appendCustomMessageEntry("note", "injected", true);
    prev.appendSessionInfo("Named");
    prev.appendLabelChange(start, "important");
    p.user(prev, "after");

    const result = await recall(context(p.session()));
    const [session] = result.sessions;
    expect(session!.name).toBe("Named");
    expect(session!.entries.map((e) => e.type)).toEqual(["message", "branch_summary", "custom_message", "message"]);
    expect(session!.entries[0]).toMatchObject({ id: start, label: "important" });

    const short = await recall(context(p.session()));
    expect(clips(short)).toEqual(["start", "Tried something else", "injected", "after"]);
  });

  test("full leaves out extension details and the compaction system prompt", async () => {
    const p = await project();
    const prev = p.session(["one", "two"]);
    const id = prev.appendCompaction("Sum", prev.getLeafId(), 5, { private: true });
    const result = await recall(context(p.session()), { from: `${prev.getSessionId()}/${id}`, limit: 1, outputMode: "full" });
    const entry = result.sessions[0]!.entries[0]!;
    expect(entry).toMatchObject({ type: "compaction", summary: "Sum", tokensBefore: 5 });
    expect(entry).not.toHaveProperty("details");
    expect(entry).not.toHaveProperty("systemMessage");
  });
});

describe("errors", () => {
  test("rejects bad cursors, sessions and limits", async () => {
    const p = await project();
    const prev = p.session(["one"]);
    const ctx = context(p.session());
    await expect(recall(ctx, { sessionId: "missing" })).rejects.toThrow("Session missing not found");
    await expect(recall(ctx, { from: "missing/x" })).rejects.toThrow("Session missing not found");
    await expect(recall(ctx, { from: `${prev.getSessionId()}/x` })).rejects.toThrow("Entry x not found");
    await expect(recall(ctx, { from: "a", before: "b" })).rejects.toThrow("either before or from");
    for (const limit of [0, -1, 21, 1.5, NaN, Infinity]) {
      await expect(recall(ctx, { limit })).rejects.toThrow("limit must be");
    }
  });

  test("an empty project returns nothing", async () => {
    const p = await project();
    expect(await recall(context(p.session()))).toEqual({ sessions: [], older: null, newer: null });
  });
});
