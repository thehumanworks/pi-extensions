import { existsSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { BotError } from "./errors.js";

export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
export function botsRoot(): string { return resolve(expandHome(process.env.PI_BOT_HOME ?? join(getAgentDir(), "bots"))); }
export function botPaths(sourceDir: string, stateDir = join(sourceDir, ".bot")) {
  return { definition: join(sourceDir, "BOT.md"), state: stateDir, memoryIndex: join(stateDir, "MEMORY.md"),
    memory: join(stateDir, "memory"), tasks: join(stateDir, "tasks"), journal: join(stateDir, "journal"),
    skills: join(sourceDir, "skills"), scripts: join(sourceDir, "scripts"), sessions: join(stateDir, "sessions") };
}
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
}
/** Symlink-aware path hygiene, not an adversarial filesystem sandbox. */
export function isInside(path: string, dir: string): boolean {
  const rel = relative(canonicalPath(dir), canonicalPath(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
}
export async function resolveSource(source: string): Promise<string> {
  if (typeof source !== "string" || !source.trim()) throw new BotError("INVALID_INPUT", "A bot source path or name is required.");
  let path = resolve(expandHome(source));
  if (!existsSync(path) && !source.includes("/") && !source.includes("\\")) path = join(botsRoot(), source);
  if (basename(path) === "BOT.md") path = dirname(path);
  try { return await realpath(path); } catch (error) { throw new BotError("NOT_FOUND", `Unknown bot source ${source} (looked in ${path}).`, { cause: error }); }
}
