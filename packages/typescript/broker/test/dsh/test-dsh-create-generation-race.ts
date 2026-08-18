#!/usr/bin/env bun
/**
 * A downlink generation rotating underneath an in-flight session create must not
 * report the host as unavailable.
 *
 * THE DEFECT THIS PINS. `DshRpcClient.abortInFlight` used to fail EVERY in-flight
 * unary call when a generation ended, and the create path rides the same shared
 * client as the downlinks:
 *
 *   canCreateSession() -> isAvailable() -> host.describe
 *                      -> workspaces()  -> workspace.list
 *
 * Neither answer describes session state, but both died with the epoch. The
 * failure was then flattened twice — `isAvailable` turns any transport failure
 * into a bare `false`, and the broker's `prepareBackendSessionCreation` turns
 * that into `SessionCreateTemporarilyUnavailableError` through a
 * `.catch(() => false)` — so a self-healing race surfaced to the user as
 * "DeepSeek Harness is temporarily unavailable for session creation. Run
 * `cosyncing doctor` for setup guidance", advice that always passes because
 * nothing is wrong. Creating a second session while the first one's live attach
 * was still settling reproduced it; waiting a moment and retrying cleared it.
 *
 * WHY THE RACE IS FORCED RATHER THAN TIMED. The host parks a chosen method on a
 * gate this suite controls, so the generation rotates at the one instant that
 * matters — while that exact call is on the wire — instead of hoping a sleep
 * lands there. Nothing here waits on a wall clock.
 *
 * ONE MARKER PER CASE. The create path issues four calls in sequence, and a case
 * that holds several and rotates on the first proves only the first: the later
 * ones have not started yet. So each surviving call gets its own case — the
 * readiness `host.describe`, the readiness `workspace.list`, `requireVerifiedHost`'s
 * own `host.describe`, and the `session.create` write — and removing any single
 * marker turns exactly one of them red.
 *
 * THE SCOPE ASSERTION IS THE POINT. Proving a create survives is half the test;
 * the other half proves `session.list` still dies with its generation. A fix
 * that simply stopped aborting would pass the first half and silently reintroduce
 * mixed-epoch session reads, which is what the abort exists to prevent.
 *
 * ISOLATED FAKE HOST. A `Bun.serve` on an OS-leased loopback port plus injected
 * fake sockets. No `dsh` process, no port 3080, no installed broker, no
 * `~/.cosyncing`, no real network, no model call.
 *
 *   bun run packages/typescript/broker/test/dsh/test-dsh-create-generation-race.ts
 */
export {};
import { DshAdapter } from '../../../adapters/dsh/src/index.ts';
import type { DshSocketLike } from '../../../adapters/dsh/src/server.ts';

const FIXTURE = await Bun.file(
  new URL('../../../adapters/dsh/test/fixtures/dsh-0.1.0-rc.6.json', import.meta.url),
).json() as {
  hostDescribe: { body: { result: { value: unknown } } };
  sessionList: { body: { result: { value: unknown } } };
  workspaceList: { body: { result: { value: unknown } } };
};

const RECONNECT_DELAY_MS = 7;
const CREATED_SESSION_ID = 'session-0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

/**
 * Read from the capture rather than written here: passing a directory exercises
 * the branch that MATCHES a registered workspace, and a hardcoded path that the
 * fixture does not carry would silently fall through to the "no workspace is
 * registered" refusal and prove nothing about the race.
 */
const FIXTURE_WORKSPACE_PATH = (
  FIXTURE.workspaceList.body.result.value as { items: Array<{ path: string }> }
).items[0]!.path;

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── A host that can be made to answer slowly, per method ────────────────────
//
// `gate` is opened by the suite, not by a timer: a held method parks until
// `release()` runs, which is what makes "the generation rotated while this exact
// call was in flight" a fact rather than a hope.
let heldMethods = new Set<string>();
let releaseHeld: (() => void) | undefined;
let held: Promise<void> | undefined;
const onWire = new Map<string, number>();
let createCount = 0;

function hold(methods: string[]): void {
  heldMethods = new Set(methods);
  held = new Promise<void>((resolve) => { releaseHeld = resolve; });
}
function release(): void {
  releaseHeld?.();
  heldMethods = new Set();
}
/** Resolve once every held method has actually reached the host. */
async function awaitOnWire(methods: string[]): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (methods.every((method) => (onWire.get(method) ?? 0) > 0)) return;
    await Bun.sleep(1);
  }
  throw new Error(`these never reached the host: ${methods.join(', ')}`);
}

/** Resolve once one method has reached the host at least `count` times. */
async function awaitOnWireCount(method: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if ((onWire.get(method) ?? 0) >= count) return;
    await Bun.sleep(1);
  }
  throw new Error(`${method} reached the host ${onWire.get(method) ?? 0} times, wanted ${count}`);
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const body = await request.json().catch(() => ({})) as { rpcId?: string; method?: string };
    const rpcId = String(body.rpcId ?? '');
    const method = String(body.method ?? '');
    onWire.set(method, (onWire.get(method) ?? 0) + 1);
    if (heldMethods.has(method) && held) await held;
    const answer = (value: unknown) =>
      Response.json({ type: 'server-response', rpcId, result: { ok: true, value } });
    switch (method) {
      case 'host.describe': return answer(FIXTURE.hostDescribe.body.result.value);
      case 'session.list': return answer(FIXTURE.sessionList.body.result.value);
      case 'workspace.list': return answer(FIXTURE.workspaceList.body.result.value);
      case 'session.create': {
        createCount += 1;
        // A DISTINCT id per call. Two creates that both answered the same id
        // would let a suite "pass" while the second one never really happened.
        return answer({
          sessionId: createCount === 1 ? CREATED_SESSION_ID : `${CREATED_SESSION_ID}-${createCount}`,
          agentPreset: 'standard',
        });
      }
      default:
        return Response.json({
          type: 'server-response',
          rpcId,
          result: { ok: false, error: { code: 'unsupported', message: method } },
        });
    }
  },
});

// ── Injected downlinks ──────────────────────────────────────────────────────

class FakeSocket implements DshSocketLike {
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  closed = false;
  close(): void { this.closed = true; }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }
  fire(type: string, event?: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

let generationSockets: FakeSocket[] = [];
let pendingReconnect: (() => void) | undefined;

const adapter = new DshAdapter({
  env: {},
  baseUrl: server.url.origin,
  reconnectDelayMs: RECONNECT_DELAY_MS,
  socketFactory: () => {
    const socket = new FakeSocket();
    generationSockets.push(socket);
    return socket;
  },
  setTimeout: (handler, ms) => {
    if (ms === RECONNECT_DELAY_MS) {
      pendingReconnect = handler;
      return 'reconnect-handle';
    }
    return setTimeout(handler, ms);
  },
  clearTimeout: (handle) => {
    if (handle === 'reconnect-handle') pendingReconnect = undefined;
    else clearTimeout(handle as never);
  },
});

const link = adapter.hostLink();

/**
 * Open the next generation's sockets WITHOUT waiting for it to verify.
 *
 * The window this suite cares about is exactly the unverified one: sockets up,
 * `host.describe` still out, frames arriving and buffering. `openGeneration`
 * waits past that window by design, so the burst case needs its own opener.
 */
async function openGenerationSocketsUnverified(): Promise<void> {
  generationSockets = [];
  if (pendingReconnect) {
    const reconnect = pendingReconnect;
    pendingReconnect = undefined;
    reconnect();
  } else {
    link.start();
  }
  for (let attempt = 0; attempt < 2_000 && generationSockets.length < 2; attempt += 1) await Bun.sleep(1);
  if (generationSockets.length !== 2) throw new Error(`expected two downlink sockets, saw ${generationSockets.length}`);
  for (const socket of generationSockets) socket.fire('open');
}

/** Push one raw frame down the mux socket, exactly as the real socket delivers it. */
function pushMux(frameType: string, payload: Record<string, unknown>, rpcId: string): void {
  const socket = generationSockets[0];
  if (!socket) throw new Error('no mux socket in this generation');
  socket.fire('message', {
    data: JSON.stringify({ type: 'server-request', rpcId, method: frameType, payload: { type: frameType, ...payload } }),
  });
}

/**
 * Bring the next generation up. After a rotation the link is already started
 * and waiting on its injected reconnect timer, so firing that timer — rather
 * than calling `start()`, which is a no-op once started — is what opens the
 * next pair of sockets, exactly as the real re-baseline does.
 */
async function openGeneration(): Promise<void> {
  generationSockets = [];
  if (pendingReconnect) {
    const reconnect = pendingReconnect;
    pendingReconnect = undefined;
    reconnect();
  } else {
    link.start();
  }
  for (let attempt = 0; attempt < 2_000 && generationSockets.length < 2; attempt += 1) await Bun.sleep(1);
  const sockets = generationSockets;
  if (sockets.length !== 2) throw new Error(`expected two downlink sockets, saw ${sockets.length}`);
  for (const socket of sockets) socket.fire('open');
  for (let attempt = 0; attempt < 2_000 && !link.isReady; attempt += 1) await Bun.sleep(1);
  if (!link.isReady) throw new Error('the host link never verified host.describe');
}

/** End the live generation the way a dropped socket does. */
function rotateGeneration(): void {
  const before = link.generation;
  generationSockets[0]?.fire('close');
  if (link.generation === before) throw new Error('the generation did not end');
}

await openGeneration();
const readyGeneration = link.generation;

// ── 1. The readiness probe survives a rotation ──────────────────────────────

// canCreateSession() calls host.describe and THEN workspace.list, so holding
// both and rotating on the first proves only the first marker: the second call
// would not have started yet. Each is held alone and rotated while it is
// individually on the wire, so removing either marker turns exactly one of
// these red.

onWire.clear();
hold(['host.describe']);
const creatableAcrossDescribe = adapter.canCreateSession();
await awaitOnWire(['host.describe']);
rotateGeneration();
release();
check(
  'a rotation while canCreateSession is on host.describe leaves the host creatable',
  await creatableAcrossDescribe === true,
  `generation ${readyGeneration} -> ${link.generation}`,
);

await openGeneration();
onWire.clear();
hold(['workspace.list']);
const creatableAcrossWorkspaces = adapter.canCreateSession();
await awaitOnWire(['workspace.list']);
rotateGeneration();
release();
check(
  'a rotation while canCreateSession is on workspace.list leaves the host creatable',
  await creatableAcrossWorkspaces === true,
  `generation now ${link.generation}`,
);

// ── 2. The create's own pre-write verification survives one ─────────────────
//
// createSession runs workspace.list, then requireVerifiedHost's host.describe,
// then the write. Rotating only once session.create is on the wire would leave
// that middle probe untested, so it gets its own case: the host holds
// host.describe, which at this point in the flow is requireVerifiedHost's.

await openGeneration();
onWire.clear();
createCount = 0;
hold(['host.describe']);
const creatingAcrossVerify = adapter.createSession({ directory: FIXTURE_WORKSPACE_PATH });
await awaitOnWire(['host.describe']);
rotateGeneration();
release();
const verifiedCreate = await creatingAcrossVerify.then((info) => info, (error: Error) => error);
check(
  'a rotation while the create is verifying the host does not refuse the write',
  !(verifiedCreate instanceof Error) && verifiedCreate.id === CREATED_SESSION_ID,
  verifiedCreate instanceof Error ? verifiedCreate.message : `id ${(verifiedCreate as { id: string }).id}`,
);

// ── 3. The write itself survives one ────────────────────────────────────────

await openGeneration();
onWire.clear();
createCount = 0;
hold(['session.create']);
const creating = adapter.createSession({ directory: FIXTURE_WORKSPACE_PATH });
await awaitOnWire(['session.create']);
rotateGeneration();
release();
const created = await creating.then((info) => info, (error: Error) => error);
check(
  'a session created while the generation rotates is returned, not failed',
  !(created instanceof Error) && created.id === CREATED_SESSION_ID,
  created instanceof Error ? created.message : `id ${(created as { id: string }).id}`,
);

// ── 4. …and an epoch-bound read still dies with its epoch ───────────────────
//
// The abort is scoped, not removed. `session.list` describes what the host held
// during a generation nothing has re-baselined, so it must still fail retryable
// rather than mix epochs.

await openGeneration();
onWire.clear();
hold(['session.list']);
const discovering = adapter.discoverSessions();
await awaitOnWire(['session.list']);
rotateGeneration();
release();
const discovered = await discovering;
check(
  'a session-scoped read is still aborted by the generation it belongs to',
  discovered.length === 0,
  `${discovered.length} sessions`,
);

// ── 5. The rotation is not silent ───────────────────────────────────────────
//
// The in-memory diagnostics buffer is surfaced nowhere, so the warning is the
// only correlation handle an operator gets when an unrelated call is taken down.

const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
try {
  await openGeneration();
  rotateGeneration();
} finally {
  console.warn = realWarn;
}
check(
  'a generation failure names itself and its reason',
  warnings.some((line) => line.includes('downlink generation') && line.includes('socket closed')),
  warnings[0] ?? '(nothing logged)',
);

// ── 6. The reported symptom, end to end ─────────────────────────────────────
//
// Everything above forces the rotation by closing a socket, which proves the
// mechanism but not the sequence the user actually hit: create a session,
// attach to it, create another one straight away, and watch the second fail.
//
// So this case reproduces that shape with a rotation cause that is not
// synthetic. The second create is issued while a fresh generation is still
// unverified, and the host bursts more frames at it than the pre-verification
// buffer may hold — the adapter's own `failGeneration('host verification did
// not keep up with the inbound frame volume')`, which is the likeliest real
// trigger when a newly attached session starts streaming. That failure aborts
// in-flight calls, and before the fix the second create was one of them.

await openGeneration();
onWire.clear();
createCount = 0;
const firstSession = await adapter.createSession({ directory: FIXTURE_WORKSPACE_PATH });

// The attach that follows a create: a new generation whose verification is
// still outstanding while its session starts talking.
hold(['host.describe']);
rotateGeneration();
await openGenerationSocketsUnverified();

const secondSession = adapter.createSession({ directory: FIXTURE_WORKSPACE_PATH });
// Two host.describe calls are now parked: this generation's verifier, and the
// second create's own pre-write verification.
await awaitOnWireCount('host.describe', 2);

// The burst that ends the generation. One past the cap, so the overflow is the
// documented condition rather than an arbitrary flood.
for (let frame = 0; frame <= 1_000; frame += 1) {
  pushMux('session/event', { sessionId: firstSession.id, seq: frame }, `burst-${frame}`);
}
release();

const second = await secondSession.then((info) => info, (error: Error) => error);
check(
  'a second create issued while the first attach is still settling still succeeds',
  !(second instanceof Error) && second.id !== firstSession.id,
  second instanceof Error
    ? second.message
    : `${firstSession.id} then ${(second as { id: string }).id}`,
);

adapter.hostLink().stop();
pendingReconnect = undefined;
server.stop(true);

const failed = results.filter((result) => !result.ok);
console.log(`\n${failed.length ? 'FAIL' : 'PASS'} ${results.length - failed.length}/${results.length} dsh create/generation race checks`);
if (failed.length) process.exit(1);
