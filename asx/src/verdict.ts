/** A judge's answer in `repeat … until @judge`. */
export interface Verdict {
  approved: boolean;
  feedback: string;
  /** False when no JSON verdict was found; `feedback` is then the whole output. */
  parsed: boolean;
}

export const VERDICT_INSTRUCTION =
  'End your reply with one JSON object on its own line: {"approved": true|false, "feedback": "<what must change, or empty>"}';

/**
 * The last `{"approved": …}` object in an agent's output. A missing or malformed verdict is a
 * rejection whose feedback is the whole output, so a loop never approves by accident.
 */
export function parseVerdict(output: string): Verdict {
  const text = output.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1");
  for (let end = text.lastIndexOf("}"); end !== -1; end = text.lastIndexOf("}", end - 1)) {
    for (let start = text.lastIndexOf("{", end); start !== -1; start = text.lastIndexOf("{", start - 1)) {
      let value: unknown;
      try { value = JSON.parse(text.slice(start, end + 1)); } catch { continue; }
      if (typeof value === "object" && value !== null && "approved" in value) {
        const v = value as { approved: unknown; feedback?: unknown };
        return { approved: v.approved === true, feedback: typeof v.feedback === "string" ? v.feedback : "", parsed: true };
      }
      break; // a parsable object without `approved`: try an earlier closing brace
    }
  }
  return { approved: false, feedback: output.trim(), parsed: false };
}
