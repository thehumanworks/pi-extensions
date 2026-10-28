import assert from "node:assert/strict";
import { test } from "node:test";

test("assertion must not escape its test", () => {
  assert.rejects(Promise.resolve(), /expected/);
});
