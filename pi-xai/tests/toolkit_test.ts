import test from "node:test";
import { assert, assertEquals, assertRejects } from "./assert.ts";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ModelResponse, SpaceXAI } from "@xai-official/sdk";
import { registerXaiTools } from "../index.ts";
import { createClientProvider } from "../src/client.ts";
import { createXaiToolkit, getApiKey, serializeResult } from "../src/index.ts";

const output = [
  {
    type: "message",
    role: "assistant",
    id: "message-1",
    status: "completed",
    content: [{ type: "output_text", text: '{"answer":42}', annotations: [] }],
  },
];
const responseBody = {
  id: "response-1",
  status: "completed",
  output,
  usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
  future_field: "preserved",
};

function fixture(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const client = new SpaceXAI({
    apiKey: "mock-key",
    baseURL: "https://mock.invalid/v1",
    maxRetries: 0,
    fetch: (async (input: Request | string | URL) => {
      assert(input instanceof Request);
      requests.push(input);
      return await handler(input);
    }) as typeof fetch,
  });
  return { toolkit: createXaiToolkit({ client }), requests, client };
}

function sse(events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": "stream-request",
      },
    },
  );
}

test("toolkit discovery and helpers are offline, complete, and independent of credentials", async () => {
  let credentialCalls = 0;
  const toolkit = createXaiToolkit({
    apiKey: () => {
      credentialCalls++;
      throw new Error("not allowed");
    },
  });
  const capabilities = await toolkit.meta.capabilities({});
  assertEquals(capabilities.sdk.version, "0.2.2");
  assertEquals(capabilities.modules.length, 11);
  assertEquals(toolkit.tools.length, 69);
  assertEquals(
    new Set(toolkit.tools.map((tool) => tool.name)).size,
    toolkit.tools.length,
  );
  const info = await toolkit.meta.describeTool({ name: "xai_images_generate" });
  assertEquals(info.parameters.type, "object");
  assertEquals(
    (await toolkit.meta.listTools({ module: "videos" })).tools.length,
    5,
  );
  assertEquals(await toolkit.executeTool("xai_helpers_code_execution", {}), {
    type: "code_interpreter",
  });
  assertEquals(credentialCalls, 0);
  await assertRejects(
    () => toolkit.executeTool("unknown", {}),
    Error,
    "Unknown xAI tool",
  );
  await assertRejects(
    () => toolkit.meta.describeTool({ name: "unknown" }),
    Error,
    "Unknown xAI tool",
  );
});

test("client initialization shares concurrent work, stays isolated, and retries failures", async () => {
  let calls = 0;
  const provider = createClientProvider({
    apiKey: () => {
      calls++;
      return Promise.resolve("mock-key");
    },
  });
  const [first, second] = await Promise.all([
    provider.getClient(),
    provider.getClient(),
  ]);
  assertEquals(first, second);
  assertEquals(calls, 1);
  const other = await createClientProvider({
    apiKey: "other-mock-key",
  }).getClient();
  assert(first !== other);
  let attempts = 0;
  const retrying = createClientProvider({
    apiKey: () => {
      if (++attempts === 1) throw new Error("temporary failure");
      return "mock-key";
    },
  });
  await assertRejects(() => retrying.getClient(), Error, "temporary failure");
  await retrying.getClient();
  assertEquals(attempts, 2);
  await assertRejects(
    () => getApiKey(() => undefined),
    Error,
    "Set XAI_API_KEY",
  );
  const names: string[] = [];
  assertEquals(
    await getApiKey((name) => {
      names.push(name);
      return "mock-key";
    }),
    "mock-key",
  );
  assertEquals(names, ["XAI_API_KEY"]);
});

test("responses preserve SDK defaults, nulls, extra fields and serializable conveniences", async () => {
  const { toolkit, requests } = fixture(() =>
    Response.json(responseBody, { headers: { "x-request-id": "request-1" } }),
  );
  const result = await toolkit.responses.create({
    model: "future-model",
    stream: false,
    input: [
      {
        role: "user",
        type: null,
        content: [
          {
            type: "input_image",
            image: { data: "AQID", mime_type: "image/png" },
          },
        ],
      },
    ],
    reasoning: { effort: null },
    text: { format: { type: "json_schema", name: null, schema: true } },
    future_option: "preserved",
    request: { headers: { "x-test": "forwarded" }, http: { body: true } },
  });
  assert(result instanceof ModelResponse);
  const body = await requests[0].json();
  assertEquals(body.input[0].type, null);
  assertEquals(
    body.input[0].content[0].image_url,
    "data:image/png;base64,AQID",
  );
  assertEquals(body.reasoning.effort, null);
  assertEquals(body.text.format.schema, true);
  assertEquals(body.text.format.name, null);
  assertEquals(body.future_option, "preserved");
  assertEquals(body.store, false);
  assertEquals(body.include, ["reasoning.encrypted_content"]);
  assert(!("request" in body));
  assertEquals(requests[0].headers.get("x-test"), "forwarded");
  const serialized = (await serializeResult(result)) as Record<string, unknown>;
  assertEquals(serialized.text, '{"answer":42}');
  assertEquals(serialized.parsed, { answer: 42 });
  assertEquals(serialized.input, result.toInput());
  assertEquals(serialized.future_field, "preserved");
  assertEquals(
    (serialized.http as { headers: Record<string, string> }).headers[
      "x-request-id"
    ],
    "request-1",
  );
  await toolkit.responses.create({
    model: "m",
    input: "input",
    stream: false,
    text: { format: null },
  });
  assertEquals((await requests[1].json()).text.format, null);
});

test("response lifecycle forwards stored IDs, compacted input, and pagination", async () => {
  const { toolkit, requests } = fixture((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/compact")) {
      return Response.json({
        id: "compact-1",
        output: [{ type: "compaction", encrypted_content: "opaque" }],
      });
    }
    if (url.pathname.endsWith("/input_items")) {
      return Response.json({
        object: "list",
        data: [{ id: "item-2", type: "message" }],
        has_more: true,
        last_id: "item-2",
      });
    }
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json(responseBody);
  });
  await toolkit.responses.get({ id: "id/encoded" });
  const compacted = await toolkit.responses.compact({
    model: "m",
    input: "hello",
  });
  await toolkit.responses.create({
    model: "m",
    input: compacted.output,
    previous_response_id: "response-1",
    store: true,
    stream: false,
  });
  const page = await toolkit.responses.inputItemsList({
    id: "id/encoded",
    query: { after: "item-1", limit: 2, order: "asc" },
  });
  assertEquals(page.last_id, "item-2");
  const deleted = await toolkit.responses.delete({ id: "id/encoded" });
  assertEquals(deleted.deleted, true);
  assertEquals(new URL(requests[0].url).pathname, "/v1/responses/id%2Fencoded");
  assertEquals(new URL(requests[3].url).searchParams.get("after"), "item-1");
  const createBody = await requests[2].json();
  assertEquals(createBody.input, compacted.output);
  assertEquals(createBody.store, true);
});

test("response streaming delivers progress and preserves final structured output", async () => {
  const events = [
    {
      type: "response.created",
      response: { ...responseBody, status: "in_progress", output: [] },
    },
    {
      type: "response.output_text.delta",
      delta: '{"answer":42}',
      item_id: "message-1",
      output_index: 0,
      content_index: 0,
    },
    { type: "response.completed", response: responseBody },
  ];
  const { toolkit, requests } = fixture(() => sse(events));
  const updates: unknown[] = [];
  const result = (await toolkit.executeTool(
    "xai_responses_create",
    {
      model: "m",
      input: "hello",
      stream: true,
    },
    {
      onUpdate: (event) => {
        updates.push(event);
      },
    },
  )) as Record<string, unknown>;
  assertEquals(result.parsed, { answer: 42 });
  assertEquals(result.text, '{"answer":42}');
  assertEquals(updates, events);
  assertEquals((await requests[0].json()).stream, true);
});

test("stream failures and callback failures reject; pre-abort avoids credential lookup", async () => {
  const { toolkit } = fixture(() =>
    sse([
      {
        type: "response.created",
        response: { ...responseBody, status: "in_progress", output: [] },
      },
    ]),
  );
  await assertRejects(() =>
    toolkit.responses.create({ model: "m", input: "hello", stream: true }),
  );
  const live = fixture(() =>
    sse([
      {
        type: "response.created",
        response: { ...responseBody, status: "in_progress", output: [] },
      },
      { type: "response.completed", response: responseBody },
    ]),
  ).toolkit;
  await assertRejects(
    () =>
      live.responses.create(
        { model: "m", input: "hello", stream: true },
        {
          onUpdate: () => {
            throw new Error("callback failed");
          },
        },
      ),
    Error,
    "callback failed",
  );
  let credentials = 0;
  const lazy = createXaiToolkit({
    apiKey: () => {
      credentials++;
      return "mock-key";
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assertRejects(() =>
    lazy.models.list({}, { signal: controller.signal }),
  );
  assertEquals(credentials, 0);
});

test("all SDK helper configurations and response transformations remain usable", async () => {
  const helpers = createXaiToolkit().helpers;
  assertEquals(await helpers.webSearch({ allowed_domains: ["example.com"] }), {
    type: "web_search",
    allowed_domains: ["example.com"],
  });
  assertEquals(
    await helpers.xSearch({ from_date: "2026-10-01", to_date: "2026-10-02" }),
    { type: "x_search", from_date: "2026-10-01", to_date: "2026-10-02" },
  );
  assertEquals(
    await helpers.collectionsSearch({ vector_store_ids: ["collection-1"] }),
    { type: "file_search", vector_store_ids: ["collection-1"] },
  );
  assertEquals(
    await helpers.mcp({
      server_label: "docs",
      server_url: "https://example.com/mcp",
    }),
    {
      type: "mcp",
      server_label: "docs",
      server_url: "https://example.com/mcp",
    },
  );
  assertEquals(await helpers.imageGeneration({ action: "edit" }), {
    type: "image_generation",
    action: "edit",
  });
  assertEquals(await helpers.toolSearch({}), { type: "tool_search" });
  assertEquals(await helpers.toText({ output }), { text: '{"answer":42}' });
  assertEquals(await helpers.toJson({ response: responseBody }), {
    value: { answer: 42 },
  });
  assertEquals(await helpers.parsePartialJson({ text: '{"answer":"hel' }), {
    value: { answer: "hel" },
  });
  assertEquals(await helpers.isMessage({ item: output[0] }), { value: true });
  assertEquals(
    await helpers.isFunctionCall({
      item: { type: "function_call", name: "run", arguments: "{}" },
    }),
    { value: true },
  );
  assertEquals(await helpers.isReasoning({ item: { type: "reasoning" } }), {
    value: true,
  });
  assertEquals(
    await helpers.isImageGenerationCall({
      item: { type: "image_generation_call" },
    }),
    { value: true },
  );
  const nextInput = await helpers.toInput({ output });
  assertEquals<unknown>(nextInput.input, output);
  await assertRejects(() =>
    helpers.toJson({ response: { ...responseBody, status: "incomplete" } }),
  );
});

test("aborting an active response stream cancels its body", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(body) {
      body.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({
            type: "response.created",
            response: { ...responseBody, status: "in_progress", output: [] },
          })}\n\n`,
        ),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  const { toolkit } = fixture(
    () =>
      new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  await assertRejects(() =>
    toolkit.responses.create(
      { model: "m", input: "hello", stream: true },
      {
        signal: controller.signal,
        onUpdate: () => controller.abort(),
      },
    ),
  );
  assertEquals(cancelled, true);
});

test("Pi adapter registers code-mode namespaces and supplies structured data and updates", async () => {
  const registrations: ToolDefinition[] = [];
  const pi = {
    registerTool(tool: ToolDefinition) {
      registrations.push(tool);
    },
  } as unknown as ExtensionAPI;
  const { client } = fixture(() =>
    sse([
      {
        type: "response.created",
        response: { ...responseBody, status: "in_progress", output: [] },
      },
      { type: "response.completed", response: responseBody },
    ]),
  );
  const toolkit = registerXaiTools(pi, { client });
  assertEquals(registrations.length, toolkit.tools.length);
  assert(
    registrations.every(
      (tool) =>
        tool.exposure === "codemode" &&
        tool.namespace?.name.startsWith("xai_") &&
        tool.outputSchema !== undefined,
    ),
  );
  const tool = registrations.find(
    (tool) => tool.name === "xai_responses_create",
  )!;
  const updates: unknown[] = [];
  const result = await tool.execute(
    "test",
    { model: "m", input: "hello", stream: true },
    undefined,
    (update) => {
      updates.push(update.details);
    },
    {} as ExtensionToolContext,
  );
  assertEquals((result.structuredContent as Record<string, unknown>).parsed, {
    answer: 42,
  });
  assertEquals(updates.length, 2);
});
