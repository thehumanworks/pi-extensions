/** Authorized real GPT-6-luna Pi turn and read-only xAI metadata check. */
import {
  type AgentSessionEvent,
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  readStoredCredential,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { SDK_VERSION } from "@xai-official/sdk";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPiApiKey } from "../pi-auth.ts";

type ToolEnd = Extract<AgentSessionEvent, { type: "tool_execution_end" }>;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function structuredResult(
  event: ToolEnd | undefined,
): Record<string, unknown> | undefined {
  if (!event || event.isError || !isRecord(event.result)) return undefined;
  return isRecord(event.result.structuredContent)
    ? event.result.structuredContent
    : undefined;
}
function scriptReports(events: ToolEnd[]): Record<string, unknown>[] {
  return events.flatMap((event) => {
    if (!isRecord(event.result) || !Array.isArray(event.result.content)) {
      return [];
    }
    return event.result.content.flatMap((item: unknown) => {
      if (
        !isRecord(item) ||
        item.type !== "text" ||
        typeof item.text !== "string"
      )
        return [];
      try {
        const parsed: unknown = JSON.parse(item.text);
        return isRecord(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
  });
}

// Every run gets a new artifact so earlier evidence remains intact.
const timestamp = new Date().toISOString();
const evidence = fileURLToPath(
  new URL(
    `../.artifacts/e2e-gpt-6-luna-${timestamp.replace(/[:.]/g, "-")}.json`,
    import.meta.url,
  ),
);
const allowed = [
  "codemode",
  "xai_meta_capabilities",
  "xai_meta_list_tools",
  "xai_meta_describe_tool",
  "xai_models_list",
];
const observedEnds: ToolEnd[] = [];
const events: unknown[] = [];
const http: { method: string; path: string; status: number }[] = [];
const record: Record<string, unknown> = {
  timestamp,
  piVersion: VERSION,
  allowlist: allowed,
  authentication: {
    xai: "saved Pi xai login, otherwise XAI_API_KEY",
    model: "existing OpenAI credential copied into memory",
  },
  events,
  xaiHttp: http,
};
let isolated: string | undefined;
let session:
  Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
let timedOut = false;
const originalFetch = globalThis.fetch;
const acceptance = {
  selectedModelObserved: false,
  modelTurnCompleted: false,
  capabilities: false,
  schema: false,
  codeMode: false,
  discovery: false,
  liveModels: false,
  reportConsistent: false,
};
record.acceptance = acceptance;
record.modelCount = null;
try {
  await getPiApiKey();
  isolated = await mkdtemp(join(tmpdir(), "xai-pi-e2e-"));
  const credentials = new InMemoryCredentialStore();
  // This public read-only helper never instantiates writable global auth storage.
  const credential = readStoredCredential("openai");
  if (credential) {
    await credentials.modify("openai", () =>
      Promise.resolve(structuredClone(credential)),
    );
  }
  record.credentials = await credentials.list();
  const runtime = await ModelRuntime.create({
    credentials,
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model = runtime.getModel("openai", "gpt-6-luna");
  if (!model) throw new Error("Installed Pi catalog has no openai/gpt-6-luna.");
  record.selected = {
    provider: model.provider,
    model: model.id,
    api: model.api,
    baseUrl: model.baseUrl,
  };
  const settings = SettingsManager.inMemory({
    cacheWarming: "off",
    defaultTools: ["+codemode"],
    compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 90000 } },
  });
  const loader = new DefaultResourceLoader({
    cwd: isolated,
    agentDir: isolated,
    settingsManager: settings,
    noExtensions: true,
    additionalExtensionPaths: [
      fileURLToPath(new URL("../index.ts", import.meta.url)),
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    disabledBuiltinExtensions: ["mcp"],
    extensionFactories: [createCodemodeExtension({ models: false })],
  });
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "api.x.ai") {
      http.push({
        method:
          input instanceof Request ? input.method : (init?.method ?? "GET"),
        path: url.pathname,
        status: response.status,
      });
    }
    return response;
  };
  await loader.reload();
  record.loaderErrors = loader.getExtensions().errors;
  if (loader.getExtensions().errors.length) {
    throw new Error("Extension loading failed.");
  }
  session = (
    await createAgentSession({
      cwd: isolated,
      agentDir: isolated,
      modelRuntime: runtime,
      model,
      thinkingLevel: "low",
      tools: allowed,
      settingsManager: settings,
      sessionManager: SessionManager.inMemory(isolated),
      resourceLoader: loader,
    })
  ).session;
  record.callableTools = session.getCallableToolNames();
  record.activeTools = session.getActiveToolNames();
  session.subscribe((event) => {
    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_end"
    )
      events.push(event);
    if (event.type === "tool_execution_end") observedEnds.push(event);
    if (event.type === "message_end" && event.message.role === "assistant") {
      const { provider, model, api, content, usage, stopReason, errorMessage } =
        event.message;
      events.push({
        type: event.type,
        provider,
        model,
        api,
        content,
        usage,
        stopReason,
        errorMessage,
      });
    }
  });
  timeout = setTimeout(() => {
    timedOut = true;
    if (session)
      void session.abort().catch((error: unknown) => {
        record.error = error instanceof Error ? error.message : String(error);
      });
  }, 120000);
  await session.prompt(
    `Run a short genuine end-to-end test of this xAI extension using code mode. Only read-only metadata tools are available. All bridge helpers are asynchronous and MUST be awaited. Start the codemode script with const namespace = await describeNamespace("xai_models"); const matches = await searchTools("models", {namespace:"xai_models",limit:10}); use matches.some(tool => tool.name === "xai_models_list") for discovery_found; await tools.xai_meta_capabilities({}); await tools.xai_meta_describe_tool({name:"xai_models_list"}); then await tools.xai_models_list({request:{maxRetries:0,timeout:20000}}). Print one compact JSON object using text() with EXACT fields: namespace: namespace.name, discovery_found: whether search found xai_models_list, sdk_version: capabilities.sdk.version, modules: capabilities.modules.map(m=>m.name), schema_type: description.parameters.type, live_status: live.http.status, model_count: live.data.length, first_models: first three model IDs from live.data. If live metadata fails, still print the successful local discovery/capabilities/schema results and the exact error. Do not print full model metadata or headers. Return a compact final JSON summary based only on these real tool results. Do not perform generation, file access, other API calls, or invent results.`,
  );
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  globalThis.fetch = originalFetch;
  if (timeout !== undefined) clearTimeout(timeout);
  if (session) {
    const assistants = session.agent.state.messages.filter(
      (message) => message.role === "assistant",
    );
    record.messages = session.agent.state.messages;
    record.assistantStopReasons = assistants.map(
      (message) => message.stopReason,
    );
    acceptance.selectedModelObserved =
      session.model?.provider === "openai" &&
      session.model.id === "gpt-6-luna" &&
      assistants.length > 0 &&
      assistants.every(
        (message) =>
          message.provider === "openai" && message.model === "gpt-6-luna",
      );
    acceptance.modelTurnCompleted =
      !timedOut &&
      assistants.length > 0 &&
      assistants.at(-1)?.stopReason === "stop" &&
      !assistants.some(
        (message) =>
          message.stopReason === "error" || message.stopReason === "aborted",
      );
    const successfulEnd = (name: string) =>
      observedEnds.find((event) => event.toolName === name && !event.isError);
    const capabilities = structuredResult(
      successfulEnd("xai_meta_capabilities"),
    );
    const schema = structuredResult(successfulEnd("xai_meta_describe_tool"));
    const live = structuredResult(successfulEnd("xai_models_list"));
    const codeModeEnds = observedEnds.filter(
      (event) => event.toolName === "codemode" && !event.isError,
    );
    acceptance.capabilities =
      isRecord(capabilities?.sdk) &&
      capabilities.sdk.version === SDK_VERSION &&
      Array.isArray(capabilities.modules) &&
      capabilities.modules.length > 0;
    acceptance.schema =
      schema?.name === "xai_models_list" &&
      isRecord(schema.parameters) &&
      schema.parameters.type === "object";
    acceptance.codeMode = codeModeEnds.length > 0;
    acceptance.liveModels =
      isRecord(live?.http) &&
      live.http.status === 200 &&
      Array.isArray(live.data) &&
      live.data.every(
        (entry: unknown) => isRecord(entry) && typeof entry.id === "string",
      ) &&
      http.some(
        (request) => request.path === "/v1/models" && request.status === 200,
      );
    const modelCount = Array.isArray(live?.data) ? live.data.length : null;
    record.modelCount = modelCount;
    const reports = scriptReports(codeModeEnds);
    acceptance.discovery = reports.some(
      (report) =>
        report.namespace === "xai_models" && report.discovery_found === true,
    );
    acceptance.reportConsistent =
      acceptance.liveModels &&
      reports.some(
        (report) =>
          report.sdk_version === SDK_VERSION &&
          report.schema_type === "object" &&
          report.live_status === 200 &&
          report.model_count === modelCount,
      );
    session.dispose();
  }
  record.modelTurnCompleted = acceptance.modelTurnCompleted
    ? "completed"
    : "failed";
  record.timedOut = timedOut;
  const gaps = Object.entries(acceptance)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  record.gaps = gaps;
  record.status =
    gaps.length === 0 && !record.error
      ? "completed"
      : acceptance.capabilities ||
          acceptance.schema ||
          acceptance.codeMode ||
          acceptance.modelTurnCompleted
        ? "partial"
        : "failed";
  if (record.status !== "completed") process.exitCode = 1;
  try {
    await mkdir(dirname(evidence), { recursive: true });
    await writeFile(evidence, `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx",
    });
  } finally {
    if (isolated) await rm(isolated, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({
      evidence,
      status: record.status,
      selected: record.selected,
      modelCount: record.modelCount,
      acceptance,
      gaps,
      error: record.error,
    }),
  );
}
