import { parse } from "@babel/parser";
import type { ValidationResult } from "./index.ts";

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
  function imports(value: unknown): void {
    if (!node(value)) return;
    if (value.type === "ImportDeclaration" && node(value.source) && /^(node:)?timers(?:\/promises)?$/.test(String(value.source.value))) {
      for (const item of value.specifiers as Node[]) {
        if (item.type === "ImportSpecifier" && timerNames.includes(name(item.imported) ?? "")) timerAliases.add(name(item.local)!);
        if (item.type === "ImportNamespaceSpecifier" || item.type === "ImportDefaultSpecifier") timerNamespaces.add(name(item.local)!);
      }
    }
    for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(imports); else if (node(child)) imports(child);
  }
  imports(ast);
  function report(value: Node, label: string): void {
    const loc = value.loc as { start?: { line?: number } } | undefined;
    diagnostics.push({ code: "nondeterministic_call", line: loc?.start?.line, message: `${label} is not replay-safe in workflow control flow. Use ctx.now(), ctx.random() or ctx.sleep(); place external effects inside ctx.step().` });
  }
  function visit(value: unknown, active = false, effectOptions = false): void {
    if (!node(value)) return;
    const key = name(value.key);
    if ((value.type === "ObjectMethod" || value.type === "ObjectProperty") && key === "run") {
      if (value.type === "ObjectMethod") { visit(value.body, true); return; }
      if (functionNode(value.value)) { visit(value.value.body, true); return; }
    }
    if (effectOptions && (value.type === "ObjectMethod" || value.type === "ObjectProperty") && key === "compensate") return;
    if (active && (value.type === "CallExpression" || value.type === "OptionalCallExpression")) {
      const callee = value.callee;
      const callName = name(callee);
      if (member(callee, "Date", "now") || callName === "Date") report(value, "Date.now()/Date()");
      if (member(callee, "Math", "random")) report(value, "Math.random()");
      if (timerAliases.has(callName ?? "") || (node(callee) && timerNamespaces.has(name(callee.object) ?? "") && timerNames.includes(name(callee.property) ?? ""))) report(value, "Timer call");
      if (node(callee) && ["MemberExpression", "OptionalMemberExpression"].includes(callee.type) && name(callee.property) === "step") {
        visit(callee, active);
        (value.arguments as unknown[]).forEach((arg, index) => {
          if (index === 1 && functionNode(arg)) return;
          visit(arg, active, index === 2);
        });
        return;
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
