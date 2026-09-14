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
 *   bun run packages/typescript/adapters/pi/test/test-pi-bridge-rehello.ts   (exit 0 = all pass)
 */
export {};
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 19000 + Math.floor(Math.random() * 20000));
process.env.COSYNCING_BROKER = `http://127.0.0.1:${PORT}`; // must be set BEFORE the module import below

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
function summaryProjection(message: any): Record<string, unknown> {
  return {
    key: message?.key,
    turnId: message?.turnId,
    userMessageKey: message?.userMessageKey,
    status: message?.status,
    startedAt: message?.startedAt,
    completedAt: message?.completedAt,
    totalRuntimeMs: message?.totalRuntimeMs,
    tokens: message?.tokens,
  };
}
function ordinalPrefixTurns(count: number, before: number): any[] {
  const entries: any[] = [];
  let parentId: string | null = null;
  for (let index = 0; index < count; index += 1) {
    const userId = `retry-prefix-user-${index}`;
    const assistantId = `retry-prefix-assistant-${index}`;
    const startedAt = before - (count - index) * 10_000;
    entries.push({
      type: 'message', id: userId, parentId, timestamp: new Date(startedAt).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: `prefix ${index}` }], timestamp: startedAt },
    });
    entries.push({
      type: 'message', id: assistantId, parentId: userId, timestamp: new Date(startedAt + 1_000).toISOString(),
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: `prefix done ${index}` }] },
    });
    parentId = assistantId;
  }
  return entries;
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
const queuedCommands: any[] = [];
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
      return Response.json({ commands: queuedCommands.splice(0) });
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
const sentCustomMessages: Array<{ message: any; options: any }> = [];
let rejectCustomMessage = false;
const skillDir = join('/tmp', `cosyncing-pi-bridge-skill-${process.pid}-${Math.random().toString(36).slice(2)}`);
const skillFile = join(skillDir, 'SKILL.md');
mkdirSync(skillDir, { recursive: true });
writeFileSync(skillFile, `---\nname: review\ndescription: Review fixture\n---\n\nFOLLOW_THE_REAL_SKILL_BODY\nSECOND_LINE\n`);
const fakePi: any = {
  on(name: string, fn: (event: any, ctx: any) => unknown) { handlers.set(name, fn); },
  registerTool() {},
  sendUserMessage() { throw new Error('bridge commands must not use literal sendUserMessage'); },
  sendMessage(message: any, options: any) {
    if (rejectCustomMessage) throw new Error('fixture rejected custom message');
    sentCustomMessages.push({ message, options });
  },
  setModel() {},
  getThinkingLevel: () => undefined,
  setThinkingLevel() {},
};
const fakeCtx: any = {
  cwd: '/tmp/cosyncing-pi-rehello',
  getContextUsage: () => ({ tokens: 4096, contextWindow: 128000, percent: 3.2 }),
  sessionManager: {
    getSessionFile: () => '/tmp/cosyncing-pi-rehello/2026-07-12T00-00-00-000Z_rehello.jsonl',
    getEntries: () => [],
  },
  resourceLoader: {
    getSkills: () => ({
      skills: [{ name: 'review', description: 'Review fixture', filePath: skillFile, baseDir: skillDir }],
    }),
  },
  ui: { setStatus() {} },
};

try {
  const ext = (await import('../../../pi-engine/agent-extensions/cosyncing-bridge/index.ts')).default;
  ext(fakePi);
  await handlers.get('session_start')?.({}, fakeCtx);

  // 1) initial registration
  const helloed = await waitFor(() => helloBodies.length === 1, 5000);
  check('bridge hellos on session_start', helloed, `hellos=${helloBodies.length}`);
  check('hello carries the session file', helloBodies[0]?.sessionFile?.includes('rehello.jsonl') === true);
  check(
    'hello history carries exact native context usage for replay',
    helloBodies[0]?.history?.some((m: any) => m.t === 'context-usage' && m.value?.tokens === 4096 && m.value?.contextWindow === 128000) === true,
    JSON.stringify(helloBodies[0]?.history),
  );

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
  fakeCtx.getContextUsage = () => ({ tokens: 8192, contextWindow: 128000, percent: 6.4 });
  await handlers.get('agent_end')?.({ timestamp: runEndMs }, fakeCtx);
  const liveDoneSeen = await waitFor(
    () => eventBodies.filter((m) => m.t === 'run-summary' && m.status === 'done').length === 2,
    5000,
  );
  check('one done summary per user turn (not one per run)', liveDoneSeen, JSON.stringify(eventBodies.filter((m) => m.t === 'run-summary')));
  check(
    'agent_end relays the latest exact native context usage',
    eventBodies.some((m) => m.t === 'context-usage' && m.value?.tokens === 8192 && m.value?.contextWindow === 128000),
    JSON.stringify(eventBodies.filter((m) => m.t === 'context-usage')),
  );
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

  // 3e) app prompts use Pi/OMP's durable, attributed custom-message carrier. This proves the real
  // extension receives the broker identities, persists them on the exact message payload, relays
  // them live, reconstructs them after re-hello, and never stamps identical terminal input.
  const correlationEventStart = eventBodies.length;
  const extOneSentAt = Date.parse('2026-07-12T01:59:58.000Z');
  const extTwoSentAt = Date.parse('2026-07-12T01:59:59.000Z');
  queuedCommands.push(
    { id: 101, kind: 'prompt', text: 'SAME REMOTE TEXT', messageKey: 'u:remote:ext-one', clientKey: 'ca.ext.one', sentAt: extOneSentAt, deliverAs: 'steer' },
    { id: 102, kind: 'prompt', text: 'SAME REMOTE TEXT', messageKey: 'u:remote:ext-two', clientKey: 'ca.ext.two', sentAt: extTwoSentAt, deliverAs: 'followUp' },
  );
  const deliveredCustom = await waitFor(() => sentCustomMessages.length >= 2, 5000);
  check(
    'extension injects queued identical app prompts as distinct attributed collab-prompt messages',
    deliveredCustom
      && sentCustomMessages[0]?.message?.customType === 'collab-prompt'
      && sentCustomMessages[0]?.message?.attribution === 'user'
      && sentCustomMessages[0]?.message?.details?.messageKey === 'u:remote:ext-one'
      && sentCustomMessages[0]?.message?.details?.clientKey === 'ca.ext.one'
      && sentCustomMessages[0]?.message?.details?.sentAt === extOneSentAt
      && sentCustomMessages[0]?.options?.deliverAs === 'steer'
      && sentCustomMessages[1]?.message?.details?.messageKey === 'u:remote:ext-two'
      && sentCustomMessages[1]?.message?.details?.clientKey === 'ca.ext.two'
      && sentCustomMessages[1]?.message?.details?.sentAt === extTwoSentAt
      && sentCustomMessages[1]?.options?.deliverAs === 'followUp',
    JSON.stringify(sentCustomMessages),
  );
  const customBeforeSkill = sentCustomMessages.length;
  queuedCommands.push({ id: 102.5, kind: 'command', name: 'skill:review', args: 'now', deliverAs: 'followUp' });
  const deliveredCommand = await waitFor(() => sentCustomMessages.length > customBeforeSkill, 5000);
  const skillDelivery = sentCustomMessages[customBeforeSkill];
  check(
    'advertised skill command expands to OMP native skill-prompt content instead of literal model input',
    deliveredCommand
      && skillDelivery?.message?.customType === 'skill-prompt'
      && skillDelivery?.message?.attribution === 'user'
      && skillDelivery?.message?.content?.includes('FOLLOW_THE_REAL_SKILL_BODY')
      && skillDelivery?.message?.content?.includes('User: now')
      && !skillDelivery?.message?.content?.includes('/skill:review')
      && skillDelivery?.message?.details?.name === 'review'
      && skillDelivery?.message?.details?.path === skillFile
      && skillDelivery?.message?.details?.lineCount === 2
      && typeof skillDelivery?.message?.details?.sentAt === 'number'
      && skillDelivery?.options?.triggerTurn === true
      && skillDelivery?.options?.deliverAs === 'followUp',
    JSON.stringify(skillDelivery),
  );

  // The expanded body is model context, not the user's transcript text. Prove the native custom
  // message opens a normal user turn live, then persist that exact envelope and require re-hello to
  // reproduce the same compact invocation, key, clocks, and completed summary.
  const skillLiveStart = eventBodies.length;
  const skillStartedAt = Number(skillDelivery!.message.details.sentAt);
  const skillLiveMessageAt = skillStartedAt + 400;
  const skillEntryAt = skillStartedAt + 900;
  const skillCompletedAt = skillStartedAt + 2500;
  await handlers.get('agent_start')?.({ timestamp: skillLiveMessageAt }, fakeCtx);
  await handlers.get('turn_start')?.({ timestamp: skillLiveMessageAt + 1 }, fakeCtx);
  await handlers.get('message_start')?.({
    timestamp: skillLiveMessageAt,
    message: { role: 'custom', ...skillDelivery!.message, attribution: undefined, timestamp: skillLiveMessageAt },
  }, fakeCtx);
  await handlers.get('message_end')?.({
    timestamp: skillCompletedAt,
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'SKILL LIVE DONE' }], usage: { input: 2, output: 3 } },
  }, fakeCtx);
  await handlers.get('agent_end')?.({ timestamp: skillCompletedAt + 1 }, fakeCtx);
  const skillLiveSeen = await waitFor(
    () => eventBodies.slice(skillLiveStart).some((m) => m.t === 'run-summary' && m.status === 'done'),
    5000,
  );
  const skillLiveEvents = eventBodies.slice(skillLiveStart);
  const skillLiveUser = skillLiveEvents.find((m) => m.t === 'user' && m.text === '/skill:review now');
  const skillLiveSummary = skillLiveEvents.find(
    (m) => m.t === 'run-summary' && m.status === 'done' && m.userMessageKey === skillLiveUser?.key,
  );
  check(
    'live native skill prompt emits only the compact invocation and owns its run boundary',
    skillLiveSeen
      && skillLiveUser?.key === 'u4'
      && !skillLiveEvents.some((m) => m.t === 'user' && String(m.text).includes('FOLLOW_THE_REAL_SKILL_BODY'))
      && skillLiveSummary?.key === 'pi:run:u4'
      && skillLiveSummary?.startedAt === skillStartedAt
      && skillLiveSummary?.completedAt === skillCompletedAt
      && skillLiveSummary?.totalRuntimeMs === 2500,
    JSON.stringify(skillLiveEvents),
  );

  const entriesBeforeSkill = fakeCtx.sessionManager.getEntries();
  fakeCtx.sessionManager.getEntries = () => [
    ...entriesBeforeSkill,
    {
      type: 'custom_message',
      id: 'native-skill-review',
      timestamp: new Date(skillEntryAt).toISOString(),
      ...skillDelivery!.message,
      attribution: undefined,
    },
    {
      type: 'message',
      id: 'native-skill-answer',
      timestamp: new Date(skillCompletedAt).toISOString(),
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'SKILL LIVE DONE' }], usage: { input: 2, output: 3 } },
    },
  ];
  knownIds.clear();
  const skillHelloCount = helloBodies.length;
  const skillRehello = await waitFor(() => helloBodies.length > skillHelloCount, 15000);
  const skillHistory = helloBodies[helloBodies.length - 1]?.history ?? [];
  const skillReloadUser = skillHistory.find((m: any) => m.t === 'user' && m.text === '/skill:review now');
  const skillReloadSummary = skillHistory.find(
    (m: any) => m.t === 'run-summary' && m.userMessageKey === skillReloadUser?.key,
  );
  check(
    're-hello converges the persisted skill invocation and summary with the live identities',
    skillRehello
      && skillReloadUser?.key === skillLiveUser?.key
      && skillLiveMessageAt !== skillStartedAt
      && skillEntryAt !== skillStartedAt
      && skillEntryAt !== skillLiveMessageAt
      && !skillHistory.some((m: any) => m.t === 'user' && String(m.text).includes('FOLLOW_THE_REAL_SKILL_BODY'))
      && JSON.stringify({
        key: skillReloadSummary?.key,
        turnId: skillReloadSummary?.turnId,
        userMessageKey: skillReloadSummary?.userMessageKey,
        startedAt: skillReloadSummary?.startedAt,
        completedAt: skillReloadSummary?.completedAt,
        totalRuntimeMs: skillReloadSummary?.totalRuntimeMs,
        tokens: skillReloadSummary?.tokens,
      }) === JSON.stringify({
        key: skillLiveSummary?.key,
        turnId: skillLiveSummary?.turnId,
        userMessageKey: skillLiveSummary?.userMessageKey,
        startedAt: skillLiveSummary?.startedAt,
        completedAt: skillLiveSummary?.completedAt,
        totalRuntimeMs: skillLiveSummary?.totalRuntimeMs,
        tokens: skillLiveSummary?.tokens,
      }),
    JSON.stringify({ skillLiveUser, skillLiveSummary, skillReloadUser, skillReloadSummary }),
  );

  // OMP's own terminal /skill path creates the same native envelope without the bridge-owned
  // sentAt detail. It must still be a user boundary. Live uses the message clock; persisted replay
  // uses the independently minted custom-entry clock, while identity and grouping still converge.
  const nativeSkillDetails = { ...skillDelivery!.message.details };
  delete nativeSkillDetails.sentAt;
  const nativeSkillMessage = { ...skillDelivery!.message, details: nativeSkillDetails };
  const nativeSkillLiveStart = eventBodies.length;
  const nativeSkillMessageAt = skillCompletedAt + 5000;
  const nativeSkillEntryAt = nativeSkillMessageAt + 700;
  const nativeSkillCompletedAt = nativeSkillMessageAt + 3000;
  await handlers.get('agent_start')?.({ timestamp: nativeSkillMessageAt }, fakeCtx);
  await handlers.get('turn_start')?.({ timestamp: nativeSkillMessageAt + 1 }, fakeCtx);
  await handlers.get('message_start')?.({
    timestamp: nativeSkillMessageAt,
    message: { role: 'custom', ...nativeSkillMessage, timestamp: nativeSkillMessageAt },
  }, fakeCtx);
  await handlers.get('message_end')?.({
    timestamp: nativeSkillCompletedAt,
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'TERMINAL SKILL DONE' }] },
  }, fakeCtx);
  await handlers.get('agent_end')?.({ timestamp: nativeSkillCompletedAt + 1 }, fakeCtx);
  const nativeSkillLiveSeen = await waitFor(
    () => eventBodies.slice(nativeSkillLiveStart).some((m) => m.t === 'run-summary' && m.status === 'done'),
    5000,
  );
  const nativeSkillLiveEvents = eventBodies.slice(nativeSkillLiveStart);
  const nativeSkillLiveUser = nativeSkillLiveEvents.find((m) => m.t === 'user' && m.text === '/skill:review now');
  const nativeSkillLiveSummary = nativeSkillLiveEvents.find(
    (m) => m.t === 'run-summary' && m.status === 'done' && m.userMessageKey === nativeSkillLiveUser?.key,
  );
  check(
    'live terminal-native skill prompt without sentAt owns a compact user turn',
    nativeSkillLiveSeen
      && nativeSkillLiveUser?.key === 'u5'
      && nativeSkillLiveUser?.sentAt === nativeSkillMessageAt
      && nativeSkillLiveSummary?.key === 'pi:run:u5'
      && nativeSkillLiveSummary?.startedAt === nativeSkillMessageAt
      && !nativeSkillLiveEvents.some((m) => m.t === 'user' && String(m.text).includes('FOLLOW_THE_REAL_SKILL_BODY')),
    JSON.stringify(nativeSkillLiveEvents),
  );

  const entriesBeforeNativeSkill = fakeCtx.sessionManager.getEntries();
  fakeCtx.sessionManager.getEntries = () => [
    ...entriesBeforeNativeSkill,
    {
      type: 'custom_message',
      id: 'native-terminal-skill-review',
      timestamp: new Date(nativeSkillEntryAt).toISOString(),
      ...nativeSkillMessage,
    },
    {
      type: 'message',
      id: 'native-terminal-skill-answer',
      timestamp: new Date(nativeSkillCompletedAt).toISOString(),
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'TERMINAL SKILL DONE' }] },
    },
  ];
  knownIds.clear();
  const nativeSkillHelloCount = helloBodies.length;
  const nativeSkillRehello = await waitFor(() => helloBodies.length > nativeSkillHelloCount, 15000);
  const nativeSkillHistory = helloBodies[helloBodies.length - 1]?.history ?? [];
  const nativeSkillReloadUser = nativeSkillHistory.find(
    (m: any) => m.t === 'user' && m.key === nativeSkillLiveUser?.key && m.text === '/skill:review now',
  );
  const nativeSkillReloadSummary = nativeSkillHistory.find(
    (m: any) => m.t === 'run-summary' && m.userMessageKey === nativeSkillLiveUser?.key,
  );
  check(
    're-hello retains a terminal-native no-sentAt skill boundary under its native entry clock',
    nativeSkillRehello
      && nativeSkillReloadUser?.key === 'u5'
      && nativeSkillReloadUser?.sentAt === nativeSkillEntryAt
      && nativeSkillReloadSummary?.key === 'pi:run:u5'
      && nativeSkillReloadSummary?.startedAt === nativeSkillEntryAt
      && nativeSkillReloadSummary?.completedAt === nativeSkillCompletedAt
      && nativeSkillEntryAt !== nativeSkillMessageAt,
    JSON.stringify({ nativeSkillLiveUser, nativeSkillLiveSummary, nativeSkillReloadUser, nativeSkillReloadSummary }),
  );

  const terminalAt = Date.parse('2026-07-12T02:00:00.000Z');
  // Interleave same-text terminal input before both native custom events. There is no pending FIFO
  // lookup: each app event brings its own identity, and the terminal row stays ordinal/unstamped.
  await handlers.get('message_start')?.({ timestamp: terminalAt, message: { role: 'user', content: [{ type: 'text', text: 'SAME REMOTE TEXT' }], timestamp: terminalAt } }, fakeCtx);
  await handlers.get('message_start')?.({ timestamp: terminalAt + 1, message: { role: 'custom', ...sentCustomMessages[0]!.message, attribution: undefined, timestamp: terminalAt + 1 } }, fakeCtx);
  await handlers.get('message_start')?.({ timestamp: terminalAt + 2, message: { role: 'custom', ...sentCustomMessages[1]!.message, timestamp: terminalAt + 2 } }, fakeCtx);
  const liveCorrelationsSeen = await waitFor(
    () => eventBodies.slice(correlationEventStart).filter((m) => m.t === 'user').length >= 3,
    5000,
  );
  const liveCorrelationUsers = eventBodies.slice(correlationEventStart).filter(
    (m) => m.t === 'user' && m.text === 'SAME REMOTE TEXT',
  );
  check(
    'live relay keeps each exact app correlation while identical terminal input stays unstamped',
    liveCorrelationsSeen
      && liveCorrelationUsers[0]?.key?.startsWith('u')
      && liveCorrelationUsers[0]?.clientKey === undefined
      && liveCorrelationUsers[1]?.key === 'u:remote:ext-one'
      && liveCorrelationUsers[1]?.clientKey === 'ca.ext.one'
      && liveCorrelationUsers[1]?.sentAt === extOneSentAt
      && liveCorrelationUsers[2]?.key === 'u:remote:ext-two'
      && liveCorrelationUsers[2]?.clientKey === 'ca.ext.two',
    JSON.stringify(liveCorrelationUsers),
  );
  const liveRemoteSummaries = eventBodies.slice(correlationEventStart).filter(
    (m) => m.t === 'run-summary' && m.status === 'running' && String(m.turnId).startsWith('u:remote:'),
  );
  check(
    'live remote summaries use the durable remote anchors and original app-send clocks',
    liveRemoteSummaries.some((m) => m.key === 'pi:run:u:remote:ext-one' && m.startedAt === extOneSentAt)
      && liveRemoteSummaries.some((m) => m.key === 'pi:run:u:remote:ext-two' && m.startedAt === extTwoSentAt),
    JSON.stringify(liveRemoteSummaries),
  );

  // A synchronous native injection failure must not manufacture a marker or stamp.
  rejectCustomMessage = true;
  const sentBeforeFailure = sentCustomMessages.length;
  const errorsBeforeFailure = eventBodies.filter((m) => m.t === 'error').length;
  queuedCommands.push({ id: 103, kind: 'prompt', text: 'MUST NOT PERSIST', messageKey: 'u:remote:failed', clientKey: 'ca.ext.failed', sentAt: terminalAt + 3 });
  const failureVisible = await waitFor(
    () => eventBodies.filter((m) => m.t === 'error').length > errorsBeforeFailure,
    5000,
  );
  rejectCustomMessage = false;
  check(
    'failed custom-message injection emits an error and leaves no message/stamp behind',
    failureVisible && sentCustomMessages.length === sentBeforeFailure,
    JSON.stringify(eventBodies.filter((m) => m.t === 'error').slice(-2)),
  );

  // Persisted rows are the authority on re-hello. This simulates the event POST being lost after
  // native storage succeeded: the fresh hello must still carry both app correlations exactly once.
  fakeCtx.sessionManager.getEntries = () => [
    { type: 'message', id: 'native-terminal-same', timestamp: new Date(terminalAt).toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'SAME REMOTE TEXT' }], timestamp: terminalAt } },
    { type: 'custom_message', id: 'native-remote-one', timestamp: new Date(terminalAt + 1).toISOString(), ...sentCustomMessages[0]!.message, attribution: undefined },
    { type: 'message', id: 'native-remote-answer', timestamp: new Date(terminalAt + 4000).toISOString(), message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'REMOTE DONE' }], usage: { input: 7, output: 8 } } },
    { type: 'custom_message', id: 'native-remote-two', timestamp: new Date(terminalAt + 2).toISOString(), ...sentCustomMessages[1]!.message },
  ];
  knownIds.clear();
  const durableHelloCount = helloBodies.length;
  const durableRehello = await waitFor(() => helloBodies.length > durableHelloCount, 15000);
  const durableUsers = (helloBodies[helloBodies.length - 1]?.history ?? []).filter((m: any) => m.t === 'user');
  check(
    're-hello reconstructs persisted correlations and the same-text terminal row independently',
    durableRehello
      && durableUsers.length === 3
      && durableUsers[0]?.clientKey === undefined
      && durableUsers[1]?.key === 'u:remote:ext-one'
      && durableUsers[1]?.clientKey === 'ca.ext.one'
      && durableUsers[2]?.key === 'u:remote:ext-two'
      && durableUsers[2]?.clientKey === 'ca.ext.two',
    JSON.stringify(durableUsers),
  );
  const durableRemoteSummary = (helloBodies[helloBodies.length - 1]?.history ?? []).find(
    (m: any) => m.t === 'run-summary' && m.turnId === 'u:remote:ext-one',
  );
  check(
    're-hello summary keeps the durable remote anchor and original app-send clock',
    durableRemoteSummary?.key === 'pi:run:u:remote:ext-one'
      && durableRemoteSummary?.userMessageKey === 'u:remote:ext-one'
      && durableRemoteSummary?.startedAt === extOneSentAt
      && durableRemoteSummary?.completedAt === terminalAt + 4000
      && durableRemoteSummary?.totalRuntimeMs === terminalAt + 4000 - extOneSentAt,
    JSON.stringify(durableRemoteSummary),
  );

  // Conflicting disk identities and forged provenance fail closed over the complete snapshot. Both
  // duplicate physical rows remain distinct under native ids, neither can collapse an app bubble,
  // and malformed/wrong-attribution rows are ignored. Old branch identities disappear entirely.
  const duplicatePayload = sentCustomMessages[0]!.message;
  fakeCtx.sessionManager.getEntries = () => [
    { type: 'custom_message', id: 'native-dup-one', timestamp: new Date(terminalAt + 10).toISOString(), ...duplicatePayload },
    { type: 'custom_message', id: 'native-dup-two', timestamp: new Date(terminalAt + 11).toISOString(), ...duplicatePayload },
    { type: 'custom_message', id: 'native-wrong-attribution', timestamp: new Date(terminalAt + 12).toISOString(), ...duplicatePayload, attribution: 'assistant' },
    { type: 'custom_message', id: 'native-wrong-source', timestamp: new Date(terminalAt + 13).toISOString(), ...duplicatePayload, details: { ...duplicatePayload.details, from: 'not-cosyncing', messageKey: 'u:remote:forged', clientKey: 'ca.ext.forged' } },
  ];
  knownIds.clear();
  const duplicateHelloCount = helloBodies.length;
  const duplicateRehello = await waitFor(() => helloBodies.length > duplicateHelloCount, 15000);
  const duplicateUsers = (helloBodies[helloBodies.length - 1]?.history ?? []).filter((m: any) => m.t === 'user');
  check(
    'duplicate/forged reconstruction fails closed and branch replacement inherits no old identity',
    duplicateRehello
      && duplicateUsers.length === 2
      && duplicateUsers[0]?.key === 'native-dup-one'
      && duplicateUsers[1]?.key === 'native-dup-two'
      && duplicateUsers.every((m: any) => m.clientKey === undefined)
      && duplicateUsers.every((m: any) => m.key !== 'u:remote:ext-two'),
    JSON.stringify(duplicateUsers),
  );

  // getEntries contains the whole append-only tree, including an abandoned duplicate. getBranch is
  // the native active-leaf authority and must be selected before correlation uniqueness is judged.
  const activeBranchEntry = {
    type: 'custom_message',
    id: 'native-active-branch',
    timestamp: new Date(terminalAt + 20).toISOString(),
    ...sentCustomMessages[0]!.message,
    attribution: undefined,
  };
  fakeCtx.sessionManager.getEntries = () => [
    { ...activeBranchEntry, id: 'native-abandoned-branch', content: 'ABANDONED BRANCH' },
    activeBranchEntry,
    { type: 'message', id: 'native-active-answer', timestamp: new Date(terminalAt + 25).toISOString(), message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'ACTIVE BRANCH ANSWER' }] } },
  ];
  fakeCtx.sessionManager.getBranch = () => [
    activeBranchEntry,
    { type: 'message', id: 'native-active-answer', timestamp: new Date(terminalAt + 25).toISOString(), message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'ACTIVE BRANCH ANSWER' }] } },
  ];
  knownIds.clear();
  const branchHelloCount = helloBodies.length;
  const branchRehello = await waitFor(() => helloBodies.length > branchHelloCount, 15000);
  const branchHistory = helloBodies[helloBodies.length - 1]?.history ?? [];
  check(
    're-hello maps only getBranch and does not let abandoned duplicates poison active correlation',
    branchRehello
      && branchHistory.some((m: any) => m.t === 'user' && m.key === 'u:remote:ext-one' && m.clientKey === 'ca.ext.one')
      && !branchHistory.some((m: any) => m.t === 'user' && m.text === 'ABANDONED BRANCH'),
    JSON.stringify(branchHistory),
  );

  const continuingEventStart = eventBodies.length;
  const continuingStartAt = Date.parse('2026-07-12T02:50:00.000Z');
  await handlers.get('agent_start')?.({ timestamp: continuingStartAt }, fakeCtx);
  await handlers.get('turn_start')?.({ timestamp: continuingStartAt }, fakeCtx);
  await handlers.get('message_start')?.({
    timestamp: continuingStartAt,
    message: {
      role: 'user', content: [{ type: 'text', text: 'native continuation without retry event' }],
      timestamp: continuingStartAt,
    },
  }, fakeCtx);
  await handlers.get('message_end')?.({
    timestamp: continuingStartAt + 1_000,
    message: {
      role: 'assistant', stopReason: 'error', error: { message: 'empty response will continue' },
      content: [], usage: { input: 1, output: 0 },
    },
  }, fakeCtx);
  await handlers.get('agent_end')?.({ timestamp: continuingStartAt + 1_010, willContinue: true }, fakeCtx);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const continuingMidSummaries = eventBodies.slice(continuingEventStart).filter((m) => m.t === 'run-summary');
  check('OMP willContinue keeps the bridge turn open without an auto_retry_start event',
    continuingMidSummaries.length === 1
      && continuingMidSummaries[0]?.status === 'running'
      && !eventBodies.slice(continuingEventStart).some((m) => m.t === 'status' && m.running === false),
    JSON.stringify(eventBodies.slice(continuingEventStart)));
  await handlers.get('agent_start')?.({ timestamp: continuingStartAt + 1_020 }, fakeCtx);
  await handlers.get('message_end')?.({
    timestamp: continuingStartAt + 2_000,
    message: {
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'continued' }],
      usage: { input: 2, output: 1 },
    },
  }, fakeCtx);
  await handlers.get('agent_end')?.({ timestamp: continuingStartAt + 2_000 }, fakeCtx);
  const continuingDoneSeen = await waitFor(
    () => eventBodies.slice(continuingEventStart).some((m) => m.t === 'run-summary' && m.status === 'done'),
    5_000,
  );
  const continuingFinalSummaries = eventBodies.slice(continuingEventStart).filter((m) => m.t === 'run-summary');
  check('OMP willContinue closes once under the same key after the continued attempt finishes',
    continuingDoneSeen
      && new Set(continuingFinalSummaries.map((m) => m.key)).size === 1
      && continuingFinalSummaries.filter((m) => m.status === 'done').length === 1
      && continuingFinalSummaries.at(-1)?.tokens?.input === 3,
    JSON.stringify(continuingFinalSummaries));

  const retryEventStart = eventBodies.length;
  const retryStartAt = Date.parse('2026-07-12T03:00:00.000Z');
  const retryDoneAt = retryStartAt + 3_000;
  await handlers.get('agent_start')?.({ timestamp: retryStartAt }, fakeCtx);
  await handlers.get('turn_start')?.({ timestamp: retryStartAt }, fakeCtx);
  await handlers.get('message_start')?.({
    timestamp: retryStartAt,
    message: { role: 'user', content: [{ type: 'text', text: 'retry bridge prompt' }], timestamp: retryStartAt },
  }, fakeCtx);
  await handlers.get('message_end')?.({
    timestamp: retryStartAt + 1_000,
    message: {
      role: 'assistant', stopReason: 'error', error: { message: 'transient bridge failure' },
      content: [], usage: { input: 1, output: 0 },
    },
  }, fakeCtx);
  await handlers.get('auto_retry_start')?.({
    timestamp: retryStartAt + 1_010,
    attempt: 1,
    maxAttempts: 3,
    errorMessage: 'transient bridge failure',
  }, fakeCtx);
  await handlers.get('agent_end')?.({ timestamp: retryStartAt + 1_015, willContinue: true }, fakeCtx);
  await handlers.get('agent_start')?.({ timestamp: retryStartAt + 1_016 }, fakeCtx);
  await handlers.get('auto_retry_end')?.({ timestamp: retryStartAt + 1_020, success: true }, fakeCtx);
  await handlers.get('message_update')?.({ assistantMessageEvent: { type: 'text_delta', delta: 'recovered' } }, fakeCtx);
  await handlers.get('message_end')?.({
    timestamp: retryDoneAt,
    message: {
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'recovered' }],
      usage: { input: 2, output: 1 },
    },
  }, fakeCtx);
  await handlers.get('agent_end')?.({ timestamp: retryDoneAt }, fakeCtx);
  const retryLiveSeen = await waitFor(
    () => eventBodies.slice(retryEventStart).some((m) => m.t === 'run-summary' && m.status === 'done'),
    5_000,
  );
  const retryLiveSummaries = eventBodies.slice(retryEventStart).filter((m) => m.t === 'run-summary');
  const retryLiveFinal = retryLiveSummaries.at(-1);
  check(
    'bridge auto-retry preserves one user-turn key and emits no provisional terminal error',
    retryLiveSeen
      && new Set(retryLiveSummaries.map((m) => m.key)).size === 1
      && retryLiveSummaries.filter((m) => m.status === 'done').length === 1
      && !retryLiveSummaries.some((m) => m.status === 'error')
      && retryLiveSummaries.at(-1)?.status === 'done',
    JSON.stringify(retryLiveSummaries),
  );

  const retryOrdinal = Number(/^u(\d+)$/u.exec(String(retryLiveFinal?.turnId))?.[1]);
  const retryPrefix = ordinalPrefixTurns(retryOrdinal, retryStartAt);
  const retryEntries = [...retryPrefix, ...[
    {
      type: 'message', id: 'retry-user', parentId: retryPrefix.at(-1)?.id ?? null, timestamp: new Date(retryStartAt).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'retry bridge prompt' }], timestamp: retryStartAt },
    },
    {
      type: 'message', id: 'retry-superseded', parentId: 'retry-user', timestamp: new Date(retryStartAt + 1_000).toISOString(),
      message: {
        role: 'assistant', stopReason: 'error', error: { message: 'transient bridge failure' }, content: [],
        usage: { input: 1, output: 0 }, retryRecovery: { kind: 'auto-retry', status: 'superseded', attempt: 1 },
      },
    },
    {
      type: 'message', id: 'retry-recovered', parentId: 'retry-superseded', timestamp: new Date(retryDoneAt).toISOString(),
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'recovered' }], usage: { input: 2, output: 1 } },
    },
  ]];
  fakeCtx.sessionManager.getBranch = () => retryEntries;
  fakeCtx.sessionManager.getEntries = () => retryEntries;
  knownIds.clear();
  const retryHelloCount = helloBodies.length;
  const retryRehello = await waitFor(() => helloBodies.length > retryHelloCount, 15_000);
  const retryReloadSummaries = (helloBodies[helloBodies.length - 1]?.history ?? [])
    .filter((m: any) => m.t === 'run-summary');
  const retryReloadFinal = retryReloadSummaries.find((m: any) => m.startedAt === retryStartAt);
  check(
    'bridge re-hello reproduces the recovered retry identity, timing, and usage exactly',
    retryRehello
      && retryReloadFinal !== undefined
      && JSON.stringify(summaryProjection(retryReloadFinal))
        === JSON.stringify(summaryProjection(retryLiveFinal)),
    JSON.stringify({ live: summaryProjection(retryLiveFinal), reload: summaryProjection(retryReloadFinal) }),
  );

  const exhaustedEventStart = eventBodies.length;
  const exhaustedStartAt = Date.parse('2026-07-12T04:00:00.000Z');
  const exhaustedDoneAt = exhaustedStartAt + 2_000;
  await handlers.get('agent_start')?.({ timestamp: exhaustedStartAt }, fakeCtx);
  await handlers.get('turn_start')?.({ timestamp: exhaustedStartAt }, fakeCtx);
  await handlers.get('message_start')?.({
    timestamp: exhaustedStartAt,
    message: {
      role: 'user', content: [{ type: 'text', text: 'exhausted retry bridge prompt' }],
      timestamp: exhaustedStartAt,
    },
  }, fakeCtx);
  await handlers.get('message_end')?.({
    timestamp: exhaustedStartAt + 1_000,
    message: {
      role: 'assistant', stopReason: 'error', error: { message: 'first bridge failure' },
      content: [], usage: { input: 1, output: 0 },
    },
  }, fakeCtx);
  await handlers.get('auto_retry_start')?.({
    timestamp: exhaustedStartAt + 1_010,
    attempt: 1,
    maxAttempts: 1,
    errorMessage: 'first bridge failure',
  }, fakeCtx);
  await handlers.get('agent_end')?.({ timestamp: exhaustedStartAt + 1_015, willContinue: true }, fakeCtx);
  await handlers.get('agent_start')?.({ timestamp: exhaustedStartAt + 1_016 }, fakeCtx);
  await handlers.get('message_end')?.({
    timestamp: exhaustedDoneAt,
    message: {
      role: 'assistant', stopReason: 'error', error: { message: 'final bridge failure' },
      content: [], usage: { input: 2, output: 0 },
    },
  }, fakeCtx);
  await handlers.get('auto_retry_end')?.({ success: false }, fakeCtx);
  await handlers.get('agent_end')?.({ timestamp: exhaustedDoneAt, isTerminal: true }, fakeCtx);
  const exhaustedLiveSeen = await waitFor(
    () => eventBodies.slice(exhaustedEventStart).some((m) => m.t === 'run-summary' && m.status === 'error'),
    5_000,
  );
  const exhaustedLiveSummaries = eventBodies.slice(exhaustedEventStart).filter((m) => m.t === 'run-summary');
  const exhaustedLiveFinal = exhaustedLiveSummaries.at(-1);
  check(
    'bridge exhausted retry keeps one key and the final assistant completion clock',
    exhaustedLiveSeen
      && new Set(exhaustedLiveSummaries.map((m) => m.key)).size === 1
      && exhaustedLiveSummaries.filter((m) => m.status === 'error').length === 1
      && exhaustedLiveFinal?.status === 'error'
      && exhaustedLiveFinal?.completedAt === exhaustedDoneAt
      && exhaustedLiveFinal?.totalRuntimeMs === 2_000
      && exhaustedLiveFinal?.tokens?.input === 3,
    JSON.stringify(exhaustedLiveSummaries),
  );

  const exhaustedOrdinal = Number(/^u(\d+)$/u.exec(String(exhaustedLiveFinal?.turnId))?.[1]);
  const exhaustedPrefix = ordinalPrefixTurns(exhaustedOrdinal, exhaustedStartAt);
  const exhaustedEntries = [...exhaustedPrefix, ...[
    {
      type: 'message', id: 'exhausted-user', parentId: exhaustedPrefix.at(-1)?.id ?? null,
      timestamp: new Date(exhaustedStartAt).toISOString(),
      message: {
        role: 'user', content: [{ type: 'text', text: 'exhausted retry bridge prompt' }],
        timestamp: exhaustedStartAt,
      },
    },
    {
      type: 'message', id: 'exhausted-superseded', parentId: 'exhausted-user',
      timestamp: new Date(exhaustedStartAt + 1_000).toISOString(),
      message: {
        role: 'assistant', stopReason: 'error', error: { message: 'first bridge failure' }, content: [],
        usage: { input: 1, output: 0 },
        retryRecovery: { kind: 'auto-retry', status: 'superseded', attempt: 1 },
      },
    },
    {
      type: 'message', id: 'exhausted-final', parentId: 'exhausted-superseded',
      timestamp: new Date(exhaustedDoneAt).toISOString(),
      message: {
        role: 'assistant', stopReason: 'error', error: { message: 'final bridge failure' }, content: [],
        usage: { input: 2, output: 0 },
      },
    },
  ]];
  fakeCtx.sessionManager.getBranch = () => exhaustedEntries;
  fakeCtx.sessionManager.getEntries = () => exhaustedEntries;
  knownIds.clear();
  const exhaustedHelloCount = helloBodies.length;
  const exhaustedRehello = await waitFor(() => helloBodies.length > exhaustedHelloCount, 15_000);
  const exhaustedReloadSummaries = (helloBodies[helloBodies.length - 1]?.history ?? [])
    .filter((m: any) => m.t === 'run-summary');
  const exhaustedReloadFinal = exhaustedReloadSummaries.find((m: any) => m.startedAt === exhaustedStartAt);
  check(
    'bridge re-hello reproduces exhausted retry identity, timing, and usage exactly',
    exhaustedRehello
      && exhaustedReloadFinal !== undefined
      && JSON.stringify(summaryProjection(exhaustedReloadFinal))
        === JSON.stringify(summaryProjection(exhaustedLiveFinal)),
    JSON.stringify({ live: summaryProjection(exhaustedLiveFinal), reload: summaryProjection(exhaustedReloadFinal) }),
  );

  // 4) session_shutdown stops the loop for good — another forget must NOT re-hello
  await handlers.get('session_shutdown')?.({ reason: 'quit' }, fakeCtx);
  knownIds.clear();
  const hellosAtShutdown = helloBodies.length;
  await sleep(7000); // > hello retry interval — long enough for a leak to show
  check('after session_shutdown the bridge never re-hellos again', helloBodies.length === hellosAtShutdown, `hellos=${helloBodies.length} (was ${hellosAtShutdown})`);
} finally {
  server.stop(true);
  rmSync(skillDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nFAIL: ${failed.length}/${results.length}` : `\n${results.length} passed, 0 failed`);
process.exit(failed.length ? 1 : 0);
