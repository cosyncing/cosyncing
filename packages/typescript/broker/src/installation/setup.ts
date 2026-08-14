import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inspectPiBridgeAsset } from '@cosyncing/adapter-pi';
import type { SetupCheck, SetupDiagnosisContext } from '@cosyncing/adapter-api';
import type { DistributionKind } from '../runtime/application-identity.ts';
import type { BuildInfo } from '../runtime/build-info.ts';
import {
  defaultBrokerConfig,
  inspectBrokerConfig,
  type BrokerConfig,
} from '../runtime/configuration.ts';
import {
  brokerTokenPath,
  inspectBrokerToken,
  inspectPiIntegration,
  piIntegrationPath,
  readPiIntegration,
} from '../security/credentials.ts';
import { createSetupDiagnosisContext } from './diagnosis-context.ts';
import { collectDoctorReport, DURABLE_SERVICE_CHECK_ID, type DoctorReport } from './doctor.ts';
import {
  assessDurableStateForSetup,
  durableStateLayout,
  inspectDurableSchemas,
  type DurableStatePermissionRepair,
  type DurableStoreInspection,
} from '../security/durable-state.ts';
import {
  inspectInstallState,
  serviceExecutablePath,
  type InstallStateInspection,
} from './install-state.ts';
import {
  acquireInstallationLock,
  type InstallationLockHandle,
} from './installation-lock.ts';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import { inspectRuntimeAssets, resolveFlutterWebRoot, serviceFlutterWebRoot } from '../runtime/runtime-assets.ts';
import { resolveTokdashEndpoint } from './tokdash-quota.ts';
import {
  provisionTokdash,
  TOKDASH_PACKAGE,
  type TokdashCommandRunner,
  type TokdashProvisionOutcome,
} from './tokdash-provision.ts';
import {
  DEFAULT_SETUP_LANGUAGE,
  normalizeSetupLanguage,
  setupMessages,
  type SetupLanguage,
  type SetupMutationStep,
  type SetupSummaryCode,
} from './setup-i18n.ts';
import {
  inspectAgentSkills,
  AGENT_SKILL_SHA256,
  agentSkillTargets,
  type AgentSkillInspection,
} from './agent-skill.ts';
import {
  inspectOpencodeShim,
  inspectRcFile,
  opencodeShimActualSha256,
  opencodeShimHost,
  opencodeShimPort,
  opencodeShimRcCandidates,
  opencodeShimShellPath,
  OPENCODE_SHIM_RESOURCE_ID,
  type OpencodeShimRcId,
  type OpencodeShimStatus,
  type RcBlockState,
} from '@cosyncing/adapter-opencode';
import {
  createDurableServiceProvider,
  createSystemdSetupAction,
  durableServiceProviderId,
  serviceDefinitionResourceId,
  startAndVerifySystemdService,
  SERVICE_RESOURCE_IDS,
  serviceAgentExecutableDirectories,
  serviceAgentExecutableOverrides,
  type DurableServiceProvider,
  type DurableServiceProviderId,
  type DurableServiceStatus,
  type ServiceAgentExecutableOverrides,
  type SystemdProviderOptions,
} from './service-manager.ts';
import {
  createSetupActionCatalog,
  inspectInstalledBinary,
  type InstalledBinaryInspection,
  type SetupActionInputs,
} from './setup-actions.ts';
import {
  readSetupState,
  readTokdashCompletion,
  readTokdashOwnership,
  setTokdashCompletion,
  setTokdashOwnership,
  setupStateHome,
  type SetupState,
} from './setup-state.ts';
import {
  executeSetupTransaction,
  readSetupFailureDiagnostic,
  readSetupTransactionJournal,
  recoverSetupTransaction,
  setupFailureDiagnosticPath,
  SetupTransactionError,
  type SetupFailureDiagnostic,
  type SetupPlanAction,
  type SetupTransactionPlan,
} from './setup-transaction.ts';
import {
  createTailscaleServeSetupAction,
  inspectTailscaleServe,
  tailscaleRouteReceiptTarget,
  TAILSCALE_SERVE_OWNERSHIP_MARKER,
  TAILSCALE_SERVE_RESOURCE_ID,
  TailscaleServeProvider,
  resolveTailscaleAddresses,
  verifyAdvertisedBrokerEndpoint,
  type AdvertisedBrokerEndpointVerificationOptions,
  type TailscaleServeInspection,
  type TailscaleServeProviderOptions,
  type TailscaleServeRouteProvider,
} from './tailscale-serve.ts';

/**
 * How the broker runs after setup. Exactly one durable option is offered per host — `systemd` on linux,
 * `launchd` on darwin — because each is the only user service manager its platform has.
 */
export type SetupServiceChoice = 'foreground' | 'systemd' | 'launchd';

/**
 * What the quota prompt may truthfully promise about setting a Tokdash up, given what is on PATH.
 *
 * Three cases, because provisioning has three: the CLI is here and only needs configuring; it is absent but
 * pipx can install it; neither is here and the operator has a prerequisite to install first.
 */
export type TokdashProvisionCapability = 'setup-only' | 'install' | 'unavailable';

export interface SetupChoices {
  /** Chosen in the wizard's first step and persisted, so a later run opens in the language already picked. */
  language: SetupLanguage;
  service: SetupServiceChoice;
  enableLingering: boolean;
  tailscaleServe: boolean;
  quotaWarnings: boolean;
  installAgentSkill: boolean;
  installOpencodeShim: boolean;
  /** One-run migration consent; never persisted as an enduring setup preference. */
  replaceLegacyPiBridge?: boolean;
  /** One-run migration consent; never authorizes any skill content except the exact known predecessor. */
  upgradeLegacyAgentSkill?: boolean;
}

/** Per-rc-file view used by the plan to decide whether the managed block needs installing. */
export interface OpencodeShimRcSummary {
  id: OpencodeShimRcId;
  resourceId: string;
  path: string;
  /** 'no-file': rc absent (never created). 'unsafe': symlink/foreign. else: the delimited block's state. */
  state: 'no-file' | 'unsafe' | RcBlockState;
}

export interface OpencodeShimInspection {
  shimPath: string;
  shimStatus: OpencodeShimStatus;
  /** On-disk hash of a structurally-safe shim script (else undefined); proves owned-stale upgrade/removal. */
  actualSha256?: string;
  rc: OpencodeShimRcSummary[];
}

export interface SetupAgentSummary {
  id: 'codex' | 'opencode' | 'pi' | 'claude';
  displayName: string;
  state: 'missing' | 'supported' | 'unsupported' | 'runtime-unavailable';
  installedVersion?: string;
  minimumVersion: string;
  /** The adapter-owned upgrade command, carried only for an `unsupported` agent so the preflight can name it. */
  upgradeCommand?: string;
  /** Non-blocking managed-runtime requirement surfaced inline by setup. */
  managedRuntimeWarning?: {
    detailCode: 'codex-standalone-install-missing' | 'codex-standalone-install-unusable';
    command: string;
  };
  /** Optional-agent runtime incompatibility: visible in setup, but never a setup blocker. */
  runtimeUnavailable?: {
    detailCode: string;
    summary: string;
    remediation: string;
    installedVersion?: string;
    minimumVersion?: string;
  };
  managedBehavior: string;
}

export interface SetupBlockingIssue {
  code: string;
  summary: string;
  remediation: string;
  localized?: Partial<Record<SetupLanguage, { summary: string; remediation: string }>>;
}

export interface SetupInspection {
  schemaVersion: 1;
  product: typeof PRODUCT_IDENTITY.productName;
  version: string;
  installLocation: string;
  stateHome: string;
  installState: InstallStateInspection;
  /** Bootstrap-copy state of `<home>/bin/cosyncing` against the running packaged executable. */
  installedBinary: InstalledBinaryInspection;
  config: ReturnType<typeof inspectBrokerConfig>;
  targetConfig: BrokerConfig;
  brokerCredential: ReturnType<typeof inspectBrokerToken>;
  piCredential: ReturnType<typeof inspectPiIntegration>;
  piCredentialUrlMatches: boolean;
  setupState: SetupState;
  piAgentDir: string;
  piBridge: ReturnType<typeof inspectPiBridgeAsset>;
  durableStatePermissionRepairs: DurableStatePermissionRepair[];
  agentSkills: AgentSkillInspection[];
  opencodeShim: OpencodeShimInspection;
  portStatus: 'free' | 'owned-running' | 'conflict' | 'unknown';
  /** Whether `pipx` is on PATH, i.e. whether the quota prompt may promise an auto-install at all. */
  pipxAvailable: boolean;
  /** Whether the `tokdash` command is on PATH, i.e. whether there is anything left to install. */
  tokdashAvailable: boolean;
  /** Validated parent directories of the exact supported agent executables resolved during inspection. */
  agentExecutableDirectories?: string[];
  /** Validated nonstandard executable names that the durable adapters must receive explicitly. */
  agentExecutableOverrides?: ServiceAgentExecutableOverrides;

  /**
   * The single durable manager this host could use. Every `systemd*` field below describes THAT provider —
   * the names are kept because the provider seam, receipts, and plan wiring are shared; only the id differs.
   */
  durableServiceProvider: DurableServiceProviderId;
  systemdAvailable: boolean;
  systemdStatus?: DurableServiceStatus;
  systemdDefinitionPath?: string;
  systemdEnvironmentPath?: string;
  systemdPersistenceTarget?: string;
  tailscaleAvailable: boolean;
  tailscale: TailscaleServeInspection;
  /**
   * Whether THIS build can actually serve the browser client. The Flutter bundle ships beside a packaged
   * executable and is routinely absent from the npm tarball, so the outro reads this rather than assuming
   * an app URL resolves. Not part of the precondition hash: a web bundle appearing or disappearing changes
   * nothing setup mutates.
   */
  webAppAvailable: boolean;
  agents: SetupAgentSummary[];
  doctor: DoctorReport;
  blockingIssues: SetupBlockingIssue[];
  preconditionHash: string;
}

export interface SetupPlan {
  schemaVersion: 1;
  transaction: SetupTransactionPlan;
  choices: SetupChoices;
  acknowledgedAt: string;
  desiredSetupState: SetupState;
  targetConfig: BrokerConfig;
  installPiBridge: boolean;
  requiresCommit: boolean;
  noOp: boolean;
  actions: SetupPlanAction[];
  blockingIssues: SetupBlockingIssue[];
  /** The plan rows in English — the reference text receipts, the journal, and `--yes` output all quote. */
  mutationSummary: string[];
  /** The same rows, structured, so the wizard can render them in the operator's language. Same order. */
  mutationSteps: SetupMutationStep[];
}

export const SETUP_PROMPT_CANCELLED = Symbol('setup-prompt-cancelled');
export type SetupPromptResult<T> = T | typeof SETUP_PROMPT_CANCELLED;

export interface SetupPresenter {
  /**
   * The wizard's FIRST step, ahead of `intro`, because every panel after it is copy that has to be rendered
   * in some language. The non-interactive presenter answers from flag, stored state, or env without asking.
   */
  chooseLanguage(inspection: Readonly<SetupInspection>): Promise<SetupPromptResult<SetupLanguage>>;
  intro(inspection: Readonly<SetupInspection>): Promise<void> | void;
  showBlockers(issues: readonly SetupBlockingIssue[]): Promise<void> | void;
  /**
   * Non-prompting resolution of the flag-driven choices (agent skill, opencode shim, Tailscale Serve) for the committed-setup
   * no-op short-circuit. The non-interactive presenter returns its flag-resolved intent so an EXPLICIT
   * `--install-opencode-shim`, `--no-install-agent-skill`, or `--enable-tailscale-serve` on an
   * already-committed install is not silently dropped by the early-return. Omitted by the interactive
   * presenter (flags are inert there), so the early-return falls back to the stored choices and never prompts
   * on a genuine no-op re-run.
   */
  intendedChoices?(inspection: Readonly<SetupInspection>): {
    installAgentSkill: boolean;
    installOpencodeShim: boolean;
    tailscaleServe: boolean;
  };
  confirmManagedRuntime(inspection: Readonly<SetupInspection>): Promise<SetupPromptResult<boolean>>;
  confirmLegacyPiBridge?(inspection: Readonly<SetupInspection>): Promise<SetupPromptResult<boolean>>;
  confirmAgentSkill(inspection: Readonly<SetupInspection>): Promise<SetupPromptResult<boolean>>;
  confirmLegacyAgentSkill?(inspection: Readonly<SetupInspection>): Promise<SetupPromptResult<boolean>>;
  confirmOpencodeShim(inspection: Readonly<SetupInspection>): Promise<SetupPromptResult<boolean>>;
  chooseService(inspection: Readonly<SetupInspection>): Promise<SetupPromptResult<SetupServiceChoice>>;
  confirmTailscale(inspection: Readonly<SetupInspection>): Promise<SetupPromptResult<boolean>>;
  confirmQuotaWarnings(inspection: Readonly<SetupInspection>): Promise<SetupPromptResult<boolean>>;
  showPlan(plan: Readonly<SetupPlan>, inspection: Readonly<SetupInspection>): Promise<void> | void;
  confirmApply(plan: Readonly<SetupPlan>): Promise<SetupPromptResult<boolean>>;
  /**
   * Rendered BEFORE the language prompt, because rolling an interrupted transaction back has to happen
   * before anything inspects the state it left behind. It is still wizard copy, so it takes the language
   * explicitly: a recovery only exists when a PREVIOUS run wrote the journal, and that run also persisted
   * its language choice, so the one notice that precedes the prompt can be rendered in it. A first-ever run
   * has no journal and therefore nothing to show here.
   */
  recoveredInterruptedTransaction(language: SetupLanguage): Promise<void> | void;
  complete(result: Readonly<SetupCommandResult>): Promise<void> | void;
  cancelled(stage: string): Promise<void> | void;
  failed(result: Readonly<SetupCommandResult>): Promise<void> | void;
}

/**
 * Why a setup transaction failed, in the words the operator needs: which step, the underlying error, and
 * where the machine-readable copy was persisted. Present only on `failed`, and only when the failure reached
 * the transaction (a blocked plan already reports its own blocking issues).
 */
export interface SetupFailureReport {
  /** The failing step, named as the plan named it where a plan action was running. */
  step: string;
  code: string;
  detail: string;
  rollback: 'complete' | 'incomplete';
  diagnosticPath: string;
}

export interface SetupCommandResult {
  schemaVersion: 1;
  status: 'complete' | 'already-configured' | 'cancelled' | 'declined' | 'blocked' | 'failed';
  exitCode: number;
  /**
   * The English reference sentence. `--yes` prints it and bug reports quote it, so it stays English on every
   * run; the interactive footer renders {@link summaryCode} instead. Both come from one catalog entry, so
   * they cannot describe different outcomes.
   */
  summary: string;
  summaryCode: SetupSummaryCode;
  actions: string[];
  agents: SetupAgentSummary[];
  /** Where this install lives and what it answers on. Rendered by the outro; see {@link SetupAccessReport}. */
  access: SetupAccessReport;
  recoveredInterruptedTransaction: boolean;
  /**
   * What the post-commit Tokdash step did. Present on a completed run only; never affects `status` or
   * `exitCode`, because quota tracking is optional and its failure is not the setup's failure.
   */
  tokdash?: TokdashProvisionOutcome;
  issueCodes?: string[];
  failure?: SetupFailureReport;
}

export interface SetupDependencies {
  buildInfo: Readonly<BuildInfo>;
  /** The running cosyncing APPLICATION artifact, which setup copies to `<home>/bin/cosyncing`. */
  executablePath: string;
  /** The external runtime that must execute it; recorded in the service unit. Absent for a native build. */
  runtimePath?: string;
  presenter: SetupPresenter;
  /** Injected so fixtures provision Tokdash without pipx, a network, or a real install on the host. */
  tokdashRunner?: TokdashCommandRunner;
  home?: string;
  aliasPath?: string;
  context?: SetupDiagnosisContext;
  now?: () => Date;
  inspectEnvironment?: (options: {
    buildInfo: Readonly<BuildInfo>;
    executablePath: string;
    runtimePath?: string;
    home: string;
    context: SetupDiagnosisContext;
    systemdProviderFactory?: (options: SystemdProviderOptions) => DurableServiceProvider;
  }) => Promise<SetupInspection>;
  acquireLock?: (options: { command: 'setup'; home: string }) => InstallationLockHandle;
  actionCatalogFactory?: typeof createSetupActionCatalog;
  systemdProviderFactory?: (options: SystemdProviderOptions) => DurableServiceProvider;
  tailscaleProviderFactory?: (options: TailscaleServeProviderOptions) => TailscaleServeRouteProvider;
  serviceHealthAttempts?: number;
  /** Readiness-loop tuning and clock seam; setup always supplies the endpoint and expected broker identity. */
  advertisedEndpointVerification?: Omit<
    AdvertisedBrokerEndpointVerificationOptions,
    'context' | 'advertisedUrl' | 'machineLabel'
  >;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function allChecks(report: DoctorReport): SetupCheck[] {
  return report.sections.flatMap((section) => section.checks);
}

function check(report: DoctorReport, id: string): SetupCheck | undefined {
  return allChecks(report).find((candidate) => candidate.id === id);
}

function installedVersion(report: DoctorReport, id: string): string | undefined {
  const value = check(report, `${id}.version`)?.evidence?.installedVersion;
  return typeof value === 'string' ? value : undefined;
}

export function agentSummaries(report: DoctorReport): SetupAgentSummary[] {
  const behavior: Record<SetupAgentSummary['id'], string> = {
    codex: 'Managed shared app-server; remote terminals may join it.',
    opencode: 'Managed shared serve; externally managed servers remain untouched.',
    pi: 'Packaged in-session bridge when Pi is installed.',
    claude: 'Observe + Take over only; setup never edits Claude settings.',
  };
  return (['codex', 'opencode', 'pi', 'claude'] as const).map((id) => {
    const matrix = report.minimumVersions.find((entry) => entry.agent === id);
    const binary = check(report, `${id}.binary`);
    const version = check(report, `${id}.version`);
    const runtime = id === 'pi' ? check(report, 'pi.node-runtime') : undefined;
    const state: SetupAgentSummary['state'] = binary?.status !== 'pass'
      ? 'missing'
      : version?.status !== 'pass'
        ? 'unsupported'
        : runtime?.status === 'fail' ? 'runtime-unavailable' : 'supported';
    // The adapter that owns the floor also owns the command that clears it. Carrying it through instead of
    // hardcoding one per agent here is what lets the preflight say `claude update` without this file
    // inventing an upgrade path any adapter could rename.
    const upgradeCommand = typeof version?.remediation?.command === 'string' ? version.remediation.command : undefined;
    const standalone = id === 'codex' ? check(report, 'codex.standalone-install') : undefined;
    const standaloneWarning = standalone?.status === 'warn'
      && (standalone.detailCode === 'standalone-install-missing'
        || standalone.detailCode === 'standalone-install-unusable')
      && typeof standalone.remediation?.command === 'string'
      ? {
          detailCode: standalone.detailCode === 'standalone-install-missing'
            ? 'codex-standalone-install-missing' as const
            : 'codex-standalone-install-unusable' as const,
          command: standalone.remediation.command,
        }
      : undefined;
    const runtimeUnavailable = state === 'runtime-unavailable' && runtime
      ? {
          detailCode: runtime.detailCode,
          summary: runtime.summary,
          remediation: runtime.remediation?.message ?? 'Repair the effective Pi runtime, then rerun setup.',
          ...(typeof runtime.evidence?.installedVersion === 'string'
            ? { installedVersion: runtime.evidence.installedVersion } : {}),
          ...(typeof runtime.evidence?.minimumVersion === 'string'
            ? { minimumVersion: runtime.evidence.minimumVersion } : {}),
        }
      : undefined;
    return {
      id,
      displayName: matrix?.displayName ?? (id === 'claude' ? 'Claude Code' : id),
      state,
      ...(installedVersion(report, id) ? { installedVersion: installedVersion(report, id) } : {}),
      minimumVersion: matrix?.version ?? 'unknown',
      ...(state === 'unsupported' && upgradeCommand ? { upgradeCommand } : {}),
      ...(standaloneWarning ? { managedRuntimeWarning: standaloneWarning } : {}),
      ...(runtimeUnavailable ? { runtimeUnavailable } : {}),
      managedBehavior: behavior[id],
    };
  });
}

export function doctorBlockers(
  report: DoctorReport,
  permissionRepairIds: ReadonlySet<string> = new Set(),
): SetupBlockingIssue[] {
  const checks = allChecks(report);
  const blockers: SetupBlockingIssue[] = [];
  for (const candidate of checks) {
    if (candidate.status !== 'fail') continue;
    if (candidate.id.startsWith('package.')) {
      blockers.push({
        code: candidate.detailCode,
        summary: candidate.summary,
        remediation: candidate.remediation?.message ?? 'Reinstall the broker package.',
      });
    }
    if (candidate.id === 'host.platform') {
      blockers.push({
        code: candidate.detailCode,
        summary: candidate.summary,
        remediation: candidate.remediation?.message ?? 'Use a supported Linux/WSL host.',
      });
    }
    if (candidate.id.startsWith('state.schema.')) {
      const store = candidate.id.slice('state.schema.'.length);
      if (permissionRepairIds.has(store)) continue;
      blockers.push({
        code: candidate.detailCode,
        summary: candidate.summary,
        remediation: candidate.remediation?.message ?? 'Back up and reconcile durable state before rerunning setup.',
        localized: {
          'zh-Hans': {
            summary: `${store} 持久状态未通过安全与架构检查。`,
            remediation: '请先备份并明确处理该持久状态，然后重新运行安装；安装不会覆盖不明确的状态。',
          },
        },
      });
    }
  }
  return blockers;
}

function durableStateBlockers(
  inspections: readonly DurableStoreInspection[],
): SetupBlockingIssue[] {
  return inspections.map((inspection) => {
    const knownPreinstallMigration = inspection.id === 'setup'
      && inspection.status === 'migration-required';
    const unversioned = inspection.status === 'migration-required';
    return {
      code: inspection.detailCode,
      summary: knownPreinstallMigration
        ? 'Existing setup state uses a known older schema, but first-time setup cannot migrate it safely.'
        : unversioned
          ? `${inspection.id} durable state is unversioned and has no supported setup migration.`
          : `${inspection.id} durable state is unsafe, malformed, or uses an unsupported schema.`,
      remediation: knownPreinstallMigration
        ? 'Back up and move the existing setup state file out of the cosyncing state directory, then rerun setup. Setup will not invoke the repair-only migration before it owns a committed installation.'
        : unversioned
          ? `Back up and move the existing ${inspection.id} state file out of the cosyncing state or cache directory, then rerun setup. Setup will not guess an unversioned format.`
          : `Back up and reconcile the existing ${inspection.id} state before rerunning setup. Setup will not alter state whose ownership, file shape, permissions, and schema are not proven safe.`,
      localized: {
        'zh-Hans': {
          summary: knownPreinstallMigration
            ? '现有安装状态使用已知旧版架构，但首次安装无法安全迁移该文件。'
            : unversioned
              ? `${inspection.id} 持久状态没有版本信息，安装程序不支持自动迁移。`
              : `${inspection.id} 持久状态不安全、格式错误或使用不受支持的架构版本。`,
          remediation: knownPreinstallMigration
            ? '请先备份现有安装状态文件，并将其移出 cosyncing 状态目录，然后重新运行安装。首次安装尚未取得已提交安装的所有权，因此不会调用仅供 repair 使用的迁移。'
            : unversioned
              ? `请先备份现有 ${inspection.id} 状态文件，并将其移出 cosyncing 状态或缓存目录，然后重新运行安装。安装程序不会猜测无版本格式。`
              : `请先备份并明确处理现有 ${inspection.id} 状态，再重新运行安装。若所有权、文件类型、权限和架构未证明安全，安装程序不会修改该状态。`,
        },
      },
    };
  });
}

function uniqueIssues(issues: readonly SetupBlockingIssue[]): SetupBlockingIssue[] {
  const byCode = new Map<string, SetupBlockingIssue>();
  for (const issue of issues) byCode.set(issue.code, issue);
  return [...byCode.values()];
}

async function portStatus(options: {
  context: SetupDiagnosisContext;
  config: BrokerConfig;
  installed: boolean;
}): Promise<SetupInspection['portStatus']> {
  const probe = await options.context.probeTcp('127.0.0.1', options.config.broker.port);
  if (probe === 'closed') return 'free';
  if (probe !== 'open') return 'unknown';
  const health = await options.context.fetchJson(
    new URL('/api/health', options.config.broker.internalUrl).toString(),
  );
  return options.installed && health.status === 'ok' && (health.json as any)?.ok === true
    ? 'owned-running'
    : 'conflict';
}

function inspectionFingerprint(input: Omit<SetupInspection, 'preconditionHash' | 'doctor'>): unknown {
  return {
    installState: input.installState.committed
      ? { committed: true, committedAt: input.installState.state.setup.committedAt, resources: input.installState.state.resources }
      : { committed: false, reason: input.installState.reason },
    installedBinary: {
      status: input.installedBinary.status,
      expectedSha256: input.installedBinary.expectedSha256,
      actualSha256: input.installedBinary.actualSha256,
    },
    config: input.config.status === 'ok'
      ? { status: 'ok', config: input.config.config }
      : { status: input.config.status, problem: input.config.status === 'error' ? input.config.detailCode : 'missing' },
    brokerCredential: input.brokerCredential.status,
    piCredential: input.piCredential.status,
    piCredentialUrlMatches: input.piCredentialUrlMatches,
    setupState: input.setupState,
    piBridge: {
      status: input.piBridge.status,
      actualSha256: input.piBridge.actualSha256,
    },
    agentSkills: input.agentSkills.map(({ id, path, status, actualSha256 }) => ({
      id,
      path,
      status,
      actualSha256,
    })),
    durableStatePermissionRepairs: input.durableStatePermissionRepairs,
    opencodeShim: {
      shimStatus: input.opencodeShim.shimStatus,
      rc: input.opencodeShim.rc.map(({ id, state }) => ({ id, state })),
    },
    portStatus: input.portStatus,
    agents: input.agents.map(({ id, state, installedVersion, minimumVersion, runtimeUnavailable }) => ({
      id,
      state,
      installedVersion,
      minimumVersion,
      ...(runtimeUnavailable ? { runtimeUnavailable } : {}),
    })),
    agentExecutableDirectories: input.agentExecutableDirectories,
    agentExecutableOverrides: input.agentExecutableOverrides,
    durableServiceProvider: input.durableServiceProvider,
    systemdAvailable: input.systemdAvailable,
    systemdStatus: input.systemdStatus,
    systemdDefinitionPath: input.systemdDefinitionPath,
    systemdEnvironmentPath: input.systemdEnvironmentPath,
    systemdPersistenceTarget: input.systemdPersistenceTarget,
    tailscaleAvailable: input.tailscaleAvailable,
    tailscale: input.tailscale,
    blockingIssueCodes: input.blockingIssues.map((issue) => issue.code).sort(),
  };
}

export async function inspectSetupEnvironment(options: {
  buildInfo: Readonly<BuildInfo>;
  executablePath: string;
  runtimePath?: string;
  home: string;
  context: SetupDiagnosisContext;
  systemdProviderFactory?: (options: SystemdProviderOptions) => DurableServiceProvider;
}): Promise<SetupInspection> {
  const config = inspectBrokerConfig(options.home);
  const targetConfig = config.status === 'ok' ? config.config : defaultBrokerConfig();
  const installState = inspectInstallState(options.home);
  const installedBinary = inspectInstalledBinary({
    home: options.home,
    packaged: options.buildInfo.packaged,
    executablePath: options.executablePath,
  });
  const brokerCredential = inspectBrokerToken(brokerTokenPath(options.home));
  const piCredential = inspectPiIntegration(piIntegrationPath(options.home));
  const piCredentialUrlMatches = piCredential.status === 'ok'
    && readPiIntegration(piCredential.path).internalUrl === targetConfig.broker.internalUrl;
  const setupState = readSetupState(options.home);
  const piAgentDir = options.context.env.PI_CODING_AGENT_DIR?.trim()
    || join(options.context.homeDir, '.pi', 'agent');
  const piBridge = inspectPiBridgeAsset(piAgentDir);
  const agentSkills = inspectAgentSkills(options.context);
  const opencodeShimPath = opencodeShimShellPath(options.home);
  const shimPort = opencodeShimPort(options.context.env.OPENCODE_URL);
  const shimHost = opencodeShimHost(options.context.env.OPENCODE_URL);
  const opencodeShim: OpencodeShimInspection = {
    shimPath: opencodeShimPath,
    shimStatus: inspectOpencodeShim(opencodeShimPath),
    actualSha256: opencodeShimActualSha256(opencodeShimPath),
    rc: opencodeShimRcCandidates(options.context).map(({ id, resourceId, path }): OpencodeShimRcSummary => {
      const rc = inspectRcFile(path, opencodeShimPath, shimPort, shimHost);
      const state = rc.status === 'absent' ? 'no-file' : rc.status === 'unsafe' ? 'unsafe' : rc.blockState;
      return { id, resourceId, path, state };
    }),
  };
  const cacheRoot = options.context.env.COSYNCING_CACHE_DIR?.trim()
    || join(options.context.homeDir, '.cache', PRODUCT_IDENTITY.cacheDirectoryName);
  const durableAssessment = assessDurableStateForSetup(durableStateLayout({
    stateRoot: options.home,
    cacheRoot,
  }));
  const [doctor, tailscale] = await Promise.all([
    collectDoctorReport({
      buildInfo: options.buildInfo,
      context: options.context,
      assetReport: inspectRuntimeAssets(),
      stateHome: options.home,
    }),
    inspectTailscaleServe({ context: options.context, internalUrl: targetConfig.broker.internalUrl }),
  ]);
  const agents = agentSummaries(doctor);
  const agentExecutableDirectories = serviceAgentExecutableDirectories(options.context);
  const agentExecutableOverrides = serviceAgentExecutableOverrides(options.context);
  const currentPort = await portStatus({
    context: options.context,
    config: targetConfig,
    installed: installState.committed,
  });
  const issues: SetupBlockingIssue[] = [...doctorBlockers(
    doctor,
    new Set(durableAssessment.permissionRepairs.map((repair) => repair.id)),
  ), ...durableStateBlockers(durableAssessment.blockers)];
  if (config.status === 'error') {
    issues.push({
      code: config.detailCode,
      summary: 'Existing broker configuration is unsafe, malformed, or requires migration.',
      remediation: `Run \`${PRODUCT_IDENTITY.primaryBinary} repair\`; setup will not overwrite ambiguous configuration.`,
    });
  }
  if (brokerCredential.status !== 'missing' && brokerCredential.status !== 'ok') {
    issues.push({
      code: brokerCredential.detailCode,
      summary: 'Existing broker credential state is unsafe or malformed.',
      remediation: `Run \`${PRODUCT_IDENTITY.primaryBinary} repair\` to rotate the credential safely.`,
    });
  }
  if (piCredential.status !== 'missing' && piCredential.status !== 'ok') {
    issues.push({
      code: piCredential.detailCode,
      summary: 'Existing Pi integration credential state is unsafe or malformed.',
      remediation: `Run \`${PRODUCT_IDENTITY.primaryBinary} repair\` to reconcile the scoped credential.`,
    });
  }
  if (currentPort === 'conflict') {
    issues.push({
      code: 'broker-port-conflict',
      summary: `Port ${targetConfig.broker.port} is already owned by an unrecognized process or contributor broker.`,
      remediation: 'Stop that process explicitly or choose a different broker port; setup never kills an unowned listener.',
    });
  }
  const pi = agents.find((agent) => agent.id === 'pi');
  if (pi?.state === 'supported' && ['unowned', 'unreadable'].includes(piBridge.status)) {
    issues.push({
      code: `pi-bridge-${piBridge.status}`,
      summary: 'The Pi bridge target cannot be replaced safely during first-time setup.',
      remediation: `Move or back up ${piBridge.path}, then rerun setup; setup replaces only an exact known legacy bridge after confirmation.`,
      localized: {
        'zh-Hans': {
          summary: '现有 Pi bridge 不是可证明属于 cosyncing 的已知旧版，安装不会覆盖。',
          remediation: `请先移动或备份 ${piBridge.path}，再重新运行安装。只有内容完全匹配已知旧版且得到确认时，安装才会替换。`,
        },
      },
    });
  }
  if (!installState.committed && installState.reason !== 'missing') {
    issues.push({
      code: `install-state-${installState.reason}`,
      summary: 'An existing installation receipt is not safely committed.',
      remediation: `Run \`${PRODUCT_IDENTITY.primaryBinary} repair\` before attempting setup again.`,
    });
  }
  const durableServiceProvider = durableServiceProviderId(options.context.platform);
  const systemdCheck = check(doctor, DURABLE_SERVICE_CHECK_ID[durableServiceProvider]);
  // A source entry point is not a stable executable for a boot service. Durable installation is exposed only
  // by the packaged binary; contributor source runs retain foreground setup for local development.
  const systemdAvailable = options.buildInfo.packaged
    && (systemdCheck?.status === 'pass' || systemdCheck?.detailCode === 'systemd-user-degraded');
  const systemdProvider = systemdAvailable
    ? (options.systemdProviderFactory ?? createDurableServiceProvider)({
        context: options.context,
        homeDir: options.context.homeDir,
        stateHome: options.home,
        cacheRoot,
        executablePath: serviceExecutablePath({
          packaged: options.buildInfo.packaged,
          home: options.home,
          executablePath: options.executablePath,
        }),
        distribution: options.buildInfo.distribution,
        ...(options.runtimePath ? { runtimePath: options.runtimePath } : {}),
        agentExecutableDirectories,
        agentExecutableOverrides,
        webDir: serviceFlutterWebRoot({
          override: options.context.env.COSYNCING_WEB_DIR,
          packaged: options.buildInfo.packaged,
          executablePath: options.executablePath,
          version: options.buildInfo.version,
        }),
      })
    : undefined;
  const systemdStatus = systemdProvider ? await systemdProvider.inspect() : undefined;
  const withoutHash: Omit<SetupInspection, 'preconditionHash' | 'doctor'> = {
    schemaVersion: 1,
    product: PRODUCT_IDENTITY.productName,
    version: options.buildInfo.version,
    installLocation: options.executablePath,
    stateHome: options.home,
    installState,
    installedBinary,
    config,
    targetConfig,
    brokerCredential,
    piCredential,
    piCredentialUrlMatches,
    setupState,
    piAgentDir,
    piBridge,
    durableStatePermissionRepairs: durableAssessment.permissionRepairs,
    agentSkills,
    opencodeShim,
    portStatus: currentPort,
    // Same PATH lookup the agent preflight uses, and the same one provisioning itself makes, so the prompt
    // describes the branch that will actually run. BOTH executables, because provisioning skips pipx
    // entirely when the tokdash command is already there — a host with the CLI installed and the instance
    // stopped was being told cosyncing could not set it up. No probe of the endpoint here: consent comes
    // before any network call.
    pipxAvailable: !!options.context.resolveExecutable('pipx'),
    tokdashAvailable: !!options.context.resolveExecutable(TOKDASH_PACKAGE),
    agentExecutableDirectories,
    agentExecutableOverrides,
    durableServiceProvider,
    systemdAvailable,
    ...(systemdStatus ? { systemdStatus } : {}),
    ...(systemdProvider ? {
      systemdDefinitionPath: systemdProvider.definitionPath,
      systemdEnvironmentPath: systemdProvider.environmentPath,
      systemdPersistenceTarget: systemdProvider.persistenceTarget,
    } : {}),
    tailscaleAvailable: tailscale.backend === 'running'
      && tailscale.httpsCapability === 'ready'
      && tailscale.route !== 'unavailable'
      && tailscale.route !== 'malformed'
      && tailscale.route !== 'conflict'
      && tailscale.route !== 'funnel-conflict',
    tailscale,
    webAppAvailable: existsSync(join(resolveFlutterWebRoot({
      override: options.context.env.COSYNCING_WEB_DIR,
      packaged: options.buildInfo.packaged,
      executablePath: options.executablePath,
      version: options.buildInfo.version,
      sourceRoot: resolve(import.meta.dir, '../../../../../apps/client/build/web'),
    }), 'index.html')),
    agents,
    blockingIssues: uniqueIssues(issues),
  };
  return {
    ...withoutHash,
    doctor,
    preconditionHash: hash(inspectionFingerprint(withoutHash)),
  };
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function desiredState(options: {
  inspection: SetupInspection;
  choices: SetupChoices;
  acknowledgedAt: string;
}): SetupState {
  const current = options.inspection.setupState;
  const currentAgents = current.agents && typeof current.agents === 'object' && !Array.isArray(current.agents)
    ? current.agents
    : {};
  const codexSupported = options.inspection.agents.some((agent) => agent.id === 'codex' && agent.state === 'supported');
  return {
    ...current,
    schemaVersion: 1,
    agents: { ...currentAgents, codex: codexSupported },
    managedRuntimeAcknowledgedAt: options.acknowledgedAt,
    serviceChoice: options.choices.service,
    systemdLingeringRequested: options.choices.enableLingering,
    tailscaleServeRequested: options.choices.tailscaleServe,
    agentSkillRequested: options.choices.installAgentSkill,
    opencodeShimRequested: options.choices.installOpencodeShim,
    quotaWarningsEnabled: options.choices.quotaWarnings,
    language: options.choices.language,
  };
}

function setupStateMatches(actual: SetupState, expected: SetupState): boolean {
  return actual.schemaVersion === 1
    && actual.agents?.codex === expected.agents?.codex
    && actual.managedRuntimeAcknowledgedAt === expected.managedRuntimeAcknowledgedAt
    && actual.serviceChoice === expected.serviceChoice
    && actual.systemdLingeringRequested === expected.systemdLingeringRequested
    && actual.tailscaleServeRequested === expected.tailscaleServeRequested
    && actual.agentSkillRequested === expected.agentSkillRequested
    && actual.opencodeShimRequested === expected.opencodeShimRequested
    && actual.quotaWarningsEnabled === expected.quotaWarningsEnabled
    && actual.language === expected.language;
}

function installMetadataMatches(inspection: SetupInspection, choices: SetupChoices): boolean {
  if (!inspection.installState.committed) return false;
  const installer = inspection.installState.state.installer;
  if (!installer || typeof installer !== 'object' || Array.isArray(installer)) return false;
  const record = installer as Record<string, unknown>;
  return record.version === inspection.version
    && record.serviceChoice === choices.service
    && record.systemdLingeringRequested === choices.enableLingering
    && record.tailscaleServeRequested === choices.tailscaleServe;
}

export function existingSetupChoices(inspection: Readonly<SetupInspection>): SetupChoices {
  return {
    language: normalizeSetupLanguage(inspection.setupState.language) ?? DEFAULT_SETUP_LANGUAGE,
    // A stored durable choice is honored only when it names THIS host's provider. State copied from a linux
    // home (or written by a newer build) degrades to foreground instead of driving a manager that is absent.
    service: inspection.setupState.serviceChoice === inspection.durableServiceProvider
      ? inspection.durableServiceProvider
      : 'foreground',
    enableLingering: inspection.setupState.systemdLingeringRequested === true,
    tailscaleServe: inspection.setupState.tailscaleServeRequested === true,
    quotaWarnings: inspection.setupState.quotaWarningsEnabled === true,
    installAgentSkill: inspection.setupState.agentSkillRequested !== false,
    installOpencodeShim: inspection.setupState.opencodeShimRequested !== false,
  };
}

/** True when this plan installs a durable service rather than foreground mode. */
function durableServiceChoice(choices: Readonly<SetupChoices>): boolean {
  return choices.service !== 'foreground';
}

function installedResource(inspection: SetupInspection, id: string) {
  return inspection.installState.committed
    ? inspection.installState.state.resources.find((resource) => resource.id === id)
    : undefined;
}

/** Does a receipt for this target prove the given content sha is package-owned at this exact path? */
function agentSkillReceiptProves(
  inspection: SetupInspection,
  target: AgentSkillInspection,
  sha: string | undefined,
): boolean {
  if (!sha) return false;
  const receipt = installedResource(inspection, target.resourceId);
  return !!receipt
    && receipt.kind === 'agent-integration'
    && receipt.target === target.path
    && receipt.ownership?.proof === 'package-hash'
    && receipt.ownership.installedSha256 === sha;
}

/** A receipt proving the CURRENT packaged content is the exact copy on disk (owned-current). */
function matchingAgentSkillReceipt(
  inspection: SetupInspection,
  target: AgentSkillInspection,
): boolean {
  return agentSkillReceiptProves(inspection, target, AGENT_SKILL_SHA256);
}

/**
 * owned-stale: the on-disk copy is an OLDER packaged version, but a receipt proves we installed exactly that
 * content (receipt.installedSha256 === the file's actual sha). This is the "broker updated, skill copy is now
 * behind" case — safe to overwrite in place with the current build rather than blocking setup.
 */
function agentSkillOwnedStale(
  inspection: SetupInspection,
  target: AgentSkillInspection,
): boolean {
  return target.status === 'drifted'
    && agentSkillReceiptProves(inspection, target, target.actualSha256);
}

/** True when the install-state receipt proves the on-disk shim script is one WE wrote at hash `sha` (the R1
 *  package-hash receipt at the resolved shim path). Mirrors agentSkillReceiptProves. */
function opencodeShimReceiptProves(inspection: SetupInspection, sha: string | undefined): boolean {
  if (!sha) return false;
  const receipt = installedResource(inspection, OPENCODE_SHIM_RESOURCE_ID);
  return !!receipt
    && receipt.kind === 'path-entry'
    && receipt.target === inspection.opencodeShim.shimPath
    && receipt.ownership?.proof === 'package-hash'
    && receipt.ownership.installedSha256 === sha;
}

/** A drifted shim script that the receipt proves WE installed (a previous package version) — a safe in-place
 *  upgrade, not user-edited foreign drift. */
function opencodeShimOwnedStale(inspection: SetupInspection): boolean {
  return inspection.opencodeShim.shimStatus === 'drifted'
    && opencodeShimReceiptProves(inspection, inspection.opencodeShim.actualSha256);
}

/**
 * Does a committed receipt already measure the current home copy exactly (right kind, canonical path,
 * package-hash proof, and the hash of the executable this run would install)? When it does, and the copy is
 * current, the bootstrap-copy step has nothing left to do and setup stays a genuine no-op.
 */
function installedBinaryReceiptCurrent(inspection: SetupInspection): boolean {
  const expected = inspection.installedBinary.expectedSha256;
  if (!expected) return false;
  const receipt = installedResource(inspection, 'broker-binary');
  return !!receipt
    && receipt.kind === 'binary'
    && resolve(receipt.target) === resolve(inspection.installedBinary.path)
    && receipt.ownership?.proof === 'package-hash'
    && receipt.ownership.installedSha256 === expected;
}

function packageOwnedFile(inspection: SetupInspection, id: string, target?: string): boolean {
  if (!target) return false;
  const resource = installedResource(inspection, id);
  if (!resource || typeof resource !== 'object' || resource.target !== target
      || !resource.ownership || typeof resource.ownership !== 'object'
      || resource.ownership.proof !== 'package-hash'
      || !resource.ownership.installedSha256) return false;
  if (!existsSync(target)) return true;
  try {
    return createHash('sha256').update(readFileSync(target)).digest('hex') === resource.ownership.installedSha256;
  } catch {
    return false;
  }
}

function systemdOwnership(inspection: SetupInspection): {
  serviceFiles: boolean;
  lingering: boolean;
} {
  const lingering = installedResource(inspection, 'service-systemd-linger');
  return {
    serviceFiles: packageOwnedFile(
      inspection,
      serviceDefinitionResourceId({ id: inspection.durableServiceProvider }),
      inspection.systemdDefinitionPath,
    )
      && packageOwnedFile(inspection, 'service-environment', inspection.systemdEnvironmentPath),
    lingering: !!lingering
      && lingering.kind === 'other'
      && lingering.target === inspection.systemdPersistenceTarget
      && lingering.ownership?.proof === 'receipt',
  };
}

function tailscaleOwnership(inspection: SetupInspection): boolean {
  const resource = installedResource(inspection, TAILSCALE_SERVE_RESOURCE_ID);
  if (!resource || resource.kind !== 'other' || resource.ownership?.proof !== 'receipt'
      || resource.ownership.marker !== TAILSCALE_SERVE_OWNERSHIP_MARKER
      || !inspection.tailscale.advertisedUrl) return false;
  return resource.target === tailscaleRouteReceiptTarget(inspection.tailscale);
}

function targetConfigForChoices(inspection: SetupInspection, choices: SetupChoices): BrokerConfig {
  const base = inspection.targetConfig;
  if (choices.tailscaleServe && inspection.tailscale.advertisedUrl) {
    return {
      ...base,
      broker: { ...base.broker, advertisedUrl: inspection.tailscale.advertisedUrl },
    };
  }
  if (!choices.tailscaleServe
      && (inspection.setupState.tailscaleServeRequested === true || tailscaleOwnership(inspection))) {
    const broker = { ...base.broker };
    delete broker.advertisedUrl;
    return { ...base, broker };
  }
  return base;
}

export function buildSetupPlan(options: {
  inspection: SetupInspection;
  choices: SetupChoices;
  acknowledgedAt?: string;
  now?: () => Date;
}): SetupPlan {
  const acknowledgedAt = validTimestamp(options.acknowledgedAt)
    ? options.acknowledgedAt
    : validTimestamp(options.inspection.setupState.managedRuntimeAcknowledgedAt)
      ? options.inspection.setupState.managedRuntimeAcknowledgedAt
      : (options.now?.() ?? new Date()).toISOString();
  const desiredSetupState = desiredState({
    inspection: options.inspection,
    choices: options.choices,
    acknowledgedAt,
  });
  const targetConfig = targetConfigForChoices(options.inspection, options.choices);
  // Every plan row is authored ONCE, as a step. `english` renders it into the reference text the journal,
  // the receipts, and `--yes` carry; the wizard renders the same step into whatever language it is running
  // in. Two renderings of one value cannot describe two different mutations, which a parallel translated
  // string list would eventually do.
  const english = setupMessages('en');
  const actions: (SetupPlanAction & { step: SetupMutationStep })[] = [];
  const planned = (step: SetupMutationStep, action: Omit<SetupPlanAction, 'summary'>) =>
    ({ ...action, summary: english.planStep(step), step });
  /** Plan rows that belong to no transaction action (a reuse note, the commit line). */
  const extraSteps: SetupMutationStep[] = [];
  if (options.inspection.config.status !== 'ok'
      || JSON.stringify(options.inspection.config.config) !== JSON.stringify(targetConfig)) {
    actions.push(planned({
      kind: 'config',
      configPath: join(options.inspection.stateHome, 'config.json'),
      internalUrl: targetConfig.broker.internalUrl,
      ...(targetConfig.broker.advertisedUrl ? { advertisedUrl: targetConfig.broker.advertisedUrl } : {}),
    }, { id: 'config.ensure', title: 'Write broker configuration', reversible: true }));
  }
  if (options.inspection.brokerCredential.status === 'missing'
      || options.inspection.piCredential.status === 'missing'
      || !options.inspection.piCredentialUrlMatches) {
    actions.push(planned({ kind: 'credentials' },
      { id: 'credentials.ensure', title: 'Create scoped credentials', reversible: true }));
  }
  if (!setupStateMatches(options.inspection.setupState, desiredSetupState)) {
    actions.push(planned({ kind: 'setup-state', service: options.choices.service },
      { id: 'setup-state.write', title: 'Record setup choices', reversible: true }));
  }
  const durableStatePermissionRepairs = options.inspection.durableStatePermissionRepairs ?? [];
  if (durableStatePermissionRepairs.length > 0) {
    actions.push(planned({
      kind: 'durable-state-permissions',
      paths: durableStatePermissionRepairs.map((repair) => repair.path),
    }, {
      id: 'durable-state.permissions',
      title: 'Tighten legacy durable-state permissions',
      reversible: true,
    }));
  }
  const installPiBridge = options.inspection.agents.some((agent) => agent.id === 'pi' && agent.state === 'supported')
    && (options.inspection.piBridge.status === 'missing'
      || (options.inspection.piBridge.status === 'legacy-marker' && options.choices.replaceLegacyPiBridge === true));
  if (installPiBridge) {
    const replacingLegacy = options.inspection.piBridge.status === 'legacy-marker';
    actions.push(planned({
      kind: 'pi-bridge',
      path: options.inspection.piBridge.path,
      ...(replacingLegacy ? { replaceLegacy: true } : {}),
    }, {
      id: 'pi-bridge.install',
      title: replacingLegacy ? 'Replace the known legacy Pi bridge' : 'Install packaged Pi bridge',
      reversible: true,
    }));
  }
  const blockingIssues = [...options.inspection.blockingIssues];
  // Bootstrap copy. Planned whenever the home copy is not byte-identical to the running packaged executable,
  // or its measured receipt is missing/stale — so a first npm install copies, an `npm update` re-copies, and
  // an unchanged re-run plans nothing.
  const installedBinary = options.inspection.installedBinary;
  const needsInstalledBinary = installedBinary.status !== 'not-applicable'
    && (installedBinary.status !== 'current' || !installedBinaryReceiptCurrent(options.inspection));
  if (installedBinary.status === 'unsafe') {
    blockingIssues.push({
      code: 'installed-binary-unsafe',
      summary: `The existing ${installedBinary.path} is a symlink, a non-regular file, or not owned by this user.`,
      remediation: `Move or remove ${installedBinary.path} explicitly, then rerun setup; setup never replaces an unowned installed binary.`,
    });
  } else if (installedBinary.status === 'source-unreadable') {
    blockingIssues.push({
      code: 'installed-binary-source-unreadable',
      summary: 'The running packaged executable cannot be read, so it cannot be installed into the state home.',
      remediation: `Reinstall the ${PRODUCT_IDENTITY.productName} package and rerun setup.`,
    });
  }
  // The bootstrap copy is DECIDED here but only unshifted into `actions` far below, after the service
  // decision, so that it lands ahead of `service.systemd` at execution time. Every predicate that asks
  // "is any mutation pending?" must therefore add this term explicitly instead of reading `actions.length`:
  // replacing the binary under an active service leaves the unit executing the deleted image (`/proc/PID/exe
  // -> ".../bin/cosyncing (deleted)"`) and serving the previous build's routes until someone restarts it by
  // hand.
  const plansInstalledBinary = needsInstalledBinary
    && !blockingIssues.some((issue) => issue.code.startsWith('installed-binary-'));
  const mutationsPending = (): boolean => actions.length > 0 || plansInstalledBinary;

  const skillReceipts = options.inspection.agentSkills.map((target) => ({
    target,
    matches: matchingAgentSkillReceipt(options.inspection, target),
    ownedStale: agentSkillOwnedStale(options.inspection, target),
  }));
  // A receipt-proved owned-stale copy is a safe in-place upgrade, not a blocking drift.
  const unsafeSkill = skillReceipts.find(({ target, ownedStale }) =>
    !['missing', 'owned'].includes(target.status)
      && !ownedStale
      && !(target.status === 'known-legacy' && options.choices.upgradeLegacyAgentSkill === true));
  if (options.choices.installAgentSkill) {
    if (unsafeSkill) {
      const knownLegacy = unsafeSkill.target.status === 'known-legacy';
      const backupPath = `${unsafeSkill.target.path}.backup`;
      blockingIssues.push({
        code: `agent-skill-${unsafeSkill.target.id}-${unsafeSkill.target.status}`,
        summary: knownLegacy
          ? `The ${unsafeSkill.target.id} target is the known preceding cosyncing skill and needs explicit upgrade confirmation.`
          : `The ${unsafeSkill.target.id} cosyncing skill target is modified or unsafe and will be preserved.`,
        remediation: knownLegacy
          ? `Rerun setup and confirm the older skill upgrade, or back it up with: mv -- '${unsafeSkill.target.path}' '${backupPath}'`
          : `Move or reconcile ${unsafeSkill.target.path} explicitly, then rerun setup; unknown content is never overwritten.`,
        localized: {
          'zh-Hans': knownLegacy
            ? {
                summary: `${unsafeSkill.target.id} 目标是已知的上一版 cosyncing skill，升级前需要单独确认。`,
                remediation: `请重新运行安装并确认升级；或先备份：mv -- '${unsafeSkill.target.path}' '${backupPath}'`,
              }
            : {
                summary: `${unsafeSkill.target.id} 目标已修改或不安全，安装会原样保留。`,
                remediation: `请先明确移动或整理 ${unsafeSkill.target.path}，再重新运行安装；未知内容永远不会被覆盖。`,
              },
        },
      });
    } else if (skillReceipts.some(({ target, matches, ownedStale }) =>
        target.status === 'missing' || target.status === 'known-legacy' || ownedStale || !matches)) {
      const upgrading = skillReceipts.some(({ target, ownedStale }) => ownedStale || target.status === 'known-legacy');
      actions.push(planned({ kind: upgrading ? 'agent-skill-refresh' : 'agent-skill-install' }, {
        id: 'agent-skill.reconcile',
        title: upgrading ? 'Refresh the packaged cosyncing skill' : 'Install the cosyncing skill',
        reversible: true,
      }));
    }
  } else {
    const ownedReceipts = skillReceipts.filter(({ matches }) => matches);
    const driftedReceipt = ownedReceipts.find(({ target }) => !['missing', 'owned'].includes(target.status));
    if (driftedReceipt) {
      blockingIssues.push({
        code: `agent-skill-${driftedReceipt.target.id}-modified-preserved`,
        summary: `The receipt-owned ${driftedReceipt.target.id} skill changed and will be preserved.`,
        remediation: 'Restore the packaged copy before opting out, or remove the modified file manually.',
      });
    } else if (ownedReceipts.length > 0) {
      actions.push(planned({ kind: 'agent-skill-remove' },
        { id: 'agent-skill.reconcile', title: 'Remove package-owned cosyncing skills', reversible: true }));
    }
  }
  if (options.choices.installOpencodeShim) {
    const shim = options.inspection.opencodeShim;
    const shimOwnedStale = opencodeShimOwnedStale(options.inspection);
    // 'foreign' (symlink/unsafe) and 'drifted'-without-a-receipt (a user edit) are preserved untouched. Only a
    // 'drifted' script the receipt proves WE installed (a previous package version) is a safe in-place upgrade.
    if (shim.shimStatus === 'foreign' || (shim.shimStatus === 'drifted' && !shimOwnedStale)) {
      blockingIssues.push({
        code: 'opencode-shim-foreign',
        summary: 'The cosyncing opencode shim script is modified or unsafe and will be preserved.',
        remediation: `Move or reconcile ${shim.shimPath}, then rerun setup.`,
      });
    } else {
      // Work is pending when R1 is not owned (missing, or an owned-stale previous version to upgrade), or any
      // EXISTING rc file's block is absent, owned-stale (a drifted port/host or older format we re-canonicalize
      // in place), or foreign (surfaced as a preserved-and-warned block). rc files that do not exist ('no-file')
      // are never created; unsafe/symlinked rc files are skipped.
      const blockPending = shim.rc.some(({ state }) => state === 'absent' || state === 'owned-stale' || state === 'foreign');
      if (shim.shimStatus !== 'owned' || blockPending) {
        actions.push(planned({ kind: 'opencode-shim' }, {
          id: 'opencode-shim.reconcile',
          title: shimOwnedStale ? 'Upgrade the cosyncing opencode shim' : 'Route terminal opencode to the shared serve',
          reversible: true,
        }));
      }
    }
  }
  const ownership = systemdOwnership(options.inspection);
  const serviceStatus = options.inspection.systemdStatus;
  const serviceArtifactsPresent = !!serviceStatus && (
    serviceStatus.definition !== 'missing'
    || serviceStatus.environment !== 'missing'
    || serviceStatus.enabled !== 'disabled'
    || serviceStatus.active !== 'inactive'
  );
  const metadataCurrent = installMetadataMatches(options.inspection, options.choices);
  const provider = options.inspection.durableServiceProvider;
  let serviceAction: 'installed' | 'absent' | undefined;
  if (durableServiceChoice(options.choices)) {
    if (!options.inspection.systemdAvailable || !serviceStatus?.supported) {
      blockingIssues.push({
        code: `${provider}-user-unavailable`,
        summary: `A usable ${provider} user service manager is required for persistent service mode.`,
        remediation: provider === 'launchd'
          ? 'Sign in to a macOS GUI session so launchd can own the agent, or choose foreground mode.'
          : 'Enable the systemd user manager or choose foreground mode. WSL without systemd supports foreground mode only.',
      });
    } else {
      if (serviceStatus.definition === 'unsafe' || serviceStatus.environment === 'unsafe'
          || ((serviceStatus.definition !== 'missing' || serviceStatus.environment !== 'missing') && !ownership.serviceFiles)) {
        blockingIssues.push({
          code: `${provider}-definition-unowned`,
          summary: `The existing ${PRODUCT_IDENTITY.productName} ${provider} definition is unsafe or is not proven to be package-owned.`,
          remediation: `Preserve the existing files and run \`${PRODUCT_IDENTITY.primaryBinary} repair\` to reconcile ownership explicitly.`,
        });
      }
      if (serviceStatus.enabled === 'unknown' || serviceStatus.active === 'unknown' || serviceStatus.active === 'transitioning') {
        blockingIssues.push({
          code: `${provider}-status-inconclusive`,
          summary: `The current ${PRODUCT_IDENTITY.productName} ${provider} service posture cannot be determined safely.`,
          remediation: `Wait for ${provider} to settle, inspect the service, and rerun setup.`,
        });
      }
      if (options.choices.enableLingering && serviceStatus.lingering === 'unknown') {
        blockingIssues.push({
          code: 'systemd-lingering-unavailable',
          summary: 'Linux user lingering cannot be inspected on this host.',
          remediation: 'Decline lingering or make loginctl available, then rerun setup.',
        });
      }
      if (options.inspection.portStatus === 'owned-running' && serviceStatus.active !== 'active') {
        blockingIssues.push({
          code: 'foreground-broker-running',
          summary: `A ${PRODUCT_IDENTITY.productName} broker is running outside the selected ${provider} service.`,
          remediation: 'Stop the foreground broker explicitly, then rerun setup; setup never races a second broker onto the port.',
        });
      }
      const needsServiceReconcile = serviceStatus.definition !== 'current'
        || serviceStatus.environment !== 'current'
        || serviceStatus.enabled !== 'enabled'
        || serviceStatus.active !== 'active'
        || (options.choices.enableLingering && serviceStatus.lingering !== 'enabled')
        || mutationsPending()
        || !options.inspection.installState.committed
        || !metadataCurrent;
      if (needsServiceReconcile) serviceAction = 'installed';
    }
  } else if (ownership.serviceFiles || ownership.lingering) {
    if (!options.inspection.systemdAvailable || !serviceStatus?.supported) {
      blockingIssues.push({
        code: `${provider}-removal-unavailable`,
        summary: `The package-owned ${provider} service cannot be removed because the user manager is unavailable.`,
        remediation: `Restore the ${provider} user service manager, then rerun setup or use \`${PRODUCT_IDENTITY.primaryBinary} repair\`.`,
      });
    } else if (serviceStatus.definition === 'unsafe' || serviceStatus.environment === 'unsafe'
        || serviceStatus.enabled === 'unknown' || serviceStatus.active === 'unknown'
        || serviceStatus.active === 'transitioning') {
      blockingIssues.push({
        code: `${provider}-removal-inconclusive`,
        summary: `The package-owned ${provider} service is not in a safely removable posture.`,
        remediation: 'Inspect the installed service, wait for transitions to settle, and rerun setup.',
      });
    } else {
      serviceAction = 'absent';
    }
  } else if (serviceArtifactsPresent) {
    blockingIssues.push({
      code: `${provider}-definition-unowned`,
      summary: `An existing ${PRODUCT_IDENTITY.productName} ${provider} service is not proven to be package-owned.`,
      remediation: `Setup will preserve it. Reconcile ownership explicitly with \`${PRODUCT_IDENTITY.primaryBinary} repair\` before committing foreground mode.`,
    });
  }
  if (serviceAction) {
    // The plan/journal action id stays `service.systemd` on both hosts: it names the one durable-service step
    // in the shared transaction catalog, and renaming it per host would invalidate in-flight journals for no
    // operator-visible gain (the title and summary below are what the wizard actually shows).
    actions.unshift(planned(
      serviceAction === 'installed'
        ? { kind: 'service-install', definitionPath: options.inspection.systemdDefinitionPath ?? '' }
        : { kind: 'service-remove', provider, product: PRODUCT_IDENTITY.productName },
      {
        id: 'service.systemd',
        title: serviceAction === 'installed'
          ? `Reconcile ${provider} user service`
          : `Remove ${provider} user service`,
        reversible: true,
      },
    ));
  }
  const ownsTailscaleRoute = tailscaleOwnership(options.inspection);
  if (options.choices.tailscaleServe) {
    if (!durableServiceChoice(options.choices)) {
      blockingIssues.push({
        code: 'tailscale-serve-requires-durable-service',
        summary: `Verified Tailscale Serve setup requires the broker to run as the selected ${provider} user service.`,
        remediation: `Choose ${provider} service mode, or keep this foreground installation loopback-only.`,
      });
    } else if (!options.inspection.tailscaleAvailable || !options.inspection.tailscale.advertisedUrl) {
      blockingIssues.push({
        code: options.inspection.tailscale.detailCode,
        summary: options.inspection.tailscale.summary,
        remediation: options.inspection.tailscale.topology === 'windows-host-only'
          ? 'Install and run Tailscale inside WSL; Windows-host Tailscale cannot proxy WSL loopback.'
          : 'Start and log in to Tailscale explicitly, enable private HTTPS Serve if required, then rerun setup.',
      });
    } else if (options.inspection.tailscale.route === 'missing') {
      actions.push(planned({
        kind: 'tailscale-register',
        advertisedUrl: options.inspection.tailscale.advertisedUrl ?? '',
        target: options.inspection.tailscale.desiredTarget,
      }, { id: 'network.tailscale-serve', title: 'Register private Tailscale HTTPS route', reversible: true }));
    } else if (options.inspection.tailscale.route === 'desired' && !ownsTailscaleRoute) {
      extraSteps.push({ kind: 'tailscale-reuse' });
    }
  } else if (ownsTailscaleRoute) {
    if (options.inspection.tailscale.route === 'conflict' || options.inspection.tailscale.route === 'funnel-conflict'
        || options.inspection.tailscale.route === 'malformed' || options.inspection.tailscale.route === 'unavailable') {
      blockingIssues.push({
        code: 'tailscale-owned-route-drifted',
        summary: 'The receipt-owned Tailscale route has drifted and cannot be removed safely by setup.',
        remediation: `Inspect the route and run \`${PRODUCT_IDENTITY.primaryBinary} repair\`; unrelated Serve configuration is preserved.`,
      });
    } else {
      actions.push(planned(
        { kind: 'tailscale-remove', advertisedUrl: options.inspection.tailscale.advertisedUrl ?? '' },
        { id: 'network.tailscale-serve', title: 'Remove package-owned Tailscale HTTPS route', reversible: true },
      ));
    }
  }
  if (options.inspection.portStatus === 'owned-running' && mutationsPending() && !serviceAction) {
    blockingIssues.push({
      code: 'foreground-broker-reconfigure-required',
      summary: 'The foreground broker is running while setup changes are pending.',
      remediation: 'Stop the foreground broker explicitly and rerun setup; only an owned service can be coordinated automatically.',
    });
  }
  // Unshifted LAST so it lands ahead of `service.systemd`: the unit's ExecStart names the home copy, and the
  // post-commit verification starts the service, so the binary must be in place before either happens.
  if (plansInstalledBinary) {
    actions.unshift(planned(
      { kind: 'binary-install', version: options.inspection.version, path: installedBinary.path },
      {
        id: 'binary.install',
        title: installedBinary.status === 'stale'
          ? 'Update the installed broker binary'
          : 'Install the broker binary into the state home',
        reversible: true,
      },
    ));
  }
  const requiresCommit = !options.inspection.installState.committed
    || actions.length > 0
    || !metadataCurrent;
  const mutationSteps: SetupMutationStep[] = [
    ...extraSteps,
    ...actions.map((action) => action.step),
    ...(requiresCommit
      ? [{
        kind: 'commit-receipts' as const,
        installStatePath: join(options.inspection.stateHome, 'install-state.json'),
      }]
      : []),
  ];
  const mutationSummary = mutationSteps.map((step) => english.planStep(step));
  // The structured step is a rendering input, not part of the plan's identity. Dropping it here keeps the
  // journal bytes and the plan hash exactly what they were, so an in-flight transaction written by an
  // earlier build still recovers and adding a language cannot invalidate one.
  const planActions: SetupPlanAction[] = actions.map(({ step: _step, ...action }) => action);
  const planHash = hash({
    preconditionHash: options.inspection.preconditionHash,
    choices: options.choices,
    acknowledgedAt,
    targetConfig,
    actions: planActions,
    requiresCommit,
  });
  const transaction: SetupTransactionPlan = {
    schemaVersion: 1,
    id: `setup-${planHash.slice(0, 24)}`,
    preconditionHash: options.inspection.preconditionHash,
    actions: planActions,
  };
  return {
    schemaVersion: 1,
    transaction,
    choices: options.choices,
    acknowledgedAt,
    desiredSetupState,
    targetConfig,
    installPiBridge,
    requiresCommit,
    noOp: actions.length === 0 && !requiresCommit,
    actions: planActions,
    blockingIssues: uniqueIssues(blockingIssues),
    mutationSummary,
    mutationSteps,
  };
}

function actionInputs(options: {
  inspection: SetupInspection;
  plan: SetupPlan;
  context: SetupDiagnosisContext;
  buildInfo: Readonly<BuildInfo>;
  executablePath: string;
  aliasPath?: string;
  now?: () => Date;
}): SetupActionInputs {
  const removeResourceIds: string[] = [];
  const removeAgentSkillResourceIds: string[] = [];
  if (options.plan.choices.service === 'foreground'
      && options.plan.actions.some((action) => action.id === 'service.systemd')) {
    removeResourceIds.push(...SERVICE_RESOURCE_IDS);
  }
  if (!options.plan.choices.tailscaleServe
      && options.plan.actions.some((action) => action.id === 'network.tailscale-serve')) {
    removeResourceIds.push(TAILSCALE_SERVE_RESOURCE_ID);
  }
  if (!options.plan.choices.installAgentSkill
      && options.plan.actions.some((action) => action.id === 'agent-skill.reconcile')) {
    for (const target of options.inspection.agentSkills) {
      if (matchingAgentSkillReceipt(options.inspection, target)) {
        removeResourceIds.push(target.resourceId);
        removeAgentSkillResourceIds.push(target.resourceId);
      }
    }
  }
  return {
    home: options.inspection.stateHome,
    config: options.plan.targetConfig,
    setupState: options.plan.desiredSetupState,
    piAgentDir: options.inspection.piAgentDir,
    installPiBridge: options.plan.installPiBridge,
    replaceLegacyPiBridge: options.plan.choices.replaceLegacyPiBridge,
    durableStatePermissionRepairs: options.inspection.durableStatePermissionRepairs ?? [],
    agentSkillTargets: options.inspection.agentSkills,
    installAgentSkill: options.plan.choices.installAgentSkill,
    upgradeLegacyAgentSkill: options.plan.choices.upgradeLegacyAgentSkill,
    removeAgentSkillResourceIds,
    opencodeShimRcTargets: options.inspection.opencodeShim.rc.map(({ id, resourceId, path }) => ({ id, resourceId, path })),
    installOpencodeShim: options.plan.choices.installOpencodeShim,
    opencodeShimStaleUpgrade: opencodeShimOwnedStale(options.inspection),
    opencodeShimPort: opencodeShimPort(options.context.env.OPENCODE_URL),
    opencodeShimHost: opencodeShimHost(options.context.env.OPENCODE_URL),
    installMetadata: {
      version: options.buildInfo.version,
      packaged: options.buildInfo.packaged,
      executablePath: options.executablePath,
      aliasPath: options.aliasPath,
      serviceChoice: options.plan.choices.service,
      systemdLingeringRequested: options.plan.choices.enableLingering,
      tailscaleServeRequested: options.plan.choices.tailscaleServe,
    },
    removeResourceIds,
    now: options.now,
  };
}

async function verifySetup(options: {
  plan: SetupPlan;
  inspection: SetupInspection;
  context: SetupDiagnosisContext;
}): Promise<boolean> {
  const config = inspectBrokerConfig(options.inspection.stateHome);
  if (config.status !== 'ok' || JSON.stringify(config.config) !== JSON.stringify(options.plan.targetConfig)) return false;
  // A packaged install is only coherent once the canonical home copy exists and matches this build; the
  // service unit, upgrade, and uninstall all address that exact file.
  if (options.inspection.installedBinary.status !== 'not-applicable'
      && inspectInstalledBinary({
        home: options.inspection.stateHome,
        packaged: true,
        executablePath: options.inspection.installLocation,
      }).status !== 'current') {
    return false;
  }
  const broker = inspectBrokerToken(brokerTokenPath(options.inspection.stateHome));
  const piCredential = inspectPiIntegration(piIntegrationPath(options.inspection.stateHome));
  if (broker.status !== 'ok' || piCredential.status !== 'ok') return false;
  if (readPiIntegration(piCredential.path).internalUrl !== options.plan.targetConfig.broker.internalUrl) return false;
  if (!setupStateMatches(readSetupState(options.inspection.stateHome), options.plan.desiredSetupState)) return false;
  if (options.plan.installPiBridge && inspectPiBridgeAsset(options.inspection.piAgentDir).status !== 'owned') return false;
  const skillStatus = inspectAgentSkills(options.context);
  if (options.plan.choices.installAgentSkill
      && !skillStatus.every((target) => target.status === 'owned')) {
    return false;
  }
  const cacheRoot = options.context.env.COSYNCING_CACHE_DIR?.trim()
    || join(options.context.homeDir, '.cache', PRODUCT_IDENTITY.cacheDirectoryName);
  if (inspectDurableSchemas(durableStateLayout({
    stateRoot: options.inspection.stateHome,
    cacheRoot,
  })).some((store) => store.status !== 'ok' && store.status !== 'missing')) {
    return false;
  }
  const port = await options.context.probeTcp('127.0.0.1', options.plan.targetConfig.broker.port);
  if (port !== 'open') return true;
  // `launchctl bootstrap` loads AND starts the agent inside apply, so by the time this runs the listener on
  // the broker port is our own just-started service. systemd defers its start to the post-commit health
  // check, so an open port there still means a foreign listener and must fail. A genuinely foreign listener
  // on either host is already refused at plan time (`broker-port-conflict` / `foreground-broker-running`),
  // and the post-commit check proves the responder is this broker before setup reports success.
  if (options.inspection.durableServiceProvider === 'launchd' && durableServiceChoice(options.plan.choices)) {
    return true;
  }
  return options.inspection.portStatus === 'owned-running';
}

/**
 * What the operator can open the moment setup returns, derived from the plan that was actually applied
 * rather than from what setup offered. Both presenters render this instead of composing URLs themselves, so
 * the outro cannot name an endpoint the plan did not produce.
 *
 * `tailscaleUrl` is present only when the applied plan carries an advertised URL — i.e. the Serve route was
 * requested AND Tailscale supplied a name — because that is the same condition under which the route is
 * registered and post-commit verified. There is deliberately no LAN URL: the broker binds
 * `config.broker.host`, which setup only ever writes as 127.0.0.1, so a printed 192.168.x.x address would
 * name an endpoint nothing is listening on.
 */
export interface SetupAccessReport {
  /** Every credential, config file, and receipt this install owns lives under here. */
  stateHome: string;
  /** Loopback origin of the broker on this host. */
  loopbackUrl: string;
  /** Private tailnet origin, present only once the applied plan registered the Serve route. */
  tailscaleUrl?: string;
  /**
   * False when this build ships no Flutter web bundle — the npm tarball routinely does not. The outro must
   * then send the operator to a paired client instead of an app URL that would answer "not built".
   */
  webApp: boolean;
  /**
   * Whether a broker is PROVEN to be answering on `loopbackUrl` as setup returns. A configured URL is not a
   * served one: a foreground install completes with nothing running, and telling that operator to "open the
   * app on this machine" hands them a dead link. Only two things prove it — the post-commit health check
   * setup already performs when it installs the durable service, and an inspection that found the port
   * already owned by a healthy broker. Everything else is a URL to open AFTER starting one.
   */
  brokerListening: boolean;
}

function accessReport(
  inspection: SetupInspection,
  targetConfig?: BrokerConfig,
  brokerVerified = false,
): SetupAccessReport {
  const broker = (targetConfig ?? inspection.targetConfig).broker;
  return {
    stateHome: inspection.stateHome,
    loopbackUrl: broker.internalUrl,
    ...(broker.advertisedUrl ? { tailscaleUrl: broker.advertisedUrl } : {}),
    webApp: inspection.webAppAvailable,
    brokerListening: brokerVerified || inspection.portStatus === 'owned-running',
  };
}

function result(options: {
  status: SetupCommandResult['status'];
  exitCode: number;
  summaryCode: SetupSummaryCode;
  /** Interpolated by the `cancelled` summary only. */
  stage?: string;
  inspection: SetupInspection;
  recovered: boolean;
  /** The applied (or about-to-be-applied) plan's config, so the outro names the endpoints it produced. */
  targetConfig?: BrokerConfig;
  /** Set only where the transaction's post-commit health check ran and passed. See {@link SetupAccessReport}. */
  brokerVerified?: boolean;
  tokdash?: TokdashProvisionOutcome;
  actions?: string[];
  issues?: readonly SetupBlockingIssue[];
  failure?: SetupFailureReport;
}): SetupCommandResult {
  return {
    schemaVersion: 1,
    status: options.status,
    exitCode: options.exitCode,
    summaryCode: options.summaryCode,
    summary: setupMessages('en').resultSummary(options.summaryCode, {
      binary: PRODUCT_IDENTITY.primaryBinary,
      stage: options.stage ?? '',
    }),
    actions: options.actions ?? [],
    agents: options.inspection.agents,
    access: accessReport(options.inspection, options.targetConfig, options.brokerVerified),
    recoveredInterruptedTransaction: options.recovered,
    ...(options.tokdash ? { tokdash: options.tokdash } : {}),
    ...(options.issues?.length ? { issueCodes: options.issues.map((issue) => issue.code) } : {}),
    ...(options.failure ? { failure: options.failure } : {}),
  };
}

/**
 * Name the failing step the way the operator saw it in the plan. Plan actions carry a title; the two checks
 * that own no action — whole-plan verification and the post-commit service check — get the wording that says
 * what they were doing, because "verify-post-commit" tells nobody anything.
 */
function failureStepLabel(diagnostic: Readonly<SetupFailureDiagnostic>, plan: Readonly<SetupPlan>): string {
  const action = diagnostic.actionId
    ? plan.actions.find((candidate) => candidate.id === diagnostic.actionId)
    : undefined;
  if (action) return `${action.title} (${action.id})`;
  if (diagnostic.actionId) return diagnostic.actionId;
  if (diagnostic.code === 'verify-post-commit') return 'starting the installed broker service and verifying its health';
  if (diagnostic.code === 'verify-final') return 'verifying the applied plan';
  return `the ${diagnostic.stage} stage`;
}

function failureReport(home: string, plan: Readonly<SetupPlan>): SetupFailureReport | undefined {
  const diagnostic = readSetupFailureDiagnostic(home);
  if (!diagnostic) return undefined;
  return {
    step: failureStepLabel(diagnostic, plan),
    code: diagnostic.code,
    detail: diagnostic.detail,
    rollback: diagnostic.rollback,
    diagnosticPath: setupFailureDiagnosticPath(home),
  };
}

async function cancelled(
  dependencies: SetupDependencies,
  inspection: SetupInspection,
  recovered: boolean,
  stage: string,
): Promise<SetupCommandResult> {
  await dependencies.presenter.cancelled(stage);
  return result({
    status: 'cancelled',
    exitCode: 130,
    summaryCode: 'cancelled',
    stage,
    inspection,
    recovered,
  });
}

/**
 * Which of the three provisioning branches this host will take, so the prompt describes THAT one.
 *
 * Provisioning resolves both executables and skips the pipx step entirely when the tokdash command is
 * already there. The prompt used to read only `pipxAvailable`, so it promised a `pipx install` that would
 * not run, and told a host with the CLI installed but no pipx that nothing could be set up at all.
 */
export function tokdashProvisionCapability(
  inspection: Pick<SetupInspection, 'pipxAvailable' | 'tokdashAvailable'>,
): TokdashProvisionCapability {
  if (inspection.tokdashAvailable) return 'setup-only';
  return inspection.pipxAvailable ? 'install' : 'unavailable';
}

/**
 * Is there still Tokdash work for a rerun to do?
 *
 * One question, one record: has provisioning been proven finished AT THIS ENDPOINT? A marker is written only
 * once consent has been issued and the instance has answered, so anything else — no marker, a malformed one,
 * a marker for the URL the operator has since moved away from, a state file written by a build that never
 * wrote markers — means unfinished, and the rerun retries.
 *
 * The gate this replaces asked whether ownership existed and whether a progress note survived, which made
 * owned-resources-with-no-note look complete. A failed progress write then disabled the retry permanently:
 * the service was up, consent had never landed, and no rerun would ever try again.
 *
 * The retry itself is cheap and convergent — the probe inside reuses whatever answers, ownership decides what
 * is skipped, and the only command an already-finished host can attract is one idempotent re-consent, after
 * which the marker is written and the ordinary rerun evaluates nothing again.
 */
function tokdashProvisioningUnfinished(home: string, context: SetupDiagnosisContext): boolean {
  const endpoint = resolveTokdashEndpoint(context.env.COSYNCING_TOKDASH_URL);
  return readTokdashCompletion(home)?.baseUrl !== endpoint.baseUrl;
}

/**
 * The one Tokdash step, shared by the post-commit path and the committed-rerun retry so both probe,
 * provision, and record identically. Never throws — `provisionTokdash` promises that, and this holds the
 * line if it ever breaks it, because a broker install is already committed by the time either caller runs.
 */
async function runTokdashProvisioning(options: {
  context: SetupDiagnosisContext;
  home: string;
  consented: boolean;
  runner?: TokdashCommandRunner;
  now?: () => Date;
}): Promise<TokdashProvisionOutcome> {
  const endpoint = resolveTokdashEndpoint(options.context.env.COSYNCING_TOKDASH_URL);
  const owned = readTokdashOwnership(options.home);
  return provisionTokdash({
    context: options.context,
    endpoint,
    consented: options.consented,
    // Each ownership fact lands here the instant its mutation succeeds. A write that fails is NOT
    // swallowed: it throws back into provisioning, which reverses the mutation it could not record rather
    // than leaving external state behind that uninstall would have no right to remove.
    recordOwnership: (ownership) => { setTokdashOwnership(ownership, options.home); },
    // Read back in so a resumed run adds its facts to the earlier ones — and so it knows which mutations it
    // must NOT repeat. This is the only stored input to that decision; the rest is the live host.
    ...(owned ? { owned } : {}),
    // The marker only ever means "finished here". It is written last, it decides nothing inside
    // provisioning, and a failed write is swallowed there because absence is the retrying direction.
    recordCompletion: (completion) => { setTokdashCompletion(completion, options.home); },
    ...(options.runner ? { run: options.runner } : {}),
    ...(options.now ? { now: options.now } : {}),
  }).catch((error): TokdashProvisionOutcome => ({
    baseUrl: endpoint.baseUrl,
    status: 'unavailable',
    reason: 'not-answering',
    detail: error instanceof Error ? error.message : String(error),
  }));
}

function defaultAliasPath(executablePath: string): string | undefined {
  const candidate = join(dirname(executablePath), PRODUCT_IDENTITY.aliasBinary);
  return existsSync(candidate) ? candidate : undefined;
}

function createSystemdProviderForSetup(options: {
  context: SetupDiagnosisContext;
  home: string;
  packaged: boolean;
  distribution: DistributionKind;
  executablePath: string;
  runtimePath?: string;
  version: string;
  agentExecutableDirectories?: readonly string[];
  agentExecutableOverrides?: Readonly<ServiceAgentExecutableOverrides>;
  factory?: (options: SystemdProviderOptions) => DurableServiceProvider;
}): DurableServiceProvider {
  const cacheRoot = options.context.env.COSYNCING_CACHE_DIR?.trim()
    || join(options.context.homeDir, '.cache', PRODUCT_IDENTITY.cacheDirectoryName);
  return (options.factory ?? createDurableServiceProvider)({
    context: options.context,
    homeDir: options.context.homeDir,
    stateHome: options.home,
    cacheRoot,
    // Must match inspectSetupEnvironment's provider exactly, or the written unit reads back as drifted.
    executablePath: serviceExecutablePath(options),
    distribution: options.distribution,
    ...(options.runtimePath ? { runtimePath: options.runtimePath } : {}),
    agentExecutableDirectories: options.agentExecutableDirectories
      ?? serviceAgentExecutableDirectories(options.context),
    agentExecutableOverrides: options.agentExecutableOverrides
      ?? serviceAgentExecutableOverrides(options.context),
    webDir: serviceFlutterWebRoot({
      override: options.context.env.COSYNCING_WEB_DIR,
      packaged: options.packaged,
      executablePath: options.executablePath,
      version: options.version,
    }),
  });
}

function createTailscaleProviderForSetup(options: {
  context: SetupDiagnosisContext;
  internalUrl: string;
  executablePath?: string;
  factory?: (options: TailscaleServeProviderOptions) => TailscaleServeRouteProvider;
}): TailscaleServeRouteProvider {
  return (options.factory ?? ((providerOptions) => new TailscaleServeProvider(providerOptions)))({
    context: options.context,
    internalUrl: options.internalUrl,
    executablePath: options.executablePath,
  });
}

export async function runSetup(dependencies: SetupDependencies): Promise<SetupCommandResult> {
  const home = dependencies.home ?? setupStateHome();
  const context = dependencies.context ?? createSetupDiagnosisContext();
  const inspect = dependencies.inspectEnvironment ?? inspectSetupEnvironment;
  const acquireLock = dependencies.acquireLock ?? ((options) => acquireInstallationLock(options));
  const catalogFactory = dependencies.actionCatalogFactory ?? createSetupActionCatalog;
  const aliasPath = dependencies.aliasPath ?? defaultAliasPath(dependencies.executablePath);
  let recovered = false;

  // Interrupted setup is always rolled back to its journaled pre-state before a fresh inspection/plan.
  const pendingJournal = readSetupTransactionJournal(home);
  if (pendingJournal) {
    const lock = acquireLock({ command: 'setup', home });
    try {
      const recoveryInputs: SetupActionInputs = {
        home,
        config: defaultBrokerConfig(),
        setupState: readSetupState(home),
        piAgentDir: context.env.PI_CODING_AGENT_DIR?.trim() || join(context.homeDir, '.pi', 'agent'),
        installPiBridge: true,
        durableStatePermissionRepairs: [],
        agentSkillTargets: agentSkillTargets(context),
        installAgentSkill: true,
        removeAgentSkillResourceIds: [],
        opencodeShimRcTargets: opencodeShimRcCandidates(context),
        installOpencodeShim: true,
        opencodeShimPort: opencodeShimPort(context.env.OPENCODE_URL),
        installMetadata: {
          version: dependencies.buildInfo.version,
          packaged: dependencies.buildInfo.packaged,
          executablePath: dependencies.executablePath,
          aliasPath,
          serviceChoice: 'foreground',
          systemdLingeringRequested: false,
          tailscaleServeRequested: false,
        },
        now: dependencies.now,
      };
      const recoveryCatalog = catalogFactory(recoveryInputs);
      const recoveryActions = [...recoveryCatalog.actions];
      if (pendingJournal.plan.actions.some((action) => action.id === 'service.systemd')) {
        const recoveryProvider = createSystemdProviderForSetup({
          context,
          home,
          packaged: dependencies.buildInfo.packaged,
          distribution: dependencies.buildInfo.distribution,
          executablePath: dependencies.executablePath,
          ...(dependencies.runtimePath ? { runtimePath: dependencies.runtimePath } : {}),
          version: dependencies.buildInfo.version,
          agentExecutableDirectories: serviceAgentExecutableDirectories(context),
          agentExecutableOverrides: serviceAgentExecutableOverrides(context),
          factory: dependencies.systemdProviderFactory,
        });
        recoveryActions.unshift(createSystemdSetupAction(recoveryProvider, {
          desired: 'installed',
          enableLingering: false,
          lingeringAlreadyOwned: false,
        }));
      }
      if (pendingJournal.plan.actions.some((action) => action.id === 'network.tailscale-serve')) {
        const recoveredConfig = inspectBrokerConfig(home);
        const internalUrl = recoveredConfig.status === 'ok'
          ? recoveredConfig.config.broker.internalUrl
          : defaultBrokerConfig().broker.internalUrl;
        const recoveryProvider = createTailscaleProviderForSetup({
          context,
          internalUrl,
          factory: dependencies.tailscaleProviderFactory,
        });
        recoveryActions.push(createTailscaleServeSetupAction(recoveryProvider, { desired: 'installed' }));
      }
      recovered = await recoverSetupTransaction({
        home,
        actions: recoveryActions,
        commitAction: recoveryCatalog.commitAction,
      });
    } finally {
      lock.release();
    }
    if (recovered) {
      await dependencies.presenter.recoveredInterruptedTransaction(
        normalizeSetupLanguage(readSetupState(home).language) ?? DEFAULT_SETUP_LANGUAGE,
      );
    }
  }

  let inspection = await inspect({
    buildInfo: dependencies.buildInfo,
    executablePath: dependencies.executablePath,
    ...(dependencies.runtimePath ? { runtimePath: dependencies.runtimePath } : {}),
    home,
    context,
    systemdProviderFactory: dependencies.systemdProviderFactory,
  });
  // FIRST prompt, ahead of the intro panels: every panel below is copy, and copy needs a language before it
  // can be rendered. Cancelling here is a cancel like any other — nothing has been mutated yet.
  const language = await dependencies.presenter.chooseLanguage(inspection);
  if (language === SETUP_PROMPT_CANCELLED) return cancelled(dependencies, inspection, recovered, 'language choice');
  await dependencies.presenter.intro(inspection);
  if (inspection.blockingIssues.length > 0) {
    await dependencies.presenter.showBlockers(inspection.blockingIssues);
    const blocked = result({
      status: 'blocked',
      exitCode: 1,
      summaryCode: 'blocked-preflight',
      inspection,
      recovered,
      issues: inspection.blockingIssues,
    });
    await dependencies.presenter.failed(blocked);
    return blocked;
  }

  // Fold any flag intent (non-interactive presenter) into the stored choices so the committed-setup no-op
  // short-circuit below reflects `--install-opencode-shim`, `--no-install-agent-skill`, and the explicit
  // Tailscale Serve choice rather than silently dropping them. The interactive presenter omits
  // intendedChoices, so this is a pure stored re-run.
  const intended = dependencies.presenter.intendedChoices?.(inspection);
  // The just-chosen language folds in the same way: picking a new one on an already-committed install is a
  // real difference, so the no-op short-circuit below correctly stops short-circuiting and the choice gets
  // persisted through the normal transaction instead of a side write.
  const existingChoices: SetupChoices = {
    ...(intended
      ? {
          ...existingSetupChoices(inspection),
          installAgentSkill: intended.installAgentSkill,
          installOpencodeShim: intended.installOpencodeShim,
          tailscaleServe: intended.tailscaleServe,
        }
      : existingSetupChoices(inspection)),
    language,
  };
  const existingPlan = buildSetupPlan({ inspection, choices: existingChoices, now: dependencies.now });
  const legacyPiMigrationPending = inspection.agents.some((agent) => agent.id === 'pi' && agent.state === 'supported')
    && inspection.piBridge.status === 'legacy-marker';
  const legacyAgentSkillMigrationPending = existingChoices.installAgentSkill
    && inspection.agentSkills.some((target) => target.status === 'known-legacy');
  const existingBlockingIssues = existingPlan.blockingIssues.filter((issue) =>
    !(legacyAgentSkillMigrationPending && issue.code.endsWith('-known-legacy')));
  if (inspection.installState.committed && existingBlockingIssues.length > 0) {
    await dependencies.presenter.showBlockers(existingBlockingIssues);
    const blocked = result({
      status: 'blocked',
      exitCode: 1,
      summaryCode: 'blocked-committed-dependency',
      inspection,
      recovered,
      issues: existingBlockingIssues,
    });
    await dependencies.presenter.failed(blocked);
    return blocked;
  }
  if (inspection.installState.committed
      && existingPlan.noOp
      && !legacyPiMigrationPending
      && !legacyAgentSkillMigrationPending) {
    // A committed rerun is a no-op for the transaction, but not for Tokdash. Provisioning is post-commit and
    // best-effort, so a first run that failed — no pipx on the host, say — leaves consent recorded and
    // nothing provisioned, and exiting here meant the operator's retry, pipx now installed, never reached
    // it. Nothing is attempted unless consent is recorded and no completion marker proves this endpoint is
    // already done; the probe inside then reuses whatever is answering, so the common unchanged rerun still
    // installs nothing.
    const retried = existingChoices.quotaWarnings && tokdashProvisioningUnfinished(home, context)
      ? await (async () => {
        // Under the lock, like every other mutation: two concurrent setups must not both install Tokdash.
        // The record is re-read inside it because the check above raced with whoever holds it.
        const retryLock = acquireLock({ command: 'setup', home });
        try {
          if (!tokdashProvisioningUnfinished(home, context)) return undefined;
          return await runTokdashProvisioning({
            context,
            home,
            consented: true,
            ...(dependencies.tokdashRunner ? { runner: dependencies.tokdashRunner } : {}),
            ...(dependencies.now ? { now: dependencies.now } : {}),
          });
        } finally {
          retryLock.release();
        }
      })()
      : undefined;
    const complete = result({
      status: 'already-configured',
      exitCode: 0,
      summaryCode: 'already-configured',
      inspection,
      recovered,
      targetConfig: existingPlan.targetConfig,
      ...(retried ? { tokdash: retried } : {}),
    });
    await dependencies.presenter.complete(complete);
    return complete;
  }

  const managed = await dependencies.presenter.confirmManagedRuntime(inspection);
  if (managed === SETUP_PROMPT_CANCELLED) return cancelled(dependencies, inspection, recovered, 'managed-runtime acknowledgement');
  if (!managed) {
    const declined = result({
      status: 'declined',
      exitCode: 1,
      summaryCode: 'declined-managed-runtime',
      inspection,
      recovered,
    });
    await dependencies.presenter.failed(declined);
    return declined;
  }

  let replaceLegacyPiBridge = false;
  if (legacyPiMigrationPending) {
    const replaceLegacy = await (dependencies.presenter.confirmLegacyPiBridge?.(inspection) ?? false);
    if (replaceLegacy === SETUP_PROMPT_CANCELLED) {
      return cancelled(dependencies, inspection, recovered, 'legacy Pi bridge migration');
    }
    if (!replaceLegacy) {
      const declined = result({
        status: 'declined',
        exitCode: 1,
        summaryCode: 'declined-plan',
        inspection,
        recovered,
      });
      await dependencies.presenter.failed(declined);
      return declined;
    }
    replaceLegacyPiBridge = true;
  }

  const installAgentSkill = await dependencies.presenter.confirmAgentSkill(inspection);
  if (installAgentSkill === SETUP_PROMPT_CANCELLED) {
    return cancelled(dependencies, inspection, recovered, 'agent skill choice');
  }

  let upgradeLegacyAgentSkill = false;
  if (installAgentSkill && inspection.agentSkills.some((target) => target.status === 'known-legacy')) {
    const upgradeLegacy = await (dependencies.presenter.confirmLegacyAgentSkill?.(inspection) ?? false);
    if (upgradeLegacy === SETUP_PROMPT_CANCELLED) {
      return cancelled(dependencies, inspection, recovered, 'legacy agent skill migration');
    }
    if (!upgradeLegacy) {
      const declined = result({
        status: 'declined',
        exitCode: 1,
        summaryCode: 'declined-plan',
        inspection,
        recovered,
      });
      await dependencies.presenter.failed(declined);
      return declined;
    }
    upgradeLegacyAgentSkill = true;
  }

  const installOpencodeShim = await dependencies.presenter.confirmOpencodeShim(inspection);
  if (installOpencodeShim === SETUP_PROMPT_CANCELLED) {
    return cancelled(dependencies, inspection, recovered, 'opencode shim choice');
  }

  const service = await dependencies.presenter.chooseService(inspection);
  if (service === SETUP_PROMPT_CANCELLED) return cancelled(dependencies, inspection, recovered, 'service choice');
  // Lingering is no longer a separate question. Choosing the systemd service means wanting the broker to
  // survive logout and reboot, so the policy that delivers that is enabled with it rather than asked about
  // one prompt later. It remains separately RECEIPTED, so uninstall still only reverses what setup enabled.
  // launchd has no equivalent and keeps its documented divergence: the agent runs GUI login to logout.
  const lingering = service === 'systemd';
  const tailscale = await dependencies.presenter.confirmTailscale(inspection);
  if (tailscale === SETUP_PROMPT_CANCELLED) return cancelled(dependencies, inspection, recovered, 'Tailscale choice');
  const quota = await dependencies.presenter.confirmQuotaWarnings(inspection);
  if (quota === SETUP_PROMPT_CANCELLED) return cancelled(dependencies, inspection, recovered, 'quota-warning choice');
  const choices: SetupChoices = {
    language,
    service,
    enableLingering: lingering,
    tailscaleServe: tailscale,
    quotaWarnings: quota,
    installAgentSkill,
    installOpencodeShim,
    replaceLegacyPiBridge,
    upgradeLegacyAgentSkill,
  };
  const plan = buildSetupPlan({ inspection, choices, now: dependencies.now });
  if (plan.blockingIssues.length > 0) {
    await dependencies.presenter.showBlockers(plan.blockingIssues);
    const blocked = result({
      status: 'blocked',
      exitCode: 1,
      summaryCode: 'blocked-unsafe-plan',
      inspection,
      recovered,
      issues: plan.blockingIssues,
    });
    await dependencies.presenter.failed(blocked);
    return blocked;
  }
  await dependencies.presenter.showPlan(plan, inspection);
  const confirmed = await dependencies.presenter.confirmApply(plan);
  if (confirmed === SETUP_PROMPT_CANCELLED) return cancelled(dependencies, inspection, recovered, 'final confirmation');
  if (!confirmed) {
    const declined = result({
      status: 'declined',
      exitCode: 1,
      summaryCode: 'declined-plan',
      inspection,
      recovered,
    });
    await dependencies.presenter.failed(declined);
    return declined;
  }

  const lock = acquireLock({ command: 'setup', home });
  try {
    inspection = await inspect({
      buildInfo: dependencies.buildInfo,
      executablePath: dependencies.executablePath,
      ...(dependencies.runtimePath ? { runtimePath: dependencies.runtimePath } : {}),
      home,
      context,
      systemdProviderFactory: dependencies.systemdProviderFactory,
    });
    const lockedPlan = buildSetupPlan({
      inspection,
      choices,
      acknowledgedAt: plan.acknowledgedAt,
      now: dependencies.now,
    });
    if (lockedPlan.transaction.id !== plan.transaction.id || lockedPlan.blockingIssues.length > 0) {
      const changed = result({
        status: 'blocked',
        exitCode: 1,
        summaryCode: 'precondition-changed',
        inspection,
        recovered,
        issues: lockedPlan.blockingIssues.length ? lockedPlan.blockingIssues : [{
          code: 'setup-preconditions-changed',
          summary: 'Setup inputs changed after confirmation.',
          remediation: 'Rerun setup and review the refreshed mutation plan.',
        }],
      });
      await dependencies.presenter.failed(changed);
      return changed;
    }
    const inputs = actionInputs({
      inspection,
      plan: lockedPlan,
      context,
      buildInfo: dependencies.buildInfo,
      executablePath: dependencies.executablePath,
      aliasPath,
      now: dependencies.now,
    });
    const catalog = catalogFactory(inputs);
    const hasSystemdAction = lockedPlan.actions.some((action) => action.id === 'service.systemd');
    const systemdProvider = (hasSystemdAction || durableServiceChoice(lockedPlan.choices))
      ? createSystemdProviderForSetup({
          context,
          home,
          packaged: dependencies.buildInfo.packaged,
          distribution: dependencies.buildInfo.distribution,
          executablePath: dependencies.executablePath,
          ...(dependencies.runtimePath ? { runtimePath: dependencies.runtimePath } : {}),
          version: dependencies.buildInfo.version,
          agentExecutableDirectories: inspection.agentExecutableDirectories,
          agentExecutableOverrides: inspection.agentExecutableOverrides,
          factory: dependencies.systemdProviderFactory,
        })
      : undefined;
    const hasTailscaleAction = lockedPlan.actions.some((action) => action.id === 'network.tailscale-serve');
    const tailscaleProvider = hasTailscaleAction
      ? createTailscaleProviderForSetup({
          context,
          internalUrl: lockedPlan.targetConfig.broker.internalUrl,
          executablePath: inspection.tailscale.executablePath,
          factory: dependencies.tailscaleProviderFactory,
        })
      : undefined;
    const transactionActions = [...catalog.actions];
    if (systemdProvider && hasSystemdAction) {
      transactionActions.unshift(createSystemdSetupAction(systemdProvider, {
        desired: durableServiceChoice(lockedPlan.choices) ? 'installed' : 'absent',
        enableLingering: lockedPlan.choices.enableLingering,
        lingeringAlreadyOwned: systemdOwnership(inspection).lingering,
      }));
    }
    if (tailscaleProvider) {
      transactionActions.push(createTailscaleServeSetupAction(tailscaleProvider, {
        desired: lockedPlan.choices.tailscaleServe ? 'installed' : 'absent',
      }));
    }
    await executeSetupTransaction({
      home,
      plan: lockedPlan.transaction,
      actions: transactionActions,
      commitAction: catalog.commitAction,
      verifyAll: () => verifySetup({ plan: lockedPlan, inspection, context }),
      ...(systemdProvider && durableServiceChoice(lockedPlan.choices) ? {
        verifyCommitted: async () => {
          const serviceReady = await startAndVerifySystemdService({
            provider: systemdProvider,
            context,
            internalUrl: lockedPlan.targetConfig.broker.internalUrl,
            // The unit execs the home copy this transaction just wrote, so the responder must report THIS
            // artifact. Without that binding a surviving previous-build process answers `ok: true` on the
            // same port and setup reports a verified install of a binary nothing is running. The whole
            // BuildInfo goes in because no single field identifies an artifact — see `buildFingerprint`.
            expectedBuild: dependencies.buildInfo,
            attempts: dependencies.serviceHealthAttempts,
          });
          if (!serviceReady.ok) return serviceReady;
          if (!lockedPlan.choices.tailscaleServe) return true;
          const advertisedUrl = lockedPlan.targetConfig.broker.advertisedUrl;
          // Read this node's own Tailscale addresses so verification survives a host whose MagicDNS
          // resolution is broken. They are only ever consulted after the advertised NAME fails to
          // connect; a name that answers wrongly is a verification failure, not a lookup problem.
          const injected = dependencies.advertisedEndpointVerification;
          const fallbackAddresses = injected?.fallbackAddresses
            ?? (inspection.tailscale.executablePath
              ? await resolveTailscaleAddresses({
                  context,
                  executablePath: inspection.tailscale.executablePath,
                })
              : []);
          const advertisedReachable = !!advertisedUrl && await verifyAdvertisedBrokerEndpoint({
            ...(injected ?? {}),
            context,
            advertisedUrl,
            machineLabel: lockedPlan.targetConfig.broker.machineLabel,
            fallbackAddresses,
          });
          return advertisedReachable ? true : {
            ok: false,
            detail: advertisedUrl
              ? `the private Tailscale endpoint ${advertisedUrl} did not answer as this broker`
              : 'the plan requested a Tailscale Serve route but produced no advertised URL to verify',
          };
        },
      } : {}),
      now: dependencies.now,
    });
    // Optional work, deliberately AFTER the commit. The transaction is all-or-nothing: an in-transaction
    // Tokdash step that failed would roll back a broker install that is otherwise complete and verified, and
    // what it mutates (pipx's state, Tokdash's own service) is not something the file-snapshot rollback can
    // restore anyway. So it runs here, reports its outcome instead of throwing, and never touches
    // `status` or `exitCode`.
    const tokdash = await runTokdashProvisioning({
      context,
      home,
      consented: lockedPlan.choices.quotaWarnings,
      ...(dependencies.tokdashRunner ? { runner: dependencies.tokdashRunner } : {}),
      ...(dependencies.now ? { now: dependencies.now } : {}),
    });
    const complete = result({
      status: 'complete',
      exitCode: 0,
      tokdash,
      summaryCode: inspection.agents.every((agent) => agent.state === 'missing')
        ? 'complete-no-agents'
        : 'complete',
      inspection,
      recovered,
      targetConfig: lockedPlan.targetConfig,
      // The durable-service branch above wires `verifyCommitted`, which starts the service and health-checks
      // it; reaching here means that check passed. A foreground choice runs no such check and starts nothing,
      // so it is NOT proof and the outro must send the operator to start the broker itself.
      brokerVerified: durableServiceChoice(lockedPlan.choices),
      actions: lockedPlan.actions.map((action) => action.id),
    });
    await dependencies.presenter.complete(complete);
    return complete;
  } catch (error) {
    const rollbackIncomplete = error instanceof SetupTransactionError && error.code === 'rollback-failed';
    // The diagnostic is read back rather than reconstructed: what the operator is told is exactly what was
    // persisted, so a bug report quoting the terminal and a bug report quoting the file cannot disagree.
    const failure = failureReport(home, plan);
    const failed = result({
      status: 'failed',
      exitCode: rollbackIncomplete ? 4 : 3,
      // Setup owns its own journal: the next `setup` run rolls the remainder back before replanning.
      // `repair` reconciles committed state and has never consumed setup journals, so pointing there was a
      // dead end — it reported "already matches declared state" and left the transaction pending.
      summaryCode: rollbackIncomplete ? 'failed-cleanup-remains' : 'failed-rolled-back',
      inspection,
      recovered,
      ...(failure ? { failure } : {}),
    });
    await dependencies.presenter.failed(failed);
    return failed;
  } finally {
    lock.release();
  }
}
