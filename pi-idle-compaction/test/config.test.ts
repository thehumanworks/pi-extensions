import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, readConfig } from "../src/config.ts";

test("defaults work without any settings", () => {
	assert.deepEqual(readConfig({}), { enabled: true, tokenThreshold: 150_000, idleMinutes: 5 });
	assert.deepEqual(readConfig(undefined), DEFAULTS);
});

test("a boolean turns it on or off", () => {
	assert.equal(readConfig({ idleCompaction: false }).enabled, false);
	assert.equal(readConfig({ idleCompaction: true }).enabled, true);
});

test("an object overrides individual values", () => {
	assert.deepEqual(readConfig({ idleCompaction: { tokenThreshold: 200_000 } }), { ...DEFAULTS, tokenThreshold: 200_000 });
	assert.deepEqual(readConfig({ idleCompaction: { idleMinutes: 60, enabled: false } }), { enabled: false, tokenThreshold: 150_000, idleMinutes: 60 });
});

test("invalid values are rejected with the offending key", () => {
	assert.throws(() => readConfig({ idleCompaction: "yes" }), /must be true, false, or an object/);
	assert.throws(() => readConfig({ idleCompaction: { enabled: "no" } }), /enabled must be a boolean/);
	assert.throws(() => readConfig({ idleCompaction: { tokenThreshold: 0 } }), /tokenThreshold/);
	assert.throws(() => readConfig({ idleCompaction: { tokenThreshold: 1.5 } }), /tokenThreshold/);
	assert.throws(() => readConfig({ idleCompaction: { idleMinutes: 0 } }), /idleMinutes/);
	assert.throws(() => readConfig({ idleCompaction: { idleMinutes: "5" } }), /idleMinutes/);
});
