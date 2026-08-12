/**
 * Extension-side regression: the bridge must RE-HELLO after a broker restart.
 *
 * issues-part2 item 3 re-flag: a broker restart forgets every live bridge registration; the old
 * bridge kept polling `/pi/bridge/commands` with its stale id, got 404 forever, and silently ran
 * unbridged — the app then diverged onto the resume adapter. The fix makes registration a loop:
 * poll 404 → drop out → re-hello (with history backfill), and hello failure (broker down) retries.
 *
 * Runs the REAL extension module against a fake broker + fake pi ExtensionAPI. No pi binary, no
 * real broker, no model cost.
 *
 *   bun run scripts/broker/tests/pi/test-pi-bridge-rehello.ts   (exit 0 = all pass)
 */
export {};

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 19000 + Math.floor(Math.random() * 20000));
process.env.COSYNCING_BROKER = `http://127.0.0.1:${PORT}`; // must be set BEFORE the module import below

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

// ── fake broker ──────────────────────────────────────────────────────────────
const helloBodies: any[] = [];
const eventBodies: any[] = [];
const knownIds = new Set<string>();
let nextBridgeId = 1;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/pi/bridge/hello' && req.method === 'POST') {
      const body = await req.json();
      helloBodies.push(body);
      const id = `bridge-${nextBridgeId++}`;
      knownIds.add(id);
      return Response.json({ id });
    }
    if (url.pathname === '/pi/bridge/commands' && req.method === 'GET') {
      const id = url.searchParams.get('id') ?? '';
      if (!knownIds.has(id)) return new Response('unknown bridge', { status: 404 });
      await sleep(200); // stand in for the real broker's long-poll so the loop doesn't spin hot
      return Response.json({ commands: [] });
    }
    if (url.pathname === '/pi/bridge/events' && req.method === 'POST') {
      try {
        for (const ev of ((await req.json()) as any)?.events ?? []) eventBodies.push(ev);
      } catch {
        /* malformed test traffic */
      }
      return Response.json({});
    }
    return Response.json({}); // flush/bye — accept and ignore
  },
});

// ── fake pi ExtensionAPI + ctx ───────────────────────────────────────────────
const handlers = new Map<string, (event: any, ctx: any) => unknown>();
const fakePi: any = {
  on(name: string, fn: (event: any, ctx: any) => unknown) { handlers.set(name, fn); },
  registerTool() {},
  sendUserMessage() {},
  setModel() {},
  getThinkingLevel: () => undefined,
  setThinkingLevel() {},
};
const fakeCtx: any = {
  cwd: '/tmp/cosyncing-pi-rehello',
  sessionManager: {
    getSessionFile: () => '/tmp/cosyncing-pi-rehello/2026-07-12T00-00-00-000Z_rehello.jsonl',
    getEntries: () => [],
  },
  ui: { setStatus() {} },
};

try {
  const ext = (await import('../../../../packages/typescript/adapters/pi/agent-extensions/cosyncing-bridge/index.ts')).default;
  ext(fakePi);
  await handlers.get('session_start')?.({}, fakeCtx);

  // 1) initial registration
  const helloed = await waitFor(() => helloBodies.length === 1, 5000);
  check('bridge hellos on session_start', helloed, `hellos=${helloBodies.length}`);
  check('hello carries the session file', helloBodies[0]?.sessionFile?.includes('rehello.jsonl') === true);

  // 2) broker restart: forget every registration → the stale-id poll 404s → bridge must RE-HELLO
  knownIds.clear();
  const rehelloed = await waitFor(() => helloBodies.length === 2, 15000);
  check('poll 404 (broker restart) triggers an automatic re-hello', rehelloed, `hellos=${helloBodies.length}`);
  check('re-hello carries a fresh history backfill payload', rehelloed && Array.isArray(helloBodies[1]?.history));

  // 3) after re-registering, polling resumes under the NEW id (registration is live again)
  const rebridged = await waitFor(() => knownIds.size === 1, 5000);
  check('bridge resumes polling under the new registration', rebridged);

  // 3b) backfill duration semantics: a hello taken MID-RUN must report the
  // trailing turn as running with no duration, and a COMPLETED prior turn's
  // span from its entry write-times — never a per-entry "done" inferred from
  // adjacent message timestamps.
  fakeCtx.sessionManager.getEntries = () => [
    // Inner message timestamps mirror the real format: the user's equals its entry
    // write time; the assistant's is its REQUEST-CREATION time (≈ the previous
    // entry's clock) — the exact value the retired inference misread as an end.
    { type: 'message', id: 'e-u1', timestamp: '2026-07-12T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }], timestamp: Date.parse('2026-07-12T00:00:01.000Z') } },
    { type: 'message', id: 'e-a1', timestamp: '2026-07-12T00:00:04.000Z', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'first answer' }], usage: { input: 3, output: 4 }, timestamp: Date.parse('2026-07-12T00:00:01.050Z') } },
    { type: 'message', id: 'e-u2', timestamp: '2026-07-12T00:00:10.000Z', message: { role: 'user', content: [{ type: 'text', text: 'second prompt' }], timestamp: Date.parse('2026-07-12T00:00:10.000Z') } },
    { type: 'message', id: 'e-a2', timestamp: '2026-07-12T00:00:12.000Z', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'e-tc1', name: 'bash', arguments: { command: 'sleep 100' } }], usage: { input: 5, output: 6 }, timestamp: Date.parse('2026-07-12T00:00:10.020Z') } },
  ];
  knownIds.clear(); // force a re-hello that carries the mid-run backfill
  const backfilled = await waitFor(() => helloBodies.length === 3, 15000);
  check('mid-run backfill re-hello arrives', backfilled, `hellos=${helloBodies.length}`);
  const backfill: any[] = helloBodies[2]?.history ?? [];
  const backfillSummaries = backfill.filter((m) => m.t === 'run-summary');
  const closedTurn = backfillSummaries.find((m) => m.userMessageKey === 'u0');
  const openTurn = backfillSummaries.find((m) => m.userMessageKey === 'u1');
  check(
    'backfill closes a finished turn from entry write-times only',
    closedTurn?.status === 'done'
      && closedTurn?.totalRuntimeMs === 3000
      && closedTurn?.startedAt === Date.parse('2026-07-12T00:00:01.000Z')
      && closedTurn?.completedAt === Date.parse('2026-07-12T00:00:04.000Z'),
    JSON.stringify(closedTurn),
  );
  check(
    'backfill reports the trailing mid-run turn as running with no duration',
    openTurn?.status === 'running'
      && openTurn?.totalRuntimeMs === undefined
      && openTurn?.completedAt === undefined,
    JSON.stringify(openTurn),
  );
  check(
    'backfill emits one summary per user turn',
    backfillSummaries.length === 2,
    JSON.stringify(backfillSummaries),
  );

  // 3c) live per-user-turn lifecycle: ONE run (one agent_start … one agent_end)
  // that batches TWO user turns — a prompt plus a queued follow-up consumed
  // mid-run. The live stream must mint one summary per USER TURN (the same
  // authority model buildHistory and the broker's JSONL mapper apply), never
  // one per run, or summary count/keys/timing/token grouping all change on the
  // next backfill. The 3b re-hello re-seeded the user-key ordinal at u2, so
  // these live turns take the exact keys the next backfill gives the same
  // entries — asserted byte-for-byte in the convergence block below.
  const runStartMs = Date.parse('2026-07-12T01:00:00.000Z');
  const firstUserMs = runStartMs; // typed prompt: created at the instant the run starts
  const firstToolEndMs = runStartMs + 30_000;
  const firstDoneMs = runStartMs + 90_000;
  const queuedUserMs = runStartMs + 10_000; // queued while turn 1 streamed…
  const queuedConsumedMs = firstDoneMs + 10; // …consumed at the turn boundary
  const secondDoneMs = runStartMs + 150_000;
  const runEndMs = secondDoneMs + 50;
  eventBodies.length = 0;
  await handlers.get('agent_start')?.({ timestamp: runStartMs }, fakeCtx);
  await handlers.get('turn_start')?.({ timestamp: runStartMs + 20 }, fakeCtx);
  // Real Pi ordering is turn_start BEFORE the user message_start. The former must not mint an
  // orphan fallback summary while the latter is still about to provide the durable turn anchor.
  await handlers.get('message_start')?.({ timestamp: firstUserMs, message: { role: 'user', content: [{ type: 'text', text: 'live first' }], timestamp: firstUserMs } }, fakeCtx);
  await handlers.get('message_update')?.({ assistantMessageEvent: { type: 'text_delta', delta: 'working ' } }, fakeCtx);
  await handlers.get('message_end')?.({ timestamp: firstToolEndMs, message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'working on it' }], usage: { input: 10, output: 1 } } }, fakeCtx);
  await waitFor(() => eventBodies.some((m) => m.t === 'final'), 5000);
  check(
    'a mid-turn toolUse message_end emits no completed run summary',
    !eventBodies.some((m) => m.t === 'run-summary' && m.status === 'done'),
    JSON.stringify(eventBodies.filter((m) => m.t === 'run-summary')),
  );
  await handlers.get('message_end')?.({ timestamp: firstDoneMs, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'first done' }], usage: { input: 20, output: 2 } } }, fakeCtx);
  // The queued follow-up enters the conversation — the boundary that must CLOSE
  // turn u2 (already closed by its terminal stop above) and OPEN turn u3.
  await handlers.get('turn_start')?.({ timestamp: queuedConsumedMs + 10 }, fakeCtx);
  await handlers.get('message_start')?.({ timestamp: queuedConsumedMs, message: { role: 'user', content: [{ type: 'text', text: 'live follow-up' }], timestamp: queuedUserMs } }, fakeCtx);
  await handlers.get('message_update')?.({ assistantMessageEvent: { type: 'text_delta', delta: 'following ' } }, fakeCtx);
  await handlers.get('message_end')?.({ timestamp: secondDoneMs, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'follow-up done' }], usage: { input: 5, output: 7 } } }, fakeCtx);
  await handlers.get('agent_end')?.({ timestamp: runEndMs }, fakeCtx);
  const liveDoneSeen = await waitFor(
    () => eventBodies.filter((m) => m.t === 'run-summary' && m.status === 'done').length === 2,
    5000,
  );
  check('one done summary per user turn (not one per run)', liveDoneSeen, JSON.stringify(eventBodies.filter((m) => m.t === 'run-summary')));
  const liveDone = eventBodies.filter((m) => m.t === 'run-summary' && m.status === 'done');
  const liveProjection = liveDone.map((m) => ({
    key: m.key,
    turnId: m.turnId,
    userMessageKey: m.userMessageKey,
    status: m.status,
    startedAt: m.startedAt,
    completedAt: m.completedAt,
    totalRuntimeMs: m.totalRuntimeMs,
    tokens: m.tokens,
  }));
  check(
    'each turn summary spans ITS user message to ITS terminal stop with ITS usage',
    JSON.stringify(liveProjection) === JSON.stringify([
      { key: 'pi:run:u2', turnId: 'u2', userMessageKey: 'u2', status: 'done', startedAt: firstUserMs, completedAt: firstDoneMs, totalRuntimeMs: firstDoneMs - firstUserMs, tokens: { input: 30, output: 3 } },
      { key: 'pi:run:u3', turnId: 'u3', userMessageKey: 'u3', status: 'done', startedAt: queuedUserMs, completedAt: secondDoneMs, totalRuntimeMs: secondDoneMs - queuedUserMs, tokens: { input: 5, output: 7 } },
    ]),
    JSON.stringify(liveProjection),
  );
  check(
    'no summary spans the whole run',
    !liveDone.some((m) => m.startedAt === runStartMs && m.completedAt === runEndMs),
    JSON.stringify(liveDone),
  );
  check(
    'exactly one running summary was minted per user turn',
    eventBodies.filter((m) => m.t === 'run-summary' && m.status === 'running').length === 2,
    JSON.stringify(eventBodies.filter((m) => m.t === 'run-summary')),
  );
  check(
    'queued follow-up got its own user bubble in the live key space',
    eventBodies.some((m) => m.t === 'user' && m.key === 'u3' && m.text === 'live follow-up'),
    JSON.stringify(eventBodies.filter((m) => m.t === 'user')),
  );

  // 3d) reload convergence: the SAME run read back from the session entries must
  // produce the SAME turn summaries — same keys, grouping, spans, and token
  // groups — or a reload visibly regroups the transcript's footers.
  const priorEntries = fakeCtx.sessionManager.getEntries();
  fakeCtx.sessionManager.getEntries = () => [
    ...priorEntries,
    { type: 'message', id: 'e-u3', timestamp: new Date(firstUserMs).toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'live first' }], timestamp: firstUserMs } },
    { type: 'message', id: 'e-a3a', timestamp: new Date(firstToolEndMs).toISOString(), message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'working on it' }], usage: { input: 10, output: 1 }, timestamp: firstUserMs + 40 } },
    { type: 'message', id: 'e-a3b', timestamp: new Date(firstDoneMs).toISOString(), message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'first done' }], usage: { input: 20, output: 2 }, timestamp: firstToolEndMs + 40 } },
    { type: 'message', id: 'e-u4', timestamp: new Date(queuedConsumedMs).toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'live follow-up' }], timestamp: queuedUserMs } },
    { type: 'message', id: 'e-a4', timestamp: new Date(secondDoneMs).toISOString(), message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'follow-up done' }], usage: { input: 5, output: 7 }, timestamp: queuedConsumedMs + 40 } },
  ];
  knownIds.clear(); // force a re-hello whose backfill re-maps the live run above
  const convergeHellos = helloBodies.length;
  const converged = await waitFor(() => helloBodies.length > convergeHellos, 15000);
  check('convergence re-hello arrives', converged, `hellos=${helloBodies.length}`);
  const convergedBackfill: any[] = helloBodies[helloBodies.length - 1]?.history ?? [];
  const reloadProjection = convergedBackfill
    .filter((m) => m.t === 'run-summary' && (m.userMessageKey === 'u2' || m.userMessageKey === 'u3'))
    .map((m) => ({
      key: m.key,
      turnId: m.turnId,
      userMessageKey: m.userMessageKey,
      status: m.status,
      startedAt: m.startedAt,
      completedAt: m.completedAt,
      totalRuntimeMs: m.totalRuntimeMs,
      tokens: m.tokens,
    }));
  check(
    'a reload reproduces the live turn summaries exactly (keys, spans, tokens)',
    JSON.stringify(reloadProjection) === JSON.stringify(liveProjection),
    `live=${JSON.stringify(liveProjection)} reload=${JSON.stringify(reloadProjection)}`,
  );

  // 4) session_shutdown stops the loop for good — another forget must NOT re-hello
  await handlers.get('session_shutdown')?.({ reason: 'quit' }, fakeCtx);
  knownIds.clear();
  const hellosAtShutdown = helloBodies.length;
  await sleep(7000); // > hello retry interval — long enough for a leak to show
  check('after session_shutdown the bridge never re-hellos again', helloBodies.length === hellosAtShutdown, `hellos=${helloBodies.length} (was ${hellosAtShutdown})`);
} finally {
  server.stop(true);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nFAIL: ${failed.length}/${results.length}` : `\n${results.length} passed, 0 failed`);
process.exit(failed.length ? 1 : 0);
