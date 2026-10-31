import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MEMORY_TYPES, type FeedbackVerdict, type MemoryInput, type MemoryItem, type MemoryScope, type MemorySource, type ScopeSelector, type SearchOptions, type SearchResult } from './types.js';
import { redactSecrets, redactObject, isSuspiciousMemory } from './secrets.js';
import { queryTerms, scoreMemory, renderMemories, isExpired } from './retrieve.js';

const ID = /^m_[a-z0-9]{20,64}$/;
const ORIGINS = ['user_statement', 'user_confirmation', 'tool_output', 'consolidation'];
const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const now = () => new Date().toISOString();
export function evidenceHash(item: Pick<MemoryItem, 'title' | 'body' | 'scope' | 'retention' | 'expiresAt' | 'confidence' | 'source'>): string {
  return hash(JSON.stringify({ title: item.title, body: item.body, scope: item.scope, retention: item.retention ?? 'long', expiresAt: item.expiresAt ?? null, confidence: item.confidence, source: { origin: item.source.origin, session: item.source.session, entries: item.source.entries } }));
}

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
  normalizeLifetime(item);
  delete item.validity;
  if (item.raw !== undefined && (!['user', 'toolResult'].includes(item.raw.role) || !Number.isFinite(Date.parse(item.raw.at)))) throw new Error('Invalid raw entry');
  if (item.derivedFrom !== undefined && (!Array.isArray(item.derivedFrom) || !item.derivedFrom.length || item.derivedFrom.length > 100 || item.derivedFrom.some(source => !source || !ID.test(source.id) || !/^[a-f0-9]{64}$/.test(source.hash)) || item.source.origin !== 'consolidation')) throw new Error('Derived memories require consolidation provenance and valid source hashes');
  return redactObject(item);
}
function validateSource(source: MemorySource): void {
  if (!source || typeof source.session !== 'string' || !source.session.trim() || !Array.isArray(source.entries) || !source.entries.length || source.entries.some(e => typeof e !== 'string' || !e.trim()) || !ORIGINS.includes(source.origin)) throw new Error('Source session, nonempty entry IDs and valid origin are required');
}
function normalizeLifetime(item: Pick<MemoryInput, 'retention' | 'expiresAt'>): void {
  item.retention ??= 'long';
  if (item.retention !== 'long' && item.retention !== 'short') throw new Error('Invalid memory retention');
  if (item.retention === 'short') {
    if (typeof item.expiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(item.expiresAt) || !Number.isFinite(Date.parse(item.expiresAt))) throw new Error('Short-term memory requires an explicit ISO expiresAt');
    item.expiresAt = new Date(item.expiresAt).toISOString();
  } else if (item.expiresAt !== undefined) throw new Error('Only short-term memory may have expiresAt');
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
  private snapshots = new Map<string, { signature: string; item?: MemoryItem; hash?: string; error?: string }>();

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
        this.snapshots.clear();
        // The npm host runs Node; the standalone Pi executable runs Bun. Keep
        // runtime-only builtins lazy so either host can load the extension.
        const moduleName = process.versions.bun ? 'bun:sqlite' : 'node:sqlite';
        const sqlite = await import(moduleName);
        const Database = process.versions.bun ? sqlite.Database : sqlite.DatabaseSync;
        this.db = new Database(join(this.rootDir, 'index.sqlite')) as DatabaseSync;
        this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, scope TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, file_hash TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.95, retention TEXT NOT NULL DEFAULT 'long', expires_at TEXT);
          CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(id UNINDEXED,title,summary,keywords,triggers,body,tokenize='porter unicode61');`);
        const columns = new Set(this.db.prepare('PRAGMA table_info(items)').all().map(row => row.name));
        for (const [column, definition] of [['confidence', 'REAL NOT NULL DEFAULT 0.95'], ['retention', "TEXT NOT NULL DEFAULT 'long'"], ['expires_at', 'TEXT']]) {
          if (!columns.has(column)) this.db.exec(`ALTER TABLE items ADD COLUMN ${column} ${definition}`);
        }
        if (!columns.has('confidence') || !columns.has('retention') || !columns.has('expires_at')) this.db.exec("UPDATE items SET confidence=COALESCE(json_extract(payload,'$.confidence'),0.95),retention=COALESCE(json_extract(payload,'$.retention'),'long'),expires_at=json_extract(payload,'$.expiresAt')");
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
    return this.directoryForScope(this.scope(scope));
  }
  private directoryForScope(scope: MemoryScope): string {
    return scope === 'global' ? join(this.rootDir, 'global') : join(this.rootDir, 'projects', hash(scope.slice(8)).slice(0, 24));
  }
  private itemPath(item: MemoryItem): string {
    if (!ID.test(item.id)) throw new Error('Invalid memory ID');
    const dir = join(this.directoryForScope(item.scope), item.status === 'active' || item.status === 'codified' ? 'items' : 'archive');
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
  private rebuild(force = false): number {
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
    const items = new Map<string, { item: MemoryItem; hash: string }>();
    const present = new Set(files);
    let changed = force || this.snapshots.size !== files.length;
    this.warnings.length = 0;
    for (const file of this.snapshots.keys()) if (!present.has(file)) { this.snapshots.delete(file); changed = true; }
    for (const file of files) {
      const signature = this.signature(file);
      let snapshot = this.snapshots.get(file);
      if (force || snapshot?.signature !== signature) {
        changed = true;
        try {
          const text = readFileSync(file, 'utf8'); const item = parseMemory(text);
          if (!file.startsWith(this.directoryForScope(item.scope) + '/') || !file.endsWith(`/${item.id}.md`) || (item.scope !== 'global' && !item.scope.startsWith('project:'))) throw new Error('Scope or ID does not match file location');
          snapshot = { signature, item, hash: hash(text) };
        } catch (error) { snapshot = { signature, error: `${file}: ${(error as Error).message}` }; }
        this.snapshots.set(file, snapshot);
      }
      if (snapshot.error) this.warnings.push(snapshot.error);
      if (snapshot.item) {
        const previous = items.get(snapshot.item.id)?.item;
        if (!previous || snapshot.item.updated >= previous.updated) items.set(snapshot.item.id, { item: snapshot.item, hash: snapshot.hash! });
      }
    }
    // A fresh empty index still needs orphan cleanup after canonical files were
    // removed while no process was running; snapshots alone cannot detect that.
    const indexed = changed || !this.snapshots.size ? db.prepare('SELECT id,file_hash FROM items').all() : undefined;
    if (!indexed) return items.size;
    const priorHashes = new Map(indexed.map(row => [row.id as string, row.file_hash as string]));
    const updates = [...items.values()].filter(value => force || priorHashes.get(value.item.id) !== value.hash);
    const removed = [...priorHashes.keys()].filter(id => !items.has(id));
    if (!force && !updates.length && !removed.length) return items.size;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (force) db.exec('DELETE FROM items; DELETE FROM items_fts');
      const itemInsert = db.prepare('INSERT OR REPLACE INTO items (id,scope,status,payload,file_hash,confidence,retention,expires_at) VALUES (?,?,?,?,?,?,?,?)');
      const ftsInsert = db.prepare('INSERT INTO items_fts VALUES (?,?,?,?,?,?)');
      const deleteItem = db.prepare('DELETE FROM items WHERE id=?'), deleteFts = db.prepare('DELETE FROM items_fts WHERE id=?');
      for (const id of removed) { deleteItem.run(id); deleteFts.run(id); }
      for (const { item, hash: fileHash } of updates) {
        itemInsert.run(item.id, item.scope, item.status, JSON.stringify(item), fileHash, item.confidence, item.retention ?? 'long', item.expiresAt ?? null);
        if (!force && priorHashes.has(item.id)) deleteFts.run(item.id);
        ftsInsert.run(item.id, item.title, item.summary, item.keywords.join(' '), item.triggers.join(' '), item.body);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return items.size;
  }
  private signature(path: string): string {
    const stat = statSync(path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  }
  async reindex(force = false): Promise<number> { return this.locked(() => this.rebuild(force)); }
  list(options: Pick<SearchOptions, 'scope' | 'includeArchived'> = {}): MemoryItem[] {
    const scopes = options.scope ? [this.scope(options.scope)] : ['global', this.projectScope];
    const rows = this.database().prepare(`SELECT payload FROM items WHERE scope IN (${scopes.map(() => '?').join(',')})${options.includeArchived ? '' : " AND status='active'"} ORDER BY id`).all(...scopes);
    const cache = new Map<string, MemoryItem | undefined>();
    return rows.map(row => this.effectiveItem(JSON.parse(row.payload as string), cache)).filter(item => options.includeArchived || item.status === 'active');
  }
  get(ids: string[]): MemoryItem[] {
    if (!ids.length) return [];
    const wanted = [...new Set(ids)], cache = new Map<string, MemoryItem | undefined>();
    return this.database().prepare(`SELECT payload FROM items WHERE scope IN (?,?) AND id IN (${wanted.map(() => '?').join(',')}) ORDER BY id`).all('global', this.projectScope, ...wanted).map(row => this.effectiveItem(JSON.parse(row.payload as string), cache));
  }
  private validDerivation(item: MemoryItem, cache: Map<string, MemoryItem | undefined>, visiting = new Set<string>()): boolean {
    if (!item.derivedFrom?.length) return true;
    if (visiting.has(item.id) || item.source.origin !== 'consolidation') return false;
    visiting.add(item.id);
    try {
      return item.derivedFrom.every(reference => {
        if (!cache.has(reference.id)) {
          const row = this.database().prepare('SELECT payload FROM items WHERE id=?').get(reference.id);
          cache.set(reference.id, row ? JSON.parse(row.payload as string) : undefined);
        }
        const source = cache.get(reference.id);
        const lifetimeSafe = source?.retention !== 'short' || (item.retention === 'short' && !!item.expiresAt && Date.parse(item.expiresAt) <= Date.parse(source.expiresAt!));
        return !!source && source.scope === item.scope && source.status === 'active' && !isExpired(source) && lifetimeSafe && evidenceHash(source) === reference.hash && this.validDerivation(source, cache, visiting);
      });
    } finally { visiting.delete(item.id); }
  }
  private effectiveItem(item: MemoryItem, cache = new Map<string, MemoryItem | undefined>()): MemoryItem {
    if (isExpired(item)) return { ...item, status: 'archived', validity: 'expired' };
    if (!this.validDerivation(item, cache)) return { ...item, status: 'archived', validity: 'stale-derived' };
    return item;
  }
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const match = terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ');
    const scopes = options.scope ? [this.scope(options.scope)] : ['global', this.projectScope];
    const predicates = [`items.scope IN (${scopes.map(() => '?').join(',')})`];
    const params: Array<string | number> = [match, ...scopes];
    if (!options.includeArchived) {
      predicates.push("items.status='active'", "(items.retention != 'short' OR items.expires_at > ?)"); params.push(now());
    }
    if (options.automatic) predicates.push('items.confidence >= 0.5');
    // Bound scored candidates, not retained memories. Scope filtering precedes
    // the cap so unrelated repositories cannot crowd out this project's facts.
    const cap = options.strategy === 'baseline' ? '' : ' LIMIT 100';
    const rows = this.database().prepare(`SELECT items.payload, bm25(items_fts,0,4,2,3,4,1) AS rank FROM items_fts JOIN items ON items.id=items_fts.id WHERE items_fts MATCH ? AND ${predicates.join(' AND ')} ORDER BY rank${cap}`).all(...params);
    const results: SearchResult[] = [];
    const cache = new Map<string, MemoryItem | undefined>();
    for (const row of rows) {
      const item = this.effectiveItem(JSON.parse(row.payload as string), cache); if ((!options.includeArchived && item.status !== 'active') || isSuspiciousMemory(`${item.title}\n${item.summary}\n${item.body}`)) continue;
      const lexicalScore = Math.max(0, -(row.rank as number));
      const scored = options.includeArchived ? { ...item, status: 'active' as const, retention: 'long' as const, expiresAt: undefined } : item;
      const score = options.strategy === 'baseline' ? lexicalScore : scoreMemory(scored, query, false, lexicalScore);
      if (score > 0) results.push({ ...item, score });
    }
    return results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, Math.max(0, Math.min(100, options.limit ?? 10)));
  }
  private persist(item: MemoryItem, invalidateDigest = true): void {
    // Digests are derived snapshots. A source mutation invalidates the next
    // session's snapshot; the current session keeps its fixed prompt prefix.
    if (invalidateDigest) rmSync(join(this.directoryForScope(item.scope), 'DIGEST.md'), { force: true });
    const target = this.itemPath(item); atomicWrite(target, serializeMemory(item));
    // Write the new canonical version before removing its previous location.
    for (const area of ['items', 'archive']) {
      const old = join(this.directoryForScope(item.scope), area, `${item.id}.md`);
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
      const scopeDirectory = this.directoryForScope(item.scope);
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
    normalizeLifetime(clean);
    return this.locked(() => {
      this.rebuild();
      if (clean.derivedFrom !== undefined) {
        if (clean.source.origin !== 'consolidation' || !Array.isArray(clean.derivedFrom) || !clean.derivedFrom.length || clean.derivedFrom.length > 100 || clean.derivedFrom.some(reference => !reference || !ID.test(reference.id) || !/^[a-f0-9]{64}$/.test(reference.hash))) throw new Error('Derived memories require consolidation provenance and valid source hashes');
        const sources = this.get(clean.derivedFrom.map(reference => reference.id));
        if (sources.length !== clean.derivedFrom.length || sources.some(source => source.scope !== scope || source.status !== 'active' || evidenceHash(source) !== clean.derivedFrom!.find(reference => reference.id === source.id)!.hash)) throw new Error('Derived memory sources must be current active evidence in the same scope');
        const expiries = sources.filter(source => source.retention === 'short').map(source => Date.parse(source.expiresAt!));
        if (expiries.length && (clean.retention !== 'short' || Date.parse(clean.expiresAt!) > Math.min(...expiries))) throw new Error('Derived memory must inherit the earliest short-term source expiry');
      }
      // A raw entry may reinforce anything, but a raw entry must never absorb the long-term memory distilled from it.
      const existing = this.list({ scope, includeArchived: true }).filter(item => (item.status === 'active' || (clean.retention === 'short' && isExpired(item))) && (clean.raw || !item.raw));
      const duplicate = existing.find(item => normalize(item.body) === normalize(clean.body) && (item.retention ?? 'long') === (clean.retention ?? 'long') && item.expiresAt === clean.expiresAt);
      const supersedes = [...new Set(clean.supersedes ?? [])];
      if (supersedes.length > 100) throw new Error('Too many supersession targets');
      const targets = this.get(supersedes);
      if (targets.length !== supersedes.length || targets.some(item => item.scope !== scope || (item.status !== 'active' && !(item.status === 'superseded' && duplicate?.supersedes.includes(item.id) && item.links.includes(duplicate.id))))) throw new Error('Supersession targets must be active memories in the same scope');
      if (clean.retention === 'short' && targets.some(item => (item.retention ?? 'long') === 'long')) throw new Error('Short-term overrides cannot supersede long-term memory');
      if (targets.some(item => (item.source.origin === 'user_statement' || item.source.origin === 'user_confirmation') && clean.source.origin !== 'user_statement' && clean.source.origin !== 'user_confirmation')) throw new Error('Non-user evidence cannot supersede explicit user evidence');
      if (duplicate) {
        if (!duplicate.sources.some(source => JSON.stringify(source) === JSON.stringify(clean.source))) duplicate.sources.push(clean.source);
        duplicate.updated = now();
        const retired = targets.filter(target => target.id !== duplicate.id && target.status === 'active');
        duplicate.supersedes = [...new Set([...duplicate.supersedes, ...retired.map(target => target.id)])];
        for (const target of retired) { target.status = 'superseded'; target.updated = duplicate.updated; target.links = [...new Set([...target.links, duplicate.id])]; }
        if (retired.length) this.persistSupersession([duplicate, ...retired]);
        else this.persist(duplicate);
        this.journal(retired.length ? 'supersede' : 'reinforce', [duplicate.id, ...retired.map(target => target.id)]); this.rebuild(); return duplicate;
      }
      const timestamp = now();
      let item: MemoryItem = {
        id: `m_${Date.now().toString(36)}${randomBytes(10).toString('hex')}`, scope,
        type: clean.type ?? 'project', title: clean.title.trim(), body: clean.body.trim(), summary: clean.summary?.trim() || clean.body.trim().split('\n')[0]!.slice(0, 300),
        keywords: clean.keywords ?? [], triggers: clean.triggers ?? [], paths: clean.paths ?? [],
        importance: clean.importance ?? 5, confidence: clean.confidence ?? (clean.source.origin === 'tool_output' ? 0.6 : clean.source.origin === 'consolidation' ? 0.75 : 0.95),
        source: clean.source, sources: [clean.source], supersedes, links: clean.links ?? [], status: 'active', created: timestamp, updated: timestamp, last_used: timestamp,
        stats: { injected: 0, used: 0, helpful: 0, harmful: 0 },
        retention: clean.retention ?? 'long', ...(clean.expiresAt ? { expiresAt: clean.expiresAt } : {}),
        ...(clean.derivedFrom ? { derivedFrom: clean.derivedFrom } : {}),
        ...(clean.raw ? { raw: clean.raw } : {}),
      };
      item = parseMemory(serializeMemory(item));
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
  /** This project's wake layer, oldest first. */
  rawEntries(): MemoryItem[] {
    return this.list({ scope: 'project' }).filter(item => item.raw).sort((a, b) => a.raw!.at.localeCompare(b.raw!.at) || a.id.localeCompare(b.id));
  }
  /** Retires raw entries the sleep pass has handled; each stays archived with the memories that now hold it. */
  async settleRaw(outcomes: Map<string, string[]>): Promise<void> {
    await this.locked(() => {
      this.rebuild();
      for (const item of this.get([...outcomes.keys()])) {
        if (!item.raw || item.status !== 'active') continue;
        const into = [...new Set(outcomes.get(item.id)!)];
        item.status = 'archived'; item.updated = now(); item.raw.settledInto = into;
        item.archive_reason = into.length ? `Assimilated into ${into.join(', ')}` : 'Pruned by the sleep pass';
        this.persist(item, false);
      }
      this.journal('settle', [...outcomes.keys()]); this.rebuild();
    });
  }
  async markInjected(ids: string[], session?: string): Promise<void> {
    await this.locked(() => {
      this.rebuild();
      const items = this.get(ids).filter(item => item.status === 'active' && !isExpired(item));
      const db = this.database();
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const item of items) {
          item.stats.injected++; item.last_used = now(); this.persist(item, false);
          const text = serializeMemory(item), path = this.itemPath(item), fileHash = hash(text);
          // Usage does not change searchable text; update metadata without any
          // FTS rewrite or second full filesystem scan.
          db.prepare('UPDATE items SET payload=?,file_hash=? WHERE id=?').run(JSON.stringify(item), fileHash, item.id);
          this.snapshots.set(path, { signature: this.signature(path), item, hash: fileHash });
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); this.snapshots.clear(); throw error; }
      this.journal('inject', items.map(item => item.id), session);
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
      const candidates = this.database().prepare("SELECT payload FROM items WHERE status='active' AND scope IN (?,?)").all('global', this.projectScope).map(row => JSON.parse(row.payload as string) as MemoryItem);
      for (const item of candidates) {
        if (item.raw) continue;
        const key = `${item.scope}\0${item.retention ?? 'long'}\0${item.expiresAt ?? ''}\0${normalize(item.body)}`;
        const prior = seen.get(key);
        if (!this.validDerivation(item, new Map())) { item.status = 'archived'; item.archive_reason = 'Derived source changed or retired'; archived++; }
        else if (isExpired(item)) { item.status = 'archived'; item.archive_reason = 'Short-term memory expired'; archived++; }
        else if (prior) { item.status = 'archived'; item.links.push(prior); item.archive_reason = 'Exact duplicate'; duplicates++; }
        else {
          seen.set(key, item.id);
          // Durable knowledge is not made false by lack of recent use. Expiry,
          // explicit feedback, supersession and deduplication drive retirement.
        }
        if (item.status !== 'active') { item.updated = now(); this.persist(item); this.journal('consolidate:archive', [item.id], item.archive_reason); }
      }
      this.rebuild();
      for (const scope of ['global', this.projectScope] as const) {
        const candidates = this.list({ scope }).filter(item => this.isStandingRule(item)).sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id));
        const directory = this.scopeDirectory(scope);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        atomicWrite(join(directory, 'DIGEST.md'), renderMemories(candidates, 600));
      }
      return { archived, duplicates };
    });
  }
  private isStandingRule(item: MemoryItem, digestScope: 'rules' | 'decisions' = 'rules'): boolean {
    const standingType = item.type === 'feedback' || item.type === 'preference' || (digestScope === 'decisions' && item.type === 'project' && item.retention !== 'short');
    return item.status === 'active' && !item.raw && !isExpired(item) && standingType && item.importance >= 8 && item.confidence >= 0.9 &&
      (item.source.origin === 'user_statement' || item.source.origin === 'user_confirmation');
  }
  /** A compiled digest selects IDs; all prose is rebuilt from current sources.
   * Call initialize/reindex first to incorporate edits made with ordinary tools.
   * With digestScope "decisions", standing items are selected live from current canonical sources (user-stated durable
   * project decisions included), so an always-on "wake" block exists before the first consolidation. Digest prose is never read.
   */
  readDigest(budgetTokens = 1200, digestScope: 'rules' | 'decisions' = 'rules'): string {
    const chosen: MemoryItem[] = [];
    for (const scope of ['global', this.projectScope] as const) {
      if (digestScope === 'decisions') { chosen.push(...this.list({ scope }).filter(item => this.isStandingRule(item, digestScope))); continue; }
      const path = join(this.scopeDirectory(scope), 'DIGEST.md');
      if (!existsSync(path)) continue;
      const ids = new Set([...readFileSync(path, 'utf8').matchAll(/\[(m_[a-z0-9]{20,64})\]/g)].map(match => match[1]!));
      chosen.push(...this.list({ scope }).filter(item => ids.has(item.id) && this.isStandingRule(item)));
    }
    return renderMemories(chosen.sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id)), budgetTokens);
  }
  async archiveAll(scope: 'project' | 'global' | 'all', reason = 'Scoped clear'): Promise<number> {
    if (!['project', 'global', 'all'].includes(scope)) throw new Error('Invalid archive scope');
    return this.locked(() => {
      this.rebuild();
      const items = scope === 'all'
        ? this.database().prepare("SELECT payload FROM items WHERE status IN ('active','codified')").all().map(row => JSON.parse(row.payload as string) as MemoryItem)
        : this.list({ scope, includeArchived: true }).filter(item => item.status === 'active' || item.status === 'codified');
      for (const item of items) { item.status = 'archived'; item.archive_reason = redactSecrets(reason); item.updated = now(); this.persist(item); }
      this.journal('archive-all', items.map(item => item.id), reason); this.rebuild();
      return items.length;
    });
  }
  async clear(scope: 'project' | 'global' | 'all'): Promise<void> {
    if (!['project', 'global', 'all'].includes(scope)) throw new Error('Invalid clear scope');
    await this.locked(() => {
      // Finish interrupted writes first; replaying them after deletion would
      // resurrect memories the user just cleared.
      this.recoverPending();
      if (scope === 'all') { rmSync(join(this.rootDir, 'global'), { recursive: true, force: true }); rmSync(join(this.rootDir, 'projects'), { recursive: true, force: true }); rmSync(join(this.rootDir, 'journal'), { recursive: true, force: true }); rmSync(join(this.rootDir, 'proposals'), { recursive: true, force: true }); }
      else rmSync(this.scopeDirectory(scope), { recursive: true, force: true });
      this.rebuild();
    });
  }
  export(): string { return this.list({ includeArchived: true }).map(serializeMemory).join('\n'); }
  close(): void { this.db?.close(); this.db = undefined; }
}
