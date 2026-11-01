import { type ArgValue, KEYWORDS, type Node } from "./ast.ts";

export class ParseError extends Error {
  readonly position: number;
  readonly source: string;
  constructor(message: string, position: number, source: string) {
    super(`${message} at position ${position}\n  ${source}\n  ${" ".repeat(position)}^`);
    this.name = "ParseError";
    this.position = position;
    this.source = source;
  }
}

type Token =
  | { kind: "name"; value: string; explicit: boolean; pos: number }
  | { kind: "number"; value: number; pos: number }
  | { kind: "string"; value: string; pos: number }
  | { kind: "punct"; value: "->" | "*" | "(" | ")" | "[" | "]" | "," | "="; pos: number }
  | { kind: "eof"; pos: number };

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*/;

/** True when the text can only be an expression, not a preset, workflow name or file path. */
export function looksLikeExpression(text: string): boolean {
  return /->|[*()[\]@]|\s/.test(text.trim()) || /^repeat\b/.test(text.trim());
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    const pos = i;
    if (source.startsWith("->", i)) { tokens.push({ kind: "punct", value: "->", pos }); i += 2; }
    else if ("*()[],=".includes(ch)) { tokens.push({ kind: "punct", value: ch as "*", pos }); i++; }
    else if (ch === '"' || ch === "'") {
      const end = source.indexOf(ch, i + 1);
      if (end === -1) throw new ParseError("Unterminated string", pos, source);
      tokens.push({ kind: "string", value: source.slice(i + 1, end), pos }); i = end + 1;
    } else if (ch === "@") {
      const m = NAME.exec(source.slice(i + 1));
      if (!m) throw new ParseError("Expected a preset name after @", pos, source);
      tokens.push({ kind: "name", value: m[0], explicit: true, pos }); i += 1 + m[0].length;
    } else {
      const m = NAME.exec(source.slice(i));
      if (!m) throw new ParseError(`Unexpected character "${ch}"`, pos, source);
      const value = m[0];
      if (/^\d+$/.test(value)) tokens.push({ kind: "number", value: Number(value), pos });
      else tokens.push({ kind: "name", value, explicit: false, pos });
      i += value.length;
    }
  }
  tokens.push({ kind: "eof", pos: source.length });
  return tokens;
}

function describe(t: Token): string {
  switch (t.kind) {
    case "eof": return "end of expression";
    case "punct": return `"${t.value}"`;
    case "name": return `"${t.explicit ? "@" : ""}${t.value}"`;
    default: return `"${t.value}"`;
  }
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];
  private readonly source: string;
  constructor(tokens: Token[], source: string) { this.tokens = tokens; this.source = source; }

  parse(): Node {
    const node = this.pipeline();
    const t = this.peek();
    if (t.kind !== "eof") this.fail(`Unexpected ${describe(t)}`);
    return node;
  }
  private peek(): Token { return this.tokens[this.index]!; }
  private next(): Token { return this.tokens[this.index++]!; }
  private fail(message: string, token: Token = this.peek()): never { throw new ParseError(message, token.pos, this.source); }
  private isPunct(value: string): boolean { const t = this.peek(); return t.kind === "punct" && t.value === value; }
  private isKeyword(word: string): boolean { const t = this.peek(); return t.kind === "name" && !t.explicit && t.value === word; }
  private expectPunct(value: string): void { if (!this.isPunct(value)) this.fail(`Expected "${value}"`); this.next(); }
  private expectKeyword(word: string): void { if (!this.isKeyword(word)) this.fail(`Expected "${word}"`); this.next(); }

  /** stage ('->' stage)* */
  private pipeline(): Node {
    const stages = [this.stage()];
    while (this.isPunct("->")) { this.next(); stages.push(this.stage()); }
    return stages.length === 1 ? stages[0]! : { type: "pipeline", stages };
  }

  /** unit ('*' (N | [variants]))? */
  private stage(): Node {
    const body = this.unit();
    if (!this.isPunct("*")) return body;
    this.next();
    const t = this.peek();
    if (t.kind === "number") {
      this.next();
      if (t.value < 1) this.fail("Fan-out count must be at least 1", t);
      return { type: "fanout", body, count: t.value };
    }
    if (this.isPunct("[")) {
      const variants = this.list(() => String(this.value()));
      if (variants.length === 0) this.fail("Fan-out variants must not be empty");
      return { type: "fanout", body, count: variants.length, variants };
    }
    return this.fail("Expected a count or [variants] after *");
  }

  /** preset | '(' pipeline ')' | '[' pipeline (',' pipeline)* ']' | repeat stage until stage max N */
  private unit(): Node {
    if (this.isPunct("(")) { this.next(); const inner = this.pipeline(); this.expectPunct(")"); return inner; }
    if (this.isPunct("[")) {
      const branches = this.list(() => this.pipeline());
      if (branches.length === 0) this.fail("Parallel group must not be empty");
      return branches.length === 1 ? branches[0]! : { type: "parallel", branches };
    }
    if (this.isKeyword("repeat")) {
      this.next();
      const body = this.stage();
      this.expectKeyword("until");
      const judge = this.stage();
      this.expectKeyword("max");
      const t = this.next();
      if (t.kind !== "number" || t.value < 1) this.fail("Expected a positive iteration cap after max", t);
      return { type: "repeat", body, judge, max: t.value };
    }
    const t = this.peek();
    if (t.kind === "name") {
      if (!t.explicit && KEYWORDS.has(t.value)) this.fail(`"${t.value}" is a keyword; write @${t.value} for the preset`);
      this.next();
      return { type: "preset", name: t.value, args: this.isPunct("(") ? this.args() : {} };
    }
    return this.fail(`Expected a preset, "(" or "[", got ${describe(t)}`);
  }

  private args(): Record<string, ArgValue> {
    this.expectPunct("(");
    const args: Record<string, ArgValue> = {};
    while (!this.isPunct(")")) {
      const key = this.next();
      if (key.kind !== "name") this.fail("Expected an argument name", key);
      this.expectPunct("=");
      args[key.value] = this.value();
      if (this.isPunct(",")) this.next();
      else if (!this.isPunct(")")) this.fail('Expected "," or ")"');
    }
    this.next();
    return args;
  }

  private list<T>(item: () => T): T[] {
    this.expectPunct("[");
    const items: T[] = [];
    while (!this.isPunct("]")) {
      items.push(item());
      if (this.isPunct(",")) this.next();
      else if (!this.isPunct("]")) this.fail('Expected "," or "]"');
    }
    this.next();
    return items;
  }

  private value(): ArgValue {
    const t = this.next();
    if (t.kind === "number" || t.kind === "string") return t.value;
    if (t.kind === "name") return t.value === "true" ? true : t.value === "false" ? false : t.value;
    return this.fail("Expected a value", t);
  }
}

export function parse(source: string): Node {
  if (!source.trim()) throw new ParseError("Empty expression", 0, source);
  return new Parser(tokenize(source), source).parse();
}
