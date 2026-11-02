/** Text and argument previews that keep what matters and say what they left out. */

const FENCE = /^(`{3,}|~{3,})/;

const omitted = (n: number) => `[… ${n.toLocaleString("en-US")} chars omitted …]`;

/** The end of a cut near `at`, preferring a paragraph, then a line, then a space, within the second half. */
function cutBefore(text: string, at: number): number {
  const window = text.slice(0, at);
  for (const sep of ["\n\n", "\n", " "]) {
    const i = window.lastIndexOf(sep);
    if (i >= at / 2) return i;
  }
  return at;
}

/** The start of a cut near `at`, preferring a paragraph, then a line, then a space, within the first half. */
function cutAfter(text: string, at: number): number {
  const rest = text.length - at;
  for (const sep of ["\n\n", "\n", " "]) {
    const i = text.indexOf(sep, at);
    if (i !== -1 && i - at <= rest / 2) return i + sep.length;
  }
  return at;
}

/** Whether a code fence is still open at the end of the text. */
function openFence(text: string): string | undefined {
  let open: string | undefined;
  for (const line of text.split("\n")) {
    const mark = FENCE.exec(line.trimStart())?.[1];
    if (!mark) continue;
    if (open === undefined) open = mark;
    else if (mark[0] === open[0] && mark.length >= open.length) open = undefined;
  }
  return open;
}

/** Shortens fenced code blocks longer than `max` chars to their first and last lines. */
export function collapseFences(text: string, max = 800): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const mark = FENCE.exec(lines[i]!.trimStart())?.[1];
    if (!mark) {
      out.push(lines[i]!);
      continue;
    }
    let end = i + 1;
    while (end < lines.length) {
      const close = FENCE.exec(lines[end]!.trimStart())?.[1];
      if (close && close[0] === mark[0] && close.length >= mark.length) break;
      end++;
    }
    const body = lines.slice(i + 1, end);
    const size = body.join("\n").length;
    if (size > max && body.length > 6) {
      const kept = [...body.slice(0, 3), ...body.slice(-2)];
      out.push(lines[i]!, ...body.slice(0, 3), omitted(size - kept.join("\n").length), ...body.slice(-2));
    } else {
      out.push(lines[i]!, ...body);
    }
    if (end < lines.length) out.push(lines[end]!);
    i = end;
  }
  return out.join("\n");
}

/**
 * The text whole if it fits, otherwise its start and end around an omission marker. Long code blocks are
 * collapsed first, cuts fall on paragraph or line breaks where possible, and code fences stay balanced.
 */
export function excerpt(text: string, max: number, headShare = 2 / 3): string {
  if (text.length <= max) return text;
  const collapsed = collapseFences(text);
  if (collapsed.length <= max) return collapsed;
  text = collapsed;

  const headEnd = cutBefore(text, Math.floor(max * headShare));
  const tailStart = Math.max(headEnd, cutAfter(text, text.length - (max - headEnd)));
  let head = text.slice(0, headEnd).trimEnd();
  let tail = text.slice(tailStart).trimStart();
  const fence = openFence(head);
  if (fence) head += `\n${fence}`;
  if (tail && openFence(tail.split("\n").reverse().join("\n"))) {
    // A closing fence with no opening one: reopen it so the tail renders as code.
    tail = `${fence ?? "```"}\n${tail}`;
  }
  return `${head}\n${omitted(tailStart - headEnd)}${tail ? `\n${tail}` : ""}`;
}

/** The start of the text, cut on a line break where possible. */
function head(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = cutBefore(text, max);
  return `${text.slice(0, end).trimEnd()}\n${omitted(text.length - end)}`;
}

/**
 * Markdown with headings, kept as every heading plus the start of each section, sharing `max` chars so
 * short sections give their room to long ones. Text without headings falls back to excerpt.
 */
export function sectionExcerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  const parts = text.split(/^(?=#{1,3} )/m);
  if (parts.length < 3) return excerpt(text, max);

  const sections = parts.map((part) => {
    const nl = part.indexOf("\n");
    const isHeading = /^#{1,3} /.test(part);
    return isHeading && nl !== -1
      ? { heading: part.slice(0, nl), body: part.slice(nl + 1).trim() }
      : { heading: isHeading ? part.trim() : "", body: isHeading ? "" : part.trim() };
  });
  let budget = max - sections.reduce((n, s) => n + s.heading.length + 2, 0);
  const allot = new Map<number, number>();
  const bySize = sections.map((s, i) => ({ i, size: s.body.length })).sort((a, b) => a.size - b.size);
  bySize.forEach(({ i, size }, k) => {
    const share = Math.max(0, Math.floor(budget / (bySize.length - k)));
    allot.set(i, Math.min(size, share));
    budget -= Math.min(size, share);
  });
  return sections
    .map((s, i) => {
      const body = s.body ? head(s.body, Math.max(80, allot.get(i)!)) : "";
      return [s.heading, body].filter(Boolean).join("\n");
    })
    .join("\n\n");
}
