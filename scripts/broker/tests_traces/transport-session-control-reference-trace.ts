/**
 * Encrypted session-control reference trace (real broker, no agent/model).
 *
 * Proves approval/question/plan-action shaped control payloads can ride as opaque encrypted envelopes
 * through the broker pairing + mailbox path. This is a reference path for the native app; it does not
 * replace the current web session WebSocket yet.
 *
 *   bun run scripts/broker/tests_traces/transport-session-control-reference-trace.ts
 */
export {};
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import {
  generateDataKey,
  generateIdentityKeyPair,
  generateX25519KeyPair,
  unwrapDataKey,
  type WrappedDataKey,
} from '../../../packages/typescript/crypto/src/index.ts';
import { TailscaleDirectTransport, type TransportEnvelope } from '../../../packages/typescript/transport/src/index.ts';
import { SecureTransportClient, securePeerFromPairing } from '../../../packages/typescript/transport-wire/src/index.ts';

interface Assertion {
  name: string;
  ok: boolean;
  detail?: string;
}

const short = randomBytes(3).toString('hex');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'transport', 'session-control-reference');
const tracePath = join(outDir, 'trace.json');
const brokerPath = join(outDir, 'broker.ndjson');
const home = mkdtempSync(join(tmpdir(), 'cosyncing-transport-control-'));
const assertions: Assertion[] = [];
mkdirSync(outDir, { recursive: true });

const port = await freePort();
const token = `control-trace-${short}`;
const baseUrl = `http://127.0.0.1:${port}`;
let broker: ReturnType<typeof Bun.spawn> | undefined;

try {
  broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_TOKEN: token,
      COSYNCING_HOME: home,
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  drainProcessOutput(broker, brokerPath);
  check('real broker starts for encrypted session-control trace', await waitHealth(baseUrl), baseUrl);

  const offerRes = await fetch(`${baseUrl}/api/transport/pairings`, {
    method: 'POST',
    headers: { 'x-cosyncing-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ clientLabel: 'Trace phone' }),
  });
  const offer = await offerRes.json() as any;
  check('broker creates public pairing offer', offerRes.status === 201 && typeof offer.qr === 'string' && !offer.qr.includes('private'), `status=${offerRes.status}`);

  const phoneIdentity = generateIdentityKeyPair();
  const phoneExchange = generateX25519KeyPair();
  const phonePeerToken = `phone-token-${short}`;
  const acceptRes = await fetch(`${baseUrl}/api/transport/pairings/${encodeURIComponent(offer.pairingId)}/accept`, {
    method: 'POST',
    headers: { 'x-cosyncing-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({
      peerId: 'trace-phone',
      peerToken: phonePeerToken,
      identityPublicKey: phoneIdentity.publicKey,
      exchangePublicKey: phoneExchange.publicKey,
    }),
  });
  const accepted = await acceptRes.json() as any;
  check('broker accepts phone identity and returns wrapped DataKey plus broker peer', acceptRes.ok && accepted.peer?.peerId === 'trace-phone' && accepted.broker?.peerToken, `status=${acceptRes.status}`);

  const dataKey = {
    algorithm: 'AES-256-GCM' as const,
    bytes: unwrapDataKey(accepted.wrappedDataKey as WrappedDataKey, phoneExchange.privateKey),
  };
  check('phone unwraps broker-issued DataKey', dataKey.bytes.byteLength === generateDataKey().bytes.byteLength);

  const phoneTransport = new TailscaleDirectTransport({
    baseUrl,
    peerId: 'trace-phone',
    peerToken: phonePeerToken,
    pollMs: 1,
    headers: { 'x-cosyncing-token': token },
  });
  const brokerTransport = new TailscaleDirectTransport({
    baseUrl,
    peerId: accepted.broker.peerId,
    peerToken: accepted.broker.peerToken,
    pollMs: 1,
    headers: { 'x-cosyncing-token': token },
  });
  const phone = new SecureTransportClient(phoneTransport, securePeerFromPairing({
    peerId: 'trace-phone',
    peerToken: phonePeerToken,
    dataKey,
    identity: phoneIdentity,
    trustedPeerId: accepted.broker.peerId,
    trustedPeerIdentityPublicKey: accepted.broker.identityPublicKey,
  }));
  const brokerClient = new SecureTransportClient(brokerTransport, securePeerFromPairing({
    peerId: accepted.broker.peerId,
    peerToken: accepted.broker.peerToken,
    dataKey,
    identity: generateIdentityKeyPair(),
    trustedPeerId: 'trace-phone',
    trustedPeerIdentityPublicKey: phoneIdentity.publicKey,
  }));

  const controlPayloads = [
    { kind: 'approve', requestId: `perm-${short}`, decision: 'approve' },
    { kind: 'answer', requestId: `question-${short}`, answers: [{ id: 'q1', value: 'yes' }] },
    { kind: 'plan-action', requestId: `plan-${short}`, action: 'approve' },
  ];
  for (const [idx, payload] of controlPayloads.entries()) {
    await phone.send({
      id: `control-${short}-${idx}`,
      channel: 'session-control',
      to: accepted.broker.peerId,
      toPeerToken: accepted.broker.peerToken,
      bytes: new TextEncoder().encode(JSON.stringify(payload)),
    });
  }

  const raw = await collectEnvelopes(brokerTransport, 3);
  const rawText = raw.map((item) => new TextDecoder().decode(item.bytes)).join('\n');
  check('broker mailbox carries only cipher envelopes for control payloads', raw.length === 3 && !rawText.includes(`perm-${short}`) && !rawText.includes(`question-${short}`) && !rawText.includes(`plan-${short}`), rawText.slice(0, 160));

  const opened = raw.map((item) => JSON.parse(new TextDecoder().decode(brokerClient.open(item).bytes)));
  check('broker-side secure client opens approval control envelope', opened.some((item) => item.kind === 'approve' && item.requestId === `perm-${short}`));
  check('broker-side secure client opens question answer control envelope', opened.some((item) => item.kind === 'answer' && item.requestId === `question-${short}`));
  check('broker-side secure client opens plan-action control envelope', opened.some((item) => item.kind === 'plan-action' && item.requestId === `plan-${short}`));
  checkThrows('broker-side secure client rejects replayed control envelope', () => brokerClient.open(raw[0]!), /replay/i);

  const revoke = await fetch(`${baseUrl}/api/transport/peers/trace-phone`, {
    method: 'DELETE',
    headers: { 'x-cosyncing-token': token },
  });
  check('broker revokes paired phone peer', revoke.ok, `status=${revoke.status}`);
  const blocked = await fetch(`${baseUrl}/api/transport/envelopes`, {
    method: 'POST',
    headers: {
      'x-cosyncing-token': token,
      'content-type': 'application/octet-stream',
      'x-cosyncing-envelope-id': `blocked-${short}`,
      'x-cosyncing-channel': 'session-control',
      'x-cosyncing-from': accepted.broker.peerId,
      'x-cosyncing-to': 'trace-phone',
      'x-cosyncing-to-token': phonePeerToken,
    },
    body: new Uint8Array([1, 2, 3]),
  });
  check('revoked peer cannot receive later encrypted control envelopes', blocked.status === 403, `status=${blocked.status}`);
} catch (err) {
  check('encrypted session-control reference trace completed without exception', false, String(err));
} finally {
  try {
    broker?.kill();
  } catch {
    /* ignore */
  }
  await broker?.exited.catch(() => undefined);
  rmSync(home, { recursive: true, force: true });
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    mode: 'transport-session-control-reference',
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

async function collectEnvelopes(transport: TailscaleDirectTransport, count: number): Promise<TransportEnvelope[]> {
  const ac = new AbortController();
  const out: TransportEnvelope[] = [];
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    for await (const envelope of transport.receive(ac.signal)) {
      out.push(envelope);
      if (out.length >= count) {
        ac.abort();
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (out.length < count) throw new Error(`expected ${count} envelopes, got ${out.length}`);
  return out;
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
  const stderr = proc.stderr instanceof ReadableStream ? proc.stderr : null;
  void pump(stderr).finally(() => writer.end());
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
