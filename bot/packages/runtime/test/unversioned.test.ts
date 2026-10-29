import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as answer } from "@earendil-works/pi-ai/providers/faux";
import { parseDefinition, validateBot } from "../src/project.js";
import { listBots, editBot } from "../src/catalog.js";
import { openBot } from "../src/runtime.js";
import { main } from "../src/cli.js";
import { fixture, scripted } from "./helpers.js";

const definition = (format = "") => `---\n${format}name: tester\ndescription: Unversioned bot\nmodel: faux/faux-1\ntools: []\nskills: []\n---\n\nTest persona.\n`;

test("omitted format and numeric 2 parse identically; explicit unsupported values fail", () => {
  assert.deepEqual(parseDefinition(definition(), "/source"), parseDefinition(definition("format: 2\n"), "/source"));
  for (const value of ["null", '"2"', "0", "1", "3", "false", "[]", "{}", ""]) {
    assert.throws(() => parseDefinition(definition(`format: ${value}\n`), "/source"), /Unsupported BOT.md format/, value);
  }
  assert.throws(() => parseDefinition("---\ndescription: Missing name\n---\nPersona", "/source"), /needs a name/);
  assert.throws(() => parseDefinition("---\nname: tester\n---\nPersona", "/source"), /needs a description/);
  assert.throws(() => parseDefinition("---\nname: tester\ndescription: Empty\n---\n", "/source"), /needs a persona/);
});

test("unversioned source validates through SDK and CLI without rewriting the file", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const file = join(f.source, "BOT.md"); await writeFile(file, definition());
  assert.equal((await validateBot(f.source, { agentDir: f.agentDir })).format, 2);
  let stdout = "", stderr = "";
  const code = await main(["validate", f.source], {
    stdout: { write(chunk) { stdout += chunk.toString(); return true; } },
    stderr: { write(chunk) { stderr += chunk.toString(); return true; } },
  });
  assert.equal(code, 0, stderr); assert.match(stdout, /Valid: tester/); assert.equal(stderr, "");
  assert.equal(await readFile(file, "utf8"), definition());
});

test("Pi's shared catalog lists and edits unversioned definitions without adding a format", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const file = join(f.source, "BOT.md"); await writeFile(file, definition());
  const listing = await listBots(f.root);
  assert.deepEqual(listing.errors, []); assert.equal(listing.bots.length, 1);
  await editBot(f.source, { prompt: "Edited persona." });
  const edited = await readFile(file, "utf8");
  assert.doesNotMatch(edited, /format/);
  assert.equal(parseDefinition(edited, f.source).prompt, "Edited persona.");
  // Complete-definition replacement must accept omitted format too.
  await editBot(f.source, { definition: definition() });
  assert.equal(await readFile(file, "utf8"), definition());
});

test("unversioned bots execute, reload and reopen durable history with an offline model", async t => {
  const f = await fixture(); t.after(f.cleanup);
  await writeFile(join(f.source, "BOT.md"), definition());
  const { models } = scripted([answer("First"), answer("Continued")]);
  let bot = await openBot(f.source, { models, agentDir: f.agentDir, cwd: f.cwd });
  t.after(() => bot.close());
  const first = await bot.run("hello");
  assert.equal(first.status, "completed", first.error); assert.equal(first.output, "First");
  await editBot(f.source, { prompt: "Changed unversioned persona." });
  assert.equal((await bot.reload()).changed, true);
  await bot.close();
  bot = await openBot(f.source, { models, agentDir: f.agentDir });
  assert.equal((await bot.info()).format, 2);
  assert.equal((await bot.getRun(first.runId)).output, "First");
  const next = await bot.run("continue", { session: first.sessionId });
  assert.equal(next.status, "completed", next.error); assert.equal(next.output, "Continued");
});
