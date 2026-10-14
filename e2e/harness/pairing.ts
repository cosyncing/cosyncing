/**
 * Pair a device with a broker the way the app does.
 *
 * The owner mints a one-use offer (`POST /api/transport/pairings`); the device
 * scans the QR, generates its own identity and exchange keys, and redeems the
 * offer without any credential (`POST /api/transport/pairings/:id/accept`).
 * The device then checks what a real client checks before it stores anything:
 * the broker's Ed25519 proof over the accepted material, against the identity
 * key the QR committed to, and that the wrapped data key opens with its own
 * exchange key. The proof layout is reimplemented here from the client's side,
 * not imported from the broker, so a broker that changes it fails here the way
 * a shipped client would.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  generateIdentityKeyPair,
  generateX25519KeyPair,
  parseQrPairingPayload,
  unwrapDataKey,
  verifySignature,
  type DataKey,
  type IdentityKeyPair,
  type QrPairingPayload,
  type WrappedDataKey,
  type X25519KeyPair,
} from '../../packages/typescript/crypto/src/index.ts';
import type { BrokerClient, Response } from './client.ts';

export interface PairingOffer {
  pairingId: string;
  qr: string;
  expiresAt: string;
  brokerPeerId: string;
  payload: QrPairingPayload;
}

export interface PairedDevice {
  /** The device's own id, as it presented itself. */
  peerId: string;
  /** The device's mailbox token (the broker stores only its hash). */
  mailboxToken: string;
  /** The per-device credential the broker issued: send as `x-cosyncing-peer-token`. */
  peerToken: string;
  brokerPeerId: string;
  identity: IdentityKeyPair;
  exchange: X25519KeyPair;
  dataKey: DataKey;
  offer: PairingOffer;
  accepted: any;
}

export interface DeviceKeys {
  peerId: string;
  mailboxToken: string;
  identity: IdentityKeyPair;
  exchange: X25519KeyPair;
}

/** Fresh device material: an id, a strong mailbox token, and two key pairs. */
export function deviceKeys(peerId = `device-${randomBytes(6).toString('hex')}`): DeviceKeys {
  return {
    peerId,
    mailboxToken: createHash('sha256').update(randomBytes(32)).digest('base64url'),
    identity: generateIdentityKeyPair(),
    exchange: generateX25519KeyPair(),
  };
}

/** The body a device posts to redeem an offer. */
export function acceptanceBody(keys: DeviceKeys): Record<string, unknown> {
  return {
    peerId: keys.peerId,
    peerToken: keys.mailboxToken,
    identityPublicKey: keys.identity.publicKey,
    exchangePublicKey: keys.exchange.publicKey,
  };
}

/** Mint an offer as the owner. Throws unless the broker created one. */
export async function createOffer(
  owner: BrokerClient,
  input: { clientLabel?: string; brokerUrl?: string } = {},
): Promise<PairingOffer> {
  const created = await owner.post('/api/transport/pairings', input);
  if (created.status !== 201) {
    throw new Error(`pairing offer refused (${created.status}): ${created.text.slice(0, 300)}`);
  }
  return { ...created.body, payload: parseQrPairingPayload(created.body.qr) };
}

/** Redeem an offer as a device: no credential, exactly as a scanned QR does. */
export function redeem(owner: BrokerClient, pairingId: string, body: unknown): Promise<Response> {
  return owner.as({ kind: 'none' }).post(
    `/api/transport/pairings/${encodeURIComponent(pairingId)}/accept`,
    body,
  );
}

/** The bytes the broker signs on accept, as a client reconstructs them. */
export function acceptanceProofBytes(input: {
  pairingId: string;
  client: { peerId: string; identityPublicKey: string; exchangePublicKey: string };
  broker: { peerId: string; peerToken: string; identityPublicKey: string };
  wrappedDataKey: WrappedDataKey;
}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: 1,
    pairingId: input.pairingId,
    client: {
      peerId: input.client.peerId,
      identityPublicKey: input.client.identityPublicKey,
      exchangePublicKey: input.client.exchangePublicKey,
    },
    broker: {
      peerId: input.broker.peerId,
      peerToken: input.broker.peerToken,
      identityPublicKey: input.broker.identityPublicKey,
    },
    wrappedDataKey: {
      version: input.wrappedDataKey.version,
      algorithm: input.wrappedDataKey.algorithm,
      ephemeralPublicKey: input.wrappedDataKey.ephemeralPublicKey,
      nonce: input.wrappedDataKey.nonce,
      ciphertext: input.wrappedDataKey.ciphertext,
      tag: input.wrappedDataKey.tag,
    },
  }));
}

/**
 * Full pairing: offer, accept, and the client-side checks. Throws if any step
 * fails, so a test that only needs a paired device can rely on it.
 */
export async function pairDevice(
  owner: BrokerClient,
  options: { peerId?: string; clientLabel?: string; brokerUrl?: string; keys?: DeviceKeys } = {},
): Promise<PairedDevice> {
  const offer = await createOffer(owner, {
    ...(options.clientLabel ? { clientLabel: options.clientLabel } : {}),
    ...(options.brokerUrl ? { brokerUrl: options.brokerUrl } : {}),
  });
  const keys = options.keys ?? deviceKeys(options.peerId);
  const response = await redeem(owner, offer.pairingId, acceptanceBody(keys));
  if (response.status !== 200) {
    throw new Error(`pairing accept refused (${response.status}): ${response.text.slice(0, 300)}`);
  }
  const accepted = response.body;
  if (accepted.broker?.peerId !== offer.payload.brokerId
    || accepted.broker?.identityPublicKey !== offer.payload.publicKey) {
    throw new Error('pairing accept answered for a different broker than the QR named');
  }
  const proof = acceptanceProofBytes({
    pairingId: offer.pairingId,
    client: {
      peerId: keys.peerId,
      identityPublicKey: keys.identity.publicKey,
      exchangePublicKey: keys.exchange.publicKey,
    },
    broker: accepted.broker,
    wrappedDataKey: accepted.wrappedDataKey,
  });
  if (accepted.brokerProof?.algorithm !== 'Ed25519'
    || !verifySignature(offer.payload.publicKey, proof, accepted.brokerProof.signature)) {
    throw new Error('pairing accept carried no valid broker proof');
  }
  const dataKeyBytes = unwrapDataKey(accepted.wrappedDataKey as WrappedDataKey, keys.exchange.privateKey);
  return {
    peerId: keys.peerId,
    mailboxToken: keys.mailboxToken,
    peerToken: String(accepted.broker.peerToken),
    brokerPeerId: String(accepted.broker.peerId),
    identity: keys.identity,
    exchange: keys.exchange,
    dataKey: { algorithm: 'AES-256-GCM', bytes: dataKeyBytes },
    offer,
    accepted,
  };
}
