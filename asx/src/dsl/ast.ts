/**
 * asx expressions: presets composed on one line.
 *
 *   @a -> @b                 pipeline: b receives a's output as `input`
 *   @a * 4                   fan-out: four copies in parallel, each with `copy.index`
 *   @a * [security, perf]    fan-out with `copy.variant`
 *   [@a, @b]                 parallel branches sharing the same input; outputs fan in as `inputs`
 *   (@a -> @b) * 2           grouping
 *   repeat (@a -> @b) until @judge max 3
 *   @a(focus=security, n=2)  per-stage args merged over --args
 *
 * Bare names work when they are not keywords; `@` always means a preset.
 */
export type ArgValue = string | number | boolean;

export type Node =
  | { type: "preset"; name: string; args: Record<string, ArgValue> }
  | { type: "pipeline"; stages: Node[] }
  | { type: "parallel"; branches: Node[] }
  | { type: "fanout"; body: Node; count: number; variants?: string[] }
  | { type: "repeat"; body: Node; judge: Node; max: number };

export const KEYWORDS = new Set(["repeat", "until", "max"]);

/** Presets referenced anywhere in the expression, in first-seen order. */
export function presetsIn(node: Node, seen: string[] = []): string[] {
  switch (node.type) {
    case "preset": if (!seen.includes(node.name)) seen.push(node.name); break;
    case "pipeline": node.stages.forEach(s => presetsIn(s, seen)); break;
    case "parallel": node.branches.forEach(b => presetsIn(b, seen)); break;
    case "fanout": presetsIn(node.body, seen); break;
    case "repeat": presetsIn(node.body, seen); presetsIn(node.judge, seen); break;
  }
  return seen;
}

function formatValue(value: ArgValue): string {
  return typeof value === "string" && !/^[A-Za-z0-9_.-]+$/.test(value) ? JSON.stringify(value) : String(value);
}

/** Canonical one-line form; the run record stores this. */
export function format(node: Node): string {
  switch (node.type) {
    case "preset": {
      const args = Object.entries(node.args).map(([k, v]) => `${k}=${formatValue(v)}`);
      return `@${node.name}${args.length ? `(${args.join(", ")})` : ""}`;
    }
    case "pipeline": return node.stages.map(s => s.type === "pipeline" ? `(${format(s)})` : format(s)).join(" -> ");
    case "parallel": return `[${node.branches.map(format).join(", ")}]`;
    case "fanout": {
      const body = node.body.type === "preset" || node.body.type === "parallel" ? format(node.body) : `(${format(node.body)})`;
      return `${body} * ${node.variants ? `[${node.variants.map(formatValue).join(", ")}]` : node.count}`;
    }
    case "repeat": {
      const wrap = (n: Node) => n.type === "preset" || n.type === "parallel" ? format(n) : `(${format(n)})`;
      return `repeat ${wrap(node.body)} until ${wrap(node.judge)} max ${node.max}`;
    }
  }
}

/** Indented tree for `asx plan`. */
export function plan(node: Node, indent = ""): string {
  const line = (text: string) => `${indent}${text}`;
  switch (node.type) {
    case "preset": return line(format(node));
    case "pipeline": return [line("pipeline"), ...node.stages.map((s, i) => `${indent}  ${i + 1}.\n${plan(s, `${indent}     `)}`)].join("\n");
    case "parallel": return [line("parallel"), ...node.branches.map(b => plan(b, `${indent}  `))].join("\n");
    case "fanout": return [line(`fan-out × ${node.count}${node.variants ? ` [${node.variants.join(", ")}]` : ""}`), plan(node.body, `${indent}  `)].join("\n");
    case "repeat": return [line(`repeat (max ${node.max})`), plan(node.body, `${indent}  `), line("until approved by"), plan(node.judge, `${indent}  `)].join("\n");
  }
}
