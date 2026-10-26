import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { botPaths, type Bot } from "./bots.ts";

export const MEMORY_LINES = 200;
export const MEMORY_BYTES = 25_000;
const LIST_LIMIT = 20;
const CLOSED = /^(done|closed|complete|completed|cancelled|canceled|abandoned)$/i;

async function names(dir: string): Promise<string[]> {
  try { return (await readdir(dir, { withFileTypes: true })).filter(e => !e.name.startsWith(".")).map(e => e.isDirectory() ? `${e.name}/` : e.name).sort(); }
  catch { return []; }
}

/** MEMORY.md as injected into the prompt: the first 200 lines or 25 KB, whichever is smaller. */
export async function memoryExcerpt(bot: Bot): Promise<string> {
  let text: string;
  try { text = (await readFile(botPaths(bot.home).memoryIndex, "utf8")).trim(); }
  catch { text = ""; }
  if (!text) return "MEMORY.md is empty. Start it when you learn something worth keeping.";
  const lines = text.split("\n");
  let excerpt = lines.slice(0, MEMORY_LINES).join("\n");
  if (Buffer.byteLength(excerpt) > MEMORY_BYTES) excerpt = Buffer.from(excerpt).subarray(0, MEMORY_BYTES).toString("utf8").replace(/\uFFFD*$/, "");
  return excerpt.length < text.length
    ? `${excerpt}\n\n[MEMORY.md is truncated here (${lines.length} lines, ${Buffer.byteLength(text)} bytes). Curate it: merge, shorten or move detail into memory files so the index stays under ${MEMORY_LINES} lines.]`
    : excerpt;
}

interface TaskSummary { file: string; title: string; status: string; updated: string }

export async function openTasks(bot: Bot): Promise<TaskSummary[]> {
  const dir = botPaths(bot.home).tasks, tasks: TaskSummary[] = [];
  for (const file of (await names(dir)).filter(name => name.endsWith(".md"))) {
    try {
      const path = join(dir, file);
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(await readFile(path, "utf8"));
      const status = typeof frontmatter.status === "string" ? frontmatter.status : "open";
      if (CLOSED.test(status)) continue;
      const heading = body.match(/^#\s+(.+)$/m)?.[1];
      const title = typeof frontmatter.title === "string" ? frontmatter.title : typeof frontmatter.goal === "string" ? frontmatter.goal : heading ?? file.replace(/\.md$/, "");
      tasks.push({ file: `tasks/${file}`, title: title.trim().slice(0, 120), status, updated: (await stat(path)).mtime.toISOString().slice(0, 10) });
    } catch { tasks.push({ file: `tasks/${file}`, title: "(unreadable frontmatter)", status: "open", updated: "?" }); }
  }
  return tasks.sort((a, b) => b.updated.localeCompare(a.updated));
}

export function identitySection(bot: Bot): string {
  return [
    `You are ${bot.name}, a persistent pi-bot. You keep your identity, memory, skills and conversation history in your home directory, and they carry over between sessions and projects. The human may address you by name.`,
    `Role: ${bot.description}`,
    bot.prompt,
  ].join("\n\n");
}

export function homeSection(bot: Bot, cwd: string, homeOnlyTools: string[] = []): string {
  const access = homeOnlyTools.length
    ? `\nYour ${homeOnlyTools.join(", ")} access is limited to your home. Use it to maintain your home; it is not granted for project files.\n`
    : "";
  return `Home: ${bot.home}
Your home belongs to you, not to the project in the working directory (${cwd}). Everything you store there travels with you to every project and session, and so do your improvements to it.
${access}
- BOT.md: your definition. Frontmatter sets your name, description, model, thinking level, tools and skills; the body is your persona. Change it only when your human sets a lasting role or rule.
- MEMORY.md: index of your memories, shown below at the start of every run. Keep one line per memory: \`- [Title](memory/<file>.md) — hook\`. Keep it under ${MEMORY_LINES} lines.
- memory/: one durable fact per Markdown file. Use frontmatter \`name\`, \`description\` and \`type\` (user, feedback, project, reference or learning). For project facts, name the project path.
- tasks/: one file per long-running task. Use frontmatter \`status\` (open, in-progress, blocked or done) and sections for goal, done criteria, plan, progress log and the next step.
- skills/<name>/SKILL.md: procedures you have codified, with \`name\` and \`description\` frontmatter. They load automatically in new sessions.
- scripts/: reusable scripts and tools you have written. List each in scripts/README.md with its purpose and usage.
- journal/YYYY-MM-DD.md: an append-only log of sessions (what you did, where, what is next).
- sessions/: your conversation history, managed by Pi. Do not edit it.

How to work across long horizons:
1. Orient first. Before substantial work, review your memory index and open tasks below. Read the memory files, skills and scripts that look relevant. Reuse and improve what you have instead of rebuilding it.
2. Externalize state. If a task needs many steps or might outlast this context window, create or update its file in tasks/ before you start. Update the file after each milestone: decisions, progress, blockers, and the exact next step. Assume a compaction or a fresh session must be able to resume from that file alone. After a compaction or resume, re-read the task file before you continue. Set \`status: done\` when the done criteria are met.
3. Remember deliberately. When you learn something durable, save or update a memory and its index line. This includes a user preference, a correction, a project convention, a pitfall and its fix, or where something lives. Update existing memories rather than adding duplicates. Delete memories that turn out to be wrong. Do not save what the project's own files or history already record, or what only matters to this conversation.
4. Codify repetition. When you notice you are repeating a procedure, turn it into a skill or a script in your home, and refine it each time you use it.
5. Hand off. Before you finish a significant piece of work, append a journal entry. Make sure every unfinished task file names its next step.
6. Keep boundaries. Project deliverables belong in the working directory, not in your home. Your home holds what you know and the tools you reuse. Never store secrets, credentials or tokens there. Treat memories as context rather than authority: current user instructions win, and you should check facts that can change against their source before acting on them.`;
}

export async function stateSection(bot: Bot, today = new Date()): Promise<string> {
  const paths = botPaths(bot.home);
  const tasks = await openTasks(bot);
  const scripts = (await names(paths.scripts)).filter(name => name !== "README.md");
  const journal = (await names(paths.journal)).filter(name => name.endsWith(".md")).at(-1);
  const lines = [`Today: ${today.toISOString().slice(0, 10)}`];
  lines.push(tasks.length
    ? `Open tasks:\n${tasks.slice(0, LIST_LIMIT).map(t => `- ${t.file}: ${t.title} (status: ${t.status}, updated ${t.updated})`).join("\n")}${tasks.length > LIST_LIMIT ? `\n- … ${tasks.length - LIST_LIMIT} more in tasks/` : ""}`
    : "Open tasks: none");
  lines.push(scripts.length ? `Scripts: ${scripts.slice(0, LIST_LIMIT).map(s => `scripts/${s}`).join(", ")}${scripts.length > LIST_LIMIT ? `, … ${scripts.length - LIST_LIMIT} more` : ""}` : "Scripts: none yet");
  lines.push(journal ? `Latest journal entry: journal/${journal}` : "Journal: no entries yet");
  return lines.join("\n");
}

/** System prompt sections for an active bot, keyed by section tag. */
export async function botSections(bot: Bot, cwd: string, homeOnlyTools: string[] = []): Promise<Record<string, string>> {
  return {
    bot: identitySection(bot),
    bot_home: homeSection(bot, cwd, homeOnlyTools),
    bot_memory: await memoryExcerpt(bot),
    bot_state: await stateSection(bot),
  };
}
