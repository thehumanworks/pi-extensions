/** ChatGPT's Codex Frameless Bidi (v3), NOT the public Realtime API. */
export const SIGNALING_URL =
  "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
export const VOICE_MODEL = "gpt-live-1-codex";
export const CONTEXT_BYTES = 500;
export type Role = "user" | "assistant";
export type Channel = "commentary" | "speakable";
export type ClientMessage =
  | { type: "session.close" }
  | {
      type: "session.context.append" | "delegation.context.append";
      delegation_item_id?: string;
      channel: Channel;
      content: { type: "input_text"; text: string }[];
    };
export type ServerEvent =
  | { type: "ready" }
  | { type: "transcript"; role: Role; text: string; id?: string; final: boolean }
  | { type: "delegation"; id: string; text: string }
  | { type: "error" };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseEvent(payload: string): ServerEvent | undefined {
  let value: unknown;
  try { value = JSON.parse(payload); } catch { return; }
  if (!record(value)) return;
  switch (value.type) {
    case "session.started":
    case "session.updated":
      return { type: "ready" };
    case "input_transcript.added":
    case "output_transcript.added": {
      const item = value.item;
      if (!record(item) || typeof item.text !== "string") return;
      return {
        type: "transcript", role: value.type === "input_transcript.added" ? "user" : "assistant",
        text: item.text, id: typeof item.id === "string" ? item.id : undefined, final: false,
      };
    }
    case "turn.done": {
      const turn = value.turn;
      if (!record(turn) || (turn.role !== "user" && turn.role !== "assistant") ||
          typeof turn.transcript !== "string") return;
      return {
        type: "transcript", role: turn.role, text: turn.transcript,
        id: typeof turn.id === "string" ? turn.id : undefined, final: true,
      };
    }
    case "delegation.created": {
      const item = value.item;
      if (!record(item) || item.type !== "delegation" || item.target !== "client" ||
          typeof item.id !== "string" || !Array.isArray(item.content)) return;
      const text = item.content.filter(record)
        .filter(c => c.type === "input_text" && typeof c.text === "string")
        .map(c => c.text as string).join("\n").trim();
      return text ? { type: "delegation", id: item.id, text } : undefined;
    }
    case "error":
      // Never surface raw provider payloads: they can echo SDP, auth, or conversation data.
      return { type: "error" };
    default:
      // Audio is rendered by the native RTP track; don't play output_audio.delta twice.
      return;
  }
}

export function sessionPayload(instructions: string, voice: string) {
  return { model: VOICE_MODEL, instructions, audio: { output: { voice } }, delegation: { type: "client" } };
}

export function parseCallId(location: string | null): string {
  if (location) {
    const id = location.split(/[?#]/, 1)[0]?.split("/").find(part =>
      /^rtc_[\w-]+$/.test(part) ||
      /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(part));
    if (id) return id;
  }
  throw new Error("ChatGPT voice signaling returned no valid call ID.");
}

export function sidebandUrl(callId: string): string {
  return `wss://api.openai.com/v1/live/${encodeURIComponent(callId)}`;
}

/** Preserve code points and keep each append within the server's UTF-8 byte limit. */
export function chunks(text: string, maxBytes = CONTEXT_BYTES): string[] {
  if (maxBytes < 4) throw new Error("Chunk limit must accommodate a UTF-8 code point.");
  const result: string[] = [];
  let chunk = "", bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) { result.push(chunk); chunk = ""; bytes = 0; }
    chunk += char; bytes += size;
  }
  if (chunk) result.push(chunk);
  return result;
}

export function contextMessages(text: string, channel: Channel, delegationId?: string): ClientMessage[] {
  return chunks(text).map(chunk => ({
    type: delegationId ? "delegation.context.append" : "session.context.append",
    ...(delegationId ? { delegation_item_id: delegationId } : {}),
    channel, content: [{ type: "input_text", text: chunk }],
  }));
}
