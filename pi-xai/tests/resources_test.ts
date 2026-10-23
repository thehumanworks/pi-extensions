import test from "node:test";
import { assert, assertEquals, assertRejects } from "./assert.ts";
import { SpaceXAI } from "@xai-official/sdk";
import { createModelsModule } from "../src/models.ts";
import { createAccountModule } from "../src/account.ts";
import { createTokenizerModule } from "../src/tokenizer.ts";
import { createFilesModule } from "../src/files.ts";
import { createBatchesModule } from "../src/batches.ts";

function setup(respond: (request: Request) => unknown | Promise<unknown>) {
  const requests: Request[] = [];
  const client = new SpaceXAI({
    apiKey: "test-key",
    baseURL: "https://xai.test/v1",
    maxRetries: 0,
    fetch: (async (input: Request | URL | string) => {
      const request = input as Request;
      requests.push(request);
      const body = await respond(request);
      return body instanceof Response ? body : Response.json(body);
    }) as typeof fetch,
  });
  return { context: { getClient: () => Promise.resolve(client) }, requests };
}

test("model families and account use all SDK catalog routes", async () => {
  const { context, requests } = setup((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/api-key") return { api_key_id: "key-1" };
    if (path === "/v1/models") {
      return { object: "list", data: [{ id: "model-1" }] };
    }
    if (path.endsWith("models")) return { models: [{ id: "model-1" }] };
    return { id: "model-1" };
  });
  const models = createModelsModule(context);
  await models.list({});
  await models.get({ id: "a/b" });
  await models.languageList({});
  await models.languageGet({ id: "a/b" });
  await models.imageList({});
  await models.imageGet({ id: "a/b" });
  await models.videoList({});
  await models.videoGet({ id: "a/b" });
  const key = await createAccountModule(context).apiKey({});
  assertEquals(key.api_key_id, "key-1");
  assertEquals(
    requests.map((r) => new URL(r.url).pathname),
    [
      "/v1/models",
      "/v1/models/a%2Fb",
      "/v1/language-models",
      "/v1/language-models/a%2Fb",
      "/v1/image-generation-models",
      "/v1/image-generation-models/a%2Fb",
      "/v1/video-generation-models",
      "/v1/video-generation-models/a%2Fb",
      "/v1/api-key",
    ],
  );
});

test("tokenization forwards passthrough body and request metadata options", async () => {
  const { context, requests } = setup(async (request) => {
    assertEquals(await request.json(), {
      model: "grok-test",
      text: "hello",
      user: "user-1",
      future_option: true,
    });
    return {
      token_ids: [{ string_token: "hello", token_bytes: [104], token_id: 7 }],
    };
  });
  const result = await createTokenizerModule(context).encode({
    model: "grok-test",
    text: "hello",
    user: "user-1",
    future_option: true,
    request: { headers: { "X-Test": "forwarded" }, http: { body: true } },
  });
  assertEquals(new URL(requests[0].url).pathname, "/v1/tokenize-text");
  assertEquals(requests[0].headers.get("X-Test"), "forwarded");
  assertEquals(result.http.body, {
    token_ids: [{ string_token: "hello", token_bytes: [104], token_id: 7 }],
  });
});

test("files preserve upload bytes, one-page cursors, binary content and URL operations", async () => {
  const { context, requests } = setup(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/v1/files" && request.method === "POST") {
      const form = await request.formData();
      const file = form.get("file") as File;
      assertEquals(file.name, "bytes.bin");
      assertEquals(
        new Uint8Array(await file.arrayBuffer()),
        new Uint8Array([0, 255, 1]),
      );
      assertEquals(form.get("purpose"), "assistants");
      assertEquals(form.get("expires_after"), "3600");
      return { id: "file-1" };
    }
    if (url.pathname === "/v1/files") {
      return { data: [{ id: "file-1" }], pagination_token: "next-page" };
    }
    if (url.pathname.endsWith("/content")) {
      return new Response(new Uint8Array([0, 255, 1]), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    if (url.pathname.endsWith("/public-url/revoke")) {
      return { id: "file-1", revoked: true };
    }
    if (url.pathname.endsWith("/public-url")) {
      return { public_url: "https://files.test/public" };
    }
    return request.method === "DELETE"
      ? { id: "file-1", deleted: true }
      : { id: "file-1" };
  });
  const files = createFilesModule(context);
  await files.upload({
    file: {
      data: "AP8B",
      encoding: "base64",
      filename: "bytes.bin",
      mime_type: "application/octet-stream",
    },
    purpose: "assistants",
    expires_after: 3600,
  });
  const page = await files.list({
    query: { limit: 2, pagination_token: "incoming", filter: "size_bytes > 1" },
  });
  assertEquals(page.pagination_token, "next-page");
  assertEquals(requests.length, 2);
  assertEquals(
    new URL(requests[1].url).searchParams.get("pagination_token"),
    "incoming",
  );
  assertEquals(
    new URL(requests[1].url).searchParams.get("sort_by"),
    "created_at",
  );
  await files.get({ id: "file/1" });
  const binary = await files.content({
    id: "file/1",
    query: { format: "original" },
  });
  assertEquals(
    new Uint8Array(await binary.arrayBuffer()),
    new Uint8Array([0, 255, 1]),
  );
  await files.createPublicUrl({ id: "file/1", body: { expires_after: 7200 } });
  await files.revokePublicUrl({ id: "file/1" });
  await files.delete({ id: "file/1" });
  assertEquals(
    requests.slice(2).map((r) => [r.method, new URL(r.url).pathname]),
    [
      ["GET", "/v1/files/file%2F1"],
      ["GET", "/v1/files/file%2F1/content"],
      ["POST", "/v1/files/file%2F1/public-url"],
      ["POST", "/v1/files/file%2F1/public-url/revoke"],
      ["DELETE", "/v1/files/file%2F1"],
    ],
  );
});

test("batches expose all operations and explicit pagination", async () => {
  const { context, requests } = setup((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/results")) {
      return { results: [], pagination_token: "results-next" };
    }
    if (url.pathname.endsWith("/requests")) {
      return request.method === "POST"
        ? {}
        : { batch_request_metadata: [], pagination_token: "requests-next" };
    }
    if (url.pathname === "/v1/batches" && request.method === "GET") {
      return { batches: [], pagination_token: "batches-next" };
    }
    return { batch_id: "batch-1", state: { num_pending: 0 } };
  });
  const batches = createBatchesModule(context);
  await batches.create({ body: { name: "test", input_file_id: "file-1" } });
  assertEquals(
    (await batches.list({ query: { pagination_token: "page-1" } }))
      .pagination_token,
    "batches-next",
  );
  await batches.get({ id: "batch/1" });
  await batches.cancel({ id: "batch/1" });
  assertEquals(
    (
      await batches.results({
        id: "batch/1",
        query: { pagination_token: "page-2" },
      })
    ).pagination_token,
    "results-next",
  );
  await batches.requestsAdd({
    id: "batch/1",
    body: {
      batch_requests: [
        {
          batch_request_id: "req-1",
          batch_request: {
            responses: { model: "grok-test", input: "hello" },
          },
        },
      ],
    },
  });
  assertEquals(
    (
      await batches.requestsList({
        id: "batch/1",
        query: { pagination_token: "page-3" },
      })
    ).pagination_token,
    "requests-next",
  );
  assertEquals(requests.length, 7);
  assertEquals(await requests[5].json(), {
    batch_requests: [
      {
        batch_request_id: "req-1",
        batch_request: {
          responses: {
            model: "grok-test",
            input: "hello",
            store: false,
            stream: false,
            include: ["reasoning.encrypted_content"],
          },
        },
      },
    ],
  });
  assertEquals(
    new URL(requests[4].url).searchParams.get("pagination_token"),
    "page-2",
  );
  assertEquals(
    new URL(requests[6].url).searchParams.get("pagination_token"),
    "page-3",
  );
});

test("batch polling completes, honors timeout and cancellation", async () => {
  let polls = 0;
  const { context } = setup(() => ({
    batch_id: "batch-1",
    state: { num_pending: ++polls < 2 ? 1 : 0 },
  }));
  const result = await createBatchesModule(context).wait({
    id: "batch-1",
    interval: 1,
    timeout: 1000,
  });
  assertEquals(result.state.num_pending, 0);
  assertEquals(polls, 2);
  const pending = setup(() => ({
    batch_id: "batch-1",
    state: { num_pending: 1 },
  }));
  await assertRejects(() =>
    createBatchesModule(pending.context).wait({
      id: "batch-1",
      interval: 1,
      timeout: 10,
    }),
  );
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assertRejects(() =>
    createBatchesModule(pending.context).wait(
      {
        id: "batch-1",
        interval: 1,
        timeout: 1000,
      },
      { signal: controller.signal },
    ),
  );
  assert(pending.requests.length > 0);
});

test("resource calls forward every request option and reject invalid input before client resolution", async () => {
  let resolved = 0;
  const client = new SpaceXAI({ apiKey: "test-key" });
  let forwarded: unknown;
  client.models.list = (options) => {
    forwarded = options;
    return Promise.resolve({
      object: "list",
      data: [],
      http: {
        status: 200,
        headers: new Headers(),
        requestId: null,
        clientRequestId: "test",
      },
    });
  };
  const context = {
    getClient: () => {
      resolved++;
      return Promise.resolve(client);
    },
  };
  const models = createModelsModule(context);
  const request = {
    timeout: 100,
    idleTimeout: 50,
    maxResponseBodyBytes: 1024,
    maxRetries: 2,
    retryBeforeOutput: true,
    headers: { "X-Test": "option" },
    http: { body: true },
  };
  const signal = new AbortController().signal;
  await models.list({ request }, { signal });
  assertEquals(forwarded, { ...request, signal });
  assertEquals(resolved, 1);
  await assertRejects(() =>
    createFilesModule(context).upload({
      file: { data: "test", encoding: "utf8" },
      expires_after: 1,
    }),
  );
  assertEquals(resolved, 1);
});
