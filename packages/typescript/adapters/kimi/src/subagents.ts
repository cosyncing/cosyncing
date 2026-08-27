/**
 * Kimi ROSTER SUBAGENTS — the read-only, file-backed child source.
 *
 * Every fact this module acts on was MEASURED against the live host's
 * `~/.kimi-code/sessions/` tree on 2026-08-25 (112 journals, 70,001 lines, 59
 * sessions, 53 subagent directories) and written up in
 * `docs-internal/active/investigations/2026-08-21-Implenation/kimi-subagent-wire-facts.md`.
 * Section references below (§2, §5.2, …) point into that document. Nothing here
 * is inferred from upstream source, and nothing is carried over from
 * `usage.ts`'s token-telemetry reader — that module answers "how many tokens did
 * this stream spend", which is a different question over the same bytes.
 *
 * WHY DISK, in a package whose posture is "talk to the server": the adapter's
 * whole roster comes from `GET /api/v2/sessions`, and that projection has never
 * been observed to mention a subagent (wire-facts §U2 — a genuine open
 * question, deliberately left open rather than assumed either way). The
 * filesystem is the ONLY place a child is known to exist today. Reading it is
 * strictly additive: nothing here writes, renames, locks, or holds a descriptor
 * across calls.
 *
 * LAYOUT (§1):
 *   <KIMI_CODE_HOME>/sessions/<workspaceDir>/<sessionId>/
 *     state.json                     ← the authoritative agents map (§2)
 *     agents/main/wire.jsonl         ← the PARENT's own journal
 *     agents/main/tasks/agent-*.json ← spawn records, when they exist (§5)
 *     agents/agent-<N>/wire.jsonl    ← one SUBAGENT SLOT (§5.2)
 *
 * THE FOUR FACTS THAT SHAPE THIS CODE
 *
 *  1. `state.json` enumerates the children exactly (§2). Its `agents` map
 *     matched the directories on disk in 59/59 sessions with zero exceptions,
 *     and only it carries `type: 'main' | 'sub'` — the discriminant a `readdir`
 *     cannot supply. So enumeration is ONE bounded read, not a directory walk.
 *     `parentAgentId` is deliberately NOT used: it is absent on 22 of 112
 *     entries and explicitly `null` on 37, so its presence means nothing.
 *
 *  2. An `agent-<N>` directory is a SLOT, not a task (§5.2). One measured slot
 *     was reused by six successive spawns, its journal appended across all six.
 *     The row is therefore keyed on the DIRECTORY — the only id that has a
 *     journal of its own to replay. A `taskId` has none.
 *
 *  3. Identity costs a bounded HEAD read (§9). `profileName`, `modelAlias` and
 *     the first `turn.prompt` were all present within 56,420 bytes of the file
 *     head in 53/53 children, while whole journals run to 10.2 MB. So the read
 *     is capped at {@link KIMI_SUBAGENT_HEAD_BYTES} and never scales with the
 *     journal.
 *
 *  4. Freshness needs no read at all (§4). The file mtime tracked the last
 *     wire line's own `time` to within 2,000 ms in 53/53 children, so a stat is
 *     an honest `updatedAt` and a bounded tail read would buy nothing. This
 *     module performs NO tail read.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DECIDE. It reports evidence; it does
 * not synthesize a status. On `protocol_version` 1.4 a child journal carries no
 * completion evidence whatsoever — 0 of 23 such children had a single
 * `turn.ended` line, so "still running" and "finished three weeks ago" are
 * indistinguishable from the journal (§8). Claiming `working` from that would
 * mint a badge nothing could ever clear. {@link kimiSubagentStatus} applies
 * round 1's claude rule instead — the parent must have a turn in flight AND the
 * child's journal must be fresh — and it is the only status path offered.
 *
 * BOUNDS DISCIPLINE, the package's existing rule: every bound sits at the
 * ITERATION or at the READ, truncation is REPORTED rather than silently
 * applied, and the file type is proven on the OPENED descriptor. A tree another
 * product appends to at will must never cost this adapter an unbounded read, an
 * unbounded listing, or an unbounded wait.
 *
 * WIRED IN LANDING 2. {@link listKimiSubagents} runs inside the discovery
 * sweep, {@link kimiSubagentRow} turns each slot into a roster row, and
 * {@link kimiSubagentIdInfo} is what `attach` reads to refuse a non-observe
 * mode before any HTTP or process path is touched.
 */
import { closeSync, fstatSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ModelOption, SessionControlState, SessionInfo } from '@cosyncing/adapter-api';

import { boundedDirectoryListing, openRegularFileSync, type KimiRegistryListing } from './server.ts';
import { isSafePathComponent, isWithinRoot, kimiSessionWireRoot } from './usage.ts';

// ── Bounds ──────────────────────────────────────────────────────────────────

/**
 * Workspace directories one child scan examines while locating a session.
 * Matches the wire reader's ceiling for the same listing: a home holds one
 * entry per workspace ever opened (8 on the measured host), so an enormous or
 * hostile sessions directory must cost the ceiling, not the directory.
 */
export const KIMI_SUBAGENT_WORKSPACE_SCAN_MAX = 256;

/**
 * Child candidates ONE parent's scan may examine — the work ceiling.
 *
 * Spent by every candidate {@link listKimiSubagents} looks at, before any io
 * and regardless of whether the candidate becomes a row, so the cost of a
 * parent is bounded by this and not by how many of its children happen to be
 * yieldable. The yield budget cannot do that job: it is spent on ROWS, so cold
 * and unreadable children would otherwise be free to read.
 *
 * Measured maximum children on a real session: 20 (21 entries with `main`), so
 * 32 clears the host with headroom while keeping a hostile or corrupt
 * `state.json` listing thousands of `type: 'sub'` entries to 32 head reads.
 */
export const KIMI_SUBAGENT_DIR_SCAN_MAX = 32;

/** Ceiling on `state.json`. Measured largest on the host: 8,821 bytes. */
export const KIMI_SUBAGENT_STATE_MAX_BYTES = 256 * 1024;

/**
 * How much of a child journal one identity read consumes.
 *
 * MEASURED (§9, n=53): every child journal yielded `profileName`, `modelAlias`
 * AND its first `turn.prompt` within 56,420 bytes — p50 43,420, max 56,420.
 * 64 KiB clears the measured maximum with headroom and is two orders of
 * magnitude below the largest journal (10,201,217 bytes). The floor is ~30 KB
 * only because `config.update` embeds the whole system prompt.
 */
export const KIMI_SUBAGENT_HEAD_BYTES = 64 * 1024;

/**
 * Bytes of the journal TAIL one settlement classification may read.
 *
 * MEASURED 2026-08-27 on the live 0.38.0 host (protocol 1.5): a 64 KiB tail
 * window held 50–104 complete lines on every child journal (largest single
 * line 26 KiB), and each of the 3 finished children carried `turn.ended` +
 * `token_counting.turn_recorded` in its LAST lines — so the settle marker of a
 * finished journal is always inside this window, and a running journal needs
 * nothing found at all.
 */
export const KIMI_SUBAGENT_TAIL_BYTES = 64 * 1024;

/**
 * Line types that record a turn settling. `turn.ended` and `turn.cancel` are
 * the host's own lifecycle statements; `token_counting.turn_recorded` is the
 * accounting line written with them (3/3 finished children, 2026-08-27).
 */
const KIMI_TURN_SETTLE_TYPES = new Set(['turn.ended', 'turn.cancel', 'token_counting.turn_recorded']);

/**
 * Line types that record a turn OPEN: a prompt began it, or a model request is
 * awaiting its response. Deliberately narrow — `context.append_loop_event` is
 * ambient on any active journal and would widen the claim to journals whose
 * protocol never writes a settle.
 */
const KIMI_TURN_OPEN_TYPES = new Set(['turn.prompt', 'llm.request']);

/**
 * How stale an OPEN-turn journal may go before the row stops claiming working.
 *
 * Wider than {@link KIMI_SUBAGENT_WORKING_FRESH_MS} on measurement: the live
 * running child (2026-08-27) sat 108 s past its last write while its
 * `llm.request` was still generating, and its bash task records were minutes
 * apart — a journal is appended in bursts, and the quiet stretch between them
 * is the model thinking, not the child finishing. Ten minutes is the crash
 * decay: a child that dies without its settle line stops claiming working
 * within this window, on its own.
 */
export const KIMI_SUBAGENT_OPEN_TURN_FRESH_MS = 10 * 60_000;

/**
 * Longest single line assembled from a head read. A line past the ceiling is
 * dropped and COUNTED — holding it would turn one malformed (or adversarial)
 * row into unbounded retention.
 */
export const KIMI_SUBAGENT_MAX_LINE_BYTES = 128 * 1024;

/** Entries examined in one `agents/main/tasks/` listing. Measured largest: 88. */
export const KIMI_SUBAGENT_TASK_SCAN_MAX = 256;

/** Spawn records read per parent. Measured largest for one session: 7. */
export const KIMI_SUBAGENT_TASK_READ_MAX = 32;

/** Ceiling on one `tasks/agent-*.json`. Measured largest: 292 bytes. */
export const KIMI_SUBAGENT_TASK_MAX_BYTES = 64 * 1024;

/** Longest title a child row publishes, matching round 1's claude child rows. */
export const KIMI_SUBAGENT_TITLE_MAX = 120;

/**
 * How fresh a child journal must be to corroborate a `working` badge.
 * Deliberately equal to round 1's claude `WORKING_FRESH_MS`: the two agents
 * answer the same question — "is this child still the thing the parent's turn is
 * blocked on" — and two different windows would make the same roster disagree
 * with itself.
 */
export const KIMI_SUBAGENT_WORKING_FRESH_MS = 60_000;

// ── Lineage namespaces ──────────────────────────────────────────────────────
//
// The client's roster join is `(machine, tool, nativeId)`, and a child's
// `parentThreadId` must equal the parent's PUBLISHED `nativeId`. Kimi publishes
// NO `nativeId` today (wire-facts §U8 — verified by reading the adapter: no
// `nativeId` key is emitted anywhere in this package). So a parent that
// actually HAS children publishes one, namespaced; a childless parent keeps
// exactly the row it has today. Reflection §2: never invent identity
// store-wide.

/** Lineage namespace for a parent that has children. Distinct from a child's. */
export const KIMI_SESSION_NATIVE_PREFIX = 'kimi-session:';

/**
 * Lineage namespace for a subagent child row. A distinct prefix means a child
 * can never be mistaken for a parent incarnation by the broker's `nativeId`
 * retirement join, and can never collide with a Kimi session id (which is
 * always `session_<uuid>` — wire-facts §2).
 */
export const KIMI_SUBAGENT_NATIVE_PREFIX = 'kimi-subagent:';

/** The lineage id a parent publishes once it is known to have children. */
export function kimiSessionNativeId(sessionId: string): string {
  return KIMI_SESSION_NATIVE_PREFIX + sessionId;
}

/**
 * A child's OWN native id. Scoped by the parent session id because an
 * `agent-<N>` directory name is unique only within one session's tree — every
 * session that spawned anything has an `agent-0` (15 of them on the measured
 * host).
 */
export function kimiSubagentNativeId(parentSessionId: string, agentDir: string): string {
  return `${KIMI_SUBAGENT_NATIVE_PREFIX}${parentSessionId}/${agentDir}`;
}

/**
 * Why a child row offers neither Drive nor take-over: the Kimi CLI owns the
 * subagent, it lives and dies inside its parent's turn, and nothing in the app
 * can ever become its writer. Single-sourced so the roster control state and
 * the attach refusal (Landing 2) cannot drift apart.
 */
export const KIMI_SUBAGENT_OWNED_REASON =
  'This Kimi subagent is owned by the session that spawned it; its parent session is where work happens.';

// ── Injected io ─────────────────────────────────────────────────────────────

/**
 * The filesystem surface this module uses, injectable so tests drive real
 * tmpdirs AND so the FIFO/symlink defenses are exercised rather than assumed.
 *
 * A near-twin of {@link import('./usage.ts').KimiWireIo}, differing in one
 * member: this reader needs the mtime as well as the size, because a stat IS
 * the freshness answer here (§4) whereas the telemetry reader tracks byte
 * offsets. Sharing one interface would have forced a `sizeOf` caller to grow a
 * field it never reads.
 */
export interface KimiSubagentIo {
  /** Must ITERATE boundedly (never materialize an unbounded directory) and report truncation. */
  listNames(directory: string, maxEntries: number): KimiRegistryListing;
  /** Cheap existence probe. Answers false for anything unreadable rather than throwing. */
  isDirectory(path: string): boolean;
  /** Must prove REGULAR-FILE on the opened descriptor; the caller closes it. */
  openRead(path: string): number;
  statOf(fd: number): { size: number; mtimeMs: number };
  readAt(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
}

export const defaultKimiSubagentIo: KimiSubagentIo = {
  listNames: (directory, maxEntries) => boundedDirectoryListing(directory, maxEntries),
  // A plain stat, not the hardened open, for the same reason the wire reader
  // gives: a directory probe cannot block the way a FIFO open can, and refusing
  // a symlinked workspace directory would lose a legitimately relocated home.
  // The hardening that matters is on the FILE, where a FIFO or a symlink would
  // otherwise be read.
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  openRead: (path) => openRegularFileSync(path),
  statOf: (fd) => {
    const st = fstatSync(fd);
    return { size: st.size, mtimeMs: st.mtimeMs };
  },
  readAt: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  close: (fd) => closeSync(fd),
};

// ── Results ─────────────────────────────────────────────────────────────────

/**
 * One subagent slot, shaped so a roster row can be built from it with no
 * further reads (Landing 2 step 3).
 */
export interface KimiSubagentChild {
  /** The directory name — `agent-0`, `agent-13`. The slot, and the row's identity (§5.2). */
  agentDir: string;
  /** `kimi-subagent:<parentSessionId>/<agentDir>`; the row's own `nativeId`. */
  nativeId: string;
  /** `kimi-session:<parentSessionId>`; the row's `parentThreadId`, and what the parent must publish. */
  parentThreadId: string;
  /** The parent session id, exactly as it names its directory (`session_<uuid>`). */
  parentSessionId: string;
  /** Absolute path of the child's own journal — the history source for Landing 2 step 4. */
  wirePath: string;
  /**
   * Roster title. The spawn record's `description` when one exists (7/53
   * children — a real human-legible label), else the child's first
   * `turn.prompt` text, trimmed (53/53). Never a guess from journal content.
   */
  title: string;
  /**
   * The host's own name for the child's role: the spawn record's
   * `subagentType`, else `profileName` from the journal. MEASURED closed set on
   * this corpus: `explore` | `coder` (53/53 children carried one).
   */
  subagentType?: string;
  /**
   * The provider-qualified model ALIAS the child ran under (`kimi-code/k3-256k`),
   * verbatim from the journal. NOT a display name — reflection §3 and P8: the
   * label is joined against the host catalog's `display_name` by the caller,
   * exactly as the parent row already does. Never scraped here.
   */
  modelAlias?: string;
  /** `metadata.created_at`, line 1 of the journal (53/53). */
  createdAt?: number;
  /** File mtime — measured within 2,000 ms of the last wire line's own `time` in 53/53 (§4). */
  updatedAt: number;
  /** `config.update.cwd` when the child recorded one (23/53); the caller inherits the parent's otherwise. */
  cwd?: string;
  /** `metadata.protocol_version` — `1.4` or `1.5` on this corpus. Decides what §8 can be claimed. */
  protocolVersion?: string;
  /** The newest spawn record naming this slot, when one exists (§5.3: only 7/53 children have any). */
  task?: KimiSubagentTask;
  /** Bytes actually consumed from the journal head. Never exceeds {@link KIMI_SUBAGENT_HEAD_BYTES}. */
  headBytesRead: number;
  /** True when the head read reached EOF, so the fields above saw the whole file. */
  headComplete: boolean;
  /** Over-long lines dropped from the head read. Non-zero means the head was not fully decodable. */
  droppedLines: number;
  /** The journal's own turn-lifecycle statement — see {@link KimiChildJournalHead.tailEvidence}. */
  tailEvidence: 'settled' | 'open' | 'none';
}

/** A `kind: 'agent'` spawn record from `agents/main/tasks/agent-*.json` (§5). */
export interface KimiSubagentTask {
  taskId: string;
  /** The DIRECTORY this task ran in. Present on 15/15 measured records — this IS the join (§5.1). */
  agentId: string;
  description?: string;
  /** MEASURED closed set: `completed` 13, `killed` 1, `failed` 1. */
  status?: string;
  subagentType?: string;
  startedAt?: number;
  endedAt?: number;
  model?: string;
}

export interface KimiSubagentScan {
  children: KimiSubagentChild[];
  /**
   * True when ANY ceiling was hit — a clipped workspace listing, a clipped
   * `agents/` listing, an exhausted yield budget, or a clipped task listing.
   * A partial child set presented as a whole one is the failure this flag
   * exists to prevent, and the caller must not conclude "no more children".
   */
  truncated: boolean;
  /** Children the cutoff excluded. Distinguishes "none are recent" from "none exist". */
  filtered: number;
  /**
   * Journal head reads ATTEMPTED — the walk's real io cost, counted before the
   * read is known to have worked and therefore including cold, missing and
   * unreadable children. Never exceeds
   * {@link KIMI_SUBAGENT_DIR_SCAN_MAX}. Deliberately not "reads that produced a
   * row": that figure would stay small precisely when the work ran away.
   */
  reads: number;
}

export interface KimiSubagentScanOptions {
  /** `<KIMI_CODE_HOME>/sessions`; see {@link import('./usage.ts').kimiSessionWireRoot}. */
  wireRoot: string;
  /**
   * The parent session id. The caller must already have decided this parent is
   * inside the roster cutoff — round 1's rule, kept verbatim: a cold parent's
   * child tree is never walked, so windowed discovery never pays for it.
   */
  parentSessionId: string;
  /**
   * Roster cutoff, applied to each CHILD's own mtime. A child last touched
   * before this is counted in `filtered` and not yielded.
   */
  updatedAfter?: number;
  /**
   * Rows this scan may still emit, counted against the sweep's shared yield
   * budget exactly as round 1 counts claude children. Exhausting it stops the
   * walk and reports `truncated`.
   */
  yieldBudget?: number;
  io?: KimiSubagentIo;
}

// ── Bounded reads ───────────────────────────────────────────────────────────

/**
 * Read at most `maxBytes` from the start of a file, TRUNCATING rather than
 * refusing, and report the mtime the same open already proved.
 *
 * Deliberately not `server.ts`'s {@link readBoundedText}, which throws when a
 * file exceeds its ceiling. That is right for a registry record, where an
 * oversized file is a malformed one; it is wrong here, where every input is a
 * multi-megabyte append-only journal and the first 64 KiB is the whole point
 * (§9). A throw would drop every real child.
 */
function readHead(
  io: KimiSubagentIo,
  path: string,
  maxBytes: number,
): { text: string; size: number; mtimeMs: number; complete: boolean; tailText?: string } | undefined {
  let fd: number;
  try {
    fd = io.openRead(path);
  } catch {
    return undefined;
  }
  try {
    const { size, mtimeMs } = io.statOf(fd);
    const want = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(want);
    let filled = 0;
    while (filled < want) {
      const n = io.readAt(fd, buffer, filled, want - filled, filled);
      // A short read on a regular file means EOF (the file shrank under us);
      // stop rather than spin.
      if (n <= 0) break;
      filled += n;
    }
    // The settlement window, read on the SAME descriptor. Only paid when the
    // head did not already cover the whole file — a small journal's head IS its
    // tail, and reading it twice would say nothing new.
    let tailText: string | undefined;
    if (size > want) {
      const tailWant = Math.min(size, KIMI_SUBAGENT_TAIL_BYTES);
      const tail = Buffer.alloc(tailWant);
      let tailFilled = 0;
      while (tailFilled < tailWant) {
        const n = io.readAt(fd, tail, tailFilled, tailWant - tailFilled, size - tailWant + tailFilled);
        if (n <= 0) break;
        tailFilled += n;
      }
      tailText = tail.subarray(0, tailFilled).toString('utf8');
    }
    return {
      text: buffer.subarray(0, filled).toString('utf8'),
      size,
      mtimeMs,
      complete: filled >= size,
      ...(tailText !== undefined ? { tailText } : {}),
    };
  } catch {
    return undefined;
  } finally {
    io.close(fd);
  }
}

/**
 * What a journal's own lines say about its last turn.
 *
 * Walks whole lines in order and keeps the LAST lifecycle statement: a settle
 * line after the last open marker means the turn ended; an open marker after
 * the last settle means one is in flight. Activity lines, unparseable
 * fragments, and an empty window say nothing.
 */
function classifyTailEvidence(lines: readonly string[]): 'settled' | 'open' | 'none' {
  let evidence: 'settled' | 'open' | 'none' = 'none';
  for (const line of lines) {
    const record = parseOrNull(line);
    if (!record) continue;
    const type = str(record.type);
    if (type === undefined) continue;
    if (KIMI_TURN_SETTLE_TYPES.has(type)) evidence = 'settled';
    else if (KIMI_TURN_OPEN_TYPES.has(type)) evidence = 'open';
  }
  return evidence;
}

/**
 * Split a head read into whole JSON lines.
 *
 * The final fragment is discarded unless the read reached EOF: a head read cuts
 * the file mid-line by construction, and parsing that fragment would either
 * throw or — worse — succeed on a truncated object and yield a field that is
 * not what the file says.
 */
function completeLines(text: string, complete: boolean): { lines: string[]; dropped: number } {
  const parts = text.split('\n');
  if (!complete) parts.pop();
  const lines: string[] = [];
  let dropped = 0;
  for (const part of parts) {
    const line = part.trim();
    if (!line) continue;
    if (Buffer.byteLength(line, 'utf8') > KIMI_SUBAGENT_MAX_LINE_BYTES) {
      dropped += 1;
      continue;
    }
    lines.push(line);
  }
  return { lines, dropped };
}

function parseOrNull(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// ── Session location ────────────────────────────────────────────────────────

/**
 * Find one session's directory under `<home>/sessions`.
 *
 * The session id names a directory, so the scan is a bounded listing of the
 * workspace level plus one cheap existence probe per workspace; the first
 * workspace holding `<sessionId>/agents` wins (a session id belongs to exactly
 * one workspace). Nothing found is a normal outcome, not an error: a session
 * the server knows about may simply have no journal tree yet, and a scan tick
 * is no place for a throw.
 *
 * TWO gates, the pattern this package already applies to the same join: each
 * untrusted segment must be a single safe component, AND the resolved directory
 * must still sit under the wire root. Both run BEFORE any io call, so a
 * rejected id costs no filesystem access at all. The predicates are imported
 * rather than re-declared — one containment rule, one place to fix it.
 */
export function locateKimiSessionDirectory(
  wireRoot: string,
  sessionId: string,
  io: KimiSubagentIo = defaultKimiSubagentIo,
): { sessionDir: string; truncated: boolean } | { sessionDir: undefined; truncated: boolean } {
  if (!isSafePathComponent(sessionId)) return { sessionDir: undefined, truncated: false };
  const root = resolve(wireRoot);
  let workspaces: KimiRegistryListing;
  try {
    workspaces = io.listNames(wireRoot, KIMI_SUBAGENT_WORKSPACE_SCAN_MAX);
  } catch {
    return { sessionDir: undefined, truncated: false };
  }
  // Defensive re-cap: the io OWES the ceiling, but an injected io that ignores
  // it must still cost bounded work here, with its excess surfacing as
  // truncation rather than as a silently chosen subset.
  const names = [...workspaces.names].sort();
  const examined = names.slice(0, KIMI_SUBAGENT_WORKSPACE_SCAN_MAX);
  const truncated = workspaces.truncated || examined.length < names.length;

  for (const workspace of examined) {
    // The listing is another product's directory, so its entries get the same
    // rule the caller's session id got.
    if (!isSafePathComponent(workspace)) continue;
    const sessionDir = join(wireRoot, workspace, sessionId);
    if (!isWithinRoot(root, resolve(sessionDir))) continue;
    if (!io.isDirectory(join(sessionDir, 'agents'))) continue;
    return { sessionDir, truncated };
  }
  return { sessionDir: undefined, truncated };
}

// ── state.json ──────────────────────────────────────────────────────────────

/** One entry of `state.json`'s `agents` map (§2). */
export interface KimiAgentEntry {
  agentId: string;
  /** MEASURED closed set (112/112): `main` ×59, `sub` ×53. The child discriminant. */
  type: string;
}

/**
 * The session's agents map, or `undefined` when `state.json` is missing or
 * unreadable.
 *
 * This is the enumeration, and it is exact: the map matched the directories on
 * disk in 59/59 measured sessions, with no dir missing from the map and no map
 * entry missing its dir (§2). One bounded read replaces a directory walk AND
 * supplies `type`, which a walk cannot.
 */
export function readKimiAgentsMap(
  sessionDir: string,
  io: KimiSubagentIo = defaultKimiSubagentIo,
): KimiAgentEntry[] | undefined {
  const head = readHead(io, join(sessionDir, 'state.json'), KIMI_SUBAGENT_STATE_MAX_BYTES);
  // An incomplete read means the file exceeded the ceiling: refuse rather than
  // parse a prefix. A truncated JSON object does not parse, but saying so here
  // keeps the reason legible.
  if (!head || !head.complete) return undefined;
  const state = parseOrNull(head.text);
  const agents = state?.agents;
  if (agents === null || typeof agents !== 'object' || Array.isArray(agents)) return undefined;
  const out: KimiAgentEntry[] = [];
  for (const [agentId, raw] of Object.entries(agents as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const type = str((raw as Record<string, unknown>).type);
    if (type === undefined) continue;
    out.push({ agentId, type });
  }
  return out;
}

// ── Spawn records ───────────────────────────────────────────────────────────

/**
 * The `kind: 'agent'` spawn records under `agents/main/tasks/`, indexed by the
 * DIRECTORY each ran in.
 *
 * The id spaces look mismatched — the file is `agent-b04zrxh6.json`, the
 * directory is `agent-4` — but the record states the join itself in `agentId`,
 * on 15/15 measured records (§5.1). No filename parsing, no fuzzy matching.
 *
 * Where a slot was reused (§5.2 — one measured slot ran six tasks), the NEWEST
 * record by `startedAt` wins: the roster shows what the slot is doing now, not
 * what it did first.
 *
 * Cost: one bounded listing, then a bounded read of only the `agent-*.json`
 * entries. The `bash-*.json` records — 244 of the 259 on the measured host —
 * are filtered out by NAME, before any read.
 */
export function readKimiSpawnRecords(
  sessionDir: string,
  io: KimiSubagentIo = defaultKimiSubagentIo,
): { byAgentId: Map<string, KimiSubagentTask>; truncated: boolean } {
  const byAgentId = new Map<string, KimiSubagentTask>();
  const tasksDir = join(sessionDir, 'agents', 'main', 'tasks');
  let listing: KimiRegistryListing;
  try {
    listing = io.listNames(tasksDir, KIMI_SUBAGENT_TASK_SCAN_MAX);
  } catch {
    // No tasks directory at all — the common case (31/59 sessions). Not an error.
    return { byAgentId, truncated: false };
  }
  const candidates = listing.names.filter((n) => n.startsWith('agent-') && n.endsWith('.json')).sort();
  const examined = candidates.slice(0, KIMI_SUBAGENT_TASK_READ_MAX);
  const truncated = listing.truncated || examined.length < candidates.length;

  for (const name of examined) {
    if (!isSafePathComponent(name)) continue;
    const head = readHead(io, join(tasksDir, name), KIMI_SUBAGENT_TASK_MAX_BYTES);
    if (!head || !head.complete) continue;
    const record = parseOrNull(head.text);
    if (!record) continue;
    // `kind` is checked, not assumed from the filename: a `process` record that
    // happened to be named `agent-*` must not become a spawn record.
    if (str(record.kind) !== 'agent') continue;
    const agentId = str(record.agentId);
    const taskId = str(record.taskId);
    if (agentId === undefined || taskId === undefined) continue;
    const task: KimiSubagentTask = {
      taskId,
      agentId,
      ...(str(record.description) !== undefined ? { description: str(record.description) } : {}),
      ...(str(record.status) !== undefined ? { status: str(record.status) } : {}),
      ...(str(record.subagentType) !== undefined ? { subagentType: str(record.subagentType) } : {}),
      ...(num(record.startedAt) !== undefined ? { startedAt: num(record.startedAt) } : {}),
      ...(num(record.endedAt) !== undefined ? { endedAt: num(record.endedAt) } : {}),
      ...(str(record.model) !== undefined ? { model: str(record.model) } : {}),
    };
    const held = byAgentId.get(agentId);
    if (held === undefined || (task.startedAt ?? 0) >= (held.startedAt ?? 0)) byAgentId.set(agentId, task);
  }
  return { byAgentId, truncated };
}

// ── Journal head ────────────────────────────────────────────────────────────

/** What a bounded head read of one child journal yields (§4, §9). */
export interface KimiChildJournalHead {
  protocolVersion?: string;
  createdAt?: number;
  profileName?: string;
  modelAlias?: string;
  cwd?: string;
  /** First `turn.prompt`'s leading text part — the title fallback (53/53). */
  firstPromptText?: string;
  bytesRead: number;
  complete: boolean;
  droppedLines: number;
  /**
   * What the journal's own lines say about its last turn. `settled`: a settle
   * line with nothing reopening it after — the child finished. `open`: a
   * `turn.prompt` or `llm.request` stands unanswered — a turn is in flight.
   * `none`: no lifecycle line in the window at all (a protocol-1.4 journal
   * that never writes them, or a window swallowed by one giant line) — absence
   * of evidence, decided by freshness alone.
   */
  tailEvidence: 'settled' | 'open' | 'none';
}

/**
 * Decode the identity fields from a bounded head of one child journal.
 *
 * Reads exactly the four line types that were measured to carry them:
 *   `metadata`      → `protocol_version`, `created_at` (line 1, 112/112)
 *   `config.update` → `profileName`, `modelAlias`, `cwd`
 *   `profile.bind`  → the same three
 *   `turn.prompt`   → `input[0].text`
 * Every other line type is skipped without interpretation. Unknown types are
 * not a fallback branch here: this function answers identity, and a line it was
 * not measured against has nothing to say about identity.
 *
 * FIRST WINS for each field. A slot's journal is the concatenation of every
 * task that ran in it (§5.2) and the head covers the earliest; taking the last
 * value seen inside an arbitrary 64 KiB window would make the answer depend on
 * where the cut fell.
 */
export function readKimiChildJournalHead(
  wirePath: string,
  io: KimiSubagentIo = defaultKimiSubagentIo,
  maxBytes: number = KIMI_SUBAGENT_HEAD_BYTES,
): (KimiChildJournalHead & { mtimeMs: number }) | undefined {
  const head = readHead(io, wirePath, maxBytes);
  if (!head) return undefined;
  const { lines, dropped } = completeLines(head.text, head.complete);
  // Lifecycle evidence is read from the TAIL window when the head did not
  // reach EOF — the settle line of a finished journal is in its last lines
  // (measured) — and from the head's own lines when it did. A tail read starts
  // mid-line by construction, so its first fragment is dropped the same way
  // completeLines drops the head's last one.
  const tailEvidence = head.complete
    ? classifyTailEvidence(lines)
    : classifyTailEvidence(head.tailText !== undefined ? head.tailText.split('\n').slice(1) : []);
  const out: KimiChildJournalHead & { mtimeMs: number } = {
    bytesRead: Buffer.byteLength(head.text, 'utf8'),
    complete: head.complete,
    droppedLines: dropped,
    mtimeMs: head.mtimeMs,
    tailEvidence,
  };
  for (const line of lines) {
    const record = parseOrNull(line);
    if (!record) continue;
    switch (str(record.type)) {
      case 'metadata': {
        out.protocolVersion ??= str(record.protocol_version);
        out.createdAt ??= num(record.created_at);
        break;
      }
      case 'config.update':
      case 'profile.bind': {
        out.profileName ??= str(record.profileName);
        out.modelAlias ??= str(record.modelAlias);
        out.cwd ??= str(record.cwd);
        break;
      }
      case 'turn.prompt': {
        if (out.firstPromptText !== undefined) break;
        const input = record.input;
        if (!Array.isArray(input)) break;
        for (const part of input) {
          if (part === null || typeof part !== 'object' || Array.isArray(part)) continue;
          const p = part as Record<string, unknown>;
          if (str(p.type) !== 'text') continue;
          const text = str(p.text);
          if (text !== undefined) {
            out.firstPromptText = text;
            break;
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * Roster title for a child. The spawn record's `description` first — it is a
 * human-written label, and the first prompt is a machine-written brief (44/53
 * open with a `<git-context>` or "You are working in…" preamble). Never a guess
 * from journal content, and never the empty string.
 */
export function kimiSubagentTitle(agentDir: string, task?: KimiSubagentTask, firstPromptText?: string): string {
  const description = task?.description?.trim();
  if (description) return description.slice(0, KIMI_SUBAGENT_TITLE_MAX);
  const prompt = firstPromptText?.trim();
  if (prompt) return prompt.slice(0, KIMI_SUBAGENT_TITLE_MAX);
  return agentDir;
}

/**
 * Status for a child row.
 *
 * Round 1 used the claude conjunction — parent working AND journal fresh —
 * because the 1.4 measurement found no completion evidence in any child
 * journal. The 2026-08-27 physical pass broke that rule on the live 0.38.0
 * host: a DETACHED protocol-1.5 child kept working after the parent's turn
 * settled (server `activity: idle`, main journal quiet 17 minutes, the child
 * appending `llm.request` lines while this was measured), and that session
 * carried no `agents/main/tasks` spawn records at all — so both of round 1's
 * evidences said idle about a child that was demonstrably running.
 *
 * Protocol 1.5 journals record their own lifecycle (`turn.ended` /
 * `turn.cancel` / `token_counting.turn_recorded`; 3/3 finished children carried
 * one in their last lines), so the child's own record replaces the parent
 * proxy:
 *
 *  1. a spawn record with `endedAt` settles it — a statement, kept from round 1;
 *  2. a tail whose last lifecycle line is a settle settles it — the journal's
 *     own statement;
 *  3. a tail whose last lifecycle line leaves a turn OPEN claims working while
 *     the journal stays within {@link KIMI_SUBAGENT_OPEN_TURN_FRESH_MS} — the
 *     quiet stretch of a generating model is minutes, not seconds (measured);
 *  4. a journal with no lifecycle evidence at all falls back to the short
 *     {@link KIMI_SUBAGENT_WORKING_FRESH_MS} window, so a protocol-1.4 file
 *     that merely got touched cannot claim working for long.
 */
export function kimiSubagentStatus(
  child: Pick<KimiSubagentChild, 'updatedAt' | 'task' | 'tailEvidence'>,
  now: number,
): 'working' | 'idle' {
  if (child.task?.endedAt !== undefined) return 'idle';
  if (child.tailEvidence === 'settled') return 'idle';
  const window = child.tailEvidence === 'open' ? KIMI_SUBAGENT_OPEN_TURN_FRESH_MS : KIMI_SUBAGENT_WORKING_FRESH_MS;
  return now - child.updatedAt <= window ? 'working' : 'idle';
}

// ── The enumerator ──────────────────────────────────────────────────────────

/**
 * The subagent slots of ONE parent session the adapter already knows.
 *
 * The caller must already have admitted the parent to the roster — round 1's
 * rule kept verbatim, so windowed discovery never pays for a cold session's
 * child tree, and the walk is the same shape for every parent that survives.
 *
 * Cost per parent, all bounded and all measured against the real host:
 *   1 workspace listing (≤ 256 entries) + ≤ 256 directory probes  → locate
 *   1 bounded read of `state.json` (≤ 256 KiB; measured max 8,821) → enumerate
 *   1 bounded listing of `agents/main/tasks/` + ≤ 32 small reads   → titles
 *   ≤ 32 bounded 64 KiB head reads, one per EXAMINED child         → identity
 * A parent with no children costs the first two and stops. Nothing scales with
 * the size of a journal, the number of tasks, the depth of the tree, or the
 * number of entries `state.json` claims — the identity line is capped by
 * {@link KIMI_SUBAGENT_DIR_SCAN_MAX} whatever the map says.
 *
 * Reports rather than hides its limits: `truncated` covers every ceiling —
 * the workspace listing, the task listing, the examination cap and the yield
 * budget; `filtered` separates "no child is recent" from "no child exists";
 * `reads` is the io actually attempted. A caller that sees `truncated` must not
 * conclude the list is whole.
 */
export function listKimiSubagents(options: KimiSubagentScanOptions): KimiSubagentScan {
  const io = options.io ?? defaultKimiSubagentIo;
  const scan: KimiSubagentScan = { children: [], truncated: false, filtered: 0, reads: 0 };

  const located = locateKimiSessionDirectory(options.wireRoot, options.parentSessionId, io);
  scan.truncated = located.truncated;
  if (located.sessionDir === undefined) return scan;
  const sessionDir = located.sessionDir;

  const entries = readKimiAgentsMap(sessionDir, io);
  // No readable `state.json` yields NO children rather than a directory walk.
  // The map is the only source of `type` (§2), and a walk would have to guess
  // which directories are children from their names — exactly the inference
  // this lane exists to avoid.
  if (entries === undefined) return scan;

  const childDirs = entries
    .filter((entry) => entry.type === 'sub' && isSafePathComponent(entry.agentId))
    .map((entry) => entry.agentId)
    .sort();
  if (childDirs.length === 0) return scan;

  // Only paid for once a child is known to exist.
  const spawns = readKimiSpawnRecords(sessionDir, io);
  scan.truncated ||= spawns.truncated;

  let budget = options.yieldBudget ?? Number.POSITIVE_INFINITY;
  // TWO independent ceilings, because they bound two different things.
  //
  // The yield budget bounds ROWS, and is spent only when a row is actually
  // produced — that is what makes it a fair share of the roster. On its own it
  // bounds no WORK: a child outside the cutoff, or one whose journal has
  // vanished, yields nothing and would therefore cost a 64 KiB head read for
  // free, so a state map listing thousands of cold slots would run thousands of
  // reads while the budget never moved. The examination cap is what bounds the
  // work — it is spent by every candidate the loop LOOKS AT, before any io and
  // whatever the outcome, so cold, missing and unreadable children are paid for
  // at the same rate as yielded ones.
  let examinations = KIMI_SUBAGENT_DIR_SCAN_MAX;
  for (const agentDir of childDirs) {
    if (budget <= 0) {
      // The sweep's shared budget is spent. Children counted against it exactly
      // as round 1 counts claude's, so a session with 20 slots cannot crowd out
      // every other agent's rows.
      scan.truncated = true;
      break;
    }
    if (examinations <= 0) {
      // Reported, never silent: a caller seeing a short list without this flag
      // would conclude the parent has no more children.
      scan.truncated = true;
      break;
    }
    examinations -= 1;
    const wirePath = join(sessionDir, 'agents', agentDir, 'wire.jsonl');
    if (!isWithinRoot(resolve(sessionDir), resolve(wirePath))) continue;
    // Counted as an ATTEMPT, before the read is known to have worked. A counter
    // that moved only on success would report a bounded figure while the
    // failures — the exact case this cap exists for — stayed invisible.
    scan.reads += 1;
    const head = readKimiChildJournalHead(wirePath, io);
    // An unreadable journal publishes NO row. A slot with no journal is not a
    // session anyone can open, and a row whose history cannot be replayed is
    // worse than no row.
    if (head === undefined) continue;
    if (options.updatedAfter !== undefined && head.mtimeMs < options.updatedAfter) {
      scan.filtered += 1;
      continue;
    }
    const task = spawns.byAgentId.get(agentDir);
    scan.children.push({
      agentDir,
      nativeId: kimiSubagentNativeId(options.parentSessionId, agentDir),
      parentThreadId: kimiSessionNativeId(options.parentSessionId),
      parentSessionId: options.parentSessionId,
      wirePath,
      title: kimiSubagentTitle(agentDir, task, head.firstPromptText),
      ...(task?.subagentType ?? head.profileName ? { subagentType: task?.subagentType ?? head.profileName } : {}),
      ...(head.modelAlias !== undefined ? { modelAlias: head.modelAlias } : {}),
      ...(head.createdAt !== undefined ? { createdAt: head.createdAt } : {}),
      updatedAt: head.mtimeMs,
      ...(head.cwd !== undefined ? { cwd: head.cwd } : {}),
      ...(head.protocolVersion !== undefined ? { protocolVersion: head.protocolVersion } : {}),
      ...(task !== undefined ? { task } : {}),
      headBytesRead: head.bytesRead,
      headComplete: head.complete,
      droppedLines: head.droppedLines,
      tailEvidence: head.tailEvidence,
    });
    budget -= 1;
  }
  return scan;
}

/**
 * Convenience wrapper for a caller holding a `KIMI_CODE_HOME` rather than a
 * wire root. Kept separate so the root stays injectable for tests.
 */
export function listKimiSubagentsForHome(
  home: string,
  parentSessionId: string,
  options?: Omit<KimiSubagentScanOptions, 'wireRoot' | 'parentSessionId'>,
): KimiSubagentScan {
  return listKimiSubagents({ ...options, wireRoot: kimiSessionWireRoot(home), parentSessionId });
}

// ── Roster rows ─────────────────────────────────────────────────────────────

/**
 * Read a session id back as a subagent handle, or `undefined` for an ordinary
 * Kimi session.
 *
 * A child row's `id` IS its `nativeId` — dsh's precedent, and available here
 * because the namespace is unambiguous: a real Kimi session id is
 * `session_<uuid>` (measured on 59/59 sessions), so a `kimi-subagent:` prefix
 * can never name one. The handle round-trips, which is what lets `attach`
 * recognize a child from the id ALONE, with no roster read and no HTTP call
 * standing between the request and the refusal.
 */
export function kimiSubagentIdInfo(
  id: string,
): { parentSessionId: string; agentDir: string } | undefined {
  if (!id.startsWith(KIMI_SUBAGENT_NATIVE_PREFIX)) return undefined;
  const rest = id.slice(KIMI_SUBAGENT_NATIVE_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return undefined;
  const parentSessionId = rest.slice(0, slash);
  const agentDir = rest.slice(slash + 1);
  // The two components become path segments on the history read, so they face
  // the same gate every other untrusted segment in this module faces — and they
  // face it HERE, at the boundary, not at the read.
  if (!isSafePathComponent(parentSessionId) || !isSafePathComponent(agentDir)) return undefined;
  return { parentSessionId, agentDir };
}

/**
 * Observe-only control for a child row.
 *
 * Deliberately carries NO terminalSync `label`/`command`. The generic "Resume
 * in terminal" tip would render something like `kimi -S agent-3`, which is not
 * a session id and not a conversation the CLI can rejoin; nothing measured
 * suggests any command reattaches a terminal to a subagent slot (wire-facts
 * §U7). An offer that cannot work is worse than no offer.
 *
 * Single-sourced with the attach refusal through {@link KIMI_SUBAGENT_OWNED_REASON}
 * so the advertisement and the enforcement cannot drift apart.
 */
export function kimiSubagentControlState(): SessionControlState {
  return {
    drive: { state: 'unavailable', supported: false, reason: KIMI_SUBAGENT_OWNED_REASON },
    terminalSync: {
      supported: false,
      syncAvailable: false,
      active: false,
      reason: `Terminal sync is unavailable here: a Kimi subagent has no conversation of its own to rejoin. ${KIMI_SUBAGENT_OWNED_REASON}`,
    },
  };
}

/**
 * The roster's model identity for a provider-qualified alias.
 *
 * The alias joins `GET /api/v1/models` on `modelID` exactly — the same join
 * `mapKimiSessionStatus` documents. The join is what puts a model on the
 * ROSTER: the client refuses (by policy) to render a bare provider-qualified
 * alias inline, so a row without `currentModel.label` shows no model at all —
 * the raw alias lives only in the tooltip. An alias the catalog does not know,
 * or no catalog at all, yields nothing rather than inventing a name.
 */
export function kimiModelIdentityFromAlias(
  alias: string,
  catalog: readonly ModelOption[] | undefined,
): SessionInfo['currentModel'] | undefined {
  const entry = catalog?.find((option) => option.modelID === alias);
  return entry
    ? { providerID: entry.providerID, modelID: alias, label: entry.label }
    : undefined;
}

/**
 * The PARENT session's own launch model, from its `agents/main/wire.jsonl` head.
 *
 * `/api/v2/sessions` — the discovery endpoint — carries no model field at all,
 * and the only server surface that does (`/api/v1/sessions/{id}/status`) is
 * per-session and paid only on attach. So an unopened parent showed no model on
 * the roster (2026-08-27 physical pass) while its children did — the children's
 * aliases come free from the journal walk. The parent's own journal head
 * carries the same `config.update` evidence (MEASURED 2026-08-27: 6/6 recent
 * main journals on the live host yielded `modelAlias` within the head cap), so
 * the parent pays the same bounded head read, through the same io, under the
 * same ceilings. A missing tree, map, or journal yields `undefined` — never a
 * throw, and never a directory guess: `main` is the same literal spelling the
 * task-record reader already uses.
 */
export function readKimiParentModelAlias(options: {
  wireRoot: string;
  parentSessionId: string;
  io?: KimiSubagentIo;
}): string | undefined {
  const io = options.io ?? defaultKimiSubagentIo;
  const located = locateKimiSessionDirectory(options.wireRoot, options.parentSessionId, io);
  if (located.sessionDir === undefined) return undefined;
  const wirePath = join(located.sessionDir, 'agents', 'main', 'wire.jsonl');
  if (!isWithinRoot(resolve(located.sessionDir), resolve(wirePath))) return undefined;
  return readKimiChildJournalHead(wirePath, io)?.modelAlias;
}

/**
 * One child slot as a roster row.
 *
 * The lineage pair is the whole point: `parentThreadId` equals the parent's
 * PUBLISHED `nativeId`, which the caller must have set to
 * {@link kimiSessionNativeId} on the same sweep — the client joins
 * `(machine, tool, nativeId)`, so a pair that does not match renders the child
 * flat with no error anywhere (reflection §2, the dsh `nativeId` case).
 *
 * `cwd` falls back to the PARENT's: a subagent runs in its parent's workspace,
 * and only 23 of 53 measured children recorded one of their own. `model` is the
 * host's provider-qualified alias verbatim — never a label this adapter
 * invented (reflection §3).
 *
 * `catalog` is `GET /api/v1/models` as the SWEEP read it, and the alias joins
 * it on `modelID` exactly — the same join `mapKimiSessionStatus` documents for
 * the parent row. The join is what puts a model on the ROSTER: the client
 * refuses (by policy) to render a bare provider-qualified alias inline, so a
 * child row without `currentModel.label` shows no model at all — the raw alias
 * lives only in the tooltip. An alias the catalog does not know, or no catalog
 * at all, keeps exactly that behaviour rather than inventing a name.
 */
export function kimiSubagentRow(
  child: KimiSubagentChild,
  parent: Pick<SessionInfo, 'cwd'>,
  now: number,
  catalog?: readonly ModelOption[],
): SessionInfo {
  const identity = child.modelAlias !== undefined
    ? kimiModelIdentityFromAlias(child.modelAlias, catalog)
    : undefined;
  return {
    id: child.nativeId,
    tool: 'kimi',
    title: child.title,
    nativeId: child.nativeId,
    origin: 'subagent',
    parentThreadId: child.parentThreadId,
    ...(child.cwd ?? parent.cwd ? { cwd: child.cwd ?? parent.cwd } : {}),
    status: kimiSubagentStatus(child, now),
    launchSurface: 'unknown',
    attachMode: 'observe',
    ...(child.modelAlias !== undefined ? { model: child.modelAlias } : {}),
    ...(identity ? { currentModel: identity } : {}),
    ...(child.createdAt !== undefined ? { createdAt: child.createdAt } : {}),
    updatedAt: child.updatedAt,
    control: kimiSubagentControlState(),
  };
}
