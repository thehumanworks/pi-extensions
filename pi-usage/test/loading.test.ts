import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("real Pi loader accepts /usage without load-time auth or network activity", async () => {
  const { loadExtensions } = await import(new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("Unexpected load-time request"); };
  try {
    const loaded = await loadExtensions([fileURLToPath(new URL("../index.ts", import.meta.url))], process.cwd());
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.ok(loaded.extensions[0].commands.has("usage"));
    assert.ok(loaded.extensions[0].handlers.has("session_shutdown"));
    assert.equal(loaded.extensions[0].tools.size, 0);
    assert.equal(fetches, 0);
  } finally { globalThis.fetch = original; }
});
