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
import {
  backwardHistoryPage,
  estimatedClientDecodedBytes,
  HISTORY_FRAME_MAX_DECODED_BYTES,
  historyDelta,
} from '../../src/sessions/history-delta.ts';
import {
  type AgentMessage,
  type AgentMessageHandler,
  type HistorySourceIdentity,
  type SessionConnection,
  type SessionInfo,
} from '../../../adapter-api/src/index.ts';
import { HISTORY_PAGE_CACHE_MAX_ENTRY_MESSAGES } from '../../src/sessions/history-page-cache.ts';
import { buildDiffRefMessage } from '../../src/sessions/diff-reference.ts';

let failures = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures++;
};

const info: SessionInfo = { id: 's1', tool: 'claude', machine: 't', title: 'resync', status: 'idle', attachMode: 'observe' };

const row = (key: string, text: string): AgentMessage =>
  ({ type: 'model-output', key, text }) as AgentMessage;

const SOURCE: HistorySourceIdentity = { sourceId: 'resync-source', revision: '1' };

function harness(options: {
  /** The source identity the connection reports; none reproduces an unversioned adapter. */
  identity?: HistorySourceIdentity;
  /** Whether the connection offers a native random-access capture (an indexed source). */
  capture?: boolean;
  /** The subscribers' egress transforms; `null` is a subscriber that declares none. */
  egresses?: Array<((message: AgentMessage) => AgentMessage) | null>;
  /** Per subscriber: whether it already knows the paging route refuses its source. */
  pagingRefused?: boolean[];
  /** Whether the connection keys its live rows differently from their history rows. */
  rekeyed?: boolean;
} = {}): {
  managed: ManagedConn;
  frames: any[];
  clientFrames: any[][];
  emit: (m: AgentMessage) => void;
  historyQueue: Array<() => Promise<AgentMessage[]>>;
  historyCalls: number[];
} {
  const handlers: AgentMessageHandler[] = [];
  const historyQueue: Array<() => Promise<AgentMessage[]>> = [];
  const historyCalls: number[] = [];
  const conn: SessionConnection = {
    // Each harness owns its session record: the managed connection writes its run state back into
    // it, and a shared record would start every later case with an earlier case's turn running.
    info: { ...info },
    getHistory: async () => {
      historyCalls.push(Date.now());
      const next = historyQueue.shift();
      return next ? next() : [];
    },
    subscribe: (h: AgentMessageHandler) => { handlers.push(h); return () => {}; },
    sendPrompt: async () => {},
    respondPermission: async () => {},
    close: async () => {},
    ...(options.identity ? { getHistorySourceIdentity: () => options.identity } : {}),
    ...(options.capture
      ? { captureHistorySnapshot: async () => undefined as never }
      : {}),
    ...(options.rekeyed === undefined ? {} : { liveRowsRekeyedInHistory: options.rekeyed }),
  };
  const managed = new ManagedConn(conn);
  const clientFrames: any[][] = [];
  (options.egresses ?? [null]).forEach((egress, index) => {
    const received: any[] = [];
    clientFrames.push(received);
    const refused = options.pagingRefused?.[index];
    const client = Object.assign(
      (e: any) => received.push(e),
      egress ? { historyEgress: egress } : {},
      refused === undefined ? {} : { historyPagingRefused: () => refused },
    );
    managed.addClient(client);
  });
  const frames = clientFrames[0]!;
  return { managed, frames, clientFrames, emit: (m) => { for (const h of handlers) h(m); }, historyQueue, historyCalls };
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

// ── 1b. The trailing pending/running rows replay after the frame, outside its cursor. ────────────
{
  const durable = [row('m0', 'zero'), row('m1', 'one')];
  const summary = { type: 'run-summary', key: 'run:1', turnId: 't1', status: 'running' } as AgentMessage;
  const tokens = { type: 'token-count', input: 10, output: 5 } as AgentMessage;
  const { frames, emit, historyQueue } = harness();
  historyQueue.push(async () => [...durable, summary, tokens]);
  emit({ type: 'history-reset', notice: 'undo' } as AgentMessage);
  await flush();
  const frame = frames.find((f) => f.kind === 'history');
  check(
    'a resync frame ends at the transcript, before the trailing run summary and token reading',
    frame?.messages?.length === 2 && frame.cursor === historyDelta(durable).cursor,
    JSON.stringify(frame?.messages?.map((m: any) => m.type)),
  );
  const frameAt = frames.indexOf(frame);
  const replayed = frames.slice(frameAt + 1).filter((f) => f.kind === 'message').map((f) => f.message?.type);
  check('the trailing rows replay after the frame', replayed.includes('run-summary') && replayed.includes('token-count'),
    JSON.stringify(replayed));
  // The adapter restates them once the next prompt lands: the resync cursor still resolves.
  const grown = [...durable, { ...summary, status: 'done' } as AgentMessage, tokens, { type: 'user-message', key: 'u2', text: 'next' } as AgentMessage];
  const next = historyDelta(grown, frame?.cursor);
  check('the resync cursor survives the restated rows', !next.reset && !next.gap && next.messages.length === 3);
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
  const { frames, emit, historyQueue } = harness({ identity: SOURCE });
  const many = Array.from({ length: 620 }, (_, i) => row(`m${i}`, `message ${i}`));
  historyQueue.push(async () => many);
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();

  const frame = frames.find((f) => f.kind === 'history');
  // Lane H1d: a resync replaces every client's window, so it is one client page (100), the same
  // bound the first-party client asks for on attach — not the 500-message legacy attach default a
  // bounded client could only trim without a boundary.
  check(
    'capped resync sends the newest client page with honest truncation metadata',
    frame?.messages?.length === 100 && frame?.truncated?.shown === 100 && frame?.truncated?.total === 620
      && frame?.messages?.[0]?.key === 'm520' && frame?.messages?.[99]?.key === 'm619',
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
    page.messages.length === 100 && last?.key === 'm519' && page.hasMore === true,
    `last=${last?.key} hasMore=${page.hasMore}`,
  );
  // The frame's endCursor is the boundary after its newest row: releasing the frame and paging
  // from it returns exactly the rows the frame carried.
  const framePage = backwardHistoryPage(many, frame?.endCursor, 100);
  check(
    'the resync endCursor pages exactly the frame it ended',
    framePage.messages.length === 100
      && (framePage.messages[0] as any)?.key === 'm520'
      && (framePage.messages.at(-1) as any)?.key === 'm619'
      && framePage.cursor === frame?.olderCursor,
    `first=${(framePage.messages[0] as any)?.key} cursorMatches=${framePage.cursor === frame?.olderCursor}`,
  );
}

// ── 10. A resync frame is bounded by the client's decoded estimate, not only by count. ────────────
{
  const { frames, emit, historyQueue } = harness();
  const wide = Array.from({ length: 80 }, (_, i) => row(`w${i}`, 'z'.repeat(40_000)));
  historyQueue.push(async () => wide);
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  const frame = frames.find((f) => f.kind === 'history');
  const bytes = (frame?.messages ?? []).reduce(
    (sum: number, message: unknown) => sum + estimatedClientDecodedBytes(message),
    0,
  );
  check(
    'a resync frame never exceeds the client decoded frame budget',
    frame?.messages?.length > 0 && frame.messages.length < 80 && bytes <= HISTORY_FRAME_MAX_DECODED_BYTES
      && frame.messages.at(-1)?.key === 'w79',
    `messages=${frame?.messages?.length} bytes=${bytes}`,
  );
  const page = backwardHistoryPage(wide, frame?.olderCursor, 100);
  check(
    'a byte-bounded resync keeps every omitted row one page away',
    frame?.hasEarlier === true
      && (page.messages.at(-1) as any)?.key === `w${80 - frame.messages.length - 1}`,
    `last=${(page.messages.at(-1) as any)?.key}`,
  );
}

// ── 11. The end boundary is named only where a page request can serve it (lane H1d). ─────────────
// A client treats `endCursor` as permission to release the frame's rows and reload them later. A
// source the paging route refuses — no identity, or a history over the paging cache — must not be
// handed one, or the rows it releases can never come back.
{
  const history = Array.from({ length: 620 }, (_, i) => row(`u${i}`, `message ${i}`));
  const unversioned = harness();
  unversioned.historyQueue.push(async () => history);
  unversioned.emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  const unversionedFrame = unversioned.frames.find((f) => f.kind === 'history');
  check(
    'an unversioned source resyncs without an end boundary',
    unversionedFrame?.messages?.length === 100 && !('endCursor' in unversionedFrame),
    `keys=${Object.keys(unversionedFrame ?? {}).join(',')}`,
  );

  const oversized = Array.from(
    { length: HISTORY_PAGE_CACHE_MAX_ENTRY_MESSAGES + 1 },
    (_, i) => ({ type: 'terminal-output', data: `${i}\n` }) as AgentMessage,
  );
  const limited = harness({ identity: SOURCE });
  limited.historyQueue.push(async () => oversized);
  limited.emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  const limitedFrame = limited.frames.find((f) => f.kind === 'history');
  check(
    'a history over the paging cache resyncs without an end boundary',
    limitedFrame?.messages?.length === 100 && !('endCursor' in limitedFrame),
    `keys=${Object.keys(limitedFrame ?? {}).join(',')}`,
  );

  const vetoed = harness({ identity: SOURCE, egresses: [null, null], pagingRefused: [true, false] });
  vetoed.historyQueue.push(async () => history);
  vetoed.emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  const refusedFrame = vetoed.clientFrames[0]!.find((f) => f.kind === 'history');
  const servedFrame = vetoed.clientFrames[1]!.find((f) => f.kind === 'history');
  check(
    'a subscriber that knows paging is refused for it gets no end boundary; the others do',
    refusedFrame !== undefined && !('endCursor' in refusedFrame)
      && typeof servedFrame?.endCursor === 'string',
  );

  const indexed = harness({ identity: SOURCE, capture: true });
  indexed.historyQueue.push(async () => oversized);
  indexed.emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  const indexedFrame = indexed.frames.find((f) => f.kind === 'history');
  check(
    'a source with a native capture pages without the encoded cache and keeps its end boundary',
    typeof indexedFrame?.endCursor === 'string',
  );
  // Revision 28: refresh and newer paging are offered on exactly the frames that name an end.
  check(
    'newerHistory rides exactly where endCursor does',
    !('newerHistory' in unversionedFrame) && !('newerHistory' in limitedFrame) && !('newerHistory' in refusedFrame)
      && servedFrame?.newerHistory === true && indexedFrame?.newerHistory === true,
    JSON.stringify({
      unversioned: unversionedFrame?.newerHistory,
      limited: limitedFrame?.newerHistory,
      refused: refusedFrame?.newerHistory,
      served: servedFrame?.newerHistory,
      indexed: indexedFrame?.newerHistory,
    }),
  );
}

// ── 11b. A history replacement moves the epoch a refresh is checked against (revision 28). ──────
// A `history-refresh` read that spans a reset or a resync describes history every client is about
// to drop, so the broker must be able to tell that one happened while it read.
{
  const history = Array.from({ length: 20 }, (_, i) => row(`e${i}`, `message ${i}`));
  const { managed, emit, historyQueue } = harness({ identity: SOURCE });
  const before = managed.historyReplacementEpoch;
  emit({ type: 'model-output', key: 'plain', text: 'an ordinary row' } as AgentMessage);
  await flush();
  check('an ordinary row leaves the replacement epoch alone', managed.historyReplacementEpoch === before);
  historyQueue.push(async () => history);
  emit({ type: 'history-reset' } as AgentMessage);
  const pushed = managed.historyReplacementEpoch;
  check('a history reset moves the replacement epoch as it arrives', pushed > before);
  await flush();
  check(
    'the resync broadcast moves it again',
    managed.historyReplacementEpoch > pushed,
    `${before} -> ${pushed} -> ${managed.historyReplacementEpoch}`,
  );
  // The answer read before a replacement is not delivered; one read after it is.
  const received: any[] = [];
  const reader = (event: any) => received.push(event);
  managed.addClient(reader);
  const answer = { kind: 'history' as const, messages: [], reset: false, cursor: 'c', endCursor: 'e', newerHistory: true as const, clientMessageId: 'r' };
  check(
    'a refresh read across a replacement is not delivered',
    managed.deliverHistoryRefresh(reader, before, answer) === false
      && !received.some((event) => event.clientMessageId === 'r'),
  );
  check(
    'a refresh read at the current epoch is delivered to its reader only',
    managed.deliverHistoryRefresh(reader, managed.historyReplacementEpoch, answer) === true
      && received.filter((event) => event.clientMessageId === 'r').length === 1,
  );
  check(
    'a refresh for a reader that left is not delivered',
    managed.deliverHistoryRefresh((() => {}) as any, managed.historyReplacementEpoch, answer) === false,
  );
  emit({ type: 'status', status: 'running' } as AgentMessage);
  check('a running turn is visible to the refresh hold', managed.turnInFlight() === true);
  emit({ type: 'status', status: 'idle' } as AgentMessage);
  check('an idle session holds nothing back', managed.turnInFlight() === false);
  // A connection whose live rows carry other keys than their history rows would have every
  // restated row shown twice, so it refuses the refresh; the others serve it.
  check(
    'a refresh is served unless the connection re-keys its live rows',
    managed.historyRefreshRefusal() === undefined
      && harness({ identity: SOURCE, rekeyed: false }).managed.historyRefreshRefusal() === undefined
      && typeof harness({ identity: SOURCE, rekeyed: true }).managed.historyRefreshRefusal() === 'string',
  );
}

// ── 12. The byte bound is measured on the shape each subscriber receives (lane H1d). ─────────────
// A reference-mode subscriber receives an oversized diff as a small `diffRef`, so the frame must
// not be cut at that row for it; a subscriber that receives rows unchanged must still get a frame
// within its bound. One frame serves both, so it is measured on the larger shape.
{
  const lockfile = Array.from({ length: 50_000 }, (_, i) => `+dependency ${i} 1.0.${i}`).join('\n');
  const history: AgentMessage[] = Array.from({ length: 100 }, (_, i) => (i === 50
    ? ({ type: 'tool-result', callId: 'lock', toolName: 'edit', diff: lockfile }) as AgentMessage
    : row(`r${i}`, `row ${i}`)));
  // The real egress rule with a stand-in store: the reference is what a reference-mode socket sends.
  const reference = (message: AgentMessage): AgentMessage => message.type === 'tool-result'
    ? buildDiffRefMessage(message, 32 * 1024, (body) => ({
      fetchUrl: '/api/sessions/claude/s1/artifact/diff?expires=1&sig=x',
      contentHash: 'h'.repeat(64),
      byteSize: body.length,
    }))
    : message;
  check(
    'the fixture diff alone exceeds the frame budget in its stored shape',
    estimatedClientDecodedBytes(history[50]) > HISTORY_FRAME_MAX_DECODED_BYTES
      && estimatedClientDecodedBytes(reference(history[50]!)) < 4_096,
  );
  const referenceOnly = harness({ identity: SOURCE, egresses: [reference] });
  referenceOnly.historyQueue.push(async () => history);
  referenceOnly.emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  const referenceFrame = referenceOnly.frames.find((f) => f.kind === 'history');
  check(
    'a reference-mode subscriber gets the whole count-bounded frame across the referenced diff',
    referenceFrame?.messages?.length === 100 && !referenceFrame?.truncated,
    `messages=${referenceFrame?.messages?.length}`,
  );

  const mixed = harness({ identity: SOURCE, egresses: [reference, null] });
  mixed.historyQueue.push(async () => history);
  mixed.emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  const mixedFrame = mixed.clientFrames[1]!.find((f) => f.kind === 'history');
  const mixedBytes = (mixedFrame?.messages ?? []).reduce(
    (sum: number, message: unknown) => sum + estimatedClientDecodedBytes(message),
    0,
  );
  check(
    'a subscriber receiving rows unchanged still gets a frame within the bound',
    mixedFrame?.messages?.length === 49 && mixedBytes <= HISTORY_FRAME_MAX_DECODED_BYTES,
    `messages=${mixedFrame?.messages?.length} bytes=${mixedBytes}`,
  );
}

// ── 13. A raced keyless row the byte-trimmed frame leaves behind its start is not replayed. ──────
// It persisted inside the snapshot, before the frame's tail start, so the frame's older boundary
// already reaches it. Replaying it live would append it after the frame, out of order, and the
// client would show it a second time once it pages back.
{
  const { managed, frames, emit, historyQueue } = harness({ identity: SOURCE });
  let release!: (m: AgentMessage[]) => void;
  const boom = { type: 'error', message: 'boom' } as AgentMessage;
  const wide = Array.from({ length: 80 }, (_, i) => row(`t${i}`, 'z'.repeat(40_000)));
  managed.acceptResyncHistoryCursor(historyDelta([row('m0', 'zero')]).cursor);
  historyQueue.push(() => new Promise<AgentMessage[]>((r) => { release = r; }));
  historyQueue.push(async () => [row('m0', 'zero'), boom, ...wide]);
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  emit(boom); // raced; it persisted before the wide rows
  release([row('m0', 'zero'), boom, ...wide]);
  await flush();

  const historyAt = frames.findIndex((f) => f.kind === 'history');
  const frame = frames[historyAt];
  const after = frames.slice(historyAt + 1).filter((f) => f.kind === 'message' && f.message?.message === 'boom');
  const reachable = backwardHistoryPage([row('m0', 'zero'), boom, ...wide], frame?.olderCursor, 100);
  check(
    'a raced keyless row behind a byte-trimmed frame start is not replayed',
    frame?.truncated !== undefined
      && !frame.messages.some((message: any) => message.message === 'boom')
      && reachable.messages.some((message: any) => message.message === 'boom')
      && after.length === 0,
    `post-reset occurrences=${after.length}`,
  );
}

// ── 14. ...but only where that older boundary pages for every subscriber. ────────────────────────
// Without a source identity the paging route refuses the boundary, and a subscriber that already
// knows paging is refused for it cannot page there either: for them the row behind the frame is not
// reachable, so the replay still delivers it.
const replayCases: Array<[string, Parameters<typeof harness>[0]]> = [
  ['an unversioned source', {}],
  ['a subscriber paging has refused', { identity: SOURCE, egresses: [null, null], pagingRefused: [false, true] }],
];
for (const [label, options] of replayCases) {
  const { managed, frames, emit, historyQueue } = harness(options);
  let release!: (m: AgentMessage[]) => void;
  const boom = { type: 'error', message: 'boom' } as AgentMessage;
  const wide = Array.from({ length: 80 }, (_, i) => row(`t${i}`, 'z'.repeat(40_000)));
  managed.acceptResyncHistoryCursor(historyDelta([row('m0', 'zero')]).cursor);
  historyQueue.push(() => new Promise<AgentMessage[]>((r) => { release = r; }));
  historyQueue.push(async () => [row('m0', 'zero'), boom, ...wide]);
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  emit(boom);
  release([row('m0', 'zero'), boom, ...wide]);
  await flush();

  const historyAt = frames.findIndex((f) => f.kind === 'history');
  const frame = frames[historyAt];
  const after = frames.slice(historyAt + 1).filter((f) => f.kind === 'message' && f.message?.message === 'boom');
  check(
    `a raced keyless row behind a trimmed frame is replayed for ${label}`,
    frame?.truncated !== undefined
      && !frame.messages.some((message: any) => message.message === 'boom')
      && after.length === 1,
    `post-reset occurrences=${after.length}`,
  );
}

// ── 15. A resync while a turn runs ends its frame at the running-turn hold. ─────────────────────
// The newest text row, the tool calls just before it, and any call still waiting for its result may
// still be rewritten by the turn: a cursor over them would diverge on the next read. They follow the
// frame instead, before the overlays.
{
  const { managed, frames, emit, historyQueue } = harness({ identity: SOURCE });
  const finished = [row('m0', 'zero'), { type: 'user-message', key: 'u1', text: 'go' } as AgentMessage];
  const streaming = row('m1', 'still wri');
  const call = { type: 'tool-call', callId: 'c1', toolName: 'bash', args: {} } as AgentMessage;
  const summary = { type: 'run-summary', key: 'run:1', turnId: 't1', status: 'running' } as AgentMessage;
  emit({ type: 'status', status: 'running' } as AgentMessage);
  await flush();
  check('the connection reports the turn running', managed.turnInFlight());
  historyQueue.push(async () => [...finished, call, streaming, summary]);
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  const frameAt = frames.findIndex((f) => f.kind === 'history');
  const frame = frames[frameAt];
  check('a resync frame while a turn runs stops before the streaming text and the call before it',
    frame?.reset === true
      && JSON.stringify(frame.messages?.map((m: any) => m.key ?? m.type)) === JSON.stringify(['m0', 'u1'])
      && frame.cursor === historyDelta(finished).cursor,
    JSON.stringify(frame?.messages?.map((m: any) => m.key ?? m.type)));
  const after = frames.slice(frameAt + 1).filter((f) => f.kind === 'message').map((f) => f.message?.key ?? f.message?.type);
  check('the held rows follow the frame in order, before the overlays',
    JSON.stringify(after.slice(0, 3)) === JSON.stringify(['tool-call', 'm1', 'run:1']),
    JSON.stringify(after));
  // Once the turn is over the same rows are final, and the next resync frame covers them.
  emit({ type: 'status', status: 'idle' } as AgentMessage);
  await flush();
  const done = row('m1', 'still writing, now done');
  historyQueue.push(async () => [...finished, call, done]);
  emit({ type: 'history-reset' } as AgentMessage);
  await flush();
  const frames2 = frames.filter((f) => f.kind === 'history');
  const idleFrame = frames2.at(-1);
  check('an idle resync frame covers every durable row',
    frames2.length === 2 && idleFrame?.cursor === historyDelta([...finished, call, done]).cursor,
    JSON.stringify(idleFrame?.messages?.map((m: any) => m.key ?? m.type)));
}

console.log(`\n${failures ? `${failures} FAILED` : 'resync-serialization regression: all checks passed.'}`);
process.exit(failures ? 1 : 0);
