/**
 * Cline adapter contract — bounded store Observe plus broker-owned Hub Drive,
 * measured against Cline 3.0.60 / Hub core 0.0.81 on 2026-08-30/31, and carried
 * to Cline 3.0.61 / Hub core 0.0.82 on 2026-09-08 by re-measuring the launch
 * surface only: 3.0.61 dropped `--cline-hub-daemon` and its host/port/pathname
 * arguments, which now travel in the environment. Protocol stayed v1.
 *
 *  1. Provider/model strings come from session metadata; no family table or
 *     unmeasured display catalog is invented.
 *  2. Native act/plan plus auto-approval mapping is retained for writer tests.
 *  3. Shipped Create/Resume uses only the isolated broker-owned Hub/profile.
 *  4. The directory, metadata, message document, and --id resume share one id.
 *  5. Subagent documents publish child nativeId plus the parent's nativeId.
 *  6. Role + block type maps totally; unknown blocks become named neutral rows.
 *  7. Observe mints no prompts. Candidate queue semantics wait for Drive probes.
 *  8. Replay and tail reparse one rewritten snapshot and key by message id.
 *  9. Observe has no writer authority or ownership claim.
 * 10. A metadata row claiming running with a dead pid is interrupted, not live.
 * 11. Parent terminal handoff uses `cline --id <sessionId>`; it is not sync.
 * 12. Unsupported: teams, schedules, fork/clone/export, and artifact delivery.
 * 13. Native file/image input remains false until an attachment echo is captured.
 * 14. Default-profile Observe owns no process; managed-profile Drive is shared
 *     only through the broker and fenced by durable app-created ownership.
 * 15. Store/mapping/Observe/registration suites are root-gate wired.
 * 16. Registration spans runtime, doctor/setup/service, client copy, and evidence.
 * 17. The fixture-only ACP writer remains test-only. Production uses Hub v1's
 *     direct run reply followed by an exact durable transcript reread.
 */
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { AcpClient } from '@cosyncing/acp-client';
import {
  CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE,
  DISCOVERY_ROW_BATCH,
  EXTERNAL_HOST_DISCOVERY_BUDGET_MS,
  NativeSessionRenameUnsupportedError,
  NativeSessionUnresumableError,
  TerminalSummaryRegistry,
  bunSpawnResolvedInvocation,
  mapInBatches,
  resolveInvocation,
  type AgentBackend,
  type AgentCapabilities,
  type AgentSetupDiagnosis,
  type AttachMode,
  type HistorySourceIdentity,
  type ManagedHostDescriptor,
  type ManagedHostIdentityInputs,
  type ModelOption,
  type ModeOption,
  type PromptInput,
  type SessionConnection,
  type SessionDiscoveryOptions,
  type SessionInfo,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import { diagnoseClineSetup } from './diagnostics.ts';
import { resolveClineAcpEnvironment } from './auth.ts';
import { ClineDriveConnection } from './drive.ts';
import {
  ClineHubCreateBoundaryUnprovenError,
  ClineHubDriveConnection,
  isTurnInternalRow,
} from './hub-drive.ts';
import {
  CLINE_HUB_READY_TIMEOUT_MS,
  CLINE_HUB_STOP_GRACE_MS,
  ClineHubClient,
  clineChildEnvWithoutHubLaunch,
  clineHubEpoch,
  clineHubHistoryIdentity,
  clineManagedDataRoot,
  clineManagedHubDiscoveryPath,
  clineManagedHubIdentity,
  clineManagedHubPort,
  parseClineHubMessages,
  probeClineHub,
  type ClineHubClientOptions,
  type ClineHubDiscovery,
  type ClineHubSocketFactory,
} from './hub.ts';
import type { ClineMapTrace, ClineTerminalSummary } from './mapping.ts';
import { ClineObserveConnection, type ClineObserveOptions } from './observe.ts';
import {
  CLINE_MINIMUM_SUPPORTED_VERSION,
  clineDataRoot,
  clineHistorySourceIdentity,
  clineStoreRoot,
  clineTerminalSummaryBoundaryFromNative,
  ClinePromptCorrelationRegistry,
  discoverClineStore,
  readClineMessages,
  type ClinePromptCorrelation,
  type ClinePromptCorrelations,
  type ClineStoredSession,
  type ClineStoreTrace,
} from './store.ts';
import { clineBinaryMatchesVerifiedVersion, clineVerifiedInvocation } from './version.ts';

export const CLINE_CAPABILITIES: AgentCapabilities = Object.freeze({
  integrationKind: 'http-websocket',
  attachModes: ['observe', 'resume'] as AttachMode[],
  supportsObserve: true,
  supportsResume: true,
  supportsLiveAttach: false,
  supportsCrossClientDriveSharing: true,
  supportsNativeArtifact: false,
  supportsNativeFileInput: false,
  supportsModelSwitch: false,
  permissionGranularity: 'per-tool',
});

const CLINE_TEST_DRIVE_CAPABILITIES: AgentCapabilities = Object.freeze({
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

const CLINE_CREATION_MODES: readonly ModeOption[] = Object.freeze([
  { value: 'ask', label: 'Ask permission', description: 'Require approval before Cline uses tools.' },
  { value: 'auto', label: 'Approve for me', description: 'Allow Cline to auto-approve tools for this child.' },
  { value: 'plan', label: 'Plan', description: 'Start Cline in plan mode with tool auto-approval disabled.' },
]);

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

export interface ClineAdapterOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  processAlive?: (pid: number) => boolean;
  trace?: (event: ClineStoreTrace | ClineMapTrace | { op: 'observe'; detail: string }) => void;
  observe?: Omit<ClineObserveOptions, 'session' | 'info' | 'trace'>;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  authMethodId?: string;
  fetcher?: typeof globalThis.fetch;
  hubSocketFactory?: ClineHubSocketFactory;
  hubClientFactory?: (options: ClineHubClientOptions) => ClineHubClient;
  isManagedHostOwned?: (identityKey: string) => boolean | Promise<boolean>;
  onUnsafeManagedAuthority?: (reason: string) => Promise<void>;
  authoritySettleTimeoutMs?: number;
  resolveStoredDriveState?: (info: {
    tool: string;
    id: string;
    nativeId?: string;
  }) => {
    currentModel?: SessionInfo['currentModel'];
    currentMode?: string;
    historyBoundary?: HistorySourceIdentity;
    promptCorrelations?: readonly ClinePromptCorrelation[];
    terminalSummaries?: readonly ClineTerminalSummary[];
  } | undefined;
  revokeStoredDriveEligibility?: (info: { tool: string; id: string; nativeId?: string }) => void;
  recordStoredDriveBoundary?: (info: {
    tool: string;
    id: string;
    nativeId?: string;
    historyBoundary: HistorySourceIdentity;
    terminalSummary?: ClineTerminalSummary;
  }) => void;
  recordStoredPromptCorrelation?: (info: {
    tool: string;
    id: string;
    nativeId?: string;
    correlation: ClinePromptCorrelation;
  }) => void;
  /** Enables the unshipped ACP writer only in deterministic adapter fixtures. */
  testOnlyEnableUnverifiedDrive?: boolean;
  /** Extra deterministic-fixture models; native secure provider config remains authoritative. */
  testOnlyModels?: ModelOption[];
  /** Bounded lease for the exact ACP child that answered session/new. */
  pendingCreateTimeoutMs?: number;
  /** Deterministic fixture override for Hub requests and durable proof polling. */
  renameTimeoutMs?: number;
  /** Deterministic fixture override for the measured native history-update child. */
  nativeRenameTimeoutMs?: number;
  /** Deterministic fixture gate immediately before ACP Create publication. */
  testOnlyBeforeCandidateCreatePublication?: () => Promise<void>;
}

type ClineWriterConnection = ClineDriveConnection | ClineHubDriveConnection;

interface PendingCreatedOwner {
  connection: ClineWriterConnection;
  claimed: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_PENDING_CREATE_TIMEOUT_MS = 60_000;
export const CLINE_NATIVE_RENAME_TIMEOUT_MS = 30_000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function boundedConfiguration(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length <= 512 && !/[\0\r\n]/u.test(normalized)
    ? normalized
    : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function responseSessionId(value: Record<string, unknown>): string | undefined {
  const session = recordOf(value.session);
  const snapshot = recordOf(value.snapshot);
  return boundedConfiguration(
    typeof session?.sessionId === 'string' ? session.sessionId
      : typeof snapshot?.sessionId === 'string' ? snapshot.sessionId
        : typeof value.sessionId === 'string' ? value.sessionId
          : undefined,
  );
}

function isDriving(connection: ClineWriterConnection | undefined): boolean {
  return connection?.info.control?.drive.state === 'driving';
}

function sessionInfo(
  session: ClineStoredSession,
  command: string,
  candidate = false,
  eligible = false,
  driving = false,
  mode?: string,
): SessionInfo {
  return {
    id: session.id,
    nativeId: session.nativeId,
    tool: 'cline',
    title: session.title,
    cwd: session.cwd,
    status: session.status === 'running' ? 'working' : 'idle',
    // Driving only, matching reasonix (`implementation.ts:125`,
    // `driving ? 'resume' : 'observe'`). Including `eligible` made every
    // Drive-ELIGIBLE session report `resume` even to a connection that is
    // plainly observing: the late reader asks for `mode: 'observe'`, gets a
    // frame saying `resume`, and its own `control.drive` says
    // `{state: "observing", supported: true}` in the same breath. Reasonix and
    // OMP sessions are `resume`-capable too and label their observe connections
    // correctly; only cline did not.
    //
    // Eligibility still reaches the client -- it is what `control.drive.supported`
    // is for, and the agent record advertises `attachModes` -- so nothing is
    // lost by keeping this field to what the connection IS rather than what the
    // session COULD be. That matters because `roster-overlay.ts` ranks on this
    // field and copies it onto the roster row, so an eligible-but-observing
    // connection was advertising a mode it was not in.
    attachMode: driving ? 'resume' : 'observe',
    ...(session.model ? { model: session.model } : {}),
    ...(session.currentModel ? { currentModel: session.currentModel } : {}),
    ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
    ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
    ...(session.origin ? { origin: session.origin } : {}),
    ...(session.parentThreadId ? { parentThreadId: session.parentThreadId } : {}),
    ...(mode ? { currentMode: mode } : {}),
    ...(!session.origin ? {
      terminalSyncHint: {
        label: 'Resume in Cline',
        command: `${shellQuote(command)} --data-dir ${shellQuote(session.dataRoot)} --id ${shellQuote(session.id)}`,
        note: 'This starts a separate Cline process; it does not join a cosyncing Drive connection.',
      },
    } : {}),
    control: {
      drive: {
        state: driving ? 'driving' : 'observing',
        supported: driving || eligible,
        ...(driving || eligible ? {} : { reason: candidate
          ? 'Cline Drive is restricted to sessions created in this broker-owned managed profile.'
          : 'Existing Cline sessions are Observe-only; Drive uses the isolated broker-owned Hub/profile.' }),
      },
      terminalSync: {
        supported: false,
        syncAvailable: false,
        active: false,
        reason: session.origin
          ? 'Cline subagent snapshots are observe-only and have no independent terminal resume contract.'
          : 'Cline --id resumes in a separate process; no measured channel joins it to this Observe connection.',
      },
    },
  };
}

export class ClineAdapter implements AgentBackend {
  readonly id = 'cline';
  readonly displayName = 'Cline';
  readonly integration = { externalHost: { managed: true as const } };
  readonly discoveryBudgetMs = EXTERNAL_HOST_DISCOVERY_BUDGET_MS;
  readonly capabilities: AgentCapabilities;
  /** `http-websocket` would crash pre-revision-14 strict decoders. */
  readonly minimumClientRevision = CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE;

  private readonly command: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDir?: string;
  private readonly processAlive?: (pid: number) => boolean;
  private readonly trace?: ClineAdapterOptions['trace'];
  private readonly observe?: ClineAdapterOptions['observe'];
  private readonly requestTimeoutMs?: number;
  private readonly promptTimeoutMs?: number;
  private readonly authMethodId?: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly hubSocketFactory?: ClineHubSocketFactory;
  private readonly hubClientFactory: (options: ClineHubClientOptions) => ClineHubClient;
  private readonly isManagedHostOwned?: ClineAdapterOptions['isManagedHostOwned'];
  private readonly onUnsafeManagedAuthority?: ClineAdapterOptions['onUnsafeManagedAuthority'];
  private readonly authoritySettleTimeoutMs?: number;
  private readonly candidateDrive: boolean;
  private readonly candidateModels: ModelOption[];
  private readonly driveEligible = new Set<string>();
  private readonly driveModes = new Map<string, string>();
  private readonly driveModels = new Map<string, SessionInfo['currentModel']>();
  private readonly driveTitles = new Map<string, string>();
  private readonly ambiguousSessionIds = new Set<string>();
  private readonly driven = new Map<string, ClineWriterConnection>();
  private readonly opening = new Map<string, symbol>();
  private readonly nativeMutations = new Set<string>();
  private readonly pendingCreatedOwners = new Map<string, PendingCreatedOwner>();
  private readonly pendingCreateTimeoutMs: number;
  private readonly renameTimeoutMs: number;
  private readonly nativeRenameTimeoutMs: number;
  private readonly beforeCandidateCreatePublication?: () => Promise<void>;
  private readonly resolveStoredDriveState?: ClineAdapterOptions['resolveStoredDriveState'];
  private readonly revokeStoredDriveEligibility?: ClineAdapterOptions['revokeStoredDriveEligibility'];
  private readonly recordStoredDriveBoundary?: ClineAdapterOptions['recordStoredDriveBoundary'];
  private readonly recordStoredPromptCorrelation?: ClineAdapterOptions['recordStoredPromptCorrelation'];
  private readonly promptCorrelations = new Map<string, ClinePromptCorrelationRegistry>();
  private readonly terminalSummaries = new Map<string, TerminalSummaryRegistry<ClineTerminalSummary>>();
  declare readonly listModels?: () => Promise<ModelOption[]>;
  declare readonly listModes?: () => Promise<ModeOption[]>;
  declare readonly createSession?: (options?: {
    directory?: string;
    title?: string;
    model?: PromptInput['model'];
    permissionMode?: string;
  }) => Promise<SessionInfo>;

  constructor(options: ClineAdapterOptions = {}) {
    this.candidateDrive = options.testOnlyEnableUnverifiedDrive === true;
    this.capabilities = this.candidateDrive ? CLINE_TEST_DRIVE_CAPABILITIES : CLINE_CAPABILITIES;
    this.env = options.env ?? process.env;
    this.command = options.command ?? (this.env.COSYNCING_CLINE_BIN?.trim() || 'cline');
    if (options.homeDir) this.homeDir = options.homeDir;
    if (options.processAlive) this.processAlive = options.processAlive;
    if (options.trace) this.trace = options.trace;
    if (options.observe) this.observe = options.observe;
    if (options.requestTimeoutMs !== undefined) this.requestTimeoutMs = options.requestTimeoutMs;
    if (options.promptTimeoutMs !== undefined) this.promptTimeoutMs = options.promptTimeoutMs;
    if (options.authMethodId) this.authMethodId = options.authMethodId;
    this.fetcher = options.fetcher ?? globalThis.fetch;
    if (options.hubSocketFactory) this.hubSocketFactory = options.hubSocketFactory;
    this.hubClientFactory = options.hubClientFactory ?? ((clientOptions) => new ClineHubClient(clientOptions));
    this.isManagedHostOwned = options.isManagedHostOwned;
    this.onUnsafeManagedAuthority = options.onUnsafeManagedAuthority;
    if (options.authoritySettleTimeoutMs !== undefined) {
      this.authoritySettleTimeoutMs = options.authoritySettleTimeoutMs;
    }
    if (options.resolveStoredDriveState) this.resolveStoredDriveState = options.resolveStoredDriveState;
    if (options.revokeStoredDriveEligibility) this.revokeStoredDriveEligibility = options.revokeStoredDriveEligibility;
    if (options.recordStoredDriveBoundary) this.recordStoredDriveBoundary = options.recordStoredDriveBoundary;
    if (options.recordStoredPromptCorrelation) {
      this.recordStoredPromptCorrelation = options.recordStoredPromptCorrelation;
    }
    this.pendingCreateTimeoutMs = Number.isSafeInteger(options.pendingCreateTimeoutMs)
      && (options.pendingCreateTimeoutMs ?? 0) > 0
      ? options.pendingCreateTimeoutMs!
      : DEFAULT_PENDING_CREATE_TIMEOUT_MS;
    this.renameTimeoutMs = Number.isSafeInteger(options.renameTimeoutMs)
      && (options.renameTimeoutMs ?? 0) > 0
      ? options.renameTimeoutMs!
      : 10_000;
    this.nativeRenameTimeoutMs = Number.isSafeInteger(options.nativeRenameTimeoutMs)
      && (options.nativeRenameTimeoutMs ?? 0) > 0
      ? options.nativeRenameTimeoutMs!
      : CLINE_NATIVE_RENAME_TIMEOUT_MS;
    this.beforeCandidateCreatePublication = options.testOnlyBeforeCandidateCreatePublication;
    this.candidateModels = options.testOnlyModels?.map((model) => ({ ...model })) ?? [];
    if (this.candidateDrive) {
      this.listModels = () => this.listCandidateModels();
      this.listModes = () => this.listCandidateModes();
      this.createSession = (value = {}) => this.createCandidateSession(value);
    } else {
      this.listModels = () => this.listHubModels();
      this.listModes = () => this.listCandidateModes();
      this.createSession = (value = {}) => this.createHubSession(value);
    }
  }

  async isAvailable(): Promise<boolean> {
    if (resolveInvocation(this.command, { env: this.env })) return true;
    const root = clineDataRoot(this.env, this.homeDir);
    return stat(root).then((value) => value.isDirectory(), () => false);
  }

  async isManagedHostReady(options?: { signal?: AbortSignal }): Promise<boolean> {
    return (await probeClineHub({
      env: this.env,
      ...(this.homeDir ? { homeDir: this.homeDir } : {}),
      fetcher: this.fetcher,
      ...(options?.signal ? { signal: options.signal } : {}),
    })) !== undefined;
  }

  managedHostIdentity(inputs: ManagedHostIdentityInputs): string {
    return clineManagedHubIdentity(inputs.env, inputs.homeDir);
  }

  async describeManagedHost(): Promise<ManagedHostDescriptor> {
    const profileRoot = clineManagedDataRoot(this.env, this.homeDir);
    const port = clineManagedHubPort(this.env);
    const discoveryPath = clineManagedHubDiscoveryPath(this.env, this.homeDir);
    const invocation = await clineVerifiedInvocation(this.command, this.env);
    const launchable = invocation?.kind === 'native';
    return {
      identityKey: clineManagedHubIdentity(this.env, this.homeDir),
      locator: { kind: 'tcp-port', port },
      launch: launchable ? {
        command: invocation.executable,
        // 3.0.61 no longer accepts `--cline-hub-daemon` on the top-level
        // command: measured, it exits 1 with "unknown option" rather than
        // ignoring it, so a stale argv kills every start. Its bundled hub code
        // still knows the string internally, so this is the CLI's option set
        // tightening rather than the concept disappearing. The `cline hub`
        // subcommand offered instead takes no address arguments at all.
        // The daemon switch and the host/port/pathname triple travel in the
        // environment below, which is what keeps this Hub off the owner's
        // default-port Hub. `--cwd` survives as an argument, so it stays one.
        args: ['--cwd', this.homeDir ?? this.env.HOME ?? process.cwd()],
        env: {
          CLINE_NO_AUTO_UPDATE: '1',
          CLINE_RUN_AS_HUB_DAEMON: '1',
          CLINE_HUB_DISCOVERY_PATH: discoveryPath,
          CLINE_DATA_DIR: profileRoot,
          CLINE_SESSION_DATA_DIR: join(profileRoot, 'sessions'),
          CLINE_HUB_PORT: String(port),
          CLINE_HUB_HOST: '127.0.0.1',
          CLINE_HUB_PATHNAME: '/hub',
          CLINE_NO_INTERACTIVE: '1',
        },
        cwd: this.homeDir ?? this.env.HOME ?? process.cwd(),
      } : null,
      // No `version`. This descriptor is built BEFORE the Hub runs, so the only
      // version available here is the floor constant -- and `serving` is stored
      // as ownership evidence, where its contract is that an absent field is an
      // absent fact rather than a placeholder. Reporting the floor recorded a
      // Hub actually serving 0.0.83 as 0.0.82, which is the same constant-for-
      // measurement substitution that `readClineHubDiscovery` was fixed for.
      // The real core version is read from the Hub's own discovery document.
      serving: { port, profile: profileRoot },
      readyTimeoutMs: CLINE_HUB_READY_TIMEOUT_MS,
      stopGraceMs: CLINE_HUB_STOP_GRACE_MS,
    };
  }

  diagnoseSetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
    return diagnoseClineSetup(context);
  }

  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
    const sessions = await this.storedSessions(options);
    const descriptor = this.candidateDrive ? undefined : await this.describeManagedHost();
    const writerAvailable = this.candidateDrive
      ? await clineBinaryMatchesVerifiedVersion(this.command, this.env)
      : !!this.configuredHubModel()
        && await clineVerifiedInvocation(this.command, this.env) !== undefined
        && descriptor !== undefined
        && await this.isManagedHostOwned?.(descriptor.identityKey) === true
        && await this.isManagedHostReady({ ...(options?.signal ? { signal: options.signal } : {}) });
    const modelCatalog = writerAvailable
      ? (this.candidateDrive ? await this.listCandidateModels() : await this.listHubModels())
      : [];
    // ONE Hub probe for the whole pass. Created lazily and NOT awaited here: a
    // sweep with no managed session must not pay for a probe nobody reads, and
    // the sessions below share this promise rather than each issuing their own.
    // See `currentHistoryBoundary` for the measurement.
    let hubProbe: Promise<ClineHubDiscovery | undefined> | undefined;
    const sharedHubProbe = (): Promise<ClineHubDiscovery | undefined> => (hubProbe ??= probeClineHub({
      env: this.env,
      ...(this.homeDir ? { homeDir: this.homeDir } : {}),
      fetcher: this.fetcher,
    }));
    // Batched, not fanned out over all of them at once: each element below reads
    // this session's boundary and, for a managed row, its message snapshot. At
    // the 127 rows this store holds today an unbounded map is 127 simultaneous
    // file descriptors from ONE leg, inside a process already running several.
    // The width is the shared DISCOVERY_ROW_BATCH, which is where the reasoning
    // for the number lives — a narrow one starves this leg against its budget.
    return mapInBatches(sessions, DISCOVERY_ROW_BATCH, async (session) => {
      const isSubagent = session.origin === 'subagent';
      const managed = !this.candidateDrive && this.isManagedSession(session);
      const stored = isSubagent || (!this.candidateDrive && !managed) ? undefined : this.resolveStoredDriveState?.({
        tool: this.id,
        id: session.id,
        nativeId: session.nativeId,
      });
      const activeDriving = isDriving(this.driven.get(session.id));
      let currentBoundary = stored?.historyBoundary && !activeDriving
        ? await this.currentHistoryBoundary(session, sharedHubProbe())
        : undefined;
      let storedBoundaryValid = stored?.historyBoundary !== undefined
        && (activeDriving || (currentBoundary !== undefined
          && sameHistoryBoundary(stored.historyBoundary, currentBoundary)));
      let storedBoundaryInvalid = false;
      if (managed && stored?.historyBoundary && currentBoundary && !storedBoundaryValid) {
        // `writerAvailable` includes one exact listener/process ownership proof
        // for this roster snapshot. Reusing it here avoids launching `lsof`
        // once per stale durable row during post-restart reconciliation. These
        // calls only read native state; attach and every mutation still prove
        // ownership afresh.
        const reconciliation = await this.reconcileStoredManagedAssistantAppend(
          session,
          stored.historyBoundary,
          writerAvailable,
        );
        if (reconciliation.status === 'advanced') {
          currentBoundary = reconciliation.boundary;
          stored.historyBoundary = reconciliation.boundary;
          storedBoundaryValid = true;
        } else if (reconciliation.status === 'invalid') storedBoundaryInvalid = true;
      }
      if (stored?.historyBoundary && currentBoundary !== undefined && !storedBoundaryValid
        && (!managed || storedBoundaryInvalid)) {
        this.invalidateDriveEligibility(session.id);
      }
      const eligible = (writerAvailable || activeDriving) && !isSubagent
        && (this.candidateDrive || managed)
        && (this.driveEligible.has(session.id) || storedBoundaryValid);
      const info = sessionInfo(
        session,
        this.command,
        this.candidateDrive || managed,
        eligible,
        isDriving(this.driven.get(session.id)),
        this.driveModes.get(session.id) ?? session.currentMode ?? stored?.currentMode,
      );
      const nativeModel = this.driveModels.get(session.id)
        ?? preserveModelLabel(session.currentModel, stored?.currentModel);
      const catalogModel = nativeModel ? modelCatalog.find((candidate) =>
        candidate.providerID === nativeModel.providerID && candidate.modelID === nativeModel.modelID) : undefined;
      const model = preserveModelLabel(nativeModel, catalogModel);
      const title = this.candidateDrive ? this.driveTitles.get(session.id) : undefined;
      if (model) info.currentModel = { ...model };
      if (title) info.title = title;
      // This row is final. Report it now so a leg abandoned at its budget keeps
      // it: measured, this adapter's own work is about a second, and the elapsed
      // time that actually trips the budget is contention with the other legs
      // the registry fans out alongside it. Discarding every session over that
      // is the worst available answer, and the rows are already here.
      options?.onPartialRows?.([info]);
      return info;
    });
  }

  async canCreateSession(): Promise<boolean> {
    if (this.candidateDrive) {
      if (!await clineBinaryMatchesVerifiedVersion(this.command, this.env)) return false;
      if (this.authMethodId) return true;
      return (await resolveClineAcpEnvironment({ env: this.env })) !== undefined;
    }
    if (!await clineVerifiedInvocation(this.command, this.env) || !this.configuredHubModel()) return false;
    const descriptor = await this.describeManagedHost();
    return await this.isManagedHostOwned?.(descriptor.identityKey) === true
      && await this.isManagedHostReady();
  }

  private configuredHubModel(): ModelOption | undefined {
    const providerID = boundedConfiguration(this.env.COSYNCING_CLINE_PROVIDER);
    const modelID = boundedConfiguration(this.env.COSYNCING_CLINE_MODEL);
    return providerID && modelID ? { providerID, modelID, label: modelID } : undefined;
  }

  /** Throws rather than returning `[]` when the binary is off-version: an empty
   *  catalogue is authoritative to the broker and answers create with 409
   *  "that model is no longer available", which is not what an unverified
   *  binary establishes. A configured-but-unset hub model is a genuine empty. */
  private async listHubModels(): Promise<ModelOption[]> {
    if (!await clineVerifiedInvocation(this.command, this.env)) {
      throw new Error(`Cline model catalog requires a ${CLINE_MINIMUM_SUPPORTED_VERSION}-or-newer binary.`);
    }
    const model = this.configuredHubModel();
    return model ? [{ ...model }] : [];
  }

  private async newOwnedManagementClient(
    cwd: string,
    ownershipAlreadyProven = false,
  ): Promise<ClineHubClient> {
    const descriptor = await this.describeManagedHost();
    if (!ownershipAlreadyProven
      && await this.isManagedHostOwned?.(descriptor.identityKey) !== true) {
      throw new Error('Cline managed Hub ownership is no longer proven.');
    }
    const discovery = await probeClineHub({
      env: this.env,
      ...(this.homeDir ? { homeDir: this.homeDir } : {}),
      fetcher: this.fetcher,
    });
    if (!discovery) throw new Error('Cline managed Hub is unavailable for authority recovery.');
    return this.newHubClient(discovery, cwd);
  }

  private async listCandidateModels(): Promise<ModelOption[]> {
    if (!await clineBinaryMatchesVerifiedVersion(this.command, this.env)) {
      throw new Error(`Cline model catalog requires a ${CLINE_MINIMUM_SUPPORTED_VERSION}-or-newer binary.`);
    }
    const configured = await resolveClineAcpEnvironment({
      env: this.env,
    });
    const models = this.candidateModels.map((model) => ({ ...model }));
    if (configured && !models.some((model) =>
      model.providerID === configured.provider && model.modelID === configured.model)) {
      models.push({ providerID: configured.provider, modelID: configured.model, label: configured.model });
    }
    return models;
  }

  private async listCandidateModes(): Promise<ModeOption[]> {
    return CLINE_CREATION_MODES.map((mode) => ({ ...mode }));
  }

  private newHubClient(discovery: NonNullable<Awaited<ReturnType<typeof probeClineHub>>>, cwd: string): ClineHubClient {
    return this.hubClientFactory({
      discovery,
      clientId: `cosyncing-${randomUUID()}`,
      workspaceRoot: cwd,
      cwd,
      capabilities: [
        { name: 'approval.respond', description: 'Resolve native per-tool approval requests.' },
      ],
      ...(this.hubSocketFactory ? { socketFactory: this.hubSocketFactory } : {}),
      ...(this.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.requestTimeoutMs }),
    });
  }

  private async createHubSession(options: {
    directory?: string;
    title?: string;
    model?: PromptInput['model'];
    permissionMode?: string;
  } = {}): Promise<SessionInfo> {
    if (!await this.canCreateSession()) {
      throw new NativeSessionUnresumableError(
        `Cline create requires ${CLINE_MINIMUM_SUPPORTED_VERSION} or newer, a broker-owned isolated Hub, and configured provider/model.`,
      );
    }
    const cwd = options.directory ?? process.cwd();
    if (!isAbsolute(cwd) || !await stat(cwd).then((value) => value.isDirectory(), () => false)) {
      throw new NativeSessionUnresumableError('Cline create requires an existing absolute workspace directory.');
    }
    const configuredModel = this.configuredHubModel()!;
    if (options.model && (options.model.providerID !== configuredModel.providerID
      || options.model.modelID !== configuredModel.modelID
      || options.model.reasoningEffort !== undefined)) {
      throw new NativeSessionUnresumableError('Cline create model must match the configured isolated native profile.');
    }
    const requestedMode = options.permissionMode ?? 'ask';
    if (!CLINE_CREATION_MODES.some((candidate) => candidate.value === requestedMode)) {
      throw new NativeSessionUnresumableError(`Cline permission mode ${requestedMode} is not supported.`);
    }
    const mode = requestedMode as NonNullable<ClineStoredSession['currentMode']>;
    const discovery = await probeClineHub({
      env: this.env,
      ...(this.homeDir ? { homeDir: this.homeDir } : {}),
      fetcher: this.fetcher,
    });
    if (!discovery) throw new NativeSessionUnresumableError('Cline managed Hub is not ready.');
    const existingIds = new Set((await this.storedSessions()).map((session) => session.id));
    const client = this.newHubClient(discovery, cwd);
    let createdId = '';
    let createdSessionIsNew = false;
    let connection: ClineHubDriveConnection | undefined;
    const openingToken = Symbol('Cline Hub create');
    try {
      await client.connect();
      const nativeMode = mode === 'plan' ? 'plan' : 'act';
      const title = options.title?.trim() || 'New Cline session';
      const created = await client.command('session.create', {
        workspaceRoot: cwd,
        cwd,
        sessionConfig: {
          providerId: configuredModel.providerID,
          modelId: configuredModel.modelID,
          cwd,
          workspaceRoot: cwd,
          systemPrompt: '',
          mode: nativeMode,
          enableTools: true,
          enableSpawnAgent: true,
          enableAgentTeams: false,
        },
        metadata: {
          source: 'cosyncing',
          provider: configuredModel.providerID,
          model: configuredModel.modelID,
          enableTools: true,
          enableSpawn: true,
          enableTeams: false,
          interactive: true,
          title,
        },
        runtimeOptions: {
          mode: nativeMode,
          enableTools: true,
          enableSpawn: true,
          enableTeams: false,
          autoApproveTools: mode === 'auto',
        },
        modelSelection: { provider: configuredModel.providerID, model: configuredModel.modelID },
        toolPolicies: { '*': { autoApprove: mode === 'auto', enabled: true } },
      }, undefined, null);
      createdId = responseSessionId(created) ?? '';
      if (!createdId) {
        throw new Error('Cline Hub session.create did not return one new bounded session identity.');
      }
      if (existingIds.has(createdId) || this.driven.has(createdId)
        || this.pendingCreatedOwners.has(createdId) || this.opening.has(createdId)) {
        throw new Error(`Cline Hub session.create returned pre-existing or active id ${createdId}; preserving it.`);
      }
      this.opening.set(createdId, openingToken);
      createdSessionIsNew = true;
      const profileRoot = clineManagedDataRoot(this.env, this.homeDir);
      const sessionDir = join(profileRoot, 'sessions', createdId);
      const provisional: ClineStoredSession = {
        id: createdId,
        nativeId: createdId,
        title,
        cwd,
        model: `${configuredModel.providerID}/${configuredModel.modelID}`,
        currentModel: { ...configuredModel },
        currentMode: mode,
        status: 'idle',
        interrupted: false,
        storeRoot: profileRoot,
        dataRoot: profileRoot,
        sessionDir,
        metadataPath: join(sessionDir, `${createdId}.json`),
        messagesPath: join(sessionDir, `${createdId}.messages.json`),
        managedCosyncingRoot: profileRoot,
      };
      const driveInfo = sessionInfo(provisional, this.command, true, true, true, mode);
      driveInfo.currentModel = { ...configuredModel };
      connection = this.hubConnection(
        provisional,
        driveInfo,
        client,
        undefined,
        this.sessionPromptCorrelations(createdId),
        openingToken,
        true,
      );
      try {
        await connection.initialize();
        if (this.opening.get(createdId) !== openingToken || !isDriving(connection)) {
          throw new Error('Cline Hub create lost Drive ownership during initialization.');
        }
        this.driveEligible.add(createdId);
        this.driveModes.set(createdId, mode);
        this.driveModels.set(createdId, { ...configuredModel });
        this.driven.set(createdId, connection);
        const timer = setTimeout(() => {
          const pending = this.pendingCreatedOwners.get(createdId);
          if (!pending || pending.connection !== connection || pending.claimed) return;
          this.pendingCreatedOwners.delete(createdId);
          this.invalidateDriveEligibility(createdId, connection);
          void connection?.close();
        }, this.pendingCreateTimeoutMs);
        timer.unref?.();
        this.pendingCreatedOwners.set(createdId, { connection, claimed: false, timer });
        const info = sessionInfo(provisional, this.command, true, true, false, mode);
        info.currentModel = { ...configuredModel };
        return info;
      } finally {
        if (this.opening.get(createdId) === openingToken) this.opening.delete(createdId);
      }
    } catch (error) {
      if (createdSessionIsNew && createdId
        && !(error instanceof ClineHubCreateBoundaryUnprovenError)
        && (!connection || isDriving(connection))) {
        await client.command('session.delete', { sessionId: createdId }, createdId, 5_000).catch(() => undefined);
      }
      await connection?.close().catch(() => undefined);
      if (!connection) await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async createCandidateSession(options: {
    directory?: string;
    title?: string;
    model?: PromptInput['model'];
    permissionMode?: string;
  } = {}): Promise<SessionInfo> {
    if (!await this.canCreateSession()) {
      throw new NativeSessionUnresumableError(
        `Cline create requires ${CLINE_MINIMUM_SUPPORTED_VERSION} or newer and a secure ACP account or API-key authentication path.`);
    }
    const cwd = options.directory ?? process.cwd();
    if (!isAbsolute(cwd) || !await stat(cwd).then((value) => value.isDirectory(), () => false)) {
      throw new NativeSessionUnresumableError('Cline create requires an existing absolute workspace directory.');
    }
    const requestedMode = options.permissionMode ?? 'ask';
    if (!CLINE_CREATION_MODES.some((candidate) => candidate.value === requestedMode)) {
      throw new NativeSessionUnresumableError(`Cline permission mode ${requestedMode} is not in the measured candidate catalog.`);
    }
    const mode = requestedMode as NonNullable<ClineStoredSession['currentMode']>;
    const apiKeyAuth = this.authMethodId ? undefined : await resolveClineAcpEnvironment({
      env: this.env,
      model: options.model,
    });
    if (!this.authMethodId && !apiKeyAuth) {
      throw new NativeSessionUnresumableError('Cline ACP has no secure OpenAI-compatible API-key environment available.');
    }
    const effectiveModel = options.model ?? (apiKeyAuth
      ? { providerID: apiKeyAuth.provider, modelID: apiKeyAuth.model }
      : undefined);
    let createdId = '';
    let connection: ClineDriveConnection | undefined;
    let provisionalSession: ClineStoredSession | undefined;
    const openingToken = Symbol('Cline ACP create');
    try {
      const existingIds = new Set((await this.storedSessions()).map((session) => session.id));
      const catalogModel = effectiveModel
        ? (await this.listCandidateModels()).find((candidate) => candidate.providerID === effectiveModel.providerID
          && candidate.modelID === effectiveModel.modelID)
        : undefined;
      const selectedModel = effectiveModel
        ? { ...effectiveModel, ...(catalogModel?.label ? { label: catalogModel.label } : {}) }
        : undefined;
      connection = await ClineDriveConnection.createPending(cwd, (sessionId) => {
        createdId = sessionId;
        if (existingIds.has(sessionId) || this.driven.has(sessionId)
          || this.pendingCreatedOwners.has(sessionId) || this.opening.has(sessionId)) {
          throw new Error(`Cline session/new returned pre-existing or active id ${sessionId}; preserving it.`);
        }
        this.opening.set(sessionId, openingToken);
        const dataRoot = clineDataRoot(this.env, this.homeDir);
        const sessionDir = join(dataRoot, 'sessions', sessionId);
        const session: ClineStoredSession = {
          id: sessionId,
          nativeId: sessionId,
          title: options.title?.trim() || sessionId,
          cwd,
          ...(selectedModel ? { model: selectedModel.modelID, currentModel: { ...selectedModel } } : {}),
          currentMode: mode,
          status: 'idle',
          interrupted: false,
          storeRoot: clineStoreRoot(this.env, this.homeDir),
          dataRoot,
          sessionDir,
          metadataPath: join(sessionDir, `${sessionId}.json`),
          messagesPath: join(sessionDir, `${sessionId}.messages.json`),
        };
        provisionalSession = session;
        return { session, info: sessionInfo(session, this.command, true, true, true, mode) };
      }, {
        command: this.command,
        args: this.acpArgs(cwd, effectiveModel, mode),
        env: { ...clineChildEnvWithoutHubLaunch(apiKeyAuth?.env ?? this.env), CLINE_NO_AUTO_UPDATE: '1' },
        authMethodId: this.authMethodId,
        requestTimeoutMs: this.requestTimeoutMs,
        promptTimeoutMs: this.promptTimeoutMs,
        ...(effectiveModel ? { model: effectiveModel } : {}),
        permissionMode: mode,
        models: (await this.listCandidateModels()).filter((candidate) => candidate.providerID === effectiveModel?.providerID),
        modes: CLINE_CREATION_MODES,
        ...(this.trace ? { trace: this.trace } : {}),
        ...(this.observe ? { observe: this.observe } : {}),
        pendingCreate: {
          discover: async () => {
            for (let attempt = 0; attempt < 80; attempt += 1) {
              const session = (await this.storedSessions()).find((candidate) => candidate.id === createdId);
              if (session) return session;
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            return undefined;
          },
          onMaterialized: (materializedConnection, session) => {
            const materializedModel = preserveModelLabel(session.currentModel, this.driveModels.get(createdId));
            if (materializedModel) this.driveModels.set(createdId, materializedModel);
            if (session.currentMode) this.driveModes.set(createdId, session.currentMode);
            this.releasePendingCreatedOwner(createdId, materializedConnection);
          },
        },
        onDemote: (demoting) => {
          if (this.driven.get(createdId) === demoting
            || this.opening.get(createdId) === openingToken) {
            this.invalidateDriveEligibility(createdId, demoting);
          }
        },
        onHistoryBoundary: (historyBoundary) => {
          this.recordStoredDriveBoundary?.({
            tool: this.id,
            id: createdId,
            nativeId: createdId,
            historyBoundary,
          });
        },
        onClose: (closing) => {
          if (this.driven.get(createdId) === closing) this.driven.delete(createdId);
          this.releasePendingCreatedOwner(createdId, closing);
        },
      });
      if (!connection.driving || !createdId || !provisionalSession
        || this.opening.get(createdId) !== openingToken) {
        throw new Error('Cline pending create lost its ACP child before ownership registration.');
      }
      if (existingIds.has(createdId)
        || (await this.storedSessions()).some((candidate) => candidate.id === createdId)) {
        throw new Error(`Cline session/new reused existing durable session ${createdId}.`);
      }
      await this.beforeCandidateCreatePublication?.();
      if (!connection.driving || this.opening.get(createdId) !== openingToken) {
        throw new Error('Cline pending create lost its ACP child before ownership publication.');
      }
      if (this.driven.has(createdId) || this.pendingCreatedOwners.has(createdId)) {
        throw new Error(`Cline session/new returned duplicate active id ${createdId}.`);
      }
      this.driveEligible.add(createdId);
      this.driveModes.set(createdId, mode);
      if (selectedModel) this.driveModels.set(createdId, selectedModel);
      if (options.title?.trim()) this.driveTitles.set(createdId, options.title.trim());
      this.driven.set(createdId, connection);
      const timer = setTimeout(() => {
        const pending = this.pendingCreatedOwners.get(createdId);
        if (!pending || pending.connection !== connection || pending.claimed) return;
        this.pendingCreatedOwners.delete(createdId);
        this.invalidateDriveEligibility(createdId, connection);
        void connection?.close();
      }, this.pendingCreateTimeoutMs);
      timer.unref?.();
      this.pendingCreatedOwners.set(createdId, { connection, claimed: false, timer });
      const info = sessionInfo(provisionalSession, this.command, true, true, false, mode);
      if (selectedModel) info.currentModel = { ...selectedModel };
      if (options.title?.trim()) info.title = options.title.trim();
      return info;
    } catch (error) {
      await connection?.close().catch(() => undefined);
      throw error;
    } finally {
      if (createdId && this.opening.get(createdId) === openingToken) this.opening.delete(createdId);
    }
  }

  async renameSession(sessionId: string, title: string | null): Promise<SessionInfo | void> {
    // Clearing an app override is broker-side. Cline has no native "restore
    // generated title" command, so null deliberately performs no native write.
    if (title === null) return;
    const normalized = title.trim();
    if (!normalized || normalized.length > 4_096 || /[\0\r\n]/u.test(normalized)) {
      throw new Error('Cline rename requires a single-line title between 1 and 4096 characters.');
    }
    const session = (await this.storedSessions()).find((candidate) => candidate.id === sessionId);
    if (!session) {
      throw new NativeSessionUnresumableError('Cline native rename requires one supported parent session.');
    }
    const storedDrive = this.resolveStoredDriveState?.({
      tool: this.id,
      id: session.id,
      nativeId: session.nativeId,
    });
    const eligible = session.origin !== 'subagent'
      && (this.candidateDrive || this.isManagedSession(session))
      && (this.driveEligible.has(sessionId) || storedDrive?.historyBoundary !== undefined);
    if (!eligible) {
      throw new NativeSessionRenameUnsupportedError(
        'Cline native rename is limited to app-created sessions in the broker-managed profile.',
      );
    }
    if (!this.candidateDrive && this.isManagedSession(session)) {
      let client: ClineHubClient | undefined;
      let durable: ClineStoredSession | undefined;
      let invalidateManagedEligibility = false;
      let nativeMutationAttempted = false;
      let nativeMutationProved = false;
      let nativeMutationReserved = false;
      const verifyDurableTitle = async (): Promise<boolean> => {
        const deadline = Date.now() + this.renameTimeoutMs;
        do {
          durable = await this.rediscoverExactManagedSession(session);
          if (durable?.title === normalized) return true;
          durable = undefined;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        } while (Date.now() < deadline);
        return false;
      };
      try {
        const active = this.driven.get(sessionId);
        if (this.opening.has(sessionId) || this.nativeMutations.has(sessionId)
          || (active !== undefined
            && !(active instanceof ClineHubDriveConnection && isDriving(active)))) {
          throw new Error('Cline session already has a writer or native metadata mutation in progress.');
        }
        this.nativeMutations.add(sessionId);
        nativeMutationReserved = true;
        if (active instanceof ClineHubDriveConnection && isDriving(active)) {
          // The connection performs finer-grained preflight checks. The
          // adapter reserves this session before awaiting it so close() cannot
          // admit Resume or another metadata child while the CLI is in flight.
          let renamed = false;
          try {
            renamed = await active.renameNativeTitle(normalized, verifyDurableTitle);
          } finally {
            // The connection itself demotes every unproved exit after it
            // invokes the CLI. A local admission/preflight refusal leaves the
            // same writer driving and must not abort its legitimate turn.
            if (this.driven.get(sessionId) !== active || !isDriving(active)) {
              invalidateManagedEligibility = true;
            }
          }
          if (!renamed || invalidateManagedEligibility) {
            throw new Error('Cline Hub active Drive ownership changed during native rename.');
          }
        } else {
          const expectedBoundary = storedDrive?.historyBoundary;
          const before = expectedBoundary ? await this.currentHistoryBoundary(session) : undefined;
          if (!expectedBoundary || !before || !sameHistoryBoundary(expectedBoundary, before)) {
            throw new Error('Cline Hub stored Drive ownership is stale for native rename.');
          }
          client = await this.newOwnedManagementClient(session.cwd);
          let foreignOwnershipSeen = false;
          const unsubscribe = client.subscribe((event) => {
            if (event.sessionId === session.nativeId
              && (event.event === 'run.enqueued' || event.event === 'run.started')) {
              foreignOwnershipSeen = true;
              invalidateManagedEligibility = true;
            }
          });
          await client.connect();
          try {
            const beforeStatus = await client.command('session.get', {
              sessionId: session.nativeId,
            }, session.nativeId, this.renameTimeoutMs);
            const beforeNativeStatus = recordOf(beforeStatus.session)?.status;
            if (beforeNativeStatus !== 'idle') {
              invalidateManagedEligibility = true;
              throw new Error('Cline Hub did not authoritatively report idle before native rename.');
            }
            nativeMutationAttempted = true;
            await this.runNativeHistoryRename(session, normalized);
            const afterStatus = await client.command('session.get', {
              sessionId: session.nativeId,
            }, session.nativeId, this.renameTimeoutMs);
            const afterNativeStatus = recordOf(afterStatus.session)?.status;
            if (afterNativeStatus !== 'idle') invalidateManagedEligibility = true;
            if (foreignOwnershipSeen || afterNativeStatus !== 'idle' || !await verifyDurableTitle()) {
              throw new Error('Cline Hub did not remain idle across durable native rename.');
            }
            const after = await this.currentHistoryBoundary(session);
            if (foreignOwnershipSeen || !after || !sameHistoryBoundary(expectedBoundary, after)) {
              invalidateManagedEligibility = true;
              throw new Error('Cline Hub transcript ownership changed during native rename.');
            }
            nativeMutationProved = true;
          } finally {
            unsubscribe();
          }
        }
        if (!durable) throw new Error('Cline Hub rename was not visible in durable rediscovery.');
        return sessionInfo(
          durable,
          this.command,
          true,
          eligible,
          isDriving(this.driven.get(sessionId)),
          this.driveModes.get(sessionId) ?? durable.currentMode,
        );
      } catch {
        if (nativeMutationAttempted && !nativeMutationProved) invalidateManagedEligibility = true;
        if (invalidateManagedEligibility) this.invalidateDriveEligibility(sessionId);
        this.trace?.({
          op: 'observe',
          detail: 'Cline managed-Hub native rename was not confirmed; using the broker display alias.',
        });
        throw new NativeSessionRenameUnsupportedError(
          'Cline managed-Hub native rename was not confirmed; use the broker display alias.',
        );
      } finally {
        await client?.close().catch(() => undefined);
        if (nativeMutationReserved) this.nativeMutations.delete(sessionId);
      }
    }
    await this.runNativeHistoryRename(session, normalized);
    this.driveTitles.set(sessionId, normalized);
    session.title = normalized;
    return sessionInfo(
      session,
      this.command,
      true,
      eligible,
      isDriving(this.driven.get(sessionId)),
      this.driveModes.get(sessionId) ?? session.currentMode,
    );
  }

  private async runNativeHistoryRename(session: ClineStoredSession, title: string): Promise<boolean> {
    const invocation = await clineVerifiedInvocation(this.command, this.env);
    if (!invocation) {
      throw new NativeSessionUnresumableError(
        `Cline native rename requires a ${CLINE_MINIMUM_SUPPORTED_VERSION}-or-newer binary.`);
    }
    const child = bunSpawnResolvedInvocation(invocation, [
      'history', 'update', '--session-id', session.nativeId, '--title', title,
    ], {
      cwd: session.cwd,
      // Cline's Hub session.update acknowledges title patches without changing
      // session.get or the durable metadata. Its measured history command
      // persists the title when pointed at the exact isolated store. The Hub
      // launch controls are stripped: this must write the store, never become
      // a second daemon on the owner's default port.
      env: {
        ...clineChildEnvWithoutHubLaunch(this.env),
        CLINE_NO_AUTO_UPDATE: '1',
        CLINE_DATA_DIR: session.dataRoot,
        CLINE_SESSION_DATA_DIR: join(session.dataRoot, 'sessions'),
      },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    let softKill: ReturnType<typeof setTimeout> | undefined;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    let reapDeadline: ReturnType<typeof setTimeout> | undefined;
    let timeoutTriggered = false;
    const timeout = new Promise<{ timedOut: true }>((resolveTimeout) => {
      softKill = setTimeout(() => {
        timeoutTriggered = true;
        try { child.kill(15); } catch { /* already exited */ }
        hardKill = setTimeout(() => {
          try { child.kill(9); } catch { /* already exited */ }
        }, 250);
        hardKill.unref?.();
        reapDeadline = setTimeout(() => resolveTimeout({ timedOut: true }), 1_000);
        reapDeadline.unref?.();
      }, this.nativeRenameTimeoutMs);
      softKill.unref?.();
    });
    const outcome = await Promise.race([
      child.exited.then((exitCode) => ({ timedOut: false as const, exitCode })),
      timeout,
    ]);
    if (softKill) clearTimeout(softKill);
    if (hardKill) clearTimeout(hardKill);
    if (reapDeadline) clearTimeout(reapDeadline);
    if (outcome.timedOut || timeoutTriggered) {
      try { child.kill(9); } catch { /* already exited */ }
      throw new Error('Cline native rename timed out.');
    }
    if (outcome.exitCode !== 0) {
      throw new Error(`Cline native rename exited with status ${outcome.exitCode}.`);
    }
    return true;
  }

  async attach(sessionId: string, mode?: AttachMode): Promise<SessionConnection> {
    const pendingCreated = this.pendingCreatedOwners.get(sessionId);
    if (pendingCreated) {
      if (mode === 'resume') {
        if (pendingCreated.claimed || !isDriving(pendingCreated.connection)) {
          throw new NativeSessionUnresumableError('Cline already has a Drive owner for this pending created session.');
        }
        pendingCreated.claimed = true;
        clearTimeout(pendingCreated.timer);
        return pendingCreated.connection;
      }
      if (!pendingCreated.claimed) {
        throw new NativeSessionUnresumableError('Cline empty created sessions require Resume for their first prompt.');
      }
      if (mode !== undefined && mode !== 'observe') {
        throw new Error(`Cline does not support ${mode} attach.`);
      }
      // A claimed managed-Hub create already has an owner and an empty durable
      // snapshot. Let a reload build a separate read-only Observe wrapper from
      // that snapshot; never return or consume the provisional writer here.
      // The fixture-only ACP candidate has no snapshot until its first prompt,
      // so the normal stored-session lookup below continues to fail closed.
    }
    const effectiveMode = mode ?? 'observe';
    const session = (await this.storedSessions()).find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error('Cline session is missing or its snapshot identity is unsupported.');
    const isSubagent = session.origin === 'subagent';
    const managed = !this.candidateDrive && this.isManagedSession(session);
    const stored = isSubagent || (!this.candidateDrive && !managed) ? undefined : this.resolveStoredDriveState?.({
      tool: this.id,
      id: session.id,
      nativeId: session.nativeId,
    });
    const activeDriving = isDriving(this.driven.get(sessionId));
    let currentBoundary = stored?.historyBoundary && !activeDriving
      ? await this.currentHistoryBoundary(session)
      : undefined;
    let storedBoundaryValid = stored?.historyBoundary !== undefined
      && (activeDriving || (currentBoundary !== undefined
        && sameHistoryBoundary(stored.historyBoundary, currentBoundary)));
    let storedBoundaryInvalid = false;
    if (managed && stored?.historyBoundary && currentBoundary && !storedBoundaryValid) {
      const reconciliation = await this.reconcileStoredManagedAssistantAppend(session, stored.historyBoundary);
      if (reconciliation.status === 'advanced') {
        currentBoundary = reconciliation.boundary;
        stored.historyBoundary = reconciliation.boundary;
        storedBoundaryValid = true;
      } else if (reconciliation.status === 'invalid') storedBoundaryInvalid = true;
    }
    if (stored?.historyBoundary && currentBoundary !== undefined && !storedBoundaryValid
      && (!managed || storedBoundaryInvalid)) {
      this.invalidateDriveEligibility(sessionId);
    }
    const descriptor = this.candidateDrive ? undefined : await this.describeManagedHost();
    const writerReady = this.candidateDrive
      ? await clineBinaryMatchesVerifiedVersion(this.command, this.env)
      : managed && !!this.configuredHubModel()
        && await clineVerifiedInvocation(this.command, this.env) !== undefined
        && descriptor !== undefined
        && await this.isManagedHostOwned?.(descriptor.identityKey) === true
        && await this.isManagedHostReady();
    const eligible = (writerReady || activeDriving)
      && !isSubagent && (this.driveEligible.has(sessionId) || storedBoundaryValid);
    if (effectiveMode === 'resume') {
      if (isSubagent) {
        throw new NativeSessionUnresumableError('Cline subagent snapshots are Observe-only; native child writer ownership is unmeasured.');
      }
      if (!eligible) {
        throw new NativeSessionUnresumableError('Cline Resume is limited to sessions created by this authenticated broker installation with an unchanged transcript boundary.');
      }
      if (this.driven.has(sessionId) || this.opening.has(sessionId)
        || this.nativeMutations.has(sessionId)) {
        throw new NativeSessionUnresumableError(
          'Cline already has a Drive owner or native metadata mutation; join after it settles.',
        );
      }
      const openingToken = Symbol('Cline Resume');
      this.opening.set(sessionId, openingToken);
      try {
        if (!this.candidateDrive) {
          const configuredModel = this.configuredHubModel()!;
          const nativeModel = preserveModelLabel(session.currentModel, stored?.currentModel);
          if (!nativeModel || nativeModel.providerID !== configuredModel.providerID
            || nativeModel.modelID !== configuredModel.modelID) {
            throw new NativeSessionUnresumableError(
              'Cline Resume requires the managed session model to match the configured isolated profile.',
            );
          }
          const selectedMode = this.driveModes.get(sessionId) ?? session.currentMode ?? stored?.currentMode ?? 'ask';
          this.driveModels.set(sessionId, { ...nativeModel, label: nativeModel.label ?? configuredModel.label });
          this.driveModes.set(sessionId, selectedMode);
          const discovery = await probeClineHub({
            env: this.env,
            ...(this.homeDir ? { homeDir: this.homeDir } : {}),
            fetcher: this.fetcher,
          });
          if (!discovery) throw new NativeSessionUnresumableError('Cline managed Hub is not ready.');
          const info = sessionInfo(session, this.command, true, true, true, selectedMode);
          info.currentModel = { ...this.driveModels.get(sessionId)! };
          const connection = this.hubConnection(
            session,
            info,
            this.newHubClient(discovery, session.cwd),
            storedBoundaryValid ? stored?.historyBoundary : undefined,
            this.sessionPromptCorrelations(
              sessionId,
              storedBoundaryValid ? stored?.promptCorrelations : undefined,
            ),
            openingToken,
            false,
            storedBoundaryValid ? stored?.terminalSummaries : undefined,
          );
          try {
            await connection.initialize();
            if (!isDriving(connection)) {
              this.invalidateDriveEligibility(sessionId, connection);
              throw new NativeSessionUnresumableError(
                'Cline Resume lost Drive ownership during initialization.',
              );
            }
            this.driven.set(sessionId, connection);
            return connection;
          } catch (error) {
            await connection.close().catch(() => undefined);
            throw error;
          }
        }
        const nativeModel = this.driveModels.get(sessionId)
          ?? preserveModelLabel(session.currentModel, stored?.currentModel);
        const selectedMode = this.driveModes.get(sessionId) ?? session.currentMode ?? stored?.currentMode ?? 'ask';
        const modelCatalog = (await this.listCandidateModels())
          .filter((candidate) => candidate.providerID === nativeModel?.providerID);
        const selectedModel = preserveModelLabel(nativeModel, modelCatalog.find((candidate) =>
          candidate.modelID === nativeModel?.modelID));
        const apiKeyAuth = this.authMethodId ? undefined : await resolveClineAcpEnvironment({
          env: this.env,
          model: selectedModel,
        });
        if (!this.authMethodId && !apiKeyAuth) {
          throw new NativeSessionUnresumableError('Cline Resume lost its secure OpenAI-compatible API-key environment.');
        }
        const info = sessionInfo(session, this.command, true, true, true, selectedMode);
        if (selectedModel) info.currentModel = { ...selectedModel };
        const title = this.driveTitles.get(sessionId);
        if (title) info.title = title;
        const connection = new ClineDriveConnection({
          session,
          info,
          command: this.command,
          args: this.acpArgs(session.cwd, selectedModel, selectedMode),
          env: { ...clineChildEnvWithoutHubLaunch(apiKeyAuth?.env ?? this.env), CLINE_NO_AUTO_UPDATE: '1' },
          authMethodId: this.authMethodId,
          requestTimeoutMs: this.requestTimeoutMs,
          promptTimeoutMs: this.promptTimeoutMs,
          ...(selectedModel ? { model: selectedModel } : {}),
          permissionMode: selectedMode,
          models: modelCatalog,
          modes: CLINE_CREATION_MODES,
          ...(storedBoundaryValid && stored?.historyBoundary
            ? { expectedHistoryBoundary: stored.historyBoundary }
            : {}),
          ...(this.trace ? { trace: this.trace } : {}),
          ...(this.observe ? { observe: this.observe } : {}),
          onDemote: (demoting) => {
            if (this.driven.get(sessionId) === demoting
              || this.opening.get(sessionId) === openingToken) {
              this.invalidateDriveEligibility(sessionId, demoting);
            }
          },
          onHistoryBoundary: (historyBoundary) => {
            this.recordStoredDriveBoundary?.({
              tool: this.id,
              id: sessionId,
              nativeId: session.nativeId,
              historyBoundary,
            });
          },
          onClose: (closing) => {
            if (this.driven.get(sessionId) === closing) this.driven.delete(sessionId);
          },
          onConfiguration: (configured) => {
            if (configured.info.currentModel) this.driveModels.set(sessionId, { ...configured.info.currentModel });
            if (configured.info.currentMode) this.driveModes.set(sessionId, configured.info.currentMode);
          },
        });
        try {
          await connection.initialize();
          if (!isDriving(connection)) {
            this.invalidateDriveEligibility(sessionId, connection);
            throw new NativeSessionUnresumableError(
              'Cline Resume lost Drive ownership during initialization.',
            );
          }
          this.driven.set(sessionId, connection);
          return connection;
        } catch (error) {
          await connection.close().catch(() => undefined);
          throw error;
        }
      } finally {
        if (this.opening.get(sessionId) === openingToken) this.opening.delete(sessionId);
      }
    }
    if (effectiveMode !== 'observe') throw new Error(`Cline does not support ${effectiveMode} attach.`);
    const sharedPromptCorrelations = !this.candidateDrive && managed
      && (activeDriving || storedBoundaryValid)
      ? this.sessionPromptCorrelations(
          sessionId,
          storedBoundaryValid ? stored?.promptCorrelations : undefined,
        )
      : undefined;
    const sharedTerminalSummaries = !this.candidateDrive && managed
      && (activeDriving || storedBoundaryValid)
      ? this.sessionTerminalSummaries(sessionId)
      : undefined;
    return new ClineObserveConnection({
      session,
      info: sessionInfo(
        session,
        this.command,
        this.candidateDrive || managed,
        eligible,
        false,
        this.driveModes.get(sessionId) ?? session.currentMode ?? stored?.currentMode,
      ),
      ...(this.trace ? { trace: this.trace } : {}),
      ...(this.processAlive ? { processAlive: this.processAlive } : {}),
      ...this.observe,
      ...(sharedPromptCorrelations ? {
        promptCorrelations: sharedPromptCorrelations,
        onPromptCorrelationInvalid: () => this.invalidateDriveEligibility(sessionId),
      } : {}),
      ...(sharedTerminalSummaries ? {
        terminalSummaryRegistry: sharedTerminalSummaries,
        ...(storedBoundaryValid && stored?.terminalSummaries
          ? { terminalSummaries: stored.terminalSummaries }
          : {}),
        ...(storedBoundaryValid && stored?.historyBoundary
          ? {
              expectedTerminalSummaryBoundary: clineTerminalSummaryBoundaryFromNative(
                sessionId,
                stored.historyBoundary,
              ),
            }
          : {}),
        onTerminalSummaryBoundaryInvalid: () => {
          if (!isDriving(this.driven.get(sessionId))) this.invalidateDriveEligibility(sessionId);
        },
      } : {}),
    });
  }

  private storeOptions(
    env: Readonly<Record<string, string | undefined>>,
    options?: SessionDiscoveryOptions,
  ) {
    return {
      env,
      ...(this.homeDir ? { homeDir: this.homeDir } : {}),
      ...(options?.updatedAfter === undefined ? {} : { updatedAfter: options.updatedAfter }),
      ...(options?.onWork ? { onWork: options.onWork } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(this.processAlive ? { processAlive: this.processAlive } : {}),
      ...(this.trace ? { trace: this.trace } : {}),
    };
  }

  private managedStoreEnv(): NodeJS.ProcessEnv {
    return { ...this.env, CLINE_DATA_DIR: clineManagedDataRoot(this.env, this.homeDir) };
  }

  private managedStoreOptions(options?: SessionDiscoveryOptions) {
    const managedRoot = clineManagedDataRoot(this.env, this.homeDir);
    return {
      ...this.storeOptions(this.managedStoreEnv(), options),
      managedCosyncingRoot: managedRoot,
    };
  }

  private async storedSessions(options?: SessionDiscoveryOptions): Promise<ClineStoredSession[]> {
    const ordinary = await discoverClineStore(this.storeOptions(this.env, options));
    if (this.candidateDrive) return ordinary;
    const managed = await discoverClineStore(this.managedStoreOptions(options));
    this.ambiguousSessionIds.clear();
    const merged = new Map(ordinary.map((session) => [session.id, session]));
    for (const session of managed) {
      if (merged.has(session.id)) {
        this.ambiguousSessionIds.add(session.id);
        continue;
      }
      merged.set(session.id, session);
    }
    return [...merged.values()];
  }

  private async rediscoverExactManagedSession(
    original: ClineStoredSession,
  ): Promise<ClineStoredSession | undefined> {
    const [ordinary, managed] = await Promise.all([
      discoverClineStore(this.storeOptions(this.env)),
      discoverClineStore(this.managedStoreOptions()),
    ]);
    if (ordinary.some((candidate) => candidate.id === original.id)) return undefined;
    const matches = managed.filter((candidate) => candidate.id === original.id);
    if (matches.length !== 1) return undefined;
    const candidate = matches[0]!;
    return candidate.nativeId === original.nativeId
      && resolve(candidate.dataRoot) === resolve(original.dataRoot)
      ? candidate
      : undefined;
  }

  private isManagedSession(session: ClineStoredSession): boolean {
    return !this.ambiguousSessionIds.has(session.id)
      && resolve(session.dataRoot) === clineManagedDataRoot(this.env, this.homeDir);
  }

  /**
   * @param sharedHubProbe one Hub probe reused across a batch of sessions.
   *   Discovery calls this once per managed session, and the probe is a lock-file
   *   read plus an HTTP `/health` round trip, so one sweep made ~95 of them for
   *   an answer that is identical every time. Measured: the Hub lock
   *   `agents/cline/locks/hub/cosyncing.json` sat open ~8x concurrently for a
   *   whole sweep, and cline is the leg the sweep now waits on --
   *   `cline=5178ms/112r/x6` beside `claude=160ms/144r/x6` in the same sweep.
   *
   *   Sharing it is also MORE correct than not: every session in one pass then
   *   compares its boundary against ONE Hub epoch, rather than against whatever
   *   the Hub happened to answer at that session's own moment mid-sweep. Omitted
   *   by the single-session callers, which probe per call exactly as before.
   */
  private async currentHistoryBoundary(
    session: ClineStoredSession,
    sharedHubProbe?: Promise<ClineHubDiscovery | undefined>,
  ): Promise<HistorySourceIdentity | undefined> {
    if (this.candidateDrive || !this.isManagedSession(session)) return clineHistorySourceIdentity(session);
    const [snapshot, discovery] = await Promise.all([
      readClineMessages(session),
      sharedHubProbe ?? probeClineHub({
        env: this.env,
        ...(this.homeDir ? { homeDir: this.homeDir } : {}),
        fetcher: this.fetcher,
      }),
    ]);
    return snapshot.issues.length === 0 && discovery
      ? clineHubHistoryIdentity(
          clineManagedDataRoot(this.env, this.homeDir),
          session.id,
          clineHubEpoch(discovery),
          snapshot.messages,
        )
      : undefined;
  }

  private async reconcileStoredManagedAssistantAppend(
    session: ClineStoredSession,
    stored: HistorySourceIdentity,
    ownershipAlreadyProven = false,
  ): Promise<
    | { status: 'advanced'; boundary: HistorySourceIdentity }
    | { status: 'invalid' }
    | { status: 'unavailable' }
  > {
    const appendPosition = stored.appendPosition;
    if (!this.isManagedSession(session) || !Number.isSafeInteger(appendPosition)
      || appendPosition === undefined || appendPosition <= 0) return { status: 'invalid' };
    let client: ClineHubClient | undefined;
    let foreignOwnershipSeen = false;
    let unsubscribe: (() => void) | undefined;
    try {
      client = await this.newOwnedManagementClient(session.cwd, ownershipAlreadyProven);
      unsubscribe = client.subscribe((event) => {
        if (event.sessionId === session.nativeId
          && (event.event === 'run.enqueued' || event.event === 'run.started')) {
          foreignOwnershipSeen = true;
        }
      });
      await client.connect();
      const readStatus = async (): Promise<string | undefined> => {
        const reply = await client!.command('session.get', {
          includeSnapshot: false,
        }, session.nativeId, this.renameTimeoutMs);
        const native = recordOf(reply.session);
        return typeof native?.status === 'string' ? native.status : undefined;
      };
      const readMessages = async () => {
        const reply = await client!.command('session.messages', {
          sessionId: session.nativeId,
        }, session.nativeId, this.renameTimeoutMs);
        if (reply.sessionId !== undefined && reply.sessionId !== session.nativeId) return undefined;
        return parseClineHubMessages(session.nativeId, reply.messages);
      };
      if (await readStatus() !== 'idle' || foreignOwnershipSeen) return { status: 'unavailable' };
      const first = await readMessages();
      const second = await readMessages();
      if (!first || !second || foreignOwnershipSeen || await readStatus() !== 'idle') {
        return { status: 'unavailable' };
      }
      const profileRoot = clineManagedDataRoot(this.env, this.homeDir);
      const epoch = clineHubEpoch(client.options.discovery);
      const firstIdentity = clineHubHistoryIdentity(profileRoot, session.nativeId, epoch, first);
      const secondIdentity = clineHubHistoryIdentity(profileRoot, session.nativeId, epoch, second);
      if (!sameHistoryBoundary(firstIdentity, secondIdentity)) return { status: 'unavailable' };
      if (appendPosition > second.length) return { status: 'invalid' };
      const prefix = second.slice(0, appendPosition);
      const suffix = second.slice(appendPosition);
      const prefixIdentity = clineHubHistoryIdentity(profileRoot, session.nativeId, epoch, prefix);
      if (!sameHistoryBoundary(stored, prefixIdentity)
        || !prefix.some((message) => message.role === 'user')
        || suffix.length === 0
        // A tool-using turn's suffix interleaves assistant replies with `role: 'user'` tool-result
        // carriers. Requiring assistant-only rows here revoked stored Resume provenance for every
        // session whose last turn called a tool.
        || !suffix.every((message) => isTurnInternalRow(message))) return { status: 'invalid' };
      this.recordStoredDriveBoundary?.({
        tool: this.id,
        id: session.id,
        nativeId: session.nativeId,
        historyBoundary: secondIdentity,
      });
      return { status: 'advanced', boundary: secondIdentity };
    } catch {
      return { status: 'unavailable' };
    } finally {
      unsubscribe?.();
      await client?.close().catch(() => undefined);
    }
  }

  private hubConnection(
    session: ClineStoredSession,
    info: SessionInfo,
    client: ClineHubClient,
    expectedHistoryBoundary?: HistorySourceIdentity,
    promptCorrelations?: ClinePromptCorrelations,
    openingToken?: symbol,
    requireEmptyIdleBoundary = false,
    terminalSummaries?: readonly ClineTerminalSummary[],
  ): ClineHubDriveConnection {
    const sessionId = session.id;
    const terminalSummaryRegistry = this.sessionTerminalSummaries(sessionId);
    return new ClineHubDriveConnection({
      info,
      client,
      profileRoot: clineManagedDataRoot(this.env, this.homeDir),
      models: this.configuredHubModel() ? [{ ...this.configuredHubModel()! }] : [],
      modes: CLINE_CREATION_MODES,
      permissionMode: this.driveModes.get(sessionId) ?? session.currentMode ?? 'ask',
      ...(expectedHistoryBoundary ? { expectedHistoryBoundary } : {}),
      ...(promptCorrelations ? { promptCorrelations } : {}),
      terminalSummaryRegistry,
      ...(terminalSummaries ? { terminalSummaries } : {}),
      ...(requireEmptyIdleBoundary ? { requireEmptyIdleBoundary: true } : {}),
      ...(this.trace ? { trace: this.trace } : {}),
      createManagementClient: () => this.newOwnedManagementClient(session.cwd),
      renameNativeTitle: (title) => this.runNativeHistoryRename(session, title),
      ...(this.onUnsafeManagedAuthority
        ? { onUnsafeAuthority: this.onUnsafeManagedAuthority }
        : {}),
      ...(this.authoritySettleTimeoutMs === undefined
        ? {}
        : { authoritySettleTimeoutMs: this.authoritySettleTimeoutMs }),
      onDemote: (demoting) => {
        if (this.driven.get(sessionId) === demoting
          || (openingToken !== undefined && this.opening.get(sessionId) === openingToken)) {
          this.invalidateDriveEligibility(sessionId, demoting);
        }
      },
      onHistoryBoundary: (historyBoundary, terminalSummary) => {
        this.recordStoredDriveBoundary?.({
          tool: this.id,
          id: sessionId,
          nativeId: session.nativeId,
          historyBoundary,
          ...(terminalSummary ? { terminalSummary } : {}),
        });
        if ((historyBoundary.appendPosition ?? 0) > 0) {
          const pending = this.pendingCreatedOwners.get(sessionId);
          if (pending) this.releasePendingCreatedOwner(sessionId, pending.connection);
        }
      },
      onPromptCorrelation: (correlation) => {
        this.recordStoredPromptCorrelation?.({
          tool: this.id, id: sessionId, nativeId: session.nativeId, correlation,
        });
        promptCorrelations?.set(correlation.nativeMessageId, correlation);
      },
      onClose: (closing) => {
        if (this.driven.get(sessionId) === closing) this.driven.delete(sessionId);
        this.releasePendingCreatedOwner(sessionId, closing);
      },
      onConfiguration: (configured) => {
        if (configured.info.currentModel) this.driveModels.set(sessionId, { ...configured.info.currentModel });
        if (configured.info.currentMode) this.driveModes.set(sessionId, configured.info.currentMode);
      },
    });
  }

  private acpArgs(cwd: string, model: PromptInput['model'] | SessionInfo['currentModel'] | undefined, mode: string): string[] {
    return [
      '--acp', '--cwd', cwd,
      '--config', clineStoreRoot(this.env, this.homeDir),
      '--data-dir', clineDataRoot(this.env, this.homeDir),
      ...(mode === 'plan' ? ['--plan'] : []),
      '--auto-approve', mode === 'auto' ? 'true' : 'false',
      ...(model ? ['--provider', model.providerID, '--model', model.modelID] : []),
      ...(model?.reasoningEffort ? ['--thinking', model.reasoningEffort] : []),
    ];
  }

  private invalidateDriveEligibility(sessionId: string, connection?: ClineWriterConnection): void {
    const summaries = this.terminalSummaries.get(sessionId);
    this.terminalSummaries.delete(sessionId);
    summaries?.clear();
    const active = this.driven.get(sessionId);
    if (!connection && active) {
      active.revokeOwnership('The Cline transcript no longer matches its durable app-owned boundary.');
      return;
    }
    if (!connection || this.driven.get(sessionId) === connection) this.driven.delete(sessionId);
    this.driveEligible.delete(sessionId);
    this.driveModes.delete(sessionId);
    this.driveModels.delete(sessionId);
    this.driveTitles.delete(sessionId);
    const correlations = this.promptCorrelations.get(sessionId);
    this.promptCorrelations.delete(sessionId);
    correlations?.clear();
    if (connection) this.releasePendingCreatedOwner(sessionId, connection);
    this.revokeStoredDriveEligibility?.({ tool: this.id, id: sessionId, nativeId: sessionId });
  }

  private sessionPromptCorrelations(
    sessionId: string,
    initial?: readonly ClinePromptCorrelation[],
  ): ClinePromptCorrelationRegistry {
    const existing = this.promptCorrelations.get(sessionId);
    if (existing) return existing;
    const created = new ClinePromptCorrelationRegistry();
    for (const correlation of initial ?? []) {
      created.set(correlation.nativeMessageId, correlation);
    }
    this.promptCorrelations.set(sessionId, created);
    return created;
  }

  private sessionTerminalSummaries(
    sessionId: string,
  ): TerminalSummaryRegistry<ClineTerminalSummary> {
    const existing = this.terminalSummaries.get(sessionId);
    if (existing) return existing;
    const created = new TerminalSummaryRegistry<ClineTerminalSummary>();
    this.terminalSummaries.set(sessionId, created);
    return created;
  }

  private releasePendingCreatedOwner(sessionId: string, connection: ClineWriterConnection): void {
    const pending = this.pendingCreatedOwners.get(sessionId);
    if (!pending || pending.connection !== connection) return;
    clearTimeout(pending.timer);
    this.pendingCreatedOwners.delete(sessionId);
  }
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
