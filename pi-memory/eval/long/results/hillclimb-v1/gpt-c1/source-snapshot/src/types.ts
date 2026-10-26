export const MEMORY_TYPES = ['feedback', 'preference', 'project', 'reference', 'procedure', 'insight', 'failure', 'entity'] as const;
export type MemoryType = typeof MEMORY_TYPES[number];
export type MemoryScope = 'global' | `project:${string}`;
export type ScopeSelector = MemoryScope | 'project';
export type MemoryOrigin = 'user_statement' | 'user_confirmation' | 'tool_output' | 'consolidation';
export type MemoryRetention = 'long' | 'short';
export interface MemorySource { session: string; entries: string[]; origin: MemoryOrigin }
export interface MemoryInput {
  title: string; body: string; type?: MemoryType; scope?: ScopeSelector; summary?: string;
  keywords?: string[]; triggers?: string[]; paths?: string[]; importance?: number;
  confidence?: number; source: MemorySource; supersedes?: string[]; links?: string[];
  retention?: MemoryRetention; expiresAt?: string;
  derivedFrom?: Array<{ id: string; hash: string }>;
}
export interface MemoryItem {
  id: string; type: MemoryType; scope: MemoryScope; title: string; body: string; summary: string;
  keywords: string[]; triggers: string[]; paths: string[]; importance: number; confidence: number;
  source: MemorySource; sources: MemorySource[]; supersedes: string[]; links: string[];
  status: 'active' | 'archived' | 'superseded' | 'codified';
  created: string; updated: string; last_used: string;
  stats: { injected: number; used: number; helpful: number; harmful: number };
  archive_reason?: string;
  codified_as?: string;
  retention?: MemoryRetention;
  expiresAt?: string;
  derivedFrom?: Array<{ id: string; hash: string }>;
  /** Computed at read time; never trusted from canonical metadata. */
  validity?: 'expired' | 'stale-derived';
}
export interface SearchOptions { scope?: ScopeSelector; limit?: number; includeArchived?: boolean; strategy?: 'baseline' | 'improved'; automatic?: boolean }
export interface SearchResult extends MemoryItem { score: number }
export type FeedbackVerdict = 'helpful' | 'harmful' | 'outdated' | 'used' | 'ignored';
