/**
 * Pairing a device, revoking it, and the operator commands that do both.
 *
 * The owner mints a one-use offer, a device redeems it with no credential and
 * receives a per-device credential, and the owner can list and revoke devices
 * from the app's API or from `cosyncing pair` / `cosyncing devices`. What a
 * device and an operator notice is asserted: status codes and stable error
 * codes, what the peer store holds on disk, the attention events the owner
 * sees, and what the CLI prints and exits with.
 *
 * `cosyncing pair` is also run against fake endpoints served from this process
 * on the port an installation names: a foreign service, a cosyncing endpoint
 * that will not take this installation's credential, one that is still
 * starting, and one that stops answering. Their request ledgers show what the
 * command asked, and in particular that it never minted an offer twice.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createQrPairingPayload,
  generateIdentityKeyPair,
  generateX25519KeyPair,
  parseQrPairingPayload,
  verifySignature,
  type DataKey,
} from '../../packages/typescript/crypto/src/index.ts';
import { type TransportEnvelope } from '../../packages/typescript/transport/src/index.ts';
import { openTransportEnvelope, sealTransportEnvelope } from '../../packages/typescript/transport-wire/src/index.ts';
import { PRODUCT_IDENTITY, BROKER_CONTRACT_REVISION, BROKER_CONTRACT_SURFACE_HASH, CLIENT_MINIMUM_BROKER_CONTRACT_REVISION } from '../../packages/typescript/protocol/src/index.ts';
import {
  type Broker,
  type BrokerClient,
  eventually,
  startBroker,
} from '../harness/index.ts';
import { fixtureEnvironment, runCli } from '../harness/cli.ts';
import { type InstalledBroker, startInstalledBroker, writeInstalledState } from '../harness/installed.ts';
import {
  acceptanceBody,
  createOffer,
  deviceKeys,
  pairDevice,
  type PairedDevice,
  redeem,
} from '../harness/pairing.ts';

const hash = (token: string): string => createHash('sha256').update(token).digest('base64url');
const LEGACY_LABEL = 'legacy\npeer\u001b]52;c;payload\u0007';

let installed: InstalledBroker;
let broker: Broker;
let owner: BrokerClient;

function peerStore(): { version: number; peers: any[] } {
  return JSON.parse(readFileSync(join(broker.paths.cosyncingHome, 'transport-peers.json'), 'utf8'));
}

async function listedPeerIds(): Promise<string[]> {
  const peers = await owner.get('/api/transport/peers');
  expect(peers.status).toBe(200);
  return (peers.body.peers as any[]).map((peer) => peer.peerId);
}

async function attentionEvents(): Promise<any[]> {
  const events = await owner.get('/api/attention-events?clientId=pairing-e2e');
  expect(events.status).toBe(200);
  return events.body.events;
}

function cliEnv(home = broker.paths.cosyncingHome, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return fixtureEnvironment(broker.paths.root, broker.paths.bin, { COSYNCING_HOME: home, ...extra });
}

beforeAll(async () => {
  installed = await startInstalledBroker({
    name: 'pairing',
    env: {
      // Small enough that one test can fill a mailbox and overflow a body.
      COSYNCING_TRANSPORT_MAILBOX_MAX: '2',
      COSYNCING_TRANSPORT_MAX_BYTES: '4096',
    },
    setup: (paths) => {
      // A device paired by an older broker, whose label predates input checks.
      writeFileSync(join(paths.cosyncingHome, 'transport-peers.json'), `${JSON.stringify({
        version: 2,
        peers: [{
          peerId: 'legacy-labelled-peer',
          label: LEGACY_LABEL,
          identityPublicKey: 'legacy-identity',
          peerTokenHash: hash('legacy-mailbox'),
          brokerPeerId: 'broker-legacy-labelled',
          brokerPeerTokenHash: hash('legacy-broker-token'),
          brokerIdentityPublicKey: 'legacy-broker-identity',
          dataKey: { algorithm: 'AES-256-GCM', bytes: '' },
          wrappedDataKey: {},
          acceptedAt: new Date(0).toISOString(),
          authGeneration: 1,
          roles: ['observe'],
        }],
      })}\n`, { mode: 0o600 });
    },
  });
  broker = installed.broker;
  owner = installed.owner;
});

afterAll(async () => {
  await installed?.stop();
});

test('route proofs and read-only checks bind identity and caller; CORS trusts exact browser origins only', async () => {
  const configuration = (await owner.get('/api/connection/configuration')).body;
  const browserOrigin = 'https://app.example.test';
  const device = await pairDevice(owner, { peerId: 'route-check-device' });
  const peer = owner.as({ kind: 'peer', peerToken: device.peerToken });
  try {
    const nonce = randomBytes(32).toString('base64url');
    const anonymous = owner.as({ kind: 'none' });
    const proof = await anonymous.post('/api/connection/identity-proof', { nonce, origin: broker.url });
    expect(proof.status).toBe(200);
    expect(proof.body.identityPublicKey).toBe(device.offer.payload.publicKey);
    const proofBytes = new TextEncoder().encode(JSON.stringify([
      'cosyncing/server-routes-v1', nonce, broker.url, proof.body.identityPublicKey,
      proof.body.issuedAt, proof.body.expiresAt,
    ]));
    expect(verifySignature(device.offer.payload.publicKey, proofBytes, proof.body.signature)).toBe(true);
    expect(proof.body.expiresAt - proof.body.issuedAt).toBe(15000);
    expect(Object.keys(proof.body).sort()).toEqual(['expiresAt', 'identityPublicKey', 'issuedAt', 'nonce', 'origin', 'signature', 'version']);
    expect((await anonymous.post('/api/connection/identity-proof', { nonce, origin: 'https://unadvertised.example.test' })).status).toBe(403);
    expect((await anonymous.get('/api/connection/check')).status).toBe(401);
    expect((await peer.post('/api/connection/configuration', configuration)).status).toBe(403);
    for (const [method, path] of [
      ['GET', '/api/storage'], ['POST', '/api/storage/scans'], ['GET', '/api/storage/scans/unknown'],
      ['GET', '/api/storage/items'], ['POST', '/api/storage/cleanup-plans'], ['POST', '/api/storage/cleanup-jobs'],
      ['GET', '/api/storage/cleanup-jobs/unknown'], ['POST', '/api/storage/cleanup-jobs/unknown/cancel'],
    ] as const) expect((await peer.request(method, path, method === 'POST' ? {} : undefined)).status).toBe(403);
    const params = { clientVersion: 'e2e', contractRevision: String(BROKER_CONTRACT_REVISION),
      minimumBrokerRevision: String(CLIENT_MINIMUM_BROKER_CONTRACT_REVISION), contractSurfaceHash: BROKER_CONTRACT_SURFACE_HASH };
    // Bun's native client accepts headers; the shared DOM declaration only
    // exposes the browser constructor's protocols argument.
    const NativeWebSocket = WebSocket as typeof WebSocket & {
      new (url: string, options: { headers: Record<string, string> }): WebSocket;
    };
    const readOnlyCheck = (wsAuthTicket: string, origin: string) => new Promise<any[]>((resolve, reject) => {
      const frames: any[] = [];
      const url = `${broker.wsUrl}/api/connection/check/ws?wsAuthTicket=${encodeURIComponent(wsAuthTicket)}`;
      const socket = new NativeWebSocket(url, { headers: { origin } });
      const deadline = setTimeout(() => { socket.close(); reject(new Error('Read-only check did not close')); }, 10000);
      socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
      socket.onerror = () => { clearTimeout(deadline); reject(new Error('Read-only check failed')); };
      socket.onclose = () => { clearTimeout(deadline); resolve(frames); };
    });
    // Origin is not an access check: an untrusted page gets no CORS grant, so
    // its browser can neither read this nor preflight a credentialed request.
    const untrusted = await owner.get('/api/connection/check', { origin: browserOrigin });
    expect(untrusted.status).toBe(200);
    expect(untrusted.headers.get('access-control-allow-origin')).toBeNull();
    const untrustedPreflight = await anonymous.request('OPTIONS', '/api/storage/cleanup-plans', undefined, {
      origin: browserOrigin, 'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-cosyncing-token',
    });
    expect(untrustedPreflight.headers.get('access-control-allow-origin')).toBeNull();
    // Behind a TLS-terminating proxy (Tailscale serve, Caddy) the broker sees
    // http://host while its own page sends Origin: https://host.
    const proxiedPage = broker.url.replace(/^http:/, 'https:');
    const proxiedTicket = await peer.post('/api/ws-auth-tickets', { audience: 'connection-check', params }, { origin: proxiedPage });
    expect(proxiedTicket.status).toBe(201);
    expect((await readOnlyCheck(proxiedTicket.body.wsAuthTicket, proxiedPage))[0]?.kind).toBe('connection-check');
    const allowed = await owner.post('/api/connection/configuration', {
      ...configuration, trustedClientOrigins: [browserOrigin],
    });
    expect(allowed.status).toBe(200);
    const preflight = await anonymous.request('OPTIONS', '/api/storage/cleanup-plans', undefined, {
      origin: browserOrigin, 'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-cosyncing-token',
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(browserOrigin);
    expect(preflight.headers.get('vary')).toContain('Origin');
    const uploadPreflight = await anonymous.request('OPTIONS', '/api/sessions/pi/fixture/uploads/fixture', undefined, {
      origin: browserOrigin, 'access-control-request-method': 'PATCH',
      'access-control-request-headers': 'content-type,x-cosyncing-peer-token,x-cosyncing-upload-offset',
    });
    expect(uploadPreflight.status).toBe(204);
    const conditionalRead = await anonymous.request('OPTIONS', '/api/sessions', undefined, {
      origin: browserOrigin, 'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-cosyncing-token,if-none-match',
    });
    expect(conditionalRead.status).toBe(204);
    expect(conditionalRead.headers.get('access-control-expose-headers')).toContain('X-Cosyncing-Content-Hash');
    const refused = await anonymous.get('/api/connection/check', { origin: browserOrigin });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('access-control-allow-origin')).toBe(browserOrigin);
    const lookalike = await owner.get('/api/connection/check', { origin: `${browserOrigin}.evil.test` });
    expect(lookalike.headers.get('access-control-allow-origin')).toBeNull();
    const checked = await peer.get('/api/connection/check', { origin: browserOrigin });
    expect(checked.status).toBe(200);
    expect(checked.body.identityPublicKey).toBe(proof.body.identityPublicKey);
    expect(checked.body.principalId).not.toBe((await owner.get('/api/connection/check')).body.principalId);
    const ticket = await peer.post('/api/ws-auth-tickets', { audience: 'connection-check', params }, { origin: browserOrigin });
    expect(ticket.status).toBe(201);
    const frames = await readOnlyCheck(ticket.body.wsAuthTicket, browserOrigin);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: 'connection-check', principalId: checked.body.principalId,
      identityPublicKey: checked.body.identityPublicKey, authGeneration: checked.body.authGeneration });
    expect((await anonymous.get(`/api/connection/check/ws?wsAuthTicket=${ticket.body.wsAuthTicket}`, { origin: browserOrigin })).status).toBe(401);
    expect((await anonymous.get('/api/sessions', { origin: browserOrigin })).status).toBe(401);
  } finally {
    const current = (await owner.get('/api/connection/configuration')).body;
    await owner.post('/api/connection/configuration', { ...configuration, generation: current.generation });
    await owner.delete(`/api/transport/peers/${device.peerId}`);
    peer.closeAll();
  }
});

describe('offers', () => {
  test('an offer is a v3 QR with no URL unless one is asked for, and never carries a secret', async () => {
    const urlFree = await createOffer(owner, { clientLabel: 'phone' });
    expect(urlFree.payload.version).toBe(3);
    expect(urlFree.payload.transport).toEqual({ kind: 'broker-url' });
    expect(urlFree.qr).not.toMatch(/privateKey|DataKey|token/i);
    expect(urlFree.qr).not.toContain(installed.credentials.brokerToken);

    const reachable = await createOffer(owner, { brokerUrl: 'https://example.test/' });
    expect(reachable.payload.transport).toEqual({ kind: 'broker-url', url: 'https://example.test' });

    for (const brokerUrl of ['ftp://example.test', 'https://user:secret@example.test', 'https://example.test/path']) {
      const refused = await owner.post('/api/transport/pairings', { brokerUrl });
      expect(refused.status, brokerUrl).toBe(400);
      expect(refused.body.code, brokerUrl).toBe('PAIRING_INVALID_INPUT');
    }
  });

  test('a device redeems an offer with no credential and holds a revocable, owner-only record', async () => {
    const previousEvents = new Set((await attentionEvents()).map((event) => event.id));
    const device = await pairDevice(owner, { peerId: 'phone-1', clientLabel: 'Test phone' });
    const status = await owner.get(`/api/transport/pairings/${device.offer.pairingId}`);
    expect(status.body.state).toBe('accepted');
    expect(status.body.peerId).toBe('phone-1');
    expect(JSON.stringify(status.body)).not.toContain(device.peerToken);
    expect(await listedPeerIds()).toContain('phone-1');

    const asDevice = owner.as({ kind: 'peer', peerToken: device.peerToken });
    expect((await asDevice.get('/api/sessions')).status).toBe(200);

    const store = peerStore();
    const record = store.peers.find((peer) => peer.peerId === 'phone-1');
    expect(store.version).toBe(2);
    expect(record.roles.sort()).toEqual(['drive', 'files', 'observe']);
    expect(record.authGeneration).toBe(1);
    const raw = JSON.stringify(store);
    expect(raw).not.toContain(device.mailboxToken);
    expect(raw).not.toContain(device.peerToken);
    if (process.platform !== 'win32') {
      expect(statSync(join(broker.paths.cosyncingHome, 'transport-peers.json')).mode & 0o777).toBe(0o600);
    }

    const paired = (await attentionEvents()).filter((event) => event.kind === 'device-paired' && !previousEvents.has(event.id));
    expect(paired).toHaveLength(1);
    expect(paired[0].state).toBe('resolved');
    expect(paired[0].severity).toBe('informational');
    expect(JSON.stringify(paired[0])).not.toContain(device.mailboxToken);
    expect(JSON.stringify(paired[0])).not.toContain(device.identity.publicKey);
  });

  test('an offer is one-use, and guessing offers is rate-limited per id', async () => {
    const keys = deviceKeys('phone-one-use');
    const offer = await createOffer(owner);
    expect((await redeem(owner, offer.pairingId, acceptanceBody(keys))).status).toBe(200);
    const replay = await redeem(owner, offer.pairingId, acceptanceBody(keys));
    expect(replay.status).toBe(409);
    expect(replay.body.error).toMatch(/review connected devices/);

    const guessed = 'pair_not_found_rate_limit';
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const miss = await redeem(owner, guessed, acceptanceBody(deviceKeys('phone-guess')));
      expect(miss.status).toBe(404);
      expect(miss.body.code).toBe('PAIRING_NOT_FOUND');
    }
    const limited = await redeem(owner, guessed, acceptanceBody(deviceKeys('phone-guess')));
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('PAIRING_RATE_LIMITED');
  });

  test('malformed acceptances are refused and do not consume the offer', async () => {
    const offer = await createOffer(owner, { clientLabel: 'Adversarial phone' });
    const other = await createOffer(owner, { clientLabel: 'Other endpoint' });
    const keys = deviceKeys('client-adversarial');
    const valid = acceptanceBody(keys);
    const cases: unknown[] = [
      { ...valid, peerId: 'client\nnewline' },
      { ...valid, peerId: 'client\u001b]52;c;payload\u0007' },
      { ...valid, peerId: offer.brokerPeerId },
      { ...valid, peerId: other.brokerPeerId },
      { ...valid, peerToken: 'x' },
      { ...valid, identityPublicKey: keys.exchange.publicKey },
      { ...valid, exchangePublicKey: keys.identity.publicKey },
      { ...valid, peerId: 42 },
      { ...valid, extra: true },
    ];
    for (const input of cases) {
      const refused = await redeem(owner, offer.pairingId, input);
      expect(refused.status, JSON.stringify(input).slice(0, 80)).toBe(400);
    }
    expect((await owner.get(`/api/transport/pairings/${offer.pairingId}`)).body.state).toBe('pending');
    expect(await listedPeerIds()).not.toContain('client-adversarial');
    expect((await redeem(owner, offer.pairingId, valid)).status).toBe(200);
  });

  test('a store write that fails leaves the offer pending and no device paired', async () => {
    const storePath = join(broker.paths.cosyncingHome, 'transport-peers.json');
    const aside = `${storePath}.e2e-aside`;
    const offer = await createOffer(owner);
    const keys = deviceKeys('phone-write-failure');
    renameSync(storePath, aside);
    mkdirSync(storePath);
    try {
      const failed = await redeem(owner, offer.pairingId, acceptanceBody(keys));
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(failed.text).not.toContain(broker.paths.root);
    } finally {
      rmSync(storePath, { recursive: true, force: true });
      renameSync(aside, storePath);
    }
    expect((await owner.get(`/api/transport/pairings/${offer.pairingId}`)).body.state).toBe('pending');
    expect(await listedPeerIds()).not.toContain('phone-write-failure');
    expect((await redeem(owner, offer.pairingId, acceptanceBody(keys))).status).toBe(200);
    expect(await listedPeerIds()).toContain('phone-write-failure');
  });

  test('a pairing that committed is not reported as failed when its attention notice cannot be written', async () => {
    const attentionPath = join(broker.paths.cosyncingHome, 'attention-events.json');
    const aside = `${attentionPath}.e2e-aside`;
    renameSync(attentionPath, aside);
    mkdirSync(attentionPath);
    try {
      const device = await pairDevice(owner, { peerId: 'phone-attention-failure' });
      expect(device.peerId).toBe('phone-attention-failure');
      expect(await listedPeerIds()).toContain('phone-attention-failure');
    } finally {
      rmSync(attentionPath, { recursive: true, force: true });
      renameSync(aside, attentionPath);
    }
  });
});

describe('revocation', () => {
  test('revoking ends the device\'s access at once and across a restart; re-pairing advances its generation', async () => {
    const first = await pairDevice(owner, { peerId: 'phone-repair', clientLabel: 'Repair phone' });
    const asFirst = owner.as({ kind: 'peer', peerToken: first.peerToken });
    expect((await asFirst.get('/api/sessions')).status).toBe(200);

    const revoked = await owner.delete('/api/transport/peers/phone-repair');
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);
    expect((await asFirst.get('/api/sessions')).status).toBe(401);
    expect(await listedPeerIds()).not.toContain('phone-repair');
    const alerts = (await attentionEvents()).filter((event) => event.title === 'Device access revoked');
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts.every((event) => event.kind === 'security-alert' && event.severity === 'action-required')).toBe(true);

    await broker.restart();
    expect((await asFirst.get('/api/sessions')).status).toBe(401);
    expect(await listedPeerIds()).not.toContain('phone-repair');

    const second = await pairDevice(owner, { peerId: 'phone-repair', clientLabel: 'Repair phone, again' });
    // The broker's signing identity is durable: a device paired before the restart still recognises it.
    expect(second.offer.payload.publicKey).toBe(first.offer.payload.publicKey);
    expect((await owner.as({ kind: 'peer', peerToken: second.peerToken }).get('/api/sessions')).status).toBe(200);
    expect((await asFirst.get('/api/sessions')).status).toBe(401);
    expect(peerStore().peers.find((peer) => peer.peerId === 'phone-repair').authGeneration).toBe(3);
  });

  test('a revocation that cannot be saved is reported as failed, never as a revocation a restart would undo', async () => {
    const device = await pairDevice(owner, { peerId: 'phone-revoke-write-failure' });
    const asDevice = owner.as({ kind: 'peer', peerToken: device.peerToken });
    const storePath = join(broker.paths.cosyncingHome, 'transport-peers.json');
    const aside = `${storePath}.e2e-aside`;
    renameSync(storePath, aside);
    mkdirSync(storePath);
    try {
      const failed = await owner.delete('/api/transport/peers/phone-revoke-write-failure');
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(failed.text).not.toContain(broker.paths.root);
    } finally {
      rmSync(storePath, { recursive: true, force: true });
      renameSync(aside, storePath);
    }
    // What the owner sees agrees with what a restart would load: still paired.
    expect(await listedPeerIds()).toContain('phone-revoke-write-failure');
    expect((await asDevice.get('/api/sessions')).status).toBe(200);

    expect((await owner.delete('/api/transport/peers/phone-revoke-write-failure')).status).toBe(200);
    expect((await asDevice.get('/api/sessions')).status).toBe(401);
  });
});

// ── Encrypted envelopes ────────────────────────────────────────────────────

function envelopeHeaders(envelope: TransportEnvelope, extra: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/octet-stream',
    'x-cosyncing-envelope-id': envelope.id,
    'x-cosyncing-channel': envelope.channel,
    ...(envelope.from ? { 'x-cosyncing-from': envelope.from } : {}),
    ...(envelope.to ? { 'x-cosyncing-to': envelope.to } : {}),
    ...(envelope.headers ?? {}),
    ...extra,
  };
}

function postBytes(path: string, headers: Record<string, string>, bytes: Uint8Array): Promise<globalThis.Response> {
  return fetch(`${broker.url}${path}`, { method: 'POST', headers, body: new Uint8Array(bytes) as Uint8Array<ArrayBuffer> });
}

function seal(device: PairedDevice, id: string, payload: unknown, senderIdentity = device.identity, key: DataKey = device.dataKey): TransportEnvelope {
  return sealTransportEnvelope({
    key,
    id,
    from: device.peerId,
    to: device.brokerPeerId,
    channel: 'session-control',
    bytes: new TextEncoder().encode(JSON.stringify(payload)),
    headers: { 'x-cosyncing-to-token': device.peerToken },
    senderIdentity,
  });
}

describe('encrypted transport', () => {
  let device: PairedDevice;
  const owned = (): Record<string, string> => ({ [PRODUCT_IDENTITY.tokenHeader]: installed.credentials.brokerToken });

  beforeAll(async () => {
    device = await pairDevice(owner, { peerId: 'phone-envelopes' });
  });

  test('a mailbox carries opaque sealed bytes to its paired reader, once', async () => {
    const plaintext = new TextEncoder().encode(JSON.stringify({ kind: 'ping', value: 42, secret: 'BROKER_MUST_NOT_SEE_THIS' }));
    const sealed = sealTransportEnvelope({
      key: device.dataKey, id: 'mailbox-env-1', from: 'phone', to: device.peerId, channel: 'ciphertext', bytes: plaintext,
    });
    const mailbox = `/api/transport/envelopes?peer=${device.peerId}`;
    expect((await fetch(`${broker.url}${mailbox}`)).status).toBe(401);
    expect((await fetch(`${broker.url}${mailbox}`, { headers: owned() })).status).toBe(403);

    const queued = await postBytes('/api/transport/envelopes',
      envelopeHeaders(sealed, { ...owned(), 'x-cosyncing-to-token': device.mailboxToken }), sealed.bytes);
    expect(queued.status).toBe(202);

    const read = await fetch(`${broker.url}${mailbox}`, { headers: { ...owned(), 'x-cosyncing-peer-token': device.mailboxToken } });
    const envelopes = (await read.json() as any).envelopes as any[];
    expect(envelopes.map((envelope) => envelope.id)).toEqual(['mailbox-env-1']);
    const bytes = new Uint8Array(Buffer.from(envelopes[0].bytes, 'base64url'));
    expect(new TextDecoder().decode(bytes)).not.toContain('BROKER_MUST_NOT_SEE_THIS');
    const opened = openTransportEnvelope(device.dataKey, { ...envelopes[0], bytes });
    expect(new TextDecoder().decode(opened.bytes)).toBe(new TextDecoder().decode(plaintext));

    const drained = await fetch(`${broker.url}${mailbox}`, { headers: { ...owned(), 'x-cosyncing-peer-token': device.mailboxToken } });
    expect((await drained.json() as any).envelopes).toEqual([]);
  });

  test('a mailbox keeps its newest envelopes and refuses an oversized body before reading it', async () => {
    const send = (id: string, body: Uint8Array) => postBytes('/api/transport/envelopes', {
      ...owned(),
      'content-type': 'application/octet-stream',
      'x-cosyncing-envelope-id': id,
      'x-cosyncing-channel': 'test',
      'x-cosyncing-to': device.peerId,
      'x-cosyncing-to-token': device.mailboxToken,
    }, body);
    expect((await send('too-large', new Uint8Array(8 * 1024))).status).toBe(413);
    for (const id of ['env-1', 'env-2', 'env-3']) {
      expect((await send(id, new TextEncoder().encode(id))).status).toBe(202);
    }
    const read = await fetch(`${broker.url}/api/transport/envelopes?peer=${device.peerId}`, {
      headers: { ...owned(), 'x-cosyncing-peer-token': device.mailboxToken },
    });
    expect(((await read.json() as any).envelopes as any[]).map((envelope) => envelope.id)).toEqual(['env-2', 'env-3']);
  });

  test('session control opens only a signed envelope from the paired device, once', async () => {
    const payload = {
      kind: 'approve', tool: 'opencode', sessionId: 'session-control-test', mode: 'live', requestId: 'perm-1', decision: 'approve',
    };
    const envelope = seal(device, 'control-env-1', payload);
    const headers = envelopeHeaders(envelope, owned());
    const opened = await postBytes('/api/transport/session-control', headers, envelope.bytes);
    expect(opened.status).toBe(202);
    const body = await opened.json() as any;
    expect(body.control).toMatchObject({ kind: 'approve', tool: 'opencode', sessionId: 'session-control-test', routed: false });

    const replay = await postBytes('/api/transport/session-control', headers, envelope.bytes);
    expect(replay.status).toBe(409);
    expect(JSON.stringify(await replay.json())).toMatch(/replay/i);

    const forged = seal(device, 'control-env-forged', payload, generateIdentityKeyPair());
    const forgedResponse = await postBytes('/api/transport/session-control', envelopeHeaders(forged, owned()), forged.bytes);
    expect(forgedResponse.status).toBe(403);
    expect(JSON.stringify(await forgedResponse.json())).toMatch(/sender identity/i);

    // The outer routing metadata is bound into the ciphertext: relabelling it fails.
    const relabel = seal(device, 'control-env-relabel', payload);
    const relabelled = await postBytes('/api/transport/session-control',
      envelopeHeaders(relabel, { ...owned(), 'x-cosyncing-envelope-id': 'control-env-other' }), relabel.bytes);
    expect(relabelled.status).toBe(400);
  });

  test('a device cannot send as another, and revoking a device purges what it queued', async () => {
    const a = await pairDevice(owner, { peerId: 'peer-a' });
    const b = await pairDevice(owner, { peerId: 'peer-b' });
    const headers = {
      'content-type': 'application/octet-stream',
      'x-cosyncing-channel': 'generic',
      'x-cosyncing-to': b.peerId,
      'x-cosyncing-to-token': b.mailboxToken,
      'x-cosyncing-peer-token': a.peerToken,
    };
    const send = (id: string, extra: Record<string, string> = {}) =>
      postBytes('/api/transport/envelopes', { ...headers, 'x-cosyncing-envelope-id': id, ...extra }, new TextEncoder().encode(id));
    expect((await send('queued-by-a')).status).toBe(202);
    expect((await send('spoofed-sender', { 'x-cosyncing-from': 'someone-else' })).status).toBe(403);
    expect((await owner.delete(`/api/transport/peers/${a.peerId}`)).status).toBe(200);
    const mailbox = await fetch(`${broker.url}/api/transport/envelopes?peer=${b.peerId}`, {
      headers: { ...owned(), 'x-cosyncing-peer-token': b.mailboxToken },
    });
    expect(mailbox.status).toBe(200);
    expect((await mailbox.json() as any).envelopes).toEqual([]);
  });
});

// ── The operator commands against the real broker ──────────────────────────

describe('cosyncing pair and cosyncing devices', () => {
  test('pair --json creates one offer for the requested URL and prints no secret', async () => {
    const result = await runCli(['pair', '--json', '--broker-url', 'https://cosy.example.test'], { env: cliEnv() });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode, result.output).toBe(0);
    const document = JSON.parse(result.stdout);
    expect(document.schemaVersion).toBe(1);
    expect(document.tokenScope).toBe('observe-drive-files-v1');
    expect(document.brokerUrl).toBe('https://cosy.example.test');
    expect(parseQrPairingPayload(document.qr).transport).toEqual({ kind: 'broker-url', url: 'https://cosy.example.test' });
    expect(result.output).not.toContain(installed.credentials.brokerToken);
    expect((await owner.get(`/api/transport/pairings/${document.pairingId}`)).body.state).toBe('pending');
  });

  test('pair --status reports pending, then accepted, then not-found for an offer it never saw', async () => {
    const offer = await createOffer(owner);
    const pending = await runCli(['pair', '--status', offer.pairingId, '--json', '--timeout', '1'], { env: cliEnv() });
    expect(pending.exitCode, pending.output).toBe(0);
    expect(JSON.parse(pending.stdout).state).toBe('pending');

    const keys = deviceKeys('phone-cli-status');
    expect((await redeem(owner, offer.pairingId, acceptanceBody(keys))).status).toBe(200);
    const accepted = await runCli(['pair', '--status', offer.pairingId, '--json'], { env: cliEnv() });
    expect(accepted.exitCode, accepted.output).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({ state: 'accepted', peerId: 'phone-cli-status' });

    const unknown = await runCli(['pair', '--status', 'pair_never_issued_1234567890', '--json', '--timeout', '1'], { env: cliEnv() });
    expect(JSON.parse(unknown.stdout).state).toBe('not-found');

    const malformed = await runCli(['pair', '--status', 'pair_short', '--json'], { env: cliEnv() });
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stderr).toContain('pairing-id-invalid');
  });

  test('plain pair shows the one-use link and where the token lives, never the token', async () => {
    const result = await runCli(['pair'], { env: cliEnv() });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.stdout).toMatch(/cosyncing:\/\/pair\?payload=/);
    expect(result.stdout).toContain(join(broker.paths.cosyncingHome, 'secrets', 'broker-token'));
    expect(result.output).not.toContain(installed.credentials.brokerToken);
  });

  test('devices list escapes a stored label, and devices revoke ends a device\'s access', async () => {
    const listed = await runCli(['devices', 'list'], { env: cliEnv() });
    expect(listed.exitCode, listed.output).toBe(0);
    expect(listed.stdout).toContain('legacy-labelled-peer');
    expect(listed.stdout).toContain('\\u001b');
    expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(listed.stdout)).toBe(false);

    const device = await pairDevice(owner, { peerId: 'phone-cli-revoke' });
    const json = await runCli(['devices', 'list', '--json'], { env: cliEnv() });
    expect(JSON.parse(json.stdout).peers.map((peer: any) => peer.peerId)).toContain('phone-cli-revoke');
    expect(json.stdout).not.toContain(device.peerToken);

    const revoked = await runCli(['devices', 'revoke', 'phone-cli-revoke', '--yes', '--json'], { env: cliEnv() });
    expect(revoked.exitCode, revoked.output).toBe(0);
    expect((await owner.as({ kind: 'peer', peerToken: device.peerToken }).get('/api/sessions')).status).toBe(401);
  });
});

// ── cosyncing pair against endpoints that are not this broker ──────────────

interface FakeEndpoint {
  port: number;
  home: string;
  requests: string[];
  stop(): void;
}

/**
 * Serve `handler` on a fresh loopback port and write an installation that
 * names that port, so `cosyncing pair` talks to it as its own broker.
 */
async function fakeEndpoint(
  handler: (request: Request, ledger: string[], server: ReturnType<typeof Bun.serve>) => Response | Promise<Response>,
): Promise<FakeEndpoint> {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, srv) {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return handler(request, requests, srv);
    },
  });
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-pair-fake-'));
  writeInstalledState(home, server.port!, { machineLabel: 'fake-endpoint-machine' });
  return {
    port: server.port!,
    home,
    requests,
    stop() {
      server.stop(true);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const posts = (requests: string[]): number => requests.filter((request) => request.startsWith('POST')).length;

describe('cosyncing pair against an endpoint that is not this broker', () => {
  const env = (home: string) => cliEnv(home, { COSYNCING_TEST_PAIR_IDENTITY_DEADLINE_MS: '1500' });

  test('a foreign service is a verdict at once, and nothing is offered through it', async () => {
    const fake = await fakeEndpoint(() => Response.json({ ok: true, product: 'other-product', machine: 'elsewhere' }));
    try {
      const result = await runCli(['pair', '--json', '--broker-url', 'https://cosy.example.test'], { env: env(fake.home) });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('local-broker-identity-mismatch');
      expect(fake.requests).toEqual(['GET /api/health']);
    } finally {
      fake.stop();
    }
  });

  test('a cosyncing endpoint that will not take this credential is waited out, then named with a listener probe', async () => {
    const fake = await fakeEndpoint(() => Response.json({ ok: true, product: 'cosyncing', version: '0.0.0' }));
    try {
      const result = await runCli(['pair', '--json', '--broker-url', 'https://cosy.example.test'], { env: env(fake.home) });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('local-broker-credential-unauthenticated');
      expect(result.stderr).toContain(`A cosyncing endpoint on port ${fake.port}`);
      expect(result.stderr).toContain("did not accept this installation's credential");
      expect(result.stderr).toContain(`ss -ltnp | grep :${fake.port}`);
      expect(result.stderr).not.toMatch(/local broker/i);
      expect(result.stderr).not.toContain('Run: cosyncing setup');
      expect(fake.requests.length).toBeGreaterThan(1);
      expect(posts(fake.requests)).toBe(0);
    } finally {
      fake.stop();
    }
  });

  test('a broker that is still starting is waited for, and the offer is minted exactly once', async () => {
    const brokerKeys = generateX25519KeyPair();
    let healthProbes = 0;
    const fake = await fakeEndpoint((request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/health') {
        healthProbes += 1;
        // A just-restarted broker answers before it has read the new token.
        return healthProbes < 3
          ? Response.json({ ok: true, product: 'cosyncing', version: '0.0.0' })
          : Response.json({ ok: true, product: 'cosyncing', machine: 'fake-endpoint-machine' });
      }
      const pairingId = 'pair_fake_endpoint_offer_000001';
      return Response.json({
        ok: true,
        pairingId,
        qr: createQrPairingPayload({
          version: 3,
          brokerId: 'broker_fake',
          pairingId,
          publicKey: brokerKeys.publicKey,
          transport: { kind: 'broker-url', url: 'https://cosy.example.test' },
        }),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        brokerPeerId: 'broker_fake',
      }, { status: 201 });
    });
    try {
      const result = await runCli(['pair', '--json', '--broker-url', 'https://cosy.example.test'], { env: env(fake.home) });
      expect(result.exitCode, result.output).toBe(0);
      expect(JSON.parse(result.stdout).pairingId).toBe('pair_fake_endpoint_offer_000001');
      expect(healthProbes).toBe(3);
      expect(posts(fake.requests)).toBe(1);
    } finally {
      fake.stop();
    }
  });

  test('an offer request whose answer is lost is never sent again', async () => {
    const fake = await fakeEndpoint((request, _ledger, server) => {
      if (new URL(request.url).pathname === '/api/health') {
        return Response.json({ ok: true, product: 'cosyncing', machine: 'fake-endpoint-machine' });
      }
      // The request arrived; the connection dies before the answer does.
      server.stop(true);
      return new Promise<Response>(() => undefined);
    });
    try {
      const result = await runCli(['pair', '--json', '--broker-url', 'https://cosy.example.test'], { env: env(fake.home) });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('pairing-create-unverified');
      expect(posts(fake.requests)).toBe(1);
    } finally {
      fake.stop();
    }
  });

  test('--status never calls an unusable or vanished answer pending', async () => {
    const healthy = () => Response.json({ ok: true, product: 'cosyncing', machine: 'fake-endpoint-machine' });
    const malformed = await fakeEndpoint((request) =>
      new URL(request.url).pathname === '/api/health' ? healthy() : Response.json({ ok: true, product: 'cosyncing' }));
    try {
      const result = await runCli(['pair', '--status', 'pair_fake_status_offer_000001', '--json', '--timeout', '1'], { env: env(malformed.home) });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).state).toBe('unverifiable');
      expect(posts(malformed.requests)).toBe(0);
    } finally {
      malformed.stop();
    }

    let reads = 0;
    const vanishing = await fakeEndpoint((request, _ledger, server) => {
      if (new URL(request.url).pathname === '/api/health') return healthy();
      reads += 1;
      if (reads === 1) return Response.json({ ok: true, state: 'pending', pairingId: 'pair_fake_status_offer_000002' });
      server.stop(true);
      return new Promise<Response>(() => undefined);
    });
    try {
      const result = await runCli(['pair', '--status', 'pair_fake_status_offer_000002', '--json', '--timeout', '2'], { env: env(vanishing.home) });
      expect(result.exitCode).toBe(1);
      // Pending, then silence: the last answer is not "still pending".
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, state: 'unverifiable' });
      expect(reads).toBeGreaterThan(1);
    } finally {
      vanishing.stop();
    }
  });
});

// ── Short-lived offers and envelopes ───────────────────────────────────────

describe('expiry', () => {
  let short: Broker;
  const mailboxToken = 'expiry-mailbox-token-0123456789abcdefghijklmnop';
  beforeAll(async () => {
    short = await startBroker({
      name: 'pairing-expiry',
      token: true,
      env: { COSYNCING_TRANSPORT_PAIRING_TTL_MS: '1000', COSYNCING_TRANSPORT_TTL_MS: '1' },
      setup: (paths) => {
        writeFileSync(join(paths.cosyncingHome, 'transport-peers.json'), `${JSON.stringify({
          version: 2,
          peers: [{
            peerId: 'expiry-peer',
            identityPublicKey: 'expiry-identity',
            peerTokenHash: hash(mailboxToken),
            brokerPeerId: 'broker-expiry',
            brokerPeerTokenHash: hash('expiry-broker-token'),
            brokerIdentityPublicKey: 'expiry-broker-identity',
            dataKey: { algorithm: 'AES-256-GCM', bytes: '' },
            wrappedDataKey: {},
            acceptedAt: new Date(0).toISOString(),
            authGeneration: 1,
            roles: ['observe', 'drive', 'files'],
          }],
        })}\n`, { mode: 0o600 });
      },
    });
  });
  afterAll(() => short?.stop());

  test('an offer nobody redeemed in time reports expired and refuses its device', async () => {
    const offer = await createOffer(short.client(), { clientLabel: 'Expired phone' });
    const expiresAt = Date.parse(offer.expiresAt);
    await eventually(() => Date.now() > expiresAt + 50, { what: 'the offer lifetime to pass' });
    expect((await short.client().get(`/api/transport/pairings/${offer.pairingId}`)).body.state).toBe('expired');
    const late = await redeem(short.client(), offer.pairingId, acceptanceBody(deviceKeys('phone-expired')));
    expect(late.status).toBe(410);
    expect(late.body.code).toBe('PAIRING_EXPIRED');
  });

  test('an envelope nobody collected in time is gone', async () => {
    const sentAt = Date.now();
    const queued = await fetch(`${short.url}/api/transport/envelopes`, {
      method: 'POST',
      headers: {
        [PRODUCT_IDENTITY.tokenHeader]: short.token!,
        'content-type': 'application/octet-stream',
        'x-cosyncing-envelope-id': 'expires',
        'x-cosyncing-channel': 'test',
        'x-cosyncing-to': 'expiry-peer',
        'x-cosyncing-to-token': mailboxToken,
      },
      body: new TextEncoder().encode('ok'),
    });
    expect(queued.status).toBe(202);
    await eventually(() => Date.now() > sentAt + 50, { what: 'the envelope lifetime to pass' });
    const read = await fetch(`${short.url}/api/transport/envelopes?peer=expiry-peer`, {
      headers: { [PRODUCT_IDENTITY.tokenHeader]: short.token!, 'x-cosyncing-peer-token': mailboxToken },
    });
    expect((await read.json() as any).envelopes).toEqual([]);
  });
});
