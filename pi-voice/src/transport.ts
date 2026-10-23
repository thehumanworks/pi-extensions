import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { LOGIN_HINT, type VoiceAuth, voiceHeaders } from "./auth.ts";
import { type NativeAudio, loadNativeAudio } from "./native.ts";
import {
  type ClientMessage, type ServerEvent, SIGNALING_URL, parseCallId, parseEvent,
  sessionPayload, sidebandUrl,
} from "./protocol.ts";

export interface VoiceTransport {
  connect(): Promise<void>;
  send(message: ClientMessage): Promise<void>;
  pushAudio(samples: Float32Array): void;
  setMuted(muted: boolean): void;
  close(): Promise<void>;
}
export interface TransportOptions {
  auth(): Promise<VoiceAuth>;
  sessionId: string;
  instructions: string;
  voice: string;
  onEvent(event: ServerEvent): void;
  onOutputLevel(level: number): void;
  onFailure(error: Error): void;
}
export interface TransportDependencies {
  native(): NativeAudio;
  fetch: typeof fetch;
  socket(url: string, headers: Record<string, string>): WebSocket;
}
const defaults: TransportDependencies = {
  native: loadNativeAudio,
  fetch: (...args) => fetch(...args),
  socket: (url, headers) => new WebSocket(url, {
    headers, handshakeTimeout: 15_000, maxPayload: 1024 * 1024,
  }),
};

export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("Voice connection cancelled."));
    if (signal.aborted) { operation.catch(() => {}); onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** WebRTC media plus an authenticated, client-managed delegation sideband. */
export class ChatGPTVoiceTransport implements VoiceTransport {
  private readonly abort = new AbortController();
  private readonly realtimeId = randomUUID();
  private peer?: InstanceType<NativeAudio["LiveWebRtcPeer"]>;
  private socket?: WebSocket;
  private pendingSocket?: WebSocket;
  private connectPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private connected = false;
  private closed = false;
  private failed = false;
  private muted = false;

  constructor(private readonly options: TransportOptions, private readonly deps = defaults) {}

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Voice transport is closed."));
    return this.connectPromise ??= this.start().catch(async error => { await this.close(); throw error; });
  }

  private async start(): Promise<void> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(45_000)]);
    // Authenticate before creating the peer (the peer may open speaker hardware).
    const auth = await abortable(this.options.auth(), signal);
    signal.throwIfAborted();
    const native = this.deps.native();
    const peer = new native.LiveWebRtcPeer(
      (error, payload) => {
        if (error) this.fail(new Error("Voice media event failed."));
        else if (!this.socket || this.socket.readyState !== WebSocket.OPEN || parseEvent(payload)?.type === "error") this.receive(payload);
      },
      (error, level) => {
        if (error) this.fail(new Error("Voice speaker playback failed."));
        else if (this.connected && !this.closed) this.options.onOutputLevel(level);
      },
      () => this.fail(new Error("Voice media connection failed. Try /voice off then /voice on.")),
    );
    this.peer = peer;
    if (this.closed || signal.aborted) { await peer.close(); throw new Error("Voice connection cancelled."); }
    const offer = await abortable(peer.createOffer(), signal);
    const signalCall = (headers: Record<string, string>) => this.deps.fetch(SIGNALING_URL, {
      method: "POST", headers: { ...headers, Accept: "*/*", "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: offer, session: sessionPayload(this.options.instructions, this.options.voice) }),
      signal, redirect: "error",
    });
    let headers = voiceHeaders(auth, this.options.sessionId, this.realtimeId);
    let response = await signalCall(headers);
    if (response.status === 401) {
      // Like Codex's unauthorized recovery: re-read the credential (another Pi process
      // may have refreshed or rotated it) and retry once, only if the token changed.
      await response.body?.cancel();
      const fresh = await abortable(this.options.auth(), signal);
      if (fresh.accessToken !== auth.accessToken) {
        headers = voiceHeaders(fresh, this.options.sessionId, this.realtimeId);
        response = await signalCall(headers);
      }
    }
    if (!response.ok) {
      await response.body?.cancel();
      const advice = response.status === 401 ? `The Codex login was rejected (expired or revoked). ${LOGIN_HINT}`
        : response.status === 403 ? "This login/account is not authorized for Codex realtime voice. ChatGPT voice access is not guaranteed."
        : response.status === 429 ? "ChatGPT voice is rate limited; try again later."
        : "The private ChatGPT voice service may be unavailable or its protocol may have changed.";
      throw new Error(`ChatGPT voice signaling failed (HTTP ${response.status}). ${advice}`);
    }
    const callId = parseCallId(response.headers.get("location"));
    const answer = await response.text();
    if (!answer.trim() || answer.length > 1024 * 1024) throw new Error("Invalid SDP answer from ChatGPT voice.");
    await abortable(peer.acceptAnswer(answer), signal);
    peer.setMuted(this.muted);
    await abortable(peer.waitForOpen(20_000), signal);
    // Calls can take a moment to become available on the sideband endpoint.
    for (let attempt = 0; ; attempt++) {
      try { await this.openSideband(callId, headers, signal); break; }
      catch (error) {
        signal.throwIfAborted();
        if (attempt === 4) throw error;
        await sleep(200 * 2 ** attempt, undefined, { signal });
      }
    }
    signal.throwIfAborted();
    this.connected = true;
  }

  private openSideband(callId: string, headers: Record<string, string>, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.deps.socket(sidebandUrl(callId), headers);
      this.pendingSocket = socket;
      let opened = false, settled = false;
      const timer = setTimeout(() => finish(new Error("Voice sideband connection timed out.")), 15_000);
      timer.unref();
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (this.pendingSocket === socket) this.pendingSocket = undefined;
        if (error) { socket.terminate(); reject(error); }
        else { this.socket = socket; resolve(); }
      };
      const onAbort = () => finish(new Error("Voice connection cancelled."));
      socket.once("open", () => {
        if (this.closed || signal.aborted || settled) { socket.terminate(); return; }
        opened = true; finish();
      });
      socket.on("message", (data, binary) => {
        if (binary) this.fail(new Error("Voice sideband returned an invalid frame."));
        else this.receive(data.toString());
      });
      socket.on("error", () => {
        const error = new Error("ChatGPT voice sideband connection failed.");
        if (!opened) finish(error); else this.fail(error);
      });
      socket.on("close", () => {
        if (!opened) finish(new Error("Voice sideband closed before connecting."));
        else this.fail(new Error("ChatGPT voice disconnected. Run /voice on to reconnect."));
      });
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private receive(payload: string): void {
    if (this.closed) return;
    const event = parseEvent(payload);
    if (event?.type === "error") this.fail(new Error("ChatGPT voice reported a service error. Run /voice on to reconnect."));
    else if (event) this.options.onEvent(event);
  }

  private fail(error: Error): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.options.onFailure(error);
    void this.close();
  }

  send(message: ClientMessage): Promise<void> {
    const socket = this.socket;
    if (!this.connected || this.closed || socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Voice sideband is not connected."));
    }
    return new Promise((resolve, reject) => {
      socket.send(JSON.stringify(message), error => error ? reject(new Error("Voice context delivery failed.")) : resolve());
    });
  }

  pushAudio(samples: Float32Array): void {
    if (this.connected && !this.closed && !this.muted) this.peer?.pushAudio(samples);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!this.closed) this.peer?.setMuted(muted);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.connected = false;
    this.abort.abort();
    const socket = this.socket;
    this.socket = undefined;
    this.pendingSocket?.terminate();
    this.pendingSocket = undefined;
    // Bound socket shutdown; do not leave an event-loop handle behind on disconnect.
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "session.close" }));
        socket.close(1000, "voice off");
        const timer = setTimeout(() => socket.terminate(), 500);
        timer.unref();
        socket.once("close", () => clearTimeout(timer));
      } else socket.terminate();
    }
    const peer = this.peer;
    this.peer = undefined;
    return this.closePromise = (async () => { try { await peer?.close(); } catch { /* best-effort release */ } })();
  }
}
