import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { Text, visibleWidth, type KeybindingsManager } from "@earendil-works/pi-tui";
import { formatReset, formatUsage, formatWindow, safeText } from "../src/format.ts";
import { UsageView } from "../src/view.ts";
import type { UsageResult } from "../src/types.ts";

const now = Date.UTC(2026, 9, 29, 12);
const result: UsageResult = {
  provider: { id: "openai", label: "OpenAI · ChatGPT", dashboardUrl: "https://chatgpt.com/settings/usage" }, status: "ok",
  snapshot: { account: "user@example.test", plan: "plus", source: "Codex login", fetchedAt: now, notes: ["App caps excluded."], groups: [
    { label: "Account allowance", windows: [{ label: "5 hour limit", remainingPercent: 75, resetsAt: now + 3600_000 }] },
  ] },
};
const theme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text };
const keys = { matches: (input: string, action: string) => ({ "tui.select.cancel": "esc", "tui.select.confirm": "enter", "tui.select.up": "up", "tui.select.down": "down" })[action] === input } as Pick<KeybindingsManager, "matches">;

test("renders Codex-style bars as remaining, not used, and labels account/source", () => {
  const text = formatUsage([result], now);
  assert.match(text, /\[█{15}░{5}\] 75% left/);
  for (const expected of ["Account: user@example.test", "Plan: plus", "Source: Codex login", "Resets in 1h", "Manage usage:"]) assert.ok(text.includes(expected));
  assert.match(formatWindow({ label: "Unknown" }, now).join("\n"), /Not reported/);
  assert.doesNotMatch(formatWindow({ label: "Unknown" }, now).join("\n"), /0%/);
});

test("reset formatting is local with relative duration and does not auto-reset stale data", () => {
  assert.match(formatReset(now + 2 * 86400_000 + 3600_000, now), /^Resets in 2d 1h/);
  assert.equal(formatReset(undefined, now), "Reset time not reported");
  assert.equal(formatReset(now - 1, now), "Reset time passed — refresh to update");
  assert.match(formatReset(now + 1, now), /^Resets in 1m/);
});

test("credits do not invent a currency or balance, and empty windows aren't unlimited", () => {
  for (const [credits, expected] of [
    [{ balance: "12.5" }, "Credits: 12.5"], [{ unlimited: true }, "Credits: Unlimited"],
    [{ hasCredits: false }, "Credits: None"], [{ hasCredits: true }, "Credits: Available (balance not reported)"], [{}, "Credits: Not reported"],
  ] as const) {
    const data: UsageResult = { ...result, status: "ok", snapshot: { ...result.snapshot, groups: [], credits } };
    const text = formatUsage([data], now);
    assert.ok(text.includes(expected));
    assert.match(text, /not necessarily unlimited/);
    assert.doesNotMatch(text, /\$12/);
  }
});

test("terminal escapes, control characters and bidi overrides in provider data are removed", () => {
  const value = "\x1b[31mred\x1b[0m\x1b]52;c;evil\x07\n\r\t\u202eevil";
  const clean = safeText(value);
  assert.doesNotMatch(clean, /[\x00-\x1f\x7f-\x9f\u202e]/);
  assert.ok(safeText("x".repeat(1000)).length <= 240);
  const text = formatUsage([{ provider: { ...result.provider, label: value }, status: "error", message: value }]);
  assert.doesNotMatch(text, /\x1b|\u202e/);
});

test("wrapping fits narrow/wide terminal widths including Unicode account data", () => {
  const text = new Text(formatUsage([{ ...result, status: "ok", snapshot: { ...result.snapshot, account: "測試 👩‍💻 " + "a".repeat(100) } }]), 0, 0);
  for (const width of [10, 20, 40, 80, 120]) for (const line of text.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
});

test("view loads, refreshes, suppresses duplicate fetches, and clears stale data", async () => {
  let loads = 0;
  let resolve!: (results: UsageResult[]) => void;
  const view = new UsageView({ requestRender() {} }, theme, keys, () => {}, async () => {
    loads++;
    return new Promise((done) => { resolve = done; });
  });
  assert.match(view.render(80).join("\n"), /Loading/);
  await tick();
  view.handleInput("r");
  assert.equal(loads, 1);
  resolve([result]);
  await tick();
  assert.match(view.render(80).join("\n"), /75% left/);
  view.handleInput("r");
  assert.doesNotMatch(view.render(80).join("\n"), /75% left/);
  await tick();
  assert.equal(loads, 2);
  resolve([{ provider: result.provider, status: "error", message: "Unavailable now" }]);
  await tick();
  assert.match(view.render(80).join("\n"), /Unavailable now/);
  assert.doesNotMatch(view.render(80).join("\n"), /75% left/);
  view.dispose();
});

test("closing cancels pending work and ignores late results/renders", async () => {
  let signal!: AbortSignal;
  let resolve!: (results: UsageResult[]) => void;
  let renders = 0;
  let closed = 0;
  const view = new UsageView({ requestRender() { renders++; } }, theme, keys, () => { closed++; }, async (s) => {
    signal = s;
    return new Promise((done) => { resolve = done; });
  });
  await tick();
  view.handleInput("esc");
  assert.equal(closed, 1);
  assert.equal(signal.aborted, true);
  const before = renders;
  resolve([result]);
  await tick();
  assert.equal(renders, before);
  view.dispose(); // idempotent
});

test("overlay viewport stays bounded, scrolls to later providers and resizes", async () => {
  const terminal = { rows: 16 };
  const view = new UsageView({ terminal, requestRender() {} }, theme, keys, () => {}, async () => [
    result, { ...result, provider: { ...result.provider, id: "second", label: "Second provider" } },
  ]);
  await tick();
  let lines = view.render(70);
  assert.ok(lines.length <= Math.floor(terminal.rows * 0.85));
  assert.match(lines.at(-1)!, /r refresh/);
  assert.doesNotMatch(lines.join("\n"), /Second provider/);
  for (let i = 0; i < 12; i++) view.handleInput("down");
  lines = view.render(70);
  assert.match(lines.join("\n"), /Second provider/);
  view.handleInput("\x1b[6~");
  assert.match(view.render(70).join("\n"), /Manage usage/);
  terminal.rows = 8;
  lines = view.render(20);
  assert.ok(lines.length <= Math.floor(terminal.rows * 0.85));
  assert.ok(lines.every((line) => visibleWidth(line) <= 20));
  terminal.rows = 3;
  assert.ok(view.render(20).length <= Math.floor(terminal.rows * 0.85));
  view.dispose();
});

test("theme invalidation rebuilds styled text; errors don't expose thrown details", async () => {
  let color = "A";
  const view = new UsageView({ requestRender() {} }, { fg: (_color, text) => `${color}:${text}`, bold: (text) => text }, keys, () => {}, async () => { throw new Error("secret"); });
  await tick();
  assert.match(view.render(80).join("\n"), /Could not load usage/);
  assert.doesNotMatch(view.render(80).join("\n"), /secret/);
  color = "B";
  view.invalidate();
  assert.match(view.render(80).join("\n"), /B:Account usage/);
  for (const width of [12, 30, 80]) for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width);
  view.dispose();
});
