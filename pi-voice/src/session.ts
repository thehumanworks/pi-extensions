import type { VoiceAuth } from "./auth.ts";
import { type NativeAudio, loadNativeAudio } from "./native.ts";
import { contextMessages, type ServerEvent } from "./protocol.ts";
import { VOICE_INSTRUCTIONS } from "./instructions.ts";
import { level, rms, speechContext } from "./text.ts";
import { Transcripts, type Transcript } from "./transcripts.ts";
import { ChatGPTVoiceTransport, type TransportOptions, type VoiceTransport } from "./transport.ts";

export interface VoiceState {
  phase: "connecting" | "listening" | "working" | "speaking" | "muted" | "off";
  muted: boolean;
  inputLevel: number;
  outputLevel: number;
}
export interface SessionOptions {
  auth(): Promise<VoiceAuth>;
  sessionId: string;
  voice: string;
  onTranscript(transcript: Transcript): void;
  onDelegate(id: string, request: string): void;
  onFailure(error: Error): void;
}
export interface SessionDependencies {
  native(): NativeAudio;
  transport(options: TransportOptions): VoiceTransport;
}
const defaults: SessionDependencies = {
  native: loadNativeAudio,
  transport: options => new ChatGPTVoiceTransport(options),
};

export class VoiceSession {
  readonly state: VoiceState = { phase: "connecting", muted: false, inputLevel: 0, outputLevel: 0 };
  private readonly transcripts = new Transcripts();
  private transport?: VoiceTransport;
  private recorder?: { stop(): void };
  private stopPromise?: Promise<void>;
  private startPromise?: Promise<void>;
  private stopped = false;
  private connected = false;
  private failed = false;
  private pendingEvents: ServerEvent[] = [];
  private delegations = new Set<string>();
  private activeDelegation?: string;
  private attachedDelegation?: string;
  private candidate = "";
  private sendTail: Promise<void> = Promise.resolve();
  private lastOutputAt = 0;
  private lastInputAt = 0;

  constructor(private readonly options: SessionOptions, private readonly deps = defaults) {}

  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Voice session is closed."));
    return this.startPromise ??= this.connect().catch(async error => { await this.stop(); throw error; });
  }

  private async connect(): Promise<void> {
    const transport = this.deps.transport({
      auth: this.options.auth, sessionId: this.options.sessionId,
      instructions: VOICE_INSTRUCTIONS, voice: this.options.voice,
      onEvent: event => {
        if (this.stopped) return;
        if (!this.connected) {
          if (this.pendingEvents.length < 256) this.pendingEvents.push(event);
        } else this.handle(event);
      },
      onOutputLevel: value => {
        if (this.stopped) return;
        this.state.outputLevel = level(value);
        this.lastOutputAt = Date.now();
        this.refresh();
      },
      onFailure: error => this.fail(error),
    });
    this.transport = transport;
    await transport.connect();
    if (this.stopped) return;
    this.connected = true;
    transport.setMuted(this.state.muted);
    const recorder = new (this.deps.native().AudioCapture)(16_000, (error, samples) => {
      if (this.stopped) return;
      if (error) { this.fail(new Error("Microphone capture failed. Check microphone permissions and the default input device.")); return; }
      if (this.state.muted) return;
      this.tick();
      this.state.inputLevel = rms(samples);
      this.lastInputAt = Date.now();
      // Native peer has no acoustic echo cancellation. Use headphones for reliable
      // full-duplex barge-in; this gate only suppresses quiet speaker leakage.
      if (this.state.outputLevel > 0.015 &&
          this.state.inputLevel < Math.max(0.04, this.state.outputLevel * 0.65)) return;
      try { transport.pushAudio(samples); }
      catch { this.fail(new Error("Voice microphone transmission failed.")); }
    });
    if (this.stopped) { recorder.stop(); return; }
    this.recorder = recorder;
    this.refresh();
    const pending = this.pendingEvents;
    this.pendingEvents = [];
    for (const event of pending) { if (!this.stopped) this.handle(event); }
  }

  private handle(event: ServerEvent): void {
    try {
      switch (event.type) {
        case "transcript": {
          const update = this.transcripts.accept(event.role, event.text, event.final, event.id);
          if (update) this.options.onTranscript(update);
          break;
        }
        case "delegation":
          if (this.delegations.has(event.id)) return;
          this.delegations.add(event.id);
          if (this.delegations.size > 512) this.delegations.delete(this.delegations.values().next().value!);
          this.activeDelegation = event.id;
          this.refresh();
          this.options.onDelegate(event.id, event.text);
          break;
        case "error": this.fail(new Error("ChatGPT voice reported a service error.")); break;
        case "ready": break;
      }
    } catch {
      this.fail(new Error("Voice event handling failed."));
    }
  }

  toggleMute(): void {
    if (this.stopped) return;
    this.state.muted = !this.state.muted;
    this.state.inputLevel = 0;
    try { this.transport?.setMuted(this.state.muted); }
    catch { this.fail(new Error("Could not change the microphone mute state.")); }
    this.refresh();
  }

  /** Called by the UI ticker too, so disconnected audio callbacks cannot stick meters. */
  tick(now = Date.now()): void {
    if (now - this.lastOutputAt > 220) this.state.outputLevel = 0;
    if (now - this.lastInputAt > 220) this.state.inputLevel = 0;
    this.refresh();
  }

  private refresh(): void {
    this.state.phase = this.stopped ? "off" : !this.connected ? "connecting"
      : this.state.muted ? "muted" : this.state.outputLevel > 0.015 ? "speaking"
      : this.activeDelegation ? "working" : "listening";
  }

  /** Attach only once Pi actually consumes the delegation, not when it is queued. */
  backendDelegationStarted(id: string): void {
    if (this.stopped || id !== this.activeDelegation || this.attachedDelegation === id) return;
    this.attachedDelegation = id;
    this.candidate = "";
  }

  /** Keep tool progress silent; only the settled final is speakable. */
  backendMessage(text: string, toolUse: boolean, error?: string): void {
    if (this.stopped || !this.attachedDelegation) return;
    if (toolUse) {
      if (text.trim()) this.queue(speechContext(text, 1200), "commentary", this.attachedDelegation);
    } else {
      this.candidate = error ? `The coding run failed: ${error}` : speechContext(text.trim());
    }
  }

  backendSettled(aborted: boolean): void {
    if (this.stopped || !this.attachedDelegation) return;
    if (this.attachedDelegation !== this.activeDelegation) {
      this.attachedDelegation = undefined;
      this.candidate = "";
      return; // A newer delegation is queued for a future run; do not consume it here.
    }
    const id = this.attachedDelegation;
    const text = aborted ? "Work was interrupted. Do not claim that it completed."
      : this.candidate || "The coding run ended without a final answer. Do not claim success.";
    this.queue(`Agent Final Message:\n\n${text}`, "speakable", id);
    this.activeDelegation = undefined;
    this.attachedDelegation = undefined;
    this.candidate = "";
    this.refresh();
  }

  private queue(text: string, channel: "commentary" | "speakable", id: string): void {
    for (const message of contextMessages(text, channel, id)) {
      this.sendTail = this.sendTail.then(async () => {
        if (!this.stopped) await this.transport?.send(message);
      }).catch(() => this.fail(new Error("Could not deliver Pi's response to the voice session.")));
    }
  }

  private fail(error: Error): void {
    if (this.stopped || this.failed) return;
    this.failed = true;
    try { this.options.onFailure(error); } catch { /* Do not throw through native callbacks. */ }
    finally { void this.stop(); }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.state.inputLevel = this.state.outputLevel = 0;
    this.refresh();
    try { this.recorder?.stop(); } catch { /* Continue releasing media if capture already failed. */ }
    this.recorder = undefined;
    this.pendingEvents = [];
    for (const transcript of this.transcripts.flush()) {
      try { this.options.onTranscript(transcript); } catch { /* Shutdown must continue. */ }
    }
    return this.stopPromise = (this.transport?.close() ?? Promise.resolve()).catch(() => {});
  }
}
