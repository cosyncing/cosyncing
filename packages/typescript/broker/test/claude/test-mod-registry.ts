/**
 * The mod registry: freshness, identity, replacement, and the queue that must not lie.
 *
 * Everything here is checked against an injected clock and an injected liveness probe. That is
 * not laziness about time: freshness is "three missed 20 s polls", and a suite that waited for
 * it would be a suite that CI turns off. What *is* real is the arithmetic and the state
 * machine, which is where the bugs live.
 *
 * The two rules with product consequences:
 * - A recycled pid reads **dead**. A dead session that still looks live keeps its Drive button,
 *   and the next prompt goes to whatever process inherited the number.
 * - A dead or stale row is **Observe**, not gone. The mirror keeps working and Take over still
 *   works, which is the fail-open shape the spec asks for.
 *
 *   bun run packages/typescript/broker/test/claude/test-mod-registry.ts   (exit 0 = all pass)
 */
export {};
import { ModRegistry, type ModRegistryOptions } from '../../src/sessions/mod-registry.ts';
import { STALE_AFTER_MS } from '../../src/sessions/mod-protocol.ts';
import type { ModRegisterMessage, ModCommand } from '../../src/sessions/mod-protocol.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

let clock = 1_000_000;
const live = new Map<number, { alive: boolean; start: string }>();
function peer(pid: number, alive = true, start = `start-${pid}`): void {
  live.set(pid, { alive, start });
}
function registry(overrides: Partial<ModRegistryOptions> = {}) {
  return new ModRegistry({
    now: () => clock,
    startTime: (pid) => live.get(pid)?.start,
    liveness: (pid, expectedStart) => {
      const entry = live.get(pid);
      if (!entry) return { alive: false, identityKnown: true, reason: 'unknown pid' };
      if (expectedStart && entry.start !== expectedStart) return { alive: false, identityKnown: true, reason: 'recycled' };
      return { alive: entry.alive, identityKnown: true };
    },
    ...overrides,
  });
}

function registerMessage(over: Partial<ModRegisterMessage> = {}): ModRegisterMessage {
  return {
    protocolVersion: 1,
    sessionId: 'session-a',
    cwd: '/tmp/whatever',
    claudeVersion: '2.1.288',
    isInteractive: true,
    surface: 'terminal',
    ...over,
  };
}

function command(op: 'prompt' | 'steer' | 'abort' | 'answer', over: Partial<ModCommand> = {}): ModCommand {
  return {
    requestId: `cmd-${op}-${Math.random().toString(36).slice(2, 7)}`,
    op,
    queuedAt: clock,
    ...(op === 'prompt' || op === 'steer' ? { text: 'hello from the app' } : {}),
    ...(op === 'abort' ? { turnId: 'turn-1' } : {}),
    ...(op === 'answer' ? { answers: { q: 'Yes' } } : {}),
    ...over,
  };
}

try {
  check('the freshness window is three missed 20 s polls', STALE_AFTER_MS === 60_000, `${STALE_AFTER_MS}ms`);

  // ── Freshness ──
  peer(101);
  let reg = registry();
  reg.register(registerMessage(), { pid: 101, uid: 1000 });
  check('a fresh registration is live', reg.status('session-a').state === 'live', JSON.stringify(reg.status('session-a').reasons));
  clock += STALE_AFTER_MS;
  check('exactly at three missed polls it is still live', reg.status('session-a').state === 'live');
  clock += 1;
  check('one millisecond past three missed polls it is observe', reg.status('session-a').state === 'observe', JSON.stringify(reg.status('session-a').reasons));
  check('stale is reported as a reason, not a silent demotion', reg.status('session-a').reasons.includes('stale'));
  reg.notePoll('session-a');
  check('a poll revives the row (the poll chain is the heartbeat)', reg.status('session-a').state === 'live');
  check('reviving clears the stale reason', reg.status('session-a').reasons.length === 0);

  // ── Pid identity ──
  peer(102, false);
  reg = registry();
  reg.register(registerMessage({ sessionId: 'dead' }), { pid: 102, uid: 1000 });
  let deadStatus = reg.status('dead');
  check('a dead pid reads observe, not gone', deadStatus.state === 'observe' && deadStatus.present, JSON.stringify(deadStatus.reasons));
  check('a dead pid is reported as pid-dead', deadStatus.reasons.includes('pid-dead'));
  check('the first dead sighting asks for one attention event', reg.takeAttentionEvent(reg.get('dead')!) === true);
  check('the second dead sighting asks for none', reg.takeAttentionEvent(reg.get('dead')!) === false);

  peer(103, true, 'start-original');
  reg.register(registerMessage({ sessionId: 'recycled' }), { pid: 103, uid: 1000 });
  check('a live pid with its recorded start time is live', reg.status('recycled').state === 'live');
  peer(103, true, 'start-somebody-else');
  const recycled = reg.status('recycled');
  check('a recycled pid reads dead rather than alive-as-another-process', recycled.pidAlive === false, JSON.stringify(recycled.reasons));
  check('a recycled pid is observe, not live', recycled.state === 'observe');

  // ── Interactive and surface gates ──
  peer(104);
  reg.register(registerMessage({ sessionId: 'headless', isInteractive: false, surface: '' }), { pid: 104, uid: 1000 });
  check('a headless registration is observe', reg.status('headless').state === 'observe', JSON.stringify(reg.status('headless').reasons));
  check('a headless registration still exists (register is safe everywhere)', reg.status('headless').present);
  peer(105);
  reg.register(registerMessage({ sessionId: 'hosted', surface: 'vscode' }), { pid: 105, uid: 1000 });
  check('a non-terminal surface is observe', reg.status('hosted').reasons.includes('not-terminal'));

  // ── Replacement: restart and /clear ──
  peer(201);
  peer(202);
  reg = registry();
  reg.register(registerMessage(), { pid: 201, uid: 1000 });
  reg.enqueue('session-a', command('prompt'));
  check('one row per session id', reg.list().length === 1);
  reg.register(registerMessage(), { pid: 202, uid: 1000 });
  check('a re-register replaces rather than duplicates', reg.list().length === 1 && reg.get('session-a')!.peerPid === 202, `pid=${reg.get('session-a')!.peerPid}`);
  check('a prompt queued before the restart survives it', reg.queuedCount('session-a') === 1, 'the --resume case');
  reg.register(registerMessage({ sessionId: 'after-clear' }), { pid: 202, uid: 1000 });
  check('/clear re-registers under the new id as its own row', reg.status('after-clear').present && reg.status('after-clear').state === 'live');

  // ── reportedPid is diagnostic only ──
  peer(301);
  reg = registry();
  reg.register(registerMessage({ reportedPid: process.pid }), { pid: 301, uid: 1000 });
  const disagreed = reg.get('session-a')!;
  check('a disagreeing reportedPid does not replace the kernel pid', disagreed.peerPid === 301, `peerPid=${disagreed.peerPid}`);
  check('a disagreeing reportedPid is recorded as a disagreement', disagreed.peerPidAgrees === false);
  reg.register(registerMessage({ reportedPid: 301 }), { pid: 301, uid: 1000 });
  check('an agreeing reportedPid records agreement', reg.get('session-a')!.peerPidAgrees === true);

  // ── Command queue ──
  peer(401);
  reg = registry();
  reg.register(registerMessage(), { pid: 401, uid: 1000 });
  const bad = reg.enqueue('session-a', { requestId: 'x', op: 'prompt', queuedAt: clock });
  check('a prompt with no text is refused before it is queued', bad.ok === false && bad.code === 'invalid_command', JSON.stringify(bad));
  check('refusing a bad command queued nothing', reg.queuedCount('session-a') === 0);
  check('a command for an unregistered session is refused', reg.enqueue('nope', command('prompt')).ok === false);
  const noRow = reg.enqueue('nope', command('prompt'));
  check('and says it is the missing registration', noRow.ok === false && noRow.code === 'no_registration', JSON.stringify(noRow));

  for (let i = 0; i < 12; i += 1) reg.enqueue('session-a', command('prompt'));
  const overflow = reg.enqueue('session-a', command('prompt'));
  check('the queue is bounded and says queue_full', overflow.ok === false && overflow.code === 'queue_full', JSON.stringify(overflow));

  reg = registry();
  reg.register(registerMessage(), { pid: 401, uid: 1000 });
  reg.enqueue('session-a', command('prompt', { text: 'first' }));
  reg.enqueue('session-a', command('prompt', { text: 'second' }));
  const first = reg.dequeue('session-a');
  check('commands are delivered in order', first?.text === 'first', String(first?.text));
  check('a delivered command is consumed once', reg.dequeue('session-a')?.text === 'second' && reg.dequeue('session-a') === undefined);

  reg.enqueue('session-a', command('prompt', { text: 'stale' }));
  clock += 5 * 60_000;
  check('an expired command is dropped rather than delivered', reg.dequeue('session-a') === undefined);

  reg = registry();
  reg.register(registerMessage(), { pid: 401, uid: 1000 });
  reg.enqueue('session-a', command('answer', { requestId: 'answer-1' }));
  check('a queued answer can be cancelled when the hold resolves elsewhere', reg.cancelQueuedAnswer('session-a', 'answer-1') === true);
  check('and cancelling removes exactly that answer', reg.queuedCount('session-a') === 0);
  check('cancelling an answer that is not there reports false', reg.cancelQueuedAnswer('session-a', 'answer-1') === false);

  // ── Holds and turn events ──
  peer(501);
  reg = registry();
  reg.register(registerMessage(), { pid: 501, uid: 1000 });
  reg.openHold('session-a', 'req-1');
  check('an open hold is visible to the poll path', reg.hasOpenHold('session-a', 'req-1') && reg.openHoldIds('session-a').join() === 'req-1');
  reg.closeHold('session-a', 'req-1');
  check('closing a hold takes it off the poll path', !reg.hasOpenHold('session-a', 'req-1') && reg.openHoldIds('session-a').length === 0);
  // Two asks open at once are two holds. Closing one leaves the other open, which is what lets the
  // turn boundary below find it.
  reg.openHold('session-a', 'req-conc-1');
  reg.openHold('session-a', 'req-conc-2');
  reg.closeHold('session-a', 'req-conc-2');
  check('closing one of two open holds leaves the other open', reg.openHoldIds('session-a').join() === 'req-conc-1',
    reg.openHoldIds('session-a').join());

  reg.openHold('session-a', 'req-2');
  reg.enqueue('session-a', command('answer', { requestId: 'req-2' }));
  const completed = reg.noteTurnEvent({ kind: 'turn.complete', sessionId: 'session-a' });
  // A turn boundary closes EVERY hold the session had open, not just the newest one: `req-conc-1`
  // from the block above is still open, and leaving it held would park a terminal whose turn is over.
  check('turn.complete resolves every open hold', [...completed.resolved].sort().join() === 'req-2,req-conc-1', JSON.stringify(completed));
  check('turn.complete also drops the answer queued for it', reg.queuedCount('session-a') === 0);
  check('turn.complete does not deregister the session', reg.status('session-a').present);

  reg.openHold('session-a', 'req-3');
  const cancelled = reg.noteTurnEvent({ kind: 'user-cancel', sessionId: 'session-a', requestId: 'req-3' });
  check('user-cancel resolves only the call that was escaped', cancelled.resolved.join() === 'req-3');
  reg.openHold('session-a', 'req-4');
  reg.openHold('session-a', 'req-5');
  const ended = reg.noteTurnEvent({ kind: 'session.end', sessionId: 'session-a', detail: { reason: 'clear' } });
  check('session.end resolves every hold and deregisters', ended.resolved.length === 2 && ended.deregister === true, JSON.stringify(ended));
  check('after session.end there is no row', reg.status('session-a').present === false);
  check('and the queue went with it', reg.queuedCount('session-a') === 0);
  // ── a send that cannot be delivered is refused, not accepted ──
  // Both of these used to answer `ok`, then drop the command at the queue's 120 s TTL. The app
  // reported success and the user's words went nowhere, which is the failure a command queue is
  // not allowed to have.
  {
    peer(4100);
    const reg = registry();
    reg.register(registerMessage({ sessionId: 'session-q' }), { pid: 4100, uid: 1000 });
    clock += STALE_AFTER_MS + 1;
    const staleSend = reg.enqueue('session-q', command('prompt', { text: 'while you were out' }));
    check('a row that stopped polling refuses the send', staleSend.ok === false && staleSend.code === 'stale_registration', JSON.stringify(staleSend));
    check('and nothing was queued behind the refusal', reg.queuedCount('session-q') === 0);
    clock -= STALE_AFTER_MS + 1;
    reg.notePoll('session-q');
    check('the same send succeeds once the poll chain is live again', reg.enqueue('session-q', command('prompt', { text: 'now' })).ok === true);
    peer(4100, false);
    const deadSend = reg.enqueue('session-q', command('prompt', { text: 'to a dead pid' }));
    check('a row whose pid is gone refuses it too', deadSend.ok === false && deadSend.code === 'stale_registration', JSON.stringify(deadSend));
  }

  // ── the turn a Stop is allowed to name ──
  {
    peer(4200);
    peer(4201);
    const reg = registry();
    reg.register(registerMessage({ sessionId: 'session-t' }), { pid: 4200, uid: 1000 });
    check('a fresh registration is running no turn', reg.currentTurn('session-t') === '');
    const noTurn = reg.enqueue('session-t', command('abort', { turnId: undefined }));
    check('Stop with no turn is refused before it can be queued', noTurn.ok === false && noTurn.code === 'no_active_turn', JSON.stringify(noTurn));
    reg.noteTurnEvent({ kind: 'turn.start', sessionId: 'session-t', detail: { turnId: 'turn-1' } });
    check('turn.start names the running turn', reg.currentTurn('session-t') === 'turn-1');
    reg.enqueue('session-t', command('abort', { requestId: 'abort-1', turnId: undefined }));
    const delivered = reg.dequeue('session-t');
    check('an abort is stamped with the running turn', delivered?.op === 'abort' && delivered.turnId === 'turn-1', JSON.stringify(delivered));
    reg.noteTurnEvent({ kind: 'turn.complete', sessionId: 'session-t', detail: { turnId: 'turn-1', agentId: 'agent-9' } });
    check("a subagent's turn.complete leaves the main turn alone", reg.currentTurn('session-t') === 'turn-1');
    reg.noteTurnEvent({ kind: 'turn.complete', sessionId: 'session-t', detail: { turnId: 'turn-1' } });
    check("the main loop's turn.complete clears it", reg.currentTurn('session-t') === '');
    reg.register(registerMessage({ sessionId: 'session-t' }), { pid: 4201, uid: 1000 });
    check('a re-registration inherits no turn', reg.currentTurn('session-t') === '');
  }

  // ── MB1: who may take a session another terminal claimed ──
  {
    peer(4300);
    peer(4301);
    const reg = registry();
    reg.register(registerMessage({ sessionId: 'session-c' }), { pid: 4300, uid: 1000 });
    check('MB1 unit: a live, polling claimant keeps its claim', reg.claimState('session-c', 4301) === 'claimed');
    clock += STALE_AFTER_MS + 1;
    check('MB1 unit: a claimant that stopped polling has lost its claim', reg.claimState('session-c', 4301) === 'takeover');
    clock -= STALE_AFTER_MS + 1;
    reg.notePoll('session-c');
    check('MB1 unit: and polling again gives it back', reg.claimState('session-c', 4301) === 'claimed');
    peer(4300, false);
    check('MB1 unit: a claimant whose pid died has lost its claim', reg.claimState('session-c', 4301) === 'takeover');
  }

} catch (error) {
  check('no exception', false, String((error as Error)?.stack ?? error).slice(0, 300));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `FAILED ${failed.length}/${results.length}` : `OK ${results.length}/${results.length} passed`}`);
process.exit(failed.length ? 1 : 0);
