/**
 * @cosyncing/transport-wire — versioned encrypted envelope helpers.
 *
 * The broker/relay routes only `TransportEnvelope` metadata plus opaque bytes. This package is the app-layer
 * bridge above transport and below broker/session semantics: clients seal JSON/bytes with an AES data key,
 * transports carry the ciphertext, and receivers authenticate metadata before opening it.
 */
import {
  decryptWithDataKey,
  encryptWithDataKey,
  generateDataKey,
  generateIdentityKeyPair,
  signBytes,
  type DataKey,
  type IdentityKeyPair,
  type SealedBytes,
  verifySignature,
} from '@cosyncing/crypto';
import type { Transport, TransportEnvelope } from '@cosyncing/transport';

export const WIRE_PROTOCOL_VERSION = 1;

export interface CipherEnvelope {
  version: 1;
  kind: 'cipher-envelope';
  envelopeId: string;
  channel: string;
  from?: string;
  to?: string;
  sealed: SealedBytes;
  senderIdentityPublicKey?: string;
  senderSignature?: string;
}

export interface OpenedEnvelope {
  id: string;
  channel: string;
  from?: string;
  to?: string;
  bytes: Uint8Array;
}

export interface SecureTransportPeer {
  peerId: string;
  peerToken?: string;
  dataKey: DataKey;
  identity: IdentityKeyPair;
  trustedSenders: Record<string, string>;
  replayCache?: ReplayCache;
}

export interface SecureTransportPair {
  local: SecureTransportPeer;
  remote: SecureTransportPeer;
}

export interface ReplayCache {
  has(id: string): boolean;
  add(id: string): void;
}

export class MemoryReplayCache implements ReplayCache {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly opts: { maxEntries?: number; ttlMs?: number; now?: () => number } = {},
  ) {}

  has(id: string): boolean {
    this.prune();
    return this.seen.has(id);
  }

  add(id: string): void {
    this.prune();
    this.seen.set(id, this.now() + (this.opts.ttlMs ?? 10 * 60 * 1000));
    const max = this.opts.maxEntries ?? 2000;
    while (this.seen.size > max) {
      const first = this.seen.keys().next().value;
      if (first == null) break;
      this.seen.delete(first);
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [id, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(id);
    }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

export function createSecureTransportPair(input: {
  localPeerId: string;
  remotePeerId: string;
  localPeerToken?: string;
  remotePeerToken?: string;
  dataKey?: DataKey;
}): SecureTransportPair {
  const dataKey = input.dataKey ?? generateDataKey();
  const localIdentity = generateIdentityKeyPair();
  const remoteIdentity = generateIdentityKeyPair();
  return {
    local: {
      peerId: input.localPeerId,
      ...(input.localPeerToken ? { peerToken: input.localPeerToken } : {}),
      dataKey,
      identity: localIdentity,
      trustedSenders: { [input.remotePeerId]: remoteIdentity.publicKey },
      replayCache: new MemoryReplayCache(),
    },
    remote: {
      peerId: input.remotePeerId,
      ...(input.remotePeerToken ? { peerToken: input.remotePeerToken } : {}),
      dataKey,
      identity: remoteIdentity,
      trustedSenders: { [input.localPeerId]: localIdentity.publicKey },
      replayCache: new MemoryReplayCache(),
    },
  };
}

export function securePeerFromPairing(input: {
  peerId: string;
  peerToken?: string;
  dataKey: DataKey;
  identity: IdentityKeyPair;
  trustedPeerId: string;
  trustedPeerIdentityPublicKey: string;
  replayCache?: ReplayCache;
}): SecureTransportPeer {
  return {
    peerId: input.peerId,
    ...(input.peerToken ? { peerToken: input.peerToken } : {}),
    dataKey: input.dataKey,
    identity: input.identity,
    trustedSenders: { [input.trustedPeerId]: input.trustedPeerIdentityPublicKey },
    replayCache: input.replayCache ?? new MemoryReplayCache(),
  };
}

export class SecureTransportClient {
  private readonly replayCache: ReplayCache;

  constructor(
    private readonly transport: Transport,
    private readonly peer: SecureTransportPeer,
  ) {
    this.replayCache = peer.replayCache ?? new MemoryReplayCache();
  }

  seal(input: {
    id: string;
    channel: string;
    bytes: Uint8Array;
    to: string;
    toPeerToken?: string;
    headers?: Record<string, string>;
  }): TransportEnvelope {
    return sealTransportEnvelope({
      key: this.peer.dataKey,
      id: input.id,
      from: this.peer.peerId,
      to: input.to,
      channel: input.channel,
      bytes: input.bytes,
      headers: {
        ...input.headers,
        ...(input.toPeerToken ? { 'x-cosyncing-to-token': input.toPeerToken } : {}),
      },
      senderIdentity: this.peer.identity,
    });
  }

  async send(input: Parameters<SecureTransportClient['seal']>[0]): Promise<void> {
    await this.transport.send(this.seal(input));
  }

  open(envelope: TransportEnvelope): OpenedEnvelope {
    const sender = envelope.from;
    if (!sender) throw new Error('secure transport envelope is missing sender');
    const trustedSenderPublicKey = this.peer.trustedSenders[sender];
    if (!trustedSenderPublicKey) throw new Error(`secure transport has no trusted sender public key for ${sender}`);
    return openTransportEnvelope(this.peer.dataKey, envelope, {
      trustedSenderPublicKey,
      replayCache: this.replayCache,
    });
  }

  async *receive(signal?: AbortSignal): AsyncIterable<OpenedEnvelope> {
    for await (const envelope of this.transport.receive(signal)) {
      yield this.open(envelope);
    }
  }
}

export function sealTransportEnvelope(input: {
  key: DataKey;
  id: string;
  channel: string;
  bytes: Uint8Array;
  from?: string;
  to?: string;
  headers?: Record<string, string>;
  senderIdentity?: IdentityKeyPair;
}): TransportEnvelope {
  const aad = envelopeAad(input);
  const cipherWithoutSignature: CipherEnvelope = {
    version: 1,
    kind: 'cipher-envelope',
    envelopeId: input.id,
    channel: input.channel,
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
    sealed: encryptWithDataKey(input.key, input.bytes, aad),
    ...(input.senderIdentity ? { senderIdentityPublicKey: input.senderIdentity.publicKey } : {}),
  };
  const cipher: CipherEnvelope = input.senderIdentity
    ? { ...cipherWithoutSignature, senderSignature: signBytes(input.senderIdentity.privateKey, senderSignaturePayload(cipherWithoutSignature)) }
    : cipherWithoutSignature;
  return {
    id: input.id,
    channel: input.channel,
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
    headers: {
      ...input.headers,
      'x-cosyncing-wire-version': String(WIRE_PROTOCOL_VERSION),
      'x-cosyncing-wire-kind': 'cipher-envelope',
    },
    bytes: new TextEncoder().encode(JSON.stringify(cipher)),
  };
}

export function openTransportEnvelope(key: DataKey, envelope: TransportEnvelope, opts: { trustedSenderPublicKey?: string; replayCache?: ReplayCache } = {}): OpenedEnvelope {
  const cipher = parseCipherEnvelope(envelope.bytes);
  if (cipher.envelopeId !== envelope.id) throw new Error('cipher envelope id does not match transport metadata');
  if (cipher.channel !== envelope.channel) throw new Error('cipher envelope channel does not match transport metadata');
  if ((cipher.from ?? '') !== (envelope.from ?? '')) throw new Error('cipher envelope sender does not match transport metadata');
  if ((cipher.to ?? '') !== (envelope.to ?? '')) throw new Error('cipher envelope recipient does not match transport metadata');
  if (opts.trustedSenderPublicKey) verifyCipherSender(cipher, opts.trustedSenderPublicKey);
  if (opts.replayCache?.has(envelope.id)) throw new Error(`replay detected for transport envelope ${envelope.id}`);
  const bytes = decryptWithDataKey(key, cipher.sealed, envelopeAad(envelope));
  opts.replayCache?.add(envelope.id);
  return {
    id: envelope.id,
    channel: envelope.channel,
    ...(envelope.from ? { from: envelope.from } : {}),
    ...(envelope.to ? { to: envelope.to } : {}),
    bytes,
  };
}

export function parseCipherEnvelope(bytes: Uint8Array): CipherEnvelope {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as CipherEnvelope;
  if (parsed.version !== 1) throw new Error('unsupported cipher envelope version');
  if (parsed.kind !== 'cipher-envelope') throw new Error('unsupported wire envelope kind');
  if (!parsed.envelopeId || !parsed.channel || !parsed.sealed) throw new Error('malformed cipher envelope');
  return parsed;
}

function verifyCipherSender(cipher: CipherEnvelope, trustedSenderPublicKey: string): void {
  if (!cipher.senderIdentityPublicKey || !cipher.senderSignature) throw new Error('cipher envelope is missing sender identity');
  if (cipher.senderIdentityPublicKey !== trustedSenderPublicKey) throw new Error('cipher envelope sender identity is not trusted');
  const withoutSignature = { ...cipher };
  delete withoutSignature.senderSignature;
  if (!verifySignature(trustedSenderPublicKey, senderSignaturePayload(withoutSignature), cipher.senderSignature)) {
    throw new Error('cipher envelope sender signature is invalid');
  }
}

function senderSignaturePayload(cipher: CipherEnvelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: WIRE_PROTOCOL_VERSION,
    kind: cipher.kind,
    envelopeId: cipher.envelopeId,
    channel: cipher.channel,
    from: cipher.from ?? '',
    to: cipher.to ?? '',
    sealed: {
      algorithm: cipher.sealed.algorithm,
      nonce: cipher.sealed.nonce,
      ciphertext: cipher.sealed.ciphertext,
      tag: cipher.sealed.tag,
    },
    senderIdentityPublicKey: cipher.senderIdentityPublicKey ?? '',
  }));
}

function envelopeAad(input: Pick<TransportEnvelope, 'id' | 'channel' | 'from' | 'to'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: WIRE_PROTOCOL_VERSION,
    id: input.id,
    channel: input.channel,
    from: input.from ?? '',
    to: input.to ?? '',
  }));
}
