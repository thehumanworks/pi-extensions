import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import createDocumentExtension, { registerCreateDocument } from "../index.ts";

type Result = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; details?: Record<string, unknown> };
type Tool = {
  name: string;
  exposure?: string;
  namespace?: { name: string };
  parameters: { properties: Record<string, unknown>; required?: string[] };
  annotations?: Record<string, boolean>;
  promptGuidelines?: string[];
  execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: { cwd: string }) => Promise<Result>;
};

const dir = mkdtempSync(join(tmpdir(), "pi-create-document-ext-"));
const temps: string[] = [];
after(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const path of temps) rmSync(path, { recursive: true, force: true });
});

function fakePi() {
  const tools = new Map<string, Tool>();
  const events: string[] = [];
  const pi = { registerTool: (tool: Tool) => tools.set(tool.name, tool), on: (event: string) => events.push(event) };
  return { pi: pi as never, tools, events };
}

test("the extension registers create, convert and read tools in one namespace", () => {
  const { pi, tools, events } = fakePi();
  createDocumentExtension(pi);
  assert.deepEqual([...tools.keys()], ["create_document", "convert_document", "read_document"]);
  assert.deepEqual(events, [], "nothing starts until a tool is used");
  for (const tool of tools.values()) assert.equal(tool.namespace?.name, "documents");
  assert.deepEqual(tools.get("create_document")!.parameters.required, ["path", "content"]);
  assert.deepEqual(tools.get("convert_document")!.parameters.required, ["input", "output"]);
  assert.equal(tools.get("read_document")!.annotations?.readOnlyHint, true);
  assert.equal(tools.get("create_document")!.annotations?.destructiveHint, true, "overwrite can replace files");
  assert.ok(tools.get("create_document")!.promptGuidelines!.some((line) => line.includes("```mermaid")));

  const custom = fakePi();
  registerCreateDocument(custom.pi, { exposure: "search" as never });
  assert.equal(custom.tools.get("read_document")!.exposure, "search");
});

test("create_document writes relative to the session directory and reports the file", async () => {
  const { pi, tools } = fakePi();
  createDocumentExtension(pi);
  const result = await tools.get("create_document")!.execute("1", { path: "out/report.docx", content: "# Report\n\n| A | B |\n|---|---|\n| 1 | 2 |\n" }, undefined, undefined, { cwd: dir });
  assert.ok(existsSync(join(dir, "out/report.docx")));
  assert.match(result.content[0]!.text, /^Created out\/report\.docx \(DOCX, \d+(\.\d+)?KB\)$/);
  assert.equal(result.structuredContent?.format, "docx");
  assert.deepEqual((result.structuredContent?.files as Array<{ path: string }>).map((file) => file.path), [join(dir, "out/report.docx")]);

  await assert.rejects(tools.get("create_document")!.execute("2", { path: "out/report.docx", content: "# Again" }, undefined, undefined, { cwd: dir }), /already exists/);
});

test("convert_document and read_document work on the files it wrote", async () => {
  const { pi, tools } = fakePi();
  createDocumentExtension(pi);
  await tools.get("create_document")!.execute("1", { path: "deck.md", content: "# Deck\n\n## One\n\n- a\n- b\n\n## Two\n\nText\n" }, undefined, undefined, { cwd: dir });
  const converted = await tools.get("convert_document")!.execute("2", { input: "deck.md", output: "deck.pptx" }, undefined, undefined, { cwd: dir });
  assert.match(converted.content[0]!.text, /^Wrote deck\.pptx \(PPTX, 3 slides, /);
  const read = await tools.get("read_document")!.execute("3", { path: "deck.pptx" }, undefined, undefined, { cwd: dir });
  assert.match(read.content[0]!.text, /^deck\.pptx \(PPTX, .*3 slides read\)\n\n# Deck\n/);
  assert.match(read.content[0]!.text, /## One\n\n- a\n- b/);
});

test("read_document truncates long documents and saves the full text", async () => {
  const { pi, tools } = fakePi();
  createDocumentExtension(pi);
  const rows = Array.from({ length: 2600 }, (_, i) => `${i},value ${i}`).join("\n");
  await tools.get("create_document")!.execute("1", { path: "big.csv", content: `id,name\n${rows}\n`, contentFormat: "csv" }, undefined, undefined, { cwd: dir });
  const read = await tools.get("read_document")!.execute("2", { path: "big.csv" }, undefined, undefined, { cwd: dir });
  const details = read.details as { fullOutputPath?: string };
  assert.ok(details.fullOutputPath);
  temps.push(join(details.fullOutputPath!, ".."));
  assert.match(read.content[0]!.text, /\[Truncated: showing \d+ of \d+ lines .* Full Markdown: /);
  assert.doesNotMatch(read.content[0]!.text, /value 2599 /);
  assert.match(readFileSync(details.fullOutputPath!, "utf8"), /\| 2599 \| value 2599 \|\n$/);
});
