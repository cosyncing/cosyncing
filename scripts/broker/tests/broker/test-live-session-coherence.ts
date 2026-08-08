#!/usr/bin/env bun
/**
 * Batch A cumulative reproduction — one live turn must have one status, one
 * prompt identity, one terminal boundary, and replay-safe history.
 *
 * This is deliberately ONE real broker, ONE real session, and ONE real turn.
 * Every lane below reads the SAME canonical identities (session id, prompt key,
 * assistant key, turn id, run-summary key) so a fix that satisfies one surface
 * while invalidating another fails here rather than in the app:
 *
 *   open current session
 *   → send prompt
 *   → roster and detail become Working
 *   → the prompt resolves to one row
 *   → the answer grows at the actual tail
 *   → the terminal footer metadata arrives on the open turn
 *   → roster and detail become Idle
 *   → reconnect / reset:false / history replay keep one prompt and one footer
 *   → an active append concurrent with older-page loading stays retriable
 *
 * The roster lane consumes the REAL `/api/session-roster-deltas` journal at the
 * same revisions the Flutter roster feed uses, so a status transition that only
 * reaches the attached socket (and needs a page refresh to reach the roster)
 * fails A-status below.
 */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  isolatedBrokerFixtureEnvironment,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';

const WAIT_MS = 20_000;
let waitLabel = 'broker state';

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures += 1;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a loopback port');
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = WAIT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${waitLabel}`);
}

type RunningBroker = { child: ReturnType<typeof Bun.spawn>; base: string; wsBase: string };

/**
 * Start one broker in a FULLY isolated home.
 *
 * Every environment root the broker reads is redirected into `home`. Inheriting the caller's real
 * `HOME`/`XDG_*` made startup host-dependent: the broker discovered the operator's actual agent
 * state and could start host-side helpers (the Codex sync server, an OpenCode autoserve) whose
 * failure killed the child before it ever listened — which the caller then saw only as a bare
 * `ConnectionRefused`. Startup failures are now reported with the child's exit code and its own
 * stderr instead of a silent poll timeout.
 */
async function startBroker(home: string): Promise<RunningBroker> {
  const port = await freePort();
  const child = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    cwd: process.cwd(),
    env: isolatedBrokerFixtureEnvironment(home, {
      overrides: {
        PORT: String(port),
        HOST: '127.0.0.1',
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local', 'share'),
        XDG_STATE_HOME: join(home, '.local', 'state'),
        COSYNCING_HOME: home,
        // Authentication is part of the isolated home too. This used to spread
        // `process.env`, which carried the operator's real `COSYNCING_TOKEN`;
        // the broker adopted it as its legacy shared credential, so every
        // unauthenticated request in this suite answered 401 on that host and
        // passed on one without a token. The allow-list no longer carries it,
        // but the empty value stays as the explicit "this broker has no token"
        // state: `credentials.ts` ignores a blank legacy token, and the
        // isolated home has no token file.
        COSYNCING_TOKEN: '',
        COSYNCING_MACHINE: 'batch-a-coherence',
        COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
        COSYNCING_CODEX_SYNC_SERVER: '0',
        COSYNCING_RESTART_DRY_RUN: '1',
        COSYNCING_HISTORY_MAX_MESSAGES: '5000',
      },
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let diagnostics = '';
  const drain = async (stream: ReadableStream<Uint8Array> | undefined): Promise<void> => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) diagnostics += decoder.decode(value, { stream: true });
    }
  };
  void drain(child.stdout as ReadableStream<Uint8Array> | undefined).catch(() => undefined);
  void drain(child.stderr as ReadableStream<Uint8Array> | undefined).catch(() => undefined);
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  const base = `http://127.0.0.1:${port}`;
  waitLabel = 'broker health';
  // Readiness is not one of this suite's assertions, so it does not get this
  // suite's WAIT_MS: a broker booting beside other suites is slow, not broken.
  // The helper still fails at once when the child dies, which is what the
  // hand-rolled loop was here for.
  try {
    await waitForBrokerHealth(child, `${base}/api/health`);
  } catch (error) {
    // The caller never receives this child — the assignment happens only once
    // `startBroker` returns, so the outer `finally` still sees `undefined` and
    // cleans up nothing. A broker that is merely slow, not dead, would outlive
    // the suite and be reaped by the lane as a stray.
    child.kill();
    await child.exited;
    throw new Error(`${(error as Error).message}\n${diagnostics.trim().slice(-2000)}`);
  }
  return { child, base, wsBase: base.replace(/^http/, 'ws') };
}

// ── session fixture ────────────────────────────────────────────────────────────────────────────
const CANONICAL = {
  promptKey: 'batch-a:u0',
  assistantKey: 'batch-a:a0',
  turnId: 'batch-a-turn-0',
  runKey: 'pi:run:batch-a-turn-0',
  promptText: 'Batch A cumulative prompt',
  answerText: 'Batch A cumulative answer',
};

async function bridgeHello(base: string, sessionFile: string, history: Array<Record<string, unknown>>): Promise<string> {
  const response = await fetch(`${base}/pi/bridge/hello`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionFile, cwd: '/tmp', title: 'Batch A coherence', history }),
  });
  assert.equal(response.status, 200);
  return String(((await response.json()) as { id: string }).id);
}

async function bridgeEvents(base: string, id: string, events: Array<Record<string, unknown>>): Promise<void> {
  const response = await fetch(`${base}/pi/bridge/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, events }),
  });
  assert.equal(response.status, 200);
}

type SocketClient = { ws: WebSocket; frames: any[] };

async function openClient(wsBase: string, id: string, initialHistory?: number): Promise<SocketClient> {
  const params = new URLSearchParams({ artifactMode: 'reference', contractRevision: '5', minimumBrokerRevision: '2' });
  if (initialHistory !== undefined) params.set('initialHistory', `${initialHistory}`);
  const frames: any[] = [];
  const ws = new WebSocket(`${wsBase}/api/sessions/pi/${encodeURIComponent(id)}/stream?${params}`);
  ws.onmessage = (event) => {
    try {
      frames.push(JSON.parse(String(event.data)));
    } catch {
      /* malformed frames surface as a wait timeout */
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WebSocket failed to open'));
  });
  waitLabel = 'initial history frame';
  await waitFor(() => frames.find((frame) => frame.kind === 'history'));
  return { ws, frames };
}

type RosterDeltaBatch = {
  revision: number;
  deltas: Array<{ revision: number; tool: string; sessionId: string; changedFields: string[]; session?: any; removed?: true }>;
  resetRequired?: boolean;
};

/** The exact call the Flutter roster feed makes: one bounded long poll, no full refetch. */
async function rosterDeltas(base: string, after: number, waitMs = 4_000): Promise<RosterDeltaBatch> {
  const response = await fetch(`${base}/api/session-roster-deltas?after=${after}&waitMs=${waitMs}`);
  assert.equal(response.status, 200);
  return (await response.json()) as RosterDeltaBatch;
}

/** Roster status for one session as delivered by the delta journal alone. */
async function rosterStatusAfter(
  base: string,
  after: number,
  sessionId: string,
  want: string,
): Promise<{ revision: number; status: string } | undefined> {
  let cursor = after;
  const deadline = Date.now() + WAIT_MS;
  let seen: string | undefined;
  while (Date.now() < deadline) {
    const batch = await rosterDeltas(base, cursor, 2_000);
    if (batch.resetRequired) return undefined;
    for (const delta of batch.deltas) {
      if (delta.sessionId !== sessionId) continue;
      if (delta.session?.status) seen = String(delta.session.status);
    }
    cursor = batch.revision;
    if (seen === want) return { revision: cursor, status: seen };
  }
  return seen === undefined ? undefined : { revision: cursor, status: seen };
}

function messagesOf(frame: any): any[] {
  return Array.isArray(frame?.messages) ? frame.messages : [];
}

function liveMessages(client: SocketClient): any[] {
  return client.frames.filter((frame) => frame.kind === 'message').map((frame) => frame.message);
}

const home = mkdtempSync('/tmp/cosyncing-batch-a-');
const sessionFile = `/tmp/cosyncing-batch-a-${process.pid}.jsonl`;
const sockets: WebSocket[] = [];
let broker: RunningBroker | undefined;

// Every run exercises the inherited-credential case rather than depending on the operator's shell.
// This is a syntactically VALID legacy credential on purpose: an isolation regression must produce
// a broker that starts and answers 401 — the failure this suite actually hit — not one that refuses
// to start on a malformed token and looks like an unrelated crash.
process.env.COSYNCING_TOKEN = 'batch-a-parent-token-must-not-authenticate';

/** Every gated leg this suite drives (Pi bridge, WS attach) is unreachable once a token is in play. */
async function checkUnauthenticated(base: string): Promise<void> {
  const response = await fetch(`${base}/api/broker/health`);
  check(
    'A-harness a non-empty parent COSYNCING_TOKEN never authenticates the spawned broker',
    response.status === 200,
    `status ${response.status}`,
  );
}

try {
  broker = await startBroker(home);
  await checkUnauthenticated(broker.base);
  // ── open the current session ─────────────────────────────────────────────────────────────────
  const id = await bridgeHello(broker.base, sessionFile, [
    { t: 'user', key: 'seed:u', text: 'seed prompt' },
    { t: 'final', key: 'seed:a', text: 'seed answer' },
  ]);
  const rosterBefore = (await (await fetch(`${broker.base}/api/sessions`)).json()) as { revision: number; sessions: any[] };
  const openRevision = rosterBefore.revision;
  check(
    'A-open the roster lists the session as idle before the turn',
    rosterBefore.sessions.find((s) => s.id === id)?.status === 'idle',
    String(rosterBefore.sessions.find((s) => s.id === id)?.status),
  );

  const detail = await openClient(broker.wsBase, id);
  sockets.push(detail.ws);

  // ── send prompt → Working ────────────────────────────────────────────────────────────────────
  await bridgeEvents(broker.base, id, [
    { t: 'status', running: true },
    { t: 'user', key: CANONICAL.promptKey, text: CANONICAL.promptText },
    {
      t: 'run-summary',
      key: CANONICAL.runKey,
      turnId: CANONICAL.turnId,
      userMessageKey: CANONICAL.promptKey,
      status: 'running',
      startedAt: 1_000,
    },
  ]);

  waitLabel = 'working session frame';
  const workingFrame = await waitFor(() =>
    detail.frames.find((frame) => frame.kind === 'session' && frame.info?.status === 'working'));
  check('A-status detail receives one authoritative working session frame', Boolean(workingFrame));

  const workingRoster = await rosterStatusAfter(broker.base, openRevision, id, 'working');
  check(
    'A-status the roster delta journal publishes working without a full refetch',
    workingRoster?.status === 'working',
    `status=${workingRoster?.status ?? 'none'}`,
  );

  // ── the prompt resolves to exactly one row ───────────────────────────────────────────────────
  waitLabel = 'live prompt echo';
  await waitFor(() => liveMessages(detail).find((m) => m.type === 'user-message' && m.key === CANONICAL.promptKey));
  const livePrompts = liveMessages(detail).filter((m) => m.type === 'user-message' && m.text === CANONICAL.promptText);
  check('A-prompt the live turn renders exactly one prompt row', livePrompts.length === 1, `rows=${livePrompts.length}`);

  // ── the answer grows, then the terminal boundary arrives on the open turn ─────────────────────
  await bridgeEvents(broker.base, id, [
    { t: 'delta', key: CANONICAL.assistantKey, delta: 'Batch A ' },
    { t: 'final', key: CANONICAL.assistantKey, text: CANONICAL.answerText },
    {
      t: 'run-summary',
      key: CANONICAL.runKey,
      turnId: CANONICAL.turnId,
      userMessageKey: CANONICAL.promptKey,
      assistantMessageKey: CANONICAL.assistantKey,
      status: 'done',
      startedAt: 1_000,
      completedAt: 4_000,
    },
    { t: 'status', running: false },
  ]);

  waitLabel = 'terminal run summary';
  const terminalSummary = await waitFor(() =>
    liveMessages(detail).find((m) => m.type === 'run-summary' && m.status === 'done'));
  check(
    'A-footer the terminal summary carries duration and completion time on the open socket',
    terminalSummary.totalRuntimeMs === 3_000 && terminalSummary.completedAt === 4_000,
    `runtime=${terminalSummary.totalRuntimeMs} completedAt=${terminalSummary.completedAt}`,
  );
  check(
    'A-footer the terminal summary references the rendered prompt identity',
    terminalSummary.userMessageKey === CANONICAL.promptKey && terminalSummary.assistantMessageKey === CANONICAL.assistantKey,
    `userMessageKey=${terminalSummary.userMessageKey} assistantMessageKey=${terminalSummary.assistantMessageKey}`,
  );

  waitLabel = 'idle session frame';
  const idleFrame = await waitFor(() =>
    detail.frames.filter((frame) => frame.kind === 'session').at(-1)?.info?.status === 'idle' ? true : undefined);
  check('A-status detail converges back to idle without a refresh', Boolean(idleFrame));

  const idleRoster = await rosterStatusAfter(broker.base, workingRoster?.revision ?? openRevision, id, 'idle');
  check(
    'A-status the roster delta journal publishes idle without a full refetch',
    idleRoster?.status === 'idle',
    `status=${idleRoster?.status ?? 'none'}`,
  );

  // ── reconnect / replay keeps ONE prompt and ONE footer ────────────────────────────────────────
  const replay = await openClient(broker.wsBase, id);
  sockets.push(replay.ws);
  const replayHistory = messagesOf(replay.frames.find((frame) => frame.kind === 'history'));
  const replayPrompts = replayHistory.filter((m) => m.type === 'user-message' && m.text === CANONICAL.promptText);
  check('A-replay history replay keeps exactly one prompt row', replayPrompts.length === 1, `rows=${replayPrompts.length}`);
  check(
    'A-replay the replayed prompt keeps the canonical identity',
    replayPrompts[0]?.key === CANONICAL.promptKey,
    String(replayPrompts[0]?.key),
  );
  const replaySummaries = replayHistory.filter((m) => m.type === 'run-summary' && m.status === 'done');
  check(
    'A-replay the replayed footer keeps duration, completion time, and prompt ownership',
    replaySummaries.length === 1
      && replaySummaries[0].totalRuntimeMs === 3_000
      && replaySummaries[0].completedAt === 4_000
      && replaySummaries[0].userMessageKey === CANONICAL.promptKey,
    `count=${replaySummaries.length}`,
  );

  // A `reset: false` continuation of the SAME cursor must not restate the prompt.
  const attachTicket = String(replay.frames.find((frame) => frame.kind === 'history')?.attachTicket ?? '');
  const resumed = await (async () => {
    const params = new URLSearchParams({
      artifactMode: 'reference',
      contractRevision: '5',
      minimumBrokerRevision: '2',
      since: attachTicket,
    });
    const frames: any[] = [];
    const ws = new WebSocket(`${broker.wsBase}/api/sessions/pi/${encodeURIComponent(id)}/stream?${params}`);
    ws.onmessage = (event) => {
      try {
        frames.push(JSON.parse(String(event.data)));
      } catch {
        /* ignore */
      }
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('WebSocket failed to open'));
    });
    waitLabel = 'reset:false history frame';
    await waitFor(() => frames.find((frame) => frame.kind === 'history'));
    return { ws, frames };
  })();
  sockets.push(resumed.ws);
  const resumedHistory = resumed.frames.find((frame) => frame.kind === 'history');
  check('A-replay an unchanged cursor continues without a full reset', resumedHistory?.reset !== true, `reset=${resumedHistory?.reset}`);
  check(
    'A-replay reset:false replays no duplicate prompt',
    messagesOf(resumedHistory).filter((m) => m.type === 'user-message' && m.text === CANONICAL.promptText).length === 0,
    `rows=${messagesOf(resumedHistory).filter((m: any) => m.type === 'user-message').length}`,
  );

  // ── exact canonical chronology survives both live WebSocket and history replay ───────────────
  const chronologyKeys = ['wire:u0', 'wire:m0', 'wire:u1', 'wire:m1'];
  await bridgeEvents(broker.base, id, [
    { t: 'user', key: chronologyKeys[0], text: 'open' },
    { t: 'delta', key: chronologyKeys[1], delta: 'before' },
    { t: 'final', key: chronologyKeys[1], text: 'before' },
    { t: 'user', key: chronologyKeys[2], text: 'steer' },
    { t: 'delta', key: chronologyKeys[3], delta: 'after' },
    { t: 'final', key: chronologyKeys[3], text: 'after' },
  ]);
  waitLabel = 'live chronology sequence';
  await waitFor(() => {
    const keys = liveMessages(detail)
      .map((message) => message.key)
      .filter((key) => chronologyKeys.includes(key));
    return keys.length === chronologyKeys.length ? keys : undefined;
  });
  const liveChronology = liveMessages(detail)
    .map((message) => message.key)
    .filter((key) => chronologyKeys.includes(key));
  check(
    'A-chronology live-only WebSocket delivery preserves exact canonical key order',
    liveChronology.join(',') === chronologyKeys.join(','),
    liveChronology.join(','),
  );

  const chronologyReplay = await openClient(broker.wsBase, id);
  sockets.push(chronologyReplay.ws);
  const historyChronology = messagesOf(
    chronologyReplay.frames.find((frame) => frame.kind === 'history'),
  )
    .map((message) => message.key)
    .filter((key) => chronologyKeys.includes(key));
  check(
    'A-chronology history-only reconnect converges to the same canonical key order',
    historyChronology.join(',') === chronologyKeys.join(',') &&
      historyChronology.join(',') === liveChronology.join(','),
    historyChronology.join(','),
  );

  // ── an active append concurrent with older-page loading stays retriable ───────────────────────
  // A truncated attach is what arms backward paging; the bridge then appends while the page cache
  // is being built, which is the ordinary Codex-rollout condition.
  const paging = await openClient(broker.wsBase, id, 2);
  sockets.push(paging.ws);
  const pagingAttach = paging.frames.find((frame) => frame.kind === 'history');
  check('A-paging a truncated attach arms an older cursor', Boolean(pagingAttach?.olderCursor), String(pagingAttach?.olderCursor));

  const requestPage = async (client: SocketClient, cursor: string, requestId: string): Promise<any> => {
    client.ws.send(JSON.stringify({ kind: 'history-page', cursor, limit: 2, clientMessageId: requestId }));
    waitLabel = `history page ${requestId}`;
    return waitFor(() =>
      client.frames.find((frame) => frame.clientMessageId === requestId && (frame.kind === 'history-page' || frame.kind === 'nack')));
  };

  // Append continuously while the page is requested, so the build observes a moving source.
  let appending = true;
  const appendLoop = (async () => {
    let index = 0;
    while (appending) {
      await bridgeEvents(broker.base, id, [
        { t: 'final', key: `append:${index}`, text: `append ${index}` },
      ]);
      index += 1;
      await Bun.sleep(5);
    }
  })();
  const racedPage = await requestPage(paging, String(pagingAttach.olderCursor), 'active-append');
  appending = false;
  await appendLoop;

  const racedTerminal = racedPage.kind === 'nack' && racedPage.code === 'HISTORY_PAGE_RESOURCE_LIMIT';
  check(
    'A-paging an append race never reports the history as too large',
    !racedTerminal,
    `kind=${racedPage.kind} code=${racedPage.code ?? '-'}`,
  );
  check(
    'A-paging an append race is either served or reported as retriable',
    racedPage.kind === 'history-page' || racedPage.code === 'HISTORY_PAGE_SOURCE_CHANGED',
    `kind=${racedPage.kind} code=${racedPage.code ?? '-'}`,
  );

  // Whatever the first outcome, the SAME socket must still be able to page —
  // a transient race must not install a sticky paging-unavailable marker.
  const retryPage = await requestPage(paging, String(pagingAttach.olderCursor), 'active-append-retry');
  check(
    'A-paging retrying on the same connection still works after an append race',
    retryPage.kind === 'history-page',
    `kind=${retryPage.kind} code=${retryPage.code ?? '-'}`,
  );
  const retryAgain = await requestPage(paging, String(pagingAttach.olderCursor), 'active-append-retry-2');
  check(
    'A-paging the connection stays pageable for every later request',
    retryAgain.kind === 'history-page',
    `kind=${retryAgain.kind} code=${retryAgain.code ?? '-'}`,
  );

  // ── broker restart rebuilds the same canonical identities ─────────────────────────────────────
  for (const ws of sockets.splice(0)) {
    try {
      ws.close();
    } catch {
      /* best effort */
    }
  }
  broker.child.kill();
  await broker.child.exited;
  broker = await startBroker(home);
  const rehelloId: string = await bridgeHello(broker.base, sessionFile, [
    { t: 'user', key: 'seed:u', text: 'seed prompt' },
    { t: 'final', key: 'seed:a', text: 'seed answer' },
    { t: 'user', key: CANONICAL.promptKey, text: CANONICAL.promptText },
    { t: 'final', key: CANONICAL.assistantKey, text: CANONICAL.answerText },
    {
      t: 'run-summary',
      key: CANONICAL.runKey,
      turnId: CANONICAL.turnId,
      userMessageKey: CANONICAL.promptKey,
      assistantMessageKey: CANONICAL.assistantKey,
      status: 'done',
      startedAt: 1_000,
      completedAt: 4_000,
    },
  ]);
  check('A-restart the same session file rebuilds the same session id', rehelloId === id, `${rehelloId} vs ${id}`);
  const restarted = await openClient(broker.wsBase, id);
  sockets.push(restarted.ws);
  const restartedHistory = messagesOf(restarted.frames.find((frame) => frame.kind === 'history'));
  check(
    'A-restart the prompt keeps one canonical identity across a broker restart',
    restartedHistory.filter((m) => m.type === 'user-message' && m.key === CANONICAL.promptKey).length === 1,
    `rows=${restartedHistory.filter((m: any) => m.type === 'user-message' && m.key === CANONICAL.promptKey).length}`,
  );
  check(
    'A-restart the footer still references the rendered prompt identity',
    restartedHistory.find((m) => m.type === 'run-summary' && m.status === 'done')?.userMessageKey === CANONICAL.promptKey,
    String(restartedHistory.find((m: any) => m.type === 'run-summary' && m.status === 'done')?.userMessageKey),
  );
} catch (error) {
  // A harness/product startup failure is a FAILURE, not a silent crash: report it the same way an
  // assertion reports, so a caller that only reads the summary still sees a red result.
  check('A-harness the broker starts and stays reachable for the whole run', false, String((error as Error)?.message ?? error));
} finally {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* best effort */
    }
  }
  broker?.child.kill();
  await broker?.child.exited.catch(() => undefined);
  rmSync(home, { recursive: true, force: true });
  rmSync(sessionFile, { force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
