import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBot } from "../src/bots.ts";
import { botSections, MEMORY_BYTES, MEMORY_LINES, memoryExcerpt, openTasks, stateSection } from "../src/prompt.ts";
import { persona, tempRoot } from "./helpers.ts";

test("sections name the home, persona and persistence protocol", async t => {
  await tempRoot(t);
  const bot = await createBot({ name: "reviewer", description: "Reviews diffs", prompt: persona });
  const sections = await botSections(bot, "/work/project", ["write", "edit"]);
  assert.deepEqual(Object.keys(sections), ["bot", "bot_home", "bot_memory", "bot_state"]);
  assert.match(sections.bot!, /^You are reviewer, a persistent pi-bot/);
  assert.match(sections.bot!, /Role: Reviews diffs/);
  assert.ok(sections.bot!.endsWith(persona));
  assert.ok(sections.bot_home!.startsWith(`Home: ${bot.home}\n`));
  assert.match(sections.bot_home!, /working directory \(\/work\/project\)/);
  assert.match(sections.bot_home!, /Your write, edit access is limited to your home/);
  for (const phrase of ["tasks/", "MEMORY.md", "skills/<name>/SKILL.md", "scripts/README.md", "journal/YYYY-MM-DD.md", "Do not edit it", "re-read the task file", "Never store secrets"]) {
    assert.ok(sections.bot_home!.includes(phrase), phrase);
  }
  assert.match(sections.bot_memory!, /Memory index/);
  assert.match(sections.bot_state!, /Open tasks: none/);
});

test("the home section omits the access note when the bot keeps full tools", async t => {
  await tempRoot(t);
  const bot = await createBot({ name: "a", description: "Job", prompt: persona });
  assert.doesNotMatch((await botSections(bot, "/w")).bot_home!, /limited to your home/);
});

test("MEMORY.md is capped at 200 lines and 25 KB with a curation notice", async t => {
  await tempRoot(t);
  const bot = await createBot({ name: "a", description: "Job", prompt: persona });
  const index = join(bot.home, "MEMORY.md");
  await writeFile(index, "");
  assert.match(await memoryExcerpt(bot), /MEMORY.md is empty/);
  await writeFile(index, Array.from({ length: 300 }, (_, i) => `- [M${i}](memory/m${i}.md) — hook`).join("\n"));
  const byLines = await memoryExcerpt(bot);
  assert.match(byLines, /- \[M199\]/);
  assert.doesNotMatch(byLines, /- \[M200\]/);
  assert.match(byLines, /truncated here \(300 lines/);
  await writeFile(index, Array.from({ length: 50 }, () => "é".repeat(400)).join("\n"));
  const byBytes = await memoryExcerpt(bot);
  const kept = byBytes.split("\n\n[MEMORY.md is truncated")[0]!;
  assert.ok(Buffer.byteLength(kept) <= MEMORY_BYTES);
  assert.ok(!kept.includes("\uFFFD"));
  assert.equal(MEMORY_LINES, 200);
});

test("state lists open tasks newest first, scripts and the latest journal entry", async t => {
  await tempRoot(t);
  const bot = await createBot({ name: "a", description: "Job", prompt: persona });
  await writeFile(join(bot.home, "tasks", "migrate.md"), "---\nstatus: in-progress\n---\n# Migrate auth to OAuth\n");
  await writeFile(join(bot.home, "tasks", "old.md"), "---\nstatus: done\n---\n# Finished\n");
  await writeFile(join(bot.home, "tasks", "plain.md"), "No frontmatter here");
  await writeFile(join(bot.home, "scripts", "bench.sh"), "#!/bin/sh\n");
  await writeFile(join(bot.home, "journal", "2026-10-24.md"), "x");
  await writeFile(join(bot.home, "journal", "2026-10-25.md"), "y");
  const tasks = await openTasks(bot);
  assert.deepEqual(tasks.map(task => [task.file, task.title, task.status]).sort(), [["tasks/migrate.md", "Migrate auth to OAuth", "in-progress"], ["tasks/plain.md", "plain", "open"]]);
  const state = await stateSection(bot, new Date("2026-10-25T12:00:00Z"));
  assert.match(state, /^Today: 2026-10-25/);
  assert.match(state, /- tasks\/migrate\.md: Migrate auth to OAuth \(status: in-progress/);
  assert.doesNotMatch(state, /old\.md/);
  assert.match(state, /Scripts: scripts\/bench\.sh$/m);
  assert.match(state, /Latest journal entry: journal\/2026-10-25\.md/);
});
