import { randomBytes, createHash, createPublicKey, timingSafeEqual } from 'node:crypto';
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
  authGeneration: number;
  roles: PeerRole[];
  securityRevision: 17;
  revokedAt?: string;
}

export type PeerRole = 'observe' | 'drive' | 'files' | 'admin';

export interface AuthenticatedTransportPeer {
  peerId: string;
  authGeneration: number;
  roles: ReadonlySet<PeerRole>;
  credentialIdentity: string;
}

export interface RevokedTransportPeer {
  peerId: string;
  brokerPeerId: string;
  authGeneration: number;
  credentialIdentity: string;
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

interface LegacyPairingStoreFile {
  version: 1;
  peers: unknown[];
}

interface PairingStoreFile {
  version: 2;
  peers: AcceptedTransportPeer[];
}

export class PairingHttpError extends Error {
  constructor(readonly status: number, readonly code: PairingErrorCode, message: string) {
    super(message);
  }
}

const PAIRING_ID_BYTES = 16;
export const PAIRING_ACCEPT_MAX_BYTES = 16 * 1024;
export const PAIRING_ID_PATTERN = /^pair_[A-Za-z0-9_-]{20,32}$/;
export const CLIENT_PEER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
export const PEER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const PAIRING_ACCEPT_MAX_FAILURES = 10;
const PAIRING_ACCEPT_FAILURE_WINDOW_MS = 60 * 1000;
const PAIRING_ACCEPT_FAILURE_MAX_BUCKETS = 1000;
const DEFAULT_PEER_ROLES: readonly PeerRole[] = ['observe', 'drive', 'files'];

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
    const pairingId = this.uniquePairingId();
    const brokerPeerId = this.uniqueBrokerPeerId();
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

  accept(pairingId: string, rawInput: unknown): {
    peer: { peerId: string; label?: string; identityPublicKey: string };
    broker: { peerId: string; peerToken: string; identityPublicKey: string };
    wrappedDataKey: WrappedDataKey;
    brokerProof: PairingAcceptanceProof;
  } {
    assertPairingId(pairingId);
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
    let input: PairingAcceptanceInput;
    try {
      input = validatePairingAcceptanceInput(rawInput);
    } catch (error) {
      this.recordPairingAcceptFailure(pairingId);
      if (error instanceof PairingHttpError) throw error;
      throw new PairingHttpError(400, 'PAIRING_INVALID_INPUT', 'pairing acceptance is invalid');
    }
    const { peerId, peerToken, identityPublicKey, exchangePublicKey } = input;
    if (!this.clientPeerIdAvailable(peerId)) {
      this.recordPairingAcceptFailure(pairingId);
      throw new PairingHttpError(409, 'PAIRING_ALREADY_ACCEPTED', 'peer identity collides with an existing endpoint');
    }
    const keys = loadOrCreateLocalKeyStore(this.keyDir, 'broker');
    const dataKey = generateDataKey();
    const wrappedDataKey = wrapDataKeyForPeer(dataKey, exchangePublicKey);
    const previousPeer = this.peers.get(peerId);
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
      authGeneration: previousPeer ? previousPeer.authGeneration + 1 : 1,
      roles: [...DEFAULT_PEER_ROLES],
      securityRevision: 17,
    };
    // Persist a candidate snapshot before publishing either in-memory mutation. A failed write or
    // rename leaves the one-use offer pending and the peer registry unchanged.
    const candidatePeers = new Map(this.peers);
    candidatePeers.set(peerId, peer);
    this.save(candidatePeers);
    this.peers.set(peerId, peer);
    offer.acceptedPeerId = peerId;
    this.pairingAcceptFailures.delete(pairingId);
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
    return this.revokeWithState(peerId) !== undefined;
  }

  /** Persist revocation before publishing it to memory. */
  revokeWithState(peerId: string): RevokedTransportPeer | undefined {
    const peer = this.peers.get(peerId);
    if (!peer || peer.revokedAt) return undefined;
    const revoked: AcceptedTransportPeer = {
      ...peer,
      authGeneration: peer.authGeneration + 1,
      revokedAt: new Date(this.now()).toISOString(),
    };
    const candidatePeers = new Map(this.peers);
    candidatePeers.set(peerId, revoked);
    this.save(candidatePeers);
    this.peers.set(peerId, revoked);
    return {
      peerId: revoked.peerId,
      brokerPeerId: revoked.brokerPeerId,
      authGeneration: revoked.authGeneration,
      credentialIdentity: `peer-token:${revoked.brokerPeerTokenHash}`,
    };
  }

  verifyPeerToken(peerId: string, peerToken: string): 'unknown' | 'ok' | 'forbidden' {
    const peer = this.peerForEndpoint(peerId);
    if (!peer) return 'unknown';
    if (peer.revokedAt) return 'forbidden';
    const hash = peer.peerId === peerId ? peer.peerTokenHash : peer.brokerPeerTokenHash;
    return safeTokenHashEquals(hash, tokenHash(peerToken)) ? 'ok' : 'forbidden';
  }

  verifyAnyPeerToken(peerToken: string): 'unknown' | 'ok' {
    return this.authenticatePeerToken(peerToken) ? 'ok' : 'unknown';
  }

  authenticatePeerToken(peerToken: string): AuthenticatedTransportPeer | undefined {
    const tokenHashValue = tokenHash(peerToken);
    for (const peer of this.peers.values()) {
      if (peer.revokedAt) continue;
      if (!safeTokenHashEquals(peer.brokerPeerTokenHash, tokenHashValue)) continue;
      return {
        peerId: peer.peerId,
        authGeneration: peer.authGeneration,
        roles: new Set(peer.roles),
        credentialIdentity: `peer-token:${peer.brokerPeerTokenHash}`,
      };
    }
    return undefined;
  }

  isPeerGenerationActive(peerId: string, authGeneration: number): boolean {
    const peer = this.peers.get(peerId);
    return !!peer && !peer.revokedAt && peer.authGeneration === authGeneration;
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
    if (!existsSync(this.path)) return;
    let parsed: LegacyPairingStoreFile | PairingStoreFile;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8')) as LegacyPairingStoreFile | PairingStoreFile;
    } catch {
      this.peers.clear();
      return;
    }
    if (!Array.isArray(parsed.peers)) return;

    if (parsed.version === 1) {
      // Revision 16 allowed every peer token to create another peer, so no record from that
      // schema has trustworthy owner-issued authorization provenance. Invalidate every legacy
      // credential before publishing the migrated map. A failed durable write aborts startup.
      const invalidatedAt = new Date(this.now()).toISOString();
      const candidate = new Map<string, AcceptedTransportPeer>();
      for (const rawPeer of parsed.peers) {
        const peer = normalizeStoredPeer(rawPeer, true);
        if (!peer) continue;
        candidate.set(peer.peerId, {
          ...peer,
          authGeneration: peer.authGeneration + (peer.revokedAt ? 0 : 1),
          roles: [],
          securityRevision: 17,
          revokedAt: peer.revokedAt ?? invalidatedAt,
        });
      }
      this.save(candidate);
      for (const [peerId, peer] of candidate) this.peers.set(peerId, peer);
      return;
    }
    if (parsed.version !== 2) return;
    try {
      for (const rawPeer of parsed.peers) {
        const peer = normalizeStoredPeer(rawPeer, false);
        if (peer) this.peers.set(peer.peerId, peer);
      }
    } catch {
      this.peers.clear();
    }
  }

  private save(peers: ReadonlyMap<string, AcceptedTransportPeer> = this.peers): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    // The store holds raw per-peer data keys — owner-only, matching cosyncing-keys.json.
    writeFileSync(tmp, JSON.stringify({ version: 2, peers: [...peers.values()] } satisfies PairingStoreFile, null, 2) + '\n', { mode: 0o600 });
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

  private endpointIdExists(peerId: string): boolean {
    return this.peers.has(peerId)
      || [...this.peers.values()].some((peer) => peer.brokerPeerId === peerId)
      || [...this.offers.values()].some((offer) => offer.brokerPeerId === peerId);
  }

  private clientPeerIdAvailable(peerId: string): boolean {
    const direct = this.peers.get(peerId);
    if (direct && !direct.revokedAt) return false;
    return ![...this.peers.values()].some((peer) => peer.brokerPeerId === peerId)
      && ![...this.offers.values()].some((offer) => offer.brokerPeerId === peerId);
  }

  private uniquePairingId(): string {
    for (;;) {
      const candidate = `pair_${randomBytes(PAIRING_ID_BYTES).toString('base64url')}`;
      if (!this.offers.has(candidate)) return candidate;
    }
  }

  private uniqueBrokerPeerId(): string {
    for (;;) {
      const candidate = `broker_${randomBytes(18).toString('base64url')}`;
      if (!this.endpointIdExists(candidate)) return candidate;
    }
  }
}

export interface PairingAcceptanceInput {
  peerId: string;
  peerToken: string;
  identityPublicKey: string;
  exchangePublicKey: string;
}

export function assertPairingId(pairingId: string): void {
  if (!PAIRING_ID_PATTERN.test(pairingId)) {
    throw new PairingHttpError(400, 'PAIRING_INVALID_INPUT', 'pairing id is invalid');
  }
}

/** Canonical public-boundary validator. The HTTP route and direct registry callers share it. */
export function validatePairingAcceptanceInput(raw: unknown): PairingAcceptanceInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PairingHttpError(400, 'PAIRING_INVALID_INPUT', 'pairing acceptance must be a JSON object');
  }
  const input = raw as Record<string, unknown>;
  const expected = ['exchangePublicKey', 'identityPublicKey', 'peerId', 'peerToken'];
  if (Object.keys(input).sort().join(',') !== expected.join(',')) {
    throw new PairingHttpError(400, 'PAIRING_INVALID_INPUT', 'pairing acceptance fields are invalid');
  }
  if (expected.some((field) => typeof input[field] !== 'string')) {
    throw new PairingHttpError(400, 'PAIRING_INVALID_INPUT', 'pairing acceptance fields must be strings');
  }
  const peerId = input.peerId as string;
  const peerToken = input.peerToken as string;
  const identityPublicKey = input.identityPublicKey as string;
  const exchangePublicKey = input.exchangePublicKey as string;
  if (!CLIENT_PEER_ID_PATTERN.test(peerId) || peerId.startsWith('broker_')) {
    throw new PairingHttpError(400, 'PAIRING_INVALID_INPUT', 'peerId is invalid or reserved');
  }
  if (!PEER_TOKEN_PATTERN.test(peerToken)) {
    throw new PairingHttpError(400, 'PAIRING_INVALID_INPUT', 'peerToken must be a strong base64url credential');
  }
  if (!publicKeyHasType(identityPublicKey, 'ed25519')) {
    throw new PairingHttpError(400, 'PAIRING_INVALID_INPUT', 'identityPublicKey must be an Ed25519 public key');
  }
  if (!publicKeyHasType(exchangePublicKey, 'x25519')) {
    throw new PairingHttpError(400, 'PAIRING_INVALID_INPUT', 'exchangePublicKey must be an X25519 public key');
  }
  return { peerId, peerToken, identityPublicKey, exchangePublicKey };
}

function publicKeyHasType(encoded: string, expected: 'ed25519' | 'x25519'): boolean {
  if (!/^[A-Za-z0-9_-]{40,256}$/.test(encoded)) return false;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return false;
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    return key.asymmetricKeyType === expected;
  } catch {
    return false;
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

function normalizeStoredPeer(raw: any, legacy: boolean): AcceptedTransportPeer | undefined {
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
    authGeneration: Number.isSafeInteger(raw.authGeneration) && raw.authGeneration > 0
      ? raw.authGeneration
      : 1,
    roles: legacy ? [] : normalizePeerRoles(raw.roles),
    securityRevision: legacy ? 17 : normalizePeerSecurityRevision(raw.securityRevision),
    ...(raw.revokedAt ? { revokedAt: String(raw.revokedAt) } : {}),
  };
}

function normalizePeerRoles(raw: unknown): PeerRole[] {
  if (!Array.isArray(raw)) throw new Error('peer-roles-invalid');
  const allowed = new Set<PeerRole>(['observe', 'drive', 'files', 'admin']);
  if (raw.some((role) => typeof role !== 'string' || !allowed.has(role as PeerRole))) {
    throw new Error('peer-roles-invalid');
  }
  return [...new Set(raw as PeerRole[])];
}

function normalizePeerSecurityRevision(raw: unknown): 17 {
  if (raw !== 17) throw new Error('peer-security-revision-invalid');
  return 17;
}
