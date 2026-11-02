import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentToolResult,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";

export const TRUNCATION_NOTE = `Text output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; the complete JSON is then saved to a temp file.`;

/**
 * A tool result whose text is the JSON of `structured`. `details` is persisted in the session, so it
 * stays small: recalled messages would otherwise be copied into every later recall.
 */
export async function jsonResult(
  structured: unknown,
  details: JsonObject,
): Promise<AgentToolResult<JsonObject>> {
  const data = JSON.parse(JSON.stringify(structured)) as JsonValue;
  const json = JSON.stringify(data, null, 1);
  const truncation = truncateHead(json, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

  let text = json;
  if (truncation.truncated) {
    const dir = await mkdtemp(join(tmpdir(), "pi-recall-"));
    const path = join(dir, "result.json");
    await writeFile(path, json, "utf8");
    // A single line over the byte limit leaves no complete line to keep.
    const shown = truncation.firstLineExceedsLimit
      ? Buffer.from(json).subarray(0, DEFAULT_MAX_BYTES).toString("utf8")
      : truncation.content;
    text = `${shown}\n\n[Truncated: ${formatSize(Buffer.byteLength(shown))} of ${formatSize(truncation.totalBytes)} shown. Complete JSON: ${path}. Use a smaller limit to page with less output.]`;
    details = { ...details, fullOutputPath: path };
  }

  return { content: [{ type: "text", text }], details, structuredContent: data };
}
