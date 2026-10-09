/**
 * The mod's lifecycle against the real broker socket: registration, the poll loop, a hot reload,
 * a second terminal, a broker that stops answering, and what the mod writes to its log.
 *
 * Everything on the broker side is real: `ModSocketServer` bound in a mkdtemp directory, the real
 * `ModRegistry`, `ModHoldStore` and audit, the real HTTP reader and the kernel's peer credential.
 * Everything on the mod side is the shipped `register.js`, loaded fresh per terminal, behind a
 * `$` whose `http.fetch` is a real fetch over that socket. What a test cannot have is faked: the
 * engine beneath `next(e)`, the TUI, and the host timer behind `$.clock.after`.
 *
 * Waits are scaled down through the mod's `tuneForTest` seam; production values are untouched.
 *
 *   bun run packages/typescript/broker/test/claude/test-claude-mod-lifecycle-seam.ts   (exit 0 = all pass)
 */
export {};
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeModService } from '../../src/sessions/claude-mod-service.ts';
import { loadMod, ledger, socketBroker, tempRoot, until, type ModInstance } from './claude-mod-seam-harness.ts';

const { check, finish } = ledger();

// A detached promise in the mod that rejects is a bug the host would only log. Recorded here and
// asserted at the end, so it fails a check instead of the whole process.
const unhandled: string[] = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(String((reason as Error)?.message ?? reason).slice(0, 200));
});

/** Fast waits for one module instance. */
function tune(mod: ModInstance, overrides: Record<string, unknown> = {}): void {
  (mod.exports.tuneForTest as (o: Record<string, unknown>) => void)({ backoffMs: [100, 200, 300], ...overrides });
}

const cleanups: (() => void)[] = [];
function onCleanup(fn: () => void): void {
  cleanups.push(fn);
}

async function startTerminal(mod: ModInstance, cwd = '/work'): Promise<void> {
  await mod.fire('session.start', { cwd, surface: 'terminal', isInteractive: true });
}

// ── MB12: the mod's log is the debug log, and it never carries what the person typed ──────────
async function loggingSection(): Promise<void> {
  const temp = tempRoot('cmls-log-');
  onCleanup(temp.remove);
  const broker = await socketBroker(temp.root);
  onCleanup(broker.close);
  const sessionId = randomUUID();
  const promptText = 'PROMPT-TEXT-cobalt-heron';
  const steerText = 'STEER-TEXT-amber-otter';
  const mod = await loadMod('logging', {
    env: { COSYNCING_CLAUDE_SOCK: broker.socketPath, COSYNCING_CLAUDE_DEBUG: '1', HOME: temp.root },
    sessionId,
    // A plugin above refuses the append and quotes the words back in its reason, which is the
    // easiest way for a person's text to reach a log line that only meant to say "refused".
    appendResult: () => ({ deny: `refused: ${steerText}` }),
  });
  onCleanup(mod.kill);
  tune(mod);
  await startTerminal(mod);
  await until(() => broker.registry.get(sessionId) !== undefined);
  broker.server.enqueue(sessionId, { requestId: 'log-prompt', op: 'prompt', text: promptText, queuedAt: Date.now() });
  await until(() => mod.record.prompts.some((p) => p.text === promptText));
  await mod.fire('turn.start', { turnId: 'log-turn' });
  broker.server.enqueue(sessionId, { requestId: 'log-steer', op: 'steer', text: steerText, queuedAt: Date.now() });
  await until(() => mod.record.prompts.some((p) => p.text === steerText));
  await mod.fire('turn.complete', { turnId: 'log-turn' });

  const logs = mod.record.logs;
  check('MB12: the debug switch on, the mod does log', logs.length > 0, `${logs.length} lines`);
  const visible = logs.filter((line) => line.to !== 'debug');
  check('MB12: every log line goes to the debug log only, never the transcript', visible.length === 0,
    visible.slice(0, 3).map((line) => `${line.to ?? '(default sink)'}: ${line.text}`).join(' | '));
  const leaked = logs.filter((line) => line.text.includes(promptText) || line.text.includes(steerText));
  check('MB12: no log line carries prompt or steer text', leaked.length === 0, leaked.map((line) => line.text).join(' | ').slice(0, 300));

  const quiet = await loadMod('logging-off', {
    env: { COSYNCING_CLAUDE_SOCK: broker.socketPath, HOME: temp.root },
    sessionId: randomUUID(),
  });
  onCleanup(quiet.kill);
  tune(quiet);
  await startTerminal(quiet);
  await until(() => quiet.record.fetches > 0);
  check('MB12: with the debug switch off, nothing is logged at all', quiet.record.logs.length === 0, JSON.stringify(quiet.record.logs).slice(0, 200));
  mod.kill();
  quiet.kill();
}

// ── MB-DISABLE: COSYNCING_CLAUDE_DISABLE=1 turns the whole mod off ───────────────────────────
async function disableSection(): Promise<void> {
  const temp = tempRoot('cmls-off-');
  onCleanup(temp.remove);
  const broker = await socketBroker(temp.root);
  onCleanup(broker.close);
  const questions = [{ question: 'Which one?', header: 'Pick', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }];
  for (const route of ['session.start', 'hot reload'] as const) {
    const sessionId = randomUUID();
    const mod = await loadMod(`disabled-${route}`, {
      env: { COSYNCING_CLAUDE_SOCK: broker.socketPath, COSYNCING_CLAUDE_DISABLE: '1', HOME: temp.root },
      sessionId,
    });
    onCleanup(mod.kill);
    tune(mod);
    // A hot reload leaves no session.start behind: the first hook the reloaded module sees is a
    // turn or an attach, and that path has to read the switch too.
    if (route === 'session.start') await startTerminal(mod);
    else await mod.fire('session.attach', { surface: 'mobile', clientId: 'app-1' });
    await mod.fire('turn.start', { turnId: `off-${route}` });
    const checked = await mod.fire('tool.check', { tool: 'Bash', tool_use_id: `tu-off-${route}`, input: { command: 'ls' } }) as { decision?: string };
    const asked = await mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: `tu-q-${route}`, questions }) as { ranItself?: boolean };
    const drawn = await mod.renderNow() as { engineDrew?: boolean };
    await mod.fire('turn.complete', { turnId: `off-${route}` });
    await mod.fire('session.end', { reason: 'other' });
    // Long enough for a loop that should not exist to have dialled at least once.
    await until(() => mod.record.fetches > 0, 600);
    check(`MB-DISABLE (${route}): no registration`, !broker.registry.get(sessionId) && !broker.registered.some((r) => r.sessionId === sessionId),
      JSON.stringify(broker.registered));
    check(`MB-DISABLE (${route}): no polls, no events, no holds: not one request leaves`, mod.record.fetches === 0,
      mod.record.requests.map((r) => r.route).join(','));
    check(`MB-DISABLE (${route}): a permission ask is the engine's own`, checked?.decision === 'ask', JSON.stringify(checked));
    check(`MB-DISABLE (${route}): a question goes to Claude's own picker`, asked?.ranItself === true, JSON.stringify(asked));
    check(`MB-DISABLE (${route}): no band is ever drawn`, drawn?.engineDrew === true && mod.record.bands.length === 0, JSON.stringify(mod.record.bands));
    mod.kill();
  }
}

// ── R4-6: a terminal the broker can never accept stops asking ────────────────────────────────
/** Three turns, each with an ask, the way a session that is doing work exercises every hook. */
async function threeTurns(mod: ModInstance, label: string): Promise<void> {
  for (let turn = 1; turn <= 3; turn += 1) {
    await mod.fire('turn.start', { turnId: `${label}-${turn}` });
    await mod.fire('tool.check', { tool: 'Bash', tool_use_id: `tu-${label}-${turn}`, input: { command: 'ls' } });
    await mod.fire('turn.complete', { turnId: `${label}-${turn}` });
  }
}

async function permanentRefusalSection(): Promise<void> {
  // Drive and Take over run Claude with COSYNCING_SPAWNED=1. The broker refuses such a process as
  // its own child, and the mod used to ask again on its backoff for the whole life of the process.
  for (const route of ['session.start', 'hot reload'] as const) {
    const temp = tempRoot('cmls-spawn-');
    onCleanup(temp.remove);
    const broker = await socketBroker(temp.root);
    onCleanup(broker.close);
    const sessionId = randomUUID();
    const mod = await loadMod(`spawned-${route}`, {
      env: { COSYNCING_CLAUDE_SOCK: broker.socketPath, COSYNCING_SPAWNED: '1', HOME: temp.root },
      sessionId,
    });
    onCleanup(mod.kill);
    tune(mod);
    if (route === 'session.start') await startTerminal(mod);
    await threeTurns(mod, `spawned-${route}`);
    await until(() => mod.record.fetches > 0, 1000);
    check(`R4-6 seam (${route}): a Claude started with COSYNCING_SPAWNED=1 sends no request across three turns`,
      mod.record.fetches === 0 && broker.refusals.length === 0,
      `${mod.record.requests.map((r) => r.route).join(',')} refusals=${JSON.stringify(broker.refusals)}`);
    mod.kill();
    broker.close();
  }

  // Refusals no retry can change: one register, one line, then nothing.
  for (const refusal of ['broker_child', 'claude_version_too_old'] as const) {
    const temp = tempRoot('cmls-perm-');
    onCleanup(temp.remove);
    const broker = await socketBroker(temp.root, refusal === 'broker_child' ? { isBrokerChild: () => true } : {});
    onCleanup(broker.close);
    const sessionId = randomUUID();
    const mod = await loadMod(`refused-${refusal}`, {
      env: { COSYNCING_CLAUDE_SOCK: broker.socketPath, COSYNCING_CLAUDE_DEBUG: '1', HOME: temp.root },
      sessionId,
      ...(refusal === 'claude_version_too_old' ? { version: '2.1.100' } : {}),
    });
    onCleanup(mod.kill);
    tune(mod);
    await startTerminal(mod);
    await threeTurns(mod, `refused-${refusal}`);
    // Ten backoff steps' worth of time, so a loop that kept asking would have asked again.
    await until(() => false, 1500);
    const registers = mod.record.requests.filter((r) => r.route === 'register');
    // The refusal's arrival. An event the first turn queued may race the register out; nothing may
    // leave after the answer came back.
    const refusedAt = mod.record.replies.find((reply) => reply.request.route === 'register')?.at ?? 0;
    const after = mod.record.requests.filter((r) => r.at > refusedAt);
    check(`R4-6 seam (${refusal}): a permanent refusal gets exactly one register attempt, then no request at all`,
      registers.length === 1 && refusedAt > 0 && after.length === 0,
      `${mod.record.requests.map((r) => r.route).join(',')} after=${after.map((r) => r.route).join(',')}`);
    const lines = mod.record.logs.filter((line) => /refused for good|sync parked/.test(line.text));
    check(`R4-6 seam (${refusal}): and the terminal says so in one log line`, lines.length === 1 && lines[0]!.text.includes(refusal),
      JSON.stringify(mod.record.logs.map((l) => l.text)));
    mod.kill();
    broker.close();
  }

  // A failure that can pass: nothing listening at the socket yet. The loop keeps backing off.
  {
    const temp = tempRoot('cmls-nobroker-');
    onCleanup(temp.remove);
    const sessionId = randomUUID();
    const mod = await loadMod('no-broker', { env: { COSYNCING_CLAUDE_SOCK: join(temp.root, 'claude-mod.sock'), HOME: temp.root }, sessionId });
    onCleanup(mod.kill);
    tune(mod);
    await startTerminal(mod);
    await until(() => false, 1500);
    const registers = mod.record.requests.filter((r) => r.route === 'register').length;
    check('R4-6 seam: with no broker listening, the terminal still retries on its backoff', registers >= 3,
      `${registers} register attempts in 1.5 s`);
    // And it finds the broker once one is there.
    const broker = await socketBroker(temp.root);
    onCleanup(broker.close);
    check('R4-6 seam: and registers once the broker is there', await until(() => broker.registry.get(sessionId) !== undefined, 3000));
    mod.kill();
    broker.close();
  }
}

// ── MB11: the poll loop ──────────────────────────────────────────────────────────────────────
/**
 * A hot reload re-evaluates the module in the same process. The old module's pending waits are
 * cancelled, but a fetch chain it already had running keeps going -- and the two loops used to take
 * the row from each other on every round, each registration bumping the generation and closing
 * every hold the other had open.
 */
async function hotReloadSection(): Promise<void> {
  const temp = tempRoot('cmls-reload-');
  onCleanup(temp.remove);
  const broker = await socketBroker(temp.root);
  onCleanup(broker.close);
  const sessionId = randomUUID();
  const env = { COSYNCING_CLAUDE_SOCK: broker.socketPath, HOME: temp.root };
  const before = await loadMod('reload-old', { env, sessionId });
  onCleanup(before.kill);
  tune(before, { pollWaitMs: 300 });
  await startTerminal(before);
  check('hot reload: the first module registers', await until(() => broker.registry.get(sessionId) !== undefined), JSON.stringify(broker.registered));

  before.reloadAway();
  const after = await loadMod('reload-new', { env, sessionId });
  onCleanup(after.kill);
  tune(after, { pollWaitMs: 300 });
  const registrationsAtReload = broker.registered.length;
  // The first hook a reloaded module can see. No session.start fires after a reload.
  await after.fire('session.attach', { surface: 'mobile', clientId: 'app-1' });
  check('hot reload: the reloaded module registers on its own', await until(() => after.record.requests.some((r) => r.route === 'register')),
    after.record.requests.map((r) => r.route).join(','));
  await until(() => false, 2000);
  const registrationsAfter = broker.registered.length - registrationsAtReload;
  check('hot reload: two loops do not fight over the row: one registration, not a ping-pong', registrationsAfter <= 2,
    `${registrationsAfter} registrations in 2 s after the reload`);
  const oldMark = before.record.requests.length;
  const generationMark = broker.registry.generation(sessionId);
  await until(() => false, 800);
  check('hot reload: the old module retires: it stops dialling', before.record.requests.length === oldMark,
    before.requestsSince(oldMark).map((r) => r.route).join(','));
  check('hot reload: the generation stops moving', broker.registry.generation(sessionId) === generationMark,
    `${generationMark} -> ${broker.registry.generation(sessionId)}`);
  broker.server.enqueue(sessionId, { requestId: 'after-reload', op: 'prompt', text: 'after the reload', queuedAt: Date.now() });
  await until(() => after.record.prompts.length + before.record.prompts.length > 0);
  await until(() => false, 300);
  check('hot reload: a prompt from the app reaches the reloaded module, once', after.record.prompts.length === 1 && before.record.prompts.length === 0,
    `new ${after.record.prompts.length}, old ${before.record.prompts.length}`);
  before.kill();
  after.kill();
}

/** A broker that keeps losing the row between the register and the poll. */
async function againBackoffSection(): Promise<void> {
  const temp = tempRoot('cmls-again-');
  onCleanup(temp.remove);
  let evict = true;
  // A row evicted the moment it is accepted: every poll after it answers `no_registration`.
  const broker = await socketBroker(temp.root, {
    onRegister: (sessionId) => {
      if (evict) queueMicrotask(() => broker.registry.deregister(sessionId));
    },
  });
  onCleanup(broker.close);
  const sessionId = randomUUID();
  const mod = await loadMod('again', { env: { COSYNCING_CLAUDE_SOCK: broker.socketPath, HOME: temp.root }, sessionId });
  onCleanup(mod.kill);
  tune(mod, { pollWaitMs: 300 });
  await startTerminal(mod);
  await until(() => false, 1500);
  const registers = mod.record.requests.filter((r) => r.route === 'register').length;
  check('MB11: a broker that keeps dropping the row is backed off from, not spun on', registers <= 15,
    `${registers} registrations and ${mod.record.fetches} requests in 1.5 s`);
  evict = false;
  check('MB11: and once the row stays, the loop is back', await until(() => broker.registry.get(sessionId) !== undefined, 3000));
  mod.kill();
}

/** `$.clock.after` refused once must not leave the loop marked as running for good. */
async function clockGuardSection(): Promise<void> {
  const temp = tempRoot('cmls-clock-');
  onCleanup(temp.remove);
  let broker = await socketBroker(temp.root);
  onCleanup(() => broker.close());
  const sessionId = randomUUID();
  let refuse = false;
  const mod = await loadMod('clock', {
    env: { COSYNCING_CLAUDE_SOCK: broker.socketPath, HOME: temp.root },
    sessionId,
    clockThrows: () => refuse,
  });
  onCleanup(mod.kill);
  tune(mod, { pollWaitMs: 300 });
  await startTerminal(mod);
  await until(() => broker.registry.get(sessionId) !== undefined);
  // The broker goes away and the host refuses the timer the loop parks on.
  refuse = true;
  broker.close();
  const failedAt = mod.record.fetches;
  await until(() => mod.record.fetches > failedAt + 1, 3000);
  await until(() => false, 300);
  refuse = false;
  broker = await socketBroker(temp.root);
  const registrationsBefore = broker.registered.length;
  // The next hook is the only thing that can notice the loop is gone.
  await mod.fire('turn.start', { turnId: 'after-refused-timer' });
  check('MB11: a refused $.clock.after does not leave the loop dead: the next hook revives it',
    await until(() => broker.registered.length > registrationsBefore, 3000),
    `${broker.registered.length - registrationsBefore} registrations after the revive`);
  mod.kill();
}

/** session.end, then the process carries on exiting with the same id still readable. */
async function sessionEndSection(): Promise<void> {
  const temp = tempRoot('cmls-end-');
  onCleanup(temp.remove);
  const broker = await socketBroker(temp.root);
  onCleanup(broker.close);
  const sessionId = randomUUID();
  const mod = await loadMod('end', { env: { COSYNCING_CLAUDE_SOCK: broker.socketPath, HOME: temp.root }, sessionId });
  onCleanup(mod.kill);
  tune(mod, { pollWaitMs: 300 });
  await startTerminal(mod);
  await until(() => broker.registry.get(sessionId) !== undefined);
  const mark = mod.record.requests.length;
  await mod.fire('session.end', { reason: 'prompt_input_exit' });
  await until(() => false, 1200);
  const registersAfterEnd = mod.requestsSince(mark, 'register');
  check('MB11: an ended session is never registered again', registersAfterEnd.length === 0 && broker.registry.get(sessionId) === undefined,
    `${registersAfterEnd.length} registrations after session.end; row ${broker.registry.get(sessionId) ? 'present' : 'absent'}`);
  // `/clear` ends one id and the loop carries on with the next one.
  const cleared = randomUUID();
  mod.setSessionId(cleared);
  check('MB11: after /clear the loop registers the new id', await until(() => broker.registry.get(cleared) !== undefined, 3000));
  check('MB11: and still not the ended one', broker.registry.get(sessionId) === undefined);
  mod.kill();
}

/** A command delivered twice runs once. The broker's queue does not dedupe, so the mod does. */
async function commandDedupeSection(): Promise<void> {
  const temp = tempRoot('cmls-dedupe-');
  onCleanup(temp.remove);
  const broker = await socketBroker(temp.root);
  onCleanup(broker.close);
  const sessionId = randomUUID();
  const mod = await loadMod('dedupe', { env: { COSYNCING_CLAUDE_SOCK: broker.socketPath, HOME: temp.root }, sessionId });
  onCleanup(mod.kill);
  tune(mod, { pollWaitMs: 300 });
  await startTerminal(mod);
  await until(() => broker.registry.get(sessionId) !== undefined);
  broker.server.enqueue(sessionId, { requestId: 'twice', op: 'prompt', text: 'only once please', queuedAt: Date.now() });
  broker.server.enqueue(sessionId, { requestId: 'twice', op: 'prompt', text: 'only once please', queuedAt: Date.now() });
  broker.server.enqueue(sessionId, { requestId: 'other', op: 'prompt', text: 'a different one', queuedAt: Date.now() });
  await until(() => mod.record.prompts.some((p) => p.text === 'a different one'));
  await until(() => false, 300);
  const runs = mod.record.prompts.filter((p) => p.text === 'only once please').length;
  check('MB11: a command delivered twice under one requestId runs once', runs === 1, `${runs} runs`);
  mod.kill();
}

// ── MB1: a terminal refused as session_claimed takes over once the claimant is gone ─────────────
const FIXTURE = new URL('./claude-mod-terminal-fixture.ts', import.meta.url).pathname;
const spawned = new Set<ReturnType<typeof Bun.spawn>>();
onCleanup(() => {
  for (const child of spawned) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

/** A claimant terminal in a process of its own, so it can really be killed or stopped. */
async function claimantTerminal(socketPath: string, sessionId: string, home: string, timing: Record<string, unknown>, ask?: string) {
  const child = Bun.spawn(['bun', 'run', FIXTURE], {
    env: {
      ...process.env,
      FIXTURE_SOCKET: socketPath,
      FIXTURE_SESSION: sessionId,
      FIXTURE_HOME: home,
      FIXTURE_TIMING: JSON.stringify(timing),
      ...(ask ? { FIXTURE_ASK: ask } : {}),
    },
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'inherit',
  });
  spawned.add(child);
  return child;
}

async function claimSection(): Promise<void> {
  const temp = tempRoot('cmls-claim-');
  onCleanup(temp.remove);
  // The claimant is this suite's own child, and the broker here is this suite, so the
  // broker-descendant rule is the one check turned off; the claim and every peer check are live.
  const broker = await socketBroker(temp.root, { isBrokerChild: () => false, staleAfterMs: 1500 });
  onCleanup(broker.close);
  const timing = { backoffMs: [200, 400, 800], pollWaitMs: 300 };

  for (const ending of ['kill -9', 'stopped'] as const) {
    const sessionId = randomUUID();
    const claimant = await claimantTerminal(broker.socketPath, sessionId, temp.root, timing);
    const claimed = await until(() => broker.registry.get(sessionId)?.peerPid === claimant.pid, 8000);
    check(`MB1 (${ending}): the first terminal claims the session`, claimed, JSON.stringify(broker.registered));

    const second = await loadMod(`second-${ending}`, { env: { COSYNCING_CLAUDE_SOCK: broker.socketPath, HOME: temp.root }, sessionId });
    onCleanup(second.kill);
    tune(second, timing);
    await startTerminal(second);
    await until(() => false, 1500);
    const refusedRegisters = broker.refusals.filter((r) => r.route === 'register' && r.code === 'session_claimed').length;
    check(`MB1 (${ending}): while the claimant is alive the second terminal is refused and keeps asking`,
      refusedRegisters >= 2 && broker.registry.get(sessionId)?.peerPid === claimant.pid,
      `${refusedRegisters} session_claimed refusals; row pid ${String(broker.registry.get(sessionId)?.peerPid)}`);
    const acceptedBefore = broker.accepted.length;
    const asked = await second.fire('tool.check', { tool: 'Bash', tool_use_id: `tu-observe-${ending}`, input: { command: 'ls' } }) as { decision?: string };
    const drawn = await second.renderNow() as { engineDrew?: boolean };
    check(`MB1 (${ending}): and stays Observe: it holds nothing, polls nothing, draws nothing`,
      asked?.decision === 'ask' && broker.accepted.length === acceptedBefore && drawn?.engineDrew === true
        && !second.record.requests.some((r) => r.route === 'poll' || r.route === 'hold'),
      `decision ${String(asked?.decision)}; routes ${[...new Set(second.record.requests.map((r) => r.route))].join(',')}`);

    const endedAt = Date.now();
    if (ending === 'kill -9') {
      // No session.end, no goodbye: the process is simply gone.
      claimant.kill('SIGKILL');
      await claimant.exited;
    } else {
      // Alive, but its poll chain stops: a hung terminal. The claim lapses on staleness.
      claimant.kill('SIGSTOP');
    }
    const tookOver = await until(() => broker.registry.get(sessionId)?.peerPid === process.pid, 30_000);
    check(`MB1 (${ending}): the second terminal takes the session over within 30 s`, tookOver,
      `${tookOver ? Date.now() - endedAt : 'never'} ms after the claimant ${ending === 'kill -9' ? 'died' : 'stopped polling'}`);
    // The broker's row moves before the mod has read the reply; its first poll is the mod's own
    // word that it knows it is registered (a refused terminal never polls).
    await until(() => second.record.requests.some((r) => r.route === 'poll'), 3000);
    const held = second.fire('tool.check', { tool: 'Bash', tool_use_id: `tu-live-${ending.replace(/[^A-Za-z0-9]+/g, '-')}`, input: { command: 'pwd' } });
    const open = await until(() => broker.holds.openHolds().some((h) => h.sessionId === sessionId), 3000);
    const holdId = broker.holds.openHolds().find((h) => h.sessionId === sessionId)?.requestId ?? '';
    broker.server.answer(sessionId, holdId, 'allow', 'app');
    const answered = await held as { decision?: string };
    check(`MB1 (${ending}): and it is live: its next ask is held and answered`, open && answered?.decision === 'allow',
      JSON.stringify({ open, answered }));
    if (ending === 'stopped') {
      claimant.kill('SIGKILL');
      await claimant.exited;
    }
    spawned.delete(claimant);
    second.kill();
  }
}

/** The real service's sweep point evicts a row whose process died, and says so once. */
async function deadRowEvictionSection(): Promise<void> {
  const temp = tempRoot('cmls-evict-');
  onCleanup(temp.remove);
  const events: { sessionId: string; kind: string }[] = [];
  // The app has the session open, so its terminal closing is worth telling the person (R4-7).
  const viewer = { ingestRequest: () => {}, respondPermission: () => {} };
  const service = new ClaudeModService({
    socketPath: join(temp.root, 'claude-mod.sock'),
    hub: () => ({ clientCount: 1, conn: viewer }),
    transcriptPath: () => undefined,
    killSwitch: () => false,
    isBrokerChild: () => false,
    onEvent: (event) => events.push({ sessionId: event.sessionId, kind: event.kind }),
    log: { warn: () => {} },
    // This section is about the status read itself, so the timer is kept out of its way.
    sweepIntervalMs: 3_600_000,
  });
  await service.start();
  onCleanup(() => service.close());
  const sessionId = randomUUID();
  const claimant = await claimantTerminal(service.socketPath, sessionId, temp.root, { backoffMs: [200, 400, 800], pollWaitMs: 300 });
  check('MB1: the service sees the terminal', await until(() => service.status(sessionId).present, 8000));
  claimant.kill('SIGKILL');
  await claimant.exited;
  spawned.delete(claimant);
  const first = service.status(sessionId);
  check('MB1: the read after a kill -9 reports the dead pid', first.present && !first.pidAlive && first.state === 'observe', JSON.stringify(first.reasons));
  const second = service.status(sessionId);
  check('MB1: and the dead row is evicted, not kept until a session.end that never comes',
    !second.present && service.registrationFor(sessionId) === undefined, JSON.stringify({ present: second.present }));
  check('MB1: the person is told once that the terminal closed',
    events.filter((event) => event.sessionId === sessionId && event.kind === 'attention.pid-dead').length === 1, JSON.stringify(events));
  service.close();
}

// ── BH7/BH9: a killed terminal is reported, and cleared away, with nobody looking ───────────────
async function sweepSection(): Promise<void> {
  const temp = tempRoot('cmls-sweep-');
  onCleanup(temp.remove);
  const transcriptIn = (name: string, mode: string): string => {
    const path = join(temp.root, `${name}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: 'permission-mode', permissionMode: mode })}\n`);
    return path;
  };
  // One terminal whose call is held for the app, and one whose call fell through to the terminal
  // and is explained by a read-only card.
  const heldSession = randomUUID();
  const releasedSession = randomUUID();
  const transcripts: Record<string, string> = {
    [heldSession]: transcriptIn('held', 'default'),
    // Bypass mode: a released call there still draws a read-only card (auto mode draws none).
    [releasedSession]: transcriptIn('released', 'bypassPermissions'),
  };
  const drawn: { requestId: string; readOnly?: boolean }[] = [];
  const closed: { requestId: string; decision: string; releaseReason?: string }[] = [];
  const conn = {
    ingestRequest: (request: { requestId: string; readOnly?: boolean }) => drawn.push({ requestId: request.requestId, readOnly: request.readOnly }),
    respondPermission: (requestId: string, decision: string, info?: { releaseReason?: string }) => {
      closed.push({ requestId, decision, ...(info?.releaseReason ? { releaseReason: info.releaseReason } : {}) });
    },
  };
  const events: { sessionId: string; kind: string }[] = [];
  const service = new ClaudeModService({
    socketPath: join(temp.root, 'claude-mod.sock'),
    hub: () => ({ clientCount: 1, conn }),
    transcriptPath: (sessionId) => transcripts[sessionId],
    killSwitch: () => false,
    isBrokerChild: () => false,
    onEvent: (event) => events.push({ sessionId: event.sessionId, kind: event.kind }),
    log: { warn: () => {} },
    sweepIntervalMs: 100,
  });
  await service.start();
  onCleanup(() => service.close());
  const timing = { backoffMs: [200, 400, 800], pollWaitMs: 300 };
  // A terminal that says goodbye properly: its row goes at once, and its lookup must follow.
  const endedSession = randomUUID();
  const ending = await loadMod('sweep-ended', { env: { COSYNCING_CLAUDE_SOCK: service.socketPath, HOME: temp.root }, sessionId: endedSession });
  onCleanup(ending.kill);
  tune(ending, { pollWaitMs: 300 });
  await startTerminal(ending);
  await until(() => service.registrationFor(endedSession) !== undefined, 5000);
  await ending.fire('session.end', { reason: 'prompt_input_exit' });
  const internalsEarly = service as unknown as { registrations: Map<string, unknown> };
  check('BH9: an ended terminal\'s registration is dropped without anybody asking for it',
    await until(() => !internalsEarly.registrations.has(endedSession), 3000), [...internalsEarly.registrations.keys()].join());
  // Killed only once the row is gone. The mod queues the `session.end` event and returns, and
  // `kill()` aborts every fetch still open, so a kill straight after the hook lost the event under
  // load. A real exit is then covered by the pid watch, but this terminal's peer pid is the test
  // process, which never dies, so here the event is the only thing that can drop the row.
  ending.kill();
  const held = await claimantTerminal(service.socketPath, heldSession, temp.root, timing, 'make deploy');
  const released = await claimantTerminal(service.socketPath, releasedSession, temp.root, timing, 'make clean');
  check('BH7: the held call drew a live card', await until(() => drawn.some((card) => card.readOnly !== true), 8000), JSON.stringify(drawn));
  check('BH7: and the released call a read-only one', await until(() => drawn.some((card) => card.readOnly === true), 8000), JSON.stringify(drawn));
  const heldCard = drawn.find((card) => card.readOnly !== true)!.requestId;
  const releasedCard = drawn.find((card) => card.readOnly === true)!.requestId;
  const internals = service as unknown as { registrations: Map<string, unknown>; released: Map<string, unknown> };
  check('BH9: both registrations and the explanation card are on record', internals.registrations.size === 2 && internals.released.size === 1,
    `${internals.registrations.size} registrations, ${internals.released.size} released`);

  // From here nothing reads `status()`: no roster, no adapter, no app. Only the sweep is running.
  for (const child of [held, released]) {
    child.kill('SIGKILL');
    await child.exited;
    spawned.delete(child);
  }
  const deadEvents = () => events.filter((event) => event.kind === 'attention.pid-dead').map((event) => event.sessionId);
  check('BH7: each killed terminal is reported, with no app and no status read',
    await until(() => deadEvents().includes(heldSession) && deadEvents().includes(releasedSession), 3000), JSON.stringify(events));
  check('BH7: once each', deadEvents().length === 2, JSON.stringify(deadEvents()));
  check('BH7: the held card closes with its terminal', await until(() => closed.some((entry) => entry.requestId === heldCard), 3000),
    JSON.stringify(closed));
  check('BH9: the read-only card is retired with its terminal, keeping its reason',
    await until(() => closed.some((entry) => entry.requestId === releasedCard && entry.releaseReason === 'mode:bypassPermissions'), 3000), JSON.stringify(closed));
  check('BH9: and nothing is left on record for either terminal',
    await until(() => internals.registrations.size === 0 && internals.released.size === 0, 3000),
    `${internals.registrations.size} registrations, ${internals.released.size} released`);
  check('BH9: no open hold is left behind', service.status(heldSession).present === false && !service.isHeld(heldSession, heldCard));
  service.close();
}

// ── MB8: the running turn survives a re-registration ─────────────────────────────────────────
async function turnStateSection(): Promise<void> {
  const temp = tempRoot('cmls-turn-');
  onCleanup(temp.remove);
  let broker = await socketBroker(temp.root);
  onCleanup(() => broker.close());
  const env = { COSYNCING_CLAUDE_SOCK: broker.socketPath, HOME: temp.root };

  // A broker restart in the middle of a turn: the new broker knows nothing until the mod says so.
  const sessionId = randomUUID();
  const mod = await loadMod('turn-restart', { env, sessionId });
  onCleanup(mod.kill);
  tune(mod, { pollWaitMs: 300 });
  await startTerminal(mod);
  await until(() => broker.registry.get(sessionId) !== undefined);
  await mod.fire('turn.start', { turnId: 'turn-across-restart' });
  await until(() => broker.registry.currentTurn(sessionId) === 'turn-across-restart');
  broker.close();
  broker = await socketBroker(temp.root);
  check('MB8: the mod re-registers with the restarted broker', await until(() => broker.registry.get(sessionId) !== undefined, 5000));
  check('MB8: the re-registration carries the turn that is still running', broker.registry.currentTurn(sessionId) === 'turn-across-restart',
    JSON.stringify(broker.registry.currentTurn(sessionId)));
  const stop = broker.server.enqueue(sessionId, { requestId: 'stop-after-restart', op: 'abort', queuedAt: Date.now() });
  check('MB8: so a Stop from the app after the restart is not refused as no_active_turn', stop.ok === true, JSON.stringify(stop));
  check('MB8: and it stops the turn the terminal is running', await until(() => mod.record.aborts.some((a) => a.turnId === 'turn-across-restart')),
    JSON.stringify(mod.record.aborts));
  await mod.fire('turn.complete', { turnId: 'turn-across-restart' });
  mod.kill();

  // A hot reload with no session.start: the reloaded module's first hook is a turn.start.
  const reloadedId = randomUUID();
  const reloaded = await loadMod('turn-reload', { env: { COSYNCING_CLAUDE_SOCK: broker.socketPath, HOME: temp.root }, sessionId: reloadedId });
  onCleanup(reloaded.kill);
  tune(reloaded, { pollWaitMs: 300 });
  await reloaded.fire('turn.start', { turnId: 'turn-after-reload' });
  await until(() => broker.registry.get(reloadedId) !== undefined, 3000);
  check('MB8: after a reload the first turn.start reaches the broker', await until(() => broker.registry.currentTurn(reloadedId) === 'turn-after-reload', 2000),
    JSON.stringify(broker.registry.currentTurn(reloadedId)));
  const reloadStop = broker.server.enqueue(reloadedId, { requestId: 'stop-after-reload', op: 'abort', queuedAt: Date.now() });
  check('MB8: and Stop works on that turn', reloadStop.ok === true && await until(() => reloaded.record.aborts.some((a) => a.turnId === 'turn-after-reload')),
    JSON.stringify({ reloadStop, aborts: reloaded.record.aborts }));
  reloaded.kill();

  // R4-11: a hot reload in the middle of a turn. No turn.start comes to the reloaded module; the
  // turn's next model request does, as a `turn.step` carrying the running turn's id.
  const midEnv = { COSYNCING_CLAUDE_SOCK: broker.socketPath, HOME: temp.root };
  const STEP = JSON.stringify({ chunks: [{ type: 'text', index: 0, text: 'working' }], result: { stopReason: 'tool_use' } });
  const midId = randomUUID();
  const old = await loadMod('mid-turn-old', { env: midEnv, sessionId: midId });
  onCleanup(old.kill);
  tune(old, { pollWaitMs: 300 });
  await startTerminal(old);
  await until(() => broker.registry.get(midId) !== undefined);
  await old.fire('turn.start', { turnId: 'turn-mid-reload' });
  await until(() => broker.registry.currentTurn(midId) === 'turn-mid-reload');
  old.reloadAway();
  const fresh = await loadMod('mid-turn-new', { env: midEnv, sessionId: midId });
  onCleanup(fresh.kill);
  tune(fresh, { pollWaitMs: 300 });
  const generation = broker.registry.generation(midId);
  // The first hook a reloaded module can see, as in the hot-reload section: it registers again.
  await fresh.fire('session.attach', { surface: 'mobile', clientId: 'app-1' });
  await until(() => broker.registry.generation(midId) > generation, 3000);
  // A subagent's step first: its turn id is not the one a Stop is aimed at.
  const sub = await fresh.fireIfHooked('turn.step', { turnId: 'turn-of-a-subagent', index: 0, model: 'haiku', messageCount: 2, agentId: 'agent-1' });
  await until(() => false, 300);
  check('R4-11 seam: a subagent\'s step is passed through untouched, and its turn is not taken for the session\'s',
    broker.registry.currentTurn(midId) !== 'turn-of-a-subagent' && JSON.stringify(sub) === STEP,
    JSON.stringify({ sub, turn: broker.registry.currentTurn(midId) }));
  const stepped = await fresh.fireIfHooked('turn.step', { turnId: 'turn-mid-reload', index: 1, model: 'haiku', messageCount: 4 });
  check('R4-11 seam: the main loop\'s step is passed through untouched', JSON.stringify(stepped) === STEP,
    JSON.stringify(stepped));
  check('R4-11 seam: after a reload mid-turn, the broker learns the running turn from its next model request',
    await until(() => broker.registry.currentTurn(midId) === 'turn-mid-reload', 2000), JSON.stringify(broker.registry.currentTurn(midId)));
  const midStop = broker.server.enqueue(midId, { requestId: 'stop-mid-reload', op: 'abort', queuedAt: Date.now() });
  check('R4-11 seam: so a Stop from the app in the same turn is not refused as no_active_turn', midStop.ok === true, JSON.stringify(midStop));
  check('R4-11 seam: and it stops that turn', await until(() => fresh.record.aborts.some((a) => a.turnId === 'turn-mid-reload')),
    JSON.stringify(fresh.record.aborts));
  const startsSent = () => fresh.record.requests.filter((r) => r.route === 'event' && r.body.kind === 'turn.start').length;
  const reportedStarts = startsSent();
  await fresh.fireIfHooked('turn.step', { turnId: 'turn-mid-reload', index: 2, model: 'haiku', messageCount: 6 });
  await until(() => false, 300);
  check('R4-11 seam: a step of a turn the module already knows says nothing more to the broker', startsSent() === reportedStarts,
    `${reportedStarts} turn.start events before, ${startsSent()} after`);
  fresh.kill();

  // The same reload where the first hook the new module sees is the model request itself.
  const firstId = randomUUID();
  const older = await loadMod('step-first-old', { env: midEnv, sessionId: firstId });
  onCleanup(older.kill);
  tune(older, { pollWaitMs: 300 });
  await startTerminal(older);
  await until(() => broker.registry.get(firstId) !== undefined);
  await older.fire('turn.start', { turnId: 'turn-step-first' });
  await until(() => broker.registry.currentTurn(firstId) === 'turn-step-first');
  older.reloadAway();
  const newer = await loadMod('step-first-new', { env: midEnv, sessionId: firstId });
  onCleanup(newer.kill);
  tune(newer, { pollWaitMs: 300 });
  const firstGeneration = broker.registry.generation(firstId);
  await newer.fireIfHooked('turn.step', { turnId: 'turn-step-first', index: 1, model: 'haiku', messageCount: 4 });
  check('R4-11 seam: a reloaded module whose first hook is a model request registers again, carrying that turn',
    await until(() => broker.registry.generation(firstId) > firstGeneration && broker.registry.currentTurn(firstId) === 'turn-step-first', 3000),
    JSON.stringify({ generation: [firstGeneration, broker.registry.generation(firstId)], turn: broker.registry.currentTurn(firstId) }));
  const firstStop = broker.server.enqueue(firstId, { requestId: 'stop-step-first', op: 'abort', queuedAt: Date.now() });
  check('R4-11 seam: and a Stop from the app stops it', firstStop.ok === true && await until(() => newer.record.aborts.some((a) => a.turnId === 'turn-step-first')),
    JSON.stringify({ firstStop, aborts: newer.record.aborts }));
  newer.kill();
}

// ── steer fallback (MB9) ───────────────────────────────────────────────────────────────────────
/**
 * A steer is an in-turn append, and the only route that may become one. The broker decides
 * "steer" from the turn it last heard about, which can end before the command reaches the mod;
 * an append into a turn that has finished is stored and never starts one, so the words sit in
 * the transcript unanswered while the app shows them as sent.
 */
async function steerFallbackSection(): Promise<void> {
  const temp = tempRoot('cmls-steer-');
  onCleanup(temp.remove);
  const broker = await socketBroker(temp.root);
  onCleanup(broker.close);
  let deny = false;
  const run = async (label: string, extraEnv: Record<string, string>, body: (mod: ModInstance, sessionId: string) => Promise<void>) => {
    const sessionId = randomUUID();
    const mod = await loadMod(`steer-${label}`, {
      env: { COSYNCING_CLAUDE_SOCK: broker.socketPath, HOME: temp.root, ...extraEnv },
      sessionId,
      appendResult: () => (deny ? { deny: 'a plugin above said no' } : { uuid: 'stored-row' }),
    });
    onCleanup(mod.kill);
    tune(mod, { pollWaitMs: 300 });
    await startTerminal(mod);
    await until(() => broker.registry.get(sessionId) !== undefined);
    await body(mod, sessionId);
    mod.kill();
  };
  const steer = (sessionId: string, requestId: string, text: string) =>
    broker.server.enqueue(sessionId, { requestId, op: 'steer', text, queuedAt: Date.now() });

  await run('after-turn', {}, async (mod, sessionId) => {
    await mod.fire('turn.start', { turnId: 'steer-t1' });
    await mod.fire('turn.complete', { turnId: 'steer-t1' });
    steer(sessionId, 'late-steer', 'the turn already ended');
    await until(() => mod.record.prompts.length + mod.record.appends.length > 0);
    check('steer fallback: a steer that arrives after the turn ended starts a turn instead of appending into nothing',
      mod.record.prompts.some((p) => p.text === 'the turn already ended' && p.asUser === true) && mod.record.appends.length === 0,
      `prompts ${mod.record.prompts.length}, appends ${mod.record.appends.length}`);
  });
  await run('mid-turn', {}, async (mod, sessionId) => {
    await mod.fire('turn.start', { turnId: 'steer-t2' });
    steer(sessionId, 'mid-steer', 'use the other approach');
    await until(() => mod.record.prompts.length + mod.record.appends.length > 0);
    check('steer fallback: mid-turn, a steer is an in-turn append', mod.record.appends.length === 1 && mod.record.prompts.length === 0,
      `prompts ${mod.record.prompts.length}, appends ${mod.record.appends.length}`);
    await mod.fire('turn.complete', { turnId: 'steer-t2' });
  });
  await run('refused', {}, async (mod, sessionId) => {
    deny = true;
    await mod.fire('turn.start', { turnId: 'steer-t3' });
    steer(sessionId, 'refused-steer', 'refused but not lost');
    await until(() => mod.record.prompts.length > 0);
    check('steer fallback: an append a plugin refuses is submitted as a prompt, not lost',
      mod.record.appends.length === 1 && mod.record.prompts.some((p) => p.text === 'refused but not lost'),
      `prompts ${mod.record.prompts.length}, appends ${mod.record.appends.length}`);
    deny = false;
    await mod.fire('turn.complete', { turnId: 'steer-t3' });
  });
  await run('switched-off', { COSYNCING_CLAUDE_STEER: '0' }, async (mod, sessionId) => {
    await mod.fire('turn.start', { turnId: 'steer-t4' });
    steer(sessionId, 'off-steer', 'steering is off here');
    await until(() => mod.record.prompts.length > 0);
    check('steer fallback: with COSYNCING_CLAUDE_STEER=0 a steer is queued as a prompt',
      mod.record.appends.length === 0 && mod.record.prompts.some((p) => p.text === 'steering is off here'),
      `prompts ${mod.record.prompts.length}, appends ${mod.record.appends.length}`);
    await mod.fire('turn.complete', { turnId: 'steer-t4' });
  });
}

// ── MB4: a broker that accepts and never answers ─────────────────────────────────────────────
/** A listener on the broker's socket path that accepts every connection and never writes. */
function blackHole(path: string): { close(): void; connections: number } {
  const open = new Set<{ end(): void }>();
  const state = { connections: 0 };
  const listener = Bun.listen({
    unix: path,
    socket: {
      open: (socket) => {
        state.connections += 1;
        open.add(socket);
      },
      data: () => {},
      close: (socket) => {
        open.delete(socket);
      },
    },
  });
  return {
    get connections() {
      return state.connections;
    },
    close: () => {
      for (const socket of open) {
        try {
          socket.end();
        } catch {
          /* closing */
        }
      }
      listener.stop(true);
    },
  };
}

/** Run a hook, but stop waiting for it after `ms`: the measurement is when `next(e)` ran. */
async function timed(mod: ModInstance, event: string, e: Record<string, unknown>, ms: number) {
  const startedAt = Date.now();
  let returnedAt: number | undefined;
  let result: unknown;
  const running = mod.fire(event, e).then((value) => {
    returnedAt = Date.now();
    result = value;
  });
  await Promise.race([running, until(() => false, ms)]);
  const nextAt = mod.nextAt(event);
  return {
    nextDelay: nextAt !== undefined && nextAt >= startedAt ? nextAt - startedAt : undefined,
    returned: returnedAt === undefined ? undefined : returnedAt - startedAt,
    result,
  };
}

async function unresponsiveBrokerSection(): Promise<void> {
  const temp = tempRoot('cmls-hole-');
  onCleanup(temp.remove);
  const broker = await socketBroker(temp.root);
  const sessionId = randomUUID();
  const mod = await loadMod('black-hole', { env: { COSYNCING_CLAUDE_SOCK: broker.socketPath, HOME: temp.root }, sessionId });
  onCleanup(mod.kill);
  // Scaled down: the bound on each request of a held call, the ack's, an event's, and the poll's
  // wait. A hold itself has no bound: what ends one on a broker that stopped answering is the
  // request that does not come back.
  const bound = { holdPollMs: 1500, ackMs: 400, eventMs: 400, pollWaitMs: 300 };
  tune(mod, bound);
  await startTerminal(mod);
  await until(() => broker.registry.get(sessionId) !== undefined);
  await until(() => mod.record.requests.some((r) => r.route === 'poll'));
  // The broker is replaced by a process that accepts and never answers.
  broker.close();
  const hole = blackHole(broker.socketPath);
  onCleanup(hole.close);

  const turnStart = await timed(mod, 'turn.start', { turnId: 'hole-turn' }, 3000);
  check('MB4: turn.start does not wait on the broker: next(e) runs at once',
    turnStart.nextDelay !== undefined && turnStart.nextDelay < 150, JSON.stringify(turnStart));
  const checked = await timed(mod, 'tool.check', { tool: 'Bash', tool_use_id: 'tu-hole', input: { command: 'ls' } }, bound.holdPollMs + 3000);
  check('MB4: a held call against a broker that never answers returns the engine\'s ask',
    (checked.result as { decision?: string } | undefined)?.decision === 'ask', JSON.stringify(checked));
  check('MB4: within the ack\'s bound', checked.returned !== undefined && checked.returned <= bound.ackMs + 500,
    `${String(checked.returned)} ms against a ${bound.ackMs} ms bound`);
  check('MB4: and no band was drawn for it', mod.record.bands.length === 0, JSON.stringify(mod.record.bands.map((b) => b.label)));
  // The ack has its own short bound, and a held call's long request bound is not it: an ask nobody
  // acknowledges is not a call anybody is waiting on yet.
  tune(mod, { holdPollMs: 60_000, ackMs: 700 });
  const capped = await timed(mod, 'tool.check', { tool: 'Bash', tool_use_id: 'tu-hole-2', input: { command: 'ls' } }, 4000);
  check('MB4: an unacknowledged ask ends on the ack bound: a long request bound does not stretch it',
    (capped.result as { decision?: string } | undefined)?.decision === 'ask' && capped.returned !== undefined && capped.returned <= 700 + 400,
    JSON.stringify(capped));
  tune(mod, bound);
  const turnComplete = await timed(mod, 'turn.complete', { turnId: 'hole-turn' }, 3000);
  check('MB4: turn.complete does not wait on the broker either', turnComplete.nextDelay !== undefined && turnComplete.nextDelay < 150,
    JSON.stringify(turnComplete));
  const ended = await timed(mod, 'session.end', { reason: 'other' }, 3000);
  check('MB4: nor does session.end', ended.nextDelay !== undefined && ended.nextDelay < 150, JSON.stringify(ended));
  check('MB4: the broker really was dialled and really never answered', hole.connections > 0, `${hole.connections} connections`);
  mod.kill();
  hole.close();

  // The other half: a broker that takes the call, says so, and then never answers again. The band
  // goes up on the ack, and the hold ends on the first request that does not come back, with the
  // engine's own ask.
  const temp2 = tempRoot('cmls-held-');
  onCleanup(temp2.remove);
  const quiet = await socketBroker(temp2.root, { holdPollWaitMs: 20_000 });
  onCleanup(() => quiet.close());
  const heldSession = randomUUID();
  const held = await loadMod('acked-then-silent', { env: { COSYNCING_CLAUDE_SOCK: quiet.socketPath, HOME: temp2.root }, sessionId: heldSession });
  onCleanup(held.kill);
  tune(held, { ...bound, holdPollMs: 1200 });
  await startTerminal(held);
  await until(() => quiet.registry.get(heldSession) !== undefined);
  await until(() => held.record.requests.some((r) => r.route === 'poll'));
  const parked = await timed(held, 'tool.check', { tool: 'Bash', tool_use_id: 'tu-held', input: { command: 'make' } }, 5000);
  check('MB4: a hold the broker acked and then never answered ends on its request bound with the engine\'s ask',
    (parked.result as { decision?: string } | undefined)?.decision === 'ask' && parked.returned !== undefined && parked.returned <= 1200 + 500,
    JSON.stringify(parked));
  check('MB4: the broker did hold it (the band went up on the ack)', quiet.accepted.length === 1 && held.record.bands.some((b) => b.label === 'Allow'),
    `${quiet.accepted.length} accepted, bands ${JSON.stringify(held.record.bands.map((b) => b.label))}`);
  held.kill();
  quiet.close();

  // LH6: a broker that answers a held call's long-poll at once, with nothing in it, every time. The
  // hold has no deadline and the hook's own clock stops while a request is out, so nothing else
  // would stop this hook asking it again for as long as the person took.
  const temp3 = tempRoot('cmls-spin-');
  onCleanup(temp3.remove);
  const eager = await socketBroker(temp3.root, { holdPollWaitMs: 1 });
  onCleanup(() => eager.close());
  const eagerSession = randomUUID();
  const spun = await loadMod('answers-at-once', { env: { COSYNCING_CLAUDE_SOCK: eager.socketPath, HOME: temp3.root }, sessionId: eagerSession });
  onCleanup(spun.kill);
  tune(spun, { ...bound, holdPollMs: 60_000 });
  await startTerminal(spun);
  await until(() => eager.registry.get(eagerSession) !== undefined);
  const holdsBefore = spun.record.requests.filter((r) => r.route === 'hold').length;
  const spinning = await timed(spun, 'tool.check', { tool: 'Bash', tool_use_id: 'tu-spin', input: { command: 'make' } }, 5000);
  const holdRequests = spun.record.requests.filter((r) => r.route === 'hold').length - holdsBefore;
  check('LH6 seam: a broker that answers a held call at once with nothing gets the call handed back, not a spin',
    (spinning.result as { decision?: string } | undefined)?.decision === 'ask' && spinning.returned !== undefined && spinning.returned < 2000,
    JSON.stringify(spinning));
  check('LH6 seam: after the ack and three such answers', holdRequests === 4, `${holdRequests} hold requests`);
  spun.kill();
  eager.close();
}

// ── MB4, the ordering it costs: an event on its way is not overtaken by a registration ──────
async function endThenStartSection(): Promise<void> {
  const temp = tempRoot('cmls-order-');
  onCleanup(temp.remove);
  const order: string[] = [];
  const broker = await socketBroker(temp.root, {
    onRegister: () => order.push(broker.events.some((e) => e.kind === 'session.end') ? 'register after end' : 'register'),
  });
  onCleanup(broker.close);
  const sessionId = randomUUID();
  let releaseEnd!: () => void;
  const endHeld = new Promise<void>((resolve) => {
    releaseEnd = resolve;
  });
  onCleanup(() => releaseEnd());
  let stalled = false;
  const mod = await loadMod('end-then-start', {
    env: { COSYNCING_CLAUDE_SOCK: broker.socketPath, HOME: temp.root },
    sessionId,
    // The session.end report is slow to leave, the way one is behind a busy broker.
    beforeFetch: async (request) => {
      if (!stalled && request.route === 'event' && request.body.kind === 'session.end') {
        stalled = true;
        await endHeld;
      }
    },
  });
  onCleanup(mod.kill);
  tune(mod);
  await startTerminal(mod);
  await until(() => broker.registry.get(sessionId) !== undefined);
  await until(() => mod.record.requests.some((r) => r.route === 'poll'));
  order.length = 0;
  // The same session ends and starts again in this process, as `/resume` of itself does.
  await mod.fire('session.end', { reason: 'resume' });
  await mod.fire('session.start', { cwd: '/work', surface: 'terminal', isInteractive: true });
  await until(() => false, 400);
  releaseEnd();
  await until(() => order.length > 0 && broker.registry.get(sessionId) !== undefined, 3000);
  await until(() => false, 600);
  check('MB4: a session.end still on its way is not overtaken by the same session\'s next registration',
    order[0] === 'register after end' && order.length === 1 && broker.registry.get(sessionId) !== undefined, JSON.stringify(order));
  mod.kill();
  broker.close();
}

try {
  await loggingSection();
  await disableSection();
  await permanentRefusalSection();
  await hotReloadSection();
  await againBackoffSection();
  await clockGuardSection();
  await sessionEndSection();
  await commandDedupeSection();
  await claimSection();
  await deadRowEvictionSection();
  await sweepSection();
  await turnStateSection();
  await steerFallbackSection();
  await unresponsiveBrokerSection();
  await endThenStartSection();
  check('no unhandled rejection escaped the mod', unhandled.length === 0, unhandled.join(' | '));
} catch (error) {
  check('no exception', false, String((error as Error)?.stack ?? error).slice(0, 600));
} finally {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      /* cleanup is best effort */
    }
  }
}
finish();
