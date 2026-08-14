/**
 * OpenCode adapter.
 *
 * Two modes are intentionally separate:
 * - Private-runtime Observe + Drive: read local OpenCode storage, watch message/part dirs, and
 *   Drive only by spawning `opencode run --session ... --format json`. This is an app-owned
 *   continuation, not control of the original bare TUI runtime.
 * - Shared-server True Sync path: talk to a reachable `opencode serve` over HTTP/SSE; a terminal can
 *   join that same owner with `opencode attach ... -s <session> --dir <cwd>`.
 *
 * Contract: docs/protocol/adapter-support.md and
 * docs/architecture/client-ui.md
 */
import type {
  AgentBackend,
  AgentCapabilities,
  AgentMessage,
  AgentMessageHandler,
  AgentOption,
  AgentSetupDiagnosis,
  AttachMode,
  CommandResult,
  FileChange,
  FileInput,
  HistorySourceIdentity,
  ModelOption,
  PermissionDecision,
  PromptInput,
  SessionConnection,
  SessionControlState,
  SessionDiscoveryOptions,
  SessionInfo,
  SlashCommand,
  ToolCommandState,
  ToolDisplayClass,
  ToolSearchGroup,
  ToolSemantic,
  SetupDiagnosisContext,
  Unsubscribe,
} from '@cosyncing/adapter-api';

import {
  PRODUCT_IDENTITY,
  SessionCreateTemporarilyUnavailableError,
  boundToolSemantic,
  boundedStream,
  commandSemantic,
  fileReadSemantic,
  searchGroup,
  searchSemantic,
  splitUnifiedDiffFiles,
  webSemantic,
} from '@cosyncing/adapter-api';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join, basename, extname, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';
import { attachedTuiSessions, tuiPresenceSupported } from './tui-presence.ts';
import { diagnoseOpenCodeSetup } from './diagnostics.ts';

const OPENCODE_RETRY_DETAIL_MAX_SCALARS = 240;

/** Bounds opaque native retry prose before it crosses the adapter boundary. */
export function normalizeOpenCodeRetryDetail(message: unknown, attempt: unknown): string {
  const source = String(message ?? '');
  let first = '';
  for (const line of source.split(/\r\n|[\n\r\u2028\u2029]/u)) {
    const normalized = line.replace(/\p{Cc}/gu, '').trim();
    if (normalized.length > 0) {
      first = normalized;
      break;
    }
  }
  if (first.length === 0) first = 'Retrying…';
  const detail = attempt ? `${first} (retry #${String(attempt)})` : first;
  const scalars = [...detail];
  if (scalars.length <= OPENCODE_RETRY_DETAIL_MAX_SCALARS) return detail;
  return `${scalars.slice(0, OPENCODE_RETRY_DETAIL_MAX_SCALARS - 1).join('')}…`;
}

/** TUI join/leave watch cadence — slightly above the presence cache TTL so each tick re-scans. */
const TUI_PRESENCE_WATCH_MS = 2_500;

const CAPS: AgentCapabilities = {
  integrationKind: 'http-sse',
  attachModes: ['observe', 'resume', 'live'],
  supportsObserve: true,
  supportsResume: true,
  supportsLiveAttach: true,
  supportsNativeArtifact: true,
  supportsNativeFileInput: true,
  supportsModelSwitch: true,
  permissionGranularity: 'per-tool',
};

/** Disk-only private Observe has no process/liveness proof. Trust unfinished assistant/tool rows as
 *  "working" only while the persisted storage is fresh; old crashed/incomplete rows otherwise linger
 *  forever. Mirrors the Claude freshness-gate rationale. */
const OPENCODE_PRIVATE_WORKING_FRESH_MS = 30 * 60 * 1000;
const OPENCODE_SSE_IDLE_DEFAULT_MS = 120_000;
const OPENCODE_SSE_RECONNECT_DEFAULT_MS = 15_000;
const OPENCODE_RUN_RECORD_LIMIT = 128;

type Activity = 'working' | 'needs-input' | 'idle';
type RunSummaryMessage = Extract<AgentMessage, { type: 'run-summary' }>;
type TerminalRunStatus = Exclude<RunSummaryMessage['status'], 'running'>;

interface OpenCodeRunRecord {
  assistantId: string;
  info: any;
  userMessageKey?: string;
  assistantMessageKey?: string;
  fallbackStartedAt?: number;
  runningEmitted: boolean;
  terminalStatus?: TerminalRunStatus;
  lastTerminalSummary?: RunSummaryMessage;
}

interface OcSession {
  id: string;
  slug?: string;
  directory?: string;
  title?: string;
  model?: { id?: string; providerID?: string; modelID?: string; variant?: string };
  /** Session-level active agent/mode (e.g. 'build' | 'plan'); persisted by OpenCode ≥1.17. */
  agent?: string;
  time?: { created?: number; updated?: number };
  parentID?: string;
  revert?: { messageID?: string };
}

export interface OpenCodeAdapterOptions {
  /** Base URL of a running `opencode serve`. Defaults to $OPENCODE_URL or 127.0.0.1:4096. */
  baseUrl?: string;
  /** OpenCode storage root (the dir CONTAINING `storage/`). Defaults to $OPENCODE_DATA, then
   *  $XDG_DATA_HOME/opencode, then ~/.local/share/opencode. Used for disk-based roster discovery. */
  storageDir?: string;
  /** Test/internal override for SSE silent-hang detection. Defaults to COSYNCING_OPENCODE_SSE_IDLE_MS. */
  sseIdleMs?: number;
  /** Test/internal override for bounded reconnect after SSE drops. Defaults to COSYNCING_OPENCODE_SSE_RECONNECT_MS. */
  sseReconnectMs?: number;
  /** Broker-owned startup/restart boundary. It never creates a session; after it settles the adapter
   * re-probes once with GET. External users of the adapter may omit it. */
  waitForManagedCreateReadiness?: () => Promise<void>;
}

function nativeTimeMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return nativeTimeMs(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function runSummaryFromOpenCodeMessage(
  info: any,
  opts: {
    userMessageKey?: string;
    fallbackStartedAt?: number;
    assistantMessageKey?: string;
    status?: RunSummaryMessage['status'];
  } = {},
): RunSummaryMessage | undefined {
  if (!info || info.role !== 'assistant') return undefined;
  const assistantId = info.id ? String(info.id) : undefined;
  const userMessageKey = opts.userMessageKey || (info.parentID ? String(info.parentID) : undefined);
  const turnId = assistantId || userMessageKey;
  if (!turnId) return undefined;
  const startedAt = nativeTimeMs(info.time?.created) ?? opts.fallbackStartedAt;
  const inferredStatus = openCodeRunStatus(info);
  const status = opts.status ?? inferredStatus;
  // A live running projection must not leak the message-level terminal telemetry that C2R is
  // fencing. The connection retains the original info and restores these fields at native idle.
  const completedAt = status === 'running' ? undefined : nativeTimeMs(info.time?.completed);
  const totalRuntimeMs =
    typeof startedAt === 'number' && typeof completedAt === 'number'
      ? Math.max(0, completedAt - startedAt)
      : undefined;
  const tok = info.tokens;
  return {
    type: 'run-summary',
    key: `opencode:run:${assistantId || turnId}`,
    turnId,
    userMessageKey,
    assistantMessageKey: opts.assistantMessageKey,
    status,
    startedAt,
    completedAt,
    totalRuntimeMs,
    tokens: tok
      ? {
          input: tok.input,
          output: tok.output,
          cacheRead: tok.cache?.read,
          cacheWrite: tok.cache?.write,
          cost: info.cost,
        }
      : undefined,
    source: 'opencode',
  };
}

function openCodeRunStatus(info: any): RunSummaryMessage['status'] {
  if (isOpenCodeCancellation(info?.error) || /abort|cancel/i.test(String(info?.finish ?? ''))) {
    return 'cancelled';
  }
  if (info?.error) return 'error';
  return nativeTimeMs(info?.time?.completed) != null || info?.finish ? 'done' : 'running';
}

function isOpenCodeCancellation(error: any): boolean {
  if (!error) return false;
  const text = [
    error.name,
    error.code,
    error.message,
    error.data?.message,
  ].map((value) => String(value ?? '')).join(' ');
  return /abort|cancel/i.test(text);
}

function mergeOpenCodeMessageInfo(previous: any, next: any): any {
  if (!previous) return next;
  if (!next) return previous;
  const time = previous.time || next.time
    ? { ...(previous.time ?? {}), ...(next.time ?? {}) }
    : undefined;
  const cache = previous.tokens?.cache || next.tokens?.cache
    ? { ...(previous.tokens?.cache ?? {}), ...(next.tokens?.cache ?? {}) }
    : undefined;
  const tokens = previous.tokens || next.tokens
    ? {
        ...(previous.tokens ?? {}),
        ...(next.tokens ?? {}),
        ...(cache ? { cache } : {}),
      }
    : undefined;
  return {
    ...previous,
    ...next,
    ...(time ? { time } : {}),
    ...(tokens ? { tokens } : {}),
  };
}

function runtimeTotalsFromRunSummaries(summaries: AgentMessage[], source: string): AgentMessage | undefined {
  let totalRuntimeMs = 0;
  let agentRuntimeMs = 0;
  let executionRuntimeMs = 0;
  let turnCount = 0;
  let updatedAt: number | undefined;
  let hasAgent = false;
  let hasExecution = false;
  for (const m of summaries) {
    if (m.type !== 'run-summary' || (m.status !== 'done' && m.status !== 'error' && m.status !== 'cancelled')) continue;
    if (typeof m.totalRuntimeMs === 'number' && m.totalRuntimeMs >= 0) {
      totalRuntimeMs += m.totalRuntimeMs;
      turnCount += 1;
    }
    if (typeof m.agentRuntimeMs === 'number' && m.agentRuntimeMs >= 0) {
      agentRuntimeMs += m.agentRuntimeMs;
      hasAgent = true;
    }
    if (typeof m.executionRuntimeMs === 'number' && m.executionRuntimeMs >= 0) {
      executionRuntimeMs += m.executionRuntimeMs;
      hasExecution = true;
    }
    if (typeof m.completedAt === 'number') updatedAt = Math.max(updatedAt ?? 0, m.completedAt);
  }
  if (!turnCount) return undefined;
  return {
    type: 'metadata-update',
    key: 'runtimeTotals',
    value: {
      totalRuntimeMs,
      ...(hasAgent ? { agentRuntimeMs } : {}),
      ...(hasExecution ? { executionRuntimeMs } : {}),
      turnCount,
      updatedAt,
      source,
    },
  };
}

function firstAssistantPartKey(parts: any[] | undefined): string | undefined {
  const part = (parts ?? []).find((p) => p?.id && (p.type === 'text' || p.type === 'reasoning'));
  return part?.id ? String(part.id) : undefined;
}

/**
 * Resolve an `OPENCODE_URL` to the base origin this adapter talks to, pinning the default port `:4096` for
 * LOCAL hosts that omit a port. The managed serve (adapter-opencode/src/managed-server.ts) launches/probes a
 * portless local URL on `:4096`; the adapter and that serve share the SAME `OPENCODE_URL`, so the adapter
 * must resolve to the SAME base or its REST/SSE calls would hit the implicit port (`:80`/`:443`) while the
 * serve listens on `:4096` — True Sync would silently fail. Non-local or malformed URLs are returned trimmed
 * and unchanged (preserving any explicit port/path). Single source of truth for the broker↔adapter base.
 */
export function resolveLocalOpencodeBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/$/, '');
  try {
    const u = new URL(trimmed);
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]';
    if (local && !u.port) {
      u.port = '4096';
      return u.origin;
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

export class OpenCodeAdapter implements AgentBackend {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode';
  readonly capabilities = CAPS;
  readonly integration = {
    managedRuntime: { kind: 'server', failureJournal: true },
  } as const;
  /** Native transcript export is JSON via `opencode export` (read generically by the broker R2 gate). */
  readonly transcriptExportFormat = 'json' as const;
  private readonly baseUrl: string;
  private readonly serverExplicitlyConfigured: boolean;
  /** Resolved `…/opencode` data dir for private-runtime discovery (legacy JSON + current sqlite DB). */
  private readonly dataDir: string;
  /** Resolved `…/opencode/storage/session` dir for disk-based discovery (empty if not local). */
  private readonly sessionStoreDir: string;
  /** Resolved `…/opencode/storage` root for private-runtime Observe + Drive. */
  private readonly storageRoot: string;
  private readonly opencodeBin: string | null;
  private readonly sseIdleMs: number;
  private readonly sseReconnectMs: number;
  private readonly waitForManagedCreateReadiness?: () => Promise<void>;
  /** Real-time working/needs-input/idle for every session, from one global event sub. */
  private readonly tracker: SessionStatusTracker;
  /** Last authoritative model catalog. A transient refresh must not erase a usable picker. */
  private modelCatalogCache: ModelOption[] = [];
  /** Present only when the source authoritatively names the connected providers. */
  private modelCatalogProviders?: Set<string>;

  constructor(opts: OpenCodeAdapterOptions = {}) {
    this.serverExplicitlyConfigured = opts.baseUrl !== undefined || !!process.env.OPENCODE_URL?.trim();
    const raw = opts.baseUrl ?? process.env.OPENCODE_URL ?? 'http://127.0.0.1:4096';
    // Pin the default port for a portless local URL so this adapter's base matches the broker-managed serve
    // (which also launches/probes :4096). See resolveLocalOpencodeBaseUrl — single source of truth.
    this.baseUrl = resolveLocalOpencodeBaseUrl(raw);
    this.sseIdleMs = opencodeSseIdleMs(opts.sseIdleMs);
    this.sseReconnectMs = opencodeSseReconnectMs(opts.sseReconnectMs);
    this.waitForManagedCreateReadiness = opts.waitForManagedCreateReadiness;
    this.tracker = new SessionStatusTracker(this.baseUrl, this.sseIdleMs);
    this.dataDir = this.resolveDataDir(opts.storageDir);
    this.sessionStoreDir = this.dataDir ? join(this.dataDir, 'storage', 'session') : '';
    this.storageRoot = this.dataDir ? join(this.dataDir, 'storage') : '';
    this.opencodeBin = resolveBin('opencode');
  }

  /**
   * Resolve `…/opencode` for private-runtime discovery — WITHOUT hard-coding a path.
   * We mirror exactly how OpenCode itself resolves its data dir (verified from the binary: it reads
   * `OPENCODE_DATA`, then `XDG_DATA_HOME`, then the OS default — the env-paths/XDG convention), build
   * the per-platform candidates, and return the FIRST whose legacy `storage/session` OR current
   * `opencode.db` exists. So a wrong guess on an unusual setup is simply skipped, and missing storage
   * degrades to the pure-API path. Disabled (returns '') when the serve is REMOTE (the local disk is a
   * different machine's).
   *
   * Generalizable: Linux/WSL → `~/.local/share/opencode`; macOS → `~/Library/Application
   * Support/opencode`; Windows → `%LOCALAPPDATA%\opencode`; any platform → `$OPENCODE_DATA` /
   * `$XDG_DATA_HOME/opencode` / the `storageDir` option override. Existence-validation is what makes
   * it portable — we never depend on a single guess being right.
   */
  private resolveDataDir(override?: string): string {
    let host = '';
    try {
      host = new URL(this.baseUrl).hostname;
    } catch {
      /* malformed url → treat as non-local */
    }
    const local = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0' || host === '';
    if (!local && !override) return ''; // remote serve → don't pair with this machine's disk

    const home = homedir();
    // `override` and $OPENCODE_DATA are full data dirs; the rest are PARENTS that get `/opencode`.
    const dataDirs: string[] = [];
    if (override) dataDirs.push(override);
    if (process.env.OPENCODE_DATA) dataDirs.push(process.env.OPENCODE_DATA);
    const parents: Array<string | undefined> = [
      process.env.XDG_DATA_HOME,
      process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : undefined,
      process.platform === 'win32' ? process.env.LOCALAPPDATA || join(home, 'AppData', 'Local') : undefined,
      join(home, '.local', 'share'), // linux/WSL/XDG default (and a reasonable last-resort elsewhere)
    ];
    for (const p of parents) if (p) dataDirs.push(join(p, 'opencode'));

    for (const dir of dataDirs) {
      try {
        if (existsSync(join(dir, 'storage', 'session')) || existsSync(join(dir, 'opencode.db'))) return dir;
      } catch {
        /* unreadable → try next */
      }
    }
    return ''; // no local storage found → discovery uses the API path only
  }

  private url(path: string): string {
    return this.baseUrl + path;
  }

  /**
   * Ready-to-paste command that turns the user's terminal into a CLIENT of this same shared
   * server (single-owner), so the TUI and cosyncing stay live-synced. `-s <id>` opens
   * straight into this session; `--dir` scopes it to the repo. Run on the host machine.
   */
  private syncHint(id: string, cwd?: string): { label: string; command: string; note?: string } {
    const dir = cwd ? ` --dir ${shellQuote(cwd)}` : '';
    return {
      label: 'Sync with your terminal (optional)',
      command: `opencode attach ${shellQuote(this.baseUrl)} -s ${shellQuote(id)}${dir}`,
      note: 'Optional — you can already view and drive this session here without any terminal. Run this only if you also want your live OpenCode TUI to mirror it. On the host machine, quit the current bare `opencode` first (it runs its own private server), then paste this to join the shared one so terminal and app stay in sync.',
    };
  }

  private controlState(id: string, cwd?: string): SessionControlState {
    return opencodeControlState(this.syncHint(id, cwd), this.tuiAttached(id));
  }

  /** Is a same-host `opencode attach` TUI currently joined to this session on our serve? Proves the
   *  "synced" badge (see tui-presence.ts for why the OS, not the serve, is the source of truth). */
  private tuiAttached(id: string): boolean {
    return attachedTuiSessions(this.baseUrl).has(id);
  }

  async isAvailable(): Promise<boolean> {
    if (this.sessionStoreDir || this.opencodeBin) return true;
    return this.serverAvailable();
  }

  async diagnoseSetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
    return diagnoseOpenCodeSetup(context, {
      baseUrl: this.baseUrl,
      dataDir: this.dataDir,
      serverExplicitlyConfigured: this.serverExplicitlyConfigured,
    });
  }

  private async serverAvailable(): Promise<boolean> {
    try {
      const res = await fetch(this.url('/session'), {
        signal: AbortSignal.timeout(1500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** C5 guardrail signal: is any session on this serve mid-turn? Reads the live status tracker's
   *  in-memory map (fed by `/global/event` plus `/session/status` reconciliation) — O(1), no extra
   *  network. Ensures the subscription is running so the answer is meaningful even if
   *  `discoverSessions` hasn't polled recently. Used by the broker-owned serve watcher to defer a
   *  config-reload restart until idle. */
  anySessionBusy(): boolean {
    this.tracker.ensureStarted();
    return this.tracker.anyBusy();
  }

  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
    const serverOk = await this.serverAvailable();
    if (serverOk) this.tracker.ensureStarted(); // begin (or keep) the global status subscription
    // GET /session is scoped to the serve's DEFAULT project (its CWD) — it returns only that one
    // project's sessions (≈3 of hundreds). To surface the FULL roster, enumerate every project via
    // GET /project, then list each project's sessions with ?directory=<worktree>, and merge by id.
    // We additionally seed the directory list with every cwd seen in on-disk storage: sessions in a
    // directory that was never a registered /project worktree (e.g. a Windows home /mnt/c/Users/…)
    // are invisible to /project, but a direct ?directory= query DOES return them — with their live
    // title/model — so they're better fetched via the API than rebuilt from the (stale-title) disk row.
    const disk = this.readPrivateSessions(options);
    const dirs = serverOk ? [...new Set([...(await this.listProjectDirs()), ...disk.dirs])] : [];
    const lists = serverOk
      ? await Promise.all(
          dirs.map(async (dir) => {
            try {
              const q = dir ? `?directory=${encodeURIComponent(dir)}` : '';
              const r = await fetch(this.url(`/session${q}`), { signal: AbortSignal.timeout(4000) });
              return r.ok ? ((await r.json()) as OcSession[]) : [];
            } catch {
              return []; // a slow/failed project must not sink the whole roster
            }
          }),
        )
      : [];
    // Dedupe by id (a session shows up under exactly one worktree, but '' = default project may
    // overlap the CWD project's listing). Last-writer-wins is fine — same row either way.
    const byId = new Map<string, OcSession>();
    const serverIds = new Set<string>();
    for (const l of lists) {
      for (const s of l) {
        if (!s?.id) continue;
        byId.set(s.id, s);
        serverIds.add(s.id);
      }
    }
    // Even with every directory queried, one class stays invisible to the API: ORPHANED projectIDs —
    // a session whose projectID's worktree changed (git identity changed) so ?directory=<its cwd> now
    // resolves to a DIFFERENT project and never returns it. The on-disk storage is the authoritative
    // full set, so we fill these from disk. We only ADD ids the API didn't return (API rows win —
    // they carry live model/time/title) and only top-level sessions (no parentID), to avoid flooding
    // the roster with sub-agent children. Attach still works: GET /session/:id and /session/:id/message
    // resolve cross-projectID.
    for (const s of disk.parents) if (!byId.has(s.id)) byId.set(s.id, s);
    const list = [...byId.values()];
    // The global event stream is edge-triggered: if cosyncing starts or reconnects while a turn is
    // already running, there may be no fresh `session.status` event to seed the roster. Reconcile
    // against OpenCode's directory-scoped point-in-time status map before rendering the snapshot.
    // The tracker also repeats this reconciliation after every SSE reconnect.
    if (serverOk) await this.tracker.reconcile(list);
    // needs-input is authoritative from the CURRENT pending list (a question/permission may have
    // been asked before the tracker started or across a restart, which live events wouldn't show).
    // working/idle come from the live tracker.
    const pending = serverOk ? await this.pendingSessionIds(list) : new Set<string>();
    return list.flatMap((s): SessionInfo[] => {
      const live = this.tracker.get(s.id);
      const fromServer = serverIds.has(s.id);
      const syncHint = serverOk ? this.syncHint(s.id, s.directory) : undefined;
      const diskStatus = fromServer ? undefined : this.diskActivity(s.id);
      const status = pending.has(s.id) || live === 'needs-input'
        ? 'needs-input'
        : live === 'working' ? 'working' : diskStatus ?? 'idle';
      const timestamp = s.time?.updated ?? s.time?.created;
      if (
        options?.updatedAfter !== undefined &&
        status === 'idle' &&
        timestamp !== undefined &&
        timestamp < options.updatedAfter
      ) {
        return [];
      }
      return [{
        id: s.id,
        tool: this.id,
        ...opencodeLineage(s),
        title: s.title || s.slug || s.id,
        slug: s.slug,
        cwd: s.directory,
        status,
        attachMode: fromServer ? 'live' : 'observe',
        model: s.model?.id ?? s.model?.modelID,
        currentModel: currentModelOf(s),
        currentAgent: currentAgentOf(s),
        createdAt: s.time?.created,
        updatedAt: s.time?.updated,
        terminalSyncHint: syncHint,
        control: fromServer
          ? this.controlState(s.id, s.directory)
          : opencodePrivateControlState({ canDrive: !!this.opencodeBin, terminalSyncHint: syncHint }),
      } satisfies SessionInfo];
    });
  }

  /** Every project worktree OpenCode knows about, plus '' (the serve's default project). GET /project
   *  lists all projects with their `worktree`; we enumerate sessions per worktree to build the full
   *  roster. Skips the synthetic 'global' project (worktree '/'), which isn't a real session home. */
  private async listProjectDirs(): Promise<string[]> {
    try {
      const r = await fetch(this.url('/project'), { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return ['']; // fall back to the default-scoped listing
      const projs = (await r.json()) as Array<{ worktree?: string }>;
      const dirs = projs.map((p) => p?.worktree).filter((w): w is string => !!w && w !== '/');
      return ['', ...new Set(dirs)]; // '' = default project (covers the serve's CWD session too)
    } catch {
      return ['']; // server gone / no /project route → degrade to the single default listing
    }
  }

  private readPrivateSessions(options?: SessionDiscoveryOptions): { parents: OcSession[]; dirs: string[] } {
    const legacy = this.readDiskSessions(options);
    const db = this.readDbSessions(options);
    const byId = new Map<string, OcSession>();
    for (const s of legacy.parents) byId.set(s.id, s);
    // Current OpenCode (1.16.x) stores new sessions in opencode.db; prefer it over legacy JSON.
    for (const s of db.parents) byId.set(s.id, s);
    return {
      parents: [...byId.values()],
      dirs: [...new Set([...legacy.dirs, ...db.dirs])],
    };
  }

  private readDbSessions(options?: SessionDiscoveryOptions): { parents: OcSession[]; dirs: string[] } {
    const db = this.openDb();
    if (!db) return { parents: [], dirs: [] };
    try {
      const cutoff = options?.updatedAfter;
      options?.onWork?.({
        kind: 'sqlite-query',
        source: join(this.dataDir, 'opencode.db'),
        bounded: cutoff !== undefined,
        ...(cutoff === undefined ? {} : { cutoff }),
      });
      const rows = cutoff === undefined
        ? db
            .query(
              `select id, parent_id, slug, directory, title, model, revert, time_created, time_updated
               from session
               where time_archived is null
               order by time_updated desc`,
            )
            .all()
        : db
            .query(
              `select id, parent_id, slug, directory, title, model, revert, time_created, time_updated
               from session
               where time_archived is null
                 and coalesce(time_updated, time_created) >= ?
               order by time_updated desc`,
            )
            .all(cutoff);
      const parents: OcSession[] = [];
      const dirs = new Set<string>();
      for (const row of rows) {
        const s = dbSessionFromRow(row);
        if (s.directory && s.directory !== '/') dirs.add(s.directory);
        if (!s.parentID) parents.push(s);
      }
      return { parents, dirs: [...dirs] };
    } catch {
      return { parents: [], dirs: [] };
    } finally {
      db.close();
    }
  }

  private readDbSession(id: string): OcSession | undefined {
    const db = this.openDb();
    if (!db) return undefined;
    try {
      const row = db
        .query(
          `select id, parent_id, slug, directory, title, model, revert, time_created, time_updated
           from session
           where id = ?`,
        )
        .get(id) as any;
      return row ? dbSessionFromRow(row) : undefined;
    } catch {
      return undefined;
    } finally {
      db.close();
    }
  }

  private openDb(): Database | undefined {
    if (!this.dataDir) return undefined;
    const path = join(this.dataDir, 'opencode.db');
    try {
      if (!existsSync(path)) return undefined;
      return new Database(path, { readonly: true });
    } catch {
      return undefined;
    }
  }

  /** Read OpenCode's on-disk session storage — the authoritative complete set. Returns top-level
   *  (parentID-less) sessions for roster augmentation, plus EVERY distinct directory seen (so the
   *  caller can ?directory=-query non-project dirs via the API for live titles/models). Layout:
   *  `<store>/session/<projectIDdir>/<sessionID>.json`. Best-effort: any FS error yields empties so
   *  discovery degrades to the pure-API path. Disabled (store '') when the serve is remote. */
  private readDiskSessions(options?: SessionDiscoveryOptions): { parents: OcSession[]; dirs: string[] } {
    if (!this.sessionStoreDir) return { parents: [], dirs: [] };
    let files: string[];
    try {
      files = this.walkJson(this.sessionStoreDir, 2); // projectID dir → session files (depth 2 is plenty)
    } catch {
      return { parents: [], dirs: [] };
    }
    const parents: OcSession[] = [];
    const dirs = new Set<string>();
    for (const f of files) {
      try {
        if (
          options?.updatedAfter !== undefined &&
          statSync(f).mtimeMs < options.updatedAfter
        ) {
          continue;
        }
        options?.onWork?.({ kind: 'decode-file', source: f });
        const s = JSON.parse(readFileSync(f, 'utf8')) as OcSession;
        if (!s?.id) continue;
        if (s.directory && s.directory !== '/') dirs.add(s.directory); // a real cwd to API-query
        if (!s.parentID) parents.push(s); // top-level sessions only (skip sub-agent children)
      } catch {
        /* skip an unreadable/partial file */
      }
    }
    return { parents, dirs: [...dirs] };
  }

  /** Collect *.json paths under `dir` up to `maxDepth` levels deep (bounded so a pathological tree
   *  can't stall the roster). */
  private walkJson(dir: string, maxDepth: number): string[] {
    if (maxDepth < 0) return [];
    const out: string[] = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        try {
          out.push(...this.walkJson(full, maxDepth - 1));
        } catch {
          /* skip an unreadable subdir */
        }
      } else if (ent.isFile() && ent.name.endsWith('.json')) {
        out.push(full);
      }
    }
    return out;
  }

  /** sessionIDs that have a pending question or permission right now (queried per unique directory). */
  private async pendingSessionIds(list: OcSession[]): Promise<Set<string>> {
    const dirs = new Set<string>();
    for (const s of list) if (s.directory) dirs.add(s.directory);
    const ids = new Set<string>();
    await Promise.all(
      [...dirs].flatMap((dir) => {
        const q = `?directory=${encodeURIComponent(dir)}`;
        return ['/question', '/permission'].map(async (base) => {
          try {
            const r = await fetch(this.url(base + q), { signal: AbortSignal.timeout(2500) });
            if (r.ok) for (const x of ((await r.json()) as any[]) ?? []) if (x?.sessionID) ids.add(x.sessionID);
          } catch {
            /* ignore a slow/failed directory */
          }
        });
      }),
    );
    return ids;
  }

  async attach(sessionId: string, mode?: AttachMode): Promise<SessionConnection> {
    const serverOk = await this.serverAvailable();
    const list = await this.discoverSessions();
    // GET /session (used by discoverSessions) is scoped to the serve's default project dir, so a
    // session living in any other directory isn't listed. Resolve it directly by id (works
    // cross-directory) to recover its real cwd — without it sendFile writes nothing, directory-
    // scoped question/permission replies 404, and the outbox watcher never starts.
    const info =
      list.find((s) => s.id === sessionId) ??
      (serverOk ? await this.fetchSessionInfo(sessionId) : undefined) ??
      this.privateSessionInfo(sessionId, serverOk) ?? {
        id: sessionId,
        tool: this.id,
        title: sessionId,
        status: 'idle' as const,
        attachMode: 'observe' as const,
        control: opencodePrivateControlState({ canDrive: !!this.opencodeBin }),
      };
    if (mode === 'resume') {
      if (!this.opencodeBin) throw new Error(`OpenCode CLI is not available on PATH, so ${PRODUCT_IDENTITY.productName} cannot Drive this session.`);
      return new OpenCodeRunConnection(this.storageRoot, this.opencodeBin, {
        ...info,
        attachMode: 'resume',
        control: {
          ...opencodePrivateControlState({ canDrive: true, terminalSyncHint: info.terminalSyncHint }),
          drive: { supported: true, state: 'driving' },
        },
      });
    }
    if (mode !== 'live' && info.attachMode !== 'live') {
      return new OpenCodeObserveConnection(this.storageRoot, {
        ...info,
        attachMode: 'observe',
        control: info.control ?? opencodePrivateControlState({ canDrive: !!this.opencodeBin, terminalSyncHint: info.terminalSyncHint }),
      });
    }
    const conn = new OpenCodeConnection(
      this.baseUrl,
      info,
      this.sseIdleMs,
      this.sseReconnectMs,
      (current) => this.loadModelCatalog(current),
    );
    conn.start();
    // Wait until the /event SSE reader is actually connected before returning, so the
    // very first prompt sent on attach isn't fired into a not-yet-listening stream and
    // dropped (the cold-attach race). Bounded so a stalled server can't hang attach.
    await Promise.race([conn.ready, new Promise<void>((r) => setTimeout(r, 4000))]);
    return conn;
  }

  private privateSessionInfo(id: string, serverOk: boolean): SessionInfo | undefined {
    const s = this.readDbSession(id) ?? this.readDiskSession(id);
    if (!s) return undefined;
    const syncHint = serverOk ? this.syncHint(s.id, s.directory) : undefined;
    return {
      id: s.id,
      tool: this.id,
      ...opencodeLineage(s),
      title: s.title || s.slug || s.id,
      slug: s.slug,
      cwd: s.directory,
      status: this.diskActivity(s.id),
      attachMode: 'observe',
      model: s.model?.id ?? s.model?.modelID,
      currentModel: currentModelOf(s),
      currentAgent: currentAgentOf(s),
      createdAt: s.time?.created,
      updatedAt: s.time?.updated,
      terminalSyncHint: syncHint,
      control: opencodePrivateControlState({ canDrive: !!this.opencodeBin, terminalSyncHint: syncHint }),
    };
  }

  private readDiskSession(id: string): OcSession | undefined {
    if (!this.sessionStoreDir) return undefined;
    for (const f of this.walkJson(this.sessionStoreDir, 2)) {
      try {
        const s = JSON.parse(readFileSync(f, 'utf8')) as OcSession;
        if (s?.id === id) return s;
      } catch {
        /* skip */
      }
    }
    return undefined;
  }

  private diskActivity(id: string): SessionInfo['status'] {
    return opencodePrivateActivity(this.storageRoot, id);
  }

  async canCreateSession(): Promise<boolean> {
    return this.serverAvailable();
  }

  /** Prove the shared server is reachable before the broker performs model validation or the one POST.
   * A connection refusal may be the bounded broker-managed startup/restart window, so only that branch
   * waits and re-probes. HTTP responses are authoritative application/server answers and are never retried. */
  async prepareCreateSession(): Promise<void> {
    const first = await this.createReadinessProbe();
    if (first.kind === 'ready') return;
    if (first.kind === 'http-error') {
      throw new Error(`OpenCode create readiness failed with HTTP ${first.status}.`);
    }

    if (this.waitForManagedCreateReadiness) {
      await this.waitForManagedCreateReadiness();
      const afterStartup = await this.createReadinessProbe();
      if (afterStartup.kind === 'ready') return;
      if (afterStartup.kind === 'http-error') {
        throw new Error(`OpenCode create readiness failed with HTTP ${afterStartup.status}.`);
      }
    }

    throw new SessionCreateTemporarilyUnavailableError(
      'OpenCode shared server is temporarily unavailable. Wait for broker startup to finish, then retry.',
      'opencode-server-connection-unavailable',
    );
  }

  private async createReadinessProbe(): Promise<
    { kind: 'ready' } | { kind: 'connection-error' } | { kind: 'http-error'; status: number }
  > {
    try {
      const response = await fetch(this.url('/session'), { signal: AbortSignal.timeout(1500) });
      return response.ok ? { kind: 'ready' } : { kind: 'http-error', status: response.status };
    } catch {
      return { kind: 'connection-error' };
    }
  }

  /** Adapter-owned catalog shared by pre-session creation and attached-session pickers. */
  async listModels(): Promise<ModelOption[]> {
    return this.loadModelCatalog(undefined, false);
  }

  private async loadModelCatalog(
    current?: SessionInfo['currentModel'],
    allowStale = true,
  ): Promise<ModelOption[]> {
    try {
      const loaded = await fetchOpenCodeModelCatalog(this.baseUrl);
      this.modelCatalogCache = loaded.models;
      this.modelCatalogProviders = loaded.connectedProviders;
    } catch (error) {
      console.warn(
        `[opencode] listModels failed (serve down or unreachable at ${this.baseUrl}): ${String(error)}`,
      );
      if (!allowStale) throw error;
    }
    return preserveOpenCodeCurrentModel(
      this.modelCatalogCache,
      current,
      this.modelCatalogProviders,
    );
  }

  /** Push a fresh SessionInfo whenever a same-host `opencode attach` TUI joins or leaves one of our
   *  sessions, so the app's synced badge flips in ~poll-tick time (the Pi-bridge UX) instead of
   *  waiting for the next roster sweep. First scan is a baseline (no events); scan errors keep the
   *  last confirmed set rather than synthesizing a mass detach. */
  watchSessionInfo(onChange: (info: SessionInfo) => void): Unsubscribe {
    if (!tuiPresenceSupported(this.baseUrl)) return () => {};
    let stopped = false;
    let prev: Set<string> | undefined;
    const poll = async () => {
      if (stopped) return;
      const now = attachedTuiSessions(this.baseUrl);
      const before = prev;
      prev = now;
      if (!before) return; // baseline
      const changed = [...new Set([...before, ...now])].filter((id) => before.has(id) !== now.has(id));
      for (const id of changed) {
        const info = await this.fetchSessionInfo(id).catch(() => undefined);
        if (!info || stopped) continue;
        // fetchSessionInfo hardcodes 'idle'; overlay the live tracker so this push can't regress a
        // working session's status (hub.updateInfo replaces info wholesale).
        if (this.tracker.get(id) === 'working') info.status = 'working';
        onChange(info);
      }
    };
    const timer = setInterval(() => void poll(), TUI_PRESENCE_WATCH_MS);
    void poll();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  /** Resolve a single session by id, cross-directory (GET /session/:id is NOT scoped to the
   *  serve's default project, unlike the GET /session listing) — the authoritative source of a
   *  session's real cwd when it isn't in discoverSessions(). */
  private async fetchSessionInfo(id: string): Promise<SessionInfo | undefined> {
    try {
      const res = await fetch(this.url(`/session/${id}`), { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return undefined;
      const s = (await res.json()) as OcSession;
      return {
        id: s.id,
        tool: this.id,
        ...opencodeLineage(s),
        title: s.title || s.slug || s.id,
        slug: s.slug,
        cwd: s.directory,
        status: 'idle',
        attachMode: 'live',
        model: s.model?.id ?? s.model?.modelID,
        currentModel: currentModelOf(s),
        currentAgent: currentAgentOf(s),
        createdAt: s.time?.created,
        updatedAt: s.time?.updated,
        terminalSyncHint: this.syncHint(s.id, s.directory),
        control: this.controlState(s.id, s.directory),
      } satisfies SessionInfo;
    } catch {
      return undefined;
    }
  }

  async createSession(opts: {
    directory?: string;
    title?: string;
    model?: PromptInput['model'];
  } = {}): Promise<SessionInfo> {
    const q = opts.directory ? `?directory=${encodeURIComponent(opts.directory)}` : '';
    const body: Record<string, unknown> = {};
    if (opts.title) body.title = opts.title;
    // OpenCode selects models per prompt, not while creating the session.
    // Sending the prompt-only `model` / `variant` fields to POST /session is
    // rejected by current OpenCode releases with BadRequest. Keep the chosen
    // model in the returned session projection so the composer sends it on
    // the first prompt through prompt_async, where those fields are valid.
    const res = await fetch(this.url(`/session${q}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`opencode create session ${res.status}: ${await safeText(res)}`);
    const s = (await res.json()) as OcSession;
    return {
      id: s.id,
      tool: this.id,
      title: s.title || s.slug || s.id,
      slug: s.slug,
      cwd: s.directory,
      status: 'idle',
      attachMode: 'live',
      model: s.model?.id ?? s.model?.modelID ?? opts.model?.modelID,
      currentModel: currentModelOf(s) ?? opts.model,
      createdAt: s.time?.created,
      updatedAt: s.time?.updated,
      terminalSyncHint: this.syncHint(s.id, s.directory),
      control: this.controlState(s.id, s.directory),
    };
  }

  async renameSession(sessionId: string, title: string | null): Promise<SessionInfo> {
    const trimmed = title == null ? null : title.trim().slice(0, 160);
    const res = await fetch(this.url(`/session/${encodeURIComponent(sessionId)}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: trimmed || null }),
    });
    if (!res.ok) throw new Error(`opencode rename failed (${res.status})`);
    const s = (await res.json()) as OcSession;
    return {
      id: s.id || sessionId,
      tool: this.id,
      title: s.title || s.slug || s.id || sessionId,
      slug: s.slug,
      cwd: s.directory,
      status: 'idle',
      attachMode: 'live',
      model: s.model?.id ?? s.model?.modelID,
      currentModel: currentModelOf(s),
      createdAt: s.time?.created,
      updatedAt: s.time?.updated,
      terminalSyncHint: this.syncHint(s.id || sessionId, s.directory),
      control: this.controlState(s.id || sessionId, s.directory),
    };
  }

  async forkSession(sessionId: string, opts: { messageId?: string | null } = {}): Promise<SessionInfo> {
    const messageID = opts.messageId?.trim() || undefined;
    const res = await fetch(this.url(`/session/${encodeURIComponent(sessionId)}/fork`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messageID ? { messageID } : {}),
    });
    if (!res.ok) throw new Error(`opencode fork failed (${res.status})`);
    const s = (await res.json().catch(() => null)) as OcSession | null;
    if (!s?.id) throw new Error('opencode fork did not return a session');
    return {
      id: s.id,
      tool: this.id,
      title: s.title || s.slug || s.id,
      slug: s.slug,
      cwd: s.directory,
      status: 'idle',
      attachMode: 'live',
      model: s.model?.id ?? s.model?.modelID,
      currentModel: currentModelOf(s),
      createdAt: s.time?.created,
      updatedAt: s.time?.updated,
      terminalSyncHint: this.syncHint(s.id, s.directory),
      control: this.controlState(s.id, s.directory),
    };
  }

  /**
   * Gated R2 transcript export (Slice 6). Runs `opencode export <sessionID> --sanitize` with explicit
   * argv (never a shell, never the TUI `/export`), captures stdout under a byte cap + timeout (killing
   * the process on either), strips the leading informational `Exporting session: …` line, and writes the
   * JSON into the BROKER-OWNED temp dir. The broker then enforces path containment, runs the mandatory
   * cosyncing redaction pass, and delivers it as an export-attachment. Never accepts a client path.
   */
  async exportTranscript(
    sessionId: string,
    opts: { tempDir: string; maxBytes: number; timeoutMs: number },
  ): Promise<{ path: string; format: 'json' }> {
    if (!this.opencodeBin) throw new Error('OpenCode CLI is not available on PATH; cannot export transcript.');
    const outPath = join(opts.tempDir, 'export.json');
    const proc = Bun.spawn([this.opencodeBin, 'export', sessionId, '--sanitize'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });
    const chunks: Buffer[] = [];
    let total = 0;
    let timedOut = false;
    let tooLarge = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }, opts.timeoutMs);
    try {
      const reader = proc.stdout.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > opts.maxBytes) {
          tooLarge = true;
          try {
            proc.kill();
          } catch {
            /* already exited */
          }
          break;
        }
        chunks.push(Buffer.from(value));
      }
      const code = await proc.exited;
      if (tooLarge) throw new Error('opencode export exceeded the size cap');
      if (timedOut) throw new Error('opencode export timed out');
      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text().catch(() => '');
        throw new Error(`opencode export exited ${code}: ${stderr.split('\n')[0]?.slice(0, 200) ?? ''}`);
      }
    } finally {
      clearTimeout(timer);
    }
    const text = stripLeadingNonJson(Buffer.concat(chunks).toString('utf8'));
    writeFileSync(outPath, text);
    return { path: outPath, format: 'json' };
  }
}

/** Drop any leading informational lines (e.g. `Exporting session: …`) before the JSON payload. */
function stripLeadingNonJson(s: string): string {
  const lines = s.split('\n');
  let i = 0;
  while (i < lines.length && !/^\s*[[{]/.test(lines[i]!)) i++;
  return i < lines.length ? lines.slice(i).join('\n') : s;
}

export function opencodeControlState(terminalSyncHint: SessionInfo['terminalSyncHint'], tuiAttached = false): SessionControlState {
  return {
    // OpenCode sessions listed by `opencode serve` are already driven through that shared server.
    // The optional terminal sync path is separate: a host TUI must run `opencode attach ...`.
    // Contract: docs/architecture/client-ui.md
    drive: { supported: true, state: 'driving' },
    terminalSync: tuiAttached
      ? {
          supported: true,
          syncAvailable: true,
          // Co-ownership PROVEN: a same-host `opencode attach` TUI for this session is alive right
          // now (tui-presence.ts) — terminal and app share the one serve owner.
          active: true,
          label: 'Synced with OpenCode terminal',
          note: 'A terminal is attached to this session via `opencode attach` — it and the app share the same live server.',
        }
      : {
          supported: true,
          // This session is served by a reachable `opencode serve`, so a host TUI can mirror it via
          // `opencode attach …` — sync is AVAILABLE but not yet active.
          syncAvailable: true,
          active: false,
          action: 'join',
          label: terminalSyncHint?.label ?? 'Sync with OpenCode terminal',
          command: terminalSyncHint?.command,
          note: terminalSyncHint?.note,
          reason: terminalSyncHint?.command ? undefined : 'OpenCode terminal sync requires a reachable opencode serve URL.',
        },
  };
}

function opencodePrivateControlState(opts: {
  canDrive: boolean;
  terminalSyncHint?: SessionInfo['terminalSyncHint'];
}): SessionControlState {
  return {
    // Private bare OpenCode TUI sessions have no reachable runtime. Observe tails disk; Drive starts
    // a broker-owned continuation. Only terminalSync.active proves same-live-owner control.
    // Contract: docs/architecture/client-ui.md
    drive: opts.canDrive
      ? { supported: true, state: 'observing' }
      : { supported: false, state: 'unavailable', reason: `OpenCode CLI is not available on PATH, so ${PRODUCT_IDENTITY.productName} cannot Drive this session.` },
    terminalSync: opts.terminalSyncHint
      ? {
          supported: true,
          // A reachable serve endpoint exists (we have a join command), so this private session can be
          // brought into sync via `opencode attach …` — AVAILABLE but not yet active.
          syncAvailable: true,
          active: false,
          label: opts.terminalSyncHint.label,
          command: opts.terminalSyncHint.command,
          note: opts.terminalSyncHint.note,
        }
      : {
          supported: false,
          syncAvailable: false,
          active: false,
          reason: 'OpenCode true sync requires a shared opencode serve endpoint; this private TUI session is observe-only until you Drive or configure True Sync.',
      },
  };
}

function opencodeDisconnectedControlState(reason = 'The shared opencode serve connection ended. Reconnect the server or reopen this session before sending input.'): SessionControlState {
  return {
    drive: {
      supported: false,
      state: 'unavailable',
      reason,
    },
    terminalSync: {
      supported: false,
      syncAvailable: false,
      active: false,
      reason,
    },
  };
}

function opencodeSseIdleMs(override?: number): number {
  const n = Number(override ?? process.env.COSYNCING_OPENCODE_SSE_IDLE_MS ?? OPENCODE_SSE_IDLE_DEFAULT_MS);
  return Number.isFinite(n) && n > 0 ? Math.max(50, n) : OPENCODE_SSE_IDLE_DEFAULT_MS;
}

function opencodeSseReconnectMs(override?: number): number {
  const n = Number(override ?? process.env.COSYNCING_OPENCODE_SSE_RECONNECT_MS ?? OPENCODE_SSE_RECONNECT_DEFAULT_MS);
  return Number.isFinite(n) && n >= 0 ? n : OPENCODE_SSE_RECONNECT_DEFAULT_MS;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type OpenCodeSessionProbe = 'exists' | 'missing' | 'down' | 'inconclusive';

function classifyOpenCodeProbeError(err: unknown): OpenCodeSessionProbe {
  const anyErr = err as { name?: unknown; code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } };
  const haystack = [
    anyErr?.name,
    anyErr?.code,
    anyErr?.message,
    anyErr?.cause?.code,
    anyErr?.cause?.message,
  ].map((v) => String(v ?? '')).join(' ');
  if (/ECONNREFUSED|ConnectionRefused|EHOSTUNREACH|ENETUNREACH|ENOTFOUND/i.test(haystack)) return 'down';
  if (/TimeoutError|timeout|timed out|aborted/i.test(haystack)) return 'inconclusive';
  return 'inconclusive';
}

class OpenCodeObserveConnection implements SessionConnection {
  private readonly handlers = new Set<AgentMessageHandler>();
  private watchers: FSWatcher[] = [];
  private resyncTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly storageRoot: string,
    readonly info: SessionInfo,
  ) {}

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    this.startWatch();
    return () => this.handlers.delete(handler);
  }

  async getHistory(): Promise<AgentMessage[]> {
    this.startWatch();
    return opencodePrivateHistory(this.storageRoot, this.info.id);
  }

  getHistorySourceIdentity(): HistorySourceIdentity | undefined {
    const dataRoot = this.storageRoot ? dirname(this.storageRoot) : '';
    if (!dataRoot || !existsSync(join(dataRoot, 'opencode.db'))) {
      // Legacy directory history has no bounded trustworthy revision probe:
      // fail closed and let the broker perform an authoritative reread.
      return undefined;
    }
    const databasePath = join(dataRoot, 'opencode.db');
    const rewriteToken = openCodeSessionRewriteToken(
      databasePath,
      this.info.id,
    );
    if (rewriteToken === undefined) return undefined;
    return fileSetHistorySourceIdentity([
      databasePath,
      join(dataRoot, 'opencode.db-wal'),
      join(dataRoot, 'opencode.db-shm'),
    ], rewriteToken);
  }

  protected emit(m: AgentMessage): void {
    for (const h of this.handlers) {
      try {
        h(m);
      } catch {
        /* isolate */
      }
    }
  }

  private startWatch(): void {
    if (this.watchers.length || !this.storageRoot) return;
    const messageDir = join(this.storageRoot, 'message', this.info.id);
    const partRoot = join(this.storageRoot, 'part');
    const dataRoot = this.storageRoot ? dirname(this.storageRoot) : '';
    const watchDirs = [
      messageDir,
      partRoot,
      ...opencodeMessageIds(this.storageRoot, this.info.id).map((id) => join(partRoot, id)),
      ...(dataRoot ? [join(dataRoot, 'opencode.db'), join(dataRoot, 'opencode.db-wal'), join(dataRoot, 'opencode.db-shm')] : []),
    ];
    for (const dir of watchDirs) {
      try {
        if (existsSync(dir)) this.watchers.push(watch(dir, () => this.scheduleResync()));
      } catch {
        /* best-effort observe */
      }
    }
  }

  private scheduleResync(): void {
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => {
      for (const w of this.watchers) w.close();
      this.watchers = [];
      this.emit({ type: 'history-reset' });
      this.startWatch();
    }, 150);
  }

  async sendPrompt(_input: PromptInput): Promise<void> {
    throw new Error(`This OpenCode session is read-only in Observe mode. Tap Drive to continue it from ${PRODUCT_IDENTITY.productName}.`);
  }

  async respondPermission(): Promise<void> {
    throw new Error(`This OpenCode session is read-only in Observe mode. Tap Drive to respond from ${PRODUCT_IDENTITY.productName}.`);
  }

  async answerQuestion(): Promise<void> {
    throw new Error(`This OpenCode session is read-only in Observe mode. Tap Drive to answer from ${PRODUCT_IDENTITY.productName}.`);
  }

  async rejectQuestion(): Promise<void> {
    throw new Error(`This OpenCode session is read-only in Observe mode. Tap Drive to answer from ${PRODUCT_IDENTITY.productName}.`);
  }

  async sendFile(_file: FileInput): Promise<void> {
    throw new Error('This OpenCode session is read-only in Observe mode. Tap Drive before uploading files.');
  }

  async close(): Promise<void> {
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
    this.handlers.clear();
  }
}

class OpenCodeRunConnection extends OpenCodeObserveConnection {
  private running?: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

  constructor(
    storageRoot: string,
    private readonly bin: string,
    info: SessionInfo,
  ) {
    super(storageRoot, info);
  }

  override async sendPrompt(input: PromptInput): Promise<void> {
    if (this.running) throw new Error('OpenCode Drive is already running a turn for this session.');
    const filePaths = (input.files ?? []).map((file) => {
      const path = writeInboxFile(this.info.cwd, file);
      if (!path) throw new Error(`OpenCode could not materialize attachment ${file.name}.`);
      return path;
    });
    const startedAt = Date.now();
    const turnId = `drive:${startedAt}`;
    const userKey = `drive:${startedAt}`;
    this.emitRun({ type: 'user-message', text: input.text, key: userKey, turnId, sentAt: startedAt, ...(input.clientMessageId ? { clientKey: input.clientMessageId } : {}) });
    this.emitRun({ type: 'run-summary', key: `opencode:run:${turnId}`, turnId, userMessageKey: userKey, status: 'running', startedAt, source: 'opencode-run' });
    this.emitRun({ type: 'status', status: 'running' });
    const args = ['run', '--session', this.info.id, '--format', 'json'];
    if (this.info.cwd) args.push('--dir', this.info.cwd);
    if (input.model?.providerID && input.model?.modelID) args.push('--model', `${input.model.providerID}/${input.model.modelID}`);
    if (input.agent) args.push('--agent', input.agent);
    for (const path of filePaths) args.push('--file', path);
    if (input.text) args.push(input.text);
    const proc = Bun.spawn([this.bin, ...args], {
      cwd: this.info.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });
    this.running = proc;
    let stderr = '';
    try {
      const stdoutP = this.consumeRunStdout(proc.stdout);
      const stderrP = new Response(proc.stderr).text().then((s) => {
        stderr = s;
        return s;
      });
      const code = await proc.exited;
      await Promise.all([stdoutP, stderrP]);
      const completedAt = Date.now();
      this.emitRun({
        type: 'run-summary',
        key: `opencode:run:${turnId}`,
        turnId,
        userMessageKey: userKey,
        status: code === 0 ? 'done' : 'error',
        startedAt,
        completedAt,
        totalRuntimeMs: Math.max(0, completedAt - startedAt),
        source: 'opencode-run',
      });
      if (code !== 0) this.emitRun({ type: 'error', message: (stderr || `opencode run exited ${code}`).split('\n')[0]!.slice(0, 240) });
    } finally {
      this.running = undefined;
      this.emitRun({ type: 'history-reset' });
      this.emitRun({ type: 'status', status: 'idle' });
    }
  }

  override async respondPermission(): Promise<void> {
    throw new Error(
      'OpenCode private Drive runs `opencode run --format json`, which is non-interactive: ask-permission requests are auto-rejected by OpenCode instead of left pending for the app. Use the shared-server True Sync path for interactive approvals.',
    );
  }

  override async answerQuestion(): Promise<void> {
    throw new Error(
      'OpenCode private Drive cannot answer native OpenCode question prompts; `opencode run --format json` does not expose the interactive question tool in this mode. Use the shared-server True Sync path for interactive questions.',
    );
  }

  override async rejectQuestion(): Promise<void> {
    throw new Error(
      'OpenCode private Drive cannot dismiss native OpenCode question prompts; `opencode run --format json` does not expose the interactive question tool in this mode. Use the shared-server True Sync path for interactive questions.',
    );
  }

  override async sendFile(file: FileInput): Promise<void> {
    await this.sendPrompt({ text: '', files: [file] });
  }

  async listCommands(): Promise<SlashCommand[]> {
    return [{ name: 'stop', description: 'Stop the private Drive turn', kind: 'action' }];
  }

  async runCommand(name: string): Promise<CommandResult | void> {
    if (name !== 'stop' && name !== 'abort') throw new Error(`OpenCode private Drive does not support /${name}.`);
    if (!this.running) return { notice: 'No private Drive turn is running.' };
    this.running.kill();
    return { notice: 'Stopped the private Drive turn.' };
  }

  override async close(): Promise<void> {
    this.running?.kill();
    await super.close();
  }

  private async consumeRunStdout(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        for (const m of messagesFromRunJsonLine(line)) this.emitRun(m);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) for (const m of messagesFromRunJsonLine(buf)) this.emitRun(m);
  }

  private emitRun(m: AgentMessage): void {
    this.emit(m);
  }
}

/**
 * Generate a message id in OpenCode's own ascending format (`Identifier.ascending('message')`):
 * `msg_` + 12 hex chars of the 48-bit big-endian value `Date.now()*4096 + counter` + 14 random
 * base62 chars. `prompt_async` accepts a caller-supplied `messageID` (the TUI uses this for its own
 * sends) — supplying one is the NATIVE app-send correlation handle, so the SSE user echo can be
 * attributed to the exact send by id, never by text. The timestamp encoding must match OpenCode's
 * or the message would sort out of order among native ids.
 */
const OC_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let ocIdLastMs = 0;
let ocIdCounter = 0;
function nativeMessageId(): string {
  const now = Date.now();
  if (now !== ocIdLastMs) {
    ocIdLastMs = now;
    ocIdCounter = 0;
  }
  ocIdCounter++;
  const value = BigInt(now) * 4096n + BigInt(ocIdCounter);
  const time = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) time[i] = Number((value >> BigInt(40 - 8 * i)) & 0xffn);
  const rand = randomBytes(14);
  let suffix = '';
  for (let i = 0; i < 14; i++) suffix += OC_ID_ALPHABET[rand[i]! % 62];
  return `msg_${time.toString('hex')}${suffix}`;
}

class OpenCodeConnection implements SessionConnection {
  private readonly handlers = new Set<AgentMessageHandler>();
  private readonly abort = new AbortController();
  private closed = false;
  private unavailable = false;
  /** messageID → role, learned from message.updated, so part events can be attributed. */
  private readonly msgRole = new Map<string, string>();
  /** messageID → native message creation time, learned from message.updated for user timestamps. */
  private readonly msgCreatedAt = new Map<string, number>();
  /** messageID → first rendered assistant text/reasoning part, for turn-footer ownership. */
  private readonly firstAssistantPart = new Map<string, string>();
  /** Part ids that are streaming via message.part.delta — so the coarse full-text snapshot from
   *  message.part.updated doesn't fight the token deltas (it would re-append the whole text). */
  private readonly streamingParts = new Set<string>();
  /** partID → true part type ('text' | 'reasoning' | …), learned from message.part.updated, which
   *  always precedes the part's deltas. Deltas' own `field` is unreliable (some models label a
   *  reasoning part's deltas field:'text'), so we route deltas by this instead. */
  private readonly partType = new Map<string, string>();
  /** Last-seen session revert pointer (undefined = not reverted), to detect undo/redo changes. */
  private lastRevertId: string | undefined;
  /** Our supplied `prompt_async` messageID → the app send's clientMessageId. Registered BEFORE the
   *  POST (the SSE echo can beat the response), attributed by exact native id — never by text. */
  private readonly appSendClientKeys = new Map<string, string>();
  /** Connection-local assistant rows awaiting, or recently closed by, an authoritative session
   * fence. OpenCode may publish more than one user/assistant boundary before the matching idle, so
   * those boundaries may associate records but can never finalize them. Terminal records remain
   * bounded here so telemetry arriving after the fence can enrich the same stable summary key. */
  private readonly runRecords = new Map<string, OpenCodeRunRecord>();
  /** Latest native user boundary, used only when an assistant row lacks its normal parentID. */
  private latestUserMessageKey?: string;
  /** A fence can precede the final assistant message update (or the entire assistant row). Retain
   * its authoritative outcome until a later user/busy boundary starts another native turn. */
  private pendingTerminalFence?: { status: TerminalRunStatus; userMessageKey?: string };
  /** Point-in-time native session activity, seeded from discovery's /session/status reconciliation. */
  private liveSessionActive: boolean;
  /** One abort surfaces on BOTH session.error and the assistant message.updated error — without a
   *  guard the user reads "Interrupted by user." twice per Stop (issues-part2 item 5 re-flag). */
  private lastInterruptNoticeAt = 0;
  private resolveReady!: () => void;
  /** Resolves once the /event SSE reader is connected (safe to send prompts). */
  readonly ready: Promise<void> = new Promise((r) => (this.resolveReady = r));

  constructor(
    private readonly baseUrl: string,
    readonly info: SessionInfo,
    private readonly sseIdleMs: number,
    private readonly sseReconnectMs: number,
    private readonly loadModels: (
      current?: SessionInfo['currentModel'],
    ) => Promise<ModelOption[]>,
  ) {
    this.liveSessionActive = info.status === 'working' || info.status === 'needs-input';
  }

  private url(path: string): string {
    return this.baseUrl + path;
  }

  /** OpenCode's question/permission reply registries are partitioned by directory — a reply
   *  without the session's directory 404s (QuestionNotFoundError). Scope to this session's cwd. */
  private dirq(): string {
    return this.info.cwd ? `?directory=${encodeURIComponent(this.info.cwd)}` : '';
  }

  /** Emit at most one interruption notice per abort: session.error and the aborted assistant
   *  message's message.updated both report the same user abort within moments of each other. */
  private noticeInterrupted(turnId?: string): void {
    const now = Date.now();
    if (now - this.lastInterruptNoticeAt < 5000) return;
    this.lastInterruptNoticeAt = now;
    const ownedTurnId = turnId
      ?? [...this.runRecords.values()]
        .reverse()
        .find((run) =>
          !run.terminalStatus
          && (!this.latestUserMessageKey
            || run.userMessageKey === this.latestUserMessageKey))
        ?.assistantId;
    this.emit({
      type: 'notice',
      message: 'Interrupted by user.',
      semantic: {
        kind: 'interruption',
        reason: 'user',
        ...(ownedTurnId ? { turnId: ownedTurnId } : {}),
      },
    });
  }

  private noteUserBoundary(info: any): void {
    const id = info?.id ? String(info.id) : undefined;
    if (!id) return;
    // User rows are ownership boundaries, never completion fences. A genuinely new user after a
    // retained terminal fence starts the next run and prevents that old fence from claiming it.
    const pending = this.pendingTerminalFence;
    if (pending) {
      pending.userMessageKey ??= id;
      if (pending.userMessageKey === id) {
        // This can be the delayed user echo for a fence already seen on the server-wide stream.
        // Associate it without resurrecting a running session.
        this.latestUserMessageKey = id;
        return;
      }
      this.pendingTerminalFence = undefined;
    }
    if ([...this.runRecords.values()].some((run) =>
      run.terminalStatus && run.userMessageKey === id)) {
      this.latestUserMessageKey = id;
      return;
    }
    this.latestUserMessageKey = id;
    this.liveSessionActive = true;
  }

  private bufferAssistantRun(
    info: any,
    opts: {
      userMessageKey?: string;
      fallbackStartedAt?: number;
      assistantMessageKey?: string;
      emitRunning?: boolean;
    } = {},
  ): RunSummaryMessage | undefined {
    if (!info || info.role !== 'assistant' || !info.id) return undefined;
    const assistantId = String(info.id);
    let run = this.runRecords.get(assistantId);
    const isNewRun = !run;
    const userMessageKey = opts.userMessageKey
      ?? (info.parentID ? String(info.parentID) : undefined)
      ?? run?.userMessageKey
      ?? this.latestUserMessageKey;

    if (!run) {
      run = {
        assistantId,
        info,
        userMessageKey,
        assistantMessageKey: opts.assistantMessageKey ?? this.firstAssistantPart.get(assistantId),
        fallbackStartedAt: opts.fallbackStartedAt,
        runningEmitted: false,
      };
      this.runRecords.set(assistantId, run);
      this.enforceRunRecordLimit();
    } else {
      run.info = mergeOpenCodeMessageInfo(run.info, info);
      run.userMessageKey = userMessageKey ?? run.userMessageKey;
      run.assistantMessageKey =
        opts.assistantMessageKey
        ?? this.firstAssistantPart.get(assistantId)
        ?? run.assistantMessageKey;
      run.fallbackStartedAt =
        run.fallbackStartedAt
        ?? opts.fallbackStartedAt;
    }

    if (run.terminalStatus) {
      this.emitTerminalRun(run);
      return undefined;
    }

    const pending = this.pendingTerminalFence;
    if (pending) {
      pending.userMessageKey ??= run.userMessageKey;
      if (
        !pending.userMessageKey
        || !run.userMessageKey
        || pending.userMessageKey === run.userMessageKey
      ) {
        // The fence arrived before this owned assistant row. Consume it exactly once; the terminal
        // record itself, not a lingering fence, accepts any later telemetry enrichment.
        this.pendingTerminalFence = undefined;
        this.latestUserMessageKey = run.userMessageKey ?? this.latestUserMessageKey;
        this.finalizeRun(run, pending.status);
        return undefined;
      }
      // A different owner proves this is a later run. Discard the stale fence and keep the new row
      // running until it receives its own authoritative terminal transition.
      this.pendingTerminalFence = undefined;
    }

    if (isNewRun && run.userMessageKey) {
      // An assistant can precede its user/busy echo on the global bus. Its explicit parent is then
      // the best current ownership boundary for the eventual authoritative fence.
      this.latestUserMessageKey = run.userMessageKey;
    }
    this.liveSessionActive = true;
    const running = runSummaryFromOpenCodeMessage(run.info, {
      userMessageKey: run.userMessageKey,
      fallbackStartedAt: run.fallbackStartedAt,
      assistantMessageKey: run.assistantMessageKey,
      status: 'running',
    });
    if (running && opts.emitRunning !== false && !run.runningEmitted) {
      run.runningEmitted = true;
      this.emit(running);
    }
    return running;
  }

  private inferredTerminalStatus(run: OpenCodeRunRecord): TerminalRunStatus {
    const inferred = openCodeRunStatus(run.info);
    return inferred === 'running' ? 'done' : inferred;
  }

  private emitTerminalRun(run: OpenCodeRunRecord): RunSummaryMessage | undefined {
    if (!run.terminalStatus) return undefined;
    const summary = runSummaryFromOpenCodeMessage(run.info, {
      userMessageKey: run.userMessageKey,
      fallbackStartedAt: run.fallbackStartedAt,
      assistantMessageKey: run.assistantMessageKey ?? this.firstAssistantPart.get(run.assistantId),
      status: run.terminalStatus,
    });
    if (
      summary
      && JSON.stringify(summary) !== JSON.stringify(run.lastTerminalSummary)
    ) {
      run.lastTerminalSummary = summary;
      this.emit(summary);
    }
    return summary;
  }

  private finalizeRun(
    run: OpenCodeRunRecord,
    status: TerminalRunStatus,
  ): RunSummaryMessage | undefined {
    run.terminalStatus ??= status;
    return this.emitTerminalRun(run);
  }

  private enforceRunRecordLimit(): void {
    while (this.runRecords.size > OPENCODE_RUN_RECORD_LIMIT) {
      let evictionId: string | undefined;
      for (const [assistantId, run] of this.runRecords) {
        if (!run.terminalStatus) continue;
        evictionId = assistantId;
        break;
      }
      // If every entry is unresolved, discard the oldest optional footer record. Losing that
      // telemetry is safer than inventing completion or allowing connection memory to grow.
      evictionId ??= this.runRecords.keys().next().value;
      if (!evictionId) break;
      this.runRecords.delete(evictionId);
    }
  }

  private runMatchesUser(run: OpenCodeRunRecord, userMessageKey?: string): boolean {
    return userMessageKey
      ? run.userMessageKey === userMessageKey
      : true;
  }

  private hasAssistantRecordForUser(userMessageKey?: string): boolean {
    for (const run of this.runRecords.values()) {
      if (this.runMatchesUser(run, userMessageKey)) return true;
    }
    return false;
  }

  private finalizeBufferedRuns(
    status: TerminalRunStatus,
    userMessageKey?: string,
  ): void {
    const pending = [...this.runRecords.values()].filter((run) => !run.terminalStatus);
    let errorTarget: OpenCodeRunRecord | undefined;
    if (status === 'error' || status === 'cancelled') {
      errorTarget = [...pending].reverse().find((run) =>
        this.runMatchesUser(run, userMessageKey));
    }
    for (const run of pending) {
      const finalStatus =
        status === 'done'
          ? this.inferredTerminalStatus(run)
          : run === errorTarget
            ? status
            : this.inferredTerminalStatus(run);
      this.finalizeRun(run, finalStatus);
    }
    this.enforceRunRecordLimit();
  }

  private fenceTerminal(status: TerminalRunStatus): void {
    const previousFence = this.pendingTerminalFence;
    const fenceUserMessageKey =
      previousFence?.userMessageKey
      ?? this.latestUserMessageKey;
    const hadActiveSession = this.liveSessionActive;
    const hadMatchingAssistant = this.hasAssistantRecordForUser(fenceUserMessageKey);
    this.liveSessionActive = false;
    this.pendingTerminalFence = undefined;
    // Status first: a client never observes terminal footer data while its authoritative session
    // state is still Working.
    this.emit({ type: 'status', status: 'idle' });
    this.finalizeBufferedRuns(status, fenceUserMessageKey);
    // Retain a one-shot fence only when the terminal transition had no matching assistant identity
    // to finalize. Existing terminal records are sufficient for late message enrichment.
    this.pendingTerminalFence =
      !hadMatchingAssistant
      && (hadActiveSession || !!previousFence || status !== 'done')
      ? {
          status,
          userMessageKey: fenceUserMessageKey,
        }
      : undefined;
  }

  private fenceIdle(): void {
    this.fenceTerminal(this.pendingTerminalFence?.status ?? 'done');
  }

  private emit(message: AgentMessage): void {
    for (const h of this.handlers) {
      try {
        h(message);
      } catch {
        /* isolate handler errors */
      }
    }
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async getHistory(): Promise<AgentMessage[]> {
    const res = await fetch(this.url(`/session/${this.info.id}/message`), {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    let rows = (await res.json()) as Array<{ info: any; parts: any[] }>;
    // Apply the session's revert pointer: messages from `revert.messageID` onward are hidden
    // (OpenCode still returns them from /message; the TUI and we must drop them). Seeding
    // lastRevertId here also stops the first session.updated from firing a spurious resync.
    const revertId = await this.fetchRevertId();
    this.lastRevertId = revertId;
    if (revertId) {
      const cut = rows.findIndex((r) => r.info?.id === revertId);
      if (cut >= 0) rows = rows.slice(0, cut);
    }
    const out: AgentMessage[] = [];
    let lastUserKey: string | undefined;
    let lastUserAt: number | undefined;
    const runSummaries: AgentMessage[] = [];
    let activeAssistantIndex = -1;
    if (this.liveSessionActive) {
      let latestUserIndex = -1;
      let latestUserId: string | undefined;
      for (let index = rows.length - 1; index >= 0; index--) {
        if (rows[index]?.info?.role === 'user') {
          latestUserIndex = index;
          latestUserId = rows[index]?.info?.id
            ? String(rows[index]!.info.id)
            : undefined;
          break;
        }
      }
      // Busy is session state, not proof that the last durable assistant row is the active one.
      // Only an assistant after, and owned by, the latest user can be demoted to running. If that
      // user has no assistant yet, every older durable completion remains historical truth.
      for (let index = rows.length - 1; index > latestUserIndex && latestUserIndex >= 0; index--) {
        const info = rows[index]?.info;
        if (
          info?.role === 'assistant'
          && latestUserId
          && info.parentID
          && String(info.parentID) === latestUserId
        ) {
          activeAssistantIndex = index;
          break;
        }
      }
    }
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]!;
      let rowInfo = row.info;
      const role = rowInfo?.role;
      if (role === 'user') {
        const text = (row.parts ?? [])
          .filter((p) => p?.type === 'text')
          .map((p) => p.text)
          .join('\n')
          .trim();
        // key by message id so the history bubble and any live echo dedupe into one.
        const sentAt = nativeTimeMs(row.info?.time?.created);
        const clientKey = row.info?.id ? this.appSendClientKeys.get(String(row.info.id)) : undefined;
        if (text) out.push({ type: 'user-message', text, key: row.info?.id, turnId: row.info?.id, sentAt, ...(clientKey ? { clientKey } : {}) });
        lastUserKey = row.info?.id ? String(row.info.id) : lastUserKey;
        lastUserAt = sentAt ?? lastUserAt;
      } else {
        const recordedRun = this.runRecords.get(String(rowInfo?.id ?? ''));
        if (recordedRun) {
          // A live authoritative fence outranks an older durable row. Merge in that direction so
          // cached terminal status/telemetry can never regress to raw-history running state.
          recordedRun.info = mergeOpenCodeMessageInfo(rowInfo, recordedRun.info);
          recordedRun.userMessageKey =
            recordedRun.userMessageKey
            ?? (rowInfo?.parentID ? String(rowInfo.parentID) : lastUserKey);
          recordedRun.assistantMessageKey =
            recordedRun.assistantMessageKey
            ?? firstAssistantPartKey(row.parts);
          recordedRun.fallbackStartedAt ??= lastUserAt;
          rowInfo = recordedRun.info;
        }
        for (const part of row.parts ?? []) out.push(...mapPart(part, true));
        // Surface a turn-level error recorded on a historical assistant row (mirrors the live
        // message.updated path) so a failed past turn isn't a silent gap on reattach.
        if (rowInfo?.error) {
          const e = rowInfo.error;
          const msg = e.data?.message ?? e.message ?? e.name ?? 'Turn failed';
          out.push({ type: 'error', message: (String(msg).split('\n')[0] ?? '').slice(0, 200) });
        }
        const summaryOpts = {
          userMessageKey:
            recordedRun?.userMessageKey
            ?? (rowInfo?.parentID ? String(rowInfo.parentID) : lastUserKey),
          fallbackStartedAt: recordedRun?.fallbackStartedAt ?? lastUserAt,
          assistantMessageKey:
            recordedRun?.assistantMessageKey
            ?? firstAssistantPartKey(row.parts),
        };
        const active = rowIndex === activeAssistantIndex && !recordedRun?.terminalStatus;
        // The durable row can already contain time.completed while /session/status still says Busy.
        // Buffer its full native telemetry, but return only a running projection. A live event that
        // raced ahead of this history fetch wins and must never be replaced by the older snapshot.
        if (
          active &&
          (!recordedRun || !recordedRun.terminalStatus)
        ) {
          this.bufferAssistantRun(rowInfo, { ...summaryOpts, emitRunning: false });
        }
        const summaryStatus =
          recordedRun?.terminalStatus
          ?? (recordedRun || active ? 'running' : undefined);
        const summary = runSummaryFromOpenCodeMessage(rowInfo, {
          ...summaryOpts,
          ...(summaryStatus ? { status: summaryStatus } : {}),
        });
        if (summary) {
          out.push(summary);
          runSummaries.push(summary);
        }
      }
      const tok = rowInfo?.tokens;
      if (tok) {
        out.push({
          type: 'token-count',
          input: tok.input,
          output: tok.output,
          cacheRead: tok.cache?.read,
          cacheWrite: tok.cache?.write,
          cost: rowInfo?.cost,
        });
      }
    }
    this.latestUserMessageKey = lastUserKey ?? this.latestUserMessageKey;
    const totals = runtimeTotalsFromRunSummaries(runSummaries, 'opencode');
    if (totals) out.push(totals);
    // Surface any request that is pending RIGHT NOW as a card, so a question/permission asked
    // before we attached renders interactively (history alone only has the raw tool part).
    out.push(...(await this.fetchPending()));
    return out;
  }

  async getHistorySourceIdentity(): Promise<HistorySourceIdentity | undefined> {
    try {
      const response = await fetch(
        this.url(`/session/${this.info.id}${this.dirq()}`),
        { signal: AbortSignal.timeout(3000) },
      );
      if (!response.ok) return undefined;
      const session = await response.json() as any;
      const updated = Number(session?.time?.updated);
      const revert = String(session?.revert?.messageID ?? '');
      return {
        sourceId: `opencode-http:${this.info.id}`,
        revision: JSON.stringify({
          id: session?.id,
          updated: Number.isFinite(updated) ? updated : null,
          revert,
        }),
        ...(Number.isFinite(updated) ? { appendPosition: updated } : {}),
        rewriteToken: revert,
      };
    } catch {
      return undefined;
    }
  }

  /** The session's current revert pointer (messageID), or undefined if not reverted. */
  private async fetchRevertId(): Promise<string | undefined> {
    try {
      const r = await fetch(this.url(`/session/${this.info.id}${this.dirq()}`), { signal: AbortSignal.timeout(3000) });
      if (r.ok) return (await r.json())?.revert?.messageID;
    } catch {
      /* server gone */
    }
    return undefined;
  }

  /** Pending questions + permissions for this session, as interactive cards (for on-attach replay). */
  private async fetchPending(): Promise<AgentMessage[]> {
    const out: AgentMessage[] = [];
    try {
      const r = await fetch(this.url(`/question${this.dirq()}`), { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        for (const q of ((await r.json()) as any[]) ?? []) {
          if (q?.sessionID && q.sessionID !== this.info.id) continue;
          out.push({
            type: 'question-request',
            requestId: q.id,
            questions: (q.questions ?? []).map((x: any) => ({
              question: x?.question ?? '',
              header: x?.header,
              options: (x?.options ?? []).map((o: any) => ({ label: o?.label, description: o?.description })),
              multiple: !!(x?.multiple ?? x?.multi),
            })),
          });
        }
      }
    } catch {
      /* none / server gone */
    }
    try {
      const r = await fetch(this.url(`/permission${this.dirq()}`), { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        for (const p of ((await r.json()) as any[]) ?? []) {
          if (p?.sessionID && p.sessionID !== this.info.id) continue;
          out.push({
            type: 'permission-request',
            requestId: p.id,
            title: p.permission ?? 'Permission request',
            detail: Array.isArray(p.patterns) ? p.patterns.join(', ') : undefined,
            options: ['approve', 'approve-session', 'reject'],
          });
        }
      }
    } catch {
      /* none */
    }
    return out;
  }

  /** Begin consuming the SSE event bus, filtered to this session. */
  start(): void {
    void this.loop();
  }

  private async loop(): Promise<void> {
    // Subscribe to the SERVER-WIDE event bus and filter by sessionID below. We deliberately
    // avoid the directory-scoped GET /event: it silently streams nothing when the session's
    // directory is unknown or doesn't exactly match the server's partition key (a 200 with no
    // events — a dead stream that looks healthy). sessionID is globally unique, so /global/event
    // is always correct regardless of cwd. Note /global/event wraps each event under a `payload`
    // envelope — unwrapped in handleEvent().
    let reconnectUntil = 0;
    while (!this.closed) {
      const streamAbort = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const parentAbort = () => streamAbort.abort();
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          streamAbort.abort();
        }, this.sseIdleMs);
      };
      this.abort.signal.addEventListener('abort', parentAbort, { once: true });
      try {
        resetIdle();
        const res = await fetch(this.url('/global/event'), { signal: streamAbort.signal });
        this.resolveReady();
        if (!res.ok || !res.body) throw new Error(`OpenCode SSE failed: ${res.status}`);
        reconnectUntil = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) throw new Error('OpenCode SSE stream ended');
          resetIdle();
          buf += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            try {
              this.handleEvent(JSON.parse(dataLine.slice(5).trim()));
            } catch {
              /* skip malformed frame */
            }
          }
        }
      } catch (err) {
        this.resolveReady(); // never leave attach hanging on a failed SSE connect
        if (this.closed) return;
        const now = Date.now();
        if (reconnectUntil === 0) reconnectUntil = now + this.sseReconnectMs;
        const probe = await this.probeSession();
        if (probe === 'exists') {
          await delay(Math.min(500, Math.max(50, this.sseReconnectMs)));
          continue;
        }
        if (probe === 'inconclusive' && now <= reconnectUntil) {
          await delay(250);
          continue;
        }
        this.markUnavailable('OpenCode shared server disconnected. This session is now read-only until the server is reachable again.');
        return;
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        this.abort.signal.removeEventListener('abort', parentAbort);
      }
    }
  }

  private async probeSession(): Promise<OpenCodeSessionProbe> {
    try {
      const res = await fetch(this.url(`/session/${this.info.id}${this.dirq()}`), { signal: AbortSignal.timeout(1500) });
      if (res.ok) return 'exists';
      if (res.status === 404 || res.status === 410) return 'missing';
      if (res.status >= 500) return 'inconclusive';
      return 'missing';
    } catch (err) {
      return classifyOpenCodeProbeError(err);
    }
  }

  private markUnavailable(message: string, controlReason?: string): void {
    if (this.unavailable) return;
    this.unavailable = true;
    this.info.status = 'idle';
    this.info.attachMode = 'observe';
    this.info.control = opencodeDisconnectedControlState(controlReason);
    this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: this.info.status, attachMode: this.info.attachMode, control: this.info.control } });
    this.emit({ type: 'error', message });
  }

  private handleEvent(raw: { type?: string; properties?: any; payload?: any }): void {
    // /global/event wraps the real event under `payload` (alongside directory/project); the
    // directory-scoped /event delivers it unwrapped. Tolerate both shapes.
    const ev = raw.payload ?? raw;
    const p = ev.properties ?? {};
    switch (ev.type) {
      case 'message.part.delta': {
        // Token-level streaming. OpenCode fires ~1 of these per token (and only a couple of the
        // coarse message.part.updated snapshots), so handling deltas is what makes our stream as
        // smooth as the TUI instead of arriving paragraph-by-paragraph.
        if (p.sessionID !== this.info.id) return;
        const partId: string | undefined = p.partID;
        if (!partId || p.delta == null) return;
        if (this.msgRole.get(p.messageID) === 'user') return; // user prompts aren't generated
        this.streamingParts.add(partId);
        // Route by the part's TRUE type (from message.part.updated), not the delta's `field` —
        // some models stream a reasoning part's deltas as field:'text', which would dump the
        // chain-of-thought into the answer bubble.
        const type = this.partType.get(partId) ?? (p.field === 'reasoning' ? 'reasoning' : 'text');
        if (type === 'reasoning') this.emit({ type: 'thinking', delta: String(p.delta), key: partId });
        else this.emit({ type: 'model-output', delta: String(p.delta), key: partId });
        return;
      }
      case 'message.part.updated': {
        if (p.sessionID !== this.info.id) return;
        const part = p.part;
        if (part?.id && part?.type) this.partType.set(part.id, part.type); // for delta routing (above)
        // The server echoes the user's OWN prompt as a text part too; without role-awareness
        // it would render as assistant output on the left (and CLI prompts would never show as
        // a user bubble). Attribute by messageID and emit user prompts as user-message instead.
        const role = part?.messageID ? this.msgRole.get(part.messageID) : undefined;
        if (
          part?.messageID &&
          part?.id &&
          (part.type === 'text' || part.type === 'reasoning') &&
          role !== 'user' &&
          !this.firstAssistantPart.has(String(part.messageID))
        ) {
          const messageId = String(part.messageID);
          this.firstAssistantPart.set(messageId, String(part.id));
          const run = this.runRecords.get(messageId);
          if (run && !run.assistantMessageKey) {
            run.assistantMessageKey = String(part.id);
            if (run.terminalStatus) this.emitTerminalRun(run);
          }
        }
        if (role === 'user') {
          if (part?.type === 'text' && part.text) {
            const clientKey = part.messageID ? this.appSendClientKeys.get(String(part.messageID)) : undefined;
            this.emit({
              type: 'user-message',
              text: part.text,
              key: part.messageID,
              turnId: part.messageID,
              sentAt: part.messageID ? this.msgCreatedAt.get(String(part.messageID)) : undefined,
              ...(clientKey ? { clientKey } : {}),
            });
          }
          return;
        }
        // A text/reasoning part that's streaming via deltas is already being appended token-by-token;
        // don't also emit the full-text snapshot (the app would append it on top → duplicated text).
        if ((part?.type === 'text' || part?.type === 'reasoning') && this.streamingParts.has(part.id)) return;
        for (const m of mapPart(part, false)) this.emit(m);
        return;
      }
      case 'session.status': {
        if (p.sessionID !== this.info.id) return;
        const stType = p.status?.type;
        if (stType === 'retry') {
          // The API call is failing (connection refused / 429 rate-limit / 5xx) and opencode is
          // retrying. Keep the turn 'running' (it is NOT done — mapping to 'idle' made the app look
          // silently stalled and flap) and surface the reason + attempt so the app can warn.
          this.liveSessionActive = true;
          this.pendingTerminalFence = undefined;
          const detail = normalizeOpenCodeRetryDetail(p.status?.message, p.status?.attempt);
          this.emit({ type: 'status', status: 'running', detail });
        } else if (stType === 'busy') {
          this.liveSessionActive = true;
          this.pendingTerminalFence = undefined;
          this.emit({ type: 'status', status: 'running' });
        } else if (stType === 'idle') {
          this.fenceIdle();
        }
        return;
      }
      case 'session.idle': {
        if (p.sessionID !== this.info.id) return;
        this.fenceIdle();
        return;
      }
      case 'session.updated': {
        // Detect undo/redo: OpenCode keeps a session-level `revert` pointer (messages from it
        // onward are hidden); `/message` still returns them, so the app must apply the pointer.
        // Fires for revert AND unrevert, from the CLI or our own /undo — one path covers all.
        const info = p.info;
        if (info?.id !== this.info.id) return;
        const currentModel = currentModelOf(info);
        if (currentModel) {
          this.info.currentModel = currentModel;
          this.info.model = info.model?.id ?? info.model?.modelID ?? currentModel.modelID;
        }
        // The snapshot also carries the session-level agent — keep the app's mode pill in sync
        // even when the dedicated switch event predates this connection or was missed.
        this.noteCurrentAgent(info.agent);
        const rev: string | undefined = info.revert?.messageID;
        if (rev !== this.lastRevertId) {
          const wasReverted = !!this.lastRevertId;
          this.lastRevertId = rev;
          const notice = rev
            ? 'Reverted to an earlier message — /redo to restore'
            : wasReverted
              ? 'Restored the reverted messages'
              : undefined;
          // Re-push the revert-filtered history to every client (vanishes/restores the bubbles).
          this.emit({
            type: 'history-reset',
            notice,
            ...(notice ? { semantic: { kind: 'rollback' as const } } : {}),
          });
        }
        if (currentModel) this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { currentModel, model: this.info.model } });
        return;
      }
      case 'session.next.agent.switched': {
        // Fired for EVERY session-level agent switch — ours (setAgent) and the terminal TUI's —
        // so a Tab-switch in the terminal flips the app's mode pill too.
        if (p.sessionID !== this.info.id) return;
        this.noteCurrentAgent(p.agent);
        return;
      }
      case 'session.deleted': {
        const id = p.sessionID ?? p.id ?? p.session?.id;
        if (id !== this.info.id) return;
        this.markUnavailable('OpenCode session was deleted. This session is now read-only until it is reopened.', 'This OpenCode session was deleted. Reopen or create another session before sending input.');
        return;
      }
      case 'session.error': {
        // A turn failed asynchronously (e.g. a bogus model/agent — prompt_async 204s but the run
        // errors later). Without surfacing this the user gets total silence. Show the message.
        // /global/event is server-wide. Missing or different session identity is never allowed to
        // finalize this connection's buffered run.
        if (p.sessionID !== this.info.id) return;
        const err = p.error ?? {};
        const msg = err.data?.message ?? err.message ?? err.name ?? 'Session error';
        const terminalStatus: 'error' | 'cancelled' = isOpenCodeCancellation(err)
          ? 'cancelled'
          : 'error';
        // A user abort is an outcome, not a failure — align with codex/claude interruption notices
        // (issues-part2 "conversation interruption" check).
        if (terminalStatus === 'cancelled') {
          this.noticeInterrupted();
        } else {
          this.emit({ type: 'error', message: (String(msg).split('\n')[0] ?? '').slice(0, 200) });
        }
        this.liveSessionActive = false;
        this.fenceTerminal(terminalStatus);
        return;
      }
      case 'message.updated': {
        if (p.sessionID !== this.info.id) return;
        if (p.info?.id && p.info?.role) this.msgRole.set(p.info.id, p.info.role);
        if (p.info?.id) {
          const createdAt = nativeTimeMs(p.info?.time?.created);
          if (createdAt) this.msgCreatedAt.set(String(p.info.id), createdAt);
        }
        if (p.info?.role === 'user') this.noteUserBoundary(p.info);
        const tok = p.info?.tokens;
        if (tok) {
          this.emit({
            type: 'token-count',
            input: tok.input,
            output: tok.output,
            cacheRead: tok.cache?.read,
            cacheWrite: tok.cache?.write,
            cost: p.info?.cost,
          });
        }
        // A turn-level error on the assistant message (output-length limit, provider-auth failure,
        // etc.) is otherwise silently dropped — surface it as a one-line error (same flattening as
        // session.error). Emitted before the idle below so the failure reads as the turn's outcome.
        if (p.info?.role === 'assistant' && p.info?.error) {
          const e = p.info.error;
          const msg = e.data?.message ?? e.message ?? e.name ?? 'Turn failed';
          if (/abort/i.test(String(e.name ?? '') + String(msg))) {
            this.noticeInterrupted(
              p.info?.id ? String(p.info.id) : undefined,
            );
          }
          else this.emit({ type: 'error', message: (String(msg).split('\n')[0] ?? '').slice(0, 200) });
        }
        if (p.info?.role === 'assistant') {
          this.bufferAssistantRun(p.info, {
            userMessageKey: p.info?.parentID
              ? String(p.info.parentID)
              : undefined,
            assistantMessageKey: p.info?.id
              ? this.firstAssistantPart.get(String(p.info.id))
              : undefined,
          });
        }
        return;
      }
      case 'permission.asked':
      case 'permission.v2.asked': {
        const req = p.id ? p : (p.permission ?? p.request ?? p);
        if (req?.sessionID && req.sessionID !== this.info.id) return;
        // v2 has NO `permission`/`patterns` fields (that's the legacy shape) — it carries `action` +
        // `resources`. Reading the legacy fields for a v2 event produced a blank/generic title. Branch.
        const isV2 = ev.type === 'permission.v2.asked';
        const title = isV2
          ? String(req?.action ?? req?.title ?? 'Permission request')
          : String(req?.permission ?? p.title ?? 'Permission request');
        const detail = isV2
          ? ((req?.resources ?? []).join(', ') || undefined)
          : ((req?.patterns ?? []).length ? (req.patterns as string[]).join(', ') : undefined);
        this.emit({
          type: 'permission-request',
          requestId: req?.id ?? p.requestID ?? '',
          title,
          detail,
          options: ['approve', 'approve-session', 'reject'],
        });
        return;
      }
      case 'permission.replied':
      case 'permission.v2.replied': {
        if (p.sessionID !== this.info.id) return;
        this.emit({
          type: 'permission-resolved',
          requestId: p.requestID ?? '',
          decision: p.reply === 'reject' ? 'reject' : p.reply === 'always' ? 'approve-session' : 'approve',
        });
        return;
      }
      case 'question.asked':
      case 'question.v2.asked': {
        // v2 shares the same payload shape (id ^que, questions[].{question,header,options,multiple}),
        // so it falls through here — without it a v2 question never renders a card.
        if (p.sessionID && p.sessionID !== this.info.id) return;
        this.emit({
          type: 'question-request',
          requestId: p.id ?? '',
          questions: (p.questions ?? []).map((q: any) => ({
            question: q?.question ?? '',
            header: q?.header,
            options: (q?.options ?? []).map((o: any) => ({ label: o?.label, description: o?.description })),
            multiple: !!(q?.multiple ?? q?.multi),
          })),
        });
        return;
      }
      case 'question.replied':
      case 'question.rejected':
      case 'question.v2.replied':
      case 'question.v2.rejected': {
        // v2 resolution falls through too — without it a legacy/answered card never clears (stuck
        // needs-input). requestID for replied/rejected; id for the asked echo.
        if (p.sessionID && p.sessionID !== this.info.id) return;
        this.emit({ type: 'question-resolved', requestId: p.id ?? p.requestID ?? '' });
        return;
      }
      case 'session.compacted': {
        // After /compact the conversation is summarized; without surfacing this the user gets the
        // 'Compacting…' banner but no completion. Reload the (now-compacted) history + a notice.
        // Strict guard (match message.removed): a frame with no sessionID must NOT reset every session.
        if (p.sessionID !== this.info.id) return;
        // Compaction may return `continue` and immediately resume the same turn. It is neither a
        // session-status transition nor a run-completion fence.
        this.emit({
          type: 'history-reset',
          notice: 'Compacted the conversation.',
          semantic: { kind: 'compaction' },
        });
        return;
      }
      case 'message.removed':
      case 'message.part.removed': {
        // A message/part was deleted server-side (or via the CLI). Re-pull and re-push the whole
        // history so the deletion propagates to live clients (history-reset is the only way bubbles
        // can DISAPPEAR); reuse the existing end-to-end history-reset path — no core/app/gate change.
        if (p.sessionID !== this.info.id) return;
        this.emit({ type: 'history-reset' });
        return;
      }
      default:
        return;
    }
  }

  async sendPrompt(input: PromptInput): Promise<void> {
    if (this.info.attachMode === 'observe' || this.info.control?.drive.state === 'unavailable') {
      throw new Error(this.info.control?.drive.reason ?? 'OpenCode session is read-only because the shared server connection is unavailable.');
    }
    let text = input.text;
    // Attachments: write each to the workspace inbox and reference them by ABSOLUTE path so the
    // agent reads them — all in THIS turn, alongside the user's text (multi-file + file+prompt).
    if (input.files?.length) {
      const refs = input.files.map((f) => {
        const abs = this.writeInboxFile(f);
        return `- ${f.name} (${f.mimeType}) → \`${abs}\``;
      });
      const note = `Attached file(s) — read them from these paths:\n${refs.join('\n')}`;
      text = text.trim() ? `${text}\n\n${note}` : note;
    }
    const parts: any[] = [{ type: 'text', text }];
    // User-uploaded images ride along as native file parts (data URLs) — OpenCode reads them.
    for (const img of input.images ?? []) {
      parts.push({ type: 'file', mime: img.mimeType, filename: img.name ?? 'image', url: `data:${img.mimeType};base64,${img.data}` });
    }
    const body: any = { parts };
    if (input.model) {
      // OpenCode's HTTP schema keeps variant as a sibling of model, not inside model.
      // Contract: docs/protocol/adapter-support.md
      body.model = { providerID: input.model.providerID, modelID: input.model.modelID };
      if (input.model.variant) body.variant = input.model.variant;
    }
    if (input.agent) body.agent = input.agent; // per-prompt agent/mode (build/plan)
    // Native app-send correlation: supply the user message's id ourselves (the TUI does the same),
    // registered BEFORE the POST because the SSE echo can arrive before the 204. The id is unique,
    // so an early registration can never claim a terminal-typed echo.
    let messageID: string | undefined;
    if (input.clientMessageId) {
      messageID = nativeMessageId();
      body.messageID = messageID;
      this.appSendClientKeys.set(messageID, input.clientMessageId);
      while (this.appSendClientKeys.size > 64) {
        this.appSendClientKeys.delete(this.appSendClientKeys.keys().next().value!);
      }
    }
    const res = await fetch(this.url(`/session/${this.info.id}/prompt_async`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (messageID) this.appSendClientKeys.delete(messageID); // rejected send never materializes
      throw new Error(`opencode prompt ${res.status}: ${await safeText(res)}`);
    }
  }

  /** OpenCode's exact model roster, grouped-friendly label "provider · name" (the UI filters/searches).
   *  Do not filter on capabilities.tools: users can intentionally run non-tool/custom models, and
   *  hiding them makes true-sync model switching diverge from the TUI.
   *  Contract: docs/protocol/adapter-support.md */
  async listModels(): Promise<ModelOption[]> {
    return this.loadModels(this.info.currentModel);
  }

  /** Primary (user-selectable) agents/modes — build, plan, etc. Internal ones (compaction/
   *  summary/title) carry no description, so filtering on a description drops them. */
  async listAgents(): Promise<AgentOption[]> {
    try {
      const r = await fetch(this.url('/agent'), { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return [];
      const list = ((await r.json()) ?? []) as any[];
      return list
        .filter((a) => a?.name && a?.mode === 'primary' && a?.description)
        .map((a) => ({ name: a.name, description: a.description }));
    } catch {
      return [];
    }
  }

  /** Switch the session's active agent/mode for subsequent turns (native v2 switchAgent — a
   *  no-turn 204). The optimistic `currentAgent` push keeps the app's pill honest immediately;
   *  the server's own `session.next.agent.switched` event (also fired for TUI-side switches)
   *  re-confirms it authoritatively. */
  async setAgent(agent: string): Promise<void> {
    if (this.info.attachMode === 'observe' || this.info.control?.drive.state === 'unavailable') {
      throw new Error(this.info.control?.drive.reason ?? 'OpenCode session is read-only because the shared server connection is unavailable.');
    }
    const res = await fetch(this.url(`/api/session/${this.info.id}/agent`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent }),
    });
    // Status-only error: native failure bodies can carry runtime-owned detail (same hygiene as rename).
    if (!res.ok) throw new Error(`opencode set agent failed (${res.status})`);
    this.noteCurrentAgent(agent);
  }

  /** Record + broadcast the session's active agent when it actually changed (setAgent above, the
   *  SSE `session.next.agent.switched` event, or a `session.updated` snapshot carrying `agent`). */
  private noteCurrentAgent(agent: unknown): void {
    if (typeof agent !== 'string' || !agent || agent === this.info.currentAgent) return;
    this.info.currentAgent = agent;
    this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { currentAgent: agent } });
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    const reply = decision === 'reject' ? 'reject' : decision === 'approve-session' ? 'always' : 'once';
    const res = await fetch(this.url(`/permission/${requestId}/reply${this.dirq()}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reply }),
    });
    if (!res.ok) throw new Error(`opencode permission reply ${res.status}: ${await safeText(res)}`);
  }

  async answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    // answers: one array of selected labels per question (custom text is just a label).
    const res = await fetch(this.url(`/question/${requestId}/reply${this.dirq()}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    if (!res.ok) throw new Error(`opencode question reply ${res.status}: ${await safeText(res)}`);
  }

  async rejectQuestion(requestId: string): Promise<void> {
    const res = await fetch(this.url(`/question/${requestId}/reject${this.dirq()}`), { method: 'POST' });
    if (!res.ok) throw new Error(`opencode question reject ${res.status}: ${await safeText(res)}`);
  }

  async listCommands(): Promise<SlashCommand[]> {
    let templates: SlashCommand[] = [];
    try {
      const res = await fetch(this.url('/command'), { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const list = (await res.json()) as any[];
        templates = (Array.isArray(list) ? list : [])
          .filter((c) => typeof c?.name === 'string' && c.name.trim() && !/[\r\n]/.test(c.name))
          .map((c) => ({ name: c.name, description: c.description, kind: 'prompt' as const }));
      }
    } catch {
      /* server gone / no commands */
    }
    return [...BUILTIN_ACTIONS, ...templates];
  }

  async runCommand(name: string, args?: string): Promise<CommandResult | void> {
    const sid = this.info.id;
    const post = (path: string, body?: unknown) =>
      fetch(this.url(path), {
        method: 'POST',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    switch (name) {
      case 'compact': {
        // V2 /api/session/{id}/compact is dormant (503); use v1 summarize with the session's model.
        let model: any;
        try {
          const sr = await fetch(this.url(`/session/${sid}${this.dirq()}`));
          if (sr.ok) model = (await sr.json())?.model;
        } catch {
          /* fall through to error below */
        }
        const providerID = model?.providerID;
        const modelID = model?.id ?? model?.modelID;
        if (!providerID || !modelID) throw new Error('opencode compact: session model unknown');
        // Fire-and-forget: summarize blocks for the WHOLE compaction (tens of seconds); awaiting it
        // would head-of-line-block every other message on this socket. Stream the result over SSE.
        post(`/session/${sid}/summarize${this.dirq()}`, { providerID, modelID })
          .then((r) => {
            if (!r.ok) this.emit({ type: 'error', message: `compact failed (${r.status})` });
          })
          .catch((e) => this.emit({ type: 'error', message: `compact: ${String(e)}` }));
        return { notice: 'Compacting the session…' };
      }
      case 'undo': {
        // revert removes a message + everything after it; target the last USER message so the
        // last turn (prompt + reply) is undone — matching the TUI's /undo. /redo restores it.
        let rows: any[] = [];
        try {
          const mr = await fetch(this.url(`/session/${sid}/message${this.dirq()}`));
          if (mr.ok) rows = (await mr.json()) as any[];
        } catch {
          /* fall through */
        }
        let lastUser: string | undefined;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]?.info?.role === 'user') {
            lastUser = rows[i].info.id;
            break;
          }
        }
        // Reverting to the very first message would empty the session — OpenCode rejects it (409).
        // So a single-turn session has nothing to undo back to.
        if (!lastUser || rows[0]?.info?.id === lastUser) return { notice: 'Nothing to undo.' };
        const r = await post(`/session/${sid}/revert${this.dirq()}`, { messageID: lastUser });
        if (r.status === 409) return { notice: revert409Notice(await safeText(r), 'undo') };
        if (!r.ok) throw new Error(`opencode undo ${r.status}: ${await safeText(r)}`);
        return; // feedback (note + bubble removal) comes from the session.updated → history-reset resync
      }
      case 'redo': {
        const r = await post(`/session/${sid}/unrevert${this.dirq()}`);
        if (r.status === 409) return { notice: revert409Notice(await safeText(r), 'redo') };
        if (!r.ok) throw new Error(`opencode redo ${r.status}: ${await safeText(r)}`);
        return; // feedback comes from the resync (no-op redo just shows the /redo echo)
      }
      case 'stop': {
        const r = await post(`/session/${sid}/abort`);
        if (!r.ok) throw new Error(`opencode abort ${r.status}`);
        return { notice: 'Stopped the running turn.' };
      }
      case 'share': {
        const r = await post(`/session/${sid}/share`); // no directory (it 500s with one)
        if (!r.ok) throw new Error(`opencode share ${r.status}: ${await safeText(r)}`);
        let url: string | undefined;
        try {
          url = (await r.json())?.share?.url;
        } catch {
          /* body may be empty */
        }
        return { notice: url ? `Shared: ${url}` : 'Share link created.' };
      }
      case 'unshare': {
        const r = await fetch(this.url(`/session/${sid}/share`), { method: 'DELETE' });
        if (!r.ok) throw new Error(`opencode unshare ${r.status}`);
        return { notice: 'Share link removed.' };
      }
      default: {
        // Template/skill command — starts a turn; fire-and-forget so the WS isn't blocked,
        // results stream back over SSE. Surface only failures.
        post(`/session/${sid}/command`, { command: name, arguments: args ?? '' })
          .then((r) => {
            if (!r.ok) this.emit({ type: 'error', message: `command ${name} failed (${r.status})` });
          })
          .catch((e) => this.emit({ type: 'error', message: `command ${name}: ${String(e)}` }));
        return { notice: `Running /${name}…` };
      }
    }
  }

  /**
   * Deliver a user-uploaded file to the agent. Universal, model-agnostic path: write it to
   * `<cwd>/.cosyncing/inbox` and inject a path-reference prompt, so ANY model (incl. text-only or
   * tool-only ones) reliably receives it. We deliberately do NOT attach a native image part:
   * OpenCode's per-model `capabilities.input` is unreliable (e.g. the local qwen advertises
   * "image" but silently drops an image prompt — a 204 that creates no message), and a dropped
   * file part takes the whole prompt with it. Native inline-vision is a future, capability-gated add.
   */
  async sendFile(file: FileInput): Promise<void> {
    // A bare upload (no accompanying text) is just a prompt carrying one attachment.
    await this.sendPrompt({ text: '', files: [file] });
  }

  /** Write an uploaded file into `<cwd>/.cosyncing/inbox`, uniquifying on collision; returns the
   *  ABSOLUTE path written (models mis-resolve a relative `.cosyncing/inbox/...` ref), or null when
   *  there's no workspace dir / the write failed. */
  private writeInboxFile(file: FileInput): string {
    if (!this.info.cwd) throw new Error('OpenCode attachment delivery requires a workspace.');
    const inbox = resolve(this.info.cwd, PRODUCT_IDENTITY.repositoryDirectoryName, 'inbox');
    if (file.brokerPath) {
      const brokerPath = resolve(file.brokerPath);
      if (dirname(brokerPath) !== inbox || !existsSync(brokerPath)) {
        throw new Error('OpenCode rejected an untrusted broker attachment path.');
      }
      return brokerPath;
    }
    if (typeof file.data !== 'string') {
      throw new Error('OpenCode attachment bytes are missing.');
    }
    try {
      mkdirSync(inbox, { recursive: true });
      const base = basename(file.name).replace(/[^\w.\- ]+/g, '_') || 'file';
      let safe = base;
      if (existsSync(join(inbox, safe))) {
        const ext = extname(base);
        const stem = ext ? base.slice(0, -ext.length) : base;
        let n = 2;
        while (existsSync(join(inbox, `${stem}-${n}${ext}`))) n++;
        safe = `${stem}-${n}${ext}`;
      }
      const abs = join(inbox, safe);
      writeFileSync(abs, Buffer.from(file.data, 'base64'));
      return abs;
    } catch (error) {
      throw new Error(`OpenCode could not materialize attachment ${file.name}: ${String(error)}`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    this.handlers.clear();
  }
}

/** Built-in OpenCode actions surfaced as slash commands (mapped to dedicated endpoints). */
const BUILTIN_ACTIONS: SlashCommand[] = [
  { name: 'compact', description: 'Compact / summarize the session', kind: 'action' },
  { name: 'undo', description: 'Revert the last message', kind: 'action' },
  { name: 'redo', description: 'Restore the reverted message', kind: 'action' },
  { name: 'stop', description: 'Stop the running turn', kind: 'action' },
  { name: 'share', description: 'Create a share link', kind: 'action' },
  { name: 'unshare', description: 'Remove the share link', kind: 'action' },
];

/**
 * Tracks real-time activity for EVERY OpenCode session via one persistent /global/event
 * subscription plus point-in-time /session/status reconciliation, so the roster reflects what each
 * agent is actually doing — not a timestamp guess. Derives `working` (session.status busy/retry),
 * `idle` (session.status idle / session.idle), and `needs-input` (a pending permission/question).
 * One event connection, auto-reconnecting.
 * See docs/project/implementation-status.md
 */
class SessionStatusTracker {
  private readonly activity = new Map<string, Activity>();
  /** sessionId → set of unresolved blocking-request ids (permissions AND questions). */
  private readonly pendingPerm = new Map<string, Set<string>>();
  /** Top-level roster sessions and their directory scope, retained for reconnect reconciliation. */
  private readonly knownSessions = new Map<string, string>();
  /** Incremented by every SSE lifecycle event so an older REST snapshot cannot overwrite it. */
  private readonly eventRevision = new Map<string, number>();
  /** Latest REST reconciliation generation per session; prevents out-of-order snapshot responses. */
  private readonly reconcileGeneration = new Map<string, number>();
  private nextReconcileGeneration = 0;
  private readonly abort = new AbortController();
  private started = false;

  constructor(
    private readonly baseUrl: string,
    private readonly sseIdleMs: number,
  ) {}

  ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    void this.loop();
  }

  get(id: string): Activity {
    return this.hasPending(id) ? 'needs-input' : this.activity.get(id) ?? 'idle';
  }

  /** Seed or refresh live state from OpenCode's point-in-time `/session/status` map. The route is
   *  directory-scoped, so group the roster exactly as discovery groups `/session` requests. A
   *  session omitted from the map is idle in OpenCode's lifecycle store; applying that absence is
   *  what clears a stale Working state after a missed idle edge or reconnect. */
  async reconcile(sessions: readonly Pick<OcSession, 'id' | 'directory'>[]): Promise<void> {
    // The caller passes the full current roster (server + disk orphans, deduped
    // by id). Any id previously in knownSessions that is not in this roster was
    // deleted while cosyncing was offline (or dropped by OpenCode); either way
    // it must not linger and be reconciled as idle forever. The session.deleted
    // SSE handler still owns the online-delete path; this only catches what it
    // could not.
    const liveIds = new Set<string>();
    for (const session of sessions) {
      if (session?.id) {
        liveIds.add(session.id);
        this.knownSessions.set(session.id, session.directory ?? '');
      }
    }
    for (const id of [...this.knownSessions.keys()]) {
      if (!liveIds.has(id)) {
        this.knownSessions.delete(id);
        this.activity.delete(id);
        this.pendingPerm.delete(id);
        this.reconcileGeneration.delete(id);
      }
    }
    await this.reconcileKnownSessions();
  }

  /** True if ANY tracked session is mid-turn (working) or blocked on input (needs-input) — i.e. a
   *  restart right now would interrupt an active turn or drop a pending permission. Drives the C5
   *  serve-restart guardrail. Point-in-time read of the live map; no network. */
  anyBusy(): boolean {
    for (const a of this.activity.values()) if (a !== 'idle') return true;
    return false;
  }

  stop(): void {
    this.abort.abort();
  }

  private hasPending(id: string): boolean {
    return (this.pendingPerm.get(id)?.size ?? 0) > 0;
  }

  private noteEvent(id: string): void {
    this.eventRevision.set(id, (this.eventRevision.get(id) ?? 0) + 1);
  }

  private setFromEvent(id: string, activity: Activity): void {
    this.noteEvent(id);
    this.activity.set(id, this.hasPending(id) ? 'needs-input' : activity);
  }

  private async reconcileKnownSessions(): Promise<void> {
    const byDirectory = new Map<string, string[]>();
    for (const [id, directory] of this.knownSessions) {
      const ids = byDirectory.get(directory) ?? [];
      ids.push(id);
      byDirectory.set(directory, ids);
    }
    await Promise.all([...byDirectory].map(([directory, ids]) => this.reconcileDirectory(directory, ids)));
  }

  private async reconcileDirectory(directory: string, ids: string[]): Promise<void> {
    if (!ids.length || this.abort.signal.aborted) return;
    const generation = ++this.nextReconcileGeneration;
    const revisions = new Map(ids.map((id) => [id, this.eventRevision.get(id) ?? 0]));
    for (const id of ids) this.reconcileGeneration.set(id, generation);
    try {
      const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
      // Compose the per-request timeout with the adapter's teardown signal so
      // an in-flight reconcile is cancelled promptly on stop() rather than
      // running to its 2.5s ceiling. AbortSignal.any is available on Node 20+.
      const res = await fetch(this.baseUrl + '/session/status' + query, {
        signal: AbortSignal.any([AbortSignal.timeout(2500), this.abort.signal]),
      });
      if (!res.ok) return; // inconclusive evidence must preserve the last confirmed state
      const snapshot = (await res.json()) as Record<string, { type?: string }>;
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
      for (const id of ids) {
        // A newer SSE event or newer reconciliation request always wins over this response.
        if ((this.eventRevision.get(id) ?? 0) !== revisions.get(id)) continue;
        if (this.reconcileGeneration.get(id) !== generation) continue;
        const status = snapshot[id];
        const type = status?.type;
        // OpenCode omits inactive entries, so absence is positive idle evidence. An unfamiliar
        // future status variant is not: preserve the last known state until its semantics are known.
        if (status && type !== 'idle' && type !== 'busy' && type !== 'retry') continue;
        const next: Activity = type === 'busy' || type === 'retry' ? 'working' : 'idle';
        this.activity.set(id, this.hasPending(id) ? 'needs-input' : next);
      }
    } catch {
      /* server gone / unsupported route / timeout → preserve last confirmed state */
    }
  }

  private async loop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      const streamAbort = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const parentAbort = () => streamAbort.abort();
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => streamAbort.abort(), this.sseIdleMs);
      };
      this.abort.signal.addEventListener('abort', parentAbort, { once: true });
      try {
        resetIdle();
        const res = await fetch(this.baseUrl + '/global/event', { signal: streamAbort.signal });
        if (res.ok && res.body) {
          // Reconcile concurrently with reading the new stream. Per-session revisions below make
          // any event observed while the request is in flight authoritative over its response.
          void this.reconcileKnownSessions();
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            resetIdle();
            buf += decoder.decode(value, { stream: true });
            let sep: number;
            while ((sep = buf.indexOf('\n\n')) !== -1) {
              const frame = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              const line = frame.split('\n').find((l) => l.startsWith('data:'));
              if (!line) continue;
              try {
                this.handle(JSON.parse(line.slice(5).trim()));
              } catch {
                /* skip malformed frame */
              }
            }
          }
        }
      } catch {
        /* server gone / dropped — fall through to reconnect */
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        this.abort.signal.removeEventListener('abort', parentAbort);
      }
      if (this.abort.signal.aborted) return;
      await new Promise((r) => setTimeout(r, 2000)); // reconnect backoff
    }
  }

  private handle(raw: any): void {
    const ev = raw?.payload ?? raw; // /global/event wraps under payload
    const p = ev?.properties ?? {};
    switch (ev?.type) {
      case 'session.status': {
        const id = p.sessionID;
        if (!id) return;
        // a 'retry' (failing/throttled API call) is still an in-progress turn → keep 'working', not 'idle'
        this.setFromEvent(id, p.status?.type === 'busy' || p.status?.type === 'retry' ? 'working' : 'idle');
        return;
      }
      case 'session.idle': {
        const id = p.sessionID;
        if (id) this.setFromEvent(id, 'idle');
        return;
      }
      case 'session.deleted': {
        const id = p.sessionID ?? p.id ?? p.session?.id;
        if (!id) return;
        this.noteEvent(id);
        this.activity.delete(id);
        this.pendingPerm.delete(id);
        this.knownSessions.delete(id);
        this.reconcileGeneration.delete(id);
        return;
      }
      case 'permission.asked':
      case 'permission.v2.asked': {
        const req = p.id ? p : (p.permission ?? p.request ?? p);
        const id = req?.sessionID ?? p.sessionID;
        const rid = req?.id ?? p.requestID;
        if (!id || !rid) return;
        let set = this.pendingPerm.get(id);
        if (!set) {
          set = new Set();
          this.pendingPerm.set(id, set);
        }
        set.add(rid);
        this.setFromEvent(id, 'needs-input');
        return;
      }
      case 'permission.replied':
      case 'permission.v2.replied': {
        const id = p.sessionID ?? '';
        const rid = p.requestID;
        if (id && rid) this.pendingPerm.get(id)?.delete(rid);
        // turn resumes after a decision; the next session.status refines working/idle.
        if (id && !this.hasPending(id)) this.setFromEvent(id, 'working');
        return;
      }
      case 'question.asked':
      case 'question.v2.asked': {
        const id = p.sessionID;
        const qid = p.id;
        if (!id || !qid) return;
        let set = this.pendingPerm.get(id);
        if (!set) {
          set = new Set();
          this.pendingPerm.set(id, set);
        }
        set.add(qid);
        this.setFromEvent(id, 'needs-input');
        return;
      }
      case 'question.replied':
      case 'question.rejected':
      case 'question.v2.replied':
      case 'question.v2.rejected': {
        const id = p.sessionID ?? '';
        const qid = p.id ?? p.requestID;
        if (id && qid) this.pendingPerm.get(id)?.delete(qid);
        if (id && !this.hasPending(id)) this.setFromEvent(id, 'working');
        return;
      }
      default:
        return;
    }
  }
}

function opencodePrivateHistory(storageRoot: string, sessionId: string): AgentMessage[] {
  const db = opencodeDbHistory(storageRoot, sessionId);
  return db ?? opencodeDiskHistory(storageRoot, sessionId);
}

function opencodeDbHistory(storageRoot: string, sessionId: string): AgentMessage[] | undefined {
  const db = openOpenCodeDb(storageRoot);
  if (!db) return undefined;
  try {
    const session = db.query(`select revert from session where id = ?`).get(sessionId) as any;
    if (!session) return undefined;
    let messages = db
      .query(`select id, session_id, time_created, data from message where session_id = ? order by time_created, id`)
      .all(sessionId) as any[];
    const revertId = parseJsonObject(session.revert)?.messageID;
    if (revertId) {
      const cut = messages.findIndex((m: any) => m.id === revertId);
      if (cut >= 0) messages = messages.slice(0, cut);
    }
    const out: AgentMessage[] = [];
    let lastUserKey: string | undefined;
    let lastUserAt: number | undefined;
    const runSummaries: AgentMessage[] = [];
    const partQuery = db.query(`select id, message_id, session_id, time_created, data from part where message_id = ? order by time_created, id`);
    for (const row of messages) {
      const msg = { id: row.id, sessionID: row.session_id, ...parseJsonObject(row.data) };
      const parts = (partQuery.all(row.id) as any[]).map(dbPartFromRow);
      if (msg.role === 'user') {
        const text = parts
          .filter((p: any) => p?.type === 'text')
          .map((p: any) => cleanDbUserText(String(p.text ?? '')))
          .filter(Boolean)
          .join('\n')
          .trim();
        const sentAt = nativeTimeMs(msg.time?.created ?? row.time_created);
        if (text) out.push({ type: 'user-message', text, key: msg.id, turnId: msg.id, sentAt });
        lastUserKey = msg.id ? String(msg.id) : lastUserKey;
        lastUserAt = sentAt ?? lastUserAt;
      } else {
        for (const part of parts) out.push(...mapPart(part, true));
        if (msg.error) {
          const e = msg.error;
          const message = e.data?.message ?? e.message ?? e.name ?? 'Turn failed';
          out.push({ type: 'error', message: String(message).split('\n')[0]!.slice(0, 200) });
        }
        const summary = runSummaryFromOpenCodeMessage(msg, {
          userMessageKey: msg.parentID ? String(msg.parentID) : lastUserKey,
          fallbackStartedAt: lastUserAt,
          assistantMessageKey: firstAssistantPartKey(parts),
        });
        if (summary) {
          out.push(summary);
          runSummaries.push(summary);
        }
      }
      const tok = msg.tokens;
      if (tok) {
        out.push({
          type: 'token-count',
          input: tok.input,
          output: tok.output,
          cacheRead: tok.cache?.read,
          cacheWrite: tok.cache?.write,
          cost: msg.cost,
        });
      }
    }
    const totals = runtimeTotalsFromRunSummaries(runSummaries, 'opencode');
    if (totals) out.push(totals);
    return out;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

function opencodeDiskHistory(storageRoot: string, sessionId: string): AgentMessage[] {
  if (!storageRoot) return [];
  const messages = opencodeDiskMessages(storageRoot, sessionId);
  const out: AgentMessage[] = [];
  let lastUserKey: string | undefined;
  let lastUserAt: number | undefined;
  const runSummaries: AgentMessage[] = [];
  for (const msg of messages) {
    const parts = readJsonDir(join(storageRoot, 'part', msg.id))
      .filter((p: any) => p?.sessionID === sessionId || p?.messageID === msg.id)
      .sort(compareOpenCodeParts);
    if (msg.role === 'user') {
      const text = parts.filter((p: any) => p?.type === 'text').map((p: any) => p.text).filter(Boolean).join('\n').trim();
      const sentAt = nativeTimeMs(msg.time?.created);
      if (text) out.push({ type: 'user-message', text, key: msg.id, turnId: msg.id, sentAt });
      lastUserKey = msg.id ? String(msg.id) : lastUserKey;
      lastUserAt = sentAt ?? lastUserAt;
    } else {
      for (const part of parts) out.push(...mapPart(part, true));
      if (msg.error) {
        const e = msg.error;
        const message = e.data?.message ?? e.message ?? e.name ?? 'Turn failed';
        out.push({ type: 'error', message: String(message).split('\n')[0]!.slice(0, 200) });
      }
      const summary = runSummaryFromOpenCodeMessage(msg, {
        userMessageKey: msg.parentID ? String(msg.parentID) : lastUserKey,
        fallbackStartedAt: lastUserAt,
        assistantMessageKey: firstAssistantPartKey(parts),
      });
      if (summary) {
        out.push(summary);
        runSummaries.push(summary);
      }
    }
    if (msg.tokens) {
      out.push({
        type: 'token-count',
        input: msg.tokens.input,
        output: msg.tokens.output,
        cacheRead: msg.tokens.cache?.read,
        cacheWrite: msg.tokens.cache?.write,
        cost: msg.cost,
      });
    }
  }
  const totals = runtimeTotalsFromRunSummaries(runSummaries, 'opencode');
  if (totals) out.push(totals);
  return out;
}

function opencodePrivateActivity(storageRoot: string, sessionId: string): SessionInfo['status'] {
  return opencodeDbActivity(storageRoot, sessionId) ?? opencodeDiskActivity(storageRoot, sessionId);
}

function opencodeDbActivity(storageRoot: string, sessionId: string): SessionInfo['status'] | undefined {
  const db = openOpenCodeDb(storageRoot);
  if (!db) return undefined;
  try {
    const session = db.query(`select id, time_updated from session where id = ?`).get(sessionId) as any;
    if (!session) return undefined;
    const latest = db
      .query(`select id, session_id, time_created, time_updated, data from message where session_id = ? order by time_created desc, id desc limit 1`)
      .get(sessionId) as any;
    if (!latest) return 'idle';
    const msg = { id: latest.id, sessionID: latest.session_id, ...parseJsonObject(latest.data) };
    const parts = (db.query(`select id, message_id, session_id, time_created, time_updated, data from part where message_id = ?`).all(latest.id) as any[]).map(dbPartFromRow);
    const fresh = isFreshOpenCodePrivateActivity([session.time_updated, latest.time_updated, latest.time_created, msg.time?.updated, msg.time?.created, ...parts.map(openCodePartTime)]);
    if (fresh && msg.role === 'assistant' && !msg.time?.completed && !msg.finish) return 'working';
    if (fresh && parts.some(isActiveOpenCodeToolPart)) return 'working';
    return 'idle';
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

function opencodeDiskActivity(storageRoot: string, sessionId: string): SessionInfo['status'] {
  if (!storageRoot) return 'idle';
  const messages = opencodeDiskMessages(storageRoot, sessionId);
  const latest = messages.at(-1);
  if (!latest) return 'idle';
  const parts = readJsonDir(join(storageRoot, 'part', latest.id)).filter((p: any) => p?.messageID === latest.id);
  const fresh = isFreshOpenCodePrivateActivity([latest.time?.updated, latest.time?.created, ...parts.map(openCodePartTime)]);
  if (fresh && latest.role === 'assistant' && !latest.time?.completed && !latest.finish) return 'working';
  if (fresh && parts.some(isActiveOpenCodeToolPart)) return 'working';
  return 'idle';
}

function isActiveOpenCodeToolPart(part: any): boolean {
  if (part?.type !== 'tool') return false;
  // TodoWrite carries durable todo item state; open/pending todos are not process liveness.
  if (part.tool === 'todowrite') return false;
  return !['completed', 'error'].includes(String(part?.state?.status ?? ''));
}

function isFreshOpenCodePrivateActivity(times: Array<unknown>): boolean {
  const latest = Math.max(0, ...times.map((t) => Number(t ?? 0)).filter((n) => Number.isFinite(n)));
  return latest > 0 && Date.now() - latest <= OPENCODE_PRIVATE_WORKING_FRESH_MS;
}

function opencodeMessageIds(storageRoot: string, sessionId: string): string[] {
  if (!storageRoot) return [];
  return [
    ...opencodeDiskMessages(storageRoot, sessionId).filter((m: any) => m?.id).map((m: any) => String(m.id)),
    ...opencodeDbMessageIds(storageRoot, sessionId),
  ];
}

function opencodeDbMessageIds(storageRoot: string, sessionId: string): string[] {
  const db = openOpenCodeDb(storageRoot);
  if (!db) return [];
  try {
    return (db.query(`select id from message where session_id = ?`).all(sessionId) as any[]).map((r) => String(r.id));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function opencodeDiskMessages(storageRoot: string, sessionId: string): any[] {
  let messages = readJsonDir(join(storageRoot, 'message', sessionId))
    .filter((m: any) => m?.sessionID === sessionId)
    .sort(compareOpenCodeMessages);
  const revertId = opencodeDiskRevertMessageId(storageRoot, sessionId);
  if (revertId) {
    const cut = messages.findIndex((m: any) => m?.id === revertId);
    if (cut >= 0) messages = messages.slice(0, cut);
  }
  return messages;
}

function opencodeDiskRevertMessageId(storageRoot: string, sessionId: string): string | undefined {
  for (const s of readJsonTree(join(storageRoot, 'session'), 2)) {
    if (s?.id === sessionId) return s.revert?.messageID ? String(s.revert.messageID) : undefined;
  }
  return undefined;
}

function dbSessionFromRow(row: any): OcSession {
  return {
    id: String(row.id),
    slug: row.slug ?? undefined,
    directory: row.directory ?? undefined,
    title: row.title ?? undefined,
    parentID: row.parent_id ?? undefined,
    model: parseJsonObject(row.model),
    revert: parseJsonObject(row.revert),
    time: {
      created: row.time_created ?? undefined,
      updated: row.time_updated ?? undefined,
    },
  };
}

function dbPartFromRow(row: any): any {
  return {
    id: row.id,
    messageID: row.message_id,
    sessionID: row.session_id,
    timeCreated: row.time_created ?? undefined,
    timeUpdated: row.time_updated ?? undefined,
    ...parseJsonObject(row.data),
  };
}

function parseJsonObject(value: unknown): any | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return undefined;
  }
}

function cleanDbUserText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* keep original */
    }
  }
  return text;
}

function openOpenCodeDb(storageRoot: string): Database | undefined {
  if (!storageRoot) return undefined;
  const path = join(dirname(storageRoot), 'opencode.db');
  try {
    if (!existsSync(path)) return undefined;
    return new Database(path, { readonly: true });
  } catch {
    return undefined;
  }
}

function fileSetHistorySourceIdentity(
  paths: string[],
  rewriteToken: string,
): HistorySourceIdentity | undefined {
  const parts: string[] = [];
  let appendPosition = 0;
  let primarySource: string | undefined;
  for (const path of paths) {
    try {
      const stat = statSync(path);
      primarySource ??= `${path}:${stat.dev}:${stat.ino}`;
      appendPosition += stat.size;
      parts.push([
        path,
        stat.dev,
        stat.ino,
        stat.size,
        stat.mtimeMs,
        stat.ctimeMs,
      ].join(':'));
    } catch {
      parts.push(`${path}:missing`);
    }
  }
  if (!primarySource) return undefined;
  return {
    sourceId: primarySource,
    revision: parts.join('|'),
    appendPosition,
    rewriteToken: `${primarySource}:${rewriteToken}`,
  };
}

const OPENCODE_HISTORY_REWRITE_TOKEN_MAX_CHARS = 4096;

function openCodeSessionRewriteToken(
  databasePath: string,
  sessionId: string,
): string | undefined {
  let database: Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true });
    const row = database
      .query('select revert from session where id = ? limit 1')
      .get(sessionId) as { revert?: unknown } | null;
    if (!row) return undefined;
    return JSON.stringify(row.revert ?? null).slice(
      0,
      OPENCODE_HISTORY_REWRITE_TOKEN_MAX_CHARS,
    );
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}

function readJsonDir(dir: string): any[] {
  try {
    if (!existsSync(dir)) return [];
    const out: any[] = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(readFileSync(join(dir, ent.name), 'utf8')));
      } catch {
        /* skip partial/corrupt JSON */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function readJsonTree(dir: string, maxDepth: number): any[] {
  if (maxDepth < 0) return [];
  try {
    if (!existsSync(dir)) return [];
    const out: any[] = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) out.push(...readJsonTree(full, maxDepth - 1));
      else if (ent.isFile() && ent.name.endsWith('.json')) {
        try {
          out.push(JSON.parse(readFileSync(full, 'utf8')));
        } catch {
          /* skip partial/corrupt JSON */
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

function compareOpenCodeMessages(a: any, b: any): number {
  return Number(a?.time?.created ?? 0) - Number(b?.time?.created ?? 0) || String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

function compareOpenCodeParts(a: any, b: any): number {
  const at = Number(a?.time?.start ?? a?.time?.created ?? 0);
  const bt = Number(b?.time?.start ?? b?.time?.created ?? 0);
  return at - bt || String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

function messagesFromRunJson(stdout: string): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const line of stdout.split('\n')) {
    out.push(...messagesFromRunJsonLine(line));
  }
  return out;
}

function messagesFromRunJsonLine(line: string): AgentMessage[] {
  if (!line.trim()) return [];
  try {
    return messagesFromRunRecord(JSON.parse(line));
  } catch {
    return [];
  }
}

function messagesFromRunRecord(obj: any): AgentMessage[] {
  const out: AgentMessage[] = [];
  const ev = obj?.payload ?? obj;
  const p = ev?.properties ?? ev ?? {};
  if (ev?.type === 'message.part.updated' && p.part) out.push(...mapPart(p.part, false));
  else if ((ev?.type === 'message.part.delta' || ev?.type === 'message.output.delta') && p.delta != null)
    out.push({ type: 'model-output', delta: String(p.delta), key: p.partID ?? p.id });
  else if (ev?.type === 'session.status') out.push({ type: 'status', status: p.status?.type === 'busy' ? 'running' : 'idle' });
  else if (ev?.type === 'message.updated' && p.info?.tokens)
    out.push({
      type: 'token-count',
      input: p.info.tokens.input,
      output: p.info.tokens.output,
      cacheRead: p.info.tokens.cache?.read,
      cacheWrite: p.info.tokens.cache?.write,
      cost: p.info.cost,
    });

  // Real `opencode run --format json` emits raw records:
  // {type:"text"|"tool_use"|"step_finish", sessionID, part:{...}} rather than server SSE events.
  // Keep this mapper next to the run connection so private Drive mirrors the actual CLI surface.
  const part = p.part;
  if (part?.type === 'step-start') out.push({ type: 'status', status: 'running' });
  else if (part?.type === 'step-finish') {
    const tok = part.tokens;
    if (tok) {
      out.push({
        type: 'token-count',
        input: tok.input,
        output: tok.output,
        cacheRead: tok.cache?.read,
        cacheWrite: tok.cache?.write,
        cost: part.cost,
      });
    }
  } else if (part) out.push(...mapPart(part, false));
  return out;
}

function writeInboxFile(cwd: string | undefined, file: FileInput): string | undefined {
  if (!cwd) return undefined;
  const dir = resolve(cwd, PRODUCT_IDENTITY.repositoryDirectoryName, 'inbox');
  if (file.brokerPath) {
    const brokerPath = resolve(file.brokerPath);
    if (dirname(brokerPath) !== dir || !existsSync(brokerPath)) {
      throw new Error('OpenCode rejected an untrusted broker attachment path.');
    }
    return brokerPath;
  }
  if (typeof file.data !== 'string') throw new Error('OpenCode attachment bytes are missing.');
  try {
    mkdirSync(dir, { recursive: true });
    const safe = basename(file.name || 'upload');
    const path = join(dir, `${Date.now()}-${safe}`);
    writeFileSync(path, Buffer.from(file.data, 'base64'));
    return path;
  } catch {
    return undefined;
  }
}

/** Map an OpenCode Part to zero or more normalized AgentMessages. */
function mapPart(part: any, _historical: boolean): AgentMessage[] {
  if (!part || typeof part !== 'object') return [];
  switch (part.type) {
    case 'text':
      return part.text ? [{ type: 'model-output', text: part.text, key: part.id, final: false }] : [];
    case 'reasoning':
      return part.text ? [{ type: 'thinking', text: part.text, key: part.id }] : [];
    case 'file':
      return [
        {
          type: 'file-artifact',
          path: part.filename ?? part.url ?? part.id,
          name: part.filename ?? 'file',
          mimeType: part.mime ?? 'application/octet-stream',
          url: part.url,
        },
      ];
    case 'tool': {
      const state = part.state ?? {};
      const status: string = state.status ?? 'pending';
      const tool: string = part.tool ?? 'tool';
      const callId = part.callID ?? part.id;
      const input = state.input ?? {};
      // The `question` tool is represented by the interactive question card (from question.asked /
      // fetchPending), so don't also render its raw-JSON tool block.
      if (tool === 'question') return [];
      if (tool === 'todowrite') {
        const taskList = taskListStateFromTodoWrite(part);
        // TodoWrite is a session-state surface, not transcript tool chatter. If a future OpenCode
        // shape is malformed, suppress the raw JSON block instead of showing duplicate args/output.
        // Contract: docs/architecture/client-ui.md
        return taskList ? [taskList] : [];
      }
      const activity = tool === 'task' ? agentActivityFromOpenCodeTask(part, _historical) : undefined;
      if (status === 'completed' || status === 'error') {
        const md = state.metadata ?? {};
        const fd = md.filediff ?? {};
        const path: string | undefined = input.filePath ?? md.filepath ?? fd.file;
        const exitCode = tool === 'bash' && md.exit != null ? Number(md.exit) : undefined;
        const diff: string | undefined = md.diff ?? fd.patch;
        // Canonical per-file change set from the event-time diff (single file for OpenCode's edit tool).
        let fileChanges: FileChange[] | undefined;
        if (typeof diff === 'string' && diff) {
          const changes = splitUnifiedDiffFiles(diff);
          if (changes.length) fileChanges = changes.map((c) => (c.path ? c : { ...c, path: path ?? '' }));
          else if (path) fileChanges = [{ path, operation: 'edit', diff, additions: fd.additions, deletions: fd.deletions }];
        }
        return [
          ...(activity ? [activity] : []),
          {
            type: 'tool-result',
            callId,
            toolName: tool,
            toolClass: openCodeToolDisplayClass(tool),
            ...(() => {
              const semantic = openCodeToolSemantic(tool, input, state, { status });
              return semantic ? { semantic } : {};
            })(),
            isError: status === 'error' || (exitCode != null && exitCode !== 0),
            result: tool === 'bash' ? (md.output ?? state.output) : (state.output ?? state.error),
            title: toolSummary(tool, input, md, status === 'error'),
            path,
            diff,
            fileChanges,
            additions: fd.additions,
            deletions: fd.deletions,
            exitCode,
            truncated: md.truncated || undefined,
            durationMs: elapsedMsFromOpenCodePart(part),
          },
        ];
      }
      return [
        ...(activity ? [activity] : []),
        {
          type: 'tool-call',
          callId,
          toolName: tool,
          toolClass: openCodeToolDisplayClass(tool),
          ...(() => {
            const semantic = openCodeToolSemantic(tool, input, state, { status });
            return semantic ? { semantic } : {};
          })(),
          title: state.title ?? toolSummary(tool, input, {}, false),
          args: input,
        },
      ];
    }
    default:
      return [];
  }
}

function taskListStateFromTodoWrite(part: any): AgentMessage | undefined {
  const todos = todoArrayFromOpenCodeState(part?.state);
  if (!todos?.length) return undefined;
  const items: Array<{ id: string; title: string; status: 'open' | 'in-progress' | 'done' | 'cancelled'; priority?: 'low' | 'normal' | 'high' }> = [];
  for (const [index, todo] of todos.entries()) {
    const title = String(todo?.content ?? todo?.title ?? '').trim();
    if (!title) continue;
    items.push({
      id: todo?.id != null ? String(todo.id) : String(index),
      title,
      status: normalizeTodoStatus(todo?.status),
      priority: normalizeTodoPriority(todo?.priority),
    });
  }
  if (!items.length) return undefined;
  const terminal = items.every((item) => item.status === 'done' || item.status === 'cancelled');
  return {
    type: 'task-list-state',
    key: `opencode:todo:${part.sessionID ?? 'current'}`,
    title: 'Tasks',
    status: terminal ? 'done' : 'running',
    source: 'tool-call',
    sourceTool: 'todowrite',
    updatedAt: openCodePartTime(part),
    items,
  };
}

function todoArrayFromOpenCodeState(state: any): any[] | undefined {
  if (Array.isArray(state?.input?.todos)) return state.input.todos;
  if (Array.isArray(state?.metadata?.todos)) return state.metadata.todos;
  return parseTodoOutput(state?.output);
}

function parseTodoOutput(output: unknown): any[] | undefined {
  if (Array.isArray(output)) return output;
  if (typeof output !== 'string' || !output.trim()) return undefined;
  const parsed = parseJsonObject(output);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.todos)) return parsed.todos;
  return undefined;
}

function normalizeTodoStatus(status: unknown): 'open' | 'in-progress' | 'done' | 'cancelled' {
  const s = String(status ?? '').toLowerCase().replace(/[_\s-]+/g, '-');
  if (s === 'completed' || s === 'complete' || s === 'done') return 'done';
  if (s === 'in-progress' || s === 'running' || s === 'active') return 'in-progress';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  return 'open';
}

function normalizeTodoPriority(priority: unknown): 'low' | 'normal' | 'high' | undefined {
  const p = String(priority ?? '').toLowerCase();
  if (p === 'low' || p === 'high') return p;
  if (p === 'medium' || p === 'normal') return 'normal';
  return undefined;
}

function agentActivityFromOpenCodeTask(part: any, historical: boolean): AgentMessage | undefined {
  const state = part?.state ?? {};
  const status = String(state.status ?? 'pending');
  // Historical OpenCode rows can contain stale `running` task states from old sessions. Only live
  // SSE/raw-run frames may create/clear the transient activity bar; history keeps the durable task
  // tool result only. Governing contract: docs/architecture/client-ui.md
  if (historical) return undefined;
  if (status !== 'running' && status !== 'completed' && status !== 'error') return undefined;
  const input = state.input ?? {};
  const title = String(input.description ?? firstLine(input.prompt) ?? 'Subagent task').trim();
  const subtitle = input.subagent_type ? String(input.subagent_type) : undefined;
  return {
    type: 'agent-activity',
    key: `agent:${part.callID ?? part.id}`,
    kind: 'subagent',
    title,
    subtitle,
    status: status === 'completed' ? 'done' : status === 'error' ? 'error' : 'running',
    elapsedMs: elapsedMsFromOpenCodePart(part),
    agentsDone: status === 'running' ? 0 : 1,
    agentsTotal: 1,
  };
}

function firstLine(value: unknown): string | undefined {
  const line = String(value ?? '').split('\n').find((s) => s.trim());
  return line?.trim();
}

function openCodePartTime(part: any): number | undefined {
  return Number(part.timeUpdated ?? part.time?.end ?? part.time?.updated ?? part.time?.created ?? part.timeCreated) || undefined;
}

function elapsedMsFromOpenCodePart(part: any): number | undefined {
  const start = Number(part.time?.start ?? part.timeCreated ?? 0);
  const end = Number(part.time?.end ?? part.timeUpdated ?? 0);
  return start && end && end >= start ? end - start : undefined;
}

/**
 * The one place OpenCode maps a native tool name to a normalized presentation
 * family; `null` keeps a tool on the bounded structured fallback.
 */
function openCodeToolFamily(toolName: string): 'command' | 'file-read' | 'search' | 'web' | null {
  switch (String(toolName || '')) {
    case 'bash':
    case 'interactive_bash':
      return 'command';
    case 'read':
      return 'file-read';
    case 'grep':
    case 'glob':
    case 'list':
      return 'search';
    case 'webfetch':
    case 'websearch':
    case 'google_search':
      return 'web';
    default:
      return null;
  }
}

/**
 * OpenCode tool part → the canonical normalized family.
 *
 * OpenCode redelivers the complete accumulated `output` on every
 * `message.part.updated` frame, so this must never rescan history: the bounded
 * stream/preview builders take a tail (or head) slice sized to the bound, which
 * is why per-frame work stays proportional to the bound and not to the run.
 */
function openCodeToolSemantic(
  tool: string,
  input: any,
  state: any,
  options: { status: string },
): ToolSemantic | undefined {
  const family = openCodeToolFamily(tool);
  if (!family) return undefined;
  const args = input && typeof input === 'object' ? input : {};
  const md = state?.metadata && typeof state.metadata === 'object' ? state.metadata : {};
  const terminal = options.status === 'completed' || options.status === 'error';
  switch (family) {
    case 'command': {
      const exit = md.exit != null ? Number(md.exit) : undefined;
      const state_: ToolCommandState = !terminal
        ? 'running'
        : md.aborted === true
          ? 'interrupted'
          : exit !== undefined && Number.isFinite(exit)
            ? (exit === 0 ? 'completed' : 'failed')
            : options.status === 'error'
              ? 'failed'
              : 'unknown';
      return boundToolSemantic(commandSemantic({
        command: args.command,
        cwd: args.cwd ?? md.cwd,
        state: state_,
        stdout: boundedStream(md.stdout),
        stderr: boundedStream(md.stderr),
      }));
    }
    case 'file-read':
      return boundToolSemantic(fileReadSemantic({
        path: args.filePath ?? md.filepath,
        startLine: typeof args.offset === 'number' ? args.offset + 1 : undefined,
        preview: terminal ? (md.preview ?? state?.output) : undefined,
        totalLines: md.totalLines ?? md.lines,
        previewTruncated: md.truncated === true,
      }));
    case 'search': {
      const groups: (ToolSearchGroup | undefined)[] = [];
      const files = Array.isArray(md.files)
        ? md.files
        : Array.isArray(md.filenames)
          ? md.filenames
          : [];
      for (const file of files) {
        groups.push(typeof file === 'string'
          ? searchGroup({ path: file })
          : searchGroup({ path: file?.path, matchCount: file?.count, matches: file?.matches }));
      }
      return boundToolSemantic(searchSemantic({
        query: args.pattern ?? args.query,
        scope: args.path ?? args.glob ?? args.include,
        matchCount: md.matches,
        fileCount: md.count ?? (files.length || undefined),
        groups,
      }));
    }
    case 'web':
      return boundToolSemantic(webSemantic({
        query: args.query,
        url: args.url,
        results: Array.isArray(md.results) ? md.results : undefined,
      }));
  }
}

/** OpenCode owns its native tool-name taxonomy; the shared client sees only this canonical class. */
function openCodeToolDisplayClass(toolName: string): ToolDisplayClass {
  const name = String(toolName || '').toLowerCase();
  if (/^(bash|shell|exec|interactive_bash|background_task)$/.test(name)) return 'execute';
  if (/(^|[_-])(edit|write|patch|create|delete|move|rename)([_-]|$)/.test(name)) return 'edit';
  if (
    /^(read|grep|glob|list|ls|webfetch|websearch|google_search|look_at|todoread|codesearch)$/.test(name)
    || /(^|[_-])(read|grep|glob|search|fetch|list|query|diagnostic|symbols)([_-]|$)/.test(name)
    || /directory_tree/.test(name)
  ) return 'lookup';
  return 'other';
}

/** Friendly, verb-first one-liner per tool (so the UI stays tool-agnostic — it just renders this). */
function toolSummary(tool: string, input: any, md: any, isError: boolean): string {
  // basename handles both `/` and `\`, so a Windows-style path from OpenCode still summarizes cleanly.
  const base = (p?: string) => (p ? basename(p) || p : '');
  switch (tool) {
    case 'edit':
    case 'apply_patch':
      return `Edited ${base(input?.filePath ?? md?.filepath)}`;
    case 'write':
      return `${md?.exists ? 'Edited' : 'Created'} ${base(input?.filePath ?? md?.filepath)}`;
    case 'read':
      return `Read ${base(input?.filePath)}`;
    case 'bash':
      return input?.description || input?.command || 'Ran command';
    case 'glob':
      return md?.count != null ? `Found ${md.count} file${md.count === 1 ? '' : 's'}` : `Glob ${input?.pattern ?? ''}`;
    case 'grep':
      return md?.matches != null ? `${md.matches} match${md.matches === 1 ? '' : 'es'} for "${input?.pattern ?? ''}"` : `Grep "${input?.pattern ?? ''}"`;
    case 'list':
      return `Listed ${base(input?.path) || 'directory'}`;
    case 'webfetch':
      return `Fetched ${input?.url ?? ''}`;
    case 'websearch':
    case 'google_search':
      return `Searched "${input?.query ?? ''}"`;
    case 'task':
      return `${input?.subagent_type ?? 'subagent'}: ${input?.description ?? ''}`.trim();
    case 'todowrite':
      return Array.isArray(input?.todos) ? `${input.todos.length} todo${input.todos.length === 1 ? '' : 's'}` : 'Updated todos';
    default:
      return (isError ? `${tool} failed` : tool);
  }
}

/** The session's current model as {providerID, modelID, variant?}, or undefined if unknown. */
function currentModelOf(s: { model?: { providerID?: string; id?: string; modelID?: string; variant?: string } }):
  | { providerID: string; modelID: string; variant?: string }
  | undefined {
  const providerID = s.model?.providerID;
  const modelID = s.model?.id ?? s.model?.modelID;
  if (!providerID || !modelID) return undefined;
  const variant = typeof s.model?.variant === 'string' && s.model.variant ? s.model.variant : undefined;
  return variant ? { providerID, modelID, variant } : { providerID, modelID };
}

/** The session's REAL active agent/mode, or undefined when OpenCode hasn't recorded one (fresh
 *  session before its first turn, or a pre-1.17 store). Never fabricate 'build' — an absent mode
 *  renders as absent, not as a guess. */
function currentAgentOf(s: { agent?: unknown }): string | undefined {
  return typeof s.agent === 'string' && s.agent ? s.agent : undefined;
}

/** Roster lineage for an OpenCode session, in the SAME shape codex emits so the client's shared,
 *  agent-neutral grouping applies unchanged. `nativeId` (a session's own id) is what a child's
 *  `parentThreadId` resolves against; a sub-agent child additionally carries `origin:'subagent'` +
 *  the spawning session's id. Without this a `Task`/sub-agent session lands in the roster as an
 *  unrelated top-level row instead of nesting under its parent. Top-level sessions get NO origin
 *  tag — only positive evidence (a real `parentID`) marks a row as a sub-agent. */
export function opencodeLineage(s: { id: string; parentID?: string }): {
  nativeId: string;
  origin?: 'subagent';
  parentThreadId?: string;
} {
  return s.parentID
    ? { nativeId: s.id, origin: 'subagent', parentThreadId: String(s.parentID) }
    : { nativeId: s.id };
}

export const OPENCODE_MAX_CONNECTED_PROVIDERS = 64;
export const OPENCODE_MAX_PROVIDER_RECORDS = 512;
export const OPENCODE_MAX_MODELS_PER_PROVIDER = 256;
export const OPENCODE_MAX_VARIANTS_PER_MODEL = 32;
export const OPENCODE_MAX_MODEL_OPTIONS = 2048;

function boundedObjectEntries(
  value: unknown,
  max: number,
): Array<[string, unknown]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).slice(0, max);
}

function modelOptionsOf(m: any): ModelOption[] {
  const providerID = typeof m?.providerID === 'string' && m.providerID ? m.providerID : undefined;
  const modelID =
    typeof m?.id === 'string' && m.id ? m.id : typeof m?.modelID === 'string' && m.modelID ? m.modelID : undefined;
  if (!providerID || !modelID) return [];
  const name = typeof m?.name === 'string' && m.name ? m.name : modelID;
  const base = (variant?: string, variantName?: string): ModelOption => {
    const suffix = variant ? ` (${variantName || variant})` : '';
    const label = `${providerID} · ${name}${suffix}`;
    return variant ? { providerID, modelID, variant, label } : { providerID, modelID, label };
  };

  // Real OpenCode /api/model responses carry per-request credential/config choices under
  // `variants[]` (for example a MiniMax row whose variant injects X-Api-Key inside OpenCode's
  // runtime). Emit one cosyncing picker option per variant, then send the selected variant back as
  // prompt_async's top-level `variant` field. Contract: docs/protocol/adapter-support.md
  const variants = Array.isArray(m?.variants)
    ? m.variants.slice(0, OPENCODE_MAX_VARIANTS_PER_MODEL)
    : boundedObjectEntries(m?.variants, OPENCODE_MAX_VARIANTS_PER_MODEL).map(
        ([id, value]) =>
          value && typeof value === 'object'
            ? { id, ...(value as Record<string, unknown>) }
            : { id },
      );
  if (variants.length) {
    return variants
      .map((v: any) => {
        const id = typeof v === 'string' ? v : typeof v?.id === 'string' ? v.id : typeof v?.name === 'string' ? v.name : '';
        if (!id) return undefined;
        const variantName = typeof v?.name === 'string' && v.name && v.name !== id ? v.name : undefined;
        return base(id, variantName);
      })
      .filter((x: ModelOption | undefined): x is ModelOption => !!x);
  }

  // Backward-compatible for older fixtures/private-server shapes, but the current server path above is
  // `variants[]`.
  const variant = typeof m?.variant === 'string' && m.variant ? m.variant : undefined;
  return [base(variant)];
}

function providerIdOf(value: unknown, fallback?: string): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback?.trim() || undefined;
  }
  const raw = value as Record<string, unknown>;
  const candidate = raw.id ?? raw.providerID ?? raw.providerId ?? fallback;
  return typeof candidate === 'string' && candidate.trim()
    ? candidate.trim()
    : undefined;
}

function connectedProviderIds(value: unknown): Set<string> | undefined {
  const ids = new Set<string>();
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, OPENCODE_MAX_CONNECTED_PROVIDERS)) {
      const id = providerIdOf(entry);
      if (id) ids.add(id);
    }
    return ids;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of boundedObjectEntries(
      value,
      OPENCODE_MAX_CONNECTED_PROVIDERS,
    )) {
      if (entry === false || entry == null) continue;
      const id = providerIdOf(entry, key);
      if (id) ids.add(id);
    }
    return ids;
  }
  return undefined;
}

/** Normalize the real `/provider` response without admitting disconnected rows from `all`. */
export function normalizeOpenCodeProviderCatalog(
  value: unknown,
): ModelOption[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const connected = connectedProviderIds(raw.connected);
  if (!connected || raw.all == null) return undefined;

  const providers: Array<[string | undefined, unknown]> = Array.isArray(raw.all)
    ? raw.all
        .slice(0, OPENCODE_MAX_PROVIDER_RECORDS)
        .map((provider) => [undefined, provider])
    : boundedObjectEntries(raw.all, OPENCODE_MAX_PROVIDER_RECORDS);
  const byKey = new Map<string, ModelOption>();
  for (const [fallbackProviderID, providerValue] of providers) {
    if (
      !providerValue ||
      typeof providerValue !== 'object' ||
      Array.isArray(providerValue)
    ) {
      continue;
    }
    const provider = providerValue as Record<string, unknown>;
    const providerID = providerIdOf(provider, fallbackProviderID);
    if (!providerID || !connected.has(providerID)) continue;
    const modelEntries: Array<[string | undefined, unknown]> = Array.isArray(
      provider.models,
    )
      ? provider.models
          .slice(0, OPENCODE_MAX_MODELS_PER_PROVIDER)
          .map((model) => [undefined, model])
      : boundedObjectEntries(
          provider.models,
          OPENCODE_MAX_MODELS_PER_PROVIDER,
        );
    for (const [fallbackModelID, modelValue] of modelEntries) {
      if (byKey.size >= OPENCODE_MAX_MODEL_OPTIONS) {
        return [...byKey.values()];
      }
      const model =
        modelValue &&
        typeof modelValue === 'object' &&
        !Array.isArray(modelValue)
          ? {
              providerID,
              id: fallbackModelID,
              ...(modelValue as Record<string, unknown>),
            }
          : { providerID, id: fallbackModelID };
      for (const option of modelOptionsOf(model)) {
        if (byKey.size >= OPENCODE_MAX_MODEL_OPTIONS) {
          return [...byKey.values()];
        }
        const key = modelKey(
          option.providerID,
          option.modelID,
          option.variant,
        );
        if (!byKey.has(key)) byKey.set(key, option);
      }
    }
  }
  return [...byKey.values()];
}

function normalizeLegacyOpenCodeCatalog(
  value: unknown,
  configuredProviders: Set<string> | null,
): ModelOption[] {
  const source =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).data
      : value;
  if (!Array.isArray(source)) return [];
  const byKey = new Map<string, ModelOption>();
  for (const raw of source.slice(
    0,
    OPENCODE_MAX_MODELS_PER_PROVIDER * OPENCODE_MAX_CONNECTED_PROVIDERS,
  )) {
    for (const option of modelOptionsOf(raw)) {
      if (
        configuredProviders &&
        !configuredProviders.has(option.providerID)
      ) {
        continue;
      }
      const key = modelKey(
        option.providerID,
        option.modelID,
        option.variant,
      );
      if (!byKey.has(key)) byKey.set(key, option);
      if (byKey.size >= OPENCODE_MAX_MODEL_OPTIONS) {
        return [...byKey.values()];
      }
    }
  }
  return [...byKey.values()];
}

interface OpenCodeCatalogLoad {
  models: ModelOption[];
  connectedProviders?: Set<string>;
}

async function fetchOpenCodeModelCatalog(
  baseUrl: string,
): Promise<OpenCodeCatalogLoad> {
  const providerResponse = await fetch(new URL('/provider', baseUrl), {
    signal: AbortSignal.timeout(4000),
  });
  if (providerResponse.ok) {
    const providerBody = await providerResponse.json();
    const normalized = normalizeOpenCodeProviderCatalog(providerBody);
    if (normalized) {
      return {
        models: normalized,
        connectedProviders: connectedProviderIds(
          (providerBody as Record<string, unknown>).connected,
        ),
      };
    }
  } else if (
    providerResponse.status !== 404 &&
    providerResponse.status !== 405 &&
    providerResponse.status !== 501
  ) {
    throw new Error(
      `OpenCode /provider returned ${providerResponse.status}: ${await safeText(providerResponse)}`,
    );
  }

  // Compatibility only: older OpenCode servers did not expose connected inventory.
  const legacyResponse = await fetch(new URL('/api/model', baseUrl), {
    signal: AbortSignal.timeout(4000),
  });
  if (!legacyResponse.ok) {
    throw new Error(
      `OpenCode /api/model returned ${legacyResponse.status}: ${await safeText(legacyResponse)}`,
    );
  }
  const configuredProviders = await configuredProviderIds(baseUrl);
  return {
    models: normalizeLegacyOpenCodeCatalog(
      await legacyResponse.json(),
      configuredProviders,
    ),
    ...(configuredProviders
      ? { connectedProviders: configuredProviders }
      : {}),
  };
}

function preserveOpenCodeCurrentModel(
  models: readonly ModelOption[],
  current?: SessionInfo['currentModel'],
  connectedProviders?: ReadonlySet<string>,
): ModelOption[] {
  const byKey = new Map(
    models.map((model) => [
      modelKey(model.providerID, model.modelID, model.variant),
      model,
    ]),
  );
  if (
    !current ||
    byKey.size >= OPENCODE_MAX_MODEL_OPTIONS ||
    (connectedProviders && !connectedProviders.has(current.providerID))
  ) {
    return [...byKey.values()];
  }
  const exact = modelKey(
    current.providerID,
    current.modelID,
    current.variant,
  );
  const hasBase = [...byKey.values()].some(
    (model) =>
      model.providerID === current.providerID &&
      model.modelID === current.modelID,
  );
  if (!byKey.has(exact) && (current.variant || !hasBase)) {
    const option = modelOptionsOf({
      providerID: current.providerID,
      modelID: current.modelID,
      name: current.label ?? current.modelID,
      variant: current.variant,
    })[0];
    if (option) byKey.set(exact, option);
  }
  return [...byKey.values()];
}

function modelKey(providerID: string, modelID: string, variant?: string): string {
  const variantKey = variant ?? '';
  return `${providerID}\0${modelID}\0${variantKey}`;
}

function modelBaseKey(providerID: string, modelID: string): string {
  return `${providerID}\0${modelID}`;
}

function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function resolveBin(bin: string): string | null {
  const paths = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const p of paths) {
    const full = join(p, bin);
    try {
      if (existsSync(full)) return full;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}

async function configuredProviderIds(baseUrl: string): Promise<Set<string> | null> {
  try {
    const r = await fetch(new URL('/config/providers', baseUrl), { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const raw = await r.json();
    const src = raw?.data ?? raw?.providers ?? raw;
    const ids = new Set<string>();
    if (Array.isArray(src)) {
      for (const p of src.slice(0, OPENCODE_MAX_CONNECTED_PROVIDERS)) {
        const id = typeof p === 'string' ? p : p?.id ?? p?.providerID ?? p?.providerId ?? p?.name;
        if (typeof id === 'string' && id.trim()) ids.add(id.trim());
      }
    } else if (src && typeof src === 'object') {
      for (const [id, value] of boundedObjectEntries(
        src,
        OPENCODE_MAX_CONNECTED_PROVIDERS,
      )) {
        if (id && value !== false && value != null) ids.add(id);
      }
    }
    return ids.size ? ids : null;
  } catch {
    return null;
  }
}

/** Friendly notice for a 409 from revert/unrevert: a busy session vs nothing left to undo/redo. */
function revert409Notice(body: string, op: 'undo' | 'redo'): string {
  if (/busy/i.test(body)) return 'Session is busy — wait for the turn to finish, then try again.';
  return op === 'undo' ? 'Nothing more to undo.' : 'Nothing to redo.';
}
