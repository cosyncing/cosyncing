import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  createQrPairingPayload,
  decryptWithDataKey,
  encryptWithDataKey,
  generateDataKey,
  generateIdentityKeyPair,
  generateX25519KeyPair,
  parseQrPairingPayload,
  signBytes,
  unwrapDataKey,
  verifySignature,
  wrapDataKeyForPeer,
} from '../../../crypto/src/index.ts';

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name} - ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

let failed = 0;

await test('AES-256-GCM data key encrypts and authenticates opaque bytes', () => {
  const key = generateDataKey();
  const plaintext = new TextEncoder().encode('phone approval payload');
  const aad = new TextEncoder().encode('session:abc');
  const sealed = encryptWithDataKey(key, plaintext, aad);
  assert.equal(sealed.algorithm, 'AES-256-GCM');
  assert.deepEqual([...decryptWithDataKey(key, sealed, aad)], [...plaintext]);
  assert.throws(() => decryptWithDataKey(key, sealed, new TextEncoder().encode('session:other')));
});

await test('X25519 wrap unwrap round-trips the data key', () => {
  const dataKey = generateDataKey();
  const recipient = generateX25519KeyPair();
  const wrapped = wrapDataKeyForPeer(dataKey, recipient.publicKey);
  const unwrapped = unwrapDataKey(wrapped, recipient.privateKey);
  assert.deepEqual([...unwrapped], [...dataKey.bytes]);

  const other = generateX25519KeyPair();
  assert.throws(() => unwrapDataKey(wrapped, other.privateKey));
});

await test('committed cross-language wrap vector unwraps with current labels', () => {
  // Shared with the client's packages/dart/broker_crypto Dart suite. If this fails after a
  // label/AAD/algorithm change, regenerate via scripts/broker/generate-pairing-vector.ts and
  // update the Dart test to match — never hand-edit the vector.
  const vector = JSON.parse(
    readFileSync(
      new URL('../../../crypto/test-vectors/pairing-datakey-wrap-v1.json', import.meta.url),
      'utf8',
    ),
  );
  const unwrapped = unwrapDataKey(vector.wrapped, vector.recipientPrivateKey);
  assert.equal(Buffer.from(unwrapped).toString('base64url'), vector.expectedDataKeyBase64Url);
});

await test('Ed25519 identity keys sign and verify pairing/auth transcripts', () => {
  const phone = generateIdentityKeyPair();
  const other = generateIdentityKeyPair();
  const transcript = new TextEncoder().encode('pairing transcript');
  const sig = signBytes(phone.privateKey, transcript);

  assert.equal(verifySignature(phone.publicKey, transcript, sig), true);
  assert.equal(verifySignature(other.publicKey, transcript, sig), false);
  assert.equal(verifySignature(phone.publicKey, new TextEncoder().encode('tampered'), sig), false);
});

await test('QR pairing payload carries direct and relay transport bootstraps', () => {
  const keyPair = generateX25519KeyPair();
  const direct = createQrPairingPayload({
    brokerId: 'desktop-1',
    transport: { kind: 'tailscale-direct', url: 'https://desktop.tailnet.ts.net' },
    publicKey: keyPair.publicKey,
  });
  const legacy = createQrPairingPayload({
    version: 1,
    brokerId: 'desktop-1',
    transport: { kind: 'tailscale-direct', url: 'https://legacy.tailnet.ts.net' },
    publicKey: keyPair.publicKey,
  });
  const relay = createQrPairingPayload({
    brokerId: 'desktop-1',
    transport: { kind: 'relay', url: 'https://relay.cosyncing.test', mailbox: 'abc' },
    publicKey: keyPair.publicKey,
    pairingId: 'pairing-test-id',
  });
  const withId = createQrPairingPayload({
    brokerId: 'desktop-1',
    transport: { kind: 'relay', url: 'https://relay.cosyncing.test', mailbox: 'abc' },
    publicKey: keyPair.publicKey,
    pairingId: 'pairing-published-v2',
  });

  assert.equal(parseQrPairingPayload(direct).transport.kind, 'tailscale-direct');
  assert.equal(parseQrPairingPayload(legacy).version, 1);
  const parsedRelay = parseQrPairingPayload(relay);
  assert.equal(parsedRelay.transport.kind, 'relay');
  assert.equal(parsedRelay.transport.mailbox, 'abc');
  const parsedWithId = parseQrPairingPayload(withId);
  assert.equal(parsedWithId.version, 2);
  assert.equal((parsedWithId as any).pairingId, 'pairing-published-v2');
  assert.equal(parsedRelay.publicKey, keyPair.publicKey);
  assert.equal((parseQrPairingPayload(legacy) as any).pairingId, undefined);
});

if (failed) {
  console.error(`\nFAIL: ${failed} crypto test(s) failed.`);
  process.exit(1);
}

console.log('\nPASS crypto tests');
