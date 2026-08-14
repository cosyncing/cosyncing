import { basename } from 'node:path';
import type { OpencodeShimSignal } from '../installation/setup-presenter.ts';
import { BUILD_INFO, type BuildInfo } from '../runtime/build-info.ts';
import { currentApplicationIdentity, type ApplicationIdentity } from '../runtime/application-identity.ts';
import { inspectInstallState, type InstallStateInspection } from '../installation/install-state.ts';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import {
  cliMessages,
  persistedCliLanguage,
  renderUninstallPlan,
  renderUninstallResult,
} from './cli-i18n.ts';

export interface BrokerRuntimeHandle {
  closed: Promise<void>;
  shutdown(reason?: string): Promise<void>;
}

export interface CliWriter {
  write(text: string): void;
}

/** Structural CLI view; the full versioned schema is owned by doctor.ts and loaded only for that command. */
export interface CliDoctorReport {
  ok: boolean;
}

export interface CliRuntimeAssetReport {
  schemaVersion: 1;
  ok: boolean;
  checks: Array<{
    id: string;
    required: boolean;
    status: 'ok' | 'missing' | 'hash-mismatch' | 'optional-missing' | 'staged';
    detail: string;
    sha256?: string;
  }>;
}

export interface CliDependencies {
  buildInfo?: Readonly<BuildInfo>;
  inspectInstallState?: () => InstallStateInspection;
  startBroker?: () => Promise<BrokerRuntimeHandle> | BrokerRuntimeHandle;
  installSignalHandlers?: (runtime: BrokerRuntimeHandle) => () => void;
  inspectRuntimeAssets?: (buildInfo: Readonly<BuildInfo>) => CliRuntimeAssetReport | Promise<CliRuntimeAssetReport>;
  collectDoctorReport?: (
    buildInfo: Readonly<BuildInfo>,
    assetReport: CliRuntimeAssetReport,
  ) => Promise<CliDoctorReport>;
  renderDoctorReport?: (report: CliDoctorReport) => string;
  /** Force human doctor colour on or off; unset lets the TTY, NO_COLOR, and TERM policy decide. */
  colorize?: boolean;
  runSetup?: (options: {
    yes: boolean;
    acceptManagedRuntimeOwnership: boolean;
    enableSystemdLingering: boolean;
    enableTailscaleServe: boolean;
    installAgentSkill: boolean;
    opencodeShimSignal: OpencodeShimSignal;
    replaceLegacyPiBridge: boolean;
    upgradeLegacyAgentSkill: boolean;
  }) => Promise<{ exitCode: number }>;
  runPair?: (options: {
    json: boolean;
    wait: boolean;
    clientLabel?: string;
    invocation: string;
    stdout: CliWriter;
    stderr: CliWriter;
  }) => Promise<{ exitCode: number }>;
  runDevicesList?: (options: {
    json: boolean;
    invocation: string;
    stdout: CliWriter;
    stderr: CliWriter;
  }) => Promise<{ exitCode: number }>;
  runDevicesRevoke?: (options: {
    peerId: string;
    yes: boolean;
    json: boolean;
    interactive: boolean;
    invocation: string;
    stdout: CliWriter;
    stderr: CliWriter;
  }) => Promise<{ exitCode: number }>;
  runStatus?: (options: {
    json: boolean;
    invocation: string;
    stdout: CliWriter;
    stderr: CliWriter;
  }) => Promise<{ exitCode: number }>;
  runServiceCommand?: (options: {
    action: 'start' | 'stop' | 'restart';
    json: boolean;
    invocation: string;
    stdout: CliWriter;
    stderr: CliWriter;
  }) => Promise<{ exitCode: number }>;
  runLogs?: (options: {
    json: boolean;
    follow: boolean;
    lines: number;
    invocation: string;
    stdout: CliWriter;
    stderr: CliWriter;
  }) => Promise<{ exitCode: number }>;
  runRepair?: (options: {
    yes: boolean;
    allowLegacyIntegrations: boolean;
    json: boolean;
    interactive: boolean;
    invocation: string;
    stdout: CliWriter;
    stderr: CliWriter;
  }) => Promise<{ exitCode: number }>;
  runUpgrade?: (options: {
    yes: boolean;
    json: boolean;
    manifestUrl?: string;
    interactive: boolean;
    invocation: string;
    stdout: CliWriter;
    stderr: CliWriter;
  }) => Promise<{ exitCode: number }>;
  runUninstall?: (options: {
    yes: boolean;
    allowLegacyIntegrations: boolean;
    purgeData: boolean;
    confirmPurgeData: boolean;
    json: boolean;
    interactive: boolean;
    invocation: string;
    stdout: CliWriter;
    stderr: CliWriter;
  }) => Promise<{ exitCode: number }>;
  stdout?: CliWriter;
  stderr?: CliWriter;
  invocation?: string;
}

function terminalWriter(stream: Pick<NodeJS.WriteStream, 'write'>): CliWriter {
  return { write: (value) => void stream.write(value) };
}

/**
 * The command name to echo back in help and errors.
 *
 * `process.execPath` is deliberately NOT consulted: in the published JavaScript distribution it names Bun,
 * which is never a cosyncing command name. The application artifact is, so a package whose entry file is
 * `bin/cosyncing` answers `cosyncing` whichever runtime launched it. `cosy` is recoverable only when the
 * process was addressed by that name directly; through a bin symlink the runtime resolves it away, and the
 * primary name is the honest fallback rather than a guess.
 */
function invocationName(explicit?: string, applicationPath?: string): string {
  if (explicit === PRODUCT_IDENTITY.aliasBinary || explicit === PRODUCT_IDENTITY.primaryBinary) {
    return explicit;
  }
  for (const candidate of [process.argv[0], applicationPath]) {
    const executable = basename(candidate || '');
    if (executable === PRODUCT_IDENTITY.aliasBinary || executable === PRODUCT_IDENTITY.primaryBinary) {
      return executable;
    }
  }
  return PRODUCT_IDENTITY.primaryBinary;
}

function help(command: string, packaged: boolean): string {
  const brokerUsage = packaged ? `${command} broker` : `${command} broker [--dev-bypass-first-run]`;
  return `${PRODUCT_IDENTITY.productName} broker CLI

Usage:
  ${brokerUsage}
  ${command} setup [--yes --accept-managed-runtime-ownership [--enable-systemd-lingering] [--enable-tailscale-serve] [--no-install-agent-skill] [--replace-legacy-pi-bridge] [--upgrade-legacy-agent-skill]]
  ${command} pair [--label <device>] [--wait] [--json]
  ${command} devices list [--json]
  ${command} devices revoke <id> [--yes] [--json]
  ${command} status [--json]
  ${command} start | stop | restart
  ${command} logs [--lines <count>] [--follow] [--json]
  ${command} repair [--yes] [--accept-legacy-integrations] [--json]
  ${command} upgrade [--yes] [--manifest <url>] [--json]
  ${command} uninstall [--yes] [--accept-legacy-integrations] [--purge-data --confirm-purge-data] [--json]
  ${command} version [--json]
  ${command} doctor [--json]
  ${command} help

Commands:
  broker   Run the broker in the foreground
  setup    Inspect, confirm, and transactionally configure the broker
  pair     Render a five-minute, one-use client pairing QR
  devices  List or immediately revoke paired-device access
  status   Summarize installation, service, endpoints, agents, sessions, and updates
  start    Start the owned durable user service (systemd or launchd)
  stop     Stop the owned durable user service
  restart  Restart the owned durable user service
  logs     Read or follow fail-closed-redacted service log output
  repair   Reconcile declared state and receipt-owned resources
  upgrade  Verify, stage, switch, health-check, and roll back a signed release (alias: update)
  uninstall Remove only receipt/hash/marker-owned resources; preserve data by default
  version  Print immutable build metadata
  doctor   Diagnose package, agents, state, service, and network without changing the machine
  help     Show this help

The ${PRODUCT_IDENTITY.aliasBinary} command is an installed alias for ${PRODUCT_IDENTITY.primaryBinary}.
`;
}

/**
 * This process's own artifact and runtime, resolved once per command.
 *
 * `process.execPath` is the cosyncing executable ONLY in the native distribution; for the published
 * JavaScript package it is Bun, and the application is the bundle Bun was handed. Every command below reads
 * `applicationPath` from here so the npm bin link, the `cosy` alias, the receipt-owned copy under
 * `~/.cosyncing/bin/`, and a contributor checkout all resolve through one rule.
 */
function applicationIdentity(buildInfo: Readonly<BuildInfo>): ApplicationIdentity {
  return currentApplicationIdentity(buildInfo.distribution, `${import.meta.dir}/cli.ts`);
}

async function defaultInspectRuntimeAssets(buildInfo: Readonly<BuildInfo>): Promise<CliRuntimeAssetReport> {
  const { inspectRuntimeAssets, resolveFlutterWebRoot } = await import('../runtime/runtime-assets.ts');
  const flutterWebRoot = resolveFlutterWebRoot({
    override: process.env.COSYNCING_WEB_DIR,
    packaged: buildInfo.packaged,
    executablePath: applicationIdentity(buildInfo).applicationPath,
    version: buildInfo.version,
    sourceRoot: `${import.meta.dir}/../../../../apps/client/build/web`,
  });
  return inspectRuntimeAssets({ flutterWebRoot });
}

async function defaultCollectDoctorReport(
  buildInfo: Readonly<BuildInfo>,
  assetReport: CliRuntimeAssetReport,
): Promise<CliDoctorReport> {
  const [{ collectDoctorReport }, { createSetupDiagnosisContext }] = await Promise.all([
    import('../installation/doctor.ts'),
    import('../installation/diagnosis-context.ts'),
  ]);
  return collectDoctorReport({
    buildInfo,
    assetReport: assetReport as Parameters<typeof collectDoctorReport>[0]['assetReport'],
    context: createSetupDiagnosisContext(),
  });
}

function versionJson(info: Readonly<BuildInfo>): string {
  return JSON.stringify(
    {
      schemaVersion: info.schemaVersion,
      product: PRODUCT_IDENTITY.productName,
      binary: PRODUCT_IDENTITY.primaryBinary,
      alias: PRODUCT_IDENTITY.aliasBinary,
      version: info.version,
      commit: info.commit,
      buildDate: info.buildDate,
      target: info.target,
      distribution: info.distribution,
      packaged: info.packaged,
      dirty: info.dirty,
      schemaVersions: info.schemaVersions,
      contract: info.contract,
    },
    null,
    2,
  );
}

async function defaultStartBroker(): Promise<BrokerRuntimeHandle> {
  const runtime = await import('../main.ts');
  return runtime.startBrokerRuntime();
}

async function defaultInstallSignalHandlers(runtime: BrokerRuntimeHandle): Promise<() => void> {
  const broker = await import('../main.ts');
  return broker.installBrokerSignalHandlers(runtime);
}

async function defaultRunSetup(options: {
  yes: boolean;
  acceptManagedRuntimeOwnership: boolean;
  enableSystemdLingering: boolean;
  enableTailscaleServe: boolean;
  installAgentSkill: boolean;
  opencodeShimSignal: OpencodeShimSignal;
  replaceLegacyPiBridge: boolean;
  upgradeLegacyAgentSkill: boolean;
  buildInfo: Readonly<BuildInfo>;
  stdout: CliWriter;
}): Promise<{ exitCode: number }> {
  const [{ runSetup }, presenters] = await Promise.all([
    import('../installation/setup.ts'),
    import('../installation/setup-presenter.ts'),
  ]);
  const presenter = options.yes
    ? presenters.createNonInteractiveSetupPresenter(options.stdout, {
        acceptManagedRuntimeOwnership: options.acceptManagedRuntimeOwnership,
        enableSystemdLingering: options.enableSystemdLingering,
        enableTailscaleServe: options.enableTailscaleServe,
        installAgentSkill: options.installAgentSkill,
        opencodeShim: options.opencodeShimSignal,
        replaceLegacyPiBridge: options.replaceLegacyPiBridge,
        upgradeLegacyAgentSkill: options.upgradeLegacyAgentSkill,
      })
    : presenters.createClackSetupPresenter();
  return runSetup({
    buildInfo: options.buildInfo,
    ...applicationLaunchInputs(options.buildInfo),
    presenter,
  });
}

async function defaultRunPair(options: {
  json: boolean;
  wait: boolean;
  clientLabel?: string;
  invocation: string;
  stdout: CliWriter;
  stderr: CliWriter;
}): Promise<{ exitCode: number }> {
  const { runPairCommand } = await import('./operator-commands.ts');
  return runPairCommand(options);
}

async function defaultRunDevicesList(options: {
  json: boolean;
  invocation: string;
  stdout: CliWriter;
  stderr: CliWriter;
}): Promise<{ exitCode: number }> {
  const { runDevicesListCommand } = await import('./operator-commands.ts');
  return runDevicesListCommand(options);
}

async function defaultRunDevicesRevoke(options: {
  peerId: string;
  yes: boolean;
  json: boolean;
  interactive: boolean;
  invocation: string;
  stdout: CliWriter;
  stderr: CliWriter;
}): Promise<{ exitCode: number }> {
  const { runDevicesRevokeCommand } = await import('./operator-commands.ts');
  return runDevicesRevokeCommand(options);
}

/**
 * What lifecycle commands must be told about this process: the application artifact, and the runtime that
 * has to execute it. Both come from the one identity resolver, so setup, status, repair, upgrade, logs, and
 * uninstall address exactly the same file with exactly the same launch model.
 */
function applicationLaunchInputs(
  buildInfo: Readonly<BuildInfo>,
): { executablePath: string; runtimePath?: string } {
  const identity = applicationIdentity(buildInfo);
  return {
    executablePath: identity.applicationPath,
    ...(identity.runtimePath ? { runtimePath: identity.runtimePath } : {}),
  };
}

function writeCommandResult<T extends { exitCode: number; summary?: string }>(
  value: T,
  json: boolean,
  stdout: CliWriter,
  stderr: CliWriter,
): void {
  if (json) {
    stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  (value.exitCode === 0 ? stdout : stderr).write(`${value.summary ?? 'Command completed.'}\n`);
}

async function defaultRunStatus(options: {
  json: boolean;
  invocation: string;
  stdout: CliWriter;
  stderr: CliWriter;
  buildInfo: Readonly<BuildInfo>;
}): Promise<{ exitCode: number }> {
  const lifecycle = await import('../installation/broker-lifecycle.ts');
  const report = await lifecycle.collectLifecycleStatus({
    buildInfo: options.buildInfo,
    ...applicationLaunchInputs(options.buildInfo),
  });
  if (options.json) options.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else options.stdout.write(lifecycle.renderLifecycleStatus(report, persistedCliLanguage()));
  return { exitCode: report.ok ? 0 : 1 };
}

async function defaultRunServiceCommand(options: {
  action: 'start' | 'stop' | 'restart';
  json: boolean;
  invocation: string;
  stdout: CliWriter;
  stderr: CliWriter;
  buildInfo: Readonly<BuildInfo>;
}): Promise<{ exitCode: number }> {
  const { runServiceCommand } = await import('../installation/broker-lifecycle.ts');
  const result = await runServiceCommand(options.action, {
    buildInfo: options.buildInfo,
    ...applicationLaunchInputs(options.buildInfo),
  });
  writeCommandResult(result, options.json, options.stdout, options.stderr);
  return result;
}

async function defaultRunLogs(options: {
  json: boolean;
  follow: boolean;
  lines: number;
  invocation: string;
  stdout: CliWriter;
  stderr: CliWriter;
  buildInfo: Readonly<BuildInfo>;
}): Promise<{ exitCode: number }> {
  const { readServiceLogs } = await import('../installation/broker-lifecycle.ts');
  const { result, output } = await readServiceLogs({
    buildInfo: options.buildInfo,
    ...applicationLaunchInputs(options.buildInfo),
    lines: options.lines,
    follow: options.follow,
    ...(options.follow ? { onOutput: (text: string) => options.stdout.write(text) } : {}),
  });
  if (options.json) options.stdout.write(`${JSON.stringify({ ...result, output }, null, 2)}\n`);
  else {
    writeCommandResult(result, false, options.stdout, options.stderr);
    if (output) options.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  }
  return result;
}

async function confirmAction(message: string): Promise<boolean> {
  const { confirm, isCancel } = await import('@clack/prompts');
  const answer = await confirm({ message, initialValue: false });
  return !isCancel(answer) && answer === true;
}

async function defaultRunRepair(options: {
  yes: boolean;
  allowLegacyIntegrations: boolean;
  json: boolean;
  interactive: boolean;
  invocation: string;
  stdout: CliWriter;
  stderr: CliWriter;
  buildInfo: Readonly<BuildInfo>;
}): Promise<{ exitCode: number }> {
  const lifecycle = await import('../installation/broker-lifecycle.ts');
  const base = { buildInfo: options.buildInfo, ...applicationLaunchInputs(options.buildInfo) };
  const plan = await lifecycle.inspectRepair(base);
  if (!options.json) {
    options.stdout.write(`Repair plan (${plan.actions.length} actions):\n${plan.actions.map((action) => `  - ${action.summary}`).join('\n') || '  - no mutations'}\n`);
  }
  const confirmed = options.yes || (options.interactive && await confirmAction('Apply this exact repair plan?'));
  let allowLegacy = options.allowLegacyIntegrations;
  if (confirmed && plan.actions.some((action) => action.legacy) && !allowLegacy && options.interactive) {
    allowLegacy = await confirmAction('Replace/remove only entries proven by the legacy cosyncing marker?');
  }
  const result = await lifecycle.runRepair({ ...base, confirmed, allowLegacyIntegrations: allowLegacy, expectedPlan: plan });
  writeCommandResult(result, options.json, options.stdout, options.stderr);
  return result;
}

async function defaultRunUpgrade(options: {
  yes: boolean;
  json: boolean;
  manifestUrl?: string;
  interactive: boolean;
  invocation: string;
  stdout: CliWriter;
  stderr: CliWriter;
  buildInfo: Readonly<BuildInfo>;
}): Promise<{ exitCode: number }> {
  const confirmed = options.yes || (options.interactive && await confirmAction('Download, verify, switch, and health-check the next signed cosyncing release?'));
  if (!confirmed) {
    const result = { schemaVersion: 1, status: 'cancelled', exitCode: 2, detailCode: 'upgrade-confirmation-required', summary: 'Upgrade was not confirmed.' };
    writeCommandResult(result, options.json, options.stdout, options.stderr);
    return result;
  }
  const [{ runUpgrade }, lifecycle] = await Promise.all([
    import('../updates/release-upgrade.ts'),
    import('../installation/broker-lifecycle.ts'),
  ]);
  const home = (await import('../installation/setup-state.ts')).setupStateHome();
  const setupState = (await import('../installation/setup-state.ts')).readSetupState(home);
  const service = (await import('../installation/setup-state.ts')).isDurableServiceChoice(setupState.serviceChoice)
    ? (() => {
        const provider = lifecycle.createLifecycleSystemdProvider({
          home,
          buildInfo: options.buildInfo,
          ...applicationLaunchInputs(options.buildInfo),
        });
        return {
          inspect: async () => ({ active: (await provider.inspect()).active === 'active' }),
          stop: () => provider.stop(),
          start: () => provider.start(),
        };
      })()
    : undefined;
  const result = await runUpgrade({
    home,
    buildInfo: options.buildInfo,
    ...applicationLaunchInputs(options.buildInfo),
    ...(options.manifestUrl ? { manifestUrl: options.manifestUrl } : {}),
    ...(service ? { service } : {}),
  });
  writeCommandResult(result, options.json, options.stdout, options.stderr);
  return result;
}

async function defaultRunUninstall(options: {
  yes: boolean;
  allowLegacyIntegrations: boolean;
  purgeData: boolean;
  confirmPurgeData: boolean;
  json: boolean;
  interactive: boolean;
  invocation: string;
  stdout: CliWriter;
  stderr: CliWriter;
  buildInfo: Readonly<BuildInfo>;
}): Promise<{ exitCode: number }> {
  const lifecycle = await import('../installation/broker-lifecycle.ts');
  const language = persistedCliLanguage();
  const text = cliMessages(language).uninstall;
  const base = { buildInfo: options.buildInfo, ...applicationLaunchInputs(options.buildInfo) };
  const plan = await lifecycle.inspectUninstall({ ...base, purgeData: options.purgeData });
  if (!options.json) {
    options.stdout.write(renderUninstallPlan(plan, language));
  }
  const confirmed = options.yes || (options.interactive && await confirmAction(text.confirmOwned));
  let allowLegacy = options.allowLegacyIntegrations;
  if (confirmed && plan.actions.some((action) => action.legacy) && !allowLegacy && options.interactive) {
    allowLegacy = await confirmAction(text.confirmLegacy);
  }
  let purgeConfirmed = options.confirmPurgeData;
  if (confirmed && options.purgeData && !purgeConfirmed && options.interactive) {
    purgeConfirmed = await confirmAction(text.confirmPurge);
  }
  const result = await lifecycle.runUninstall({
    ...base,
    confirmed,
    allowLegacyIntegrations: allowLegacy,
    purgeData: options.purgeData,
    purgeConfirmed,
    expectedPlan: plan,
  });
  // In JSON mode the pre-confirmation plan display is suppressed, so carry the disconnection advisories on
  // the result object — with --json --yes they would otherwise be invisible everywhere.
  if (options.json) {
    writeCommandResult({ ...result, advisories: plan.advisories }, true, options.stdout, options.stderr);
  } else {
    (result.exitCode === 0 ? options.stdout : options.stderr).write(`${renderUninstallResult(result, {
      purgeData: options.purgeData,
      acquisitionPackagePreserved: plan.advisories.some(
        (item) => item.detailCode === 'acquisition-package-preserved',
      ),
    }, language)}\n`);
  }
  return result;
}

export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? terminalWriter(process.stdout);
  const stderr = dependencies.stderr ?? terminalWriter(process.stderr);
  const buildInfo = dependencies.buildInfo ?? BUILD_INFO;
  const command = invocationName(dependencies.invocation, applicationIdentity(buildInfo).applicationPath);
  const [rawRequested = 'help', ...args] = argv;
  const requested = rawRequested === 'update' ? 'upgrade' : rawRequested;

  if (requested === 'help' || requested === '--help' || requested === '-h') {
    if (args.length > 0) {
      stderr.write(`${command}: help takes no arguments\n`);
      return 2;
    }
    stdout.write(help(command, buildInfo.packaged));
    return 0;
  }

  if (requested === 'version' || requested === '--version' || requested === '-V') {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
      stderr.write(`${command}: version accepts only --json\n`);
      return 2;
    }
    if (args[0] === '--json') {
      stdout.write(`${versionJson(buildInfo)}\n`);
    } else {
      const commit = buildInfo.dirty ? `${buildInfo.commit}+dirty` : buildInfo.commit;
      stdout.write(`${PRODUCT_IDENTITY.productName} ${buildInfo.version} (${commit}, ${buildInfo.target})\n`);
    }
    return 0;
  }

  if (requested === 'doctor') {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
      stderr.write(`${command}: doctor accepts only --json\n`);
      return 2;
    }
    try {
      const assets = await (dependencies.inspectRuntimeAssets ?? defaultInspectRuntimeAssets)(buildInfo);
      const report = await (dependencies.collectDoctorReport ?? defaultCollectDoctorReport)(buildInfo, assets);
      if (args[0] === '--json') {
        stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        if (dependencies.renderDoctorReport) {
          stdout.write(dependencies.renderDoctorReport(report));
        } else {
          const { doctorColorEnabled, renderDoctorReport } = await import('../installation/doctor.ts');
          // Colour is a property of the real terminal, so it is decided only when this process owns the
          // stream. An injected writer is a buffer whose destination this file knows nothing about, and
          // process.stdout.isTTY would say nothing true about it.
          const color = dependencies.colorize
            ?? (!dependencies.stdout && doctorColorEnabled({ env: process.env, tty: process.stdout.isTTY === true }));
          stdout.write(renderDoctorReport(report as Parameters<typeof renderDoctorReport>[0], {
            color,
            language: persistedCliLanguage(),
          }));
        }
      }
      return report.ok ? 0 : 1;
    } catch {
      const failure = {
        schemaVersion: 1,
        product: PRODUCT_IDENTITY.productName,
        version: buildInfo.version,
        effects: 'forbidden',
        ok: false,
        detailCode: 'doctor-internal-error',
        summary: 'Doctor could not complete its read-only inspection.',
        remediation: { kind: 'command', command: 'cosyncing repair', message: 'Repair the installation, then rerun doctor.' },
      } as const;
      if (args[0] === '--json') stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
      else {
        const text = cliMessages(persistedCliLanguage()).doctor;
        stderr.write(`${text.internalFailureSummary}\n${text.fixLabel} ${text.remediation({
          id: 'doctor.internal',
          status: 'fail',
          detailCode: failure.detailCode,
          summary: failure.summary,
          remediation: failure.remediation,
        })} (${failure.remediation.command})\n`);
      }
      return 1;
    }
  }

  if (requested === 'setup') {
    const allowed = new Set([
      '--yes',
      '--accept-managed-runtime-ownership',
      '--enable-systemd-lingering',
      '--enable-tailscale-serve',
      '--no-install-agent-skill',
      '--install-opencode-shim',
      '--no-install-opencode-shim',
      '--replace-legacy-pi-bridge',
      '--upgrade-legacy-agent-skill',
    ]);
    const unknown = args.find((arg) => !allowed.has(arg));
    const duplicates = args.some((arg, index) => args.indexOf(arg) !== index);
    if (unknown || duplicates) {
      stderr.write(`${command}: setup received an unknown or duplicate option${unknown ? ` ${JSON.stringify(unknown)}` : ''}\n`);
      return 2;
    }
    const yes = args.includes('--yes');
    const acceptManagedRuntimeOwnership = args.includes('--accept-managed-runtime-ownership');
    const enableSystemdLingering = args.includes('--enable-systemd-lingering');
    const enableTailscaleServe = args.includes('--enable-tailscale-serve');
    const installAgentSkill = !args.includes('--no-install-agent-skill');
    const replaceLegacyPiBridge = args.includes('--replace-legacy-pi-bridge');
    const upgradeLegacyAgentSkill = args.includes('--upgrade-legacy-agent-skill');
    // Tri-state consent. If both flags are passed, --no- wins deterministically. 'unset' (neither) never
    // silently enables in the non-interactive path — the presenter honors only a prior stored opt-in.
    const opencodeShimSignal: OpencodeShimSignal = args.includes('--no-install-opencode-shim')
      ? 'off'
      : args.includes('--install-opencode-shim')
        ? 'on'
        : 'unset';
    // Non-interactive negative flags require --yes; the bare positive opt-in (--install-opencode-shim) does not
    // — it only informs the non-interactive presenter and is inert in the interactive (clack) path.
    if (!yes && (acceptManagedRuntimeOwnership || enableSystemdLingering || enableTailscaleServe
      || !installAgentSkill || opencodeShimSignal === 'off' || replaceLegacyPiBridge || upgradeLegacyAgentSkill)) {
      stderr.write(`${command}: non-interactive setup flags require --yes\n`);
      return 2;
    }
    if (yes && !acceptManagedRuntimeOwnership) {
      stderr.write(JSON.stringify({
        schemaVersion: 1,
        detailCode: 'managed-runtime-ownership-acknowledgement-required',
        message: `${command} setup --yes requires --accept-managed-runtime-ownership.`,
      }) + '\n');
      return 2;
    }
    if (!yes && !dependencies.runSetup && !process.stdin.isTTY) {
      stderr.write(`${command} setup requires an interactive terminal; use --yes --accept-managed-runtime-ownership for safe non-interactive defaults.\n`);
      return 2;
    }
    try {
      const setup = dependencies.runSetup
        ? await dependencies.runSetup({
            yes,
            acceptManagedRuntimeOwnership,
            enableSystemdLingering,
            enableTailscaleServe,
            installAgentSkill,
            opencodeShimSignal,
            replaceLegacyPiBridge,
            upgradeLegacyAgentSkill,
          })
        : await defaultRunSetup({
            yes,
            acceptManagedRuntimeOwnership,
            enableSystemdLingering,
            enableTailscaleServe,
            installAgentSkill,
            opencodeShimSignal,
            replaceLegacyPiBridge,
            upgradeLegacyAgentSkill,
            buildInfo,
            stdout,
          });
      return setup.exitCode;
    } catch {
      stderr.write(`${PRODUCT_IDENTITY.productName} setup failed before mutation. Run '${command} doctor' for details.\n`);
      return 1;
    }
  }

  if (requested === 'pair') {
    let json = false;
    let wait = false;
    let clientLabel: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === '--json' && !json) { json = true; continue; }
      if (arg === '--wait' && !wait) { wait = true; continue; }
      if (arg === '--label' && clientLabel === undefined) {
        const value = args[index + 1]?.trim();
        if (!value || value.startsWith('--') || value.length > 128 || /[\0\r\n]/.test(value)) {
          stderr.write(`${command} pair: --label requires a device label of at most 128 characters\n`);
          return 2;
        }
        clientLabel = value;
        index += 1;
        continue;
      }
      stderr.write(`${command} pair: unknown or duplicate option ${JSON.stringify(arg)}\n`);
      return 2;
    }
    const pair = await (dependencies.runPair ?? defaultRunPair)({
      json,
      wait,
      ...(clientLabel ? { clientLabel } : {}),
      invocation: command,
      stdout,
      stderr,
    });
    return pair.exitCode;
  }

  if (requested === 'devices') {
    const [subcommand, ...deviceArgs] = args;
    if (subcommand === 'list') {
      if (deviceArgs.length > 1 || (deviceArgs.length === 1 && deviceArgs[0] !== '--json')) {
        stderr.write(`${command} devices list: accepts only --json\n`);
        return 2;
      }
      const listed = await (dependencies.runDevicesList ?? defaultRunDevicesList)({
        json: deviceArgs[0] === '--json',
        invocation: command,
        stdout,
        stderr,
      });
      return listed.exitCode;
    }
    if (subcommand === 'revoke') {
      const [peerId, ...flags] = deviceArgs;
      if (!peerId || peerId.startsWith('--')) {
        stderr.write(`${command} devices revoke: a device id is required\n`);
        return 2;
      }
      const allowed = new Set(['--yes', '--json']);
      if (flags.some((flag) => !allowed.has(flag)) || flags.some((flag, index) => flags.indexOf(flag) !== index)) {
        stderr.write(`${command} devices revoke: unknown or duplicate option\n`);
        return 2;
      }
      const revoked = await (dependencies.runDevicesRevoke ?? defaultRunDevicesRevoke)({
        peerId,
        yes: flags.includes('--yes'),
        json: flags.includes('--json'),
        interactive: process.stdin.isTTY,
        invocation: command,
        stdout,
        stderr,
      });
      return revoked.exitCode;
    }
    stderr.write(`${command} devices: expected 'list' or 'revoke <id>'\n`);
    return 2;
  }

  if (requested === 'status') {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
      stderr.write(`${command} status: accepts only --json\n`);
      return 2;
    }
    return (await (dependencies.runStatus ?? ((options) => defaultRunStatus({ ...options, buildInfo })))(
      { json: args[0] === '--json', invocation: command, stdout, stderr },
    )).exitCode;
  }

  if (requested === 'start' || requested === 'stop' || requested === 'restart') {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
      stderr.write(`${command} ${requested}: accepts only --json\n`);
      return 2;
    }
    return (await (dependencies.runServiceCommand ?? ((options) => defaultRunServiceCommand({ ...options, buildInfo })))(
      { action: requested, json: args[0] === '--json', invocation: command, stdout, stderr },
    )).exitCode;
  }

  if (requested === 'logs') {
    let json = false;
    let follow = false;
    let lines = 200;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === '--json' && !json) { json = true; continue; }
      if (arg === '--follow' && !follow) { follow = true; continue; }
      if (arg === '--lines' && lines === 200) {
        const value = args[index + 1];
        if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 10_000) {
          stderr.write(`${command} logs: --lines requires an integer from 1 to 10000\n`);
          return 2;
        }
        lines = Number(value);
        index += 1;
        continue;
      }
      stderr.write(`${command} logs: unknown or duplicate option ${JSON.stringify(arg)}\n`);
      return 2;
    }
    if (json && follow) {
      stderr.write(`${command} logs: --json cannot be combined with --follow\n`);
      return 2;
    }
    return (await (dependencies.runLogs ?? ((options) => defaultRunLogs({ ...options, buildInfo })))(
      { json, follow, lines, invocation: command, stdout, stderr },
    )).exitCode;
  }

  if (requested === 'repair') {
    const allowed = new Set(['--yes', '--accept-legacy-integrations', '--json']);
    if (args.some((arg) => !allowed.has(arg)) || args.some((arg, index) => args.indexOf(arg) !== index)) {
      stderr.write(`${command} repair: unknown or duplicate option\n`);
      return 2;
    }
    const yes = args.includes('--yes');
    const json = args.includes('--json');
    const allowLegacyIntegrations = args.includes('--accept-legacy-integrations');
    if (allowLegacyIntegrations && !yes) {
      stderr.write(`${command} repair: --accept-legacy-integrations requires --yes in non-interactive form\n`);
      return 2;
    }
    if (!yes && !process.stdin.isTTY && !dependencies.runRepair) {
      stderr.write(`${command} repair requires an interactive terminal or --yes\n`);
      return 2;
    }
    if (json && !yes && !dependencies.runRepair) {
      stderr.write(`${command} repair: --json requires --yes so prompts cannot corrupt JSON output\n`);
      return 2;
    }
    return (await (dependencies.runRepair ?? ((options) => defaultRunRepair({ ...options, buildInfo })))(
      { yes, allowLegacyIntegrations, json, interactive: process.stdin.isTTY, invocation: command, stdout, stderr },
    )).exitCode;
  }

  if (requested === 'upgrade') {
    let yes = false;
    let json = false;
    let manifestUrl: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === '--yes' && !yes) { yes = true; continue; }
      if (arg === '--json' && !json) { json = true; continue; }
      if (arg === '--manifest' && manifestUrl === undefined) {
        const value = args[index + 1];
        try {
          const parsed = value ? new URL(value) : undefined;
          if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('invalid');
        } catch {
          stderr.write(`${command} upgrade: --manifest requires a credential-free HTTPS URL\n`);
          return 2;
        }
        manifestUrl = value;
        index += 1;
        continue;
      }
      stderr.write(`${command} upgrade: unknown or duplicate option ${JSON.stringify(arg)}\n`);
      return 2;
    }
    if (!yes && !process.stdin.isTTY && !dependencies.runUpgrade) {
      stderr.write(`${command} upgrade requires an interactive terminal or --yes\n`);
      return 2;
    }
    if (json && !yes && !dependencies.runUpgrade) {
      stderr.write(`${command} upgrade: --json requires --yes so prompts cannot corrupt JSON output\n`);
      return 2;
    }
    return (await (dependencies.runUpgrade ?? ((options) => defaultRunUpgrade({ ...options, buildInfo })))(
      { yes, json, ...(manifestUrl ? { manifestUrl } : {}), interactive: process.stdin.isTTY, invocation: command, stdout, stderr },
    )).exitCode;
  }

  if (requested === 'uninstall') {
    const allowed = new Set(['--yes', '--accept-legacy-integrations', '--purge-data', '--confirm-purge-data', '--json']);
    if (args.some((arg) => !allowed.has(arg)) || args.some((arg, index) => args.indexOf(arg) !== index)) {
      stderr.write(`${command} uninstall: unknown or duplicate option\n`);
      return 2;
    }
    const yes = args.includes('--yes');
    const allowLegacyIntegrations = args.includes('--accept-legacy-integrations');
    const purgeData = args.includes('--purge-data');
    const confirmPurgeData = args.includes('--confirm-purge-data');
    const json = args.includes('--json');
    if ((allowLegacyIntegrations || confirmPurgeData) && !yes) {
      stderr.write(`${command} uninstall: non-interactive confirmation flags require --yes\n`);
      return 2;
    }
    if (confirmPurgeData && !purgeData) {
      stderr.write(`${command} uninstall: --confirm-purge-data requires --purge-data\n`);
      return 2;
    }
    if (!yes && !process.stdin.isTTY && !dependencies.runUninstall) {
      stderr.write(`${command} uninstall requires an interactive terminal or --yes\n`);
      return 2;
    }
    if (json && !yes && !dependencies.runUninstall) {
      stderr.write(`${command} uninstall: --json requires --yes so prompts cannot corrupt JSON output\n`);
      return 2;
    }
    return (await (dependencies.runUninstall ?? ((options) => defaultRunUninstall({ ...options, buildInfo })))(
      { yes, allowLegacyIntegrations, purgeData, confirmPurgeData, json, interactive: process.stdin.isTTY, invocation: command, stdout, stderr },
    )).exitCode;
  }

  if (requested !== 'broker') {
    stderr.write(`${command}: unknown command ${JSON.stringify(requested)}\nRun '${command} help' for usage.\n`);
    return 2;
  }

  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    stdout.write(help(command, buildInfo.packaged));
    return 0;
  }

  const allowedFlags = new Set(['--dev-bypass-first-run']);
  const unknown = args.filter((arg) => !allowedFlags.has(arg));
  if (unknown.length > 0) {
    stderr.write(`${command} broker: unknown option ${JSON.stringify(unknown[0])}\n`);
    return 2;
  }
  const devBypass = args.includes('--dev-bypass-first-run');
  if (devBypass && buildInfo.packaged) {
    stderr.write(`${command} broker: --dev-bypass-first-run is unavailable in packaged builds\n`);
    return 2;
  }

  const inspection = (dependencies.inspectInstallState ?? inspectInstallState)();
  if (!inspection.committed && !devBypass) {
    stderr.write(
      `${PRODUCT_IDENTITY.productName} setup is incomplete (${inspection.reason}). ` +
        `Run '${PRODUCT_IDENTITY.primaryBinary} setup' before starting the broker.\n`,
    );
    return 1;
  }

  if (devBypass) process.env.COSYNCING_DEV_MODE = '1';

  try {
    const runtime = await (dependencies.startBroker ?? defaultStartBroker)();
    const removeSignalHandlers = dependencies.installSignalHandlers
      ? dependencies.installSignalHandlers(runtime)
      : await defaultInstallSignalHandlers(runtime);
    try {
      await runtime.closed;
    } finally {
      removeSignalHandlers();
    }
    return 0;
  } catch (error) {
    stderr.write(`${PRODUCT_IDENTITY.productName} broker failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
