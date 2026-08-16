/**
 * The single-owner connection hub. For each (tool, session) the broker holds at
 * most ONE underlying SessionConnection and fans its messages out to N clients —
 * this is what lets the phone + web (and later a terminal client) all drive the
 * same live session without the "single-owner" conflict (see
 * docs/architecture/monorepo.md).
 */
import { lstatSync, readFileSync } from 'node:fs';
import { basename, extname, relative, dirname, resolve, isAbsolute } from 'node:path';
import type {
  AgentMessage,
  AgentOption,
  AgentRegistry,
  AttachMode,
  BrokerClientCompatibility,
  BrokerContractIdentity,
  DriveAttachReason,
  ModeOption,
  ModelOption,
  SessionConnection,
  SessionConnectionAuthority,
  SessionInfo,
  SessionJoinExistingAction,
  SessionOwnerProjection,
  SessionOwnerRevision,
  SlashCommand,
  Unsubscribe,
} from '@cosyncing/adapter-api';
import { OwnershipConflictError } from '@cosyncing/adapter-api';
import {
  artifactKeyFor,
  DEFAULT_SESSION_ARTIFACT_REPLAY_LIMIT,
  type ArtifactStore,
} from '../artifacts/artifact-store.ts';
import type { SharedDraftStore } from './draft-store.ts';
import { planSemanticFromMessage } from './client-message-policy.ts';
import { capHistoryMessages } from './history-delta.ts';
import type { SessionControlTransition } from '../attention/attention-policy.ts';
import type { LiveOverlayEntry } from '../roster/roster-overlay.ts';
import {
  activeOwnerState,
  ActiveSessionOwnerRegistry,
  JoinExistingError,
  sessionConnectionAuthority,
  sameOwnerRevision,
} from './session-owner.ts';

interface RunStateRepairableConnection {
  requestRunStateRepair(): void | Promise<void>;
}

function runStateRepairable(conn: unknown): RunStateRepairableConnection | undefined {
  const candidate = conn as Partial<RunStateRepairableConnection> | null | undefined;
  return typeof candidate?.requestRunStateRepair === 'function'
    ? (candidate as RunStateRepairableConnection)
    : undefined;
}

/** External inferred state can request repair, but the live owner still derives the answer. */
function contradictsOwnerRunState(
  external: SessionInfo['status'] | undefined,
  owner: SessionInfo['status'] | undefined,
): boolean {
  if (external === undefined || owner === undefined) return false;
  const inFlight = (status: SessionInfo['status']): boolean => status !== 'idle';
  return inFlight(external) !== inFlight(owner);
}

export type WireEvent =
  | {
      kind: 'hello';
      broker: { version: string; contract: BrokerContractIdentity };
      clientVersion?: string;
      compatibility: BrokerClientCompatibility;
    }
  | {
      kind: 'session';
      info: SessionInfo;
      authority?: SessionConnectionAuthority;
      joinExisting?: SessionJoinExistingAction;
    }
  | {
      kind: 'history';
      messages: AgentMessage[];
      reset?: boolean;
      cursor?: string;
      attachTicket?: string;
      gap?: { code: string; reason?: string; message: string };
      truncated?: { shown: number; total: number };
      /** Opaque cursor for the page immediately before this capped attach tail. */
      olderCursor?: string;
      hasEarlier?: boolean;
    }
  | {
      kind: 'history-page';
      messages: AgentMessage[];
      cursor?: string;
      hasMore: boolean;
      endOfHistory: boolean;
      clientMessageId?: string;
    }
  | { kind: 'message'; seq: number; message: AgentMessage }
  | { kind: 'commands'; commands: SlashCommand[] }
  /** Model + agent + mode pickers for this session (sent on attach, alongside commands). `modes` =
   *  permission/approval modes (e.g. Claude default|acceptEdits|plan|bypassPermissions). */
  | { kind: 'options'; models: ModelOption[]; agents: AgentOption[]; modes?: ModeOption[] }
  /** Short requester-facing feedback for a completed action (e.g. "Reverted last message"). */
  | { kind: 'notice'; message: string }
  /** Multi-client composer sync (issues-part2): the session's shared unsent draft. Broadcast to every
   *  attached client on change and replayed to late joiners, so phone/desktop/web composers agree.
   *  DR1: `revision` is the broker-assigned per-session monotone version (from the durable shared
   *  draft store); `updateId` echoes the accepted mutation's idempotency token so the writer can
   *  recognize its own update. Legacy clients ignore both. */
  | { kind: 'draft'; text: string; at: number; revision: number; updateId?: string }
  /** The live session this socket attached to ended/was-replaced in the terminal (quit/new/resume/
   *  fork). A clean teardown signal so the app shows "session ended" instead of a silently-dead
   *  socket — the bridge reload/fork orphan fix. `reason` is Pi's SessionShutdownEvent.reason. */
  | { kind: 'ended'; reason?: string }
  /** `draftCleared` appears only as `false`, on an accepted prompt whose shared-draft clear could
   *  not be durably stored (DR1). The prompt itself succeeded; the sender must keep its associated
   *  local draft row and retry the clear instead of completing the handoff. `draftRevision` rides
   *  with it and names the revision the shared record was left at, so the sender's retry stays
   *  conditional on the exact record its prompt sent. Both are part of the terminal result the
   *  idempotency journal replays, so they must survive a duplicate send and a broker restart. */
  | { kind: 'ack'; ack: 'ack' | 'nack' | 'client-message'; attachTicket?: string; clientMessageId?: string; duplicate?: boolean; pending?: boolean; draftCleared?: boolean; draftRevision?: number }
  | { kind: 'nack'; code: string; message: string; attachTicket?: string; clientMessageId?: string; duplicate?: boolean }
  | { kind: 'error'; message: string }
  /** Structured ownership arbitration result for a reason-tagged `mode=resume` attach the broker
   *  DENIED: the socket stays open and continues as an Observe-class attach, and this frame tells
   *  the client the machine reason so it can keep (or surface) its local provenance honestly.
   *  Never sent for a mode-only attach — those keep the legacy error+close behavior. */
  | { kind: 'attach-conflict'; requestedMode: string; reason: string; code: string; message: string };

/** Resync history bound — same knob as the attach-path cap in main.ts (0 disables). */
const RESYNC_MAX_MESSAGES = (() => {
  const raw = process.env.COSYNCING_HISTORY_MAX_MESSAGES?.trim();
  if (!raw) return 500;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 500;
})();

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.html': 'text/html', '.htm': 'text/html',
  '.pdf': 'application/pdf', '.json': 'application/json', '.csv': 'text/csv', '.txt': 'text/plain',
  '.md': 'text/markdown', '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const mimeFromName = (name: string): string => MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
const artifactIdentity = (message: AgentMessage & { type: 'file-artifact' }): string =>
  message.artifactKey || [message.path, message.contentHash || message.url || message.size || ''].join('\0');

/** Extensions the agent can "send" just by writing them — auto-surfaced as a file-artifact.
 *  Deliverables, not source churn, so a coding turn that writes .ts/.py stays quiet. `.md` is on
 *  by default (a future per-session toggle can suppress it); the explicit send_file tool can
 *  deliver ANY type regardless of this set. */
const DELIVERABLE = new Set([
  '.html', '.htm', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.csv', '.json', '.zip', '.txt', '.md',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
]);

/** True if `target` resolves to inside `base` — the trust boundary for any surfaced artifact. */
function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export type Client = ((event: WireEvent) => void) & {
  /** Atomically retarget the runtime socket when this subscriber moves to a
   *  surviving wrapper. Callback-only fixture clients may omit it. */
  onManagedConnChanged?: (managed: ManagedConn) => void;
};

export interface ManagedConnAttentionHooks {
  /** Live canonical frames only; history snapshots and initial roster discovery never enter here. */
  onMessage?: (info: SessionInfo, message: AgentMessage) => void;
  onRetentionChanged?: (info: SessionInfo, required: boolean) => void;
  onClientCountChanged?: (info: SessionInfo, count: number) => void;
  /** Owning live evidence vanished without proving the native session ended. */
  onObservationLost?: (info: SessionInfo) => void;
  /** Transcript-free live roster metadata/status projection. */
  onSessionInfo?: (info: SessionInfo) => void;
}

export interface HubAttentionHooks {
  onMessage?: (info: SessionInfo, message: AgentMessage) => void;
  onSessionEnded?: (info: SessionInfo, reason?: string) => void;
  onLeaseDenied?: (info: SessionInfo) => void;
  onControlTransition?: (transition: SessionControlTransition) => void;
  onObservationLost?: (info: SessionInfo) => void;
  /** Transcript-free live roster metadata/status projection. */
  onSessionInfo?: (info: SessionInfo) => void;
  maxZeroClientLeases?: number;
}

function controlPathState(
  info: SessionInfo,
  path: SessionControlTransition['path'],
): SessionControlTransition['from'] {
  if (path === 'drive') {
    const state = info.control?.drive.state;
    if (state === 'driving') return 'active';
    if (state === 'observing') return 'available';
    if (state === 'unavailable') return 'unavailable';
    return 'unknown';
  }
  const sync = info.control?.terminalSync;
  if (sync?.active) return 'active';
  if (sync?.supported && sync.syncAvailable) return 'available';
  if (sync?.supported && !sync.syncAvailable) return 'unavailable';
  return 'unknown';
}

const SESSION_OPTIONAL_KEYS = [
  'machine',
  'slug',
  'cwd',
  'projectName',
  'model',
  'currentModel',
  'currentAgent',
  'currentMode',
  'createdAt',
  'updatedAt',
  'terminalSyncHint',
  'control',
] as const;

function replaceInfo(target: SessionInfo, source: SessionInfo): void {
  target.id = source.id;
  target.tool = source.tool;
  target.title = source.title;
  target.status = source.status;
  target.attachMode = source.attachMode;
  for (const key of SESSION_OPTIONAL_KEYS) {
    if (key in source) (target as any)[key] = (source as any)[key];
    else delete (target as any)[key];
  }
}

export interface DraftSetResult {
  /** False when the write was rejected as stale-base or could not be durably stored; either way the
   *  shared record was left untouched. */
  applied: boolean;
  /** True when the write was an idempotent replay of the last accepted `updateId`. */
  duplicate: boolean;
  /** True when the durable store could not persist the mutation. The write is NOT applied, NOT
   *  broadcast, and must not be acknowledged to the writer: its local row stays dirty and retries,
   *  because a broker restart would otherwise lose text every client believes is shared. */
  unavailable: boolean;
  /** The current shared record after arbitration (the untouched record on rejection). */
  record: { text: string; at: number; revision: number; updateId?: string };
}

export class ManagedConn {
  private readonly ring: Array<{ seq: number; message: AgentMessage }> = [];
  private seq = 0;
  private readonly clients = new Set<Client>();
  private unsub: Unsubscribe;
  /** Broker-INJECTED file-artifacts (session-owned writes and send_file) — kept so they
   *  survive a reattach AND a history-reset. They are NOT in conn.getHistory() (that's the agent's own
   *  message parts), so without this they'd vanish whenever the thread is rebuilt from history. The
   *  cache is count-bounded because every entry becomes a replay frame on attach/reset. */
  private readonly artifacts: AgentMessage[] = [];
  private readonly artifactReplayLimit: number;
  /** Store-less large-artifact versions still need distinct identities at the same path. */
  private artifactEmissionSequence = 0;
  /** The session working dir: the trust boundary for artifacts (must stay within it). */
  private readonly cwd?: string;
  /** Per-key accumulated in-flight text (model-output/thinking), so a client attaching mid-stream
   *  gets what was streamed BEFORE it joined (history's in-flight part is empty). Cleared each turn. */
  private readonly liveText = new Map<string, { type: string; text: string }>();
  /** Whether a turn is currently running, so a mid-turn joiner gets a `running` status (not idle). */
  private liveRunning = false;
  private liveNeedsInput = false;
  /** The adapter-owned `conn.info.status` this wrapper has already folded (R0c.4).
   *
   *  An adapter may correct its own run state without emitting a status frame — the Codex
   *  `markRunning`/`markIdle` transitions mutate `info.status` directly, and native reconciliation
   *  runs them long after attach. Those writes land on the SAME object this wrapper publishes from,
   *  so without observing them the adapter can believe Working while the live-owner overlay still
   *  publishes the latched Idle, with no frame anywhere to reconcile the two. Comparing against the
   *  last value this wrapper itself wrote makes an adapter-side change detectable; every broker-side
   *  write below records itself here so only a foreign write is a transition. Capability-driven: no
   *  adapter names or per-tool branches. */
  private observedConnStatus: SessionInfo['status'];
  private foldingAdapterStatus = false;
  /** Pending user action cards that are not part of transcript history. Replayed to late joiners. */
  private readonly pendingInput = new Map<string, AgentMessage>();
  /** Generic live source evidence used to keep long work observable after the last UI disconnects. */
  private readonly activeRunKeys = new Set<string>();
  private readonly activeGoalKeys = new Set<string>();
  /** The session's shared UNSENT composer draft (multi-client sync, issues-part2). Written through
   *  to the durable {@link SharedDraftStore} when one is configured, so owner eviction and broker
   *  restart cannot lose it; the in-memory value is only the low-latency fan-out cache. `revision`
   *  is the store-assigned monotone version; without a store a local counter keeps the wire shape. */
  private draft: { text: string; at: number; revision: number; updateId?: string } = { text: '', at: 0, revision: 0 };
  /** Current adapter-authored plan states, keyed by the semantic planKey. Generic task ledgers never
   * enter this map. It is seeded from attach/resync history and refreshed by live frames. */
  private readonly currentPlans = new Map<string, Extract<AgentMessage, { type: 'task-list-state' }>>();

  constructor(
    public conn: SessionConnection,
    private readonly artifactStore?: ArtifactStore,
    private readonly attentionHooks: ManagedConnAttentionHooks = {},
    private readonly draftStore?: SharedDraftStore,
  ) {
    this.cwd = conn.info.cwd;
    this.artifactReplayLimit = artifactStore?.replayLimit ?? DEFAULT_SESSION_ARTIFACT_REPLAY_LIMIT;
    // Attach/reconnect can already carry an exact active-turn projection before this wrapper has a
    // subscription. Seed the live-owner overlay from that authoritative SessionInfo so replacing an
    // owner or replaying history cannot manufacture an Idle gap while the same turn is active.
    this.liveRunning = conn.info.status !== 'idle';
    this.liveNeedsInput = conn.info.status === 'needs-input';
    this.observedConnStatus = conn.info.status;
    // Hydrate the fan-out cache from the durable shared draft so a reconstructed
    // owner (zero-client eviction) and a restarted broker both keep the draft.
    const persisted = this.draftStore?.get(conn.info.tool, conn.info.id);
    if (persisted) {
      this.draft = {
        text: persisted.text,
        at: persisted.updatedAt,
        revision: persisted.revision,
        ...(persisted.lastUpdateId ? { updateId: persisted.lastUpdateId } : {}),
      };
    }
    // Only records created by an exact session-qualified producer route are
    // eligible. Pre-fix cwd-outbox records carry no marker and fail closed.
    this.artifacts.push(...(this.artifactStore?.sessionQualifiedArtifacts(this.sessionRef()) ?? []));
    this.unsub = conn.subscribe((m) => this.push(m));
  }

  /** Push the latest SessionInfo to attached clients. This is the low-latency control-state path:
   *  adapters can report an external terminal-sync bridge appearing/disappearing, and the app updates
   *  without waiting for the roster poll. */
  broadcastSession(info: SessionInfo = this.conn.info): void {
    try {
      this.attentionHooks.onSessionInfo?.(info);
    } catch {
      /* roster observation never changes the session stream */
    }
    this.broadcastSessionProjection(info);
  }

  /** Re-publish session-level projection changes without feeding them back as adapter evidence. */
  broadcastSessionProjection(info: SessionInfo = this.conn.info): void {
    for (const c of this.clients) c({ kind: 'session', info });
  }

  /** Update the shared draft and fan it out (including back to the writer — clients recognize their
   *  own update by `updateId`). DR1: the write goes through the durable store first, which assigns
   *  the monotone `revision` and arbitrates:
   *  - `applied`: broadcast to every attached client;
   *  - `duplicate` (same `updateId` as the last accepted update): no mutation and no fan-out — the
   *    caller unicasts the current record to the retrying writer;
   *  - `stale-base` (`baseRevision` behind the current revision with different text): REJECTED, the
   *    shared record is untouched, `applied` is false, and the caller unicasts the current record so
   *    the writer can present a conflict instead of silently overwriting a newer shared draft. */
  setDraft(text: string, options: { updateId?: string; baseRevision?: number } = {}): DraftSetResult {
    if (this.draftStore) {
      const result = this.draftStore.write(this.conn.info.tool, this.conn.info.id, String(text ?? ''), options);
      if (result.status === 'unavailable') {
        // Durability failed: the store kept its previous record, so the fan-out cache must not move
        // either. Nothing is broadcast and the caller does not acknowledge — the writer stays dirty.
        return { applied: false, duplicate: false, unavailable: true, record: { ...this.draft } };
      }
      this.draft = {
        text: result.record.text,
        at: result.record.updatedAt,
        revision: result.record.revision,
        ...(result.record.lastUpdateId ? { updateId: result.record.lastUpdateId } : {}),
      };
      if (result.status === 'applied') {
        for (const c of this.clients) c({ kind: 'draft', ...this.draft });
      }
      return {
        applied: result.status !== 'stale-base',
        duplicate: result.status === 'duplicate',
        unavailable: false,
        record: { ...this.draft },
      };
    }
    // Store-less fallback (unit tests): keep the versioned wire shape with a local counter.
    this.draft = {
      text: String(text ?? ''),
      at: Date.now(),
      revision: this.draft.revision + 1,
      ...(options.updateId ? { updateId: options.updateId } : {}),
    };
    for (const c of this.clients) c({ kind: 'draft', ...this.draft });
    return { applied: true, duplicate: false, unavailable: false, record: { ...this.draft } };
  }

  /**
   * Clear the shared draft after a prompt was accepted — but only the draft the sender was actually
   * looking at.
   *
   * `observedRevision` is the shared revision the sending client had adopted. A versioned client
   * always sends one (0 when it holds no shared draft). If the shared record has moved past it,
   * ANOTHER device typed a newer draft that this send never contained, so clearing would silently
   * erase that device's unsent text; the clear is skipped instead. A legacy client sends nothing and
   * keeps the historical unconditional clear.
   */
  clearDraftAfterPrompt(observedRevision?: number, observedUpdateId?: string): DraftSetResult | undefined {
    if (observedRevision === undefined) return this.setDraft('');
    const record = this.draftStore?.get(this.conn.info.tool, this.conn.info.id);
    const current = this.draftStore ? (record?.revision ?? 0) : this.draft.revision;
    const lastUpdateId = this.draftStore ? record?.lastUpdateId : this.draft.updateId;
    // Revision alone is not enough. A client that presses Send while its own draft write is still
    // unacknowledged reports the PRE-write revision — the draft and the prompt travel the same
    // socket, so the broker applies the draft first and moves past it. That draft is this prompt's
    // own text, so its acceptance still makes the clear ours: an updateId match is equally valid
    // proof of ownership. Without it the just-sent text would survive as the shared unsent draft.
    const owned =
      current === observedRevision ||
      (observedUpdateId !== undefined && lastUpdateId !== undefined && lastUpdateId === observedUpdateId);
    if (!owned) return undefined;
    if (current === 0 && !this.draft.text) return undefined; // nothing shared to clear
    // Base the clear on the CURRENT revision, not the stale one the sender reported, so an
    // updateId-proven clear is not then rejected as stale-base by the store.
    return this.setDraft('', { baseRevision: current });
  }

  /**
   * Current draft for late-joiner replay, including a CLEAR TOMBSTONE (empty text with its
   * revision).
   *
   * A device that was offline when another client cleared or sent the draft holds a clean local row
   * at an older revision. Without the tombstone it sees no record at all, keeps that row, and
   * redisplays a draft the session no longer has. Replaying the empty revision lets it adopt the
   * clear. Only versioned clients may receive it — a legacy client has no revision to compare and
   * would just have its composer wiped, so {@link draftSnapshot} keeps the old contract for them.
   */
  draftSnapshot(options: { includeTombstone?: boolean } = {}): { text: string; at: number; revision: number } | null {
    if (this.draft.text) {
      return { text: this.draft.text, at: this.draft.at, revision: this.draft.revision };
    }
    if (!options.includeTombstone || this.draft.revision <= 0) return null;
    // Only a RETAINED empty record is replayed, because only that is evidence
    // of an explicit clear. A session with no record at all is not the same
    // thing: retention removes evicted and expired NON-EMPTY drafts by exactly
    // the same route, and a device's clean local row is then the last copy of
    // that text anywhere. Synthesizing an authoritative empty revision would
    // delete it — the broker forgetting its cached copy would destroy the
    // user's. Silence leaves the device showing a draft the others cannot see,
    // which is recoverable; deletion is not. Tombstone retention is what covers
    // a real clear: it matches the device-local draft TTL, so a device cannot
    // outlive the tombstone that would have informed it.
    return { text: '', at: this.draft.at, revision: this.draft.revision };
  }

  observeHistory(messages: AgentMessage[]): void {
    const latest = new Map<string, Extract<AgentMessage, { type: 'task-list-state' }>>();
    for (const message of messages) {
      const semantic = planSemanticFromMessage(message);
      if (semantic && message.type === 'task-list-state') latest.set(semantic.planKey, message);
    }
    for (const [planKey, message] of latest) {
      // Live evidence already observed on this owner is newer than an attach snapshot. This also
      // closes the getHistory race: a plan emitted while history is loading must not be overwritten.
      if (!this.currentPlans.has(planKey) && message.status !== 'cleared') this.currentPlans.set(planKey, message);
    }
  }

  currentPlan(planKey: unknown): Extract<AgentMessage, { type: 'task-list-state' }> | undefined {
    return typeof planKey === 'string' ? this.currentPlans.get(planKey) : undefined;
  }

  private observePlan(message: AgentMessage): void {
    const semantic = planSemanticFromMessage(message);
    if (!semantic || message.type !== 'task-list-state') return;
    if (message.status === 'cleared') this.currentPlans.delete(semantic.planKey);
    else this.currentPlans.set(semantic.planKey, message);
  }

  updateInfo(info: SessionInfo): void {
    replaceInfo(this.conn.info, info);
    // A broker write, not an adapter one: record it so the next fold does not read it back as an
    // adapter-side transition. Callers that must not weaken this owner already pass `mc.status`.
    this.observedConnStatus = this.conn.info.status;
    this.broadcastSession(this.conn.info);
  }

  /** Swap the underlying connection while preserving websocket clients. Used when an Observe attach
   *  becomes True Sync because an external terminal bridge appeared after the app was already open. */
  replaceConnection(conn: SessionConnection): void {
    if (conn === this.conn) {
      this.broadcastSession(conn.info);
      return;
    }
    const retainedBefore = this.requiresAttentionRetention;
    const old = this.conn;
    try {
      this.unsub();
    } catch {
      /* ignore */
    }
    this.conn = conn;
    this.unsub = conn.subscribe((m) => this.push(m));
    this.liveText.clear();
    this.liveRunning = conn.info.status !== 'idle';
    this.liveNeedsInput = conn.info.status === 'needs-input';
    this.observedConnStatus = conn.info.status;
    this.pendingInput.clear();
    this.currentPlans.clear();
    this.clearLiveAttentionEvidence();
    this.updateInfo(conn.info);
    // A transport swap can hide turns that went through the OTHER owner before the swap: the new
    // conn's subscription only carries FUTURE events. Concretely: a terminal joins the codex daemon
    // and the user types within the sync-watch window (~2.5s poll + fold) — that message reached the
    // thread but the old stdio rival never relayed it, and without a resync it stays invisible on
    // every attached socket forever (issues-part2 item-15 re-flag: "message not shown in the app").
    // Same window exists for the pi-bridge adopt path (typed between TUI start and bridge hello).
    if (this.clients.size > 0) void this.resync().catch(() => {});
    if (retainedBefore !== this.requiresAttentionRetention) {
      this.attentionHooks.onRetentionChanged?.(this.conn.info, this.requiresAttentionRetention);
    }
    void old.close().catch(() => {});
  }

  /** Read a workspace file and push it to clients as a file-artifact: inline (data URL) when small,
   *  metadata-only when too big. HTML is bundled (local images/css/js inlined as data-URIs) so it
   *  renders standalone in the app's sandboxed iframe — there are no sibling files on the phone. */
  private emitArtifact(full: string, name: string, size: number, opts?: { proactive?: boolean }): boolean {
    const emissionVersion = ++this.artifactEmissionSequence;
    const mime = mimeFromName(name);
    const rel = this.cwd && isWithin(this.cwd, full) ? relative(this.cwd, full) : basename(name);
    const base: AgentMessage & { type: 'file-artifact' } = {
      type: 'file-artifact',
      name: basename(name),
      mimeType: mime,
      path: rel,
      size,
      proactive: opts?.proactive,
    };
    if (size > 5_000_000) {
      // Too big to inline. With the artifact store enabled, copy bytes into durable
      // content-addressed storage and surface a lazy ref; otherwise fall back to metadata only.
      const fallback: AgentMessage & { type: 'file-artifact' } = {
        ...base,
        artifactKey: artifactKeyFor(rel, `emission:${emissionVersion}`),
      };
      if (!this.artifactStore) {
        this.pushArtifact(fallback);
        return true;
      }
      try {
        this.pushArtifact(this.artifactStore.copyFile(
          this.sessionRef(),
          base,
          full,
          undefined,
          { sessionQualified: true },
        ));
        return true;
      } catch {
        return false;
      }
    }
    try {
      let buf = readFileSync(full);
      if (mime.includes('html')) buf = Buffer.from(this.bundleHtml(full, buf.toString('utf8')), 'utf8');
      if (this.artifactStore) {
        this.pushArtifact(this.artifactStore.putBytes(
          this.sessionRef(),
          base,
          buf,
          mime,
          undefined,
          { sessionQualified: true },
        ));
      } else {
        this.pushArtifact({ ...base, url: `data:${mime};base64,${buf.toString('base64')}` });
      }
      return true;
    } catch {
      return false;
    }
  }

  private sessionRef(): { tool: string; id: string } {
    return { tool: this.conn.info.tool, id: this.conn.info.id };
  }

  /** Fan a broker-injected artifact out live AND remember it (deduped by artifact identity, never
   *  path alone) so it survives a reattach or a history-reset — neither of which replays the agent's
   *  history would include it. */
  private pushArtifact(message: AgentMessage & { type: 'file-artifact' }): void {
    // Replace exact repeats, but keep distinct versions at the same path as durable session record.
    const key = artifactIdentity(message);
    const i = this.artifacts.findIndex((a) => a.type === 'file-artifact' && artifactIdentity(a) === key);
    if (i >= 0) this.artifacts.splice(i, 1, message);
    else this.artifacts.push(message);
    if (this.artifacts.length > this.artifactReplayLimit) {
      this.artifacts.splice(0, this.artifacts.length - this.artifactReplayLimit);
    }
    this.push(message);
  }

  /** Broker-injected artifacts to replay AFTER history on attach / resync (atomic snapshot, like
   *  {@link liveSnapshot}). A copy so a concurrent surface can't mutate it mid-iteration. */
  artifactSnapshot(): AgentMessage[] {
    return [...this.artifacts];
  }

  /** If this message is a successful native `write` of a deliverable-type file inside cwd, surface
   *  it as an artifact — so "make an html/pdf and send it to me" works with zero extra agent context.
   *  Source-code churn (.ts/.py/…) is excluded by {@link DELIVERABLE}; edits aren't 'write'. */
  private maybeSurfaceWrite(message: AgentMessage): void {
    if (message.type !== 'tool-result' || message.isError) return;
    if (message.toolName !== 'write') return; // file-creating tool (opencode); other adapters extend later
    const p = message.path;
    if (!p || !this.cwd) return;
    if (!DELIVERABLE.has(extname(p).toLowerCase())) return;
    const abs = resolve(this.cwd, p); // p is usually absolute; resolve tolerates relative too
    if (!isWithin(this.cwd, abs)) return; // never surface a write that escaped the workspace
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink() || !st.isFile()) return;
      // The exact session's native write result is the ownership proof. The
      // artifact store content-addresses repeats and versions changed bytes.
      this.emitArtifact(abs, basename(abs), st.size, { proactive: true });
    } catch {
      /* gone/unreadable */
    }
  }

  /** Deliver an explicit file (the agent's send_file tool, any type) from inside cwd. Returns a
   *  short status the tool relays back to the model. Bypasses the DELIVERABLE filter on purpose. */
  surfaceExplicit(rawPath: string): { ok: boolean; detail: string } {
    if (!this.cwd) return { ok: false, detail: 'no workspace dir for this session' };
    const abs = resolve(this.cwd, rawPath);
    if (!isWithin(this.cwd, abs)) return { ok: false, detail: 'path is outside the workspace' };
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink() || !st.isFile()) return { ok: false, detail: 'not a regular file' };
      if (!this.emitArtifact(abs, basename(abs), st.size, { proactive: true })) {
        return { ok: false, detail: 'artifact could not be stored within broker limits' };
      }
      return { ok: true, detail: `sent ${basename(abs)} (${st.size} bytes) to the user` };
    } catch {
      return { ok: false, detail: 'file not found' };
    }
  }

  /** Inline an HTML file's LOCAL asset references (img/script src, link href) as data-URIs so the
   *  artifact is self-contained. Remote (http/data/protocol-relative) refs are left untouched; only
   *  files inside cwd are inlined (no path escape). */
  private bundleHtml(htmlPath: string, html: string): string {
    const baseDir = dirname(htmlPath);
    const inline = (u: string): string | null => {
      if (!u || /^(https?:|data:|blob:|#|mailto:|tel:|\/\/)/i.test(u)) return null;
      const clean = u.split(/[#?]/)[0] ?? '';
      if (!clean) return null;
      const abs = resolve(baseDir, clean);
      if (!this.cwd || !isWithin(this.cwd, abs)) return null;
      try {
        const st = lstatSync(abs);
        if (st.isSymbolicLink() || !st.isFile() || st.size > 5_000_000) return null;
        return `data:${mimeFromName(abs)};base64,${readFileSync(abs).toString('base64')}`;
      } catch {
        return null;
      }
    };
    html = html.replace(/(<(?:img|script)\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi, (m, pre, q, u) => {
      const d = inline(u);
      return d ? `${pre}${q}${d}${q}` : m;
    });
    html = html.replace(/(<link\b[^>]*?\bhref\s*=\s*)(["'])(.*?)\2/gi, (m, pre, q, u) => {
      const d = inline(u);
      return d ? `${pre}${q}${d}${q}` : m;
    });
    return html;
  }

  private push(message: AgentMessage): void {
    if (
      message.type === 'metadata-update' &&
      (message.key === 'sessionInfo' || message.key === 'session-info') &&
      message.value &&
      typeof message.value === 'object'
    ) {
      Object.assign(this.conn.info as any, message.value);
      this.broadcastSession(this.conn.info);
      return;
    }
    // Out-of-band transcript change (undo/redo): re-pull the revert-filtered history and re-push
    // it wholesale instead of forwarding a chat message — the only way bubbles can *disappear*.
    if (message.type === 'history-reset') {
      this.liveText.clear();
      this.currentPlans.clear();
      void this.resync(message.notice);
      return;
    }
    this.observePlan(message);
    this.accumulateLive(message);
    try {
      this.attentionHooks.onMessage?.(this.conn.info, message);
    } catch (error) {
      console.warn('[hub] attention message observer failed:', error instanceof Error ? error.message : String(error));
    }
    const entry = { seq: ++this.seq, message };
    this.ring.push(entry);
    if (this.ring.length > 3000) this.ring.shift();
    for (const c of this.clients) c({ kind: 'message', ...entry });
    // After the tool-result is delivered, auto-surface a deliverable file the agent just wrote,
    // so "make an html/pdf and send it to me" works with no extra agent context.
    this.maybeSurfaceWrite(message);
  }

  /** Write this wrapper's own projection onto the adapter-owned SessionInfo, recording it so the
   *  adapter-transition fold below cannot read the broker's own write back as adapter evidence. */
  private applyManagedStatus(status: SessionInfo['status']): void {
    this.conn.info.status = status;
    this.observedConnStatus = status;
  }

  /**
   * Adopt a run-state transition the ADAPTER made on `conn.info` without emitting a frame (R0c.4).
   *
   * This is the one repair path for the edge-latch: the frame stream is the normal channel, and an
   * adapter that corrects itself out-of-band (Codex `markRunning`/`markIdle` from native
   * reconciliation) would otherwise diverge from this wrapper forever. It is deliberately NOT a
   * freshness rule and not an inferred-state channel — the value adopted is the owned connection's
   * own projection, the same authority `status` already publishes. A pending permission/question
   * still outranks it, exactly as in {@link status}.
   */
  private foldAdapterStatusTransition(): void {
    const current = this.conn.info.status;
    if (current === this.observedConnStatus || this.foldingAdapterStatus) return;
    this.observedConnStatus = current;
    this.liveNeedsInput = current === 'needs-input';
    this.liveRunning = current !== 'idle';
    // One run-state representation: write the managed projection back, so `conn.info.status` and the
    // published owner status cannot disagree even for one frame. Only pendingInput can differ from
    // the adopted value — a real permission/question outranks a bare `working`, exactly as in
    // {@link status}.
    const projected = this.liveNeedsInput || this.pendingInput.size > 0
      ? 'needs-input'
      : this.liveRunning ? 'working' : 'idle';
    if (projected !== current) {
      this.conn.info.status = projected;
      this.observedConnStatus = projected;
    }
    // A silent adapter correction is still a run-state transition: an attached client must not have
    // to wait for the roster poll. Re-entrant by construction (the broadcast observer re-reads
    // `status`), but bounded — the observed value is updated FIRST, so the nested fold is a no-op.
    this.foldingAdapterStatus = true;
    try {
      this.broadcastSession(this.conn.info);
    } finally {
      this.foldingAdapterStatus = false;
    }
  }

  /** Track in-flight streamed text so a late joiner can be caught up (see {@link liveSnapshot}). */
  private accumulateLive(message: AgentMessage): void {
    const retainedBefore = this.requiresAttentionRetention;
    const statusBefore = this.conn.info.status;
    if ((message.type === 'model-output' || message.type === 'thinking') && message.key) {
      const cur = this.liveText.get(message.key);
      const text = message.text != null ? message.text : (cur?.text ?? '') + (message.delta ?? '');
      this.liveText.set(message.key, { type: message.type, text });
    } else if (message.type === 'permission-request' || message.type === 'question-request') {
      this.liveNeedsInput = false;
      this.pendingInput.set(message.requestId, message);
      this.applyManagedStatus('needs-input');
    } else if (message.type === 'permission-resolved' || message.type === 'question-resolved') {
      // A duplicate or orphan resolution is not a state transition. In
      // particular, do not let an old cached resolution recompute/broadcast
      // status for an unrelated live request.
      if (this.pendingInput.delete(message.requestId)) {
        this.applyManagedStatus(this.status);
      }
    } else if (message.type === 'status') {
      // A replacement's needs-input seed is provisional until this owner emits its first exact
      // status frame. A real permission/question remains authoritative in pendingInput below.
      this.liveNeedsInput = false;
      if (message.status === 'idle') {
        this.liveRunning = false;
        this.liveText.clear(); // turn finished → those parts are now in history; reset the accumulator
      } else if (message.status === 'running') {
        this.liveRunning = true;
      }
      this.applyManagedStatus(this.status);
    } else if (message.type === 'run-summary') {
      if (message.status === 'running') this.activeRunKeys.add(message.key);
      else this.activeRunKeys.delete(message.key);
    } else if (message.type === 'goal-state') {
      const key = message.key ?? 'current';
      if (message.status === 'active') this.activeGoalKeys.add(key);
      else this.activeGoalKeys.delete(key);
    }
    const retainedAfter = this.requiresAttentionRetention;
    if (retainedBefore !== retainedAfter) {
      try {
        this.attentionHooks.onRetentionChanged?.(this.conn.info, retainedAfter);
      } catch (error) {
        console.warn('[hub] attention retention observer failed:', error instanceof Error ? error.message : String(error));
      }
    }
    // A run-state transition is control state, not transcript: push the updated SessionInfo so an
    // attached client stops showing a stale `working` the moment the turn ends, instead of waiting
    // for the roster poll. Existing `{ kind: 'session' }` frame — no contract change.
    if (this.conn.info.status !== statusBefore) this.broadcastSession(this.conn.info);
  }

  /** Accumulated in-flight text as replayable messages — sent to a client right after history so
   *  it sees text streamed before it attached. Captured atomically with addClient (no await between).
   *  Leads with a `running` status if a turn is in flight, so a mid-turn joiner doesn't show idle. */
  liveSnapshot(): AgentMessage[] {
    const out: AgentMessage[] = [...this.liveText].map(([key, v]) => ({ type: v.type, key, text: v.text }) as AgentMessage);
    if (this.liveRunning) out.unshift({ type: 'status', status: 'running' });
    out.push(...this.pendingInput.values());
    return out;
  }

  /** Re-fetch history and broadcast a fresh snapshot (+ optional system note) to all clients. */
  private async resync(notice?: string): Promise<void> {
    let full = await this.conn.getHistory().catch(() => null);
    // An EMPTY snapshot here is almost always a transient read (the CLI mid-rewrite at a compaction
    // boundary, or a fork transcript not flushed yet) — pushing it would WIPE every client's thread
    // until a manual refresh (issues-part2 "/compact removes/cleared the displayed messages"). Retry
    // once, then keep the current view rather than destroy it; the next reset/turn will resync.
    if (!full || full.length === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      full = await this.conn.getHistory().catch(() => null);
    }
    if (!full || full.length === 0) return;
    this.observeHistory(full);
    // Apply the same state-aware cap as initial attach. A raw slice loses durable panels/goal state
    // that may not recur in the transcript tail; projecting the newest state after the tail also
    // keeps terminal states such as "Goal paused" visible at the client's bottom scroll.
    // Governing doc: docs/architecture/client-ui.md
    const capped = capHistoryMessages(full, RESYNC_MAX_MESSAGES);
    const messages = capped.messages;
    const truncated = capped.truncated;
    this.ring.length = 0; // fresh baseline so a late joiner doesn't replay pre-revert live frames
    for (const c of this.clients) {
      c({ kind: 'history', messages, ...(truncated ? { truncated } : {}) });
      // Re-attach the received files AFTER history — the app clears the thread on a history frame, and
      // these broker-injected artifacts aren't in getHistory(), so without this they'd vanish on every
      // undo/redo/compaction. (This was the "received files disappeared" bug.)
      for (const a of this.artifacts) c({ kind: 'message', seq: ++this.seq, message: a });
      if (notice) c({ kind: 'notice', message: notice });
    }
  }

  addClient(c: Client): void {
    this.clients.add(c);
    this.attentionHooks.onClientCountChanged?.(this.conn.info, this.clients.size);
  }

  removeClient(c: Client): void {
    this.clients.delete(c);
    this.attentionHooks.onClientCountChanged?.(this.conn.info, this.clients.size);
  }

  /** Move every subscriber to a surviving wrapper without closing its socket.
   *  The callback retargets runtime mutation/release authority in the same JS
   *  turn as fan-out membership, so no open socket retains this discarded
   *  ManagedConn. */
  moveClientsTo(target: ManagedConn): number {
    if (target === this || this.clients.size === 0) return 0;
    const moving = [...this.clients];
    for (const client of moving) {
      this.clients.delete(client);
      target.clients.add(client);
      client.onManagedConnChanged?.(target);
    }
    this.attentionHooks.onClientCountChanged?.(this.conn.info, this.clients.size);
    target.attentionHooks.onClientCountChanged?.(target.conn.info, target.clients.size);
    return moving.length;
  }

  /** Rebuild attached clients after their owner transport changed outside
   *  replaceConnection(). */
  refreshAttachedClients(): void {
    if (this.clients.size > 0) void this.resync().catch(() => {});
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** True only for live conditions observed on this owned connection. It never infers from history. */
  get requiresAttentionRetention(): boolean {
    return this.liveRunning || this.pendingInput.size > 0 || this.activeRunKeys.size > 0 || this.activeGoalKeys.size > 0;
  }

  /** Is a turn currently running on this live connection? Drives the roster's working/idle overlay
   *  for a session the broker owns (attached or a pinned bridge), so a session being driven live
   *  doesn't show as idle. Derived from the status stream, identically for every adapter. */
  get isRunning(): boolean {
    this.foldAdapterStatusTransition();
    return this.liveRunning;
  }

  /** Roster-facing live state for this owned connection. */
  get status(): SessionInfo['status'] {
    this.foldAdapterStatusTransition();
    if (this.liveNeedsInput || this.pendingInput.size > 0) return 'needs-input';
    return this.liveRunning ? 'working' : 'idle';
  }

  /** Tell every attached client the live session ended/was-replaced in the terminal — a clean signal
   *  sent RIGHT BEFORE {@link dispose} clears the client set, so a phone on a bridged session that the
   *  user quit/forked sees an "ended" frame instead of a socket that silently goes quiet forever
   *  (the bridge reload/fork orphan bug). Only the bridge-teardown path ({@link Hub.evict}) calls
   *  this; a plain zero-client {@link Hub.release} has no one to notify. */
  notifyEnded(reason?: string): void {
    for (const c of this.clients) {
      try {
        c({ kind: 'ended', reason });
      } catch {
        /* isolate one bad client */
      }
    }
  }

  /** Release this wrapper's LOCAL resources — the conn subscription, fan-out clients, and buffers —
   *  WITHOUT closing the underlying connection. Used by rekey()'s merge path,
   *  where `old.conn` has been transferred to another ManagedConn: closing it would kill the live connection
   *  the surviving wrapper now owns. A merged-away wrapper must still release its native subscription
   *  so it cannot ring-buffer every later message forever. */
  detachLocal(): void {
    try {
      this.unsub();
    } catch {
      /* subscription already torn down */
    }
    this.clients.clear(); // never fan out to a stale client after teardown
    this.ring.length = 0;
    this.liveText.clear();
    this.pendingInput.clear();
    this.currentPlans.clear();
    this.clearLiveAttentionEvidence();
    this.artifacts.length = 0;
  }

  async dispose(): Promise<void> {
    this.detachLocal();
    await this.conn.close();
  }

  private clearLiveAttentionEvidence(): void {
    const hadIncompleteTransition = this.activeRunKeys.size > 0 || this.activeGoalKeys.size > 0;
    this.activeRunKeys.clear();
    this.activeGoalKeys.clear();
    if (!hadIncompleteTransition) return;
    try {
      this.attentionHooks.onObservationLost?.(this.conn.info);
    } catch {
      /* observer-only */
    }
  }
}

/** An attach still in flight, tagged with the generation it began under. */
interface PendingAttach {
  generation: number;
  promise: Promise<ManagedConn>;
}

/** An attach that began before this session's ownership changed and was
 *  therefore refused at admission. Distinct from an adapter failure: the attach
 *  itself succeeded, and re-attaching returns current state. */
export class SupersededAttachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupersededAttachError';
  }
}

export class Hub {
  private readonly conns = new Map<string, ManagedConn>();
  private readonly pending = new Map<string, PendingAttach>();

  /** Monotone per-key attach generation, bumped whenever this session's
   *  ownership changes under attaches that are already in flight — terminal
   *  handoff retiring the mutable keys, or an adapter's Drive eligibility being
   *  revoked on the bare one.
   *
   *  An attach that STARTED before the bump snapshotted an answer that no longer
   *  holds, so it may not be admitted afterwards — not as a registered wrapper,
   *  and not by another caller coalescing onto its in-flight promise. A registry
   *  lookup cannot enforce that: `pending` is the state `conns` does not show. */
  private readonly attachGeneration = new Map<string, number>();
  private disposed = false;
  /** Pending disposals: a connection with zero clients is torn down after a grace period. */
  private readonly evictTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Keys whose connection is owned EXTERNALLY (a live Pi bridge) — never evicted on zero clients;
   *  they live as long as the terminal session does, and are removed only on an explicit bye. */
  private readonly pinned = new Set<string>();
  /** Zero-client connections retained only because the broker observed an active attention source. */
  private readonly attentionLeases = new Set<ManagedConn>();
  private readonly attentionLeaseDenied = new Set<ManagedConn>();
  private readonly maxZeroClientLeases: number;
  /** One revision domain for session-level owner truth across every mode-scoped wrapper. */
  private readonly sessionOwners = new ActiveSessionOwnerRegistry<ManagedConn>();
  /** Session keys whose sole Drive owner is being closed for terminal handoff. */
  private readonly terminalHandoffs = new Set<string>();

  constructor(
    private readonly registry: AgentRegistry,
    /** Grace window before disposing an idle (zero-client) connection. */
    private readonly graceMs = 15000,
    private readonly artifactStore?: ArtifactStore,
    private readonly attentionHooks: HubAttentionHooks = {},
    /** Durable shared-draft store (DR1). When present, every ManagedConn writes drafts through it. */
    private readonly draftStore?: SharedDraftStore,
  ) {
    const configured = attentionHooks.maxZeroClientLeases ?? Number(process.env.COSYNCING_ATTENTION_MAX_LEASES ?? 32);
    this.maxZeroClientLeases = Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : 32;
  }

  private key(tool: string, id: string, mode?: string): string {
    // observe and resume of the SAME session are DISTINCT owners (one read-only tail, one drivable
    // process), so they must not collapse onto one ManagedConn. Default (observe/bridge) keeps the
    // bare `tool:id` key, preserving every existing adopt/evict/getConn caller.
    return mode && mode !== 'observe' ? `${tool}:${id}#${mode}` : `${tool}:${id}`;
  }

  /** The mutable owner terminal handoff is allowed to end, with the key it is registered under.
   *
   *  Deliberately NOT {@link getConn}. That one resolves `#resume ?? #live ?? bare` because a file
   *  delivery just needs whichever connection is live, and its bare fallback is load-bearing: an
   *  OpenCode bare conn can report `drive: 'driving'` and a Codex bare conn at `attachMode: 'live'`
   *  IS the mutable path. Handoff must not inherit that fallback. The bare key is also where the
   *  shared read-only observer lives, and the only thing standing between it and the close path
   *  would be the drive-state assertion at the call site — one predicate away from ending the very
   *  connection handoff is supposed to leave behind.
   *
   *  Ambiguity REFUSES rather than picking. If both `#resume` and `#live` exist, the session has two
   *  mutable owners and no ordering between them is defensible: preferring either silently ends one
   *  writer while the other keeps writing, which is the exact failure handoff exists to prevent.
   *  Returning undefined lets the caller refuse before anything is mutated. */
  private handoffOwner(tool: string, id: string): { key: string; managed: ManagedConn } | undefined {
    const candidates = (['resume', 'live'] as const)
      .map((mode) => ({ key: this.key(tool, id, mode) }))
      .map(({ key }) => ({ key, managed: this.conns.get(key) }))
      .filter((entry): entry is { key: string; managed: ManagedConn } => entry.managed !== undefined);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private reportEnsureBranch(branch: 'create' | 'reuse' | 'join', managed: ManagedConn, inflight = false): void {
    if (!/^(1|true|yes|on)$/i.test(String(process.env.COSYNCING_CODEX_ATTACH_DIAGNOSTICS ?? '').trim())) return;
    const attachMode = managed.conn.info.attachMode;
    const transport = attachMode === 'live' ? 'daemon-proxy' : attachMode === 'resume' ? 'stdio' : 'observe';
    try {
      console.error(`[codex-attach] ${JSON.stringify({
        event: 'hub.ensure',
        branch,
        transport,
        ...(managed.conn.info.nativeId ? { threadId: managed.conn.info.nativeId } : {}),
        ...(inflight ? { inflight: true } : {}),
      })}`);
    } catch {
      /* diagnostics never change ownership */
    }
  }

  private cancelEvict(key: string): void {
    const t = this.evictTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.evictTimers.delete(key);
    }
  }

  /** Drop every hub-side record of the wrapper at `key` — eviction timer,
   *  attention leases, registry row — with no await in between, so nothing can
   *  observe a half-unregistered wrapper.
   *
   *  Deliberately does NOT touch `pinned`: a pinned key means a live terminal
   *  bridge holds it, and whether that is the caller's to take down is the
   *  caller's decision, never this helper's. */
  private unregisterWrapper(key: string, managed: ManagedConn): void {
    this.cancelEvict(key);
    this.attentionLeases.delete(managed);
    this.attentionLeaseDenied.delete(managed);
    this.conns.delete(key);
  }

  private generationOf(key: string): number {
    return this.attachGeneration.get(key) ?? 0;
  }

  /** Retire every attach begun before this moment for `key`: none of them may
   *  register, and no later caller may coalesce onto one. */
  private invalidateInFlightAttaches(key: string): void {
    this.attachGeneration.set(key, this.generationOf(key) + 1);
  }

  /** Drop an in-flight record only while it is still the current one — a newer
   *  attach may already have replaced it under the same key. */
  private clearPending(key: string, entry: PendingAttach): void {
    if (this.pending.get(key) === entry) this.pending.delete(key);
  }

  /** Settle a wrapper a failed handoff has already taken authority away from:
   *  tell its clients the session ended, drop local fan-out, close best-effort.
   *  Never throws — it runs on the failure path, where a second failure would
   *  only hide the first. */
  private settleHandoffCasualty(managed: ManagedConn): void {
    managed.notifyEnded('terminal-handoff-failed');
    managed.detachLocal();
    void managed.conn.close().catch(() => { /* settling a failed handoff */ });
  }

  private keyForManaged(target: ManagedConn): string | undefined {
    for (const [key, managed] of this.conns) if (managed === target) return key;
    return undefined;
  }

  private createManaged(conn: SessionConnection): ManagedConn {
    let managed!: ManagedConn;
    managed = new ManagedConn(conn, this.artifactStore, {
      onMessage: (info, message) => this.attentionHooks.onMessage?.(info, message),
      onRetentionChanged: () => this.handleRetentionChanged(managed),
      onClientCountChanged: (_info, count) => {
        if (count > 0) {
          this.attentionLeases.delete(managed);
          this.attentionLeaseDenied.delete(managed);
          const key = this.keyForManaged(managed);
          if (key) this.cancelEvict(key);
        }
      },
      onObservationLost: (info) => this.attentionHooks.onObservationLost?.(info),
      onSessionInfo: (info) => this.handleSessionInfo(managed, info),
    }, this.draftStore);
    return managed;
  }

  private matchingConnections(
    tool: string,
    id: string,
  ): Array<{ key: string; identity: ManagedConn; generation: SessionConnection; info: SessionInfo }> {
    const matches: Array<{
      key: string;
      identity: ManagedConn;
      generation: SessionConnection;
      info: SessionInfo;
    }> = [];
    for (const [key, managed] of this.conns) {
      if (managed.conn.info.tool === tool && managed.conn.info.id === id) {
        matches.push({
          key,
          identity: managed,
          generation: managed.conn,
          info: managed.conn.info,
        });
      }
    }
    return matches;
  }

  private reconcileSessionOwner(
    tool: string,
    id: string,
    fallbackInfo?: SessionInfo,
    sourceManaged?: ManagedConn,
  ): { projection: SessionOwnerProjection; owner?: { key: string; identity: ManagedConn; info: SessionInfo } } {
    const { resolution, changed, previouslyKnown } = this.sessionOwners.reconcile(
      tool,
      id,
      this.matchingConnections(tool, id),
    );
    if (changed) {
      for (const candidate of this.matchingConnections(tool, id)) {
        // The source ManagedConn's broadcast continues immediately after its
        // hook returns. Publish only to siblings here so each socket receives
        // one frame for this transition.
        if (candidate.identity === sourceManaged) continue;
        candidate.identity.broadcastSessionProjection(
          this.withOwnerProjection(candidate.info, resolution.projection),
        );
      }
      const source = resolution.owner?.info ?? fallbackInfo;
      // Preserve native-incarnation publication ordering: the first managed
      // connection for a never-seen adapter id is not itself a roster
      // publication. Discovery/owner frames publish it after predecessor
      // retirement. A previously projected session still publishes owner
      // transitions immediately.
      if (source && sourceManaged == null && previouslyKnown) {
        try {
          this.attentionHooks.onSessionInfo?.(
            this.withOwnerProjection(source, resolution.projection),
          );
        } catch {
          /* owner publication never changes connection lifecycle */
        }
      }
    }
    return resolution;
  }

  private handleSessionInfo(managed: ManagedConn, info: SessionInfo): void {
    const resolution = this.reconcileSessionOwner(
      info.tool,
      info.id,
      info,
      managed,
    );
    try {
      this.attentionHooks.onSessionInfo?.(
        this.withOwnerProjection(info, resolution.projection),
      );
    } catch {
      /* roster observation never changes the session stream */
    }
  }

  private withOwnerProjection(info: SessionInfo, owner: SessionOwnerProjection): SessionInfo {
    return {
      ...info,
      sessionOwner: {
        revision: { ...owner.revision },
        state: owner.state,
      },
    };
  }

  /** Current session-level owner truth for roster and Session Detail publication. */
  projectSessionInfo(info: SessionInfo): SessionInfo {
    const resolution = this.reconcileSessionOwner(info.tool, info.id, info);
    return this.withOwnerProjection(info, resolution.projection);
  }

  /** Socket-local Session Detail envelope. Owner truth never grants this socket authority. */
  sessionDetailFrame(
    managed: ManagedConn,
    allowJoinAction: boolean,
    sourceInfo: SessionInfo = managed.conn.info,
    readOnly = false,
  ): Extract<WireEvent, { kind: 'session' }> {
    const info = this.projectSessionInfo(sourceInfo);
    // `readOnly` is the SOCKET's own declaration, so it overrides what the
    // connection would otherwise grant. The connection can legitimately be a
    // driving one — an opencode shared-serve attach is mutable however it was
    // opened — and publishing its authority to a socket that asked not to have
    // any is precisely the fail-open: the client would render a live composer
    // for a session it told the broker it could not reason about.
    const authority = readOnly
      ? { canMutate: false, prompt: 'none' } as const
      : sessionConnectionAuthority(managed.conn.info);
    const resolution = this.reconcileSessionOwner(info.tool, info.id, info);
    const backend = this.registry.get(info.tool);
    const joinable =
      allowJoinAction
      && !authority.canMutate
      && resolution.projection.state === 'drive'
      && resolution.owner?.identity !== managed
      && backend?.capabilities.supportsCrossClientDriveSharing === true;
    return {
      kind: 'session',
      info,
      authority,
      ...(joinable
        ? { joinExisting: { ownerRevision: { ...resolution.projection.revision } } }
        : {}),
    };
  }

  /** Atomically reuse the exact shareable Drive owner the client observed. Never calls attach. */
  joinExisting(tool: string, id: string, expected: SessionOwnerRevision): ManagedConn {
    if (this.disposed) throw new Error('hub is shutting down');
    if (this.terminalHandoffs.has(this.key(tool, id))) {
      throw new JoinExistingError('JOIN_OWNER_NOT_FOUND', 'The observed Drive owner is handing control to the terminal.');
    }
    const resolution = this.reconcileSessionOwner(tool, id);
    const owner = resolution.owner;
    if (!owner || resolution.projection.state !== 'drive') {
      throw new JoinExistingError('JOIN_OWNER_NOT_FOUND', 'The observed Drive owner is no longer active.');
    }
    if (!sameOwnerRevision(resolution.projection.revision, expected)) {
      throw new JoinExistingError('JOIN_OWNER_STALE', 'The session owner changed before this client joined it.');
    }
    const backend = this.registry.get(tool);
    if (backend?.capabilities.supportsCrossClientDriveSharing !== true) {
      throw new JoinExistingError('JOIN_NOT_SUPPORTED', 'This agent does not share Drive across clients.');
    }
    this.cancelEvict(owner.key);
    this.attentionLeases.delete(owner.identity);
    this.attentionLeaseDenied.delete(owner.identity);
    this.reportEnsureBranch('join', owner.identity);
    return owner.identity;
  }

  /** End the requesting socket's broker-owned mutable owner only when it is
   *  the last attached driver. Peer drivers make the operation refuse; the
   *  UI must never report terminal handoff while another foreground client
   *  still holds the shared owner.
   *
   *  Resolves the owner across `#resume` AND `#live` (see {@link handoffOwner}).
   *  It used to look only under `#resume`, so a live-mode driver — kimi, dsh —
   *  was never found and the call threw `driver-changed` unconditionally.
   *
   *  ORDER, and why every step sits where it does:
   *
   *    close → unregister + owner=none → revoke eligibility → build Observe → migrate
   *
   *  Building Observe first (the previous order) asks the adapter for a fresh
   *  row while it still believes it owns the session, so an adapter with its own
   *  eligibility record publishes a DRIVABLE observer — handoff would appear to
   *  succeed and the next open would take Drive back with no user action.
   *  Unregistering immediately after the close is what keeps a failure honest:
   *  every later step can throw, and none of them may leave a closed wrapper
   *  still registered as the Drive owner. */
  async handoffToTerminal(
    tool: string,
    id: string,
    requester: ManagedConn,
  ): Promise<ManagedConn> {
    if (this.disposed) throw new Error('hub is shutting down');
    const sessionKey = this.key(tool, id);
    const owner = this.handoffOwner(tool, id);
    if (!owner || owner.managed !== requester || activeOwnerState(owner.managed.conn.info) !== 'drive') {
      // Ambiguity lands here too: two mutable owners resolve to `undefined`, and
      // refusing before any mutation is the only safe answer — see handoffOwner.
      throw new OwnershipConflictError(
        'This socket no longer owns the active Drive session.',
        'driver-changed',
      );
    }
    const { key: driveKey, managed: driver } = owner;
    if (driver.clientCount > 1) {
      throw new OwnershipConflictError(
        'Another foreground client is still driving this session. Close or hand off that client first.',
        'peer-driver-active',
      );
    }
    if (this.terminalHandoffs.has(sessionKey)) {
      throw new OwnershipConflictError(
        'Terminal handoff is already in progress for this session.',
        'driver-changed',
      );
    }
    // The observer this ends with has to be constructible BEFORE the native owner
    // is closed. An adapter with no read-only surface — dsh serves one
    // undifferentiated client contract and refuses every non-`live` attach —
    // would otherwise lose its only owner to a handoff that then cannot build the
    // connection meant to replace it. Read from the registered backend, never
    // from client-supplied state: a stale or hostile client must not be able to
    // talk the broker into stranding a session.
    const backend = this.registry.get(tool);
    if (!backend?.capabilities?.attachModes?.includes('observe')) {
      throw new OwnershipConflictError(
        'This agent has no read-only session to hand back to; handing off would leave nothing attached.',
        'driver-changed',
      );
    }

    this.terminalHandoffs.add(sessionKey);
    // Raising the fence is not enough on its own. `ensure` consults
    // `terminalHandoffs` when the request STARTS, so a mutable attach that was
    // already parked inside `backend.attach()` when the fence went up sails
    // straight past it and registers a brand-new Drive owner — during the
    // handoff, or after `finally` has cleared the fence. The bare-key
    // invalidation below does not reach it: it began under a different key.
    //
    // So both mutable keys are retired here, at the same moment the fence goes
    // up, and the admission check does the enforcing — which is what keeps it
    // honest after the fence is gone. This is deliberately NOT scoped to
    // adapters with adapter-owned eligibility: the fence protects every adapter,
    // in whichever direction the alternate attach runs (registered `#live` with
    // a parked `#resume`, or the reverse).
    this.invalidateInFlightAttaches(this.key(tool, id, 'resume'));
    this.invalidateInFlightAttaches(this.key(tool, id, 'live'));
    try {
      // Owner truth and the requester stay on Drive until the native owner has
      // actually closed. A close failure changes nothing and the caller gets a
      // refusal instead of a fabricated owner=none transition.
      await driver.conn.close();

      // From here authority is GONE, so it is published as gone immediately —
      // synchronously, with no await in between. Anything that throws after this
      // point settles through the catch below; nothing restores Drive.
      this.pinned.delete(driveKey);
      this.unregisterWrapper(driveKey, driver);
      this.reconcileSessionOwner(tool, id);

      let stale: ManagedConn | undefined;
      try {
        // Before the observer is built, not after: the adapter must not answer an
        // observe attach while it still thinks it may drive this session.
        //
        // Fenced on BOTH sides, because an attach can be in flight rather than
        // registered, and `stale` below only sees what finished registering. An
        // attach parked mid-flight snapshotted the adapter's answer when it
        // STARTED, so:
        //   - the bump before covers one begun earlier — and, being outside the
        //     try, it stands even if the hook mutates and then throws;
        //   - the bump after covers one begun WHILE the hook ran, whose snapshot
        //     is just as pre-revocation.
        // Only an attach begun strictly after the hook settles may be admitted,
        // which is also what stops our own replacement `ensure` from coalescing
        // onto a promise that predates the revocation.
        if (backend.releaseDriveEligibility) {
          this.invalidateInFlightAttaches(sessionKey);
          try {
            await backend.releaseDriveEligibility(id);
          } finally {
            this.invalidateInFlightAttaches(sessionKey);
          }
        }

        // A bare observer may ALREADY exist — a resident/background client on the
        // same session is an ordinary topology. It was built while the session was
        // still owned, so the control it captured says Drive is supported, and
        // revocation changes the adapter's future answers rather than info already
        // sitting on a live connection. Reusing it would hand control to the
        // terminal and simultaneously tell the app it may take Drive back.
        //
        // So it is REPLACED, not reused, and its clients come along. The hub does
        // not rewrite the control state itself: only the adapter knows what the
        // post-revocation posture is, and a fresh attach is how it says so.
        //
        // Scoped to adapters that actually REVOKE. Without adapter-owned
        // eligibility nothing about the adapter's answer changed, so an existing
        // observer is not stale and replacing it would be churn — and would break
        // the established identity guarantee that handoff returns the session's
        // existing Observe wrapper for Codex, OpenCode and Pi.
        //
        // A PINNED wrapper is left alone — that is a live terminal bridge, which
        // is already the authoritative terminal-owned answer.
        stale = backend.releaseDriveEligibility && !this.pinned.has(sessionKey)
          ? this.conns.get(sessionKey)
          : undefined;
        if (stale) this.unregisterWrapper(sessionKey, stale);

        const observer = await this.ensure(tool, id);
        const moved = driver.moveClientsTo(observer) + (stale?.moveClientsTo(observer) ?? 0);
        driver.detachLocal();
        const resolution = this.reconcileSessionOwner(tool, id, observer.conn.info);
        if (moved > 0) {
          // Publish the post-handoff owner truth to the clients that just moved,
          // UNCONDITIONALLY. reconcileSessionOwner only broadcasts on a change,
          // and the drive→none change was already published above — synchronously,
          // at a moment when this session had no registered wrapper and therefore
          // no audience. Without this the requester is acked and never told, and
          // its UI keeps offering the Drive it just gave away.
          //
          // The same applies to a client carried over from a replaced observer:
          // it changed wrappers without changing owner state, so `changed` is
          // false for it too, and it would otherwise keep the pre-revocation row.
          observer.broadcastSessionProjection(
            this.withOwnerProjection(observer.conn.info, resolution.projection),
          );
          observer.refreshAttachedClients();
        }
        if (stale) {
          // Best-effort, and deliberately last: the handoff has already succeeded
          // by here — authority released, fresh truth published, clients migrated
          // — so a stubborn native close must not turn that into a failure. The
          // local teardown is what actually matters, and it cannot throw.
          stale.detachLocal();
          void stale.conn.close().catch(() => { /* replaced wrapper; nothing left to serve */ });
        }
        return observer;
      } catch (error) {
        // Authority was released and cannot be handed back. Tell the attached
        // clients the session ended, drop local resources, and rethrow so the
        // request is nacked. Never leave a socket fanning out from a ManagedConn
        // whose connection is already closed. The driver's native conn already
        // closed successfully above, so it is settled without a second close.
        driver.notifyEnded('terminal-handoff-failed');
        driver.detachLocal();

        // Then the UNION of every observer wrapper this handoff disturbed,
        // because the failure can land on either side of the swap:
        //
        //   - revocation itself mutated and THEN threw. `stale` was never
        //     captured, so the pre-existing observer is still registered — and
        //     still publishing the Drive the adapter has just taken away.
        //   - or the replacement was already built and registered, and the
        //     migration threw partway, leaving a fresh wrapper holding some of
        //     the clients.
        //
        // Reading the registry HERE, instead of trusting a variable captured
        // before the failure, is what makes those the same case. The pinned
        // exclusion is the same one the success path applies: a live terminal
        // bridge is not this handoff's to tear down.
        const casualties = new Set<ManagedConn>();
        if (stale) casualties.add(stale);
        const registered = this.pinned.has(sessionKey) ? undefined : this.conns.get(sessionKey);
        if (registered) {
          this.unregisterWrapper(sessionKey, registered);
          casualties.add(registered);
        }
        for (const casualty of casualties) this.settleHandoffCasualty(casualty);

        // Republished once nothing is left registered: whatever the failure
        // stranded, no wrapper may survive it still claiming Drive.
        this.reconcileSessionOwner(tool, id);
        throw error;
      }
    } finally {
      this.terminalHandoffs.delete(sessionKey);
    }
  }

  private handleRetentionChanged(managed: ManagedConn): void {
    const key = this.keyForManaged(managed);
    if (!key || this.pinned.has(key) || managed.clientCount > 0) return;
    if (managed.requiresAttentionRetention) {
      this.acquireAttentionLease(key, managed);
      return;
    }
    this.attentionLeaseDenied.delete(managed);
    if (this.attentionLeases.delete(managed)) this.scheduleEvict(key, managed);
  }

  private acquireAttentionLease(key: string, managed: ManagedConn): boolean {
    if (this.attentionLeases.has(managed)) {
      this.cancelEvict(key);
      return true;
    }
    if (this.attentionLeases.size >= this.maxZeroClientLeases) {
      if (this.attentionLeaseDenied.has(managed)) return false;
      this.attentionLeaseDenied.add(managed);
      console.warn(
        `[hub] zero-client attention lease cap ${this.maxZeroClientLeases} reached; ${managed.conn.info.tool}:${managed.conn.info.id} will use normal disposal`,
      );
      try {
        this.attentionHooks.onLeaseDenied?.(managed.conn.info);
      } catch {
        /* diagnostics must not break connection lifecycle */
      }
      return false;
    }
    this.attentionLeases.add(managed);
    this.attentionLeaseDenied.delete(managed);
    this.cancelEvict(key);
    return true;
  }

  private scheduleEvict(key: string, managed: ManagedConn): void {
    if (this.disposed) return;
    this.cancelEvict(key);
    const timer = setTimeout(() => {
      this.evictTimers.delete(key);
      const current = this.conns.get(key);
      if (
        current === managed &&
        managed.clientCount === 0 &&
        !this.pinned.has(key) &&
        !this.attentionLeases.has(managed)
      ) {
        const fallbackInfo = structuredClone(managed.conn.info);
        this.conns.delete(key);
        this.attentionLeaseDenied.delete(managed);
        this.reconcileSessionOwner(fallbackInfo.tool, fallbackInfo.id, fallbackInfo);
        managed.dispose().catch((error) => console.error('[hub] dispose failed', key, error));
      }
    }, this.graceMs);
    this.evictTimers.set(key, timer);
  }

  private emitControlTransitions(
    before: SessionInfo,
    after: SessionInfo,
    cause: SessionControlTransition['cause'],
    intentional = false,
  ): void {
    for (const path of ['drive', 'terminal-sync'] as const) {
      const from = controlPathState(before, path);
      const to = controlPathState(after, path);
      if (from === to) continue;
      try {
        this.attentionHooks.onControlTransition?.({
          tool: after.tool,
          sessionId: after.id,
          sessionTitle: after.title,
          path,
          from,
          to,
          cause,
          intentional,
          observedAt: Date.now(),
        });
      } catch {
        /* attention observation never changes control lifecycle */
      }
    }
  }

  /** The live owning connection for a session if one is currently attached (else undefined).
   *  Used by the agent's send_file tool endpoint to deliver a file into the right session's stream.
   *  Prefer a mutating/active owner (#resume/#live) because Drive uses a distinct Hub key from
   *  read-only observe. Fallback to observe so plain observed shared-server sessions still work. */
  getConn(tool: string, id: string): ManagedConn | undefined {
    return (
      this.conns.get(this.key(tool, id, 'resume')) ??
      this.conns.get(this.key(tool, id, 'live')) ??
      this.conns.get(this.key(tool, id))
    );
  }

  /** Snapshot of every broker-owned live connection (attached sessions + pinned bridges) with its
   *  current run-state, for the roster to OVERLAY onto disk-discovered sessions — so a session being
   *  driven live shows its true attach mode (e.g. a Pi bridge as 'live') and floats up as 'working'
   *  instead of appearing idle/resume. Capability-driven: it reflects ANY owned connection's
   *  {@link SessionInfo}, never a per-tool branch.
   *
   *  The owning Hub key travels with each entry: one session id can have several owners, and the
   *  roster must pick exactly one of them deterministically rather than by iteration order (see
   *  `authoritativeLiveOwners`). */
  liveSnapshot(): LiveOverlayEntry[] {
    return [...this.conns.entries()].map(([key, mc]) => ({ key, info: mc.conn.info, status: mc.status }));
  }

  /** Push a broker-decorated SessionInfo frame to every matching open connection. This is used for
   *  display-only metadata changes (session/project rename) without mutating the adapter-owned
   *  SessionConnection info. */
  broadcastSessionWhere(predicate: (info: SessionInfo) => boolean, decorate: (info: SessionInfo) => SessionInfo): void {
    for (const mc of this.conns.values()) {
      if (predicate(mc.conn.info)) mc.broadcastSession(decorate(mc.conn.info));
    }
  }

  /** Patch the IN-MEMORY info of every matching open connection. A native rename updates the agent's
   *  own store and clears the broker alias — but an attached session's `mc.conn.info` still carried
   *  the attach-time title, so every later broadcast built from it (status flips etc.) resurrected
   *  the OLD name until the next roster poll re-corrected it, over and over (issues-part2 item 15:
   *  "renamed opencode session shows its original name, then the new one, and repeats"). */
  patchSessionInfoWhere(predicate: (info: SessionInfo) => boolean, patch: Partial<SessionInfo>): void {
    for (const mc of this.conns.values()) {
      if (predicate(mc.conn.info)) Object.assign(mc.conn.info, patch);
    }
  }

  /** Adopt an externally-owned connection (a live Pi bridge) into the Hub: it becomes the single
   *  owner for that session (so a WS client attach reuses it, never spawns a second `pi`), and is
   *  PINNED — `release()` won't dispose it on zero clients; only {@link evict} removes it. Idempotent. */
  /** Fold `#mode` sibling wrappers into the canonical `key` identity. A `?mode=resume` Drive attach
   *  owns a DISTINCT wrapper by design (see key()), but once a terminal becomes the true owner a
   *  surviving Drive wrapper would keep routing prompts to its broker-owned rival process while the
   *  terminal writes the same session, forking the conversation (issues-part2 items 3 and the codex
   *  app-created re-flag). A client-bearing sibling remains the preferred
   *  wrapper, but every client on the losing wrapper is migrated with its
   *  runtime authority target before that wrapper is disposed. The caller
   *  then swaps the survivor's transport via replaceConnection, which closes
   *  the rival process. */
  private foldModeScopedSiblings(key: string): void {
    let changedInfo: SessionInfo | undefined;
    const sibPrefix = `${key}#`;
    for (const k of [...this.conns.keys()]) {
      if (!k.startsWith(sibPrefix)) continue;
      const sibling = this.conns.get(k)!;
      changedInfo ??= structuredClone(sibling.conn.info);
      this.cancelEvict(k);
      this.conns.delete(k);
      this.pinned.delete(k);
      this.attentionLeases.delete(sibling);
      this.attentionLeaseDenied.delete(sibling);
      const base = this.conns.get(key);
      if (!base) {
        this.conns.set(key, sibling); // the Drive wrapper becomes the canonical identity
      } else if (sibling.clientCount > 0) {
        // A client-bearing Drive wrapper survives. Move canonical Observe
        // clients too; disposing their wrapper must not strand open sockets.
        this.cancelEvict(key);
        this.attentionLeases.delete(base);
        this.attentionLeaseDenied.delete(base);
        base.moveClientsTo(sibling);
        void base.dispose().catch(() => {});
        this.conns.set(key, sibling);
      } else {
        void sibling.dispose().catch(() => {}); // no clients worth preserving → close the rival process
      }
    }
    if (changedInfo) {
      this.reconcileSessionOwner(changedInfo.tool, changedInfo.id, changedInfo);
    }
  }

  adopt(tool: string, id: string, conn: SessionConnection): ManagedConn {
    if (this.disposed) throw new Error('hub is shutting down');
    const key = this.key(tool, id);
    this.foldModeScopedSiblings(key); // a terminal bridge hello makes the terminal the sole owner
    const existing = this.conns.get(key);
    if (existing) {
      // Cancel any pending eviction BEFORE pinning: if the Observe socket had just lost its last client,
      // release() armed a grace-window dispose timer; without cancelling it, that timer would fire and tear
      // down the bridge we are adopting right now (the sibling of the refreshExternalSession teardown).
      this.cancelEvict(key);
      existing.replaceConnection(conn); // upgrade an already-attached Observe socket to the live bridge
      this.attentionLeases.delete(existing);
      this.attentionLeaseDenied.delete(existing);
      this.pinned.add(key);
      this.reconcileSessionOwner(tool, id, existing.conn.info);
      return existing;
    }
    this.cancelEvict(key);
    const mc = this.createManaged(conn);
    this.conns.set(key, mc);
    this.pinned.add(key);
    this.reconcileSessionOwner(tool, id, mc.conn.info);
    return mc;
  }

  /** Move a default/adopted connection to a new session id without dropping attached clients.
   *  Used when an early Pi bridge hello used a symlink spelling before the JSONL existed, then the
   *  file materialized and canonical realpath identity became available. */
  rekey(tool: string, oldId: string, newId: string): ManagedConn | undefined {
    const oldKey = this.key(tool, oldId);
    const newKey = this.key(tool, newId);
    if (oldKey === newKey) return this.conns.get(oldKey);
    const old = this.conns.get(oldKey);
    if (!old) return this.conns.get(newKey);
    const existing = this.conns.get(newKey);
    if (existing && existing !== old) {
      existing.replaceConnection(old.conn);
      // `old.conn` now belongs to `existing`; free `old`'s wrapper-local resources (watcher/sweep/subscription)
      // WITHOUT closing that conn — old is removed from this.conns next and would otherwise leak forever.
      old.detachLocal();
      this.conns.delete(oldKey);
      this.attentionLeases.delete(old);
      this.attentionLeaseDenied.delete(old);
      if (this.pinned.delete(oldKey)) this.pinned.add(newKey);
      this.cancelEvict(oldKey);
      this.reconcileSessionOwner(tool, oldId, old.conn.info);
      this.reconcileSessionOwner(tool, newId, existing.conn.info);
      return existing;
    }
    this.conns.delete(oldKey);
    this.conns.set(newKey, old);
    if (this.pinned.delete(oldKey)) this.pinned.add(newKey);
    this.cancelEvict(oldKey);
    old.updateInfo({ ...old.conn.info, id: newId });
    this.reconcileSessionOwner(tool, oldId);
    this.reconcileSessionOwner(tool, newId, old.conn.info);
    return old;
  }

  /** Adapter-reported metadata/control change for an externally-owned session. If a bare Observe
   *  connection is open and the adapter now says terminal sync is active, reattach the bare owner
   *  through the adapter's default path so the same websocket becomes mutable. If sync disappears,
   *  the same path downgrades back to Observe. Resume/Drive owners are keyed separately and are not
   *  rewritten by terminal-side changes. */
  async refreshExternalSession(info: SessionInfo): Promise<void> {
    const key = this.key(info.tool, info.id);
    // A pinned connection is a broker-OWNED live bridge (Pi extension / Claude hooks overlay): its control
    // state is authoritative and flows from its own hello/hook endpoints, NOT from adapter discovery. An
    // adapter that reports the same session as observe-only — the Claude adapter ALWAYS returns
    // terminalSync.supported:false because Claude sync lives in the hook overlay, not the adapter — must
    // never tear the bridge down or rewrite it here. Only `evict` removes a pinned bridge. (Without this,
    // the Claude adapter's watchSessionInfo → refreshExternalSession downgrade branch would replace the
    // live hooks connection with a bare Observe one, killing sync and orphaning the in-flight permission /
    // question the hook is still blocking on.)
    if (this.pinned.has(key)) return;
    const incomingSynced = info.control?.terminalSync.supported === true && info.control.terminalSync.active === true;
    // A session being DRIVEN lives under a mode-scoped key (`tool:id#resume`) — the bare-key lookup
    // below misses it entirely, so a terminal joining an app-created session never upgraded the open
    // socket: the app kept prompting its rival broker-owned process while the terminal wrote the same
    // thread (issues-part2 re-flag: codex app-created true-sync broken both ways). When the adapter
    // reports the terminal as the true owner, fold the Drive rival into the canonical identity first;
    // the upgrade branch below then reattaches it through the adapter's default (live) path, which
    // closes the rival process while keeping every attached socket valid.
    if (incomingSynced) this.foldModeScopedSiblings(key);
    const mc = this.conns.get(key);
    if (!mc) return;
    const cur = mc.conn.info;
    const before: SessionInfo = structuredClone(cur);
    // Downgrade-reattach only when the sync loss changes the CONNECTION CLASS: codex reports
    // attachMode 'observe' once the daemon-live owner is gone (the live conn must be torn down), but
    // opencode still reports 'live' — its serve conn is identical with or without an attached TUI, and
    // a teardown+reattach there would risk dropping mid-run SSE deltas just to flip a badge off;
    // updateInfo below handles that losslessly. (The upgrade branch already discriminates by
    // `cur.attachMode !== 'live'` — an observe conn always reattaches to become mutable.)
    // NOT gated on the badge still being lit: presence-based active can flip off seconds BEFORE the
    // daemon unloads the thread (TUI exit → badge-off, then loaded-drop). Requiring currentSynced
    // here left an observe-class info sitting on a live daemon-proxy conn — a stale transport the
    // prompt gate then rejected confusingly.
    if ((incomingSynced && cur.attachMode !== 'live') || (!incomingSynced && cur.attachMode === 'live' && info.attachMode !== 'live')) {
      const backend = this.registry.get(info.tool);
      if (!backend) return;
      const conn = await backend.attach(info.id);
      // Generation fence: this refresh was derived from a snapshot that predates the attach await.
      // If the owner was replaced, retired, or adopted as a pinned bridge while attach was in
      // flight, the newer owner is the authority and this result is stale watcher work — swapping
      // it in would overwrite the replacement's exact projection with an older inferred one.
      if (this.conns.get(key) !== mc || this.pinned.has(key)) {
        void conn.close().catch(() => {});
        return;
      }
      mc.replaceConnection(conn);
      this.emitControlTransitions(before, mc.conn.info, 'runtime-unreachable');
      return;
    }
    // R0c.4 repair hand-off. A snapshot that CONTRADICTS the owner's definite run state used to be
    // discarded here, which is what made one missed edge permanent: every other source is
    // subordinated, so nothing could ever tell the owner it was wrong. The contradiction is handed
    // to the owner instead — it re-derives from its OWN exact native evidence and decides. The
    // snapshot's status is still never adopted (the line below is unchanged), so this cannot become
    // the inferred-state reversal path R0c.1 closed. An adapter without an exact native channel has
    // no capability here and the call does not exist.
    const repairable = runStateRepairable(mc.conn);
    if (repairable && contradictsOwnerRunState(info.status, mc.status)) {
      try {
        await repairable.requestRunStateRepair();
      } catch {
        /* an unavailable probe is unknown evidence; it never moves run state */
      }
      // Same generation fence as the reattach branch: the repair is an await, and the owner may
      // have been replaced, retired, or pinned while it ran.
      if (this.conns.get(key) !== mc || this.pinned.has(key)) return;
    }
    // Metadata/control refresh must not weaken this owner's exact managed run status: the live
    // connection observes the turn boundary itself, while the incoming snapshot only infers it from
    // a scan that may still be catching up. Same rule as the roster overlay: the managed status
    // owns ALL run states — an inferred needs-input is not adopted either; real permission/question
    // frames on the owned connection are the route to exact Needs input. Evaluated here — after
    // every await — so it cannot go stale against a newer owner frame.
    mc.updateInfo({ ...info, status: mc.status });
    this.emitControlTransitions(before, mc.conn.info, 'runtime-unreachable');
  }

  /** Remove + dispose an adopted bridge (on the extension's bye / session shutdown). Fans a clean
   *  `ended` frame to any attached client FIRST (so a phone isn't left on a silently-dead socket when
   *  the terminal session is quit/replaced), THEN tears the connection down. `reason` is Pi's
   *  SessionShutdownEvent.reason, surfaced to the app for a precise message. */
  async evict(tool: string, id: string, reason?: string): Promise<void> {
    const key = this.key(tool, id);
    const mc = this.conns.get(key);
    if (!mc) return;
    await this.retireManaged(key, mc, reason);
  }

  /** Retire owners superseded by a discovered incarnation of the same exact native session.
   *
   * Adapter ids may change when a native runtime replaces its transcript/process generation. The
   * native id is the only cross-incarnation join. Callers must pass only the canonical rows selected
   * by complete, generation-aware discovery; watcher frames are not replacement authority.
   * Ambiguous discovery (two replacement ids for one native id) retires nothing. Every mode-scoped
   * owner is removed before this resolves, so callers can remove the old roster row first. */
  async retireSupersededOwners(replacements: readonly SessionInfo[], reason = 'Native session incarnation replaced.'): Promise<SessionInfo[]> {
    const replacementIdByNative = new Map<string, string | null>();
    for (const info of replacements) {
      if (!info.nativeId) continue;
      const key = `${info.tool}\0${info.nativeId}`;
      const current = replacementIdByNative.get(key);
      replacementIdByNative.set(key, current === undefined || current === info.id ? info.id : null);
    }
    const targets = new Map<ManagedConn, string>();
    for (const [key, managed] of this.conns) {
      const info = managed.conn.info;
      if (!info.nativeId) continue;
      const replacementId = replacementIdByNative.get(`${info.tool}\0${info.nativeId}`);
      if (!replacementId || replacementId === info.id) continue;
      targets.set(managed, key);
    }
    const retired: SessionInfo[] = [];
    for (const [managed, key] of targets) {
      retired.push(structuredClone(managed.conn.info));
      await this.retireManaged(key, managed, reason);
    }
    return retired;
  }

  private async retireManaged(key: string, mc: ManagedConn, reason?: string): Promise<void> {
    if (this.conns.get(key) !== mc) return;
    this.pinned.delete(key);
    this.conns.delete(key);
    this.cancelEvict(key);
    this.attentionLeases.delete(mc);
    this.attentionLeaseDenied.delete(mc);
    const endedInfo = structuredClone(mc.conn.info);
    this.reconcileSessionOwner(endedInfo.tool, endedInfo.id, endedInfo);
    for (const path of ['drive', 'terminal-sync'] as const) {
      const from = controlPathState(endedInfo, path);
      if (from !== 'active' && from !== 'available') continue;
      try {
        this.attentionHooks.onControlTransition?.({
          tool: endedInfo.tool,
          sessionId: endedInfo.id,
          sessionTitle: endedInfo.title,
          path,
          from,
          to: 'unavailable',
          cause: 'peer-ended',
          observedAt: Date.now(),
        });
      } catch {
        /* attention observation never changes teardown */
      }
    }
    mc.notifyEnded(reason); // clean teardown signal BEFORE dispose() clears the client set
    try {
      this.attentionHooks.onSessionEnded?.(mc.conn.info, reason);
    } catch {
      /* attention failures never block native teardown */
    }
    await mc.dispose().catch(() => {});
  }

  /** Get-or-create the single owning connection for a session (de-duped). `mode` (e.g. 'resume')
   *  selects a DRIVABLE owner distinct from the read-only observe owner of the same session.
   *  `reason` (additive) is the authenticated drive-attach intent forwarded to the adapter so
   *  restore-vs-takeover arbitration happens atomically inside the single owner-creating call —
   *  it never changes the connection key, so concurrent restores still converge on one owner.
   *  `join-existing` uses a dedicated operation and never reaches this path. */
  async ensure(tool: string, id: string, mode?: string, reason?: DriveAttachReason): Promise<ManagedConn> {
    if (this.disposed) throw new Error('hub is shutting down');
    if (reason === 'join-existing') {
      throw new Error('join-existing must use Hub.joinExisting with an owner revision');
    }
    const key = this.key(tool, id, mode);
    // BOTH mutable modes are fenced, not just resume. The fence exists so nothing
    // re-acquires authority in the window where handoff has closed the native
    // owner and is still building the observer; a `live` attach acquires exactly
    // the same authority, so fencing only `resume` left the window open for every
    // live-mode adapter.
    if ((mode === 'resume' || mode === 'live') && this.terminalHandoffs.has(this.key(tool, id))) {
      throw new OwnershipConflictError(
        'This session is handing control to the terminal.',
        'driver-changed',
      );
    }
    // A mode-scoped attach (?mode=resume) must JOIN an existing canonical connection that is already
    // the drivable owner, instead of spawning a rival broker-owned process on the same session:
    //  - a PINNED conn is a live terminal bridge — the terminal is the sole owner (issues-part2 item 3:
    //    driven pi session + TUI = two writers on one JSONL);
    //  - a bare conn reporting drive:'driving' is a broker-owned driving path already (opencode shared
    //    serve) — a `#resume` twin would be an `opencode run` rival that shares NO live frames with the
    //    bare tab (issues-part2 item 14: two app tabs on one session, drafts/messages not mirrored);
    //  - a bare conn at attachMode 'live' is a true-sync owner (codex daemon-proxy) — it IS the mutable
    //    path (its drive state reads 'unavailable' because Drive-as-takeover makes no sense there), and
    //    a `#resume` twin would either throw or fork the thread.
    // Genuine resume flows are unaffected: there the bare conn (if any) is an OBSERVE conn
    // (drive:'observing'), which still warrants its own resume owner.
    const baseKey = this.key(tool, id);
    if (key !== baseKey) {
      const base = this.conns.get(baseKey);
      if (base && (this.pinned.has(baseKey) || base.conn.info.control?.drive?.state === 'driving' || base.conn.info.attachMode === 'live')) {
        this.cancelEvict(baseKey);
        this.attentionLeases.delete(base);
        this.attentionLeaseDenied.delete(base);
        this.reportEnsureBranch('join', base);
        return base;
      }
    }
    this.cancelEvict(key); // a fresh attach cancels any pending disposal
    const existing = this.conns.get(key);
    if (existing) {
      this.attentionLeases.delete(existing);
      this.attentionLeaseDenied.delete(existing);
      this.reportEnsureBranch('reuse', existing);
      return existing;
    }
    // Coalescing is generation-scoped. An in-flight attach from an earlier
    // generation began before this session's ownership changed, so joining it
    // would inherit exactly the answer that change exists to retract — which
    // includes the handoff's own replacement attach joining a stale observer.
    const startedGeneration = this.generationOf(key);
    const inflight = this.pending.get(key);
    if (inflight && inflight.generation === startedGeneration) {
      const managed = await inflight.promise;
      this.reportEnsureBranch('reuse', managed, true);
      return managed;
    }

    const entry: PendingAttach = { generation: startedGeneration, promise: undefined as never };
    entry.promise = (async () => {
      const backend = this.registry.get(tool);
      if (!backend) throw new Error(`unknown tool: ${tool}`);
      const conn = await backend.attach(id, mode as AttachMode | undefined, reason ? { reason } : undefined);
      // Checked at ADMISSION, not at call time: the adapter snapshots what it
      // may do when the attach starts, and the whole window between that
      // snapshot and this line is the race. A connection from a retired
      // generation is closed rather than registered — publishing it would
      // reinstate authority the session has since given up.
      if (this.generationOf(key) !== startedGeneration) {
        this.clearPending(key, entry);
        await conn.close().catch(() => { /* nothing was ever served from it */ });
        throw new SupersededAttachError(
          'This attach began before session ownership changed; attach again for current state.',
        );
      }
      const mc = this.createManaged(conn);
      this.conns.set(key, mc);
      this.clearPending(key, entry);
      this.reconcileSessionOwner(tool, id, mc.conn.info);
      this.reportEnsureBranch('create', mc);
      return mc;
    })();
    this.pending.set(key, entry);
    try {
      return await entry.promise;
    } catch (err) {
      this.clearPending(key, entry);
      throw err;
    }
  }

  /**
   * Called when a client disconnects. If no client remains, dispose the owning
   * connection after a grace period (lets a refresh re-attach without respawning)
   * — this is what prevents the per-session process/connection leak (B1).
   */
  release(tool: string, id: string, mode?: string): void {
    const key = this.key(tool, id, mode);
    if (this.pinned.has(key)) return; // a live bridge outlives its clients — only `evict` removes it
    const mc = this.conns.get(key);
    if (!mc || mc.clientCount > 0) return;
    if (mc.requiresAttentionRetention && this.acquireAttentionLease(key, mc)) return;
    this.scheduleEvict(key, mc);
  }

  /** Release the connection an attach actually joined.
   *
   * A `mode=resume` ensure may fold onto an already-mutable bare/live owner.
   * In that case releasing the requested `#resume` key is a no-op and leaks the
   * clientless canonical owner. Resolve the real key by identity before
   * delegating to the normal zero-client grace path. */
  releaseAttached(tool: string, id: string, requestedMode: string | undefined, mc: ManagedConn): void {
    const requestedKey = this.key(tool, id, requestedMode);
    if (this.conns.get(requestedKey) === mc) {
      this.release(tool, id, requestedMode);
      return;
    }
    const baseKey = this.key(tool, id);
    if (this.conns.get(baseKey) === mc) {
      this.release(tool, id);
    }
  }

  /** Close every broker-owned adapter connection and cancel all deferred eviction work. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.evictTimers.values()) clearTimeout(timer);
    this.evictTimers.clear();

    // An attach that started before shutdown may still create and register a ManagedConn. Wait for
    // those constructors to settle before taking the final connection snapshot.
    await Promise.allSettled([...this.pending.values()].map((entry) => entry.promise));
    this.pending.clear();

    const managed = [...new Set(this.conns.values())];
    this.conns.clear();
    this.pinned.clear();
    this.attentionLeases.clear();
    this.attentionLeaseDenied.clear();
    this.terminalHandoffs.clear();
    await Promise.allSettled(managed.map((connection) => connection.dispose()));
  }
}
