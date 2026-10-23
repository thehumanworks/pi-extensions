import { test } from "node:test";
import assert from "node:assert/strict";
import { intervalMs, nextDue, parseLoop, validateRequest } from "../src/protocol.ts";

test("intervals support seconds through weeks, fractions, and long timer delays", () => {
  assert.equal(intervalMs("5m"), 300_000);
  assert.equal(intervalMs(" 1.5H "), 5_400_000);
  assert.equal(intervalMs("30d"), 2_592_000_000);
  assert.equal(intervalMs("1w"), 604_800_000);
  for (const bad of ["0s", "-1m", "0.01s", "5", "daily", "Infinityh", "366d", "1e3s", "5m task"])
    assert.throws(() => intervalMs(bad));
});
test("parse preserves multiline task text", () => {
  assert.deepEqual(parseLoop("  5m Check build\nwithout changing files.  "),
    { frequency: "5m", task: "Check build\nwithout changing files." });
  assert.throws(() => parseLoop("5m"));
});
test("missed ticks coalesce, next tick is strictly in the future", () => {
  assert.equal(nextDue(1000, 1000, 1000), 2000);
  assert.equal(nextDue(1000, 1000, 1700), 2000);
  assert.equal(nextDue(1000, 1000, 4000), 5000);
});
test("wire requests are validated independently of the extension", () => {
  for (const value of [null, {}, { action: "nope" }, { action: "pause" }, { action: "create" }])
    assert.throws(() => validateRequest(value));
  assert.deepEqual(validateRequest({ action: "list", unexpected: 1 }), { action: "list" });
});
