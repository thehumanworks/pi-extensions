import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_HEALTH_RULES, type HealthRules } from "./analysis/health.ts";
import { parseDuration } from "./sdk/time.ts";

export type ToolExposureSetting = "direct" | "codemode";

export interface StatusLineConfig {
  /** Start each session with the status line on: it polls Loggly in the background. /loggly status changes only the current session. */
  enabled: boolean;
  /** Seconds between background health checks. */
  refreshSeconds: number;
  /** Seconds each pressing issue stays on the status line before the next. */
  rotateSeconds: number;
  /** Notify when a new critical issue appears. */
  notify: boolean;
}

export interface TrendsConfig {
  /** At Pi start, save daily trends when this many complete days are waiting. 0 turns it off. */
  saveEveryDays: number;
}

export interface LogglyConfig {
  statusLine: StatusLineConfig;
  health: HealthRules;
  trends: TrendsConfig;
  tools: { exposure: ToolExposureSetting };
}

export const DEFAULT_CONFIG: LogglyConfig = {
  statusLine: { enabled: false, refreshSeconds: 300, rotateSeconds: 8, notify: true },
  health: DEFAULT_HEALTH_RULES,
  trends: { saveEveryDays: 0 },
  tools: { exposure: "direct" },
};

export interface LoadedConfig {
  config: LogglyConfig;
  path: string;
  exists: boolean;
  /** Problems found; affected settings fall back to defaults. */
  problems: string[];
}

export function configPath(): string {
  return join(getAgentDir(), "loggly.json");
}

/** Read the configuration, keeping every valid setting and defaulting the rest. */
export function loadConfig(path = configPath()): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: structuredClone(DEFAULT_CONFIG), path, exists: false, problems: [] };
    return { config: structuredClone(DEFAULT_CONFIG), path, exists: true, problems: [`Could not read ${path}`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { config: structuredClone(DEFAULT_CONFIG), path, exists: true, problems: [`${path} is not valid JSON; using defaults`] };
  }
  const problems: string[] = [];
  return { config: normalizeConfig(raw, problems), path, exists: true, problems };
}

export function normalizeConfig(raw: unknown, problems: string[] = []): LogglyConfig {
  const root = record(raw);
  const status = record(root.statusLine);
  const health = record(root.health);
  const trends = record(root.trends);
  const tools = record(root.tools);
  const d = DEFAULT_CONFIG;
  const h = d.health;
  const read = <T>(source: Record<string, unknown>, section: string, key: string, fallback: T, valid: (value: unknown) => boolean): T => {
    if (source[key] === undefined) return fallback;
    if (valid(source[key])) return source[key] as T;
    problems.push(`${section}.${key} is invalid; using ${JSON.stringify(fallback)}`);
    return fallback;
  };
  const text = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  const duration = (value: unknown, allowZero = false) => {
    if (typeof value !== "string") return false;
    try {
      parseDuration(value, { allowZero });
      return true;
    } catch {
      return false;
    }
  };
  const number = (min: number, max = Number.POSITIVE_INFINITY) => (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  const integer = (min: number, max: number) => (value: unknown) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
  const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");
  return {
    statusLine: {
      enabled: read(status, "statusLine", "enabled", d.statusLine.enabled, (v) => typeof v === "boolean"),
      refreshSeconds: read(status, "statusLine", "refreshSeconds", d.statusLine.refreshSeconds, number(30)),
      rotateSeconds: read(status, "statusLine", "rotateSeconds", d.statusLine.rotateSeconds, number(2)),
      notify: read(status, "statusLine", "notify", d.statusLine.notify, (v) => typeof v === "boolean"),
    },
    health: {
      scope: read(health, "health", "scope", h.scope, text),
      groupBy: read(health, "health", "groupBy", h.groupBy, (v) => text(v) && !/[\s/?#\\]/.test(v as string)),
      errorQuery: read(health, "health", "errorQuery", h.errorQuery, text),
      messageFields: read(health, "health", "messageFields", [...h.messageFields], strings),
      window: read(health, "health", "window", h.window, duration),
      baselineWindows: read(health, "health", "baselineWindows", h.baselineWindows, integer(1, 24)),
      lag: read(health, "health", "lag", h.lag, (v) => duration(v, true)),
      spikeRatio: read(health, "health", "spikeRatio", h.spikeRatio, number(1)),
      criticalRatio: read(health, "health", "criticalRatio", h.criticalRatio, number(1)),
      minErrors: read(health, "health", "minErrors", h.minErrors, number(1)),
      silentMinBaseline: read(health, "health", "silentMinBaseline", h.silentMinBaseline, number(1)),
      silentRatio: read(health, "health", "silentRatio", h.silentRatio, number(0, 1)),
      chronicErrorRate: read(health, "health", "chronicErrorRate", h.chronicErrorRate, number(0, 1)),
      sampleSize: read(health, "health", "sampleSize", h.sampleSize, integer(1, 1000)),
      sampleIssues: read(health, "health", "sampleIssues", h.sampleIssues, integer(0, 10)),
      maxSystems: read(health, "health", "maxSystems", h.maxSystems, integer(1, 300)),
      muted: read(health, "health", "muted", [...h.muted], strings),
    },
    trends: {
      saveEveryDays: read(trends, "trends", "saveEveryDays", d.trends.saveEveryDays, integer(0, 365)),
    },
    tools: {
      exposure: read(tools, "tools", "exposure", d.tools.exposure, (v) => v === "direct" || v === "codemode"),
    },
  };
}

/**
 * Apply a change to the configuration file atomically, preserving keys this
 * version does not know. `update` receives the parsed file (or {}).
 */
export function updateConfigFile(update: (raw: Record<string, unknown>) => void, path = configPath()): LoadedConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = record(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot update ${path}: it is unreadable or not valid JSON`);
  }
  update(raw);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return loadConfig(path);
}

/** Get or create a nested object section of a raw configuration document. */
export function section(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = raw[key];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  const created: Record<string, unknown> = {};
  raw[key] = created;
  return created;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
