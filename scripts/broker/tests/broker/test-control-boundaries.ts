#!/usr/bin/env bun
/** Broker control, credential, Observe, and durable-state boundary acceptance. */
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BROKER_ERROR_CODES,
  type AgentMessage,
  type SessionConnection,
} from '../../../../packages/typescript/adapter-api/src/index.ts';
import {
  generateIdentityKeyPair,
  generateX25519KeyPair,
} from '../../../../packages/typescript/crypto/src/index.ts';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';
import { ManagedConn } from '../../../../packages/typescript/broker/src/hub.ts';
import {
  remoteFilesystemAllowed,
} from '../../../../packages/typescript/broker/src/client-control-boundary.ts';
import {
  ClientMessagePolicyError,
  validateRequestedPermissionMode,
} from '../../../../packages/typescript/broker/src/client-message-policy.ts';
import {
  defaultBrokerConfig,
  writeBrokerConfig,
} from '../../../../packages/typescript/broker/src/configuration.ts';
import { ensureInstallationCredentials } from '../../../../packages/typescript/broker/src/credentials.ts';
import {
  durableStateLayout,
  inspectDurableCorruptionEvidence,
} from '../../../../packages/typescript/broker/src/durable-state.ts';
import { AttentionStore } from '../../../../packages/typescript/broker/src/attention-store.ts';

const ROOT = join(import.meta.dir, '../../../..');
let checks = 0;

async function run(name: string, test: () => Promise<void> | void): Promise<void> {
  await test();
  checks++;
  console.log(`PASS  ${name}`);
}

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a port');
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

// Readiness is not one of this suite's assertions, so it gets no wall-clock
// budget: a broker booting beside other suites is slow, not broken.
const waitForHealth = (
  child: { exitCode: number | null; exited: Promise<number> },
  base: string,
): Promise<void> => waitForBrokerHealth(child, `${base}/api/health`);

async function waitForFrame(frames: any[], predicate: (frame: any) => boolean): Promise<any> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const found = frames.find(predicate);
    if (found) return found;
    await delay(25);
  }
  throw new Error('timed out waiting for WebSocket frame');
}

async function openSocket(url: string): Promise<{ socket: WebSocket; frames: any[] }> {
  const socket = new WebSocket(url);
  const frames: any[] = [];
  socket.onmessage = (event) => {
    try { frames.push(JSON.parse(String(event.data))); } catch { /* ignore malformed test traffic */ }
  };
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket open timed out')), 5_000);
    socket.onopen = () => { clearTimeout(timeout); resolve(); };
    socket.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket open failed')); };
  });
  await waitForFrame(frames, (frame) => frame.kind === 'history');
  return { socket, frames };
}

function snapshotTree(root: string): string[] {
  const walk = (directory: string, prefix = ''): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(directory).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        out.push(`${rel}/`);
        out.push(...walk(path, rel));
        continue;
      }
      out.push(`${rel}:${Buffer.from(readFileSync(path)).toString('base64')}`);
    }
    return out;
  };
  return walk(root);
}

await run('permissionMode accepts only exact adapter-advertised values', async () => {
  const connection = {
    async listModes() {
      return [{ value: 'approve-for-me', label: 'Approve for me' }];
    },
  };
  await validateRequestedPermissionMode(connection as SessionConnection, false, undefined);
  assert.equal(
    await validateRequestedPermissionMode(connection as SessionConnection, true, 'approve-for-me'),
    'approve-for-me',
  );
  for (const invalid of ['full-access', '', 'approve-for-me\n', 7]) {
    await assert.rejects(
      validateRequestedPermissionMode(connection as SessionConnection, true, invalid),
      (error: unknown) => error instanceof ClientMessagePolicyError
        && error.code === 'PERMISSION_MODE_UNSUPPORTED',
    );
  }
  await assert.rejects(
    validateRequestedPermissionMode({} as SessionConnection, true, 'approve-for-me'),
    (error: unknown) => error instanceof ClientMessagePolicyError
      && error.code === 'PERMISSION_MODE_UNSUPPORTED',
  );
  assert(BROKER_ERROR_CODES.includes('PERMISSION_MODE_UNSUPPORTED'));
});

await run('remote filesystem trust remains independent of successful authentication', () => {
  assert.equal(remoteFilesystemAllowed('127.0.0.1', false), true);
  assert.equal(remoteFilesystemAllowed('::1', false), true);
  assert.equal(remoteFilesystemAllowed('100.64.1.20', false), false,
    'a tailnet/full-access peer is still denied without the separate filesystem switch');
  assert.equal(remoteFilesystemAllowed('100.64.1.20', true), true);
});

await run('opening Observe leaves the workspace byte-for-byte unchanged', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'cosyncing-control-observe-'));
  try {
    writeFileSync(join(workspace, 'seed.txt'), 'preserve me');
    const before = snapshotTree(workspace);
    const connection: SessionConnection = {
      info: {
        id: 'observe-fixture',
        tool: 'fixture',
        title: 'Observe fixture',
        cwd: workspace,
        status: 'idle',
        attachMode: 'observe',
        control: {
          drive: { supported: true, state: 'observing' },
          terminalSync: { supported: false, syncAvailable: false, active: false },
        },
      },
      async getHistory() { return []; },
      subscribe() { return () => undefined; },
      async sendPrompt() { throw new Error('observe is read-only'); },
      async respondPermission() { throw new Error('observe is read-only'); },
      async close() { /* fixture */ },
    };
    const managed = new ManagedConn(connection);
    const frames: AgentMessage[] = [];
    const client = (event: any) => {
      if (event.kind === 'message') frames.push(event.message);
    };
    managed.addClient(client);
    await connection.getHistory();
    await delay(50);
    assert.deepEqual(snapshotTree(workspace), before);
    assert.equal(existsSync(join(workspace, '.cosyncing')), false);

    // A write-requiring producer may create outbox later; the already-open wrapper adopts it.
    const outbox = join(workspace, '.cosyncing', 'outbox');
    mkdirSync(outbox, { recursive: true });
    writeFileSync(join(outbox, 'result.txt'), 'explicit output');
    await delay(2_250);
    assert(frames.some((message) => message.type === 'file-artifact' && message.name === 'result.txt'));
    managed.removeClient(client);
    await managed.dispose();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

await run('recovered durable corruption stays visible through stable health evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-control-corrupt-'));
  try {
    const layout = durableStateLayout({ stateRoot: join(root, 'state'), cacheRoot: join(root, 'cache') });
    mkdirSync(layout.stateRoot, { recursive: true });
    writeFileSync(layout.attention, '{not json', { mode: 0o600 });
    const attention = new AttentionStore({ path: layout.attention, onWarning: () => undefined });
    assert.equal(attention.headCursor, 0);
    mkdirSync(join(layout.cacheRoot, 'artifacts'), { recursive: true });
    writeFileSync(`${layout.artifactIndex}.corrupt-fixture`, '{bad index', { mode: 0o600 });
    writeFileSync(`${layout.schedules}.corrupt-fixture`, '{bad schedules', { mode: 0o600 });

    const symlinkVictim = join(root, 'victim');
    writeFileSync(symlinkVictim, 'not store evidence');
    symlinkSync(symlinkVictim, `${layout.peers}.corrupt-fixture`);

    const evidence = inspectDurableCorruptionEvidence(layout);
    assert.deepEqual(
      evidence.map((item) => item.detailCode).sort(),
      ['artifacts-corruption-recovered', 'attention-corruption-recovered', 'schedules-corruption-recovered'],
    );
    assert(!JSON.stringify(evidence).includes(root), 'health evidence must not disclose local paths');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await run('authenticated resume, full-access peer, scoped Pi credential, and invalid mode boundaries hold', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-control-runtime-'));
  const home = join(root, 'state');
  const cache = join(root, 'cache');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;
  const config = defaultBrokerConfig();
  config.broker = {
    ...config.broker,
    port,
    machineLabel: 'control-boundary-fixture',
    internalUrl: base,
  };
  writeBrokerConfig(config, home);
  const credentials = ensureInstallationCredentials({ home, internalUrl: base });
  const child = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    cwd: ROOT,
    env: isolatedBrokerFixtureEnvironment(root, {
      overrides: {
        HOME: root,
        COSYNCING_HOME: home,
        COSYNCING_CACHE_DIR: cache,
        COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
        COSYNCING_PI_BRIDGE_AUTOINSTALL: '0',
        COSYNCING_CODEX_SYNC_SERVER: '0',
        COSYNCING_TOKDASH_URL: 'http://127.0.0.1:1',
      },
    }),
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const brokerOutput = captureProcessOutput(child);

  let sharedSocket: WebSocket | undefined;
  let peerSocket: WebSocket | undefined;
  try {
    try {
      await waitForHealth(child, base);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${brokerOutput.read().trim().slice(-2000)}`);
    }
    const sharedHeaders = { 'x-cosyncing-token': credentials.brokerToken };
    const integrationHeaders = { 'x-cosyncing-integration-token': credentials.piIntegration.credential };
    const hello = await fetch(`${base}/pi/bridge/hello`, {
      method: 'POST',
      headers: { ...integrationHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionFile: join(root, 'pi-session.jsonl'),
        cwd: root,
        title: 'Control-boundary Pi fixture',
        history: [],
      }),
    });
    assert.equal(hello.status, 200);
    const sessionId = String((await hello.json() as any).id);
    const streamPath = `/api/sessions/pi/${encodeURIComponent(sessionId)}/stream?mode=resume`;

    assert.equal((await fetch(`${base}${streamPath}`)).status, 401, 'unauthenticated direct resume must fail');
    assert.equal((await fetch(`${base}${streamPath}`, { headers: integrationHeaders })).status, 401,
      'the Pi route credential must not authorize a session stream');
    assert.equal((await fetch(`${base}/api/machines`, { headers: integrationHeaders })).status, 401);
    assert.equal((await fetch(`${base}/api/broker/restart`, {
      method: 'POST', headers: integrationHeaders,
    })).status, 401);

    const shared = await openSocket(`${wsBase}${streamPath}&token=${encodeURIComponent(credentials.brokerToken)}`);
    sharedSocket = shared.socket;
    const commandPollAbort = new AbortController();
    const commandPoll = fetch(
      `${base}/pi/bridge/commands?id=${encodeURIComponent(sessionId)}`,
      { headers: integrationHeaders, signal: commandPollAbort.signal },
    ).then(async (response) => (await response.json() as any).commands);
    let commandPollAbortError: unknown;
    try {
      shared.socket.send(JSON.stringify({
        kind: 'prompt',
        text: 'must not reach Pi',
        permissionMode: 'crafted-native-bypass',
        clientMessageId: 'invalid-mode-1',
      }));
      const nack = await waitForFrame(shared.frames,
        (frame) => frame.kind === 'nack' && frame.clientMessageId === 'invalid-mode-1');
      // The wired mutation boundary validates the exact adapter-advertised value and returns one stable code.
      assert.equal(nack.code, 'PERMISSION_MODE_UNSUPPORTED');
      const pollOutcome = await Promise.race([
        commandPoll.then((commands) => ({ state: 'resolved' as const, commands })),
        Bun.sleep(100).then(() => ({ state: 'pending' as const })),
      ]);
      assert.equal(
        pollOutcome.state,
        'pending',
        `rejected mode must not reach the adapter: ${JSON.stringify(pollOutcome)}`,
      );
    } finally {
      commandPollAbort.abort();
      try {
        await commandPoll;
      } catch (error) {
        commandPollAbortError = error;
      }
    }
    assert.equal(
      (commandPollAbortError as Error | undefined)?.name,
      'AbortError',
      'the negative command poll must be cancelled after the NACK',
    );

    const offerResponse = await fetch(`${base}/api/transport/pairings`, {
      method: 'POST',
      headers: { ...sharedHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ clientLabel: 'Control-boundary peer' }),
    });
    assert.equal(offerResponse.status, 201);
    const offer = await offerResponse.json() as any;
    const identity = generateIdentityKeyPair();
    const exchange = generateX25519KeyPair();
    const acceptedResponse = await fetch(`${base}/api/transport/pairings/${encodeURIComponent(offer.pairingId)}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: 'control-boundary-phone',
        peerToken: 'phone-mailbox-token',
        identityPublicKey: identity.publicKey,
        exchangePublicKey: exchange.publicKey,
      }),
    });
    assert.equal(acceptedResponse.status, 200);
    const accepted = await acceptedResponse.json() as any;
    const brokerPeerToken = String(accepted.broker.peerToken);
    assert.equal((await fetch(`${base}/api/machines?peerToken=${encodeURIComponent(brokerPeerToken)}`)).status, 200,
      'a v1 peer token intentionally has full broker access');
    const peer = await openSocket(`${wsBase}${streamPath}&peerToken=${encodeURIComponent(brokerPeerToken)}`);
    peerSocket = peer.socket;

    const healthResponse = await fetch(`${base}/api/broker/health`, { headers: sharedHeaders });
    const health = await healthResponse.json() as any;
    assert.equal(healthResponse.status, 200);
    assert(!JSON.stringify(health).includes(root));
  } finally {
    sharedSocket?.close();
    peerSocket?.close();
    child.kill('SIGTERM');
    await child.exited.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

await run('the shipped Take-over path requires client confirmation before mode=resume', () => {
  const app = readFileSync(join(ROOT, 'apps/poc-ui/public/app.js'), 'utf8');
  const start = app.indexOf('async function requestDrive');
  const end = app.indexOf('// The ONE control button', start);
  const requestDrive = app.slice(start, end);
  assert(start >= 0 && end > start);
  assert(requestDrive.indexOf('await confirmDialog') >= 0);
  assert(requestDrive.indexOf("attach(s, 'resume')") > requestDrive.indexOf('await confirmDialog'));
});

console.log(`\nPASS ${checks}/${checks} control-boundary groups`);
