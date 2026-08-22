import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { generateDataKey, generateIdentityKeyPair } from '../../../crypto/src/index.ts';
import { BrokerHttpTransport, MemoryRelay } from '../../../transport/src/index.ts';
import {
  createSecureTransportPair,
  parseCipherEnvelope,
  sealTransportEnvelope,
  securePeerFromPairing,
  SecureTransportClient,
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

await test('secure transport client pairs real identities, round-trips through broker, and rejects replay/tamper/wrong identity', async () => {
  const port = await freePort();
  const token = `secure-transport-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_TOKEN: token,
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  try {
    await waitHealth(baseUrl);
    const paired = createSecureTransportPair({
      localPeerId: 'phone',
      localPeerToken: 'phone-token',
      remotePeerId: 'broker',
      remotePeerToken: 'broker-token',
    });
    const phoneTransport = new BrokerHttpTransport({
      baseUrl,
      peerId: paired.local.peerId,
      peerToken: paired.local.peerToken,
      pollMs: 1,
      headers: { 'x-cosyncing-token': token },
    });
    const brokerTransport = new BrokerHttpTransport({
      baseUrl,
      peerId: paired.remote.peerId,
      peerToken: paired.remote.peerToken,
      pollMs: 1,
      headers: { 'x-cosyncing-token': token },
    });
    const phone = new SecureTransportClient(phoneTransport, paired.local);
    const brokerClient = new SecureTransportClient(brokerTransport, paired.remote);
    const plaintext = new TextEncoder().encode(JSON.stringify({ kind: 'approve', requestId: 'r1', secret: 'BROKER_MUST_NOT_SEE_THIS' }));

    await phone.send({
      id: 'secure-env-1',
      to: paired.remote.peerId,
      toPeerToken: paired.remote.peerToken,
      channel: 'session-control',
      bytes: plaintext,
    });

    const raw = await firstEnvelope(brokerTransport);
    assert.equal(raw.id, 'secure-env-1');
    assert.equal(raw.from, 'phone');
    assert.equal(raw.to, 'broker');
    assert.equal(raw.headers?.['x-cosyncing-wire-kind'], 'cipher-envelope');
    assert.equal(new TextDecoder().decode(raw.bytes).includes('BROKER_MUST_NOT_SEE_THIS'), false);

    const opened = brokerClient.open(raw);
    assert.equal(new TextDecoder().decode(opened.bytes), new TextDecoder().decode(plaintext));
    assert.throws(() => brokerClient.open(raw), /replay/i);

    const tampered = phone.seal({
      id: 'secure-env-tamper',
      to: paired.remote.peerId,
      channel: 'session-control',
      bytes: plaintext,
    });
    const tamperedCipher = parseCipherEnvelope(tampered.bytes);
    tamperedCipher.sealed.ciphertext = flipBase64UrlChar(tamperedCipher.sealed.ciphertext);
    assert.throws(() => brokerClient.open({ ...tampered, bytes: new TextEncoder().encode(JSON.stringify(tamperedCipher)) }), /signature|authenticate|auth|bad decrypt|Unsupported state/i);

    const attackerIdentity = generateIdentityKeyPair();
    const wrongIdentity = sealTransportEnvelope({
      key: paired.local.dataKey,
      id: 'secure-env-wrong-identity',
      from: 'phone',
      to: paired.remote.peerId,
      channel: 'session-control',
      bytes: plaintext,
      senderIdentity: attackerIdentity,
    });
    assert.throws(() => brokerClient.open(wrongIdentity), /sender identity is not trusted/i);
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
  }
});

await test('secure transport client rejects unsigned or stripped-signature ciphers', () => {
  const { phone, brokerClient, paired, plaintext } = secureHarness();
  const valid = phone.seal({
    id: 'secure-env-unsigned',
    to: paired.remote.peerId,
    channel: 'session-control',
    bytes: plaintext,
  });

  const withoutSignature = parseCipherEnvelope(valid.bytes);
  delete withoutSignature.senderSignature;
  assert.throws(
    () => brokerClient.open({ ...valid, bytes: encodeJson(withoutSignature) }),
    /missing sender identity/i,
  );

  const withoutIdentity = parseCipherEnvelope(valid.bytes);
  delete withoutIdentity.senderIdentityPublicKey;
  assert.throws(
    () => brokerClient.open({ ...valid, bytes: encodeJson(withoutIdentity) }),
    /missing sender identity/i,
  );
});

await test('secure transport client rejects outer metadata rebinding', () => {
  const { phone, brokerClient, paired, plaintext } = secureHarness();
  const valid = phone.seal({
    id: 'secure-env-rebind',
    to: paired.remote.peerId,
    channel: 'session-control',
    bytes: plaintext,
  });

  assert.throws(
    () => brokerClient.open({ ...valid, id: 'secure-env-rebound' }),
    /does not match transport metadata/i,
  );
  assert.throws(
    () => brokerClient.open({ ...valid, channel: 'other-channel' }),
    /does not match transport metadata/i,
  );
  assert.throws(
    () => brokerClient.open({ ...valid, to: 'other-peer' }),
    /does not match transport metadata/i,
  );
  assert.throws(
    () => brokerClient.open({ ...valid, from: 'attacker' }),
    /no trusted sender public key/i,
  );
});

await test('secure transport client blocks replay-cache evasion by outer relabel', () => {
  const { phone, brokerClient, paired, plaintext } = secureHarness();
  const valid = phone.seal({
    id: 'secure-env-cross-channel-replay',
    to: paired.remote.peerId,
    channel: 'session-control',
    bytes: plaintext,
  });

  assert.equal(new TextDecoder().decode(brokerClient.open(valid).bytes), new TextDecoder().decode(plaintext));
  assert.throws(
    () => brokerClient.open({ ...valid, channel: 'other-channel' }),
    /does not match transport metadata|replay/i,
  );
});

await test('secure transport client opens envelopes from independently paired identities', () => {
  const brokerIdentity = generateIdentityKeyPair();
  const phoneIdentity = generateIdentityKeyPair();
  const dataKey = generateDataKey();
  const relay = new MemoryRelay();
  const phone = new SecureTransportClient(relay.endpoint('phone'), securePeerFromPairing({
    peerId: 'phone',
    dataKey,
    identity: phoneIdentity,
    trustedPeerId: 'broker',
    trustedPeerIdentityPublicKey: brokerIdentity.publicKey,
  }));
  const brokerClient = new SecureTransportClient(relay.endpoint('broker'), securePeerFromPairing({
    peerId: 'broker',
    dataKey,
    identity: brokerIdentity,
    trustedPeerId: 'phone',
    trustedPeerIdentityPublicKey: phoneIdentity.publicKey,
  }));
  const envelope = phone.seal({
    id: 'real-paired-1',
    channel: 'session-control',
    to: 'broker',
    bytes: new TextEncoder().encode('paired ok'),
  });
  const opened = brokerClient.open(envelope);
  assert.equal(new TextDecoder().decode(opened.bytes), 'paired ok');
});

if (failed) {
  console.error(`\nFAIL: ${failed} secure transport client test(s) failed.`);
  process.exit(1);
}

console.log('\nPASS secure transport client tests');

async function firstEnvelope(transport: BrokerHttpTransport): Promise<Awaited<ReturnType<SecureTransportClient['seal']>>> {
  const ac = new AbortController();
  for await (const envelope of transport.receive(ac.signal)) {
    ac.abort();
    return envelope;
  }
  throw new Error('no envelope received');
}

function flipBase64UrlChar(value: string): string {
  if (!value) throw new Error('empty ciphertext');
  const replacement = value[0] === 'A' ? 'B' : 'A';
  return replacement + value.slice(1);
}

function secureHarness(): {
  paired: ReturnType<typeof createSecureTransportPair>;
  phone: SecureTransportClient;
  brokerClient: SecureTransportClient;
  plaintext: Uint8Array;
} {
  const paired = createSecureTransportPair({
    localPeerId: 'phone',
    localPeerToken: 'phone-token',
    remotePeerId: 'broker',
    remotePeerToken: 'broker-token',
  });
  const noopTransport = {
    kind: 'noop',
    async send() {
      /* not used by seal/open regression guards */
    },
    async *receive() {
      /* not used by seal/open regression guards */
    },
  };
  return {
    paired,
    phone: new SecureTransportClient(noopTransport, paired.local),
    brokerClient: new SecureTransportClient(noopTransport, paired.remote),
    plaintext: new TextEncoder().encode(JSON.stringify({ kind: 'approve', requestId: 'r1' })),
  };
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

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
