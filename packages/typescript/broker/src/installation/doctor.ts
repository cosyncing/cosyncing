import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve, win32 } from 'node:path';
import type {
  AgentBackend,
  AgentSetupDiagnosis,
  SetupCheck,
  SetupDiagnosisContext,
  SetupCheckStatus,
} from '@cosyncing/adapter-api';
import { INTERNAL_AGENT_ROSTER_PATH, PRODUCT_IDENTITY } from '@cosyncing/adapter-api';
import type { BuildInfo } from '../runtime/build-info.ts';
import {
  BUN_RUNTIME_OVERRIDE_VARIABLE,
  currentApplicationIdentity,
  MINIMUM_BUN_RUNTIME_VERSION,
  type ApplicationIdentity,
} from '../runtime/application-identity.ts';
import {
  inspectBrokerConfig,
  resolveBrokerConfiguration,
  type BrokerConfigInspection,
} from '../runtime/configuration.ts';
import {
  inspectBrokerToken,
  inspectPiIntegration,
  readBrokerToken,
} from '../security/credentials.ts';
import { durableStateLayout, inspectDurableSchemas } from '../security/durable-state.ts';
import {
  inspectInstallState,
  installedBinaryPath,
  type InstalledResourceRecord,
  type InstallStateInspection,
} from './install-state.ts';
import { serviceFlutterWebRoot, type RuntimeAssetReport } from '../runtime/runtime-assets.ts';
import { readSetupState, setupStateHome } from './setup-state.ts';
import { isSupportedBrokerHost, supportedBrokerHostList } from './supported-hosts.ts';
import { shippedAdapters } from './shipped-adapters.ts';
import { brokerManagedHostIdentities } from './managed-host-posture.ts';
import { inspectOwnerOnlyDirectory, inspectOwnerOnlyFile } from '../security/secure-files.ts';
import {
  inspectAgentSkills,
  AGENT_SKILL_SHA256,
} from './agent-skill.ts';
import {
  durableServiceProviderId,
  createDurableServiceProvider,
  parseLaunchdPrintState,
  resolveServiceAgentExecutables,
  serviceAgentExecutableDirectories,
  serviceAgentExecutableOverrides,
  servicePathEntries,
  servicePathMatchesExpected,
  serviceDefinitionResourceId,
  SERVICE_AGENT_EXECUTABLE_OVERRIDE_NAMES,
  LAUNCHD_SERVICE_LABEL,
  SYSTEMD_SERVICE_NAME,
  type DurableServiceProviderId,
} from './service-manager.ts';
import {
  inspectCodexTuiReadiness,
  type CodexTuiReadinessReport,
} from '@cosyncing/adapter-codex/tui-presence';
import { readSetupFailureDiagnostic, setupFailureDiagnosticPath } from './setup-transaction.ts';
import { cliMessages } from '../cli/cli-i18n.ts';
import type { SetupLanguage } from './setup-i18n.ts';
import { diagnoseManagedRuntimeFailure } from '../runtime/managed-runtime-state.ts';
import {
  classifyManagedHost,
  defaultManagedHostEffects,
  listManagedHostOwnerships,
  locateRecordedManagedHost,
} from '../runtime/managed-host.ts';
import { inspectPiBridgeOwnership } from './pi-bridge-ownership.ts';
import { parseMachinePeers } from '../roster/machine-aggregation.ts';
import { WindowsTaskSchedulerPowerShellBackend } from './windows-task-scheduler-powershell.ts';
import { parseWindowsServiceEnvironment, windowsServiceVersionKey } from './windows-service-install.ts';

export const DOCTOR_REPORT_SCHEMA_VERSION = 1 as const;

/**
 * The service-manager availability check id, per durable provider. It is per-provider (rather than one shared
 * id) because the line is rendered verbatim to the operator, and telling a macOS user their `systemd-user`
 * manager is fine — or missing — is the exact dishonesty this split exists to prevent.
 */
export const DURABLE_SERVICE_CHECK_ID: Readonly<Record<DurableServiceProviderId, string>> = Object.freeze({
  systemd: 'service.systemd-user',
  launchd: 'service.launchd-user',
  'task-scheduler': 'service.task-scheduler',
});

export interface DoctorSection {
  id: 'package' | 'state' | 'agents' | 'host' | 'service' | 'network' | 'runtime';
  title: string;
  checks: SetupCheck[];
}

export interface DoctorReport {
  schemaVersion: typeof DOCTOR_REPORT_SCHEMA_VERSION;
  product: typeof PRODUCT_IDENTITY.productName;
  version: string;
  effects: 'forbidden';
  ok: boolean;
  summary: Record<SetupCheckStatus, number>;
  minimumVersions: Array<{
    agent: string;
    displayName: string;
    version: string;
    requiredFeature: string;
    evidenceUrl: string;
    evidenceNote: string;
  }>;
  sections: DoctorSection[];
}

export interface DoctorDependencies {
  buildInfo: Readonly<BuildInfo>;
  context: SetupDiagnosisContext;
  assetReport: RuntimeAssetReport;
  adapters?: readonly AgentBackend[];
  stateHome?: string;
  codexTuiReadiness?: Readonly<CodexTuiReadinessReport>;
  /**
   * This process's artifact and runtime. Injected so fixtures can pose as a JavaScript install whose Bun has
   * moved or vanished — states a test host running a source checkout can never reach on its own.
   */
  applicationIdentity?: Readonly<ApplicationIdentity>;
}

function remediation(command: string, message: string): SetupCheck['remediation'] {
  return { kind: 'command', command, message };
}

/**
 * Convert the process-level readiness probe into the stable public doctor contract.
 * Raw PIDs, socket paths, and probe messages intentionally stop at this boundary.
 */
export function codexTuiReadinessCheck(
  report: Readonly<CodexTuiReadinessReport>,
): SetupCheck {
  switch (report.status) {
    case 'ok':
      return {
        id: 'codex.terminal-readiness',
        status: 'pass',
        detailCode: 'terminal-readiness-shared',
        summary: 'All detected Codex terminals are attached to the shared server.',
      };
    case 'restart-required': {
      // New readiness reports preserve the true count separately from the capped PID diagnostics.
      // Keep accepting older injected reports that only supplied the PID list.
      const count = report.staleCandidateCount ?? report.staleCandidatePids.length;
      return {
        id: 'codex.terminal-readiness',
        status: 'warn',
        detailCode: 'terminal-restart-required',
        summary: `${count} already-running Codex terminal${count === 1 ? '' : 's'} must be reopened to join the shared server.`,
        evidence: { count, customSocket: report.customSocket },
        remediation: {
          kind: 'manual',
          message: report.customSocket
            ? 'Close and reopen those terminals with the generated custom remote command; use Resume to keep their threads.'
            : 'Close and reopen those terminals; new Codex terminals connect to the shared server automatically.',
        },
      };
    }
    case 'unknown':
      return {
        id: 'codex.terminal-readiness',
        status: 'warn',
        detailCode: 'terminal-readiness-inconclusive',
        summary: 'Codex terminal attachment could not be confirmed safely.',
        remediation: { kind: 'manual', message: 'Rerun doctor after Codex and the broker settle; use the generated Resume command if needed.' },
      };
    case 'daemon-unavailable':
      return {
        id: 'codex.terminal-readiness',
        status: 'warn',
        detailCode: 'terminal-readiness-daemon-unavailable',
        summary: 'Codex terminal readiness is unavailable because the shared server is not running.',
        remediation: remediation('cosyncing repair', 'Start or reconcile the managed Codex shared server.'),
      };
    case 'unsupported':
      return {
        id: 'codex.terminal-readiness',
        status: 'skip',
        detailCode: 'terminal-readiness-platform-unsupported',
        summary: 'Codex terminal readiness inspection is unavailable on this platform.',
      };
  }
}

function safeCodexTuiReadiness(context: SetupDiagnosisContext): CodexTuiReadinessReport {
  try {
    return inspectCodexTuiReadiness({
      env: context.env,
      platform: context.platform as NodeJS.Platform,
    });
  } catch {
    return {
      status: 'unknown',
      customSocket: false,
      staleCandidatePids: [],
      message: 'Codex terminal readiness inspection failed safely.',
    };
  }
}

function assetChecks(report: RuntimeAssetReport): SetupCheck[] {
  return report.checks.map((check) => ({
    id: `package.${check.id}`,
    status: check.status === 'ok' ? 'pass' : check.required ? 'fail' : 'skip',
    detailCode: `asset-${check.status}`,
    summary: check.status === 'ok'
      ? `${check.id} is present and verified.`
      : check.required
        ? `${check.id} failed package verification.`
        : `${check.id} is not part of the required v1 package.`,
    evidence: { required: check.required },
    ...(check.status === 'ok' || !check.required ? {} : {
      remediation: remediation('cosyncing repair', 'Repair or reinstall the packaged runtime assets.'),
    }),
  }));
}

/**
 * The interpreter path the INSTALLED service definition actually names, read from the file itself.
 *
 * Comparing the whole unit against its expected rendering already detects drift, but it can only say "the
 * definition changed" — and after a Bun move that message sends an operator looking at the wrong thing. The
 * launch command is the one field worth naming separately, so it is extracted here and nowhere else.
 *
 * Both service managers write the same argv in their own syntax, so both are read: three arguments means a
 * runtime is named, two means the application is its own runtime. Anything else is left unanswered rather
 * than guessed.
 */
function recordedServiceRuntimePath(definitionPath: string, provider: DurableServiceProviderId): string | undefined {
  if (provider === 'task-scheduler') return undefined;
  if (inspectOwnerOnlyFile(definitionPath).status !== 'ok') return undefined;
  let content: string;
  try {
    content = readFileSync(definitionPath, 'utf8');
  } catch {
    return undefined;
  }
  if (provider === 'systemd') {
    const execStart = content.split('\n').find((line) => line.startsWith('ExecStart='));
    if (!execStart) return undefined;
    const quoted = [...execStart.slice('ExecStart='.length).matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((match) => match[1]!.replaceAll('\\"', '"').replaceAll('\\\\', '\\'));
    return quoted.length === 3 ? quoted[0] : undefined;
  }
  const argumentsBlock = content.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!argumentsBlock) return undefined;
  const entries = [...argumentsBlock[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)]
    .map((match) => match[1]!.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
  return entries.length === 3 ? entries[0] : undefined;
}

/**
 * The interpreter this build cannot run without, and the service unit's recorded copy of it.
 *
 * The published JavaScript application carries no runtime: Bun is a separate installation the operator owns,
 * and it can be upgraded in place, moved by a version manager, or removed entirely long after setup wrote a
 * unit naming an absolute path. Those three outcomes are genuinely different — in place is fine, moved is
 * repairable, removed is not — so this reports them as three different answers rather than one "service
 * failed to start", which is all the operator would otherwise see.
 *
 * A compiled native build embeds its runtime and legitimately has nothing to check, so it skips.
 */
/**
 * One summary per way the runtime can be unusable.
 *
 * These are genuinely different operator actions — install Bun, fix the override variable, upgrade Bun — so
 * collapsing them into a single "runtime unavailable" would tell an operator with a stale Bun to reinstall
 * something they already have.
 */
function runtimeProblemSummary(detailCode?: string): string {
  switch (detailCode) {
    case 'bun-runtime-outdated':
      return `The Bun runtime is older than ${PRODUCT_IDENTITY.productName} requires.`;
    case 'bun-runtime-probe-failed':
    case 'bun-runtime-unrecognized':
      return 'The configured runtime did not identify itself as Bun.';
    case 'bun-runtime-override-invalid':
    case 'bun-runtime-override-unusable':
      return `${BUN_RUNTIME_OVERRIDE_VARIABLE} does not name a usable Bun runtime.`;
    default:
      return `${PRODUCT_IDENTITY.productName} could not resolve the Bun runtime that must execute it.`;
  }
}

function applicationRuntimeCheck(options: {
  identity: Readonly<ApplicationIdentity>;
  serviceRuntimePath?: string;
}): SetupCheck {
  const id = 'package.runtime';
  if (options.identity.distribution === 'native') {
    return {
      id,
      status: 'skip',
      detailCode: 'runtime-embedded',
      summary: 'This build embeds its own runtime, so no external interpreter is required.',
    };
  }
  if (!options.identity.runtimePath) {
    const problem = options.identity.runtimeProblem;
    return {
      id,
      status: 'fail',
      detailCode: problem?.detailCode ?? 'runtime-unresolved',
      // A fixed summary per detail code, with the raw message as evidence. The messages name paths and
      // versions, so using them directly as the summary would leave the Chinese CLI printing English on
      // exactly the hosts where something is already wrong.
      summary: runtimeProblemSummary(problem?.detailCode),
      ...(problem ? { evidence: { problem: problem.message } } : {}),
      remediation: {
        kind: 'manual',
        message: 'Install a supported Bun runtime, then rerun `cosyncing setup`.',
      },
    };
  }
  // The unit records an absolute interpreter. If Bun now lives somewhere else, the unit still names the old
  // path and the service cannot start — but everything is recoverable, because repair rewrites the unit with
  // the runtime executing this command. Saying so is the whole point of separating this from a bare failure.
  if (options.serviceRuntimePath && resolve(options.serviceRuntimePath) !== resolve(options.identity.runtimePath)) {
    return {
      id,
      status: 'fail',
      detailCode: 'runtime-path-drifted',
      summary: `The installed service runs ${options.serviceRuntimePath}, but ${PRODUCT_IDENTITY.productName} is `
        + `now executed by ${options.identity.runtimePath}; the service cannot start until the unit is rewritten.`,
      evidence: { serviceRuntime: options.serviceRuntimePath, currentRuntime: options.identity.runtimePath },
      remediation: remediation('cosyncing repair', 'Rewrite the service definition with the current runtime path.'),
    };
  }
  return {
    id,
    status: 'pass',
    detailCode: 'runtime-available',
    summary: 'The Bun runtime this build requires is installed and executable.',
    evidence: {
      runtime: options.identity.runtimePath,
      ...(options.identity.runtimeVersion ? { version: options.identity.runtimeVersion } : {}),
      minimum: MINIMUM_BUN_RUNTIME_VERSION,
    },
  };
}

function configCheck(inspection: BrokerConfigInspection, context: SetupDiagnosisContext): SetupCheck {
  if (inspection.status === 'ok') {
    return {
      id: 'state.config',
      status: 'pass',
      detailCode: 'config-valid',
      summary: 'Broker configuration is valid.',
      evidence: { path: context.displayPath(inspection.path), schemaVersion: inspection.config.schemaVersion },
    };
  }
  if (inspection.status === 'missing') {
    return {
      id: 'state.config',
      status: 'fail',
      detailCode: 'config-missing',
      summary: 'Broker configuration is missing.',
      evidence: { path: context.displayPath(inspection.path) },
      remediation: remediation('cosyncing setup', 'Create validated broker configuration through setup.'),
    };
  }
  return {
    id: 'state.config',
    status: 'fail',
    detailCode: inspection.detailCode,
    summary: 'Broker configuration is unsafe, malformed, unsupported, or requires migration.',
    evidence: { path: context.displayPath(inspection.path) },
    remediation: remediation('cosyncing repair', 'Inspect, migrate, or repair broker configuration.'),
  };
}

function credentialCheck(options: {
  id: string;
  label: string;
  inspection: ReturnType<typeof inspectBrokerToken>;
  context: SetupDiagnosisContext;
}): SetupCheck {
  const inspection = options.inspection;
  if (inspection.status === 'ok') {
    return {
      id: options.id,
      status: 'pass',
      detailCode: inspection.detailCode,
      summary: `${options.label} is valid and owner-only.`,
      evidence: { path: options.context.displayPath(inspection.path) },
    };
  }
  return {
    id: options.id,
    status: 'fail',
    detailCode: inspection.detailCode,
    summary: `${options.label} is missing, unsafe, unreadable, or malformed.`,
    evidence: { path: options.context.displayPath(inspection.path) },
    remediation: remediation(
      inspection.status === 'missing' ? 'cosyncing setup' : 'cosyncing repair',
      inspection.status === 'missing' ? `Create ${options.label} through setup.` : `Repair or rotate ${options.label}.`,
    ),
  };
}

function durableChecks(
  home: string,
  context: SetupDiagnosisContext,
): SetupCheck[] {
  const cacheRoot = context.env.COSYNCING_CACHE_DIR?.trim()
    || join(context.homeDir, '.cache', PRODUCT_IDENTITY.cacheDirectoryName);
  return inspectDurableSchemas(durableStateLayout({ stateRoot: home, cacheRoot })).map((inspection) => {
    if (inspection.status === 'ok') {
      return {
        id: `state.schema.${inspection.id}`,
        status: 'pass',
        detailCode: inspection.detailCode,
        summary: `${inspection.id} state schema is current.`,
        evidence: { version: inspection.version ?? 1 },
      } satisfies SetupCheck;
    }
    if (inspection.status === 'missing') {
      return {
        id: `state.schema.${inspection.id}`,
        status: 'skip',
        detailCode: inspection.detailCode,
        summary: `${inspection.id} state has not been created yet.`,
      } satisfies SetupCheck;
    }
    return {
      id: `state.schema.${inspection.id}`,
      status: inspection.status === 'migration-required' ? 'warn' : 'fail',
      detailCode: inspection.detailCode,
      summary: `${inspection.id} state requires repair or migration.`,
      remediation: remediation('cosyncing repair', 'Back up and reconcile durable state.'),
    } satisfies SetupCheck;
  });
}

function durableDirectoryChecks(home: string, context: SetupDiagnosisContext): SetupCheck[] {
  const cacheRoot = context.env.COSYNCING_CACHE_DIR?.trim()
    || join(context.homeDir, '.cache', PRODUCT_IDENTITY.cacheDirectoryName);
  const layout = durableStateLayout({ stateRoot: home, cacheRoot });
  const directories = [
    { id: 'state-root', path: layout.stateRoot },
    { id: 'secrets', path: join(layout.stateRoot, 'secrets') },
    { id: 'transport-keys', path: layout.transportKeys },
    { id: 'cache-root', path: layout.cacheRoot },
    { id: 'artifact-blobs', path: layout.artifactBlobs },
    { id: 'backups', path: layout.backups },
  ] as const;
  return directories.map(({ id, path }) => {
    const inspection = inspectOwnerOnlyDirectory(path);
    if (inspection.status === 'ok') {
      return {
        id: `state.directory.${id}`,
        status: 'pass',
        detailCode: `${id}-directory-owner-only`,
        summary: `${id} directory is owner-only.`,
        evidence: { path: context.displayPath(path) },
      } satisfies SetupCheck;
    }
    if (inspection.status === 'missing') {
      return {
        id: `state.directory.${id}`,
        status: 'skip',
        detailCode: `${id}-directory-missing`,
        summary: `${id} directory has not been created yet.`,
      } satisfies SetupCheck;
    }
    return {
      id: `state.directory.${id}`,
      status: 'fail',
      detailCode: `${id}-directory-${inspection.problem ?? inspection.status}`,
      summary: `${id} directory is not owner-only.`,
      evidence: { path: context.displayPath(path) },
      remediation: remediation('cosyncing repair', `Repair the ${id} directory security.`),
    } satisfies SetupCheck;
  });
}

function environmentPrecedenceCheck(options: {
  packaged: boolean;
  home: string;
  context: SetupDiagnosisContext;
}): SetupCheck {
  try {
    const effective = resolveBrokerConfiguration({
      packaged: options.packaged,
      home: options.home,
      env: options.context.env as NodeJS.ProcessEnv,
    });
    return {
      id: 'state.environment-precedence',
      status: effective.environmentOverrides.length > 0 ? 'warn' : 'pass',
      detailCode: effective.environmentOverrides.length > 0 ? 'environment-overrides-active' : 'configuration-precedence-clean',
      summary: effective.environmentOverrides.length > 0
        ? 'Source-development environment overrides take precedence over stored configuration.'
        : 'No source-development environment override changes effective broker configuration.',
      ...(effective.environmentOverrides.length > 0
        ? { evidence: { overrideNames: effective.environmentOverrides.join(',') } }
        : {}),
      ...(effective.environmentOverrides.length > 0
        ? { remediation: { kind: 'manual', message: 'Remove stale development overrides before validating packaged behavior.' } as const }
        : {}),
    };
  } catch (error) {
    return {
      id: 'state.environment-precedence',
      status: 'fail',
      detailCode: 'effective-configuration-invalid',
      summary: error instanceof Error ? error.message : 'Effective broker configuration is invalid.',
      remediation: remediation('cosyncing repair', 'Repair configuration before starting the broker.'),
    };
  }
}

export function machinePeerCredentialCheck(context: SetupDiagnosisContext): SetupCheck {
  const raw = context.env.COSYNCING_MACHINE_PEERS?.trim() ?? '';
  if (!raw) {
    return {
      id: 'state.machine-peer-credentials',
      status: 'skip',
      detailCode: 'machine-peers-not-configured',
      summary: 'No machine peers are configured.',
    };
  }
  try {
    const peers = parseMachinePeers(raw);
    const tokenless = peers.filter((peer) => !peer.token && !peer.credential);
    if (tokenless.length === 0) {
      return {
        id: 'state.machine-peer-credentials',
        status: 'pass',
        detailCode: 'machine-peer-credentials-configured',
        summary: 'Every machine peer has an explicit credential.',
        evidence: { peerCount: peers.length },
      };
    }
    return {
      id: 'state.machine-peer-credentials',
      status: 'warn',
      detailCode: 'machine-peer-authentication-required',
      summary: 'One or more machine peers have no credential and will stop aggregating after that peer upgrades to contract revision 16.',
      evidence: { peerCount: peers.length, tokenlessPeerCount: tokenless.length },
      remediation: {
        kind: 'manual',
        message: 'Add a broker-token or revocable peer-token credential to each COSYNCING_MACHINE_PEERS entry.',
      },
    };
  } catch {
    return {
      id: 'state.machine-peer-credentials',
      status: 'fail',
      detailCode: 'machine-peer-configuration-invalid',
      summary: 'COSYNCING_MACHINE_PEERS is invalid.',
      remediation: { kind: 'manual', message: 'Repair COSYNCING_MACHINE_PEERS before starting or upgrading the broker.' },
    };
  }
}

function isWsl(context: SetupDiagnosisContext): boolean {
  if (context.platform !== 'linux') return false;
  if (context.env.WSL_DISTRO_NAME?.trim() || context.env.WSL_INTEROP?.trim()) return true;
  const release = context.readText('/proc/sys/kernel/osrelease', 4_096);
  return release.ok && /microsoft|wsl/i.test(release.text);
}

function hostChecks(context: SetupDiagnosisContext, arch: string): { checks: SetupCheck[]; wsl: boolean } {
  const wsl = isWsl(context);
  let host: SetupCheck;
  if (context.platform === 'linux' || context.platform === 'darwin') {
    // The architecture is probed now, which it never used to be.
    //
    // It did not have to be while every distribution was a compiled per-target binary: an Intel Mac had no
    // artifact to install, so it could not reach this check with a packaged build at all. One universal
    // JavaScript bundle runs wherever a supported Bun runs, so the absence of an artifact no longer refuses
    // anything, and an unverified host would otherwise be told it is supported.
    if (!isSupportedBrokerHost(context.platform, arch)) {
      host = {
        id: 'host.platform',
        status: 'fail',
        detailCode: 'host-architecture-unsupported',
        summary: `${context.platform}-${arch} is not a supported ${PRODUCT_IDENTITY.productName} broker host.`,
        evidence: { platform: context.platform, arch, supported: supportedBrokerHostList() },
        remediation: {
          kind: 'manual',
          message: 'Run the broker on a supported host: linux-x64, linux-arm64, or darwin-arm64.',
        },
      };
      return { checks: [host], wsl };
    }
    host = context.platform === 'linux'
      ? {
        id: 'host.platform',
        status: 'pass',
        detailCode: wsl ? 'linux-wsl-supported' : 'linux-supported',
        summary: wsl ? 'WSL is supported through the declared Linux subset.' : 'Linux is a supported v1 broker host.',
        evidence: { platform: wsl ? 'linux-wsl' : 'linux', arch },
      }
      : {
        id: 'host.platform',
        status: 'pass',
        detailCode: 'macos-supported',
        summary: 'macOS on Apple Silicon is a supported broker host.',
        evidence: { platform: 'darwin', arch },
      };
  } else {
    host = {
      id: 'host.platform',
      status: 'fail',
      detailCode: 'native-windows-not-v1',
      summary: 'Native Windows broker hosting is a named near-term follow-up, not part of v1.',
      remediation: { kind: 'manual', message: 'Run the broker inside the supported WSL subset.' },
    };
  }
  return { checks: [host], wsl };
}

/**
 * launchd availability. The GUI domain is what a LaunchAgent is bootstrapped into, so the check is simply
 * whether `launchctl` can print that domain. There is no daemon to "not be running" the way a systemd user
 * manager can be, so the only failure worth reporting is an unusable launchctl.
 */
async function launchdServiceChecks(context: SetupDiagnosisContext): Promise<SetupCheck[]> {
  const id = DURABLE_SERVICE_CHECK_ID.launchd;
  const launchctl = context.resolveExecutable('launchctl');
  if (!launchctl) {
    return [{
      id,
      status: 'skip',
      detailCode: 'launchctl-unavailable',
      summary: 'launchctl is not on PATH, so the launchd user domain cannot be inspected; foreground mode remains supported.',
      remediation: remediation(`${PRODUCT_IDENTITY.primaryBinary} broker`, 'Run the broker in the foreground on this host.'),
    }];
  }
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '';
  const probe = /^\d{1,10}$/.test(uid)
    ? await context.runReadOnly(launchctl, ['print', `gui/${uid}`])
    : undefined;
  if (probe?.status === 'ok') {
    return [{
      id,
      status: 'pass',
      detailCode: 'launchd-user-ready',
      summary: 'The launchd GUI user domain is available.',
      evidence: { executable: context.displayPath(launchctl), domain: 'gui' },
    }];
  }
  return [{
    id,
    status: 'warn',
    detailCode: 'launchd-user-unavailable',
    summary: 'The launchd GUI user domain could not be inspected; foreground mode remains supported.',
    remediation: remediation(`${PRODUCT_IDENTITY.primaryBinary} broker`, 'Sign in to a macOS GUI session for service mode, or run the broker in the foreground.'),
  }];
}

async function serviceChecks(context: SetupDiagnosisContext, wsl: boolean): Promise<SetupCheck[]> {
  const provider = durableServiceProviderId(context.platform);
  if (provider === 'launchd') return launchdServiceChecks(context);
  if (provider === 'task-scheduler') {
    try {
      const sid = new WindowsTaskSchedulerPowerShellBackend().currentUserSid();
      return [{
        id: DURABLE_SERVICE_CHECK_ID['task-scheduler'],
        status: 'pass',
        detailCode: 'task-scheduler-user-ready',
        summary: 'The Task Scheduler per-user COM API is available.',
        evidence: { principal: sid ? 'current-user-sid' : 'unknown' },
      }];
    } catch {
      return [{
        id: DURABLE_SERVICE_CHECK_ID['task-scheduler'],
        status: 'fail',
        detailCode: 'task-scheduler-user-unavailable',
        summary: 'The Task Scheduler per-user COM API is unavailable.',
        remediation: { kind: 'manual', message: 'Restore Windows Task Scheduler before persistent broker setup.' },
      }];
    }
  }
  const systemctl = context.resolveExecutable('systemctl');
  if (!systemctl) {
    return [{
      id: 'service.systemd-user',
      status: wsl ? 'warn' : 'fail',
      detailCode: wsl ? 'wsl-foreground-only' : 'systemctl-missing',
      summary: wsl
        ? 'WSL systemd is unavailable; foreground broker mode remains supported.'
        : 'systemd user-service tooling is unavailable.',
      remediation: wsl
        ? remediation('cosyncing broker', 'Run the broker in the foreground, or enable WSL systemd for persistence.')
        : { kind: 'manual', message: 'Install/enable a systemd user manager before service setup.' },
    }];
  }
  const status = await context.runReadOnly(systemctl, ['--user', 'is-system-running']);
  const reportedState = `${status.stdout}\n${status.stderr}`.trim().split(/\s+/)[0]?.toLowerCase() || '';
  const state = ['running', 'degraded', 'starting', 'maintenance', 'stopping', 'offline'].includes(reportedState)
    ? reportedState
    : 'unknown';
  if (state === 'running' || state === 'degraded') {
    return [{
      id: 'service.systemd-user',
      status: state === 'degraded' ? 'warn' : 'pass',
      detailCode: state === 'degraded' ? 'systemd-user-degraded' : 'systemd-user-ready',
      summary: state === 'degraded' ? 'The systemd user manager is degraded but reachable.' : 'The systemd user manager is available.',
      evidence: { executable: context.displayPath(systemctl), state },
      ...(state === 'degraded' ? { remediation: { kind: 'manual' as const, message: 'Inspect failed user units before service installation.' } } : {}),
    }];
  }
  return [{
    id: 'service.systemd-user',
    status: wsl ? 'warn' : 'fail',
    detailCode: wsl ? 'wsl-systemd-unavailable' : 'systemd-user-unavailable',
    summary: wsl
      ? 'WSL has systemctl but no usable user manager; foreground mode remains supported.'
      : 'The systemd user manager is not reachable.',
    evidence: { state },
    remediation: wsl
      ? remediation('cosyncing broker', 'Use foreground mode or enable WSL systemd and user services.')
      : { kind: 'manual', message: 'Enable the systemd user manager and login session.' },
  }];
}

function resourceIntegrity(resource: InstalledResourceRecord | undefined): 'ok' | 'missing' | 'unsafe' | 'drifted' {
  if (!resource || typeof resource !== 'object' || typeof resource.target !== 'string'
      || !resource.ownership || typeof resource.ownership !== 'object'
      || resource.ownership.proof !== 'package-hash' || !resource.ownership.installedSha256) return 'missing';
  const inspection = inspectOwnerOnlyFile(resource.target);
  if (inspection.status === 'missing') return 'missing';
  if (inspection.status !== 'ok') return 'unsafe';
  try {
    return createHash('sha256').update(readFileSync(resource.target)).digest('hex') === resource.ownership.installedSha256
      ? 'ok'
      : 'drifted';
  } catch {
    return 'unsafe';
  }
}

function parseServiceEnvironmentValue(quoted: string): string | undefined {
  if (quoted.length < 2 || quoted[0] !== '"' || quoted.at(-1) !== '"') return undefined;
  let value = '';
  for (let index = 1; index < quoted.length - 1; index += 1) {
    const char = quoted[index]!;
    if (char === '\\') {
      index += 1;
      if (index >= quoted.length - 1) return undefined;
      value += quoted[index]!;
    } else {
      value += char;
    }
  }
  return value;
}

function parseServiceEnvironment(environment: string): Record<string, string> | undefined {
  const values: Record<string, string> = {};
  for (const line of environment.split('\n').filter(Boolean)) {
    const separator = line.indexOf('=');
    if (separator < 1) return undefined;
    const name = line.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || name in values) return undefined;
    const value = parseServiceEnvironmentValue(line.slice(separator + 1));
    if (value === undefined) return undefined;
    values[name] = value;
  }
  return values;
}

/**
 * Compare the interactive detection result with the receipt-owned PATH the durable service actually uses.
 *
 * `runtimePath` is the validated external Bun executing this build, when there is one. Setup writes its
 * directory into the durable PATH, so reconstructing the expectation without it would call a correct fresh
 * install "obsolete" — failing doctor while repair finds nothing to change.
 */
function serviceAgentPathCheck(
  context: SetupDiagnosisContext,
  home: string,
  resources: readonly InstalledResourceRecord[],
  environment: InstalledResourceRecord | undefined,
  integrity: ReturnType<typeof resourceIntegrity>,
  runtimePath: string | undefined,
): SetupCheck {
  const executables = resolveServiceAgentExecutables(context);
  if (!environment || integrity !== 'ok') {
    return {
      id: 'service.agent-executable-path',
      status: 'skip',
      detailCode: 'service-agent-path-unavailable',
      summary: 'Agent executable coverage cannot be checked until the service environment is repaired.',
    };
  }
  let durableEnvironment: Record<string, string> | undefined;
  try {
    if (context.platform === 'win32') {
      durableEnvironment = parseWindowsServiceEnvironment(JSON.parse(readFileSync(environment.target, 'utf8')))?.variables;
    } else {
      durableEnvironment = parseServiceEnvironment(readFileSync(environment.target, 'utf8'));
    }
  } catch { /* integrity check owns the error */ }
  const entries = durableEnvironment?.PATH?.split(context.platform === 'win32' ? ';' : ':').filter(Boolean);
  if (!durableEnvironment || !entries) {
    return {
      id: 'service.agent-executable-path',
      status: 'fail',
      detailCode: 'service-agent-path-malformed',
      summary: 'The receipt-owned service environment does not contain a valid PATH.',
      remediation: remediation('cosyncing repair', 'Rebuild the durable service environment.'),
    };
  }
  const requiredDirectories = serviceAgentExecutableDirectories(context);
  const serviceExecutable = context.platform === 'win32'
    ? win32.join(win32.dirname(environment.target), PRODUCT_IDENTITY.primaryBinary)
    : resources.find((resource) => resource.id === 'broker-binary')?.target ?? installedBinaryPath(home);
  let expectedEntries: string[];
  try {
    expectedEntries = servicePathEntries(
      context.homeDir, serviceExecutable, requiredDirectories, runtimePath, context.platform,
    );
  } catch {
    return {
      id: 'service.agent-executable-path',
      status: 'fail',
      detailCode: 'service-agent-path-malformed',
      summary: 'The receipt-owned service executable state cannot produce a valid bounded PATH.',
      remediation: remediation('cosyncing repair', 'Rebuild the durable service environment.'),
    };
  }
  const normalizedEntries = context.platform === 'win32' ? entries.map((entry) => entry.toLowerCase()) : entries;
  const normalizedExpected = context.platform === 'win32'
    ? expectedEntries.map((entry) => entry.toLowerCase()) : expectedEntries;
  const missing = normalizedExpected.filter((directory) => !normalizedEntries.includes(directory));
  const obsolete = normalizedEntries.filter((directory) => !normalizedExpected.includes(directory));
  const orderingMismatch = missing.length === 0
    && obsolete.length === 0
    && !servicePathMatchesExpected(normalizedEntries, normalizedExpected);
  const expectedOverrides = serviceAgentExecutableOverrides(context);
  const overrideMismatches = SERVICE_AGENT_EXECUTABLE_OVERRIDE_NAMES.filter(
    (name) => durableEnvironment[name] !== expectedOverrides[name],
  );
  if (missing.length === 0 && obsolete.length === 0 && !orderingMismatch && overrideMismatches.length === 0) {
    return {
      id: 'service.agent-executable-path',
      status: 'pass',
      detailCode: 'service-agent-path-current',
      summary: 'The durable service agent environment matches the bounded PATH, detected executable directories, and explicit overrides.',
      evidence: {
        detectedExecutables: executables.length,
        expectedDirectories: expectedEntries.length,
      },
    };
  }
  return {
    id: 'service.agent-executable-path',
    status: 'fail',
    detailCode: 'service-agent-path-stale',
    summary: 'The durable service agent environment does not match the bounded PATH and overrides for the currently detected executables.',
    evidence: {
      detectedExecutables: executables.length,
      missingDirectories: missing.length,
      obsoleteDirectories: obsolete.length,
      orderingMismatch,
      overrideMismatches: overrideMismatches.length,
    },
    remediation: remediation('cosyncing repair', 'Reconcile the service PATH with the currently installed agent executables.'),
  };
}

function agentSkillChecks(home: string, context: SetupDiagnosisContext): SetupCheck[] {
  const setupState = readSetupState(home);
  const install = inspectInstallState(home);
  const resources = install.committed ? install.state.resources : [];
  const inspections = inspectAgentSkills(context);
  const hasReceipt = inspections.some((target) => resources.some((item) => item.id === target.resourceId));
  if (setupState.agentSkillRequested !== true && !hasReceipt) return [];

  return inspections.map((target): SetupCheck => {
    const receipt = resources.find((item) => item.id === target.resourceId);
    const receiptProves = (sha: string | undefined): boolean => !!receipt
      && receipt.kind === 'agent-integration'
      && receipt.target === target.path
      && receipt.ownership?.proof === 'package-hash'
      && !!sha
      && receipt.ownership.installedSha256 === sha;
    const receiptMatches = receiptProves(AGENT_SKILL_SHA256);
    const evidence = { target: target.id, path: context.displayPath(target.path) };
    if (target.status === 'owned' && receiptMatches) {
      return {
        id: `state.agent-skill.${target.id}`,
        status: 'pass',
        detailCode: 'agent-skill-present',
        summary: `The package-owned cosyncing skill is present in the ${target.id} discovery root.`,
        evidence,
      };
    }
    // owned-stale: a receipt proves we installed the older on-disk copy; setup/repair will refresh it.
    if (target.status === 'drifted' && receiptProves(target.actualSha256)) {
      return {
        id: `state.agent-skill.${target.id}`,
        status: 'warn',
        detailCode: 'agent-skill-stale',
        summary: `The ${target.id} cosyncing skill is an older packaged version; setup or repair will refresh it to this build's version.`,
        evidence,
        remediation: remediation('cosyncing setup', 'Rerun setup or repair to refresh the receipt-owned packaged skill.'),
      };
    }
    if (target.status === 'missing') {
      return {
        id: `state.agent-skill.${target.id}`,
        status: 'fail',
        detailCode: 'agent-skill-missing',
        summary: `The requested ${target.id} cosyncing skill is missing${receiptMatches ? '' : ' and lacks a matching receipt'}.`,
        evidence,
        remediation: remediation('cosyncing repair', 'Restore the receipt-owned packaged skill.'),
      };
    }
    return {
      id: `state.agent-skill.${target.id}`,
      status: 'warn',
      detailCode: 'agent-skill-unowned-drift',
      summary: `The ${target.id} cosyncing skill is modified, unsafe, or lacks matching ownership evidence.`,
      evidence: { ...evidence, state: target.status },
      remediation: { kind: 'manual', message: 'Preserve or reconcile the user-managed copy explicitly; repair will not overwrite it.' },
    };
  });
}

/**
 * Surface the last failed setup run, if one is recorded.
 *
 * Severity follows the rollback outcome. A COMPLETED rollback left the machine as it was, so the record is
 * history rather than current breakage — `warn`. An INCOMPLETE rollback means a transaction journal remains
 * and the host may be partially mutated; repair refuses to run in that state, so doctor must not exit
 * healthy — `fail`. Either way this record is the only place the reason survives, and a successful setup
 * clears it, so a present one always describes the most recent attempt. Nothing is emitted when no failure
 * is recorded, keeping a healthy machine's report unchanged.
 */
function setupFailureChecks(home: string, context: SetupDiagnosisContext): SetupCheck[] {
  const failure = readSetupFailureDiagnostic(home);
  if (!failure) return [];
  return [{
    id: 'state.last-setup-failure',
    status: failure.rollback === 'incomplete' ? 'fail' : 'warn',
    detailCode: `last-setup-${failure.code}`,
    summary: `The last setup run failed while ${failure.actionId ? `applying ${failure.actionId}` : `in the ${failure.stage} stage`}: ${failure.detail}`,
    evidence: {
      recordedAt: failure.recordedAt,
      transaction: failure.transactionId,
      rollback: failure.rollback,
      path: context.displayPath(setupFailureDiagnosticPath(home)),
      ...(failure.actionId ? { action: failure.actionId } : {}),
    },
    remediation: failure.rollback === 'incomplete'
      ? remediation(`${PRODUCT_IDENTITY.primaryBinary} setup`, 'Cleanup from that run remains; rerun setup, which rolls the remainder back before replanning.')
      : remediation(`${PRODUCT_IDENTITY.primaryBinary} setup`, 'Address the reported cause, then rerun setup.'),
  }];
}

/**
 * Report every external agent host this installation has an ownership record
 * for, and say plainly whether it is still ours.
 *
 * Read straight off disk, so it works with the broker stopped — which is when an
 * operator most needs it. Nothing here performs an effect: it locates, it
 * classifies, and it reports. The three answers are genuinely different things
 * to tell someone:
 *
 *   owned          the host is running and cosyncing can stop it
 *   absent         the record describes a process that is gone; harmless
 *   foreign/unknown something is there that cosyncing must not touch, which is
 *                  also why `uninstall` will leave it running
 *
 * A record that cannot be proven is a `warn`, never a `fail`: nothing is broken,
 * but a host may outlive the product, and that is exactly the surprise this
 * check exists to prevent.
 */
function managedHostChecks(home: string, effects = defaultManagedHostEffects()): SetupCheck[] {
  return listManagedHostOwnerships(home).map((record) => {
    const location = locateRecordedManagedHost(record, effects);
    const verdict = location.state === 'unknown'
      ? 'indeterminate'
      : classifyManagedHost(
        record,
        effects.liveProcess(location.state === 'identified' ? location.pid : record.pid),
        record.identityKey,
      );
    const evidence = {
      agent: record.agent,
      pid: record.pid,
      executable: record.evidence.executable,
      ...(record.evidence.port === undefined ? {} : { port: record.evidence.port }),
      ...(record.evidence.version === undefined ? {} : { version: record.evidence.version }),
      ...(record.evidence.profile === undefined ? {} : { profile: record.evidence.profile }),
      verdict,
    };
    if (verdict === 'owned') {
      return {
        id: `state.managed-host-${record.agent}`,
        status: 'pass' as const,
        detailCode: 'managed-host-owned',
        summary: `The ${record.agent} host cosyncing started is running and can be stopped by cosyncing.`,
        evidence,
      };
    }
    if (verdict === 'absent') {
      return {
        id: `state.managed-host-${record.agent}`,
        status: 'pass' as const,
        detailCode: 'managed-host-not-running',
        summary: `The ${record.agent} host cosyncing started is no longer running.`,
        evidence,
      };
    }
    return {
      id: `state.managed-host-${record.agent}`,
      status: 'warn' as const,
      detailCode: verdict === 'foreign' ? 'managed-host-foreign' : 'managed-host-unprovable',
      summary: verdict === 'foreign'
        ? `A ${record.agent} host is running that cosyncing cannot prove it started; cosyncing will leave it running.`
        : `Whether the ${record.agent} host is still the one cosyncing started cannot be determined on this machine; cosyncing will leave it running.`,
      evidence,
      remediation: remediation(
        `${PRODUCT_IDENTITY.primaryBinary} doctor`,
        'Stop that host yourself if you no longer want it running; cosyncing will not stop a process it cannot prove it started.',
      ),
    };
  });
}

function firstOutputWord(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

/**
 * Read the installed job's enabled/active posture from whichever manager owns it, normalized onto the words
 * this check already reports. launchd has no is-enabled/is-active pair, so its single `print` is parsed by the
 * same defensive parser the provider uses and mapped back onto those words.
 */
async function installedServicePosture(
  context: SetupDiagnosisContext,
  provider: DurableServiceProviderId,
  manager: string,
): Promise<{ enabledState: string; activeState: string }> {
  if (provider === 'systemd') {
    const [enabled, active] = await Promise.all([
      context.runReadOnly(manager, ['--user', 'is-enabled', SYSTEMD_SERVICE_NAME]),
      context.runReadOnly(manager, ['--user', 'is-active', SYSTEMD_SERVICE_NAME]),
    ]);
    return {
      enabledState: firstOutputWord(enabled.stdout, enabled.stderr),
      activeState: firstOutputWord(active.stdout, active.stderr),
    };
  }
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '';
  if (!/^\d{1,10}$/.test(uid)) return { enabledState: '', activeState: '' };
  const printed = await context.runReadOnly(manager, ['print', `gui/${uid}/${LAUNCHD_SERVICE_LABEL}`]);
  const state = parseLaunchdPrintState({
    status: printed.status === 'ok' ? 'ok' : printed.status === 'unavailable' ? 'unavailable' : 'error',
    ...(printed.exitCode === undefined ? {} : { exitCode: printed.exitCode }),
    stdout: printed.stdout,
    stderr: printed.stderr,
  });
  return { enabledState: state.enabled, activeState: state.active };
}

async function installedBrokerServiceChecks(
  context: SetupDiagnosisContext,
  home: string,
  identity: Readonly<ApplicationIdentity>,
  buildInfo: Readonly<BuildInfo>,
): Promise<SetupCheck[]> {
  const setupState = readSetupState(home);
  const provider = durableServiceProviderId(context.platform);
  if (setupState.serviceChoice !== provider) {
    return [{
      id: 'service.broker',
      status: 'skip',
      detailCode: 'broker-service-not-selected',
      summary: 'Persistent broker service mode is not selected.',
    }];
  }
  const managerCommand = provider === 'launchd' ? 'launchctl' : 'systemctl';
  const manager = context.resolveExecutable(managerCommand);
  const install = inspectInstallState(home);
  const resources = install.committed ? install.state.resources : [];
  const definition = resources.find((resource) => resource.id === serviceDefinitionResourceId({ id: provider }));
  const environment = resources.find((resource) => resource.id === 'service-environment');
  const definitionIntegrity = resourceIntegrity(definition);
  const windowsEnvironmentInspection = environment ? inspectOwnerOnlyFile(environment.target) : undefined;
  const environmentIntegrity: ReturnType<typeof resourceIntegrity> = provider === 'task-scheduler'
    ? (!environment || environment.ownership.proof !== 'receipt'
      ? 'missing'
      : windowsEnvironmentInspection?.status === 'ok' ? 'ok'
        : windowsEnvironmentInspection?.status === 'missing' ? 'missing' : 'unsafe')
    : resourceIntegrity(environment);
  const agentPathCheck = serviceAgentPathCheck(context, home, resources, environment, environmentIntegrity, identity.runtimePath);
  let serviceCheck: SetupCheck;
  if (provider === 'task-scheduler') {
    try {
      if (!install.committed || !install.state.installationId || !identity.runtimePath) {
        throw new Error('incomplete Windows service receipt');
      }
      const durable = createDurableServiceProvider({
        context,
        homeDir: context.homeDir,
        stateHome: home,
        installationId: install.state.installationId,
        taskSchedulerReceiptResources: resources,
        versionKey: windowsServiceVersionKey(buildInfo),
        cacheRoot: context.env.COSYNCING_CACHE_DIR?.trim()
          || join(context.homeDir, '.cache', PRODUCT_IDENTITY.cacheDirectoryName),
        executablePath: installedBinaryPath(home),
        acquisitionExecutablePath: identity.applicationPath,
        distribution: buildInfo.distribution,
        runtimePath: identity.runtimePath,
        agentExecutableDirectories: serviceAgentExecutableDirectories(context),
        agentExecutableOverrides: serviceAgentExecutableOverrides(context),
        webDir: serviceFlutterWebRoot({
          override: context.env.COSYNCING_WEB_DIR,
          packaged: buildInfo.packaged,
          executablePath: identity.applicationPath,
          version: buildInfo.version,
        }),
      });
      const status = await durable.inspect();
      if (status.definition === 'current' && status.environment === 'current'
          && status.enabled === 'enabled' && status.active === 'active') {
        serviceCheck = {
          id: 'service.broker', status: 'pass', detailCode: 'broker-service-healthy',
          summary: 'The receipt-owned broker service is enabled and active.',
        };
      } else {
        serviceCheck = {
          id: 'service.broker', status: 'fail',
          detailCode: status.active === 'failed' ? 'broker-service-failed' : 'broker-service-inactive',
          summary: status.active === 'failed'
            ? 'The broker service is failed or crash-looping.'
            : 'The broker service is disabled, inactive, or still transitioning.',
          evidence: {
            definition: status.definition,
            environment: status.environment,
            enabled: status.enabled,
            active: status.active,
          },
          remediation: remediation('cosyncing repair', 'Reconcile and start the owned service.'),
        };
      }
    } catch {
      serviceCheck = {
        id: 'service.broker', status: 'fail', detailCode: 'broker-service-definition-invalid',
        summary: 'The broker service definition or owner-only environment file is missing, unsafe, or changed outside its receipt.',
        remediation: remediation('cosyncing repair', 'Reconcile the receipt-owned task-scheduler service files.'),
      };
    }
  } else if (!manager) {
    serviceCheck = {
      id: 'service.broker',
      status: 'fail',
      detailCode: 'broker-service-manager-missing',
      summary: `The configured broker service cannot be inspected because ${managerCommand} is unavailable.`,
      remediation: remediation('cosyncing repair', `Restore ${managerCommand} or switch explicitly to foreground mode.`),
    };
  } else if (definitionIntegrity !== 'ok' || environmentIntegrity !== 'ok') {
    serviceCheck = {
      id: 'service.broker',
      status: 'fail',
      detailCode: 'broker-service-definition-invalid',
      summary: 'The broker service definition or owner-only environment file is missing, unsafe, or changed outside its receipt.',
      evidence: { definition: definitionIntegrity, environment: environmentIntegrity },
      remediation: remediation('cosyncing repair', `Reconcile the receipt-owned ${provider} service files.`),
    };
  } else {
    const { enabledState, activeState } = await installedServicePosture(context, provider, manager);
    if (enabledState === 'enabled' && activeState === 'active') {
      serviceCheck = {
        id: 'service.broker',
        status: 'pass',
        detailCode: 'broker-service-healthy',
        summary: 'The receipt-owned broker service is enabled and active.',
      };
    } else {
      const failed = activeState === 'failed';
      serviceCheck = {
        id: 'service.broker',
        status: 'fail',
        detailCode: failed ? 'broker-service-failed' : 'broker-service-inactive',
        summary: failed
          ? 'The broker service is failed or crash-looping.'
          : 'The broker service is disabled, inactive, or still transitioning.',
        evidence: {
          enabled: ['enabled', 'disabled'].includes(enabledState) ? enabledState : 'unknown',
          active: ['active', 'inactive', 'failed', 'activating', 'deactivating'].includes(activeState)
            ? activeState
            : 'unknown',
        },
        // `cosyncing logs` reads and redacts whichever backing store this provider uses; naming journalctl on
        // a launchd host would send the operator to a command that does not exist there.
        remediation: remediation(
          failed ? `${PRODUCT_IDENTITY.primaryBinary} logs --lines 100` : 'cosyncing repair',
          failed
            ? 'Inspect the redacted service log output, then repair or restart the service.'
            : 'Reconcile and start the owned service.',
        ),
      };
    }
  }

  // launchd has no lingering to inspect: a LaunchAgent lives in the GUI session and there is no equivalent
  // policy to enable, so the check is skipped outright rather than reported as unverifiable.
  if (provider === 'launchd') {
    return [serviceCheck, agentPathCheck, {
      id: 'service.systemd-lingering',
      status: 'skip',
      detailCode: 'lingering-unsupported-on-launchd',
      summary: 'launchd has no user-lingering equivalent; the broker runs from GUI login to logout.',
    }];
  }
  if (setupState.systemdLingeringRequested !== true) {
    return [serviceCheck, agentPathCheck, {
      id: 'service.systemd-lingering',
      status: 'skip',
      detailCode: 'systemd-lingering-not-requested',
      summary: 'Systemd user lingering was not requested; service persistence begins with a login session.',
    }];
  }
  const loginctl = context.resolveExecutable('loginctl');
  if (!loginctl) {
    return [serviceCheck, agentPathCheck, {
      id: 'service.systemd-lingering',
      status: 'fail',
      detailCode: 'systemd-lingering-unverifiable',
      summary: 'Requested boot and post-logout persistence cannot be verified because loginctl is unavailable.',
      remediation: remediation('cosyncing repair', 'Restore loginctl or decline lingering explicitly.'),
    }];
  }
  const userIdentifier = typeof process.getuid === 'function' ? String(process.getuid()) : context.env.USER?.trim();
  if (!userIdentifier || !/^[A-Za-z0-9._-]{1,128}$/.test(userIdentifier)) {
    return [serviceCheck, agentPathCheck, {
      id: 'service.systemd-lingering',
      status: 'fail',
      detailCode: 'systemd-lingering-user-unknown',
      summary: 'Requested user lingering cannot be tied to a safe local user identifier.',
      remediation: remediation('cosyncing repair', 'Reconcile the installing user and lingering state.'),
    }];
  }
  const lingering = await context.runReadOnly(
    loginctl,
    ['show-user', userIdentifier, '--property=Linger', '--value'],
  );
  const lingerState = firstOutputWord(lingering.stdout, lingering.stderr);
  return [serviceCheck, agentPathCheck, lingerState === 'yes' ? {
    id: 'service.systemd-lingering',
    status: 'pass',
    detailCode: 'systemd-lingering-enabled',
    summary: 'Systemd user lingering is enabled for boot and post-logout persistence.',
  } : {
    id: 'service.systemd-lingering',
    status: 'fail',
    detailCode: 'systemd-lingering-disabled',
    summary: 'Systemd user lingering was requested but is not enabled.',
    remediation: remediation('cosyncing repair', 'Reconcile the separately consented lingering policy.'),
  }];
}

function installedState(home: string): ReturnType<typeof inspectInstallState> {
  try { return inspectInstallState(home); } catch {
    return { committed: false, path: '', reason: 'unreadable' };
  }
}

async function endpointAndRuntimeChecks(options: {
  context: SetupDiagnosisContext;
  config: BrokerConfigInspection;
  brokerToken: ReturnType<typeof inspectBrokerToken>;
  home: string;
  agentPathCheck?: Readonly<SetupCheck>;
}): Promise<{ network: SetupCheck[]; runtime: SetupCheck[]; agents: SetupCheck[] }> {
  if (options.config.status !== 'ok') return { network: [], runtime: [], agents: [] };
  const install = installedState(options.home);
  const token = options.brokerToken.status === 'ok' ? readBrokerToken(options.brokerToken.path) : '';
  const headers: Readonly<Record<string, string>> = token ? { [PRODUCT_IDENTITY.tokenHeader]: token } : {};
  const internal = options.config.config.broker.internalUrl;
  const internalHealth = await options.context.fetchJson(new URL('/api/broker/health', internal).toString(), headers);
  const network: SetupCheck[] = [];
  const runtime: SetupCheck[] = [];
  const agents: SetupCheck[] = [];
  if (internalHealth.status !== 'ok') {
    network.push({
      id: 'network.internal-endpoint',
      status: install.committed ? 'fail' : 'warn',
      detailCode: internalHealth.status === 'http-error' ? 'internal-endpoint-auth-or-http-error' : 'internal-endpoint-unreachable',
      summary: install.committed ? 'The installed broker internal endpoint is not healthy.' : 'The broker internal endpoint is not running yet.',
      evidence: { endpoint: 'internal-loopback' },
      remediation: remediation(install.committed ? 'cosyncing repair' : 'cosyncing setup', 'Reconcile and start the broker service.'),
    });
  } else {
    const health = internalHealth.json as any;
    const reportedStatus = String(health?.status ?? '').toLowerCase();
    const status = ['healthy', 'degraded', 'critical'].includes(reportedStatus) ? reportedStatus : 'unknown';
    network.push({
      id: 'network.internal-endpoint',
      status: status === 'critical' || status === 'unknown' ? 'fail' : status === 'degraded' ? 'warn' : 'pass',
      detailCode: status === 'critical'
        ? 'broker-health-critical'
        : status === 'degraded' ? 'broker-health-degraded' : status === 'healthy' ? 'broker-health-healthy' : 'broker-health-malformed',
      summary: status === 'critical'
        ? 'Broker health is critical.'
        : status === 'degraded'
          ? 'Broker health is degraded.'
          : status === 'healthy' ? 'Broker internal endpoint is healthy.' : 'Broker health returned an unknown status.',
      evidence: { endpoint: 'internal-loopback', status },
      ...(status === 'healthy' ? {} : { remediation: remediation('cosyncing repair', 'Inspect and repair failing broker health components.') }),
    });

    const updates = await options.context.fetchJson(new URL('/api/agent-runtime-updates', internal).toString(), headers);
    if (updates.status === 'ok' && Array.isArray((updates.json as any)?.updates)) {
      const items = (updates.json as any).updates as any[];
      const errors = items.filter((item) => item?.state === 'error');
      const pending = items.filter((item) => item?.updateAvailable === true || item?.state === 'pending');
      runtime.push({
        id: 'runtime.managed-updates',
        status: errors.length > 0 ? 'fail' : pending.length > 0 ? 'warn' : 'pass',
        detailCode: errors.length > 0 ? 'runtime-update-error' : pending.length > 0 ? 'runtime-update-pending' : 'runtime-updates-current',
        summary: errors.length > 0
          ? 'One or more managed runtimes could not report update state.'
          : pending.length > 0 ? 'One or more managed runtimes have a pending update.' : 'Managed runtime versions are current.',
        evidence: { checked: items.length, pending: pending.length, errors: errors.length },
        ...(errors.length > 0 || pending.length > 0
          ? { remediation: remediation('cosyncing repair', 'Reconcile managed runtime versions when sessions are safe to restart.') }
          : {}),
      });
    } else {
      runtime.push({
        id: 'runtime.managed-updates',
        status: 'warn',
        detailCode: 'runtime-update-status-unavailable',
        summary: 'Managed runtime update status is unavailable.',
        remediation: remediation('cosyncing repair', 'Retry managed runtime diagnosis.'),
      });
    }

    const readiness = await options.context.fetchJson(new URL(INTERNAL_AGENT_ROSTER_PATH, internal).toString(), headers);
    if (readiness.status === 'ok' && Array.isArray(readiness.json)) {
      const installed = new Set(resolveServiceAgentExecutables(options.context).map((agent) => agent.id));
      for (const candidate of readiness.json) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const row = candidate as Record<string, unknown>;
        if (typeof row.id !== 'string') continue;
        const displayName = typeof row.displayName === 'string' ? row.displayName : row.id;
        const reported = typeof row.canCreateSession === 'boolean';
        const ready = row.canCreateSession === true;
        const installedInShell = installed.has(row.id as 'codex' | 'opencode' | 'pi' | 'claude');
        const pathStale = installedInShell && options.agentPathCheck?.status === 'fail';
        const pathCurrent = installedInShell && options.agentPathCheck?.status === 'pass';
        const runtimeUnavailable = !ready && reported && pathCurrent;
        agents.push({
          id: `${row.id}.broker-create-readiness`,
          status: ready ? 'pass' : !reported ? 'warn' : installedInShell ? 'fail' : 'skip',
          detailCode: ready
            ? 'broker-session-creation-ready'
            : !reported ? 'broker-session-creation-unreported'
              : pathStale ? 'broker-session-creation-path-stale'
                : runtimeUnavailable ? 'broker-agent-runtime-unavailable'
                  : installedInShell ? 'broker-session-creation-unavailable' : 'broker-agent-executable-unavailable',
          summary: ready
            ? `${displayName} is registered in the running broker and can create sessions.`
            : !reported
              ? `${displayName} is registered in the running broker, but creation readiness was not reported.`
              : pathStale
                ? `${displayName} is installed and registered, but the durable service PATH is stale.`
                : runtimeUnavailable
                  ? `${displayName} has a current durable service PATH, but its runtime or shared server is unavailable.`
                  : installedInShell
                    ? `${displayName} is installed in this shell and registered, but the running broker cannot create sessions.`
                    : `${displayName} is registered, but its executable is not installed or not visible to the running broker.`,
          evidence: {
            registered: true,
            creationReady: ready,
            installedInInteractiveShell: installedInShell,
            ...(typeof row.syncEnabled === 'boolean' ? { syncEnabled: row.syncEnabled } : {}),
          },
          ...(pathStale ? {
            remediation: remediation('cosyncing repair', 'Reconcile the durable service PATH and restart the broker.'),
          } : runtimeUnavailable ? {
            remediation: remediation(
              'cosyncing restart',
              `Restart the broker-managed ${displayName} runtime or shared server; inspect \`cosyncing logs\` if it remains unavailable.`,
            ),
          } : !ready && installedInShell ? {
            remediation: remediation('cosyncing doctor', 'Verify the durable service and agent runtime state, then rerun doctor.'),
          } : {}),
        });
      }
    } else {
      agents.push({
        id: 'agents.broker-create-readiness',
        status: 'warn',
        detailCode: 'broker-agent-readiness-unavailable',
        summary: 'The running broker did not report agent creation readiness.',
        remediation: remediation('cosyncing repair', 'Reconcile and restart the broker, then rerun doctor.'),
      });
    }
  }

  return { network, runtime, agents };
}

export async function diagnoseAgents(
  context: SetupDiagnosisContext,
  adapters: readonly AgentBackend[],
  /**
   * The external hosts THIS machine's cosyncing starts and supervises, as the
   * identity keys each adapter names them by.
   *
   * Threaded per adapter rather than left on the shared context, so a diagnosis
   * never has to ask about itself by name: each adapter is simply handed the
   * identities of its own managed hosts, and decides by comparing them against
   * the one it resolved. An agent with no entry is told nothing, which is the
   * unmanaged posture.
   */
  brokerManaged: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): Promise<AgentSetupDiagnosis[]> {
  return Promise.all(adapters.map(async (adapter) => {
    if (!adapter.diagnoseSetup) {
      return {
        agent: adapter.id,
        displayName: adapter.displayName,
        minimumVersion: {
          version: '0.0.0',
          requiredFeature: 'adapter diagnosis contract',
          evidenceUrl: '',
          evidenceNote: 'No adapter-owned diagnosis is registered.',
        },
        checks: [{
          id: `${adapter.id}.diagnosis`,
          status: 'fail',
          detailCode: 'adapter-diagnosis-missing',
          summary: `${adapter.displayName} does not provide setup diagnosis.`,
          remediation: { kind: 'manual', message: 'Update cosyncing to a build with complete adapter diagnosis.' },
        }],
      };
    }
    try {
      const managedIdentities = brokerManaged.get(adapter.id);
      const diagnosis = await adapter.diagnoseSetup(
        managedIdentities ? { ...context, managedExternalHostIdentities: [...managedIdentities] } : context,
      );
      // A managed EXTERNAL HOST earns the same diagnosis as a managed runtime,
      // and for the same reason: the broker starts it, supervises it, and
      // restarts it, so its failures to do any of that are the broker's to
      // report. Without this a Kimi or dsh host that crashed and could not be
      // restarted left nothing in doctor at all — the supervisor's warning
      // scrolled past in the journal and that was the end of it.
      //
      // Derived from what the adapter declares, not from a list of ids, so the
      // next managed-host adapter cannot ship with its recovery failures silent.
      const diagnosesManagedFailures = adapter.integration?.managedRuntime?.failureJournal === true
        || adapter.integration?.externalHost?.managed === true;
      return diagnosesManagedFailures
        ? {
            ...diagnosis,
            checks: [
              ...diagnosis.checks,
              diagnoseManagedRuntimeFailure(context, adapter.id, adapter.displayName),
            ],
          }
        : diagnosis;
    } catch {
      return {
        agent: adapter.id,
        displayName: adapter.displayName,
        minimumVersion: {
          version: '0.0.0',
          requiredFeature: 'adapter diagnosis contract',
          evidenceUrl: '',
          evidenceNote: 'Adapter diagnosis failed before its version matrix could be returned.',
        },
        checks: [{
          id: `${adapter.id}.diagnosis`,
          status: 'fail',
          detailCode: 'adapter-diagnosis-error',
          summary: `${adapter.displayName} diagnosis failed safely.`,
          remediation: remediation('cosyncing doctor', 'Retry diagnosis after checking the agent installation.'),
        }],
      };
    }
  }));
}

/** Overlay broker receipt/safety evidence onto the adapter's provider-specific bridge content check. */
function reconcilePiBridgeDoctorDiagnosis(
  context: SetupDiagnosisContext,
  install: InstallStateInspection,
  diagnoses: readonly AgentSetupDiagnosis[],
): AgentSetupDiagnosis[] {
  const pi = diagnoses.find((diagnosis) => diagnosis.agent === 'pi');
  if (!pi || !pi.checks.some((check) => check.id === 'pi.bridge-asset')) return [...diagnoses];
  const piAgentDir = context.env.PI_CODING_AGENT_DIR?.trim() || join(context.homeDir, '.pi', 'agent');
  const decision = inspectPiBridgeOwnership(install, piAgentDir);
  let replacement: SetupCheck | undefined;
  if (decision.status === 'owned-stale') {
    replacement = {
      id: 'pi.bridge-asset',
      status: 'warn',
      detailCode: 'bridge-owned-stale',
      summary: 'The installed Pi bridge is a receipt-proven older packaged version.',
      evidence: { path: context.displayPath(decision.bridge.path) },
      remediation: remediation(
        'cosyncing setup',
        'Run setup or repair to refresh the package-owned Pi bridge.',
      ),
    };
  } else if (decision.status === 'receipt-invalid') {
    replacement = {
      id: 'pi.bridge-asset',
      status: 'fail',
      detailCode: 'bridge-receipt-invalid',
      summary: 'The Pi bridge receipt does not prove ownership of the installed target.',
      evidence: { path: context.displayPath(decision.bridge.path) },
      remediation: {
        kind: 'manual',
        message: 'Preserve the bridge and reconcile its install receipt before setup or repair.',
      },
    };
  } else if (decision.status === 'unsafe' || decision.status === 'unreadable') {
    replacement = {
      id: 'pi.bridge-asset',
      status: 'fail',
      detailCode: decision.status === 'unsafe' ? 'bridge-unsafe' : 'bridge-unreadable',
      summary: 'The Pi bridge target cannot be inspected safely.',
      evidence: { path: context.displayPath(decision.bridge.path) },
      remediation: remediation('cosyncing repair', 'Repair Pi bridge ownership and permissions.'),
    };
  }
  if (!replacement) return [...diagnoses];
  return diagnoses.map((diagnosis) => diagnosis !== pi ? diagnosis : {
    ...diagnosis,
    checks: diagnosis.checks.map((check) => check.id === replacement.id ? replacement : check),
  });
}

function summarize(sections: readonly DoctorSection[]): Record<SetupCheckStatus, number> {
  const result: Record<SetupCheckStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const section of sections) {
    for (const check of section.checks) result[check.status] += 1;
  }
  return result;
}

/**
 * The adapters production doctor diagnoses: every one this build ships, with no
 * dependence on the environment it was handed.
 *
 * It is the SAME list the installed service derives managed-host activation
 * from, so an agent cannot be diagnosed here and left unmanaged there. Doctor
 * reporting a host that is not running is the answer an operator opened it for;
 * an adapter that disappears unless a variable is set cannot give it.
 *
 * `env` is accepted and deliberately unused — the parameter survives so callers
 * that once passed a rollout environment keep compiling, and so the signature
 * says out loud that the answer no longer depends on it.
 */
export function defaultDoctorAdapters(
  env: Readonly<Record<string, string | undefined>>,
): readonly AgentBackend[] {
  void env;
  return shippedAdapters();
}

export async function collectDoctorReport(dependencies: DoctorDependencies): Promise<DoctorReport> {
  if (dependencies.context.effects !== 'forbidden') throw new Error('doctor requires a no-effects context');
  const home = dependencies.stateHome ?? setupStateHome();
  const config = inspectBrokerConfig(home);
  const brokerToken = inspectBrokerToken(join(home, 'secrets', 'broker-token'));
  const piIntegration = inspectPiIntegration(join(home, 'secrets', 'pi-integration.json'));
  const host = hostChecks(dependencies.context, dependencies.context.arch);
  const adapters = dependencies.adapters ?? defaultDoctorAdapters(dependencies.context.env);
  const installedResources = inspectInstallState(home);
  // Resolved before the service checks because the durable service PATH is derived from it: setup records
  // the validated runtime's directory there, and the check below must reconstruct the same expectation.
  const identity = dependencies.applicationIdentity
    ?? currentApplicationIdentity(dependencies.buildInfo.distribution, `${import.meta.dir}/cli.ts`);
  const [adapterDiagnoses, service, installedService] = await Promise.all([
    diagnoseAgents(dependencies.context, adapters, brokerManagedHostIdentities(
      // `home` is the STATE home — receipts and ownership records. The identity
      // an adapter resolves belongs to the USER home, which is the same one the
      // diagnosis below resolves against; handing it the state home would name
      // `~/.cosyncing/.kimi-code`, match nothing, and quietly restore the manual
      // start command the posture exists to withhold.
      home,
      dependencies.context.homeDir,
      adapters,
    )),
    serviceChecks(dependencies.context, host.wsl),
    installedBrokerServiceChecks(dependencies.context, home, identity, dependencies.buildInfo),
  ]);
  const agents = reconcilePiBridgeDoctorDiagnosis(
    dependencies.context,
    installedResources,
    adapterDiagnoses,
  );
  const endpoints = await endpointAndRuntimeChecks({
    context: dependencies.context,
    config,
    brokerToken,
    home,
    agentPathCheck: installedService.find((candidate) => candidate.id === 'service.agent-executable-path'),
  });
  const codexReadiness = codexTuiReadinessCheck(
    dependencies.codexTuiReadiness ?? safeCodexTuiReadiness(dependencies.context),
  );
  // Read from the receipt's own target, so this inspects the file the installer actually wrote rather than
  // a path recomputed here — the same rule every other receipt-owned resource check follows.
  const serviceProvider = durableServiceProviderId(dependencies.context.platform);
  const serviceDefinitionReceipt = (installedResources.committed ? installedResources.state.resources : [])
    .find((resource: InstalledResourceRecord) => resource.id === serviceDefinitionResourceId({ id: serviceProvider }));
  const serviceRuntimePath = serviceDefinitionReceipt
    ? recordedServiceRuntimePath(serviceDefinitionReceipt.target, serviceProvider)
    : undefined;
  const sections: DoctorSection[] = [
    {
      id: 'package',
      title: 'Package',
      checks: [
        ...assetChecks(dependencies.assetReport),
        applicationRuntimeCheck({
          identity,
          ...(serviceRuntimePath ? { serviceRuntimePath } : {}),
        }),
      ],
    },
    {
      id: 'state',
      title: 'Configuration and state',
      checks: [
        configCheck(config, dependencies.context),
        credentialCheck({ id: 'state.broker-token', label: 'Broker credential', inspection: brokerToken, context: dependencies.context }),
        credentialCheck({ id: 'state.pi-integration', label: 'Pi integration credential', inspection: piIntegration, context: dependencies.context }),
        environmentPrecedenceCheck({ packaged: dependencies.buildInfo.packaged, home, context: dependencies.context }),
        machinePeerCredentialCheck(dependencies.context),
        ...agentSkillChecks(home, dependencies.context),
        ...setupFailureChecks(home, dependencies.context),
        ...managedHostChecks(home),
        ...durableDirectoryChecks(home, dependencies.context),
        ...durableChecks(home, dependencies.context),
      ],
    },
    { id: 'agents', title: 'Coding agents', checks: [...agents.flatMap((agent) => agent.checks), ...endpoints.agents, codexReadiness] },
    { id: 'host', title: 'Host', checks: host.checks },
    { id: 'service', title: 'Service manager', checks: [...service, ...installedService] },
    { id: 'network', title: 'Local broker', checks: endpoints.network },
    { id: 'runtime', title: 'Managed runtimes', checks: endpoints.runtime },
  ];
  const summary = summarize(sections);
  return {
    schemaVersion: DOCTOR_REPORT_SCHEMA_VERSION,
    product: PRODUCT_IDENTITY.productName,
    version: dependencies.buildInfo.version,
    effects: 'forbidden',
    ok: summary.fail === 0,
    summary,
    minimumVersions: agents.map((agent) => ({
      agent: agent.agent,
      displayName: agent.displayName,
      ...agent.minimumVersion,
    })),
    sections,
  };
}

/** SGR foreground per status: ok green, warning yellow, error red, info blue. */
const STATUS_SGR: Readonly<Record<SetupCheckStatus, string>> = Object.freeze({
  pass: '32',
  warn: '33',
  fail: '31',
  skip: '34',
});

/**
 * Whether the human doctor render may emit colour. A pipe, a redirect, `NO_COLOR`, or a dumb terminal all
 * mean plain text — the escapes would end up in whatever file or bug report the output was captured into.
 * `--json` never reaches this decision: it is rendered by `JSON.stringify` and stays byte-identical.
 */
export function doctorColorEnabled(options: {
  env: Readonly<Record<string, string | undefined>>;
  tty: boolean;
}): boolean {
  if (!options.tty) return false;
  // https://no-color.org: set and non-empty disables colour, whatever the value is.
  if (typeof options.env.NO_COLOR === 'string' && options.env.NO_COLOR !== '') return false;
  return options.env.TERM !== 'dumb';
}

export function renderDoctorReport(
  report: DoctorReport,
  options: { color?: boolean; language?: SetupLanguage } = {},
): string {
  const text = cliMessages(options.language);
  const lines = [text.doctor.title(report.product), ''];
  const paint = (status: SetupCheckStatus, text: string): string =>
    options.color ? `\u001b[${STATUS_SGR[status]}m${text}\u001b[0m` : text;
  for (const section of report.sections) {
    lines.push(text.doctor.sectionTitle(section));
    for (const check of section.checks) {
      lines.push(`${paint(check.status, `[${text.doctor.mark[check.status]}]`)} ${check.id}: ${text.doctor.checkSummary(check)}`);
      if (check.remediation) {
        lines.push(`  ${text.doctor.fixLabel} ${text.doctor.remediation(check)}${check.remediation.command ? ` (${check.remediation.command})` : ''}`);
      }
    }
    lines.push('');
  }
  if (options.language === 'zh-Hans') {
    lines.push(text.doctor.totals(report.summary));
  } else {
    lines.push(`Summary: ${paint('pass', `${report.summary.pass} passed`)}, `
      + `${paint('warn', `${report.summary.warn} warnings`)}, `
      + `${paint('fail', `${report.summary.fail} failed`)}, `
      + `${paint('skip', `${report.summary.skip} skipped`)}.`);
  }
  return `${lines.join('\n')}\n`;
}
