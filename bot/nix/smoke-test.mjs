// Exercise the installed CLI, not the build tree, with no host tools or credentials.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [executable, version] = process.argv.slice(2);
const home = mkdtempSync(join(tmpdir(), "bot-nix-smoke-"));
const source = join(home, "reviewer");
const env = {
  HOME: home,
  PATH: "",
  PI_CODING_AGENT_DIR: join(home, "agent"),
  PI_OFFLINE: "1",
};
const cli = (...args) => execFileSync(executable, args, {
  cwd: home,
  env,
  encoding: "utf8",
  timeout: 30_000,
});
const tool = (name, input) => JSON.parse(cli(
  "tool", "call", source, name, "--input", JSON.stringify(input), "--json",
));

try {
  assert.equal(cli("--version").trim(), version);
  assert.match(cli("--help"), /Usage: bot/);
  cli("init", source);
  assert.match(cli("validate", source), /Valid:/);
  assert.equal(JSON.parse(cli("info", source, "--json")).sourceDir, source);

  // Selecting a catalog model requires no credentials for direct tool calls.
  // This opens the real worker and SQLite runtime without a provider request.
  writeFileSync(join(source, "BOT.md"), `---
format: 2
name: reviewer
description: Nix smoke test
model: openai/gpt-4o
inherit: none
builtinTools: [bash, find, grep]
maintenance: false
---
Test the installed tools.
`);
  mkdirSync(join(home, "workspace"));
  writeFileSync(join(home, "workspace", "example.txt"), "nix-smoke-marker\n");
  const result = tool("bash", {
    command: "printf nix-smoke-shell; node --version; flock --version",
  });
  assert.notEqual(result.isError, true);
  assert.match(JSON.stringify(result), /nix-smoke-shell/);
  assert.match(JSON.stringify(result), /flock/);
  assert.match(JSON.stringify(tool("find", { pattern: "*.txt", path: "./workspace" })), /example.txt/);
  assert.match(JSON.stringify(tool("grep", { pattern: "nix-smoke-marker", path: "./workspace" })), /example.txt/);
  assert.deepEqual(JSON.parse(cli("sessions", "list", source, "--json")), []);
} finally {
  rmSync(home, { recursive: true, force: true });
}
