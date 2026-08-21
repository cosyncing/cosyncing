/**
 * The attach boundary: the priming window, the single admit gate, the
 * reconnect re-baseline, and the pending-prompt table.
 *
 * The hard part of this connection is the ORDER the broker uses: it subscribes
 * first and reads history second, so live frames legitimately arrive before the
 * transcript they overlap exists. dsh gives every event a contiguous per-session
 * `seq`, so the overlap is exact — and these tests assert that a frame arriving
 * in the window is never dropped and never duplicated, on the buffered path, on
 * the cap-breach path, on the timeout path, and after a reconnect.
 *
 * Everything is injected: the RPC client runs on a stub fetch, frames are handed
 * in directly, and the priming clock is a counter. No dsh process, no network.
 *
 *   bun run packages/typescript/adapters/dsh/test/test-dsh-observe.ts   (exit 0 = all pass)
 */
export {};
import type { AgentMessage, SessionInfo } from '@cosyncing/adapter-api';
import { DshRpcClient, type DshDownlinkFrame, type DshFetch } from '../src/server.ts';
import {
  DshSessionConnection,
  DSH_HISTORY_PARTIAL_NOTICE,
  DSH_HISTORY_TRUNCATED_NOTICE,
  DSH_HISTORY_UNAVAILABLE_NOTICE,
  DSH_RECONNECT_NOTICE,
} from '../src/observe.ts';
import type { DshHistoryEntry } from '../src/mapping.ts';

const FIXTURE = await Bun.file(new URL('./fixtures/dsh-0.1.0-rc.6.json', import.meta.url)).json() as {
  historyTail: { body: { result: { value: { events: DshHistoryEntry[]; hasMore: boolean; projections: unknown } } } };
};
const HISTORY = FIXTURE.historyTail.body.result.value;
const SESSION_ID = 'session-7723d8e8-cf1c-4e0a-8748-3a600aa396fc';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const info: SessionInfo = {
  id: SESSION_ID,
  tool: 'dsh',
  title: 'spike',
  status: 'idle',
  attachMode: 'live',
};

/** An RPC client whose only answer is a scripted `session.history` page. */
function historyClient(pages: Array<{ ok?: boolean; value?: unknown }>): { rpc: DshRpcClient; calls: unknown[] } {
  const calls: unknown[] = [];
  let index = 0;
  const fetchImpl: DshFetch = async (_url, init) => {
    const body = JSON.parse(init.body) as { rpcId: string; payload: unknown };
    calls.push(body.payload);
    const page = pages[Math.min(index, pages.length - 1)];
    index += 1;
    if (page?.ok === false) {
      return {
        status: 200,
        text: async () => JSON.stringify({
          type: 'server-response',
          rpcId: body.rpcId,
          result: { ok: false, error: { code: 'internal', message: 'nope', details: {} } },
        }),
      };
    }
    return {
      status: 200,
      text: async () => JSON.stringify({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: page?.value ?? { events: [], hasMore: false } },
      }),
    };
  };
  return { rpc: new DshRpcClient({ baseUrl: 'http://h', fetchImpl }), calls };
}

function eventFrame(event: Record<string, unknown>, view?: unknown): DshDownlinkFrame {
  const payload = { type: 'session/event', sessionId: SESSION_ID, event, ...(view !== undefined ? { view } : {}) };
  // `bytes` feeds only the host link's pre-verification budget, which these
  // direct-to-connection frames never pass through; carry the honest estimate.
  return {
    stream: 'mux',
    rpcId: `push-${String(event.seq)}`,
    frameType: 'session/event',
    payload,
    bytes: JSON.stringify(payload).length,
  };
}

function frame(frameType: string, payload: Record<string, unknown>, rpcId = 'rpc-1', stream: 'mux' | 'host' = 'mux'): DshDownlinkFrame {
  const full = { type: frameType, sessionId: SESSION_ID, ...payload };
  return { stream, rpcId, frameType, payload: full, bytes: JSON.stringify(full).length };
}

function userEvent(seq: number, text: string, id: string): Record<string, unknown> {
  return {
    type: 'user/message',
    seq,
    time: 1,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' }, id },
    surfaceOp: 'append',
  };
}

// ── 1. Priming boundary ─────────────────────────────────────────────────────

{
  const { rpc } = historyClient([{ value: HISTORY }]);
  const connection = new DshSessionConnection(info, { rpc });
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));

  // Live frames land BEFORE history is read: one that history will also carry
  // (seq 8, the human prompt) and one genuinely newer (seq 21).
  connection.handleMuxFrame(eventFrame(HISTORY.events[8]!.event as unknown as Record<string, unknown>));
  connection.handleMuxFrame(eventFrame(userEvent(21, 'after the seed', 'm21')));
  check('frames arriving before the seed are buffered, not delivered', seen.length === 0 && !connection.isPrimed);

  const history = await connection.getHistory();
  const bubbles = history.filter((message) => message.type === 'user-message');
  check(
    'the history seed carries the transcript',
    bubbles.length === 1 && (bubbles[0] as { text: string }).text === 'Reply with exactly: OK',
    String(history.length),
  );
  const flushed = seen.filter((message) => message.type === 'user-message') as Array<{ text: string }>;
  check(
    'the flush delivers only what history did not already carry',
    connection.isPrimed && flushed.length === 1 && flushed[0]!.text === 'after the seed',
    JSON.stringify(flushed),
  );

  // The gate is one gate: a replay of an already-admitted seq is refused
  // whatever path it arrives on.
  const before = seen.length;
  connection.handleMuxFrame(eventFrame(userEvent(21, 'after the seed', 'm21')));
  connection.handleMuxFrame(eventFrame(HISTORY.events[8]!.event as unknown as Record<string, unknown>));
  check('a replayed seq is refused after priming too', seen.length === before, `${seen.length} vs ${before}`);
}

{
  const { rpc } = historyClient([{ value: { events: [], hasMore: false } }]);
  const connection = new DshSessionConnection(info, { rpc, primingMaxFrames: 2 });
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  connection.handleMuxFrame(eventFrame(userEvent(1, 'one', 'm1')));
  connection.handleMuxFrame(eventFrame(userEvent(2, 'two', 'm2')));
  check('the buffer holds up to its cap', seen.length === 0);
  connection.handleMuxFrame(eventFrame(userEvent(3, 'three', 'm3')));
  check(
    'a breached cap FLUSHES rather than discarding, and the triggering frame takes the same gate',
    connection.isPrimed && seen.filter((message) => message.type === 'user-message').length === 3,
    String(seen.length),
  );
}

{
  let now = 0;
  const { rpc } = historyClient([{ value: { events: [], hasMore: false } }]);
  const connection = new DshSessionConnection(info, { rpc, now: () => now, primingTimeoutMs: 100 });
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  connection.handleMuxFrame(eventFrame(userEvent(1, 'one', 'm1')));
  check('the priming timer starts with the first buffered frame', seen.length === 0);
  now = 500;
  connection.handleMuxFrame(eventFrame(userEvent(2, 'two', 'm2')));
  check(
    'a caller that never reads history still gets its live rows once the window expires',
    connection.isPrimed && seen.filter((message) => message.type === 'user-message').length === 2,
    String(seen.length),
  );
}

// ── 2. History bounds ───────────────────────────────────────────────────────

{
  const { rpc } = historyClient([{ ok: false }]);
  const connection = new DshSessionConnection(info, { rpc });
  const history = await connection.getHistory();
  check(
    'an unreadable history says so instead of presenting an empty session',
    history.length === 1 && (history[0] as { message: string }).message === DSH_HISTORY_UNAVAILABLE_NOTICE,
  );
}

{
  const { rpc } = historyClient([
    { value: { events: [{ event: userEvent(10, 'newest', 'm10') }], hasMore: true } },
    { ok: false },
  ]);
  const connection = new DshSessionConnection(info, { rpc });
  const history = await connection.getHistory();
  check(
    'a partially read history is reported as partial, with what was read',
    (history[0] as { message?: string }).message === DSH_HISTORY_PARTIAL_NOTICE && history.length === 2,
    JSON.stringify(history.map((message) => message.type)),
  );
}

{
  let seq = 100;
  const { rpc, calls } = historyClient([]);
  // Each page answers with a strictly older event and claims more remains.
  const paging = new DshSessionConnection(info, {
    rpc: new DshRpcClient({
      baseUrl: 'http://h',
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body) as { rpcId: string; payload: { beforeSeq?: number } };
        calls.push(body.payload);
        seq -= 10;
        return {
          status: 200,
          text: async () => JSON.stringify({
            type: 'server-response',
            rpcId: body.rpcId,
            result: { ok: true, value: { events: [{ event: userEvent(seq, `page ${seq}`, `m${seq}`) }], hasMore: true } },
          }),
        };
      },
    }),
    historyMaxPages: 3,
  });
  const history = await paging.getHistory();
  check(
    'backward paging is bounded and says so when it stops short',
    calls.length === 3 && (history[0] as { message?: string }).message === DSH_HISTORY_TRUNCATED_NOTICE,
    `${calls.length} pages`,
  );
  check(
    'each page asks for what is older than the last one read',
    (calls[1] as { beforeSeq?: number }).beforeSeq === 90 && (calls[2] as { beforeSeq?: number }).beforeSeq === 80,
    JSON.stringify(calls),
  );
}

// ── 3. Reconnect and re-baseline ────────────────────────────────────────────

{
  const { rpc } = historyClient([{ value: HISTORY }]);
  const connection = new DshSessionConnection(info, { rpc });
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  await connection.getHistory();

  connection.handleMuxFrame(frame('session/subscribed', { lastSeq: 20 }));
  check(
    'a subscribe whose tail matches what we hold asks for nothing',
    !seen.some((message) => message.type === 'history-reset'),
  );

  connection.handleMuxFrame(frame('session/subscribed', { lastSeq: 40 }));
  const reset = seen.find((message) => message.type === 'history-reset') as { notice?: string } | undefined;
  check(
    'a subscribe whose tail is ahead of ours proves a gap and requests a reload',
    reset?.notice === DSH_RECONNECT_NOTICE,
    JSON.stringify(reset),
  );

  connection.onGenerationLost();
  check('a lost generation re-enters priming', !connection.isPrimed);
  const buffered = seen.length;
  connection.handleMuxFrame(eventFrame(userEvent(41, 'post reconnect', 'm41')));
  check('frames in the new window buffer again', seen.length === buffered);
  await connection.getHistory();
  check(
    'the re-baseline flushes them exactly once',
    seen.filter((message) => (message as { text?: string }).text === 'post reconnect').length === 1,
  );
}

{
  // A live compaction rewrites transcript the client already holds. Only a
  // wholesale reload can make rows disappear.
  const { rpc } = historyClient([{ value: HISTORY }]);
  const connection = new DshSessionConnection(info, { rpc });
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  await connection.getHistory();
  connection.handleMuxFrame(eventFrame({
    type: 'user/message',
    seq: 30,
    time: 1,
    data: { content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' }, id: 'm30' },
    surfaceOp: { op: 'replace', start: 8, end: 18 },
  }));
  const reset = seen.filter((message) => message.type === 'history-reset') as Array<{ semantic?: { kind: string } }>;
  check(
    'a live surface replace asks for a reload instead of appending beside what it shadows',
    reset.length === 1 && reset[0]!.semantic?.kind === 'compaction'
      && !seen.some((message) => (message as { text?: string }).text === 'summary'),
    JSON.stringify(reset),
  );
}

// ── 3b. Control frames bypass the priming buffer ───────────────────────────

{
  // Only `session/event` frames overlap the history seed; every other frame is
  // either idempotent or rpcId-keyed, and `session/subscribed` in particular is
  // the reconnect baseline — buffering it would delay gap detection by the whole
  // priming timeout.
  const { rpc } = historyClient([{ value: HISTORY }]);
  const connection = new DshSessionConnection(info, { rpc });
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));

  // Initial attach, BEFORE any history read: the broker's first read is already
  // coming, so a subscribe here proves nothing and must not request a reload.
  connection.handleMuxFrame(frame('session/subscribed', { lastSeq: 20 }));
  check(
    'the initial subscribe never requests a reload — the first history read is already coming',
    !seen.some((message) => message.type === 'history-reset') && !connection.isPrimed,
  );

  connection.handleMuxFrame(frame('question/requested', {
    type: 'question/requested',
    sessionId: SESSION_ID,
    questions: [{ id: 'q', question: 'Now?', options: [{ label: 'Yes' }] }],
  }, 'rpc-q-early'));
  check(
    'an answerable prompt reaches the user while the connection is still unprimed',
    seen.some((message) => message.type === 'question-request'),
    JSON.stringify(seen.map((message) => message.type)),
  );

  await connection.getHistory();

  // Reconnect with NO gap: the admit gate already holds every delivered seq, so
  // the connection re-primes itself and live frames flow without a re-read.
  connection.onGenerationLost();
  connection.handleMuxFrame(frame('session/subscribed', { lastSeq: 20 }));
  check('a no-gap reconnect re-primes without a history read', connection.isPrimed);
  const before = seen.length;
  connection.handleMuxFrame(eventFrame(userEvent(21, 'flows immediately', 'm21')));
  check(
    'live frames flow immediately after a no-gap reconnect',
    seen.length > before
      && seen.some((message) => (message as { text?: string }).text === 'flows immediately'),
  );

  // Reconnect WITH a gap: the reset is delivered from the subscribe itself —
  // no priming-timeout wait, no history read of the connection's own.
  connection.onGenerationLost();
  const resetsBefore = seen.filter((message) => message.type === 'history-reset').length;
  connection.handleMuxFrame(frame('session/subscribed', { lastSeq: 99 }));
  check(
    'a gapped reconnect requests the reload immediately from the subscribe frame',
    seen.filter((message) => message.type === 'history-reset').length === resetsBefore + 1
      && !connection.isPrimed,
  );
}

// ── 4. Pending prompts ──────────────────────────────────────────────────────

{
  const { rpc } = historyClient([{ value: { events: [], hasMore: false } }]);
  const connection = new DshSessionConnection(info, { rpc });
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  await connection.getHistory();

  const approval = frame('approval/requested', { approvalId: 'ap-1', toolName: 'bash' }, 'rpc-ap-1');
  const question = frame('question/requested', {
    questions: [{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }],
  }, 'rpc-q-1');
  connection.handleMuxFrame(approval);
  connection.handleMuxFrame(question);
  check(
    'answerable frames become cards and enter the pending table under their rpcId',
    seen.filter((message) => message.type === 'permission-request').length === 1
      && seen.filter((message) => message.type === 'question-request').length === 1
      && JSON.stringify(connection.pendingRpcIds()) === JSON.stringify(['rpc-ap-1', 'rpc-q-1']),
    JSON.stringify(connection.pendingRpcIds()),
  );

  // The host replays pending frames VERBATIM on every mux open.
  connection.handleMuxFrame(approval);
  connection.handleMuxFrame(question);
  check(
    'a verbatim replay of a still-pending prompt is a no-op, not a duplicate card',
    seen.filter((message) => message.type === 'permission-request').length === 1
      && seen.filter((message) => message.type === 'question-request').length === 1,
  );
  check(
    'pending cards are replayed to a late client through getPending',
    connection.getPending().length === 2,
  );

  connection.handleMuxFrame(frame('approval/resolved', { approvalId: 'ap-1', outcome: 'allowed-once' }));
  connection.handleMuxFrame(frame('question/resolved', { questionRpcId: 'rpc-q-1', outcome: 'answered' }));
  const resolvedApproval = seen.find((message) => message.type === 'permission-resolved') as { requestId: string; decision: string };
  check(
    'a resolution clears the card by the rpcId the client knows it as',
    resolvedApproval.requestId === 'rpc-ap-1' && resolvedApproval.decision === 'approve'
      && seen.some((message) => message.type === 'question-resolved')
      && connection.pendingRpcIds().length === 0,
    JSON.stringify(resolvedApproval),
  );

  connection.handleMuxFrame(frame('approval/requested', { approvalId: 'ap-2', toolName: 'write' }, 'rpc-ap-2'));
  connection.handleMuxFrame(frame('approval/resolved', { approvalId: 'ap-2', outcome: 'cancelled' }));
  const external = seen.filter((message) => message.type === 'permission-resolved') as Array<{ decision: string }>;
  check(
    'a cancelled approval reads as settled elsewhere, which is normal in a multi-client host',
    external[1]!.decision === 'external',
    JSON.stringify(external),
  );
}

// ── 4b. Pending prompts converge across a generation loss ───────────────────

{
  // The host replays only STILL-pending prompts on a mux reconnect. A card that
  // was settled by another client while this one was disconnected will never
  // see a resolution frame, so the generation loss itself settles every local
  // card as resolved-elsewhere — and the replay reconstructs what truly remains.
  const { rpc } = historyClient([{ value: { events: [], hasMore: false } }]);
  const connection = new DshSessionConnection(info, { rpc });
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  await connection.getHistory();

  connection.handleMuxFrame(frame('approval/requested', { approvalId: 'ap-g', toolName: 'bash' }, 'rpc-ap-g'));
  connection.handleMuxFrame(frame('question/requested', {
    questions: [{ id: 'q', question: 'Still there?', options: [{ label: 'Yes' }] }],
  }, 'rpc-q-g'));
  check('two prompts are pending before the loss', connection.pendingRpcIds().length === 2);

  connection.onGenerationLost();
  const approvals = seen.filter((message) => message.type === 'permission-resolved') as Array<{ requestId: string; decision: string }>;
  const questions = seen.filter((message) => message.type === 'question-resolved') as Array<{ requestId: string }>;
  check(
    'a lost generation settles every local card as resolved-elsewhere and empties the table',
    connection.pendingRpcIds().length === 0
      && approvals.length === 1 && approvals[0]!.requestId === 'rpc-ap-g' && approvals[0]!.decision === 'external'
      && questions.length === 1 && questions[0]!.requestId === 'rpc-q-g',
    JSON.stringify({ approvals, questions }),
  );

  // The replay then re-delivers ONLY what is genuinely still pending.
  connection.handleMuxFrame(frame('question/requested', {
    questions: [{ id: 'q', question: 'Still there?', options: [{ label: 'Yes' }] }],
  }, 'rpc-q-g'));
  check(
    'the verbatim replay reconstructs the prompts that actually remain pending',
    JSON.stringify(connection.pendingRpcIds()) === JSON.stringify(['rpc-q-g'])
      && seen.filter((message) => message.type === 'question-request').length === 2,
  );
}

// ── 4c. Removed sessions and the mutation gate ──────────────────────────────

{
  const { rpc } = historyClient([{ value: { events: [], hasMore: false } }]);
  // Fresh info: removal writes control.drive onto it, and the shared fixture
  // object must not carry that into later blocks.
  const removable: SessionInfo = {
    ...info,
    control: {
      drive: { state: 'driving', supported: true },
      terminalSync: { supported: false, syncAvailable: false, active: false },
    },
  };
  const connection = new DshSessionConnection(removable, { rpc });
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  await connection.getHistory();
  connection.handleMuxFrame(frame('approval/requested', { approvalId: 'ap-r', toolName: 'bash' }, 'rpc-ap-r'));

  // Removal lands MID-TURN: the session is working, which is exactly the state
  // that must be retracted or the broker keeps the live-running latch forever.
  connection.handleHostFrame(frame('host/session-status', { running: true }, 'rpc-h', 'host'));
  check('the session is working when removal lands', removable.status === 'working');

  connection.handleHostFrame(frame('host/session-removed', {}, 'rpc-h', 'host'));
  check(
    'session removal announces itself',
    seen.some((message) => message.type === 'notice'),
  );

  const settled = seen.find((message) => message.type === 'permission-resolved') as { requestId?: string; decision?: string } | undefined;
  check(
    'removal settles pending cards — no resolution frame will ever arrive for them',
    connection.pendingRpcIds().length === 0
      && settled?.requestId === 'rpc-ap-r' && settled?.decision === 'external',
    JSON.stringify({ pending: connection.pendingRpcIds(), settled }),
  );

  const statuses = seen.filter((message) => message.type === 'status') as Array<{ status: string }>;
  const update = seen.find((message) => message.type === 'metadata-update') as {
    key?: string;
    value?: { status?: string; control?: { drive?: { state?: string; supported?: boolean } } };
  } | undefined;
  check(
    'removal retracts the working state and Drive authority, in the model and on the wire',
    removable.status === 'idle'
      && removable.control?.drive.state === 'unavailable'
      && removable.control?.drive.supported === false
      && statuses[statuses.length - 1]?.status === 'idle'
      && update?.key === 'sessionInfo'
      && update.value?.status === 'idle'
      && update.value?.control?.drive?.state === 'unavailable',
    JSON.stringify(update?.value),
  );

  // The two downlinks have no cross-stream ordering, so frames can arrive AFTER
  // the removal. Removal is terminal for TRANSIENT and CONTROL frames: no
  // recreated card, no relatched working state.
  const delivered = seen.length;
  connection.handleMuxFrame(frame('approval/requested', { approvalId: 'ap-late', toolName: 'write' }, 'rpc-ap-late'));
  connection.handleMuxFrame(frame('question/requested', {
    questions: [{ id: 'q', question: 'Late?', options: [{ label: 'Yes' }] }],
  }, 'rpc-q-late'));
  connection.handleMuxFrame(frame('session/queue', { items: [{ id: 'mq', placement: 'queued', message: { content: [{ type: 'text', text: 'late queue' }] } }] }));
  connection.handleHostFrame(frame('host/session-status', { running: true }, 'rpc-h', 'host'));
  connection.handleHostFrame(frame('host/agent-error', { message: 'late error' }, 'rpc-h', 'host'));
  check(
    'late transient and control frames after removal are dropped: no card recreated, no status relatched',
    seen.length === delivered
      && connection.pendingRpcIds().length === 0
      && removable.status === 'idle',
    `${seen.length} vs ${delivered}, pending ${JSON.stringify(connection.pendingRpcIds())}, status ${removable.status}`,
  );

  // But a DURABLE transcript event emitted before the removal and merely
  // delivered late must survive — dropping it could lose the final message of
  // the session permanently. The seq admit gate still applies, so a duplicate
  // of it cannot double-render.
  connection.handleMuxFrame(eventFrame(userEvent(60, 'final words', 'm60')));
  connection.handleMuxFrame(eventFrame(userEvent(60, 'final words', 'm60')));
  check(
    'a durable transcript event delivered after removal is preserved exactly once',
    seen.length === delivered + 1
      && seen.some((message) => (message as { text?: string }).text === 'final words')
      && removable.status === 'idle',
    `${seen.length} vs ${delivered}`,
  );

  const refusals: string[] = [];
  await connection.sendPrompt({ text: 'gone' }).catch((error: Error) => refusals.push(error.message));
  await connection.respondPermission('rpc-ap-r', 'approve').catch((error: Error) => refusals.push(error.message));
  await connection.answerQuestion('rpc-ap-r', [['x']]).catch((error: Error) => refusals.push(error.message));
  await connection.runCommand('stop').catch((error: Error) => refusals.push(error.message));
  check(
    'every mutation is refused once the host says the session is gone',
    refusals.length === 4 && refusals.every((message) => message.includes('removed from the DeepSeek Harness host')),
    JSON.stringify(refusals),
  );
}

{
  // The link-level readiness seam: while the owning host link is unverified
  // (first probe, or re-verifying after a generation loss), mutations refuse.
  const { rpc } = historyClient([{ value: { events: [], hasMore: false } }]);
  let ready = false;
  const connection = new DshSessionConnection(info, { rpc, mutationReady: () => ready });
  await connection.getHistory();

  let unready = '';
  await connection.sendPrompt({ text: 'hold' }).catch((error: Error) => { unready = error.message; });
  check(
    'a mutation against an unverified generation is refused before any RPC is made',
    unready.includes('re-verifying'),
    unready,
  );

  ready = true;
  let drove = true;
  await connection.sendPrompt({ text: 'go' }).catch(() => { drove = false; });
  check('the same mutation flows once the link reports ready', drove);
}

// ── 5. Snapshots and projections ────────────────────────────────────────────

{
  const { rpc } = historyClient([{ value: HISTORY }]);
  const connection = new DshSessionConnection(info, { rpc });
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  await connection.getHistory();

  const overlays = await connection.getHistoryOverlays();
  check(
    'the seeded projections surface as current-state overlays, not as transcript',
    overlays.some((message) => message.type === 'metadata-update' && message.key === 'sessionInfo')
      && overlays.some((message) => message.type === 'metadata-update' && message.key === 'contextUsage'),
    JSON.stringify(overlays.map((message) => (message as { key?: string }).key)),
  );

  connection.handleMuxFrame(frame('session/projection', { key: 'title', value: 'renamed', seq: 40 }));
  connection.handleMuxFrame(frame('session/projection', { key: 'title', value: 'stale', seq: 5 }));
  const titles = seen.filter((message) => message.type === 'metadata-update') as Array<{ value: { title?: string } }>;
  check(
    'a projection frame updates under higher-seq-wins and a late lower-seq value is refused',
    titles.length === 1 && titles[0]!.value.title === 'renamed' && connection.projectionValue('title') === 'renamed',
    JSON.stringify(titles),
  );

  connection.handleMuxFrame(frame('session/projection', { key: 'community-plugin/state', value: { x: 1 }, seq: 41 }));
  check(
    'an unknown projection key is kept and readable, and puts nothing on the wire',
    connection.projectionKeys().includes('community-plugin/state')
      && seen.filter((message) => message.type === 'metadata-update').length === 1,
  );

  connection.handleMuxFrame(frame('session/queue', {
    items: [
      { id: 'msg-9', placement: 'queued', message: { content: [{ type: 'text', text: 'waiting' }] } },
      { id: 'msg-10', placement: 'context', message: { content: [{ type: 'text', text: 'invisible' }] } },
    ],
  }));
  const queued = seen.filter((message) => (message as { queued?: boolean }).queued === true) as Array<{ key: string; text: string }>;
  check(
    'queued inbox items render as dimmed bubbles keyed by the native message id; context items stay invisible',
    queued.length === 1 && queued[0]!.text === 'waiting' && queued[0]!.key.endsWith(':msg:msg-9'),
    JSON.stringify(queued),
  );

  connection.handleMuxFrame(frame('session/jobs', { jobs: [{ id: 'bash-1', kind: 'bash', status: 'running' }] }));
  check(
    'the authoritative jobs snapshot is held rather than rendered as an invented card',
    connection.jobsSnapshot().length === 1
      && !seen.some((message) => message.type === 'agent-activity'),
  );

  const before = seen.length;
  connection.handleMuxFrame(frame('session/future-frame', { anything: true }));
  check('an unknown mux frame type renders nothing and breaks nothing', seen.length === before);

  connection.handleHostFrame(frame('host/session-status', { running: true }, 'rpc-h', 'host'));
  connection.handleHostFrame(frame('host/agent-error', { message: 'model unavailable' }, 'rpc-h', 'host'));
  check(
    'host frames drive session status and surface agent errors',
    connection.info.status === 'working'
      && (seen.find((message) => message.type === 'status') as { status: string }).status === 'running'
      && (seen.find((message) => message.type === 'error') as { message: string }).message === 'model unavailable',
  );

  let closedId = '';
  const closing = new DshSessionConnection(info, { rpc, onClosed: (id) => { closedId = id; } });
  await closing.close();
  await closing.close();
  check('close is idempotent and tells its owner once', closedId === SESSION_ID);
}

// ── 5b. Fork-child totals suppression ───────────────────────────────────────

{
  // A forked session's sessionStats folds the whole PHYSICAL log upstream, so
  // it includes the inherited parent prefix the parent already publishes under
  // its own session — a child (parentThreadId set) emits no runtimeTotals,
  // live or via overlays, while its other projections still flow.
  const childInfo: SessionInfo = { ...info, parentThreadId: 'parent-session' };
  const { rpc } = historyClient([{ value: HISTORY }]);
  const child = new DshSessionConnection(childInfo, { rpc });
  const seen: AgentMessage[] = [];
  child.subscribe((message) => seen.push(message));
  await child.getHistory();

  child.handleMuxFrame(frame('session/projection', { key: 'sessionStats', value: { turns: 3, llmMs: 900, toolMs: 40 }, seq: 42 }));
  child.handleMuxFrame(frame('session/projection', { key: 'title', value: 'child renamed', seq: 43 }));
  const totals = seen.filter((message) => message.type === 'metadata-update' && message.key === 'runtimeTotals');
  const titles = seen.filter((message) => message.type === 'metadata-update' && message.key === 'sessionInfo');
  check(
    'a fork child publishes no runtimeTotals from sessionStats, live or seeded, but keeps other projections',
    totals.length === 0 && titles.length === 1
      && !(await child.getHistoryOverlays()).some((message) => message.type === 'metadata-update' && message.key === 'runtimeTotals'),
    JSON.stringify(totals),
  );

  // The same frame on a ROOT session still publishes its totals.
  const { rpc: rootRpc } = historyClient([{ value: HISTORY }]);
  const root = new DshSessionConnection(info, { rpc: rootRpc });
  const rootSeen: AgentMessage[] = [];
  root.subscribe((message) => rootSeen.push(message));
  await root.getHistory();
  root.handleMuxFrame(frame('session/projection', { key: 'sessionStats', value: { turns: 3, llmMs: 900, toolMs: 40 }, seq: 42 }));
  check(
    'a root session still publishes sessionStats as runtimeTotals',
    rootSeen.some((message) => message.type === 'metadata-update' && message.key === 'runtimeTotals'),
  );
}

// ── 5c. Projection reconciliation against live frames and host restarts ────

{
  // The history cut is a STALE-OK baseline: a live projection applied while
  // the history RPC was still pending is NEWER than the cut and must survive
  // seeding — same key (baseline value refused) and omitted key alike.
  let release: ((value: unknown) => void) | undefined;
  const fetchImpl: DshFetch = (_url, init) => new Promise((resolve) => {
    const body = JSON.parse((init as { body: string }).body) as { rpcId: string };
    release = (value) => resolve({
      status: 200,
      text: async () => JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }),
    });
  });
  const connection = new DshSessionConnection(info, { rpc: new DshRpcClient({ baseUrl: 'http://h', fetchImpl }) });
  const reading = connection.getHistory(); // history RPC in flight
  connection.handleMuxFrame(frame('session/projection', { key: 'title', value: 'live title', seq: 30 }));
  connection.handleMuxFrame(frame('session/projection', { key: 'live-plugin/state', value: { fresh: true }, seq: 30 }));
  release!(HISTORY); // baseline as-of seq 20, omitting live-plugin/state
  await reading;
  check(
    'a projection applied while the history RPC was pending survives the seed',
    connection.projectionValue('title') === 'live title'
      && JSON.stringify(connection.projectionValue('live-plugin/state')) === JSON.stringify({ fresh: true }),
    JSON.stringify([connection.projectionValue('title'), connection.projectionValue('live-plugin/state')]),
  );

  // A session/subscribed whose tail is BEHIND a held row proves a restarted
  // host: that row belonged to the previous generation and is truncated,
  // while rows at or below the tail stay.
  connection.handleMuxFrame(frame('session/subscribed', { lastSeq: 20 }));
  check(
    "session/subscribed truncates rows beyond a restarted host's tail",
    connection.projectionValue('title') === undefined
      && connection.projectionValue('live-plugin/state') === undefined
      && connection.projectionValue('sessionStats') !== undefined,
    JSON.stringify(connection.projectionKeys()),
  );
}

// ── 5d. Host restart convergence ────────────────────────────────────────────

{
  // A tail BEHIND delivered state is a restarted host: projection rows beyond
  // the tail were already DELIVERED, transcript rows beyond it are stale, and
  // the new host reuses those seqs. Rollback must retract via history-reset,
  // truncate the projections, and rewind the admit gate so a replacement
  // seq 21 is new content, not a duplicate.
  const { rpc } = historyClient([{ value: HISTORY }]);
  const connection = new DshSessionConnection(info, { rpc });
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  await connection.getHistory();

  connection.handleMuxFrame(eventFrame(userEvent(21, 'previous generation', 'm21')));
  connection.handleMuxFrame(frame('session/projection', { key: 'title', value: 'old title', seq: 30 }));
  check(
    'setup: the previous generation delivered a transcript row and a title beyond seq 20',
    seen.some((message) => (message as { text?: string }).text === 'previous generation')
      && connection.projectionValue('title') === 'old title',
  );

  const resetsBefore = seen.filter((message) => message.type === 'history-reset').length;
  connection.handleMuxFrame(frame('session/subscribed', { lastSeq: 20 }));
  check(
    'a lower tail retracts delivered state: history-reset, re-priming, truncated projections',
    seen.filter((message) => message.type === 'history-reset').length === resetsBefore + 1
      && !connection.isPrimed
      && connection.projectionValue('title') === undefined
      && connection.projectionValue('sessionStats') !== undefined,
  );

  // The broker's wholesale re-read re-primes; then the restarted host's OWN
  // seq 21 — different content, reused number — must be admitted.
  await connection.getHistory();
  connection.handleMuxFrame(eventFrame(userEvent(21, 'new generation', 'm21-new')));
  check(
    'a reused sequence number from the restarted host is accepted as new content',
    seen.filter((message) => (message as { text?: string }).text === 'new generation').length === 1,
    JSON.stringify(seen.filter((message) => message.type === 'user-message').map((message) => (message as { text?: string }).text)),
  );
}

// ── 9. History reads never corrupt the live temporal fold ───────────────────

const OPEN_TURN_EVENTS = [
  { event: { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } } },
  { event: { type: 'step/start', seq: 2, time: 1100, data: { turn: 1, step: 1 } } },
] as unknown as DshHistoryEntry[];

function liveAssistant(seq: number, time: number, text: string): Record<string, unknown> {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] }, usage: { inputTokens: 5, outputTokens: 1 } },
    surfaceOp: 'append',
  };
}

{
  // A second getHistory (another client attaching) while a turn is open must
  // not fence the live fold's turn as a cancelled predecessor.
  const { rpc } = historyClient([{ value: { events: OPEN_TURN_EVENTS, hasMore: false } }]);
  const connection = new DshSessionConnection(info, { rpc });
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  await connection.getHistory();

  connection.handleMuxFrame(eventFrame(liveAssistant(3, 1500, 'live reply')));
  const reread = await connection.getHistory();
  check(
    'a late history read during an open turn emits no cancelled fence',
    !reread.some((message) => message.type === 'run-summary' && (message as { status: string }).status === 'cancelled')
      && !seen.some((message) => message.type === 'run-summary' && (message as { status: string }).status === 'cancelled'),
  );

  connection.handleMuxFrame(eventFrame({ type: 'turn/end', seq: 4, time: 1600, data: { turn: 1, reason: { kind: 'completed' } } }));
  const close = seen.find((message) => message.type === 'run-summary' && (message as { status: string }).status === 'done') as
    Record<string, unknown> | undefined;
  check(
    'the live fold still closes the turn with its native timing and usage',
    close?.totalRuntimeMs === 600 && close?.agentRuntimeMs === 400
      && JSON.stringify(close?.tokens) === JSON.stringify({ input: 5, output: 1, cacheRead: 0, cacheWrite: 0 }),
    JSON.stringify(close),
  );
}

{
  // A live frame landing MID-READ (between pages of a late client's paginated
  // history) advances the live fold; the replay must not rewind it.
  let releaseOlderPage!: () => void;
  const olderPageReady = new Promise<void>((resolve) => { releaseOlderPage = resolve; });
  let call = 0;
  const fetchImpl: DshFetch = async (_url, init) => {
    const body = JSON.parse((init as { body: string }).body) as { rpcId: string };
    call += 1;
    let value: unknown = { events: [], hasMore: false };
    if (call === 2) value = { events: OPEN_TURN_EVENTS, hasMore: true };
    if (call === 3) {
      await olderPageReady;
      value = { events: [{ event: userEvent(0, 'ancient', 'm0') }], hasMore: false };
    }
    return {
      status: 200,
      text: async () => JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }),
    };
  };
  const connection = new DshSessionConnection(info, { rpc: new DshRpcClient({ baseUrl: 'http://h', fetchImpl }) });
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  await connection.getHistory(); // call 1: empty initial read, primes

  connection.handleMuxFrame(eventFrame(OPEN_TURN_EVENTS[0]!.event as unknown as Record<string, unknown>));
  connection.handleMuxFrame(eventFrame(OPEN_TURN_EVENTS[1]!.event as unknown as Record<string, unknown>));

  const rereadPromise = connection.getHistory(); // call 2 (tail) → call 3 (deferred)
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the tail page land
  connection.handleMuxFrame(eventFrame(liveAssistant(3, 1500, 'mid-read reply')));
  releaseOlderPage();
  const reread = await rereadPromise;

  connection.handleMuxFrame(eventFrame({ type: 'turn/end', seq: 4, time: 1600, data: { turn: 1, reason: { kind: 'completed' } } }));
  const close = seen.find((message) => message.type === 'run-summary' && (message as { status: string }).status === 'done') as
    Record<string, unknown> | undefined;
  check(
    'a live event during a paginated read is neither lost nor rewound by the replay',
    seen.filter((message) => (message as { text?: string }).text === 'mid-read reply').length === 1
      && close?.totalRuntimeMs === 600 && close?.agentRuntimeMs === 400,
    JSON.stringify(close),
  );
  check(
    'the interleaved read still returns its rows without fencing the live turn',
    reread.some((message) => (message as { text?: string }).text === 'ancient')
      && !reread.some((message) => message.type === 'run-summary' && (message as { status: string }).status === 'cancelled'),
  );
}

{
  // Reconnect recovery during an open turn: the gapped subscribe re-enters
  // priming, the wholesale re-read seeds the live fold from the complete
  // snapshot, and the buffered live tail closes the turn timed.
  const rereadEvents = [
    ...OPEN_TURN_EVENTS,
    { event: liveAssistant(3, 1500, 'pre-gap reply') },
  ] as unknown as DshHistoryEntry[];
  let call = 0;
  const fetchImpl: DshFetch = async (_url, init) => {
    const body = JSON.parse((init as { body: string }).body) as { rpcId: string };
    call += 1;
    const value = call === 1 ? { events: [], hasMore: false } : { events: rereadEvents, hasMore: false };
    return {
      status: 200,
      text: async () => JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }),
    };
  };
  const connection = new DshSessionConnection(info, { rpc: new DshRpcClient({ baseUrl: 'http://h', fetchImpl }) });
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  await connection.getHistory();

  connection.handleMuxFrame(eventFrame(OPEN_TURN_EVENTS[0]!.event as unknown as Record<string, unknown>));
  connection.handleMuxFrame(eventFrame(OPEN_TURN_EVENTS[1]!.event as unknown as Record<string, unknown>));
  connection.handleMuxFrame(frame('session/subscribed', { lastSeq: 9 }));
  check('a gapped reconnect during an open turn re-enters priming', !connection.isPrimed);

  connection.handleMuxFrame(eventFrame({ type: 'turn/end', seq: 4, time: 1600, data: { turn: 1, reason: { kind: 'completed' } } }));
  await connection.getHistory(); // the broker's wholesale re-read re-primes
  const close = seen.find((message) => message.type === 'run-summary' && (message as { status: string }).status === 'done') as
    Record<string, unknown> | undefined;
  check(
    'the re-seeded live fold closes the recovered turn with native timing',
    close?.totalRuntimeMs === 600 && close?.agentRuntimeMs === 400
      && JSON.stringify(close?.tokens) === JSON.stringify({ input: 5, output: 1, cacheRead: 0, cacheWrite: 0 }),
    JSON.stringify(close),
  );
}

// ── 9. The permission-mode chip ─────────────────────────────────────────────

{
  // The host publishes the roster AND the current value in ONE `permissions`
  // projection, and republishes the whole thing on every switch. The adapter
  // held it only for the picker and an "already in this mode" short-circuit, so
  // the chip stayed blank while the host had plainly reported a mode.
  //
  // `currentMode` is the contract field the picker preselects from. The broker
  // Object.assigns this value onto SessionInfo, so any other key would land
  // silently and read as blank — asserted by name, not by shape.
  const permissions = (currentValue: string) => ({
    options: [
      { value: 'read-only', name: 'Read only' },
      { value: 'auto-edit', name: 'Auto edit' },
    ],
    currentValue,
  });
  const seeded = (values: Record<string, unknown>) => historyClient([{
    value: { events: [], hasMore: false, projections: { asOfSeq: 1, values } },
  }]);

  {
    const { rpc } = seeded({ permissions: permissions('auto-edit') });
    const connection = new DshSessionConnection(info, { rpc });
    await connection.getHistory();
    const overlays = await connection.getHistoryOverlays() as Array<{ type: string; key?: string; value?: unknown }>;
    const chip = overlays.filter((message) => message.type === 'metadata-update' && message.key === 'sessionInfo');
    check(
      'the attach-time replay publishes the host permission mode as currentMode',
      chip.length === 1 && JSON.stringify(chip[0]!.value) === JSON.stringify({ currentMode: 'auto-edit' }),
      JSON.stringify(overlays),
    );
  }

  {
    const { rpc } = seeded({ permissions: permissions('read-only') });
    const connection = new DshSessionConnection(info, { rpc });
    await connection.getHistory();
    const seen: AgentMessage[] = [];
    connection.subscribe((message) => seen.push(message));
    connection.handleMuxFrame(frame('session/projection', { key: 'permissions', value: permissions('auto-edit'), seq: 50 }));
    const updates = seen.filter((message) =>
      message.type === 'metadata-update' && message.key === 'sessionInfo'
    ) as Array<{ value: { currentMode?: string } }>;
    check(
      'a live permissions republish moves the chip to the new mode',
      updates.length === 1 && updates[0]!.value.currentMode === 'auto-edit',
      JSON.stringify(seen),
    );
  }

  {
    // "The host reported no mode" is not a mode, and it is published as an
    // EXPLICIT clear: the broker folds the value with Object.assign, so an
    // omitted key would leave the previous mode on the chip after the host
    // withdrew it.
    const { rpc } = seeded({ permissions: permissions('') });
    const connection = new DshSessionConnection(info, { rpc });
    await connection.getHistory();
    const seen: AgentMessage[] = [];
    connection.subscribe((message) => seen.push(message));
    const overlays = await connection.getHistoryOverlays();
    connection.handleMuxFrame(frame('session/projection', { key: 'permissions', value: { options: [] }, seq: 51 }));
    const clears = (rows: AgentMessage[]) => rows.filter((message) =>
      message.type === 'metadata-update' && message.key === 'sessionInfo'
      && typeof message.value === 'object' && message.value !== null
      && 'currentMode' in message.value && (message.value as { currentMode?: unknown }).currentMode === undefined);
    check(
      'an empty or absent currentValue publishes an EXPLICIT clear, live and on replay',
      clears(overlays).length === 1 && clears(seen).length === 1,
      JSON.stringify({ overlays, seen }),
    );
  }
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
