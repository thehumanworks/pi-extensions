import assert from "node:assert/strict";
import { test } from "node:test";
import { DictationSession, encodeWav, SAMPLE_RATE, toPcm16, transcribe, TRANSCRIBE_URL } from "../src/dictation.ts";
import type { NativeAudio } from "../src/native.ts";

const auth = async () => ({ accessToken: "test-token", accountId: "test-account" });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

function capture() {
  let callback: ((error: Error | null, samples: Float32Array) => void) | undefined;
  let opens = 0, stops = 0;
  const native = {
    AudioCapture: class {
      constructor(rate: number, cb: typeof callback) { assert.equal(rate, SAMPLE_RATE); callback = cb; opens++; }
      stop() { stops++; callback = undefined; }
    },
  } as unknown as Pick<NativeAudio, "AudioCapture">;
  return { native, emit: (samples: Float32Array) => callback?.(null, samples), fail: () => callback?.(new Error("x"), new Float32Array()), counts: () => ({ opens, stops }) };
}

test("WAV encoding is 16 kHz mono PCM16 with clamped samples", () => {
  const pcm = toPcm16(new Float32Array([0, 1, -1, 2, Number.NaN]));
  assert.deepEqual([...pcm], [0, 32767, -32768, 32767, 0]);
  const wav = Buffer.from(encodeWav([pcm]));
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt32LE(40), 10);
  assert.equal(wav.length, 54);
});

test("transcription uses the ChatGPT login, multipart audio, and never leaks bodies", async () => {
  let seen: RequestInit | undefined;
  const text = await transcribe(auth, encodeWav([new Int16Array(10)]), new AbortController().signal, async (url, init) => {
    assert.equal(url, TRANSCRIBE_URL);
    seen = init;
    return Response.json({ text: " Add a test.\u001b[31m ", asset_pointer: "sediment://x" });
  });
  assert.equal(text, "Add a test.");
  const headers = seen!.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer test-token");
  assert.equal(headers["ChatGPT-Account-ID"], "test-account");
  const file = (seen!.body as FormData).get("file") as File;
  assert.equal(file.type, "audio/wav");
  for (const status of [401, 403, 413, 429, 500]) {
    await assert.rejects(
      transcribe(auth, encodeWav([]), new AbortController().signal, async () => new Response("SECRET", { status })),
      (error: Error) => {
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.ok(!error.message.includes("SECRET"));
        if (status === 401) assert.match(error.message, /\/login openai-codex/);
        return true;
      });
  }
  await assert.rejects(transcribe(auth, encodeWav([]), new AbortController().signal, async () => Response.json({ nope: 1 })),
    /invalid response/);
});

test("401 retries once only with a changed credential", async () => {
  const tokens = ["old", "new"];
  const used: string[] = [];
  const text = await transcribe(async () => ({ accessToken: tokens.shift() ?? "new", accountId: "a" }), encodeWav([]),
    new AbortController().signal, async (_url, init) => {
      const token = (init?.headers as Record<string, string>).Authorization;
      used.push(token ?? "");
      return token === "Bearer old" ? new Response("", { status: 401 }) : Response.json({ text: "ok" });
    });
  assert.equal(text, "ok");
  assert.deepEqual(used, ["Bearer old", "Bearer new"]);
});

test("push-to-talk opens the mic only while recording and returns text", async () => {
  const c = capture(), texts: string[] = [], notices: string[] = [], failures: Error[] = [];
  let uploaded = 0;
  const session = new DictationSession({
    auth, onText: text => texts.push(text), onNotice: m => notices.push(m), onFailure: e => failures.push(e),
  }, { native: () => c.native, fetch: async (_url, init) => {
    uploaded = ((init?.body as FormData).get("file") as File).size;
    return Response.json({ text: "hello world" });
  } });
  assert.equal(c.counts().opens, 0);
  session.toggle();
  assert.equal(session.state.phase, "recording");
  c.emit(new Float32Array(SAMPLE_RATE).fill(0.2));
  assert.ok(session.state.inputLevel > 0.1);
  session.toggle();
  assert.equal(c.counts().stops, 1);
  assert.equal(session.state.phase, "transcribing");
  session.toggle(); // Ignored while transcribing.
  assert.equal(c.counts().opens, 1);
  await tick();
  assert.deepEqual(texts, ["hello world"]);
  assert.equal(uploaded, 44 + SAMPLE_RATE * 2);
  assert.equal(session.state.phase, "ready");
  // Too short: nothing is uploaded.
  session.toggle(); c.emit(new Float32Array(100)); session.toggle();
  assert.equal(session.state.phase, "ready");
  assert.match(notices.at(-1)!, /Nothing recorded/);
  // Capture failures are reported and release the mic.
  session.toggle(); c.fail();
  assert.equal(failures.length, 1);
  assert.equal(session.state.phase, "ready");
  assert.equal(c.counts().stops, 3);
  await session.stop();
  assert.equal(session.state.phase, "off");
});

test("stop cancels an in-flight transcription without delivering text", async () => {
  const c = capture(), texts: string[] = [], failures: Error[] = [];
  const session = new DictationSession({ auth, onText: t => texts.push(t), onNotice() {}, onFailure: e => failures.push(e) }, {
    native: () => c.native,
    fetch: (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  session.toggle(); c.emit(new Float32Array(SAMPLE_RATE)); session.toggle();
  await session.stop();
  await tick();
  assert.deepEqual(texts, []);
  assert.deepEqual(failures, []);
});
