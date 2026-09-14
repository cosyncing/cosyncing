/**
 * Grok Build adapter contract — bounded Observe plus a shipped writer measured
 * against authenticated Grok Build 1.0.13 ACP and store evidence.
 *
 *  1. Model ids come from summary.current_model_id; labels and effort choices
 *     come only from the ACP initialize _meta.modelState catalog.
 *  2. Discovery has no permission mode. A driven row publishes the launch mode
 *     the broker passed to its own child.
 *  3. Create accepts model/effort at child spawn and re-discovers the durable row.
 *  4. The UUIDv7 directory id equals summary.info.id and the ACP session id.
 *  5. Subagent parent mapping remains unsupported until a local capture exists.
 *  6. The nine measured update kinds map totally; unknown additive values become
 *     named neutral context with a trace, never a human bubble.
 *  7. Drive mints queued rows. Event-id-bearing live echoes correlate directly;
 *     id-less frames wait for their durable JSONL line and byte-fenced claim.
 *  8. Live and replay share one ACP-shaped mapper. Only frames with eventId map
 *     live; durable line identity supplies the fallback key for id-less frames.
 *  9. One session registry owns one identity-CAS Drive connection; nonmatching
 *     foreign durable user events demote and terminate it.
 * 10. turn_completed is durable; a replay ending after a user update is cancelled.
 * 11. Terminal handoff uses `grok --cwd <cwd> --resume <uuid>`; no true-sync wire exists.
 * 12. Unsupported: leader-socket live attach, rename/fork/clone, per-inference
 *     unified usage, subagent rows, Markdown transcript export, and artifacts.
 * 13. File/image echo is unmeasured, so native file input stays false.
 * 14. Joined clients reuse one ACP stdin, pending FIFO, permission map, and demotion.
 * 15. Focused suites plus registration/cross-client gates are root-wired.
 * 16. Registration spans runtime, setup/service PATH, client labels, manifests,
 *     support evidence, and public docs.
 * 17. Create and Drive require Grok Build >= GROK_MINIMUM_SUPPORTED_VERSION
 *     plus reusable cached-token ACP auth; newer builds are admitted without
 *     enumeration. Resume is limited to ids with durable app-created provenance.
 */
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AcpClient } from '@cosyncing/acp-client';
import {
  DISCOVERY_ROW_BATCH,
  NativeSessionUnresumableError,
  TerminalSummaryRegistry,
  mapInBatches,
  resolveInvocation,
  type AgentBackend,
  type AgentCapabilities,
  type AgentSetupDiagnosis,
  type AttachMode,
  type HistorySourceIdentity,
  type ModelOption,
  type ModeOption,
  type PromptInput,
  type SessionConnection,
  type SessionInfo,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import { diagnoseGrokSetup } from './diagnostics.ts';
import { authenticateGrokClient } from './auth.ts';
import {
  GROK_PERMISSION_MODES,
  GrokDriveConnection,
  grokLoadedReasoningEffort,
  parseGrokModelCatalog,
} from './drive.ts';
import {
  GrokObserveConnection,
  GrokReplayCorrelationRegistry,
  type GrokReplayCorrelation,
  type GrokReplayCorrelations,
  type GrokTerminalSummary,
} from './observe.ts';
import {
  GROK_MINIMUM_SUPPORTED_VERSION,
  discoverGrokStore,
  grokHistorySourceIdentity,
  grokStoreRoot,
  type GrokStoredSession,
} from './store.ts';
import { grokBinaryMatchesVerifiedVersion, grokChildEnv } from './version.ts';

export const GROK_CAPABILITIES: AgentCapabilities = Object.freeze({
  integrationKind: 'acp-stdio',
  attachModes: ['observe', 'resume'] as AttachMode[],
  supportsObserve: true,
  supportsResume: true,
  supportsLiveAttach: false,
  supportsCrossClientDriveSharing: true,
  supportsNativeArtifact: false,
  supportsNativeFileInput: false,
  supportsModelSwitch: true,
  permissionGranularity: 'per-tool',
});

function preserveModelLabel(
  native: SessionInfo['currentModel'],
  fallback: SessionInfo['currentModel'],
): SessionInfo['currentModel'] {
  if (!native) return fallback ? { ...fallback } : undefined;
  if (native.label || !fallback?.label
    || native.providerID !== fallback.providerID
    || native.modelID !== fallback.modelID) return { ...native };
  return { ...native, label: fallback.label };
}

export interface GrokAdapterOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  requestTimeoutMs?: number;
  authMethodId?: string;
  resolveStoredDriveState?: (info: {
    tool: string;
    id: string;
    nativeId?: string;
  }) => {
    currentModel?: SessionInfo['currentModel'];
    currentMode?: string;
    historyBoundary?: HistorySourceIdentity;
    terminalSummaries?: readonly GrokTerminalSummary[];
  } | undefined;
  revokeStoredDriveEligibility?: (info: { tool: string; id: string; nativeId?: string }) => void;
  recordStoredDriveBoundary?: (info: {
    tool: string;
    id: string;
    nativeId?: string;
    historyBoundary: HistorySourceIdentity;
    terminalSummary?: GrokTerminalSummary;
  }) => void;
  /** @deprecated The floor-gated writer is shipped; retained for fixture compatibility. */
  testOnlyEnableUnverifiedDrive?: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function control(driving: boolean, eligible: boolean, candidateEnabled: boolean): SessionInfo['control'] {
  return {
    drive: driving
      ? { state: 'driving', supported: true, handoffAvailable: true }
      : eligible
        ? { state: 'observing', supported: true }
        : { state: 'observing', supported: false, reason: candidateEnabled
          ? 'Grok Drive is restricted to sessions created by this broker installation.'
          : `Grok Drive requires Grok Build ${GROK_MINIMUM_SUPPORTED_VERSION} or newer and durable app-created ownership.` },
    terminalSync: {
      supported: false,
      syncAvailable: false,
      active: false,
      reason: candidateEnabled
        ? 'Grok exposes terminal resume but no measured channel that joins a running TUI to the broker-owned ACP child.'
        : `Grok terminal resume is available for observation, but Drive requires Grok Build ${GROK_MINIMUM_SUPPORTED_VERSION} or newer.`,
    },
  };
}

function sessionInfo(
  session: GrokStoredSession,
  driving = false,
  eligible = false,
  attachMode?: AttachMode,
  candidateEnabled = false,
): SessionInfo {
  const isSubagent = session.origin === 'subagent';
  const effectiveDriving = !isSubagent && driving;
  const effectiveEligible = !isSubagent && eligible;
  return {
    id: session.id,
    nativeId: session.id,
    tool: 'grok',
    title: session.title,
    cwd: session.cwd,
    status: session.status,
    attachMode: isSubagent ? 'observe' : attachMode ?? (effectiveDriving || effectiveEligible ? 'resume' : 'observe'),
    ...(isSubagent ? { origin: 'subagent' as const, parentThreadId: session.parentThreadId } : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(session.currentModel ? { currentModel: session.currentModel } : {}),
    ...(session.currentAgent ? { currentAgent: session.currentAgent } : {}),
    ...(effectiveDriving ? { currentMode: 'default' } : {}),
    ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
    ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
    ...(!isSubagent ? { terminalSyncHint: {
      label: 'Resume in Grok',
      command: `grok --cwd ${shellQuote(session.cwd)} --resume ${shellQuote(session.id)}`,
      note: 'This hands control to a separate terminal process; it does not join the broker-owned ACP child.',
    } } : {}),
    control: isSubagent ? {
      drive: {
        state: 'observing',
        supported: false,
        reason: 'Grok subagent sessions are Observe-only; native child resume ownership is unmeasured.',
      },
      terminalSync: {
        supported: false,
        syncAvailable: false,
        active: false,
        reason: 'Grok subagent terminal handoff is unmeasured.',
      },
    } : control(effectiveDriving, effectiveEligible, candidateEnabled),
  };
}

export class GrokAdapter implements AgentBackend {
  readonly id = 'grok';
  readonly displayName = 'Grok Build';
  readonly capabilities: AgentCapabilities;
  private readonly command: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly root: string;
  private readonly requestTimeoutMs?: number;
  private readonly authMethodId?: string;
  private readonly resolveStoredDriveState?: GrokAdapterOptions['resolveStoredDriveState'];
  private readonly revokeStoredDriveEligibility?: GrokAdapterOptions['revokeStoredDriveEligibility'];
  private readonly recordStoredDriveBoundary?: GrokAdapterOptions['recordStoredDriveBoundary'];
  private readonly driveEligible = new Set<string>();
  private readonly driveModes = new Map<string, string>();
  private readonly driveModels = new Map<string, SessionInfo['currentModel']>();
  private readonly driveTitles = new Map<string, string>();
  private readonly drivenSessions = new Map<string, GrokDriveConnection>();
  private readonly pendingDriveOpens = new Set<string>();
  private readonly replayCorrelations = new Map<string, GrokReplayCorrelations>();
  private readonly terminalSummaries = new Map<string, TerminalSummaryRegistry<GrokTerminalSummary>>();
  private cachedModels?: ModelOption[];
  private authReadiness?: { checkedAt: number; ready: boolean };

  constructor(options: GrokAdapterOptions = {}) {
    this.capabilities = GROK_CAPABILITIES;
    this.env = options.env ?? process.env;
    this.command = options.command ?? (this.env.COSYNCING_GROK_BIN?.trim() || 'grok');
    this.root = grokStoreRoot(this.env, options.homeDir);
    if (options.requestTimeoutMs !== undefined) this.requestTimeoutMs = options.requestTimeoutMs;
    if (options.authMethodId) this.authMethodId = options.authMethodId;
    if (options.resolveStoredDriveState) this.resolveStoredDriveState = options.resolveStoredDriveState;
    if (options.revokeStoredDriveEligibility) this.revokeStoredDriveEligibility = options.revokeStoredDriveEligibility;
    if (options.recordStoredDriveBoundary) this.recordStoredDriveBoundary = options.recordStoredDriveBoundary;
  }

  async isAvailable(): Promise<boolean> {
    return resolveInvocation(this.command, { env: this.env }) !== undefined;
  }

  diagnoseSetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
    return diagnoseGrokSetup(context);
  }

  async discoverSessions(options?: { updatedAfter?: number }): Promise<SessionInfo[]> {
    const candidateEnabled = this.hasPinnedBinaryVersion();
    // Batched, not fanned out over every row at once: each element below opens
    // the session's `updates.jsonl` for its boundary, so an unbounded map is one
    // simultaneous fd per discovered session inside a process already running
    // several discovery legs. `discoverGrokStore` batches its own `summary.json`
    // reads 16 at a time for the same reason.
    return mapInBatches(
      await discoverGrokStore({ root: this.root, updatedAfter: options?.updatedAfter }),
      DISCOVERY_ROW_BATCH,
      async (session) => {
        const isSubagent = session.origin === 'subagent';
        const activeDrive = !isSubagent && this.isDriving(session.id);
        const stored = isSubagent ? undefined : this.resolveStoredDriveState?.({
          tool: this.id,
          id: session.id,
          nativeId: session.id,
        });
        const currentBoundary = await grokHistorySourceIdentity(session);
        const storedBoundaryValid = stored?.historyBoundary !== undefined
          && sameHistoryBoundary(stored.historyBoundary, currentBoundary);
        if (stored?.historyBoundary && currentBoundary !== undefined
          && !storedBoundaryValid && !activeDrive) {
          this.invalidateDriveEligibility(session.id);
        }
        const eligible = candidateEnabled && !isSubagent
          && (activeDrive || this.driveEligible.has(session.id) || storedBoundaryValid);
        const info = sessionInfo(
          session,
          !isSubagent && this.isDriving(session.id),
          eligible,
          undefined,
          candidateEnabled,
        );
        const mode = isSubagent ? undefined : this.driveModes.get(session.id) ?? stored?.currentMode;
        const model = isSubagent ? undefined
          : this.driveModels.get(session.id)
            ?? preserveModelLabel(session.currentModel, stored?.currentModel);
        const title = isSubagent ? undefined : this.driveTitles.get(session.id);
        if (mode) info.currentMode = mode;
        if (model) info.currentModel = { ...model };
        if (title) info.title = title;
        return info;
      },
    );
  }

  async canCreateSession(): Promise<boolean> {
    if (!this.hasPinnedBinaryVersion()) return false;
    const now = Date.now();
    if (this.authReadiness && now - this.authReadiness.checkedAt < 30_000) {
      return this.authReadiness.ready;
    }
    let ready = false;
    let client: AcpClient | undefined;
    try {
      client = await AcpClient.connect({
        command: this.command,
        args: ['agent', '--no-leader', 'stdio'],
        cwd: process.cwd(),
        env: grokChildEnv(this.env),
        requestTimeoutMs: this.requestTimeoutMs,
      });
      await authenticateGrokClient(client, this.authMethodId);
      ready = true;
    } catch {
      ready = false;
    } finally {
      await client?.close().catch(() => undefined);
    }
    this.authReadiness = { checkedAt: now, ready };
    return ready;
  }

  /**
   * THROWS when the catalogue is unavailable, rather than answering `[]`.
   *
   * An empty array is authoritative to the broker: create answers 409 "selected
   * model 'x/y' is no longer available", asserting something a failed ACP
   * handshake never established. A throw reaches the channel the broker already
   * built for this — `ModelCatalogUnavailableError` -> 503
   * MODEL_CATALOG_UNAVAILABLE. Grok's own drive path (`drive.ts:643-665`)
   * already rethrows rather than serving `[]`; this is the same rule one level
   * up.
   *
   * The empty catalogue is also no longer CACHED. `[]` is truthy, so a single
   * handshake that produced no `modelState` was remembered for the life of the
   * process and every later create was refused against it.
   */
  async listModels(): Promise<ModelOption[]> {
    if (!this.hasPinnedBinaryVersion()) {
      throw new Error(`Grok model catalog requires Grok Build ${GROK_MINIMUM_SUPPORTED_VERSION} or newer.`);
    }
    if (this.cachedModels?.length) return this.cachedModels.map((model) => ({ ...model }));
    const client = await AcpClient.connect({
      command: this.command,
      args: ['agent', '--no-leader', 'stdio'],
      cwd: process.cwd(),
      env: grokChildEnv(this.env),
      requestTimeoutMs: this.requestTimeoutMs,
    });
    try {
      await authenticateGrokClient(client, this.authMethodId);
      const meta = client.initializeResult?._meta;
      const models = meta && typeof meta === 'object' && !Array.isArray(meta)
        ? parseGrokModelCatalog((meta as Record<string, unknown>).modelState)
        : [];
      if (models.length === 0) {
        throw new Error('Grok ACP initialize reported no model catalog.');
      }
      this.cachedModels = models;
      return models.map((model) => ({ ...model }));
    } finally {
      await client.close();
    }
  }

  async listModes(): Promise<ModeOption[]> {
    if (!this.hasPinnedBinaryVersion()) return [];
    return GROK_PERMISSION_MODES.map((mode) => ({ ...mode }));
  }

  async createSession(options: {
    directory?: string;
    title?: string;
    model?: PromptInput['model'];
    permissionMode?: string;
  } = {}): Promise<SessionInfo> {
    if (!this.hasPinnedBinaryVersion()) {
      throw new NativeSessionUnresumableError(`Grok create requires Grok Build ${GROK_MINIMUM_SUPPORTED_VERSION} or newer.`);
    }
    const requestedMode = options.permissionMode ?? 'default';
    if (!GROK_PERMISSION_MODES.some((mode) => mode.value === requestedMode)) {
      throw new NativeSessionUnresumableError(`Grok permission mode ${requestedMode} has no physical native-behaviour capture.`);
    }
    const cwd = options.directory ?? process.cwd();
    if (!isAbsolute(cwd) || !await stat(cwd).then((value) => value.isDirectory(), () => false)) {
      throw new NativeSessionUnresumableError('Grok create requires an existing absolute workspace directory.');
    }
    const model = options.model
      ? options.model.providerID === 'xai' ? options.model.modelID : `${options.model.providerID}/${options.model.modelID}`
      : undefined;
    const client = await AcpClient.connect({
      command: this.command,
      args: [
        '--permission-mode', requestedMode,
        'agent', '--no-leader',
        ...(model ? ['--model', model] : []),
        ...(options.model?.reasoningEffort ? ['--reasoning-effort', options.model.reasoningEffort] : []),
        'stdio',
      ],
      cwd,
      env: grokChildEnv(this.env),
      requestTimeoutMs: this.requestTimeoutMs,
    });
    let createdId: string | undefined;
    let createdIsNew = false;
    try {
      await authenticateGrokClient(client, this.authMethodId);
      const existingIds = new Set((await discoverGrokStore({ root: this.root })).map((session) => session.id));
      const created = await client.sessionNew({ cwd, mcpServers: [] });
      if (typeof created.sessionId !== 'string' || !created.sessionId) throw new Error('Grok session/new returned no session id.');
      createdId = created.sessionId;
      if (existingIds.has(createdId)) {
        throw new Error(`Grok session/new reused existing durable session ${createdId}; refusing writer ownership.`);
      }
      createdIsNew = true;
      let session: GrokStoredSession | undefined;
      for (let attempt = 0; attempt < 40 && !session; attempt += 1) {
        session = (await discoverGrokStore({ root: this.root })).find((candidate) => candidate.id === createdId);
        if (!session) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!session) throw new Error(`Grok created ${createdId}, but no matching durable store row appeared.`);
      const loaded = await client.sessionLoad({ sessionId: createdId, cwd, mcpServers: [] });
      const loadedModels = isRecord(loaded.models) ? loaded.models : undefined;
      const loadedModes = isRecord(loaded.modes) ? loaded.modes : undefined;
      const effectiveModel = boundedSelection(loadedModels, ['currentModelId', 'currentModel']);
      const effectiveEffort = grokLoadedReasoningEffort(loadedModels);
      const effectiveMode = boundedSelection(loadedModes, ['currentModeId', 'currentMode']);
      if (model !== undefined && effectiveModel !== model) {
        throw new Error(`Grok session/new did not confirm requested model ${model}; session/load reported ${String(effectiveModel)}.`);
      }
      if (options.model?.reasoningEffort !== undefined
        && effectiveEffort !== options.model.reasoningEffort) {
        throw new Error(
          `Grok session/new did not confirm requested reasoning effort ${options.model.reasoningEffort}; session/load reported ${String(effectiveEffort)}.`,
        );
      }
      if (effectiveMode !== undefined && effectiveMode !== requestedMode) {
        throw new Error(`Grok session/new did not confirm requested permission mode ${requestedMode}; session/load reported ${String(effectiveMode)}.`);
      }
      this.driveEligible.add(createdId);
      this.driveModes.set(createdId, requestedMode);
      const catalog = parseGrokModelCatalog((client.initializeResult?._meta as Record<string, unknown> | undefined)?.modelState);
      const catalogModel = options.model
        ? catalog.find((candidate) => candidate.providerID === options.model!.providerID
          && candidate.modelID === options.model!.modelID)
        : undefined;
      const selectedModel = options.model
        ? { ...options.model, ...(catalogModel?.label ? { label: catalogModel.label } : {}) }
        : undefined;
      if (selectedModel) this.driveModels.set(createdId, selectedModel);
      if (options.title?.trim()) this.driveTitles.set(createdId, options.title.trim());
      const historyBoundary = await grokHistorySourceIdentity(session);
      if (historyBoundary) {
        this.recordStoredDriveBoundary?.({
          tool: this.id,
          id: createdId,
          nativeId: createdId,
          historyBoundary,
        });
      }
      const info = sessionInfo(session, false, true, undefined, true);
      info.currentMode = requestedMode;
      if (selectedModel) info.currentModel = { ...selectedModel };
      if (options.title?.trim()) info.title = options.title.trim();
      return info;
    } finally {
      if (createdId && createdIsNew && client.alive) {
        await client.sessionClose({ sessionId: createdId }, 250).catch(() => undefined);
      }
      await client.close();
    }
  }

  async attach(sessionId: string, mode: AttachMode = 'observe'): Promise<SessionConnection> {
    const session = (await discoverGrokStore({ root: this.root })).find((candidate) => candidate.id === sessionId);
    if (!session) throw new NativeSessionUnresumableError('Grok session is missing or its store identity is unsupported.');
    const isSubagent = session.origin === 'subagent';
    const activeDrive = !isSubagent && this.isDriving(session.id);
    const stored = isSubagent ? undefined : this.resolveStoredDriveState?.({
      tool: this.id,
      id: session.id,
      nativeId: session.id,
    });
    const currentBoundary = await grokHistorySourceIdentity(session);
    const storedBoundaryValid = stored?.historyBoundary !== undefined
      && sameHistoryBoundary(stored.historyBoundary, currentBoundary);
    if (stored?.historyBoundary && currentBoundary !== undefined
      && !storedBoundaryValid && !activeDrive) {
      this.invalidateDriveEligibility(session.id);
    }
    const eligible = this.hasPinnedBinaryVersion() && !isSubagent
      && (activeDrive || this.driveEligible.has(sessionId) || storedBoundaryValid);
    const sharedTerminalSummaries = !isSubagent && (activeDrive || storedBoundaryValid)
      ? this.sessionTerminalSummaries(
          sessionId,
          storedBoundaryValid ? stored?.historyBoundary : undefined,
          storedBoundaryValid ? stored?.terminalSummaries : undefined,
        )
      : undefined;
    if (mode === 'observe') {
      const info = sessionInfo(session, false, eligible, 'observe', this.hasPinnedBinaryVersion());
      const selectedModel = isSubagent ? undefined
        : this.driveModels.get(sessionId)
          ?? preserveModelLabel(session.currentModel, stored?.currentModel);
      if (selectedModel) info.currentModel = selectedModel;
      return new GrokObserveConnection({
        session,
        info,
        replayCorrelations: this.sessionReplayCorrelations(sessionId),
        ...(sharedTerminalSummaries ? {
          terminalSummaryRegistry: sharedTerminalSummaries,
          ...(storedBoundaryValid && stored?.historyBoundary
            ? { expectedTerminalSummaryBoundary: stored.historyBoundary }
            : {}),
          onTerminalSummaryBoundaryInvalid: () => {
            if (!activeDrive) this.invalidateDriveEligibility(sessionId);
          },
        } : {}),
      });
    }
    if (isSubagent) {
      throw new NativeSessionUnresumableError('Grok subagent sessions are Observe-only; native child resume ownership is unmeasured.');
    }
    if (mode !== 'resume') throw new Error(`Grok does not support ${mode} attach.`);
    if (!eligible) throw new NativeSessionUnresumableError('Grok Drive is limited to sessions created by this broker installation; Observe remains available.');
    if (!this.hasPinnedBinaryVersion()) throw new NativeSessionUnresumableError(`Grok Resume requires Grok Build ${GROK_MINIMUM_SUPPORTED_VERSION} or newer.`);
    if (this.drivenSessions.get(sessionId)?.driving || this.pendingDriveOpens.has(sessionId)) {
      throw new NativeSessionUnresumableError('Grok already has a Drive owner; join the existing broker connection instead of opening another child.');
    }
    this.pendingDriveOpens.add(sessionId);
    try {
      const info = sessionInfo(session, true, true, 'resume', true);
      const selectedModel = this.driveModels.get(sessionId)
        ?? preserveModelLabel(session.currentModel, stored?.currentModel);
      const selectedMode = this.driveModes.get(sessionId) ?? stored?.currentMode ?? 'default';
      const title = this.driveTitles.get(sessionId);
      info.currentMode = selectedMode;
      if (selectedModel) info.currentModel = { ...selectedModel };
      if (title) info.title = title;
      const connection = await GrokDriveConnection.open(session, info, {
        command: this.command,
        // Deliberately the live reference, NOT `grokChildEnv(this.env)`. The
        // connection holds this object and re-reads it on every lazy child
        // start, so wrapping here would hand it a snapshot taken at open time
        // and silently drop any later change to the environment. The updater
        // suppression is applied where the child is actually spawned, in
        // `GrokDriveConnection.ensureClient`.
        env: this.env,
        model: selectedModel?.providerID === 'xai' ? selectedModel.modelID
          : selectedModel ? `${selectedModel.providerID}/${selectedModel.modelID}` : session.model,
        reasoningEffort: selectedModel?.reasoningEffort,
        permissionMode: selectedMode,
        requestTimeoutMs: this.requestTimeoutMs,
        authMethodId: this.authMethodId,
        replayCorrelations: this.sessionReplayCorrelations(sessionId),
        terminalSummaryRegistry: this.sessionTerminalSummaries(
          sessionId,
          storedBoundaryValid ? stored?.historyBoundary : undefined,
          storedBoundaryValid ? stored?.terminalSummaries : undefined,
        ),
        notifyTerminalSummaryChanges: false,
        ...(storedBoundaryValid && stored?.historyBoundary
          ? { expectedHistoryBoundary: stored.historyBoundary }
          : {}),
        onConfiguration: (configured) => {
          if (configured.currentModel) this.driveModels.set(sessionId, { ...configured.currentModel });
          if (configured.currentMode) this.driveModes.set(sessionId, configured.currentMode);
        },
        onHistoryBoundary: (historyBoundary, terminalSummary) => {
          this.recordStoredDriveBoundary?.({
            tool: this.id,
            id: sessionId,
            nativeId: sessionId,
            historyBoundary,
            ...(terminalSummary ? { terminalSummary } : {}),
          });
        },
        onDemote: (demoting) => {
          if (this.drivenSessions.get(sessionId) === demoting) {
            this.driveEligible.delete(sessionId);
            this.driveModes.delete(sessionId);
            this.driveModels.delete(sessionId);
            this.driveTitles.delete(sessionId);
            this.revokeStoredDriveEligibility?.({ tool: this.id, id: sessionId, nativeId: sessionId });
          }
        },
        onClose: (closing) => {
          if (this.drivenSessions.get(sessionId) === closing) this.drivenSessions.delete(sessionId);
        },
      });
      this.drivenSessions.set(sessionId, connection);
      return connection;
    } catch (error) {
      throw new NativeSessionUnresumableError(`Grok refused session/load: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.pendingDriveOpens.delete(sessionId);
    }
  }

  releaseDriveEligibility(sessionId: string): void {
    this.invalidateDriveEligibility(sessionId);
  }
  isDriving(sessionId: string): boolean { return this.drivenSessions.get(sessionId)?.driving === true; }
  driveConnection(sessionId: string): GrokDriveConnection | undefined { return this.drivenSessions.get(sessionId); }

  private hasPinnedBinaryVersion(): boolean {
    return grokBinaryMatchesVerifiedVersion(this.command, this.env);
  }

  private invalidateDriveEligibility(sessionId: string): void {
    this.driveEligible.delete(sessionId);
    this.driveModes.delete(sessionId);
    this.driveModels.delete(sessionId);
    this.driveTitles.delete(sessionId);
    this.replayCorrelations.delete(sessionId);
    const summaries = this.terminalSummaries.get(sessionId);
    this.terminalSummaries.delete(sessionId);
    summaries?.clear();
    this.revokeStoredDriveEligibility?.({ tool: this.id, id: sessionId, nativeId: sessionId });
  }

  private sessionReplayCorrelations(sessionId: string): GrokReplayCorrelations {
    const existing = this.replayCorrelations.get(sessionId);
    if (existing) return existing;
    const created = new GrokReplayCorrelationRegistry();
    this.replayCorrelations.set(sessionId, created);
    return created;
  }

  private sessionTerminalSummaries(
    sessionId: string,
    boundary?: HistorySourceIdentity,
    initial?: readonly GrokTerminalSummary[],
  ): TerminalSummaryRegistry<GrokTerminalSummary> {
    const existing = this.terminalSummaries.get(sessionId);
    if (existing) return existing;
    const created = new TerminalSummaryRegistry<GrokTerminalSummary>();
    if (boundary) created.hydrate(boundary, initial ?? []);
    this.terminalSummaries.set(sessionId, created);
    return created;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameHistoryBoundary(
  expected: HistorySourceIdentity,
  current: HistorySourceIdentity | undefined,
): boolean {
  return current !== undefined
    && expected.sourceId === current.sourceId
    && expected.revision === current.revision
    && expected.appendPosition === current.appendPosition
    && expected.rewriteToken === current.rewriteToken;
}

function boundedSelection(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 512) return value;
  }
  return undefined;
}
