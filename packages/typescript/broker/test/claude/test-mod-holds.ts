/**
 * Hold lifecycle: one answer per request, late answers dropped and logged, and a lease the
 * terminal renews for as long as it waits.
 *
 * Three of these are regression tests for measured failures rather than hypotheticals:
 * - An unread verdict decided the *next* tool call in 14 ms with nobody asked, so consumption is
 *   once-per-request and the late answer is logged, not merely ignored.
 * - A hold that outlived its turn would decide the next call, so `turn.complete` and
 *   `user-cancel` both end it and the audit row says so.
 * - A hold whose terminal stopped asking kept its card tappable, so a lapsed lease closes it and
 *   refuses a late answer. A hold whose terminal is still asking is never closed by the clock.
 *
 *   bun run packages/typescript/broker/test/claude/test-mod-holds.ts   (exit 0 = all pass)
 */
export {};
import { ModHoldStore, decideModHold } from '../../src/sessions/mod-holds.ts';
import { ModAuditStore } from '../../src/sessions/mod-audit.ts';
import { ModRegistry } from '../../src/sessions/mod-registry.ts';
import { MOD_DETAIL_MAX_CHARS, parseModHold } from '../../src/sessions/mod-protocol.ts';
import type { ModHoldMessage } from '../../src/sessions/mod-protocol.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** A clock the suite advances by the same amount the injected sleep waits, so time is real
 *  enough for the lease logic and fast enough for CI. */
/** `mode: null` means "the transcript has no permission-mode row", which is not the same thing
 *  as a mode string and is the case the gate must refuse on. */
function harness(options: { mode?: string | null; viewers?: number; killSwitch?: boolean; leaseMs?: number } = {}) {
  const log: string[] = [];
  const accepted: string[] = [];
  const released: { requestId: string; why: string }[] = [];
  const resolved: { requestId: string; outcome: string }[] = [];
  let clock = 100_000;
  const registry = new ModRegistry({
    now: () => clock,
    startTime: () => 'start',
    liveness: () => ({ alive: true, identityKnown: true }),
  });
  registry.register({ protocolVersion: 1, sessionId: 's', cwd: '/tmp', claudeVersion: '2.1.288', isInteractive: true, surface: 'terminal' }, { pid: 900, uid: 1000 });
  const audit = new ModAuditStore({ now: () => clock });
  const holds = new ModHoldStore({
    registry,
    audit,
    now: () => clock,
    leaseMs: options.leaseMs ?? 100_000,
    sleep: async (ms) => {
      clock += ms;
      await new Promise((r) => setTimeout(r, 0));
    },
    log: (message) => log.push(message),
    gate: () => ({ mode: options.mode === null ? undefined : (options.mode ?? 'default'), viewers: options.viewers ?? 1, killSwitch: options.killSwitch ?? false }),
    onHoldAccepted: (hold) => accepted.push(hold.requestId),
    onRelease: (_sessionId, hold, why) => released.push({ requestId: hold.requestId, why }),
    onResolve: (_sessionId, requestId, outcome) => resolved.push({ requestId, outcome: outcome.kind }),
  });
  return { registry, audit, holds, log, accepted, released, resolved, clock: () => clock, advance: (ms: number) => { clock += ms; } };
}

function hold(requestId: string, over: Partial<ModHoldMessage> = {}): ModHoldMessage {
  return { sessionId: 's', requestId, tool: 'Bash', decision: 'ask', input: 'rm -rf /important/directory', ...over };
}

try {
  // ── A mod that stops polling, and a row that stops being able to carry an answer ──
  // A hold's expiry used to be enforced only inside a verdict poll. A mod that never polls cannot
  // enter one, so the hold sat open after its terminal had stopped asking -- and the app's card
  // stayed tappable the whole time, for a call its terminal had long since been handed. The sweep
  // is what closes it when nobody is asking.
  const vanished = harness({ leaseMs: 5_000 });
  vanished.holds.accept(hold('r-vanished'));
  const notYet = vanished.holds.sweep('s', true);
  check('a sweep inside the lease leaves a live hold alone', notYet.length === 0 && vanished.holds.isOpen('s', 'r-vanished'), JSON.stringify(notYet));
  vanished.advance(5_100);
  const swept = vanished.holds.sweep('s', true);
  check('a hold whose terminal stopped asking is closed by the sweep, not left open', swept.join() === 'r-vanished' && vanished.holds.isOpen('s', 'r-vanished') === false, JSON.stringify(swept));
  check('and closing it is said out loud, so the card goes with it', vanished.resolved.some((r) => r.requestId === 'r-vanished' && r.outcome === 'expired'), JSON.stringify(vanished.resolved));
  check('and the audit names the expiry', vanished.audit.list({ includeReleases: true }).some((row) => row.requestId === 'r-vanished' && row.released === 'deadline'), JSON.stringify(vanished.audit.list({ includeReleases: true }).map((row) => row.released)));

  const stale = harness({ leaseMs: 60_000 });
  stale.holds.accept(hold('r-stale'));
  const unclosed = stale.holds.sweep('s', true);
  check('a row that can still carry an answer keeps its hold open', unclosed.length === 0);
  const dropped = stale.holds.sweep('s', false);
  check('a row that cannot carry one closes everything it has open', dropped.join() === 'r-stale' && stale.holds.isOpen('s', 'r-stale') === false, JSON.stringify(dropped));
  check('and the close is a cancel with a reason, not an approval', stale.resolved.some((r) => r.requestId === 'r-stale' && r.outcome === 'cancelled'), JSON.stringify(stale.resolved));

  // ── Immediate releases ──
  const auto = harness({ mode: 'auto' });
  const autoOutcome = auto.holds.accept(hold('r-auto'));
  check('auto mode releases at once', autoOutcome.kind === 'released' && autoOutcome.why === 'mode:auto', JSON.stringify(autoOutcome));
  check('the release is published to the app as a reason', auto.released[0]?.why === 'mode:auto', JSON.stringify(auto.released));
  check('a released hold opens nothing', auto.holds.openCount() === 0);
  check('a release is recorded as a release, not a decision', auto.audit.list({ includeReleases: true })[0]?.released === 'mode:auto');
  check('a release is absent from the decisions view', auto.audit.list().length === 0);

  for (const [name, options, expected] of [
    ['no viewer', { viewers: 0 }, 'viewer:none'],
    ['kill switch', { killSwitch: true }, 'killSwitch'],
    ['unknown mode', { mode: null }, 'mode:unknown'],
    ["don't-ask mode", { mode: 'dontAsk' }, 'mode:dontAsk'],
    ['bypass mode', { mode: 'bypassPermissions' }, 'mode:bypassPermissions'],
    ['an unwritten mode name (CX9)', { mode: 'manual' }, 'mode:unknown'],
  ] as const) {
    const local = harness(options as never);
    const outcome = local.holds.accept(hold(`r-${name}`));
    check(`${name} releases with ${expected}`, outcome.kind === 'released' && outcome.why === expected, JSON.stringify(outcome));
  }

  // ── PM1/PM2: plan mode holds an ordinary ask, and shows a plan without taking it ──
  const planning = harness({ mode: 'plan' });
  check('PM1 unit: a plan-mode ask is held for the app', planning.holds.accept(hold('r-plan-bash')).kind === 'held'
    && planning.accepted.includes('r-plan-bash'));
  const planned = planning.holds.accept(hold('r-plan', { tool: 'ExitPlanMode', input: 'plan: # Ship it' }));
  check('PM2 unit: the plan itself is released, not held, so its card cannot approve it',
    planned.kind === 'released' && planned.why === 'plan:terminal-only' && !planning.accepted.includes('r-plan'), JSON.stringify(planned));
  check('PM2 unit: and the release reaches the app, where it is drawn read-only',
    planning.released.some((r) => r.requestId === 'r-plan' && r.why === 'plan:terminal-only'), JSON.stringify(planning.released));
  const viewerless = harness({ mode: 'plan', viewers: 0 });
  check('PM2 unit: with nobody watching the plan says that, not the plan rule',
    (viewerless.holds.accept(hold('r-plan-nobody', { tool: 'ExitPlanMode' })) as { why?: string }).why === 'viewer:none');

  // ── AM1: a question is held in auto mode, where the picker is a person's; a tool call is not ──
  const autoQuestion = harness({ mode: 'auto' });
  check('AM1 unit: an auto-mode question is held for the app',
    autoQuestion.holds.accept(hold('q-auto', { tool: 'AskUserQuestion', input: '', questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] })).kind === 'held');
  check('AM1 unit: an auto-mode tool call beside it is released', autoQuestion.holds.accept(hold('r-auto-call')).kind === 'released');
  const dontAskQuestion = harness({ mode: 'dontAsk' });
  check('AM1 unit: a dontAsk question is released, because Claude refuses it there',
    (dontAskQuestion.holds.accept(hold('q-dont', { tool: 'AskUserQuestion', input: '', questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] })) as { why?: string }).why === 'mode:dontAsk');

  // ── Held, then answered ──
  const held = harness({ mode: 'default', viewers: 2 });
  check('default mode with a viewer holds', held.holds.accept(hold('r-1')).kind === 'held');
  check('the app is told about the hold', held.accepted.join() === 'r-1');
  check('the hold is open and answerable', held.holds.isOpen('s', 'r-1'));
  const duplicate = held.holds.accept(hold('r-1'));
  check('a duplicate hold for one request opens no second card', duplicate.kind === 'held' && held.accepted.length === 1);

  const poll = held.holds.pollVerdict('s', 'r-1', 50);
  const answered = held.holds.answer('s', 'r-1', 'allow', 'app');
  const outcome = await poll;
  check('the in-flight poll receives the verdict', answered && outcome.kind === 'verdict' && (outcome as { behavior?: string }).behavior === 'allow', JSON.stringify(outcome));
  check('the verdict names who answered', (outcome as { source?: string }).source === 'app');
  check('answering closes the hold', !held.holds.isOpen('s', 'r-1'));

  // ── Consumption exactly once ──
  const second = held.holds.answer('s', 'r-1', 'deny', 'band');
  check('a second answer to the same request is refused', second === false);
  check('and it is logged, because an invisible drop is how this bug hid once', held.log.some((line) => line.includes('late answer dropped') && line.includes('r-1')), held.log.join(' | ').slice(0, 120));
  const late = harness({ mode: 'default' });
  late.holds.accept(hold('r-late'));
  late.holds.answer('s', 'r-late', 'allow', 'app');
  late.holds.answer('s', 'r-late', 'deny', 'band');
  check('the losing seat cannot overwrite the winning answer', late.log.filter((line) => line.includes('late answer dropped')).length === 1);
  const neverHeld = harness();
  check('an answer to a request that was never held is dropped and logged', neverHeld.holds.answer('s', 'ghost', 'allow', 'app') === false && neverHeld.log.some((l) => l.includes('never held')));

  // A consumed verdict is not delivered twice, even to a second poll.
  const replay = harness({ mode: 'default' });
  replay.holds.accept(hold('r-once'));
  const firstPoll = replay.holds.pollVerdict('s', 'r-once', 40);
  replay.holds.answer('s', 'r-once', 'allow', 'band');
  const first = await firstPoll;
  const secondPoll = await replay.holds.pollVerdict('s', 'r-once', 5);
  // The second reader is told the call is over, and that its outcome went out elsewhere: never the
  // verdict again, and never an empty answer it could read as "still held".
  check('the verdict travels once', first.kind === 'verdict' && secondPoll.kind === 'settled-elsewhere', `${first.kind} then ${secondPoll.kind}`);
  const reoffered = replay.holds.accept(hold('r-once'));
  check('MB3 unit: a call whose outcome was handed over is not accepted as a new hold', reoffered.kind === 'settled-elsewhere'
    && replay.holds.openCount() === 0, `${reoffered.kind}, ${replay.holds.openCount()} open`);

  // ── The lease, and turn death ──
  // LH1: no deadline. A hold the terminal keeps asking about is open for as long as it asks: here
  // fifty leases' worth of time, all of it inside the terminal's own long-polls.
  const patient = harness({ mode: 'default', viewers: 1, leaseMs: 100 });
  patient.holds.accept(hold('r-patient'));
  const patientStart = patient.clock();
  let patientLast = await patient.holds.pollVerdict('s', 'r-patient', 1_000);
  for (let i = 1; i < 5 && patientLast.kind === 'held'; i += 1) patientLast = await patient.holds.pollVerdict('s', 'r-patient', 1_000);
  check('LH1 unit: a hold its terminal keeps polling is still open fifty leases later',
    patientLast.kind === 'held' && patient.holds.isOpen('s', 'r-patient') && patient.clock() - patientStart >= 5_000,
    `${patientLast.kind} after ${patient.clock() - patientStart} ms`);
  check('LH1 unit: and an answer then is still taken', patient.holds.answer('s', 'r-patient', 'allow', 'app') === true);
  check('LH1 unit: the audit row counts every poll it was asked, with no cap',
    patient.audit.list().find((row) => row.requestId === 'r-patient')?.polls === 5,
    JSON.stringify(patient.audit.list().map((row) => row.polls)));

  // LH2: what a lease is for. A hold nobody asks about any more ends, and a later poll hears why.
  const expired = harness({ mode: 'default', viewers: 1, leaseMs: 100 });
  expired.holds.accept(hold('r-exp'));
  const expiredOutcome = await expired.holds.pollVerdict('s', 'r-exp', 5_000, false);
  check('LH2 unit: a hold its terminal stopped asking about expires rather than waiting forever', expiredOutcome.kind === 'expired', JSON.stringify(expiredOutcome));
  check('expiry is auditable as an expiry', expired.audit.list({ includeReleases: true }).some((row) => row.answeredBy === 'expired'));
  check('an expired hold answers a later poll with the expiry, not with nothing', (await expired.holds.pollVerdict('s', 'r-exp', 1)).kind === 'expired');

  // LH3: a parked request whose connection has gone is not the terminal asking. Renewing on it
  // would keep a dead terminal's card open for as long as the request stayed parked.
  const deadClaim = harness({ mode: 'default', viewers: 1, leaseMs: 100 });
  deadClaim.holds.accept(hold('r-dead-claim'));
  const deadOutcome = await deadClaim.holds.pollVerdict('s', 'r-dead-claim', 5_000, true, () => false);
  check('LH3 unit: a hold leg whose connection has gone does not renew the lease', deadOutcome.kind === 'expired'
    && !deadClaim.holds.isOpen('s', 'r-dead-claim') && deadClaim.clock() < 100_000 + 1_000, `${deadOutcome.kind} at +${deadClaim.clock() - 100_000} ms`);

  // LH4: the same call offered again is the terminal asking too.
  const reoffer = harness({ mode: 'default', viewers: 1, leaseMs: 1_000 });
  reoffer.holds.accept(hold('r-reoffer'));
  reoffer.advance(900);
  check('LH4 unit: a re-offer inside the lease is the same hold', reoffer.holds.accept(hold('r-reoffer')).kind === 'held');
  reoffer.advance(900);
  check('LH4 unit: and it renewed the lease', reoffer.holds.answer('s', 'r-reoffer', 'deny', 'app') === true);

  const cancelled = harness({ mode: 'default' });
  cancelled.holds.accept(hold('r-turn'));
  const turnEvent = cancelled.registry.noteTurnEvent({ kind: 'turn.complete', sessionId: 's' });
  for (const id of turnEvent.resolved) cancelled.holds.cancel('s', id, 'turn-complete');
  check('turn.complete resolves the hold', cancelled.resolved.some((r) => r.requestId === 'r-turn' && r.outcome === 'cancelled'), JSON.stringify(cancelled.resolved));
  check('and no verdict survives it', cancelled.holds.answer('s', 'r-turn', 'allow', 'app') === false);

  const escaped = harness({ mode: 'default' });
  escaped.holds.accept(hold('r-esc'));
  escaped.registry.noteTurnEvent({ kind: 'user-cancel', sessionId: 's', requestId: 'r-esc' });
  escaped.holds.cancel('s', 'r-esc', 'user-cancel');
  check('Escape inside a hold ends it (user-cancel)', !escaped.holds.isOpen('s', 'r-esc'));

  // ── BH1: a lapsed hold takes no answer, whether or not anything has swept it ──
  const onTime = harness({ mode: 'default', leaseMs: 1_000 });
  onTime.holds.accept(hold('r-on-time'));
  onTime.advance(999);
  check('BH1 unit: an answer a millisecond inside the lease is taken', onTime.holds.answer('s', 'r-on-time', 'allow', 'app') === true);

  const pastDue = harness({ mode: 'default', leaseMs: 1_000 });
  pastDue.holds.accept(hold('r-late'));
  const lateCard = pastDue.holds.openHolds()[0]!.appRequestId;
  check('BH1 unit: inside the lease the card is the hold\'s', pastDue.holds.byCard('s', lateCard)?.requestId === 'r-late');
  pastDue.advance(1_000);
  check('BH1 unit: once it lapses, the card stands for nothing an answer can reach', pastDue.holds.byCard('s', lateCard) === undefined);
  check('BH1 unit: an answer to a lapsed hold is refused before any sweep has run', pastDue.holds.answer('s', 'r-late', 'allow', 'app') === false);
  check('BH1 unit: and the refusal closes the hold as the lease would, card and all',
    !pastDue.holds.isOpen('s', 'r-late') && pastDue.resolved.some((r) => r.requestId === 'r-late' && r.outcome === 'expired')
      && pastDue.audit.list({ includeReleases: true }).some((row) => row.requestId === 'r-late' && row.released === 'deadline'),
    JSON.stringify(pastDue.resolved));
  check('BH1 unit: it is logged as late, not lost', pastDue.log.some((line) => /late answer dropped .*stopped asking/.test(line)), JSON.stringify(pastDue.log));

  const lateQuestion = harness({ mode: 'default', leaseMs: 1_000 });
  lateQuestion.holds.accept(hold('q-late', { tool: 'AskUserQuestion', questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }));
  lateQuestion.advance(1_000);
  check('BH1 unit: a question answer to a lapsed hold is refused too', lateQuestion.holds.answerQuestion('s', 'q-late', { 'Which?': 'A' }) === false
    && lateQuestion.resolved.some((r) => r.requestId === 'q-late' && r.outcome === 'expired'), JSON.stringify(lateQuestion.resolved));

  const sweepable = harness({ mode: 'default', leaseMs: 1_000 });
  sweepable.holds.accept(hold('r-swept'));
  sweepable.holds.accept(hold('r-young'));
  sweepable.advance(1_000);
  check('BH1 unit: every session with an open hold is reachable by a sweep', JSON.stringify(sweepable.holds.openSessionIds()) === '["s"]');

  // ── Audit content ──
  const audited = harness({ mode: 'acceptEdits', viewers: 1 });
  audited.holds.accept(hold('r-audit', { tool: 'Write' }));
  audited.holds.answer('s', 'r-audit', 'allow', 'app');
  const row = audited.audit.list()[0];
  check('the audit row names the session, request and tool', row?.sessionId === 's' && row?.requestId === 'r-audit' && row?.tool === 'Write', JSON.stringify(row));
  check('the audit row names the engine verdict', row?.engineVerdict === 'ask');
  check('the audit row names the mode the gate saw', row?.modeSeen === 'acceptEdits', String(row?.modeSeen));
  check('the audit row names who answered', row?.answeredBy === 'app');
  check('the audit row carries a duration', typeof row?.durationMs === 'number' && row.durationMs >= 0, String(row?.durationMs));
  const serialised = JSON.stringify(audited.audit.list({ includeReleases: true }));
  check('no audit row carries prompt or tool text', !serialised.includes('rm -rf') && !serialised.includes('important'), serialised.slice(0, 120));
  check('the tool input is kept only as a fingerprint', /^[0-9a-f]{16}$/.test(String(row?.inputDigest)), String(row?.inputDigest));

  // ── The gate stays pure under load ──
  check('the gate is a pure function of its three inputs', decideModHold({ mode: 'default', viewers: 1, killSwitch: false }).hold === true);

  // The card's details: kept with their line breaks, and bounded by the broker whatever a mod sends.
  const detailed = parseModHold({ sessionId: '9d2b9c1e-3f4a-4b5c-8d6e-7f8091a2b3c4', requestId: 'cm-1', tool: 'Edit', detail: 'file_path: /w/a.ts\nold_string: a\nnew_string: b' });
  check('full detail unit: a hold keeps the call\'s details, line breaks and all',
    detailed.ok && detailed.message.detail === 'file_path: /w/a.ts\nold_string: a\nnew_string: b', JSON.stringify(detailed));
  const oversized = parseModHold({ sessionId: '9d2b9c1e-3f4a-4b5c-8d6e-7f8091a2b3c4', requestId: 'cm-2', tool: 'Write', detail: 'x'.repeat(20_000) });
  check('full detail unit: details past the broker\'s bound are cut, with an ellipsis',
    oversized.ok && oversized.message.detail?.length === MOD_DETAIL_MAX_CHARS + 2 && oversized.message.detail.endsWith('\n\u2026'),
    String(oversized.ok && oversized.message.detail?.length));
  const notText = parseModHold({ sessionId: '9d2b9c1e-3f4a-4b5c-8d6e-7f8091a2b3c4', requestId: 'cm-3', tool: 'Bash', detail: { command: 'ls' } });
  check('full detail unit: details that are not text are dropped, and the hold stands', notText.ok && notText.message.detail === undefined, JSON.stringify(notText));
} catch (error) {
  check('no exception', false, String((error as Error)?.stack ?? error).slice(0, 300));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `FAILED ${failed.length}/${results.length}` : `OK ${results.length}/${results.length} passed`}`);
process.exit(failed.length ? 1 : 0);
