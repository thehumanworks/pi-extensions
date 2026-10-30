import assert from "node:assert/strict";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as answer, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import piAgent from "../index.ts";
import { definition, fixture, scripted } from "./helpers.ts";

test("real /agent new asks the current Pi session to generate and iterate, with no definition editor", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const oldRoot = process.env.PI_AGENT_HOME, oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_AGENT_HOME = f.store.root; process.env.PI_CODING_AGENT_DIR = f.agentDir;
  const restore = (key: string, value?: string) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  t.after(() => { restore("PI_AGENT_HOME", oldRoot); restore("PI_CODING_AGENT_DIR", oldDir); });
  const first = definition("reviewer", "", "Proposed by the current session");
  const revised = definition("reviewer", "", "Check authorization and tests");
  const { models, faux } = await scripted(f.agentDir, [
    answer("Our project is a billing service"),
    ctx => {
      assert.match(JSON.stringify(ctx.messages), /Our project is a billing service/);
      assert.match(JSON.stringify(ctx.messages), /Reviews security-sensitive changes/);
      return answer(call("agent_draft", { action: "propose", definition: first }), { stopReason: "toolUse" });
    },
    answer("Here is the draft; tell me what to improve or ask for evals."),
    answer(call("agent_draft", { action: "propose", definition: revised }), { stopReason: "toolUse" }),
    answer("Revised. Ready for another review or evaluation."),
  ]);
  const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, noExtensions: true, extensionFactories: [piAgent] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: f.cwd, agentDir: f.agentDir, modelRuntime: models, resourceLoader: loader, sessionManager: SessionManager.inMemory(f.cwd) });
  t.after(async () => { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
  const notifications: string[] = [];
  const ui = {
    input: async () => "Reviews security-sensitive changes",
    editor: async () => { throw new Error("Must not ask the user to author the definition"); },
    confirm: async () => true,
    notify: (message: string) => notifications.push(message), setStatus() {}, setWidget() {},
  } as unknown as ExtensionUIContext;
  await session.bindExtensions({ mode: "rpc", uiContext: ui });
  await session.prompt("Remember our project's purpose");
  let settled!: () => void;
  const ready = new Promise<void>(r => { settled = r; });
  const unsubscribe = session.subscribe(e => { if (e.type === "agent_settled") settled(); });
  await session.prompt("/agent new");
  await ready; unsubscribe();
  assert.equal(faux.state.callCount, 3);
  assert.equal((await f.store.list()).agents.length, 0);
  await session.prompt("Focus more on authorization and missing tests");
  assert.equal(faux.state.callCount, 5);
  assert.equal((await f.store.list()).agents.length, 0);
  await session.prompt("/agent accept");
  assert.equal((await f.store.ensure("reviewer")).prompt, "Check authorization and tests");
  assert.deepEqual(notifications, []);
});
