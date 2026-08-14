#!/usr/bin/env bun
/**
 * H1c — a bounded large-history refusal never becomes an empty session.
 *
 * Two independent claims are proved here.
 *
 * 1. The construction ceilings match the PUBLIC paging contract. A source
 *    inside the advertised 256 MiB / 50,000-message native bound must produce
 *    an index. Before H1c an 8 MiB adapter reader cap and a 12 MiB broker index
 *    cap — neither of them stated anywhere in the contract — refused the real
 *    137.8 MiB / 26,984-message `cosyncing-orch` rollout outright.
 *
 * 2. When a source genuinely IS beyond the contract, the refusal still yields
 *    the newest usable replay or nothing at all — never an authoritative empty
 *    history, and never a true session start.
 */
import { strict as assert } from 'node:assert';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type {
  AgentMessage,
  HistorySnapshotSink,
} from '../../../adapter-api/src/index.ts';
import {
  CodexEnrichStore,
  captureFileHistoryInto,
  enrichEntryBytes,
} from '../../../adapters/codex/src/index.ts';
import {
  backwardHistoryCursorFromHash,
  historyCursorFromHash,
} from '../../src/sessions/history-delta.ts';
import {
  BoundedTailHistorySnapshotSink,
  EncodedHistoryPageCache,
  HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES,
  HISTORY_PAGE_CACHE_MAX_ENTRY_MESSAGES,
  HISTORY_PAGE_CACHE_MAX_INDEX_BYTES,
  HISTORY_PAGE_CACHE_MAX_PAGE_MESSAGES,
  HISTORY_TAIL_REPLAY_MAX_BYTES,
  HISTORY_TAIL_REPLAY_MAX_MESSAGES,
  HistoryPageCachePool,
  IndexedHistoryPageCacheBuilder,
  historySourceStillContainsSnapshot,
  type BoundedTailHistoryReplay,
  type CompactHistoryAttach,
  type IndexedHistoryPageCache,
} from '../../src/sessions/history-page-cache.ts';

const PAGE_MESSAGES = 100;
/** The old adapter reader ceiling. A fixture inside the contract must exceed it. */
const RETIRED_READER_MAX_BYTES = 8 * 1024 * 1024;
/** The old broker compact-index ceiling. Same requirement. */
const RETIRED_INDEX_MAX_BYTES = 12 * 1024 * 1024;

const REAL_ROLLOUT_FLAG = 'COSYNCING_TEST_REAL_ROLLOUT';
const REAL_ROLLOUT_PATH = 'COSYNCING_TEST_REAL_ROLLOUT_PATH';

/**
 * The operator-supplied real rollout, or nothing.
 *
 * Reading a real Codex session requires BOTH an explicit opt-in flag and an
 * explicit absolute path. Nothing is ever discovered from a home directory, so
 * no operator's own session path can enter this tree or be read by accident.
 * Neither variable set is the default: the real-host block below skips and
 * every hermetic proof in this suite still runs. Exactly one variable set is a
 * configuration error rather than a silent skip — a half-configured opt-in
 * would otherwise quietly stop covering the thing it was set up to cover.
 *
 * Only a rollout large enough to exceed the retired reader ceiling proves
 * anything here, which the real-host block asserts rather than assumes.
 */
function resolveRealRollout(): string | undefined {
  const flag = process.env[REAL_ROLLOUT_FLAG] ?? '';
  const path = process.env[REAL_ROLLOUT_PATH] ?? '';
  const optedIn = flag !== '' && flag !== '0' && flag.toLowerCase() !== 'false';
  const pinned = path !== '';
  if (!optedIn && !pinned) return undefined;
  if (optedIn !== pinned) {
    throw new Error(
      `real-rollout opt-in is half-configured (${REAL_ROLLOUT_FLAG}=`
      + `${JSON.stringify(flag)}, ${REAL_ROLLOUT_PATH}=${JSON.stringify(path)}`
      + `): set BOTH ${REAL_ROLLOUT_FLAG}=1 and ${REAL_ROLLOUT_PATH}=`
      + '<absolute path to a rollout .jsonl>, or neither. '
      + `An unset, empty, "0" or "false" ${REAL_ROLLOUT_FLAG} counts as off.`,
    );
  }
  if (!isAbsolute(path)) {
    throw new Error(`${REAL_ROLLOUT_PATH} must be absolute, got ${JSON.stringify(path)}`);
  }
  if (!existsSync(path)) {
    throw new Error(`${REAL_ROLLOUT_PATH} does not exist: ${path}`);
  }
  return path;
}

const REAL_FIXTURE = resolveRealRollout();

const temp = mkdtempSync('/tmp/cosyncing-h1c-');

function writeRollout(name: string, rows: readonly string[]): string {
  const path = join(temp, name);
  const fd = openSync(path, 'w');
  try {
    for (let base = 0; base < rows.length; base += 500) {
      writeSync(fd, `${rows.slice(base, base + 500).join('\n')}\n`);
    }
  } finally {
    closeSync(fd);
  }
  return path;
}

function userRow(index: number, pad = 0): string {
  return JSON.stringify({
    timestamp: '2026-07-28T00:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: pad > 0 ? `row ${index} ${'x'.repeat(pad)}` : `row ${index}`,
    },
  });
}

/** A function call whose NAME survives descriptor templating, so the compact
 *  reader's retained bytes grow the way a real MCP-heavy rollout's do. */
function fatCallRow(index: number, nameLength: number): string {
  return JSON.stringify({
    timestamp: '2026-07-28T00:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: `mcp__fixture__${'n'.repeat(nameLength)}_${index}`,
      call_id: `call-${index}`,
      arguments: '{"a":1}',
    },
  });
}

type IndexedCapture = {
  outcome: 'cache' | 'refusal' | 'moved' | 'over-budget';
  cache?: IndexedHistoryPageCache;
  readerRetainedBytes?: number;
  accepted: number;
};

async function captureIndexed(
  path: string,
  maxBytes = HISTORY_PAGE_CACHE_MAX_INDEX_BYTES,
  maxMessages = HISTORY_PAGE_CACHE_MAX_ENTRY_MESSAGES,
): Promise<IndexedCapture> {
  const builder = new IndexedHistoryPageCacheBuilder(maxBytes, maxMessages);
  let accepted = 0;
  const sink: HistorySnapshotSink = {
    acceptsLocations: true,
    accept(message: AgentMessage, location?: number): boolean {
      const ok = builder.accept(message, location);
      if (ok) accepted += 1;
      return ok;
    },
  };
  const captured = await captureFileHistoryInto(path, sink);
  if (!captured) return { outcome: 'moved', accepted };
  if ('refusal' in captured) return { outcome: 'refusal', accepted };
  const cache = builder.finish(captured.identity, captured.reader);
  return cache
    ? {
        outcome: 'cache',
        cache,
        readerRetainedBytes: captured.reader?.retainedBytes,
        accepted,
      }
    : {
        outcome: 'over-budget',
        readerRetainedBytes: captured.reader?.retainedBytes,
        accepted,
      };
}

async function captureTail(
  path: string,
  maxMessages = HISTORY_TAIL_REPLAY_MAX_MESSAGES,
  maxBytes = HISTORY_TAIL_REPLAY_MAX_BYTES,
): Promise<{ replay?: BoundedTailHistoryReplay; sink: BoundedTailHistorySnapshotSink; refused: boolean }> {
  const sink = new BoundedTailHistorySnapshotSink(maxMessages, maxBytes);
  const captured = await captureFileHistoryInto(path, sink);
  if (!captured || 'refusal' in captured) {
    return { sink, refused: true };
  }
  return { replay: sink.finish(captured.identity), sink, refused: false };
}

/**
 * The invariant every refusal path must satisfy.
 *
 * `durableCount` is what makes this live up to its name. Checking only whether a
 * frame CLAIMS a session start let a replacement frame carrying zero messages
 * for a history with thousands pass — which is the H1c symptom itself: the
 * client clears its transcript and renders a notice above nothing. When the
 * caller states how many durable messages the captured prefix holds, a reset
 * frame for a non-empty one must carry at least one (H1c round 3, finding 3).
 */
function assertNeverAuthoritativeEmpty(
  attach: CompactHistoryAttach,
  label: string,
  durableCount?: number,
): void {
  const claimsStart = attach.reset
    && !attach.hasEarlier
    && attach.truncated === undefined;
  assert(
    !(attach.reset && attach.messages.length === 0 && claimsStart),
    `${label}: refusal claimed an authoritative empty history / true session start`,
  );
  if (durableCount !== undefined && durableCount > 0 && attach.reset) {
    assert(
      attach.messages.length > 0,
      `${label}: a replacement frame for a ${durableCount}-message history carried no messages`,
    );
  }
}

try {
  // ---------------------------------------------------------------- ceilings
  // The compact index budget IS the per-entry paging budget. A smaller private
  // number here is what made the compact path refuse sources the encoded path
  // advertises.
  assert.equal(
    HISTORY_PAGE_CACHE_MAX_INDEX_BYTES,
    HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES,
    'compact index budget drifted below the public per-entry paging budget',
  );
  assert.equal(HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES, 32 * 1024 * 1024);
  assert.equal(HISTORY_PAGE_CACHE_MAX_ENTRY_MESSAGES, 50_000);
  assert.equal(HISTORY_PAGE_CACHE_MAX_PAGE_MESSAGES, 500);
  assert.equal(HISTORY_TAIL_REPLAY_MAX_MESSAGES, 500);
  assert.equal(HISTORY_TAIL_REPLAY_MAX_BYTES, 4 * 1024 * 1024);

  // ------------------------------------------- inside the contract must build
  // 40,000 messages, well inside the 50,000-message bound, retaining more than
  // BOTH retired ceilings and less than the aligned one. This is the hermetic
  // stand-in for the production `cosyncing-orch` rollout.
  const insideRows: string[] = [];
  for (let index = 0; index < 20_000; index += 1) {
    insideRows.push(fatCallRow(index, 120));
    insideRows.push(userRow(index));
  }
  const inside = writeRollout('inside-contract.jsonl', insideRows);
  const insideCapture = await captureIndexed(inside);
  assert.equal(
    insideCapture.outcome,
    'cache',
    'a source inside the public contract must produce a compact index',
  );
  assert(
    (insideCapture.readerRetainedBytes ?? 0) > RETIRED_READER_MAX_BYTES,
    `fixture retained only ${insideCapture.readerRetainedBytes} reader bytes; it no longer exercises the retired 8 MiB adapter ceiling`,
  );
  assert(
    (insideCapture.cache?.encodedBytes ?? 0) > RETIRED_INDEX_MAX_BYTES,
    `fixture retained only ${insideCapture.cache?.encodedBytes} index bytes; it no longer exercises the retired 12 MiB broker ceiling`,
  );
  assert(
    (insideCapture.cache?.encodedBytes ?? 0) <= HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES,
    'aligned construction still has to stay inside the per-entry budget',
  );
  const insideAttach = await insideCapture.cache!.loadAttach(
    undefined,
    PAGE_MESSAGES,
  );
  assert(!('kind' in insideAttach), 'inside-contract attach must serve');
  assert.equal(insideAttach.messages.length, PAGE_MESSAGES);
  assert(insideAttach.olderCursor, 'a served index must offer older pages');

  // ------------------------------------------------- every real refusal path
  // Each of these refuses the INDEX. Every one of them must still leave the
  // bounded tail reader available: a ceiling that exists to bound retention has
  // nothing to say to a reader whose retention is a fixed window, and applying
  // it anyway is what left a first-time client with a notice and no messages.
  //
  // 1. Native source bytes, decided from the fstat alone.
  const oversizePath = join(temp, 'oversize.jsonl');
  const oversizeFd = openSync(oversizePath, 'w');
  try {
    // Sparse: the hole reads as one enormous record the tail read skips past,
    // and the real rows live beyond the indexing ceiling.
    ftruncateSync(oversizeFd, 256 * 1024 * 1024 + 1);
    writeSync(
      oversizeFd,
      `\n${Array.from({ length: 40 }, (_unused, index) => userRow(index, 64)).join('\n')}\n`,
      256 * 1024 * 1024 + 1,
    );
  } finally {
    closeSync(oversizeFd);
  }
  assert(statSync(oversizePath).size > 256 * 1024 * 1024);
  assert.equal((await captureIndexed(oversizePath)).outcome, 'refusal');
  const oversizeTail = await captureTail(oversizePath);
  assert(
    !oversizeTail.refused,
    'a bounded tail read must survive the indexing source ceiling',
  );
  assertNeverAuthoritativeEmpty(
    oversizeTail.replay!.attach(undefined, PAGE_MESSAGES),
    'over-source attach',
    oversizeTail.replay!.durableCount,
  );
  assert.equal(
    oversizeTail.replay!.attach(undefined, PAGE_MESSAGES).messages.length,
    40,
    'an over-contract source must still replay its newest messages',
  );

  // Beyond the tail reader's own ceiling, refusing is right again — the cost
  // there is streaming TIME, which no window size bounds.
  const beyondTailPath = join(temp, 'beyond-tail.jsonl');
  const beyondTailFd = openSync(beyondTailPath, 'w');
  try {
    ftruncateSync(beyondTailFd, 4 * 256 * 1024 * 1024 + 1);
  } finally {
    closeSync(beyondTailFd);
  }
  assert(
    (await captureTail(beyondTailPath)).refused,
    'the bounded tail read must still have a stated ceiling of its own',
  );

  // 2. One newline-delimited record beyond the per-record budget. It could
  //    never fit a bounded window, so it is skipped rather than fatal.
  const hugeRecordPath = join(temp, 'huge-record.jsonl');
  const hugeFd = openSync(hugeRecordPath, 'w');
  try {
    for (let index = 0; index < 20; index += 1) {
      writeSync(hugeFd, `${userRow(index, 64)}\n`);
    }
    const chunk = Buffer.alloc(1 << 20, 0x78);
    writeSync(hugeFd, '{"type":"event_msg","payload":{"type":"user_message","message":"');
    for (let written = 0; written < 33; written += 1) writeSync(hugeFd, chunk);
    writeSync(hugeFd, '"}}\n');
    for (let index = 100; index < 120; index += 1) {
      writeSync(hugeFd, `${userRow(index, 64)}\n`);
    }
  } finally {
    closeSync(hugeFd);
  }
  assert(statSync(hugeRecordPath).size > 32 * 1024 * 1024);
  assert.equal((await captureIndexed(hugeRecordPath)).outcome, 'refusal');
  const hugeRecordTail = await captureTail(hugeRecordPath);
  assert(!hugeRecordTail.refused, 'an oversized record must not cost every other message');
  const hugeRecordAttach = hugeRecordTail.replay!.attach(undefined, PAGE_MESSAGES);
  assertNeverAuthoritativeEmpty(hugeRecordAttach, 'over-record attach', hugeRecordTail.replay!.durableCount);
  assert.equal(
    hugeRecordAttach.messages.length,
    40,
    'both sides of a skipped record must still be replayed',
  );

  // 3. Enrichment ceilings: evicted oldest-first rather than fatal, exactly as
  //    the live tail already does, so the newest calls keep their detail.
  const overEnrichPath = writeRollout('over-enrich.jsonl', [
    ...Array.from({ length: 60_000 }, (_unused, index) => JSON.stringify({
      timestamp: '2026-07-28T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell',
        call_id: `c${index}`,
        arguments: '{"a":1}',
      },
    })),
    ...Array.from({ length: 20 }, (_unused, index) => userRow(index, 64)),
  ]);
  assert.equal((await captureIndexed(overEnrichPath)).outcome, 'refusal');
  const overEnrichTail = await captureTail(overEnrichPath);
  assert(!overEnrichTail.refused, 'the enrichment ceiling must not deny a bounded tail');
  const overEnrichAttach = overEnrichTail.replay!.attach(undefined, PAGE_MESSAGES);
  assertNeverAuthoritativeEmpty(overEnrichAttach, 'over-enrich attach', overEnrichTail.replay!.durableCount);
  assert.equal(overEnrichAttach.messages.length, PAGE_MESSAGES);
  assert(overEnrichAttach.hasEarlier);
  assert.equal(overEnrichAttach.truncated?.total, overEnrichTail.replay!.durableCount);

  // 4. The compact reader's native call-reference ceiling — an index-only
  //    ceiling, so the plain streaming path stays available underneath it.
  const sharedCallRows: string[] = [];
  for (let index = 0; index < 400; index += 1) sharedCallRows.push(userRow(index, 64));
  for (let index = 0; index < 96; index += 1) {
    sharedCallRows.push(JSON.stringify({
      timestamp: '2026-07-28T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'shared-call',
        output: `output ${index}`,
      },
    }));
  }
  const sharedCall = writeRollout('shared-call.jsonl', sharedCallRows);
  assert.equal(
    (await captureIndexed(sharedCall)).outcome,
    'refusal',
    'more call references than the compact reader retains must refuse the index',
  );

  // 5. Broker compact-index byte and message ceilings, at their real gates.
  assert.equal((await captureIndexed(inside, 64 * 1024)).outcome, 'refusal');
  assert.equal((await captureIndexed(inside, undefined, 128)).outcome, 'refusal');

  // 6. Broker encoded-entry ceilings (the non-compact shape).
  const encodedMessages: AgentMessage[] = Array.from(
    { length: 64 },
    (_unused, index) => ({
      type: 'user-message',
      text: 'y'.repeat(4_096),
      timestamp: index,
    }) as unknown as AgentMessage,
  );
  assert.equal(
    EncodedHistoryPageCache.create(
      { sourceId: 's', revision: 'r' },
      encodedMessages,
      16 * 1024,
    ),
    undefined,
    'the encoded entry byte ceiling must still refuse',
  );
  assert.equal(
    EncodedHistoryPageCache.create(
      { sourceId: 's', revision: 'r' },
      encodedMessages,
      undefined,
      8,
    ),
    undefined,
    'the encoded entry message ceiling must still refuse',
  );

  // ------------------------------------------- the refusal still says something
  // The SAME source the compact index refuses still yields its newest window.
  const sharedTail = await captureTail(sharedCall);
  assert(!sharedTail.refused && sharedTail.replay, 'the bounded tail must survive an index-only refusal');
  const sharedReplay = sharedTail.replay!;

  // Initial attach, no retained client pages.
  const initial = sharedReplay.attach(undefined, PAGE_MESSAGES);
  assertNeverAuthoritativeEmpty(initial, 'initial attach', sharedReplay.durableCount);
  assert(initial.reset, 'a client with nothing must receive a replacement window');
  assert(initial.messages.length > 0, 'a refusal must still replay the newest messages');
  assert.equal(initial.messages.length, PAGE_MESSAGES);
  assert(initial.hasEarlier, 'earlier history exists and must be admitted');
  assert.equal(initial.truncated?.total, sharedReplay.durableCount);
  assert.equal(
    (initial as { olderCursor?: string }).olderCursor,
    undefined,
    'a fallback must not offer an older cursor it can never serve',
  );
  assert(initial.cursor, 'the fallback must still issue a real reconnect cursor');

  // An initialized client whose cursor lands inside the retained window gets an
  // incremental delta: its retained pages are never replaced.
  const incremental = sharedReplay.attach(initial.cursor, PAGE_MESSAGES);
  assertNeverAuthoritativeEmpty(incremental, 'in-window reconnect');
  assert.equal(incremental.reset, false, 'an in-window cursor must not reset the client');
  assert.equal(incremental.messages.length, 0);
  assert.equal(incremental.truncated, undefined);
  assert.equal(incremental.cursor, initial.cursor);

  // An initialized client whose cursor is older than the retained window — or
  // beyond the prefix entirely — is told so, and still receives the newest
  // usable replay instead of an erasure.
  const narrowReplay = (await captureTail(sharedCall, 8, 64 * 1024)).replay!;
  const evicted = narrowReplay.attach(
    historyCursorFromHash(1, 'a-boundary-this-window-evicted'),
    PAGE_MESSAGES,
  );
  assertNeverAuthoritativeEmpty(evicted, 'evicted-boundary reconnect', narrowReplay.durableCount);
  assert(evicted.reset && evicted.messages.length === 8);
  assert(evicted.hasEarlier);
  assert.equal(evicted.gap?.code, 'HISTORY_CURSOR_GONE');

  const stale = sharedReplay.attach(
    historyCursorFromHash(sharedReplay.durableCount + 5, 'beyond-the-prefix'),
    PAGE_MESSAGES,
  );
  assertNeverAuthoritativeEmpty(stale, 'out-of-range reconnect', sharedReplay.durableCount);
  assert(stale.reset && stale.messages.length > 0);
  assert(stale.hasEarlier);
  assert.equal(stale.gap?.code, 'HISTORY_CURSOR_GONE');

  // A forged in-range cursor diverges rather than silently resolving.
  const forged = sharedReplay.attach(
    historyCursorFromHash(sharedReplay.durableCount, 'forged'),
    PAGE_MESSAGES,
  );
  assertNeverAuthoritativeEmpty(forged, 'forged reconnect', sharedReplay.durableCount);
  assert.equal(forged.gap?.code, 'HISTORY_CURSOR_DIVERGED');
  assert(forged.reset && forged.messages.length > 0);

  const malformed = sharedReplay.attach('!!!not-base64!!!', PAGE_MESSAGES);
  assertNeverAuthoritativeEmpty(malformed, 'malformed reconnect', sharedReplay.durableCount);
  assert.equal(malformed.gap?.code, 'HISTORY_CURSOR_INVALID');
  assert(malformed.messages.length > 0);

  // Nothing the fallback says may claim a full replay it did not send.
  for (const attach of [initial, stale, forged, malformed, incremental]) {
    assert(
      !(attach.gap?.message ?? '').includes('full replay'),
      'a bounded-tail frame must never describe itself as a full replay',
    );
  }

  // ----------------------------------------------------- the tail stays bounded
  // Retention is a fixed window whatever the source size, so this path is
  // admissible exactly where an index is not.
  const bigRows: string[] = [];
  for (let index = 0; index < 12_000; index += 1) bigRows.push(userRow(index, 1_024));
  const big = writeRollout('big.jsonl', bigRows);
  const bigTail = await captureTail(big);
  assert(!bigTail.refused, 'the bounded tail must never refuse for size');
  assert.equal(bigTail.sink.durableCount, 12_000);
  assert(
    bigTail.sink.retainedMessages <= HISTORY_TAIL_REPLAY_MAX_MESSAGES,
    `tail retained ${bigTail.sink.retainedMessages} messages`,
  );
  assert(
    bigTail.sink.retainedBytes <= HISTORY_TAIL_REPLAY_MAX_BYTES,
    `tail retained ${bigTail.sink.retainedBytes} bytes`,
  );
  // Tight explicit bounds prove eviction, not just a fixture that happened to fit.
  const tightTail = await captureTail(big, 12, 64 * 1024);
  assert(!tightTail.refused);
  assert.equal(tightTail.sink.retainedMessages, 12);
  const tightAttach = tightTail.replay!.attach(undefined, PAGE_MESSAGES);
  assertNeverAuthoritativeEmpty(tightAttach, 'tight tail attach', tightTail.replay!.durableCount);
  assert.equal(tightAttach.messages.length, 12);
  assert.equal(tightAttach.truncated?.total, 12_000);
  assert(tightAttach.hasEarlier);

  // The retained tail is the LONGEST SUFFIX that fits, so a budget with room
  // for exactly one message keeps exactly the newest one.
  const oneRowBytes = Buffer.byteLength(
    JSON.stringify(
      JSON.parse(
        JSON.stringify(tightAttach.messages[tightAttach.messages.length - 1]),
      ),
    ),
    'utf8',
  ) + 1;
  const singleTail = await captureTail(big, 500, oneRowBytes);
  assert(!singleTail.refused);
  assert.equal(
    singleTail.sink.retainedMessages,
    1,
    'a budget sized for one message must keep one message',
  );
  assert(singleTail.sink.retainedBytes <= oneRowBytes);
  const singleAttach = singleTail.replay!.attach(undefined, PAGE_MESSAGES);
  assertNeverAuthoritativeEmpty(singleAttach, 'single-row tail attach', singleTail.replay!.durableCount);
  assert.equal(singleAttach.messages.length, 1);
  assert(singleAttach.hasEarlier);

  // A message larger than the WHOLE payload budget cannot be sent inside it.
  // Keeping it anyway is what made `retainedBytes` a fiction — and the client
  // applies the same window budget and would discard it on arrival regardless.
  // The honest answer is an empty tail that still refuses to claim a start.
  const starvedTail = await captureTail(big, 500, 1);
  assert(!starvedTail.refused);
  assert.equal(starvedTail.sink.retainedMessages, 0);
  assert.equal(
    starvedTail.sink.retainedBytes,
    0,
    'the shared payload budget must hold even when nothing fits',
  );
  const starvedAttach = starvedTail.replay!.attach(undefined, PAGE_MESSAGES);
  // Deliberately WITHOUT a durable count: this is the degenerate floor, a
  // one-BYTE payload budget in which no representation of any message exists —
  // not even the clipped stand-in the oversized-entry case below retains. Every
  // other refusal path passes its durable count and must carry messages.
  assertNeverAuthoritativeEmpty(starvedAttach, 'starved tail attach');
  assert.equal(starvedAttach.messages.length, 0);
  assert(starvedAttach.hasEarlier);
  assert.equal(starvedAttach.truncated?.total, 12_000);

  // A genuinely empty history is the ONE case where start-of-session is true.
  const emptyPath = writeRollout('empty.jsonl', [
    JSON.stringify({
      timestamp: '2026-07-28T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: '00000000-0000-4000-8000-00000000000e', cwd: '/tmp' },
    }),
  ]);
  const emptyTail = await captureTail(emptyPath);
  assert(!emptyTail.refused);
  const emptyAttach = emptyTail.replay!.attach(undefined, PAGE_MESSAGES);
  assert.equal(emptyAttach.messages.length, 0);
  assert(emptyAttach.reset && !emptyAttach.hasEarlier);
  assert.equal(emptyAttach.truncated, undefined);

  // --------------------------- projection enrichment never displaces the tail
  // Ten older state projections in front of a byte-evicted three-message tail
  // used to consume every slot in a five-message frame, so the two newest
  // messages were dropped from the replay entirely. The tail claims its slots
  // first; enrichment spends only what is left.
  {
    const sink = new BoundedTailHistorySnapshotSink(3, 1024 * 1024);
    for (let index = 0; index < 10; index += 1) {
      sink.accept({
        type: 'metadata-update',
        key: `p${index}`,
        value: { note: index },
      } as unknown as AgentMessage);
    }
    for (const id of ['u1', 'u2']) {
      sink.accept({
        type: 'user-message',
        id,
        text: id,
      } as unknown as AgentMessage);
    }
    assert.equal(sink.retainedMessages, 3);
    const attach = sink
      .finish({ sourceId: 'displace', revision: '1' })
      .attach(undefined, 5);
    const identities = attach.messages.map(
      (message) => (message as { key?: string; id?: string }).key
        ?? (message as { id?: string }).id,
    );
    assert.deepEqual(
      identities.slice(-2),
      ['u1', 'u2'],
      `projection replay displaced the newest messages: ${identities.join(',')}`,
    );
    assert(attach.messages.length <= 5, 'one frame must stay inside its bound');
    assertNeverAuthoritativeEmpty(attach, 'projection displacement', sink.durableCount);
  }

  // ------------------------------- one shared payload budget, actually enforced
  // Tail, retained projections, and derived activity overlays all reach the
  // client, so all three spend one budget. Counting only the tail reported 758
  // bytes for a 3,793-byte replay, which bounds one contributor, not the frame.
  {
    const maxBytes = 4 * 1024;
    const sink = new BoundedTailHistorySnapshotSink(500, maxBytes);
    for (let index = 0; index < 40; index += 1) {
      sink.accept({
        type: 'metadata-update',
        key: `state-${index}`,
        value: { note: 'x'.repeat(64) },
      } as unknown as AgentMessage);
      sink.accept({
        type: 'agent-activity',
        key: `activity-${index}`,
        value: { elapsed: index, note: 'y'.repeat(64) },
      } as unknown as AgentMessage);
      sink.accept({
        type: 'user-message',
        id: `m${index}`,
        text: 'z'.repeat(128),
      } as unknown as AgentMessage);
    }
    assert(
      sink.retainedBytes <= maxBytes,
      `shared payload budget exceeded: ${sink.retainedBytes} > ${maxBytes}`,
    );
    const attach = sink
      .finish({ sourceId: 'budget', revision: '1' })
      .attach(undefined, HISTORY_PAGE_CACHE_MAX_PAGE_MESSAGES);
    const framed = Buffer.byteLength(
      JSON.stringify(attach.messages), 'utf8',
    ) + Buffer.byteLength(JSON.stringify(attach.derivedMessages), 'utf8');
    assert(
      framed <= maxBytes,
      `replay payload ${framed} exceeded the ${maxBytes} budget it reports`,
    );
    assert(attach.messages.length > 0, 'a real budget must still carry messages');
    assertNeverAuthoritativeEmpty(attach, 'shared budget', sink.durableCount);
  }

  // ------------------- one oversized NEWEST message must not empty the window
  // The eviction loop spent the whole fitting window paying for a single
  // over-budget newest row and then dropped that row too, so a 4-32 MiB Codex
  // record produced a notice above an empty transcript (round 3, finding 3).
  //
  // Round 4 made the answer VARIANT-AWARE. A shape-safe body is shortened in
  // place; anything else is omitted rather than sent malformed. Both branches
  // are proved here, and neither may destroy the window around the message.
  {
    // (a) A safe variant: substituted, every original field preserved, no field
    //     invented, and the shortening declared structurally rather than in
    //     English prose inside the body.
    const maxBytes = 2_000;
    const sink = new BoundedTailHistorySnapshotSink(500, maxBytes);
    for (let index = 0; index < 10; index += 1) {
      sink.accept({
        type: 'user-message',
        key: `fitting-${index}`,
        text: `row ${index}`,
      } as unknown as AgentMessage);
    }
    const original = {
      type: 'model-output',
      key: 'oversized-newest',
      text: 'y'.repeat(8_000),
      delta: 'tail delta',
      final: true,
    } as unknown as AgentMessage;
    sink.accept(original);

    assert.equal(
      sink.retainedMessages,
      11,
      `one oversized newest message destroyed the fitting window: ${sink.retainedMessages} rows retained`,
    );
    assert.equal(sink.clippedMessages, 1, 'exactly the oversized row is a stand-in');
    assert.equal(sink.omittedMessages, 0, 'a safe variant must be substituted, not omitted');
    assert(
      sink.retainedBytes <= maxBytes,
      `the stand-in must stay inside the payload budget: ${sink.retainedBytes} > ${maxBytes}`,
    );

    const replay = sink.finish({ sourceId: 'oversized-newest', revision: '1' });
    const attach = replay.attach(undefined, PAGE_MESSAGES);
    assertNeverAuthoritativeEmpty(attach, 'oversized newest attach', replay.durableCount);
    assert.equal(attach.messages.length, 11);
    const keys = attach.messages.map(
      (message) => (message as { key?: string }).key,
    );
    assert.equal(
      keys[keys.length - 1],
      'oversized-newest',
      'the replay must still END at the newest position',
    );
    assert.equal(keys[0], 'fitting-0', 'every fitting row must survive');

    // The stand-in is the SAME MESSAGE with less text. Key sets must differ by
    // exactly the declared flag: deleting a field the variant requires is what
    // made an oversized task-list-state undecodable on the client.
    const standIn = attach.messages[attach.messages.length - 1] as
      Record<string, unknown>;
    const originalKeys = Object.keys(original as unknown as Record<string, unknown>).sort();
    assert.deepEqual(
      Object.keys(standIn).sort(),
      [...originalKeys, 'bodyTruncated'].sort(),
      `a stand-in must drop no field and invent none: ${Object.keys(standIn).join(',')}`,
    );
    assert.equal(standIn.final, true, 'non-clippable fields must be verbatim');
    assert.equal(standIn.key, 'oversized-newest');
    assert.equal(standIn.bodyTruncated, true, 'the shortening must be declared');
    assert(
      typeof standIn.text === 'string'
        && standIn.text.length < 8_000
        && standIn.text.length > 0,
      'the dominant string field is what gets shortened',
    );
    assert(
      Buffer.byteLength(JSON.stringify(attach.messages), 'utf8') <= maxBytes,
      'the frame the client receives must honour the budget it was built under',
    );
    // The overlap claim is what was SENT, not what the agent produced.
    assert.equal(
      attach.deliveredText.get('model-output:oversized-newest'),
      (standIn.text as string).length,
      'reset overlap claims must not include text the client was not sent',
    );
    // The cursor chain is folded from the REAL messages, so an incremental
    // reconnect still resolves across a clipped row.
    const incremental = replay.attach(attach.cursor, PAGE_MESSAGES);
    assert.equal(incremental.reset, false, 'a clip must not break the cursor chain');
    assert.equal(incremental.messages.length, 0);

    // (b) An UNSAFE variant: no substitute at all. `items` is required by the
    //     Dart decoder (agent_message.dart), and a stand-in missing it decodes
    //     to nothing while still holding a cursor position. The window around
    //     it must survive and the accounting must admit the hole.
    const unsafe = new BoundedTailHistorySnapshotSink(500, maxBytes);
    for (let index = 0; index < 6; index += 1) {
      unsafe.accept({
        type: 'user-message',
        key: `kept-${index}`,
        text: `row ${index}`,
      } as unknown as AgentMessage);
    }
    unsafe.accept({
      type: 'task-list-state',
      key: 'tasks',
      title: 'Plan',
      status: 'running',
      source: 'tool-call',
      sourceTool: 'update_plan',
      items: Array.from({ length: 200 }, (_unused, index) => ({
        id: `${index}`,
        title: `step ${index} ${'x'.repeat(80)}`,
        status: 'pending',
      })),
    } as unknown as AgentMessage);

    assert.equal(
      unsafe.retainedMessages,
      6,
      'the fitting window must survive an un-substitutable newest message',
    );
    assert.equal(unsafe.clippedMessages, 0, 'an unsafe variant must never be substituted');
    assert.equal(unsafe.omittedMessages, 1, 'the oversized row must be accounted for');

    const unsafeReplay = unsafe.finish({ sourceId: 'unsafe-newest', revision: '1' });
    const unsafeAttach = unsafeReplay.attach(undefined, PAGE_MESSAGES);
    assertNeverAuthoritativeEmpty(
      unsafeAttach,
      'omitted newest attach',
      unsafeReplay.durableCount,
    );
    assert.equal(unsafeAttach.messages.length, 6);
    // No malformed row can ship because NO row ships: the frame contains only
    // messages that were never touched.
    assert(
      unsafeAttach.messages.every(
        (message) => message.type === 'user-message'
          && typeof (message as { text?: unknown }).text === 'string',
      ),
      'an omitted variant must leave no partial row behind',
    );
    assert.equal(unsafeReplay.omittedMessages, 1);
    assert.equal(unsafeReplay.durableCount, 7, 'the cursor chain still counts it');
    assert.deepEqual(
      unsafeAttach.truncated,
      { shown: 6, total: 7 },
      'the frame must admit that it carries fewer messages than the history holds',
    );
    assert(unsafeAttach.hasEarlier, 'a frame short of its history must say so');

    // (c) No replay payload may carry broker-authored English. The round-3
    //     stand-in injected a marker sentence into message bodies, which is the
    //     same localization defect S2 removed from the gap notice.
    for (const [label, frame] of [
      ['safe substitute', attach],
      ['omitted variant', unsafeAttach],
    ] as const) {
      const payload = JSON.stringify([frame.messages, frame.derivedMessages]);
      for (const marker of ['truncated by cosyncing', 'bounded history replay budget']) {
        assert(
          !payload.includes(marker),
          `${label}: broker prose leaked into message content ("${marker}")`,
        );
      }
    }

    // (d) A field is clippable only if the client VISIBLY renders it. `delta`
    //     was on the allow-list in round 4, but the thinking renderer resolves
    //     its body from ['content','thought','text','status'] and never reads
    //     `delta`, so a delta-only clipped thinking row showed an empty body
    //     AND no truncation note — a clip with no indicator anywhere (round 5,
    //     blocker 3). Such a message must be OMITTED, not silently shortened.
    for (const type of ['thinking', 'model-output'] as const) {
      const deltaOnly = new BoundedTailHistorySnapshotSink(500, 2_000);
      deltaOnly.accept({
        type: 'user-message',
        key: 'anchor',
        text: 'fits',
      } as unknown as AgentMessage);
      deltaOnly.accept({
        type,
        key: `${type}-delta-only`,
        delta: 'd'.repeat(8_000),
      } as unknown as AgentMessage);
      assert.equal(
        deltaOnly.clippedMessages,
        0,
        `${type}: a body carried only in \`delta\` must not be silently shortened`,
      );
      assert.equal(
        deltaOnly.omittedMessages,
        1,
        `${type}: an unrenderable oversized body must be omitted`,
      );
      const deltaAttach = deltaOnly
        .finish({ sourceId: `delta-only-${type}`, revision: '1' })
        .attach(undefined, PAGE_MESSAGES);
      assert(
        !JSON.stringify(deltaAttach.messages).includes('dddd'),
        `${type}: no fragment of an unrenderable body may ship`,
      );
      assert.equal(
        deltaAttach.messages.length,
        1,
        `${type}: the window around it must survive`,
      );
    }

    // A budget with room for nothing at all is still the honest empty tail: a
    // stand-in has to fit too, and clipping is never allowed to break the bound.
    const impossible = new BoundedTailHistorySnapshotSink(500, 8);
    impossible.accept({
      type: 'model-output',
      key: 'impossible',
      text: 'z'.repeat(4_096),
    } as unknown as AgentMessage);
    assert.equal(impossible.retainedMessages, 0);
    assert.equal(impossible.retainedBytes, 0);
  }

  // --------- an omitted state update must SUPERSEDE older same-key state (B1)
  // Projection and tail bookkeeping for state variants ran only when a payload
  // survived, so an oversized same-key update left the OLDER value registered
  // and replayable: a 400-item plan that outgrew the budget replayed as the
  // one-item plan it replaced, presented as current. Silence about the newest
  // value is honest; asserting a superseded one is not. Fails against the
  // pre-fix bookkeeping with the old payload present in the frame.
  {
    const stateCases = [
      {
        label: 'task-list-state',
        older: {
          type: 'task-list-state',
          key: 'tasks',
          status: 'running',
          items: [{ id: '1', title: 'OLD plan state', status: 'in-progress' }],
        },
        newer: {
          type: 'task-list-state',
          key: 'tasks',
          status: 'running',
          items: Array.from({ length: 400 }, (_unused, index) => ({
            id: `${index}`,
            title: `NEW step ${index} ${'x'.repeat(60)}`,
            status: 'pending',
          })),
        },
      },
      {
        label: 'goal-state',
        older: {
          type: 'goal-state',
          key: 'goal',
          title: 'OLD goal state',
          status: 'active',
        },
        newer: {
          type: 'goal-state',
          key: 'goal',
          title: `NEW goal ${'y'.repeat(8_000)}`,
          status: 'active',
        },
      },
      {
        label: 'metadata-update',
        older: {
          type: 'metadata-update',
          key: 'meta',
          value: { note: 'OLD metadata state' },
        },
        newer: {
          type: 'metadata-update',
          key: 'meta',
          value: { note: `NEW metadata ${'z'.repeat(8_000)}` },
        },
      },
    ] as const;

    for (const { label, older, newer } of stateCases) {
      const sink = new BoundedTailHistorySnapshotSink(500, 4_000);
      sink.accept(older as unknown as AgentMessage);
      sink.accept({
        type: 'user-message',
        key: 'mid',
        text: 'in between',
      } as unknown as AgentMessage);
      sink.accept(newer as unknown as AgentMessage);

      assert.equal(
        sink.omittedMessages,
        1,
        `${label}: the oversized update must be omitted`,
      );
      assert.equal(
        sink.withheldMessages,
        1,
        `${label}: the superseded older row must be withheld, not replayed`,
      );

      const replay = sink.finish({ sourceId: `supersede-${label}`, revision: '1' });
      const attach = replay.attach(undefined, PAGE_MESSAGES);
      const payload = JSON.stringify([attach.messages, attach.derivedMessages]);
      assert(
        !payload.includes('OLD'),
        `${label}: superseded state was replayed as current: ${payload.slice(0, 200)}`,
      );
      assert(
        !payload.includes('NEW'),
        `${label}: an omitted update must not partially ship`,
      );
      // The window around it is untouched, and the frame stays truthful.
      assert.equal(
        attach.messages.length,
        1,
        `${label}: the unrelated message must survive`,
      );
      assert.equal(
        (attach.messages[0] as { key?: string }).key,
        'mid',
        `${label}: the surviving row must be the unrelated one`,
      );
      assertNeverAuthoritativeEmpty(attach, `${label} supersede`, replay.durableCount);
      assert.deepEqual(
        attach.truncated,
        { shown: 1, total: 3 },
        `${label}: the frame must admit it carries fewer rows than the history holds`,
      );
      assert(attach.hasEarlier, `${label}: a short frame must say so`);
      assert.equal(
        replay.withheldMessages,
        1,
        `${label}: the replay must carry the withheld count outward`,
      );
      // Withheld rows keep their boundary, so the cursor chain is intact.
      assert.equal(replay.durableCount, 3, `${label}: every message is still counted`);
      // Round 6, P1-1: this client was GIVEN the old state row by an earlier
      // capture, and an incremental frame never retracts anything. Suppressing
      // the row in this capture's payload is not enough — the reconnect must
      // escalate to a replacement window, or the stale row stays on screen.
      const incremental = replay.attach(attach.cursor, PAGE_MESSAGES);
      assert.equal(
        incremental.reset,
        true,
        `${label}: a withheld row the client may hold must force a replacement frame`,
      );
      assert.equal(
        incremental.gap,
        undefined,
        `${label}: the cursor itself resolved; escalation is not a cursor failure`,
      );
      assert(
        !JSON.stringify(incremental.messages).includes('OLD'),
        `${label}: the replacement frame must not carry the superseded row`,
      );
    }

    // The ENRICHMENT path specifically: when the older same-key row has already
    // been evicted from the window, the registered projection is the only thing
    // that could resurrect it. It must be unregistered too.
    {
      const sink = new BoundedTailHistorySnapshotSink(2, 4_000);
      sink.accept({
        type: 'task-list-state',
        key: 'tasks',
        status: 'running',
        items: [{ id: '1', title: 'OLD plan state', status: 'in-progress' }],
      } as unknown as AgentMessage);
      for (const id of ['a', 'b']) {
        sink.accept({
          type: 'user-message',
          key: id,
          text: `row ${id}`,
        } as unknown as AgentMessage);
      }
      // The old state row is out of the 2-message window but still projected.
      const beforeAttach = sink
        .finish({ sourceId: 'supersede-projection', revision: '1' })
        .attach(undefined, PAGE_MESSAGES);
      assert(
        JSON.stringify(beforeAttach.messages).includes('OLD plan state'),
        'the fixture must actually exercise projection enrichment',
      );

      sink.accept({
        type: 'task-list-state',
        key: 'tasks',
        status: 'running',
        items: Array.from({ length: 400 }, (_unused, index) => ({
          id: `${index}`,
          title: `NEW step ${index} ${'x'.repeat(60)}`,
          status: 'pending',
        })),
      } as unknown as AgentMessage);
      const afterReplay = sink
        .finish({ sourceId: 'supersede-projection', revision: '2' });
      const afterAttach = afterReplay.attach(undefined, PAGE_MESSAGES);
      assert(
        !JSON.stringify(afterAttach.messages).includes('OLD plan state'),
        'an omitted state update must unregister the older same-key projection',
      );
      assert.equal(
        afterReplay.supersededMessages,
        0,
        'the fixture requires the superseded row to exist only as projection enrichment',
      );
      const projectionDelta = afterReplay.attach(beforeAttach.cursor, PAGE_MESSAGES);
      assert.equal(
        projectionDelta.reset,
        true,
        'projection-only state removal must latch a replacement frame',
      );
      assert(
        !JSON.stringify(projectionDelta.messages).includes('OLD plan state'),
        'the projection replacement must retract the stale state',
      );
    }

    // The derived/activity map is structurally immune to the same bug: its
    // replacement is unconditional and keyed, so a newer value always displaces
    // the older one and no size decision can leave a stale entry behind. Pinned
    // so a future oversize branch there cannot reintroduce the shape.
    {
      const sink = new BoundedTailHistorySnapshotSink(500, 64 * 1024);
      sink.accept({
        type: 'agent-activity',
        key: 'act',
        value: { note: 'OLD activity' },
      } as unknown as AgentMessage);
      sink.accept({
        type: 'agent-activity',
        key: 'act',
        value: { note: `NEW activity ${'q'.repeat(4_000)}` },
      } as unknown as AgentMessage);
      const derived = JSON.stringify(
        sink.finish({ sourceId: 'derived-supersede', revision: '1' })
          .attach(undefined, PAGE_MESSAGES).derivedMessages,
      );
      assert(
        !derived.includes('OLD activity'),
        'a newer activity must displace the older same-key one',
      );
      assert(derived.includes('NEW activity'), 'the newest activity must be present');
    }
  }

  // ---- an incremental frame must retract state the client may hold (R6 P1-1)
  // supersedeState removes the stale row from THIS capture's payload, but the
  // client received it from an EARLIER capture and an incremental frame never
  // retracts. Fails against the pre-fix attach with reset:false and the stale
  // plan still on screen.
  {
    const buildCapture = (withNewPlan: boolean) => {
      const sink = new BoundedTailHistorySnapshotSink(500, 4_000);
      sink.accept({
        type: 'task-list-state',
        key: 'tasks',
        status: 'running',
        items: [{ id: '1', title: 'OLD plan the client displays', status: 'in-progress' }],
      } as unknown as AgentMessage);
      sink.accept({ type: 'user-message', key: 'u1', text: 'first' } as unknown as AgentMessage);
      if (withNewPlan) {
        sink.accept({
          type: 'task-list-state',
          key: 'tasks',
          status: 'running',
          items: Array.from({ length: 400 }, (_unused, index) => ({
            id: `${index}`,
            title: `NEW step ${index} ${'x'.repeat(60)}`,
            status: 'pending',
          })),
        } as unknown as AgentMessage);
        sink.accept({ type: 'user-message', key: 'u2', text: 'second' } as unknown as AgentMessage);
      }
      return sink;
    };

    // The client attached to the earlier capture and holds the old plan.
    const firstAttach = buildCapture(false)
      .finish({ sourceId: 'r6-p1-1', revision: '2' })
      .attach(undefined, PAGE_MESSAGES);
    assert(
      JSON.stringify(firstAttach.messages).includes('OLD plan'),
      'the fixture must actually hand the client the old plan first',
    );

    // It reconnects with that cursor against the grown capture.
    const grown = buildCapture(true).finish({ sourceId: 'r6-p1-1', revision: '4' });
    const reconnect = grown.attach(firstAttach.cursor, PAGE_MESSAGES);
    assert.equal(
      reconnect.reset,
      true,
      'a reconnect that would leave stale state on screen must send a replacement window',
    );
    assert(
      !JSON.stringify(reconnect.messages).includes('OLD plan'),
      'the replacement window must not carry the superseded state row',
    );
    assert(
      !JSON.stringify(reconnect.messages).includes('NEW step'),
      'an omitted update must not partially ship on the reconnect either',
    );
    assertNeverAuthoritativeEmpty(reconnect, 'r6 state retraction', grown.durableCount);
    assert.deepEqual(
      reconnect.truncated,
      { shown: reconnect.messages.length, total: grown.durableCount },
      'the replacement frame must account for what it carries',
    );

    // A withheld row BEYOND the history cursor still needs escalation. Live
    // delivery can append the old plan without advancing that stored cursor,
    // so cursor position cannot prove the client never saw the stale value.
    const earlySink = new BoundedTailHistorySnapshotSink(500, 4_000);
    earlySink.accept({ type: 'user-message', key: 'e1', text: 'one' } as unknown as AgentMessage);
    earlySink.accept({ type: 'user-message', key: 'e2', text: 'two' } as unknown as AgentMessage);
    const earlyAttach = earlySink
      .finish({ sourceId: 'r6-p1-1b', revision: '2' })
      .attach(undefined, PAGE_MESSAGES);

    const laterSink = new BoundedTailHistorySnapshotSink(500, 4_000);
    laterSink.accept({ type: 'user-message', key: 'e1', text: 'one' } as unknown as AgentMessage);
    laterSink.accept({ type: 'user-message', key: 'e2', text: 'two' } as unknown as AgentMessage);
    laterSink.accept({
      type: 'task-list-state',
      key: 'late',
      status: 'running',
      items: [{ id: '1', title: 'plan the client may have seen live', status: 'in-progress' }],
    } as unknown as AgentMessage);
    laterSink.accept({
      type: 'task-list-state',
      key: 'late',
      status: 'running',
      items: Array.from({ length: 400 }, (_unused, index) => ({
        id: `${index}`,
        title: `NEW step ${index} ${'x'.repeat(60)}`,
        status: 'pending',
      })),
    } as unknown as AgentMessage);
    const later = laterSink.finish({ sourceId: 'r6-p1-1b', revision: '4' });
    assert.equal(later.withheldMessages, 1, 'the later capture must withhold a row');
    const escalated = later.attach(earlyAttach.cursor, PAGE_MESSAGES);
    assert.equal(
      escalated.reset,
      true,
      'an unsendable state update beyond the cursor must force replacement',
    );

    // A merely CLIPPED row must NOT force a replacement: the client's earlier
    // full copy is strictly better than the stand-in and is not stale.
    const clipSink = new BoundedTailHistorySnapshotSink(500, 4_000);
    clipSink.accept({ type: 'user-message', key: 'c1', text: 'anchor' } as unknown as AgentMessage);
    clipSink.accept({
      type: 'model-output',
      key: 'big',
      text: 'y'.repeat(16_000),
      final: true,
    } as unknown as AgentMessage);
    const clipReplay = clipSink.finish({ sourceId: 'r6-clip', revision: '2' });
    assert.equal(clipReplay.clippedMessages, 1, 'the fixture must actually clip');
    assert.equal(clipReplay.withheldMessages, 0, 'a clip is not a withholding');
    const clipAttach = clipReplay.attach(undefined, PAGE_MESSAGES);
    assert.equal(
      clipReplay.attach(clipAttach.cursor, PAGE_MESSAGES).reset,
      false,
      'a clipped row must not make every reconnect a full replacement',
    );
  }

  // ---- skipped native records suppress state authority (R6 P1-2) ----------
  // A record over the per-record ceiling never reaches the sink, so a newer
  // update_plan inside it cannot supersede anything and the older plan would
  // replay as CURRENT. Runs the real production path. Fails against the pre-fix
  // capture with the old plan present and zero suppression.
  {
    const planRow = (title: string, pad = 0) => JSON.stringify({
      timestamp: '2026-07-31T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'update_plan',
        call_id: `plan-${title.slice(0, 8)}`,
        arguments: JSON.stringify({
          explanation: title,
          plan: [{ status: 'in_progress', step: `${title} ${'x'.repeat(pad)}` }],
        }),
      },
    });
    const skipPath = writeRollout('state-skip.jsonl', [
      JSON.stringify({
        timestamp: '2026-07-31T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: '00000000-0000-4000-8000-0000000000r6', cwd: '/tmp' },
      }),
      userRow(1, 64),
      planRow('OLD PLAN MUST NOT RESURRECT'),
      // Last on purpose: the prior plan remains pending until the scan ends.
      // Suppressing before that flush used to accept OLD after suppression.
      planRow('NEW PLAN', 33 * 1024 * 1024),
    ]);
    const skipped = await captureTail(skipPath);
    assert(!skipped.refused, 'an oversized record must not refuse the bounded tail');
    const skipReplay = skipped.replay!;
    assert(
      skipReplay.stateAuthorityUnverified,
      'a skipped record must mark state authority unverifiable',
    );
    assert(
      skipReplay.unverifiedStateMessages > 0,
      'the suppressed state rows must be counted with their own reason',
    );
    assert.equal(
      skipReplay.supersededMessages,
      0,
      'nothing newer was SEEN, so this is not supersession',
    );
    const skipAttach = skipReplay.attach(undefined, PAGE_MESSAGES);
    assert(
      !JSON.stringify([skipAttach.messages, skipAttach.derivedMessages])
        .includes('OLD PLAN MUST NOT RESURRECT'),
      'an unverifiable plan must not replay as current',
    );
    assertNeverAuthoritativeEmpty(
      skipAttach,
      'r6 skipped-record state suppression',
      skipReplay.durableCount,
    );
    // Transcript rows are NOT suppressed: they are positional, and the skip
    // count already reports their absence honestly.
    assert(
      skipAttach.messages.some((message) => message.type === 'user-message'),
      'suppressing state must not suppress the transcript',
    );
    // COMPOSITION with P1-1: a client may hold a state row from a capture
    // entirely behind this window, where the positional test cannot see it, so
    // ANY incremental attach fails closed while state is unverifiable.
    const skipReconnect = skipReplay.attach(skipAttach.cursor, PAGE_MESSAGES);
    assert.equal(
      skipReconnect.reset,
      true,
      'unverifiable state must make every reconnect a replacement window',
    );
  }

  // -------------- the enrichment store's ceilings are actually reached (F2)
  // `evictUntilWithin` returned the moment the OLDEST key happened to be the
  // protected one, leaving every newer entry retained and both ceilings broken.
  // This is the only thing bounding enrichment on the bounded-tail capture path,
  // so a bound it never reaches is that path's whole memory guarantee. Fails
  // against the pre-fix early return with size 2 and 8,264 bytes.
  {
    const store = new CodexEnrichStore();
    const beginRow = (id: string) => ({
      type: 'event_msg',
      payload: {
        type: 'exec_command_begin',
        call_id: id,
        command: ['bash', '-lc', 'x'.repeat(5_000)],
        cwd: '/tmp',
      },
    });
    store.accumulate(beginRow('a'));
    store.accumulate(beginRow('b'));
    store.accumulate(beginRow('c'));
    // "a" is the oldest key AND the one just enriched — exactly the shape that
    // used to stop eviction dead.
    store.accumulate({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'a',
        output: '{"duration_seconds":1}',
      },
    });
    assert.equal(store.size, 3);
    store.evictUntilWithin(1, 100, 'a');
    assert(
      store.size <= 1,
      `protecting the oldest key must not retain newer ones: size=${store.size} keys=${[...store.entries.keys()].join(',')}`,
    );
    assert(
      store.retainedBytes <= 100,
      `the byte ceiling must actually hold: ${store.retainedBytes} > 100`,
    );
    assert(
      store.entries.has('a'),
      'the protected entry is the one exception to the entry ceiling',
    );
    // Bounded by CLIPPING, not by fiction: the surviving entry is really smaller.
    const survivor = store.entries.get('a')!;
    assert(
      (survivor.command?.length ?? 0) < 5_000,
      'the protected entry must be shortened, not merely re-measured',
    );
    assert.equal(
      store.retainedBytes,
      enrichEntryBytes(survivor),
      'retained bytes must equal what enrichEntryBytes measures',
    );

    // Insertion order (which IS the eviction order) survives clipping.
    const ordered = new CodexEnrichStore();
    for (const id of ['first', 'second', 'third']) ordered.accumulate(beginRow(id));
    ordered.evictUntilWithin(2, 32 * 1024, 'third');
    assert.deepEqual(
      [...ordered.entries.keys()],
      ['second', 'third'],
      'eviction must stay oldest-first across a protected key',
    );

    // Nothing to protect and nothing that fits: the store empties rather than
    // reporting a ceiling it does not honour.
    const unprotected = new CodexEnrichStore();
    unprotected.accumulate(beginRow('only'));
    unprotected.evictUntilWithin(4_096, 16);
    assert.equal(unprotected.size, 0);
    assert.equal(unprotected.retainedBytes, 0);

    // The degenerate floor, reconciled with the pre-existing rule that the call
    // being enriched survives ANY ceiling (test-tool-semantics). It survives,
    // but only in its irreducible form: every retained string gone, leaving
    // enrichEntryBytes' constant fixed-field allowance and nothing that grows.
    const impossible = new CodexEnrichStore();
    impossible.accumulate(beginRow('kept'));
    impossible.evictUntilWithin(1, 1, 'kept');
    const kept = impossible.entries.get('kept');
    assert(kept, 'the call being enriched must survive even an impossible ceiling');
    assert.equal(kept.command, undefined, 'every retained string must be given up first');
    assert.equal(kept.cwd, undefined);
    assert.equal(
      impossible.retainedBytes,
      enrichEntryBytes(kept),
      'the reported bytes must stay exactly what the entry costs',
    );
    assert(
      impossible.retainedBytes <= enrichEntryBytes({}),
      `an irreducible entry may not exceed the empty-entry allowance: ${impossible.retainedBytes}`,
    );
  }

  // --------------------------------- append / rewrite / compaction / restart
  const appendPath = writeRollout(
    'append.jsonl',
    Array.from({ length: 900 }, (_unused, index) => userRow(index, 128)),
  );
  const beforeAppend = (await captureTail(appendPath)).replay!;
  const beforeAttach = beforeAppend.attach(undefined, PAGE_MESSAGES);
  appendFileSync(appendPath, `${userRow(900, 128)}\n`);
  const afterAppend = (await captureTail(appendPath)).replay!;
  assert(
    historySourceStillContainsSnapshot(
      beforeAppend.sourceIdentity,
      afterAppend.sourceIdentity,
    ),
    'an append must preserve the captured prefix identity',
  );
  const acrossAppend = afterAppend.attach(beforeAttach.cursor, PAGE_MESSAGES);
  assert.equal(
    acrossAppend.reset,
    false,
    'a cursor issued before an append must still resolve incrementally',
  );
  assert.equal(acrossAppend.messages.length, 1);
  assertNeverAuthoritativeEmpty(acrossAppend, 'append reconnect', afterAppend.durableCount);

  const rewriteFd = openSync(appendPath, 'r+');
  try {
    writeSync(rewriteFd, Buffer.from('Y'), 0, 1, 40);
  } finally {
    closeSync(rewriteFd);
  }
  const afterRewrite = (await captureTail(appendPath)).replay!;
  assert(
    !historySourceStillContainsSnapshot(
      beforeAppend.sourceIdentity,
      afterRewrite.sourceIdentity,
    ),
    'a same-size rewrite must invalidate the captured prefix identity',
  );
  const acrossRewrite = afterRewrite.attach(beforeAttach.cursor, PAGE_MESSAGES);
  assertNeverAuthoritativeEmpty(acrossRewrite, 'rewrite reconnect', afterRewrite.durableCount);
  assert(acrossRewrite.messages.length > 0);

  const compactFd = openSync(appendPath, 'r+');
  try {
    ftruncateSync(compactFd, Math.trunc(statSync(appendPath).size / 3));
  } finally {
    closeSync(compactFd);
  }
  const afterCompaction = (await captureTail(appendPath)).replay!;
  assert(
    !historySourceStillContainsSnapshot(
      beforeAppend.sourceIdentity,
      afterCompaction.sourceIdentity,
    ),
    'compaction must invalidate the captured prefix identity',
  );
  const acrossCompaction = afterCompaction.attach(
    beforeAttach.cursor,
    PAGE_MESSAGES,
  );
  assertNeverAuthoritativeEmpty(acrossCompaction, 'compaction reconnect', afterCompaction.durableCount);
  assert(acrossCompaction.reset && acrossCompaction.messages.length > 0);

  // A restarted broker has no in-memory index, and its first read is the same
  // truthful bounded answer rather than an empty session.
  const restartedPool = new HistoryPageCachePool();
  assert.equal(
    restartedPool.get('h1c', afterCompaction.sourceIdentity),
    undefined,
    'restart must not resurrect an in-memory index',
  );
  const afterRestart = (await captureTail(appendPath)).replay!.attach(
    undefined,
    PAGE_MESSAGES,
  );
  assertNeverAuthoritativeEmpty(afterRestart, 'post-restart attach', afterCompaction.durableCount);
  assert(afterRestart.messages.length > 0);

  // Backward cursor divergence on the aligned index is unchanged.
  const divergent = await insideCapture.cache!.loadPage(
    backwardHistoryCursorFromHash(10, 'forged'),
    PAGE_MESSAGES,
  );
  assert(
    !('kind' in divergent) && divergent.gap?.code === 'HISTORY_CURSOR_DIVERGED',
  );

  console.log(JSON.stringify({
    insideContractMessages: insideCapture.accepted,
    insideReaderRetainedBytes: insideCapture.readerRetainedBytes,
    insideIndexBytes: insideCapture.cache?.encodedBytes,
    retiredReaderCeiling: RETIRED_READER_MAX_BYTES,
    retiredIndexCeiling: RETIRED_INDEX_MAX_BYTES,
    alignedEntryCeiling: HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES,
    tailRetainedMessages: bigTail.sink.retainedMessages,
    tailRetainedBytes: bigTail.sink.retainedBytes,
  }));

  if (REAL_FIXTURE) {
    // The selected rollout may belong to the Codex process running this check
    // and can keep growing between the indexed and fallback reads. Compare the
    // two implementations against one immutable observation, not two moments
    // of a live session.
    const realSnapshot = join(temp, 'real-fixture.jsonl');
    copyFileSync(REAL_FIXTURE, realSnapshot);
    const real = await captureIndexed(realSnapshot);
    assert.equal(
      real.outcome,
      'cache',
      'the supplied real rollout is inside the public contract and must index',
    );
    assert(
      (real.readerRetainedBytes ?? 0) > RETIRED_READER_MAX_BYTES,
      'the real fixture no longer reproduces the retired adapter ceiling',
    );
    assert(
      (real.cache?.encodedBytes ?? 0) <= HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES,
    );
    const realAttach = await real.cache!.loadAttach(undefined, PAGE_MESSAGES);
    assert(!('kind' in realAttach), 'real fixture attach must serve');
    assert.equal(realAttach.messages.length, PAGE_MESSAGES);
    assert(realAttach.olderCursor);
    // The same real source through the fallback path is also never empty.
    const realTail = await captureTail(realSnapshot);
    assert(!realTail.refused);
    const realTailAttach = realTail.replay!.attach(undefined, PAGE_MESSAGES);
    assertNeverAuthoritativeEmpty(realTailAttach, 'real fixture fallback', realTail.replay!.durableCount);
    // This host fixture is a live rollout. Its newest rows can grow while this
    // test runs, and the fallback is byte-bounded as well as count-bounded.
    // Require the public contract instead of assuming 100 current rows fit.
    assert(realTailAttach.messages.length > 0);
    assert(realTailAttach.messages.length <= PAGE_MESSAGES);
    assert(realTailAttach.hasEarlier);
    assert.deepEqual(realTailAttach.truncated, {
      shown: realTailAttach.messages.length,
      total: realTail.replay!.durableCount,
    });
    console.log(JSON.stringify({
      fixture: REAL_FIXTURE,
      sourceBytes: statSync(realSnapshot).size,
      messages: real.accepted,
      readerRetainedBytes: real.readerRetainedBytes,
      indexBytes: real.cache?.encodedBytes,
      fallbackDurableCount: realTail.replay!.durableCount,
    }));
  } else {
    console.log(JSON.stringify({
      fixture: null,
      skipped:
        `real-rollout block skipped: set ${REAL_ROLLOUT_FLAG}=1 and `
        + `${REAL_ROLLOUT_PATH}=<absolute rollout .jsonl> to run it`,
    }));
  }

  // ------------------------------------------------- H1d append-only resume
  // Reattaching an over-index source used to re-stream the WHOLE source
  // through the bounded sink — O(source) work per attach, serialized in front
  // of the history frame. For the largest active rollouts that cost outlasted
  // the client's own attach deadline, so the client abandoned the socket and
  // retried the same scan: the live-stream starvation this lane fixes. The
  // capture now freezes a watermark for the exact sink it fed, so the same
  // sink is extended by exactly the appended bytes — and the window must be
  // indistinguishable from a fresh whole-source capture of the same bytes.
  const resumeSource = join(temp, 'resume-oversize.jsonl');
  {
    const resumeFd = openSync(resumeSource, 'w');
    try {
      ftruncateSync(resumeFd, 256 * 1024 * 1024 + 1);
      writeSync(
        resumeFd,
        `\n${Array.from({ length: 40 }, (_unused, index) => userRow(index, 64)).join('\n')}\n`,
        256 * 1024 * 1024 + 1,
      );
    } finally {
      closeSync(resumeFd);
    }
  }
  const scanRanges: Array<{ start: number; end: number }> = [];
  const resumeSink = new BoundedTailHistorySnapshotSink();
  const firstCapture = await captureFileHistoryInto(
    resumeSource,
    resumeSink,
    undefined,
    { onScanRange: (start, end) => scanRanges.push({ start, end }) },
  );
  assert(firstCapture && !('refusal' in firstCapture), 'oversized tail capture must serve');
  const firstSize = statSync(resumeSource).size;
  assert(
    scanRanges.length > 0 && scanRanges.every((range) => range.start === 0),
    'a first capture reads the whole source',
  );
  scanRanges.length = 0;
  appendFileSync(
    resumeSource,
    `${Array.from({ length: 7 }, (_unused, index) => userRow(1_000 + index, 64)).join('\n')}\n`,
  );
  const grownSize = statSync(resumeSource).size;
  const resumedCapture = await captureFileHistoryInto(
    resumeSource,
    resumeSink,
    undefined,
    { onScanRange: (start, end) => scanRanges.push({ start, end }) },
  );
  assert(resumedCapture && !('refusal' in resumedCapture), 'append resume must serve');
  assert(scanRanges.length > 0, 'a resumed capture must report its scan ranges');
  for (const range of scanRanges) {
    assert.equal(
      range.start,
      firstSize,
      'a resumed capture must read only the appended bytes, never the whole source again',
    );
    assert.equal(range.end, grownSize);
  }
  const resumedReplay = resumeSink.finish(resumedCapture.identity);
  const freshTail = await captureTail(resumeSource);
  assert(!freshTail.refused, 'the fresh whole-source control capture must serve');
  const resumedAttach = resumedReplay.attach(undefined, PAGE_MESSAGES);
  const freshAttach = freshTail.replay!.attach(undefined, PAGE_MESSAGES);
  assert.deepEqual(
    resumedAttach.messages,
    freshAttach.messages,
    'a resumed window must be identical to a fresh whole-source capture of the same bytes',
  );
  assert.equal(
    resumedAttach.cursor,
    freshAttach.cursor,
    'a resumed window must issue the same reconnect cursor a fresh capture does',
  );
  assert.equal(resumedReplay.durableCount, freshTail.replay!.durableCount);
  // A same-size in-place rewrite breaks the lineage: the fed sink must never be
  // scanned into from byte zero again (every retained row would double), so the
  // answer is the ordinary retriable `undefined` and the caller's fresh sink.
  {
    const rewriteFd = openSync(resumeSource, 'r+');
    try {
      const stamp = Buffer.from('{"type":"rewritten-in-place"}');
      writeSync(rewriteFd, stamp, 0, stamp.length, 256 * 1024 * 1024 + 2);
    } finally {
      closeSync(rewriteFd);
    }
    const afterRewrite = await captureFileHistoryInto(resumeSource, resumeSink);
    assert.equal(
      afterRewrite,
      undefined,
      'a rewritten source must not resume into an already-fed sink',
    );
    const freshAfterRewrite = await captureTail(resumeSource);
    assert(
      !freshAfterRewrite.refused,
      'the rewritten source must still serve a fresh whole-source capture',
    );
  }

  console.log('PASS H1c bounded large-history refusal never empties a session');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
