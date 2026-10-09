// cosyncing true sync for a terminal Claude Code session.
//
// One file, no imports. It reaches only the local cosyncing broker, over a private
// Unix socket: no network host, no process execution, no credential handle, no timer.
// Every path here is fail-open. No broker, no socket, no refusal: plain Claude.
//
// The API authority is the build's own declarations, laid into .claude-plugin/types/
// when this mod loads. The calls this file makes, and nothing beside them:
//   $.env.get  $.http.fetch  $.session.id  $.session.version  $.session.cwd
//   $.session.surfaces  $.session.append  $.prompt.submit  $.turn.abort  $.ui.resolve
//   $.ui.invalidate  $.ui.log  $.clock.after
//
// COSYNCING_CLAUDE_DISABLE=1 is this terminal's own off switch, read at session start (and on a
// loop revived by a hot reload). It turns the whole mod off: no registration, no poll, no event,
// no hold and no band, so the session is plain Claude and the app sees it as a mirrored row. The
// other switch lives in cosyncing's settings and reaches the broker's gate; it stops holds for
// every terminal at once while the rest of the sync keeps running.

const HOST = 'http://cosyncing.local';
const ROUTES = {
  register: '/claude/mod/register',
  poll: '/claude/mod/poll',
  hold: '/claude/mod/hold',
  event: '/claude/mod/event',
};

const PROTOCOL_VERSION = 1;
const POLL_WAIT_MS = 20000;
// A hold waits for as long as the person does, the way Claude's own dialog does: the terminal can
// answer the whole time, so nothing about the hold itself runs out. Each request in it is bounded
// instead. The broker parks a held call's long-poll for 20 s at most and renews the hold while it
// is parked, so a request that has not come back after this long is a broker that stopped
// answering, and the call goes back to Claude's own dialog.
const HOLD_POLL_BREAK_MS = 25000;
// The broker parks a held call's long-poll; it does not answer one at once with nothing in it. A
// broker that did would have this hook spinning for as long as the hold lasted, which is now as
// long as the person takes, so a few such answers in a row hand the call back.
const QUICK_EMPTY_MS = 1000;
const QUICK_EMPTY_LIMIT = 3;
// The broker answers an ask at once, held or released, before it waits on anybody. An ask still
// unanswered after this long is a broker that is not answering, and the call goes back to Claude's
// own dialog rather than leaving the person's Claude waiting on it.
const ACK_BREAK_MS = 5000;
// Nothing waits on an event: the hook that sends one has already moved on. This only stops a
// broker that never answers from holding up the events queued behind it.
const EVENT_BREAK_MS = 5000;
// How long a hold told `settled-elsewhere` waits for the outcome the poll leg is carrying. The broker
// says so only after it handed that outcome over, so this is a margin for one reply in flight.
const SETTLED_WAIT_MS = 5000;
const TRANSPORT_BREAK = 2;
const QUESTION_TOOL = 'AskUserQuestion';
// The whole call, for the card's "Show details". Bounded so a hold for a large Write still fits the
// broker's 64 KB body however its text escapes: 8,000 characters at six bytes each is 48 KB.
const DETAIL_MAX_CHARS = 8000;

// How long a parked loop waits before it dials again, and never longer than this. A broker that
// is restarting, a registration that was refused, a dial that cannot land: each one used to END
// the loop, and only `session.start` ever started one, so `cosy restart` killed sync in every
// open terminal. Parking on a capped backoff is what lets an idle session re-register on its own
// once the broker is back, with no hot loop and no spin.
//
// The cap is 10 s and not 30 s, and the reason is the promise itself. A backoff that has already
// climbed to its ceiling is a wait that has to finish BEFORE the next dial, so a 30 s ceiling
// means a session that parked while the broker was down can sit for 30 s after the broker
// returns -- the worst case, not the average. Ten seconds is still six small requests a minute
// per idle terminal, which is nowhere near a spin, and it puts recovery inside a window a test
// can assert rather than one it has to hope in.
const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];

// Refusals no retry can change, because each is a fact about this process: the broker launched it,
// its Claude is below the floor, it speaks another protocol, or it runs as another user. The loop
// stops on the first one, the way it stops when there is no socket to dial, and this terminal is
// plain Claude for the rest of its life. Everything else is retried on the backoff: no broker yet,
// a refused connection, a row that went away (`no_registration`). `session_claimed` is retried too:
// the first terminal to re-register after a broker restart gets the claim, and the one refused
// takes the session over once that process dies or stops polling, which only a retry can see.
const PERMANENT_REFUSALS = ['broker_child', 'claude_version_too_old', 'protocol_version_mismatch', 'uid_mismatch'];

/**
 * Every wait this file takes, in one place. Production never changes these: the values are the
 * constants above. The seam suites scale them down through `tuneForTest`, because a 25 s request
 * bound or a 10 s park is a case a test has to be able to run in well under a second.
 */
const TIMING = {
  holdPollMs: HOLD_POLL_BREAK_MS,
  quickEmptyMs: QUICK_EMPTY_MS,
  ackMs: ACK_BREAK_MS,
  eventMs: EVENT_BREAK_MS,
  settledWaitMs: SETTLED_WAIT_MS,
  backoffMs: BACKOFF_MS,
  pollWaitMs: POLL_WAIT_MS,
};

/**
 * Test seam: replace some of the waits above for this module instance. Unknown keys and values
 * that are not positive numbers (or, for `backoffMs`, a non-empty list of them) are ignored, so a
 * typo cannot quietly turn a bound off. Nothing in the product calls this.
 */
export function tuneForTest(overrides) {
  if (!overrides || typeof overrides !== 'object') return;
  for (const key of Object.keys(TIMING)) {
    const value = overrides[key];
    if (key === 'backoffMs') {
      if (Array.isArray(value) && value.length > 0 && value.every((ms) => typeof ms === 'number' && ms > 0)) TIMING.backoffMs = value.slice();
    } else if (typeof value === 'number' && value > 0) {
      TIMING[key] = value;
    }
  }
}

/** The broker's socket file name, spelled once. */
const SOCKET_FILENAME = 'claude-mod.sock';

/**
 * The absolute socket path, stamped in by `cosyncing setup` when it writes the installed
 * marketplace copy, next to the version stamp it already writes. The tracked file keeps the
 * empty literal, so a `--plugin-dir` run off this checkout falls through to the env rules.
 *
 * The stamp exists because a terminal does not inherit the broker's environment. An operator who
 * moved COSYNCING_HOME would otherwise have a mod dialling `~/.cosyncing` forever, and the mod
 * can read no files: its whole window on the machine is the literal list in `readEnvironment`
 * and this constant, which is why setup's copy carries the answer it already knows.
 */
const STAMPED_SOCKET_PATH = '';

/**
 * Which evaluation of this module is running: when it was evaluated, in base 36, and a random tail.
 *
 * A hot reload evaluates the module again inside the same Claude process, and the old evaluation's
 * request chain keeps running after it. The kernel's pid cannot tell the two apart, so every
 * request carries this tag; the broker keeps the row with the newer one and answers the older one
 * `superseded`, and the older one stops for good instead of taking the row back.
 */
const INSTANCE = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12).replace(/[^a-z0-9]/g, '');

// One session per process. The kill switch is the only value cached across polls: the
// local gates have to answer between polls, and a stale kill switch fails toward
// "hold", which is the direction the spec's fail-open matrix asks for.
const state = {
  socketPath: '',
  disabled: false,
  spawned: false,
  steer: false,
  debug: false,
  sessionId: '',
  /**
   * The id the broker ACCEPTED a registration for. Not the same fact as `sessionId`, which is the
   * id this terminal is working with: a terminal refused as `session_claimed` used to adopt the id
   * anyway, and since the loop only registered when the id changed, it never asked again -- it
   * polled a row that belonged to another process, was refused on every round, and stayed out
   * even after that process died.
   */
  registeredId: '',
  cwd: '',
  surface: '',
  interactive: false,
  version: '',
  turnId: '',
  /**
   * When this module last saw the main turn end (`turn.complete` or `session.end`), in ms since the
   * epoch, or 0 for never. Sent with every registration: a broker that restarted has forgotten it,
   * and a turn stopped from the app writes no interruption row, so without this the restarted broker
   * drew that turn as still running in every history read until the next turn ended.
   */
  turnEndedAt: 0,
  /**
   * True from the main turn's end until the next one starts. A call that arrives then with no
   * `agentId` is not this conversation's: see `conversationCall`. False until a turn is seen, so a
   * module loaded mid-turn holds as it always did.
   */
  betweenTurns: false,
  killSwitch: false,
  /** Open holds, oldest first, each with its own band. See `headBand`. */
  bands: [],
  loopToken: 0,
  /** Whether a loop is running under some token. See `ensureLoop`. */
  loopStarted: false,
  /** No socket path in this process's environment: a fact that cannot change, so it is asked once. */
  loopDeclined: false,
  /** The permanent refusal that stopped the loop for good, if one did. See PERMANENT_REFUSALS. */
  refusedForGood: '',
  seq: 0,
  /** Consecutive stops in a row, which is the backoff step. Cleared by any good round trip. */
  backoff: 0,
  /** Consecutive `again` rounds. The first is retried at once; the rest park on the backoff. */
  againStreak: 0,
  transportFailures: 0,
  /** Set when the broker says a newer evaluation of this module holds the session. Final. */
  retired: false,
  /**
   * The id `session.end` closed. A process that is exiting can still read it from
   * `$.session.id()`, and registering it again re-created a row for a session that had ended.
   */
  endedSessionId: '',
  /** Request ids of the commands already run, newest last, so a redelivery is not a rerun. */
  recentCommands: [],
  /** The events not yet sent, in order. See `report`. */
  events: Promise.resolve(),
};

// The debug log and nothing else. `$.ui.log` with no sink appends a dim row to the person's own
// transcript, so a diagnostic switch turned into lines in the conversation they were having. The
// build's `{ to: "debug" }` sink is the debug log alone (`claude --debug` or `--debug-file`), and
// nothing on screen. Callers pass ids, kinds and codes: never a prompt, a steer, or any text a
// person or another plugin wrote, because the debug log is a file people attach to bug reports.
function log($, message) {
  if (state.debug) $.ui.log('cosyncing: ' + message, { to: 'debug' });
}

// `HttpResponse.text` is a string property, not a method. The build said so in its own
// declarations and the spike confirmed it on the wire, so this reads it as one.
function bodyOf(response) {
  const body = response ? response.text : '';
  return typeof body === 'string' ? body : '';
}

async function call($, route, payload, query) {
  return callFor($, state.sessionId, route, payload, query);
}

/**
 * One request to the broker. With `bound`, the wait for its answer ends after `bound.ms` (thrown
 * as `timeout`) or as soon as `bound.band` is decided here (thrown as `woken`). Without one it is
 * the engine's own limit, which is only right for a wait no hook is parked on.
 */
async function callFor($, sessionId, route, payload, query, bound) {
  // Never dial without a path we vouch for: an empty `socketPath` makes the URL real.
  if (!isAbsolutePath(state.socketPath)) throw new Error('socket_unresolved');
  let target = HOST + ROUTES[route] + '?sid=' + encodeURIComponent(sessionId) + '&inst=' + INSTANCE;
  if (query) target += '&' + query;
  const sent = $.http.fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    socketPath: state.socketPath,
  });
  const response = bound ? await within($, bound.ms, sent, bound.band) : await sent;
  if (response === TIMED_OUT) throw new Error('timeout');
  if (response === WOKEN) throw new Error('woken');
  const status = Number(response ? response.status : 0);
  let parsed = null;
  try {
    parsed = JSON.parse(bodyOf(response) || 'null');
  } catch (error) {
    parsed = null;
  }
  if (status !== 200 || !parsed || parsed.ok !== true) {
    const code = parsed && parsed.code ? String(parsed.code) : 'status_' + status;
    // A newer evaluation of this module has the session. Nothing this one does from now on can
    // help, and everything it does would take the row from the module the engine is calling.
    if (code === 'superseded') retire($);
    const error = new Error(code);
    // The broker's own refusal, as against a dial that never landed (the fetch rejects) or a reply
    // that is not the broker's: the broker is there, and it said no to this request.
    if (parsed && parsed.code) error.refused = true;
    throw error;
  }
  state.transportFailures = 0;
  return parsed;
}

/** What `within` resolves with when its time ran out, and when the band it watched was decided. */
const TIMED_OUT = { bound: 'timeout' };
const WOKEN = { bound: 'woken' };

/**
 * `work`, unless `ms` pass first, or `band` is decided here first.
 *
 * `$.http.fetch` takes no signal, and the engine gives a request 30 s before it gives up on it. A
 * hook awaiting a broker that accepts the connection and never answers was stuck for those 30 s,
 * twice over for a hold, and the person's Claude was stuck behind it. This races the request
 * against the host's own timer instead. The request is not cancelled, because nothing can cancel
 * it: it is only no longer waited on, and an answer that comes after is dropped.
 *
 * A timer the host refuses leaves the engine's own limit as the only bound, which is what there
 * was before. The race costs a hook nothing either way: its clock stops while a `$` call is out.
 */
function within($, ms, work, band) {
  return new Promise((resolve, reject) => {
    let waiting = true;
    let timer = null;
    const finish = (settleWith, value) => {
      if (!waiting) return;
      waiting = false;
      if (band && band.wake === wake) band.wake = null;
      if (timer) {
        try {
          timer.cancel();
        } catch (error) {
          // Already fired, or gone with the environment that set it.
        }
      }
      settleWith(value);
    };
    const wake = () => finish(resolve, WOKEN);
    if (band) band.wake = wake;
    try {
      timer = $.clock.after(Math.max(1, ms), () => finish(resolve, TIMED_OUT));
    } catch (error) {
      timer = null;
    }
    if (work) work.then((value) => finish(resolve, value), (error) => finish(reject, error));
    // Nothing to wait on but the band, and no timer to stop waiting: waiting would be for ever.
    else if (!timer) finish(resolve, TIMED_OUT);
  });
}

/** Stop this module's loop for good: a newer evaluation of it owns the session now. */
function retire($) {
  if (state.retired) return;
  state.retired = true;
  state.loopToken += 1;
  state.loopStarted = false;
  log($, 'a newer copy of this mod holds the session: this one stops');
  breakBand($, 'superseded');
}

// A fault is the mod's cue to stop talking, not to dial again: a broker that is not
// there must not turn into a loop of attempts. Two faults clear the band and the loop.
function fault($) {
  state.transportFailures += 1;
  if (state.transportFailures >= TRANSPORT_BREAK) breakBand($, 'transport');
  return state.transportFailures < TRANSPORT_BREAK;
}

/**
 * Where the broker's mod socket is, resolved the way the broker binds it.
 *
 * The order is the broker's: an explicit override, then the path setup stamped into this copy,
 * then `$COSYNCING_HOME/claude-mod.sock`, then `$HOME/.cosyncing/claude-mod.sock`. Anything that
 * is not absolute is rejected rather than guessed at, because `$.http.fetch` with an empty
 * `socketPath` does not fail -- it goes out over TCP to whatever answers the host in the URL.
 * No path we can vouch for means no sync, which is the fail-open shape; the wrong path means
 * handing the user's prompts to a stranger's process.
 *
 * An override that is set decides, even when it is unusable. A relative COSYNCING_CLAUDE_SOCK is
 * refused here exactly as the broker refuses to bind one, and it does not fall through to the
 * stamped path: whoever set it meant one particular broker, and the stamped path is usually the
 * production one.
 */
export function resolveSocketPath(sources) {
  const override = typeof sources.override === 'string' ? sources.override.trim() : '';
  if (override) return isAbsolutePath(override) ? override : '';
  const stamped = typeof sources.stamped === 'string' ? sources.stamped.trim() : '';
  if (isAbsolutePath(stamped)) return stamped;
  return socketUnder(sources.cosyncingHome) || socketUnder(sources.home, '.cosyncing');
}

function isAbsolutePath(value) {
  return typeof value === 'string' && value.startsWith('/');
}

function socketUnder(dir, ...segments) {
  if (typeof dir !== 'string') return '';
  let base = dir.trim();
  if (!isAbsolutePath(base)) return '';
  while (base.length > 1 && base.endsWith('/')) base = base.slice(0, -1);
  const parts = [base === '/' ? '' : base].concat(segments.filter((part) => typeof part === 'string' && part.length > 0));
  return parts.join('/') + '/' + SOCKET_FILENAME;
}

async function readEnvironment($) {
  // Literal reads only, so the shipped inventory says exactly what the mod can see.
  const socket = await $.env.get('COSYNCING_CLAUDE_SOCK');
  const disable = await $.env.get('COSYNCING_CLAUDE_DISABLE');
  const steer = await $.env.get('COSYNCING_CLAUDE_STEER');
  const spawned = await $.env.get('COSYNCING_SPAWNED');
  const debug = await $.env.get('COSYNCING_CLAUDE_DEBUG');
  const cosyncingHome = await $.env.get('COSYNCING_HOME');
  const home = await $.env.get('HOME');
  state.socketPath = resolveSocketPath({
    override: socket,
    stamped: STAMPED_SOCKET_PATH,
    cosyncingHome,
    home,
  });
  state.disabled = disable === '1';
  // Default on, and an explicit 0 is the only off: the operator's terminal is not going to
  // carry our variable, and a mid-turn message that silently queues instead of steering is a
  // worse surprise than one that steers. Same convention the broker uses for its own switch.
  state.steer = steer !== '0';
  state.spawned = spawned === '1';
  state.debug = debug === '1';
}

async function sessionVersion($) {
  try {
    const v = await $.session.version();
    return String((v && (v.base || v.version)) || '');
  } catch (error) {
    return '';
  }
}

async function currentSessionId($) {
  try {
    return String(await $.session.id());
  } catch (error) {
    return '';
  }
}

// The local gates. The mode and the viewer count are the broker's to read when the
// hold arrives; these are only the facts the mod can know cheaply, and each one that
// fails sends the call to Claude's own dialog.
function canHold() {
  return state.sessionId.length > 0
    // Only a terminal the broker accepted: a refused one is Observe, and holds nothing.
    && state.registeredId === state.sessionId
    && !state.disabled
    && !state.retired
    && !state.spawned
    && !state.killSwitch
    && state.interactive === true
    && state.surface === 'terminal'
    && state.socketPath.length > 0;
}

async function registerSession($) {
  const id = await currentSessionId($);
  if (!id) return false;
  state.sessionId = id;
  // Behind every event already queued. Events go out without a hook waiting on them, and a
  // `session.end` still on its way when the same id registered again landed after it -- and closed
  // the row that had just been opened.
  await state.events;
  try {
    const reply = await call($, 'register', {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: id,
      cwd: state.cwd,
      claudeVersion: state.version,
      isInteractive: state.interactive,
      surface: state.surface,
      instance: INSTANCE,
      // The turn running right now, if any. A row is born knowing no turn, so without this a
      // broker restart mid-turn -- or a reload whose first hook was this turn's own turn.start,
      // reported before any registration existed -- left Stop refused as no_active_turn.
      ...(state.turnId ? { turnId: state.turnId } : {}),
      // When the last turn ended, which a restarted broker no longer knows. See `state.turnEndedAt`.
      ...(state.turnEndedAt > 0 ? { turnEndedAt: state.turnEndedAt } : {}),
    });
    // The register reply is the odd one out: there `state` is the row's state name and the
    // switch sits beside it, while every other reply carries `state.killSwitch`. Reading the
    // poll shape here read `undefined` off a string and left the switch stuck off.
    state.killSwitch = reply.killSwitch === true;
    state.registeredId = id;
    log($, 'registered ' + id + ' as ' + reply.state + ' peer ' + reply.peerPid);
    return true;
  } catch (error) {
    // Refused -- most often `session_claimed`, another live terminal on the same session. The
    // loop parks and asks again on its own cadence, which is how this terminal takes the session
    // over once that process dies or stops polling.
    state.registeredId = '';
    const code = String(error.message || error);
    if (PERMANENT_REFUSALS.includes(code)) {
      state.refusedForGood = code;
      log($, 'register refused for good: ' + code + '; staying off');
      return false;
    }
    log($, 'register refused: ' + code);
    return false;
  }
}

// The band is a picture of one open hold. `outcome`, `broken` and `chosen` are written
// from three places (the poll loop, a turn event, a keypress) and read by the hold
// loop, which is the only place that decides.
// The bands are one per open hold, not one shared slot. Two tools can be awaiting a
// permission at the same moment -- a subagent's call and the main thread's, or two parallel
// tool uses -- and with a single slot the second ask overwrote the first. The first hold then
// had no face left to answer from, and its answer went to whichever call held the slot, which
// is how an approval ends up on a call the user never saw.
function openBands() {
  return state.bands.filter((band) => !band.outcome && !band.broken);
}

/**
 * The band the keyboard is showing: the oldest ask still waiting that the broker said it holds.
 *
 * Not simply the oldest ask. A render can come at any moment -- a keypress, a resize, another
 * plugin's invalidate -- and one that landed while an ask was still on its way to the broker drew
 * an undecided band: buttons for a call the broker might be about to release, or never hear of.
 */
function headBand() {
  const open = openBands().filter((band) => band.shown);
  return open.length > 0 ? open[0] : null;
}

/**
 * Put this hold's band on screen.
 *
 * Not when the ask arrives -- when the broker has said it is HOLDING the ask. Drawing on the
 * ask itself flashed a band on every prompt in auto mode, on every prompt with nobody
 * watching, and on every prompt while the broker was down, because in all three the broker
 * answers that same request with a release before the first round trip ends. The band is a
 * promise that somebody is waiting on you; it may only appear once that is true.
 */
function showBand($, band) {
  if (band.shown || band.outcome || band.broken) return;
  band.shown = true;
  $.ui.invalidate('ui.render');
}

function dropBand($, band) {
  const at = state.bands.indexOf(band);
  if (at < 0) return;
  state.bands.splice(at, 1);
  // A dropped band's picture can outlive it on screen until the engine draws again, and its
  // buttons are closures over it. Marked, a press on that picture does nothing.
  band.dropped = true;
  // Anything that was ever drawn is drawn away. Asking only about `shown` left a band that a render
  // had painted before its ack -- and that then ended on the deadline or a refusal -- standing with
  // live buttons.
  if (band.shown || band.drawn) $.ui.invalidate('ui.render');
}

function settle($, outcome) {
  const band = state.bands.find((candidate) => candidate.requestId === outcome.requestId);
  if (!band || band.outcome || band.broken) return false;
  band.outcome = outcome;
  // The hold may be parked on a request the other leg has just made moot.
  wakeBand(band);
  // The next ask in the queue takes the band's place as soon as this one leaves it.
  $.ui.invalidate('ui.render');
  return true;
}

/** Let the hold waiting on this band stop waiting on the broker: it has been decided here. */
function wakeBand(band) {
  const wake = band.wake;
  band.wake = null;
  if (wake) wake();
}

function breakBand($, why) {
  const open = openBands();
  if (open.length === 0) return;
  log($, 'band cleared: ' + why + ' (' + open.length + ' open)');
  for (const band of open) {
    band.broken = why;
    wakeBand(band);
  }
  $.ui.invalidate('ui.render');
}

function bandTree($, e, band) {
  const { Box, Text, Button } = $.ui.resolve(e);
  // Only a human press reaches this closure, which is the point of the band: nothing
  // else in this file can answer `allow`. The POST fires here rather than from the
  // hold loop because that loop is parked inside a long-poll when the key goes down.
  const tap = (behavior) => () => {
    // `dropped`: the hold behind this picture has already given its call back. The broker may still
    // hold the request for a few seconds more, and a press here would answer it -- deciding a call
    // the engine has already put to the person in its own dialog.
    if (band.dropped || band.outcome || band.broken || band.chosen) return;
    band.chosen = behavior;
    log($, 'band tap ' + behavior);
    void answerBand($, band, behavior);
  };
  const asking = band.questions && band.questions.length;
  const title = asking
    ? 'cosyncing: Claude is asking a question'
    : 'cosyncing: Claude wants to run ' + band.tool;
  if (asking) {
    // One button, because it is the only answer this band can give. A survey is not
    // settled by `allow`: its answer is a set of choices, and the choices are on the
    // app's card or in Claude's own dialog. Offered Allow and Deny anyway, both
    // buttons did the same thing as the third -- hand the call back, which drops the
    // app's card and reopens the picker -- so a user tapping what looked like an
    // approval got a picker instead, twice.
    // The face names the chord, as the permission band's does: a bare 1 reaches this button only
    // while the band holds the keyboard, and typed into the composer it is a 1 in the next prompt.
    return Box({
      flexDirection: 'column',
      children: [
        Text({ children: title }),
        Box({
          flexDirection: 'row',
          children: [
            Button({ key: 'cosyncing-dialog', label: "Answer in Claude's dialog", hotkey: '1', plain: true, autoFocus: true, onPress: tap('dialog') }),
          ],
        }),
        Text({ dimColor: true, children: 'cosyncing: answer it in the cosyncing app, or ctrl+x then tab, then 1, to have Claude ask here' }),
      ],
    });
  }
  // Measured on 2.1.289: a Button hotkey arms only while this band holds the keyboard, and a
  // bare digit typed in the composer answers a survey's rows rather than a plugin's band. So the
  // band says the chord on its own face and starts its ring on Allow, which is the answer a
  // person most often means; Enter there is one key from the moment the band takes the keys.
  return Box({
    flexDirection: 'column',
    children: [
      Text({ children: title }),
      Box({
        flexDirection: 'row',
        children: [
          Button({ key: 'cosyncing-allow', label: 'Allow', hotkey: '1', plain: true, autoFocus: true, onPress: tap('allow') }),
          Button({ key: 'cosyncing-deny', label: 'Deny', hotkey: '2', plain: true, onPress: tap('deny') }),
          Button({ key: 'cosyncing-dialog', label: "Show Claude's dialog", hotkey: '3', plain: true, onPress: tap('dialog') }),
        ],
      }),
      Text({ dimColor: true, children: 'cosyncing: ctrl+x then tab to take these keys' }),
    ],
  });
}

/**
 * Whether a call is one this terminal's conversation is making, and so one to hold.
 *
 * Measured on 2.1.295: when a turn ends, Claude runs a forked agent to guess the next prompt
 * (`prompt_suggestion` in its debug log), and that fork can call tools. Its calls reach `tool.call`
 * and `tool.check` in the main loop's envelope, with no `agentId`, but after the main turn's
 * `turn.complete` and before any `turn.start`. Held, a fork's AskUserQuestion drew a band and an app
 * card for a question that is in no transcript, and it took the band's place in front of the real
 * question asked next. A subagent's call carries its `agentId` and is held as before.
 */
function conversationCall(e) {
  if (typeof e.agentId === 'string' && e.agentId.length > 0) return true;
  return !state.betweenTurns;
}

async function answerBand($, band, behavior) {
  if (behavior === 'dialog') {
    // The human chose Claude's own dialog. Say so over the event leg, so the app's card
    // closes for the same reason the band did instead of holding a call nobody will run.
    band.broken = 'dialog';
    wakeBand(band);
    // `via` says which of the terminal's own cancels this was, so the app's card can say the
    // answer is in the terminal rather than in some other client.
    report($, 'user-cancel', band.requestId, { via: 'dialog' });
    return;
  }
  let reply = null;
  try {
    reply = await callFor($, state.sessionId, 'event', {
      sessionId: state.sessionId,
      kind: 'hold.answer',
      requestId: band.requestId,
      detail: { behavior, source: 'band' },
    }, undefined, { ms: TIMING.eventMs });
  } catch (error) {
    const code = String(error.message || error);
    log($, 'band answer refused: ' + code);
    // The registration this band was drawn for is gone, and every hold it had open with it.
    if (code === 'no_registration' || code === 'peer_mismatch' || code === 'superseded') {
      holdGone($, band);
      return;
    }
    // The answer never landed, and the call is still held. A band that stayed chosen here left every
    // button inert, "Show Claude's dialog" included, on a hold that has no deadline.
    band.chosen = '';
    $.ui.invalidate('ui.render');
    return;
  }
  // The broker holds no such call any more: answered from the app, ended with its turn, or lapsed.
  if (reply && reply.answered === false) holdGone($, band);
}

/**
 * The broker has no open hold behind this band. Its hold leg is told to stop waiting and ask once
 * more, which ends it with whatever the broker decided -- the app's answer, a release -- and takes
 * the band down. The band stays chosen until then, so nothing on it can be pressed in the meantime.
 */
function holdGone($, band) {
  log($, 'band answer found no hold: the call ends with what the broker has');
  wakeBand(band);
}

/**
 * Ask the broker to hold this call, and wait for the answer.
 *
 * Returns the outcome, or null when nothing was answered: released by a gate, broken by a turn
 * event or a keypress, its hook aborted, or a broker that stopped answering. Every null is the
 * engine's own `ask` put back on the table, which is the fail-open rule. There is no deadline: a
 * call nobody has answered is still a call somebody can answer, from either side.
 */
async function hold($, request) {
  const band = {
    // Unique per process, and the broker scopes it by registration generation, so a resumed
    // process cannot inherit the dead one's card.
    requestId: 'cm-' + (++state.seq),
    tool: request.tool,
    questions: request.questions || null,
    outcome: null,
    broken: null,
    chosen: '',
    // Whether this hold's band is on screen. `showBand` waits for the broker's first reply,
    // so a call it is about to release never paints a band at all.
    shown: false,
    /** Whether a render ever painted it, which is what decides that dropping it repaints. */
    drawn: false,
    /** Set once the hold is over, so a press on a picture of it that is still on screen is inert. */
    dropped: false,
    /** Set while the hold waits on the broker, so a decision made here ends the wait. */
    wake: null,
  };
  state.bands.push(band);
  // The engine aborts a hook it has given up on -- an interrupted turn -- and drops its answer a few
  // seconds later. A hold with no deadline must end there too, or it would go on asking the broker
  // about a call nobody is running and keep the app's card open for it.
  const signal = request.signal;
  const onAbort = () => {
    if (band.broken || band.outcome) return;
    band.broken = 'aborted';
    wakeBand(band);
    // Said, so the app's card closes now rather than when the broker notices the silence. An
    // interrupt is Escape at the keyboard or the app's own Stop; the broker knows which.
    report($, 'user-cancel', band.requestId, { via: 'interrupt' });
  };
  if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort);
  if (signal && signal.aborted === true) onAbort();
  let quickEmpty = 0;
  try {
    for (;;) {
      if (band.broken) return null;
      if (band.outcome) return band.outcome;
      // Until the broker has said it holds the call, the wait is for an answer it gives at once.
      const ms = band.shown ? TIMING.holdPollMs : TIMING.ackMs;
      const sentAt = Date.now();
      let reply = null;
      try {
        reply = await callFor($, state.sessionId, 'hold', {
          sessionId: state.sessionId,
          requestId: band.requestId,
          tool: request.tool,
          decision: 'ask',
          input: request.input,
          ...(request.detail ? { detail: request.detail } : {}),
          ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
          ...(request.questions ? { questions: request.questions } : {}),
        }, undefined, { ms, band });
      } catch (error) {
        const code = String(error.message || error);
        // Decided here while the request was out: by the poll leg, the band, or a turn event.
        if (code === 'woken') continue;
        log($, 'hold refused: ' + code);
        if (code === 'timeout') {
          log($, 'hold: no answer from the broker within ' + ms + ' ms: handing the call back');
          return null;
        }
        // Not the poll leg's rule. Re-registering from here would bump the registration
        // generation, and a new generation closes every hold the previous one opened -- including
        // this one, and any other call this session is parked on. So one leg only: the loop owns
        // re-registration, and a hold whose row is gone says so and hands the call back.
        // A refusal here may be about a registration this terminal has already replaced -- a hold
        // opened before a resume answers after it -- so it changes nothing but this call.
        if (code === 'no_registration' || code === 'peer_mismatch') {
          log($, 'hold has no registration any more: handing the call back');
          return null;
        }
        // Any other refusal is about this call -- its body, its shape -- and offering it again would
        // be refused the same way. It is not a transport fault: counted as one, a single oversize
        // question cleared every other band this session had up.
        if (error.refused) {
          log($, 'hold: the broker will not hold this call: handing it back');
          return null;
        }
        if (!fault($)) return null;
        continue;
      }
      if (reply.state) state.killSwitch = !!reply.state.killSwitch;
      if (reply.settledElsewhere) {
        // This call is over, and its outcome went out on the poll leg, which this terminal will read
        // in a moment. Offering the call again would be refused the same way: before the broker said
        // so, the re-offer opened a second hold for a call that had already been decided.
        if (!band.outcome && !band.broken) await within($, TIMING.settledWaitMs, null, band);
        if (band.broken || !band.outcome) {
          log($, 'hold settled elsewhere, and the outcome never reached this terminal: handing the call back');
          return null;
        }
        return band.outcome;
      }
      if (reply.held === true) {
        // The broker has the call and is waiting on somebody. That is the cue to put the band
        // up: not the arrival of the ask, which painted one over every prompt the broker
        // released in the same round trip -- in auto mode, with nobody watching, and whenever
        // the row could not answer at all.
        showBand($, band);
        continue;
      }
      if (reply.verdict) {
        settle($, { requestId: band.requestId, kind: 'verdict', behavior: reply.verdict.behavior, source: reply.verdict.source });
      } else if (reply.answer) {
        settle($, { requestId: band.requestId, kind: 'answer', answers: reply.answer.answers });
      } else if (reply.release) {
        settle($, { requestId: band.requestId, kind: 'release', why: reply.release.why });
      } else if (Date.now() - sentAt < TIMING.quickEmptyMs) {
        // Still held, said without waiting: see QUICK_EMPTY_MS.
        quickEmpty += 1;
        if (quickEmpty >= QUICK_EMPTY_LIMIT) {
          log($, 'hold: the broker answers without waiting: handing the call back');
          return null;
        }
      } else {
        quickEmpty = 0;
      }
    }
  } finally {
    if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
    dropBand($, band);
  }
}

/**
 * Tell the broker something happened, and do not wait for it to listen.
 *
 * Hooks awaited this, so a broker that accepted the connection and never answered held up every
 * turn start and turn end in the person's Claude for the engine's whole 30 s fetch limit. The event
 * is queued instead, and the queue sends one at a time so the broker still reads a turn's end after
 * its start; each send has its own bound, so one lost request delays the next by that much at most.
 * Returns the queue, which is never rejected.
 */
function report($, kind, requestId, detail, forSession) {
  const sessionId = forSession || state.sessionId;
  if (state.disabled || state.retired || state.spawned || state.refusedForGood || !sessionId) return state.events;
  const payload = {
    sessionId,
    kind,
    ...(requestId ? { requestId } : {}),
    ...(detail ? { detail } : {}),
  };
  state.events = state.events.then(() => sendEvent($, sessionId, kind, payload));
  return state.events;
}

async function sendEvent($, sessionId, kind, payload) {
  // Queued before the broker refused this terminal for good, and nothing it says would be heard now.
  if (state.refusedForGood) return;
  try {
    await callFor($, sessionId, 'event', payload, undefined, { ms: TIMING.eventMs });
  } catch (error) {
    log($, kind + ' event refused: ' + String(error.message || error));
  }
}

async function runCommand($, command) {
  // Defence in depth: the broker's queue delivers once, but a requeue after a write it thought
  // had failed, or a queue that accepted the same request twice, would otherwise run a prompt twice.
  const id = typeof command.requestId === 'string' ? command.requestId : '';
  if (id) {
    if (state.recentCommands.includes(id)) {
      log($, 'command ' + command.op + ' ' + id + ' already ran: not running it again');
      return;
    }
    state.recentCommands.push(id);
    if (state.recentCommands.length > 64) state.recentCommands.shift();
  }
  log($, 'command ' + command.op);
  try {
    if (command.op === 'prompt' && typeof command.text === 'string') {
      await $.prompt.submit({ text: command.text, asUser: true });
    } else if (command.op === 'steer' && typeof command.text === 'string') {
      // Steering is an in-turn append, so it needs a turn this terminal knows is running. The broker
      // chose "steer" from the last turn it heard about, and that turn can end before the command
      // lands here: an append into a finished turn is stored and starts nothing, which left the
      // person's words unanswered in the transcript with the app showing them as sent. With no
      // turn running, the words are a prompt.
      if (steerRoute(state.steer) === 'append' && state.turnId) {
        const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: command.text }] } });
        // Two ways this does not land, and both used to be silent. A plugin above refuses the
        // append and the call resolves to `{ deny: reason }` with nothing stored; and a turn
        // that ended between the broker's decision to steer and this call leaves an in-turn
        // append writing into a turn that is no longer there. Either way the person's words
        // were gone, with the app showing them as sent. The fallback costs one input boundary
        // and says nothing about it being unusual, which is what a queued prompt is.
        if (!appended || appended.deny || !appended.uuid) {
          // Not the refusal's reason: a plugin that refuses an append may quote the words back.
          log($, 'append refused (' + (appended && appended.deny ? 'a plugin refused it' : 'no row id') + '): submitting as a prompt instead');
          await $.prompt.submit({ text: command.text, asUser: true });
        }
      } else {
        // Steering off in this terminal, or no turn to steer: the words still go to Claude, one
        // boundary later. A command that is read and then dropped is a lost message, and the user
        // has no way to know the app sent it.
        await $.prompt.submit({ text: command.text, asUser: true });
      }
    } else if (command.op === 'abort') {
      // Only the turn the engine actually started, and only while it is still running. The
      // broker stamps its current turn onto an abort that arrived without one, so an abort
      // reaching here with no id means there was no turn to stop -- and stopping "whatever is
      // current" would interrupt a turn the user never meant to touch.
      const turnId = String(command.turnId || '');
      if (!turnId || turnId !== state.turnId) {
        log($, 'abort refused: no running turn for ' + (turnId || '(none)'));
        report($, 'command.refused', command.requestId, { op: 'abort', reason: 'no_active_turn' });
      } else {
        await $.turn.abort({ turnId });
      }
    }
    // There is no `answer` op. A question's answer resolves the hold it belongs to, because a
    // mod parked on a hold is not parked on its poll leg at the same time, and an answer handed
    // over as a queued command sat unread until the hold ended by itself.
  } catch (error) {
    // A host error about a prompt or a steer may carry the text it failed on, so for those two
    // the log says which command failed and no more.
    const carriesText = command.op === 'prompt' || command.op === 'steer';
    log($, 'command ' + command.op + ' failed' + (carriesText ? '' : ': ' + String(error.message || error)));
    // Said to the broker, which tells the app: a message the app showed as sent and the terminal
    // never delivered was lost without a word. A fixed code, never the error, for the same reason
    // as the log line above.
    report($, 'command.refused', command.requestId, { op: String(command.op), reason: 'host_error' });
  }
}

/**
 * One round of the loop: register if the id moved, then long-poll.
 *
 * 'ok' is a good round trip, 'again' is worth another immediate try (the row went away, so the
 * next round registers), and anything else is a reason to park. 'again' deliberately does not
 * clear the backoff, so a broker that keeps dropping the row between the register and the poll
 * backs off instead of oscillating.
 */
async function pollOnce($, token) {
  if (state.retired) return 'retired';
  const id = await currentSessionId($);
  // Every await below can come back to a loop that a newer one replaced. A retired loop's answer
  // is about the row it was serving, and writing it into the shared state cleared the NEW loop's
  // session id between its register and its first poll.
  if (token !== state.loopToken) return 'stale';
  // `/clear` and a resume both re-issue the id. Re-register on any change from the
  // id we hold rather than on a remembered one: the remembered id is the stale fact.
  if (!id) return 'no-session';
  // The id `session.end` closed is not registered again. A process on its way out still reads
  // it, and registering it re-created a row for a session that had ended -- twice, in real runs.
  if (id === state.endedSessionId) return 'ended';
  // A changed id registers, and so does an id the broker has not accepted yet: a refused
  // registration is asked again on the park cadence rather than adopted and polled.
  if (id !== state.sessionId || id !== state.registeredId) {
    state.sessionId = id;
    const accepted = await registerSession($);
    if (token !== state.loopToken) return 'stale';
    if (!accepted) return state.refusedForGood ? 'refused-for-good' : 'register-refused';
  }
  let reply = null;
  try {
    reply = await call($, 'poll', { sessionId: state.sessionId, wait: TIMING.pollWaitMs });
  } catch (error) {
    if (token !== state.loopToken) return 'stale';
    const code = String(error.message || error);
    if (PERMANENT_REFUSALS.includes(code)) {
      state.refusedForGood = code;
      log($, 'poll refused for good: ' + code + '; staying off');
      return 'refused-for-good';
    }
    log($, 'poll refused: ' + code);
    // A broker that restarted, or that evicted this row as stale, or a row that now belongs to
    // another process, is not a transport fault: the answer is to register again. Only a dial
    // that cannot land counts.
    if (code === 'no_registration' || code === 'peer_mismatch' || code === 'session_mismatch') {
      state.registeredId = '';
      return 'again';
    }
    if (!fault($)) return 'transport';
    return 'again';
  }
  if (token !== state.loopToken) return 'stale';
  if (reply.state) state.killSwitch = !!reply.state.killSwitch;
  if (reply.command) await runCommand($, reply.command);
  else if (reply.verdict) settle($, { requestId: reply.verdict.requestId, kind: 'verdict', behavior: reply.verdict.behavior, source: reply.verdict.source });
  else if (reply.answer) settle($, { requestId: reply.answer.requestId, kind: 'answer', answers: reply.answer.answers });
  else if (reply.release) settle($, { requestId: reply.release.requestId, kind: 'release', why: reply.release.why });
  return 'ok';
}

// Chained fetches: each poll is a request the broker holds open, so the loop's own pace is the
// broker's. A new token retires the previous loop.
async function runLoop($, token) {
  while (token === state.loopToken && !state.retired) {
    const outcome = await pollOnce($, token);
    if (outcome === 'stale') return;
    if (outcome === 'ok') {
      state.backoff = 0;
      state.againStreak = 0;
      continue;
    }
    if (outcome === 'retired') return;
    if (outcome === 'refused-for-good') {
      // Not parked: nothing a later attempt sends could be answered differently.
      state.loopStarted = false;
      state.loopDeclined = true;
      return;
    }
    // One `again` is retried at once: the row went away and the next round registers. Two in a
    // row is a broker that keeps losing the row, and an unbacked-off retry against that was a
    // spin -- hundreds of registrations a second, each one closing every hold the row had open.
    if (outcome === 'again') {
      state.againStreak += 1;
      if (state.againStreak <= 1) continue;
    }
    park($, token, outcome);
    return;
  }
}

function park($, token, reason) {
  if (state.retired || token !== state.loopToken) return;
  // An ended session is waiting for `/clear` to hand it a new id: a local read, not a dial, so it
  // is retried at the first step and never climbs to the ceiling.
  const step = reason === 'ended' ? 0 : state.backoff;
  const wait = TIMING.backoffMs[Math.min(step, TIMING.backoffMs.length - 1)];
  if (reason !== 'ended') state.backoff += 1;
  log($, 'sync parked (' + reason + '), next attempt in ' + wait + ' ms');
  // `$.clock.after` and not `$.clock.sleep`: this loop is detached from the dispatch that
  // started it, and a sleep there would spend a budget that dispatch no longer has. `after` is
  // the host's own timer, and a hot reload cancels its pending waits with the old environment.
  try {
    $.clock.after(wait, () => {
      // A newer `session.start` owns the loop by then; this timer is a leftover.
      if (token !== state.loopToken) return;
      void runLoop($, token);
    });
  } catch (error) {
    // The host refused the timer. Nothing is driving the loop now, so it must not read as running:
    // marked stopped, the next hook's `ensureLoop` starts it again.
    state.loopStarted = false;
    log($, 'the host refused the park timer: the next hook restarts the loop');
  }
}

function startLoop($) {
  const token = ++state.loopToken;
  if (state.disabled || state.spawned || state.refusedForGood || !isAbsolutePath(state.socketPath)) {
    // Switched off, launched by cosyncing itself (Drive and Take over, which the broker refuses as
    // its own child and which hold nothing here anyway), refused for good, or nothing to dial. Each
    // is fixed for this process, so the revived loop does not go asking again on every turn.
    log($, state.disabled
      ? 'COSYNCING_CLAUDE_DISABLE=1: staying off'
      : state.spawned
        ? 'COSYNCING_SPAWNED=1: a Claude cosyncing started; staying off'
        : state.refusedForGood
          ? 'refused for good (' + state.refusedForGood + '); staying off'
          : 'no broker socket in view; staying off');
    state.loopStarted = false;
    state.loopDeclined = true;
    return;
  }
  state.loopStarted = true;
  // A new loop starts its own count: the one it replaced may have been mid-backoff.
  state.backoff = 0;
  state.againStreak = 0;
  void runLoop($, token);
}

/**
 * Start the loop if nothing is driving it.
 *
 * A hot reload (plugin files change under a running Claude, which the marketplace copy does
 * on `cosy update`) re-evaluates this module: `state` comes back empty and the host cancels
 * the pending `$.clock.after` waits along with the old environment. Only `session.start`
 * started a loop, and a reload mid-session never fires another one, so the reloaded mod sat
 * in every open terminal doing nothing at all -- registered nowhere, holding nothing, with
 * the app still showing the row as synced.
 *
 * The facts `session.start` carried are gone with the old module, so they are read back from
 * the build rather than guessed at. `$.session.surfaces()` is the same reading `session.start`
 * documents for its own `surface` field ("terminal under the REPL; null for a -p run or the
 * SDK, which draw nowhere yet"), and the build's `isInteractive` is described by exactly the
 * same split, so a terminal surface is a person at a prompt and anything else is not. If the
 * call fails there is nothing to assert, and the mod stays off: registering an invented
 * interactive terminal is how a headless run ends up with a hold nobody can answer.
 */
async function ensureLoop($) {
  if (state.retired || state.loopStarted || state.loopDeclined) return;
  await readEnvironment($);
  if (state.disabled || state.spawned || !isAbsolutePath(state.socketPath)) {
    state.loopDeclined = true;
    return;
  }
  if (!state.surface) {
    state.surface = await recoveredSurface($);
    state.interactive = state.surface === 'terminal';
  }
  if (!state.version) state.version = await sessionVersion($);
  if (!state.cwd) {
    try {
      const cwd = await $.session.cwd();
      if (typeof cwd === 'string') state.cwd = cwd;
    } catch (error) {
      log($, 'cwd unavailable: ' + String(error.message || error));
    }
  }
  log($, 'loop restarted without session.start (surface=' + (state.surface || 'none') + ')');
  startLoop($);
}

/** The session's own first surface, or '' when the build will not say. */
async function recoveredSurface($) {
  try {
    const surfaces = await $.session.surfaces();
    const first = Array.isArray(surfaces) && surfaces.length > 0 ? surfaces[0] : '';
    return typeof first === 'string' ? first : '';
  } catch (error) {
    return '';
  }
}

/**
 * An AskUserQuestion answer is returned only when it is exactly the shape the tool
 * validates. A wrong shape does not fall back to the human: the question dies and the
 * model reads a validator error, which is the worst thing this mod can do to a user.
 */
/**
 * Which call a `steer` command becomes: an in-turn append, or an ordinary queued prompt.
 *
 * The broker decides whether to ask for steering at all; this is the mod's own half, so
 * `COSYNCING_CLAUDE_STEER=0` in one terminal really means that terminal keeps its turns
 * unsteered. Neither route loses the message.
 */
export function steerRoute(steeringEnabled) {
  return steeringEnabled === true ? 'append' : 'prompt';
}

// What 2.1.292's AskUserQuestion takes from a hook: answers of up to 8,192 characters each (its
// 32,768 for the whole set is four of them, and a call asks four questions at most). A longer one
// would be refused there, and the person would get the picker after the app had said Sent.
const ANSWER_MAX_CHARS = 8192;
// A number answer, written the way Claude's own number control writes one.
const NUMBER_ANSWER = /^-?\d+(\.\d+)?$/;

/**
 * A multi-select answer read back into its labels, or null for text Claude's picker could not have
 * written. The picker joins the chosen labels with ", " and writes a label holding ", " or a double
 * quote as a JSON string; this is the parser 2.1.292 reads that back with, so a label with a comma
 * in it is one label here, as it is there.
 */
export function splitLabels(answer) {
  const parts = [];
  let rest = answer;
  for (;;) {
    if (rest.startsWith('"')) {
      let end = -1;
      let escaped = false;
      for (let index = 1; index < rest.length; index += 1) {
        const char = rest[index];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          end = index;
          break;
        }
      }
      if (end === -1) return null;
      try {
        const label = JSON.parse(rest.slice(0, end + 1));
        if (typeof label !== 'string') return null;
        parts.push(label);
      } catch (error) {
        return null;
      }
      rest = rest.slice(end + 1);
    } else {
      const comma = rest.indexOf(', ');
      const part = comma === -1 ? rest : rest.slice(0, comma);
      if (part.includes('"')) return null;
      parts.push(part);
      rest = comma === -1 ? '' : rest.slice(comma);
    }
    if (rest === '') break;
    if (!rest.startsWith(', ')) return null;
    rest = rest.slice(2);
    if (rest === '') return null;
  }
  return parts;
}

/**
 * The questions as the broker needs them. An option's `preview` is a mock-up or a snippet Claude
 * draws beside the option; the app does not draw it, and four of them can carry a hold past the
 * broker's 64 KB body, which handed the question back to the picker with no card at all. The tool
 * still gets the questions it asked, untouched.
 */
export function withoutPreviews(questions) {
  return questions.map((question) => {
    if (!question || typeof question !== 'object' || !Array.isArray(question.options)) return question;
    return {
      ...question,
      options: question.options.map((option) => {
        if (!option || typeof option !== 'object' || !('preview' in option)) return option;
        const { preview, ...rest } = option;
        return rest;
      }),
    };
  });
}

export function validateAnswers(questions, answers) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) return false;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return false;
  if (Object.keys(answers).length !== questions.length) return false;
  for (const question of questions) {
    if (!question || typeof question.question !== 'string') return false;
    if (!(question.question in answers)) return false;
    const answer = answers[question.question];
    if (typeof answer !== 'string' || answer.length === 0 || answer.length > ANSWER_MAX_CHARS) return false;
    const kind = question.kind || 'choice';
    if (kind === 'text') continue;
    if (kind === 'number') {
      if (!NUMBER_ANSWER.test(answer)) return false;
      const value = Number(answer);
      if (typeof question.min === 'number' && value < question.min) return false;
      if (typeof question.max === 'number' && value > question.max) return false;
      continue;
    }
    const labels = Array.isArray(question.options)
      ? question.options.map((option) => (option && typeof option.label === 'string' ? option.label : ''))
      : [];
    if (labels.length === 0) return false;
    if (question.multiSelect === true) {
      // A multi-select answer is the chosen labels as the engine's own picker joins them. Every part
      // has to be a real option, once: a stray part means the answer came from a different
      // question set.
      const picked = splitLabels(answer);
      if (!picked || picked.length === 0 || picked.some((part) => !labels.includes(part))) return false;
      if (new Set(picked).size !== picked.length) return false;
    }
    // A single choice may legitimately be the free text the engine hands back for "Other" -- the
    // build says as much of its own dialog -- so a non-label string is a shape we accept. The
    // answer's identity comes from the call it was held on, not from matching a label.
  }
  return true;
}

/**
 * Every field of the tool input, one `key: value` per field, for the card's details.
 *
 * The brief names one argument and cuts it at 240 characters, which is enough to recognise a call
 * and not enough to decide one: the rest of a command, an edit's old and new text, the body of a
 * file being written. Kept off the audit row and out of the debug log, like the brief.
 */
export function fullInput(input) {
  if (!input || typeof input !== 'object') return '';
  const lines = [];
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (value === undefined) continue;
    let text = '';
    if (typeof value === 'string') text = value;
    else {
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value);
      }
    }
    lines.push(key + ': ' + text);
  }
  const whole = lines.join('\n');
  return whole.length > DETAIL_MAX_CHARS ? whole.slice(0, DETAIL_MAX_CHARS) + '\n\u2026' : whole;
}

/**
 * A short, non-transcript summary of the tool input, for the card and the audit row. A plan is
 * summarised by its first line, its title as Claude wrote it; the whole plan is in the details.
 */
export function briefInput(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'prompt', 'plan']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) {
      const text = key === 'plan' ? value.trim().split('\n')[0].trim() : value;
      return key + ': ' + (text.length > 240 ? text.slice(0, 240) + '...' : text);
    }
  }
  return '';
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    state.endedSessionId = '';
    state.betweenTurns = false;
    state.cwd = typeof e.cwd === 'string' ? e.cwd : '';
    state.surface = typeof e.surface === 'string' ? e.surface : '';
    state.interactive = e.isInteractive === true;
    state.version = await sessionVersion($);
    await readEnvironment($);
    // A fresh session owns the loop: the token retires whatever a previous session's loop, or
    // a revived one, was running.
    startLoop($);
    return next(e);
  });

  // `session.attach` says which surface a CLIENT draws on (build: "Where the client draws:
  // what it declared"), and a second field beside it is the client's own id. It says nothing
  // about where THIS session runs, and `SessionAttachInput` carries no cwd at all. Taking the
  // surface from it -- which is what this hook used to do -- meant the first app connection
  // rewrote `terminal` to `desktop`, failed the terminal gate on every later ask, and left
  // the session synced in the app and holding nothing, permanently, with no way back short of
  // a restart. A remote client joining is not a reason to stop asking the person at the
  // keyboard. The loop is revived here because a hot reload leaves no session.start behind,
  // and this is the first hook one can arrive on.
  on('session.attach', async ($, e, next) => {
    await ensureLoop($);
    return next(e);
  });

  on('turn.start', async ($, e, next) => {
    // A turn is running, so whatever session this is has not ended.
    state.endedSessionId = '';
    state.betweenTurns = false;
    // Recorded before the loop is revived, so the registration a revived loop sends carries it.
    if (typeof e.turnId === 'string') state.turnId = e.turnId;
    await ensureLoop($);
    if (typeof e.turnId === 'string') {
      // The broker keeps this so an app Stop with no id can be answered with the turn that is
      // really running, and so a Stop with none, when nothing is running, can be refused.
      report($, 'turn.start', undefined, { turnId: e.turnId });
    }
    return next(e);
  });

  // A hot reload in the middle of a turn leaves the new module without the turn: no `turn.start`
  // comes to it, its registration carries none, and a Stop from the app is refused as
  // `no_active_turn` until the next turn. The turn's next model request does come, with the turn's
  // id (build: the one `turn.start` minted, which every `turn.step` of the turn carries), so a module
  // that does not know the running turn learns it here and says so, the way `turn.start` would
  // have. A subagent's step carries its own run's id, which is not the session's turn. The step
  // itself passes through untouched.
  on('turn.step', async function* ($, e, next) {
    const main = !(typeof e.agentId === 'string' && e.agentId.length > 0);
    if (main && typeof e.turnId === 'string' && e.turnId && e.turnId !== state.turnId) {
      state.endedSessionId = '';
      state.betweenTurns = false;
      state.turnId = e.turnId;
      await ensureLoop($);
      report($, 'turn.start', undefined, { turnId: e.turnId });
    }
    return yield* next(e);
  });

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn is not the main loop's. Every hook sees a child's `turn.complete`, so
    // without this a subagent finishing broke the main band and cancelled the holds its parent
    // was still parked on.
    if (typeof e.agentId === 'string' && e.agentId.length > 0) return next(e);
    breakBand($, 'turn.complete');
    const turnId = typeof e.turnId === 'string' ? e.turnId : '';
    state.turnId = '';
    state.turnEndedAt = Date.now();
    state.betweenTurns = true;
    report($, 'turn.complete', undefined, turnId ? { turnId } : undefined);
    return next(e);
  });

  on('session.end', async ($, e, next) => {
    breakBand($, 'session.end');
    // Cleared BEFORE the report goes out. While it was in flight the broker dropped the row and woke
    // the loop's poll, the loop saw no registration and registered the same id again, and then this
    // handler cleared the id and the loop registered it a second time: a row re-created for a
    // session that had just ended, and two registrations where there should have been none.
    const ended = state.sessionId;
    state.turnEndedAt = Date.now();
    state.sessionId = '';
    state.registeredId = '';
    state.endedSessionId = ended;
    state.transportFailures = 0;
    // Measured on 2.1.289: `/clear` fires `session.end` and no second `session.start` for a
    // plugin mod, so a loop retired here is never restarted and every later hold is refused.
    // The loop survives and registers the NEXT id, which is also what a real process exit costs:
    // nothing, because the process is going anyway and the broker's pid watch closes the row.
    report($, 'session.end', undefined, undefined, ended);
    return next(e);
  });

  on('tool.check', async ($, e, next) => {
    const engine = await next(e);
    if (!engine || engine.decision !== 'ask') return engine;
    if (!canHold()) return engine;

    // A `tool.check` with no tool_use_id is not a call this terminal is about to run. The build
    // says `$.tool.check` runs the same chain as a real permission prompt, so a query from another
    // plugin arrives here too -- and holding one would draw a card for a call nobody is making,
    // then answer whichever call happens to reach the same hold key next.
    const toolUseId = typeof e.tool_use_id === 'string' ? e.tool_use_id : '';
    if (!toolUseId) {
      log($, 'check ' + String(e.tool) + ' has no tool_use_id: a query, not a call; leaving it alone');
      return engine;
    }
    if (!conversationCall(e)) {
      log($, 'check ' + String(e.tool) + ' between turns with no agent: not this conversation\'s call; leaving it alone');
      return engine;
    }

    // AskUserQuestion is not answered here. The build's own declarations put `tool.call` ahead
    // of the permission prompt and this event behind it, and only `tool.call` can answer with a
    // `{result}` the tool actually returns. A permission card for a survey would offer the app a
    // decision that cannot reach the question behind it, so the human's own picker stays the
    // answer for this tool.
    if (e.tool === QUESTION_TOOL) {
      log($, 'check AskUserQuestion decision=' + String(engine && engine.decision) + ': not held here');
      return engine;
    }
    log($, 'check ' + String(e.tool) + ' decision=' + String(engine && engine.decision)
      + ' inputKeys=' + (e.input && typeof e.input === 'object' ? Object.keys(e.input).join(',') : typeof e.input));
    const outcome = await hold($, { tool: e.tool, input: briefInput(e.input), detail: fullInput(e.input), toolUseId, signal: next.signal });
    if (!outcome || outcome.kind !== 'verdict') return engine;
    return { decision: outcome.behavior, reason: 'cosyncing answered this call from ' + outcome.source };
  });

  // The question hold lives here because this is the one place a returned `{result}` becomes the
  // tool's result. `tool.call`'s envelope spreads the tool's arguments beside `tool`, so the
  // questions are `e.questions`, not a nested `e.input.questions`.
  on('tool.call', { tool: QUESTION_TOOL }, async ($, e, next) => {
    const questions = Array.isArray(e.questions) && e.questions.length > 0 ? e.questions : null;
    if (!questions) return next(e);
    log($, 'question tool.call: questions=' + String(questions.length)
      + ' call=' + String(e.tool_use_id || '(none)'));
    if (!canHold()) return next(e);
    // The same rule as `tool.check`: a call with no id is not one this terminal is running, and the
    // id is what makes the hold stand for this call rather than for a counter in this process.
    const toolUseId = typeof e.tool_use_id === 'string' ? e.tool_use_id : '';
    if (!toolUseId) {
      log($, 'question tool.call has no tool_use_id: not a call this terminal runs; leaving it alone');
      return next(e);
    }
    if (!conversationCall(e)) {
      log($, 'question tool.call between turns with no agent: not this conversation\'s call; leaving it alone');
      return next(e);
    }
    const outcome = await hold($, { tool: QUESTION_TOOL, input: '', questions: withoutPreviews(questions), toolUseId, signal: next.signal });
    if (!outcome || outcome.kind !== 'answer') {
      log($, 'question not answered here: outcome=' + String(outcome && outcome.kind));
      return next(e);
    }
    if (!validateAnswers(questions, outcome.answers)) {
      log($, 'answer shape refused: the human gets the picker');
      return next(e);
    }
    return { result: { questions, answers: outcome.answers } };
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const band = headBand();
    if (!band) return next(e);
    // Claude's own picker is on screen: it has the keys, and a band under it cannot be
    // tapped. The hold stays open and the app keeps its card.
    if (e.hasSurvey === true) return next(e);
    band.drawn = true;
    return bandTree($, e, band);
  });
}
