/**
 * End-to-end WebSocket proof for DR1 shared composer drafts (review findings 1–3).
 *
 * Spins a REAL broker and attaches TWO real client sockets to one session, because the
 * failures this locks down are races between clients that a single hand-rolled call
 * sequence cannot express:
 *
 *   1. a versioned write fans out to BOTH clients with the broker-assigned revision and
 *      the writer's updateId;
 *   2. a stale-base write is REJECTED and answered to the WRITER ONLY — the other client
 *      never sees a frame, so a reconnecting device can never silently overwrite a newer
 *      shared draft;
 *   3. an idempotent retry (same updateId) mutates nothing and is answered to the writer;
 *   4. a late joiner at contract revision ≥ 3 receives the CLEAR TOMBSTONE, so a device
 *      that was away when the draft was cleared adopts the clear instead of redisplaying
 *      a draft the session no longer has;
 *   5. a legacy late joiner (contract revision 2) is NOT sent an empty draft, which would
 *      just wipe a composer it cannot arbitrate;
 *   6. the shared draft survives a broker restart — the durable per-session shard, not
 *      the in-memory fan-out cache, is what a late joiner reads;
 *   7. a prompt whose shared-draft clear cannot be durably stored is still acknowledged
 *      (it reached the agent) but the acknowledgement says the draft was NOT cleared and
 *      names the revision the sender's retry must target. A silent success here is the
 *      expensive failure: the sender would delete the row that retries the clear, and a
 *      broker restart would replay the sent text as an unsent draft on every client.
 *
 * The prompt-clear OWNERSHIP arbitration (a send clears only the draft its sender
 * observed) stays in test-draft-durability.ts, which can drive the revision/token
 * combinations directly instead of racing them onto a socket.
 *
 * Run: bun run scripts/broker/tests/broker/test-draft-two-client-wire.ts
 */
export {};
import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BROKER_CONTRACT_REVISION } from '../../../../packages/typescript/adapter-api/src/index.ts';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const forcedFailureFixture = process.argv.includes('--initial-readiness-failure-fixture');
const stateHome = process.env.COSYNCING_DRAFT_WIRE_STATE_HOME
  ?? mkdtempSync(join(tmpdir(), 'ca-draftwire-home-'));
mkdirSync(stateHome, { recursive: true });
let port = 0;
let brokerBase = '';
let websocketBase = '';

function spawnBroker(brokerPort: number): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: isolatedBrokerFixtureEnvironment(stateHome, {
      overrides: {
        PORT: String(brokerPort),
        HOST: '127.0.0.1',
        COSYNCING_HOME: stateHome,
        COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
        // Keep the fixture on the explicit loopback/no-auth baseline even when
        // the developer shell is authenticated to another broker. The
        // allow-list already drops these; the blanks say so at the call site.
        COSYNCING_TOKEN: '',
        COSYNCING_TOKEN_FILE: '',
        COSYNCING_PI_INTEGRATION_TOKEN: '',
        COSYNCING_PI_INTEGRATION_TOKEN_FILE: '',
      },
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

let broker: ReturnType<typeof Bun.spawn> | undefined;
let brokerOutput: ReturnType<typeof captureProcessOutput> | undefined;
let activePortLease: Awaited<ReturnType<typeof reserveLoopbackFixturePort>> | undefined;
const currentBroker = (): ReturnType<typeof Bun.spawn> => {
  if (!broker) throw new Error('broker fixture is not running');
  return broker;
};

// Readiness is not one of this suite's assertions, so it gets no wall-clock
// budget: a broker booting beside other suites is slow, not broken. Every wait
// after this keeps its own bound, because those are the behaviour under test.
const waitHealth = async (phase: string): Promise<void> => {
  const started = Date.now();
  const child = currentBroker();
  try {
    await waitForBrokerHealth(
      child,
      `${brokerBase}${forcedFailureFixture ? '/api/intentionally-not-health' : '/api/health'}`,
      forcedFailureFixture ? { timeoutMs: 250 } : {},
    );
  } catch (error) {
    throw new Error(
      `${phase} failed after ${Date.now() - started}ms; `
        + `process exit=${child.exitCode ?? 'running'}\n`
        + `${(error as Error).message}\n`
        + `${brokerOutput?.read().trim().slice(-2000) ?? ''}`,
    );
  }
};

const startBroker = async (phase: string): Promise<void> => {
  const lease = await reserveLoopbackFixturePort();
  activePortLease = lease;
  port = lease.port;
  brokerBase = `http://127.0.0.1:${port}`;
  websocketBase = brokerBase.replace(/^http/, 'ws');
  // The lease proves the kernel selected an unused port. Release it immediately
  // before the broker claims it; spawning while the lease still owns the port
  // turns startup into an avoidable bind race.
  await lease.release();
  activePortLease = undefined;
  broker = spawnBroker(port);
  // Every broker generation owns fresh pipes. Draining only the first process
  // can block a restarted child and makes its failure quote stale output.
  brokerOutput = captureProcessOutput(broker);
  if (forcedFailureFixture) {
    console.log(`DRAFT_WIRE_FAILURE_START ${JSON.stringify({
      brokerPid: broker.pid,
      port,
      stateHome,
    })}`);
  }
  await waitHealth(phase);
};

const stopBrokerGeneration = async (phase: string): Promise<void> => {
  const child = broker;
  const output = brokerOutput;
  broker = undefined;
  brokerOutput = undefined;
  if (child) {
    if (child.exitCode === null) child.kill('SIGTERM');
    let exited = await Promise.race([
      child.exited.then(() => true),
      sleep(5_000).then(() => false),
    ]);
    if (!exited && child.exitCode === null) {
      child.kill('SIGKILL');
      exited = await Promise.race([
        child.exited.then(() => true),
        sleep(2_000).then(() => false),
      ]);
    }
    if (!exited) throw new Error(`${phase}: broker did not exit after SIGTERM/SIGKILL`);
  }
  if (output) {
    const drained = await Promise.race([
      output.done.then(() => true),
      sleep(2_000).then(() => false),
    ]);
    if (!drained) throw new Error(`${phase}: broker stdout/stderr did not reach EOF`);
  }
};

const cleanupFixture = async (phase: string): Promise<void> => {
  let failure: unknown;
  try {
    await stopBrokerGeneration(phase);
  } catch (error) {
    failure = error;
  }
  if (activePortLease) {
    try {
      await activePortLease.release();
    } catch (error) {
      failure ??= error;
    } finally {
      activePortLease = undefined;
    }
  }
  rmSync(stateHome, { recursive: true, force: true });
  if (failure) throw failure;
};

if (forcedFailureFixture) {
  let failedAsIntended = false;
  try {
    await startBroker('forced initial broker readiness');
  } catch (error) {
    failedAsIntended = String(error).includes('forced initial broker readiness failed');
    console.log(`DRAFT_WIRE_FAILURE_OBSERVED ${JSON.stringify({
      failedAsIntended,
      error: String(error).slice(0, 500),
    })}`);
  } finally {
    await cleanupFixture('forced initial readiness cleanup');
  }
  console.log(`DRAFT_WIRE_FAILURE_CLEANUP ${JSON.stringify({
    failedAsIntended,
    stateRemoved: !existsSync(stateHome),
  })}`);
  process.exit(failedAsIntended ? 0 : 1);
}

async function portIsReusable(candidate: number): Promise<boolean> {
  const server = createServer();
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(candidate, '127.0.0.1', () => {
      server.close((error) => resolve(!error));
    });
  });
}

async function verifyInitialReadinessCleanup(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ca-draftwire-initial-failure-'));
  const failedState = join(root, 'state');
  const child = Bun.spawn(
    ['bun', 'run', import.meta.path, '--initial-readiness-failure-fixture'],
    {
      cwd: process.cwd(),
      env: isolatedBrokerFixtureEnvironment(join(root, 'runner'), {
        overrides: { COSYNCING_DRAFT_WIRE_STATE_HOME: failedState },
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const captured = captureProcessOutput(child, { maxChars: 16_000 });
  let start: { brokerPid: number; port: number; stateHome: string } | undefined;
  let pipeEof = false;
  try {
    const exited = await Promise.race([
      child.exited.then((code) => ({ done: true, code })),
      sleep(10_000).then(() => ({ done: false, code: -1 })),
    ]);
    if (!exited.done && child.exitCode === null) child.kill('SIGKILL');
    pipeEof = await Promise.race([
      captured.done.then(() => true),
      sleep(2_000).then(() => false),
    ]);
    const output = captured.read();
    const match = output.match(/DRAFT_WIRE_FAILURE_START (\{[^\n]+\})/);
    if (match) start = JSON.parse(match[1]!) as typeof start;
    const cleanupReported = /DRAFT_WIRE_FAILURE_CLEANUP .*"stateRemoved":true/.test(output);
    check('initial readiness failure exits through local cleanup', exited.done && exited.code === 0);
    check('initial readiness failure drains both broker pipes to EOF', pipeEof);
    check(
      'initial readiness failure terminates its broker without the outer supervisor',
      !!start && (() => {
        try { process.kill(start.brokerPid, 0); return false; } catch { return true; }
      })(),
    );
    check(
      'initial readiness failure releases the OS-leased port',
      !!start && await portIsReusable(start.port),
    );
    check(
      'initial readiness failure removes its temporary state',
      !!start && cleanupReported && start.stateHome === failedState && !existsSync(failedState),
    );
  } finally {
    if (start) {
      try { process.kill(start.brokerPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
}

const post = (path: string, body: unknown) =>
  fetch(`${brokerBase}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

interface Client {
  frames: any[];
  drafts: () => any[];
  send: (msg: unknown) => void;
  close: () => void;
}

/** Attach one real client socket advertising `contractRevision`. */
async function attach(sessionId: string, contractRevision: number): Promise<Client> {
  const frames: any[] = [];
  const url =
    `${websocketBase}/api/sessions/pi/${encodeURIComponent(sessionId)}/stream` +
    `?contractRevision=${contractRevision}&minimumBrokerRevision=0`;
  const ws = new WebSocket(url);
  ws.onmessage = (e) => {
    try {
      frames.push(JSON.parse(String(e.data)));
    } catch {
      /* ignore non-JSON */
    }
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error('socket failed to open'));
  });
  return {
    frames,
    drafts: () => frames.filter((f) => f.kind === 'draft'),
    send: (msg: unknown) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}

/** The same stable shard name the store derives, so the test can target one session's file. */
const shardFile = (directory: string, tool: string, sessionId: string) =>
  join(directory, `${createHash('sha256').update(`${tool}\0${sessionId}`).digest('hex').slice(0, 32)}.json`);

/** Wait until `predicate` holds or the deadline passes (no fixed sleeps in assertions). */
async function until(predicate: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}

let a: Client | undefined;
let b: Client | undefined;
try {
  await verifyInitialReadinessCleanup();
  await startBroker('initial broker readiness');
  const sessionFile = `/tmp/cadraftwire-${Math.random().toString(36).slice(2, 8)}.jsonl`;
  const id = String(
    (await (await post('/pi/bridge/hello', { sessionFile, cwd: '/tmp', title: 'draft-wire-test' })).json()).id,
  );

  // Two real clients on ONE session, both speaking the versioned draft contract.
  a = await attach(id, BROKER_CONTRACT_REVISION);
  b = await attach(id, BROKER_CONTRACT_REVISION);
  await sleep(400); // let both attaches complete before the first write

  // 1. A versioned write fans out to BOTH clients with the broker's revision.
  a.frames.length = 0;
  b.frames.length = 0;
  a.send({ kind: 'draft', text: 'typed on device A', updateId: 'wire-a-1', baseRevision: 0 });
  const fannedOut = await until(() => a!.drafts().length >= 1 && b!.drafts().length >= 1);
  const aEcho = a.drafts().at(-1);
  const bBroadcast = b.drafts().at(-1);
  // Revisions come from the store-wide clock, which also spends one telling each attaching
  // client that the session had no draft yet. Only the ORDER is contractual.
  const firstRevision = Number(aEcho?.revision ?? 0);
  check('a versioned draft reaches both attached clients', fannedOut, `a=${a.drafts().length} b=${b.drafts().length}`);
  check(
    'the writer sees its own updateId echoed with the assigned revision',
    aEcho?.text === 'typed on device A' && aEcho?.updateId === 'wire-a-1' && firstRevision > 0,
    JSON.stringify(aEcho),
  );
  check(
    'the other client sees the same revision',
    bBroadcast?.text === 'typed on device A' && bBroadcast?.revision === firstRevision,
    JSON.stringify(bBroadcast),
  );

  // 2. B types over it from the current revision — a normal accepted edit.
  a.frames.length = 0;
  b.frames.length = 0;
  b.send({ kind: 'draft', text: 'device B typed later', updateId: 'wire-b-1', baseRevision: firstRevision });
  await until(() => a!.drafts().length >= 1 && b!.drafts().length >= 1);
  const secondRevision = Number(a.drafts().at(-1)?.revision ?? 0);
  check('a write from the current revision applies at the next one', secondRevision > firstRevision);

  // 3. A reconnecting device retries an OFFLINE edit based on the superseded revision 1.
  //    It must be rejected, and the rejection must reach the writer ONLY — broadcasting it
  //    would push A's stale text onto B's composer.
  a.frames.length = 0;
  b.frames.length = 0;
  a.send({ kind: 'draft', text: 'stale offline edit from A', updateId: 'wire-a-2', baseRevision: firstRevision });
  const answered = await until(() => a!.drafts().length >= 1);
  const rejection = a.drafts().at(-1);
  check('a stale-base write is answered to its writer', answered, JSON.stringify(rejection));
  check(
    'the rejection returns the CURRENT shared record, not the stale text',
    rejection?.text === 'device B typed later' && rejection?.revision === secondRevision,
    JSON.stringify(rejection),
  );
  await sleep(300); // give any (incorrect) broadcast time to arrive
  check('the other client is never told about a rejected write', b.drafts().length === 0, `b saw ${b.drafts().length}`);

  // 4. An idempotent retry of an accepted updateId mutates nothing.
  a.frames.length = 0;
  b.frames.length = 0;
  b.send({ kind: 'draft', text: 'device B typed later', updateId: 'wire-b-1', baseRevision: firstRevision });
  await until(() => b!.drafts().length >= 1);
  check('a duplicate updateId does not bump the revision', b.drafts().at(-1)?.revision === secondRevision);
  await sleep(300);
  check('a duplicate is not re-broadcast to other clients', a.drafts().length === 0, `a saw ${a.drafts().length}`);

  // 5. The draft is cleared (as an accepted prompt does), then a LATE JOINER attaches.
  a.send({ kind: 'draft', text: '', updateId: 'wire-b-clear', baseRevision: secondRevision });
  await until(() => b!.drafts().some((d) => d.text === '' && d.revision > secondRevision));
  const clearRevision = Number(b.drafts().at(-1)?.revision ?? 0);

  const versionedLateJoiner = await attach(id, BROKER_CONTRACT_REVISION);
  const gotTombstone = await until(() => versionedLateJoiner.drafts().length >= 1);
  const tombstone = versionedLateJoiner.drafts().at(-1);
  versionedLateJoiner.close();
  check(
    'a versioned late joiner is replayed the clear tombstone',
    gotTombstone && tombstone?.text === '' && tombstone?.revision === clearRevision,
    JSON.stringify(tombstone),
  );

  const legacyLateJoiner = await attach(id, 2);
  await sleep(600); // an attach completes well within this
  const legacyDrafts = legacyLateJoiner.drafts();
  legacyLateJoiner.close();
  check(
    'a legacy late joiner is not sent an empty draft to apply',
    legacyDrafts.length === 0,
    JSON.stringify(legacyDrafts),
  );

  // 6. Durability: a non-empty draft survives a real broker restart, read back by a
  //    late joiner from the per-session shard rather than the in-memory cache.
  a.send({ kind: 'draft', text: 'must survive a restart', updateId: 'wire-a-3', baseRevision: clearRevision });
  await until(() => b!.drafts().some((d) => d.text === 'must survive a restart'));
  check(
    'accepted drafts are persisted as one shard per session',
    readdirSync(join(stateHome, 'drafts')).filter((n) => n.endsWith('.json')).length >= 1,
  );

  a.close();
  b.close();
  a = undefined;
  b = undefined;
  await stopBrokerGeneration('pre-restart broker cleanup');
  await startBroker('restart broker readiness');
  await post('/pi/bridge/hello', { sessionFile, cwd: '/tmp', title: 'draft-wire-test' });

  const afterRestart = await attach(id, BROKER_CONTRACT_REVISION);
  const restored = await until(() => afterRestart.drafts().length >= 1, 5000);
  const restoredDraft = afterRestart.drafts().at(-1);
  afterRestart.close();
  check(
    'the shared draft survives a broker restart',
    restored && restoredDraft?.text === 'must survive a restart',
    JSON.stringify(restoredDraft),
  );
  check('the revision sequence continues across the restart', (restoredDraft?.revision ?? 0) > clearRevision, JSON.stringify(restoredDraft));

  // 7. A prompt whose shared-draft clear cannot be durably stored.
  const sender = await attach(id, BROKER_CONTRACT_REVISION);
  const replayed = await until(() => sender.drafts().length >= 1, 5000);
  const held = sender.drafts().at(-1);
  const heldRevision = Number(held?.revision ?? 0);
  check('the sender is replayed the shared draft its prompt will send', replayed && heldRevision > 0, JSON.stringify(held));

  // Occupy the shard path with a directory: the atomic owner-only write now fails on a
  // LIVE store, which is the shape of a full or failing disk.
  const shard = shardFile(join(stateHome, 'drafts'), 'pi', id);
  rmSync(shard, { force: true });
  mkdirSync(shard);
  sender.frames.length = 0;
  sender.send({
    kind: 'prompt',
    text: String(held?.text ?? ''),
    clientMessageId: 'cm-clear-unstorable',
    draftRevision: heldRevision,
  });
  const acked = await until(() => sender.frames.some((f) => f.kind === 'ack' && f.clientMessageId === 'cm-clear-unstorable'));
  const failAck = sender.frames.find((f) => f.kind === 'ack' && f.clientMessageId === 'cm-clear-unstorable');
  check('a prompt is still acknowledged when its draft clear cannot be stored', acked, JSON.stringify(failAck));
  check('the acknowledgement reports the clear as failed', failAck?.draftCleared === false, JSON.stringify(failAck));
  check(
    'the failed clear names the revision the retry must target',
    failAck?.draftRevision === heldRevision,
    JSON.stringify(failAck),
  );
  await sleep(300); // give any (incorrect) tombstone broadcast time to arrive
  check('an unstorable clear is never broadcast as a tombstone', !sender.drafts().some((d) => d.text === ''), JSON.stringify(sender.drafts()));

  // The crash this whole path exists for: the sender persisted its pending clear but died
  // before settling the outbox, so reconnecting REPLAYS the identical prompt frame. The
  // broker fingerprints every field but the client message id, so the replay must be
  // answered from the journal — with the failure and its retry target intact. A conflict
  // here would turn an already-executed prompt into a terminal failure.
  sender.frames.length = 0;
  sender.send({
    kind: 'prompt',
    text: String(held?.text ?? ''),
    clientMessageId: 'cm-clear-unstorable',
    draftRevision: heldRevision,
  });
  const replayAnswered = await until(() => sender.frames.some((f) => f.clientMessageId === 'cm-clear-unstorable'));
  const replayAck = sender.frames.find((f) => f.clientMessageId === 'cm-clear-unstorable');
  check('an identical replay is answered, not rejected as a reused id', replayAnswered && replayAck?.kind === 'ack', JSON.stringify(replayAck));
  check('the replay is served from the journal as a duplicate', replayAck?.duplicate === true, JSON.stringify(replayAck));
  check(
    'the replayed acknowledgement still reports the failed clear and its target',
    replayAck?.draftCleared === false && replayAck?.draftRevision === heldRevision,
    JSON.stringify(replayAck),
  );

  // Durability returns: a fresh draft applies, and the prompt that sends it clears it
  // for real — with an acknowledgement that stays silent about the draft.
  rmSync(shard, { recursive: true, force: true });
  sender.frames.length = 0;
  sender.send({ kind: 'draft', text: 'sent once the disk recovers', updateId: 'wire-recovered-1', baseRevision: heldRevision });
  await until(() => sender.drafts().some((d) => d.text === 'sent once the disk recovers'));
  const recovered = sender.drafts().at(-1);
  sender.frames.length = 0;
  sender.send({
    kind: 'prompt',
    text: 'sent once the disk recovers',
    clientMessageId: 'cm-clear-storable',
    draftRevision: Number(recovered?.revision ?? 0),
  });
  const clearedAcked = await until(() => sender.frames.some((f) => f.kind === 'ack' && f.clientMessageId === 'cm-clear-storable'));
  const okAck = sender.frames.find((f) => f.kind === 'ack' && f.clientMessageId === 'cm-clear-storable');
  const tombstoned = await until(() => sender.drafts().some((d) => d.text === ''));
  sender.close();
  check('a stored clear acknowledges without the failure field', clearedAcked && !('draftCleared' in (okAck ?? {})), JSON.stringify(okAck));
  check('a stored clear broadcasts the tombstone', tombstoned, JSON.stringify(sender.drafts().at(-1)));
} finally {
  a?.close();
  b?.close();
  await cleanupFixture('final broker cleanup');
}

console.log(`\n${fail ? `${fail} FAILED (${pass} passed)` : `draft two-client wire regression: all ${pass} checks passed.`}`);
process.exit(fail ? 1 : 0);
