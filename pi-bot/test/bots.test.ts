import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  applyTextEdits, archiveBot, botForSessionDir, botsRoot, createBot, isInside, listBots, loadBot, parseBot, serializeBot, updateBot,
  validateName, writeDefinition, type BotDefinition,
} from "../src/bots.ts";
import { persona, tempRoot } from "./helpers.ts";

test("BOT.md round-trips awkward values and keeps unknown frontmatter", () => {
  const bot: BotDefinition = {
    name: "reviewer",
    description: "Reviews diffs: security, \"correctness\" # and style",
    model: "openai/gpt-6.1-sol",
    thinking: "off",
    tools: ["read", "mcp__radius__*", "bash"],
    skills: ["~/skills/review", "add-pi-extension"],
    prompt: persona,
    extra: { color: "blue", version: 2, nested: { a: [1, "two"] } },
  };
  const text = serializeBot(bot);
  assert.match(text, /^---\nname: reviewer\n/);
  assert.match(text, /thinking: "off"/);
  assert.deepEqual(parseBot(text, "reviewer"), bot);
});

test("parseBot accepts comma lists and the effort alias, and rejects bad levels", () => {
  const parsed = parseBot("---\nname: other\ndescription: Does things\neffort: high\ntools: read, bash\n---\nBody", "dir-name");
  assert.equal(parsed.name, "dir-name");
  assert.equal(parsed.thinking, "high");
  assert.deepEqual(parsed.tools, ["read", "bash"]);
  assert.throws(() => parseBot("---\ndescription: x\nthinking: extreme\n---\nBody", "a"), /Invalid thinking level/);
});

test("names are validated and subcommand names are reserved", () => {
  assert.equal(validateName("code-reviewer_2"), "code-reviewer_2");
  for (const bad of ["Reviewer", "-x", "a/b", "", "x".repeat(64)]) assert.throws(() => validateName(bad), /Invalid bot name/);
  for (const reserved of ["list", "new", "exit", "resume"]) assert.throws(() => validateName(reserved), /reserved/);
});

test("createBot scaffolds the home and refuses duplicates", async t => {
  const root = await tempRoot(t);
  assert.equal(botsRoot(), root);
  const bot = await createBot({ name: "reviewer", description: "Reviews diffs", prompt: persona, thinking: "high" });
  for (const path of ["BOT.md", "MEMORY.md", "memory", "skills", "scripts/README.md", "tasks", "journal", "sessions"]) assert.ok(existsSync(join(bot.home, path)), path);
  assert.equal((await loadBot("reviewer")).thinking, "high");
  await assert.rejects(createBot({ name: "reviewer", description: "x", prompt: "y" }), /already exists/);
  await assert.rejects(createBot({ name: "empty", description: " ", prompt: "y" }), /description/);
  await assert.rejects(loadBot("missing"), /Unknown bot "missing"/);
});

test("updateBot patches fields; null and empty lists clear settings", async t => {
  await tempRoot(t);
  await createBot({ name: "a", description: "Job", prompt: persona, model: "openai/x", thinking: "low", tools: ["read"], skills: ["s"] });
  const updated = await updateBot("a", { description: "New job", model: null, thinking: null, tools: [], skills: null });
  assert.equal(updated.description, "New job");
  assert.equal(updated.prompt, persona);
  const reloaded = await loadBot("a");
  assert.deepEqual([reloaded.model, reloaded.thinking, reloaded.tools, reloaded.skills], [undefined, undefined, undefined, undefined]);
  await assert.rejects(updateBot("a", { prompt: "  " }), /persona/);
});

test("text edits match once against the original and must not overlap", () => {
  const text = "Be direct.\nCite file:line.\nBe kind.";
  assert.equal(applyTextEdits(text, [{ oldText: "Be kind.", newText: "Be brief." }, { oldText: "Be direct.", newText: "Be blunt." }]), "Be blunt.\nCite file:line.\nBe brief.");
  assert.throws(() => applyTextEdits(text, [{ oldText: "Be ", newText: "" }]), /matches more than once/);
  assert.throws(() => applyTextEdits(text, [{ oldText: "missing", newText: "" }]), /Edit 1: oldText was not found/);
  assert.throws(() => applyTextEdits(text, [{ oldText: "", newText: "x" }]), /empty/);
  assert.throws(() => applyTextEdits(text, [{ oldText: "Cite file", newText: "" }, { oldText: "file:line", newText: "" }]), /overlap/);
});

test("updateBot applies persona edits and rejects mixing them with a full prompt", async t => {
  await tempRoot(t);
  await createBot({ name: "a", description: "Job", prompt: persona });
  const edited = await updateBot("a", { edits: [{ oldText: "Be direct.", newText: "Be direct and cite file:line." }] });
  assert.equal(edited.prompt, "You review code for correctness.\n\nBe direct and cite file:line.");
  assert.equal((await loadBot("a")).prompt, edited.prompt);
  await assert.rejects(updateBot("a", { prompt: "x", edits: [{ oldText: "Be", newText: "x" }] }), /either prompt .* or edits/);
});

test("writeDefinition validates edited text; archiveBot moves the home aside", async t => {
  const root = await tempRoot(t);
  const bot = await createBot({ name: "a", description: "Job", prompt: persona });
  await assert.rejects(writeDefinition("a", "---\nmodel: x\n---\nBody"), /description/);
  await writeDefinition("a", "---\ndescription: Edited\n---\nNew persona");
  assert.equal((await loadBot("a")).prompt, "New persona");
  const target = await archiveBot("a");
  assert.ok(!existsSync(bot.home));
  assert.ok(existsSync(join(target, "BOT.md")));
  assert.equal(dirname(target), join(root, ".archive"));
  assert.deepEqual((await listBots()).bots, []);
});

test("listBots skips non-bot directories and reports invalid definitions", async t => {
  const root = await tempRoot(t);
  await createBot({ name: "good", description: "Job", prompt: persona });
  await mkdir(join(root, "no-definition"), { recursive: true });
  await mkdir(join(root, "broken"), { recursive: true });
  await writeFile(join(root, "broken", "BOT.md"), "---\ndescription: x\nthinking: loud\n---\nBody");
  const { bots, errors } = await listBots();
  assert.deepEqual(bots.map(bot => bot.name), ["good"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /^broken: Invalid thinking level/);
});

test("session directories identify their bot, through symlinks too", async t => {
  const root = await tempRoot(t);
  await mkdir(join(root, "reviewer", "sessions"), { recursive: true });
  assert.equal(botForSessionDir(join(root, "reviewer", "sessions"), root), "reviewer");
  assert.equal(botForSessionDir(join(root, "reviewer", "sessions", "nested"), root), undefined);
  assert.equal(botForSessionDir(join(root, "reviewer"), root), undefined);
  assert.equal(botForSessionDir(join(root, "..", "elsewhere", "sessions"), root), undefined);
  assert.equal(botForSessionDir(undefined, root), undefined);
  const link = join(dirname(root), "link");
  await symlink(root, link);
  assert.equal(botForSessionDir(join(link, "reviewer", "sessions"), root), "reviewer");
});

test("isInside handles files that do not exist yet and parent escapes", async t => {
  const root = await tempRoot(t);
  const home = join(root, "a");
  await mkdir(home, { recursive: true });
  assert.ok(isInside(join(home, "memory", "new.md"), home));
  assert.ok(isInside(home, home));
  assert.ok(!isInside(join(home, "..", "b", "x.md"), home));
  assert.ok(!isInside(join(root, "ab"), home));
  assert.match(await readFile(join(await createBot({ name: "c", description: "d", prompt: "p" }).then(b => b.home), "MEMORY.md"), "utf8"), /Memory index/);
});
