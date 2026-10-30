import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Result files hold production log data: delete them after a day. */
export const RESULTS_MAX_AGE_MS = 24 * 3_600_000;

const RESULT_FILE = /^[a-z]+-[\w-]+\.jsonl$/;

export function defaultResultsDir(): string {
  return join(tmpdir(), `pi-loggly-${process.getuid?.() ?? "user"}`);
}

/** Write JSON lines to a new private file, then delete expired ones. Returns the path. */
export async function writeResultFile(dir: string, name: string, lines: readonly string[], now = Date.now()): Promise<string> {
  await ensurePrivateDir(dir);
  const path = join(dir, `${name}-${new Date(now).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.jsonl`);
  await writeFile(path, lines.join("\n") + "\n", { mode: 0o600, flag: "wx" });
  await pruneResults(dir, RESULTS_MAX_AGE_MS, now).catch(() => 0);
  return path;
}

/** Delete result files older than maxAgeMs. Returns how many were deleted. */
export async function pruneResults(dir: string, maxAgeMs = RESULTS_MAX_AGE_MS, now = Date.now()): Promise<number> {
  if (!(await isPrivateDir(dir))) return 0;
  let deleted = 0;
  for (const name of await readdir(dir)) {
    if (!RESULT_FILE.test(name)) continue;
    const path = join(dir, name);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile() || now - info.mtimeMs <= maxAgeMs) continue;
    await unlink(path).then(() => deleted++, () => {});
  }
  return deleted;
}

/**
 * Create the directory if needed and check it is a real directory owned by
 * this user and closed to others, since /tmp is shared.
 */
async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await isPrivateDir(dir))) throw new Error(`Refusing to write log data to ${dir}: it must be a directory owned by you with mode 700`);
}

async function isPrivateDir(dir: string): Promise<boolean> {
  const info = await lstat(dir).catch(() => undefined);
  const uid = process.getuid?.();
  return !!info && info.isDirectory() && (uid === undefined || info.uid === uid) && (info.mode & 0o077) === 0;
}
