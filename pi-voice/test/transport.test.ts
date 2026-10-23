import assert from "node:assert/strict";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import type { NativeAudio } from "../src/native.ts";
import type { ServerEvent } from "../src/protocol.ts";
import { SIGNALING_URL } from "../src/protocol.ts";
import { abortable, ChatGPTVoiceTransport, type TransportOptions } from "../src/transport.ts";

function nativeFixture() {
  let events!: (error: Error | null, value: string) => void;
  let closes = 0, pushes = 0, muted = false;
  const native = {
    LiveWebRtcPeer: class {
      constructor(event: typeof events) { events = event; }
      async createOffer() { return "test-sdp-offer"; }
      async acceptAnswer(sdp: string) { assert.equal(sdp, "test-sdp-answer"); }
      async waitForOpen() {}
      pushAudio() { pushes++; }
      setMuted(value: boolean) { muted = value; }
      async close() { closes++; }
    },
  } as unknown as NativeAudio;
  return { native, get events() { return events; }, counts: () => ({ closes, pushes, muted }) };
}
function options(events: ServerEvent[], failures: Error[]): TransportOptions {
  return {
    auth: async () => ({ accessToken: "test-token", accountId: "test-account" }),
    sessionId: "pi-test", instructions: "test instructions", voice: "sol",
    onEvent: event => events.push(event), onOutputLevel() {}, onFailure: error => failures.push(error),
  };
}

test("signaling and authenticated sideband carry real v3 messages with native media", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const n = nativeFixture(), events: ServerEvent[] = [], failures: Error[] = [], messages: string[] = [];
  let remote: WebSocket | undefined;
  server.on("connection", socket => {
    remote = socket;
    socket.on("message", data => messages.push(data.toString()));
  });
  const transport = new ChatGPTVoiceTransport(options(events, failures), {
    native: () => n.native,
    fetch: async (url, init) => {
      assert.equal(url, SIGNALING_URL);
      assert.equal(init?.method, "POST");
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer test-token");
      assert.equal(headers["ChatGPT-Account-ID"], "test-account");
      assert.equal(headers["OpenAI-Alpha"], "quicksilver=v2");
      const body = JSON.parse(init?.body as string);
      assert.equal(body.sdp, "test-sdp-offer");
      assert.equal(body.session.model, "gpt-live-1-codex");
      assert.equal(body.session.delegation.type, "client");
      assert.ok(!JSON.stringify(body).includes("test-token"));
      return new Response("test-sdp-answer", { headers: { location: "/v1/live/rtc_test" } });
    },
    socket: (url, headers) => {
      assert.equal(url, "wss://api.openai.com/v1/live/rtc_test");
      assert.equal(headers.Authorization, "Bearer test-token");
      return new WebSocket(`ws://127.0.0.1:${address.port}`);
    },
  });
  try {
    await transport.connect();
    transport.pushAudio(new Float32Array([0.1]));
    transport.setMuted(true);
    transport.pushAudio(new Float32Array([0.1]));
    assert.deepEqual(n.counts(), { closes: 0, pushes: 1, muted: true });
    remote!.send(JSON.stringify({ type: "turn.done", turn: { id: "t", role: "user", transcript: "Hello" } }));
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(events.at(-1)?.type, "transcript");
    n.events(null, JSON.stringify({ type: "input_transcript.added", item: { text: "duplicate-channel" } }));
    assert.equal(events.length, 1);
    await transport.send({ type: "session.context.append", channel: "commentary", content: [{ type: "input_text", text: "progress" }] });
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.match(messages[0]!, /commentary/);
    // Errors on the media data channel must not be discarded after sideband opens.
    n.events(null, JSON.stringify({ type: "error", message: "SECRET SDP" }));
    await transport.close();
    assert.equal(failures.length, 1);
    assert.ok(!failures[0]!.message.includes("SECRET"));
    assert.equal(n.counts().closes, 1);
    await assert.rejects(transport.send({ type: "session.close" }), /not connected/);
  } finally {
    await transport.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("HTTP authorization errors are actionable and never leak raw server bodies", async () => {
  for (const status of [401, 403, 429, 500]) {
    const n = nativeFixture();
    const transport = new ChatGPTVoiceTransport(options([], []), {
      native: () => n.native,
      fetch: async () => new Response("SECRET access_token=bad", { status }),
      socket: () => { throw new Error("should not open"); },
    });
    await assert.rejects(transport.connect(), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!error.message.includes("SECRET"));
      if (status === 401) assert.match(error.message, /\/login openai-codex/);
      return true;
    });
    assert.equal(n.counts().closes, 1);
  }
});

test("401 re-reads the Pi credential and retries once only when the token changed", async () => {
  for (const rotated of [true, false]) {
    const n = nativeFixture(), o = options([], []), tokens: string[] = [];
    let resolves = 0;
    o.auth = async () => ({ accessToken: rotated && resolves++ > 0 ? "rotated-token" : "stale-token", accountId: "acct" });
    const transport = new ChatGPTVoiceTransport(o, {
      native: () => n.native,
      fetch: async (_url, init) => {
        const token = (init?.headers as Record<string, string>).Authorization!;
        tokens.push(token);
        return token === "Bearer rotated-token"
          ? new Response("test-sdp-answer", { headers: { location: "/v1/live/rtc_retry" } })
          : new Response("SECRET", { status: 401 });
      },
      socket: () => { throw new Error("stop after signaling"); },
    });
    await assert.rejects(transport.connect(), rotated ? /stop after signaling/ : /HTTP 401/);
    assert.deepEqual(tokens, rotated ? ["Bearer stale-token", "Bearer rotated-token"] : ["Bearer stale-token"]);
    await transport.close();
  }
});

test("authentication must succeed before native peer is loaded; close cancels pending auth", async () => {
  let loads = 0;
  const o = options([], []);
  o.auth = () => new Promise(() => {});
  const transport = new ChatGPTVoiceTransport(o, {
    native: () => { loads++; throw new Error("should not load"); },
    fetch: async () => { throw new Error("should not fetch"); },
    socket: () => { throw new Error("should not connect"); },
  });
  const connecting = transport.connect();
  await setImmediate();
  await transport.close();
  await assert.rejects(connecting, /cancelled/);
  assert.equal(loads, 0);
  await assert.rejects(transport.connect(), /closed/);
});

test("abort helper observes late native rejection after cancellation", async () => {
  const abort = new AbortController();
  let reject!: (error: Error) => void;
  const operation = new Promise<void>((_resolve, r) => { reject = r; });
  const result = abortable(operation, abort.signal);
  abort.abort();
  await assert.rejects(result, /cancelled/);
  reject(new Error("late"));
  await setImmediate();
});
