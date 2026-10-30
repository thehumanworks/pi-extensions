import assert from "node:assert/strict";
import test from "node:test";
import { parseDefinition, withHome, permitsTool, checkName } from "../src/definitions.ts";
import { definition } from "./helpers.ts";
const parse = (text: string) => parseDefinition(text, "/defs/tester.md", "/homes");

test("native defaults, independent empty lists, provider/model and thinking", () => {
  const basic = parse(definition());
  assert.equal(basic.home, "/homes/tester");
  assert.equal(basic.tools, undefined); assert.equal(basic.skills, undefined);
  assert.equal(basic.model, undefined); assert.equal(basic.thinking, undefined);
  const limited = parse(definition("tester", 'tools: []\nskills: []\nmodel: openrouter/vendor/model\nthinking: high\nhome: ../memory'));
  assert.deepEqual(limited.tools, []); assert.deepEqual(limited.skills, []);
  assert.equal(limited.model, "openrouter/vendor/model"); assert.equal(limited.thinking, "high");
  assert.equal(limited.home, "/memory");
  assert.equal(permitsTool(limited, "read"), false);
  assert.equal(permitsTool(parse(definition("tester", "skills: []")), "bash"), true);
});

test("Claude comma tools and aliases; Cursor filename defaults and readonly", () => {
  const claude = parse(definition("tester", "tools: Read, Grep, Glob, Bash\ndisallowedTools: Bash\nmodel: sonnet\neffort: high"));
  assert.deepEqual(claude.tools, ["read", "grep", "find", "bash"]);
  assert.equal(permitsTool(claude, "bash"), false);
  assert.equal(claude.model, "sonnet");
  const cursor = parse("---\nmodel: inherit\nreadonly: true\n---\nReview code.");
  assert.equal(cursor.name, "tester"); assert.equal(cursor.description, "");
  assert.equal(permitsTool(cursor, "read"), true); assert.equal(permitsTool(cursor, "bash"), false);
  assert.equal(permitsTool(cursor, "agent_run"), false);
});

test("additive normalization preserves foreign keys, comments and body", () => {
  const raw = definition("tester", "color: blue # retained\ncustom:\n  nested: [a, b]\npermissionMode: plan", "Prompt\n\nSecond paragraph");
  const normalized = withHome(raw, "/fixed");
  const def = parse(normalized);
  assert.equal(def.metadata.color, "blue");
  assert.deepEqual(def.metadata.custom, { nested: ["a", "b"] });
  assert.match(normalized, /# retained/);
  assert.equal(def.prompt, "Prompt\n\nSecond paragraph");
  assert.deepEqual(def.unsupported, ["permissionMode"]);
  assert.equal(def.home, "/fixed");
});

test("malformed definitions and unsafe names fail closed", () => {
  for (const name of ["../oops", "UPPER", "a--b", "", "-x", "a".repeat(65)]) assert.throws(() => checkName(name));
  for (const text of [
    "No frontmatter", "---\na: [\n---\nx", "---\n- a\n---\nx",
    definition("tester", "name: duplicate"), definition("tester", "tools: [1]"),
    definition("tester", "skills: read"), definition("tester", "thinking: gigantic"),
    definition("tester", "readonly: yes"), definition("tester", "tools: Bash(git:*)"),
  ]) assert.throws(() => parse(text));
  assert.equal(parse("\uFEFF" + definition().replaceAll("\n", "\r\n")).name, "tester");
});

test("wildcard tool selection is anchored and applies denylist last", () => {
  const def = parse(definition("tester", "tools: [mcp__docs__*, read]\ndisallowedTools: [mcp__docs__write*]"));
  assert.equal(permitsTool(def, "mcp__docs__search"), true);
  assert.equal(permitsTool(def, "mcp__docs__write"), false);
  assert.equal(permitsTool(def, "bread"), false);
});
