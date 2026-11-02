import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { PAGE_MAX_CHARS, recall } from "./recall.ts";
import { search } from "./search.ts";
import { context, project } from "./testing.ts";

type Result = Awaited<ReturnType<typeof recall>>;
type Entry = Record<string, unknown> & { id: string };
type Trace = { entries: number; calls: number; tools: Record<string, number>; changed?: string[]; moreChanged?: number; errors?: Record<string, string>[]; moreErrors?: number };

const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let clock = Date.UTC(2026, 10, 3);

function assistant(sm: SessionManager, text: string, calls: { id: string; name: string; args: JsonObject }[] = [], stopReason: "stop" | "toolUse" | "aborted" = calls.length > 0 ? "toolUse" : "stop") {
  return sm.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private" },
      ...(text ? [{ type: "text" as const, text }] : []),
      ...calls.map((c) => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: c.args })),
    ],
    api: "test", provider: "test", model: "test", usage, stopReason, timestamp: (clock += 1000),
  });
}

function result(sm: SessionManager, callId: string, name: string, text: string, isError = false) {
  return sm.appendMessage({ role: "toolResult", toolCallId: callId, toolName: name, isError, content: [{ type: "text", text }], timestamp: (clock += 1000) });
}

const entries = (r: Result) => r.sessions.flatMap((s) => s.entries) as Entry[];
const texts = (r: Result) => entries(r).map((e) => e.text);

describe("traces", () => {
  test("fold the tool calls after a message into its trace, with files changed and errors", async () => {
    const p = await project();
    const prev = p.session(["run the tests"]);
    assistant(prev, "Running them.", [
      { id: "c1", name: "bash", args: { command: "bun test" } },
      { id: "c2", name: "edit", args: { path: "a.ts", edits: [] } },
      { id: "c3", name: "read", args: { path: "c.ts" } },
    ]);
    result(prev, "c1", "bash", "39 pass\n0 fail");
    const failed = result(prev, "c2", "edit", `Error at start\n${"noise\n".repeat(200)}oldText not found`, true);
    assistant(prev, "", [{ id: "c4", name: "write", args: { path: "b.ts", content: "x" } }]);
    result(prev, "c4", "write", "ok");
    assistant(prev, "Done.");
    const sid = prev.getSessionId();

    const r = await recall(context(p.session()));
    const list = entries(r);
    expect(list.map((e) => e.text)).toEqual(["run the tests", "Running them.", "Done."]);
    expect(list[0]).not.toHaveProperty("trace");
    expect(list[1]).not.toHaveProperty("thinking");
    expect(list[1]).not.toHaveProperty("tools");
    expect(list[2]).not.toHaveProperty("trace");
    const trace = list[1]!.trace as Trace;
    expect(trace).toMatchObject({
      entries: 4,
      calls: 4,
      tools: { bash: 1, edit: 1, read: 1, write: 1 },
      changed: ["b.ts"],
      errors: [{ tool: "edit", call: "a.ts", result: `${sid}/${failed}` }],
    });
    expect(trace.errors![0]!.error).toContain("Error at start");
    expect(trace.errors![0]!.error).toContain("oldText not found");
    expect(trace).not.toHaveProperty("moreErrors");

    // An error's result reads that output, and the message with limit entries + 1 reads all of its calls.
    const output = await recall(context(p.session()), { from: trace.errors![0]!.result, limit: 1, outputMode: "full" });
    expect(entries(output)[0]).toMatchObject({ id: failed, message: { role: "toolResult", isError: true } });
    const calls = await recall(context(p.session()), { from: `${sid}/${list[1]!.id}`, limit: trace.entries + 1, outputMode: "full" });
    expect(entries(calls).map((e) => (e.message as { role: string }).role)).toEqual(["assistant", "toolResult", "toolResult", "assistant", "toolResult"]);
  });

  test("count calls by tool, most used first, and cap the files and errors listed", async () => {
    const p = await project();
    const prev = p.session(["refactor"]);
    for (let i = 0; i < 12; i++) {
      assistant(prev, "", [{ id: `e${i}`, name: "edit", args: { path: `f${i}.ts` } }]);
      result(prev, `e${i}`, "edit", "ok");
    }
    for (let i = 0; i < 5; i++) {
      assistant(prev, "", [{ id: `b${i}`, name: "bash", args: { command: `cmd ${i}` } }]);
      result(prev, `b${i}`, "bash", `fail ${i}`, true);
    }
    const trace = entries(await recall(context(p.session())))[0]!.trace as Trace;
    expect(Object.entries(trace.tools)).toEqual([["edit", 12], ["bash", 5]]);
    expect(trace).toMatchObject({ entries: 34, calls: 17, moreChanged: 4, moreErrors: 2 });
    expect(trace.changed).toHaveLength(8);
    expect(trace.errors!.map((e) => e.call)).toEqual(["cmd 0", "cmd 1", "cmd 2"]);
  });

  test("include a tool result whose call is not on the branch, and show aborted replies and shell commands as messages", async () => {
    const p = await project();
    const prev = p.session(["go"]);
    const orphan = result(prev, "gone", "bash", "boom", true);
    assistant(prev, "", [], "aborted");
    prev.appendMessage({ role: "bashExecution", command: "ls", output: "a\nb", exitCode: 0, cancelled: false, truncated: false, timestamp: (clock += 1000) });
    const list = entries(await recall(context(p.session())));
    expect(list[0]!.trace).toEqual({
      entries: 1, calls: 1, tools: { bash: 1 },
      errors: [{ tool: "bash", error: "boom", result: `${prev.getSessionId()}/${orphan}` }],
    });
    expect(list[1]).toMatchObject({ role: "assistant", stopReason: "aborted" });
    expect(list[2]).toMatchObject({ command: "ls", exitCode: 0, outputChars: 3, output: "a\nb" });
  });
});

describe("paging messages", () => {
  test("limit counts messages, not tool calls", async () => {
    const p = await project();
    const prev = p.session(["first"]);
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 10; i++) {
        assistant(prev, "", [{ id: `c${round}-${i}`, name: "read", args: { path: `${i}.ts` } }]);
        result(prev, `c${round}-${i}`, "read", "text");
      }
      assistant(prev, `reply ${round}`);
    }
    const ctx = context(p.session());
    const page = await recall(ctx, { limit: 2 });
    expect(texts(page)).toEqual(["reply 1", "reply 2"]);
    const back = await recall(ctx, { before: page.older!, limit: 2 });
    expect(texts(back)).toEqual(["first", "reply 0"]);
    expect(back.older).toBeNull();
    expect((entries(back)[0]!.trace as Trace).calls).toBe(10);
  });

  test("a cursor at a tool entry belongs to the message before it", async () => {
    const p = await project();
    const prev = p.session(["start"]);
    assistant(prev, "step 0", [{ id: "c0", name: "bash", args: { command: "one" } }]);
    const call = assistant(prev, "", [{ id: "c1", name: "bash", args: { command: "needle" } }]);
    const output = result(prev, "c1", "bash", "out");
    assistant(prev, "step 1");
    const ctx = context(p.session());
    const sid = prev.getSessionId();

    for (const id of [call, output]) {
      expect(texts(await recall(ctx, { from: `${sid}/${id}`, limit: 1 }))).toEqual(["step 0"]);
      expect(texts(await recall(ctx, { before: `${sid}/${id}` }))).toEqual(["start", "step 0"]);
    }
    // A search hit in a tool call reads from the message whose trace holds it.
    const [hit] = (await search(ctx, { query: "needle" })).hits;
    expect(hit!.ref).toBe(`${sid}/${call}`);
    expect(entries(await recall(ctx, { from: hit!.ref, limit: 1 }))[0]).toMatchObject({ text: "step 0", trace: { calls: 2 } });
  });

  test("a cursor at a tool entry before any message starts at the next message", async () => {
    const p = await project();
    const prev = p.session();
    const orphan = result(prev, "gone", "read", "early");
    p.user(prev, "first message");
    const r = await recall(context(p.session()), { from: `${prev.getSessionId()}/${orphan}`, limit: 1 });
    expect(texts(r)).toEqual(["first message"]);
  });

  test("stops a page near the size limit and continues without skipping or repeating", async () => {
    const p = await project();
    const texts = Array.from({ length: 12 }, (_, i) => `${i} ${"x".repeat(2900)}`);
    p.session(texts);
    const ctx = context(p.session());

    const seen: string[] = [];
    let before: string | undefined;
    let pages = 0;
    do {
      const r = await recall(ctx, before ? { before } : {});
      expect(JSON.stringify(r).length).toBeLessThan(PAGE_MAX_CHARS + 1000);
      seen.unshift(...entries(r).map((e) => e.id));
      before = r.older ?? undefined;
      pages++;
    } while (before);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  test("always returns one message, even one over the limit", async () => {
    const p = await project();
    p.session(["y".repeat(20000)]);
    expect(entries(await recall(context(p.session())))).toHaveLength(1);
  });
});

describe("message text", () => {
  test("keeps messages whole up to 3,000 chars and shortens longer ones", async () => {
    const p = await project();
    const fits = "a".repeat(3000);
    const long = `${"Start. ".repeat(300)}\n\n${"middle ".repeat(1000)}\n\n${"End. ".repeat(100).trim()}`;
    p.session([fits, long]);
    const [first, second] = entries(await recall(context(p.session())));
    expect(first!.text).toBe(fits);
    expect(second!.text).toMatch(/^Start\. /);
    expect(second!.text).toMatch(/End\.$/);
    expect(second!.text).toContain("chars omitted");
    expect((second!.text as string).length).toBeLessThan(3200);
  });

  test("shortens compaction summaries by section and reports their size", async () => {
    const p = await project();
    const prev = p.session(["one", "two"]);
    const summary = `## Objective\nBuild it.\n## Decisions\n${"- choice\n".repeat(1000)}## Next Steps\nShip.`;
    prev.appendCompaction(summary, prev.getLeafId(), 99);
    const list = entries(await recall(context(p.session())));
    const compaction = list.find((e) => e.type === "compaction")!;
    expect(compaction).toMatchObject({ summaryChars: summary.length, tokensBefore: 99 });
    expect(compaction.summary).toContain("## Next Steps\nShip.");
    expect((compaction.summary as string).length).toBeLessThan(3500);
  });
});
