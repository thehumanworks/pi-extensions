import { stripVTControlCharacters } from "node:util";

/** Provider strings are untrusted terminal input, including error strings. */
export function safeText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

/** Bound speech context by UTF-8 bytes, not by the number of wire chunks. */
export function speechContext(text: string, maxBytes = 4000): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const suffix = "… Full details are in the written chat.";
  const budget = maxBytes - Buffer.byteLength(suffix);
  let result = "", bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > budget) break;
    result += char; bytes += size;
  }
  return result + suffix;
}

export function level(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function rms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += Number.isFinite(sample) ? sample * sample : 0;
  return samples.length ? level(Math.sqrt(sum / samples.length)) : 0;
}
