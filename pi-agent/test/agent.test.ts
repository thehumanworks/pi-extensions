import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { AgentDefinitionError, loadAgentDefinition, parseAgentDefinition } from "../src/agent.ts";

const agent = (frontmatter: string, body = "Prompt.") => `---\n${frontmatter}\n---\n\n${body}\n`;

describe("parseAgentDefinition", () => {
  test("loads the Claude Code example definition", () => {
    const file = loadAgentDefinition(fileURLToPath(new URL("../agent.md", import.meta.url)));
    assert.deepEqual(file?.definition, {
      name: "code-improver",
      description:
        "Scans files and suggests improvements for readability, performance, and best practices. Use after writing or modifying code.",
      tools: ["Read", "Grep", "Glob"],
      model: "sonnet",
    });
    assert.match(file!.prompt, /^You are a code improvement specialist\./);
    assert.ok(!file!.prompt.endsWith("\n"));
  });

  test("keeps commas inside Agent(...) with their entry", () => {
    const file = parseAgentDefinition(agent("name: coordinator\ndescription: d\ntools: Agent(worker, researcher), Read, Bash"));
    assert.deepEqual(file?.definition.tools, ["Agent(worker, researcher)", "Read", "Bash"]);
  });

  test("accepts YAML lists for list fields", () => {
    const file = parseAgentDefinition(
      agent("name: a\ndescription: d\ntools:\n  - Read\n  - Bash\ndisallowedTools: Write, Edit\nskills:\n  - api-conventions"),
    );
    assert.deepEqual(file?.definition.tools, ["Read", "Bash"]);
    assert.deepEqual(file?.definition.disallowedTools, ["Write", "Edit"]);
    assert.deepEqual(file?.definition.skills, ["api-conventions"]);
  });

  test("omitted tools inherit, empty tools means none", () => {
    assert.equal(parseAgentDefinition(agent("name: a\ndescription: d"))?.definition.tools, undefined);
    assert.deepEqual(parseAgentDefinition(agent("name: a\ndescription: d\ntools: []"))?.definition.tools, []);
  });

  test("parses every documented field", () => {
    const file = parseAgentDefinition(
      agent(
        [
          "name: browser-tester",
          "description: >-",
          "  Tests features",
          "  in a browser",
          "model: inherit",
          "permissionMode: manual",
          "maxTurns: 12",
          "mcpServers:",
          "  - playwright:",
          "      type: stdio",
          "      command: npx",
          '      args: ["-y", "@playwright/mcp@latest"]',
          "  - github",
          "hooks:",
          "  PreToolUse:",
          '    - matcher: "Bash"',
          "      hooks:",
          "        - type: command",
          '          command: "./validate.sh"',
          "  Stop:",
          "    - hooks:",
          "        - type: command",
          "          command: ./done.sh",
          "memory: project",
          "background: true",
          "effort: xhigh",
          "isolation: worktree",
          "color: cyan",
          "initialPrompt: Start with /review",
          "experimental:",
          "  cacheTtl: 1h",
          "x-pi-home: ~/agents/browser",
        ].join("\n"),
      ),
    );
    assert.deepEqual(file?.definition, {
      name: "browser-tester",
      description: "Tests features in a browser",
      model: "inherit",
      permissionMode: "default",
      maxTurns: 12,
      mcpServers: [{ playwright: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] } }, "github"],
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./validate.sh" }] }],
        Stop: [{ hooks: [{ type: "command", command: "./done.sh" }] }],
      },
      memory: "project",
      background: true,
      effort: "xhigh",
      isolation: "worktree",
      color: "cyan",
      initialPrompt: "Start with /review",
      experimental: { cacheTtl: "1h" },
    });
    assert.equal(file?.frontmatter["x-pi-home"], "~/agents/browser");
  });

  test("ignores unsupported cacheTtl values", () => {
    const file = parseAgentDefinition(agent("name: a\ndescription: d\nexperimental:\n  cacheTtl: 2h"));
    assert.deepEqual(file?.definition.experimental, {});
  });

  test("treats files without frontmatter or name as documentation", () => {
    assert.equal(parseAgentDefinition("# Notes\n\nNothing here."), undefined);
    assert.equal(parseAgentDefinition(`\n${agent("name: a\ndescription: d")}`), undefined);
    assert.equal(parseAgentDefinition(agent("description: d")), undefined);
    assert.equal(parseAgentDefinition("---\n---\nBody"), undefined);
  });

  test("handles CRLF line endings, a BOM and a body containing ---", () => {
    const file = parseAgentDefinition("\uFEFF---\r\nname: a\r\ndescription: d\r\n---\r\nOne\r\n---\r\nTwo\r\n");
    assert.equal(file?.definition.name, "a");
    assert.equal(file?.prompt, "One\r\n---\r\nTwo");
  });

  test("rejects files Claude Code skips as invalid", () => {
    const invalid = [
      ["name: -a\ndescription: d", /must not start with "-"/],
      ["name: plugin:a\ndescription: d", /must not contain ":"/],
      ["name: a", /description is required/],
      ["name: a\ndescription: d\n  bad: indent", /invalid frontmatter YAML/],
      ["name: a\ndescription: d\npermissionMode: yolo", /permissionMode must be one of/],
      ["name: a\ndescription: d\nmaxTurns: 0", /maxTurns must be a positive integer/],
      ["name: a\ndescription: d\nbackground: yes please", /background must be true or false/],
      ["name: a\ndescription: d\nmcpServers: github", /mcpServers must be a list/],
      ["name: a\ndescription: d\nhooks:\n  PreToolUse:\n    - matcher: Bash", /needs a hooks list/],
    ] as const;
    for (const [frontmatter, message] of invalid) {
      assert.throws(() => parseAgentDefinition(agent(frontmatter), "x.md"), (error: unknown) => {
        assert.ok(error instanceof AgentDefinitionError);
        assert.match(error.message, /^x\.md: /);
        assert.match(error.message, message);
        return true;
      });
    }
  });
});
