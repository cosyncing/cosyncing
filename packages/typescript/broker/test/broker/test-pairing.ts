import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIdentityKeyPair, generateX25519KeyPair, parseQrPairingPayload } from '@cosyncing/crypto';
import {
  pairingBrokerUrlUsesUnprotectedHttp,
  normalizePairingBrokerUrl,
  PairingBrokerUrlError,
} from '../../src/transport/pairing-url.ts';
import { ScheduleStore } from '../../src/scheduling/schedule-store.ts';
import {
  AUTHORIZATION_PROVENANCE_MIGRATION_FILE,
  AUTHORIZATION_PROVENANCE_MIGRATION_ID,
  completeAuthorizationProvenanceMigration,
} from '../../src/security/authorization-provenance-migration.ts';
import {
  authorizationMigrationRollbackFenceActive,
  loadOrCreateBrokerInstance,
} from '../../src/runtime/broker-instance.ts';
import { PairingHttpError, tokenHash, TransportPairingRegistry } from '../../src/transport/transport-pairing.ts';
import { WakePushRegistry } from '../../src/transport/push-wake.ts';
import { terminalSafeText } from '../../src/cli/operator-commands.ts';

const home = mkdtempSync(join(tmpdir(), 'cosyncing-pairing-'));

try {
  const registry = new TransportPairingRegistry({ home, now: () => Date.parse('2026-08-22T12:00:00Z') });

  const urlFree = parseQrPairingPayload(registry.createOffer({ clientLabel: 'phone' }).qr);
  assert.equal(urlFree.version, 3);
  assert.equal(urlFree.transport.kind, 'broker-url');
  assert.equal('url' in urlFree.transport, false);

  const reachable = parseQrPairingPayload(registry.createOffer({
    brokerUrl: 'https://example.test/',
  }).qr);
  assert.deepEqual(reachable.transport, { kind: 'broker-url', url: 'https://example.test' });

  assert.equal(normalizePairingBrokerUrl('http://127.0.0.1:7734/'), 'http://127.0.0.1:7734');
  assert.equal(normalizePairingBrokerUrl(undefined), undefined);
  assert.equal(pairingBrokerUrlUsesUnprotectedHttp('http://127.0.0.1:7734'), false);
  assert.equal(pairingBrokerUrlUsesUnprotectedHttp('http://broker.example:7734'), true);
  assert.throws(() => normalizePairingBrokerUrl('ftp://example.test'), PairingBrokerUrlError);
  assert.throws(() => normalizePairingBrokerUrl('https://user:secret@example.test'), PairingBrokerUrlError);
  assert.throws(() => registry.createOffer({ brokerUrl: 'https://example.test/path' }), (error: unknown) =>
    error instanceof PairingHttpError && error.code === 'PAIRING_INVALID_INPUT');

  const invalid = JSON.parse(readFileSync(join(
    import.meta.dir,
    '../../../crypto/test-vectors/pairing-invalid.json',
  ), 'utf8')) as { cases: Array<{ name: string; payload: unknown }> };
  for (const fixture of invalid.cases) {
    const qr = `cosyncing://pair?payload=${Buffer.from(JSON.stringify(fixture.payload)).toString('base64url')}`;
    assert.throws(() => parseQrPairingPayload(qr), Error, fixture.name);
  }

  const inert = terminalSafeText('legacy\npeer\u001b]52;c;payload\u0007');
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(inert), false);
  assert.match(inert, /\\u001b/);

  const validInput = (suffix: string) => ({
    peerId: `client-${suffix}`,
    peerToken: Buffer.alloc(32, suffix.charCodeAt(0)).toString('base64url'),
    identityPublicKey: generateIdentityKeyPair().publicKey,
    exchangePublicKey: generateX25519KeyPair().publicKey,
  });

  if (process.platform !== 'win32') {
    const writeHome = mkdtempSync(join(tmpdir(), 'cosyncing-pairing-write-failure-'));
    try {
      const writeRegistry = new TransportPairingRegistry({ home: writeHome });
      const offer = writeRegistry.createOffer();
      chmodSync(writeHome, 0o500);
      assert.throws(() => writeRegistry.accept(offer.pairingId, validInput('w')), Error);
      assert.deepEqual(writeRegistry.listPeers(), []);
      assert.equal(writeRegistry.getOfferStatus(offer.pairingId)?.state, 'pending');
      chmodSync(writeHome, 0o700);
      assert.equal(writeRegistry.accept(offer.pairingId, validInput('w')).peer.peerId, 'client-w');
    } finally {
      chmodSync(writeHome, 0o700);
      rmSync(writeHome, { recursive: true, force: true });
    }
  }

  const renameHome = mkdtempSync(join(tmpdir(), 'cosyncing-pairing-rename-failure-'));
  try {
    const renameRegistry = new TransportPairingRegistry({ home: renameHome });
    const offer = renameRegistry.createOffer();
    mkdirSync(join(renameHome, 'transport-peers.json'));
    assert.throws(() => renameRegistry.accept(offer.pairingId, validInput('r')), Error);
    assert.deepEqual(renameRegistry.listPeers(), []);
    assert.equal(renameRegistry.getOfferStatus(offer.pairingId)?.state, 'pending');
    rmSync(join(renameHome, 'transport-peers.json'), { recursive: true });
    const acceptedInput = validInput('r');
    const accepted = renameRegistry.accept(offer.pairingId, acceptedInput);
    assert.equal(accepted.peer.peerId, 'client-r');
    const before = renameRegistry.authenticatePeerToken(accepted.broker.peerToken);
    assert.equal(before?.authGeneration, 1);
    assert.deepEqual([...before!.roles].sort(), ['drive', 'files', 'observe']);
    mkdirSync(join(renameHome, 'transport-peers.json.tmp'));
    assert.throws(() => renameRegistry.revokeWithState('client-r'), Error);
    assert.equal(renameRegistry.verifyAnyPeerToken(accepted.broker.peerToken), 'ok');
    rmSync(join(renameHome, 'transport-peers.json.tmp'), { recursive: true });
    const revocation = renameRegistry.revokeWithState('client-r');
    assert.equal(revocation?.authGeneration, 2);
    assert.equal(renameRegistry.verifyAnyPeerToken(accepted.broker.peerToken), 'unknown');
    const reloaded = new TransportPairingRegistry({ home: renameHome });
    assert.equal(reloaded.verifyAnyPeerToken(accepted.broker.peerToken), 'unknown');

    const repairOffer = reloaded.createOffer();
    const repaired = reloaded.accept(repairOffer.pairingId, acceptedInput);
    const repairedPrincipal = reloaded.authenticatePeerToken(repaired.broker.peerToken);
    assert.equal(repairedPrincipal?.authGeneration, 3, 're-pairing a revoked id must advance, not reset, its generation');
    assert.equal(reloaded.verifyAnyPeerToken(accepted.broker.peerToken), 'unknown');

    const peerStorePath = join(renameHome, 'transport-peers.json');
    const stored = JSON.parse(readFileSync(peerStorePath, 'utf8')) as { version: number; peers: Array<Record<string, unknown>> };
    stored.peers[0]!.roles = [];
    writeFileSync(peerStorePath, `${JSON.stringify(stored)}\n`);
    const zeroRoleReload = new TransportPairingRegistry({ home: renameHome });
    assert.deepEqual([...zeroRoleReload.authenticatePeerToken(repaired.broker.peerToken)!.roles], []);

    stored.peers[0]!.roles = ['invalid-role'];
    writeFileSync(peerStorePath, `${JSON.stringify(stored)}\n`);
    const malformedRoleReload = new TransportPairingRegistry({ home: renameHome });
    assert.equal(
      malformedRoleReload.authenticatePeerToken(repaired.broker.peerToken),
      undefined,
      'malformed stored authorization state must fail closed',
    );

    const legacyStore = structuredClone(stored);
    legacyStore.version = 1;
    delete legacyStore.peers[0]!.roles;
    writeFileSync(peerStorePath, `${JSON.stringify(legacyStore)}\n`);
    const legacyRoleReload = new TransportPairingRegistry({ home: renameHome });
    assert.equal(
      legacyRoleReload.authenticatePeerToken(repaired.broker.peerToken),
      undefined,
      'a legacy peer without revision-17 provenance is invalidated instead of receiving roles',
    );
    const migrated = JSON.parse(readFileSync(peerStorePath, 'utf8')) as {
      version: number;
      peers: Array<{ authGeneration: number; roles: string[]; revokedAt?: string }>;
    };
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated.peers[0]?.roles, []);
    assert.ok(migrated.peers[0]?.revokedAt);
    assert.ok((migrated.peers[0]?.authGeneration ?? 0) > (repairedPrincipal?.authGeneration ?? 0));
  } finally {
    rmSync(renameHome, { recursive: true, force: true });
  }

  // Cross-version adversarial fixture: revision 16 could not prove who created peers, schedules,
  // or wake destinations. All three stores must become inert before revision-17 startup proceeds.
  const migrationHome = mkdtempSync(join(tmpdir(), 'cosyncing-revision-17-migration-'));
  const migrationNow = Date.parse('2026-08-24T12:00:00Z');
  const legacyPeer = (peerId: string, peerToken: string) => ({
    peerId,
    identityPublicKey: `identity-${peerId}`,
    peerTokenHash: tokenHash(`mailbox-${peerId}`),
    brokerPeerId: `broker-${peerId}`,
    brokerPeerTokenHash: tokenHash(peerToken),
    brokerIdentityPublicKey: `broker-identity-${peerId}`,
    dataKey: { algorithm: 'AES-256-GCM', bytes: '' },
    wrappedDataKey: {},
    acceptedAt: new Date(0).toISOString(),
    authGeneration: 1,
  });
  try {
    writeFileSync(join(migrationHome, 'broker-instance.json'), JSON.stringify({
      version: 1,
      instanceId: 'broker_legacy_authorization_fixture_1234567890',
    }), { mode: 0o600 });
    const peerAToken = 'legacy-peer-a-token';
    const hiddenPeerBToken = 'legacy-hidden-peer-b-token';
    writeFileSync(join(migrationHome, 'transport-peers.json'), JSON.stringify({
      version: 1,
      peers: [legacyPeer('peer-a', peerAToken), legacyPeer('hidden-peer-b', hiddenPeerBToken)],
    }), { mode: 0o600 });
    writeFileSync(join(migrationHome, 'schedules.json'), JSON.stringify({
      version: 1,
      schedules: [
        {
          id: 'legacy-one-shot', revision: 1, kind: 'message', tool: 'codex', sessionId: 'session-a',
          text: 'legacy delayed command', at: migrationNow + 60_000, state: 'scheduled', createdAt: 1, updatedAt: 1,
        },
        {
          id: 'legacy-repeat', revision: 1, kind: 'new-session', tool: 'codex',
          text: 'legacy recurring command', at: migrationNow + 60_000, repeat: 'daily', state: 'scheduled',
          createdAt: 1, updatedAt: 1,
        },
      ],
    }), { mode: 0o600 });
    writeFileSync(join(migrationHome, 'push-wake-tokens.json'), JSON.stringify({
      version: 1,
      registrations: [{
        deviceId: 'legacy-attacker-phone', platform: 'fcm', token: 'legacy-push-token',
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      }],
    }), { mode: 0o600 });

    const instance = loadOrCreateBrokerInstance(migrationHome);
    assert.equal(instance.version, 2);
    assert.equal(authorizationMigrationRollbackFenceActive(migrationHome), true);
    const pairings = new TransportPairingRegistry({ home: migrationHome, now: () => migrationNow });
    const wake = new WakePushRegistry(migrationHome, {
      now: () => migrationNow,
      isPeerGenerationActive: (peerId, generation) => pairings.isPeerGenerationActive(peerId, generation),
    });
    const schedules = new ScheduleStore({ path: join(migrationHome, 'schedules.json'), now: () => migrationNow });
    completeAuthorizationProvenanceMigration(migrationHome, { now: () => new Date(migrationNow) });
    assert.equal(pairings.authenticatePeerToken(peerAToken), undefined);
    assert.equal(pairings.authenticatePeerToken(hiddenPeerBToken), undefined);
    assert.deepEqual(pairings.listPeers(), []);
    assert.deepEqual(schedules.due(migrationNow + 365 * 24 * 60 * 60_000), []);
    assert.ok(schedules.list().every((schedule) => schedule.state === 'canceled'));
    assert.deepEqual(wake.list({ kind: 'owner' }), []);
    assert.deepEqual(wake.listForDispatch(), []);

    const peerFile = JSON.parse(readFileSync(join(migrationHome, 'transport-peers.json'), 'utf8'));
    const scheduleFile = JSON.parse(readFileSync(join(migrationHome, 'schedules.json'), 'utf8'));
    const wakeFile = JSON.parse(readFileSync(join(migrationHome, 'push-wake-tokens.json'), 'utf8'));
    assert.equal(peerFile.version, 2);
    assert.ok(peerFile.peers.every((peer: any) => peer.revokedAt && peer.roles.length === 0));
    assert.ok(peerFile.peers.every((peer: any) => peer.securityRevision === undefined));
    assert.equal(scheduleFile.version, 2);
    assert.ok(scheduleFile.schedules.every((schedule: any) => schedule.createdBy.kind === 'legacy-unprovenanced'));
    assert.deepEqual(wakeFile, { version: 2, registrations: [] });
    assert.deepEqual(
      JSON.parse(readFileSync(join(migrationHome, AUTHORIZATION_PROVENANCE_MIGRATION_FILE), 'utf8')),
      {
        schemaVersion: 1,
        migration: AUTHORIZATION_PROVENANCE_MIGRATION_ID,
        completedAt: new Date(migrationNow).toISOString(),
      },
    );

    const offer = pairings.createOffer();
    const identity = generateIdentityKeyPair();
    const exchange = generateX25519KeyPair();
    const repaired = pairings.accept(offer.pairingId, {
      peerId: 'peer-a',
      peerToken: tokenHash('revision-17-peer-token'),
      identityPublicKey: identity.publicKey,
      exchangePublicKey: exchange.publicKey,
    });
    const principal = pairings.authenticatePeerToken(repaired.broker.peerToken);
    assert.ok(principal && principal.authGeneration > 2);
    assert.equal(pairings.revoke('peer-a'), true);
    assert.equal(pairings.authenticatePeerToken(repaired.broker.peerToken), undefined);
  } finally {
    rmSync(migrationHome, { recursive: true, force: true });
  }

  // Failure injection at every migration boundary. The frozen revision-16 instance-file rule was
  // exactly `version === 1`; once v2 is durable, an old broker cannot reach any still-v1 security
  // store even when a later replacement or the completion marker fails.
  const boundaryHome = (name: string) => mkdtempSync(join(tmpdir(), `cosyncing-auth-boundary-${name}-`));
  const seedBoundary = (target: string) => {
    writeFileSync(join(target, 'broker-instance.json'), JSON.stringify({
      version: 1,
      instanceId: 'broker_boundary_fixture_identity_1234567890',
    }), { mode: 0o600 });
    writeFileSync(join(target, 'transport-peers.json'), JSON.stringify({ version: 1, peers: [] }), { mode: 0o600 });
    writeFileSync(join(target, 'push-wake-tokens.json'), JSON.stringify({
      version: 1,
      registrations: [{
        deviceId: 'legacy-boundary-phone', platform: 'fcm', token: 'legacy-token',
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      }],
    }), { mode: 0o600 });
    writeFileSync(join(target, 'schedules.json'), JSON.stringify({
      version: 1,
      schedules: [{
        id: 'legacy-boundary-schedule', revision: 1, kind: 'message', tool: 'codex',
        sessionId: 'session-boundary', text: 'must remain inert', at: migrationNow + 60_000,
        state: 'scheduled', createdAt: 1, updatedAt: 1,
      }],
    }), { mode: 0o600 });
  };
  const storeVersion = (target: string, name: string) =>
    (JSON.parse(readFileSync(join(target, name), 'utf8')) as { version: number }).version;
  const revision16InstanceReaderAccepts = (target: string) =>
    (JSON.parse(readFileSync(join(target, 'broker-instance.json'), 'utf8')) as { version?: unknown }).version === 1;

  for (const boundary of ['fence', 'peer', 'wake', 'schedule', 'marker'] as const) {
    const target = boundaryHome(boundary);
    try {
      seedBoundary(target);
      if (boundary === 'fence') {
        assert.throws(() => loadOrCreateBrokerInstance(target, {
          beforeMigrationPersist: () => { throw new Error('injected fence failure'); },
        }));
        assert.equal(revision16InstanceReaderAccepts(target), true);
        assert.equal(storeVersion(target, 'transport-peers.json'), 1);
        continue;
      }

      loadOrCreateBrokerInstance(target);
      assert.equal(revision16InstanceReaderAccepts(target), false, `${boundary}: revision 16 must reject the fence`);
      if (boundary === 'peer') {
        assert.throws(() => new TransportPairingRegistry({
          home: target,
          beforeMigrationPersist: () => { throw new Error('injected peer failure'); },
        }));
        assert.equal(storeVersion(target, 'transport-peers.json'), 1);
        continue;
      }

      const pairings = new TransportPairingRegistry({ home: target });
      assert.equal(storeVersion(target, 'transport-peers.json'), 2);
      if (boundary === 'wake') {
        assert.throws(() => new WakePushRegistry(target, {
          beforeMigrationPersist: () => { throw new Error('injected wake failure'); },
        }));
        assert.equal(storeVersion(target, 'push-wake-tokens.json'), 1);
        continue;
      }

      new WakePushRegistry(target, {
        isPeerGenerationActive: (peerId, generation) => pairings.isPeerGenerationActive(peerId, generation),
      });
      assert.equal(storeVersion(target, 'push-wake-tokens.json'), 2);
      if (boundary === 'schedule') {
        assert.throws(() => new ScheduleStore({
          path: join(target, 'schedules.json'),
          beforeMigrationPersist: () => { throw new Error('injected schedule failure'); },
        }));
        assert.equal(storeVersion(target, 'schedules.json'), 1);
        continue;
      }

      new ScheduleStore({ path: join(target, 'schedules.json') });
      assert.equal(storeVersion(target, 'schedules.json'), 2);
      assert.throws(() => completeAuthorizationProvenanceMigration(target, {
        beforePersist: () => { throw new Error('injected marker failure'); },
      }));
      assert.equal(existsSync(join(target, AUTHORIZATION_PROVENANCE_MIGRATION_FILE)), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }

  const markerFailureHome = mkdtempSync(join(tmpdir(), 'cosyncing-revision-17-marker-failure-'));
  try {
    mkdirSync(join(markerFailureHome, AUTHORIZATION_PROVENANCE_MIGRATION_FILE));
    assert.throws(
      () => completeAuthorizationProvenanceMigration(markerFailureHome),
      Error,
      'a completion-marker write failure must escape startup instead of reporting readiness',
    );
  } finally {
    rmSync(markerFailureHome, { recursive: true, force: true });
  }

  console.log('PASS pairing, revision-17 migration, and failure-atomic persistence contracts');
} finally {
  rmSync(home, { recursive: true, force: true });
}
