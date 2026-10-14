/**
 * Session status truth, the ordering tables: exhaustive property checks that an end-to-end suite
 * cannot enumerate cheaply (about 1.4 s in-process).
 *
 *   convergence: the production Codex connection, fed by a real unix-socket daemon, converges for
 *     every permutation of one turn's notifications, for duplicate and re-ordered redelivery, for a
 *     terminal exactly-once, for a reused turn id (generation fence) and for the transcript and run
 *     identities of two generations.
 *   fold: the production Hub/ManagedConn fold, the roster publication boundary and the revision
 *     journal, for every frame of a script, a watcher snapshot at every position, replacement seeds
 *     and a proven replacement retiring its predecessor.
 *
 * The live behaviour of the same rules through a real broker is `e2e/broker/status-truth*.test.ts`.
 * Windows: the fold lane is pure; the convergence lane uses a unix socket inside a temp directory
 * (the legacy task ran it in the Windows suite the same way).
 */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub, ManagedConn } from '../../src/sessions/hub.ts';
import { RosterRevisionStore } from '../../src/roster/roster-revision.ts';
import {
  createRosterPublicationBoundary,
  NativeIncarnationPublicationAuthority,
  type RosterPublicationBoundary,
} from '../../src/roster/roster-publication.ts';
import { AgentRegistry, type AgentMessage, type SessionConnection, type SessionInfo } from '../../../adapter-api/src/index.ts';
import { FakeCodexDaemon } from '../helpers/fake-codex-daemon.ts';
import type { CodexTuiScan } from '../../../adapters/codex/src/tui-presence.ts';

// The Codex adapter reads its env-derived constants when its module loads, which happens on the
// first dynamic import inside a test: the environment is fixed here, once, against one temp home.
const home = mkdtempSync(join(tmpdir(), 'cosyncing-status-fold-'));
const sock = join(home, 'app-server-control.sock');
const previous: Record<string, string | undefined> = {};
for (const [key, value] of Object.entries({
  CODEX_HOME: home,
  COSYNCING_CODEX_SYNC_SERVER: '1',
  COSYNCING_CODEX_APP_SERVER_SOCK: sock,
  COSYNCING_CODEX_SYNC_WATCH_MS: '250',
  COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS: '1',
})) {
  previous[key] = process.env[key];
  process.env[key] = value;
}
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value == null) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const cwd = join(home, 'workspace');
const sessions = join(home, 'sessions', '2026', '08', '03');
const FOLD_MACHINE = 'status-interleaving';
const encode = (path: string): string => Buffer.from(path, 'utf8').toString('base64url');

/** A failed check names itself and what was seen. */
const check = (label: string, ok: boolean, extra = ''): void => {
  if (!ok) throw new Error(`${label}${extra ? `  (${extra})` : ''}`);
};

const emptyScan = (): CodexTuiScan => ({
  attributed: new Set(),
  unattributed: [],
  privateThreadIds: new Set(),
  privateUnattributed: [],
  unknownUnattributed: [],
  unknownThreadIds: new Set(),
  candidates: [],
  socketDiagAvailable: true,
  processScanAvailable: true,
});

/** Poll for a condition until a hang-detector deadline; false if it never held. */
async function settlesTo(predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(5);
  }
  return false;
}

// ── convergence ──────────────────────────────────────────────────────────────────────────────
describe('Codex turn-event delivery converges whatever the order', () => {
  let convergenceDaemon: FakeCodexDaemon;

  const THREAD = '019fca00-0000-7000-8000-00000000000f';
  const TURN = 'turn-interleaved';
  const FOREIGN_TURN = 'turn-foreign';
  const rollout = join(sessions, `rollout-2026-08-03T00-00-00-${THREAD}.jsonl`);

  type Event = { name: string; method: string; params: unknown };

  const EVENTS: Event[] = [
    { name: 'started', method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN } } },
    { name: 'active', method: 'thread/status/changed', params: { threadId: THREAD, status: { type: 'active', activeFlags: [] } } },
    { name: 'idle', method: 'thread/status/changed', params: { threadId: THREAD, status: { type: 'idle' } } },
    { name: 'notLoaded', method: 'thread/status/changed', params: { threadId: THREAD, status: { type: 'notLoaded' } } },
    {
      name: 'completed',
      method: 'turn/completed',
      params: {
        threadId: THREAD,
        turn: { id: TURN, status: 'completed', createdAt: '2026-08-03T00:00:00.000Z', completedAt: '2026-08-03T00:00:08.000Z' },
      },
    },
  ];

  function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items];
    const out: T[][] = [];
    for (let i = 0; i < items.length; i++) {
      const rest = [...items.slice(0, i), ...items.slice(i + 1)];
      for (const tail of permutations(rest)) out.push([items[i]!, ...tail]);
    }
    return out;
  }

  convergenceDaemon = new FakeCodexDaemon(sock, {
    loadedThreadIds: [THREAD],
    // No status in the resume result: the seed is deliberately empty so the notifications under test
    // are the ONLY run-state evidence the connection has.
    resumeResult: () => ({ thread: { id: THREAD, name: 'interleaved' }, model: 'fake-model', modelProvider: 'fake-provider' }),
    // The runtime's own truth for the complete record: the turn ran and completed. A reconciliation
    // triggered by an out-of-order `active` frame must therefore agree with the derivation, not fight
    // it — that agreement is what "converges" means here.
    readResult: () => ({ thread: { id: THREAD, status: { type: 'idle' }, turns: [{ id: TURN, status: 'completed' }] } }),
    turnsResult: () => ({ data: [{ id: TURN, status: 'completed' }] }),
  });

  let sentinel = 0;
  /** Deliver `events` in order, then a sentinel whose canonical message proves the whole batch was
   *  consumed — the socket preserves order, so no wall-clock settle is needed. */
  async function deliver(events: Event[], seen: AgentMessage[]): Promise<boolean> {
    for (const event of events) convergenceDaemon!.notify(event.method, event.params);
    const marker = ++sentinel * 1_000;
    convergenceDaemon!.notify('thread/tokenUsage/updated', { threadId: THREAD, tokenUsage: { total: { inputTokens: marker, outputTokens: 0, cachedInputTokens: 0 } } });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (seen.some((m: any) => m?.type === 'token-count' && m.input === marker)) return true;
      await Bun.sleep(5);
    }
    return false;
  }

  const rolloutLine = (value: unknown): string => `${JSON.stringify({ timestamp: '2026-08-03T01:00:00.000Z', ...(value as object) })}\n`;

  async function withOwner(
    fn: (conn: SessionConnection, managed: ManagedConn, seen: AgentMessage[]) => Promise<void>,
  ): Promise<void> {
    const { CodexAdapter } = await import('../../../adapters/codex/src/index.ts');
    const adapter = new CodexAdapter({
      queryLoadedThreadIds: async () => new Set([THREAD]),
      queryLoadedThreadActivities: async () => [],
      scanCodexTuiPresence: async () => emptyScan(),
    });
    const conn = await adapter.attach(encode(rollout));
    const seen: AgentMessage[] = [];
    // The production Hub wrapper, so the assertions cover the fold the roster publishes from — not
    // just the adapter's private state.
    const managed = new ManagedConn(conn);
    const stop = conn.subscribe((message) => seen.push(message));
    try {
      await fn(conn, managed, seen);
    } finally {
      stop();
      await managed.dispose().catch(() => {});
    }
  }

  const statusFrames = (seen: AgentMessage[]): string[] =>
    seen.filter((m: any) => m?.type === 'status').map((m: any) => String(m.status));
  const terminalSummaries = (seen: AgentMessage[]): any[] =>
    seen.filter((m: any) => m?.type === 'run-summary' && m.turnId === TURN && m.status !== 'running');

  beforeAll(async () => {
    mkdirSync(sessions, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(rollout, `${JSON.stringify({
      timestamp: '2026-08-03T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: THREAD, cwd },
    })}\n`);
    await convergenceDaemon.start();
  });
  afterAll(async () => {
    await convergenceDaemon?.stop().catch(() => {});
  });

  test('I every permutation converges and emits one terminal', async () => {
    const orders = permutations(EVENTS);
    const divergent: string[] = [];
    const multipleTerminals: string[] = [];
    for (const order of orders) {
      await withOwner(async (conn, managed, seen) => {
        const delivered = await deliver(order, seen);
        const names = order.map((event) => event.name).join(',');
        if (!delivered) {
          divergent.push(`${names}: delivery never settled`);
          return;
        }
        // The complete record is "turn TURN started and completed", whose derivation is Idle.
        //
        // Awaited, not sampled: an out-of-order `active` frame starts a native reconciliation whose
        // reply travels after this batch's sentinel, so a permutation ending on `active` is legitimately
        // mid-flight at this point. CONVERGENCE is the property under test, and a bounded wait cannot
        // mask a real divergence — an interleaving that settles on the wrong state settles there and
        // stays, so the wait expires and the permutation is still recorded.
        if (!await settlesTo(() => conn.info.status === 'idle' && managed.status === 'idle')) {
          divergent.push(`${names}: adapter=${conn.info.status} hub=${managed.status}`);
        }
        const terminals = terminalSummaries(seen);
        if (terminals.length !== 1) multipleTerminals.push(`${names}: ${terminals.length}`);
      });
    }
    check(`I all ${orders.length} permutations of one turn's notifications converge to the complete-record derivation`,
      divergent.length === 0, divergent.slice(0, 4).join(' | '));
    check('I every permutation emits exactly one terminal run-summary for the turn',
      multipleTerminals.length === 0, multipleTerminals.slice(0, 4).join(' | '));

  });

  test('D duplicates and replays', async () => {
    await withOwner(async (conn, managed, seen) => {
      const forward = [...EVENTS];
      const reversed = [...EVENTS].reverse();
      const first = await deliver(forward, seen);
      const second = await deliver(reversed, seen);
      const third = await deliver(forward, seen);
      const converged = await settlesTo(() => conn.info.status === 'idle' && managed.status === 'idle');
      check('D a replayed and re-ordered redelivery of the same turn still converges to Idle',
        first && second && third && converged,
        `adapter=${conn.info.status} hub=${managed.status}`);
      check('D three deliveries of the same turn still yield exactly one terminal run-summary',
        terminalSummaries(seen).length === 1, `terminals=${terminalSummaries(seen).length}`);
  });

  });

  test('E terminal exactly-once while a turn is admitted', async () => {
    await withOwner(async (conn, managed, seen) => {
      const admitted = await deliver([EVENTS[0]!], seen);
      check('E the turn is admitted Working from its exact start', admitted && managed.status === 'working', `hub=${managed.status}`);
      const beforeIdles = statusFrames(seen).filter((status) => status === 'idle').length;

      await deliver([
        EVENTS[2]!, // weak thread idle
        EVENTS[3]!, // weak notLoaded
        EVENTS[2]!, // duplicate weak idle
        { name: 'foreign', method: 'turn/completed', params: { threadId: THREAD, turn: { id: FOREIGN_TURN, status: 'completed' } } },
        { name: 'idless', method: 'turn/completed', params: { threadId: THREAD, turn: { status: 'completed' } } },
      ], seen);
      check('E weak idle/notLoaded, a foreign completion, and an id-less completion add no Idle transition',
        statusFrames(seen).filter((status) => status === 'idle').length === beforeIdles && managed.status === 'working',
        `idles=${statusFrames(seen).filter((s) => s === 'idle').length} before=${beforeIdles} hub=${managed.status}`);

      await deliver([EVENTS[4]!, EVENTS[4]!, EVENTS[4]!], seen);
      check('E the exact matching terminal adds exactly one Idle transition, duplicates add none',
        statusFrames(seen).filter((status) => status === 'idle').length === beforeIdles + 1 && managed.status === 'idle',
        `idles=${statusFrames(seen).filter((s) => s === 'idle').length} expected=${beforeIdles + 1} hub=${managed.status}`);
      check('E the completed turn produced exactly one terminal run-summary',
        terminalSummaries(seen).length === 1, `terminals=${terminalSummaries(seen).length}`);
      check('E the adapter projection and the Hub fold agree after the terminal',
        conn.info.status === managed.status, `adapter=${conn.info.status} hub=${managed.status}`);
  });

  });

  test('G a reused turn id needs a proven new generation', async () => {
    // The replay guard settles Idle for any start bearing a recently-completed id, which is right for
    // a redelivered start and wrong for a runtime that genuinely reuses the id — the real turn would
    // be swallowed and the session would sit Idle through it. The runtime's own timestamps separate
    // the two: a start that began after the recorded completion cannot be that completion's start.
    await withOwner(async (conn, managed, seen) => {
      await deliver([EVENTS[0]!, EVENTS[4]!], seen);
      check('G the first generation completes normally', managed.status === 'idle' && terminalSummaries(seen).length === 1,
        `hub=${managed.status} terminals=${terminalSummaries(seen).length}`);

      // A redelivery of that same start — no timestamp, so nothing proves a new turn.
      await deliver([EVENTS[0]!], seen);
      check('G a redelivered start with no timestamp is still treated as a replay',
        managed.status === 'idle' && terminalSummaries(seen).length === 1,
        `hub=${managed.status} terminals=${terminalSummaries(seen).length}`);

      // A start whose own timestamp PREDATES the recorded completion is likewise an old start.
      await deliver([{
        name: 'stale-start',
        method: 'turn/started',
        params: { threadId: THREAD, turn: { id: TURN, startedAt: '2026-08-03T00:00:00.000Z' } },
      }], seen);
      check('G a start older than the recorded completion is still a replay',
        managed.status === 'idle', `hub=${managed.status}`);

      // A start that began AFTER the recorded completion is a new turn reusing the id.
      await deliver([{
        name: 'new-generation',
        method: 'turn/started',
        params: { threadId: THREAD, turn: { id: TURN, startedAt: '2026-08-03T00:00:30.000Z' } },
      }], seen);
      check('G a start newer than the recorded completion admits a new generation as Working',
        conn.info.status === 'working' && managed.status === 'working',
        `adapter=${conn.info.status} hub=${managed.status}`);

      // The new generation owns its own terminal: the retired record must not swallow it.
      await deliver([{
        name: 'new-generation-completed',
        method: 'turn/completed',
        params: {
          threadId: THREAD,
          turn: { id: TURN, status: 'completed', createdAt: '2026-08-03T00:00:30.000Z', completedAt: '2026-08-03T00:00:38.000Z' },
        },
      }], seen);
      check('G the new generation emits its own terminal and settles Idle',
        managed.status === 'idle' && terminalSummaries(seen).length === 2,
        `hub=${managed.status} terminals=${terminalSummaries(seen).length}`);
  });

  });

  test('K two generations keep distinct transcript and run identities', async () => {
    // Admitting the second generation is only half the job: its prompt and answer must be distinct
    // canonical rows from the first's, its footer must name its OWN prompt, and — because a client
    // rebuilds the same session from the rollout after a reconnect — the live keys and the replayed
    // keys must be the same ordered sequence. The prompt ordinal is what carries that: it counts per
    // turn id across the whole file, so it must NOT restart at zero for a new generation.
    await withOwner(async (conn, _managed, seen) => {
      const userKeys = (): string[] => seen.filter((m: any) => m?.type === 'user-message').map((m: any) => String(m.key));
      const assistantKeys = (): string[] => seen.filter((m: any) => m?.type === 'model-output' && m.text).map((m: any) => String(m.key));
      const summaryFor = (completedAt: string): any => seen.filter((m: any) =>
        m?.type === 'run-summary' && m.turnId === TURN && m.status !== 'running'
        && m.completedAt === Date.parse(completedAt)).at(-1);

      // Generation one: prompt, answer, terminal.
      await deliver([
        EVENTS[0]!,
        { name: 'g1-user', method: 'item/started', params: { threadId: THREAD, turnId: TURN, item: { type: 'userMessage', id: 'item-u-g1', content: [{ type: 'text', text: 'first generation prompt' }] } } },
        { name: 'g1-answer', method: 'item/completed', params: { threadId: THREAD, turnId: TURN, item: { type: 'agentMessage', id: 'item-a-g1', text: 'first generation answer' } } },
        {
          name: 'g1-completed',
          method: 'turn/completed',
          params: { threadId: THREAD, turn: { id: TURN, status: 'completed', createdAt: '2026-08-03T01:00:00.000Z', completedAt: '2026-08-03T01:00:08.000Z' } },
        },
      ], seen);
      const generationOneUser = [...userKeys()];
      const generationOneAssistant = [...assistantKeys()];
      check('K generation one published one prompt and one answer',
        generationOneUser.length === 1 && generationOneAssistant.length === 1,
        `user=${generationOneUser.join(',')} assistant=${generationOneAssistant.join(',')}`);

      // Generation two reuses the id, proven new by its own start timestamp.
      await deliver([
        { name: 'g2-start', method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN, startedAt: '2026-08-03T01:00:30.000Z' } } },
        { name: 'g2-user', method: 'item/started', params: { threadId: THREAD, turnId: TURN, item: { type: 'userMessage', id: 'item-u-g2', content: [{ type: 'text', text: 'second generation prompt' }] } } },
        { name: 'g2-answer', method: 'item/completed', params: { threadId: THREAD, turnId: TURN, item: { type: 'agentMessage', id: 'item-a-g2', text: 'second generation answer' } } },
        {
          name: 'g2-completed',
          method: 'turn/completed',
          params: { threadId: THREAD, turn: { id: TURN, status: 'completed', createdAt: '2026-08-03T01:00:30.000Z', completedAt: '2026-08-03T01:00:38.000Z' } },
        },
      ], seen);
      const liveUser = userKeys();
      const liveAssistant = assistantKeys();
      check('K generation one’s published keys are unchanged by the second generation',
        liveUser[0] === generationOneUser[0] && liveAssistant[0] === generationOneAssistant[0],
        `user=${liveUser.join(',')} assistant=${liveAssistant.join(',')}`);
      check('K the second generation’s prompt and answer are DISTINCT canonical rows',
        liveUser.length === 2 && liveUser[1] !== liveUser[0]
        && liveAssistant.length === 2 && liveAssistant[1] !== liveAssistant[0],
        `user=${liveUser.join(',')} assistant=${liveAssistant.join(',')}`);
      check('K the second generation’s footer names its OWN prompt, not the first’s',
        summaryFor('2026-08-03T01:00:38.000Z')?.userMessageKey === liveUser[1],
        `summary=${JSON.stringify(summaryFor('2026-08-03T01:00:38.000Z') ?? null)} expected=${liveUser[1]}`);
      check('K the first generation’s footer still names the first prompt',
        summaryFor('2026-08-03T01:00:08.000Z')?.userMessageKey === liveUser[0],
        `summary=${JSON.stringify(summaryFor('2026-08-03T01:00:08.000Z') ?? null)} expected=${liveUser[0]}`);

      // Convergence: the same two generations as the rollout would persist them. A reconnecting client
      // rebuilds from these bytes, so the replayed identities must be the live ones.
      appendFileSync(rollout, [
        rolloutLine({ type: 'event_msg', payload: { type: 'task_started', turn_id: TURN } }),
        rolloutLine({ type: 'event_msg', payload: { type: 'user_message', message: 'first generation prompt' } }),
        rolloutLine({ type: 'event_msg', payload: { type: 'task_complete', turn_id: TURN } }),
        rolloutLine({ type: 'event_msg', payload: { type: 'task_started', turn_id: TURN } }),
        rolloutLine({ type: 'event_msg', payload: { type: 'user_message', message: 'second generation prompt' } }),
        rolloutLine({ type: 'event_msg', payload: { type: 'task_complete', turn_id: TURN } }),
      ].join(''));
      const history = await conn.getHistory();
      const historyUser = history.filter((m: any) => m?.type === 'user-message').map((m: any) => String(m.key));
      check('K a rollout replay of the reused id yields the SAME ordered keys the live path published',
        historyUser.join(',') === liveUser.join(','),
        `history=${historyUser.join(',')} live=${liveUser.join(',')}`);
      // The replay's own footers must attach per generation too, for the same reason the live ones do:
      // a client rebuilding from these bytes would otherwise show the second turn owning the first
      // turn's prompt. The generation boundary here is visible purely in record order — a start for an
      // id whose terminal already appeared — which is what lets both paths agree without sharing state.
      const historySummaries: any[] = history.filter((m: any) =>
        m?.type === 'run-summary' && m.turnId === TURN && m.status !== 'running');
      check('K the replay attaches each generation’s footer to its own prompt',
        historySummaries.length === 2
        && historySummaries[0]?.userMessageKey === historyUser[0]
        && historySummaries[1]?.userMessageKey === historyUser[1],
        `summaries=${JSON.stringify(historySummaries.map((m: any) => m.userMessageKey))} users=${historyUser.join(',')}`);

      // Canonical RUN identity (round 4). Distinct emissions are not enough: canonical identity
      // downstream is exactly type+key — the Flutter reducer merges equal pairs (the second footer
      // would REPLACE the first) and Attention derives its observation/dedupe identity from this key.
      // The two generations must therefore mint distinct run keys, identically on both paths.
      const liveTerminalRunKeys = seen.filter((m: any) =>
        m?.type === 'run-summary' && m.turnId === TURN && m.status !== 'running')
        .map((m: any) => String(m.key));
      check('K the two generations carry DISTINCT canonical run keys',
        liveTerminalRunKeys.length === 2 && liveTerminalRunKeys[0] !== liveTerminalRunKeys[1],
        `keys=${liveTerminalRunKeys.join(',')}`);
      const historyRunKeys = historySummaries.map((m: any) => String(m.key));
      check('K the replay mints the SAME per-generation run keys the live path published',
        historyRunKeys.join(',') === liveTerminalRunKeys.join(','),
        `history=${historyRunKeys.join(',')} live=${liveTerminalRunKeys.join(',')}`);

      // A reused generation that also repeats an ITEM id is a new prompt, not a redelivery: the
      // idempotent re-delivery memory is generation-scoped (round 4). With it left intact across the
      // boundary, liveUserMessageKey answers with the PREVIOUS generation's key and merges the two
      // prompts into one row.
      const REUSED = 'turn-reused-item';
      await deliver([
        { name: 'r1-start', method: 'turn/started', params: { threadId: THREAD, turn: { id: REUSED, startedAt: '2026-08-03T02:00:00.000Z' } } },
        { name: 'r1-user', method: 'item/started', params: { threadId: THREAD, turnId: REUSED, item: { type: 'userMessage', id: 'item-u-shared', content: [{ type: 'text', text: 'reused-item generation one' }] } } },
        { name: 'r1-completed', method: 'turn/completed', params: { threadId: THREAD, turn: { id: REUSED, status: 'completed', createdAt: '2026-08-03T02:00:00.000Z', completedAt: '2026-08-03T02:00:05.000Z' } } },
        { name: 'r2-start', method: 'turn/started', params: { threadId: THREAD, turn: { id: REUSED, startedAt: '2026-08-03T02:00:30.000Z' } } },
        { name: 'r2-user', method: 'item/started', params: { threadId: THREAD, turnId: REUSED, item: { type: 'userMessage', id: 'item-u-shared', content: [{ type: 'text', text: 'reused-item generation two' }] } } },
        { name: 'r2-completed', method: 'turn/completed', params: { threadId: THREAD, turn: { id: REUSED, status: 'completed', createdAt: '2026-08-03T02:00:30.000Z', completedAt: '2026-08-03T02:00:35.000Z' } } },
      ], seen);
      const sharedItemKeys = seen.filter((m: any) =>
        m?.type === 'user-message' && String(m.key).startsWith(`codex:${REUSED}:`))
        .map((m: any) => String(m.key));
      check('K a repeated item id in a NEW generation is a new prompt with a new key',
        sharedItemKeys.length === 2 && sharedItemKeys[0] !== sharedItemKeys[1],
        `keys=${sharedItemKeys.join(',')}`);
  });
  });

});

// ── fold ─────────────────────────────────────────────────────────────────────────────────────
describe('the Hub fold, the watcher and a replacement never disagree with the reference rules', () => {
  const rosterRevision = new RosterRevisionStore(4096);
  const decorate = (info: SessionInfo): SessionInfo => structuredClone({ ...info, machine: FOLD_MACHINE });
  const observeRosterViews = (info: SessionInfo): void => {
    rosterRevision.observe(decorate(info), FOLD_MACHINE);
  };

  type Emitter = SessionConnection & { emit: (m: AgentMessage) => void };
  function fakeConn(info: SessionInfo): Emitter {
    const handlers = new Set<(m: AgentMessage) => void>();
    const conn: any = {
      info: structuredClone(info),
      emit: (m: AgentMessage) => { for (const h of [...handlers]) h(m); },
      getHistory: async () => [],
      subscribe: (h: (m: AgentMessage) => void) => { handlers.add(h); return () => handlers.delete(h); },
      sendPrompt: async () => {},
      respondPermission: async () => {},
      close: async () => {},
    };
    return conn as Emitter;
  }

  const attachPlans = new Map<string, () => Emitter>();
  const registry = new AgentRegistry();
  registry.register({
    id: 'codex',
    displayName: 'Codex (fake)',
    capabilities: {} as any,
    isAvailable: async () => true,
    discoverSessions: async () => [],
    attach: async (id: string) => {
      const plan = attachPlans.get(id);
      if (!plan) throw new Error(`no attach plan for ${id}`);
      return plan();
    },
  } as any);

  let boundary: {
    publishOwnerFrame(info: SessionInfo): void;
    submitWatcherSnapshot(info: SessionInfo): void;
    settle(): Promise<void>;
  };
  const hub = new Hub(registry, 15000, undefined, {
    onSessionInfo: (info) => boundary.publishOwnerFrame(info),
  });
  const nativeAuthority = new NativeIncarnationPublicationAuthority();
  boundary = createRosterPublicationBoundary({
    liveOwners: () => hub.liveSnapshot(),
    publish: observeRosterViews,
    acceptWatcher: (info: SessionInfo) => nativeAuthority.acceptsWatcher(info),
    reconcile: (info: SessionInfo) => hub.refreshExternalSession(decorate(info)),
    onReconcileError: () => {},
  });

  const codexInfo = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
    id,
    tool: 'codex',
    title: `interleave ${id}`,
    cwd: '/tmp/cosyncing-interleave',
    nativeId: `thread-${id}`,
    status: 'idle',
    attachMode: 'live',
    updatedAt: 10_000,
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: true, syncAvailable: true, active: false },
    },
    ...over,
  } as SessionInfo);

  /** Every status value journaled for one session after `after`, consecutive duplicates collapsed. */
  function statusTrail(after: number, sessionId: string): string[] {
    const trail: string[] = [];
    for (const delta of rosterRevision.eventsAfter(after).deltas) {
      if (delta.sessionId !== sessionId || delta.removed) continue;
      const status = String(delta.session?.status ?? '');
      if (trail.at(-1) !== status) trail.push(status);
    }
    return trail;
  }
  function idleRevisions(after: number, sessionId: string): number {
    return rosterRevision.eventsAfter(after).deltas.filter((delta) =>
      delta.sessionId === sessionId && !delta.removed &&
      (delta.changedFields.includes('status') || delta.changedFields.includes('session')) &&
      delta.session?.status === 'idle').length;
  }

  // ── reference fold: the DOCUMENTED ManagedConn run-state rules, nothing more ─────────────────
  type Step = string; // 'run' | 'idle' | 'perm:<id>' | 'res:<id>' | 'q:<id>' | 'resq:<id>'
  interface FoldState { running: boolean; provisional: boolean; pending: Set<string> }
  const foldStatus = (s: FoldState): string =>
    s.provisional || s.pending.size > 0 ? 'needs-input' : s.running ? 'working' : 'idle';
  function foldSeed(seedStatus: string): FoldState {
    return { running: seedStatus !== 'idle', provisional: seedStatus === 'needs-input', pending: new Set() };
  }
  function foldStep(s: FoldState, step: Step): void {
    const [kind, id] = step.split(':');
    if (kind === 'run') { s.provisional = false; s.running = true; }
    else if (kind === 'idle') { s.provisional = false; s.running = false; }
    else if (kind === 'perm' || kind === 'q') { s.provisional = false; s.pending.add(String(id)); }
    else if (kind === 'res' || kind === 'resq') { s.pending.delete(String(id)); }
    else throw new Error(`unknown step ${step}`);
  }
  function frameFor(step: Step): AgentMessage {
    const [kind, id] = step.split(':');
    if (kind === 'run') return { type: 'status', status: 'running' } as AgentMessage;
    if (kind === 'idle') return { type: 'status', status: 'idle' } as AgentMessage;
    if (kind === 'perm') return { type: 'permission-request', requestId: String(id), title: 'fake' } as AgentMessage;
    if (kind === 'res') return { type: 'permission-resolved', requestId: String(id) } as AgentMessage;
    if (kind === 'q') return { type: 'question-request', requestId: String(id), questions: [] } as AgentMessage;
    return { type: 'question-resolved', requestId: String(id) } as AgentMessage;
  }
  /** The fold's deduped transition trail from a seed, matching the journal's collapse rule. */
  function foldTrail(seedStatus: string, steps: Step[]): string[] {
    const s = foldSeed(seedStatus);
    const trail: string[] = [];
    let last = foldStatus(s);
    for (const step of steps) {
      foldStep(s, step);
      const now = foldStatus(s);
      if (now !== last) { trail.push(now); last = now; }
    }
    return trail;
  }

  let nextId = 0;
  async function ownedSession(seedStatus: SessionInfo['status'] = 'idle'): Promise<{ id: string; conn: Emitter }> {
    const id = `s-${String(++nextId).padStart(3, '0')}`;
    const conn = fakeConn(codexInfo(id, { status: seedStatus }));
    attachPlans.set(id, () => conn);
    await hub.ensure('codex', id);
    return { id, conn };
  }

  test('F fold determinism after every frame', async () => {
    // ── Lane F — fold determinism after every frame ──────────────────────────────────────────────
    const FOLD_SEQUENCES: { name: string; seed: SessionInfo['status']; steps: Step[] }[] = [
      { name: 'plain turn', seed: 'idle', steps: ['run', 'idle'] },
      { name: 'permission inside the turn', seed: 'idle', steps: ['run', 'perm:p1', 'res:p1', 'idle'] },
      { name: 'permission outlives the status idle', seed: 'idle', steps: ['run', 'perm:p1', 'idle', 'res:p1'] },
      { name: 'request before the running frame', seed: 'idle', steps: ['perm:p1', 'run', 'res:p1', 'idle'] },
      { name: 'question flow', seed: 'idle', steps: ['run', 'q:q1', 'resq:q1', 'idle'] },
      { name: 'orphan resolution is a no-op', seed: 'idle', steps: ['run', 'res:zz', 'idle'] },
      { name: 'duplicate status frames are no-ops', seed: 'idle', steps: ['run', 'run', 'idle', 'idle'] },
      { name: 'duplicate request ids resolve once', seed: 'idle', steps: ['perm:p1', 'perm:p1', 'res:p1', 'res:p1', 'idle'] },
      { name: 'needs-input seed is provisional', seed: 'needs-input', steps: ['run', 'idle'] },
      { name: 'working seed carries the active turn', seed: 'working', steps: ['perm:p1', 'res:p1', 'idle'] },
    ];
    for (const seq of FOLD_SEQUENCES) {
      const { id, conn } = await ownedSession(seq.seed);
      const start = rosterRevision.revision;
      const model = foldSeed(seq.seed);
      let stepwiseOk = true;
      let detail = '';
      for (const step of seq.steps) {
        conn.emit(frameFor(step));
        foldStep(model, step);
        const got = hub.getConn('codex', id)?.status;
        if (got !== foldStatus(model)) {
          stepwiseOk = false;
          detail = `after ${step}: managed=${String(got)} fold=${foldStatus(model)}`;
          break;
        }
      }
      check(`F ${seq.name}: managed status equals the reference fold after every frame`, stepwiseOk, detail);
      const expectedTrail = foldTrail(seq.seed, seq.steps);
      const trail = statusTrail(start, id);
      check(`F ${seq.name}: journaled trail equals the fold's transitions`,
        trail.join('→') === expectedTrail.join('→'),
        `journal=${trail.join('→') || '(none)'} fold=${expectedTrail.join('→') || '(none)'}`);
    }

  });

  test('W watcher-position commutativity', async () => {
    // ── Lane W — watcher-position commutativity ──────────────────────────────────────────────────
    const W_STEPS: Step[] = ['run', 'perm:p1', 'res:p1', 'idle'];
    /** Expected trail with one watcher insertion at `position`: the watcher may add ONLY a truthful
     *  re-publication of the owner's current status, which the collapse absorbs unless it is the
     *  session's first journal row. */
    function expectedTrailWithWatcherAt(position: number): string {
      const s = foldSeed('idle');
      const trail: string[] = [];
      for (let i = 0; i <= W_STEPS.length; i++) {
        if (i === position && trail.at(-1) !== foldStatus(s)) trail.push(foldStatus(s));
        if (i < W_STEPS.length) {
          foldStep(s, W_STEPS[i]!);
          if (trail.at(-1) !== foldStatus(s)) trail.push(foldStatus(s));
        }
      }
      return trail.join('→');
    }
    const watcherVariants: { name: string; status: SessionInfo['status']; attachMode: string }[] = [
      { name: 'observe idle', status: 'idle', attachMode: 'observe' },
      { name: 'observe working', status: 'working', attachMode: 'observe' },
      { name: 'observe needs-input', status: 'needs-input', attachMode: 'observe' },
      { name: 'live idle', status: 'idle', attachMode: 'live' },
      { name: 'live working', status: 'working', attachMode: 'live' },
      { name: 'live needs-input', status: 'needs-input', attachMode: 'live' },
    ];
    for (const variant of watcherVariants) {
      let allOk = true;
      let detail = '';
      for (let position = 0; position <= W_STEPS.length; position++) {
        const { id, conn } = await ownedSession('idle');
        const start = rosterRevision.revision;
        const model = foldSeed('idle');
        for (let i = 0; i <= W_STEPS.length; i++) {
          if (i === position) {
            boundary.submitWatcherSnapshot(codexInfo(id, {
              status: variant.status,
              attachMode: variant.attachMode,
              updatedAt: 99_000,
              control: {
                drive: { supported: true, state: variant.attachMode === 'live' ? 'driving' : 'observing' },
                terminalSync: { supported: true, syncAvailable: true, active: false },
              },
            } as Partial<SessionInfo>));
            await boundary.settle();
            const managed = hub.getConn('codex', id)?.status;
            if (managed !== foldStatus(model)) {
              allOk = false;
              detail = `position ${position}: watcher moved the managed status to ${String(managed)}`;
              break;
            }
          }
          if (i < W_STEPS.length) {
            conn.emit(frameFor(W_STEPS[i]!));
            foldStep(model, W_STEPS[i]!);
          }
        }
        if (!allOk) break;
        const trail = statusTrail(start, id).join('→');
        const expected = expectedTrailWithWatcherAt(position);
        if (trail !== expected) {
          allOk = false;
          detail = `position ${position}: ${trail || '(none)'} vs expected ${expected}`;
          break;
        }
      }
      check(`W a ${variant.name} watcher snapshot at any of ${W_STEPS.length + 1} positions republishes only the owner's current status`,
        allOk, detail);
    }

  });

  test('R replacement seed coherence', async () => {
    // ── Lane R — replacement seed coherence ──────────────────────────────────────────────────────
    {
      const { id, conn } = await ownedSession('idle');
      const start = rosterRevision.revision;
      conn.emit(frameFor('run'));
      const replacement = fakeConn(codexInfo(id, { status: 'working' }));
      attachPlans.set(id, () => replacement);
      hub.getConn('codex', id)!.replaceConnection(replacement);
      const midTrail = statusTrail(start, id);
      check('R replacing the owner with an exact working projection journals no Idle gap',
        !midTrail.includes('idle') && hub.getConn('codex', id)?.status === 'working',
        `trail=${midTrail.join('→')} status=${String(hub.getConn('codex', id)?.status)}`);
      replacement.emit(frameFor('idle'));
      check('R the exact terminal after replacement journals exactly one Idle revision',
        idleRevisions(start, id) === 1 && statusTrail(start, id).at(-1) === 'idle',
        `idleRevisions=${idleRevisions(start, id)} trail=${statusTrail(start, id).join('→')}`);
    }
    {
      const { id, conn } = await ownedSession('idle');
      const start = rosterRevision.revision;
      conn.emit(frameFor('run'));
      const replacement = fakeConn(codexInfo(id, { status: 'needs-input' }));
      attachPlans.set(id, () => replacement);
      hub.getConn('codex', id)!.replaceConnection(replacement);
      check('R a needs-input replacement seed projects Needs input without an Idle gap',
        hub.getConn('codex', id)?.status === 'needs-input' && !statusTrail(start, id).includes('idle'),
        `status=${String(hub.getConn('codex', id)?.status)} trail=${statusTrail(start, id).join('→')}`);
      replacement.emit(frameFor('run'));
      check('R the first authoritative frame clears the provisional seed to Working',
        hub.getConn('codex', id)?.status === 'working' && !statusTrail(start, id).includes('idle'),
        `status=${String(hub.getConn('codex', id)?.status)} trail=${statusTrail(start, id).join('→')}`);
      replacement.emit(frameFor('perm:p9'));
      replacement.emit(frameFor('res:p9'));
      replacement.emit(frameFor('idle'));
      const trail = statusTrail(start, id);
      check('R the full replacement round journals exactly one Idle revision',
        idleRevisions(start, id) === 1 && trail.at(-1) === 'idle',
        `idleRevisions=${idleRevisions(start, id)} trail=${trail.join('→')}`);
    }

  });

  test('E terminal exactly-once under duplicates and orphans', async () => {
    // ── Lane E — terminal exactly-once under duplicates and orphans ──────────────────────────────
    {
      const { id, conn } = await ownedSession('idle');
      const start = rosterRevision.revision;
      for (const step of ['run', 'idle', 'idle', 'res:orphan', 'resq:orphan'] as Step[]) conn.emit(frameFor(step));
      check('E duplicate idle frames and orphan resolutions journal exactly one Idle revision',
        idleRevisions(start, id) === 1 && statusTrail(start, id).join('→') === 'working→idle',
        `idleRevisions=${idleRevisions(start, id)} trail=${statusTrail(start, id).join('→')}`);
    }

  });

  test('R2 a proven replacement retires its predecessor before publication', async () => {
    // ── Lane R2 — a proven replacement retires its predecessor BEFORE publication ───────────────
    // Two owned sessions share ONE exact native id (the adapter-id swap a native runtime's new
    // incarnation produces). The production sequence (runtime.ts): a generation-aware canonical
    // discovery selects the replacement, `Hub.retireSupersededOwners` retires the predecessor, its
    // journal row is removed, and only then is the replacement published through the publication
    // boundary. Reversing that order exposes both logical owners for one revision window and leaves
    // the superseded row actionable.
    {
      const INCARNATION = 'thread-incarnation-shared';
      const OLD = 's-incarnation-old';
      const NEW = 's-incarnation-new';
      const oldConn = fakeConn(codexInfo(OLD, { nativeId: INCARNATION }));
      attachPlans.set(OLD, () => oldConn);
      await hub.ensure('codex', OLD);
      // The predecessor is a live Working owner, journaled — the row the replacement must supersede.
      oldConn.emit(frameFor('run'));
      // The replacement owner exists in the Hub but has emitted nothing, so nothing of it is
      // journaled yet — exactly the position of a discovered-but-unpublished incarnation.
      const newConn = fakeConn(codexInfo(NEW, { nativeId: INCARNATION }));
      attachPlans.set(NEW, () => newConn);
      await hub.ensure('codex', NEW);
      await boundary.settle();
      const start = rosterRevision.revision;

      const replacementInfo = codexInfo(NEW, { nativeId: INCARNATION });
      const canonical = nativeAuthority.reconcile([replacementInfo]);
      const retired = await hub.retireSupersededOwners(canonical);
      check('R2 a proven replacement retires exactly the superseded predecessor owner',
        retired.length === 1 && retired[0]?.id === OLD
        && hub.getConn('codex', OLD) === undefined && hub.getConn('codex', NEW) !== undefined,
        `retired=${JSON.stringify(retired.map((info) => info.id))}`);
      for (const info of retired) rosterRevision.remove(FOLD_MACHINE, info.tool, info.id);
      boundary.publishOwnerFrame(replacementInfo);
      await boundary.settle();

      // Exactly-once: a repeated retirement round over the same canonical replacement retires
      // nothing more and journals no second removal.
      const retiredAgain = await hub.retireSupersededOwners(nativeAuthority.reconcile([replacementInfo]));
      for (const info of retiredAgain) rosterRevision.remove(FOLD_MACHINE, info.tool, info.id);
      const deltas = rosterRevision.eventsAfter(start).deltas;
      const removals = deltas.filter((delta) => delta.sessionId === OLD && delta.removed);
      check('R2 the predecessor retires exactly once — one removal transition, none from a repeated round',
        retiredAgain.length === 0 && removals.length === 1,
        `removals=${removals.length} retiredAgain=${retiredAgain.length}`);

      const removalIndex = deltas.findIndex((delta) => delta.sessionId === OLD && delta.removed);
      const replacementIndex = deltas.findIndex((delta) => delta.sessionId === NEW && !delta.removed);
      check('R2 the roster journal orders the predecessor removal BEFORE the replacement publication',
        removalIndex !== -1 && replacementIndex !== -1 && removalIndex < replacementIndex,
        `removal@${removalIndex} replacement@${replacementIndex}`);

      const current = new Map<string, SessionInfo>();
      for (const delta of rosterRevision.eventsAfter(start).deltas) {
        if (delta.removed) current.delete(delta.sessionId);
        else if (delta.session) current.set(delta.sessionId, delta.session as SessionInfo);
      }
      const visible = [...current.values()].filter((info) => info.nativeId === INCARNATION);
      const liveOwners = hub.liveSnapshot().filter((entry) => entry.info.nativeId === INCARNATION);
      check('R2 exactly one visible current incarnation remains for the shared native id',
        visible.length === 1 && visible[0]?.id === NEW
        && liveOwners.length === 1 && liveOwners[0]?.info.id === NEW,
        `journal=${visible.map((info) => info.id).join(',')} owners=${liveOwners.map((entry) => entry.info.id).join(',')}`);
    }

    await boundary.settle();
  });

  afterAll(async () => {
    await boundary?.settle();
    await hub?.dispose?.();
  });
});
