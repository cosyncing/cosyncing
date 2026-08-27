#!/usr/bin/env bun
/**
 * Antigravity across TWO sockets on one broker: one Drive connection, one child,
 * one writer.
 *
 * Q14 of the adapter's checklist, proved rather than declared. The flag is
 * OPTIONAL and defaults to false, so an adapter that stays silent is never
 * offered the join by `Hub.sessionDetailFrame` — and the second client stays on
 * its own read-only observe connection, reading "observing" forever with nothing
 * it can do about it. That silence was the entirety of two shipped defects
 * (reflection §11 for kimi, §1 for claude), and neither produced a type error.
 * agy declares it, so this is what the declaration has to be worth:
 *
 *  - The second socket is OFFERED the join.
 *  - Joining hands it the EXISTING `AgyDriveConnection` — `Hub.joinExisting`
 *    never attaches — so there is no second child, no second stdin, and both
 *    sockets' prompts reach one writer in order. The pending-row FIFO and the
 *    queued-key map live on the CONNECTION, which is what makes a peer socket's
 *    prompt our own writer rather than a foreign one.
 *  - It sees the owner's accepted-but-undelivered prompts in its REPLAY. agy
 *    records nothing we could read until the child writes the transcript line —
 *    its own `history.jsonl` is workspace-scoped and cannot correlate — so until
 *    then the adapter's minted row is the ONLY record that the user said this.
 *    A joining socket that could not see it is a reload that deletes their words.
 *  - A DEMOTION reaches both sockets at once. A posture change recorded only on
 *    the connection that changed leaves every other client reading a stale one
 *    forever.
 *
 * Runs the REAL adapter and a real `Hub`, against a temp fixture store and a
 * scripted fake `agy` that speaks the measured stream-json wire. The real
 * binary is NEVER spawned: it costs a full workspace init, reaches the network,
 * and would spend model quota.
 *
 *   bun run packages/typescript/broker/test/broker/test-agy-cross-client-join.ts
 */
export {};
import { appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Hub, type WireEvent } from '../../src/sessions/hub.ts';
import { AgentRegistry } from '../../../adapter-api/src/index.ts';
import type { AttachMode, SessionConnection } from '../../../adapter-api/src/index.ts';
import { AgyAdapter } from '../../../adapters/antigravity/src/index.ts';
import { AgyDriveConnection } from '../../../adapters/antigravity/src/drive.ts';
import {
  buildAgyFixtureTree,
  writeFakeAgyBinary,
  FIXTURE,
} from '../../../adapters/antigravity/test/fixtures/tree.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const LIVE = FIXTURE.conversationIds.withTranscript;
const tree = buildAgyFixtureTree();
const fakeBinDir = join(tree.dir, 'bin');

/**
 * A child that accepts every turn and answers it, and never echoes the prompt to
 * the transcript.
 *
 * That is the state a reload has to survive: the prompt is accepted, the turn
 * completes, and the delivering `USER_INPUT` line has NOT been written — so the
 * adapter's minted row is the only place the user's words exist.
 */
const fake = writeFakeAgyBinary(fakeBinDir, {
  init: FIXTURE.streamEvents.init,
  defaultTurn: [FIXTURE.streamEvents.result],
});
const argvPath = join(fakeBinDir, 'agy-argv.json');

const adapter = new AgyAdapter({ roots: tree.roots, env: { PATH: fakeBinDir }, trace: () => {} });

// Counted around the REAL attach, because "the join performs no native attach"
// is the property that makes one writer stay one writer.
let attachCalls = 0;
const realAttach = adapter.attach.bind(adapter);
adapter.attach = ((id: string, mode?: AttachMode, options?: unknown): Promise<SessionConnection> => {
  attachCalls += 1;
  return realAttach(id, mode, options as never);
}) as typeof adapter.attach;

const registry = new AgentRegistry();
registry.register(adapter);
const hub = new Hub(registry, 15_000);

const users = (history: Array<Record<string, unknown>>) =>
  history
    .filter((message) => message?.type === 'user-message')
    .map((message) => ({ key: String(message.key ?? ''), text: String(message.text ?? ''), queued: message.queued }));

/**
 * The adapter-minted rows — the prompts agy has accepted and not yet written to
 * the transcript.
 *
 * Keyed by the `queued:agy:` namespace rather than by the `queued` FLAG, which
 * is a different fact: the flag marks a prompt typed while a turn was already
 * running, so whether it is set depends on where the child's `result` landed
 * relative to the send. What every one of these rows shares — queued behind a
 * turn or not — is that only this connection knows about it.
 */
const pendingRows = (history: Array<Record<string, unknown>>) =>
  users(history).filter((row) => row.key.startsWith('queued:agy:'));

/** When did a process last write the argv file? A new child rewrites it. */
function lastSpawnAt(): number | undefined {
  try {
    return statSync(argvPath).mtimeMs;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for a condition the tail will satisfy on its own clock, or give up. */
async function until(condition: () => boolean, budgetMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(25);
  }
  return condition();
}

try {
  check('0 the adapter advertises cross-client Drive sharing',
    adapter.capabilities.supportsCrossClientDriveSharing === true);

  // ── A. Owner first, with an accepted prompt the transcript has not recorded ─
  const owner = await hub.ensure('agy', LIVE, 'resume');
  const ownerFrames: Array<Extract<WireEvent, { kind: 'session' }>> = [];
  owner.addClient((event) => {
    if (event.kind === 'session') ownerFrames.push(event as Extract<WireEvent, { kind: 'session' }>);
  });
  const ownerFrame = hub.sessionDetailFrame(owner, true);
  check('A1 the resume attach is the session-level Drive owner',
    ownerFrame.authority?.canMutate === true && ownerFrame.info.control?.drive?.state === 'driving',
    JSON.stringify(ownerFrame.info.control?.drive));
  check('A2 ...and attaching it spawned nothing: the child starts on the first prompt',
    lastSpawnAt() === undefined, JSON.stringify(fake.argv()));

  // Priming the fold is what an ordinary attach does, and the drive's byte fence
  // is read from the transcript at send time, so history comes first.
  await owner.conn.getHistory();
  await owner.conn.sendPrompt({ text: 'steer me please' });
  await until(() => lastSpawnAt() !== undefined);
  const firstSpawnAt = lastSpawnAt();
  check('A3 the first prompt spawned exactly one child, with no `--print` in its argv',
    firstSpawnAt !== undefined && (fake.argv() ?? []).includes('--conversation')
      && !(fake.argv() ?? []).includes('--print'),
    JSON.stringify(fake.argv()));
  const ownerPending = pendingRows(await owner.conn.getHistory() as never);
  check('A4 the owner replays the accepted prompt as its own minted row',
    ownerPending.length === 1 && ownerPending[0]!.text === 'steer me please',
    JSON.stringify(ownerPending));

  // ── The second socket: a bare attach, which is where the reload lands ──────
  const observer = await hub.ensure('agy', LIVE);
  observer.addClient(() => {});
  check('A5 a bare attach gets a DIFFERENT connection, not the driver',
    observer !== owner && observer.conn !== owner.conn && attachCalls === 2, `attachCalls=${attachCalls}`);
  const observerHistory = users(await observer.conn.getHistory() as never);
  check('A6 ...whose history is the transcript alone: the undelivered prompt is NOT in it',
    !observerHistory.some((row) => row.text === 'steer me please') && observerHistory.length > 0,
    JSON.stringify(observerHistory.map((row) => row.key)));

  const observerFrame = hub.sessionDetailFrame(observer, true);
  check('A7 the bare socket stays explicitly read-only',
    observerFrame.authority?.canMutate === false && observerFrame.authority.prompt === 'none',
    JSON.stringify(observerFrame.authority));
  check('A8 ...and IS offered the join, which a silent capability would never have produced',
    observerFrame.joinExisting?.ownerRevision !== undefined, JSON.stringify(observerFrame.joinExisting));

  const joined = hub.joinExisting('agy', LIVE, observerFrame.joinExisting!.ownerRevision);
  check('A9 the join reuses the EXACT drive connection — one writer, one stdin',
    joined === owner && joined.conn === owner.conn && joined.conn instanceof AgyDriveConnection);
  check('A10 ...and performs no native attach, so no second child could exist',
    attachCalls === 2 && lastSpawnAt() === firstSpawnAt, `attachCalls=${attachCalls}`);

  const joinedPending = pendingRows(await joined.conn.getHistory() as never);
  check('A11 the joined socket replays the undelivered prompt — the row a reload used to lose',
    joinedPending.length === 1 && joinedPending[0]!.text === 'steer me please',
    JSON.stringify(joinedPending));
  const joinedFrame = hub.sessionDetailFrame(joined, true);
  check('A12 the joined socket has mutation authority and is offered no second join',
    joinedFrame.authority?.canMutate === true && joinedFrame.joinExisting === undefined,
    JSON.stringify(joinedFrame.authority));

  // The second socket's own client, on the SAME wrapper — this is what "both
  // sockets" means from here on.
  const joinedFrames: Array<Extract<WireEvent, { kind: 'session' }>> = [];
  joined.addClient((event) => {
    if (event.kind === 'session') joinedFrames.push(event as Extract<WireEvent, { kind: 'session' }>);
  });

  // ── B. A peer socket's prompt is OUR writer, not a foreign one ────────────
  //
  // The queued-key map and the pending FIFO are per CONNECTION, and both sockets
  // now share one. So the peer's prompt goes down the same stdin, in order, and
  // cannot read as a second writer.
  await joined.conn.sendPrompt({ text: 'and this one from the other tab' });
  check('B1 the peer socket\'s prompt spawned NO new child',
    lastSpawnAt() === firstSpawnAt, `${String(lastSpawnAt())} vs ${String(firstSpawnAt)}`);
  // The write crosses a pipe, so the child records it on its own clock.
  await until(() => fake.stdin().length === 2);
  const stdin = fake.stdin();
  const sent = stdin.map((line) => String((line.message as Record<string, unknown> | undefined)?.content ?? ''));
  check('B2 ...and both sockets\' prompts reached ONE stdin, in the order they were sent',
    sent.length === 2 && sent[0] === 'steer me please' && sent[1] === 'and this one from the other tab',
    JSON.stringify(sent));
  check('B3 ...each as the measured `{"event":"user"}` envelope, never claude\'s `type`',
    stdin.every((line) => line.event === 'user' && line.type === undefined), JSON.stringify(stdin));
  const bothPending = pendingRows(await joined.conn.getHistory() as never);
  check('B4 both accepted prompts are replayed, and the session is still driving',
    bothPending.length === 2 && owner.conn.info.control?.drive?.state === 'driving',
    JSON.stringify(bothPending));

  // ── C. A demotion reaches BOTH sockets at once ───────────────────────────
  //
  // A `USER_EXPLICIT` line on the tail that neither claimed one of our pending
  // keys nor matches a recent send means a terminal took the conversation. The
  // connection stops writing — single writer — but keeps the tail running and
  // KEEPS its pending rows: every accepted prompt was already written to the
  // child's stdin, so killing the child proves nothing about what it buffered.
  const ownerFramesBefore = ownerFrames.length;
  const joinedFramesBefore = joinedFrames.length;
  appendFileSync(tree.transcriptPath, JSON.stringify({
    step_index: 25,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: '2026-08-20T10:20:00Z',
    content: '<USER_REQUEST>\nsomebody else is typing in a terminal\n</USER_REQUEST>',
  }) + '\n');

  const demoted = (frames: Array<Extract<WireEvent, { kind: 'session' }>>, from: number) =>
    frames.slice(from).some((event) => event.info.control?.drive?.state === 'observing');
  const reached = await until(() =>
    demoted(ownerFrames, ownerFramesBefore) && demoted(joinedFrames, joinedFramesBefore));
  check('C1 the foreign write demotes the connection, and BOTH sockets are told in the same broadcast',
    reached,
    `owner=${demoted(ownerFrames, ownerFramesBefore)} joined=${demoted(joinedFrames, joinedFramesBefore)}`);
  check('C2 ...the demotion offers a takeover rather than pretending the session is unreachable',
    owner.conn.info.control?.drive?.takeoverAvailable === true
      && owner.conn.info.control?.drive?.supported === false,
    JSON.stringify(owner.conn.info.control?.drive));
  check('C3 ...both sockets lose mutation authority together, neither before the other',
    hub.sessionDetailFrame(owner, true).authority?.canMutate === false
      && hub.sessionDetailFrame(joined, true).authority?.canMutate === false);
  // The rows a demotion must NOT throw away. Only `close()` drops them.
  const afterDemotion = pendingRows(await joined.conn.getHistory() as never);
  check('C4 the demotion KEEPS both accepted prompts, so a reload still shows the user their words',
    afterDemotion.length === 2, JSON.stringify(afterDemotion));
  // Single writer: it stopped writing rather than racing the terminal.
  let refusedAfterDemotion = false;
  try {
    await joined.conn.sendPrompt({ text: 'this must not race the terminal' });
  } catch {
    refusedAfterDemotion = true;
  }
  check('C5 ...and a send from EITHER socket is refused afterwards — it stopped writing, it did not race',
    refusedAfterDemotion && fake.stdin().length === 2, `stdin lines=${fake.stdin().length}`);
} catch (error) {
  check('test harness completed', false, error instanceof Error ? error.message : String(error));
} finally {
  await hub.dispose().catch(() => {});
  tree.cleanup();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
