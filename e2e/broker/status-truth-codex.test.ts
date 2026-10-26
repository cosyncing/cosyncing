/**
 * Codex run-state authority: when a Codex session is Working, and when it may stop being.
 *
 * Codex's turn lives in three places at once, and the broker weighs them: the shared app-server
 * daemon (turn notifications, `thread/read`, `thread/turns/list`), the durable rollout, and
 * terminals. A real broker runs against {@link CodexAppServer}: the daemon in this process on a
 * unix socket (every RPC the broker made is in its ledger), rollouts in the fixture's
 * `CODEX_HOME`, and terminals in a fake `/proc` root. The Codex watcher polls at its fastest
 * (250 ms), so "within one watcher interval" is a short wait, and "it did not happen" is proved by
 * the broker's own later repair reads (`thread/read` with turns) or watcher polls.
 *
 * Two kinds of owner, two rules:
 *   - a live owner (the daemon holds the thread) admits a turn on any exact evidence and retires it
 *     only on a terminal for that exact turn (native, a later native page, or the rollout);
 *   - an Observe owner (the daemon does not drive it) holds an open turn while any owner may still
 *     be writing it, and retires once every owner is provably gone.
 *
 * Unix sockets, a fake `/proc` and Codex terminal sync are Linux and macOS only (Windows has no
 * Codex sync); terminal presence through `/proc` is Linux only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeSync, openSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Broker,
  type BrokerClient,
  eventually,
  type Frame,
  type SessionStream,
  startBroker,
} from '../harness/index.ts';
import {
  CodexAppServer,
  codexComplete,
  codexRecord,
  type CodexRollout,
  codexStart,
  codexToolCall,
  type ThreadModel,
} from '../harness/fakes/codex-app-server.ts';
import { RosterFeed } from '../harness/roster.ts';

const posix = process.platform !== 'win32';
const linux = process.platform === 'linux';

let serial = 0;
/** A fresh thread id (Codex thread ids are UUIDs; terminals name them in argv). */
const thread = (): string => `019fc900-0000-7000-8000-${(++serial).toString(16).padStart(12, '0')}`;
const at = (second: number): string => `2026-08-03T00:00:${String(second).padStart(2, '0')}.000Z`;

/**
 * The run states a stream was shown, in order, a repeat of the current one collapsed. A `session`
 * frame carries the whole SessionInfo and is re-sent whenever any of it moves, not only the status:
 * the roster reconcile re-publishes an attached session's title and control state on its own
 * schedule (every discovery pass), and when that lands during the attach it is queued behind
 * `history`. A repeated status is no transition, and when it arrives is not this file's claim.
 */
const sessionStatuses = (stream: SessionStream): string[] =>
  stream.frames
    .filter((frame) => frame.kind === 'session')
    .map((frame) => String(frame.info?.status))
    .filter((status, index, all) => index === 0 || status !== all[index - 1]);
const liveMessages = (stream: SessionStream): any[] =>
  stream.frames.filter((frame) => frame.kind === 'message').map((frame) => frame.message);
const footers = (stream: SessionStream, turnId: string, terminal: boolean): any[] =>
  liveMessages(stream).filter((message) => message.type === 'run-summary' && message.turnId === turnId
    && (terminal ? message.status !== 'running' : message.status === 'running'));

function settlesTo(stream: SessionStream, status: string, what?: string): Promise<Frame> {
  return stream.waitForFrame(() => sessionStatuses(stream).at(-1) === status, { what: what ?? `the session to settle on ${status}` });
}

/**
 * Wait for a turn's footer (`terminal`: its closing one, else its opening one). A footer is its own
 * frame and follows the session frame that moves the run state, so a settled status does not mean
 * the footer has arrived yet.
 */
function footerArrives(stream: SessionStream, turnId: string, terminal: boolean): Promise<any[]> {
  return eventually(() => footers(stream, turnId, terminal).length > 0 && footers(stream, turnId, terminal), {
    what: `the ${terminal ? 'closing' : 'opening'} footer of ${turnId}`,
  });
}

describe.skipIf(!posix)('Codex run state', () => {
  let broker: Broker;
  let client: BrokerClient;
  let codex: CodexAppServer;
  /** Loaded and Working before the broker starts: what its watcher's first poll sees. */
  const firstPoll = { thread: thread(), rollout: undefined as CodexRollout | undefined };

  beforeAll(async () => {
    broker = await startBroker({
      name: 'status-codex',
      setup: async (paths) => {
        codex = await CodexAppServer.start(paths);
        firstPoll.rollout = codex.writeRollout(firstPoll.thread, [codexStart('turn-first-poll')]);
        codex.thread(firstPoll.thread, {
          loaded: true,
          status: 'active',
          turns: [{ id: 'turn-first-poll', status: 'inProgress', startedAt: at(1) }],
        });
      },
      env: () => ({
        ...codex.env,
        COSYNCING_MACHINE: 'status-codex',
        COSYNCING_ROSTER_SAFETY_RECONCILE_MS: '3600000',
      }),
    });
    client = broker.client();
  });
  afterAll(async () => {
    client?.closeAll();
    await broker?.stop();
    await codex?.stop();
  });

  /** Wait for `count` more watcher polls: a sentinel that every poll-driven check has run. */
  async function watcherPolls(count: number): Promise<void> {
    const mark = codex.mark;
    await eventually(() => codex.polls(mark) >= count, { what: `${count} watcher polls` });
  }

  /** Wait for `count` more repair reads of one thread. */
  async function repairRounds(threadId: string, count: number): Promise<void> {
    const mark = codex.mark;
    await eventually(() => codex.repairReads(threadId, mark) >= count, { what: `${count} repair reads of ${threadId}` });
  }

  /**
   * Make the daemon hold `ids` (each with `change`), and wait until the broker's view of the loaded
   * set has caught up: two complete watcher polls (each asks `thread/loaded/list` twice), so the
   * short-lived loaded-thread cache an attach consults includes them.
   */
  async function hold(ids: string | string[], change: Partial<ThreadModel> = {}): Promise<void> {
    for (const id of [ids].flat()) codex.thread(id, { loaded: true, ...change });
    await watcherPolls(4);
  }

  async function rosterRow(threadId: string): Promise<any> {
    return (await client.sessions({ refresh: true })).find((row) => row.nativeId === threadId);
  }

  async function open(rollout: CodexRollout, options: { readOnly?: boolean; mode?: string } = {}): Promise<SessionStream> {
    const stream = await client.attach('codex', rollout.id, options);
    await stream.waitForKind('history');
    return stream;
  }

  test('a client that only follows the delta feed learns a daemon-held session is Working, without a snapshot or an owner', async () => {
    const feed = new RosterFeed(client);
    const batch = await feed.request(0);
    expect(batch.resetRequired).toBeUndefined();
    const row = batch.deltas.filter((delta) => delta.sessionId === firstPoll.rollout!.id).at(-1);
    expect(row?.session?.status).toBe('working');

    // The same holds for a thread the daemon picks up later.
    await feed.start();
    const later = thread();
    const rollout = codex.writeRollout(later, [codexStart('turn-later')]);
    codex.thread(later, { loaded: true, status: 'active', turns: [{ id: 'turn-later', status: 'inProgress', startedAt: at(1) }] });
    await feed.waitFor((delta) => delta.sessionId === rollout.id && delta.session?.status === 'working');
  });

  test('an Observe attach seeds Working from an unmatched start, and Idle from a matched terminal or a settings-only record', async () => {
    const seeds = [
      { name: 'unmatched start', records: [codexStart('turn-open')], status: 'working' },
      { name: 'matched terminal', records: [codexStart('turn-done'), codexComplete('turn-done')], status: 'idle' },
      {
        name: 'turn_context only',
        records: [codexRecord('turn_context', { turn_id: 'turn-context', model: 'fake' })],
        status: 'idle',
      },
    ];
    const rollouts = seeds.map((seed) => codex.writeRollout(thread(), seed.records));
    // Daemon-held with no readable activity: only the rollout speaks for the turn.
    await hold(rollouts.map((rollout) => rollout.threadId), { status: 'unknown' });
    const seen: Record<string, string[]> = {};
    for (const [index, seed] of seeds.entries()) {
      const stream = await open(rollouts[index]!, { readOnly: true });
      seen[seed.name] = sessionStatuses(stream);
      stream.close();
    }
    expect(seen).toEqual(Object.fromEntries(seeds.map((seed) => [seed.name, [seed.status]])));
  });

  test('Guardian reviews and spawned subagents stream their work without attention events; the parent still notifies', async () => {
    const parent = thread();
    const parentRollout = codex.writeRollout(parent);
    const children = [false, true].map((guardian) => {
      const id = thread();
      return codex.writeRollout(id, [], { parent, guardian });
    });
    await hold([parent, ...children.map((child) => child.threadId)], { status: 'unknown' });

    for (const child of children) {
      expect(await rosterRow(child.threadId)).toMatchObject({ origin: 'subagent', parentThreadId: parent });
      const stream = await open(child, { readOnly: true });
      const turnId = `turn-${child.threadId}`;
      const goal = (status: string) => codexRecord('event_msg', {
        type: 'thread_goal_updated',
        goal: { threadId: child.threadId, objective: 'Internal review', status, createdAt: at(1) },
      });
      child.append(codexStart(turnId), goal('active'));
      await footerArrives(stream, turnId, false);
      await stream.waitForMessage((message) => message.type === 'goal-state' && message.status === 'active');
      child.append(codexComplete(turnId), goal('completed'));
      await footerArrives(stream, turnId, true);
      await stream.waitForMessage((message) => message.type === 'goal-state' && message.status === 'done');
      stream.close();
    }

    // A later parent outcome is a barrier through the broker's ordered attention queue.
    // It proves silence for fully processed child turns, without a timed absence check.
    const parentStream = await open(parentRollout, { readOnly: true });
    parentRollout.append(codexStart('turn-parent'), codexComplete('turn-parent'));
    await footerArrives(parentStream, 'turn-parent', true);
    const events = await eventually(async () => {
      const response = await client.get('/api/attention-events?clientId=subagent-check&limit=200');
      expect(response.status).toBe(200);
      return response.body.events.some((event: any) => event.sessionId === parentRollout.id && event.kind === 'run-finished')
        ? response.body.events : undefined;
    }, { what: 'the parent completion notification' });
    expect(events.filter((event: any) => children.some((child) => child.id === event.sessionId))).toEqual([]);
    parentStream.close();
  });

  test('a stale rollout qualification (same size and mtime) cannot seed Idle over a start already on disk, and the tail still streams', async () => {
    const id = thread();
    const start = `${JSON.stringify(codexStart('turn-seed-race'))}\n`;
    // A filler line of exactly the record's length (`{"filler":"…"}` plus newline is 14 bytes plus
    // the run), so writing the record over it keeps the size.
    const rollout = codex.writeRollout(id, [{ filler: '#'.repeat(start.length - 14) }]);
    await hold(id, { status: 'unknown' });
    /** Whole seconds, so the mtime round-trips exactly. */
    const frozen = 1_785_500_000;
    utimesSync(rollout.path, frozen, frozen);
    const before = statSync(rollout.path);
    // Discovery qualifies the row (and memoizes it by size and mtime) while it has no open turn.
    expect((await rosterRow(id))?.status).toBe('idle');

    const offset = before.size - start.length;
    const fd = openSync(rollout.path, 'r+');
    try {
      writeSync(fd, start, offset);
    } finally {
      closeSync(fd);
    }
    utimesSync(rollout.path, frozen, frozen);
    const after = statSync(rollout.path);
    expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({ size: before.size, mtimeMs: before.mtimeMs });

    const stream = await open(rollout, { readOnly: true });
    expect(sessionStatuses(stream)).toEqual(['working']);
    rollout.append(codexToolCall('call-after-baseline'));
    await stream.waitForMessage((message) => message.type === 'tool-call');
    stream.close();
  });

  test('a daemon that has just gone active seeds Working even when its last reading said idle', async () => {
    const idle = thread();
    const racing = thread();
    const idleRollout = codex.writeRollout(idle, [codexStart('turn-stale')]);
    const rollout = codex.writeRollout(racing, [codexStart('turn-race')]);
    await hold([idle, racing], { status: 'idle' });
    // An exact native idle that is current still retires a start the rollout never closed.
    const quiet = await open(idleRollout, { readOnly: true });
    expect(sessionStatuses(quiet)).toEqual(['idle']);
    quiet.close();

    await eventually(async () => (await rosterRow(racing))?.status === 'idle', { what: 'the idle reading to be cached' });
    codex.thread(racing, { status: 'active', turns: [{ id: 'turn-race', status: 'inProgress', startedAt: at(1) }] });
    const stream = await open(rollout, { readOnly: true });
    expect(sessionStatuses(stream)).toEqual(['working']);
    stream.close();
  });

  test('a live owner that missed a turn start repairs to Working on the open session, the delta feed and a fresh roster', async () => {
    const id = thread();
    const rollout = codex.writeRollout(id);
    await hold(id, { status: 'idle' });
    const stream = await open(rollout);
    expect(sessionStatuses(stream)).toEqual(['idle']);
    expect(stream.frames.find((frame) => frame.kind === 'session')?.info.attachMode).toBe('live');
    const feed = new RosterFeed(client);
    await feed.start();

    // The turn starts with no `turn/started` notification: only the rollout and `thread/read` know.
    rollout.append(codexStart('turn-missed'));
    codex.thread(id, { status: 'active', turns: [{ id: 'turn-missed', status: 'inProgress', startedAt: at(1) }] });
    await settlesTo(stream, 'working');
    await feed.waitFor((delta) => delta.sessionId === rollout.id && delta.session?.status === 'working');
    expect((await rosterRow(id))?.status).toBe('working');
    // A repaired start is a real turn boundary: it opens the turn's footer.
    await footerArrives(stream, 'turn-missed', false);
    expect(footers(stream, 'turn-missed', false)).toHaveLength(1);
    stream.close();
  });

  test('a live owner retires a turn only on its own terminal: a newer turn re-points it, a bare idle holds it, the terminal ends it once', async () => {
    const id = thread();
    const rollout = codex.writeRollout(id);
    await hold(id, { status: 'idle' });
    const stream = await open(rollout);
    codex.notify('turn/started', { threadId: id, turn: { id: 'turn-1' } });
    await settlesTo(stream, 'working');
    await stream.waitForMessage((message) => message.type === 'run-summary' && message.turnId === 'turn-1');

    // The daemon names a newer turn in progress: the one the owner held is over.
    codex.thread(id, {
      status: 'idle',
      turns: [
        { id: 'turn-1', status: 'completed', completedAt: at(5) },
        { id: 'turn-2', status: 'inProgress', startedAt: at(6) },
      ],
    });
    await eventually(() => footers(stream, 'turn-1', true).length === 1 && footers(stream, 'turn-2', false).length === 1, {
      what: 'turn-1 closed and turn-2 opened',
    });

    // An exact idle that does not account for turn-2 cannot retire it.
    codex.thread(id, { status: 'idle', turns: [] });
    await repairRounds(id, 3);
    expect(sessionStatuses(stream).at(-1)).toBe('working');
    expect(footers(stream, 'turn-2', true)).toEqual([]);

    codex.thread(id, { status: 'idle', turns: [{ id: 'turn-2', status: 'completed', completedAt: at(12) }] });
    await settlesTo(stream, 'idle');
    // Another contradiction (the daemon reads active again) runs more repair rounds: none adds a footer.
    codex.thread(id, { status: 'active', turns: [{ id: 'turn-2', status: 'completed', completedAt: at(12) }] });
    await repairRounds(id, 3);
    expect(footers(stream, 'turn-1', true)).toHaveLength(1);
    expect(footers(stream, 'turn-2', true)).toHaveLength(1);
    // The turn was Working from its start to its terminal, and no contradiction revived it.
    expect(new Set(sessionStatuses(stream).slice(sessionStatuses(stream).indexOf('idle', 1)))).toEqual(new Set(['idle']));
    codex.thread(id, { status: 'idle' });
    stream.close();
  });

  test('a terminal on a later native page, a failed turn\'s error and the rollout\'s own terminal each retire a turn; a live frame fences a stale page', async () => {
    const id = thread();
    const rollout = codex.writeRollout(id);
    await hold(id, { status: 'idle' });
    const stream = await open(rollout);

    // The terminal is past `thread/read` and the first page of `thread/turns/list`.
    codex.notify('turn/started', { threadId: id, turn: { id: 'turn-paged' } });
    await settlesTo(stream, 'working');
    codex.thread(id, {
      status: 'idle',
      turns: [],
      turnsList: (params) => params?.cursor === 'page-2'
        ? { data: [{ id: 'turn-paged', status: 'failed', error: 'paged native failure', completedAt: at(14) }], nextCursor: null }
        : { data: Array.from({ length: 100 }, (_, index) => ({ id: `older-${index}`, status: 'completed' })), nextCursor: 'page-2' },
    });
    await settlesTo(stream, 'idle');
    await footerArrives(stream, 'turn-paged', true);
    expect(footers(stream, 'turn-paged', true).map((footer) => footer.status)).toEqual(['error']);
    expect(liveMessages(stream).some((message) => message.type === 'error' && message.message === 'paged native failure')).toBe(true);

    // The native history no longer reaches the turn; the rollout records its terminal.
    codex.thread(id, { turnsList: undefined });
    codex.notify('turn/started', { threadId: id, turn: { id: 'turn-rollout' } });
    await settlesTo(stream, 'working');
    rollout.append(codexStart('turn-rollout'), codexComplete('turn-rollout'));
    await settlesTo(stream, 'idle');
    await footerArrives(stream, 'turn-rollout', true);
    expect(footers(stream, 'turn-rollout', true)).toHaveLength(1);

    // A repair holding a page while a newer turn starts live must not retire that newer turn.
    codex.notify('turn/started', { threadId: id, turn: { id: 'turn-race-old' } });
    await settlesTo(stream, 'working');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const mark = codex.mark;
    codex.thread(id, {
      turnsList: async () => {
        await held;
        return { data: [{ id: 'turn-race-old', status: 'completed' }], nextCursor: null };
      },
    });
    await eventually(() => codex.calls('thread/turns/list', mark).some((call) => call.params?.threadId === id), {
      what: 'the repair to ask for a turns page',
    });
    codex.notify('turn/started', { threadId: id, turn: { id: 'turn-race-new' } });
    await stream.waitForMessage((message) => message.type === 'run-summary' && message.turnId === 'turn-race-new');
    release();
    await repairRounds(id, 3);
    expect(sessionStatuses(stream).at(-1)).toBe('working');
    expect(footers(stream, 'turn-race-old', true)).toEqual([]);
    // Every repair since closed nothing a second time.
    expect(footers(stream, 'turn-paged', true)).toHaveLength(1);
    expect(footers(stream, 'turn-rollout', true)).toHaveLength(1);
    codex.thread(id, { turnsList: undefined, turns: [{ id: 'turn-race-new', status: 'completed', completedAt: at(30) }] });
    await settlesTo(stream, 'idle');
    stream.close();
  });

  test('an idle the adapter reaches on its own, with no status frame, still reaches the open session and the roster', async () => {
    const id = thread();
    const rollout = codex.writeRollout(id);
    // The activity probe reads no status (so the watcher hands over no contradiction); only a
    // turns read says idle.
    await hold(id, {
      status: 'unknown',
      read: (params) => params?.includeTurns
        ? { thread: { id, status: { type: 'idle' }, turns: [] } }
        : { thread: { id } },
    });
    const stream = await open(rollout);
    expect(sessionStatuses(stream)).toEqual(['idle']);
    const feed = new RosterFeed(client);
    await feed.start();
    codex.notify('thread/status/changed', { threadId: id, status: { type: 'active', activeFlags: [] } });
    await feed.waitFor((delta) => delta.sessionId === rollout.id && delta.session?.status === 'idle');
    await stream.waitForFrame(() => sessionStatuses(stream).join() === 'idle,working,idle', {
      what: 'Working, then the silent native idle, on the stream',
    });
    // The adapter said `running` and never said `idle`: the session frame is the only carrier.
    expect(liveMessages(stream).filter((message) => message.type === 'status').map((message) => message.status)).toEqual(['running']);
    expect(feed.of(rollout.id).at(-1)?.session?.status).toBe('idle');
    expect((await rosterRow(id))?.status).toBe('idle');
    stream.close();
  });

  test('a non-blocking question leaves the run state alone and is still replayed to a late joiner', async () => {
    const id = thread();
    const rollout = codex.writeRollout(id);
    await hold(id, { status: 'idle' });
    const stream = await open(rollout);
    let marker = 0;
    const tokens = async (target: SessionStream): Promise<void> => {
      const value = ++marker * 1_000;
      codex.notify('thread/tokenUsage/updated', { threadId: id, tokenUsage: { total: { inputTokens: value, outputTokens: 0, cachedInputTokens: 0 } } });
      await target.waitForMessage((message) => message.type === 'token-count' && message.input === value);
    };
    const ask = (itemId: string, turnId: string) => codex.notify('item/completed', {
      threadId: id,
      turnId,
      item: { type: 'agentMessage', id: itemId, delivery: 'async', text: 'Which colour first?', questions: [{ title: 'Which colour first?', options: ['Crimson', 'Teal'] }] },
    });

    ask('call-async-idle', 'turn-q0');
    const card = await stream.waitForMessage((message) => message.type === 'question-request');
    expect(card).toMatchObject({ requestId: 'codex:aq:call-async-idle', blocking: false });
    await tokens(stream);
    expect(sessionStatuses(stream)).toEqual(['idle']);

    codex.notify('turn/started', { threadId: id, turn: { id: 'turn-q1' } });
    await settlesTo(stream, 'working');
    ask('call-async-working', 'turn-q1');
    await stream.waitForMessage((message) => message.requestId === 'codex:aq:call-async-working');
    await tokens(stream);
    expect(sessionStatuses(stream)).toEqual(['idle', 'working']);

    const late = await open(rollout);
    await tokens(late);
    expect(sessionStatuses(late)).toEqual(['working']);
    expect(liveMessages(late).filter((message) => message.type === 'question-request').map((message) => message.requestId).sort())
      .toEqual(['codex:aq:call-async-idle', 'codex:aq:call-async-working']);
    late.close();
    stream.close();
  });

  test.skipIf(!linux)('an Observe subagent holds its open turn while the parent\'s terminal runs, though the daemon reads idle, and retires once it exits', async () => {
    const parent = thread();
    const child = thread();
    codex.writeRollout(parent);
    const rollout = codex.writeRollout(child, [codexStart('turn-child')], { parent });
    codex.thread(parent, { loaded: true, status: 'idle' });
    codex.thread(child, { loaded: true, status: 'idle' });
    const exit = codex.terminal(parent);
    await eventually(async () => (await rosterRow(parent))?.control?.terminalSync?.presence === 'shared', {
      what: 'the parent terminal to be seen',
    });
    const stream = await open(rollout);
    expect(stream.frames.find((frame) => frame.kind === 'session')?.info.attachMode).toBe('observe');
    expect(sessionStatuses(stream)).toEqual(['working']);
    // Every poll hands the owner the daemon's idle; the present terminal outranks it each time.
    await watcherPolls(8);
    expect(sessionStatuses(stream).filter((status) => status !== 'working')).toEqual([]);

    exit();
    await settlesTo(stream, 'idle', 'the subagent to retire once no owner is left');
    stream.close();
  });

  test.skipIf(!linux)('an Observe owner holds a turn a private terminal is running, though the daemon reads idle, and retires once it exits', async () => {
    const id = thread();
    codex.thread(id, { loaded: true, status: 'idle' });
    const rollout = codex.writeRollout(id, [codexStart('turn-private')]);
    const exit = codex.terminal(id, { private: true });
    await eventually(async () => (await rosterRow(id))?.control?.terminalSync?.presence === 'private', {
      what: 'the private terminal to be seen',
    });
    const stream = await open(rollout, { readOnly: true });
    expect(sessionStatuses(stream)).toEqual(['working']);
    await watcherPolls(8);
    rollout.append(codexToolCall('call-quiet'));
    await stream.waitForMessage((message) => message.type === 'tool-call');
    await watcherPolls(4);
    expect(sessionStatuses(stream).filter((status) => status !== 'working')).toEqual([]);

    exit();
    await settlesTo(stream, 'idle', 'the turn to retire once no owner is left');
    stream.close();
  });

  // The daemon speaks only for threads it holds. For any other thread the watcher's own terminal
  // scan is the evidence: once no terminal names the thread, the attached Observe owner is asked to
  // re-derive, and owner absence retires the turn while the client stays attached.
  test.skipIf(!linux)('an Observe owner of a thread the daemon does not hold retires a turn whose terminal died', async () => {
    const id = thread();
    const rollout = codex.writeRollout(id, [codexStart('turn-orphaned')]);
    const exit = codex.terminal(id, { private: true });
    await eventually(async () => (await rosterRow(id))?.control?.terminalSync?.presence === 'private', {
      what: 'the private terminal to be seen',
    });
    const stream = await open(rollout);
    expect(sessionStatuses(stream)).toEqual(['working']);
    exit();
    await eventually(async () => (await rosterRow(id))?.control?.terminalSync?.presence === 'absent', {
      what: 'the terminal to be gone',
    });
    // Rule (b) retires within two corroborating rounds; give it many watcher polls.
    await watcherPolls(12);
    expect(sessionStatuses(stream).at(-1)).toBe('idle');
  });

  test.skipIf(!linux)('an Observe owner becomes the live owner when a terminal joins a daemon-held thread', async () => {
    const id = thread();
    const rollout = codex.writeRollout(id);
    await hold(id, { status: 'idle' });
    const stream = await open(rollout, { readOnly: true });
    const first = stream.frames.find((frame) => frame.kind === 'session')!;
    expect(first.info.attachMode).toBe('observe');
    const exit = codex.terminal(id);
    await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info.attachMode === 'live'
      && frame.info.control?.terminalSync?.active === true, { what: 'the owner to be replaced by the synced live one' });
    const sessions = stream.frames.filter((frame) => frame.kind === 'session');
    expect(sessions.map((frame) => frame.info.attachMode)).toEqual(['observe', ...sessions.slice(1).map(() => 'live')]);
    expect(sessions.at(-1)!.info.control.terminalSync).toMatchObject({ active: true, presence: 'shared' });
    expect(new Set(sessionStatuses(stream))).toEqual(new Set(['idle']));
    exit();
    stream.close();
  });

  // Discovery describes the session's BEST owner: a daemon-held thread with no terminal reads
  // `live` and `driving`. An Observe connection opened beside that owner is still a read-only tail;
  // a discovery pass may refresh what discovery knows (title, presence), never the connection's own
  // class or Drive state, and a pass that changes nothing about the connection sends nothing.
  test('an Observe owner beside a live owner keeps its own authority, and a discovery pass that changes nothing sends nothing', async () => {
    const id = thread();
    const rollout = codex.writeRollout(id);
    await hold(id, { status: 'idle' });
    const observer = await open(rollout, { mode: 'observe' });
    const driver = await open(rollout, { mode: 'live' });
    await driver.waitForFrame((frame) => frame.kind === 'session' && frame.authority?.canMutate === true, {
      what: 'the live owner to be Driving',
    });

    // Three discovery passes re-derive the row, and each is reconciled onto the open owners of the
    // session, one after another. The first (a turn starts on the daemon) carries discovery's own
    // native rename for the row: seeing it is seeing that pass arrive. Attach and discovery
    // initially resolve the same title, so an invented fallback difference cannot mark this pass.
    const attachedTitle = observer.ofKind('session')[0]!.info.title;
    writeFileSync(join(codex.codexHome, 'session_index.jsonl'), `${JSON.stringify({ id, thread_name: 'discovery beside' })}\n`);
    codex.thread(id, { status: 'active', turns: [{ id: 'turn-beside', status: 'inProgress', startedAt: at(1) }] });
    const discovered = await observer.waitForFrame((frame) => frame.kind === 'session' && frame.info.title !== attachedTitle, {
      what: 'the first discovery pass to reach the Observe owner',
    });
    expect(discovered.info.title).toBe((await rosterRow(id))?.title);
    expect(discovered.info.title).toBe('discovery beside');
    // The second (the turn ends) changes nothing the Observe owner holds: its run state is its own.
    codex.thread(id, { status: 'idle', turns: [{ id: 'turn-beside', status: 'completed', startedAt: at(1), completedAt: at(2) }] });
    await watcherPolls(4);
    // The third renames the thread; reconciles are serialized per session, so its title arriving
    // means the second pass has been reconciled too.
    writeFileSync(join(codex.codexHome, 'session_index.jsonl'), `${JSON.stringify({ id, thread_name: 'renamed beside' })}\n`);
    codex.thread(id, { status: 'active', turns: [{ id: 'turn-beside-2', status: 'inProgress', startedAt: at(3) }] });
    await observer.waitForFrame((frame) => frame.kind === 'session' && frame.info.title === 'renamed beside', {
      what: 'the third discovery pass to reach the Observe owner',
    });
    expect((await rosterRow(id))?.control?.drive?.state).toBe('driving');

    // The Observe owner's own Drive state is whatever it was opened with (this fixture has no Codex
    // CLI, so it cannot offer Drive); it is never the live owner's `driving`.
    const sessions = observer.ofKind('session');
    const own = sessions[0]!.info.control?.drive?.state;
    expect(own).not.toBe('driving');
    expect(sessions.map((frame) => ({
      attachMode: frame.info.attachMode,
      drive: frame.info.control?.drive?.state,
      canMutate: frame.authority?.canMutate,
    }))).toEqual(sessions.map(() => ({ attachMode: 'observe', drive: own, canMutate: false })));
    const repeats = sessions.filter((frame, index) => index > 0 && JSON.stringify(frame) === JSON.stringify(sessions[index - 1]));
    expect(repeats).toEqual([]);

    // A mode-less attach joins the live owner, not the Observe tail, and its prompt reaches the daemon
    // (once the live owner has closed the daemon's turn, so the prompt is not queued behind it).
    await footerArrives(driver, 'turn-beside-2', false);
    codex.thread(id, { status: 'idle', turns: [{ id: 'turn-beside-2', status: 'completed', startedAt: at(3), completedAt: at(4) }] });
    await footerArrives(driver, 'turn-beside-2', true);
    await settlesTo(driver, 'idle');
    const mark = codex.mark;
    const joined = await open(rollout);
    expect(joined.ofKind('session').at(-1)?.authority).toEqual({ canMutate: true, prompt: 'full' });
    expect((await joined.sendAndAwait({ kind: 'prompt', text: 'beside an observer' })).kind).toBe('ack');
    const started = await eventually(() => codex.calls('turn/start', mark).length > 0 && codex.calls('turn/start', mark), {
      what: 'the prompt to reach the daemon',
    });
    expect(started.map((call) => call.params?.threadId)).toEqual([id]);
    for (const stream of [joined, driver, observer]) stream.close();
  });

  test('after a broker restart, sessions mid-turn come back Working (main and subagent) and a finished one stays Idle', async () => {
    const main = thread();
    const child = thread();
    const done = thread();
    const live = thread();
    const rollouts = {
      main: codex.writeRollout(main, [codexStart('turn-main')]),
      child: codex.writeRollout(child, [codexStart('turn-child')], { parent: main }),
      done: codex.writeRollout(done, [codexStart('turn-done'), codexComplete('turn-done')]),
      live: codex.writeRollout(live),
    };
    for (const id of [main, child, done]) codex.thread(id, { loaded: true, status: 'unknown' });
    await hold(live, { status: 'idle' });
    const stream = await open(rollouts.live);
    codex.notify('turn/started', { threadId: live, turn: { id: 'turn-live' } });
    rollouts.live.append(codexStart('turn-live'));
    codex.thread(live, { status: 'active', turns: [{ id: 'turn-live', status: 'inProgress', startedAt: at(1) }] });
    await settlesTo(stream, 'working');

    client.closeAll();
    await broker.restart();
    const rows = await client.sessions({ refresh: true });
    const status = (id: string) => rows.find((row) => row.nativeId === id)?.status;
    expect({ main: status(main), child: status(child), done: status(done), live: status(live) })
      .toEqual({ main: 'working', child: 'working', done: 'idle', live: 'working' });
    for (const [name, rollout] of Object.entries(rollouts)) {
      const reopened = await open(rollout, { readOnly: true });
      expect({ name, statuses: sessionStatuses(reopened) }).toEqual({ name, statuses: [name === 'done' ? 'idle' : 'working'] });
      reopened.close();
    }
  });
});
