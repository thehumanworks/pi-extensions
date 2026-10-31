import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { evidenceHash, type MemoryStore } from './store.ts';
import type { MemoryItem, MemoryScope } from './types.ts';
import { isSuspiciousMemory, redactSecrets } from './secrets.ts';

export type ProposalKind = 'skill' | 'prompt' | 'agent' | 'hook' | 'instructions';
/** Patterns are literal substrings, not executable regular expressions. */
export interface HookRule { tool: string; pattern?: string; action: 'block' | 'confirm' | 'warn'; message: string }
export interface Proposal {
  id: string; kind: ProposalKind; name: string; memoryIds: string[]; scope: MemoryScope;
  draft: string; rationale: string; status: 'pending' | 'applied' | 'rejected'; created: string;
  provenance: Array<{ id: string; session: string; entries: string[]; origin: string; hash: string; evidenceVersion?: 1 }>;
  destination?: string;
}
export interface MaintenanceOptions { root: string; projectKey: string; cwd: string; agentDir?: string }
const KINDS = ['skill', 'prompt', 'agent', 'hook', 'instructions'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const validName = (name: string) => /^[a-z][a-z0-9-]{0,63}$/.test(name);
const validId = (id: string) => /^p_[a-f0-9-]{36}$/.test(id);
async function atomic(path: string, value: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, value, { mode: 0o600, flag: 'wx' });
  await rename(tmp, path);
}
function validateHook(value: HookRule): void {
  if (!value || typeof value.tool !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/.test(value.tool) || !['block', 'confirm', 'warn'].includes(value.action) || typeof value.message !== 'string' || !value.message.trim() || value.message.length > 1000 || (value.pattern !== undefined && (typeof value.pattern !== 'string' || value.pattern.length > 500))) throw new Error('Invalid declarative hook rule');
}
/** Follow no symlink below an explicitly allowed root, including the destination file. */
async function safeDestination(base: string, parts: string[]): Promise<string> {
  await mkdir(base, { recursive: true });
  let path = await realpath(base);
  for (const [index, part] of parts.entries()) {
    if (!part || part === '.' || part === '..' || /[\/\\]/.test(part)) throw new Error('Invalid artifact path');
    path = join(path, part);
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Refusing symlink artifact destination'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (index < parts.length - 1) await mkdir(path, { recursive: false }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  }
  return path;
}
function draft(kind: ProposalKind, name: string, items: MemoryItem[], hook?: HookRule): string {
  const title = items[0]!.title.replace(/[\r\n]/g, ' ');
  const body = items.map(item => `### ${item.title}\n\n${item.body}\n\n<!-- Source memory: ${item.id} -->`).join('\n\n');
  switch (kind) {
    case 'skill': return `---\nname: ${name}\ndescription: ${JSON.stringify(title)}\n---\n\n# ${title}\n\n${body}\n`;
    case 'prompt': return `---\ndescription: ${JSON.stringify(title)}\n---\n\n${body}\n`;
    case 'agent': return `---\nname: ${name}\ndescription: ${JSON.stringify(title)}\n---\n\n${body}\n`;
    case 'hook':
      if (!hook) throw new Error('A hook proposal requires an explicit declarative rule');
      validateHook(hook);
      return JSON.stringify({ ...hook, memoryIds: items.map(item => item.id) }, null, 2) + '\n';
    case 'instructions': return `\n<!-- pi-memory:${name} -->\n${body}\n<!-- /pi-memory:${name} -->\n`;
  }
}

/** Explicit proposals only: models cannot select filesystem destinations or apply drafts. */
export class ProposalManager {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: MemoryStore, private options: MaintenanceOptions) {}
  private directory(): string { return join(this.options.root, 'proposals'); }
  private path(id: string): string { if (!validId(id)) throw new Error('Invalid proposal ID'); return join(this.directory(), `${id}.json`); }
  async propose(kind: ProposalKind, memoryIds: string[], name: string, hookRule?: HookRule): Promise<Proposal> {
    if (!KINDS.includes(kind) || !validName(name)) throw new Error('Invalid proposal kind or name');
    if (!memoryIds.length || memoryIds.length > 20 || new Set(memoryIds).size !== memoryIds.length) throw new Error('Supply 1 to 20 unique source memories');
    const items = this.store.get(memoryIds);
    if (items.length !== memoryIds.length || items.some(item => !['active', 'codified'].includes(item.status))) throw new Error('Proposal sources must be active memories in current scopes');
    if (items.some(item => item.retention === 'short' || item.raw || (item.expiresAt && Date.parse(item.expiresAt) <= Date.now()))) throw new Error('Temporary memories cannot be codified; supply separate durable evidence');
    if (items.some(item => isSuspiciousMemory(item.body))) throw new Error('Suspicious instructions cannot be codified');
    const proposal: Proposal = {
      id: `p_${randomUUID()}`, kind, name, memoryIds, scope: items.every(item => item.scope === 'global') ? 'global' : `project:${this.options.projectKey}`,
      draft: redactSecrets(draft(kind, name, items, hookRule)), rationale: `Explicitly requested ${kind} derived from ${items.length} source memories; review the full draft before applying.`,
      status: 'pending', created: new Date().toISOString(),
      provenance: items.map(item => ({ id: item.id, session: item.source.session, entries: item.source.entries, origin: item.source.origin, hash: evidenceHash(item), evidenceVersion: 1 })),
    };
    await mkdir(this.directory(), { recursive: true, mode: 0o700 });
    await atomic(this.path(proposal.id), JSON.stringify(proposal, null, 2));
    return proposal;
  }
  async list(): Promise<Proposal[]> {
    let files: string[];
    try { files = await readdir(this.directory()); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const proposals: Proposal[] = [];
    for (const file of files.filter(file => file.endsWith('.json'))) {
      const proposal = await this.read(basename(file, '.json'));
      if (proposal.scope === 'global' || proposal.scope === `project:${this.options.projectKey}`) proposals.push(proposal);
    }
    return proposals.sort((a, b) => a.created.localeCompare(b.created));
  }
  private async read(id: string): Promise<Proposal> {
    const proposal = JSON.parse(await readFile(this.path(id), 'utf8')) as Proposal;
    if (proposal.id !== id || !KINDS.includes(proposal.kind) || !validName(proposal.name) || !Array.isArray(proposal.memoryIds) || !Array.isArray(proposal.provenance) || typeof proposal.draft !== 'string' || proposal.draft.length > 100000 || !['pending', 'applied', 'rejected'].includes(proposal.status)) throw new Error('Invalid proposal');
    return proposal;
  }
  async apply(id: string, reviewed: boolean): Promise<Proposal> {
    if (reviewed !== true) throw new Error('Explicit review is required before applying any proposal');
    const operation = this.queue.then(() => this.applyReviewed(id));
    this.queue = operation.catch(() => {});
    return operation;
  }
  private async applyReviewed(id: string): Promise<Proposal> {
    const proposal = await this.read(id);
    if (proposal.status !== 'pending') throw new Error('Proposal is not pending');
    if (!['global', `project:${this.options.projectKey}`].includes(proposal.scope)) throw new Error('Proposal belongs to another project');
    const sources = this.store.get(proposal.memoryIds);
    if (sources.length !== proposal.memoryIds.length || sources.some(item => !['active', 'codified'].includes(item.status) || (proposal.provenance.find(p => p.id === item.id)?.evidenceVersion !== 1 || proposal.provenance.find(p => p.id === item.id)?.hash !== evidenceHash(item)))) throw new Error('Proposal evidence changed; create and review a new proposal');
    if (sources.some(item => item.retention === 'short' || (item.expiresAt && Date.parse(item.expiresAt) <= Date.now()))) throw new Error('Temporary memories cannot be codified; supply separate durable evidence');
    if (isSuspiciousMemory(proposal.draft) || redactSecrets(proposal.draft) !== proposal.draft) throw new Error('Unsafe proposal draft');
    const scopeRoot = this.store.scopeDirectory(proposal.scope);
    let destination: string;
    switch (proposal.kind) {
      case 'skill': destination = await safeDestination(scopeRoot, ['skills', proposal.name, 'SKILL.md']); break;
      case 'prompt': destination = await safeDestination(scopeRoot, ['prompts', `${proposal.name}.md`]); break;
      case 'hook': validateHook(JSON.parse(proposal.draft)); destination = await safeDestination(scopeRoot, ['hooks', `${proposal.name}.json`]); break;
      case 'agent': destination = await safeDestination(this.options.agentDir || join(this.options.cwd, '.pi'), ['agents', `${proposal.name}.md`]); break;
      case 'instructions': destination = await safeDestination(this.options.cwd, ['AGENTS.md']); break;
    }
    let existing: string | undefined;
    try { existing = await readFile(destination, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (proposal.kind === 'instructions') {
      if (existing?.includes(`<!-- pi-memory:${proposal.name} -->`) && !existing.includes(proposal.draft)) throw new Error('Instructions already contain a different proposal with this name');
      if (!existing?.includes(proposal.draft)) await atomic(destination, (existing || '') + proposal.draft);
    } else {
      if (existing !== undefined && existing !== proposal.draft) throw new Error('Refusing to overwrite an existing artifact');
      if (existing === undefined) await writeFile(destination, proposal.draft, { flag: 'wx', mode: 0o600 });
    }
    proposal.status = 'applied'; proposal.destination = destination;
    if (['skill', 'prompt', 'hook'].includes(proposal.kind)) await this.store.markCodified(proposal.memoryIds, destination);
    await appendFile(join(this.options.root, 'ledger.jsonl'), JSON.stringify({ proposal: id, kind: proposal.kind, scope: proposal.scope, path: destination, sha256: hash(proposal.draft), memoryIds: proposal.memoryIds, artifact: ['agent', 'instructions'].includes(proposal.kind) ? proposal : undefined, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    await atomic(this.path(id), JSON.stringify(proposal, null, 2));
    return proposal;
  }
  /** Earned recurring procedures become drafts only; never applies them automatically. */
  async proposeEarned(): Promise<Proposal[]> {
    const existing = await this.list();
    const result: Proposal[] = [];
    for (const item of this.store.list()) {
      if (item.retention === 'short' || item.type !== 'procedure' || item.confidence < 0.8 || new Set(item.sources.filter(source => source.origin !== 'tool_output').map(source => source.session)).size < 2) continue;
      if (existing.some(proposal => proposal.kind === 'skill' && proposal.memoryIds.includes(item.id))) continue;
      const name = `memory-${item.id.slice(2, 50)}`;
      result.push(await this.propose('skill', [item.id], name));
    }
    return result;
  }
  /** Clear proposal-backed hooks immediately; preserve edited external artifacts. */
  async cleanup(scope: 'project' | 'global' | 'all', includingCodified: boolean): Promise<{ proposals: number; artifacts: number; dreamFiles: number; preserved: string[] }> {
    if (!['project', 'global', 'all'].includes(scope)) throw new Error('Invalid cleanup scope');
    const result = { proposals: 0, artifacts: 0, dreamFiles: 0, preserved: [] as string[] };
    const records: Proposal[] = [];
    let files: string[] = [];
    try { files = await readdir(this.directory()); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const file of files.filter(file => /^p_[a-f0-9-]{36}\.json$/.test(file))) records.push(await this.read(basename(file, '.json')));
    const external = new Map<string, Proposal>();
    const completed = new Set<string>();
    if (includingCodified) {
      let ledger = '';
      try { ledger = await readFile(join(this.options.root, 'ledger.jsonl'), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      for (const line of ledger.split('\n').filter(Boolean)) {
        const entry = JSON.parse(line) as { operation?: string; proposal: string; artifact?: Proposal };
        if (entry.operation === 'artifact-cleaned') completed.add(entry.proposal);
        if (entry.artifact && validId(entry.artifact.id) && validName(entry.artifact.name)) external.set(entry.artifact.id, entry.artifact);
      }
    }
    for (const proposal of records) if (proposal.status === 'applied') external.set(proposal.id, proposal);
    const inScope = (proposal: { scope: string }) => scope === 'all' || proposal.scope === (scope === 'global' ? 'global' : `project:${this.options.projectKey}`);
    if (includingCodified) for (const proposal of external.values()) {
      if (!inScope(proposal) || completed.has(proposal.id) || !proposal.destination || !['agent', 'instructions'].includes(proposal.kind)) continue;
      // An all-scope clear cannot infer another project's instructions directory safely.
      if (proposal.kind === 'instructions' && proposal.scope !== `project:${this.options.projectKey}`) { result.preserved.push(proposal.destination); continue; }
      const base = proposal.kind === 'agent' ? (this.options.agentDir || join(this.options.cwd, '.pi')) : this.options.cwd;
      const parts = proposal.kind === 'agent' ? ['agents', `${proposal.name}.md`] : ['AGENTS.md'];
      const expected = await safeDestination(base, parts);
      if (resolve(proposal.destination) !== expected) { result.preserved.push(proposal.destination); continue; }
      let content: string | undefined;
      try { content = await readFile(expected, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      let cleaned = content === undefined;
      if (content !== undefined) {
        if (proposal.kind === 'instructions' && content.includes(proposal.draft)) {
          await atomic(expected, content.replace(proposal.draft, '')); result.artifacts++; cleaned = true;
        } else if (proposal.kind === 'agent' && content === proposal.draft) {
          await unlink(expected); result.artifacts++; cleaned = true;
        } else result.preserved.push(expected);
      }
      if (cleaned) await appendFile(join(this.options.root, 'ledger.jsonl'), JSON.stringify({ operation: 'artifact-cleaned', proposal: proposal.id, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    }
    for (const proposal of records) {
      if (!inScope(proposal)) continue;
      await unlink(this.path(proposal.id)); result.proposals++;
      await appendFile(join(this.options.root, 'ledger.jsonl'), JSON.stringify({ operation: 'clear-proposal', proposal: proposal.id, scope: proposal.scope, includingCodified, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    }
    // Hypotheses may contain facts even though they are not active memories; scoped clear removes them too.
    for (const area of ['', 'runs', 'hypotheses']) {
      const directory = join(this.options.root, 'dream', area);
      let names: string[] = [];
      try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      for (const name of names.filter(name => /^(?:processed-[a-f0-9]{24}|[a-f0-9]{64}|h_[a-f0-9]{24})\.json$/.test(name))) {
        const path = join(directory, name);
        const record = JSON.parse(await readFile(path, 'utf8')) as { scope?: string; sourceEvidence?: Array<{ scope?: string }> };
        const recordScope = record.scope || record.sourceEvidence?.[0]?.scope;
        if (scope === 'all' || (recordScope && inScope({ scope: recordScope }))) { await unlink(path); result.dreamFiles++; }
      }
    }
    // Clearing is a user instruction: do not resurrect a pending pre-clear transcript later.
    let captures: string[] = [];
    try { captures = await readdir(join(this.options.root, 'capture')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const file of captures.filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
      const path = join(this.options.root, 'capture', file);
      const state = JSON.parse(await readFile(path, 'utf8')) as { processed: string[]; pending?: { projectKey: string; entries: string[] } };
      if (state.pending && (scope !== 'project' || state.pending.projectKey === this.options.projectKey)) {
        state.processed = [...new Set([...state.processed, ...state.pending.entries])]; delete state.pending;
        await atomic(path, JSON.stringify(state));
      }
    }
    return result;
  }
  async reject(id: string): Promise<void> {
    const proposal = await this.read(id);
    if (proposal.status !== 'pending') throw new Error('Proposal is not pending');
    proposal.status = 'rejected';
    await atomic(this.path(id), JSON.stringify(proposal, null, 2));
  }
}

/** Exact deduplication and conservative decay retain all archived evidence. */
export async function consolidate(store: MemoryStore): Promise<{ archived: number; duplicates: number }> {
  return store.consolidate();
}
