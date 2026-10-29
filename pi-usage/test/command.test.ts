import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { registerUsage } from "../index.ts";
import { collectUsage } from "../src/service.ts";
import { UsageError, type AuthRegistry, type UsageProvider, type UsageSnapshot } from "../src/types.ts";

const registry: AuthRegistry = { getProvider: () => undefined, getProviderAuth: async () => undefined };
const snapshot: UsageSnapshot = { account: "test account", source: "test", fetchedAt: 1, groups: [], notes: [] };
const provider = (id = "test", fetch: UsageProvider["fetch"] = async () => snapshot): UsageProvider => ({ id, label: id, dashboardUrl: "https://example.test/usage", fetch });

function harness(providers: UsageProvider[]) {
  let command!: Omit<RegisteredCommand, "name">;
  let shutdown!: () => void;
  const notifications: string[] = [];
  registerUsage({
    registerCommand(name: string, options: Omit<RegisteredCommand, "name">) { assert.equal(name, "usage"); command = options; },
    on(name: string, handler: () => void) { assert.equal(name, "session_shutdown"); shutdown = handler; },
  } as unknown as ExtensionAPI, providers);
  const ctx = { hasUI: true, mode: "rpc", modelRegistry: registry, ui: { notify(message: string) { notifications.push(message); } } } as unknown as ExtensionCommandContext;
  return { get command() { return command; }, shutdown: () => shutdown(), notifications, ctx };
}

test("provider results remain independent and ordered; raw failures are redacted", async () => {
  let starts = 0;
  const providers = [provider("ok", async () => { starts++; await delay(5); return snapshot; }),
    provider("error", async () => { starts++; throw new Error("secret request headers"); }),
    provider("unavailable", async () => { starts++; throw new UsageError("Sign in first", "unavailable"); })];
  const results = await collectUsage(providers, registry, new AbortController().signal);
  assert.equal(starts, 3);
  assert.deepEqual(results.map((r) => [r.provider.id, r.status]), [["ok", "ok"], ["error", "error"], ["unavailable", "unavailable"]]);
  assert.ok(!JSON.stringify(results).includes("secret"));
  assert.ok(JSON.stringify(results).includes("Sign in first"));
});

test("timeouts bound stalled providers/auth refresh and abort their signals", async () => {
  let signal!: AbortSignal;
  const task = collectUsage([provider("stalled", async (ctx) => {
    signal = ctx.signal;
    return new Promise(() => {});
  })], registry, new AbortController().signal, 5);
  const [results] = await Promise.all([task, delay(20)]); // keep Node alive for AbortSignal.timeout's unref'd timer
  assert.equal(results[0].status, "error");
  assert.match(JSON.stringify(results), /timed out/);
  assert.equal(signal.aborted, true);
});

test("cancellation stops waiting even if Pi auth refresh ignores the signal", async () => {
  const controller = new AbortController();
  const task = collectUsage([provider("stalled", async () => new Promise(() => {}))], registry, controller.signal);
  controller.abort();
  await assert.rejects(task, { name: "AbortError" });
  await assert.rejects(collectUsage([], registry, controller.signal), { name: "AbortError" });
});

test("RPC command formats usage without sending a prompt or saving account data", async () => {
  const h = harness([provider("openai")]);
  await h.command.handler("", h.ctx);
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0], /Account: test account/);
  assert.match(h.notifications[0], /Manage usage:/);
  assert.deepEqual(await h.command.getArgumentCompletions?.("op"), [{ value: "openai", label: "openai" }]);
});

test("provider filtering, unknown arguments and no-UI mode do not query unintended providers", async () => {
  const queried: string[] = [];
  const h = harness([provider("one", async () => { queried.push("one"); return snapshot; }), provider("two", async () => { queried.push("two"); return snapshot; })]);
  await h.command.handler(" TWO ", h.ctx);
  assert.deepEqual(queried, ["two"]);
  await h.command.handler("nope", h.ctx);
  await h.command.handler("", { ...h.ctx, hasUI: false, mode: "print" });
  assert.deepEqual(queried, ["two"]);
  assert.match(h.notifications[1], /Usage: \/usage/);
});

test("shutdown cancels active work and does not post a late notification", async () => {
  const h = harness([provider("stalled", async () => new Promise(() => {}))]);
  const task = h.command.handler("", h.ctx);
  await h.command.handler("", h.ctx);
  assert.match(h.notifications[0], /already open/);
  h.notifications.length = 0;
  h.shutdown();
  await task;
  assert.equal(h.notifications.length, 0);
});

test("TUI command selects an overlay and exposes no extra model tools", async () => {
  const h = harness([provider("openai")]);
  let custom = false;
  await h.command.handler("", { ...h.ctx, mode: "tui", ui: { ...h.ctx.ui, custom: async (_factory, options) => {
    custom = true;
    assert.equal(options?.overlay, true);
    assert.deepEqual(options?.overlayOptions, { width: "90%", maxHeight: "85%" });
    return undefined;
  } } } as ExtensionCommandContext);
  assert.equal(custom, true);
});
