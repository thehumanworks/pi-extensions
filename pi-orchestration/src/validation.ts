import { parse } from "@babel/parser";
import type { ValidationResult } from "./index.ts";

/** Option names ctx.agent() and ctx.spawn() accept; checked at validate time and again at run time. */
/** Members of the run context; validate reports any other `ctx.<name>` the run reads. */
export const CONTEXT_MEMBERS = ["runId", "args", "cwd", "depth", "budget", "agent", "parallel", "pipeline", "step", "workflow", "signal", "sleep", "spawn", "swarm", "phase", "log", "now", "random"];
export const AGENT_OPTIONS = ["model", "thinkingLevel", "instructions", "tools", "cwd", "isolation", "budget", "timeoutMs", "retries", "label", "phase", "agentType", "key", "schema"];

type Node = { type: string; [key: string]: unknown };
function node(value: unknown): value is Node { return value !== null && typeof value === "object" && "type" in value && typeof value.type === "string"; }
function name(value: unknown): string | undefined {
  if (!node(value)) return undefined;
  return value.type === "Identifier" ? value.name as string : value.type === "StringLiteral" ? value.value as string : undefined;
}
function member(value: unknown, object: string, property: string): boolean {
  return node(value) && (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") && name(value.object) === object && name(value.property) === property;
}
function functionNode(value: unknown): value is Node { return node(value) && ["FunctionExpression", "ArrowFunctionExpression", "ObjectMethod"].includes(value.type); }
/** `a.b.c` for an identifier or a chain of plain member accesses. */
function dotted(value: unknown): string | undefined {
  if (!node(value)) return undefined;
  if (value.type === "Identifier") return value.name as string;
  if ((value.type !== "MemberExpression" && value.type !== "OptionalMemberExpression") || value.computed) return undefined;
  const object = dotted(value.object), property = name(value.property);
  return object && property ? `${object}.${property}` : undefined;
}

/** Inspect actual calls in run control flow, excluding comments, text and ctx.step effects. */
export function lintDeterminism(source: string): ValidationResult["diagnostics"] {
  const diagnostics: ValidationResult["diagnostics"] = [];
  let ast: unknown;
  try { ast = parse(source, { sourceType: "module", plugins: ["typescript"] }); }
  catch (error) {
    const syntax = error as Error & { loc?: { line?: number } };
    return [{ code: "syntax_error", line: syntax.loc?.line, message: syntax.message }];
  }
  const timerNames = ["setTimeout", "setInterval", "setImmediate"];
  const timerAliases = new Set(timerNames);
  const timerNamespaces = new Set<string>();
  // Local names bound to file system and process APIs, whether functions (readFileSync) or namespaces (fs).
  const ioNames = new Set<string>();
  function imports(value: unknown): void {
    if (!node(value)) return;
    if (value.type === "ImportDeclaration" && node(value.source) && /^(node:)?timers(?:\/promises)?$/.test(String(value.source.value))) {
      for (const item of value.specifiers as Node[]) {
        if (item.type === "ImportSpecifier" && timerNames.includes(name(item.imported) ?? "")) timerAliases.add(name(item.local)!);
        if (item.type === "ImportNamespaceSpecifier" || item.type === "ImportDefaultSpecifier") timerNamespaces.add(name(item.local)!);
      }
    }
    if (value.type === "ImportDeclaration" && node(value.source) && /^(node:)?(?:fs|fs\/promises|child_process)$/.test(String(value.source.value))) {
      for (const item of value.specifiers as Node[]) ioNames.add(name(item.local)!);
    }
    for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(imports); else if (node(child)) imports(child);
  }
  imports(ast);
  function report(value: Node, label: string): void {
    const loc = value.loc as { start?: { line?: number } } | undefined;
    diagnostics.push({ code: "nondeterministic_call", line: loc?.start?.line, message: `${label} is not replay-safe in workflow control flow. Use ctx.now(), ctx.random() or ctx.sleep(); place external effects inside ctx.step().` });
  }
  let ctxName: string | undefined;
  function visit(value: unknown, active = false, effectOptions = false): void {
    if (!node(value)) return;
    const key = name(value.key);
    if ((value.type === "ObjectMethod" || value.type === "ObjectProperty") && key === "run") {
      const fn = value.type === "ObjectMethod" ? value : functionNode(value.value) ? value.value : undefined;
      const param = fn ? (fn.params as Node[])[0] : undefined;
      if (!active) ctxName = param?.type === "Identifier" ? name(param) : undefined;
      if (value.type === "ObjectMethod") { visit(value.body, true); return; }
      if (functionNode(value.value)) { visit(value.value.body, true); return; }
    }
    if (effectOptions && (value.type === "ObjectMethod" || value.type === "ObjectProperty") && key === "compensate") return;
    if (active && (value.type === "CallExpression" || value.type === "OptionalCallExpression")) {
      const callee = value.callee;
      const method = node(callee) ? name(callee.property) : undefined;
      const options = method === "agent" ? (value.arguments as unknown[])[1] : method === "spawn" ? (value.arguments as unknown[])[0] : undefined;
      const known = method === "spawn" ? [...AGENT_OPTIONS, "name", "initialPrompt", "detach"] : AGENT_OPTIONS;
      if (node(options) && options.type === "ObjectExpression") {
        for (const property of options.properties as Node[]) {
          const option = property.type === "ObjectProperty" && !property.computed ? name(property.key) : undefined;
          if (option === undefined || known.includes(option)) continue;
          const near = known.find(valid => valid.startsWith(option) || option.startsWith(valid));
          const loc = property.loc as { start?: { line?: number } } | undefined;
          diagnostics.push({ code: "unknown_agent_option", line: loc?.start?.line, message: `Unknown agent option '${option}'${near ? ` (did you mean '${near}'?)` : ""}. Valid options: ${known.join(", ")}.` });
        }
      }
      const callName = name(callee);
      if (member(callee, "Date", "now") || callName === "Date") report(value, "Date.now()/Date()");
      if (member(callee, "Math", "random")) report(value, "Math.random()");
      if (member(callee, "performance", "now")) report(value, "performance.now()");
      if (member(callee, "process", "hrtime")) report(value, "process.hrtime()");
      if (["randomBytes", "randomInt"].includes(callName ?? "") || member(callee, "crypto", "randomBytes") || member(callee, "crypto", "randomInt")) report(value, "crypto.randomBytes()/randomInt()");
      if (callName === "randomUUID" || member(callee, "crypto", "randomUUID") || member(callee, "crypto", "getRandomValues")) report(value, "crypto.randomUUID()/getRandomValues()");
      if (timerAliases.has(callName ?? "") || (node(callee) && timerNamespaces.has(name(callee.object) ?? "") && timerNames.includes(name(callee.property) ?? ""))) report(value, "Timer call");
      const io = dotted(callee);
      if (io === "fetch" || io === "globalThis.fetch" || ioNames.has(io?.split(".")[0] ?? "")) {
        const loc = value.loc as { start?: { line?: number } } | undefined;
        diagnostics.push({ code: "nondeterministic_call", line: loc?.start?.line, message: `${io}() is I/O; move it into ctx.step().` });
      }
      if (node(callee) && ["MemberExpression", "OptionalMemberExpression"].includes(callee.type) && name(callee.property) === "step") {
        visit(callee, active);
        (value.arguments as unknown[]).forEach((arg, index) => {
          if (index === 1 && functionNode(arg)) return;
          visit(arg, active, index === 2);
        });
        return;
      }
    }
    if (active && ctxName && ["MemberExpression", "OptionalMemberExpression"].includes(value.type) && !value.computed && name(value.object) === ctxName) {
      const member = name(value.property);
      if (member && !CONTEXT_MEMBERS.includes(member)) {
        const loc = value.loc as { start?: { line?: number } } | undefined;
        diagnostics.push({ code: "unknown_context_member", line: loc?.start?.line, message: `${ctxName}.${member} does not exist on the workflow context. Members: ${CONTEXT_MEMBERS.join(", ")}.` });
      }
    }
    if (active && value.type === "NewExpression" && name(value.callee) === "Date" && (value.arguments as unknown[]).length === 0) report(value, "new Date()");
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(item => visit(item, active, effectOptions));
      else if (node(child)) visit(child, active, effectOptions);
    }
  }
  visit(ast);
  return diagnostics;
}
