#!/usr/bin/env bun
/** Tailscale topology/ownership plus terminal pair/list/revoke acceptance. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SetupDiagnosisContext, SetupHttpProbe } from '../../../adapter-api/src/index.ts';
import {
  createQrPairingPayload,
  parseQrPairingPayload,
  type QrPairingPayloadV3,
} from '../../../crypto/src/index.ts';
import { BROKER_CONTRACT } from '../../../protocol/src/index.ts';
import { runCli } from '../../src/cli/cli.ts';
import { BUILD_INFO } from '../../src/runtime/build-info.ts';
import { defaultBrokerConfig, writeBrokerConfig } from '../../src/runtime/configuration.ts';
import {
  brokerTokenPath,
  ensureInstallationCredentials,
  readBrokerToken,
} from '../../src/security/credentials.ts';
import { committedInstallState, writeInstallState } from '../../src/installation/install-state.ts';
import {
  runDevicesListCommand,
  runDevicesRevokeCommand,
  runPairCommand,
  renderTerminalPairingQr,
  type OperatorFetch,
} from '../../src/cli/operator-commands.ts';
import {
  renderTerminalQr,
  terminalQrColorEnabled,
  terminalQrWidth,
} from '../../src/cli/terminal-qr.ts';
import { TransportPairingRegistry } from '../../src/transport/transport-pairing.ts';
import {
  normalizePairingBrokerUrl,
  pairingBrokerUrlUsesUnprotectedHttp,
} from '../../src/transport/pairing-url.ts';
import { writeSetupState } from '../../src/installation/setup-state.ts';
import { buildSetupPlan, type SetupInspection } from '../../src/installation/setup.ts';
import type { ServiceCommandRunner } from '../../src/installation/service-manager.ts';
import {
  ADVERTISED_ENDPOINT_VERIFY_INTERVAL_MS,
  createTailscaleServeSetupAction,
  inspectServeStatusJson,
  inspectTailscaleServe,
  MACOS_TAILSCALE_BUNDLE_CLI,
  TAILSCALE_SERVE_RESOURCE_ID,
  limitFallbackAddresses,
  probeAdvertisedEndpointOnce,
  TailscaleServeProvider,
  tailscaleAddressesFromStatusJson,
  verifyAdvertisedBrokerEndpoint,
  type AdvertisedEndpointDirectProbeOptions,
  type AdvertisedEndpointPollingClock,
} from '../../src/installation/tailscale-serve.ts';
import type { SetupTransactionContext } from '../../src/installation/setup-transaction.ts';

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Advance polling delays without wall time while retaining observable timer ownership and cleanup. */
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

// Planner integration: confirmed private Serve adds the advertised URL and exact owned action; a matching
// foreign route is reused without claiming it.
{
  const config = defaultBrokerConfig();
  const tailscale = {
    schemaVersion: 1 as const,
    topology: 'native-linux' as const,
    backend: 'running' as const,
    executablePath: '/usr/bin/tailscale',
    dnsName: 'devbox.tailnet.ts.net',
    advertisedUrl: 'https://devbox.tailnet.ts.net',
    httpsCapability: 'ready' as const,
    route: 'missing' as const,
    desiredTarget: config.broker.internalUrl,
    detailCode: 'tailscale-serve-route-missing',
    summary: 'missing fixture',
  };
  const inspection = {
    schemaVersion: 1,
    product: 'cosyncing',
    version: BUILD_INFO.version,
    installLocation: '/fixture/cosyncing',
    stateHome: '/fixture/.cosyncing',
    installState: { committed: false, path: '/fixture/.cosyncing/install-state.json', reason: 'missing' },
    // Source-build fixture: no packaged executable to bootstrap-copy, so the planner adds no binary step.
    installedBinary: {
      path: '/fixture/.cosyncing/bin/cosyncing',
      status: 'not-applicable',
      selfInstalled: false,
    },
    config: { status: 'missing', path: '/fixture/.cosyncing/config.json', problem: 'missing' },
    targetConfig: config,
    brokerCredential: { status: 'missing', path: '/fixture/broker-token', detailCode: 'broker-token-missing' },
    piCredential: { status: 'missing', path: '/fixture/pi-integration.json', detailCode: 'pi-integration-missing' },
    piCredentialUrlMatches: false,
    setupState: { schemaVersion: 1 },
    piAgentDir: '/fixture/.pi/agent',
    piBridge: {
      status: 'missing',
      path: '/fixture/.pi/agent/extensions/cosyncing.ts',
      expectedSha256: '0'.repeat(64),
      requiresConfirmation: false,
    },
    durableStatePermissionRepairs: [],
    agentSkills: [],
    opencodeShim: { shimPath: '/fixture/.cosyncing/shell/opencode-shim.sh', shimStatus: 'missing', rc: [] },
    portStatus: 'free',
    pipxAvailable: false,
    tokdashAvailable: false,
    durableServiceProvider: 'systemd',
    systemdAvailable: true,
    systemdStatus: {
      provider: 'systemd', supported: true, definition: 'missing', environment: 'missing',
      enabled: 'disabled', active: 'inactive', lingering: 'disabled',
    },
    systemdDefinitionPath: '/fixture/.config/systemd/user/cosyncing.service',
    systemdEnvironmentPath: '/fixture/.cosyncing/service/broker.env',
    systemdPersistenceTarget: 'systemd-user-linger:fixture',
    tailscaleAvailable: true,
    tailscale,
    webAppAvailable: false,
    agents: [],
    doctor: { schemaVersion: 1, product: 'cosyncing', version: BUILD_INFO.version, effects: 'forbidden', ok: true, summary: { pass: 0, warn: 0, fail: 0, skip: 0 }, minimumVersions: [], sections: [] },
    blockingIssues: [],
    preconditionHash: '0'.repeat(64),
  } as SetupInspection;
  const ownedPlan = buildSetupPlan({
    inspection,
    choices: { language: 'en', service: 'systemd', enableLingering: false, tailscaleServe: true, quotaWarnings: false, installAgentSkill: false, installOpencodeShim: false },
  });
  const foreignPlan = buildSetupPlan({
    inspection: { ...inspection, tailscale: { ...tailscale, route: 'desired' } },
    choices: { language: 'en', service: 'systemd', enableLingering: false, tailscaleServe: true, quotaWarnings: false, installAgentSkill: false, installOpencodeShim: false },
  });
  check('setup planner writes the private advertised URL and owns only a route it creates',
    ownedPlan.blockingIssues.length === 0
      && ownedPlan.targetConfig.broker.advertisedUrl === 'https://devbox.tailnet.ts.net'
      && ownedPlan.actions.some((action) => action.id === 'network.tailscale-serve')
      && !foreignPlan.actions.some((action) => action.id === 'network.tailscale-serve')
      && foreignPlan.mutationSummary.some((summary) => summary.includes('without claiming ownership')));

  const identityContext = fakeContext({});
  const delayedClock = new ImmediatePollingClock();
  let delayedProbes = 0;
  identityContext.fetchJson = async () => {
    delayedProbes += 1;
    return delayedProbes < 3
      ? { status: 'unreachable' as const }
      : {
          status: 'ok' as const,
          statusCode: 200,
          json: { ok: true, product: 'cosyncing', machine: 'devbox' },
        };
  };
  const delayedSuccess = await verifyAdvertisedBrokerEndpoint({
    context: identityContext,
    advertisedUrl: 'https://devbox.tailnet.ts.net',
    machineLabel: 'devbox',
    timeoutMs: ADVERTISED_ENDPOINT_VERIFY_INTERVAL_MS * 5,
    clock: delayedClock,
  });
  check('advertised endpoint polling returns as soon as the expected broker appears',
    delayedSuccess && delayedProbes === 3
      && delayedClock.timeMs === ADVERTISED_ENDPOINT_VERIFY_INTERVAL_MS * 2,
    `success=${delayedSuccess} probes=${delayedProbes} elapsed=${delayedClock.timeMs}`);
  check('successful advertised polling clears every scheduled timer',
    delayedClock.schedules === 2 && delayedClock.cancellations === 2 && delayedClock.pending.size === 0,
    `scheduled=${delayedClock.schedules} cancelled=${delayedClock.cancellations} pending=${delayedClock.pending.size}`);

  const wrongIdentityContext = fakeContext({});
  const wrongIdentityClock = new ImmediatePollingClock();
  let wrongIdentityProbes = 0;
  wrongIdentityContext.fetchJson = async () => ({
    status: 'ok',
    statusCode: 200,
    json: {
      ok: true,
      product: wrongIdentityProbes++ % 2 === 0 ? 'another-product' : 'cosyncing',
      machine: 'another-machine',
    },
  });
  const wrongIdentityAccepted = await verifyAdvertisedBrokerEndpoint({
    context: wrongIdentityContext,
    advertisedUrl: 'https://devbox.tailnet.ts.net',
    machineLabel: 'devbox',
    timeoutMs: ADVERTISED_ENDPOINT_VERIFY_INTERVAL_MS * 2 + 1,
    clock: wrongIdentityClock,
  });
  check('advertised endpoint polling rejects the wrong product or machine through the deadline',
    !wrongIdentityAccepted && wrongIdentityProbes === 3
      && wrongIdentityClock.timeMs === ADVERTISED_ENDPOINT_VERIFY_INTERVAL_MS * 2 + 1,
    `accepted=${wrongIdentityAccepted} probes=${wrongIdentityProbes} elapsed=${wrongIdentityClock.timeMs}`);
  check('deadline failure clears every advertised polling timer',
    wrongIdentityClock.schedules === 3
      && wrongIdentityClock.cancellations === 3
      && wrongIdentityClock.pending.size === 0,
    `scheduled=${wrongIdentityClock.schedules} cancelled=${wrongIdentityClock.cancellations} pending=${wrongIdentityClock.pending.size}`);

  // ── Address fallback when the advertised NAME cannot be resolved ──
  // A WSL host reproduces this exactly: the MagicDNS name fails through the system resolver while the
  // node's own Tailscale address answers normally. Verification must survive that without ever loosening
  // what it proves — same identity checks, same deadline, same certificate validation.
  const ADVERTISED = 'https://devbox.tailnet.ts.net';
  const IPV4 = '100.64.0.1';
  const IPV6 = 'fd7a:115c:a1e0::1';
  const thisBroker = { ok: true, product: 'cosyncing', machine: 'devbox' };

  /** Run one verification, recording every address literal the fallback actually connected to. */
  async function verifyWithFallback(options: {
    named: () => SetupHttpProbe;
    direct?: (probe: AdvertisedEndpointDirectProbeOptions) => SetupHttpProbe;
    addresses?: readonly string[];
    advertisedUrl?: string;
    timeoutMs?: number;
  }): Promise<{
    ok: boolean;
    calls: AdvertisedEndpointDirectProbeOptions[];
    clock: ImmediatePollingClock;
  }> {
    const context = fakeContext({});
    const clock = new ImmediatePollingClock();
    const calls: AdvertisedEndpointDirectProbeOptions[] = [];
    context.fetchJson = async () => options.named();
    const ok = await verifyAdvertisedBrokerEndpoint({
      context,
      advertisedUrl: options.advertisedUrl ?? ADVERTISED,
      machineLabel: 'devbox',
      timeoutMs: options.timeoutMs ?? ADVERTISED_ENDPOINT_VERIFY_INTERVAL_MS * 2 + 1,
      clock,
      fallbackAddresses: options.addresses ?? [IPV4, IPV6],
      async directProbe(probe) {
        calls.push(probe);
        return options.direct?.(probe) ?? { status: 'unreachable' };
      },
    });
    return { ok, calls, clock };
  }

  const resolvable = await verifyWithFallback({ named: () => ({ status: 'ok', statusCode: 200, json: thisBroker }) });
  check('a resolvable MagicDNS name verifies without ever probing an address literal',
    resolvable.ok && resolvable.calls.length === 0,
    `ok=${resolvable.ok} directProbes=${resolvable.calls.length}`);

  const ipv4Fallback = await verifyWithFallback({
    named: () => ({ status: 'unreachable' }),
    direct: (probe) => (probe.address === IPV4
      ? { status: 'ok', statusCode: 200, json: thisBroker }
      : { status: 'unreachable' }),
  });
  check('a MagicDNS name that will not resolve still verifies through this node IPv4 address',
    ipv4Fallback.ok && ipv4Fallback.calls.length === 1 && ipv4Fallback.calls[0]?.address === IPV4,
    `ok=${ipv4Fallback.ok} calls=${ipv4Fallback.calls.map((c) => c.address).join(',')}`);
  check('the fallback presents the advertised hostname for SNI, certificate validation, and Host',
    ipv4Fallback.calls[0]?.hostname === 'devbox.tailnet.ts.net'
      && ipv4Fallback.calls[0]?.port === 443
      && ipv4Fallback.calls[0]?.path === '/api/health',
    JSON.stringify(ipv4Fallback.calls[0]));
  check('a fallback success leaves no advertised polling timer armed',
    ipv4Fallback.clock.pending.size === 0
      && ipv4Fallback.clock.schedules === ipv4Fallback.clock.cancellations,
    `scheduled=${ipv4Fallback.clock.schedules} cancelled=${ipv4Fallback.clock.cancellations} pending=${ipv4Fallback.clock.pending.size}`);

  const ipv6Fallback = await verifyWithFallback({
    named: () => ({ status: 'unreachable' }),
    direct: (probe) => (probe.address === IPV6
      ? { status: 'ok', statusCode: 200, json: thisBroker }
      : { status: 'unreachable' }),
  });
  check('an unreachable IPv4 literal falls through to this node IPv6 address',
    ipv6Fallback.ok && ipv6Fallback.calls.map((c) => c.address).join(',') === `${IPV4},${IPV6}`,
    `ok=${ipv6Fallback.ok} calls=${ipv6Fallback.calls.map((c) => c.address).join(',')}`);

  // A certificate that does not validate for the advertised hostname reaches the probe as a transport
  // failure. It must end as a verification failure: nothing here may retry with validation disabled.
  const badCertificate = await verifyWithFallback({
    named: () => ({ status: 'unreachable' }),
    direct: () => ({ status: 'unreachable' }),
  });
  check('an untrusted or mismatched certificate fails verification instead of being bypassed',
    !badCertificate.ok && badCertificate.calls.length > 0,
    `ok=${badCertificate.ok} attempts=${badCertificate.calls.length}`);

  const wrongProduct = await verifyWithFallback({
    named: () => ({ status: 'ok', statusCode: 200, json: { ok: true, product: 'another-product', machine: 'devbox' } }),
    direct: () => ({ status: 'ok', statusCode: 200, json: thisBroker }),
  });
  check('a name answering with the wrong product never falls back to an address literal',
    !wrongProduct.ok && wrongProduct.calls.length === 0,
    `ok=${wrongProduct.ok} directProbes=${wrongProduct.calls.length}`);

  const wrongMachine = await verifyWithFallback({
    named: () => ({ status: 'ok', statusCode: 200, json: { ok: true, product: 'cosyncing', machine: 'another-machine' } }),
    direct: () => ({ status: 'ok', statusCode: 200, json: thisBroker }),
  });
  check('a name answering as another machine never falls back to an address literal',
    !wrongMachine.ok && wrongMachine.calls.length === 0,
    `ok=${wrongMachine.ok} directProbes=${wrongMachine.calls.length}`);

  const httpError = await verifyWithFallback({
    named: () => ({ status: 'http-error', statusCode: 502 }),
    direct: () => ({ status: 'ok', statusCode: 200, json: thisBroker }),
  });
  check('an HTTP error from the advertised name is a verification failure, not a resolution failure',
    !httpError.ok && httpError.calls.length === 0,
    `ok=${httpError.ok} directProbes=${httpError.calls.length}`);

  // A reachable-but-wrong ADDRESS is the same class of evidence: stop probing literals rather than
  // walking the list hoping a different one answers as this broker.
  const wrongViaAddress = await verifyWithFallback({
    named: () => ({ status: 'unreachable' }),
    direct: () => ({ status: 'ok', statusCode: 200, json: { ok: true, product: 'cosyncing', machine: 'another-machine' } }),
  });
  check('an address literal answering as another machine retires the fallback instead of trying the rest',
    !wrongViaAddress.ok && wrongViaAddress.calls.length === 1,
    `ok=${wrongViaAddress.ok} calls=${wrongViaAddress.calls.map((c) => c.address).join(',')}`);

  const unreachable = await verifyWithFallback({ named: () => ({ status: 'unreachable' }) });
  check('a genuinely unreachable endpoint fails after exhausting both the name and every address',
    !unreachable.ok && unreachable.calls.length === 6 && unreachable.clock.pending.size === 0,
    `ok=${unreachable.ok} attempts=${unreachable.calls.length} pending=${unreachable.clock.pending.size}`);

  const nonLiteral = await verifyWithFallback({
    named: () => ({ status: 'unreachable' }),
    direct: () => ({ status: 'ok', statusCode: 200, json: thisBroker }),
    addresses: ['not-an-ip', 'devbox.tailnet.ts.net', '', '100.64.0.1:443'],
  });
  check('a fallback entry that is not a bare address literal is never connected to',
    !nonLiteral.ok && nonLiteral.calls.length === 0,
    `ok=${nonLiteral.ok} directProbes=${nonLiteral.calls.length}`);

  const plaintext = await verifyWithFallback({
    named: () => ({ status: 'unreachable' }),
    direct: () => ({ status: 'ok', statusCode: 200, json: thisBroker }),
    advertisedUrl: 'http://devbox.tailnet.ts.net',
  });
  check('a non-HTTPS advertised URL gets no address fallback, because SNI is what makes it sound',
    !plaintext.ok && plaintext.calls.length === 0,
    `ok=${plaintext.ok} directProbes=${plaintext.calls.length}`);

  // Bounding, not just ordering: a malformed or unexpectedly long status payload must not turn one
  // interactive probe into N request timeouts.
  const manyAddresses = await verifyWithFallback({
    named: () => ({ status: 'unreachable' }),
    addresses: ['100.64.0.1', '100.64.0.2', '100.64.0.3', IPV6, 'fd7a:115c:a1e0::2'],
    timeoutMs: ADVERTISED_ENDPOINT_VERIFY_INTERVAL_MS + 1,
  });
  check('at most one IPv4 and one IPv6 candidate are ever contacted',
    manyAddresses.calls.every((call) => call.address === '100.64.0.1' || call.address === IPV6)
      && new Set(manyAddresses.calls.map((call) => call.address)).size === 2,
    manyAddresses.calls.map((call) => call.address).join(','));
  check('capping keeps the two families rather than the first two entries',
    limitFallbackAddresses(['100.64.0.1', '100.64.0.2', IPV6]).join(',') === `100.64.0.1,${IPV6}`
      && limitFallbackAddresses(['bogus', IPV6]).join(',') === IPV6
      && limitFallbackAddresses([]).length === 0,
    limitFallbackAddresses(['100.64.0.1', '100.64.0.2', IPV6]).join(','));

  // A single-shot caller supplies no deadline of its own, so the primitive must impose one.
  {
    const context = fakeContext({});
    context.fetchJson = async () => ({ status: 'unreachable' });
    let contacted = 0;
    const started = Date.now();
    const probe = await probeAdvertisedEndpointOnce({
      context,
      advertisedUrl: ADVERTISED,
      fallbackAddresses: [IPV4, IPV6],
      totalTimeoutMs: 120,
      async directProbe(options) {
        contacted += 1;
        await new Promise((wait) => setTimeout(wait, options.timeoutMs));
        return { status: 'unreachable' };
      },
    });
    const elapsed = Date.now() - started;
    check('a single-shot probe bounds the name plus every address under one total deadline',
      probe.status === 'unreachable' && contacted >= 1 && elapsed < 1_000,
      `elapsed=${elapsed}ms addressAttempts=${contacted}`);
  }

  const parsed = tailscaleAddressesFromStatusJson({
    BackendState: 'Running',
    Self: { DNSName: 'devbox.tailnet.ts.net.', TailscaleIPs: [IPV4, IPV6, 'bogus', 42, IPV4] },
    Peer: { 'peer-key': { TailscaleIPs: ['100.64.9.9'] } },
  });
  check('self addresses parse from tailscale status, dropping duplicates, malformed entries, and peers',
    parsed.join(',') === `${IPV4},${IPV6}`,
    parsed.join(',') || '(none)');
  check('a status payload with no self addresses yields no fallback at all',
    tailscaleAddressesFromStatusJson({ BackendState: 'Running', Self: { DNSName: 'devbox.tailnet.ts.net.' } }).length === 0
      && tailscaleAddressesFromStatusJson({}).length === 0
      && tailscaleAddressesFromStatusJson(undefined).length === 0);
}

function fakeContext(options: {
  wsl?: boolean;
  executable?: string;
  status?: unknown | 'nonzero';
  serve?: unknown | 'nonzero';
  platform?: string;
  /** Present the Mac App Store bundle CLI on disk without putting it on PATH. */
  bundleCli?: boolean;
}): SetupDiagnosisContext {
  return {
    effects: 'forbidden',
    platform: options.platform ?? 'linux',
    arch: options.platform === 'darwin' ? 'arm64' : 'x64',
    env: options.wsl ? { WSL_DISTRO_NAME: 'Ubuntu', PATH: '' } : { PATH: '' },
    homeDir: '/home/test',
    resolveExecutable(command) {
      if (command === 'tailscale' || command === 'tailscale.exe') return options.executable;
      return undefined;
    },
    inspectPath: (path) => (options.bundleCli && path === MACOS_TAILSCALE_BUNDLE_CLI
      ? { status: 'file', readable: true, displayPath: path }
      : { status: 'missing', readable: false, displayPath: path }),
    readText: () => ({ ok: false, reason: 'missing' }),
    readPackageVersion: () => undefined,
    async runReadOnly(_path, args) {
      const value = args[0] === 'status' ? options.status : options.serve;
      if (value === 'nonzero') return { status: 'nonzero', exitCode: 1, stdout: '', stderr: 'not running' };
      return { status: 'ok', exitCode: 0, stdout: JSON.stringify(value ?? {}), stderr: '' };
    },
    async fetchJson() { return { status: 'unreachable' }; },
    async probeTcp() { return 'closed'; },
    listDirectory() { return { ok: false, reason: 'missing' } as const; },
    processAlive() { return false; },
    displayPath: (path) => path,
  };
}

const healthyStatus = {
  BackendState: 'Running',
  Self: { DNSName: 'devbox.tailnet.ts.net.' },
};

{
  check('pairing Broker URLs normalize to an origin without a reachability probe',
    normalizePairingBrokerUrl('https://cosy.example.com/') === 'https://cosy.example.com'
      && normalizePairingBrokerUrl('http://100.64.0.1:7734') === 'http://100.64.0.1:7734'
      && normalizePairingBrokerUrl(undefined) === undefined
      && pairingBrokerUrlUsesUnprotectedHttp('http://cosy.example.com')
      && !pairingBrokerUrlUsesUnprotectedHttp('http://127.0.0.1:7734'));
  for (const invalid of [
    'ftp://cosy.example.com',
    'https://user:secret@cosy.example.com',
    'https://cosy.example.com/path',
    'https://cosy.example.com?query=1',
    'https://cosy.example.com#fragment',
    'https://cosy.example.com\n',
  ]) {
    let rejected = false;
    try { normalizePairingBrokerUrl(invalid); } catch { rejected = true; }
    check(`pairing Broker URL rejects ${JSON.stringify(invalid)}`, rejected);
  }
}

// The pairing QR is read by a phone camera pointed at a terminal, so geometry and contrast are the
// contract — but so is the byte count, because the byte count is what decides the geometry. Everything here
// runs on a payload from the PRODUCTION offer machinery: a real X25519 key off the on-disk key store, real
// 16-byte/9-byte random ids, the real encoder, and a MagicDNS URL as long as a real one gets. A short fake
// key and toy ids shrink the symbol by twelve columns and would have let the shipped 85-column QR pass.
{
  // Built rather than written literally: a bare ESC byte in a source file is invisible in review.
  const ESC = String.fromCharCode(27);
  const qrHome = mkdtempSync(join(tmpdir(), 'cosyncing-pairing-qr-'));
  // A production-LENGTH tailnet URL, not the short `devbox.tailnet.ts.net` fixture: MagicDNS names are
  // `<host>.<tailnet>.ts.net`, the host half is whatever the operator called the machine, and a real one
  // runs to about 50 characters. Only the length reaches the symbol, so the name is synthetic and padded
  // rather than copied off a real device. The short fixture URL renders 73 columns instead of 77 — a whole
  // QR version of headroom this check must not be handed.
  const advertisedUrl = `https://devbox-${'a'.repeat(20)}.tailnet.ts.net`;
  const qrRegistry = new TransportPairingRegistry({
    // Configured exactly as runtime.ts configures it, so this pins what the offer does with the descriptor
    // rather than assuming it.
    broker: { version: BUILD_INFO.version, contract: { ...BROKER_CONTRACT } },
    home: qrHome,
  });
  const offer = qrRegistry.createOffer({ brokerUrl: advertisedUrl });
  const payload = offer.qr;
  const parsedOffer = parseQrPairingPayload(payload) as QrPairingPayloadV3;
  const rendered = await renderTerminalPairingQr(payload);
  const colored = renderTerminalQr(payload, { color: true });
  const mono = renderTerminalQr(payload, { color: false });
  // Not trimEnd(): the quiet zone's trailing lines are all spaces and trimming would delete the very
  // border these checks exist to pin. The renderer ends with exactly one newline, so drop that alone.
  const monoLines = mono.split('\n').slice(0, -1);
  const widths = new Set(monoLines.map((line) => [...line].length));
  const width = monoLines[0]?.length ?? 0;

  check('the default renderer answers, and an explicit colour choice changes the output',
    rendered.length > 100 && colored.length > mono.length && monoLines.length > 5);
  // Terminal cells are ~1:2, so one cell per module renders modules stretched 1:2. Two module rows per line
  // via a half block is what makes them square again: height must be half the width, not equal to it.
  check('two module rows share each line, so modules render square',
    widths.size === 1 && width > 0 && monoLines.length === Math.ceil(width / 2),
    `width=${width} lines=${monoLines.length}`);
  // A wrapped QR is not a degraded QR, it is not a QR. The number is pinned exactly, not just bounded: the
  // payload is deterministic in length (fixed-width ids, a 44-byte SPKI key, one URL), so a change that
  // re-inflates it moves this by a whole QR version rather than sliding quietly under 80.
  check('the production-shaped symbol is 73 columns and fits an 80-column terminal',
    width === 73 && width <= 80, `width=${width} payload=${payload.length}`);
  check('terminalQrWidth answers without rendering, and agrees with what was rendered',
    terminalQrWidth(payload) === width, `predicted=${terminalQrWidth(payload)} rendered=${width}`);
  // The descriptor duplicates what /api/health, the accept response, and the WS hello all carry, and the
  // Dart parser drops it; carrying it here cost 154 characters and pushed the symbol to 85 columns. It stays
  // in the response, and a payload that still contains it stays parseable.
  check('the QR drops the redundant broker descriptor while the offer response keeps it',
    parsedOffer.broker === undefined
      && offer.broker?.version === BUILD_INFO.version
      && offer.broker?.contract.surfaceHash === BROKER_CONTRACT.surfaceHash,
    `qrBroker=${JSON.stringify(parsedOffer.broker)}`);
  check('the QR still carries every field the client parses',
    parsedOffer.version === 3
      && parsedOffer.pairingId === offer.pairingId
      && parsedOffer.brokerId === offer.brokerPeerId
      && parsedOffer.publicKey.length === 59
      && parsedOffer.transport.kind === 'broker-url'
      && parsedOffer.transport.url === advertisedUrl);
  const urlFreeOffer = parseQrPairingPayload(qrRegistry.createOffer().qr) as QrPairingPayloadV3;
  check('a URL-free offer carries authentication material without a target URL',
    urlFreeOffer.version === 3
      && urlFreeOffer.transport.kind === 'broker-url'
      && urlFreeOffer.transport.url === undefined
      && !JSON.stringify(urlFreeOffer).includes(advertisedUrl));
  // Compaction bought headroom, not immunity: the advertised URL is the operator's, and a long enough one
  // still crosses 80. Pin where that happens so the fallback below is a measured floor, not a guess.
  //
  // The ids below are FIXED fixtures rather than this offer's own, because a symbol's size follows the
  // ENCODED payload and the encoder segments by content, not merely by length: base64url mixes
  // alphanumeric-encodable runs (A-Z, 0-9, -) with byte-only ones, so two payloads of identical length
  // can encode to different QR versions. At this URL length the payload sits exactly on the version
  // 13/14 boundary, and live random ids rendered 77 instead of the asserted 81 for ~1% of offers — a
  // gate failure with no source change behind it. Lengthening the URL does not fix it; sampling put a
  // 93-character URL at 1 in 50_000. Only fixed content makes the measurement reproducible, and the
  // lengths are asserted against the live offer so pinning content cannot mask a change in the real
  // id or key shapes.
  {
    // Production shapes: `broker_` + 12 characters, `pair_` + 22, and a 59-character key.
    const brokerId = 'broker_Fixture0Qr01';
    const pairingId = 'pair_Fixture0000QrWidth0001';
    const publicKey = 'FixtureQrWidthPublicKey00000000000000000000000000000000abcd';
    check('the fixed width fixtures still carry the production id and key lengths',
      brokerId.length === parsedOffer.brokerId.length
        && pairingId.length === parsedOffer.pairingId.length
        && publicKey.length === parsedOffer.publicKey.length,
      `fixture=${brokerId.length}/${pairingId.length}/${publicKey.length}`
        + ` live=${parsedOffer.brokerId.length}/${parsedOffer.pairingId.length}`
        + `/${parsedOffer.publicKey.length}`);
    const overflowing = createQrPairingPayload({
      version: 3,
      brokerId,
      pairingId,
      publicKey,
      transport: { kind: 'broker-url', url: `https://${'h'.repeat(81)}.ts.net` },
    });
    check('a 96-character Broker URL is the first fixed fixture that outgrows 80 columns',
      terminalQrWidth(overflowing) === 81, `width=${terminalQrWidth(overflowing)}`);
  }
  rmSync(qrHome, { recursive: true, force: true });
  // 30/37/40/47 index the terminal THEME palette, where black and white are routinely a dark grey and a
  // beige — the reported "low-contrast greyscale". 24-bit escapes name the colours a scanner needs.
  check('colour mode paints explicit black and white, never the theme palette',
    colored.includes(`${ESC}[38;2;0;0;0m`) && colored.includes(`${ESC}[48;2;255;255;255m`)
      && !new RegExp(`${ESC}\\[(30|37|40|47)m`).test(colored));
  check('the no-colour fallback is block glyphs alone',
    !mono.includes(ESC) && /^[▀▄█ \n]+$/.test(mono));
  // Four light modules on every side: two full text lines top and bottom, four cells left and right.
  check('a four-module quiet zone borders the symbol on every side',
    monoLines.slice(0, 2).every((line) => line.trim() === '')
      && monoLines.slice(-2).every((line) => line.trim() === '')
      && monoLines.every((line) => line.startsWith('    ') && line.endsWith('    ')),
    `first=${JSON.stringify(monoLines[0])}`);
  // Colour mode must PAINT the quiet zone rather than leave it to the terminal background, or it vanishes
  // on a dark theme exactly where a scanner looks for the symbol's border.
  check('colour mode paints the quiet zone white instead of leaving it transparent',
    (colored.split('\n')[0] ?? '').includes(`${ESC}[48;2;255;255;255m`));
  check('colour policy matches doctor: TTY on, NO_COLOR or dumb terminals off',
    terminalQrColorEnabled({ env: {}, tty: true })
      && !terminalQrColorEnabled({ env: {}, tty: false })
      && !terminalQrColorEnabled({ env: { NO_COLOR: '1' }, tty: true })
      && !terminalQrColorEnabled({ env: { TERM: 'dumb' }, tty: true }));
}

// Pure topology fixtures, including the WSL split required by the plan.
{
  const missing = await inspectTailscaleServe({
    context: fakeContext({ wsl: true }),
    internalUrl: 'http://127.0.0.1:7734',
  });
  const windows = await inspectTailscaleServe({
    context: fakeContext({ wsl: true, executable: '/mnt/c/Program Files/Tailscale/tailscale.exe' }),
    internalUrl: 'http://127.0.0.1:7734',
  });
  const stopped = await inspectTailscaleServe({
    context: fakeContext({ wsl: true, executable: '/usr/bin/tailscale', status: 'nonzero' }),
    internalUrl: 'http://127.0.0.1:7734',
  });
  const healthy = await inspectTailscaleServe({
    context: fakeContext({ wsl: true, executable: '/usr/bin/tailscale', status: healthyStatus, serve: {} }),
    internalUrl: 'http://127.0.0.1:7734',
  });
  check('WSL topology distinguishes missing, Windows-host-only, stopped in-WSL, and healthy in-WSL',
    missing.topology === 'missing'
      && windows.topology === 'windows-host-only'
      && stopped.topology === 'inside-wsl' && stopped.backend === 'daemon-unavailable'
      && healthy.topology === 'inside-wsl' && healthy.backend === 'running'
      && healthy.advertisedUrl === 'https://devbox.tailnet.ts.net');

  // macOS is its own topology, and a Mac App Store install (CLI in the app bundle, nothing on PATH) must be
  // found rather than reported as "Tailscale is not installed".
  const macOnPath = await inspectTailscaleServe({
    context: fakeContext({ platform: 'darwin', executable: '/opt/homebrew/bin/tailscale', status: healthyStatus, serve: {} }),
    internalUrl: 'http://127.0.0.1:7734',
  });
  const macBundle = await inspectTailscaleServe({
    context: fakeContext({ platform: 'darwin', bundleCli: true, status: healthyStatus, serve: {} }),
    internalUrl: 'http://127.0.0.1:7734',
  });
  const macAbsent = await inspectTailscaleServe({
    context: fakeContext({ platform: 'darwin' }),
    internalUrl: 'http://127.0.0.1:7734',
  });
  check('macOS reports its own topology and falls back to the App Store bundle CLI',
    macOnPath.topology === 'native-macos' && macOnPath.backend === 'running'
      && macBundle.topology === 'native-macos' && macBundle.backend === 'running'
      && macBundle.executablePath === MACOS_TAILSCALE_BUNDLE_CLI
      && macAbsent.topology === 'missing' && macAbsent.detailCode === 'tailscale-missing',
    `${macOnPath.topology}/${macBundle.executablePath}/${macAbsent.detailCode}`);

  const desired = inspectServeStatusJson({
    TCP: { 443: { HTTPS: true } },
    Web: { 'devbox.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7734' } } } },
  }, { dnsName: 'devbox.tailnet.ts.net', desiredTarget: 'http://127.0.0.1:7734' });
  const conflict = inspectServeStatusJson({
    Web: { 'devbox.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } },
  }, { dnsName: 'devbox.tailnet.ts.net', desiredTarget: 'http://127.0.0.1:7734' });
  const funnel = inspectServeStatusJson({
    AllowFunnel: { 'devbox.tailnet.ts.net:443': true },
    Web: { 'devbox.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7734' } } } },
  }, { dnsName: 'devbox.tailnet.ts.net', desiredTarget: 'http://127.0.0.1:7734' });
  check('Serve parser accepts only the exact private root target and refuses conflicts/Funnel',
    desired.route === 'desired' && conflict.route === 'conflict' && funnel.route === 'funnel-conflict');

  // A host may already serve sibling paths on the same MagicDNS name (a real one serves /tokdash). Those
  // handlers are not the root route and must read as neither a conflict nor an existing cosyncing route.
  const siblingOnly = inspectServeStatusJson({
    TCP: { 443: { HTTPS: true } },
    Web: { 'devbox.tailnet.ts.net:443': { Handlers: { '/tokdash': { Proxy: 'http://127.0.0.1:55423' } } } },
  }, { dnsName: 'devbox.tailnet.ts.net', desiredTarget: 'http://127.0.0.1:7734' });
  const siblingBeside = inspectServeStatusJson({
    TCP: { 443: { HTTPS: true } },
    Web: {
      'devbox.tailnet.ts.net:443': {
        Handlers: {
          '/tokdash': { Proxy: 'http://127.0.0.1:55423' },
          '/': { Proxy: 'http://127.0.0.1:7734' },
        },
      },
    },
  }, { dnsName: 'devbox.tailnet.ts.net', desiredTarget: 'http://127.0.0.1:7734' });
  check('a sibling Serve path on the same hostname is neither a conflict nor a cosyncing route',
    siblingOnly.route === 'missing' && siblingBeside.route === 'desired'
      && siblingBeside.routeTarget === 'http://127.0.0.1:7734',
    `${siblingOnly.route}/${siblingBeside.route}`);
}

// The Serve mutation must be per-path additive. `tailscale serve --set-path=<p>` touches exactly one
// handler, so registering the broker root leaves an existing sibling route alone; a whole-config form would
// silently take the hostname over. The runner below models that per-path contract and refuses any command
// that does not scope itself, so a regression to a config-replacing invocation fails here.
{
  const handlers: Record<string, { Proxy: string }> = { '/tokdash': { Proxy: 'http://127.0.0.1:55423' } };
  const commandArgs: string[][] = [];
  const context = fakeContext({ executable: '/usr/bin/tailscale', status: healthyStatus, serve: {} });
  context.runReadOnly = async (_path, args) => ({
    status: 'ok',
    exitCode: 0,
    stdout: JSON.stringify(args[0] === 'status' ? healthyStatus : {
      TCP: { 443: { HTTPS: true } },
      Web: { 'devbox.tailnet.ts.net:443': { Handlers: { ...handlers } } },
    }),
    stderr: '',
  });
  const runner: ServiceCommandRunner = {
    async run(_executable, args) {
      commandArgs.push([...args]);
      const path = args.find((arg) => arg.startsWith('--set-path='))?.slice('--set-path='.length);
      if (!path) throw new Error('serve invocation did not scope itself to a single path');
      if (args.at(-1) === 'off') delete handlers[path];
      else handlers[path] = { Proxy: args.at(-1)! };
      return { status: 'ok', exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const provider = new TailscaleServeProvider({ context, internalUrl: 'http://127.0.0.1:7734', runner });
  const action = createTailscaleServeSetupAction(provider, { desired: 'installed' });
  const transactionContext: SetupTransactionContext = {
    home: '/tmp/cosyncing-serve-coexistence',
    transactionDirectory: '/tmp/cosyncing-serve-coexistence/tx',
    plan: { schemaVersion: 1, id: 'serve-coexistence', preconditionHash: '0'.repeat(64), actions: [] },
  };
  const before = await provider.inspect();
  const rollbackRecord = await action.prepare(transactionContext);
  await action.apply(transactionContext);
  const verified = await action.verify(transactionContext);
  const afterApply = { ...handlers };
  await action.rollback(transactionContext, rollbackRecord);
  check('registering the broker root preserves an existing sibling Serve path',
    before.route === 'missing' && !!verified
      && afterApply['/tokdash']?.Proxy === 'http://127.0.0.1:55423'
      && afterApply['/']?.Proxy === 'http://127.0.0.1:7734',
    JSON.stringify(afterApply));
  check('removing the broker root removes only its own path and leaves the sibling serving',
    Object.keys(handlers).join(',') === '/tokdash'
      && handlers['/tokdash']?.Proxy === 'http://127.0.0.1:55423',
    JSON.stringify(handlers));
  check('every Serve mutation is scoped to one path and never replaces the whole configuration',
    commandArgs.length === 2
      && commandArgs.every((args) => args.includes('--set-path=/')
        && !args.some((arg) => arg === 'reset' || arg === 'clear' || arg.startsWith('--set-raw'))),
    JSON.stringify(commandArgs));
}

// Transactional route action: exact argv, ownership receipt, and inverse-only rollback.
{
  let route: 'missing' | 'desired' = 'missing';
  const commandArgs: string[][] = [];
  const context = fakeContext({ executable: '/usr/bin/tailscale', status: healthyStatus, serve: {} });
  context.runReadOnly = async (_path, args) => {
    if (args[0] === 'status') return { status: 'ok', exitCode: 0, stdout: JSON.stringify(healthyStatus), stderr: '' };
    const serve = route === 'missing' ? {} : {
      TCP: { 443: { HTTPS: true } },
      Web: { 'devbox.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7734' } } } },
    };
    return { status: 'ok', exitCode: 0, stdout: JSON.stringify(serve), stderr: '' };
  };
  const runner: ServiceCommandRunner = {
    async run(_executable, args) {
      commandArgs.push([...args]);
      route = args.includes('off') ? 'missing' : 'desired';
      return { status: 'ok', exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const provider = new TailscaleServeProvider({
    context,
    internalUrl: 'http://127.0.0.1:7734',
    runner,
  });
  const action = createTailscaleServeSetupAction(provider, { desired: 'installed' });
  const transactionContext: SetupTransactionContext = {
    home: '/tmp/cosyncing-pairing-fixture',
    transactionDirectory: '/tmp/cosyncing-pairing-fixture/tx',
    plan: { schemaVersion: 1, id: 'pairing-fixture', preconditionHash: '0'.repeat(64), actions: [] },
  };
  const rollback = await action.prepare(transactionContext);
  const applied = await action.apply(transactionContext);
  const verified = await action.verify(transactionContext);
  await action.rollback(transactionContext, rollback);
  check('owned route action registers and verifies one private HTTPS root receipt',
    !!verified && applied?.resources?.[0]?.id === TAILSCALE_SERVE_RESOURCE_ID
      && applied.resources[0]?.ownership.proof === 'receipt');
  check('setup route mutation never invokes Funnel and rollback removes only the exact route',
    commandArgs.length === 2
      && commandArgs.every((args) => args[0] === 'serve' && !args.some((arg) => /funnel/i.test(arg)))
      && commandArgs[0]?.includes('--bg') === true && commandArgs[0]?.includes('--https=443') === true
      && commandArgs[1]?.at(-1) === 'off' && route === 'missing',
    JSON.stringify(commandArgs));
}

function writer() {
  let value = '';
  return {
    output: { write(text: string) { value += text; } },
    text: () => value,
  };
}

function prepareHome(
  root: string,
  serviceChoice: 'foreground' | 'systemd' = 'foreground',
  language: 'en' | 'zh-Hans' = 'en',
): string {
  const home = join(root, '.cosyncing');
  const config = defaultBrokerConfig();
  config.broker.machineLabel = 'devbox';
  config.broker.advertisedUrl = 'https://devbox.tailnet.ts.net';
  writeBrokerConfig(config, home);
  ensureInstallationCredentials({ home, internalUrl: config.broker.internalUrl });
  writeSetupState({ schemaVersion: 1, serviceChoice, tailscaleServeRequested: true, language }, home);
  writeInstallState(committedInstallState('2026-07-17T00:00:00.000Z'), home);
  return home;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-pairing-'));
try {
  const home = prepareHome(root);
  const pairingId = 'pair_public_fixture';
  const qr = createQrPairingPayload({
    version: 3,
    brokerId: 'broker_public_fixture',
    pairingId,
    publicKey: 'broker-public-key',
    transport: { kind: 'broker-url', url: 'https://devbox.tailnet.ts.net' },
  });

  // Pairing preflights both endpoints before creating any state, renders public-only QR, then waits.
  {
    const calls: Array<{ url: string; method: string; authenticated: boolean }> = [];
    const out = writer();
    const err = writer();
    let renderedPayload = '';
    const result = await runPairCommand({
      json: false,
      wait: true,
      brokerUrl: 'https://devbox.tailnet.ts.net',
      clientLabel: 'Test phone',
      home,
      invocation: 'cosy',
      interactive: false,
      stdout: out.output,
      stderr: err.output,
    }, {
      renderQr: async (payload) => { renderedPayload = payload; return `QR(${payload})`; },
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const headers = new Headers(init?.headers);
        calls.push({ url, method, authenticated: headers.has('x-cosyncing-token') });
        if (url.endsWith('/api/health')) return jsonResponse({ ok: true, product: 'cosyncing', machine: 'devbox' });
        if (url.endsWith('/api/transport/pairings') && method === 'POST') {
          return jsonResponse({
            ok: true,
            pairingId,
            qr,
            brokerPeerId: 'broker_public_fixture',
            expiresAt: '2026-07-17T00:05:00.000Z',
          }, 201);
        }
        if (url.endsWith(`/api/transport/pairings/${pairingId}`)) {
          return jsonResponse({ ok: true, state: 'accepted', peerId: 'phone-1' });
        }
        return jsonResponse({ error: 'unexpected' }, 500);
      },
      now: () => Date.parse('2026-07-17T00:00:00.000Z'),
    });
    const postIndex = calls.findIndex((call) => call.method === 'POST');
    check('pair verifies only the local broker identity before creating an offer',
      result.exitCode === 0 && postIndex === 1
        && calls[0]?.url === 'http://127.0.0.1:7734/api/health'
        && calls[0]?.authenticated === false
        && calls[postIndex]?.authenticated === true,
      JSON.stringify(calls));
    check('terminal pair renders QR v3, expiry, full-access warning, and accepted device without a peer token',
      out.text().includes(`QR(${qr})`)
        && out.text().includes('one-use')
        && out.text().includes('full broker API access')
        && out.text().includes('Paired device phone-1')
        && !/peerToken|privateKey/.test(out.text())
        && err.text() === '');
    const printedPairingLink = out.text().split('\n').find((line) => line.startsWith('Pairing link: '));
    const parsedPrintedPayload = printedPairingLink == null
      ? undefined
      : parseQrPairingPayload(printedPairingLink.slice('Pairing link: '.length)) as QrPairingPayloadV3;
    check('the selectable pairing link exactly matches the QR payload and keeps the supplied Broker URL',
      renderedPayload === qr
        && printedPairingLink === `Pairing link: ${qr}`
        && parsedPrintedPayload != null
        && parsedPrintedPayload.transport.url === 'https://devbox.tailnet.ts.net'
        && !parsedPrintedPayload.transport.url.includes('/cosy'),
      JSON.stringify({ renderedPayload, printedPairingLink, transport: parsedPrintedPayload?.transport.url }));
    const tokenPath = brokerTokenPath(home);
    const actualToken = readBrokerToken(tokenPath);
    check('non-interactive pair --wait tells the operator where the browser-client (shared) token lives',
      out.text().includes(`Authentication token file: ${tokenPath}`)
        && out.text().includes(`Read it: cat ${tokenPath}`)
        && out.text().includes('/cosy')
        && !out.text().includes('/poc-ui')
        && out.text().includes('per-device')
        && !out.text().includes(actualToken)
        && err.text() === '',
      out.text());
  }

  // A plain single-offer `pair` (no --wait) still ends with the same browser-client credential pointer.
  {
    const out = writer();
    const err = writer();
    const singlePairingId = 'pair_single_fixture';
    const singleQr = createQrPairingPayload({
      version: 3,
      brokerId: 'broker_public_fixture',
      pairingId: singlePairingId,
      publicKey: 'broker-public-key',
      transport: { kind: 'broker-url', url: 'https://devbox.tailnet.ts.net' },
    });
    const result = await runPairCommand({
      json: false,
      wait: false,
      brokerUrl: 'https://devbox.tailnet.ts.net',
      home,
      invocation: 'cosy',
      stdout: out.output,
      stderr: err.output,
    }, {
      renderQr: async () => 'QR',
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/api/health')) return jsonResponse({ ok: true, product: 'cosyncing', machine: 'devbox' });
        if (url.endsWith('/api/transport/pairings') && method === 'POST') {
          return jsonResponse({
            ok: true,
            pairingId: singlePairingId,
            qr: singleQr,
            brokerPeerId: 'broker_public_fixture',
            expiresAt: '2026-07-17T00:05:00.000Z',
          }, 201);
        }
        return jsonResponse({ error: 'unexpected' }, 500);
      },
    });
    const tokenPath = brokerTokenPath(home);
    const actualToken = readBrokerToken(tokenPath);
    check('a single-offer pair (no --wait) also points to the browser-client token without printing it',
      result.exitCode === 0 && result.detailCode === 'pairing-created'
        && out.text().includes(`Authentication token file: ${tokenPath}`)
        && out.text().includes(`Read it: cat ${tokenPath}`)
        && !out.text().includes(actualToken)
        && err.text() === '',
      out.text());
  }

  // Compaction fits every realistic tailnet URL, but the URL is the operator's and a long enough one still
  // does not fit. A terminal too narrow for the symbol must say so and hand over the link: wrapped output
  // still looks like a QR to the operator, so silently printing it is the one outcome that cannot be caught.
  {
    const out = writer();
    const err = writer();
    const narrowPairingId = 'pair_narrow_fixture';
    const narrowQr = createQrPairingPayload({
      version: 3,
      brokerId: 'broker_public_fixture',
      pairingId: narrowPairingId,
      publicKey: 'broker-public-key',
      transport: { kind: 'broker-url', url: 'https://devbox.tailnet.ts.net' },
    });
    const narrowWidth = terminalQrWidth(narrowQr);
    const result = await runPairCommand({
      json: false,
      wait: false,
      brokerUrl: 'https://devbox.tailnet.ts.net',
      home,
      invocation: 'cosy',
      stdout: out.output,
      stderr: err.output,
    }, {
      columns: () => narrowWidth - 1,
      renderQr: async () => 'QR-SHOULD-NOT-BE-PRINTED',
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/api/health')) return jsonResponse({ ok: true, product: 'cosyncing', machine: 'devbox' });
        if (url.endsWith('/api/transport/pairings') && method === 'POST') {
          return jsonResponse({
            ok: true,
            pairingId: narrowPairingId,
            qr: narrowQr,
            brokerPeerId: 'broker_public_fixture',
            expiresAt: '2026-07-17T00:05:00.000Z',
          }, 201);
        }
        return jsonResponse({ error: 'unexpected' }, 500);
      },
    });
    check('a terminal narrower than the symbol prints the pairing link and both widths, never a wrapped QR',
      result.exitCode === 0
        && !out.text().includes('QR-SHOULD-NOT-BE-PRINTED')
        && out.text().includes(narrowQr)
        && out.text().includes(`${narrowWidth - 1} columns wide`)
        && out.text().includes(`needs ${narrowWidth}`)
        && err.text() === '',
      out.text());
  }

  // Human pair output follows the setup language while the payload remains byte-for-byte identical.
  {
    const zhHome = prepareHome(join(root, 'zh-pair'), 'foreground', 'zh-Hans');
    const out = writer();
    const err = writer();
    const zhPairingId = 'pair_zh_fixture';
    const zhQr = createQrPairingPayload({
      version: 3,
      brokerId: 'broker_public_fixture',
      pairingId: zhPairingId,
      publicKey: 'broker-public-key',
      transport: { kind: 'broker-url', url: 'https://devbox.tailnet.ts.net' },
    });
    const result = await runPairCommand({
      json: false,
      wait: false,
      brokerUrl: 'https://devbox.tailnet.ts.net',
      home: zhHome,
      invocation: 'cosy',
      stdout: out.output,
      stderr: err.output,
    }, {
      renderQr: async () => 'QR',
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/api/health')) return jsonResponse({ ok: true, product: 'cosyncing', machine: 'devbox' });
        if (url.endsWith('/api/transport/pairings') && method === 'POST') {
          return jsonResponse({
            ok: true,
            pairingId: zhPairingId,
            qr: zhQr,
            brokerPeerId: 'broker_public_fixture',
            expiresAt: '2026-07-17T00:05:00.000Z',
          }, 201);
        }
        return jsonResponse({ error: 'unexpected' }, 500);
      },
    });
    check('Chinese pair output labels the same selectable one-use payload as 配对链接',
      result.exitCode === 0
        && out.text().split('\n').includes(`配对链接: ${zhQr}`)
        && !out.text().includes('Pairing link:')
        && err.text() === '',
      out.text());
  }

  // Interactive "pair another device?" loop: one fresh offer per device, declining ends the session.
  {
    // Serves a distinct offer per POST so the loop must issue a new QR for every device.
    function loopFetch(peerIds: string[]) {
      const posts: string[] = [];
      const polled: string[] = [];
      const fetcher: OperatorFetch = async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/api/health')) return jsonResponse({ ok: true, product: 'cosyncing', machine: 'devbox' });
        if (url.endsWith('/api/transport/pairings') && method === 'POST') {
          const offerId = `pair_loop_${posts.length + 1}`;
          posts.push(offerId);
          return jsonResponse({
            ok: true,
            pairingId: offerId,
            qr: createQrPairingPayload({
              version: 3,
              brokerId: 'broker_public_fixture',
              pairingId: offerId,
              publicKey: 'broker-public-key',
              transport: { kind: 'broker-url', url: 'https://devbox.tailnet.ts.net' },
            }),
            brokerPeerId: 'broker_public_fixture',
            expiresAt: '2026-07-17T00:05:00.000Z',
          }, 201);
        }
        const match = /\/api\/transport\/pairings\/(pair_loop_\d+)$/.exec(url);
        if (match && method === 'GET') {
          const index = Number(match[1]!.slice('pair_loop_'.length)) - 1;
          polled.push(match[1]!);
          return jsonResponse({ ok: true, state: 'accepted', peerId: peerIds[index] });
        }
        return jsonResponse({ error: 'unexpected' }, 500);
      };
      return { fetcher, posts, polled };
    }

    // Accepts once, then declines: two devices, two offers, one summary.
    {
      const out = writer();
      const err = writer();
      const { fetcher, posts, polled } = loopFetch(['phone-1', 'tablet-2']);
      const answers = [true, false];
      const prompts: number[] = [];
      const result = await runPairCommand({
        json: false,
        wait: true,
        brokerUrl: 'https://devbox.tailnet.ts.net',
        clientLabel: 'Test phone',
        home,
        invocation: 'cosy',
        interactive: true,
        stdout: out.output,
        stderr: err.output,
      }, {
        fetch: fetcher,
        renderQr: async (payload) => `QR(${payload.slice(0, 12)})`,
        now: () => Date.parse('2026-07-17T00:00:00.000Z'),
        confirmAnother: async (paired) => { prompts.push(paired); return answers.shift() ?? false; },
      });
      check('pair --wait loops through a fresh offer per device and ends on decline',
        result.exitCode === 0 && result.detailCode === 'pairing-accepted'
          && posts.length === 2 && posts[0] !== posts[1]
          && polled.join(',') === 'pair_loop_1,pair_loop_2'
          && prompts.join(',') === '1,2'
          && out.text().includes('Paired device phone-1')
          && out.text().includes('Paired device tablet-2')
          && err.text() === '',
        JSON.stringify({ posts, polled, prompts, detailCode: result.detailCode }));
      check('pair loop summarises every device paired this session',
        out.text().includes('Paired 2 devices this session:')
          && out.text().includes('- phone-1 (Test phone)')
          && out.text().includes('- tablet-2 (Test phone)')
          && (out.text().match(/one-use/g) ?? []).length === 2,
        out.text());
      const tokenPath = brokerTokenPath(home);
      const actualToken = readBrokerToken(tokenPath);
      check('the multi-device loop still ends with exactly one browser-client token pointer, never the value',
        (out.text().match(/Authentication token file:/g) ?? []).length === 1
          && out.text().includes(`Authentication token file: ${tokenPath}`)
          && out.text().includes(`Read it: cat ${tokenPath}`)
          && !out.text().includes(actualToken),
        out.text());
    }

    // Declining immediately keeps today's single-offer contract.
    {
      const out = writer();
      const err = writer();
      const { fetcher, posts } = loopFetch(['phone-1']);
      let prompted = 0;
      const result = await runPairCommand({
        json: false,
        wait: true,
        brokerUrl: 'https://devbox.tailnet.ts.net',
        home,
        invocation: 'cosy',
        interactive: true,
        stdout: out.output,
        stderr: err.output,
      }, {
        fetch: fetcher,
        renderQr: async () => 'QR',
        now: () => Date.parse('2026-07-17T00:00:00.000Z'),
        confirmAnother: async () => { prompted += 1; return false; },
      });
      check('declining the first prompt pairs exactly one device with the unchanged exit contract',
        result.exitCode === 0 && result.detailCode === 'pairing-accepted'
          && posts.length === 1 && prompted === 1
          && out.text().includes('Paired device phone-1')
          && out.text().includes('Paired 1 device this session:')
          && err.text() === '',
        JSON.stringify({ posts, prompted, detailCode: result.detailCode }));
      const tokenPath = brokerTokenPath(home);
      check('a single-device wait loop also ends with the browser-client token pointer',
        out.text().includes(`Authentication token file: ${tokenPath}`) && out.text().includes(`Read it: cat ${tokenPath}`),
        out.text());
    }

    // --json --wait never prompts and stays a single parseable document.
    {
      const out = writer();
      const err = writer();
      const { fetcher, posts } = loopFetch(['phone-1', 'tablet-2']);
      let prompted = 0;
      const result = await runPairCommand({
        json: true,
        wait: true,
        brokerUrl: 'https://devbox.tailnet.ts.net',
        home,
        invocation: 'cosy',
        interactive: true,
        stdout: out.output,
        stderr: err.output,
      }, {
        fetch: fetcher,
        now: () => Date.parse('2026-07-17T00:00:00.000Z'),
        confirmAnother: async () => { prompted += 1; return true; },
      });
      let parsed: any;
      try { parsed = JSON.parse(out.text()); } catch { parsed = undefined; }
      check('pair --json --wait never prompts and emits one machine-parseable accepted document',
        result.exitCode === 0 && result.detailCode === 'pairing-accepted'
          && prompted === 0 && posts.length === 1
          && parsed?.state === 'accepted' && parsed.peerId === 'phone-1'
          && parsed.schemaVersion === 1 && parsed.tokenScope === 'full-broker-api-v1'
          && !/session|QR\(/.test(out.text()) && err.text() === '',
        JSON.stringify({ prompted, posts, text: out.text() }));
      const acceptedTokenPath = brokerTokenPath(home);
      const acceptedActualToken = readBrokerToken(acceptedTokenPath);
      check('pair --json --wait keeps the accepted document shape exact and never carries the browser-client token',
        parsed !== undefined
          && Object.keys(parsed).sort().join(',') === 'expiresAt,pairingId,peerId,schemaVersion,state,tokenScope'
          && !out.text().includes(acceptedActualToken)
          && !out.text().includes(acceptedTokenPath)
          && !/Token file|Read it: cat|browser|per-device/i.test(out.text()),
        out.text());
    }

    // --json without --wait is untouched by the loop refactor.
    {
      const out = writer();
      const err = writer();
      const { fetcher } = loopFetch(['phone-1']);
      let prompted = 0;
      const result = await runPairCommand({
        json: true,
        wait: false,
        brokerUrl: 'https://devbox.tailnet.ts.net',
        home,
        invocation: 'cosy',
        interactive: true,
        stdout: out.output,
        stderr: err.output,
      }, { fetch: fetcher, confirmAnother: async () => { prompted += 1; return true; } });
      let parsed: any;
      try { parsed = JSON.parse(out.text()); } catch { parsed = undefined; }
      check('pair --json without --wait still emits one created-offer document and never prompts',
        result.exitCode === 0 && result.detailCode === 'pairing-created' && prompted === 0
          && parsed?.pairingId === 'pair_loop_1' && typeof parsed.qr === 'string'
          && parsed.brokerUrl === 'https://devbox.tailnet.ts.net',
        out.text());
      const createdTokenPath = brokerTokenPath(home);
      const createdActualToken = readBrokerToken(createdTokenPath);
      check('pair --json (no --wait) keeps the created document shape exact and never carries the browser-client token',
        parsed !== undefined
          && Object.keys(parsed).sort().join(',') === 'brokerUrl,expiresAt,pairingId,qr,schemaVersion,tokenScope'
          && !out.text().includes(createdActualToken)
          && !out.text().includes(createdTokenPath)
          && !/Token file|Read it: cat|browser|per-device/i.test(out.text()),
        out.text());
    }
  }

  // An unreachable broker is diagnosed before POST, with exact foreground guidance.
  {
    let calls = 0;
    const out = writer();
    const err = writer();
    const result = await runPairCommand({
      json: false,
      wait: false,
      home,
      invocation: 'cosy',
      stdout: out.output,
      stderr: err.output,
    }, {
      fetch: async () => { calls += 1; throw new Error('stopped'); },
    });
    check('pair on a stopped foreground broker creates no offer and prints the exact start command',
      result.detailCode === 'broker-unreachable' && calls === 1
        && err.text().includes('Broker mode: foreground') && err.text().includes('cosy broker'));
  }

  // An unconfigured machine never touches HTTP and points directly to setup.
  {
    let calls = 0;
    const out = writer();
    const err = writer();
    const result = await runPairCommand({
      json: false,
      wait: false,
      home: join(root, 'unconfigured'),
      invocation: 'cosyncing',
      stdout: out.output,
      stderr: err.output,
    }, { fetch: async () => { calls += 1; return jsonResponse({}); } });
    check('pair on an unconfigured broker creates no state and prints setup guidance',
      result.detailCode === 'setup-not-committed' && calls === 0 && err.text().includes('cosyncing setup'));
  }

  // Device output is public-only and revocation calls the live authenticated route once.
  {
    const listOut = writer();
    const listErr = writer();
    const revokeOut = writer();
    const revokeErr = writer();
    const requests: Array<{ url: string; method: string }> = [];
    const fetcher: OperatorFetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method });
      if (url.endsWith('/api/health')) return jsonResponse({ ok: true, product: 'cosyncing', machine: 'devbox' });
      if (url.endsWith('/api/transport/peers') && method === 'GET') {
        return jsonResponse({ ok: true, peers: [{
          peerId: 'phone-1',
          label: 'Test phone',
          acceptedAt: '2026-07-17T00:00:00.000Z',
          peerTokenHash: 'must-not-render',
          dataKey: 'must-not-render',
        }] });
      }
      if (url.endsWith('/api/transport/peers/phone-1') && method === 'DELETE') {
        return jsonResponse({ ok: true, revoked: true });
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    };
    const listed = await runDevicesListCommand({
      json: true,
      home,
      invocation: 'cosy',
      stdout: listOut.output,
      stderr: listErr.output,
    }, { fetch: fetcher });
    const revoked = await runDevicesRevokeCommand({
      peerId: 'phone-1',
      yes: true,
      json: false,
      interactive: false,
      home,
      invocation: 'cosy',
      stdout: revokeOut.output,
      stderr: revokeErr.output,
    }, { fetch: fetcher });
    check('devices list exposes public identity only and states the full-access boundary',
      listed.exitCode === 0 && listOut.text().includes('phone-1')
        && !listOut.text().includes('must-not-render') && listErr.text() === '');
    check('devices revoke --yes calls the authenticated delete route and reports immediate invalidation',
      revoked.exitCode === 0
        && requests.some((request) => request.method === 'DELETE' && request.url.endsWith('/api/transport/peers/phone-1'))
        && revokeOut.text().includes('invalid immediately') && revokeErr.text() === '');
  }

  // CLI grammar carries the actual invocation name and explicit confirmation flags.
  {
    let pairOptions: any;
    let revokeOptions: any;
    let setupOptions: any;
    const out = writer();
    const err = writer();
    const pairExit = await runCli([
      'pair',
      '--broker-url',
      'https://cosy.example.com',
      '--label',
      'Phone',
      '--wait',
    ], {
      invocation: 'cosy',
      stdout: out.output,
      stderr: err.output,
      runPair: async (options) => { pairOptions = options; return { exitCode: 0 }; },
    });
    const revokeExit = await runCli(['devices', 'revoke', 'phone-1', '--yes', '--json'], {
      invocation: 'cosy',
      stdout: out.output,
      stderr: err.output,
      runDevicesRevoke: async (options) => { revokeOptions = options; return { exitCode: 0 }; },
    });
    const setupExit = await runCli([
      'setup',
      '--yes',
      '--accept-managed-runtime-ownership',
      '--enable-tailscale-serve',
    ], {
      invocation: 'cosy',
      stdout: out.output,
      stderr: err.output,
      runSetup: async (options) => { setupOptions = options; return { exitCode: 0 }; },
    });
    check('CLI parses explicit Tailscale setup, pair, and revoke without a shared-token argument surface',
      pairExit === 0 && revokeExit === 0 && setupExit === 0
        && pairOptions.brokerUrl === 'https://cosy.example.com'
        && pairOptions.clientLabel === 'Phone' && pairOptions.wait === true && pairOptions.invocation === 'cosy'
        && revokeOptions.peerId === 'phone-1' && revokeOptions.yes === true && revokeOptions.json === true
        && setupOptions.enableTailscaleServe === true
        && !JSON.stringify({ pairOptions, revokeOptions, setupOptions }).match(/shared.?token/i));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ── Real TLS: the shipped direct probe against a real HTTPS server ──
// Everything above injects a fake directProbe, so none of it executes the https.request path, presents a
// real SNI value, or validates a real certificate chain. This block runs the SHIPPED probe against a real
// server with a real certificate, because "we never disable TLS validation" is only worth as much as the
// evidence that validation actually rejects something.
{
  const openssl = Bun.which('openssl');
  if (!openssl) {
    check('real-TLS direct probe coverage requires openssl', false,
      'openssl not found; this evidence cannot be produced on this host');
  } else {
    const tlsHome = mkdtempSync(join(tmpdir(), 'cosyncing-serve-tls-'));
    const HOST = 'fixture.tailnet.ts.net';
    const path$ = (name: string): string => join(tlsHome, name);
    const run = async (args: string[]): Promise<boolean> => {
      const proc = Bun.spawn([openssl, ...args], { cwd: tlsHome, stdout: 'pipe', stderr: 'pipe' });
      return (await proc.exited) === 0;
    };
    await Bun.write(path$('ext.cnf'), `subjectAltName=DNS:${HOST}\n`);
    const built = await run(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'ca.key', '-out', 'ca.pem',
      '-days', '1', '-nodes', '-subj', '/CN=cosyncing-test-ca'])
      && await run(['req', '-newkey', 'rsa:2048', '-keyout', 'srv.key', '-out', 'srv.csr', '-nodes',
        '-subj', `/CN=${HOST}`])
      && await run(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
        '-CAcreateserial', '-out', 'srv.pem', '-days', '1', '-extfile', 'ext.cnf']);

    if (!built) {
      check('real-TLS fixture certificates build', false, 'openssl could not produce the fixture chain');
    } else {
      const { createServer } = await import('node:https');
      const seenHost: string[] = [];

      const server = createServer({
        key: readFileSync(path$('srv.key')),
        cert: readFileSync(path$('srv.pem')),
      }, (request, response) => {
        seenHost.push(String(request.headers.host ?? ''));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, product: 'cosyncing', machine: 'devbox' }));
      });

      await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
      const port = (server.address() as { port: number }).port;

      // The probe runs in a child so NODE_EXTRA_CA_CERTS is set before TLS initialises. Trust is granted
      // ONLY through that variable; nothing here lowers rejectUnauthorized, which has no option to lower.
      const driver = path$('drive.ts');
      await Bun.write(driver, [
        `import { probeAdvertisedEndpointOnce } from '${resolve('packages/typescript/broker/src/installation/tailscale-serve.ts')}';`,
        `const [hostname, port] = [process.argv[2], Number(process.argv[3])];`,
        `const probe = await probeAdvertisedEndpointOnce({`,
        `  context: { fetchJson: async () => ({ status: 'unreachable' }) } as never,`,
        `  advertisedUrl: 'https://' + hostname + ':' + port,`,
        `  fallbackAddresses: ['127.0.0.1'],`,
        `});`,
        `console.log(JSON.stringify(probe));`,
      ].join('\n'));

      const drive = async (hostname: string, trust: boolean): Promise<{
        status?: string;
        json?: unknown;
        childExitCode?: number;
        childStderr?: string;
      }> => {
        const proc = Bun.spawn(['bun', 'run', driver, hostname, String(port)], {
          env: { ...process.env, ...(trust ? { NODE_EXTRA_CA_CERTS: path$('ca.pem') } : {}) },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [out, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        try {
          return JSON.parse(out.trim().split('\n').pop() ?? '{}');
        } catch {
          return { childExitCode: exitCode, childStderr: stderr.trim() };
        }
      };

      const trusted = await drive(HOST, true);
      check('the shipped probe completes a real TLS handshake and reads the broker identity',
        trusted.status === 'ok'
          && (trusted.json as { machine?: string } | undefined)?.machine === 'devbox',
        JSON.stringify(trusted));
      check('it sends the advertised hostname as the Host header, never the address literal',
        seenHost.length > 0 && seenHost.every((value) => value.startsWith(HOST)),
        `host=${seenHost.join(',')}`);

      const untrusted = await drive(HOST, false);
      check('an untrusted chain is refused rather than bypassed',
        untrusted.status === 'unreachable', JSON.stringify(untrusted));

      // The connection above is to 127.0.0.1 while the certificate covers only the advertised hostname.
      // Succeeding for HOST and failing for a name the certificate does not cover is the proof that
      // `servername` drives BOTH the SNI sent and the identity the chain is validated against — the
      // server side cannot supply it, because Bun's node:https emits neither secureConnection nor a
      // servername, and honours no SNICallback.
      const wrongName = await drive('other.tailnet.ts.net', true);
      check('a certificate that does not cover the advertised hostname is refused',
        wrongName.status === 'unreachable', JSON.stringify(wrongName));
      check('certificate validation is bound to the advertised hostname, not the connected address',
        trusted.status === 'ok' && wrongName.status === 'unreachable',
        `sameAddress=127.0.0.1 trusted(${HOST})=${trusted.status} wrongName=${wrongName.status}`);
      await new Promise<void>((closed) => server.close(() => closed()));
    }
    rmSync(tlsHome, { recursive: true, force: true });
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} Tailscale pairing checks passed`);
if (failed.length > 0) process.exitCode = 1;
