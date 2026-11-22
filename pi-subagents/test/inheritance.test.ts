import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createCodemodeExtension,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Type,
  getCurrentTools,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import extension from "../index.ts";

test("codemode-only workers inherit SDK and nested tools, exclude board tools and honor the live lead guard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-tools-")),
    previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(dir, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const fake = fauxProvider({ tokensPerSecond: 100000 });
    runtime.registerNativeProvider(fake.provider);
    const settings = SettingsManager.inMemory({
      codemode: { mode: "only" },
      cacheWarming: "off",
      compaction: { enabled: false },
    });
    let protectedCalls = 0,
      inheritedCalls = 0,
      workerTurns = 0,
      leadTurns = 0;
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      noExtensions: true,
      extensionFactories: [
        extension,
        { name: "codemode", factory: createCodemodeExtension(), builtin: true },
        (pi) => {
          pi.on("tool_call", (e) => {
            if (e.toolName === "sealed") return { block: true, reason: "lead denied this call" };
          });
          pi.registerTool({
            name: "nested_only",
            label: "nested",
            description: "runtime-only nested tool",
            exposure: "codemode",
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: "live nested result" }], details: {} }),
          });
        },
      ],
      additionalExtensionPaths: ["builtin:codemode"],
      systemPrompt: "Test lead",
    });
    await loader.reload();
    const model = fake.getModel();
    ({ session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      sessionManager: SessionManager.create(dir, dir),
      modelRuntime: runtime,
      model,
      resourceLoader: loader,
      tools: [
        "codemode",
        "subagent_delegate",
        "subagent_status",
        "subagent_resume",
        "sealed",
        "live_tool",
        "nested_only",
      ],
      customTools: ["live_tool", "sealed"].map((name) => ({
        name,
        label: name,
        description: name,
        parameters: Type.Object({}),
        execute: async () => {
          if (name === "sealed") protectedCalls++;
          else inheritedCalls++;
          return { content: [{ type: "text", text: "live implementation" }], details: {} };
        },
      })),
    }));
    await session.bindExtensions({ mode: "print" });
    session.setActiveToolsByName(session.getActiveToolNames().filter((n) => n !== "nested_only"));
    const seen: string[] = [];
    const response: FauxResponseFactory = (c) => {
      const isWorker = JSON.stringify(c.messages[0]).includes("background worker speaking only");
      const tools = getCurrentTools(c.messages).map((t) => t.name);
      if (isWorker) {
        seen.push(JSON.stringify(tools));
        if (++workerTurns === 1)
          return fauxAssistantMessage(
            fauxToolCall("codemode", {
              code: `
          store("marker","durable worker value"); text(ALL_TOOLS.map(t=>typeof t==="string"?t:t.name));
          text(await tools.live_tool({})); text(await tools.nested_only({}));
          try { text(await tools.sealed({})); } catch(e) {text(String(e));}
        `,
            }),
            { stopReason: "toolUse" },
          );
        seen.push(JSON.stringify(c.messages.at(-1)));
        if (workerTurns === 2) return fauxAssistantMessage("BLOCKED: Ready for the next check?");
        if (workerTurns === 3)
          return fauxAssistantMessage(fauxToolCall("codemode", { code: 'text(load("marker"))' }), {
            stopReason: "toolUse",
          });
        return fauxAssistantMessage("Worker finished");
      }
      if (++leadTurns === 1)
        return fauxAssistantMessage(
          fauxToolCall("codemode", { code: 'text(await tools.subagent_delegate({task:"Check tools"}))' }),
          { stopReason: "toolUse" },
        );
      if (leadTurns === 3) {
        const id = /Worker ([a-f0-9-]{36}) blocked:/.exec(JSON.stringify(c.messages))?.[1];
        assert.ok(id);
        return fauxAssistantMessage(
          fauxToolCall("codemode", {
            code: `text(await tools.subagent_resume({id:"${id}",input:"Proceed"}))`,
          }),
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage(leadTurns === 2 ? "queued" : leadTurns === 4 ? "resumed" : "received");
    };
    fake.setResponses(Array.from({ length: 12 }, () => response));
    await session.prompt("Delegate work");
    for (let i = 0; i < 300 && leadTurns < 5; i++) await sleep(10);
    assert.deepEqual(
      seen.slice(0, 2),
      ['["codemode"]', '["codemode"]'],
      JSON.stringify(session.messages).slice(-1600),
    );
    assert.equal(inheritedCalls, 1);
    assert.equal(protectedCalls, 0);
    assert.match(seen[2], /live nested result/);
    assert.match(seen[2], /lead denied this call/);
    assert.doesNotMatch(seen[2], /subagent_delegate|subagent_resume|subagent_status/);
    assert.match(seen.at(-1)!, /durable worker value/);
    assert.equal(leadTurns, 5);
  } finally {
    await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
