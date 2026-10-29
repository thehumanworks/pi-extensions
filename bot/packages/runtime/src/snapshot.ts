import { mkdir, open, opendir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { constants } from "node:fs";
import { BotError } from "./errors.js";
import { canonicalPath, isInside } from "./paths.js";

/**
 * Snapshot policy: root authoring/config/docs plus tools/extensions/lib/skills/scripts/assets/evals.
 * No arbitrary workspace tree. Assets in those directories may be binary.
 * Credential-like names, dotfiles (except authoring config), dependencies and SDK state are excluded.
 * File sizes are unbounded. Count limits are hard failures, never silently incomplete snapshots.
 */
export const SNAPSHOT_POLICY = { maxFiles: 2048, maxEntries: 10_000 } as const;
const roots = new Set(["tools", "extensions", "lib", "skills", "scripts", "assets", "evals"]);
export function excludedSourceName(name: string): boolean {
  return name === "node_modules" || name === ".git" || name === ".bot" || name.startsWith(".sdk-") ||
    /^\.env/i.test(name) || /^(?:auth|credentials?|secrets?|models-store)\.json$/i.test(name) ||
    /(?:^|[._-])(?:credentials?|secrets?|api[-_]?keys?|tokens?)(?:[._-]|$)/i.test(name) && !/\.[cm]?[jt]sx?$/.test(name) ||
    /\.(?:pem|key|p12|pfx|sqlite|sqlite3|db)(?:-(?:wal|shm))?$/i.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/.test(name);
}
export function rootSourceFile(name: string): boolean {
  return name === ".gitignore" || /\.(?:[cm]?tsx?|[cm]?jsx?|json|md|ya?ml)$/.test(name) || ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"].includes(name);
}
export async function snapshotSource(sourceDir: string, stateDir: string, agentDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const omitted = [stateDir, agentDir].map(canonicalPath).filter(path => path !== canonicalPath(sourceDir) && !isInside(sourceDir, path));
  let count = 0, visited = 0;
  async function walk(path: string, root: boolean): Promise<void> {
    const entries = [];
    for await (const entry of await opendir(path)) {
      if (++visited > SNAPSHOT_POLICY.maxEntries) throw new BotError("INVALID_INPUT", "Bot snapshot exceeds the 10000-entry scan limit; move non-capability files outside the source.");
      entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    if (!root && entries.some(entry => entry.name === ".sdk-state.lock" || entry.name === "runtime.sqlite")) return;
    for (const entry of entries) {
      if (excludedSourceName(entry.name) || (entry.name.startsWith(".") && entry.name !== ".gitignore")) continue;
      if (root && !roots.has(entry.name) && !rootSourceFile(entry.name)) continue;
      if (root && canonicalPath(sourceDir) === canonicalPath(agentDir) && ["models.json", "settings.json", "mcp.json"].includes(entry.name)) continue;
      const file = join(path, entry.name);
      if (omitted.some(dir => isInside(file, dir))) continue;
      if (entry.isSymbolicLink()) throw new BotError("INVALID_INPUT", `Symlinked capability source is unsupported: ${file}`);
      if (entry.isDirectory()) { await walk(file, false); continue; }
      if (!entry.isFile()) throw new BotError("INVALID_INPUT", `Capability source must contain regular files: ${file}`);
      if (++count > SNAPSHOT_POLICY.maxFiles) throw new BotError("INVALID_INPUT", "Bot snapshot exceeds the 2048-file limit.");
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let content: Buffer;
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) throw new BotError("INVALID_INPUT", `Snapshot source is no longer a regular file: ${file}`);
        const size = metadata.size;
        // The extra byte detects a file that grows after stat().
        content = Buffer.alloc(size + 1);
        const read = await handle.read(content, 0, content.length, 0);
        content = content.subarray(0, read.bytesRead);
        if (read.bytesRead !== size || (await handle.stat()).size !== size) throw new BotError("CONFLICT", `Source file changed while snapshotting: ${file}`);
      } finally { await handle.close(); }
      files[relative(sourceDir, file)] = content.toString("base64");
    }
  }
  await walk(sourceDir, true);
  return files;
}
export async function materializeSource(sourceDir: string, files: Record<string, string>): Promise<void> {
  for (const [file, contents] of Object.entries(files)) {
    const target = join(sourceDir, file);
    if (!isInside(target, sourceDir)) throw new BotError("INVALID_INPUT", "Invalid snapshot path.");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(contents, "base64"));
  }
}
