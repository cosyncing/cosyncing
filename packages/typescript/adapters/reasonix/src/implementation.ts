/**
 * Reasonix adapter contract — probed 2026-08-27/30 against Reasonix v1.25.2.
 *
 *  1. Model identity comes from store meta as provider/model; no host display
 *     label is invented.
 *  2. Discovery exposes no currentMode: the store has none. ACP config reports
 *     tool_approval only for the child that returned it.
 *  3. Create accepts a spawn-time model and retains that exact ACP child under
 *     a bounded in-memory lease; only the first prompt may materialize a row.
 *  4. R1 proved ACP id = ACP metadata id = transcript metadata id = file stem;
 *     both SessionInfo.id and nativeId use it.
 *  5. Subagent nesting is unsupported: no persisted child-session shape was
 *     observed.
 *  6. system -> context injection; user -> the only human bubble; assistant ->
 *     thinking/output/timing; unknown shapes -> named neutral event + trace.
 *  7. Drive mints a byte-fenced queued row before delivery. It stays in
 *     getHistory until the durable user row claims its correlation.
 *  8. ACP chunks and flat replay are different shapes. Durable file tail and
 *     replay share the display-index key function; anonymous ACP deltas never
 *     mint a false durable identity.
 *  9. One adapter-level session registry owns one identity-CAS Drive connection;
 *     discovery reads its posture and joined sockets reuse it.
 * 10. workDurationMs proves a finished assistant row. An idle replay ending in
 *     a user row is projected as an interrupted/cancelled turn, never running.
 * 11. `reasonix --resume [QUERY]` exists, but exact session targeting is not
 *     pinned; terminalSyncHint stays absent and true terminal sync unsupported.
 * 12. Unsupported: per-session tokens, images/files, live terminal attach,
 *     discovery mode, subagent rows, rename/fork, and artifacts. ACP command
 *     snapshots are bounded and run as prompt commands after the child reports them.
 * 13. Attachment echo is unmeasured, so both native file capabilities are false.
 * 14. Cross-client Drive sharing is true because all sockets reuse this broker's
 *     single ACP stdin, pending FIFO, correlation map, and demotion broadcast.
 * 15. ACP plus seven Reasonix suites are wired into the root verification graph.
 * 16. Registration spans runtime, shipped/setup/doctor, client labels, manifests,
 *     support evidence, and public docs.
 * 17. R1 proved store/ACP identity, so create is exposed only for the pinned
 *     binary; first-prompt durable id/cwd/model mismatch fails closed.
 */
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  NativeSessionUnresumableError,
  reportedProductVersion,
  resolveInvocation,
  probeResolvedInvocation,
  type AgentBackend,
  type AgentCapabilities,
  type AgentSetupDiagnosis,
  type AttachMode,
  type ModeOption,
  type ModelOption,
  type PromptInput,
  type SessionConnection,
  type SessionInfo,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import { diagnoseReasonixSetup, REASONIX_VERIFIED_VERSION } from './diagnostics.ts';
import { ReasonixCorrelationRegistry } from './correlation.ts';
import { ReasonixDriveConnection } from './drive.ts';
import { ReasonixObserveConnection } from './observe.ts';
import {
  discoverReasonixStore,
  REASONIX_APPROVAL_MODES,
  reasonixApprovalMode,
  reasonixModelSelection,
  reasonixStoreRoot,
  type ReasonixStoredSession,
} from './store.ts';

export const REASONIX_CAPABILITIES: AgentCapabilities = Object.freeze({
  integrationKind: 'acp-stdio',
  // Observe stays first: a bare attach is read-only and never spawns Reasonix.
  attachModes: ['observe', 'resume'] as AttachMode[],
  supportsObserve: true,
  supportsResume: true,
  supportsLiveAttach: false,
  // One broker-owned ACP child is the writer; joining clients reuse that connection.
  supportsCrossClientDriveSharing: true,
  supportsNativeArtifact: false,
  supportsNativeFileInput: false,
  // The checked-in v1.25.2 probe did not prove session/load + set_config_option.
  supportsModelSwitch: false,
  // R2 captured one request per gated tool call with allow-once/always/reject options.
  permissionGranularity: 'per-tool',
});

export interface ReasonixAdapterOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  requestTimeoutMs?: number;
  /** Bounded ownership lease for a created empty session before its first Resume attach. */
  pendingCreateTimeoutMs?: number;
}

interface PendingCreatedOwner {
  connection: ReasonixDriveConnection;
  claimed: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_PENDING_CREATE_TIMEOUT_MS = 60_000;
const VERSION_SUCCESS_TTL_MS = 5 * 60_000;
const VERSION_FAILURE_TTL_MS = 30_000;

/**
 * `writerAvailable` is the same exact-version gate `attach(…, 'resume')`
 * enforces, threaded through so the control block cannot promise what the gate
 * will refuse.
 *
 * Hard-coding `supported: true` here meant an install with `~/.reasonix` intact
 * but the binary gone — or moved off 1.25.2 — advertised an enabled "Take over"
 * on every row that errored on press, while reasonix's own doctor failed the
 * same session. Grok, cline and kilo all thread their gate into the control
 * block; this was the one that did not.
 */
function control(driving: boolean, writerAvailable: boolean): SessionInfo['control'] {
  return {
    drive: driving
      ? { state: 'driving', supported: true, handoffAvailable: true }
      : {
          state: 'observing',
          supported: writerAvailable,
          ...(writerAvailable ? { takeoverAvailable: true } : {
            reason: `Reasonix Drive requires the exactly-verified ${REASONIX_VERIFIED_VERSION} binary on this host.`,
          }),
        },
    terminalSync: {
      supported: false,
      syncAvailable: false,
      active: false,
      reason: 'Reasonix exposes --resume [QUERY], but exact session targeting is not pinned; the broker-owned ACP child has no true terminal join channel.',
    },
  };
}

function sessionInfo(
  session: ReasonixStoredSession,
  driving = false,
  writerAvailable = true,
): SessionInfo {
  return {
    id: session.id,
    nativeId: session.id,
    tool: 'reasonix',
    title: session.title,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    status: session.status,
    attachMode: driving ? 'resume' : 'observe',
    ...(session.model ? { model: session.model } : {}),
    ...(session.currentModel ? { currentModel: session.currentModel } : {}),
    ...(session.currentMode ? { currentMode: session.currentMode } : {}),
    ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
    ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
    control: control(driving, writerAvailable),
  };
}

export class ReasonixAdapter implements AgentBackend {
  readonly id = 'reasonix';
  readonly displayName = 'Reasonix';
  readonly capabilities = REASONIX_CAPABILITIES;
  private readonly command: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly root: string;
  private readonly requestTimeoutMs?: number;
  private readonly drivenSessions = new Map<string, ReasonixDriveConnection>();
  private readonly pendingDriveOpens = new Set<string>();
  private readonly pendingCreatedOwners = new Map<string, PendingCreatedOwner>();
  private readonly correlationRegistry = new ReasonixCorrelationRegistry();
  private readonly pendingCreateTimeoutMs: number;
  private pinnedBinaryVersion?: { result: boolean; expiresAt: number };
  private pinnedBinaryProbe?: Promise<boolean>;

  constructor(options: ReasonixAdapterOptions = {}) {
    this.command = options.command ?? 'reasonix';
    this.env = options.env ?? process.env;
    this.root = reasonixStoreRoot(this.env, options.homeDir);
    if (options.requestTimeoutMs !== undefined) this.requestTimeoutMs = options.requestTimeoutMs;
    this.pendingCreateTimeoutMs = Number.isSafeInteger(options.pendingCreateTimeoutMs)
      && (options.pendingCreateTimeoutMs ?? 0) > 0
      ? options.pendingCreateTimeoutMs!
      : DEFAULT_PENDING_CREATE_TIMEOUT_MS;
  }

  async isAvailable(): Promise<boolean> {
    return resolveInvocation(this.command, { env: this.env }) !== undefined;
  }

  /**
   * The exact-version gate, cached with ASYMMETRIC TTLs.
   *
   * The asynchronous one-second probe is shared by concurrent callers. A
   * success lasts five minutes, a failure only thirty seconds; expiry starts
   * when the answer arrives, not before native startup.
   *
   * It used to cache for the life of the broker process and to write a probe
   * FAILURE — a 1s timeout, an EAGAIN, an EMFILE — into that cache as a
   * definite `false`. One slow `reasonix --version` therefore disabled
   * `canCreateSession`, `listModels`, `listModes`, `createSession` and Resume
   * until the process was restarted, the last two throwing a message asserting
   * the binary is not 1.25.2 — which the probe never established. Cline and
   * kilo already used 300s/30s for exactly this reason: a success is stable, a
   * failure usually is not, and holding a failure is how a healthy binary stays
   * locked out.
   */
  private async hasPinnedBinaryVersion(): Promise<boolean> {
    const now = Date.now();
    if (this.pinnedBinaryVersion && this.pinnedBinaryVersion.expiresAt > now) {
      return this.pinnedBinaryVersion.result;
    }
    if (this.pinnedBinaryProbe) return this.pinnedBinaryProbe;
    const remember = (result: boolean): boolean => {
      this.pinnedBinaryVersion = {
        result,
        expiresAt: Date.now() + (result ? VERSION_SUCCESS_TTL_MS : VERSION_FAILURE_TTL_MS),
      };
      return result;
    };
    const invocation = resolveInvocation(this.command, { env: this.env });
    if (!invocation) return remember(false);
    const operation = (async () => {
      const probe = await probeResolvedInvocation(invocation, ['--version'], {
        env: this.env,
        timeout: 1_000,
        maxBuffer: 64 * 1024,
      });
      if (probe.error || probe.status !== 0) return remember(false);
      return remember(
        reportedProductVersion(`${probe.stdout}\n${probe.stderr}`, ['reasonix'])
          === REASONIX_VERIFIED_VERSION,
      );
    })().catch(() => remember(false)).finally(() => { this.pinnedBinaryProbe = undefined; });
    this.pinnedBinaryProbe = operation;
    return operation;
  }

  diagnoseSetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
    return diagnoseReasonixSetup(context);
  }

  async discoverSessions(options?: { updatedAfter?: number }): Promise<SessionInfo[]> {
    // Probed ONCE per sweep rather than per row: it is cached, but the rows must
    // also agree with each other within a sweep.
    const writerAvailable = await this.hasPinnedBinaryVersion();
    return (await discoverReasonixStore({ root: this.root, updatedAfter: options?.updatedAfter }))
      .map((session) => sessionInfo(session, this.isDriving(session.id), writerAvailable));
  }

  canCreateSession(): Promise<boolean> {
    return this.hasPinnedBinaryVersion();
  }

  /**
   * The catalogue Reasonix already knows about, read from `doctor --json`.
   *
   * Without this the broker REFUSES a model it was handed. Captured against
   * v1.25.2 before this existed:
   *
   *     POST /api/sessions/reasonix {"model":{...}}  ->  503
   *                                 {"code":"MODEL_CATALOG_UNAVAILABLE"}
   *     POST /api/sessions/reasonix (no model)       ->  200
   *
   * So choosing a model for a new Reasonix session did not merely go
   * unadvertised, it FAILED. The model was plumbed the whole way already --
   * `createSession` builds `provider/model`, `createPending` forwards it, and
   * the child is spawned as `['acp', '--model', <model>, '--workspace-only']`.
   * The only missing piece was the catalogue the create route validates against.
   *
   * `doctor --json` is a machine surface the CLI documents alongside
   * `session list --json`. Filtered to name and models: the same provider
   * records carry `api_key_env` and `key_present`, which must never reach a
   * catalogue served over the wire.
   *
   * Deliberately NOT advertised: `reasoningEfforts`. The binary takes
   * `--effort LEVEL` but does not enumerate the levels, and inventing them is
   * the sort of unproven claim `supportsModelSwitch: false` exists to prevent.
   * Mid-session switching stays unsupported for that same reason; this is the
   * pre-session catalogue only.
   */
  async listModels(): Promise<ModelOption[]> {
    // THROW rather than answer `[]`. The two are different facts and the broker
    // already distinguishes them: `modelCatalogForCreation` turns a throw into
    // `ModelCatalogUnavailableError` -> 503 MODEL_CATALOG_UNAVAILABLE, while an
    // empty array is authoritative and produces a 409 telling the user their
    // model "is no longer available" — a claim a failed `doctor --json` never
    // established. Every other caller already tolerates a throw
    // (`collectSessionOptions` softens it to `[]`, `client-message-policy`
    // reports MODEL_UNSUPPORTED), so the honest channel is reachable at last.
    if (!await this.hasPinnedBinaryVersion()) {
      throw new Error(`Reasonix model catalog requires the exactly-verified ${REASONIX_VERIFIED_VERSION} binary.`);
    }
    const invocation = resolveInvocation(this.command, { env: this.env });
    if (!invocation) throw new Error('Reasonix is not installed or is not visible to the broker.');
    const probe = await probeResolvedInvocation(invocation, ['doctor', '--json'], {
      env: this.env,
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (probe.error || probe.status !== 0) {
      throw new Error(`Reasonix doctor --json did not answer (status ${String(probe.status)}).`);
    }
    let parsed: Record<string, unknown> | undefined;
    try {
      const value: unknown = JSON.parse(probe.stdout);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      throw new Error('Reasonix doctor --json returned output this adapter could not parse.');
    }
    if (!parsed) throw new Error('Reasonix doctor --json returned a non-object document.');
    const providers: unknown[] = Array.isArray(parsed.providers) ? parsed.providers : [];
    const models: ModelOption[] = [];
    const seen = new Set<string>();
    for (const entry of providers) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const provider = entry as Record<string, unknown>;
      const providerID = typeof provider.name === 'string' ? provider.name.trim() : '';
      if (!providerID || providerID.length > 128) continue;
      const names: unknown[] = Array.isArray(provider.models) ? provider.models : [];
      for (const name of names) {
        if (typeof name !== 'string') continue;
        const modelID = name.trim();
        if (!modelID || modelID.length > 256) continue;
        // `provider/model` is the identity `createSession` builds, and the same
        // model name is offered by more than one provider here (`glm-5.2` and
        // `deepseek-v4-*` each appear twice), so dedupe on the PAIR.
        const key = `${providerID}/${modelID}`;
        if (seen.has(key)) continue;
        seen.add(key);
        models.push({ providerID, providerLabel: providerID, modelID, label: modelID });
      }
    }
    return models;
  }

  async listModes(): Promise<ModeOption[]> {
    if (!await this.hasPinnedBinaryVersion()) return [];
    return REASONIX_APPROVAL_MODES.map((value) => ({
      value,
      label: value === 'ask' ? 'Ask' : value === 'auto' ? 'Auto' : 'Yolo',
      description: value === 'ask'
        ? 'Ask before permission-gated tool calls'
        : value === 'auto'
          ? 'Follow configured permission rules without fallback prompts'
          : 'Approve tool calls except protected decisions',
      category: value === 'ask'
        ? 'ask-permission'
        : value === 'auto' ? 'approve-for-me' : 'full-access',
    }));
  }

  async createSession(options: {
    directory?: string;
    title?: string;
    model?: PromptInput['model'];
    permissionMode?: string;
  } = {}): Promise<SessionInfo> {
    if (!await this.hasPinnedBinaryVersion()) {
      throw new NativeSessionUnresumableError(
        'Reasonix create is enabled only for the native-contract-measured 1.25.2 binary.',
      );
    }
    const cwd = options.directory ?? process.cwd();
    if (!isAbsolute(cwd) || !await stat(cwd).then((value) => value.isDirectory(), () => false)) {
      throw new NativeSessionUnresumableError('Reasonix create requires an existing absolute workspace directory.');
    }
    const model = options.model
      ? `${options.model.providerID}/${options.model.modelID}`
      : undefined;
    const permissionMode = options.permissionMode === undefined
      ? undefined
      : reasonixApprovalMode(options.permissionMode);
    if (options.permissionMode !== undefined && !permissionMode) {
      throw new NativeSessionUnresumableError(
        `Reasonix permission mode ${options.permissionMode} is not in the measured native vocabulary.`,
      );
    }
    let createdSessionId = '';
    let connection: ReasonixDriveConnection | undefined;
    let provisionalSession: ReasonixStoredSession | undefined;
    try {
      connection = await ReasonixDriveConnection.createPending(cwd, (sessionId, createdModel, createdMode) => {
        createdSessionId = sessionId;
        const effectiveModel = createdModel ?? model;
        const sessionsRoot = join(this.root, 'sessions');
        const session: ReasonixStoredSession = {
          id: sessionId,
          title: options.title?.trim() || sessionId,
          cwd,
          ...(effectiveModel ? { model: effectiveModel, currentModel: reasonixModelSelection(effectiveModel) } : {}),
          ...(createdMode ? { currentMode: createdMode } : {}),
          status: 'idle',
          driveEligible: false,
          layout: 'global',
          storeRoot: this.root,
          transcriptPath: join(sessionsRoot, `${sessionId}.jsonl`),
          metaPath: join(sessionsRoot, `${sessionId}.jsonl.meta`),
          acpMetadataPath: join(sessionsRoot, `${sessionId}.acp.json`),
          eventIndexPath: join(sessionsRoot, `${sessionId}.event-index.json`),
          eventLogPath: join(sessionsRoot, `${sessionId}.events.jsonl`),
          displayIndexPath: join(sessionsRoot, `${sessionId}.display-index.json`),
        };
        provisionalSession = session;
        return { session, info: sessionInfo(session, true) };
      }, {
        command: this.command,
        env: this.env,
        model,
        ...(permissionMode ? { permissionMode } : {}),
        requestTimeoutMs: this.requestTimeoutMs,
        correlationRegistry: this.correlationRegistry,
        pendingCreate: {
          cwd,
          ...(model ? { model } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          discover: async () => (await discoverReasonixStore({ root: this.root }))
            .find((candidate) => candidate.id === createdSessionId),
          onMaterialized: (materialized) => this.releasePendingCreatedOwner(createdSessionId, materialized),
        },
        onClose: (closing) => {
          if (this.drivenSessions.get(createdSessionId) === closing) this.drivenSessions.delete(createdSessionId);
          this.releasePendingCreatedOwner(createdSessionId, closing);
        },
      });
      if (!connection.driving) {
        throw new Error(`Reasonix pending create ${createdSessionId} lost its ACP child before ownership registration.`);
      }
      // `requireCompleteEnumeration`, because this is the CAS that admits an
      // exclusive owner: "no durable session carries this id" is what GRANTS
      // ownership, and `discoverReasonixStore` otherwise answers `[]` for an
      // EACCES or a scan-budget overrun exactly as it does for an empty store.
      // Failing to look must not read as having looked and found nothing.
      if ((await discoverReasonixStore({ root: this.root, requireCompleteEnumeration: true }))
        .some((candidate) => candidate.id === createdSessionId)) {
        throw new Error(`Reasonix session/new reused existing durable id ${createdSessionId}; refusing competing ownership.`);
      }
      if (this.drivenSessions.has(createdSessionId) || this.pendingCreatedOwners.has(createdSessionId)) {
        throw new Error(`Reasonix session/new returned duplicate active id ${createdSessionId}; refusing competing ownership.`);
      }
      this.drivenSessions.set(createdSessionId, connection);
      const timer = setTimeout(() => {
        const pending = this.pendingCreatedOwners.get(createdSessionId);
        if (!pending || pending.connection !== connection || pending.claimed) return;
        this.pendingCreatedOwners.delete(createdSessionId);
        if (this.drivenSessions.get(createdSessionId) === connection) this.drivenSessions.delete(createdSessionId);
        void connection?.close();
      }, this.pendingCreateTimeoutMs);
      timer.unref?.();
      this.pendingCreatedOwners.set(createdSessionId, { connection, claimed: false, timer });
      if (!provisionalSession) throw new Error('Reasonix pending create did not establish its native identity.');
      return sessionInfo(provisionalSession, false, await this.hasPinnedBinaryVersion());
    } catch (error) {
      await connection?.close().catch(() => undefined);
      throw error;
    }
  }

  async attach(sessionId: string, mode: AttachMode = 'observe'): Promise<SessionConnection> {
    const pendingCreated = this.pendingCreatedOwners.get(sessionId);
    if (pendingCreated) {
      if (mode !== 'resume') {
        throw new NativeSessionUnresumableError('Reasonix empty created sessions require Resume for their first prompt.');
      }
      if (pendingCreated.claimed || !pendingCreated.connection.driving) {
        throw new NativeSessionUnresumableError(
          'Reasonix already has a Drive owner for this pending created session; join the existing broker connection.',
        );
      }
      pendingCreated.claimed = true;
      clearTimeout(pendingCreated.timer);
      return pendingCreated.connection;
    }
    const session = (await discoverReasonixStore({ root: this.root }))
      .find((candidate) => candidate.id === sessionId);
    if (!session) throw new NativeSessionUnresumableError('Reasonix session is missing or its store schema is unsupported.');
    if (mode === 'observe') return new ReasonixObserveConnection({
      session,
      info: sessionInfo(session, false, await this.hasPinnedBinaryVersion()),
      correlationRegistry: this.correlationRegistry,
    });
    if (mode !== 'resume') throw new Error(`Reasonix does not support ${mode} attach.`);
    if (!session.driveEligible) {
      throw new NativeSessionUnresumableError(
        'Reasonix does not explicitly report this session as idle; Resume refuses a writer until native metadata proves a quiescent state.',
      );
    }
    if (!session.cwd || !isAbsolute(session.cwd)
      || !await stat(session.cwd).then((value) => value.isDirectory(), () => false)) {
      throw new NativeSessionUnresumableError(
        'Reasonix resume requires a valid absolute workspace from native ACP metadata; Observe remains available.',
      );
    }
    if (!await this.hasPinnedBinaryVersion()) {
      throw new NativeSessionUnresumableError(
        'Reasonix Resume is enabled only for the native-contract-measured 1.25.2 binary; Observe remains available.',
      );
    }
    if (this.drivenSessions.get(sessionId)?.driving || this.pendingDriveOpens.has(sessionId)) {
      throw new NativeSessionUnresumableError(
        'Reasonix already has a Drive owner for this session; join the existing broker connection instead of opening another writer.',
      );
    }
    this.pendingDriveOpens.add(sessionId);
    try {
      const connection = await ReasonixDriveConnection.open(session, sessionInfo(session, true), {
        command: this.command,
        env: this.env,
        model: session.model,
        requestTimeoutMs: this.requestTimeoutMs,
        correlationRegistry: this.correlationRegistry,
        onClose: (closing) => {
          if (this.drivenSessions.get(sessionId) === closing) this.drivenSessions.delete(sessionId);
        },
      });
      this.drivenSessions.set(sessionId, connection);
      return connection;
    } catch (error) {
      throw new NativeSessionUnresumableError(
        `Reasonix refused session/load: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.pendingDriveOpens.delete(sessionId);
    }
  }

  /** Session-level Drive posture for discovery rows and identity-CAS tests. */
  isDriving(sessionId: string): boolean {
    return this.drivenSessions.get(sessionId)?.driving === true;
  }

  /** The exact registered owner; the broker still owns socket-level joins. */
  driveConnection(sessionId: string): ReasonixDriveConnection | undefined {
    return this.drivenSessions.get(sessionId);
  }

  private releasePendingCreatedOwner(sessionId: string, connection: ReasonixDriveConnection): void {
    const pending = this.pendingCreatedOwners.get(sessionId);
    if (!pending || pending.connection !== connection) return;
    clearTimeout(pending.timer);
    this.pendingCreatedOwners.delete(sessionId);
  }
}
