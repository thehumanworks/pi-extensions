import { lstat, mkdir, readFile, realpath, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Deep-merge plain objects one level at a time so `{ capture: { model } }` keeps sibling keys such as `capture.onCompact`. */
export function mergeSettings(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...current };
  for (const [key, value] of Object.entries(patch)) result[key] = isObject(value) && isObject(current[key]) ? mergeSettings(current[key], value) : value;
  return result;
}

/** Merge only our settings, using Pi's settings lock and preserving existing symlinks. */
export async function saveSettings(agentDir: string, patch: Record<string, unknown>): Promise<void> {
  const path = join(agentDir, "settings.json");
  await mkdir(agentDir, { recursive: true });
  await withFileMutationQueue(path, async () => {
    const lock = `${path}.lock`;
    await mkdir(lock);
    try {
      let target = path, current: Record<string, unknown> = {}, mode = 0o600;
      try {
        await lstat(path); target = await realpath(path); mode = (await stat(target)).mode & 0o777;
        current = JSON.parse(await readFile(target, "utf8"));
        if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("Invalid settings.json");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const memory = current.memory;
      if (memory !== undefined && (!memory || typeof memory !== "object" || Array.isArray(memory))) throw new Error("Invalid memory settings");
      const tmp = `${target}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify({ ...current, memory: mergeSettings((memory ?? {}) as Record<string, unknown>, patch) }, null, 2) + "\n", { mode, flag: "wx" });
      await rename(tmp, target);
    } finally { await rmdir(lock); }
  });
}
