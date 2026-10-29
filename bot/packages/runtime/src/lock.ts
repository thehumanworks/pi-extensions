import { open, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { BotError, botError } from "./errors.js";

/**
 * Kernel advisory lock, not a racy PID-file unlink protocol. The inherited fd shares
 * its open-file description with flock(1); the parent retains the lock after the
 * child exits. Files are NEVER unlinked, including after a crash. Stale PIDs are
 * informational; only the kernel decides ownership. Requires Unix flock(1).
 */
export async function acquireLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  let file;
  try { file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
  catch (error) { throw botError(error, "CONFLICT"); }
  const metadata = await file.stat();
  if (!metadata.isFile() || metadata.nlink !== 1) { await file.close(); throw new BotError("CONFLICT", "Ownership locks must be regular, singly linked files (no symlinks/hardlinks)."); }
  const result = spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "pipe", "pipe", file.fd] });
  if (result.error || result.status !== 0) {
    const buffer = Buffer.alloc(1024);
    const owner = await file.read(buffer, 0, buffer.length, 0).then(read => buffer.subarray(0, read.bytesRead).toString("utf8")).catch(() => "unknown owner");
    await file.close();
    if (result.error) throw new BotError("UNAVAILABLE", `Cannot acquire bot ownership: flock(1) is required: ${result.error.message}`);
    if (result.status !== 1) throw new BotError("UNAVAILABLE", `flock failed: ${result.stderr?.toString() ?? result.status}`);
    throw new BotError("CONFLICT", `Bot is already open (${path}; ${owner.trim() || "unknown owner"}).`);
  }
  try {
    await file.truncate(0);
    await file.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
  } catch (error) { await file.close(); throw botError(error, "UNAVAILABLE"); }
  let released = false;
  return async () => { if (!released) { released = true; await file.close(); } };
}
