import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MEMORY_TYPES, type FeedbackVerdict, type MemoryInput, type MemoryItem, type MemoryScope, type MemorySource, type ScopeSelector, type SearchOptions, type SearchResult } from './types.js';
import { redactSecrets, redactObject, isSuspiciousMemory } from './secrets.js';
import { queryTerms, scoreMemory, renderMemories } from './retrieve.js';

const ID = /^m_[a-z0-9]{20,64}$/;
const ORIGINS = ['user_statement', 'user_confirmation', 'tool_output', 'consolidation'];
const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const now = () => new Date().toISOString();

/** JSON is a YAML 1.2 subset; avoid ambiguous YAML scalars and executable tags. */
export function serializeMemory(item: MemoryItem): string {
  const { body, ...metadata } = item;
  return `---\n${JSON.stringify(metadata, null, 2)}\n---\n${body}\n`;
}
export function parseMemory(text: string): MemoryItem {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error('Memory requires JSON-compatible YAML frontmatter');
  const item = { ...JSON.parse(match[1]!), body: match[2]!.trim() } as MemoryItem;
  if (!ID.test(item.id) || !MEMORY_TYPES.includes(item.type) || !['active', 'archived', 'superseded', 'codified'].includes(item.status)) throw new Error('Invalid memory metadata');
  validateSource(item.source);
  if (!Array.isArray(item.sources)) item.sources = [item.source];
  item.sources.forEach(validateSource);
  for (const field of ['keywords', 'triggers', 'paths', 'supersedes', 'links'] as const) {
    if (!Array.isArray(item[field]) || item[field].some(v => typeof v !== 'string')) throw new Error(`Invalid ${field}`);
  }
  for (const field of ['title', 'summary', 'body'] as const) if (typeof item[field] !== 'string') throw new Error(`Invalid ${field}`);
  if (!item.title.trim() || !item.body.trim() || item.body.length > 20000) throw new Error('Invalid memory content');
  if (!Number.isFinite(item.importance) || item.importance < 1 || item.importance > 10 || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) throw new Error('Invalid memory confidence or importance');
  if (!item.stats || ['injected', 'used', 'helpful', 'harmful'].some(k => !Number.isSafeInteger(item.stats[k as keyof typeof item.stats]) || item.stats[k as keyof typeof item.stats] < 0)) throw new Error('Invalid memory stats');
  for (const field of ['created', 'updated', 'last_used'] as const) if (!Number.isFinite(Date.parse(item[field]))) throw new Error(`Invalid ${field}`);
  return redactObject(item);
}
function validateSource(source: MemorySource): void {
  if (!source || typeof source.session !== 'string' || !source.session.trim() || !Array.isArray(source.entries) || !source.entries.length || source.entries.some(e => typeof e !== 'string' || !e.trim()) || !ORIGINS.includes(source.origin)) throw new Error('Source session, nonempty entry IDs and valid origin are required');
}
function atomicWrite(path: string, content: string): void {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, path);
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temp, { force: true }); }
}

export class MemoryStore {
  readonly rootDir: string;
  readonly projectKey: string;
  readonly projectScope: MemoryScope;
  readonly warnings: string[] = [];
  private db?: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(rootDir: string, projectKey: string) {
    this.rootDir = resolve(rootDir);
    // Remote-based human keys are hashed for disk paths, never interpolated into paths.
    this.projectKey = projectKey;
    this.projectScope = `project:${projectKey}`;
    if (!projectKey.trim()) throw new Error('Project key is required');
  }
  async initialize(): Promise<void> {
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    await this.locked(async () => {
      if (!this.db) {
        // The npm host runs Node; the standalone Pi executable runs Bun. Keep
        // runtime-only builtins lazy so either host can load the extension.
        const moduleName = process.versions.bun ? 'bun:sqlite' : 'node:sqlite';
        const sqlite = await import(moduleName);
        const Database = process.versions.bun ? sqlite.Database : sqlite.DatabaseSync;
        this.db = new Database(join(this.rootDir, 'index.sqlite')) as DatabaseSync;
        this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, scope TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, file_hash TEXT NOT NULL);
          CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(id UNINDEXED,title,summary,keywords,triggers,body,tokenize='porter unicode61');`);
      }
      this.rebuild();
    });
  }
  private database(): DatabaseSync { if (!this.db) throw new Error('MemoryStore.initialize() must be called first'); return this.db; }
  private scope(value?: ScopeSelector): MemoryScope {
    const scope = !value || value === 'project' ? this.projectScope : value;
    if (scope !== 'global' && scope !== this.projectScope) throw new Error('Memory scope is outside the current project');
    return scope;
  }
  scopeDirectory(scope: ScopeSelector = 'project'): string {
    return this.scope(scope) === 'global' ? join(this.rootDir, 'global') : join(this.rootDir, 'projects', hash(this.projectKey).slice(0, 24));
  }
  private itemPath(item: MemoryItem): string {
    if (!ID.test(item.id)) throw new Error('Invalid memory ID');
    const dir = join(this.scopeDirectory(item.scope), item.status === 'active' || item.status === 'codified' ? 'items' : 'archive');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, `${item.id}.md`);
  }
  private reclaimDeadLock(lock: string): void {
    // Serialize reclaimers as well as writers: two stale-owner probes must not
    // both unlink a lock, since the second unlink could hit a new live owner.
    const recovery = `${lock}.recovery`;
    try { mkdirSync(recovery, { mode: 0o700 }); } catch { return; }
    try {
      try {
        const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as { pid: number };
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return;
        try { process.kill(owner.pid, 0); }
        catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') rmSync(lock, { recursive: true, force: true }); }
      } catch {
        // A process may die between mkdir and writing its PID; do not steal a
        // fresh directory while its creator is about to write the owner file.
        try { if (Date.now() - statSync(lock).mtimeMs > 30000) rmSync(lock, { recursive: true, force: true }); } catch { /* released meanwhile */ }
      }
    } finally { rmSync(recovery, { recursive: true, force: true }); }
  }
  private async locked<T>(fn: () => T | Promise<T>): Promise<T> {
    const action = this.queue.then(async () => {
      const lock = join(this.rootDir, '.mutation-lock');
      const start = Date.now();
      while (true) {
        try { mkdirSync(lock, { mode: 0o700 }); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          this.reclaimDeadLock(lock);
          if (Date.now() - start > 35000) throw new Error('Timed out waiting for memory mutation lock');
          await delay(20 + Math.random() * 30);
        }
      }
      try { writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 }); return await fn(); }
      finally { rmSync(lock, { recursive: true, force: true }); }
    });
    this.queue = action.catch(() => {});
    return action;
  }
  private rebuild(): number {
    this.recoverPending();
    const db = this.database();
    const files: string[] = [];
    const scopes = [join(this.rootDir, 'global')];
    const projects = join(this.rootDir, 'projects');
    if (existsSync(projects)) for (const dir of readdirSync(projects, { withFileTypes: true })) if (dir.isDirectory()) scopes.push(join(projects, dir.name));
    for (const scope of scopes) for (const area of ['items', 'archive']) {
      const directory = join(scope, area);
      if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) continue;
      for (const file of readdirSync(directory, { withFileTypes: true })) if (file.isFile() && file.name.endsWith('.md')) files.push(join(directory, file.name));
    }
    const items = new Map<string, { item: MemoryItem; text: string }>();
    this.warnings.length = 0;
    for (const file of files) try {
      const text = readFileSync(file, 'utf8'); const item = parseMemory(text);
      const expectedScope = file.startsWith(join(this.rootDir, 'global') + '/') ? item.scope === 'global' : item.scope.startsWith('project:') && file.startsWith(join(this.rootDir, 'projects', hash(item.scope.slice(8)).slice(0, 24)) + '/');
      if (!expectedScope || !file.endsWith(`/${item.id}.md`)) throw new Error('Scope or ID does not match file location');
      const previous = items.get(item.id)?.item;
      if (!previous || item.updated >= previous.updated) items.set(item.id, { item, text });
    } catch (error) { this.warnings.push(`${file}: ${(error as Error).message}`); }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM items; DELETE FROM items_fts');
      const itemInsert = db.prepare('INSERT INTO items VALUES (?,?,?,?,?)');
      const ftsInsert = db.prepare('INSERT INTO items_fts VALUES (?,?,?,?,?,?)');
      for (const { item, text } of items.values()) {
        itemInsert.run(item.id, item.scope, item.status, JSON.stringify(item), hash(text));
        ftsInsert.run(item.id, item.title, item.summary, item.keywords.join(' '), item.triggers.join(' '), item.body);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return items.size;
  }
  async reindex(): Promise<number> { return this.locked(() => this.rebuild()); }
  list(options: Pick<SearchOptions, 'scope' | 'includeArchived'> = {}): MemoryItem[] {
    const scopes = options.scope ? [this.scope(options.scope)] : ['global', this.projectScope];
    const rows = this.database().prepare(`SELECT payload FROM items WHERE scope IN (${scopes.map(() => '?').join(',')})${options.includeArchived ? '' : " AND status='active'"} ORDER BY id`).all(...scopes);
    return rows.map(row => JSON.parse(row.payload as string) as MemoryItem);
  }
  get(ids: string[]): MemoryItem[] {
    const wanted = new Set(ids); return this.list({ includeArchived: true }).filter(item => wanted.has(item.id));
  }
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const allowed = new Map(this.list(options).map(item => [item.id, item]));
    const match = terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ');
    const rows = this.database().prepare('SELECT id, bm25(items_fts,0,4,2,3,4,1) AS rank FROM items_fts WHERE items_fts MATCH ? ORDER BY rank').all(match);
    const results: SearchResult[] = [];
    for (const row of rows) {
      const item = allowed.get(row.id as string); if (!item || isSuspiciousMemory(`${item.title}\n${item.summary}\n${item.body}`)) continue;
      const lexicalScore = Math.max(0, -(row.rank as number));
      const scored = options.includeArchived ? { ...item, status: 'active' as const } : item;
      const score = options.strategy === 'baseline' ? lexicalScore : scoreMemory(scored, query);
      if (score > 0) results.push({ ...item, score });
    }
    return results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, Math.max(0, Math.min(100, options.limit ?? 10)));
  }
  private persist(item: MemoryItem): void {
    // Digests are derived snapshots. A source mutation invalidates the next
    // session's snapshot; the current session keeps its fixed prompt prefix.
    rmSync(join(this.scopeDirectory(item.scope), 'DIGEST.md'), { force: true });
    const target = this.itemPath(item); atomicWrite(target, serializeMemory(item));
    // Write the new canonical version before removing its previous location.
    for (const area of ['items', 'archive']) {
      const old = join(this.scopeDirectory(item.scope), area, `${item.id}.md`);
      if (old !== target) rmSync(old, { force: true });
    }
  }
  /** Complete a durably recorded multi-file change before rebuilding the index.
   * Recovery runs under the global mutation lock and may belong to another
   * project, so derive paths from validated scope data rather than caller scope.
   */
  private recoverPending(): void {
    const pending = join(this.rootDir, '.pending-supersession.json');
    if (!existsSync(pending)) return;
    const payload: unknown = JSON.parse(readFileSync(pending, 'utf8'));
    if (!Array.isArray(payload) || payload.length > 101) throw new Error('Invalid pending supersession');
    const items = payload.map(value => {
      if (typeof value !== 'string') throw new Error('Invalid pending memory');
      const item = parseMemory(value);
      if (item.scope !== 'global' && !/^project:.+$/.test(item.scope)) throw new Error('Invalid pending scope');
      return item;
    });
    for (const item of items) {
      const scopeDirectory = item.scope === 'global' ? join(this.rootDir, 'global') : join(this.rootDir, 'projects', hash(item.scope.slice(8)).slice(0, 24));
      const area = item.status === 'active' || item.status === 'codified' ? 'items' : 'archive';
      const directory = join(scopeDirectory, area);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      rmSync(join(scopeDirectory, 'DIGEST.md'), { force: true });
      atomicWrite(join(directory, `${item.id}.md`), serializeMemory(item));
      rmSync(join(scopeDirectory, area === 'items' ? 'archive' : 'items', `${item.id}.md`), { force: true });
    }
    rmSync(pending);
  }
  private persistSupersession(items: MemoryItem[]): void {
    atomicWrite(join(this.rootDir, '.pending-supersession.json'), JSON.stringify(items.map(serializeMemory)));
    this.recoverPending();
  }
  private journal(operation: string, ids: string[], note?: string): void {
    const directory = join(this.rootDir, 'journal'); mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendFileSync(join(directory, `${now().slice(0, 10)}.jsonl`), JSON.stringify({ at: now(), operation, ids, ...(note ? { note: redactSecrets(note) } : {}) }) + '\n', { mode: 0o600 });
  }
  async save(input: MemoryInput): Promise<MemoryItem> {
    validateSource(input.source);
    if (!input.title?.trim() || !input.body?.trim()) throw new Error('Title and body are required');
    if (input.body.length > 20000 || input.title.length > 300) throw new Error('Memory is too large');
    const scope = this.scope(input.scope);
    const clean = redactObject(input);
    return this.locked(() => {
      this.rebuild();
      const existing = this.list({ scope });
      const duplicate = existing.find(item => normalize(item.body) === normalize(clean.body));
      if (duplicate) {
        if (!duplicate.sources.some(source => JSON.stringify(source) === JSON.stringify(clean.source))) duplicate.sources.push(clean.source);
        duplicate.updated = now();
        this.persist(duplicate); this.journal('reinforce', [duplicate.id]); this.rebuild(); return duplicate;
      }
      const supersedes = [...new Set(clean.supersedes ?? [])];
      if (supersedes.length > 100) throw new Error('Too many supersession targets');
      const targets = this.get(supersedes);
      if (targets.length !== supersedes.length || targets.some(item => item.scope !== scope || item.status !== 'active')) throw new Error('Supersession targets must be active memories in the same scope');
      if (targets.some(item => (item.source.origin === 'user_statement' || item.source.origin === 'user_confirmation') && clean.source.origin === 'tool_output')) throw new Error('Tool output cannot supersede explicit user evidence');
      const timestamp = now();
      const item: MemoryItem = {
        id: `m_${Date.now().toString(36)}${randomBytes(10).toString('hex')}`, scope,
        type: clean.type ?? 'project', title: clean.title.trim(), body: clean.body.trim(), summary: clean.summary?.trim() || clean.body.trim().split('\n')[0]!.slice(0, 300),
        keywords: clean.keywords ?? [], triggers: clean.triggers ?? [], paths: clean.paths ?? [],
        importance: clean.importance ?? 5, confidence: clean.confidence ?? (clean.source.origin === 'tool_output' ? 0.6 : clean.source.origin === 'consolidation' ? 0.75 : 0.95),
        source: clean.source, sources: [clean.source], supersedes, links: clean.links ?? [], status: 'active', created: timestamp, updated: timestamp, last_used: timestamp,
        stats: { injected: 0, used: 0, helpful: 0, harmful: 0 },
      };
      parseMemory(serializeMemory(item));
      for (const target of targets) { target.status = 'superseded'; target.updated = timestamp; target.links.push(item.id); }
      if (targets.length) this.persistSupersession([item, ...targets]);
      else this.persist(item);
      this.journal(supersedes.length ? 'supersede' : 'add', [item.id, ...supersedes]); this.rebuild(); return item;
    });
  }
  async feedback(id: string, verdict: FeedbackVerdict, note?: string): Promise<MemoryItem> {
    if (!['helpful', 'harmful', 'outdated', 'used', 'ignored'].includes(verdict)) throw new Error('Invalid feedback verdict');
    return this.locked(() => {
      this.rebuild(); const item = this.get([id])[0]; if (!item) throw new Error('Memory not found in current scopes');
      if (verdict === 'outdated') { item.status = 'archived'; item.archive_reason = redactSecrets(note || 'Reported outdated'); }
      else if (verdict !== 'ignored') item.stats[verdict]++;
      if (verdict === 'used' || verdict === 'helpful') item.last_used = now();
      item.updated = now(); this.persist(item); this.journal(`feedback:${verdict}`, [id], note); this.rebuild(); return item;
    });
  }
  async archive(id: string, reason = 'Archived by user'): Promise<MemoryItem> {
    return this.locked(() => {
      this.rebuild(); const item = this.get([id])[0]; if (!item) throw new Error('Memory not found in current scopes');
      item.status = 'archived'; item.updated = now(); item.archive_reason = redactSecrets(reason);
      this.persist(item); this.journal('archive', [id], reason); this.rebuild(); return item;
    });
  }
  async markInjected(ids: string[], session?: string): Promise<void> {
    await this.locked(() => {
      this.rebuild();
      for (const item of this.get(ids)) { item.stats.injected++; item.last_used = now(); this.persist(item); }
      this.journal('inject', ids, session); this.rebuild();
    });
  }
  async markCodified(ids: string[], path: string): Promise<void> {
    if (!path.trim()) throw new Error('Codified artifact path is required');
    await this.locked(() => {
      this.rebuild(); const items = this.get([...new Set(ids)]);
      if (items.length !== new Set(ids).size || items.some(item => item.status !== 'active' && item.status !== 'codified')) throw new Error('Codification sources must be active memories');
      for (const item of items) { item.status = 'codified'; item.codified_as = redactSecrets(path); item.updated = now(); this.persist(item); }
      this.journal('codify', ids, path); this.rebuild();
    });
  }
  async consolidate(): Promise<{ archived: number; duplicates: number }> {
    return this.locked(() => {
      this.rebuild(); const seen = new Map<string, string>(); let archived = 0, duplicates = 0;
      for (const item of this.list()) {
        const key = `${item.scope}\0${normalize(item.body)}`;
        const prior = seen.get(key);
        if (prior) { item.status = 'archived'; item.links.push(prior); item.archive_reason = 'Exact duplicate'; duplicates++; }
        else {
          seen.set(key, item.id);
          const age = Math.max(0, (Date.now() - Date.parse(item.last_used)) / 86400000);
          const strength = Math.max(1, 1 + item.importance / 2 + item.stats.helpful - item.stats.harmful);
          if (!(item.type === 'feedback' && item.importance >= 9) && Math.exp(-age / strength) < 0.15) {
            item.status = 'archived'; item.archive_reason = 'Decayed without use'; archived++;
          }
        }
        if (item.status !== 'active') { item.updated = now(); this.persist(item); this.journal('consolidate:archive', [item.id], item.archive_reason); }
      }
      this.rebuild();
      for (const scope of ['global', this.projectScope] as const) {
        const candidates = this.list({ scope }).filter(item =>
          (item.type === 'feedback' || item.type === 'preference') && item.importance >= 8 && item.confidence >= 0.9 &&
          (item.source.origin === 'user_statement' || item.source.origin === 'user_confirmation')
        ).sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id));
        const directory = this.scopeDirectory(scope);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        atomicWrite(join(directory, 'DIGEST.md'), renderMemories(candidates, 600));
      }
      return { archived, duplicates };
    });
  }
  async clear(scope: 'project' | 'global' | 'all'): Promise<void> {
    if (!['project', 'global', 'all'].includes(scope)) throw new Error('Invalid clear scope');
    await this.locked(() => {
      if (scope === 'all') { rmSync(join(this.rootDir, 'global'), { recursive: true, force: true }); rmSync(join(this.rootDir, 'projects'), { recursive: true, force: true }); rmSync(join(this.rootDir, 'journal'), { recursive: true, force: true }); rmSync(join(this.rootDir, 'proposals'), { recursive: true, force: true }); }
      else rmSync(this.scopeDirectory(scope), { recursive: true, force: true });
      this.rebuild();
    });
  }
  export(): string { return this.list({ includeArchived: true }).map(serializeMemory).join('\n'); }
  close(): void { this.db?.close(); this.db = undefined; }
}
