/**
 * Mutation idempotency: a client message id names one mutation, once, for good.
 *
 * The app keeps an outbox and resends anything it has no answer for: after a reconnect, after the
 * broker restarted, after the app itself restarted. The broker must answer a resend with the first
 * outcome and never hand the agent the same prompt twice; refuse an id reused for a different
 * mutation; and say honestly when it cannot know the outcome. These scenarios drive a real broker
 * over the app's wire and read what the agent actually received (the Pi extension's command queue,
 * the OpenCode server's prompt ledger) and what the broker keeps on disk.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Broker, type BrokerClient, eventually, type Frame, type SessionStream, startBroker } from '../harness/index.ts';
import { pairDevice } from '../harness/pairing.ts';
import { PiBridgeSession } from '../harness/fakes/pi-bridge-driver.ts';
import { type FakeOpenCodeServer, startFakeOpenCode } from '../harness/fakes/opencode-server.ts';
import { DAY, TestClock } from '../harness/fakes/test-clock.ts';

const JOURNAL = 'protocol-journal.json';

/** The prompts the Pi extension received, in order (first line of each). */
function promptsOf(pi: PiBridgeSession): string[] {
  return pi.commands.filter((command) => command.kind === 'prompt').map((command) => String(command.text).split('\n')[0]!);
}

/**
 * Wait until the extension received the prompt `text`, then list every prompt it received. A
 * sentinel sent after the mutations under test is the barrier: anything they dispatched is queued
 * before it.
 */
async function promptsThrough(pi: PiBridgeSession, text: string): Promise<string[]> {
  await pi.nextCommand((command) => command.kind === 'prompt' && String(command.text).startsWith(text), { what: `the "${text}" prompt` });
  return promptsOf(pi);
}

/** Send `message` with exactly this id (no fresh one) and wait for its ack or nack. */
function resend(stream: SessionStream, message: Record<string, unknown>): Promise<Frame> {
  return stream.sendAndAwait(message);
}

/** The broker's journal file, as text (empty when absent). */
function journalText(broker: Broker): string {
  const path = join(broker.paths.cosyncingHome, JOURNAL);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/**
 * The fingerprint revision 6 of the journal wrote for a flat prompt: SHA-256 (base64url) of the
 * message's JSON with keys sorted and `clientMessageId` left out. Written from the format, not by
 * calling the broker, so a broker that changes it fails here the way an upgraded install would.
 */
function journalFingerprint(message: { kind: string; text: string }): string {
  return createHash('sha256').update(JSON.stringify({ kind: message.kind, text: message.text })).digest('base64url');
}

/** A terminal journal record, in the on-disk shape. */
function terminalRecord(
  scope: { identity: string; tool: string; sessionId: string },
  message: { kind: string; text: string; clientMessageId: string },
  result: Record<string, unknown>,
): Record<string, unknown> {
  const now = Date.now();
  return {
    ...scope,
    clientMessageId: message.clientMessageId,
    mutationKind: message.kind,
    fingerprint: journalFingerprint(message),
    state: 'terminal',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 60_000,
    result: { clientMessageId: message.clientMessageId, ...result },
  };
}

function writeJournal(broker: Broker, records: Array<Record<string, unknown>>): void {
  writeFileSync(join(broker.paths.cosyncingHome, JOURNAL), JSON.stringify({ version: 1, idempotency: records, tickets: [] }));
}

// ── Within one broker run ────────────────────────────────────────────────────

describe('within one broker run', () => {
  let broker: Broker;
  let owner: BrokerClient;
  let opencode: FakeOpenCodeServer;
  let worktree: string;
  const streams: SessionStream[] = [];

  beforeAll(async () => {
    worktree = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-mutation-oc-'));
    opencode = startFakeOpenCode(worktree, 'ses_mutation');
    // With an owner credential, so a paired device is a second, distinct sender.
    broker = await startBroker({ name: 'mutation', token: true, env: { OPENCODE_URL: opencode.url } });
    owner = broker.client();
  });
  afterAll(async () => {
    for (const stream of streams) stream.close();
    await broker?.stop();
    opencode?.stop();
    rmSync(worktree, { recursive: true, force: true });
  });

  async function session(name: string): Promise<PiBridgeSession> {
    const cwd = join(broker.paths.root, 'work', name);
    mkdirSync(cwd, { recursive: true });
    return PiBridgeSession.open(owner, { cwd, title: name });
  }

  async function attach(client: BrokerClient, tool: string, id: string): Promise<SessionStream> {
    const stream = await client.attach(tool, id);
    streams.push(stream);
    await stream.waitForKind('history');
    return stream;
  }

  test('a resent prompt is answered from the journal, on the same socket and after a reconnect, and reaches the agent once', async () => {
    const pi = await session('resend');
    const prompt = { kind: 'prompt', text: 'ONCE', clientMessageId: 'resend-once' };
    const first = await attach(owner, 'pi', pi.id);
    const ack = await resend(first, prompt);
    expect([ack.kind, ack.ack, ack.duplicate]).toEqual(['ack', 'client-message', undefined]);

    const again = await resend(first, prompt);
    expect([again.kind, again.duplicate]).toEqual(['ack', true]);
    first.close();
    await first.closed;

    // The app reconnects and replays its outbox.
    const reconnected = await attach(owner, 'pi', pi.id);
    const replayed = await resend(reconnected, prompt);
    expect([replayed.kind, replayed.duplicate]).toEqual(['ack', true]);
    expect((await reconnected.sendAndAwait({ kind: 'prompt', text: 'sentinel' })).kind).toBe('ack');
    expect(await promptsThrough(pi, 'sentinel')).toEqual(['ONCE', 'sentinel']);
  });

  test('an id reused for a different mutation is refused, and the refusal reaches nothing', async () => {
    const pi = await session('conflict');
    const stream = await attach(owner, 'pi', pi.id);
    expect((await resend(stream, { kind: 'prompt', text: 'ORIGINAL', clientMessageId: 'reused' })).kind).toBe('ack');
    for (const different of [
      { kind: 'prompt', text: 'ORIGINAL, EDITED', clientMessageId: 'reused' },
      { kind: 'command', name: 'compact', clientMessageId: 'reused' },
      { kind: 'prompt', text: 'ORIGINAL', model: { providerID: 'p', modelID: 'm' }, clientMessageId: 'reused' },
    ]) {
      const refused = await resend(stream, different);
      expect([refused.kind, refused.code]).toEqual(['nack', 'CLIENT_MESSAGE_ID_CONFLICT']);
    }
    // The original is still answered as itself.
    expect((await resend(stream, { kind: 'prompt', text: 'ORIGINAL', clientMessageId: 'reused' })).duplicate).toBe(true);
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'sentinel' })).kind).toBe('ack');
    expect(await promptsThrough(pi, 'sentinel')).toEqual(['ORIGINAL', 'sentinel']);
    expect(pi.commands.some((command) => command.kind === 'command' || command.kind === 'set-model')).toBe(false);
  });

  test('a refused mutation is replayed as the same refusal', async () => {
    const pi = await session('refusal');
    const stream = await attach(owner, 'pi', pi.id);
    const forged = { kind: 'prompt', text: 'NEVER', permissionMode: 'forged-bypass', clientMessageId: 'refused-once' };
    const first = await resend(stream, forged);
    expect([first.kind, first.code, first.duplicate]).toEqual(['nack', 'PERMISSION_MODE_UNSUPPORTED', undefined]);
    const replay = await resend(stream, forged);
    expect([replay.kind, replay.code, replay.duplicate]).toEqual(['nack', 'PERMISSION_MODE_UNSUPPORTED', true]);
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'sentinel' })).kind).toBe('ack');
    expect(await promptsThrough(pi, 'sentinel')).toEqual(['sentinel']);
  });

  test('an id belongs to its sender and its session: another device or another session may use it', async () => {
    const one = await session('scope-one');
    const two = await session('scope-two');
    const phone = await pairDevice(owner, { peerId: 'mutation-phone' });
    const asPhone = owner.as({ kind: 'peer', peerToken: phone.peerToken });
    const id = 'same-id-everywhere';

    const ownerOne = await attach(owner, 'pi', one.id);
    expect((await resend(ownerOne, { kind: 'prompt', text: 'owner on one', clientMessageId: id })).duplicate).toBeUndefined();
    const phoneOne = await attach(asPhone, 'pi', one.id);
    expect((await resend(phoneOne, { kind: 'prompt', text: 'phone on one', clientMessageId: id })).duplicate).toBeUndefined();
    const ownerTwo = await attach(owner, 'pi', two.id);
    expect((await resend(ownerTwo, { kind: 'prompt', text: 'owner on two', clientMessageId: id })).duplicate).toBeUndefined();

    expect((await ownerOne.sendAndAwait({ kind: 'prompt', text: 'sentinel one' })).kind).toBe('ack');
    expect(await promptsThrough(one, 'sentinel one')).toEqual(['owner on one', 'phone on one', 'sentinel one']);
    expect((await ownerTwo.sendAndAwait({ kind: 'prompt', text: 'sentinel two' })).kind).toBe('ack');
    expect(await promptsThrough(two, 'sentinel two')).toEqual(['owner on two', 'sentinel two']);
  });

  test('a resend that arrives while the first is still being delivered is told it is pending, then gets the outcome', async () => {
    const prompt = { kind: 'prompt', text: 'slow to deliver', clientMessageId: 'in-flight' };
    const first = await attach(owner, 'opencode', opencode.sessionId);
    const delivery = opencode.holdPrompts();
    first.send(prompt);
    await delivery.started;

    // The app lost its socket mid-send and replays from a new one.
    const second = await attach(owner, 'opencode', opencode.sessionId);
    const pending = await resend(second, prompt);
    expect([pending.kind, pending.duplicate, pending.pending]).toEqual(['ack', true, true]);

    delivery.release();
    const outcome = await first.waitForFrame((frame) => frame.kind === 'ack' && frame.clientMessageId === 'in-flight' && !frame.duplicate);
    expect(outcome.ack).toBe('client-message');
    const settled = await resend(second, prompt);
    expect([settled.kind, settled.duplicate, settled.pending]).toEqual(['ack', true, undefined]);
    expect(opencode.prompts.filter((candidate) => candidate.text === 'slow to deliver')).toHaveLength(1);
  });
});

// ── Across restarts and on-disk journals ─────────────────────────────────────

describe('across broker restarts', () => {
  let broker: Broker;
  let owner: BrokerClient;
  let opencode: FakeOpenCodeServer;
  let worktree: string;
  let pi: PiBridgeSession;
  const streams: SessionStream[] = [];

  beforeAll(async () => {
    worktree = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-mutation-restart-oc-'));
    opencode = startFakeOpenCode(worktree, 'ses_restart');
    broker = await startBroker({ name: 'mutation-restart', env: { OPENCODE_URL: opencode.url } });
    owner = broker.client();
    const cwd = join(broker.paths.root, 'work', 'restart');
    mkdirSync(cwd, { recursive: true });
    pi = await PiBridgeSession.open(owner, { cwd, title: 'restart' });
  });
  afterAll(async () => {
    for (const stream of streams) stream.close();
    await broker?.stop();
    opencode?.stop();
    rmSync(worktree, { recursive: true, force: true });
  });

  async function attach(tool: string, id: string, options: Parameters<BrokerClient['attach']>[2] = {}): Promise<SessionStream> {
    const stream = await owner.attach(tool, id, options);
    streams.push(stream);
    await stream.waitForKind('history');
    return stream;
  }

  /** Restart on the same state, as a service restart or an upgrade would; the extension re-announces. */
  async function restart(options: { crash?: boolean; before?: () => void } = {}): Promise<void> {
    if (options.crash) await broker.crash();
    else await broker.stop({ keepState: true });
    options.before?.();
    await broker.start();
    await pi.rehello();
  }

  /** The prompts the extension received after the ledger held `from` of them. */
  const promptsSince = (from: number) => promptsOf(pi).slice(from);

  test('acks and refusals, including a failed draft clear and its retry target, replay after a restart without the prompt text on disk', async () => {
    const stream = await attach('pi', pi.id);
    const prompt = { kind: 'prompt', text: 'RESTART_ONCE', clientMessageId: 'restart-ack' };
    const refused = { kind: 'prompt', text: 'NEVER_DISPATCH', permissionMode: 'forged', clientMessageId: 'restart-nack' };
    expect((await resend(stream, prompt)).kind).toBe('ack');
    expect((await resend(stream, refused)).code).toBe('PERMISSION_MODE_UNSUPPORTED');

    // A shared draft holds the text the next prompt sends, and its store then refuses the clear:
    // the prompt is accepted, but the sender must keep its draft and retry the clear later.
    // Another of the user's devices sees the shared draft and its revision.
    const tablet = await attach('pi', pi.id);
    // Typed on top of the shared draft revision this client last saw (the earlier prompts cleared it).
    const base = Number(stream.ofKind('draft').at(-1)?.revision ?? 0);
    stream.send({ kind: 'draft', text: 'DRAFTED THEN SENT', updateId: 'draft-1', baseRevision: base });
    const drafted = await tablet.waitForFrame((frame) => frame.kind === 'draft' && frame.text === 'DRAFTED THEN SENT');
    const drafts = join(broker.paths.cosyncingHome, 'drafts');
    const shard = readdirSync(drafts)
      .map((name) => join(drafts, name))
      .find((path) => !path.endsWith('.json.tmp') && readFileSync(path, 'utf8').includes('DRAFTED THEN SENT'));
    expect(shard).toBeDefined();
    // A non-empty directory where the shard file goes: every write of it fails, on every platform.
    rmSync(shard!);
    mkdirSync(join(shard!, 'blocked'), { recursive: true });
    const draftPrompt = { kind: 'prompt', text: 'DRAFTED THEN SENT', draftRevision: drafted.revision, clientMessageId: 'restart-draft' };
    const kept = await resend(stream, draftPrompt);
    expect([kept.kind, kept.draftCleared]).toEqual(['ack', false]);
    expect(typeof kept.draftRevision).toBe('number');
    rmSync(shard!, { recursive: true, force: true });
    expect(await promptsThrough(pi, 'DRAFTED THEN SENT')).toEqual(['RESTART_ONCE', 'DRAFTED THEN SENT']);

    // The journal is bookkeeping, never a copy of what was said.
    const onDisk = journalText(broker);
    expect(onDisk).toContain('restart-ack');
    for (const text of ['RESTART_ONCE', 'NEVER_DISPATCH', 'DRAFTED THEN SENT']) expect(onDisk).not.toContain(text);

    const before = promptsOf(pi).length;
    await restart();
    const reattached = await attach('pi', pi.id);
    const ack = await resend(reattached, prompt);
    expect([ack.kind, ack.duplicate]).toEqual(['ack', true]);
    const nack = await resend(reattached, refused);
    expect([nack.kind, nack.code, nack.duplicate]).toEqual(['nack', 'PERMISSION_MODE_UNSUPPORTED', true]);
    const draft = await resend(reattached, draftPrompt);
    expect([draft.kind, draft.duplicate, draft.draftCleared, draft.draftRevision]).toEqual(['ack', true, false, kept.draftRevision]);
    expect((await reattached.sendAndAwait({ kind: 'prompt', text: 'sentinel after restart' })).kind).toBe('ack');
    await promptsThrough(pi, 'sentinel after restart');
    expect(promptsSince(before)).toEqual(['sentinel after restart']);
  });

  test('a mutation in flight when the broker dies gets an unknown outcome, and is never delivered again', async () => {
    const prompt = { kind: 'prompt', text: 'lost with the broker', clientMessageId: 'crash-in-flight' };
    const stream = await attach('opencode', opencode.sessionId);
    const delivery = opencode.holdPrompts();
    stream.send(prompt);
    await delivery.started;
    await restart({ crash: true, before: () => delivery.release() });

    for (const round of ['after the crash', 'after another restart']) {
      const again = await attach('opencode', opencode.sessionId);
      const answer = await resend(again, prompt);
      expect([round, answer.kind, answer.code, answer.duplicate]).toEqual([round, 'nack', 'CLIENT_MESSAGE_OUTCOME_UNKNOWN', true]);
      expect(opencode.prompts.filter((candidate) => candidate.text === 'lost with the broker')).toHaveLength(1);
      if (round === 'after the crash') await restart();
    }
  });

  test('an outcome recorded before client profiles existed still answers a profile-scoped resend', async () => {
    // Revision 6 keyed the journal by credential only; the app now attaches with its profile and
    // installation. An outbox replay across that upgrade must still find the recorded outcome.
    const prompt = { kind: 'prompt', text: 'PRE_A1_ALREADY_DELIVERED', clientMessageId: 'revision-6-outbox-replay' };
    const before = promptsOf(pi).length;
    await restart({
      before: () => writeJournal(broker, [
        terminalRecord({ identity: 'loopback-local', tool: 'pi', sessionId: pi.id }, prompt, { kind: 'ack', ack: 'client-message' }),
      ]),
    });
    const stream = await attach('pi', pi.id, {
      params: { clientProfileId: 'profile-after-upgrade', clientProfileIncarnation: 'incarnation-a1' },
    });
    const replay = await resend(stream, prompt);
    expect([replay.kind, replay.duplicate]).toEqual(['ack', true]);
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'sentinel after upgrade' })).kind).toBe('ack');
    await promptsThrough(pi, 'sentinel after upgrade');
    expect(promptsSince(before)).toEqual(['sentinel after upgrade']);
  });

  test('an unreadable journal, or one whose failed clear lost its retry target, is set aside and the broker starts clean', async () => {
    const quarantined = () => readdirSync(broker.paths.cosyncingHome).filter((name) => name.startsWith(`${JOURNAL}.corrupt-`));
    const already = quarantined().length;
    await restart({ before: () => writeFileSync(join(broker.paths.cosyncingHome, JOURNAL), '{broken') });
    expect(quarantined()).toHaveLength(already + 1);

    // A failed-clear record without the revision a retry needs would make the sender empty a draft
    // another device typed since: the whole file is distrusted, so the resend runs for real.
    const prompt = { kind: 'prompt', text: 'BAD_CLEAR_RECORD', clientMessageId: 'bad-clear' };
    await restart({
      before: () => writeJournal(broker, [
        terminalRecord({ identity: 'loopback-local', tool: 'pi', sessionId: pi.id }, prompt, {
          kind: 'ack', ack: 'client-message', draftCleared: false,
        }),
      ]),
    });
    expect(quarantined()).toHaveLength(already + 2);
    const stream = await attach('pi', pi.id);
    const answer = await resend(stream, prompt);
    expect([answer.kind, answer.duplicate]).toEqual(['ack', undefined]);
    expect(await promptsThrough(pi, 'BAD_CLEAR_RECORD')).toContain('BAD_CLEAR_RECORD');
  });
});

// ── Retention and bounds ─────────────────────────────────────────────────────

describe('how long and how much the journal remembers', () => {
  let broker: Broker;
  let owner: BrokerClient;
  let clock!: TestClock;
  let opencode: FakeOpenCodeServer;
  let worktree: string;
  const streams: SessionStream[] = [];

  beforeAll(async () => {
    worktree = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-mutation-bounds-oc-'));
    opencode = startFakeOpenCode(worktree, 'ses_bounds');
    broker = await startBroker({
      name: 'mutation-bounds',
      env: (paths) => ({
        ...(clock = new TestClock(paths.root)).env,
        OPENCODE_URL: opencode.url,
        // Test hook: a two-entry journal, so its bound is reachable.
        COSYNCING_TEST_PROTOCOL_JOURNAL_MAX_ENTRIES: '2',
      }),
    });
    owner = broker.client();
  });
  afterAll(async () => {
    for (const stream of streams) stream.close();
    await broker?.stop();
    opencode?.stop();
    rmSync(worktree, { recursive: true, force: true });
  });

  async function attach(tool: string, id: string): Promise<SessionStream> {
    const stream = await owner.attach(tool, id);
    streams.push(stream);
    await stream.waitForKind('history');
    return stream;
  }

  async function session(name: string): Promise<PiBridgeSession> {
    const cwd = join(broker.paths.root, 'work', name);
    mkdirSync(cwd, { recursive: true });
    return PiBridgeSession.open(owner, { cwd, title: name });
  }

  test('an outcome and an attach receipt are remembered for a week, then forgotten', async () => {
    const pi = await session('retention');
    const stream = await attach('pi', pi.id);
    const ticket = stream.ofKind('history')[0]!.attachTicket;
    expect(typeof ticket).toBe('string');
    const prompt = { kind: 'prompt', text: 'remembered for a week', clientMessageId: 'week-old' };
    expect((await resend(stream, prompt)).duplicate).toBeUndefined();

    clock.advance(6 * DAY);
    expect((await resend(stream, prompt)).duplicate).toBe(true);
    // The unreceipted attach ticket is still held after six days.
    expect(JSON.parse(journalText(broker)).tickets).toHaveLength(1);
    clock.advance(2 * DAY);
    // Past retention the id is free again: the resend is a new mutation, and so is other content.
    expect((await resend(stream, prompt)).duplicate).toBeUndefined();
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'sentinel' })).kind).toBe('ack');
    expect(await promptsThrough(pi, 'sentinel')).toEqual(['remembered for a week', 'remembered for a week', 'sentinel']);
    const receipt = await stream.sendAndAwait({ kind: 'ack', attachTicket: ticket });
    expect([receipt.kind, receipt.code]).toEqual(['nack', 'ACK_UNKNOWN_TARGET']);
  });

  test('a full journal evicts its oldest finished outcome, and refuses a new mutation while every entry is in flight', async () => {
    const pi = await session('bounds');
    const stream = await attach('pi', pi.id);
    for (const id of ['bound-1', 'bound-2', 'bound-3']) {
      expect((await resend(stream, { kind: 'prompt', text: id, clientMessageId: id })).duplicate).toBeUndefined();
    }
    // bound-1 was evicted to make room for bound-3: its resend is delivered again.
    expect((await resend(stream, { kind: 'prompt', text: 'bound-3', clientMessageId: 'bound-3' })).duplicate).toBe(true);
    expect((await resend(stream, { kind: 'prompt', text: 'bound-1', clientMessageId: 'bound-1' })).duplicate).toBeUndefined();
    expect(await promptsThrough(pi, 'bound-1')).toEqual(['bound-1', 'bound-2', 'bound-3', 'bound-1']);

    // Two deliveries held in flight fill the journal; nothing finished is left to evict.
    const delivery = opencode.holdPrompts();
    const first = await attach('opencode', opencode.sessionId);
    const second = await attach('opencode', opencode.sessionId);
    first.send({ kind: 'prompt', text: 'held one', clientMessageId: 'held-1' });
    await delivery.started;
    second.send({ kind: 'prompt', text: 'held two', clientMessageId: 'held-2' });
    // A mutation is journalled before it is delivered: once held-2 is on disk, both are in flight.
    await eventually(() => journalText(broker).includes('"held-2"'), { what: 'held-2 claimed in the journal' });
    const refused = await resend(stream, { kind: 'prompt', text: 'no room', clientMessageId: 'no-room' });
    expect([refused.kind, refused.code]).toEqual(['nack', 'CLIENT_MESSAGE_JOURNAL_FULL']);

    delivery.release();
    await first.waitForFrame((frame) => frame.kind === 'ack' && frame.clientMessageId === 'held-1' && !frame.duplicate);
    await second.waitForFrame((frame) => frame.kind === 'ack' && frame.clientMessageId === 'held-2' && !frame.duplicate);
    // With finished outcomes to evict again, the refused mutation goes through when resent.
    expect((await resend(stream, { kind: 'prompt', text: 'no room', clientMessageId: 'no-room' })).kind).toBe('ack');
    expect(await promptsThrough(pi, 'no room')).toEqual(['bound-1', 'bound-2', 'bound-3', 'bound-1', 'no room']);
  });
});
