import assert from "node:assert/strict";
import { test } from "node:test";
import { chunks, contextMessages, parseCallId, parseEvent, sessionPayload, sidebandUrl } from "../src/protocol.ts";

test("frameless session payload is not a public realtime session.update", () => {
  assert.deepEqual(sessionPayload("instructions", "sol"), {
    model: "gpt-live-1-codex", instructions: "instructions",
    audio: { output: { voice: "sol" } }, delegation: { type: "client" },
  });
  assert.equal(sidebandUrl("rtc_example"), "wss://api.openai.com/v1/live/rtc_example");
});

test("call IDs only come from valid path segments", () => {
  assert.equal(parseCallId("/v1/live/rtc_example?q=1"), "rtc_example");
  const uuid = "12345678-1234-1234-1234-123456789abc";
  assert.equal(parseCallId(`https://api.openai.com/v1/live/${uuid}`), uuid);
  for (const input of [null, "", "/?rtc_fake", "/rtc_invalid.with.dot", "/garbage"]) {
    assert.throws(() => parseCallId(input));
  }
});

test("parse deltas, canonical turns, client delegations and harmless unknowns", () => {
  const parse = (value: unknown) => parseEvent(JSON.stringify(value));
  assert.deepEqual(parse({ type: "input_transcript.added", item: { id: "a", text: "hello " } }), {
    type: "transcript", role: "user", id: "a", text: "hello ", final: false,
  });
  assert.equal(parse({ type: "output_transcript.added", item: { text: "world" } })?.type, "transcript");
  assert.deepEqual(parse({ type: "turn.done", turn: { id: "t", role: "assistant", transcript: "Hello!" } }), {
    type: "transcript", role: "assistant", id: "t", text: "Hello!", final: true,
  });
  assert.deepEqual(parse({ type: "delegation.created", item: {
    id: "d", type: "delegation", target: "client",
    content: [{ type: "input_text", text: "fix it" }, null, { type: "other", text: "ignore" }],
  } }), { type: "delegation", id: "d", text: "fix it" });
  for (const value of ["null", "[]", "{", '{"type":"turn.done","turn":{"role":"tool","transcript":"x"}}']) {
    assert.equal(parseEvent(value), undefined);
  }
  assert.equal(parse({ type: "output_audio.delta", audio: "pcm" }), undefined);
  assert.equal(parse({ type: "new.future.event" }), undefined);
  assert.deepEqual(parse({ type: "error", error: { message: "sensitive" } }), { type: "error" });
});

test("500-byte Unicode-safe appends preserve all text, order, channel and delegation", () => {
  const text = "hello 🦊 café 你好 ".repeat(200);
  const parts = chunks(text);
  assert.equal(parts.join(""), text);
  for (const part of parts) {
    assert.ok(Buffer.byteLength(part) <= 500);
    assert.equal(Buffer.from(part).toString(), part);
  }
  const messages = contextMessages(text, "commentary", "d1");
  assert.equal(messages.map(message => "content" in message ? message.content[0]!.text : "").join(""), text);
  for (const message of messages) {
    assert.equal(message.type, "delegation.context.append");
    assert.ok("channel" in message && message.channel === "commentary" && message.delegation_item_id === "d1");
  }
  assert.equal(contextMessages("hi", "speakable")[0]?.type, "session.context.append");
  assert.deepEqual(chunks(""), []);
  assert.throws(() => chunks("x", 2));
});
