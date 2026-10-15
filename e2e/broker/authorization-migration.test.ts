/**
 * Upgrading from contract revision 16 to 17 makes every earlier grant inert.
 *
 * Revision 16 let any paired device create another pairing, so nothing it
 * stored can prove the owner granted it: paired devices, scheduled sends and
 * push-wake registrations. The first revision-17 start crosses a one-way fence
 * (the broker instance file moves to version 2, which a revision-16 broker
 * refuses to start on), then revokes every legacy device, cancels every legacy
 * schedule, drops every wake registration, and records the migration.
 *
 * A home is seeded exactly as revision 16 left it and a real broker is started
 * on it. Then the same home is seeded again with one migration step made to
 * fail, at each boundary in turn: whatever the failure, the broker never
 * reports ready, and the home is never left where a revision-16 broker could
 * start and read a store revision 17 has already rewritten.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveLoopbackFixturePort } from '../../packages/typescript/broker/test/helpers/isolated-broker-fixture.ts';
import { type Broker, startBroker } from '../harness/index.ts';
import { BROKER_ENTRY, fixtureEnvironment, runToExit } from '../harness/cli.ts';
import { pairDevice } from '../harness/pairing.ts';

const hash = (token: string): string => createHash('sha256').update(token).digest('base64url');
const FUTURE = Date.now() + 24 * 60 * 60_000;

const LEGACY_PEER_TOKENS = { 'peer-a': 'legacy-peer-a-token', 'hidden-peer-b': 'legacy-hidden-peer-b-token' };

/** The four security stores as revision 16 wrote them. */
function seedRevision16(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const write = (name: string, value: unknown) =>
    writeFileSync(join(home, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  write('broker-instance.json', { version: 1, instanceId: 'broker_legacy_authorization_fixture_1234567890' });
  write('transport-peers.json', {
    version: 1,
    peers: Object.entries(LEGACY_PEER_TOKENS).map(([peerId, token]) => ({
      peerId,
      identityPublicKey: `identity-${peerId}`,
      peerTokenHash: hash(`mailbox-${peerId}`),
      brokerPeerId: `broker-${peerId}`,
      brokerPeerTokenHash: hash(token),
      brokerIdentityPublicKey: `broker-identity-${peerId}`,
      dataKey: { algorithm: 'AES-256-GCM', bytes: '' },
      wrappedDataKey: {},
      acceptedAt: new Date(0).toISOString(),
      authGeneration: 1,
    })),
  });
  write('schedules.json', {
    version: 1,
    schedules: [
      {
        id: 'legacy-one-shot', revision: 1, kind: 'message', tool: 'codex', sessionId: 'session-a',
        text: 'legacy delayed command', at: FUTURE, state: 'scheduled', createdAt: 1, updatedAt: 1,
      },
      {
        id: 'legacy-repeat', revision: 1, kind: 'new-session', tool: 'codex',
        text: 'legacy recurring command', at: FUTURE, repeat: 'daily', state: 'scheduled', createdAt: 1, updatedAt: 1,
      },
    ],
  });
  write('push-wake-tokens.json', {
    version: 1,
    registrations: [{
      deviceId: 'legacy-attacker-phone', platform: 'fcm', token: 'legacy-push-token',
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    }],
  });
}

function version(home: string, name: string): unknown {
  return (JSON.parse(readFileSync(join(home, name), 'utf8')) as { version?: unknown }).version;
}

/** The whole of revision 16's startup check on the instance file. */
function revision16WouldStart(home: string): boolean {
  return version(home, 'broker-instance.json') === 1;
}

describe('a revision-16 home started by revision 17', () => {
  let broker: Broker;
  let home: string;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'rev17-migration',
      token: true,
      setup: (paths) => seedRevision16(paths.cosyncingHome),
    });
    home = broker.paths.cosyncingHome;
  });
  afterAll(() => broker?.stop());

  test('crosses the one-way fence before anything else', () => {
    expect(version(home, 'broker-instance.json')).toBe(2);
    expect(revision16WouldStart(home)).toBe(false);
  });

  test('every legacy device credential is dead and no device is listed', async () => {
    for (const token of Object.values(LEGACY_PEER_TOKENS)) {
      expect((await broker.client({ kind: 'peer', peerToken: token }).get('/api/sessions')).status).toBe(401);
    }
    expect((await broker.client().get('/api/transport/peers')).body.peers).toEqual([]);
    const peers = JSON.parse(readFileSync(join(home, 'transport-peers.json'), 'utf8'));
    expect(peers.version).toBe(2);
    expect(peers.peers.every((peer: any) => peer.revokedAt && peer.roles.length === 0)).toBe(true);
  });

  test('every legacy schedule is canceled and every wake registration is gone', async () => {
    const schedules = await broker.client().get('/api/schedules');
    expect(schedules.status).toBe(200);
    expect((schedules.body.schedules as any[]).every((schedule) => schedule.state === 'canceled')).toBe(true);
    const stored = JSON.parse(readFileSync(join(home, 'schedules.json'), 'utf8'));
    expect(stored.version).toBe(2);
    expect(stored.schedules.every((schedule: any) => schedule.createdBy?.kind === 'legacy-unprovenanced')).toBe(true);

    const wake = await broker.client().get('/api/push/wake-tokens');
    expect(wake.body.registrations).toEqual([]);
    expect(JSON.parse(readFileSync(join(home, 'push-wake-tokens.json'), 'utf8'))).toEqual({ version: 2, registrations: [] });
  });

  test('the migration is recorded, and a legacy device can pair again under a newer generation', async () => {
    const marker = JSON.parse(readFileSync(join(home, 'authorization-provenance-migration.json'), 'utf8'));
    expect(marker).toMatchObject({ schemaVersion: 1, migration: 'authorization-provenance-v1' });
    expect(typeof marker.completedAt).toBe('string');

    const device = await pairDevice(broker.client(), { peerId: 'peer-a' });
    expect((await broker.client({ kind: 'peer', peerToken: device.peerToken }).get('/api/sessions')).status).toBe(200);
    const record = JSON.parse(readFileSync(join(home, 'transport-peers.json'), 'utf8'))
      .peers.find((peer: any) => peer.peerId === 'peer-a');
    expect(record.authGeneration).toBeGreaterThan(2);
    expect(record.revokedAt).toBeUndefined();
  });
});

describe('a migration step that fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-rev17-boundaries-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /**
   * Seed a revision-16 home, break one step, and start revision 17 on it.
   * The break: the store's path is a symlink (the secure writer refuses a
   * symlink leaf) or, for the completion marker, a directory.
   */
  async function startWithBrokenStep(step: string, store: string): Promise<{ home: string; exitCode: number | null; output: string }> {
    const caseRoot = join(root, step);
    const home = join(caseRoot, 'cosyncing-home');
    const bin = join(caseRoot, 'bin');
    mkdirSync(bin, { recursive: true });
    seedRevision16(home);
    if (store === 'authorization-provenance-migration.json') {
      mkdirSync(join(home, store));
    } else {
      const real = join(caseRoot, `real-${store}`);
      writeFileSync(real, readFileSync(join(home, store)), { mode: 0o600 });
      rmSync(join(home, store));
      symlinkSync(real, join(home, store));
    }
    const lease = await reserveLoopbackFixturePort();
    await lease.release();
    const result = await runToExit(['bun', BROKER_ENTRY], {
      label: `broker with a broken ${step} step`,
      env: fixtureEnvironment(caseRoot, bin, {
        COSYNCING_HOME: home,
        COSYNCING_TOKEN: 'rev17-boundary-token',
        PORT: String(lease.port),
        HOST: '127.0.0.1',
      }),
    });
    expect(result.timedOut, `${step}: the broker must not keep running`).toBe(false);
    return { home, exitCode: result.exitCode, output: result.output };
  }

  const stores = ['transport-peers.json', 'push-wake-tokens.json', 'schedules.json'];

  test.each([
    ['fence', 'broker-instance.json'],
    ['peers', 'transport-peers.json'],
    ['wake registrations', 'push-wake-tokens.json'],
    ['schedules', 'schedules.json'],
    ['completion marker', 'authorization-provenance-migration.json'],
  ])('%s: the broker refuses to start, and revision 16 can never read a migrated store', async (step, store) => {
    const { home, exitCode, output } = await startWithBrokenStep(step, store);
    expect(exitCode, output).not.toBe(0);
    if (revision16WouldStart(home)) {
      // Nothing crossed the fence, so nothing behind it may have moved.
      for (const name of stores) expect(version(home, name), `${step}: ${name}`).toBe(1);
    }
    if (step === 'fence') {
      expect(revision16WouldStart(home)).toBe(true);
    } else {
      expect(revision16WouldStart(home)).toBe(false);
    }
    if (step !== 'completion marker') {
      // An interrupted migration is never recorded as complete.
      expect(existsSync(join(home, 'authorization-provenance-migration.json'))).toBe(false);
    }
    if (store !== 'broker-instance.json' && store !== 'authorization-provenance-migration.json') {
      // The step that failed left its store exactly as revision 16 wrote it.
      expect(version(home, store)).toBe(1);
    }
  });
});
