/**
 * Transcript message identity: one logical message is one row on the client.
 *
 * A client merges everything it receives (the attach frame, live frames, pages, reset frames) by
 * a row's identity (`type` + `key`). These scenarios drive a real broker the way the app does and
 * check what the client ends up holding: every message exactly once, under the identity it had
 * before, still carrying the markers (`final`, `clientKey`) the app reads.
 *
 * - Attach: a joiner at the overlap of saved history and the live text buffer, mid-stream, after
 *   idle, with a capped frame, and with a cursor.
 * - App-send echo: the app's `clientMessageId` comes back as `clientKey` only on the exact native
 *   echo of that send (Pi bridge, OpenCode), never on equal text typed in a terminal (Claude tail).
 * - Resync: a replaced transcript reaches every client as one authoritative reset frame; what the
 *   reset wiped is restored after it; an empty re-read keeps the client's view.
 * - Reconnect and restart: a reconnect with the client's cursor, and a broker restart (Codex rollout
 *   on disk, Pi bridge re-announcing), leave no row missing and none twice.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Broker, type BrokerClient, type Frame, type SessionStream, startBroker } from '../harness/index.ts';
import { ask } from '../harness/history.ts';
import { openPiBridgeSession, piUserRows, type PiBridgeSession, type PiEvent } from '../harness/fakes/pi-bridge.ts';
import { writeRollout, type Rollout } from '../harness/fakes/codex-rollout.ts';
import { type FakeOpenCodeServer, openCodeRows as oc, startFakeOpenCode } from '../harness/fakes/opencode-server.ts';

// ── What a client holds ──────────────────────────────────────────────────────

/** Every copy of `key` the client received: attach and reset frames, pages, live frames. */
function copiesOf(stream: SessionStream, key: string): any[] {
  return stream.messages().filter((message) => message?.key === key);
}

/** Frames received after index `from`, of one kind. */
function framesAfter(stream: SessionStream, from: number, kind: string): Frame[] {
  return stream.frames.slice(from).filter((frame) => frame.kind === kind);
}

let barrierSequence = 0;

/**
 * Receipt the newest attach ticket, as the app does once it applied a frame, and wait for the
 * answer. The broker answers inbound frames only after an attach finished sending its catch-up, and
 * a socket is ordered, so once the answer is here every frame sent before it is too. This is the
 * barrier for "nothing more is coming" checks.
 */
async function settled(stream: SessionStream): Promise<void> {
  const ticket = [...stream.frames].reverse().find((frame) => frame.kind === 'history' && frame.attachTicket)?.attachTicket;
  const clientMessageId = `settle-${++barrierSequence}`;
  const after = stream.frames.length;
  stream.send({ kind: 'ack', attachTicket: ticket ?? 'none', clientMessageId });
  await stream.waitForFrame(
    (frame) => (frame.kind === 'ack' || frame.kind === 'nack') && frame.clientMessageId === clientMessageId,
    { what: `the receipt answer ${clientMessageId}`, after },
  );
}

/**
 * The client's transcript after merging every frame the way the app does: a reset history frame
 * replaces the window, an incremental one and live frames upsert by identity (deltas append to
 * the row's text). Keyless rows are appended. Returns `type:key` → row, in first-seen order.
 */
function mergedTranscript(stream: SessionStream): Map<string, any> {
  const rows = new Map<string, any>();
  const upsert = (message: any) => {
    if (!message || typeof message !== 'object') return;
    const identity = `${message.type}:${message.key ?? message.requestId ?? message.callId ?? `#${rows.size}`}`;
    const held = rows.get(identity);
    if (typeof message.delta === 'string' && typeof message.text !== 'string') {
      rows.set(identity, { ...held, ...message, text: `${held?.text ?? ''}${message.delta}` });
    } else {
      rows.set(identity, { ...held, ...message });
    }
  };
  for (const frame of stream.frames) {
    if (frame.kind === 'history') {
      if (frame.reset !== false) rows.clear();
      for (const message of frame.messages ?? []) upsert(message);
    } else if (frame.kind === 'history-page') {
      for (const message of frame.messages ?? []) upsert(message);
    } else if (frame.kind === 'message') {
      upsert(frame.message);
    }
  }
  return rows;
}

/** `type:key` of the client's merged transcript rows of these types. */
function transcriptKeys(stream: SessionStream, types = ['user-message', 'model-output']): string[] {
  return [...mergedTranscript(stream).values()]
    .filter((row) => types.includes(row.type))
    .map((row) => `${row.type}:${row.key}`);
}

/** Commands the broker queued for the Pi extension. Called only when one is known to be queued. */
async function piCommands(client: BrokerClient, id: string): Promise<any[]> {
  const response = await client.get(`/pi/bridge/commands?id=${encodeURIComponent(id)}`);
  if (response.status !== 200) throw new Error(`pi commands refused (${response.status}): ${response.text.slice(0, 300)}`);
  return response.body.commands ?? [];
}

// ── Pi bridge: attach, echo, resync ──────────────────────────────────────────

describe('a Pi session through one broker', () => {
  let broker: Broker;
  let client: BrokerClient;
  const streams: SessionStream[] = [];
  const sessions: PiBridgeSession[] = [];

  beforeAll(async () => {
    broker = await startBroker({ name: 'transcript-identity' });
    client = broker.client();
  });
  afterAll(async () => {
    for (const stream of streams) stream.close();
    await broker?.stop();
  });

  async function attach(id: string, options: Parameters<BrokerClient['attach']>[2] = {}): Promise<SessionStream> {
    const stream = await client.attach('pi', id, options);
    streams.push(stream);
    await stream.waitForKind('history');
    return stream;
  }

  /** A bridge session with a client already attached, so the broker holds its live text. */
  async function liveSession(title: string, history: PiEvent[] = []): Promise<{ pi: PiBridgeSession; driver: SessionStream }> {
    const pi = await openPiBridgeSession(broker, history, { title });
    sessions.push(pi);
    const driver = await attach(pi.id);
    await settled(driver);
    return { pi, driver };
  }

  describe('attach', () => {
    test('a client joining after the final reached history, while the live buffer still holds it, gets one copy, still final', async () => {
      const { pi, driver } = await liveSession('overlap');
      const key = 'pi:answer:overlap';
      await pi.events([
        { t: 'status', running: true },
        { t: 'delta', key, delta: 'The answer is 42.' },
        { t: 'final', key, text: 'The answer is 42.' },
      ]);
      await settled(driver);
      const joiner = await attach(pi.id);
      await settled(joiner);
      const copies = copiesOf(joiner, key);
      expect(copies.map((copy) => copy.text)).toEqual(['The answer is 42.']);
      // The client keeps the last copy of an identity: a restated live copy would drop `final`.
      expect(copies.at(-1)?.final).toBe(true);
    });

    test('a client joining mid-stream gets the text streamed so far', async () => {
      const { pi, driver } = await liveSession('midstream');
      const key = 'pi:answer:midstream';
      await pi.events([{ t: 'status', running: true }, { t: 'delta', key, delta: 'Still thinking' }]);
      await settled(driver);
      const joiner = await attach(pi.id);
      await settled(joiner);
      expect(copiesOf(joiner, key).map((copy) => copy.text)).toEqual(['Still thinking']);
    });

    test('a live copy carrying more text than history is still delivered', async () => {
      const { pi, driver } = await liveSession('extended');
      const key = 'pi:answer:extended';
      await pi.events([
        { t: 'status', running: true },
        { t: 'delta', key, delta: 'Part one.' },
        { t: 'final', key, text: 'Part one.' },
        { t: 'delta', key, delta: ' Part two.' },
      ]);
      await settled(driver);
      const joiner = await attach(pi.id);
      await settled(joiner);
      expect(mergedTranscript(joiner).get(`model-output:${key}`)?.text).toBe('Part one. Part two.');
      expect(copiesOf(joiner, key).some((copy) => copy.text === 'Part one. Part two.')).toBe(true);
    });

    test('a capped attach during a running turn delivers each block once, and an older page keeps their identities', async () => {
      const { pi, driver } = await liveSession('capped');
      const keys = ['pi:cap:1', 'pi:cap:2', 'pi:cap:3', 'pi:cap:4'];
      await pi.events([
        { t: 'status', running: true },
        ...keys.flatMap((key, index) => [
          { t: 'delta', key, delta: `Block ${index + 1}.` },
          { t: 'final', key, text: `Block ${index + 1}.` },
        ]),
      ]);
      await settled(driver);
      const joiner = await attach(pi.id, { initialHistory: 1 });
      await settled(joiner);
      // The frame ends at the running-turn hold: the newest block follows it instead.
      const frame = joiner.ofKind('history')[0]!;
      expect(frame.truncated).toEqual({ shown: 1, total: keys.length - 1 });
      expect(frame.messages.map((message: any) => message.key)).toEqual([keys[2]]);
      // A block capped out of the frame is still live text nothing else delivers: it arrives once.
      expect(copiesOf(joiner, keys[0]!).map((copy) => copy.text)).toEqual(['Block 1.']);
      // The block the frame carried is not restated; the held block arrives once, still final.
      expect(copiesOf(joiner, keys[2]!).map((copy) => copy.final)).toEqual([true]);
      expect(copiesOf(joiner, keys[3]!).map((copy) => copy.final)).toEqual([true]);

      const page = await ask(joiner, { kind: 'history-page', cursor: frame.olderCursor, limit: 10 });
      expect(page.messages.map((message: any) => message.key)).toEqual(keys.slice(0, 2));
      // The paged copy of the live-delivered block fills in under the same identity: one row.
      expect(copiesOf(joiner, keys[0]!).map((copy) => copy.text)).toEqual(['Block 1.', 'Block 1.']);
      expect(transcriptKeys(joiner)).toEqual(expect.arrayContaining(keys.map((key) => `model-output:${key}`)));
      expect(transcriptKeys(joiner).filter((key) => key.startsWith('model-output:pi:cap:'))).toHaveLength(4);
    });

    test('a reconnect with a cursor does not restate what the cursor acknowledges', async () => {
      const { pi, driver } = await liveSession('cursor');
      const key = 'pi:answer:cursor';
      const newest = 'pi:answer:cursor-newest';
      await pi.events([
        { t: 'status', running: true },
        { t: 'delta', key, delta: 'Persisted once.' },
        { t: 'final', key, text: 'Persisted once.' },
        { t: 'delta', key: newest, delta: 'Then more.' },
        { t: 'final', key: newest, text: 'Then more.' },
      ]);
      await settled(driver);
      const first = await attach(pi.id);
      await settled(first);
      expect(copiesOf(first, key).map((copy) => copy.final)).toEqual([true]);
      const cursor = first.ofKind('history')[0]!.cursor;
      expect(typeof cursor).toBe('string');
      first.close();
      await first.closed;

      const again = await attach(pi.id, { since: cursor });
      await settled(again);
      const frame = again.ofKind('history')[0]!;
      expect([frame.reset, frame.messages.length]).toEqual([false, 0]);
      expect(copiesOf(again, key)).toEqual([]);
      // The running-turn hold kept the newest block out of the cursor: it follows once, final.
      expect(copiesOf(again, newest).map((copy) => copy.final)).toEqual([true]);
    });

    test('a client joining after the turn went idle gets the answer once, from history', async () => {
      const { pi, driver } = await liveSession('after-idle');
      const key = 'pi:answer:idle';
      await pi.events([
        { t: 'status', running: true },
        { t: 'delta', key, delta: 'Settled.' },
        { t: 'final', key, text: 'Settled.' },
        { t: 'status', running: false },
      ]);
      await settled(driver);
      const joiner = await attach(pi.id);
      await settled(joiner);
      expect(copiesOf(joiner, key).map((copy) => [copy.text, copy.final])).toEqual([['Settled.', true]]);
      const fromHistory = joiner.ofKind('history')[0]!.messages.filter((message: any) => message.key === key);
      expect(fromHistory).toHaveLength(1);
    });
  });

  describe('app-send echo correlation', () => {
    test('an app prompt comes back under its exact key and clientKey; identical terminal text stays unstamped', async () => {
      const { pi, driver } = await liveSession('echo');
      const sent = await driver.sendAndAwait({ kind: 'prompt', text: 'ping from app', clientMessageId: 'ca.pi.1' });
      expect(sent.kind).toBe('ack');
      const prompt = (await piCommands(client, pi.id)).find((command) => command.kind === 'prompt');
      expect(prompt?.text).toBe('ping from app');
      expect(prompt?.clientKey).toBe('ca.pi.1');
      expect(String(prompt?.messageKey)).toStartWith('u:remote:');

      // The terminal typed the same text first; then the extension relays the app's prompt row.
      // A native row cannot claim the app's identity even when it names one.
      await pi.events([
        { t: 'user', key: 'u0', text: 'ping from app', sentAt: 1_000 },
        { t: 'user', key: 'u1', clientKey: 'ca.pi.1', text: 'ping from app', sentAt: 1_500 },
        { t: 'user', key: prompt.messageKey, clientKey: prompt.clientKey, text: 'ping from app', sentAt: 2_000 },
      ]);
      await settled(driver);
      const echoes = () => driver.messages().filter((message) => message.type === 'user-message');
      expect(echoes().map((message) => [message.key, message.clientKey ?? null])).toEqual([
        ['u0', null],
        ['u1', null],
        [prompt.messageKey, 'ca.pi.1'],
      ]);

      // A client attaching later holds the same rows and the same stamp.
      const joiner = await attach(pi.id);
      await settled(joiner);
      expect(joiner.messages().filter((message) => message.type === 'user-message')
        .map((message) => [message.key, message.clientKey ?? null])).toEqual([
        ['u0', null],
        ['u1', null],
        [prompt.messageKey, 'ca.pi.1'],
      ]);

      // The extension reloads with its authoritative transcript: a persisted app prompt whose live
      // event was lost is recovered once, and the terminal rows it no longer has are gone.
      const from = joiner.frames.length;
      await pi.rehello([
        { t: 'user', key: prompt.messageKey, clientKey: 'ca.pi.1', text: 'ping from app', sentAt: 2_000 },
        { t: 'user', key: 'u:remote:recovered', clientKey: 'ca.pi.2', text: 'persisted before crash', sentAt: 3_000 },
      ]);
      const reset = await joiner.waitForFrame((frame) => frame.kind === 'history' && frame.reset === true, { after: from });
      expect(reset.messages.filter((message: any) => message.type === 'user-message')
        .map((message: any) => [message.key, message.clientKey ?? null])).toEqual([
        [prompt.messageKey, 'ca.pi.1'],
        ['u:remote:recovered', 'ca.pi.2'],
      ]);
      await settled(joiner);
      expect(transcriptKeys(joiner, ['user-message'])).toEqual([
        `user-message:${prompt.messageKey}`,
        'user-message:u:remote:recovered',
      ]);
    });

    // A session announced empty, whose first prompt's live event was lost, is recovered on the next
    // re-hello: the client already attached gets it too, not only a client that attaches later.
    test('a re-hello that recovers rows into an empty session reaches the clients already attached', async () => {
      const { pi, driver } = await liveSession('recover-into-empty');
      await pi.rehello([{ t: 'user', key: 'u:remote:recovered-first', clientKey: 'ca.pi.first', text: 'persisted before crash' }]);
      await pi.events([{ t: 'user', key: 'after-recovery', text: 'sentinel' }]);
      await driver.waitForMessage((message) => message.key === 'after-recovery');
      // A fresh attach holds the recovered row; the attached client must too.
      const fresh = await attach(pi.id);
      expect(fresh.ofKind('history')[0]!.messages.map((message: any) => message.key)).toEqual(['u:remote:recovered-first', 'after-recovery']);
      expect(transcriptKeys(driver, ['user-message'])).toEqual(['user-message:u:remote:recovered-first', 'user-message:after-recovery']);
    });
  });

  describe('resync', () => {
    test('a replaced transcript reaches every client as one reset frame, and the pending card follows it', async () => {
      const { pi, driver } = await liveSession('resync', [
        { t: 'user', key: 'r-u1', text: 'question' },
        { t: 'final', key: 'r-a1', text: 'first answer' },
      ]);
      const second = await attach(pi.id);
      await settled(second);
      await pi.events([
        { t: 'status', running: true },
        { t: 'permission-request', requestId: 'perm-1', title: 'Run tests?' },
        { t: 'delta', key: 'r-a2', delta: 'reverted draft' },
      ]);
      await settled(driver);
      await settled(second);
      const marks = [driver.frames.length, second.frames.length];

      // The extension reloads with a rewritten transcript (an undo): the broker must replace windows.
      await pi.rehello([
        { t: 'user', key: 'r-u1', text: 'question' },
        { t: 'final', key: 'r-a1b', text: 'rewritten answer' },
      ]);
      for (const [index, stream] of [driver, second].entries()) {
        const frame = await stream.waitForFrame((candidate) => candidate.kind === 'history', { after: marks[index] });
        // Authoritative: an explicit reset with a full-prefix cursor, carrying the durable rows only.
        expect(frame.reset).toBe(true);
        expect(typeof frame.cursor).toBe('string');
        expect(frame.messages.map((message: any) => `${message.type}:${message.key}`)).toEqual([
          'user-message:r-u1',
          'model-output:r-a1b',
        ]);
      }
      // A later live row is the sentinel: everything the resync replays comes before it.
      await pi.events([{ t: 'user', key: 'r-u2', text: 'after the reset' }]);
      for (const [index, stream] of [driver, second].entries()) {
        await stream.waitForMessage((message) => message.key === 'r-u2');
        const after = stream.frames.slice(marks[index]);
        expect(after.filter((frame) => frame.kind === 'history')).toHaveLength(1);
        const resetAt = after.findIndex((frame) => frame.kind === 'history');
        const replayed = after.slice(resetAt + 1).filter((frame) => frame.kind === 'message').map((frame) => frame.message);
        // The pending card the reset wiped is restored; the reverted streamed text is not.
        expect(replayed.some((message) => message.type === 'permission-request' && message.requestId === 'perm-1')).toBe(true);
        expect(replayed.some((message) => message.key === 'r-a2')).toBe(false);
        expect(transcriptKeys(stream, ['user-message', 'model-output'])).toEqual([
          'user-message:r-u1',
          'model-output:r-a1b',
          'user-message:r-u2',
        ]);
      }

      // The reset frame's cursor is a delivery position: a reconnect from it is an empty delta.
      const cursor = [...driver.frames].reverse().find((frame) => frame.kind === 'history')!.cursor;
      const resumed = await attach(pi.id, { since: cursor });
      await settled(resumed);
      const delta = resumed.ofKind('history')[0]!;
      expect(delta.reset).toBe(false);
      expect(delta.messages.map((message: any) => message.key)).toEqual(['r-u2']);
    });

    test('a capped resync keeps the older history one page away', async () => {
      const { pi, driver } = await liveSession('capped-resync', piUserRows('before', 3));
      const mark = driver.frames.length;
      await pi.rehello(piUserRows('long', 150));
      const frame = await driver.waitForFrame((candidate) => candidate.kind === 'history', { after: mark });
      expect(frame.reset).toBe(true);
      expect(frame.truncated).toEqual({ shown: 100, total: 150 });
      expect(frame.hasEarlier).toBe(true);
      expect(frame.messages.map((message: any) => message.key)).toEqual(piUserRows('long', 100, 50).map((row) => row.key));
      const page = await ask(driver, { kind: 'history-page', cursor: frame.olderCursor, limit: 100 });
      expect(page.messages.map((message: any) => message.key)).toEqual(piUserRows('long', 50).map((row) => row.key));
      expect(page.endOfHistory).toBe(true);
      // The frame's end boundary pages exactly the rows the frame carried.
      const end = await ask(driver, { kind: 'history-page', cursor: frame.endCursor, limit: 100 });
      expect(end.messages.map((message: any) => message.key)).toEqual(frame.messages.map((message: any) => message.key));
      expect(transcriptKeys(driver, ['user-message'])).toHaveLength(150);
    });

  });

  describe('reconnect', () => {
    test('a client that reconnects with its cursor receives exactly the rows it missed', async () => {
      const { pi } = await liveSession('reconnect', piUserRows('seen', 3));
      const first = await attach(pi.id);
      await settled(first);
      const cursor = first.ofKind('history')[0]!.cursor;
      first.close();
      await first.closed;
      await pi.events([
        { t: 'user', key: 'missed-u', text: 'sent while away' },
        { t: 'final', key: 'missed-a', text: 'answered while away' },
      ]);
      const again = await attach(pi.id, { since: cursor });
      await settled(again);
      const frame = again.ofKind('history')[0]!;
      expect(frame.reset).toBe(false);
      expect(frame.messages.map((message: any) => message.key)).toEqual(['missed-u', 'missed-a']);
      // Merged on top of what the client held before, every row is there once.
      const held = transcriptKeys(first);
      const merged = [...new Set([...held, ...transcriptKeys(again)])];
      expect(merged).toEqual([...piUserRows('seen', 3).map((row) => `user-message:${row.key}`), 'user-message:missed-u', 'model-output:missed-a']);
    });
  });
});

// ── OpenCode and Claude: native stores ──────────────────────────────────────

describe('sessions on native stores', () => {
  let broker: Broker;
  let opencode: FakeOpenCodeServer;
  let worktree: string;

  beforeAll(async () => {
    worktree = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-echo-'));
    opencode = startFakeOpenCode(worktree, 'ses_echo');
    broker = await startBroker({ name: 'echo-native', env: { OPENCODE_URL: opencode.url } });
  });
  afterAll(async () => {
    await broker?.stop();
    opencode?.stop();
    rmSync(worktree, { recursive: true, force: true });
  });

  test('OpenCode: the prompt carries a native message id, and only its echo is stamped, even before the 204', async () => {
    const stream = await broker.client().attach('opencode', opencode.sessionId);
    try {
      await stream.waitForKind('history');
      // The fake announces the user row on its event bus before it answers the POST.
      expect((await stream.sendAndAwait({ kind: 'prompt', text: 'serve me', clientMessageId: 'ca.oc.1' })).kind).toBe('ack');
      const prompt = opencode.prompts.find((candidate) => candidate.text === 'serve me');
      expect(prompt?.messageID).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      const echo = await stream.waitForMessage((message) => message.type === 'user-message' && message.key === prompt!.messageID);
      expect(echo.clientKey).toBe('ca.oc.1');

      // The same words typed in the TUI are a different message and are never stamped.
      opencode.announce({
        info: { id: 'msg_tui', role: 'user', time: { created: Date.now() } },
        parts: [{ id: 'prt_tui', type: 'text', text: 'serve me' }],
      });
      const tui = await stream.waitForMessage((message) => message.type === 'user-message' && message.key === 'msg_tui');
      expect(tui.clientKey).toBeUndefined();

      // A reattach reads OpenCode's transcript: the stamp survives on the app's row only.
      const joiner = await broker.client().attach('opencode', opencode.sessionId);
      try {
        const frame = await joiner.waitForKind('history');
        const rows = frame.messages.filter((message: any) => message.type === 'user-message');
        expect(rows.map((message: any) => [message.key, message.clientKey ?? null])).toEqual([[prompt!.messageID, 'ca.oc.1']]);
      } finally {
        joiner.close();
      }
    } finally {
      stream.close();
    }
  });

  test('Claude: lines the transcript tail reads are never stamped, and identical lines stay two rows', async () => {
    const uuid = '0e2e0000-0000-4000-8000-0000000ec401';
    const project = join(broker.paths.root, 'claude', 'projects', '-e2e-echo');
    mkdirSync(project, { recursive: true });
    const transcript = join(project, `${uuid}.jsonl`);
    const line = (id: string, minute: number, content: string) => `${JSON.stringify({
      type: 'user',
      uuid: id,
      sessionId: uuid,
      cwd: broker.paths.home,
      timestamp: `2026-07-23T00:0${minute}:00.000Z`,
      message: { role: 'user', content },
    })}\n`;
    writeFileSync(transcript, line('uu0', 0, 'history line'));
    const id = Buffer.from(transcript, 'utf8').toString('base64url');
    const stream = await broker.client().attach('claude', id);
    try {
      await stream.waitForKind('history');
      // Claude Code writes its own JSONL with no handle on the app's send, so a terminal prompt
      // landing before the app's echo must not be able to take the app's identity.
      appendFileSync(transcript, line('uu1', 1, 'hello from app') + line('uu2', 2, 'hello from app'));
      const echoes = await (async () => {
        let found: any[] = [];
        await stream.waitForMessage(() => {
          found = stream.messages().filter((message) => message.type === 'user-message' && message.text === 'hello from app');
          return found.length >= 2;
        });
        return found;
      })();
      expect(echoes.map((message) => message.clientKey ?? null)).toEqual([null, null]);
      expect(new Set(echoes.map((message) => message.key)).size).toBe(2);
    } finally {
      stream.close();
    }
  });

  test('OpenCode resync: live rows racing the snapshot read stream at once and follow the reset frame', async () => {
    opencode.setBusy(false);
    opencode.setRows([
      oc.user('msg_r1', 1_000, 'question'),
      oc.assistant('msg_ra1', 'msg_r1', 1_001, [oc.text('prt_ra1', 'first answer', 1_001, 1_002)], 1_003),
    ]);
    const stream = await broker.client().attach('opencode', opencode.sessionId);
    try {
      await stream.waitForKind('history');
      await settled(stream);
      const mark = stream.frames.length;
      // A compaction makes the broker re-read the transcript; the read is held open.
      const read = opencode.holdReads();
      opencode.publish({ type: 'session.compacted', properties: { sessionID: opencode.sessionId } });
      await read.started;
      // The agent keeps writing while the snapshot is read: those rows are not in it.
      opencode.announce(oc.user('msg_r2', 2_000, 'raced question'));
      opencode.announce(oc.assistant('msg_ra2', 'msg_r2', 2_001, [oc.text('prt_ra2', 'raced answer', 2_001)]));
      // Live delivery does not wait for the read.
      await stream.waitForMessage((message) => message.key === 'prt_ra2');
      expect(framesAfter(stream, mark, 'history')).toHaveLength(0);
      read.release();

      const reset = await stream.waitForFrame((frame) => frame.kind === 'history', { after: mark });
      expect(reset.reset).toBe(true);
      expect(typeof reset.cursor).toBe('string');
      expect(reset.messages.map((message: any) => `${message.type}:${message.key}`)).toEqual([
        'user-message:msg_r1',
        'model-output:prt_ra1',
      ]);
      // Everything newer than the snapshot is replayed after it, so the client ends with
      // [snapshot][newer], each once, and the compaction notice reaches it.
      const resetAt = stream.frames.indexOf(reset);
      await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message?.key === 'prt_ra2', { after: resetAt + 1 });
      await stream.waitForFrame((frame) => frame.kind === 'notice', { after: resetAt });
      expect(transcriptKeys(stream)).toEqual([
        'user-message:msg_r1',
        'model-output:prt_ra1',
        'user-message:msg_r2',
        'model-output:prt_ra2',
      ]);
      expect(mergedTranscript(stream).get('model-output:prt_ra2')?.text).toBe('raced answer');
      const seqs = stream.frames.slice(mark).filter((frame) => frame.kind === 'message').map((frame) => frame.seq as number);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
    } finally {
      stream.close();
    }
  });

  test('OpenCode resync while a turn runs: the frame ends at the running-turn hold and the held rows follow it', async () => {
    opencode.setRows([
      oc.user('msg_h1', 3_000, 'go'),
      oc.assistant('msg_ha1', 'msg_h1', 3_001, [oc.tool('prt_ht1', 'call_h1', 'completed', 'ls'), oc.text('prt_ha1', 'working on it', 3_002)]),
    ]);
    const stream = await broker.client().attach('opencode', opencode.sessionId);
    try {
      await stream.waitForKind('history');
      opencode.setBusy(true);
      await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message?.type === 'status' && frame.message.status === 'running');
      const mark = stream.frames.length;
      // A deleted message makes the broker re-read and replace every client's window.
      opencode.publish({ type: 'message.removed', properties: { sessionID: opencode.sessionId, messageID: 'msg_gone' } });
      const reset = await stream.waitForFrame((frame) => frame.kind === 'history', { after: mark });
      // The streaming text may still be rewritten by the turn: it is not under the frame's cursor.
      expect(reset.messages.map((message: any) => message.type)).toEqual(['user-message', 'tool-call', 'tool-result']);
      const resetAt = stream.frames.indexOf(reset);
      const held = await stream.waitForFrame((frame) => frame.message?.key === 'prt_ha1', { after: resetAt + 1 });
      expect(held.message.text).toBe('working on it');
      await settled(stream);
      expect(copiesOf(stream, 'prt_ha1').slice(-1)[0]?.text).toBe('working on it');
      expect(transcriptKeys(stream).filter((key) => key === 'model-output:prt_ha1')).toHaveLength(1);
    } finally {
      opencode.setBusy(false);
      stream.close();
    }
  });
});

// ── Restart: identity outlives the broker process ───────────────────────────

describe('across a broker restart', () => {
  const THREAD_ONE = 'turn-before-restart';
  const ITEM_ONE = 'msg_before_restart';
  const THREAD_TWO = 'turn-after-restart';
  const ITEM_TWO = 'msg_after_restart';
  const ANSWER = 'The answer is 42.';
  let broker: Broker;
  let rollout: Rollout;
  const streams: SessionStream[] = [];

  /** The records Codex persists for one assistant item: the UI event, then the item carrying its id. */
  const assistantTurn = (turnId: string, itemId: string, text: string) => [
    { timestamp: '2026-07-25T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
    { timestamp: '2026-07-25T00:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: text, phase: 'final_answer' } },
    {
      timestamp: '2026-07-25T00:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', id: itemId, phase: 'final_answer', content: [{ type: 'output_text', text }] },
    },
    { timestamp: '2026-07-25T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
  ];
  const answers = (stream: SessionStream) => stream.messages().filter((message) => message.type === 'model-output');

  beforeAll(async () => {
    broker = await startBroker({
      name: 'identity-restart',
      setup: (paths) => {
        // An empty /proc: no Codex terminal presence, and no scan of the host's processes.
        mkdirSync(join(paths.root, 'proc'), { recursive: true });
        writeFileSync(join(paths.root, 'proc', 'uptime'), '5000.00 20000.00\n');
        rollout = writeRollout(paths.home, { day: '2026-07-25', rows: assistantTurn(THREAD_ONE, ITEM_ONE, ANSWER) });
      },
      env: (paths) => ({
        COSYNCING_CODEX_SYNC_SERVER: '0',
        COSYNCING_CODEX_PROC_ROOT: join(paths.root, 'proc'),
        COSYNCING_CODEX_APP_SERVER_SOCK: join(paths.root, 'no-codex-daemon.sock'),
      }),
    });
  });
  afterAll(async () => {
    for (const stream of streams) stream.close();
    await broker?.stop();
  });

  async function attach(tool: string, id: string, options: Parameters<BrokerClient['attach']>[2] = {}): Promise<SessionStream> {
    const stream = await broker.client().attach(tool, id, options);
    streams.push(stream);
    await stream.waitForKind('history');
    await settled(stream);
    return stream;
  }

  test('a persisted answer keeps its native identity, a turn written while the broker was down gets its own, and a reconnect holds both once', async () => {
    const pi = await openPiBridgeSession(broker, piUserRows('pi-before', 2), { title: 'pi restart' });
    const piBefore = await attach('pi', pi.id);
    const codexBefore = await attach('codex', rollout.id);
    const before = answers(codexBefore);
    expect(before.map((message) => [message.key, message.text, message.final])).toEqual([
      [`codex:${THREAD_ONE}:${ITEM_ONE}:t`, ANSWER, true],
    ]);
    const codexCursor = codexBefore.ofKind('history')[0]!.cursor;
    const piCursor = piBefore.ofKind('history')[0]!.cursor;
    const firstPid = broker.pid;

    // The agent keeps working while the broker is down: a second turn with byte-identical text.
    await broker.stop({ keepState: true });
    rollout.append(assistantTurn(THREAD_TWO, ITEM_TWO, ANSWER));
    await broker.start();
    expect(broker.pid).not.toBe(firstPid);

    const after = await attach('codex', rollout.id);
    expect(answers(after).map((message) => [message.key, message.text])).toEqual([
      [`codex:${THREAD_ONE}:${ITEM_ONE}:t`, ANSWER],
      [`codex:${THREAD_TWO}:${ITEM_TWO}:t`, ANSWER],
    ]);

    // The app reconnects with the cursor it held from the old process: whatever path the broker
    // takes (incremental or replacement), the client ends with each answer exactly once.
    const resumed = await attach('codex', rollout.id, { since: codexCursor });
    const merged = [...new Set([...transcriptKeys(codexBefore), ...transcriptKeys(resumed)])];
    const resumedFrame = resumed.ofKind('history')[0]!;
    const held = resumedFrame.reset === false ? merged : transcriptKeys(resumed);
    expect(held.filter((key) => key.startsWith('model-output:'))).toEqual([
      `model-output:codex:${THREAD_ONE}:${ITEM_ONE}:t`,
      `model-output:codex:${THREAD_TWO}:${ITEM_TWO}:t`,
    ]);

    // The Pi extension re-announces its session to the new process with its whole transcript; a
    // client reconnecting with its old cursor ends with every row once.
    await pi.rehello([...piUserRows('pi-before', 2), ...piUserRows('pi-after', 1)]);
    const piAgain = await attach('pi', pi.id, { since: piCursor });
    const piFrame = piAgain.ofKind('history')[0]!;
    const piHeld = piFrame.reset === false
      ? [...new Set([...transcriptKeys(piBefore), ...transcriptKeys(piAgain)])]
      : transcriptKeys(piAgain);
    expect(piHeld).toEqual([...piUserRows('pi-before', 2), ...piUserRows('pi-after', 1)].map((row) => `user-message:${row.key}`));
  });
});
