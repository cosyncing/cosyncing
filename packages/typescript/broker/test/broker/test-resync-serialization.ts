#!/usr/bin/env bun
/**
 * Regression — resync snapshots must be broker-authoritative and serialized with live delivery
 * (2026-08-28 stale-resync review, disjoint-stale finding).
 *
 * hub.resync() used to broadcast `{kind:'history'}` with no reset flag and no cursor while live
 * frames kept flowing during the async getHistory() read. A client could therefore hold content
 * NEWER than the "fresh" snapshot and cannot distinguish that shape from a genuine new suffix —
 * with enough intervening output the overlap with its bounded retained tail disappears entirely,
 * and the stale snapshot appends after current content and regresses latest-wins state.
 *
 * The fix has two halves, both pinned here:
 *  1. Authoritative frame: the snapshot travels as `reset: true` with a full-prefix cursor, so the
 *     client REPLACES its window and the next reattach is an incremental delta.
 *  2. Catch-up: live frames arriving while the history read is pending still fan out immediately
 *     (no delivery stall), and are RECONCILED after the snapshot broadcast, so every client
 *     converges on [snapshot][everything newer] — never the stale-disjoint end state.
 *
 * The replay is reconciled, not unconditional (round-4/6 review): a row newly persisted between
 * the pre-resync baseline read and refreshed snapshot need not go out again (keyless rows have no
 * client-side identity to dedup on), but an older byte-identical snapshot row must never consume a
 * new raced occurrence. A capped reset must keep backward paging reachable (olderCursor +
 * hasEarlier, like attach).
 */
import { ManagedConn } from '../../src/sessions/hub.ts';
import { backwardHistoryPage, historyDelta } from '../../src/sessions/history-delta.ts';
import {
  type AgentMessage,
  type AgentMessageHandler,
  type SessionConnection,
  type SessionInfo,
} from '../../../adapter-api/src/index.ts';

let failures = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures++;
};

const info: SessionInfo = { id: 's1', tool: 'claude', machine: 't', title: 'resync', status: 'idle', attachMode: 'observe' };

const row = (key: string, text: string): AgentMessage =>
  ({ type: 'model-output', key, text }) as AgentMessage;

function harness(): {
  managed: ManagedConn;
  frames: any[];
  emit: (m: AgentMessage) => void;
  historyQueue: Array<() => Promise<AgentMessage[]>>;
  historyCalls: number[];
} {
  const handlers: AgentMessageHandler[] = [];
  const historyQueue: Array<() => Promise<AgentMessage[]>> = [];
  const historyCalls: number[] = [];
  const conn: SessionConnection = {
    info,
    getHistory: async () => {
      historyCalls.push(Date.now());
      const next = historyQueue.shift();
      return next ? next() : [];
    },
    subscribe: (h: AgentMessageHandler) => { handlers.push(h); return () => {}; },
    sendPrompt: async () => {},
    respondPermission: async () => {},
    close: async () => {},
  };
  const managed = new ManagedConn(conn);
  const frames: any[] = [];
  managed.addClient((e: any) => frames.push(e));
  return { managed, frames, emit: (m) => { for (const h of handlers) h(m); }, historyQueue, historyCalls };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ── 1. A resync frame is authoritative: reset + full-prefix cursor, derived overlays after. ──────
{
  const durable = [row('m0', 'zero'), row('m1', 'one')];
  const activity = { type: 'agent-activity', key: 'act', kind: 'subagent', title: 'working', status: 'running' } as AgentMessage;
  const { frames, emit, historyQueue } = harness();
  historyQueue.push(async () => [durable[0]!, activity, durable[1]!]);
  emit({ type: 'history-reset', notice: 'undo' } as AgentMessage);
  await flush();

  const history = frames.filter((f) => f.kind === 'history');
  check('resync broadcasts exactly one history frame', history.length === 1);
  const frame = history[0];
  check('resync frame is an explicit reset', frame?.reset === true, JSON.stringify({ reset: frame?.reset }));
  check('resync frame carries a cursor', typeof frame?.cursor === 'string' && frame.cursor.length > 0);
  check(
    'resync frame body is the durable transcript only',
    Array.isArray(frame?.messages) && frame.messages.length === 2 && frame.messages.every((m: any) => m.type === 'model-output'),
  );
  // The cursor must cover the full durable prefix: a reattach with it is an incremental no-op.
  const next = historyDelta(durable, frame?.cursor);
  check('reattach with the resync cursor is an empty incremental delta', !next.reset && next.messages.length === 0);
  const frameAt = frames.indexOf(frame);
  const activityAt = frames.findIndex((f) => f.kind === 'message' && f.message?.type === 'agent-activity');
  check('derived overlays replay after the snapshot frame', activityAt > frameAt, `history@${frameAt} activity@${activityAt}`);
  const notice = frames.findIndex((f) => f.kind === 'notice' && f.message === 'undo');
  check('the notice still fans out with the snapshot', notice > frameAt);
}

// ── 2. Live frames racing the pending read fan out at once AND replay AFTER the snapshot. ────────
{
  const { frames, emit, historyQueue } = harness();
  let release!: (m: AgentMessage[]) => void;
  historyQueue.push(() => new Promise<AgentMessage[]>((r) => { release = r; }));
  emit({ type: 'history-reset' } as AgentMessage);
  await flush(); // let resync start: getHistory is now pending, the replay recorder is armed

  emit(row('live1', 'newer than the snapshot'));
  emit(row('live2', 'also newer'));
  check(
    'live delivery does not stall while the snapshot read is pending',
    frames.filter((f) => f.kind === 'message').map((f) => f.message?.key).join(',') === 'live1,live2',
    JSON.stringify(frames.map((f) => f.kind)),
  );

  // The read resolves to a STALE snapshot that does not contain the live rows — the exact race.
  release([row('m0', 'zero')]);
  await flush();

  const kinds = frames.map((f) => (f.kind === 'message' ? `msg:${f.message?.key}` : f.kind));
  const historyAt = frames.findIndex((f) => f.kind === 'history');
  const live1Last = frames.findLastIndex((f) => f.kind === 'message' && f.message?.key === 'live1');
  const live2Last = frames.findLastIndex((f) => f.kind === 'message' && f.message?.key === 'live2');
  check(
    'every raced frame is replayed after the snapshot that replaced the window',
    historyAt >= 0 && live1Last > historyAt && live2Last > live1Last,
    kinds.join(','),
  );
  const seqs = frames.filter((f) => f.kind === 'message').map((f) => f.seq as number);
  check('wire seq stays monotone across the replay', seqs.every((s, i) => i === 0 || s > seqs[i - 1]!), seqs.join(','));
}

// ── 3. An aborted resync (empty read twice) replays nothing: no snapshot to get ahead of. ────────
{
  const { frames, emit, historyQueue } = harness();
  let release!: (m: AgentMessage[]) => void;
  historyQueue.push(() => new Promise<AgentMessage[]>((r) => { release = r; }));
  historyQueue.push(async () => []); // retry also comes back empty → resync aborts, keeps the view
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  emit(row('live3', 'delivered live, exactly once'));
  release([]);
  await new Promise((r) => setTimeout(r, 1800)); // outlive the broker's 1.5s empty-read retry

  check('an aborted resync sends no history frame', frames.every((f) => f.kind !== 'history'));
  check(
    'a frame racing an aborted resync is delivered exactly once',
    frames.filter((f) => f.kind === 'message' && f.message?.key === 'live3').length === 1,
  );
}

// ── 4. Overlapping resyncs serialize: one cycle at a time, both snapshots broadcast in order. ────
{
  const { frames, emit, historyQueue, historyCalls } = harness();
  let releaseFirst!: (m: AgentMessage[]) => void;
  historyQueue.push(() => new Promise<AgentMessage[]>((r) => { releaseFirst = r; }));
  historyQueue.push(async () => [row('m0', 'zero'), row('m1', 'one')]);
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  emit({ type: 'history-reset' } as AgentMessage); // second resync queues behind the first
  await flush();
  check('the second resync waits for the first read to finish', historyCalls.length === 1);
  releaseFirst([row('m0', 'zero')]);
  await flush();
  await flush();
  const history = frames.filter((f) => f.kind === 'history');
  check('both resyncs broadcast, in order', history.length === 2 && history[1]!.messages.length === 2);
}

// ── 5. A second read can catch a raced keyless row the first read missed. ────────────────────────
{
  const { managed, frames, emit, historyQueue } = harness();
  let release!: (m: AgentMessage[]) => void;
  managed.acceptResyncHistoryCursor(historyDelta([row('m0', 'zero')]).cursor);
  historyQueue.push(() => new Promise<AgentMessage[]>((r) => { release = r; }));
  historyQueue.push(async () => [row('m0', 'zero'), { type: 'error', message: 'boom' } as AgentMessage]);
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  emit({ type: 'error', message: 'boom' } as AgentMessage); // the read will return it
  emit({ type: 'error', message: 'not persisted yet' } as AgentMessage); // the read will miss it
  release([row('m0', 'zero')]); // pre-resync baseline; the refresh above catches `boom`
  await flush();

  const historyAt = frames.findIndex((f) => f.kind === 'history');
  const boom = frames.filter((f) => f.kind === 'message' && f.message?.message === 'boom');
  const missed = frames.filter((f) => f.kind === 'message' && f.message?.message === 'not persisted yet');
  check(
    'a raced keyless row the snapshot carries is not replayed (no visible duplicate)',
    boom.length === 1 && frames.indexOf(boom[0]!) < historyAt,
    `occurrences=${boom.length}`,
  );
  check(
    'a raced keyless row the snapshot missed replays after the reset that wiped it',
    missed.length === 2 && frames.indexOf(missed[1]!) > historyAt,
    `occurrences=${missed.length}`,
  );
}

// ── 5b. Occurrence budget: identical keyless rows reconcile by count, not by identity. ───────────
{
  const { managed, frames, emit, historyQueue } = harness();
  let release!: (m: AgentMessage[]) => void;
  managed.acceptResyncHistoryCursor(historyDelta([row('m0', 'zero')]).cursor);
  historyQueue.push(() => new Promise<AgentMessage[]>((r) => { release = r; }));
  historyQueue.push(async () => [row('m0', 'zero'), { type: 'terminal-output', data: '$ ok\n' } as AgentMessage]);
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  emit({ type: 'terminal-output', data: '$ ok\n' } as AgentMessage); // two IDENTICAL raced chunks
  emit({ type: 'terminal-output', data: '$ ok\n' } as AgentMessage);
  release([row('m0', 'zero')]); // baseline; the refresh above caught one
  await flush();

  const historyAt = frames.findIndex((f) => f.kind === 'history');
  const after = frames.slice(historyAt + 1).filter((f) => f.kind === 'message' && f.message?.type === 'terminal-output');
  check(
    'one snapshot occurrence covers exactly one raced duplicate — the second replays',
    after.length === 1,
    `post-reset occurrences=${after.length}`,
  );
}

// ── 5c. An OLD identical snapshot row cannot consume a NEW raced occurrence. ────────────────────
{
  const { managed, frames, emit, historyQueue } = harness();
  let release!: (m: AgentMessage[]) => void;
  const old = { type: 'terminal-output', data: '$ ok\n' } as AgentMessage;
  managed.acceptResyncHistoryCursor(historyDelta([row('m0', 'zero'), old]).cursor);
  historyQueue.push(() => new Promise<AgentMessage[]>((r) => { release = r; }));
  historyQueue.push(async () => [row('m0', 'zero'), old]); // refresh still misses the new occurrence
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  emit({ type: 'terminal-output', data: '$ ok\n' } as AgentMessage); // new, but byte-identical to old
  release([row('m0', 'zero'), old]); // pre-resync baseline already contained the historical row
  await flush();

  const historyAt = frames.findIndex((f) => f.kind === 'history');
  const after = frames.slice(historyAt + 1).filter((f) => f.kind === 'message' && f.message?.type === 'terminal-output');
  check(
    'an older identical snapshot occurrence cannot absorb a newly raced row',
    after.length === 1,
    `post-reset occurrences=${after.length}`,
  );
}

// ── 5d. The FIRST read may already contain the raced row; the accepted cursor predates it. ──────
{
  const { managed, frames, emit, historyQueue } = harness();
  let release!: (m: AgentMessage[]) => void;
  const boom = { type: 'error', message: 'boom' } as AgentMessage;
  managed.acceptResyncHistoryCursor(historyDelta([row('m0', 'zero')]).cursor);
  historyQueue.push(() => new Promise<AgentMessage[]>((r) => { release = r; }));
  historyQueue.push(async () => [row('m0', 'zero'), boom]); // second read is unchanged
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  emit(boom);
  release([row('m0', 'zero'), boom]); // first read already caught the raced row
  await flush();

  const historyAt = frames.findIndex((f) => f.kind === 'history');
  const occurrences = frames.filter((f) => f.kind === 'message' && f.message?.message === 'boom');
  const after = frames.slice(historyAt + 1).filter((f) => f.kind === 'message' && f.message?.message === 'boom');
  check(
    'a raced row already present in the first read is not duplicated after reset',
    occurrences.length === 1 && after.length === 0,
    `wire occurrences=${occurrences.length} post-reset=${after.length}`,
  );
}

// ── 5e. A pre-window live duplicate cannot cover an identical raced occurrence. ─────────────────
{
  const { managed, frames, emit, historyQueue } = harness();
  let release!: (m: AgentMessage[]) => void;
  const boom = { type: 'error', message: 'boom' } as AgentMessage;
  managed.acceptResyncHistoryCursor(historyDelta([row('m0', 'zero')]).cursor);
  emit(boom); // delivered live before resync; it persists after the accepted cursor
  historyQueue.push(() => new Promise<AgentMessage[]>((r) => { release = r; }));
  historyQueue.push(async () => [row('m0', 'zero'), boom]);
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  emit(boom); // new raced occurrence; both reads miss this copy
  release([row('m0', 'zero'), boom]);
  await flush();

  const historyAt = frames.findIndex((f) => f.kind === 'history');
  const after = frames.slice(historyAt + 1).filter((f) => f.kind === 'message' && f.message?.message === 'boom');
  check(
    'a persisted pre-window live row cannot consume an identical raced row',
    after.length === 1,
    `post-reset occurrences=${after.length}`,
  );
}

// ── 6. A raced streamed delta covered by the snapshot's full text is never re-appended. ──────────
{
  const { frames, emit, historyQueue } = harness();
  let release!: (m: AgentMessage[]) => void;
  emit({ type: 'model-output', key: 's1', delta: 'Hello ' } as AgentMessage); // in-flight pre-resync
  historyQueue.push(() => new Promise<AgentMessage[]>((r) => { release = r; }));
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  emit({ type: 'model-output', key: 's1', delta: 'World' } as AgentMessage); // raced chunk
  release([{ type: 'model-output', key: 's1', text: 'Hello World', final: true } as AgentMessage]);
  await flush();

  const historyAt = frames.findIndex((f) => f.kind === 'history');
  const after = frames.slice(historyAt + 1).filter((f) => f.kind === 'message' && f.message?.key === 's1');
  check(
    'a raced delta whose text the snapshot delivered in full replays nothing',
    after.length === 0,
    JSON.stringify(after.map((f) => f.message)),
  );
  const raced = frames.slice(0, historyAt).filter((f) => f.kind === 'message' && f.message?.delta === 'World');
  check('the raced chunk still streamed live before the snapshot', raced.length === 1);
}

// ── 6b. A raced completion survives a snapshot that delivered all text without the marker. ───────
{
  const { frames, emit, historyQueue } = harness();
  let release!: (m: AgentMessage[]) => void;
  historyQueue.push(() => new Promise<AgentMessage[]>((r) => { release = r; }));
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  emit({ type: 'model-output', key: 'f1', text: 'Done', final: true } as AgentMessage);
  release([{ type: 'model-output', key: 'f1', text: 'Done' } as AgentMessage]); // full text, no final
  await flush();

  const historyAt = frames.findIndex((f) => f.kind === 'history');
  const after = frames.slice(historyAt + 1).filter((f) => f.kind === 'message' && f.message?.key === 'f1');
  check(
    'a raced final full-text frame re-finalizes the snapshot copy',
    after.length === 1 && after[0]!.message?.final === true && after[0]!.message?.text === 'Done',
    JSON.stringify(after.map((f) => f.message)),
  );
}

// ── 6c. A fully-overlapped raced delta still carries its completion across the reset. ────────────
{
  const { frames, emit, historyQueue } = harness();
  let release!: (m: AgentMessage[]) => void;
  historyQueue.push(() => new Promise<AgentMessage[]>((r) => { release = r; }));
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  emit({ type: 'model-output', key: 'f1', delta: 'ne', final: true } as AgentMessage);
  release([{ type: 'model-output', key: 'f1', text: 'Done' } as AgentMessage]); // covers the delta, no final
  await flush();

  const historyAt = frames.findIndex((f) => f.kind === 'history');
  const after = frames.slice(historyAt + 1).filter((f) => f.kind === 'message' && f.message?.key === 'f1');
  check(
    'a fully-overlapped final delta re-finalizes on the delivered full text',
    after.length === 1 && after[0]!.message?.final === true && after[0]!.message?.text === 'Done',
    JSON.stringify(after.map((f) => f.message)),
  );
}

// ── 6d. No re-finalize when the snapshot copy already carries the marker. ────────────────────────
{
  const { frames, emit, historyQueue } = harness();
  let release!: (m: AgentMessage[]) => void;
  historyQueue.push(() => new Promise<AgentMessage[]>((r) => { release = r; }));
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  emit({ type: 'model-output', key: 'f1', text: 'Done', final: true } as AgentMessage);
  release([{ type: 'model-output', key: 'f1', text: 'Done', final: true } as AgentMessage]);
  await flush();

  const historyAt = frames.findIndex((f) => f.kind === 'history');
  const after = frames.slice(historyAt + 1).filter((f) => f.kind === 'message' && f.message?.key === 'f1');
  check('a snapshot copy that is already final replays nothing', after.length === 0, JSON.stringify(after.map((f) => f.message)));
}

// ── 7. A stale snapshot missing the streamed tail gets exactly the missing tail, appended. ───────
{
  const { frames, emit, historyQueue } = harness();
  let release!: (m: AgentMessage[]) => void;
  emit({ type: 'model-output', key: 's1', delta: 'Hello ' } as AgentMessage);
  historyQueue.push(() => new Promise<AgentMessage[]>((r) => { release = r; }));
  emit({ type: 'history-reset' } as AgentMessage); // clears the accumulator: the chunk is a fragment
  await flush();
  emit({ type: 'model-output', key: 's1', delta: 'World' } as AgentMessage);
  release([{ type: 'model-output', key: 's1', text: 'Hello ' } as AgentMessage]); // stale: missing the tail
  await flush();

  const historyAt = frames.findIndex((f) => f.kind === 'history');
  const after = frames.slice(historyAt + 1).filter((f) => f.kind === 'message' && f.message?.key === 's1');
  check(
    'the catch-up appends exactly the missing tail once',
    after.length === 1 && after[0]!.message?.delta === 'World' && after[0]!.message?.text === undefined,
    JSON.stringify(after.map((f) => f.message)),
  );
}

// ── 7b. Partial-flush alignment: only the genuinely undelivered suffix is appended. ──────────────
{
  const { frames, emit, historyQueue } = harness();
  let release!: (m: AgentMessage[]) => void;
  historyQueue.push(() => new Promise<AgentMessage[]>((r) => { release = r; }));
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  emit({ type: 'model-output', key: 's1', delta: 'World' } as AgentMessage);
  release([{ type: 'model-output', key: 's1', text: 'Hello Wor' } as AgentMessage]); // mid-chunk flush
  await flush();

  const historyAt = frames.findIndex((f) => f.kind === 'history');
  const after = frames.slice(historyAt + 1).filter((f) => f.kind === 'message' && f.message?.key === 's1');
  check(
    'a mid-chunk flush overlap replays only the unseen suffix',
    after.length === 1 && after[0]!.message?.delta === 'ld',
    JSON.stringify(after.map((f) => f.message)),
  );
}

// ── 8. A non-clearing resync (owner refresh) restores the in-flight buffer and pending card. ─────
{
  const { managed, frames, emit, historyQueue } = harness();
  emit({ type: 'model-output', key: 's2', delta: 'streaming…' } as AgentMessage);
  emit({ type: 'permission-request', requestId: 'p1', title: 'Allow?' } as AgentMessage);
  historyQueue.push(async () => [row('m0', 'zero')]); // snapshot carries neither
  managed.refreshAttachedClients(); // resync without the history-reset accumulator clear
  await flush();

  const historyAt = frames.findIndex((f) => f.kind === 'history');
  const after = frames.slice(historyAt + 1).filter((f) => f.kind === 'message');
  check(
    'the in-flight streamed text the reset wiped is restored as full text',
    after.some((f) => f.message?.key === 's2' && f.message?.text === 'streaming…'),
    JSON.stringify(after.map((f) => f.message)),
  );
  check(
    'the pending request card is restored after the reset',
    after.some((f) => f.message?.type === 'permission-request' && f.message?.requestId === 'p1'),
  );
}

// ── 9. A capped resync reset keeps the older history reachable. ──────────────────────────────────
{
  const { frames, emit, historyQueue } = harness();
  const many = Array.from({ length: 620 }, (_, i) => row(`m${i}`, `message ${i}`));
  historyQueue.push(async () => many);
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();

  const frame = frames.find((f) => f.kind === 'history');
  check(
    'capped resync sends the newest 500 with honest truncation metadata',
    frame?.messages?.length === 500 && frame?.truncated?.shown === 500 && frame?.truncated?.total === 620,
    JSON.stringify(frame?.truncated),
  );
  check(
    'capped resync advertises the earlier history it replaced',
    frame?.hasEarlier === true && typeof frame?.olderCursor === 'string',
  );
  const page = backwardHistoryPage(many, frame?.olderCursor, 100);
  const last = page.messages.at(-1) as any;
  check(
    'the backward cursor pages the pre-window history',
    page.messages.length === 100 && last?.key === 'm119' && page.hasMore === true,
    `last=${last?.key} hasMore=${page.hasMore}`,
  );
}

console.log(`\n${failures ? `${failures} FAILED` : 'resync-serialization regression: all checks passed.'}`);
process.exit(failures ? 1 : 0);
