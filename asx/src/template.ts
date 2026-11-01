import { execFile } from "node:child_process";
import { Liquid, Tag, type Context, type Emitter, type TagToken, type TopLevelToken } from "liquidjs";

/** Position of a stage inside a `* N` or `* [a, b]` fan-out. */
export interface CopyInfo { index: number; count: number; variant?: string }

/** Variables a preset task template can use. */
export interface TemplateContext {
  /** `--args` JSON merged under the stage's own `@preset(k=v)` args. */
  args: Record<string, unknown>;
  /** Directory `{% sh %}` commands run in. */
  cwd: string;
  env: Record<string, string | undefined>;
  /** Upstream stage outputs joined with separators; empty for a first stage. */
  input: string;
  /** Upstream stage outputs, one per upstream agent. */
  inputs: string[];
  copy?: CopyInfo;
  /** 1-based loop iteration inside `repeat … until`. */
  iteration?: number;
  /** The judge's feedback from the previous iteration. */
  feedback?: string;
}

export class TemplateError extends Error {}

/** `sh -c command` in cwd; trimmed stdout. A non-zero exit fails the render so a broken command never reaches the model. */
export function sh(command: string, cwd: string, env: TemplateContext["env"], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("sh", ["-c", command], { cwd, env: env as NodeJS.ProcessEnv, signal, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code !== undefined && typeof (error as { code?: unknown }).code !== "number") {
        return reject(new TemplateError(`command failed: ${command}\n${error.message}`));
      }
      if (error) {
        const code = (error as { code?: number }).code;
        return reject(new TemplateError(`command failed (exit ${code ?? "?"}): ${command}${stderr.trim() ? `\n${stderr.trim()}` : ""}`));
      }
      resolve(stdout.trimEnd());
    });
  });
}

/** `{% sh <command> %}`: everything after `sh` goes verbatim to `sh -c`. */
class ShTag extends Tag {
  private readonly command: string;
  constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
    super(token, remain, liquid);
    this.command = token.args.trim();
    if (!this.command) throw new TemplateError("{% sh %} requires a command");
  }
  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const { cwd, env } = ctx.environments as unknown as TemplateContext;
    emitter.write((yield sh(this.command, cwd, env)) as string);
  }
}

const engine = new Liquid({ strictFilters: true, outputEscape: undefined });
engine.registerTag("sh", ShTag);
// `{{ "git log -n " | append: args.n | sh }}`: the tag's filter form, composable with other filters.
engine.registerFilter("sh", function (this: { context: Context }, command: unknown) {
  const { cwd, env } = this.context.environments as unknown as TemplateContext;
  return sh(String(command), cwd, env);
});

/** The submitter's environment a durable render may use: tool lookup, git hook variables, locale. No credentials. */
export function forwardedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (/^(PATH|HOME|USER|SHELL|LANG|TERM|TMPDIR|LC_[A-Z]+)$/.test(key) || /^(GIT_|ASX_PRESET_DIR$)/.test(key))) out[key] = value;
  }
  return out;
}

export function joinInputs(inputs: readonly string[]): string {
  if (inputs.length <= 1) return inputs[0] ?? "";
  return inputs.map((text, i) => `--- input ${i + 1} of ${inputs.length} ---\n${text}`).join("\n\n");
}

export async function renderTemplate(template: string, context: Partial<TemplateContext> = {}): Promise<string> {
  const inputs = context.inputs ?? (context.input !== undefined ? [context.input] : []);
  const full: TemplateContext = {
    args: context.args ?? {}, cwd: context.cwd ?? process.cwd(), env: context.env ?? process.env,
    input: context.input ?? joinInputs(inputs), inputs, copy: context.copy, iteration: context.iteration, feedback: context.feedback,
  };
  try { return await engine.parseAndRender(template, full); }
  catch (error) {
    if (error instanceof TemplateError) throw error;
    throw new TemplateError(error instanceof Error ? error.message : String(error));
  }
}
