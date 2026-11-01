import type { Node } from "./ast.ts";
import type { CopyInfo } from "../template.ts";
import { parseVerdict } from "../verdict.ts";

/** One preset run the interpreter asks for. Mirrors `PresetOptions` plus the stage key. */
export interface StageCall {
  key: string;
  preset: string;
  args: Record<string, unknown>;
  inputs: string[];
  copy?: CopyInfo;
  iteration?: number;
  feedback?: string;
}

/** How stages are scheduled: the expression workflow maps these onto ctx.preset, ctx.parallel and ctx.log. */
export interface Executor {
  stage(call: StageCall): Promise<string>;
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]>;
  log(message: string): void;
}

export class ExpressionFailure extends Error {
  readonly stageKey: string;
  constructor(message: string, stageKey: string) { super(message); this.name = "ExpressionFailure"; this.stageKey = stageKey; }
}

interface Frame { key: string; copy?: CopyInfo; iteration?: number; feedback?: string }

/** Run an expression. Resolves with the final stage outputs, one per final agent. */
export function interpret(node: Node, executor: Executor, args: Record<string, unknown> = {}): Promise<string[]> {
  return evaluate(node, [], { key: "" }, executor, args);
}

async function evaluate(node: Node, inputs: string[], frame: Frame, x: Executor, args: Record<string, unknown>): Promise<string[]> {
  const key = (suffix: string) => frame.key ? `${frame.key}.${suffix}` : suffix;
  switch (node.type) {
    case "preset": {
      const call: StageCall = { key: frame.key || node.name, preset: node.name, args: { ...args, ...node.args }, inputs, copy: frame.copy, iteration: frame.iteration, feedback: frame.feedback };
      return [await x.stage(call)];
    }
    case "pipeline": {
      let current = inputs;
      for (const [i, stage] of node.stages.entries()) current = await evaluate(stage, current, { ...frame, key: key(String(i + 1)) }, x, args);
      return current;
    }
    case "parallel":
      return (await x.parallel(node.branches.map((branch, i) => () => evaluate(branch, inputs, { ...frame, key: key(`b${i + 1}`) }, x, args)))).flat();
    case "fanout":
      return (await x.parallel(Array.from({ length: node.count }, (_, i) => () => {
        const copy: CopyInfo = { index: i + 1, count: node.count, variant: node.variants?.[i] };
        return evaluate(node.body, inputs, { ...frame, key: key(`#${i + 1}`), copy }, x, args);
      }))).flat();
    case "repeat": {
      let feedback: string | undefined;
      for (let i = 1; i <= node.max; i++) {
        const outputs = await evaluate(node.body, inputs, { ...frame, key: key(`i${i}.body`), iteration: i, feedback }, x, args);
        const judged = await evaluate(node.judge, outputs, { ...frame, key: key(`i${i}.judge`), iteration: i }, x, args);
        const verdict = parseVerdict(judged.join("\n"));
        if (verdict.approved) { x.log(`approved after ${i} iteration${i === 1 ? "" : "s"}`); return outputs; }
        feedback = verdict.feedback;
        x.log(`iteration ${i} rejected${verdict.parsed ? "" : " (no verdict found in the judge's output)"}`);
      }
      throw new ExpressionFailure(`judge did not approve after ${node.max} iteration${node.max === 1 ? "" : "s"}`, key("repeat"));
    }
  }
}
