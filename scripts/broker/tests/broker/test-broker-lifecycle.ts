#!/usr/bin/env bun
/** Deterministic lifecycle, repair, signed upgrade/rollback, and owned-uninstall acceptance. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PI_BRIDGE_EMBEDDED_SHA256,
  PI_BRIDGE_EMBEDDED_SOURCE,
} from '../../../../packages/typescript/adapters/pi/src/index.ts';
import type {
  SetupDiagnosisContext,
  SetupHttpProbe,
} from '../../../../packages/typescript/adapter-api/src/index.ts';
import {
  collectLifecycleStatus,
  inspectRepair,
  inspectUninstall,
  readServiceLogs,
  runRepair,
  runServiceCommand,
  runUninstall,
  renderLifecycleStatus,
  type LifecycleStatusReport,
} from '../../../../packages/typescript/broker/src/broker-lifecycle.ts';
import { cliMessages } from '../../../../packages/typescript/broker/src/cli-i18n.ts';
import { PRODUCT_IDENTITY } from '../../../../packages/typescript/adapter-api/src/index.ts';
import { BUILD_INFO, buildFingerprint } from '../../../../packages/typescript/broker/src/build-info.ts';
import { createSetupDiagnosisContext } from '../../../../packages/typescript/broker/src/diagnosis-context.ts';
import { runCli } from '../../../../packages/typescript/broker/src/cli.ts';
import {
  localizeCliStatusValue,
  ZH_STATUS_VALUES,
  type CliStatusValue,
} from '../../../../packages/typescript/broker/src/cli-i18n.ts';
import { defaultBrokerConfig, writeBrokerConfig, type BrokerConfig } from '../../../../packages/typescript/broker/src/configuration.ts';
import {
  ensureInstallationCredentials,
  readBrokerToken,
  readPiIntegration,
} from '../../../../packages/typescript/broker/src/credentials.ts';
import {
  committedInstallState,
  inspectInstallState,
  writeInstallState,
  type InstalledResourceRecord,
} from '../../../../packages/typescript/broker/src/install-state.ts';
import {
  releaseManifestForTests,
  runUpgrade,
  type ReleaseArtifact,
  type ReleaseManifest,
  type UpgradeServiceController,
} from '../../../../packages/typescript/broker/src/release-upgrade.ts';
import {
  atomicWriteOwnerOnly,
  ensureOwnerOnlyDirectory,
} from '../../../../packages/typescript/broker/src/secure-files.ts';
import {
  SYSTEMD_SERVICE_NAME,
  type DurableServiceProvider,
  type DurableServiceStatus,
  type ServiceCommandResult,
  type ServiceCommandRunner,
} from '../../../../packages/typescript/broker/src/service-manager.ts';
import {
  readCodexDaemonOwnership,
  readSetupState,
  setCodexDaemonOwnership,
  writeSetupState,
} from '../../../../packages/typescript/broker/src/setup-state.ts';
import { decideCodexDaemonOwnership } from '../../../../packages/typescript/adapters/codex/src/index.ts';
import type { CodexDaemonStatus } from '../../../../packages/typescript/broker/src/broker-lifecycle.ts';
import {
  TAILSCALE_SERVE_OWNERSHIP_MARKER,
  TAILSCALE_SERVE_RESOURCE_ID,
  tailscaleRouteReceiptTarget,
  type TailscaleServeInspection,
  type TailscaleServeRouteProvider,
} from '../../../../packages/typescript/broker/src/tailscale-serve.ts';
import {
  AGENT_SKILL_SHA256,
  AGENT_SKILL_SOURCE,
  agentSkillTargets,
} from '../../../../packages/typescript/broker/src/agent-skill.ts';
import {
  OPENCODE_SHIM_BLOCK_BEGIN,
  OPENCODE_SHIM_RC_RESOURCE_IDS,
  OPENCODE_SHIM_RESOURCE_ID,
  OPENCODE_SHIM_SHA256,
  OPENCODE_SHIM_SOURCE,
  installRcBlock,
  opencodeShimPort,
  opencodeShimShellPath,
} from '../../../../packages/typescript/broker/src/opencode-shim.ts';

function readFrozenTextFixture(path: string): string {
  const asset = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (asset.schemaVersion !== 1 || asset.release !== '0.1.0'
    || !Array.isArray(asset.lines) || !asset.lines.every((line) => typeof line === 'string')
    || typeof asset.trailingNewline !== 'boolean') throw new Error(`invalid frozen text fixture: ${path}`);
  return `${asset.lines.join('\n')}${asset.trailingNewline ? '\n' : ''}`;
}

// The repair fixture comes from the frozen released asset, never from the production identity constant.
const PI_BRIDGE_V010_FIXTURE = readFrozenTextFixture(join(
  import.meta.dir,
  '../../../../packages/typescript/adapters/pi/assets/legacy/cosyncing-bridge-v0.1.0.json',
));

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const BUILD = Object.freeze({
  schemaVersion: 2 as const,
  version: '1.0.0',
  commit: '1111111',
  buildDate: '2026-07-17T00:00:00.000Z',
  target: 'linux-x64',
  distribution: 'native' as const,
  packaged: true,
  dirty: false,
  schemaVersions: BUILD_INFO.schemaVersions,
  contract: BUILD_INFO.contract,
});

interface NetworkState {
  route: 'missing' | 'desired' | 'conflict' | 'funnel-conflict';
  available: boolean;
}

function tailscaleInspection(network: NetworkState, config: BrokerConfig): TailscaleServeInspection {
  return {
    schemaVersion: 1,
    topology: network.available ? 'native-linux' : 'missing',
    backend: network.available ? 'running' : 'missing',
    ...(network.available ? { executablePath: '/usr/bin/tailscale' } : {}),
    ...(network.available ? { dnsName: 'fixture.tailnet.ts.net', advertisedUrl: 'https://fixture.tailnet.ts.net' } : {}),
    httpsCapability: network.available ? 'ready' : 'unavailable',
    route: network.available ? network.route : 'unavailable',
    desiredTarget: config.broker.internalUrl,
    detailCode: `tailscale-${network.available ? network.route : 'missing'}`,
    summary: 'fixture Tailscale state',
  };
}

function contextFor(options: {
  userHome: string;
  config: BrokerConfig;
  network: NetworkState;
  health?: boolean;
}): SetupDiagnosisContext {
  return {
    effects: 'forbidden',
    platform: 'linux',
    arch: 'x64',
    env: { HOME: options.userHome, PATH: '/usr/bin:/bin' },
    homeDir: options.userHome,
    resolveExecutable(command) {
      if (command === 'tailscale' && options.network.available) return '/usr/bin/tailscale';
      if (command === 'systemctl') return '/usr/bin/systemctl';
      if (command === 'journalctl') return '/usr/bin/journalctl';
      return undefined;
    },
    inspectPath: (path) => ({ status: 'missing', readable: false, displayPath: path }),
    readText: () => ({ ok: false, reason: 'missing' }),
    readPackageVersion: () => undefined,
    async runReadOnly(_path, args) {
      if (args[0] === 'status') {
        return { status: 'ok', exitCode: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'fixture.tailnet.ts.net.' } }), stderr: '' };
      }
      const serve = options.network.route === 'missing' ? {} : {
        TCP: { 443: { HTTPS: true } },
        Web: { 'fixture.tailnet.ts.net:443': { Handlers: { '/': { Proxy: options.network.route === 'conflict' ? 'http://127.0.0.1:9999' : options.config.broker.internalUrl } } } },
        ...(options.network.route === 'funnel-conflict' ? { AllowFunnel: { 'fixture.tailnet.ts.net:443': true } } : {}),
      };
      return { status: 'ok', exitCode: 0, stdout: JSON.stringify(serve), stderr: '' };
    },
    async fetchJson(url) {
      const path = new URL(url).pathname;
      if (path === '/api/health') {
        return options.health === false
          ? { status: 'unreachable' }
          : { status: 'ok', statusCode: 200, json: { ok: true, product: 'cosyncing', version: BUILD.version, commit: BUILD.commit, buildFingerprint: buildFingerprint(BUILD), machine: options.config.broker.machineLabel } };
      }
      if (path === '/api/agents') return { status: 'ok', statusCode: 200, json: [
        { id: 'codex', displayName: 'Codex', canCreateSession: false, syncEnabled: true },
        { id: 'opencode', displayName: 'OpenCode', canCreateSession: true },
        { id: 'pi', displayName: 'Pi', canCreateSession: false },
        { id: 'claude', displayName: 'Claude Code', canCreateSession: true },
      ] };
      if (path === '/api/sessions') return { status: 'ok', statusCode: 200, json: [
        { id: 'one', status: 'active' }, { id: 'two', status: 'idle' },
      ] };
      if (path === '/api/agent-runtime-updates') return { status: 'ok', statusCode: 200, json: { updates: [{ pending: true }, { pending: false }] } };
      return { status: 'unreachable' };
    },
    async probeTcp() { return 'closed'; },
    displayPath: (path) => path,
  };
}

class FakeService implements DurableServiceProvider {
  readonly id = 'systemd' as const;
  readonly serviceName = SYSTEMD_SERVICE_NAME;
  readonly definitionPath: string;
  readonly environmentPath: string;
  readonly persistenceTarget = 'systemd-user-linger:fixture';
  active = false;
  enabled = false;
  lingering = false;
  supported = true;
  calls: string[] = [];
  // Mirrors both real providers: the unit/plist lives in a SHARED system root (systemd's user directory,
  // ~/Library/LaunchAgents) while the environment file it points at lives in the state home's own
  // `service/` directory. Uninstall may empty the second and must never touch the first.
  constructor(root: string, stateHome: string) {
    this.definitionPath = join(root, 'service', SYSTEMD_SERVICE_NAME);
    this.environmentPath = join(stateHome, 'service', 'broker.env');
  }
  logsCommand(request: { follow: boolean; lines: number }): readonly string[] {
    return request.follow
      ? ['/usr/bin/journalctl', '--user', '-u', SYSTEMD_SERVICE_NAME, '-f']
      : ['/usr/bin/journalctl', '--user', '-u', SYSTEMD_SERVICE_NAME, '-n', String(request.lines), '--no-pager'];
  }
  expectedDefinition(): string { return '[Service]\nExecStart=/fixture/cosyncing\n'; }
  expectedEnvironment(): string { return 'COSYNCING_HOME="/fixture"\n'; }
  async inspect(): Promise<DurableServiceStatus> {
    const state = (path: string, expected: string): 'missing' | 'current' | 'drifted' =>
      !existsSync(path) ? 'missing' : readFileSync(path, 'utf8') === expected ? 'current' : 'drifted';
    return {
      provider: 'systemd', supported: this.supported,
      definition: state(this.definitionPath, this.expectedDefinition()),
      environment: state(this.environmentPath, this.expectedEnvironment()),
      enabled: this.enabled ? 'enabled' : 'disabled',
      active: this.active ? 'active' : 'inactive',
      lingering: this.lingering ? 'enabled' : 'disabled',
    };
  }
  async installDefinition(): Promise<void> {
    this.calls.push('install');
    atomicWriteOwnerOnly(this.definitionPath, this.expectedDefinition());
    atomicWriteOwnerOnly(this.environmentPath, this.expectedEnvironment());
    this.enabled = true;
  }
  async reloadDefinition(): Promise<void> { this.calls.push('reload'); }
  async setEnabled(value: boolean): Promise<void> { this.enabled = value; }
  async enableLingering(): Promise<void> { this.lingering = true; }
  async disableLingering(): Promise<void> { this.lingering = false; }
  async start(): Promise<void> { this.calls.push('start'); this.active = true; }
  async stop(): Promise<void> { this.calls.push('stop'); this.active = false; }
  async restart(): Promise<void> { this.calls.push('restart'); this.active = true; }
  async uninstall(): Promise<void> {
    this.calls.push('uninstall');
    this.active = false;
    this.enabled = false;
    for (const path of [this.definitionPath, this.environmentPath]) if (existsSync(path)) unlinkSync(path);
  }
}

class FakeTailscale implements TailscaleServeRouteProvider {
  calls: string[] = [];
  constructor(readonly network: NetworkState, readonly config: BrokerConfig) {}
  async inspect(): Promise<TailscaleServeInspection> { return tailscaleInspection(this.network, this.config); }
  async registerPrivateHttpsRoot(): Promise<void> { this.calls.push('register'); this.network.route = 'desired'; }
  async removePrivateHttpsRoot(): Promise<void> { this.calls.push('remove'); this.network.route = 'missing'; }
}

interface Machine {
  root: string;
  userHome: string;
  home: string;
  cache: string;
  binary: string;
  alias: string;
  piAgentDir: string;
  claudeSettings: string;
  config: BrokerConfig;
  network: NetworkState;
  context: SetupDiagnosisContext;
  service: FakeService;
  tailscale: FakeTailscale;
}

function machine(options: {
  service?: boolean;
  tailscale?: boolean;
  resources?: InstalledResourceRecord[];
  binaryHash?: boolean;
} = {}): Machine {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-broker-lifecycle-'));
  const userHome = join(root, 'user');
  const home = join(userHome, '.cosyncing');
  const cache = join(userHome, '.cache', 'cosyncing');
  ensureOwnerOnlyDirectory(home);
  ensureOwnerOnlyDirectory(cache);
  const config = defaultBrokerConfig();
  config.broker.machineLabel = 'fixture-machine';
  config.broker.advertisedUrl = 'https://fixture.tailnet.ts.net';
  writeBrokerConfig(config, home);
  ensureInstallationCredentials({ home, internalUrl: config.broker.internalUrl });
  writeSetupState({
    managedRuntimeAcknowledgedAt: '2026-07-17T00:00:00.000Z',
    serviceChoice: options.service ? 'systemd' : 'foreground',
    tailscaleServeRequested: options.tailscale === true,
  }, home);
  const binary = join(home, 'bin', 'cosyncing');
  const alias = join(home, 'bin', 'cosy');
  atomicWriteOwnerOnly(binary, 'old-binary-v1', { mode: 0o700 });
  symlinkSync('cosyncing', alias);
  const baseResources: InstalledResourceRecord[] = [
    { id: 'broker-binary', kind: 'binary', target: binary, ownership: { proof: options.binaryHash ? 'package-hash' : 'receipt', ...(options.binaryHash ? { installedSha256: hash('old-binary-v1') } : {}) } },
    { id: 'broker-alias', kind: 'alias', target: alias, ownership: { proof: 'receipt' } },
  ];
  const state = committedInstallState('2026-07-17T00:00:00.000Z');
  state.resources = [...baseResources, ...(options.resources ?? [])];
  writeInstallState(state, home);
  const network = { route: options.tailscale ? 'desired' as const : 'missing' as const, available: true };
  const context = contextFor({ userHome, config, network });
  const service = new FakeService(root, home);
  const tailscale = new FakeTailscale(network, config);
  const piAgentDir = join(userHome, '.pi', 'agent');
  const claudeSettings = join(userHome, '.claude', 'settings.json');
  return { root, userHome, home, cache, binary, alias, piAgentDir, claudeSettings, config, network, context, service, tailscale };
}

function baseOptions(m: Machine) {
  return {
    home: m.home,
    cacheRoot: m.cache,
    buildInfo: BUILD,
    executablePath: m.binary,
    context: m.context,
    piAgentDir: m.piAgentDir,
    claudeSettingsPath: m.claudeSettings,
    systemdProviderFactory: () => m.service,
    tailscaleProviderFactory: () => m.tailscale,
  };
}

function installAgentSkills(m: Machine): ReturnType<typeof agentSkillTargets> {
  const targets = agentSkillTargets(m.context);
  for (const target of targets) atomicWriteOwnerOnly(target.path, AGENT_SKILL_SOURCE, { mode: 0o600 });
  const install = inspectInstallState(m.home);
  if (!install.committed) throw new Error('fixture install missing');
  install.state.resources.push(...targets.map((target): InstalledResourceRecord => ({
    id: target.resourceId,
    kind: 'agent-integration',
    target: target.path,
    ownership: { proof: 'package-hash', installedSha256: AGENT_SKILL_SHA256 },
  })));
  writeInstallState(install.state, m.home);
  writeSetupState({ ...readSetupState(m.home), agentSkillRequested: true }, m.home);
  return targets;
}

const cleanup: string[] = [];
try {
  // Read-only status plus service lifecycle and redacted logs.
  {
    const m = machine({ service: true, binaryHash: true }); cleanup.push(m.root);
    await m.service.installDefinition();
    await m.service.start();
    // ── status on a host whose MagicDNS will not resolve ──
    // Drives collectLifecycleStatus itself: the advertised NAME never connects, `tailscale status --json`
    // supplies this node's addresses, and the endpoint must still report ready — but only for THIS broker.
    {
      const ADDRESSES = ['100.64.0.1', 'fd7a:115c:a1e0::1'];
      const brokenDns = {
        ...m.context,
        resolveExecutable(command: string) {
          if (command === 'tailscale') return '/usr/bin/tailscale';
          return m.context.resolveExecutable(command);
        },
        async runReadOnly(path: string, args: readonly string[]) {
          if (path === '/usr/bin/tailscale' && args[0] === 'status') {
            return { status: 'ok' as const, exitCode: 0, stderr: '', stdout: JSON.stringify({
              BackendState: 'Running',
              Self: { DNSName: 'fixture.tailnet.ts.net.', TailscaleIPs: ADDRESSES },
            }) };
          }
          return m.context.runReadOnly(path, args);
        },
        async fetchJson(url: string, headers?: Readonly<Record<string, string>>, timeoutMs?: number) {
          if (url.startsWith('https://fixture.tailnet.ts.net')) return { status: 'unreachable' as const };
          return m.context.fetchJson(url, headers, timeoutMs);
        },
      };
      const contacted: string[] = [];
      const statusVia = async (machine: string) => collectLifecycleStatus({
        ...baseOptions(m),
        context: brokenDns,
        advertisedDirectProbe: async ({ address }) => {
          contacted.push(address);
          return { status: 'ok', statusCode: 200, json: { ok: true, product: 'cosyncing', machine } };
        },
      });
      const readyViaAddress = await statusVia('fixture-machine');
      check('status reports the advertised endpoint ready through this node address when MagicDNS fails',
        readyViaAddress.endpoints.advertised === 'ready' && contacted[0] === ADDRESSES[0],
        `${readyViaAddress.endpoints.advertised} contacted=${contacted.join(',')}`);
      const foreign = await statusVia('another-machine');
      check('status reports identity-mismatch when the address answers as a different machine',
        foreign.endpoints.advertised === 'identity-mismatch',
        foreign.endpoints.advertised);
      // Loopback must never be given the fallback: it needs no name resolution and an address retry there
      // would be probing something the internal URL never pointed at.
      check('the internal loopback endpoint is unaffected by the advertised fallback',
        readyViaAddress.endpoints.internal === 'ready',
        readyViaAddress.endpoints.internal);
    }

    const status = await collectLifecycleStatus(baseOptions(m));
    const serialized = JSON.stringify(status);
    check('status summarizes service/endpoints/agents/sessions/updates without credentials',
      status.ok && status.service.active === 'active' && status.agents.length === 4
        && status.agents.find((agent) => agent.id === 'codex')?.canCreateSession === false
        && status.agents.find((agent) => agent.id === 'codex')?.syncEnabled === true
        && status.agents.find((agent) => agent.id === 'opencode')?.canCreateSession === true
        && typeof status.sessions === 'object' && status.sessions?.total === 2
        && typeof status.updates === 'object' && status.updates?.pending === 1
        && !serialized.includes(readBrokerToken(join(m.home, 'secrets', 'broker-token'))));

    // A roster too large to read is NOT an unavailable broker. It reported as one until now: the read
    // failed, the count became null, and the presenter rendered "broker unavailable" about a broker that
    // was answering correctly — a lie that got likelier the more sessions the operator accumulated.
    {
      const sessionsAnswering = async (probe: SetupHttpProbe) => collectLifecycleStatus({
        ...baseOptions(m),
        context: {
          ...m.context,
          async fetchJson(url: string, headers?: Readonly<Record<string, string>>, timeoutMs?: number, maxBytes?: number) {
            if (new URL(url).pathname === '/api/sessions') return probe;
            return m.context.fetchJson(url, headers, timeoutMs, maxBytes);
          },
        },
      });
      const tooLarge = await sessionsAnswering({ status: 'invalid-response', statusCode: 200 });
      check('a roster too large to read reports unreadable rather than an unavailable broker',
        tooLarge.sessions === 'unreadable', String(tooLarge.sessions));
      check('the unreadable roster never renders as broker unavailable in either locale',
        !renderLifecycleStatus(tooLarge, 'en').includes('Sessions: broker unavailable')
          && !renderLifecycleStatus(tooLarge, 'zh-Hans').includes('会话：broker 不可用'),
        renderLifecycleStatus(tooLarge, 'en').split('\n').find((line) => line.startsWith('Sessions:')));
      // The distinction is only worth anything if the genuine case still reads unavailable.
      const silent = await sessionsAnswering({ status: 'unreachable' });
      check('a broker that does not answer at all still reports unavailable',
        silent.sessions === null
          && renderLifecycleStatus(silent, 'en').includes('Sessions: broker unavailable'),
        String(silent.sessions));
    }

    // The raised ceiling is production wiring, not a default. Without it a real roster fails the moment it
    // passes the shared 256 KiB probe limit, which 2.4k sessions already do three times over.
    {
      const requested = new Map<string, { maxBytes?: number; timeoutMs?: number }>();
      await collectLifecycleStatus({
        ...baseOptions(m),
        context: {
          ...m.context,
          async fetchJson(url: string, headers?: Readonly<Record<string, string>>, timeoutMs?: number, maxBytes?: number) {
            requested.set(new URL(url).pathname, { maxBytes, timeoutMs });
            return m.context.fetchJson(url, headers, timeoutMs, maxBytes);
          },
        },
      });
      const roster = requested.get('/api/sessions');
      check('the roster read asks for a body ceiling far above the 256 KiB probe default',
        (roster?.maxBytes ?? 0) >= 8 * 1024 * 1024,
        `maxBytes=${roster?.maxBytes}`);
      // The allowance is the ROSTER's, not the status command's. `status` reads three authenticated
      // endpoints concurrently, so granting all of them the roster ceiling would let one invocation
      // accept three times it — for two documents whose size is fixed by the protocol and that could
      // never have needed it. Every endpoint below must therefore ask for nothing at all, which is
      // what leaves it on the shared probe default.
      // `/api/health` names the 3s probe deadline explicitly, which is the default value spelled out
      // rather than an expanded one, so the test asks whether an endpoint EXCEEDS the defaults.
      for (const path of ['/api/health', '/api/agents', '/api/agent-runtime-updates']) {
        const asked = requested.get(path);
        check(`${path} keeps the probe defaults instead of inheriting the roster allowance`,
          asked !== undefined
            && asked.maxBytes === undefined
            && (asked.timeoutMs === undefined || asked.timeoutMs <= 3_000),
          `observed=${JSON.stringify(asked)} roster=${JSON.stringify(roster)}`);
      }
    }

    // The wiring above proves what the roster read ASKS for. This proves the shipped context honours it,
    // against a real socket rather than a fake, because everything above would still pass if
    // `fetchJson` accepted the argument and ignored it.
    {
      const rows = Array.from({ length: 12_000 }, (_, index) => ({ id: `session-${index}`, status: 'idle' }));
      const body = JSON.stringify({ sessions: rows });
      const server = Bun.serve({
        port: 0,
        fetch: () => new Response(body, { headers: { 'content-type': 'application/json' } }),
      });
      try {
        const url = `http://127.0.0.1:${server.port}/api/sessions`;
        const real = createSetupDiagnosisContext();
        check('the roster fixture is genuinely larger than the shared probe ceiling',
          body.length > 256 * 1024, `bytes=${body.length}`);
        const atProbeDefault = await real.fetchJson(url, {}, 5_000);
        check('the probe default still refuses an oversized body, and calls it answered not unreachable',
          atProbeDefault.status === 'invalid-response', atProbeDefault.status);
        const atRosterCeiling = await real.fetchJson(url, {}, 5_000, 16 * 1024 * 1024);
        const parsed = atRosterCeiling.status === 'ok' && atRosterCeiling.json
          && typeof atRosterCeiling.json === 'object'
          ? (atRosterCeiling.json as { sessions?: unknown[] }).sessions
          : undefined;
        check('the shipped context reads the whole roster when the caller raises the ceiling',
          atRosterCeiling.status === 'ok' && parsed?.length === rows.length,
          `${atRosterCeiling.status} rows=${parsed?.length}`);
      } finally {
        server.stop(true);
      }
    }

    // `maxBytes` is a request, not a grant. These drive the shipped context against an endpoint that
    // never stops sending and never declares a length, so nothing but the streaming ceiling can end
    // the read.
    //
    // The endpoint never ends its response and never declares a length, and it produces bytes only
    // when pulled. That makes both halves of the contract observable without trusting a counter that
    // measures the wrong side: the stream's own `cancel` fires exactly when the reader gives up, and
    // `produced` counts only what the reader actually pulled, because an unread stream stops being
    // pulled. Status alone can never prove this — a read with no ceiling at all ends in
    // `invalid-response` too, just after swallowing every byte first. Elapsed time separates the two
    // remaining explanations: a ceiling returns in milliseconds, an unbounded read runs to the
    // timeout and comes back `unreachable`.
    {
      const MIB = 1024 * 1024;
      const HARD_LIMIT = 16 * MIB;
      const TIMEOUT_MS = 10_000;
      const payload = new Uint8Array(128 * 1024).fill(0x20);
      const streamProbe = async (maxBytes?: number): Promise<{
        status: string;
        produced: number;
        elapsedMs: number;
      }> => {
        let produced = 0;
        const server = Bun.serve({
          port: 0,
          fetch: () => new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue(payload);
                produced += payload.length;
                // Paced, so an unbounded read cannot exhaust this host's memory before the timeout
                // catches it, and so elapsed time tracks bytes read rather than scheduler luck.
                await Bun.sleep(1);
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        });
        try {
          const started = Bun.nanoseconds();
          const probe = await createSetupDiagnosisContext()
            .fetchJson(`http://127.0.0.1:${server.port}/api/sessions`, {}, TIMEOUT_MS, maxBytes);
          // Sampled here and never later: the server keeps producing into its own buffers after the
          // reader has gone, so anything read after this line measures the server, not the ceiling.
          return { status: probe.status, produced, elapsedMs: (Bun.nanoseconds() - started) / 1e6 };
        } finally {
          server.stop(true);
        }
      };

      // The fixture must declare no length, or every assertion below exercises the wrong branch: a
      // declared length ends the read before the streaming ceiling comes into play at all. Checked on
      // a server of its own, because a second reader on the shared one keeps being pulled after its
      // body is cancelled and silently inflates the byte counter the measurements depend on.
      {
        const framingServer = Bun.serve({
          port: 0,
          fetch: () => new Response(
            new ReadableStream({
              // Paced like the measured fixture: an unpaced pull never yields, and the request that
              // is only here to read a header would hang the suite producing bytes nobody reads.
              async pull(controller) { controller.enqueue(payload); await Bun.sleep(1); },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        });
        try {
          const response = await fetch(`http://127.0.0.1:${framingServer.port}/api/sessions`);
          const declared = response.headers.get('content-length');
          await response.body?.cancel().catch(() => undefined);
          check('the endless fixture declares no length, so only the streaming ceiling can end the read',
            declared === null, `content-length=${declared}`);
        } finally {
          framingServer.stop(true);
        }
      }

      // The ceiling actually granted is not directly observable, so it is measured by proxy: how far
      // an endless response got before the reader gave up. Everything below is relative to this one.
      const atMaximum = await streamProbe(HARD_LIMIT);
      check('an endless response is cut off at the repository maximum rather than running to the timeout',
        atMaximum.status === 'invalid-response'
          && atMaximum.elapsedMs < TIMEOUT_MS / 2
          && atMaximum.produced <= HARD_LIMIT + 4 * MIB,
        `status=${atMaximum.status} produced=${atMaximum.produced} ms=${Math.round(atMaximum.elapsedMs)}`);

      // Anything that is not a finite positive byte count collapses to the probe DEFAULT. Comparing
      // against the maximum rather than against a fixed byte count is what makes that specific:
      // collapsing to the maximum instead would return the same status and the same `cancelled`, and
      // only the distance travelled tells the two apart.
      for (const [label, requested] of [
        ['omitted', undefined],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['NaN', Number.NaN],
        ['zero', 0],
        ['negative', -1],
      ] as const) {
        const probe = await streamProbe(requested);
        check(`an endless undeclared response stops at the probe default when maxBytes is ${label}`,
          probe.status === 'invalid-response'
            && probe.elapsedMs < TIMEOUT_MS / 2
            && probe.produced < atMaximum.produced / 2,
          `status=${probe.status} produced=${probe.produced}`
            + ` vs maximum=${atMaximum.produced} ms=${Math.round(probe.elapsedMs)}`);
      }

      // A finite request beyond the repository maximum is capped at it, not honoured.
      const beyond = await streamProbe(1e12);
      check('a maxBytes request of a terabyte is capped at the repository maximum',
        beyond.status === 'invalid-response'
          && beyond.elapsedMs < TIMEOUT_MS / 2
          && beyond.produced <= atMaximum.produced + 4 * MIB,
        `status=${beyond.status} produced=${beyond.produced} vs maximum=${atMaximum.produced} ms=${Math.round(beyond.elapsedMs)}`);
    }
    const chineseStatus = renderLifecycleStatus(status, 'zh-Hans');
    check('human lifecycle status localizes labels and enum values while keeping names and detail codes stable',
      chineseStatus.includes('cosyncing 1.0.0：就绪')
        && chineseStatus.includes('安装：已提交')
        && chineseStatus.includes('服务：systemd / 运行中 / 已启用')
        && chineseStatus.includes('内部端点：就绪')
        && chineseStatus.includes('已注册智能体：Codex [无法创建会话；同步已启用]')
        && chineseStatus.includes('OpenCode [可创建会话]')
        && chineseStatus.includes('Pi [无法创建会话]')
        && chineseStatus.includes('会话：1 个活跃 / 共 2 个')
        && chineseStatus.includes('更新：1 个待处理')
        && !chineseStatus.includes('Installation:')
        && JSON.stringify(status) === serialized,
      chineseStatus.trim());
    const expectedZhStatusValues = {
      ready: '就绪',
      foreground: '前台',
      systemd: 'systemd',
      launchd: 'launchd',
      unconfigured: '未配置',
      active: '运行中',
      inactive: '未运行',
      failed: '失败',
      transitioning: '切换中',
      enabled: '已启用',
      disabled: '已禁用',
      unknown: '未知',
      unreachable: '无法访问',
      'identity-mismatch': '身份不匹配',
      missing: '缺失',
      running: '运行中',
      stopped: '已停止',
      'logged-out': '未登录',
      'daemon-unavailable': 'daemon 不可用',
      desired: '符合预期',
      conflict: '冲突',
      'funnel-conflict': 'Funnel 冲突',
      unavailable: '不可用',
      malformed: '格式错误',
      'native-linux': '原生 Linux',
      'native-macos': '原生 macOS',
      'inside-wsl': 'WSL 内部',
      'windows-host-only': '仅 Windows 主机',
    } satisfies Readonly<Record<CliStatusValue, string>>;
    const statusMatrixKeys = Object.keys(expectedZhStatusValues) as CliStatusValue[];
    const macStatus = renderLifecycleStatus({
      ...status,
      network: { ...status.network, topology: 'native-macos' },
    }, 'zh-Hans');
    const wslStatus = renderLifecycleStatus({
      ...status,
      network: { ...status.network, topology: 'inside-wsl' },
    }, 'zh-Hans');
    check('Chinese lifecycle status exhaustively maps every service, endpoint, Tailscale topology, backend, and route enum',
      statusMatrixKeys.length === Object.keys(ZH_STATUS_VALUES).length
        && statusMatrixKeys.every((value) => ZH_STATUS_VALUES[value] === expectedZhStatusValues[value]
          && localizeCliStatusValue(value, 'zh-Hans') === expectedZhStatusValues[value]
          && localizeCliStatusValue(value, 'en') === value)
        && macStatus.includes('Tailscale：原生 macOS /')
        && wslStatus.includes('Tailscale：WSL 内部 /'),
      `${macStatus.split('\n').find((line) => line.startsWith('Tailscale'))} | ${wslStatus.split('\n').find((line) => line.startsWith('Tailscale'))}`);
    const stopped = await runServiceCommand('stop', baseOptions(m));
    const started = await runServiceCommand('start', baseOptions(m));
    const restarted = await runServiceCommand('restart', baseOptions(m));
    check('start/stop/restart control only the configured owned service',
      stopped.exitCode === 0 && started.exitCode === 0 && restarted.exitCode === 0
        && m.service.calls.includes('restart'));

    // Regression: launchd's verbs return BEFORE the job settles, so the post-condition must be waited for.
    // This provider reports the pre-transition state for the first few samples, exactly as a real launchd
    // job does between `kill SIGTERM` and the process actually exiting. A single-shot check reads that
    // stale sample and wrongly reports "did not reach"; the wait loop must observe the real outcome.
    let settleSamples = 0;
    const lagging = Object.assign(Object.create(Object.getPrototypeOf(m.service)), m.service, {
      async inspect(): Promise<DurableServiceStatus> {
        const status = await FakeService.prototype.inspect.call(m.service);
        settleSamples += 1;
        // Samples 1-3 after the command still show the old state; only later ones show the truth.
        return settleSamples <= 3 ? { ...status, active: 'active' as const } : status;
      },
      async stop(): Promise<void> { await FakeService.prototype.stop.call(m.service); },
    });
    const laggingStop = await runServiceCommand('stop', {
      ...baseOptions(m),
      systemdProviderFactory: () => lagging,
    });
    check('a lifecycle command whose transition lands on a later sample is reported as succeeding',
      laggingStop.exitCode === 0 && laggingStop.detailCode === 'service-stop-complete'
        && settleSamples > 3,
      `${laggingStop.detailCode} after ${settleSamples} samples`);
    const logRunner: ServiceCommandRunner = {
      async run(): Promise<ServiceCommandResult> {
        return { status: 'ok', exitCode: 0, stdout: 'normal\nCOSYNCING_TOKEN=super-secret-token-value\n', stderr: '' };
      },
    };
    const logs = await readServiceLogs({ ...baseOptions(m), lines: 50, follow: false, runner: logRunner });
    check('logs use the bounded fail-closed redactor', logs.result.exitCode === 0 && !logs.output.includes('super-secret-token-value'));
    // The provider owns the whole argv now, so a non-follow read reaches the runner as journalctl's own
    // bounded form rather than a spliced fixed command. The launchd twin below proves the same seam works
    // for a `tail` shaped command, which no amount of argv splicing could have produced.
    const recorded: Array<{ executable: string; args: readonly string[] }> = [];
    const recordingRunner: ServiceCommandRunner = {
      async run(executable, args): Promise<ServiceCommandResult> {
        recorded.push({ executable, args: [...args] });
        return { status: 'ok', exitCode: 0, stdout: 'entry\n', stderr: '' };
      },
    };
    await readServiceLogs({ ...baseOptions(m), lines: 42, follow: false, runner: recordingRunner });
    check('non-follow logs are built by the provider with a bounded line count',
      recorded[0]?.args.join(' ') === `--user -u ${SYSTEMD_SERVICE_NAME} -n 42 --no-pager`,
      recorded[0]?.args.join(' '));
    recorded.length = 0;
    const launchdLogs = await readServiceLogs({
      ...baseOptions(m),
      lines: 99_999,
      follow: false,
      runner: recordingRunner,
      systemdProviderFactory: () => Object.assign(Object.create(Object.getPrototypeOf(m.service)), m.service, {
        logsCommand: (request: { follow: boolean; lines: number }) => [
          '/usr/bin/tail', ...(request.follow ? ['-f'] : []), '-n', String(request.lines),
          '/fixture/.cosyncing/logs/broker.out.log', '/fixture/.cosyncing/logs/broker.err.log',
        ],
      }),
    });
    check('a tail-shaped provider command survives intact and stays line-bounded and redacted',
      launchdLogs.result.exitCode === 0
        && recorded[0]?.executable === '/usr/bin/tail'
        && recorded[0]?.args.join(' ')
          === '-n 10000 /fixture/.cosyncing/logs/broker.out.log /fixture/.cosyncing/logs/broker.err.log',
      `${recorded[0]?.executable} ${recorded[0]?.args.join(' ')}`);
  }

  // Legacy repair: exact marker confirmation, unrelated-setting preservation, scoped credential URL, token rotation.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const piPath = join(m.piAgentDir, 'extensions', 'cosyncing-bridge', 'index.ts');
    atomicWriteOwnerOnly(piPath, PI_BRIDGE_V010_FIXTURE);
    atomicWriteOwnerOnly(m.claudeSettings, `${JSON.stringify({
      preserve: { theme: 'dark' },
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: 'COSYNCING_TOKEN=legacy-secret bun cosyncing-hook.ts request' }] },
          { matcher: 'Read', hooks: [{ type: 'command', command: 'keep-this-command' }] },
        ],
      },
    }, null, 2)}\n`, { mode: 0o600 });
    ensureInstallationCredentials({ home: m.home, internalUrl: 'http://127.0.0.1:8844' });
    const beforeToken = readBrokerToken(join(m.home, 'secrets', 'broker-token'));
    const plan = await inspectRepair(baseOptions(m));
    const refused = await runRepair({ ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false });
    const repaired = await runRepair({ ...baseOptions(m), confirmed: true, allowLegacyIntegrations: true });
    const settings = JSON.parse(readFileSync(m.claudeSettings, 'utf8'));
    check('legacy repair requires its separate marker confirmation',
      plan.actions.filter((action) => action.legacy).length === 2
        && refused.detailCode === 'legacy-integration-confirmation-required');
    check('legacy Pi/Claude repair preserves unrelated settings and rotates a possibly embedded shared token',
      repaired.exitCode === 0
        && hash(readFileSync(piPath)) === PI_BRIDGE_EMBEDDED_SHA256
        && settings.preserve.theme === 'dark'
        && JSON.stringify(settings).includes('keep-this-command')
        && !JSON.stringify(settings).includes('cosyncing-hook')
        && readPiIntegration(join(m.home, 'secrets', 'pi-integration.json')).internalUrl === m.config.broker.internalUrl
        && readBrokerToken(join(m.home, 'secrets', 'broker-token')) !== beforeToken);
  }

  // Unknown Pi content is never overwritten.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const piPath = join(m.piAgentDir, 'extensions', 'cosyncing-bridge', 'index.ts');
    atomicWriteOwnerOnly(piPath, '// unrelated user extension\n');
    const repaired = await runRepair({ ...baseOptions(m), confirmed: true, allowLegacyIntegrations: true });
    check('repair preserves a modified/unowned Pi bridge with an explicit cleanup result',
      repaired.exitCode === 4 && readFileSync(piPath, 'utf8') === '// unrelated user extension\n');
  }

  // Dual native skill targets follow receipt/hash ownership for repair and uninstall.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const targets = installAgentSkills(m);
    const agents = targets.find((target) => target.id === 'agents')!;
    unlinkSync(agents.path);
    const plan = await inspectRepair(baseOptions(m));
    const repaired = await runRepair({ ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false });
    check('repair restores a missing receipt-owned cosyncing skill target',
      plan.actions.some((action) => action.id === 'agent-skill.restore.agents')
        && repaired.exitCode === 0
        && readFileSync(agents.path, 'utf8') === AGENT_SKILL_SOURCE);

    const claude = targets.find((target) => target.id === 'claude')!;
    atomicWriteOwnerOnly(claude.path, '# user-modified skill\n', { mode: 0o600 });
    const drifted = await runRepair({ ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false });
    check('repair preserves a user-modified cosyncing skill with an explicit warning',
      drifted.exitCode === 4
        && drifted.remaining?.includes('agent-skill-claude-unowned-drift') === true
        && readFileSync(claude.path, 'utf8') === '# user-modified skill\n');
  }
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const targets = installAgentSkills(m);
    const uninstalled = await runUninstall({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false,
    });
    check('uninstall removes exactly the two receipt-owned packaged skill copies',
      uninstalled.exitCode === 0 && targets.every((target) => !existsSync(target.path)));
  }

  // A broker update leaves owned-stale skill copies (a receipt proves the older on-disk content); repair
  // refreshes them in place to the current build rather than warning them as invalid.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const targets = installAgentSkills(m);
    const oldContent = '---\nname: cosyncing\n---\n\n# older packaged version\n';
    const oldSha = hash(oldContent);
    const install = inspectInstallState(m.home);
    if (!install.committed) throw new Error('fixture install missing');
    for (const target of targets) {
      atomicWriteOwnerOnly(target.path, oldContent, { mode: 0o600 });
      install.state.resources.find((item) => item.id === target.resourceId)!.ownership.installedSha256 = oldSha;
    }
    writeInstallState(install.state, m.home);
    const plan = await inspectRepair(baseOptions(m));
    const repaired = await runRepair({ ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false });
    const after = inspectInstallState(m.home);
    check('repair refreshes receipt-proved stale cosyncing skill copies to the current build',
      targets.every((target) => plan.actions.some((action) =>
          action.id === `agent-skill.restore.${target.id}` && /refresh/i.test(action.summary)))
        && repaired.exitCode === 0
        && targets.every((target) => readFileSync(target.path, 'utf8') === AGENT_SKILL_SOURCE)
        && after.committed
        && targets.every((target) => after.state.resources.some((item) =>
          item.id === target.resourceId && item.ownership.installedSha256 === AGENT_SKILL_SHA256)));
  }

  // A legacy binary receipt gains a measured hash without claiming package provenance it never had.
  {
    const m = machine(); cleanup.push(m.root);
    const plan = await inspectRepair(baseOptions(m));
    const repaired = await runRepair({ ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false });
    const install = inspectInstallState(m.home);
    const binary = install.committed
      ? install.state.resources.find((item) => item.id === 'broker-binary')
      : undefined;
    check('repair records a missing binary hash while preserving receipt provenance',
      plan.actions.some((action) => action.id === 'receipt.binary-hash')
        && repaired.exitCode === 0 && binary?.ownership.proof === 'receipt'
        && binary.ownership.installedSha256 === hash('old-binary-v1'));
  }

  // A confirmed repair plan is invalidated, not silently expanded, when ownership state changes.
  {
    const m = machine(); cleanup.push(m.root);
    const plan = await inspectRepair(baseOptions(m));
    const piPath = join(m.piAgentDir, 'extensions', 'cosyncing-bridge', 'index.ts');
    atomicWriteOwnerOnly(piPath, '// appeared after confirmation\n');
    const repaired = await runRepair({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false, expectedPlan: plan,
    });
    const install = inspectInstallState(m.home);
    const binary = install.committed
      ? install.state.resources.find((item) => item.id === 'broker-binary')
      : undefined;
    check('repair refuses a state change after plan confirmation without applying the old plan',
      repaired.detailCode === 'repair-plan-changed' && binary?.ownership.installedSha256 === undefined);
  }

  // Repair owns the supported additive migration, takes a two-root backup, and preserves unknown fields.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    writeFileSync(join(m.home, 'setup-state.json'), `${JSON.stringify({
      serviceChoice: 'foreground',
      tailscaleServeRequested: false,
      preservedFutureField: { keep: 7 },
    })}\n`, { mode: 0o600 });
    const plan = await inspectRepair(baseOptions(m));
    const repaired = await runRepair({ ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false });
    const setup = JSON.parse(readFileSync(join(m.home, 'setup-state.json'), 'utf8'));
    const install = inspectInstallState(m.home);
    check('repair backs up and applies the supported schema migration while preserving additive state',
      plan.actions.some((action) => action.id === 'schema.migrate') && repaired.exitCode === 0
        && setup.schemaVersion === 1 && setup.preservedFutureField.keep === 7
        && install.committed && install.state.migrations.some((item) => item.id === 'setup-state-v0-to-v1')
        && existsSync(install.committed ? install.state.migrations[0]!.backupPath : ''));
  }

  // Service drift and a missing requested private route reconcile together and gain receipts.
  {
    const m = machine({ service: true, tailscale: true, binaryHash: true }); cleanup.push(m.root);
    m.network.route = 'missing';
    atomicWriteOwnerOnly(m.service.definitionPath, 'manual drift\n');
    atomicWriteOwnerOnly(m.service.environmentPath, 'manual drift\n');
    m.service.enabled = true;
    m.service.active = false;
    const inspection = inspectInstallState(m.home);
    if (!inspection.committed) throw new Error('fixture install missing');
    inspection.state.resources.push(
      { id: 'service-systemd', kind: 'service', target: m.service.definitionPath, ownership: { proof: 'package-hash', installedSha256: hash(m.service.expectedDefinition()) } },
      { id: 'service-environment', kind: 'environment-file', target: m.service.environmentPath, ownership: { proof: 'package-hash', installedSha256: hash(m.service.expectedEnvironment()) } },
    );
    writeInstallState(inspection.state, m.home);
    const repaired = await runRepair({ ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false });
    const after = inspectInstallState(m.home);
    check('repair reconciles owned service drift, starts it, and restores the requested private route',
      repaired.exitCode === 0 && (await m.service.inspect()).definition === 'current' && m.service.active
        && String(m.network.route) === 'desired' && after.committed
        && after.state.resources.some((item) => item.id === TAILSCALE_SERVE_RESOURCE_ID));
  }

  // A drifted environment file on an ACTIVE service must converge in one run.
  //
  // The reconcile stops the unit, reinstalls, and starts it again — then verified the result on the very
  // next sample. Both providers finish a start asynchronously (systemd's job transition, launchd's queued
  // spawn) and a broker that has just been execed has not bound its port yet, so a normally-booting service
  // failed both the posture check and the single-shot identity probe. The rollback closures then restored
  // the SNAPSHOTS — i.e. re-installed the very drift the operator ran repair to remove — and reported
  // failure, so `repair` could restart the service and still leave the stale COSYNCING_WEB_DIR behind.
  //
  // This fixture reports the realistic transition (`transitioning` for the first samples after start, then
  // `active`) and refuses the health probe until the port is up. Pre-fix, that sequence fails and rolls back.
  {
    const m = machine({ service: true, binaryHash: true }); cleanup.push(m.root);
    const staleWebDir = '/opt/cosyncing/web/0.9.0';
    const currentWebDir = '/opt/cosyncing/web/1.0.0';

    /** Reports a start the way a real user service manager does: settled a few samples later, not at once. */
    class BootingService extends FakeService {
      startLag = 0;
      private pending = 0;
      override expectedEnvironment(): string {
        return `COSYNCING_HOME="/fixture"\nCOSYNCING_WEB_DIR="${currentWebDir}"\n`;
      }
      override async start(): Promise<void> {
        await super.start();
        this.pending = this.startLag;
      }
      override async inspect(): Promise<DurableServiceStatus> {
        const status = await FakeService.prototype.inspect.call(this);
        if (this.pending > 0) {
          this.pending -= 1;
          return { ...status, active: 'transitioning' };
        }
        return status;
      }
    }
    const service = new BootingService(m.root, m.home);
    await service.installDefinition();
    await service.start();

    // The drift an operator actually hits: a broker.env still naming the previous release's web root.
    const driftedEnvironment = `COSYNCING_HOME="/fixture"\nCOSYNCING_WEB_DIR="${staleWebDir}"\n`;
    atomicWriteOwnerOnly(service.environmentPath, driftedEnvironment);
    const install = inspectInstallState(m.home);
    if (!install.committed) throw new Error('fixture install missing');
    install.state.resources.push(
      { id: 'service-systemd', kind: 'service', target: service.definitionPath, ownership: { proof: 'package-hash', installedSha256: hash(service.expectedDefinition()) } },
      { id: 'service-environment', kind: 'environment-file', target: service.environmentPath, ownership: { proof: 'package-hash', installedSha256: hash(service.expectedEnvironment()) } },
    );
    writeInstallState(install.state, m.home);

    let healthProbes = 0;
    const bootingContext: SetupDiagnosisContext = {
      ...m.context,
      async fetchJson(url, headers, timeoutMs) {
        // The broker is execed but has not bound the port yet for the first samples after start.
        if (new URL(url).pathname === '/api/health') {
          healthProbes += 1;
          if (healthProbes <= 2) return { status: 'unreachable' };
        }
        return m.context.fetchJson(url, headers, timeoutMs);
      },
    };
    service.startLag = 2;
    const beforeCalls = service.calls.length;
    const plan = await inspectRepair({ ...baseOptions(m), context: bootingContext, systemdProviderFactory: () => service });
    const repaired = await runRepair({
      ...baseOptions(m),
      context: bootingContext,
      systemdProviderFactory: () => service,
      confirmed: true,
      allowLegacyIntegrations: false,
    });
    const environmentAfter = readFileSync(service.environmentPath, 'utf8');
    const after = inspectInstallState(m.home);
    const applied = service.calls.slice(beforeCalls);
    check('repair converges a drifted COSYNCING_WEB_DIR on an active service in one run',
      plan.actions.some((action) => action.id === 'service.reconcile')
        && repaired.exitCode === 0 && repaired.detailCode === 'repair-complete'
        && environmentAfter === service.expectedEnvironment()
        && !environmentAfter.includes(staleWebDir)
        && after.committed
        && after.state.resources.some((item) => item.id === 'service-environment'
          && item.ownership.installedSha256 === hash(service.expectedEnvironment())),
      `${repaired.exitCode}:${repaired.detailCode} env=${JSON.stringify(environmentAfter)}`);
    check('the converging repair restarts the service and rolls nothing back',
      applied.join(',') === 'stop,install,start'
        && service.active && (await service.inspect()).active === 'active'
        && !applied.includes('uninstall') && !applied.includes('reload'),
      applied.join(','));
    check('the reconcile waited out the start transition and the not-yet-bound health port',
      healthProbes > 2 && service.startLag === 2,
      `health probes=${healthProbes}`);

    // The bound is a bound, not an amnesty: a broker that never answers is still a failed repair, and the
    // rollback that restores the pre-repair files (drift included) is unchanged for that case.
    const deadMachine = machine({ service: true, binaryHash: true }); cleanup.push(deadMachine.root);
    const deadService = new BootingService(deadMachine.root, deadMachine.home);
    await deadService.installDefinition();
    await deadService.start();
    atomicWriteOwnerOnly(deadService.environmentPath, driftedEnvironment);
    const deadInstall = inspectInstallState(deadMachine.home);
    if (!deadInstall.committed) throw new Error('fixture install missing');
    deadInstall.state.resources.push(
      { id: 'service-systemd', kind: 'service', target: deadService.definitionPath, ownership: { proof: 'package-hash', installedSha256: hash(deadService.expectedDefinition()) } },
      { id: 'service-environment', kind: 'environment-file', target: deadService.environmentPath, ownership: { proof: 'package-hash', installedSha256: hash(deadService.expectedEnvironment()) } },
    );
    writeInstallState(deadInstall.state, deadMachine.home);
    const silent = await runRepair({
      ...baseOptions(deadMachine),
      context: contextFor({ userHome: deadMachine.userHome, config: deadMachine.config, network: deadMachine.network, health: false }),
      systemdProviderFactory: () => deadService,
      serviceHealthAttempts: 2,
      confirmed: true,
      allowLegacyIntegrations: false,
    });
    check('a broker that never answers still fails the repair and restores the pre-repair files',
      silent.exitCode === 3 && silent.detailCode === 'repair-rolled-back'
        && readFileSync(deadService.environmentPath, 'utf8') === driftedEnvironment,
      `${silent.exitCode}:${silent.detailCode}`);
  }

  // Full owned uninstall, marker cleanup, and default data preservation.
  {
    const m = machine({ service: true, tailscale: true, binaryHash: true }); cleanup.push(m.root);
    await m.service.installDefinition();
    await m.service.start();
    const skills = installAgentSkills(m);
    const piPath = join(m.piAgentDir, 'extensions', 'cosyncing-bridge', 'index.ts');
    atomicWriteOwnerOnly(piPath, PI_BRIDGE_EMBEDDED_SOURCE);
    atomicWriteOwnerOnly(m.claudeSettings, `${JSON.stringify({
      preserve: true,
      hooks: { Stop: [
        { hooks: [{ command: 'bun cosyncing-hook.ts idle' }] },
        { hooks: [{ command: 'keep-me' }] },
      ] },
    })}\n`);
    // Opt-in OpenCode shim: R1 the hash-owned shim script, R2 a managed block in each existing rc file with
    // pre-existing unrelated content that must survive uninstall byte-for-byte.
    const shimPath = opencodeShimShellPath(m.home);
    const shimPort = opencodeShimPort(m.context.env.OPENCODE_URL);
    atomicWriteOwnerOnly(shimPath, OPENCODE_SHIM_SOURCE, { mode: 0o600 });
    const bashrc = join(m.userHome, '.bashrc');
    const zshrc = join(m.userHome, '.zshrc');
    const bashOriginal = 'export EDITOR=vim\nalias ll="ls -la"\n';
    const zshOriginal = '# zsh config\nsetopt AUTO_CD\n';
    atomicWriteOwnerOnly(bashrc, installRcBlock(bashOriginal, shimPath, shimPort), { mode: 0o600 });
    atomicWriteOwnerOnly(zshrc, installRcBlock(zshOriginal, shimPath, shimPort), { mode: 0o600 });
    const inspection = inspectInstallState(m.home);
    if (!inspection.committed) throw new Error('fixture install missing');
    const liveTail = tailscaleInspection(m.network, m.config);
    inspection.state.resources.push(
      { id: 'service-systemd', kind: 'service', target: m.service.definitionPath, ownership: { proof: 'package-hash', installedSha256: hash(m.service.expectedDefinition()) } },
      { id: 'service-environment', kind: 'environment-file', target: m.service.environmentPath, ownership: { proof: 'package-hash', installedSha256: hash(m.service.expectedEnvironment()) } },
      { id: 'pi-bridge', kind: 'agent-integration', target: piPath, ownership: { proof: 'package-hash', installedSha256: PI_BRIDGE_EMBEDDED_SHA256 } },
      { id: TAILSCALE_SERVE_RESOURCE_ID, kind: 'other', target: tailscaleRouteReceiptTarget(liveTail), ownership: { proof: 'receipt', marker: TAILSCALE_SERVE_OWNERSHIP_MARKER } },
      { id: OPENCODE_SHIM_RESOURCE_ID, kind: 'path-entry', target: shimPath, ownership: { proof: 'package-hash', installedSha256: OPENCODE_SHIM_SHA256 } },
      { id: OPENCODE_SHIM_RC_RESOURCE_IDS.bash, kind: 'shell-init-block', target: bashrc, ownership: { proof: 'receipt', marker: OPENCODE_SHIM_BLOCK_BEGIN } },
      { id: OPENCODE_SHIM_RC_RESOURCE_IDS.zsh, kind: 'shell-init-block', target: zshrc, ownership: { proof: 'receipt', marker: OPENCODE_SHIM_BLOCK_BEGIN } },
    );
    writeInstallState(inspection.state, m.home);
    atomicWriteOwnerOnly(join(m.cache, 'keep-artifact'), 'keep');
    const uninstalled = await runUninstall({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: true,
      purgeData: false, purgeConfirmed: false,
    });
    const claude = JSON.parse(readFileSync(m.claudeSettings, 'utf8'));
    check('uninstall removes exact owned service/route/Pi/binaries and marker hooks only',
      uninstalled.exitCode === 0 && !existsSync(m.binary) && !existsSync(piPath)
        && !existsSync(m.service.definitionPath) && m.network.route === 'missing'
        && !JSON.stringify(claude).includes('cosyncing-hook') && JSON.stringify(claude).includes('keep-me'));
    check('uninstall removes the owned opencode shim script and excises each rc block, preserving unrelated rc content',
      !existsSync(shimPath)
        && readFileSync(bashrc, 'utf8') === bashOriginal
        && readFileSync(zshrc, 'utf8') === zshOriginal);
    check('normal uninstall preserves durable state and artifact cache but clears the committed install gate',
      existsSync(m.home) && existsSync(m.cache) && existsSync(join(m.cache, 'keep-artifact'))
        && !inspectInstallState(m.home).committed);
    // A physical Ubuntu uninstall removed every owned file and left six empty product-named directories on
    // the host. All six are the directory a removed receipt's own target lived in; nothing above them is.
    const emptiedDirectories = [
      ...skills.map((target) => dirname(target.path)),
      dirname(piPath),
      join(m.home, 'bin'),
      join(m.home, 'shell'),
      join(m.home, 'service'),
    ];
    check('uninstall leaves no empty product-named directory at any of the six owned locations',
      emptiedDirectories.every((directory) => !existsSync(directory)),
      emptiedDirectories.filter((directory) => existsSync(directory)).join(','));
    // The shared discovery roots those product directories sat in belong to the agents, not to cosyncing,
    // and are left alone even when this uninstall emptied them.
    const sharedRoots = [
      ...skills.map((target) => dirname(dirname(target.path))),
      join(m.piAgentDir, 'extensions'),
      dirname(m.service.definitionPath),
      m.home,
    ];
    check('uninstall never removes a shared discovery root, the systemd unit directory, or the state home',
      sharedRoots.every((directory) => existsSync(directory)),
      sharedRoots.filter((directory) => !existsSync(directory)).join(','));
  }

  // User content in a product-named directory wins outright: the owned SKILL.md goes, the directory and the
  // user's own file stay. Same rule protects the optional user-authored Pi bridge config.json.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const skills = installAgentSkills(m);
    const claudeSkillDir = dirname(skills[0]!.path);
    const userFile = join(claudeSkillDir, 'NOTES.md');
    writeFileSync(userFile, '# my own notes\n', { mode: 0o600 });
    const piPath = join(m.piAgentDir, 'extensions', 'cosyncing-bridge', 'index.ts');
    const piConfig = join(m.piAgentDir, 'extensions', 'cosyncing-bridge', 'config.json');
    atomicWriteOwnerOnly(piPath, PI_BRIDGE_EMBEDDED_SOURCE);
    writeFileSync(piConfig, '{"approvals":"ask"}\n', { mode: 0o600 });
    const inspection = inspectInstallState(m.home);
    if (!inspection.committed) throw new Error('fixture install missing');
    inspection.state.resources.push({ id: 'pi-bridge', kind: 'agent-integration', target: piPath, ownership: { proof: 'package-hash', installedSha256: PI_BRIDGE_EMBEDDED_SHA256 } });
    writeInstallState(inspection.state, m.home);
    const uninstalled = await runUninstall({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false,
    });
    check('a product directory holding user content keeps the directory and the user file, minus our file',
      uninstalled.exitCode === 0
        && !existsSync(skills[0]!.path) && !existsSync(piPath)
        && existsSync(claudeSkillDir) && readFileSync(userFile, 'utf8') === '# my own notes\n'
        && existsSync(dirname(piConfig)) && readFileSync(piConfig, 'utf8') === '{"approvals":"ask"}\n'
        // The second skill directory held only our copy, so it still goes.
        && !existsSync(dirname(skills[1]!.path)),
      `${uninstalled.exitCode}/${uninstalled.detailCode}`);
  }

  // Modified resources survive uninstall and produce an honest remaining-resource result.
  {
    const m = machine({ resources: [], binaryHash: true }); cleanup.push(m.root);
    const piPath = join(m.piAgentDir, 'extensions', 'cosyncing-bridge', 'index.ts');
    atomicWriteOwnerOnly(piPath, '// user modified bridge\n');
    const inspection = inspectInstallState(m.home);
    if (!inspection.committed) throw new Error('fixture install missing');
    inspection.state.resources.push({ id: 'pi-bridge', kind: 'agent-integration', target: piPath, ownership: { proof: 'package-hash', installedSha256: PI_BRIDGE_EMBEDDED_SHA256 } });
    writeInstallState(inspection.state, m.home);
    const uninstalled = await runUninstall({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: true,
      purgeData: false, purgeConfirmed: false,
    });
    check('uninstall preserves a manually modified Pi bridge and retains retry evidence',
      uninstalled.exitCode === 4 && existsSync(piPath) && inspectInstallState(m.home).committed);
  }

  // A forged or corrupted binary receipt cannot redirect repair/uninstall outside the product bin directory.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const unrelated = join(m.userHome, 'unrelated-executable');
    atomicWriteOwnerOnly(unrelated, 'do-not-delete', { mode: 0o700 });
    const inspection = inspectInstallState(m.home);
    if (!inspection.committed) throw new Error('fixture install missing');
    const binary = inspection.state.resources.find((item) => item.id === 'broker-binary');
    if (!binary) throw new Error('fixture binary receipt missing');
    binary.target = unrelated;
    binary.ownership.installedSha256 = hash('do-not-delete');
    writeInstallState(inspection.state, m.home);
    const repairPlan = await inspectRepair(baseOptions(m));
    const uninstalled = await runUninstall({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false,
    });
    check('invalid binary receipt targets are blocked by repair and preserved by uninstall',
      repairPlan.blockers.some((item) => item.detailCode === 'broker-binary-receipt-invalid')
        && uninstalled.exitCode === 4 && existsSync(unrelated) && existsSync(m.binary));
  }

  // An exact package-hash service can be removed from a partial install even when the receipt is absent.
  {
    const m = machine({ service: true, binaryHash: true }); cleanup.push(m.root);
    await m.service.installDefinition();
    await m.service.start();
    unlinkSync(join(m.home, 'install-state.json'));
    const uninstalled = await runUninstall({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false,
    });
    check('partial uninstall uses exact package hashes to remove the product service without a receipt',
      uninstalled.exitCode === 0 && !existsSync(m.service.definitionPath) && !m.service.active);
  }

  // Uninstall also revalidates the displayed ownership plan under the mutation lock.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const plan = await inspectUninstall({ ...baseOptions(m), purgeData: false });
    atomicWriteOwnerOnly(m.binary, 'changed-after-confirmation', { mode: 0o700 });
    const uninstalled = await runUninstall({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false, expectedPlan: plan,
    });
    check('uninstall refuses ownership drift after confirmation before removing any resource',
      uninstalled.detailCode === 'uninstall-plan-changed' && existsSync(m.binary) && existsSync(m.alias));
  }

  // Bootstrap-copy invariant: the installed binary lives at <home>/bin/cosyncing, so repair, status, and
  // uninstall must reach the same verdict whether the command runs from that copy or from the acquisition
  // artifact that installed it (an `npm i -g` binary under node_modules, or the alias).
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const npmBinary = join(m.userHome, 'npm-global', 'lib', 'node_modules', 'cosyncing', 'bin', 'cosyncing');
    mkdirSync(join(m.userHome, 'npm-global', 'lib', 'node_modules', 'cosyncing', 'bin'), { recursive: true });
    // Deliberately NOT byte-identical to the installed copy: after an `upgrade`, the acquisition artifact
    // stays behind at its old version while the home copy advances. The verdict must not depend on it.
    writeFileSync(npmBinary, 'npm-launcher-v0', { mode: 0o755 });

    const fromHomeCopy = await inspectRepair(baseOptions(m));
    const fromNpm = await inspectRepair({ ...baseOptions(m), executablePath: npmBinary });
    check('repair reaches an identical verdict from the installed copy and from the npm launcher',
      JSON.stringify(fromHomeCopy) === JSON.stringify(fromNpm)
        && fromHomeCopy.blockers.length === 0,
      `home=${JSON.stringify(fromHomeCopy.blockers)} npm=${JSON.stringify(fromNpm.blockers)}`);

    const statusFromNpm = await collectLifecycleStatus({ ...baseOptions(m), executablePath: npmBinary });
    check('status from the npm launcher reports the committed installation, not a binary receipt fault',
      statusFromNpm.installation.committed
        && !statusFromNpm.detailCodes.some((code) => code.startsWith('broker-binary')),
      statusFromNpm.detailCodes.join(','));

    const npmPlan = await inspectUninstall({ ...baseOptions(m), executablePath: npmBinary, purgeData: false });
    check('uninstall from the npm launcher plans a real removal of the receipt-owned home copy',
      npmPlan.actions.some((action) => action.id === 'binary.remove.broker-binary' && action.target === m.binary)
        && !npmPlan.warnings.some((warning) => warning.detailCode === 'broker-binary-receipt-invalid'),
      `${npmPlan.actions.map((action) => action.id).join(',')} warnings=${npmPlan.warnings.map((w) => w.detailCode).join(',')}`);
    check('uninstall advises that the acquisition package survives and must be removed separately',
      npmPlan.advisories.some((item) => item.detailCode === 'acquisition-package-preserved'
        && item.summary.includes('npm uninstall -g cosyncing')),
      npmPlan.advisories.map((item) => item.detailCode).join(','));

    const removed = await runUninstall({
      ...baseOptions(m), executablePath: npmBinary, confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false,
    });
    check('uninstall removes the receipt-owned home copy and never touches the acquisition artifact',
      removed.exitCode === 0 && !existsSync(m.binary)
        && existsSync(npmBinary) && readFileSync(npmBinary, 'utf8') === 'npm-launcher-v0',
      `${removed.exitCode}/${removed.detailCode}`);
    // The plan's advisory has scrolled away by now; the completion line is where the operator learns why
    // `cosyncing` is still on PATH in the next terminal they open.
    check('the completion message repeats that the acquisition package keeps the command on PATH',
      removed.summary.includes('stays on PATH') && removed.summary.includes('npm uninstall -g cosyncing'),
      removed.summary);
  }

  // The same hint must NOT appear when there is no preserved acquisition package: run from the installed
  // home copy, uninstall removed the only thing that put `cosyncing` on PATH.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const removed = await runUninstall({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false,
    });
    check('a run without a preserved acquisition package prints no npm removal hint',
      removed.exitCode === 0 && !existsSync(m.binary)
        && !removed.summary.includes('npm uninstall'),
      removed.summary);
  }


  // Codex daemon ownership: pure decision logic used at broker startup to record ownership evidence.
  {
    const running = decideCodexDaemonOwnership('running', false);
    const absentSpawned = decideCodexDaemonOwnership('absent', true);
    const absentNotSpawned = decideCodexDaemonOwnership('absent', false);
    const unknownSpawned = decideCodexDaemonOwnership('unknown', true);
    check('codex daemon ownership records true only for a confidently-absent daemon we then started',
      running === null && absentNotSpawned === null && unknownSpawned === null
        && !!absentSpawned && absentSpawned.startedByBroker === true);
  }

  // An owned running daemon with live sessions plans the stop plus a resumability disconnection advisory,
  // and a confirmed run stops the daemon and clears the recorded ownership. Ownership is PROVEN by a
  // control-socket fingerprint recorded when the broker started the daemon.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const socket = { dev: 51, ino: 90210, mtimeMs: 1752700000000 };
    setCodexDaemonOwnership({ startedByBroker: true, recordedAt: '2026-07-17T00:00:00.000Z', socket }, m.home);
    const stopCalls: number[] = [];
    const codexOptions = {
      codexDaemonProbe: async (): Promise<CodexDaemonStatus> => ({ binaryAvailable: true, running: true, loadedThreadCount: 2, socketFingerprint: socket }),
      codexDaemonStop: async (timeoutMs: number) => { stopCalls.push(timeoutMs); },
    };
    const plan = await inspectUninstall({ ...baseOptions(m), ...codexOptions, purgeData: false });
    const disconnect = plan.advisories.filter((item) => item.detailCode === 'codex-daemon-sessions-disconnect');
    const uninstalled = await runUninstall({
      ...baseOptions(m), ...codexOptions, confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false, expectedPlan: plan,
    });
    check('owned codex daemon plans a stop + one resumable disconnection advisory and the confirmed run stops it',
      plan.actions.filter((action) => action.id === 'codex-daemon.stop').length === 1
        && disconnect.length === 1 && disconnect[0]!.summary.includes('2 open')
        && disconnect[0]!.summary.includes("'codex resume'")
        && uninstalled.exitCode === 0 && stopCalls.length === 1
        && readCodexDaemonOwnership(m.home)?.startedByBroker === false);
  }

  // A replacement daemon (the broker's daemon died, the user started a new one) recreates the control
  // socket, so the recorded fingerprint no longer matches: the daemon is preserved, never stopped.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    setCodexDaemonOwnership(
      { startedByBroker: true, recordedAt: '2026-07-17T00:00:00.000Z', socket: { dev: 51, ino: 90210, mtimeMs: 1752700000000 } },
      m.home,
    );
    const stopCalls: number[] = [];
    const codexOptions = {
      codexDaemonProbe: async (): Promise<CodexDaemonStatus> => ({ binaryAvailable: true, running: true, loadedThreadCount: 1, socketFingerprint: { dev: 51, ino: 424242, mtimeMs: 1752710000000 } }),
      codexDaemonStop: async (timeoutMs: number) => { stopCalls.push(timeoutMs); },
    };
    const plan = await inspectUninstall({ ...baseOptions(m), ...codexOptions, purgeData: false });
    const uninstalled = await runUninstall({
      ...baseOptions(m), ...codexOptions, confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false, expectedPlan: plan,
    });
    check('a replaced codex daemon (socket fingerprint mismatch) is advised as preserved and never stopped',
      plan.actions.filter((action) => action.id === 'codex-daemon.stop').length === 0
        && plan.advisories.filter((item) => item.detailCode === 'codex-daemon-replaced-preserved').length === 1
        && plan.advisories.filter((item) => item.detailCode === 'codex-daemon-sessions-disconnect').length === 0
        && uninstalled.exitCode === 0 && stopCalls.length === 0);
  }

  // A pre-fingerprint ownership record (startedByBroker boolean only) is unprovable: the running daemon is
  // preserved with an advisory, never stopped.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    setCodexDaemonOwnership({ startedByBroker: true, recordedAt: '2026-07-17T00:00:00.000Z' }, m.home);
    const stopCalls: number[] = [];
    const codexOptions = {
      codexDaemonProbe: async (): Promise<CodexDaemonStatus> => ({ binaryAvailable: true, running: true, loadedThreadCount: 1, socketFingerprint: { dev: 51, ino: 90210, mtimeMs: 1752700000000 } }),
      codexDaemonStop: async (timeoutMs: number) => { stopCalls.push(timeoutMs); },
    };
    const plan = await inspectUninstall({ ...baseOptions(m), ...codexOptions, purgeData: false });
    const uninstalled = await runUninstall({
      ...baseOptions(m), ...codexOptions, confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false, expectedPlan: plan,
    });
    check('a boolean-only ownership record is unprovable: the running daemon is preserved, never stopped',
      plan.actions.filter((action) => action.id === 'codex-daemon.stop').length === 0
        && plan.advisories.filter((item) => item.detailCode === 'codex-daemon-replaced-preserved').length === 1
        && uninstalled.exitCode === 0 && stopCalls.length === 0);
  }

  // An owned daemon that is no longer running gets an explicit advisory instead of silence, and no stop.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    setCodexDaemonOwnership(
      { startedByBroker: true, recordedAt: '2026-07-17T00:00:00.000Z', socket: { dev: 51, ino: 90210, mtimeMs: 1752700000000 } },
      m.home,
    );
    const stopCalls: number[] = [];
    const codexOptions = {
      codexDaemonProbe: async (): Promise<CodexDaemonStatus> => ({ binaryAvailable: true, running: false }),
      codexDaemonStop: async (timeoutMs: number) => { stopCalls.push(timeoutMs); },
    };
    const plan = await inspectUninstall({ ...baseOptions(m), ...codexOptions, purgeData: false });
    const uninstalled = await runUninstall({
      ...baseOptions(m), ...codexOptions, confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false, expectedPlan: plan,
    });
    check('an owned-but-not-running codex daemon gets an advisory and no stop action',
      plan.actions.filter((action) => action.id === 'codex-daemon.stop').length === 0
        && plan.advisories.filter((item) => item.detailCode === 'codex-daemon-not-running').length === 1
        && uninstalled.exitCode === 0 && stopCalls.length === 0);
  }

  // Disabling Codex sync AFTER the broker started the daemon must not skip daemon cleanup: the daemon
  // outlives the sync flag, so a proven-owned daemon is still stopped and advised.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    writeSetupState({ ...readSetupState(m.home), agents: { codex: false } }, m.home);
    const socket = { dev: 51, ino: 90210, mtimeMs: 1752700000000 };
    setCodexDaemonOwnership({ startedByBroker: true, recordedAt: '2026-07-17T00:00:00.000Z', socket }, m.home);
    const stopCalls: number[] = [];
    const codexOptions = {
      codexDaemonProbe: async (): Promise<CodexDaemonStatus> => ({ binaryAvailable: true, running: true, loadedThreadCount: 1, socketFingerprint: socket }),
      codexDaemonStop: async (timeoutMs: number) => { stopCalls.push(timeoutMs); },
    };
    const plan = await inspectUninstall({ ...baseOptions(m), ...codexOptions, purgeData: false });
    const uninstalled = await runUninstall({
      ...baseOptions(m), ...codexOptions, confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false, expectedPlan: plan,
    });
    check('disabling codex sync does not skip owned daemon cleanup at uninstall',
      plan.actions.filter((action) => action.id === 'codex-daemon.stop').length === 1
        && plan.advisories.filter((item) => item.detailCode === 'codex-daemon-sessions-disconnect').length === 1
        && uninstalled.exitCode === 0 && stopCalls.length === 1);
  }

  // An unknown loaded-thread count must not masquerade as "0 open sessions": the advisory stays count-free.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const socket = { dev: 51, ino: 90210, mtimeMs: 1752700000000 };
    setCodexDaemonOwnership({ startedByBroker: true, recordedAt: '2026-07-17T00:00:00.000Z', socket }, m.home);
    const codexOptions = {
      codexDaemonProbe: async (): Promise<CodexDaemonStatus> => ({ binaryAvailable: true, running: true, socketFingerprint: socket }),
      codexDaemonStop: async () => {},
    };
    const plan = await inspectUninstall({ ...baseOptions(m), ...codexOptions, purgeData: false });
    const disconnect = plan.advisories.filter((item) => item.detailCode === 'codex-daemon-sessions-disconnect');
    check('an unknown loaded-thread count keeps the disconnection advisory count-free',
      disconnect.length === 1 && disconnect[0]!.summary.startsWith('Open synced Codex sessions')
        && disconnect[0]!.summary.includes("'codex resume'"));
  }

  // A daemon replaced inside the locked window (fingerprint matches at the locked re-inspect but not at the
  // stop call) is preserved at execution and never stopped.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const socket = { dev: 51, ino: 90210, mtimeMs: 1752700000000 };
    setCodexDaemonOwnership({ startedByBroker: true, recordedAt: '2026-07-17T00:00:00.000Z', socket }, m.home);
    const stopCalls: number[] = [];
    const plan = await inspectUninstall({
      ...baseOptions(m),
      codexDaemonProbe: async (): Promise<CodexDaemonStatus> => ({ binaryAvailable: true, running: true, loadedThreadCount: 1, socketFingerprint: socket }),
      purgeData: false,
    });
    let probeCalls = 0;
    const codexOptions = {
      codexDaemonProbe: async (): Promise<CodexDaemonStatus> => {
        probeCalls += 1;
        // First call is the locked re-inspect (still the owned instance); the replacement lands just before
        // the stop executes, so the execution-time fingerprint re-check must catch it.
        return {
          binaryAvailable: true,
          running: true,
          loadedThreadCount: 1,
          socketFingerprint: probeCalls === 1 ? socket : { dev: 51, ino: 424242, mtimeMs: 1752710000000 },
        };
      },
      codexDaemonStop: async (timeoutMs: number) => { stopCalls.push(timeoutMs); },
    };
    const uninstalled = await runUninstall({
      ...baseOptions(m), ...codexOptions, confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false, expectedPlan: plan,
    });
    check('a daemon replaced inside the locked window is preserved at execution, never stopped',
      uninstalled.exitCode === 4 && uninstalled.remaining?.includes('codex-daemon-preserved') === true
        && stopCalls.length === 0);
  }

  // A running daemon without ownership evidence is never stopped; uninstall completes and leaves it running.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const stopCalls: number[] = [];
    const codexOptions = {
      codexDaemonProbe: async (): Promise<CodexDaemonStatus> => ({ binaryAvailable: true, running: true, loadedThreadCount: 3 }),
      codexDaemonStop: async (timeoutMs: number) => { stopCalls.push(timeoutMs); },
    };
    const plan = await inspectUninstall({ ...baseOptions(m), ...codexOptions, purgeData: false });
    const uninstalled = await runUninstall({
      ...baseOptions(m), ...codexOptions, confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false, expectedPlan: plan,
    });
    check('unowned running codex daemon plans no stop, advises it is left running, and still completes',
      plan.actions.filter((action) => action.id === 'codex-daemon.stop').length === 0
        && plan.advisories.filter((item) => item.detailCode === 'codex-daemon-preexisting-preserved').length === 1
        && plan.advisories.filter((item) => item.detailCode === 'codex-daemon-sessions-disconnect').length === 0
        && uninstalled.exitCode === 0 && stopCalls.length === 0);
  }

  // A missing codex binary preserves an owned daemon with a warning and never fails the uninstall.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    setCodexDaemonOwnership({ startedByBroker: true, recordedAt: '2026-07-17T00:00:00.000Z' }, m.home);
    const stopCalls: number[] = [];
    const codexOptions = {
      codexDaemonProbe: async (): Promise<CodexDaemonStatus> => ({ binaryAvailable: false, running: false, loadedThreadCount: 0 }),
      codexDaemonStop: async (timeoutMs: number) => { stopCalls.push(timeoutMs); },
    };
    const plan = await inspectUninstall({ ...baseOptions(m), ...codexOptions, purgeData: false });
    const uninstalled = await runUninstall({
      ...baseOptions(m), ...codexOptions, confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false, expectedPlan: plan,
    });
    check('a missing codex binary preserves the owned daemon with a warning and does not fail uninstall',
      plan.actions.filter((action) => action.id === 'codex-daemon.stop').length === 0
        && plan.advisories.filter((item) => item.detailCode === 'codex-daemon-preserved').length === 1
        && uninstalled.exitCode === 0 && stopCalls.length === 0);
  }

  // A live-session count that changes between confirmation and the locked re-inspect is not a plan change.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const socket = { dev: 51, ino: 90210, mtimeMs: 1752700000000 };
    setCodexDaemonOwnership({ startedByBroker: true, recordedAt: '2026-07-17T00:00:00.000Z', socket }, m.home);
    let sessionCount = 2;
    const stopCalls: number[] = [];
    const codexOptions = {
      codexDaemonProbe: async (): Promise<CodexDaemonStatus> => ({ binaryAvailable: true, running: true, loadedThreadCount: sessionCount, socketFingerprint: socket }),
      codexDaemonStop: async (timeoutMs: number) => { stopCalls.push(timeoutMs); },
    };
    const plan = await inspectUninstall({ ...baseOptions(m), ...codexOptions, purgeData: false });
    sessionCount = 0; // a session finished between confirmation and execution
    const uninstalled = await runUninstall({
      ...baseOptions(m), ...codexOptions, confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false, expectedPlan: plan,
    });
    check('a volatile live-session count does not spuriously invalidate the confirmed uninstall plan',
      uninstalled.detailCode !== 'uninstall-plan-changed' && uninstalled.exitCode === 0
        && stopCalls.length === 1);
  }

  // ...but a Claude legacy-hook COUNT change (structural, inside the repair action summary) between
  // confirmation and the locked re-inspect IS a plan change and must block the confirmed repair.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const hooks = (count: number) => ({
      hooks: {
        PreToolUse: Array.from({ length: count }, () => ({ hooks: [{ type: 'command', command: 'bun cosyncing-hook.ts request' }] })),
      },
    });
    atomicWriteOwnerOnly(m.claudeSettings, `${JSON.stringify(hooks(2), null, 2)}\n`, { mode: 0o600 });
    const plan = await inspectRepair(baseOptions(m));
    atomicWriteOwnerOnly(m.claudeSettings, `${JSON.stringify(hooks(3), null, 2)}\n`, { mode: 0o600 });
    const repaired = await runRepair({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: true, expectedPlan: plan,
    });
    check('a changed Claude legacy-hook entry count invalidates the confirmed repair plan',
      plan.actions.some((action) => action.id === 'claude-hooks.remove-legacy' && action.summary.includes('2 marker-owned'))
        && repaired.detailCode === 'repair-plan-changed'
        && JSON.stringify(readFileSync(m.claudeSettings, 'utf8')).split('cosyncing-hook').length - 1 === 3);
  }

  // A recorded PATH-file edit is restored only when both current and backup hashes still match.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const shellFile = join(m.userHome, '.profile');
    const original = 'export KEEP_ME=1\n';
    const installed = `${original}export PATH="${m.home}/bin:$PATH"\n`;
    const backup = join(m.home, 'backups', 'path', 'profile.before');
    atomicWriteOwnerOnly(shellFile, installed, { mode: 0o600 });
    atomicWriteOwnerOnly(backup, original, { mode: 0o600 });
    const inspection = inspectInstallState(m.home);
    if (!inspection.committed) throw new Error('fixture install missing');
    inspection.state.resources.push({
      id: 'shell-path-profile', kind: 'path-entry', target: shellFile,
      ownership: {
        proof: 'package-hash', installedSha256: hash(installed), originalSha256: hash(original), backupPath: backup,
      },
    });
    writeInstallState(inspection.state, m.home);
    const uninstalled = await runUninstall({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false,
    });
    check('uninstall restores a verified PATH-file backup and preserves unrelated shell content',
      uninstalled.exitCode === 0 && readFileSync(shellFile, 'utf8') === original);
  }

  // A symlinked PATH backup is never followed, even when the receipt hashes look valid.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    const shellFile = join(m.userHome, '.profile');
    const original = 'export KEEP_ME=1\n';
    const installed = `${original}export PATH="${m.home}/bin:$PATH"\n`;
    const backup = join(m.home, 'backups', 'path', 'profile.before');
    const outside = join(m.userHome, 'outside-profile');
    atomicWriteOwnerOnly(shellFile, installed, { mode: 0o600 });
    atomicWriteOwnerOnly(outside, original, { mode: 0o600 });
    mkdirSync(join(m.home, 'backups', 'path'), { recursive: true });
    symlinkSync(outside, backup);
    const inspection = inspectInstallState(m.home);
    if (!inspection.committed) throw new Error('fixture install missing');
    inspection.state.resources.push({
      id: 'shell-path-profile', kind: 'path-entry', target: shellFile,
      ownership: {
        proof: 'package-hash', installedSha256: hash(installed), originalSha256: hash(original), backupPath: backup,
      },
    });
    writeInstallState(inspection.state, m.home);
    const uninstalled = await runUninstall({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false,
    });
    check('uninstall refuses a symlinked PATH backup and preserves the edited file',
      uninstalled.exitCode === 4 && readFileSync(shellFile, 'utf8') === installed
        && readFileSync(outside, 'utf8') === original);
  }

  // Purge is a distinct confirmation and enumerates/removes both roots only after owned cleanup succeeds.
  {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    atomicWriteOwnerOnly(join(m.cache, 'artifact'), 'private');
    const skills = installAgentSkills(m);
    const refused = await runUninstall({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false,
      purgeData: true, purgeConfirmed: false,
    });
    check('purge-data requires separate confirmation before any mutation', refused.exitCode === 2 && existsSync(m.binary), `${refused.exitCode}/${refused.detailCode}/binary=${existsSync(m.binary)}`);
    let stateRootPresentAtRelease: boolean | undefined;
    const purged = await runUninstall({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false,
      purgeData: true, purgeConfirmed: true,
      acquireLock: () => ({
        path: join(m.home, 'installation.lock'),
        recoveredStaleLock: false,
        release() { stateRootPresentAtRelease = existsSync(m.home); },
      }),
    });
    check('confirmed purge holds the mutation lock while removing both exact durable roots',
      purged.exitCode === 0 && !existsSync(m.home) && !existsSync(m.cache)
        && stateRootPresentAtRelease === false);
    check('purge still removes every owned integration outside the purged roots',
      skills.every((target) => !existsSync(target.path) && !existsSync(dirname(target.path))),
      skills.map((target) => `${existsSync(target.path)}/${existsSync(dirname(target.path))}`).join(','));
  }

  // Signed-manifest upgrade matrix.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = 'fixture-ed25519';
  const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const candidate = Buffer.from('candidate-binary-v2');
  const artifact: ReleaseArtifact = {
    name: 'cosyncing-linux-x64', target: 'linux-x64', platform: 'linux', arch: 'x64',
    size: candidate.byteLength, sha256: hash(candidate),
    url: 'https://releases.example/cosyncing-linux-x64',
    provenanceUrl: 'https://releases.example/cosyncing-linux-x64.intoto.jsonl',
  };
  const signedManifest = (override: Partial<ReleaseArtifact> = {}): ReleaseManifest => releaseManifestForTests({
    version: '2.0.0', sourceCommit: '2222222', publishedAt: '2026-07-17T12:00:00.000Z',
    artifact: { ...artifact, ...override }, keyId,
    sign: (payload) => sign(null, payload, privateKey),
  });
  const upgradeMachine = () => {
    const m = machine({ binaryHash: true }); cleanup.push(m.root);
    let active = true;
    let startFails = false;
    const service: UpgradeServiceController = {
      async inspect() { return { active }; },
      async stop() { active = false; },
      async start() { if (startFails) throw new Error('fixture start failure'); active = true; },
    };
    return { m, service, active: () => active, failStart: () => { startFails = true; } };
  };
  const fetcher = (manifest: ReleaseManifest, artifactBytes = candidate): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('manifest.json')) {
        const body = JSON.stringify(manifest);
        return new Response(body, { status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) } });
      }
      return new Response(artifactBytes, { status: 200, headers: { 'content-length': String(artifactBytes.byteLength) } });
    }) as typeof fetch;
  const upgradeOptions = (fixture: ReturnType<typeof upgradeMachine>, manifest = signedManifest()) => ({
    home: fixture.m.home,
    cacheRoot: fixture.m.cache,
    buildInfo: BUILD,
    executablePath: fixture.m.binary,
    manifestUrl: 'https://releases.example/manifest.json',
    trustedKeys: { [keyId]: publicPem },
    fetch: fetcher(manifest),
    runBinary: async () => ({ status: 'ok' as const, exitCode: 0, stdout: JSON.stringify({ version: '2.0.0', target: 'linux-x64', packaged: true, distribution: 'native' }), stderr: '' }),
    service: fixture.service,
    verifyBrokerVersion: async () => true,
    healthAttempts: 1,
    sleep: async () => undefined,
  });

  {
    const fixture = (() => {
      const m = machine(); cleanup.push(m.root);
      let active = true;
      const service: UpgradeServiceController = {
        async inspect() { return { active }; },
        async stop() { active = false; },
        async start() { active = true; },
      };
      return { m, service, active: () => active, failStart() {} };
    })();
    const rejected = await runUpgrade(upgradeOptions(fixture));
    check('upgrade requires a measured installed-binary receipt before downloading',
      rejected.detailCode === 'installed-binary-receipt-invalid'
        && readFileSync(fixture.m.binary, 'utf8') === 'old-binary-v1' && fixture.active());
  }

  {
    const fixture = upgradeMachine();
    const upgraded = await runUpgrade(upgradeOptions(fixture));
    const state = inspectInstallState(fixture.m.home);
    check('signed upgrade verifies, self-checks, switches, health-checks, and preserves the previous binary',
      upgraded.exitCode === 0 && readFileSync(fixture.m.binary, 'utf8') === candidate.toString()
        && readFileSync(join(fixture.m.home, 'bin', 'cosyncing.previous'), 'utf8') === 'old-binary-v1'
        && state.committed && (state.state.installer as any)?.version === '2.0.0');
  }
  {
    // Driven from the acquisition artifact, not the installed copy: an npm-installed launcher on PATH is the
    // normal way `cosyncing upgrade` is typed, and it is deliberately NOT byte-identical to the home copy
    // (it stays at its installed version while the home copy advances). The receipt alone names the target.
    const fixture = upgradeMachine();
    const npmBinary = join(fixture.m.userHome, 'npm-global', 'lib', 'node_modules', 'cosyncing', 'bin', 'cosyncing');
    mkdirSync(join(fixture.m.userHome, 'npm-global', 'lib', 'node_modules', 'cosyncing', 'bin'), { recursive: true });
    writeFileSync(npmBinary, 'npm-launcher-v0', { mode: 0o755 });
    const upgraded = await runUpgrade({ ...upgradeOptions(fixture), executablePath: npmBinary });
    check('upgrade invoked from the npm launcher still swaps the receipt-owned home copy',
      upgraded.exitCode === 0
        && readFileSync(fixture.m.binary, 'utf8') === candidate.toString()
        && readFileSync(npmBinary, 'utf8') === 'npm-launcher-v0',
      `${upgraded.exitCode}/${upgraded.detailCode}`);
  }
  {
    const fixture = upgradeMachine();
    const oversized = await runUpgrade({
      ...upgradeOptions(fixture),
      fetch: (async () => new Response(new Uint8Array(300_000), { status: 200 })) as unknown as typeof fetch,
    });
    check('upgrade bounds a streamed manifest even without Content-Length',
      oversized.detailCode === 'release-download-too-large'
        && readFileSync(fixture.m.binary, 'utf8') === 'old-binary-v1' && fixture.active());
  }
  {
    const fixture = upgradeMachine();
    const bad = signedManifest({ sha256: '0'.repeat(64) });
    const rejected = await runUpgrade(upgradeOptions(fixture, bad));
    check('upgrade rejects a checksum mismatch before service or binary mutation',
      rejected.detailCode === 'release-artifact-checksum-mismatch'
        && readFileSync(fixture.m.binary, 'utf8') === 'old-binary-v1' && fixture.active());
  }
  {
    const fixture = upgradeMachine();
    const tampered = { ...signedManifest(), version: '2.0.1' } as ReleaseManifest;
    const rejected = await runUpgrade(upgradeOptions(fixture, tampered));
    check('upgrade rejects a modified signed manifest before downloading its artifact',
      rejected.detailCode === 'release-manifest-signature-invalid'
        && readFileSync(fixture.m.binary, 'utf8') === 'old-binary-v1' && fixture.active());
  }
  {
    const fixture = upgradeMachine();
    const unavailable = await runUpgrade({
      ...upgradeOptions(fixture),
      fetch: (async () => new Response('missing', { status: 503 })) as unknown as typeof fetch,
    });
    check('unavailable release leaves the installed binary untouched',
      unavailable.detailCode === 'release-download-unavailable' && readFileSync(fixture.m.binary, 'utf8') === 'old-binary-v1');
  }
  {
    const fixture = upgradeMachine();
    const badSelf = await runUpgrade({
      ...upgradeOptions(fixture),
      runBinary: async () => ({ status: 'error', exitCode: 1, stdout: '', stderr: 'bad' }),
    });
    check('offline self-check failure removes staging and never stops the service',
      badSelf.detailCode === 'release-offline-self-check-failed'
        && readFileSync(fixture.m.binary, 'utf8') === 'old-binary-v1' && fixture.active());
  }
  {
    // `packaged` is true for the npm JavaScript distribution too, so it can no longer stand in for "this is
    // a native executable". A misassembled signed manifest offering a JavaScript bundle to the native swap
    // lane would otherwise be written over the running binary and could not start.
    const fixture = upgradeMachine();
    const wrongKind = await runUpgrade({
      ...upgradeOptions(fixture),
      runBinary: async () => ({
        status: 'ok' as const,
        exitCode: 0,
        stdout: JSON.stringify({ version: '2.0.0', target: 'linux-x64', packaged: true, distribution: 'bun-js' }),
        stderr: '',
      }),
    });
    check('a candidate that is packaged but not native is refused by the native upgrade lane',
      wrongKind.detailCode === 'release-offline-self-check-failed'
        && readFileSync(fixture.m.binary, 'utf8') === 'old-binary-v1' && fixture.active(),
      wrongKind.detailCode);
  }
  {
    const fixture = upgradeMachine();
    const rolledBack = await runUpgrade({ ...upgradeOptions(fixture), verifyBrokerVersion: async () => false });
    check('failed candidate health restores the previous binary and service',
      rolledBack.exitCode === 3 && rolledBack.detailCode === 'upgrade-rolled-back'
        && readFileSync(fixture.m.binary, 'utf8') === 'old-binary-v1' && fixture.active());
  }
  {
    const fixture = upgradeMachine();
    const interrupted = await runUpgrade({ ...upgradeOptions(fixture), faultAfter: 'binary-switched' });
    const recovered = await runUpgrade({
      ...upgradeOptions(fixture),
      fetch: (async () => new Response('missing', { status: 503 })) as unknown as typeof fetch,
    });
    check('interrupted switched upgrade restores the old release from its durable journal on the next run',
      interrupted.exitCode === 4 && recovered.exitCode === 3
        && recovered.detailCode === 'upgrade-interrupted-recovered' && recovered.recoveredInterruptedUpgrade
        && readFileSync(fixture.m.binary, 'utf8') === 'old-binary-v1' && fixture.active()
        && !existsSync(join(fixture.m.home, 'upgrade-journal.json')));
  }
  {
    const fixture = upgradeMachine();
    const interrupted = await runUpgrade({ ...upgradeOptions(fixture), faultAfter: 'receipt-committed' });
    const committedCandidate = inspectInstallState(fixture.m.home);
    const recovered = await runUpgrade(upgradeOptions(fixture));
    const restored = inspectInstallState(fixture.m.home);
    const restoredBinary = restored.committed
      ? restored.state.resources.find((item) => item.id === 'broker-binary')
      : undefined;
    check('recovery restores the old receipt when a crash lands after candidate receipt commit',
      interrupted.exitCode === 4 && committedCandidate.committed
        && (committedCandidate.state.installer as any)?.version === '2.0.0'
        && recovered.detailCode === 'upgrade-interrupted-recovered'
        && readFileSync(fixture.m.binary, 'utf8') === 'old-binary-v1'
        && restored.committed && (restored.state.installer as any)?.version === '1.0.0'
        && restoredBinary?.ownership.installedSha256 === hash('old-binary-v1'));
  }
  {
    const fixture = upgradeMachine();
    fixture.failStart();
    const incomplete = await runUpgrade(upgradeOptions(fixture));
    check('rollback failure preserves the journal and reports manual cleanup',
      incomplete.exitCode === 4 && incomplete.detailCode === 'upgrade-rollback-incomplete'
        && existsSync(join(fixture.m.home, 'upgrade-journal.json')));
  }

  // CLI grammar keeps all lifecycle flags explicit and alias-aware.
  {
    const calls: string[] = [];
    const writer = { write() {} };
    const dependencies = {
      buildInfo: BUILD,
      invocation: 'cosy',
      stdout: writer,
      stderr: writer,
      runStatus: async () => { calls.push('status'); return { exitCode: 0 }; },
      runServiceCommand: async ({ action }: { action: 'start' | 'stop' | 'restart' }) => { calls.push(action); return { exitCode: 0 }; },
      runLogs: async ({ lines }: { lines: number }) => { calls.push(`logs:${lines}`); return { exitCode: 0 }; },
      runRepair: async ({ allowLegacyIntegrations }: { allowLegacyIntegrations: boolean }) => { calls.push(`repair:${allowLegacyIntegrations}`); return { exitCode: 0 }; },
      runUpgrade: async ({ manifestUrl }: { manifestUrl?: string }) => { calls.push(`upgrade:${manifestUrl}`); return { exitCode: 0 }; },
      runUninstall: async ({ purgeData, confirmPurgeData }: { purgeData: boolean; confirmPurgeData: boolean }) => { calls.push(`uninstall:${purgeData}:${confirmPurgeData}`); return { exitCode: 0 }; },
    } as Parameters<typeof runCli>[1];
    await runCli(['status', '--json'], dependencies);
    await runCli(['restart'], dependencies);
    await runCli(['logs', '--lines', '42'], dependencies);
    await runCli(['repair', '--yes', '--accept-legacy-integrations'], dependencies);
    await runCli(['upgrade', '--yes', '--manifest', 'https://releases.example/manifest.json'], dependencies);
    await runCli(['uninstall', '--yes', '--purge-data', '--confirm-purge-data'], dependencies);
    check('CLI parses status/service/logs/repair/upgrade/uninstall with explicit destructive gates',
      calls.join('|') === 'status|restart|logs:42|repair:true|upgrade:https://releases.example/manifest.json|uninstall:true:true', calls.join('|'));

    // The unreadable-roster line tells the operator to run a command; that command has to exist and
    // has to be one that helps. It names `logs` rather than `doctor` because doctor reads only
    // fixed-size documents — it never looks at the roster, so it would report a healthy broker and
    // leave the line unexplained. Bound to the parser above rather than to a string: the command in
    // the copy is extracted and re-run through the real CLI, so renaming or dropping it fails here.
    for (const language of ['en', 'zh-Hans'] as const) {
      const line = cliMessages(language).status.sessions(
        { sessions: 'unreadable' } as unknown as LifecycleStatusReport,
      );
      const named = line.match(new RegExp(`${PRODUCT_IDENTITY.primaryBinary} ([a-z-]+)`))?.[1];
      calls.length = 0;
      if (named) await runCli([named, '--lines', '42'], dependencies);
      check(`the ${language} unreadable-roster line names a command the CLI actually runs`,
        named === 'logs' && calls.join('|') === 'logs:42',
        `named=${named} line=${line} calls=${calls.join('|')}`);
    }
  }
} finally {
  for (const root of cleanup) rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} broker-lifecycle checks failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} broker-lifecycle checks`);
