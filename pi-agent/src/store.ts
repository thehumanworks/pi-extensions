import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkName, parseDefinition, withHome, type Definition } from "./definitions.ts";
import { atomicWrite, digest, readOptional, withLock } from "./storage.ts";

export interface AgentInfo { name: string; description: string; home: string; file: string; warnings: string[] }
interface Approved { source: string; origin: string }
export interface Candidate { source: string; base: string; revision: string }
export interface Roster { agents: AgentInfo[]; diagnostics: string[] }

async function markdownFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 8) return [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    else if (entry.isDirectory()) files.push(...await markdownFiles(path, depth + 1));
  }
  return files;
}

export class AgentStore {
  readonly homes: string;
  constructor(readonly root: string, readonly agentDir: string) { this.homes = join(root, "homes"); }
  file(name: string): string { return join(this.root, `${checkName(name)}.md`); }
  state(name: string): string { return join(this.root, ".state", checkName(name)); }
  private approvedPath(name: string) { return join(this.state(name), "approved.json"); }
  private pendingPath(name: string) { return join(this.state(name), "pending.json"); }
  private tombstone(name: string) { return join(this.root, ".deleted", checkName(name)); }
  parse(source: string, name: string): Definition { return parseDefinition(source, this.file(name), this.homes); }

  async list(cwd?: string): Promise<Roster> {
    const dirs = [this.root];
    if (cwd) {
      let dir = resolve(cwd);
      while (true) {
        dirs.push(...[".pi", ".cursor", ".claude"].map(p => join(dir, p, "agents")));
        if (await stat(join(dir, ".git")).then(() => true, () => false) || dirname(dir) === dir) break;
        dir = dirname(dir);
      }
    }
    dirs.push(join(homedir(), ".cursor", "agents"), join(homedir(), ".claude", "agents"));
    const found = new Map<string, AgentInfo>();
    const diagnostics: string[] = [];
    for (const dir of [...new Set(dirs)]) {
      // Managed roster is flat; homes may contain unrelated Markdown files.
      const paths = dir === this.root
        ? (await readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; })).filter(e => e.isFile() && e.name.endsWith(".md")).map(e => join(dir, e.name))
        : await markdownFiles(dir);
      for (const file of paths) {
        try {
          const source = (await readOptional(file))!;
          const def = parseDefinition(source, file, this.homes);
          if (await readOptional(this.tombstone(def.name)) !== undefined) continue;
          if (found.has(def.name)) { diagnostics.push(`Shadowed agent '${def.name}': ${file}`); continue; }
          found.set(def.name, { name: def.name, description: def.description, home: def.home, file, warnings: def.warnings });
        } catch (e) { diagnostics.push(`${file}: ${String(e)}`); }
      }
    }
    return { agents: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
  }

  /** Import on first explicit use. Subsequent on-disk changes never replace the approved revision. */
  async ensure(name: string, cwd?: string): Promise<Definition> {
    checkName(name);
    const saved = await readOptional(this.approvedPath(name));
    if (await readOptional(this.tombstone(name)) !== undefined) throw new Error(`Agent '${name}' was deleted; use a new name.`);
    if (saved) return this.parse((JSON.parse(saved) as Approved).source, name);
    return withLock(this.root, `definition:${name}`, async () => {
      const again = await readOptional(this.approvedPath(name));
      if (again) return this.parse((JSON.parse(again) as Approved).source, name);
      const roster = await this.list(cwd);
      const info = roster.agents.find(a => a.name === name);
      if (!info) throw new Error(`Unknown agent '${name}'. ${roster.diagnostics.join("\n")}`);
      const raw = (await readOptional(info.file))!;
      const def = parseDefinition(raw, info.file, this.homes);
      const source = withHome(raw, def.home);
      await this.save(name, source, info.file);
      return this.parse(source, name);
    });
  }

  private async save(name: string, source: string, origin: string): Promise<void> {
    await atomicWrite(this.file(name), source);
    await atomicWrite(this.approvedPath(name), JSON.stringify({ source, origin } satisfies Approved));
  }

  async create(name: string, source: string): Promise<Definition> {
    checkName(name);
    const def = this.parse(source, name);
    if (def.name !== name) throw new Error("Definition name must match the requested name.");
    return withLock(this.root, `definition:${name}`, async () => {
      if (await readOptional(this.file(name)) !== undefined || await readOptional(this.approvedPath(name)) !== undefined || await readOptional(this.tombstone(name)) !== undefined) throw new Error(`Agent '${name}' already exists or was archived.`);
      const normalized = withHome(source, def.home);
      await this.save(name, normalized, this.file(name));
      return this.parse(normalized, name);
    });
  }

  async source(name: string): Promise<string> {
    const raw = await readOptional(this.approvedPath(name));
    if (!raw) throw new Error(`Agent '${name}' has not been imported.`);
    return (JSON.parse(raw) as Approved).source;
  }

  /** All edits, not just self-edits, require approval, preventing proxy-agent bypasses. */
  async propose(name: string, source: string): Promise<Candidate> {
    const def = this.parse(source, name);
    if (def.name !== name) throw new Error("Renaming agents is not supported; create a new agent.");
    return withLock(this.root, `definition:${name}`, async () => {
      const base = await this.source(name);
      if (def.home !== this.parse(base, name).home) throw new Error("Agent homes are immutable to preserve history. Create a new agent for another home.");
      const candidate = { source: withHome(source, def.home), base: digest(base), revision: "" };
      candidate.revision = digest(candidate.base + candidate.source);
      await atomicWrite(this.pendingPath(name), JSON.stringify(candidate));
      return candidate;
    });
  }

  async candidate(name: string): Promise<Candidate | undefined> {
    const base = await this.source(name);
    const pending = await readOptional(this.pendingPath(name));
    if (pending) {
      const candidate = JSON.parse(pending) as Candidate;
      if (typeof candidate.source !== "string" || candidate.revision !== digest(candidate.base + candidate.source)) throw new Error("Invalid proposal revision; refusing approval.");
      return candidate;
    }
    const disk = await readOptional(this.file(name));
    if (disk !== undefined && disk !== base) return { source: disk, base: digest(base), revision: digest(digest(base) + disk) };
    return undefined;
  }

  /** Called only by a human-confirmed command with the revision displayed to that human. */
  async approve(name: string, revision: string): Promise<void> {
    await withLock(this.root, `definition:${name}`, async () => {
      const candidate = await this.candidate(name);
      if (!candidate || candidate.revision !== revision || digest(await this.source(name)) !== candidate.base) throw new Error("Proposal changed; review it again.");
      const def = this.parse(candidate.source, name);
      const old = this.parse(await this.source(name), name);
      if (def.name !== name || def.home !== old.home) throw new Error("Approval cannot change agent identity or home.");
      await this.save(name, candidate.source, this.file(name));
      await rm(this.pendingPath(name), { force: true });
    });
  }

  async reject(name: string, revision: string): Promise<void> {
    await withLock(this.root, `definition:${name}`, async () => {
      const candidate = await this.candidate(name);
      if (!candidate || candidate.revision !== revision) throw new Error("Proposal changed; review it again.");
      await atomicWrite(this.file(name), await this.source(name));
      await rm(this.pendingPath(name), { force: true });
    });
  }

  /** Archive registry state, never recursively delete an arbitrary user-specified home. */
  async archive(name: string): Promise<string> {
    return withLock(this.root, `run:${name}`, () => withLock(this.root, `definition:${name}`, async () => {
      await this.source(name);
      const dest = join(this.root, ".archive", `${Date.now()}-${name}`);
      await mkdir(dest, { recursive: true, mode: 0o700 });
      await atomicWrite(this.tombstone(name), dest);
      await rename(this.state(name), join(dest, "state"));
      if (await readOptional(this.file(name)) !== undefined) await rename(this.file(name), join(dest, `${name}.md`));
      return dest;
    }));
  }
}
