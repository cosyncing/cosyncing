import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HistorySourceIdentity, SessionInfo, SessionLaunchSurface } from '@cosyncing/protocol';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';

interface SessionTitleRecord {
  title: string;
  updatedAt: number;
}

interface ProjectNameRecord {
  name: string;
  updatedAt: number;
}

export interface StoredPromptCorrelation {
  nativeMessageId: string;
  nativeMessageDigest: string;
  key: string;
  clientKey?: string;
}

export interface StoredTerminalSummary {
  type: 'run-summary';
  key: string;
  turnId: string;
  userMessageKey?: string;
  assistantMessageKey?: string;
  status: 'done' | 'error' | 'cancelled';
  /** The turn's own token usage, when the adapter reported it.
   *
   *  `cleanTerminalSummary` rebuilds a stored summary field by field, so a field
   *  absent HERE is dropped on the way through even though the adapter attached
   *  it -- which is what happened to Cline's per-turn counts, silently, while the
   *  summary itself survived and kept `runCompleted` true. */
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
  };
}

interface SessionProvenanceRecord {
  launchSurface?: SessionLaunchSurface;
  appCreatedAt?: number;
  appMutatedPrivateAt?: number;
  /** Last exact model selected through the app. Codex needs this for an empty
   *  rollout because its session_meta records the provider but not the model. */
  currentModel?: SessionInfo['currentModel'];
  /** Last exact approval mode selected through the app. */
  currentMode?: string;
  /** Exact transcript boundary last observed after an app-owned mutation. A
   *  writer may resume after restart only when the native source is unchanged. */
  historyBoundary?: HistorySourceIdentity;
  /** Bounded exact native-user-row to app-key links. These are exposed only
   *  while the adapter independently proves the current history boundary. */
  promptCorrelations?: StoredPromptCorrelation[];
  /** Terminal turn anchors emitted from an authoritative native completion
   * only after the adapter recorded this exact history boundary. */
  terminalSummaries?: StoredTerminalSummary[];
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
const MAX_PROMPT_CORRELATIONS_PER_SESSION = 64;
const MAX_TERMINAL_SUMMARIES_PER_SESSION = 64;
/** Bounds the COUNT of retained records, which is what eviction is for; eviction
 * only loses replay cosmetics.
 *
 * It does not bound the byte size, and an earlier version of this comment
 * claimed it capped the payload "well below 300 KiB". It does not:
 * `cleanOpaqueString` bounds `String.length` (UTF-16 code units, not bytes), and
 * 256 retained terminal summaries carrying four 512-char opaque strings each is
 * already ~512 KiB of ASCII before prompt correlations are counted — several
 * times that for non-ASCII ids. The index is rewritten synchronously, pretty
 * printed, on every provenance write, so the real cost belongs in any change to
 * these limits. */
const MAX_PROMPT_CORRELATIONS_TOTAL = 256;
const MAX_TERMINAL_SUMMARIES_TOTAL = 256;

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

  currentModeHint(info: { tool: string; id: string; nativeId?: string }): string | undefined {
    return cleanLabel(this.getProvenance(info)?.currentMode, 120) ?? undefined;
  }

  appHistoryBoundary(info: { tool: string; id: string; nativeId?: string }): HistorySourceIdentity | undefined {
    return cleanHistoryBoundary(this.getProvenance(info)?.historyBoundary);
  }

  appPromptCorrelations(info: { tool: string; id: string; nativeId?: string }): StoredPromptCorrelation[] {
    return cleanPromptCorrelations(this.getProvenance(info)?.promptCorrelations);
  }

  appTerminalSummaries(info: { tool: string; id: string; nativeId?: string }): StoredTerminalSummary[] {
    return cleanTerminalSummaries(this.getProvenance(info)?.terminalSummaries);
  }

  wasAppCreatedSession(info: { tool: string; id: string; nativeId?: string }): boolean {
    const provenance = this.getProvenance(info);
    return provenance?.launchSurface === 'app'
      && typeof provenance.appCreatedAt === 'number'
      && Number.isFinite(provenance.appCreatedAt);
  }

  /** Revoke durable writer eligibility after handoff, foreign ownership, or an ambiguous writer failure. */
  revokeAppCreatedSession(info: { tool: string; id: string; nativeId?: string }): boolean {
    return this.writeAppProvenance(info, (record) => ({
      ...record,
      appCreatedAt: undefined,
      historyBoundary: undefined,
      promptCorrelations: undefined,
      terminalSummaries: undefined,
    }));
  }

  recordAppHistoryBoundary(info: {
    tool: string;
    id: string;
    nativeId?: string;
    historyBoundary: HistorySourceIdentity;
    terminalSummary?: StoredTerminalSummary;
  }): boolean {
    const historyBoundary = cleanHistoryBoundary(info.historyBoundary);
    if (!historyBoundary) return false;
    const terminalSummary = info.terminalSummary === undefined
      ? undefined
      : cleanTerminalSummary(info.terminalSummary);
    if (info.terminalSummary !== undefined && !terminalSummary) return false;
    return this.writeAppProvenance(info, (record) => {
      const previous = cleanTerminalSummaries(record.terminalSummaries)
        .filter((entry) => entry.key !== terminalSummary?.key
          && entry.turnId !== terminalSummary?.turnId);
      return {
        ...record,
        historyBoundary,
        terminalSummaries: terminalSummary
          ? [...previous, terminalSummary].slice(-MAX_TERMINAL_SUMMARIES_PER_SESSION)
          : record.terminalSummaries,
      };
    });
  }

  recordAppPromptCorrelation(info: {
    tool: string;
    id: string;
    nativeId?: string;
    correlation: StoredPromptCorrelation;
  }): boolean {
    const correlation = cleanPromptCorrelation(info.correlation);
    if (!correlation) return false;
    return this.writeAppProvenance(info, (record) => {
      const previous = cleanPromptCorrelations(record.promptCorrelations)
        .filter((entry) => entry.nativeMessageId !== correlation.nativeMessageId);
      return {
        ...record,
        promptCorrelations: [...previous, correlation].slice(-MAX_PROMPT_CORRELATIONS_PER_SESSION),
      };
    });
  }

  /** Replace a provisional app-selected model with newer authoritative native evidence. */
  recordCurrentModelHint(info: {
    tool: string;
    id: string;
    nativeId?: string;
    currentModel: SessionInfo['currentModel'];
  }): boolean {
    const currentModel = cleanCurrentModel(info.currentModel);
    if (!currentModel) return false;
    return this.writeAppProvenance(info, (record) => ({ ...record, currentModel }));
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
    prunePromptCorrelations(indexV2.provenance, key);
    pruneTerminalSummaries(indexV2.provenance, key);
    this.save();
    return true;
  }

  /** The title the user gave this session in Cosyncing, if any. */
  titleOf(tool: string, id: string): string | undefined {
    return this.index.sessions[sessionKey(tool, id)]?.title || undefined;
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
  recordAppCreatedSession(info: {
    tool: string;
    id: string;
    nativeId?: string;
    currentModel?: SessionInfo['currentModel'];
    currentMode?: string;
  }): void {
    const now = Date.now();
    const currentModel = cleanCurrentModel(info.currentModel);
    const currentMode = cleanLabel(info.currentMode, 120) ?? undefined;
    this.writeAppProvenance(info, (record) => ({
      launchSurface: 'app',
      appCreatedAt: record.appCreatedAt ?? now,
      appMutatedPrivateAt: record.appMutatedPrivateAt,
      currentModel: currentModel ?? record.currentModel,
      currentMode: currentMode ?? record.currentMode,
      historyBoundary: record.historyBoundary,
      promptCorrelations: record.promptCorrelations,
      terminalSummaries: record.terminalSummaries,
    }));
  }

  /** Record that the app has successfully injected/changed conversation state for this session. */
  recordAppMutation(info: {
    tool: string;
    id: string;
    nativeId?: string;
    control?: SessionInfo['control'];
    currentModel?: SessionInfo['currentModel'];
    currentMode?: string;
  }): boolean {
    const privateMutation = info.control?.terminalSync?.presence === 'private';
    const currentModel = cleanCurrentModel(info.currentModel);
    const currentMode = cleanLabel(info.currentMode, 120) ?? undefined;
    if (!privateMutation && !currentModel && !currentMode) return false;
    const now = Date.now();
    return this.writeAppProvenance(info, (record) => ({
      launchSurface: record.launchSurface,
      appCreatedAt: record.appCreatedAt,
      appMutatedPrivateAt: privateMutation ? record.appMutatedPrivateAt || now : record.appMutatedPrivateAt,
      currentModel: currentModel ?? record.currentModel,
      currentMode: currentMode ?? record.currentMode,
      historyBoundary: record.historyBoundary,
      promptCorrelations: record.promptCorrelations,
      terminalSummaries: record.terminalSummaries,
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
      currentMode: record.currentMode,
      historyBoundary: record.historyBoundary,
      promptCorrelations: record.promptCorrelations,
      terminalSummaries: record.terminalSummaries,
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

function prunePromptCorrelations(
  provenance: Record<string, SessionProvenanceRecord>,
  keep: string,
): void {
  const normalized = new Map<string, StoredPromptCorrelation[]>();
  let total = 0;
  for (const [key, record] of Object.entries(provenance)) {
    const correlations = cleanPromptCorrelations(record.promptCorrelations);
    if (correlations.length > 0) record.promptCorrelations = correlations;
    else delete record.promptCorrelations;
    normalized.set(key, correlations);
    total += correlations.length;
  }
  if (total <= MAX_PROMPT_CORRELATIONS_TOTAL) return;
  const evictionOrder = [...normalized.keys()]
    .filter((key) => key !== keep)
    .sort((left, right) => provenanceRecency(provenance[left]!) - provenanceRecency(provenance[right]!));
  if (normalized.has(keep)) evictionOrder.push(keep);
  for (const key of evictionOrder) {
    const correlations = normalized.get(key) ?? [];
    const remove = Math.min(correlations.length, total - MAX_PROMPT_CORRELATIONS_TOTAL);
    const retained = correlations.slice(remove);
    total -= remove;
    if (retained.length > 0) provenance[key]!.promptCorrelations = retained;
    else delete provenance[key]!.promptCorrelations;
    if (total <= MAX_PROMPT_CORRELATIONS_TOTAL) break;
  }
}

function pruneTerminalSummaries(
  provenance: Record<string, SessionProvenanceRecord>,
  keep: string,
): void {
  const normalized = new Map<string, StoredTerminalSummary[]>();
  let total = 0;
  for (const [key, record] of Object.entries(provenance)) {
    const summaries = cleanTerminalSummaries(record.terminalSummaries);
    if (summaries.length > 0) record.terminalSummaries = summaries;
    else delete record.terminalSummaries;
    normalized.set(key, summaries);
    total += summaries.length;
  }
  if (total <= MAX_TERMINAL_SUMMARIES_TOTAL) return;
  const evictionOrder = [...normalized.keys()]
    .filter((key) => key !== keep)
    .sort((left, right) => provenanceRecency(provenance[left]!) - provenanceRecency(provenance[right]!));
  if (normalized.has(keep)) evictionOrder.push(keep);
  for (const key of evictionOrder) {
    const summaries = normalized.get(key) ?? [];
    const remove = Math.min(summaries.length, total - MAX_TERMINAL_SUMMARIES_TOTAL);
    const retained = summaries.slice(remove);
    total -= remove;
    if (retained.length > 0) provenance[key]!.terminalSummaries = retained;
    else delete provenance[key]!.terminalSummaries;
    if (total <= MAX_TERMINAL_SUMMARIES_TOTAL) break;
  }
}

function provenanceEquals(a: SessionProvenanceRecord, b: SessionProvenanceRecord): boolean {
  return (
    a.launchSurface === b.launchSurface &&
    a.appCreatedAt === b.appCreatedAt &&
    a.appMutatedPrivateAt === b.appMutatedPrivateAt &&
    a.currentMode === b.currentMode &&
    historyBoundaryEquals(a.historyBoundary, b.historyBoundary) &&
    promptCorrelationsEqual(a.promptCorrelations, b.promptCorrelations) &&
    terminalSummariesEqual(a.terminalSummaries, b.terminalSummaries) &&
    currentModelEquals(a.currentModel, b.currentModel)
  );
}

function cleanOpaqueString(value: unknown, maxChars: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars && !value.includes('\0')
    ? value
    : undefined;
}

/** A summary's token counts, keeping only finite non-negative numbers.
 *
 *  Returns undefined when nothing survives, so a summary that reported no usage
 *  stores no `tokens` key rather than an empty object that later reads as a
 *  present-but-empty count. */
function cleanTerminalSummaryTokens(
  value: unknown,
): StoredTerminalSummary['tokens'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const tokens: Record<string, number> = {};
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost'] as const) {
    const count = record[field];
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) tokens[field] = count;
  }
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function cleanPromptCorrelation(value: unknown): StoredPromptCorrelation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Partial<StoredPromptCorrelation>;
  const nativeMessageId = cleanOpaqueString(record.nativeMessageId, 512);
  const nativeMessageDigest = cleanOpaqueString(record.nativeMessageDigest, 71);
  const key = cleanOpaqueString(record.key, 160);
  const clientKey = record.clientKey === undefined ? undefined : cleanOpaqueString(record.clientKey, 160);
  if (!nativeMessageId || !nativeMessageDigest || !/^sha256:[a-f0-9]{64}$/u.test(nativeMessageDigest)
    || !key || (record.clientKey !== undefined && !clientKey)) return undefined;
  return { nativeMessageId, nativeMessageDigest, key, ...(clientKey ? { clientKey } : {}) };
}

function cleanPromptCorrelations(value: unknown): StoredPromptCorrelation[] {
  if (!Array.isArray(value)) return [];
  const out = new Map<string, StoredPromptCorrelation>();
  for (const item of value.slice(-MAX_PROMPT_CORRELATIONS_PER_SESSION)) {
    const correlation = cleanPromptCorrelation(item);
    if (correlation) out.set(correlation.nativeMessageId, correlation);
  }
  return [...out.values()].slice(-MAX_PROMPT_CORRELATIONS_PER_SESSION);
}

function promptCorrelationsEqual(
  left: StoredPromptCorrelation[] | undefined,
  right: StoredPromptCorrelation[] | undefined,
): boolean {
  const a = cleanPromptCorrelations(left);
  const b = cleanPromptCorrelations(right);
  return a.length === b.length && a.every((value, index) => {
    const other = b[index];
    return value.nativeMessageId === other?.nativeMessageId
      && value.nativeMessageDigest === other.nativeMessageDigest
      && value.key === other.key
      && value.clientKey === other.clientKey;
  });
}

function cleanTerminalSummary(value: unknown): StoredTerminalSummary | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Partial<StoredTerminalSummary>;
  const key = cleanOpaqueString(record.key, 512);
  const turnId = cleanOpaqueString(record.turnId, 512);
  const userMessageKey = record.userMessageKey === undefined
    ? undefined
    : cleanOpaqueString(record.userMessageKey, 512);
  const assistantMessageKey = record.assistantMessageKey === undefined
    ? undefined
    : cleanOpaqueString(record.assistantMessageKey, 512);
  if (!key || !turnId
    || !['done', 'error', 'cancelled'].includes(record.status ?? '')
    || (record.userMessageKey !== undefined && !userMessageKey)
    || (record.assistantMessageKey !== undefined && !assistantMessageKey)) return undefined;
  const tokens = cleanTerminalSummaryTokens(record.tokens);
  return {
    type: 'run-summary',
    key,
    turnId,
    status: record.status as StoredTerminalSummary['status'],
    ...(userMessageKey ? { userMessageKey } : {}),
    ...(assistantMessageKey ? { assistantMessageKey } : {}),
    ...(tokens ? { tokens } : {}),
  };
}

function cleanTerminalSummaries(value: unknown): StoredTerminalSummary[] {
  if (!Array.isArray(value)) return [];
  const out = new Map<string, StoredTerminalSummary>();
  for (const item of value.slice(-MAX_TERMINAL_SUMMARIES_PER_SESSION)) {
    const summary = cleanTerminalSummary(item);
    if (!summary) continue;
    for (const [key, existing] of out) {
      if (existing.turnId === summary.turnId) out.delete(key);
    }
    out.set(summary.key, summary);
  }
  return [...out.values()].slice(-MAX_TERMINAL_SUMMARIES_PER_SESSION);
}

function terminalSummariesEqual(
  left: StoredTerminalSummary[] | undefined,
  right: StoredTerminalSummary[] | undefined,
): boolean {
  const a = cleanTerminalSummaries(left);
  const b = cleanTerminalSummaries(right);
  return a.length === b.length && a.every((value, index) => {
    const other = b[index];
    return value.key === other?.key
      && value.turnId === other.turnId
      && value.userMessageKey === other.userMessageKey
      && value.assistantMessageKey === other.assistantMessageKey
      && value.status === other.status
      // Counts too, or a summary republished WITH usage reads as unchanged and
      // is never written -- the same silent drop as the whitelist above, one
      // function along. Cline republishes exactly that way when its metrics
      // land after the turn settles.
      && JSON.stringify(value.tokens ?? null) === JSON.stringify(other.tokens ?? null);
  });
}

function cleanHistoryBoundary(value: HistorySourceIdentity | undefined): HistorySourceIdentity | undefined {
  if (!value || typeof value.sourceId !== 'string' || !value.sourceId || value.sourceId.length > 32_768) return undefined;
  if (typeof value.revision !== 'string' || !value.revision || value.revision.length > 1_024) return undefined;
  if (value.appendPosition !== undefined
    && (!Number.isSafeInteger(value.appendPosition) || value.appendPosition < 0)) return undefined;
  if (value.rewriteToken !== undefined
    && (typeof value.rewriteToken !== 'string' || !value.rewriteToken || value.rewriteToken.length > 4_096)) return undefined;
  return {
    sourceId: value.sourceId,
    revision: value.revision,
    ...(value.appendPosition === undefined ? {} : { appendPosition: value.appendPosition }),
    ...(value.rewriteToken === undefined ? {} : { rewriteToken: value.rewriteToken }),
  };
}

function historyBoundaryEquals(a: HistorySourceIdentity | undefined, b: HistorySourceIdentity | undefined): boolean {
  return a?.sourceId === b?.sourceId
    && a?.revision === b?.revision
    && a?.appendPosition === b?.appendPosition
    && a?.rewriteToken === b?.rewriteToken;
}

function cleanCurrentModel(value: SessionInfo['currentModel'] | undefined): SessionInfo['currentModel'] | undefined {
  const providerID = cleanLabel(value?.providerID, 256);
  const modelID = cleanLabel(value?.modelID, 256);
  if (!providerID || !modelID) return undefined;
  const variant = cleanLabel(value?.variant, 256) ?? undefined;
  const reasoningEffort = cleanLabel(value?.reasoningEffort, 64) ?? undefined;
  // `label` is carried, not dropped. The wire permits it and the composer needs
  // it: the client deliberately refuses to invent a human name from a raw model
  // id, so an adapter that publishes the label from its OWN catalog was having
  // it erased here and the session rendered a generic `Model` chip instead of
  // the model the New Session sheet had just shown the operator.
  const label = cleanLabel(value?.label, 256) ?? undefined;
  return {
    providerID,
    modelID,
    ...(label ? { label } : {}),
    ...(variant ? { variant } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function currentModelEquals(a: SessionInfo['currentModel'] | undefined, b: SessionInfo['currentModel'] | undefined): boolean {
  return (
    a?.providerID === b?.providerID &&
    a?.modelID === b?.modelID &&
    // Compared, or a label arriving for an already-known model reads as "no
    // change" and never reaches a client that is missing it.
    a?.label === b?.label &&
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
