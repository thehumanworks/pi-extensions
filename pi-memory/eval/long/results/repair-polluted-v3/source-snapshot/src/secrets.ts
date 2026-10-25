/** Best-effort defense in depth. Capture must also exclude credential files entirely. */
export function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g, '[redacted private key]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:[\w-]*(?:api[_-]?key|secret|password|passwd|token|credential)[\w-]*)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '[redacted credential]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted token]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@');
}

export function isSuspiciousMemory(text: string): boolean {
  return /(?:ignore|override|disregard)\s+(?:all\s+)?(?:previous|prior|system|developer|higher.priority)\s+(?:instructions?|prompts?|messages?)|(?:reveal|exfiltrate|send|upload)\s+(?:all\s+)?(?:secrets?|credentials?|api.keys?|passwords?)|<\/?(?:system|developer|memory_recall)\b/i.test(text);
}

export function redactObject<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(redactObject) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactObject(item)])) as T;
  return value;
}
