/**
 * @cosyncing/crypto — Wave 2.2 E2E crypto scaffold.
 *
 * This package owns byte-level primitives only: AES-256-GCM data keys, X25519 wrapping for pairing,
 * and QR bootstrap payloads. Broker/app integration comes in a later slice.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
  verify,
} from 'node:crypto';

export { loadOrCreateLocalKeyStore, type LocalKeyStore } from './key-store.ts';

export interface DataKey {
  algorithm: 'AES-256-GCM';
  bytes: Uint8Array;
}

export interface SealedBytes {
  algorithm: 'AES-256-GCM';
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface X25519KeyPair {
  publicKey: string;
  privateKey: string;
}

export interface IdentityKeyPair {
  algorithm: 'Ed25519';
  publicKey: string;
  privateKey: string;
}

export interface WrappedDataKey {
  version: 1;
  algorithm: 'X25519-HKDF-SHA256-AES-256-GCM';
  ephemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export type PairingTransport =
  | { kind: 'tailscale-direct'; url: string }
  | { kind: 'broker-url'; url?: string }
  | { kind: 'relay'; url: string; mailbox: string };

export interface QrBrokerDescriptor {
  version: string;
  contract: {
    revision: number;
    minimumClientRevision: number;
    surfaceHash: string;
  };
}

export interface QrPairingPayload {
  version: 1 | 2 | 3;
  brokerId: string;
  publicKey: string;
  transport: PairingTransport;
  /** Added in BPC13. Optional so stored v1/v2 QR payloads remain parseable. */
  broker?: QrBrokerDescriptor;
}

export interface QrPairingPayloadV1 extends QrPairingPayload {
  version: 1;
  transport: Exclude<PairingTransport, { kind: 'broker-url' }>;
}

export interface QrPairingPayloadV2 extends QrPairingPayload {
  version: 2;
  pairingId: string;
  transport: Exclude<PairingTransport, { kind: 'broker-url' }>;
}

export interface QrPairingPayloadV3 extends QrPairingPayload {
  version: 3;
  pairingId: string;
  transport: Extract<PairingTransport, { kind: 'broker-url' }>;
}

type QrPairingPayloadInput =
  | (Omit<QrPairingPayloadV1, 'version'> & { version?: 1 })
  | (Omit<QrPairingPayloadV2, 'version'> & { version?: 2 })
  | (Omit<QrPairingPayloadV3, 'version'> & { version: 3 });

const WRAP_INFO = new TextEncoder().encode('cosyncing-datakey-wrap-v1');
const WRAP_AAD = new TextEncoder().encode('cosyncing-datakey');

export function generateDataKey(): DataKey {
  return { algorithm: 'AES-256-GCM', bytes: randomBytes(32) };
}

export function encryptWithDataKey(key: DataKey, plaintext: Uint8Array, aad?: Uint8Array): SealedBytes {
  assertDataKey(key);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key.bytes), nonce);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return {
    algorithm: 'AES-256-GCM',
    nonce: b64(nonce),
    ciphertext: b64(ciphertext),
    tag: b64(cipher.getAuthTag()),
  };
}

export function decryptWithDataKey(key: DataKey, sealed: SealedBytes, aad?: Uint8Array): Uint8Array {
  assertDataKey(key);
  if (sealed.algorithm !== 'AES-256-GCM') throw new Error(`unsupported sealed algorithm: ${sealed.algorithm}`);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key.bytes), unb64(sealed.nonce));
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(unb64(sealed.tag));
  return new Uint8Array(Buffer.concat([decipher.update(unb64(sealed.ciphertext)), decipher.final()]));
}

export function generateX25519KeyPair(): X25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: exportPublic(publicKey),
    privateKey: exportPrivate(privateKey),
  };
}

export function generateIdentityKeyPair(): IdentityKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    algorithm: 'Ed25519',
    publicKey: exportPublic(publicKey),
    privateKey: exportPrivate(privateKey),
  };
}

export function signBytes(privateKey: string, bytes: Uint8Array): string {
  return b64(sign(null, Buffer.from(bytes), importPrivate(privateKey)));
}

export function verifySignature(publicKey: string, bytes: Uint8Array, signature: string): boolean {
  try {
    return verify(null, Buffer.from(bytes), importPublic(publicKey), unb64(signature));
  } catch {
    return false;
  }
}

export function wrapDataKeyForPeer(dataKey: DataKey, recipientPublicKey: string): WrappedDataKey {
  assertDataKey(dataKey);
  const ephemeral = generateKeyPairSync('x25519');
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: importPublic(recipientPublicKey),
  });
  const wrapKey = deriveWrapKey(shared);
  const sealed = encryptWithDataKey({ algorithm: 'AES-256-GCM', bytes: wrapKey }, dataKey.bytes, WRAP_AAD);
  return {
    version: 1,
    algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
    ephemeralPublicKey: exportPublic(ephemeral.publicKey),
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    tag: sealed.tag,
  };
}

export function unwrapDataKey(wrapped: WrappedDataKey, recipientPrivateKey: string): Uint8Array {
  if (wrapped.version !== 1) throw new Error(`unsupported wrapped key version: ${wrapped.version}`);
  if (wrapped.algorithm !== 'X25519-HKDF-SHA256-AES-256-GCM') throw new Error(`unsupported wrapped key algorithm: ${wrapped.algorithm}`);
  const privateKey = importPrivate(recipientPrivateKey);
  const shared = diffieHellman({
    privateKey,
    publicKey: importPublic(wrapped.ephemeralPublicKey),
  });
  const wrapKey = deriveWrapKey(shared);
  return decryptWithDataKey(
    { algorithm: 'AES-256-GCM', bytes: wrapKey },
    { algorithm: 'AES-256-GCM', nonce: wrapped.nonce, ciphertext: wrapped.ciphertext, tag: wrapped.tag },
    WRAP_AAD,
  );
}

export function createQrPairingPayload(payload: QrPairingPayloadInput): string {
  const hasPairingId = 'pairingId' in payload;
  const explicitVersion = payload.version;
  const version = explicitVersion ?? (hasPairingId ? 2 : 1);
  const normalized = version === 3
    ? (() => {
        if (payload.transport.kind !== 'broker-url') throw new Error('pairing payload v3 requires broker-url transport');
        return {
          ...payload,
          version: 3,
          pairingId: hasPairingId ? String(payload.pairingId) : '',
          transport: payload.transport,
        } satisfies QrPairingPayloadV3;
      })()
    : version === 2
      ? (() => {
          if (payload.transport.kind === 'broker-url') {
            throw new Error('broker-url pairing transport requires version 3');
          }
          return {
            ...payload,
            version: 2,
            pairingId: hasPairingId ? String(payload.pairingId) : '',
            transport: payload.transport,
          } satisfies QrPairingPayloadV2;
        })()
      : { ...payload, version: 1 } as QrPairingPayloadV1;
  validatePairingPayload(normalized);
  return `cosyncing://pair?payload=${encodeURIComponent(b64(Buffer.from(JSON.stringify(normalized), 'utf8')))}`;
}

export function parseQrPairingPayload(input: string): QrPairingPayload {
  const url = new URL(input);
  if (url.protocol !== 'cosyncing:' || url.hostname !== 'pair') throw new Error('not a cosyncing pairing payload');
  const encoded = url.searchParams.get('payload');
  if (!encoded) throw new Error('pairing payload is missing');
  const parsed = JSON.parse(unb64(encoded).toString('utf8')) as QrPairingPayload;
  validatePairingPayload(parsed);
  return parsed;
}

function assertDataKey(key: DataKey): void {
  if (key.algorithm !== 'AES-256-GCM') throw new Error(`unsupported data key algorithm: ${key.algorithm}`);
  if (key.bytes.byteLength !== 32) throw new Error('AES-256-GCM data key must be 32 bytes');
}

function deriveWrapKey(shared: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', Buffer.from(shared), Buffer.alloc(0), Buffer.from(WRAP_INFO), 32));
}

function importPublic(encoded: string): KeyObject {
  return createPublicKey({ key: unb64(encoded), format: 'der', type: 'spki' });
}

function importPrivate(encoded: string): KeyObject {
  return createPrivateKey({ key: unb64(encoded), format: 'der', type: 'pkcs8' });
}

function exportPublic(key: KeyObject): string {
  return b64(key.export({ format: 'der', type: 'spki' }) as Buffer);
}

function exportPrivate(key: KeyObject): string {
  return b64(key.export({ format: 'der', type: 'pkcs8' }) as Buffer);
}

function validatePairingPayload(payload: QrPairingPayload): void {
  if (payload.version === 1) {
    return validatePairingPayloadV1(payload as QrPairingPayloadV1);
  }
  if (payload.version === 2) {
    return validatePairingPayloadV2(payload as QrPairingPayloadV2);
  }
  if (payload.version === 3) {
    return validatePairingPayloadV3(payload as QrPairingPayloadV3);
  }
  throw new Error('unsupported pairing payload version');
}

function validatePairingPayloadV1(payload: QrPairingPayloadV1): void {
  if (!payload.brokerId) throw new Error('pairing payload brokerId is required');
  if (!payload.publicKey) throw new Error('pairing payload publicKey is required');
  validateLegacyPairingTransport(payload.transport);
  validateQrBrokerDescriptor(payload.broker);
}

function validatePairingPayloadV2(payload: QrPairingPayloadV2): void {
  if (!payload.brokerId) throw new Error('pairing payload brokerId is required');
  if (!payload.publicKey) throw new Error('pairing payload publicKey is required');
  if (!payload.pairingId) throw new Error('pairing payload pairingId is required');
  validateLegacyPairingTransport(payload.transport);
  validateQrBrokerDescriptor(payload.broker);
}

function validatePairingPayloadV3(payload: QrPairingPayloadV3): void {
  if (!payload.brokerId) throw new Error('pairing payload brokerId is required');
  if (!payload.publicKey) throw new Error('pairing payload publicKey is required');
  if (!payload.pairingId) throw new Error('pairing payload pairingId is required');
  if (payload.transport.kind !== 'broker-url') throw new Error('version 3 pairing transport must be broker-url');
  validatePairingTransport(payload.transport);
  validateQrBrokerDescriptor(payload.broker);
}

function validateQrBrokerDescriptor(broker: QrBrokerDescriptor | undefined): void {
  if (broker === undefined) return;
  if (!broker || typeof broker.version !== 'string'
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(broker.version)
      || !broker.contract
      || !Number.isSafeInteger(broker.contract.revision) || broker.contract.revision < 0
      || !Number.isSafeInteger(broker.contract.minimumClientRevision)
      || broker.contract.minimumClientRevision < 0
      || broker.contract.minimumClientRevision > broker.contract.revision
      || !/^fnv1a32:[a-f0-9]{8}$/.test(broker.contract.surfaceHash)) {
    throw new Error('pairing payload broker descriptor is invalid');
  }
}

function validatePairingTransport(transport: PairingTransport): void {
  if (transport.kind === 'tailscale-direct') {
    if (!transport.url) throw new Error('tailscale-direct pairing URL is required');
    return;
  }
  if (transport.kind === 'broker-url') {
    if (transport.url != null && !transport.url) throw new Error('broker-url pairing URL is invalid');
    return;
  }
  if (transport.kind === 'relay') {
    if (!transport.url || !transport.mailbox) throw new Error('relay pairing URL and mailbox are required');
    return;
  }
  throw new Error('unsupported pairing transport');
}

function validateLegacyPairingTransport(
  transport: Exclude<PairingTransport, { kind: 'broker-url' }>,
): void {
  if ((transport as PairingTransport).kind === 'broker-url') {
    throw new Error('broker-url pairing transport requires version 3');
  }
  validatePairingTransport(transport);
}

function b64(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('base64url');
}

function unb64(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}
