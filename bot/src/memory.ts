import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const MEMORY_LINES = 200;
export const MEMORY_BYTES = 25_000;
const CLOSED = /^(done|closed|complete|completed|cancelled|canceled|abandoned)$/i;
export async function memoryExcerpt(stateDir: string): Promise<string> {
  let text: string;
  try { text = (await readFile(join(stateDir, "MEMORY.md"), "utf8")).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; text = ""; }
  if (!text) return "MEMORY.md is empty. Start it when you learn something worth keeping.";
  const lines = text.split("\n");
  let excerpt = lines.slice(0, MEMORY_LINES).join("\n");
  if (Buffer.byteLength(excerpt) > MEMORY_BYTES) excerpt = Buffer.from(excerpt).subarray(0, MEMORY_BYTES).toString("utf8").replace(/\uFFFD*$/, "");
  return excerpt.length < text.length ? `${excerpt}\n\n[MEMORY.md truncated (${lines.length} lines, ${Buffer.byteLength(text)} bytes). Curate the index to under ${MEMORY_LINES} lines.]` : excerpt;
}
export interface TaskSummary { file: string; title: string; status: string; updated: string }
export async function openTasks(stateDir: string): Promise<TaskSummary[]> {
  const dir = join(stateDir, "tasks"); let files: string[];
  try { files = (await readdir(dir, { withFileTypes: true })).filter(e => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith(".")).map(e => e.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const tasks: TaskSummary[] = [];
  for (const file of files) {
    try {
      const path = join(dir, file);
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(await readFile(path, "utf8"));
      const status = typeof frontmatter.status === "string" ? frontmatter.status : "open";
      if (CLOSED.test(status)) continue;
      const title = String(frontmatter.title ?? frontmatter.goal ?? body.match(/^#\s+(.+)$/m)?.[1] ?? file.replace(/\.md$/, ""));
      tasks.push({ file: `tasks/${file}`, title: title.trim().slice(0, 120), status, updated: (await stat(path)).mtime.toISOString().slice(0, 10) });
    } catch { tasks.push({ file: `tasks/${file}`, title: "(unreadable task)", status: "open", updated: "?" }); }
  }
  return tasks.sort((a, b) => b.updated.localeCompare(a.updated));
}
