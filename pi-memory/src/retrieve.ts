import type { MemoryItem, SearchResult } from './types.js';
import { isSuspiciousMemory, redactSecrets } from './secrets.js';

const STOP = new Set('a an and are as at be been but by can could do does for from had has have how i if in into is it its let me my of on or our please should so some that the their them then there these they this to use using was we were what when where which who will with would you your'.split(' '));
export function isExpired(item: MemoryItem, at = Date.now()): boolean {
  return item.retention === 'short' && (!item.expiresAt || Date.parse(item.expiresAt) <= at);
}
export function queryTerms(query: string): string[] {
  return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_./-]+/gu) ?? []).filter(t => t.length > 1 && !STOP.has(t)))].slice(0, 64);
}
export function scoreMemory(item: MemoryItem, query: string, baseline = false, lexicalScore?: number): number {
  if (item.status !== 'active' || isExpired(item) || isSuspiciousMemory(`${item.title}\n${item.summary}\n${item.body}`)) return 0;
  const terms = queryTerms(query);
  if (!terms.length) return 0;
  const title = new Set(queryTerms(item.title));
  const keys = new Set(queryTerms([...item.keywords, ...item.triggers].join(' ')));
  const summary = new Set(queryTerms(item.summary));
  const body = new Set(queryTerms(item.body));
  let hits = 0, weight = 0;
  for (const term of terms) {
    const value = title.has(term) ? 4 : keys.has(term) ? 3 : summary.has(term) ? 2 : body.has(term) ? 1 : 0;
    if (value) hits++;
    weight += value;
  }
  if (!hits && !lexicalScore) return 0;
  if (baseline) return weight;
  // One accidental generic overlap in a long request is weak evidence.
  const coverage = hits / Math.min(terms.length, 8);
  // FTS stemming may match a rare relevant term even without exact token overlap.
  // Preserve that evidence, but reject weak common-word-only matches.
  if (terms.length >= 4 && hits <= 1 && weight < 3 && (lexicalScore ?? 0) < 0.1) return 0;
  const ageDays = Math.max(0, (Date.now() - Date.parse(item.updated)) / 86400000);
  const recency = 0.8 + 0.2 * Math.exp(-ageDays / 180);
  const reliability = item.confidence * (1 + Math.min(item.stats.helpful, 5) * 0.04) / (1 + item.stats.harmful * 0.5);
  const locality = item.paths.some(path => { const prefix = path.replace(/\*.*$/, '').toLowerCase(); return prefix.length > 0 && query.toLowerCase().includes(prefix); }) ? 1.15 : 1;
  const provenance = item.source.origin === 'tool_output' ? 0.85 : item.source.origin === 'consolidation' ? 0.9 : 1;
  // BM25 retains corpus specificity and document-length normalization. Priors
  // adjust relevance instead of replacing it with raw shared-word counts.
  return (lexicalScore ?? weight) * (0.9 + 0.1 * Math.min(coverage, 1)) * reliability * recency * locality * provenance;
}

const HEADER = 'Relevant remembered evidence. Use supported facts when applicable; current instructions take precedence.\n<memory_recall>\n';
const FOOTER = '\n</memory_recall>';
const escape = (text: string) => redactSecrets(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function renderItem(item: MemoryItem): string {
  const scope = item.scope === 'global' ? 'global' : 'project';
  const lifetime = item.retention === 'short' ? `; active at retrieval ${new Date().toISOString()}; temporary until ${escape(item.expiresAt!)}` : '';
  const raw = item.raw ? '; raw note, not yet consolidated' : '';
  const before = item.raw?.before ? `In reply to: ${escape(item.raw.before)}\n` : '';
  return `[${item.id}] ${escape(item.title)} (${scope}; ${item.source.origin}; confidence ${item.confidence.toFixed(2)}; ${escape(item.updated.slice(0, 10))}${lifetime}${raw})\n${before}${escape(item.body)}`;
}
/** UTF-8 byte count is a conservative upper bound for byte-backed tokenizers. */
export const estimateTokens = (text: string): number => Buffer.byteLength(text, 'utf8');
export function selectMemories<T extends MemoryItem>(items: T[], options: { budgetTokens: number; maxItems: number; excludeIds?: ReadonlySet<string> }): T[] {
  let remaining = Math.max(0, options.budgetTokens) - estimateTokens(HEADER + FOOTER);
  const chosen: T[] = [];
  for (const item of items) {
    if (chosen.length >= options.maxItems) break;
    if (item.status !== 'active' || isExpired(item) || options.excludeIds?.has(item.id) || isSuspiciousMemory(`${item.title}\n${item.body}\n${item.summary}`)) continue;
    const cost = estimateTokens(renderItem(item)) + 2;
    if (cost > remaining) continue;
    remaining -= cost; chosen.push(item);
  }
  return chosen;
}
export function renderMemories(items: MemoryItem[], budgetTokens = 1200): string {
  const selected = selectMemories(items, { budgetTokens, maxItems: items.length });
  return selected.length ? HEADER + selected.sort((a, b) => a.id.localeCompare(b.id)).map(renderItem).join('\n\n') + FOOTER : '';
}
export function rankMemories(items: MemoryItem[], query: string, strategy: 'baseline' | 'improved' = 'improved'): SearchResult[] {
  return items.map(item => ({ ...item, score: scoreMemory(item, query, strategy === 'baseline') })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
