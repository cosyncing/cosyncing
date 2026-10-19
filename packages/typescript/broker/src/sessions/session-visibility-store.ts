import { join } from 'node:path';
import type { SessionInfo } from '@cosyncing/protocol';
import { atomicWriteOwnerOnly, inspectOwnerOnlyFile, readOwnerOnlyText } from '../security/secure-files.ts';

type Link = { native: string; parent?: string };
type Index = { version: 1; revision: number; hidden: string[]; links: Record<string, Link>; changed?: Record<string, number> };
const key = (tool: string, id: string): string => JSON.stringify([tool, id]);

/** User-authored visibility lives in broker state, outside every rebuildable cache.
 * Links retain subagent ancestry across bounded discovery and broker restarts.
 * Native aliases keep a preference stable when an adapter's handle changes. */
export class SessionVisibilityStore {
  private readonly file: string;
  private revision = 0;
  private hidden = new Set<string>();
  private links = new Map<string, Link>();
  private changed = new Map<string, number>();

  constructor(stateHome: string) {
    this.file = join(stateHome, 'session-visibility.json');
    if (inspectOwnerOnlyFile(this.file).status === 'missing') return;
    try {
      const data = JSON.parse(readOwnerOnlyText(this.file)) as Index;
      if (data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0
        || !Array.isArray(data.hidden) || !data.hidden.every((v) => typeof v === 'string')
        || !data.links || typeof data.links !== 'object' || Array.isArray(data.links)
        || (data.changed !== undefined && (!data.changed || typeof data.changed !== 'object' || Array.isArray(data.changed)))) throw new Error('Invalid session visibility state');
      for (const [id, link] of Object.entries(data.links)) {
        if (!link || typeof link.native !== 'string'
          || (link.parent !== undefined && typeof link.parent !== 'string')) throw new Error('Invalid visibility ancestry');
        this.links.set(id, link);
      }
      this.revision = data.revision;
      this.hidden = new Set(data.hidden);
      for (const [id, revision] of Object.entries(data.changed ?? {})) {
        if (!Number.isSafeInteger(revision) || revision < 0 || revision > data.revision) {
          throw new Error('Invalid visibility revision');
        }
        this.changed.set(id, revision);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /** Batch before decorating a roster so discovering many ancestors writes once. */
  observe(sessions: SessionInfo[]): void {
    let next = this.links;
    let linksChanged = false;
    for (const info of sessions) {
      const id = key(info.tool, info.id);
      const native = key(info.tool, info.nativeId ?? info.id);
      const previous = next.get(id);
      // An attach's sparse identity must not erase previously discovered ancestry.
      const parent = info.origin === 'subagent' && info.parentThreadId
        ? key(info.tool, info.parentThreadId) : previous?.parent;
      const link = { native: info.nativeId ? native : previous?.native ?? native, ...(parent ? { parent } : {}) };
      if (previous?.native !== link.native || previous?.parent !== link.parent) {
        if (!linksChanged) next = new Map(this.links);
        next.set(id, link);
        next.set(link.native, link);
        linksChanged = true;
      }
    }
    if (!linksChanged) return;
    // Before the first preference there is no authored state to preserve.
    const hidden = new Set([...this.hidden].map((id) => next.get(id)?.native ?? id));
    const changed = new Map<string, number>();
    for (const [id, revision] of this.changed) {
      const canonical = next.get(id)?.native ?? id;
      changed.set(canonical, Math.max(changed.get(canonical) ?? 0, revision));
    }
    if (this.revision > 0) this.persist(hidden, next, this.revision, changed);
    this.links = next;
    this.hidden = hidden;
    this.changed = changed;
  }

  private canonical(id: string): string { return this.links.get(id)?.native ?? id; }

  private ancestorHidden(info: SessionInfo): boolean {
    let current = this.canonical(key(info.tool, info.id));
    const seen = new Set<string>([current]);
    let inherited = false;
    for (;;) {
      const parent = this.links.get(current)?.parent;
      if (!parent) return inherited;
      current = this.canonical(parent);
      // Malformed ancestry cannot make an explicit preference impossible to
      // undo. Cycles confer no inherited visibility, like the roster forest.
      if (seen.has(current)) return false;
      seen.add(current);
      inherited ||= this.hidden.has(current) || this.hidden.has(parent);
    }
  }

  apply(info: SessionInfo): SessionInfo {
    const id = key(info.tool, info.id);
    const inherited = this.ancestorHidden(info);
    let current: string | undefined = id;
    let revision = 0;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      revision = Math.max(revision, this.changed.get(this.canonical(current)) ?? 0);
      current = this.links.get(current)?.parent;
      if (current) current = this.canonical(current);
    }
    return { ...info, appHidden: inherited || this.hidden.has(this.canonical(id)) || this.hidden.has(id),
      appHiddenByAncestor: inherited, appVisibilityRevision: revision };
  }

  set(info: SessionInfo, hidden: boolean): void {
    this.observe([info]);
    if (this.ancestorHidden(info)) throw new Error('HIDDEN_ANCESTOR');
    const id = key(info.tool, info.id);
    const canonical = this.canonical(id);
    const next = new Set(this.hidden);
    // Remove historical handles for this exact native identity as well.
    for (const candidate of next) if (this.canonical(candidate) === canonical) next.delete(candidate);
    if (hidden) next.add(canonical);
    if (next.size === this.hidden.size && [...next].every((value) => this.hidden.has(value))) return;
    const revision = this.revision + 1;
    const changed = new Map(this.changed).set(canonical, revision);
    this.persist(next, this.links, revision, changed);
    this.hidden = next;
    this.changed = changed;
    this.revision = revision;
  }

  private persist(hidden: Set<string>, links: Map<string, Link>, revision: number, changed: Map<string, number>): void {
    atomicWriteOwnerOnly(this.file, JSON.stringify({ version: 1, revision,
      hidden: [...hidden], links: Object.fromEntries(links), changed: Object.fromEntries(changed) } satisfies Index));
  }
}
