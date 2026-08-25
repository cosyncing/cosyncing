/**
 * Codex adapter — integrationKind 'jsonrpc-stdio'; attach modes: RESUME + OBSERVE.
 *
 * Codex (codex-cli) persists every session as an append-only rollout JSONL under
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl (default: ~/.codex)
 * Each line is `{timestamp, type, payload}` with `type` ∈ session_meta | response_item | event_msg |
 * turn_context | compacted. Observe replays this file as history and live-follows appended lines — no
 * daemon, no spawned process, no model cost: the dependable surface that makes the app "never empty"
 * for Codex. Resume/live (drive a turn) need `codex app-server` over a broker-owned stdio process and
 * are a later increment — see docs/protocol/adapter-support.md
 *
 * Mapping is DOUBLE-FREE by design: the same content appears as both an `event_msg/*` (the UI event)
 * and a `response_item/*` (the model's turn item). We take TEXT/reasoning/user from `event_msg`, tool
 * calls/results from `response_item/{function_call,function_call_output}`, and correlate the rich
 * `event_msg/{patch_apply_end,exec_command_end}` detail onto the matching tool-result by `call_id`
 * (enrichment, never a second bubble). Keys are the rollout LINE INDEX, so a history copy and a
 * live-tailed copy of the same line dedupe in the app (the observe attach-window race is harmless).
 *
 * Resume uses a broker-owned `codex app-server --stdio` JSONL process. The live app-server stream is
 * NOT the rollout shape: it emits v2 `item/*` notifications plus text deltas, while optional raw
 * response items are a second channel. The resume mapper ignores raw response items and maps v2
 * items directly to the existing canonical message union.
 */
import { createHash, randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import {
  existsSync,
  fstatSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  watch,
  mkdirSync,
  writeFileSync,
  realpathSync,
  type FSWatcher,
} from 'node:fs';
import { join, basename, dirname, extname, resolve } from 'node:path';
import {
  createJsonlSplitter,
  PRODUCT_IDENTITY,
  summarizeDiff,
  splitUnifiedDiffFiles,
  fileChangesOperation,
  gitDiffPath,
  isRestoreDriveAttachReason,
  AgentOwnedSessionError,
  NativeSessionUnresumableError,
  OwnershipConflictError,
  type AgentBackend,
  type AttachOptions,
  type FileChange,
  type FileOperation,
  type AgentCapabilities,
  type AgentMessage,
  type AgentMessageHandler,
  type AttachMode,
  type CommandResult,
  type CommandInput,
  type FileInput,
  type HistorySnapshotCapture,
  type HistorySnapshotPageRead,
  type HistorySnapshotPageReader,
  type HistorySnapshotRefusal,
  type HistorySnapshotSink,
  type HistorySourceIdentity,
  type ModeOption,
  type ManagedRuntimeStartReporter,
  type ModelOption,
  type PermissionDecision,
  type PlanSemantic,
  type PromptInput,
  type SessionConnection,
  type SessionControlState,
  type SessionDiscoveryOptions,
  type SessionLaunchSurface,
  type SessionInfo,
  type SessionTerminalAction,
  type SessionTerminalPresence,
  type AgentSetupDiagnosis,
  type SetupDiagnosisContext,
  type SlashCommand,
  type ToolCommandState,
  type ToolDisplayClass,
  type ToolSemantic,
  type Unsubscribe,
  boundToolSemantic,
  boundedStream,
  bunSpawnResolvedInvocation,
  clipTailBytes,
  commandSemantic,
  webSemantic,
  COMMAND_MAX_CHARS,
  COMMAND_STREAM_MAX_BYTES,
  PATH_MAX_CHARS,
  resolveInvocation,
} from '@cosyncing/adapter-api';
import {
  CODEX_TUI_BIRTH_WINDOW_MS,
  type CodexTuiScan,
  type CodexMacConfiguredExecutable,
  codexAttachedTuisAsync,
  resolveCodexMacConfiguredExecutable,
} from './tui-presence.ts';
import { diagnoseCodexSetup } from './diagnostics.ts';
import {
  codexBaselineSourceIntact,
  codexSeedContextCouldDemote,
  codexTurnStartGeneration,
  decideCodexObserveRunState,
  decideCodexRunStateRepair,
  readCodexNativeRunEvidence,
} from './run-state-repair.ts';

const CODEX_HOME = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
const SESSIONS_ROOT = join(CODEX_HOME, 'sessions');
const SESSION_INDEX = join(CODEX_HOME, 'session_index.jsonl');
const DEFAULT_APP_SERVER_CONTROL_SOCK = join(CODEX_HOME, 'app-server-control', 'app-server-control.sock');
const ROLLOUT_STATUS_CHUNK_BYTES = 128 * 1024;
const ROLLOUT_STATUS_MAX_RECORD_BYTES = 1024 * 1024;
const ROLLOUT_STATUS_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const ROLLOUT_STATUS_MAX_ELAPSED_MS = 250;
const ROLLOUT_AUTHORITY_SAMPLE_BYTES = 1024;
const ROLLOUT_AUTHORITY_CACHE_MAX = 8192;
const ROLLOUT_SURFACE_SCAN_BYTES = 1024 * 1024;
const LIVE_THREAD_CACHE_MS = 5000;
const CODEX_LOADED_ACTIVITY_MAX = 256;
const CODEX_NATIVE_ACTIVITY_FAILURE_GRACE_MS = 10_000;
const CODEX_SYNC_WATCH_MS = Math.max(250, Number(process.env.COSYNCING_CODEX_SYNC_WATCH_MS ?? 2500) || 2500);
const CODEX_SYNC_DROP_GRACE_POLLS = Math.max(1, Number(process.env.COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS ?? 2) || 2);
const CODEX_DEFAULT_PERMISSION_MODE = 'ask-permission';
const CODEX_RECENT_COMPLETED_TURN_LIMIT = 32;
const CODEX_RESUME_START_TIMEOUT_MS = 30_000;
const CODEX_RESUME_PROCESS_STOP_TIMEOUT_MS = 2_000;
type CodexTurnRunState = { kind: 'hydrating' } | { kind: 'unknown' } | { kind: 'idle' } | { kind: 'active'; turnId: string };
/** A live owner the adapter may ask to re-derive its run state from exact native evidence (R0c.4). */
type CodexRepairableOwner = {
  readonly info: SessionInfo;
  requestRunStateRepair(): Promise<void>;
};
type BootstrapQueuedMessage = { method: string; params: any; rpcId?: number | string };
type CodexCompletedTurnEvidence = { params: any; emitted: boolean };
export type CodexLoadedThreadDecision = 'loaded' | 'absent' | 'unknown';

/** Redacted, bounded attach diagnostics. No rollout paths, cwd, prompts, transcript
 *  bodies, credentials, or dynamic-tool schemas are admitted to this shape. */
export interface CodexAttachDiagnostic {
  event: 'daemon-loaded-probe' | 'transport-selected' | 'rpc-stage' | 'child-lifecycle';
  threadId: string;
  outcome?: string;
  transport?: CodexTransport;
  stage?: 'initialize' | 'thread/resume' | 'turn/start';
  pid?: number;
  pendingRpcCount?: number;
  nativeCode?: string;
  message?: string;
}

export type CodexAttachDiagnosticReporter = (diagnostic: CodexAttachDiagnostic) => void;

function emitCodexAttachDiagnostic(diagnostic: CodexAttachDiagnostic): void {
  if (!truthyEnv(process.env.COSYNCING_CODEX_ATTACH_DIAGNOSTICS)) return;
  try {
    console.error(`[codex-attach] ${JSON.stringify(diagnostic)}`);
  } catch {
    /* diagnostics never change attach behavior */
  }
}

/** Default mode for a session with NO recorded approval/reviewer/sandbox settings (fresh app-created threads,
 *  never-turned rollouts): maintainer wants approve-for-me, not the daemon's config default of "ask"
 *  (issues-part3 follow-up 2026-07-13). Asserted only on COLD loads we own — recorded rollout settings
 *  and already-loaded (terminal-live) threads are never overridden, and an explicit pick always wins.
 *  Overridable via COSYNCING_CODEX_DEFAULT_MODE (ask-permission | approve-for-me | full-access). */
const CODEX_DEFAULT_SESSION_MODE = ((): string => {
  const v = (process.env.COSYNCING_CODEX_DEFAULT_MODE ?? 'approve-for-me').trim();
  return v === 'ask-permission' || v === 'approve-for-me' || v === 'full-access' ? v : 'approve-for-me';
})();

const enc = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const dec = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

export class CodexAdapter implements AgentBackend {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  readonly capabilities = codexCapabilities();
  readonly integration = {
    managedRuntime: { kind: 'process', failureJournal: true },
  } as const;
  private liveThreadCache: { at: number; ids: Set<string> } | undefined;
  private liveActivityCache: { at: number; activities: Map<string, CodexThreadActivityStatus> } | undefined;
  /** Connections this adapter handed out and that are still open, for the R0c.4 owner self-check.
   *  Bounded by the number of live owners; every connection removes itself on close. */
  private readonly openOwners = new Set<CodexRepairableOwner>();

  constructor(private readonly options: {
    queryLoadedThreadIds?: () => Promise<Set<string>>;
    queryLoadedThreadActivities?: () => Promise<CodexLoadedThreadActivity[]>;
    scanCodexTuiPresence?: (sockPath: string, fresh?: boolean) => Promise<CodexTuiScan>;
    reportManagedStart?: ManagedRuntimeStartReporter;
    reportDaemonOwnership?: CodexDaemonOwnershipReporter;
    reportAttachDiagnostic?: CodexAttachDiagnosticReporter;
    resumeStartupTimeoutMs?: number;
    resumeProcessStopTimeoutMs?: number;
  } = {}) {}

  private reportAttachDiagnostic(diagnostic: CodexAttachDiagnostic): void {
    try {
      (this.options.reportAttachDiagnostic ?? emitCodexAttachDiagnostic)(diagnostic);
    } catch {
      /* diagnostics never change attach behavior */
    }
  }

  async isAvailable(): Promise<boolean> {
    return existsSync(SESSIONS_ROOT) || resolveBin('codex') !== null;
  }

  async diagnoseSetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
    return diagnoseCodexSetup(context);
  }

  canCreateSession(): boolean {
    return resolveBin('codex') !== null;
  }

  async listModels(): Promise<ModelOption[]> {
    const cwd = homedir();
    return withCodexAppServerRpc(cwd, async (rpc) => {
      const [config, response] = await Promise.all([
        rpc('config/read', { cwd, includeLayers: false }, 5000).catch(
          () => ({}),
        ),
        rpc(
          'model/list',
          { limit: CODEX_MAX_MODEL_OPTIONS, includeHidden: false },
          10000,
        ),
      ]);
      const provider = String(config?.config?.model_provider ?? 'openai');
      return codexModelOptions(response, provider);
    });
  }

  async createSession(opts: {
    directory?: string;
    title?: string;
    model?: PromptInput['model'];
  } = {}): Promise<SessionInfo> {
    const cwd = opts.directory?.trim() || homedir();
    if (!existsSync(cwd)) throw new Error(`Codex createSession directory does not exist: ${cwd}`);
    const started = await createCodexThread(cwd, opts.title, opts.model);
    const thread = started?.thread ?? {};
    const path = typeof thread.path === 'string' && thread.path ? thread.path : undefined;
    if (!path) throw new Error('Codex thread/start did not return a durable rollout path.');
    const threadId = String(thread.id ?? '');
    const actualCwd = String(started?.cwd ?? thread.cwd ?? cwd);
    const terminalSyncHint = this.syncHint(threadId, actualCwd, started?.model ? String(started.model) : undefined);
    const terminalPresence = classifyCodexTerminalPresence(
      await codexPresenceScanAsync(codexAppServerSock()),
      threadId,
      actualCwd,
      timestampToMs(thread.createdAt ?? started?.created_at ?? started?.startedAt),
    );
    const title = opts.title?.trim() || String(thread.name ?? '') || (actualCwd ? basename(actualCwd) : threadId.slice(0, 8) || 'Codex session');
    return {
      id: enc(path),
      tool: this.id,
      title,
      cwd: actualCwd,
      nativeId: threadId || undefined,
      launchSurface: 'app',
      status: 'idle',
      attachMode: 'observe',
      model: started?.model
        ? String(started.model)
        : opts.model?.modelID,
      currentModel: started?.model || opts.model
        ? {
            providerID: String(
              started?.modelProvider ?? opts.model?.providerID ?? 'openai',
            ),
            modelID: String(started?.model ?? opts.model?.modelID),
            // createCodexThread applies an explicit effort through the
            // schema-supported thread/settings/update RPC and rejects if that
            // update fails. Its successful selection therefore supersedes a
            // stale/default effort echoed by thread/start.
            reasoningEffort: opts.model?.reasoningEffort
              ?? (started?.reasoningEffort
                ? String(started.reasoningEffort)
                : undefined),
          }
        : undefined,
      createdAt: timestampToMs(thread.createdAt),
      updatedAt: timestampToMs(thread.updatedAt),
      terminalSyncHint,
      control: codexControlState({
        canResume: true,
        driveState: 'observing',
        terminalSyncActive: false,
        terminalSyncHint,
        terminalSyncPresence: terminalPresence,
        terminalSyncAction: 'join',
        syncEnabled: this.capabilities.supportsLiveAttach,
      }),
    };
  }

  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
    if (!existsSync(SESSIONS_ROOT)) return [];
    const titles = readSessionIndexTitles(); // id → thread_name (best-effort)
    const canResume = resolveBin('codex') !== null;
    ensureCodexDaemon(
      canResume ? resolveBin('codex') : null,
      this.options.reportManagedStart,
      this.options.reportDaemonOwnership,
    ); // sync-on-by-default needs the shared daemon up
    const [liveThreadIds, liveActivities, presenceScan] = await Promise.all([
      this.liveLoadedThreadIds(),
      this.liveLoadedThreadActivities(),
      // Through the seam, not the raw scanner: discovery-derived presence must classify with the
      // same evidence attach and repair classify with, injected harness included — round 4 made
      // presence a retirement gate, so a bypassed seam here turns hermetic suites host-dependent.
      this.presenceScan(),
    ]);
    const out: SessionInfo[] = [];
    let scannedFiles = 0;
    for (const full of findRollouts(SESSIONS_ROOT)) {
      // Cold authority recovery yields every 128 KiB. This outer yield still bounds the metadata/
      // surface work across many small rollouts that resolve without entering a long authority scan.
      if (++scannedFiles % 25 === 0) await new Promise((r) => setTimeout(r, 0));
      const st = statSafe(full);
      if (!st) continue;
      // Incremental discovery must apply its cutoff before decoding an old rollout. A daemon-loaded
      // thread is the one bounded exception: it is live native authority and still needs projection.
      const pathId = rolloutUuid(full);
      if (
        options?.updatedAfter !== undefined &&
        st.mtimeMs < options.updatedAfter &&
        !liveThreadIds.has(pathId)
      ) {
        continue;
      }
      const facts = await rolloutFacts(full, st); // meta (line 1: cwd + id) + surface + exact status, stat-cached
      const meta = facts.meta;
      const id = meta?.id ? String(meta.id) : pathId;
      options?.onWork?.({ kind: 'decode-file', source: full });
      // Tag-not-drop (issues-part3 subagent display): subagent/exec/vscode rollouts stay in the
      // roster payload with an `origin` tag; the app hides auto origins by default (Settings toggles).
      const originTag = codexSessionOrigin(meta);
      const cwd = meta?.cwd ? String(meta.cwd) : undefined;
      const surface = facts.surface;
      const launchSurface = facts.launchSurface;
      const terminalPresence = classifyCodexTerminalPresence(presenceScan, id, cwd, timestampToMs(meta?.timestamp));
      const name = (id && titles.get(id)) || (cwd ? `${basename(cwd)} · ${id.slice(0, 8)}` : basename(full));
      const liveLoaded = liveThreadIds.has(id);
      const agentOwned = codexAgentOwned(originTag.origin);
      const parentThreadId = originTag.parentThreadId;
      const status = qualifyCodexRolloutStatus(facts.rawStatus, {
        liveLoaded,
        nativeActivity: liveActivities.get(id),
        terminalPresence,
        agentOwned,
        parentLiveLoaded: parentThreadId ? liveThreadIds.has(parentThreadId) : false,
        parentNativeActivity: parentThreadId ? liveActivities.get(parentThreadId) : undefined,
        parentTerminalPresence: parentThreadId
          ? classifyCodexTerminalPresence(presenceScan, parentThreadId)
          : undefined,
      });
      const attachMode = agentOwned ? 'observe' : codexAttachMode(canResume, status, liveLoaded);
      const terminalSyncHint = this.syncHint(id, cwd, surface.model, agentOwned);
      out.push({
        id: enc(full), // base64url of the rollout path — attach re-opens the exact file (like Pi)
        tool: this.id,
        title: name,
        cwd,
        ...originTag,
        nativeId: id,
        launchSurface,
        model: surface.model,
        currentModel: surface.currentModel,
        currentMode: surface.currentMode,
        // Observe cannot infer needs-input from a file alone, but rollout task markers do expose
        // active-vs-idle for terminal-owned sessions.
        status,
        attachMode,
        updatedAt: st.mtimeMs,
        terminalSyncHint,
        control: codexControlState({
          canResume,
          // A daemon-loaded thread WITHOUT a shared terminal is app-driven through the live daemon
          // conn (the composer is the mutable path); with a shared terminal attached it is terminal-
          // owned and sync is the input path. Keying this on loaded alone left the composer gated shut
          // the moment the badge dropped (canPromptSession allows driving OR active-sync, not "live").
          driveState: liveLoaded ? (terminalPresence === 'shared' ? 'unavailable' : 'driving') : 'observing',
          agentOwned,
          terminalSyncActive: liveLoaded && terminalPresence === 'shared',
          terminalSyncPresence: terminalPresence,
          terminalSyncAction: 'join',
          terminalSyncHint,
          syncEnabled: this.capabilities.supportsLiveAttach,
        }),
      });
    }
    return out;
  }

  watchSessionInfo(onChange: (info: SessionInfo) => void): Unsubscribe {
    if (!this.capabilities.supportsLiveAttach) return () => {};
    let stopped = false;
    let initialized = false;
    let pollInFlight = false;
    let confirmedLive = new Set<string>();
    const missingPolls = new Map<string, number>();
    let lastPresenceKey = '';
    let lastActivityKey = '';
    let lastInfoKeys = new Map<string, string>();
    const readScan = async (): Promise<CodexTuiScan> => {
      const sock = codexAppServerSock();
      if (!sock) return emptyCodexTuiScan();
      return this.options.scanCodexTuiPresence
        ? this.options.scanCodexTuiPresence(sock)
        : codexAttachedTuisAsync(sock, undefined, {
            macConfiguredExecutable: macConfiguredCodexExecutableIdentity(),
          });
    };
    // Fingerprint of the TUI presence scan. A terminal join/exit usually changes NOTHING in the
    // loaded list (it is a one-way latch), so presence flips are only visible here. startedAt is
    // included because downgrade safety depends on not losing a live shared candidate.
    const presenceKey = (scan: CodexTuiScan): string => codexPresenceFingerprint(scan);
    const poll = async () => {
      if (pollInFlight || stopped || !existsSync(SESSIONS_ROOT)) return;
      pollInFlight = true;
      try {
        let observedLive: Set<string>;
        let activities: Map<string, CodexThreadActivityStatus>;
        let scan: CodexTuiScan;
        try {
          // Both probes are async. In particular, the presence path uses the coalesced async
          // socket diagnostic and never runs the synchronous `ss` probe from the watch timer.
          [observedLive, activities, scan] = await Promise.all([
            this.refreshLiveLoadedThreadIds(),
            this.refreshLiveLoadedThreadActivities(),
            readScan(),
          ]);
        } catch {
          // Probe failure is unknown, never an authoritative empty loaded list. Treating a socket/RPC
          // error as empty would synthesize a sync-degraded transition and downgrade live terminals.
          return;
        }
        if (stopped) return;
        // Exact native evidence for every open owner, on the interval that already exists.
        this.checkOpenOwnerRunStates(activities);
        if (!initialized) {
          confirmedLive = observedLive;
          lastPresenceKey = presenceKey(scan);
          lastActivityKey = codexActivityFingerprint(activities);
          const firstInfos = await this.sessionInfosForLiveIds(confirmedLive, scan, activities);
          if (stopped) return;
          lastInfoKeys = sessionInfoKeys(firstInfos);
          initialized = true;
          // R0c.4: publish the first derived state instead of only recording it. The watcher used to
          // seed its fingerprints silently, so after a broker restart an UNOWNED row kept whatever
          // the last discovery pass journaled until some later input edge happened to fire — the
          // watcher could observe the correct state and never say so. Publication is idempotent: the
          // revision journal records nothing for a row that already matches.
          //
          // Scoped to the daemon-loaded set, which is exactly what this poll's live probes ATTEST
          // to. The rest of the disk roster is discovery's to publish and is derived identically
          // there, so republishing it here would only duplicate a startup burst.
          for (const info of firstInfos) {
            if (confirmedLive.has(sessionInfoThreadId(info))) onChange(info);
          }
          return;
        }

        const changedLoadedIds = new Set<string>();
        const pk = presenceKey(scan);
        const presenceRefresh = codexPresenceRequiresFullWatchReemit(lastPresenceKey, pk);
        if (presenceRefresh) lastPresenceKey = pk;
        const ak = codexActivityFingerprint(activities);
        const activityRefresh = ak !== lastActivityKey;
        if (activityRefresh) lastActivityKey = ak;
        for (const id of confirmedLive) {
          if (observedLive.has(id)) {
            missingPolls.delete(id);
            continue;
          }
          const misses = (missingPolls.get(id) ?? 0) + 1;
          if (misses >= CODEX_SYNC_DROP_GRACE_POLLS) {
            missingPolls.delete(id);
            confirmedLive.delete(id);
            changedLoadedIds.add(id);
          } else {
            missingPolls.set(id, misses);
          }
        }
        for (const id of observedLive) {
          missingPolls.delete(id);
          if (!confirmedLive.has(id)) {
            confirmedLive.add(id);
            changedLoadedIds.add(id);
          }
        }

        if (!presenceRefresh && !activityRefresh && changedLoadedIds.size === 0) return;
        const nextInfos = await this.sessionInfosForLiveIds(confirmedLive, scan, activities);
        if (stopped) return;
        const nextInfoKeys = sessionInfoKeys(nextInfos);
        // Suppression is decided per session against what was actually PUBLISHED, never against the
        // input fingerprints above — those only decide when it is worth re-deriving. A row that is
        // computed but not published therefore keeps its previously published key and stays eligible.
        const published = new Map<string, string>();
        for (const info of nextInfos) {
          const threadId = sessionInfoThreadId(info);
          const nextKey = nextInfoKeys.get(threadId);
          const derivedChanged = lastInfoKeys.get(threadId) !== nextKey;
          // A loaded-set transition is itself a derived SessionInfo/control transition. Keep this
          // explicit guard so a future renderer-only change cannot accidentally suppress the
          // required affected-row notification.
          if (derivedChanged || changedLoadedIds.has(threadId)) {
            onChange(info);
            if (nextKey !== undefined) published.set(threadId, nextKey);
          } else if (nextKey !== undefined) {
            published.set(threadId, nextKey);
          }
        }
        // Rebuilt rather than merged, so rows whose rollouts disappeared cannot accumulate.
        lastInfoKeys = published;
      } finally {
        pollInFlight = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), CODEX_SYNC_WATCH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  private async sessionInfosForLiveIds(
    liveThreadIds: Set<string>,
    scan: CodexTuiScan = emptyCodexTuiScan(),
    activities: Map<string, CodexThreadActivityStatus> = new Map(),
  ): Promise<SessionInfo[]> {
    if (!existsSync(SESSIONS_ROOT)) return [];
    const titles = readSessionIndexTitles();
    const canResume = resolveBin('codex') !== null;
    const out: SessionInfo[] = [];
    for (const full of findRollouts(SESSIONS_ROOT)) {
      const st = statSafe(full);
      if (!st) continue;
      const facts = await rolloutFacts(full, st);
      const meta = facts.meta;
      const originTag = codexSessionOrigin(meta); // tag-not-drop (same contract as discoverSessions)
      const id = meta?.id ? String(meta.id) : rolloutUuid(full);
      const cwd = meta?.cwd ? String(meta.cwd) : undefined;
      const surface = facts.surface;
      const launchSurface = facts.launchSurface;
      const terminalPresence = classifyCodexTerminalPresence(scan, id, cwd, timestampToMs(meta?.timestamp));
      const liveLoaded = liveThreadIds.has(id);
      const agentOwned = codexAgentOwned(originTag.origin);
      const parentThreadId = originTag.parentThreadId;
      const status = qualifyCodexRolloutStatus(facts.rawStatus, {
        liveLoaded,
        nativeActivity: activities.get(id),
        terminalPresence,
        agentOwned,
        parentLiveLoaded: parentThreadId ? liveThreadIds.has(parentThreadId) : false,
        parentNativeActivity: parentThreadId ? activities.get(parentThreadId) : undefined,
        parentTerminalPresence: parentThreadId
          ? classifyCodexTerminalPresence(scan, parentThreadId)
          : undefined,
      });
      const terminalSyncHint = this.syncHint(id, cwd, surface.model, agentOwned);
      out.push({
        id: enc(full),
        tool: this.id,
        title: (id && titles.get(id)) || (cwd ? `${basename(cwd)} · ${id.slice(0, 8)}` : basename(full)),
        cwd,
        ...originTag,
        nativeId: id,
        launchSurface,
        model: surface.model,
        currentModel: surface.currentModel,
        currentMode: surface.currentMode,
        status,
        attachMode: agentOwned ? 'observe' : codexAttachMode(canResume, status, liveLoaded),
        updatedAt: st.mtimeMs,
        terminalSyncHint,
        control: codexControlState({
          canResume,
          // A daemon-loaded thread WITHOUT a shared terminal is app-driven through the live daemon
          // conn (the composer is the mutable path); with a shared terminal attached it is terminal-
          // owned and sync is the input path. Keying this on loaded alone left the composer gated shut
          // the moment the badge dropped (canPromptSession allows driving OR active-sync, not "live").
          driveState: liveLoaded ? (terminalPresence === 'shared' ? 'unavailable' : 'driving') : 'observing',
          agentOwned,
          terminalSyncActive: liveLoaded && terminalPresence === 'shared',
          terminalSyncPresence: terminalPresence,
          terminalSyncAction: 'join',
          terminalSyncHint,
          syncEnabled: this.capabilities.supportsLiveAttach,
        }),
      });
    }
    return out;
  }

  /** Native rename via `thread/name/set` — propagates to the codex TUI/session index, not just our
   *  roster alias (issues-part2 rename check). Short-lived app-server RPC; the rollout stays put. */
  async renameSession(sessionId: string, title: string | null): Promise<SessionInfo> {
    const path = dec(sessionId);
    const meta = readSessionMeta(path);
    const threadId = meta?.id ? String(meta.id) : rolloutUuid(path);
    const cwd = meta?.cwd ? String(meta.cwd) : process.cwd();
    if (!threadId) throw new Error('Codex rename: could not resolve the thread id from the rollout.');
    const name = (title ?? '').trim() || basename(cwd);
    await withCodexAppServerRpc(cwd, async (rpc) => {
      await rpc('thread/name/set', { threadId, name }, 10000);
    });
    const st = statSafe(path);
    const originTag = codexSessionOrigin(meta);
    const agentOwned = codexAgentOwned(originTag.origin);
    const canResume = resolveBin('codex') !== null;
    const terminalSyncHint = this.syncHint(threadId, cwd, undefined, agentOwned);
    // thread/name/set acknowledges success but returns no Thread. The submitted
    // normalized name is therefore the immediate native title authority; do
    // not rediscover the index and risk returning its delayed old value.
    return {
      id: sessionId,
      tool: this.id,
      title: name,
      cwd,
      ...originTag,
      nativeId: threadId,
      status: 'idle',
      attachMode: 'observe',
      createdAt: timestampToMs(meta?.timestamp) ?? st?.birthtimeMs ?? st?.ctimeMs,
      updatedAt: st?.mtimeMs,
      terminalSyncHint,
      control: codexControlState({
        canResume,
        driveState: 'observing',
        agentOwned,
        terminalSyncActive: false,
        terminalSyncAction: 'join',
        terminalSyncHint,
        syncEnabled: this.capabilities.supportsLiveAttach,
      }),
    };
  }

  /** Native fork via app-server `thread/fork` — forks the loaded rollout into a NEW thread (new rollout
   *  path, `forkedFromId` set) so the app and terminal never write the same transcript. Codex forks the
   *  whole thread at head (no message-point param), i.e. clone-at-head semantics; the `messageId` opt is
   *  therefore ignored. The forked rollout is forced to disk before we return so the immediate attach can
   *  find it. Command-surface action (maintainer §4.6): no button, honest evidence D,L0. */
  async forkSession(sessionId: string, _opts: { messageId?: string | null } = {}): Promise<SessionInfo> {
    const path = dec(sessionId);
    const meta = readSessionMeta(path);
    const threadId = meta?.id ? String(meta.id) : rolloutUuid(path);
    const cwd = meta?.cwd ? String(meta.cwd) : process.cwd();
    if (!threadId) throw new Error('Codex fork: could not resolve the thread id from the rollout.');
    // Refuse the USER-INITIATED fork of a child thread, ABOVE `forkCodexThread` — the same shape as
    // `attach()`: no app-server RPC, no spawn, no new rollout on disk before it fails. Forking a child
    // could only ever produce another permanently Observe-only thread and drop the user into it, so the
    // honest answer is "no", not "yes, into a dead end".
    //
    // SCOPE — this blocks OUR fork route only (client Fork button → broker POST …/fork → here). Codex
    // implements its own subagent spawn as an internal `thread/fork` inside the codex process; that never
    // enters this adapter, and nothing here can or should constrain it (maintainer, 2026-07-25: "not
    // blocked in the codex side, since maybe codex later on will perform fork for its subagent itself…
    // but for user initiated fork, should be blocked"). Do not widen this into the app-server client
    // (`forkCodexThread`) or into any discovery/roster path.
    //
    // TYPED, not a plain Error: the broker's own route gate answers this with 409 SESSION_AGENT_OWNED,
    // but only when `discoverSession()` could see the source. When it could not (a rollout outside the
    // discovered tree, a stale/absent roster row, a peer-served row) this refusal is the ONLY one, and
    // an untyped throw fell into the route's catch-all `502 native session fork failed` — a transient-
    // sounding answer to a permanent capability boundary, which invites a retry that can never work.
    // NOT an OwnershipConflictError: that advertises a competing owner to take over from, and there is
    // no other owner here — the capability simply does not exist for a child thread.
    if (codexAgentOwned(codexSessionOrigin(meta).origin)) {
      throw new AgentOwnedSessionError(`Codex subagent threads cannot be forked. ${CODEX_AGENT_OWNED_DRIVE_REASON}`, 'fork');
    }
    const forked = await forkCodexThread(cwd, threadId);
    const thread = forked?.thread ?? {};
    const newPath = typeof thread.path === 'string' && thread.path ? thread.path : undefined;
    if (!newPath) throw new Error('Codex thread/fork did not return a durable rollout path.');
    const actualCwd = String(forked?.cwd ?? thread.cwd ?? cwd);
    const baseTitle = meta?.name ? String(meta.name) : basename(actualCwd) || threadId.slice(0, 8);
    const title = (typeof thread.name === 'string' && thread.name) ? thread.name : `${baseTitle} (fork)`;
    // DEFENCE IN DEPTH, now that an agent-owned SOURCE is refused above. What is left to cover is the
    // fork whose OWN meta comes back agent-owned from a source that was not: the app-server decides what
    // the new rollout's `session_meta` says, so a future codex could mark an app-requested fork of a
    // normal thread as a child (a spawn-shaped fork, `originator` policy change, …) and discovery would
    // then call Observe-only a row we had already handed the client as drivable.
    // This row is returned straight to the client, so it must carry BOTH halves of what that discovery
    // would say: the tag-not-drop `origin`/`parentThreadId` fields, and the suppressed capabilities that
    // follow from them. Untagged-but-suppressed is the worst of the two — the client would see an
    // ordinary session whose Drive is mysteriously gone, and the tag would only appear on the next
    // roster rebuild. Both metas are still folded (`thread/fork` COPIES source provenance into the new
    // rollout on this machine's forks: user→user, marker-absent→marker-absent — never defaulted), so the
    // source arm stays as a second floor under the up-front refusal rather than its only enforcement.
    const forkTag = codexSessionOrigin(readSessionMeta(newPath));
    const sourceTag = codexSessionOrigin(meta);
    const originTag =
      forkTag.origin === 'subagent' ? forkTag : sourceTag.origin === 'subagent' ? sourceTag : forkTag.origin ? forkTag : sourceTag;
    const agentOwned = codexAgentOwned(originTag.origin);
    const terminalSyncHint = this.syncHint(String(thread.id ?? ''), actualCwd, undefined, agentOwned);
    return {
      id: enc(newPath),
      tool: this.id,
      title,
      // Lineage = the PARENT thread this was forked from (`forkedFromId`), not the fork's own
      // `sessionId` (which the app-server sets to the fork's new uuid, not a shared tree id — verified
      // against codex 0.142.5; Fable review 2026-07-08 #2). Omitted if the runtime didn't report it.
      ...(thread.forkedFromId ? { lineageId: String(thread.forkedFromId) } : {}),
      ...originTag, // tag-not-drop: the fork carries the provenance it inherited, from its first row on
      cwd: actualCwd,
      launchSurface: 'app',
      status: 'idle',
      attachMode: 'observe',
      model: forked?.model ? String(forked.model) : undefined,
      currentModel: forked?.model
        ? {
            providerID: String(forked.modelProvider ?? 'openai'),
            modelID: String(forked.model),
            reasoningEffort: forked?.reasoningEffort ? String(forked.reasoningEffort) : undefined,
          }
        : undefined,
      createdAt: timestampToMs(thread.createdAt),
      updatedAt: timestampToMs(thread.updatedAt),
      terminalSyncHint,
      control: codexControlState({
        canResume: true,
        driveState: 'observing',
        agentOwned,
        terminalSyncActive: false,
        terminalSyncHint,
        terminalSyncPresence: 'absent',
        terminalSyncAction: 'join',
        syncEnabled: this.capabilities.supportsLiveAttach,
      }),
    };
  }

  async attach(sessionId: string, mode?: AttachMode, opts?: AttachOptions): Promise<SessionConnection> {
    const path = dec(sessionId);
    const meta = readSessionMeta(path);
    const cwd = meta?.cwd ? String(meta.cwd) : undefined;
    const threadId = meta?.id ? String(meta.id) : rolloutUuid(path);
    const surface = codexSessionSurface(path, meta);
    const launchSurface = codexRolloutLaunchSurface(meta);
    const originTag = codexSessionOrigin(meta);
    const agentOwned = codexAgentOwned(originTag.origin);
    const restorationAttempt = mode === 'resume' && !!opts?.reason && isRestoreDriveAttachReason(opts.reason);
    // A permanent capability boundary, so a plain Error (an OwnershipConflictError would advertise a
    // contended owner the caller could take over from). Refused ABOVE the daemon probe and every
    // resolveBin/spawn path: a driving attach on a child thread must not start a process or reach an
    // owner before it fails, whatever routed here (including reason-tagged Drive restores).
    if (agentOwned && (mode === 'resume' || mode === 'live')) {
      throw new Error(`Codex subagent threads are Observe-only. ${CODEX_AGENT_OWNED_DRIVE_REASON}`);
    }
    if (mode === 'live' && !this.capabilities.supportsLiveAttach) {
      throw new Error('Codex sync server mode is not enabled; set COSYNCING_CODEX_SYNC_SERVER=1 after configuring the app-server daemon.');
    }
    const loadedDecision = this.capabilities.supportsLiveAttach
      ? await this.liveLoadedDecision(threadId, mode === 'resume' || mode === 'live')
      : 'absent';
    this.reportAttachDiagnostic({
      event: 'daemon-loaded-probe',
      threadId,
      outcome: loadedDecision,
    });
    if ((mode === 'resume' || mode === 'live') && loadedDecision === 'unknown') {
      throw new OwnershipConflictError(
        'Codex daemon ownership could not be verified. This session stays in Observe; no private app-server was started.',
        'daemon-ownership-unknown',
      );
    }
    const liveLoaded = loadedDecision === 'loaded';
    if (mode === 'live' && !liveLoaded) {
      throw new Error('This Codex thread is not loaded in the managed app-server daemon; start or attach the terminal through Codex remote-control first.');
    }
    if (mode === 'resume' && liveLoaded) {
      // Ownership fact, not a generic failure: active daemon-level terminal sync always wins.
      // A reason-tagged attach downgrades to joining that owner at the broker; a mode-only
      // attach keeps this as the established hard failure.
      throw new OwnershipConflictError('This Codex thread is already using true terminal sync; Drive is unavailable for daemon-loaded threads.', 'terminal-sync-active');
    }
    // `!agentOwned`: a mode-less attach silently becomes the mutable daemon-proxy owner once the thread
    // is daemon-loaded (the roster's sync-upgrade reattach takes exactly that route), which would drive
    // a child thread without any caller asking for Drive. It stays a read-only Observe conn instead.
    const liveEligible = !agentOwned && liveLoaded && mode !== 'observe' && mode !== 'resume';
    if (mode === 'resume' && !liveEligible && resolveBin('codex') === null) {
      throw new Error('Codex CLI is not available on PATH; cannot Drive this session.');
    }
    const observe = mode === 'observe' || (!liveEligible && mode !== 'resume');
    const terminalSyncHint = this.syncHint(threadId, cwd, surface.model, agentOwned);
    // Restoration is a control decision, not a badge refresh. It must bypass a cached absence so a
    // terminal that appeared inside the normal 2-second display TTL cannot be overwritten.
    const presenceScan = await this.presenceScan(restorationAttempt);
    const terminalPresence = classifyCodexTerminalPresence(presenceScan, threadId, cwd, timestampToMs(meta?.timestamp));
    const liveActivities = await this.liveLoadedThreadActivities();
    const parentThreadId = originTag.parentThreadId;
    const st = statSafe(path);
    const rolloutStatus = st ? (await rolloutFacts(path, st)).rawStatus : 'idle';
    const qualification: CodexRolloutQualificationContext = {
      liveLoaded,
      nativeActivity: liveActivities.get(threadId),
      terminalPresence,
      agentOwned,
      parentLiveLoaded: parentThreadId ? this.liveThreadCache?.ids.has(parentThreadId) ?? false : false,
      parentNativeActivity: parentThreadId ? liveActivities.get(parentThreadId) : undefined,
      parentTerminalPresence: parentThreadId
        ? classifyCodexTerminalPresence(presenceScan, parentThreadId)
        : undefined,
    };
    const qualifiedRolloutStatus = qualifyCodexRolloutStatus(rolloutStatus, qualification);
    if (restorationAttempt && terminalPresence !== 'absent') {
      // An automatic restore must PROVE it is safe. A private terminal writing this rollout,
      // unprovable presence, or shared evidence without a loaded thread are all competing-owner
      // facts; fail closed to Observe and leave the explicit user-confirmed Take over path as
      // the recovery. This check runs inside the Hub's single owner-creating call, so it is
      // atomic with the decision to spawn the Resume owner.
      throw new OwnershipConflictError(
        terminalPresence === 'private'
          ? 'A terminal is running this Codex session privately; Drive was not restored automatically.'
          : terminalPresence === 'shared'
            ? 'A terminal appears attached to this Codex session; Drive was not restored automatically.'
            : 'Terminal presence for this Codex session could not be verified; Drive was not restored automatically.',
        `terminal-${terminalPresence}`,
      );
    }
    const info: SessionInfo = {
      id: sessionId,
      tool: this.id,
      title: cwd ? `${basename(cwd)}` : basename(path),
      cwd,
      ...originTag, // an OPEN subagent/exec session keeps its tag on pushed frames
      nativeId: threadId,
      launchSurface,
      model: surface.model,
      currentModel: surface.currentModel,
      currentMode: surface.currentMode,
      status: qualifiedRolloutStatus,
      attachMode: observe ? 'observe' : liveEligible ? 'live' : 'resume',
      terminalSyncHint,
      control: codexControlState({
        canResume: resolveBin('codex') !== null,
        // A live daemon conn without a terminal attached is app-driven (composer mutable); with a
        // terminal it is terminal-owned and active sync is the input path.
        driveState: liveEligible
          ? (terminalPresence === 'shared' ? 'unavailable' : 'driving')
          : observe
            ? 'observing'
            : 'driving',
        agentOwned,
        terminalSyncActive: liveEligible && terminalPresence === 'shared',
        terminalSyncPresence: terminalPresence,
        terminalSyncAction: 'join',
        terminalSyncHint,
        syncEnabled: this.capabilities.supportsLiveAttach,
      }),
    };
    if (observe) {
      const observeConn = new CodexObserveConnection(
        path,
        info,
        qualification,
        () => this.freshQualification({
          threadId,
          parentThreadId,
          agentOwned,
          cwd,
          createdAtMs: timestampToMs(meta?.timestamp),
        }),
      );
      await observeConn.start();
      return this.trackOwner(observeConn);
    }
    const transport = liveEligible ? 'daemon-proxy' : 'stdio';
    this.reportAttachDiagnostic({ event: 'transport-selected', threadId, transport });
    const conn = new CodexResumeConnection(
      path,
      threadId,
      cwd,
      info,
      transport,
      (diagnostic) => this.reportAttachDiagnostic(diagnostic),
      this.options.resumeStartupTimeoutMs,
      this.options.resumeProcessStopTimeoutMs,
    );
    await conn.start();
    return this.trackOwner(conn);
  }

  /** Register a live owner for the run-state self-check and unregister it on close. Wrapping
   *  `close` keeps the registry exact without a second lifecycle to keep in sync. */
  private trackOwner<T extends SessionConnection & CodexRepairableOwner>(conn: T): T {
    this.openOwners.add(conn);
    const close = conn.close.bind(conn);
    conn.close = async () => {
      this.openOwners.delete(conn);
      await close();
    };
    return conn;
  }

  /**
   * Re-take EVERY dynamic input `qualifyCodexRolloutStatus` consults, at ONE instant, bypassing
   * every cache (R0c.4 round 3).
   *
   * The qualifier weighs daemon-loaded state, exact native activity, and terminal presence — for a
   * subagent, its parent's too. Refreshing only the activity left the presence classification stale,
   * so a TUI that appeared inside the attach window was still read as `absent` and demoted a start
   * marker the scan had just found. Anything unprovable becomes an explicit unknown rather than a
   * false negative: a failed daemon probe cannot prove idle, and a failed presence scan cannot prove
   * no terminal owns the rollout.
   */
  private async freshQualification(target: {
    threadId: string;
    parentThreadId?: string;
    agentOwned: boolean;
    cwd?: string;
    createdAtMs?: number;
  }): Promise<CodexRolloutQualificationContext> {
    const base: CodexRolloutQualificationContext = {
      liveLoaded: false,
      nativeActivity: 'unknown',
      terminalPresence: 'unknown',
      agentOwned: target.agentOwned,
    };
    if (!this.capabilities.supportsLiveAttach) return base;
    const [ids, activities, scan] = await Promise.all([
      this.refreshLiveLoadedThreadIds().then((value) => value, () => undefined),
      this.refreshLiveLoadedThreadActivities().then((value) => value, () => undefined),
      this.presenceScan().then((value) => value, () => undefined),
    ]);
    // Either daemon probe failing makes the whole daemon side unprovable: reporting "not loaded"
    // from a failed probe would hand the qualifier a fabricated absence of an owner.
    const daemon = ids !== undefined && activities !== undefined ? { ids, activities } : undefined;
    const presence = (threadId: string): SessionTerminalPresence => scan
      ? classifyCodexTerminalPresence(scan, threadId, target.cwd, target.createdAtMs)
      : 'unknown';
    return {
      liveLoaded: daemon?.ids.has(target.threadId) ?? false,
      nativeActivity: daemon ? daemon.activities.get(target.threadId) : 'unknown',
      terminalPresence: presence(target.threadId),
      agentOwned: target.agentOwned,
      ...(target.parentThreadId
        ? {
            parentLiveLoaded: daemon?.ids.has(target.parentThreadId) ?? false,
            parentNativeActivity: daemon ? daemon.activities.get(target.parentThreadId) : 'unknown',
            parentTerminalPresence: presence(target.parentThreadId),
          }
        : {}),
    };
  }

  /**
   * The R0c.4 owner self-check, riding the EXISTING watcher poll (no new cadence, timer, or probe).
   *
   * The broker's publication boundary only hands a contradiction to the owner when the watcher
   * actually publishes one, and a session whose native activity has been steadily Working since
   * before the owner latched Idle produces no watcher edge at all. This closes that case: the
   * activity map the poll already fetched is exact native evidence, and any open owner whose
   * published run state disagrees with it is asked to re-derive. The owner still decides — this
   * passes no status, only the fact that a contradiction exists.
   */
  private checkOpenOwnerRunStates(activities: Map<string, CodexThreadActivityStatus>): void {
    if (this.openOwners.size === 0) return;
    for (const owner of this.openOwners) {
      const threadId = owner.info.nativeId;
      if (!threadId) continue;
      const activity = activities.get(threadId);
      if (activity !== 'idle' && activity !== 'working' && activity !== 'needs-input') continue;
      const nativeInFlight = activity !== 'idle';
      if (nativeInFlight === (owner.info.status !== 'idle')) continue;
      void owner.requestRunStateRepair().catch(() => {});
    }
  }

  private async liveLoadedThreadIds(): Promise<Set<string>> {
    if (!this.capabilities.supportsLiveAttach) return new Set();
    if (this.liveThreadCache && Date.now() - this.liveThreadCache.at < LIVE_THREAD_CACHE_MS) return this.liveThreadCache.ids;
    try {
      return await this.refreshLiveLoadedThreadIds();
    } catch {
      // Discovery remains available while the daemon probe is transiently unhealthy, but we do not
      // overwrite a last-known loaded set with fabricated emptiness.
      return this.liveThreadCache?.ids ?? new Set();
    }
  }

  private async refreshLiveLoadedThreadIds(): Promise<Set<string>> {
    const ids = await (this.options.queryLoadedThreadIds ?? queryCodexLoadedThreadIds)();
    this.liveThreadCache = { at: Date.now(), ids };
    return ids;
  }

  private async liveLoadedThreadActivities(): Promise<Map<string, CodexThreadActivityStatus>> {
    if (!this.capabilities.supportsLiveAttach) return new Map();
    if (this.liveActivityCache && Date.now() - this.liveActivityCache.at < LIVE_THREAD_CACHE_MS) {
      return this.liveActivityCache.activities;
    }
    try {
      return await this.refreshLiveLoadedThreadActivities();
    } catch {
      // A point-in-time native status failure is unknown. Preserve a recent successful snapshot;
      // otherwise the rollout/process qualification below fails open rather than inventing Idle.
      const previous = this.liveActivityCache;
      return previous && Date.now() - previous.at <= CODEX_NATIVE_ACTIVITY_FAILURE_GRACE_MS
        ? previous.activities
        : new Map();
    }
  }

  private async refreshLiveLoadedThreadActivities(): Promise<Map<string, CodexThreadActivityStatus>> {
    // Existing tests inject only the older loaded-id seam. Do not reach the operator's real daemon
    // from those fixtures; absence from this map means unknown, not Idle.
    if (this.options.queryLoadedThreadIds && !this.options.queryLoadedThreadActivities) return new Map();
    const rows = await (this.options.queryLoadedThreadActivities ?? queryCodexLoadedThreadActivitiesStrict)();
    const activities = new Map(rows.map((row) => [row.id, row.status] as const));
    this.liveActivityCache = { at: Date.now(), activities };
    return activities;
  }

  private async liveLoadedDecision(threadId: string, requireCurrentProof = false): Promise<CodexLoadedThreadDecision> {
    const socket = codexAppServerSock();
    if (!this.options.queryLoadedThreadIds) {
      if (!socket || !existsSync(socket)) return 'absent';
      try {
        if (!lstatSync(socket).isSocket()) return 'unknown';
      } catch {
        // We already observed an entry at this path. Failure to establish its
        // type is not evidence that daemon ownership is absent.
        return 'unknown';
      }
    }
    const cached = this.liveThreadCache;
    // Display discovery may reuse a short-lived cache. A Drive/take-over
    // decision may not: cached non-membership cannot prove that a daemon did
    // not load the thread after the snapshot was taken.
    if (!requireCurrentProof && cached && Date.now() - cached.at < LIVE_THREAD_CACHE_MS) {
      return cached.ids.has(threadId) ? 'loaded' : 'absent';
    }
    try {
      return (await this.refreshLiveLoadedThreadIds()).has(threadId) ? 'loaded' : 'absent';
    } catch {
      // A last-known loaded thread remains potentially owned even after the
      // daemon stops answering. Cached non-membership is not equivalent: a
      // failed current probe cannot prove the thread stayed absent.
      return cached?.ids.has(threadId) ? 'loaded' : 'unknown';
    }
  }

  /** The top-level `codex resume --remote …` offer. Suppressed for an agent-owned child thread for the
   *  same reason its control state advertises no sync ({@link CODEX_AGENT_OWNED_SYNC_REASON}): the hint
   *  is a runnable join command that travels in the roster payload as its OWN field, so suppressing
   *  only `control.terminalSync` would leave it on the wire. (No client in this repo renders it today
   *  — the contract is what is being kept honest, not one renderer.) */
  private syncHint(threadId: string, cwd?: string, model?: string, agentOwned = false): SessionInfo['terminalSyncHint'] | undefined {
    if (!this.capabilities.supportsLiveAttach || agentOwned) return undefined;
    return codexTerminalSyncHint(threadId, cwd, model);
  }

  /** Attach-time presence evidence. Honors the injected test scanner so restore
   *  arbitration is deterministic under the fake-codex harness. */
  private async presenceScan(fresh = false): Promise<CodexTuiScan> {
    const sock = codexAppServerSock();
    if (this.options.scanCodexTuiPresence) {
      return sock ? this.options.scanCodexTuiPresence(sock, fresh) : emptyCodexTuiScan();
    }
    return codexPresenceScanAsync(sock, fresh);
  }

}

function codexCapabilities(): AgentCapabilities {
  const live = codexLiveSyncEnabled();
  return {
    integrationKind: 'jsonrpc-stdio',
    attachModes: live ? ['live', 'resume', 'observe'] : ['resume', 'observe'],
    supportsObserve: true,
    supportsResume: true,
    supportsLiveAttach: live,
    supportsCrossClientDriveSharing: true,
    supportsNativeArtifact: false,
    supportsNativeFileInput: true,
    supportsModelSwitch: true,
    permissionGranularity: 'per-tool',
  };
}

const CODEX_PERMISSION_MODES: ModeOption[] = [
  {
    value: 'ask-permission',
    label: 'Ask permission',
    category: 'ask-permission',
    description: 'Codex asks before untrusted commands and permission escalations; the workspace sandbox stays active.',
  },
  {
    value: 'approve-for-me',
    label: 'Approve for me',
    category: 'approve-for-me',
    description: 'Codex does not pause for approval prompts and uses the baseline safe sandbox policy.',
  },
  {
    value: 'full-access',
    label: 'Full access',
    category: 'full-access',
    description: 'Codex runs without approval prompts and switches the turn to danger-full-access. Use only for trusted sessions.',
  },
];

export function codexAttachMode(canResume: boolean, status: SessionInfo['status'], liveLoaded = false): AttachMode {
  if (liveLoaded) return 'live';
  void canResume;
  void status;
  // Resume is a broker-owned app-server driver, not terminal sync. Keep normal Codex rollouts
  // observe-first so opening a session never silently creates a second controller; Drive sends
  // ?mode=resume when the user explicitly accepts the takeover warning.
  return 'observe';
}

function codexLiveSyncEnabled(): boolean {
  // ON by default (issues-part2): the daemon is managed via `codex app-server daemon start`
  // (idempotent, see ensureCodexDaemon). Set COSYNCING_CODEX_SYNC_SERVER=0 to opt out.
  const v = (process.env.COSYNCING_CODEX_SYNC_SERVER ?? process.env.COSYNCING_CODEX_LIVE ?? '').trim();
  if (!v) return true;
  return truthyEnv(v);
}

function brokerClientInfo(): { name: string; title: string; version: string } {
  const version = process.env.COSYNCING_BROKER_BUILD_VERSION?.trim() || 'development';
  return { name: PRODUCT_IDENTITY.productName, title: PRODUCT_IDENTITY.productName, version };
}

// Fire-and-forget, once per broker lifetime: make sure the shared app-server daemon that terminal
// `codex resume --remote` sessions join is actually up. `daemon start` is a no-op when it already runs.
let _codexDaemonEnsured = false;
let _codexDaemonEnsureProcess: Bun.Subprocess | null = null;
let _codexDaemonEnsureCancelled: Bun.Subprocess | null = null;
function boundedStreamCapture(stream: ReadableStream<Uint8Array>, limit = 8 * 1024): {
  read: () => string;
  done: Promise<void>;
} {
  let value = '';
  const done = (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (value.length < limit) value += decoder.decode(next.value, { stream: true }).slice(0, limit - value.length);
      }
      if (value.length < limit) value += decoder.decode().slice(0, limit - value.length);
    } catch {
      /* process ended while the bounded diagnostic stream was draining */
    }
  })();
  return { read: () => value, done };
}

function notifyManagedStart(
  reporter: ManagedRuntimeStartReporter | undefined,
  failure?: Parameters<ManagedRuntimeStartReporter>[0],
): void {
  try { reporter?.(failure); } catch {
    /* diagnostic persistence must never break session discovery */
  }
}

/** Result of the pre-spawn daemon probe used to decide app-server ownership. */
export type CodexDaemonProbeOutcome = 'running' | 'absent' | 'unknown';

/**
 * Control-socket identity of the broker-started daemon. A replacement daemon recreates the socket file at
 * the same path (new inode/mtime), so a changed fingerprint proves the live daemon is not the recorded one.
 */
export interface CodexDaemonSocketFingerprint {
  dev: number;
  ino: number;
  mtimeMs: number;
}

/** Ownership evidence the broker persists so uninstall knows whether cosyncing started the daemon. */
export interface CodexDaemonOwnershipEvidence {
  startedByBroker: boolean;
  /** Fingerprint of the control socket right after the broker started the daemon (best-effort). */
  socket?: CodexDaemonSocketFingerprint;
}

/** Reporter the broker supplies to persist (or ignore) daemon ownership evidence; null → record nothing. */
export type CodexDaemonOwnershipReporter = (evidence: CodexDaemonOwnershipEvidence | null) => void;

/**
 * Pure ownership decision. Only a confidently-absent daemon that we then spawned is broker-owned; a
 * pre-existing ('running') daemon, an ambiguous ('unknown') probe, or a spawn we did not perform records
 * nothing (null). Absence of evidence is unknown ownership, and uninstall never stops on unknown.
 */
export function decideCodexDaemonOwnership(
  probe: CodexDaemonProbeOutcome,
  spawned: boolean,
): CodexDaemonOwnershipEvidence | null {
  return probe === 'absent' && spawned ? { startedByBroker: true } : null;
}

function notifyDaemonOwnership(
  reporter: CodexDaemonOwnershipReporter | undefined,
  evidence: CodexDaemonOwnershipEvidence | null,
): void {
  try { reporter?.(evidence); } catch {
    /* durable ownership-evidence persistence must never break session discovery */
  }
}

/**
 * Probe the daemon BEFORE `daemon start` so we can prove whether cosyncing started it. A missing control
 * socket is a confident "absent" (nothing is listening); a socket that answers `version` is a pre-existing
 * daemon; a present-but-unresponsive socket is "unknown" (stale/transient) and never claimed as ours.
 */
async function probeCodexDaemonForOwnership(): Promise<CodexDaemonProbeOutcome> {
  if (!codexAppServerSock()) return 'absent';
  try {
    return (await readCodexDaemonVersion()) ? 'running' : 'unknown';
  } catch {
    return 'unknown';
  }
}

function ensureCodexDaemon(
  bin: string | null,
  reporter?: ManagedRuntimeStartReporter,
  ownershipReporter?: CodexDaemonOwnershipReporter,
): void {
  if (_codexDaemonEnsured || !bin || !codexLiveSyncEnabled()) return;
  _codexDaemonEnsured = true;
  if (process.env.COSYNCING_CODEX_APP_SERVER_SOCK?.trim()) return; // explicitly pointed at an external daemon
  // Keep the broker-startup path non-blocking: the probe+spawn+ownership record all run in this async tail.
  void ensureCodexDaemonAsync(bin, reporter, ownershipReporter);
}

/**
 * Read-only stat of the resolved app-server control socket; undefined when the file is absent or not a
 * socket. Used to fingerprint the broker-started daemon so uninstall can prove instance identity.
 */
export function codexAppServerSocketFingerprint(): CodexDaemonSocketFingerprint | undefined {
  const explicit = process.env.COSYNCING_CODEX_APP_SERVER_SOCK?.trim();
  try {
    const stat = lstatSync(explicit || DEFAULT_APP_SERVER_CONTROL_SOCK);
    if (!stat.isSocket()) return undefined;
    return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

async function ensureCodexDaemonAsync(
  bin: string,
  reporter?: ManagedRuntimeStartReporter,
  ownershipReporter?: CodexDaemonOwnershipReporter,
): Promise<void> {
  const probe = await probeCodexDaemonForOwnership();
  if (probe === 'running') {
    // A pre-existing daemon is already up; `daemon start` would be a no-op and we do not own it.
    notifyDaemonOwnership(ownershipReporter, decideCodexDaemonOwnership(probe, false));
    notifyManagedStart(reporter); // the daemon is healthy — clear any stale start-failure evidence
    return;
  }
  try {
    const proc = spawnCodex(bin, ['app-server', 'daemon', 'start'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const stdout = boundedStreamCapture(proc.stdout);
    const stderr = boundedStreamCapture(proc.stderr);
    _codexDaemonEnsureProcess = proc;
    void proc.exited
      .then(async (code) => {
        await Promise.all([stdout.done, stderr.done]);
        if (_codexDaemonEnsureCancelled === proc) return;
        if (code === 0) {
          notifyManagedStart(reporter);
          // Only a confidently-absent daemon we then started is broker-owned; 'unknown' records nothing.
          // Attach the control-socket fingerprint so uninstall can later prove the live daemon is the same
          // instance (a user-started replacement recreates the socket and must never be stopped).
          const evidence = decideCodexDaemonOwnership(probe, true);
          if (evidence) {
            const socket = codexAppServerSocketFingerprint();
            notifyDaemonOwnership(ownershipReporter, socket ? { ...evidence, socket } : evidence);
          } else {
            notifyDaemonOwnership(ownershipReporter, null);
          }
        } else {
          notifyManagedStart(reporter, {
            detailCode: 'codex-daemon-start-exited',
            capturedOutput: `stdout:\n${stdout.read()}\nstderr:\n${stderr.read()}`,
          });
        }
      })
      .catch((error) => {
        if (_codexDaemonEnsureCancelled !== proc) {
          notifyManagedStart(reporter, {
            detailCode: 'codex-daemon-start-error',
            capturedOutput: String(error),
          });
        }
      })
      .finally(() => {
        if (_codexDaemonEnsureProcess === proc) _codexDaemonEnsureProcess = null;
        if (_codexDaemonEnsureCancelled === proc) _codexDaemonEnsureCancelled = null;
      });
  } catch (error) {
    notifyManagedStart(reporter, {
      detailCode: 'codex-daemon-start-spawn-error',
      capturedOutput: String(error),
    });
  }
}

/** Stop only the short-lived broker-spawned `daemon start` helper, never the persistent Codex daemon. */
export async function stopCodexDaemonEnsureProcess(graceMs = 1000): Promise<void> {
  const proc = _codexDaemonEnsureProcess;
  _codexDaemonEnsureProcess = null;
  if (!proc || proc.exitCode != null) return;
  _codexDaemonEnsureCancelled = proc;
  try {
    proc.kill();
    const killer = setTimeout(() => {
      try {
        proc.kill(9);
      } catch {
        /* already exited */
      }
    }, graceMs);
    await proc.exited;
    clearTimeout(killer);
  } catch {
    /* already exited */
  }
}

function truthyEnv(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
}

function codexAppServerSock(): string | undefined {
  const explicit = process.env.COSYNCING_CODEX_APP_SERVER_SOCK?.trim();
  if (explicit) return explicit;
  return existsSync(DEFAULT_APP_SERVER_CONTROL_SOCK) ? DEFAULT_APP_SERVER_CONTROL_SOCK : undefined;
}

function emptyCodexTuiScan(): CodexTuiScan {
  return {
    attributed: new Set(),
    unattributed: [],
    privateUnattributed: [],
    unknownUnattributed: [],
    privateThreadIds: new Set(),
    unknownThreadIds: new Set(),
    candidates: [],
    socketDiagAvailable: false,
    processScanAvailable: false,
  };
}

/** Async presence scan for discovery/create/open paths: the socket probe must never run a
 *  synchronous `ss` on the broker event loop (same rule as the watch poll). Shares the sync
 *  variant's TTL cache, so cached results stay consistent across both paths. */
async function codexPresenceScanAsync(sockPath?: string, fresh = false): Promise<CodexTuiScan> {
  const sock = sockPath?.trim() ? sockPath : codexAppServerSock();
  return sock ? codexAttachedTuisAsync(sock, undefined, {
    fresh,
    macConfiguredExecutable: macConfiguredCodexExecutableIdentity(),
  }) : emptyCodexTuiScan();
}

/** Resolve an explicit Codex override to both the invocation path and canonical executable target.
 * `null` is deliberate evidence: an override exists but cannot be mapped safely, so macOS absence
 * must remain unknown. Linux ignores this identity and retains its existing /proc behavior. */
function macConfiguredCodexExecutableIdentity(): CodexMacConfiguredExecutable | null | undefined {
  if (process.platform !== 'darwin') return undefined;
  return resolveCodexMacConfiguredExecutable(process.env.COSYNCING_CODEX_BIN);
}

function codexPresenceFingerprint(scan: CodexTuiScan): string {
  const setKey = (values: Set<string>) => [...values].sort().join(',');
  const compact = (value?: string) => value ?? '';
  const formatCandidates = (list: Array<{ pid: number; proof: string; cwd?: string; startedAtMs?: number; threadIds?: string[] }>) =>
    list
      .map((candidate) =>
        `${candidate.pid}|${candidate.proof}|${candidate.threadIds?.slice().sort().join(',') || '-'}|${compact(candidate.cwd)}|${candidate.startedAtMs ?? ''}`,
      )
      .sort()
      .join('^');
  const formatUnattributed = (list: Array<{ cwd?: string; startedAtMs?: number }>) =>
    list
      .map((candidate) => `${compact(candidate.cwd)}|${candidate.startedAtMs ?? ''}`)
      .sort()
      .join('^');

  return [
    `ps:${scan.processScanAvailable ? 1 : 0}`,
    `sd:${scan.socketDiagAvailable ? 1 : 0}`,
    `a:${setKey(scan.attributed)}`,
    `p:${setKey(scan.privateThreadIds)}`,
    `u:${setKey(scan.unknownThreadIds)}`,
    `ua:${formatUnattributed(scan.unattributed)}`,
    `pu:${formatUnattributed(scan.privateUnattributed)}`,
    `uu:${formatUnattributed(scan.unknownUnattributed)}`,
    `c:${formatCandidates(scan.candidates)}`,
  ].join('|');
}

function codexActivityFingerprint(activities: Map<string, CodexThreadActivityStatus>): string {
  return [...activities]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, status]) => `${id}:${status}`)
    .join('|');
}

export function codexPresenceRequiresFullWatchReemit(previousPresenceKey: string, nextPresenceKey: string): boolean {
  return previousPresenceKey !== nextPresenceKey;
}

function sessionInfoThreadId(info: SessionInfo): string {
  if (info.nativeId) return String(info.nativeId);
  try {
    return rolloutUuid(dec(info.id));
  } catch {
    return info.id;
  }
}

/** Stable derived-row snapshots for watch diffing. Raw TUI candidate identity (PID/start time)
 * is deliberately not compared directly: a replacement process can refresh the scan without
 * changing any session's derived presence/control state. */
function sessionInfoKeys(infos: SessionInfo[]): Map<string, string> {
  return new Map(infos.map((info) => [sessionInfoThreadId(info), JSON.stringify(info) ?? '']));
}

function codexRemoteAddr(): string {
  const explicit = process.env.COSYNCING_CODEX_REMOTE_ADDR?.trim();
  if (explicit) return explicit;
  return `unix://${process.env.COSYNCING_CODEX_APP_SERVER_SOCK?.trim() || DEFAULT_APP_SERVER_CONTROL_SOCK}`;
}

export function codexControlState(opts: {
  canResume: boolean;
  driveState: 'observing' | 'driving' | 'unavailable';
  /** The session is a child thread its parent agent owns ({@link codexAgentOwned}). Overrides every
   *  drive state: the capability is absent, not merely blocked by a current owner. */
  agentOwned?: boolean;
  terminalSyncActive: boolean;
  terminalSyncPresence?: SessionTerminalPresence;
  terminalSyncAction?: SessionTerminalAction;
  terminalSyncHint?: SessionInfo['terminalSyncHint'];
  syncEnabled: boolean;
}): SessionControlState {
  const terminalSyncPresence = opts.terminalSyncPresence;
  const terminalSyncActive = opts.terminalSyncActive && (terminalSyncPresence === undefined || terminalSyncPresence === 'shared');
  const drive = opts.agentOwned
    ? { supported: false, state: 'unavailable' as const, reason: CODEX_AGENT_OWNED_DRIVE_REASON }
    : opts.driveState === 'driving'
      ? { supported: true, state: 'driving' as const }
      : opts.driveState === 'unavailable'
        ? { supported: false, state: 'unavailable' as const, reason: 'This Codex session is already using true terminal sync; Drive is a takeover path, not the sync path.' }
        : opts.canResume
          ? { supported: true, state: 'observing' as const }
          : { supported: false, state: 'unavailable' as const, reason: `Codex CLI is not available on PATH, so ${PRODUCT_IDENTITY.productName} cannot Drive this session.` };

  // An agent-owned child thread offers NOTHING to join, and the offer was never cosmetic: joining
  // loads the child into the managed app-server daemon — exactly the mutable live surface Drive is
  // already refused for. Overrides syncEnabled/terminalSyncActive/presence/hint alike, so no caller
  // combination can put a `codex resume --remote` command back on a child row.
  const terminalSync = opts.agentOwned
    ? {
        supported: false,
        syncAvailable: false,
        active: false,
        reason: CODEX_AGENT_OWNED_SYNC_REASON,
      }
    : opts.syncEnabled
    ? {
        supported: true,
        // Ability is on (COSYNCING_CODEX_SYNC_SERVER=1) → the managed app-server daemon makes this
        // thread joinable now or via `codex resume --remote` (one setup step), so sync is
        // AVAILABLE (D16: the agents endpoint advertises ability; control reflects live state).
        // `active` requires per-session proof that a terminal is attached RIGHT NOW (shared proof)
        // — the loaded list alone is a one-way latch that survives every terminal exit.
        syncAvailable: true,
        active: terminalSyncActive,
        presence: terminalSyncPresence ?? (terminalSyncActive ? 'shared' : undefined),
        action: opts.terminalSyncAction,
        label: terminalSyncActive ? 'Synced with Codex terminal' : opts.terminalSyncHint?.label ?? 'Sync with Codex terminal',
        command: terminalSyncActive ? undefined : opts.terminalSyncHint?.command,
        note: terminalSyncActive
          ? 'A terminal is attached to this thread on the shared Codex daemon; it and the app share the same live session.'
          : opts.terminalSyncHint?.note,
      }
    : {
        supported: false,
        syncAvailable: false,
        active: false,
        reason: 'Codex true terminal sync is disabled. Configure the standalone Codex daemon, then enable COSYNCING_CODEX_SYNC_SERVER=1.',
      };

  return { drive, terminalSync };
}

function codexTerminalSyncHint(threadId: string, cwd?: string, model?: string): SessionInfo['terminalSyncHint'] {
  const remote = codexRemoteAddr();
  const cd = cwd ? `cd ${shellQuote(cwd)} && ` : '';
  // Carry the session's recorded model: a bare resume falls back to the user's default model and
  // codex warns "recorded with X but resuming with Y" (maintainer hit spark→sol drift on this hint).
  const modelArg = model ? ` -m ${shellQuote(model)}` : '';
  return {
    label: 'Sync with your terminal (optional)',
    command: `${cd}codex resume --remote ${shellQuote(remote)}${modelArg} ${shellQuote(threadId)}`,
    note: `Optional — this joins the same Codex app-server daemon as ${PRODUCT_IDENTITY.productName}. Plain Codex sessions on the same machine can auto-connect after daemon startup; use this exact command when you need manual fallback behavior.`,
  };
}

type CodexSessionSurface = Pick<SessionInfo, 'model' | 'currentModel' | 'currentMode'>;

function canonicalizePathForPresence(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

function scanCandidateByProof(candidates: Array<{ cwd?: string; startedAtMs?: number }>, cwd?: string, createdAtMs?: number): boolean {
  const targetCwd = canonicalizePathForPresence(cwd);
  if (!targetCwd || createdAtMs === undefined) return false;
  return candidates.some(
    (candidate) =>
      candidate.cwd !== undefined &&
      Math.abs(createdAtMs - (candidate.startedAtMs ?? Number.NaN)) <= CODEX_TUI_BIRTH_WINDOW_MS &&
      canonicalizePathForPresence(candidate.cwd) === targetCwd,
  );
}

/** Classify live terminal evidence for one thread from a scan bucket.
 *  Ordering is intentionally strict:
 *  - shared beats private / unknown
 *  - private beats unknown
 *  - absent is only returned when /proc evidence exists and nothing matches.
 */
export function classifyCodexTerminalPresence(
  scan: CodexTuiScan,
  threadId: string,
  cwd?: string,
  createdAtMs?: number,
): SessionTerminalPresence {
  if (!scan.processScanAvailable) return 'unknown';
  const canonicalThreadId = threadId.toLowerCase();
  const isUnattributedCandidate = (candidate: { threadIds?: string[] }) => !(candidate.threadIds && candidate.threadIds.length);

  if (scan.source === 'darwin') {
    const targetCwd = canonicalizePathForPresence(cwd);
    const matchingCandidates = scan.candidates.filter((candidate) => {
      if (candidate.threadIds?.some((id) => id.toLowerCase() === canonicalThreadId)) return true;
      if (candidate.threadIds?.length || !targetCwd || createdAtMs === undefined) return false;
      return candidate.cwd !== undefined &&
        candidate.startedAtMs !== undefined &&
        canonicalizePathForPresence(candidate.cwd) === targetCwd &&
        Math.abs(createdAtMs - candidate.startedAtMs) <= CODEX_TUI_BIRTH_WINDOW_MS;
    });
    // One stable process identity is required for positive macOS ownership. Multiple matches could
    // be duplicate launchers, PID churn, or competing owners, so automatic restore must not guess.
    if (matchingCandidates.length > 1) return 'unknown';
    const candidate = matchingCandidates[0];
    if (candidate && (
      !candidate.startToken ||
      !candidate.argv?.length ||
      !candidate.cwd ||
      !candidate.socketPaths
    )) return 'unknown';
  }

  const sharedEvidence =
    scan.attributed.has(canonicalThreadId) ||
    scanCandidateByProof(scan.unattributed, cwd, createdAtMs) ||
    scanCandidateByProof(
      scan.candidates
        .filter((candidate) => candidate.proof === 'shared' && isUnattributedCandidate(candidate))
        .map((candidate) => ({ cwd: candidate.cwd, startedAtMs: candidate.startedAtMs })),
      cwd,
      createdAtMs,
    );
  if (sharedEvidence) return 'shared';

  const privateEvidence =
    scan.privateThreadIds.has(canonicalThreadId) ||
    scanCandidateByProof(scan.privateUnattributed, cwd, createdAtMs) ||
    scanCandidateByProof(
      scan.candidates
        .filter((candidate) => candidate.proof === 'private' && isUnattributedCandidate(candidate))
        .map((candidate) => ({ cwd: candidate.cwd, startedAtMs: candidate.startedAtMs })),
      cwd,
      createdAtMs,
    );
  if (privateEvidence) return 'private';

  const unknownEvidence =
    scan.unknownThreadIds.has(canonicalThreadId) ||
    scanCandidateByProof(scan.unknownUnattributed, cwd, createdAtMs) ||
    scanCandidateByProof(
      scan.candidates
        .filter((candidate) => candidate.proof === 'unknown' && isUnattributedCandidate(candidate))
        .map((candidate) => ({ cwd: candidate.cwd, startedAtMs: candidate.startedAtMs })),
      cwd,
      createdAtMs,
    );

  return unknownEvidence ? 'unknown' : 'absent';
}

/** Qualify durable rollout Working evidence with a current owner.
 *
 * An unmatched task_started is necessary lifecycle evidence, but it is not sufficient forever: a
 * killed TUI can leave that final record behind. For daemon-loaded threads, point-in-time
 * `thread/read` activity outranks the sticky loaded-id set. Other normal threads become Idle only
 * when a successful process scan proves no terminal owns them. Unknown evidence fails open to the
 * durable rollout status. Agent-owned child rollouts qualify through their parent owner because
 * they do not have a separate TUI.
 */
export interface CodexRolloutQualificationContext {
  liveLoaded: boolean;
  nativeActivity?: CodexThreadActivityStatus;
  terminalPresence: SessionTerminalPresence;
  agentOwned: boolean;
  parentLiveLoaded?: boolean;
  parentNativeActivity?: CodexThreadActivityStatus;
  parentTerminalPresence?: SessionTerminalPresence;
}

export function qualifyCodexRolloutStatus(
  rawStatus: 'working' | 'idle',
  opts: CodexRolloutQualificationContext,
): 'working' | 'needs-input' | 'idle' {
  if (opts.agentOwned) {
    if (opts.nativeActivity === 'idle') {
      // Daemon idle for the child retires only a turn no terminal could own. The child has no TUI
      // of its own; the PARENT's terminal is the possible owner, and the daemon cannot see a turn
      // that terminal is running — they are different processes (round-3 rule (b): owner absence,
      // not daemon idleness, retires an open turn). Undefined parent presence is unproven absence
      // and therefore a possible owner.
      if (rawStatus !== 'working') return 'idle';
      return opts.parentTerminalPresence === 'absent' ? 'idle' : 'working';
    }
    if (opts.nativeActivity === 'working' || opts.nativeActivity === 'needs-input') return 'working';
    if (rawStatus !== 'working') return 'idle';
    if (opts.parentNativeActivity === 'idle') {
      return opts.parentTerminalPresence === 'absent' ? 'idle' : 'working';
    }
    if (opts.parentNativeActivity === 'working' || opts.parentNativeActivity === 'needs-input') return 'working';
    if (opts.parentLiveLoaded) return 'working';
    if (opts.parentTerminalPresence === 'absent') return 'idle';
    return 'working';
  }
  if (opts.nativeActivity === 'idle') {
    // Same rule for a session's own terminal: an exact daemon idle is authoritative for the
    // daemon's turn, never for one a PRESENT terminal may be running. With no open turn the idle
    // stands as before; with one, only proven owner absence retires it.
    if (rawStatus !== 'working') return 'idle';
    return opts.terminalPresence === 'absent' ? 'idle' : 'working';
  }
  if (opts.nativeActivity === 'needs-input') return 'needs-input';
  if (opts.nativeActivity === 'working') return 'working';
  if (rawStatus !== 'working') return 'idle';
  // Unknown is an explicit failed thread/read and therefore cannot retire durable evidence. A
  // missing activity on a loaded thread is the legacy injected-test seam and follows the same rule.
  if (opts.nativeActivity === 'unknown' || opts.liveLoaded) return 'working';
  return opts.terminalPresence === 'absent' ? 'idle' : 'working';
}

export function codexRolloutLaunchSurface(meta: any): SessionLaunchSurface {
  const raw = typeof meta?.originator === 'string' ? meta.originator.toLowerCase() : '';
  if (raw === 'codex-tui' || raw === 'codex_tui' || raw === 'codex_cli_rs') return 'terminal';
  if (raw === 'codex_vscode') return 'ide';
  if (raw === 'cosyncing' || raw === 'cosyncing' || raw.startsWith('cosyncing-') || raw.startsWith('cosyncing-')) return 'app';
  return 'unknown';
}

function codexSessionSurface(path: string, meta: any): CodexSessionSurface {
  const firstContext = readRolloutTurnContext(path, 'head');
  const lastContext = readRolloutTurnContext(path, 'tail');
  const candidates = [lastContext, firstContext, meta, lastContext?.config, firstContext?.config, meta?.config, meta?.settings].filter(Boolean);
  const modelID = firstMetadataString(candidates, ['model', 'modelID', 'modelId', 'model_id', 'modelName', 'model_name']);
  const providerID = firstMetadataString(candidates, ['modelProvider', 'model_provider', 'providerID', 'providerId', 'provider_id', 'provider']);
  const reasoningEffort = firstMetadataString(candidates, ['reasoningEffort', 'reasoning_effort', 'model_reasoning_effort', 'effort']);
  const approvalPolicy = firstDefinedMetadata(candidates, ['approvalPolicy', 'approval_policy']);
  const approvalsReviewer = firstDefinedMetadata(candidates, ['approvalsReviewer', 'approvals_reviewer']);
  const sandboxPolicy = firstDefinedMetadata(candidates, ['sandboxPolicy', 'sandbox_policy', 'sandbox']);
  const explicitMode = firstMetadataString(candidates, ['currentMode', 'permissionMode', 'permission_mode']);
  const surface: CodexSessionSurface = {};
  if (modelID) surface.model = modelID;
  if (modelID && providerID) {
    surface.currentModel = { providerID, modelID };
    if (reasoningEffort) surface.currentModel.reasoningEffort = reasoningEffort;
  }
  if (approvalPolicy !== undefined || approvalsReviewer !== undefined || sandboxPolicy !== undefined) {
    surface.currentMode = codexModeFromSettings(approvalPolicy, approvalsReviewer, sandboxPolicy);
  } else if (explicitMode) surface.currentMode = explicitMode;
  return surface;
}

function codexCurrentModelFromNative(value: any, fallbackProvider?: string): SessionInfo['currentModel'] | undefined {
  const candidates = [value, value?.threadSettings, value?.turn, value?.thread, value?.status, value?.config, value?.settings].filter(Boolean);
  const modelID = firstMetadataString(candidates, ['model', 'modelID', 'modelId', 'model_id', 'modelName', 'model_name']);
  if (!modelID) return undefined;
  const providerID =
    firstMetadataString(candidates, ['modelProvider', 'model_provider', 'providerID', 'providerId', 'provider_id', 'provider']) ??
    fallbackProvider;
  if (!providerID) return undefined;
  const reasoningEffort = firstMetadataString(candidates, ['reasoningEffort', 'reasoning_effort', 'model_reasoning_effort', 'effort']);
  return { providerID, modelID, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

function firstMetadataString(candidates: any[], keys: string[]): string | undefined {
  for (const obj of candidates) {
    if (!obj || typeof obj !== 'object') continue;
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
  }
  return undefined;
}

function firstDefinedMetadata(candidates: any[], keys: string[]): unknown {
  for (const obj of candidates) {
    if (!obj || typeof obj !== 'object') continue;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    }
  }
  return undefined;
}

function readRolloutTurnContext(path: string, side: 'head' | 'tail'): any | undefined {
  const st = statSafe(path);
  if (!st?.size) return undefined;
  const length = Math.min(st.size, ROLLOUT_SURFACE_SCAN_BYTES);
  const offset = side === 'tail' ? Math.max(0, st.size - length) : 0;
  let latest: any | undefined;
  try {
    for (const raw of splitRolloutLines(readBytesFrom(path, offset, length).toString('utf8'))) {
      const line = parseLineOrNull(raw);
      if (line?.type === 'turn_context' && line.payload && typeof line.payload === 'object') latest = line.payload;
    }
  } catch {
    return undefined;
  }
  return latest;
}

function codexCurrentModelOption(current: NonNullable<SessionInfo['currentModel']>, label?: string): ModelOption {
  const option: ModelOption = {
    providerID: current.providerID,
    modelID: current.modelID,
    label: label || current.modelID,
  };
  if (current.variant) option.variant = current.variant;
  if (current.reasoningEffort) {
    option.reasoningEfforts = [{ effort: current.reasoningEffort, label: reasoningEffortLabel(current.reasoningEffort) }];
    option.defaultReasoningEffort = current.reasoningEffort;
  }
  return option;
}

function codexModeOption(value: string): ModeOption {
  return (
    CODEX_PERMISSION_MODES.find((m) => m.value === value) ?? {
      value,
      label: value,
      category: 'custom',
      description: 'Native Codex permission mode recovered from rollout metadata.',
    }
  );
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_/:=.,@%+\-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

async function withCodexDaemonRpc<T>(
  sock: string,
  fn: (rpc: <R = any>(method: string, params: unknown, timeoutMs?: number) => Promise<R>) => Promise<T>,
): Promise<T> {
  const pending = new Map<string, PendingRpc>();
  let reqId = 0;
  let transport: CodexUnixSocketTransport | undefined;
  const write = (obj: unknown) => {
    transport?.write(obj);
  };
  const rpc = <T = any>(method: string, params: unknown, timeoutMs = 1500): Promise<T> => {
    const id = ++reqId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(String(id))) reject(new Error(`codex ${method} timed out`));
      }, timeoutMs);
      pending.set(String(id), { resolve, reject, timer });
      write({ id, method, params });
    });
  };
  transport = new CodexUnixSocketTransport(sock, (line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg?.id == null || (!('result' in msg) && !('error' in msg))) return;
    const p = pending.get(String(msg.id));
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(String(msg.id));
    msg.error ? p.reject(new Error(String(msg.error?.message ?? msg.error))) : p.resolve(msg.result);
  });

  try {
    await transport.connect();
    await rpc('initialize', {
      clientInfo: brokerClientInfo(),
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    write({ method: 'initialized', params: {} });
    return await fn(rpc);
  } finally {
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    transport.close();
  }
}

async function loadedCodexThreadIds(rpc: <R = any>(method: string, params: unknown, timeoutMs?: number) => Promise<R>): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null | undefined = null;
  do {
    const page: any = await rpc('thread/loaded/list', { cursor, limit: 200 });
    for (const id of page?.data ?? []) ids.add(String(id));
    cursor = page?.nextCursor ?? null;
  } while (cursor);
  return ids;
}

export async function queryCodexLoadedThreadIds(): Promise<Set<string>> {
  const sock = codexAppServerSock();
  if (!sock) return new Set();
  return withCodexDaemonRpc(sock, loadedCodexThreadIds);
}

/** Safety-critical form used before automatic daemon restart: socket absence is unknown, never idle. */
export async function queryCodexLoadedThreadIdsStrict(): Promise<Set<string>> {
  if (!codexAppServerSock()) throw new Error('Codex managed daemon socket is unavailable.');
  return queryCodexLoadedThreadIds();
}

export type CodexThreadActivityStatus = 'idle' | 'working' | 'needs-input' | 'unknown';
export interface CodexLoadedThreadActivity {
  id: string;
  status: CodexThreadActivityStatus;
  detail?: string;
}

/** Map the native v2 `thread/read` status; waiting flags are stronger than generic active. */
export function codexThreadActivityFromNative(id: string, response: any): CodexLoadedThreadActivity {
  const native = response?.thread?.status;
  const type = typeof native?.type === 'string' ? native.type : '';
  if (type === 'idle') return { id, status: 'idle' };
  if (type === 'active') {
    const flags = Array.isArray(native.activeFlags) ? native.activeFlags.map(String) : [];
    if (flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')) {
      return { id, status: 'needs-input', detail: flags.join(', ') };
    }
    return { id, status: 'working' };
  }
  return { id, status: 'unknown', detail: type ? `native status: ${type}` : 'thread/read returned no native status' };
}

/**
 * Safety-critical native activity probe for every daemon-loaded thread.
 * `thread/read` is point-in-time native state, so no rollout recency/staleness heuristic is involved.
 * Individual read failures remain visible unknown blockers instead of collapsing the whole list.
 */
export async function queryCodexLoadedThreadActivitiesStrict(): Promise<CodexLoadedThreadActivity[]> {
  const sock = codexAppServerSock();
  if (!sock) throw new Error('Codex managed daemon socket is unavailable.');
  return withCodexDaemonRpc(sock, async (rpc) => {
    const ids = [...await loadedCodexThreadIds(rpc)];
    if (ids.length > CODEX_LOADED_ACTIVITY_MAX) {
      throw new Error(`Codex loaded-thread activity exceeds the ${CODEX_LOADED_ACTIVITY_MAX}-thread bound.`);
    }
    return Promise.all(ids.map(async (id) => {
      try {
        const response = await rpc('thread/read', { threadId: id, includeTurns: false }, 1500);
        return codexThreadActivityFromNative(id, response);
      } catch (error) {
        return {
          id,
          status: 'unknown' as const,
          detail: `thread/read failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }));
  });
}

export interface CodexDaemonVersion {
  status: string;
  cliVersion: string;
  appServerVersion: string;
  socketPath?: string;
}

export interface CodexConfigFreshness {
  changed: boolean;
  detail: string;
  /** Internal content identity used to distinguish pending config occurrences. */
  fingerprint: string;
}

export interface CodexConfigFreshnessProbe {
  inspect(version: CodexDaemonVersion): Promise<CodexConfigFreshness>;
}

/** ENOENT check that survives minification (no `error.code` narrowing dependency). */
function isEnoent(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error
    && String((error as { code?: unknown }).code ?? '') === 'ENOENT';
}

/** Content fingerprint of a single file: `file:<sha256>` + its mtime, or `absent`/0 when missing. */
function fileFingerprint(path: string): { value: string; mtimeMs: number } {
  try {
    const contents = readFileSync(path);
    return { value: `file:${createHash('sha256').update(contents).digest('hex')}`, mtimeMs: statSync(path).mtimeMs };
  } catch (error) {
    if (isEnoent(error)) return { value: 'absent', mtimeMs: 0 };
    throw error;
  }
}

/** Content+structure fingerprint of a directory tree: sorted (relative-path → content-hash) over every
 *  regular file, so any add, remove, rename, or edit changes the value. mtimeMs is the newest across the
 *  dir itself (add/remove/rename) and its files (content edits). Bounded by depth + a file budget so a
 *  pathological tree can't stall the probe; symlinks are skipped (no loop risk). `absent`/0 when missing. */
function dirFingerprint(root: string, depth = 6, budget = { files: 2000 }): { value: string; mtimeMs: number } {
  let newest: number;
  try {
    newest = statSync(root).mtimeMs;
  } catch (error) {
    if (isEnoent(error)) return { value: 'absent', mtimeMs: 0 };
    throw error;
  }
  const files: Array<{ rel: string; hash: string }> = [];
  const walk = (dir: string, rel: string, remaining: number): void => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (budget.files <= 0) break;
        const child = join(dir, entry.name);
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        try {
          if (entry.isDirectory()) {
            if (remaining > 0) {
              newest = Math.max(newest, statSync(child).mtimeMs); // subdir mtime catches add/remove/rename inside it
              walk(child, childRel, remaining - 1);
            }
          } else if (entry.isFile()) {
            budget.files -= 1;
            const contents = readFileSync(child);
            files.push({ rel: childRel, hash: createHash('sha256').update(contents).digest('hex') });
            newest = Math.max(newest, statSync(child).mtimeMs);
          }
        } catch {
          /* raced: the entry vanished between readdir and stat — ignore */
        }
      }
    } catch {
      /* unreadable subtree — ignore */
    }
  };
  walk(root, '', depth);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const combined = createHash('sha256');
  for (const file of files) combined.update(`${file.rel}\0${file.hash}\n`);
  return { value: `dir:${files.length}:${combined.digest('hex')}`, mtimeMs: newest };
}

/**
 * Tracks the daemon-owned Codex user config + agent definitions without exposing their contents.
 *
 * Watches `$CODEX_HOME/config.toml` AND `$CODEX_HOME/agents/` (custom subagent `.toml` defs): both are the
 * one global daemon layer, and the app-server daemon reads them at startup, so an edit needs a daemon
 * restart to take effect. A combined content fingerprint catches edits, replacement, and deletion while
 * this broker is running. On broker startup, the newest config/agent mtime vs the socket mtime establishes
 * whether the existing independently-managed daemon predates them. A new socket generation clears drift
 * after a daemon restart. Project `.codex/config.toml` and per-run profile overlays stay OUT of this
 * shared-daemon detector; they are selected per cwd/invocation rather than being one global daemon layer.
 */
export function createCodexConfigFreshnessProbe(options: {
  configPath?: string;
  socketPath?: string;
  agentsDir?: string;
} = {}): CodexConfigFreshnessProbe {
  const configPath = options.configPath ?? join(CODEX_HOME, 'config.toml');
  const agentsDir = options.agentsDir ?? join(dirname(configPath), 'agents');
  let generation: string | undefined;
  let baselineFingerprint: string | undefined;
  let generationStartedStale = false;

  const fingerprint = (): { value: string; mtimeMs: number } => {
    const config = fileFingerprint(configPath);
    const agents = dirFingerprint(agentsDir);
    return {
      value: `config:${config.value}|agents:${agents.value}`,
      mtimeMs: Math.max(config.mtimeMs, agents.mtimeMs),
    };
  };

  return {
    async inspect(version) {
      const current = fingerprint();
      const daemonSocketPath = options.socketPath ?? version.socketPath ?? DEFAULT_APP_SERVER_CONTROL_SOCK;
      const socketStat = statSync(daemonSocketPath);
      const nextGeneration = `${socketStat.dev}:${socketStat.ino}:${socketStat.mtimeMs}`;
      if (nextGeneration !== generation) {
        generation = nextGeneration;
        baselineFingerprint = current.value;
        generationStartedStale = current.mtimeMs > socketStat.mtimeMs;
      }
      const changed = generationStartedStale || current.value !== baselineFingerprint;
      return {
        changed,
        fingerprint: current.value,
        detail: changed
          ? 'Codex user configuration or agent definitions changed after this daemon started.'
          : 'Codex user configuration and agent definitions match this daemon generation.',
      };
    },
  };
}

export function parseCodexDaemonVersionOutput(output: string): CodexDaemonVersion | undefined {
  try {
    const value = JSON.parse(output);
    if (!value || typeof value !== 'object') return undefined;
    const cliVersion = typeof value.cliVersion === 'string' ? value.cliVersion.trim() : '';
    const appServerVersion = typeof value.appServerVersion === 'string' ? value.appServerVersion.trim() : '';
    if (!cliVersion || !appServerVersion) return undefined;
    return {
      status: typeof value.status === 'string' ? value.status : 'unknown',
      cliVersion,
      appServerVersion,
      ...(typeof value.socketPath === 'string' ? { socketPath: value.socketPath } : {}),
    };
  } catch {
    return undefined;
  }
}

async function runCodexDaemonCommand(command: 'version' | 'restart' | 'stop', timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const bin = resolveBin('codex');
  if (!bin) throw new Error('Codex CLI is not available on PATH.');
  const proc = spawnCodex(bin, ['app-server', 'daemon', command], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* already exited */ }
  }, timeoutMs);
  try {
    const code = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** Read-only native probe. A stopped daemon returns undefined; this command does not start it. */
export async function readCodexDaemonVersion(): Promise<CodexDaemonVersion | undefined> {
  if (!resolveBin('codex')) return undefined;
  const result = await runCodexDaemonCommand('version', 5000);
  return result.code === 0 ? parseCodexDaemonVersionOutput(result.stdout.trim()) : undefined;
}

/** Explicit lifecycle mutation used only after the idle-only gate or a confirmed manual action. */
export async function restartCodexDaemon(): Promise<void> {
  const result = await runCodexDaemonCommand('restart', 30_000);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `codex daemon restart exited ${result.code}`);
}

/**
 * Stop the managed Codex app-server daemon. Used only by uninstall, and only with broker ownership proven by
 * the recorded control-socket fingerprint. Throws when the codex CLI is unavailable (see
 * `runCodexDaemonCommand`) so the caller can preserve-and-warn.
 * A daemon that is already down is a benign no-op: a non-zero exit is re-checked with a read-only version
 * probe, and only a still-running daemon after the stop attempt is reported as a failure.
 */
export async function stopCodexDaemon(timeoutMs = 15_000): Promise<void> {
  const result = await runCodexDaemonCommand('stop', timeoutMs);
  if (result.code === 0) return;
  if (await readCodexDaemonVersion()) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `codex daemon stop exited ${result.code}`);
  }
}

/** Spawn a short-lived `codex app-server --stdio`, run `fn` with an initialized RPC handle, then kill it. */
async function withCodexAppServerRpc<T>(cwd: string, fn: (rpc: <R = any>(method: string, params: unknown, timeoutMs?: number) => Promise<R>, write: (obj: unknown) => void) => Promise<T>): Promise<T> {
  const bin = resolveBin('codex');
  if (!bin) throw new Error('Codex CLI is not available on PATH.');
  const proc = spawnCodex(bin, ['app-server', '--stdio'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd,
    env: { ...process.env },
  });
  const pending = new Map<string, PendingRpc>();
  let reqId = 0;
  const write = (obj: unknown) => {
    proc.stdin.write(JSON.stringify(obj) + '\n');
    try {
      proc.stdin.flush?.();
    } catch {
      /* ignore flush support differences in probe scripts */
    }
  };
  const rpc = <T = any>(method: string, params: unknown, timeoutMs = 30000): Promise<T> => {
    const id = ++reqId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(String(id))) reject(new Error(`codex ${method} timed out`));
      }, timeoutMs);
      pending.set(String(id), { resolve, reject, timer });
      write({ id, method, params });
    });
  };
  const split = createJsonlSplitter((line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg?.id == null || (!('result' in msg) && !('error' in msg))) return;
    const p = pending.get(String(msg.id));
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(String(msg.id));
    msg.error ? p.reject(new Error(String(msg.error?.message ?? msg.error))) : p.resolve(msg.result);
  });
  void (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        split(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* process ended */
    }
  })();
  void drainStream(proc.stderr);
  try {
    await rpc('initialize', {
      clientInfo: brokerClientInfo(),
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    write({ method: 'initialized', params: {} });
    return await fn(rpc, write);
  } finally {
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    try { proc.kill(); } catch { /* already closed */ }
  }
}

async function createCodexThread(
  cwd: string,
  name?: string,
  model?: PromptInput['model'],
): Promise<any> {
  return withCodexAppServerRpc(cwd, async (rpc) => {
    const started = await rpc('thread/start', {
      cwd,
      serviceName: brokerClientInfo().name,
      ...(model
        ? {
            model: model.modelID,
            modelProvider: model.providerID,
          }
        : {}),
    });
    // `thread/start` only ALLOCATES the rollout path — codex writes the file lazily, normally on the
    // first turn. A create→attach flow therefore raced a file that would never exist ("failed to
    // resolve rollout path", issues-part1 codex create). `thread/name/set` is the cheapest RPC that
    // forces the rollout to disk (verified against codex app-server 2026-07-04), and we want the
    // thread named after the session title anyway.
    const threadId = started?.thread?.id;
    const path = typeof started?.thread?.path === 'string' ? started.thread.path : undefined;
    if (threadId != null) {
      // Codex 0.146.0's generated ThreadStartParams accepts model and
      // modelProvider, but not reasoningEffort. Effort is a supported
      // thread-settings field (`effort`), so apply it through the same native
      // settings path used for cold-restore before claiming the exact
      // selection on the created session.
      if (model?.reasoningEffort) {
        await rpc(
          'thread/settings/update',
          {
            threadId,
            model: model.modelID,
            effort: model.reasoningEffort,
          },
          5000,
        );
      }
      try {
        await rpc('thread/name/set', { threadId, name: name?.trim() || basename(cwd) || `${PRODUCT_IDENTITY.productName} session` }, 10000);
      } catch {
        /* older app-server without name/set → fall through to the existence guard below */
      }
    }
    if (path) {
      for (let i = 0; i < 20 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 200));
      if (!existsSync(path)) throw new Error('Codex did not persist the new session rollout; send the first message from a terminal `codex resume` instead.');
    }
    return started;
  });
}

/** Fork an existing thread into a new one via `thread/fork`, forcing the forked rollout to disk (same
 *  lazy-write concern as thread/start) so a create→attach flow can find the new file. */
async function forkCodexThread(cwd: string, threadId: string): Promise<any> {
  return withCodexAppServerRpc(cwd, async (rpc) => {
    const forked = await rpc('thread/fork', { threadId }, 30000);
    const newThreadId = forked?.thread?.id;
    const path = typeof forked?.thread?.path === 'string' ? forked.thread.path : undefined;
    if (newThreadId != null) {
      try {
        const name = typeof forked?.thread?.name === 'string' && forked.thread.name ? forked.thread.name : `${basename(cwd) || 'Codex session'} (fork)`;
        await rpc('thread/name/set', { threadId: newThreadId, name }, 10000);
      } catch {
        /* older app-server without name/set → rely on the existence guard below */
      }
    }
    if (path) {
      for (let i = 0; i < 20 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 200));
      if (!existsSync(path)) throw new Error('Codex did not persist the forked session rollout.');
    }
    return forked;
  });
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    /* process ended */
  }
}

/** Longest EITHER surface waits for the record that carries an assistant line's native id — the live
 *  tail holding a deferred line, and a history read polling a rollout that ends on one.
 *
 *  Codex writes the pair in a single append: across 60 real rollouts the paired record was always the
 *  immediately next line, never further, so the physical window is one filesystem event rather than
 *  anything human-scale. The bound only has to cover that append surfacing as two watcher
 *  notifications instead of one; beyond that it is pure attach latency paid by the ~12% of records
 *  that carry no native id anywhere and can never be resolved by waiting longer.
 *
 *  Both surfaces derive from this one constant deliberately. Two independent deadlines would let a
 *  tailed line and a history read of the same file time out against different clocks and publish two
 *  identities for one answer. */
const ASSISTANT_PAIR_WAIT_MS = 150;
/** How long a synthetic-baseline tail holds deferred lines after a capture ends WITHOUT adoption,
 *  waiting for the attach sequence's next capture (indexed refusal → bounded tail). See
 *  {@link CodexObserveConnection.captureHistorySnapshot}. */
const CODEX_OBSERVE_DEFERRED_FLUSH_MS = 250;

/** Re-read interval while a history read waits for a trailing assistant line's paired record. */
const ROLLOUT_PAIR_SETTLE_POLL_MS = 25;

/** A rollout not written within this long is not mid-append, so nothing is coming: an unpaired
 *  trailing record there is genuinely unpaired and must cost an attach nothing. */
const ROLLOUT_ACTIVE_WRITE_MS = 2_000;

/** Assistant lines one connection remembers publishing an identity for. The boundary that needs
 *  remembering is always at the tail of the rollout, so a few hundred covers any realistic overlap
 *  between a tailed line and a later history read of the same file. */
const PUBLISHED_IDENTITY_LIMIT = 512;

/**
 * Identities a connection has ALREADY published for assistant rollout lines, by line index.
 *
 * The two surfaces decide from different amounts of the file: the tail sees one following line within
 * {@link ASSISTANT_PAIR_WAIT_MS}, a history read sees whatever the file holds when it runs. A pair
 * split wider than that bound resolves differently on each — the tail flushes `c<n>` while a later
 * `getHistory()` reads the now-settled pair and returns the native key — which is one answer under two
 * identities in one client's transcript, the exact duplicate this lane removes.
 *
 * Whichever surface decides first therefore binds the rest of the connection: the client already
 * stored that key, so reproducing it is what keeps the message single. Bounded and per-connection,
 * because rollout line indices only mean anything within one append-only file.
 */
class CodexPublishedIdentities {
  private readonly byLine = new Map<number, string>();

  /** The key already published for `lineIndex`, or `decided` — now published — when it is new. */
  adopt(lineIndex: number, decided: string): string {
    const published = this.byLine.get(lineIndex);
    if (published !== undefined) return published;
    this.byLine.set(lineIndex, decided);
    // Evict the oldest LINE, not the oldest insertion: a whole-file re-read republishes from the
    // start, and insertion-order eviction would drop the tail entries that re-read is about to
    // consult. Line order is also the order in which decisions stop being able to change.
    while (this.byLine.size > PUBLISHED_IDENTITY_LIMIT) {
      let oldest: number | undefined;
      for (const line of this.byLine.keys()) if (oldest === undefined || line < oldest) oldest = line;
      if (oldest === undefined) break;
      this.byLine.delete(oldest);
    }
    return decided;
  }

  clear(): void {
    this.byLine.clear();
  }
}

type ActiveRolloutContext = {
  turnId: string | undefined;
  automaticApprovalDenials: number;
  toolNameByCallId: Map<string, string>;
};

const ACTIVE_ROLLOUT_CONTEXT_TOOL_LIMIT = 256;

/** Fold one rollout record into the live tail's bounded inherited context. */
function updateActiveRolloutContext(
  context: ActiveRolloutContext,
  line: any,
): void {
  const transition = rolloutTurnTransition(line);
  if (transition?.opens) {
    if (context.turnId !== transition.turnId) {
      context.automaticApprovalDenials = 0;
      context.toolNameByCallId.clear();
    }
    context.turnId = transition.turnId;
  } else if (
    transition
    && !transition.opens
    && transition.turnId !== undefined
    && transition.turnId === context.turnId
  ) {
    context.turnId = undefined;
    context.automaticApprovalDenials = 0;
    context.toolNameByCallId.clear();
  } else if (
    context.turnId !== undefined
    && line.type === 'response_item'
    && (
      line.payload?.type === 'function_call'
      || line.payload?.type === 'custom_tool_call'
    )
    && line.payload?.call_id != null
    && line.payload?.name != null
  ) {
    const callId = String(line.payload.call_id);
    context.toolNameByCallId.delete(callId);
    context.toolNameByCallId.set(callId, String(line.payload.name));
    while (
      context.toolNameByCallId.size > ACTIVE_ROLLOUT_CONTEXT_TOOL_LIMIT
    ) {
      const oldest = context.toolNameByCallId.keys().next().value;
      if (oldest === undefined) break;
      context.toolNameByCallId.delete(oldest);
    }
  } else if (
    context.turnId !== undefined
    && line.type === 'response_item'
    && (
      line.payload?.type === 'function_call_output'
      || line.payload?.type === 'custom_tool_call_output'
    )
  ) {
    const callId = line.payload?.call_id == null
      ? undefined
      : String(line.payload.call_id);
    const toolName = callId === undefined
      ? undefined
      : context.toolNameByCallId.get(callId);
    if (callId !== undefined) context.toolNameByCallId.delete(callId);
    if (isAutomaticApprovalReviewDenial(toolName, line.payload?.output)) {
      context.automaticApprovalDenials = Math.min(
        AUTOMATIC_APPROVAL_DENIAL_THRESHOLD,
        context.automaticApprovalDenials + 1,
      );
    }
  }
}

type ObserveTailBaseline = {
  size: number;
  lineIndex: number;
  context: ActiveRolloutContext;
  /** True only for a COMPLETE validated scan of the current source. A ceiling refusal or a source
   *  that moved yields no run-state evidence at all — treating its empty task state as "no open
   *  turn" would manufacture Idle for exactly the largest, busiest rollouts. */
  scanned: boolean;
  /** The unmatched `task_started` at the tail boundary, or undefined. Distinct from
   *  {@link ActiveRolloutContext.turnId}, which `turn_context` also opens: a turn_context can persist
   *  settings for an idle thread and is not lifecycle evidence (same exclusion
   *  {@link exactActiveRolloutTurnId} documents). */
  openTaskTurnId?: string;
};

/**
 * Establish the byte and line boundary inherited by a new observe tail.
 *
 * This used to allocate the complete rollout as both a Buffer and UTF-8
 * string, then retain a full split array before compact paging had a chance to
 * apply any limit. A chunked scan keeps only one bounded record. A source over
 * the capture ceiling is not read at all: compact capture will return its
 * typed resource refusal, and the synthetic line base merely keeps any later
 * live-only keys disjoint while no persisted history is attachable.
 *
 * Asynchronous for the same reason the capture is (H1c round 3): this was the
 * last synchronous whole-source scan, and a 256 MiB rollout being observed for
 * the first time held the broker's event loop for the whole read.
 */
async function readObserveTailBaseline(path: string): Promise<ObserveTailBaseline | undefined> {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const before = fstatSync(fd);
    const size = before.size;
    let startOffset = 0;
    let startRecordIndex = 0;
    let openTaskTurnId: string | undefined;
    let context: ActiveRolloutContext = {
      turnId: undefined,
      automaticApprovalDenials: 0,
      toolNameByCallId: new Map(),
    };
    if (size > HISTORY_SNAPSHOT_MAX_SOURCE_BYTES) {
      // Over the whole-source scan ceiling. A completed bounded-tail capture may have left an
      // exact watermark for these same bytes: record count, enclosing turn, and prefix token at
      // its stop position. Scanning only [watermark, EOF) then yields the SAME line base and turn
      // context a full scan would, so live-tailed rows key identically to a history read — the
      // synthetic byte base below survives only for a source no capture has ever completed on.
      const watermark = codexTailPositions.get(`${before.dev}:${before.ino}`);
      const delta = watermark ? size - watermark.size : Number.POSITIVE_INFINITY;
      const usable = watermark
        && codexTailWatermarkValid(watermark, before)
        && delta <= HISTORY_SNAPSHOT_MAX_SOURCE_BYTES;
      if (!usable) {
        return {
          size,
          lineIndex: Math.min(size, Number.MAX_SAFE_INTEGER - 1),
          context,
          scanned: false,
        };
      }
      const prefixProbe = Buffer.alloc(Math.min(watermark.prefixLength, size));
      const prefixProbeBytes = prefixProbe.length > 0
        ? readSync(fd, prefixProbe, 0, prefixProbe.length, 0)
        : 0;
      if (
        prefixTokenOver(prefixProbe, prefixProbeBytes, watermark.prefixLength)
          !== watermark.rewriteToken
      ) {
        return {
          size,
          lineIndex: Math.min(size, Number.MAX_SAFE_INTEGER - 1),
          context,
          scanned: false,
        };
      }
      startOffset = watermark.size;
      startRecordIndex = watermark.recordIndex;
      context = cloneActiveRolloutContext(watermark.context);
      openTaskTurnId = watermark.openTaskTurnId;
    }

    let lineIndex = startRecordIndex;
    const scan = await scanFileLinesAsync(fd, size, (raw, _start, _end, index) => {
      lineIndex = index + 1;
      // Folded from the SAME bytes that fix the tail boundary. The observe seed used to come from a
      // stat-cached qualification taken several awaits earlier, so a task_started written inside
      // that window landed behind the tail and was never emitted while the seed still said Idle.
      const marker = rolloutTaskMarker(raw);
      if (marker?.kind === 'start') openTaskTurnId = marker.turnId;
      else if (marker?.kind === 'terminal' && (openTaskTurnId === undefined || openTaskTurnId === marker.turnId)) {
        openTaskTurnId = undefined;
      }
      const line = parseLineOrNull(raw);
      if (line) updateActiveRolloutContext(context, line);
      return true;
      // The delta path skips oversized records exactly as the bounded-tail capture it resumes
      // does, so both count record indices identically; the whole-source path keeps its
      // established abort.
    }, { startOffset, startRecordIndex, skipOversizedRecords: startOffset > 0 });
    if (scan === 'timed-out' || scan.recordOverflow || scan.bytes !== size) return undefined;
    // Source fencing: see {@link codexBaselineSourceIntact} for why the PATH, not the descriptor,
    // is the thing whose identity has to be checked.
    if (!codexBaselineSourceIntact(before, fstatSync(fd), statSafe(path), size)) return undefined;
    return { size, lineIndex, context, scanned: true, ...(openTaskTurnId ? { openTaskTurnId } : {}) };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** True when the rollout's last decodable record is an assistant event with nothing after it — the
 *  window in which the paired `response_item/message` carrying its native id has not landed yet.
 *  Trailing blank/partial segments are skipped: a half-written line is not an answer, it is the pair
 *  still arriving. */
function endsOnUnpairedAssistant(segs: string[]): boolean {
  for (let i = segs.length - 1; i >= 0; i--) {
    const ln = parseLineOrNull(segs[i]!);
    if (ln) return isDeferrableAssistantLine(ln);
  }
  return false;
}

/** Read a rollout for mapping, briefly waiting out the gap between an assistant event and the paired
 *  record that carries its native id.
 *
 *  Codex appends the pair together, so the gap is measured in milliseconds — but a history read that
 *  lands inside it keys that answer by line index while the app-server is already delivering it under
 *  the native key, which is exactly the duplicate this identity lane removes. The wait is bounded by
 *  {@link ASSISTANT_PAIR_WAIT_MS} (the same bound the live tail holds a deferred line for) and gated
 *  on the file still being written. A record that is never paired at all pays the full bound, so that
 *  bound is kept close to the physical window rather than to what a client would tolerate. */
async function readRolloutSegmentsSettled(path: string): Promise<string[]> {
  let segs = splitRolloutLines(readFileText(path));
  const deadline = Date.now() + ASSISTANT_PAIR_WAIT_MS;
  while (endsOnUnpairedAssistant(segs) && Date.now() < deadline) {
    const st = statSafe(path);
    if (!st || Date.now() - st.mtimeMs > ROLLOUT_ACTIVE_WRITE_MS) break;
    await new Promise((r) => setTimeout(r, ROLLOUT_PAIR_SETTLE_POLL_MS));
    segs = splitRolloutLines(readFileText(path));
  }
  return segs;
}

/** Test-only capture gate: while the file named by COSYNCING_TEST_CODEX_CAPTURE_HOLD_FILE exists,
 *  an observe capture waits before scanning, so a wire test can deterministically land an append
 *  INSIDE the capture window (the cold-attach adoption race). Unset env → immediate no-op; the
 *  wait is bounded so a leaked hold file cannot wedge a broker under test. */
async function codexObserveCaptureTestHold(): Promise<void> {
  const holdPath = process.env.COSYNCING_TEST_CODEX_CAPTURE_HOLD_FILE?.trim();
  if (!holdPath) return;
  const deadline = Date.now() + 10_000;
  while (statSafe(holdPath) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * A read-only observe connection: replays the rollout as history and live-follows appended lines.
 * Keys every message by its rollout line index so the history snapshot and any live-tailed line
 * dedupe in the app (no double-render across the attach window).
 */
class CodexObserveConnection implements SessionConnection {
  private readonly handlers = new Set<AgentMessageHandler>();
  private watcher?: FSWatcher;
  private offset = 0; // bytes consumed by the live tail
  private lineIndex = 0; // next rollout line number (history sets the base; the tail continues it)
  private tailBuf = '';
  /** The baseline scan was refused (over-ceiling source, no watermark), so live keys sit on the
   *  synthetic byte base and disagree with every history read of the same lines. Cleared when a
   *  completed capture's watermark is adopted before the tail consumed anything. */
  private baselineSynthetic = false;
  /** A cold synthetic tail starts waiting before the watcher is installed, closing the small
   *  subscribe -> first-capture gap as well as the capture itself. The first successful bounded
   *  capture clears this by adopting its record-index watermark; a refused/failed attach gets the
   *  bounded fallback below so a connection used outside the broker cannot wait forever. */
  private initialCapturePending = false;
  /** Lines the live tail has consumed since the baseline was fixed — adoption is only sound
   *  while this is zero and no partial line is buffered. */
  private tailLinesConsumed = 0;
  /** Captures currently running against this connection. While one is in flight and a synthetic
   *  baseline could still adopt its watermark, the tail DEFERS reading appended bytes: a line
   *  drained mid-capture would go out under the synthetic byte base and permanently block
   *  adoption — the cold-attach race on an over-ceiling source that is being written to. The
   *  deferred bytes stay in the file; after adoption the tail resumes from the watermark, which
   *  discards the capture-covered prefix and emits only the remainder under record-index keys. */
  private captureInFlight = 0;
  /** A watcher event arrived while the tail was deferring — drain once the capture settles. */
  private deferredDrainPending = false;
  /** Flush fallback armed when a capture ends WITHOUT adoption (refusal/failure): the attach
   *  sequence usually runs another capture moments later (indexed refusal → bounded tail), and
   *  flushing between them would put synthetic-keyed lines out and block that second capture's
   *  adoption. The next capture cancels this; if none comes, the timer delivers the deferred
   *  lines under the base the connection always had — bounded, never retained indefinitely. */
  private deferredFlushTimer?: ReturnType<typeof setTimeout>;
  /** call_id → tool name + rich detail, accumulated live so a function_call_output can be enriched.
   *
   *  Bounded, because a long-lived observe connection would otherwise keep every
   *  completed call's detail until disconnect. Eviction is oldest-call-first and
   *  costs only enrichment: an output whose call was evicted still renders from
   *  its own canonical fields. */
  private readonly liveEnrichStore = new CodexEnrichStore();
  private readonly liveEnrich = this.liveEnrichStore.entries;
  private readonly liveRuntime = new CodexRuntimeTracker();
  /** One assistant line held until the following line settles its identity — the native id lives on
   *  the paired record, so emitting before seeing it would key the answer differently here than a
   *  fresh getHistory() of the same file does. Never held longer than
   *  {@link ASSISTANT_PAIR_WAIT_MS}. */
  private deferredAssistant?: { ln: any; index: number };
  private deferredTimer?: ReturnType<typeof setTimeout>;
  /** Shared by the tail and every history read on this connection, so a pair split wider than the
   *  wait cannot resolve two ways for one line. */
  private readonly published = new CodexPublishedIdentities();

  /** Streaming decoder so a line flushed mid-multibyte-character isn't corrupted: partial bytes are
   *  held internally across reads instead of decoding to U+FFFD and advancing past them. */
  private readonly decoder = new TextDecoder();

  /** Serializes the repair probe: the watcher self-check and the broker's contradiction hand-off can
   *  both arrive within one interval, and a second probe would only re-read the same source. */
  private repairInFlight?: Promise<void>;
  /** Rollout identity at the last fresh-idle observation that CONTRADICTED an unmatched open turn.
   *  Retirement needs the same disagreement to survive a round over unchanged bytes; see
   *  {@link decideCodexObserveRunState}. */
  private retirementHoldIdentity?: string;

  constructor(
    private readonly path: string,
    readonly info: SessionInfo,
    /** The exact attach-time qualification for this rollout, reused verbatim so the seed re-derived
     *  in {@link start} is qualified IDENTICALLY to the one `attach` computed — only its raw rollout
     *  status is refreshed. */
    private readonly qualification?: CodexRolloutQualificationContext,
    /** Re-take EVERY dynamic qualification input at one instant, bypassing each cache. Supplied by
     *  the adapter, which owns the bounded daemon and presence probes; the connection never opens
     *  its own. Refreshing one field at a time is what left the seed race half open: the qualifier
     *  consults loaded-state, native activity AND terminal presence, and any of them can be the
     *  stale one. */
    private readonly refreshQualification?: () => Promise<CodexRolloutQualificationContext>,
  ) {}

  /**
   * Establish the tail's starting boundary.
   *
   * Separate from the constructor only because the baseline scan yields to the event loop now
   * (H1c round 3): reading a large rollout synchronously here froze every other session while one
   * observe connection was being opened. `subscribe` starts the tail lazily, and the adapter awaits
   * this before handing the connection out, so no line can be read before the boundary is known.
   */
  async start(): Promise<void> {
    // Start the live tail from the CURRENT end of file so we only emit NEW lines. getHistory()
    // replays everything up to here; overlap (if the file grew between) dedupes via line-index keys.
    // The base index MUST match getHistory's segment indexing (splitRolloutLines) so the keys align.
    const baseline = await readObserveTailBaseline(this.path);
    if (baseline) {
      this.offset = baseline.size;
      this.lineIndex = baseline.lineIndex;
      // Prime the enclosing turn from the history this tail starts after. Attaching mid-turn leaves
      // the turn's opening marker behind us, and assistant text carries no turn of its own — without
      // this, the tail would key the rest of the turn differently than getHistory() does. Attaching
      // after that turn ENDED must leave no turn at all, or the next turn's opening records would be
      // keyed under the finished one.
      this.liveRuntime.primeActiveTurn(
        baseline.context.turnId,
        baseline.context.automaticApprovalDenials,
      );
      // R0c.4: close the attach seed race. The seed `attach` computed came from stat-cached rollout
      // facts plus a <=5s activity cache, several awaits before this scan fixed the tail at the
      // then-current EOF. A task_started written inside that window is BEHIND the tail — it will
      // never be emitted as `running` — while the seed still says Idle, which is the stuck-Idle
      // reproduction with tool events streaming. Re-derive the raw rollout status from the very
      // bytes that fixed the boundary and qualify it with the SAME owner evidence, so this is a
      // fresher input to the identical decision, never a second, weaker rule. A refused or moved
      // scan carries no run-state evidence and leaves the seed alone.
      if (baseline.scanned && this.qualification) {
        const raw = baseline.openTaskTurnId ? 'working' : 'idle';
        this.info.status = qualifyCodexRolloutStatus(raw, await this.coherentSeedContext(raw));
      }
      this.baselineSynthetic = !baseline.scanned;
    } else {
      const st = statSafe(this.path);
      this.offset = st?.size ?? 0;
      // A source that moved during the bounded scan has no attachable
      // snapshot. Keep later live-only identities disjoint until retry.
      this.lineIndex = Math.min(
        this.offset,
        Number.MAX_SAFE_INTEGER - 1,
      );
      this.baselineSynthetic = true;
    }
    // Arm before subscribe() can install the watcher. captureInFlight alone starts too late: the
    // broker subscribes, then awaits source identity before it invokes the first capture, and an
    // append in that gap used to escape under the synthetic byte base.
    this.initialCapturePending = this.baselineSynthetic;
  }

  /**
   * Adopt a just-completed capture's watermark in place of a synthetic baseline.
   *
   * An over-ceiling source fixes its tail base at the byte size, so every live-only key
   * (`c<byteOffset>`) disagrees with the line-index key a history read gives the same record —
   * the same message renders twice across a refresh. The attach that created this connection
   * runs a bounded-tail capture moments later, and that capture knows the TRUE record count at
   * its stop position. While the tail has consumed nothing, moving the base to the watermark is
   * pure relabeling: bytes between the old offset and the watermark were delivered by that same
   * capture as history, so the tail must skip them, and everything after keys identically to a
   * later read. Once a single live line is out under the synthetic base, adoption would re-key
   * the stream mid-flight — the window simply stays synthetic, exactly as before this path.
   */
  private adoptCaptureWatermark(): void {
    if (!this.baselineSynthetic) return;
    if (this.tailLinesConsumed > 0 || this.tailBuf !== '') return;
    const st = statSafe(this.path);
    if (!st) return;
    const watermark = codexTailPositions.get(`${st.dev}:${st.ino}`);
    if (!watermark || watermark.size < this.offset) return;
    if (!codexTailWatermarkValid(watermark, st)) return;
    this.offset = watermark.size;
    this.lineIndex = watermark.recordIndex;
    this.liveRuntime.primeActiveTurn(
      watermark.context.turnId,
      watermark.context.automaticApprovalDenials,
    );
    this.baselineSynthetic = false;
    this.initialCapturePending = false;
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    if (!this.watcher) this.startTail();
    return () => this.handlers.delete(handler);
  }

  /**
   * One coherent evidence boundary for the attach seed (R0c.4 round 2).
   *
   * The attach-time context carries a ≤5s-cached native activity that can PREDATE the start marker
   * the baseline scan just read off disk — the same TOCTOU as the rollout memo, on a different
   * input. `qualifyCodexRolloutStatus` checks exact native idle FIRST and unconditionally, so a
   * stale cached idle would demote the fresh evidence straight back to Idle and re-open the very
   * race this lane closed. Re-probe once, cache-bypassing, so both inputs describe one instant. A
   * FRESH exact idle still demotes — R0c.3's rule is about current evidence and is untouched; only
   * a superseded value is refused. Unknown follows the ordinary qualifier rules.
   */
  private async coherentSeedContext(raw: 'working' | 'idle'): Promise<CodexRolloutQualificationContext> {
    const context = this.qualification!;
    if (raw !== 'working' || !this.refreshQualification) return context;
    if (!codexSeedContextCouldDemote(context)) return context;
    try {
      return await this.refreshQualification();
    } catch {
      // Neither runtime nor terminal ownership could be re-established. Unknown on both axes is the
      // qualifier's fail-open input, which keeps the freshly-observed open turn rather than letting
      // a value we have just proven superseded retire it.
      return { ...context, nativeActivity: 'unknown', terminalPresence: 'unknown' };
    }
  }

  /**
   * Re-derive this Observe owner's run state from exact native evidence (R0c.4 repair channel).
   *
   * An Observe tail has no turn-notification channel, so its only edges are appended rollout lines
   * — and a start marker that landed behind the tail baseline produces none. Both exact sources are
   * read here: a cache-bypassing runtime probe and the durable rollout's exact authority. Admission
   * takes either; retirement takes their agreement, or the same disagreement surviving a round over
   * unchanged bytes ({@link decideCodexObserveRunState}). The status frame carries the correction to
   * the Hub fold and to every attached client.
   */
  requestRunStateRepair(): Promise<void> {
    if (this.repairInFlight) return this.repairInFlight;
    const flight = (async () => {
      let context: CodexRolloutQualificationContext | undefined;
      try {
        context = await this.refreshQualification?.();
      } catch {
        /* a failed probe is unknown evidence, never Idle */
      }
      if (!context) return;
      let rollout: { openTurn: boolean; identity: string } | undefined;
      try {
        const st = statSafe(this.path);
        const inferred = await inferRolloutRawStatus(this.path, st);
        // Only an EXACT authority result counts. A typed bounded fallback is a catch-up state, which
        // is precisely the inferred evidence R0c.1 refused to publish. The identity comes from the
        // SAME stat the scan answered about, so it describes those exact bytes.
        if (st && inferred.kind === 'authority') {
          rollout = {
            openTurn: inferred.status === 'working',
            identity: `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`,
          };
        }
      } catch {
        /* unreadable source is unknown evidence */
      }
      const decision = decideCodexObserveRunState({
        // The SAME qualification discovery and the watcher run, so a repaired Observe owner and the
        // row discovery would publish for it cannot disagree by construction.
        qualified: rollout ? qualifyCodexRolloutStatus(rollout.openTurn ? 'working' : 'idle', context) : 'idle',
        rollout,
        heldIdentity: this.retirementHoldIdentity,
      });
      this.retirementHoldIdentity = decision.heldIdentity;
      if (!decision.next || this.info.status === decision.next) return;
      // The status vocabulary carries only running/idle, so exact Needs input — a Working run state
      // that additionally blocks on the user — is emitted as `running` and the finer projection is
      // written after, where the Hub's adapter-status fold picks it up. Real permission/question
      // frames remain the only route to exact Needs input for an owned connection; this preserves
      // what discovery already publishes for the same row.
      this.emit({ type: 'status', status: decision.next === 'idle' ? 'idle' : 'running' });
      this.info.status = decision.next;
    })().finally(() => {
      if (this.repairInFlight === flight) this.repairInFlight = undefined;
    });
    this.repairInFlight = flight;
    return flight;
  }

  private emit(m: AgentMessage): void {
    for (const h of this.handlers) {
      try {
        h(m);
      } catch {
        /* isolate one bad subscriber */
      }
    }
  }

  async getHistory(): Promise<AgentMessage[]> {
    // Position-preserving parse: each newline segment maps to its raw index (blank/malformed → null
    // slot that still occupies its index), so keys match the live tail's per-segment counter.
    const segs = await readRolloutSegmentsSettled(this.path);
    return mapRollout(segs.map(parseLineOrNull), this.published);
  }

  /** H1b: messages and identity from ONE captured rollout prefix, so an append stays compatible.
   *
   *  Asynchronous because the scan yields between chunks (H1c round 3): a large source costs this
   *  attach wall-clock time, never the broker's event loop. */
  async captureHistorySnapshot(
    sink: HistorySnapshotSink,
  ): Promise<HistorySnapshotCapture | HistorySnapshotRefusal | undefined> {
    this.captureInFlight += 1;
    // A follow-up capture in the same attach sequence supersedes the refusal fallback below.
    if (this.deferredFlushTimer) {
      clearTimeout(this.deferredFlushTimer);
      this.deferredFlushTimer = undefined;
    }
    try {
      await codexObserveCaptureTestHold();
      const captured = await captureFileHistoryInto(this.path, sink, this.published);
      // A completed bounded-tail capture leaves an exact watermark; a synthetic over-ceiling
      // baseline adopts it so this connection's live keys agree with the history it just served.
      if (captured && !('refusal' in captured)) this.adoptCaptureWatermark();
      return captured;
    } finally {
      this.captureInFlight -= 1;
      if (this.captureInFlight === 0) {
        if (!this.baselineSynthetic) {
          // Adopted: the read starts at the capture's stop position — capture-covered bytes are
          // discarded and the remainder goes out under record-index keys.
          this.flushDeferredDrain();
        } else if (this.initialCapturePending) {
          // No adoption (refusal/failure). The attach path typically tries another capture
          // immediately — an indexed refusal is followed by the bounded-tail capture — and it
          // must find the tail still unfed or its watermark can never be adopted. Hold the
          // deferred lines across that gap; release the initial hold on a short fallback if no
          // capture comes. Arm this even when no watcher event has fired yet, or the first later
          // append on a direct/refused connection would wait indefinitely.
          this.deferredFlushTimer = setTimeout(() => {
            this.deferredFlushTimer = undefined;
            if (this.captureInFlight === 0) {
              this.initialCapturePending = false;
              this.flushDeferredDrain();
            }
          }, CODEX_OBSERVE_DEFERRED_FLUSH_MS);
        }
      }
    }
  }

  private flushDeferredDrain(): void {
    if (!this.deferredDrainPending) return;
    this.deferredDrainPending = false;
    if (this.watcher) this.drainTail();
  }

  getHistorySourceIdentity(): HistorySourceIdentity | undefined {
    return fileHistorySourceIdentity(this.path);
  }

  async listModels(): Promise<ModelOption[]> {
    // Observe must stay read-only and zero-cost; expose only the current model Codex persisted.
    // docs/architecture/client-ui.md requires the UI to show this as locked.
    return this.info.currentModel ? [codexCurrentModelOption(this.info.currentModel, this.info.model)] : [];
  }

  async listModes(): Promise<ModeOption[]> {
    return this.info.currentMode ? [codexModeOption(this.info.currentMode)] : [];
  }

  private startTail(): void {
    try {
      this.watcher = watch(this.path, () => setTimeout(() => this.drainTail(), 80));
    } catch {
      /* fs.watch unsupported here → history-only (no live follow) */
    }
  }

  /** Read bytes appended past `offset`, map each newly-completed line, emit. Best-effort enrichment:
   *  a patch_apply_end/exec_command_end/function_call usually precedes the function_call_output, so
   *  the rolling liveEnrich map is populated in time; if not, the result just lacks a chip. */
  private drainTail(): void {
    // A synthetic baseline that could still adopt an in-flight capture's watermark must not
    // consume a line yet: doing so pins the synthetic byte base forever (adoptCaptureWatermark
    // refuses once anything is out). Defer — the bytes are still in the file, and the capture's
    // completion re-drains from whichever base survives (see captureHistorySnapshot).
    if (
      this.baselineSynthetic
      && this.tailLinesConsumed === 0
      && this.tailBuf === ''
      && (
        this.initialCapturePending
        || this.captureInFlight > 0
        || this.deferredFlushTimer !== undefined
      )
    ) {
      this.deferredDrainPending = true;
      return;
    }
    let bytes: Buffer;
    try {
      const st = statSafe(this.path);
      if (!st || st.size <= this.offset) return;
      bytes = readBytesFrom(this.path, this.offset, st.size - this.offset);
      this.offset = st.size;
    } catch {
      return;
    }
    this.tailBuf += this.decoder.decode(bytes, { stream: true }); // partial multibyte chars held across reads
    let nl: number;
    while ((nl = this.tailBuf.indexOf('\n')) !== -1) {
      const raw = this.tailBuf.slice(0, nl);
      this.tailBuf = this.tailBuf.slice(nl + 1);
      this.tailLinesConsumed += 1; // once a line is out, a synthetic base can no longer be re-keyed
      const idx = this.lineIndex++; // consume the index FIRST — a blank/malformed line still advances it,
      const ln = parseLineOrNull(raw); // exactly as getHistory's position-preserving parse does (key alignment)
      // A null slot is not a record, so it settles nothing: the held line keeps waiting for a real
      // record or its timer, exactly as a whole-file map skips null slots looking for the pair.
      if (!ln) continue;
      // Whatever real record arrived settles a held assistant line, one way or the other.
      this.resolveDeferredAssistant(ln);
      this.accumulateLiveEnrich(ln);
      if (isDeferrableAssistantLine(ln)) {
        this.deferAssistant(ln, idx);
        continue;
      }
      for (const m of mapLine(ln, idx, this.liveEnrich, this.liveRuntime, undefined, this.published)) this.emit(m);
    }
  }

  /** Accumulates one tailed line, then re-establishes the map's ceiling.
   *
   *  Work is proportional to the line just read plus whatever it evicts, never
   *  to the accumulated map. */
  private accumulateLiveEnrich(ln: any): void {
    this.liveEnrichStore.accumulate(ln);
    const rawId = ln?.payload?.call_id;
    this.liveEnrichStore.evictUntilWithin(
      CODEX_LIVE_ENRICH_MAX_ENTRIES,
      CODEX_LIVE_ENRICH_MAX_BYTES,
      rawId == null ? undefined : String(rawId),
    );
  }

  /** Hold one assistant line until the next line reveals whether the paired record carrying its
   *  native id follows. */
  private deferAssistant(ln: any, index: number): void {
    this.deferredAssistant = { ln, index };
    if (this.deferredTimer) clearTimeout(this.deferredTimer);
    // The pair is written with the event record, so it nearly always lands in this same drain and the
    // timer never fires. It exists for the record that is genuinely never paired (all mid-turn
    // commentary, and carrying no native id anywhere): that answer is emitted on the line-index
    // fallback rather than withheld — a differing key costs a duplicate, a withheld line costs the
    // text itself. The key that goes out is recorded, so a later history read cannot decide again.
    this.deferredTimer = setTimeout(() => this.resolveDeferredAssistant(null), ASSISTANT_PAIR_WAIT_MS);
  }

  private resolveDeferredAssistant(next: any): void {
    if (this.deferredTimer) {
      clearTimeout(this.deferredTimer);
      this.deferredTimer = undefined;
    }
    const held = this.deferredAssistant;
    if (!held) return;
    this.deferredAssistant = undefined;
    for (const m of mapLine(held.ln, held.index, this.liveEnrich, this.liveRuntime, next, this.published)) this.emit(m);
  }

  // Observe is read-only: driving a Codex turn needs the app-server (resume increment).
  async sendPrompt(): Promise<void> {
    throw new Error('This Codex session is view-only here; driving requires an idle broker-owned resume session, not an active terminal-owned turn.');
  }
  async respondPermission(): Promise<void> {
    throw new Error('This Codex session is read-only in Observe mode. Tap Drive or use active terminal sync before approving.');
  }
  async answerQuestion(): Promise<void> {
    throw new Error('This Codex session is read-only in Observe mode. Tap Drive or use active terminal sync before answering.');
  }
  async rejectQuestion(): Promise<void> {
    throw new Error('This Codex session is read-only in Observe mode. Tap Drive or use active terminal sync before answering.');
  }
  async sendFile(_file: FileInput): Promise<void> {
    throw new Error('This Codex session is read-only in Observe mode. Tap Drive or use active terminal sync before uploading files.');
  }

  async close(): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.deferredFlushTimer) {
      clearTimeout(this.deferredFlushTimer);
      this.deferredFlushTimer = undefined;
    }
    this.initialCapturePending = false;
    this.resolveDeferredAssistant(null); // last boundary: flush before the subscribers go away
    this.handlers.clear();
    this.liveEnrich.clear();
    this.published.clear(); // line indices only mean anything to the connection that published them
  }
}

type PendingRpc = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function nativeRpcRejected(error: unknown): boolean {
  return error instanceof Error && (error as Error & { rpcRejected?: unknown }).rpcRejected === true;
}

const NATIVE_SESSION_UNRESUMABLE_CODES = new Set([
  'SESSION_NOT_RESUMABLE',
  'THREAD_NOT_RESUMABLE',
  'SESSION_UNRESUMABLE',
  'THREAD_UNRESUMABLE',
  'SESSION_APP_ONLY',
  'THREAD_APP_ONLY',
  'APP_ONLY_SESSION',
  'APP_ONLY_THREAD',
  'SESSION_RESUME_UNSUPPORTED',
  'THREAD_RESUME_UNSUPPORTED',
]);

const NATIVE_OWNERSHIP_CONFLICT_CODES = new Set([
  'ACTIVE_WRITER',
  'SESSION_ACTIVE_WRITER',
  'THREAD_ACTIVE_WRITER',
  'SESSION_ALREADY_HAS_ACTIVE_WRITER',
  'THREAD_ALREADY_HAS_ACTIVE_WRITER',
]);

function normalizedNativeSignal(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || undefined;
}

/** A native active-writer rejection is explicit session ownership evidence.
 * Codex Desktop currently runs a private stdio app-server, so the separate
 * shared daemon can truthfully report the thread absent even while Desktop
 * retains its writer. In that case thread/resume is the first native boundary
 * that can identify the conflict. Keep the match limited to exact structured
 * signals or the observed native phrase; a generic -32600 remains retryable. */
function nativeOwnershipConflictRejection(error: unknown): boolean {
  if (!nativeRpcRejected(error)) return false;
  const rpcError = error as Error & { rpcCode?: unknown; rpcData?: unknown };
  const data = rpcError.rpcData && typeof rpcError.rpcData === 'object'
    ? rpcError.rpcData as Record<string, unknown>
    : undefined;
  const signals = [data?.code, data?.reason, data?.kind];
  if (signals.some((value) => {
    const normalized = normalizedNativeSignal(value);
    return normalized !== undefined && NATIVE_OWNERSHIP_CONFLICT_CODES.has(normalized);
  })) return true;
  return /\balready has an active writer\b/i.test(rpcError.message);
}

/** Only explicit native capability/rejection facts are permanent enough to
 *  call a session unresumable. Generic JSON-RPC rejection, including internal
 *  and invalid-request failures, remains a retryable Drive restore failure. */
function nativeSessionUnresumableRejection(error: unknown): boolean {
  if (!nativeRpcRejected(error)) return false;
  const rpcError = error as Error & { rpcCode?: unknown; rpcData?: unknown };
  if (rpcError.rpcCode === -32601) return true; // thread/resume method unsupported
  const data = rpcError.rpcData && typeof rpcError.rpcData === 'object'
    ? rpcError.rpcData as Record<string, unknown>
    : undefined;
  const signals = [rpcError.rpcCode, data?.code, data?.reason, data?.kind, data?.capability];
  if (signals.some((value) => {
    const normalized = normalizedNativeSignal(value);
    return normalized !== undefined && NATIVE_SESSION_UNRESUMABLE_CODES.has(normalized);
  })) return true;
  return data?.appOnly === true || data?.resumable === false;
}

function diagnosticStrings(value: unknown, out = new Set<string>(), seen = new Set<object>()): Set<string> {
  if (typeof value === 'string') {
    if (value) out.add(value);
    return out;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) diagnosticStrings(item, out, seen);
    return out;
  }
  for (const item of Object.values(value as Record<string, unknown>)) diagnosticStrings(item, out, seen);
  return out;
}

function nativeRpcDiagnostic(
  error: unknown,
  sensitiveValues: readonly unknown[] = [],
): Pick<CodexAttachDiagnostic, 'nativeCode' | 'message'> {
  const redactions = new Set<string>();
  for (const value of sensitiveValues) diagnosticStrings(value, redactions);
  let message = error instanceof Error ? error.message : compactText(error);
  for (const sensitive of [...redactions].sort((a, b) => b.length - a.length)) {
    message = message.split(sensitive).join('[redacted]');
  }
  if (!(error instanceof Error)) return { message: compactText(message) };
  const rpcCode = (error as Error & { rpcCode?: unknown }).rpcCode;
  return {
    ...(rpcCode !== undefined ? { nativeCode: compactText(rpcCode) } : {}),
    message: compactText(message),
  };
}

async function boundedProcessExit(
  proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>,
  timeoutMs: number,
): Promise<{ exited: boolean; code?: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      proc.exited.then((code) => ({ exited: true as const, code })),
      new Promise<{ exited: false }>((resolve) => {
        timer = setTimeout(() => resolve({ exited: false }), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type PendingApproval = {
  rpcId: number | string;
  method: string;
  params: any;
};

type PendingQuestion = {
  rpcId: number | string;
  method: string;
  params: any;
};

type CodexTransport = 'stdio' | 'daemon-proxy';

class CodexUnixSocketTransport {
  private socket: Socket | undefined;
  private buffer = Buffer.alloc(0);
  private connected = false;
  private closed = false;

  constructor(
    private readonly socketPath: string,
    private readonly onMessage: (line: string) => void,
    private readonly onError?: (message: string) => void,
  ) {}

  connect(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath);
      this.socket = socket;
      const key = randomBytes(16).toString('base64');
      let handshake = Buffer.alloc(0);
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(() => finish(new Error('Codex daemon WebSocket handshake timed out')), timeoutMs);
      socket.on('connect', () => {
        socket.write(
          [
            'GET / HTTP/1.1',
            'Host: localhost',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n'),
        );
      });
      socket.on('data', (chunk) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!this.connected) {
          handshake = Buffer.concat([handshake, data]);
          const idx = handshake.indexOf('\r\n\r\n');
          if (idx === -1) return;
          const header = handshake.subarray(0, idx).toString('utf8');
          if (!/^HTTP\/1\.[01] 101\b/.test(header)) {
            finish(new Error(`Codex daemon WebSocket upgrade failed: ${header.split('\r\n')[0] || 'no status'}`));
            socket.destroy();
            return;
          }
          this.connected = true;
          finish();
          const rest = handshake.subarray(idx + 4);
          if (rest.length) this.consume(rest);
          return;
        }
        this.consume(data);
      });
      socket.on('error', (err) => {
        this.onError?.(String(err?.message ?? err));
        finish(err instanceof Error ? err : new Error(String(err)));
      });
      socket.on('close', () => {
        this.closed = true;
      });
    });
  }

  write(obj: unknown): void {
    if (!this.socket || this.closed) return;
    this.socket.write(webSocketFrame(Buffer.from(JSON.stringify(obj), 'utf8'), 0x1));
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = readWebSocketFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.bytes);
      if (frame.opcode === 0x1) {
        this.onMessage(frame.payload.toString('utf8'));
      } else if (frame.opcode === 0x8) {
        this.close();
        return;
      } else if (frame.opcode === 0x9 && this.socket && !this.closed) {
        this.socket.write(webSocketFrame(frame.payload, 0xA));
      }
    }
  }
}

function webSocketFrame(payload: Buffer, opcode: number): Buffer {
  const mask = randomBytes(4);
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
      : payload.length <= 0xffff
        ? Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 126]), u16(payload.length)])
        : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), u64(payload.length)]);
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, mask, out]);
}

function readWebSocketFrame(buf: Buffer): { opcode: number; payload: Buffer; bytes: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0f;
  const masked = Boolean(buf[1]! & 0x80);
  let len = buf[1]! & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    const big = buf.readBigUInt64BE(off);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Codex daemon WebSocket frame is too large.');
    len = Number(big);
    off += 8;
  }
  const mask = masked ? buf.subarray(off, off + 4) : undefined;
  if (masked) off += 4;
  if (buf.length < off + len) return null;
  let payload = buf.subarray(off, off + len);
  if (mask) {
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i]! ^ mask[i % 4]!;
    payload = out;
  }
  return { opcode, payload, bytes: off + len };
}

function u16(n: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(n);
  return buf;
}

function u64(n: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(n));
  return buf;
}

/** Monotonic per-process tiebreaker for [CodexResumeConnection.waitingPlaceholderEpoch]. */
let codexWaitingEpochCounter = 0;

/**
 * Broker-owned Codex app-server resume connection. JSONL framing intentionally mirrors Pi's
 * adapter shape, but the event mapper is Codex-v2-specific.
 */
class CodexResumeConnection implements SessionConnection {
  private readonly handlers = new Set<AgentMessageHandler>();
  private proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
  private daemon: CodexUnixSocketTransport | undefined;
  private reqId = 0;
  private readonly pendingRpc = new Map<string, PendingRpc>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  /** Which synthetic waiting placeholders are ACTIVE (emitted and not yet resolved). A
   *  resolution frame may only be emitted for a placeholder that was actually emitted —
   *  turn completion/idle/system-error settling paths fire after every ordinary turn, and
   *  unconditionally emitting `*-resolved` there manufactured orphan "Permission resolved"/
   *  "Question resolved" cards in every client (CR2). */
  private readonly activeWaitingPlaceholders = new Map<'approval' | 'question', string>();
  /** Clients pair request/resolution frames by exact canonical id, and canonical history outlives
   *  this connection. A plain per-connection counter restarts at 1 after every reconnect (and after
   *  a broker restart), so a fresh post-reconnect placeholder could reuse an id whose resolution is
   *  already in history and render as instantly settled. The wall-clock epoch plus a per-process
   *  tiebreaker makes every connection's ids disjoint from every other's. */
  private readonly waitingPlaceholderEpoch =
    `${Date.now().toString(36)}-${(++codexWaitingEpochCounter).toString(36)}`;
  /** Assistant identities this connection has already published from the rollout, so a re-read for an
   *  older page or a post-compaction refresh reproduces them instead of deciding again. */
  private readonly published = new CodexPublishedIdentities();
  private waitingPlaceholderSequence = 0;
  private readonly skills = new Map<string, { name: string; path: string; description?: string }>();
  private readonly turnWaiters = new Set<(turnId: string | undefined) => void>();
  private promptChain: Promise<void> = Promise.resolve();
  private pendingPromptStarts = 0;
  private turnRunState: CodexTurnRunState = { kind: 'hydrating' };
  private bootstrapApplying = true;
  private bootstrapQueue: BootstrapQueuedMessage[] = [];
  private turnStartPending = false;
  private turnRunStateVersion = 0;
  private reconcileActiveTurnFlight?: Promise<void>;
  private reconcileActiveTurnFlightVersion = 0;
  /** Serializes the exact-evidence repair probe: the watcher self-check and the broker's
   *  contradiction hand-off can both fire within one watcher interval. */
  private repairRunStateFlight?: Promise<void>;
  private readonly recentlyCompletedTurnIds = new Set<string>();
  private readonly recentlyCompletedTurnOrder: string[] = [];
  private readonly completedTurnEvidence = new Map<string, CodexCompletedTurnEvidence>();
  private userSeq = 0;
  /** Our submitted userMessage clientId → the broker's PromptInput.clientMessageId, so the echoed
   *  item (key = clientId) is stamped with `clientKey` by EXACT identity, never by text. Bounded. */
  private readonly appSendClientKeys = new Map<string, string>();
  /**
   * turnId → that turn's opening prompt key, its monotonic ordinal, and a BOUNDED recent-item index
   * for idempotent re-delivery (CR4b).
   *
   * The ordinal is assigned from `count`, so a re-delivered `item/started` for a userMessage this
   * connection already echoed keeps its first key instead of inventing a second row. `opening` is
   * what lets a terminal `turn/completed` name the prompt this socket actually rendered, so the
   * footer lands on the open turn without waiting for a rollout replay.
   *
   * Retaining every item id and key per turn was bounded only by the TURN count: one long turn with
   * many steers grew for the connection's lifetime. Ownership needs exactly the first key, the
   * ordinal needs exactly a counter, and re-delivery is a short window — so the lookup keeps only
   * the {@link CODEX_TURN_RECENT_ITEM_LIMIT} most recent items. An item evicted from that window and
   * then re-delivered is issued a new ordinal rather than merged into another message: this lane
   * never merges two prompts to stay small.
   *
   * Bounded to {@link CODEX_TURN_USER_KEY_LIMIT} turns, oldest evicted first, and released with the
   * connection. Nothing here outlives the socket.
   */
  private readonly liveTurnUserKeys = new Map<string, LiveTurnUserKeys>();
  /** Generation ordinal per turn id whose reuse was PROVEN ({@link forgetCompletedTurn}); absent
   *  means generation one. Feeds {@link codexRunKey} so reused generations keep distinct canonical
   *  run identities downstream. */
  private readonly liveRunGeneration = new Map<string, number>();
  /** turnId → newest assistant text key emitted for it, same bound and lifetime. */
  private readonly liveTurnAssistantKeys = new Map<string, string>();
  private baselineSandboxPolicy: unknown;
  private liveRuntimeTotalMs = 0;
  private liveRuntimeTurnCount = 0;
  private liveRuntimeUpdatedAt: number | undefined;
  private readonly countedLiveRuntimeTurns = new Set<string>();
  private closeFlight: Promise<void> | undefined;
  private firstRealTurnStart = true;

  constructor(
    private readonly path: string,
    private readonly threadId: string,
    private readonly cwd: string | undefined,
    readonly info: SessionInfo,
    private readonly transport: CodexTransport = 'stdio',
    private readonly reportDiagnostic: CodexAttachDiagnosticReporter = emitCodexAttachDiagnostic,
    private readonly startupTimeoutMs = CODEX_RESUME_START_TIMEOUT_MS,
    private readonly processStopTimeoutMs = CODEX_RESUME_PROCESS_STOP_TIMEOUT_MS,
  ) {}

  private diagnostic(diagnostic: Omit<CodexAttachDiagnostic, 'threadId'>): void {
    try {
      this.reportDiagnostic({ threadId: this.threadId, ...diagnostic });
    } catch {
      /* diagnostics never change connection behavior */
    }
  }

  private emit(m: AgentMessage): void {
    for (const h of this.handlers) {
      try {
        h(m);
      } catch {
        /* isolate */
      }
    }
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async start(): Promise<void> {
    try {
      await this.startConnection();
    } catch (error) {
      // Startup owns every resource it creates until the final successful
      // return. A rejected/timed-out initialize or resume therefore cannot
      // escape with a child, socket, timer, or pending RPC behind it.
      await this.close();
      throw error;
    }
  }

  private async startConnection(): Promise<void> {
    // Rollout evidence exists before either app-server transport reconnects. Admit its exact open
    // turn first so a weak thread/resume idle/notLoaded frame cannot manufacture an Idle gap. A
    // later exact matching terminal retires it through the same generic turn-id fence used for
    // main and subagent threads.
    const rolloutActiveTurnId = await exactActiveRolloutTurnId(this.path);
    if (rolloutActiveTurnId) this.markRunning(rolloutActiveTurnId);
    const bin = resolveBin('codex') ?? 'codex';
    if (this.transport === 'daemon-proxy') {
      const sock = codexAppServerSock();
      if (!sock) throw new Error('Codex sync server mode is enabled, but the app-server daemon socket is not configured or present.');
      this.daemon = new CodexUnixSocketTransport(sock, (line) => this.onLine(line), (message) => this.emit({ type: 'error', message: message.slice(0, 220) }));
      await this.daemon.connect();
    } else {
      this.proc = spawnCodex(bin, ['app-server', '--stdio'], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: this.cwd && existsSync(this.cwd) ? this.cwd : undefined,
        env: { ...process.env },
      });
      this.diagnostic({
        event: 'child-lifecycle',
        transport: this.transport,
        outcome: 'spawned',
        pid: this.proc.pid,
      });
      const split = createJsonlSplitter((line) => this.onLine(line));
      void (async () => {
        const reader = this.proc!.stdout.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            split(decoder.decode(value, { stream: true }));
          }
        } catch {
          /* process ended */
        }
      })();
      void (async () => {
        const reader = this.proc!.stderr.getReader();
        const decoder = new TextDecoder();
        let stderr = '';
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            stderr += decoder.decode(value, { stream: true });
          }
        } catch {
          /* process ended */
        }
        const line = stderr.trim().split('\n').find((s) => s.trim());
        if (line && this.proc) this.emit({ type: 'error', message: line.slice(0, 220) });
      })();
    }

    this.diagnostic({ event: 'rpc-stage', transport: this.transport, stage: 'initialize', outcome: 'started' });
    try {
      await this.rpc('initialize', {
        clientInfo: brokerClientInfo(),
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, this.startupTimeoutMs);
      this.diagnostic({ event: 'rpc-stage', transport: this.transport, stage: 'initialize', outcome: 'succeeded' });
    } catch (error) {
      this.diagnostic({
        event: 'rpc-stage',
        transport: this.transport,
        stage: 'initialize',
        outcome: nativeRpcRejected(error) ? 'rejected' : 'failed-or-timed-out',
        ...nativeRpcDiagnostic(error),
      });
      throw error;
    }
    this.write({ method: 'initialized', params: {} });
    // Rejoin vs cold load: an already-loaded thread carries live settings someone may have explicitly
    // set (an app pick or a synced terminal) — trust the resume response. A COLD load initializes the
    // thread from the daemon's config defaults (verified 0.144.1: resume ignores the rollout's
    // approval_policy/approvals_reviewer AND model), so the session's last-used mode and model must be restored from the
    // rollout tail or every reopen silently resets to "ask permission" on the config-default model.
    let alreadyLoaded = false;
    try {
      // Short timeout: this is an attach-path pre-check; a server that cannot answer it quickly
      // (older binary, minimal fake) must degrade to the cold-load path, not stall the attach.
      alreadyLoaded = (await loadedCodexThreadIds((m, p) => this.rpc(m, p, 5000))).has(this.threadId);
    } catch {
      /* fresh stdio server or older daemon: treat as a cold load */
    }
    this.diagnostic({ event: 'rpc-stage', transport: this.transport, stage: 'thread/resume', outcome: 'started' });
    let resumed: any;
    try {
      resumed = await this.rpc('thread/resume', {
        threadId: this.threadId,
        path: this.path,
        cwd: this.cwd,
        // A resume response populates thread.turns by default. That made the
        // 451 MB Computer Use session serialize and synchronously JSON.parse
        // its complete native history on the broker event loop before the
        // startup timer could fire. Ask the native protocol for metadata/live
        // state only; the bounded page below retains the one recent turn used
        // to seed run state. This is capability-driven for every thread, never
        // a title, origin, content, or rollout-size classification.
        excludeTurns: true,
        // Requesting raw events during resume would create a second live content channel. Keep it off.
        initialTurnsPage: { limit: 1, sortDirection: 'desc', itemsView: 'summary' },
      }, this.startupTimeoutMs);
      this.diagnostic({ event: 'rpc-stage', transport: this.transport, stage: 'thread/resume', outcome: 'succeeded' });
    } catch (error) {
      const rejected = nativeRpcRejected(error);
      const facts = nativeRpcDiagnostic(error, [this.threadId, this.path, this.cwd]);
      this.diagnostic({
        event: 'rpc-stage',
        transport: this.transport,
        stage: 'thread/resume',
        outcome: rejected ? 'rejected' : 'failed-or-timed-out',
        ...facts,
      });
      if (nativeOwnershipConflictRejection(error)) {
        throw new OwnershipConflictError(
          'Codex refused Take over because this session already has an active writer.',
          'native-active-writer',
        );
      }
      if (nativeSessionUnresumableRejection(error)) {
        throw new NativeSessionUnresumableError(
          `Codex could not resume this session for app control: ${facts.message ?? 'the native runtime rejected thread/resume'}`,
          facts.nativeCode,
        );
      }
      throw error;
    }
    await this.applyResumedThreadState(resumed);
    if (resumed?.model) {
      this.info.currentModel = {
        providerID: String(resumed.modelProvider ?? 'openai'),
        modelID: String(resumed.model),
        reasoningEffort: resumed?.reasoningEffort ? String(resumed.reasoningEffort) : undefined,
      };
    }
    let approvalPolicy: unknown = resumed?.approvalPolicy;
    let approvalsReviewer: unknown = resumed?.approvalsReviewer;
    let sandboxPolicy: unknown = resumed?.sandbox;
    if (!alreadyLoaded) {
      const restored = await this.restoreRolloutThreadSettings();
      const rolloutHadMode = !!restored && (
        restored.approvalPolicy !== undefined ||
        restored.approvalsReviewer !== undefined ||
        restored.sandboxPolicy !== undefined
      );
      if (restored) {
        approvalPolicy = restored.approvalPolicy ?? approvalPolicy;
        approvalsReviewer = restored.approvalsReviewer ?? approvalsReviewer;
        sandboxPolicy = restored.sandboxPolicy ?? sandboxPolicy;
        if (restored.model) {
          this.info.currentModel = {
            providerID: restored.modelProvider ?? this.info.currentModel?.providerID ?? 'openai',
            modelID: restored.model,
            ...(restored.effort ? { reasoningEffort: restored.effort } : {}),
          };
        }
      }
      // Never-configured session (no turn_context mode in the rollout): the daemon's config default
      // would govern — usually "ask permission". Always assert the complete canonical app-default
      // tuple. Comparing only the derived product mode is insufficient because legacy
      // `never + user + safe` also derives to Approve for me but disables Codex's auto reviewer.
      // Recorded modes above and already-loaded threads are untouched; an explicit pick (app or
      // terminal) still overrides.
      if (!rolloutHadMode) {
        const def = codexPermissionMode(CODEX_DEFAULT_SESSION_MODE, safeCodexSandboxPolicy(sandboxPolicy, this.cwd));
        try {
          await this.rpc('thread/settings/update', {
            threadId: this.threadId,
            approvalPolicy: def.approvalPolicy,
            approvalsReviewer: def.approvalsReviewer,
            ...(def.sandboxPolicy !== undefined ? { sandboxPolicy: def.sandboxPolicy } : {}),
          }, 5000);
          approvalPolicy = def.approvalPolicy;
          approvalsReviewer = def.approvalsReviewer;
          sandboxPolicy = def.sandboxPolicy ?? sandboxPolicy;
        } catch {
          /* older server without settings/update — the config default stands */
        }
      }
    }
    this.baselineSandboxPolicy = safeCodexSandboxPolicy(sandboxPolicy, this.cwd);
    this.info.currentMode = codexModeFromSettings(approvalPolicy, approvalsReviewer, sandboxPolicy);
    if (resumed?.thread?.name) this.info.title = String(resumed.thread.name);
    this.refreshSyncHint();
    this.bootstrapApplying = false;
    await this.flushBootstrapQueue();
    this.diagnostic({
      event: 'child-lifecycle',
      transport: this.transport,
      outcome: 'start-complete',
      pid: this.proc?.pid,
      pendingRpcCount: this.pendingRpc.size,
    });
  }

  /** Cold load only: push the rollout tail's approval/reviewer/sandbox/model settings into the freshly loaded
   *  thread so the daemon's config default does not masquerade as this session's mode OR model (a cold
   *  resume returns the config default for both — maintainer's spark session reopened as gpt-5.6-sol, and
   *  every undirty prompt would then RUN on sol). Model values are restored verbatim from the rollout:
   *  codex accepts them unvalidated (probed 0.144.3), same trust as the `-m` in the sync hint. Returns
   *  what was restored, or null when the rollout has no turn_context or the server lacks the RPC. */
  private async restoreRolloutThreadSettings(): Promise<{ approvalPolicy?: unknown; approvalsReviewer?: unknown; sandboxPolicy?: unknown; model?: string; modelProvider?: string; effort?: string } | null> {
    const ctx = readRolloutTurnContext(this.path, 'tail');
    const approvalPolicy = ctx?.approval_policy ?? ctx?.approvalPolicy;
    const approvalsReviewer = ctx?.approvals_reviewer ?? ctx?.approvalsReviewer;
    const sandboxPolicy = wireSandboxPolicyFromRollout(ctx?.sandbox_policy ?? ctx?.sandboxPolicy);
    const model = firstMetadataString([ctx], ['model', 'modelID', 'modelId', 'model_id']);
    const modelProvider = firstMetadataString([ctx], ['modelProvider', 'model_provider', 'provider']);
    const effort = firstMetadataString([ctx], ['effort', 'reasoningEffort', 'reasoning_effort', 'model_reasoning_effort']);
    if (approvalPolicy === undefined && approvalsReviewer === undefined && sandboxPolicy === undefined && !model) return null;
    try {
      await this.rpc('thread/settings/update', {
        threadId: this.threadId,
        ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
        ...(approvalsReviewer !== undefined ? { approvalsReviewer } : {}),
        ...(sandboxPolicy !== undefined ? { sandboxPolicy } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      }, 5000);
      return { approvalPolicy, approvalsReviewer, sandboxPolicy, model, modelProvider, effort };
    } catch {
      return null;
    }
  }

  /** Rebuild the advertised sync command whenever this conn learns a new current model. The roster
   *  overlays an OPEN conn's info over discovery rows, so a stale attach-time hint (built before the
   *  first turn recorded a model) would otherwise shadow the on-disk `-m` until reattach. */
  private refreshSyncHint(): void {
    const ts = this.info.control?.terminalSync;
    if (!this.info.terminalSyncHint && !ts?.supported) return; // sync disabled at attach time
    const hint = codexTerminalSyncHint(this.threadId, this.cwd, this.info.currentModel?.modelID ?? this.info.model);
    if (!hint) return;
    this.info.terminalSyncHint = hint;
    if (ts?.supported && !ts.active && ts.command) ts.command = hint.command;
  }

  private write(obj: unknown): void {
    if (this.daemon) {
      this.daemon.write(obj);
      return;
    }
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
    try {
      this.proc.stdin.flush?.();
    } catch {
      /* ignore flush support differences in spawn environment */
    }
  }

  private rpc<T = any>(method: string, params: unknown, timeoutMs = 30000): Promise<T> {
    const id = ++this.reqId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRpc.delete(String(id))) reject(new Error(`codex ${method} timed out`));
      }, timeoutMs);
      this.pendingRpc.set(String(id), { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  private makeCodexRpcError(payload: unknown): Error {
    if (payload && typeof payload === 'object') {
      const rpcErr = payload as { message?: unknown; code?: unknown; data?: unknown };
      const err: Error & { rpcCode?: unknown; rpcData?: unknown; rpcRejected?: true } = new Error(String(rpcErr.message ?? payload));
      err.rpcCode = rpcErr.code;
      err.rpcData = rpcErr.data;
      err.rpcRejected = true;
      return err;
    }
    const err: Error & { rpcRejected?: true } = new Error(String(payload));
    err.rpcRejected = true;
    return err;
  }

  private onLine(line: string): void {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    const id = obj?.id;
    if (id != null && ('result' in obj || 'error' in obj)) {
      const p = this.pendingRpc.get(String(id));
      if (p) {
        clearTimeout(p.timer);
        this.pendingRpc.delete(String(id));
        if (obj.error) p.reject(this.makeCodexRpcError(obj.error));
        else p.resolve(obj.result);
        return;
      }
    }
    if (id != null && obj?.method) {
      if (!this.shouldProcessInboundMessage(obj.method, obj.params)) {
        return;
      }
      if (this.bootstrapApplying && this.isThreadScopedMessage(obj.method)) {
        this.bootstrapQueue.push({ method: obj.method, rpcId: id, params: obj.params ?? {} });
        return;
      }
      this.handleServerRequest(obj.method, id, obj.params ?? {});
      return;
    }
    if (!obj?.method) return;
    if (!this.shouldProcessInboundMessage(obj.method, obj.params)) return;
    if (this.bootstrapApplying && this.isThreadScopedMessage(obj.method)) {
      this.bootstrapQueue.push({ method: obj.method, params: obj.params ?? {} });
      return;
    }
    this.handleNotification(obj.method, obj.params ?? {});
  }

  private shouldProcessInboundMessage(method: string, params: any): boolean {
    if (!params || typeof params !== 'object') return this.transport !== 'daemon-proxy' || !this.isThreadScopedMessage(method);
    if (params.threadId !== undefined) {
      return String(params.threadId) === this.threadId;
    }
    if (this.isThreadScopedMessage(method)) {
      return this.transport !== 'daemon-proxy';
    }
    return true;
  }

  private handleNotification(method: string, params: any): void {
    this.updateCurrentModelFromNative(params);
    switch (method) {
      case 'turn/started': {
        const startedTurnId = params?.turn?.id;
        if (typeof startedTurnId === 'string' && startedTurnId) {
          if (this.isReplayedTurnStart(startedTurnId, params?.turn)) {
            const settleTurn = this.turnRunState.kind !== 'active' || this.turnRunState.turnId === startedTurnId;
            const idleChanged = settleTurn && this.turnRunState.kind !== 'idle';
            if (settleTurn) this.markIdle();
            this.emitCompletedTurnEvidence(startedTurnId, settleTurn, idleChanged);
          } else {
            const newlyAdmitted = this.turnRunState.kind !== 'active' || this.turnRunState.turnId !== startedTurnId;
            this.markRunning(startedTurnId);
            if (newlyAdmitted) {
              this.emit({ type: 'status', status: 'running' });
              this.emitNativeRunSummary(params, 'running');
            }
          }
        } else {
          this.markUnknown();
          this.emit({ type: 'status', status: 'running' });
          this.emitNativeRunSummary(params, 'running');
        }
        return;
      }
      case 'turn/completed': {
        const completedTurnId = typeof params?.turn?.id === 'string' && params.turn.id ? String(params.turn.id) : undefined;
        if (!completedTurnId) {
          // There is no safe run key to retain for a missing-id completion, but its terminal error
          // and idle status are still useful when no newer active turn is present.
          if (this.turnRunState.kind === 'active') return;
          const idleChanged = this.turnRunState.kind !== 'idle';
          this.markIdle();
          this.settleExternallyResolved('approval');
          this.settleExternallyResolved('question');
          if (params?.turn?.status === 'failed' && params?.turn?.error) {
            this.emit({ type: 'error', message: compactText(params.turn.error) });
          }
          if (idleChanged) this.emit({ type: 'status', status: 'idle' });
          this.emitNativeRunSummary(params, codexRunStatusFromNative(params?.turn?.status));
          return;
        }
        this.rememberCompletedTurn(completedTurnId, params);
        const hasMatchingActiveTurn = this.turnRunState.kind === 'active' && completedTurnId === this.turnRunState.turnId;
        if (hasMatchingActiveTurn) {
          this.markIdle();
          this.emitCompletedTurnEvidence(completedTurnId, true, true);
          return;
        }
        // Do not let an old completion clear a newer active turn, but still preserve the terminal
        // evidence. A completion can arrive before the matching turn/start result in one read chunk.
        if (this.turnRunState.kind === 'active') {
          this.emitCompletedTurnEvidence(completedTurnId, false);
          return;
        }
        const idleChanged = this.turnRunState.kind !== 'idle';
        this.markIdle();
        this.emitCompletedTurnEvidence(completedTurnId, true, idleChanged);
        return;
      }
      case 'serverRequest/resolved':
        this.handleServerRequestResolved(params);
        return;
      case 'thread/settings/updated':
        this.handleThreadSettingsUpdated(params);
        return;
      case 'thread/status/changed':
        this.handleThreadStatusChanged(params);
        return;
      case 'thread/goal/updated':
        this.handleGoalUpdated(params);
        return;
      case 'thread/goal/cleared':
        this.handleGoalCleared(params);
        return;
      case 'turn/plan/updated': {
        const taskList = taskListStateFromCodexNativePlan(params);
        if (taskList) this.emit(taskList);
        return;
      }
      case 'item/started':
        this.handleItemStarted(params?.item, String(params?.turnId ?? ''));
        return;
      case 'item/completed':
        this.handleItemCompleted(params?.item, String(params?.turnId ?? ''));
        return;
      case 'item/agentMessage/delta':
        if (params?.delta) this.emit({ type: 'model-output', delta: String(params.delta), key: codexTextKey(params, 't') });
        return;
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        if (params?.delta) this.emit({ type: 'thinking', delta: String(params.delta), key: codexTextKey(params, 'r') });
        return;
      case 'thread/tokenUsage/updated': {
        const u = params?.tokenUsage?.total;
        if (u) this.emit({ type: 'token-count', input: u.inputTokens, output: u.outputTokens, cacheRead: u.cachedInputTokens });
        return;
      }
      case 'thread/compacted':
        this.emit({
          type: 'history-reset',
          notice: 'Compacted the conversation.',
          semantic: { kind: 'compaction' },
        });
        return;
      case 'error':
        this.emit({ type: 'error', message: compactText(params?.error ?? params) });
        return;
      default:
        return;
    }
  }

  /**
   * Generation fence for a `turn/started` whose id this connection already retired (R0c.4 round 2).
   *
   * The replay guard exists because the daemon can redeliver a start after its completion — a
   * reconnect, a bootstrap flush, an out-of-order batch — and admitting that would resurrect a
   * finished turn. Keyed on the id ALONE it also swallows a genuine new turn that reuses the id,
   * which nothing in the protocol forbids. The runtime's own timestamps separate the two: a start
   * that began after the completion this connection recorded cannot be that completion's start.
   * Missing or equal timestamps prove nothing and stay on the replay side.
   *
   * A proven new generation forgets the retired record entirely; otherwise the new turn's own
   * completion would be swallowed by the exactly-once evidence guard it inherited.
   */
  private isReplayedTurnStart(turnId: string, startedTurn: any): boolean {
    if (!this.recentlyCompletedTurnIds.has(turnId)) return false;
    const completedTurn = this.completedTurnEvidence.get(turnId)?.params?.turn;
    const generation = codexTurnStartGeneration(
      timestampToMs(startedTurn?.startedAt ?? startedTurn?.started_at ?? startedTurn?.createdAt ?? startedTurn?.created_at),
      timestampToMs(completedTurn?.completedAt ?? completedTurn?.completed_at ?? completedTurn?.finishedAt ?? completedTurn?.finished_at),
    );
    if (generation === 'replay') return true;
    this.forgetCompletedTurn(turnId);
    return false;
  }

  private forgetCompletedTurn(turnId: string): void {
    this.recentlyCompletedTurnIds.delete(turnId);
    this.completedTurnEvidence.delete(turnId);
    const at = this.recentlyCompletedTurnOrder.indexOf(turnId);
    if (at !== -1) this.recentlyCompletedTurnOrder.splice(at, 1);
    // The runtime-total ledger is keyed by turn id too; a new generation must be countable again.
    this.countedLiveRuntimeTurns.delete(turnId);
    // Transcript identity is generation-scoped as well. Without this the new turn's footer names the
    // PREVIOUS generation's opening prompt and its newest answer — the summary would attach to
    // output the new turn never produced. The prompt ORDINAL deliberately survives (see
    // {@link beginCodexTurnGeneration}), which is also what keeps live and replay convergent.
    beginCodexTurnGeneration(this.liveTurnUserKeys.get(turnId));
    this.liveTurnAssistantKeys.delete(turnId);
    // Canonical RUN identity is generation-scoped too: entries exist only for ids that PROVED a
    // second generation, so this map stays tiny for any real session.
    this.liveRunGeneration.set(turnId, (this.liveRunGeneration.get(turnId) ?? 1) + 1);
  }

  private rememberCompletedTurn(turnId: string, params: any): void {
    if (!this.recentlyCompletedTurnIds.has(turnId)) {
      this.recentlyCompletedTurnIds.add(turnId);
      this.recentlyCompletedTurnOrder.push(turnId);
      while (this.recentlyCompletedTurnOrder.length > CODEX_RECENT_COMPLETED_TURN_LIMIT) {
        const expired = this.recentlyCompletedTurnOrder.shift();
        if (expired) {
          this.recentlyCompletedTurnIds.delete(expired);
          this.completedTurnEvidence.delete(expired);
        }
      }
    }
    if (!this.completedTurnEvidence.has(turnId)) {
      this.completedTurnEvidence.set(turnId, { params, emitted: false });
    }
  }

  private emitCompletedTurnEvidence(turnId: string, settleTurn: boolean, emitIdle: boolean = settleTurn): void {
    const evidence = this.completedTurnEvidence.get(turnId);
    if (!evidence || evidence.emitted) return;
    evidence.emitted = true;
    const params = evidence.params;
    const terminalStatus = codexRunStatusFromNative(params?.turn?.status);
    if (settleTurn) {
      this.settleExternallyResolved('approval');
      this.settleExternallyResolved('question');
    }
    if (params?.turn?.status === 'failed' && params?.turn?.error) {
      this.emit({ type: 'error', message: compactText(params.turn.error) });
    }
    // The rollout records this marker as `turn_aborted`, but an attached
    // app-server connection sees the terminal state first as
    // `turn/completed`. Emit the same structured boundary here so a stopped
    // zero-output turn is correct immediately instead of only after refresh.
    // `evidence.emitted` makes this exactly-once even when completion wins the
    // race with `turn/started`.
    if (terminalStatus === 'cancelled') {
      this.emit({
        type: 'notice',
        message: CODEX_INTERRUPTED_NOTICE,
        semantic: {
          kind: 'interruption',
          reason: 'generic',
          turnId,
        },
      });
    }
    if (emitIdle) this.emit({ type: 'status', status: 'idle' });
    this.emitNativeRunSummary(params, terminalStatus);
  }

  private isTurnSteerMismatchError(error: unknown): boolean {
    const anyErr = error as { message?: unknown; rpcCode?: unknown; rpcData?: unknown } | undefined;
    const code = anyErr?.rpcCode;
    if (code === 'expected_active_turn' || code === 'MISMATCHED_ACTIVE_TURN' || code === 'ACTIVE_TURN_MISMATCH') return true;
    const data = anyErr?.rpcData;
    const dataCode = typeof data === 'object' && data !== null ? String((data as any).code ?? (data as any).name ?? '') : '';
    if (dataCode && (dataCode === 'expected_active_turn' || dataCode === 'MISMATCHED_ACTIVE_TURN' || dataCode === 'ACTIVE_TURN_MISMATCH')) return true;
    const message = String(anyErr?.message ?? '').toLowerCase();
    return message.includes('expected active turn');
  }

  private canApplyReconciledState(expectedTurnRunVersion: number): boolean {
    return this.turnRunStateVersion === expectedTurnRunVersion
      && (this.turnRunState.kind === 'unknown' || this.turnRunState.kind === 'hydrating');
  }

  /**
   * Repair a DEFINITE latched run state from exact native evidence (R0c.4).
   *
   * {@link canApplyReconciledState} deliberately admits only unknown/hydrating, so a wrong-but-
   * definite Idle (or an Active pinned to a turn id the runtime no longer has) was unrepairable —
   * the steer path only got past it by forcing `markUnknown()` first, which is not something a
   * passive observer may do. This is the same reconciliation, version-fenced identically, with one
   * difference: the evidence must be exact. An in-progress turn id admits Working; an exact
   * non-active thread status retires an admitted turn ONLY with a matching terminal for that exact
   * id. Weak Idle/notLoaded frames, inferred scans, and recency reach none of this.
   *
   * Callers offer a contradiction, never an answer. Failure is unknown evidence and changes nothing.
   */
  requestRunStateRepair(): Promise<void> {
    if (this.repairRunStateFlight) return this.repairRunStateFlight;
    const flight = this.repairRunStateFromNative().finally(() => {
      if (this.repairRunStateFlight === flight) this.repairRunStateFlight = undefined;
    });
    this.repairRunStateFlight = flight;
    return flight;
  }

  private async repairRunStateFromNative(): Promise<void> {
    // Bootstrap owns the initial projection and queues thread-scoped traffic behind itself; a repair
    // racing it would decide from a half-applied resume.
    if (this.bootstrapApplying) return;
    const expectedVersion = this.turnRunStateVersion;
    let read: any;
    try {
      read = await this.rpc('thread/read', { threadId: this.threadId, includeTurns: true }, 5000);
    } catch {
      try {
        read = await this.rpc('thread/turns/list', { threadId: this.threadId, limit: 1, sortDirection: 'desc' }, 5000);
      } catch {
        return; // an unavailable runtime is unknown evidence
      }
    }
    // Any live frame delivered while the probe was in flight is NEWER than what it read.
    if (this.turnRunStateVersion !== expectedVersion) return;
    const evidence = readCodexNativeRunEvidence(read);
    const current = this.turnRunState.kind === 'active'
      ? { kind: 'active' as const, turnId: this.turnRunState.turnId }
      : { kind: this.turnRunState.kind };
    const repair = decideCodexRunStateRepair(current, evidence, (turnId) => this.recentlyCompletedTurnIds.has(turnId));
    if (repair.kind === 'none') return;
    // A repaired transition is a real turn boundary, so it takes the SAME lifecycle a delivered one
    // takes — run-summary open/close, footer, Attention observation, retention release. Emitting only
    // a status frame left the run key open in `ManagedConn.activeRunKeys` forever: retention stayed
    // active behind a visibly Idle session, and a terminal discovered by repair produced no footer.
    // Everything below routes through `completedTurnEvidence`, so the exactly-once guard is shared
    // with delivered terminals rather than duplicated.
    if (repair.kind === 'running') {
      const superseded = this.activeTurnId();
      if (superseded && superseded !== repair.turnId) {
        // The runtime reports a DIFFERENT turn in progress, so the one this owner held is over.
        // Close its lifecycle without settling to idle — a newer turn is active — exactly as the
        // "old completion while a newer turn is active" branch of `turn/completed` does.
        this.rememberCompletedTurn(superseded, this.nativeTurnEvidence(read, superseded));
        this.emitCompletedTurnEvidence(superseded, false);
      }
      this.markRunning(repair.turnId);
      this.emit({ type: 'status', status: 'running' });
      this.emitNativeRunSummary(this.nativeTurnEvidence(read, repair.turnId), 'running');
      return;
    }
    const admitted = this.activeTurnId();
    if (!admitted) {
      // Nothing to account for: no run key is open, so there is no summary to close. Mirrors the
      // id-less `turn/completed` branch.
      this.settleExternallyResolved('approval');
      this.settleExternallyResolved('question');
      this.markIdle();
      this.emit({ type: 'status', status: 'idle' });
      return;
    }
    const alreadyEmitted = this.completedTurnEvidence.get(admitted)?.emitted === true;
    this.rememberCompletedTurn(admitted, this.nativeTurnEvidence(read, admitted));
    this.markIdle();
    if (alreadyEmitted) {
      // This turn's terminal evidence was already published (e.g. closed while a newer turn was
      // active). Re-emitting it would break exactly-once, so only the run-state settle is left.
      this.settleExternallyResolved('approval');
      this.settleExternallyResolved('question');
      this.emit({ type: 'status', status: 'idle' });
      return;
    }
    this.emitCompletedTurnEvidence(admitted, true, true);
  }

  /** Native evidence for one turn out of a `thread/read`/`thread/turns/list` result, shaped like the
   *  notification params the run-summary path consumes. A turn the read does not list carries no
   *  status: `codexRunStatusFromNative(undefined)` is the neutral terminal, which is the most this
   *  knows — the runtime proved the turn is no longer in progress, not how it ended. */
  private nativeTurnEvidence(read: any, turnId: string): any {
    const turns: any[] = [
      ...(Array.isArray(read?.thread?.turns) ? read.thread.turns : []),
      ...(Array.isArray(read?.turns) ? read.turns : []),
      ...(Array.isArray(read?.data) ? read.data : []),
    ];
    const record = turns.find((turn) => turn?.id != null && String(turn.id) === turnId);
    return { threadId: this.threadId, turn: { ...(record ?? {}), id: turnId } };
  }

  private async reconcileActiveTurnFromNative(expectedTurnRunVersion: number = this.turnRunStateVersion): Promise<void> {
    if (!this.canApplyReconciledState(expectedTurnRunVersion)) return;
    if (this.reconcileActiveTurnFlight && this.reconcileActiveTurnFlightVersion === expectedTurnRunVersion) {
      return this.reconcileActiveTurnFlight;
    }
    const flight = (async () => {
      try {
        const read = await this.rpc('thread/read', { threadId: this.threadId, includeTurns: true }, 5000);
        if (!this.canApplyReconciledState(expectedTurnRunVersion)) return;
        const statusType = String(read?.thread?.status?.type ?? '').trim();
        if (statusType && statusType !== 'active') {
          this.markIdle();
          return;
        }
        const turns = [
          ...(Array.isArray(read?.thread?.turns) ? read.thread.turns : []),
          ...(Array.isArray(read?.turns) ? read.turns : []),
        ];
        const activeTurnId = this.pickNewestInProgressTurnId(turns);
        if (!this.canApplyReconciledState(expectedTurnRunVersion)) return;
        if (activeTurnId) {
          this.markRunning(activeTurnId);
          return;
        }
        try {
          const list = await this.rpc('thread/turns/list', { threadId: this.threadId, limit: 1, sortDirection: 'desc' }, 5000);
          if (!this.canApplyReconciledState(expectedTurnRunVersion)) return;
          const turns = Array.isArray(list?.data) ? list.data : [];
          const activeTurnId = this.pickNewestInProgressTurnId(turns);
          if (!this.canApplyReconciledState(expectedTurnRunVersion)) return;
          if (activeTurnId) this.markRunning(activeTurnId);
          else this.markUnknown();
        } catch {
          if (this.canApplyReconciledState(expectedTurnRunVersion)) this.markUnknown();
        }
        return;
      } catch {
        try {
          const list = await this.rpc('thread/turns/list', { threadId: this.threadId, limit: 1, sortDirection: 'desc' }, 5000);
          if (!this.canApplyReconciledState(expectedTurnRunVersion)) return;
          const turns = Array.isArray(list?.data) ? list.data : [];
          const activeTurnId = this.pickNewestInProgressTurnId(turns);
          if (!this.canApplyReconciledState(expectedTurnRunVersion)) return;
          if (activeTurnId) this.markRunning(activeTurnId);
          else this.markUnknown();
        } catch {
          if (this.canApplyReconciledState(expectedTurnRunVersion)) this.markUnknown();
        }
      }
    })();
    this.reconcileActiveTurnFlight = flight;
    this.reconcileActiveTurnFlightVersion = expectedTurnRunVersion;
    return flight.finally(() => {
      if (this.reconcileActiveTurnFlight === flight) {
        this.reconcileActiveTurnFlight = undefined;
        this.reconcileActiveTurnFlightVersion = 0;
      }
    });
  }

  private turnRunStateMatches(expectedVersion: number, expectedState: CodexTurnRunState): boolean {
    if (this.turnRunStateVersion !== expectedVersion || expectedState.kind !== this.turnRunState.kind) return false;
    if (expectedState.kind !== 'active') return true;
    if (this.turnRunState.kind !== 'active') return false;
    return expectedState.turnId === this.turnRunState.turnId;
  }

  private async submitTurnSteerWithRecovery(
    expectedTurnId: string,
    clientUserMessageId: string,
    content: any[],
    model?: PromptInput['model'],
    permissionMode?: string,
  ): Promise<void> {
    try {
      await this.rpc('turn/steer', {
        threadId: this.threadId,
        expectedTurnId,
        clientUserMessageId,
        input: content,
      }, 15000);
      return;
    } catch (error) {
      if (!this.isTurnSteerMismatchError(error)) throw error;
      // The native precondition is authoritative. Reconcile even if an intervening completion
      // notification already moved our local state to idle; that is the race this recovery covers.
      if (this.turnRunState.kind !== 'unknown' && this.turnRunState.kind !== 'hydrating') this.markUnknown();
      await this.reconcileActiveTurnFromNative(this.turnRunStateVersion);
      const resolvedTurnId = this.activeTurnId();
      if (resolvedTurnId) {
        await this.rpc('turn/steer', {
          threadId: this.threadId,
          expectedTurnId: resolvedTurnId,
          clientUserMessageId,
          input: content,
        }, 15000);
        return;
      }
      if (this.turnRunState.kind === 'idle') {
        await this.submitTurnStart(content, clientUserMessageId, model, permissionMode);
        return;
      }
      throw error;
    }
  }

  private async submitTurnStart(
    content: any[],
    clientUserMessageId: string,
    model?: PromptInput['model'],
    permissionMode?: string,
  ): Promise<void> {
    // Only an EXPLICIT app pick overrides the permission tuple. Codex persists turn/start's
    // approval/reviewer settings "for this turn and subsequent turns", so unconditionally re-asserting a
    // fallback here is what used to clobber a synced terminal's approve-for-me back to "ask"
    // on every prompt (issues-part3). No pick → omit → the thread's live settings govern.
    const mode = permissionMode !== undefined ? codexPermissionMode(permissionMode, this.baselineSandboxPolicy) : undefined;
    const expectedTurnRunVersion = this.turnRunStateVersion;
    const expectedTurnRunState = this.turnRunState;
    const captureFirstTurnStart = this.firstRealTurnStart;
    this.firstRealTurnStart = false;
    this.turnStartPending = true;
    try {
      const started: any = await this.rpc('turn/start', {
        threadId: this.threadId,
        clientUserMessageId,
        input: content,
        cwd: this.cwd,
        ...(mode ? {
          approvalPolicy: mode.approvalPolicy,
          approvalsReviewer: mode.approvalsReviewer,
          ...(mode.sandboxPolicy ? { sandboxPolicy: mode.sandboxPolicy } : {}),
        } : {}),
        model: model?.modelID,
        modelProvider: model?.providerID,
        effort: model?.reasoningEffort,
      }, 15000);
      if (mode) this.info.currentMode = mode.value;
      const startedTurnId = started?.turn?.id ? String(started.turn.id) : undefined;
      if (startedTurnId && this.isReplayedTurnStart(startedTurnId, started?.turn)) {
        const settleTurn = this.turnRunState.kind !== 'active' || this.turnRunState.turnId === startedTurnId;
        const idleChanged = settleTurn && this.turnRunState.kind !== 'idle';
        if (settleTurn) this.markIdle();
        this.emitCompletedTurnEvidence(startedTurnId, settleTurn, idleChanged);
        return;
      }
      if (this.turnRunStateMatches(expectedTurnRunVersion, expectedTurnRunState)) {
        if (startedTurnId) this.markRunning(startedTurnId);
        else this.markUnknown();
      }
    } catch (err) {
      if (captureFirstTurnStart) {
        this.diagnostic({
          event: 'rpc-stage',
          transport: this.transport,
          stage: 'turn/start',
          outcome: nativeRpcRejected(err) ? 'rejected' : 'failed-or-timed-out',
          ...nativeRpcDiagnostic(err, [this.threadId, this.cwd, clientUserMessageId, content]),
        });
      }
      if (this.turnRunStateMatches(expectedTurnRunVersion, expectedTurnRunState)) {
        this.markUnknown();
        const reconcileVersion = this.turnRunStateVersion;
        await this.reconcileActiveTurnFromNative(reconcileVersion);
      }
      throw err;
    }
  }

  private updateCurrentModelFromNative(params: any): void {
    const currentModel = codexCurrentModelFromNative(params, this.info.currentModel?.providerID);
    if (!currentModel) return;
    const previous = this.info.currentModel;
    // Native notifications are not all complete thread snapshots. A settings/turn update can repeat
    // the current model while omitting its effort; treating that omission as a reset silently loses
    // an exact selection such as Ultra. Preserve the known effort only for the exact same
    // provider/model. A real model change never inherits another model's effort ladder.
    if (
      currentModel.reasoningEffort === undefined &&
      previous?.reasoningEffort !== undefined &&
      previous.providerID === currentModel.providerID &&
      previous.modelID === currentModel.modelID
    ) {
      currentModel.reasoningEffort = previous.reasoningEffort;
    }
    const changed =
      previous?.providerID !== currentModel.providerID ||
      previous?.modelID !== currentModel.modelID ||
      previous?.reasoningEffort !== currentModel.reasoningEffort;
    this.info.currentModel = currentModel;
    this.info.model = currentModel.modelID;
    if (changed) {
      this.refreshSyncHint();
      this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { currentModel, model: this.info.model } });
    }
  }

  private handleThreadStatusChanged(params: any): void {
    const status = params?.status;
    if (status?.type === 'active') {
      const exactTurnAlreadyActive = this.turnRunState.kind === 'active' && !!this.turnRunState.turnId;
      if (this.turnRunState.kind !== 'active' || !this.turnRunState.turnId) {
        this.markUnknown();
      }
      const flags = Array.isArray(status.activeFlags) ? status.activeFlags.map(String) : [];
      if (flags.includes('waitingOnApproval') && this.pendingApprovals.size === 0
        && !this.activeWaitingPlaceholders.has('approval')) {
        const requestId = this.nextWaitingRequestId('approval');
        this.activeWaitingPlaceholders.set('approval', requestId);
        this.emit({
          type: 'permission-request',
          requestId,
          title: 'Codex is waiting for approval',
          detail: 'Codex reports a pending approval, but the original app-server request was not replayed. Answer in the terminal, or wait for a fresh request.',
          readOnly: true,
        });
      } else if (!flags.includes('waitingOnApproval')) {
        // A synthetic card exists only while the native waiting flag does.
        // Do not settle native pending requests here: an unrelated/stale
        // active-status update is weaker evidence than serverRequest/resolved
        // or a terminal turn state.
        this.clearWaitingPlaceholders('approval');
      }
      if (flags.includes('waitingOnUserInput') && this.pendingQuestions.size === 0
        && !this.activeWaitingPlaceholders.has('question')) {
        const requestId = this.nextWaitingRequestId('question');
        this.activeWaitingPlaceholders.set('question', requestId);
        this.emit({
          type: 'question-request',
          requestId,
          readOnly: true,
          questions: [
            {
              header: 'Codex is waiting for input',
              question: 'Codex reports a pending user-input request, but the original app-server request was not replayed.',
              options: [],
            },
          ],
        });
      } else if (!flags.includes('waitingOnUserInput')) {
        this.clearWaitingPlaceholders('question');
      }
      if (!exactTurnAlreadyActive) this.emit({ type: 'status', status: 'running' });
      if (this.turnRunState.kind !== 'active' || !this.turnRunState.turnId) {
        void this.reconcileActiveTurnFromNative().catch(() => {});
      }
    } else if (status?.type === 'idle' || status?.type === 'notLoaded') {
      // Thread-level idle/notLoaded is weaker than an admitted exact turn. It can be replayed,
      // reordered around reconnect, or describe loader state; only that turn's completion,
      // failure, or interruption may retire the exact owner.
      if (this.turnRunState.kind === 'active') return;
      this.settleExternallyResolved('approval');
      this.settleExternallyResolved('question');
      const idleChanged = this.turnRunState.kind !== 'idle';
      this.markIdle();
      if (idleChanged) this.emit({ type: 'status', status: 'idle' });
    } else if (status?.type === 'systemError') {
      const activeTurnId = this.activeTurnId();
      if (activeTurnId) {
        const reportedTurnId = params?.turnId ?? params?.turn?.id ?? status?.turnId ?? status?.turn?.id;
        // Some app-server revisions include the affected turn on the thread-level error. When they
        // do, retain the exact-turn fence: a delayed failure for a retired turn cannot stop its
        // successor. An unscoped systemError still applies to the currently active thread turn.
        if (typeof reportedTurnId === 'string' && reportedTurnId && reportedTurnId !== activeTurnId) return;
        const completedAt = timestampToMs(params?.timestamp ?? status?.timestamp ?? status?.at) ?? Date.now();
        const evidence = {
          ...params,
          turn: {
            id: activeTurnId,
            status: 'failed',
            error: { message: 'Codex reported a system error for this thread.' },
            completedAt,
          },
        };
        this.rememberCompletedTurn(activeTurnId, evidence);
        this.markIdle();
        this.emitCompletedTurnEvidence(activeTurnId, true, true);
        return;
      }
      this.settleExternallyResolved('approval');
      this.settleExternallyResolved('question');
      const idleChanged = this.turnRunState.kind !== 'idle';
      this.markIdle();
      this.emit({ type: 'error', message: 'Codex reported a system error for this thread.' });
      if (idleChanged) this.emit({ type: 'status', status: 'idle' });
    }
  }

  private clearWaitingPlaceholders(kind: 'approval' | 'question'): void {
    // Exactly-once: a resolution exists only for a placeholder that was actually
    // emitted. Settling paths (turn completion, idle, system error, a real
    // request arriving) call this unconditionally; without the guard every
    // ordinary turn manufactured an orphan resolution card (CR2).
    const requestId = this.activeWaitingPlaceholders.get(kind);
    if (!requestId) return;
    this.activeWaitingPlaceholders.delete(kind);
    this.emit(kind === 'approval' ? { type: 'permission-resolved', requestId, decision: 'external' } : { type: 'question-resolved', requestId });
  }

  private nextWaitingRequestId(kind: 'approval' | 'question'): string {
    this.waitingPlaceholderSequence += 1;
    return codexWaitingRequestId(
      this.threadId,
      kind,
      `${this.waitingPlaceholderEpoch}-${this.waitingPlaceholderSequence}`,
    );
  }

  /** Another client of the shared daemon (e.g. a synced `codex resume --remote` terminal) answered a
   *  server→client request. The daemon broadcasts only that the request is settled — not the decision —
   *  so resolve our card as 'external' instead of leaving it stuck on "needs input" forever. */
  private handleServerRequestResolved(params: any): void {
    if (params?.threadId && String(params.threadId) !== this.threadId) return;
    const requestId = params?.requestId;
    if (requestId === undefined || requestId === null) return;
    for (const [id, pending] of this.pendingApprovals) {
      if (String(pending.rpcId) !== String(requestId)) continue;
      this.pendingApprovals.delete(id);
      this.emit({ type: 'permission-resolved', requestId: id, decision: 'external' });
      return;
    }
    for (const [id, pending] of this.pendingQuestions) {
      if (String(pending.rpcId) !== String(requestId)) continue;
      this.pendingQuestions.delete(id);
      this.emit({ type: 'question-resolved', requestId: id });
      return;
    }
  }

  /** Thread settings changed (our restore, an app pick riding turn/start, or a synced terminal's
   *  update) — mirror the authoritative approval/reviewer/sandbox state into currentMode so every client
   *  shows the mode codex will actually use. */
  private handleThreadSettingsUpdated(params: any): void {
    if (params?.threadId && String(params.threadId) !== this.threadId) return;
    const settings = params?.threadSettings;
    if (!settings || typeof settings !== 'object') return;
    this.baselineSandboxPolicy = safeCodexSandboxPolicy(settings.sandboxPolicy, this.cwd);
    const mode = codexModeFromSettings(settings.approvalPolicy, settings.approvalsReviewer, settings.sandboxPolicy);
    if (mode !== this.info.currentMode) {
      this.info.currentMode = mode;
      this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { currentMode: mode } });
    }
  }

  /** A turn ended (or codex reports it is no longer waiting) while we still hold pending request
   *  cards: they were answered in another client or died with the turn. Without this they stay
   *  "needs input" forever AND replay to every late-joining app client via getPending(). */
  private settleExternallyResolved(kind: 'approval' | 'question'): void {
    this.clearWaitingPlaceholders(kind);
    const map = kind === 'approval' ? this.pendingApprovals : this.pendingQuestions;
    if (!map.size) return;
    for (const id of [...map.keys()]) {
      map.delete(id);
      this.emit(kind === 'approval' ? { type: 'permission-resolved', requestId: id, decision: 'external' } : { type: 'question-resolved', requestId: id });
    }
  }

  private handleGoalUpdated(params: any): void {
    if (params?.threadId && String(params.threadId) !== this.threadId) return;
    const msg = codexGoalMessage(params?.goal);
    if (msg) this.emit(msg);
  }

  private handleGoalCleared(params: any): void {
    if (params?.threadId && String(params.threadId) !== this.threadId) return;
    this.emit({ type: 'goal-state', key: this.threadId, status: 'cleared' });
  }

  private async applyResumedThreadState(resumed: any): Promise<void> {
    const statusType = String(resumed?.thread?.status?.type ?? '').trim();
    const candidateTurns = [
      ...(Array.isArray(resumed?.initialTurnsPage?.data) ? resumed.initialTurnsPage.data : []),
      ...(Array.isArray(resumed?.thread?.turns) ? resumed.thread.turns : []),
    ];
    if (statusType === 'idle') {
      if (this.turnRunState.kind === 'active') {
        this.info.status = 'working';
        return;
      }
      this.markIdle();
      return;
    }
    if (statusType === 'active') {
      const activeTurnId = this.pickNewestInProgressTurnId(candidateTurns);
      if (activeTurnId) {
        this.markRunning(activeTurnId);
        return;
      }
      if (this.turnRunState.kind === 'active') {
        this.info.status = 'working';
        return;
      }
      this.markUnknown();
      await this.reconcileActiveTurnFromNative();
      this.info.status = this.activeTurnId() ? 'working' : 'idle';
      return;
    }
    if (!statusType) {
      const activeTurnId = this.pickNewestInProgressTurnId(candidateTurns);
      if (activeTurnId) {
        this.markRunning(activeTurnId);
      } else if (this.turnRunState.kind === 'active') {
        this.info.status = 'working';
      } else {
        this.markIdle();
      }
      return;
    }
    if (this.turnRunState.kind === 'active') {
      this.info.status = 'working';
      return;
    }
    this.markUnknown();
  }

  private pickNewestInProgressTurnId(turns: any[]): string | undefined {
    let best: { id: string; startedAt: number } | undefined;
    for (const turn of turns) {
      const status = String(turn?.status ?? '').toLowerCase();
      if (!status.includes('progress') && status !== 'running' && status !== 'active') continue;
      const id = turn?.id ? String(turn.id) : '';
      if (!id) continue;
      const startedAt = timestampToMs(turn.startedAt ?? turn.started_at ?? turn.createdAt ?? turn.created_at) ?? 0;
      if (!best || startedAt >= best.startedAt) best = { id, startedAt };
    }
    return best?.id;
  }

  private async flushBootstrapQueue(): Promise<void> {
    const queued = [...this.bootstrapQueue];
    this.bootstrapQueue = [];
    for (const item of queued) {
      if (item.rpcId === undefined) {
        this.handleNotification(item.method, item.params);
      } else {
        this.handleServerRequest(item.method, item.rpcId, item.params);
      }
    }
  }

  private isThreadScopedMessage(method: string): boolean {
    return [
      'turn/started',
      'turn/completed',
      'serverRequest/resolved',
      'thread/settings/updated',
      'thread/status/changed',
      'thread/goal/updated',
      'thread/goal/cleared',
      'thread/tokenUsage/updated',
      'thread/compacted',
      'turn/plan/updated',
      'item/started',
      'item/completed',
      'item/agentMessage/delta',
      'item/reasoning/textDelta',
      'item/reasoning/summaryTextDelta',
      'error',
      'item/tool/requestUserInput',
      'item/fileChange/requestApproval',
      'item/fileChange/response',
      'item/commandExecution/requestApproval',
      'item/commandExecution/response',
      'item/permissions/requestApproval',
      'item/tool/call',
      'mcpServer/elicitation/request',
      'mcpServer/elicitation/response',
      'item/permissions/requestInput',
      'execCommandApproval',
      'applyPatchApproval',
    ].includes(method);
  }

  private markRunning(turnId: string | undefined): void {
    this.turnRunStateVersion += 1;
    this.turnStartPending = false;
    if (typeof turnId === 'string' && turnId) this.turnRunState = { kind: 'active', turnId };
    else this.turnRunState = { kind: 'unknown' };
    if (this.turnRunState.kind === 'active') this.info.status = 'working';
    this.resolveTurnWaiters(this.activeTurnId());
  }

  private markIdle(): void {
    this.turnRunStateVersion += 1;
    this.turnStartPending = false;
    this.turnRunState = { kind: 'idle' };
    this.info.status = 'idle';
    this.resolveTurnWaiters(undefined);
  }

  private markUnknown(): void {
    this.turnRunStateVersion += 1;
    this.turnStartPending = false;
    this.turnRunState = { kind: 'unknown' };
    this.resolveTurnWaiters(undefined);
  }

  private activeTurnId(): string | undefined {
    return this.turnRunState.kind === 'active' ? this.turnRunState.turnId : undefined;
  }

  private isHydratingOrUnknown(): boolean {
    return this.turnRunState.kind === 'hydrating' || this.turnRunState.kind === 'unknown';
  }

  private resolveTurnWaiters(turnId: string | undefined): void {
    const waiters = [...this.turnWaiters];
    this.turnWaiters.clear();
    for (const waiter of waiters) waiter(turnId);
  }

  private waitForActiveTurnId(timeoutMs: number, waitForStart = false): Promise<string | undefined> {
    const activeTurnId = this.activeTurnId();
    if (activeTurnId) return Promise.resolve(activeTurnId);
    if (!waitForStart && !this.turnStartPending && !this.isHydratingOrUnknown()) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let settled = false;
      const waiter = (turnId: string | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.turnWaiters.delete(waiter);
        resolve(turnId ?? this.activeTurnId());
      };
      const timer = setTimeout(() => waiter(this.activeTurnId()), timeoutMs);
      this.turnWaiters.add(waiter);
    });
  }

  private handleItemStarted(item: any, turnId: string): void {
    if (!item?.type) return;
    if (item.type === 'userMessage') {
      const text = userInputText(item.content);
      const clientKey = item.clientId ? this.appSendClientKeys.get(String(item.clientId)) : undefined;
      if (text) this.emit({
        type: 'user-message',
        text,
        imageCount: imageInputCount(item.content),
        // CR4b: the same `(turnId, ordinal)` identity the rollout rebuilds, not the invented
        // `clientId`. `clientKey` still correlates the optimistic bubble by exact send token — that
        // is echo correlation, not identity, and it is never derived from text.
        key: this.liveUserMessageKey(turnId, item),
        turnId,
        sentAt: timestampToMs(item.createdAt ?? item.created_at ?? item.timestamp ?? item.startedAt ?? item.started_at),
        ...(clientKey ? { clientKey } : {}),
      });
      return;
    }
    const call = codexToolCallFromItem(item, turnId);
    if (call) this.emit(call);
  }

  /** Canonical key for one live userMessage item, stable across re-delivery. */
  private liveUserMessageKey(turnId: string, item: any): string {
    const itemId = String(item?.clientId ?? item?.id ?? '');
    const entry = this.liveTurnUserKeys.get(turnId);
    if (entry) {
      const known = itemId ? entry.recent.get(itemId) : undefined;
      if (known !== undefined) return known;
      const key = codexUserMessageKey(turnId, entry.count);
      entry.count += 1;
      // A generation that has not claimed an opener yet takes this prompt as its own, so a reused
      // turn id's footer names the prompt of the generation it actually belongs to.
      if (entry.opening === undefined) entry.opening = key;
      if (itemId) rememberRecentLiveItem(entry.recent, itemId, key);
      return key;
    }
    const key = codexUserMessageKey(turnId, 0);
    const recent = new Map<string, string>();
    if (itemId) recent.set(itemId, key);
    this.liveTurnUserKeys.set(turnId, { opening: key, count: 1, recent });
    while (this.liveTurnUserKeys.size > CODEX_TURN_USER_KEY_LIMIT) {
      const oldest = this.liveTurnUserKeys.keys().next().value;
      if (oldest === undefined) break;
      this.liveTurnUserKeys.delete(oldest);
    }
    return key;
  }

  /** Remembers the newest assistant text key for a turn, for the terminal footer. */
  private noteLiveAssistantKey(turnId: string, key: string): void {
    this.liveTurnAssistantKeys.set(turnId, key);
    while (this.liveTurnAssistantKeys.size > CODEX_TURN_USER_KEY_LIMIT) {
      const oldest = this.liveTurnAssistantKeys.keys().next().value;
      if (oldest === undefined) break;
      this.liveTurnAssistantKeys.delete(oldest);
    }
  }

  private emitNativeRunSummary(params: any, status: RunStatus): void {
    const base = codexNativeRunSummary(params, status);
    if (!base) return;
    // CR4b: the live terminal boundary must name the prompt and answer THIS socket rendered, so the
    // open turn grows its `Ran for … · Finished at …` footer on the first terminal frame instead of
    // waiting for authoritative history to be rebuilt on refresh. Both keys are the connection's own
    // emissions — never guessed, never text-matched — so an unknown turn stays unowned.
    const summary: RunSummaryMessage = {
      ...base,
      key: codexRunKey(base.turnId, this.liveRunGeneration.get(base.turnId)),
      ...(base.userMessageKey === undefined
        ? { userMessageKey: this.liveTurnUserKeys.get(base.turnId)?.opening }
        : {}),
      ...(base.assistantMessageKey === undefined
        ? { assistantMessageKey: this.liveTurnAssistantKeys.get(base.turnId) }
        : {}),
    };
    this.emit(summary);
    const totals = this.liveRuntimeTotalsFromSummary(summary);
    if (totals) this.emit(totals);
  }

  private liveRuntimeTotalsFromSummary(summary: RunSummaryMessage): AgentMessage | null {
    if (summary.status === 'running' || typeof summary.totalRuntimeMs !== 'number') return null;
    if (this.countedLiveRuntimeTurns.has(summary.turnId)) return null;
    this.countedLiveRuntimeTurns.add(summary.turnId);
    this.liveRuntimeTotalMs += summary.totalRuntimeMs;
    this.liveRuntimeTurnCount += 1;
    if (typeof summary.completedAt === 'number') this.liveRuntimeUpdatedAt = summary.completedAt;
    const value: Record<string, unknown> = {
      totalRuntimeMs: this.liveRuntimeTotalMs,
      turnCount: this.liveRuntimeTurnCount,
      source: 'codex-app-server-live-only',
    };
    if (typeof this.liveRuntimeUpdatedAt === 'number') value.updatedAt = this.liveRuntimeUpdatedAt;
    return { type: 'metadata-update', key: 'runtimeTotals', value };
  }

  private handleItemCompleted(item: any, turnId: string): void {
    if (!item?.type) return;
    if (item.type === 'agentMessage') {
      if (item.text) {
        const key = codexItemTextKey(turnId, String(item.id ?? 'unknown'), 't');
        this.noteLiveAssistantKey(turnId, key);
        this.emit({ type: 'model-output', text: String(item.text), final: true, key });
      }
      return;
    }
    if (item.type === 'reasoning') {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].filter(Boolean).join('\n').trim();
      if (text) this.emit({ type: 'thinking', text, key: codexItemTextKey(turnId, String(item.id ?? 'unknown'), 'r') });
      return;
    }
    const result = codexToolResultFromItem(item);
    if (result) this.emit(result);
  }

  private handleServerRequest(method: string, rpcId: number | string, params: any): void {
    if (method === 'item/tool/requestUserInput') {
      const requestId = `codex:q:${rpcId}:${params?.itemId ?? ''}`;
      this.pendingQuestions.set(requestId, { rpcId, method, params });
      this.clearWaitingPlaceholders('question');
      this.emit(codexQuestionMessage(method, requestId, params));
      return;
    }

    if (method === 'mcpServer/elicitation/request') {
      const requestId = `codex:q:${rpcId}:${params?.serverName ?? 'mcp'}`;
      this.pendingQuestions.set(requestId, { rpcId, method, params });
      this.clearWaitingPlaceholders('question');
      this.emit(codexQuestionMessage(method, requestId, params));
      return;
    }

    if (isApprovalMethod(method)) {
      const requestId = `codex:p:${rpcId}:${params?.approvalId ?? params?.itemId ?? params?.callId ?? ''}`;
      this.pendingApprovals.set(requestId, { rpcId, method, params });
      this.clearWaitingPlaceholders('approval');
      this.emit(approvalMessage(method, requestId, params));
      return;
    }

    // Avoid hanging Codex on server-initiated requests this adapter does not yet implement.
    this.write({ id: rpcId, error: { code: -32601, message: `unsupported server request: ${method}` } });
    this.emit({ type: 'event', name: 'codex-server-request-skipped', payload: { method } });
  }

  async getHistory(): Promise<AgentMessage[]> {
    const segs = await readRolloutSegmentsSettled(this.path);
    const out = mapRollout(segs.map(parseLineOrNull), this.published);
    const goal = await this.currentGoalMessage();
    if (goal) out.push(goal);
    return out;
  }

  /** Current app-server state is bounded and deliberately outside rollout cursors. */
  async getHistoryOverlays(): Promise<AgentMessage[]> {
    const goal = await this.currentGoalMessage();
    return goal ? [goal] : [];
  }

  /** H1b: messages and identity from ONE captured rollout prefix.
   *
   *  The live goal state is deliberately absent: it is current session state, not part of any
   *  rollout prefix, and the broker's cursor index is built from durable messages only.
   *
   *  Asynchronous for the same reason as the observe connection's: the scan yields between chunks
   *  so a large source never blocks the broker (H1c round 3). */
  captureHistorySnapshot(
    sink: HistorySnapshotSink,
  ): Promise<HistorySnapshotCapture | HistorySnapshotRefusal | undefined> {
    return captureFileHistoryInto(this.path, sink, this.published);
  }

  getHistorySourceIdentity(): HistorySourceIdentity | undefined {
    return fileHistorySourceIdentity(this.path);
  }

  private async currentGoalMessage(): Promise<AgentMessage | null> {
    try {
      const resp: any = await this.rpc('thread/goal/get', { threadId: this.threadId }, 5000);
      return codexGoalMessage(resp?.goal);
    } catch {
      return null;
    }
  }

  getPending(): AgentMessage[] {
    return [
      ...[...this.pendingApprovals].map(([requestId, pending]) => approvalMessage(pending.method, requestId, pending.params)),
      ...[...this.pendingQuestions].map(([requestId, pending]) => codexQuestionMessage(pending.method, requestId, pending.params)),
      ...(this.activeWaitingPlaceholders.has('approval') ? [{
        type: 'permission-request' as const,
        requestId: this.activeWaitingPlaceholders.get('approval')!,
        title: 'Codex is waiting for approval',
        detail: 'Codex reports a pending approval, but the original app-server request was not replayed. Answer in the terminal, or wait for a fresh request.',
        readOnly: true,
      }] : []),
      ...(this.activeWaitingPlaceholders.has('question') ? [{
        type: 'question-request' as const,
        requestId: this.activeWaitingPlaceholders.get('question')!,
        readOnly: true,
        questions: [{
          header: 'Codex is waiting for input',
          question: 'Codex reports a pending user-input request, but the original app-server request was not replayed.',
          options: [],
        }],
      }] : []),
    ];
  }

  async sendPrompt(input: PromptInput): Promise<void> {
    let text = input.text;
    if (input.files?.length) {
      const refs = input.files.map((f) => {
        const abs = this.writeInboxFile(f);
        return `- ${f.name} (${f.mimeType}) -> \`${abs}\``;
      });
      const note = `Attached file(s) - read them from these paths:\n${refs.join('\n')}`;
      text = text.trim() ? `${text}\n\n${note}` : note;
    }
    const content: any[] = [];
    if (text.trim()) content.push({ type: 'text', text, text_elements: [] });
    for (const img of input.images ?? []) content.push({ type: 'image', url: `data:${img.mimeType};base64,${img.data}` });
    if (!content.length) return;

    await this.enqueueContent(content, input.model, input.permissionMode, input.clientMessageId);
  }

  private enqueueContent(content: any[], model?: PromptInput['model'], permissionMode?: string, clientMessageId?: string): Promise<void> {
    this.pendingPromptStarts += 1;
    const run = this.promptChain
      .catch(() => undefined)
      .then(() => this.submitContent(content, model, permissionMode, clientMessageId))
      .finally(() => {
        this.pendingPromptStarts = Math.max(0, this.pendingPromptStarts - 1);
      });
    this.promptChain = run.catch(() => undefined);
    return run;
  }

  private async submitContent(content: any[], model?: PromptInput['model'], permissionMode?: string, clientMessageId?: string): Promise<void> {
    if (!content.length) return;
    const clientUserMessageId = `cosyncing-${Date.now()}-${++this.userSeq}`;
    if (clientMessageId) {
      this.appSendClientKeys.set(clientUserMessageId, clientMessageId);
      while (this.appSendClientKeys.size > 64) {
        this.appSendClientKeys.delete(this.appSendClientKeys.keys().next().value!);
      }
    }
    if (model?.modelID) {
      // Route through the shared updater so the change is BROADCAST (metadata-update → session
      // frame), not just recorded locally: the attach-time frame carried the config-default model
      // in its sync hint, and a silent update left the app's sync dialog advertising `-m` for a
      // model this session never ran (maintainer copied `-m gpt-5.6-sol` off his spark session).
      this.updateCurrentModelFromNative({
        model: model.modelID,
        modelProvider: model.providerID,
        reasoningEffort: model.reasoningEffort,
      });
    }
    let activeTurnId = this.activeTurnId();
    if (this.turnStartPending || this.isHydratingOrUnknown()) {
      await this.waitForActiveTurnId(5000, true);
      activeTurnId = this.activeTurnId();
    }
    if (this.isHydratingOrUnknown() && !activeTurnId) {
      throw new Error('Codex is recovering thread state; retry this prompt after a moment.');
    }
    if (activeTurnId) {
      await this.submitTurnSteerWithRecovery(activeTurnId, clientUserMessageId, content, model, permissionMode);
    } else {
      await this.submitTurnStart(content, clientUserMessageId, model, permissionMode);
    }
  }

  async sendFile(file: FileInput): Promise<void> {
    await this.sendPrompt({ text: '', files: [file] });
  }

  private writeInboxFile(file: FileInput): string {
    if (!this.cwd) throw new Error('Codex attachment delivery requires a workspace.');
    const inbox = resolve(this.cwd, PRODUCT_IDENTITY.repositoryDirectoryName, 'inbox');
    if (file.brokerPath) {
      const brokerPath = resolve(file.brokerPath);
      if (dirname(brokerPath) !== inbox || !existsSync(brokerPath)) {
        throw new Error('Codex rejected an untrusted broker attachment path.');
      }
      return brokerPath;
    }
    if (typeof file.data !== 'string') {
      throw new Error('Codex attachment bytes are missing.');
    }
    try {
      mkdirSync(inbox, { recursive: true });
      const base = sanitizeFileName(file.name);
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
      throw new Error(`Codex could not materialize attachment ${file.name}: ${String(error)}`);
    }
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    this.pendingApprovals.delete(requestId);
    if (!pending) return;
    this.write({ id: pending.rpcId, result: approvalResponse(pending.method, pending.params, decision) });
    this.emit({ type: 'permission-resolved', requestId, decision });
  }

  async answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    const pending = this.pendingQuestions.get(requestId);
    this.pendingQuestions.delete(requestId);
    if (!pending) return;
    if (pending.method === 'mcpServer/elicitation/request') {
      this.write({ id: pending.rpcId, result: mcpElicitationResponse(pending.params, answers) });
      this.emit({ type: 'question-resolved', requestId });
      return;
    }
    const out: Record<string, { answers: string[] }> = {};
    const qs = pending.params?.questions ?? [];
    for (let i = 0; i < qs.length; i++) {
      const qid = qs[i]?.id ? String(qs[i].id) : String(i);
      out[qid] = { answers: answers?.[i] ?? [] };
    }
    this.write({ id: pending.rpcId, result: { answers: out } });
    this.emit({ type: 'question-resolved', requestId });
  }

  async rejectQuestion(requestId: string): Promise<void> {
    const pending = this.pendingQuestions.get(requestId);
    this.pendingQuestions.delete(requestId);
    if (!pending) return;
    const result = pending.method === 'mcpServer/elicitation/request'
      ? { action: 'decline', content: null, _meta: null }
      : { answers: {} };
    this.write({ id: pending.rpcId, result });
    this.emit({ type: 'question-resolved', requestId });
  }

  async listCommands(): Promise<SlashCommand[]> {
    const builtins: SlashCommand[] = [
      { name: 'stop', description: 'Stop the running turn', kind: 'action' },
      { name: 'compact', description: 'Compact / summarize the conversation', kind: 'action' },
      // Native goal lifecycle is an action command, not a prompt turn. Syntax and replay behavior:
      // docs/architecture/client-ui.md
      { name: 'goal', description: 'Set a goal, or use pause, resume, or clear', kind: 'action' },
    ];
    const skills = await this.refreshSkills();
    const used = new Set(builtins.map((c) => c.name));
    return [
      ...builtins,
      ...skills
        .filter((s) => !used.has(s.name))
        .map((s) => ({ name: s.name, description: s.description || `Use Codex skill ${s.name}`, kind: 'prompt' as const })),
    ];
  }

  async runCommand(name: string, args?: string, input?: CommandInput): Promise<CommandResult | void> {
    if (name === 'stop' || name === 'abort') {
      const isStarting = this.pendingPromptStarts > 0 || this.turnStartPending;
      let activeTurnId = this.activeTurnId();
      if (!activeTurnId && this.isHydratingOrUnknown()) {
        await this.reconcileActiveTurnFromNative(this.turnRunStateVersion).catch(() => {});
        activeTurnId = this.activeTurnId();
      }
      if (!activeTurnId && (isStarting || this.isHydratingOrUnknown())) {
        activeTurnId = await this.waitForActiveTurnId(5000, true);
      }
      if (!activeTurnId) {
        return {
          notice: this.isHydratingOrUnknown()
            ? 'Codex is still reconciling the turn; try Stop again.'
            : isStarting
            ? 'Codex is starting a turn but has not reported a turn id yet; try Stop again.'
            : 'No running turn to stop.',
        };
      }
      await this.rpc('turn/interrupt', { threadId: this.threadId, turnId: activeTurnId }, 10000);
      return { notice: 'Stopped the turn.' };
    }
    if (name === 'compact') {
      await this.rpc('thread/compact/start', { threadId: this.threadId }, 10000);
      return { notice: 'Compacting the conversation...' };
    }
    if (name === 'goal') {
      const goalArgs = args?.trim() ?? '';
      const subcommand = goalArgs.toLowerCase();
      if (!goalArgs) {
        const resp: any = await this.rpc('thread/goal/get', { threadId: this.threadId }, 5000);
        const goal = resp?.goal;
        return {
          notice: goal?.objective
            ? `Goal ${String(goal.status ?? 'active')}: ${compactText(goal.objective)}`
            : 'No goal is set. Use /goal <objective>, /goal pause, /goal resume, or /goal clear.',
        };
      }
      if (subcommand === 'clear') {
        await this.rpc('thread/goal/clear', { threadId: this.threadId }, 10000);
        return { notice: 'Goal cleared.' };
      }
      if (subcommand === 'pause' || subcommand === 'resume') {
        await this.rpc('thread/goal/set', {
          threadId: this.threadId,
          status: subcommand === 'pause' ? 'paused' : 'active',
        }, 10000);
        if (subcommand === 'pause') {
          // Codex `paused` only gates FUTURE auto-turns — the in-flight goal turn (and any subagents
          // it spawned) runs to completion (verified 2026-07-12, see adapters/03-codex.md). A user
          // pausing means "stop working", so the gate is closed first, then the running turn braked.
          const activeTurnId = await this.waitForActiveTurnId(3000, true);
          if (activeTurnId) {
            await this.rpc('turn/interrupt', { threadId: this.threadId, turnId: activeTurnId }, 10000).catch(() => {});
            return { notice: 'Goal paused; interrupted the running turn.' };
          }
          return { notice: 'Goal paused.' };
        }
        return { notice: 'Goal resumed — Codex continues working toward it autonomously.' };
      }
      const objective = /^set\s+/i.test(goalArgs) ? goalArgs.replace(/^set\s+/i, '').trim() : goalArgs;
      if (!objective) return { notice: 'Add an objective after /goal set.' };
      await this.rpc('thread/goal/set', { threadId: this.threadId, objective, status: 'active' }, 10000);
      return { notice: `Goal set: ${compactText(objective)}` };
    }
    const skill = this.skills.get(name) ?? (await this.refreshSkills(), this.skills.get(name));
    if (skill) {
      const content: any[] = [{ type: 'skill', name: skill.name, path: skill.path }];
      if (args?.trim()) content.push({ type: 'text', text: args.trim(), text_elements: [] });
      await this.enqueueContent(content, input?.model, input?.permissionMode);
    }
  }

  async listModels(): Promise<ModelOption[]> {
    try {
      const defaultProvider = await this.currentModelProvider();
      const response = await this.rpc(
        'model/list',
        { limit: CODEX_MAX_MODEL_OPTIONS, includeHidden: false },
        10000,
      );
      return codexModelOptions(response, defaultProvider);
    } catch {
      return [];
    }
  }

  async listModes(): Promise<ModeOption[]> {
    return CODEX_PERMISSION_MODES;
  }

  private async currentModelProvider(): Promise<string> {
    try {
      const resp = await this.rpc('config/read', { cwd: this.cwd, includeLayers: false }, 5000);
      return String(resp?.config?.model_provider ?? 'openai');
    } catch {
      return 'openai';
    }
  }

  private async refreshSkills(): Promise<{ name: string; path: string; description?: string }[]> {
    try {
      const resp = await this.rpc('skills/list', this.cwd ? { cwds: [this.cwd], forceReload: false } : { forceReload: false }, 10000);
      const out: { name: string; path: string; description?: string }[] = [];
      for (const entry of resp?.data ?? []) {
        for (const skill of entry?.skills ?? []) {
          if (!skill?.name || !skill?.path || skill.enabled === false) continue;
          const name = String(skill.name).trim();
          if (!name || /[\r\n]/.test(name)) continue;
          out.push({ name, path: String(skill.path), description: skill.shortDescription ?? skill.description });
        }
      }
      this.skills.clear();
      for (const s of out) this.skills.set(s.name, s);
      return out;
    } catch {
      return [...this.skills.values()];
    }
  }

  async close(): Promise<void> {
    if (this.closeFlight) return this.closeFlight;
    const closing = this.closeResources();
    this.closeFlight = closing;
    return closing;
  }

  private async closeResources(): Promise<void> {
    try {
      if (this.transport === 'stdio' && this.activeTurnId()) this.write({ id: ++this.reqId, method: 'turn/interrupt', params: { threadId: this.threadId, turnId: this.activeTurnId() } });
    } catch {
      /* ignore */
    }
    this.handlers.clear();
    this.pendingApprovals.clear();
    this.pendingQuestions.clear();
    this.activeWaitingPlaceholders.clear();
    this.skills.clear();
    this.published.clear(); // line indices only mean anything to the connection that published them
    this.bootstrapApplying = false;
    this.bootstrapQueue = [];
    this.pendingPromptStarts = 0;
    this.turnStartPending = false;
    this.markIdle();
    for (const p of this.pendingRpc.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Codex connection closed.'));
    }
    this.pendingRpc.clear();
    const proc = this.proc;
    if (proc) await this.stopSpawnedProcess(proc);
    this.proc = undefined;
    this.daemon?.close();
    this.daemon = undefined;
  }

  private async stopSpawnedProcess(proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>): Promise<void> {
    this.diagnostic({
      event: 'child-lifecycle',
      transport: this.transport,
      outcome: 'close-requested',
      pid: proc.pid,
      pendingRpcCount: this.pendingRpc.size,
    });
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
    let exit = await boundedProcessExit(proc, this.processStopTimeoutMs);
    if (!exit.exited) {
      try {
        proc.kill(9);
      } catch {
        /* already exited */
      }
      exit = await boundedProcessExit(proc, this.processStopTimeoutMs);
    }
    this.diagnostic({
      event: 'child-lifecycle',
      transport: this.transport,
      outcome: exit.exited ? `exited:${String(exit.code)}` : 'exit-timeout',
      pid: proc.pid,
      pendingRpcCount: this.pendingRpc.size,
    });
  }
}

// ── rollout mapping (exported for the headless test) ───────────────────────────

/** call_id → the tool name + the canonical rich-detail fields recovered from the matching
 *  function_call / patch_apply_end / exec_command_end lines. */
export interface CodexEnrich {
  name?: string;
  path?: string;
  diff?: string;
  fileChanges?: FileChange[];
  additions?: number;
  deletions?: number;
  exitCode?: number;
  truncated?: boolean;
  title?: string;
  durationMs?: number;
  /** spawn_agent: the child's role (`agent_type`), recovered from the call so the matching
   *  function_call_output (which carries only agent_id + nickname) can label its activity bar. */
  agentType?: string;
  /** Exact command line, recovered from `exec_command_begin` or the call arguments. */
  command?: string;
  /** Working directory the command ran in, when the native event records one. */
  cwd?: string;
  /** Separated native streams; Codex only publishes them on newer exec events. */
  stdout?: string;
  stderr?: string;
  /** Native lifecycle from `exec_command_end`, when it publishes one. */
  aborted?: boolean;
}

/** Codex records an exec command as an argv array or a plain string. */
function codexCommandLine(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter((part): part is string => typeof part === 'string');
  const line = parts.join(' ').trim();
  return line || undefined;
}

/** The exec call's argv/cwd, wherever this Codex build records it. */
function codexExecArgs(args: unknown): { command?: string; cwd?: string } {
  if (!args || typeof args !== 'object') return {};
  const record = args as Record<string, unknown>;
  const command = codexCommandLine(record.command ?? record.cmd ?? record.argv);
  const cwd = record.cwd ?? record.workdir ?? record.working_directory;
  return {
    ...(command ? { command } : {}),
    ...(typeof cwd === 'string' && cwd ? { cwd } : {}),
  };
}

/** Turns Codex exit/abort evidence into the canonical lifecycle. */
function codexCommandState(e: CodexEnrich, hasResult: boolean): ToolCommandState {
  if (e.aborted === true) return 'interrupted';
  if (!hasResult) return 'running';
  if (e.exitCode === undefined) return 'unknown';
  return e.exitCode === 0 ? 'completed' : 'failed';
}

/** The command semantic for one enriched Codex tool, or undefined for a non-command tool. */
function codexCommandSemantic(e: CodexEnrich, hasResult: boolean): ToolSemantic | undefined {
  if (!e.command) return undefined;
  return boundToolSemantic(commandSemantic({
    command: e.command,
    cwd: e.cwd,
    state: codexCommandState(e, hasResult),
    stdout: boundedStream(e.stdout),
    stderr: boundedStream(e.stderr),
  }));
}

/**
 * The one place Codex decides which normalized family a tool belongs to.
 *
 * Both Codex surfaces (rollout replay and the app-server item stream) route
 * through here, so a family is classified once and every bound is applied once.
 * Native names are read HERE and nowhere downstream — the emitted message
 * carries only the canonical family.
 */
function codexCallSemantic(
  toolName: string,
  e: CodexEnrich | undefined,
  args: unknown,
  result?: { hasResult: boolean; output?: string },
): ToolSemantic | undefined {
  const enrich: CodexEnrich = { ...(e ?? {}) };
  if (!enrich.command) {
    const exec = codexExecArgs(args);
    if (exec.command) enrich.command = exec.command;
    if (exec.cwd && !enrich.cwd) enrich.cwd = exec.cwd;
  }
  const command = codexCommandSemantic(enrich, result?.hasResult === true);
  if (command) return command;
  const name = String(toolName || '').toLowerCase();
  if (name === 'web_search' || name.endsWith('__web_search')) {
    const query = args && typeof args === 'object'
      ? (args as Record<string, unknown>).query
      : undefined;
    return boundToolSemantic(webSemantic({ query }));
  }
  return undefined;
}

/** App-server `commandExecution` item → the same canonical command family. */
function codexItemCommandSemantic(item: any, hasResult: boolean): ToolSemantic | undefined {
  const command = codexCommandLine(item?.command);
  if (!command) return undefined;
  const exitCode = typeof item?.exitCode === 'number' ? item.exitCode : undefined;
  const status = String(item?.status ?? '');
  const state: ToolCommandState = status === 'declined' || status === 'aborted'
    ? 'interrupted'
    : !hasResult || status === 'inProgress' || status === 'running'
      ? 'running'
      : status === 'failed'
        ? 'failed'
        : exitCode === undefined
          ? 'unknown'
          : exitCode === 0
            ? 'completed'
            : 'failed';
  return boundToolSemantic(commandSemantic({
    command,
    cwd: item?.cwd,
    state,
    stdout: boundedStream(item?.stdout),
    stderr: boundedStream(item?.stderr),
  }));
}

/** Fold one rollout line's tool detail into the enrichment map (call_id → CodexEnrich). */
/** Clips a retained identity string to the shared bound it will be presented under. */
function clipEnrichChars(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

export function accumulateEnrich(ln: any, m: Map<string, CodexEnrich>): void {
  const p = ln?.payload;
  if (!p || p.call_id == null) return; // only call-scoped lines enrich a tool-result
  const id = String(p.call_id);
  if (ln.type === 'response_item') {
    if (p.type === 'function_call') {
      const e = m.get(id) ?? {};
      if (p.name) e.name = String(p.name);
      // An exec tool's argv/cwd are the ONLY command evidence when a rollout has no
      // exec_command_begin (older builds, or an app-server-authored history).
      if (e.name && codexToolDisplayClass(e.name) === 'execute') {
        const exec = codexExecArgs(parseArgs(p.arguments));
        if (exec.command && !e.command) e.command = clipEnrichChars(exec.command, COMMAND_MAX_CHARS);
        if (exec.cwd && !e.cwd) e.cwd = clipEnrichChars(exec.cwd, PATH_MAX_CHARS);
      }
      // spawn_agent's role lives in the CALL arguments; the output carries only agent_id+nickname.
      if (p.name === 'spawn_agent') {
        const a = parseArgs(p.arguments);
        const role = a && typeof a === 'object' ? (a as any).agent_type : undefined;
        if (typeof role === 'string' && role) e.agentType = role;
      }
      m.set(id, e);
    } else if (p.type === 'custom_tool_call') {
      // apply_patch — the PRIMARY file-edit tool — is a CUSTOM tool call (not function_call); its patch
      // text is in `input`, and a session may have NO patch_apply_end event to fall back on, so recover
      // the path + diffstat from the patch body here (otherwise the edit renders as opaque text).
      const e = m.get(id) ?? {};
      e.name = String(p.name ?? 'tool');
      if (e.name === 'apply_patch' && typeof p.input === 'string') {
        const pp = parseApplyPatch(p.input);
        if (pp.fileChanges?.length) {
          e.fileChanges = pp.fileChanges;
          e.title = titleForChanges(pp.fileChanges);
        }
        if (pp.path) e.path = pp.path;
        if (pp.diff) {
          e.diff = pp.diff;
          const { additions, deletions } = summarizeDiff(pp.diff);
          e.additions = additions;
          e.deletions = deletions;
        }
      }
      m.set(id, e);
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const e = m.get(id) ?? {};
      const durationMs = codexToolOutputDurationMs(p.output);
      if (durationMs !== undefined) e.durationMs = durationMs;
      m.set(id, e);
    }
    return;
  }
  if (ln.type !== 'event_msg') return;
  if (p.type === 'exec_command_begin') {
    // The only place Codex records the exact argv and working directory.
    const e = m.get(id) ?? {};
    const command = codexCommandLine(p.command ?? p.cmd);
    if (command) e.command = clipEnrichChars(command, COMMAND_MAX_CHARS);
    if (typeof p.cwd === 'string' && p.cwd) e.cwd = clipEnrichChars(p.cwd, PATH_MAX_CHARS);
    m.set(id, e);
  } else if (p.type === 'exec_command_end') {
    const e = m.get(id) ?? {};
    if (typeof p.exit_code === 'number') e.exitCode = p.exit_code;
    // Newer exec events separate the streams; older ones only carry the merged
    // aggregate, which stays on the canonical `result` and is labeled combined.
    // Clipped to the shared stream bound AT INGEST, not at presentation: a
    // gigabyte of build output would otherwise sit in this map, uncounted by
    // enrichEntryBytes and unreachable by any presentation bound, for the whole
    // life of the connection.
    if (typeof p.stdout === 'string' && p.stdout) e.stdout = clipTailBytes(p.stdout, COMMAND_STREAM_MAX_BYTES);
    if (typeof p.stderr === 'string' && p.stderr) e.stderr = clipTailBytes(p.stderr, COMMAND_STREAM_MAX_BYTES);
    if (p.aborted === true || p.interrupted === true) e.aborted = true;
    const durationMs = nativeDurationMs(p);
    if (durationMs !== undefined) e.durationMs = durationMs;
    m.set(id, e);
  } else if (p.type === 'patch_apply_end') {
    const e = m.get(id) ?? {};
    const changes = p.changes && typeof p.changes === 'object' ? p.changes : {};
    // Fill only what the richer custom_tool_call/apply_patch path (parseApplyPatch) did not
    // already set, so its multi-file git-style diff is never clobbered by this result event.
    // Build EVERY changed file, not just the first (the old code summarized multi-file as one).
    const fileChanges: FileChange[] = [];
    const sections: string[] = [];
    for (const [path, raw] of Object.entries(changes)) {
      const ch = raw && typeof raw === 'object' ? (raw as any) : {};
      const op: ApplyPatchOp = ch.type === 'add' ? 'add' : ch.type === 'delete' ? 'delete' : 'update';
      // Codex change entries are {type, content, diff?}. Prefer a carried unified diff. Only an ADD
      // or DELETE has an honest all-lines body: an add's `content` is the whole new file (all `+`),
      // a delete's is the whole old file (all `-`). An UPDATE's `content` is the new file text, NOT a
      // diff — synthesizing `+content` there would render an edit as a brand-new file (T1b finding 4),
      // so with no carried diff we omit the update's body rather than fabricate one. Never reconstructed
      // from Git or the current file.
      let section = typeof ch.diff === 'string' && ch.diff ? ch.diff : typeof ch.unified_diff === 'string' && ch.unified_diff ? ch.unified_diff : '';
      if (!section && (op === 'add' || op === 'delete') && typeof ch.content === 'string' && ch.content) {
        const body = ch.content.split('\n').map((l: string) => `${op === 'delete' ? '-' : '+'}${l}`).join('\n');
        section =
          op === 'delete'
            ? `diff --git ${gitDiffPath('a', path)} ${gitDiffPath('b', path)}\ndeleted file\n--- ${gitDiffPath('a', path)}\n+++ /dev/null\n${body}`
            : `diff --git ${gitDiffPath('a', path)} ${gitDiffPath('b', path)}\nnew file\n--- /dev/null\n+++ ${gitDiffPath('b', path)}\n${body}`;
      } else if (!section) {
        section =
          op === 'delete'
            ? `diff --git ${gitDiffPath('a', path)} ${gitDiffPath('b', path)}\ndeleted file\n--- ${gitDiffPath('a', path)}\n+++ /dev/null`
            : op === 'add'
              ? `diff --git ${gitDiffPath('a', path)} ${gitDiffPath('b', path)}\nnew file\n--- /dev/null\n+++ ${gitDiffPath('b', path)}`
              : `diff --git ${gitDiffPath('a', path)} ${gitDiffPath('b', path)}`;
      }
      sections.push(section);
      const { additions, deletions } = summarizeDiff(section);
      fileChanges.push({
        path,
        operation: op === 'add' ? 'create' : op === 'delete' ? 'delete' : 'edit',
        diff: section,
        additions,
        deletions,
      });
    }
    if (fileChanges.length) {
      if (!e.fileChanges) e.fileChanges = fileChanges;
      if (!e.path) e.path = fileChanges[0]!.path;
      if (!e.title) e.title = titleForChanges(e.fileChanges);
      if (!e.diff) {
        e.diff = sections.join('\n');
        const { additions, deletions } = summarizeDiff(e.diff);
        e.additions = additions;
        e.deletions = deletions;
      }
    }
    if (p.success === false && e.exitCode == null) e.exitCode = 1; // surface a failed patch
    m.set(id, e);
  }
}

function nativeDurationMs(value: any): number | undefined {
  const direct = Number(value?.durationMs ?? value?.duration_ms ?? value?.elapsedMs ?? value?.elapsed_ms);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const duration = value?.duration;
  if (duration && typeof duration === 'object') {
    const seconds = Number(duration.secs ?? duration.seconds ?? 0);
    const nanos = Number(duration.nanos ?? duration.nanoseconds ?? 0);
    const ms = seconds * 1000 + nanos / 1_000_000;
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  const startedAt = timestampToMs(value?.startedAt ?? value?.started_at);
  const completedAt = timestampToMs(value?.completedAt ?? value?.completed_at ?? value?.finishedAt ?? value?.finished_at);
  return startedAt !== undefined && completedAt !== undefined && completedAt >= startedAt ? completedAt - startedAt : undefined;
}

function codexToolOutputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => codexToolOutputText(item)).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (record.output !== undefined) return codexToolOutputText(record.output);
  if (record.content !== undefined) return codexToolOutputText(record.content);
  return '';
}

/** New Codex exec tool outputs record `Wall time N seconds`; older rollouts use duration.secs/nanos. */
function codexToolOutputDurationMs(output: unknown): number | undefined {
  const native = nativeDurationMs(output);
  if (native !== undefined) return native;
  const text = codexToolOutputText(output);
  const wall = /\bwall[_ ]time(?:_seconds)?\b[\s:"=]+([0-9]+(?:\.[0-9]+)?)/i.exec(text);
  return wall?.[1] !== undefined ? Number(wall[1]) * 1000 : undefined;
}

/** Codex owns this native-name mapping; clients consume only the canonical semantic class. */
function codexToolDisplayClass(toolName: string): ToolDisplayClass {
  const name = String(toolName || '').toLowerCase();
  if (/^(exec|exec_command|shell|shell_command|write_stdin|wait)$/.test(name)) return 'execute';
  if (/(^|__|[_-])(edit|write|patch|create|delete|move|rename)([_-]|$)/.test(name)) return 'edit';
  if (
    /^(view_image|web_search|read_mcp_resource|list_mcp_resources|list_mcp_resource_templates)$/.test(name)
    || /(^|__|[_-])(read|grep|glob|search|fetch|list|query|snapshot|screenshot|console|network)([_-]|$)/.test(name)
    || /directory_tree/.test(name)
  ) return 'lookup';
  return 'other';
}

type RunStatus = 'running' | 'done' | 'error' | 'cancelled';
type RunSummaryMessage = Extract<AgentMessage, { type: 'run-summary' }>;

type ActiveRun = {
  turnId: string;
  key: string;
  startedAt?: number;
  userMessageKey?: string;
  assistantMessageKey?: string;
};

type SubagentState = { key: string; agentId: string; nickname: string; agentType?: string; spawnTs?: number };

type SubagentActivity = Extract<AgentMessage, { type: 'agent-activity' }>;

const AUTOMATIC_APPROVAL_DENIAL_THRESHOLD = 2;
const CODEX_INTERRUPTED_NOTICE = 'Conversation interrupted.';
const CODEX_REPEATED_AUTO_APPROVAL_INTERRUPTION_NOTICE =
  'Conversation interrupted because automatic permission approval was denied repeatedly.';

/** True only for Codex's automatic host-approval rejection, never an ordinary user refusal.
 *
 *  The affected rollout records the denial inside the parent turn's tool result. The separate
 *  approval-reviewer session has richer JSON, but correlating two session files would introduce
 *  lifecycle and identity ambiguity. These three signatures are all present in real automatic
 *  denials and deliberately exclude a plain "rejected by user" result. Scanning is bounded because
 *  a denial is a short control-plane result, not command output. */
function isAutomaticApprovalReviewDenial(
  toolName: string | undefined,
  output: unknown,
): boolean {
  if (
    toolName === undefined
    || codexToolDisplayClass(toolName) !== 'execute'
  ) {
    return false;
  }
  const text = (
    typeof output === 'string' ? output : codexToolOutputText(output)
  ).slice(0, 8192).toLowerCase();
  const denied = /\b(?:denied|rejected|forbids?|forbidden)\b/.test(text);
  const automaticReview =
    /automatic approval review|approval policy|unacceptable risk/.test(text);
  const hostExecution =
    /exec_command failed|createprocess|escalat(?:ed|ion)|host execution/.test(text);
  return denied && automaticReview && hostExecution;
}

/** One `spawn_agent`/`wait_agent` child rendered as the canonical subagent activity bar (the same
 *  type Claude's Task subagents use, so the app renders it identically — no per-tool app code). */
function subagentActivity(s: SubagentState, status: SubagentActivity['status'], elapsedMs?: number): SubagentActivity {
  return {
    type: 'agent-activity',
    key: s.key,
    kind: 'subagent',
    title: s.nickname,
    subtitle: s.agentType,
    status,
    elapsedMs,
    agentsTotal: 1,
    agentsDone: status === 'done' ? 1 : 0,
  };
}

/** Bounded per-turn user-message bookkeeping retained after a turn finishes. */
const CODEX_TURN_USER_KEY_LIMIT = 64;

/** Per-turn item ids kept for idempotent re-delivery of a live userMessage. */
const CODEX_TURN_RECENT_ITEM_LIMIT = 32;

/**
 * Per-turn prompt bookkeeping. One shape of comment covers both maps below.
 *
 * `count` is the turn id's ordinal sequence and is NEVER reset, including across a reused turn id.
 * That is what makes a second generation's prompts distinct from the first's — and, critically,
 * what makes the live connection and a rollout replay agree: the replay counts prompts per turn id
 * across the whole file, so a live path that restarted at zero would hand generation two the
 * generation-one `u0` and merge two prompts into one row.
 *
 * `opening` IS generation-scoped: it names the prompt a run summary may own, and generation two's
 * footer must not point at generation one's prompt. Clearing it to undefined lets the next prompt
 * recorded for the turn claim it.
 */
type TurnUserKeys = {
  /** The prompt that OPENED the current generation of the turn; undefined until one is recorded. */
  opening: string | undefined;
  /** Monotonic count of distinct prompts recorded for the turn id; the next ordinal. */
  count: number;
  /** The key most recently issued, so an immediate re-record is not a second prompt. */
  last: string | undefined;
};

/** Per-turn prompt bookkeeping for a live app-server connection. See {@link TurnUserKeys}. */
type LiveTurnUserKeys = {
  opening: string | undefined;
  count: number;
  /** Bounded recent `itemId → key` lookup, newest last, for idempotent re-delivery. */
  recent: Map<string, string>;
};

/**
 * Open a NEW generation of a turn id that already closed (R0c.4 round 3).
 *
 * Shared by the rollout replay and the live connection so the two cannot drift. Generation-scoped:
 * the opener a run summary may own, and the re-delivery memory — a repeated item id in a NEW
 * generation is a new prompt, not a redelivery of the old one, so answering with the previous
 * generation's key would merge two prompts. The ordinal counter survives, because it is what keeps
 * generation two's prompts distinct from generation one's AND identical between the two paths —
 * resetting it would give generation two the `u0` generation one already published and merge two
 * prompts into a single row, which is strictly worse than the footer bug it would fix.
 */
function beginCodexTurnGeneration(
  entry: { opening: string | undefined; last?: string | undefined; recent?: Map<string, string> } | undefined,
): void {
  if (!entry) return;
  entry.opening = undefined;
  if ('last' in entry) entry.last = undefined;
  entry.recent?.clear();
}

/** Record `itemId → key`, keeping at most {@link CODEX_TURN_RECENT_ITEM_LIMIT} newest entries. */
function rememberRecentLiveItem(recent: Map<string, string>, itemId: string, key: string): void {
  recent.delete(itemId);
  recent.set(itemId, key);
  while (recent.size > CODEX_TURN_RECENT_ITEM_LIMIT) {
    const oldest = recent.keys().next().value;
    if (oldest === undefined) break;
    recent.delete(oldest);
  }
}

class CodexRuntimeTracker {
  private readonly active = new Map<string, ActiveRun>();
  private readonly order: string[] = [];
  private lastUserMessageKey: string | undefined;
  private lastAssistantMessageKey: string | undefined;
  /** Legacy Codex writes an assistant event immediately before the response item for the same
   * text. Newer rollouts omit that event and retain only the response item. Remember only the last
   * real record's legacy text so the next response item is suppressed when it is the duplicate
   * half of a dual-emission pair, while a new-only response remains visible. */
  private pendingLegacyAssistantText: string | undefined;
  /** The user prompt most recently mapped from ONE of its two durable forms
   * (`event_msg/user_message` legacy, `item_completed`/`UserMessage` since 0.147), held only while
   * the OTHER form could still arrive as the IMMEDIATELY NEXT record. No local rollout carries
   * both forms (34 new-format + 927 legacy files, zero mixed), so this is purely forward
   * compatibility — and it is scoped exactly like the assistant pair above: the very next real
   * record consumes it, one way or the other. Never a session- or turn-wide text match, which
   * would merge two genuinely identical prompts. */
  private pendingUserDualEmission: { form: 'legacy' | 'item'; text: string; turnId: string | undefined } | undefined;
  /**
   * turnId → user messages seen inside it, oldest first.
   *
   * This replaces `lastUserMessageKey` as the run summary's ownership source. In a real rollout
   * `task_started` is written BEFORE the turn's own `event_msg/user_message`, so binding at
   * `start()` bound the PREVIOUS turn's prompt: measured on a real session, turn `019f8057…`
   * reported `userMessageKey=c13` while its actual prompt was line 142. Recording per turn and
   * reading the turn's FIRST entry has no ordering dependency at all.
   *
   * Bounded by {@link CODEX_TURN_USER_KEY_LIMIT} turns, oldest evicted first; a finished turn's
   * entry is retained only until that bound, because a late `task_complete` for an older turn is
   * the one consumer that still needs it. Each entry is O(1): only the OPENING key and a monotonic
   * count are ever read, so a turn with many steers does not grow the entry.
   */
  private readonly userKeysByTurn = new Map<string, TurnUserKeys>();
  /** Turn ids this read has seen CLOSE. A later opening record for one of them is a second
   *  generation of that id, not a duplicate start. Bounded with the same ceiling as the key map. */
  private readonly retiredTurnIds = new Set<string>();
  /** Generation ordinal per turn id that reopened after its own terminal; absent = generation one.
   *  Mirrors the live connection's map so both paths mint identical {@link codexRunKey}s. */
  private readonly runGeneration = new Map<string, number>();
  /** One prompt mapped before any turn was open, awaiting the turn that opens next. */
  private unclaimedUserKey: string | undefined;
  private totalRuntimeMs = 0;
  private turnCount = 0;
  private updatedAt: number | undefined;
  /** agent_id → live subagent state, so a later wait_agent output resolves it to done/error with elapsed. */
  private readonly subagents = new Map<string, SubagentState>();
  /** agent_ids already given a terminal frame — so a second wait_agent on the same child (Codex polls) does
   *  not re-emit a (misleadingly longer-elapsed) duplicate, and turn-end reaping skips already-resolved ones. */
  private readonly resolvedSubagents = new Set<string>();
  /** Turn currently OPEN, so assistant text — which carries no turn of its own — can be keyed by the
   *  same turn the app-server uses for it (see {@link mapLine}). Undefined between turns: a record
   *  landing outside any turn belongs to no turn, and keying it under the last COMPLETED one would
   *  invent an identity the app-server never delivered. */
  private activeTurnId: string | undefined;
  /** Bounded turn-local evidence for a reason-aware interruption marker. */
  private automaticApprovalDenials = 0;

  /** Apply one exact rollout transition. A stale, duplicate, or id-less terminal cannot retire the
   * current turn. The return value lets mapping suppress a second footer/status transition too. */
  noteTurnTransition(transition: RolloutTurnTransition | undefined): 'opened' | 'retired' | 'ignored' | undefined {
    if (!transition) return undefined;
    if (
      transition.opens
      && this.activeTurnId !== transition.turnId
    ) {
      this.automaticApprovalDenials = 0;
    }
    if (transition.opens) {
      // A turn id that ALREADY closed in this read and now opens again is a second generation of
      // that id. Evidence both paths can see: the rollout carries `task_started T … task_complete T
      // … task_started T` in byte order, and a live connection sees a start whose own timestamp
      // postdates the completion it recorded. Duplicate starts BEFORE a terminal are ordinary
      // (R0c.2) and are not this: only a start after the id's own terminal qualifies.
      if (transition.turnId !== undefined && this.retiredTurnIds.has(transition.turnId)) {
        this.retiredTurnIds.delete(transition.turnId);
        beginCodexTurnGeneration(this.userKeysByTurn.get(transition.turnId));
        // Same boundary the live connection fences: the new generation's canonical run identity
        // must be distinct, or the downstream type/key merge collapses its footer into the first's.
        this.runGeneration.set(transition.turnId, (this.runGeneration.get(transition.turnId) ?? 1) + 1);
      }
      this.activeTurnId = transition.turnId;
      return 'opened';
    }
    // Legacy/id-less rollouts have only the synthetic line-key authority. Allow their sole
    // synthetic turn to close, while an id-less terminal remains too weak to retire any exact
    // native turn.
    if (!transition.turnId) {
      if (!this.activeTurnId?.startsWith('line:')) return 'ignored';
      this.activeTurnId = undefined;
      return 'retired';
    }
    if (transition.turnId !== this.activeTurnId) return 'ignored';
    this.activeTurnId = undefined;
    this.retiredTurnIds.delete(transition.turnId);
    this.retiredTurnIds.add(transition.turnId);
    while (this.retiredTurnIds.size > CODEX_TURN_USER_KEY_LIMIT) {
      const oldest = this.retiredTurnIds.values().next().value;
      if (oldest === undefined) break;
      this.retiredTurnIds.delete(oldest);
    }
    return 'retired';
  }

  /** Adopt the turn and denial evidence left open by history before a live tail starts. */
  primeActiveTurn(
    turnId: string | undefined,
    automaticApprovalDenials = 0,
  ): void {
    this.activeTurnId = turnId;
    this.automaticApprovalDenials = turnId === undefined
      ? 0
      : Math.min(
          AUTOMATIC_APPROVAL_DENIAL_THRESHOLD,
          automaticApprovalDenials,
        );
  }

  get currentTurnId(): string | undefined {
    return this.activeTurnId;
  }

  /** Consume the possible dual-emission pair from the preceding real record.
   *
   * Calling this for every real record deliberately clears the candidate on any intervening
   * record. Blank/malformed slots never call the mapper, matching the rollout pair rules used for
   * identity adoption. */
  consumeLegacyAssistantPair(record: any): boolean {
    const pending = this.pendingLegacyAssistantText;
    this.pendingLegacyAssistantText = undefined;
    if (pending === undefined) return false;
    const payload = record?.payload;
    return record?.type === 'response_item'
      && payload?.type === 'message'
      && payload?.role === 'assistant'
      && responseItemText(payload) === pending;
  }

  expectLegacyAssistantPair(text: string): void {
    this.pendingLegacyAssistantText = text;
  }

  /** Consume the possible OTHER durable form of the user prompt just mapped.
   *
   * Called for every real record, like {@link consumeLegacyAssistantPair}, and consumed by
   * whatever arrives: only the DIRECTLY ADJACENT record can be the pair. A byte-equal
   * `response_item/message` `role: 'user'` disarms it too — that twin precedes its own durable
   * record in both formats, so seeing one after a durable form means a SECOND prompt's
   * representation is opening, and letting the pairing survive it is how two genuinely identical
   * prompts (one legacy, one new) collapsed into one row. Suppression also demands KNOWN, EQUAL
   * turn evidence on both sides — a pending or record whose turn is unknown never suppresses.
   * Same form twice is never a pair either. The residue of this narrowness is fail-safe: a future
   * dual format that interleaves anything between its two durable forms costs a duplicate row,
   * never a lost prompt. */
  consumeUserDualEmission(record: any): boolean {
    const pending = this.pendingUserDualEmission;
    if (pending === undefined) return false;
    this.pendingUserDualEmission = undefined;
    if (pending.turnId === undefined || record?.type !== 'event_msg') return false;
    const payload = record?.payload;
    if (pending.form === 'item' && payload?.type === 'user_message') {
      // The legacy record names no turn of its own, so the enclosing turn must be known AND be
      // the one the completed item declared — otherwise these are prompts of two different turns.
      return String(payload.message ?? '') === pending.text
        && pending.turnId === this.activeTurnId;
    }
    if (
      pending.form === 'legacy'
      && payload?.type === 'item_completed'
      && payload.item?.type === 'UserMessage'
    ) {
      const turnId = payload.turn_id != null ? String(payload.turn_id) : undefined;
      return turnId !== undefined
        && userInputText(payload.item.content) === pending.text
        && pending.turnId === turnId;
    }
    return false;
  }

  expectUserDualEmission(form: 'legacy' | 'item', text: string, turnId: string | undefined): void {
    this.pendingUserDualEmission = { form, text, turnId };
  }

  /** Records one automatic denial only while a turn is open. */
  recordAutomaticApprovalDenial(
    toolName: string | undefined,
    output: unknown,
  ): void {
    if (
      this.activeTurnId === undefined
      || !isAutomaticApprovalReviewDenial(toolName, output)
    ) {
      return;
    }
    this.automaticApprovalDenials = Math.min(
      AUTOMATIC_APPROVAL_DENIAL_THRESHOLD,
      this.automaticApprovalDenials + 1,
    );
  }

  /** Consumes whether this turn crossed the repeated-denial threshold. */
  consumeRepeatedAutomaticApprovalDenial(): boolean {
    const repeated =
      this.automaticApprovalDenials >= AUTOMATIC_APPROVAL_DENIAL_THRESHOLD;
    this.automaticApprovalDenials = 0;
    return repeated;
  }

  /** A normal terminal boundary must not leak denial evidence into the next turn. */
  clearInterruptionEvidence(): void {
    this.automaticApprovalDenials = 0;
  }

  /** A `spawn_agent` output resolved → the child is running. Idempotent on re-emit (same key upserts). */
  spawnSubagent(agentId: string, nickname: string, agentType: string | undefined, spawnTs?: number): AgentMessage {
    const existing = this.subagents.get(agentId);
    const s: SubagentState = existing
      ? { ...existing, nickname: nickname || existing.nickname, agentType: agentType ?? existing.agentType }
      : { key: `agent:${agentId}`, agentId, nickname, agentType, spawnTs };
    this.subagents.set(agentId, s);
    return subagentActivity(s, 'running');
  }

  /** A `wait_agent` output reported this child terminal → a done/error bar (first→last elapsed) AND the child's
   *  returned report as a `subagent` tool-result so its findings aren't lost (the agent-activity bar has no body
   *  field, and Codex folds the report only into the parent's own reasoning). Idempotent: only the FIRST
   *  resolution emits, so a polled re-wait doesn't duplicate the report or emit a longer, misleading elapsed. */
  resolveSubagent(agentId: string, status: 'done' | 'error', report: string | undefined, doneTs?: number): AgentMessage[] {
    if (this.resolvedSubagents.has(agentId)) return [];
    this.resolvedSubagents.add(agentId);
    const s = this.subagents.get(agentId) ?? { key: `agent:${agentId}`, agentId, nickname: agentId.slice(0, 8) };
    this.subagents.set(agentId, s);
    const elapsedMs = s.spawnTs != null && doneTs != null && doneTs >= s.spawnTs ? doneTs - s.spawnTs : undefined;
    const out: AgentMessage[] = [subagentActivity(s, status, elapsedMs)];
    if (report && report.trim()) {
      out.push({
        type: 'tool-result',
        callId: `subagent:${agentId}`, // synthetic — disjoint from real Codex `call_...` ids, so no card collision
        toolName: 'subagent',
        toolClass: 'other',
        title: s.agentType ? `${s.nickname} · ${s.agentType}` : s.nickname,
        result: report,
        isError: status === 'error',
      });
    }
    return out;
  }

  /** Turn end (task_complete / turn_aborted) → settle any subagent still showing 'running'. A `wait_agent` that
   *  times out returns an EMPTY status map ({status:{},timed_out:true}), so without this a never-joined child's
   *  bar would hang 'running' forever on an idle session. Verified safe: spawn↔wait never span turns (248/248). */
  reapSubagents(status: 'done' | 'error', ts?: number): AgentMessage[] {
    const out: AgentMessage[] = [];
    for (const [agentId, s] of this.subagents) {
      if (this.resolvedSubagents.has(agentId)) continue;
      this.resolvedSubagents.add(agentId);
      const elapsedMs = s.spawnTs != null && ts != null && ts >= s.spawnTs ? ts - s.spawnTs : undefined;
      out.push(subagentActivity(s, status, elapsedMs));
    }
    return out;
  }

  /** `turnId` defaults to the open turn; a record that declares its own exact turn (0.147
   *  `item_completed`) books there instead, so its footer ownership never depends on which turn
   *  this read happened to consider active. */
  recordUser(key: string, turnId: string | undefined = this.activeTurnId): void {
    this.lastUserMessageKey = key;
    if (!turnId) {
      // Some rollouts write the prompt BEFORE the turn opens. It belongs to the turn that opens
      // next, and to no other: holding exactly one unclaimed key is what keeps that attribution
      // from ever reaching across an already-open turn.
      this.unclaimedUserKey = key;
      return;
    }
    this.attachUserKey(turnId, key);
  }

  private attachUserKey(turnId: string, key: string): void {
    const entry = this.userKeysByTurn.get(turnId);
    if (entry) {
      // Re-recording the key just issued is the same prompt, not the next one. Ordinals are handed
      // out from `count`, so two records inside one turn can only repeat the key most recently
      // issued for it — which is exactly what this rejects.
      if (entry.last === key) return;
      // A generation that has not claimed an opener yet takes this prompt as its own.
      if (entry.opening === undefined) entry.opening = key;
      entry.last = key;
      entry.count += 1;
      return;
    }
    this.userKeysByTurn.set(turnId, { opening: key, count: 1, last: key });
    while (this.userKeysByTurn.size > CODEX_TURN_USER_KEY_LIMIT) {
      const oldest = this.userKeysByTurn.keys().next().value;
      if (oldest === undefined) break;
      this.userKeysByTurn.delete(oldest);
    }
  }

  /** Next user-message ordinal inside the currently open turn. */
  nextUserOrdinal(turnId: string): number {
    return this.userKeysByTurn.get(turnId)?.count ?? 0;
  }

  /** The prompt that OPENED [turnId], or undefined when this read never saw it. */
  private openingUserKey(turnId: string | undefined): string | undefined {
    if (turnId === undefined) return undefined;
    const known = this.userKeysByTurn.get(turnId)?.opening;
    if (known !== undefined) return known;
    const unclaimed = this.unclaimedUserKey;
    if (unclaimed === undefined) return undefined;
    // Claimed exactly once: a second turn cannot inherit the same prompt.
    this.unclaimedUserKey = undefined;
    this.attachUserKey(turnId, unclaimed);
    return unclaimed;
  }

  recordAssistant(key: string): void {
    this.lastAssistantMessageKey = key;
    const turnId = this.order.at(-1);
    if (turnId) {
      const run = this.active.get(turnId);
      if (run) run.assistantMessageKey = key;
    }
  }

  start(turnId: string, startedAt?: number): AgentMessage {
    // Legacy task_started records lack a native id, so rolloutTurnTransition cannot open them.
    // Their line-derived id is still exact within this source and may be retired only by an id-less
    // legacy terminal (noteTurnTransition fences that fallback separately from native ids).
    if (this.activeTurnId === undefined) this.activeTurnId = turnId;
    const existing = this.active.get(turnId);
    const run: ActiveRun = existing ?? { turnId, key: codexRunKey(turnId, this.runGeneration.get(turnId)) };
    run.startedAt = startedAt ?? run.startedAt;
    // Deliberately NOT `lastUserMessageKey`: the rollout writes `task_started` before the turn's own
    // prompt line, so that field still holds the previous turn's prompt here. A running summary
    // simply reports no owner until the prompt is mapped; `finish()` fills it in.
    run.userMessageKey = run.userMessageKey ?? this.openingUserKey(turnId);
    this.active.set(turnId, run);
    if (!existing) this.order.push(turnId);
    return this.summary(run, 'running');
  }

  finish(turnId: string | undefined, status: Exclude<RunStatus, 'running'>, completedAt?: number): AgentMessage[] {
    const id = turnId || (this.order.length === 1 ? this.order[0] : this.order.at(-1));
    const run = id ? this.active.get(id) : undefined;
    const fallbackId = id || 'unknown';
    const resolved: ActiveRun = run ?? {
      turnId: fallbackId,
      key: codexRunKey(fallbackId, this.runGeneration.get(fallbackId)),
      userMessageKey: this.openingUserKey(id),
      assistantMessageKey: this.lastAssistantMessageKey,
    };
    // The prompt line is written after `task_started`, so this is where a real turn's ownership
    // becomes knowable. Fail closed: a turn whose prompt this read never saw stays unowned rather
    // than borrowing the previous turn's.
    resolved.userMessageKey = resolved.userMessageKey ?? this.openingUserKey(id);
    resolved.assistantMessageKey = resolved.assistantMessageKey ?? this.lastAssistantMessageKey;
    const msg = this.summary(resolved, status, completedAt);
    if (id) {
      this.active.delete(id);
      const idx = this.order.indexOf(id);
      if (idx >= 0) this.order.splice(idx, 1);
    }
    if (typeof msg.totalRuntimeMs === 'number') {
      this.totalRuntimeMs += msg.totalRuntimeMs;
      this.turnCount += 1;
      this.updatedAt = msg.completedAt;
      return [msg, this.totals()];
    }
    return [msg];
  }

  private summary(run: ActiveRun, status: RunStatus, completedAt?: number): RunSummaryMessage {
    const totalRuntimeMs =
      typeof run.startedAt === 'number' && typeof completedAt === 'number'
        ? Math.max(0, completedAt - run.startedAt)
        : undefined;
    return {
      type: 'run-summary',
      key: run.key,
      turnId: run.turnId,
      userMessageKey: run.userMessageKey,
      assistantMessageKey: run.assistantMessageKey,
      status,
      startedAt: run.startedAt,
      completedAt,
      totalRuntimeMs,
      source: 'codex-rollout',
    };
  }

  private totals(): AgentMessage {
    return {
      type: 'metadata-update',
      key: 'runtimeTotals',
      value: {
        totalRuntimeMs: this.totalRuntimeMs,
        turnCount: this.turnCount,
        updatedAt: this.updatedAt,
        source: 'codex-rollout',
      },
    };
  }
}

function lineTimestampMs(ln: any): number | undefined {
  return timestampToMs(ln?.timestamp ?? ln?.time ?? ln?.createdAt);
}

function rolloutNativeTurnId(p: any): string | undefined {
  const id = p?.turn_id ?? p?.turnId ?? p?.turn?.id ?? p?.id;
  return id == null ? undefined : String(id);
}

function rolloutTurnId(p: any, lineIndex: number): string {
  return rolloutNativeTurnId(p) ?? `line:${lineIndex}`;
}

/** A rollout line's effect on which turn is in flight: opening one, or ending the one that was. */
export type RolloutTurnTransition =
  | { opens: true; turnId: string }
  | { opens: false; turnId?: string };

/** The turn transition a rollout line declares, read ONLY from lines that are about a turn.
 *
 *  Deliberately not {@link rolloutNativeTurnId}, whose `p.id` fallback would read a message's own
 *  `msg_…` id as a turn id on every other line. Assistant text records carry no turn of their own,
 *  so the enclosing turn is tracked from these transitions instead.
 *
 *  `turn_context` opens a turn: it declares the turn in effect and never disagreed with the enclosing
 *  `task_started` across 1,515 real samples. An opener that declares no id opens nothing — an unnamed
 *  turn cannot key anything, and the line-index fallback is the safe direction. A terminal retains
 *  its exact id so only the matching active turn can be retired. */
export function rolloutTurnTransition(ln: any): RolloutTurnTransition | undefined {
  const p = ln?.payload;
  if (!p) return undefined;
  const opensTurn = ln.type === 'turn_context' || (ln.type === 'event_msg' && p.type === 'task_started');
  const endsTurn = ln.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted');
  if (endsTurn) {
    const id = p.turn_id ?? p.turnId;
    return { opens: false, ...(id != null ? { turnId: String(id) } : {}) };
  }
  if (!opensTurn) return undefined;
  const id = p.turn_id ?? p.turnId;
  return id == null ? undefined : { opens: true, turnId: String(id) };
}

/** Concatenated text of a `response_item` content array. */
function responseItemText(p: any): string {
  const content = Array.isArray(p?.content) ? p.content : [];
  return content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('');
}

/** The native id of the `response_item/message` that pairs with an `event_msg/agent_message`, or
 *  undefined when `next` is not that pair.
 *
 *  Measured across 60 real rollouts (4,680 assistant events): when the paired record exists it is
 *  ALWAYS the very next line — never further away — with `role: 'assistant'`, a native `msg_…` id,
 *  and byte-equal text (4,147/4,147 on all three). Requiring all of them keeps a rewritten or
 *  unpaired record on the line-index fallback rather than borrowing an id that belongs to different
 *  text. */
function pairedAssistantItemId(next: any, text: string): string | undefined {
  const p = next?.payload;
  if (next?.type !== 'response_item' || p?.type !== 'message' || p?.role !== 'assistant') return undefined;
  const id = p.id == null ? '' : String(p.id);
  if (!id || responseItemText(p) !== text) return undefined;
  return id;
}

/** The first REAL record at or after `from`, skipping null slots.
 *
 *  A blank or unparseable segment holds an index but is not a record, so it cannot be the answer to
 *  "what followed this line" either way. Scanning past one is not scanning past the pair; scanning
 *  past a real record would be, which is why this stops at the first one. */
function nextRecord(lines: any[], from: number): any {
  for (let i = from; i < lines.length; i++) if (lines[i]) return lines[i];
  return undefined;
}

/** True for the one rollout line whose identity needs the NEXT line to decide (see
 *  {@link pairedAssistantItemId}). The live tail defers exactly these. */
export function isDeferrableAssistantLine(ln: any): boolean {
  return ln?.type === 'event_msg' && ln.payload?.type === 'agent_message' && Boolean(ln.payload?.message);
}

/** Context-window usage from a `token_count` event's `info`, or undefined when it cannot be trusted.
 *
 *  Three traps live in this payload, all verified against ~42k real rollout events:
 *  - `total_token_usage` ACCUMULATES over the session and reaches many multiples of the window
 *    (160406% on one measured session). Only `last_token_usage` is resident in the window.
 *  - `cached_input_tokens` is a SUBSET of `input_tokens` here (`total_tokens === input + output`,
 *    42255/42255 samples), unlike Anthropic's API where the cache buckets are additive. Summing the
 *    cache bucket in would double-count.
 *  - `total_tokens` is occasionally a sentinel equal to the window size while every other bucket is
 *    zero, which would render a false 100%. Summing input+output sidesteps it. */
function codexContextUsage(info: any): AgentMessage | undefined {
  const last = info?.last_token_usage;
  const max = info?.model_context_window;
  if (!last || typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return undefined;
  const input = typeof last.input_tokens === 'number' ? last.input_tokens : 0;
  const output = typeof last.output_tokens === 'number' ? last.output_tokens : 0;
  const used = input + output;
  if (used <= 0) return undefined;
  return { type: 'metadata-update', key: 'contextUsage', value: { used, max } };
}

/** Map ONE rollout line (already parsed) at `lineIndex` to canonical messages, enriching
 *  tool-results from `enrich`.
 *
 *  `next` is the immediately following rollout line when the caller already knows it. Assistant text
 *  needs it: its native identity lives on the paired `response_item/message`, not on the event
 *  record being mapped (see {@link pairedAssistantItemId}). Callers that cannot see the next line
 *  yet either defer the line (the live tail) or accept the line-index fallback. */
export function mapLine(
  ln: any,
  lineIndex: number,
  enrich: Map<string, CodexEnrich>,
  runtime = new CodexRuntimeTracker(),
  next?: any,
  published?: CodexPublishedIdentities,
): AgentMessage[] {
  const p = ln?.payload;
  if (!p) return [];
  const duplicateLegacyAssistantPair = runtime.consumeLegacyAssistantPair(ln);
  const duplicateUserDualEmission = runtime.consumeUserDualEmission(ln);
  const key = `c${lineIndex}`;
  const ts = lineTimestampMs(ln);
  const transition = runtime.noteTurnTransition(rolloutTurnTransition(ln));
  if (ln.type === 'event_msg') {
    switch (p.type) {
      case 'user_message': {
        if (!p.message) return [];
        // The other durable form of this same prompt already produced its row (see the
        // `item_completed`/`UserMessage` case): a dual-format rollout writes one prompt twice, and
        // the second durable record must not become a second bubble.
        if (duplicateUserDualEmission) return [];
        // The rollout gives this line no native identity at all, but the enclosing turn is already
        // open (`turn_context`/`task_started` precede it and both carry `turn_id`). Rebuilding
        // `codex:<turnId>:u<ordinal>` here is what makes the replayed prompt the SAME row the live
        // app-server echo produced. Turn-less heads and older rollouts keep the line-index key: a
        // fallback costs the duplicate this lane fixes, never a lost or merged prompt.
        const turnId = runtime.currentTurnId;
        const decided = turnId ? codexUserMessageKey(turnId, runtime.nextUserOrdinal(turnId)) : key;
        // An identity this connection already handed a client outranks the one this read would
        // pick, exactly as for assistant text: re-deciding is how one prompt becomes two rows.
        const userKey = published ? published.adopt(lineIndex, decided) : decided;
        runtime.recordUser(userKey);
        runtime.expectUserDualEmission('legacy', String(p.message), turnId);
        return [{ type: 'user-message', text: String(p.message), key: userKey, turnId, sentAt: ts }];
      }
      case 'item_completed': {
        // Codex 0.147 stopped writing `event_msg/user_message`: a prompt's only durable event is
        // now `item_completed` whose `item.type` is `UserMessage` (measured locally: 34 rollouts,
        // 275 such items, none beside a legacy record). Every other completed item type stays
        // ignored here exactly as before — assistant text, reasoning and tools keep arriving via
        // their paired `response_item` records, so mapping them too would double each one.
        const item = p.item;
        if (item?.type !== 'UserMessage') return [];
        const text = userInputText(item.content);
        if (!text) return [];
        // The legacy form of this same prompt already produced its row (dual-format rollout).
        if (duplicateUserDualEmission) return [];
        // Unlike the legacy event, this record names its own turn — and that exact id outranks
        // whichever turn this read currently considers open: booking under `turn_id` keeps the
        // key AND the footer's ownership correct even when this line and the turn's opening
        // records are read on different sides of an attach boundary.
        const turnId = p.turn_id != null ? String(p.turn_id) : runtime.currentTurnId;
        const decided = turnId ? codexUserMessageKey(turnId, runtime.nextUserOrdinal(turnId)) : key;
        const userKey = published ? published.adopt(lineIndex, decided) : decided;
        runtime.recordUser(userKey, turnId);
        runtime.expectUserDualEmission('item', text, turnId);
        const imageCount = imageInputCount(item.content);
        return [{
          type: 'user-message',
          text,
          key: userKey,
          turnId,
          sentAt: ts ?? timestampToMs(p.started_at_ms),
          ...(imageCount ? { imageCount } : {}),
        }];
      }
      case 'agent_message': {
        if (!p.message) return [];
        const text = String(p.message);
        // Prefer the identity the app-server also delivers, so a final that has reached the rollout
        // while the live accumulator still holds it stays ONE message. Older rollouts (no paired
        // record, no native id) and turn-less heads keep the line-index key: a mismatch there costs
        // the duplicate this lane fixes, never a lost or merged answer.
        const nativeId = pairedAssistantItemId(next, text);
        const turnId = runtime.currentTurnId;
        const decided = nativeId && turnId ? codexItemTextKey(turnId, nativeId, 't') : key;
        // An identity this connection already handed a client outranks the one this read would pick:
        // the client stored the first, and re-deciding is how one answer becomes two rows.
        const textKey = published ? published.adopt(lineIndex, decided) : decided;
        runtime.recordAssistant(textKey);
        runtime.expectLegacyAssistantPair(text);
        return [{ type: 'model-output', text, final: true, key: textKey }];
      }
      case 'agent_reasoning': {
        const txt = reasoningText(p);
        return txt ? [{ type: 'thinking', text: txt, key }] : [];
      }
      case 'task_started': {
        const turnId = rolloutTurnId(p, lineIndex);
        return [{ type: 'status', status: 'running' }, runtime.start(turnId, ts)];
      }
      case 'task_complete': {
        if (transition !== 'retired') return [];
        const messages: AgentMessage[] = [
          { type: 'status', status: 'idle' },
          ...runtime.finish(rolloutNativeTurnId(p), 'done', ts),
          ...runtime.reapSubagents('done', ts),
        ];
        runtime.clearInterruptionEvidence();
        return messages;
      }
      case 'turn_aborted': {
        if (transition !== 'retired') return [];
        // The rollout contains automatic host-approval denials in this SAME turn's tool results.
        // Two or more give the interruption an actionable reason; one stays generic because a
        // single denied escalation does not itself prove why the turn ended.
        const repeatedAutomaticApprovalDenial =
          runtime.consumeRepeatedAutomaticApprovalDenial();
        const turnId = rolloutNativeTurnId(p);
        return [
          {
            type: 'notice',
            message: p.reason === 'interrupted'
              ? (
                  repeatedAutomaticApprovalDenial
                    ? CODEX_REPEATED_AUTO_APPROVAL_INTERRUPTION_NOTICE
                    : CODEX_INTERRUPTED_NOTICE
                )
              : `Turn aborted${p.reason ? ` (${String(p.reason)})` : ''}.`,
            semantic: {
              kind: 'interruption',
              reason: repeatedAutomaticApprovalDenial
                ? 'automatic-approval-denied-repeatedly'
                : 'generic',
              ...(turnId ? { turnId } : {}),
            },
          },
          { type: 'status', status: 'idle' },
          ...runtime.finish(rolloutNativeTurnId(p), 'cancelled', ts),
          ...runtime.reapSubagents('error', ts),
        ];
      }
      case 'thread_goal_updated': {
        // Same goal payload as the live `thread/goal/updated` notification — without this the app only
        // ever saw goals on live-synced sessions, never in observe/replay ("Goal paused" issues-part2).
        const goal = codexGoalMessage(p.goal);
        return goal ? [goal] : [];
      }
      case 'token_count': {
        const out: AgentMessage[] = [];
        const u = p.info?.total_token_usage;
        if (u) out.push({ type: 'token-count', input: u.input_tokens, output: u.output_tokens, cacheRead: u.cached_input_tokens });
        const ctx = codexContextUsage(p.info);
        if (ctx) out.push(ctx);
        return out;
      }
      case 'context_compacted':
        return [{
          type: 'history-reset',
          notice: 'Compacted the conversation.',
          semantic: { kind: 'compaction' },
        }];
      case 'thread_rolled_back':
        // Out-of-band truncation (the same class as context_compacted) → reload the whole transcript.
        return [{
          type: 'history-reset',
          notice: typeof p.num_turns === 'number'
            ? `Rolled back ${p.num_turns} turn(s).`
            : 'Conversation rolled back.',
          semantic: { kind: 'rollback' },
        }];
      case 'error':
        return [{ type: 'error', message: String(p.message ?? p.error ?? 'error').split('\n')[0]!.slice(0, 200) }];
      default:
        return []; // exec_command_end / patch_apply_end → enrichment only (see accumulateEnrich)
    }
  }
  if (ln.type === 'response_item') {
    switch (p.type) {
      case 'message': {
        if (p.role !== 'assistant' || duplicateLegacyAssistantPair) return [];
        const text = responseItemText(p);
        if (!text) return [];
        const nativeId = p.id == null ? '' : String(p.id);
        const turnId = runtime.currentTurnId;
        const decided = nativeId && turnId
          ? codexItemTextKey(turnId, nativeId, 't')
          : key;
        const textKey = published ? published.adopt(lineIndex, decided) : decided;
        runtime.recordAssistant(textKey);
        return [{ type: 'model-output', text, final: true, key: textKey }];
      }
      // apply_patch et al. arrive as custom_tool_call (NOT function_call) — both are tool calls.
      case 'function_call': {
        if (p.name === 'update_plan') {
          const taskList = taskListStateFromCodexUpdatePlan(p);
          // Codex `update_plan` is session task state, not a transcript tool card. Suppress malformed
          // plan chatter instead of rendering raw JSON. See docs/architecture/client-ui.md
          return taskList ? [taskList] : [];
        }
        // spawn_agent/wait_agent are subagent control-plane, not user tool cards — their matching
        // function_call_output produces the agent-activity bar (running on spawn, done on wait).
        if (p.name === 'spawn_agent' || p.name === 'wait_agent') return [];
        const callId = String(p.call_id ?? '');
        const semantic = codexCallSemantic(String(p.name ?? 'tool'), enrich.get(callId), parseArgs(p.arguments));
        return [{
          type: 'tool-call',
          callId,
          toolName: String(p.name ?? 'tool'),
          toolClass: codexToolDisplayClass(String(p.name ?? 'tool')),
          args: parseArgs(p.arguments),
          ...(semantic ? { semantic } : {}),
        }];
      }
      case 'custom_tool_call':
        return [{
          type: 'tool-call',
          callId: String(p.call_id ?? ''),
          toolName: String(p.name ?? 'tool'),
          toolClass: codexToolDisplayClass(String(p.name ?? 'tool')),
          args: p.type === 'custom_tool_call' ? (p.input ?? undefined) : parseArgs(p.arguments),
        }];
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = String(p.call_id ?? '');
        const text = typeof p.output === 'string' ? p.output : safeStringify(p.output);
        const e = enrich.get(callId) ?? {};
        runtime.recordAutomaticApprovalDenial(e.name, p.output);
        if (e.name === 'update_plan') return [];
        // Subagent lifecycle → activity bars (see spawn_agent/wait_agent suppression above).
        if (e.name === 'spawn_agent') return spawnAgentActivity(p.output, e, ts, runtime);
        if (e.name === 'wait_agent') return waitAgentActivity(p.output, ts, runtime);
        const semantic = codexCallSemantic(e.name ?? 'tool', e, undefined, { hasResult: true, output: text });
        return [{
          type: 'tool-result',
          callId,
          toolName: e.name ?? 'tool',
          toolClass: codexToolDisplayClass(e.name ?? 'tool'),
          ...(semantic ? { semantic } : {}),
          isError: e.exitCode != null && e.exitCode !== 0,
          result: text,
          path: e.path,
          diff: e.diff,
          fileChanges: e.fileChanges,
          additions: e.additions,
          deletions: e.deletions,
          exitCode: e.exitCode,
          truncated: e.truncated,
          title: e.title,
          durationMs: e.durationMs,
        }];
      }
      default:
        return []; // reasoning → covered by event_msg/agent_reasoning
    }
  }
  return [];
}

/** A `spawn_agent` function_call_output → a running subagent bar. Output is `{agent_id, nickname}`
 *  (JSON string); the role (`agent_type`) was folded onto `enrich` from the matching call. */
function spawnAgentActivity(output: unknown, e: CodexEnrich, ts: number | undefined, runtime: CodexRuntimeTracker): AgentMessage[] {
  const o = parseArgs(output);
  if (!o || typeof o !== 'object') return [];
  const raw = (o as any).agent_id ?? (o as any).agentId ?? (o as any).id;
  if (raw == null) return [];
  const agentId = String(raw);
  const nickname = String((o as any).nickname ?? (o as any).name ?? agentId.slice(0, 8));
  return [runtime.spawnSubagent(agentId, nickname, e.agentType, ts)];
}

/** A `wait_agent` function_call_output → done/error bars + the child's report for each child that reached a
 *  terminal state. Output is `{status:{<agent_id>:{completed|failed|...}}}`; children still running are left
 *  as-is (a timed-out wait gives an EMPTY status map — those are reaped at turn end, not here). */
function waitAgentActivity(output: unknown, ts: number | undefined, runtime: CodexRuntimeTracker): AgentMessage[] {
  const o = parseArgs(output);
  const status = o && typeof o === 'object' ? (o as any).status : undefined;
  if (!status || typeof status !== 'object') return [];
  const out: AgentMessage[] = [];
  for (const [agentId, st] of Object.entries(status as Record<string, any>)) {
    const verdict = subagentVerdict(st);
    if (verdict) out.push(...runtime.resolveSubagent(agentId, verdict, subagentReport(st), ts));
  }
  return out;
}

/** The child's returned text from its wait_agent status entry (the report it was spawned to produce). */
function subagentReport(st: any): string | undefined {
  if (!st || typeof st !== 'object') return undefined;
  for (const k of ['completed', 'failed', 'error', 'result', 'output', 'message']) {
    const v = st[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/** Classify one child's wait_agent status entry: a `completed` payload → done; an explicit failure → error;
 *  anything still in flight → undefined (leave the running bar untouched until a later wait resolves it). */
function subagentVerdict(st: any): 'done' | 'error' | undefined {
  if (!st || typeof st !== 'object') return undefined;
  if (st.completed != null) return 'done';
  if (st.failed != null || st.error != null) return 'error';
  const s = typeof st.status === 'string' ? st.status.toLowerCase() : '';
  if (s === 'completed' || s === 'complete' || s === 'done') return 'done';
  if (s === 'failed' || s === 'error' || s === 'cancelled' || s === 'canceled' || s === 'timeout') return 'error';
  return undefined;
}

function taskListStateFromCodexUpdatePlan(p: any): AgentMessage | undefined {
  const args = parseArgs(p?.arguments);
  const plan = Array.isArray((args as any)?.plan) ? (args as any).plan : undefined;
  if (!plan?.length) return undefined;
  const items: Extract<AgentMessage, { type: 'task-list-state' }>['items'] = [];
  for (const [index, item] of plan.entries()) {
    const title = String(item?.step ?? item?.title ?? item?.content ?? '').trim();
    if (!title) continue;
    items.push({
      id: item?.id != null ? String(item.id) : String(index),
      title,
      status: normalizeCodexPlanStatus(item?.status),
    });
  }
  if (!items.length) return undefined;
  const terminal = items.every((item) => item.status === 'done' || item.status === 'cancelled');
  const planKey = 'codex:plan';
  return {
    type: 'task-list-state',
    key: planKey,
    title: 'Plan',
    status: terminal ? 'done' : 'running',
    source: 'tool-call',
    sourceTool: 'update_plan',
    semantic: codexPlanSemantic(planKey, items, terminal),
    items,
  };
}

function taskListStateFromCodexNativePlan(params: any): AgentMessage | undefined {
  const plan = Array.isArray(params?.plan) ? params.plan : undefined;
  if (!plan?.length) return undefined;
  const items: Extract<AgentMessage, { type: 'task-list-state' }>['items'] = [];
  for (const [index, item] of plan.entries()) {
    const title = String(item?.step ?? item?.title ?? item?.content ?? '').trim();
    if (!title) continue;
    items.push({
      id: item?.id != null ? String(item.id) : String(index),
      title,
      status: normalizeCodexPlanStatus(item?.status),
    });
  }
  if (!items.length) return undefined;
  const terminal = items.every((item) => item.status === 'done' || item.status === 'cancelled');
  const turnId = params?.turnId ? String(params.turnId) : undefined;
  const planKey = turnId ? `codex:plan:${turnId}` : 'codex:plan';
  return {
    type: 'task-list-state',
    key: planKey,
    title: params?.explanation ? compactText(params.explanation) || 'Plan' : 'Plan',
    status: terminal ? 'done' : 'running',
    source: 'native',
    sourceTool: 'turn/plan/updated',
    semantic: codexPlanSemantic(planKey, items, terminal),
    items,
  };
}

function codexPlanSemantic(
  planKey: string,
  items: Extract<AgentMessage, { type: 'task-list-state' }>['items'],
  terminal: boolean,
): PlanSemantic {
  const revision = createHash('sha256')
    .update(JSON.stringify(items.map(({ id, title, status }) => ({ id, title, status }))))
    .digest('base64url')
    .slice(0, 32);
  return {
    kind: 'plan',
    planKey,
    revision,
    state: terminal ? 'completed' : 'active',
    // Codex exposes plan state but no native approve/edit/exit RPC for these notifications. Do not
    // turn a display plan into fabricated controls; a future adapter hook may advertise them.
    actions: { approve: false, edit: false, exit: false },
  };
}

function normalizeCodexPlanStatus(status: unknown): 'open' | 'in-progress' | 'done' | 'cancelled' {
  const s = String(status ?? '').toLowerCase().replace(/[_\s-]+/g, '-');
  if (s === 'completed' || s === 'complete' || s === 'done') return 'done';
  if (s === 'in-progress' || s === 'inprogress' || s === 'running' || s === 'active') return 'in-progress';
  if (s === 'cancelled' || s === 'canceled' || s === 'skipped') return 'cancelled';
  return 'open';
}

/**
 * Two-pass map of a full rollout: build the call_id → detail map, then emit double-free messages.
 * `lines` is position-preserving — a blank/malformed line is a `null` slot that STILL consumes its
 * index, so keys here match the live tail (which advances its line counter for every newline segment,
 * parseable or not). That alignment is what makes the history vs live-tail dedupe correct.
 */
export function mapRollout(lines: any[], published?: CodexPublishedIdentities): AgentMessage[] {
  const enrich = new Map<string, CodexEnrich>();
  for (const ln of lines) if (ln) accumulateEnrich(ln, enrich);
  const runtime = new CodexRuntimeTracker();
  const out: AgentMessage[] = [];
  // A whole-file map always knows the next line, so assistant text here resolves to its native
  // identity whenever the rollout recorded one.
  for (let i = 0; i < lines.length; i++) if (lines[i]) out.push(...mapLine(lines[i], i, enrich, runtime, nextRecord(lines, i + 1), published));
  return out;
}

// ── resume live mapping helpers ─────────────────────────────────────────────

function codexRunStatusFromNative(status: unknown): Exclude<RunStatus, 'running'> {
  const s = String(status ?? '').toLowerCase();
  if (s === 'failed' || s === 'error') return 'error';
  if (s === 'interrupted' || s === 'cancelled' || s === 'canceled' || s === 'aborted') return 'cancelled';
  return 'done';
}

function finiteMs(...values: unknown[]): number | undefined {
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

/** Canonical run key for one GENERATION of a turn id (R0c.4 round 4).
 *
 *  Generation one keeps the base key every consumer already published against. Later generations
 *  carry an explicit qualifier, because canonical identity downstream is exactly `type` + `key`:
 *  the Flutter reducer merges equal pairs (the second footer would REPLACE the first) and Attention
 *  derives its observation/dedupe identity from this key, so one shared key collapses two real
 *  turns into one everywhere it matters. Both the live connection and the rollout replay derive the
 *  generation from the same evidence — a start after the id's own terminal — so the two paths mint
 *  identical keys. */
function codexRunKey(turnId: string, generation: number | undefined): string {
  return generation !== undefined && generation > 1
    ? `codex:run:${turnId}@g${generation}`
    : `codex:run:${turnId}`;
}

function codexNativeRunSummary(params: any, status: RunStatus): RunSummaryMessage | null {
  const turn = params?.turn ?? {};
  const turnId = String(turn.id ?? params?.turnId ?? params?.turn_id ?? '');
  if (!turnId) return null;
  const startedAt = timestampToMs(turn.startedAt ?? turn.started_at ?? turn.createdAt ?? turn.created_at ?? params?.startedAt ?? params?.started_at);
  const completedAt = timestampToMs(turn.completedAt ?? turn.completed_at ?? turn.finishedAt ?? turn.finished_at ?? turn.updatedAt ?? turn.updated_at ?? params?.completedAt ?? params?.completed_at);
  const reportedTotal = finiteMs(turn.totalRuntimeMs, turn.runtimeMs, turn.durationMs, turn.elapsedMs, params?.totalRuntimeMs, params?.runtimeMs, params?.durationMs, params?.elapsedMs);
  const totalRuntimeMs = reportedTotal ?? (
    typeof startedAt === 'number' && typeof completedAt === 'number'
      ? Math.max(0, completedAt - startedAt)
      : undefined
  );
  // App-server turn notifications are allowed to carry only the native turn
  // id and status. The exact id is sufficient to pair running and terminal
  // evidence; timing fields enrich the row but must not gate it. Gating here
  // dropped the observation AttentionPolicy needs and made ordinary native
  // completions disappear from the durable attention ledger.
  return {
    type: 'run-summary',
    key: `codex:run:${turnId}`,
    turnId,
    status,
    startedAt,
    completedAt,
    totalRuntimeMs,
    source: 'codex-app-server',
  };
}

/** The one identity a Codex text item carries on every surface that delivers it.
 *
 *  The app-server streams and completes an item under exactly this string. The rollout persists the
 *  SAME item as an `event_msg/agent_message` immediately followed by a `response_item/message` —
 *  and that response item is the only half of the pair carrying the native id. Rebuilding this
 *  string from the rollout is what keeps one logical answer ONE message when saved history and a
 *  still-live snapshot overlap at the attach boundary (CR4). */
function codexItemTextKey(turnId: string, itemId: string, kind: 't' | 'r'): string {
  return `codex:${turnId}:${itemId}:${kind}`;
}

/**
 * The one identity a Codex USER message carries on every surface (CR4b).
 *
 * Unlike an assistant item, a user prompt has no native id anywhere. Measured on a real 21k-line
 * rollout: `event_msg/user_message` carries only `message`/`images`/`text_elements` — no `turn_id`,
 * no `id` — and the `response_item/message` with `role: 'user'` that precedes it carries no `id`
 * either. The app-server side has the opposite problem: its `item/started` echo has an id, but it is
 * one this broker invented (`clientId`) or one the rollout never records.
 *
 * What BOTH surfaces do know is the enclosing turn and the order of user messages inside it:
 * the rollout opens a turn with `task_started`/`turn_context` (both carry `turn_id`) before the
 * prompt line, and the app-server delivers the same `turnId` on `item/started`. `(turnId, ordinal)`
 * is therefore the only identity that live, tail, history, reconnect, paging and restart can all
 * rebuild — and it is structural, never textual, so two byte-identical prompts stay two messages.
 *
 * The ordinal distinguishes a mid-turn steer from the prompt that opened the turn.
 */
function codexUserMessageKey(turnId: string, ordinal: number): string {
  return `codex:${turnId}:u${ordinal}`;
}

function codexTextKey(params: any, kind: 't' | 'r'): string {
  return codexItemTextKey(String(params?.turnId ?? ''), String(params?.itemId ?? 'unknown'), kind);
}

function codexToolCallFromItem(item: any, turnId: string): AgentMessage | null {
  switch (item.type) {
    case 'commandExecution': {
      const semantic = codexItemCommandSemantic(item, false);
      return {
        type: 'tool-call',
        callId: String(item.id ?? ''),
        toolName: 'exec_command',
        toolClass: 'execute',
        title: item.command ? String(item.command) : 'Run command',
        args: { cmd: item.command, cwd: item.cwd },
        ...(semantic ? { semantic } : {}),
      };
    }
    case 'fileChange':
      return {
        type: 'tool-call',
        callId: String(item.id ?? ''),
        toolName: 'apply_patch',
        toolClass: 'edit',
        title: fileChangeTitle(item) ?? 'Apply patch',
        args: item.changes,
      };
    case 'mcpToolCall':
      return {
        type: 'tool-call',
        callId: String(item.id ?? ''),
        toolName: [item.server, item.tool].filter(Boolean).join('.') || 'mcp_tool',
        toolClass: codexToolDisplayClass([item.server, item.tool].filter(Boolean).join('.') || 'mcp_tool'),
        args: item.arguments,
      };
    case 'dynamicToolCall':
      return {
        type: 'tool-call',
        callId: String(item.id ?? ''),
        toolName: [item.namespace, item.tool].filter(Boolean).join('.') || 'tool',
        toolClass: codexToolDisplayClass([item.namespace, item.tool].filter(Boolean).join('.') || 'tool'),
        args: item.arguments,
      };
    case 'webSearch':
      return {
        type: 'tool-call',
        callId: String(item.id ?? ''),
        toolName: 'web_search',
        toolClass: 'lookup',
        args: { query: item.query },
        semantic: boundToolSemantic(webSemantic({ query: item.query }))!,
      };
    case 'imageView':
      return {
        type: 'tool-call',
        callId: String(item.id ?? ''),
        toolName: 'view_image',
        toolClass: 'lookup',
        args: { path: item.path },
      };
    case 'imageGeneration':
      return {
        type: 'tool-call',
        callId: String(item.id ?? ''),
        toolName: 'image_generation',
        toolClass: 'other',
        args: { revisedPrompt: item.revisedPrompt },
      };
    default:
      void turnId;
      return null;
  }
}

function codexToolResultFromItem(item: any): AgentMessage | null {
  switch (item.type) {
    case 'commandExecution': {
      const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined;
      const semantic = codexItemCommandSemantic(item, true);
      return {
        type: 'tool-result',
        callId: String(item.id ?? ''),
        toolName: 'exec_command',
        toolClass: 'execute',
        ...(semantic ? { semantic } : {}),
        title: item.command ? String(item.command) : 'Run command',
        isError: item.status === 'failed' || item.status === 'declined' || (exitCode != null && exitCode !== 0),
        result: item.aggregatedOutput ?? '',
        exitCode,
        durationMs: nativeDurationMs(item),
      };
    }
    case 'fileChange': {
      const diff = (item.changes ?? []).map((c: any) => c?.diff).filter((d: any) => typeof d === 'string' && d).join('\n');
      // Per-file change set: split each carried diff, backfilling a path/operation from the change
      // entry when its diff lacks headers. Event-time only — never reconstructed from Git.
      const fileChanges: FileChange[] = [];
      for (const c of item.changes ?? []) {
        if (!c || typeof c.diff !== 'string' || !c.diff) continue;
        const parts = splitUnifiedDiffFiles(c.diff);
        const cp = c.path ? String(c.path) : undefined;
        const op: FileOperation | undefined = c.kind === 'add' || c.type === 'add' ? 'create' : c.kind === 'delete' || c.type === 'delete' ? 'delete' : undefined;
        if (parts.length) {
          for (const part of parts) fileChanges.push({ ...part, path: part.path || cp || '', operation: part.operation === 'edit' && op ? op : part.operation });
        } else if (cp) {
          fileChanges.push({ path: cp, operation: op ?? 'edit', diff: c.diff, ...summarizeDiff(c.diff) });
        }
      }
      const path = fileChanges[0]?.path ?? (item.changes?.[0]?.path ? String(item.changes[0].path) : undefined);
      const stats: { additions?: number; deletions?: number } = diff ? summarizeDiff(diff) : {};
      return {
        type: 'tool-result',
        callId: String(item.id ?? ''),
        toolName: 'apply_patch',
        toolClass: 'edit',
        title: (fileChanges.length ? titleForChanges(fileChanges) : undefined) ?? fileChangeTitle(item),
        isError: item.status === 'failed' || item.status === 'declined',
        result: item.status ?? 'completed',
        path,
        diff: diff || undefined,
        fileChanges: fileChanges.length ? fileChanges : undefined,
        additions: stats.additions,
        deletions: stats.deletions,
        exitCode: item.status === 'failed' || item.status === 'declined' ? 1 : undefined,
        durationMs: nativeDurationMs(item),
      };
    }
    case 'mcpToolCall':
      return {
        type: 'tool-result',
        callId: String(item.id ?? ''),
        toolName: [item.server, item.tool].filter(Boolean).join('.') || 'mcp_tool',
        toolClass: codexToolDisplayClass([item.server, item.tool].filter(Boolean).join('.') || 'mcp_tool'),
        isError: item.status === 'failed' || !!item.error,
        result: item.error ?? item.result ?? '',
        durationMs: nativeDurationMs(item),
      };
    case 'dynamicToolCall':
      return {
        type: 'tool-result',
        callId: String(item.id ?? ''),
        toolName: [item.namespace, item.tool].filter(Boolean).join('.') || 'tool',
        toolClass: codexToolDisplayClass([item.namespace, item.tool].filter(Boolean).join('.') || 'tool'),
        isError: item.success === false || item.status === 'failed',
        result: item.contentItems ?? '',
        durationMs: nativeDurationMs(item),
      };
    case 'webSearch':
      return {
        type: 'tool-result',
        callId: String(item.id ?? ''),
        toolName: 'web_search',
        toolClass: 'lookup',
        semantic: boundToolSemantic(webSemantic({
          query: item.query,
          results: Array.isArray(item.results) ? item.results : undefined,
        }))!,
        result: item.action ?? item.query ?? '',
        durationMs: nativeDurationMs(item),
      };
    case 'imageView':
      return {
        type: 'tool-result',
        callId: String(item.id ?? ''),
        toolName: 'view_image',
        toolClass: 'lookup',
        path: item.path ? String(item.path) : undefined,
        result: item.path ?? '',
        durationMs: nativeDurationMs(item),
      };
    case 'imageGeneration':
      return {
        type: 'tool-result',
        callId: String(item.id ?? ''),
        toolName: 'image_generation',
        toolClass: 'other',
        path: item.savedPath ? String(item.savedPath) : undefined,
        result: item.result ?? item.status ?? '',
        isError: /fail|error/i.test(String(item.status ?? '')),
        durationMs: nativeDurationMs(item),
      };
    default:
      return null;
  }
}

function fileChangeTitle(item: any): string | undefined {
  const path = item?.changes?.[0]?.path;
  return path ? `Edited ${basename(String(path))}` : undefined;
}

function userInputText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => {
      if (c?.type === 'text') return c.text ?? '';
      // `localImage` on the app-server wire, `local_image` in the 0.147 rollout's completed item.
      if (c?.type === 'image' || c?.type === 'localImage' || c?.type === 'local_image') return '[image]';
      if (c?.type === 'mention') return c.path ? `@${c.path}` : c.name ? `@${c.name}` : '';
      if (c?.type === 'skill') return c.name ? `/${c.name}` : '';
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function imageInputCount(content: unknown): number | undefined {
  if (!Array.isArray(content)) return undefined;
  const n = content.filter((c: any) => c?.type === 'image' || c?.type === 'localImage' || c?.type === 'local_image').length;
  return n || undefined;
}

export const CODEX_MAX_MODEL_OPTIONS = 256;
export const CODEX_MAX_REASONING_EFFORTS = 16;

function codexModelOptions(
  response: any,
  defaultProvider: string,
): ModelOption[] {
  const models: any[] = Array.isArray(response?.data)
    ? response.data.slice(0, CODEX_MAX_MODEL_OPTIONS)
    : [];
  const unique = new Map<string, ModelOption>();
  for (const model of models) {
    if (!model?.id && !model?.model) continue;
    const option: ModelOption = {
      providerID: String(
        model.providerID ??
          model.providerId ??
          model.provider ??
          model.modelProvider ??
          defaultProvider,
      ),
      modelID: String(model.model ?? model.id),
      label: String(model.displayName ?? model.model ?? model.id),
      description: model.description
        ? String(model.description)
        : undefined,
      reasoningEfforts: (Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.slice(
            0,
            CODEX_MAX_REASONING_EFFORTS,
          )
        : []
      )
        .map((effortValue: any) => {
          const effort =
            effortValue?.reasoningEffort ??
            effortValue?.effort ??
            effortValue;
          return effort
            ? {
                effort: String(effort),
                label: String(
                  effortValue?.displayName ??
                    effortValue?.label ??
                    reasoningEffortLabel(String(effort)),
                ),
                description: effortValue?.description
                  ? String(effortValue.description)
                  : undefined,
              }
            : null;
        })
        .filter(Boolean) as ModelOption['reasoningEfforts'],
      defaultReasoningEffort: model.defaultReasoningEffort
        ? String(model.defaultReasoningEffort)
        : undefined,
    };
    const key = `${option.providerID}\0${option.modelID}`;
    if (!unique.has(key)) unique.set(key, option);
  }
  return [...unique.values()];
}

function reasoningEffortLabel(effort: string): string {
  return effort
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join(' ');
}

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
]);

function isApprovalMethod(method: string): boolean {
  return APPROVAL_METHODS.has(method);
}

function codexWaitingRequestId(threadId: string, kind: 'approval' | 'question', occurrence: string): string {
  return `codex:waiting:${kind}:${threadId}:${occurrence}`;
}

type CodexPermissionModeSettings = {
  value: string;
  approvalPolicy: unknown;
  approvalsReviewer: 'user' | 'auto_review';
  sandboxPolicy?: unknown;
};

function codexPermissionMode(value: string | undefined, baselineSandboxPolicy?: unknown): CodexPermissionModeSettings {
  switch (value) {
    case 'approve-for-me':
      return { value: 'approve-for-me', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxPolicy: baselineSandboxPolicy };
    case 'full-access':
      return { value: 'full-access', approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } };
    case 'ask-permission':
    default:
      return { value: CODEX_DEFAULT_PERMISSION_MODE, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: baselineSandboxPolicy };
  }
}

/** Rollout turn_context records sandbox_policy in snake_case; the wire API takes camelCase.
 *  Returns undefined for shapes that should not be blindly restored (e.g. externalSandbox). */
function wireSandboxPolicyFromRollout(value: any): unknown | undefined {
  if (!value || typeof value !== 'object' || !('type' in value)) return undefined;
  const t = String(value.type);
  if (t === 'dangerFullAccess' || t === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (t === 'readOnly' || t === 'read-only') return { type: 'readOnly', networkAccess: !!(value.networkAccess ?? value.network_access) };
  if (t === 'workspaceWrite' || t === 'workspace-write') {
    return {
      type: 'workspaceWrite',
      writableRoots: value.writableRoots ?? value.writable_roots ?? [],
      networkAccess: !!(value.networkAccess ?? value.network_access),
      excludeTmpdirEnvVar: !!(value.excludeTmpdirEnvVar ?? value.exclude_tmpdir_env_var),
      excludeSlashTmp: !!(value.excludeSlashTmp ?? value.exclude_slash_tmp),
    };
  }
  return undefined;
}

function safeCodexSandboxPolicy(value: unknown, cwd?: string): unknown {
  if (value && typeof value === 'object' && 'type' in value && String((value as any).type) !== 'dangerFullAccess') return value;
  return {
    type: 'workspaceWrite',
    writableRoots: cwd ? [cwd] : [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function codexModeFromSettings(approvalPolicy: unknown, approvalsReviewer: unknown, sandboxPolicy: unknown): string {
  const approval = typeof approvalPolicy === 'string' ? approvalPolicy : approvalPolicy && typeof approvalPolicy === 'object' ? 'granular' : '';
  const reviewer = typeof approvalsReviewer === 'string' ? approvalsReviewer : '';
  const sandbox =
    typeof sandboxPolicy === 'string'
      ? sandboxPolicy
      : sandboxPolicy && typeof sandboxPolicy === 'object' && 'type' in sandboxPolicy
        ? String((sandboxPolicy as any).type)
        : '';
  // An unsandboxed thread must never be presented as a safe mode, even if another client left a
  // mixed approval/reviewer tuple behind. Sandbox danger takes precedence over reviewer policy.
  if (sandbox === 'dangerFullAccess' || sandbox === 'danger-full-access') return 'full-access';
  if (reviewer === 'auto_review' || reviewer === 'guardian_subagent') return 'approve-for-me';
  // Compatibility for rollouts written before Codex exposed approvals_reviewer separately.
  if (approval === 'never') return 'approve-for-me';
  return CODEX_DEFAULT_PERMISSION_MODE;
}

function approvalMessage(method: string, requestId: string, params: any): AgentMessage {
  if (method === 'item/commandExecution/requestApproval') {
    const detail = [params?.command, params?.cwd ? `cwd: ${params.cwd}` : '', params?.reason].filter(Boolean).join('\n');
    return { type: 'permission-request', requestId, title: 'Approve command', toolName: 'exec_command', detail };
  }
  if (method === 'execCommandApproval') {
    const cmd = Array.isArray(params?.command) ? params.command.join(' ') : params?.command;
    const detail = [cmd, params?.cwd ? `cwd: ${params.cwd}` : '', params?.reason].filter(Boolean).join('\n');
    return { type: 'permission-request', requestId, title: 'Approve command', toolName: 'exec_command', detail };
  }
  if (method === 'item/fileChange/requestApproval') {
    const detail = [params?.grantRoot ? `root: ${params.grantRoot}` : '', params?.reason].filter(Boolean).join('\n');
    return { type: 'permission-request', requestId, title: 'Approve file change', toolName: 'apply_patch', detail };
  }
  if (method === 'applyPatchApproval') {
    const paths = Object.keys(params?.fileChanges ?? {});
    const detail = [paths.join('\n'), params?.grantRoot ? `root: ${params.grantRoot}` : '', params?.reason].filter(Boolean).join('\n');
    return { type: 'permission-request', requestId, title: 'Approve file change', toolName: 'apply_patch', detail };
  }
  const detail = [params?.cwd ? `cwd: ${params.cwd}` : '', params?.reason, safeStringify(params?.permissions)].filter(Boolean).join('\n');
  return { type: 'permission-request', requestId, title: 'Approve permissions', toolName: 'permissions', detail };
}

function approvalResponse(method: string, params: any, decision: PermissionDecision): unknown {
  if (method === 'item/commandExecution/requestApproval') {
    if (decision === 'reject') return { decision: 'decline' };
    if (decision === 'approve-session') {
      if ((params?.availableDecisions ?? []).includes('acceptForSession')) return { decision: 'acceptForSession' };
      if (params?.proposedExecpolicyAmendment) {
        return { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } } };
      }
    }
    return { decision: 'accept' };
  }
  if (method === 'item/fileChange/requestApproval') {
    return { decision: decision === 'reject' ? 'decline' : decision === 'approve-session' ? 'acceptForSession' : 'accept' };
  }
  if (method === 'item/permissions/requestApproval') {
    const req = decision === 'reject' ? {} : {
      network: params?.permissions?.network ?? undefined,
      fileSystem: params?.permissions?.fileSystem ?? undefined,
    };
    return { permissions: req, scope: decision === 'approve-session' ? 'session' : 'turn', strictAutoReview: decision === 'reject' };
  }
  return { decision: decision === 'reject' ? 'denied' : decision === 'approve-session' ? 'approved_for_session' : 'approved' };
}

function codexQuestionMessage(method: string, requestId: string, params: any): Extract<AgentMessage, { type: 'question-request' }> {
  if (method === 'mcpServer/elicitation/request') {
    return {
      type: 'question-request',
      requestId,
      questions: mcpElicitationQuestions(params),
    };
  }
  return {
    type: 'question-request',
    requestId,
    questions: (params?.questions ?? []).map((q: any) => ({
      question: String(q?.question ?? ''),
      header: q?.header ? String(q.header) : undefined,
      options: (q?.options ?? []).map((o: any) => ({
        label: String(o?.label ?? o?.value ?? o),
        description: o?.description ? String(o.description) : undefined,
      })),
      multiple: Boolean(q?.multiple ?? q?.isMultiple),
    })),
  };
}

function mcpElicitationQuestions(params: any): { question: string; header?: string; options: { label: string; description?: string }[]; multiple?: boolean }[] {
  const header = params?.serverName ? `MCP: ${params.serverName}` : 'MCP request';
  if (params?.mode === 'url') {
    return [{
      header,
      question: [params?.message, params?.url].filter(Boolean).join('\n'),
      options: [{ label: 'Accept' }, { label: 'Decline' }],
    }];
  }
  const props = params?.requestedSchema?.properties;
  if (!props || typeof props !== 'object') {
    return [{ header, question: String(params?.message ?? 'Input requested'), options: [] }];
  }
  return Object.entries(props).map(([key, schema]: [string, any]) => ({
    header,
    question: [schema?.title ?? key, schema?.description].filter(Boolean).join('\n'),
    options: mcpOptions(schema),
    multiple: schema?.type === 'array',
  }));
}

function mcpOptions(schema: any): { label: string; description?: string }[] {
  if (Array.isArray(schema?.oneOf)) {
    return schema.oneOf
      .map((o: any) => ({ label: String(o?.const ?? o?.title ?? ''), description: o?.title ? String(o.title) : undefined }))
      .filter((o: { label: string }) => o.label);
  }
  if (Array.isArray(schema?.enum)) return schema.enum.map((v: any) => ({ label: String(v) }));
  if (Array.isArray(schema?.items?.enum)) return schema.items.enum.map((v: any) => ({ label: String(v) }));
  if (schema?.type === 'boolean') return [{ label: 'true' }, { label: 'false' }];
  return [];
}

function mcpElicitationResponse(params: any, answers: string[][]): unknown {
  if (params?.mode === 'url') {
    const answer = String(answers?.[0]?.[0] ?? '').toLowerCase();
    return { action: answer.startsWith('decline') ? 'decline' : 'accept', content: null, _meta: null };
  }
  const props = params?.requestedSchema?.properties;
  if (!props || typeof props !== 'object') return { action: 'accept', content: {}, _meta: null };
  const content: Record<string, unknown> = {};
  let i = 0;
  for (const [key, schema] of Object.entries(props) as [string, any][]) {
    const vals = answers?.[i++] ?? [];
    content[key] = mcpValue(schema, vals);
  }
  return { action: 'accept', content, _meta: null };
}

function mcpValue(schema: any, vals: string[]): unknown {
  if (schema?.type === 'array') return vals;
  const raw = vals[0] ?? schema?.default ?? '';
  if (schema?.type === 'boolean') return /^(true|yes|y|1|accept)$/i.test(String(raw));
  if (schema?.type === 'number' || schema?.type === 'integer') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

function compactText(v: unknown): string {
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').slice(0, 220);
  if (v && typeof v === 'object') {
    const msg = (v as any).message ?? (v as any).description ?? (v as any).error;
    if (msg) return String(msg).replace(/\s+/g, ' ').slice(0, 220);
  }
  return safeStringify(v).replace(/\s+/g, ' ').slice(0, 220);
}

function codexGoalMessage(goal: any): AgentMessage | null {
  if (!goal || typeof goal !== 'object') return null;
  const status = codexGoalStatus(goal.status);
  if (!status) return null;
  const threadId = goal.threadId ? String(goal.threadId) : undefined;
  const title = compactText(goal.objective ?? '');
  return {
    type: 'goal-state',
    key: threadId,
    title: title || undefined,
    status,
    startedAt: timestampToMs(goal.createdAt),
    elapsedMs: typeof goal.timeUsedSeconds === 'number' ? Math.max(0, goal.timeUsedSeconds * 1000) : undefined,
    detail: codexGoalDetail(goal),
  };
}

function codexGoalStatus(status: unknown): Extract<AgentMessage, { type: 'goal-state' }>['status'] | null {
  switch (status) {
    case 'active':
      return 'active';
    case 'complete':
    case 'completed': // rollout event_msg spells it "completed"; live notifications use "complete"
      return 'done';
    case 'blocked':
      return 'blocked';
    case 'paused':
      return 'paused';
    case 'usageLimited':
    case 'budgetLimited':
      return 'blocked';
    default:
      return null;
  }
}

function codexGoalDetail(goal: any): string | undefined {
  const parts: string[] = [];
  if (goal?.status === 'usageLimited') parts.push('Usage limited');
  if (goal?.status === 'budgetLimited') parts.push('Budget limited');
  if (typeof goal?.tokensUsed === 'number' && typeof goal?.tokenBudget === 'number') {
    parts.push(`${goal.tokensUsed}/${goal.tokenBudget} tokens`);
  } else if (typeof goal?.tokensUsed === 'number' && goal.tokensUsed > 0) {
    parts.push(`${goal.tokensUsed} tokens`);
  }
  return parts.join(' · ') || undefined;
}

function timestampToMs(v: unknown): number | undefined {
  if (typeof v === 'string' && v.trim()) {
    const numeric = Number(v);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return v < 1_000_000_000_000 ? v * 1000 : v;
}

// ── small helpers ───────────────────────────────────────────────────────────

function reasoningText(p: any): string {
  const c = p?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x: any) => (typeof x === 'string' ? x : x?.text ?? '')).join('').trim();
  if (typeof p?.summary === 'string') return p.summary;
  if (Array.isArray(p?.summary)) return p.summary.map((x: any) => (typeof x === 'string' ? x : x?.text ?? '')).join('').trim();
  return '';
}

function parseArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v ?? '');
  } catch {
    return String(v ?? '');
  }
}

/** Recursively find rollout-*.jsonl files under the date-nested sessions tree. */
function findRollouts(root: string): string[] {
  const out: string[] = [];
  try {
    for (const entry of readdirSync(root, { recursive: true }) as string[]) {
      const name = basename(entry);
      if (name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push(join(root, entry));
    }
  } catch {
    /* unreadable */
  }
  return out;
}

/** The session_meta object (rollout line 1) — has the authoritative cwd + id. Bounded read so a
 *  large `base_instructions` field doesn't force reading the whole file per session at discovery. */
function readSessionMeta(path: string): any | undefined {
  const first = readFirstLine(path, 512 * 1024);
  if (!first) return undefined;
  try {
    const obj = JSON.parse(first);
    return obj?.type === 'session_meta' ? obj.payload ?? obj : undefined;
  } catch {
    return undefined;
  }
}

/** Known agent-driven/probe originators observed on this machine's rollouts — sessions a PROGRAM
 *  started, so they fall under the hide-auto default even though their thread_source says 'user'
 *  or 'vscode' ('Claude Code' = MCP-spawned codex runs; cosyncing-* and cosyncing-* = our probe harnesses). */
const AUTO_ORIGINATORS = new Set(['Claude Code']);

/** Classify how a rollout came to exist (issues-part3 subagent-display D2: hide AUTO sessions by
 *  default, show human-initiated ones). Discovery TAGS sessions with this instead of dropping them —
 *  the app filters by origin (subagent+exec hidden by default, vscode shown, toggles in Settings).
 *  Hiding requires POSITIVE evidence of automation — an UNKNOWN originator (say a Cursor-style
 *  codex front-end we have never seen) fails OPEN to displayed, because silently hiding a human's
 *  sessions is worse than showing an automated one (maintainer, 2026-07-15).
 *  Shapes verified on maintainer's 646 real rollouts (2026-07-15):
 *   - subagent: `thread_source:'subagent'` + top-level `parent_thread_id` (current), or the old
 *     `source.subagent.thread_spawn.parent_thread_id` object shape (2026-03 era);
 *   - exec:     `originator:'codex_exec'`, `thread_source:'exec'`, or a KNOWN agent/probe
 *     originator ({@link AUTO_ORIGINATORS} + our 'cosyncing-*' / 'cosyncing-*' harnesses);
 *   - vscode:   `originator:'codex_vscode'`;
 *   - undefined (displayed): human surfaces (codex-tui / codex_cli_rs / the app's 'cosyncing')
 *     AND any unrecognized front-end. */
export function codexSessionOrigin(meta: any): { origin?: 'subagent' | 'exec' | 'vscode'; parentThreadId?: string } {
  if (!meta || typeof meta !== 'object') return {};
  if (meta.thread_source === 'subagent' || meta.source?.subagent) {
    const parent = meta.parent_thread_id ?? meta.source?.subagent?.thread_spawn?.parent_thread_id;
    return { origin: 'subagent', ...(parent ? { parentThreadId: String(parent) } : {}) };
  }
  const originator = typeof meta.originator === 'string' ? meta.originator : '';
  if (originator === 'codex_exec' || meta.thread_source === 'exec') return { origin: 'exec' };
  if (originator === 'codex_vscode') return { origin: 'vscode' };
  if (AUTO_ORIGINATORS.has(originator) || originator.startsWith('cosyncing-') || originator.startsWith('cosyncing-')) return { origin: 'exec' };
  return {};
}

/** Drive reason for a child thread the parent agent owns. Single-sourced: the roster/attach control
 *  state advertises it and {@link CodexAdapter.attach} refuses with it. */
const CODEX_AGENT_OWNED_DRIVE_REASON =
  'This Codex thread is owned by the agent that spawned it; its parent session is where work happens.';

/** Terminal-sync reason for the same ownership fact — a JOIN is not a read-only affordance: it loads
 *  the child thread into the managed app-server daemon, i.e. the very live surface Drive is refused
 *  for. Composed from {@link CODEX_AGENT_OWNED_DRIVE_REASON} so the ownership sentence stays single-
 *  sourced (one string to change, and the roster/attach/refusal copy can never drift apart). */
const CODEX_AGENT_OWNED_SYNC_REASON =
  `Terminal sync is unavailable here: joining would load the thread into the shared Codex daemon. ${CODEX_AGENT_OWNED_DRIVE_REASON}`;

/** A subagent rollout is a CHILD thread whose only writer is the parent agent's run — there is no
 *  owner for a second driver to talk to, so Drive is a capability the session does not have (not a
 *  contended-ownership fact that could clear later). Tag-not-drop is unchanged: these stay listed and
 *  readable in Observe, including the orphan rows the roster surfaces past the origin filter. */
function codexAgentOwned(origin: ReturnType<typeof codexSessionOrigin>['origin']): boolean {
  return origin === 'subagent';
}

/** id → thread_name from ~/.codex/session_index.jsonl (best-effort; the index lacks cwd). */
function readSessionIndexTitles(): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(SESSION_INDEX)) return m;
  try {
    for (const line of readFileText(SESSION_INDEX).split('\n')) {
      if (!line) continue;
      const o = JSON.parse(line);
      if (o?.id && o?.thread_name) m.set(String(o.id), String(o.thread_name));
    }
  } catch {
    /* index unreadable */
  }
  return m;
}

const rolloutUuid = (path: string): string => basename(path).replace(/^rollout-.*?-([0-9a-f-]+)\.jsonl$/i, '$1');

export type RolloutStatusFallbackReason =
  | 'source-limit'
  | 'time-limit'
  | 'record-limit'
  | 'source-changed';

/** Maximum distinct terminal turn ids retained while a cold reverse scan searches for the newest
 * unmatched start. Exceeding it is a typed bounded fallback, never an unbounded identity set. */
export const ROLLOUT_STATUS_TERMINAL_ID_LIMIT = 4096;

export type RolloutStatusInference =
  | { kind: 'authority'; status: 'working' | 'idle'; scannedBytes: number }
  | {
      kind: 'fallback';
      status: 'working' | 'idle';
      reason: RolloutStatusFallbackReason;
      scannedBytes: number;
    };

/** Test-only seams for deterministic admission and source-race coverage. */
export interface RolloutStatusScanOptions {
  maxSourceBytes?: number;
  maxElapsedMs?: number;
  beforeValidation?: () => void;
}

export async function inferRolloutStatus(path: string, st = statSafe(path)): Promise<SessionInfo['status']> {
  return (await inferRolloutRawStatus(path, st)).status;
}

export async function inferRolloutStatusResult(
  path: string,
  options?: RolloutStatusScanOptions,
): Promise<RolloutStatusInference> {
  return inferRolloutRawStatus(path, statSafe(path), options);
}

type RolloutAuthorityStat = {
  size: number;
  mtimeMs: number;
  dev?: number | bigint;
  ino?: number | bigint;
};

interface RolloutTaskAuthorityEntry {
  sourceKey: string;
  /** Validated source EOF used for append/replacement fencing. */
  size: number;
  /** Forward cursor through that source; may lag `size` after a bounded scan. */
  processedSize: number;
  prefixLength: number;
  prefixHash: string;
  boundaryLength: number;
  boundaryHash: string;
  status: 'working' | 'idle';
  /** Exact unmatched native task_started retained across incremental scans. */
  activeTurnId?: string;
  resolution: 'authority' | 'fallback';
  fallbackReason?: RolloutStatusFallbackReason;
  tail: RolloutAuthorityTail;
  /** Latest exact marker in the processed prefix, published only after catch-up reaches EOF. */
  candidateStatus: 'working' | 'idle';
  candidateActiveTurnId?: string;
  candidateAuthoritative: boolean;
}

type RolloutAuthorityTail =
  | { kind: 'complete' }
  | { kind: 'partial'; start: number }
  | { kind: 'opaque' };

const rolloutTaskAuthorityCache = new Map<string, RolloutTaskAuthorityEntry>();

/** The rollout's persistent exact task authority.
 *
 * A cooperative reverse scan recovers the latest marker on cold discovery. Once observed, the
 * cache advances to the observed EOF with bounded framing state and retains an unmatched
 * task_started across arbitrarily many appended progress records. Cold and incremental work yield
 * after every 128 KiB and admit at most 64 MiB/250 ms per call; exceeding a source, time, or record
 * bound returns a typed fallback. A source change racing an admitted incremental scan rejects the
 * candidate but keeps the published status until a settled pass. Truncation, atomic replacement,
 * or sampled-prefix/boundary mismatch resets authority before re-seeding. */
async function inferRolloutRawStatus(
  path: string,
  st: RolloutAuthorityStat | undefined = statSafe(path),
  options?: RolloutStatusScanOptions,
): Promise<RolloutStatusInference> {
  if (!st || st.size <= 0) {
    rolloutTaskAuthorityCache.delete(path);
    return { kind: 'authority', status: 'idle', scannedBytes: 0 };
  }
  const cached = rolloutTaskAuthorityCache.get(path);
  if (cached && rolloutAuthorityAppendCompatible(path, st, cached)) {
    if (st.size > cached.size || cached.processedSize < st.size) {
      const advanced = await scanRolloutAuthorityRange(path, st, cached, options);
      if (advanced.reason === 'source-changed') {
        // The admitted prefix was still valid when this scan started, so only the racing
        // candidate is rejected; the published authority stands until the settled follow-up
        // re-validates the source or append incompatibility forces a reseed.
        return {
          kind: 'fallback',
          status: cached.status,
          reason: advanced.reason,
          scannedBytes: advanced.scannedBytes,
        };
      }
      cached.status = advanced.status;
      cached.activeTurnId = advanced.activeTurnId;
      cached.size = st.size;
      cached.processedSize = advanced.processedThrough;
      cached.tail = advanced.tail;
      cached.candidateStatus = advanced.candidateStatus;
      cached.candidateActiveTurnId = advanced.candidateActiveTurnId;
      cached.candidateAuthoritative = advanced.candidateAuthoritative;
      cached.resolution = advanced.kind;
      cached.fallbackReason = advanced.kind === 'fallback' ? advanced.reason : undefined;
      refreshRolloutAuthoritySamples(path, st, cached);
      rememberRolloutTaskAuthority(path, cached);
      return advanced.kind === 'authority'
        ? { kind: 'authority', status: advanced.status, scannedBytes: advanced.scannedBytes }
        : {
            kind: 'fallback',
            status: advanced.status,
            reason: advanced.reason,
            scannedBytes: advanced.scannedBytes,
          };
    }
    rememberRolloutTaskAuthority(path, cached);
    return cached.resolution === 'authority'
      ? { kind: 'authority', status: cached.status, scannedBytes: 0 }
      : {
          kind: 'fallback',
          status: cached.status,
          reason: cached.fallbackReason ?? 'source-limit',
          scannedBytes: 0,
        };
  }

  const recovered = await scanRolloutColdStatus(path, st, options);
  if (recovered.reason === 'source-changed') {
    return {
      kind: 'fallback',
      status: 'idle',
      reason: recovered.reason,
      scannedBytes: recovered.scannedBytes,
    };
  }
  const entry: RolloutTaskAuthorityEntry = {
    sourceKey: rolloutAuthoritySourceKey(st),
    size: st.size,
    processedSize: st.size,
    prefixLength: 0,
    prefixHash: '',
    boundaryLength: 0,
    boundaryHash: '',
    status: recovered.status,
    activeTurnId: recovered.activeTurnId,
    resolution: recovered.kind,
    ...(recovered.kind === 'fallback' ? { fallbackReason: recovered.reason } : {}),
    tail: recovered.tail ?? (recovered.kind === 'authority'
      ? recovered.scannedThrough === st.size
        ? { kind: 'complete' }
        : { kind: 'partial', start: recovered.scannedThrough }
      : { kind: 'opaque' }),
    candidateStatus: recovered.status,
    candidateActiveTurnId: recovered.activeTurnId,
    candidateAuthoritative: recovered.kind === 'authority',
  };
  refreshRolloutAuthoritySamples(path, st, entry);
  rememberRolloutTaskAuthority(path, entry);
  return recovered;
}

/** Exact active task retained by the bounded rollout authority. `turn_context` deliberately does
 * not participate: it can persist settings for an idle thread. A typed catch-up fallback may keep
 * a previously validated active id, but can never invent one. */
async function exactActiveRolloutTurnId(path: string): Promise<string | undefined> {
  const inferred = await inferRolloutRawStatus(path);
  if (inferred.status !== 'working') return undefined;
  return rolloutTaskAuthorityCache.get(path)?.activeTurnId;
}

type RolloutColdScan =
  | {
      kind: 'authority';
      status: 'working' | 'idle';
      scannedThrough: number;
      scannedBytes: number;
      activeTurnId?: string;
      tail?: RolloutAuthorityTail;
      reason?: undefined;
    }
  | {
      kind: 'fallback';
      status: 'idle';
      reason: RolloutStatusFallbackReason;
      scannedThrough: number;
      scannedBytes: number;
      activeTurnId?: string;
      tail?: RolloutAuthorityTail;
    };

async function scanRolloutColdStatus(
  path: string,
  st: RolloutAuthorityStat,
  options: RolloutStatusScanOptions = {},
): Promise<RolloutColdScan> {
  const maxSourceBytes = Math.max(
    ROLLOUT_STATUS_CHUNK_BYTES,
    options.maxSourceBytes ?? ROLLOUT_STATUS_MAX_SOURCE_BYTES,
  );
  const deadline = Date.now() + Math.max(1, options.maxElapsedMs ?? ROLLOUT_STATUS_MAX_ELAPSED_MS);
  let fd: number | undefined;
  let scannedBytes = 0;
  let scannedThrough: number | undefined;
  let result: RolloutColdScan | undefined;
  const terminalTurnIds = new Set<string>();
  const applyMarker = (marker: RolloutTaskMarker | undefined): 'resolved' | 'continue' | 'overflow' => {
    if (!marker) return 'continue';
    if (marker.kind === 'terminal') {
      terminalTurnIds.add(marker.turnId);
      return terminalTurnIds.size > ROLLOUT_STATUS_TERMINAL_ID_LIMIT ? 'overflow' : 'continue';
    }
    // Turns are serial within one rollout. The first start reached while scanning backwards is the
    // newest lifecycle boundary: if a later matching terminal was already seen, that newest turn is
    // closed and no older orphaned start may resurrect Working. A later terminal for some OTHER turn
    // remains stale evidence, so the newest unmatched start still owns Working.
    if (terminalTurnIds.has(marker.turnId)) {
      result = {
        kind: 'authority',
        status: 'idle',
        scannedThrough: scannedThrough ?? 0,
        scannedBytes,
      };
      return 'resolved';
    }
    result = {
      kind: 'authority',
      status: 'working',
      activeTurnId: marker.turnId,
      scannedThrough: scannedThrough ?? 0,
      scannedBytes,
    };
    return 'resolved';
  };
  try {
    fd = openSync(path, 'r');
    const opened = fstatSync(fd);
    if (!rolloutAuthorityStatMatches(st, opened)) {
      return { kind: 'fallback', status: 'idle', reason: 'source-changed', scannedThrough: st.size, scannedBytes };
    }
    const guard = rolloutAuthorityGuardFromFd(fd, opened);
    const last = Buffer.alloc(1);
    if (readSync(fd, last, 0, 1, st.size - 1) !== 1) {
      return { kind: 'fallback', status: 'idle', reason: 'source-changed', scannedThrough: st.size, scannedBytes };
    }
    if (last[0] === 0x0a) scannedThrough = st.size;

    let pos = st.size;
    let suffix: Buffer = Buffer.alloc(0);
    scan: while (pos > 0) {
      if (scannedBytes >= maxSourceBytes) {
        result = { kind: 'fallback', status: 'idle', reason: 'source-limit', scannedThrough: st.size, scannedBytes };
        break;
      }
      if (Date.now() > deadline) {
        result = { kind: 'fallback', status: 'idle', reason: 'time-limit', scannedThrough: st.size, scannedBytes };
        break;
      }
      const len = Math.min(ROLLOUT_STATUS_CHUNK_BYTES, pos, maxSourceBytes - scannedBytes);
      pos -= len;
      const chunk = Buffer.alloc(len);
      if (readSync(fd, chunk, 0, len, pos) !== len) {
        result = { kind: 'fallback', status: 'idle', reason: 'source-changed', scannedThrough: st.size, scannedBytes };
        break;
      }
      scannedBytes += len;
      const newlineOffsets: number[] = [];
      for (let offset = chunk.indexOf(0x0a); offset >= 0; offset = chunk.indexOf(0x0a, offset + 1)) {
        newlineOffsets.push(offset);
      }
      if (scannedThrough === undefined && newlineOffsets.length > 0) {
        scannedThrough = pos + newlineOffsets.at(-1)! + 1;
      }
      if (newlineOffsets.length === 0) {
        if (chunk.length + suffix.length > ROLLOUT_STATUS_MAX_RECORD_BYTES) {
          result = { kind: 'fallback', status: 'idle', reason: 'record-limit', scannedThrough: st.size, scannedBytes };
          break;
        }
        suffix = Buffer.concat([chunk, suffix], chunk.length + suffix.length);
        await yieldToEventLoop();
        continue;
      }

      let right = chunk.length;
      for (let i = newlineOffsets.length - 1; i >= 0; i--) {
        const left = newlineOffsets[i]! + 1;
        const fragment = chunk.subarray(left, right);
        const recordLength = fragment.length + suffix.length;
        if (recordLength > ROLLOUT_STATUS_MAX_RECORD_BYTES) {
          result = { kind: 'fallback', status: 'idle', reason: 'record-limit', scannedThrough: st.size, scannedBytes };
          break scan;
        }
        const record = suffix.length > 0
          ? Buffer.concat([fragment, suffix], recordLength)
          : fragment;
        const markerResult = applyMarker(rolloutTaskMarker(record.toString('utf8')));
        if (markerResult === 'resolved') break scan;
        if (markerResult === 'overflow') {
          result = { kind: 'fallback', status: 'idle', reason: 'record-limit', scannedThrough: st.size, scannedBytes };
          break scan;
        }
        suffix = Buffer.alloc(0);
        right = newlineOffsets[i]!;
      }
      suffix = chunk.subarray(0, right);
      if (suffix.length > ROLLOUT_STATUS_MAX_RECORD_BYTES) {
        result = { kind: 'fallback', status: 'idle', reason: 'record-limit', scannedThrough: st.size, scannedBytes };
        break;
      }
      await yieldToEventLoop();
    }
    if (!result) {
      const markerResult = applyMarker(rolloutTaskMarker(suffix.toString('utf8')));
      if (markerResult === 'overflow') {
        result = { kind: 'fallback', status: 'idle', reason: 'record-limit', scannedThrough: st.size, scannedBytes };
      }
    }
    if (!result) {
      result = {
        kind: 'authority',
        status: 'idle',
        scannedThrough: scannedThrough ?? 0,
        scannedBytes,
      };
    }
    options.beforeValidation?.();
    if (!rolloutAuthorityGuardStillMatches(path, fd, guard)) {
      return { kind: 'fallback', status: 'idle', reason: 'source-changed', scannedThrough: st.size, scannedBytes };
    }
    return {
      ...result,
      tail: last[0] === 0x0a
        ? { kind: 'complete' }
        : result.kind === 'authority'
          ? { kind: 'partial', start: result.scannedThrough }
          : { kind: 'opaque' },
    };
  } catch {
    return { kind: 'fallback', status: 'idle', reason: 'source-changed', scannedThrough: st.size, scannedBytes };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

type RolloutRangeScan =
  | {
      kind: 'authority';
      status: 'working' | 'idle';
      tail: RolloutAuthorityTail;
      scannedBytes: number;
      processedThrough: number;
      candidateStatus: 'working' | 'idle';
      activeTurnId?: string;
      candidateActiveTurnId?: string;
      candidateAuthoritative: boolean;
      reason?: undefined;
    }
  | {
      kind: 'fallback';
      status: 'working' | 'idle';
      reason: RolloutStatusFallbackReason;
      tail: RolloutAuthorityTail;
      scannedBytes: number;
      processedThrough: number;
      candidateStatus: 'working' | 'idle';
      activeTurnId?: string;
      candidateActiveTurnId?: string;
      candidateAuthoritative: boolean;
    };

/** Cooperatively advance an admitted source without ever revisiting an unbounded suffix.
 *
 * Observed EOF and processed position advance independently. A bounded partial record is represented
 * by its start offset and may be reread once; an oversized tail stays opaque across calls until a
 * newline. Exact candidates are retained while catching up but published only at validated EOF. */
async function scanRolloutAuthorityRange(
  path: string,
  st: RolloutAuthorityStat,
  cached: RolloutTaskAuthorityEntry,
  options: RolloutStatusScanOptions = {},
): Promise<RolloutRangeScan> {
  const maxSourceBytes = Math.max(
    ROLLOUT_STATUS_CHUNK_BYTES,
    options.maxSourceBytes ?? ROLLOUT_STATUS_MAX_SOURCE_BYTES,
  );
  const deadline = Date.now() + Math.max(1, options.maxElapsedMs ?? ROLLOUT_STATUS_MAX_ELAPSED_MS);
  const initialStatus = cached.status;
  let candidateStatus = cached.candidateStatus;
  let candidateActiveTurnId = cached.candidateActiveTurnId;
  let candidateAuthoritative = cached.candidateAuthoritative;
  let fallbackReason = cached.fallbackReason;
  let scannedBytes = 0;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const opened = fstatSync(fd);
    if (!rolloutAuthorityStatMatches(st, opened)) {
      return {
        kind: 'fallback', status: cached.status, activeTurnId: cached.activeTurnId,
        reason: 'source-changed', tail: cached.tail, scannedBytes,
        processedThrough: cached.processedSize, candidateStatus,
        candidateActiveTurnId, candidateAuthoritative,
      };
    }
    const guard = rolloutAuthorityGuardFromFd(fd, opened);
    const start = cached.tail.kind === 'partial' ? cached.tail.start : cached.processedSize;
    let pos = start;
    let fragments: Buffer[] = [];
    let fragmentBytes = 0;
    let skippingOversized = cached.tail.kind === 'opaque';
    let boundedReason: RolloutStatusFallbackReason | undefined;

    while (pos < st.size) {
      if (scannedBytes >= maxSourceBytes) {
        boundedReason = 'source-limit';
        break;
      }
      if (Date.now() > deadline) {
        boundedReason = 'time-limit';
        break;
      }
      const len = Math.min(
        ROLLOUT_STATUS_CHUNK_BYTES,
        st.size - pos,
        maxSourceBytes - scannedBytes,
      );
      const chunk = Buffer.alloc(len);
      if (readSync(fd, chunk, 0, len, pos) !== len) {
        boundedReason = 'source-changed';
        break;
      }
      scannedBytes += len;
      let segmentStart = 0;
      for (let newline = chunk.indexOf(0x0a); newline >= 0; newline = chunk.indexOf(0x0a, newline + 1)) {
        const fragment = chunk.subarray(segmentStart, newline);
        if (skippingOversized) {
          skippingOversized = false;
        } else if (fragmentBytes + fragment.length <= ROLLOUT_STATUS_MAX_RECORD_BYTES) {
          const recordLength = fragmentBytes + fragment.length;
          const record = fragments.length > 0
            ? Buffer.concat([...fragments, fragment], recordLength)
            : fragment;
          const marker = rolloutTaskMarker(record.toString('utf8'));
          if (marker?.kind === 'start') {
            candidateStatus = 'working';
            candidateActiveTurnId = marker.turnId;
            candidateAuthoritative = true;
          } else if (
            marker?.kind === 'terminal'
            && candidateActiveTurnId === marker.turnId
          ) {
            candidateStatus = 'idle';
            candidateActiveTurnId = undefined;
            candidateAuthoritative = true;
          }
        }
        fragments = [];
        fragmentBytes = 0;
        segmentStart = newline + 1;
      }
      const trailing = chunk.subarray(segmentStart);
      if (!skippingOversized && trailing.length > 0) {
        if (fragmentBytes + trailing.length > ROLLOUT_STATUS_MAX_RECORD_BYTES) {
          fragments = [];
          fragmentBytes = 0;
          skippingOversized = true;
          fallbackReason = 'record-limit';
          // Nothing before an opaque record is necessarily the latest marker.
          candidateStatus = initialStatus;
          candidateActiveTurnId = cached.activeTurnId;
          candidateAuthoritative = false;
        } else {
          fragments.push(trailing);
          fragmentBytes += trailing.length;
        }
      }
      pos += len;
      await yieldToEventLoop();
    }

    if (!boundedReason && !skippingOversized && fragmentBytes > 0) {
      const trailing = rolloutTaskMarker(Buffer.concat(fragments, fragmentBytes).toString('utf8'));
      if (trailing?.kind === 'start') {
        candidateStatus = 'working';
        candidateActiveTurnId = trailing.turnId;
        candidateAuthoritative = true;
      } else if (
        trailing?.kind === 'terminal'
        && candidateActiveTurnId === trailing.turnId
      ) {
        candidateStatus = 'idle';
        candidateActiveTurnId = undefined;
        candidateAuthoritative = true;
      }
    }

    let tail: RolloutAuthorityTail;
    if (skippingOversized) tail = { kind: 'opaque' };
    else if (fragmentBytes > 0) tail = { kind: 'partial', start: pos - fragmentBytes };
    else tail = { kind: 'complete' };
    if (boundedReason) fallbackReason = boundedReason;
    else if (skippingOversized) fallbackReason = 'record-limit';

    options.beforeValidation?.();
    if (!rolloutAuthorityGuardStillMatches(path, fd, guard)) {
      return {
        kind: 'fallback', status: cached.status, activeTurnId: cached.activeTurnId,
        reason: 'source-changed', tail: cached.tail, scannedBytes,
        processedThrough: cached.processedSize, candidateStatus: cached.candidateStatus,
        candidateActiveTurnId: cached.candidateActiveTurnId,
        candidateAuthoritative: cached.candidateAuthoritative,
      };
    }
    const caughtUp = !boundedReason && pos === st.size;
    if (caughtUp && candidateAuthoritative && !skippingOversized) {
      return {
        kind: 'authority',
        status: candidateStatus,
        activeTurnId: candidateActiveTurnId,
        tail,
        scannedBytes,
        processedThrough: pos,
        candidateStatus,
        candidateActiveTurnId,
        candidateAuthoritative,
      };
    }
    return {
      kind: 'fallback',
      status: initialStatus,
      activeTurnId: cached.activeTurnId,
      reason: fallbackReason ?? 'record-limit',
      tail,
      scannedBytes,
      processedThrough: pos,
      candidateStatus,
      candidateActiveTurnId,
      candidateAuthoritative,
    };
  } catch {
    return {
      kind: 'fallback', status: cached.status, activeTurnId: cached.activeTurnId,
      reason: 'source-changed', tail: cached.tail, scannedBytes,
      processedThrough: cached.processedSize, candidateStatus: cached.candidateStatus,
      candidateActiveTurnId: cached.candidateActiveTurnId,
      candidateAuthoritative: cached.candidateAuthoritative,
    };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function rolloutAuthoritySourceKey(st: RolloutAuthorityStat): string {
  return `${String(st.dev ?? 'unknown')}:${String(st.ino ?? 'unknown')}`;
}

interface RolloutAuthorityGuard {
  sourceKey: string;
  size: number;
  mtimeMs: number;
  prefixLength: number;
  prefixHash: string;
  boundaryLength: number;
  boundaryHash: string;
}

function rolloutAuthorityFdRangeHash(fd: number, offset: number, length: number): string {
  if (length <= 0) return '';
  const bytes = Buffer.alloc(length);
  const read = readSync(fd, bytes, 0, length, offset);
  return createHash('sha256').update(bytes.subarray(0, read)).digest('hex');
}

function rolloutAuthorityStatMatches(expected: RolloutAuthorityStat, actual: RolloutAuthorityStat): boolean {
  return expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && rolloutAuthoritySourceKey(expected) === rolloutAuthoritySourceKey(actual);
}

function rolloutAuthorityGuardFromFd(fd: number, st: RolloutAuthorityStat): RolloutAuthorityGuard {
  const prefixLength = Math.min(ROLLOUT_AUTHORITY_SAMPLE_BYTES, st.size);
  const boundaryLength = Math.min(ROLLOUT_AUTHORITY_SAMPLE_BYTES, st.size);
  return {
    sourceKey: rolloutAuthoritySourceKey(st),
    size: st.size,
    mtimeMs: st.mtimeMs,
    prefixLength,
    prefixHash: rolloutAuthorityFdRangeHash(fd, 0, prefixLength),
    boundaryLength,
    boundaryHash: rolloutAuthorityFdRangeHash(fd, st.size - boundaryLength, boundaryLength),
  };
}

function rolloutAuthorityGuardStillMatches(
  path: string,
  fd: number,
  guard: RolloutAuthorityGuard,
): boolean {
  const opened = fstatSync(fd);
  const current = statSafe(path);
  const matchesGuard = (candidate: RolloutAuthorityStat): boolean =>
    candidate.size === guard.size
    && candidate.mtimeMs === guard.mtimeMs
    && rolloutAuthoritySourceKey(candidate) === guard.sourceKey;
  if (!current || !matchesGuard(opened) || !matchesGuard(current)) {
    return false;
  }
  return rolloutAuthorityFdRangeHash(fd, 0, guard.prefixLength) === guard.prefixHash
    && rolloutAuthorityFdRangeHash(
      fd,
      guard.size - guard.boundaryLength,
      guard.boundaryLength,
    ) === guard.boundaryHash
    && rolloutAuthorityRangeHash(path, 0, guard.prefixLength) === guard.prefixHash
    && rolloutAuthorityRangeHash(
      path,
      guard.size - guard.boundaryLength,
      guard.boundaryLength,
    ) === guard.boundaryHash;
}

function rolloutAuthorityRangeHash(path: string, offset: number, length: number): string {
  if (length <= 0) return '';
  try {
    return createHash('sha256').update(readBytesFrom(path, offset, length)).digest('hex');
  } catch {
    return '';
  }
}

function rolloutAuthorityAppendCompatible(
  path: string,
  st: RolloutAuthorityStat,
  entry: RolloutTaskAuthorityEntry,
): boolean {
  if (st.size < entry.size || rolloutAuthoritySourceKey(st) !== entry.sourceKey) return false;
  if (
    entry.prefixLength > 0 &&
    rolloutAuthorityRangeHash(path, 0, entry.prefixLength) !== entry.prefixHash
  ) return false;
  if (
    entry.boundaryLength > 0 &&
    rolloutAuthorityRangeHash(path, entry.size - entry.boundaryLength, entry.boundaryLength) !== entry.boundaryHash
  ) return false;
  return true;
}

function refreshRolloutAuthoritySamples(
  path: string,
  st: RolloutAuthorityStat,
  entry: RolloutTaskAuthorityEntry,
): void {
  entry.sourceKey = rolloutAuthoritySourceKey(st);
  entry.prefixLength = Math.min(ROLLOUT_AUTHORITY_SAMPLE_BYTES, st.size);
  entry.prefixHash = rolloutAuthorityRangeHash(path, 0, entry.prefixLength);
  entry.boundaryLength = Math.min(ROLLOUT_AUTHORITY_SAMPLE_BYTES, entry.size);
  entry.boundaryHash = rolloutAuthorityRangeHash(path, entry.size - entry.boundaryLength, entry.boundaryLength);
}

function rememberRolloutTaskAuthority(path: string, entry: RolloutTaskAuthorityEntry): void {
  rolloutTaskAuthorityCache.delete(path);
  if (rolloutTaskAuthorityCache.size >= ROLLOUT_AUTHORITY_CACHE_MAX) {
    const idle = [...rolloutTaskAuthorityCache].find(([, candidate]) => candidate.status === 'idle');
    const evict = idle?.[0] ?? rolloutTaskAuthorityCache.keys().next().value;
    if (typeof evict === 'string') rolloutTaskAuthorityCache.delete(evict);
  }
  rolloutTaskAuthorityCache.set(path, entry);
}

/** Stat-validated per-rollout discovery memo (2026-07-03 perf must-fix): meta + surface + raw status
 * only change when the file does. Cold status recovery is cooperative and admission-bounded; an
 * unchanged rollout costs one stat. The cache is dropped wholesale past a soft cap so deleted
 * sessions cannot accumulate forever. */
interface RolloutFacts {
  size: number;
  mtimeMs: number;
  meta: any | undefined;
  surface: CodexSessionSurface;
  launchSurface: SessionLaunchSurface;
  rawStatus: 'working' | 'idle';
}
const ROLLOUT_FACTS_MAX = 8192;
const rolloutFactsCache = new Map<string, RolloutFacts>();
async function rolloutFacts(path: string, st: { size: number; mtimeMs: number }): Promise<RolloutFacts> {
  const hit = rolloutFactsCache.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
  if (rolloutFactsCache.size >= ROLLOUT_FACTS_MAX) rolloutFactsCache.clear();
  const meta = readSessionMeta(path);
  const facts: RolloutFacts = {
    size: st.size,
    mtimeMs: st.mtimeMs,
    meta,
    surface: codexSessionSurface(path, meta),
    launchSurface: codexRolloutLaunchSurface(meta),
    rawStatus: (await inferRolloutRawStatus(path, st)).status,
  };
  rolloutFactsCache.set(path, facts);
  return facts;
}

type RolloutTaskMarker =
  | { kind: 'start'; turnId: string }
  | { kind: 'terminal'; turnId: string };

function rolloutTaskMarker(line: string): RolloutTaskMarker | undefined {
  if (!/"(?:task_started|task_complete|turn_aborted)"/.test(line)) return undefined;
  try {
    const record = JSON.parse(line);
    if (record?.type !== 'event_msg') return undefined;
    const type = record.payload?.type;
    const rawTurnId = record.payload?.turn_id ?? record.payload?.turnId;
    if (rawTurnId === undefined || rawTurnId === null || String(rawTurnId) === '') return undefined;
    const turnId = String(rawTurnId);
    if (type === 'task_started') return { kind: 'start', turnId };
    if (type === 'task_complete' || type === 'turn_aborted') return { kind: 'terminal', turnId };
  } catch {
    // A partially appended JSONL record is not authoritative yet.
  }
  return undefined;
}

// ── filesystem primitives (bounded reads; no whole-file slurp at discovery) ────

function readFirstLine(path: string, maxBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    const s = buf.toString('utf8', 0, n);
    const nl = s.indexOf('\n');
    return nl === -1 ? (n < maxBytes ? s : undefined) : s.slice(0, nl);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function readBytesFrom(path: string, offset: number, length: number): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, n);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function readFileText(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    const buf = Buffer.alloc(size);
    const n = readSync(fd, buf, 0, size, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** Split a rollout into raw line segments, dropping ONLY the trailing empty segment left by a final
 *  newline. The segment count is the line-index space shared by getHistory and the live tail. */
function splitRolloutLines(text: string): string[] {
  const segs = text.split('\n');
  if (segs.length && segs[segs.length - 1] === '') segs.pop();
  return segs;
}

/** Parse one rollout line; blank or malformed → null (a position-preserving slot — see mapRollout). */
function parseLineOrNull(s: string): any | null {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Parse Codex's apply_patch `input` (`*** Begin Patch … *** End Patch`) into the first file path and a
 *  diff body (the `*** … File:` control lines stripped) for the canonical path/title/diffstat chips. */
type ApplyPatchOp = 'add' | 'update' | 'delete';

/** Human title for a single-file change by canonical operation. */
function changeTitle(op: FileOperation, base: string): string {
  switch (op) {
    case 'create':
      return `Created ${base}`;
    case 'delete':
      return `Deleted ${base}`;
    case 'rename':
      return `Renamed ${base}`;
    default:
      return `Edited ${base}`;
  }
}

/** Collapsed one-line title for a set of file changes: single-file uses the file's operation
 *  verb; multi-file uses a count ("Edited 3 files", "Changed 3 files" when operations differ). */
function titleForChanges(changes: FileChange[]): string | undefined {
  if (changes.length === 0) return undefined;
  if (changes.length === 1) return changeTitle(changes[0]!.operation, basename(changes[0]!.path));
  const op = fileChangesOperation(changes);
  const verb =
    op === 'create' ? 'Created' : op === 'delete' ? 'Deleted' : op === 'rename' ? 'Renamed' : op === 'edit' ? 'Edited' : 'Changed';
  return `${verb} ${changes.length} files`;
}

/**
 * Parse a codex apply_patch envelope (V4A) into a git-style unified diff.
 *
 * V4A marks sections with `*** Add|Update|Delete File: <path>` (and an optional
 * `*** Move to: <path>` rename) wrapping `@@ <context>` hints and ` `/`+`/`-`
 * body lines — but no line-number ranges. We rewrite each section into
 * `diff --git`/`--- `/`+++ ` headers so the client keeps per-file boundaries for
 * a multi-file patch and renders create/delete/rename honestly, instead of the
 * old behaviour that dropped every `*** ` line and merged files into one blob.
 * This is the event-time diff carried in the tool call — never rebuilt from
 * later Git state.
 */
function parseApplyPatch(input: string): {
  path?: string;
  diff?: string;
  op?: ApplyPatchOp;
  fileChanges?: FileChange[];
} {
  const lines = input.split('\n');
  const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
  const out: string[] = [];
  const changes: FileChange[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const m = header.exec(line);
    if (!m?.[1] || !m[2]) {
      i++;
      continue;
    }
    const op = m[1].toLowerCase() as ApplyPatchOp;
    const path = m[2].trim();
    i++;
    let newPath = path;
    const move = /^\*\*\* Move to: (.+)$/.exec(lines[i] ?? '');
    if (move?.[1]) {
      newPath = move[1].trim();
      i++;
    }
    const body: string[] = [];
    while (i < lines.length) {
      const next = lines[i] ?? '';
      if (header.test(next) || /^\*\*\* (?:End|Begin) Patch/.test(next)) break;
      if (!next.startsWith('*** ')) body.push(next);
      i++;
    }
    const renamed = op !== 'delete' && newPath !== path;
    // Per-file git-style header. Absolute paths keep their leading slash without doubling it.
    const section: string[] = [`diff --git ${gitDiffPath('a', path)} ${gitDiffPath('b', newPath)}`];
    if (op === 'add') {
      section.push('new file', '--- /dev/null', `+++ ${gitDiffPath('b', newPath)}`);
    } else if (op === 'delete') {
      section.push('deleted file', `--- ${gitDiffPath('a', path)}`, '+++ /dev/null');
    } else {
      if (renamed) section.push(`rename from ${path}`, `rename to ${newPath}`);
      section.push(`--- ${gitDiffPath('a', path)}`, `+++ ${gitDiffPath('b', newPath)}`);
    }
    for (const b of body) section.push(b);
    out.push(...section);
    const { additions, deletions } = summarizeDiff(section.join('\n'));
    const change: FileChange = {
      path: op === 'delete' ? path : newPath,
      operation: op === 'add' ? 'create' : op === 'delete' ? 'delete' : renamed ? 'rename' : 'edit',
      diff: section.join('\n'),
      additions,
      deletions,
    };
    if (renamed) change.previousPath = path;
    changes.push(change);
  }
  const result: { path?: string; diff?: string; op?: ApplyPatchOp; fileChanges?: FileChange[] } = {};
  const first = changes[0];
  if (first) {
    result.path = first.path;
    result.op = first.operation === 'create' ? 'add' : first.operation === 'delete' ? 'delete' : 'update';
    result.fileChanges = changes;
  }
  const diff = out.join('\n').trim();
  if (diff) result.diff = diff;
  return result;
}

function sanitizeFileName(name: string): string {
  let base = basename(String(name)).replace(/[^\w.\- ]+/g, '_').trim();
  if (!base || base === '.' || base === '..') base = 'file';
  if (base.length > 200) {
    const ext = extname(base).slice(0, 20);
    base = base.slice(0, 200 - ext.length) + ext;
  }
  return base;
}

function statSafe(p: string) {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

const HISTORY_SOURCE_REWRITE_PREFIX_BYTES = 1024;

/** Bytes read per capture chunk. Peak resident bytes are one chunk plus the held partial record
 *  (itself bounded by {@link HISTORY_SNAPSHOT_MAX_RECORD_BYTES}) — never the whole rollout, its
 *  UTF-8 string, and the array `String.split` builds from it. */
const HISTORY_SNAPSHOT_CHUNK_BYTES = 1 << 20;

/** Hard ceiling on the native source a capture will read at all. Real Codex rollouts reach ~90 MB,
 *  so this is deliberately far above them: it exists to refuse a corrupt or pathological file with a
 *  typed answer, decided from the `fstat` alone, before any work starts. */
const HISTORY_SNAPSHOT_MAX_SOURCE_BYTES = 256 * 1024 * 1024;

/** Hard ceiling on the native source a BOUNDED-TAIL read will stream (H1c).
 *
 *  The 256 MiB ceiling above guards INDEXING, where retention grows with the source. A sink that
 *  keeps a fixed newest window makes retention O(window) at any source size, so that ceiling has
 *  nothing left to protect — and applying it anyway is what left an over-contract session with no
 *  history whatsoever rather than a degraded one. What remains bounded here is TIME: this pass is
 *  two sequential streams, so it costs roughly `4 x size / disk throughput`. Four times the
 *  indexing ceiling puts the worst case at a few seconds on a spinning disk, which is a slow attach
 *  rather than a hung one; beyond it, refusing is the better answer. */
const HISTORY_TAIL_READ_MAX_SOURCE_BYTES = 4 * HISTORY_SNAPSHOT_MAX_SOURCE_BYTES;

/** Substring every line that can enrich a tool result must contain.
 *
 *  {@link accumulateEnrich} ignores any line whose `payload.call_id` is absent, so a line without
 *  this substring cannot contribute — and skipping its `JSON.parse` keeps the enrichment pass a
 *  string scan over the ~90% of a rollout that is message/reasoning text. The rollout is written by
 *  serde_json, which never escapes ASCII key characters, so the key is always literal here. */
const CODEX_ENRICH_LINE_MARKER = 'call_id';

/** Hard ceiling on one newline-delimited record, in UTF-8 BYTES.
 *
 *  Aligned with the broker's per-entry encoded budget, which is itself a byte budget: a single
 *  record larger than the whole paging-cache entry cannot produce a servable snapshot, so refusing
 *  it here is not a new policy — it is the same budget applied before a record without a newline
 *  could otherwise hold the entire source resident as the held remainder. Bytes, not UTF-16 code
 *  units: a CJK-heavy record is three bytes per code unit, and a code-unit ceiling would have
 *  admitted ~96 MiB of source under a "32 MiB" claim. */
const HISTORY_SNAPSHOT_MAX_RECORD_BYTES = 32 * 1024 * 1024;

/** Hard ceiling on enrichment entries retained by the pre-pass.
 *
 *  Aligned with the broker's 50k-message cap: every enriched call produces at least one mapped
 *  message, so a source with more call ids than the message budget cannot fit the cache either. */
const HISTORY_SNAPSHOT_MAX_ENRICH_ENTRIES = 50_000;

/** Hard ceiling on UTF-8 bytes the enrichment map RETAINS (names, paths, titles, diff bodies).
 *
 *  Measured on what {@link accumulateEnrich} keeps, not on the size of the lines it read: tool
 *  OUTPUT lines carry a `call_id` but retain only a duration, and must not count against the
 *  snapshot. Aligned with the per-entry encoded budget — retained diffs are embedded into mapped
 *  messages, so more retained bytes than the cache entry can hold cannot produce a snapshot.
 *  UTF-8 bytes on purpose, matching how the broker's budget counts: a code-unit measure undercounts
 *  CJK-heavy diffs threefold. */
const HISTORY_SNAPSHOT_MAX_ENRICH_BYTES = 32 * 1024 * 1024;

/** Live-tail ceilings on the same retained enrichment, measured with the same
 *  {@link enrichEntryBytes}.
 *
 *  A history read is a bounded pass over one file and can refuse; an observe
 *  connection runs for as long as the session is open, so it evicts instead.
 *  Both ceilings apply — entries alone would not bound a few very large diffs,
 *  and bytes alone would not bound very many tiny calls. */
const CODEX_LIVE_ENRICH_MAX_ENTRIES = 4_096;
const CODEX_LIVE_ENRICH_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The enrichment map plus its byte accounting, in one place.
 *
 * Both readers measure retention identically — with {@link enrichEntryBytes} and
 * nothing else. They differ only in what they do at the ceiling: a bounded
 * history pass refuses the snapshot, while a connection that stays open for the
 * life of a session evicts its oldest calls instead.
 *
 * The per-key tally is what keeps this incremental: accumulating one record
 * re-measures exactly the entry that record touched, never the whole map.
 */
export class CodexEnrichStore {
  /** The map itself, for the mappers that consume it. */
  readonly entries = new Map<string, CodexEnrich>();
  private readonly entryBytes = new Map<string, number>();
  private total = 0;

  /** UTF-8 bytes currently retained across every entry. */
  get retainedBytes(): number {
    return this.total;
  }

  /** Number of retained calls. */
  get size(): number {
    return this.entries.size;
  }

  /** Accumulates one record, re-measuring only the entry it touched. */
  accumulate(ln: unknown): void {
    const rawId = (ln as { payload?: { call_id?: unknown } })?.payload?.call_id;
    accumulateEnrich(ln, this.entries);
    if (rawId == null) return; // not call-scoped; accumulateEnrich retained nothing
    const key = String(rawId);
    const measured = enrichEntryBytes(this.entries.get(key));
    this.total += measured - (this.entryBytes.get(key) ?? 0);
    this.entryBytes.set(key, measured);
  }

  /**
   * Evicts oldest-call-first until both ceilings hold.
   *
   * `keep` is the call just enriched: its own output is still to come, so
   * evicting it would drop detail that was about to be used. Eviction costs
   * only enrichment — an output whose call was evicted still renders from its
   * own canonical fields.
   *
   * `keep` is SKIPPED, never a stopping condition. Returning the moment the
   * oldest key happened to be the protected one left every newer entry retained
   * and both ceilings broken — with `maxEntries: 1, maxBytes: 100` and the
   * oldest key protected, the store kept two entries and 8,264 bytes and called
   * itself bounded (H1c round 3, finding 2). This method is the only thing
   * bounding enrichment on the bounded-tail capture path, so a bound it does not
   * actually reach is the whole of that path's memory guarantee.
   *
   * Skipping is O(1): the iterator is restarted per eviction and can pass over
   * at most the one protected key before reaching an evictable one.
   */
  evictUntilWithin(maxEntries: number, maxBytes: number, keep?: string): void {
    while (this.entries.size > maxEntries || this.total > maxBytes) {
      let evicted: string | undefined;
      for (const key of this.entries.keys()) {
        if (key === keep) continue;
        evicted = key;
        break;
      }
      if (evicted === undefined) break; // only the protected entry is left
      this.entries.delete(evicted);
      this.total -= this.entryBytes.get(evicted) ?? 0;
      this.entryBytes.delete(evicted);
    }
    // The protected entry may outlive `maxEntries` — that is the documented
    // exception, and dropping the record this pass just read would defeat the
    // point of protecting it. It may not simply outlive `maxBytes` either:
    // `retainedBytes` is a fact the capture path reports, so when the survivor
    // alone is over the byte ceiling its retained strings are shortened until
    // the ceiling holds.
    if (this.total > maxBytes && keep !== undefined) this.clipEntryWithin(keep, maxBytes);
  }

  /**
   * Shortens one entry's retained strings until it honours [maxBytes].
   *
   * Re-measured through {@link enrichEntryBytes} — the same function both
   * ceilings are stated in — so the accounting stays exact rather than
   * approximately exact. The entry object is mutated in place, never re-`set`,
   * so its Map insertion position (which is the eviction order) is preserved.
   *
   * An entry that cannot fit even with every string gone is kept in that
   * irreducible form rather than deleted. Two rules meet here and neither is
   * negotiable: the call currently being enriched must survive any ceiling (its
   * own output has not been read yet), and retention must be bounded. Both hold,
   * because what is left is {@link enrichEntryBytes}'s fixed-field allowance —
   * a CONSTANT, with no retained string behind it and nothing further to give
   * up. `retainedBytes` still reports it exactly, so a caller comparing against
   * its ceiling sees the truth rather than a rounded-down claim.
   */
  private clipEntryWithin(key: string, maxBytes: number): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const remeasure = (): number => {
      const measured = enrichEntryBytes(entry);
      this.total += measured - (this.entryBytes.get(key) ?? 0);
      this.entryBytes.set(key, measured);
      return measured;
    };
    if (remeasure() <= maxBytes) return;
    // Structured file changes cannot be honestly halved; the flat strings can.
    if (entry.fileChanges?.length) {
      delete entry.fileChanges;
      if (remeasure() <= maxBytes) return;
    }
    const ordered = [...CLIPPABLE_ENRICH_FIELDS].sort(
      (left, right) => utf8Length(entry[right]) - utf8Length(entry[left]),
    );
    for (const field of ordered) {
      const value = entry[field];
      if (typeof value !== 'string' || value.length === 0) continue;
      const excess = remeasure() - maxBytes;
      if (excess <= 0) return;
      // Every character removed frees at least one UTF-8 byte.
      const keepChars = Math.max(0, value.length - excess);
      if (keepChars === 0) delete entry[field];
      else entry[field] = clipEnrichChars(value, keepChars);
    }
    // Nothing retained is left to give up. The irreducible entry stays, and
    // `remeasure` has already made `retainedBytes` report exactly what it costs.
    remeasure();
  }
}

/** Retained {@link CodexEnrich} strings, shortest-lived detail first when clipped. */
const CLIPPABLE_ENRICH_FIELDS = [
  'diff',
  'stdout',
  'stderr',
  'command',
  'title',
  'path',
  'cwd',
  'name',
  'agentType',
] as const;

const utf8Length = (value: string | undefined | null): number =>
  value == null ? 0 : Buffer.byteLength(value);

/** Approximate retained size of one enrichment entry, in UTF-8 bytes.
 *
 *  Must charge EVERY string the entry retains. A field that is kept but not
 *  counted here is a hole straight through {@link HISTORY_SNAPSHOT_MAX_ENRICH_BYTES}
 *  and through the live map's own ceiling, both of which measure with this
 *  function and nothing else. */
export function enrichEntryBytes(entry: CodexEnrich | undefined): number {
  if (!entry) return 0;
  let bytes = 32; // fixed fields (numbers, flags)
  bytes += utf8Length(entry.name) + utf8Length(entry.path)
    + utf8Length(entry.title) + utf8Length(entry.diff) + utf8Length(entry.agentType)
    + utf8Length(entry.command) + utf8Length(entry.cwd)
    + utf8Length(entry.stdout) + utf8Length(entry.stderr);
  for (const change of entry.fileChanges ?? []) {
    bytes += utf8Length(change.path) + utf8Length(change.previousPath) + utf8Length(change.diff) + 16;
  }
  return bytes;
}

type ScanOutcome = {
  /** End position of the scan in the file — equals the requested size on a complete pass. */
  bytes: number;
  /** SHA-256 over exactly the bytes read this pass (from `startOffset` to `bytes`). */
  digest: Buffer;
  /** A record exceeded {@link HISTORY_SNAPSHOT_MAX_RECORD_BYTES}. Terminal. */
  recordOverflow: boolean;
  /** Oversized records passed over instead, when the caller allowed skipping. */
  skippedRecords: number;
  /** Record index the next appended record would take — the scan's line-count watermark. */
  nextRecordIndex: number;
  /** True when the scan ended exactly at a newline, so a later pass may resume at `bytes`.
   *  A final record with no trailing newline (or a discarded oversized tail) is a torn
   *  boundary: resuming there would read the rest of that line as a new record and shift
   *  every later index. */
  endedAtRecordBoundary: boolean;
};

/** Compact native paging metadata retained after a Codex index build.
 *
 *  Aligned with the broker's per-entry paging budget, exactly like
 *  {@link HISTORY_SNAPSHOT_MAX_RECORD_BYTES} and
 *  {@link HISTORY_SNAPSHOT_MAX_ENRICH_BYTES}. It was 8 MiB — a private number
 *  below every public bound — and the real 137.8 MiB `cosyncing-orch` rollout
 *  retains 9.2 MiB of descriptors and offsets, so a source squarely inside the
 *  advertised 256 MiB / 50,000-message contract was refused by a ceiling the
 *  contract never states (H1c). Construction stays streaming and bounded:
 *  {@link CodexHistoryPageReaderBuilder.register} measures every descriptor as
 *  it is created and still stops the capture at the ceiling. */
const CODEX_HISTORY_READER_MAX_BYTES = 32 * 1024 * 1024;
const CODEX_HISTORY_READER_MAX_RECORDS = 250_000;
const CODEX_HISTORY_READER_MAX_CALL_IDS = 50_000;
const CODEX_HISTORY_READER_MAX_CALL_REFS = 250_000;
const CODEX_HISTORY_READER_MAX_CALL_REFS_PER_ID = 64;

/** One requested page may decode at most this much native/normalized content. */
const CODEX_HISTORY_PAGE_MAX_BYTES = 16 * 1024 * 1024;
const CODEX_HISTORY_PAGE_MAX_RECORDS = 4_096;

type CodexHistoryDescriptor =
  | { kind: 'inline'; json: string }
  | {
      kind: 'native';
      record: number;
      type: AgentMessage['type'];
      typeOrdinal: number;
      templateJson: string;
    };

const CODEX_HISTORY_NATIVE_TYPES = new Set<AgentMessage['type']>([
  'model-output',
  'thinking',
  'user-message',
  'tool-call',
  'tool-result',
]);

/** Remove source-backed bodies while retaining exact identity/state metadata. */
function codexHistoryMessageTemplate(message: AgentMessage): string {
  const copy = { ...message } as Record<string, unknown>;
  delete copy.text;
  delete copy.result;
  delete copy.diff;
  delete copy.fileChanges;
  delete copy.args;
  return JSON.stringify(copy);
}

class CodexHistoryPageReaderBuilder {
  private readonly descriptors: CodexHistoryDescriptor[] = [];
  private readonly nativeIndexBytes: number;
  private descriptorBytes = 0;
  private overflowed = false;

  constructor(
    private readonly path: string,
    private readonly size: number,
    private readonly dev: number,
    private readonly ino: number,
    private readonly mtimeMs: number,
    private readonly ctimeMs: number,
    private readonly prefix: Buffer,
    private readonly recordStarts: readonly number[],
    private readonly recordEnds: readonly number[],
    private readonly callRecords: ReadonlyMap<string, readonly number[]>,
    private readonly beforePageRecordReads?: () => void,
  ) {
    let callBytes = 0;
    for (const [id, records] of callRecords) {
      callBytes += Buffer.byteLength(id, 'utf8') + 64 + records.length * 4;
    }
    // Two Uint32 offset arrays, compact call references, the rewrite prefix,
    // and fixed path/identity/collection overhead. This intentionally
    // overcounts the retained native reader rather than treating JS objects as
    // free.
    this.nativeIndexBytes =
      recordStarts.length * 8
      + callBytes
      + prefix.byteLength
      + Buffer.byteLength(path, 'utf8')
      + 512;
  }

  get exceededBudget(): boolean {
    return this.overflowed;
  }

  register(
    message: AgentMessage,
    record: number,
    typeOrdinal: number,
  ): number | undefined {
    if (this.overflowed) return undefined;
    // Transcript bodies always remain source-backed, even when individually
    // small. Inline descriptors are reserved for bounded state/control
    // metadata that cannot be reconstructed from an isolated record without
    // replaying the entire runtime tracker.
    const descriptor: CodexHistoryDescriptor =
      CODEX_HISTORY_NATIVE_TYPES.has(message.type)
        ? {
            kind: 'native',
            record,
            type: message.type,
            typeOrdinal,
            templateJson: codexHistoryMessageTemplate(message),
          }
        : { kind: 'inline', json: JSON.stringify(message) };
    const retained = descriptor.kind === 'inline'
      ? Buffer.byteLength(descriptor.json, 'utf8') + 64
      : Buffer.byteLength(descriptor.templateJson, 'utf8') + 96;
    this.descriptorBytes += retained;
    if (
      this.descriptors.length >= HISTORY_SNAPSHOT_MAX_ENRICH_ENTRIES
      || this.retainedBytesEstimate() > CODEX_HISTORY_READER_MAX_BYTES
    ) {
      this.overflowed = true;
      return undefined;
    }
    const location = this.descriptors.length;
    this.descriptors.push(descriptor);
    return location;
  }

  private retainedBytesEstimate(): number {
    return this.descriptorBytes + this.nativeIndexBytes;
  }

  finish(identity: HistorySourceIdentity): HistorySnapshotPageReader | undefined {
    if (this.overflowed) return undefined;
    const retainedBytes = this.retainedBytesEstimate();
    if (retainedBytes > CODEX_HISTORY_READER_MAX_BYTES) return undefined;
    const compactCallRecords = new Map<string, Uint32Array>();
    for (const [id, records] of this.callRecords) {
      compactCallRecords.set(id, Uint32Array.from(records));
    }
    return new CodexHistoryPageReader({
      path: this.path,
      size: this.size,
      dev: this.dev,
      ino: this.ino,
      mtimeMs: this.mtimeMs,
      ctimeMs: this.ctimeMs,
      prefix: Buffer.from(this.prefix),
      identity: Object.freeze({ ...identity }),
      recordStarts: Uint32Array.from(this.recordStarts),
      recordEnds: Uint32Array.from(this.recordEnds),
      callRecords: compactCallRecords,
      descriptors: this.descriptors,
      retainedBytes,
      beforePageRecordReads: this.beforePageRecordReads,
    });
  }
}

type CodexHistoryRecordRead =
  | { kind: 'record'; raw: string }
  | { kind: 'resource-limit' }
  | { kind: 'source-changed' };

class CodexHistoryPageReader implements HistorySnapshotPageReader {
  readonly retainedBytes: number;
  private readonly path: string;
  private readonly size: number;
  private readonly dev: number;
  private readonly ino: number;
  private readonly mtimeMs: number;
  private readonly ctimeMs: number;
  private readonly prefix: Buffer;
  private readonly identity: Readonly<HistorySourceIdentity>;
  private readonly recordStarts: Uint32Array;
  private readonly recordEnds: Uint32Array;
  private readonly callRecords: ReadonlyMap<string, Uint32Array>;
  private readonly descriptors: readonly CodexHistoryDescriptor[];
  private readonly beforePageRecordReads?: () => void;

  constructor(parts: {
    path: string;
    size: number;
    dev: number;
    ino: number;
    mtimeMs: number;
    ctimeMs: number;
    prefix: Buffer;
    identity: Readonly<HistorySourceIdentity>;
    recordStarts: Uint32Array;
    recordEnds: Uint32Array;
    callRecords: ReadonlyMap<string, Uint32Array>;
    descriptors: readonly CodexHistoryDescriptor[];
    retainedBytes: number;
    beforePageRecordReads?: () => void;
  }) {
    this.path = parts.path;
    this.size = parts.size;
    this.dev = parts.dev;
    this.ino = parts.ino;
    this.mtimeMs = parts.mtimeMs;
    this.ctimeMs = parts.ctimeMs;
    this.prefix = parts.prefix;
    this.identity = parts.identity;
    this.recordStarts = parts.recordStarts;
    this.recordEnds = parts.recordEnds;
    this.callRecords = parts.callRecords;
    this.descriptors = parts.descriptors;
    this.retainedBytes = parts.retainedBytes;
    this.beforePageRecordReads = parts.beforePageRecordReads;
  }

  read(
    locations: readonly number[],
  ): HistorySnapshotPageRead | HistorySnapshotRefusal | undefined {
    if (locations.length > CODEX_HISTORY_PAGE_MAX_RECORDS) {
      return { refusal: 'resource-limit' };
    }
    let fd: number | undefined;
    try {
      fd = openSync(this.path, 'r');
      const before = fstatSync(fd);
      if (
        before.dev !== this.dev
        || before.ino !== this.ino
        || before.size < this.size
        || (
          before.size === this.size
          && (
            before.mtimeMs !== this.mtimeMs
            || before.ctimeMs !== this.ctimeMs
          )
        )
      ) return undefined;
      const prefixNow = Buffer.alloc(this.prefix.length);
      const prefixBytes = this.prefix.length > 0
        ? readSync(fd, prefixNow, 0, prefixNow.length, 0)
        : 0;
      if (
        prefixBytes !== this.prefix.length
        || !prefixNow.equals(this.prefix)
      ) return undefined;

      const rawByRecord = new Map<number, string>();
      let bytesRead = prefixBytes;
      let recordsRead = 0;
      const readRecord = (record: number): CodexHistoryRecordRead => {
        const cached = rawByRecord.get(record);
        if (cached !== undefined) return { kind: 'record', raw: cached };
        const start = this.recordStarts[record];
        const end = this.recordEnds[record];
        if (start === undefined || end === undefined || end < start) {
          return { kind: 'source-changed' };
        }
        const length = end - start;
        if (
          length > HISTORY_SNAPSHOT_MAX_RECORD_BYTES
          || bytesRead + length > CODEX_HISTORY_PAGE_MAX_BYTES
          || recordsRead >= CODEX_HISTORY_PAGE_MAX_RECORDS
        ) return { kind: 'resource-limit' };
        const buf = Buffer.alloc(length);
        if (length > 0 && readSync(fd!, buf, 0, length, start) !== length) {
          return { kind: 'source-changed' };
        }
        const raw = buf.toString('utf8');
        rawByRecord.set(record, raw);
        bytesRead += length;
        recordsRead += 1;
        return { kind: 'record', raw };
      };

      const requested = locations.map((location) => {
        if (!Number.isSafeInteger(location) || location < 0) return undefined;
        return this.descriptors[location];
      });
      if (requested.some((descriptor) => descriptor === undefined)) {
        return undefined;
      }

      const targetRecords = new Set<number>();
      for (const descriptor of requested) {
        if (descriptor?.kind === 'native') {
          targetRecords.add(descriptor.record);
          if (descriptor.record + 1 < this.recordStarts.length) {
            targetRecords.add(descriptor.record + 1);
          }
        }
      }
      this.beforePageRecordReads?.();
      for (const record of targetRecords) {
        const result = readRecord(record);
        if (result.kind === 'resource-limit') return { refusal: 'resource-limit' };
        if (result.kind === 'source-changed') return undefined;
      }

      const neededCalls = new Set<string>();
      for (const descriptor of requested) {
        if (descriptor?.kind !== 'native') continue;
        const record = parseLineOrNull(rawByRecord.get(descriptor.record) ?? '');
        const callId = record?.payload?.call_id;
        if (callId != null) neededCalls.add(String(callId));
      }
      const enrich = new Map<string, CodexEnrich>();
      for (const callId of neededCalls) {
        for (const record of this.callRecords.get(callId) ?? []) {
          const result = readRecord(record);
          if (result.kind === 'resource-limit') return { refusal: 'resource-limit' };
          if (result.kind === 'source-changed') return undefined;
          const parsed = parseLineOrNull(result.raw);
          if (parsed) accumulateEnrich(parsed, enrich);
        }
      }

      const mappedByRecord = new Map<number, AgentMessage[]>();
      const resolveNative = (
        descriptor: Extract<CodexHistoryDescriptor, { kind: 'native' }>,
      ): AgentMessage | undefined => {
        let mapped = mappedByRecord.get(descriptor.record);
        if (!mapped) {
          const record = parseLineOrNull(rawByRecord.get(descriptor.record) ?? '');
          if (!record) return undefined;
          const next = parseLineOrNull(
            rawByRecord.get(descriptor.record + 1) ?? '',
          );
          mapped = mapLine(
            record,
            descriptor.record,
            enrich,
            new CodexRuntimeTracker(),
            next,
          );
          mappedByRecord.set(descriptor.record, mapped);
        }
        const candidate = mapped
          .filter((message) => message.type === descriptor.type)
          [descriptor.typeOrdinal];
        if (!candidate) return undefined;
        return {
          ...candidate,
          ...JSON.parse(descriptor.templateJson),
        } as AgentMessage;
      };

      const messages: AgentMessage[] = [];
      let encodedBytes = 0;
      for (const descriptor of requested) {
        const message = descriptor!.kind === 'inline'
          ? JSON.parse(descriptor!.json) as AgentMessage
          : resolveNative(descriptor!);
        if (!message) return undefined;
        encodedBytes += Buffer.byteLength(JSON.stringify(message), 'utf8');
        if (encodedBytes > CODEX_HISTORY_PAGE_MAX_BYTES) {
          return { refusal: 'resource-limit' };
        }
        messages.push(message);
      }

      const after = fstatSync(fd);
      if (
        after.dev !== this.dev
        || after.ino !== this.ino
        || after.size < this.size
        || (
          after.size === this.size
          && (
            after.mtimeMs !== this.mtimeMs
            || after.ctimeMs !== this.ctimeMs
          )
        )
      ) return undefined;
      return {
        identity: { ...this.identity },
        messages,
        work: { recordsRead, bytesRead },
      };
    } catch (error) {
      return error instanceof RangeError
        ? { refusal: 'resource-limit' }
        : undefined;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  }
}

/**
 * Read every newline-delimited record inside a captured byte boundary, in order.
 *
 * Chunked by construction: at most one chunk plus one bounded partial record is resident,
 * whatever the file size. Record boundaries are found in the BYTE domain — `0x0A` never occurs
 * inside a UTF-8 multibyte sequence — and the per-record ceiling is enforced on raw bytes BEFORE
 * a record is copied or decoded, so an oversized record aborts the scan without ever being
 * materialized, and the ceiling means exactly what the broker's byte budget means regardless of
 * how many bytes each character encodes to. Every byte consumed is folded into the returned
 * digest, so a caller running two passes can prove they observed the same content, not merely the
 * same length. `onLine` returning false stops the scan early (sink budget exhausted).
 *
 * `skipOversizedRecords` turns that abort into a skip, for a caller that retains only a bounded
 * newest window. Such a record could never fit that window anyway, so refusing the whole source
 * over it costs the client every OTHER message for no benefit. The skip is decided purely from
 * byte lengths, so both passes skip exactly the same records and their record indices, digests and
 * boundaries stay aligned.
 *
 * Written as a generator so the scan can suspend after each chunk without the chunking, skip
 * decisions, digest folding or record indexing living anywhere but here. {@link scanFileLinesAsync}
 * resumes it from the event loop; a second copy of this logic would be a second place for the two
 * capture passes to disagree about which records they skipped.
 */
function* scanFileLineChunks(
  fd: number,
  size: number,
  onLine: (
    raw: string,
    start: number,
    end: number,
    index: number,
  ) => boolean,
  options: {
    skipOversizedRecords?: boolean;
    /** Resume a prior complete pass: read from this byte (a record boundary), not from 0. */
    startOffset?: number;
    /** Record index of the first record at `startOffset`, so indices stay file-absolute. */
    startRecordIndex?: number;
  } = {},
): Generator<void, ScanOutcome, void> {
  const skipOversized = options.skipOversizedRecords === true;
  const startOffset = options.startOffset ?? 0;
  const chunk = Buffer.alloc(
    Math.min(HISTORY_SNAPSHOT_CHUNK_BYTES, Math.max(size - startOffset, 1)),
  );
  const digest = createHash('sha256');
  /** Byte segments of the current partial record, copied out of the reused chunk buffer. */
  let heldParts: Buffer[] = [];
  let heldBytes = 0;
  let read = startOffset;
  let recordStart = startOffset;
  let recordIndex = options.startRecordIndex ?? 0;
  let skipped = 0;
  /** Inside an oversized record: consume to its newline without retaining it. */
  let discarding = false;
  const outcome = (recordOverflow: boolean): ScanOutcome => ({
    bytes: read,
    digest: digest.digest(),
    recordOverflow,
    skippedRecords: skipped,
    nextRecordIndex: recordIndex,
    endedAtRecordBoundary: heldBytes === 0 && !discarding,
  });
  let firstChunk = true;
  while (read < size) {
    // Suspend BEFORE every chunk after the first. One chunk is 1 MiB of reading, newline scanning
    // and per-record work — low tens of milliseconds — so the longest slice this scan imposes on
    // the event loop is one chunk plus the unavoidable parse of one bounded record, whatever the
    // source size (H1c round 3, finding 4).
    if (!firstChunk) yield;
    firstChunk = false;
    const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - read), read);
    if (n <= 0) break;
    read += n;
    const view = chunk.subarray(0, n);
    digest.update(view);
    let cursor = 0;
    let nl: number;
    while ((nl = view.indexOf(0x0a, cursor)) !== -1) {
      const segment = view.subarray(cursor, nl);
      cursor = nl + 1;
      const recordEnd = read - n + nl;
      if (discarding) {
        discarding = false;
        heldParts = [];
        heldBytes = 0;
        recordIndex += 1;
        recordStart = recordEnd + 1;
        continue;
      }
      if (heldBytes + segment.length > HISTORY_SNAPSHOT_MAX_RECORD_BYTES) {
        if (!skipOversized) return outcome(true);
        heldParts = [];
        heldBytes = 0;
        skipped += 1;
        recordIndex += 1;
        recordStart = recordEnd + 1;
        continue;
      }
      // Decoded from the record's exact byte range, so a multibyte sequence split across chunk
      // reads reassembles correctly; record boundaries are always sequence boundaries.
      const raw = heldParts.length === 0
        ? segment.toString('utf8')
        : Buffer.concat([...heldParts, segment]).toString('utf8');
      heldParts = [];
      heldBytes = 0;
      if (!onLine(raw, recordStart, recordEnd, recordIndex++)) {
        return outcome(false);
      }
      recordStart = recordEnd + 1;
    }
    const remainder = view.subarray(cursor);
    if (remainder.length > 0 && !discarding) {
      if (heldBytes + remainder.length > HISTORY_SNAPSHOT_MAX_RECORD_BYTES) {
        if (!skipOversized) return outcome(true);
        discarding = true;
        skipped += 1;
        heldParts = [];
        heldBytes = 0;
      } else {
        heldParts.push(Buffer.from(remainder));
        heldBytes += remainder.length;
      }
    }
  }
  // A final record with no trailing newline is still a record, exactly as `splitRolloutLines`
  // treated it — and a trailing empty segment still is not.
  if (heldBytes > 0 && !discarding) {
    onLine(
      Buffer.concat(heldParts).toString('utf8'),
      recordStart,
      size,
      recordIndex,
    );
  }
  return outcome(false);
}

/** One turn of the event loop, so pending I/O and other sockets are serviced between chunks. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve); });
}

/**
 * Drive {@link scanFileLineChunks} from the event loop.
 *
 * The two capture passes were a fully synchronous `readSync` loop over a source admitted up to
 * 1 GiB, run TWICE. At realistic throughput that is tens of seconds in which the broker services
 * nothing — one client's attach froze every other client's session (H1c round 3, finding 4).
 * Resuming the scan through `setImmediate` costs microseconds per chunk and makes the wall clock,
 * not the event loop, the thing a large source spends.
 *
 * KNOWN RESIDUAL (round 4, not fixed here). The slice between yields is bounded by CHUNK BYTES, not
 * by CPU work, and the two are not proportional. Review measured 118 ms heartbeat gaps on a 16 MiB
 * fixture of very small records (per-record overhead dominates, ~2,000 parses per chunk) and 94 ms
 * on a single 24 MiB record (one unavoidable parse). Both are inside the 250 ms regression limit and
 * far below the pre-fix whole-file stall, but well above the ~16 ms typical slice. A future
 * hardening should yield on elapsed slice time or record count as well as chunk boundaries, so a
 * pathological record-size distribution cannot stretch one slice.
 */
async function scanFileLinesAsync(
  fd: number,
  size: number,
  onLine: (raw: string, start: number, end: number, index: number) => boolean,
  options: {
    skipOversizedRecords?: boolean;
    deadline?: number;
    startOffset?: number;
    startRecordIndex?: number;
  } = {},
): Promise<ScanOutcome | 'timed-out'> {
  const scan = scanFileLineChunks(fd, size, onLine, options);
  for (;;) {
    const step = scan.next();
    if (step.done) return step.value;
    if (options.deadline !== undefined && Date.now() > options.deadline) {
      scan.return(undefined as never);
      return 'timed-out';
    }
    await yieldToEventLoop();
  }
}

/**
 * Wall-clock budget for ONE bounded-tail capture, across both of its passes.
 *
 * With the scan yielding, {@link HISTORY_TAIL_READ_MAX_SOURCE_BYTES} no longer bounds anything a
 * user feels: a 1 GiB source no longer stalls the broker, it just takes a while for the one client
 * that asked. The cost that remains is an open descriptor and a CPU held for an unbounded time, so
 * the bound moves from bytes to seconds — which is what the byte ceiling was always a proxy for,
 * and a far better proxy on a fast disk than on a slow one. The byte ceiling is deliberately kept
 * as the cheap `fstat`-time pre-filter that refuses an absurd source before opening a single chunk.
 *
 * 30 seconds is several times the ~6 s a 200 MiB dense rollout measures at here, so no realistic
 * source reaches it. Exceeding it is a terminal `resource-limit`, not a retriable miss: the same
 * source will exceed it again, and a terminal answer keeps whatever window the client already holds
 * instead of retrying forever against a file that cannot be read in time.
 */
const HISTORY_TAIL_READ_MAX_ELAPSED_MS = 30_000;

/** Test-only seams for {@link captureFileHistoryInto}. Production passes nothing. */
export interface CaptureFileHistoryHooks {
  /** Runs after the identity stat and prefix are captured, before the enrichment pass. */
  beforeFirstPass?: () => void;
  /** Runs between the enrichment pass and the mapping pass. */
  betweenPasses?: () => void;
  /** Runs after page identity/prefix validation but before native records are read. */
  beforePageRecordReads?: () => void;
  /** Overrides {@link HISTORY_TAIL_READ_MAX_ELAPSED_MS} so the abort is deterministically testable. */
  maxElapsedMs?: number;
  /** Reports the byte range each capture pass actually read — O(delta) evidence for tests. */
  onScanRange?: (startOffset: number, endOffset: number) => void;
}

/**
 * Where a completed bounded-tail capture stopped, plus the mapping state frozen at that byte.
 *
 * Keyed by the sink instance the rows were streamed into: the state below is only meaningful
 * for continuing THAT sink, because the sink holds the corresponding retained window and
 * latest-wins projections. A different sink must pay a full scan, and a collected sink lets
 * this state be collected with it — the WeakMap is the lifecycle contract.
 */
type CodexTailCaptureResume = {
  /** `${dev}:${ino}` of the captured source. */
  sourceDevIno: string;
  /** Hash of the first {@link HISTORY_SOURCE_REWRITE_PREFIX_BYTES} (or fewer) bytes at capture. */
  rewriteToken: string;
  /** How many bytes that token covered, so a grown file recomputes over the same window. */
  prefixLength: number;
  /** Byte position the capture consumed to — always a record boundary. */
  size: number;
  /** Post-capture stat, so a same-size rewrite (mtime/ctime moved) invalidates the resume. */
  mtimeMs: number;
  ctimeMs: number;
  /** Record index the next appended record takes. */
  recordIndex: number;
  /** Cumulative oversized records skipped across the original capture and every resume. */
  skippedRecords: number;
  enrichStore: CodexEnrichStore;
  runtime: CodexRuntimeTracker;
  /** Observe-tail turn inheritance state at `size`, folded alongside the mapping pass. */
  context: ActiveRolloutContext;
  openTaskTurnId?: string;
};

const codexTailCaptureResumes = new WeakMap<HistorySnapshotSink, CodexTailCaptureResume>();

/**
 * Sinks this function has streamed any prefix into.
 *
 * A tail sink without usable resume state (a torn final record, a failed pass) must never be
 * scanned into from byte zero again — every retained row would be fed twice. Membership here
 * with no resume entry is answered with the retriable `undefined`, and the caller retries on
 * a fresh sink.
 */
const codexTailFedSinks = new WeakSet<HistorySnapshotSink>();

/**
 * Byte/record watermark of the newest completed bounded-tail capture per source.
 *
 * Sink-independent on purpose: {@link readObserveTailBaseline} consults it so an
 * over-ceiling observe tail can fix its boundary at the TRUE record count (and inherit
 * the enclosing turn) by scanning only the bytes appended since the last capture,
 * instead of falling back to the synthetic byte-based line base that keys the same
 * message differently live than a history read does.
 */
type CodexTailPosition = {
  rewriteToken: string;
  prefixLength: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  recordIndex: number;
  context: ActiveRolloutContext;
  openTaskTurnId?: string;
};

const CODEX_TAIL_POSITION_LIMIT = 8;
const codexTailPositions = new Map<string, CodexTailPosition>();

function storeCodexTailPosition(devIno: string, position: CodexTailPosition): void {
  codexTailPositions.delete(devIno);
  codexTailPositions.set(devIno, position);
  while (codexTailPositions.size > CODEX_TAIL_POSITION_LIMIT) {
    const oldest = codexTailPositions.keys().next().value;
    if (oldest === undefined) break;
    codexTailPositions.delete(oldest);
  }
}

function cloneActiveRolloutContext(context: ActiveRolloutContext): ActiveRolloutContext {
  return {
    turnId: context.turnId,
    automaticApprovalDenials: context.automaticApprovalDenials,
    toolNameByCallId: new Map(context.toolNameByCallId),
  };
}

/** Hash the same prefix window a stored token covered, so growth cannot fake a rewrite. */
function prefixTokenOver(prefix: Buffer, prefixBytes: number, length: number): string {
  return createHash('sha256')
    .update(prefix.subarray(0, Math.min(prefixBytes, length)))
    .digest('base64url');
}

/** Whether a stored watermark still describes a pure append of the statted source. */
function codexTailWatermarkValid(
  stored: { size: number; mtimeMs: number; ctimeMs: number },
  stat: { size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  if (stat.size < stored.size) return false;
  // A write that did not grow the file is a rewrite hazard, exactly as the capture's own
  // post-scan revalidation treats it.
  if (stat.size === stored.size && (stat.mtimeMs !== stored.mtimeMs || stat.ctimeMs !== stored.ctimeMs)) {
    return false;
  }
  return true;
}

/**
 * Stream one rollout prefix into [sink], and return the identity of exactly those bytes (H1b).
 *
 * ONE `fstat` on ONE open descriptor decides both halves: `appendPosition` is the size that was
 * read, and the messages are exactly the ones inside those bytes. A rollout the agent is still
 * appending to therefore yields a snapshot the broker can keep serving — the later bytes simply are
 * not in it — while a rewrite, compaction or truncation changes the prefix hash or shrinks the size
 * and still fails closed.
 *
 * Nothing whole-file is ever built, and nothing unbounded is retained before the sink's budget can
 * run: the held partial record, the enrichment entry count, and the bytes enrichment retains are
 * each capped, and exceeding any of them is the same typed resource refusal the sink's own budget
 * produces. `mapRollout` needs two things beyond the current line — the call-scoped enrichment map
 * and the NEXT record (assistant text resolves its native identity from the line that follows it) —
 * so this makes two chunked passes and holds exactly one record plus that one-line lookahead.
 *
 * An open descriptor does not freeze file CONTENT: the two passes can observe different bytes even
 * at one size. Three checks close the rewrite windows, each reported as retriable so the next
 * capture reads the settled content. Each pass digests exactly what it read and the digests must
 * match (a rewrite BETWEEN the passes pairs enrichment with the wrong messages otherwise); the
 * first {@link HISTORY_SOURCE_REWRITE_PREFIX_BYTES} are re-read afterwards and must still match the
 * prefix captured up front; and a write that moved mtime/ctime without growing the file is retried,
 * because a same-size rewrite BEFORE the first pass leaves both passes agreeing on rewritten bytes
 * under the pre-rewrite revision. A prefix-preserving append remains invisible throughout: both
 * passes stop at the captured boundary, and growth explains the metadata movement.
 */
export async function captureFileHistoryInto(
  path: string,
  sink: HistorySnapshotSink,
  published?: CodexPublishedIdentities,
  hooks?: CaptureFileHistoryHooks,
): Promise<HistorySnapshotCapture | HistorySnapshotRefusal | undefined> {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    const size = stat.size;
    // A sink that retains only a bounded newest window does not grow with the
    // source, so the indexing ceiling has nothing left to protect for it; only
    // the streaming TIME still needs a limit (H1c).
    const tailOnly = sink.readsBoundedTailOnly === true;
    // Decided from the stat, before a single byte is read.
    const sourceCeiling = tailOnly
      ? HISTORY_TAIL_READ_MAX_SOURCE_BYTES
      : HISTORY_SNAPSHOT_MAX_SOURCE_BYTES;
    if (size > sourceCeiling) return { refusal: 'resource-limit' };
    // Both passes share ONE budget: the pair is what an attach waits on.
    const deadline = Date.now()
      + (hooks?.maxElapsedMs ?? HISTORY_TAIL_READ_MAX_ELAPSED_MS);

    const prefix = Buffer.alloc(Math.min(HISTORY_SOURCE_REWRITE_PREFIX_BYTES, size));
    const prefixBytes = prefix.length > 0 ? readSync(fd, prefix, 0, prefix.length, 0) : 0;

    // Append-only continuation (H1d). A sink this function already streamed a prefix into may
    // come back for the bytes appended since: the resume state frozen for exactly that sink
    // proves where the prior pass stopped and what the mapper knew there, so both passes read
    // only [resume.size, size). Anything short of proof — a different file, a shrink, a prefix
    // rewrite, a same-size metadata move — is answered with the ordinary retriable `undefined`:
    // this sink already holds rows, so a full re-scan into it would double every one of them.
    const devIno = `${stat.dev}:${stat.ino}`;
    const resume = tailOnly ? codexTailCaptureResumes.get(sink) : undefined;
    if (resume) codexTailCaptureResumes.delete(sink);
    if (tailOnly && !resume && codexTailFedSinks.has(sink)) return undefined;
    if (tailOnly) codexTailFedSinks.add(sink);
    let startOffset = 0;
    let startRecordIndex = 0;
    let carriedSkips = 0;
    if (resume) {
      const appendOnly = resume.sourceDevIno === devIno
        && codexTailWatermarkValid(resume, stat)
        && prefixTokenOver(prefix, prefixBytes, resume.prefixLength) === resume.rewriteToken;
      if (!appendOnly) return undefined;
      startOffset = resume.size;
      startRecordIndex = resume.recordIndex;
      carriedSkips = resume.skippedRecords;
    }

    hooks?.beforeFirstPass?.();

    // Pass 1 — tool enrichment, under its own count and retained-byte ceilings.
    const wantsLocations = sink.acceptsLocations === true;
    const recordStarts: number[] = [];
    const recordEnds: number[] = [];
    const callRecords = new Map<string, number[]>();
    let callRefCount = 0;
    let nativeIndexOverflow = false;
    const enrichStore = resume?.enrichStore ?? new CodexEnrichStore();
    const enrich = enrichStore.entries;
    let enrichOverflow = false;
    const enrichScan = await scanFileLinesAsync(fd, size, (
      raw,
      start,
      end,
      recordIndex,
    ) => {
      if (wantsLocations) {
        if (
          recordIndex >= CODEX_HISTORY_READER_MAX_RECORDS
          || start > 0xffff_ffff
          || end > 0xffff_ffff
        ) {
          nativeIndexOverflow = true;
          return false;
        }
        recordStarts.push(start);
        recordEnds.push(end);
      }
      if (!raw.includes(CODEX_ENRICH_LINE_MARKER)) return true;
      const record = parseLineOrNull(raw);
      const id = record?.payload?.call_id;
      if (record == null || id == null) return true;
      if (wantsLocations) {
        const key = String(id);
        const refs = callRecords.get(key) ?? [];
        if (!callRecords.has(key)) callRecords.set(key, refs);
        refs.push(recordIndex);
        callRefCount += 1;
        if (
          callRecords.size > CODEX_HISTORY_READER_MAX_CALL_IDS
          || callRefCount > CODEX_HISTORY_READER_MAX_CALL_REFS
          || refs.length > CODEX_HISTORY_READER_MAX_CALL_REFS_PER_ID
        ) {
          nativeIndexOverflow = true;
          return false;
        }
      }
      enrichStore.accumulate(record);
      if (tailOnly) {
        // Bounded-window read: evict oldest-call-first exactly as the live tail
        // does, instead of refusing the whole source. Eviction is oldest-first
        // and the retained window is the NEWEST messages, so what survives is
        // precisely the enrichment those messages need.
        enrichStore.evictUntilWithin(
          CODEX_LIVE_ENRICH_MAX_ENTRIES,
          CODEX_LIVE_ENRICH_MAX_BYTES,
          String(id),
        );
        return true;
      }
      if (enrichStore.size > HISTORY_SNAPSHOT_MAX_ENRICH_ENTRIES
        || enrichStore.retainedBytes > HISTORY_SNAPSHOT_MAX_ENRICH_BYTES) {
        enrichOverflow = true;
        return false;
      }
      return true;
    }, { skipOversizedRecords: tailOnly, deadline, startOffset, startRecordIndex });
    if (enrichScan === 'timed-out') return { refusal: 'resource-limit' };
    hooks?.onScanRange?.(startOffset, enrichScan.bytes);
    if (
      enrichScan.recordOverflow
      || enrichOverflow
      || nativeIndexOverflow
    ) return { refusal: 'resource-limit' };

    const readerBuilder = wantsLocations
      ? new CodexHistoryPageReaderBuilder(
          path,
          size,
          stat.dev,
          stat.ino,
          stat.mtimeMs,
          stat.ctimeMs,
          prefix.subarray(0, prefixBytes),
          recordStarts,
          recordEnds,
          callRecords,
          hooks?.beforePageRecordReads,
        )
      : undefined;

    hooks?.betweenPasses?.();

    // Pass 2 — map and emit. Resident: one record, its lookahead, and the run tracker.
    const runtime = resume?.runtime ?? new CodexRuntimeTracker();
    // Folded beside the mapping so an over-ceiling observe tail can later inherit the
    // enclosing turn and the exact record count from this capture instead of a synthetic
    // byte-based line base (see {@link readObserveTailBaseline}).
    const tailContext = resume
      ? cloneActiveRolloutContext(resume.context)
      : {
          turnId: undefined,
          automaticApprovalDenials: 0,
          toolNameByCallId: new Map<string, string>(),
        };
    let tailOpenTaskTurnId = resume?.openTaskTurnId;
    let pending: { record: any; index: number } | undefined;
    let refused = false;
    const emit = (record: any, at: number, next: any): boolean => {
      const typeOrdinals = new Map<AgentMessage['type'], number>();
      for (const message of mapLine(
        record,
        at,
        enrich,
        runtime,
        next,
        published,
      )) {
        const typeOrdinal = typeOrdinals.get(message.type) ?? 0;
        typeOrdinals.set(message.type, typeOrdinal + 1);
        const location = readerBuilder?.register(
          message,
          at,
          typeOrdinal,
        );
        if (
          (readerBuilder && location === undefined)
          || !sink.accept(message, location)
        ) {
          refused = true;
          return false;
        }
      }
      return true;
    };
    const mapScan = await scanFileLinesAsync(fd, size, (raw, _start, _end, at) => {
      if (tailOnly) {
        const marker = rolloutTaskMarker(raw);
        if (marker?.kind === 'start') tailOpenTaskTurnId = marker.turnId;
        else if (
          marker?.kind === 'terminal'
          && (tailOpenTaskTurnId === undefined || tailOpenTaskTurnId === marker.turnId)
        ) {
          tailOpenTaskTurnId = undefined;
        }
      }
      const record = parseLineOrNull(raw);
      if (!record) return true;
      if (tailOnly) updateActiveRolloutContext(tailContext, record);
      if (pending && !emit(pending.record, pending.index, record)) return false;
      pending = { record, index: at };
      return true;
    }, { skipOversizedRecords: tailOnly, deadline, startOffset, startRecordIndex });
    if (mapScan === 'timed-out') return { refusal: 'resource-limit' };
    if (mapScan.recordOverflow) return { refusal: 'resource-limit' };
    hooks?.onScanRange?.(startOffset, mapScan.bytes);
    // Both passes decide skips from byte lengths alone, so a disagreement means
    // the file moved between them — retriable, never a silently different prefix.
    if (enrichScan.skippedRecords !== mapScan.skippedRecords) return undefined;
    if (refused) return { refusal: 'resource-limit' };
    if (pending && !emit(pending.record, pending.index, undefined)) return { refusal: 'resource-limit' };
    if (readerBuilder?.exceededBudget) return { refusal: 'resource-limit' };
    const totalSkippedRecords = carriedSkips + mapScan.skippedRecords;
    // The skip count is trustworthy from here, and every pending accepted
    // message has now reached the sink. Suppress only after that final flush:
    // when the skipped record is last, suppressing first lets the preceding old
    // state be accepted afterwards and resurrected as CURRENT. The party that
    // skipped must report the loss on every successful path, including direct
    // capture callers that bypass the broker's fallback wiring.
    if (mapScan.skippedRecords > 0) sink.suppressStateAuthority?.();
    // Both passes must have observed the SAME prefix — same byte count AND same content — or the
    // enrichment belongs to one revision and the messages to another under the original identity.
    // A short read or a content change means the file moved under the capture: retriable.
    if (enrichScan.bytes !== size || mapScan.bytes !== size) return undefined;
    if (!enrichScan.digest.equals(mapScan.digest)) return undefined;
    // Revalidate the source itself after the passes: still the same file, not shrunk, prefix
    // intact. An append beyond the captured boundary passes all three.
    const after = fstatSync(fd);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size < size) return undefined;
    // The pass digests only prove the two passes agreed with EACH OTHER. A same-size rewrite
    // in the window between the identity stat above and the first pass leaves both passes
    // observing the rewritten bytes — internally consistent, but stamped with the pre-rewrite
    // revision, which would let two captures racing such a write serve DIFFERENT content under
    // ONE identity. Any write that did not grow the file within the open-descriptor window
    // (mtime or ctime moved at an unchanged size; ctime also catches an mtime restored with
    // utimes) is therefore retried. A genuine append grows the size and stays admissible.
    if (after.size === size && (after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)) {
      return undefined;
    }
    const prefixAfter = Buffer.alloc(prefix.length);
    const prefixAfterBytes = prefix.length > 0 ? readSync(fd, prefixAfter, 0, prefixAfter.length, 0) : 0;
    if (prefixAfterBytes !== prefixBytes || !prefixAfter.subarray(0, prefixAfterBytes).equals(prefix.subarray(0, prefixBytes))) {
      return undefined;
    }

    const identity = Object.freeze({
      sourceId: `${path}:${stat.dev}:${stat.ino}`,
      revision: `${size}:${stat.mtimeMs}:${stat.ctimeMs}`,
      appendPosition: size,
      rewriteToken: createHash('sha256')
        .update(prefix.subarray(0, prefixBytes))
        .digest('base64url'),
    });
    const reader = readerBuilder?.finish(identity);
    if (wantsLocations && !reader) return { refusal: 'resource-limit' };
    // Freeze the watermark for this sink and for later observe baselines — but only at a clean
    // record boundary. A torn final line would make a resumed pass read the rest of that line
    // as a new record and shift every later index; leaving no resume entry makes the next
    // capture on this sink answer `undefined`, and the caller retries on a fresh sink.
    if (tailOnly && mapScan.endedAtRecordBoundary) {
      const watermark = {
        rewriteToken: identity.rewriteToken,
        prefixLength: prefixBytes,
        size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        recordIndex: mapScan.nextRecordIndex,
      };
      codexTailCaptureResumes.set(sink, {
        sourceDevIno: devIno,
        ...watermark,
        skippedRecords: totalSkippedRecords,
        enrichStore,
        runtime,
        context: tailContext,
        ...(tailOpenTaskTurnId !== undefined ? { openTaskTurnId: tailOpenTaskTurnId } : {}),
      });
      storeCodexTailPosition(devIno, {
        ...watermark,
        context: cloneActiveRolloutContext(tailContext),
        ...(tailOpenTaskTurnId !== undefined ? { openTaskTurnId: tailOpenTaskTurnId } : {}),
      });
    }
    return {
      identity,
      ...(reader ? { reader } : {}),
      // Both passes agreed on this count above, so it describes the captured prefix across the
      // original pass and every resume of it. Carried outward so the frame can admit that some
      // records inside the window were never read (H1c round 3, finding 5).
      ...(totalSkippedRecords > 0 ? { skippedRecords: totalSkippedRecords } : {}),
    };
  } catch (error) {
    // An allocation or string-length failure is a bound this source cannot satisfy, not a source
    // that moved: reporting it as transient made the client retry it indefinitely.
    if (error instanceof RangeError) return { refusal: 'resource-limit' };
    return undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function fileHistorySourceIdentity(path: string): HistorySourceIdentity | undefined {
  const stat = statSafe(path);
  if (!stat) return undefined;
  const prefix = Buffer.alloc(
    Math.min(HISTORY_SOURCE_REWRITE_PREFIX_BYTES, stat.size),
  );
  let prefixBytes = 0;
  try {
    const fd = openSync(path, 'r');
    try {
      prefixBytes = readSync(fd, prefix, 0, prefix.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const rewriteToken = createHash('sha256')
    .update(prefix.subarray(0, prefixBytes))
    .digest('base64url');
  return {
    sourceId: `${path}:${stat.dev}:${stat.ino}`,
    revision: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
    appendPosition: stat.size,
    rewriteToken,
  };
}

function resolveBin(bin: string): string | null {
  try {
    const override = bin === 'codex' ? process.env.COSYNCING_CODEX_BIN : undefined;
    if (override && existsSync(override)) return override;
    return Bun.which(bin);
  } catch {
    return null;
  }
}

function spawnCodex<
  const In extends Bun.SpawnOptions.Writable,
  const Out extends Bun.SpawnOptions.Readable,
  const Err extends Bun.SpawnOptions.Readable,
>(
  executable: string,
  args: readonly string[],
  options: Bun.SpawnOptions.SpawnOptions<In, Out, Err>,
): Bun.Subprocess<In, Out, Err> {
  const env = (options.env ?? process.env) as Readonly<Record<string, string | undefined>>;
  const invocation = resolveInvocation(executable, { env, platform: process.platform });
  if (!invocation) throw new Error(`Codex executable is unavailable: ${executable}`);
  return bunSpawnResolvedInvocation(invocation, args, options);
}
