import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIdentityKeyPair, generateX25519KeyPair, parseQrPairingPayload } from '@cosyncing/crypto';
import {
  pairingBrokerUrlUsesUnprotectedHttp,
  normalizePairingBrokerUrl,
  PairingBrokerUrlError,
} from '../../src/transport/pairing-url.ts';
import { PairingHttpError, TransportPairingRegistry } from '../../src/transport/transport-pairing.ts';
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
  } finally {
    rmSync(renameHome, { recursive: true, force: true });
  }

  console.log('PASS pairing URL, terminal safety, and failure-atomic persistence contracts');
} finally {
  rmSync(home, { recursive: true, force: true });
}
