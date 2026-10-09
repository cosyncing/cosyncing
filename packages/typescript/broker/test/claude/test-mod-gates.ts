/**
 * The hold gate, exhaustively: the modes we never touch, and the two we do.
 *
 * This is the suite that keeps the product out of the classifier's seat. Measured on 2.1.288, a
 * mod `allow` on an `ask` in auto mode replaces Claude's own classifier answer outright (decision
 * time fell from ~300 ms to ~25 ms and the classifier's log lines vanished), while the same engine
 * refuses a user's own dangerous allow rule for exactly that privilege. The design's answer is not
 * to argue with that but to never be in the room: hold only in `default` and `acceptEdits`, and
 * treat every unknown as "do not hold".
 *
 * The registry half is checked too, because the gate is only half the rule. A headless `-p` run
 * and a hosted (non-terminal) surface register happily and must never hold, since a held `ask`
 * with no dialog behind it parks a turn that nobody can finish.
 *
 *   bun run packages/typescript/broker/test/claude/test-mod-gates.ts   (exit 0 = all pass)
 */
export {};
import { decideModHold } from '../../src/sessions/mod-holds.ts';
import { HOLDABLE_PERMISSION_MODES, HOLDABLE_QUESTION_MODES } from '../../src/sessions/mod-protocol.ts';
import { ModRegistry } from '../../src/sessions/mod-registry.ts';
import type { ModRegisterMessage } from '../../src/sessions/mod-protocol.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const HOLDABLE = ['default', 'acceptEdits', 'plan'];
/** Every mode string the engine can put in a `permission-mode` row, plus the never-hold list. */
const NON_HOLDABLE = ['auto', 'dontAsk', 'bypassPermissions', 'unknown', '', 'something-new-in-a-future-build'];
/** A question is held wherever Claude opens its picker for a person: auto mode included. */
const QUESTION_HOLDABLE = ['default', 'acceptEdits', 'plan', 'auto'];

try {
  check('PM1: the holdable set is default, acceptEdits and plan', JSON.stringify(HOLDABLE_PERMISSION_MODES) === JSON.stringify(HOLDABLE), JSON.stringify(HOLDABLE_PERMISSION_MODES));
  check('PM1: a plan-mode ask is held like a default-mode one', decideModHold({ mode: 'plan', viewers: 1, killSwitch: false }).hold === true);
  // AM1: auto mode answers tool calls with its classifier, which runs after tool.check; a person
  // answers its questions. dontAsk refuses both, measured on 2.1.292.
  check('AM1: the question set adds auto mode and nothing else', JSON.stringify(HOLDABLE_QUESTION_MODES) === JSON.stringify(QUESTION_HOLDABLE), JSON.stringify(HOLDABLE_QUESTION_MODES));
  for (const mode of QUESTION_HOLDABLE) {
    check(`AM1: a question is held in ${mode}`, decideModHold({ mode, viewers: 1, killSwitch: false }, 'question').hold === true);
  }
  check('AM1: an auto-mode permission is still not held', decideModHold({ mode: 'auto', viewers: 1, killSwitch: false }, 'permission').hold === false);
  for (const [mode, why] of [['dontAsk', 'mode:dontAsk'], ['bypassPermissions', 'mode:bypassPermissions'], [undefined, 'mode:unknown']] as const) {
    const decided = decideModHold({ mode, viewers: 1, killSwitch: false }, 'question');
    check(`AM1: a question in ${String(mode)} is left to the terminal as ${why}`, !decided.hold && decided.why === why, JSON.stringify(decided));
  }
  check('AM1: a question still needs a viewer and the switch on',
    decideModHold({ mode: 'auto', viewers: 0, killSwitch: false }, 'question').hold === false
      && decideModHold({ mode: 'auto', viewers: 1, killSwitch: true }, 'question').hold === false);

  // The two modes that may hold, and only with a viewer and the kill switch off.
  for (const mode of HOLDABLE) {
    const held = decideModHold({ mode, viewers: 1, killSwitch: false });
    check(`holds in ${mode} with a viewer`, held.hold === true, JSON.stringify(held));
    check(`does not hold in ${mode} with no viewer`, decideModHold({ mode, viewers: 0, killSwitch: false }).hold === false);
    check(`does not hold in ${mode} with the kill switch on`, decideModHold({ mode, viewers: 3, killSwitch: true }).hold === false);
  }

  // Nothing is held on an unknown, ever, whatever else is true.
  check('never holds when the mode is undefined (no permission-mode row yet)', decideModHold({ mode: undefined, viewers: 5, killSwitch: false }).hold === false);
  const unknown = decideModHold({ mode: undefined, viewers: 5, killSwitch: false });
  check('an unreadable mode releases with mode:unknown', !unknown.hold && unknown.why === 'mode:unknown', JSON.stringify(unknown));

  // Every non-holdable mode names itself on the card. A gate that lumps them together tells a
  // person bypassing permissions that they were sitting in auto mode, which is a claim about their
  // terminal and it is wrong, so each mode gets its own expectation here rather than a shared one.
  const RELEASE_REASON: Record<string, string> = {
    auto: 'mode:auto',
    dontAsk: 'mode:dontAsk',
    bypassPermissions: 'mode:bypassPermissions',
    // A mode name this build does not recognize is still a mode we could not read, so it keeps
    // the honest reason rather than borrowing a known mode's.
    unknown: 'mode:unknown',
    '': 'mode:unknown',
    'something-new-in-a-future-build': 'mode:unknown',
  };
  for (const mode of NON_HOLDABLE) {
    const decision = decideModHold({ mode, viewers: 9, killSwitch: false });
    const expected = RELEASE_REASON[mode];
    check(`never holds in mode "${mode}"`, decision.hold === false, JSON.stringify(decision));
    check(`mode "${mode}" releases with ${expected}`, !decision.hold && decision.why === expected, JSON.stringify(decision));
  }

  // CX9: Claude does not write `manual` (the pane's "manual" is stored as `default`). A mode name the
  // gate does not know is released as unknown: it is never held, and the card never names a mode
  // the person was not in.
  const manual = decideModHold({ mode: 'manual', viewers: 9, killSwitch: false });
  check('CX9 a mode name Claude does not write is never held', manual.hold === false, JSON.stringify(manual));
  check('CX9 and it is released as an unknown mode, not as a "manual" one', !manual.hold && manual.why === 'mode:unknown', JSON.stringify(manual));

  // Reason precedence, because the read-only card in the app names one reason and one only.
  const killFirst = decideModHold({ mode: 'auto', viewers: 0, killSwitch: true });
  check('the kill switch outranks every other reason', !killFirst.hold && killFirst.why === 'killSwitch', JSON.stringify(killFirst));
  const viewerBeforeMode = decideModHold({ mode: 'auto', viewers: 0, killSwitch: false });
  check('no viewer outranks the mode reason', !viewerBeforeMode.hold && viewerBeforeMode.why === 'viewer:none', JSON.stringify(viewerBeforeMode));
  check('zero viewers is fail-open, not an error', decideModHold({ mode: 'default', viewers: 0, killSwitch: false }).hold === false);
  check('a negative viewer count is treated as nobody watching', decideModHold({ mode: 'default', viewers: -1, killSwitch: false }).hold === false);

  // The registry half: interactive terminal, or the row is not live and nothing is held.
  let clock = 10_000;
  const registry = new ModRegistry({ now: () => clock, startTime: () => 'start', liveness: () => ({ alive: true, identityKnown: true }) });
  const row = (over: Partial<ModRegisterMessage>): ModRegisterMessage => ({
    protocolVersion: 1, sessionId: 'gate', cwd: '/tmp', claudeVersion: '2.1.288', isInteractive: true, surface: 'terminal', ...over,
  });

  registry.register(row({ sessionId: 'terminal' }), { pid: 1, uid: 1000 });
  check('an interactive terminal row is live', registry.status('terminal').state === 'live');
  registry.register(row({ sessionId: 'headless', isInteractive: false, surface: '' }), { pid: 2, uid: 1000 });
  check('headless -p is not live (it registers, and never holds)', registry.status('headless').state === 'observe');
  check('headless is refused for the interactive reason', registry.status('headless').reasons.includes('not-interactive'));
  registry.register(row({ sessionId: 'hosted', surface: 'vscode' }), { pid: 3, uid: 1000 });
  check('a hosted surface is not live', registry.status('hosted').state === 'observe');
  registry.register(row({ sessionId: 'desktop', surface: 'desktop' }), { pid: 4, uid: 1000 });
  check('Claude Desktop would be refused by the same gate', registry.status('desktop').reasons.includes('not-terminal'));
  registry.register(row({ sessionId: 'bg', surface: 'background' }), { pid: 5, uid: 1000 });
  check('a --bg session is listed and offered nothing', registry.status('bg').state === 'observe' && registry.status('bg').present);

  // The gate the mod runs locally before it spends a round trip.
  const localGate = (info: { isInteractive: boolean; surface: string; killSwitch: boolean }): boolean =>
    info.isInteractive && info.surface === 'terminal' && !info.killSwitch;
  check('the mod sends a hold only from an interactive terminal with the switch off', localGate({ isInteractive: true, surface: 'terminal', killSwitch: false }));
  check('the mod stays silent headless', !localGate({ isInteractive: false, surface: 'terminal', killSwitch: false }));
  check('the mod stays silent on a hosted surface', !localGate({ isInteractive: true, surface: 'vscode', killSwitch: false }));
  check('the mod stays silent under the kill switch', !localGate({ isInteractive: true, surface: 'terminal', killSwitch: true }));

  clock += 61_000;
  check('a stale row is not live either, so a dead hook cannot hold', registry.status('terminal').state === 'observe');

  // Auto mode is the population the app will normally be in, so it is worth saying out loud.
  const autoRow = registry.register(row({ sessionId: 'auto-account' }), { pid: 6, uid: 1000 });
  const autoGate = decideModHold({ mode: 'auto', viewers: 2, killSwitch: false });
  check('on an auto-mode account the broker approves nothing (measured default for this corpus)', autoGate.hold === false && autoRow.peerPid === 6);
} catch (error) {
  check('no exception', false, String((error as Error)?.stack ?? error).slice(0, 300));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `FAILED ${failed.length}/${results.length}` : `OK ${results.length}/${results.length} passed`}`);
process.exit(failed.length ? 1 : 0);
