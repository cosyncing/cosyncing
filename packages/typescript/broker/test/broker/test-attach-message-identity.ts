/**
 * CR4: a client joining at the persisted-final/live-snapshot overlap sees ONE logical message.
 *
 * Spins a REAL broker and drives the exact boundary the duplicate-message regression describes:
 * a turn's final has already reached saved history while the live text accumulator still holds it,
 * because the turn's idle has not arrived to clear the buffer. Attaching there delivers history AND
 * the captured live snapshot, so the same answer can be stated twice.
 *
 * The Pi bridge reproduces that boundary natively and without a model: its `final` event goes to
 * history only (the deltas already rendered it live), so history and the accumulator genuinely hold
 * the same keyed message at the same time. What the adapter is does not matter here — this locks
 * the BROKER's reconciliation, which must key off identity alone:
 *
 *   1. history already delivered that identity → the live restatement is not replayed, and the one
 *      surviving copy keeps `final` (Copy, read-aloud and turn telemetry all read it);
 *   2. a genuine mid-stream joiner (nothing in history yet) still receives the accumulated text;
 *   3. a live copy that carries MORE text than history is still delivered — reconciliation drops a
 *      redundant restatement, never newer content;
 *   4. and the complement boundary, where idle already emptied the accumulator, still delivers that
 *      answer exactly once and completed.
 *
 * Run: bun run packages/typescript/broker/test/broker/test-attach-message-identity.ts
 */
export {};
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const portLease = await reserveLoopbackFixturePort();
const PORT = Number(process.env.COSYNCING_TEST_PORT ?? portLease.port);
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stateHome = mkdtempSync(join(tmpdir(), 'ca-identity-home-'));

// Spreading the host environment handed the broker every credential and agent
// directory this machine happens to have, which is both a leak and a reason
// this suite could not share a host with another.
await portLease.release();
const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  env: isolatedBrokerFixtureEnvironment(stateHome, {
    overrides: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      COSYNCING_HOME: stateHome,
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    },
  }),
  stdout: 'pipe',
  stderr: 'pipe',
});
const brokerOutput = captureProcessOutput(broker);

// Readiness is not one of this suite's assertions, so it gets no wall-clock
// budget: a broker booting beside other suites is slow, not broken.
const waitHealth = async (): Promise<void> => {
  try {
    await waitForBrokerHealth(broker, `${BROKER}/api/health`);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${brokerOutput.read().trim().slice(-2000)}`);
  }
};

const post = (path: string, body: unknown) =>
  fetch(`${BROKER}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

interface Client {
  frames: any[];
  send: (msg: unknown) => void;
  close: () => void;
}

async function attach(sessionId: string, query = ''): Promise<Client> {
  const frames: any[] = [];
  const ws = new WebSocket(`${WSBASE}/api/sessions/pi/${encodeURIComponent(sessionId)}/stream?contractRevision=3&minimumBrokerRevision=0${query ? `&${query}` : ''}`);
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
  return { frames, send: (msg) => ws.send(JSON.stringify(msg)), close: () => ws.close() };
}

/** Every copy of one keyed message a client received, from history and catch-up alike. */
function copiesOf(client: Client, key: string): any[] {
  const out: any[] = [];
  for (const frame of client.frames) {
    if (frame.kind === 'history') for (const m of frame.messages ?? []) if (m?.key === key) out.push(m);
    if (frame.kind === 'history-page') for (const m of frame.messages ?? []) if (m?.key === key) out.push(m);
    if (frame.kind === 'message' && frame.message?.key === key) out.push(frame.message);
  }
  return out;
}

async function until(predicate: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}

/** One bridge session with a client already attached, so the hub is accumulating live text. */
async function openSession(label: string): Promise<{ id: string; driver: Client; sessionFile: string }> {
  const sessionFile = `/tmp/ca-identity-${label}-${Math.random().toString(36).slice(2, 8)}.jsonl`;
  const id = String((await (await post('/pi/bridge/hello', { sessionFile, cwd: '/tmp', title: label })).json()).id);
  const driver = await attach(id);
  await sleep(300);
  return { id, driver, sessionFile };
}

const opened: Client[] = [];
let joiner: Client | undefined;
try {
  await waitHealth();

  // 1. The overlap itself: the final has reached history, idle has NOT cleared the accumulator.
  {
    const { id, driver } = await openSession('overlap');
    opened.push(driver);
    const key = 'pi:answer:1';
    await post('/pi/bridge/events', {
      id,
      events: [
        { t: 'status', running: true },
        { t: 'delta', key, delta: 'The answer is 42.' },
        { t: 'final', key, text: 'The answer is 42.' },
      ],
    });
    await sleep(200);

    joiner = await attach(id);
    await until(() => copiesOf(joiner!, key).length > 0);
    await sleep(400); // let every catch-up frame land before counting

    const copies = copiesOf(joiner, key);
    check(
      'a client joining at the persisted-final overlap receives ONE copy of the answer',
      copies.length === 1,
      `copies=${copies.length}${copies.length ? ` texts=${JSON.stringify(copies.map((c) => c.text))}` : ''}`,
    );
    // The client keeps the LAST copy delivered for an identity, so an unreconciled restatement is
    // what the row ends up being — and the live accumulator's copy carries no `final`.
    const last = copies.at(-1);
    check(
      'the copy the client ends up with is still marked final (Copy/read-aloud/turn telemetry read it)',
      last?.final === true,
      `final=${String(last?.final)}`,
    );
    joiner.close();
    joiner = undefined;
  }

  // 2. A real mid-stream joiner must still be caught up on text history does not have yet.
  {
    const { id, driver } = await openSession('midstream');
    opened.push(driver);
    const key = 'pi:answer:2';
    await post('/pi/bridge/events', {
      id,
      events: [
        { t: 'status', running: true },
        { t: 'delta', key, delta: 'Still thinking' },
      ],
    });
    await sleep(200);

    joiner = await attach(id);
    const arrived = await until(() => copiesOf(joiner!, key).length > 0);
    const copies = copiesOf(joiner, key);
    check(
      'a mid-stream joiner still receives the in-flight text (nothing in history to reconcile against)',
      arrived && copies.length === 1 && copies[0].text === 'Still thinking',
      `copies=${copies.length} texts=${JSON.stringify(copies.map((c) => c.text))}`,
    );
    joiner.close();
    joiner = undefined;
  }

  // 3. Reconciliation drops a redundant restatement, never newer content.
  {
    const { id, driver } = await openSession('extended');
    opened.push(driver);
    const key = 'pi:answer:3';
    await post('/pi/bridge/events', {
      id,
      events: [
        { t: 'status', running: true },
        { t: 'delta', key, delta: 'Part one.' },
        { t: 'final', key, text: 'Part one.' },
        { t: 'delta', key, delta: ' Part two.' },
      ],
    });
    await sleep(200);

    joiner = await attach(id);
    await until(() => copiesOf(joiner!, key).some((c) => String(c.text ?? '').includes('Part two')));
    await sleep(400);

    const copies = copiesOf(joiner, key);
    check(
      'a live copy carrying MORE text than history is still delivered',
      copies.some((c) => c.text === 'Part one. Part two.'),
      `texts=${JSON.stringify(copies.map((c) => c.text))}`,
    );
    joiner.close();
    joiner = undefined;
  }

  // 4. Reconciliation may only suppress what this client was actually SENT. A small `initialHistory`
  //    caps older messages out of the history frame; an in-flight block that was capped away is not
  //    delivered by anything else, so treating it as delivered loses it from the transcript entirely.
  {
    const { id, driver } = await openSession('capped');
    opened.push(driver);
    const keys = ['pi:cap:1', 'pi:cap:2', 'pi:cap:3', 'pi:cap:4'];
    await post('/pi/bridge/events', {
      id,
      events: [
        { t: 'status', running: true },
        ...keys.flatMap((key, i) => [
          { t: 'delta', key, delta: `Block ${i + 1}.` },
          { t: 'final', key, text: `Block ${i + 1}.` },
        ]),
      ],
    });
    await sleep(200);

    joiner = await attach(id, 'initialHistory=1');
    await until(() => copiesOf(joiner!, keys[3]!).length > 0);
    await sleep(400);

    const historyFrame = joiner.frames.find((f) => f.kind === 'history');
    check(
      'the joining client really did receive a capped history frame (the boundary this exercises)',
      historyFrame?.truncated?.shown === 1 && historyFrame?.truncated?.total === keys.length,
      `truncated=${JSON.stringify(historyFrame?.truncated)} messages=${historyFrame?.messages?.length}`,
    );
    const capped = copiesOf(joiner, keys[0]!);
    check(
      'a live block capped OUT of the history frame still reaches the joining client',
      capped.length === 1 && capped[0].text === 'Block 1.',
      `copies=${capped.length} texts=${JSON.stringify(capped.map((c) => c.text))}`,
    );
    // Capping widens what must still be sent; it does not turn the reconciliation off for the
    // messages the frame did carry.
    const delivered = copiesOf(joiner, keys[3]!);
    check(
      'the block the capped history DID deliver is still not restated',
      delivered.length === 1 && delivered.at(-1)?.final === true,
      `copies=${delivered.length} final=${String(delivered.at(-1)?.final)}`,
    );

    // Older-page prepend. `handleHistoryPage` re-reads the adapter's history, so a page walks the
    // SAME messages a second time — under a producer that re-derives identity per read, a prepended
    // page would arrive keyed differently from the copy the client already holds and prepend a second
    // row of the same answer instead of filling in above it.
    const olderCursor = historyFrame?.olderCursor;
    check('the capped frame offered a backward cursor to page with', typeof olderCursor === 'string' && olderCursor.length > 0, `olderCursor=${String(olderCursor)}`);
    joiner.send({ kind: 'history-page', cursor: olderCursor, limit: 10, clientMessageId: 'page1' });
    const paged = await until(() => joiner!.frames.some((f) => f.kind === 'history-page'));
    const pageFrame = joiner.frames.find((f) => f.kind === 'history-page');
    const pagedKeys = (pageFrame?.messages ?? []).map((m: any) => m?.key);
    check(
      'an older-page prepend returns the earlier blocks under the identities they already had',
      paged && keys.slice(0, 3).every((k) => pagedKeys.includes(k)),
      `pageKeys=${JSON.stringify(pagedKeys)}`,
    );
    // The block that was capped out reached this client live; the page must fill in ABOVE it under
    // that same key, not introduce a second identity for it.
    const cappedAfterPage = copiesOf(joiner, keys[0]!);
    check(
      'the paged copy of a live-delivered block shares its identity (one row, not two)',
      cappedAfterPage.length === 2 && cappedAfterPage.every((c) => c.text === 'Block 1.'),
      `copies=${cappedAfterPage.length} texts=${JSON.stringify(cappedAfterPage.map((c) => c.text))}`,
    );
    joiner.close();
    joiner = undefined;
  }

  // 5. Reconnect with a cursor. The delta carries no messages — the client's cursor already covers
  //    them — but the client DOES hold that prefix, so the live snapshot behind it is a replay, not
  //    catch-up. Reconciling only against the (empty) delta restates a delivered final without its
  //    `final` marker, which is the reported symptom arriving one attach later.
  {
    const { id, driver } = await openSession('cursor');
    opened.push(driver);
    const key = 'pi:answer:5';
    await post('/pi/bridge/events', {
      id,
      events: [
        { t: 'status', running: true },
        { t: 'delta', key, delta: 'Persisted once.' },
        { t: 'final', key, text: 'Persisted once.' },
      ],
    });
    await sleep(200);

    const first = await attach(id);
    await until(() => copiesOf(first, key).length > 0);
    await sleep(400);
    const cursor = first.frames.find((f) => f.kind === 'history')?.cursor;
    check('the first attach handed out a history cursor to reconnect with', typeof cursor === 'string' && cursor.length > 0, `cursor=${String(cursor)}`);
    check(
      'that first attach saw the answer once, marked final',
      copiesOf(first, key).length === 1 && copiesOf(first, key).at(-1)?.final === true,
      `copies=${copiesOf(first, key).length}`,
    );
    first.close();
    await sleep(150);

    joiner = await attach(id, `since=${encodeURIComponent(String(cursor))}`);
    await sleep(600); // nothing new is expected — wait long enough that a restatement would have landed

    const frame = joiner.frames.find((f) => f.kind === 'history');
    check(
      'the reconnect really did take the incremental path (the boundary this exercises)',
      frame?.reset === false && (frame?.messages?.length ?? -1) === 0,
      `reset=${String(frame?.reset)} n=${frame?.messages?.length}`,
    );
    const copies = copiesOf(joiner, key);
    check(
      'a cursor reconnect does not restate the message that cursor already acknowledges',
      copies.length === 0,
      `copies=${copies.length} final=${JSON.stringify(copies.map((c) => c.final ?? null))}`,
    );
    joiner.close();
    joiner = undefined;
  }

  // 6. The other side of case 1's boundary. Idle HAS arrived, so the turn's parts were dropped from
  //    the live accumulator before this client attached: the answer now exists only in saved history.
  //    The contract lists "immediately after idle" as an attach case of its own because catch-up here
  //    has no live copy to reconcile against — the one copy has to come from history, complete, and a
  //    producer that re-derives identity per read would still be free to hand it a second key.
  {
    const { id, driver } = await openSession('after-idle');
    opened.push(driver);
    const key = 'pi:answer:6';
    await post('/pi/bridge/events', {
      id,
      events: [
        { t: 'status', running: true },
        { t: 'delta', key, delta: 'Settled.' },
        { t: 'final', key, text: 'Settled.' },
        { t: 'status', running: false }, // clears the hub's live text accumulator
      ],
    });
    await sleep(200);

    joiner = await attach(id);
    await until(() => copiesOf(joiner!, key).length > 0);
    await sleep(400); // a stray live restatement would have landed by now

    const copies = copiesOf(joiner, key);
    check(
      'a client joining after idle receives ONE copy of the answer, still marked final',
      copies.length === 1 && copies[0].text === 'Settled.' && copies[0].final === true,
      `copies=${copies.length} final=${JSON.stringify(copies.map((c) => c.final ?? null))}`,
    );
    const fromHistory = (joiner.frames.find((f) => f.kind === 'history')?.messages ?? []).filter((m: any) => m?.key === key);
    check(
      'that copy came from history, under the identity history stored it with',
      fromHistory.length === 1 && copies.length === 1,
      `history=${fromHistory.length} total=${copies.length}`,
    );
    joiner.close();
    joiner = undefined;
  }

} catch (e) {
  check('test harness completed', false, String(e));
} finally {
  joiner?.close();
  for (const c of opened) c.close();
  await sleep(150);
  // Awaiting the exit is the point: signalling and returning left the broker
  // and its children alive past this process, for the lane to reap.
  broker.kill();
  await broker.exited;
  try {
    rmSync(stateHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
