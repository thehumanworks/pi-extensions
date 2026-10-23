import { createHash, randomBytes } from 'node:crypto';
export type Product = 'jira' | 'confluence';
export type Obj = Record<string, unknown>;
export const hash = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
export const opaque = (): string => randomBytes(24).toString('base64url');
export function obj(value: unknown): Obj { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {}; }
export function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.length) throw new Error(`${name} must be a nonempty string`);
  return value;
}
export function product(value: unknown): Product {
  if (value !== 'jira' && value !== 'confluence') throw new Error('product must be jira or confluence');
  return value;
}
export function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return value;
}
export function id(value: unknown): string {
  const s = requiredString(value, 'id');
  if (!/^[A-Za-z0-9_-]+$/.test(s) || s === '.' || s === '..' || s.length > 200) throw new Error('Invalid id/path parameter (no separators, traversal or URL encoding)');
  return s;
}
// Generic documented property/account keys are segments, not resource IDs.
export function pathSegment(value: string): string {
  if (!/^[A-Za-z0-9_.:-]+$/.test(value) || value === '.' || value === '..' || value.length > 200) throw new Error('Invalid path parameter (no separators, traversal or URL encoding)');
  return encodeURIComponent(value);
}
export function strings(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(x => typeof x === 'string' && x.length > 0)) throw new Error(`${name} must be a string array`);
  return value as string[];
}
export function pointer(value: unknown, path: string): unknown {
  if (path === '') return value;
  if (!path.startsWith('/') || /~(?:[^01]|$)/.test(path)) throw new Error('Malformed RFC6901 pointer');
  let current = value;
  for (const part of path.slice(1).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current) && !/^(0|[1-9]\d*)$/.test(key)) throw new Error('Invalid array pointer index');
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) throw new Error('Pointer does not exist in source');
    current = (current as Obj)[key];
  }
  return current;
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable((value as Obj)[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function range(text: string, input: Obj): Obj {
  const offset = integer(input.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
  const length = integer(input.length, 2000, 1, 16000, 'length');
  if (offset > text.length) throw new Error('offset exceeds totalLength');
  const end = Math.min(text.length, offset + length);
  return { text: text.slice(offset, end), offset, endExclusive: end, totalLength: text.length, eof: end === text.length, ...(end < text.length ? { nextOffset: end } : {}), units: 'UTF16 code units' };
}
export function storageOutline(source: string, sourcePointer: string): Obj[] {
  const headings: Obj[] = [];
  const protectedRanges = [...source.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(ac:plain-text-body|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi)].map(m => ({ start: m.index, end: m.index + m[0].length }));
  const re = /<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1\s*>/gi;
  for (const match of source.matchAll(re)) {
    if (protectedRanges.some(r => match.index >= r.start && match.index < r.end)) continue;
    headings.push({ level: Number(match[1]), title: (match[2] ?? '').replace(/<[^>]*>/g, ''), offset: match.index, endOffset: match.index + match[0].length, pointer: sourcePointer, locator: { pointer: sourcePointer, offset: match.index, length: match[0].length }, representation: 'storage', units: 'UTF16 code units' });
  }
  for (let i = 0; i < headings.length; i++) headings[i]!.sectionEnd = headings[i + 1]?.offset ?? source.length;
  return headings;
}
export function textProjection(value: unknown): string {
  if (typeof value === 'string') return value.replace(/<[^>]*>/g, ' ');
  if (Array.isArray(value)) return value.map(textProjection).join('\n');
  if (value !== null && typeof value === 'object') {
    const v = obj(value);
    if (typeof v.text === 'string') return v.text;
    return Object.entries(v).map(([k, x]) => k + ': ' + textProjection(x)).join('\n');
  }
  return JSON.stringify(value) ?? '';
}
