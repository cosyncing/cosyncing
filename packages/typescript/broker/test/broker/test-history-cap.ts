/**
 * Initial-history cap (performance must-fix, 2026-07-03 review):
 * a full-history attach on a huge session must send only the newest N durable messages
 * (bounded frame + bounded client DOM), while the cursor still covers the FULL durable
 * prefix so the next reattach gets an incremental delta, not another full replay.
 */
import type { AgentMessage } from '../../../adapter-api/src/index.ts';
import {
  backwardHistoryCursor,
  backwardHistoryPage,
  capHistoryDelta,
  capHistoryMessages,
  historyDelta,
} from '../../src/sessions/history-delta.ts';

function fail(message: string): never {
  throw new Error(message);
}

const mkMessages = (n: number): AgentMessage[] =>
  Array.from({ length: n }, (_, i) => ({ type: 'model-output', key: `m${i}`, text: `message ${i}` }) as AgentMessage);

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
  if (capped.messages.length !== 502) fail(`expected 500 tail + 2 salvaged, got ${capped.messages.length}`);
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
  if (capped.messages.length !== 501) fail(`expected 500 tail + paused goal projection, got ${capped.messages.length}`);

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

console.log('PASS broker history cap and backward pagination');
