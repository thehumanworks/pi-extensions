import { describe, expect, test } from "bun:test";
import { createMatcher, hasCapital, REGEX_TEXT_MAX, snippets } from "./match.ts";

const found = (query: string, text: string, mode: "literal" | "regex" = "literal") =>
  createMatcher(query, mode).ranges(text).map(([s, e]) => text.slice(s, e));

describe("createMatcher", () => {
  test("literal queries ignore case unless they have a capital letter", () => {
    expect(found("fence", "Fence and fence")).toEqual(["Fence", "fence"]);
    expect(found("Fence", "Fence and fence")).toEqual(["Fence"]);
    expect(createMatcher("Fence").caseSensitive).toBe(true);
    expect(createMatcher("fence").caseSensitive).toBe(false);
    expect(found("été", "ÉTÉ")).toEqual(["ÉTÉ"]);
  });

  test("literal queries match special characters as written and whitespace as any whitespace", () => {
    expect(found("a.b", "axb a.b")).toEqual(["a.b"]);
    expect(found("src/recall.ts(", "see src/recall.ts(1)")).toEqual(["src/recall.ts("]);
    expect(found("[x]*", "[x]* [x]")).toEqual(["[x]*"]);
    expect(found("fence balancing", "fence\n  balancing")).toEqual(["fence\n  balancing"]);
    expect(found(" fence ", "a fence b")).toEqual(["fence"]);
  });

  test("regex queries use JavaScript syntax with ^ and $ at line breaks", () => {
    expect(found("fen.e", "fence", "regex")).toEqual(["fence"]);
    expect(found("^## \\w+", "intro\n## Decisions\ntext", "regex")).toEqual(["## Decisions"]);
    expect(found("done$", "done\nnot done yet", "regex")).toEqual(["done"]);
  });

  test("smart case ignores the letters of regex escapes", () => {
    expect(hasCapital("\\Sfoo\\b\\W\\D", "regex")).toBe(false);
    expect(hasCapital("\\p{Lu}x\\u00E9\\x4A", "regex")).toBe(false);
    expect(hasCapital("(?<Name>x)\\k<Name>", "regex")).toBe(false);
    expect(hasCapital("\\bFoo", "regex")).toBe(true);
    expect(hasCapital("\\S", "literal")).toBe(true);
  });

  test("ignores empty matches", () => {
    expect(found("x*", "abc", "regex")).toEqual([]);
    expect(found("x*", "axxb", "regex")).toEqual(["xx"]);
  });

  test("regex queries see only the start of very long text; literal queries see all of it", () => {
    const text = `${"a".repeat(REGEX_TEXT_MAX)}needle`;
    expect(found("needle", text, "regex")).toEqual([]);
    expect(found("needle", text)).toEqual(["needle"]);
  });

  test("rejects empty, long and invalid queries and unknown modes", () => {
    expect(() => createMatcher("")).toThrow("must not be empty");
    expect(() => createMatcher("   ")).toThrow("must not be empty");
    expect(() => createMatcher("x".repeat(501))).toThrow("at most 500");
    expect(() => createMatcher("(", "regex")).toThrow("Invalid regex");
    expect(() => createMatcher("x", "semantic" as "regex")).toThrow("match must be one of literal, regex");
  });
});

describe("snippets", () => {
  const ranges = (query: string, text: string) => createMatcher(query).ranges(text);

  test("shows a short text whole, with whitespace collapsed", () => {
    const text = "keep the\n\n  fence   balanced";
    expect(snippets(text, ranges("fence", text))).toEqual(["keep the fence balanced"]);
  });

  test("shows about 80 chars either side, cut on spaces, with ellipses", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const text = `${words(60)} NEEDLE ${words(60)}`;
    const [snippet] = snippets(text, ranges("NEEDLE", text));
    expect(snippet!.startsWith("…w")).toBe(true);
    expect(snippet!.endsWith("…")).toBe(true);
    expect(snippet).toContain(" NEEDLE ");
    // Cut on spaces: the first and last words are whole.
    expect(snippet!.slice(1, -1).split(" ").every((w) => w === "NEEDLE" || /^w\d+$/.test(w))).toBe(true);
    expect(snippet!.length).toBeGreaterThan(140);
    expect(snippet!.length).toBeLessThan(200);
  });

  test("merges nearby matches and keeps distant ones apart, up to the maximum", () => {
    const gap = " ".repeat(10);
    const far = "x".repeat(400);
    const text = `a${gap}a${far}a${far}a${far}a`;
    expect(snippets(text, ranges("a", text), 10)).toHaveLength(4);
    expect(snippets(text, ranges("a", text), 2)).toHaveLength(2);
  });

  test("dense matches split into bounded snippets", () => {
    const text = "ab ".repeat(1000);
    const result = snippets(text, ranges("ab", text));
    expect(result).toHaveLength(3);
    for (const snippet of result) expect(snippet.length).toBeLessThanOrEqual(330);
  });

  test("a long match shows its start", () => {
    const text = `start ${"y".repeat(5000)} end`;
    const [snippet] = snippets(text, createMatcher("start y+", "regex").ranges(text));
    expect(snippet!.startsWith("start yyy")).toBe(true);
    expect(snippet!.endsWith("…")).toBe(true);
    expect(snippet!.length).toBeLessThanOrEqual(330);
  });
});
