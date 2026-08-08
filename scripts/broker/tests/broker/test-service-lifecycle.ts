#!/usr/bin/env bun
/** Durable-service acceptance: typed systemd rendering, lifecycle, rollback, ownership, and WSL. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { SetupDiagnosisContext } from '../../../../packages/typescript/adapter-api/src/index.ts';
import { BUILD_INFO, buildFingerprint, type BuildInfo } from '../../../../packages/typescript/broker/src/build-info.ts';
import { defaultBrokerConfig } from '../../../../packages/typescript/broker/src/configuration.ts';
import { createSetupDiagnosisContext } from '../../../../packages/typescript/broker/src/diagnosis-context.ts';
import { collectDoctorReport } from '../../../../packages/typescript/broker/src/doctor.ts';
import { inspectRepair, runRepair } from '../../../../packages/typescript/broker/src/broker-lifecycle.ts';
import { inspectInstallState } from '../../../../packages/typescript/broker/src/install-state.ts';
import { inspectRuntimeAssets } from '../../../../packages/typescript/broker/src/runtime-assets.ts';
import { atomicWriteOwnerOnly } from '../../../../packages/typescript/broker/src/secure-files.ts';
import {
  LaunchdUserServiceProvider,
  SystemdUserServiceProvider,
  awaitServiceState,
  brokerServiceEnvironmentEntries,
  createServiceCommandRunner,
  parseLaunchdPrintState,
  serviceAgentExecutableDirectories,
  serviceAgentExecutableOverrides,
  type DurableServiceProvider,
  type DurableServiceStatus,
  type ServiceCommandResult,
  type ServiceCommandRunner,
  type ServiceLogsRequest,
  type ServiceAgentExecutableOverrides,
  type SystemdProviderOptions,
} from '../../../../packages/typescript/broker/src/service-manager.ts';
import {
  buildSetupPlan,
  existingSetupChoices,
  inspectSetupEnvironment,
  runSetup,
  SETUP_PROMPT_CANCELLED,
  type SetupCommandResult,
  type SetupInspection,
  type SetupPlan,
  type SetupPresenter,
  type SetupPromptResult,
  type SetupServiceChoice,
} from '../../../../packages/typescript/broker/src/setup.ts';
import { readSetupState } from '../../../../packages/typescript/broker/src/setup-state.ts';
import type { SetupLanguage } from '../../../../packages/typescript/broker/src/setup-i18n.ts';
import {
  type AdvertisedEndpointPollingClock,
  type TailscaleServeInspection,
  type TailscaleServeRouteProvider,
} from '../../../../packages/typescript/broker/src/tailscale-serve.ts';
import {
  readSetupFailureDiagnostic,
  readSetupTransactionJournal,
  setupFailureDiagnosticPath,
  type SetupTransactionContext,
} from '../../../../packages/typescript/broker/src/setup-transaction.ts';
import { createSystemdSetupAction } from '../../../../packages/typescript/broker/src/service-manager.ts';

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const FIXED_DATE = new Date('2026-07-17T15:00:00.000Z');
const now = (): Date => new Date(FIXED_DATE);

class ServicePresenter implements SetupPresenter {
  readonly calls: string[] = [];
  lastResult?: SetupCommandResult;

  constructor(readonly choices: {
    service?: SetupServiceChoice;
    cancelService?: boolean;
    quota?: boolean;
    tailscale?: boolean;
  } = {}) {}

  async chooseLanguage(): Promise<SetupLanguage> { this.calls.push('language'); return 'en'; }
  intro(): void { this.calls.push('intro'); }
  showBlockers(): void { this.calls.push('blockers'); }
  async confirmManagedRuntime(): Promise<boolean> { this.calls.push('ack'); return true; }
  async confirmAgentSkill(): Promise<boolean> { this.calls.push('skill'); return true; }
  async confirmOpencodeShim(): Promise<boolean> { this.calls.push('opencode-shim'); return true; }
  async chooseService(): Promise<SetupPromptResult<SetupServiceChoice>> {
    this.calls.push('service');
    if (this.choices.cancelService) return SETUP_PROMPT_CANCELLED;
    return this.choices.service ?? 'systemd';
  }
  async confirmTailscale(): Promise<boolean> { this.calls.push('tailscale'); return this.choices.tailscale ?? false; }
  async confirmQuotaWarnings(): Promise<boolean> { this.calls.push('quota'); return this.choices.quota ?? false; }
  showPlan(_plan: Readonly<SetupPlan>, _inspection: Readonly<SetupInspection>): void { this.calls.push('plan'); }
  async confirmApply(): Promise<boolean> { this.calls.push('confirm'); return true; }
  recoveredInterruptedTransaction(): void { this.calls.push('recovered'); }
  complete(result: Readonly<SetupCommandResult>): void { this.calls.push('complete'); this.lastResult = { ...result }; }
  cancelled(stage: string): void { this.calls.push(`cancelled:${stage}`); }
  failed(result: Readonly<SetupCommandResult>): void { this.calls.push('failed'); this.lastResult = { ...result }; }
}

function fileState(path: string, expected: string): DurableServiceStatus['definition'] {
  if (!existsSync(path)) return 'missing';
  try { return readFileSync(path, 'utf8') === expected ? 'current' : 'drifted'; } catch { return 'unsafe'; }
}

class FakeServiceProvider implements DurableServiceProvider {
  readonly id: DurableServiceProvider['id'] = 'systemd';
  readonly serviceName: string = 'cosyncing.service';
  definitionPath: string;
  readonly environmentPath: string;
  readonly persistenceTarget: string = 'systemd-user-linger:fixture';
  readonly events: string[] = [];
  enabled: DurableServiceStatus['enabled'] = 'disabled';
  active: DurableServiceStatus['active'] = 'inactive';
  lingering: DurableServiceStatus['lingering'] = 'disabled';
  supported = true;
  healthOk = true;

  constructor(readonly root: string) {
    this.definitionPath = join(root, '.config', 'systemd', 'user', 'cosyncing.service');
    this.environmentPath = join(root, '.cosyncing', 'service', 'broker.env');
  }

  logsCommand(request: Readonly<ServiceLogsRequest>): readonly string[] {
    return request.follow
      ? ['/usr/bin/journalctl', '--user', '-u', 'cosyncing.service', '-f']
      : ['/usr/bin/journalctl', '--user', '-u', 'cosyncing.service', '-n', String(request.lines), '--no-pager'];
  }
  expectedDefinition(): string {
    return '[Unit]\nDescription=cosyncing fixture\n[Service]\nExecStart="/fixture/cosyncing" broker\n';
  }
  expectedEnvironment(): string {
    return 'HOME="/fixture/home"\nCOSYNCING_HOME="/fixture/home/.cosyncing"\n';
  }
  async inspect(): Promise<DurableServiceStatus> {
    return {
      provider: 'systemd',
      supported: this.supported,
      definition: fileState(this.definitionPath, this.expectedDefinition()),
      environment: fileState(this.environmentPath, this.expectedEnvironment()),
      enabled: this.enabled,
      active: this.active,
      lingering: this.lingering,
    };
  }
  async installDefinition(): Promise<void> {
    this.events.push('install');
    atomicWriteOwnerOnly(this.definitionPath, this.expectedDefinition(), { mode: 0o600 });
    atomicWriteOwnerOnly(this.environmentPath, this.expectedEnvironment(), { mode: 0o600 });
    this.enabled = 'enabled';
  }
  async reloadDefinition(): Promise<void> { this.events.push('reload'); }
  async setEnabled(enabled: boolean): Promise<void> {
    this.events.push(enabled ? 'enable' : 'disable');
    this.enabled = enabled ? 'enabled' : 'disabled';
  }
  async enableLingering(): Promise<void> { this.events.push('enable-linger'); this.lingering = 'enabled'; }
  async disableLingering(): Promise<void> { this.events.push('disable-linger'); this.lingering = 'disabled'; }
  async start(): Promise<void> { this.events.push('start'); this.active = 'active'; }
  async stop(): Promise<void> { this.events.push('stop'); this.active = 'inactive'; }
  async restart(): Promise<void> { this.events.push('restart'); this.active = 'active'; }
  async uninstall(): Promise<void> {
    this.events.push('uninstall');
    this.active = 'inactive';
    this.enabled = 'disabled';
    for (const path of [this.definitionPath, this.environmentPath]) {
      if (existsSync(path)) unlinkSync(path);
    }
  }
}

/** The real environment renderer over a fixture machine, so doctor inspects the bytes setup would write. */
function fixtureServiceEnvironment(root: string, options: {
  agentDirectories: readonly string[];
  agentOverrides: Readonly<ServiceAgentExecutableOverrides>;
  runtimePath?: string | undefined;
}): string {
  const entries = brokerServiceEnvironmentEntries({
    homeDir: root,
    stateHome: join(root, '.cosyncing'),
    cacheRoot: join(root, '.cache', 'cosyncing'),
    executablePath: join(root, '.cosyncing', 'bin', 'cosyncing'),
    agentExecutableDirectories: options.agentDirectories,
    agentExecutableOverrides: options.agentOverrides,
    webDir: join(root, 'cosyncing-web'),
    ...(options.runtimePath ? { runtimePath: options.runtimePath } : {}),
  });
  return `${entries.map(([name, value]) => `${name}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join('\n')}\n`;
}

class AgentPathServiceProvider extends FakeServiceProvider {
  agentDirectories: readonly string[] = [];
  agentOverrides: Readonly<ServiceAgentExecutableOverrides> = {};
  runtimePath: string | undefined;

  override expectedEnvironment(): string {
    return fixtureServiceEnvironment(this.root, this);
  }
}

/** The launchd twin of FakeServiceProvider: same in-memory posture, launchd's id/paths/lingering answer. */
class FakeLaunchdProvider extends FakeServiceProvider {
  override readonly id = 'launchd' as const;
  override readonly serviceName = 'dev.cosyncing.broker';
  override readonly persistenceTarget = 'launchd-gui-session:501';

  constructor(root: string) {
    super(root);
    this.definitionPath = join(root, 'Library', 'LaunchAgents', 'dev.cosyncing.broker.plist');
    this.lingering = 'unsupported';
  }

  override logsCommand(request: Readonly<ServiceLogsRequest>): readonly string[] {
    const logs = join(this.root, '.cosyncing', 'logs');
    return ['/usr/bin/tail', ...(request.follow ? ['-f'] : []), '-n', String(request.lines),
      join(logs, 'broker.out.log'), join(logs, 'broker.err.log')];
  }
  override expectedDefinition(): string {
    return '<plist version="1.0"><dict><key>Label</key><string>dev.cosyncing.broker</string></dict></plist>\n';
  }
  /** `bootstrap` starts the job as it loads it, so a fake install must reproduce that or the posture lies. */
  override async installDefinition(): Promise<void> {
    await super.installDefinition();
    this.active = 'active';
  }
  /**
   * launchd's reload is bootout + bootstrap, and RunAtLoad starts the job as part of loading it — so a
   * reload leaves the agent enabled AND running. Reproducing that here is what makes a rollback that
   * assumes reload is posture-neutral actually fail in this suite instead of only on a Mac.
   */
  override async reloadDefinition(): Promise<void> {
    await super.reloadDefinition();
    const loaded = existsSync(this.definitionPath);
    this.enabled = loaded ? 'enabled' : 'disabled';
    this.active = loaded ? 'active' : 'inactive';
  }
  /** Disabling boots the job out of the domain, so it stops as well. */
  override async setEnabled(enabled: boolean): Promise<void> {
    await super.setEnabled(enabled);
    if (!enabled) this.active = 'inactive';
  }
  override async enableLingering(): Promise<void> { throw new Error('launchd-lingering-unsupported'); }
  override async disableLingering(): Promise<void> { throw new Error('launchd-lingering-unsupported'); }
}

/** The launchd twin of AgentPathServiceProvider: the same rendered environment behind launchd receipts. */
class AgentPathLaunchdProvider extends FakeLaunchdProvider {
  agentDirectories: readonly string[] = [];
  agentOverrides: Readonly<ServiceAgentExecutableOverrides> = {};
  runtimePath: string | undefined;

  override expectedEnvironment(): string {
    return fixtureServiceEnvironment(this.root, this);
  }
}

class FakeTailscaleProvider implements TailscaleServeRouteProvider {
  route: 'missing' | 'desired' = 'missing';
  readonly events: string[] = [];
  readonly advertisedUrl = 'https://devbox.tailnet.ts.net';
  readonly desiredTarget = defaultBrokerConfig().broker.internalUrl;

  async inspect(): Promise<TailscaleServeInspection> {
    return {
      schemaVersion: 1,
      topology: 'native-macos',
      backend: 'running',
      executablePath: '/usr/bin/tailscale',
      dnsName: 'devbox.tailnet.ts.net',
      advertisedUrl: this.advertisedUrl,
      httpsCapability: 'ready',
      route: this.route,
      ...(this.route === 'desired' ? { routeTarget: this.desiredTarget } : {}),
      desiredTarget: this.desiredTarget,
      detailCode: this.route === 'desired' ? 'tailscale-serve-route-ready' : 'tailscale-serve-route-missing',
      summary: `${this.route} fixture`,
    };
  }
  async registerPrivateHttpsRoot(): Promise<void> { this.events.push('register'); this.route = 'desired'; }
  async removePrivateHttpsRoot(): Promise<void> { this.events.push('remove'); this.route = 'missing'; }
}

/** Deterministic timer ownership for setup's advertised-endpoint deadline. */
class ImmediatePollingClock implements AdvertisedEndpointPollingClock {
  timeMs = 0;
  schedules = 0;
  cancellations = 0;
  private nextHandle = 0;
  readonly pending = new Set<number>();

  now(): number { return this.timeMs; }
  schedule(callback: () => void, delayMs: number): number {
    const handle = ++this.nextHandle;
    this.schedules += 1;
    this.pending.add(handle);
    queueMicrotask(() => {
      if (!this.pending.delete(handle)) return;
      this.timeMs += delayMs;
      callback();
    });
    return handle;
  }
  cancel(handle: unknown): void {
    this.cancellations += 1;
    this.pending.delete(handle as number);
  }
}

/**
 * launchd's RunAtLoad spawn is ASYNCHRONOUS: `bootstrap` returns while the job is still `spawn scheduled`,
 * and a `launchctl kill` aimed at it finds no process while the queued spawn intent survives. That is the
 * exact shape that stranded a real Mac in `spawn scheduled` limbo, and modelling it here is what makes a
 * rollback that stops the job mid-spawn fail in this suite instead of only on hardware.
 */
class SpawningLaunchdProvider extends FakeLaunchdProvider {
  /** Inspects still owed before the queued spawn completes; polling is what advances it, as in reality. */
  spawnLag = 0;

  override async inspect(): Promise<DurableServiceStatus> {
    const status = await super.inspect();
    if (this.spawnLag <= 0) return status;
    this.spawnLag -= 1;
    return { ...status, active: 'transitioning' };
  }
  override async reloadDefinition(): Promise<void> {
    await super.reloadDefinition();
    if (existsSync(this.definitionPath)) this.spawnLag = 3;
  }
  override async stop(): Promise<void> {
    if (this.spawnLag > 0) {
      // The signal lands on a job with no process yet; launchd keeps the spawn queued and nothing stops.
      this.events.push('stop-mid-spawn');
      return;
    }
    await super.stop();
  }
}

function contextFor(options: {
  root: string;
  provider?: FakeServiceProvider;
  tailscale?: FakeTailscaleProvider;
  advertisedHealth?: () => Awaited<ReturnType<SetupDiagnosisContext['fetchJson']>>;
  systemd?: boolean;
  wsl?: boolean;
  platform?: string;
  agentExecutables?: Partial<Record<'codex' | 'opencode' | 'pi' | 'claude', string>>;
  /**
   * The BUILD the healthy loopback broker answers as. A real `/api/health` always identifies the artifact
   * serving it, and setup's post-commit check binds that to the artifact it just installed — so a fixture
   * that omits it models a broker no release ever shipped. Defaults to the fixture's own build; override it
   * to model a previous build that survived the replacement and kept the port.
   */
  healthBuild?: Readonly<Omit<BuildInfo, 'schemaVersions' | 'contract'>>;
}): SetupDiagnosisContext {
  const healthBody = (): Record<string, unknown> => {
    const build = options.healthBuild ?? BUILD_INFO;
    return {
      ok: true,
      product: 'cosyncing',
      machine: defaultBrokerConfig().broker.machineLabel,
      version: build.version,
      commit: build.commit,
      // Derived from the same single definition the broker uses, never hand-listed here.
      buildFingerprint: buildFingerprint(build),
    };
  };
  const tailscaleReadOnly = (args: readonly string[]) => {
    if (args[0] === 'status') {
      return {
        status: 'ok' as const,
        exitCode: 0,
        stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'devbox.tailnet.ts.net.' } }),
        stderr: '',
      };
    }
    const desiredTarget = options.tailscale?.desiredTarget ?? defaultBrokerConfig().broker.internalUrl;
    const configured = options.tailscale?.route === 'desired';
    return {
      status: 'ok' as const,
      exitCode: 0,
      stdout: JSON.stringify(configured ? {
        TCP: { '443': { HTTPS: true } },
        Web: {
          'devbox.tailnet.ts.net:443': { Handlers: { '/': { Proxy: desiredTarget } } },
        },
      } : {}),
      stderr: '',
    };
  };
  const fetchHealth = async (url: string) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'devbox.tailnet.ts.net') {
      return options.advertisedHealth?.() ?? { status: 'unreachable' as const };
    }
    if (parsed.pathname === '/api/health' && options.provider?.active === 'active' && options.provider.healthOk) {
      return { status: 'ok' as const, statusCode: 200, json: healthBody() };
    }
    return { status: 'unreachable' as const };
  };
  if (options.platform === 'darwin') {
    const darwin = darwinContext(options.root);
    return {
      ...darwin,
      env: {
        ...darwin.env,
        COSYNCING_CACHE_DIR: join(options.root, '.cache', 'cosyncing'),
        CODEX_HOME: join(options.root, '.codex'),
        PI_CODING_AGENT_DIR: join(options.root, '.pi', 'agent'),
      },
      resolveExecutable(command): string | undefined {
        if (command in (options.agentExecutables ?? {})) {
          return options.agentExecutables?.[command as keyof NonNullable<typeof options.agentExecutables>];
        }
        if (options.tailscale && command === 'tailscale') return '/usr/bin/tailscale';
        return darwin.resolveExecutable(command);
      },
      async runReadOnly(executable, args) {
        if (options.tailscale && executable === '/usr/bin/tailscale') return tailscaleReadOnly(args);
        // Only the launchd domain probe answers; every other read-only probe stays unavailable.
        if (executable.endsWith('launchctl') && args[0] === 'print') {
          return { status: 'ok', exitCode: 0, stdout: 'gui/501 = {\n\tstate = running\n}\n', stderr: '' };
        }
        return { status: 'unavailable', stdout: '', stderr: '' };
      },
      async probeTcp() {
        return options.provider?.active === 'active' ? 'open' : 'closed';
      },
      fetchJson: fetchHealth,
    };
  }
  const systemd = options.systemd ?? true;
  // A darwin fixture stands for an Apple Silicon Mac, which is the supported macOS host; the arch travels
  // with the platform so a diagnosis never describes a machine that is half fixture and half test host.
  const platform = options.platform ?? (systemd ? 'linux' : 'darwin');
  const base = createSetupDiagnosisContext({
    homeDir: options.root,
    platform,
    arch: platform === 'darwin' ? 'arm64' : 'x64',
    env: {
      HOME: options.root,
      PATH: '',
      COSYNCING_HOME: join(options.root, '.cosyncing'),
      COSYNCING_CACHE_DIR: join(options.root, '.cache', 'cosyncing'),
      CODEX_HOME: join(options.root, '.codex'),
      PI_CODING_AGENT_DIR: join(options.root, '.pi', 'agent'),
      ...(options.wsl ? { WSL_DISTRO_NAME: 'Ubuntu' } : {}),
    },
  });
  return {
    ...base,
    resolveExecutable(command): string | undefined {
      if (command in (options.agentExecutables ?? {})) {
        return options.agentExecutables?.[command as keyof NonNullable<typeof options.agentExecutables>];
      }
      if (options.tailscale && command === 'tailscale') return '/usr/bin/tailscale';
      if (systemd && command === 'systemctl') return '/usr/bin/systemctl';
      if (systemd && command === 'loginctl') return '/usr/bin/loginctl';
      return undefined;
    },
    async runReadOnly(executable, args) {
      if (options.tailscale && executable === '/usr/bin/tailscale') return tailscaleReadOnly(args);
      if (executable.endsWith('systemctl') && args.includes('is-system-running')) {
        return { status: 'ok', exitCode: 0, stdout: 'running\n', stderr: '' };
      }
      if (executable.endsWith('systemctl') && args.includes('is-enabled')) {
        const value = options.provider?.enabled ?? 'disabled';
        return { status: value === 'enabled' ? 'ok' : 'nonzero', exitCode: value === 'enabled' ? 0 : 1, stdout: `${value}\n`, stderr: '' };
      }
      if (executable.endsWith('systemctl') && args.includes('is-active')) {
        const value = options.provider?.active ?? 'inactive';
        return { status: value === 'active' ? 'ok' : 'nonzero', exitCode: value === 'active' ? 0 : 3, stdout: `${value}\n`, stderr: '' };
      }
      if (executable.endsWith('loginctl')) {
        return { status: 'ok', exitCode: 0, stdout: options.provider?.lingering === 'enabled' ? 'yes\n' : 'no\n', stderr: '' };
      }
      return { status: 'unavailable', stdout: '', stderr: '' };
    },
    async probeTcp() {
      return options.provider?.active === 'active' ? 'open' : 'closed';
    },
    fetchJson: fetchHealth,
  };
}

function setupOptions(options: {
  root: string;
  provider?: FakeServiceProvider;
  presenter: SetupPresenter;
  buildInfo?: Readonly<BuildInfo>;
  systemd?: boolean;
  wsl?: boolean;
  platform?: string;
  healthAttempts?: number;
  tailscale?: FakeTailscaleProvider;
  advertisedHealth?: () => Awaited<ReturnType<SetupDiagnosisContext['fetchJson']>>;
  advertisedEndpointVerification?: NonNullable<Parameters<typeof runSetup>[0]['advertisedEndpointVerification']>;
  /** Override the build the healthy broker answers as; defaults to the build this fixture installs. */
  healthBuild?: Readonly<Omit<BuildInfo, 'schemaVersions' | 'contract'>>;
}) {
  const buildInfo = options.buildInfo ?? { ...BUILD_INFO, packaged: true, target: 'bun-linux-x64' };
  const context = contextFor({
    root: options.root,
    provider: options.provider,
    systemd: options.systemd,
    wsl: options.wsl,
    healthBuild: options.healthBuild ?? buildInfo,
    ...(options.tailscale ? { tailscale: options.tailscale } : {}),
    ...(options.advertisedHealth ? { advertisedHealth: options.advertisedHealth } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
  });
  const executablePath = join(options.root, 'bin', 'cosyncing');
  // A packaged fixture must have a real executable on disk: setup bootstrap-copies it into
  // <home>/bin/cosyncing and the systemd unit's ExecStart names that copy. The bytes stand in for the
  // compiled binary; keeping them stable across a fixture's reruns keeps the copy step idempotent.
  if (buildInfo.packaged) {
    mkdirSync(join(options.root, 'bin'), { recursive: true });
    if (!existsSync(executablePath)) writeFileSync(executablePath, 'fixture-packaged-binary', { mode: 0o755 });
  }
  return {
    buildInfo,
    executablePath,
    home: join(options.root, '.cosyncing'),
    context,
    presenter: options.presenter,
    now,
    systemdProviderFactory: options.provider ? () => options.provider! : undefined,
    ...(options.tailscale ? { tailscaleProviderFactory: () => options.tailscale! } : {}),
    serviceHealthAttempts: options.healthAttempts ?? 2,
    ...(options.advertisedEndpointVerification
      ? { advertisedEndpointVerification: options.advertisedEndpointVerification }
      : {}),
  } satisfies Parameters<typeof runSetup>[0];
}

class RecordingRunner implements ServiceCommandRunner {
  readonly calls: Array<{ executable: string; args: readonly string[] }> = [];
  enabled = false;
  active: 'active' | 'inactive' | 'failed' = 'inactive';
  lingering = false;

  async run(executable: string, args: readonly string[]): Promise<ServiceCommandResult> {
    this.calls.push({ executable, args: [...args] });
    const command = args[0] === '--user' ? args[1] : args[0];
    if (command === 'is-enabled') {
      return { status: this.enabled ? 'ok' : 'error', exitCode: this.enabled ? 0 : 1, stdout: this.enabled ? 'enabled\n' : 'disabled\n', stderr: '' };
    }
    if (command === 'is-active') {
      return { status: this.active === 'active' ? 'ok' : 'error', exitCode: this.active === 'active' ? 0 : 3, stdout: `${this.active}\n`, stderr: '' };
    }
    if (command === 'enable') this.enabled = true;
    if (command === 'disable') { this.enabled = false; if (args.includes('--now')) this.active = 'inactive'; }
    if (command === 'start' || command === 'restart') this.active = 'active';
    if (command === 'stop') this.active = 'inactive';
    if (command === 'show-user') return { status: 'ok', exitCode: 0, stdout: this.lingering ? 'yes\n' : 'no\n', stderr: '' };
    if (command === 'enable-linger') this.lingering = true;
    if (command === 'disable-linger') this.lingering = false;
    return { status: 'ok', exitCode: 0, stdout: '', stderr: '' };
  }
}

/**
 * Deterministic launchctl stand-in. It models only what the provider depends on — domain membership, the
 * disable override, and whether the job is running — and answers `print` with realistic launchd output so
 * the real parser is exercised on Linux exactly as it would be on a Mac.
 */
class LaunchctlRunner implements ServiceCommandRunner {
  readonly calls: Array<{ executable: string; args: readonly string[] }> = [];
  loaded = false;
  disabled = false;
  running = false;
  lastExitCode = 0;
  /** Number of `print` probes for which a successful bootout remains visible as loaded. */
  bootoutPrintLag = 0;
  private pendingBootoutPrints = 0;
  /** Set to replace `print` stdout with something the parser must refuse to guess at. */
  printOverride?: string;

  async run(executable: string, args: readonly string[]): Promise<ServiceCommandResult> {
    this.calls.push({ executable, args: [...args] });
    const [command] = args;
    if (command === 'print') {
      if (this.pendingBootoutPrints > 0) {
        this.pendingBootoutPrints -= 1;
        if (this.pendingBootoutPrints === 0) {
          this.loaded = false;
          this.running = false;
        }
      }
      if (!this.loaded) {
        return { status: 'error', exitCode: 113, stdout: '', stderr: `Could not find service "${args[1]}" in domain\n` };
      }
      const stdout = this.printOverride ?? [
        `${args[1]} = {`,
        '\tactive count = 1',
        `\tstate = ${this.running ? 'running' : 'not running'}`,
        `\tlast exit code = ${this.lastExitCode}`,
        '}',
        '',
      ].join('\n');
      return { status: 'ok', exitCode: 0, stdout, stderr: '' };
    }
    if (command === 'bootstrap') {
      if (this.loaded) return { status: 'error', exitCode: 37, stdout: '', stderr: 'service already bootstrapped\n' };
      this.loaded = true;
      this.running = true; // RunAtLoad
      return { status: 'ok', exitCode: 0, stdout: '', stderr: '' };
    }
    if (command === 'bootout') {
      if (!this.loaded) return { status: 'error', exitCode: 113, stdout: '', stderr: 'Could not find service\n' };
      if (this.bootoutPrintLag > 0) this.pendingBootoutPrints = this.bootoutPrintLag;
      else {
        this.loaded = false;
        this.running = false;
      }
      return { status: 'ok', exitCode: 0, stdout: '', stderr: '' };
    }
    if (command === 'enable') this.disabled = false;
    if (command === 'disable') this.disabled = true;
    if (command === 'kickstart') {
      if (!this.loaded) return { status: 'error', exitCode: 113, stdout: '', stderr: 'Could not find service\n' };
      this.running = true;
    }
    if (command === 'kill') {
      if (!this.loaded) return { status: 'error', exitCode: 113, stdout: '', stderr: 'Could not find service\n' };
      this.running = false;
      this.lastExitCode = 0;
    }
    return { status: 'ok', exitCode: 0, stdout: '', stderr: '' };
  }
}

function darwinContext(root: string): SetupDiagnosisContext {
  const base = createSetupDiagnosisContext({
    homeDir: root,
    platform: 'darwin',
    arch: 'arm64',
    env: { HOME: root, PATH: '', COSYNCING_HOME: join(root, '.cosyncing') },
  });
  return {
    ...base,
    resolveExecutable(command): string | undefined {
      if (command === 'launchctl') return '/bin/launchctl';
      if (command === 'tail') return '/usr/bin/tail';
      return undefined;
    },
  };
}

/**
 * Drive one durable-service action through prepare -> apply -> rollback against a provider that starts in
 * `prior` posture, and report the posture rollback actually left behind. A failure DURING a transaction is
 * the only way this path runs in production, so the postures it can be handed are exactly the ones a
 * previous install could have been sitting in.
 */
async function rollbackPosture(
  provider: FakeServiceProvider,
  transactionDirectory: string,
  prior: { enabled: DurableServiceStatus['enabled']; active: DurableServiceStatus['active'] },
): Promise<{ enabled: string; active: string; definition: string; rollbackError?: string }> {
  mkdirSync(transactionDirectory, { recursive: true });
  // Establish the prior posture: the definition already on disk, in the recorded enabled/active state.
  await provider.installDefinition();
  provider.enabled = prior.enabled;
  provider.active = prior.active;
  const action = createSystemdSetupAction(provider, {
    desired: 'installed',
    enableLingering: false,
    lingeringAlreadyOwned: false,
  });
  const context = { transactionDirectory } as SetupTransactionContext;
  const record = await action.prepare(context);
  await action.apply(context);
  // A rollback that cannot reach the recorded posture now throws rather than reporting a false success.
  // Surface that as an observed posture so the caller reports one clean FAIL line instead of crashing.
  let rollbackError: string | undefined;
  try {
    await action.rollback!(context, record!);
  } catch (error) {
    rollbackError = error instanceof Error ? error.message : String(error);
  }
  const after = await provider.inspect();
  return {
    enabled: after.enabled,
    active: after.active,
    definition: after.definition,
    ...(rollbackError ? { rollbackError } : {}),
  };
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-service-lifecycle-'));
try {
  // Rollback must restore the EXACT prior posture, not merely the files. launchd's reload bootstraps the
  // restored definition and RunAtLoad starts it, so a rollback that only re-enables when the prior state was
  // enabled leaves a previously stopped or disabled agent running. Both providers are checked against all
  // three postures a real install can be sitting in.
  {
    for (const [label, make] of [
      ['systemd', (dir: string) => new FakeServiceProvider(dir)],
      ['launchd', (dir: string) => new FakeLaunchdProvider(dir)],
    ] as const) {
      const postures = [
        { name: 'enabled+inactive', enabled: 'enabled' as const, active: 'inactive' as const },
        { name: 'disabled+inactive', enabled: 'disabled' as const, active: 'inactive' as const },
        { name: 'enabled+active', enabled: 'enabled' as const, active: 'active' as const },
      ];
      const observed: string[] = [];
      let restoredAll = true;
      for (const posture of postures) {
        const machine = join(root, `rollback-${label}-${posture.name}`);
        const provider = make(machine);
        const after = await rollbackPosture(provider, join(machine, 'txn'), posture);
        const ok = after.enabled === posture.enabled && after.active === posture.active
          && after.definition === 'current' && !after.rollbackError;
        if (!ok) restoredAll = false;
        observed.push(`${posture.name}=>${after.enabled}/${after.active}/${after.definition}`
          + (after.rollbackError ? `!${after.rollbackError}` : ''));
      }
      check(`${label} rollback restores files, enabled, and active state exactly for every prior posture`,
        restoredAll,
        observed.join(' | '));
    }
  }

  // The RunAtLoad race. Restoring a prior enabled+INACTIVE posture means reloading the definition (which
  // starts the job) and then stopping it. Stopping it while launchd has only SCHEDULED the spawn strands
  // the job in `spawn scheduled` forever, so the rollback must let the spawn settle first.
  {
    const machine = join(root, 'rollback-launchd-spawn-race');
    const provider = new SpawningLaunchdProvider(machine);
    const after = await rollbackPosture(provider, join(machine, 'txn'), {
      enabled: 'enabled',
      active: 'inactive',
    });
    check('launchd rollback lets a RunAtLoad spawn settle before stopping, never leaving spawn-scheduled limbo',
      after.enabled === 'enabled' && after.active === 'inactive' && after.definition === 'current'
        && !after.rollbackError && !provider.events.includes('stop-mid-spawn'),
      `${after.enabled}/${after.active}${after.rollbackError ? `!${after.rollbackError}` : ''} `
        + `events=${provider.events.join(',')}`);
  }

  // A transaction that had nothing on disk beforehand must roll back to nothing, without issuing
  // enable/disable against a definition that no longer exists.
  {
    const machine = join(root, 'rollback-launchd-fresh');
    const provider = new FakeLaunchdProvider(machine);
    const transactionDirectory = join(machine, 'txn');
    mkdirSync(transactionDirectory, { recursive: true });
    const action = createSystemdSetupAction(provider, {
      desired: 'installed',
      enableLingering: false,
      lingeringAlreadyOwned: false,
    });
    const context = { transactionDirectory } as SetupTransactionContext;
    const record = await action.prepare(context);
    await action.apply(context);
    await action.rollback!(context, record!);
    const after = await provider.inspect();
    check('rolling back a first install leaves no definition and no running agent',
      after.definition === 'missing' && after.environment === 'missing'
        && after.active === 'inactive' && after.enabled === 'disabled',
      `${after.definition}/${after.enabled}/${after.active}`);
  }

  // The transition wait must be bounded by wall time, not just attempts: each probe can burn its own
  // command deadline, so 40 attempts against a wedged launchctl would stretch one command into minutes.
  {
    const machine = join(root, 'await-wall-clock');
    const provider = new FakeLaunchdProvider(machine);
    let probes = 0;
    const wedged = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, {
      async inspect(): Promise<DurableServiceStatus> {
        probes += 1;
        await Bun.sleep(40); // stands in for a slow launchctl print
        return { ...(await FakeLaunchdProvider.prototype.inspect.call(provider)), active: 'active' as const };
      },
    });
    const startedAt = Date.now();
    const settled = await awaitServiceState({
      provider: wedged,
      expected: 'inactive',
      attempts: 40,
      delayMs: 1,
      timeoutMs: 200,
    });
    const elapsedMs = Date.now() - startedAt;
    check('a wedged transition probe is cut off by the wall-clock deadline, not the attempt count',
      settled.active === 'active' && elapsedMs < 1_000 && probes < 40,
      `${probes} probes in ${elapsedMs}ms (attempt-bound would be ~1640ms)`);
  }

  // The command runner must not outlive its work. `Promise.race` does not cancel the loser, so an armed
  // deadline timer keeps the event loop alive and the whole CLI process exits one full timeout late even
  // though every returned value was correct and prompt. That is invisible in-process, so this measures the
  // only thing that shows it: the wall time of a child that performs one fast run() and nothing else.
  {
    const probe = join(root, 'runner-exit-probe.ts');
    const runnerModule = join(import.meta.dir, '../../../../packages/typescript/broker/src/service-manager.ts');
    writeFileSync(probe, [
      `import { createServiceCommandRunner } from ${JSON.stringify(runnerModule)};`,
      `const runner = createServiceCommandRunner({ PATH: '/usr/bin:/bin' });`,
      // A 15s deadline against a command that settles in milliseconds: the gap IS the assertion.
      `const result = await runner.run('/bin/echo', ['ready'], 15_000);`,
      `if (result.status !== 'ok' || !result.stdout.includes('ready')) process.exit(2);`,
      `console.log('settled');`,
      '',
    ].join('\n'));
    const startedAt = Date.now();
    const child = Bun.spawn(['bun', 'run', probe], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await child.exited;
    const elapsedMs = Date.now() - startedAt;
    const stdout = child.stdout instanceof ReadableStream ? await new Response(child.stdout).text() : '';
    check('the command runner clears its deadline so the process exits with its work, not after the timeout',
      exitCode === 0 && stdout.includes('settled') && elapsedMs < 5_000,
      `exit=${exitCode} in ${elapsedMs}ms (leaked timer would be ~15000ms)`);
  }

  // The deadline must still fire for a command that genuinely wedges — clearing it on settle must not
  // disarm it while the work is still outstanding.
  {
    const runner = createServiceCommandRunner({ PATH: '/usr/bin:/bin' });
    const startedAt = Date.now();
    const wedged = await runner.run('/bin/sleep', ['30'], 300);
    const elapsedMs = Date.now() - startedAt;
    check('a wedged command still hits its deadline and is killed rather than awaited forever',
      wedged.status === 'timeout' && elapsedMs < 5_000,
      `${wedged.status} in ${elapsedMs}ms`);
  }

  // The shipping renderer and command boundary use typed arguments and owner-only files.
  {
    const machine = join(root, 'renderer with spaces');
    mkdirSync(machine, { recursive: true });
    const runner = new RecordingRunner();
    const context = contextFor({ root: machine, systemd: true });
    const nodeAgentBin = join(machine, 'node-v22.14.0-linux-x64', 'bin');
    const opencodeBin = join(machine, '.opencode', 'bin');
    const provider = new SystemdUserServiceProvider({
      context,
      homeDir: machine,
      stateHome: join(machine, '.cosyncing'),
      cacheRoot: join(machine, '.cache', 'cosyncing'),
      executablePath: join(machine, 'bin with spaces', 'cosyncing'),
      distribution: 'native',
      agentExecutableDirectories: [nodeAgentBin, opencodeBin, nodeAgentBin],
      // What a packaged install resolves beside the ACQUISITION executable — the path the unit could not
      // work out for itself, which is the whole reason it is carried in the environment.
      webDir: join(machine, 'acquisition', 'cosyncing-web-9.9.9'),
      workingDirectory: join(machine, 'working tree'),
      configHome: join(machine, '.config'),
      runner,
      systemctlPath: '/usr/bin/systemctl',
      journalctlPath: '/usr/bin/journalctl',
      loginctlPath: '/usr/bin/loginctl',
      userIdentifier: '1000',
    });
    const unit = provider.expectedDefinition();
    const environment = provider.expectedEnvironment();
    check('typed systemd rendering quotes paths and carries no plaintext token or token argument',
      unit.includes(`ExecStart="${join(machine, 'bin with spaces', 'cosyncing')}" "broker"`)
        && unit.includes('EnvironmentFile=')
        && !`${unit}\n${environment}`.includes('super-secret')
        && !unit.match(/--token|COSYNCING_TOKEN=/));
    // systemd only unquotes directives it splits into arguments. WorkingDirectory= and EnvironmentFile=
    // take the literal remainder of the line, so a quoted value arrives WITH the quotes: real systemd 255
    // rejected WorkingDirectory as "path is not absolute" (fatal, unit never starts) and silently IGNORED
    // the quoted EnvironmentFile, which would have started the broker with none of its environment.
    // Spaces need no escaping here precisely because the whole remainder is the value.
    check('bare-path systemd directives are rendered unquoted and absolute',
      unit.includes(`\nWorkingDirectory=${join(machine, 'working tree')}\n`)
        && unit.includes(`\nEnvironmentFile=${join(machine, '.cosyncing', 'service', 'broker.env')}\n`)
        && !/\n(?:WorkingDirectory|EnvironmentFile)="/.test(unit),
      unit.split('\n').filter((line) => /^(WorkingDirectory|EnvironmentFile)=/.test(line)).join(' | '));
    check('service environment is explicit, minimal, and path-only',
      ['HOME=', 'PATH=', 'COSYNCING_HOME=', 'COSYNCING_CACHE_DIR=', 'COSYNCING_TOKEN_FILE=',
        'COSYNCING_PI_INTEGRATION_FILE=', 'COSYNCING_WEB_DIR=']
        .every((name) => environment.includes(name))
        && !environment.includes('WSL_DISTRO_NAME=')
        && !environment.includes('CLAUDE'));
    const renderedPath = environment.split('\n').find((line) => line.startsWith('PATH=')) ?? '';
    check('systemd PATH includes detected versioned-Node and ~/.opencode directories once without inheriting the shell PATH',
      renderedPath.includes(`${nodeAgentBin}:${opencodeBin}`)
        && renderedPath.split(nodeAgentBin).length === 2
        && !renderedPath.includes('/interactive-only/bin'),
      renderedPath);
    await provider.installDefinition();
    await provider.start();
    await provider.restart();
    await provider.stop();
    await provider.enableLingering();
    const installedMode = statSync(provider.definitionPath).mode & 0o777;
    await provider.uninstall();
    check('systemd lifecycle, boot persistence, journald access, and crash restart policy are explicit',
      installedMode === 0o600
        && unit.includes('Restart=on-failure') && unit.includes('StartLimitBurst=3')
        && provider.logsCommand({ follow: true, lines: 50 }).join(' ')
          === '/usr/bin/journalctl --user -u cosyncing.service -f'
        && provider.logsCommand({ follow: false, lines: 50 }).join(' ')
          === '/usr/bin/journalctl --user -u cosyncing.service -n 50 --no-pager'
        && !existsSync(provider.definitionPath));
    check('service commands are bounded argv calls with no shell interpolation',
      runner.calls.length > 0
        && runner.calls.every((call) => call.executable.startsWith('/')
          && !call.args.some((arg) => /[\0\r\n]/.test(arg))
          && !call.args.includes('sh') && !call.args.includes('-c')));

    // The rendered artifact must meet REAL systemd at least once. No fake-provider seam can catch a unit
    // that parses but is rejected (or half-ignored) by systemd's own directive parsers — that class of bug
    // reached a physical machine precisely because every test here stopped at our own abstractions.
    const analyze = Bun.which('systemd-analyze');
    if (!analyze) {
      check('rendered unit passes real systemd validation', true, 'skipped: systemd-analyze is unavailable');
    } else {
      const verifyDir = join(root, 'systemd-analyze');
      mkdirSync(join(verifyDir, 'bin'), { recursive: true });
      // systemd-analyze resolves ExecStart and warns when it is not executable, so give it a real file:
      // that keeps a genuine finding from hiding behind an artefact of the fixture.
      const executable = join(verifyDir, 'bin', 'cosyncing');
      writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const verifyProvider = new SystemdUserServiceProvider({
        context: contextFor({ root: verifyDir, systemd: true }),
        homeDir: verifyDir,
        stateHome: join(verifyDir, '.cosyncing'),
        cacheRoot: join(verifyDir, '.cache', 'cosyncing'),
        executablePath: executable,
        distribution: 'native',
        webDir: join(verifyDir, 'acquisition', 'cosyncing-web-9.9.9'),
        configHome: join(verifyDir, '.config'),
        systemctlPath: '/usr/bin/systemctl',
        journalctlPath: '/usr/bin/journalctl',
        loginctlPath: '/usr/bin/loginctl',
        userIdentifier: '1000',
      });
      const unitPath = join(verifyDir, 'cosyncing.service');
      writeFileSync(unitPath, verifyProvider.expectedDefinition());
      const verified = Bun.spawnSync([analyze, 'verify', '--user', unitPath], {
        cwd: verifyDir,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const diagnostics = `${verified.stdout.toString()}${verified.stderr.toString()}`.trim();
      // systemd-analyze exits 0 even for directives it merely "ignores", so the OUTPUT is the assertion:
      // any complaint naming one of our directives is a defect regardless of exit code.
      check('rendered unit passes real systemd validation',
        !/not absolute|ignoring|Unknown key|Failed to parse|fatal/i.test(diagnostics),
        diagnostics.slice(0, 220) || 'no diagnostics');
    }
  }

  // The JavaScript distribution's durable service: an EXTERNAL Bun executing the receipt-owned application.
  //
  // This is the case the previous design could not express at all. Its unit named one executable and hard-
  // coded `broker` after it, so a JavaScript install could only have been launched by leaving the interpreter
  // to the `#!/usr/bin/env bun` shebang — which resolves through PATH, and the service PATH is deliberately
  // restricted. Both providers must therefore name Bun explicitly, and must agree on doing so.
  {
    const machine = join(root, 'javascript-distribution-service');
    const userHome = join(machine, 'home');
    const stateHome = join(userHome, '.cosyncing');
    // A version-manager layout: Bun lives outside every fixed entry the restricted PATH already carries.
    const versionManagerBin = join(userHome, '.local', 'share', 'mise', 'installs', 'bun', '1.3.8', 'bin');
    for (const directory of [join(stateHome, 'bin'), versionManagerBin]) mkdirSync(directory, { recursive: true });
    const bunRuntime = join(versionManagerBin, 'bun');
    writeFileSync(bunRuntime, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const application = join(stateHome, 'bin', 'cosyncing');
    writeFileSync(application, '#!/usr/bin/env bun\n', { mode: 0o700 });
    const acquisitionWeb = join(userHome, 'npm-global', 'lib', 'node_modules', 'cosyncing', 'bin', 'cosyncing-web-9.9.9');
    mkdirSync(acquisitionWeb, { recursive: true });
    const runner = new RecordingRunner();
    const providerOptions = {
      context: contextFor({ root: userHome, systemd: true }),
      runner,
      homeDir: userHome,
      stateHome,
      cacheRoot: join(userHome, '.cache', 'cosyncing'),
      executablePath: application,
      distribution: 'bun-js' as const,
      runtimePath: bunRuntime,
      webDir: acquisitionWeb,
      configHome: join(userHome, '.config'),
      systemctlPath: '/usr/bin/systemctl',
      journalctlPath: '/usr/bin/journalctl',
      loginctlPath: '/usr/bin/loginctl',
      userIdentifier: '1000',
    };
    const systemdProvider = new SystemdUserServiceProvider(providerOptions);
    const systemdUnit = systemdProvider.expectedDefinition();
    check('the systemd unit execs the external Bun runtime plus the installed application, in that order',
      systemdUnit.includes(`ExecStart="${bunRuntime}" "${application}" "broker"`)
        && !systemdUnit.includes(`ExecStart="${application}"`),
      systemdUnit.split('\n').find((line) => line.startsWith('ExecStart=')));

    const launchdProvider = new LaunchdUserServiceProvider({
      ...providerOptions,
      context: contextFor({ root: userHome, systemd: false }),
      launchAgentsHome: join(userHome, 'Library', 'LaunchAgents'),
      launchctlPath: '/bin/launchctl',
      tailPath: '/usr/bin/tail',
    });
    const plist = launchdProvider.expectedDefinition();
    const programArguments = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
    check('the launchd job carries the identical argv as three separate ProgramArguments strings',
      programArguments.includes(bunRuntime)
        && programArguments.indexOf(bunRuntime) + 1 === programArguments.indexOf(application)
        && programArguments.indexOf(application) + 1 === programArguments.indexOf('broker'),
      programArguments.slice(0, 4).join(' '));

    // Both managers write one receipt-owned environment file, so it must be byte-identical across them —
    // including the runtime directory that the version-manager layout newly requires.
    const systemdEnvironment = systemdProvider.expectedEnvironment();
    check('both providers render the identical service environment for one JavaScript install',
      systemdEnvironment === launchdProvider.expectedEnvironment());
    const renderedPath = systemdEnvironment.split('\n').find((line) => line.startsWith('PATH=')) ?? '';
    check('the restricted PATH gains the version-manager runtime directory and nothing else',
      renderedPath.includes(versionManagerBin)
        && !renderedPath.includes('/interactive-only/bin')
        && renderedPath.replace(/^PATH="|"$/g, '').split(':').length <= 9,
      renderedPath);
    // Resolved from the ACQUISITION application, which is where the sidecar actually sits — the installed
    // copy has no sidecar beside it and never will.
    check('the service is told the sidecar path beside the acquisition package, not beside the copy it execs',
      systemdEnvironment.includes(`COSYNCING_WEB_DIR="${acquisitionWeb}"`)
        && !systemdEnvironment.includes(`COSYNCING_WEB_DIR="${join(stateHome, 'bin')}`));

    // Bun MOVED after setup. The unit still names the old absolute path, so the service cannot start; the
    // definition reads back as drifted, which is precisely the signal repair acts on. Rewriting with the
    // runtime executing the command now is the convergence.
    const movedBin = join(userHome, '.local', 'share', 'mise', 'installs', 'bun', '1.4.0', 'bin');
    mkdirSync(movedBin, { recursive: true });
    const movedRuntime = join(movedBin, 'bun');
    writeFileSync(movedRuntime, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await systemdProvider.installDefinition();
    const installedUnit = readFileSync(systemdProvider.definitionPath, 'utf8');
    const afterMove = new SystemdUserServiceProvider({ ...providerOptions, runtimePath: movedRuntime });
    check('a Bun that moved after setup makes the installed definition read back as drifted',
      (await afterMove.inspect()).definition === 'drifted'
        && (await systemdProvider.inspect()).definition === 'current',
      installedUnit.split('\n').find((line) => line.startsWith('ExecStart=')));
    await afterMove.installDefinition();
    check('repair converges the moved runtime by rewriting the unit with the current one',
      (await afterMove.inspect()).definition === 'current'
        && readFileSync(afterMove.definitionPath, 'utf8').includes(`"${movedRuntime}"`),
      readFileSync(afterMove.definitionPath, 'utf8').split('\n').find((line) => line.startsWith('ExecStart=')));

    // The providers are exported and constructible without the identity resolver that already refuses this
    // path, so they must refuse it independently: `/tmp/a:b` is a legal directory name, but PATH has no
    // escape for `:` — rendered anyway, the runtime's directory splits into two bogus search entries.
    const renderRefused = (render: () => string): boolean => {
      try { render(); return false; } catch { return true; }
    };
    const colonProviderOptions = { ...providerOptions, runtimePath: '/tmp/a:b/bin/bun' };
    check('both providers refuse a runtime path containing the PATH separator at their own boundary',
      renderRefused(() => new SystemdUserServiceProvider(colonProviderOptions).expectedDefinition())
        && renderRefused(() => new SystemdUserServiceProvider(colonProviderOptions).expectedEnvironment())
        && renderRefused(() => new LaunchdUserServiceProvider({
          ...colonProviderOptions,
          context: contextFor({ root: userHome, systemd: false }),
          launchAgentsHome: join(userHome, 'Library', 'LaunchAgents'),
          launchctlPath: '/bin/launchctl',
          tailPath: '/usr/bin/tail',
        }).expectedDefinition()));

    // Uninstall removes cosyncing-owned service resources and nothing else. Bun was never copied and never
    // receipted, so there is nothing that could remove it — this proves the absence rather than assuming it.
    await afterMove.uninstall();
    check('uninstalling the service preserves the separately installed Bun runtime',
      !existsSync(afterMove.definitionPath)
        && existsSync(movedRuntime) && existsSync(bunRuntime)
        && !readFileSync(application, 'utf8').includes('exit 0'),
      `${existsSync(bunRuntime)}/${existsSync(movedRuntime)}`);
  }

  // Launch a child with the exact environment entries a durable service receives. This crosses the real
  // Bun.which/adapter/runtime boundaries: it is not a string-only renderer assertion. Fake CLIs make the
  // test hermetic while preserving the real command names and startup paths.
  {
    const machine = join(root, 'service-agent-runtime');
    const userHome = join(machine, 'home');
    const stateHome = join(userHome, '.cosyncing');
    const nodeAgentBin = join(userHome, 'node-v22.14.0-darwin-arm64', 'bin');
    const nodeRuntimeBin = join(userHome, '.nvm', 'versions', 'node', 'v24.19.0', 'bin');
    const opencodeBin = join(userHome, '.opencode', 'bin');
    const piBin = join(userHome, '.local', 'share', 'pi', 'bin');
    const codexLog = join(machine, 'codex.log');
    const opencodeLog = join(machine, 'opencode.log');
    for (const directory of [nodeAgentBin, nodeRuntimeBin, opencodeBin, piBin, stateHome]) mkdirSync(directory, { recursive: true });
    const bunShebang = `#!${process.execPath}`;
    const codexTarget = join(machine, 'packages', 'codex-cli.ts');
    mkdirSync(dirname(codexTarget), { recursive: true });
    writeFileSync(codexTarget, [
      bunShebang,
      `import { appendFileSync } from 'node:fs';`,
      `appendFileSync(${JSON.stringify(codexLog)}, process.argv.slice(2).join(' ') + '\\n');`,
      '',
    ].join('\n'), { mode: 0o755 });
    symlinkSync(codexTarget, join(nodeAgentBin, 'codex'));
    writeFileSync(join(nodeAgentBin, 'claude'), `${bunShebang}\nprocess.exit(0);\n`, { mode: 0o755 });
    symlinkSync(process.execPath, join(nodeRuntimeBin, 'node'));
    writeFileSync(join(piBin, 'pi'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
    writeFileSync(join(opencodeBin, 'opencode'), [
      bunShebang,
      `import { appendFileSync } from 'node:fs';`,
      `const args = process.argv.slice(2);`,
      `appendFileSync(${JSON.stringify(opencodeLog)}, args.join(' ') + '\\n');`,
      `const portIndex = args.indexOf('--port');`,
      `const hostnameIndex = args.indexOf('--hostname');`,
      `Bun.serve({`,
      `  hostname: hostnameIndex >= 0 ? args[hostnameIndex + 1] : '127.0.0.1',`,
      `  port: portIndex >= 0 ? Number(args[portIndex + 1]) : 4096,`,
      `  fetch(request) {`,
      `    const path = new URL(request.url).pathname;`,
      `    if (path === '/session') return Response.json([]);`,
      `    if (path === '/global/health') return Response.json({ healthy: true, version: '1.17.19' });`,
      `    return new Response('not found', { status: 404 });`,
      `  },`,
      `});`,
      '',
    ].join('\n'), { mode: 0o755 });

    const detectionContext = createSetupDiagnosisContext({
      homeDir: userHome,
      platform: 'darwin',
      arch: 'arm64',
      env: {
        HOME: userHome,
        PATH: `${nodeAgentBin}:${opencodeBin}:${piBin}:${nodeRuntimeBin}:/interactive-only/bin`,
      },
    });
    const detectedDirectories = serviceAgentExecutableDirectories(detectionContext);
    const freePortServer = Bun.serve({ port: 0, fetch: () => new Response('reserved') });
    const opencodePort = freePortServer.port;
    freePortServer.stop(true);
    const serviceEntries = brokerServiceEnvironmentEntries({
      homeDir: userHome,
      stateHome,
      cacheRoot: join(userHome, '.cache', 'cosyncing'),
      executablePath: process.execPath,
      agentExecutableDirectories: detectedDirectories,
      webDir: join(machine, 'web'),
    });
    const probe = join(machine, 'service-agent-probe.ts');
    const codexModule = join(import.meta.dir, '../../../../packages/typescript/adapters/codex/src/index.ts');
    const opencodeModule = join(import.meta.dir, '../../../../packages/typescript/adapters/opencode/src/index.ts');
    const piModule = join(import.meta.dir, '../../../../packages/typescript/adapters/pi/src/index.ts');
    const claudeModule = join(import.meta.dir, '../../../../packages/typescript/adapters/claude/src/index.ts');
    const serveModule = join(import.meta.dir, '../../../../packages/typescript/broker/src/opencode-serve.ts');
    writeFileSync(probe, [
      `import { existsSync, mkdirSync, readFileSync } from 'node:fs';`,
      `import { join } from 'node:path';`,
      `import { CodexAdapter } from ${JSON.stringify(codexModule)};`,
      `import { OpenCodeAdapter } from ${JSON.stringify(opencodeModule)};`,
      `import { PiAdapter } from ${JSON.stringify(piModule)};`,
      `import { ClaudeAdapter } from ${JSON.stringify(claudeModule)};`,
      `import { ensureManagedOpencodeServe, stopManagedOpencodeServe } from ${JSON.stringify(serveModule)};`,
      `mkdirSync(join(process.env.HOME!, '.codex', 'sessions'), { recursive: true });`,
      `await ensureManagedOpencodeServe();`,
      `const opencode = new OpenCodeAdapter();`,
      `const codex = new CodexAdapter();`,
      `await codex.discoverSessions();`,
      `for (let i = 0; i < 80 && !existsSync(${JSON.stringify(codexLog)}); i += 1) await Bun.sleep(25);`,
      `const result = {`,
      `  opencodeCreate: await opencode.canCreateSession(),`,
      `  codexCreate: codex.canCreateSession(),`,
      `  claudeCreate: new ClaudeAdapter().canCreateSession(),`,
      `  piCreate: new PiAdapter().canCreateSession(),`,
      `  piRuns: Bun.spawnSync([process.env.COSYNCING_PI_BIN || 'pi', '--version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0,`,
      `  codexDaemonStarted: existsSync(${JSON.stringify(codexLog)}) && readFileSync(${JSON.stringify(codexLog)}, 'utf8').includes('app-server daemon start'),`,
      `  opencodeAutoserved: existsSync(${JSON.stringify(opencodeLog)}) && readFileSync(${JSON.stringify(opencodeLog)}, 'utf8').includes('serve --hostname'),`,
      `};`,
      `await stopManagedOpencodeServe();`,
      `console.log('RESULT ' + JSON.stringify(result));`,
      '',
    ].join('\n'));
    const child = Bun.spawn([process.execPath, probe], {
      cwd: resolve(import.meta.dir, '../../../..'),
      env: {
        ...Object.fromEntries(serviceEntries),
        OPENCODE_URL: `http://127.0.0.1:${opencodePort}`,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const line = stdout.split('\n').find((candidate) => candidate.startsWith('RESULT '));
    const outcome = line ? JSON.parse(line.slice('RESULT '.length)) as Record<string, unknown> : {};
    check('the rendered service environment enables OpenCode autoserve, Codex daemon startup, Claude creation, and installed Pi creation',
      exitCode === 0
        && outcome.opencodeCreate === true
        && outcome.codexCreate === true
        && outcome.claudeCreate === true
        && outcome.piCreate === true
        && outcome.piRuns === true
        && outcome.codexDaemonStarted === true
        && outcome.opencodeAutoserved === true,
      `exit=${exitCode} result=${JSON.stringify(outcome)} stderr=${stderr.trim().slice(0, 240)}`);
    const servicePath = serviceEntries.find(([name]) => name === 'PATH')?.[1] ?? '';
    check('service PATH capture uses exact resolved agent parents and excludes unrelated interactive entries',
      detectedDirectories.length === 4
        && detectedDirectories.every((directory) => servicePath.split(':').includes(directory))
        && servicePath.split(':').includes(nodeRuntimeBin)
        && !servicePath.includes('/interactive-only/bin'),
      servicePath);

    const overrideCodex = join(machine, 'override-codex', 'bin', 'codex-fixture');
    const overrideClaude = join(machine, 'override-claude', 'bin', 'claude-fixture');
    const overridePi = join(machine, 'override-pi', 'bin', 'pi-fixture');
    for (const path of [overrideCodex, overrideClaude, overridePi]) mkdirSync(dirname(path), { recursive: true });
    symlinkSync(codexTarget, overrideCodex);
    writeFileSync(overrideClaude, `${bunShebang}\nprocess.exit(0);\n`, { mode: 0o755 });
    writeFileSync(overridePi, `${bunShebang}\nprocess.exit(0);\n`, { mode: 0o755 });
    const overrideContext = createSetupDiagnosisContext({
      homeDir: userHome,
      platform: 'darwin',
      arch: 'arm64',
      env: {
        HOME: userHome,
        PATH: `${opencodeBin}:/interactive-only/bin`,
        COSYNCING_CODEX_BIN: overrideCodex,
        COSYNCING_CLAUDE_BIN: overrideClaude,
        COSYNCING_PI_BIN: overridePi,
      },
    });
    const overrideDirectories = serviceAgentExecutableDirectories(overrideContext);
    const executableOverrides = serviceAgentExecutableOverrides(overrideContext);
    const overrideEntries = brokerServiceEnvironmentEntries({
      homeDir: userHome,
      stateHome,
      cacheRoot: join(userHome, '.cache', 'cosyncing'),
      executablePath: process.execPath,
      agentExecutableDirectories: overrideDirectories,
      agentExecutableOverrides: executableOverrides,
      webDir: join(machine, 'web'),
    });
    const secondPortReservation = Bun.serve({ port: 0, fetch: () => new Response('reserved') });
    const secondOpencodePort = secondPortReservation.port;
    secondPortReservation.stop(true);
    const overrideChild = Bun.spawn([process.execPath, probe], {
      cwd: resolve(import.meta.dir, '../../../..'),
      env: {
        ...Object.fromEntries(overrideEntries),
        OPENCODE_URL: `http://127.0.0.1:${secondOpencodePort}`,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [overrideExit, overrideStdout, overrideStderr] = await Promise.all([
      overrideChild.exited,
      new Response(overrideChild.stdout).text(),
      new Response(overrideChild.stderr).text(),
    ]);
    const overrideLine = overrideStdout.split('\n').find((candidate) => candidate.startsWith('RESULT '));
    const overrideOutcome = overrideLine
      ? JSON.parse(overrideLine.slice('RESULT '.length)) as Record<string, unknown>
      : {};
    const renderedOverrides = Object.fromEntries(overrideEntries);
    check('nonstandard Codex, Claude, and Pi override basenames survive the durable service environment',
      overrideExit === 0
        && renderedOverrides.COSYNCING_CODEX_BIN === overrideCodex
        && renderedOverrides.COSYNCING_CLAUDE_BIN === overrideClaude
        && renderedOverrides.COSYNCING_PI_BIN === overridePi
        && overrideOutcome.codexCreate === true
        && overrideOutcome.claudeCreate === true
        && overrideOutcome.piCreate === true
        && overrideOutcome.piRuns === true,
      `exit=${overrideExit} result=${JSON.stringify(overrideOutcome)} stderr=${overrideStderr.trim().slice(0, 240)}`);
  }

  // A package-manager upgrade can move an agent from one versioned Node directory to another while leaving
  // the broker installation untouched. Both setup and repair must compare against the newly resolved parent
  // and reconcile the receipt-owned environment instead of accepting its old hash as operational.
  {
    const machine = join(root, 'agent-path-move');
    const provider = new AgentPathServiceProvider(machine);
    // Native: this fixture's durable environment carries no runtime directory, and only a native identity
    // legitimately has none. Doctor's runtime-aware PATH reconstruction is exercised by its own fixture.
    const serviceBuild = { ...BUILD_INFO, packaged: true, target: 'bun-linux-x64', distribution: 'native' } satisfies BuildInfo;
    let codexPath = join(machine, 'releases', '0.144.5-fixture', 'bin', 'codex');
    const makeContext = () => contextFor({
      root: machine,
      provider,
      systemd: true,
      agentExecutables: { codex: codexPath },
      healthBuild: serviceBuild,
    });
    const providerFactory = (options: SystemdProviderOptions) => {
      provider.agentDirectories = options.agentExecutableDirectories ?? [];
      provider.agentOverrides = options.agentExecutableOverrides ?? {};
      return provider;
    };
    const first = await runSetup({
      ...setupOptions({
        root: machine,
        provider,
        presenter: new ServicePresenter({ service: 'systemd' }),
        buildInfo: serviceBuild,
      }),
      context: makeContext(),
      systemdProviderFactory: providerFactory,
    });
    const oldEnvironment = provider.expectedEnvironment();
    codexPath = join(machine, 'releases', '0.145.0-fixture', 'bin', 'codex');
    const movedContext = makeContext();
    const inspection = await inspectSetupEnvironment({
      buildInfo: serviceBuild,
      executablePath: join(machine, 'bin', 'cosyncing'),
      home: join(machine, '.cosyncing'),
      context: movedContext,
      systemdProviderFactory: providerFactory,
    });
    const setupPlan = buildSetupPlan({
      inspection,
      choices: existingSetupChoices(inspection),
      now,
    });
    const repairPlan = await inspectRepair({
      buildInfo: serviceBuild,
      executablePath: join(machine, 'bin', 'cosyncing'),
      home: join(machine, '.cosyncing'),
      context: movedContext,
      systemdProviderFactory: providerFactory,
    });
    const doctorAgentPath = inspection.doctor.sections.flatMap((section) => section.checks)
      .find((candidate) => candidate.id === 'service.agent-executable-path');
    check('setup and repair both detect a moved versioned agent executable as service-environment drift',
      first.status === 'complete'
        && inspection.systemdStatus?.environment === 'drifted'
        && doctorAgentPath?.status === 'fail'
        && doctorAgentPath.detailCode === 'service-agent-path-stale'
        && setupPlan.actions.some((action) => action.id === 'service.systemd')
        && repairPlan.actions.some((action) => action.id === 'service.reconcile'),
      `setup=${setupPlan.actions.map((action) => action.id).join(',')} repair=${repairPlan.actions.map((action) => action.id).join(',')}`);
    const reconciled = await runSetup({
      ...setupOptions({
        root: machine,
        provider,
        presenter: new ServicePresenter({ service: 'systemd' }),
        buildInfo: serviceBuild,
      }),
      context: movedContext,
      systemdProviderFactory: providerFactory,
    });
    const newDirectory = dirname(codexPath);
    const installedEnvironment = readFileSync(provider.environmentPath, 'utf8');
    check('setup rewrites and restarts the owned service after an agent executable moves',
      reconciled.status === 'complete'
        && installedEnvironment !== oldEnvironment
        && installedEnvironment.includes(newDirectory)
        && !installedEnvironment.includes(dirname(join(machine, 'releases', '0.144.5-fixture', 'bin', 'codex'))),
      `${reconciled.status}: ${installedEnvironment.trim()}`);
  }

  // Removing agents is the inverse of installation/move discovery: doctor must flag the receipt-owned
  // directory as obsolete, including when the final agent disappears, and repair must rewrite it away.
  {
    const machine = join(root, 'agent-path-removal');
    const provider = new AgentPathServiceProvider(machine);
    const serviceBuild = { ...BUILD_INFO, packaged: true, target: 'bun-linux-x64', distribution: 'native' } satisfies BuildInfo;
    const agentExecutables: Partial<Record<'codex' | 'opencode' | 'pi' | 'claude', string>> = {
      codex: join(machine, 'node-v22.14.0-linux-x64', 'bin', 'codex'),
      opencode: join(machine, '.opencode', 'bin', 'opencode'),
    };
    const makeContext = () => contextFor({
      root: machine,
      provider,
      systemd: true,
      agentExecutables: { ...agentExecutables },
      healthBuild: serviceBuild,
    });
    const providerFactory = (options: SystemdProviderOptions) => {
      provider.agentDirectories = options.agentExecutableDirectories ?? [];
      provider.agentOverrides = options.agentExecutableOverrides ?? {};
      return provider;
    };
    const base = {
      buildInfo: serviceBuild,
      executablePath: join(machine, 'bin', 'cosyncing'),
      home: join(machine, '.cosyncing'),
      systemdProviderFactory: providerFactory,
    };
    const installed = await runSetup({
      ...setupOptions({
        root: machine,
        provider,
        presenter: new ServicePresenter({ service: 'systemd' }),
        buildInfo: serviceBuild,
      }),
      context: makeContext(),
      systemdProviderFactory: providerFactory,
    });

    const runtimeBase = makeContext();
    const opencodeUnavailableContext: SetupDiagnosisContext = {
      ...runtimeBase,
      async fetchJson(url, headers, timeoutMs) {
        const path = new URL(url).pathname;
        if (path === '/api/broker/health') return { status: 'ok', statusCode: 200, json: { status: 'healthy' } };
        if (path === '/api/agent-runtime-updates') return { status: 'ok', statusCode: 200, json: { updates: [] } };
        if (path === '/api/agents') {
          return {
            status: 'ok',
            statusCode: 200,
            json: [{ id: 'opencode', displayName: 'OpenCode', canCreateSession: false }],
          };
        }
        return runtimeBase.fetchJson(url, headers, timeoutMs);
      },
    };
    const runtimeReport = await collectDoctorReport({
      buildInfo: serviceBuild,
      context: opencodeUnavailableContext,
      assetReport: inspectRuntimeAssets(),
      adapters: [],
      stateHome: base.home,
      codexTuiReadiness: { status: 'ok', customSocket: false, staleCandidatePids: [], message: 'fixture' },
    });
    const runtimeChecks = runtimeReport.sections.flatMap((section) => section.checks);
    const currentPath = runtimeChecks.find((candidate) => candidate.id === 'service.agent-executable-path');
    const opencodeReadiness = runtimeChecks.find((candidate) => candidate.id === 'opencode.broker-create-readiness');
    check('doctor attributes OpenCode creation failure to its shared server when the durable PATH is current',
      installed.status === 'complete'
        && currentPath?.status === 'pass'
        && opencodeReadiness?.status === 'fail'
        && opencodeReadiness.detailCode === 'broker-agent-runtime-unavailable'
        && opencodeReadiness.remediation?.command === 'cosyncing restart'
        && !opencodeReadiness.remediation.message.includes('service PATH'),
      `${currentPath?.status}/${opencodeReadiness?.detailCode}: ${opencodeReadiness?.remediation?.message}`);

    const inspectRemoval = async () => {
      const context = makeContext();
      const inspection = await inspectSetupEnvironment({ ...base, context });
      const doctorPath = inspection.doctor.sections.flatMap((section) => section.checks)
        .find((candidate) => candidate.id === 'service.agent-executable-path');
      const plan = await inspectRepair({ ...base, context });
      return { context, inspection, doctorPath, plan };
    };
    delete agentExecutables.codex;
    const oneRemoved = await inspectRemoval();
    const repairedOne = await runRepair({
      ...base,
      context: oneRemoved.context,
      confirmed: true,
      allowLegacyIntegrations: false,
      expectedPlan: oneRemoved.plan,
    });
    const afterOne = readFileSync(provider.environmentPath, 'utf8');
    check('doctor detects one removed agent and repair removes only its obsolete service PATH directory',
      oneRemoved.inspection.systemdStatus?.environment === 'drifted'
        && oneRemoved.doctorPath?.status === 'fail'
        && oneRemoved.doctorPath.evidence?.obsoleteDirectories === 1
        && oneRemoved.plan.actions.some((action) => action.id === 'service.reconcile')
        && repairedOne.exitCode === 0
        && !afterOne.includes(dirname(join(machine, 'node-v22.14.0-linux-x64', 'bin', 'codex')))
        && afterOne.includes(dirname(agentExecutables.opencode!)),
      `${oneRemoved.doctorPath?.status}/${repairedOne.detailCode}/${repairedOne.exitCode}: ${afterOne.trim()}`);

    const finalDirectory = dirname(agentExecutables.opencode!);
    delete agentExecutables.opencode;
    const lastRemoved = await inspectRemoval();
    const repairedLast = await runRepair({
      ...base,
      context: lastRemoved.context,
      confirmed: true,
      allowLegacyIntegrations: false,
      expectedPlan: lastRemoved.plan,
    });
    const afterLast = readFileSync(provider.environmentPath, 'utf8');
    check('doctor detects removal of the last agent and repair removes its obsolete service PATH directory',
      lastRemoved.inspection.systemdStatus?.environment === 'drifted'
        && lastRemoved.doctorPath?.status === 'fail'
        && lastRemoved.doctorPath.evidence?.detectedExecutables === 0
        && lastRemoved.doctorPath.evidence?.obsoleteDirectories === 1
        && lastRemoved.plan.actions.some((action) => action.id === 'service.reconcile')
        && repairedLast.exitCode === 0
        && !afterLast.includes(finalDirectory),
      `${lastRemoved.doctorPath?.status}/${repairedLast.detailCode}/${repairedLast.exitCode}: ${afterLast.trim()}`);
  }

  // A fresh JavaScript install records the external runtime's directory in the durable service PATH, so
  // doctor must reconstruct its expectation from the runtime that is executing it. Before doctor was told
  // the runtime, this exact healthy state read as one "obsolete" directory: doctor failed, recommended
  // repair, and repair found nothing to change — a permanent loop on every fresh npm installation. Both
  // service managers share the reconstruction, so both are proven.
  {
    for (const flavor of [
      { id: 'systemd' as const, target: 'bun-linux-x64', makeProvider: (dir: string) => new AgentPathServiceProvider(dir) },
      { id: 'launchd' as const, target: 'darwin-arm64', makeProvider: (dir: string) => new AgentPathLaunchdProvider(dir) },
    ]) {
      const machine = join(root, `runtime-path-doctor-${flavor.id}`);
      const provider = flavor.makeProvider(machine);
      const serviceBuild = {
        ...BUILD_INFO, packaged: true, target: flavor.target, distribution: 'bun-js',
      } satisfies BuildInfo;
      const darwin = flavor.id === 'launchd';
      const makeContext = () => contextFor({
        root: machine,
        provider,
        ...(darwin ? { platform: 'darwin' } : { systemd: true }),
        healthBuild: serviceBuild,
      });
      const providerFactory = (options: SystemdProviderOptions) => {
        provider.agentDirectories = options.agentExecutableDirectories ?? [];
        provider.agentOverrides = options.agentExecutableOverrides ?? {};
        provider.runtimePath = options.runtimePath;
        return provider;
      };
      const installed = await runSetup({
        ...setupOptions({
          root: machine,
          provider,
          presenter: new ServicePresenter({ service: flavor.id }),
          ...(darwin ? { platform: 'darwin' } : {}),
          buildInfo: serviceBuild,
        }),
        context: makeContext(),
        runtimePath: process.execPath,
        systemdProviderFactory: providerFactory,
      });
      const durablePath = readFileSync(provider.environmentPath, 'utf8')
        .split('\n').find((line) => line.startsWith('PATH=')) ?? '';
      const inspection = await inspectSetupEnvironment({
        buildInfo: serviceBuild,
        executablePath: join(machine, 'bin', 'cosyncing'),
        runtimePath: process.execPath,
        home: join(machine, '.cosyncing'),
        context: makeContext(),
        systemdProviderFactory: providerFactory,
      });
      const doctorPath = inspection.doctor.sections.flatMap((section) => section.checks)
        .find((candidate) => candidate.id === 'service.agent-executable-path');
      check(`doctor expects the runtime directory a fresh ${flavor.id} JavaScript install put on the service PATH`,
        installed.status === 'complete'
          && durablePath.includes(dirname(process.execPath))
          && inspection.systemdStatus?.environment === 'current'
          && doctorPath?.status === 'pass',
        `${installed.status} env=${inspection.systemdStatus?.environment} `
          + `${doctorPath?.status}:${doctorPath?.detailCode} ${JSON.stringify(doctorPath?.evidence)}`);

      // The converse: when Bun genuinely moved, the same reconstruction must fail toward a repair that HAS
      // something to rewrite — a check that passed unconditionally would be worse than the loop it replaces.
      const movedReport = await collectDoctorReport({
        buildInfo: serviceBuild,
        context: makeContext(),
        assetReport: inspectRuntimeAssets(),
        adapters: [],
        stateHome: join(machine, '.cosyncing'),
        applicationIdentity: {
          distribution: 'bun-js',
          applicationPath: join(machine, '.cosyncing', 'bin', 'cosyncing'),
          runtimePath: join(machine, 'moved-bun', 'bin', 'bun'),
          packaged: true,
        },
        codexTuiReadiness: { status: 'ok', customSocket: false, staleCandidatePids: [], message: 'fixture' },
      });
      const movedPath = movedReport.sections.flatMap((section) => section.checks)
        .find((candidate) => candidate.id === 'service.agent-executable-path');
      check(`a runtime that moved after ${flavor.id} setup reads as stale service PATH, so repair has work to do`,
        movedPath?.status === 'fail'
          && movedPath.detailCode === 'service-agent-path-stale'
          && movedPath.evidence?.missingDirectories === 1
          && movedPath.evidence?.obsoleteDirectories === 1,
        `${movedPath?.status}:${movedPath?.detailCode} ${JSON.stringify(movedPath?.evidence)}`);
    }
  }

  // The unit must exec the bootstrap copy under the state home, never the running executable. An acquisition
  // artifact (an `npm i -g` path under node_modules) is moved by `npm update`/`npm uninstall`, which would
  // leave a boot service pointing at a path that no longer exists.
  {
    const machine = join(root, 'execstart-home-copy');
    const npmBinary = join(machine, 'npm-global', 'lib', 'node_modules', 'cosyncing', 'bin', 'cosyncing');
    mkdirSync(join(machine, 'npm-global', 'lib', 'node_modules', 'cosyncing', 'bin'), { recursive: true });
    writeFileSync(npmBinary, 'fixture-packaged-binary', { mode: 0o755 });
    const provider = new FakeServiceProvider(machine);
    const handed: string[] = [];
    const installed = await runSetup({
      ...setupOptions({ root: machine, provider, presenter: new ServicePresenter({ service: 'systemd' }) }),
      executablePath: npmBinary,
      systemdProviderFactory: (options) => { handed.push(options.executablePath); return provider; },
    });
    const homeCopy = join(machine, '.cosyncing', 'bin', 'cosyncing');
    check('setup points the systemd unit at the installed home copy, never at the npm acquisition path',
      installed.status === 'complete' && handed.length > 0
        && handed.every((path) => path === homeCopy)
        && existsSync(homeCopy),
      handed.join(','));
  }

  // Clean install, separate lingering consent, and no-op rerun.
  {
    const machine = join(root, 'clean-install');
    const provider = new FakeServiceProvider(machine);
    const presenter = new ServicePresenter({ service: 'systemd' });
    const installed = await runSetup(setupOptions({ root: machine, provider, presenter }));
    const install = inspectInstallState(join(machine, '.cosyncing'));
    check('clean Linux setup commits definition before one service start and health check',
      installed.status === 'complete'
        && provider.events.filter((event) => event === 'install').length === 1
        && provider.events.filter((event) => event === 'start').length === 1
        && provider.events.indexOf('install') < provider.events.indexOf('start')
        && install.committed
        && install.state.resources.some((resource) => resource.id === 'service-systemd'));
    check('choosing the systemd service enables lingering with it, without a separate prompt',
      presenter.calls.join(',') === 'language,intro,ack,skill,opencode-shim,service,tailscale,quota,plan,confirm,complete'
        && provider.events.includes('enable-linger')
        && provider.lingering === 'enabled',
      presenter.calls.join(','));
    const mutationsBefore = provider.events.length;
    const rerunPresenter = new ServicePresenter();
    const rerun = await runSetup(setupOptions({ root: machine, provider, presenter: rerunPresenter }));
    check('healthy committed systemd setup reruns as a mutation-free no-op',
      rerun.status === 'already-configured'
        && rerunPresenter.calls.join(',') === 'language,intro,complete'
        && provider.events.length === mutationsBefore);

    const upgradePresenter = new ServicePresenter({ service: 'systemd' });
    const beforeUpgrade = provider.events.length;
    const upgraded = await runSetup(setupOptions({
      root: machine,
      provider,
      presenter: upgradePresenter,
      buildInfo: { ...BUILD_INFO, version: '0.1.1', packaged: true, target: 'bun-linux-x64' },
    }));
    const upgradeEvents = provider.events.slice(beforeUpgrade);
    check('live service reconfiguration performs exactly one stop, apply, commit, and start cycle',
      upgraded.status === 'complete'
        && upgradeEvents.filter((event) => event === 'stop').length === 1
        && upgradeEvents.filter((event) => event === 'install').length === 1
        && upgradeEvents.filter((event) => event === 'start').length === 1,
      upgradeEvents.join(','));

    // `ok: true` proves only that SOMETHING holds the broker port. After a binary replacement the likeliest
    // something is the previous build, whose process survives the file swap; setup must not sign off on an
    // install of bytes nothing is executing.
    //
    // Three refusals, each one the case the previous binding could not see. The installed build is fixed and
    // only what the RESPONDER claims moves, so each pin isolates exactly one term of the fingerprint.
    const installedBuild = {
      ...BUILD_INFO, version: '0.1.0', commit: '2222222', buildDate: '2026-08-06T00:00:00.000Z',
      dirty: false, packaged: true, target: 'bun-linux-x64',
    } as const;
    const refusal = async (
      name: string,
      directory: string,
      answered: Readonly<Omit<BuildInfo, 'schemaVersions' | 'contract'>>,
      expectedInDetail: readonly string[],
    ): Promise<void> => {
      const machineRoot = join(root, directory);
      const result = await runSetup(setupOptions({
        root: machineRoot,
        provider: new FakeServiceProvider(machineRoot),
        presenter: new ServicePresenter({ service: 'systemd' }),
        buildInfo: installedBuild,
        healthBuild: answered,
      }));
      check(name,
        result.status === 'failed' && result.failure?.code === 'verify-post-commit'
          && expectedInDetail.every((term) => result.failure!.detail.includes(term)),
        `${result.status}:${result.failure?.code}:${result.failure?.detail}`);
    };

    // A different release entirely.
    await refusal('post-commit verification rejects a healthy answer from a build setup did not just install',
      'stale-responder', { ...installedBuild, version: '0.1.1' }, ['0.1.1', '0.1.0']);
    // One semver, two commits — what an in-cycle upgrade actually produces, and what a version-only
    // comparison cannot see.
    await refusal('post-commit verification rejects a same-version answer from a different commit',
      'stale-commit-responder', { ...installedBuild, commit: '1111111' }, ['1111111', '2222222']);
    // Same version AND same commit, different ARTIFACT: one built from a dirty checkout, one clean. Nothing
    // in the version/commit pair separates these, yet they can contain different code — a rebuilt dev binary
    // left running under a unit whose ExecStart now holds the clean release build reports an identical
    // version and commit. Only the rest of the build identity distinguishes them.
    await refusal('post-commit verification rejects a same-commit answer from a different build',
      'stale-build-responder', { ...installedBuild, dirty: true }, ['dirty', 'clean']);
  }

  // Cancelling at the service choice must abort before any mutation at all.
  {
    const machine = join(root, 'cancel-service');
    const provider = new FakeServiceProvider(machine);
    const presenter = new ServicePresenter({ cancelService: true });
    const cancelled = await runSetup(setupOptions({ root: machine, provider, presenter }));
    check('Ctrl+C at the service choice cancels before every mutation',
      cancelled.status === 'cancelled' && cancelled.exitCode === 130
        && !existsSync(join(machine, '.cosyncing')) && provider.events.length === 0
        && presenter.calls.join(',') === 'language,intro,ack,skill,opencode-shim,service,cancelled:service choice',
      presenter.calls.join(','));
  }
  {
    const machine = join(root, 'failed-health');
    const provider = new FakeServiceProvider(machine);
    provider.healthOk = false;
    const failed = await runSetup(setupOptions({
      root: machine,
      provider,
      presenter: new ServicePresenter({ service: 'systemd' }),
      healthAttempts: 2,
    }));
    const home = join(machine, '.cosyncing');
    check('failed service health rolls back every setup and service mutation',
      failed.status === 'failed' && failed.exitCode === 3
        && !existsSync(provider.definitionPath)
        && !existsSync(provider.environmentPath)
        && !inspectInstallState(home).committed
        && !existsSync(join(home, 'config.json'))
        && !readSetupTransactionJournal(home)
        && provider.enabled === 'disabled' && provider.active === 'inactive');
    check('rollback reverses only the lingering policy enabled by this transaction',
      provider.events.includes('enable-linger') && provider.events.includes('disable-linger')
        && provider.lingering === 'disabled');
    // A physical Linux audit hit exactly this path and was told only "setup failed". The failing step and
    // the real reason must reach the operator, not just the generic rollback sentence.
    check('a failed post-commit health check reports the step and the underlying service reason',
      failed.failure?.code === 'verify-post-commit'
        && /health/i.test(failed.failure.step)
        && /active=|healthy/i.test(failed.failure.detail)
        && failed.failure.rollback === 'complete'
        && !/^\s*$/.test(failed.failure.detail),
      `${failed.failure?.code}: ${failed.failure?.step} — ${failed.failure?.detail}`);
    // The record must outlive the rollback that erased every other trace of the run.
    const diagnostic = readSetupFailureDiagnostic(home);
    check('the machine-readable failure diagnostic survives rollback with timestamp, transaction, and reason',
      !!diagnostic && diagnostic.code === 'verify-post-commit'
        && diagnostic.transactionId.length > 0
        && Number.isFinite(Date.parse(diagnostic.recordedAt))
        && diagnostic.detail === failed.failure?.detail
        && diagnostic.rollback === 'complete'
        && existsSync(setupFailureDiagnosticPath(home)),
      JSON.stringify(diagnostic));
    const failureReport = await collectDoctorReport({
      buildInfo: BUILD_INFO,
      context: contextFor({ root: machine, provider }),
      assetReport: inspectRuntimeAssets(),
      adapters: [],
      stateHome: home,
      codexTuiReadiness: { status: 'unsupported', customSocket: false, staleCandidatePids: [], message: 'fixture' },
    });
    const failureCheck = failureReport.sections.flatMap((section) => section.checks)
      .find((candidate) => candidate.id === 'state.last-setup-failure');
    check('doctor surfaces the last setup failure with its reason',
      failureCheck?.status === 'warn'
        && failureCheck.summary.includes(diagnostic?.detail ?? '\0')
        && failureCheck.remediation?.command === 'cosyncing setup',
      `${failureCheck?.status}: ${failureCheck?.summary}`);
    // Rollback restored the files; the directories the writes created must not be left behind empty.
    check('rollback removes the directories it created that ended up empty',
      !existsSync(join(home, 'secrets')) && !existsSync(join(home, 'transactions')),
      `${existsSync(join(home, 'secrets'))}/${existsSync(join(home, 'transactions'))}`);

    // A later successful run clears the breadcrumb so doctor never reports a failure the host moved past.
    provider.healthOk = true;
    const recovered = await runSetup(setupOptions({
      root: machine,
      provider,
      presenter: new ServicePresenter({ service: 'systemd' }),
      healthAttempts: 2,
    }));
    const clearedReport = await collectDoctorReport({
      buildInfo: BUILD_INFO,
      context: contextFor({ root: machine, provider }),
      assetReport: inspectRuntimeAssets(),
      adapters: [],
      stateHome: home,
      codexTuiReadiness: { status: 'unsupported', customSocket: false, staleCandidatePids: [], message: 'fixture' },
    });
    check('a successful setup clears the recorded failure for setup and doctor alike',
      recovered.status === 'complete' && !recovered.failure
        && !readSetupFailureDiagnostic(home)
        && !clearedReport.sections.flatMap((section) => section.checks)
          .some((candidate) => candidate.id === 'state.last-setup-failure'),
      `${recovered.status}`);
  }

  // Accepted lingering is receipted only when cosyncing changed it.
  {
    const machine = join(root, 'linger-owned');
    const provider = new FakeServiceProvider(machine);
    const accepted = await runSetup(setupOptions({
      root: machine,
      provider,
      presenter: new ServicePresenter({ service: 'systemd' }),
    }));
    const install = inspectInstallState(join(machine, '.cosyncing'));
    check('accepted lingering is enabled and ownership is recorded independently',
      accepted.status === 'complete' && provider.lingering === 'enabled' && install.committed
        && install.state.resources.some((resource) => resource.id === 'service-systemd-linger'));

    const switched = await runSetup(setupOptions({
      root: machine,
      provider,
      presenter: new ServicePresenter({ service: 'foreground' }),
      buildInfo: { ...BUILD_INFO, version: '0.1.2', packaged: true, target: 'bun-linux-x64' },
    }));
    const switchedInstall = inspectInstallState(join(machine, '.cosyncing'));
    check('switching to foreground removes only the receipt-owned service and lingering policy',
      switched.status === 'complete' && provider.lingering === 'disabled'
        && provider.enabled === 'disabled' && provider.active === 'inactive'
        && switchedInstall.committed
        && !switchedInstall.state.resources.some((resource) => resource.id.startsWith('service-')));
  }
  {
    const machine = join(root, 'linger-preexisting');
    const provider = new FakeServiceProvider(machine);
    provider.lingering = 'enabled';
    const accepted = await runSetup(setupOptions({
      root: machine,
      provider,
      presenter: new ServicePresenter({ service: 'systemd' }),
    }));
    const install = inspectInstallState(join(machine, '.cosyncing'));
    check('pre-existing user lingering is preserved without claiming ownership',
      accepted.status === 'complete' && install.committed
        && !provider.events.includes('enable-linger')
        && !install.state.resources.some((resource) => resource.id === 'service-systemd-linger'));
  }

  // Unowned files are never overwritten.
  {
    const machine = join(root, 'collision');
    const provider = new FakeServiceProvider(machine);
    atomicWriteOwnerOnly(provider.definitionPath, provider.expectedDefinition(), { mode: 0o600 });
    atomicWriteOwnerOnly(provider.environmentPath, provider.expectedEnvironment(), { mode: 0o600 });
    const before = `${readFileSync(provider.definitionPath, 'utf8')}|${readFileSync(provider.environmentPath, 'utf8')}`;
    const blocked = await runSetup(setupOptions({
      root: machine,
      provider,
      presenter: new ServicePresenter({ service: 'systemd' }),
    }));
    const after = `${readFileSync(provider.definitionPath, 'utf8')}|${readFileSync(provider.environmentPath, 'utf8')}`;
    check('unowned systemd definition collision blocks and preserves both files byte-for-byte',
      blocked.status === 'blocked' && blocked.issueCodes?.includes('systemd-definition-unowned') === true
        && before === after && provider.events.length === 0);
  }

  // WSL capability staging is truthful in both subsets.
  {
    const machine = join(root, 'wsl-foreground');
    const presenter = new ServicePresenter({ service: 'foreground' });
    const setup = await runSetup(setupOptions({
      root: machine,
      presenter,
      systemd: false,
      wsl: true,
    }));
    check('WSL without systemd commits foreground mode with no false persistence prompt or claim',
      setup.status === 'complete' && readSetupState(join(machine, '.cosyncing')).serviceChoice === 'foreground'
        && !presenter.calls.includes('lingering'));
  }
  {
    const machine = join(root, 'wsl-systemd');
    const provider = new FakeServiceProvider(machine);
    const setup = await runSetup(setupOptions({
      root: machine,
      provider,
      presenter: new ServicePresenter({ service: 'systemd' }),
      wsl: true,
    }));
    check('WSL with a user manager passes the persistent-service subset',
      setup.status === 'complete' && provider.active === 'active' && provider.lingering === 'enabled');
  }

  // The shipping launchd provider: plist rendering, launchctl argv, defensive `print` parsing, and uninstall.
  // All of it runs on Linux through the ServiceCommandRunner seam; nothing here needs a Mac.
  {
    const machine = join(root, 'launchd renderer');
    mkdirSync(machine, { recursive: true });
    const runner = new LaunchctlRunner();
    const nodeAgentBin = join(machine, 'node-v22.14.0-darwin-arm64', 'bin');
    const opencodeBin = join(machine, '.opencode', 'bin');
    const provider = new LaunchdUserServiceProvider({
      context: darwinContext(machine),
      homeDir: machine,
      stateHome: join(machine, '.cosyncing'),
      cacheRoot: join(machine, '.cache', 'cosyncing'),
      executablePath: join(machine, 'bin with spaces', 'cosyncing'),
      distribution: 'native',
      agentExecutableDirectories: [nodeAgentBin, opencodeBin],
      webDir: join(machine, 'acquisition', 'cosyncing-web-9.9.9'),
      workingDirectory: join(machine, 'working tree'),
      runner,
      launchctlPath: '/bin/launchctl',
      tailPath: '/usr/bin/tail',
      userIdentifier: '501',
    });
    const plist = provider.expectedDefinition();
    const environment = provider.expectedEnvironment();
    check('launchd plist declares the agreed job policy and carries no credential',
      plist.includes('<key>Label</key>\n  <string>dev.cosyncing.broker</string>')
        && plist.includes(`<string>${join(machine, 'bin with spaces', 'cosyncing')}</string>`)
        && plist.includes('<string>broker</string>')
        && plist.includes('<key>RunAtLoad</key>\n  <true/>')
        && plist.includes('<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>')
        && plist.includes(`<key>StandardOutPath</key>\n  <string>${provider.standardOutPath}</string>`)
        && plist.includes(`<key>StandardErrorPath</key>\n  <string>${provider.standardErrorPath}</string>`)
        && !plist.includes('COSYNCING_TOKEN=') && !/--token/.test(plist));
    check('launchd materializes the identical receipt-owned environment into EnvironmentVariables',
      ['HOME', 'PATH', 'COSYNCING_HOME', 'COSYNCING_CACHE_DIR', 'COSYNCING_TOKEN_FILE', 'COSYNCING_PI_INTEGRATION_FILE',
        'COSYNCING_WEB_DIR']
        .every((name) => environment.includes(`${name}=`) && plist.includes(`<key>${name}</key>`))
        // The provider marker lives only in the definition, exactly as systemd's Environment= line does.
        && plist.includes('<key>COSYNCING_SERVICE_PROVIDER</key>\n    <string>launchd</string>')
        && !environment.includes('COSYNCING_SERVICE_PROVIDER'),
      environment);
    check('launchd PATH materializes detected versioned-Node and ~/.opencode directories into both receipt and plist',
      environment.includes(`${nodeAgentBin}:${opencodeBin}`)
        && plist.includes(`${nodeAgentBin}:${opencodeBin}`)
        && !`${environment}\n${plist}`.includes('/interactive-only/bin'));
    check('launchd state root stays ~/.cosyncing with logs inside it',
      provider.environmentPath === join(machine, '.cosyncing', 'service', 'broker.env')
        && provider.logDirectory === join(machine, '.cosyncing', 'logs')
        && provider.definitionPath === join(machine, 'Library', 'LaunchAgents', 'dev.cosyncing.broker.plist'));

    const beforeInstall = await provider.inspect();
    await provider.installDefinition();
    const afterInstall = await provider.inspect();
    const installArgv = runner.calls.map((call) => call.args.join(' '));
    check('installDefinition writes both files then bootout/enable/bootstrap in that order',
      beforeInstall.definition === 'missing' && beforeInstall.enabled === 'disabled'
        && beforeInstall.active === 'inactive'
        && afterInstall.definition === 'current' && afterInstall.environment === 'current'
        && afterInstall.enabled === 'enabled' && afterInstall.active === 'active'
        && installArgv.includes(`bootout gui/501/dev.cosyncing.broker`)
        && installArgv.includes(`enable gui/501/dev.cosyncing.broker`)
        && installArgv.includes(`bootstrap gui/501 ${provider.definitionPath}`)
        && installArgv.indexOf('enable gui/501/dev.cosyncing.broker')
          < installArgv.findIndex((argv) => argv.startsWith('bootstrap ')),
      installArgv.join(' | '));

    runner.calls.length = 0;
    runner.bootoutPrintLag = 3;
    await provider.installDefinition();
    const delayedBootoutArgv = runner.calls.map((call) => call.args.join(' '));
    const delayedBootoutIndex = delayedBootoutArgv.indexOf('bootout gui/501/dev.cosyncing.broker');
    const delayedBootstrapIndex = delayedBootoutArgv.findIndex((argv) => argv.startsWith('bootstrap '));
    const unloadProbes = delayedBootoutArgv
      .slice(delayedBootoutIndex + 1, delayedBootstrapIndex)
      .filter((argv) => argv === 'print gui/501/dev.cosyncing.broker').length;
    check('launchd replacement waits for an acknowledged bootout to leave the domain before bootstrap',
      delayedBootoutIndex >= 0
        && delayedBootstrapIndex > delayedBootoutIndex
        && unloadProbes === 3
        && runner.loaded
        && runner.running,
      delayedBootoutArgv.join(' | '));
    runner.bootoutPrintLag = 0;

    check('lingering is reported unsupported and is never emulated with a LaunchDaemon',
      afterInstall.lingering === 'unsupported'
        && await provider.enableLingering().then(() => false, () => true)
        && !runner.calls.some((call) => call.args.join(' ').includes('system/')));

    runner.calls.length = 0;
    await provider.stop();
    const stopped = await provider.inspect();
    await provider.start();
    const started = await provider.inspect();
    await provider.restart();
    const lifecycleArgv = runner.calls.map((call) => call.args.join(' '));
    check('stop SIGTERMs the loaded job while start and restart use kickstart',
      stopped.active === 'inactive' && started.active === 'active'
        && lifecycleArgv.includes('kill SIGTERM gui/501/dev.cosyncing.broker')
        && lifecycleArgv.includes('kickstart gui/501/dev.cosyncing.broker')
        && lifecycleArgv.includes('kickstart -k gui/501/dev.cosyncing.broker'),
      lifecycleArgv.join(' | '));
    check('every launchctl call is bounded argv with no shell interpolation',
      runner.calls.length > 0
        && runner.calls.every((call) => call.executable.startsWith('/')
          && !call.args.some((arg) => /[\0\r\n]/.test(arg))
          && !call.args.includes('sh') && !call.args.includes('-c')));
    check('launchd logs command tails both owned files and adds -f only when following',
      provider.logsCommand({ follow: false, lines: 120 }).join(' ')
        === `/usr/bin/tail -n 120 ${provider.standardOutPath} ${provider.standardErrorPath}`
        && provider.logsCommand({ follow: true, lines: 120 }).join(' ')
          === `/usr/bin/tail -f -n 120 ${provider.standardOutPath} ${provider.standardErrorPath}`);

    const installedMode = statSync(provider.definitionPath).mode & 0o777;
    await provider.uninstall();
    check('uninstall boots the job out and removes only the two owned files',
      installedMode === 0o600
        && !existsSync(provider.definitionPath) && !existsSync(provider.environmentPath)
        && runner.loaded === false
        && (await provider.inspect()).definition === 'missing');
  }

  // `launchctl print` parsing: every recognized posture, plus garbage and missing, without throwing.
  {
    const printed = (stdout: string): ServiceCommandResult => ({ status: 'ok', exitCode: 0, stdout, stderr: '' });
    const running = parseLaunchdPrintState(printed('x = {\n\tstate = running\n\tlast exit code = 0\n}\n'));
    const stopped = parseLaunchdPrintState(printed('x = {\n\tstate = not running\n\tlast exit code = 0\n}\n'));
    const crashed = parseLaunchdPrintState(printed('x = {\n\tstate = not running\n\tlast exit code = 1\n}\n'));
    const throttled = parseLaunchdPrintState(printed('x = {\n\tstate = waiting\n\tlast exit code = 78\n}\n'));
    const scheduled = parseLaunchdPrintState(printed('x = {\n\tstate = spawn scheduled\n}\n'));
    check('launchctl print maps running, stopped, crashed, and throttled postures',
      running.active === 'active' && running.enabled === 'enabled'
        && stopped.active === 'inactive' && stopped.enabled === 'enabled'
        && crashed.active === 'failed' && throttled.active === 'failed'
        && scheduled.active === 'transitioning',
      JSON.stringify({ running, stopped, crashed, throttled, scheduled }));

    const missing = parseLaunchdPrintState({ status: 'error', exitCode: 113, stdout: '', stderr: 'Could not find service "x"\n' });
    const denied = parseLaunchdPrintState({ status: 'error', exitCode: 1, stdout: '', stderr: 'Operation not permitted\n' });
    const noLaunchctl = parseLaunchdPrintState({ status: 'unavailable', stdout: '', stderr: '' });
    const timedOut = parseLaunchdPrintState({ status: 'timeout', stdout: '', stderr: '' });
    const garbage = parseLaunchdPrintState(printed('\0\x01 not remotely plist output {{{\n'));
    const empty = parseLaunchdPrintState(printed(''));
    check('unloaded is a fact while unparseable, denied, absent, and timed-out output is unknown',
      missing.active === 'inactive' && missing.enabled === 'disabled'
        && denied.active === 'unknown' && denied.enabled === 'unknown'
        && noLaunchctl.active === 'unknown' && timedOut.active === 'unknown'
        && garbage.active === 'unknown' && garbage.enabled === 'unknown'
        && empty.active === 'unknown' && empty.enabled === 'unknown',
      JSON.stringify({ missing, denied, garbage, empty }));

    // Verbatim strings captured from `launchctl print gui/$UID/dev.cosyncing.broker` on macOS 26.5.2,
    // including the leading TAB indentation, the "(never exited)" first-run exit value, and the deeper
    // nested `state = active` line that belongs to an endpoint rather than the job. The nested line is
    // placed BEFORE the job's own state here because that ordering is what makes a first-match parser
    // silently read the wrong vocabulary.
    const capturedRunning = [
      'dev.cosyncing.broker = {',
      '\tactive count = 1',
      '\tpath = /Library/LaunchAgents/dev.cosyncing.broker.plist',
      '\tstate = running',
      '\tlast exit code = (never exited)',
      '}',
      '',
    ].join('\n');
    const capturedStopped = [
      'dev.cosyncing.broker = {',
      '\tactive count = 0',
      '\tstate = not running',
      '\tlast exit code = 0',
      '}',
      '',
    ].join('\n');
    const capturedNestedEndpoint = [
      'dev.cosyncing.broker = {',
      '\tendpoints = {',
      '\t\t"dev.cosyncing.broker.socket" = {',
      '\t\t\tstate = active',
      '\t\t}',
      '\t}',
      '\tstate = not running',
      '\tlast exit code = 0',
      '}',
      '',
    ].join('\n');
    // Verbatim from a real Mac stuck mid-rollback: launchd holds a queued spawn intent and reports this
    // for as long as it holds it (12+ seconds observed). It is in-between, not unknowable, so the wait loop
    // must poll through it. `spawn failed` is launchd saying it could not exec at all, which is terminal.
    const capturedSpawnScheduled = 'dev.cosyncing.broker = {\n\tstate = spawn scheduled\n}\n';
    const capturedSpawnFailed = 'dev.cosyncing.broker = {\n\tstate = spawn failed\n\tlast exit code = 1\n}\n';
    const spawnScheduled = parseLaunchdPrintState(printed(capturedSpawnScheduled));
    const spawnFailed = parseLaunchdPrintState(printed(capturedSpawnFailed));
    check('a queued launchd spawn is transitional and a failed spawn is terminal, neither is unknown',
      spawnScheduled.active === 'transitioning' && spawnScheduled.enabled === 'enabled'
        && spawnFailed.active === 'failed',
      JSON.stringify({ spawnScheduled, spawnFailed }));

    const capturedFirstRun = parseLaunchdPrintState(printed(capturedRunning));
    const capturedAfterStop = parseLaunchdPrintState(printed(capturedStopped));
    const capturedNested = parseLaunchdPrintState(printed(capturedNestedEndpoint));
    check('real macOS print output parses through tabs, "(never exited)", and nested endpoint state',
      capturedFirstRun.active === 'active' && capturedFirstRun.enabled === 'enabled'
        && capturedAfterStop.active === 'inactive'
        // The nested endpoint's `state = active` must never be mistaken for the job's own state.
        && capturedNested.active === 'inactive',
      JSON.stringify({ capturedFirstRun, capturedAfterStop, capturedNested }));
  }

  // The transition wait loop. launchd's verbs return before the job settles, so a provider that only
  // reaches its target state on a later sample must still be reported as succeeding.
  {
    class SettlingProvider extends FakeLaunchdProvider {
      samples = 0;
      /** Samples to serve the pre-transition state before reporting the target. */
      lag = 3;
      pending: DurableServiceStatus['active'] = 'active';
      override async inspect(): Promise<DurableServiceStatus> {
        const status = await super.inspect();
        this.samples += 1;
        return this.samples <= this.lag ? { ...status, active: this.pending } : status;
      }
    }
    const machine = join(root, 'launchd-settling');
    const provider = new SettlingProvider(machine);
    await provider.installDefinition();
    provider.active = 'inactive';
    provider.samples = 0;
    provider.pending = 'active';
    const settled = await awaitServiceState({ provider, expected: 'inactive', delayMs: 1 });
    check('a stop that settles only after several samples is observed, not declared failed',
      settled.active === 'inactive' && provider.samples > provider.lag,
      `${settled.active} after ${provider.samples} samples`);

    provider.active = 'failed';
    provider.samples = 0;
    provider.lag = 0;
    const crashLoop = await awaitServiceState({ provider, expected: 'active', attempts: 40, delayMs: 1 });
    check('a crash-looping job short-circuits instead of burning the whole deadline',
      crashLoop.active === 'failed' && provider.samples === 1,
      `${crashLoop.active} after ${provider.samples} samples`);
  }

  // A first macOS Serve route may be correct before MagicDNS/certificate propagation lets the advertised
  // HTTPS request through. Setup must wait for that endpoint, while retaining the ordinary transaction
  // rollback if it never becomes this machine's broker.
  {
    const machine = join(root, 'launchd-tailscale-delayed');
    const provider = new FakeLaunchdProvider(machine);
    const tailscale = new FakeTailscaleProvider();
    const clock = new ImmediatePollingClock();
    let advertisedProbes = 0;
    const installed = await runSetup(setupOptions({
      root: machine,
      provider,
      tailscale,
      presenter: new ServicePresenter({ service: 'launchd', tailscale: true }),
      platform: 'darwin',
      buildInfo: { ...BUILD_INFO, packaged: true, target: 'darwin-arm64' },
      advertisedHealth: () => {
        advertisedProbes += 1;
        return advertisedProbes < 3
          ? { status: 'unreachable' }
          : {
              status: 'ok',
              statusCode: 200,
              json: {
                ok: true,
                product: 'cosyncing',
                machine: defaultBrokerConfig().broker.machineLabel,
              },
            };
      },
      advertisedEndpointVerification: { timeoutMs: 2_500, intervalMs: 500, clock },
    }));
    const install = inspectInstallState(join(machine, '.cosyncing'));
    check('macOS first-run setup waits for delayed advertised-endpoint readiness and then commits',
      installed.status === 'complete' && advertisedProbes === 3
        && install.committed && provider.active === 'active' && tailscale.route === 'desired'
        && tailscale.events.join(',') === 'register',
      `${installed.status} probes=${advertisedProbes} service=${provider.active} route=${tailscale.route}`);
    check('delayed advertised success leaves no polling timer behind',
      clock.schedules === 2 && clock.cancellations === 2 && clock.pending.size === 0,
      `scheduled=${clock.schedules} cancelled=${clock.cancellations} pending=${clock.pending.size}`);
  }

  {
    const machine = join(root, 'launchd-tailscale-unreachable');
    const home = join(machine, '.cosyncing');
    const provider = new FakeLaunchdProvider(machine);
    const tailscale = new FakeTailscaleProvider();
    const clock = new ImmediatePollingClock();
    let advertisedProbes = 0;
    const failed = await runSetup(setupOptions({
      root: machine,
      provider,
      tailscale,
      presenter: new ServicePresenter({ service: 'launchd', tailscale: true }),
      platform: 'darwin',
      buildInfo: { ...BUILD_INFO, packaged: true, target: 'darwin-arm64' },
      advertisedHealth: () => { advertisedProbes += 1; return { status: 'unreachable' }; },
      advertisedEndpointVerification: { timeoutMs: 1_001, intervalMs: 500, clock },
    }));
    check('a permanently unreachable advertised endpoint expires and rolls back the complete macOS setup',
      failed.status === 'failed' && failed.exitCode === 3
        && failed.failure?.code === 'verify-post-commit' && failed.failure.rollback === 'complete'
        && advertisedProbes === 3 && tailscale.events.join(',') === 'register,remove'
        && tailscale.route === 'missing'
        && provider.active === 'inactive' && provider.enabled === 'disabled'
        && !existsSync(provider.definitionPath) && !existsSync(provider.environmentPath)
        && !inspectInstallState(home).committed && !existsSync(join(home, 'config.json'))
        && !readSetupTransactionJournal(home),
      `${failed.status}:${failed.failure?.rollback} probes=${advertisedProbes} `
        + `service=${provider.active}/${provider.enabled} route=${tailscale.route}`);
    check('advertised deadline rollback leaves no service process or polling timer behind',
      provider.events.includes('uninstall')
        && clock.schedules === 3 && clock.cancellations === 3 && clock.pending.size === 0,
      `events=${provider.events.join(',')} scheduled=${clock.schedules} `
        + `cancelled=${clock.cancellations} pending=${clock.pending.size}`);
  }

  // A darwin setup commits the launchd provider, receipts it as `service-launchd`, and never prompts for
  // lingering; switching back to foreground drops the receipt again.
  {
    const machine = join(root, 'launchd-setup');
    const provider = new FakeLaunchdProvider(machine);
    const presenter = new ServicePresenter({ service: 'launchd' });
    const installed = await runSetup(setupOptions({
      root: machine,
      provider,
      presenter,
      platform: 'darwin',
    }));
    const install = inspectInstallState(join(machine, '.cosyncing'));
    check('darwin setup commits a launchd service with a service-launchd receipt',
      installed.status === 'complete'
        && readSetupState(join(machine, '.cosyncing')).serviceChoice === 'launchd'
        && install.committed
        && install.state.resources.some((resource) => resource.id === 'service-launchd')
        && install.state.resources.some((resource) => resource.id === 'service-environment')
        && !install.state.resources.some((resource) => resource.id === 'service-systemd'),
      `${installed.status}: ${installed.summary}`);
    check('darwin setup never prompts for lingering and claims no boot persistence',
      presenter.calls.join(',') === 'language,intro,ack,skill,opencode-shim,service,tailscale,quota,plan,confirm,complete'
        && !provider.events.includes('enable-linger'),
      presenter.calls.join(','));

    const switched = await runSetup(setupOptions({
      root: machine,
      provider,
      presenter: new ServicePresenter({ service: 'foreground' }),
      platform: 'darwin',
      buildInfo: { ...BUILD_INFO, version: '0.1.3', packaged: true, target: 'darwin-arm64' },
    }));
    const switchedInstall = inspectInstallState(join(machine, '.cosyncing'));
    check('switching a darwin install to foreground removes the receipt-owned launchd agent',
      switched.status === 'complete'
        && switchedInstall.committed
        && !switchedInstall.state.resources.some((resource) => resource.id.startsWith('service-')),
      `${switched.status}: ${switched.summary}`);
  }

  // Doctor exposes failed/crash-loop posture without leaking service environment contents.
  {
    const machine = join(root, 'doctor-failed');
    const provider = new FakeServiceProvider(machine);
    await runSetup(setupOptions({
      root: machine,
      provider,
      presenter: new ServicePresenter({ service: 'systemd' }),
    }));
    provider.active = 'failed';
    const report = await collectDoctorReport({
      buildInfo: BUILD_INFO,
      context: contextFor({ root: machine, provider }),
      assetReport: inspectRuntimeAssets(),
      adapters: [],
      stateHome: join(machine, '.cosyncing'),
      codexTuiReadiness: {
        status: 'unsupported',
        customSocket: false,
        staleCandidatePids: [],
        message: 'fixture',
      },
    });
    const service = report.sections.flatMap((section) => section.checks)
      .find((candidate) => candidate.id === 'service.broker');
    const reportJson = JSON.stringify(report);
    check('doctor makes failed or crash-looping service posture actionable and redacted',
      service?.status === 'fail' && service.detailCode === 'broker-service-failed'
        && !reportJson.includes(provider.expectedEnvironment()));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((entry) => !entry.ok);
if (failed.length) {
  console.error(`\nFAIL ${failed.length}/${results.length} service-lifecycle checks`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} service-lifecycle checks`);
