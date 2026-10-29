import assert from "node:assert/strict";
import { test } from "node:test";
import { Chat } from "@ai-sdk/react";
import { createUIMessageStreamResponse, type UIMessageChunk } from "ai";
import type { BotUIMessage } from "@nothumanwork/bot-ai-sdk";
import { createChatTransport } from "../lib/transport";
import type { RunState } from "../lib/chat";

function response(chunks: UIMessageChunk[]) {
  return createUIMessageStreamResponse({ stream: new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } }) });
}
function text(id: string, value: string): UIMessageChunk[] {
  return [{ type: "start", messageId: id }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: value }, { type: "text-end", id: "t" }, { type: "finish" }];
}

test("SDK7 send uses only latest user text, live refs and stable retry identity", async () => {
  let session: string | undefined;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const transport = createChatTransport({ session: () => session, run: () => undefined, fetch: async (input, init) => {
    requests.push({ url: String(input), init });
    return response([]);
  } });
  const chat = new Chat<BotUIMessage>({ id: "chat1", transport, messages: [{ id: "old", role: "assistant", parts: [{ type: "text", text: "Old history" }] }] });
  await chat.sendMessage({ id: "user1", role: "user", parts: [{ type: "text", text: "hello" }] });
  await chat.sendMessage();
  session = "session1";
  await chat.sendMessage();
  const bodies = requests.map(request => JSON.parse(String(request.init?.body)));
  assert.equal(bodies[0].requestId, "chat1:user1");
  assert.equal(bodies[1].requestId, bodies[0].requestId);
  assert.deepEqual(bodies[0].messages.map((message: BotUIMessage) => message.id), ["user1"]);
  assert.equal(bodies[2].sessionId, undefined, "Retry retains its original new-session scope after acceptance");
  assert.equal(bodies[2].messageId, "user1");
  assert.equal(bodies[2].trigger, "submit-message");
  assert.equal(bodies[0].cwd, undefined);
  await chat.sendMessage({ id: "user2", role: "user", parts: [{ type: "text", text: "next turn" }] });
  assert.equal(JSON.parse(String(requests[3].init?.body)).sessionId, "session1", "A genuinely new turn uses the live session");
});

test("SDK7 canonical history replacement + full resume does not duplicate assistant text or lose users", async () => {
  const run: RunState = { runId: "run1", sessionId: "session1", status: "running" };
  const requests: Array<{ url: string; method?: string }> = [];
  const transport = createChatTransport({ session: () => run.sessionId, run: () => run, fetch: async (input, init) => {
    requests.push({ url: String(input), method: init?.method });
    return response([...text("a1", "First answer"), ...text("a2", "Second answer complete")]);
  } });
  const chat = new Chat<BotUIMessage>({ id: "chat2", transport });
  const canonical: BotUIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "first" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "First answer" }] },
    { id: "u2", role: "user", parts: [{ type: "text", text: "second" }] },
    { id: "a2", role: "assistant", parts: [{ type: "text", text: "Second answer par" }] }
  ];
  chat.messages = structuredClone(canonical);
  await chat.resumeStream();
  assert.deepEqual(requests, [{ url: "/api/chat?sessionId=session1&runId=run1", method: "GET" }]);
  assert.deepEqual(chat.messages.map(message => message.id), ["u1", "a1", "u2", "a2"]);
  assert.equal(chat.messages[3].parts.length, 1);
  assert.deepEqual(chat.messages[3].parts[0], { type: "text", text: "Second answer complete", state: "done", providerMetadata: undefined });
  assert.equal(chat.messages.filter(message => message.role === "user").length, 2);
  // Repeated reconnect remains a replacement, never a new submission or duplicated answer.
  await chat.resumeStream();
  assert.equal(chat.messages.length, 4);
  assert.equal(requests.filter(request => request.method === "POST").length, 0);
});

test("disconnects are observable errors and never imply cancellation", async () => {
  let errors = 0;
  const requests: string[] = [];
  const transport = createChatTransport({ session: () => "s1", run: () => undefined, fetch: async input => {
    requests.push(String(input));
    throw new TypeError("network error");
  } });
  const chat = new Chat<BotUIMessage>({ id: "chat3", transport, onError: () => errors++ });
  await chat.resumeStream();
  assert.equal(errors, 1);
  assert.equal(chat.status, "error");
  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0], /cancel/);
});

test("local stop only detaches an accepted stream; daemon cancellation needs its explicit route", async () => {
  const urls: string[] = [];
  let started!: () => void;
  const admitted = new Promise<void>(resolve => { started = resolve; });
  const transport = createChatTransport({ session: () => "s1", run: () => undefined, fetch: async input => {
    urls.push(String(input));
    return createUIMessageStreamResponse({ stream: new ReadableStream<UIMessageChunk>({ start(controller) {
      controller.enqueue({ type: "data-bot-run", data: { runId: "r1", sessionId: "s1", status: "running" }, transient: true });
      controller.enqueue({ type: "start", messageId: "a1" });
      controller.enqueue({ type: "text-start", id: "t1" });
      controller.enqueue({ type: "text-delta", id: "t1", delta: "Accepted work" });
      // Intentionally left open until the local observer detaches.
    } }) });
  } });
  const chat = new Chat<BotUIMessage>({ id: "chat4", transport, onData: () => started() });
  const sending = chat.sendMessage({ text: "work" });
  await admitted;
  await chat.stop();
  await sending;
  assert.equal(chat.status, "ready");
  assert.deepEqual(urls, ["/api/chat"]);
});
