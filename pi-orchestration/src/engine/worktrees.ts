import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkflowError } from "../errors.ts";

const execute = promisify(execFile);
export interface Worktree { path: string; branch: string }
export function worktreeSuffix(label: string): string {
  const clean = label.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+/, "").slice(0, 64) || "agent";
  return clean === label ? clean : `${clean}-${createHash("sha256").update(label).digest("hex").slice(0, 8)}`;
}
async function git(cwd: string, args: string[]): Promise<string> {
  try { return (await execute("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
  catch (error) {
    const details = error as Error & { stderr?: string };
    throw new WorkflowError("worktree_error", `git ${args[0]} failed in ${cwd}: ${details.stderr?.trim() || details.message}`);
  }
}
async function exists(path: string): Promise<boolean> {
  try { await realpath(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
/** Resolve symlinks in the existing prefix, so paths compare like Git's real-path listing. */
async function canonical(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(absolute) === absolute) throw error;
    return join(await canonical(dirname(absolute)), basename(absolute));
  }
}
async function listWorktrees(cwd: string): Promise<string[]> {
  const listed = (await git(cwd, ["worktree", "list", "--porcelain", "-z"])).split("\0").filter(line => line.startsWith("worktree ")).map(line => line.slice(9));
  return Promise.all(listed.map(canonical));
}
export async function ensureWorktree(options: { home: string; runId: string; key: string; label?: string; cwd: string }): Promise<Worktree> {
  if (!/^[a-zA-Z0-9_-]+$/.test(options.runId)) throw new WorkflowError("worktree_error", "Invalid run ID for a worktree path.");
  const suffix = worktreeSuffix(options.label ?? options.key);
  const path = await canonical(join(options.home, "worktrees", options.runId, suffix));
  const branch = `orch/${options.runId}/${suffix}`;
  const common = await realpath(await git(options.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const listed = await listWorktrees(options.cwd);
  if (await exists(path)) {
    const foundCommon = await realpath(await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    const foundBranch = await git(path, ["symbolic-ref", "--short", "HEAD"]);
    if (!listed.includes(path) || foundCommon !== common || foundBranch !== branch) {
      throw new WorkflowError("worktree_conflict", `Refusing to reuse ${path}: it is not the expected ${branch} worktree. Move it aside or use a different agent label.`);
    }
    return { path, branch };
  }
  if (listed.includes(path)) throw new WorkflowError("worktree_conflict", `Git still records missing worktree ${path}. Repair it before retrying.`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let branchExists = false;
  try { await execute("git", ["-C", options.cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]); branchExists = true; }
  catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
  await git(options.cwd, branchExists ? ["worktree", "add", "--", path, branch] : ["worktree", "add", "--no-track", "-b", branch, "--", path, "HEAD"]);
  return { path, branch };
}
export async function removeWorktree(cwd: string, worktree: Worktree): Promise<void> {
  const listed = await listWorktrees(cwd);
  if (!listed.includes(await canonical(worktree.path))) {
    if (await exists(worktree.path)) throw new WorkflowError("worktree_conflict", `Refusing to remove unregistered directory ${worktree.path}.`);
    return;
  }
  if (await exists(worktree.path)) {
    const branch = await git(worktree.path, ["symbolic-ref", "--short", "HEAD"]);
    if (branch !== worktree.branch) throw new WorkflowError("worktree_conflict", `Worktree ${worktree.path} now uses branch ${branch}; expected ${worktree.branch}.`);
  }
  await git(cwd, ["worktree", "remove", "--force", "--", worktree.path]);
}
