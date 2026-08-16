/**
 * The wire-journal reader: a read-only telemetry sidecar over Kimi's on-disk
 * `wire.jsonl` files.
 *
 * WHY DISK AT ALL, in a package whose whole posture is "talk to the server":
 * the server's REST projections carry no usage. `/status` reports the context
 * window and nothing else, and the session/message projections hardcode an
 * empty usage object, so the journal is the ONLY place a real token count
 * exists. Reading it is strictly additive — nothing here writes, renames, locks,
 * or even holds a descriptor between ticks.
 *
 * LAYOUT (verified against a real 0.35.0 home):
 *   <KIMI_CODE_HOME>/sessions/<workspaceDir>/<sessionId>/agents/<agentDir>/wire.jsonl
 * Each agent directory (`main`, `agent-1`, …) is ONE CONCURRENT STREAM: a
 * subagent writes its own journal while the main stream keeps writing its own,
 * which is why every figure derived here is per-stream first and combined
 * afterwards.
 *
 * BOUNDS DISCIPLINE, the same one the rest of this package follows: every bound
 * sits at the ITERATION or at the READ, truncation is always REPORTED rather
 * than silently applied, and the file type is proven on the OPENED descriptor
 * (see {@link openRegularFileSync}). A journal another product appends to at
 * will must never be able to cost this adapter an unbounded read, an unbounded
 * line, or an unbounded wait.
 */
import { closeSync, fstatSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  boundedDirectoryListing,
  openRegularFileSync,
  type KimiRegistryListing,
} from './server.ts';

// ── Bounds ──────────────────────────────────────────────────────────────────

/**
 * Workspace directories one discovery scan examines. A home holds one entry per
 * workspace ever opened; the scan probes each for this session, so an enormous
 * (or hostile) sessions directory must cost the ceiling, not the directory.
 */
export const KIMI_WIRE_WORKSPACE_SCAN_MAX = 256;

/** Concurrent streams one session may contribute. Real sessions hold a handful. */
export const KIMI_WIRE_STREAM_MAX = 32;

/**
 * How far back the FIRST read of a journal reaches. Everything older is outside
 * the observed window, and a reader that skipped bytes says so for the rest of
 * the connection — a clipped sum is not a session total.
 */
export const KIMI_WIRE_TAIL_CAP_BYTES = 4 * 1024 * 1024;

/**
 * How much one tick may consume from one journal. A hot journal must not make a
 * single tick unbounded; the remainder is simply picked up on the next tick.
 */
export const KIMI_WIRE_TICK_CAP_BYTES = 256 * 1024;

/**
 * Longest line this reader will assemble. A line past the ceiling is dropped,
 * COUNTED, and skipped to the next newline — holding it would turn a single
 * malformed (or adversarial) row into unbounded retention.
 */
export const KIMI_WIRE_MAX_LINE_BYTES = 64 * 1024;

/** Remembered usage identities per stream, so a long observe cannot grow without limit. */
export const KIMI_WIRE_DEDUPE_LIMIT = 4_096;

/** `<home>/sessions` — the root every discovery scan walks. */
export function kimiSessionWireRoot(home: string): string {
  return join(home, 'sessions');
}

// ── Injected io ─────────────────────────────────────────────────────────────

/**
 * The filesystem surface this module uses, injectable so tests drive real
 * tmpdirs AND so the FIFO/symlink defenses are exercised rather than assumed.
 * The production default is {@link defaultKimiWireIo}.
 */
export interface KimiWireIo {
  /** Must ITERATE boundedly (never materialize an unbounded directory) and report truncation. */
  listNames(directory: string, maxEntries: number): KimiRegistryListing;
  /** Cheap existence probe. Answers false for anything unreadable rather than throwing. */
  isDirectory(path: string): boolean;
  /** Must prove REGULAR-FILE on the opened descriptor; the caller closes it. */
  openRead(path: string): number;
  sizeOf(fd: number): number;
  readAt(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
}

export const defaultKimiWireIo: KimiWireIo = {
  listNames: (directory, maxEntries) => boundedDirectoryListing(directory, maxEntries),
  // Deliberately a plain stat, not the hardened open: a directory probe cannot
  // block the way a FIFO open can, and refusing a symlinked workspace directory
  // would lose telemetry for a legitimately relocated home. The hardening that
  // matters is on the FILE, where a FIFO or a symlink would otherwise be read.
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  openRead: (path) => openRegularFileSync(path),
  sizeOf: (fd) => fstatSync(fd).size,
  readAt: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  close: (fd) => closeSync(fd),
};

// ── Discovery ───────────────────────────────────────────────────────────────

/** One concurrent stream: an agent directory and the journal inside it. */
export interface KimiWireStream {
  /** The agent directory name (`main`, `agent-1`, …). */
  streamId: string;
  wirePath: string;
}

export interface KimiWireDiscovery {
  streams: KimiWireStream[];
  /**
   * True when EITHER listing hit its ceiling. Telemetry then reports itself
   * clipped: an unexamined workspace or an unexamined agent directory means the
   * account covers part of the session, and presenting a partial account as a
   * whole one is the failure this flag exists to prevent.
   */
  truncated: boolean;
}

/**
 * Is `name` ONE safe path component — something that can only ever name a child
 * of the directory it is joined to?
 *
 * The session id arrives from the server (or from whatever asked the broker to
 * attach), and the workspace name arrives from a directory another product
 * writes, so both are untrusted strings about to become path segments. A
 * separator, a NUL, a bare `.`/`..`, or an absolute-path shape each let one
 * segment address something other than a child — `../../etc` walks out of the
 * home entirely — and this reader opens whatever the join produces.
 */
function isSafePathComponent(name: string): boolean {
  if (!name) return false;
  // Both separators, on every platform: a Windows-shaped id must not become a
  // traversal on a POSIX host merely because `join` there treats `\` as text.
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.includes('\0')) return false;
  if (name === '.' || name === '..') return false;
  // Catches the platform's own absolute forms, including a Windows drive
  // prefix, which carries no separator of its own.
  if (isAbsolute(name)) return false;
  return true;
}

/** Is `target` the root itself or something beneath it? The containment half of the check above. */
function isWithinRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Find this session's journals under `<home>/sessions`.
 *
 * The session id names a directory, so the scan is a bounded listing of the
 * workspace level plus one cheap existence probe per workspace; the first
 * workspace holding `<sessionId>/agents` wins (a session id belongs to exactly
 * one workspace). Nothing found is a normal, honest outcome: the caller emits
 * NO usage and NO timing at all rather than an invented zero — which is also the
 * answer a REJECTED id gets, because "no telemetry" is a state this module
 * already has and a throw inside a poll tick is not.
 *
 * TWO gates, not one. Each untrusted segment must be a single safe component,
 * AND the resolved directory must still sit under the wire root — the component
 * rule is what a reviewer can read, the containment rule is what actually holds
 * if the component rule ever misses a form. Both run BEFORE any io call, so a
 * rejected id costs no filesystem access at all.
 */
export function locateKimiWireStreams(
  wireRoot: string,
  sessionId: string,
  io: KimiWireIo = defaultKimiWireIo,
): KimiWireDiscovery {
  // Checked before the root is even listed: a hostile id must reach no io call.
  if (!isSafePathComponent(sessionId)) return { streams: [], truncated: false };
  const root = resolve(wireRoot);
  let workspaces: KimiRegistryListing;
  try {
    workspaces = io.listNames(wireRoot, KIMI_WIRE_WORKSPACE_SCAN_MAX);
  } catch {
    return { streams: [], truncated: false };
  }
  // Defensive re-cap, the pattern scanKimiInstances applies to its own injected
  // io: the io OWES the ceiling, and one that ignores it must still cost bounded
  // work here, with its excess surfacing as truncation.
  const names = [...workspaces.names].sort();
  const examined = names.slice(0, KIMI_WIRE_WORKSPACE_SCAN_MAX);
  let truncated = workspaces.truncated || examined.length < names.length;

  for (const workspace of examined) {
    // The listing is another product's directory, so its entries get the same
    // rule the caller's session id got.
    if (!isSafePathComponent(workspace)) continue;
    const agentsDirectory = join(wireRoot, workspace, sessionId, 'agents');
    if (!isWithinRoot(root, resolve(agentsDirectory))) continue;
    if (!io.isDirectory(agentsDirectory)) continue;
    let agents: KimiRegistryListing;
    try {
      agents = io.listNames(agentsDirectory, KIMI_WIRE_STREAM_MAX);
    } catch {
      return { streams: [], truncated };
    }
    const agentNames = [...agents.names].sort();
    const streamNames = agentNames.slice(0, KIMI_WIRE_STREAM_MAX);
    truncated = truncated || agents.truncated || streamNames.length < agentNames.length;
    return {
      streams: streamNames.map((streamId) => ({
        streamId,
        wirePath: join(agentsDirectory, streamId, 'wire.jsonl'),
      })),
      truncated,
    };
  }
  return { streams: [], truncated };
}

// ── Usage rows ──────────────────────────────────────────────────────────────

/** One `usage.record` row, the only row type this reader keeps. */
export interface KimiUsageRecord {
  streamId: string;
  model: string;
  /** Epoch ms, as the journal writes it. */
  timeMs: number;
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}

export interface KimiWireRead {
  records: KimiUsageRecord[];
  /**
   * True once this reader has skipped bytes it will never read: the first tail
   * started past the head of a large journal, or a rotation reset re-tailed one.
   * Persistent — a window that was clipped stays clipped for the connection.
   */
  clipped: boolean;
  /** Lines dropped for exceeding {@link KIMI_WIRE_MAX_LINE_BYTES}, counted per line. */
  oversizedLines: number;
  /** Streams that could not be read this tick (missing, a FIFO, a symlink, permissions). */
  failedStreams: number;
  /**
   * Bytes this pass took off the streams, summed across them.
   *
   * The record count alone cannot say whether a pass MOVED: a pass may consume a
   * whole tick cap of tool rows, junk, or a discarded leading fragment and
   * decode nothing at all. A caller draining a window (see the observe
   * baseline) needs the byte figure to know there is more behind it.
   */
  bytesConsumed: number;
}

const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);
/**
 * Cheap pre-filter. A busy journal is overwhelmingly tool and loop-event rows,
 * and parsing each of them as JSON is the entire cost of reading one — so the
 * parse is paid only by a line that could possibly be a usage row.
 */
const USAGE_MARKER = Buffer.from('usage.record');

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Decode one line, or nothing. Everything that is not a well-formed usage row —
 * a `turn.prompt`, a tool row, a half-written line, malformed JSON — is skipped
 * without error: this reader is a passenger on a file another product owns, and
 * an unknown row must cost nothing at all.
 *
 * `usageScope` is NOT filtered. A `session`-scoped row is the compaction
 * accounting and is real usage the user paid for; dropping it would understate
 * exactly the sessions that cost the most.
 */
function decodeUsageRecord(line: Buffer, streamId: string): KimiUsageRecord | undefined {
  if (line.length === 0 || !line.includes(USAGE_MARKER)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const row = parsed as { type?: unknown; model?: unknown; time?: unknown; usage?: unknown };
  if (row.type !== 'usage.record') return undefined;
  const time = row.time;
  if (typeof time !== 'number' || !Number.isSafeInteger(time) || time <= 0) return undefined;
  const usage = (row.usage && typeof row.usage === 'object' && !Array.isArray(row.usage)
    ? row.usage
    : {}) as Record<string, unknown>;
  return {
    streamId,
    model: typeof row.model === 'string' ? row.model : '',
    timeMs: time,
    inputOther: safeCount(usage.inputOther),
    output: safeCount(usage.output),
    inputCacheRead: safeCount(usage.inputCacheRead),
    inputCacheCreation: safeCount(usage.inputCacheCreation),
  };
}

/** The reference dedupe key: a row is the same reading only if all of it matches. */
function usageKey(record: KimiUsageRecord): string {
  return `${record.timeMs}:${record.model}:${record.inputOther}:${record.output}`
    + `:${record.inputCacheRead}:${record.inputCacheCreation}`;
}

interface WireStreamState {
  /** Byte position the next read starts from. */
  offset: number;
  started: boolean;
  clipped: boolean;
  /** The trailing incomplete line, held until its newline arrives. */
  partial: Buffer;
  /** Discarding bytes up to the next newline: a mid-file start, or an oversized line. */
  skipping: boolean;
  seen: Set<string>;
}

/**
 * Incremental tail over a fixed set of journals.
 *
 * Holds NO descriptor between reads: each read opens, stats, reads at most one
 * tick's worth, and closes. The only state that survives a read is a byte
 * offset, the trailing partial line, and the dedupe memory — which is what makes
 * a connection's telemetry survive the journal being rotated, truncated, or
 * appended to by a process this adapter does not control.
 */
export class KimiWireTail {
  private readonly states = new Map<string, WireStreamState>();
  private clippedEver = false;

  constructor(
    readonly streams: readonly KimiWireStream[],
    private readonly io: KimiWireIo = defaultKimiWireIo,
  ) {}

  /**
   * One bounded pass over every stream. A stream that cannot be read this tick
   * is COUNTED and skipped rather than failing the pass: one unreadable journal
   * must not cost the account the streams beside it.
   */
  read(): KimiWireRead {
    const records: KimiUsageRecord[] = [];
    let oversizedLines = 0;
    let failedStreams = 0;
    let bytesConsumed = 0;
    for (const stream of this.streams) {
      try {
        const outcome = this.readStream(stream);
        records.push(...outcome.records);
        oversizedLines += outcome.oversizedLines;
        bytesConsumed += outcome.bytesConsumed;
      } catch {
        failedStreams += 1;
      }
    }
    return { records, clipped: this.clippedEver, oversizedLines, failedStreams, bytesConsumed };
  }

  /**
   * One bounded read of ONE stream. PROPAGATES an open or read failure, so a
   * caller that wants to know (and the suite that pins the FIFO and symlink
   * refusals) can see it; {@link read} is the forgiving wrapper.
   */
  readStream(
    stream: KimiWireStream,
  ): { records: KimiUsageRecord[]; oversizedLines: number; bytesConsumed: number } {
    const state = this.stateOf(stream.streamId);
    const fd = this.io.openRead(stream.wirePath);
    try {
      const size = this.io.sizeOf(fd);
      if (!state.started) {
        state.started = true;
        // BASELINE: start one tail cap back, never at byte zero of an arbitrarily
        // large file. A mid-file start is DISCARDED up to the next newline, the
        // same rule the shrink branch below applies, rather than left for the
        // parser to reject as malformed: the cut lands wherever the arithmetic
        // puts it, including exactly at the start of a whole row, and a parser
        // cannot tell that row from the suffix of the one before it. At an
        // exact line start the skip costs one whole row — acceptable inside a
        // window this same arithmetic has already clipped, and cheaper than
        // trusting a parser to reject every possible suffix of every row.
        state.offset = Math.max(0, size - KIMI_WIRE_TAIL_CAP_BYTES);
        state.skipping = state.offset > 0;
        if (state.offset > 0) this.markClipped(state);
      } else if (size < state.offset) {
        // The file SHRANK: it was rotated or truncated under us, so the held
        // offset addresses bytes that no longer exist and the dedupe memory
        // describes a file that is gone. Re-tail from scratch and say so.
        state.offset = Math.max(0, size - KIMI_WIRE_TAIL_CAP_BYTES);
        state.partial = EMPTY;
        state.seen.clear();
        state.skipping = state.offset > 0;
        this.markClipped(state);
      }
      const available = size - state.offset;
      if (available <= 0) return { records: [], oversizedLines: 0, bytesConsumed: 0 };
      // Bounded AT the read: a journal that grew by a gigabyte between ticks
      // costs one tick cap now and the rest on later ticks.
      const length = Math.min(available, KIMI_WIRE_TICK_CAP_BYTES);
      const buffer = Buffer.alloc(length);
      const bytesRead = this.io.readAt(fd, buffer, 0, length, state.offset);
      state.offset += bytesRead;
      return {
        ...this.consume(state, stream.streamId, buffer.subarray(0, bytesRead)),
        bytesConsumed: bytesRead,
      };
    } finally {
      this.io.close(fd);
    }
  }

  private markClipped(state: WireStreamState): void {
    state.clipped = true;
    this.clippedEver = true;
  }

  private stateOf(streamId: string): WireStreamState {
    const existing = this.states.get(streamId);
    if (existing) return existing;
    const created: WireStreamState = {
      offset: 0,
      started: false,
      clipped: false,
      partial: EMPTY,
      skipping: false,
      seen: new Set(),
    };
    this.states.set(streamId, created);
    return created;
  }

  /**
   * Parse COMPLETE lines only. The trailing fragment is held for the next read,
   * because a journal is appended to while it is being read and half a line is
   * not a row — and it is held only up to the line ceiling.
   */
  private consume(
    state: WireStreamState,
    streamId: string,
    chunk: Buffer,
  ): { records: KimiUsageRecord[]; oversizedLines: number } {
    const data = state.partial.length > 0 ? Buffer.concat([state.partial, chunk]) : chunk;
    state.partial = EMPTY;
    const records: KimiUsageRecord[] = [];
    let oversizedLines = 0;
    let start = 0;
    for (;;) {
      const newline = data.indexOf(NEWLINE, start);
      if (newline === -1) break;
      const line = data.subarray(start, newline);
      start = newline + 1;
      if (state.skipping) {
        // Whatever ended at this newline is the tail of a line this reader never
        // saw the start of; the next one is whole.
        state.skipping = false;
        continue;
      }
      if (line.length > KIMI_WIRE_MAX_LINE_BYTES) {
        // The ceiling applies to every line, not only to a held one: a row that
        // arrives whole inside one tick chunk is still a row this reader refuses
        // to parse, so the rule does not depend on where the chunk boundary fell.
        oversizedLines += 1;
        continue;
      }
      const record = decodeUsageRecord(line, streamId);
      if (record && this.admit(state, record)) records.push(record);
    }
    const rest = data.subarray(start);
    if (state.skipping) return { records, oversizedLines };
    if (rest.length > KIMI_WIRE_MAX_LINE_BYTES) {
      state.skipping = true;
      oversizedLines += 1;
      return { records, oversizedLines };
    }
    // Copied rather than retained as a view, so holding a few bytes cannot pin
    // the whole tick-sized chunk.
    state.partial = rest.length > 0 ? Buffer.from(rest) : EMPTY;
    return { records, oversizedLines };
  }

  /** Bounded dedupe memory, insertion-ordered eviction (Sets iterate oldest-first). */
  private admit(state: WireStreamState, record: KimiUsageRecord): boolean {
    const key = usageKey(record);
    if (state.seen.has(key)) return false;
    state.seen.add(key);
    if (state.seen.size > KIMI_WIRE_DEDUPE_LIMIT) {
      const excess = state.seen.size - KIMI_WIRE_DEDUPE_LIMIT;
      let dropped = 0;
      for (const older of state.seen) {
        state.seen.delete(older);
        dropped += 1;
        if (dropped >= excess) break;
      }
    }
    return true;
  }
}
