import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDefinition } from "../src/agent.ts";
import { agentHome, agentWorkspacesDir, homeOwner } from "../src/homes.ts";
import { activeTools, toolPolicy, unmatchedTools } from "../src/tools.ts";

const registered = ["read", "bash", "edit", "write", "grep", "find", "ls", "codemode", "mcp__radius__query", "mcp__radius__list", "mcp__other__get"].map(
  (name) => ({ name, exposure: name.startsWith("mcp__") ? "codemode" : "direct" }),
);
const piDefaults = ["read", "bash", "edit", "write"];

function agent(fields: Partial<AgentDefinition>): AgentDefinition {
  return { name: "test", description: "Test", ...fields };
}

function select(fields: Partial<AgentDefinition>) {
  const definition = agent(fields);
  const policy = toolPolicy(definition);
  return { policy, active: activeTools(definition, policy, registered, piDefaults) };
}

test("an agent without tools or disallowedTools is unrestricted", () => {
  const { policy, active } = select({});
  assert.equal(policy.restricted, false);
  assert.ok(policy.allows("mcp__other__get"));
  assert.deepEqual(active, piDefaults);
});

test("Claude Code tool names select the equivalent Pi tools, and nothing else", () => {
  const { policy, active } = select({ tools: ["Read", "Grep", "Glob", "LS", "MultiEdit"] });
  assert.deepEqual(active, ["read", "edit", "grep", "find", "ls"]);
  assert.equal(policy.allows("bash"), false);
  assert.equal(policy.allows("mcp__radius__query"), false, "an allowlist grants MCP tools only by name");
});

test("MCP servers and patterns grant their tools", () => {
  assert.deepEqual(select({ tools: ["mcp__radius"] }).active, ["mcp__radius__query", "mcp__radius__list"]);
  assert.deepEqual(select({ tools: ["mcp__*__get"] }).active, ["mcp__other__get"]);
});

test("disallowedTools removes tools from Pi's selection or from the allowlist", () => {
  assert.deepEqual(select({ disallowedTools: ["Bash", "Write"] }).active, ["read", "edit"]);
  const { policy, active } = select({ tools: ["mcp__radius"], disallowedTools: ["mcp__radius__list"] });
  assert.deepEqual(active, ["mcp__radius__query"]);
  assert.equal(policy.allows("mcp__radius__list"), false);
});

test("permission rules fail closed", () => {
  const granted = select({ tools: ["Bash(git:*)", "Read"] });
  assert.deepEqual(granted.active, ["read"]);
  assert.match(granted.policy.warnings[0] ?? "", /"Bash\(git:\*\)" is not supported and grants nothing/);

  const denied = select({ disallowedTools: ["Bash(rm:*)"] });
  assert.deepEqual(denied.active, ["read", "edit", "write"]);
  assert.match(denied.policy.warnings[0] ?? "", /all of Bash is denied/);
});

test("subagent tools are reported as unavailable, and unknown tools as unmatched", () => {
  const definition = agent({ tools: ["Agent(worker, researcher)", "WebSearch", "Read"] });
  assert.match(toolPolicy(definition).warnings[0] ?? "", /"Agent\(worker, researcher\)" is not available in Pi yet/);
  assert.deepEqual(unmatchedTools(definition, registered), ["WebSearch"]);
});

test("homes live in the workspaces directory and cannot leave it", () => {
  const agentDir = "/tmp/pi-agent-dir";
  assert.equal(agentHome("reviewer", agentDir), join(agentDir, "agent-workspaces", "reviewer"));
  for (const name of ["..", ".", "a/b", "a\\b", ""]) assert.throws(() => agentHome(name, agentDir), /cannot be used/);
  assert.equal(homeOwner(join(agentWorkspacesDir(agentDir), "reviewer"), agentDir), "reviewer");
  assert.equal(homeOwner(join(agentWorkspacesDir(agentDir), "reviewer", "src"), agentDir), undefined);
  assert.equal(homeOwner(agentDir, agentDir), undefined);
  assert.equal(homeOwner("/elsewhere/reviewer", agentDir), undefined);
});
