#!/usr/bin/env bun
/**
 * C2R: OpenCode assistant completion telemetry is not a live terminal fence.
 *
 * Drives the real adapter against one fake server-wide OpenCode HTTP/SSE bus. The fixture covers
 * app prompts and terminal-originated prompts, active attach/history reconciliation, native
 * error/abort fences, stale-fence ownership, bounded assistant state, duplicate events, and two
 * interleaved sessions without a model or live OpenCode process.
 */
export {};

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '../../../adapter-api/src/index.ts';
import { OpenCodeAdapter } from '../../../adapters/opencode/src/index.ts';
import { AttentionPolicy } from '../../src/attention/attention-policy.ts';
import { AttentionStore } from '../../src/attention/attention-store.ts';

type OpenCodeStatus = { type: 'idle' | 'busy' | 'retry' };
type OpenCodeRow = { info: any; parts: any[] };
type Connection = Awaited<ReturnType<OpenCodeAdapter['attach']>>;

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'cosyncing-opencode-c2r-'));
const DATA_DIR = join(TEST_ROOT, 'opencode-data');
const WORKTREE = join(TEST_ROOT, 'worktree');
mkdirSync(join(DATA_DIR, 'storage', 'session'), { recursive: true });
mkdirSync(WORKTREE, { recursive: true });

const sessionIds = [
  'ses_app',
  'ses_tui',
  'ses_compaction_continue',
  'ses_active_history',
  'ses_busy_trailing_user',
  'ses_historical',
  'ses_stale',
  'ses_idle_existing_then_other',
  'ses_error_existing_then_other',
  'ses_idle_no_assistant',
  'ses_idle_first',
  'ses_error',
  'ses_error_first',
  'ses_cancel',
  'ses_bounded',
  'ses_cross_a',
  'ses_cross_b',
] as const;
const sessions = sessionIds.map((id, index) => ({
  id,
  slug: id,
  directory: WORKTREE,
  title: `C2R ${id}`,
  time: { created: 1_800_000_000_000 + index, updated: 1_800_000_000_100 + index },
}));
const rows = new Map<string, OpenCodeRow[]>(sessionIds.map((id) => [id, []]));
const statusSnapshot: Record<string, OpenCodeStatus> = {};
const promptBodies = new Map<string, any[]>();
const eventClients = new Set<ReadableStreamDefaultController>();
const openConnections = new Set<Connection>();

function setBusy(id: string, busy: boolean): void {
  if (busy) statusSnapshot[id] = { type: 'busy' };
  else delete statusSnapshot[id];
}

function sendEvent(event: unknown): void {
  const frame = new TextEncoder().encode(`data: ${JSON.stringify({ payload: event })}\n\n`);
  for (const client of [...eventClients]) {
    try {
      client.enqueue(frame);
    } catch {
      eventClients.delete(client);
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  assert.ok(predicate(), 'timed out waiting for the expected OpenCode fixture state');
}

function userInfo(id: string, created: number): any {
  return { id, role: 'user', time: { created } };
}

function assistantInfo(input: {
  id: string;
  userId: string;
  created: number;
  completed?: number;
  finish?: string;
  error?: any;
  tokens?: any;
}): any {
  return {
    id: input.id,
    role: 'assistant',
    parentID: input.userId,
    time: {
      created: input.created,
      ...(input.completed === undefined ? {} : { completed: input.completed }),
    },
    ...(input.finish === undefined ? {} : { finish: input.finish }),
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.tokens === undefined ? {} : { tokens: input.tokens }),
  };
}

function sendMessageUpdated(sessionID: string, info: any): void {
  sendEvent({ type: 'message.updated', properties: { sessionID, info } });
}

function sendAssistantPart(sessionID: string, messageID: string, partID: string, text = 'answer'): void {
  sendEvent({
    type: 'message.part.updated',
    properties: {
      sessionID,
      part: { id: partID, messageID, sessionID, type: 'text', text },
    },
  });
}

function summaries(messages: AgentMessage[]): Array<Extract<AgentMessage, { type: 'run-summary' }>> {
  return messages.filter((message): message is Extract<AgentMessage, { type: 'run-summary' }> =>
    message.type === 'run-summary');
}

function terminals(messages: AgentMessage[]): Array<Extract<AgentMessage, { type: 'run-summary' }>> {
  return summaries(messages).filter((message) => message.status !== 'running');
}

let server: ReturnType<typeof Bun.serve> | undefined;
for (let attempt = 0; attempt < 20 && !server; attempt++) {
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 49_000 + Math.floor(Math.random() * 15_000),
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/global/event') {
          return new Response(new ReadableStream({
            start(controller) {
              eventClients.add(controller);
              controller.enqueue(new TextEncoder().encode(': connected\n\n'));
            },
            cancel() {
              // Pruned on the next event or final cleanup.
            },
          }), { headers: { 'content-type': 'text/event-stream' } });
        }
        if (url.pathname === '/project') return Response.json([{ worktree: WORKTREE }]);
        if (url.pathname === '/session' && req.method === 'GET') return Response.json(sessions);
        if (url.pathname === '/session/status') return Response.json(structuredClone(statusSnapshot));
        if (url.pathname === '/question' || url.pathname === '/permission') return Response.json([]);

        const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
        if (messageMatch && req.method === 'GET') {
          return Response.json(rows.get(decodeURIComponent(messageMatch[1]!)) ?? []);
        }
        const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
        if (promptMatch && req.method === 'POST') {
          const id = decodeURIComponent(promptMatch[1]!);
          const bodies = promptBodies.get(id) ?? [];
          bodies.push(await req.json());
          promptBodies.set(id, bodies);
          return new Response(null, { status: 204 });
        }
        const sessionMatch = url.pathname.match(/^\/session\/([^/]+)$/);
        if (sessionMatch && req.method === 'GET') {
          const found = sessions.find((candidate) => candidate.id === decodeURIComponent(sessionMatch[1]!));
          return found ? Response.json(found) : new Response('not found', { status: 404 });
        }
        return new Response('not found', { status: 404 });
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
  }
}
if (!server) throw new Error('Could not allocate an OpenCode C2R test port after 20 attempts.');

const attentionRoot = join(TEST_ROOT, 'attention');
let attentionId = 0;
let attentionNow = 2_000_000_000_000;
const attentionStore = new AttentionStore({
  home: attentionRoot,
  now: () => attentionNow,
  idFactory: () => `attention-${++attentionId}`,
});
const attentionPolicy = new AttentionPolicy(attentionStore, {
  now: () => attentionNow,
});
const pendingAttention = new Set<Promise<void>>();

async function drainAttention(): Promise<void> {
  while (pendingAttention.size > 0) await Promise.all([...pendingAttention]);
}

async function attach(
  adapter: OpenCodeAdapter,
  id: string,
  options: { attention?: boolean } = {},
): Promise<{ conn: Connection; live: AgentMessage[] }> {
  const conn = await adapter.attach(id, 'live');
  openConnections.add(conn);
  const live: AgentMessage[] = [];
  conn.subscribe((message) => {
    live.push(message);
    if (!options.attention) return;
    let task!: Promise<void>;
    task = attentionPolicy.handleMessage(conn.info, message).finally(() => pendingAttention.delete(task));
    pendingAttention.add(task);
  });
  return { conn, live };
}

async function closeConnection(conn: Connection): Promise<void> {
  openConnections.delete(conn);
  await conn.close();
}

const baseUrl = `http://127.0.0.1:${server.port}`;
const adapter = new OpenCodeAdapter({
  baseUrl,
  storageDir: DATA_DIR,
  sseIdleMs: 30_000,
  sseReconnectMs: 1000,
});

try {
  // App-driven turn: native message completion is buffered; idle emits one stable final summary and
  // the same frame is the first point at which Attention can produce run-finished.
  {
    const id = 'ses_app';
    const { conn, live } = await attach(adapter, id, { attention: true });
    await conn.sendPrompt?.({ text: 'app turn', clientMessageId: 'client-app-1' });
    const body = promptBodies.get(id)?.at(-1);
    const userId = body?.messageID;
    assert.equal(typeof userId, 'string', 'app prompt carries native message identity');
    const assistantId = 'msg_app_assistant';
    const partId = 'prt_app_assistant';
    const startedAt = 1_800_100_000_000;
    const completedAt = startedAt + 75_000;

    sendEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
    sendMessageUpdated(id, userInfo(userId, startedAt - 100));
    sendMessageUpdated(id, assistantInfo({ id: assistantId, userId, created: startedAt }));
    sendAssistantPart(id, assistantId, partId);
    attentionNow += 75_000;
    sendMessageUpdated(id, assistantInfo({
      id: assistantId,
      userId,
      created: startedAt,
      completed: completedAt,
      finish: 'stop',
      tokens: { input: 11, output: 7, cache: { read: 3, write: 2 } },
    }));
    await waitFor(() => summaries(live).length > 0);
    await drainAttention();

    assert.equal(terminals(live).length, 0, 'message completion emits no terminal run-summary before idle');
    assert.ok(
      summaries(live).some((summary) => summary.status === 'running'),
      'live assistant telemetry creates a running summary before idle',
    );
    assert.equal(
      attentionStore.findByDedupeKey(`run-finished:opencode:${id}:${assistantId}`),
      undefined,
      'Attention emits no run-finished before idle',
    );
    assert.equal(
      live.some((message) => message.type === 'status' && message.status === 'idle'),
      false,
      'message completion does not synthesize idle',
    );

    setBusy(id, false);
    sendEvent({ type: 'session.idle', properties: { sessionID: id } });
    await waitFor(() => terminals(live).length === 1);
    await drainAttention();
    const [running] = summaries(live).filter((summary) => summary.status === 'running');
    const [final] = terminals(live);
    assert.deepEqual(
      {
        key: final?.key,
        turnId: final?.turnId,
        userMessageKey: final?.userMessageKey,
        assistantMessageKey: final?.assistantMessageKey,
        status: final?.status,
        startedAt: final?.startedAt,
        completedAt: final?.completedAt,
        totalRuntimeMs: final?.totalRuntimeMs,
      },
      {
        key: `opencode:run:${assistantId}`,
        turnId: assistantId,
        userMessageKey: userId,
        assistantMessageKey: partId,
        status: 'done',
        startedAt,
        completedAt,
        totalRuntimeMs: 75_000,
      },
      'idle finalizes the buffered native telemetry with correct ownership and timing',
    );
    assert.equal(running?.key, final?.key, 'running and final summaries use one stable identity');
    assert.ok(
      live.findIndex((message) => message.type === 'status' && message.status === 'idle')
        < live.findIndex((message) => message.type === 'run-summary' && message.status === 'done'),
      'authoritative idle reaches the client before terminal footer data',
    );
    assert.equal(
      attentionStore.findByDedupeKey(`run-finished:opencode:${id}:${assistantId}`)?.state,
      'resolved',
      'Attention consumes the corrected post-idle terminal summary',
    );

    sendMessageUpdated(id, assistantInfo({
      id: assistantId,
      userId,
      created: startedAt,
      completed: completedAt,
      finish: 'stop',
    }));
    sendEvent({ type: 'session.idle', properties: { sessionID: id } });
    sendEvent({ type: 'session.idle', properties: { sessionID: id } });
    await Bun.sleep(100);
    await drainAttention();
    assert.equal(terminals(live).length, 1, 'duplicate completion and idle events stay idempotent');
    assert.equal(
      attentionStore.listEvents().filter((event) =>
        event.dedupeKey === `run-finished:opencode:${id}:${assistantId}`).length,
      1,
      'duplicate completion and idle produce exactly one Attention event',
    );
    await closeConnection(conn);
  }

  // A prompt originating in an attached TUI has the same global-event transition as an app prompt.
  {
    const id = 'ses_tui';
    const promptCountBefore = promptBodies.get(id)?.length ?? 0;
    const { conn, live } = await attach(adapter, id);
    const userId = 'msg_tui_user';
    const assistantId = 'msg_tui_assistant';
    const startedAt = 1_800_200_000_000;
    const completedAt = startedAt + 5000;
    sendEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
    sendMessageUpdated(id, userInfo(userId, startedAt - 100));
    sendMessageUpdated(id, assistantInfo({ id: assistantId, userId, created: startedAt }));
    sendAssistantPart(id, assistantId, 'prt_tui_assistant');
    sendMessageUpdated(id, assistantInfo({
      id: assistantId,
      userId,
      created: startedAt,
      completed: completedAt,
      finish: 'stop',
    }));
    await waitFor(() => summaries(live).some((summary) => summary.status === 'running'));
    assert.equal(terminals(live).length, 0, 'attached-TUI completion stays running before idle');
    setBusy(id, false);
    sendEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'idle' } } });
    await waitFor(() => terminals(live).length === 1);
    assert.equal(terminals(live)[0]?.status, 'done');
    assert.equal(promptBodies.get(id)?.length ?? 0, promptCountBefore, 'TUI fixture did not use app send');
    await closeConnection(conn);
  }

  // Automatic compaction can continue the same native turn. It must reset history without changing
  // Working, finalizing the footer, or notifying Attention before the later authoritative idle.
  {
    const id = 'ses_compaction_continue';
    const { conn, live } = await attach(adapter, id, { attention: true });
    const userId = 'msg_compaction_u';
    const assistantId = 'msg_compaction_a';
    const startedAt = 1_800_250_000_000;
    sendEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
    sendMessageUpdated(id, userInfo(userId, startedAt - 100));
    sendMessageUpdated(id, assistantInfo({
      id: assistantId,
      userId,
      created: startedAt,
      completed: startedAt + 3000,
      finish: 'stop',
    }));
    await waitFor(() => summaries(live).some((summary) => summary.turnId === assistantId));
    sendEvent({ type: 'session.compacted', properties: { sessionID: id } });
    await waitFor(() => live.some((message) =>
      message.type === 'history-reset'
      && message.semantic?.kind === 'compaction'));
    await drainAttention();

    const statusAfterCompaction = live.findLast((message) => message.type === 'status');
    assert.equal(
      statusAfterCompaction?.type === 'status' ? statusAfterCompaction.status : undefined,
      'running',
      'session.compacted preserves Working while OpenCode continues the turn',
    );
    assert.equal(terminals(live).length, 0, 'compaction emits no terminal footer');
    assert.equal(
      attentionStore.listEvents().some((event) =>
        event.sessionId === id && (event.kind === 'run-finished' || event.kind === 'run-failed')),
      false,
      'compaction emits no terminal Attention event',
    );

    setBusy(id, false);
    sendEvent({ type: 'session.idle', properties: { sessionID: id } });
    await waitFor(() => terminals(live).length === 1);
    await drainAttention();
    assert.equal(terminals(live)[0]?.status, 'done');
    assert.equal(
      attentionStore.findByDedupeKey(`run-finished:opencode:${id}:${assistantId}`)?.state,
      'resolved',
      'the subsequent authoritative idle finalizes and notifies exactly once',
    );
    await closeConnection(conn);
  }

  // Active attach/reconnect: only the newest persisted assistant completion is fenced. The previous
  // completed turn keeps its footer data; the active row is running until idle.
  {
    const id = 'ses_active_history';
    const firstStart = 1_800_300_000_000;
    const secondStart = firstStart + 10_000;
    rows.set(id, [
      {
        info: userInfo('msg_history_u1', firstStart - 100),
        parts: [{ id: 'prt_history_u1', type: 'text', text: 'first', messageID: 'msg_history_u1', sessionID: id }],
      },
      {
        info: assistantInfo({
          id: 'msg_history_a1',
          userId: 'msg_history_u1',
          created: firstStart,
          completed: firstStart + 4000,
          finish: 'stop',
        }),
        parts: [{ id: 'prt_history_a1', type: 'text', text: 'first answer', messageID: 'msg_history_a1', sessionID: id }],
      },
      {
        info: userInfo('msg_history_u2', secondStart - 100),
        parts: [{ id: 'prt_history_u2', type: 'text', text: 'second', messageID: 'msg_history_u2', sessionID: id }],
      },
      {
        info: assistantInfo({
          id: 'msg_history_a2',
          userId: 'msg_history_u2',
          created: secondStart,
          completed: secondStart + 4000,
          finish: 'stop',
        }),
        parts: [{ id: 'prt_history_a2', type: 'text', text: 'still working', messageID: 'msg_history_a2', sessionID: id }],
      },
    ]);
    setBusy(id, true);
    const firstAttach = await attach(adapter, id);
    const firstHistory = await firstAttach.conn.getHistory();
    const firstRuns = summaries(firstHistory);
    assert.equal(firstRuns.find((summary) => summary.turnId === 'msg_history_a1')?.status, 'done');
    const active = firstRuns.find((summary) => summary.turnId === 'msg_history_a2');
    assert.equal(active?.status, 'running', 'busy attach fences the newest persisted completion');
    assert.equal(active?.completedAt, undefined, 'active history withholds premature completion time');
    assert.equal(active?.totalRuntimeMs, undefined, 'active history withholds premature final runtime');

    await closeConnection(firstAttach.conn);
    const reconnect = await attach(adapter, id);
    const reconnectHistory = await reconnect.conn.getHistory();
    assert.equal(
      summaries(reconnectHistory).find((summary) => summary.turnId === 'msg_history_a2')?.status,
      'running',
      'reattach while still busy does not turn persisted message telemetry into completion',
    );
    setBusy(id, false);
    sendEvent({ type: 'session.idle', properties: { sessionID: id } });
    await waitFor(() => terminals(reconnect.live).length === 1);
    assert.equal(terminals(reconnect.live)[0]?.turnId, 'msg_history_a2');
    assert.equal(terminals(reconnect.live)[0]?.userMessageKey, 'msg_history_u2');
    await closeConnection(reconnect.conn);
  }

  // Busy history can end with a new user whose assistant row does not exist yet.
  {
    const id = 'ses_busy_trailing_user';
    const startedAt = 1_800_350_000_000;
    rows.set(id, [
      {
        info: userInfo('msg_trailing_u1', startedAt - 100),
        parts: [{ id: 'prt_trailing_u1', type: 'text', text: 'first', messageID: 'msg_trailing_u1', sessionID: id }],
      },
      {
        info: assistantInfo({
          id: 'msg_trailing_a1',
          userId: 'msg_trailing_u1',
          created: startedAt,
          completed: startedAt + 4000,
          finish: 'stop',
        }),
        parts: [{ id: 'prt_trailing_a1', type: 'text', text: 'done', messageID: 'msg_trailing_a1', sessionID: id }],
      },
      {
        info: userInfo('msg_trailing_u2', startedAt + 5000),
        parts: [{ id: 'prt_trailing_u2', type: 'text', text: 'working', messageID: 'msg_trailing_u2', sessionID: id }],
      },
    ]);
    setBusy(id, true);
    const { conn } = await attach(adapter, id);
    const history = await conn.getHistory();
    const first = summaries(history).find((summary) => summary.turnId === 'msg_trailing_a1');
    assert.equal(
      first?.status,
      'done',
      'busy history ending in a user row does not demote the previous completed assistant',
    );
    assert.equal(first?.completedAt, startedAt + 4000);
    assert.equal(
      summaries(history).some((summary) => summary.status === 'running'),
      false,
      'latest user without an assistant creates no synthetic active assistant summary',
    );
    await closeConnection(conn);
  }

  // An idle durable replay is historical truth and remains completed.
  {
    const id = 'ses_historical';
    const startedAt = 1_800_400_000_000;
    rows.set(id, [
      {
        info: userInfo('msg_durable_u', startedAt - 100),
        parts: [{ id: 'prt_durable_u', type: 'text', text: 'durable', messageID: 'msg_durable_u', sessionID: id }],
      },
      {
        info: assistantInfo({
          id: 'msg_durable_a',
          userId: 'msg_durable_u',
          created: startedAt,
          completed: startedAt + 9000,
          finish: 'stop',
        }),
        parts: [{ id: 'prt_durable_a', type: 'text', text: 'done', messageID: 'msg_durable_a', sessionID: id }],
      },
    ]);
    setBusy(id, false);
    const { conn } = await attach(adapter, id);
    const history = await conn.getHistory();
    const completed = summaries(history).find((summary) => summary.turnId === 'msg_durable_a');
    assert.equal(completed?.status, 'done', 'idle historical attach preserves completed summary');
    assert.equal(completed?.completedAt, startedAt + 9000);
    assert.equal(completed?.totalRuntimeMs, 9000);
    await closeConnection(conn);
  }

  // A later native user boundary cannot steal an older buffered assistant summary.
  {
    const id = 'ses_stale';
    const { conn, live } = await attach(adapter, id);
    setBusy(id, true);
    sendEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
    sendMessageUpdated(id, userInfo('msg_stale_u1', 1_800_500_000_000));
    sendMessageUpdated(id, assistantInfo({
      id: 'msg_stale_a1',
      userId: 'msg_stale_u1',
      created: 1_800_500_000_100,
      completed: 1_800_500_001_100,
      finish: 'stop',
    }));
    await waitFor(() => summaries(live).some((summary) => summary.turnId === 'msg_stale_a1'));
    sendMessageUpdated(id, userInfo('msg_stale_u2', 1_800_500_002_000));
    await Bun.sleep(100);
    assert.equal(
      terminals(live).length,
      0,
      'a later user boundary never finalizes the preceding assistant before idle',
    );
    sendMessageUpdated(id, assistantInfo({
      id: 'msg_stale_a2',
      userId: 'msg_stale_u2',
      created: 1_800_500_002_100,
      completed: 1_800_500_003_100,
      finish: 'stop',
    }));
    await waitFor(() => summaries(live).some((summary) => summary.turnId === 'msg_stale_a2'));
    assert.equal(
      terminals(live).length,
      0,
      'a later assistant boundary never finalizes another assistant before idle',
    );
    sendEvent({ type: 'session.compacted', properties: { sessionID: id } });
    await Bun.sleep(100);
    assert.equal(
      terminals(live).length,
      0,
      'a compaction completion signal is not a native turn-completion fence',
    );
    setBusy(id, false);
    sendEvent({ type: 'session.idle', properties: { sessionID: id } });
    await waitFor(() => terminals(live).length === 2);
    assert.equal(
      terminals(live).some((summary) =>
        summary.turnId === 'msg_stale_a1' && summary.userMessageKey !== 'msg_stale_u1'),
      false,
      'older buffered summary never attaches to the later user',
    );
    assert.equal(
      terminals(live).find((summary) => summary.turnId === 'msg_stale_a2')?.userMessageKey,
      'msg_stale_u2',
    );
    await closeConnection(conn);
  }

  // Idle may precede OpenCode's final message.updated. The fence immediately finalizes available
  // identity, then late telemetry enriches that same terminal key without resurrecting running.
  {
    const id = 'ses_idle_first';
    const { conn, live } = await attach(adapter, id, { attention: true });
    const userId = 'msg_idle_first_u';
    const assistantId = 'msg_idle_first_a';
    const startedAt = 1_800_550_000_000;
    const completedAt = startedAt + 6000;
    sendEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
    sendMessageUpdated(id, userInfo(userId, startedAt - 100));
    sendMessageUpdated(id, assistantInfo({ id: assistantId, userId, created: startedAt }));
    sendAssistantPart(id, assistantId, 'prt_idle_first_a');
    await waitFor(() => summaries(live).some((summary) => summary.status === 'running'));
    const runningCountAtFence = summaries(live).filter((summary) => summary.status === 'running').length;

    setBusy(id, false);
    sendEvent({ type: 'session.idle', properties: { sessionID: id } });
    await waitFor(() => terminals(live).length === 1);
    await drainAttention();
    assert.equal(terminals(live)[0]?.status, 'done');
    assert.equal(terminals(live)[0]?.completedAt, undefined);
    assert.equal(
      attentionStore.findByDedupeKey(`run-finished:opencode:${id}:${assistantId}`)?.state,
      'resolved',
      'idle immediately closes the observed run even before final message telemetry',
    );
    rows.set(id, [
      {
        info: userInfo(userId, startedAt - 100),
        parts: [{ id: 'prt_idle_first_u', type: 'text', text: 'idle first', messageID: userId, sessionID: id }],
      },
      {
        info: assistantInfo({ id: assistantId, userId, created: startedAt }),
        parts: [{ id: 'prt_idle_first_a', type: 'text', text: 'answer', messageID: assistantId, sessionID: id }],
      },
    ]);
    const beforeTelemetryHistory = await conn.getHistory();
    const beforeTelemetrySummary = summaries(beforeTelemetryHistory)
      .find((summary) => summary.turnId === assistantId);
    assert.equal(
      beforeTelemetrySummary?.status,
      'done',
      'history cannot regress an idle-fenced terminal record back to running',
    );
    assert.equal(beforeTelemetrySummary?.key, `opencode:run:${assistantId}`);

    sendMessageUpdated(id, assistantInfo({
      id: assistantId,
      userId,
      created: startedAt,
      completed: completedAt,
      finish: 'stop',
      tokens: { input: 13, output: 8 },
    }));
    await waitFor(() => terminals(live).length === 2);
    await drainAttention();
    const [initial, enriched] = terminals(live);
    assert.equal(initial?.key, enriched?.key, 'late telemetry enriches the same terminal identity');
    assert.equal(enriched?.completedAt, completedAt);
    assert.equal(enriched?.totalRuntimeMs, 6000);
    assert.deepEqual(
      { input: enriched?.tokens?.input, output: enriched?.tokens?.output },
      { input: 13, output: 8 },
    );
    assert.equal(
      summaries(live).filter((summary) => summary.status === 'running').length,
      runningCountAtFence,
      'late telemetry after idle never emits a running projection',
    );
    assert.equal(
      attentionStore.listEvents().filter((event) =>
        event.dedupeKey === `run-finished:opencode:${id}:${assistantId}`).length,
      1,
      'terminal enrichment does not duplicate Attention',
    );
    sendMessageUpdated(id, assistantInfo({
      id: assistantId,
      userId,
      created: startedAt,
      completed: completedAt,
      finish: 'stop',
      tokens: { input: 13, output: 8 },
    }));
    sendEvent({ type: 'session.idle', properties: { sessionID: id } });
    await Bun.sleep(100);
    assert.equal(terminals(live).length, 2, 'repeated enriched telemetry and idle are idempotent');
    await closeConnection(conn);
  }

  // Message-level failure telemetry is buffered. Native session.error is the terminal error fence,
  // then a repeated idle must not create a second terminal summary or notification.
  {
    const id = 'ses_error';
    const { conn, live } = await attach(adapter, id, { attention: true });
    const error = { name: 'ProviderAuthError', data: { message: 'provider rejected request' } };
    const startedAt = 1_800_600_000_000;
    const completedAt = startedAt + 2000;
    sendEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
    sendMessageUpdated(id, userInfo('msg_error_u', startedAt - 100));
    sendMessageUpdated(id, assistantInfo({ id: 'msg_error_a', userId: 'msg_error_u', created: startedAt }));
    sendMessageUpdated(id, assistantInfo({
      id: 'msg_error_a',
      userId: 'msg_error_u',
      created: startedAt,
      completed: completedAt,
      error,
    }));
    await waitFor(() => summaries(live).some((summary) => summary.status === 'running'));
    await drainAttention();
    assert.equal(terminals(live).length, 0, 'message error is not a terminal summary before session error');
    assert.equal(
      attentionStore.findByDedupeKey(`run-failed:opencode:${id}:msg_error_a`),
      undefined,
      'Attention emits no run-failed from message-level error alone',
    );
    sendEvent({ type: 'session.error', properties: { sessionID: id, error } });
    await waitFor(() => terminals(live).length === 1);
    await drainAttention();
    assert.equal(terminals(live)[0]?.status, 'error');
    assert.equal(terminals(live)[0]?.completedAt, completedAt);
    assert.equal(
      attentionStore.findByDedupeKey(`run-failed:opencode:${id}:msg_error_a`)?.state,
      'resolved',
      'Attention emits run-failed only after native session error',
    );
    setBusy(id, false);
    sendEvent({ type: 'session.idle', properties: { sessionID: id } });
    await Bun.sleep(100);
    assert.equal(terminals(live).length, 1, 'idle after error is idempotent');
    await closeConnection(conn);
  }

  // Native error can precede final message telemetry: fail immediately, then enrich without running.
  {
    const id = 'ses_error_first';
    const { conn, live } = await attach(adapter, id, { attention: true });
    const error = { name: 'ProviderAuthError', data: { message: 'provider rejected before final row' } };
    const startedAt = 1_800_650_000_000;
    const completedAt = startedAt + 2500;
    sendEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
    sendMessageUpdated(id, userInfo('msg_error_first_u', startedAt - 100));
    sendMessageUpdated(id, assistantInfo({
      id: 'msg_error_first_a',
      userId: 'msg_error_first_u',
      created: startedAt,
    }));
    await waitFor(() => summaries(live).some((summary) => summary.status === 'running'));
    const runningCountAtFence = summaries(live).filter((summary) => summary.status === 'running').length;
    sendEvent({ type: 'session.error', properties: { sessionID: id, error } });
    await waitFor(() => terminals(live).length === 1);
    await drainAttention();
    assert.equal(terminals(live)[0]?.status, 'error');
    assert.equal(terminals(live)[0]?.completedAt, undefined);
    assert.equal(
      attentionStore.findByDedupeKey('run-failed:opencode:ses_error_first:msg_error_first_a')?.state,
      'resolved',
      'session.error immediately emits the failed Attention outcome',
    );
    rows.set(id, [
      {
        info: userInfo('msg_error_first_u', startedAt - 100),
        parts: [{
          id: 'prt_error_first_u',
          type: 'text',
          text: 'error first',
          messageID: 'msg_error_first_u',
          sessionID: id,
        }],
      },
      {
        info: assistantInfo({
          id: 'msg_error_first_a',
          userId: 'msg_error_first_u',
          created: startedAt,
        }),
        parts: [{
          id: 'prt_error_first_a',
          type: 'text',
          text: 'partial',
          messageID: 'msg_error_first_a',
          sessionID: id,
        }],
      },
    ]);
    const beforeTelemetryHistory = await conn.getHistory();
    assert.equal(
      summaries(beforeTelemetryHistory)
        .find((summary) => summary.turnId === 'msg_error_first_a')?.status,
      'error',
      'history cannot regress an error-fenced terminal record back to running',
    );

    sendMessageUpdated(id, assistantInfo({
      id: 'msg_error_first_a',
      userId: 'msg_error_first_u',
      created: startedAt,
      completed: completedAt,
      error,
      tokens: { input: 5, output: 1 },
    }));
    await waitFor(() => terminals(live).length === 2);
    await drainAttention();
    assert.equal(terminals(live)[1]?.key, terminals(live)[0]?.key);
    assert.equal(terminals(live)[1]?.status, 'error');
    assert.equal(terminals(live)[1]?.completedAt, completedAt);
    assert.equal(
      summaries(live).filter((summary) => summary.status === 'running').length,
      runningCountAtFence,
      'late error telemetry never emits running after the terminal fence',
    );
    assert.equal(
      attentionStore.listEvents().filter((event) =>
        event.dedupeKey === 'run-failed:opencode:ses_error_first:msg_error_first_a').length,
      1,
      'late error enrichment does not duplicate run-failed Attention',
    );
    await closeConnection(conn);
  }

  // A fence that already finalized an assistant must not remain available for a later owner.
  {
    const id = 'ses_idle_existing_then_other';
    const { conn, live } = await attach(adapter, id);
    const startedAt = 1_800_675_000_000;
    sendEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
    sendMessageUpdated(id, userInfo('msg_idle_existing_u1', startedAt - 100));
    sendMessageUpdated(id, assistantInfo({
      id: 'msg_idle_existing_a1',
      userId: 'msg_idle_existing_u1',
      created: startedAt,
    }));
    await waitFor(() => summaries(live).some((summary) => summary.turnId === 'msg_idle_existing_a1'));
    sendEvent({ type: 'session.idle', properties: { sessionID: id } });
    await waitFor(() => terminals(live).some((summary) => summary.turnId === 'msg_idle_existing_a1'));

    sendMessageUpdated(id, assistantInfo({
      id: 'msg_idle_existing_a2',
      userId: 'msg_idle_existing_u2',
      created: startedAt + 1000,
    }));
    await waitFor(() => summaries(live).some((summary) => summary.turnId === 'msg_idle_existing_a2'));
    assert.equal(
      summaries(live).findLast((summary) => summary.turnId === 'msg_idle_existing_a2')?.status,
      'running',
      'an idle fence consumed by an existing assistant cannot finalize a different-user assistant',
    );
    assert.equal(
      terminals(live).some((summary) => summary.turnId === 'msg_idle_existing_a2'),
      false,
    );
    await closeConnection(conn);
  }

  {
    const id = 'ses_error_existing_then_other';
    const { conn, live } = await attach(adapter, id);
    const error = { name: 'ProviderAuthError', data: { message: 'first owner failed' } };
    const startedAt = 1_800_680_000_000;
    sendEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
    sendMessageUpdated(id, userInfo('msg_error_existing_u1', startedAt - 100));
    sendMessageUpdated(id, assistantInfo({
      id: 'msg_error_existing_a1',
      userId: 'msg_error_existing_u1',
      created: startedAt,
    }));
    await waitFor(() => summaries(live).some((summary) => summary.turnId === 'msg_error_existing_a1'));
    sendEvent({ type: 'session.error', properties: { sessionID: id, error } });
    await waitFor(() =>
      terminals(live).some((summary) =>
        summary.turnId === 'msg_error_existing_a1' && summary.status === 'error'));

    sendMessageUpdated(id, assistantInfo({
      id: 'msg_error_existing_a2',
      userId: 'msg_error_existing_u2',
      created: startedAt + 1000,
    }));
    await waitFor(() => summaries(live).some((summary) => summary.turnId === 'msg_error_existing_a2'));
    assert.equal(
      summaries(live).findLast((summary) => summary.turnId === 'msg_error_existing_a2')?.status,
      'running',
      'an error fence consumed by an existing assistant cannot finalize a different-user assistant',
    );
    assert.equal(
      terminals(live).some((summary) => summary.turnId === 'msg_error_existing_a2'),
      false,
    );
    await closeConnection(conn);
  }

  // When idle genuinely precedes the entire assistant row, retain one ownership-scoped fence.
  {
    const id = 'ses_idle_no_assistant';
    const { conn, live } = await attach(adapter, id);
    const startedAt = 1_800_685_000_000;
    sendEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
    sendMessageUpdated(id, userInfo('msg_idle_none_u1', startedAt - 100));
    sendEvent({ type: 'session.idle', properties: { sessionID: id } });
    await waitFor(() => live.some((message) => message.type === 'status' && message.status === 'idle'));
    assert.equal(terminals(live).length, 0);

    sendMessageUpdated(id, assistantInfo({
      id: 'msg_idle_none_a1',
      userId: 'msg_idle_none_u1',
      created: startedAt,
    }));
    await waitFor(() => terminals(live).some((summary) => summary.turnId === 'msg_idle_none_a1'));
    assert.equal(
      terminals(live).find((summary) => summary.turnId === 'msg_idle_none_a1')?.status,
      'done',
      'idle before any assistant finalizes the matching late assistant',
    );
    assert.equal(
      summaries(live).some((summary) =>
        summary.turnId === 'msg_idle_none_a1' && summary.status === 'running'),
      false,
      'matching late assistant never resurrects running after the fence',
    );

    sendMessageUpdated(id, assistantInfo({
      id: 'msg_idle_none_a2',
      userId: 'msg_idle_none_u2',
      created: startedAt + 1000,
    }));
    await waitFor(() => summaries(live).some((summary) => summary.turnId === 'msg_idle_none_a2'));
    assert.equal(
      summaries(live).findLast((summary) => summary.turnId === 'msg_idle_none_a2')?.status,
      'running',
      'the ownership-scoped pending fence is consumed exactly once',
    );
    await closeConnection(conn);
  }

  // Native abort finalizes as cancelled and does not masquerade as run-finished/run-failed.
  {
    const id = 'ses_cancel';
    const { conn, live } = await attach(adapter, id, { attention: true });
    const abort = { name: 'MessageAbortedError', data: { message: 'The message was aborted' } };
    const startedAt = 1_800_700_000_000;
    const completedAt = startedAt + 3000;
    sendEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
    sendMessageUpdated(id, userInfo('msg_cancel_u', startedAt - 100));
    sendMessageUpdated(id, assistantInfo({ id: 'msg_cancel_a', userId: 'msg_cancel_u', created: startedAt }));
    await waitFor(() => summaries(live).some((summary) => summary.status === 'running'));
    sendEvent({ type: 'session.error', properties: { sessionID: id, error: abort } });
    await waitFor(() => terminals(live).length === 1);
    assert.equal(
      terminals(live)[0]?.status,
      'cancelled',
      'an abort fence immediately finalizes the available native assistant identity',
    );
    sendMessageUpdated(id, assistantInfo({
      id: 'msg_cancel_a',
      userId: 'msg_cancel_u',
      created: startedAt,
      completed: completedAt,
      error: abort,
    }));
    await waitFor(() => terminals(live).length === 2);
    await drainAttention();
    assert.equal(terminals(live)[1]?.status, 'cancelled');
    assert.equal(terminals(live)[1]?.completedAt, completedAt);
    assert.equal(terminals(live)[0]?.key, terminals(live)[1]?.key);
    assert.equal(
      attentionStore.listEvents().some((event) =>
        event.sessionId === id && (event.kind === 'run-finished' || event.kind === 'run-failed')),
      false,
      'cancelled run creates no finished/failed Attention event',
    );
    setBusy(id, false);
    sendEvent({ type: 'session.idle', properties: { sessionID: id } });
    await Bun.sleep(100);
    assert.equal(terminals(live).length, 2);
    await closeConnection(conn);
  }

  // Every live connection consumes the server-wide bus, so buffered state must remain session-local.
  {
    const id = 'ses_bounded';
    const { conn, live } = await attach(adapter, id);
    const userId = 'msg_bounded_u';
    const startedAt = 1_800_750_000_000;
    sendEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
    sendMessageUpdated(id, userInfo(userId, startedAt - 100));
    for (let index = 0; index < 129; index++) {
      sendMessageUpdated(id, assistantInfo({
        id: `msg_bounded_a${index}`,
        userId,
        created: startedAt + index,
      }));
    }
    await waitFor(() => summaries(live).filter((summary) => summary.status === 'running').length === 129);
    assert.equal(terminals(live).length, 0);
    sendEvent({ type: 'session.idle', properties: { sessionID: id } });
    await waitFor(() => terminals(live).length >= 128);
    await Bun.sleep(100);
    assert.equal(
      terminals(live).length,
      128,
      'assistant record storage has a hard 128-entry ceiling before a fence',
    );
    assert.equal(
      terminals(live).some((summary) => summary.turnId === 'msg_bounded_a0'),
      false,
      'hard-cap eviction drops the oldest unresolved optional footer telemetry',
    );
    assert.equal(
      terminals(live).some((summary) => summary.turnId === 'msg_bounded_a128'),
      true,
      'hard-cap eviction retains the newest unresolved assistant',
    );
    await closeConnection(conn);
  }

  // Every live connection consumes the server-wide bus, so buffered state must remain session-local.
  {
    const a = await attach(adapter, 'ses_cross_a');
    const b = await attach(adapter, 'ses_cross_b');
    for (const [id, suffix, startedAt] of [
      ['ses_cross_a', 'a', 1_800_800_000_000],
      ['ses_cross_b', 'b', 1_800_800_010_000],
    ] as const) {
      sendEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
      sendMessageUpdated(id, userInfo(`msg_cross_u_${suffix}`, startedAt - 100));
      sendMessageUpdated(id, assistantInfo({
        id: `msg_cross_a_${suffix}`,
        userId: `msg_cross_u_${suffix}`,
        created: startedAt,
        completed: startedAt + 1000,
        finish: 'stop',
      }));
    }
    await waitFor(() =>
      summaries(a.live).some((summary) => summary.status === 'running') &&
      summaries(b.live).some((summary) => summary.status === 'running'));
    assert.equal(terminals(a.live).length, 0);
    assert.equal(terminals(b.live).length, 0);
    sendEvent({
      type: 'session.error',
      properties: {
        sessionID: 'ses_unrelated',
        error: { name: 'ProviderAuthError', data: { message: 'belongs elsewhere' } },
      },
    });
    await Bun.sleep(100);
    assert.equal(terminals(a.live).length, 0, 'unrelated global error does not finalize session A');
    assert.equal(terminals(b.live).length, 0, 'unrelated global error does not finalize session B');
    setBusy('ses_cross_a', false);
    sendEvent({ type: 'session.idle', properties: { sessionID: 'ses_cross_a' } });
    await waitFor(() => terminals(a.live).length === 1);
    await Bun.sleep(100);
    assert.equal(terminals(a.live)[0]?.turnId, 'msg_cross_a_a');
    assert.equal(terminals(b.live).length, 0, 'session A idle does not finalize session B');
    setBusy('ses_cross_b', false);
    sendEvent({ type: 'session.idle', properties: { sessionID: 'ses_cross_b' } });
    await waitFor(() => terminals(b.live).length === 1);
    assert.equal(terminals(b.live)[0]?.turnId, 'msg_cross_a_b');
    await closeConnection(a.conn);
    await closeConnection(b.conn);
  }

  console.log('PASS: OpenCode completion fencing, history, reconnect, Attention, errors, cancellation, idempotency, and session isolation');
} finally {
  await drainAttention();
  await Promise.all([...openConnections].map((conn) => conn.close().catch(() => {})));
  for (const client of [...eventClients]) {
    try {
      client.close();
    } catch {
      // already closed
    }
  }
  server.stop(true);
  rmSync(TEST_ROOT, { recursive: true, force: true });
}
process.exit(0);
