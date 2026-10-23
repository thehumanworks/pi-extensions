import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { KeyId } from "@earendil-works/pi-tui";

export const VOICES = ["arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale"] as const;
export interface VoiceSettings { muteKey: KeyId; voice: string }
export const DEFAULT_SETTINGS: VoiceSettings = { muteKey: "ctrl+x", voice: "sol" };

/** Require a modified shortcut or function key, so ordinary typing still works. */
export function isMuteKey(value: string): value is KeyId {
  if (["ctrl+c", "ctrl+d", "ctrl+z"].includes(value)) return false;
  const rest = value.replace(/^(?:(?:ctrl|alt|shift|super)\+)+/, "");
  const modifiers = value.slice(0, value.length - rest.length).split("+").filter(Boolean);
  if (!modifiers.length) return /^f(?:[1-9]|1[0-2])$/.test(value);
  if (new Set(modifiers).size !== modifiers.length ||
      !modifiers.some(m => m === "ctrl" || m === "alt" || m === "super")) return false;
  return /^[a-z0-9]$/.test(rest) || /^[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]$/.test(rest) ||
    /^(?:space|enter|return|tab|escape|esc|backspace|delete|insert|clear|home|end|pageUp|pageDown|up|down|left|right|f(?:[1-9]|1[0-2]))$/.test(rest);
}

export async function readSettings(path: string): Promise<VoiceSettings> {
  let data: unknown;
  try { data = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SETTINGS };
    throw new Error(`Cannot read voice settings at ${path}. Fix the JSON or remove this file.`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Voice settings must be a JSON object.");
  const value = data as Record<string, unknown>;
  const muteKey = value.muteKey ?? DEFAULT_SETTINGS.muteKey;
  const voice = value.voice ?? DEFAULT_SETTINGS.voice;
  if (typeof muteKey !== "string" || !isMuteKey(muteKey)) throw new Error("Invalid voice muteKey; use a modified key such as ctrl+x or f9.");
  if (typeof voice !== "string" || !(VOICES as readonly string[]).includes(voice)) throw new Error(`Invalid voice; choose ${VOICES.join(", ")}.`);
  return { muteKey, voice };
}

export async function writeSettings(path: string, settings: VoiceSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}
