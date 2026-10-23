import assert from "node:assert/strict";
import { test } from "node:test";
import { Transcripts } from "../src/transcripts.ts";
import { safeText, rms } from "../src/text.ts";

test("whitespace and repeated deltas are retained; final transcript is authoritative", () => {
  const t = new Transcripts();
  t.accept("user", "ha", false);
  assert.equal(t.accept("user", "ha ", false)?.text, "haha ");
  assert.equal(t.accept("user", "ha", false)?.text, "haha ha");
  assert.deepEqual(t.accept("user", "Ha ha.", true, "turn1"), {
    role: "user", turn: 1, text: "Ha ha.", final: true,
  });
  assert.equal(t.accept("user", "Ha ha.", true, "turn1"), undefined);
  assert.equal(t.accept("user", "ha", false)?.turn, 2);
  assert.equal(t.accept("user", "Ha ha.", true, "turn2")?.turn, 2);
});

test("role buffers are independent and unfinished turns flush exactly once", () => {
  const t = new Transcripts();
  t.accept("user", "I was saying", false);
  t.accept("assistant", "Sure", false);
  assert.deepEqual(t.flush().map(t => [t.role, t.text, t.interrupted]), [
    ["user", "I was saying", true], ["assistant", "Sure", true],
  ]);
  assert.deepEqual(t.flush(), []);
});

test("sanitize terminal control/OSC injection and handle audio silence safely", () => {
  assert.equal(safeText("\x1b[31mred\x1b[0m\x00\x1b]0;evil\x07"), "red");
  assert.equal(safeText("a\u202eb"), "ab");
  assert.equal(rms(new Float32Array()), 0);
  assert.equal(rms(new Float32Array([NaN])), 0);
  assert.equal(rms(new Float32Array([0.5, -0.5])), 0.5);
});
