import { strict as assert } from 'node:assert';
import { generateDataKey, generateIdentityKeyPair } from '../../../crypto/src/index.ts';
import {
  MemoryReplayCache,
  openTransportEnvelope,
  parseCipherEnvelope,
  sealTransportEnvelope,
} from '../../../transport-wire/src/index.ts';

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

await test('wire seals and opens an encrypted transport envelope', () => {
  const key = generateDataKey();
  const plaintext = new TextEncoder().encode(JSON.stringify({ kind: 'approve', requestId: 'r1' }));
  const sealed = sealTransportEnvelope({
    key,
    id: 'env-1',
    from: 'phone',
    to: 'broker',
    channel: 'session-control',
    bytes: plaintext,
  });

  assert.equal(sealed.id, 'env-1');
  assert.equal(sealed.channel, 'session-control');
  assert.equal(sealed.headers?.['x-cosyncing-wire-kind'], 'cipher-envelope');
  assert.equal(parseCipherEnvelope(sealed.bytes).sealed.algorithm, 'AES-256-GCM');
  assert.deepEqual([...openTransportEnvelope(key, sealed).bytes], [...plaintext]);
});

await test('wire rejects tampered routing metadata', () => {
  const key = generateDataKey();
  const sealed = sealTransportEnvelope({
    key,
    id: 'env-2',
    from: 'phone',
    to: 'broker',
    channel: 'session-control',
    bytes: new TextEncoder().encode('payload'),
  });

  assert.throws(() => openTransportEnvelope(key, { ...sealed, channel: 'other' }));
  assert.throws(() => openTransportEnvelope(key, { ...sealed, to: 'other-peer' }));
});

await test('wire verifies sender identity and rejects replayed envelope ids', () => {
  const key = generateDataKey();
  const phone = generateIdentityKeyPair();
  const attacker = generateIdentityKeyPair();
  const replayCache = new MemoryReplayCache();
  const sealed = sealTransportEnvelope({
    key,
    id: 'auth-env-1',
    from: 'phone',
    to: 'broker',
    channel: 'session-control',
    bytes: new TextEncoder().encode(JSON.stringify({ kind: 'approve', requestId: 'r1' })),
    senderIdentity: phone,
  });

  const cipher = parseCipherEnvelope(sealed.bytes);
  assert.equal(cipher.senderIdentityPublicKey, phone.publicKey);
  assert.equal(typeof cipher.senderSignature, 'string');
  assert.deepEqual([...openTransportEnvelope(key, sealed, { trustedSenderPublicKey: phone.publicKey, replayCache }).bytes], [...new TextEncoder().encode(JSON.stringify({ kind: 'approve', requestId: 'r1' }))]);
  assert.throws(() => openTransportEnvelope(key, sealed, { trustedSenderPublicKey: phone.publicKey, replayCache }), /replay/i);
  assert.throws(() => openTransportEnvelope(key, sealed, { trustedSenderPublicKey: attacker.publicKey, replayCache: new MemoryReplayCache() }), /sender/i);
});

await test('wire rejects flipped ciphertext bytes through AES-GCM authentication', () => {
  const key = generateDataKey();
  const sealed = sealTransportEnvelope({
    key,
    id: 'tamper-env-1',
    from: 'phone',
    to: 'broker',
    channel: 'session-control',
    bytes: new TextEncoder().encode('payload'),
  });
  const cipher = parseCipherEnvelope(sealed.bytes);
  cipher.sealed.ciphertext = `${cipher.sealed.ciphertext[0] === 'A' ? 'B' : 'A'}${cipher.sealed.ciphertext.slice(1)}`;

  assert.throws(
    () => openTransportEnvelope(key, { ...sealed, bytes: new TextEncoder().encode(JSON.stringify(cipher)) }),
    /authenticate|auth|bad decrypt|Unsupported state/i,
  );
});

if (failed) {
  console.error(`\nFAIL: ${failed} wire test(s) failed.`);
  process.exit(1);
}

console.log('\nPASS wire tests');
