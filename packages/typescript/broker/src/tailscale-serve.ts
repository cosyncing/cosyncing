import type { SetupDiagnosisContext } from '@cosyncing/adapter-api';
import type { InstalledResourceRecord } from './install-state.ts';
import { PRODUCT_IDENTITY } from './product.ts';
import {
  createServiceCommandRunner,
  type ServiceCommandResult,
  type ServiceCommandRunner,
} from './service-manager.ts';
import type {
  SetupRollbackRecord,
  SetupTransactionAction,
} from './setup-transaction.ts';

export const TAILSCALE_SERVE_RESOURCE_ID = 'tailscale-serve-https-root';
export const TAILSCALE_SERVE_OWNERSHIP_MARKER = 'cosyncing-tailscale-serve-v1';

export type TailscaleTopology =
  | 'missing'
  | 'native-linux'
  | 'native-macos'
  | 'inside-wsl'
  | 'windows-host-only';

/**
 * The Mac App Store build ships its CLI inside the app bundle and does not put it on PATH; the standalone
 * and Homebrew builds do. Probing this exact path is the difference between "Tailscale is not installed"
 * and "it is installed, just not on your PATH".
 */
export const MACOS_TAILSCALE_BUNDLE_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/** Resolve the tailscale CLI for this host, including the macOS app-bundle fallback. */
function resolveTailscaleExecutable(context: SetupDiagnosisContext, wsl: boolean): string | undefined {
  const onPath = context.resolveExecutable('tailscale');
  if (onPath) return onPath;
  if (wsl) return context.resolveExecutable('tailscale.exe');
  if (context.platform !== 'darwin') return undefined;
  const bundled = context.inspectPath(MACOS_TAILSCALE_BUNDLE_CLI);
  return bundled.status === 'file' && bundled.readable ? MACOS_TAILSCALE_BUNDLE_CLI : undefined;
}

export type TailscaleBackendState =
  | 'missing'
  | 'daemon-unavailable'
  | 'logged-out'
  | 'stopped'
  | 'running'
  | 'malformed';

export type TailscaleServeRouteState =
  | 'unavailable'
  | 'missing'
  | 'desired'
  | 'conflict'
  | 'funnel-conflict'
  | 'malformed';

export interface TailscaleServeInspection {
  schemaVersion: 1;
  topology: TailscaleTopology;
  backend: TailscaleBackendState;
  executablePath?: string;
  dnsName?: string;
  advertisedUrl?: string;
  httpsCapability: 'ready' | 'unavailable' | 'unknown';
  route: TailscaleServeRouteState;
  routeTarget?: string;
  desiredTarget: string;
  detailCode: string;
  summary: string;
}

interface JsonRecord {
  [key: string]: unknown;
}

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function field(value: JsonRecord | undefined, ...names: string[]): unknown {
  if (!value) return undefined;
  for (const name of names) {
    if (name in value) return value[name];
    const matched = Object.keys(value).find((key) => key.toLowerCase() === name.toLowerCase());
    if (matched) return value[matched];
  }
  return undefined;
}

function cleanDnsName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\.+$/, '').toLowerCase();
  if (!normalized || normalized.length > 253 || !normalized.includes('.')
      || !/^[a-z0-9.-]+$/.test(normalized)) return undefined;
  return normalized;
}

function canonicalLoopbackTarget(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = host === 'localhost' || host === '::1' || host.startsWith('127.');
    if (!loopback || parsed.protocol !== 'http:' || parsed.username || parsed.password
        || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function wslContext(context: SetupDiagnosisContext): boolean {
  return context.platform === 'linux'
    && (!!context.env.WSL_DISTRO_NAME || !!context.env.WSL_INTEROP || /microsoft/i.test(context.env.WSLENV ?? ''));
}

function parseBackend(value: unknown): TailscaleBackendState {
  const root = record(value);
  const state = String(field(root, 'BackendState') ?? '').trim().toLowerCase();
  if (state === 'running') return 'running';
  if (state === 'needslogin' || state === 'needsmachineauth') return 'logged-out';
  if (state === 'stopped' || state === 'starting' || state === 'nostate') return 'stopped';
  return state ? 'stopped' : 'malformed';
}

function dnsNameFromStatus(value: unknown): string | undefined {
  const root = record(value);
  const self = record(field(root, 'Self'));
  return cleanDnsName(field(self, 'DNSName'))
    ?? cleanDnsName(field(root, 'DNSName'))
    ?? cleanDnsName(field(record(field(root, 'CurrentTailnet')), 'MagicDNSSuffix'));
}

function matchingHostEntry(web: JsonRecord | undefined, dnsName: string): JsonRecord | undefined {
  if (!web) return undefined;
  const expected = `${dnsName}:443`;
  const key = Object.keys(web).find((candidate) => candidate.replace(/\.+(?=:)/, '').toLowerCase() === expected);
  return key ? record(web[key]) : undefined;
}

function funnelEnabled(root: JsonRecord, dnsName: string): boolean {
  const allow = record(field(root, 'AllowFunnel'));
  if (!allow) return false;
  const expected = `${dnsName}:443`;
  return Object.entries(allow).some(([key, value]) =>
    key.replace(/\.+(?=:)/, '').toLowerCase() === expected && value === true);
}

/** Parse the node-level `tailscale serve status --json` shape without depending on key order. */
export function inspectServeStatusJson(
  value: unknown,
  options: { dnsName: string; desiredTarget: string },
): Pick<TailscaleServeInspection, 'route' | 'routeTarget'> {
  const root = record(value);
  if (!root) return { route: 'malformed' };
  const web = record(field(root, 'Web'));
  const host = matchingHostEntry(web, options.dnsName);
  const handlers = record(field(host, 'Handlers'));
  const rootHandler = record(field(handlers, '/'));
  const proxy = field(rootHandler, 'Proxy');
  const routeTarget = canonicalLoopbackTarget(proxy);
  if (funnelEnabled(root, options.dnsName)) {
    return { route: 'funnel-conflict', ...(routeTarget ? { routeTarget } : {}) };
  }
  if (!rootHandler) return { route: 'missing' };
  const tcp = record(field(root, 'TCP'));
  const httpsListener = record(field(tcp, '443'));
  if (field(httpsListener, 'HTTPS') !== true) {
    return { route: 'conflict', ...(routeTarget ? { routeTarget } : {}) };
  }
  if (!routeTarget) return { route: 'conflict' };
  return routeTarget === canonicalLoopbackTarget(options.desiredTarget)
    ? { route: 'desired', routeTarget }
    : { route: 'conflict', routeTarget };
}

function unavailable(options: {
  topology: TailscaleTopology;
  backend: TailscaleBackendState;
  desiredTarget: string;
  executablePath?: string;
  detailCode: string;
  summary: string;
}): TailscaleServeInspection {
  return {
    schemaVersion: 1,
    topology: options.topology,
    backend: options.backend,
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    httpsCapability: 'unavailable',
    route: 'unavailable',
    desiredTarget: options.desiredTarget,
    detailCode: options.detailCode,
    summary: options.summary,
  };
}

/** Read-only Tailscale topology and Serve inspection used by setup, doctor, and repair. */
export async function inspectTailscaleServe(options: {
  context: SetupDiagnosisContext;
  internalUrl: string;
}): Promise<TailscaleServeInspection> {
  const desiredTarget = canonicalLoopbackTarget(options.internalUrl);
  if (!desiredTarget) throw new Error('Tailscale Serve target must be loopback HTTP');
  const wsl = wslContext(options.context);
  const executablePath = resolveTailscaleExecutable(options.context, wsl);
  if (!executablePath) {
    return unavailable({
      topology: 'missing',
      backend: 'missing',
      desiredTarget,
      detailCode: wsl ? 'wsl-tailscale-missing' : 'tailscale-missing',
      summary: 'Tailscale is not installed in the broker host environment.',
    });
  }
  if (wsl && (/\.exe$/i.test(executablePath) || /^\/mnt\/[a-z]\//i.test(executablePath))) {
    return unavailable({
      topology: 'windows-host-only',
      backend: 'daemon-unavailable',
      executablePath,
      desiredTarget,
      detailCode: 'wsl-windows-host-tailscale-only',
      summary: 'Windows-host Tailscale cannot Serve a broker bound to WSL loopback.',
    });
  }
  const topology: TailscaleTopology = wsl
    ? 'inside-wsl'
    : options.context.platform === 'darwin' ? 'native-macos' : 'native-linux';
  const status = await options.context.runReadOnly(executablePath, ['status', '--json']);
  if (status.status !== 'ok') {
    return unavailable({
      topology,
      backend: 'daemon-unavailable',
      executablePath,
      desiredTarget,
      detailCode: wsl ? 'wsl-tailscale-daemon-stopped' : 'tailscale-daemon-unavailable',
      summary: 'The Tailscale CLI is installed, but its local daemon is not reachable.',
    });
  }
  let statusJson: unknown;
  try { statusJson = JSON.parse(status.stdout); } catch {
    return unavailable({
      topology,
      backend: 'malformed',
      executablePath,
      desiredTarget,
      detailCode: 'tailscale-status-malformed',
      summary: 'Tailscale returned malformed status JSON.',
    });
  }
  const backend = parseBackend(statusJson);
  if (backend !== 'running') {
    return unavailable({
      topology,
      backend,
      executablePath,
      desiredTarget,
      detailCode: backend === 'logged-out' ? 'tailscale-login-required' : 'tailscale-not-running',
      summary: backend === 'logged-out'
        ? 'Tailscale requires an explicit login before private Serve can be configured.'
        : 'Tailscale is not in the running state.',
    });
  }
  const dnsName = dnsNameFromStatus(statusJson);
  if (!dnsName) {
    return {
      schemaVersion: 1,
      topology,
      backend,
      executablePath,
      httpsCapability: 'unavailable',
      route: 'unavailable',
      desiredTarget,
      detailCode: 'tailscale-magicdns-unavailable',
      summary: 'Tailscale is running, but no MagicDNS HTTPS hostname is available.',
    };
  }
  const advertisedUrl = `https://${dnsName}`;
  const serve = await options.context.runReadOnly(executablePath, ['serve', 'status', '--json']);
  if (serve.status !== 'ok') {
    const noConfiguration = /no (serve )?config|not configured|no servers/i.test(`${serve.stdout}\n${serve.stderr}`);
    return {
      schemaVersion: 1,
      topology,
      backend,
      executablePath,
      dnsName,
      advertisedUrl,
      httpsCapability: 'ready',
      route: noConfiguration ? 'missing' : 'unavailable',
      desiredTarget,
      detailCode: noConfiguration ? 'tailscale-serve-not-configured' : 'tailscale-serve-status-unavailable',
      summary: noConfiguration
        ? 'Tailscale Serve is ready but has no root HTTPS route for cosyncing.'
        : 'Tailscale Serve configuration could not be inspected safely.',
    };
  }
  let serveJson: unknown;
  try { serveJson = JSON.parse(serve.stdout); } catch {
    return {
      schemaVersion: 1,
      topology,
      backend,
      executablePath,
      dnsName,
      advertisedUrl,
      httpsCapability: 'unknown',
      route: 'malformed',
      desiredTarget,
      detailCode: 'tailscale-serve-status-malformed',
      summary: 'Tailscale Serve returned malformed configuration JSON.',
    };
  }
  const route = inspectServeStatusJson(serveJson, { dnsName, desiredTarget });
  return {
    schemaVersion: 1,
    topology,
    backend,
    executablePath,
    dnsName,
    advertisedUrl,
    httpsCapability: 'ready',
    ...route,
    desiredTarget,
    detailCode: route.route === 'desired'
      ? 'tailscale-serve-route-ready'
      : route.route === 'missing' ? 'tailscale-serve-route-missing'
        : route.route === 'funnel-conflict' ? 'tailscale-funnel-route-conflict'
          : route.route === 'conflict' ? 'tailscale-serve-route-conflict'
            : 'tailscale-serve-status-malformed',
    summary: route.route === 'desired'
      ? 'The private HTTPS root route already targets this broker.'
      : route.route === 'missing' ? 'No private HTTPS root route targets this broker yet.'
        : route.route === 'funnel-conflict' ? 'The HTTPS root is currently public through Funnel and will not be changed.'
          : 'An existing HTTPS root route conflicts with the broker target and will be preserved.',
  };
}

export function tailscaleRouteReceiptTarget(inspection: Pick<
  TailscaleServeInspection,
  'advertisedUrl' | 'desiredTarget'
>): string {
  if (!inspection.advertisedUrl) throw new Error('Tailscale advertised URL is unavailable');
  return `${inspection.advertisedUrl}/ -> ${inspection.desiredTarget}`;
}

export class TailscaleServeCommandError extends Error {
  constructor(readonly code: string) {
    super(`Tailscale Serve command failed (${code})`);
    this.name = 'TailscaleServeCommandError';
  }
}

function requireCommand(result: ServiceCommandResult): void {
  if (result.status === 'ok') return;
  const output = `${result.stdout}\n${result.stderr}`;
  const code = /acl|access denied|permission denied|not allowed|forbidden/i.test(output)
    ? 'tailscale-serve-acl-denied'
    : /https|certificate|cert domain|enable.*https|admin console/i.test(output)
      ? 'tailscale-serve-https-not-enabled'
      : result.status === 'timeout' ? 'tailscale-serve-timeout'
        : 'tailscale-serve-command-failed';
  throw new TailscaleServeCommandError(code);
}

export interface TailscaleServeProviderOptions {
  context: SetupDiagnosisContext;
  internalUrl: string;
  executablePath?: string;
  runner?: ServiceCommandRunner;
}

export interface TailscaleServeRouteProvider {
  inspect(): Promise<TailscaleServeInspection>;
  registerPrivateHttpsRoot(): Promise<void>;
  removePrivateHttpsRoot(): Promise<void>;
}

/** Mutating provider. It can add/remove only the node HTTPS root route and has no Funnel command. */
export class TailscaleServeProvider {
  readonly executablePath: string;
  readonly internalUrl: string;
  private readonly runner: ServiceCommandRunner;

  constructor(readonly options: TailscaleServeProviderOptions) {
    this.executablePath = options.executablePath
      ?? resolveTailscaleExecutable(options.context, wslContext(options.context))
      ?? (() => { throw new TailscaleServeCommandError('tailscale-missing'); })();
    this.internalUrl = canonicalLoopbackTarget(options.internalUrl)
      ?? (() => { throw new TailscaleServeCommandError('tailscale-target-invalid'); })();
    this.runner = options.runner ?? createServiceCommandRunner(options.context.env);
  }

  inspect(): Promise<TailscaleServeInspection> {
    return inspectTailscaleServe({ context: this.options.context, internalUrl: this.internalUrl });
  }

  async registerPrivateHttpsRoot(): Promise<void> {
    requireCommand(await this.runner.run(this.executablePath, [
      'serve', '--bg', '--yes', '--https=443', '--set-path=/', this.internalUrl,
    ]));
  }

  async removePrivateHttpsRoot(): Promise<void> {
    requireCommand(await this.runner.run(this.executablePath, [
      'serve', '--yes', '--https=443', '--set-path=/', this.internalUrl, 'off',
    ]));
  }
}

interface TailscaleRouteRollbackData extends Record<string, unknown> {
  before: 'missing' | 'desired';
  receiptTarget: string;
}

function routeRollback(recordValue: Readonly<SetupRollbackRecord>): TailscaleRouteRollbackData {
  if (recordValue.kind !== 'tailscale-serve-route-v1'
      || (recordValue.data.before !== 'missing' && recordValue.data.before !== 'desired')
      || typeof recordValue.data.receiptTarget !== 'string') {
    throw new Error('invalid Tailscale Serve rollback record');
  }
  return recordValue.data as TailscaleRouteRollbackData;
}

export function createTailscaleServeSetupAction(
  provider: TailscaleServeRouteProvider,
  options: { desired: 'installed' | 'absent' },
): SetupTransactionAction {
  return {
    id: 'network.tailscale-serve',
    async prepare() {
      const before = await provider.inspect();
      if (before.route !== 'missing' && before.route !== 'desired') {
        throw new TailscaleServeCommandError(`tailscale-route-precondition-${before.route}`);
      }
      return {
        kind: 'tailscale-serve-route-v1',
        data: {
          before: before.route,
          receiptTarget: tailscaleRouteReceiptTarget(before),
        } satisfies TailscaleRouteRollbackData,
      };
    },
    async apply() {
      const current = await provider.inspect();
      if (current.route !== 'missing' && current.route !== 'desired') {
        throw new TailscaleServeCommandError(`tailscale-route-changed-${current.route}`);
      }
      if (options.desired === 'installed') {
        if (current.route === 'missing') await provider.registerPrivateHttpsRoot();
        const verified = await provider.inspect();
        if (verified.route !== 'desired') throw new TailscaleServeCommandError('tailscale-route-verify-failed');
        return {
          resources: [{
            id: TAILSCALE_SERVE_RESOURCE_ID,
            kind: 'other',
            target: tailscaleRouteReceiptTarget(verified),
            ownership: { proof: 'receipt', marker: TAILSCALE_SERVE_OWNERSHIP_MARKER },
          } satisfies InstalledResourceRecord],
        };
      }
      if (current.route === 'desired') await provider.removePrivateHttpsRoot();
      return { resources: [] };
    },
    async verify() {
      const current = await provider.inspect();
      return options.desired === 'installed' ? current.route === 'desired' : current.route === 'missing';
    },
    async rollback(_context, rollbackRecord) {
      const prior = routeRollback(rollbackRecord);
      const current = await provider.inspect();
      if (current.route !== 'missing' && current.route !== 'desired') {
        throw new TailscaleServeCommandError(`tailscale-route-rollback-conflict-${current.route}`);
      }
      if (prior.before === 'missing' && current.route === 'desired') await provider.removePrivateHttpsRoot();
      if (prior.before === 'desired' && current.route === 'missing') await provider.registerPrivateHttpsRoot();
      const restored = await provider.inspect();
      if (restored.route !== prior.before || tailscaleRouteReceiptTarget(restored) !== prior.receiptTarget) {
        throw new TailscaleServeCommandError('tailscale-route-rollback-verify-failed');
      }
    },
  };
}

export const ADVERTISED_ENDPOINT_VERIFY_TIMEOUT_MS = 30_000;
export const ADVERTISED_ENDPOINT_VERIFY_INTERVAL_MS = 500;
const ADVERTISED_ENDPOINT_REQUEST_TIMEOUT_MS = 3_000;

/**
 * Timer seam for the advertised-endpoint readiness loop. Setup uses the wall clock; acceptance fixtures use
 * a clock that advances immediately so propagation success and deadline expiry stay deterministic. Keeping
 * the handle here also makes cleanup explicit: a successful probe never leaves a deadline/sleep timer armed.
 */
export interface AdvertisedEndpointPollingClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const advertisedEndpointWallClock: AdvertisedEndpointPollingClock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

async function waitForAdvertisedEndpointPoll(
  clock: AdvertisedEndpointPollingClock,
  delayMs: number,
): Promise<void> {
  let armed = false;
  let timer: unknown;
  try {
    await new Promise<void>((resolve) => {
      timer = clock.schedule(resolve, delayMs);
      armed = true;
    });
  } finally {
    if (armed) clock.cancel(timer);
  }
}

export interface AdvertisedBrokerEndpointVerificationOptions {
  context: SetupDiagnosisContext;
  advertisedUrl: string;
  machineLabel: string;
  timeoutMs?: number;
  intervalMs?: number;
  requestTimeoutMs?: number;
  clock?: AdvertisedEndpointPollingClock;
}

export async function verifyAdvertisedBrokerEndpoint(
  options: AdvertisedBrokerEndpointVerificationOptions,
): Promise<boolean> {
  const clock = options.clock ?? advertisedEndpointWallClock;
  const timeoutMs = Math.max(1, options.timeoutMs ?? ADVERTISED_ENDPOINT_VERIFY_TIMEOUT_MS);
  const intervalMs = Math.max(1, options.intervalMs ?? ADVERTISED_ENDPOINT_VERIFY_INTERVAL_MS);
  const requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? ADVERTISED_ENDPOINT_REQUEST_TIMEOUT_MS);
  const deadline = clock.now() + timeoutMs;
  const healthUrl = new URL('/api/health', options.advertisedUrl).toString();

  while (clock.now() < deadline) {
    const remainingBeforeProbe = deadline - clock.now();
    const health = await options.context.fetchJson(
      healthUrl,
      {},
      Math.min(requestTimeoutMs, remainingBeforeProbe),
    );
    const body = record(health.json);
    if (clock.now() < deadline
        && health.status === 'ok'
        && body?.ok === true
        && body.product === PRODUCT_IDENTITY.productName
        && body.machine === options.machineLabel) {
      return true;
    }

    const remaining = deadline - clock.now();
    if (remaining <= 0) return false;
    await waitForAdvertisedEndpointPoll(clock, Math.min(intervalMs, remaining));
  }
  return false;
}
