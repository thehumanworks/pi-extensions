import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { MemoryStore } from './store.ts';
import type { MemoryItem, MemoryScope } from './types.ts';
import { isSuspiciousMemory, redactSecrets } from './secrets.ts';

export type ProposalKind = 'skill' | 'prompt' | 'agent' | 'hook' | 'instructions';
/** Patterns are literal substrings, not executable regular expressions. */
export interface HookRule { tool: string; pattern?: string; action: 'block' | 'confirm' | 'warn'; message: string }
export interface Proposal {
  id: string; kind: ProposalKind; name: string; memoryIds: string[]; scope: MemoryScope;
  draft: string; rationale: string; status: 'pending' | 'applied' | 'rejected'; created: string;
  provenance: Array<{ id: string; session: string; entries: string[]; origin: string; hash: string }>;
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
    if (items.length !== memoryIds.length || items.some(item => item.status !== 'active')) throw new Error('Proposal sources must be active memories in current scopes');
    if (items.some(item => isSuspiciousMemory(item.body))) throw new Error('Suspicious instructions cannot be codified');
    const proposal: Proposal = {
      id: `p_${randomUUID()}`, kind, name, memoryIds, scope: items.every(item => item.scope === 'global') ? 'global' : `project:${this.options.projectKey}`,
      draft: redactSecrets(draft(kind, name, items, hookRule)), rationale: `Explicitly requested ${kind} derived from ${items.length} source memories; review the full draft before applying.`,
      status: 'pending', created: new Date().toISOString(),
      provenance: items.map(item => ({ id: item.id, session: item.source.session, entries: item.source.entries, origin: item.source.origin, hash: hash(item.body) })),
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
    if (sources.length !== proposal.memoryIds.length || sources.some(item => item.status !== 'active' || proposal.provenance.find(p => p.id === item.id)?.hash !== hash(item.body))) throw new Error('Proposal evidence changed; create and review a new proposal');
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
    await appendFile(join(this.options.root, 'ledger.jsonl'), JSON.stringify({ proposal: id, kind: proposal.kind, scope: proposal.scope, path: destination, sha256: hash(proposal.draft), memoryIds: proposal.memoryIds, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    await atomic(this.path(id), JSON.stringify(proposal, null, 2));
    return proposal;
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
