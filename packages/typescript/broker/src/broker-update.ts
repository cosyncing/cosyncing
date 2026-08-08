import { isAbsolute } from 'node:path';
import type { BuildInfo } from './build-info.ts';
import { PRODUCT_IDENTITY } from './product.ts';
import type { BrokerServiceBoundary } from './service-boundary.ts';
import { settleWithDeadline } from './service-manager.ts';
import {
  checkReleaseUpdate,
  packageManagerUpdateGuidance,
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
  manifestUrl?: string;
  run?: (argv: readonly string[]) => Promise<{ ok: boolean; detail?: string }>;
}

/**
 * Public for deterministic tests; argv-only, with any candidate URL bounded to credential-free HTTPS.
 *
 * Returns undefined whenever no handoff exists — including on every launchd host, where there is no
 * systemd-run equivalent that can run the replacement outside the service's own process tree. The caller
 * turns that into an explicit `broker-update-handoff-unavailable` block naming the `upgrade` CLI, which
 * remains the supported path there; it never falls back to replacing the binary from inside the service.
 */
export function brokerUpdateHandoffCommand(dependencies: BrokerUpdateTriggerDependencies): string[] | undefined {
  if (dependencies.service.provider !== 'systemd') return undefined;
  const systemdRun = dependencies.systemdRunPath ?? Bun.which('systemd-run') ?? undefined;
  if (!systemdRun || !isAbsolute(systemdRun) || !isAbsolute(dependencies.executablePath)
      || !isAbsolute(dependencies.stateHome)
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
  command.push(dependencies.executablePath, 'upgrade', '--yes', '--json');
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

async function defaultRun(argv: readonly string[]): Promise<{ ok: boolean; detail?: string }> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  // Same held-timer hazard as the service command runner: the deadline must be cleared on settle, or the
  // handoff would keep this process alive for the full 5s after systemd-run already returned.
  const completed = await settleWithDeadline(
    child.exited.then((exitCode) => ({ timedOut: false as const, exitCode })),
    5_000,
    { timedOut: true as const, exitCode: -1 },
  );
  if (completed.timedOut) child.kill('SIGKILL');
  const stderr = child.stderr instanceof ReadableStream
    ? (await new Response(child.stderr).text()).trim().slice(-1_000)
    : '';
  if (completed.timedOut) await child.exited.catch(() => undefined);
  return completed.exitCode === 0
    ? { ok: true }
    : { ok: false, detail: stderr || (completed.timedOut ? 'systemd handoff timed out' : `systemd-run exited ${completed.exitCode}`) };
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
  const command = brokerUpdateHandoffCommand(dependencies);
  if (!command) {
    // launchd hosts land here by design: no handoff exists, so the honest answer names the command the
    // operator can run instead rather than implying the update was queued.
    return {
      ...base,
      status: 'blocked',
      detailCode: 'broker-update-handoff-unavailable',
      message: dependencies.service.provider === 'systemd'
        ? `The systemd update handoff is unavailable; run \`${PRODUCT_IDENTITY.primaryBinary} upgrade\` instead.`
        : `App-triggered updates are not available on ${dependencies.service.provider}; run \`${PRODUCT_IDENTITY.primaryBinary} upgrade\` instead.`,
    };
  }
  const launched = await (dependencies.run ?? defaultRun)(command);
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
