import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SessionInfo, SessionLaunchSurface } from '@cosyncing/protocol';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';

interface SessionTitleRecord {
  title: string;
  updatedAt: number;
}

interface ProjectNameRecord {
  name: string;
  updatedAt: number;
}

interface SessionProvenanceRecord {
  launchSurface?: SessionLaunchSurface;
  appCreatedAt?: number;
  appMutatedPrivateAt?: number;
  /** Last exact model selected through the app. Codex needs this for an empty
   *  rollout because its session_meta records the provider but not the model. */
  currentModel?: SessionInfo['currentModel'];
}

interface MetadataIndexV1 {
  version: 1;
  sessions: Record<string, SessionTitleRecord>;
  projects: Record<string, ProjectNameRecord>;
}

interface MetadataIndexV2 {
  version: 2;
  sessions: Record<string, SessionTitleRecord>;
  projects: Record<string, ProjectNameRecord>;
  provenance: Record<string, SessionProvenanceRecord>;
}

type MetadataIndex = MetadataIndexV1 | MetadataIndexV2;

const MAX_TITLE_CHARS = 160;
const MAX_PROJECT_CHARS = 120;
/** Retention cap for provenance records (~100 bytes each). Far above any realistic live session
 *  count; under pressure the least-recently-touched records are evicted, which only degrades
 *  toward the adapter's own rollout-derived launchSurface and drops stale behind-evidence. */
const MAX_PROVENANCE_RECORDS = 1000;

function cacheRoot(): string {
  return process.env.COSYNCING_CACHE_DIR || join(homedir(), '.cache', PRODUCT_IDENTITY.cacheDirectoryName);
}

function emptyIndex(): MetadataIndexV2 {
  return {
    version: 2,
    sessions: {},
    projects: {},
    provenance: {},
  };
}

function readIndex(path: string): MetadataIndex {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      version?: number;
      sessions?: unknown;
      projects?: unknown;
      provenance?: unknown;
    };
    const version = typeof raw.version === 'number' ? raw.version : 1;
    const sessions = raw.sessions && typeof raw.sessions === 'object' ? (raw.sessions as Record<string, SessionTitleRecord>) : {};
    const projects = raw.projects && typeof raw.projects === 'object' ? (raw.projects as Record<string, ProjectNameRecord>) : {};
    const provenance = raw.provenance && typeof raw.provenance === 'object'
      ? (raw.provenance as Record<string, SessionProvenanceRecord>)
      : {};
    if (version >= 2) return { version: 2, sessions, projects, provenance };
    return { version: 1, sessions, projects };
  } catch {
    return emptyIndex();
  }
}

function cleanLabel(raw: string | null | undefined, maxChars: number): string | null {
  if (raw == null) return null;
  const label = String(raw).replace(/\s+/g, ' ').trim();
  return label ? label.slice(0, maxChars) : null;
}

function sessionKey(tool: string, id: string): string {
  return `${tool}\0${id}`;
}

function provenanceKey(tool: string, nativeIdOrId: string): string {
  return `${tool}\0${nativeIdOrId}`;
}

function isMetadataIndexV2(index: MetadataIndex): index is MetadataIndexV2 {
  return index.version >= 2;
}

export class SessionMetadataStore {
  private readonly file: string;
  private index: MetadataIndex;

  constructor(root = cacheRoot()) {
    this.file = join(root, 'session-metadata.json');
    this.index = readIndex(this.file);
  }

  private materializeV2(): void {
    if (!isMetadataIndexV2(this.index)) {
      this.index = {
        version: 2,
        sessions: this.index.sessions,
        projects: this.index.projects,
        provenance: {},
      };
    }
  }

  private getProvenanceIndex(): MetadataIndexV2 {
    this.materializeV2();
    return this.index as MetadataIndexV2;
  }

  private keyFor(info: { tool: string; id: string; nativeId?: string }): string {
    return provenanceKey(info.tool, info.nativeId || info.id);
  }

  private getProvenance(info: { tool: string; id: string; nativeId?: string }): SessionProvenanceRecord | undefined {
    return isMetadataIndexV2(this.index) ? this.index.provenance[this.keyFor(info)] : undefined;
  }

  /** Exact app-selected model to restore when an adapter's durable session has
   *  not recorded a model yet. Callers must prefer native rollout evidence. */
  currentModelHint(info: { tool: string; id: string; nativeId?: string }): SessionInfo['currentModel'] | undefined {
    return cleanCurrentModel(this.getProvenance(info)?.currentModel);
  }

  private writeAppProvenance(
    info: { tool: string; id: string; nativeId?: string },
    update: (record: SessionProvenanceRecord) => SessionProvenanceRecord,
  ): boolean {
    const indexV2 = this.getProvenanceIndex();
    const key = this.keyFor(info);
    const current = indexV2.provenance[key] ?? {};
    const next = update(current);
    if (provenanceEquals(current, next)) return false;
    indexV2.provenance[key] = next;
    pruneProvenance(indexV2.provenance, key);
    this.save();
    return true;
  }

  apply(info: SessionInfo): SessionInfo {
    const out: SessionInfo = { ...info };
    const title = this.index.sessions[sessionKey(info.tool, info.id)];
    if (title?.title) out.title = title.title;
    if (info.cwd) {
      const project = this.index.projects[info.cwd];
      if (project?.name) out.projectName = project.name;
      else if ('projectName' in out) delete out.projectName;
    }
    const provenance = this.getProvenance({ tool: info.tool, id: info.id, nativeId: info.nativeId });
    if (provenance?.launchSurface !== undefined) out.launchSurface = provenance.launchSurface;
    if (out.control?.terminalSync) {
      const presence = out.control.terminalSync.presence;
      const nextSync = {
        ...out.control.terminalSync,
        behind: presence === 'private' && Boolean(provenance?.appMutatedPrivateAt),
      };
      if (!terminalSyncEquals(out.control.terminalSync, nextSync)) {
        out.control = { ...out.control, terminalSync: nextSync };
      }
    }
    return out;
  }

  applyAll(sessions: SessionInfo[]): SessionInfo[] {
    return sessions.map((s) => this.apply(s));
  }

  /** Record that the app created a durable session for provenance and fork-safety heuristics. */
  recordAppCreatedSession(info: { tool: string; id: string; nativeId?: string; currentModel?: SessionInfo['currentModel'] }): void {
    const now = Date.now();
    const currentModel = cleanCurrentModel(info.currentModel);
    this.writeAppProvenance(info, (record) => ({
      launchSurface: 'app',
      appCreatedAt: record.appCreatedAt ?? now,
      appMutatedPrivateAt: record.appMutatedPrivateAt,
      currentModel: currentModel ?? record.currentModel,
    }));
  }

  /** Record that the app has successfully injected/changed conversation state for this session. */
  recordAppMutation(info: { tool: string; id: string; nativeId?: string; control?: SessionInfo['control']; currentModel?: SessionInfo['currentModel'] }): boolean {
    const privateMutation = info.control?.terminalSync?.presence === 'private';
    const currentModel = cleanCurrentModel(info.currentModel);
    if (!privateMutation && !currentModel) return false;
    const now = Date.now();
    return this.writeAppProvenance(info, (record) => ({
      launchSurface: record.launchSurface,
      appCreatedAt: record.appCreatedAt,
      appMutatedPrivateAt: privateMutation ? record.appMutatedPrivateAt || now : record.appMutatedPrivateAt,
      currentModel: currentModel ?? record.currentModel,
    }));
  }

  /**
   * Clear durable private-divergence evidence only on authoritative shared rejoin.
   * Returns true only when evidence was actually removed.
   */
  clearPrivateMutationEvidenceOnSharedRejoin(info: { tool: string; id: string; nativeId?: string; control?: SessionInfo['control'] }): boolean {
    if (info.control?.terminalSync?.presence !== 'shared') return false;
    return this.writeAppProvenance(info, (record) => ({
      launchSurface: record.launchSurface,
      appCreatedAt: record.appCreatedAt,
      appMutatedPrivateAt: undefined,
      currentModel: record.currentModel,
    }));
  }

  renameSession(tool: string, id: string, rawTitle: string | null | undefined): SessionTitleRecord | null {
    const key = sessionKey(tool, id);
    const title = cleanLabel(rawTitle, MAX_TITLE_CHARS);
    if (!title) {
      delete this.index.sessions[key];
      this.save();
      return null;
    }
    const record = { title, updatedAt: Date.now() };
    this.index.sessions[key] = record;
    this.save();
    return record;
  }

  renameProject(cwd: string, rawName: string | null | undefined): ProjectNameRecord | null {
    const name = cleanLabel(rawName, MAX_PROJECT_CHARS);
    if (!name) {
      delete this.index.projects[cwd];
      this.save();
      return null;
    }
    const record = { name, updatedAt: Date.now() };
    this.index.projects[cwd] = record;
    this.save();
    return record;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const index = this.getProvenanceIndex();
    writeFileSync(tmp, JSON.stringify(index, null, 2));
    renameSync(tmp, this.file);
    if (!existsSync(this.file)) throw new Error('session metadata write failed');
  }
}

function provenanceRecency(record: SessionProvenanceRecord): number {
  return Math.max(record.appCreatedAt ?? 0, record.appMutatedPrivateAt ?? 0);
}

function pruneProvenance(provenance: Record<string, SessionProvenanceRecord>, keep: string): void {
  const keys = Object.keys(provenance);
  if (keys.length <= MAX_PROVENANCE_RECORDS) return;
  keys
    .filter((key) => key !== keep)
    .sort((a, b) => provenanceRecency(provenance[a]!) - provenanceRecency(provenance[b]!))
    .slice(0, keys.length - MAX_PROVENANCE_RECORDS)
    .forEach((key) => delete provenance[key]);
}

function provenanceEquals(a: SessionProvenanceRecord, b: SessionProvenanceRecord): boolean {
  return (
    a.launchSurface === b.launchSurface &&
    a.appCreatedAt === b.appCreatedAt &&
    a.appMutatedPrivateAt === b.appMutatedPrivateAt &&
    currentModelEquals(a.currentModel, b.currentModel)
  );
}

function cleanCurrentModel(value: SessionInfo['currentModel'] | undefined): SessionInfo['currentModel'] | undefined {
  const providerID = cleanLabel(value?.providerID, 256);
  const modelID = cleanLabel(value?.modelID, 256);
  if (!providerID || !modelID) return undefined;
  const variant = cleanLabel(value?.variant, 256) ?? undefined;
  const reasoningEffort = cleanLabel(value?.reasoningEffort, 64) ?? undefined;
  return { providerID, modelID, ...(variant ? { variant } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) };
}

function currentModelEquals(a: SessionInfo['currentModel'] | undefined, b: SessionInfo['currentModel'] | undefined): boolean {
  return (
    a?.providerID === b?.providerID &&
    a?.modelID === b?.modelID &&
    a?.variant === b?.variant &&
    a?.reasoningEffort === b?.reasoningEffort
  );
}

function terminalSyncEquals(
  a: NonNullable<SessionInfo['control']>['terminalSync'],
  b: NonNullable<SessionInfo['control']>['terminalSync'],
): boolean {
  return (
    a.supported === b.supported &&
    a.syncAvailable === b.syncAvailable &&
    a.active === b.active &&
    a.input === b.input &&
    a.presence === b.presence &&
    a.action === b.action &&
    a.behind === b.behind
  );
}
