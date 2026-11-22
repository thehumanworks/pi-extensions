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
import {
  contentText,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import extension from "../index.ts";

test("a task-only worker inherits the lead settings; the lead stays responsive and receives one persisted completion", () =>
  exerciseDelegation(false));
test("a worker uses the scoped model, reasoning effort and replacement prompt without changing the lead", () =>
  exerciseDelegation(true));

async function exerciseDelegation(withOverrides: boolean) {
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
    const lead = fauxProvider({ models: [{ id: "lead", reasoning: true }] });
    const alternate = fauxProvider({
      provider: "faux-other",
      models: [{ id: "team/reasoner", reasoning: true }],
    });
    for (const fake of [lead, alternate]) runtime.registerNativeProvider(fake.provider);
    const model = lead.getModel(),
      other = alternate.getModel();
    const leadPrompt = "Follow the main session's instructions.";
    const overrides = {
      model: `${other.provider}/${other.id}`,
      reasoningEffort: "high",
      systemPrompt: "Follow this assignment's custom instructions.",
    };
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
      systemPrompt: leadPrompt,
    });
    await loader.reload();
    const create = async (sm: SessionManager) => {
      const { session: s } = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        settingsManager: settings,
        sessionManager: sm,
        modelRuntime: runtime,
        model,
        thinkingLevel: "low",
        scopedModels: [{ model: other }, { model }],
        resourceLoader: loader,
        tools: ["subagent_delegate", "bash"],
      });
      await s.bindExtensions({ mode: "print" });
      return s;
    };
    session = await create(SessionManager.create(dir, dir));
    const leadSessionId = session.sessionId;
    const originalPrompt = session.systemPrompt;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    type Request = { model: string; reasoning?: string; prompt: string };
    const leadRequests: Request[] = [],
      workerRequests: Request[] = [];
    let shellResult = "";
    // Route by session, not by the model or prompt under test. Lead and worker calls can overlap.
    const respond: FauxResponseFactory = async ({ messages }, options, _state, requestModel) => {
      const isLead = options?.sessionId === leadSessionId;
      const turn = (isLead ? leadRequests : workerRequests).push({
        model: `${requestModel.provider}/${requestModel.id}`,
        reasoning: options?.reasoning,
        prompt: getCurrentSystemPrompt(messages),
      });
      if (isLead) {
        if (turn === 1)
          return fauxAssistantMessage(
            fauxToolCall("subagent_delegate", {
              task: "Return a result",
              ...(withOverrides ? overrides : {}),
            }),
            { stopReason: "toolUse" },
          );
        return fauxAssistantMessage(turn === 2 ? "Task queued" : "Lead received the result");
      }
      if (turn === 1) {
        await gate;
        return fauxAssistantMessage(fauxToolCall("bash", { command: "printf worker-shell-ok" }), {
          stopReason: "toolUse",
        });
      }
      const result = messages.at(-1);
      if (result?.role === "toolResult" && result.toolName === "bash" && !result.isError)
        shellResult = contentText(result.content);
      return fauxAssistantMessage("Worker result");
    };
    for (const fake of [lead, alternate]) fake.setResponses(Array.from({ length: 5 }, () => respond));
    try {
      await session.prompt("Delegate the assignment.");
      assert.equal(session.getLastAssistantText(), "Task queued");
    } finally {
      release();
    }
    for (let i = 0; i < 200 && session.getLastAssistantText() !== "Lead received the result"; i++)
      await sleep(10);
    assert.equal(session.getLastAssistantText(), "Lead received the result");
    await session.waitForIdle();
    assert.equal(shellResult.trim(), "worker-shell-ok");
    assert.equal(leadRequests.length, 3);
    assert.equal(workerRequests.length, 2);
    const leadModel = `${model.provider}/${model.id}`;
    for (const request of leadRequests) {
      assert.equal(request.model, leadModel);
      assert.equal(request.reasoning, "low");
      assert.ok(request.prompt.includes(leadPrompt));
      assert.ok(!request.prompt.includes(overrides.systemPrompt));
      assert.doesNotMatch(request.prompt, /background worker speaking only to the lead/);
    }
    for (const request of workerRequests) {
      assert.equal(request.model, withOverrides ? overrides.model : leadModel);
      assert.equal(request.reasoning, withOverrides ? overrides.reasoningEffort : "low");
      assert.equal(request.prompt.includes(leadPrompt), !withOverrides, request.prompt);
      assert.equal(request.prompt.includes(overrides.systemPrompt), withOverrides, request.prompt);
      assert.match(request.prompt, /background worker speaking only to the lead/);
      assert.match(request.prompt, /BLOCKED:/);
    }
    assert.equal(session.model?.provider, model.provider);
    assert.equal(session.model?.id, model.id);
    assert.equal(session.thinkingLevel, "low");
    assert.equal(session.systemPrompt, originalPrompt);

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
    assert.equal(lead.state.callCount, withOverrides ? 3 : 5);
    assert.equal(alternate.state.callCount, withOverrides ? 2 : 0);
  } finally {
    await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}
