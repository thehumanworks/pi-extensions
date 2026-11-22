import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import extension from "../index.ts";

test("a real lead session remains responsive and receives a persisted completion once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-lead-")),
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
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    });
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      noExtensions: true,
      extensionFactories: [extension],
      systemPrompt: "Test lead",
    });
    await loader.reload();
    const model = fake.getModel();
    const create = async (sm: SessionManager) => {
      const { session: s } = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        settingsManager: settings,
        sessionManager: sm,
        modelRuntime: runtime,
        model,
        resourceLoader: loader,
        tools: ["subagent_delegate", "bash"],
      });
      await s.bindExtensions({ mode: "print" });
      return s;
    };
    session = await create(SessionManager.create(dir, dir));
    let resolve!: () => void;
    const release = new Promise<void>((r) => {
      resolve = r;
    });
    fake.setResponses([
      fauxAssistantMessage(fauxToolCall("subagent_delegate", { task: "Return a result" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Task queued"),
      async () => {
        await release;
        return fauxAssistantMessage(fauxToolCall("bash", { command: "printf worker-shell-ok" }), {
          stopReason: "toolUse",
        });
      },
      (c) => {
        assert.match(JSON.stringify(c.messages.at(-1)), /worker-shell-ok/);
        return fauxAssistantMessage("Worker result");
      },
      fauxAssistantMessage("Lead received the result"),
    ]);
    await session.prompt("Delegate the assignment.");
    assert.equal(session.getLastAssistantText(), "Task queued");
    resolve();
    for (let i = 0; i < 200 && session.getLastAssistantText() !== "Lead received the result"; i++)
      await sleep(10);
    assert.equal(session.getLastAssistantText(), "Lead received the result");
    const notices = () =>
      session!.sessionManager
        .getBranch()
        .filter((e) => e.type === "custom_message" && e.customType === "pi-subagents-update");
    assert.equal(notices().length, 1);
    const file = session.sessionManager.getSessionFile()!;
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    session = await create(SessionManager.open(file));
    await sleep(50);
    assert.equal(notices().length, 1);
    assert.equal(fake.state.callCount, 5);
  } finally {
    await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
