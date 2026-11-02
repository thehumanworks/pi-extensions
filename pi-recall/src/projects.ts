import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

type ReadonlySession = ExtensionContext["sessionManager"];
/** What finding the projects to read needs: the session, and whether the project's own settings may be read. */
export type ScopeContext = Pick<ExtensionContext, "sessionManager" | "isProjectTrusted">;

/** A folder pi was started in, which pi keeps sessions for. */
export interface Project {
  path: string;
  /** pi's folder for the project's session files. */
  sessionDir: string;
}

export interface ProjectIndex {
  current: Project;
  /** Every project with saved sessions, and the current one. */
  projects: Project[];
  /** The project each saved session belongs to, and the current session's, by session id. */
  sessions: Map<string, Project>;
  /** Each saved session's file, by session id. */
  files: Map<string, string>;
}

/** The setting in pi's settings files that names the projects whose history a project recalls with its own. */
export const SETTINGS_KEY = "recallConfig";
/** The project argument that reads every project. */
export const ALL_PROJECTS = "all";
/** The longest header line read: pi writes it first, with the session's working directory. */
const HEADER_BYTES = 64 * 1024;

/** pi's folder name for a project's sessions in its default layout. */
export const sessionFolderName = (cwd: string) => `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

/** Session files are named `<timestamp>_<sessionId>.jsonl`. */
export function idFromPath(path: string): string | undefined {
  return basename(path, ".jsonl").split("_").slice(1).join("_") || undefined;
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** The working directory a session file's header records. */
async function headerCwd(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, "r");
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEADER_BYTES), 0, HEADER_BYTES, 0);
    const header = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0]!);
    return header?.type === "session" && typeof header.cwd === "string" && header.cwd ? resolve(header.cwd) : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/**
 * The projects on this machine, from session file names and headers. In pi's default layout each project has
 * its own folder, so one header per folder names the project; a session directory set in pi's settings holds
 * every project's sessions, so each file's header is read.
 */
export async function projectIndex(sm: ReadonlySession): Promise<ProjectIndex> {
  const dir = sm.getSessionDir();
  const current: Project = { path: resolve(sm.getCwd()), sessionDir: dir };
  const byPath = new Map<string, Project>([[current.path, current]]);
  const sessions = new Map<string, Project>([[sm.getSessionId(), current]]);
  const paths = new Map<string, string>();
  const add = (path: string, sessionDir: string, files: string[]) => {
    let project = byPath.get(path);
    if (!project) byPath.set(path, (project = { path, sessionDir }));
    for (const file of files) {
      const id = idFromPath(file);
      if (!id) continue;
      if (!sessions.has(id)) sessions.set(id, project);
      paths.set(id, join(sessionDir, file));
    }
  };

  if (dir && basename(dir) === sessionFolderName(current.path)) {
    const root = dirname(dir);
    await Promise.all((await list(root)).map(async (name) => {
      const sessionDir = join(root, name);
      const files = (await list(sessionDir)).filter((file) => file.endsWith(".jsonl"));
      if (files.length === 0) return;
      if (sessionDir === dir) return add(current.path, dir, files);
      for (const file of files) {
        const cwd = await headerCwd(join(sessionDir, file));
        if (cwd) return add(cwd, sessionDir, files);
      }
    }));
  } else if (dir) {
    const files = (await list(dir)).filter((file) => file.endsWith(".jsonl"));
    const cwds = await Promise.all(files.map((file) => headerCwd(join(dir, file))));
    files.forEach((file, i) => {
      if (cwds[i]) add(cwds[i]!, dir, [file]);
    });
  }
  return { current, projects: [...byPath.values()], sessions, files: paths };
}

const segments = (path: string) => path.split(/[/\\]/).filter(Boolean);

function endsWith(project: Project, tail: string[]): boolean {
  const parts = segments(project.path);
  return tail.length <= parts.length && tail.every((part, i) => parts[parts.length - tail.length + i] === part);
}

/**
 * The projects a name refers to. A path starting with /, ~, ./ or ../ names one folder, relative to base;
 * anything else names the projects whose path ends with it, such as "pi-memory" or "pi-extensions/pi-memory".
 */
export function matchProjects(name: string, projects: Project[], base: string): Project[] {
  if (/^(\/|~(\/|$)|\.\.?(\/|$))/.test(name)) {
    const path = resolve(base, name.replace(/^~(?=\/|$)/, homedir()));
    return projects.filter((project) => project.path === path);
  }
  const tail = segments(name);
  return tail.length === 0 ? [] : projects.filter((project) => endsWith(project, tail));
}

/** The shortest end of the project's path that no other project's path ends with. */
export function projectName(project: Project, projects: Project[]): string {
  const parts = segments(project.path);
  for (let n = 1; n <= parts.length; n++) {
    const tail = parts.slice(-n);
    if (projects.filter((other) => endsWith(other, tail)).length === 1) return tail.join("/");
  }
  return project.path;
}

/** pi's settings files that may name projects to recall: the global one, and the project's own if it is trusted. */
export function settingsFiles(cwd: string, trusted: boolean, agentDir = getAgentDir()): string[] {
  return [join(agentDir, "settings.json"), ...(trusted ? [join(cwd, CONFIG_DIR_NAME, "settings.json")] : [])];
}

async function readSettings(file: string): Promise<Record<string, unknown> | undefined> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const settings: unknown = JSON.parse(content.replace(/^\uFEFF/, ""));
    return settings && typeof settings === "object" ? (settings as Record<string, unknown>) : undefined;
  } catch (error) {
    throw new Error(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every((name) => typeof name === "string");

/**
 * The names of the projects to recall with this one, from recallConfig in each settings file. A list names them
 * for every project the file applies to: the project whose settings it is, or every project in the global
 * settings. A map names them for the projects each key names, as a path or the last folders of one.
 */
export async function readRecallConfig(current: Project, trusted: boolean, agentDir?: string): Promise<string[]> {
  const names: string[] = [];
  for (const file of settingsFiles(current.path, trusted, agentDir)) {
    const config = (await readSettings(file))?.[SETTINGS_KEY];
    if (config === undefined) continue;
    const invalid = () => new Error(
      `${SETTINGS_KEY} in ${file} must map projects to lists of projects, like {"~/code/app": ["app-old"]}, or be one list`,
    );
    if (isNames(config)) {
      names.push(...config);
      continue;
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw invalid();
    for (const [key, value] of Object.entries(config)) {
      if (!isNames(value)) throw invalid();
      if (matchProjects(key, [current], current.path).length > 0) names.push(...value);
    }
  }
  return names;
}

export interface Scope {
  index: ProjectIndex;
  projects: Project[];
}

/**
 * The projects to read. Without a project, this one and those recallConfig names for it; "all" for every project;
 * otherwise the one project the name matches.
 */
export async function resolveScope(ctx: ScopeContext, project?: string, index?: ProjectIndex): Promise<Scope> {
  index ??= await projectIndex(ctx.sessionManager);
  const { current, projects } = index;
  if (project === undefined) {
    const names = await readRecallConfig(current, ctx.isProjectTrusted());
    const named = names.flatMap((name) => matchProjects(name, projects, current.path));
    return { index, projects: [...new Set([current, ...named])] };
  }
  if (project === ALL_PROJECTS) return { index, projects };
  const matches = matchProjects(project, projects, current.path);
  if (matches.length === 1) return { index, projects: matches };
  if (matches.length > 1) {
    throw new Error(`"${project}" matches ${matches.length} projects: ${matches.map((p) => p.path).join(", ")}. Pass more of the path.`);
  }
  const lower = project.toLowerCase();
  const near = projects.filter((p) => p.path.toLowerCase().includes(lower)).slice(0, 5).map((p) => p.path);
  throw new Error(
    `No project matches "${project}". Pass a path, the last folders of one, or "${ALL_PROJECTS}".` +
      (near.length > 0 ? ` Projects whose path contains it: ${near.join(", ")}` : ""),
  );
}
