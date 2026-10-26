import { LOGIN_HINT, type VoiceAuth } from "./auth.ts";
import { type NativeAudio, loadNativeAudio } from "./native.ts";
import { rms, safeText } from "./text.ts";

/**
 * ChatGPT's own dictation endpoint: plain HTTPS with the Codex ChatGPT login, so it
 * works where realtime WebRTC media (UDP) is blocked. Never an API key.
 */
export const TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
export const SAMPLE_RATE = 16_000;
export const MAX_SECONDS = 300;
const MIN_SECONDS = 0.3;

export interface DictationState {
  phase: "ready" | "recording" | "transcribing" | "off";
  muted: boolean;
  inputLevel: number;
  outputLevel: number;
  /** Recording start, for the elapsed-time display. */
  startedAt?: number;
}
export interface DictationOptions {
  auth(): Promise<VoiceAuth>;
  onText(text: string): void;
  onNotice(message: string): void;
  onFailure(error: Error): void;
}
export interface DictationDependencies {
  native(): Pick<NativeAudio, "AudioCapture">;
  fetch: typeof fetch;
}
const defaults: DictationDependencies = { native: loadNativeAudio, fetch: (...args) => fetch(...args) };

/** 16-bit mono PCM WAV. */
export function encodeWav(chunks: readonly Int16Array[], rate = SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(samples * 2, 40);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk) { buffer.writeInt16LE(sample, offset); offset += 2; }
  return buffer;
}

export function toPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const value = Number.isFinite(samples[i]!) ? Math.max(-1, Math.min(1, samples[i]!)) : 0;
    out[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return out;
}

export async function transcribe(
  auth: () => Promise<VoiceAuth>, wav: Uint8Array<ArrayBuffer>, signal: AbortSignal, fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const call = (credential: VoiceAuth) => {
    const form = new FormData();
    form.append("file", new File([wav], "dictation.wav", { type: "audio/wav" }));
    return fetchImpl(TRANSCRIBE_URL, {
      method: "POST", body: form, signal, redirect: "error",
      headers: {
        Authorization: `Bearer ${credential.accessToken}`, "ChatGPT-Account-ID": credential.accountId,
        originator: "codex_cli_rs", "User-Agent": "pi-voice/0.1.0", Accept: "application/json",
      },
    });
  };
  const first = await auth();
  let response = await call(first);
  if (response.status === 401) {
    // Another Pi process may have refreshed the credential; retry once only if it changed.
    await response.body?.cancel();
    const fresh = await auth();
    if (fresh.accessToken !== first.accessToken) response = await call(fresh);
  }
  if (!response.ok) {
    await response.body?.cancel();
    const advice = response.status === 401 ? `The Codex login was rejected (expired or revoked). ${LOGIN_HINT}`
      : response.status === 403 ? "This login/account is not authorized for ChatGPT dictation."
      : response.status === 413 ? "The recording is too long; dictate in shorter parts."
      : response.status === 429 ? "ChatGPT dictation is rate limited; try again later."
      : "The private ChatGPT dictation service may be unavailable or its protocol may have changed.";
    throw new Error(`ChatGPT dictation failed (HTTP ${response.status}). ${advice}`);
  }
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  const text = body && typeof body === "object" ? (body as Record<string, unknown>).text : undefined;
  // Never surface raw provider payloads.
  if (typeof text !== "string") throw new Error("ChatGPT dictation returned an invalid response.");
  return safeText(text).trim();
}

/** Push-to-talk: the microphone is open only while recording. */
export class DictationSession {
  readonly state: DictationState = { phase: "ready", muted: false, inputLevel: 0, outputLevel: 0 };
  private recorder?: { stop(): void };
  private chunks: Int16Array[] = [];
  private samples = 0;
  private lastInputAt = 0;
  private readonly abort = new AbortController();
  private stopped = false;

  constructor(private readonly options: DictationOptions, private readonly deps = defaults) {}

  /** Start recording, or stop and transcribe. Ignored while a transcription is running. */
  toggle(): void {
    if (this.state.phase === "ready") this.record();
    else if (this.state.phase === "recording") void this.finish();
  }

  private record(): void {
    this.chunks = [];
    this.samples = 0;
    try {
      this.recorder = new (this.deps.native().AudioCapture)(SAMPLE_RATE, (error, samples) => {
        if (this.state.phase !== "recording") return;
        if (error) { this.fail(new Error("Microphone capture failed. Check microphone permissions and the default input device.")); return; }
        this.state.inputLevel = rms(samples);
        this.lastInputAt = Date.now();
        this.chunks.push(toPcm16(samples));
        this.samples += samples.length;
        if (this.samples >= MAX_SECONDS * SAMPLE_RATE) {
          this.options.onNotice(`Dictation reached ${MAX_SECONDS / 60} minutes; transcribing.`);
          void this.finish();
        }
      });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("Microphone capture failed."));
      return;
    }
    this.state.phase = "recording";
    this.state.startedAt = Date.now();
  }

  private async finish(): Promise<void> {
    this.release();
    const chunks = this.chunks;
    this.chunks = [];
    if (this.samples < MIN_SECONDS * SAMPLE_RATE) {
      this.state.phase = "ready";
      this.options.onNotice("Nothing recorded.");
      return;
    }
    this.state.phase = "transcribing";
    try {
      const text = await transcribe(this.options.auth, encodeWav(chunks), this.abort.signal, this.deps.fetch);
      if (this.stopped) return;
      if (text) this.options.onText(text);
      else this.options.onNotice("No speech detected.");
      this.state.phase = "ready";
    } catch (error) {
      if (this.stopped) return;
      this.fail(error instanceof Error ? error : new Error("ChatGPT dictation failed."));
    }
  }

  private release(): void {
    try { this.recorder?.stop(); } catch { /* Capture may already have failed. */ }
    this.recorder = undefined;
    this.state.inputLevel = 0;
    this.state.startedAt = undefined;
  }

  /** A failed recording or transcription is reported and dictation returns to ready. */
  private fail(error: Error): void {
    this.release();
    this.chunks = [];
    if (this.stopped) return;
    this.state.phase = "ready";
    try { this.options.onFailure(error); } catch { /* Do not throw through native callbacks. */ }
  }

  /** Called by the UI ticker so a stalled capture cannot stick the meter. */
  tick(now = Date.now()): void {
    if (now - this.lastInputAt > 220) this.state.inputLevel = 0;
  }

  stop(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    this.abort.abort();
    this.release();
    this.chunks = [];
    this.state.phase = "off";
    return Promise.resolve();
  }
}
