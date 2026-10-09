/**
 * The mod-to-broker wire protocol: shapes, limits, and the codes both sides print.
 *
 * The mod and the broker ship together from the same repository, so `PROTOCOL_VERSION` is a
 * consistency check rather than a negotiation: a mismatch means one of the two was replaced
 * under the other, which is refused and logged rather than papered over. Every message is a
 * single JSON object in the body of a `POST` to one path under `/claude/mod/`; there is no
 * GET leg, because a bodiless GET from Claude's own HTTP client carries no `Content-Length`
 * at all and the reader would have to grow a second framing rule to accept it.
 *
 * What the mod is allowed to keep a copy of is exactly one field: `killSwitch`. The
 * permission mode and the viewer count are decided by the broker at the moment the `hold`
 * arrives, never stamped on a poll response. That is not tidiness: a mode cached from a
 * 20 s long-poll can be twenty seconds older than the broker's own transcript read on top of
 * the transcript flush lag, and the viewer set changes whenever the app opens or closes.
 *
 * Nothing in here carries prompt text. The audit trail answers "who approved this", and ids,
 * kinds, decisions, durations and the mode the gate saw are enough to answer it.
 */

import { claudeAnswerRows, joinClaudeAnswerLabels } from '@cosyncing/adapter-claude';

/** Bumped only when the two halves can no longer talk. A mismatch is refused, not adapted. */
export const MOD_PROTOCOL_VERSION = 1;

/** Namespace of the mod socket. Not an HTTP route on the token-authenticated surface. */
export const MOD_PATH_PREFIX = '/claude/mod/';

/** Long-poll ceiling the mod may ask for. The engine aborts a fetch with no answer inside 30 s. */
export const MAX_POLL_WAIT_MS = 20_000;
/** Default long-poll when the mod does not say. */
export const DEFAULT_POLL_WAIT_MS = 20_000;
/**
 * How long a held call stays open once its terminal has stopped asking about it.
 *
 * A hold has no wall-clock ceiling: the app waits as long as Claude's own dialog would, because
 * the terminal can still answer the whole time. What ends a hold is an event -- an answer from
 * either side, the person handing the call to Claude's dialog, the turn ending, the terminal
 * dying -- and this lease is how the broker notices a terminal that went quiet without saying so.
 * The mod keeps a hold long-poll parked here for as long as it waits, each one renews the lease
 * while it is parked, and the next follows within milliseconds. A hold with no poll for this long
 * belongs to a terminal that is no longer waiting on it, and an answer to it would decide nothing.
 */
export const HOLD_LEASE_MS = 15_000;
/** Freshness: three missed 20 s polls. There is no second timer anywhere in this design. */
export const STALE_AFTER_MS = 3 * MAX_POLL_WAIT_MS;

/**
 * The modes a permission `ask` is held in: the ones where an `ask` is Claude putting the call to a
 * person in its own dialog. Plan mode is one -- measured on 2.1.292, a plan-mode `ask` opens the
 * same dialog default mode does. Auto mode is not: `tool.check` runs before its classifier, which
 * settles most asks with nobody shown anything, and an app answer there would take the
 * classifier's seat. `dontAsk` turns an `ask` into a denial after the hooks have run, so holding
 * one would let the app allow what the mode refuses. Anything else is released at once.
 */
export const HOLDABLE_PERMISSION_MODES: readonly string[] = ['default', 'acceptEdits', 'plan'];
/**
 * The modes a question is held in: the ones where Claude puts AskUserQuestion's picker in front of
 * a person, which is a different question from who approves a tool call. Measured on 2.1.292: the
 * picker opens in auto mode, and `dontAsk` refuses the question outright, so the app must not
 * answer one there either. `bypassPermissions` is left to the terminal because it is unmeasured.
 */
export const HOLDABLE_QUESTION_MODES: readonly string[] = ['default', 'acceptEdits', 'plan', 'auto'];
/**
 * Release reasons that draw nothing in the app. In auto mode the classifier settles the call and in
 * `dontAsk` Claude refuses it, both without showing anyone a dialog, so a card saying the prompt
 * was left to the terminal described a prompt that did not exist -- once for nearly every tool call
 * of an auto-mode turn. The release is still audited.
 */
export const UNCARDED_RELEASE_REASONS: readonly string[] = ['mode:auto', 'mode:dontAsk'];
/** The tool whose approval also chooses how Claude continues: only Claude's own dialog offers that. */
export const PLAN_APPROVAL_TOOL = 'ExitPlanMode';

/** Wire targets. One request per connection, so a request is addressed by its path alone. */
export type ModRoute = 'register' | 'poll' | 'hold' | 'event';

/** Wire targets, literal-typed so a handler can branch on the route and narrow. */
export const MOD_ROUTES: Record<ModRoute, string> = {
  register: '/claude/mod/register',
  poll: '/claude/mod/poll',
  hold: '/claude/mod/hold',
  event: '/claude/mod/event',
};

/**
 * Stable refusal codes. `claude plugin validate` output, the mod's own log line and the
 * broker's log all quote these strings, so they are API: add, never rename.
 */
export type ModRefusalCode =
  // Framing (see `mod-http-reader.ts`), repeated here because the socket server answers some
  // of them itself when it is the caller rather than the reader.
  | 'method_not_allowed'
  | 'unsupported_header'
  | 'content_length_required'
  | 'trailing_bytes'
  | 'header_too_large'
  | 'body_too_large'
  | 'header_deadline'
  /** A declared body that stopped arriving. 408, for the same reason the header deadline is. */
  | 'body_deadline'
  /** A header line with no field name, or a folded continuation. Refused, not repaired. */
  | 'malformed_header'
  /** Two `Content-Length` values that disagree, which is request smuggling rather than a typo. */
  | 'duplicate_content_length'
  | 'request_line'
  // Registration and identity.
  | 'uid_mismatch'
  | 'peer_unavailable'
  | 'broker_child'
  | 'claude_version_too_old'
  | 'protocol_version_mismatch'
  | 'invalid_message'
  | 'unknown_route'
  | 'json_invalid'
  // Command delivery.
  | 'no_registration'
  | 'invalid_command'
  /** The text is longer than cosyncing will carry to a terminal. Refused at the door rather than
   *  truncated on the way in: half a prompt is a different instruction, not a smaller one. */
  | 'command_too_large'
  | 'queue_full'
  /** The row exists but its poll chain stopped, so nothing could receive the command. Accepting
   *  it and dropping it at the queue's TTL is how a prompt used to vanish without a word. */
  | 'stale_registration'
  /** Stop was asked for and no turn is running. Not an error to paper over: the app says so. */
  | 'no_active_turn'
  /** A second live process asked for a session another live process already claimed. The owner
   *  rule is first-come: the newcomer stays Observe and retries on its normal poll cadence. */
  | 'session_claimed'
  /** The kernel's peer pid is not the pid the row was registered under. Every route checks this,
   *  not just `register`: a queue read, a hold or a `hold.answer` from a process nobody registered
   *  is somebody else's session. */
  | 'peer_mismatch'
  /** The `sid` in the query and the `sessionId` in the body disagree, so the row the caller is
   *  aimed at and the row it claims to be are not the same row. */
  | 'session_mismatch'
  /** A newer evaluation of the mod module, in the same process, holds this session: the caller is
   *  the module a hot reload replaced. It stops for good rather than registering again, which is
   *  what used to turn one reload into two loops taking the row from each other on every round. */
  | 'superseded';

/** HTTP status each refusal answers with. A refusal is never a 5xx: nothing here is the mod's fault to fix. */
export const MOD_REFUSAL_STATUS: Record<ModRefusalCode, number> = {
  method_not_allowed: 405,
  unsupported_header: 400,
  content_length_required: 400,
  trailing_bytes: 400,
  header_too_large: 431,
  body_too_large: 413,
  header_deadline: 408,
  body_deadline: 408,
  malformed_header: 400,
  duplicate_content_length: 400,
  request_line: 400,
  uid_mismatch: 403,
  peer_unavailable: 403,
  broker_child: 403,
  claude_version_too_old: 400,
  protocol_version_mismatch: 400,
  invalid_message: 400,
  unknown_route: 404,
  json_invalid: 400,
  no_registration: 409,
  invalid_command: 400,
  command_too_large: 413,
  queue_full: 409,
  stale_registration: 409,
  no_active_turn: 409,
  session_claimed: 409,
  peer_mismatch: 403,
  session_mismatch: 403,
  superseded: 409,
};

/** Why the broker declined to hold a permission call. Carried to the app so a card can explain itself. */
export type ModReleaseReason =
  | 'mode:auto'
  | 'mode:dontAsk'
  | 'mode:bypassPermissions'
  | 'mode:unknown'
  | 'viewer:none'
  | 'killSwitch'
  /**
   * A question the app cannot answer the way Claude's tool will take it: a number, a multi-select
   * whose labels cannot be told apart once joined, or a payload the app cannot draw. It is shown
   * read-only, and the person answers it in the terminal.
   */
  | 'question:terminal-only'
  /**
   * Claude's plan, put to the person for approval. Approving it in Claude's dialog also picks how
   * Claude carries on (accept edits or approve each one), and measured on 2.1.292 a mod's `allow`
   * does not close that dialog. The plan is shown read-only, and the person answers in the terminal.
   */
  | 'plan:terminal-only';

/**
 * The mode that decided a hold was not taken, as the reason that names it.
 *
 * The rule is short -- cosyncing holds only where Claude asks a person (HOLDABLE_PERMISSION_MODES,
 * HOLDABLE_QUESTION_MODES) -- but the card has to say which mode it read, because "not held" is
 * not information and "you were bypassing permissions" is. A mode name it does not know is
 * `mode:unknown`, never another mode's sentence.
 *
 * There is no `manual` here. The permission pane's "manual" is written to the transcript as
 * `default`, and is held like it; a scan of about 34,700 recorded mode values found no `manual`.
 * A reason for a value Claude does not write only ever reached a card as a claim about the
 * person's terminal that was not true.
 */
export function modModeReleaseReason(mode: string | undefined): ModReleaseReason {
  switch (mode) {
    case 'auto':
      return 'mode:auto';
    case 'dontAsk':
      return 'mode:dontAsk';
    case 'bypassPermissions':
      return 'mode:bypassPermissions';
    default:
      // `undefined` is no mode row yet rather than an unreadable one, and this is also the
      // answer for any mode name Claude invents next month: we could not tell what the mode
      // was, so we did not touch the call.
      return 'mode:unknown';
  }
}

/** Why a held call stopped without a verdict, when the reason was not one of the four gates. */
export type ModHoldCancelReason = 'turn-complete' | 'user-cancel' | 'transport' | 'replaced' | 'deadline';

/**
 * What a response may name as the reason a held call stopped.
 *
 * The four gate reasons and the cancel reasons are one union on the wire and two ideas in the
 * code. Naming a turn-complete cancel `viewer:none` told the mod, and any log it leaves, that
 * nobody was watching when the truth was that the turn had simply ended.
 */
export type ModWireReleaseReason = ModReleaseReason | ModHoldCancelReason;

/** Who answered a held call: a tap in the app, the terminal band, or nobody before the hold lapsed. */
export type ModDecisionSource = 'app' | 'band' | 'expired';

export interface ModRegisterMessage {
  protocolVersion: number;
  sessionId: string;
  cwd: string;
  claudeVersion: string;
  model?: string;
  isInteractive: boolean;
  surface: string;
  /**
   * The mod's own guess at its pid, kept for the log and never trusted. The authoritative pid
   * is the kernel's peer credential; `peerPidAgrees` is how a divergence becomes visible.
   */
  reportedPid?: number;
  /**
   * Which evaluation of the mod module is registering, as `<epoch ms in base 36>-<random>`.
   *
   * A hot reload evaluates the module again inside the same Claude process, so the kernel's pid
   * cannot tell the two apart, and the old module's request chain keeps running after the reload.
   * The time it was evaluated orders the two: the newer one keeps the row and the older one is
   * answered `superseded`. Optional, because a mod that predates it must still register.
   */
  instance?: string;
  /**
   * The turn the mod says is running as it registers, or absent for none.
   *
   * A registration replaces the row, and a row is born knowing no turn. That was right for a new
   * process and wrong for every other re-registration: a broker restart mid-turn, or a hot reload
   * whose first hook is the turn's own `turn.start`, left the broker believing nothing ran, so a
   * Stop from the app was refused as `no_active_turn` with the terminal plainly working.
   */
  turnId?: string;
  /**
   * When the mod last saw the session's main turn end, in ms since the epoch, or absent for never.
   *
   * The broker keeps that time in memory, and a history read restates a run the transcript left open
   * as cancelled only when it started before it. A restarted broker has forgotten it, and a turn
   * stopped from the app writes no interruption row, so the stopped turn read as running again. The
   * mod remembers it across the restart. Not refused when unusable: it is a hint, and a terminal
   * that loses its registration over one loses true sync.
   */
  turnEndedAt?: number;
}

export interface ModPollMessage {
  sessionId: string;
  /** Milliseconds, capped at `MAX_POLL_WAIT_MS`. */
  wait: number;
}

export interface ModHoldMessage {
  sessionId: string;
  requestId: string;
  tool: string;
  /** The engine's own verdict, which is `ask` for every hold by construction. */
  decision: string;
  /** Tool input summary as the mod was given it. Bounded; never a retained transcript. */
  input?: string;
  /** Every field of the tool input, for the card's details. Bounded; kept only while the hold is
   *  alive, and never written to the audit row or a log. */
  detail?: string;
  /** Question payload for an `AskUserQuestion` hold, kept only while the hold is alive. */
  questions?: unknown;
  /** The hold carried a question payload this broker cannot read, so it can only be answered in the terminal. */
  questionsUnreadable?: true;
  /** The engine's id for the call this hold stands for, when the mod was given one. */
  toolUseId?: string;
}

export interface ModEventMessage {
  sessionId: string;
  kind: string;
  requestId?: string;
  /** Event-specific envelope: ids, durations, decisions. Never prompt text. */
  detail?: Record<string, unknown>;
}

export type ModCommandOp = 'prompt' | 'steer' | 'abort' | 'answer';

export interface ModCommand {
  requestId: string;
  op: ModCommandOp;
  /** `prompt` and `steer`. */
  text?: string;
  /** `abort`: the turn id from `turn.start`. */
  turnId?: string;
  /** `answer`: the validated question answer. */
  answers?: unknown;
  /** Wall-clock ms at which the broker queued it, so a stale command can be dropped. */
  queuedAt: number;
}

export interface ModState {
  killSwitch: boolean;
}

export type ModPollResponse =
  | { ok: true; state: ModState }
  /** The hold was opened by THIS request. Answered at once, before the wait for the verdict, so
   *  the mod can put its band up exactly when somebody is really waiting and not before. */
  | { ok: true; state: ModState; held: true }
  | { ok: true; state: ModState; command: ModCommand }
  | { ok: true; state: ModState; release: { requestId: string; why: ModReleaseReason } }
  | { ok: true; state: ModState; verdict: { requestId: string; behavior: 'allow' | 'deny'; source: ModDecisionSource } }
  /** A question answered in the app. It travels on the same two legs as a verdict, because the
   *  mod could be parked on either one when the answer lands. */
  | { ok: true; state: ModState; answer: { requestId: string; answers: unknown } }
  /** On the hold leg only: this call's outcome has already gone out on the other leg. The mod takes
   *  it from there and never offers the call again. */
  | { ok: true; state: ModState; settledElsewhere: { requestId: string } };

export interface ModRegisterReply {
  ok: true;
  /** Kernel-reported peer pid. Authority for the pid watch. */
  peerPid: number;
  peerUid: number;
  /** False when the mod's own guess disagreed; logged, kept, and the row still stands. */
  peerPidAgrees: boolean;
  state: 'live' | 'observe';
  killSwitch: boolean;
}

export interface ModFailure {
  ok: false;
  code: ModRefusalCode;
  /** Human-readable, for the mod's own log and for a terminal operator reading it. */
  message?: string;
}

/** Body builder for every non-OK answer on the socket. */
export function refusalBody(code: ModRefusalCode, message?: string): string {
  const payload: ModFailure = message ? { ok: false, code, message } : { ok: false, code };
  return JSON.stringify(payload);
}

/** A module-instance tag as the mod mints it: `<epoch ms, base 36>-<random>`, nothing else. */
const MOD_INSTANCE_PATTERN = /^[a-z0-9]{1,16}-[A-Za-z0-9_]{1,40}$/;

/** The tag, when it is one; anything else is treated as absent rather than trusted. */
export function modInstanceTag(value: unknown): string | undefined {
  return typeof value === 'string' && MOD_INSTANCE_PATTERN.test(value) ? value : undefined;
}

/** When the module behind a tag was evaluated, in epoch ms, or undefined for a tag that is not one. */
export function modInstanceBornAt(tag: string | undefined): number | undefined {
  if (!tag || !MOD_INSTANCE_PATTERN.test(tag)) return undefined;
  const born = parseInt(tag.slice(0, tag.indexOf('-')), 36);
  return Number.isFinite(born) && born > 0 ? born : undefined;
}

/**
 * Is `tag` an older evaluation of the module than `current`, the one that holds the row?
 *
 * Only a strict "older" answers yes. Two tags that cannot be ordered are not ordered: refusing on
 * a guess would retire a module that may be the newest one in the process.
 */
export function modInstanceIsOlder(tag: string | undefined, current: string | undefined): boolean {
  if (!tag || !current || tag === current) return false;
  const mine = modInstanceBornAt(tag);
  const theirs = modInstanceBornAt(current);
  if (mine === undefined || theirs === undefined) return false;
  return mine < theirs || (mine === theirs && tag < current);
}

/**
 * The shapes every identifier on this wire must have, checked before anything is keyed, logged or
 * drawn by one.
 *
 * Each was a bounded string and nothing more. A NUL inside an id let two hold keys collide, because
 * the store joins its key parts with NUL; a control character in a session id or a version reached
 * the broker's own log line, where it could forge one; and a session id over 256 characters was cut
 * one way by the peer check and another by the parser, so the two disagreed about which row was
 * meant. A session id is what Claude mints, a UUID. Every other id is what the mod, Claude and the
 * adapter actually mint -- `cm-3`, `toolu_01…`, a turn's UUID, `mod-cmd-…` -- and nothing else.
 */
const SESSION_ID_PATTERN = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const WIRE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** `2.1.289`, `2.1.289-dev.1`, `v2.1.290+local`. */
const VERSION_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/;
/** `terminal`, `vscode`, `sdk-ts`. */
const SURFACE_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
/** `turn.start`, `hold.answer`, `user-cancel`. */
const EVENT_KIND_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
/** Claude's tool names, MCP ones included (`mcp__server__tool`). */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/** A model id: printable ASCII and nothing a log line could be broken by. */
const MODEL_PATTERN = /^[\x21-\x7e]{1,128}$/;
/** The engine's own verdict word. */
const DECISION_PATTERN = /^[a-z]{1,32}$/;

/** A Claude session id, or undefined for anything that is not one. */
export function modSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value) ? value : undefined;
}

/** A request, tool-use, turn or command id, or undefined for anything that is not one. */
export function modWireId(value: unknown): string | undefined {
  return typeof value === 'string' && WIRE_ID_PATTERN.test(value) ? value : undefined;
}

/**
 * Split a request target into its route and its `sid` and `inst` query parameters.
 *
 * `invalid` says why the query cannot be trusted: an escape that does not decode, or a `sid` that is
 * not a session id. The caller answers it 400. A malformed escape used to throw out of here and
 * reach the client as a 500, and a `sid` was used however long and whatever it held.
 */
export function parseModTarget(target: string): { route: ModRoute | null; sid: string | undefined; inst: string | undefined; path: string; invalid?: string } {
  const [path = '', query = ''] = target.split('?');
  let route: ModRoute | null = null;
  for (const name of Object.keys(MOD_ROUTES) as ModRoute[]) {
    if (path === MOD_ROUTES[name]) route = name;
  }
  let sid: string | undefined;
  let inst: string | undefined;
  let invalid: string | undefined;
  for (const pair of query.split('&')) {
    const [key, value] = pair.split('=');
    if (key === 'sid' && value) {
      let decoded: string | undefined;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        invalid = 'the sid query parameter is not valid percent-encoding';
        continue;
      }
      sid = modSessionId(decoded);
      if (!sid) invalid = 'the sid query parameter is not a Claude session id';
    }
    if (key === 'inst' && value) inst = modInstanceTag(value);
  }
  return { route, sid, inst, path, ...(invalid ? { invalid } : {}) };
}

/**
 * Ceiling on the text of a `prompt` or `steer` command.
 *
 * Measured context: the mod socket's inbound body ceiling is 64 KB, and one Bun write on a Unix
 * socket carries 219264 bytes on Linux (Bun 1.3.14) and 8192 on macOS 26 arm64 (Bun 1.3.8) before
 * it stops. The response is written in a loop, so the ceiling here is about reasonableness rather
 * than a hard write limit -- it sits well inside what the response path delivers, and well outside
 * what anyone pastes into a terminal on purpose. Above it the command is refused with
 * `command_too_large` BEFORE it is queued, because the alternative -- truncating -- sends the agent
 * a different instruction than the one the user wrote.
 */
export const MAX_COMMAND_TEXT_BYTES = 32 * 1024;

const BOUNDED_STRING = 4096;

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}...[truncated]` : trimmed;
}

/**
 * How much of a call's input the card's details carry: the broker's own bound on what it holds in
 * memory and fans to every seat. The mod cuts at 8,000 and adds its ellipsis; this sits just above
 * that, so a current mod's text is never cut twice.
 */
export const MOD_DETAIL_MAX_CHARS = 8 * 1024;

/** The details as the mod sent them, cut at {@link MOD_DETAIL_MAX_CHARS} with an ellipsis, which
 *  reads the same in every locale. Line breaks are kept: an edit's text is lines. */
function boundedDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MOD_DETAIL_MAX_CHARS ? `${trimmed.slice(0, MOD_DETAIL_MAX_CHARS)}\n\u2026` : trimmed;
}

function failure(code: ModRefusalCode, message: string): { ok: false; failure: ModFailure } {
  return { ok: false, failure: { ok: false, code, message } };
}

/**
 * Validate a `register` body. The refusals here are the ones a real mod can hit in the field:
 * a protocol skew after a partial upgrade, and a Claude that predates the floor.
 */
export function parseModRegister(raw: unknown): { ok: true; message: ModRegisterMessage } | { ok: false; failure: ModFailure } {
  const body = raw as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return failure('invalid_message', 'register body is not an object');
  const sessionId = modSessionId(body.sessionId);
  if (!sessionId) return failure('invalid_message', 'register requires a sessionId that is a Claude session id');
  const protocolVersion = Number(body.protocolVersion);
  if (!Number.isInteger(protocolVersion)) return failure('invalid_message', 'register requires protocolVersion');
  const cwd = boundedText(body.cwd, BOUNDED_STRING) ?? '';
  if (cwd.includes('\0')) return failure('invalid_message', 'register cwd contains a NUL');
  const claudeVersion = typeof body.claudeVersion === 'string' && VERSION_PATTERN.test(body.claudeVersion) ? body.claudeVersion : undefined;
  if (!claudeVersion) return failure('invalid_message', 'register requires a claudeVersion of letters, digits and . + - _');
  if (body.surface !== undefined && !(typeof body.surface === 'string' && SURFACE_PATTERN.test(body.surface))) {
    return failure('invalid_message', 'register surface is not a surface name');
  }
  const surface = typeof body.surface === 'string' ? body.surface : '';
  if (body.turnId !== undefined && !modWireId(body.turnId)) return failure('invalid_message', 'register turnId is not a turn id');
  const reportedPidRaw = body.reportedPid;
  const reportedPid = typeof reportedPidRaw === 'number' && Number.isInteger(reportedPidRaw) && reportedPidRaw > 0 ? reportedPidRaw : undefined;
  const model = typeof body.model === 'string' && MODEL_PATTERN.test(body.model) ? body.model : undefined;
  const turnEndedAt = typeof body.turnEndedAt === 'number' && Number.isSafeInteger(body.turnEndedAt) && body.turnEndedAt > 0
    ? body.turnEndedAt
    : undefined;
  return {
    ok: true,
    message: {
      protocolVersion,
      sessionId,
      cwd,
      claudeVersion,
      ...(model ? { model } : {}),
      isInteractive: body.isInteractive === true,
      surface,
      ...(reportedPid === undefined ? {} : { reportedPid }),
      ...(modInstanceTag(body.instance) ? { instance: modInstanceTag(body.instance) } : {}),
      ...(modWireId(body.turnId) ? { turnId: modWireId(body.turnId) } : {}),
      ...(turnEndedAt === undefined ? {} : { turnEndedAt }),
    },
  };
}

/** Validate a `poll` body and clamp its wait. A long-poll is never longer than the engine allows. */
export function parseModPoll(raw: unknown, sessionId?: string): { ok: true; message: ModPollMessage } | { ok: false; failure: ModFailure } {
  const body = raw as Record<string, unknown> | null;
  const id = modSessionId((body ?? {})?.sessionId ?? sessionId);
  if (!id) return failure('invalid_message', 'poll requires a sessionId that is a Claude session id');
  const requested = Number(body?.wait);
  const wait = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_POLL_WAIT_MS) : DEFAULT_POLL_WAIT_MS;
  return { ok: true, message: { sessionId: id, wait } };
}

/** Validate a `hold` body. The tool name is required because the audit row and the card both name it. */
export function parseModHold(raw: unknown, sessionId?: string): { ok: true; message: ModHoldMessage } | { ok: false; failure: ModFailure } {
  const body = raw as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return failure('invalid_message', 'hold body is not an object');
  const id = modSessionId(body.sessionId ?? sessionId);
  const requestId = modWireId(body.requestId);
  const tool = typeof body.tool === 'string' && TOOL_NAME_PATTERN.test(body.tool) ? body.tool : undefined;
  if (!id || !requestId || !tool) return failure('invalid_message', 'hold requires a session id, a request id and a tool name, each in its own shape');
  if (body.decision !== undefined && !(typeof body.decision === 'string' && DECISION_PATTERN.test(body.decision))) {
    return failure('invalid_message', 'hold decision is not a verdict word');
  }
  const decision = typeof body.decision === 'string' ? body.decision : 'ask';
  const input = boundedText(body.input, 8 * 1024);
  const detail = boundedDetail(body.detail);
  if (body.toolUseId !== undefined && !modWireId(body.toolUseId)) return failure('invalid_message', 'hold toolUseId is not a tool-use id');
  const toolUseId = modWireId(body.toolUseId);
  return {
    ok: true,
    message: {
      sessionId: id,
      requestId,
      tool,
      decision,
      ...(input ? { input } : {}),
      ...(detail ? { detail } : {}),
      // Which call this hold stands for. The card and the audit both read it, and it is what makes
      // a hold key refer to a tool call rather than to a counter inside one process.
      ...(toolUseId ? { toolUseId } : {}),
      // A question payload the app cannot draw is kept as a fact, not as questions: the call is
      // still a question, and drawn as a permission card it offered an Allow the mod then threw
      // away. It is shown read-only and answered in the terminal.
      ...(modQuestionsShape(body.questions) ? { questions: body.questions } : {}),
      ...(body.questions !== undefined && !modQuestionsShape(body.questions) ? { questionsUnreadable: true as const } : {}),
    },
  };
}

/**
 * Is this a question payload the app can render? The shape is Claude's own tool's shape: one to
 * four questions, each with its text and at least one option with a label.
 *
 * Checked on the way in rather than at the card, because the alternative is a question card the
 * app cannot draw. A payload that fails is dropped and the hold carries on as a plain permission
 * card, which the human can still answer; the questions are the mod's copy of a tool input, not
 * a fact the broker has any reason to trust on presentation.
 */
export function modQuestionsShape(questions: unknown): questions is { question: string; options: { label: string }[] }[] {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) return false;
  return questions.every((question) => {
    if (!question || typeof question !== 'object') return false;
    const row = question as Record<string, unknown>;
    if (typeof row.question !== 'string' || row.question.length === 0 || row.question.length > 4 * 1024) return false;
    // A text or number question has no options to draw: its answer is typed.
    if (row.kind === 'text' || row.kind === 'number') return row.options === undefined || Array.isArray(row.options);
    if (!Array.isArray(row.options)) return false;
    return (row.options as unknown[]).some((option) => {
      if (!option || typeof option !== 'object') return false;
      const label = (option as Record<string, unknown>).label;
      return typeof label === 'string' && label.length > 0 && label.length <= 1024;
    });
  });
}

/**
 * The longest answer Claude takes from a hook: 8,192 characters, the limit 2.1.292's AskUserQuestion
 * holds each of a hook's answers to. Its limit on the whole set, 32,768, is four of these, and a
 * call asks four questions at most. The mod refuses a longer answer, so the broker does.
 */
export const MOD_ANSWER_MAX_CHARS = 8192;

/** A number answer, written the way Claude's own number control writes one. */
const MOD_NUMBER_ANSWER = /^-?\d+(\.\d+)?$/;

/**
 * A multi-select answer, spelled the way Claude's own picker spells it, and read back. The adapter
 * owns both halves, because its transcript mapper reads Claude's answers back too.
 */
export { joinClaudeAnswerLabels as modJoinLabels, splitClaudeAnswerLabels as modSplitLabels } from '@cosyncing/adapter-claude';

/** One question as the answer rule reads it. */
interface ModQuestionRule {
  question: string;
  kind: 'choice' | 'text' | 'number';
  labels: string[];
  multiple: boolean;
  /** A number question's range, when the question gave a usable one. */
  min?: number;
  max?: number;
}

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function modQuestionRule(question: unknown): ModQuestionRule | undefined {
  const row = question as Record<string, unknown> | null;
  if (!row || typeof row !== 'object' || typeof row.question !== 'string' || !row.question) return undefined;
  const kind = row.kind === 'text' || row.kind === 'number' ? row.kind : 'choice';
  const labels = Array.isArray(row.options)
    ? row.options.flatMap((option) => {
      const label = (option as Record<string, unknown> | null)?.label;
      return typeof label === 'string' && label.length > 0 ? [label] : [];
    })
    : [];
  return {
    question: row.question,
    kind,
    labels,
    multiple: row.multiSelect === true || row.multiple === true,
    ...(kind === 'number' && finiteNumber(row.min) ? { min: row.min } : {}),
    ...(kind === 'number' && finiteNumber(row.max) ? { max: row.max } : {}),
  };
}

/**
 * Whether the app can answer this question the way Claude's tool will take it. The ONE rule: the
 * card offers only what it allows, and an answer is accepted only when it keeps to it, so the app
 * never says Sent while the terminal opens Claude's own picker.
 *
 * - A number is one number from its `min` to its `max`, written the way Claude's own control writes
 *   it. A number question with no usable range is one Claude's own schema refuses, and it stays in
 *   the terminal.
 * - A multi-select answer is its labels, joined the way Claude's picker joins them (`modJoinLabels`)
 *   and read back by the mod with Claude's own parser, so a comma or a quote in a label is fine. A
 *   label with space at either end is not: the app trims what it draws, and would send a label the
 *   question does not have. Free text is never offered on one.
 * - A single choice may be any label, or free text, which is the tool's own "Other".
 */
export function modQuestionAnswerable(question: unknown): boolean {
  const rule = modQuestionRule(question);
  if (!rule) return false;
  if (rule.kind === 'number') return rule.min !== undefined && rule.max !== undefined && rule.min < rule.max;
  if (rule.kind === 'text') return true;
  if (rule.labels.length === 0) return false;
  if (!rule.multiple) return true;
  return rule.labels.every((label) => label === label.trim()) && new Set(rule.labels).size === rule.labels.length;
}

/** Whether every question in a set is answerable from the app, and the answers can be told apart. */
export function modQuestionsAnswerable(questions: unknown): boolean {
  if (!modQuestionsShape(questions)) return false;
  const texts = (questions as { question: string }[]).map((question) => question.question);
  if (new Set(texts).size !== texts.length) return false;
  return (questions as unknown[]).every((question) => modQuestionAnswerable(question));
}

/** Validate an `event` body. Kinds are not an enum here on purpose: an unknown kind is stored, never guessed at. */
export function parseModEvent(raw: unknown, sessionId?: string): { ok: true; message: ModEventMessage } | { ok: false; failure: ModFailure } {
  const body = raw as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return failure('invalid_message', 'event body is not an object');
  const id = modSessionId(body.sessionId ?? sessionId);
  const kind = typeof body.kind === 'string' && EVENT_KIND_PATTERN.test(body.kind) ? body.kind : undefined;
  if (!id || !kind) return failure('invalid_message', 'event requires a session id and a kind, each in its own shape');
  if (body.requestId !== undefined && !modWireId(body.requestId)) return failure('invalid_message', 'event requestId is not a request id');
  const requestId = modWireId(body.requestId);
  const detail = body.detail && typeof body.detail === 'object' ? (body.detail as Record<string, unknown>) : undefined;
  return { ok: true, message: { sessionId: id, kind, ...(requestId ? { requestId } : {}), ...(detail ? { detail } : {}) } };
}

/** Validate a command before it is ever queued: never dequeue what you cannot serve. */
export function validateModCommand(command: ModCommand): { ok: true } | { ok: false; failure: ModFailure } {
  if (!command || typeof command !== 'object') return failure('invalid_command', 'command is not an object');
  if (!modWireId(command.requestId)) return failure('invalid_command', 'command requires a request id');
  switch (command.op) {
    case 'prompt':
    case 'steer': {
      const text = typeof command.text === 'string' ? command.text.trim() : '';
      if (!text) return failure('invalid_command', `${command.op} requires text`);
      // Byte length, not character count: the ceiling is about what leaves this process, and a
      // pasted CJK prompt is three bytes a character.
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_COMMAND_TEXT_BYTES) {
        return failure('command_too_large', `${command.op} is ${bytes} bytes, ceiling ${MAX_COMMAND_TEXT_BYTES}`);
      }
      return { ok: true };
    }
    case 'abort':
      // The turn id is the broker's to supply, not the app's: the app cannot know which turn the
      // terminal is on. `enqueue` stamps the registration's current turn, so an abort that
      // arrives with none is refused upstream as `no_active_turn` rather than reaching the mod
      // with an id it would have to guess. A caller that does send one is checked for shape, and
      // the mod refuses an id that is not the turn it is running.
      return command.turnId === undefined || modWireId(command.turnId)
        ? { ok: true }
        : failure('invalid_command', 'abort turnId is not a usable id');
    case 'answer':
      return command.answers === undefined ? failure('invalid_command', 'answer requires answers') : { ok: true };
    default:
      return failure('invalid_command', `unknown op (${String(command.op)})`);
  }
}

/**
 * A question payload the app can render, in the shape the mod sent it.
 *
 * Two names for one idea meet here, and both are load-bearing. Claude's AskUserQuestion calls a
 * multi-select question `multiSelect`; cosyncing's contract calls it `multiple`. The mapping is
 * asserted in both directions by `test:claude-mod-service`, because a card that does not know a
 * question takes several answers draws radio buttons and silently drops everything but the first.
 */
export interface ModQuestionView {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiple: boolean;
  /** False when only the listed labels are accepted: no free-text field is drawn. Absent means true. */
  freeText?: false;
  /** How it is answered, when not by picking: typed text, or a number. Absent means choice. */
  kind?: 'text' | 'number';
  /** A number question's range, its step and its unit, as Claude's question gave them. */
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

/** The mod's question list as the contract's, mapping `multiSelect` to `multiple`. */
export function modQuestionViews(questions: unknown): ModQuestionView[] {
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((question) => {
    const row = question as Record<string, unknown> | null;
    if (!row || typeof row.question !== 'string' || !row.question) return [];
    const options = Array.isArray(row.options)
      ? row.options.flatMap((option) => {
        const o = option as Record<string, unknown> | null;
        if (!o || typeof o.label !== 'string' || !o.label) return [];
        return [{
          label: o.label,
          ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}),
        }];
      })
      : [];
    const multiple = row.multiSelect === true || row.multiple === true;
    const kind = row.kind === 'text' || row.kind === 'number' ? row.kind : undefined;
    return [{
      question: row.question,
      ...(typeof row.header === 'string' && row.header ? { header: row.header } : {}),
      options,
      multiple,
      // The same rule `modAnswerMap` applies: a multi-select is answered with its labels and nothing
      // else, so the card draws no free-text field for one.
      ...(multiple && row.kind !== 'text' ? { freeText: false as const } : {}),
      // A number question names its range, so the card can draw a number field that keeps to it.
      ...(kind ? { kind } : {}),
      ...(kind === 'number' && finiteNumber(row.min) ? { min: row.min } : {}),
      ...(kind === 'number' && finiteNumber(row.max) ? { max: row.max } : {}),
      ...(kind === 'number' && finiteNumber(row.step) && row.step > 0 ? { step: row.step } : {}),
      ...(kind === 'number' && typeof row.unit === 'string' && row.unit.trim() && row.unit.length <= 32 ? { unit: row.unit.trim() } : {}),
    }];
  });
}

/** The contract's question list as Claude's, mapping `multiple` back to `multiSelect`. */
export function modQuestionsFromViews(views: readonly ModQuestionView[]): Record<string, unknown>[] {
  return views.map((view) => ({
    question: view.question,
    ...(view.header ? { header: view.header } : {}),
    options: view.options,
    multiSelect: view.multiple === true,
  }));
}

/**
 * The app's answer rows, converted to the map the tool validates.
 *
 * `answers` on the wire is one array of selected labels per question, in question order -- that
 * is what `outbound_frame.dart` sends and what every other agent's question card uses. Claude's
 * AskUserQuestion takes `{ [question text]: answer }`, with a multi-select answer comma-joined.
 * This is the only place either shape can be converted, because it is the only place the
 * questions are known: the app sends positions, and a position means nothing without the question
 * it came from.
 *
 * A mismatch is refused rather than guessed at. An answer put on the wrong question is words in
 * the user's mouth that the model will believe, which is worse than the card staying open.
 */
export function modAnswerMap(questions: unknown, rows: unknown): Record<string, string> | undefined {
  // The rule first: a question set the app could not answer faithfully takes no answer from it.
  if (!modQuestionsAnswerable(questions)) return undefined;
  const rules = (questions as unknown[]).map((question) => modQuestionRule(question)!);
  if (!Array.isArray(rows) || rows.length !== rules.length) return undefined;
  const answers: Record<string, string> = {};
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]!;
    const picked = rows[index];
    if (!Array.isArray(picked) || picked.length === 0) return undefined;
    if (!picked.every((value) => typeof value === 'string' && (value as string).trim().length > 0)) return undefined;
    const values = picked.map((value) => String(value).trim());
    const multiSelect = rule.kind === 'choice' && rule.multiple;
    if (!multiSelect && values.length !== 1) return undefined;
    // A multi-select answer is labels, each once: the mod reads back every one of them.
    if (multiSelect && (values.some((value) => !rule.labels.includes(value)) || new Set(values).size !== values.length)) return undefined;
    // A number is written as Claude's control writes one, inside the question's range.
    if (rule.kind === 'number') {
      const value = values[0]!;
      if (!MOD_NUMBER_ANSWER.test(value) || Number(value) < rule.min! || Number(value) > rule.max!) return undefined;
    }
    const joined = multiSelect ? joinClaudeAnswerLabels(values) : values[0]!;
    if (joined.length > MOD_ANSWER_MAX_CHARS) return undefined;
    if (Object.prototype.hasOwnProperty.call(answers, rule.question)) return undefined;
    answers[rule.question] = joined;
  }
  return answers;
}

/**
 * The map the tool was answered with, back to the app's rows, so a card can close with its answer.
 * The transcript mapper reads Claude's own answer with the same rule, so every seat draws the same
 * settled card whichever of the two closed it.
 */
export function modAnswerRows(questions: unknown, answers: unknown): string[][] | undefined {
  return claudeAnswerRows(modQuestionViews(questions), answers);
}
