import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { recall } from "./recall.ts";
import { search, searchTool } from "./search.ts";
import { context, project } from "./testing.ts";

const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let clock = Date.UTC(2026, 10, 4);

function assistant(sm: SessionManager, text: string, calls: { id: string; name: string; args: JsonObject }[] = []) {
  return sm.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private plan" },
      ...(text ? [{ type: "text" as const, text }] : []),
      ...calls.map((c) => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: c.args })),
    ],
    api: "test", provider: "test", model: "test", usage, stopReason: calls.length > 0 ? "toolUse" : "stop", timestamp: (clock += 1000),
  });
}

function result(sm: SessionManager, callId: string, name: string, text: string, isError = false) {
  return sm.appendMessage({ role: "toolResult", toolCallId: callId, toolName: name, isError, content: [{ type: "text", text }], timestamp: (clock += 1000) });
}

/** The ref recall_search gives an entry. */
const ref = (sm: SessionManager, id: string) => `${sm.getSessionId()}/${id}`;
const idOf = (sm: SessionManager, text: string) =>
  sm.getBranch().find((e) => e.type === "message" && e.message.role === "user" && e.message.content === text)!.id;
const refs = (r: Awaited<ReturnType<typeof search>>) => r.hits.map((hit) => hit.ref);

describe("recall_search", () => {
  test("finds matches newest first across sessions, with refs that recall_messages reads", async () => {
    const p = await project();
    const a = p.session(["talk about fences", "unrelated"]);
    const b = p.session(["Fence balancing works", "more fence talk"]);
    const ctx = context(p.session());

    const r = await search(ctx, { query: "fence" });
    expect(r).toMatchObject({ match: "literal", order: "recent", caseSensitive: false, next: null });
    expect(refs(r)).toEqual([
      ref(b, idOf(b, "more fence talk")),
      ref(b, idOf(b, "Fence balancing works")),
      ref(a, idOf(a, "talk about fences")),
    ]);
    expect(r.hits[0]).toEqual({
      ref: ref(b, idOf(b, "more fence talk")), sessionId: b.getSessionId(), timestamp: expect.any(String),
      type: "message", role: "user", matches: 1, snippets: [{ where: "text", text: "more fence talk" }],
    });

    const from = await recall(ctx, { from: r.hits[2]!.ref, limit: 1 });
    expect(from.sessions[0]!.entries[0]).toMatchObject({ text: "talk about fences" });
    const before = await recall(ctx, { before: r.hits[0]!.ref, limit: 1 });
    expect(before.sessions[0]!.entries[0]).toMatchObject({ text: "Fence balancing works" });

    const cased = await search(ctx, { query: "Fence" });
    expect(cased.caseSensitive).toBe(true);
    expect(refs(cased)).toEqual([ref(b, idOf(b, "Fence balancing works"))]);
  });

  test("matches regular expressions", async () => {
    const p = await project();
    const prev = p.session(["error E1234 here", "error code"]);
    const r = await search(context(p.session()), { query: "E\\d{4}", match: "regex" });
    expect(refs(r)).toEqual([ref(prev, idOf(prev, "error E1234 here"))]);
    await expect(search(context(p.session()), { query: "(", match: "regex" })).rejects.toThrow("Invalid regex");
  });

  test("searches tool calls by default and tool output on request, each on its own entry", async () => {
    const p = await project();
    const prev = p.session(["run the tests"]);
    const call = assistant(prev, "Running them.", [{ id: "c1", name: "bash", args: { command: "bun test src/clip.test.ts", timeout: 60 } }]);
    const output = result(prev, "c1", "bash", "error: ENOENT clip.ts", true);
    const orphan = result(prev, "gone", "read", "ENOENT again", true);
    assistant(prev, "Done.");
    const ctx = context(p.session());

    const args = await search(ctx, { query: "clip.test" });
    expect(args.hits).toMatchObject([
      { ref: ref(prev, call), role: "assistant", snippets: [{ where: "args", tool: "bash", text: "bash bun test src/clip.test.ts 60" }] },
    ]);
    expect((await search(ctx, { query: "ENOENT" })).hits).toEqual([]);
    expect((await search(ctx, { query: "clip", in: ["text"] })).hits).toEqual([]);

    const outputs = await search(ctx, { query: "ENOENT", in: ["outputs"] });
    expect(outputs.hits).toMatchObject([
      { ref: ref(prev, orphan), role: "toolResult", snippets: [{ where: "output", tool: "read", text: "ENOENT again" }] },
      { ref: ref(prev, output), role: "toolResult", snippets: [{ where: "output", tool: "bash", text: "error: ENOENT clip.ts" }] },
    ]);

    const everywhere = await search(ctx, { query: "clip", in: ["text", "tools", "outputs"] });
    expect(everywhere.hits).toMatchObject([
      { ref: ref(prev, output), matches: 1, snippets: [{ where: "output", tool: "bash" }] },
      { ref: ref(prev, call), matches: 1, snippets: [{ where: "args", tool: "bash" }] },
    ]);
  });

  test("searches summaries, labels, custom messages and shell commands, but not thinking or images", async () => {
    const p = await project();
    const prev = p.session(["start"]);
    const start = prev.getLeafId()!;
    assistant(prev, "Thinking done.");
    prev.appendLabelChange(start, "milestone");
    prev.appendCustomMessageEntry("note", "injected reminder", true);
    prev.appendMessage({ role: "bashExecution", command: "git status", output: "nothing to commit", exitCode: 0, cancelled: false, truncated: false, timestamp: (clock += 1000) });
    prev.appendMessage({ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: (clock += 1000) });
    const compaction = prev.appendCompaction("## Decisions\nUse literal search first.", prev.getLeafId(), 10);
    p.user(prev, "after");
    const ctx = context(p.session());
    const find = async (query: string, scopes?: ("text" | "tools" | "outputs")[]) =>
      (await search(ctx, { query, ...(scopes ? { in: scopes } : {}) })).hits;

    expect(await find("private plan")).toEqual([]);
    expect(await find("image")).toEqual([]);
    expect(await find("milestone")).toMatchObject([{ ref: ref(prev, start), snippets: [{ where: "label", text: "milestone" }] }]);
    expect(await find("reminder")).toMatchObject([{ type: "custom_message", snippets: [{ where: "text" }] }]);
    expect(await find("literal search")).toMatchObject([{ ref: ref(prev, compaction), type: "compaction", snippets: [{ where: "summary" }] }]);
    expect(await find("git status")).toMatchObject([{ role: "bashExecution", snippets: [{ where: "args", tool: "bash", text: "git status" }] }]);
    expect(await find("nothing to commit")).toEqual([]);
    expect(await find("nothing to commit", ["outputs"])).toMatchObject([{ role: "bashExecution", snippets: [{ where: "output" }] }]);
  });

  test("an entry with many matches is one hit with up to three snippets", async () => {
    const p = await project();
    const filler = " filler".repeat(60);
    p.session([Array.from({ length: 5 }, (_, i) => `needle ${i}${filler}`).join("\n")]);
    const r = await search(context(p.session()), { query: "needle" });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.matches).toBe(5);
    expect(r.hits[0]!.snippets.map((s) => s.text.match(/needle \d/g))).toEqual([["needle 0"], ["needle 1"], ["needle 2"]]);
  });

  test("skips entries in context unless includeContext, but finds what compaction removed", async () => {
    const p = await project();
    const prev = p.session(["needle old"]);
    const current = p.session(["needle 1", "needle 2", "needle 3"]);
    current.appendCompaction("Summary", idOf(current, "needle 3"), 100);
    p.user(current, "needle 4");
    const ctx = context(current);

    expect(refs(await search(ctx, { query: "needle" }))).toEqual([
      ref(current, idOf(current, "needle 2")),
      ref(current, idOf(current, "needle 1")),
      ref(prev, idOf(prev, "needle old")),
    ]);
    const all = await search(ctx, { query: "needle", includeContext: true });
    expect(all.hits.map((hit) => hit.snippets[0]!.text)).toEqual(["needle 4", "needle 3", "needle 2", "needle 1", "needle old"]);
  });

  test("sessionId searches one session", async () => {
    const p = await project();
    const a = p.session(["needle a"]);
    p.session(["needle b"]);
    const ctx = context(p.session());
    expect(refs(await search(ctx, { query: "needle", sessionId: a.getSessionId() }))).toEqual([ref(a, idOf(a, "needle a"))]);
    await expect(search(ctx, { query: "needle", sessionId: "missing" })).rejects.toThrow("Session missing not found");
  });

  test("pages with next across sessions without skipping or repeating", async () => {
    const p = await project();
    p.session(["hit 0", "miss", "hit 1"]);
    p.session(["hit 2", "miss", "hit 3", "hit 4"]);
    const ctx = context(p.session());

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await search(ctx, { query: "hit", limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...r.hits.map((hit) => hit.snippets[0]!.text));
      cursor = r.next ?? undefined;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(["hit 4", "hit 3", "hit 2", "hit 1", "hit 0"]);

    // A full last page has no next.
    expect((await search(ctx, { query: "hit", limit: 5 })).next).toBeNull();
  });

  test("rejects bad cursors, scopes and limits", async () => {
    const p = await project();
    const prev = p.session(["one"]);
    const ctx = context(p.session());
    await expect(search(ctx, { query: "one", cursor: "nope" })).rejects.toThrow("Invalid cursor");
    await expect(search(ctx, { query: "one", cursor: `${prev.getSessionId()}/missing` })).rejects.toThrow("Invalid cursor");
    await expect(search(ctx, { query: "one", in: [] })).rejects.toThrow("in must list");
    await expect(search(ctx, { query: "one", in: ["bogus" as "text"] })).rejects.toThrow("in must list");
    for (const limit of [0, 51, 1.5, NaN]) {
      await expect(search(ctx, { query: "one", limit })).rejects.toThrow("limit must be");
    }
  });

  test("the tool returns structured hits and keeps details small", async () => {
    const p = await project();
    const prev = p.session(["needle"]);
    const r = await searchTool.execute("t", { query: "needle" }, undefined, undefined, context(p.session()));
    expect(r.details).toEqual({ match: "literal", hits: [ref(prev, prev.getLeafId()!)], next: null });
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual(r.structuredContent!);
    expect(r.structuredContent).toMatchObject({ order: "recent", hits: [{ snippets: [{ text: "needle" }] }] });
  });
});
