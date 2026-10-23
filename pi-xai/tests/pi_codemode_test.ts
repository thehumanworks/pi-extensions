import {
  deepStrictEqual as assertEquals,
  ok as assert,
} from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  discoverAndLoadExtensions,
  type ExtensionToolContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { SpaceXAI } from "@xai-official/sdk";
import xaiExtension, { registerXaiTools } from "../index.ts";
import { fileURLToPath } from "node:url";

test("Pi loads the default entrypoint from disk without credentials", async () => {
  const isolated = await mkdtemp(join(tmpdir(), "xai-pi-loader-"));
  try {
    const loaded = await discoverAndLoadExtensions(
      [fileURLToPath(new URL("../index.ts", import.meta.url))],
      isolated,
      isolated,
    );
    assertEquals(loaded.errors, []);
    const extension = loaded.extensions.find((item) =>
      item.tools.has("xai_meta_capabilities"),
    );
    assert(extension);
    assertEquals(extension.tools.size, 69);
    const tool = extension.tools.get("xai_meta_capabilities")!.definition;
    assertEquals(tool.exposure, "codemode");
    const result = await tool.execute(
      "offline-loader",
      {},
      undefined,
      undefined,
      {} as ExtensionToolContext,
    );
    const capabilities = result.structuredContent as {
      sdk: { version: string };
    };
    assertEquals(capabilities.sdk.version, "0.2.2");
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
});

/** Actual Pi session and QuickJS sandbox; no prompt or provider completion is sent. */
test("Pi code mode discovers xAI namespaces and receives structured SDK results", async () => {
  const isolated = await mkdtemp(join(tmpdir(), "xai-pi-codemode-"));
  let fetches = 0;
  const client = new SpaceXAI({
    apiKey: "offline-fixture",
    baseURL: "https://offline.invalid/v1",
    maxRetries: 0,
    fetch: ((input: string | URL | Request) => {
      fetches++;
      assertEquals(
        new URL(input instanceof Request ? input.url : input).pathname,
        "/v1/models",
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "offline-model",
                object: "model",
                owned_by: "fixture",
                created: 0,
              },
            ],
          }),
          {
            headers: {
              "content-type": "application/json",
              "x-request-id": "offline-sdk",
            },
          },
        ),
      );
    }) as typeof fetch,
  });
  const settingsManager = SettingsManager.inMemory({
    cacheWarming: "off",
    defaultTools: ["+codemode"],
    compaction: { enabled: false },
  });
  const sessionManager = SessionManager.inMemory(isolated);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  // A model is selected only as session metadata. The agent never runs a turn.
  const loader = new DefaultResourceLoader({
    cwd: isolated,
    agentDir: isolated,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    disabledBuiltinExtensions: ["mcp"],
    extensionFactories: [
      createCodemodeExtension({ models: false }),
      (pi) => {
        registerXaiTools(pi, { client });
      },
    ],
  });
  let session:
    Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    assertEquals(typeof xaiExtension, "function");
    await loader.reload();
    assertEquals(loader.getExtensions().errors, []);
    const created = await createAgentSession({
      cwd: isolated,
      agentDir: isolated,
      modelRuntime,
      model: modelRuntime.getModels()[0],
      resourceLoader: loader,
      sessionManager,
      settingsManager,
    });
    session = created.session;
    // defaultTools activates code mode without imposing an allowlist on registrations.
    assert(session.getActiveToolNames().includes("codemode"));
    assert(session.getActiveToolNames().includes("read"));
    assert(
      !session.getActiveToolNames().some((name) => name.startsWith("xai_")),
    );
    assert(session.getCallableToolNames().includes("xai_meta_capabilities"));
    assert(session.getCallableToolNames().includes("xai_models_list"));
    assertEquals(
      session.getAllTools().find((tool) => tool.name === "xai_models_list")
        ?.namespace?.name,
      "xai_models",
    );
    assertEquals(
      session.getAllTools().find((tool) => tool.name === "xai_models_list")
        ?.exposure,
      "codemode",
    );
    const codemode = session.agent.state.tools.find(
      (tool) => tool.name === "codemode",
    )!;
    assert(codemode);
    // The real nested-call pipeline requires an assistant tool-call envelope.
    // Supply that envelope locally instead of calling a language model.
    session.agent.state.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "offline-codemode",
            name: "codemode",
            arguments: {},
          },
        ],
        api: "openai-responses",
        provider: "fixture",
        model: "fixture",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 0,
      },
    ];
    let languageModelCalls = 0;
    session.agent.streamFunction = () => {
      languageModelCalls++;
      throw new Error("This fixture must never call a language model");
    };
    const result = await codemode.execute(
      "offline-codemode",
      {
        code: `
        const namespace = await describeNamespace("xai_models");
        const discovered = await searchTools("models", {namespace:"xai_models",limit:20});
        const capabilities = await tools.xai_meta_capabilities({});
        const models = await tools.xai_models_list({});
        text({
          namespace: namespace.name,
          declaredModelTool: namespace.tools.includes("xai_models_list"),
          discoveredModelTool: discovered.some(tool => tool.name === "xai_models_list"),
          sdkVersion: capabilities.sdk.version,
          modules: capabilities.modules.map(module => module.name),
          model: models.data[0].id,
          status: models.http.status,
          requestId: models.http.headers["x-request-id"]
        });
      `,
      },
      new AbortController().signal,
    );
    const textItems = result.content.filter((item) => item.type === "text");
    assert(
      textItems[0].text.startsWith("Script completed"),
      JSON.stringify(result),
    );
    const output = JSON.parse(textItems[1].text);
    assertEquals(output.namespace, "xai_models");
    assertEquals(output.declaredModelTool, true);
    assertEquals(output.discoveredModelTool, true);
    assertEquals(output.sdkVersion, "0.2.2");
    assert(output.modules.includes("voice"));
    assertEquals(output.model, "offline-model");
    assertEquals(output.status, 200);
    assertEquals(output.requestId, "offline-sdk");
    assertEquals(fetches, 1);
    assertEquals(session.agent.state.messages.length, 1);
    assertEquals(languageModelCalls, 0);
  } finally {
    session?.dispose();
    await rm(isolated, { recursive: true, force: true });
  }
});
