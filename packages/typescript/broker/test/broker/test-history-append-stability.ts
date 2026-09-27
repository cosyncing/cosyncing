#!/usr/bin/env bun
/**
 * Append stability, per adapter: the cursors one read of a session's history issued must still
 * resolve on the adapter's next read, when the session only moved forward — a prompt was sent, a
 * turn continued or ended, a pending request was answered.
 *
 * Adapters append their CURRENT state after the transcript they read (a running run summary, a
 * token reading, recomputed totals, a pending permission card, a prompt not yet delivered) and
 * restate, move or drop it on the next read. A cursor that counted those rows broke on every
 * append, so a client could neither reconnect incrementally nor page from where its frame ended.
 *
 * Every adapter here runs its real history code over fixtures shaped like its native store:
 * OpenCode's HTTP API, a Claude transcript, a Codex rollout, the grok, Reasonix and Cline stores
 * with their ACP drives, Kilo's SQLite store and the HTTP connection its live attaches use, Pi's
 * and omp's JSONL session files, Kimi's REST history, dsh's event log, and Antigravity's
 * transcript, inbox and drive. For each step t -> t+1 the suite checks, on every read path the
 * broker serves:
 *   - reconnect, refresh, a backward page and a newer page from t's cursors succeed on t+1, over
 *     the whole-array history, the encoded page cache, and (where the adapter captures) the
 *     indexed cache and the bounded-tail replay;
 *   - the whole-array and captured paths issue the same cursors for the same read;
 *   - the rule this replaced (every durable row counts) is recorded per step, and a step expected
 *     to have broken under it is checked to have done so, so no case passes vacuously.
 * A parallel step whose tools finish in either order (Kilo's store and HTTP API, OpenCode's adapter)
 * also checks every count bound a refresh or newer page can cut it with: each stops at the
 * running-turn hold, and resolves on the next read.
 *
 *   bun run packages/typescript/broker/test/broker/test-history-append-stability.ts
 */
export {};

import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, HistorySourceIdentity, SessionConnection, SessionInfo } from '../../../adapter-api/src/index.ts';
import { isHistorySnapshotRefusal } from '../../../adapter-api/src/index.ts';
import { OpenCodeAdapter } from '../../../adapters/opencode/src/index.ts';
import { ClaudeResumeConnection } from '../../../adapters/claude/src/index.ts';
import { GrokObserveConnection } from '../../../adapters/grok/src/observe.ts';
import { GrokDriveConnection, type GrokAcpTransport } from '../../../adapters/grok/src/drive.ts';
import { discoverGrokStore } from '../../../adapters/grok/src/store.ts';
import { buildGrokFixtureTree, fixtureUpdates } from '../../../adapters/grok/test/fixtures/tree.ts';
import { ReasonixObserveConnection } from '../../../adapters/reasonix/src/observe.ts';
import { ReasonixDriveConnection, type ReasonixAcpTransport } from '../../../adapters/reasonix/src/drive.ts';
import { discoverReasonixStore } from '../../../adapters/reasonix/src/store.ts';
import { buildReasonixFixtureTree } from '../../../adapters/reasonix/test/fixtures/tree.ts';
import { ClineObserveConnection } from '../../../adapters/cline/src/observe.ts';
import { ClineHubDriveConnection } from '../../../adapters/cline/src/hub-drive.ts';
import { discoverClineStore } from '../../../adapters/cline/src/store.ts';
import { buildClineFixtureTree, CLINE_FIXTURE_ID as CLINE_HUB_SESSION, fixtureParentMessages } from '../../../adapters/cline/test/fixtures/tree.ts';
import { KiloObserveConnection } from '../../../adapters/kilocode/src/observe.ts';
import { discoverKiloStore } from '../../../adapters/kilocode/src/store.ts';
import { buildKiloFixtureTree, KILO_FIXTURE_SESSION_ID } from '../../../adapters/kilocode/test/fixtures/database.ts';
import { OpenCodeLiveConnection } from '../../../opencode-wire/src/live.ts';
import { KimiAdapter } from '../../../adapters/kimi/src/index.ts';
import { decodeKimiInstanceRecord, type KimiInstanceScan } from '../../../adapters/kimi/src/server.ts';
import { DshRpcClient, type DshFetch } from '../../../adapters/dsh/src/server.ts';
import { DshSessionConnection } from '../../../adapters/dsh/src/observe.ts';
import { AgyObserveConnection } from '../../../adapters/antigravity/src/observe.ts';
import { AgyDriveConnection } from '../../../adapters/antigravity/src/drive.ts';
import {
  buildAgyFixtureTree,
  FIXTURE as AGY_FIXTURE,
  jsonl as agyJsonl,
  writeFakeAgyBinary,
  type AgyFixtureTree,
} from '../../../adapters/antigravity/test/fixtures/tree.ts';
import {
  backwardHistoryCursorBoundary,
  backwardHistoryPage,
  cursorDurableHistory,
  forwardHistoryPage,
  historyDelta,
  historyCursorParts,
  historyRefresh,
  holdRunningTurn,
  isBackwardPageMessage,
  isCursorDurableMessage,
} from '../../src/sessions/history-delta.ts';
import {
  isolatedBrokerFixtureEnvironment,
  startHealthyFixtureBroker,
} from '../helpers/isolated-broker-fixture.ts';
import {
  BoundedTailHistoryReplay,
  BoundedTailHistorySnapshotSink,
  EncodedHistoryPageCache,
  IndexedHistoryPageCache,
  IndexedHistoryPageCacheBuilder,
} from '../../src/sessions/history-page-cache.ts';

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const describe = (message: AgentMessage) => {
  const row = message as { type: string; key?: string; status?: string; queued?: boolean; requestId?: string };
  return `${row.type}${row.key ? `:${row.key}` : ''}${row.requestId ? `:${row.requestId}` : ''}`
    + `${row.status ? `(${row.status})` : ''}${row.queued ? '[queued]' : ''}`;
};
const shape = (history: readonly AgentMessage[]) => history.map(describe).join(' | ');
const OPENING = historyDelta([]).cursor;
const OPENING_OLDER = historyDelta([]).endCursor;
const FIXED_SOURCE: HistorySourceIdentity = { sourceId: 'append-stability', revision: 'fixed' };

type Gapped = { gap?: { code: string } } | { kind: string };
const refusal = (value: unknown): string | undefined => {
  const result = value as Gapped;
  if ('kind' in result) return result.kind;
  return result.gap?.code;
};

/** One adapter read, with the cursors every broker path names for it. */
interface Read {
  label: string;
  history: AgentMessage[];
  durable: AgentMessage[];
  running: boolean;
  indexed?: IndexedHistoryPageCache;
  tail?: BoundedTailHistoryReplay;
  /** The attach frame's end: what a client that attached now holds. While a turn runs it is the
   *  running-turn hold, as every broker frame names it. */
  attach: { reconnect: string; older: string };
  /** The attach end without the running-turn hold, over every durable row. */
  unheldAttach: string;
  /** A refresh from the opening cursor: what a client that refreshed now holds. */
  refresh: { reconnect: string; older: string };
  /** The same attach end under the replaced rule, where every durable row counted. */
  previousRule: string;
}

async function read(
  label: string,
  connection: Pick<SessionConnection, 'getHistory' | 'captureHistorySnapshot'>,
  running: boolean,
): Promise<Read> {
  const history = await connection.getHistory();
  const { durable, derived: overlays } = cursorDurableHistory(history);
  // The attach frame, as the broker builds it: while a turn runs it ends at the running-turn hold,
  // and the held rows follow it with the rest kept out of the cursor space.
  const { framed, held } = running ? holdRunningTurn(durable) : { framed: durable, held: [] as AgentMessage[] };
  const derived = [...held, ...overlays];
  const attach = historyDelta(framed);
  const refreshed = historyRefresh(durable, OPENING, { max: 500, holdTrailingText: running });
  if ('gap' in refreshed) throw new Error(`${label}: a refresh from the opening cursor was refused`);
  // A newer page to the end of the history, while a turn runs, stops where the attach does: the
  // rows after that may still be rewritten.
  const wholeNewer = forwardHistoryPage(durable, OPENING_OLDER, 500, undefined, { holdTrailingText: running });
  const encodedNewer = EncodedHistoryPageCache.create(FIXED_SOURCE, durable)?.pageNewer(OPENING_OLDER, 500, undefined, { holdTrailingText: running });
  check(`${label}: a newer page to the end stops where the attach does`,
    !wholeNewer.gap && wholeNewer.cursor === attach.endCursor
      && encodedNewer !== undefined && !encodedNewer.gap && encodedNewer.cursor === attach.endCursor,
    `${wholeNewer.gap?.code ?? ''} ${encodedNewer?.gap?.code ?? ''} ${shape(history)}`);
  const out: Read = {
    label,
    history,
    durable,
    running,
    attach: { reconnect: attach.cursor, older: attach.endCursor },
    unheldAttach: historyDelta(durable).cursor,
    refresh: { reconnect: refreshed.cursor, older: refreshed.endCursor },
    previousRule: historyDelta(history.filter(isCursorDurableMessage)).cursor,
  };
  if (typeof connection.captureHistorySnapshot === 'function') {
    const builder = new IndexedHistoryPageCacheBuilder();
    const captured = await connection.captureHistorySnapshot(builder, {});
    if (!captured || isHistorySnapshotRefusal(captured)) throw new Error(`${label}: the indexed capture failed`);
    const indexed = builder.finish(captured.identity, captured.reader);
    if (!indexed) throw new Error(`${label}: the indexed capture exceeded its budget`);
    out.indexed = indexed;
    // The captured paths must name the same boundaries the whole-array history does. They are
    // resolved now, while the capture is still the adapter's current source.
    const indexedAttach = await indexed.loadAttach(undefined, 500, undefined, Number.POSITIVE_INFINITY, undefined, running);
    check(`${label}: the indexed attach ends where the whole-array attach does`,
      !('kind' in indexedAttach) && indexedAttach.cursor === attach.cursor && indexedAttach.endCursor === attach.endCursor,
      'kind' in indexedAttach ? indexedAttach.kind : shape(history));
    const indexedRefresh = await indexed.loadRefresh(OPENING, { max: 500, holdTrailingText: running });
    check(`${label}: the indexed refresh ends where the whole-array refresh does`,
      !('kind' in indexedRefresh) && !('gap' in indexedRefresh) && indexedRefresh.cursor === refreshed.cursor,
      JSON.stringify(indexedRefresh).slice(0, 200));
    // A newer page to the end of the history, while a turn runs, stops where the attach does.
    const indexedNewer = await indexed.loadNewerPage(OPENING_OLDER, 500, undefined, {}, { holdTrailingText: running });
    check(`${label}: the indexed newer page to the end stops where the attach does`,
      refusal(indexedNewer) === undefined && !('kind' in indexedNewer) && indexedNewer.cursor === attach.endCursor,
      refusal(indexedNewer) ?? shape(history));
    const sink = new BoundedTailHistorySnapshotSink();
    const tailCapture = await connection.captureHistorySnapshot(sink, {});
    if (!tailCapture || isHistorySnapshotRefusal(tailCapture)) throw new Error(`${label}: the bounded-tail capture failed`);
    out.tail = sink.finish(tailCapture.identity);
    const tailAttach = out.tail.attach(undefined, 500, running);
    check(`${label}: the bounded-tail replay ends where the whole-array attach does`,
      tailAttach.cursor === attach.cursor, shape(history));
    // The rows kept out of the cursor space, and the rows the running-turn hold kept out of the
    // frame, still reach the client, after the frame. A drive's undelivered prompts are the
    // exception: they are not in the capture, and replay from the drive's pending set instead.
    const held = derived
      .filter((message) => isCursorDurableMessage(message))
      .filter((message) => !(message.type === 'user-message' && message.queued === true))
      .map((message) => JSON.stringify(message));
    const indexedDerived = 'kind' in indexedAttach ? [] : indexedAttach.derivedMessages.map((message) => JSON.stringify(message));
    const tailDerived = tailAttach.derivedMessages.map((message) => JSON.stringify(message));
    check(`${label}: the captured paths send the trailing pending/running rows after the frame`,
      held.every((row) => indexedDerived.includes(row) && tailDerived.includes(row)),
      `held ${held.length}; indexed ${indexedDerived.length}; tail ${tailDerived.length}`);
  }
  return out;
}

/** Every path a client may take from [cursor] (named on an earlier read) must work on [next]. */
async function expectResolves(
  label: string,
  cursor: { reconnect: string; older: string },
  next: Read,
): Promise<void> {
  const reconnect = historyDelta(next.durable, cursor.reconnect);
  check(`${label}: reconnect is incremental`, !reconnect.gap && !reconnect.reset,
    `${reconnect.gap?.code ?? 'reset'}; t+1 = ${shape(next.history)}`);
  const refresh = historyRefresh(next.durable, cursor.reconnect, { max: 500, holdTrailingText: next.running });
  check(`${label}: refresh is served`, !('gap' in refresh), refusal(refresh));
  const older = backwardHistoryPage(next.durable, cursor.older, 100);
  check(`${label}: a backward page is served`, !older.gap, older.gap?.code);
  const newer = forwardHistoryPage(next.durable, cursor.older, 500);
  const expectedNewer = reconnect.gap ? [] : reconnect.messages.filter(isBackwardPageMessage);
  check(`${label}: a newer page is served and holds exactly the appended rows`,
    !newer.gap && JSON.stringify(newer.messages) === JSON.stringify(expectedNewer), newer.gap?.code);
  const encoded = EncodedHistoryPageCache.create(FIXED_SOURCE, next.durable);
  if (!encoded) throw new Error(`${label}: the encoded cache exceeded its budget`);
  check(`${label}: the encoded cache serves both page directions`,
    !encoded.page(cursor.older, 100).gap && !encoded.pageNewer(cursor.older, 500).gap);
  if (next.indexed) {
    const attach = await next.indexed.loadAttach(cursor.reconnect, 500);
    check(`${label}: the indexed reconnect is incremental`,
      !('kind' in attach) && !attach.gap && !attach.reset, refusal(attach) ?? 'reset');
    const indexedRefresh = await next.indexed.loadRefresh(cursor.reconnect, { max: 500, holdTrailingText: next.running });
    check(`${label}: the indexed refresh is served`, refusal(indexedRefresh) === undefined, refusal(indexedRefresh));
    const page = await next.indexed.loadPage(cursor.older, 100);
    check(`${label}: the indexed backward page is served`, refusal(page) === undefined, refusal(page));
    const newerPage = await next.indexed.loadNewerPage(cursor.older, 500);
    check(`${label}: the indexed newer page is served`, refusal(newerPage) === undefined, refusal(newerPage));
  }
  if (next.tail) {
    const attach = next.tail.attach(cursor.reconnect, 500);
    check(`${label}: the bounded-tail reconnect is incremental`, !attach.gap && !attach.reset,
      attach.gap?.code ?? 'reset');
  }
}

const previousRuleBreaks: string[] = [];

/**
 * One step t -> t+1. [previousRule] states whether the replaced rule kept t's attach cursor: a
 * step expected to break it must break it, or the step proves nothing. [holdNeeded] is set where
 * the newest row at t was still being written (streamed text, a running tool): an attach end over
 * that row would not survive its rewrite, so this checks that the unheld end breaks and that the
 * held end every broker frame names does not.
 */
async function step(
  prev: Read,
  next: Read,
  options: { previousRule: 'breaks' | 'holds'; holdNeeded?: boolean },
): Promise<void> {
  const label = `${prev.label} -> ${next.label}`;
  const kept = !historyDelta(next.history.filter(isCursorDurableMessage), prev.previousRule).reset;
  if (!kept) previousRuleBreaks.push(label);
  check(`${label}: the replaced rule ${options.previousRule === 'breaks' ? 'broke' : 'kept'} this step`,
    kept === (options.previousRule === 'holds'),
    `t = ${shape(prev.history)}; t+1 = ${shape(next.history)}`);
  if (options.holdNeeded) {
    const reconnect = historyDelta(next.durable, prev.unheldAttach);
    check(`${label}: the unheld mid-turn attach end was rewritten (the hold is needed)`,
      reconnect.gap?.code === 'HISTORY_CURSOR_DIVERGED', reconnect.gap?.code ?? 'kept');
  }
  await expectResolves(`${label} (attach end)`, prev.attach, next);
  await expectResolves(`${label} (refresh end)`, prev.refresh, next);
  await expectResolves(`${label} (opening)`, { reconnect: OPENING, older: OPENING_OLDER }, next);
}

const roots: string[] = [];
const temporaryRoot = (prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

// ── OpenCode: the real HTTP adapter against a fake server ─────────────────────────────────────
type OpenCodeRow = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

/** An OpenCode server for one session: its messages, run status and pending permissions. */
function fakeOpenCode(worktree: string) {
  const session = { id: 'ses_append', slug: 'append', directory: worktree, title: 'append', time: { created: 1, updated: 2 } };
  let rows: OpenCodeRow[] = [];
  let busy = false;
  let writing = false;
  let readDelayMs = 0;
  let permissions: unknown[] = [];
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let server: ReturnType<typeof Bun.serve> | undefined;
  for (let attempt = 0; attempt < 20 && !server; attempt += 1) {
    try {
      server = Bun.serve({
        hostname: '127.0.0.1',
        port: 40_000 + Math.floor(Math.random() * 20_000),
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === '/global/event' || url.pathname === '/event') {
            let own: ReadableStreamDefaultController<Uint8Array> | undefined;
            return new Response(new ReadableStream<Uint8Array>({
              start(controller) {
                own = controller;
                streams.add(controller);
                controller.enqueue(new TextEncoder().encode(': connected\n\n'));
              },
              cancel() { if (own) streams.delete(own); },
            }), { headers: { 'content-type': 'text/event-stream' } });
          }
          if (url.pathname === '/project') return Response.json([{ worktree }]);
          if (url.pathname === '/session' && request.method === 'GET') return Response.json([session]);
          if (url.pathname === '/session/status') return Response.json(busy ? { [session.id]: { type: 'busy' } } : {});
          if (url.pathname === `/session/${session.id}/message`) {
            // A session still writing moves on while it is read.
            if (writing) session.time.updated += 1;
            const answer = rows;
            if (readDelayMs > 0) await Bun.sleep(readDelayMs);
            return Response.json(answer);
          }
          if (url.pathname === `/session/${session.id}`) return Response.json(session);
          if (url.pathname === '/permission') return Response.json(permissions);
          if (url.pathname === '/question') return Response.json([]);
          return new Response('not found', { status: 404 });
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'EADDRINUSE') throw error;
    }
  }
  if (!server) throw new Error('no port for the fake OpenCode server');
  const running = server;
  return {
    session,
    url: `http://127.0.0.1:${running.port}`,
    /** Replace the transcript and move `time.updated`, as a write that bumps the session does. */
    setRows(next: OpenCodeRow[]) {
      rows = next;
      session.time.updated += 1;
    },
    /**
     * Replace the transcript WITHOUT moving `time.updated`. Real OpenCode moves the session's
     * `time.updated` only every few writes (up to dozens of part and message writes go by between
     * two moves), so a write is usually invisible to the session revision.
     */
    setRowsQuietly(next: OpenCodeRow[]) {
      rows = next;
    },
    /** Deliver one event on the event bus, as OpenCode does for every write. */
    emit(type: string, properties: Record<string, unknown>) {
      const frame = new TextEncoder().encode(`data: ${JSON.stringify({ payload: { type, properties } })}\n\n`);
      for (const controller of streams) {
        try { controller.enqueue(frame); } catch { streams.delete(controller); }
      }
    },
    setPermissions(next: unknown[]) { permissions = next; },
    /** Revert the session to before [messageID], as OpenCode records a revert on the session. */
    setRevert(messageID: string) { (session as { revert?: { messageID: string } }).revert = { messageID }; },
    /** While set, every transcript read observes a newer revision than the one before it. */
    setWriting(next: boolean) { writing = next; },
    /** A slow transcript read, so that requests arriving together overlap it. */
    setReadDelay(ms: number) { readDelayMs = ms; },
    /** Set the run status, and tell subscribers as OpenCode's event bus does. */
    setBusy(next: boolean) {
      busy = next;
      const event = { payload: { type: 'session.status', properties: { sessionID: session.id, status: { type: next ? 'busy' : 'idle' } } } };
      const frame = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
      for (const controller of streams) {
        try { controller.enqueue(frame); } catch { streams.delete(controller); }
      }
    },
    stop() { running.stop(true); },
  };
}

const zeroTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
const openCodeUser = (id: string, created: number, text: string): OpenCodeRow => ({
  info: { id, role: 'user', time: { created } },
  parts: [{ id: `prt_${id}`, type: 'text', text }],
});
const openCodeAssistant = (
  id: string,
  parent: string,
  created: number,
  parts: Array<Record<string, unknown>>,
  completed?: number,
): OpenCodeRow => ({
  info: {
    id,
    role: 'assistant',
    parentID: parent,
    time: completed ? { created, completed } : { created },
    ...(completed ? { finish: 'stop' } : {}),
    tokens: completed ? { ...zeroTokens, input: 10, output: 5 } : zeroTokens,
    cost: completed ? 0.01 : 0,
  },
  parts,
});
/** A text part; one without an end time is still streaming. */
const openCodeText = (id: string, body: string, start: number, end?: number, type = 'text') => ({
  id, type, text: body, time: end ? { start, end } : { start },
});
const openCodeTool = (id: string, callID: string, status: 'running' | 'completed', command: string) => ({
  id,
  type: 'tool',
  tool: 'bash',
  callID,
  state: status === 'completed'
    ? { status, input: { command }, output: 'ok', title: command, metadata: { exit: 0, output: 'ok' }, time: { start: 1, end: 2 } }
    : { status, input: { command }, time: { start: 1 } },
});
/** A step of an OpenCode turn: one assistant message, closed with `finish` when the step ends. */
const openCodeStep = (
  id: string,
  parent: string,
  created: number,
  parts: Array<Record<string, unknown>>,
  done?: { at: number; finish: 'tool-calls' | 'stop' },
): OpenCodeRow => ({
  info: {
    id,
    role: 'assistant',
    parentID: parent,
    time: done ? { created, completed: done.at } : { created },
    ...(done ? { finish: done.finish } : {}),
    tokens: done ? { ...zeroTokens, input: 10, output: 5 } : zeroTokens,
    cost: done ? 0.01 : 0,
  },
  parts,
});
const openCodeFirstTurn = (): OpenCodeRow[] => [
  openCodeUser('msg_u1', 1_000, 'first'),
  openCodeAssistant('msg_a1', 'msg_u1', 2_000, [openCodeText('prt_a1', 'answer one', 2_000, 2_400)], 2_500),
];

async function openCode(): Promise<void> {
  const directory = temporaryRoot('cosyncing-append-opencode-');
  const worktree = join(directory, 'worktree');
  const storage = join(directory, 'data');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(storage, 'storage', 'session'), { recursive: true });
  const fake = fakeOpenCode(worktree);
  const user = openCodeUser;
  const assistant = openCodeAssistant;
  const text = openCodeText;
  const tool = openCodeTool;
  const firstTurn = openCodeFirstTurn();
  try {
    const adapter = new OpenCodeAdapter({ baseUrl: fake.url, storageDir: storage, sseIdleMs: 30_000 });
    fake.setRows(firstTurn);
    const connection = await adapter.attach(fake.session.id, 'live');
    const stop = connection.subscribe(() => {});
    await sleep(100);

    const idle = await read('opencode idle', connection, false);
    fake.setRows([...firstTurn, user('msg_u2', 3_000, 'second')]);
    fake.setBusy(true);
    const prompted = await read('opencode one prompt', connection, true);
    await step(idle, prompted, { previousRule: 'breaks' });

    fake.setRows([...firstTurn, user('msg_u2', 3_000, 'second'),
      assistant('msg_a2', 'msg_u2', 4_000, [text('prt_a2', 'Hello wor', 4_000)])]);
    const streaming = await read('opencode text streaming', connection, true);
    await step(prompted, streaming, { previousRule: 'breaks' });

    fake.setRows([...firstTurn, user('msg_u2', 3_000, 'second'),
      assistant('msg_a2', 'msg_u2', 4_000, [
        text('prt_a2', 'Hello world, and more', 4_000, 4_500),
        tool('prt_t1', 'call_1', 'running', 'ls'),
      ])]);
    const toolRunning = await read('opencode tool running', connection, true);
    await step(streaming, toolRunning, { previousRule: 'breaks', holdNeeded: true });

    fake.setRows([...firstTurn, user('msg_u2', 3_000, 'second'),
      assistant('msg_a2', 'msg_u2', 4_000, [
        text('prt_a2', 'Hello world, and more', 4_000, 4_500),
        tool('prt_t1', 'call_1', 'completed', 'ls'),
        tool('prt_t2', 'call_2', 'running', 'rm scratch'),
      ])]);
    fake.setPermissions([{ id: 'per_1', sessionID: fake.session.id, permission: 'bash', patterns: ['rm scratch'] }]);
    const permission = await read('opencode permission pending', connection, true);
    // OpenCode rewrites a tool's one part as it finishes. History keeps the call beside its result,
    // so the finished tool appends a row instead of replacing one, and even an unheld end over the
    // running call survives it.
    await step(toolRunning, permission, { previousRule: 'breaks' });
    check('opencode: a finished tool keeps its call, and the result follows it',
      shape(permission.durable).includes('tool-call | tool-result'), shape(permission.durable));
    check('opencode: the end over a running call, without the hold, survives the tool finishing',
      !historyDelta(permission.durable, toolRunning.unheldAttach).gap, shape(permission.durable));

    fake.setRows([...firstTurn, user('msg_u2', 3_000, 'second'),
      assistant('msg_a2', 'msg_u2', 4_000, [
        text('prt_a2', 'Hello world, and more', 4_000, 4_500),
        tool('prt_t1', 'call_1', 'completed', 'ls'),
        tool('prt_t2', 'call_2', 'completed', 'rm scratch'),
        text('prt_a3', 'Done.', 5_000, 5_100),
      ], 5_200)]);
    fake.setPermissions([]);
    fake.setBusy(false);
    const resolved = await read('opencode permission resolved, turn ended', connection, false);
    await step(permission, resolved, { previousRule: 'breaks' });

    stop();
    await connection.close();
  } finally {
    fake.stop();
  }
}

// ── OpenCode: a turn of several steps, observed live ─────────────────────────────────────────
// OpenCode writes one assistant message per step, and a step that called tools ends with
// `finish: tool-calls` while the turn goes on. Each step's run summary stays `running` until the
// whole turn goes idle, when every one is rewritten in place as `done` with its completion time.
// Most writes do not move the session's `time.updated`, and every one arrives on the event bus.
async function openCodeMultiStep(): Promise<void> {
  const directory = temporaryRoot('cosyncing-append-opencode-steps-');
  const worktree = join(directory, 'worktree');
  const storage = join(directory, 'data');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(storage, 'storage', 'session'), { recursive: true });
  const fake = fakeOpenCode(worktree);
  const sessionID = fake.session.id;
  const text = openCodeText;
  const tool = openCodeTool;
  const first = openCodeFirstTurn();
  const update = (row: OpenCodeRow) => fake.emit('message.updated', { sessionID, info: { ...row.info, sessionID } });
  try {
    const adapter = new OpenCodeAdapter({ baseUrl: fake.url, storageDir: storage, sseIdleMs: 30_000 });
    fake.setRows(first);
    const connection = await adapter.attach(sessionID, 'live');
    const stop = connection.subscribe(() => {});
    await sleep(100);
    const idle = await read('opencode steps idle', connection, false);

    const prompt = openCodeUser('msg_u2', 3_000, 'look around');
    fake.setBusy(true);
    update(prompt);
    fake.setRowsQuietly([...first, prompt]);
    await sleep(50);
    const prompted = await read('opencode steps prompted', connection, true);
    await step(idle, prompted, { previousRule: 'breaks' });

    const stepOne = openCodeStep('msg_s1', 'msg_u2', 4_000, [
      text('prt_s1', 'Let me look.', 4_000, 4_100),
      tool('prt_t1', 'call_1', 'completed', 'ls'),
    ], { at: 4_500, finish: 'tool-calls' });
    const stepTwo = openCodeStep('msg_s2', 'msg_u2', 5_000, [text('prt_s2', 'The directory', 5_000)]);
    update(stepOne);
    update(stepTwo);
    fake.setRowsQuietly([...first, prompt, stepOne, stepTwo]);
    await sleep(50);
    const second = await read('opencode step two streaming', connection, true);
    await step(prompted, second, { previousRule: 'breaks' });

    const stepTwoDone = openCodeStep('msg_s2', 'msg_u2', 5_000, [
      text('prt_s2', 'The directory has one file.', 5_000, 5_200),
      tool('prt_t2', 'call_2', 'completed', 'cat a'),
    ], { at: 5_500, finish: 'tool-calls' });
    const stepThree = openCodeStep('msg_s3', 'msg_u2', 6_000, [tool('prt_t3', 'call_3', 'running', 'wc a')]);
    update(stepTwoDone);
    update(stepThree);
    fake.setRowsQuietly([...first, prompt, stepOne, stepTwoDone, stepThree]);
    await sleep(50);
    const third = await read('opencode step three tool running', connection, true);
    await step(second, third, { previousRule: 'breaks', holdNeeded: true });

    const stepThreeDone = openCodeStep('msg_s3', 'msg_u2', 6_000, [
      tool('prt_t3', 'call_3', 'completed', 'wc a'),
      text('prt_s3', 'It has three lines.', 6_200, 6_300),
    ], { at: 6_400, finish: 'stop' });
    update(stepThreeDone);
    fake.setRows([...first, prompt, stepOne, stepTwoDone, stepThreeDone]);
    fake.setBusy(false);
    await sleep(100);
    const ended = await read('opencode steps turn ended', connection, false);
    await step(third, ended, { previousRule: 'breaks' });

    // Every boundary a client could hold from the middle of the turn still resolves after it.
    for (const mid of [prompted, second, third]) {
      await expectResolves(`${mid.label} -> ${ended.label} (attach end)`, mid.attach, ended);
      await expectResolves(`${mid.label} -> ${ended.label} (refresh end)`, mid.refresh, ended);
    }
    // ... although the turn rewrote a row before those boundaries: each finished step's summary
    // was still `running` and became `done` in place when the turn ended.
    const summaryAt = (at: Read, key: string) => at.durable.findIndex((message) =>
      message.type === 'run-summary' && message.key === key);
    for (const key of ['opencode:run:msg_s1', 'opencode:run:msg_s2']) {
      const mid = summaryAt(third, key);
      const end = summaryAt(ended, key);
      const midRow = third.durable[mid] as { status?: string } | undefined;
      const endRow = ended.durable[end] as { status?: string; completedAt?: number } | undefined;
      check(`opencode steps: ${key} is cursor-durable and running mid-turn`,
        mid >= 0 && midRow?.status === 'running', shape(third.durable));
      check(`opencode steps: the turn ending rewrites ${key} in place as done`,
        end === mid && endRow?.status === 'done' && endRow.completedAt !== undefined, shape(ended.durable));
      check(`opencode steps: the mid-turn attach end lies after ${key}`,
        (historyCursorParts(third.attach.reconnect)?.boundary ?? -1) > mid);
    }
    check('opencode steps: the turn had more than one step',
      ended.durable.filter((message) => message.type === 'run-summary' && message.key?.startsWith('opencode:run:msg_s')).length === 3,
      shape(ended.durable));
    stop();
    await connection.close();
  } finally {
    fake.stop();
  }
}

// ── OpenCode through a real broker: the refresh and reconnect a client actually sends ─────────
type BrokerClient = { ws: WebSocket; frames: any[]; attach: any };

/**
 * A real broker over [fake], on a random loopback port with an isolated home and managed runtimes
 * off, and the requests a client sends it.
 */
async function brokerOverOpenCode(root: string, fake: ReturnType<typeof fakeOpenCode>) {
  let stderr = '';
  const sockets: WebSocket[] = [];
  const broker = await startHealthyFixtureBroker({
    spawn: (port) => {
      stderr = '';
      const child = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
        env: isolatedBrokerFixtureEnvironment(root, {
          overrides: {
            PORT: String(port),
            HOST: '127.0.0.1',
            COSYNCING_HOME: join(root, 'home'),
            COSYNCING_TOKEN: '',
            COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
            COSYNCING_TEST_HISTORY_READ_METRICS: '1',
            OPENCODE_URL: fake.url,
          },
        }),
        stdout: 'ignore',
        stderr: 'pipe',
      });
      void (async () => {
        const reader = child.stderr.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stderr += new TextDecoder().decode(value);
        }
      })();
      return child;
    },
    healthUrl: (port) => `http://127.0.0.1:${port}/api/health`,
    peekOutput: () => stderr,
    readSettledOutput: async () => stderr,
    stop: async (child) => { child.kill(); await child.exited.catch(() => undefined); },
  });
  const wsBase = `ws://127.0.0.1:${broker.port}`;
  let request = 0;
  return {
    /** The history reads the broker made of [kind] (`refresh`, `page-cache-miss`, ...). */
    reads(kind: string): number {
      return stderr.split('\n').filter((line) => line.includes(`[h1-history-read] ${kind} opencode:`)).length;
    },
    async open(since?: string, revision = 28): Promise<BrokerClient> {
      const params = new URLSearchParams({ artifactMode: 'reference', contractRevision: String(revision), minimumBrokerRevision: '2' });
      if (since) params.set('since', since);
      const frames: any[] = [];
      const ws = new WebSocket(`${wsBase}/api/sessions/opencode/${fake.session.id}/stream?${params}`);
      sockets.push(ws);
      ws.onmessage = (event) => { try { frames.push(JSON.parse(String(event.data))); } catch { /* asserted by timeout */ } };
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('WebSocket failed to open'));
      });
      const attach = await waitForFrame(frames, (frame) => frame.kind === 'history', 'attach frame');
      return { ws, frames, attach };
    },
    async ask(client: { ws: WebSocket; frames: any[] }, body: Record<string, unknown>): Promise<any> {
      const clientMessageId = `append-${++request}`;
      client.ws.send(JSON.stringify({ ...body, clientMessageId }));
      return waitForFrame(client.frames, (frame) => frame.clientMessageId === clientMessageId
        && (frame.kind === 'history' || frame.kind === 'history-page' || frame.kind === 'nack'), String(body.kind));
    },
    async stop(): Promise<void> {
      for (const ws of sockets) ws.close();
      broker.child.kill();
      await broker.child.exited.catch(() => undefined);
    },
  };
}

const brokerKeys = (messages: any[]) => (messages ?? []).map((message) => `${message.type}:${message.key ?? message.requestId ?? ''}`);

async function openCodeThroughBroker(): Promise<void> {
  const root = temporaryRoot('cosyncing-append-broker-');
  const worktree = join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const fake = fakeOpenCode(worktree);
  let broker: Awaited<ReturnType<typeof brokerOverOpenCode>> | undefined;
  try {
    fake.setRows(openCodeFirstTurn());
    broker = await brokerOverOpenCode(root, fake);
    const { open, ask } = broker;
    const keys = brokerKeys;

    // Idle after one turn: the attach ends at the finished run's summary, and the token reading
    // and recomputed totals after it arrive after the frame.
    const reader = await open();
    check('broker: an idle attach ends at the finished run summary',
      JSON.stringify(keys(reader.attach.messages))
        === JSON.stringify(['user-message:msg_u1', 'model-output:prt_a1', 'run-summary:opencode:run:msg_a1'])
        && reader.attach.newerHistory === true,
      JSON.stringify(keys(reader.attach.messages)));
    // The replay after the frame is sent after it, so it may still be on its way.
    await waitForFrame(reader.frames, (frame) => frame.kind === 'message' && frame.message?.type === 'metadata-update', 'replayed totals')
      .catch(() => undefined);
    const afterAttach = reader.frames.slice(reader.frames.indexOf(reader.attach) + 1)
      .filter((frame) => frame.kind === 'message').map((frame) => `${frame.message?.type}:${frame.message?.key ?? ''}`);
    check('broker: the token reading and totals the attach held arrive after its frame',
      afterAttach.includes('token-count:') && afterAttach.includes('metadata-update:runtimeTotals'),
      JSON.stringify(afterAttach));
    // One prompt, nothing else: the idle end cursor still refreshes, pages and reconnects.
    fake.setRows([...openCodeFirstTurn(), openCodeUser('msg_u2', 3_000, 'second')]);
    const newerFromEnd = await ask(reader, { kind: 'history-page', direction: 'newer', cursor: reader.attach.endCursor, limit: 100 });
    check('broker: a newer page from the idle end boundary reaches the prompt (and pools the snapshot the refresh reuses)',
      newerFromEnd.kind === 'history-page' && keys(newerFromEnd.messages).includes('user-message:msg_u2'),
      JSON.stringify(newerFromEnd).slice(0, 300));
    const afterPrompt = await ask(reader, { kind: 'history-refresh', cursor: reader.attach.cursor });
    check('broker: the idle end cursor refreshes after one prompt',
      afterPrompt.kind === 'history' && !afterPrompt.reset && keys(afterPrompt.messages).at(-1) === 'user-message:msg_u2',
      JSON.stringify(afterPrompt).slice(0, 300));
    const reconnected = await open(reader.attach.cursor);
    check('broker: a reconnect from the idle end cursor is incremental',
      reconnected.attach.reset === false && keys(reconnected.attach.messages).at(-1) === 'user-message:msg_u2',
      JSON.stringify(reconnected.attach).slice(0, 300));
    reconnected.ws.close();

    // Mid-turn: a refresh while text streams holds that text back, and every boundary it names
    // survives the turn continuing and ending.
    fake.setBusy(true);
    await waitForFrame(reader.frames, (frame) => frame.kind === 'message' && frame.message?.type === 'status'
      && frame.message.status === 'running', 'running status');
    fake.setRows([...openCodeFirstTurn(), openCodeUser('msg_u2', 3_000, 'second'),
      openCodeAssistant('msg_a2', 'msg_u2', 4_000, [
        openCodeText('prt_r2', 'thinking it over', 4_000, 4_100, 'reasoning'),
        openCodeText('prt_a2', 'Hello wor', 4_200),
      ])]);
    const midTurn = await ask(reader, { kind: 'history-refresh', cursor: afterPrompt.cursor });
    check('broker: a mid-turn refresh names the finished rows and holds the streaming text',
      midTurn.kind === 'history' && JSON.stringify(keys(midTurn.messages)) === JSON.stringify(['thinking:prt_r2']),
      JSON.stringify(midTurn).slice(0, 300));
    fake.setRows([...openCodeFirstTurn(), openCodeUser('msg_u2', 3_000, 'second'),
      openCodeAssistant('msg_a2', 'msg_u2', 4_000, [
        openCodeText('prt_r2', 'thinking it over', 4_000, 4_100, 'reasoning'),
        openCodeText('prt_a2', 'Hello world, and more', 4_200, 4_500),
        openCodeTool('prt_t1', 'call_1', 'running', 'ls'),
      ])]);
    const continued = await ask(reader, { kind: 'history-refresh', cursor: midTurn.cursor });
    check('broker: the mid-turn refresh cursor still refreshes after the text grew; the running tool has a reserved result',
      continued.kind === 'history' && !continued.reset
        && JSON.stringify(keys(continued.messages)) === JSON.stringify(['model-output:prt_a2', 'tool-call:', 'tool-result:'])
        && continued.messages.at(-1).pending === true
        && typeof continued.messages.at(-1).reloadCursor === 'string'
        && continued.messages[0].text === 'Hello world, and more',
      JSON.stringify(continued).slice(0, 300));
    const legacy = await broker.open(undefined, 27);
    check('broker: an older client never receives a hidden result reservation',
      legacy.attach.messages.every((row: any) => !row.pending)
        && legacy.attach.messages.some((row: any) => row.type === 'tool-call'));
    legacy.ws.close();
    const backFromMid = await ask(reader, { kind: 'history-page', cursor: midTurn.endCursor, limit: 100 });
    check('broker: the mid-turn refresh end pages back after the turn continued',
      backFromMid.kind === 'history-page', JSON.stringify(backFromMid).slice(0, 300));
    const forwardFromMid = await ask(reader, { kind: 'history-page', direction: 'newer', cursor: midTurn.endCursor, limit: 100 });
    check('broker: the mid-turn refresh end pages newer after the turn continued',
      forwardFromMid.kind === 'history-page' && keys(forwardFromMid.messages).includes('model-output:prt_a2'),
      JSON.stringify(forwardFromMid).slice(0, 300));
    fake.setRows([...openCodeFirstTurn(), openCodeUser('msg_u2', 3_000, 'second'),
      openCodeAssistant('msg_a2', 'msg_u2', 4_000, [
        openCodeText('prt_r2', 'thinking it over', 4_000, 4_100, 'reasoning'),
        openCodeText('prt_a2', 'Hello world, and more', 4_200, 4_500),
        openCodeTool('prt_t1', 'call_1', 'completed', 'ls'),
        openCodeText('prt_a3', 'Done.', 5_000, 5_100),
      ], 5_200)]);
    fake.setBusy(false);
    await waitForFrame(reader.frames, (frame) => frame.kind === 'message' && frame.message?.type === 'status'
      && frame.message.status === 'idle', 'idle status');
    const ended = await ask(reader, { kind: 'history-refresh', cursor: continued.cursor });
    check('broker: the refresh cursor named beside a running tool survives the tool finishing',
      ended.kind === 'history' && !ended.reset
        && JSON.stringify(keys(ended.messages))
          === JSON.stringify(['model-output:prt_a3', 'run-summary:opencode:run:msg_a2']),
      JSON.stringify(ended).slice(0, 300));
    const completedSlot = await ask(reader, { kind: 'history-page', cursor: continued.messages.at(-1).reloadCursor, limit: 1 });
    check('broker: a reserved slot reloads its completion after the cached pending snapshot',
      completedSlot.kind === 'history-page' && completedSlot.messages.length === 1
        && completedSlot.messages[0].pending === false && completedSlot.messages[0].callId === 'call_1',
      JSON.stringify(completedSlot).slice(0, 300));
    const legacyReconnect = await broker.open(legacy.attach.cursor, 27);
    check('broker: an older client reconnect receives a fresh snapshot with missed completion',
      legacyReconnect.attach.reset && legacyReconnect.attach.messages.some((row: any) =>
        row.type === 'tool-result' && row.callId === 'call_1' && row.pending === false));
    legacyReconnect.ws.close();
    const late = await open(midTurn.cursor);
    check('broker: a reconnect from the mid-turn refresh cursor is incremental after the turn',
      late.attach.reset === false && keys(late.attach.messages)[0] === 'model-output:prt_a2',
      JSON.stringify(late.attach).slice(0, 300));
    late.ws.close();

    // Refreshes that arrive together while the grown history is read share that one read.
    const refreshReads = () => broker!.reads('refresh');
    const peer = await open(ended.cursor);
    const readsBeforeTogether = refreshReads();
    fake.setRows([...openCodeFirstTurn(), openCodeUser('msg_u2', 3_000, 'second'),
      openCodeAssistant('msg_a2', 'msg_u2', 4_000, [
        openCodeText('prt_r2', 'thinking it over', 4_000, 4_100, 'reasoning'),
        openCodeText('prt_a2', 'Hello world, and more', 4_200, 4_500),
        openCodeTool('prt_t1', 'call_1', 'completed', 'ls'),
        openCodeText('prt_a3', 'Done.', 5_000, 5_100),
      ], 5_200),
      openCodeUser('msg_u2b', 5_500, 'aside')]);
    fake.setReadDelay(400);
    const [together, alongside] = await Promise.all([
      ask(reader, { kind: 'history-refresh', cursor: ended.cursor }),
      ask(peer, { kind: 'history-refresh', cursor: ended.cursor }),
    ]);
    fake.setReadDelay(0);
    check('broker: two refreshes that arrive together share one read of the grown history',
      together.kind === 'history' && alongside.kind === 'history' && together.cursor === alongside.cursor
        && refreshReads() === readsBeforeTogether + 1,
      `${refreshReads() - readsBeforeTogether} reads`);
    peer.ws.close();
    const ended2 = together;

    // The next turn writes while it is read, so no read of it is ever an exact revision. A newer
    // page that reaches the end of the snapshot the last refresh pooled cannot be extended from the
    // current source, and is answered from that snapshot rather than refused, as far as it reaches.
    fake.setRows([...openCodeFirstTurn(), openCodeUser('msg_u2', 3_000, 'second'),
      openCodeAssistant('msg_a2', 'msg_u2', 4_000, [
        openCodeText('prt_r2', 'thinking it over', 4_000, 4_100, 'reasoning'),
        openCodeText('prt_a2', 'Hello world, and more', 4_200, 4_500),
        openCodeTool('prt_t1', 'call_1', 'completed', 'ls'),
        openCodeText('prt_a3', 'Done.', 5_000, 5_100),
      ], 5_200),
      openCodeUser('msg_u2b', 5_500, 'aside'),
      openCodeUser('msg_u3', 6_000, 'third')]);
    fake.setWriting(true);
    // One that STARTS at that end would carry nothing, while more history lies past it: an empty
    // page at the requested cursor that claims more history gives a client nothing to insert and
    // the same request to repeat. It is refused as a source still being written, which the client
    // retries after a pause.
    const atEnd = await ask(reader, { kind: 'history-page', direction: 'newer', cursor: ended2.endCursor, limit: 100 });
    check('broker: a newer page at the end of the pooled snapshot, while the session writes, is refused as still writing',
      atEnd.kind === 'nack' && atEnd.code === 'HISTORY_PAGE_SOURCE_CHANGED', JSON.stringify(atEnd).slice(0, 300));
    const intoEnd = await ask(reader, { kind: 'history-page', direction: 'newer', cursor: midTurn.endCursor, limit: 100 });
    check('broker: a newer page running into the end of the pooled snapshot carries its rows',
      intoEnd.kind === 'history-page'
        && JSON.stringify(keys(intoEnd.messages)) === JSON.stringify(['model-output:prt_a2', 'tool-call:', 'tool-result:', 'model-output:prt_a3', 'run-summary:opencode:run:msg_a2', 'token-count:', 'user-message:msg_u2b'])
        && intoEnd.cursor === ended2.endCursor && intoEnd.hasMore === true && intoEnd.endOfHistory === false,
      JSON.stringify(intoEnd).slice(0, 300));
    const pageReads = () => broker!.reads('page-cache-miss');
    const readsBeforeUntil = pageReads();
    const toUntil = await ask(reader, {
      kind: 'history-page', direction: 'newer', cursor: midTurn.endCursor, until: ended2.endCursor, limit: 100,
    });
    check('broker: a newer page that reaches its until at the snapshot end needs nothing newer',
      toUntil.kind === 'history-page' && toUntil.cursor === ended2.endCursor && toUntil.messages.length === 7
        && toUntil.endOfHistory === false && pageReads() === readsBeforeUntil,
      `${pageReads() - readsBeforeUntil} reads; ${JSON.stringify(toUntil).slice(0, 300)}`);
    const writingRefresh = await ask(reader, { kind: 'history-refresh', cursor: ended2.cursor });
    check('broker: a refresh while the session writes is answered from its read',
      writingRefresh.kind === 'history' && keys(writingRefresh.messages).at(-1) === 'user-message:msg_u3',
      JSON.stringify(writingRefresh).slice(0, 300));
    const pastSnapshot = await ask(reader, {
      kind: 'history-page', direction: 'newer', cursor: midTurn.endCursor, until: writingRefresh.endCursor, limit: 100,
    });
    check('broker: a newer page whose until lies past the pooled snapshot stops at the snapshot end',
      pastSnapshot.kind === 'history-page' && pastSnapshot.messages.length === 7
        && pastSnapshot.cursor === ended2.endCursor && pastSnapshot.hasMore === true && pastSnapshot.endOfHistory === false,
      JSON.stringify(pastSnapshot).slice(0, 300));
    // The request a client sends for the rest of that gap, from the snapshot end toward the until
    // past it: the current source cannot be read, and the snapshot has nothing after its end.
    const gapRest = await ask(reader, {
      kind: 'history-page', direction: 'newer', cursor: ended2.endCursor, until: writingRefresh.endCursor, limit: 100,
    });
    check('broker: a newer page from the snapshot end toward an until past it is refused as still writing, never answered empty',
      gapRest.kind === 'nack' && gapRest.code === 'HISTORY_PAGE_SOURCE_CHANGED', JSON.stringify(gapRest).slice(0, 300));
    fake.setWriting(false);
    const settledPage = await ask(reader, {
      kind: 'history-page', direction: 'newer', cursor: ended2.endCursor, until: writingRefresh.endCursor, limit: 100,
    });
    check('broker: once the session settles the same page reads the current source',
      settledPage.kind === 'history-page'
        && JSON.stringify(keys(settledPage.messages)) === JSON.stringify(['user-message:msg_u3'])
        && settledPage.cursor === writingRefresh.endCursor,
      JSON.stringify(settledPage).slice(0, 300));
    // An empty newer page is still an answer where it is the truth: at the end of a current history.
    const atTrueEnd = await ask(reader, { kind: 'history-page', direction: 'newer', cursor: settledPage.cursor, limit: 100 });
    check('broker: a newer page at the end of the current history is empty and reports the end',
      atTrueEnd.kind === 'history-page' && atTrueEnd.messages.length === 0 && atTrueEnd.cursor === settledPage.cursor
        && atTrueEnd.hasMore === false && atTrueEnd.endOfHistory === true,
      JSON.stringify(atTrueEnd).slice(0, 300));
  } finally {
    await broker?.stop();
    fake.stop();
  }
}

// ── OpenCode's coarse revision through a real broker ─────────────────────────────────────────
// OpenCode moves a session's `time.updated` only every few writes, so a snapshot the broker pooled
// under the current revision can be missing rows the session has written since. Nothing may be
// answered from such a snapshot as if it were current.
async function openCodeCoarseRevision(): Promise<void> {
  const root = temporaryRoot('cosyncing-append-coarse-');
  const worktree = join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const fake = fakeOpenCode(worktree);
  const sessionID = fake.session.id;
  const first = openCodeFirstTurn();
  const announce = (row: OpenCodeRow) => {
    fake.emit('message.updated', { sessionID, info: { ...row.info, sessionID } });
    for (const part of row.parts) {
      fake.emit('message.part.updated', { sessionID, part: { ...part, sessionID, messageID: row.info.id } });
    }
  };
  let broker: Awaited<ReturnType<typeof brokerOverOpenCode>> | undefined;
  try {
    fake.setRows(first);
    broker = await brokerOverOpenCode(root, fake);
    const { open, ask } = broker;
    const keys = brokerKeys;
    const reader = await open();
    fake.setBusy(true);
    await waitForFrame(reader.frames, (frame) => frame.kind === 'message' && frame.message?.type === 'status'
      && frame.message.status === 'running', 'running status');

    // The prompt moves the revision, and a refresh pools the snapshot it read.
    const prompt = openCodeUser('msg_u2', 3_000, 'second');
    announce(prompt);
    fake.setRows([...first, prompt]);
    const prompted = await ask(reader, { kind: 'history-refresh', cursor: reader.attach.cursor });
    check('coarse revision: the refresh after the prompt reaches it',
      prompted.kind === 'history' && keys(prompted.messages).at(-1) === 'user-message:msg_u2',
      JSON.stringify(prompted).slice(0, 300));

    // The turn writes rows without moving the revision; the event bus delivers them live.
    const answering = openCodeAssistant('msg_a2', 'msg_u2', 4_000, [
      openCodeText('prt_r2', 'thinking it over', 4_000, 4_100, 'reasoning'),
      openCodeText('prt_a2', 'Hello world.', 4_200, 4_300),
      openCodeText('prt_a3', 'And mo', 4_400),
    ]);
    fake.setRowsQuietly([...first, prompt, answering]);
    announce(answering);
    await waitForFrame(reader.frames, (frame) => frame.kind === 'message' && frame.message?.key === 'prt_a2', 'live text');
    const quiet = await ask(reader, { kind: 'history-refresh', cursor: prompted.cursor });
    check('coarse revision: a refresh after rows arrived live is not answered from the older snapshot',
      quiet.kind === 'history' && !quiet.reset
        && JSON.stringify(keys(quiet.messages)) === JSON.stringify(['thinking:prt_r2', 'model-output:prt_a2']),
      JSON.stringify(quiet).slice(0, 300));

    // More rows land with no event yet (the bus lags the store). A second client reads the source
    // itself, so its boundaries lie past the snapshot pooled under the same revision.
    const moreWritten = openCodeAssistant('msg_a2', 'msg_u2', 4_000, [
      openCodeText('prt_r2', 'thinking it over', 4_000, 4_100, 'reasoning'),
      openCodeText('prt_a2', 'Hello world.', 4_200, 4_300),
      openCodeText('prt_a3', 'And more.', 4_400, 4_500),
      openCodeTool('prt_t1', 'call_1', 'completed', 'ls'),
      openCodeText('prt_a4', 'Looking', 4_700),
    ]);
    fake.setRowsQuietly([...first, prompt, moreWritten]);
    const second = await open();
    check('coarse revision: the second attach names rows past the pooled snapshot',
      keys(second.attach.messages).includes('model-output:prt_a3') && keys(second.attach.messages).includes('tool-result:'),
      JSON.stringify(keys(second.attach.messages)));
    await waitForFrame(second.frames, (frame) => frame.kind === 'message' && frame.message?.key === 'prt_a4', 'held text')
      .catch(() => undefined);
    const heldAfterAttach = second.frames.slice(second.frames.indexOf(second.attach) + 1)
      .filter((frame) => frame.kind === 'message').map((frame) => `${frame.message?.type}:${frame.message?.key ?? ''}`);
    check('coarse revision: an attach while the turn runs ends before the streaming text, which follows the frame',
      keys(second.attach.messages).at(-1) === 'tool-result:' && heldAfterAttach.includes('model-output:prt_a4'),
      `${JSON.stringify(keys(second.attach.messages).slice(-2))} then ${JSON.stringify(heldAfterAttach)}`);
    const readsBefore = broker.reads('refresh') + broker.reads('page-cache-miss');
    const older = await ask(second, { kind: 'history-page', cursor: second.attach.endCursor, limit: 100 });
    check('coarse revision: an older page from the second attach end is served',
      older.kind === 'history-page' && keys(older.messages).includes('user-message:msg_u1'),
      JSON.stringify(older).slice(0, 300));
    // Every row after that end is one the running turn may still rewrite, so a newer page from it
    // has nothing it may carry yet: it is refused as still writing, never answered empty.
    const newer = await ask(second, { kind: 'history-page', direction: 'newer', cursor: second.attach.endCursor, limit: 100 });
    check('coarse revision: a newer page from the second attach end, where the turn holds every newer row, is refused as still writing',
      newer.kind === 'nack' && newer.code === 'HISTORY_PAGE_SOURCE_CHANGED', JSON.stringify(newer).slice(0, 300));
    const refreshed = await ask(second, { kind: 'history-refresh', cursor: second.attach.cursor });
    check('coarse revision: a refresh from the second attach cursor is served',
      refreshed.kind === 'history' && !refreshed.reset && refreshed.messages.length === 0,
      JSON.stringify(refreshed).slice(0, 300));
    const readsAfter = broker.reads('refresh') + broker.reads('page-cache-miss');
    check('coarse revision: the stale snapshot is rebuilt once for all three',
      readsAfter === readsBefore + 1, `${readsAfter - readsBefore} reads`);
    // A client whose first request after such an attach is a refresh reads the source once more.
    const stillMore = openCodeAssistant('msg_a2', 'msg_u2', 4_000, [
      openCodeText('prt_r2', 'thinking it over', 4_000, 4_100, 'reasoning'),
      openCodeText('prt_a2', 'Hello world.', 4_200, 4_300),
      openCodeText('prt_a3', 'And more.', 4_400, 4_500),
      openCodeTool('prt_t1', 'call_1', 'completed', 'ls'),
      openCodeText('prt_a4', 'Looking closer.', 4_700, 4_800),
      openCodeText('prt_a5', 'Fin', 4_900),
    ]);
    fake.setRowsQuietly([...first, prompt, stillMore]);
    const third = await open();
    const thirdRefresh = await ask(third, { kind: 'history-refresh', cursor: third.attach.cursor });
    check('coarse revision: a refresh from a cursor past the pooled snapshot is answered from a new read',
      thirdRefresh.kind === 'history' && !thirdRefresh.reset && thirdRefresh.messages.length === 0
        && thirdRefresh.cursor === third.attach.cursor,
      JSON.stringify(thirdRefresh).slice(0, 300));
    // ... and one whose first request is a page, over a row the pooled snapshot holds as it was
    // while it still streamed, rebuilds that snapshot too.
    const lastWritten = openCodeAssistant('msg_a2', 'msg_u2', 4_000, [
      ...stillMore.parts.slice(0, 5),
      openCodeText('prt_a5', 'Finished.', 4_900, 5_000),
      openCodeText('prt_a6', 'Summar', 5_100),
    ]);
    fake.setRowsQuietly([...first, prompt, lastWritten]);
    const fourth = await open();
    const fourthPage = await ask(fourth, { kind: 'history-page', cursor: fourth.attach.endCursor, limit: 100 });
    check('coarse revision: an older page over a row rewritten since the pooled read is served',
      fourthPage.kind === 'history-page' && keys(fourthPage.messages).includes('user-message:msg_u1'),
      JSON.stringify(fourthPage).slice(0, 300));
    // The first client's older cursor still pages from the rebuilt snapshot.
    const firstClientPage = await ask(reader, { kind: 'history-page', direction: 'newer', cursor: prompted.endCursor, limit: 100 });
    check('coarse revision: the first client pages newer from its older boundary into the rebuilt snapshot',
      firstClientPage.kind === 'history-page' && keys(firstClientPage.messages).includes('tool-result:'),
      JSON.stringify(firstClientPage).slice(0, 300));

    // A refusal from a snapshot read for the request itself is the answer: it is not read again.
    // The session is reverted to the prompt (OpenCode names the revert on the session), so the
    // fourth client's boundaries are gone from it.
    const reads = () => broker!.reads('refresh') + broker!.reads('page-cache-miss');
    fake.setRevert('msg_a2');
    fake.setRows([...first, prompt]);
    const beforeRevertPage = reads();
    const revertedPage = await ask(fourth, { kind: 'history-page', cursor: fourth.attach.endCursor, limit: 100 });
    check('coarse revision: a page past a reverted session is refused after one read of it',
      revertedPage.kind === 'nack' && revertedPage.code === 'HISTORY_CURSOR_GONE' && reads() === beforeRevertPage + 1,
      `${reads() - beforeRevertPage} reads; ${JSON.stringify(revertedPage).slice(0, 200)}`);
    fake.setRevert('msg_u2');
    fake.setRows(first);
    const beforeRevertRefresh = reads();
    const revertedRefresh = await ask(fourth, { kind: 'history-refresh', cursor: fourth.attach.cursor });
    check('coarse revision: a refresh past a reverted session is refused after one read of it',
      revertedRefresh.kind === 'nack' && reads() === beforeRevertRefresh + 1,
      `${reads() - beforeRevertRefresh} reads; ${JSON.stringify(revertedRefresh).slice(0, 200)}`);
  } finally {
    await broker?.stop();
    fake.stop();
  }
}

// ── The bounded-tail replay under a trailing run longer than its window ─────────────────────
// The replay's frame ends before the trailing pending/running run, exactly where every other path
// ends, even when the run reaches back past the rows the window retained. The rows of the run it
// retained follow the frame; the ones the window evicted are counted as missing, not dropped
// silently, and are not kept past the budget.
function boundedTailVolatileRun(): void {
  const transcript: AgentMessage[] = [
    { type: 'user-message', key: 'u1', text: 'first' },
    { type: 'model-output', key: 'a1', text: 'answer one', final: true },
    { type: 'user-message', key: 'u2', text: 'second' },
    { type: 'model-output', key: 'a2', text: 'answer two', final: true },
  ] as AgentMessage[];
  const run: AgentMessage[] = [
    { type: 'run-summary', key: 'run:2', turnId: 'u2', status: 'running' },
    { type: 'permission-request', requestId: 'perm-1', title: 'run a' },
    { type: 'permission-request', requestId: 'perm-2', title: 'run b' },
    { type: 'token-count', input: 10, output: 5 },
  ] as AgentMessage[];
  const history = [...transcript, ...run];
  const { durable } = cursorDurableHistory(history);
  const expected = historyDelta(durable).cursor;
  for (const window of [2, 3, 4, 500]) {
    const sink = new BoundedTailHistorySnapshotSink(window, 1024 * 1024);
    for (const message of history) sink.accept(message);
    const replay = sink.finish(FIXED_SOURCE);
    const attach = replay.attach(undefined, 500);
    const evicted = Math.max(0, run.length - window);
    const trailing = attach.derivedMessages.map((message) => JSON.stringify(message));
    check(`bounded tail (window ${window}): the frame ends before the trailing run, where every path does`,
      attach.cursor === expected, `${attach.cursor} vs ${expected}`);
    check(`bounded tail (window ${window}): the retained rows of the run follow the frame, in order`,
      JSON.stringify(trailing) === JSON.stringify(run.slice(evicted).map((message) => JSON.stringify(message))),
      JSON.stringify(attach.derivedMessages));
    check(`bounded tail (window ${window}): the rows of the run the window evicted are counted as missing`,
      replay.omittedMessages === evicted && sink.omittedMessages === evicted,
      `${replay.omittedMessages}/${sink.omittedMessages} vs ${evicted}`);
    const reconnect = replay.attach(expected, 500);
    check(`bounded tail (window ${window}): a reconnect from that end is incremental`,
      !reconnect.gap && !reconnect.reset && reconnect.cursor === expected, reconnect.gap?.code ?? 'reset');
  }
}

async function waitForFrame(frames: any[], predicate: (frame: any) => boolean, label: string): Promise<any> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const frame = frames.find(predicate);
    if (frame) return frame;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ── Claude: the real transcript reader behind a resume connection ─────────────────────────────
async function claude(): Promise<void> {
  const directory = temporaryRoot('cosyncing-append-claude-');
  const store = { configDir: directory, projectsRoot: join(directory, 'projects'), bin: 'claude', isDefault: true };
  const path = join(directory, 'session.jsonl');
  const usage = { input_tokens: 100, output_tokens: 20 };
  const lines: unknown[] = [
    { type: 'user', uuid: 'u1', timestamp: '2026-08-20T10:00:00.000Z', cwd: directory, message: { role: 'user', content: 'first' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-08-20T10:00:01.000Z', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'one' }], usage } },
  ];
  const write = () => writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  write();
  const info = { id: 'session', tool: 'claude', title: 'append', cwd: directory, status: 'idle', attachMode: 'resume' } as SessionInfo;
  const connection = new ClaudeResumeConnection(store as never, path, info);
  // A resume connection relaunches Claude per prompt; the fake process only accepts stdin.
  (connection as unknown as { relaunch: () => boolean }).relaunch = () => {
    (connection as unknown as { proc: unknown }).proc = { stdin: { write: () => true, end: () => {} }, kill: () => {}, killed: false };
    return true;
  };
  const drain = () => (connection as unknown as { drainUserEcho?: () => void }).drainUserEcho?.();
  const stop = connection.subscribe(() => {});

  const idle = await read('claude idle', connection, false);
  await connection.sendPrompt({ text: 'second' });
  const pending = await read('claude prompt pending', connection, true);
  await step(idle, pending, { previousRule: 'holds' });

  lines.push({ type: 'user', uuid: 'u2', timestamp: '2026-08-20T10:00:05.000Z', cwd: directory, message: { role: 'user', content: [{ type: 'text', text: 'second' }] } });
  write();
  drain();
  const delivered = await read('claude prompt delivered', connection, true);
  await step(pending, delivered, { previousRule: 'holds' });

  lines.push({ type: 'assistant', uuid: 'a2', timestamp: '2026-08-20T10:00:06.000Z', message: { id: 'm2', stop_reason: 'tool_use', content: [{ type: 'text', text: 'I will run ls.' }], usage } });
  lines.push({ type: 'assistant', uuid: 'a3', timestamp: '2026-08-20T10:00:06.500Z', message: { id: 'm2', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }], usage } });
  write();
  const midTurn = await read('claude mid-turn append', connection, true);
  await step(delivered, midTurn, { previousRule: 'holds' });

  await connection.sendPrompt({ text: 'queued follow-up' });
  const queued = await read('claude follow-up queued', connection, true);
  await step(midTurn, queued, { previousRule: 'holds' });

  lines.push({ type: 'user', uuid: 'ur1', timestamp: '2026-08-20T10:00:07.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a\nb' }] }, toolUseResult: { stdout: 'a\nb', stderr: '', interrupted: false, isImage: false } });
  lines.push({ type: 'assistant', uuid: 'a4', timestamp: '2026-08-20T10:00:08.000Z', message: { id: 'm3', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 130, output_tokens: 8 } } });
  write();
  const turnEnded = await read('claude turn ended, follow-up still queued', connection, true);
  await step(queued, turnEnded, { previousRule: 'breaks' });

  lines.push({ type: 'user', uuid: 'u3', timestamp: '2026-08-20T10:00:09.000Z', cwd: directory, message: { role: 'user', content: [{ type: 'text', text: 'queued follow-up' }] } });
  write();
  drain();
  const followUp = await read('claude follow-up delivered', connection, true);
  await step(turnEnded, followUp, { previousRule: 'holds' });
  stop();
  await connection.close();
}

// ── Codex: the real rollout reader and its capture ────────────────────────────────────────────
async function codex(): Promise<void> {
  const home = temporaryRoot('cosyncing-append-codex-');
  process.env.CODEX_HOME = home;
  process.env.COSYNCING_CODEX_SYNC_SERVER = '0';
  const { CodexAdapter } = await import('../../../adapters/codex/src/index.ts');
  const { pathToFileURL } = await import('node:url');
  const path = join(home, 'rollout-2026-09-14T00-00-00-00000000-0000-4000-8000-000000000999.jsonl');
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  writeFileSync(path, [
    { type: 'session_meta', payload: { id: '00000000-0000-4000-8000-000000000999', cwd: home } },
    { timestamp: '2026-06-18T10:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
    { timestamp: '2026-06-18T10:00:02.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'thinking through it' } },
    // The reasoning item itself, which is what history renders (one row, under the live key).
    { type: 'response_item', payload: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'thinking through it' }], content: null, encrypted_content: 'opaque', internal_chat_message_metadata_passthrough: { turn_id: 't1' } } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"command":"ls"}' } },
  ].map(line).join(''));
  const connection = await new CodexAdapter().attach(Buffer.from(path, 'utf8').toString('base64url'), 'observe');
  const running = await read('codex tool call running', connection, true);
  appendFileSync(path, [
    { type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'c1', exit_code: 0, duration: { secs: 1, nanos: 0 } } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'a\nb' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 5 }, last_token_usage: { input_tokens: 10, output_tokens: 5 } } } },
  ].map(line).join(''));
  const result = await read('codex tool result mid-turn', connection, true);
  await step(running, result, { previousRule: 'holds' });
  // A code-mode cell: the model issues one `exec` call, and the command that cell runs is written
  // only as its `item_completed` record (an `exec-` id), which history maps to a call and a result.
  appendFileSync(path, [
    { type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: 'c_cell', name: 'exec', input: 'await tools.exec_command({ cmd: "ls" })' } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: '00000000-0000-4000-8000-000000000999', turn_id: 't1', started_at_ms: 1, completed_at_ms: 2, item: { type: 'CommandExecution', id: 'exec-00000000-0000-4000-8000-0000000000e1', process_id: '42', command: ['/bin/bash', '-lc', 'ls'], cwd: pathToFileURL(home).href, parsed_cmd: [{ type: 'list_files', cmd: 'ls', path: null }], source: 'unified_exec_startup', status: 'completed', stdout: 'a\nb\n', stderr: '', aggregated_output: 'a\nb\n', exit_code: 0, duration: { secs: 0, nanos: 2_000_000 }, formatted_output: 'a\nb\n' } } },
  ].map(line).join(''));
  const nested = await read('codex nested exec call mid-cell', connection, true);
  await step(result, nested, { previousRule: 'holds' });
  appendFileSync(path, [
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c_cell', output: [{ type: 'input_text', text: 'Script completed' }] } },
  ].map(line).join(''));
  const cell = await read('codex exec cell done', connection, true);
  await step(nested, cell, { previousRule: 'holds' });
  check('codex: the nested exec call is one tool-call and one tool-result in history',
    JSON.stringify(cell.history.filter((m) => (m.type === 'tool-call' || m.type === 'tool-result') && m.callId === 'exec-00000000-0000-4000-8000-0000000000e1').map((m) => m.type)) === '["tool-call","tool-result"]',
    shape(cell.history));
  appendFileSync(path, [
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 20, output_tokens: 9 }, last_token_usage: { input_tokens: 10, output_tokens: 4 } } } },
    { timestamp: '2026-06-18T10:00:09.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
  ].map(line).join(''));
  const ended = await read('codex turn end', connection, false);
  await step(cell, ended, { previousRule: 'holds' });
  appendFileSync(path, [
    { timestamp: '2026-06-18T10:01:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'again' } },
    { timestamp: '2026-06-18T10:01:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } },
  ].map(line).join(''));
  const next = await read('codex next prompt', connection, true);
  await step(ended, next, { previousRule: 'holds' });
  await connection.close();
}

// ── Kilo: its SQLite store, then the HTTP connection its live and live-observe attaches use ──
// Kilo shares OpenCode's storage lineage: one row per message and per part, a message completed in
// place when its step ends, a part rewritten as its text grows or its tool finishes. The store
// reader maps a message still running with its token reading and no run summary, and adds the
// summary before that reading once the message completes.
type KiloPart = { id: string; data: Record<string, unknown> };
type KiloRow = { id: string; at: number; data: Record<string, unknown>; parts: KiloPart[] };
const kiloBase = Date.parse('2026-08-23T10:00:00.000Z');
const kiloUser = (id: string, at: number, text: string): KiloRow => ({
  id, at, data: { role: 'user', time: { created: at } }, parts: [{ id: `prt-${id}`, data: { type: 'text', text } }],
});
const kiloAssistant = (
  id: string,
  parent: string,
  at: number,
  parts: KiloPart[],
  done?: { at: number; finish: 'tool-calls' | 'stop' },
): KiloRow => ({
  id,
  at,
  parts,
  data: {
    role: 'assistant', parentID: parent, providerID: 'vllm-fixture', modelID: 'qwen-fixture',
    time: done ? { created: at, completed: done.at } : { created: at },
    ...(done ? { finish: done.finish } : {}),
    cost: done ? 0.01 : 0,
    tokens: done
      ? { input: 7, output: 2, cache: { read: 0, write: 0 }, total: 9 }
      : { input: 0, output: 0, cache: { read: 0, write: 0 }, total: 0 },
  },
});
/** A text part; one without an end time is still streaming. */
const kiloText = (id: string, body: string, start: number, end?: number, type = 'text'): KiloPart => ({
  id, data: { type, text: body, time: end ? { start, end } : { start } },
});
const kiloTool = (id: string, callID: string, status: 'running' | 'completed', command: string): KiloPart => ({
  id,
  data: {
    type: 'tool',
    tool: 'bash',
    callID,
    state: status === 'completed'
      ? { status, input: { command }, output: 'ok', title: command, metadata: { exit: 0 }, time: { start: 1, end: 2 } }
      : { status, input: { command }, time: { start: 1 } },
  },
});

/** Replace the fixture session's messages and parts, as Kilo's writes leave them. */
function writeKiloRows(databasePath: string, rows: KiloRow[]): void {
  const database = new Database(databasePath);
  try {
    database.query('delete from part where session_id = ?').run(KILO_FIXTURE_SESSION_ID);
    database.query('delete from message where session_id = ?').run(KILO_FIXTURE_SESSION_ID);
    for (const row of rows) {
      database.query('insert into message values (?, ?, ?, ?, ?)')
        .run(row.id, KILO_FIXTURE_SESSION_ID, row.at, row.at, JSON.stringify(row.data));
      row.parts.forEach((part, index) => database.query('insert into part values (?, ?, ?, ?, ?, ?)')
        .run(part.id, row.id, KILO_FIXTURE_SESSION_ID, row.at + index, row.at + index, JSON.stringify(part.data)));
    }
    database.query('update session set time_updated = time_updated + 1 where id = ?').run(KILO_FIXTURE_SESSION_ID);
  } finally {
    database.close();
  }
}

/** One Kilo turn of two steps, as the store holds it at each point a client could read it. */
function kiloTurn(): Array<{ label: string; rows: KiloRow[]; running: boolean }> {
  const first = [
    kiloUser('msg-u1', kiloBase, 'first'),
    kiloAssistant('msg-a1', 'msg-u1', kiloBase + 1_000, [
      kiloText('prt-r1', 'thinking it over', kiloBase + 1_000, kiloBase + 1_100, 'reasoning'),
      kiloText('prt-a1', 'answer one', kiloBase + 1_200, kiloBase + 1_500),
    ], { at: kiloBase + 1_600, finish: 'stop' }),
  ];
  const prompt = kiloUser('msg-u2', kiloBase + 3_000, 'second');
  const stepOneDone = kiloAssistant('msg-a2', 'msg-u2', kiloBase + 4_000, [
    kiloText('prt-a2', 'Hello world', kiloBase + 4_000, kiloBase + 4_100),
    kiloTool('prt-t1', 'call_1', 'completed', 'ls'),
  ], { at: kiloBase + 4_500, finish: 'tool-calls' });
  const stepTwoDone = kiloAssistant('msg-a3', 'msg-u2', kiloBase + 5_000, [
    kiloText('prt-a3', 'Done.', kiloBase + 5_000, kiloBase + 5_100),
  ], { at: kiloBase + 5_200, finish: 'stop' });
  return [
    { label: 'idle', rows: first, running: false },
    { label: 'one prompt', rows: [...first, prompt], running: true },
    { label: 'text streaming', rows: [...first, prompt,
      kiloAssistant('msg-a2', 'msg-u2', kiloBase + 4_000, [kiloText('prt-a2', 'Hello wor', kiloBase + 4_000)])], running: true },
    { label: 'tool running', rows: [...first, prompt,
      kiloAssistant('msg-a2', 'msg-u2', kiloBase + 4_000, [
        kiloText('prt-a2', 'Hello world', kiloBase + 4_000, kiloBase + 4_100),
        kiloTool('prt-t1', 'call_1', 'running', 'ls'),
      ])], running: true },
    { label: 'step two streaming', rows: [...first, prompt, stepOneDone,
      kiloAssistant('msg-a3', 'msg-u2', kiloBase + 5_000, [kiloText('prt-a3', 'Do', kiloBase + 5_000)])], running: true },
    { label: 'turn ended', rows: [...first, prompt, stepOneDone, stepTwoDone], running: false },
    { label: 'next prompt', rows: [...first, prompt, stepOneDone, stepTwoDone, kiloUser('msg-u3', kiloBase + 6_000, 'third')], running: true },
  ];
}

/**
 * Whether the rule this replaced (every durable row counts) kept the cursor across each step of
 * {@link kiloTurn}, and whether the step needs the running-turn hold: a streaming part's text
 * grows, the running message's token reading is replaced by the rows that follow it, and a
 * completed message gains its summary before that reading.
 */
const kiloSteps: Array<{ previousRule: 'breaks' | 'holds'; holdNeeded?: boolean }> = [
  { previousRule: 'holds' },
  { previousRule: 'holds' },
  { previousRule: 'breaks', holdNeeded: true },
  { previousRule: 'breaks' },
  { previousRule: 'breaks', holdNeeded: true },
  { previousRule: 'holds' },
];

async function kilo(): Promise<void> {
  const tree = buildKiloFixtureTree();
  try {
    const turn = kiloTurn();
    writeKiloRows(tree.databasePath, turn[0]!.rows);
    const session = (await discoverKiloStore({ env: { KILO_DATA_DIR: tree.dataRoot } }))[0]!;
    const info = {
      id: session.id, nativeId: session.nativeId, tool: 'kilo', title: session.title, cwd: session.cwd,
      status: 'idle', attachMode: 'observe',
    } as SessionInfo;
    // One connection reads the whole turn, as the broker's does while clients stay attached. Kilo
    // writes each message in place until it completes, and none of that may read as a rewrite: a
    // connection that took it for one reset its clients on every later read and stopped naming a
    // source, so no cursor of this turn could be paged or refreshed again.
    const connection = new KiloObserveConnection({ session, info });
    const resets: AgentMessage[] = [];
    const stop = connection.subscribe((message) => { if (message.type === 'history-reset') resets.push(message); });
    const readStore = async (label: string, running: boolean): Promise<Read | undefined> => {
      try {
        return await read(`kilo store ${label}`, connection, running);
      } catch (error) {
        check(`kilo store ${label}: the connection still captures its history`, false,
          error instanceof Error ? error.message : String(error));
        return undefined;
      }
    };
    let prev = await readStore(turn[0]!.label, turn[0]!.running);
    let completed = 0;
    for (let index = 1; prev && index < turn.length; index += 1) {
      writeKiloRows(tree.databasePath, turn[index]!.rows);
      const next = await readStore(turn[index]!.label, turn[index]!.running);
      if (!next) break;
      await step(prev, next, kiloSteps[index - 1]!);
      prev = next;
      completed = index;
    }
    check('kilo store: one connection reads the whole turn without a reset, and still names its source',
      completed === turn.length - 1 && resets.length === 0 && await connection.getHistorySourceIdentity() !== undefined,
      `${completed}/${turn.length - 1} steps; ${resets.length} resets`);
    check('kilo store: a completed step gains its summary before its token reading',
      !!prev && shape(prev.durable).includes('tool-result | run-summary:kilo:run:msg-a2(done) | token-count'),
      prev ? shape(prev.durable) : 'no read');
    check('kilo store: a finished tool keeps its call, and the result follows it',
      !!prev && shape(prev.durable).includes('tool-call | tool-result'), prev ? shape(prev.durable) : 'no read');
    stop();
    await connection.close();
  } finally {
    tree.cleanup();
  }

  // The HTTP connection Kilo's live and live-observe attaches read history through, over the same
  // turn served as OpenCode's HTTP API serves it.
  const directory = temporaryRoot('cosyncing-append-kilo-live-');
  const worktree = join(directory, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const fake = fakeOpenCode(worktree);
  try {
    const asHttp = (rows: KiloRow[]): OpenCodeRow[] => rows.map((row) => ({
      info: { id: row.id, ...row.data },
      parts: row.parts.map((part) => ({ id: part.id, ...part.data })),
    }));
    const turn = kiloTurn();
    const connection = new OpenCodeLiveConnection({
      baseUrl: fake.url,
      info: {
        id: fake.session.id, nativeId: fake.session.id, tool: 'kilo', title: 'Kilo live', cwd: worktree,
        status: 'idle', attachMode: 'live',
      } as SessionInfo,
      dialect: { productId: 'kilo', displayName: 'Kilo Code' },
    });
    fake.setRows(asHttp(turn[0]!.rows));
    let prev = await read(`kilo http ${turn[0]!.label}`, connection, turn[0]!.running);
    for (let index = 1; index < turn.length; index += 1) {
      fake.setRows(asHttp(turn[index]!.rows));
      const next = await read(`kilo http ${turn[index]!.label}`, connection, turn[index]!.running);
      await step(prev, next, kiloSteps[index - 1]!);
      prev = next;
    }
    check('kilo http: a finished tool keeps its call, and the result follows it',
      shape(prev.durable).includes('tool-call | tool-result'), shape(prev.durable));
    await connection.close();
  } finally {
    fake.stop();
  }
}

// ── Kilo and OpenCode: a parallel step whose tools finish out of order ───────────────────────
// A step that runs two tools at once writes both calls. Each tool's one part maps to its call, and
// to its call followed by its result once that tool finished, so when the later tool finishes first
// its result already follows the earlier call, which is still running; when that one finishes, its
// result is written straight after its own call, before the later call. In either completion order
// no boundary a frame, refresh or newer page names may lie after a call still waiting for its
// result, and every count bound that would cut the step there stops before it instead.
type ParallelStep = { label: string; rows: KiloRow[]; running: boolean; expect?: { previousRule: 'breaks' | 'holds'; holdNeeded?: boolean } };

/** One turn whose step runs tools A and B together, with [first] finishing before the other. */
function kiloParallelTurn(first: 'A' | 'B'): ParallelStep[] {
  const opening = kiloTurn()[0]!.rows;
  const prompt = kiloUser('msg-u2', kiloBase + 3_000, 'run both');
  const both = (a: 'running' | 'completed', b: 'running' | 'completed', done?: { at: number; finish: 'tool-calls' }) =>
    kiloAssistant('msg-a2', 'msg-u2', kiloBase + 4_000, [
      kiloText('prt-a2', 'Running both.', kiloBase + 4_000, kiloBase + 4_100),
      kiloTool('prt-ta', 'call_a', a, 'sleep 5'),
      kiloTool('prt-tb', 'call_b', b, 'ls'),
    ], done);
  const closing = kiloAssistant('msg-a3', 'msg-u2', kiloBase + 6_000, [
    kiloText('prt-a3', 'Both finished.', kiloBase + 6_000, kiloBase + 6_100),
  ], { at: kiloBase + 6_200, finish: 'stop' });
  // [expect] is how the step from the one before reads, as the Kilo store and its HTTP API map it.
  // Once the step writes, the replaced rule breaks on every read: it counted the running message's
  // token reading, which the next row displaces.
  return [
    { label: 'idle', rows: opening, running: false },
    { label: 'prompted', rows: [...opening, prompt], running: true, expect: { previousRule: 'holds' } },
    { label: 'both running', rows: [...opening, prompt, both('running', 'running')], running: true, expect: { previousRule: 'holds' } },
    first === 'A'
      // A's result goes before B's call: an end after B's call would not survive, the hold is needed.
      ? { label: 'A finished first', rows: [...opening, prompt, both('completed', 'running')], running: true, expect: { previousRule: 'breaks' } }
      // B's result is written after B's call, which ended the history: only an append.
      : { label: 'B finished first', rows: [...opening, prompt, both('running', 'completed')], running: true, expect: { previousRule: 'breaks' } },
    first === 'A'
      ? { label: 'then B', rows: [...opening, prompt, both('completed', 'completed')], running: true, expect: { previousRule: 'breaks' } }
      // A's result goes between A's call and B's: an end after B's result would not survive.
      : { label: 'then A', rows: [...opening, prompt, both('completed', 'completed')], running: true, expect: { previousRule: 'breaks' } },
    { label: 'turn ended', rows: [...opening, prompt, both('completed', 'completed', { at: kiloBase + 5_000, finish: 'tool-calls' }), closing], running: false, expect: { previousRule: 'breaks' } },
  ];
}

/** A boundary one count-bounded request named, to be resolved on the next read. */
type CountBoundary = { label: string; reconnect?: string; older: string };

/**
 * Every count bound a refresh or a newer page may cut [at]'s history with, from the opening
 * boundary: each stops at or before the running-turn hold, where the attach ends, and every path
 * (the whole-array history, the encoded cache and, where the adapter captures, the native index)
 * names the same boundary. Checked while [at]'s capture is still the adapter's current source.
 */
async function countBoundaries(at: Read): Promise<CountBoundary[]> {
  const out: CountBoundary[] = [];
  const hold = historyCursorParts(at.attach.reconnect)?.boundary ?? -1;
  const encoded = EncodedHistoryPageCache.create(FIXED_SOURCE, at.durable);
  if (!encoded) throw new Error(`${at.label}: the encoded cache exceeded its budget`);
  for (let limit = 1; limit <= at.durable.length; limit += 1) {
    const options = { max: limit, holdTrailingText: at.running };
    const refreshed = historyRefresh(at.durable, OPENING, options);
    if ('gap' in refreshed) throw new Error(`${at.label}: a refresh of ${limit} was refused`);
    const end = historyCursorParts(refreshed.cursor)?.boundary ?? Number.POSITIVE_INFINITY;
    check(`${at.label}: a refresh of ${limit} stops at or before the hold`, end <= hold, `${end} > ${hold}`);
    const encodedRefresh = encoded.loadRefresh(OPENING, options);
    check(`${at.label}: the encoded refresh of ${limit} ends where the whole-array one does`,
      !('gap' in encodedRefresh) && encodedRefresh.cursor === refreshed.cursor, refusal(encodedRefresh));
    const newer = forwardHistoryPage(at.durable, OPENING_OLDER, limit, undefined, { holdTrailingText: at.running });
    const newerEnd = backwardHistoryCursorBoundary(newer.cursor) ?? Number.POSITIVE_INFINITY;
    check(`${at.label}: a newer page of ${limit} stops at or before the hold`, !newer.gap && newerEnd <= hold, `${newerEnd} > ${hold}`);
    const encodedNewer = encoded.pageNewer(OPENING_OLDER, limit, undefined, { holdTrailingText: at.running });
    check(`${at.label}: the encoded newer page of ${limit} ends where the whole-array one does`,
      !encodedNewer.gap && encodedNewer.cursor === newer.cursor, encodedNewer.gap?.code);
    if (at.indexed) {
      const indexedRefresh = await at.indexed.loadRefresh(OPENING, options);
      check(`${at.label}: the indexed refresh of ${limit} ends where the whole-array one does`,
        !('kind' in indexedRefresh) && !('gap' in indexedRefresh) && indexedRefresh.cursor === refreshed.cursor,
        refusal(indexedRefresh));
      const indexedNewer = await at.indexed.loadNewerPage(OPENING_OLDER, limit, undefined, {}, { holdTrailingText: at.running });
      check(`${at.label}: the indexed newer page of ${limit} ends where the whole-array one does`,
        !('kind' in indexedNewer) && !indexedNewer.gap && indexedNewer.cursor === newer.cursor, refusal(indexedNewer));
    }
    out.push({ label: `refresh of ${limit}`, reconnect: refreshed.cursor, older: refreshed.endCursor });
    out.push({ label: `newer page of ${limit}`, older: newer.cursor! });
  }
  return out;
}

/** Every boundary [countBoundaries] named on an earlier read still resolves on [next]. */
async function expectCountBoundariesResolve(from: Read, boundaries: CountBoundary[], next: Read): Promise<void> {
  for (const boundary of boundaries) {
    const label = `${from.label} -> ${next.label} (${boundary.label})`;
    if (boundary.reconnect !== undefined) {
      await expectResolves(label, { reconnect: boundary.reconnect, older: boundary.older }, next);
      continue;
    }
    const older = backwardHistoryPage(next.durable, boundary.older, 100);
    const newer = forwardHistoryPage(next.durable, boundary.older, 500);
    check(`${label}: the page it ended reloads, and the pages after it are served`, !older.gap && !newer.gap,
      `${older.gap?.code ?? ''} ${newer.gap?.code ?? ''}; t+1 = ${shape(next.history)}`);
    if (next.indexed) {
      const page = await next.indexed.loadPage(boundary.older, 100);
      const after = await next.indexed.loadNewerPage(boundary.older, 500);
      check(`${label}: the indexed pages from it are served`,
        refusal(page) === undefined && refusal(after) === undefined, `${refusal(page) ?? ''} ${refusal(after) ?? ''}`);
    }
  }
}

/**
 * Drive [turn] through one connection, writing each step with [write] before it is read.
 * [previousRule] overrides how the replaced rule reads each step, for a connection that appends
 * other rows than the Kilo store does.
 */
async function parallelToolsOver(
  label: string,
  connection: Pick<SessionConnection, 'getHistory' | 'captureHistorySnapshot'>,
  turn: ParallelStep[],
  write: (rows: KiloRow[]) => void,
  previousRule?: 'breaks' | 'holds',
): Promise<Read> {
  write(turn[0]!.rows);
  let prev = await read(`${label} ${turn[0]!.label}`, connection, turn[0]!.running);
  let bounds = await countBoundaries(prev);
  for (let index = 1; index < turn.length; index += 1) {
    write(turn[index]!.rows);
    const next = await read(`${label} ${turn[index]!.label}`, connection, turn[index]!.running);
    const expect = turn[index]!.expect!;
    const completion = /finished first|then [AB]/.test(turn[index]!.label);
    await step(prev, next, { ...expect, previousRule: completion ? 'holds' : previousRule ?? expect.previousRule });
    await expectCountBoundariesResolve(prev, bounds, next);
    prev = next;
    bounds = await countBoundaries(prev);
  }
  return prev;
}

async function parallelTools(): Promise<void> {
  for (const first of ['A', 'B'] as const) {
    const turn = kiloParallelTurn(first);
    const order = `${first} first`;
    // The store reader, whose capture also serves the native index and the bounded-tail replay.
    const tree = buildKiloFixtureTree();
    try {
      writeKiloRows(tree.databasePath, turn[0]!.rows);
      const session = (await discoverKiloStore({ env: { KILO_DATA_DIR: tree.dataRoot } }))[0]!;
      const info = {
        id: session.id, nativeId: session.nativeId, tool: 'kilo', title: session.title, cwd: session.cwd,
        status: 'idle', attachMode: 'observe',
      } as SessionInfo;
      const connection = new KiloObserveConnection({ session, info });
      const stop = connection.subscribe(() => {});
      const last = await parallelToolsOver(`kilo store parallel (${order})`, connection, turn,
        (rows) => writeKiloRows(tree.databasePath, rows));
      check(`kilo store parallel (${order}): each finished tool keeps its call, and its result follows it`,
        shape(last.durable).includes('tool-call | tool-result | tool-call | tool-result'), shape(last.durable));
      stop();
      await connection.close();
    } finally {
      tree.cleanup();
    }

    // The HTTP connection Kilo's live attaches read history through, and OpenCode's own adapter,
    // over the same turn served as OpenCode's HTTP API serves it.
    const directory = temporaryRoot('cosyncing-append-parallel-');
    const worktree = join(directory, 'worktree');
    const storage = join(directory, 'data');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(join(storage, 'storage', 'session'), { recursive: true });
    const fake = fakeOpenCode(worktree);
    const asHttp = (rows: KiloRow[]): OpenCodeRow[] => rows.map((row) => ({
      info: { id: row.id, ...row.data },
      parts: row.parts.map((part) => ({ id: part.id, ...part.data })),
    }));
    try {
      const kiloHttp = new OpenCodeLiveConnection({
        baseUrl: fake.url,
        info: {
          id: fake.session.id, nativeId: fake.session.id, tool: 'kilo', title: 'Kilo live', cwd: worktree,
          status: 'idle', attachMode: 'live',
        } as SessionInfo,
        dialect: { productId: 'kilo', displayName: 'Kilo Code' },
      });
      await parallelToolsOver(`kilo http parallel (${order})`, kiloHttp, turn, (rows) => fake.setRows(asHttp(rows)));
      await kiloHttp.close();

      fake.setRows(asHttp(turn[0]!.rows));
      const adapter = new OpenCodeAdapter({ baseUrl: fake.url, storageDir: storage, sseIdleMs: 30_000 });
      const openCodeConnection = await adapter.attach(fake.session.id, 'live');
      const stop = openCodeConnection.subscribe(() => {});
      await sleep(100);
      // OpenCode's recomputed runtime totals end every read, and the replaced rule counted them, so
      // it breaks on every step.
      await parallelToolsOver(`opencode parallel (${order})`, openCodeConnection, turn, (rows) => {
        fake.setRows(asHttp(rows));
        fake.setBusy(rows !== turn[0]!.rows && rows !== turn.at(-1)!.rows);
      }, 'breaks');
      stop();
      await openCodeConnection.close();
    } finally {
      fake.stop();
    }
  }
}

// ── Pi and omp: the observe reader of their JSONL session file ──────────────────────────────
// Both run the same engine over their own dialect. The session file gains whole entries (a prompt,
// an assistant message, a tool result) as a turn goes on, and every read restates the open turn's
// summary and the recomputed totals after the transcript.
const piLine = (entry: Record<string, unknown>) => `${JSON.stringify(entry)}\n`;
const piAt = (ms: number) => new Date(Date.parse('2026-08-23T10:00:00.000Z') + ms).toISOString();
const piMessage = (id: string, parentId: string | null, ms: number, message: Record<string, unknown>) =>
  piLine({ type: 'message', id, parentId, timestamp: piAt(ms), message });
const piAssistant = (content: unknown[], stopReason: 'stop' | 'toolUse', requestAt: number, usage?: Record<string, number>) => ({
  role: 'assistant', stopReason, timestamp: Date.parse(piAt(requestAt)), content, ...(usage ? { usage } : {}),
});

async function piFamily(): Promise<void> {
  const root = temporaryRoot('cosyncing-append-pi-');
  // Each dialect resolves its directories and binary from the environment when its module loads,
  // so both are pointed at this fixture root first: no read reaches the host's agent directories,
  // and a binary that does not exist means nothing is ever spawned.
  const overrides: Record<string, string> = {
    COSYNCING_PI_AGENT_DIR: join(root, 'pi-agent'),
    COSYNCING_PI_SESSIONS_ROOT: join(root, 'pi-sessions'),
    COSYNCING_PI_BIN: join(root, 'bin', 'pi-not-installed'),
    COSYNCING_OMP_AGENT_DIR: join(root, 'omp-agent'),
    COSYNCING_OMP_SESSIONS_ROOT: join(root, 'omp-sessions'),
    COSYNCING_OMP_BIN: join(root, 'bin', 'omp-not-installed'),
  };
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const { PiAdapter } = await import('../../../adapters/pi/src/index.ts');
    const { OmpAdapter } = await import('../../../adapters/omp/src/index.ts');
    const cwd = join(root, 'work');
    mkdirSync(cwd, { recursive: true });
    for (const [tool, adapter, sessionsRoot, header] of [
      ['pi', new PiAdapter({ brokerUrl: 'http://127.0.0.1:1' }), overrides.COSYNCING_PI_SESSIONS_ROOT!, [] as string[]],
      // omp keeps its title in a leading `title` entry of its own.
      ['omp', new OmpAdapter({ brokerUrl: 'http://127.0.0.1:1' }), overrides.COSYNCING_OMP_SESSIONS_ROOT!,
        [piLine({ type: 'title', id: 't0', parentId: null, timestamp: piAt(0), title: 'append fixture' })]],
    ] as const) {
      const directory = join(sessionsRoot, '--work--');
      mkdirSync(directory, { recursive: true });
      const file = join(directory, '2026-08-23T10-00-00-000Z_append.jsonl');
      writeFileSync(file, [
        piLine({ type: 'session', version: 3, id: `${tool}-append`, timestamp: piAt(0), cwd }),
        ...header,
        piMessage('u1', null, 1_000, { role: 'user', content: [{ type: 'text', text: 'first' }] }),
        piMessage('a1', 'u1', 2_000, piAssistant([{ type: 'thinking', thinking: 'thinking it over' }, { type: 'text', text: 'answer one' }], 'stop', 1_000, { input: 1, output: 2 })),
      ].join(''));
      const connection = await adapter.attach(Buffer.from(realpathSync(file), 'utf8').toString('base64url'));
      const idle = await read(`${tool} idle`, connection, false);
      appendFileSync(file, piMessage('u2', 'a1', 3_000, { role: 'user', content: [{ type: 'text', text: 'second' }] }));
      const prompted = await read(`${tool} one prompt`, connection, true);
      await step(idle, prompted, { previousRule: 'breaks' });
      appendFileSync(file, piMessage('a2', 'u2', 4_000, piAssistant([
        { type: 'text', text: 'Let me look.' },
        { type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } },
      ], 'toolUse', 3_000)));
      const called = await read(`${tool} tool call`, connection, true);
      await step(prompted, called, { previousRule: 'breaks' });
      appendFileSync(file, piMessage('r2', 'a2', 5_000, {
        role: 'toolResult', toolCallId: 'tc1', toolName: 'bash', content: [{ type: 'text', text: 'a.txt' }], isError: false,
      }));
      const result = await read(`${tool} tool result`, connection, true);
      await step(called, result, { previousRule: 'breaks' });
      appendFileSync(file, piMessage('a3', 'r2', 6_000, piAssistant([{ type: 'text', text: 'One file.' }], 'stop', 5_000, { input: 3, output: 4 })));
      const ended = await read(`${tool} turn ended`, connection, false);
      await step(result, ended, { previousRule: 'breaks' });
      appendFileSync(file, piMessage('u3', 'a3', 7_000, { role: 'user', content: [{ type: 'text', text: 'third' }] }));
      const next = await read(`${tool} next prompt`, connection, true);
      await step(ended, next, { previousRule: 'breaks' });
      check(`${tool}: the open turn's summary and the totals follow the transcript, outside every cursor`,
        shape(next.history).endsWith('(running) | metadata-update:runtimeTotals')
          && next.durable.at(-1)?.type === 'user-message',
        shape(next.history));
      await connection.close();
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ── Kimi: the REST history its observe and drive attaches read, over a fake `kimi web` ───────
// The server's host metadata comes from the adapter's committed capture; the transcript is
// synthetic. Kimi pages its messages newest first and restates nothing after them (its current
// state arrives through overlays), so every step only appends.
async function kimi(): Promise<void> {
  const capture = await Bun.file(new URL('../../../adapters/kimi/test/fixtures/kimi-0.35.0.json', import.meta.url)).json() as {
    sessionId: string;
    rest: Record<string, { code: number; msg: string; data: unknown }>;
    instanceRecord: Record<string, unknown>;
  };
  const sessionId = capture.sessionId;
  let items: Array<Record<string, unknown>> = [];
  let busy = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/healthz') return Response.json(capture.rest.healthz);
      if (request.headers.get('authorization') !== 'Bearer fixture-token') {
        return Response.json(capture.rest.metaUnauthorized, { status: 401 });
      }
      if (url.pathname === '/api/v1/meta') return Response.json(capture.rest.meta);
      if (url.pathname === '/api/v2/sessions') {
        return Response.json({
          code: 0, msg: 'success', request_id: 'append',
          data: {
            items: [{
              id: sessionId,
              workspace: { id: 'append-workspace', cwd: '/append/work' },
              meta: { title: 'append fixture', last_prompt: 'second', created_at: 1, updated_at: 2, archived: false },
              activity: { status: busy ? 'running' : 'idle' },
            }],
            has_more: false,
            next_page_token: null,
          },
        });
      }
      if (url.pathname === `/api/v1/sessions/${sessionId}/status`) {
        return Response.json({ ...capture.rest.status, data: { ...(capture.rest.status!.data as object), busy } });
      }
      if (url.pathname === `/api/v1/sessions/${sessionId}`) {
        return Response.json({ code: 0, msg: 'success', data: { id: sessionId, busy, pending_interaction: 'none' }, request_id: 'append' });
      }
      if (url.pathname === `/api/v1/sessions/${sessionId}/messages`) {
        const newestFirst = [...items].reverse();
        const beforeId = url.searchParams.get('before_id');
        const pageSize = Number(url.searchParams.get('page_size') ?? '100');
        const start = beforeId ? newestFirst.findIndex((item) => item.id === beforeId) + 1 : 0;
        const window = newestFirst.slice(start, start + pageSize);
        return Response.json({
          code: 0, msg: 'success', request_id: 'append',
          data: { items: window, has_more: start + window.length < newestFirst.length },
        });
      }
      return Response.json(capture.rest.messagesUnknownSession);
    },
  });
  try {
    const record = decodeKimiInstanceRecord(capture.instanceRecord)!;
    const scan: KimiInstanceScan = {
      live: [{
        baseUrl: `http://127.0.0.1:${server.port}`,
        port: server.port!,
        pid: record.pid,
        serverId: record.serverId,
        hostVersion: record.hostVersion,
        ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      }],
      stale: 0,
      invalid: 0,
      truncated: false,
    };
    const adapter = new KimiAdapter({
      env: {},
      homeDir: '/append/home',
      instanceScan: () => scan,
      readToken: () => 'fixture-token',
      observe: {
        socketFactory: () => ({ send() {}, close() {}, addEventListener() {} }) as never,
        setInterval: () => 1,
        clearInterval: () => {},
      },
    });
    const at = (ms: number) => new Date(Date.parse('2026-08-23T10:00:00.000Z') + ms).toISOString();
    const message = (id: string, role: string, ms: number, content: unknown[]) =>
      ({ id, session_id: sessionId, role, content, created_at: at(ms) });
    items = [
      message('m1', 'user', 0, [{ type: 'text', text: 'first' }]),
      message('m2', 'assistant', 1_000, [{ type: 'thinking', thinking: 'thinking it over' }, { type: 'text', text: 'answer one' }]),
    ];
    const connection = await adapter.attach(sessionId);
    const idle = await read('kimi idle', connection, false);
    busy = true;
    items = [...items, message('m3', 'user', 2_000, [{ type: 'text', text: 'second' }])];
    const prompted = await read('kimi one prompt', connection, true);
    await step(idle, prompted, { previousRule: 'holds' });
    items = [...items, message('m4', 'assistant', 3_000, [
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', tool_call_id: 'call_1', tool_name: 'Bash', input: { command: 'ls' } },
    ])];
    const called = await read('kimi tool call', connection, true);
    await step(prompted, called, { previousRule: 'holds' });
    items = [...items, message('m5', 'tool', 4_000, [{ type: 'tool_result', tool_call_id: 'call_1', output: 'a.txt', is_error: false }])];
    const result = await read('kimi tool result', connection, true);
    await step(called, result, { previousRule: 'holds' });
    busy = false;
    items = [...items, message('m6', 'assistant', 5_000, [{ type: 'text', text: 'One file.' }])];
    const ended = await read('kimi turn ended', connection, false);
    await step(result, ended, { previousRule: 'holds' });
    busy = true;
    items = [...items, message('m7', 'user', 6_000, [{ type: 'text', text: 'third' }])];
    const next = await read('kimi next prompt', connection, true);
    await step(ended, next, { previousRule: 'holds' });
    check('kimi: the call and its result are both in history, keyed by the call',
      shape(next.durable).includes('tool-call | tool-result'), shape(next.durable));
    await connection.close();
  } finally {
    server.stop(true);
  }
}

// ── dsh: its session connection over a scripted `session.history` RPC ─────────────────────────
// dsh's history is its event log, in `seq` order, so a later read only appends. A turn's summary is
// written `running` where the turn starts and again, `done`, where it ends.
async function dsh(): Promise<void> {
  const sessionId = 'session-append-fixture';
  let events: Array<{ event: Record<string, unknown> }> = [];
  const fetchImpl: DshFetch = async (_url, init) => {
    const body = JSON.parse(init.body) as { rpcId: string };
    return {
      status: 200,
      text: async () => JSON.stringify({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: { events, hasMore: false } },
      }),
    };
  };
  const connection = new DshSessionConnection(
    { id: sessionId, tool: 'dsh', title: 'append fixture', status: 'idle', attachMode: 'live' } as SessionInfo,
    { rpc: new DshRpcClient({ baseUrl: 'http://dsh.invalid', fetchImpl }) },
  );
  let seq = 0;
  const base = Date.parse('2026-08-23T10:00:00.000Z');
  const push = (type: string, data: Record<string, unknown>, ms: number, extra: Record<string, unknown> = {}) => {
    seq += 1;
    events = [...events, { event: { type, seq, time: base + ms, data, ...extra } }];
  };
  const user = (id: string, text: string, ms: number) =>
    push('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id }, ms, { surfaceOp: 'append' });
  const assistant = (turn: number, stepIndex: number, id: string, text: string, ms: number) =>
    push('assistant/message', {
      turn, step: stepIndex,
      message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' }, id },
      usage: { inputTokens: 5, outputTokens: 2 },
    }, ms, { surfaceOp: 'append' });
  try {
    push('turn/start', { turn: 1 }, 0);
    user('u1', 'first', 10);
    push('step/start', { turn: 1, step: 1 }, 20);
    assistant(1, 1, 'a1', 'answer one', 30);
    push('step/end', { turn: 1, step: 1 }, 40);
    push('turn/end', { turn: 1, reason: { kind: 'completed' } }, 50);
    const idle = await read('dsh idle', connection, false);
    push('turn/start', { turn: 2 }, 100);
    user('u2', 'second', 110);
    const prompted = await read('dsh one prompt', connection, true);
    await step(idle, prompted, { previousRule: 'holds' });
    push('step/start', { turn: 2, step: 1 }, 120);
    assistant(2, 1, 'a2', 'Let me look.', 130);
    push('tool/call', { turn: 2, step: 1, callId: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }, 140);
    const called = await read('dsh tool call', connection, true);
    await step(prompted, called, { previousRule: 'holds' });
    push('tool/result', {
      turn: 2, step: 1,
      message: {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call_1', content: 'a.txt', isError: false }],
        source: { kind: 'tool', callId: 'call_1' },
        id: 't1',
      },
    }, 150);
    push('step/end', { turn: 2, step: 1 }, 160);
    const result = await read('dsh tool result', connection, true);
    await step(called, result, { previousRule: 'holds' });
    push('step/start', { turn: 2, step: 2 }, 170);
    assistant(2, 2, 'a3', 'One file.', 180);
    push('step/end', { turn: 2, step: 2 }, 190);
    push('turn/end', { turn: 2, reason: { kind: 'completed' } }, 200);
    const ended = await read('dsh turn ended', connection, false);
    await step(result, ended, { previousRule: 'holds' });
    push('turn/start', { turn: 3 }, 300);
    user('u3', 'third', 310);
    const next = await read('dsh next prompt', connection, true);
    await step(ended, next, { previousRule: 'holds' });
    const turnTwo = `dsh:${sessionId}:turn2`;
    check('dsh: a turn\'s summary is written where it starts and again where it ends',
      next.durable.filter((message) => message.type === 'run-summary' && message.key === turnTwo)
        .map((message) => (message as { status?: string }).status).join(',') === 'running,done',
      shape(next.durable));
  } finally {
    await connection.close();
  }
}

// ── Antigravity: its transcript and inbox, then its drive with a prompt pending ───────────────
// Antigravity names no history source, so the broker refuses its pages and refreshes: a client
// resumes it by reconnecting, and that is the cursor these steps must keep. Its history is the
// transcript it appends to, the settlements its inbox gains as background tasks end, the task
// panel folded from both, and the drive's prompts not yet delivered.
const agyInbox = (tree: AgyFixtureTree, conversation: string) =>
  join(tree.roots.appData, 'brain', conversation, '.system_generated', 'messages');
const agyUserInput = (stepIndex: number, text: string, createdAt: string) => ({
  step_index: stepIndex,
  source: 'USER_EXPLICIT',
  type: 'USER_INPUT',
  status: 'DONE',
  created_at: createdAt,
  content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${createdAt}.\n</ADDITIONAL_METADATA>`,
});

async function antigravity(): Promise<void> {
  const conversation = AGY_FIXTURE.conversationIds.withTranscript;
  const info = (attachMode: 'observe' | 'resume') => ({
    id: conversation, nativeId: conversation, tool: 'agy', title: 'Antigravity fixture', status: 'idle', attachMode,
  }) as SessionInfo;
  const steps = AGY_FIXTURE.transcript;
  const tree = buildAgyFixtureTree({ transcriptSteps: 13, withoutSettlement: true });
  try {
    const observe = new AgyObserveConnection({ roots: tree.roots, conversationId: conversation, info: info('observe'), trace: () => {} });
    const idle = await read('agy idle', observe, false);
    // A background task is started, and the panel appears where it was.
    appendFileSync(tree.transcriptPath, agyJsonl(steps.slice(13, 15)));
    const started = await read('agy task started', observe, false);
    await step(idle, started, { previousRule: 'holds' });
    appendFileSync(tree.transcriptPath, agyJsonl(steps.slice(15, 21)));
    const asked = await read('agy question asked', observe, false);
    await step(started, asked, { previousRule: 'holds' });
    // The task ends: its settlement lands in the inbox, recorded after every step written so far.
    mkdirSync(agyInbox(tree, conversation), { recursive: true });
    writeFileSync(join(agyInbox(tree, conversation), `${String(AGY_FIXTURE.settlement.id)}.json`),
      JSON.stringify(AGY_FIXTURE.settlement));
    const settled = await read('agy task settled', observe, false);
    await step(asked, settled, { previousRule: 'holds' });
    // The host delivers the settlement and the conversation goes on, after it.
    appendFileSync(tree.transcriptPath, agyJsonl(steps.slice(21)));
    const delivered = await read('agy settlement delivered', observe, false);
    await step(settled, delivered, { previousRule: 'holds' });
    appendFileSync(tree.transcriptPath, agyJsonl(AGY_FIXTURE.appendedSteps));
    const ended = await read('agy turn ended', observe, false);
    await step(delivered, ended, { previousRule: 'holds' });
    const panels = ended.durable.filter((message) => message.type === 'task-list-state') as Array<{ items: Array<{ id?: string; status: string }> }>;
    // Recorded while the question of step 20 was open, and delivered by the system step after it.
    const at = (match: (message: AgentMessage) => boolean) => ended.durable.findIndex(match);
    const settlementAt = at((message) => message.type === 'tool-result'
      && message.callId === `agy:${conversation}:task:${String(AGY_FIXTURE.settlement.sender)}`);
    check('agy: the settlement sits where it was recorded, between the question and the steps after it',
      settlementAt > at((message) => message.type === 'tool-result' && message.callId === `agy:${conversation}:19:call:0`)
        && settlementAt < at((message) => message.type === 'model-output' && message.key === `agy:${conversation}:24:text`),
      `${settlementAt}: ${shape(ended.durable)}`);
    check('agy: the task panel is restated where the ledger changed, and the newest says the task ended',
      panels.length === 2 && panels[0]!.items[0]?.status === 'in-progress' && panels.at(-1)!.items[0]?.status === 'done',
      JSON.stringify(panels));
    await observe.close();
  } finally {
    tree.cleanup();
  }

  // The drive: a prompt sent while the session is idle stands in the history until the transcript
  // line that delivers it arrives, and other steps can be written before that line.
  const driveTree = buildAgyFixtureTree({ transcriptSteps: 3, withoutSettlement: true });
  try {
    const fake = writeFakeAgyBinary(join(driveTree.dir, 'bin'), {
      init: { init: {}, conversation_id: conversation, model: 'gemini-3.5-flash-low', cwd: '/fixture/demo-project', permission_mode: 'request-review', tools: [] },
      // The turn stays open: the child answers nothing, so the prompt is delivered only by the
      // transcript lines this case appends.
      defaultTurn: [],
    });
    const drive = new AgyDriveConnection({
      roots: driveTree.roots, conversationId: conversation, info: info('resume'), binary: fake.path, trace: () => {},
    });
    const driveIdle = await read('agy drive idle', drive, false);
    await drive.sendPrompt({ text: 'summarise the review' });
    const pending = await read('agy drive prompt pending', drive, true);
    await step(driveIdle, pending, { previousRule: 'holds' });
    const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    appendFileSync(driveTree.transcriptPath, agyJsonl([{
      step_index: 3, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: at,
      content: 'A background task finished.',
    }]));
    const beforeDelivery = await read('agy drive step before the delivery', drive, true);
    await step(pending, beforeDelivery, { previousRule: 'breaks' });
    appendFileSync(driveTree.transcriptPath, agyJsonl([agyUserInput(4, 'summarise the review', at)]));
    const deliveredPrompt = await read('agy drive prompt delivered', drive, true);
    await step(beforeDelivery, deliveredPrompt, { previousRule: 'holds' });
    appendFileSync(driveTree.transcriptPath, agyJsonl([{
      step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at, content: 'The review is summarised.',
    }]));
    const answered = await read('agy drive turn append', drive, true);
    await step(deliveredPrompt, answered, { previousRule: 'holds' });
    const users = answered.durable.filter((message) => message.type === 'user-message' && message.text === 'summarise the review');
    check('agy drive: the delivering line takes the pending prompt\'s place, once',
      users.length === 1 && String((users[0] as { key?: string }).key).startsWith('queued:agy:'),
      shape(answered.durable));
    await drive.close();
  } finally {
    driveTree.cleanup();
  }
}

// ── grok: the store reader, then its ACP drive with a prompt pending ──────────────────────────
function grokInfo(id: string, cwd: string, attachMode: 'observe' | 'resume'): SessionInfo {
  return {
    id,
    nativeId: id,
    tool: 'grok',
    title: 'Grok fixture',
    cwd,
    status: 'idle',
    attachMode,
    ...(attachMode === 'resume' ? {
      control: {
        drive: { state: 'driving', supported: true },
        terminalSync: { supported: false, syncAvailable: false, active: false },
      },
    } : {}),
  } as SessionInfo;
}

async function grok(): Promise<void> {
  const tree = buildGrokFixtureTree();
  try {
    const updates = fixtureUpdates();
    tree.writeRows(updates.slice(0, 4));
    const session = (await discoverGrokStore({ root: tree.root }))[0]!;
    const observe = new GrokObserveConnection({ session, info: grokInfo(session.id, session.cwd, 'observe') });
    const toolCall = await read('grok tool call', observe, true);
    tree.writeRows(updates.slice(0, 5));
    const toolResult = await read('grok tool result', observe, true);
    await step(toolCall, toolResult, { previousRule: 'breaks' });
    tree.writeRows(updates);
    const turnEnd = await read('grok turn end', observe, false);
    await step(toolResult, turnEnd, { previousRule: 'breaks' });
    await observe.close();

    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const promptStarted = new Promise<void>((resolve) => { started = resolve; });
    const transport: GrokAcpTransport = {
      alive: true,
      initialize: () => Promise.resolve(),
      sessionPrompt: async () => {
        started?.();
        await new Promise<void>((resolve) => { release = resolve; });
        return { stopReason: 'end_turn' };
      },
      sessionCancel: () => {},
      configure: () => Promise.resolve(),
      listModels: () => Promise.resolve([]),
      listCommands: () => Promise.resolve([]),
      close: () => Promise.resolve(),
    };
    const drive = await GrokDriveConnection.fromTransport(
      session,
      grokInfo(session.id, session.cwd, 'resume'),
      transport,
      { replayCorrelations: new Map() },
    );
    const stop = drive.subscribe(() => {});
    const idle = await read('grok drive idle', drive, false);
    const send = drive.sendPrompt({ text: 'second prompt', clientMessageId: 'client-1' });
    await promptStarted;
    const pending = await read('grok drive prompt pending', drive, true);
    await step(idle, pending, { previousRule: 'holds' });
    tree.append({
      timestamp: '2026-08-23T10:01:00.000Z',
      method: 'session/update',
      params: {
        sessionId: session.id,
        _meta: { eventId: 'owned-event' },
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'second prompt' } },
      },
    } as never);
    await sleep(160);
    const delivered = await read('grok drive prompt delivered', drive, true);
    await step(pending, delivered, { previousRule: 'breaks' });
    tree.append({
      timestamp: '2026-08-23T10:01:00.100Z',
      method: 'session/update',
      params: {
        sessionId: session.id,
        _meta: { eventId: 'owned-answer-event', promptId: 'owned-prompt' },
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'owned answer' } },
      },
    } as never);
    const answered = await read('grok drive turn append', drive, true);
    await step(delivered, answered, { previousRule: 'breaks' });
    release?.();
    await send;
    stop();
    await drive.close();
  } finally {
    tree.cleanup();
  }
}

// ── Reasonix: the store reader, then its ACP drive with a prompt pending ──────────────────────
async function reasonix(): Promise<void> {
  const tree = buildReasonixFixtureTree();
  try {
    const session = (await discoverReasonixStore({ root: tree.root } as never))[0]!;
    const info = { id: session.id, nativeId: session.id, tool: 'reasonix', title: 'Reasonix fixture', cwd: tree.cwd, status: 'idle', attachMode: 'observe' } as SessionInfo;
    const observe = new ReasonixObserveConnection({ session, info } as never);
    const idle = await read('reasonix idle', observe, false);
    tree.appendUser('second prompt');
    const prompted = await read('reasonix next prompt', observe, true);
    await step(idle, prompted, { previousRule: 'holds' });
    tree.writeRows([...tree.rows, { role: 'assistant', content: 'second answer', reasoning_content: '', workDurationMs: 3 }]);
    const answered = await read('reasonix answer', observe, false);
    await step(prompted, answered, { previousRule: 'breaks' });
    await observe.close();

    let release: (() => void) | undefined;
    let prompts = 0;
    const transport: ReasonixAcpTransport = {
      alive: true,
      sessionPrompt: async () => {
        prompts += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return { stopReason: 'end_turn' };
      },
      sessionCancel: () => {},
      close: async () => { release?.(); },
    };
    const drive = ReasonixDriveConnection.fromTransport(
      { ...session, driveEligible: true },
      { ...info, attachMode: 'resume' },
      transport,
    );
    const stop = drive.subscribe(() => {});
    const driveIdle = await read('reasonix drive idle', drive, false);
    const send = drive.sendPrompt({ text: 'third prompt', clientMessageId: 'client-3' });
    for (let attempt = 0; attempt < 100 && prompts === 0; attempt += 1) await sleep(20);
    const pending = await read('reasonix drive prompt pending', drive, true);
    await step(driveIdle, pending, { previousRule: 'holds' });
    tree.appendUser('third prompt');
    const delivered = await read('reasonix drive prompt delivered', drive, true);
    await step(pending, delivered, { previousRule: 'holds' });
    tree.writeRows([...tree.rows, { role: 'assistant', content: 'third answer', reasoning_content: '', workDurationMs: 3 }]);
    const turnAppend = await read('reasonix drive turn append', drive, true);
    await step(delivered, turnAppend, { previousRule: 'holds' });
    release?.();
    await send.catch(() => {});
    stop();
    await drive.close();

    // A tool step: its call is kept from the assistant row that made it, under the id the tool
    // row with its result names, from the read where that row is written.
    const toolObserve = new ReasonixObserveConnection({ session, info } as never);
    const beforeTool = await read('reasonix before a tool step', toolObserve, false);
    tree.appendUser('list the workspace');
    const toolPrompted = await read('reasonix tool prompt', toolObserve, true);
    await step(beforeTool, toolPrompted, { previousRule: 'holds' });
    const call = { id: 'call_00_fixture', name: 'bash', arguments: '{"command":"ls"}' };
    tree.writeRows([...tree.rows, { role: 'assistant', content: 'listing it', reasoning_content: '', workDurationMs: 2, tool_calls: [call] }]);
    const toolCalled = await read('reasonix tool call', toolObserve, true);
    await step(toolPrompted, toolCalled, { previousRule: 'breaks' });
    tree.writeRows([...tree.rows, { role: 'tool', name: 'bash', tool_call_id: call.id, content: 'README.md' }]);
    const toolResulted = await read('reasonix tool result', toolObserve, true);
    await step(toolCalled, toolResulted, { previousRule: 'holds' });
    tree.writeRows([...tree.rows, { role: 'assistant', content: 'one file', reasoning_content: '', workDurationMs: 3 }]);
    const toolAnswered = await read('reasonix tool answer', toolObserve, false);
    await step(toolResulted, toolAnswered, { previousRule: 'holds' });
    const keptCall = (history: AgentMessage[]) => history.filter((message) => message.type === 'tool-call')
      .map((message) => (message as { callId: string }).callId);
    const resultAt = toolAnswered.history.findIndex((message) => message.type === 'tool-result'
      && (message as { callId: string }).callId === call.id);
    check('reasonix: the call is kept under the id its result names, just before that result',
      JSON.stringify(keptCall(toolCalled.history)) === JSON.stringify([call.id])
        && JSON.stringify(keptCall(toolAnswered.history)) === JSON.stringify([call.id])
        && toolAnswered.history[resultAt - 1]?.type === 'tool-call',
      shape(toolAnswered.history));
    await toolObserve.close();
  } finally {
    tree.cleanup();
  }
}

// ── Cline: the store reader, then its Hub drive with a prompt pending ─────────────────────────
async function cline(): Promise<void> {
  const tree = buildClineFixtureTree();
  try {
    const messages = fixtureParentMessages();
    tree.writeParent(messages.slice(0, 2));
    const session = (await discoverClineStore({ env: { CLINE_DIR: tree.root }, processAlive: () => true }))[0]!;
    const info = { id: session.id, nativeId: session.nativeId, tool: 'cline', title: session.title, cwd: session.cwd, status: 'idle', attachMode: 'observe' } as SessionInfo;
    const observe = new ClineObserveConnection({ session, info });
    const midTurn = await read('cline mid-turn', observe, true);
    tree.writeParent(messages.slice(0, 3), '2026-08-23T10:00:02.500Z');
    const toolResult = await read('cline tool result', observe, true);
    await step(midTurn, toolResult, { previousRule: 'breaks' });
    tree.writeParent(messages, '2026-08-23T10:00:03.500Z');
    const final = await read('cline final answer', observe, false);
    await step(toolResult, final, { previousRule: 'breaks' });
    tree.writeParent([...messages, { id: 'msg-user-2', role: 'user', ts: '2026-08-23T10:00:04.000Z', content: [{ type: 'text', text: 'next' }] }], '2026-08-23T10:00:04.500Z');
    const next = await read('cline next prompt', observe, true);
    await step(final, next, { previousRule: 'breaks' });
    await observe.close();
  } finally {
    tree.cleanup();
  }

  // The Hub drive, which is how Cline is driven: its own history read over a Hub that answers
  // `session.messages` from a fixture transcript.
  let native = fixtureParentMessages();
  const client = {
    options: { discovery: { hubId: 'fixture-hub', startedAt: 1 } },
    subscribe: () => () => {},
    onClose: () => () => {},
    close: async () => {},
    command: async (name: string) => {
      if (name !== 'session.messages') throw new Error(`unexpected Cline Hub command ${name}`);
      return { sessionId: CLINE_HUB_SESSION, messages: native };
    },
  };
  const hubRoot = temporaryRoot('cosyncing-append-cline-hub-');
  const drive = new ClineHubDriveConnection({
    info: { id: CLINE_HUB_SESSION, nativeId: CLINE_HUB_SESSION, tool: 'cline', title: 'Cline fixture', cwd: hubRoot, status: 'idle', attachMode: 'resume' } as SessionInfo,
    client: client as never,
    profileRoot: hubRoot,
    models: [],
    modes: [],
    permissionMode: 'ask',
  });
  const idle = await read('cline hub idle', drive, false);
  // `sendPrompt` admits a prompt exactly like this before the Hub persists it: the queued row, and
  // the transcript it was sent against.
  (drive as unknown as { pendingPrompts: unknown[] }).pendingPrompts.push({
    key: 'client-2',
    text: 'next',
    beforeMessages: [...native],
    row: { type: 'user-message', text: 'next', key: 'client-2', clientKey: 'client-2', queued: true },
  });
  const pending = await read('cline hub prompt pending', drive, true);
  await step(idle, pending, { previousRule: 'holds' });
  native = [...native, { id: 'msg-user-2', role: 'user', ts: '2026-08-23T10:00:04.000Z', content: [{ type: 'text', text: 'next' }] }];
  const delivered = await read('cline hub prompt delivered', drive, true);
  await step(pending, delivered, { previousRule: 'holds' });
  native = [...native, { id: 'msg-assistant-3', role: 'assistant', ts: '2026-08-23T10:00:05.000Z', content: [{ type: 'text', text: 'next answer' }] }];
  const answered = await read('cline hub turn append', drive, false);
  await step(delivered, answered, { previousRule: 'holds' });
  await drive.close();
}

try {
  await openCode();
  await openCodeMultiStep();
  await openCodeThroughBroker();
  await openCodeCoarseRevision();
  await claude();
  await codex();
  await grok();
  await reasonix();
  await cline();
  await kilo();
  await parallelTools();
  await piFamily();
  await kimi();
  await dsh();
  await antigravity();
  boundedTailVolatileRun();
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

console.log(`steps the replaced rule broke: ${previousRuleBreaks.length}`);
for (const label of previousRuleBreaks) console.log(`  ${label}`);
if (failures.length > 0) {
  console.log(`\nhistory append stability: ${failures.length} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`\nhistory append stability: ${passed}/${passed} checks passed`);
process.exit(0);
