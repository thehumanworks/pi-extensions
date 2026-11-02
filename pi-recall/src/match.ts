/** Pattern matching for recall_search: where a query matches a text, and short snippets around the matches. */

export const MATCH_MODES = ["literal", "regex"] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

/** Longest query accepted, to bound the cost of a regular expression. */
export const QUERY_MAX = 500;
/** A regular expression sees at most this much of each text, since JavaScript cannot interrupt a slow one. */
export const REGEX_TEXT_MAX = 200_000;

export interface Matcher {
  caseSensitive: boolean;
  /** Start and end of each non-empty match, in order. */
  ranges(text: string): [number, number][];
}

/** Escapes, named groups and backreferences, whose letters say nothing about case. */
const REGEX_SYNTAX = /\\[pP]\{[^}]*\}|\\u\{[0-9a-fA-F]+\}|\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}|\\c[A-Za-z]|\\k<[^>]*>|\\.|\(\?<[^>=!][^>]*>/g;

/** Smart case, as in ripgrep: a query with a capital letter matches case, any other ignores it. */
export function hasCapital(query: string, mode: MatchMode): boolean {
  const letters = mode === "regex" ? query.replace(REGEX_SYNTAX, "") : query;
  return letters !== letters.toLowerCase();
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A matcher for the query. Literal queries match as written, except that any run of whitespace matches any
 * other, so a phrase still matches across a line break. Regular expressions use JavaScript syntax, with ^ and
 * $ matching at line breaks.
 */
export function createMatcher(query: string, mode: MatchMode = "literal"): Matcher {
  if (!MATCH_MODES.includes(mode)) throw new Error(`match must be one of ${MATCH_MODES.join(", ")}`);
  if (query.length === 0 || (mode === "literal" && !query.trim())) throw new Error("query must not be empty");
  if (query.length > QUERY_MAX) throw new Error(`query must be at most ${QUERY_MAX} chars`);
  const caseSensitive = hasCapital(query, mode);
  const source = mode === "regex" ? query : query.trim().split(/\s+/).map(escape).join("\\s+");
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, caseSensitive ? "gm" : "gim");
  } catch (error) {
    throw new Error(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
  }
  const max = mode === "regex" ? REGEX_TEXT_MAX : Infinity;
  return {
    caseSensitive,
    ranges(text) {
      const ranges: [number, number][] = [];
      for (const m of (text.length > max ? text.slice(0, max) : text).matchAll(pattern)) {
        if (m[0].length > 0) ranges.push([m.index, m.index + m[0].length]);
      }
      return ranges;
    },
  };
}

/** Chars of context on each side of a match. */
const CONTEXT = 80;
/** Longest snippet, before whitespace is collapsed. Nearby matches share a snippet up to this length. */
const SNIPPET_MAX = 320;
/** How far a snippet's edge moves to start or end on a word. */
const SNAP = 20;

interface Window {
  start: number;
  end: number;
  /** Start of the window's first match and end of its last, which its edges must not cut. */
  first: number;
  last: number;
}

/**
 * Up to `max` snippets of the text around the ranges, in order: about 80 chars either side of each match,
 * nearby matches merged into one, cut on spaces where possible, whitespace collapsed, and … where text is left out.
 */
export function snippets(text: string, ranges: [number, number][], max = 3): string[] {
  const windows: Window[] = [];
  for (const [s, e] of ranges) {
    let start = Math.max(0, s - CONTEXT);
    // A long match shows its start.
    const end = Math.min(text.length, Math.min(e, s + SNIPPET_MAX - 2 * CONTEXT) + CONTEXT);
    const prev = windows.at(-1);
    if (prev && start <= prev.end) {
      if (end - prev.start <= SNIPPET_MAX) {
        prev.end = Math.max(prev.end, end);
        prev.last = Math.max(prev.last, Math.min(e, end));
        continue;
      }
      if (e <= prev.end) {
        prev.last = Math.max(prev.last, e);
        continue;
      }
      start = prev.end;
    }
    if (windows.length === max) break;
    windows.push({ start, end, first: Math.max(s, start), last: Math.min(e, end) });
  }
  return windows.map(({ start, end, first, last }) => {
    if (start > 0) {
      const space = text.slice(start, Math.min(start + SNAP, first)).search(/\s/);
      if (space !== -1) start += space + 1;
    }
    if (end < text.length) {
      const from = Math.max(end - SNAP, last);
      const space = text.slice(from, end).search(/\s\S*$/);
      if (space !== -1) end = from + space;
    }
    const body = text.slice(start, end).replace(/\s+/g, " ").trim();
    return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
  });
}
