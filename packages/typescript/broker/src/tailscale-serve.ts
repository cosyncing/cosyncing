import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { SetupDiagnosisContext, SetupHttpProbe } from '@cosyncing/adapter-api';
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

/**
 * This machine's own Tailscale addresses, in the order the daemon reports them (IPv4 first in practice).
 *
 * These are read from `Self` ONLY. A peer's address is never a substitute for this node: the advertised
 * endpoint must be proved to be THIS broker, and the identity check downstream would reject a peer anyway —
 * but connecting to one at all is a probe of somebody else's machine, so it never happens here.
 */
export function tailscaleAddressesFromStatusJson(value: unknown): string[] {
  const self = record(field(record(value), 'Self'));
  const raw = field(self, 'TailscaleIPs');
  if (!Array.isArray(raw)) return [];
  const addresses: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    // isIP rejects anything that is not a bare literal — no ports, no zone ids, no hostnames. A value that
    // is not already an address literal must never reach the connect path, because the whole point of the
    // fallback is to bypass name resolution.
    if (isIP(trimmed) === 0 || addresses.includes(trimmed)) continue;
    addresses.push(trimmed);
  }
  return addresses;
}

/** Read this node's validated Tailscale addresses for the DNS-failure fallback. Never throws: no address
 *  simply means the fallback is unavailable and hostname verification stands alone. */
export async function resolveTailscaleAddresses(options: {
  context: SetupDiagnosisContext;
  executablePath: string;
}): Promise<string[]> {
  const status = await options.context.runReadOnly(options.executablePath, ['status', '--json']);
  if (status.status !== 'ok') return [];
  try {
    return tailscaleAddressesFromStatusJson(JSON.parse(status.stdout));
  } catch {
    return [];
  }
}

/**
 * This node's fallback addresses for any surface that must reach the advertised endpoint, resolved from
 * the host's own Tailscale CLI.
 *
 * Returns nothing when Tailscale is absent, and deliberately nothing for the Windows-host-only WSL
 * topology: there `Self` describes the WINDOWS machine, so its addresses belong to a different host than
 * the broker. The identity check would reject such an answer anyway, but connecting at all would be
 * probing somebody else's machine, which this must never do.
 */
export async function resolveTailscaleFallbackAddresses(
  context: SetupDiagnosisContext,
): Promise<string[]> {
  const wsl = wslContext(context);
  const executablePath = resolveTailscaleExecutable(context, wsl);
  if (!executablePath) return [];
  if (wsl && (/\.exe$/i.test(executablePath) || /^\/mnt\/[a-z]\//i.test(executablePath))) return [];
  return resolveTailscaleAddresses({ context, executablePath });
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

/** Response body ceiling for the direct-address probe, matching the shared diagnosis fetch. */
const ADVERTISED_ENDPOINT_BODY_LIMIT = 256 * 1024;

/**
 * Total wall-clock ceiling for ONE advertised-endpoint probe — the named request plus every address
 * attempt together. Single-shot callers (`status`, `doctor`, `pair`) supply no deadline of their own, so
 * without this a malformed or unexpectedly long `TailscaleIPs` list would multiply the per-request timeout
 * by the address count and stall an interactive command.
 */
export const ADVERTISED_ENDPOINT_TOTAL_TIMEOUT_MS = 9_000;

/**
 * At most one IPv4 and one IPv6 candidate.
 *
 * A healthy node reports exactly that pair. Anything beyond it is either a topology this fallback has no
 * business guessing at or a malformed status payload, and in both cases walking the whole list only buys
 * latency: the addresses all belong to the same machine, so if the first of a family cannot be reached the
 * rest almost certainly cannot either.
 */
export function limitFallbackAddresses(addresses: readonly string[]): string[] {
  const chosen: string[] = [];
  for (const family of [4, 6]) {
    const match = addresses.find((address) => isIP(address) === family);
    if (match) chosen.push(match);
  }
  return chosen;
}

/** The advertised endpoint answered, and answered as THIS broker. */
export function advertisedProbeIsBroker(probe: SetupHttpProbe, machineLabel: string): boolean {
  const body = record(probe.json);
  return probe.status === 'ok'
    && body?.ok === true
    && body.product === PRODUCT_IDENTITY.productName
    && body.machine === machineLabel;
}

export interface AdvertisedEndpointDirectProbeOptions {
  /** Tailscale address literal to CONNECT to — never resolved, never a hostname. */
  address: string;
  port: number;
  /** Advertised MagicDNS hostname: the TLS SNI value, the certificate validation target, and the HTTP Host. */
  hostname: string;
  path: string;
  headers?: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export type AdvertisedEndpointDirectProbe =
  (options: AdvertisedEndpointDirectProbeOptions) => Promise<SetupHttpProbe>;

/**
 * HTTPS probe aimed at an address literal while every identity input stays the advertised hostname.
 *
 * `servername` drives SNI *and* is what Node validates the presented certificate against, so a Serve
 * certificate issued for the MagicDNS name still verifies while the connection skips resolution entirely.
 * `rejectUnauthorized` is never lowered here and has no option to be: this path exists for a name-resolution
 * failure, not for a broken or mismatched certificate, and a bad chain must fail exactly as it would have.
 */
const defaultAdvertisedEndpointDirectProbe: AdvertisedEndpointDirectProbe = (options) =>
  new Promise<SetupHttpProbe>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: ReturnType<typeof httpsRequest> | undefined;
    const finish = (probe: SetupHttpProbe): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Destroying the request tears the socket down on every exit path, including the ones where a
      // response was already parsed, so a verified endpoint leaves no connection behind either.
      try { request?.destroy(); } catch { /* already closed */ }
      resolve(probe);
    };
    try {
      request = httpsRequest({
        host: options.address,
        port: options.port,
        path: options.path,
        method: 'GET',
        servername: options.hostname,
        rejectUnauthorized: true,
        // Host is set LAST so a caller-supplied header set can never redirect the request's identity
        // away from the advertised hostname the certificate was just validated against.
        headers: { ...options.headers, Host: options.hostname },
        family: isIP(options.address) === 6 ? 6 : 4,
      }, (response) => {
        const statusCode = response.statusCode ?? 0;
        let body = '';
        let bytes = 0;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          bytes += Buffer.byteLength(chunk, 'utf8');
          if (bytes > ADVERTISED_ENDPOINT_BODY_LIMIT) {
            finish({ status: 'invalid-response', statusCode });
            return;
          }
          body += chunk;
        });
        response.on('error', () => finish({ status: 'unreachable' }));
        response.on('end', () => {
          let json: unknown;
          try { json = body ? JSON.parse(body) : undefined; } catch {
            finish({ status: 'invalid-response', statusCode });
            return;
          }
          // A redirect is not followed: the shared fetch treats one as an error, and this path holds the
          // same line so a Serve route pointing somewhere else can never be read as this broker.
          finish({
            status: statusCode >= 200 && statusCode < 300 ? 'ok' : 'http-error',
            statusCode,
            ...(json !== undefined ? { json } : {}),
          });
        });
      });
      request.on('error', () => finish({ status: 'unreachable' }));
      timer = setTimeout(() => finish({ status: 'unreachable' }), Math.max(100, options.timeoutMs));
      timer.unref?.();
      request.end();
    } catch {
      finish({ status: 'unreachable' });
    }
  });

export interface AdvertisedEndpointProbeOptions {
  context: SetupDiagnosisContext;
  /** Base URL whose HOSTNAME is the identity throughout — the address literals only carry the packets. */
  advertisedUrl: string;
  path?: string;
  headers?: Readonly<Record<string, string>>;
  fallbackAddresses?: readonly string[];
  directProbe?: AdvertisedEndpointDirectProbe;
  requestTimeoutMs?: number;
  /** Ceiling for the named request plus every address attempt. Defaults to
   *  {@link ADVERTISED_ENDPOINT_TOTAL_TIMEOUT_MS}; ignored when `deadline` is supplied. */
  totalTimeoutMs?: number;
  /** Optional hard stop shared with a polling caller, so walking several addresses cannot overrun it. */
  deadline?: { now: () => number; at: number };
}

/**
 * One advertised-endpoint probe, by name first and by this node's own addresses only if the name could not
 * be reached. This is the single DNS-independent primitive: setup polls it to a deadline, while status,
 * doctor, and pairing each take one shot, so a host with broken MagicDNS resolution reports the same truth
 * everywhere instead of only surviving setup.
 *
 * The name's answer always wins when there is one. Any completed HTTP exchange — a status code, an
 * unparsable body, or a valid body with the wrong identity — is returned as-is and no address is tried,
 * because that is the endpoint answering, and re-asking an address literal would only be shopping for a
 * better reply. Address probes stop at the first one that answers for the same reason.
 */
export async function probeAdvertisedEndpointOnce(
  options: AdvertisedEndpointProbeOptions,
): Promise<SetupHttpProbe> {
  const target = new URL(options.path ?? '/api/health', options.advertisedUrl);
  const headers = options.headers ?? {};
  const ceiling = Math.max(1, options.requestTimeoutMs ?? ADVERTISED_ENDPOINT_REQUEST_TIMEOUT_MS);
  // A total deadline ALWAYS applies. A polling caller shares its own so the poll's bound governs
  // everything; a single-shot caller gets one synthesised here, because otherwise each address would
  // cost a full request timeout and an interactive command could hang for the length of the list.
  const deadline = options.deadline ?? (() => {
    const at = Date.now() + Math.max(1, options.totalTimeoutMs ?? ADVERTISED_ENDPOINT_TOTAL_TIMEOUT_MS);
    return { now: () => Date.now(), at };
  })();
  // Each probe is clamped to whatever is left of that deadline, so a list of addresses costs at most the
  // remaining budget rather than one full request timeout apiece.
  const budget = (): number => Math.min(ceiling, deadline.at - deadline.now());
  const named = await options.context.fetchJson(target.toString(), headers, Math.max(1, budget()));
  if (named.status !== 'unreachable' || target.protocol !== 'https:') return named;
  const directProbe = options.directProbe ?? defaultAdvertisedEndpointDirectProbe;
  for (const address of limitFallbackAddresses(options.fallbackAddresses ?? [])) {
    const remaining = budget();
    if (remaining <= 0) break;
    const direct = await directProbe({
      address,
      port: target.port ? Number(target.port) : 443,
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      headers,
      timeoutMs: remaining,
    });
    if (direct.status !== 'unreachable') return direct;
  }
  return named;
}

export interface AdvertisedBrokerEndpointVerificationOptions {
  context: SetupDiagnosisContext;
  advertisedUrl: string;
  machineLabel: string;
  timeoutMs?: number;
  intervalMs?: number;
  requestTimeoutMs?: number;
  clock?: AdvertisedEndpointPollingClock;
  /** This node's Tailscale addresses, used only when the advertised NAME cannot be reached. */
  fallbackAddresses?: readonly string[];
  directProbe?: AdvertisedEndpointDirectProbe;
}

export async function verifyAdvertisedBrokerEndpoint(
  options: AdvertisedBrokerEndpointVerificationOptions,
): Promise<boolean> {
  const clock = options.clock ?? advertisedEndpointWallClock;
  const timeoutMs = Math.max(1, options.timeoutMs ?? ADVERTISED_ENDPOINT_VERIFY_TIMEOUT_MS);
  const intervalMs = Math.max(1, options.intervalMs ?? ADVERTISED_ENDPOINT_VERIFY_INTERVAL_MS);
  const requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? ADVERTISED_ENDPOINT_REQUEST_TIMEOUT_MS);
  const deadline = clock.now() + timeoutMs;
  /**
   * Set the moment ANY probe completes an HTTP exchange — a status code, an unparsable body, or a valid
   * answer carrying the wrong product/machine. All of those prove the endpoint was reached and answered
   * wrongly, which is a real verification failure and never a resolution problem. Retrying it against an
   * address literal would be asking a second question to get a nicer answer, so the fallback is retired
   * for the rest of this verification — the one piece of state a single probe cannot carry.
   */
  let answeredWrongly = false;

  const isThisBroker = (probe: SetupHttpProbe): boolean =>
    advertisedProbeIsBroker(probe, options.machineLabel);

  while (clock.now() < deadline) {
    const remainingBeforeProbe = deadline - clock.now();
    const probe = await probeAdvertisedEndpointOnce({
      context: options.context,
      advertisedUrl: options.advertisedUrl,
      requestTimeoutMs: Math.min(requestTimeoutMs, remainingBeforeProbe),
      deadline: { now: () => clock.now(), at: deadline },
      ...(options.directProbe ? { directProbe: options.directProbe } : {}),
      fallbackAddresses: answeredWrongly ? [] : (options.fallbackAddresses ?? []),
    });
    if (clock.now() < deadline && isThisBroker(probe)) return true;
    if (probe.status !== 'unreachable') answeredWrongly = true;

    const remaining = deadline - clock.now();
    if (remaining <= 0) return false;
    await waitForAdvertisedEndpointPoll(clock, Math.min(intervalMs, remaining));
  }
  return false;
}
