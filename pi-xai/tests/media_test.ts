import test from "node:test";
import { assert, assertEquals, assertRejects } from "./assert.ts";
import { BinaryResponse, SpaceXAI } from "@xai-official/sdk";
import { createImagesModule } from "../src/image.ts";
import { createVideosModule } from "../src/video.ts";
import { createVoiceModule } from "../src/tts.ts";

interface CapturedRequest {
  path: string;
  init: RequestInit;
}
function fixture(
  handler: (request: CapturedRequest) => Response | Promise<Response>,
) {
  const calls: CapturedRequest[] = [];
  const client = new SpaceXAI({
    apiKey: "mock-key",
    baseURL: "https://mock.invalid/v1",
    maxRetries: 0,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const sent = input instanceof Request ? input : new Request(input, init);
      const contentType = sent.headers.get("content-type") ?? "";
      const request = {
        path: new URL(sent.url).pathname,
        init: {
          method: sent.method,
          headers: sent.headers,
          signal: sent.signal,
          body:
            sent.body === null
              ? undefined
              : contentType.startsWith("multipart/form-data")
                ? await sent.formData()
                : await sent.text(),
        },
      };
      calls.push(request);
      return await handler(request);
    }) as typeof fetch,
  });
  return { context: { getClient: () => Promise.resolve(client) }, calls };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": "mock-request",
    },
  });
}
function body(call: CapturedRequest): Record<string, unknown> {
  return JSON.parse(call.init.body as string);
}
const encodedImage = {
  data: "AQID",
  encoding: "base64" as const,
  mime_type: "image/png",
  filename: "reference.png",
};
const encodedAudio = {
  data: "audio",
  encoding: "utf8" as const,
  mime_type: "audio/wav",
  filename: "reference.wav",
};

test("images preserve all results, SDK fields, metadata, and reference payloads", async () => {
  const { context, calls } = fixture(() =>
    json({
      data: [{ url: "one" }, { b64_json: "two" }],
      usage: { cost_in_usd_ticks: 5000000000 },
    }),
  );
  const images = createImagesModule(context);
  const generated = await images.generate({
    model: "future-image",
    prompt: "hello",
    n: 2,
    quality: null,
    resolution: null,
    user: null,
    response_format: null,
    future_option: "keep",
    request: { headers: { "x-test": "forward" } },
  });
  assertEquals(generated.data.length, 2);
  assertEquals(generated.usage?.cost_usd, 0.5);
  assertEquals(generated.http.status, 200);
  assertEquals(new Headers(calls[0].init.headers).get("x-test"), "forward");
  assertEquals(body(calls[0]).future_option, "keep");
  assertEquals(body(calls[0]).quality, null);
  assert(!("request" in body(calls[0])));
  await images.edit({
    model: "future-image",
    prompt: "edit",
    images: [
      encodedImage,
      { file_id: "file-one" },
      {
        url: "https://example.invalid/image.png",
      },
    ],
  });
  assertEquals(body(calls[1]).images, [
    { url: "data:image/png;base64,AQID" },
    {
      file_id: "file-one",
    },
    { url: "https://example.invalid/image.png" },
  ]);
  await images.edit({
    model: "future-image",
    prompt: "edit",
    image: { url: "image" },
  });
  assertEquals(body(calls[2]).image, { url: "image" });
  await assertRejects(() =>
    images.edit({
      model: "m",
      prompt: "p",
      image: { url: "one" },
      images: [{ url: "two" }],
    }),
  );
  await assertRejects(() => images.edit({ model: "m", prompt: "p" }));
});

test("videos forward every generation reference, edit/extend fields, and lifecycle results", async () => {
  let polls = 0;
  const { context, calls } = fixture((call) =>
    call.init.method === "GET"
      ? json(
          ++polls === 1
            ? { status: "pending", progress: 20 }
            : {
                status: "done",
                video: { url: "done.mp4" },
                usage: { cost_in_usd_ticks: 10000000000 },
              },
        )
      : json({ request_id: "video/request" }),
  );
  const videos = createVideosModule(context);
  const started = await videos.generate({
    model: "future-video",
    image: encodedImage,
    reference_images: [{ file_id: "image-ref" }],
    reference_audios: [{ voice_id: "future-voice", url: null }],
    keyframes: [{ image: encodedImage, timestamp_s: 3 }],
    duration: null,
    output: null,
    storage_options: {
      filename: "movie.mp4",
      expires_after: null,
      public_url: null,
    },
  });
  assertEquals(started.request_id, "video/request");
  assertEquals(body(calls[0]).image, { url: "data:image/png;base64,AQID" });
  assertEquals(body(calls[0]).keyframes, [
    {
      image: { url: "data:image/png;base64,AQID" },
      timestamp_s: 3,
    },
  ]);
  assertEquals(body(calls[0]).reference_audios, [
    {
      voice_id: "future-voice",
      url: null,
    },
  ]);
  await videos.edit({
    model: "future-video",
    prompt: "edit",
    video: { file_id: "video-id" },
    output: { upload_url: "https://upload.invalid" },
    user: null,
  });
  await videos.extend({
    model: "future-video",
    prompt: "continue",
    video: { data: "AQID", mime_type: "video/mp4" },
    duration: null,
  });
  assertEquals(calls[1].path, "/v1/videos/edits");
  assertEquals(body(calls[1]).video, { file_id: "video-id" });
  assertEquals(calls[2].path, "/v1/videos/extensions");
  assertEquals(body(calls[2]).video, { url: "data:video/mp4;base64,AQID" });
  assertEquals(
    (await videos.get({ request_id: started.request_id })).status,
    "pending",
  );
  const done = await videos.wait({
    request_id: started.request_id,
    interval: 0,
    timeout: 1000,
  });
  assertEquals(done.status, "done");
  assertEquals(done.usage?.cost_usd, 1);
  assertEquals(calls[3].path, "/v1/videos/video%2Frequest");
});

test("voice speak returns native binary and complete timestamp responses", async () => {
  const { context, calls } = fixture((call) =>
    body(call).with_timestamps
      ? json({
          audio: "AQID",
          content_type: "audio/mp3",
          duration: 1,
          audio_timestamps: { graph_chars: ["a"], graph_times: [[0, 1]] },
        })
      : new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "audio/mpeg" },
        }),
  );
  const voice = createVoiceModule(context);
  const binary = await voice.speak({
    text: "Hello",
    language: "auto",
    voice_id: "custom-future",
    output_format: { codec: "mp3", bit_rate: null },
    speed: 1.1,
    replace: { hi: "hello" },
    text_normalization: false,
  });
  assert(binary instanceof BinaryResponse);
  assertEquals(await binary.bytes(), new Uint8Array([1, 2, 3]));
  assertEquals(binary.contentType, "audio/mpeg");
  const timed = await voice.speak({
    text: "a",
    language: "en",
    with_timestamps: true,
  });
  assert(!(timed instanceof BinaryResponse));
  assertEquals(timed.audio_timestamps?.graph_times, [[0, 1]]);
  assertEquals(timed.http.status, 200);
  assertEquals(body(calls[0]).replace, { hi: "hello" });
});

test("voice transcription and custom creation retain multipart bytes, labels, repeated fields", async () => {
  const { context, calls } = fixture((call) =>
    call.path.endsWith("/stt")
      ? json({
          text: "hello",
          language: "en",
          duration: 1,
          words: [{ text: "hello", start: 0, end: 1 }],
          channels: [{ index: 0, text: "hello" }],
        })
      : json({ voice_id: "custom", created_at: "now" }),
  );
  const voice = createVoiceModule(context);
  const transcribed = await voice.transcribe({
    file: encodedAudio,
    model: "future-transcriber",
    audio_format: "wav",
    sample_rate: 48000,
    language: "en",
    keyterm: ["one", "two"],
    diarize: true,
    multichannel: true,
  });
  assertEquals(transcribed.words?.length, 1);
  assertEquals(transcribed.channels?.[0].text, "hello");
  const form = calls[0].init.body as FormData;
  assertEquals(form.getAll("keyterm"), ["one", "two"]);
  assertEquals(await (form.get("file") as File).text(), "audio");
  assertEquals((form.get("file") as File).name, "reference.wav");
  assertEquals([...form.keys()].at(-1), "file");
  await voice.transcribe({
    url: "https://audio.invalid/reference.wav",
    format: true,
    language: "en",
  });
  assertEquals(
    (calls[1].init.body as FormData).get("url"),
    "https://audio.invalid/reference.wav",
  );
  await voice.customCreate({
    file: encodedAudio,
    name: "My voice",
    gender: "neutral",
    tone: "warm",
  });
  const custom = calls[2].init.body as FormData;
  assertEquals(custom.get("name"), "My voice");
  assertEquals(await (custom.get("file") as File).text(), "audio");
  await assertRejects(() =>
    voice.transcribe({ file: encodedAudio, url: "https://audio.invalid" }),
  );
  await assertRejects(() => voice.transcribe({}));
});

test("voice management, custom audio, client secrets, and speech helpers are exposed", async () => {
  const { context, calls } = fixture((call) => {
    if (call.path.endsWith("/audio")) {
      return new Response("reference audio", {
        headers: { "content-type": "audio/wav" },
      });
    }
    if (call.path.endsWith("/client_secrets")) {
      return json({ value: "mock-secret", expires_at: 123 });
    }
    if (call.init.method === "DELETE") return json({ deleted: true });
    if (call.path.endsWith("/voices") || call.path.endsWith("/custom-voices")) {
      return json({
        voices: [{ voice_id: "voice" }],
        pagination_token: "next",
      });
    }
    return json({ voice_id: "voice", created_at: "now", name: null });
  });
  const voice = createVoiceModule(context);
  assertEquals((await voice.list({})).voices.length, 1);
  assertEquals((await voice.get({ voice_id: "eve" })).voice_id, "voice");
  assertEquals(
    (await voice.customList({ limit: 2, pagination_token: "old" }))
      .pagination_token,
    "next",
  );
  await voice.customGet({ voice_id: "custom/id" });
  await voice.customUpdate({
    voice_id: "custom/id",
    name: null,
    tone: "calm",
    future_label: "yes",
  });
  assertEquals(body(calls[4]), {
    name: null,
    tone: "calm",
    future_label: "yes",
  });
  assertEquals(
    (await voice.customDelete({ voice_id: "custom/id" })).deleted,
    true,
  );
  assertEquals(
    await (await voice.customGetAudio({ voice_id: "custom/id" })).text(),
    "reference audio",
  );
  const secret = await voice.clientSecretsCreate({
    expires_after: { seconds: 60 },
    session: { model: "future-realtime", reasoning: { effort: "none" } },
  });
  assertEquals(secret.expires_at, 123);
  assertEquals(body(calls[7]).session, {
    model: "future-realtime",
    reasoning: { effort: "none" },
  });
  assert((await voice.speechTags({})).inline.includes("pause"));
  assertEquals(
    await voice.checkSpeechText({ text: "[pause] Hello <soft>there</soft>" }),
    [],
  );
  assert((await voice.checkSpeechText({ text: "[unknown] Hello" })).length > 0);
  assertEquals(
    await voice.stripInvalidSpeechTags({ text: "[unknown] Hello" }),
    " Hello",
  );
});

test("media and voice forward cancellation without starting aborted requests", async () => {
  const { context, calls } = fixture(() =>
    json({ data: [], request_id: "r", text: "t" }),
  );
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const callContext = { signal: controller.signal };
  await assertRejects(() =>
    createImagesModule(context).generate(
      { model: "m", prompt: "p" },
      callContext,
    ),
  );
  await assertRejects(() =>
    createVideosModule(context).generate({ model: "m" }, callContext),
  );
  await assertRejects(() =>
    createVideosModule(context).wait(
      { request_id: "r", interval: 0 },
      callContext,
    ),
  );
  await assertRejects(() =>
    createVoiceModule(context).transcribe({ file: encodedAudio }, callContext),
  );
  assertEquals(calls.length, 0);
});

test("video polling retains pending and failed outcomes and respects timeout", async () => {
  let polls = 0;
  const pending = fixture(() => new Response(null, { status: 202 }));
  const videos = createVideosModule(pending.context);
  const result = await videos.get({ request_id: "empty-pending" });
  assertEquals(result.status, "pending");
  assertEquals(result.usage, null);
  await assertRejects(() =>
    videos.wait({ request_id: "empty-pending", interval: 1, timeout: 10 }),
  );
  const failed = fixture(() =>
    json(
      ++polls === 1
        ? { status: "pending" }
        : { status: "failed", error: { message: "rejected" } },
    ),
  );
  const terminal = await createVideosModule(failed.context).wait({
    request_id: "failed",
    interval: 0,
    timeout: 1000,
  });
  assertEquals(terminal.status, "failed");
  assertEquals(terminal.error?.message, "rejected");
  assertEquals(polls, 2);
});

test("media tools expose JSON schemas and serialize binary audio and HTTP headers", async () => {
  const { context } = fixture(
    () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "content-type": "audio/mpeg",
          "x-request-id": "tool-request",
        },
      }),
  );
  const voice = createVoiceModule(context);
  const speech = voice.tools.find((tool) => tool.name === "xai_voice_speak")!;
  assertEquals(speech.parameters.type, "object");
  const serialized = (await speech.execute({
    text: "Hello",
    language: "en",
  })) as {
    data: string;
    encoding: string;
    mime_type: string;
    byte_length: number;
    http: { status: number; headers: Record<string, string> };
  };
  assertEquals(serialized.data, "AQID");
  assertEquals(serialized.encoding, "base64");
  assertEquals(serialized.mime_type, "audio/mpeg");
  assertEquals(serialized.byte_length, 3);
  assertEquals(serialized.http.headers["x-request-id"], "tool-request");
  assertEquals(
    voice.tools.find((tool) => tool.name === "xai_voice_custom_get_audio")
      ?.module,
    "voice",
  );
});
