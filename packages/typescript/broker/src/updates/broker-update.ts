import { WINDOWS_TASK_SCHEDULER_TIMEOUT_MS } from '../installation/windows-task-scheduler-powershell.ts';
import { isAbsolute } from 'node:path';
import type { BuildInfo } from '../runtime/build-info.ts';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import type { BrokerServiceBoundary } from '../runtime/service-boundary.ts';
import { settleWithDeadline } from '../installation/service-manager.ts';
import { stageBrokerUpdateRunner, windowsBrokerUpdateCommand } from './broker-update-runner.ts';
import { QUALIFIED_BROKER_UPDATE_PROVIDERS } from './desktop-updater-support.ts';
import {
  checkReleaseUpdate,
  packageManagerUpdateGuidance,
  isReleaseId,
  releaseIdVersion,
  type ReleaseUpdateCheckDependencies,
  type ReleaseUpdateCheckResult,
} from './release-upgrade.ts';

export const BROKER_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface BrokerUpdateSnapshot extends ReleaseUpdateCheckResult {
  cached: boolean;
  nextCheckAt: string;
}

/** One shared promise and one daily cache prevent request bursts from becoming release-channel storms. */
export class BrokerUpdateChecker {
  private cached?: { result: ReleaseUpdateCheckResult; expiresAt: number };
  private inFlight?: Promise<ReleaseUpdateCheckResult>;

  constructor(
    private readonly dependencies: ReleaseUpdateCheckDependencies,
    private readonly options: { ttlMs?: number; now?: () => number } = {},
  ) {}

  async inspect(input: { refresh?: boolean } = {}): Promise<BrokerUpdateSnapshot> {
    const now = this.options.now?.() ?? Date.now();
    const ttlMs = Math.max(1_000, this.options.ttlMs ?? BROKER_UPDATE_CHECK_INTERVAL_MS);
    if (!input.refresh && this.cached && this.cached.expiresAt > now) {
      return this.snapshot(this.cached.result, true, this.cached.expiresAt);
    }
    if (!this.inFlight) {
      this.inFlight = checkReleaseUpdate(this.dependencies).finally(() => {
        this.inFlight = undefined;
      });
    }
    const result = await this.inFlight;
    const expiresAt = now + ttlMs;
    this.cached = { result, expiresAt };
    return this.snapshot(result, false, expiresAt);
  }

  /** Explicit acceptance/candidate path; verified with the embedded key and never replaces stable cache. */
  async inspectManifest(manifestUrl: string): Promise<BrokerUpdateSnapshot> {
    const now = this.options.now?.() ?? Date.now();
    const ttlMs = Math.max(1_000, this.options.ttlMs ?? BROKER_UPDATE_CHECK_INTERVAL_MS);
    const result = await checkReleaseUpdate({ ...this.dependencies, manifestUrl });
    return this.snapshot(result, false, now + ttlMs);
  }

  private snapshot(
    result: ReleaseUpdateCheckResult,
    cached: boolean,
    expiresAt: number,
  ): BrokerUpdateSnapshot {
    return { ...result, cached, nextCheckAt: new Date(expiresAt).toISOString() };
  }
}

export interface BrokerUpdateTriggerResult {
  schemaVersion: 1;
  status: 'accepted' | 'blocked' | 'failed';
  detailCode: string;
  message: string;
  fromVersion: string;
  toVersion?: string;
}

export type BrokerUpdateLaunchDecision =
  | { allowed: true }
  | { allowed: false; detailCode: 'grant-revoked' | 'installation-superseded' | 'launch-authority-consumed' };

export interface BrokerUpdateTriggerDependencies {
  buildInfo: Readonly<BuildInfo>;
  service: Readonly<BrokerServiceBoundary>;
  /** The cosyncing APPLICATION artifact, never the runtime that executes it. */
  executablePath: string;
  /** The external runtime that must exec `executablePath`. Absent only for a compiled native build. */
  runtimePath?: string;
  stateHome: string;
  cacheRoot?: string;
  userHome?: string;
  systemdRunPath?: string;
  launchdPlistPath?: string;
  windowsPowerShellPath?: string;
  /** Owner-only runner payload staged outside the installation being replaced. */
  windowsPayloadPath?: string;
  manifestUrl?: string;
  /**
   * The immutable release the caller reviewed, spelled into the handoff.
   *
   * Without it the delegated command resolves the mutable pointer when it runs, which is a
   * different instruction from the one anybody approved: a release promoted between the
   * review and this process being replaced would be installed under a job that never saw it.
   */
  pinnedReleaseId?: string;
  /** Durable broker-only preparation, consumed by the independent worker. */
  preparedJobId?: string;
  /**
   * The authority answer for the moment the updater is actually scheduled.
   *
   * Asked after the command exists and before anything is spawned, because everything the caller
   * knew earlier was a fact about an earlier moment: an in-app commit re-reads the release
   * channel on its way here, and a grant the owner withdrew during that wait is withdrawn now.
   * Absent for an owner at a terminal, who has their own authority and nothing to re-ask.
   */
  authorizeLaunch?: () => BrokerUpdateLaunchDecision;
  run?: (argv: readonly string[]) => Promise<{ ok: boolean; detail?: string }>;
}

/**
 * Public for deterministic tests; argv-only, with any candidate URL bounded to credential-free HTTPS.
 *
 * A launcher runs outside the broker's lifetime: a transient systemd unit,
 * a separate launchd job, or a per-user scheduler task. Native qualification is
 * checked by the production trigger before it publishes an accepted handoff.
 */
export function brokerUpdateHandoffCommand(dependencies: BrokerUpdateTriggerDependencies): string[] | undefined {
  if (dependencies.service.provider === 'launchd') {
    return dependencies.launchdPlistPath && isAbsolute(dependencies.launchdPlistPath)
      && process.getuid ? ['/bin/launchctl', 'bootstrap', `gui/${process.getuid()}`, dependencies.launchdPlistPath] : undefined;
  }
  if (dependencies.service.provider === 'task-scheduler') return windowsBrokerUpdateCommand(dependencies);
  if (dependencies.service.provider !== 'systemd') return undefined;
  const systemdRun = dependencies.systemdRunPath ?? Bun.which('systemd-run') ?? undefined;
  if (!systemdRun || !isAbsolute(systemdRun) || !isAbsolute(dependencies.executablePath)
      || !isAbsolute(dependencies.stateHome)
      // An identity this command cannot express as a pin is not a pin to guess at: there is
      // no handoff, and the caller is told to run the upgrader itself.
      || (dependencies.pinnedReleaseId !== undefined && !isReleaseId(dependencies.pinnedReleaseId))
      || (dependencies.manifestUrl && !isBrokerUpdateManifestUrl(dependencies.manifestUrl))) {
    return undefined;
  }
  const command = [
    systemdRun,
    '--user',
    '--collect',
    '--unit=cosyncing-broker-update',
    '--on-active=2s',
    '--property=Type=exec',
    `--setenv=COSYNCING_HOME=${dependencies.stateHome}`,
  ];
  if (dependencies.cacheRoot && isAbsolute(dependencies.cacheRoot)) {
    command.push(`--setenv=COSYNCING_CACHE_DIR=${dependencies.cacheRoot}`);
  }
  if (dependencies.userHome && isAbsolute(dependencies.userHome)) {
    command.push(`--setenv=HOME=${dependencies.userHome}`);
    command.push(`--working-directory=${dependencies.userHome}`);
  }
  // The runtime, when there is one, comes first: `systemd-run ... <bundle> upgrade` would exec a JavaScript
  // file the kernel can only run through its shebang, and the transient unit carries no PATH to resolve it.
  if (dependencies.runtimePath) {
    if (!isAbsolute(dependencies.runtimePath)) return undefined;
    command.push(dependencies.runtimePath);
  }
  // Server-only, spelled out. The app's update button means "update this server", and
  // an unscoped `upgrade` also reconciles the installer-owned desktop on this host --
  // which is what a person at a terminal wants, and is not what a phone asked for.
  command.push(dependencies.executablePath, 'upgrade', '--yes', '--json', '--components', 'broker');
  // Ahead of the manifest flag and part of the same argv: the pin travels with the run that
  // has to honour it, so a transient unit started in twenty seconds installs the reviewed
  // build or refuses, whatever the channel is serving by then.
  if (dependencies.pinnedReleaseId) command.push('--release', dependencies.pinnedReleaseId);
  if (dependencies.preparedJobId) command.push('--prepared-job', dependencies.preparedJobId);
  if (dependencies.manifestUrl) command.push('--manifest', dependencies.manifestUrl);
  return command;
}

export function isBrokerUpdateManifestUrl(value: string): boolean {
  if (value.length > 2_048 || /[\0\r\n]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

async function defaultRun(argv: readonly string[], provider: string): Promise<{ ok: boolean; detail?: string }> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  // Cold Windows PowerShell imports and task registration use the same budget
  // as other scheduler operations. Clear the deadline when handoff settles.
  const completed = await settleWithDeadline(
    child.exited.then((exitCode) => ({ timedOut: false as const, exitCode })),
    provider === 'task-scheduler' ? WINDOWS_TASK_SCHEDULER_TIMEOUT_MS : 5_000,
    { timedOut: true as const, exitCode: -1 },
  );
  if (completed.timedOut) child.kill('SIGKILL');
  const stderr = child.stderr instanceof ReadableStream
    ? (await new Response(child.stderr).text()).trim().slice(-1_000)
    : '';
  if (completed.timedOut) await child.exited.catch(() => undefined);
  return completed.exitCode === 0
    ? { ok: true }
    : { ok: false, detail: stderr || (completed.timedOut ? `${provider} update handoff timed out` : `${provider} update handoff exited ${completed.exitCode}`) };
}

/** Queue the existing BPC8 CLI upgrader outside the broker service cgroup, after the HTTP 202 is flushed. */
export async function triggerBrokerUpdate(
  dependencies: BrokerUpdateTriggerDependencies,
  toVersion: string,
): Promise<BrokerUpdateTriggerResult> {
  const base = {
    schemaVersion: 1 as const,
    fromVersion: dependencies.buildInfo.version,
    toVersion,
  };
  // Same fence the CLI upgrade applies, for the same reason: the app's update button must never report that
  // a signed native release was queued on a distribution that cannot install one.
  const packageManagerOwned = packageManagerUpdateGuidance(dependencies.buildInfo);
  if (packageManagerOwned) {
    return { ...base, status: 'blocked', detailCode: packageManagerOwned.detailCode, message: packageManagerOwned.summary };
  }
  if (!dependencies.buildInfo.packaged) {
    return { ...base, status: 'blocked', detailCode: 'broker-update-source-build', message: 'Source builds cannot replace themselves.' };
  }
  if (!dependencies.service.managed) {
    return { ...base, status: 'blocked', detailCode: 'broker-update-managed-service-required', message: 'App-triggered updates require an installed durable user service.' };
  }
  if (dependencies.run === undefined && !QUALIFIED_BROKER_UPDATE_PROVIDERS.includes(dependencies.service.provider)) {
    return { ...base, status: 'blocked', detailCode: 'broker-update-handoff-unavailable',
      message: 'This platform has not completed native in-app update acceptance. Use the signed installer or cosy update.' };
  }
  let launchDependencies = dependencies;
  try {
    // Stubbed launches retain their explicit fixture; production pins the real
    // signed bundle before scheduling it outside the service's lifetime.
    if (dependencies.run === undefined) launchDependencies = stageBrokerUpdateRunner(dependencies);
  } catch {
    return { ...base, status: 'blocked', detailCode: 'broker-update-runner-untrusted',
      message: 'The installed updater could not prove ownership of its runner.' };
  }
  const command = brokerUpdateHandoffCommand(launchDependencies);
  if (!command) {
    // Missing native service infrastructure is a supported manual path, never
    // an accepted update that cannot actually be launched.
    return {
      ...base,
      status: 'blocked',
      detailCode: 'broker-update-handoff-unavailable',
      message: dependencies.service.provider === 'systemd'
        ? `The systemd update handoff is unavailable; run \`${PRODUCT_IDENTITY.primaryBinary} upgrade\` instead.`
        : `App-triggered updates are not available on ${dependencies.service.provider}; run \`${PRODUCT_IDENTITY.primaryBinary} upgrade\` instead.`,
    };
  }
  // The last question before a process exists. What is scheduled here fires on its own in two
  // seconds and nothing in this call can take it back, so an authority answer read anywhere
  // earlier -- including a few milliseconds and one channel refresh earlier -- is not this answer.
  const authority = dependencies.authorizeLaunch?.();
  if (authority !== undefined && !authority.allowed) {
    return {
      ...base,
      status: 'blocked',
      detailCode: authority.detailCode,
      message: authority.detailCode === 'installation-superseded'
        ? 'The installation changed before the updater was scheduled. Review the update again.'
        : authority.detailCode === 'grant-revoked'
          ? 'The update grant was withdrawn before the updater was scheduled.'
          : 'This launch authorization has already been used.',
    };
  }
  const launched = await (dependencies.run ? dependencies.run(command) : defaultRun(command, dependencies.service.provider));
  if (!launched.ok) {
    return { ...base, status: 'failed', detailCode: 'broker-update-handoff-failed', message: launched.detail || 'Could not queue the broker update.' };
  }
  return {
    ...base,
    status: 'accepted',
    detailCode: 'broker-update-accepted',
    message: 'The signed broker update was queued; clients will reconnect after its health check.',
  };
}

/** What a handoff needs beyond the launch itself: this host's reader of the release channel. */
export interface BrokerUpdateHandoffDependencies extends BrokerUpdateTriggerDependencies {
  checker: { inspect(input?: { refresh?: boolean }): Promise<BrokerUpdateSnapshot> };
}

/**
 * The handoff a confirmed in-app commit makes, kept as one function so its wait is a tested wait.
 *
 * It is in this shape for one reason: asking for authority and being answered are further apart
 * in time than they look. The channel refresh below is a network call, the grant that let this
 * commit start can be withdrawn during it, and the updater must not be scheduled on the strength
 * of an answer given beforehand. So this function does the observation, then asks the launcher to
 * ask, and the launcher asks at the only moment that means anything.
 *
 * `pinnedReleaseId` is the job's own reviewed release. The channel is re-read because a release
 * that has moved on means nobody is asking for this one any more, not because the answer is what
 * gets installed: the pin travels into the delegated command and is honoured, or refused, there.
 */
export async function handoffBrokerUpdate(
  dependencies: BrokerUpdateHandoffDependencies,
): Promise<{ accepted: boolean; detailCode: string }> {
  const pinned = dependencies.pinnedReleaseId;
  const version = pinned === undefined ? undefined : releaseIdVersion(pinned);
  if (version === undefined) return { accepted: false, detailCode: 'release-candidate-unreadable' };
  const update = await dependencies.checker.inspect({ refresh: true });
  // Never hand off a target the reviewed job did not pin, whatever the channel says right now.
  if (update.status !== 'update-available' || update.latestVersion !== version) {
    return { accepted: false, detailCode: 'release-target-moved' };
  }
  const handoff = await triggerBrokerUpdate(dependencies, version);
  return { accepted: handoff.status === 'accepted', detailCode: handoff.detailCode };
}
