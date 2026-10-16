/**
 * Starting, failing to start, and the durable state a broker reads back.
 *
 * A broker that cannot start must exit non-zero, say why, and leave nothing
 * listening. One that starts reads its configuration and credentials from the
 * owner-only files setup wrote, never leaks a credential into its command line
 * or logs, keeps additive configuration it does not understand, and reports
 * damaged state through its health surface with stable codes and no local
 * paths, while staying live.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveLoopbackFixturePort } from '../../packages/typescript/broker/test/helpers/isolated-broker-fixture.ts';
import { PRODUCT_IDENTITY } from '../../packages/typescript/protocol/src/index.ts';
import { type Broker, eventually, REPO_ROOT, startBroker } from '../harness/index.ts';
import { BROKER_ENTRY, CLI_ENTRY, commandLineOf, fixtureEnvironment, runCli, runToExit } from '../harness/cli.ts';
import { type InstalledBroker, startInstalledBroker, writeInstalledState } from '../harness/installed.ts';
import { createOffer, pairDevice } from '../harness/pairing.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-startup-'));
const hash = (token: string): string => createHash('sha256').update(token).digest('base64url');
const UNKNOWN_ROLE_TOKEN = 'unknown-role-device-credential-0123456789';
const KNOWN_ROLE_TOKEN = 'known-role-device-credential-0123456789';
const BROKEN_RECORD_TOKEN = 'broken-record-device-credential-0123456789';
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A v2 peer-store record as a broker writes it, whose device presents `token`. */
function storedPeer(name: string, token: string, roles: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    peerId: `peer-${name}`,
    identityPublicKey: `identity-${name}`,
    peerTokenHash: hash(`mailbox-${name}`),
    brokerPeerId: `broker-peer-${name}`,
    brokerPeerTokenHash: hash(token),
    brokerIdentityPublicKey: `broker-identity-${name}`,
    dataKey: { algorithm: 'AES-256-GCM', bytes: '' },
    wrappedDataKey: {},
    acceptedAt: new Date(0).toISOString(),
    authGeneration: 1,
    roles,
    ...extra,
  };
}

function writePeerStore(cosyncingHome: string, peers: Array<Record<string, unknown>>): void {
  writeFileSync(join(cosyncingHome, 'transport-peers.json'), `${JSON.stringify({ version: 2, peers })}\n`, { mode: 0o600 });
}

function readPeerStore(cosyncingHome: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(cosyncingHome, 'transport-peers.json'), 'utf8')).peers;
}

/** A home and an environment for a process this file starts by hand. */
function processCase(name: string, overrides: Record<string, string> = {}): { home: string; env: NodeJS.ProcessEnv } {
  const caseRoot = join(root, name);
  const bin = join(caseRoot, 'bin');
  const home = join(caseRoot, 'cosyncing-home');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return { home, env: fixtureEnvironment(caseRoot, bin, { COSYNCING_HOME: home, HOST: '127.0.0.1', ...overrides }) };
}

async function occupy(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function portIsFree(port: number): Promise<boolean> {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
  } catch {
    return false;
  }
  await close(probe);
  return true;
}

async function leasedPort(): Promise<number> {
  const lease = await reserveLoopbackFixturePort();
  await lease.release();
  return lease.port;
}

describe('a broker that cannot start', () => {
  test.each([
    ['the source entry point', ['bun', BROKER_ENTRY]],
    ['the cosyncing broker command', ['bun', CLI_ENTRY, 'broker', '--dev-bypass-first-run']],
  ])('%s exits non-zero when its port is taken, says why, and leaves no listener', async (label, argv) => {
    const port = await leasedPort();
    const squatter = await occupy(port);
    let result;
    try {
      const { env } = processCase(`taken-port-${label.replaceAll(' ', '-')}`, {
        PORT: String(port),
        COSYNCING_TOKEN: 'fatal-startup-token',
        COSYNCING_CLAUDE_HOOKS: '0',
      });
      result = await runToExit(argv as string[], { env, label: `${label} on a taken port` });
    } finally {
      await close(squatter);
    }
    expect(result.timedOut, 'it must exit rather than run on, serving nothing').toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/broker failed/);
    expect(result.output).toMatch(/port/i);
    expect(await portIsFree(port)).toBe(true);
  });

  test('a rejected argument exits 2 with its diagnostic', async () => {
    const { env } = processCase('bad-argument');
    const result = await runToExit(['bun', CLI_ENTRY, 'broker', '--not-a-real-flag'], { env });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/unknown option/);
  });

  test('a malformed configuration is a stable, redacted CLI error before any listener exists', async () => {
    const { home, env } = processCase('malformed-config');
    writeFileSync(join(home, 'config.json'), '{ malformed', { mode: 0o600 });
    const result = await runCli(['broker', '--dev-bypass-first-run'], { env: { ...env, PORT: String(await leasedPort()) } });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('config-malformed-json');
    expect(result.output).not.toContain('{ malformed');
  });

  test.each([
    ['a port outside 1-65535', { port: 70_000 }, {}, 'config-port'],
    ['an unknown update channel', {}, { update: { channel: 'surprise' } }, 'config-update-channel'],
  ])('a configuration with %s fails closed', async (label, broker, extra, code) => {
    const { home, env } = processCase(`invalid-config-${label.replaceAll(' ', '-')}`);
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      schemaVersion: 2,
      broker: { port: 7734, machineLabel: 'invalid-config', ...broker },
      update: { channel: 'stable' },
      ...extra,
    }), { mode: 0o600 });
    const result = await runToExit(['bun', BROKER_ENTRY], { env: { ...env, PORT: String(await leasedPort()) } });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode, result.output).not.toBe(0);
    expect(result.output).toContain(`broker configuration is invalid (${code})`);
  });

  test('a malformed instance identity stops startup with a stable code and is left for repair', async () => {
    const { home, env } = processCase('malformed-instance');
    const identity = '{"version":2,"instanceId":"invalid"}\n';
    writeFileSync(join(home, 'broker-instance.json'), identity, { mode: 0o600 });
    const result = await runToExit(['bun', BROKER_ENTRY], { env: { ...env, PORT: String(await leasedPort()) } });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('broker-instance-invalid');
    expect(readFileSync(join(home, 'broker-instance.json'), 'utf8')).toBe(identity);
  });

  test.skipIf(process.platform === 'win32')('a credential file anyone else can read stops startup, naming the file problem but not the secret', async () => {
    const { home, env } = processCase('loose-token');
    const port = await leasedPort();
    const credentials = writeInstalledState(home, port);
    chmodSync(join(home, 'secrets', 'broker-token'), 0o644);
    const result = await runToExit(['bun', BROKER_ENTRY], { env: { ...env, PORT: String(port) } });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('broker-token-unsafe-mode');
    expect(result.output).not.toContain(credentials.brokerToken);
  });

  test('integration credentials written for another port stop startup until setup rewrites them', async () => {
    const { home, env } = processCase('moved-port');
    const credentials = writeInstalledState(home, await leasedPort());
    const result = await runToExit(['bun', BROKER_ENTRY], { env: { ...env, PORT: String(await leasedPort()) } });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('pi-integration-url-mismatch');
    expect(result.output).not.toContain(credentials.piCredential);
  });
});

describe('first start', () => {
  test('concurrent first starts all adopt one exclusively created instance identity', async () => {
    const home = join(root, 'instance-race');
    const workers = Array.from({ length: 12 }, () =>
      runToExit(['bun', join(REPO_ROOT, 'packages/typescript/broker/test/fixtures/create-broker-instance.ts'), home], {
        env: fixtureEnvironment(join(root, 'instance-race-env'), join(root, 'instance-race-bin')),
        label: 'first start',
      }));
    const outcomes = await Promise.all(workers);
    expect(outcomes.map((outcome) => outcome.exitCode)).toEqual(Array(12).fill(0));
    const ids = new Set(outcomes.map((outcome) => outcome.stdout.trim()));
    expect(ids.size).toBe(1);
    const persisted = JSON.parse(readFileSync(join(home, 'broker-instance.json'), 'utf8'));
    expect(persisted.instanceId).toBe([...ids][0]);
    expect(persisted.version).toBe(2);
  });
});

// ── An installed broker ────────────────────────────────────────────────────

describe('an installed broker', () => {
  let installed: InstalledBroker;
  let broker: Broker;
  const configPath = () => join(broker.paths.cosyncingHome, 'config.json');

  beforeAll(async () => {
    installed = await startInstalledBroker({
      name: 'startup-installed',
      setup: (paths, port) => {
        // What an older setup and a newer client may have left in config.json.
        const current = JSON.parse(readFileSync(join(paths.cosyncingHome, 'config.json'), 'utf8'));
        writeFileSync(join(paths.cosyncingHome, 'config.json'), JSON.stringify({
          ...current,
          ownerExtension: { preserved: true },
          broker: {
            ...current.broker,
            host: '0.0.0.0',
            internalUrl: `http://nonloopback.example.test:${port}`,
            advertisedUrl: 'http://remote.example',
            nestedExtension: 'keep-me',
          },
        }), { mode: 0o600 });
      },
    });
    broker = installed.broker;
  });
  afterAll(() => installed?.stop());

  test('authenticates the owner and the Pi bridge from their files, and nothing else', async () => {
    const { brokerToken, piCredential } = installed.credentials;
    expect((await installed.owner.get('/api/sessions')).status).toBe(200);
    expect((await broker.client({ kind: 'none' }).get('/api/sessions')).status).toBe(401);
    const pi = { 'x-cosyncing-integration-token': piCredential };
    expect((await fetch(`${broker.url}/pi/bridge/status?id=missing`, { headers: pi })).status).toBe(200);
    expect((await fetch(`${broker.url}/pi/bridge/status?id=missing`, {
      headers: { [PRODUCT_IDENTITY.tokenHeader]: piCredential },
    })).status).toBe(401);
    expect((await fetch(`${broker.url}/api/machines`, { headers: pi })).status).toBe(401);
    expect(brokerToken).not.toBe(piCredential);
  });

  test('listens on loopback only, whatever an old configuration said', async () => {
    const health = await installed.owner.get('/api/health');
    expect(health.body.machine).toBe(installed.machineLabel);
    const external = Object.values(networkInterfaces()).flat()
      .find((address) => address && address.family === 'IPv4' && !address.internal);
    if (external) {
      const reached = await fetch(`http://${external.address}:${broker.port}/api/health`, {
        signal: AbortSignal.timeout(5_000),
      }).then(() => true, () => false);
      expect(reached).toBe(false);
    }
  });

  test('a configuration change keeps additive fields, drops listener fields, and stays owner-only', async () => {
    const changed = await installed.owner.post('/api/broker/features/workspace-browsing', {
      enabled: true,
      confirmRemoteFileAccess: true,
    });
    expect(changed.ok).toBe(true);
    const written = JSON.parse(readFileSync(configPath(), 'utf8'));
    expect(written.schemaVersion).toBe(2);
    expect(written.features?.httpWorkspaceBrowsing).toBe(true);
    expect(written.ownerExtension).toEqual({ preserved: true });
    expect(written.broker.nestedExtension).toBe('keep-me');
    expect(written.broker.port).toBe(broker.port);
    expect(written.broker.host).toBeUndefined();
    expect(written.broker.internalUrl).toBeUndefined();
    expect(written.broker.advertisedUrl).toBeUndefined();
    if (process.platform !== 'win32') {
      expect(statSync(configPath()).mode & 0o777).toBe(0o600);
      expect(statSync(broker.paths.cosyncingHome).mode & 0o777).toBe(0o700);
    }
  });

  test('a remote pairing QR carries the requested HTTPS URL and no credential', async () => {
    const offer = await createOffer(installed.owner, { brokerUrl: 'https://fixture-machine.tailnet.example' });
    expect(offer.payload.transport).toEqual({ kind: 'broker-url', url: 'https://fixture-machine.tailnet.example' });
    expect(offer.qr).not.toContain(installed.credentials.brokerToken);
  });

  test('no credential appears in the broker\'s command line or anything it has logged', async () => {
    const { brokerToken, piCredential, ompCredential } = installed.credentials;
    const commandLine = commandLineOf(broker.pid!);
    expect(commandLine.trim().length).toBeGreaterThan(0);
    for (const secret of [brokerToken, piCredential, ompCredential]) {
      expect(commandLine.includes(secret)).toBe(false);
    }
    // Restart so the log covers a whole shutdown and a whole startup.
    await broker.restart();
    expect((await installed.owner.get('/api/sessions')).status).toBe(200);
    const logs = broker.output();
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [brokerToken, piCredential, ompCredential]) {
      expect(logs.includes(secret)).toBe(false);
    }
  });
});

// ── Degraded but live ──────────────────────────────────────────────────────

describe('damaged state', () => {
  test('an unusable artifact directory leaves the broker live but critical, and artifacts still deliver', async () => {
    let blocked = '';
    const broker = await startBroker({
      name: 'startup-artifact-root',
      env: (paths) => {
        blocked = join(paths.root, 'cache-is-a-file');
        writeFileSync(blocked, 'blocked');
        return { COSYNCING_CACHE_DIR: blocked };
      },
    });
    try {
      const health = await broker.client().get('/api/health');
      expect(health.status).toBe(200);
      expect(health.body.ok).toBe(true);
      expect(health.body.healthStatus).toBe('critical');
      const detail = await broker.client().get('/api/broker/health');
      expect(detail.body.components['artifact-filesystem'].status).toBe('critical');
      expect(detail.text).not.toContain(blocked);

      // The process-local fallback: a file surfaced now still reaches a client.
      const cwd = join(broker.paths.root, 'workspace');
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, 'fallback.txt'), 'served from the fallback');
      const hello = await broker.client().post('/pi/bridge/hello', {
        sessionFile: join(broker.paths.root, 'pi-fallback.jsonl'), cwd, title: 'fallback',
      });
      const id = String(hello.body.id);
      const stream = await broker.client().attach('pi', id, { artifactMode: 'reference' });
      await stream.waitForKind('history');
      expect((await broker.client().post('/pi/bridge/send-file', { id, path: join(cwd, 'fallback.txt') })).status).toBe(200);
      const artifact = await stream.waitForMessage((message) => message.type === 'file-artifact' && message.name === 'fallback.txt');
      const url = String(artifact.fetchUrl ?? '');
      expect(url).not.toBe('');
      const fetched = await fetch(new URL(url, broker.url));
      expect(fetched.status).toBe(200);
      expect(await fetched.text()).toBe('served from the fallback');
      stream.close();
    } finally {
      await broker.stop();
    }
  });

  // No broker can read any of these, so pairing may start a new store, but never over the old bytes:
  // they are set aside beside it, where health reports them as recovered corruption.
  const UNREADABLE_PEER_STORES: Array<[what: string, bytes: string]> = [
    ['a malformed peer store', '{ malformed peer state'],
    ['a peer store holding JSON null', 'null\n'],
    ['a peer store with no peer list', '{"version":2,"peers":{}}\n'],
  ];
  for (const [what, bytes] of UNREADABLE_PEER_STORES) {
    test(`${what} is reported with a stable code and no path, and pairing recovers it without erasing it`, async () => {
      const broker = await startBroker({
        name: 'startup-malformed-peers',
        token: true,
        setup: (paths) => writeFileSync(join(paths.cosyncingHome, 'transport-peers.json'), bytes, { mode: 0o600 }),
      });
      try {
        const health = await broker.client().get('/api/broker/health');
        expect(health.status).toBe(200);
        expect(health.body.status).toBe('critical');
        expect(health.body.components['security-state'].detailCodes).toContain('peers-malformed');
        expect(health.text).not.toContain(broker.paths.root);
        expect((await broker.client().get('/api/transport/peers')).body.peers).toEqual([]);

        await pairDevice(broker.client(), { peerId: 'phone-after-malformed' });
        expect(readPeerStore(broker.paths.cosyncingHome).map((peer) => peer.peerId)).toEqual(['phone-after-malformed']);
        const setAside = readdirSync(broker.paths.cosyncingHome).filter((name) => name.startsWith('transport-peers.json.corrupt-'));
        expect(setAside).toHaveLength(1);
        expect(readFileSync(join(broker.paths.cosyncingHome, setAside[0]!), 'utf8')).toBe(bytes);
        await eventually(async () => {
          const after = await broker.client().get('/api/broker/health');
          const codes: string[] = after.body.components['security-state'].detailCodes;
          return !codes.includes('peers-malformed') && codes.includes('peers-corruption-recovered');
        }, { what: 'the security state to report recovered corruption once the store is rewritten' });
      } finally {
        await broker.stop();
      }
    });
  }

  test('a peer store from a newer broker is never rewritten: pairing and revocation refuse', async () => {
    // A downgrade: the newer broker's devices are lost to this one, but must not be lost to that one.
    const newer = `${JSON.stringify({
      version: 3,
      peers: [storedPeer('from-newer-broker', KNOWN_ROLE_TOKEN, ['observe'])],
      storedBy: 'a-newer-broker',
    })}\n`;
    const broker = await startBroker({
      name: 'startup-newer-peer-store',
      token: true,
      setup: (paths) => writeFileSync(join(paths.cosyncingHome, 'transport-peers.json'), newer, { mode: 0o600 }),
    });
    try {
      const owner = broker.client();
      const home = broker.paths.cosyncingHome;
      const health = await owner.get('/api/broker/health');
      expect(health.body.status).toBe('critical');
      expect(health.body.components['security-state'].detailCodes).toContain('peers-unsupported-version');
      expect(health.text).not.toContain(broker.paths.root);
      expect((await broker.client({ kind: 'peer', peerToken: KNOWN_ROLE_TOKEN }).get('/api/sessions')).status).toBe(401);
      expect((await owner.get('/api/transport/peers')).body.peers).toEqual([]);

      const offer = await owner.post('/api/transport/pairings', { clientLabel: 'phone' });
      expect(offer.status).toBe(409);
      expect(offer.body.code).toBe('PERSISTENCE_FAILED');
      expect(offer.text).not.toContain(broker.paths.root);
      const revoke = await owner.delete('/api/transport/peers/peer-from-newer-broker');
      expect(revoke.status).toBe(409);
      expect(revoke.body.code).toBe('PERSISTENCE_FAILED');

      expect(readFileSync(join(home, 'transport-peers.json'), 'utf8')).toBe(newer);
      expect(readdirSync(home).filter((name) => name.startsWith('transport-peers.json.'))).toEqual([]);
      expect((await owner.get('/api/broker/health')).body.components['security-state'].detailCodes)
        .toContain('peers-unsupported-version');
    } finally {
      await broker.stop();
    }
  });

  test('a structurally broken device record admits nothing, shows in health, and survives a pairing as stored', async () => {
    const { identityPublicKey: _missing, ...broken } = storedPeer('broken', BROKEN_RECORD_TOKEN, ['observe', 'drive', 'files']);
    const known = storedPeer('known-role', KNOWN_ROLE_TOKEN, ['observe', 'drive', 'files']);
    const broker = await startBroker({
      name: 'startup-broken-peer-record',
      token: true,
      setup: (paths) => writePeerStore(paths.cosyncingHome, [known, broken, null as unknown as Record<string, unknown>]),
    });
    try {
      const owner = broker.client();
      const asKnown = broker.client({ kind: 'peer', peerToken: KNOWN_ROLE_TOKEN });
      expect((await broker.client({ kind: 'peer', peerToken: BROKEN_RECORD_TOKEN }).get('/api/sessions')).status).toBe(401);
      expect((await asKnown.get('/api/sessions')).status).toBe(200);
      expect((await owner.get('/api/transport/peers')).body.peers.map((peer: any) => peer.peerId)).toEqual(['peer-known-role']);
      const health = await owner.get('/api/broker/health');
      expect(health.body.status).toBe('degraded');
      expect(health.body.components['security-state']).toMatchObject({ status: 'degraded', detailCodes: ['peers-record-malformed'] });
      expect(health.text).not.toContain(broker.paths.root);

      await pairDevice(owner, { peerId: 'phone-after-broken-record' });
      const stored = readPeerStore(broker.paths.cosyncingHome);
      expect(stored.map((peer) => peer?.peerId ?? null)).toEqual(['peer-known-role', 'phone-after-broken-record', 'peer-broken', null]);
      expect(JSON.stringify(stored[2])).toBe(JSON.stringify(broken));
      expect((await asKnown.get('/api/sessions')).status).toBe(200);
      expect((await broker.client({ kind: 'peer', peerToken: BROKEN_RECORD_TOKEN }).get('/api/sessions')).status).toBe(401);
      expect((await owner.get('/api/broker/health')).body.components['security-state'].detailCodes).toEqual(['peers-record-malformed']);
    } finally {
      await broker.stop();
    }
  });

  test('a stored device holding a role nobody can grant admits nobody, and health says so', async () => {
    // Structurally valid, so only the authorization check can refuse it: not even
    // the role it shares with this broker ('observe') admits it.
    const broker = await startBroker({
      name: 'startup-unknown-peer-role',
      token: true,
      setup: (paths) => writePeerStore(paths.cosyncingHome, [
        storedPeer('unknown-role', UNKNOWN_ROLE_TOKEN, ['observe', 'invalid-role']),
      ]),
    });
    try {
      const asDevice = broker.client({ kind: 'peer', peerToken: UNKNOWN_ROLE_TOKEN });
      expect((await asDevice.get('/api/sessions')).status).toBe(401);
      expect((await asDevice.get('/api/broker/health')).status).toBe(401);
      expect((await asDevice.get('/api/transport/peers')).status).toBe(401);
      expect((await broker.client().get('/api/transport/peers')).body.peers).toEqual([]);
      const health = await broker.client().get('/api/broker/health');
      expect(health.body.status).toBe('degraded');
      expect(health.body.components['security-state']).toMatchObject({ status: 'degraded', detailCodes: ['peers-unknown-role'] });
      expect(health.text).not.toContain(broker.paths.root);
      expect(health.text).not.toContain('peer-unknown-role');
    } finally {
      await broker.stop();
    }
  });

  test('a device holding a role nobody can grant costs only itself, and no rewrite erases it', async () => {
    // The likeliest cause is a downgrade: a newer broker granted a role this one
    // does not know. The record must survive this broker for the newer one.
    const unknown = storedPeer('unknown-role', UNKNOWN_ROLE_TOKEN, ['observe', 'invalid-role'], { grantedBy: 'a-newer-broker' });
    // A readable record can carry fields this broker does not read; they are a newer broker's too.
    const known = storedPeer('known-role', KNOWN_ROLE_TOKEN, ['observe', 'drive', 'files'], { deviceClass: { kind: 'tablet' } });
    const broker = await startBroker({
      name: 'startup-unknown-peer-role-beside-others',
      token: true,
      setup: (paths) => writePeerStore(paths.cosyncingHome, [unknown, known]),
    });
    try {
      const owner = broker.client();
      const asKnown = broker.client({ kind: 'peer', peerToken: KNOWN_ROLE_TOKEN });
      const asUnknown = broker.client({ kind: 'peer', peerToken: UNKNOWN_ROLE_TOKEN });
      const peerIds = async (): Promise<string[]> =>
        (await owner.get('/api/transport/peers')).body.peers.map((peer: any) => peer.peerId).sort();
      const storedRecord = (peerId: string): Record<string, unknown> | undefined =>
        readPeerStore(broker.paths.cosyncingHome).find((peer) => peer.peerId === peerId);

      // The other device keeps its credential and its roles; only the unknown one is refused.
      expect((await asKnown.get('/api/sessions')).status).toBe(200);
      expect((await asKnown.get('/api/broker/health')).body.principal).toEqual({ kind: 'peer', roles: ['drive', 'files', 'observe'] });
      expect((await asUnknown.get('/api/sessions')).status).toBe(401);
      expect(await peerIds()).toEqual(['peer-known-role']);
      const listed = (await owner.get('/api/transport/peers')).body.peers[0];
      expect(listed).not.toHaveProperty('deviceClass');
      expect(listed).not.toHaveProperty('extraFields');
      const health = await owner.get('/api/broker/health');
      expect(health.body.status).toBe('degraded');
      expect(health.body.components['security-state'].status).toBe('degraded');
      expect(health.body.components['security-state'].detailCodes).toContain('peers-unknown-role');
      expect(health.text).not.toContain(broker.paths.root);

      // Pairing rewrites the store: every record survives, the refused one field for field.
      const phone = await pairDevice(owner, { peerId: 'phone-after-unknown-role' });
      expect(readPeerStore(broker.paths.cosyncingHome).map((peer) => peer.peerId).sort())
        .toEqual(['peer-known-role', 'peer-unknown-role', 'phone-after-unknown-role']);
      expect(JSON.stringify(storedRecord('peer-unknown-role'))).toBe(JSON.stringify(unknown));
      expect(storedRecord('peer-known-role')).toEqual(known);
      expect((await asKnown.get('/api/sessions')).status).toBe(200);
      expect((await broker.client({ kind: 'peer', peerToken: phone.peerToken }).get('/api/sessions')).status).toBe(200);
      expect((await asUnknown.get('/api/sessions')).status).toBe(401);
      expect(await peerIds()).toEqual(['peer-known-role', 'phone-after-unknown-role']);

      // Revoking another device rewrites the store again; the refused record is still untouched.
      expect((await owner.delete('/api/transport/peers/phone-after-unknown-role')).body).toEqual({ ok: true, revoked: true });
      expect(JSON.stringify(storedRecord('peer-unknown-role'))).toBe(JSON.stringify(unknown));
      expect((await asKnown.get('/api/sessions')).status).toBe(200);

      // The owner can still revoke the refused record by id: only its revocation is added.
      expect((await owner.delete('/api/transport/peers/peer-unknown-role')).body).toEqual({ ok: true, revoked: true });
      const revoked = storedRecord('peer-unknown-role')!;
      expect(typeof revoked.revokedAt).toBe('string');
      expect(revoked).toEqual({ ...unknown, authGeneration: 2, revokedAt: revoked.revokedAt });
      expect(storedRecord('peer-known-role')).toEqual(known);
      const afterRevoke = await owner.get('/api/broker/health');
      expect(afterRevoke.body.components['security-state'].detailCodes).not.toContain('peers-unknown-role');

      // A restart reads the same store back: the revocation holds and the other device still works.
      await broker.restart();
      expect((await owner.get('/api/broker/health')).body.components['security-state'].detailCodes).not.toContain('peers-unknown-role');
      expect((await owner.delete('/api/transport/peers/peer-unknown-role')).body).toEqual({ ok: true, revoked: false });
      expect((await asKnown.get('/api/sessions')).status).toBe(200);
      expect((await asUnknown.get('/api/sessions')).status).toBe(401);
      expect(await peerIds()).toEqual(['peer-known-role']);
      expect(storedRecord('peer-unknown-role')).toEqual(revoked);
    } finally {
      await broker.stop();
    }
  });

  test('a corrupt attention store is recovered at startup and stays visible as recovered corruption', async () => {
    const broker = await startBroker({
      name: 'startup-corrupt-attention',
      setup: (paths) => writeFileSync(join(paths.cosyncingHome, 'attention-events.json'), '{not json', { mode: 0o600 }),
    });
    try {
      const events = await broker.client().get('/api/attention-events?clientId=startup-e2e');
      expect(events.status).toBe(200);
      const health = await broker.client().get('/api/broker/health');
      expect(health.body.components['attention-store']).toMatchObject({ status: 'degraded', detailCodes: ['startup-corrupt'] });
      expect(health.body.components['security-state'].detailCodes).toContain('attention-corruption-recovered');
      expect(health.body.status).toBe('degraded');
      expect(health.text).not.toContain(broker.paths.root);
    } finally {
      await broker.stop();
    }
  });
});
