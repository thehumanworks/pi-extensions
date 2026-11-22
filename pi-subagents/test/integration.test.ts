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

test("clearing the lead queue cannot lose a completed worker notice", { timeout: 10000 }, () =>
  exerciseDelegation(false, "clear"),
);
test("an abort delivers a waiting worker notice without starting another turn", { timeout: 10000 }, () =>
  exerciseDelegation(false, "abort"),
);

test(
  "a prompt submitted by an earlier settlement hook does not duplicate a worker notice",
  { timeout: 10000 },
  () => exerciseDelegation(false, "settle-prompt"),
);
test(
  "aborting a prompt from an earlier settlement hook does not start a worker notice turn",
  { timeout: 10000 },
  () => exerciseDelegation(false, "settle-prompt-abort"),
);
test(
  "a later settlement hook's prompt still runs after a queued worker notice command",
  { timeout: 10000 },
  () => exerciseDelegation(false, "settle-prompt-late"),
);
test(
  "a slow settlement hook without an abort does not suppress the worker notice turn",
  { timeout: 10000 },
  () => exerciseDelegation(false, "settle-slow"),
);
test("cancelling tree navigation does not strand a waiting worker notice", { timeout: 10000 }, () =>
  exerciseDelegation(false, "cancel-tree"),
);

test("print receives a completion committed during a later settlement hook", { timeout: 10000 }, () =>
  exerciseDelegation(false, "settle-completion"),
);

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

async function exerciseDelegation(
  withOverrides: boolean,
  interrupt?:
    | "clear"
    | "abort"
    | "settle-prompt"
    | "settle-prompt-abort"
    | "settle-prompt-late"
    | "settle-completion"
    | "settle-slow"
    | "cancel-tree",
) {
  const settlePrompt = interrupt === "settle-prompt" || interrupt === "settle-prompt-abort";
  const laterPrompt = interrupt === "settle-prompt-late";
  const slowHook = interrupt === "settle-slow";
  const laterPromptText = "A later extension submitted a prompt.";
  const laterPromptAnswer = "Later prompt answered";
  const aborted = interrupt === "abort" || interrupt === "settle-prompt-abort";
  const holdLead =
    interrupt !== undefined && interrupt !== "cancel-tree" && interrupt !== "settle-completion";
  const treeWaiting = latch();
  const cancelTree = latch();
  const followupWaiting = latch();
  const finishFollowup = latch();
  const finished = latch();
  const leadWaiting = latch();
  const finishLead = latch();
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
    let noticeStarts = 0;
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      noExtensions: true,
      extensionFactories: [
        (pi) => {
          let prompted = false;
          pi.on("agent_settled", () => {
            if (!settlePrompt || prompted) return;
            prompted = true;
            pi.sendUserMessage("An earlier extension submitted a prompt.");
          });
          pi.on("session_before_tree", async () => {
            if (interrupt !== "cancel-tree") return;
            treeWaiting.resolve();
            await cancelTree.promise;
            return { cancel: true };
          });
        },
        extension,
        (pi) => {
          let delayed = false;
          pi.on("agent_settled", async () => {
            if (!delayed && interrupt === "settle-completion") {
              delayed = true;
              release();
              await finished.promise;
              return;
            }
            if (delayed || (!settlePrompt && !laterPrompt && !slowHook)) return;
            delayed = true;
            // Let the notice command queue before the later prompt. The slow
            // case holds the hook open past the old dispatch deadline.
            await sleep(slowHook ? 1250 : laterPrompt ? 100 : 25);
            if (laterPrompt) pi.sendUserMessage(laterPromptText);
          });
          pi.on("before_agent_start", (event) => {
            if (event.messageType === "custom" && event.message.customType === "pi-subagents-update")
              noticeStarts++;
          });
        },
      ],
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
      await s.bindExtensions({
        mode: "print",
        uiContext: {
          ...s.extensionRunner.getUIContext(),
          setStatus(_key, value) {
            if (value?.includes("1 done")) finished.resolve();
          },
        },
      });
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
        if (holdLead && turn === 2) {
          leadWaiting.resolve();
          await finishLead.promise;
        }
        if (settlePrompt && turn === 3) {
          followupWaiting.resolve();
          await finishFollowup.promise;
          return fauxAssistantMessage("Earlier prompt answered");
        }
        const last = messages.at(-1);
        if (laterPrompt && last?.role === "user" && contentText(last.content) === laterPromptText)
          return fauxAssistantMessage(laterPromptAnswer);
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
    for (const fake of [lead, alternate]) fake.setResponses(Array.from({ length: 8 }, () => respond));
    const notices = () =>
      session!.sessionManager
        .getBranch()
        .filter((e) => e.type === "custom_message" && e.customType === "pi-subagents-update");
    try {
      const leadRun = session.prompt("Delegate the assignment.");
      if (holdLead) {
        await leadWaiting.promise;
        release();
        await finished.promise;
        session.clearQueue();
        const abort = interrupt === "abort" ? session.abort() : undefined;
        finishLead.resolve();
        await abort;
      }
      if (settlePrompt) {
        await followupWaiting.promise;
        const abort = aborted ? session.abort() : undefined;
        finishFollowup.resolve();
        await abort;
      }
      await leadRun;
      if (interrupt === "clear" || interrupt === "settle-completion") {
        // Print mode shuts down as soon as prompt() returns.
        assert.equal(notices().length, 1);
        assert.equal(session.getLastAssistantText(), "Lead received the result");
      }
      if (!holdLead && interrupt !== "settle-completion")
        assert.equal(session.getLastAssistantText(), "Task queued");
      if (interrupt === "cancel-tree") {
        const oldLeaf = session.sessionManager.getLeafId();
        const target = session.sessionManager
          .getBranch()
          .find((entry) => entry.type === "message" && entry.message.role === "user");
        assert.ok(target);
        const navigation = session.navigateTree(target.id);
        await treeWaiting.promise;
        release();
        await finished.promise;
        // Give the extension time to attempt delivery while Pi is still busy.
        await sleep(100);
        assert.equal(session.isIdle, false);
        assert.equal(notices().length, 0);
        cancelTree.resolve();
        assert.deepEqual(await navigation, { cancelled: true });
        assert.equal(session.sessionManager.getLeafId(), oldLeaf);
      }
    } finally {
      release();
      finishLead.resolve();
      finishFollowup.resolve();
      cancelTree.resolve();
    }
    for (let i = 0; i < 200 && (notices().length === 0 || !session.isIdle); i++) await sleep(10);
    assert.equal(notices().length, 1);
    if (!aborted && !laterPrompt) assert.equal(session.getLastAssistantText(), "Lead received the result");
    await session.waitForIdle();
    assert.equal(shellResult.trim(), "worker-shell-ok");
    const expectedLeadRequests = (aborted ? 2 : 3) + Number(settlePrompt || laterPrompt);
    assert.equal(leadRequests.length, expectedLeadRequests);
    assert.equal(noticeStarts, aborted ? 0 : 1);
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

    const file = session.sessionManager.getSessionFile()!;
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    session = await create(SessionManager.open(file));
    await sleep(50);
    assert.equal(notices().length, 1);
    if (laterPrompt) {
      const messages = session.sessionManager
        .getBranch()
        .flatMap((e) => (e.type === "message" ? [e.message] : []));
      assert.equal(
        messages.filter((m) => m.role === "user" && contentText(m.content) === laterPromptText).length,
        1,
      );
      assert.ok(messages.some((m) => m.role === "assistant" && contentText(m.content) === laterPromptAnswer));
    }
    assert.equal(lead.state.callCount, expectedLeadRequests + (withOverrides ? 0 : 2));
    assert.equal(alternate.state.callCount, withOverrides ? 2 : 0);
    if (interrupt === "clear") {
      const target = session.sessionManager
        .getBranch()
        .find((e) => e.type === "message" && e.message.role === "user");
      assert.ok(target);
      assert.equal((await session.navigateTree(target.id)).cancelled, false);
      await sleep(100);
      assert.equal(session.sessionManager.getLeafId(), target.parentId);
      assert.equal(notices().length, 0, "editing an old prompt must not replay a delivered notice");
      assert.equal(lead.state.callCount, expectedLeadRequests + 2);
    }
  } finally {
    await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}
