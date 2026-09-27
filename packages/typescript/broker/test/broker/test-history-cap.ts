/**
 * Initial-history cap (performance must-fix, 2026-07-03 review):
 * a full-history attach on a huge session must send only the newest N durable messages
 * (bounded frame + bounded client DOM), while the cursor still covers the FULL durable
 * prefix so the next reattach gets an incremental delta, not another full replay.
 */
import { mapOpenCodePart } from '../../../opencode-wire/src/mapping.ts';
import type { AgentMessage } from '../../../adapter-api/src/index.ts';
import {
  backwardHistoryCursor,
  backwardHistoryPage,
  capHistoryDelta,
  capHistoryMessages,
  cursorDurableHistory,
  MAX_VOLATILE_TAIL_ROWS,
  estimatedClientDecodedBytes,
  forwardHistoryPage,
  HISTORY_FRAME_MAX_DECODED_BYTES,
  historyDelta,
  holdRunningTurn,
  historyRefresh,
  historyRefreshRequest,
  isBackwardPageMessage,
} from '../../src/sessions/history-delta.ts';

function fail(message: string): never {
  throw new Error(message);
}

const mkMessages = (n: number): AgentMessage[] =>
  Array.from({ length: n }, (_, i) => ({ type: 'model-output', key: `m${i}`, text: `message ${i}` }) as AgentMessage);

// Large completed outputs behind an unfinished parallel tool belong to the capped frame.
// They must not escape through the unbudgeted post-frame overlay stream.
{
  const tool = (callID: string, pending: boolean) => mapOpenCodePart({
    type: 'tool', id: `part-${callID}`, callID, tool: 'bash',
    state: { status: pending ? 'running' : 'completed', input: { command: 'example' },
      ...(pending ? {} : { output: 'x'.repeat(250_000), metadata: { exit: 0 } }),
      time: { start: 1, ...(pending ? {} : { end: 2 }) } },
  }, { historical: true });
  const history = [...tool('slow', true),
    ...Array.from({ length: 8 }, (_, i) => tool(`fast-${i}`, false)).flat()];
  const { framed, held } = holdRunningTurn(history);
  if (held.length) fail('parallel outputs escaped the frame budget');
  const capped = capHistoryDelta(historyDelta(framed), 100, framed.length,
    HISTORY_FRAME_MAX_DECODED_BYTES, { history: framed });
  const bytes = capped.messages.reduce((sum, row) => sum + estimatedClientDecodedBytes(row), 0);
  if (bytes > HISTORY_FRAME_MAX_DECODED_BYTES) fail('large parallel outputs exceeded frame budget');
  if (!capped.olderCursor || !capped.truncated) fail('large outputs need a reload boundary');
  const restored = [...capped.messages];
  let cursor: string | undefined = capped.olderCursor;
  while (cursor) {
    const page = backwardHistoryPage(history, cursor, 1);
    if (page.gap) fail('dropped output could not reload');
    restored.unshift(...page.messages);
    cursor = page.hasMore ? page.cursor : undefined;
  }
  if (restored.length !== history.length) fail('reload lost or duplicated a reserved tool row');
  const results = restored.filter((row) => row.type === 'tool-result' && !row.pending);
  if (results.length !== 8 || results.some((row) => row.type === 'tool-result' && row.result !== 'x'.repeat(250_000))) {
    fail('reloading clipped a completed tool output');
  }
}

// 1) Cold attach (no cursor) on a long history → tail only, reset, truncated marker, full-length cursor.
{
  const messages = mkMessages(1200);
  const capped = capHistoryDelta(historyDelta(messages), 500, messages.length);
  if (capped.messages.length !== 500) fail(`cold attach: expected 500 messages, got ${capped.messages.length}`);
  if ((capped.messages[0] as any).key !== 'm700') fail('cold attach: expected the NEWEST 500 (tail), not the head');
  if (!capped.reset) fail('cold attach: capped frame must still be a reset frame');
  if (!capped.truncated || capped.truncated.shown !== 500 || capped.truncated.total !== 1200) {
    fail(`cold attach: expected truncated {shown:500,total:1200}, got ${JSON.stringify(capped.truncated)}`);
  }
  // The cursor must cover the FULL durable prefix: a reattach with it is an incremental no-op.
  const next = historyDelta(messages, capped.cursor);
  if (next.reset || next.messages.length !== 0) fail('cursor after cap must cover the full prefix (reattach = empty delta)');
  if (capped.olderBoundary !== 700) fail(`cold attach: tail boundary must be 700, got ${capped.olderBoundary}`);
}

// 1b) Flutter's negotiated initial budget is exactly 100: a fresh attach never
//     transfers the remaining 1,100 messages.
{
  const messages = mkMessages(1200);
  const capped = capHistoryDelta(historyDelta(messages), 100, messages.length);
  if (capped.messages.length !== 100) fail(`phone attach: expected 100 messages, got ${capped.messages.length}`);
  if ((capped.messages[0] as any).key !== 'm1100') fail('phone attach: expected only the newest 100');
  if (capped.truncated?.shown !== 100 || capped.truncated.total !== 1200) {
    fail('phone attach: initial truncation metadata must describe 100 of 1200');
  }
  if (!backwardHistoryCursor(messages, 1100)) fail('phone attach: older cursor missing');
}

// 2) Short history → untouched (same object semantics: no cap, no truncated marker).
{
  const messages = mkMessages(20);
  const delta = historyDelta(messages);
  const capped = capHistoryDelta(delta, 500, messages.length);
  if (capped.messages.length !== 20 || capped.truncated) fail('short history must pass through uncapped');
  if (capped.reset !== delta.reset || capped.cursor !== delta.cursor) fail('short history must be unchanged');
}

// 3) Valid cursor but a huge gap (e.g. long-offline reattach) → forced reset + tail cap, so the
//    client thread can never be asked to render an unbounded incremental batch.
{
  const messages = mkMessages(2000);
  const early = historyDelta(messages.slice(0, 10));
  const delta = historyDelta(messages, early.cursor);
  if (delta.reset) fail('precondition: cursor over first 10 should be a valid incremental cursor');
  if (delta.messages.length !== 1990) fail('precondition: expected 1990 new messages');
  const capped = capHistoryDelta(delta, 500, messages.length);
  if (capped.messages.length !== 500) fail('huge incremental delta must be capped');
  if (!capped.reset) fail('a capped incremental delta must force reset:true (the client tail-rebuilds; nothing silently missing mid-thread)');
  if ((capped.messages[0] as any).key !== 'm1500') fail('capped incremental delta must keep the newest tail');
  if (!capped.truncated || capped.truncated.total !== 2000) fail('truncated.total must report the full durable length');
}

// 4) State salvage: the newest task-list-state / goal-state / metadata-update from the DROPPED
//    prefix must ride along (else capping blanks the todo panel / statusline on long sessions) —
//    but not when the tail already carries a newer frame for the same panel.
{
  const messages = mkMessages(1200);
  (messages as any[])[100] = { type: 'task-list-state', key: 'claude:tasks', status: 'running', items: [{ title: 'old', status: 'open' }] };
  (messages as any[])[200] = { type: 'task-list-state', key: 'claude:tasks', status: 'running', items: [{ title: 'newer', status: 'open' }] };
  (messages as any[])[300] = { type: 'metadata-update', key: 'context', value: '42%' };
  const capped = capHistoryDelta(historyDelta(messages), 500, messages.length);
  const salvagedTasks = capped.messages.filter((m: any) => m.type === 'task-list-state');
  if (salvagedTasks.length !== 1) fail(`expected exactly 1 salvaged task panel, got ${salvagedTasks.length}`);
  if ((salvagedTasks[0] as any).items[0].title !== 'newer') fail('salvage must keep the NEWEST dropped state frame');
  if (!capped.messages.some((m: any) => m.type === 'metadata-update')) fail('metadata-update must be salvaged');
  // Enrichment is paid for INSIDE the bound (the final delivered shape): 498 tail rows + 2
  // projections, never 500 + 2. The tail stays contiguous and ends at the newest message.
  if (capped.messages.length !== 500) fail(`expected 498 tail + 2 salvaged = 500, got ${capped.messages.length}`);
  if ((capped.messages[0] as any).key !== 'm702') fail(`projection slots must come from the oldest tail rows, got ${(capped.messages[0] as any).key}`);
  if ((capped.messages[497] as any).key !== 'm1199') fail('the newest message must stay in the tail');
  if (capped.olderBoundary !== 702) fail(`tail boundary must move with the spent slots, got ${capped.olderBoundary}`);
  if (capped.truncated?.shown !== 500) fail('shown must count every delivered message');
  if (capped.messages.at(-2)?.type !== 'task-list-state' && capped.messages.at(-1)?.type !== 'task-list-state') fail('salvaged frames should follow the tail');

  // tail already has a newer panel → the dropped one must NOT resurface
  const messages2 = mkMessages(1200);
  (messages2 as any[])[100] = { type: 'task-list-state', key: 'claude:tasks', status: 'running', items: [{ title: 'stale', status: 'open' }] };
  (messages2 as any[])[1100] = { type: 'task-list-state', key: 'claude:tasks', status: 'done', items: [{ title: 'fresh', status: 'done' }] };
  const capped2 = capHistoryDelta(historyDelta(messages2), 500, messages2.length);
  const panels2 = capped2.messages.filter((m: any) => m.type === 'task-list-state');
  if (panels2.length !== 1 || (panels2[0] as any).items[0].title !== 'fresh') fail('tail panel must win over a dropped stale one');
}

// 5) The reported Codex shape: a paused goal thousands of messages before the end survives a 500
//    cap and is projected LAST, so the app's initial bottom scroll visibly shows "Goal paused".
{
  const messages = mkMessages(26_447);
  (messages as any[])[26_447 - 1 - 2_641] = {
    type: 'goal-state',
    key: '019efa47-85b7',
    title: 'resume the last goal',
    status: 'paused',
  };
  const capped = capHistoryDelta(historyDelta(messages), 500, messages.length);
  const last = capped.messages.at(-1) as any;
  if (last?.type !== 'goal-state' || last.status !== 'paused') fail('distant paused goal must be projected after the capped tail');
  if (capped.messages.length !== 500) fail(`expected 499 tail + paused goal projection, got ${capped.messages.length}`);

  // Hub resync uses the cursor-free helper and must preserve the exact same state projection.
  const resync = capHistoryMessages(messages, 500);
  const resyncLast = resync.messages.at(-1) as any;
  if (resyncLast?.type !== 'goal-state' || resyncLast.status !== 'paused') fail('resync cap must preserve the distant paused goal');
  if (resync.truncated?.shown !== 500 || resync.truncated.total !== messages.length) fail('resync cap must report the bounded transcript tail honestly');
}

// 6) Cap disabled (<=0 or non-finite) → pass-through.
{
  const messages = mkMessages(50);
  const delta = historyDelta(messages);
  if (capHistoryDelta(delta, 0, 50) !== delta) fail('cap 0 must disable capping');
  if (capHistoryDelta(delta, Number.NaN, 50) !== delta) fail('NaN cap must disable capping');
}

// 7) Backward pages use opaque prefix-bound cursors, preserve chronological ordering, and never
//    replay old projection/reset frames that could resurrect cleared client state.
{
  const messages: AgentMessage[] = [
    { type: 'model-output', key: 'm0', text: 'zero' },
    { type: 'task-list-state', key: 'tasks', status: 'running', items: [{ title: 'stale', status: 'open' }] },
    { type: 'model-output', key: 'm2', text: 'two' },
    { type: 'goal-state', key: 'goal', title: 'stale goal', status: 'running' },
    { type: 'history-reset', reason: 'old reset' },
    { type: 'model-output', key: 'm5', text: 'five' },
    { type: 'metadata-update', key: 'context', value: 'stale' },
    { type: 'model-output', key: 'm7', text: 'seven' },
    { type: 'model-output', key: 'm8', text: 'eight' },
    { type: 'model-output', key: 'm9', text: 'nine' },
  ] as AgentMessage[];
  const first = backwardHistoryPage(messages, backwardHistoryCursor(messages, messages.length), 3);
  const keys = first.messages.map((message: any) => message.key).join(',');
  if (keys !== 'm7,m8,m9') fail(`backward page must be chronological, got ${keys}`);
  if (!first.hasMore || first.endOfHistory || !first.cursor) fail('first backward page should advertise an earlier page');
  const second = backwardHistoryPage(messages, first.cursor, 10);
  const secondKeys = second.messages.map((message: any) => message.key).join(',');
  if (secondKeys !== 'm0,m2,m5') fail(`state/reset frames must be excluded from older pages, got ${secondKeys}`);
  if (second.hasMore || !second.endOfHistory || second.cursor) fail('final backward page must mark end-of-history without a cursor');

  const appended = backwardHistoryPage([...messages, { type: 'model-output', key: 'tail', text: 'tail' }], backwardHistoryCursor(messages, 7), 2);
  if (appended.gap) fail('tail appends must not invalidate a prefix-bound older cursor');

  const invalid = backwardHistoryPage(messages, 'not-a-cursor', 10);
  if (invalid.gap?.code !== 'HISTORY_CURSOR_INVALID') fail('malformed older cursor must fail with HISTORY_CURSOR_INVALID');
  const goneCursor = backwardHistoryCursor([...messages, ...mkMessages(3)], messages.length + 3);
  const gone = backwardHistoryPage(messages, goneCursor, 10);
  if (gone.gap?.code !== 'HISTORY_CURSOR_GONE') fail('out-of-retention older cursor must fail with HISTORY_CURSOR_GONE');
  const divergedMessages = [...messages];
  divergedMessages[0] = { type: 'model-output', key: 'm0', text: 'rewritten/reset' };
  const diverged = backwardHistoryPage(divergedMessages, backwardHistoryCursor(messages, messages.length), 10);
  if (diverged.gap?.code !== 'HISTORY_CURSOR_DIVERGED') fail('rewritten/reset prefix must fail with HISTORY_CURSOR_DIVERGED');
}

// 8) Decoded-byte bound (lane H1d): the FINAL frame fits the client's decoded estimate, the newest
//    message survives, and the backward boundary pages exactly the rows the frame left out.
{
  const messages = Array.from({ length: 300 }, (_, i) => ({
    type: 'model-output',
    key: `big${i}`,
    text: 'x'.repeat(40_000),
  }) as AgentMessage);
  const capped = capHistoryDelta(historyDelta(messages), 100, messages.length, HISTORY_FRAME_MAX_DECODED_BYTES);
  const bytes = capped.messages.reduce((sum, message) => sum + estimatedClientDecodedBytes(message), 0);
  if (bytes > HISTORY_FRAME_MAX_DECODED_BYTES) fail(`byte-bounded frame is ${bytes} bytes`);
  if (capped.messages.length >= 100) fail('a byte bound tighter than the count bound must shrink the tail');
  if ((capped.messages.at(-1) as any).key !== 'big299') fail('the newest message must survive a byte bound');
  if (!capped.reset || !capped.truncated) fail('a byte-bounded frame is a truncated replacement');
  const boundary = capped.olderBoundary!;
  if (boundary !== messages.length - capped.messages.length) fail('boundary must sit immediately before the shown tail');
  const page = backwardHistoryPage(messages, backwardHistoryCursor(messages, boundary), 5);
  if ((page.messages.at(-1) as any)?.key !== `big${boundary - 1}`) fail('olderCursor must page the row just before the frame');

  // One message larger than the whole budget still ships alone rather than vanishing.
  const oversized = [...mkMessages(10), { type: 'model-output', key: 'huge', text: 'y'.repeat(2_000_000) } as AgentMessage];
  const alone = capHistoryDelta(historyDelta(oversized), 100, oversized.length, HISTORY_FRAME_MAX_DECODED_BYTES);
  if (alone.messages.length !== 1 || (alone.messages[0] as any).key !== 'huge') fail('an oversized newest message must ship alone');
  if (alone.olderBoundary !== 10) fail('the oversized frame must keep a boundary for everything before it');

  // A frame that fits both bounds is untouched.
  const small = historyDelta(mkMessages(20));
  if (capHistoryDelta(small, 100, 20, HISTORY_FRAME_MAX_DECODED_BYTES) !== small) fail('a fitting frame must pass through');
}

// 9) endCursor names the boundary after the frame's newest durable message in the backward
//    encoding, so the frame's own rows page back from exactly where it ended.
{
  const messages = mkMessages(250);
  const delta = historyDelta(messages);
  if (delta.endCursor !== backwardHistoryCursor(messages, messages.length)) fail('endCursor must be the canonical boundary cursor');
  const page = backwardHistoryPage(messages, delta.endCursor, 100);
  if (page.messages.length !== 100 || (page.messages[0] as any).key !== 'm150' || (page.messages[99] as any).key !== 'm249') {
    fail('paging from endCursor must return the newest rows the frame carried');
  }
  const capped = capHistoryDelta(delta, 100, messages.length);
  if (capped.endCursor !== delta.endCursor) fail('capping must preserve endCursor');
  const incremental = historyDelta([...messages, ...mkMessages(3).map((m, i) => ({ ...m, key: `n${i}` }) as AgentMessage)], delta.cursor);
  if (incremental.reset || incremental.messages.length !== 3) fail('precondition: incremental delta');
  const incrementalPage = backwardHistoryPage(
    [...messages, ...mkMessages(3).map((m, i) => ({ ...m, key: `n${i}` }) as AgentMessage)],
    incremental.endCursor,
    3,
  );
  if (incrementalPage.messages.map((m: any) => m.key).join(',') !== 'n0,n1,n2') fail('an incremental endCursor pages the delta rows');
}

// 10) The estimator mirrors the Flutter client's `_estimatedDecodedValueBytes` exactly. The same
//     literal is pinned on the Dart side.
{
  const bytes = estimatedClientDecodedBytes({ type: 'model-output', key: 'k', text: 'abc' });
  if (bytes !== 334) fail(`estimator parity literal changed: ${bytes}`);
  if (estimatedClientDecodedBytes({ a: undefined, b: [1, null, true] }) !== 64 + 24 + 26 + 32 + 24 + 16 + 8 + 16) {
    fail('undefined properties are not delivered and must not be counted');
  }
}

// 11) A frame whose oldest row is a state row the backward walk does not count. Reloading the
//     frame from its endCursor with its pageable row count returns exactly the frame's pageable
//     rows, but the walk stops AFTER the leading state row, so its cursor differs from the frame's
//     olderCursor. This is the shape the client's released-range descriptor exists for: it adopts
//     the descriptor's older boundary when the row count matches, instead of reading the
//     difference as a gap.
{
  const plan = {
    type: 'task-list-state',
    key: 'plan',
    title: 'Plan',
    status: 'running',
    items: [],
  } as unknown as AgentMessage;
  const messages = [...mkMessages(300), plan, ...mkMessages(99).map((m, i) => ({ ...m, key: `t${i}` }) as AgentMessage)];
  const frame = capHistoryDelta(historyDelta(messages), 100, messages.length);
  if (frame.messages.length !== 100 || (frame.messages[0] as any).key !== 'plan') {
    fail(`precondition: the frame starts with the state row, got ${(frame.messages[0] as any)?.key}`);
  }
  const olderCursor = backwardHistoryCursor(messages, frame.olderBoundary!);
  const pageable = frame.messages.filter((m) => m.type !== 'task-list-state').length;
  const reload = backwardHistoryPage(messages, frame.endCursor, pageable);
  if (reload.messages.length !== 99 || (reload.messages[0] as any).key !== 't0') {
    fail('an end-boundary reload returns exactly the frame pageable rows');
  }
  if (reload.cursor === olderCursor) fail('the walk must stop past the leading state row');
  if (reload.cursor !== backwardHistoryCursor(messages, frame.olderBoundary! + 1)) {
    fail('the walk stops immediately after the state row');
  }
}

// 12) A byte-trimmed frame re-exposes the latest state row it trimmed away (lane H1d). State rows
//     are never backward-pageable and a replacement frame rebuilds the client's live state from what
//     it carries, so a plan that fell behind the tail start would otherwise be gone for good.
const planRow = (key: string): AgentMessage => ({
  type: 'task-list-state',
  key,
  title: 'Plan',
  status: 'running',
  items: [{ id: '1', title: 'step', status: 'in-progress' }],
}) as unknown as AgentMessage;
const wideRows = (count: number, prefix = 'wide'): AgentMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    type: 'model-output',
    key: `${prefix}-${i}`,
    text: `${i}:`.padEnd(40_000, 'w'),
  }) as AgentMessage);
{
  const messages = [...wideRows(5), planRow('plan'), ...wideRows(54, 'late')];
  const capped = capHistoryDelta(historyDelta(messages), 100, messages.length, 1024 * 1024, { history: messages });
  if (!capped.truncated) fail('precondition: the byte bound trims this frame');
  if (!capped.messages.some((m) => m.type === 'task-list-state')) fail('a byte-trimmed frame must re-expose the plan row');
  if ((capped.messages.at(-1) as any).type !== 'task-list-state') fail('the projection follows the contiguous tail');
  const bytes = capped.messages.reduce((sum, message) => sum + estimatedClientDecodedBytes(message), 0);
  if (bytes > 1024 * 1024) fail(`the enriched frame must still fit: ${bytes}`);
  if (capped.olderCursor !== backwardHistoryCursor(messages, capped.olderBoundary!)) {
    fail('a capped frame carries the backward cursor at its own boundary');
  }
}

// 13) An incremental delta that a bound turns into a replacement salvages state from the prefix the
//     delta omitted: the client's copy of that prefix is about to be replaced along with its plan.
{
  const messages = [...wideRows(5), planRow('plan'), ...wideRows(54, 'late')];
  const since = historyDelta(messages.slice(0, 10)).cursor;
  const delta = historyDelta(messages, since);
  if (delta.reset || delta.messages.length !== 50) fail('precondition: an incremental delta after the plan');
  const capped = capHistoryDelta(delta, 100, messages.length, 1024 * 1024, { history: messages });
  if (!capped.reset || !capped.truncated) fail('an over-budget incremental delta becomes a replacement');
  if (!capped.messages.some((m) => m.type === 'task-list-state')) {
    fail('the replacement must carry the plan from the omitted prefix');
  }
  if (capped.olderBoundary !== messages.length - capped.messages.filter((m) => m.type !== 'task-list-state').length) {
    fail('the replacement boundary is absolute in the full history');
  }
  // A delta that fits stays incremental and never restates the prefix.
  const fits = historyDelta(mkMessages(30), historyDelta(mkMessages(20)).cursor);
  if (capHistoryDelta(fits, 100, 30, HISTORY_FRAME_MAX_DECODED_BYTES, { history: mkMessages(30) }) !== fits) {
    fail('a fitting incremental delta passes through untouched');
  }
}

// 13b) Salvage shares the count bound. A delta within the count bound but over the byte bound starts
//      later and salvages prefix state, and the salvaged rows still fit beside the tail within `max`.
{
  const history: AgentMessage[] = [];
  for (let index = 0; index < 30; index += 1) history.push(planRow(`plan${index}`));
  for (let index = 0; index < 20; index += 1) history.push({ type: 'model-output', key: `p${index}`, text: 'x' } as AgentMessage);
  const since = historyDelta(history).cursor;
  history.push({ type: 'model-output', key: 'big', text: 'y'.repeat(1_200_000) } as AgentMessage);
  for (let index = 0; index < 99; index += 1) history.push({ type: 'model-output', key: `s${index}`, text: 'z'.repeat(100) } as AgentMessage);
  const capped = capHistoryDelta(historyDelta(history, since), 100, history.length, 2 * 1024 * 1024, { history });
  if (!capped.reset || !capped.truncated) fail('precondition: the oversized delta becomes a replacement');
  if (capped.messages.length > 100) fail(`salvage overflowed the count bound: ${capped.messages.length}`);
  if (capped.truncated.shown !== capped.messages.length) fail('shown counts the delivered rows');
  if (!capped.messages.some((m) => (m as any).key === 'plan29')) fail('the newest plan survives inside the bound');
  if ((capped.messages.findLast((m) => m.type === 'model-output') as any)?.key !== 's98') fail('the tail still ends at the newest row');
}

// 14) The byte bound measures the shape the client receives (lane H1d): a caller whose egress
//     reshapes a row passes that measure, and the frame is bounded by it rather than by the stored
//     shape.
{
  const messages = wideRows(60);
  const stored = capHistoryMessages(messages, 100, messages.length, 1024 * 1024);
  if (!stored.truncated) fail('precondition: the stored shape does not fit');
  const delivered = capHistoryMessages(messages, 100, messages.length, 1024 * 1024, { measure: () => 1_000 });
  if (delivered.truncated || delivered.messages.length !== 60) fail('a delivered-shape measure keeps the whole frame');
  const measured = new Set<string>();
  capHistoryMessages(wideRows(2_000), 0, 2_000, 1024 * 1024, {
    measure: (message) => {
      measured.add((message as any).key);
      return estimatedClientDecodedBytes(message);
    },
  });
  if (measured.size > 40) fail(`rows that can never ship must not be measured (egress-transformed): ${measured.size}`);
}

// 15) The byte phase is linear: with the count bound disabled, a long history trimmed to a small
//     frame finishes promptly and exactly.
{
  const rows = Array.from({ length: 60_000 }, (_, i) => ({ type: 'terminal-output', data: `${i}`.padEnd(64, '.') }) as AgentMessage);
  const started = performance.now();
  const capped = capHistoryMessages(rows, 0, rows.length, 64 * 1024);
  const elapsed = performance.now() - started;
  const bytes = capped.messages.reduce((sum, message) => sum + estimatedClientDecodedBytes(message), 0);
  if (!capped.truncated || bytes > 64 * 1024 || capped.messages.length < 100) fail('the trimmed frame must fit and keep the tail');
  if ((capped.messages.at(-1) as any).data !== (rows.at(-1) as any).data) fail('the trimmed frame ends at the newest row');
  if (elapsed > 2_000) fail(`the byte phase must be linear: ${elapsed.toFixed(0)} ms`);
}

// 16) Estimator parity beyond one literal. Each shape is measured AFTER a JSON round trip, which is
//     what the client decodes; the same JSON and the same numbers are pinned on the Dart side
//     (`transcript_history_window_budget_test.dart`).
{
  const shapes: Array<[string, number]> = [
    ['{"type":"user-message","key":"u1","text":"h\u00e9llo \ud83d\udc4b","sentAt":1700000000000}', 422],
    ['{"type":"tool-call","callId":"c1","toolName":"bash","title":"Run","args":{"command":"ls -la","timeout":30,"env":null,"flags":[true,false]}}', 930],
    [
      `{"type":"tool-result","callId":"c1","toolName":"edit","title":"Edited a.ts","path":"a.ts","isError":false,"additions":3,"deletions":1,"fileChanges":[{"path":"a.ts","operation":"edit","additions":3,"deletions":1}],"diffRef":{"fetchUrl":"/api/sessions/claude/s/artifact/k?expires=1&sig=z","contentHash":"${'ab'.repeat(32)}","byteSize":1234,"lineCount":40}}`,
      2004,
    ],
    ['{"type":"task-list-state","key":"plan","title":"Plan","status":"running","items":[{"id":"1","title":"step one","status":"completed"},{"id":"2","title":"step two","status":"in-progress"}]}', 1242],
    ['{"type":"metadata-update","key":"runtimeTotals","value":{"tokens":[],"cost":{},"ratio":0.5}}', 686],
    [`{"type":"model-output","key":"long","text":"${'x'.repeat(1000)}","final":true}`, 2408],
  ];
  for (const [json, expected] of shapes) {
    const bytes = estimatedClientDecodedBytes(JSON.parse(json));
    if (bytes !== expected) fail(`estimator parity drifted for ${json.slice(0, 40)}: ${bytes} != ${expected}`);
  }
}

// 17) Forward (newer) pages, contract revision 28. A forward page walks the same rows a backward
//     page does, oldest first; its cursor names the boundary after them, so a backward page from
//     that cursor with the same count returns the same rows. A full page ends just before the next
//     row a page carries, and a walk that reaches `until` names it verbatim.
{
  const plan = (key: string): AgentMessage => ({ type: 'task-list-state', key, title: 'P', status: 'running', items: [] }) as unknown as AgentMessage;
  const messages: AgentMessage[] = [];
  for (let index = 0; index < 40; index += 1) {
    messages.push({ type: 'model-output', key: `f${index}`, text: `row ${index}` } as AgentMessage);
    if (index % 7 === 3) messages.push(plan(`plan${index}`));
    if (index === 20) messages.push({ type: 'history-reset', reason: 'old' } as AgentMessage);
  }
  const keysOf = (rows: AgentMessage[]) => rows.map((m: any) => m.key).join(',');
  const start = backwardHistoryCursor(messages, 0);
  const first = forwardHistoryPage(messages, start, 3);
  if (first.gap) fail(`forward page refused: ${first.gap.code}`);
  if (keysOf(first.messages) !== 'f0,f1,f2') fail(`forward page must be oldest-first, got ${keysOf(first.messages)}`);
  if (!first.hasMore || first.endOfHistory || !first.cursor) fail('a forward page with rows beyond it advertises more');
  const mirror = backwardHistoryPage(messages, first.cursor, first.messages.length);
  if (keysOf(mirror.messages) !== keysOf(first.messages)) fail('a backward page from the forward cursor must return the same rows');

  // Walking the whole history forward holds every pageable row exactly once, in order.
  const walked: AgentMessage[] = [];
  let cursor: string | undefined = start;
  let pages = 0;
  for (;;) {
    const page = forwardHistoryPage(messages, cursor, 4);
    if (page.gap) fail(`forward walk refused: ${page.gap.code}`);
    walked.push(...page.messages);
    pages += 1;
    const back = backwardHistoryPage(messages, page.cursor, page.messages.length);
    if (page.messages.length > 0 && keysOf(back.messages) !== keysOf(page.messages)) fail(`page ${pages}: forward and backward walks disagree`);
    cursor = page.cursor;
    if (page.endOfHistory) break;
    if (pages > 100) fail('forward walk does not terminate');
  }
  if (keysOf(walked) !== keysOf(messages.filter(isBackwardPageMessage))) fail('a forward walk must hold every pageable row once, in order');
  if (cursor !== backwardHistoryCursor(messages, messages.length)) fail('the final forward cursor is the end boundary');
  if (cursor !== historyDelta(messages).endCursor) fail('the final forward cursor equals the frame endCursor');

  // `until` closes a range exactly: the rows between two boundaries, then `until` verbatim.
  const lower = backwardHistoryCursor(messages, 5);
  const upper = backwardHistoryCursor(messages, 30);
  const between = messages.slice(5, 30).filter(isBackwardPageMessage);
  const closed = forwardHistoryPage(messages, lower, 100, upper);
  if (keysOf(closed.messages) !== keysOf(between) || closed.cursor !== upper) fail('a forward page stops at until and names it');
  if (!closed.hasMore) fail('rows exist after until');
  // A full page whose last row is followed only by rows no page carries still closes the range.
  const planAt = messages.findIndex((m) => m.type === 'task-list-state');
  const beforePlan = messages.slice(0, planAt).filter(isBackwardPageMessage).length;
  const exact = forwardHistoryPage(messages, start, beforePlan, backwardHistoryCursor(messages, planAt + 1));
  if (exact.messages.length !== beforePlan || exact.cursor !== backwardHistoryCursor(messages, planAt + 1)) {
    fail('a full page ending before a state row closes the range at until');
  }
  // A partial page leaves the rest of the range for the next page, which then closes it.
  const partial = forwardHistoryPage(messages, lower, 5, upper);
  if (partial.messages.length !== 5 || partial.cursor === upper) fail('a partial page stops early');
  const rest = forwardHistoryPage(messages, partial.cursor, 100, upper);
  if (keysOf([...partial.messages, ...rest.messages]) !== keysOf(between) || rest.cursor !== upper) {
    fail('two partial pages hold the range once and close it');
  }
  // The client matches the closed range by the cursor it sent, so `until` comes back verbatim even
  // in an encoding the broker would not have produced itself.
  const canonical = JSON.parse(Buffer.from(upper, 'base64url').toString('utf8'));
  const reordered = Buffer.from(JSON.stringify({ h: canonical.h, b: canonical.b, k: 'older', v: 1 }), 'utf8').toString('base64url');
  if (reordered === upper) fail('precondition: the reordered cursor is a different string');
  const verbatim = forwardHistoryPage(messages, lower, 100, reordered);
  if (verbatim.gap || verbatim.cursor !== reordered) fail('a walk that reaches until returns it verbatim');
  const empty = forwardHistoryPage(messages, upper, 10, upper);
  if (empty.gap || empty.messages.length !== 0 || empty.cursor !== upper) fail('an empty range is closed immediately');
  if (forwardHistoryPage(messages, upper, 10, lower).gap?.code !== 'HISTORY_CURSOR_INVALID') fail('until before the cursor is invalid');
  if (forwardHistoryPage(messages, 'nope', 10).gap?.code !== 'HISTORY_CURSOR_INVALID') fail('a malformed forward cursor is invalid');
  if (forwardHistoryPage(messages, start, 10, 'nope').gap?.code !== 'HISTORY_CURSOR_INVALID') fail('a malformed until is invalid');
  const longer = [...messages, ...mkMessages(5).map((m, i) => ({ ...m, key: `x${i}` }) as AgentMessage)];
  if (forwardHistoryPage(messages, backwardHistoryCursor(longer, longer.length), 10).gap?.code !== 'HISTORY_CURSOR_GONE') {
    fail('a forward cursor past the end is gone');
  }
  const rewritten = [...messages];
  rewritten[0] = { type: 'model-output', key: 'f0', text: 'rewritten' } as AgentMessage;
  if (forwardHistoryPage(rewritten, upper, 10).gap?.code !== 'HISTORY_CURSOR_DIVERGED') fail('a rewritten prefix diverges');
  // Appends never invalidate a forward cursor; the walk continues into the appended rows.
  const appended = forwardHistoryPage(longer, cursor, 10);
  if (appended.gap || keysOf(appended.messages) !== 'x0,x1,x2,x3,x4' || !appended.endOfHistory) fail('a forward walk continues into appended rows');
}

// 18) history-refresh (revision 28): from the reconnect cursor of the client's last frame, a bounded
//     PREFIX of what was persisted since, and the boundaries after it in both encodings. The frame
//     is never a replacement, never skips a row, and repeated refreshes cover the suffix once.
{
  const prefix = mkMessages(20);
  const since = historyDelta(prefix).cursor;
  const grown = [...prefix, ...mkMessages(250).map((m, i) => ({ ...m, key: `g${i}` }) as AgentMessage)];
  const first = historyRefresh(grown, since, { max: 100 });
  if ('gap' in first) fail(`refresh refused: ${first.gap.code}`);
  if (first.messages.length !== 100 || (first.messages[0] as any).key !== 'g0') fail('a refresh is a prefix of the persisted suffix, oldest first');
  if (!first.more) fail('a bounded refresh reports that more was persisted');
  if (first.cursor !== historyDelta(grown.slice(0, 120)).cursor) fail('the refresh cursor is the reconnect cursor after its rows');
  if (first.endCursor !== backwardHistoryCursor(grown, 120)) fail('the refresh endCursor is the page cursor after its rows');
  const reload = backwardHistoryPage(grown, first.endCursor, first.messages.length);
  if (reload.messages.map((m: any) => m.key).join(',') !== first.messages.map((m: any) => m.key).join(',')) {
    fail('paging back from the refresh endCursor returns exactly the refreshed rows');
  }
  const followUp = historyDelta(grown, first.cursor);
  if (followUp.reset || followUp.messages.length !== 150) fail('a reconnect from the refresh cursor is incremental');
  const covered: AgentMessage[] = [...first.messages];
  let cursor = first.cursor;
  for (let guard = 0; guard < 10; guard += 1) {
    const next = historyRefresh(grown, cursor, { max: 100 });
    if ('gap' in next) fail(`follow-up refresh refused: ${next.gap.code}`);
    covered.push(...next.messages);
    cursor = next.cursor;
    if (!next.more) break;
  }
  if (covered.length !== 250 || covered.some((m: any, i) => m.key !== `g${i}`)) fail('refreshes cover the persisted suffix exactly once, in order');
  if (cursor !== historyDelta(grown).cursor) fail('the last refresh ends at the current reconnect cursor');
  const idle = historyRefresh(grown, cursor, { max: 100 });
  if ('gap' in idle || idle.messages.length !== 0 || idle.cursor !== cursor || idle.more) fail('an up-to-date refresh is empty and keeps the cursor');

  // The byte bound, measured as the connection receives rows; an oversized row still ships alone.
  const wide = [...prefix, ...Array.from({ length: 60 }, (_, i) => ({ type: 'model-output', key: `w${i}`, text: 'w'.repeat(40_000) }) as AgentMessage)];
  const bounded = historyRefresh(wide, since, { max: 100, maxDecodedBytes: 1024 * 1024 });
  if ('gap' in bounded) fail('bounded refresh refused');
  const bytes = bounded.messages.reduce((sum, m) => sum + estimatedClientDecodedBytes(m), 0);
  if (bytes > 1024 * 1024 || bounded.messages.length === 0 || bounded.messages.length >= 60 || !bounded.more) fail(`the refresh is byte-bounded: ${bytes}`);
  const delivered = historyRefresh(wide, since, { max: 100, maxDecodedBytes: 1024 * 1024, measure: () => 1 });
  if ('gap' in delivered || delivered.messages.length !== 60) fail('the refresh bound measures the delivered shape');
  const huge = [...prefix, { type: 'model-output', key: 'huge', text: 'h'.repeat(3_000_000) } as AgentMessage];
  const alone = historyRefresh(huge, since, { max: 100, maxDecodedBytes: 1024 * 1024 });
  if ('gap' in alone || alone.messages.length !== 1) fail('an oversized row ships alone');

  // While a turn runs, the rows at the end it may still rewrite are left for a later frame: a
  // newest row of streamed text, the tool calls just before it (a running call is rewritten in
  // place, into its result), and every row from a call still waiting for its result. Any other
  // newest row is not held, and nothing is held once the turn ends.
  const streaming = [...prefix, { type: 'tool-result', callId: 'c', toolName: 'bash' } as AgentMessage, { type: 'model-output', key: 'live', text: 'partial' } as AgentMessage];
  const held = historyRefresh(streaming, since, { max: 100, holdTrailingText: true });
  if ('gap' in held || held.messages.length !== 1 || held.messages[0]!.type !== 'tool-result') fail('a running turn holds the trailing text row back');
  if (held.cursor !== historyDelta(streaming.slice(0, 21)).cursor || !held.more) fail('a held row stays beyond the refresh cursor');
  const settled = historyRefresh(streaming, since, { max: 100, holdTrailingText: false });
  if ('gap' in settled || settled.messages.length !== 2) fail('an idle refresh carries the trailing text');
  const thinking = [...prefix, { type: 'thinking', key: 'th', text: 'hmm' } as AgentMessage];
  const heldThinking = historyRefresh(thinking, since, { max: 100, holdTrailingText: true });
  if ('gap' in heldThinking || heldThinking.messages.length !== 0 || heldThinking.cursor !== since) fail('trailing thinking is held too');
  const toolRunning = [...prefix, { type: 'model-output', key: 'done', text: 'done' } as AgentMessage, { type: 'tool-call', callId: 'd', toolName: 'bash' } as AgentMessage];
  const heldCall = historyRefresh(toolRunning, since, { max: 100, holdTrailingText: true });
  if ('gap' in heldCall || heldCall.messages.length !== 1 || heldCall.messages[0]!.type !== 'model-output') fail('a running tool call is held and the finished text before it ships');
  const settledCall = historyRefresh(toolRunning, since, { max: 100, holdTrailingText: false });
  if ('gap' in settledCall || settledCall.messages.length !== 2) fail('an idle refresh carries the trailing tool call');
  const parallel = [...prefix, { type: 'tool-call', callId: 'p1', toolName: 'bash' } as AgentMessage, { type: 'tool-call', callId: 'p2', toolName: 'bash' } as AgentMessage, { type: 'model-output', key: 'after', text: 'while they run' } as AgentMessage];
  const heldParallel = historyRefresh(parallel, since, { max: 100, holdTrailingText: true });
  if ('gap' in heldParallel || heldParallel.messages.length !== 0 || heldParallel.cursor !== since) fail('every running call before trailing text is held');
  const finished = [...prefix, { type: 'tool-call', callId: 'f', toolName: 'bash' } as AgentMessage, { type: 'tool-result', callId: 'f', toolName: 'bash' } as AgentMessage];
  const notHeld = historyRefresh(finished, since, { max: 100, holdTrailingText: true });
  if ('gap' in notHeld || notHeld.messages.length !== 2) fail('a call followed by its result is finished and ships');
  const keyless = [...prefix, { type: 'model-output', text: 'no key' } as AgentMessage];
  const keylessHeld = historyRefresh(keyless, since, { max: 100, holdTrailingText: true });
  if ('gap' in keylessHeld || keylessHeld.messages.length !== 1) fail('keyless text cannot be streamed by key and is not held');

  // Refusals: a malformed, out-of-range or diverged reconnect cursor is refused, never guessed.
  const refusal = (value: unknown) => (value as { gap?: { code: string } }).gap?.code;
  if (refusal(historyRefresh(grown, 'nope', { max: 100 })) !== 'HISTORY_CURSOR_INVALID') fail('a malformed refresh cursor is invalid');
  if (refusal(historyRefresh(grown, undefined, { max: 100 })) !== 'HISTORY_CURSOR_INVALID') fail('a refresh needs a cursor');
  if (refusal(historyRefresh(prefix, historyDelta(grown).cursor, { max: 100 })) !== 'HISTORY_CURSOR_GONE') fail('a refresh cursor past the end is gone');
  const rewritten = [...grown];
  rewritten[3] = { type: 'model-output', key: 'm3', text: 'rewritten' } as AgentMessage;
  if (refusal(historyRefresh(rewritten, since, { max: 100 })) !== 'HISTORY_CURSOR_DIVERGED') fail('a rewritten prefix diverges');

  // The request is checked before anything is read. A session whose live rows carry other keys
  // than their history rows refuses the refresh outright: every row it restated would show twice.
  const serves = { historyRefreshRefusal: () => undefined };
  const rekeys = { historyRefreshRefusal: () => 'live rows are re-keyed' };
  const defaulted = historyRefreshRequest({ cursor: ` ${since} ` }, serves);
  if ('code' in defaulted || defaulted.limit !== 100 || defaulted.since !== since) fail('a refresh defaults to 100 rows from the trimmed cursor');
  const widest = historyRefreshRequest({ cursor: since, limit: 500 }, serves);
  if ('code' in widest || widest.limit !== 500) fail('a refresh may ask for up to 500 rows');
  for (const limit of [0, 501, 1.5, Number.NaN]) {
    const bad = historyRefreshRequest({ cursor: since, limit }, serves);
    if (!('code' in bad) || bad.code !== 'BAD_PARAM') fail(`a refresh limit of ${limit} is refused`);
  }
  for (const cursor of [undefined, '', '   ', 7]) {
    const bad = historyRefreshRequest({ cursor }, serves);
    if (!('code' in bad) || bad.code !== 'BAD_PARAM') fail('a refresh without a cursor is refused');
  }
  const refused = historyRefreshRequest({ cursor: since }, rekeys);
  if (!('code' in refused) || refused.code !== 'NOT_SUPPORTED' || refused.message !== 'live rows are re-keyed') {
    fail('a session that re-keys its live rows refuses a refresh');
  }
}

// The rows that end a history while they describe its current state stay out of its cursor space
// and replay after the frame; a transcript row after them makes them history. The set is what the
// adapters were observed to restate: a finished run's summary and a plan, goal or status row are
// transcript even at the end.
{
  const transcript = mkMessages(3);
  const volatile: AgentMessage[] = [
    { type: 'user-message', key: 'q', text: 'queued', queued: true } as AgentMessage,
    { type: 'permission-request', requestId: 'p', title: 'bash' } as AgentMessage,
    { type: 'question-request', requestId: 'q', questions: [] } as AgentMessage,
    { type: 'run-summary', key: 'r', turnId: 't', status: 'running' } as AgentMessage,
    { type: 'run-summary', key: 'c', turnId: 't', status: 'cancelled' } as AgentMessage,
    { type: 'token-count', input: 1, output: 1 } as AgentMessage,
    { type: 'metadata-update', key: 'runtimeTotals', value: {} } as AgentMessage,
  ];
  for (const row of volatile) {
    const split = cursorDurableHistory([...transcript, row]);
    if (split.durable.length !== 3 || split.derived.at(-1) !== row) fail(`a trailing ${row.type} replays after the frame`);
    const followed = cursorDurableHistory([...transcript, row, { type: 'model-output', key: 'next', text: 'next' } as AgentMessage]);
    if (followed.durable.length !== 5 || followed.derived.includes(row)) fail(`a ${row.type} followed by transcript is history`);
  }
  const transcriptEnds: AgentMessage[] = [
    { type: 'user-message', key: 'sent', text: 'sent' } as AgentMessage,
    { type: 'run-summary', key: 'd', turnId: 't', status: 'done' } as AgentMessage,
    { type: 'run-summary', key: 'u', turnId: 't' } as AgentMessage,
    { type: 'task-list-state', key: 'plan', status: 'running', items: [] } as AgentMessage,
    { type: 'goal-state', key: 'goal', title: 'g', status: 'active' } as AgentMessage,
    { type: 'status', status: 'idle' } as AgentMessage,
  ];
  for (const row of transcriptEnds) {
    if (cursorDurableHistory([...transcript, row]).durable.length !== 4) fail(`a trailing ${describeRow(row)} is transcript`);
  }
  // The whole trailing run is held, in order, with the non-durable overlays; the attach cursor is
  // the one over the transcript alone.
  const activity = { type: 'agent-activity', key: 'a', kind: 'subagent', title: 't', status: 'running' } as AgentMessage;
  const mixed = cursorDurableHistory([...transcript, volatile[3]!, activity, volatile[5]!, volatile[6]!]);
  if (mixed.durable.length !== 3 || mixed.derived.length !== 4 || mixed.derived[1] !== activity) fail('the trailing run and the overlays replay in history order');
  if (historyDelta(mixed.durable).cursor !== historyDelta(transcript).cursor) fail('the held run is outside the cursor');
  // A run longer than the look-behind releases its oldest rows as history, so a streaming reader
  // holds a bounded window and still agrees with the whole-array split.
  const long = Array.from({ length: MAX_VOLATILE_TAIL_ROWS + 3 }, () => ({ type: 'token-count', input: 1 }) as AgentMessage);
  const capped = cursorDurableHistory([...transcript, ...long]);
  if (capped.durable.length !== 6 || capped.derived.length !== MAX_VOLATILE_TAIL_ROWS) fail('the held run is bounded');
}

function describeRow(row: AgentMessage): string {
  return row.type === 'run-summary' ? `run-summary(${(row as { status?: string }).status ?? 'unset'})` : row.type;
}

console.log('PASS broker history cap and backward pagination');
