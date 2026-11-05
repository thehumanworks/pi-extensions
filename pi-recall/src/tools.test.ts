import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { formatEntry, preview } from "./format.ts";
import { recall, recallTool } from "./recall.ts";
import { sessionsTool } from "./sessions-tool.ts";
import { context, project } from "./testing.ts";

type Message = SessionMessageEntry["message"];

function entry(id: string, message: Message): SessionMessageEntry {
  return { type: "message", id, parentId: null, timestamp: "2026-11-02T00:00:00.000Z", message };
}

/** A fresh current session after a saved session holding the texts. */
async function after(texts: string[]) {
  const p = await project();
  const prev = p.session(texts);
  return { prev, ctx: context(p.session()) };
}

const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const image = { type: "image" as const, data: "A".repeat(400), mimeType: "image/png" };

describe("preview", () => {
  test("clips user text and marks images", () => {
    const text = `hello\n  world ${"x".repeat(500)}`;
    const clip = preview({ role: "user", content: [{ type: "text", text }, image], timestamp: 0 });
    expect(clip.startsWith("hello world x")).toBe(true);
    expect(clip.length).toBe(240);
    expect(clip.endsWith("…")).toBe(true);
  });

  test("lists assistant tool calls and errors, without thinking", () => {
    const clip = preview({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret plan" },
        { type: "text", text: "Reading files" },
        { type: "toolCall", id: "c1", name: "read", arguments: {} },
        { type: "toolCall", id: "c2", name: "bash", arguments: {} },
      ],
      api: "test", provider: "test", model: "test", usage, stopReason: "error", errorMessage: "overloaded",
      timestamp: 0,
    });
    expect(clip).toBe("Reading files [tool calls: read; bash] [error: overloaded]");
  });

  test("names the tool of a tool result", () => {
    expect(preview({
      role: "toolResult", toolCallId: "c1", toolName: "read", isError: true,
      content: [{ type: "text", text: "ENOENT" }], timestamp: 0,
    })).toBe("read ✗ 6 chars: ENOENT");
  });

  test("shows the command and status of a shell execution", () => {
    expect(preview({
      role: "bashExecution", command: "ls", output: "a\nb", exitCode: 0, cancelled: false, truncated: false,
      timestamp: 0,
    })).toBe("$ ls (exit 0): a b");
  });

  test("uses the summary of summaries and the type of custom messages", () => {
    expect(preview({ role: "compactionSummary", summary: "Did X", tokensBefore: 1, timestamp: 0 })).toBe("Did X");
    expect(preview({ role: "branchSummary", summary: "Tried Y", fromId: null, timestamp: 0 })).toBe("Tried Y");
    expect(preview({ role: "custom", customType: "note", content: "hi", display: true, timestamp: 0 }))
      .toBe("note: hi");
  });

  test("tolerates unknown roles", () => {
    expect(preview({ role: "other", content: "data" } as unknown as Message)).toBe("data");
  });
});

describe("formatEntry", () => {
  const e = entry("m1", { role: "user", content: [{ type: "text", text: "look" }, image], timestamp: 0 });

  test("messages include the type, role, notes and text, with images as placeholders", () => {
    expect(formatEntry(e, "messages", { label: "bookmark" }) as Record<string, unknown>).toEqual({
      id: "m1", parentId: null, timestamp: "2026-11-02T00:00:00.000Z", type: "message", role: "user", label: "bookmark",
      text: "look\n[image image/png]",
    });
  });

  test("full omits image data and keeps the rest", () => {
    const full = formatEntry(e, "full") as unknown as { message: { content: unknown[] } };
    expect(full.message.content).toEqual([
      { type: "text", text: "look" },
      { type: "image", mimeType: "image/png", omittedBytes: 300 },
    ]);
  });
});

describe("recall output modes", () => {
  test("defaults to messages and rejects the removed modes", async () => {
    const { ctx } = await after(["hi"]);
    expect((await recall(ctx)).sessions[0]!.entries[0]).toMatchObject({ text: "hi" });
    for (const outputMode of ["compact", "short", "metadata"]) {
      await expect(recall(ctx, { outputMode: outputMode as "full" })).rejects.toThrow("outputMode must be one of messages, full");
    }
  });

  test("from an id with limit 1 reads that entry in full", async () => {
    const { prev, ctx } = await after(["first", "second"]);
    const [, second] = prev.getBranch();
    const result = await recall(ctx, { from: `${prev.getSessionId()}/${second!.id}`, limit: 1, outputMode: "full" });
    expect(result.sessions[0]!.entries).toMatchObject([{ id: second!.id, message: { content: "second" } }]);
    expect(result.newer).toBeNull();
  });
});

describe("tool results", () => {
  test("recall keeps details small and returns structured content", async () => {
    const { prev, ctx } = await after(["hi"]);
    const id = prev.getLeafId()!;
    const result = await recallTool.execute("t", { outputMode: "full" }, undefined, undefined, ctx);
    expect(result.details).toEqual({
      outputMode: "full", sessions: [{ sessionId: prev.getSessionId(), ids: [id] }], older: null, newer: null,
    });
    expect(result.structuredContent).toMatchObject({ sessions: [{ entries: [{ id, message: { content: "hi" } }] }] });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.structuredContent!);
  });

  test("truncates large output and saves the complete JSON", async () => {
    const big = "y".repeat(80 * 1024);
    const { ctx } = await after([big]);
    const result = await recallTool.execute("t", { outputMode: "full" }, undefined, undefined, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(Buffer.byteLength(text)).toBeLessThan(60 * 1024);
    expect(text).toContain("[Truncated:");
    const path = (result.details as { fullOutputPath: string }).fullOutputPath;
    expect(JSON.parse(await readFile(path, "utf8")).sessions[0].entries[0].message.content).toBe(big);
  });
});

describe("recall_sessions", () => {
  test("lists the current session first, then by last activity, with forks and paging", async () => {
    const p = await project();
    const a = p.session(["a"]);
    const b = p.session(["b"]);
    const fork = p.session(["fork"], { parentSession: a.getSessionFile() });
    p.user(a, "a again");
    const current = p.session();
    const ctx = context(current);

    const first = await sessionsTool.execute("t", { limit: 3 }, undefined, undefined, ctx);
    const page = first.structuredContent as { sessions: Record<string, unknown>[]; next: string | null };
    expect(page.sessions.map((s) => s.sessionId)).toEqual([current.getSessionId(), a.getSessionId(), fork.getSessionId()]);
    expect(page.sessions[0]).toMatchObject({ current: true, messageCount: 0, firstMessage: "(no messages)" });
    expect(page.sessions[1]).toMatchObject({ messageCount: 2, firstMessage: "a" });
    expect(page.sessions[2]).toMatchObject({ parentSessionId: a.getSessionId() });
    expect(page.next).toBe("3");

    const second = await sessionsTool.execute("t", { cursor: page.next! }, undefined, undefined, ctx);
    expect(second.details).toEqual({ ids: [b.getSessionId()], next: null });
  });
});
