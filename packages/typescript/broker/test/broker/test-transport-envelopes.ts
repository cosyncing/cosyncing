import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateDataKey,
  generateIdentityKeyPair,
  generateX25519KeyPair,
  parseQrPairingPayload,
  unwrapDataKey,
  verifySignature,
  type DataKey,
  type IdentityKeyPair,
  type WrappedDataKey,
} from '../../../crypto/src/index.ts';
import { BrokerHttpTransport } from '../../../transport/src/index.ts';
import { openTransportEnvelope, sealTransportEnvelope } from '../../../transport-wire/src/index.ts';
import { pairingAcceptanceProofBytes } from '../../src/transport/transport-pairing.ts';

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

function strongPeerToken(seed: string): string {
  return createHash('sha256').update(seed).digest('base64url');
}

async function pairDevice(baseUrl: string, ownerToken: string, peerId: string, seed: string): Promise<any> {
  const created = await fetch(`${baseUrl}/api/transport/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cosyncing-token': ownerToken },
    body: JSON.stringify({ clientLabel: peerId }),
  });
  assert.equal(created.status, 201);
  const offer = await created.json() as any;
  const identity = generateIdentityKeyPair();
  const exchange = generateX25519KeyPair();
  const accepted = await fetch(`${baseUrl}/api/transport/pairings/${offer.pairingId}/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      peerId,
      peerToken: strongPeerToken(seed),
      identityPublicKey: identity.publicKey,
      exchangePublicKey: exchange.publicKey,
    }),
  });
  assert.equal(accepted.status, 200);
  return await accepted.json();
}

await test('broker carries authenticated opaque encrypted transport envelopes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-transport-opaque-'));
  const port = await freePort();
  const token = `transport-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_TOKEN: token,
      COSYNCING_TOKEN_FILE: '',
      COSYNCING_PI_INTEGRATION_FILE: '',
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_HOME: home,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  try {
    await waitHealth(baseUrl);

    const paired = await pairDevice(baseUrl, token, 'phone', 'opaque-phone');
    const brokerPeerId = String(paired.broker.peerId);
    const brokerPeerToken = String(paired.broker.peerToken);

    const unauth = await fetch(`${baseUrl}/api/transport/envelopes?peer=${brokerPeerId}`);
    assert.equal(unauth.status, 401);
    const missingPeerToken = await fetch(`${baseUrl}/api/transport/envelopes?peer=${brokerPeerId}`, { headers: { 'x-cosyncing-token': token } });
    assert.equal(missingPeerToken.status, 403);

    const key = generateDataKey();
    const transport = new BrokerHttpTransport({
      baseUrl,
      peerId: brokerPeerId,
      peerToken: brokerPeerToken,
      pollMs: 1,
      headers: { 'x-cosyncing-token': token },
    });
    const plaintext = new TextEncoder().encode(JSON.stringify({ kind: 'ping', value: 42 }));
    const sealed = sealTransportEnvelope({
      key,
      id: 'broker-env-1',
      from: 'phone',
      to: brokerPeerId,
      channel: 'session-control',
      bytes: plaintext,
      headers: { 'x-cosyncing-to-token': brokerPeerToken },
    });

    await transport.send(sealed);
    const ac = new AbortController();
    const received: any[] = [];
    for await (const envelope of transport.receive(ac.signal)) {
      received.push(envelope);
      ac.abort();
      break;
    }

    assert.equal(received.length, 1);
    assert.equal(received[0].id, 'broker-env-1');
    assert.deepEqual([...openTransportEnvelope(key, received[0]).bytes], [...plaintext]);

    const drained = await fetch(`${baseUrl}/api/transport/envelopes?peer=${brokerPeerId}`, {
      headers: { 'x-cosyncing-token': token, 'x-cosyncing-peer-token': brokerPeerToken },
    });
    assert.deepEqual((await drained.json()).envelopes, []);
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
  }
});

await test('broker transport mailbox enforces cap, ttl, and early body limit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-transport-mailbox-'));
  const port = await freePort();
  const token = `transport-hardening-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_TOKEN: token,
      COSYNCING_TOKEN_FILE: '',
      COSYNCING_PI_INTEGRATION_FILE: '',
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_HOME: home,
      COSYNCING_TRANSPORT_MAX_BYTES: '16',
      COSYNCING_TRANSPORT_MAILBOX_MAX: '2',
      COSYNCING_TRANSPORT_TTL_MS: '25',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  try {
    await waitHealth(baseUrl);
    const paired = await pairDevice(baseUrl, token, 'mailbox-peer', 'mailbox-peer');
    const peerId = String(paired.peer.peerId);
    const peerToken = strongPeerToken('mailbox-peer');
    const tooLarge = await fetch(`${baseUrl}/api/transport/envelopes`, {
      method: 'POST',
      headers: {
        'x-cosyncing-token': token,
        'content-type': 'application/octet-stream',
        'x-cosyncing-envelope-id': 'too-large',
        'x-cosyncing-channel': 'test',
        'x-cosyncing-to': peerId,
        'x-cosyncing-to-token': peerToken,
      },
      body: new Uint8Array(32),
    });
    assert.equal(tooLarge.status, 413);

    for (const id of ['env-1', 'env-2', 'env-3']) {
      const res = await fetch(`${baseUrl}/api/transport/envelopes`, {
        method: 'POST',
        headers: {
          'x-cosyncing-token': token,
          'content-type': 'application/octet-stream',
          'x-cosyncing-envelope-id': id,
          'x-cosyncing-channel': 'test',
          'x-cosyncing-to': peerId,
          'x-cosyncing-to-token': peerToken,
        },
        body: new TextEncoder().encode(id),
      });
      assert.equal(res.status, 202);
    }
    const capped = await fetch(`${baseUrl}/api/transport/envelopes?peer=${peerId}`, {
      headers: { 'x-cosyncing-token': token, 'x-cosyncing-peer-token': peerToken },
    });
    assert.deepEqual((await capped.json()).envelopes.map((x: any) => x.id), ['env-2', 'env-3']);

    const expiring = await fetch(`${baseUrl}/api/transport/envelopes`, {
      method: 'POST',
      headers: {
        'x-cosyncing-token': token,
        'content-type': 'application/octet-stream',
        'x-cosyncing-envelope-id': 'expires',
        'x-cosyncing-channel': 'test',
        'x-cosyncing-to': peerId,
        'x-cosyncing-to-token': peerToken,
      },
      body: new TextEncoder().encode('ok'),
    });
    assert.equal(expiring.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const expired = await fetch(`${baseUrl}/api/transport/envelopes?peer=${peerId}`, {
      headers: { 'x-cosyncing-token': token, 'x-cosyncing-peer-token': peerToken },
    });
    assert.deepEqual((await expired.json()).envelopes, []);
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
  }
});

await test('broker pairing accept route is tokenless one-time bootstrap', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-transport-pairing-'));
  const port = await freePort();
  const token = `pairing-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_TOKEN: token,
      COSYNCING_TOKEN_FILE: '',
      COSYNCING_PI_INTEGRATION_FILE: '',
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_HOME: home,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  try {
    await waitHealth(baseUrl);
    const contentType = { 'content-type': 'application/json' };
    const tokenAuth = { 'x-cosyncing-token': token, ...contentType };

    const created = await fetch(`${baseUrl}/api/transport/pairings`, {
      method: 'POST',
      headers: { 'x-cosyncing-token': token, ...contentType },
      body: JSON.stringify({ clientLabel: 'Test phone', brokerUrl: baseUrl }),
    });
    assert.equal(created.status, 201);
    const offer = await created.json() as any;
    const parsed = parseQrPairingPayload(offer.qr);
    assert.equal(parsed.version, 3);
    assert.deepEqual(parsed.transport, { kind: 'broker-url', url: baseUrl });
    assert.equal((parsed as any).pairingId, offer.pairingId);
    assert.equal(typeof offer.pairingId, 'string');
    assert.equal(typeof offer.qr, 'string');
    assert.equal(offer.qr.includes('privateKey'), false);
    assert.equal(offer.qr.includes('DataKey'), false);

    const statusWithoutToken = await fetch(`${baseUrl}/api/transport/pairings/${offer.pairingId}`);
    assert.equal(statusWithoutToken.status, 401);
    const pendingStatus = await fetch(`${baseUrl}/api/transport/pairings/${offer.pairingId}`, {
      headers: { 'x-cosyncing-token': token },
    });
    assert.equal(pendingStatus.status, 200);
    assert.equal((await pendingStatus.json() as any).state, 'pending');

    const phoneIdentity = generateIdentityKeyPair();
    const phoneExchange = generateX25519KeyPair();
    const peerToken = strongPeerToken('phone-token-1');
    const acceptedBody = JSON.stringify({
      peerId: 'phone-1',
      peerToken,
      identityPublicKey: phoneIdentity.publicKey,
      exchangePublicKey: phoneExchange.publicKey,
    });
    const accepted = await fetch(`${baseUrl}/api/transport/pairings/${offer.pairingId}/accept`, {
      method: 'POST',
      headers: contentType,
      body: acceptedBody,
    });
    assert.equal(accepted.status, 200);
    const paired = await accepted.json() as any;
    assert.equal(paired.peer.peerId, 'phone-1');
    assert.equal(typeof paired.broker.peerId, 'string');
    assert.equal(typeof paired.broker.peerToken, 'string');
    assert.equal(typeof paired.broker.identityPublicKey, 'string');
    assert.equal(typeof paired.wrappedDataKey?.ciphertext, 'string');
    const unwrapped = unwrapDataKey(paired.wrappedDataKey as WrappedDataKey, phoneExchange.privateKey);
    assert.equal(unwrapped.byteLength, 32);
    const acceptedStatus = await fetch(`${baseUrl}/api/transport/pairings/${offer.pairingId}`, {
      headers: { 'x-cosyncing-token': token },
    });
    const acceptedStatusBody = await acceptedStatus.json() as any;
    assert.equal(acceptedStatus.status, 200);
    assert.equal(acceptedStatusBody.state, 'accepted');
    assert.equal(acceptedStatusBody.peerId, 'phone-1');
    assert.equal('peerToken' in acceptedStatusBody, false);

    const attention = await fetch(`${baseUrl}/api/attention-events?after=0&clientId=review-device`, {
      headers: { 'x-cosyncing-token': token },
    });
    assert.equal(attention.status, 200);
    const pairedEvents = (await attention.json() as any).events.filter((event: any) => event.kind === 'device-paired');
    assert.equal(pairedEvents.length, 1, 'successful new pairing creates one durable security event');
    assert.equal(pairedEvents[0].state, 'resolved');
    assert.equal(pairedEvents[0].severity, 'informational',
      'successful pairing is an informational lifecycle notice, not an urgent security incident');
    assert.equal(JSON.stringify(pairedEvents[0]).includes(peerToken), false);
    assert.equal(JSON.stringify(pairedEvents[0]).includes(phoneIdentity.publicKey), false);

    const peers = await fetch(`${baseUrl}/api/transport/peers`, { headers: { 'x-cosyncing-token': token } });
    assert.equal(peers.status, 200);
    assert.deepEqual((await peers.json() as any).peers.map((p: any) => p.peerId), ['phone-1']);

    const replay = await fetch(`${baseUrl}/api/transport/pairings/${offer.pairingId}/accept`, {
      method: 'POST',
      headers: contentType,
      body: acceptedBody,
    });
    assert.equal(replay.status, 409);
    assert.match((await replay.json() as any).error, /review connected devices/);

    const wrong = await fetch(`${baseUrl}/api/transport/pairings/pair_not_real_12345678901/accept`, {
      method: 'POST',
      headers: contentType,
      body: JSON.stringify({
        peerId: 'phone-2',
        peerToken: strongPeerToken('phone-token-2'),
        identityPublicKey: phoneIdentity.publicKey,
        exchangePublicKey: phoneExchange.publicKey,
      }),
    });
    assert.equal(wrong.status, 404);
    for (let attempt = 1; attempt <= 11; attempt++) {
      const limited = await fetch(`${baseUrl}/api/transport/pairings/pair_not_found_rate_limit/accept`, {
        method: 'POST',
        headers: contentType,
        body: JSON.stringify({
          peerId: 'phone-limit',
          peerToken: strongPeerToken('phone-limit'),
          identityPublicKey: phoneIdentity.publicKey,
          exchangePublicKey: phoneExchange.publicKey,
        }),
      });
      if (attempt <= 10) {
        assert.equal(limited.status, 404);
        assert.equal((await limited.json()).code, 'PAIRING_NOT_FOUND');
      } else {
        assert.equal(limited.status, 429);
        assert.equal((await limited.json()).code, 'PAIRING_RATE_LIMITED');
      }
    }

    const createOfferWithoutToken = await fetch(`${baseUrl}/api/transport/pairings`, {
      method: 'POST',
      headers: contentType,
      body: JSON.stringify({ clientLabel: 'should fail' }),
    });
    assert.equal(createOfferWithoutToken.status, 401);

    const peersWithoutToken = await fetch(`${baseUrl}/api/transport/peers`, {
      method: 'GET',
    });
    assert.equal(peersWithoutToken.status, 401);

    const mailboxWithoutToken = await fetch(`${baseUrl}/api/transport/envelopes?peer=phone-1`, {
      method: 'GET',
    });
    assert.equal(mailboxWithoutToken.status, 401);

    const sessionControlWithoutToken = await fetch(`${baseUrl}/api/transport/session-control`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(),
    });
    assert.equal(sessionControlWithoutToken.status, 401);

    const peersWithBrokerPeerToken = await fetch(`${baseUrl}/api/transport/peers`, {
      headers: { 'x-cosyncing-peer-token': paired.broker.peerToken },
    });
    assert.equal(peersWithBrokerPeerToken.status, 403, 'peer credentials cannot administer devices');

    const peerMailboxRoute = await fetch(`${baseUrl}/api/transport/envelopes?peer=phone-1`, {
      method: 'GET',
      headers: { 'x-cosyncing-token': token, 'x-cosyncing-peer-token': peerToken },
    });
    assert.equal(peerMailboxRoute.status, 200, 'shared token plus receiver mailbox token should read mailbox');
    assert.deepEqual((await peerMailboxRoute.json()).envelopes, []);

    const streamNoToken = await fetch(`${baseUrl}/api/sessions/opencode/missing/stream`);
    assert.equal(streamNoToken.status, 401);

    const streamTicketResponse = await fetch(`${baseUrl}/api/ws-auth-tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cosyncing-peer-token': paired.broker.peerToken },
      body: JSON.stringify({ tool: 'opencode', sessionId: 'missing', params: {} }),
    });
    const streamTicket = await streamTicketResponse.json() as any;
    const streamWithPeerToken = await fetch(`${baseUrl}/api/sessions/opencode/missing/stream?wsAuthTicket=${encodeURIComponent(streamTicket.wsAuthTicket)}`);
    assert.equal(streamWithPeerToken.status, 426, 'broker-issued peer token should authenticate stream route');

    const acceptedMailboxPost = await fetch(`${baseUrl}/api/transport/envelopes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-cosyncing-envelope-id': 'peer-route-1',
        'x-cosyncing-channel': 'session-control',
        'x-cosyncing-to': paired.broker.peerId,
        'x-cosyncing-to-token': paired.broker.peerToken,
        'x-cosyncing-peer-token': paired.broker.peerToken,
      },
      body: new TextEncoder().encode('peer-auth'),
    });
    assert.equal(acceptedMailboxPost.status, 202, 'acceptedMailboxPost');

    const mailboxByPeer = await fetch(`${baseUrl}/api/transport/envelopes?peer=${paired.peer.peerId}`, {
      headers: { 'x-cosyncing-token': token, 'x-cosyncing-peer-token': peerToken },
    });
    assert.equal(mailboxByPeer.status, 200, 'broker-issued peer token plus receiver mailbox token should read queued peer mailbox');

    const sharedTokenStillWorks = await fetch(`${baseUrl}/api/transport/pairings`, {
      method: 'POST',
      headers: tokenAuth,
      body: JSON.stringify({ clientLabel: 'token still works' }),
    });
    assert.equal(sharedTokenStillWorks.status, 201);

    const tokenMailbox = await fetch(`${baseUrl}/api/transport/envelopes`, {
      method: 'POST',
      headers: {
        'x-cosyncing-token': token,
        'content-type': 'application/octet-stream',
        'x-cosyncing-envelope-id': 'cosyncing-token-envelopes',
        'x-cosyncing-channel': 'session-control',
        'x-cosyncing-to': paired.peer.peerId,
        'x-cosyncing-to-token': peerToken,
      },
      body: new TextEncoder().encode('shared-token'),
    });
    assert.equal(tokenMailbox.status, 202, 'tokenMailbox');

    const revoke = await fetch(`${baseUrl}/api/transport/peers/phone-1`, {
      method: 'DELETE',
      headers: { 'x-cosyncing-token': token },
    });
    assert.equal(revoke.status, 200);
    const attentionAfterRevoke = await fetch(
      `${baseUrl}/api/attention-events?clientId=security-audit`,
      { headers: { 'x-cosyncing-token': token } },
    );
    assert.equal(attentionAfterRevoke.status, 200);
    const securityEvents = (await attentionAfterRevoke.json() as any).events;
    assert.ok(securityEvents.some((event: any) =>
      event.kind === 'security-alert'
      && event.title === 'Repeated broker authentication failures'
      && event.severity === 'action-required'),
    'thresholded repeated authentication failures are high-priority security alerts');
    assert.ok(securityEvents.some((event: any) =>
      event.kind === 'security-alert'
      && event.title === 'Device access revoked'
      && event.severity === 'action-required'),
    'peer revocation is a high-priority security alert');
    const rejectedAfterRevoke = await fetch(`${baseUrl}/api/transport/envelopes?peer=${paired.peer.peerId}`, {
      headers: { 'x-cosyncing-peer-token': paired.broker.peerToken },
    });
    assert.equal(rejectedAfterRevoke.status, 401);

    const revokedStream = await fetch(`${baseUrl}/api/sessions/opencode/missing/stream`, {
      headers: { 'x-cosyncing-peer-token': paired.broker.peerToken },
    });
    assert.equal(revokedStream.status, 401);

    const tokenlessAccept = await fetch(`${baseUrl}/api/transport/pairings/${offer.pairingId}/accept`, {
      method: 'POST',
      headers: contentType,
      body: acceptedBody,
    });
    assert.equal(tokenlessAccept.status, 409);
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
  }
});

await test('broker pairing accept route rejects expired tokenless QR offers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-transport-pairing-expired-'));
  const port = await freePort();
  const token = `pairing-expired-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const broker = startBroker(port, token, {
    COSYNCING_HOME: home,
    COSYNCING_TRANSPORT_PAIRING_TTL_MS: '5',
  });
  try {
    await waitHealth(baseUrl);
    const auth = { 'x-cosyncing-token': token, 'content-type': 'application/json' };
    const created = await fetch(`${baseUrl}/api/transport/pairings`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ clientLabel: 'Expired phone' }),
    });
    assert.equal(created.status, 201);
    const offer = await created.json() as any;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const expiredStatus = await fetch(`${baseUrl}/api/transport/pairings/${offer.pairingId}`, {
      headers: { 'x-cosyncing-token': token },
    });
    assert.equal(expiredStatus.status, 200);
    assert.equal((await expiredStatus.json() as any).state, 'expired');
    const phoneIdentity = generateIdentityKeyPair();
    const phoneExchange = generateX25519KeyPair();
    const expiredAccept = await fetch(`${baseUrl}/api/transport/pairings/${offer.pairingId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'phone-expired',
        peerToken: 'phone-token-expired',
        identityPublicKey: phoneIdentity.publicKey,
        exchangePublicKey: phoneExchange.publicKey,
      }),
    });
    assert.equal(expiredAccept.status, 410);
    assert.equal((await expiredAccept.json() as any).code, 'PAIRING_EXPIRED');
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
  }
});

await test('public pairing acceptance rejects unsafe identities and bounds unknown offers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-pairing-adversarial-'));
  const port = await freePort();
  const token = `pairing-adversarial-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const broker = startBroker(port, token, { COSYNCING_HOME: home });
  try {
    await waitHealth(baseUrl);
    const auth = { 'x-cosyncing-token': token, 'content-type': 'application/json' };
    const created = await fetch(`${baseUrl}/api/transport/pairings`, {
      method: 'POST', headers: auth, body: JSON.stringify({ clientLabel: 'Adversarial phone' }),
    });
    const offer = await created.json() as any;
    const secondCreated = await fetch(`${baseUrl}/api/transport/pairings`, {
      method: 'POST', headers: auth, body: JSON.stringify({ clientLabel: 'Other endpoint' }),
    });
    const otherOffer = await secondCreated.json() as any;
    const identity = generateIdentityKeyPair();
    const exchange = generateX25519KeyPair();
    const baseInput = {
      peerId: 'client-adversarial',
      peerToken: strongPeerToken('adversarial'),
      identityPublicKey: identity.publicKey,
      exchangePublicKey: exchange.publicKey,
    };
    const cases: unknown[] = [
      { ...baseInput, peerId: 'client\nnewline' },
      { ...baseInput, peerId: 'client\u001b]52;c;payload\u0007' },
      { ...baseInput, peerId: offer.brokerPeerId },
      { ...baseInput, peerId: otherOffer.brokerPeerId },
      { ...baseInput, peerToken: 'x' },
      { ...baseInput, identityPublicKey: exchange.publicKey },
      { ...baseInput, exchangePublicKey: identity.publicKey },
      { ...baseInput, peerId: 42 },
      { ...baseInput, extra: true },
    ];
    for (const input of cases) {
      const response = await fetch(`${baseUrl}/api/transport/pairings/${offer.pairingId}/accept`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      });
      assert.equal(response.status, 400);
      const status = await fetch(`${baseUrl}/api/transport/pairings/${offer.pairingId}`, {
        headers: { 'x-cosyncing-token': token },
      });
      assert.equal((await status.json() as any).state, 'pending');
      const peers = await fetch(`${baseUrl}/api/transport/peers`, { headers: { 'x-cosyncing-token': token } });
      assert.deepEqual((await peers.json() as any).peers, []);
    }

    const oversized = await fetch(`${baseUrl}/api/transport/pairings/pair_not_real_12345678901/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseInput, padding: 'x'.repeat(17 * 1024) }),
    });
    assert.equal(oversized.status, 413);

    const accepted = await fetch(`${baseUrl}/api/transport/pairings/${offer.pairingId}/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseInput),
    });
    assert.equal(accepted.status, 200, 'invalid attempts must not consume the offer');
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
  }
});

await test('attention persistence failure does not turn a committed pairing into an HTTP failure', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-pairing-attention-failure-'));
  const port = await freePort();
  const token = `pairing-attention-failure-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const broker = startBroker(port, token, { COSYNCING_HOME: home });
  try {
    await waitHealth(baseUrl);
    const attentionPath = join(home, 'attention-events.json');
    rmSync(attentionPath, { recursive: true, force: true });
    mkdirSync(attentionPath);
    const paired = await pairPhone(baseUrl, token, {
      peerId: 'client-attention-failure',
      peerToken: 'attention-failure',
    });
    assert.equal(paired.accepted.peer.peerId, 'client-attention-failure');
    const peers = await fetch(`${baseUrl}/api/transport/peers`, { headers: { 'x-cosyncing-token': token } });
    assert.deepEqual((await peers.json() as any).peers.map((peer: any) => peer.peerId), ['client-attention-failure']);
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
  }
});

await test('broker pairing persistence, revoke cleanup, and re-pair isolation survive restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-transport-persist-'));
  const port = await freePort();
  const token = `pairing-persist-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  let broker = startBroker(port, token, { COSYNCING_HOME: home });
  try {
    await waitHealth(baseUrl);
    const first = await pairPhone(baseUrl, token, {
      peerId: 'phone-repair',
      peerToken: 'phone-token-old',
      label: 'Repair phone',
    });

    const oldQueued = await fetch(`${baseUrl}/api/transport/envelopes`, {
      method: 'POST',
      headers: {
        'x-cosyncing-token': token,
        'content-type': 'application/octet-stream',
        'x-cosyncing-envelope-id': 'old-queued-before-revoke',
        'x-cosyncing-channel': 'session-control',
        'x-cosyncing-from': first.material.peerId,
        'x-cosyncing-to': first.accepted.peer.peerId,
        'x-cosyncing-to-token': first.material.peerToken,
      },
      body: new TextEncoder().encode('old ciphertext'),
    });
    assert.equal(oldQueued.status, 202);

    broker.kill();
    await broker.exited.catch(() => undefined);
    broker = startBroker(port, token, { COSYNCING_HOME: home });
    await waitHealth(baseUrl);

    const peersAfterRestart = await fetch(`${baseUrl}/api/transport/peers`, { headers: { 'x-cosyncing-token': token } });
    assert.deepEqual((await peersAfterRestart.json() as any).peers.map((p: any) => p.peerId), ['phone-repair']);
    const persistedRaw = readFileSync(join(home, 'transport-peers.json'), 'utf8');
    assert(!persistedRaw.includes('phone-token-old'), 'peer mailbox token must be stored hashed, never plaintext');
    assert(!persistedRaw.includes(first.accepted.broker.peerToken), 'broker mailbox token must not be stored inside the peer list response payload');
    if (process.platform !== 'win32') {
      const peersMode = statSync(join(home, 'transport-peers.json')).mode & 0o777;
      assert.equal(peersMode, 0o600, 'transport-peers.json holds raw data keys and must be owner-only (0600)');
    }

    const revoke = await fetch(`${baseUrl}/api/transport/peers/phone-repair`, {
      method: 'DELETE',
      headers: { 'x-cosyncing-token': token },
    });
    assert.equal(revoke.status, 200);
    const rejectedOldToken = await fetch(`${baseUrl}/api/transport/envelopes?peer=phone-repair`, {
      headers: { 'x-cosyncing-token': token, 'x-cosyncing-peer-token': first.material.peerToken },
    });
    assert.equal(rejectedOldToken.status, 403);

    const second = await pairPhone(baseUrl, token, {
      peerId: 'phone-repair',
      peerToken: 'phone-token-new',
      label: 'Repair phone new token',
    });
    assert.equal(second.accepted.peer.peerId, 'phone-repair');
    const newMailbox = await fetch(`${baseUrl}/api/transport/envelopes?peer=phone-repair`, {
      headers: { 'x-cosyncing-token': token, 'x-cosyncing-peer-token': second.material.peerToken },
    });
    assert.deepEqual((await newMailbox.json() as any).envelopes, [], 'revocation must purge old queued envelopes before a peer id can be re-paired');
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
  }
});

await test('broker opens paired encrypted session-control envelopes with sender auth and replay rejection', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-transport-control-'));
  const port = await freePort();
  const token = `transport-control-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const broker = startBroker(port, token, { COSYNCING_HOME: home });
  try {
    await waitHealth(baseUrl);
    const paired = await pairPhone(baseUrl, token, {
      peerId: 'phone-control',
      peerToken: 'phone-control-token',
      label: 'Control phone',
    });

    const payload = {
      kind: 'approve',
      tool: 'opencode',
      sessionId: 'session-control-test',
      mode: 'live',
      requestId: 'perm-1',
      decision: 'approve',
    };
    const envelope = sealTransportEnvelope({
      key: paired.dataKey,
      id: 'control-env-1',
      from: paired.material.peerId,
      to: paired.accepted.broker.peerId,
      channel: 'session-control',
      bytes: new TextEncoder().encode(JSON.stringify(payload)),
      headers: { 'x-cosyncing-to-token': paired.accepted.broker.peerToken },
      senderIdentity: paired.material.identity,
    });
    const opened = await postSessionControl(baseUrl, token, envelope, paired.accepted.broker.peerToken);
    assert.equal(opened.status, 202);
    const body = await opened.json() as any;
    assert.equal(body.ok, true);
    assert.equal(body.control.kind, 'approve');
    assert.equal(body.control.tool, 'opencode');
    assert.equal(body.control.sessionId, 'session-control-test');
    assert.equal(body.control.routed, false);
    assert.match(body.control.reason, /no attached session/i);

    const replay = await postSessionControl(baseUrl, token, envelope, paired.accepted.broker.peerToken);
    assert.equal(replay.status, 409);
    assert.match(JSON.stringify(await replay.json()), /replay/i);

    const wrongIdentity = generateIdentityKeyPair();
    const forged = sealTransportEnvelope({
      key: paired.dataKey,
      id: 'control-env-forged',
      from: paired.material.peerId,
      to: paired.accepted.broker.peerId,
      channel: 'session-control',
      bytes: new TextEncoder().encode(JSON.stringify(payload)),
      headers: { 'x-cosyncing-to-token': paired.accepted.broker.peerToken },
      senderIdentity: wrongIdentity,
    });
    const forgedRes = await postSessionControl(baseUrl, token, forged, paired.accepted.broker.peerToken);
    assert.equal(forgedRes.status, 403);
    assert.match(JSON.stringify(await forgedRes.json()), /sender identity/i);
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
  }
});

await test('broker recovers from malformed persisted transport peer store', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-transport-malformed-'));
  writeFileSync(join(home, 'transport-peers.json'), '{ not json');
  const port = await freePort();
  const token = `pairing-malformed-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const broker = startBroker(port, token, { COSYNCING_HOME: home });
  try {
    await waitHealth(baseUrl);
    const peers = await fetch(`${baseUrl}/api/transport/peers`, { headers: { 'x-cosyncing-token': token } });
    assert.deepEqual((await peers.json() as any).peers, []);
    const paired = await pairPhone(baseUrl, token, { peerId: 'phone-after-malformed', peerToken: 'phone-token-fixed' });
    assert.equal(paired.accepted.peer.peerId, 'phone-after-malformed');
    assert(JSON.parse(readFileSync(join(home, 'transport-peers.json'), 'utf8')).peers.length === 1);
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
  }
});

await test('pairing accept failure limiter is memory-bounded under unique-id spam', async () => {
  // The accept route is unauthenticated, so its failure buckets are attacker-growable — direct
  // registry-level check that unique bogus pairingIds cannot grow the map without bound, and that
  // per-id limiting still trips after eviction pressure.
  const { TransportPairingRegistry, PairingHttpError } = await import('../../src/transport/transport-pairing.ts');
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-pairing-limiter-'));
  const fixedNow = 1_000_000;
  const registry = new TransportPairingRegistry({ home, now: () => fixedNow });
  const bogusInput = { peerId: 'p', peerToken: 't', identityPublicKey: 'i', exchangePublicKey: 'e' };

  for (let i = 0; i < 2500; i++) {
    assert.throws(() => registry.accept(`pair_${String(i).padStart(20, 'a')}`, bogusInput), PairingHttpError);
  }
  const buckets = (registry as any).pairingAcceptFailures as Map<string, unknown>;
  assert(buckets.size <= 1000, `failure buckets must stay bounded, got ${buckets.size}`);

  // Per-id limiting still works after eviction pressure: 10 failures → 11th is 429.
  for (let i = 0; i < 10; i++) {
    assert.throws(() => registry.accept('pair_repeat_offender_1234', bogusInput), PairingHttpError);
  }
  try {
    registry.accept('pair_repeat_offender_1234', bogusInput);
    assert.fail('11th failed attempt should be rate-limited');
  } catch (err) {
    assert.equal((err as InstanceType<typeof PairingHttpError>).code, 'PAIRING_RATE_LIMITED');
    assert.equal((err as InstanceType<typeof PairingHttpError>).status, 429);
  }
});

if (failed) {
  console.error(`\nFAIL: ${failed} broker transport test(s) failed.`);
  process.exit(1);
}

console.log('\nPASS broker transport tests');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('could not allocate port');
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return addr.port;
}

async function waitHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('broker did not become healthy');
}

function startBroker(port: number, token: string, env: Record<string, string> = {}): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_TOKEN: token,
      COSYNCING_TOKEN_FILE: '',
      COSYNCING_PI_INTEGRATION_FILE: '',
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
}

async function pairPhone(baseUrl: string, token: string, input: { peerId: string; peerToken: string; label?: string }): Promise<{
  material: { peerId: string; peerToken: string; identity: IdentityKeyPair; identityPublicKey: string; exchangePublicKey: string };
  accepted: any;
  dataKey: DataKey;
}> {
  const auth = { 'x-cosyncing-token': token, 'content-type': 'application/json' };
  const peerToken = strongPeerToken(input.peerToken);
  const created = await fetch(`${baseUrl}/api/transport/pairings`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ clientLabel: input.label ?? input.peerId }),
  });
  assert.equal(created.status, 201);
  const offer = await created.json() as any;
  const identity = generateIdentityKeyPair();
  const exchange = generateX25519KeyPair();
  const acceptedRes = await fetch(`${baseUrl}/api/transport/pairings/${offer.pairingId}/accept`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      peerId: input.peerId,
      peerToken,
      identityPublicKey: identity.publicKey,
      exchangePublicKey: exchange.publicKey,
    }),
  });
  assert.equal(acceptedRes.status, 200);
  const accepted = await acceptedRes.json() as any;
  const qr = parseQrPairingPayload(offer.qr);
  assert.equal(accepted.broker.peerId, qr.brokerId);
  assert.equal(accepted.broker.identityPublicKey, qr.publicKey);
  assert.equal(accepted.brokerProof?.algorithm, 'Ed25519');
  assert(verifySignature(
    qr.publicKey,
    pairingAcceptanceProofBytes({
      pairingId: offer.pairingId,
      client: {
        peerId: input.peerId,
        identityPublicKey: identity.publicKey,
        exchangePublicKey: exchange.publicKey,
      },
      broker: accepted.broker,
      wrappedDataKey: accepted.wrappedDataKey,
    }),
    accepted.brokerProof.signature,
  ));
  return {
    material: {
      peerId: input.peerId,
        peerToken,
      identity,
      identityPublicKey: identity.publicKey,
      exchangePublicKey: exchange.publicKey,
    },
    accepted,
    dataKey: { algorithm: 'AES-256-GCM', bytes: unwrapDataKey(accepted.wrappedDataKey as WrappedDataKey, exchange.privateKey) },
  };
}

async function postSessionControl(baseUrl: string, token: string, envelope: ReturnType<typeof sealTransportEnvelope>, toToken: string): Promise<Response> {
  return fetch(`${baseUrl}/api/transport/session-control`, {
    method: 'POST',
    headers: {
      'x-cosyncing-token': token,
      'content-type': 'application/octet-stream',
      'x-cosyncing-envelope-id': envelope.id,
      'x-cosyncing-channel': envelope.channel,
      ...(envelope.from ? { 'x-cosyncing-from': envelope.from } : {}),
      ...(envelope.to ? { 'x-cosyncing-to': envelope.to } : {}),
      'x-cosyncing-to-token': toToken,
      ...(envelope.headers ?? {}),
    },
    body: exactArrayBuffer(envelope.bytes),
  });
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}
