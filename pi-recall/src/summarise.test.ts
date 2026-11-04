import { describe, expect, test } from "bun:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { RecalledEntry } from "./entries.ts";
import { SUMMARISER, summarise, summariserModel } from "./summarise.ts";

const model = { provider: SUMMARISER.provider, id: SUMMARISER.id, maxTokens: 32000, contextWindow: 128000 };

function registry(reply: Partial<AssistantMessage>, options: { known?: boolean; auth?: boolean } = {}) {
  const calls: Context[] = [];
  const completionOptions: { signal?: AbortSignal; maxTokens?: number; cacheRetention?: string }[] = [];
  const stub = {
    find: (provider: string, id: string) =>
      options.known !== false && provider === SUMMARISER.provider && id === SUMMARISER.id ? model : undefined,
    hasConfiguredAuth: () => options.auth !== false,
    complete: async (_model: unknown, context: Context, options: typeof completionOptions[number]) => {
      calls.push(context);
      completionOptions.push(options);
      return { content: [], stopReason: "stop", ...reply } as AssistantMessage;
    },
  };
  return { registry: stub as unknown as ModelRegistry, calls, completionOptions };
}

const entry = (id: string, text: string) =>
  ({ type: "message", id, parentId: null, timestamp: "t", message: { role: "user", content: text, timestamp: 1 } }) as RecalledEntry;

describe("summariserModel", () => {
  test("finds the summariser in the registry", () => {
    expect(summariserModel(registry({}).registry)).toBe(model as never);
  });

  test("names the model when it is unknown or has no credentials", () => {
    expect(() => summariserModel(registry({}, { known: false }).registry)).toThrow("inception/mercury-3 is not available");
    expect(() => summariserModel(registry({}, { auth: false }).registry)).toThrow("No credentials configured for vercel-ai-gateway");
  });
});

describe("summarise", () => {
  test("sends each entry with its id and returns the summary text", async () => {
    const { registry: stub, calls } = registry({ content: [{ type: "text", text: " Summary\n\nCitations {} " }] });
    expect(await summarise(stub, [entry("a1", "first"), entry("b2", "second")])).toBe("Summary\n\nCitations {}");
    const prompt = String(calls[0]!.messages[0]!.content);
    expect(prompt).toContain('"id":"a1"');
    expect(prompt).toContain('"text":"second"');
  });

  test("passes notes, cancellation and bounded output options", async () => {
    const { registry: stub, calls, completionOptions } = registry({ content: [{ type: "text", text: "Summary" }] });
    const controller = new AbortController();
    await summarise(stub, [entry("a1", "first")], { signal: controller.signal, notes: () => ({ label: "important" }) });
    expect(completionOptions[0]).toEqual({ signal: controller.signal, maxTokens: 4096, cacheRetention: "none" });
    expect(String(calls[0]!.messages[0]!.content)).toContain('"label":"important"');
    stub.find = () => ({ ...model, maxTokens: 1024 }) as never;
    await summarise(stub, [entry("a1", "first")]);
    expect(completionOptions[1]!.maxTokens).toBe(1024);
    controller.abort();
    await expect(summarise(stub, [entry("a1", "first")], { signal: controller.signal })).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  test("rejects oversized history before calling the model", async () => {
    const { registry: stub, calls } = registry({});
    await expect(summarise(stub, Array.from({ length: 300 }, (_, i) => entry(String(i), "x".repeat(3000))))).rejects.toThrow("too large");
    expect(calls).toHaveLength(0);
  });

  test("throws on errors and empty replies", async () => {
    await expect(summarise(registry({ stopReason: "error", errorMessage: "boom" }).registry, [entry("a1", "x")])).rejects.toThrow("boom");
    await expect(summarise(registry({}).registry, [entry("a1", "x")])).rejects.toThrow("empty summary");
    await expect(summarise(registry({}).registry, [])).rejects.toThrow("No messages");
  });
});
