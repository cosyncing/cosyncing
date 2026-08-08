import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import {
  CLAUDE_HOOK_LEGACY_MARKER,
  inspectLegacyClaudeHooks,
} from '@cosyncing/adapter-claude';
import {
  queryCodexLoadedThreadIdsStrict,
  readCodexDaemonVersion,
  stopCodexDaemon,
  codexAppServerSocketFingerprint,
} from '@cosyncing/adapter-codex';
import {
  inspectPiBridgeAsset,
  PI_BRIDGE_EMBEDDED_SHA256,
  PI_BRIDGE_EMBEDDED_SOURCE,
  PI_BRIDGE_LEGACY_MARKER,
} from '@cosyncing/adapter-pi';
import type { SetupDiagnosisContext } from '@cosyncing/adapter-api';
import { artifactCacheRoot } from './artifact-store.ts';
import type { BuildInfo } from './build-info.ts';
import { inspectBrokerConfig, type BrokerConfig } from './configuration.ts';
import {
  brokerTokenPath,
  ensureInstallationCredentials,
  inspectBrokerToken,
  inspectPiIntegration,
  piIntegrationPath,
  readBrokerToken,
  readPiIntegration,
} from './credentials.ts';
import { createSetupDiagnosisContext } from './diagnosis-context.ts';
import {
  applyDurableStateMigrationsWithLockHeld,
  durableStateLayout,
  planDurableStateMigrations,
  purgeDataInventory,
} from './durable-state.ts';
import {
  inspectInstallState,
  installStatePath,
  installedBinaryPath,
  serviceExecutablePath,
  writeInstallState,
  type CommittedInstallState,
  type InstalledResourceRecord,
} from './install-state.ts';
import { acquireInstallationLock, type InstallationLockHandle } from './installation-lock.ts';
import { PRODUCT_IDENTITY } from './product.ts';
import { inspectRuntimeAssets, serviceFlutterWebRoot } from './runtime-assets.ts';
import {
  inspectAgentSkill,
  inspectAgentSkills,
  AGENT_SKILL_SHA256,
  AGENT_SKILL_SOURCE,
  type AgentSkillInspection,
} from './agent-skill.ts';
import {
  OPENCODE_SHIM_BLOCK_BEGIN,
  OPENCODE_SHIM_RESOURCE_ID,
  exciseRcBlock,
  inspectRcFile,
  opencodeShimActualSha256,
  opencodeShimHost,
  opencodeShimPort,
  opencodeShimRcCandidates,
  opencodeShimShellPath,
} from './opencode-shim.ts';
import { KNOWN_INSTALL_RESOURCE_IDS } from './install-resource-ids.ts';
import {
  TOKDASH_PACKAGE,
  reverseTokdashProvisioning,
  type TokdashCommandRunner,
} from './tokdash-provision.ts';
import { sanitizeManagedRuntimeOutput } from './runtime-failure-store.ts';
import {
  awaitServiceState,
  createServiceCommandRunner,
  createDurableServiceProvider,
  serviceDefinitionResourceId,
  SERVICE_RESOURCE_IDS,
  SERVICE_TRANSITION_TIMEOUT_MS,
  serviceAgentExecutableDirectories,
  serviceAgentExecutableOverrides,
  type DurableServiceProvider,
  type DurableServiceStatus,
  type ServiceCommandRunner,
  type SystemdProviderOptions,
} from './service-manager.ts';
import {
  assertNoSymlinkComponents,
  atomicWriteOwnerOnly,
} from './secure-files.ts';
import { readSetupTransactionJournal } from './setup-transaction.ts';
import {
  isDurableServiceChoice,
  readCodexDaemonOwnership,
  clearTokdashCompletion,
  clearTokdashOwnership,
  readSetupState,
  readTokdashOwnership,
  setCodexDaemonOwnership,
  setTokdashOwnership,
  setupStateHome,
  setupStatePath,
  type CodexDaemonSocketFingerprint,
} from './setup-state.ts';
import {
  inspectTailscaleServe,
  tailscaleRouteReceiptTarget,
  TAILSCALE_SERVE_OWNERSHIP_MARKER,
  TAILSCALE_SERVE_RESOURCE_ID,
  TailscaleServeProvider,
  type TailscaleServeInspection,
  type TailscaleBackendState,
  type TailscaleServeProviderOptions,
  type TailscaleServeRouteState,
  type TailscaleServeRouteProvider,
  type TailscaleTopology,
} from './tailscale-serve.ts';
import { cliMessages } from './cli-i18n.ts';
import type { SetupLanguage } from './setup-i18n.ts';

export interface LifecycleBaseOptions {
  home?: string;
  cacheRoot?: string;
  buildInfo: Readonly<BuildInfo>;
  executablePath: string;
  context?: SetupDiagnosisContext;
  systemdProviderFactory?: (options: SystemdProviderOptions) => DurableServiceProvider;
  tailscaleProviderFactory?: (options: TailscaleServeProviderOptions) => TailscaleServeRouteProvider;
  runner?: ServiceCommandRunner;
  piAgentDir?: string;
  claudeSettingsPath?: string;
  now?: () => Date;
  /** Injected read-only Codex daemon probe (uninstall live-session enumeration); default talks to the daemon. */
  codexDaemonProbe?: () => Promise<CodexDaemonStatus>;
  /** Injected Codex daemon stopper (uninstall execution); default runs `codex app-server daemon stop`. */
  codexDaemonStop?: (timeoutMs: number) => Promise<void>;
}

/** Best-effort, read-only view of the managed Codex app-server daemon used by uninstall planning. */
export interface CodexDaemonStatus {
  /** False when the codex CLI is not on PATH — the daemon can be neither inspected nor stopped. */
  binaryAvailable: boolean;
  /** True when a live daemon answered the read-only version probe, or the probe itself errored (state then
   *  unknown; planning treats the daemon as potentially running so an owned instance is never abandoned). */
  running: boolean;
  /** Best-effort count of daemon-loaded threads; undefined when unknown or unreachable (never a fake 0). */
  loadedThreadCount?: number;
  /** Live control-socket fingerprint; matched against the ownership record to prove instance identity. */
  socketFingerprint?: CodexDaemonSocketFingerprint;
}

export interface LifecycleStatusReport {
  schemaVersion: 1;
  product: typeof PRODUCT_IDENTITY.productName;
  version: string;
  ok: boolean;
  installation: { committed: boolean; detailCode: string };
  service: {
    mode: 'foreground' | 'systemd' | 'launchd' | 'unconfigured';
    supported: boolean;
    active: DurableServiceStatus['active'];
    enabled: DurableServiceStatus['enabled'];
    definition: string;
    environment: string;
  };
  endpoints: {
    internal: 'ready' | 'unreachable' | 'unconfigured' | 'identity-mismatch';
    advertised: 'ready' | 'unreachable' | 'unconfigured' | 'identity-mismatch';
  };
  network: {
    topology: TailscaleTopology;
    backend: TailscaleBackendState;
    route: TailscaleServeRouteState;
    owned: boolean;
  };
  agents: Array<{
    id: string;
    displayName?: string;
    registered: true;
    /** null means an older/unavailable broker did not report the live creation probe. */
    canCreateSession: boolean | null;
    /** Persisted/effective sync configuration where the adapter exposes it (currently Codex). */
    syncEnabled?: boolean;
  }>;
  sessions: { total: number; active: number } | null;
  updates: { pending: number } | null;
  detailCodes: string[];
}

export interface LifecycleCommandResult {
  schemaVersion: 1;
  status: 'complete' | 'blocked' | 'failed' | 'rolled-back' | 'cleanup-required' | 'cancelled';
  exitCode: 0 | 1 | 2 | 3 | 4;
  detailCode: string;
  summary: string;
  actions?: string[];
  remaining?: string[];
}

export interface RepairPlan {
  schemaVersion: 1;
  actions: Array<{ id: string; summary: string; legacy: boolean }>;
  blockers: Array<{ detailCode: string; summary: string }>;
  warnings: Array<{ detailCode: string; summary: string }>;
}

export interface RepairOptions extends LifecycleBaseOptions {
  confirmed: boolean;
  allowLegacyIntegrations: boolean;
  expectedPlan?: RepairPlan;
  acquireLock?: (options: { command: 'repair'; home: string }) => InstallationLockHandle;
  /** Bounds the post-reconcile identity probe, mirroring setup's `serviceHealthAttempts` dependency. */
  serviceHealthAttempts?: number;
}

export interface UninstallPlan {
  schemaVersion: 1;
  actions: Array<{ id: string; target: string; legacy: boolean }>;
  warnings: Array<{ detailCode: string; summary: string }>;
  /**
   * Informational disconnection notices shown before confirmation (e.g. live synced sessions that will drop
   * but remain resumable). Unlike `warnings`, advisories never make uninstall a cleanup-required outcome.
   * Only the volatile live-session count inside `codex-daemon-sessions-disconnect` is excluded from the
   * plan-stability equality check; every other summary is compared verbatim.
   */
  advisories: Array<{ detailCode: string; summary: string }>;
  purgeInventory: Array<{ id: string; path: string }>;
}

export interface UninstallOptions extends LifecycleBaseOptions {
  confirmed: boolean;
  allowLegacyIntegrations: boolean;
  purgeData: boolean;
  purgeConfirmed: boolean;
  expectedPlan?: UninstallPlan;
  acquireLock?: (options: { command: 'uninstall'; home: string }) => InstallationLockHandle;
  /** Injected so fixtures exercise Tokdash reversal without pipx or a real install on the host. */
  tokdashRunner?: TokdashCommandRunner;
}

interface LifecycleEnvironment {
  home: string;
  cacheRoot: string;
  context: SetupDiagnosisContext;
  config?: BrokerConfig;
  setupState: ReturnType<typeof readSetupState>;
  install: ReturnType<typeof inspectInstallState>;
  provider?: DurableServiceProvider;
  tailscale: TailscaleServeInspection;
  tailscaleProvider?: TailscaleServeRouteProvider;
  piAgentDir: string;
  claudeSettingsPath: string;
  agentSkills: AgentSkillInspection[];
}

interface FileSnapshot {
  path: string;
  existed: boolean;
  bytes?: Uint8Array;
  mode?: number;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function resource(state: CommittedInstallState | undefined, id: string): InstalledResourceRecord | undefined {
  return state?.resources.find((candidate) => candidate.id === id);
}

function resourceOwnedAt(record: InstalledResourceRecord | undefined, target: string): boolean {
  return !!record && resolve(record.target) === resolve(target);
}

function validSha256(value: string | undefined): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function pathWithin(root: string, target: string): boolean {
  const base = resolve(root);
  const candidate = resolve(target);
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

function cacheRoot(options: LifecycleBaseOptions, context: SetupDiagnosisContext): string {
  return options.cacheRoot
    ?? context.env.COSYNCING_CACHE_DIR?.trim()
    ?? artifactCacheRoot();
}

export function createLifecycleSystemdProvider(options: LifecycleBaseOptions): DurableServiceProvider {
  const context = options.context ?? createSetupDiagnosisContext();
  const home = options.home ?? setupStateHome();
  return (options.systemdProviderFactory ?? createDurableServiceProvider)({
    context,
    homeDir: context.homeDir,
    stateHome: home,
    cacheRoot: cacheRoot(options, context),
    // The same resolution setup used when it wrote the unit, so status/repair compare against the identical
    // expected definition no matter which binary (installed copy or acquisition launcher) is running now.
    executablePath: serviceExecutablePath({
      packaged: options.buildInfo.packaged,
      home,
      executablePath: options.executablePath,
    }),
    agentExecutableDirectories: serviceAgentExecutableDirectories(context),
    agentExecutableOverrides: serviceAgentExecutableOverrides(context),
    // Same reason, same inputs: the service cannot resolve the sidecar from the binary it execs, so status
    // and repair must expect the identical explicit path setup wrote.
    webDir: serviceFlutterWebRoot({
      override: context.env.COSYNCING_WEB_DIR,
      packaged: options.buildInfo.packaged,
      executablePath: options.executablePath,
      version: options.buildInfo.version,
    }),
  });
}

async function environment(options: LifecycleBaseOptions): Promise<LifecycleEnvironment> {
  const home = options.home ?? setupStateHome();
  const context = options.context ?? createSetupDiagnosisContext();
  const configInspection = inspectBrokerConfig(home);
  const config = configInspection.status === 'ok' ? configInspection.config : undefined;
  const setupState = readSetupState(home);
  const install = inspectInstallState(home);
  const provider = isDurableServiceChoice(setupState.serviceChoice)
    ? createLifecycleSystemdProvider({ ...options, home, context })
    : undefined;
  const internalUrl = config?.broker.internalUrl ?? 'http://127.0.0.1:7734';
  const tailscale = await inspectTailscaleServe({ context, internalUrl });
  let tailscaleProvider: TailscaleServeRouteProvider | undefined;
  if (tailscale.executablePath) {
    tailscaleProvider = (options.tailscaleProviderFactory ?? ((providerOptions) => new TailscaleServeProvider(providerOptions)))({
      context,
      internalUrl,
      executablePath: tailscale.executablePath,
    });
  }
  return {
    home,
    cacheRoot: cacheRoot(options, context),
    context,
    config,
    setupState,
    install,
    provider,
    tailscale,
    tailscaleProvider,
    piAgentDir: options.piAgentDir ?? context.env.PI_CODING_AGENT_DIR?.trim() ?? join(context.homeDir, '.pi', 'agent'),
    claudeSettingsPath: options.claudeSettingsPath ?? join(
      context.env.CLAUDE_CONFIG_DIR?.trim() ?? join(context.homeDir, '.claude'),
      'settings.json',
    ),
    agentSkills: inspectAgentSkills(context),
  };
}

function matchingAgentSkillReceipt(
  env: LifecycleEnvironment,
  target: AgentSkillInspection,
): InstalledResourceRecord | undefined {
  if (!env.install.committed) return undefined;
  const receipt = resource(env.install.state, target.resourceId);
  return receipt
    && receipt.kind === 'agent-integration'
    && resolve(receipt.target) === resolve(target.path)
    && receipt.ownership?.proof === 'package-hash'
    && receipt.ownership.installedSha256 === AGENT_SKILL_SHA256
    ? receipt
    : undefined;
}

/**
 * owned-stale: the on-disk copy is an OLDER packaged version, but a receipt proves we installed exactly that
 * content (receipt.installedSha256 === the file's actual sha). Repair refreshes it to the current build.
 */
function agentSkillOwnedStale(
  env: LifecycleEnvironment,
  target: AgentSkillInspection,
): boolean {
  if (!env.install.committed || target.status !== 'drifted' || !target.actualSha256) return false;
  const receipt = resource(env.install.state, target.resourceId);
  return !!receipt
    && receipt.kind === 'agent-integration'
    && resolve(receipt.target) === resolve(target.path)
    && receipt.ownership?.proof === 'package-hash'
    && receipt.ownership.installedSha256 === target.actualSha256;
}

function matchingTailscaleReceipt(env: LifecycleEnvironment): boolean {
  if (!env.install.committed || !env.tailscale.advertisedUrl) return false;
  const receipt = resource(env.install.state, TAILSCALE_SERVE_RESOURCE_ID);
  return !!receipt && receipt.kind === 'other' && receipt.ownership.proof === 'receipt'
    && receipt.ownership.marker === TAILSCALE_SERVE_OWNERSHIP_MARKER
    && receipt.target === tailscaleRouteReceiptTarget(env.tailscale);
}

async function endpointIdentity(
  context: SetupDiagnosisContext,
  url: string | undefined,
  machine: string | undefined,
): Promise<'ready' | 'unreachable' | 'unconfigured' | 'identity-mismatch'> {
  if (!url || !machine) return 'unconfigured';
  const response = await context.fetchJson(new URL('/api/health', url).toString());
  if (response.status !== 'ok') return 'unreachable';
  const body = response.json && typeof response.json === 'object' && !Array.isArray(response.json)
    ? response.json as Record<string, unknown>
    : {};
  return body.ok === true && body.product === PRODUCT_IDENTITY.productName && body.machine === machine
    ? 'ready'
    : 'identity-mismatch';
}

/**
 * `endpointIdentity`, retried while a just-restarted broker is still coming up.
 *
 * Same shape and same bound as {@link awaitServiceState}, for the same reason: a process that has been
 * execed has not bound its port yet, so the first probe after a start reports `unreachable` for a broker
 * that is about to be perfectly healthy. Single-shot sampling there is what let a normally-booting service
 * fail repair's verification and take a rollback with it. `unconfigured` short-circuits — no URL or machine
 * label is a state no amount of waiting changes.
 */
async function awaitEndpointIdentity(options: {
  context: SetupDiagnosisContext;
  url: string | undefined;
  machine: string | undefined;
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
}): Promise<'ready' | 'unreachable' | 'unconfigured' | 'identity-mismatch'> {
  const attempts = Math.max(1, options.attempts ?? 30);
  const delayMs = Math.max(1, options.delayMs ?? 250);
  const deadline = Date.now() + Math.max(1, options.timeoutMs ?? SERVICE_TRANSITION_TIMEOUT_MS);
  let identity = await endpointIdentity(options.context, options.url, options.machine);
  for (let index = 1; index < attempts && identity !== 'ready'; index += 1) {
    if (identity === 'unconfigured' || Date.now() >= deadline) return identity;
    await Bun.sleep(delayMs);
    identity = await endpointIdentity(options.context, options.url, options.machine);
  }
  return identity;
}

async function authenticatedJson(
  env: LifecycleEnvironment,
  path: string,
): Promise<unknown | undefined> {
  if (!env.config) return undefined;
  const tokenInspection = inspectBrokerToken(brokerTokenPath(env.home));
  if (tokenInspection.status !== 'ok') return undefined;
  const response = await env.context.fetchJson(
    new URL(path, env.config.broker.internalUrl).toString(),
    { [PRODUCT_IDENTITY.tokenHeader]: readBrokerToken(tokenInspection.path) },
  );
  return response.status === 'ok' ? response.json : undefined;
}

export async function collectLifecycleStatus(options: LifecycleBaseOptions): Promise<LifecycleStatusReport> {
  const env = await environment(options);
  const serviceStatus = env.provider ? await env.provider.inspect() : undefined;
  const [internal, advertised, agentsRaw, sessionsRaw, updatesRaw] = await Promise.all([
    endpointIdentity(env.context, env.config?.broker.internalUrl, env.config?.broker.machineLabel),
    endpointIdentity(env.context, env.config?.broker.advertisedUrl, env.config?.broker.machineLabel),
    authenticatedJson(env, '/api/agents'),
    authenticatedJson(env, '/api/sessions'),
    authenticatedJson(env, '/api/agent-runtime-updates'),
  ]);
  const agents = Array.isArray(agentsRaw)
    ? agentsRaw.flatMap((candidate): LifecycleStatusReport['agents'] => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
        const row = candidate as Record<string, unknown>;
        if (typeof row.id !== 'string') return [];
        return [{
          id: row.id,
          ...(typeof row.displayName === 'string' ? { displayName: row.displayName } : {}),
          registered: true,
          canCreateSession: typeof row.canCreateSession === 'boolean' ? row.canCreateSession : null,
          ...(typeof row.syncEnabled === 'boolean' ? { syncEnabled: row.syncEnabled } : {}),
        }];
      })
    : [];
  const sessionsArray = Array.isArray(sessionsRaw)
    ? sessionsRaw
    : sessionsRaw && typeof sessionsRaw === 'object' && Array.isArray((sessionsRaw as Record<string, unknown>).sessions)
      ? (sessionsRaw as { sessions: unknown[] }).sessions
      : undefined;
  const sessions = sessionsArray
    ? {
        total: sessionsArray.length,
        active: sessionsArray.filter((candidate) => candidate && typeof candidate === 'object'
          && ['active', 'working', 'waiting'].includes(String((candidate as Record<string, unknown>).status))).length,
      }
    : null;
  const updateRows = Array.isArray(updatesRaw)
    ? updatesRaw
    : updatesRaw && typeof updatesRaw === 'object' && Array.isArray((updatesRaw as Record<string, unknown>).updates)
      ? (updatesRaw as { updates: unknown[] }).updates
      : undefined;
  const updates = updateRows
    ? { pending: updateRows.filter((candidate) => candidate && typeof candidate === 'object'
      && (candidate as Record<string, unknown>).pending === true).length }
    : null;
  const detailCodes: string[] = [];
  if (!env.install.committed) detailCodes.push(`installation-${env.install.reason}`);
  if (!env.config) detailCodes.push('broker-config-invalid');
  if (isDurableServiceChoice(env.setupState.serviceChoice) && serviceStatus?.active !== 'active') detailCodes.push(`service-${serviceStatus?.active ?? 'unknown'}`);
  if (internal !== 'ready') detailCodes.push(`internal-endpoint-${internal}`);
  if (env.config?.broker.advertisedUrl && advertised !== 'ready') detailCodes.push(`advertised-endpoint-${advertised}`);
  if (env.setupState.tailscaleServeRequested && env.tailscale.route !== 'desired') detailCodes.push(`tailscale-route-${env.tailscale.route}`);
  return {
    schemaVersion: 1,
    product: PRODUCT_IDENTITY.productName,
    version: options.buildInfo.version,
    ok: detailCodes.length === 0,
    installation: {
      committed: env.install.committed,
      detailCode: env.install.committed ? 'installation-committed' : `installation-${env.install.reason}`,
    },
    service: {
      mode: env.setupState.serviceChoice ?? 'unconfigured',
      supported: serviceStatus?.supported ?? env.setupState.serviceChoice === 'foreground',
      active: serviceStatus?.active ?? (internal === 'ready' ? 'active' : 'inactive'),
      enabled: serviceStatus?.enabled ?? 'unknown',
      definition: serviceStatus?.definition ?? 'missing',
      environment: serviceStatus?.environment ?? 'missing',
    },
    endpoints: { internal, advertised },
    network: {
      topology: env.tailscale.topology,
      backend: env.tailscale.backend,
      route: env.tailscale.route,
      owned: matchingTailscaleReceipt(env),
    },
    agents,
    sessions,
    updates,
    detailCodes,
  };
}

function commandResult(
  status: LifecycleCommandResult['status'],
  exitCode: LifecycleCommandResult['exitCode'],
  detailCode: string,
  summary: string,
  extra: Pick<LifecycleCommandResult, 'actions' | 'remaining'> = {},
): LifecycleCommandResult {
  return { schemaVersion: 1, status, exitCode, detailCode, summary, ...extra };
}

/**
 * Stable equality key for the plan-confirmation gate. Only the volatile live-session count inside the
 * `codex-daemon-sessions-disconnect` advisory summary is normalized away: a session finishing between
 * confirmation and the locked re-inspect is not a real ownership change. Every other summary — including
 * the Claude legacy-hook entry count in `claude-hooks.remove-legacy` — is compared verbatim, so a changed
 * hook count (or any other real drift) still blocks with `*-plan-changed`. Structural identity — action
 * ids/targets/legacy, warning/blocker/advisory detailCodes, and the purge inventory — is fully preserved.
 */
function stablePlanKey(plan: RepairPlan | UninstallPlan): string {
  const clone = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
  const advisories = clone.advisories;
  if (Array.isArray(advisories)) {
    for (const item of advisories) {
      if (item && typeof item === 'object'
          && (item as Record<string, unknown>).detailCode === 'codex-daemon-sessions-disconnect') {
        delete (item as Record<string, unknown>).summary;
      }
    }
  }
  return JSON.stringify(clone);
}

function samePlan(left: RepairPlan | UninstallPlan, right: RepairPlan | UninstallPlan): boolean {
  return stablePlanKey(left) === stablePlanKey(right);
}

/**
 * Default read-only Codex daemon probe. Gates on the CONTEXT-resolved codex binary so isolated test fixtures
 * (whose context never resolves `codex`) never reach the real daemon. `readCodexDaemonVersion` and
 * `queryCodexLoadedThreadIdsStrict` talk to the daemon directly over its control socket — no running broker.
 */
async function defaultCodexDaemonProbe(context: SetupDiagnosisContext): Promise<CodexDaemonStatus> {
  const socketFingerprint = codexAppServerSocketFingerprint();
  if (!context.resolveExecutable('codex')) return { binaryAvailable: false, running: false, ...(socketFingerprint ? { socketFingerprint } : {}) };
  let version;
  try {
    version = await readCodexDaemonVersion();
  } catch {
    // A probe ERROR is not proof the daemon is down (the version command never answered). Report the state
    // as potentially running so an owned instance still gets a — self-correcting, idempotent — stop plan.
    return { binaryAvailable: true, running: true, ...(socketFingerprint ? { socketFingerprint } : {}) };
  }
  if (!version) return { binaryAvailable: true, running: false, ...(socketFingerprint ? { socketFingerprint } : {}) };
  let loadedThreadCount: number | undefined;
  try {
    loadedThreadCount = (await queryCodexLoadedThreadIdsStrict()).size;
  } catch {
    /* best-effort count; a transient list failure leaves the disconnection notice count-free (undefined) */
  }
  return { binaryAvailable: true, running: true, ...(loadedThreadCount === undefined ? {} : { loadedThreadCount }), ...(socketFingerprint ? { socketFingerprint } : {}) };
}

/**
 * Prove the live daemon is the instance the broker started: the recorded control-socket fingerprint must
 * match the live socket exactly. A replacement daemon recreates the socket file (new inode/mtime), and a
 * record without a fingerprint (pre-fingerprint era) is unproven — both fail closed.
 */
function codexDaemonSocketFingerprintMatches(
  recorded: CodexDaemonSocketFingerprint | undefined,
  current: CodexDaemonSocketFingerprint | undefined,
): boolean {
  return !!recorded && !!current
    && recorded.dev === current.dev
    && recorded.ino === current.ino
    && recorded.mtimeMs === current.mtimeMs;
}

export async function runServiceCommand(
  action: 'start' | 'stop' | 'restart',
  options: LifecycleBaseOptions,
): Promise<LifecycleCommandResult> {
  const env = await environment(options);
  if (!env.install.committed) return commandResult('blocked', 1, 'service-installation-uncommitted', 'Run cosyncing setup first.');
  if (!env.provider) {
    return commandResult('blocked', 1, 'service-foreground-mode', `This installation uses foreground mode; run ${PRODUCT_IDENTITY.primaryBinary} broker.`);
  }
  try {
    const before = await env.provider.inspect();
    if (!before.supported || before.definition !== 'current' || before.environment !== 'current') {
      return commandResult('blocked', 1, 'service-repair-required', 'The owned service is missing or drifted; run cosyncing repair.');
    }
    await env.provider[action]();
    // launchd's verbs return before the transition completes (kickstart requests a spawn, kill delivers a
    // signal), so the post-condition must be waited for rather than sampled once. systemd already blocks and
    // satisfies this on the first sample.
    const expected = action === 'stop' ? 'inactive' : 'active';
    const after = await awaitServiceState({ provider: env.provider, expected });
    if (after.active !== expected) return commandResult('failed', 1, `service-${action}-verify-failed`, `Service ${action} did not reach ${expected}.`);
    return commandResult('complete', 0, `service-${action}-complete`, `cosyncing service is ${after.active}.`, { actions: [action] });
  } catch {
    return commandResult('failed', 1, `service-${action}-failed`, `Could not ${action} the cosyncing ${env.provider.id} user service.`);
  }
}

export async function readServiceLogs(options: LifecycleBaseOptions & {
  lines: number;
  follow: boolean;
  onOutput?: (text: string) => void;
}): Promise<{ result: LifecycleCommandResult; output: string }> {
  const env = await environment(options);
  if (!env.provider) {
    return { result: commandResult('blocked', 1, 'logs-foreground-mode', 'Foreground broker logs remain in the launching terminal.'), output: '' };
  }
  // The provider owns the whole argv: journald selects a unit, launchd tails its own StandardOut/StandardError
  // files, and neither shape survives splicing the other's flags in.
  const [executable, ...args] = env.provider.logsCommand({
    follow: options.follow,
    lines: Math.min(10_000, Math.max(1, options.lines)),
  });
  if (!executable || !isAbsolute(executable)) {
    return { result: commandResult('failed', 1, 'logs-command-unavailable', 'The service log command is unavailable.'), output: '' };
  }
  if (options.follow && !options.runner) {
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn([executable, ...args], {
        env: { ...env.context.env },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch {
      return { result: commandResult('failed', 1, 'logs-command-unavailable', 'The service log command is unavailable.'), output: '' };
    }
    let captured = '';
    const emit = (value: string): void => {
      const redacted = sanitizeManagedRuntimeOutput(value);
      options.onOutput?.(redacted);
      if (!options.onOutput) captured = `${captured}${redacted}`.slice(-16_384);
    };
    const consume = async (stream: number | ReadableStream<Uint8Array> | undefined): Promise<void> => {
      if (!(stream instanceof ReadableStream)) return;
      const reader = stream.getReader();
      let pending = '';
      let withholdingOversizedLine = false;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          let chunk = Buffer.from(next.value).toString('utf8');
          if (withholdingOversizedLine) {
            const newline = chunk.indexOf('\n');
            if (newline < 0) continue;
            chunk = chunk.slice(newline + 1);
            withholdingOversizedLine = false;
          }
          pending += chunk;
          for (;;) {
            const newline = pending.indexOf('\n');
            if (newline < 0) break;
            const line = pending.slice(0, newline + 1);
            pending = pending.slice(newline + 1);
            emit(line.length > 16_384 ? '[log entry withheld because it exceeded the redaction limit]\n' : line);
          }
          if (pending.length > 16_384) {
            emit('[log entry withheld because it exceeded the redaction limit]\n');
            pending = '';
            withholdingOversizedLine = true;
          }
        }
        if (pending && !withholdingOversizedLine) emit(pending);
      } finally {
        reader.releaseLock();
      }
    };
    let interrupted = false;
    const stop = (): void => {
      interrupted = true;
      try { child.kill('SIGTERM'); } catch { /* child already exited */ }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const streams = Promise.allSettled([consume(child.stdout), consume(child.stderr)]);
    const exitCode = await child.exited;
    await streams;
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    return {
      result: interrupted || exitCode === 0
        ? commandResult('complete', 0, 'logs-follow-complete', 'Stopped following redacted service logs.')
        : commandResult('failed', 1, 'logs-follow-failed', 'The service log follower exited unexpectedly.'),
      output: captured,
    };
  }
  const runner = options.runner ?? createServiceCommandRunner(env.context.env);
  const response = await runner.run(executable, args, options.follow ? 60_000 : 15_000);
  const raw = `${response.stdout}${response.stderr ? `\n${response.stderr}` : ''}`;
  const output = sanitizeManagedRuntimeOutput(raw);
  if (response.status !== 'ok' && !(options.follow && response.status === 'timeout')) {
    return { result: commandResult('failed', 1, 'logs-read-failed', 'Could not read redacted service log output.'), output };
  }
  return { result: commandResult('complete', 0, 'logs-read-complete', 'Redacted service logs follow.'), output };
}

function snapshot(path: string): FileSnapshot {
  assertNoSymlinkComponents(path, false);
  if (!existsSync(path)) return { path, existed: false };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('repair-target-unsafe');
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && stat.uid !== uid) throw new Error('repair-target-owner-mismatch');
  return { path, existed: true, bytes: readFileSync(path), mode: stat.mode & 0o777 };
}

function restore(snapshotValue: FileSnapshot): void {
  if (snapshotValue.existed) {
    if (!snapshotValue.bytes) throw new Error('repair-snapshot-missing');
    atomicWriteOwnerOnly(snapshotValue.path, snapshotValue.bytes, { mode: snapshotValue.mode ?? 0o600 });
    return;
  }
  if (!existsSync(snapshotValue.path)) return;
  const stat = lstatSync(snapshotValue.path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('repair-rollback-target-unsafe');
  unlinkSync(snapshotValue.path);
}

function removeLegacyClaudeEntries(path: string): { removed: number; embeddedCredential: boolean } {
  const original = readFileSync(path, 'utf8');
  let settings: Record<string, unknown>;
  try {
    const parsed = JSON.parse(original);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    settings = parsed as Record<string, unknown>;
  } catch {
    throw new Error('claude-settings-malformed');
  }
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return { removed: 0, embeddedCredential: false };
  let removed = 0;
  let embeddedCredential = false;
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
      const commands = Array.isArray((entry as Record<string, unknown>).hooks)
        ? ((entry as Record<string, unknown>).hooks as unknown[]).flatMap((hook) => {
            if (!hook || typeof hook !== 'object' || Array.isArray(hook)) return [];
            const command = (hook as Record<string, unknown>).command;
            return typeof command === 'string' ? [command] : [];
          })
        : [];
      const ours = commands.some((command) => command.includes(CLAUDE_HOOK_LEGACY_MARKER));
      if (ours) {
        removed += 1;
        if (commands.some((command) => /(?:COSYNCING_TOKEN\s*=|x-cosyncing-token\s*[:=])/i.test(command))) embeddedCredential = true;
      }
      return !ours;
    });
    if (filtered.length > 0) (hooks as Record<string, unknown>)[event] = filtered;
    else delete (hooks as Record<string, unknown>)[event];
  }
  if (removed > 0) atomicWriteOwnerOnly(path, `${JSON.stringify(settings, null, 2)}\n`, { preserveMode: true });
  return { removed, embeddedCredential };
}

function verifiedPathBackup(home: string, item: InstalledResourceRecord): Uint8Array {
  const backupPath = item.ownership.backupPath;
  if (!backupPath) throw new Error('path-entry-backup-missing');
  if (!item.ownership.originalSha256) throw new Error('path-entry-original-hash-missing');
  const backup = resolve(backupPath);
  const backupRoot = `${resolve(join(home, 'backups'))}${sep}`;
  if (!backup.startsWith(backupRoot)) throw new Error('path-entry-backup-outside-root');
  assertNoSymlinkComponents(backup);
  const stat = lstatSync(backup);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (stat.isSymbolicLink() || !stat.isFile() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error('path-entry-backup-unsafe');
  }
  const bytes = readFileSync(backup);
  if (sha256(bytes) !== item.ownership.originalSha256) {
    throw new Error('path-entry-backup-drift');
  }
  return bytes;
}

export async function inspectRepair(options: LifecycleBaseOptions): Promise<RepairPlan> {
  const env = await environment(options);
  const actions: RepairPlan['actions'] = [];
  const blockers: RepairPlan['blockers'] = [];
  const warnings: RepairPlan['warnings'] = [];
  if (!env.install.committed) blockers.push({ detailCode: 'repair-installation-uncommitted', summary: 'Run setup before repair.' });
  // A pending setup journal means an interrupted transaction still owns part of the machine. Repair
  // reconciles COMMITTED state and never consumes those journals, so proceeding would compare against a
  // half-applied installation and report "already matches declared state" while the transaction sits
  // unresolved. Setup owns its own recovery; say so instead of silently doing nothing.
  if (readSetupTransactionJournal(env.home)) {
    blockers.push({
      detailCode: 'repair-setup-transaction-pending',
      summary: `An interrupted setup transaction is still pending. Rerun \`${PRODUCT_IDENTITY.primaryBinary} setup\`, which rolls it back before replanning.`,
    });
  }
  if (!env.config) blockers.push({ detailCode: 'repair-config-invalid', summary: 'The broker configuration is missing or unsafe.' });
  const migrationPlan = planDurableStateMigrations(durableStateLayout({ stateRoot: env.home, cacheRoot: env.cacheRoot }));
  for (const blocker of migrationPlan.blockers) {
    blockers.push({ detailCode: blocker.detailCode, summary: `Durable ${blocker.store} state requires explicit recovery.` });
  }
  if (migrationPlan.steps.length > 0) {
    actions.push({ id: 'schema.migrate', summary: 'Back up both durable roots and apply the displayed backward-compatible schema migration.', legacy: false });
  }
  const assets = inspectRuntimeAssets();
  if (!assets.ok) blockers.push({ detailCode: 'repair-runtime-assets-invalid', summary: 'The packaged binary is missing a required embedded asset.' });
  if (env.config) {
    const broker = inspectBrokerToken(brokerTokenPath(env.home));
    const piCredential = inspectPiIntegration(piIntegrationPath(env.home));
    if (broker.status !== 'ok' || piCredential.status !== 'ok'
        || (piCredential.status === 'ok' && readPiIntegration(piCredential.path).internalUrl !== env.config.broker.internalUrl)) {
      actions.push({ id: 'credentials.reconcile', summary: 'Reconcile owner-only broker and Pi-scoped credentials with the internal URL.', legacy: false });
    }
  }
  const pi = inspectPiBridgeAsset(env.piAgentDir);
  const piReceipt = env.install.committed ? resource(env.install.state, 'pi-bridge') : undefined;
  if (pi.status === 'missing' && piReceipt) actions.push({ id: 'pi-bridge.install', summary: 'Restore the receipt-owned packaged Pi bridge.', legacy: false });
  else if (pi.status === 'legacy-marker') actions.push({ id: 'pi-bridge.replace-legacy', summary: 'Replace the marker-owned repo-era Pi bridge after explicit confirmation.', legacy: true });
  else if (pi.status === 'unowned' || pi.status === 'unreadable') warnings.push({ detailCode: `pi-bridge-${pi.status}`, summary: 'Preserve the unknown or modified Pi bridge and provide manual guidance.' });

  for (const target of env.agentSkills) {
    const receipt = matchingAgentSkillReceipt(env, target);
    const ownedStale = agentSkillOwnedStale(env, target);
    const anyReceipt = env.install.committed ? resource(env.install.state, target.resourceId) : undefined;
    if (receipt && target.status === 'missing') {
      actions.push({
        id: `agent-skill.restore.${target.id}`,
        summary: `Restore the receipt-owned cosyncing skill in the ${target.id} discovery root.`,
        legacy: false,
      });
    } else if (ownedStale) {
      actions.push({
        id: `agent-skill.restore.${target.id}`,
        summary: `Refresh the packaged cosyncing skill to this build's version in the ${target.id} discovery root.`,
        legacy: false,
      });
    } else if (receipt && !['missing', 'owned'].includes(target.status)) {
      warnings.push({
        detailCode: `agent-skill-${target.id}-unowned-drift`,
        summary: `Preserve the modified or unsafe ${target.id} cosyncing skill.`,
      });
    } else if (anyReceipt && !receipt) {
      warnings.push({
        detailCode: `agent-skill-${target.id}-receipt-invalid`,
        summary: `Preserve the ${target.id} skill because its ownership receipt is invalid.`,
      });
    }
  }

  const claude = inspectLegacyClaudeHooks(env.claudeSettingsPath);
  if (claude.status === 'legacy-marker') actions.push({ id: 'claude-hooks.remove-legacy', summary: `Remove ${claude.entryCount} marker-owned Claude hook entries and preserve all unrelated settings.`, legacy: true });
  else if (claude.status === 'unreadable') warnings.push({ detailCode: 'claude-settings-unreadable', summary: 'Preserve unreadable Claude settings.' });

  if (env.provider) {
    const status = await env.provider.inspect();
    const serviceReceipt = env.install.committed
      && resourceOwnedAt(resource(env.install.state, serviceDefinitionResourceId(env.provider)), env.provider.definitionPath);
    if (status.definition !== 'current' || status.environment !== 'current' || status.enabled !== 'enabled') {
      if (serviceReceipt || (status.definition === 'missing' && status.environment === 'missing')) {
        actions.push({ id: 'service.reconcile', summary: `Reinstall the typed ${env.provider.id} definition and owner-only environment.`, legacy: false });
      } else {
        blockers.push({ detailCode: 'service-unowned-drift', summary: `The ${env.provider.id} files drifted without matching ownership evidence.` });
      }
    }
    if (status.active !== 'active') actions.push({ id: 'service.start', summary: `Start and verify the configured ${env.provider.id} service.`, legacy: false });
  }

  const tailscaleOwned = matchingTailscaleReceipt(env);
  if (env.setupState.tailscaleServeRequested === true) {
    if (env.tailscale.route === 'missing') actions.push({ id: 'tailscale.register', summary: 'Restore the requested private HTTPS root route.', legacy: false });
    else if (env.tailscale.route !== 'desired') blockers.push({ detailCode: `tailscale-route-${env.tailscale.route}`, summary: 'A conflicting or unsafe Serve route is preserved.' });
    else if (env.install.committed && resource(env.install.state, TAILSCALE_SERVE_RESOURCE_ID) && !tailscaleOwned) {
      blockers.push({ detailCode: 'tailscale-receipt-drift', summary: 'The live private route no longer matches its ownership receipt.' });
    }
  } else if (tailscaleOwned && env.tailscale.route === 'desired') {
    actions.push({ id: 'tailscale.remove', summary: 'Remove the receipt-owned route no longer declared by setup state.', legacy: false });
  }
  const binaryReceipt = env.install.committed ? resource(env.install.state, 'broker-binary') : undefined;
  // The receipt names the installed home copy, not whatever binary is running this command, so repair and
  // status agree from either invocation path (the installed copy or an npm/alias launcher for it).
  const expectedBinary = installedBinaryPath(env.home);
  if (options.buildInfo.packaged && !binaryReceipt) {
    blockers.push({ detailCode: 'broker-binary-receipt-missing', summary: 'The packaged binary ownership receipt is missing.' });
  } else if (binaryReceipt) {
    if (binaryReceipt.kind !== 'binary' || !resourceOwnedAt(binaryReceipt, expectedBinary)) {
      blockers.push({ detailCode: 'broker-binary-receipt-invalid', summary: 'The installed binary receipt does not name the product binary.' });
    } else if (!existsSync(binaryReceipt.target)) {
      blockers.push({ detailCode: 'broker-binary-missing', summary: 'The receipt-owned product binary is missing.' });
    } else {
      try {
        assertNoSymlinkComponents(binaryReceipt.target, false);
        const stat = lstatSync(binaryReceipt.target);
        const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
        if (stat.isSymbolicLink() || !stat.isFile() || (uid !== undefined && stat.uid !== uid)) {
          throw new Error('broker-binary-unsafe');
        }
        const actual = sha256(readFileSync(binaryReceipt.target));
        if (binaryReceipt.ownership.installedSha256 && binaryReceipt.ownership.installedSha256 !== actual) {
          blockers.push({ detailCode: 'broker-binary-hash-drift', summary: 'The installed binary differs from its ownership receipt.' });
        } else if (!binaryReceipt.ownership.installedSha256) {
          actions.push({ id: 'receipt.binary-hash', summary: 'Record the current installed binary hash in the ownership receipt.', legacy: false });
        }
      } catch {
        blockers.push({ detailCode: 'broker-binary-unsafe', summary: 'The receipt-owned product binary is not a safe regular file.' });
      }
    }
  }
  return { schemaVersion: 1, actions, blockers, warnings };
}

function mergeResources(state: CommittedInstallState, incoming: readonly InstalledResourceRecord[]): CommittedInstallState {
  const resources = new Map(state.resources.map((item) => [item.id, item]));
  for (const item of incoming) resources.set(item.id, item);
  return { ...state, resources: [...resources.values()].sort((left, right) => left.id.localeCompare(right.id)) };
}

export async function runRepair(options: RepairOptions): Promise<LifecycleCommandResult> {
  const plan = options.expectedPlan ?? await inspectRepair(options);
  if (plan.blockers.length > 0) return commandResult('blocked', 1, plan.blockers[0]!.detailCode, plan.blockers[0]!.summary, { remaining: plan.blockers.map((item) => item.detailCode) });
  if (plan.actions.length === 0) {
    return plan.warnings.length
      ? commandResult('cleanup-required', 4, plan.warnings[0]!.detailCode, 'Repair found resources that cannot be changed safely.', { remaining: plan.warnings.map((item) => item.detailCode) })
      : commandResult('complete', 0, 'repair-noop', 'The owned installation already matches declared state.', { actions: [] });
  }
  if (!options.confirmed) return commandResult('cancelled', 2, 'repair-confirmation-required', 'Repair requires confirmation after displaying the mutation plan.');
  if (plan.actions.some((action) => action.legacy) && !options.allowLegacyIntegrations) {
    return commandResult('blocked', 2, 'legacy-integration-confirmation-required', 'Legacy marker evidence requires separate confirmation.');
  }
  let env = await environment(options);
  if (!env.install.committed || !env.config) return commandResult('blocked', 1, 'repair-precondition-changed', 'Repair preconditions changed; rerun inspection.');
  const acquire = options.acquireLock ?? ((input) => acquireInstallationLock(input));
  let lock: InstallationLockHandle;
  try { lock = acquire({ command: 'repair', home: env.home }); }
  catch { return commandResult('blocked', 1, 'installation-lock-unavailable', 'Another installation mutation is active or the lock is unsafe.'); }
  const snapshots: FileSnapshot[] = [];
  const rollback: Array<() => Promise<void> | void> = [];
  const completed: string[] = [];
  let nextState = env.install.state;
  try {
    const lockedPlan = await inspectRepair(options);
    if (!samePlan(plan, lockedPlan)) {
      return commandResult('blocked', 1, 'repair-plan-changed', 'Repair state changed after confirmation; inspect and confirm the new plan.');
    }
    env = await environment(options);
    if (!env.install.committed || !env.config) {
      return commandResult('blocked', 1, 'repair-precondition-changed', 'Repair preconditions changed; rerun inspection.');
    }
    nextState = env.install.state;
    for (const action of plan.actions) {
      if (action.id === 'schema.migrate') {
        snapshots.push(snapshot(setupStatePath(env.home)));
        const migrationPlan = planDurableStateMigrations(durableStateLayout({ stateRoot: env.home, cacheRoot: env.cacheRoot }));
        const migrated = applyDurableStateMigrationsWithLockHeld({
          plan: migrationPlan,
          confirmed: true,
          stateRoot: env.home,
          cacheRoot: env.cacheRoot,
          now: options.now,
        });
        if (migrated.applied.length > 0 && migrated.backupPath) {
          nextState = {
            ...nextState,
            migrations: [
              ...nextState.migrations,
              ...migrationPlan.steps.map((step) => ({
                id: step.id,
                fromVersion: step.fromVersion,
                toVersion: step.toVersion,
                backupPath: migrated.backupPath!,
                appliedAt: (options.now?.() ?? new Date()).toISOString(),
              })),
            ],
          };
        }
      } else if (action.id === 'credentials.reconcile') {
        snapshots.push(snapshot(brokerTokenPath(env.home)), snapshot(piIntegrationPath(env.home)));
        ensureInstallationCredentials({ home: env.home, internalUrl: env.config.broker.internalUrl });
      } else if (action.id === 'pi-bridge.install' || action.id === 'pi-bridge.replace-legacy') {
        const target = inspectPiBridgeAsset(env.piAgentDir).path;
        snapshots.push(snapshot(target));
        const legacyMayContainSharedCredential = action.id.endsWith('legacy')
          && /(?:COSYNCING_TOKEN|x-cosyncing-token)/i.test(readFileSync(target, 'utf8'));
        if (legacyMayContainSharedCredential) {
          if (!snapshots.some((item) => item.path === brokerTokenPath(env.home))) snapshots.push(snapshot(brokerTokenPath(env.home)));
          ensureInstallationCredentials({
            home: env.home,
            internalUrl: env.config.broker.internalUrl,
            rotateBrokerToken: true,
          });
        }
        atomicWriteOwnerOnly(target, PI_BRIDGE_EMBEDDED_SOURCE, { mode: 0o600 });
        nextState = mergeResources(nextState, [{
          id: 'pi-bridge', kind: 'agent-integration', target,
          ownership: { proof: 'package-hash', installedSha256: PI_BRIDGE_EMBEDDED_SHA256 },
        }]);
      } else if (action.id.startsWith('agent-skill.restore.')) {
        const targetId = action.id.slice('agent-skill.restore.'.length);
        const target = env.agentSkills.find((candidate) => candidate.id === targetId);
        const fresh = target ? inspectAgentSkill(target) : undefined;
        const restoreMissing = !!target && !!fresh
          && !!matchingAgentSkillReceipt(env, target) && fresh.status === 'missing';
        const refreshStale = !!fresh && fresh.status === 'drifted' && agentSkillOwnedStale(env, fresh);
        if (!target || (!restoreMissing && !refreshStale)) {
          throw new Error('agent-skill-repair-precondition-changed');
        }
        snapshots.push(snapshot(target.path));
        atomicWriteOwnerOnly(target.path, AGENT_SKILL_SOURCE, { mode: 0o600 });
        nextState = mergeResources(nextState, [{
          id: target.resourceId,
          kind: 'agent-integration',
          target: target.path,
          ownership: { proof: 'package-hash', installedSha256: AGENT_SKILL_SHA256 },
        }]);
      } else if (action.id === 'claude-hooks.remove-legacy') {
        snapshots.push(snapshot(env.claudeSettingsPath));
        const removed = removeLegacyClaudeEntries(env.claudeSettingsPath);
        if (removed.embeddedCredential) {
          if (!snapshots.some((item) => item.path === brokerTokenPath(env.home))) snapshots.push(snapshot(brokerTokenPath(env.home)));
          ensureInstallationCredentials({
            home: env.home,
            internalUrl: env.config.broker.internalUrl,
            rotateBrokerToken: true,
          });
        }
      } else if (action.id === 'service.reconcile') {
        if (!env.provider) throw new Error('service-provider-missing');
        const before = await env.provider.inspect();
        snapshots.push(snapshot(env.provider.definitionPath), snapshot(env.provider.environmentPath));
        rollback.push(async () => {
          await env.provider!.stop().catch(() => undefined);
          await env.provider!.uninstall().catch(() => undefined);
          restore(snapshots.find((item) => item.path === env.provider!.definitionPath)!);
          restore(snapshots.find((item) => item.path === env.provider!.environmentPath)!);
          await env.provider!.reloadDefinition();
          if (before.enabled === 'enabled') await env.provider!.setEnabled(true);
          if (before.active === 'active') await env.provider!.start();
        });
        await env.provider.stop();
        await env.provider.installDefinition();
        if (before.active === 'active') {
          await env.provider.start();
          // Neither provider's start verb means "the job is up": systemd's transition is still running and
          // launchd has only queued the spawn. Verifying on the next sample read the PRE-transition state
          // and threw away a reconcile that in fact succeeded — taking the rollback, and the drift the
          // operator ran repair to remove, with it.
          await awaitServiceState({ provider: env.provider, expected: 'active' });
        }
        nextState = mergeResources(nextState, [
          { id: serviceDefinitionResourceId(env.provider), kind: 'service', target: env.provider.definitionPath, ownership: { proof: 'package-hash', installedSha256: sha256(env.provider.expectedDefinition()) } },
          { id: 'service-environment', kind: 'environment-file', target: env.provider.environmentPath, ownership: { proof: 'package-hash', installedSha256: sha256(env.provider.expectedEnvironment()) } },
        ]);
      } else if (action.id === 'service.start') {
        if (!env.provider) throw new Error('service-provider-missing');
        const before = await env.provider.inspect();
        if (before.active !== 'active') {
          rollback.push(() => env.provider!.stop());
          await env.provider.start();
        }
      } else if (action.id === 'tailscale.register') {
        if (!env.tailscaleProvider) throw new Error('tailscale-provider-missing');
        const before = await env.tailscaleProvider.inspect();
        if (before.route !== 'missing') throw new Error('tailscale-route-precondition-changed');
        rollback.push(() => env.tailscaleProvider!.removePrivateHttpsRoot());
        await env.tailscaleProvider.registerPrivateHttpsRoot();
        const after = await env.tailscaleProvider.inspect();
        if (after.route !== 'desired') throw new Error('tailscale-route-verify-failed');
        nextState = mergeResources(nextState, [{
          id: TAILSCALE_SERVE_RESOURCE_ID,
          kind: 'other',
          target: tailscaleRouteReceiptTarget(after),
          ownership: { proof: 'receipt', marker: TAILSCALE_SERVE_OWNERSHIP_MARKER },
        }]);
      } else if (action.id === 'tailscale.remove') {
        if (!env.tailscaleProvider) throw new Error('tailscale-provider-missing');
        rollback.push(() => env.tailscaleProvider!.registerPrivateHttpsRoot());
        await env.tailscaleProvider.removePrivateHttpsRoot();
        nextState = { ...nextState, resources: nextState.resources.filter((item) => item.id !== TAILSCALE_SERVE_RESOURCE_ID) };
      } else if (action.id === 'receipt.binary-hash') {
        const binary = resource(nextState, 'broker-binary');
        if (!binary || !existsSync(binary.target)) throw new Error('broker-binary-missing');
        nextState = mergeResources(nextState, [{
          ...binary,
          ownership: { ...binary.ownership, installedSha256: sha256(readFileSync(binary.target)) },
        }]);
      }
      completed.push(action.id);
    }
    if (env.provider) {
      // Waited, not sampled: any action above may have just issued a lifecycle command, and `awaitServiceState`
      // returns immediately once the posture is already settled, so this costs a healthy host one probe.
      const serviceStatus = await awaitServiceState({ provider: env.provider, expected: 'active' });
      if (serviceStatus.active !== 'active' || serviceStatus.definition !== 'current' || serviceStatus.environment !== 'current') {
        throw new Error('service-repair-verify-failed');
      }
    }
    const piCredential = inspectPiIntegration(piIntegrationPath(env.home));
    if (piCredential.status !== 'ok' || readPiIntegration(piCredential.path).internalUrl !== env.config.broker.internalUrl) {
      throw new Error('pi-integration-repair-verify-failed');
    }
    if (env.provider) {
      const health = await awaitEndpointIdentity({
        context: env.context,
        url: env.config.broker.internalUrl,
        machine: env.config.broker.machineLabel,
        ...(options.serviceHealthAttempts !== undefined ? { attempts: options.serviceHealthAttempts } : {}),
      });
      if (health !== 'ready') throw new Error('broker-health-repair-verify-failed');
    }
    writeInstallState(nextState, env.home);
    if (plan.warnings.length > 0) {
      return commandResult('cleanup-required', 4, plan.warnings[0]!.detailCode, 'Owned resources were repaired, but unknown resources were preserved.', { actions: completed, remaining: plan.warnings.map((item) => item.detailCode) });
    }
    return commandResult('complete', 0, 'repair-complete', 'The declared installation and owned resources were reconciled.', { actions: completed });
  } catch {
    let complete = true;
    for (const undo of [...rollback].reverse()) {
      try { await undo(); } catch { complete = false; }
    }
    for (const item of [...snapshots].reverse()) {
      try { restore(item); } catch { complete = false; }
    }
    return complete
      ? commandResult('rolled-back', 3, 'repair-rolled-back', 'Repair failed and all completed file mutations were restored.', { actions: completed })
      : commandResult('cleanup-required', 4, 'repair-rollback-incomplete', 'Repair failed and manual cleanup remains.', { actions: completed });
  } finally {
    lock.release();
  }
}

function safeRemoveRegular(path: string, expectedSha256?: string): boolean {
  if (!existsSync(path)) return true;
  assertNoSymlinkComponents(path, false);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) return false;
  if (expectedSha256 && sha256(readFileSync(path)) !== expectedSha256) return false;
  unlinkSync(path);
  return true;
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function safeRemoveAlias(path: string): boolean {
  if (!lexists(path)) return true;
  assertNoSymlinkComponents(path, false);
  const stat = lstatSync(path);
  if (!stat.isSymbolicLink()) return false;
  if (readlinkSync(path) !== PRODUCT_IDENTITY.primaryBinary) return false;
  unlinkSync(path);
  return true;
}

/**
 * Directory names uninstall may remove once its own removal emptied them: the product-named leaf each
 * installer creates inside a SHARED discovery root, and the integration subdirectories of the state home.
 * `.cosyncing` is deliberately absent — the state home is durable state and survives every non-purge run.
 */
const OWNED_PRODUCT_DIRECTORY_NAMES: readonly string[] = [
  PRODUCT_IDENTITY.productName,
  `${PRODUCT_IDENTITY.productName}-bridge`,
];
const OWNED_STATE_HOME_DIRECTORY_NAMES: readonly string[] = ['bin', 'shell', 'service'];

/**
 * The directory that held a removed file, when removing it is ours to do. A file target is the only thing a
 * receipt names, so the directory is derived from it and never guessed: `<root>/skills/cosyncing/SKILL.md`
 * and `<pi>/extensions/cosyncing-bridge/index.ts` yield the product-named leaf, `<home>/bin/cosyncing` and
 * `<home>/shell/opencode-shim.sh` yield the state-home integration directory. Everything else yields nothing
 * — the shared discovery roots (`~/.claude/skills`, `~/.agents/skills`, `~/.pi/agent/extensions`), the rc
 * files' `$HOME`, `~/.config/systemd/user`, and the state home itself are other people's directories.
 */
function ownedDirectoryOf(home: string, fileTarget: string): string | undefined {
  if (!isAbsolute(fileTarget)) return undefined;
  const directory = resolve(dirname(fileTarget));
  const stateHome = resolve(home);
  if (directory === stateHome || directory === parse(directory).root) return undefined;
  if (OWNED_PRODUCT_DIRECTORY_NAMES.includes(basename(directory))) return directory;
  if (OWNED_STATE_HOME_DIRECTORY_NAMES.includes(basename(directory))
      && resolve(dirname(directory)) === stateHome) {
    return directory;
  }
  return undefined;
}

/**
 * Drop a product-owned directory the run itself emptied. A directory still holding anything is somebody
 * else's (a user's own skill, the optional Pi bridge `config.json`, a binary we did not install) and wins
 * outright, and every step is best effort: a leftover empty directory is untidy, never a reason to turn a
 * completed uninstall into a failure.
 */
function removeEmptyOwnedDirectory(directory: string): void {
  try {
    if (!existsSync(directory)) return;
    assertNoSymlinkComponents(directory, false);
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    if (readdirSync(directory).length > 0) return;
    rmdirSync(directory);
  } catch {
    // Best effort by design; see above.
  }
}

function safePurgeRoot(path: string): void {
  const absolute = resolve(path);
  if (!isAbsolute(absolute) || absolute === parse(absolute).root || absolute.length < 8) throw new Error('purge-root-unsafe');
  if (!existsSync(absolute)) return;
  assertNoSymlinkComponents(absolute, false);
  const stat = lstatSync(absolute);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) throw new Error('purge-root-unsafe');
  rmSync(absolute, { recursive: true, force: false });
}

export async function inspectUninstall(options: LifecycleBaseOptions & { purgeData: boolean }): Promise<UninstallPlan> {
  const env = await environment(options);
  const actions: UninstallPlan['actions'] = [];
  const warnings: UninstallPlan['warnings'] = [];
  if (env.provider) {
    const status = await env.provider.inspect();
    const exactPackageFiles = status.definition === 'current' && status.environment === 'current';
    if (exactPackageFiles) actions.push({ id: 'service.remove', target: env.provider.definitionPath, legacy: false });
    else if (status.definition !== 'missing' || status.environment !== 'missing') warnings.push({ detailCode: 'service-modified-preserved', summary: 'Modified or unreceipted service files will be preserved.' });
  }
  if (matchingTailscaleReceipt(env) && env.tailscale.route === 'desired') actions.push({ id: 'tailscale.remove', target: tailscaleRouteReceiptTarget(env.tailscale), legacy: false });
  else if (env.install.committed && resource(env.install.state, TAILSCALE_SERVE_RESOURCE_ID)) warnings.push({ detailCode: 'tailscale-route-drift-preserved', summary: 'The receipt route drifted and will be preserved.' });
  const pi = inspectPiBridgeAsset(env.piAgentDir);
  if (pi.status === 'owned') actions.push({ id: 'pi-bridge.remove', target: pi.path, legacy: false });
  else if (pi.status === 'legacy-marker') actions.push({ id: 'pi-bridge.remove-legacy', target: pi.path, legacy: true });
  else if (pi.status !== 'missing') warnings.push({ detailCode: `pi-bridge-${pi.status}-preserved`, summary: 'The modified or unknown Pi bridge will be preserved.' });
  for (const target of env.agentSkills) {
    const receipt = matchingAgentSkillReceipt(env, target);
    const anyReceipt = env.install.committed ? resource(env.install.state, target.resourceId) : undefined;
    if (receipt && target.status === 'owned') {
      actions.push({ id: `agent-skill.remove.${target.id}`, target: target.path, legacy: false });
    } else if (receipt && !['missing', 'owned'].includes(target.status)) {
      warnings.push({
        detailCode: `agent-skill-${target.id}-modified-preserved`,
        summary: `The modified or unsafe ${target.id} cosyncing skill will be preserved.`,
      });
    } else if (anyReceipt && !receipt) {
      warnings.push({
        detailCode: `agent-skill-${target.id}-receipt-invalid`,
        summary: `The ${target.id} skill has an invalid ownership receipt and will be preserved.`,
      });
    }
  }
  const claude = inspectLegacyClaudeHooks(env.claudeSettingsPath);
  if (claude.status === 'legacy-marker') actions.push({ id: 'claude-hooks.remove-legacy', target: env.claudeSettingsPath, legacy: true });
  else if (claude.status === 'unreadable') warnings.push({ detailCode: 'claude-settings-unreadable-preserved', summary: 'Unreadable Claude settings will be preserved.' });
  if (env.install.committed) {
    for (const item of env.install.state.resources) {
      if (item.id === 'broker-alias') {
        const expected = join(env.home, 'bin', PRODUCT_IDENTITY.aliasBinary);
        let liveAliasMatches = !lexists(item.target);
        if (!liveAliasMatches) {
          try {
            assertNoSymlinkComponents(item.target, false);
            liveAliasMatches = lstatSync(item.target).isSymbolicLink()
              && readlinkSync(item.target) === PRODUCT_IDENTITY.primaryBinary;
          } catch {
            liveAliasMatches = false;
          }
        }
        if (item.kind === 'alias' && resolve(item.target) === resolve(expected) && liveAliasMatches) {
          actions.push({ id: 'binary.alias-remove', target: item.target, legacy: false });
        } else {
          warnings.push({ detailCode: 'broker-alias-receipt-invalid', summary: 'An invalid binary-alias receipt will be preserved.' });
        }
      }
      // The receipt-owned home copy setup's bootstrap copy created (and upgrade later swapped). Removing it is
      // a genuine removal, not a preserve-with-warning: it lives inside the owner-only state home, its receipt
      // measures it, and the acquisition artifact it was copied from is a separate, untouched file.
      else if (item.id === 'broker-binary' || item.id === 'broker-binary-previous') {
        const expected = item.id === 'broker-binary'
          ? installedBinaryPath(env.home)
          : join(env.home, 'bin', `${PRODUCT_IDENTITY.primaryBinary}.previous`);
        let liveBinaryMatches = !existsSync(item.target);
        if (!liveBinaryMatches) {
          try {
            assertNoSymlinkComponents(item.target, false);
            const stat = lstatSync(item.target);
            const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
            liveBinaryMatches = !stat.isSymbolicLink() && stat.isFile()
              && (uid === undefined || stat.uid === uid)
              && validSha256(item.ownership.installedSha256)
              && sha256(readFileSync(item.target)) === item.ownership.installedSha256;
          } catch {
            liveBinaryMatches = false;
          }
        }
        if (item.kind === 'binary' && resolve(item.target) === resolve(expected)
            && validSha256(item.ownership.installedSha256) && liveBinaryMatches) {
          actions.push({ id: `binary.remove.${item.id}`, target: item.target, legacy: false });
        } else {
          warnings.push({ detailCode: `${item.id}-receipt-invalid`, summary: 'An invalid binary receipt will be preserved.' });
        }
      }
      else if (item.id === OPENCODE_SHIM_RESOURCE_ID) {
        // R1 shim script: a DEDICATED id-based branch, keyed on the resource id, that owns this receipt so it
        // never flows through the generic path-entry branch below. It validates the receipt target === the
        // resolved shim path EXACTLY and removes the file ONLY when it still hashes to what the RECEIPT records
        // installing — which may be a PREVIOUS package version, so a shim written by an older build still
        // removes cleanly (mirrors binary.remove). There is no pathWithin($HOME) guard, so a custom
        // COSYNCING_HOME outside $HOME removes cleanly too. A user-edited (hash != receipt), absent, or
        // structurally-unsafe script is preserved.
        try {
          const expected = opencodeShimShellPath(env.home);
          if (item.kind !== 'path-entry' || resolve(item.target) !== resolve(expected)
              || !validSha256(item.ownership.installedSha256)) {
            throw new Error('opencode-shim-receipt-invalid');
          }
          // User deleted it: preserve the receipt as honest remaining evidence rather than claim a clean removal.
          if (!existsSync(item.target)) continue;
          if (opencodeShimActualSha256(item.target) !== item.ownership.installedSha256) throw new Error('opencode-shim-drift');
          actions.push({ id: 'opencode-shim.remove', target: item.target, legacy: false });
        } catch {
          warnings.push({ detailCode: 'opencode-shim-preserved', summary: 'A modified, mismatched, or unrecognized cosyncing opencode shim script will be preserved.' });
        }
      }
      else if (item.kind === 'path-entry') {
        try {
          if (!pathWithin(env.context.homeDir, item.target)) throw new Error('path-entry-outside-home');
          if (!existsSync(item.target)) continue;
          const current = lstatSync(item.target);
          if (current.isSymbolicLink() || !current.isFile()
              || !validSha256(item.ownership.installedSha256)
              || sha256(readFileSync(item.target)) !== item.ownership.installedSha256) {
            throw new Error('path-entry-drift');
          }
          if (item.ownership.backupPath) {
            verifiedPathBackup(env.home, item);
            actions.push({ id: 'path-entry.restore', target: item.target, legacy: false });
          } else if (!item.ownership.originalSha256) {
            actions.push({ id: 'path-entry.remove', target: item.target, legacy: false });
          } else {
            throw new Error('path-entry-backup-missing');
          }
        } catch {
          warnings.push({ detailCode: 'path-entry-preserved', summary: 'The recorded PATH mutation changed or lacks a verified backup and will be preserved.' });
        }
      }
      else if (item.kind === 'shell-init-block') {
        // Excise the managed rc block ONLY when the receipt id is a KNOWN opencode-shim rc id AND its target is
        // the exact rc path that id maps to (fail closed on an unknown or mismatched receipt — never excise a
        // marker block from an arbitrary owned file), the file is a safe non-symlink, and the delimited region
        // is exactly what setup would write now (owned) for the resolved shim path + port. A block the user
        // edited/removed, a symlinked rc file, or a drifted/unknown receipt is preserved-and-warned; a
        // whole-file restore would be wrong because later unrelated edits must survive.
        const rcCandidate = opencodeShimRcCandidates(env.context).find((candidate) => candidate.resourceId === item.id);
        const shimPath = opencodeShimShellPath(env.home);
        const port = opencodeShimPort(env.context.env.OPENCODE_URL);
        const host = opencodeShimHost(env.context.env.OPENCODE_URL);
        const rc = inspectRcFile(item.target, shimPath, port, host);
        // 'owned' (exact) or 'owned-stale' (a drifted port/host or older format still unmistakably ours) are
        // both excised — exciseRcBlock removes the marker region regardless of the pinned values inside it.
        if (rcCandidate && resolve(rcCandidate.path) === resolve(item.target)
            && rc.status === 'present' && (rc.blockState === 'owned' || rc.blockState === 'owned-stale')
            && item.ownership.proof === 'receipt' && item.ownership.marker === OPENCODE_SHIM_BLOCK_BEGIN) {
          actions.push({ id: `shell-init-block.excise.${item.id}`, target: item.target, legacy: false });
        } else {
          warnings.push({ detailCode: `${item.id}-preserved`, summary: 'A modified, removed, unknown, or mismatched cosyncing opencode shell block will be preserved.' });
        }
      }
      else if (!KNOWN_INSTALL_RESOURCE_IDS.has(item.id)) {
        warnings.push({ detailCode: `resource-${item.id}-preserved`, summary: 'An unknown receipt resource will be preserved.' });
      }
    }
  }
  const advisories: UninstallPlan['advisories'] = [];

  // Codex daemon (best-effort, read-only). Terminal `codex resume --remote` sessions live inside the managed
  // app-server daemon, which outlives both the broker and the sync flag: once started it keeps running until
  // stopped, so uninstall probes and cleans up regardless of the current codexSyncEnabled value. A stop is
  // planned only when ownership is PROVEN — `startedByBroker` recorded AND the recorded control-socket
  // fingerprint still matches the live socket — so a replacement daemon started after the broker's daemon
  // died (or any daemon we cannot prove) is never stopped.
  const codexProbe = await (options.codexDaemonProbe ?? (() => defaultCodexDaemonProbe(env.context)))();
  const codexOwnership = readCodexDaemonOwnership(env.home);
  const codexOwned = codexOwnership?.startedByBroker === true;
  const codexOwnershipProven = codexOwned
    && codexDaemonSocketFingerprintMatches(codexOwnership?.socket, codexProbe.socketFingerprint);
  if (!codexProbe.binaryAvailable) {
    if (codexOwned) {
      advisories.push({
        detailCode: 'codex-daemon-preserved',
        summary: "The Codex CLI is unavailable, so the cosyncing-started app-server daemon cannot be stopped and is left running; open sessions remain resumable with 'codex resume'.",
      });
    }
  } else if (codexOwnershipProven) {
    actions.push({ id: 'codex-daemon.stop', target: 'codex-app-server-daemon', legacy: false });
    if (codexProbe.running) {
      advisories.push({
        detailCode: 'codex-daemon-sessions-disconnect',
        summary: typeof codexProbe.loadedThreadCount === 'number'
          ? `${codexProbe.loadedThreadCount} open synced Codex session(s) will be disconnected when the daemon stops — they remain resumable with 'codex resume'.`
          : `Open synced Codex sessions will be disconnected when the daemon stops — they remain resumable with 'codex resume'.`,
      });
    }
  } else if (codexProbe.running) {
    advisories.push(codexOwned
      ? {
          detailCode: 'codex-daemon-replaced-preserved',
          summary: 'The running Codex app-server daemon cannot be proven to be the instance cosyncing started; it will be left running.',
        }
      : {
          detailCode: 'codex-daemon-preexisting-preserved',
          summary: 'The Codex app-server daemon was not started by cosyncing and will be left running.',
        });
  } else if (codexOwned) {
    advisories.push({
      detailCode: 'codex-daemon-not-running',
      summary: 'The cosyncing-started Codex app-server daemon is no longer running; nothing needs to be stopped.',
    });
  }

  // Tokdash: reverse a setup-provisioned instance and NOTHING else. The record only exists when setup ran
  // `pipx install tokdash` and/or `tokdash setup`; an instance that was already running when setup asked is
  // reused and leaves no record, so it is never removed here. Reversal is Tokdash's own `uninstall`, which
  // is the exact inverse of the `setup` that created its service.
  const tokdashOwned = readTokdashOwnership(env.home);
  if (tokdashOwned) {
    if (env.context.resolveExecutable(TOKDASH_PACKAGE)) {
      actions.push({ id: 'tokdash.remove', target: TOKDASH_PACKAGE, legacy: false });
    } else {
      advisories.push({
        detailCode: 'tokdash-command-missing-preserved',
        summary: 'The tokdash command is no longer on PATH, so the Tokdash instance cosyncing installed cannot be removed automatically.',
      });
    }
  }

  // OpenCode: stopping the owned service also tears down the broker-managed `opencode serve` child, which
  // disconnects synced OpenCode terminal TUIs (resumable by reopening `opencode`).
  if (actions.some((item) => item.id === 'service.remove')) {
    advisories.push({
      detailCode: 'opencode-serve-disconnect',
      summary: "Stopping the owned service also stops the broker-managed 'opencode serve', disconnecting synced OpenCode terminal sessions; they remain resumable by reopening 'opencode'.",
    });
  }

  // Acquisition artifact: uninstall removes the receipt-owned installed copy under the state home, but it
  // never touches the package the binary was acquired from. When this command is running from something
  // OTHER than the installed copy (an `npm i -g` launcher, or the alias), say so — otherwise `cosyncing`
  // still resolves on PATH after a clean uninstall and looks like a failed removal.
  if (options.buildInfo.packaged
      && actions.some((item) => item.id === 'binary.remove.broker-binary')
      && resolve(options.executablePath) !== resolve(installedBinaryPath(env.home))) {
    advisories.push({
      detailCode: 'acquisition-package-preserved',
      summary: `The installed binary at ${installedBinaryPath(env.home)} will be removed, but the package it `
        + `was installed from is preserved; remove that separately (for example \`npm uninstall -g `
        + `${PRODUCT_IDENTITY.productName}\`) or \`${PRODUCT_IDENTITY.primaryBinary}\` stays on PATH.`,
    });
  }

  // Pi: removing the bridge drops the app link for any live bridged session; the terminal session continues.
  if (actions.some((item) => item.id === 'pi-bridge.remove' || item.id === 'pi-bridge.remove-legacy')) {
    advisories.push({
      detailCode: 'pi-bridge-sessions-disconnect',
      summary: 'Removing the Pi bridge drops the app link for any live bridged session; the terminal session itself continues uninterrupted.',
    });
  }

  return {
    schemaVersion: 1,
    actions: actions.filter((item, index) => actions.findIndex((candidate) => candidate.id === item.id && candidate.target === item.target) === index),
    warnings,
    advisories,
    purgeInventory: options.purgeData ? purgeDataInventory(durableStateLayout({ stateRoot: env.home, cacheRoot: env.cacheRoot })) : [],
  };
}

export async function runUninstall(options: UninstallOptions): Promise<LifecycleCommandResult> {
  const plan = options.expectedPlan ?? await inspectUninstall(options);
  if (!options.confirmed) return commandResult('cancelled', 2, 'uninstall-confirmation-required', 'Uninstall requires confirmation after displaying its ownership plan.');
  if (options.purgeData && !options.purgeConfirmed) return commandResult('blocked', 2, 'purge-data-confirmation-required', 'Purging both durable roots requires a separate confirmation.');
  if (plan.actions.some((action) => action.legacy) && !options.allowLegacyIntegrations) {
    return commandResult('blocked', 2, 'legacy-integration-confirmation-required', 'Legacy marker removal requires separate confirmation.');
  }
  let env = await environment(options);
  const acquire = options.acquireLock ?? ((input) => acquireInstallationLock(input));
  let lock: InstallationLockHandle;
  try { lock = acquire({ command: 'uninstall', home: env.home }); }
  catch { return commandResult('blocked', 1, 'installation-lock-unavailable', 'Another installation mutation is active or the lock is unsafe.'); }
  const completed: string[] = [];
  let remaining = [...plan.warnings.map((warning) => warning.detailCode)];
  let retainedResources = env.install.committed ? [...env.install.state.resources] : [];
  try {
    const lockedPlan = await inspectUninstall(options);
    if (!samePlan(plan, lockedPlan)) {
      return commandResult('blocked', 1, 'uninstall-plan-changed', 'Uninstall state changed after confirmation; inspect and confirm the new plan.');
    }
    env = await environment(options);
    remaining = [...plan.warnings.map((warning) => warning.detailCode)];
    retainedResources = env.install.committed ? [...env.install.state.resources] : [];
    for (const action of plan.actions) {
      try {
        if (action.id === 'service.remove') {
          const current = await env.provider!.inspect();
          if (current.definition !== 'current' || current.environment !== 'current') {
            throw new Error('service-drift');
          }
          await env.provider!.uninstall();
          const linger = resource(env.install.committed ? env.install.state : undefined, 'service-systemd-linger');
          if (linger && (await env.provider!.inspect()).lingering === 'enabled') await env.provider!.disableLingering();
          retainedResources = retainedResources.filter((item) => !SERVICE_RESOURCE_IDS.includes(item.id));
        } else if (action.id === 'tailscale.remove') {
          if (!env.tailscaleProvider) throw new Error('tailscale-provider-missing');
          const current = await env.tailscaleProvider.inspect();
          if (current.route !== 'desired' || tailscaleRouteReceiptTarget(current) !== action.target) throw new Error('tailscale-route-drift');
          await env.tailscaleProvider.removePrivateHttpsRoot();
          retainedResources = retainedResources.filter((item) => item.id !== TAILSCALE_SERVE_RESOURCE_ID);
        } else if (action.id === 'pi-bridge.remove' || action.id === 'pi-bridge.remove-legacy') {
          const inspection = inspectPiBridgeAsset(env.piAgentDir);
          const allowed = inspection.status === 'owned' || (action.id.endsWith('legacy') && inspection.status === 'legacy-marker');
          if (!allowed) throw new Error('pi-bridge-drift');
          let expectedSha256 = PI_BRIDGE_EMBEDDED_SHA256;
          if (inspection.status === 'legacy-marker') {
            const legacyBytes = readFileSync(inspection.path);
            if (!legacyBytes.toString('utf8').includes(PI_BRIDGE_LEGACY_MARKER)) throw new Error('pi-bridge-drift');
            expectedSha256 = sha256(legacyBytes);
          }
          if (!safeRemoveRegular(inspection.path, expectedSha256)) throw new Error('pi-bridge-drift');
          retainedResources = retainedResources.filter((item) => item.id !== 'pi-bridge');
        } else if (action.id.startsWith('agent-skill.remove.')) {
          const targetId = action.id.slice('agent-skill.remove.'.length);
          const target = env.agentSkills.find((candidate) => candidate.id === targetId);
          if (!target || !matchingAgentSkillReceipt(env, target)
              || inspectAgentSkill(target).status !== 'owned'
              || !safeRemoveRegular(target.path, AGENT_SKILL_SHA256)) {
            throw new Error('agent-skill-drift');
          }
          retainedResources = retainedResources.filter((item) => item.id !== target.resourceId);
        } else if (action.id === 'claude-hooks.remove-legacy') {
          const removed = removeLegacyClaudeEntries(env.claudeSettingsPath);
          if (removed.removed < 1) throw new Error('claude-hook-drift');
          if (removed.embeddedCredential && env.config) ensureInstallationCredentials({
            home: env.home,
            internalUrl: env.config.broker.internalUrl,
            rotateBrokerToken: true,
          });
        } else if (action.id === 'binary.alias-remove') {
          if (!safeRemoveAlias(action.target)) throw new Error('alias-drift');
          retainedResources = retainedResources.filter((item) => item.id !== 'broker-alias');
        } else if (action.id.startsWith('binary.remove.')) {
          const id = action.id.slice('binary.remove.'.length);
          const receipt = resource(env.install.committed ? env.install.state : undefined, id);
          if (!receipt || !safeRemoveRegular(action.target, receipt.ownership.installedSha256)) throw new Error('binary-drift');
          retainedResources = retainedResources.filter((item) => item.id !== id);
        } else if (action.id === 'opencode-shim.remove') {
          // Re-verify under the lock: the receipt must still be the R1 id at the resolved shim path, and the
          // on-disk script must still hash to what the RECEIPT records installing (possibly a previous package
          // version — still our file). safeRemoveRegular fails closed on a symlink or hash mismatch. Works
          // regardless of whether the state home is inside or outside $HOME.
          const expected = opencodeShimShellPath(env.home);
          const receipt = retainedResources.find((item) => item.id === OPENCODE_SHIM_RESOURCE_ID
            && item.kind === 'path-entry' && resolve(item.target) === resolve(action.target));
          if (!receipt || resolve(action.target) !== resolve(expected)
              || !validSha256(receipt.ownership.installedSha256)
              || !safeRemoveRegular(action.target, receipt.ownership.installedSha256)) {
            throw new Error('opencode-shim-drift');
          }
          retainedResources = retainedResources.filter((item) => item !== receipt);
        } else if (action.id === 'path-entry.restore' || action.id === 'path-entry.remove') {
          const receipt = retainedResources.find((item) => item.kind === 'path-entry' && resolve(item.target) === resolve(action.target));
          if (!receipt?.ownership.installedSha256 || sha256(readFileSync(action.target)) !== receipt.ownership.installedSha256) {
            throw new Error('path-entry-drift');
          }
          if (action.id === 'path-entry.restore') {
            const bytes = verifiedPathBackup(env.home, receipt);
            atomicWriteOwnerOnly(action.target, bytes, { preserveMode: true });
          } else if (!safeRemoveRegular(action.target, receipt.ownership.installedSha256)) {
            throw new Error('path-entry-remove-failed');
          }
          retainedResources = retainedResources.filter((item) => item !== receipt);
        } else if (action.id.startsWith('shell-init-block.excise.')) {
          // Re-verify under the lock: the receipt id must still be a KNOWN opencode-shim rc id whose expected
          // rc path matches this target (fail closed on unknown/mismatched — never excise from an arbitrary
          // owned file), the receipt must still own an unmodified block, then excise EXACTLY that marker region
          // (never a whole-file restore) so later unrelated edits survive.
          const id = action.id.slice('shell-init-block.excise.'.length);
          const receipt = retainedResources.find((item) => item.kind === 'shell-init-block'
            && item.id === id && resolve(item.target) === resolve(action.target));
          const rcCandidate = opencodeShimRcCandidates(env.context).find((candidate) => candidate.resourceId === id);
          const shimPath = opencodeShimShellPath(env.home);
          const port = opencodeShimPort(env.context.env.OPENCODE_URL);
          const host = opencodeShimHost(env.context.env.OPENCODE_URL);
          const rc = inspectRcFile(action.target, shimPath, port, host);
          if (!receipt || receipt.ownership.marker !== OPENCODE_SHIM_BLOCK_BEGIN
              || !rcCandidate || resolve(rcCandidate.path) !== resolve(action.target)
              || rc.status !== 'present' || (rc.blockState !== 'owned' && rc.blockState !== 'owned-stale')) {
            throw new Error('shell-init-block-drift');
          }
          const excised = exciseRcBlock(rc.content);
          if (excised === undefined) throw new Error('shell-init-block-excise-failed');
          atomicWriteOwnerOnly(action.target, excised, { preserveMode: true });
          retainedResources = retainedResources.filter((item) => item !== receipt);
        } else if (action.id === 'tokdash.remove') {
          // Re-read ownership under the lock: only reverse what a record still proves cosyncing created.
          const ownership = readTokdashOwnership(env.home);
          if (!ownership) { remaining.push('tokdash-preserved'); continue; }
          const reversal = await reverseTokdashProvisioning({
            context: env.context,
            ownership,
            // Each fact is cleared the moment its own reversal succeeds, so a failure halfway through
            // resumes at the step that did not happen instead of repeating the one that did. Skipped when
            // purging, where the state root is deleted and a post-purge write would resurrect it.
            ...(options.purgeData ? {} : {
              onReversed: (left) => {
                // The completion marker goes with the FIRST reversal, not the last: it asserts a consented
                // instance is live at this endpoint, and removing either the service or the package it runs
                // from makes that false. A marker outliving what it describes would tell the next setup
                // there is nothing to do on a host that now has nothing.
                clearTokdashCompletion(env.home);
                if (left) setTokdashOwnership(left, env.home); else clearTokdashOwnership(env.home);
              },
            }),
            ...(options.tokdashRunner ? { run: options.tokdashRunner } : {}),
          });
          if (!reversal.removed) { remaining.push('tokdash-preserved'); continue; }
        } else if (action.id === 'codex-daemon.stop') {
          // Re-verify ownership under the lock — never stop a daemon we cannot prove cosyncing started, even
          // though the action only exists in the plan when ownership was proven. The live control-socket
          // fingerprint must still match the recorded one, so a replacement daemon started after the plan
          // was confirmed (the broker's daemon died, the user started a new one) is preserved.
          const ownership = readCodexDaemonOwnership(env.home);
          const probe = await (options.codexDaemonProbe ?? (() => defaultCodexDaemonProbe(env.context)))();
          if (ownership?.startedByBroker !== true
              || !codexDaemonSocketFingerprintMatches(ownership.socket, probe.socketFingerprint)) {
            remaining.push('codex-daemon-preserved');
            continue;
          }
          // Talks to the daemon via the codex CLI, not the broker, so it works with the broker already stopped.
          const stop = options.codexDaemonStop ?? ((timeoutMs: number) => stopCodexDaemon(timeoutMs));
          try {
            await stop(15_000);
          } catch {
            // codex binary missing or a stop failure: preserve-and-warn; uninstall must not hard-fail here.
            remaining.push('codex-daemon-preserved');
            continue;
          }
          // Mark ownership cleared so a later run never tries to stop a daemon that is already down. Skip when
          // purging: the state root is deleted anyway and a post-purge write must not resurrect it.
          if (!options.purgeData) {
            try {
              setCodexDaemonOwnership(
                { startedByBroker: false, recordedAt: (options.now?.() ?? new Date()).toISOString() },
                env.home,
              );
            } catch {
              /* durable ownership mark is best-effort; the daemon is already stopped */
            }
          }
        }
        completed.push(action.id);
      } catch {
        remaining.push(`${action.id}-preserved`);
      }
    }
    // Drop the product-named directories the removals above just emptied. A physical Ubuntu uninstall removed
    // every owned FILE and left six empty product directories behind — the same defect the setup rollback
    // path was fixed for. One sweep rather than per-action cleanup: `<home>/bin` holds up to three separately
    // removed receipts, so only after the whole plan has run is "now empty" the real answer. Candidates come
    // from the file targets of actions that ACTUALLY completed, plus the service action's second, receipt-named
    // target (its environment file under the state home; its unit lives in a shared systemd root we never touch).
    const ownedDirectories = new Set<string>();
    for (const action of plan.actions) {
      if (!completed.includes(action.id)) continue;
      const directory = ownedDirectoryOf(env.home, action.target);
      if (directory) ownedDirectories.add(directory);
    }
    if (completed.includes('service.remove') && env.provider) {
      const directory = ownedDirectoryOf(env.home, env.provider.environmentPath);
      if (directory) ownedDirectories.add(directory);
    }
    for (const directory of ownedDirectories) removeEmptyOwnedDirectory(directory);
    if (env.install.committed) {
      const piAfter = inspectPiBridgeAsset(env.piAgentDir);
      if (piAfter.status === 'missing') retainedResources = retainedResources.filter((item) => item.id !== 'pi-bridge');
      for (const target of env.agentSkills) {
        if (inspectAgentSkill(target).status === 'missing') {
          retainedResources = retainedResources.filter((item) => item.id !== target.resourceId);
        }
      }
      if (env.provider) {
        const serviceAfter = await env.provider.inspect();
        if (serviceAfter.definition === 'missing' && serviceAfter.environment === 'missing') {
          const lingerReceipt = retainedResources.some((item) => item.id === 'service-systemd-linger');
          if (lingerReceipt && serviceAfter.lingering === 'enabled') await env.provider.disableLingering();
          retainedResources = retainedResources.filter((item) => !SERVICE_RESOURCE_IDS.includes(item.id));
        }
      }
      if (env.tailscale.route === 'missing' || (env.tailscaleProvider && (await env.tailscaleProvider.inspect()).route === 'missing')) {
        retainedResources = retainedResources.filter((item) => item.id !== TAILSCALE_SERVE_RESOURCE_ID);
      }
      if (retainedResources.length > 0) {
        for (const item of retainedResources) {
          const code = `resource-${item.id}-remaining`;
          if (!remaining.includes(code)) remaining.push(code);
        }
      }
      if (retainedResources.length > 0 || remaining.length > 0) {
        writeInstallState({ ...env.install.state, resources: retainedResources }, env.home);
      } else {
        safeRemoveRegular(installStatePath(env.home));
      }
    }
    if (remaining.length > 0) {
      return commandResult('cleanup-required', 4, remaining[0]!, 'Uninstall preserved modified, unknown, or drifted resources.', { actions: completed, remaining });
    }
    if (options.purgeData) {
      try {
        // Keep the shared mutation lock through both exact-root deletions; releasing after the state root is
        // gone is intentionally a no-op.
        safePurgeRoot(env.cacheRoot);
        safePurgeRoot(env.home);
      } catch {
        return commandResult('cleanup-required', 4, 'purge-data-incomplete', 'Owned integrations were removed, but one durable root could not be purged safely.', { actions: completed });
      }
    }
    // The acquisition-package note exists in the pre-confirmation plan, which has scrolled away by the time
    // the run finishes: an operator opened a new terminal after a clean uninstall, found `cosyncing` still on
    // PATH, and read that as a failed removal. Repeat it where it matters, and ONLY when the same evidence the
    // plan used still holds — a source or tarball install has no preserved package and gets no npm hint.
    const acquisitionPackagePreserved = completed.includes('binary.remove.broker-binary')
      && plan.advisories.some((item) => item.detailCode === 'acquisition-package-preserved');
    return commandResult('complete', 0, 'uninstall-complete', (options.purgeData
      ? 'Owned integrations and both confirmed durable roots were removed.'
      : 'Owned integrations were removed; durable state and artifact cache were preserved.')
      + (acquisitionPackagePreserved
        ? ` The \`${PRODUCT_IDENTITY.primaryBinary}\` command stays on PATH from the package it was installed `
          + `from; remove that separately (for example \`npm uninstall -g ${PRODUCT_IDENTITY.productName}\`).`
        : ''), { actions: completed });
  } finally {
    lock.release();
  }
}

export function renderLifecycleStatus(
  report: LifecycleStatusReport,
  language: SetupLanguage = 'en',
): string {
  const text = cliMessages(language).status;
  const lines = [
    text.headline(report),
    text.installation(report),
    text.service(report),
    text.internalEndpoint(report),
    text.advertisedEndpoint(report),
    text.tailscale(report),
    text.agents(report),
    text.sessions(report),
    text.updates(report),
  ];
  if (report.detailCodes.length) lines.push(text.fix(report.detailCodes));
  return `${lines.join('\n')}\n`;
}
