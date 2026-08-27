/**
 * The last terminal outcome of a session's MAIN turn, read from its own wire
 * journal.
 *
 * WHY DISK, in a package whose posture is "talk to the server". A turn that
 * FAILS states why exactly once — in the live `turn.ended` frame — and nothing
 * durable carries that statement afterwards. Verified 2026-08-27 against host
 * 0.38.0, on a session whose last two turns were both killed by a 403 quota
 * refusal:
 *
 *  - `GET .../messages` folds an assistant row with `content: []` for the
 *    failed turn and no error at all;
 *  - `GET .../status` carries the context window and the modes, no outcome;
 *  - `GET /api/v1/sessions/{id}` carries `last_turn_reason`, and it is NOT
 *    evidence — that same row reported `"completed"` for that same session, and
 *    omitted the field entirely for a neighbouring one. Force-loading the
 *    session first did not change the answer.
 *
 * So a user who was not watching at the instant the turn died — the ordinary
 * case, since the failure that matters most is the one that happened while they
 * were away — saw an empty assistant bubble and no reason. Any history reset (a
 * resync, a re-attach) erased the live error row too, because the authoritative
 * re-fold that replaces the transcript does not contain one.
 *
 * The journal does contain it, verbatim, as the last line the turn writes:
 *   {"type":"turn.ended","agentId":"main","turnId":6,"reason":"failed",
 *    "error":{"code":"provider.auth_error","message":"403 You've reached …"}}
 * Reading it is strictly additive — nothing here writes, renames, locks, or
 * holds a descriptor across calls — and it is the same journal tree the usage
 * telemetry and the subagent roster already read, through the same injected io.
 *
 * BOUNDS DISCIPLINE, the package's standing rule: the bound sits at the READ,
 * the file type is proven on the OPENED descriptor (see
 * {@link import('./server.ts').openRegularFileSync}), and a window that cannot
 * be classified yields NOTHING rather than a guess.
 */
import { locateKimiWireStreams, type KimiWireIo, defaultKimiWireIo } from './usage.ts';

/**
 * Bytes of the main journal one outcome read consumes.
 *
 * Deliberately the subagent classifier's window and for the same measured
 * reason: on the live 0.38.0 host a 64 KiB tail held 50–104 complete lines of
 * every journal (largest single line 26 KiB), and a settled turn writes its
 * `turn.ended` in the LAST lines it writes at all. A turn still running needs
 * nothing found.
 */
export const KIMI_TURN_OUTCOME_TAIL_BYTES = 64 * 1024;

/**
 * Longest line assembled from the window. Past the ceiling a line is dropped,
 * exactly as the subagent reader drops one: holding it would turn a single
 * malformed (or adversarial) row into unbounded retention.
 */
export const KIMI_TURN_OUTCOME_MAX_LINE_BYTES = 128 * 1024;

/** Line types that record a turn OPEN — the same narrow pair the child classifier uses. */
const TURN_OPEN_TYPES = new Set(['turn.prompt', 'llm.request']);

/** The agent directory whose journal IS the session's own transcript. */
export const KIMI_MAIN_STREAM_ID = 'main';

/** One settled main turn, as its own journal recorded it. */
export interface KimiTurnOutcome {
  /** `turnId` stringified — the identity the live `turn.ended` path keys its row on. */
  turnRef: string;
  /** `completed` | `cancelled` | `failed`, or whatever else the host writes. */
  reason: string;
  /** The `error` payload, verbatim, for {@link import('./mapping.ts').mapKimiTurnFailure}. */
  error?: unknown;
  /** `interruptReason`, the fallback that same mapping falls back to. */
  interruptReason?: unknown;
  /** Epoch ms the host stamped on the line. */
  timeMs?: number;
}

/**
 * The LAST settled main turn of one session, or undefined.
 *
 * Undefined covers every "no evidence" case and they are deliberately not
 * distinguished: no journal tree, an unreadable file, a window with no
 * `turn.ended` in it, or — the case that matters — a turn OPEN after the last
 * ending. That last one is why the walk tracks open markers at all: a session
 * mid-turn has the PREVIOUS turn's outcome sitting in the same window, and
 * replaying that as the session's current outcome would put a stale failure on
 * top of work running right now.
 */
export function readKimiLastTurnOutcome(
  wireRoot: string,
  sessionId: string,
  io: KimiWireIo = defaultKimiWireIo,
): KimiTurnOutcome | undefined {
  let located;
  try {
    located = locateKimiWireStreams(wireRoot, sessionId, io);
  } catch {
    return undefined;
  }
  const main = located.streams.find((stream) => stream.streamId === KIMI_MAIN_STREAM_ID);
  if (!main) return undefined;
  return readKimiTurnOutcomeFromJournal(main.wirePath, io);
}

/** {@link readKimiLastTurnOutcome} against a journal the caller already located. */
export function readKimiTurnOutcomeFromJournal(
  wirePath: string,
  io: KimiWireIo = defaultKimiWireIo,
): KimiTurnOutcome | undefined {
  const window = readTail(io, wirePath, KIMI_TURN_OUTCOME_TAIL_BYTES);
  if (window === undefined) return undefined;
  return classifyOutcome(window.text, window.complete);
}

/**
 * Read at most `maxBytes` from the END of a file, TRUNCATING rather than
 * refusing, and say whether the read covered the whole file.
 *
 * Holds no descriptor beyond the call. A short read means EOF (the file shrank
 * under us) and stops the loop rather than spinning.
 */
function readTail(
  io: KimiWireIo,
  path: string,
  maxBytes: number,
): { text: string; complete: boolean } | undefined {
  let fd: number;
  try {
    fd = io.openRead(path);
  } catch {
    return undefined;
  }
  try {
    const size = io.sizeOf(fd);
    if (!Number.isFinite(size) || size <= 0) return undefined;
    const want = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(want);
    let filled = 0;
    while (filled < want) {
      const n = io.readAt(fd, buffer, filled, want - filled, size - want + filled);
      if (n <= 0) break;
      filled += n;
    }
    return { text: buffer.subarray(0, filled).toString('utf8'), complete: want >= size };
  } catch {
    return undefined;
  } finally {
    try {
      io.close(fd);
    } catch {
      /* a close that fails leaks one descriptor; it must not lose the reading */
    }
  }
}

/**
 * Walk the window in order and keep the last `turn.ended` that nothing reopened.
 *
 * A tail read cuts the file mid-line by construction, so the FIRST fragment is
 * dropped unless the read reached byte zero — the mirror of the rule the
 * subagent head reader applies to its LAST fragment, and for the same reason: a
 * truncated object either throws or, worse, parses into a field that is not
 * what the file says.
 */
function classifyOutcome(text: string, complete: boolean): KimiTurnOutcome | undefined {
  const parts = text.split('\n');
  if (!complete) parts.shift();
  let outcome: KimiTurnOutcome | undefined;
  for (const part of parts) {
    const line = part.trim();
    if (!line) continue;
    if (Buffer.byteLength(line, 'utf8') > KIMI_TURN_OUTCOME_MAX_LINE_BYTES) continue;
    let record: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      record = value as Record<string, unknown>;
    } catch {
      continue;
    }
    // A subagent's lifecycle lives in ITS journal, but the main journal carries
    // frames tagged for other agents on some protocol versions. An ABSENT id
    // passes — the same defensive rule the live frame filter applies.
    const agentId = record.agentId;
    if (typeof agentId === 'string' && agentId !== KIMI_MAIN_STREAM_ID) continue;
    const type = record.type;
    if (typeof type !== 'string') continue;
    if (TURN_OPEN_TYPES.has(type)) {
      // A turn opened after the ending being held: that ending is history, not
      // the session's current outcome.
      outcome = undefined;
      continue;
    }
    if (type !== 'turn.ended') continue;
    const reason = record.reason;
    if (typeof reason !== 'string' || !reason) continue;
    const turnId = record.turnId;
    outcome = {
      turnRef: typeof turnId === 'number' || typeof turnId === 'string' ? String(turnId) : 'unknown',
      reason,
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.interruptReason !== undefined ? { interruptReason: record.interruptReason } : {}),
      ...(typeof record.time === 'number' && Number.isFinite(record.time) ? { timeMs: record.time } : {}),
    };
  }
  return outcome;
}
