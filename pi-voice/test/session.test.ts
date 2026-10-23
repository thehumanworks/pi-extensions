import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { VoiceSession, type SessionOptions } from "../src/session.ts";
import type { NativeAudio } from "../src/native.ts";
import type { ClientMessage } from "../src/protocol.ts";
import type { Transcript } from "../src/transcripts.ts";
import type { TransportOptions } from "../src/transport.ts";

function fixture(wait?: Promise<void>) {
  let callbacks!: TransportOptions;
  let mic!: (error: Error | null, samples: Float32Array) => void;
  let captures = 0, stops = 0, closes = 0, pushes = 0, mute = false;
  const sent: ClientMessage[] = [], transcripts: Transcript[] = [], delegated: string[] = [], failures: Error[] = [];
  const options: SessionOptions = {
    auth: async () => ({ accessToken: "test", accountId: "acct" }), sessionId: "session", voice: "sol",
    onTranscript: value => transcripts.push(value),
    onDelegate: id => delegated.push(id), onFailure: error => failures.push(error),
  };
  const native = {
    AudioCapture: class {
      constructor(_rate: number, cb: typeof mic) { captures++; mic = cb; }
      stop() { stops++; }
    },
  } as unknown as NativeAudio;
  const session = new VoiceSession(options, {
    native: () => native,
    transport: cb => {
      callbacks = cb;
      return {
        connect: async () => { await wait; }, close: async () => { closes++; },
        send: async message => { sent.push(message); },
        pushAudio: () => { pushes++; }, setMuted: value => { mute = value; },
      };
    },
  });
  return { session, sent, transcripts, delegated, failures,
    get callbacks() { return callbacks; },
    audio: (value: number) => mic(null, new Float32Array([value, value])),
    counts: () => ({ captures, stops, closes, pushes, mute }),
  };
}

test("capture begins only after connect; mute blocks transmission but not playback", async () => {
  const f = fixture();
  await f.session.start();
  assert.equal(f.counts().captures, 1);
  f.audio(0.1);
  assert.equal(f.counts().pushes, 1);
  f.session.toggleMute();
  f.audio(0.8);
  f.callbacks.onOutputLevel(0.3);
  assert.equal(f.counts().pushes, 1);
  assert.equal(f.counts().mute, true);
  assert.equal(f.session.state.inputLevel, 0);
  assert.equal(f.session.state.outputLevel, 0.3);
  assert.equal(f.session.state.phase, "muted");
  f.session.toggleMute();
  f.audio(0.01); // quiet speaker leakage is gated
  assert.equal(f.counts().pushes, 1);
  f.audio(0.4); // louder speech can barge in
  assert.equal(f.counts().pushes, 2);
  f.session.tick(Date.now() + 1000);
  assert.equal(f.session.state.outputLevel, 0);
  await f.session.stop(); await f.session.stop();
  assert.equal(f.counts().stops, 1);
  assert.equal(f.counts().closes, 1);
  assert.equal(f.session.state.phase, "off");
});

test("off while connecting never opens the microphone afterward", async () => {
  let resolve!: () => void;
  const wait = new Promise<void>(r => { resolve = r; });
  const f = fixture(wait);
  const starting = f.session.start();
  await f.session.stop();
  resolve(); await starting;
  assert.equal(f.counts().captures, 0);
  assert.equal(f.counts().closes, 1);
});

test("only delegations launch work, duplicates ignored, progress silent and settled final speakable", async () => {
  const f = fixture(); await f.session.start();
  f.callbacks.onEvent({ type: "transcript", role: "user", text: "Fix ", final: false });
  f.callbacks.onEvent({ type: "transcript", role: "user", text: "it", final: false });
  assert.deepEqual(f.delegated, []);
  f.callbacks.onEvent({ type: "transcript", role: "user", text: "Fix it.", final: true, id: "t" });
  const delegation = { type: "delegation" as const, id: "d", text: "Fix it." };
  f.callbacks.onEvent(delegation); f.callbacks.onEvent(delegation);
  assert.deepEqual(f.delegated, ["d"]);
  f.session.backendDelegationStarted("d");
  f.session.backendMessage("Investigating", true);
  f.session.backendMessage("not final until settled", false);
  await setImmediate();
  assert.equal(f.sent.length, 1);
  assert.ok("channel" in f.sent[0]! && f.sent[0].channel === "commentary");
  f.session.backendMessage("Fixed. Tests passed.", false);
  f.session.backendSettled(false); await setImmediate();
  const final = f.sent.at(-1)!;
  assert.ok("channel" in final && final.channel === "speakable");
  assert.ok("content" in final && final.content[0]!.text.includes("Fixed. Tests passed."));
  assert.equal(f.transcripts.at(-1)?.text, "Fix it.");
  await f.session.stop();
});

test("a pending new delegation cannot be consumed by an old run's settlement", async () => {
  const f = fixture(); await f.session.start();
  f.callbacks.onEvent({ type: "delegation", id: "old", text: "Old task" });
  f.session.backendDelegationStarted("old");
  f.session.backendMessage("Old final", false);
  f.callbacks.onEvent({ type: "delegation", id: "new", text: "New task" });
  f.session.backendSettled(false); await setImmediate();
  assert.equal(f.sent.length, 0);
  f.session.backendDelegationStarted("new");
  f.session.backendMessage("New final", false);
  f.session.backendSettled(false); await setImmediate();
  assert.ok(f.sent.every(m => "delegation_item_id" in m && m.delegation_item_id === "new"));
  assert.equal(f.session.state.phase, "listening");
  await f.session.stop();
});

test("interrupts are reported honestly, speech context bounded, partial transcripts flushed once", async () => {
  const f = fixture(); await f.session.start();
  f.callbacks.onEvent({ type: "delegation", id: "d", text: "Work" });
  f.session.backendDelegationStarted("d");
  f.session.backendMessage("🦊".repeat(10000), false);
  f.session.backendSettled(false); await setImmediate();
  const text = f.sent.flatMap(m => "content" in m ? m.content.map(c => c.text) : []).join("");
  assert.ok(Buffer.byteLength(text) < 4100);
  assert.match(text, /written chat/);
  f.sent.length = 0;
  f.callbacks.onEvent({ type: "delegation", id: "d2", text: "Work" });
  f.session.backendDelegationStarted("d2");
  f.session.backendSettled(true); await setImmediate();
  assert.match(JSON.stringify(f.sent), /interrupted/);
  f.callbacks.onEvent({ type: "transcript", role: "assistant", text: "unfinished", final: false });
  await f.session.stop(); await f.session.stop();
  assert.equal(f.transcripts.filter(t => t.final && t.interrupted).length, 1);
});

test("fatal asynchronous errors terminate once and release capture", async () => {
  const f = fixture(); await f.session.start();
  f.callbacks.onFailure(new Error("connection lost"));
  f.callbacks.onFailure(new Error("again"));
  await f.session.stop();
  assert.equal(f.failures.length, 1);
  assert.equal(f.counts().stops, 1);
});
