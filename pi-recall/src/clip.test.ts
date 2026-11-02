import { describe, expect, test } from "bun:test";
import { collapseFences, excerpt, sectionExcerpt } from "./clip.ts";

const fences = (text: string) => text.split("\n").filter((line) => /^\s*```/.test(line)).length;

describe("excerpt", () => {
  test("keeps text that fits", () => {
    expect(excerpt("short", 10)).toBe("short");
  });

  test("keeps the start and end, cut on paragraph breaks, and says how much is gone", () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"word ".repeat(20)}`.trim());
    const text = paragraphs.join("\n\n");
    const out = excerpt(text, 1000);
    expect(out.length).toBeLessThan(1100);
    expect(out.startsWith("Paragraph 0 ")).toBe(true);
    expect(out.endsWith(paragraphs.at(-1)!)).toBe(true);
    expect(out).toMatch(/\n\[… [\d,]+ chars omitted …\]\n/);
    // Whole paragraphs on both sides of the cut.
    for (const part of out.split(/\n?\[…[^\]]*\]\n?/)) {
      for (const p of part.split("\n\n")) expect(paragraphs).toContain(p);
    }
  });

  test("collapses long code blocks before cutting prose", () => {
    const code = Array.from({ length: 200 }, (_, i) => `line ${i};`).join("\n");
    const text = `Intro.\n\n\`\`\`ts\n${code}\n\`\`\`\n\nConclusion.`;
    const out = excerpt(text, 1000);
    expect(out).toContain("Intro.");
    expect(out).toContain("Conclusion.");
    expect(out).toContain("line 0;");
    expect(out).toContain("line 199;");
    expect(fences(out)).toBe(2);
  });

  test("keeps code fences balanced when the cut falls inside one", () => {
    const code = Array.from({ length: 400 }, (_, i) => `x${i}`).join("\n");
    // Short lines keep the block under the collapse threshold per line but not overall.
    const text = `\`\`\`\n${code}\n\`\`\``;
    const out = excerpt(collapseFences(text, Infinity), 300);
    expect(fences(out) % 2).toBe(0);
  });
});

describe("collapseFences", () => {
  test("leaves short blocks alone", () => {
    const text = "```js\na\nb\n```";
    expect(collapseFences(text)).toBe(text);
  });
});

describe("sectionExcerpt", () => {
  test("keeps every heading, short sections whole, and shortens long ones", () => {
    const text = [
      "## Objective", "Ship it.",
      "## Decisions", Array.from({ length: 100 }, (_, i) => `- decision ${i}`).join("\n"),
      "## Next Steps", "1. Test.",
    ].join("\n");
    const out = sectionExcerpt(text, 600);
    expect(out).toContain("## Objective\nShip it.");
    expect(out).toContain("## Next Steps\n1. Test.");
    expect(out).toContain("- decision 0");
    expect(out).not.toContain("- decision 99");
    expect(out).toContain("chars omitted");
    expect(out.length).toBeLessThan(800);
  });

  test("falls back to excerpt without headings", () => {
    expect(sectionExcerpt("a ".repeat(1000), 100)).toContain("chars omitted");
  });
});
