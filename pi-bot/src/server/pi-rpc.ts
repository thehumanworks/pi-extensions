import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { JsonAgentSessionEvent, RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";

/** Everything Pi prints on stdout in RPC mode, except command responses. */
export type PiEvent = JsonAgentSessionEvent | RpcExtensionUIRequest;

/** An RPC command without its id, kept as a union so each variant's fields stay known. */
export type Command = RpcCommand extends infer C ? (C extends { id?: string } ? Omit<C, "id"> : never) : never;

export interface PiProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onEvent: (event: PiEvent) => void;
  /** Called once, after the process has exited for any reason. */
  onExit: (code: number | null, stderr: string) => void;
}

const STDERR_LIMIT = 8_000;
const STOP_GRACE_MS = 5_000;

/**
 * One `pi --mode rpc` child: JSON lines in, JSON lines out.
 *
 * This is deliberately smaller than Pi's own RpcClient: it runs any command (not only node),
 * keeps the child's stderr instead of echoing it, and exposes the raw event stream.
 * Lines are split on LF only; readline would also split on U+2028/2029.
 */
export class PiProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private seq = 0;
  private stderr = "";
  private exited = false;

  constructor(private readonly options: PiProcessOptions) {
    this.child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout!.on("data", (chunk: Buffer) => this.feed(this.decoder.write(chunk)));
    this.child.stderr!.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_LIMIT); });
    this.child.on("error", error => { this.stderr = `${this.stderr}\n${error.message}`.slice(-STDERR_LIMIT); });
    this.child.on("exit", code => {
      this.exited = true;
      this.feed(this.decoder.end());
      const reason = new Error(`pi exited with code ${code ?? "null"}${this.stderr.trim() ? `: ${this.stderr.trim().slice(-500)}` : ""}`);
      for (const request of this.pending.values()) request.reject(reason);
      this.pending.clear();
      options.onExit(code, this.stderr);
    });
  }

  get isRunning(): boolean { return !this.exited; }
  get pid(): number | undefined { return this.child.pid; }

  /** Run one RPC command and resolve with its `data`. */
  request<T = unknown>(command: Command): Promise<T> {
    if (this.exited) return Promise.reject(new Error("pi is not running."));
    const id = String(++this.seq);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: data => resolve(data as T), reject });
      this.child.stdin!.write(`${JSON.stringify({ ...command, id })}\n`, error => {
        if (error) { this.pending.delete(id); reject(error); }
      });
    });
  }

  /** Answer an extension UI dialog; Pi sends no response for it. */
  send(message: RpcExtensionUIResponse): void {
    if (!this.exited) this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  /** Close stdin so Pi shuts down, then escalate to signals if it lingers. */
  stop(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill("SIGTERM"); setTimeout(() => this.child.kill("SIGKILL"), STOP_GRACE_MS).unref(); }, STOP_GRACE_MS);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
      this.child.stdin!.end();
    });
  }

  private feed(text: string): void {
    this.buffer += text;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let record: RpcResponse | PiEvent;
    try { record = JSON.parse(line); } catch { return; }
    if (record.type === "response") {
      const request = record.id ? this.pending.get(record.id) : undefined;
      if (!request) return;
      this.pending.delete(record.id!);
      if (record.success) request.resolve("data" in record ? record.data : undefined);
      else request.reject(new Error(record.error));
      return;
    }
    this.options.onEvent(record);
  }
}
