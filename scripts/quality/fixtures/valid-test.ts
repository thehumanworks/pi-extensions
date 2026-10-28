import assert from "node:assert/strict";
import { test } from "node:test";

// Node's test runner owns registered tests; assertions still must be awaited.
test("registered test", async () => {
  await assert.rejects(Promise.reject(new Error("expected")), /expected/);
});
