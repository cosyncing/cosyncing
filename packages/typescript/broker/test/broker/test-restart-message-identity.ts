/**
 * CR4: one logical agent message keeps ONE identity across a broker restart.
 *
 * The contract lists broker restart as an attach case of its own, and it is the case that separates a
 * durable identity from a lucky one. A key derived from anything process-local — a per-connection
 * counter, an attach-time cursor, the order a watcher happened to observe lines in — survives every
 * in-process test and then renames the message the moment the broker comes back. The client stored
 * the first key; a second key is a second row for the same answer.
 *
 * The Pi bridge cannot express this: it holds its transcript in memory and never writes its session
 * file, so a restart leaves nothing to replay and the test would be asserting an in-memory adapter's
 * durability instead of this lane's. Codex Observe can: its history IS a rollout file on disk, so the
 * same bytes outlive the broker process. This drives the REAL Codex adapter through a REAL broker
 * over a REAL WebSocket — no daemon, no CLI, no model cost — and asserts the identity rebuilt from
 * that file is the native `codex:<turnId>:<itemId>:t` one the app-server also delivers live, both
 * before and after the restart.
 *
 * A second turn is appended while the broker is DOWN, carrying byte-identical text to the first: the
 * restarted broker must key it by its own native id, so two identical answers stay two messages
 * across the restart the same way they do within one process.
 *
 * Run: bun run packages/typescript/broker/test/broker/test-restart-message-identity.ts
 */
export {};
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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

// An OS-reserved loopback port and isolated COSYNCING_HOME keep the fixture
// independent from the machine's broker and sibling suites.
const portLease = await reserveLoopbackFixturePort();
const PORT = Number(process.env.COSYNCING_TEST_PORT ?? portLease.port);
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stateHome = mkdtempSync(join(tmpdir(), 'ca-restart-home-'));
const codexHome = mkdtempSync(join(tmpdir(), 'ca-restart-codex-'));
const workDir = join(codexHome, 'work');
const procRoot = join(codexHome, 'proc'); // empty fake /proc: no terminal presence, no real scan
mkdirSync(workDir, { recursive: true });
mkdirSync(procRoot, { recursive: true });
writeFileSync(join(procRoot, 'uptime'), '5000.00 20000.00\n');

// Codex lays its rollouts out as $CODEX_HOME/sessions/<y>/<m>/<d>/rollout-<ts>-<uuid>.jsonl.
const THREAD = '019f57aa-0000-7000-8000-0000000c0de1';
const sessions = join(codexHome, 'sessions', '2026', '07', '25');
mkdirSync(sessions, { recursive: true });
const rollout = join(sessions, `rollout-2026-07-25T00-00-00-${THREAD}.jsonl`);
const sessionId = Buffer.from(rollout, 'utf8').toString('base64url');

// Byte-identical answers in both turns: identity is never text, and the restart must not be the
// thing that decides otherwise.
const ANSWER = 'The answer is 42.';
const TURN_ONE = 'turn-before-restart';
const MSG_ONE = 'msg_before_restart';
const TURN_TWO = 'turn-after-restart';
const MSG_TWO = 'msg_after_restart';

/** The pair Codex persists for one assistant item: the UI event, then the record carrying its id. */
const assistantTurn = (turnId: string, itemId: string, text: string) => [
  { timestamp: '2026-07-25T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
  { timestamp: '2026-07-25T00:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: text, phase: 'final_answer' } },
  {
    timestamp: '2026-07-25T00:00:02.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', id: itemId, phase: 'final_answer', content: [{ type: 'output_text', text }] },
  },
  { timestamp: '2026-07-25T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
];

const appendRollout = (lines: unknown[]): void => {
  const encoded = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  writeFileSync(rollout, encoded, { flag: 'a' });
};

appendRollout([
  { timestamp: '2026-07-25T00:00:00.000Z', type: 'session_meta', payload: { id: THREAD, cwd: workDir } },
  ...assistantTurn(TURN_ONE, MSG_ONE, ANSWER),
]);

// Built, not inherited. The allow-list carries no `COSYNCING_CODEX_SYNC_SERVER`,
// so Observe stays pure file-watching and never joins a daemon — which the
// previous `{ ...process.env }` plus a `delete` only achieved for whatever the
// operator's shell happened to hold.
const brokerEnv = isolatedBrokerFixtureEnvironment(stateHome, {
  overrides: {
    PORT: String(PORT),
    HOST: '127.0.0.1',
    COSYNCING_HOME: stateHome,
    CODEX_HOME: codexHome,
    COSYNCING_CODEX_PROC_ROOT: procRoot,
    COSYNCING_CODEX_APP_SERVER_SOCK: join(codexHome, 'no-daemon.sock'),
    COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
  },
});

let broker: ReturnType<typeof Bun.spawn> | undefined;
let brokerStderr = '';
function spawnBroker(): void {
  const child = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: brokerEnv,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  // Drain stderr as it arrives, keeping only the tail: an unread pipe fills at ~64 KB and would
  // block the broker mid-test, which would look like a broken identity instead of a stuck process.
  void (async () => {
    const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      brokerStderr = (brokerStderr + decoder.decode(value, { stream: true })).slice(-2000);
    }
  })().catch(() => undefined);
  broker = child;
}

/**
 * Wait for the broker to become ready.
 *
 * Readiness is not one of this suite's assertions — restart identity is — so
 * it gets no wall-clock budget of its own. A broker booting beside other
 * suites is slow, not broken, and the fixed 15s here was really a statement
 * about how fast the host is.
 */
const waitHealthy = () =>
  broker
    ? waitForBrokerHealth(broker, `${BROKER}/api/health`)
    : Promise.reject(new Error('no broker to wait for'));

/**
 * Wait for the port to stop answering.
 *
 * The opposite direction, and genuinely a bounded poll: nothing signals "the
 * socket is free now", and this is checked after the process has already been
 * reaped, so the wait is short by construction.
 */
async function waitGone(tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      if (!(await fetch(`${BROKER}/api/health`)).ok) return true;
    } catch {
      return true;
    }
    await sleep(250);
  }
  return false;
}

/** Kill the broker and wait for the port to be genuinely free, so the restart really rebinds it. */
async function stopBroker(): Promise<void> {
  broker?.kill();
  await broker?.exited.catch(() => undefined);
  await waitGone();
}

interface Client {
  frames: any[];
  close: () => void;
}

async function attach(): Promise<Client> {
  const frames: any[] = [];
  const ws = new WebSocket(
    `${WSBASE}/api/sessions/codex/${encodeURIComponent(sessionId)}/stream?contractRevision=3&minimumBrokerRevision=0`,
  );
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
  return { frames, close: () => ws.close() };
}

/** Every copy of the assistant answer this client received, from history and catch-up alike. */
function answers(client: Client): any[] {
  const out: any[] = [];
  for (const frame of client.frames) {
    if (frame.kind === 'history' || frame.kind === 'history-page') {
      for (const m of frame.messages ?? []) if (m?.type === 'model-output') out.push(m);
    }
    if (frame.kind === 'message' && frame.message?.type === 'model-output') out.push(frame.message);
  }
  return out;
}

async function until(predicate: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}

let client: Client | undefined;
try {
  await portLease.release();
  spawnBroker();
  try {
    await waitHealthy();
  } catch (error) {
    throw new Error(`${(error as Error).message}: ${brokerStderr.slice(-400)}`);
  }

  // ── Before the restart ──
  client = await attach();
  await until(() => answers(client!).length > 0);
  await sleep(300); // let every catch-up frame land before counting

  const before = answers(client);
  check(
    'the attached client sees the persisted answer exactly once',
    before.length === 1 && before[0].text === ANSWER && before[0].final === true,
    `copies=${before.length} keys=${JSON.stringify(before.map((m) => m.key))}`,
  );
  const identityBefore = before[0]?.key;
  // The identity has to be rebuilt from what the FILE says — the turn that was open and the paired
  // record's native id — because that is the only part of it the restart preserves. A key derived
  // from this connection's read (a line index, a counter) would look just as stable until now.
  check(
    'that identity is the durable native one, rebuilt from the rollout',
    identityBefore === `codex:${TURN_ONE}:${MSG_ONE}:t`,
    `key=${String(identityBefore)}`,
  );
  client.close();
  client = undefined;

  // ── The restart, with the agent still working while the broker is gone ──
  const firstPid = broker!.pid;
  await stopBroker();
  appendRollout(assistantTurn(TURN_TWO, MSG_TWO, ANSWER));
  spawnBroker();
  try {
    await waitHealthy();
  } catch (error) {
    throw new Error(`after restart: ${(error as Error).message}: ${brokerStderr.slice(-400)}`);
  }
  check(
    'the broker really was restarted on the same durable state',
    broker!.pid !== firstPid,
    `pid ${firstPid} → ${broker!.pid}`,
  );

  // ── After the restart ──
  client = await attach();
  await until(() => answers(client!).length >= 2);
  await sleep(300);

  const after = answers(client);
  const restored = after.filter((m) => m.key === identityBefore);
  check(
    'the same logical message keeps the identity it had before the restart, exactly once',
    restored.length === 1 && restored[0].text === ANSWER && restored[0].final === true,
    `copies=${restored.length} keys=${JSON.stringify(after.map((m) => m.key))}`,
  );
  // The turn that landed while the broker was down is a different message with the same bytes. If a
  // restart could renumber identities, this is where the transcript would fuse or split them.
  check(
    'a turn appended while the broker was down arrives under its own native identity',
    after.length === 2 && after[1]?.key === `codex:${TURN_TWO}:${MSG_TWO}:t` && after[1]?.text === ANSWER,
    `keys=${JSON.stringify(after.map((m) => m.key))}`,
  );
  check(
    'two byte-identical answers stay two messages across the restart',
    after.length === 2 && after[0]?.text === after[1]?.text && after[0]?.key !== after[1]?.key,
    `keys=${JSON.stringify(after.map((m) => m.key))} texts=${JSON.stringify(after.map((m) => m.text))}`,
  );
} catch (e) {
  check('test harness completed', false, String(e));
} finally {
  client?.close();
  await sleep(150);
  broker?.kill();
  await broker?.exited.catch(() => undefined);
  for (const dir of [stateHome, codexHome]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
