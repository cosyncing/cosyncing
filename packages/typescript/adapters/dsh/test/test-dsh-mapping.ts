/**
 * The mapping boundary: the plugin-foundation contract.
 *
 * Three properties are asserted here because they are what makes this adapter
 * survive an ecosystem of thousands of plugins it will never enumerate:
 *
 *  1. The fold is TOTAL. A real 21-event turn maps exactly; an event type this
 *     build has never seen becomes an honest activity record instead of a throw
 *     or a silent drop; `ignorable` is the one licence to omit.
 *  2. Tool cards come from the host-computed `view` and NOTHING else — no tool
 *     name is ever branched on — and an absent or unknown card falls back to the
 *     product's documented generic JSON card.
 *  3. The projection store is generic: higher-seq-wins, seeded from the history
 *     tail's consistent cut, unknown keys kept and readable but never forwarded
 *     as raw dsh-shaped values.
 *
 * Every input is a SANITIZED CAPTURE from a real dsh 0.1.0-rc.6 host, or a
 * hand-built event whose shape comes from the upstream contract.
 *
 *   bun run packages/typescript/adapters/dsh/test/test-dsh-mapping.ts   (exit 0 = all pass)
 */
export {};
import {
  createDshMapState,
  dshMessageKey,
  dshProjectionMessages,
  DshProjectionStore,
  foldDshSurface,
  mapDshApproval,
  mapDshEvent,
  mapDshHistory,
  mapDshQuestion,
  mapDshSession,
  mapToolCallView,
  mapToolResultView,
  parseDshUsageSample,
  type DshHistoryEntry,
} from '../src/mapping.ts';

const FIXTURE = await Bun.file(new URL('./fixtures/dsh-0.1.0-rc.6.json', import.meta.url)).json() as {
  sessionList: { body: { result: { value: { items: Array<Record<string, unknown>> } } } };
  historyTail: { body: { result: { value: { events: DshHistoryEntry[]; projections: unknown } } } };
};

const HISTORY = FIXTURE.historyTail.body.result.value;
const SESSION_ID = 'session-7723d8e8-cf1c-4e0a-8748-3a600aa396fc';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function typesOf(messages: Array<{ type: string }>): string {
  return messages.map((message) => message.type).join(',');
}

// ── 1. A real turn folds exactly ────────────────────────────────────────────

{
  const state = createDshMapState(SESSION_ID, false);
  const rows = mapDshHistory(HISTORY.events, state) as Array<Record<string, unknown>>;
  check(
    'the captured 21-event turn folds to its canonical rows',
    typesOf(rows as Array<{ type: string }>)
      === 'metadata-update,run-summary,user-message,notice,notice,metadata-update,model-output,token-count,run-summary',
    typesOf(rows as Array<{ type: string }>),
  );

  const human = rows.find((row) => row.type === 'user-message') as { text?: string; key?: string; sentAt?: number };
  check(
    'the human prompt is the only user bubble, keyed by its native message id',
    human?.text === 'Reply with exactly: OK'
      && human.key === dshMessageKey(SESSION_ID, '2adee810-fbb9-4924-a0d7-3a79318cef62')
      && typeof human.sentAt === 'number',
    JSON.stringify(human),
  );

  const notices = rows.filter((row) => row.type === 'notice') as Array<{ message: string }>;
  check(
    'injected context renders as bounded notices naming their origin, never as human bubbles',
    notices.length === 2
      && notices[0]!.message.startsWith('Context added by @deepseek-ai/dsh-system-prompt')
      && notices[1]!.message.startsWith('Context added by skill-catalog')
      && notices.every((notice) => notice.message.length <= 240),
    notices.map((notice) => `${notice.message.slice(0, 40)}…`).join(' | '),
  );

  const output = rows.find((row) => row.type === 'model-output') as { text?: string; final?: boolean; key?: string };
  check(
    'the assembled assistant message is the final model output',
    output?.text === 'OK' && output.final === true && output.key === `dsh:${SESSION_ID}:turn1:step1`,
    JSON.stringify(output),
  );

  const usage = rows.find((row) => row.type === 'token-count') as { input?: number; output?: number; cacheRead?: number };
  check(
    'per-step usage rides token-count (never the cumulative tokenUsage projection)',
    usage?.input === 7987 && usage.output === 2 && usage.cacheRead === 1792,
    JSON.stringify(usage),
  );

  const runs = rows.filter((row) => row.type === 'run-summary') as Array<{ status: string; turnId: string }>;
  check(
    'the turn opens and closes as one run-summary identity',
    runs.length === 2 && runs[0]!.status === 'running' && runs[1]!.status === 'done'
      && runs[0]!.turnId === runs[1]!.turnId,
    JSON.stringify(runs),
  );

  const closed = runs[1]! as Record<string, unknown>;
  check(
    'the closed turn carries native turn elapsed time plus the model/tool work split',
    closed.totalRuntimeMs === 2572 && closed.agentRuntimeMs === 2458 && closed.executionRuntimeMs === 0,
    JSON.stringify(closed),
  );

  const turnTokens = closed.tokens as Record<string, number> | undefined;
  check(
    'the closed turn carries the folded per-turn usage',
    turnTokens?.input === 7987 && turnTokens?.output === 2
      && turnTokens?.cacheRead === 1792 && turnTokens?.cacheWrite === 0,
    JSON.stringify(turnTokens),
  );

  check(
    'the bounded fold publishes NO session-wide totals of its own',
    !rows.some((row) => row.type === 'metadata-update' && (row as { key?: string }).key === 'runtimeTotals'),
    typesOf(rows as Array<{ type: string }>),
  );

  check(
    'history replays the assembled message, not the token chunks it was built from',
    !rows.some((row) => row.type === 'thinking')
      && rows.filter((row) => row.type === 'model-output').length === 1,
  );

  check(
    'a fully recognized turn produces no opaque activity records',
    !rows.some((row) => row.type === 'event'),
    typesOf(rows as Array<{ type: string }>),
  );
}

// ── 2. Verbatim passthrough with no allowlist ───────────────────────────────

{
  const state = createDshMapState(SESSION_ID, true);
  const unknown = mapDshEvent(
    { event: { type: 'community-plugin/did-a-thing', seq: 99, time: 1, data: { secret: 'payload' } } },
    state,
  ) as Array<{ type: string; name?: string; payload?: Record<string, unknown> }>;
  check(
    'an event type this build has never seen becomes an honest activity record',
    unknown.length === 1 && unknown[0]!.type === 'event' && unknown[0]!.name === 'dsh.session-event'
      && unknown[0]!.payload?.eventType === 'community-plugin/did-a-thing'
      && unknown[0]!.payload?.seq === 99,
    JSON.stringify(unknown),
  );
  check(
    'the activity record carries no dsh-shaped payload out of the package',
    !JSON.stringify(unknown).includes('secret'),
  );

  const ignorable = mapDshEvent(
    { event: { type: 'community-plugin/noise', seq: 100, time: 1, ignorable: true } },
    state,
  );
  check('an ignorable event is omitted entirely', ignorable.length === 0);

  const structurallyBroken = [
    { type: 'tool/call', seq: 101, time: 1, data: {} },
    { type: 'tool/result', seq: 102, time: 1, data: {} },
    { type: 'user/message', seq: 103, time: 1, data: { content: [] } },
    { type: 'assistant/message', seq: 104, time: 1, data: {} },
  ];
  let threw = false;
  for (const event of structurallyBroken) {
    try {
      mapDshEvent({ event }, state);
    } catch {
      threw = true;
    }
  }
  check('a structurally broken event degrades instead of throwing', !threw);
}

// ── 3. Surface folding ──────────────────────────────────────────────────────

{
  const entries: DshHistoryEntry[] = [
    { event: { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'one' }], source: { kind: 'user' }, id: 'm1' }, surfaceOp: 'append' } },
    { event: { type: 'turn/start', seq: 2, time: 1, data: { turn: 1 } } },
    { event: { type: 'user/message', seq: 3, time: 1, data: { content: [{ type: 'text', text: 'two' }], source: { kind: 'user' }, id: 'm2' }, surfaceOp: 'append' } },
    { event: { type: 'user/message', seq: 4, time: 1, data: { content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' }, id: 'm3' }, surfaceOp: { op: 'replace', start: 1, end: 3 }, sourceEventSeqs: [1, 3] } },
  ];
  const folded = foldDshSurface(entries).map((entry) => entry.event.seq);
  check(
    'a compaction replace shadows its range and takes the range position',
    JSON.stringify(folded) === JSON.stringify([4, 2]),
    JSON.stringify(folded),
  );
  const state = createDshMapState(SESSION_ID, false);
  const texts = (mapDshHistory(entries, state) as Array<{ type: string; text?: string }>)
    .filter((row) => row.type === 'user-message')
    .map((row) => row.text);
  check(
    'shadowed surface nodes never reach the transcript',
    JSON.stringify(texts) === JSON.stringify(['summary']),
    JSON.stringify(texts),
  );
}

// ── 4. Tool views: one vocabulary, generic fallback always ──────────────────

{
  const state = createDshMapState(SESSION_ID, true);
  const call = mapDshEvent({
    event: {
      type: 'tool/call',
      seq: 200,
      time: 1,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls -la"}' },
    },
    view: { for: 'call', view: { card: 'terminal', title: 'ls -la', cwd: '/w' } },
  }, state) as Array<Record<string, unknown>>;
  check(
    'a terminal call view becomes an execute-class command semantic',
    call[0]!.type === 'tool-call' && call[0]!.toolClass === 'execute'
      && (call[0]!.semantic as { kind: string; command: string; cwd?: string }).kind === 'command'
      && (call[0]!.semantic as { cwd?: string }).cwd === '/w'
      && JSON.stringify(call[0]!.args) === '{"command":"ls -la"}',
    JSON.stringify(call[0]),
  );

  const result = mapDshEvent({
    event: {
      type: 'tool/result',
      seq: 201,
      time: 1,
      data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'total 0' }] }] } },
    },
    view: { for: 'result', view: { card: 'terminal', output: 'total 0', exitCode: 0 } },
  }, state) as Array<Record<string, unknown>>;
  check(
    'a terminal result view carries exit state and pairs with its call name',
    result[0]!.type === 'tool-result' && result[0]!.toolName === 'bash' && result[0]!.exitCode === 0
      && (result[0]!.semantic as { state: string }).state === 'completed',
    JSON.stringify(result[0]),
  );

  const failed = mapToolResultView({ for: 'result', view: { card: 'terminal', output: 'boom', exitCode: 2 } }, undefined);
  check('a non-zero exit is a failed command state', (failed.semantic as { state: string }).state === 'failed');

  const read = mapToolResultView({
    for: 'result',
    view: { card: 'read', path: '/w/a.ts', offset: 10, totalLines: 40, lines: [{ number: 10, text: 'const a = 1' }] },
  }, undefined);
  check(
    'a read result view becomes a lookup-class file-read semantic',
    read.toolClass === 'lookup' && read.path === '/w/a.ts'
      && (read.semantic as { startLine?: number; totalLines?: number; preview?: string }).startLine === 10
      && (read.semantic as { totalLines?: number }).totalLines === 40
      && (read.semantic as { preview?: string }).preview === 'const a = 1',
    JSON.stringify(read),
  );

  const grep = mapToolResultView({
    for: 'result',
    view: { card: 'search', shape: 'matches', truncated: true, total: 9, files: [{ path: 'a.ts', matches: [{ lineNumber: 3, line: 'hit' }] }] },
  }, undefined);
  check(
    'a grouped search result view becomes a search semantic with its truncation flag',
    (grep.semantic as { kind: string; matchCount?: number; truncated?: boolean }).kind === 'search'
      && (grep.semantic as { matchCount?: number }).matchCount === 9
      && (grep.semantic as { truncated?: boolean }).truncated === true,
    JSON.stringify(grep),
  );

  const glob = mapToolResultView({
    for: 'result',
    view: { card: 'search', shape: 'paths', truncated: false, total: 2, paths: ['a.ts', 'b.ts'] },
  }, undefined);
  check(
    'a path search result view keeps its paths as search groups',
    (glob.semantic as { fileCount?: number }).fileCount === 2,
    JSON.stringify(glob.semantic),
  );

  const web = mapToolResultView({
    for: 'result',
    view: { card: 'web', kind: 'search', truncated: false, sources: [{ url: 'https://example.test', title: 'T' }] },
  }, undefined);
  check(
    'a web result view becomes a web semantic',
    (web.semantic as { kind: string; results?: unknown[] }).kind === 'web'
      && ((web.semantic as { results?: unknown[] }).results ?? []).length === 1,
    JSON.stringify(web.semantic),
  );

  const diff = mapToolResultView({
    for: 'result',
    view: { card: 'diff', diffs: [{ path: 'a.txt', oldText: null, newText: 'hello' }] },
  }, undefined);
  check(
    'a diff result view becomes an edit-class unified diff for a created file',
    diff.toolClass === 'edit' && diff.path === 'a.txt'
      && (diff.diff ?? '').includes('--- /dev/null') && (diff.diff ?? '').includes('+hello'),
    JSON.stringify(diff.diff),
  );

  // The whole point: NO view, and a card from a plugin this build never heard
  // of, both land on the documented generic JSON card.
  const absent = mapToolResultView(undefined, { anything: [1, 2, 3] });
  const alien = mapToolResultView({ for: 'result', view: { card: 'holographic-widget', title: 'Held' } }, { raw: true });
  check(
    'an absent view falls back to the generic JSON card',
    typeof absent.result === 'string' && absent.result.includes('anything'),
    String(absent.result),
  );
  check(
    'an unknown card keeps its title and still renders through the generic card',
    alien.title === 'Held' && typeof alien.result === 'string' && alien.result.includes('raw'),
    JSON.stringify(alien),
  );
  check(
    'an unknown CALL card degrades to a titled generic card',
    mapToolCallView({ for: 'call', view: { card: 'holographic-widget', title: 'Doing' } }).title === 'Doing'
      && mapToolCallView(undefined).toolClass === 'other',
  );

  const source = await Bun.file(new URL('../src/mapping.ts', import.meta.url)).text();
  check(
    'the mapping branches on no native tool name',
    !/\b(bash|grep|glob|web_search|web_fetch|todowrite|TodoWrite)\b\s*(===|==|:)/.test(source),
  );
}

// ── 5. Live streaming ───────────────────────────────────────────────────────

{
  const live = createDshMapState(SESSION_ID, true);
  const delta = mapDshEvent({
    event: { type: 'assistant/chunk', seq: 300, time: 1, data: { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'He' } } },
  }, live) as Array<{ type: string; delta?: string; key?: string }>;
  const reasoning = mapDshEvent({
    event: { type: 'assistant/chunk', seq: 301, time: 1, data: { turn: 2, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'hmm' } } },
  }, live) as Array<{ type: string; delta?: string }>;
  const assembled = mapDshEvent({
    event: { type: 'assistant/message', seq: 302, time: 1, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } }, surfaceOp: 'append' },
  }, live) as Array<{ type: string; key?: string }>;
  check(
    'live chunks stream deltas under the key their assembled message replaces',
    delta[0]!.type === 'model-output' && delta[0]!.delta === 'He'
      && reasoning[0]!.type === 'thinking'
      && assembled[0]!.key === delta[0]!.key,
    `${delta[0]!.key} vs ${assembled[0]!.key}`,
  );

  const empty = mapDshEvent({
    event: { type: 'assistant/message', seq: 303, time: 1, data: { turn: 2, step: 2, message: { role: 'assistant', content: [] }, usage: { inputTokens: 5, outputTokens: 0 } }, surfaceOp: 'append' },
  }, live) as Array<{ type: string }>;
  check(
    'an empty assembled message is a truncation artifact: usage only, no transcript row',
    empty.length === 1 && empty[0]!.type === 'token-count',
    typesOf(empty),
  );

  const aborted = mapDshEvent({
    event: { type: 'turn/end', seq: 304, time: 1, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
  }, live) as Array<{ type: string; status?: string; semantic?: { kind: string; reason?: string } }>;
  check(
    'a user-cancelled turn closes as cancelled with a user interruption notice',
    aborted.length === 2 && aborted[0]!.status === 'cancelled'
      && aborted[1]!.semantic?.kind === 'interruption' && aborted[1]!.semantic?.reason === 'user',
    JSON.stringify(aborted),
  );

  const hookAborted = mapDshEvent({
    event: { type: 'turn/end', seq: 305, time: 1, data: { turn: 3, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'budget' } } } },
  }, live) as Array<{ semantic?: { reason?: string } }>;
  check(
    'a non-user abort cause (hook/parent/disposed) does not claim the user reason',
    hookAborted[1]!.semantic?.reason === 'generic',
    JSON.stringify(hookAborted),
  );
}

// ── 6. Generic projection store ─────────────────────────────────────────────

{
  const store = new DshProjectionStore();
  const seeded = store.seed(HISTORY.projections);
  check(
    'the history tail projections block seeds every key as one consistent cut',
    seeded.includes('title') && seeded.includes('tokenUsage') && seeded.includes('permissions')
      && store.seqOf('title') === 20,
    `${store.size} keys`,
  );

  store.apply('title', 'newer', 21);
  store.apply('title', 'older', 5);
  check('higher-seq-wins, and a late lower-seq value is refused', store.get('title') === 'newer');

  // Equal-seq is a REPLAY, not new information: upstream rejects seq <= held,
  // so a history seed at seq 20 cannot overwrite a live value held at seq 20.
  const replayed = new DshProjectionStore();
  check(
    'an equal-sequence value is rejected, so a seed cannot overwrite a live value at the same seq',
    replayed.apply('title', 'live', 20) === true
      && replayed.apply('title', 'seeded', 20) === false
      && replayed.get('title') === 'live',
  );

  // A seed is a STALE-OK baseline: a held row the cut omits and does not
  // postdate was removed upstream and is cleared, but a row NEWER than the
  // cut is live state the cut merely predates (the host advanced while the
  // history RPC was in flight) and is always preserved. Only
  // session/subscribed's lastSeq proves a restarted host, so
  // previous-generation cleanup is truncate(), not seed().
  const reconciled = new DshProjectionStore();
  reconciled.apply('sessionStats', { turns: 1, llmMs: 1, toolMs: 1 }, 18);
  reconciled.apply('removed-plugin/state', { gone: true }, 20);
  reconciled.apply('title', 'kept', 20);
  reconciled.apply('live-plugin/state', { fresh: true }, 30);
  reconciled.seed({ asOfSeq: 20, values: { title: 'kept' } });
  check(
    'seeding clears omitted rows at or below the cut but preserves every row newer than it',
    reconciled.get('removed-plugin/state') === undefined
      && reconciled.get('sessionStats') === undefined
      && JSON.stringify(reconciled.get('live-plugin/state')) === JSON.stringify({ fresh: true })
      && reconciled.get('title') === 'kept'
      && reconciled.keys().length === 2,
    reconciled.keys().join(','),
  );
  reconciled.truncate(20);
  check(
    "truncate(lastSeq) discards rows beyond a restarted host's tail and keeps the rest",
    reconciled.get('live-plugin/state') === undefined
      && reconciled.get('title') === 'kept'
      && reconciled.keys().length === 1,
    reconciled.keys().join(','),
  );

  // `in` consults the prototype chain: a held projection literally named
  // "constructor" would masquerade as supplied by every baseline. The
  // reconciliation must test own properties only.
  const prototypeNamed = new DshProjectionStore();
  prototypeNamed.apply('constructor', { x: 1 }, 10);
  prototypeNamed.seed({ asOfSeq: 20, values: {} });
  check(
    'an omitted projection named constructor clears against an empty baseline',
    prototypeNamed.get('constructor') === undefined && prototypeNamed.size === 0,
    prototypeNamed.keys().join(','),
  );

  store.apply('community-plugin/widget-state', { anything: true }, 30);
  check(
    'an unknown projection key is kept and readable',
    store.keys().includes('community-plugin/widget-state'),
  );
  check(
    'an unknown projection key emits nothing on the wire',
    dshProjectionMessages('community-plugin/widget-state', { anything: true }).length === 0,
  );
  check(
    'the cumulative tokenUsage projection is deliberately not forwarded as token-count',
    dshProjectionMessages('tokenUsage', store.get('tokenUsage')).length === 0,
  );

  const statsTotals = dshProjectionMessages('sessionStats', store.get('sessionStats')) as Array<Record<string, unknown>>;
  check(
    'the authoritative sessionStats projection carries whole-session runtimeTotals (no window wall clock)',
    statsTotals.length === 1 && statsTotals[0]!.key === 'runtimeTotals'
      && JSON.stringify(statsTotals[0]!.value)
        === JSON.stringify({ agentRuntimeMs: 2458, executionRuntimeMs: 0, turnCount: 1, source: 'dsh' }),
    JSON.stringify(statsTotals),
  );
  check(
    'a malformed sessionStats value publishes nothing',
    dshProjectionMessages('sessionStats', { turns: 1 }).length === 0
      && dshProjectionMessages('sessionStats', { turns: -1, llmMs: 0, toolMs: 0 }).length === 0
      && dshProjectionMessages('sessionStats', { turns: 1.5, llmMs: 0, toolMs: 0 }).length === 0
      && dshProjectionMessages('sessionStats', { turns: 1, llmMs: Number.NaN, toolMs: 0 }).length === 0,
  );
  // A fork child's sessionStats folds the whole PHYSICAL log upstream, so it
  // includes the inherited parent prefix the parent already publishes — no
  // runtimeTotals until a seed-aware totals source exists.
  check(
    'sessionStats totals are suppressed for a fork child (parentThreadId)',
    dshProjectionMessages('sessionStats', { turns: 2, llmMs: 100, toolMs: 5 }, { forkedChild: true }).length === 0
      && dshProjectionMessages('title', 'A session', { forkedChild: true }).length === 1,
  );

  const title = dshProjectionMessages('title', 'A session') as Array<Record<string, unknown>>;
  const pressure = dshProjectionMessages('contextPressure', { pressureTokens: 9779, contextWindow: 1_000_000 }) as Array<Record<string, unknown>>;
  check(
    'named consumers map title and context pressure to canonical metadata',
    title[0]!.key === 'sessionInfo'
      && pressure[0]!.key === 'contextUsage'
      && JSON.stringify(pressure[0]!.value) === JSON.stringify({ used: 9779, max: 1_000_000 }),
    JSON.stringify([title[0], pressure[0]]),
  );

  const todos = dshProjectionMessages('todos', [
    { content: 'first', status: 'completed' },
    { content: 'second', status: 'in_progress' },
  ]) as Array<{ type: string; items: Array<{ status: string }> }>;
  check(
    'the todo projection becomes one task-list-state panel',
    todos[0]!.type === 'task-list-state' && todos[0]!.items.length === 2
      && todos[0]!.items[0]!.status === 'done' && todos[0]!.items[1]!.status === 'in-progress',
    JSON.stringify(todos[0]),
  );

  const goal = dshProjectionMessages('goal', {
    goal: { id: 'g1', revision: 1, objective: 'Ship it', phase: 'active', maxGoalRounds: 5 },
    roundsStarted: 1,
    createdAt: 10,
    updatedAt: 11,
  }) as Array<{ type: string; title?: string; status: string }>;
  check(
    'the goal projection becomes a goal-state row, and null clears it',
    goal[0]!.type === 'goal-state' && goal[0]!.title === 'Ship it' && goal[0]!.status === 'active'
      && (dshProjectionMessages('goal', null) as Array<{ status: string }>)[0]!.status === 'cleared',
    JSON.stringify(goal[0]),
  );
}

// ── 7. Sessions, questions, approvals ───────────────────────────────────────

{
  const summary = FIXTURE.sessionList.body.result.value.items[0]!;
  const session = mapDshSession(summary)!;
  check(
    'a captured session row maps with its projected title and drive-owner control state',
    session.id === SESSION_ID
      && session.title === 'cosyncing spike (safe to delete)'
      && session.attachMode === 'live'
      && session.status === 'idle'
      && session.control?.drive.supported === true
      && session.control?.drive.state === 'driving',
    JSON.stringify(session.control),
  );
  // dsh has NO terminal UI, so terminal sync is structurally impossible — not
  // merely inactive. Claiming an active shared channel would misrank the owner
  // projection as terminal-sync and surface a "Synced" affordance for a
  // terminal that cannot exist; mutation authority already flows from drive.
  check(
    'terminal sync is reported structurally impossible, never active',
    session.control?.terminalSync.supported === false
      && session.control?.terminalSync.syncAvailable === false
      && session.control?.terminalSync.active === false
      && typeof session.control?.terminalSync.reason === 'string',
    JSON.stringify(session.control?.terminalSync),
  );
  // Declared on the row, not left for the client to infer from `attachModes`.
  // dsh advertises `live` as its only attach mode and refuses observe, so there
  // is no read-only session for terminal handoff to leave attached — the broker
  // refuses the call, and a client that offered the control anyway would be
  // offering a guaranteed failure. Asserted on BOTH postures because a host
  // going unreachable must not accidentally re-enable it.
  check(
    'every dsh row states that terminal handoff is unavailable',
    session.control?.drive.handoffAvailable === false
      && mapDshSession(summary, { driveSupported: false })!.control?.drive.handoffAvailable === false,
    JSON.stringify(session.control?.drive),
  );
  check('a row with no sessionId is refused', mapDshSession({}) === undefined);
  check(
    'a running session reports working, and an unreachable host drops DRIVE, never to a mislabeled observe',
    mapDshSession({ ...summary, running: true })!.status === 'working'
      && mapDshSession(summary, { driveSupported: false })!.attachMode === 'live'
      && mapDshSession(summary, { driveSupported: false })!.control?.drive.supported === false,
  );

  const question = mapDshQuestion('rpc-q1', {
    sessionId: SESSION_ID,
    questions: [{
      id: 'q1',
      question: 'Which approach?',
      header: 'Plan',
      options: [{ label: 'A', description: 'first' }, { label: 'B' }],
      multiSelect: true,
      intent: { kind: 'plan-review', approve: 'A' },
    }],
  })!;
  const card = question.message as { type: string; requestId: string; questions: Array<{ options: unknown[]; multiple?: boolean }> };
  check(
    'a question card is identified by the frame rpcId and keeps its native ids for the answer',
    card.type === 'question-request' && card.requestId === 'rpc-q1'
      && JSON.stringify(question.ids) === JSON.stringify(['q1'])
      && card.questions[0]!.options.length === 2 && card.questions[0]!.multiple === true,
    JSON.stringify(question),
  );
  check(
    'the native multiSelect flag survives for the answer path, per question',
    JSON.stringify(question.multiSelect) === JSON.stringify([true])
      && JSON.stringify(
        mapDshQuestion('rpc-q1b', { sessionId: SESSION_ID, questions: [{ id: 'q', question: 'One?' }] })!.multiSelect,
      ) === JSON.stringify([false]),
  );
  check(
    'a presentation intent stays a hint and never gates answerability',
    !JSON.stringify(card).includes('plan-review'),
  );
  check(
    'an empty question batch is refused rather than shown as a blank card',
    mapDshQuestion('rpc-q2', { sessionId: SESSION_ID, questions: [] }) === undefined,
  );

  // A plan-review question REQUIRES `detail` — it carries the plan under
  // review — and the canonical per-question shape has no separate body field.
  const planReview = mapDshQuestion('rpc-q3', {
    sessionId: SESSION_ID,
    questions: [{
      id: 'q1',
      question: 'Approve this plan?',
      detail: '## Plan\n1. read\n2. write',
      options: [{ label: 'Approve' }, { label: 'Decline' }],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }],
  })!;
  const planCard = planReview.message as { questions: Array<{ question: string }> };
  check(
    'a plan-review question carries its plan: detail joins the question text',
    planCard.questions[0]!.question.includes('Approve this plan?')
      && planCard.questions[0]!.question.includes('## Plan\n1. read\n2. write'),
    JSON.stringify(planCard.questions[0]),
  );

  // The host validates answers index-aligned against its own registry (one
  // answer per question, ids matching per position), so a malformed item must
  // degrade in place rather than be skipped — skipping it would desync every
  // later answer and make the whole request unanswerable.
  const ragged = mapDshQuestion('rpc-q4', {
    sessionId: SESSION_ID,
    questions: [
      { id: 'q1', options: [{ label: 'A' }] },
      { id: 'q2', question: 'Second?', options: [{ label: 'B' }] },
    ],
  })!;
  const raggedCard = ragged.message as { questions: Array<{ question: string }> };
  check(
    'a question item with no text degrades to a placeholder in place, keeping answer alignment',
    JSON.stringify(ragged.ids) === JSON.stringify(['q1', 'q2'])
      && ragged.optionLabels.length === 2
      && raggedCard.questions.length === 2
      && raggedCard.questions[0]!.question === '(question text missing)'
      && raggedCard.questions[1]!.question === 'Second?',
    JSON.stringify({ ids: ragged.ids, questions: raggedCard.questions }),
  );

  const approval = mapDshApproval('rpc-a1', {
    sessionId: SESSION_ID,
    approvalId: 'ap-1',
    toolName: 'bash',
    reason: 'writes outside the workspace',
  })!;
  const permission = approval.message as { type: string; requestId: string; options: string[]; detail?: string };
  check(
    'an approval card is identified by the frame rpcId and offers only the two real outcomes',
    permission.type === 'permission-request' && permission.requestId === 'rpc-a1'
      && JSON.stringify(permission.options) === JSON.stringify(['approve', 'reject'])
      && permission.detail === 'writes outside the workspace',
    JSON.stringify(permission),
  );
  check(
    'an approval with no approvalId is refused',
    mapDshApproval('rpc-a2', { sessionId: SESSION_ID }) === undefined,
  );
}

// ── 8. Turn timing and usage fold ───────────────────────────────────────────

{
  // One two-step turn with a matched tool pair: model time sums
  // step/start → assistant/message per step, tool time sums the matched
  // tool/call → tool/result pair, and active time is the turn's wall clock.
  const state = createDshMapState(SESSION_ID, false);
  const feed = (seq: number, time: number, type: string, data: Record<string, unknown>) =>
    mapDshEvent({ event: { type, seq, time, data } }, state) as Array<Record<string, unknown>>;
  feed(1, 1000, 'turn/start', { turn: 1 });
  feed(2, 1100, 'step/start', { turn: 1, step: 1 });
  feed(3, 1600, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] }, usage: { inputTokens: 100, outputTokens: 10 } });
  feed(4, 1700, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' });
  feed(5, 1900, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [{ toolCallId: 'c1', content: 'ok' }] } });
  feed(6, 1950, 'step/end', { turn: 1, step: 1 });
  feed(7, 2000, 'step/start', { turn: 1, step: 2 });
  feed(8, 2400, 'assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] }, usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 25 } });
  feed(9, 2450, 'step/end', { turn: 1, step: 2 });
  const closedRows = feed(10, 2500, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  const closed = closedRows[0]!;
  check(
    'a closed turn carries native elapsed time, the model/tool split, and folded usage',
    closed.type === 'run-summary' && closed.status === 'done'
      && closed.totalRuntimeMs === 1500 && closed.agentRuntimeMs === 900 && closed.executionRuntimeMs === 200
      && JSON.stringify(closed.tokens) === JSON.stringify({ input: 150, output: 15, cacheRead: 25, cacheWrite: 0 }),
    JSON.stringify(closed),
  );
  check(
    'the fold emits no session-wide totals — those come from the sessionStats projection',
    closedRows.length === 1,
    JSON.stringify(closedRows),
  );

  // A turn/end with no in-window turn/start cannot be timed: the row closes
  // with NO timing or usage fields, and totals do not move — no fake zeroes.
  const orphan = createDshMapState(SESSION_ID, false);
  const orphanRows = mapDshEvent({
    event: { type: 'turn/end', seq: 20, time: 9000, data: { turn: 7, reason: { kind: 'completed' } } },
  }, orphan) as Array<Record<string, unknown>>;
  check(
    'a turn whose start fell outside the fold window closes untimed and moves no totals',
    orphanRows.length === 1 && orphanRows[0]!.type === 'run-summary'
      && orphanRows[0]!.totalRuntimeMs === undefined && orphanRows[0]!.agentRuntimeMs === undefined
      && orphanRows[0]!.tokens === undefined,
    JSON.stringify(orphanRows),
  );

  // A fresh turn fences its unterminated predecessor as cancelled WITHOUT
  // inventing a completion time or a totals contribution.
  const fenced = createDshMapState(SESSION_ID, false);
  const fenceFeed = (seq: number, time: number, type: string, data: Record<string, unknown>) =>
    mapDshEvent({ event: { type, seq, time, data } }, fenced) as Array<Record<string, unknown>>;
  fenceFeed(1, 1000, 'turn/start', { turn: 1 });
  const fenceRows = fenceFeed(2, 2000, 'turn/start', { turn: 2 });
  const fenceEnd = fenceFeed(3, 2600, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
  check(
    'a new turn fences the open one as cancelled with no invented timing',
    fenceRows.length === 2 && fenceRows[0]!.status === 'cancelled' && fenceRows[0]!.completedAt === undefined
      && fenceRows[0]!.totalRuntimeMs === undefined && fenceRows[1]!.status === 'running',
    JSON.stringify(fenceRows),
  );
  check(
    'the properly closed successor still carries its native timing',
    fenceEnd.length === 1 && fenceEnd[0]!.status === 'done'
      && fenceEnd[0]!.totalRuntimeMs === 600 && fenceEnd[0]!.agentRuntimeMs === 0
      && fenceEnd[0]!.executionRuntimeMs === 0,
    JSON.stringify(fenceEnd),
  );

  // Re-folding the same history must not corrupt state: a fresh fold state per
  // read (observe.ts enforces this) sees the same events produce the same rows.
  const refoldA = mapDshHistory(HISTORY.events, createDshMapState(SESSION_ID, false)) as Array<Record<string, unknown>>;
  const refoldB = mapDshHistory(HISTORY.events, createDshMapState(SESSION_ID, false)) as Array<Record<string, unknown>>;
  check(
    'two independent folds of the same window produce identical rows',
    JSON.stringify(refoldA) === JSON.stringify(refoldB),
  );

  // A cancelled step assembles no message (untimed, per upstream) and a tool
  // call left unresolved at turn/end is dropped; both are measured zeroes on
  // a fully-observed turn, not absent fields.
  const cancelled = createDshMapState(SESSION_ID, false);
  const cancelFeed = (seq: number, time: number, type: string, data: Record<string, unknown>) =>
    mapDshEvent({ event: { type, seq, time, data } }, cancelled) as Array<Record<string, unknown>>;
  cancelFeed(1, 1000, 'turn/start', { turn: 1 });
  cancelFeed(2, 1100, 'step/start', { turn: 1, step: 1 });
  cancelFeed(3, 1200, 'tool/call', { turn: 1, step: 1, callId: 'cx', name: 'bash', arguments: '{}' });
  cancelFeed(4, 1300, 'step/end', { turn: 1, step: 1 });
  const cancelEnd = cancelFeed(5, 1400, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
  const cancelSummary = cancelEnd[0]!;
  check(
    'a cancelled step and an unresolved tool call are measured zeroes, never fabricated time',
    cancelSummary.status === 'cancelled' && cancelSummary.totalRuntimeMs === 400
      && cancelSummary.agentRuntimeMs === 0 && cancelSummary.executionRuntimeMs === 0
      && cancelSummary.tokens === undefined,
    JSON.stringify(cancelSummary),
  );

  // An early usage chunk counts even when its request never assembles a final
  // message; when the final message DOES land, it replaces the chunk instead
  // of double-counting it (tokdash's replace-not-add fold).
  const chunkOnly = createDshMapState(SESSION_ID, true);
  const chunkFeed = (seq: number, time: number, type: string, data: Record<string, unknown>) =>
    mapDshEvent({ event: { type, seq, time, data } }, chunkOnly) as Array<Record<string, unknown>>;
  chunkFeed(1, 1000, 'turn/start', { turn: 1 });
  chunkFeed(2, 1100, 'step/start', { turn: 1, step: 1 });
  chunkFeed(3, 1500, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 700, outputTokens: 3 } } });
  const chunkEnd = chunkFeed(4, 1600, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } });
  check(
    'a chunk-only usage sample survives a failed request',
    JSON.stringify((chunkEnd[0] as { tokens?: unknown }).tokens)
      === JSON.stringify({ input: 700, output: 3, cacheRead: 0, cacheWrite: 0 }),
    JSON.stringify(chunkEnd[0]),
  );

  const replaced = createDshMapState(SESSION_ID, true);
  const replaceFeed = (seq: number, time: number, type: string, data: Record<string, unknown>) =>
    mapDshEvent({ event: { type, seq, time, data } }, replaced) as Array<Record<string, unknown>>;
  replaceFeed(1, 1000, 'turn/start', { turn: 1 });
  replaceFeed(2, 1100, 'step/start', { turn: 1, step: 1 });
  replaceFeed(3, 1500, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 700, outputTokens: 3 } } });
  replaceFeed(4, 1550, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 800, outputTokens: 4 } });
  const replaceEnd = replaceFeed(5, 1600, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  check(
    'the finalized message replaces its earlier usage chunk for the same step',
    JSON.stringify((replaceEnd[0] as { tokens?: unknown }).tokens)
      === JSON.stringify({ input: 800, output: 4, cacheRead: 0, cacheWrite: 0 })
      && (replaceEnd[0] as { agentRuntimeMs?: number }).agentRuntimeMs === 450,
    JSON.stringify(replaceEnd[0]),
  );
}

// ── 9. Usage and timestamp validation ───────────────────────────────────────

{
  // Tokdash parity: both input and output required, every bucket finite and
  // non-negative, cache buckets optionally absent, all-zero samples skipped.
  check(
    'a usage sample needs both input and output, non-negative finite buckets, and a non-zero total',
    parseDshUsageSample({ inputTokens: 5, outputTokens: 7 }) !== undefined
      && parseDshUsageSample({ inputTokens: 5 }) === undefined
      && parseDshUsageSample({ outputTokens: 7 }) === undefined
      && parseDshUsageSample({ inputTokens: 0, outputTokens: 7, cacheReadTokens: -3 }) === undefined
      && parseDshUsageSample({ inputTokens: -1, outputTokens: 7 }) === undefined
      && parseDshUsageSample({ inputTokens: Number.NaN, outputTokens: 7 }) === undefined
      && parseDshUsageSample({ inputTokens: Number.POSITIVE_INFINITY, outputTokens: 7 }) === undefined
      && parseDshUsageSample({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }) === undefined
      && parseDshUsageSample({ inputTokens: '5', outputTokens: 7 }) === undefined
      && parseDshUsageSample(null) === undefined,
  );
  check(
    'reasoning tokens are never folded — dsh already includes them in output',
    JSON.stringify(parseDshUsageSample({ inputTokens: 5, outputTokens: 7, reasoningTokens: 99, cacheWriteTokens: 2 }))
      === JSON.stringify({ input: 5, output: 7, cacheRead: 0, cacheWrite: 2 }),
  );

  // An invalid sample produces NO token-count row and no turn usage, instead of
  // a partial or negative reading.
  const badUsage = createDshMapState(SESSION_ID, false);
  const badRows = mapDshEvent({
    event: { type: 'assistant/message', seq: 40, time: 5, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, usage: { inputTokens: 0, outputTokens: 7, cacheReadTokens: -3 } } },
  }, badUsage) as Array<{ type: string }>;
  check(
    'a sample with a negative cache bucket is rejected outright',
    badRows.length === 1 && badRows[0]!.type === 'model-output',
    typesOf(badRows),
  );

  // Reversed or unusable endpoints: pairs are dropped, and a turn whose own
  // endpoints disagree closes with NO timing, tokens, or totals — the status
  // row still lands.
  const reversed = createDshMapState(SESSION_ID, false);
  const reversedFeed = (seq: number, time: unknown, type: string, data: Record<string, unknown>) =>
    mapDshEvent({ event: { type, seq, time, data } as never }, reversed) as Array<Record<string, unknown>>;
  reversedFeed(1, 2000, 'turn/start', { turn: 1 });
  reversedFeed(2, 2100, 'step/start', { turn: 1, step: 1 });
  reversedFeed(3, 2050, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, usage: { inputTokens: 3, outputTokens: 1 } });
  reversedFeed(4, 2200, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' });
  reversedFeed(5, 2150, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [{ toolCallId: 'c1', content: 'ok' }] } });
  const reversedEnd = reversedFeed(6, 1000, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  check(
    'reversed turn endpoints close the row without timing or tokens',
    reversedEnd.length === 1 && reversedEnd[0]!.status === 'done'
      && reversedEnd[0]!.totalRuntimeMs === undefined && reversedEnd[0]!.agentRuntimeMs === undefined
      && reversedEnd[0]!.executionRuntimeMs === undefined && reversedEnd[0]!.tokens === undefined,
    JSON.stringify(reversedEnd[0]),
  );

  const missingTime = createDshMapState(SESSION_ID, false);
  const missingFeed = (seq: number, time: unknown, type: string, data: Record<string, unknown>) =>
    mapDshEvent({ event: { type, seq, time, data } as never }, missingTime) as Array<Record<string, unknown>>;
  missingFeed(1, 'not-a-time', 'turn/start', { turn: 1 });
  missingFeed(2, 1100, 'step/start', { turn: 1, step: 1 });
  missingFeed(3, Number.NaN, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, usage: { inputTokens: 3, outputTokens: 1 } });
  missingFeed(4, 1200, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' });
  missingFeed(5, Number.POSITIVE_INFINITY, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [{ toolCallId: 'c1', content: 'ok' }] } });
  const missingEnd = missingFeed(6, 1600, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  check(
    'string and non-finite timestamps drop their pairs and leave the turn untimed',
    missingEnd.length === 1 && missingEnd[0]!.totalRuntimeMs === undefined
      && missingEnd[0]!.agentRuntimeMs === undefined && missingEnd[0]!.tokens === undefined,
    JSON.stringify(missingEnd[0]),
  );

  // A turn with valid endpoints but a reversed STEP pair reports the pair as
  // dropped (model time absent from the sum) while the turn itself times.
  const droppedPair = createDshMapState(SESSION_ID, false);
  const pairFeed = (seq: number, time: number, type: string, data: Record<string, unknown>) =>
    mapDshEvent({ event: { type, seq, time, data } }, droppedPair) as Array<Record<string, unknown>>;
  pairFeed(1, 1000, 'turn/start', { turn: 1 });
  pairFeed(2, 1100, 'step/start', { turn: 1, step: 1 });
  pairFeed(3, 1050, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, usage: { inputTokens: 3, outputTokens: 1 } });
  const pairEnd = pairFeed(4, 1600, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  check(
    'a reversed step pair is dropped while the turn itself still times',
    pairEnd[0]!.totalRuntimeMs === 600 && pairEnd[0]!.agentRuntimeMs === 0
      && JSON.stringify(pairEnd[0]!.tokens) === JSON.stringify({ input: 3, output: 1, cacheRead: 0, cacheWrite: 0 }),
    JSON.stringify(pairEnd[0]),
  );

  // Raw invalid timestamps must never reach canonical rows: only VALIDATED
  // times are spread, so a malformed turn/start or turn/end leaves the field
  // absent instead of publishing "bad" as a timestamp.
  const rawTimes = createDshMapState(SESSION_ID, false);
  const rawFeed = (seq: number, time: unknown, type: string, data: Record<string, unknown>) =>
    mapDshEvent({ event: { type, seq, time, data } as never }, rawTimes) as Array<Record<string, unknown>>;
  const rawStart = rawFeed(1, 'bad', 'turn/start', { turn: 1 });
  const rawEnd = rawFeed(2, 'bad', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  check(
    'invalid turn timestamps stay out of startedAt and completedAt entirely',
    rawStart.length === 1 && !('startedAt' in rawStart[0]!)
      && rawEnd.length === 1 && !('completedAt' in rawEnd[0]!),
    JSON.stringify([rawStart[0], rawEnd[0]]),
  );

  // Usage from an event with an unusable timestamp is not accepted: no
  // token-count row, no fold contribution — even when the turn itself times.
  const untimedUsage = createDshMapState(SESSION_ID, false);
  const untimedFeed = (seq: number, time: unknown, type: string, data: Record<string, unknown>) =>
    mapDshEvent({ event: { type, seq, time, data } as never }, untimedUsage) as Array<Record<string, unknown>>;
  untimedFeed(1, 1000, 'turn/start', { turn: 1 });
  untimedFeed(2, 1100, 'step/start', { turn: 1, step: 1 });
  const untimedMessage = untimedFeed(3, Number.NaN, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, usage: { inputTokens: 3, outputTokens: 1 } });
  untimedFeed(4, 'bad', 'assistant/chunk', { turn: 1, step: 2, chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } } });
  const untimedEnd = untimedFeed(5, 1600, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  check(
    'usage without a usable event time produces no reading and no fold contribution',
    untimedMessage.every((row) => row.type !== 'token-count')
      && untimedEnd[0]!.totalRuntimeMs === 600 && untimedEnd[0]!.tokens === undefined,
    JSON.stringify([untimedMessage, untimedEnd[0]]),
  );
}

// ── 10. Fork seed boundary ──────────────────────────────────────────────────

{
  // Events before the LAST session/end-seed came from a constructor seed
  // (resume/fork/replay): they render as transcript but never feed this
  // lifecycle's timing or usage — tokdash skips the same prefix via the
  // header's seedLength, which the wire does not expose. The marker TRAILS
  // the prefix it closes, so the batch fold locates it up front.
  const forked = mapDshHistory([
    { event: { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } } },
    { event: { type: 'step/start', seq: 2, time: 1100, data: { turn: 1, step: 1 } } },
    { event: { type: 'assistant/message', seq: 3, time: 1500, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'parent reply' }] }, usage: { inputTokens: 500, outputTokens: 50 } }, surfaceOp: 'append' } },
    { event: { type: 'step/end', seq: 4, time: 1550, data: { turn: 1, step: 1 } } },
    { event: { type: 'turn/end', seq: 5, time: 1600, data: { turn: 1, reason: { kind: 'completed' } } } },
    { event: { type: 'session/end-seed', seq: 6, time: 1700, data: {} } },
    { event: { type: 'turn/start', seq: 7, time: 1800, data: { turn: 2 } } },
    { event: { type: 'step/start', seq: 8, time: 1850, data: { turn: 2, step: 1 } } },
    { event: { type: 'assistant/message', seq: 9, time: 2000, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'child reply' }] }, usage: { inputTokens: 10, outputTokens: 2 } }, surfaceOp: 'append' } },
    { event: { type: 'step/end', seq: 10, time: 2050, data: { turn: 2, step: 1 } } },
    { event: { type: 'turn/end', seq: 11, time: 2100, data: { turn: 2, reason: { kind: 'completed' } } } },
  ], createDshMapState(SESSION_ID, false)) as Array<Record<string, unknown>>;
  const closes = forked.filter((row) => row.type === 'run-summary' && row.status === 'done');
  const tokenRows = forked.filter((row) => row.type === 'token-count');
  check(
    'the seed prefix renders as transcript but carries no usage readings',
    forked.some((row) => row.type === 'model-output' && (row as { text?: string }).text === 'parent reply')
      && tokenRows.length === 1
      && JSON.stringify(tokenRows[0]) === JSON.stringify({ type: 'token-count', input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }),
    `${tokenRows.length} token-count rows`,
  );
  check(
    'an inherited parent turn closes untimed while the child turn times normally',
    closes.length === 2
      && closes[0]!.totalRuntimeMs === undefined && closes[0]!.tokens === undefined
      && closes[1]!.totalRuntimeMs === 300 && closes[1]!.agentRuntimeMs === 150
      && JSON.stringify(closes[1]!.tokens) === JSON.stringify({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }),
    JSON.stringify(closes),
  );

  // With a boundary established, an UNREADABLE seq (missing, string, NaN)
  // cannot be proven post-seed: it fails closed into the seeded prefix — no
  // token-count, no timing or usage contribution — while the transcript row
  // still renders.
  const unreadableSeq = createDshMapState(SESSION_ID, false);
  const seqFeed = (seq: unknown, time: number, type: string, data: Record<string, unknown>) =>
    mapDshEvent({ event: { type, seq, time, data } as never }, unreadableSeq) as Array<Record<string, unknown>>;
  seqFeed(6, 1700, 'session/end-seed', {});
  seqFeed(7, 1800, 'turn/start', { turn: 2 });
  seqFeed(8, 1850, 'step/start', { turn: 2, step: 1 });
  const noSeqMessage = seqFeed(undefined, 2000, 'assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'child reply' }] }, usage: { inputTokens: 10, outputTokens: 2 } });
  const noSeqEnd = seqFeed(11, 2100, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
  check(
    'with a seed boundary, an unreadable seq is excluded from usage and timing',
    noSeqMessage.some((row) => row.type === 'model-output')
      && noSeqMessage.every((row) => row.type !== 'token-count')
      && noSeqEnd[0]!.totalRuntimeMs === 300 && noSeqEnd[0]!.agentRuntimeMs === 0
      && noSeqEnd[0]!.tokens === undefined,
    JSON.stringify([noSeqMessage, noSeqEnd[0]]),
  );

  // Without a boundary the same event still counts — the fail-closed rule is
  // scoped to sessions with a proven seeded prefix.
  const noBoundary = createDshMapState(SESSION_ID, false);
  const freeFeed = (seq: unknown, time: number, type: string, data: Record<string, unknown>) =>
    mapDshEvent({ event: { type, seq, time, data } as never }, noBoundary) as Array<Record<string, unknown>>;
  freeFeed(1, 1000, 'turn/start', { turn: 1 });
  freeFeed(2, 1100, 'step/start', { turn: 1, step: 1 });
  const freeMessage = freeFeed(undefined, 1500, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, usage: { inputTokens: 3, outputTokens: 1 } });
  check(
    'without a seed boundary, an unreadable seq still counts (nothing to be excluded from)',
    freeMessage.some((row) => row.type === 'token-count'),
    JSON.stringify(freeMessage),
  );
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
