/**
 * OpenCode without a serve: a bare `opencode` TUI keeps its own private server, so the broker finds its
 * sessions only on disk, opens them read-only (Observe), and drives one only when the app asks to
 * (`mode=resume`), by running `opencode run --format json` as a child that persists its turn.
 *
 * Run once for each store layout the adapter reads: the sqlite `opencode.db` of current builds and the
 * older `storage/**.json` tree. The fake `opencode` binary (`kits/fakes/opencode-cli.ts`) is the only
 * OpenCode here. `OPENCODE_URL` names a leased loopback port nothing listens on, so a missing serve
 * can never fall through to 4096.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { reserveLoopbackFixturePort } from '../../packages/typescript/broker/test/helpers/isolated-broker-fixture.ts';
import { type Broker, type BrokerClient, eventually, type SessionStream, startBroker } from '../harness/index.ts';
import { type FakeOpencodeCliConfig, OpencodeStore, type StoreLayout } from './kits/fakes/opencode-cli.ts';
import { installFakeExecutable, Ledger, treeSnapshot } from './kits/kit.ts';

type Json = Record<string, any>;

const textOf = (message: any): string | undefined =>
  typeof message?.text === 'string' ? message.text : typeof message?.delta === 'string' ? message.delta : undefined;
const userTexts = (messages: any[]): string[] => messages.filter((message) => message.type === 'user-message').map(textOf) as string[];
const tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } };

describe.each(['sqlite', 'json'] as StoreLayout[])('OpenCode without a serve, %s store', (layout) => {
  let broker: Broker;
  let client: BrokerClient;
  let store: OpencodeStore;
  let ledger: Ledger;
  let controlDir: string;
  let workspace: string;
  const ids = {
    main: 'ses_private_main',
    child: 'ses_private_child',
    working: 'ses_private_working',
    stale: 'ses_private_stale',
    reverted: 'ses_private_reverted',
    todo: 'ses_private_todo',
    drive: 'ses_private_drive',
  };

  /** A session with `turns` finished exchanges, oldest first, ending `endedAgo` ms ago. */
  function seed(id: string, title: string, options: { turns?: number; endedAgo?: number; parentID?: string } = {}): number {
    const turns = options.turns ?? 1;
    const end = Date.now() - (options.endedAgo ?? 60_000);
    const start = end - turns * 10;
    store.putSession({ id, directory: workspace, title, created: start, updated: end, ...(options.parentID ? { parentID: options.parentID } : {}), model: { providerID: 'test-provider', modelID: 'model-a' } });
    for (let turn = 1; turn <= turns; turn += 1) {
      const at = start + turn * 10;
      store.putMessage(id, { id: `msg_${id}_${turn}_u`, role: 'user', time: { created: at } });
      store.putPart(id, `msg_${id}_${turn}_u`, { id: `prt_${id}_${turn}_u`, type: 'text', text: `seeded prompt ${turn}` });
      store.putMessage(id, {
        id: `msg_${id}_${turn}_a`, role: 'assistant', parentID: `msg_${id}_${turn}_u`, time: { created: at + 1, completed: at + 2 }, finish: 'stop', tokens, cost: 0.01,
      });
      store.putPart(id, `msg_${id}_${turn}_a`, { id: `prt_${id}_${turn}_a`, type: 'text', text: `seeded answer ${turn}`, time: { start: at + 1, end: at + 2 } });
    }
    return end;
  }

  /** An assistant row that never finished, after the session's last finished turn. */
  function unfinishedTurn(id: string, startedAgo: number, extra: Json = {}): string {
    const at = Date.now() - startedAgo;
    store.putMessage(id, { id: `msg_${id}_open_u`, role: 'user', time: { created: at } });
    store.putPart(id, `msg_${id}_open_u`, { id: `prt_${id}_open_u`, type: 'text', text: 'a turn that never finished' });
    store.putMessage(id, { id: `msg_${id}_open_a`, role: 'assistant', parentID: `msg_${id}_open_u`, time: { created: at + 1 }, ...extra });
    store.putPart(id, `msg_${id}_open_a`, { id: `prt_${id}_open_a`, type: 'text', text: 'still typing', time: { start: at + 1 } });
    store.touchSession(id, at + 1);
    return `msg_${id}_open_u`;
  }

  beforeAll(async () => {
    const lease = await reserveLoopbackFixturePort();
    await lease.release();
    broker = await startBroker({
      name: `opencode-private-${layout}`,
      token: true,
      setup: (paths) => {
        workspace = join(paths.root, 'workspaces', 'private');
        mkdirSync(workspace, { recursive: true });
        const dataDir = join(paths.root, 'opencode-data');
        // The adapter decides at startup whether local storage exists, so the store is made first.
        store = new OpencodeStore(dataDir, layout);
        const installRoot = join(paths.root, 'fakes', 'opencode');
        controlDir = join(installRoot, 'control');
        mkdirSync(controlDir, { recursive: true });
        ledger = new Ledger(join(installRoot, 'ledger.jsonl'));
        const config: FakeOpencodeCliConfig = { ledger: ledger.path, controlDir, version: '1.17.19', store: { dataDir, layout } };
        installFakeExecutable(paths.bin, 'opencode', 'opencode-cli.ts', config);
        seed(ids.main, 'Private main', { turns: 2 });
        seed(ids.child, 'Private child', { parentID: ids.main });
        seed(ids.working, 'Private working');
        unfinishedTurn(ids.working, 1_000);
        seed(ids.stale, 'Private stale', { endedAgo: 4 * 3_600_000 });
        unfinishedTurn(ids.stale, 3 * 3_600_000);
        seed(ids.drive, 'Private drive');
        // A reverted tail: the pointer names the unfinished user row, so the unfinished turn is hidden.
        seed(ids.reverted, 'Private reverted');
        const hidden = unfinishedTurn(ids.reverted, 1_000);
        store.setRevert(ids.reverted, hidden, Date.now());
        // A todo list the agent kept.
        seed(ids.todo, 'Private todo');
        const at = Date.now() - 5_000;
        store.putMessage(ids.todo, { id: `msg_${ids.todo}_t`, role: 'assistant', time: { created: at, completed: at + 1 }, finish: 'stop' });
        store.putPart(ids.todo, `msg_${ids.todo}_t`, {
          id: `prt_${ids.todo}_t`, type: 'tool', tool: 'todowrite', callID: 'call_todo',
          state: {
            status: 'completed', input: { todos: [{ content: 'write the tests', status: 'in_progress', priority: 'high' }, { content: 'ship', status: 'pending' }] },
            output: '', title: '2 todos', metadata: {}, time: { start: at, end: at + 1 },
          },
        });
      },
      env: (paths) => ({
        // Nothing listens here: the broker has no serve to find, and no way to reach 4096.
        OPENCODE_URL: `http://127.0.0.1:${lease.port}`,
        COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
        OPENCODE_DATA: join(paths.root, 'opencode-data'),
      }),
    });
    client = broker.client();
  });
  afterAll(async () => {
    client?.closeAll();
    store?.close();
    await broker?.stop();
  });

  const row = (id: string) => client.waitForSession((candidate) => candidate.id === id);
  const spawns = (from = 0) => ledger.entries().slice(from).filter((entry) => entry.kind === 'spawn');

  test('a stored session is listed as Observe, and its sub-agent children are not', async () => {
    const main = await row(ids.main);
    expect(main).toMatchObject({ tool: 'opencode', title: 'Private main', cwd: workspace, attachMode: 'observe' });
    expect(main.currentModel).toMatchObject({ providerID: 'test-provider', modelID: 'model-a' });
    expect(main.control.drive).toEqual({ supported: true, state: 'observing' });
    // No serve, so there is nothing for a terminal to join.
    expect(main.control.terminalSync).toMatchObject({ supported: false, syncAvailable: false, active: false });
    expect(main.terminalSyncHint).toBeUndefined();
    // Discovery from disk stays parent-only: the child exists, but is not listed.
    await row(ids.drive);
    expect((await client.sessions({ refresh: true })).some((candidate) => candidate.id === ids.child)).toBe(false);
  });

  test('Observe replays the conversation in order and refuses every write, changing nothing', async () => {
    const before = treeSnapshot(store.dataDir);
    const mark = ledger.mark();
    const stream = await client.attach('opencode', ids.main);
    const history = await stream.waitForKind('history');
    const session = stream.ofKind('session').at(-1)!;
    expect(session.authority).toEqual({ canMutate: false, prompt: 'none' });
    expect(session.info.attachMode).toBe('observe');
    const visible = (history.messages as any[]).filter((message) => message.type === 'user-message' || message.type === 'model-output');
    expect(visible.map(textOf)).toEqual(['seeded prompt 1', 'seeded answer 1', 'seeded prompt 2', 'seeded answer 2']);
    expect(new Set(visible.map((message) => `${message.type}:${message.key}`)).size).toBe(4);
    expect((history.messages as any[]).filter((message) => message.type === 'run-summary').map((message) => message.status)).toEqual(['done', 'done']);
    for (const message of [
      { kind: 'prompt', text: 'observe must not send this' },
      { kind: 'approve', requestId: 'any', decision: 'approve' },
      { kind: 'answer', requestId: 'any', answers: [['x']] },
      { kind: 'command', name: 'stop' },
    ]) {
      const reply = await stream.sendAndAwait(message);
      expect(reply.kind, message.kind).toBe('nack');
    }
    expect(spawns(mark)).toEqual([]);
    expect(treeSnapshot(store.dataDir)).toEqual(before);
    stream.close();
  });

  test('a turn written to the store while Observe is open arrives, once', async () => {
    const id = 'ses_private_tail';
    const end = seed(id, 'Private tail');
    void end;
    await row(id);
    const stream = await client.attach('opencode', id);
    await stream.waitForKind('history');
    const from = stream.frames.length;
    const at = Date.now();
    store.putMessage(id, { id: `msg_${id}_new_u`, role: 'user', time: { created: at } });
    store.putPart(id, `msg_${id}_new_u`, { id: `prt_${id}_new_u`, type: 'text', text: 'typed in the terminal' });
    store.putMessage(id, { id: `msg_${id}_new_a`, role: 'assistant', parentID: `msg_${id}_new_u`, time: { created: at + 1, completed: at + 2 }, finish: 'stop', tokens, cost: 0 });
    store.putPart(id, `msg_${id}_new_a`, { id: `prt_${id}_new_a`, type: 'text', text: 'answered in the terminal', time: { start: at + 1, end: at + 2 } });
    store.touchSession(id, at + 2);
    const reset = await stream.waitForFrame((frame) => frame.kind === 'history' && frame.reset === true
      && (frame.messages as any[]).some((message) => textOf(message) === 'answered in the terminal'), { after: from, what: 'the re-read history with the new turn' });
    expect(userTexts(reset.messages)).toEqual(['seeded prompt 1', 'typed in the terminal']);
    // The reset restates the conversation: nothing is shown twice once the client applies it.
    const shown = (reset.messages as any[]).filter((message) => textOf(message) === 'typed in the terminal').length;
    expect(shown).toBe(1);
    stream.close();
  });

  test('a session reads working only while a fresh turn is unfinished, and a reverted tail is ignored', async () => {
    const working = await client.waitForSession((candidate) => candidate.id === ids.working && candidate.status === 'working');
    expect(working.status).toBe('working');
    // The same unfinished turn hours old is a crashed run, not a working session.
    expect((await row(ids.stale)).status).toBe('idle');
    // The unfinished turn sits past the revert pointer: it is hidden, so the session is idle.
    // (The sqlite reader ignores the pointer when it reads activity: an open product defect.)
    if (layout === 'json' || process.env.COSYNCING_E2E_KNOWN_BUGS === '1') expect((await row(ids.reverted)).status).toBe('idle');
    // Tools that are open todo state are not liveness either.
    expect((await row(ids.todo)).status).toBe('idle');
  });

  test('history applies the revert pointer', async () => {
    const stream = await client.attach('opencode', ids.reverted);
    const history = await stream.waitForKind('history');
    expect(userTexts(history.messages)).toEqual(['seeded prompt 1']);
    expect((history.messages as any[]).some((message) => textOf(message) === 'still typing')).toBe(false);
    stream.close();
  });

  test('a todo list is one task-list row, and the raw tool rows are not shown', async () => {
    const stream = await client.attach('opencode', ids.todo);
    const history = await stream.waitForKind('history');
    const lists = (history.messages as any[]).filter((message) => message.type === 'task-list-state');
    expect(lists.length).toBe(1);
    expect(lists[0].items.map((item: any) => [item.title, item.status, item.priority])).toEqual([
      ['write the tests', 'in-progress', 'high'], ['ship', 'open', undefined],
    ]);
    expect((history.messages as any[]).some((message) => message.type === 'tool-call' && message.toolName === 'todowrite')).toBe(false);
    stream.close();
  });

  describe('Drive runs `opencode run` and persists the turn', () => {
    const open = async (id = ids.drive): Promise<SessionStream> => {
      const stream = await client.attach('opencode', id, { mode: 'resume', reason: 'takeover' });
      const session = await stream.waitForKind('session');
      expect(session.authority?.canMutate).toBe(true);
      await stream.waitForKind('commands');
      return stream;
    };

    test('one prompt is one run, answered, summarised and durable', async () => {
      const stream = await open();
      expect(stream.ofKind('session').at(-1)!.info.control.drive).toEqual({ supported: true, state: 'driving' });
      // Only the stop action is offered: there are no templates or other actions without a serve.
      expect((stream.ofKind('commands').at(-1)!.commands as any[]).map((command) => [command.name, command.kind])).toEqual([['stop', 'action']]);
      const mark = ledger.mark();
      const from = stream.frames.length;
      // Without a serve there is no model catalog, so a chosen model is not advertised and is refused before any run.
      const refused = await stream.sendAndAwait({ kind: 'prompt', text: 'on a model', model: { providerID: 'test-provider', modelID: 'model-b' } });
      expect(refused.kind).toBe('nack');
      expect(refused.code).toBe('MODEL_UNSUPPORTED');
      expect(spawns(mark)).toEqual([]);
      const reply = await stream.sendAndAwait({ kind: 'prompt', text: 'hello private', clientMessageId: 'private-1' });
      expect(reply.kind, JSON.stringify(reply)).toBe('ack');
      const runs = spawns(mark);
      expect(runs.length).toBe(1);
      expect(runs[0]!.argv).toEqual(['run', '--session', ids.drive, '--format', 'json', '--dir', workspace, 'hello private']);
      expect(runs[0]!.autoUpdateDisabled).toBe('1');
      const live = stream.frames.slice(from).filter((frame) => frame.kind === 'message').map((frame) => frame.message);
      const own = live.find((message) => message.type === 'user-message' && message.text === 'hello private');
      expect(own?.clientKey).toBe('private-1');
      expect(live.some((message) => message.type === 'model-output' && textOf(message) === 'answer: hello private')).toBe(true);
      expect(live.some((message) => message.type === 'token-count' && message.input === 10 && message.output === 5)).toBe(true);
      expect(live.filter((message) => message.type === 'run-summary').map((message) => message.status)).toEqual(['running', 'done']);
      // The continuation is in the store: a fresh reader sees the turn once, after the earlier one.
      const fresh = await client.attach('opencode', ids.drive);
      const history = await fresh.waitForKind('history');
      expect(userTexts(history.messages)).toEqual(['seeded prompt 1', 'hello private']);
      expect((history.messages as any[]).filter((message) => textOf(message) === 'answer: hello private').length).toBe(1);
      fresh.close();
      stream.close();
    });

    test('a second prompt while a run is open is refused, Stop ends the run, and approvals are refused', async () => {
      const stream = await open();
      // One socket serializes its own messages; a second tab reaches the same run while it is open.
      const tab = await open();
      const mark = ledger.mark();
      const first = stream.sendAndAwait({ kind: 'prompt', text: '[[hold:private-stop]] a long run' });
      first.catch(() => undefined);
      await eventually(() => spawns(mark).length === 1, { what: 'the run to start' });
      const second = await tab.sendAndAwait({ kind: 'prompt', text: 'overlapping' });
      expect(second.kind).toBe('nack');
      expect(String(second.message)).toContain('already running a turn');
      // Without a serve a run cannot be asked for approvals or answers: the broker says so and sends nothing.
      const approval = await tab.sendAndAwait({ kind: 'approve', requestId: 'any', decision: 'approve' });
      expect(approval.kind).toBe('nack');
      expect(String(approval.message)).toContain('non-interactive');
      const answer = await tab.sendAndAwait({ kind: 'answer', requestId: 'any', answers: [['x']] });
      expect(answer.kind).toBe('nack');
      expect((await tab.sendAndAwait({ kind: 'command', name: 'stop' })).kind).toBe('ack');
      await eventually(() => ledger.entries().slice(mark).some((entry) => entry.kind === 'signal'), { what: 'the run to be signalled' });
      await first;
      // The run is over and the session idle. A user's Stop should read as cancelled, like it does on a serve;
      // a private run reports `error` and `opencode run exited 143` (open product defect, asserted with the opt-in).
      const ended = await stream.waitForMessage((message) => message.type === 'run-summary' && message.status !== 'running');
      await stream.waitForMessage((message) => message.type === 'status' && message.status === 'idle');
      if (process.env.COSYNCING_E2E_KNOWN_BUGS === '1') {
        expect(ended.status).toBe('cancelled');
        expect(stream.messages().some((message) => message.type === 'error')).toBe(false);
      }
      expect(spawns(mark).length).toBe(1);
      // The session is usable again.
      expect((await stream.sendAndAwait({ kind: 'prompt', text: 'after stop' })).kind).toBe('ack');
      stream.close();
      tab.close();
    });
  });
});
