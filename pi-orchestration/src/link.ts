import { constants } from "node:fs";
import { access, mkdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { BIN_PATH } from "./guide.ts";

async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return (await stat(path)).isFile(); } catch { return false; }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

/** The first `workflow` executable on PATH, as the shell would find it. */
export async function findCommand(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(resolve(directory), "workflow");
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

/** How a shell reaches this package's CLI: `workflow` when PATH finds this copy, else an explicit node command. */
export async function shellCommand(env: NodeJS.ProcessEnv, bin = BIN_PATH): Promise<string> {
  const found = await findCommand(env);
  if (found && await realpath(found).catch(() => "") === await realpath(bin).catch(() => bin)) return "workflow";
  return `node ${bin}`;
}

export interface LinkOptions {
  env: NodeJS.ProcessEnv;
  /** Holds the marker that records a link was made. */
  stateDir: string;
  bin?: string;
  home?: string;
  platform?: NodeJS.Platform;
}

/**
 * Pi installs packages without linking their binaries. Link `workflow` into
 * ~/.local/bin or ~/bin when one of them is on PATH and nothing else on PATH is
 * called `workflow`. A marker records the link, so deleting it opts out: it is
 * never recreated.
 */
export async function linkCli(options: LinkOptions): Promise<string | undefined> {
  if ((options.platform ?? process.platform) === "win32") return undefined;
  if (await findCommand(options.env)) return undefined;
  const marker = join(options.stateDir, "cli-link.json");
  if (await exists(marker)) return undefined;
  const home = resolve(options.home ?? options.env.HOME ?? homedir());
  const preferred = new Set([join(home, ".local", "bin"), join(home, "bin")]);
  const path = (options.env.PATH ?? "").split(delimiter).filter(Boolean).map(entry => resolve(entry));
  let directory: string | undefined;
  for (const entry of path) {
    if (preferred.has(entry) && await stat(entry).then(info => info.isDirectory(), () => false)) { directory = entry; break; }
  }
  const bin = options.bin ?? BIN_PATH;
  if (!directory || !await executable(bin)) return undefined;
  const link = join(directory, "workflow");
  try { await symlink(bin, link); }
  catch (error) {
    // Never replace a file someone else put there, even a non-executable one.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  await writeFile(marker, JSON.stringify({ link, target: bin }) + "\n");
  return link;
}
