import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PairingErrorCode } from '@cosyncing/protocol';
import {
  createQrPairingPayload,
  generateDataKey,
  loadOrCreateLocalKeyStore,
  signBytes,
  wrapDataKeyForPeer,
  type DataKey,
  type QrBrokerDescriptor,
  type WrappedDataKey,
} from '@cosyncing/crypto';
import { setupStateHome } from '../installation/setup-state.ts';
import { normalizePairingBrokerUrl, PairingBrokerUrlError } from './pairing-url.ts';

export interface AcceptedTransportPeer {
  peerId: string;
  label?: string;
  identityPublicKey: string;
  peerTokenHash: string;
  brokerPeerId: string;
  brokerPeerTokenHash: string;
  brokerIdentityPublicKey: string;
  dataKey: StoredDataKey;
  wrappedDataKey: WrappedDataKey;
  acceptedAt: string;
  revokedAt?: string;
}

interface StoredDataKey {
  algorithm: 'AES-256-GCM';
  bytes: string;
}

export interface BrokerTransportPeerMaterial {
  peerId: string;
  identityPublicKey: string;
  brokerPeerId: string;
  dataKey: DataKey;
}

export interface PairingAcceptanceProof {
  version: 1;
  algorithm: 'Ed25519';
  signature: string;
}

interface PairingOffer {
  pairingId: string;
  label?: string;
  brokerPeerId: string;
  brokerPeerToken: string;
  qr: string;
  createdAt: number;
  expiresAt: number;
  acceptedPeerId?: string;
}

interface PairingFailureBucket {
  count: number;
  windowStart: number;
}

interface PairingStoreFile {
  version: 1;
  peers: AcceptedTransportPeer[];
}

export class PairingHttpError extends Error {
  constructor(readonly status: number, readonly code: PairingErrorCode, message: string) {
    super(message);
  }
}

const PAIRING_ID_BYTES = 16;
const PAIRING_ACCEPT_MAX_FAILURES = 10;
const PAIRING_ACCEPT_FAILURE_WINDOW_MS = 60 * 1000;
const PAIRING_ACCEPT_FAILURE_MAX_BUCKETS = 1000;

export class TransportPairingRegistry {
  private readonly offers = new Map<string, PairingOffer>();
  private readonly peers = new Map<string, AcceptedTransportPeer>();
  private readonly path: string;
  private readonly keyDir: string;
  private readonly pairingAcceptFailures = new Map<string, PairingFailureBucket>();

  constructor(
    private readonly opts: {
      broker?: QrBrokerDescriptor;
      ttlMs?: number;
      home?: string;
      now?: () => number;
    },
  ) {
    const home = opts.home ?? setupStateHome();
    this.path = join(home, 'transport-peers.json');
    this.keyDir = join(home, 'transport-keys');
    this.load();
  }

  createOffer(input: { clientLabel?: string; brokerUrl?: string } = {}): {
    pairingId: string;
    qr: string;
    expiresAt: string;
    brokerPeerId: string;
    broker?: QrBrokerDescriptor;
  } {
    for (const [id, offer] of this.offers) {
      if (offer.expiresAt <= this.now()) this.offers.delete(id);
    }
    const keys = loadOrCreateLocalKeyStore(this.keyDir, 'broker');
    const pairingId = `pair_${randomBytes(PAIRING_ID_BYTES).toString('base64url')}`;
    const brokerPeerId = `broker_${randomBytes(9).toString('base64url')}`;
    const brokerPeerToken = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + (this.opts.ttlMs ?? 5 * 60 * 1000);
    // The broker descriptor stays OUT of the QR and in the response beside it. A QR is scanned off a
    // terminal, so every byte is symbol area: the descriptor costs 154 payload characters, which is the
    // difference between a 73-column symbol and an 85-column one — wider than the 80-column terminal it is
    // printed into, and a wrapped QR is not a QR. Nothing reads it from here: the Dart parser drops the
    // field, and the client learns the same version/contract from `/api/health`, from the pairing-accept
    // response, and from the WebSocket hello's compatibility handshake, all of which it must complete
    // anyway. `parseQrPairingPayload` still accepts the field so payloads stored by older brokers parse.
    let brokerUrl: string | undefined;
    try {
      brokerUrl = normalizePairingBrokerUrl(input.brokerUrl);
    } catch (error) {
      throw new PairingHttpError(
        400,
        'PAIRING_INVALID_INPUT',
        error instanceof PairingBrokerUrlError ? error.message : 'brokerUrl is invalid',
      );
    }
    const qr = createQrPairingPayload({
      version: 3,
      brokerId: brokerPeerId,
      pairingId,
      // V3 commits the broker identity key. The accept response must prove
      // possession before a client stores the returned endpoint or secret.
      publicKey: keys.identity.publicKey,
      transport: { kind: 'broker-url', ...(brokerUrl ? { url: brokerUrl } : {}) },
    });
    this.offers.set(pairingId, {
      pairingId,
      ...(input.clientLabel ? { label: input.clientLabel } : {}),
      brokerPeerId,
      brokerPeerToken,
      qr,
      createdAt: this.now(),
      expiresAt,
    });
    return {
      pairingId,
      qr,
      brokerPeerId,
      expiresAt: new Date(expiresAt).toISOString(),
      ...(this.opts.broker ? { broker: this.opts.broker } : {}),
    };
  }

  getOfferStatus(pairingId: string):
    | { state: 'pending'; expiresAt: string }
    | { state: 'accepted'; expiresAt: string; peerId: string }
    | { state: 'expired'; expiresAt: string }
    | undefined {
    const offer = this.offers.get(pairingId);
    if (!offer) return undefined;
    const expiresAt = new Date(offer.expiresAt).toISOString();
    if (offer.acceptedPeerId) return { state: 'accepted', expiresAt, peerId: offer.acceptedPeerId };
    if (offer.expiresAt <= this.now()) {
      return { state: 'expired', expiresAt };
    }
    return { state: 'pending', expiresAt };
  }

  accept(pairingId: string, input: {
    peerId: string;
    peerToken: string;
    identityPublicKey: string;
    exchangePublicKey: string;
  }): {
    peer: { peerId: string; label?: string; identityPublicKey: string };
    broker: { peerId: string; peerToken: string; identityPublicKey: string };
    wrappedDataKey: WrappedDataKey;
    brokerProof: PairingAcceptanceProof;
  } {
    this.assertPairingAcceptAllowed(pairingId);
    const offer = this.offers.get(pairingId);
    if (!offer) {
      this.recordPairingAcceptFailure(pairingId);
      throw new PairingHttpError(404, 'PAIRING_NOT_FOUND', 'pairing offer not found');
    }
    if (offer.acceptedPeerId) {
      this.recordPairingAcceptFailure(pairingId);
      throw new PairingHttpError(
        409,
        'PAIRING_ALREADY_ACCEPTED',
        'this pairing QR was already used — generate a new one and review connected devices',
      );
    }
    if (offer.expiresAt <= this.now()) {
      this.offers.delete(pairingId);
      this.recordPairingAcceptFailure(pairingId);
      throw new PairingHttpError(410, 'PAIRING_EXPIRED', 'pairing offer expired');
    }
    const peerId = input.peerId.trim();
    const peerToken = input.peerToken.trim();
    const identityPublicKey = input.identityPublicKey.trim();
    const exchangePublicKey = input.exchangePublicKey.trim();
    if (!peerId || !peerToken || !identityPublicKey || !exchangePublicKey) {
      this.recordPairingAcceptFailure(pairingId);
      throw new PairingHttpError(400, 'PAIRING_INVALID_INPUT', 'peerId, peerToken, identityPublicKey, and exchangePublicKey are required');
    }
    if (this.peers.get(peerId)?.revokedAt == null && this.peers.has(peerId)) {
      this.recordPairingAcceptFailure(pairingId);
      throw new PairingHttpError(409, 'PAIRING_ALREADY_ACCEPTED', 'peer is already paired');
    }
    const keys = loadOrCreateLocalKeyStore(this.keyDir, 'broker');
    const dataKey = generateDataKey();
    const wrappedDataKey = wrapDataKeyForPeer(dataKey, exchangePublicKey);
    const peer: AcceptedTransportPeer = {
      peerId,
      ...(offer.label ? { label: offer.label } : {}),
      identityPublicKey,
      peerTokenHash: tokenHash(peerToken),
      brokerPeerId: offer.brokerPeerId,
      brokerPeerTokenHash: tokenHash(offer.brokerPeerToken),
      brokerIdentityPublicKey: keys.identity.publicKey,
      dataKey: serializeDataKey(dataKey),
      wrappedDataKey,
      acceptedAt: new Date(this.now()).toISOString(),
    };
    this.peers.set(peerId, peer);
    offer.acceptedPeerId = peerId;
    this.pairingAcceptFailures.delete(pairingId);
    this.save();
    const broker = {
      peerId: peer.brokerPeerId,
      peerToken: offer.brokerPeerToken,
      identityPublicKey: peer.brokerIdentityPublicKey,
    };
    const proofBytes = pairingAcceptanceProofBytes({
      pairingId,
      client: { peerId, identityPublicKey, exchangePublicKey },
      broker,
      wrappedDataKey,
    });
    return {
      peer: {
        peerId,
        ...(peer.label ? { label: peer.label } : {}),
        identityPublicKey,
      },
      broker,
      wrappedDataKey,
      brokerProof: {
        version: 1,
        algorithm: 'Ed25519',
        signature: signBytes(keys.identity.privateKey, proofBytes),
      },
    };
  }

  listPeers(): Array<Omit<AcceptedTransportPeer, 'peerTokenHash' | 'brokerPeerTokenHash' | 'dataKey' | 'wrappedDataKey'>> {
    return [...this.peers.values()]
      .filter((peer) => !peer.revokedAt)
      .map(({ peerTokenHash: _token, brokerPeerTokenHash: _brokerToken, dataKey: _dataKey, wrappedDataKey: _wrapped, ...peer }) => peer);
  }

  revoke(peerId: string): boolean {
    const peer = this.peers.get(peerId);
    if (!peer || peer.revokedAt) return false;
    peer.revokedAt = new Date(this.now()).toISOString();
    this.save();
    return true;
  }

  verifyPeerToken(peerId: string, peerToken: string): 'unknown' | 'ok' | 'forbidden' {
    const peer = this.peerForEndpoint(peerId);
    if (!peer) return 'unknown';
    if (peer.revokedAt) return 'forbidden';
    const hash = peer.peerId === peerId ? peer.peerTokenHash : peer.brokerPeerTokenHash;
    return safeTokenHashEquals(hash, tokenHash(peerToken)) ? 'ok' : 'forbidden';
  }

  verifyAnyPeerToken(peerToken: string): 'unknown' | 'ok' {
    const tokenHashValue = tokenHash(peerToken);
    for (const peer of this.peers.values()) {
      if (peer.revokedAt) continue;
      if (safeTokenHashEquals(peer.brokerPeerTokenHash, tokenHashValue)) {
        return 'ok';
      }
    }
    return 'unknown';
  }

  brokerMaterialForRecipient(brokerPeerId: string): BrokerTransportPeerMaterial | undefined {
    const peer = [...this.peers.values()].find((candidate) => candidate.brokerPeerId === brokerPeerId && !candidate.revokedAt);
    const dataKey = peer ? deserializeDataKey(peer.dataKey) : undefined;
    if (!peer || !dataKey) return undefined;
    return {
      peerId: peer.peerId,
      identityPublicKey: peer.identityPublicKey,
      brokerPeerId: peer.brokerPeerId,
      dataKey,
    };
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as PairingStoreFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.peers)) return;
      for (const rawPeer of parsed.peers as any[]) {
        const peer = normalizeStoredPeer(rawPeer);
        if (peer) this.peers.set(peer.peerId, peer);
      }
    } catch {
      this.peers.clear();
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    // The store holds raw per-peer data keys — owner-only, matching cosyncing-keys.json.
    writeFileSync(tmp, JSON.stringify({ version: 1, peers: [...this.peers.values()] } satisfies PairingStoreFile, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private assertPairingAcceptAllowed(pairingId: string): void {
    const bucket = this.pairingAcceptFailures.get(pairingId);
    if (!bucket) return;
    if (this.now() - bucket.windowStart >= PAIRING_ACCEPT_FAILURE_WINDOW_MS) {
      this.pairingAcceptFailures.delete(pairingId);
      return;
    }
    if (bucket.count >= PAIRING_ACCEPT_MAX_FAILURES) {
      throw new PairingHttpError(429, 'PAIRING_RATE_LIMITED', 'pairing attempts exhausted for this QR code');
    }
  }

  private recordPairingAcceptFailure(pairingId: string): void {
    const now = this.now();
    const bucket = this.pairingAcceptFailures.get(pairingId);
    if (!bucket || now - bucket.windowStart >= PAIRING_ACCEPT_FAILURE_WINDOW_MS) {
      // The accept route is unauthenticated, so this map is attacker-growable: bound it. Sweep
      // expired buckets first; if a spammer of unique bogus ids still fills it, evict oldest
      // (insertion order) — legitimate offers re-enter cheaply, so eviction only loosens limiting.
      if (!bucket && this.pairingAcceptFailures.size >= PAIRING_ACCEPT_FAILURE_MAX_BUCKETS) {
        for (const [id, b] of this.pairingAcceptFailures) {
          if (now - b.windowStart >= PAIRING_ACCEPT_FAILURE_WINDOW_MS) this.pairingAcceptFailures.delete(id);
        }
        while (this.pairingAcceptFailures.size >= PAIRING_ACCEPT_FAILURE_MAX_BUCKETS) {
          const oldest = this.pairingAcceptFailures.keys().next().value;
          if (oldest === undefined) break;
          this.pairingAcceptFailures.delete(oldest);
        }
      }
      this.pairingAcceptFailures.set(pairingId, { count: 1, windowStart: now });
      return;
    }
    bucket.count += 1;
  }

  private peerForEndpoint(peerId: string): AcceptedTransportPeer | undefined {
    const direct = this.peers.get(peerId);
    if (direct) return direct;
    return [...this.peers.values()].find((peer) => peer.brokerPeerId === peerId);
  }
}

export function pairingAcceptanceProofBytes(input: {
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

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function serializeDataKey(dataKey: DataKey): StoredDataKey {
  return { algorithm: dataKey.algorithm, bytes: Buffer.from(dataKey.bytes).toString('base64url') };
}

function deserializeDataKey(stored: StoredDataKey | undefined): DataKey | undefined {
  if (!stored || stored.algorithm !== 'AES-256-GCM' || !stored.bytes) return undefined;
  return { algorithm: 'AES-256-GCM', bytes: new Uint8Array(Buffer.from(stored.bytes, 'base64url')) };
}

function safeTokenHashEquals(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

function normalizeStoredPeer(raw: any): AcceptedTransportPeer | undefined {
  if (!raw?.peerId || !raw?.identityPublicKey || !raw?.peerTokenHash || !raw?.brokerPeerId) return undefined;
  const brokerPeerTokenHash = typeof raw.brokerPeerTokenHash === 'string'
    ? raw.brokerPeerTokenHash
    : typeof raw.brokerPeerToken === 'string'
      ? tokenHash(raw.brokerPeerToken)
      : '';
  if (!brokerPeerTokenHash) return undefined;
  return {
    peerId: String(raw.peerId),
    ...(raw.label ? { label: String(raw.label) } : {}),
    identityPublicKey: String(raw.identityPublicKey),
    peerTokenHash: String(raw.peerTokenHash),
    brokerPeerId: String(raw.brokerPeerId),
    brokerPeerTokenHash,
    brokerIdentityPublicKey: String(raw.brokerIdentityPublicKey ?? ''),
    ...(raw.dataKey ? { dataKey: raw.dataKey as StoredDataKey } : { dataKey: { algorithm: 'AES-256-GCM', bytes: '' } }),
    wrappedDataKey: raw.wrappedDataKey as WrappedDataKey,
    acceptedAt: String(raw.acceptedAt ?? new Date(0).toISOString()),
    ...(raw.revokedAt ? { revokedAt: String(raw.revokedAt) } : {}),
  };
}
