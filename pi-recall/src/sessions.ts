import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type ExtensionContext,
  type SessionInfo,
  SessionManager,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import { contentText } from "./format.ts";
import { idFromPath, type Project, type Scope } from "./projects.ts";

export type ReadonlySession = ExtensionContext["sessionManager"];

export interface SessionSummary {
  sessionId: string;
  name?: string;
  /** ISO 8601 */
  created: string;
  /** ISO 8601 time of the last user or assistant message */
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionId?: string;
  /** The project's folder, for sessions of another project. */
  project?: string;
  current?: true;
}

export interface SessionSource {
  summary: SessionSummary;
  current: boolean;
  project: Project;
  load(): Promise<ReadonlySession>;
}

function liveSummary(sm: ReadonlySession): Omit<SessionSummary, "parentSessionId"> {
  const header = sm.getHeader();
  let modified = header ? Date.parse(header.timestamp) : NaN;
  let messageCount = 0;
  let firstMessage = "";
  for (const entry of sm.getEntries()) {
    if (entry.type !== "message") continue;
    messageCount++;
    const { message } = entry;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const time = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
    if (!Number.isNaN(time)) modified = Number.isNaN(modified) ? time : Math.max(modified, time);
    if (!firstMessage && message.role === "user") firstMessage = contentText(message.content);
  }
  const now = new Date().toISOString();
  return {
    sessionId: sm.getSessionId(),
    name: sm.getSessionName(),
    created: header?.timestamp ?? now,
    modified: Number.isNaN(modified) ? now : new Date(modified).toISOString(),
    messageCount,
    firstMessage: firstMessage || "(no messages)",
    current: true,
  };
}

/** Reads a session file without SessionManager.open, which can rewrite old-format files. */
async function openReadonly(info: SessionInfo, cwd: string, signal?: AbortSignal): Promise<ReadonlySession> {
  const content = await readFile(info.path, { encoding: "utf8", signal });
  return SessionManager.inMemory(info.cwd || cwd, undefined, parseSessionEntries(content));
}

/**
 * The sessions of these projects, most recently active first. The current session comes first if its project
 * is among them, read live since its file may lag behind memory or not exist yet.
 */
export async function listSessions(sm: ReadonlySession, projects: Project[], signal?: AbortSignal): Promise<SessionSource[]> {
  const cwd = resolve(sm.getCwd());
  const byDir = new Map<string, Project[]>();
  for (const project of projects) byDir.set(project.sessionDir, [...(byDir.get(project.sessionDir) ?? []), project]);
  // A folder that several of these projects share is read once and split by each session's working directory.
  const listed = (await Promise.all([...byDir].map(async ([dir, shared]) => {
    if (shared.length === 1) {
      return [{ project: shared[0]!, infos: await SessionManager.list(shared[0]!.path, dir || undefined, undefined, signal) }];
    }
    const infos = await SessionManager.listAll(dir, undefined, signal);
    return shared.map((project) => ({ project, infos: infos.filter((info) => info.cwd && resolve(info.cwd) === project.path) }));
  }))).flat();
  const idsByPath = new Map(listed.flatMap(({ infos }) => infos.map((info) => [info.path, info.id] as const)));
  const parentId = (path: string | undefined) => (path ? (idsByPath.get(path) ?? idFromPath(path)) : undefined);

  const currentId = sm.getSessionId();
  const others = listed
    .flatMap(({ project, infos }) => infos.filter((info) => info.id !== currentId).map((info): SessionSource => {
      let loaded: Promise<ReadonlySession> | undefined;
      return {
        summary: {
          sessionId: info.id,
          name: info.name,
          created: info.created.toISOString(),
          modified: info.modified.toISOString(),
          messageCount: info.messageCount,
          firstMessage: info.firstMessage,
          parentSessionId: parentId(info.parentSessionPath),
          ...(project.path !== cwd ? { project: project.path } : {}),
        },
        current: false,
        project,
        load: () => (loaded ??= openReadonly(info, project.path, signal)),
      };
    }))
    .sort((a, b) => b.summary.modified.localeCompare(a.summary.modified));

  const project = projects.find((p) => p.path === cwd);
  if (!project) return others;
  const current: SessionSource = {
    summary: { ...liveSummary(sm), parentSessionId: parentId(sm.getHeader()?.parentSession) },
    current: true,
    project,
    load: async () => sm,
  };
  return [current, ...others];
}

/** The sessions a read of this session id needs: these if it is among them, otherwise its project's. */
export async function sourcesWith(
  sm: ReadonlySession,
  scope: Scope,
  sources: SessionSource[],
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionSource[]> {
  if (sources.some((source) => source.summary.sessionId === sessionId)) return sources;
  const project = scope.index.sessions.get(sessionId);
  if (!project) throw new Error(`Session ${sessionId} not found`);
  return listSessions(sm, [project], signal);
}
