/**
 * Transport + crypto broker adoption trace (deterministic, real broker, no agent/model).
 *
 * Proves the reusable client-side secure transport module can pair real identities, seal opaque
 * ciphertext, carry it through the broker mailbox, verify sender identity by default, reject replay,
 * reject ciphertext tamper, and reject a wrong sender identity. The broker sees only envelope metadata
 * plus opaque cipher-envelope bytes.
 *
 *   bun run scripts/broker/tests_traces/transport-crypto-broker-trace.ts
 */
export {};
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import {
  createQrPairingPayload,
  generateDataKey,
  generateIdentityKeyPair,
  loadOrCreateLocalKeyStore,
  parseQrPairingPayload,
  unwrapDataKey,
  wrapDataKeyForPeer,
} from '../../../packages/typescript/crypto/src/index.ts';
import { TailscaleDirectTransport, type TransportEnvelope } from '../../../packages/typescript/transport/src/index.ts';
import {
  parseCipherEnvelope,
  sealTransportEnvelope,
  securePeerFromPairing,
  SecureTransportClient,
} from '../../../packages/typescript/transport-wire/src/index.ts';

interface Assertion {
  name: string;
  ok: boolean;
  detail?: string;
}

const short = randomBytes(3).toString('hex');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'transport', 'secure-broker');
const tracePath = join(outDir, 'trace.json');
const brokerPath = join(outDir, 'broker.ndjson');
const pairingRoot = join(tmpdir(), `cosyncing-secure-trace-pairing-${short}`);
const assertions: Assertion[] = [];
mkdirSync(outDir, { recursive: true });

const port = await freePort();
const token = `secure-trace-${short}`;
const baseUrl = `http://127.0.0.1:${port}`;
let broker: ReturnType<typeof Bun.spawn> | undefined;

try {
  broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
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
  drainProcessOutput(broker, brokerPath);
  check('real broker starts for secure transport trace', await waitHealth(baseUrl), baseUrl);

  const brokerKeys = loadOrCreateLocalKeyStore(join(pairingRoot, 'broker'), 'broker');
  const phoneKeys = loadOrCreateLocalKeyStore(join(pairingRoot, 'phone'), 'phone');
  const brokerKeysReloaded = loadOrCreateLocalKeyStore(join(pairingRoot, 'broker'), 'broker');
  check('real pairing uses independently generated persisted identities', brokerKeys.identity.publicKey !== phoneKeys.identity.publicKey && brokerKeys.identity.publicKey === brokerKeysReloaded.identity.publicKey);

  const qr = createQrPairingPayload({
    brokerId: `broker-${short}`,
    publicKey: brokerKeys.exchange.publicKey,
    transport: { kind: 'tailscale-direct', url: baseUrl },
  });
  const parsedQr = parseQrPairingPayload(qr);
  check('QR pairing payload carries broker public exchange key only', parsedQr.publicKey === brokerKeys.exchange.publicKey && !qr.includes(brokerKeys.exchange.privateKey), qr.slice(0, 80));

  const brokerDataKey = generateDataKey();
  const wrappedForPhone = wrapDataKeyForPeer(brokerDataKey, phoneKeys.exchange.publicKey);
  const phoneDataKey = { algorithm: 'AES-256-GCM' as const, bytes: unwrapDataKey(wrappedForPhone, phoneKeys.exchange.privateKey) };
  check('phone unwraps broker DataKey through its independent exchange key', Buffer.from(phoneDataKey.bytes).equals(Buffer.from(brokerDataKey.bytes)));

  const phonePeerToken = `phone-token-${short}`;
  const brokerPeerToken = `broker-token-${short}`;
  const phonePeer = securePeerFromPairing({
    peerId: 'phone',
    peerToken: phonePeerToken,
    dataKey: phoneDataKey,
    identity: phoneKeys.identity,
    trustedPeerId: 'broker',
    trustedPeerIdentityPublicKey: brokerKeys.identity.publicKey,
  });
  const brokerPeer = securePeerFromPairing({
    peerId: 'broker',
    peerToken: brokerPeerToken,
    dataKey: brokerDataKey,
    identity: brokerKeys.identity,
    trustedPeerId: 'phone',
    trustedPeerIdentityPublicKey: phoneKeys.identity.publicKey,
  });
  check('paired peers trust only exchanged Ed25519 public identities', phonePeer.trustedSenders.broker === brokerKeys.identity.publicKey && brokerPeer.trustedSenders.phone === phoneKeys.identity.publicKey);

  const phoneTransport = new TailscaleDirectTransport({
    baseUrl,
    peerId: phonePeer.peerId,
    peerToken: phonePeer.peerToken,
    pollMs: 1,
    headers: { 'x-cosyncing-token': token },
  });
  const brokerTransport = new TailscaleDirectTransport({
    baseUrl,
    peerId: brokerPeer.peerId,
    peerToken: brokerPeer.peerToken,
    pollMs: 1,
    headers: { 'x-cosyncing-token': token },
  });
  const phone = new SecureTransportClient(phoneTransport, phonePeer);
  const brokerClient = new SecureTransportClient(brokerTransport, brokerPeer);
  const plaintext = new TextEncoder().encode(JSON.stringify({ kind: 'approve', requestId: `r-${short}`, secret: `secret-${short}` }));

  await phone.send({
    id: `secure-${short}`,
    to: brokerPeer.peerId,
    toPeerToken: brokerPeer.peerToken,
    channel: 'session-control',
    bytes: plaintext,
  });
  const raw = await firstEnvelope(brokerTransport);
  const brokerBytes = new TextDecoder().decode(raw.bytes);
  check('broker mailbox carries opaque cipher-envelope bytes only', raw.headers?.['x-cosyncing-wire-kind'] === 'cipher-envelope' && !brokerBytes.includes(`secret-${short}`), brokerBytes.slice(0, 120));

  const opened = brokerClient.open(raw);
  check('receiver opens broker-carried envelope with trusted sender verification', text(opened.bytes).includes(`r-${short}`), text(opened.bytes));
  checkThrows('receiver rejects replayed envelope id', () => brokerClient.open(raw), /replay/i);

  const tampered = phone.seal({ id: `tamper-${short}`, to: brokerPeer.peerId, channel: 'session-control', bytes: plaintext });
  const tamperedCipher = parseCipherEnvelope(tampered.bytes);
  tamperedCipher.sealed.ciphertext = flipBase64UrlChar(tamperedCipher.sealed.ciphertext);
  checkThrows(
    'receiver rejects flipped ciphertext byte before plaintext exposure',
    () => brokerClient.open({ ...tampered, bytes: new TextEncoder().encode(JSON.stringify(tamperedCipher)) }),
    /signature|authenticate|auth|bad decrypt|Unsupported state/i,
  );

  const attackerIdentity = generateIdentityKeyPair();
  const wrongIdentity = sealTransportEnvelope({
    key: phonePeer.dataKey,
    id: `wrong-identity-${short}`,
    from: 'phone',
    to: brokerPeer.peerId,
    channel: 'session-control',
    bytes: plaintext,
    senderIdentity: attackerIdentity,
  });
  checkThrows('receiver rejects wrong sender identity for claimed peer', () => brokerClient.open(wrongIdentity), /sender identity is not trusted/i);
} catch (err) {
  check('transport crypto broker trace completed without exception', false, String(err));
} finally {
  try {
    broker?.kill();
  } catch {
    /* ignore */
  }
  await broker?.exited.catch(() => undefined);
  rmSync(pairingRoot, { recursive: true, force: true });
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    mode: 'transport-crypto-broker',
    broker: baseUrl,
    output: { broker: brokerPath },
    assertions,
    status: failed ? 'fail' : 'pass',
  }, null, 2));
  console.log(`\ntrace: ${tracePath}`);
  console.log(`${assertions.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

function check(name: string, ok: boolean, detail = ''): void {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
}

function checkThrows(name: string, fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
    check(name, false, 'did not throw');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check(name, pattern.test(message), message);
  }
}

async function firstEnvelope(transport: TailscaleDirectTransport): Promise<TransportEnvelope> {
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

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function drainProcessOutput(proc: ReturnType<typeof Bun.spawn>, path: string): void {
  const writer = Bun.file(path).writer();
  const pump = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      writer.write(value);
    }
  };
  const stdout = proc.stdout instanceof ReadableStream ? proc.stdout : null;
  const stderr = proc.stderr instanceof ReadableStream ? proc.stderr : null;
  void Promise.all([pump(stdout), pump(stderr)]).finally(() => writer.end());
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

async function waitHealth(url: string): Promise<boolean> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch {
      /* broker not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}
