import { mkdir, mkdtemp, chmod, writeFile, open, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, opaque, type Obj } from './util.ts';
export interface Source { handle: string; source: Obj; }
interface Entry { file: string; digest: string; source: Obj; }
export class ResultStore {
  private directory: Promise<string> | undefined;
  private entries = new Map<string, Entry>();
  private bytes = 0;
  private closed = false;
  private closing: Promise<void> | undefined;
  private pending = new Set<Promise<Source>>();
  constructor(private readonly parent: string = tmpdir(), private readonly maxBytes = 67108864) {}
  put(raw: string, metadata: Obj): Promise<Source> {
    const pending = this.write(raw, metadata);
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending;
  }
  private async write(raw: string, metadata: Obj): Promise<Source> {
    if (this.closed) throw new Error('Service closed; re-fetch in a new runtime');
    const bytes = Buffer.byteLength(raw, 'utf8');
    if (this.entries.size + this.pending.size >= 2000) throw new Error('Private result count limit exceeded; start a new runtime and re-fetch');
    if (this.bytes + bytes > this.maxBytes) throw new Error('Private result storage limit exceeded; start a new runtime and re-fetch');
    this.bytes += bytes;
    const handle = opaque();
    try {
      const directory = await (this.directory ??= mkdir(this.parent, { recursive: true, mode: 0o700 }).then(() => mkdtemp(join(this.parent, 'pi-atlassian-'))).then(async d => { await chmod(d, 0o700); return d; }));
      if (this.closed) throw new Error('Service closed; re-fetch');
      const file = join(directory, handle);
      await writeFile(file, raw, { encoding: 'utf8', mode: 0o600, flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW });
      const digest = hash(raw);
      const source = { ...metadata, sha256: digest, checksum: digest, byteLength: bytes, totalLength: raw.length, retrievedAt: new Date().toISOString(), exact: metadata.exact ?? true, untrusted: true };
      this.entries.set(handle, { file, digest, source });
      return { handle, source };
    } catch (error) { this.bytes -= bytes; throw error; }
  }
  async get(handle: string): Promise<{ raw: string; source: Obj }> {
    const entry = this.entries.get(handle);
    if (this.closed || !entry) throw new Error('Unknown, expired or restarted handle; re-fetch the source');
    const file = await open(entry.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: string;
    try {
      if (!(await file.stat()).isFile()) throw new Error('Source integrity failed; re-fetch');
      raw = await file.readFile('utf8');
    } finally { await file.close(); }
    if (hash(raw) !== entry.digest) throw new Error('Source checksum failed; re-fetch');
    return { raw, source: { ...entry.source } };
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true;
      await Promise.allSettled([...this.pending]);
      this.entries.clear();
      if (this.directory) await rm(await this.directory, { recursive: true, force: true });
    })();
  }
}
