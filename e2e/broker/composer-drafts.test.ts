/**
 * Shared composer drafts: every device attached to a session shares one unsent draft.
 *
 * A draft typed on one device reaches the others with a broker-assigned revision; the broker
 * arbitrates reconnect retries and stale offline edits by revision and update id (never by client
 * clocks), keeps the draft across a broker restart, tells a device that was away that the draft was
 * cleared, and clears on Send only the draft the sender actually saw. What it cannot store durably
 * it never acknowledges or broadcasts.
 *
 * Sessions come from the Pi bridge (no agent binary). Retention runs on the broker's test clock,
 * and a second broker lowers the draft cap (`COSYNCING_TEST_DRAFT_MAX_SESSIONS`) to show LRU
 * eviction with a handful of sessions.
 *
 * "Nothing arrives" is never a wait: the client that must not receive a frame then writes a draft
 * of its own, and its own echo, which the broker sends after anything it would have sent before,
 * is the sentinel.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AttachOptions, type Broker, type BrokerClient, type Frame, type SessionStream, startBroker } from '../harness/index.ts';
import { PiBridgeSession } from '../harness/fakes/pi-bridge-driver.ts';
import { DAY, HOUR, TestClock } from '../harness/fakes/test-clock.ts';
import { MAX_SHARED_DRAFT_TEXT_CHARS } from '../../packages/typescript/broker/src/sessions/draft-store.ts';

/** The last contract revision before versioned drafts: it has no revision to compare a clear with. */
const PRE_DRAFT_REVISION = { contractRevision: '2', minimumBrokerRevision: '0' };

let updates = 0;
const updateId = (label: string): string => `${label}-${++updates}`;

class Drafts {
  readonly #broker: Broker;
  readonly #live: PiBridgeSession[] = [];
  readonly #streams: SessionStream[] = [];

  constructor(broker: Broker) {
    this.#broker = broker;
  }

  get client(): BrokerClient {
    return this.#broker.client();
  }

  async session(name: string): Promise<PiBridgeSession> {
    const cwd = join(this.#broker.paths.root, 'work', name);
    mkdirSync(cwd, { recursive: true });
    const pi = await PiBridgeSession.open(this.client, { cwd, title: name });
    this.#live.push(pi);
    return pi;
  }

  /** A device attached to `pi`, once its attach has finished (history is the first thing it gets). */
  async device(pi: PiBridgeSession, options: AttachOptions = {}): Promise<SessionStream> {
    const stream = await this.client.attach('pi', pi.id, options);
    this.#streams.push(stream);
    await stream.waitForKind('history');
    return stream;
  }

  /** After a broker restart the Pi extension announces its sessions again. */
  async reannounce(): Promise<void> {
    for (const pi of this.#live) await pi.rehello();
  }

  closeAll(): void {
    for (const stream of this.#streams.splice(0)) stream.close();
  }

  /** The shard file holding one session's draft, found by what it says it holds. */
  shard(pi: PiBridgeSession): string {
    const directory = join(this.#broker.paths.cosyncingHome, 'drafts');
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.json') || name === 'revision-clock.json') continue;
      const path = join(directory, name);
      try {
        const body = JSON.parse(readFileSync(path, 'utf8'));
        if (body.tool === 'pi' && body.sessionId === pi.id) return path;
      } catch {
        // Another session's shard mid-replace; not the one wanted.
      }
    }
    throw new Error(`no draft shard for pi/${pi.id}`);
  }
}

function drafts(stream: SessionStream, after = 0): Frame[] {
  return stream.frames.slice(after).filter((frame) => frame.kind === 'draft');
}

function write(stream: SessionStream, text: string, id: string, baseRevision?: number): void {
  stream.send({ kind: 'draft', text, updateId: id, ...(baseRevision === undefined ? {} : { baseRevision }) });
}

/** The first draft frame from `after` on that matches. */
function nextDraft(stream: SessionStream, after: number, predicate: (frame: Frame) => boolean, what: string): Promise<Frame> {
  return stream.waitForFrame((frame) => frame.kind === 'draft' && predicate(frame), { after, what });
}

/** Write a draft and wait for the writer's own echo of it. */
async function typed(stream: SessionStream, text: string, baseRevision: number, label = 'typed'): Promise<Frame> {
  const after = stream.frames.length;
  const id = updateId(label);
  write(stream, text, id, baseRevision);
  return nextDraft(stream, after, (frame) => frame.updateId === id, `the echo of ${id}`);
}

/**
 * The drafts a device was replayed when it joined. It then asks for an invalid history page: the
 * broker handles nothing a device sends before its attach (draft replay included) is complete, so
 * the refusal follows everything the attach replayed, and asking changes no draft.
 */
async function replayedOnJoin(stream: SessionStream): Promise<Frame[]> {
  const clientMessageId = updateId('sentinel');
  stream.send({ kind: 'history-page', limit: 0, clientMessageId });
  const refusal = await stream.waitForFrame(
    (frame) => frame.kind === 'nack' && frame.clientMessageId === clientMessageId,
    { what: 'the sentinel refusal' },
  );
  return stream.frames.slice(0, stream.frames.indexOf(refusal)).filter((frame) => frame.kind === 'draft');
}

describe('shared composer drafts', () => {
  let broker: Broker;
  let clock: TestClock;
  let world: Drafts;

  beforeAll(async () => {
    broker = await startBroker({ name: 'drafts', env: (paths) => (clock = new TestClock(paths.root)).env });
    world = new Drafts(broker);
  });
  afterAll(async () => {
    world?.closeAll();
    await broker?.stop();
  });

  test('a draft typed on one device reaches every device with the broker revision and the writer’s update id', async () => {
    const pi = await world.session('fan-out');
    const phone = await world.device(pi);
    const laptop = await world.device(pi);

    const id = updateId('phone');
    write(phone, 'typed on the phone', id, 0);
    const echo = await nextDraft(phone, 0, (frame) => frame.updateId === id, 'the phone’s echo');
    const seen = await nextDraft(laptop, 0, (frame) => frame.text === 'typed on the phone', 'the draft on the laptop');
    expect(echo).toMatchObject({ text: 'typed on the phone', updateId: id });
    expect(echo.revision).toBeGreaterThan(0);
    expect(seen).toMatchObject({ text: 'typed on the phone', updateId: id, revision: echo.revision });

    // The laptop carries on from that revision: an ordinary edit, applied at a later one.
    const edit = await typed(laptop, 'edited on the laptop', echo.revision);
    expect(edit.revision).toBeGreaterThan(echo.revision);
    await nextDraft(phone, 0, (frame) => frame.revision === edit.revision && frame.text === 'edited on the laptop', 'the edit on the phone');
  });

  test('a stale offline edit is refused, and only its writer hears about it, with the current draft', async () => {
    const pi = await world.session('stale');
    const phone = await world.device(pi);
    const laptop = await world.device(pi);
    const first = await typed(phone, 'first', 0);
    const current = await typed(laptop, 'laptop typed later', first.revision);

    // The phone reconnects and retries an edit it made against the first revision.
    const laptopMark = laptop.frames.length;
    const phoneMark = phone.frames.length;
    write(phone, 'stale offline edit', updateId('offline'), first.revision);
    const answer = await nextDraft(phone, phoneMark, () => true, 'the answer to the stale edit');
    expect(answer).toMatchObject({ text: 'laptop typed later', revision: current.revision });

    // The phone resolves the conflict against the current revision; the laptop hears only that.
    const resolved = await typed(phone, 'resolved on the phone', current.revision);
    await nextDraft(laptop, laptopMark, (frame) => frame.revision === resolved.revision, 'the resolved draft on the laptop');
    expect(drafts(laptop, laptopMark).map((frame) => frame.text)).toEqual(['resolved on the phone']);
  });

  test('a retried update changes nothing and is not sent to the other devices', async () => {
    const pi = await world.session('retry');
    const phone = await world.device(pi);
    const laptop = await world.device(pi);
    const id = updateId('once');
    write(phone, 'sent once', id, 0);
    const applied = await nextDraft(laptop, 0, (frame) => frame.updateId === id, 'the first send on the laptop');

    const phoneMark = phone.frames.length;
    const laptopMark = laptop.frames.length;
    write(phone, 'sent once', id, 0); // a reconnect retry of the same update
    const answer = await nextDraft(phone, phoneMark, () => true, 'the answer to the retry');
    expect(answer).toMatchObject({ text: 'sent once', revision: applied.revision, updateId: id });

    const next = await typed(phone, 'a real edit', applied.revision);
    await nextDraft(laptop, laptopMark, (frame) => frame.revision === next.revision, 'the next edit on the laptop');
    expect(drafts(laptop, laptopMark).map((frame) => frame.text)).toEqual(['a real edit']);
  });

  test('a device that was away learns the draft was cleared; a pre-revision client is not sent an empty draft', async () => {
    const pi = await world.session('tombstone');
    const phone = await world.device(pi);
    const draft = await typed(phone, 'about to be cleared', 0);
    const cleared = await typed(phone, '', draft.revision);
    expect(cleared.revision).toBeGreaterThan(draft.revision);

    const tablet = await world.device(pi);
    expect(await replayedOnJoin(tablet)).toEqual([
      expect.objectContaining({ text: '', revision: cleared.revision }),
    ]);

    // An older app cannot compare revisions; an empty draft would only wipe its composer.
    const old = await world.device(pi, { params: PRE_DRAFT_REVISION });
    expect(await replayedOnJoin(old)).toEqual([]);
  });

  test('a device attached Observe-only cannot prompt but can still edit the shared draft', async () => {
    const pi = await world.session('observe');
    const driver = await world.device(pi);
    const watcher = await world.device(pi, { readOnly: true });

    const refused = await watcher.sendAndAwait({ kind: 'prompt', text: 'not from a read-only device' });
    expect(refused.kind).toBe('nack');
    const edit = await typed(watcher, 'typed while observing', 0);
    await nextDraft(driver, 0, (frame) => frame.revision === edit.revision && frame.text === 'typed while observing', 'the observer’s draft on the driver');
  });

  test('sending clears only the draft the sender saw; another device’s newer draft survives', async () => {
    const pi = await world.session('send');
    const phone = await world.device(pi);
    const laptop = await world.device(pi);
    const seenByPhone = await typed(phone, 'phone text', 0);
    const newer = await typed(laptop, 'laptop typed this later', seenByPhone.revision);

    // The phone sends what it saw. The agent gets it; the laptop's newer draft is not erased.
    const sent = await phone.sendAndAwait({ kind: 'prompt', text: 'phone text', draftRevision: seenByPhone.revision });
    expect(sent.kind).toBe('ack');
    expect(sent.draftCleared).toBeUndefined();
    await pi.nextCommand((command) => command.text === 'phone text', { what: 'the phone’s prompt at the agent' });
    const late = await world.device(pi);
    expect(await replayedOnJoin(late)).toEqual([
      expect.objectContaining({ text: 'laptop typed this later', revision: newer.revision }),
    ]);

    // The laptop sends its draft: that one is cleared on every device.
    const laptopSent = await laptop.sendAndAwait({ kind: 'prompt', text: 'laptop typed this later', draftRevision: newer.revision });
    expect(laptopSent.kind).toBe('ack');
    await nextDraft(phone, 0, (frame) => frame.text === '' && frame.revision > newer.revision, 'the clear on the phone');
    await pi.nextCommand((command) => command.text === 'laptop typed this later', { what: 'the laptop’s prompt at the agent' });
  });

  test('a Send that races its own unacknowledged draft clears it, and the sent text proves ownership', async () => {
    const pi = await world.session('race');
    const phone = await world.device(pi);
    const laptop = await world.device(pi);

    // The draft and the prompt ride one socket; the prompt still names the revision before the draft.
    const id = updateId('racing');
    write(phone, 'racing prompt', id, 0);
    const sent = await phone.sendAndAwait({ kind: 'prompt', text: 'racing prompt', draftRevision: 0, draftUpdateId: id });
    expect(sent.kind).toBe('ack');
    const applied = await nextDraft(laptop, 0, (frame) => frame.updateId === id, 'the racing draft on the laptop');
    const racedClear = await nextDraft(laptop, 0, (frame) => frame.text === '' && frame.revision > applied.revision, 'the clear after the racing send');

    // A debounced re-send of the same text moved both the revision and the update id past what the
    // prompt reports; the shared draft is still exactly the sent text, so it is the sender's to clear.
    const first = await typed(phone, 'sent prompt text', racedClear.revision);
    const again = await typed(phone, 'sent prompt text', first.revision);
    const resent = await phone.sendAndAwait({ kind: 'prompt', text: 'sent prompt text', draftRevision: first.revision, draftUpdateId: first.updateId });
    expect(resent.kind).toBe('ack');
    const textClear = await nextDraft(laptop, 0, (frame) => frame.text === '' && frame.revision > again.revision, 'the clear proven by text');

    // The text proof never clears someone else's different draft.
    const mine = await typed(phone, 'my draft', textClear.revision);
    const theirs = await typed(laptop, 'their newer draft', mine.revision);
    expect((await phone.sendAndAwait({ kind: 'prompt', text: 'my draft', draftRevision: mine.revision, draftUpdateId: mine.updateId })).kind).toBe('ack');
    const late = await world.device(pi);
    expect(await replayedOnJoin(late)).toEqual([
      expect.objectContaining({ text: 'their newer draft', revision: theirs.revision }),
    ]);
  });

  test('an oversized draft is refused and the shared draft is unchanged', async () => {
    const pi = await world.session('oversized');
    const phone = await world.device(pi);
    const laptop = await world.device(pi);
    const kept = await typed(phone, 'small draft', 0);
    const laptopMark = laptop.frames.length;
    const phoneMark = phone.frames.length;
    write(phone, 'x'.repeat(MAX_SHARED_DRAFT_TEXT_CHARS + 1), updateId('huge'), kept.revision);
    const next = await typed(phone, 'after the refusal', kept.revision);
    const answers = phone.frames.slice(phoneMark).filter((frame) => frame.kind === 'error' || frame.kind === 'draft');
    expect(answers.map((frame) => frame.kind)).toEqual(['error', 'draft']);
    expect(answers[0]!.message).toContain(`exceeds ${MAX_SHARED_DRAFT_TEXT_CHARS} characters`);
    // Had the huge draft been applied, this edit would be a stale base and the laptop would see nothing.
    await nextDraft(laptop, laptopMark, (frame) => frame.revision === next.revision, 'the next edit on the laptop');
    expect(drafts(laptop, laptopMark).map((frame) => frame.text)).toEqual(['after the refusal']);
  });

  test('a Send whose clear cannot be stored is still acknowledged, says so, broadcasts nothing, and replays the same answer', async () => {
    const pi = await world.session('unstorable');
    const phone = await world.device(pi);
    const laptop = await world.device(pi);
    const held = await typed(phone, 'the text being sent', 0);

    // The draft's shard path becomes a directory: the store's write now fails, as a full disk does.
    const shard = world.shard(pi);
    rmSync(shard, { force: true });
    mkdirSync(shard);
    try {
      const prompt = { kind: 'prompt', text: 'the text being sent', clientMessageId: updateId('cm'), draftRevision: held.revision };
      const laptopMark = laptop.frames.length;
      const ack = await phone.sendAndAwait(prompt);
      expect(ack).toMatchObject({ kind: 'ack', draftCleared: false, draftRevision: held.revision });
      await pi.nextCommand((command) => command.text === 'the text being sent', { what: 'the prompt at the agent' });

      // The sender crashed before settling and replays the identical frame: the journal answers it.
      const replay = await phone.sendAndAwait(prompt);
      expect(replay).toMatchObject({ kind: 'ack', duplicate: true, draftCleared: false, draftRevision: held.revision });

      // An edit while the disk is still failing is not applied: no echo, no broadcast. The next
      // prompt from the same socket is handled after it, and still finds the store failing.
      write(phone, 'lost while failing', updateId('lost'), held.revision);
      const after = await phone.sendAndAwait({ kind: 'prompt', text: 'the text being sent', draftRevision: held.revision });
      expect(after).toMatchObject({ kind: 'ack', draftCleared: false, draftRevision: held.revision });
      rmSync(shard, { recursive: true, force: true });
      const recovered = await typed(phone, 'sent once the disk recovers', held.revision);
      await nextDraft(laptop, laptopMark, (frame) => frame.revision === recovered.revision, 'the recovered draft on the laptop');
      expect(drafts(laptop, laptopMark).map((frame) => frame.text)).toEqual(['sent once the disk recovers']);

      const cleared = await phone.sendAndAwait({ kind: 'prompt', text: 'sent once the disk recovers', draftRevision: recovered.revision });
      expect(cleared.kind).toBe('ack');
      expect('draftCleared' in cleared).toBe(false);
      await nextDraft(laptop, laptopMark, (frame) => frame.text === '' && frame.revision > recovered.revision, 'the clear on the laptop');
    } finally {
      rmSync(shard, { recursive: true, force: true });
    }
  });

  test('drafts survive a broker restart and revisions keep rising; a corrupt shard is set aside while the others load', async () => {
    const kept = await world.session('restart-kept');
    const corrupted = await world.session('restart-corrupt');
    const keptDraft = await typed(await world.device(kept), 'must survive a restart', 0);
    const corruptDraft = await typed(await world.device(corrupted), 'will be corrupted', 0);
    world.closeAll();

    await broker.restart();
    await world.reannounce();
    const back = await world.device(kept);
    expect(await replayedOnJoin(back)).toEqual([
      expect.objectContaining({ text: 'must survive a restart', revision: keptDraft.revision }),
    ]);
    const continued = await typed(back, 'edited after the restart', keptDraft.revision);
    expect(continued.revision).toBeGreaterThan(Math.max(keptDraft.revision, corruptDraft.revision));

    const shard = world.shard(corrupted);
    world.closeAll();
    await broker.stop({ keepState: true });
    writeFileSync(shard, '{not json');
    await broker.start();
    await world.reannounce();
    expect(readdirSync(join(broker.paths.cosyncingHome, 'drafts')).some((name) => name.includes('.corrupt-'))).toBe(true);
    expect(existsSync(shard)).toBe(false);
    expect(await replayedOnJoin(await world.device(corrupted))).toEqual([]);
    expect(await replayedOnJoin(await world.device(kept))).toEqual([
      expect.objectContaining({ text: 'edited after the restart', revision: continued.revision }),
    ]);
    world.closeAll();
  });

  test('an abandoned draft expires after 30 days and is never replayed as a clear; a clear is replayed for as long', async () => {
    const abandoned = await world.session('ttl-abandoned');
    const cleared = await world.session('ttl-cleared');
    const draft = await typed(await world.device(abandoned), 'left behind', 0);
    const writer = await world.device(cleared);
    const tombstone = await typed(writer, '', (await typed(writer, 'sent text', 0)).revision);
    world.closeAll();

    await broker.stop({ keepState: true });
    clock.advance(30 * DAY - HOUR);
    await broker.start();
    await world.reannounce();
    expect(await replayedOnJoin(await world.device(abandoned))).toEqual([
      expect.objectContaining({ text: 'left behind', revision: draft.revision }),
    ]);
    expect(await replayedOnJoin(await world.device(cleared))).toEqual([
      expect.objectContaining({ text: '', revision: tombstone.revision }),
    ]);
    world.closeAll();

    await broker.stop({ keepState: true });
    clock.advance(2 * HOUR);
    await broker.start();
    await world.reannounce();
    // Expired is not cleared: a device may hold the last copy of that text, and an empty draft would delete it.
    expect(await replayedOnJoin(await world.device(abandoned))).toEqual([]);
    expect(await replayedOnJoin(await world.device(cleared))).toEqual([]);
    world.closeAll();
  });
});

describe('shared drafts at the retention cap', () => {
  const CAP = 3;
  let broker: Broker;
  let world: Drafts;

  beforeAll(async () => {
    broker = await startBroker({ name: 'drafts-cap', env: { COSYNCING_TEST_DRAFT_MAX_SESSIONS: String(CAP) } });
    world = new Drafts(broker);
  });
  afterAll(async () => {
    world?.closeAll();
    await broker?.stop();
  });

  test('past the cap the least recently edited draft is dropped, but a clear is kept', async () => {
    const cleared = await world.session('cap-cleared');
    const writer = await world.device(cleared);
    const tombstone = await typed(writer, '', (await typed(writer, 'sent', 0)).revision);
    const sessions: PiBridgeSession[] = [];
    for (let index = 0; index <= CAP; index += 1) {
      const pi = await world.session(`cap-${index}`);
      await typed(await world.device(pi), `draft ${index}`, 0);
      sessions.push(pi);
    }
    world.closeAll();
    await broker.restart();
    await world.reannounce();

    expect(await replayedOnJoin(await world.device(sessions[0]!))).toEqual([]);
    for (const [index, pi] of sessions.slice(1).entries()) {
      const replayed = await replayedOnJoin(await world.device(pi));
      expect(replayed.map((frame) => frame.text)).toEqual([`draft ${index + 1}`]);
    }
    expect(await replayedOnJoin(await world.device(cleared))).toEqual([
      expect.objectContaining({ text: '', revision: tombstone.revision }),
    ]);
    world.closeAll();
  });

  test('with its revision clock lost the store refuses drafts across restarts instead of reusing revisions', async () => {
    const pi = await world.session('lost-clock');
    await typed(await world.device(pi), 'before the loss', 0);
    world.closeAll();
    const shard = world.shard(pi);

    await broker.stop({ keepState: true });
    rmSync(join(broker.paths.cosyncingHome, 'drafts', 'revision-clock.json'), { force: true });
    writeFileSync(shard, '{not json'); // set aside at startup, so the store is not a fresh one
    for (let restart = 1; restart <= 2; restart += 1) {
      await broker.start();
      await world.reannounce();
      const device = await world.device(pi);
      write(device, `refused after restart ${restart}`, updateId('refused'), 0);
      // Drafts and prompts from one socket are handled in order: anything the draft caused is
      // sent before the prompt's acknowledgement.
      const ack = await device.sendAndAwait({ kind: 'prompt', text: `prompt after restart ${restart}` });
      expect(ack.kind).toBe('ack');
      expect(drafts(device)).toEqual([]);
      world.closeAll();
      await broker.stop({ keepState: true });
    }
    await broker.start();
  });
});
