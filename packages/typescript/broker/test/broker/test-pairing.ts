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
import {
  runPairCommand,
  terminalSafeText,
  type PairCommandOptions,
} from '../../src/cli/operator-commands.ts';
import { defaultBrokerConfig, writeBrokerConfig } from '../../src/runtime/configuration.ts';
import { ensureInstallationCredentials } from '../../src/security/credentials.ts';
import { committedInstallState, writeInstallState } from '../../src/installation/install-state.ts';

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

  // `pair` is the command the installer's one-liner handoff runs, and its answer decides whether a fresh
  // install opens paired or opens "Connect this device". Two properties matter more here than its output:
  // a broker that is merely busy must not be reported as absent, and a one-use offer must never be minted
  // twice for one client. Both were measured on an installed broker where /api/health stalls for seconds
  // about once a minute while roster discovery runs.
  {
    const pairHome = mkdtempSync(join(tmpdir(), 'cosyncing-pair-command-'));
    try {
      const pairConfig = defaultBrokerConfig();
      pairConfig.broker.machineLabel = 'pair-fixture-machine';
      writeBrokerConfig(pairConfig, pairHome);
      ensureInstallationCredentials({ home: pairHome, internalUrl: pairConfig.broker.internalUrl });
      writeInstallState(committedInstallState(), pairHome);
      const brokerUrl = pairConfig.broker.internalUrl;
      const offer = registry.createOffer({ brokerUrl });
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
        status, headers: { 'content-type': 'application/json' },
      });
      const health = (): Response => json({ ok: true, product: 'cosyncing', machine: 'pair-fixture-machine' });
      const created = (): Response => json({
        ok: true,
        pairingId: offer.pairingId,
        qr: offer.qr,
        expiresAt: new Date(Date.parse('2026-08-22T12:05:00Z')).toISOString(),
        brokerPeerId: 'peer_broker',
      }, 201);
      // Quiet by default; a case that needs to read what the command printed passes its own writer.
      const options = (extra: Partial<PairCommandOptions> = {}): PairCommandOptions => ({
        json: true,
        wait: false,
        brokerUrl,
        home: pairHome,
        invocation: 'cosyncing',
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        ...extra,
      });

      // A broker that goes quiet twice and then answers is a busy broker. One missed sample used to end
      // this command with "not reachable", and the installer turned that into a skipped handoff.
      const busyCalls: string[] = [];
      let busyHealth = 0;
      const busy = await runPairCommand(options(), {
        sleep: async () => {},
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          busyCalls.push(`${init?.method ?? 'GET'} ${path}`);
          if (path !== '/api/health') return created();
          busyHealth += 1;
          if (busyHealth < 3) throw new Error('ECONNREFUSED');
          return health();
        },
      });
      assert.equal(busy.exitCode, 0, 'a busy broker must not be reported as an absent one');
      assert.equal(busyHealth, 3, 'the identity read is retried until it answers');
      assert.equal(busyCalls.filter((call) => call.startsWith('POST')).length, 1,
        'waiting out the identity read must not create a second offer');

      // Something answering as another product named itself on the first probe. Asking again only delays
      // the answer, and offering pairing through a foreign socket is not a fallback.
      const foreignCalls: string[] = [];
      const foreign = await runPairCommand(options(), {
        sleep: async () => {},
        fetch: async (input, init) => {
          foreignCalls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
          return json({ ok: true, product: 'other-product', machine: 'somewhere-else' });
        },
      });
      assert.equal(foreign.exitCode, 1);
      assert.equal(foreign.detailCode, 'local-broker-identity-mismatch');
      assert.equal(foreignCalls.length, 1, 'a service that identified itself is not waited out');
      assert.equal(foreignCalls.filter((call) => call.startsWith('POST')).length, 0);

      // A cosyncing endpoint that answers WITHOUT taking our credential. `/api/health` replies to a request
      // it did not authenticate with `{ok, product, version}` and withholds the machine label, and reading
      // that as a foreign service sends the operator to stop the wrong process. It is not proof of local
      // ownership either -- another cosyncing installation answers the same way to a token it does not
      // recognise -- and it is a state that can clear on its own, because a broker restarted moments after
      // its token was written answers like this too. So it is waited out, then named for what it is.
      let unauthElapsed = 0;
      const unauthCalls: string[] = [];
      const unauthWritten: string[] = [];
      const unauthenticated = await runPairCommand(options({
        stderr: { write: (text: string) => { unauthWritten.push(text); } },
      }), {
        platform: 'linux',
        now: () => unauthElapsed,
        sleep: async (milliseconds) => { unauthElapsed += milliseconds; },
        fetch: async (input, init) => {
          unauthCalls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
          return json({ ok: true, product: 'cosyncing', version: '0.0.0' });
        },
      });
      assert.equal(unauthenticated.exitCode, 1);
      assert.equal(unauthenticated.detailCode, 'local-broker-credential-unauthenticated',
        'a broker that answers as itself without our credential is not a foreign service');
      assert.ok(unauthCalls.length > 1, 'a credential it has not taken yet gets the deadline, not one probe');
      assert.ok(unauthElapsed >= 10_000, `the identity deadline was honoured: ${unauthElapsed}ms`);
      assert.equal(unauthCalls.filter((call) => call.startsWith('POST')).length, 0,
        'no offer is minted through an endpoint that will not authenticate us');
      // What the operator is TOLD is the other half of this fault. A withheld machine label proves the
      // credential was not accepted and nothing else -- a second installation behind a WSL port relay
      // answers identically -- so the sentence belongs to the endpoint that answered rather than to the
      // installation asking. The repair cannot be `setup` either: that rewrites this machine's token, which
      // is not the thing known to be wrong, and it walks past the one question worth asking, which owns
      // the port.
      const unauthText = unauthWritten.join('');
      assert.ok(unauthText.includes('A cosyncing endpoint on port 7734'),
        `the fault names the endpoint by its port: ${unauthText}`);
      assert.ok(unauthText.includes("did not accept this installation's credential"),
        `the fault names the credential: ${unauthText}`);
      assert.equal(/local broker/i.test(unauthText), false,
        `an unauthenticated answer proves nothing about who owns the endpoint: ${unauthText}`);
      assert.equal(unauthText.includes('Run: cosyncing setup'), false,
        `setup is not the repair for an endpoint whose owner is unknown: ${unauthText}`);
      assert.ok(unauthText.includes('ss -ltnp | grep :7734'),
        `the guidance names a listener probe: ${unauthText}`);
      // A probe the operator can run, on their host. Windows has no `ss`.
      let unauthWindowsElapsed = 0;
      const unauthWindowsWritten: string[] = [];
      const unauthWindows = await runPairCommand(options({
        stderr: { write: (text: string) => { unauthWindowsWritten.push(text); } },
      }), {
        platform: 'win32',
        now: () => unauthWindowsElapsed,
        sleep: async (milliseconds) => { unauthWindowsElapsed += milliseconds; },
        fetch: async () => json({ ok: true, product: 'cosyncing', version: '0.0.0' }),
      });
      assert.equal(unauthWindows.detailCode, 'local-broker-credential-unauthenticated');
      const unauthWindowsText = unauthWindowsWritten.join('');
      assert.ok(unauthWindowsText.includes('Get-NetTCPConnection -LocalPort 7734'),
        `the Windows guidance names a cmdlet: ${unauthWindowsText}`);
      assert.equal(unauthWindowsText.includes('ss -ltnp'), false,
        `a command the operator does not have is not guidance: ${unauthWindowsText}`);

      // A broker answering with SOMEONE ELSE'S machine label has answered the identity question, and
      // asking it again only holds the installer over a port that is not its own.
      const labelCalls: string[] = [];
      const mislabelled = await runPairCommand(options(), {
        sleep: async () => {},
        fetch: async (input, init) => {
          labelCalls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
          return json({ ok: true, product: 'cosyncing', machine: 'some-other-machine' });
        },
      });
      assert.equal(mislabelled.detailCode, 'local-broker-identity-mismatch');
      assert.equal(labelCalls.length, 1, 'a label that is present and different is a verdict');

      // A POST whose ANSWER was lost is not a POST that did not happen. The offer may be sitting on the
      // broker right now, and a second one mints a second identity for one device.
      const lostCalls: string[] = [];
      const lost = await runPairCommand(options(), {
        sleep: async () => {},
        fetch: async (input, init) => {
          const method = init?.method ?? 'GET';
          lostCalls.push(`${method} ${new URL(String(input)).pathname}`);
          if (method === 'POST') throw new Error('socket closed before the response');
          return health();
        },
      });
      assert.equal(lost.detailCode, 'pairing-create-unverified');
      assert.equal(lostCalls.filter((call) => call.startsWith('POST')).length, 1,
        'an unanswered offer request is never retried as though it had not been sent');

      // Did the client pair? The offer file cannot answer -- the client deletes it BEFORE asking for its
      // credential -- so the broker is the only witness, and its three answers stay three.
      const clock = { now: 0 };
      const watcher = {
        now: () => clock.now,
        sleep: async (milliseconds: number) => { clock.now += milliseconds; },
      };
      // `read` counts the reads of the OFFER, not of the endpoint: every case here settles identity first,
      // and a case that answers differently over time is asking about the broker's record, not its health.
      const askAbout = async (respond: (read: number) => Response): Promise<{
        result: { exitCode: number; detailCode: string }; stdout: string; calls: string[];
      }> => {
        clock.now = 0;
        const calls: string[] = [];
        const lines: string[] = [];
        let reads = 0;
        const result = await runPairCommand(options({
          statusPairingId: offer.pairingId,
          statusTimeoutSeconds: 2,
          stdout: { write: (text) => { lines.push(text); } },
        }), {
          ...watcher,
          fetch: async (input, init) => {
            const path = new URL(String(input)).pathname;
            calls.push(`${init?.method ?? 'GET'} ${path}`);
            // Identity is settled before any read of an offer, so the fixture keeps answering that route
            // correctly and lets each case decide only what the pairing read says.
            if (path === '/api/health') return health();
            reads += 1;
            return respond(reads);
          },
        });
        return { result, stdout: lines.join(''), calls };
      };

      // A 2xx that is not a pairing document is its own case. The broker answered, so this is not the
      // silence below; the answer is unusable, so it is not "pending" either.
      const malformed = await askAbout(() => health());
      assert.equal(malformed.result.exitCode, 1, 'an unusable answer is not a success');
      assert.ok(malformed.stdout.includes('"state": "unverifiable"'), malformed.stdout);
      assert.ok(!malformed.stdout.includes('"state": "pending"'), malformed.stdout);

      const paired = await askAbout(() => json({
        ok: true, state: 'accepted', peerId: 'peer_paired', pairingId: offer.pairingId,
      }));
      assert.equal(paired.result.exitCode, 0);
      assert.equal(paired.result.detailCode, 'pairing-accepted');
      assert.ok(paired.stdout.includes('"state": "accepted"'), paired.stdout);
      assert.ok(paired.stdout.includes('peer_paired'), paired.stdout);
      assert.equal(paired.calls.filter((call) => call.startsWith('POST')).length, 0,
        'reporting an offer must never create one');

      const waiting = await askAbout(() => json({ ok: true, state: 'pending', pairingId: offer.pairingId }));
      assert.equal(waiting.result.exitCode, 0);
      assert.equal(waiting.result.detailCode, 'pairing-pending');
      assert.ok(waiting.stdout.includes('"state": "pending"'), waiting.stdout);
      assert.ok(waiting.calls.filter((call) => call.includes('/api/transport/pairings')).length > 1,
        'a pending offer is polled until the deadline, not once');

      const gone = await askAbout(() => json({ ok: false, code: 'not-found' }, 404));
      assert.equal(gone.result.detailCode, 'pairing-not-found');
      assert.ok(gone.stdout.includes('"state": "not-found"'), gone.stdout);

      // Pending, and then nothing. The answer at the deadline has to be the LAST one: an offer the broker
      // stopped reporting on is not an offer anybody can still be told to wait for, and a one-use offer
      // whose outcome is unknown is exactly the case a wrong "pending" turns into a second pairing.
      const quiet = await askAbout((read) => {
        if (read === 1) return json({ ok: true, state: 'pending', pairingId: offer.pairingId });
        throw new Error('the broker stopped answering');
      });
      assert.equal(quiet.result.exitCode, 1, 'silence after an earlier pending is not still pending');
      assert.equal(quiet.result.detailCode, 'broker-unreachable');
      assert.ok(quiet.stdout.includes('"state": "unverifiable"'), quiet.stdout);
      assert.ok(!quiet.stdout.includes('"state": "pending"'), quiet.stdout);
      assert.ok(quiet.calls.filter((call) => call.includes('/api/transport/pairings')).length > 1,
        'the pending answer is followed up rather than kept');

      // The silence case. Reporting it as pending would tell the operator to wait for a pairing that may
      // already have happened, and reporting it as accepted would be a lie about a one-use credential.
      const silent = await askAbout(() => { throw new Error('broker stopped answering'); });
      assert.equal(silent.result.exitCode, 1, 'no answer must never exit as success');
      assert.equal(silent.result.detailCode, 'broker-unreachable');
      assert.ok(silent.stdout.includes('"ok": false'), silent.stdout);
      assert.ok(silent.stdout.includes('"state": "unverifiable"'), silent.stdout);
      assert.ok(!silent.stdout.includes('"state": "pending"'), silent.stdout);

      // A malformed id is refused before anything is asked of the network: an id is not a probe target.
      const badId = await runPairCommand(options({ statusPairingId: 'pair_short' }), {
        fetch: async () => { throw new Error('must not be called'); },
      });
      assert.equal(badId.exitCode, 1);
      assert.equal(badId.detailCode, 'pairing-id-invalid');
    } finally {
      rmSync(pairHome, { recursive: true, force: true });
    }
  }

  console.log('PASS pairing, revision-17 migration, and failure-atomic persistence contracts');
} finally {
  rmSync(home, { recursive: true, force: true });
}
