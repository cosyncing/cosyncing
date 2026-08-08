/**
 * Regenerates the cross-language pairing wrap vector consumed by
 * `packages/typescript/crypto/test-vectors/pairing-datakey-wrap-v1.json` (broker test) and the
 * client's `packages/dart/broker_crypto/test/pairing_crypto_test.dart`.
 *
 * Run after any change to the wrap algorithm, HKDF labels, or AAD:
 *   bun scripts/broker/generate-pairing-vector.ts
 * then copy the printed WrappedDataKey fields into the Dart test.
 *
 * The recipient private key below is a committed TEST VECTOR key. It is already
 * public in the client test suite and protects nothing — not a secret.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { unwrapDataKey, wrapDataKeyForPeer, type DataKey } from '../../packages/typescript/crypto/src/index.ts';

const RECIPIENT_PRIVATE_KEY = 'MC4CAQAwBQYDK2VuBCIEIBDFzu-GkzHl4SBrPrSJ7aESoJObwfWej_XF6PethMV_';
const VECTOR_PATH = 'packages/typescript/crypto/test-vectors/pairing-datakey-wrap-v1.json';

// Fixed, recognizable data key: byte i is 255 - i.
const dataKey: DataKey = {
  algorithm: 'AES-256-GCM',
  bytes: Uint8Array.from({ length: 32 }, (_, i) => 255 - i),
};

const privateKeyObject = createPrivateKey({
  key: Buffer.from(RECIPIENT_PRIVATE_KEY, 'base64url'),
  format: 'der',
  type: 'pkcs8',
});
const recipientPublicKey = Buffer.from(
  createPublicKey(privateKeyObject).export({ format: 'der', type: 'spki' }),
).toString('base64url');

const wrapped = wrapDataKeyForPeer(dataKey, recipientPublicKey);

// Self-check before committing anything.
const unwrapped = unwrapDataKey(wrapped, RECIPIENT_PRIVATE_KEY);
if (Buffer.compare(Buffer.from(unwrapped), Buffer.from(dataKey.bytes)) !== 0) {
  throw new Error('self-check failed: unwrap did not return the data key');
}

const vector = {
  description:
    'Cross-language X25519-HKDF-SHA256-AES-256-GCM wrap vector. The recipient private key is a ' +
    'committed test vector, not a secret. Data key byte i is 255 - i. Regenerate with ' +
    'scripts/broker/generate-pairing-vector.ts whenever wrap labels, AAD, or algorithm change, and ' +
    'update the client Dart test to match.',
  generator: 'scripts/broker/generate-pairing-vector.ts',
  recipientPrivateKey: RECIPIENT_PRIVATE_KEY,
  recipientPublicKey,
  expectedDataKeyBase64Url: Buffer.from(dataKey.bytes).toString('base64url'),
  wrapped,
};

mkdirSync('packages/typescript/crypto/test-vectors', { recursive: true });
writeFileSync(VECTOR_PATH, `${JSON.stringify(vector, null, 2)}\n`);

console.log(`wrote ${VECTOR_PATH}`);
console.log('\nDart test values (packages/dart/broker_crypto/test/pairing_crypto_test.dart):');
console.log(`  ephemeralPublicKey: '${wrapped.ephemeralPublicKey}'`);
console.log(`  nonce: '${wrapped.nonce}'`);
console.log(`  ciphertext: '${wrapped.ciphertext}'`);
console.log(`  tag: '${wrapped.tag}'`);
