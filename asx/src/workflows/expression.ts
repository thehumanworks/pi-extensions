// The workflow behind `asx <preset>` and `asx '<expression>'`. Each stage is ctx.preset(): a journaled
// render of the preset's task template, then one full pi session. Completed stages replay from the
// journal, so `asx retry <runId>` re-runs only what did not finish.
import { Type } from "typebox";
import { defineWorkflow } from "../index.ts";
import { interpret, type Executor } from "../dsl/interpreter.ts";
import { parse } from "../dsl/parser.ts";

export default defineWorkflow({
  name: "asx-expression",
  description: "Run presets composed on one line: @a -> @b, @a * 3, [@a, @b], repeat (…) until @judge max N.",
  args: Type.Object({
    expression: Type.String({ minLength: 1 }),
    /** Template `args`, under each stage's own `@preset(k=v)` args. */
    args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    /** Preset directories in lookup order; default: the run cwd's .pi/presets, $ASX_PRESET_DIR, ~/.pi/agent/presets. */
    presetDirs: Type.Optional(Type.Array(Type.String())),
    /** Submitter environment for `{% sh %}` (PATH, HOME, GIT_*), over the worker's. */
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
  }),
  async run(ctx) {
    const ast = parse(ctx.args.expression);
    const executor: Executor = {
      stage: call => ctx.preset(call.preset, {
        key: call.key, args: call.args, inputs: call.inputs, copy: call.copy, iteration: call.iteration, feedback: call.feedback,
        presetDirs: ctx.args.presetDirs, env: ctx.args.env,
      }),
      parallel: thunks => ctx.parallel(thunks, { failure: "failFast" }) as Promise<never[]>,
      log: message => ctx.log(message),
    };
    const outputs = await interpret(ast, executor, ctx.args.args ?? {});
    return outputs.join("\n\n");
  },
});
