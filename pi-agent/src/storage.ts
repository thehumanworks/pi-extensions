import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

/** Heartbeating cross-process lock; never wait on another running agent (avoids delegation deadlocks). */
export async function withLock<T>(root: string, key: string, operation: (signal: AbortSignal) => Promise<T>, retries = 0): Promise<T> {
  const locks = join(root, ".locks");
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  const release = await lockfile.lock(join(locks, digest(key)), {
    realpath: false, stale: 30_000, update: 5_000, retries: { retries, factor: 1, minTimeout: 20, maxTimeout: 40, randomize: true },
    onCompromised: error => controller.abort(error),
  });
  try {
    const result = await operation(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally { await release(); }
}
