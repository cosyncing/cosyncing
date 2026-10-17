/**
 * Adapter conformance: one parameterized feature suite every agent kit runs.
 *
 * One real broker per kit, the kit's fake native agent installed in the
 * broker's own PATH and store, and an app-shaped protocol client. Every
 * scenario asserts what a user or the agent would notice: the frames a client
 * receives, the frames and argv the fake receives (its ledger), and the bytes
 * that land in the native store. Nothing here names a tool; everything that
 * differs between agents is profile data (`kits/<agent>.ts`).
 *
 * Scenario ids C01–C22 are the inventory's (B2 §A). A scenario a profile
 * marks `refuse` asserts the product's refusal; `skip` records why it cannot
 * run for that kit yet.
 *
 * Ordering: C01–C15, C18, C19, C21 and C22 each use their own sessions and
 * leave the fake as they found it. C20, C16 and C17 restart the broker or
 * change the fake's version/presence, so they run last, in that order.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runCli } from '../../harness/cli.ts';
import { BROKER_CONTRACT_REVISION } from '../../../packages/typescript/protocol/src/index.ts';
import {
  type Broker,
  type BrokerClient,
  eventually,
  type Frame,
  scaled,
  type SessionStream,
  SOON_MS,
  startBroker,
} from '../../harness/index.ts';
import {
  type ConformanceContext,
  type ConformanceKit,
  type DriveSession,
  expectOneResetSince,
  type HostileStoreCase,
  type FakeController,
  type ScenarioId,
  SCENARIOS,
} from '../kits/kit.ts';

/** Text of a transcript row, whether it arrived whole or as one delta. */
const rowText = (message: any): string | undefined =>
  typeof message?.text === 'string' ? message.text : typeof message?.delta === 'string' ? message.delta : undefined;

const isUser = (message: any, text: string) => message?.type === 'user-message' && message.text === text;

/** Live `message` frames from frame index `from`. */
const liveMessages = (stream: SessionStream, from = 0): any[] =>
  stream.frames.slice(from).filter((frame) => frame.kind === 'message').map((frame) => frame.message);

/**
 * What the client shows, merged by row identity the way the app's reducer
 * merges: deltas accumulate under `type:key`, a whole row replaces, a history
 * reset starts over.
 */
function transcript(stream: SessionStream): Array<{ type: string; key: string; text?: string; queued?: boolean }> {
  const rows = new Map<string, { type: string; key: string; text?: string; queued?: boolean }>();
  const apply = (message: any): void => {
    const key = typeof message?.key === 'string' ? message.key : undefined;
    if (!key || !['user-message', 'model-output', 'thinking'].includes(message.type)) return;
    const identity = `${message.type}:${key}`;
    const held = rows.get(identity);
    if (typeof message.delta === 'string' && typeof message.text !== 'string') {
      rows.set(identity, { type: message.type, key, text: (held?.text ?? '') + message.delta });
      return;
    }
    rows.set(identity, { type: message.type, key, text: message.text ?? held?.text, queued: message.queued === true });
  };
  for (const frame of stream.frames) {
    if (frame.kind === 'history' || frame.kind === 'history-page') {
      if (frame.reset) rows.clear();
      for (const message of frame.messages ?? []) apply(message);
    } else if (frame.kind === 'message') {
      apply(frame.message);
    }
  }
  return [...rows.values()];
}

/** How many distinct transcript rows show exactly `text`. */
const shown = (stream: SessionStream, type: string, text: string): number =>
  transcript(stream).filter((row) => row.type === type && row.text === text).length;

function lastSessionFrame(stream: SessionStream): Frame | undefined {
  return stream.frames.findLast((frame) => frame.kind === 'session');
}

export function conformanceSuite(kit: ConformanceKit): void {
  const { profile } = kit;
  const agent = profile.agent;

  describe(`${profile.displayName} adapter conformance`, () => {
    let broker: Broker;
    let fake: FakeController;
    let client: BrokerClient;

    beforeAll(async () => {
      broker = await startBroker({
        name: `conformance-${agent}`,
        // Drive (`mode=resume`) requires a credentialed client, as the app is.
        token: true,
        env: kit.env,
        setup: async (paths) => {
          fake = await kit.install(paths);
        },
      });
      client = broker.client();
      await kit.ready?.({ broker, client, fake });
    });
    afterAll(async () => {
      client?.closeAll();
      // Before the broker's root goes: a fake's long-lived processes (a daemon) are found through it.
      await fake?.cleanup?.();
      await broker?.stop();
    });

    /**
     * Whether a scenario asserts the part a profile marks as a known bug: `C09`, or one named
     * aspect of it (`C09.clientKey`) when a scenario guards more than one defect.
     */
    const assertsFixed = (id: ScenarioId, aspect?: string): boolean =>
      !(profile.knownBugs as Record<string, string> | undefined)?.[aspect ? `${id}.${aspect}` : id] || process.env.COSYNCING_E2E_KNOWN_BUGS === '1';

    const scenario = (id: ScenarioId, body: () => Promise<void>, positive?: () => Promise<void>): void => {
      const bugs = process.env.COSYNCING_E2E_KNOWN_BUGS === '1'
        ? []
        : Object.entries(profile.knownBugs ?? {}).filter(([key]) => key === id || key.startsWith(`${id}.`)).map(([, bug]) => bug);
      const name = `${id} ${SCENARIOS[id]}${bugs.length ? ` — known bug not asserted: ${bugs.join('; ')}` : ''}`;
      const applicability = profile.scenarios[id];
      if (applicability && 'skip' in applicability) {
        test.skip(`${name} — skipped: ${applicability.skip}`, () => undefined);
      } else if (applicability && 'refuse' in applicability) {
        test(`${name} — refused: ${applicability.refuse}`, positive ?? body);
      } else {
        test(name, body);
      }
    };

    /** The native id behind a session (the broker's id unless the kit maps it). */
    const nativeOf = (session: { id: string; nativeId?: string }): string =>
      session.nativeId ?? fake.nativeId?.(session.id) ?? session.id;

    /** A prompt row the sender sees first: the adapter's queued row, or the agent's own echo of it. */
    const admitted = (message: any, text: string): boolean =>
      isUser(message, text) && (profile.promptEcho === 'native' || profile.idleSendQueued === false || message.queued === true);

    /** A session Resume may drive: app-created, or stored and idle. */
    async function drivableSession(title = 'conformance'): Promise<DriveSession> {
      if (profile.driveEligibility === 'app-created') {
        const id = fake.prepareCreate();
        const cwd = fake.workspace('drive');
        const created = await client.post(`/api/sessions/${agent}`, { directory: cwd, title });
        expect(created.status, created.text).toBe(200);
        expect(created.body.session.id).toBe(id);
        return { id, cwd, reason: 'create' };
      }
      const seeded = fake.seedSession({ title });
      await client.waitForSession((row) => row.id === seeded.id);
      return { id: seeded.id, cwd: seeded.cwd, reason: 'takeover', ...(seeded.nativeId ? { nativeId: seeded.nativeId } : {}) };
    }

    /** The attach parameters the app opens Drive with (see `profile.driveAttach`). */
    const driveOptions = (session: { reason: string }) =>
      profile.driveAttach === 'bare' ? {} : profile.driveAttach === 'live' ? { mode: 'live' } : { mode: 'resume', reason: session.reason };

    /**
     * A Drive attach the product refuses: Observe with an attach conflict and no authority, or (an agent whose
     * Drive is a live attach, with no Observe twin to fall back to) an error and no writer. A live attach that
     * falls back to Observe is told why in the same conflict frame, naming the live attach it was.
     */
    async function expectDriveRefused(refused: SessionStream, label: string): Promise<void> {
      if (profile.driveAttach === 'live' && profile.liveRefusal === 'observe') {
        await refused.waitForKind('history');
        expect(refused.ofKind('attach-conflict').length, label).toBe(1);
        expect(refused.ofKind('attach-conflict')[0]?.requestedMode, label).toBe('live');
        expect(lastSessionFrame(refused)?.authority?.canMutate, label).toBe(false);
        return;
      }
      if (profile.driveAttach === 'live') {
        await refused.waitForKind('error');
        expect(refused.frames.some((frame) => frame.kind === 'session' && frame.authority?.canMutate === true), label).toBe(false);
        return;
      }
      await refused.waitForKind('history');
      expect(refused.ofKind('attach-conflict').length, label).toBe(1);
      expect(lastSessionFrame(refused)?.authority?.canMutate, label).toBe(false);
    }

    /** Open Drive the way the app does and wait until its catalogs arrived. */
    async function openDrive(session: DriveSession): Promise<SessionStream> {
      const stream = await client.attach(agent, session.id, driveOptions(session));
      const frame = await stream.waitForKind('session');
      expect(stream.ofKind('attach-conflict'), JSON.stringify(stream.ofKind('attach-conflict'))).toEqual([]);
      expect(frame.authority?.canMutate).toBe(true);
      await stream.waitForKind('options');
      if (profile.commandsFrame !== false) await stream.waitForKind('commands');
      return stream;
    }

    /**
     * Send a prompt and wait for its ack/nack (Drive acks once the turn
     * settles). A prompt left pending by a failed assertion must not surface
     * later as an unhandled rejection inside another scenario.
     */
    function prompt(stream: SessionStream, text: string, extra: Record<string, unknown> = {}): Promise<Frame> {
      // An agent acked on acceptance (Claude) is awaited to the end of the turn the prompt started.
      const settled = fake.promptSettled?.(stream, text);
      const reply = stream.sendAndAwait({ kind: 'prompt', text, ...extra }).then(async (frame) => {
        if (frame.kind === 'ack' && settled) await settled();
        return frame;
      });
      reply.catch(() => undefined);
      return reply;
    }

    /**
     * Send a prompt and return once the writer has read its durable user row
     * back from the store (the sender's row left the queue), so a later store
     * change is judged against a log the broker has seen: Grok creates its log
     * on the first prompt, and a log replaced before the first read is
     * indistinguishable from that creation. A turn-start agent's turn is held
     * until then, so the change lands after a turn that has fully settled.
     */
    let tailedTurns = 0;
    async function tailedPrompt(stream: SessionStream, text: string): Promise<void> {
      const clientMessageId = `tailed-${++tailedTurns}`;
      // The sender's own row, by its clientKey (or by its text where the agent stamps none: C09.clientKey).
      const byText = profile.knownBugs?.['C09.clientKey'] !== undefined;
      const left = (message: any) => message.type === 'user-message' && message.queued !== true
        && (byText ? String(message.text ?? '').endsWith(text) : message.clientKey === clientMessageId);
      if (profile.userRowDurable === 'turn-start') {
        const sent = prompt(stream, `[[hold:${clientMessageId}]] ${text}`, { clientMessageId });
        await stream.waitForMessage(left);
        fake.release(clientMessageId);
        expect((await sent).kind).toBe('ack');
      } else {
        expect((await prompt(stream, text, { clientMessageId })).kind).toBe('ack');
        await stream.waitForMessage(left);
      }
    }

    const prompted = (session: { id: string; nativeId?: string }, from = 0): string[] =>
      fake.ledger.requests('session/prompt', from)
        .filter((entry) => entry.frame?.params?.sessionId === nativeOf(session))
        .map((entry) => (entry.frame?.params?.prompt ?? []).map((part: { text?: string }) => part.text ?? '').join(''));

    const childStarts = (session: { cwd: string }, from = 0) =>
      fake.ledger.spawns(from).filter((entry) => entry.cwd === session.cwd);

    // ------------------------------------------------------------------ C01
    scenario('C01', async () => {
      const query = (revision?: string) =>
        client.get(`/api/agents${revision === undefined ? '' : `?contractRevision=${encodeURIComponent(revision)}`}`);
      for (const revision of [undefined, '0', String(BROKER_CONTRACT_REVISION), 'not-a-revision']) {
        const response = await query(revision);
        expect(response.status).toBe(200);
        const rows = (Array.isArray(response.body) ? response.body : response.body.agents) as any[];
        const mine = rows.filter((row) => row.id === agent);
        // A client below the agent's revision floor (an older one, or one that names none) is not shown the agent.
        if (profile.minimumClientRevision !== undefined && !(Number(revision) >= profile.minimumClientRevision)) {
          expect(mine).toEqual([]);
          continue;
        }
        expect(mine.length, `contractRevision=${String(revision)}`).toBe(1);
        expect(mine[0].capabilities).toEqual(profile.capabilities);
        expect(mine[0].displayName).toBe(profile.displayName);
      }
    });

    // ------------------------------------------------------------------ C02
    scenario('C02', async () => {
      const root = fake.seedSession({ title: 'Roster root' });
      const child = profile.subagents ? fake.seedSession({ title: 'Roster child', childOf: root }) : undefined;
      const ownFiles = () => new Map([...fake.storeSnapshot()].filter(([path]) =>
        path.includes(root.storeKey ?? nativeOf(root)) || (child && path.includes(child.storeKey ?? nativeOf(child)))));
      const before = ownFiles();
      expect(before.size).toBeGreaterThan(0);
      const lineage = root.rosterNativeId ?? nativeOf(root);
      // The parent row that already sees its child (a sweep may have read the store between the two writes).
      const row = await client.waitForSession((candidate) => candidate.id === root.id && (!child || candidate.nativeId === lineage));
      expect(row.tool).toBe(agent);
      expect(row.nativeId).toBe(lineage);
      expect(row.cwd).toBe(root.cwd);
      expect(row.title).toBe('Roster root');
      expect(typeof row.updatedAt).toBe('number');
      expect(row.currentModel?.modelID).toBeString();
      expect(row.control?.drive?.state).toBe(profile.rosterDriveState ?? 'observing');
      if (child) {
        const childRow = await client.waitForSession((candidate) => candidate.id === child.id);
        expect(childRow.origin).toBe('subagent');
        expect(childRow.parentThreadId).toBe(lineage);
        expect(childRow.attachMode).toBe('observe');
        if (assertsFixed('C02', 'childDrive')) expect(childRow.control?.drive?.supported).toBe(false);
      }
      // Reading the roster and attaching to Observe change no store byte.
      const observer = await client.attach(agent, root.id);
      await observer.waitForKind('history');
      // Every frame a live connection publishes is journalled as the roster row, so it carries the
      // lineage the roster joins children on, from its first frame.
      if (child) expect(observer.frames.find((frame) => frame.kind === 'session')?.info?.nativeId).toBe(lineage);
      await client.sessions({ refresh: true });
      observer.close();
      expect(ownFiles()).toEqual(before);
      if (!child) return;
      // A parent already watched when its subagent starts takes the lineage too. Without it, each
      // frame the parent sends drops the child out of the tree until the next sweep restores it.
      const watched = fake.seedSession({ title: 'Watched root' });
      await client.waitForSession((candidate) => candidate.id === watched.id);
      const watcher = await client.attach(agent, watched.id);
      await watcher.waitForKind('history');
      const lateChild = fake.seedSession({ title: 'Late child', childOf: watched });
      const watchedLineage = watched.rosterNativeId ?? nativeOf(watched);
      await client.waitForSession((candidate) => candidate.id === lateChild.id && candidate.parentThreadId === watchedLineage);
      await watcher.waitForFrame((frame) => frame.kind === 'session' && frame.info?.nativeId === watchedLineage);
      watcher.close();
    });

    // ------------------------------------------------------------------ C03
    scenario('C03', async () => {
      const seeded = fake.seedSession({ turns: 2 });
      await client.waitForSession((row) => row.id === seeded.id);
      const mark = fake.ledger.mark();
      const first = await client.attach(agent, seeded.id);
      const history = await first.waitForKind('history');
      const session = first.frames.find((frame) => frame.kind === 'session')!;
      expect(session.authority).toEqual(profile.bareAttach?.authority ?? { canMutate: false, prompt: 'none' });
      expect(session.info.attachMode).toBe(profile.bareAttach?.attachMode ?? 'observe');
      // History before any live row.
      const historyIndex = first.frames.indexOf(history);
      expect(first.frames.slice(0, historyIndex).some((frame) => frame.kind === 'message')).toBe(false);
      // The conversation, in order, as user and answer rows.
      const visible = (history.messages as any[])
        .filter((message) => message.type === 'user-message' || message.type === 'model-output')
        .map(rowText);
      expect(visible).toEqual(seeded.texts);
      // One finished run summary per turn; an anchor, when the agent's store
      // supplies one, names a row the client holds. A replayed store may restate
      // a turn's summary under its own key as it ran (the client keeps the last):
      // only a running summary is ever restated.
      const summaries = new Map<string, any>();
      for (const message of history.messages as any[]) {
        if (message.type !== 'run-summary') continue;
        expect(summaries.get(message.key)?.status ?? 'running').toBe('running');
        summaries.set(message.key, message);
      }
      if (profile.observeRunSummaries !== false) expect(summaries.size).toBe(seeded.texts.length / 2);
      for (const summary of summaries.values()) {
        expect(summary.status).toBe('done');
        if (summary.userMessageKey !== undefined) {
          expect((history.messages as any[]).some((message) => message.key === summary.userMessageKey)).toBe(true);
        }
      }
      // Rows' keys are present, unique, and stable across a second attach. State
      // (status, metadata, token counts, run summaries) may be restated as a replay ran; the last wins.
      const keys = (history.messages as any[]).map((message) => `${message.type}:${message.key}`);
      const rowKeys = (history.messages as any[])
        // An `event` row is state, keyless by protocol (a context injection carries no key).
        .filter((message) => !['status', 'metadata-update', 'run-summary', 'token-count', 'event'].includes(message.type))
        .map((message) => `${message.type}:${message.key}`);
      expect(new Set(rowKeys).size).toBe(rowKeys.length);
      expect(rowKeys.every((key) => !key.endsWith(':undefined'))).toBe(true);
      const second = await client.attach(agent, seeded.id);
      const again = await second.waitForKind('history');
      expect((again.messages as any[]).map((message) => `${message.type}:${message.key}`)).toEqual(keys);
      // Observe never starts the agent.
      expect(childStarts(seeded, mark)).toEqual([]);
      first.close();
      second.close();
    });

    // ------------------------------------------------------------------ C04
    scenario('C04', async () => {
      const seeded = fake.seedSession();
      await client.waitForSession((row) => row.id === seeded.id);
      const stream = await client.attach(agent, seeded.id, profile.readOnlyAttach?.params ?? {});
      await stream.waitForKind('history');
      const mark = fake.ledger.mark();
      const before = fake.storeSnapshot();
      for (const message of [
        { kind: 'prompt', text: 'observe must not send this' },
        { kind: 'approve', requestId: 'any-request', decision: 'approve' },
        { kind: 'command', name: profile.catalog.commands[0] ?? 'compact', args: '' },
        { kind: 'prompt', text: 'with a model', model: { providerID: 'x', modelID: 'y' } },
      ]) {
        const reply = await stream.sendAndAwait(message);
        expect(reply.kind, `${message.kind} on Observe`).toBe('nack');
        expect(String(reply.message)).toContain('read-only');
      }
      // The broker refused at its boundary: the agent was never started or written to.
      expect(childStarts(seeded, mark)).toEqual([]);
      expect(prompted(seeded, mark)).toEqual([]);
      expect(fake.storeSnapshot()).toEqual(before);
      stream.close();

      // Explicit Observe stays read-only even on a session the roster offers Drive for.
      const drivable = await drivableSession('explicit observe');
      if (profile.freshCreateObservable === false) {
        // A created session with no turn yet is Resume-only; Observe starts once it has history.
        const driver = await openDrive(drivable);
        expect((await prompt(driver, 'first turn')).kind).toBe('ack');
        driver.close();
      }
      const explicitMark = fake.ledger.mark();
      const explicit = await client.attach(agent, drivable.id, profile.readOnlyAttach?.params ?? { mode: 'observe' });
      await explicit.waitForKind('history');
      const info = lastSessionFrame(explicit);
      expect(info?.info?.attachMode).toBe(profile.readOnlyAttach?.attachMode ?? 'observe');
      expect(info?.authority).toEqual({ canMutate: false, prompt: 'none' });
      expect((await explicit.sendAndAwait({ kind: 'prompt', text: 'explicit observe must not send this' })).kind).toBe('nack');
      explicit.close();
      // An agent whose read-only attach is a separate parameter still owes Observe: `mode=observe` alone grants no authority.
      if (profile.readOnlyAttach && assertsFixed('C04', 'explicit')) {
        const plain = await client.attach(agent, drivable.id, { mode: 'observe' });
        await plain.waitForKind('history');
        expect(lastSessionFrame(plain)?.authority).toEqual({ canMutate: false, prompt: 'none' });
        expect((await plain.sendAndAwait({ kind: 'prompt', text: 'plain observe must not send this' })).kind).toBe('nack');
        plain.close();
      }
      // A mode the agent does not declare is refused, never downgraded to one it does.
      const undeclared = ['observe', 'resume', 'live'].find((mode) => !profile.capabilities.attachModes.includes(mode));
      if (undeclared) {
        const refused = await client.attach(agent, drivable.id, { mode: undeclared });
        await refused.waitForKind('error');
        expect(refused.frames.some((frame) => frame.kind === 'session')).toBe(false);
        refused.close();
      }
      expect(childStarts(drivable, explicitMark)).toEqual([]);
      expect(prompted(drivable, explicitMark)).toEqual([]);
    });

    // ------------------------------------------------------------------ C05
    scenario('C05', async () => {
      const seeded = fake.seedSession();
      await client.waitForSession((row) => row.id === seeded.id);
      const stream = await client.attach(agent, seeded.id);
      await stream.waitForKind('history');
      const from = stream.frames.length;
      fake.watcherNoise(seeded);
      fake.appendTurn(seeded, 'tail prompt 1', 'tail answer 1');
      fake.watcherNoise(seeded);
      fake.appendTurn(seeded, 'tail prompt 2', 'tail answer 2');
      fake.appendPartial(seeded, 'partial prompt');
      fake.completePartial(seeded);
      fake.appendTurn(seeded, 'tail prompt 3', 'tail answer 3');
      await stream.waitForMessage((message) => message.type === 'model-output' && rowText(message) === 'tail answer 3');
      // Every appended row arrived live exactly once, the partial line once it was whole.
      for (const text of ['tail prompt 1', 'tail prompt 2', 'partial prompt', 'tail prompt 3']) {
        expect(shown(stream, 'user-message', text), text).toBe(1);
      }
      for (const text of ['tail answer 1', 'tail answer 2', 'tail answer 3']) {
        expect(shown(stream, 'model-output', text), text).toBe(1);
      }
      const live = liveMessages(stream, from);
      const order = ['tail prompt 1', 'tail prompt 2', 'partial prompt', 'tail prompt 3']
        .map((text) => live.findIndex((message) => isUser(message, text)));
      expect(order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1]!))).toBe(true);
      expect(live.some((message) => message.type === 'error')).toBe(false);
      // A fresh reader's history carries the same keys the live tail used.
      const fresh = await client.attach(agent, seeded.id);
      const history = (await fresh.waitForKind('history')).messages as any[];
      for (const message of live.filter((row) => row.type === 'user-message' || row.type === 'model-output')) {
        expect(history.some((row) => row.type === message.type && row.key === message.key), String(message.key)).toBe(true);
      }
      stream.close();
      fresh.close();
    });

    // ------------------------------------------------------------------ C06
    scenario('C06', async () => {
      const seeded = fake.seedSession({ turns: 2 });
      await client.waitForSession((row) => row.id === seeded.id);
      const stream = await client.attach(agent, seeded.id);
      await stream.waitForKind('history');
      const from = stream.frames.length;
      fake.rewriteHistory(seeded);
      if (!assertsFixed('C06', 'live')) {
        // The live reader misses the rewrite (known bug); a fresh reader still never mixes the two.
        // (A read that races the rewrite is answered with a gap and no rows, and its retry replays: wait for rows.)
        const replay = await eventually(async () => {
          const fresh = await client.attach(agent, seeded.id);
          const frame = await fresh.waitForKind('history');
          fresh.close();
          return frame.gap ? undefined : frame.messages as any[];
        }, { what: 'a fresh reader to replay the rewritten history' });
        expect(replay.filter((message) => message.type === 'user-message').map(rowText))
          .toEqual(['rewritten first prompt', seeded.texts[2]]);
        stream.close();
        return;
      }
      const reset = await stream.waitForFrame((frame) => frame.kind === 'history' && frame.reset === true
        && (frame.messages as any[]).some((message) => isUser(message, 'rewritten first prompt')), { after: from });
      // Never a mix: no frame after the rewrite restates the replaced row.
      const after = stream.frames.slice(from);
      const restatesOld = (frame: Frame) =>
        (frame.kind === 'history' && (frame.messages as any[]).some((message) => isUser(message, seeded.texts[0]!)))
        || (frame.kind === 'message' && isUser(frame.message, seeded.texts[0]!));
      expect(after.some(restatesOld)).toBe(false);
      expect((reset.messages as any[]).filter((message) => message.type === 'user-message').map(rowText))
        .toEqual(['rewritten first prompt', seeded.texts[2]]);
      expect(shown(stream, 'user-message', 'rewritten first prompt')).toBe(1);
      expect(shown(stream, 'user-message', seeded.texts[0]!)).toBe(0);
      // One rewrite, one reset: never a second reload with its own notice.
      await expectOneResetSince(stream, fake, seeded, from);
      stream.close();
    });

    // ------------------------------------------------------------------ C07
    scenario('C07', async () => {
      const id = fake.prepareCreate();
      const cwd = fake.workspace('create');
      const before = fake.storeSnapshot();
      const mark = fake.ledger.mark();
      const created = await client.post(`/api/sessions/${agent}`, {
        directory: cwd,
        title: 'Created by conformance',
        ...(profile.catalog.createModel ? { model: profile.catalog.createModel } : {}),
        ...(profile.catalog.createMode ? { permissionMode: profile.catalog.createMode } : {}),
      });
      expect(created.status, created.text).toBe(200);
      const info = created.body.session;
      expect(info.id).toBe(id);
      expect(info.nativeId).toBe(nativeOf({ id }));
      expect(info.cwd).toBe(cwd);
      expect(info.title).toBe('Created by conformance');
      if (profile.catalog.createModel) {
        expect(info.currentModel?.providerID).toBe(profile.catalog.createModel.providerID);
        expect(info.currentModel?.modelID).toBe(profile.catalog.createModel.modelID);
      }
      expect(created.body.attachMode).toBe('resume');
      expect(info.control?.drive?.supported).toBe(true);
      // The created session is drivable and its first prompt lands under the same id.
      const stream = await openDrive({ id, cwd, reason: 'create' });
      expect((await prompt(stream, 'first created prompt')).kind).toBe('ack');
      expect(prompted({ id })).toEqual(['first created prompt']);
      // Create either hands its own child to Drive or closes it before Drive starts one.
      const starts = childStarts({ cwd }, mark);
      expect(starts.length).toBe(profile.createChildAdopted ? 1 : 2);
      expect(fake.ledger.requests('session/new', mark).filter((entry) => entry.pid === starts[0]!.pid).length).toBe(1);
      const row = await client.waitForSession((candidate) => candidate.id === id && candidate.cwd === cwd);
      expect(row.title).toBe('Created by conformance');
      expect([...fake.storeSnapshot().keys()].filter((path) => !before.has(path)).some((path) => path.includes(nativeOf({ id })))).toBe(true);
      stream.close();

      // A native create that answers with an id already in the store is refused,
      // and the existing session does not become broker-owned.
      if (!assertsFixed('C07')) return;
      const existing = fake.seedSession({ title: 'Pre-existing' });
      await client.waitForSession((candidate) => candidate.id === existing.id);
      fake.prepareCreate(existing.id);
      const reused = await client.post(`/api/sessions/${agent}`, { directory: existing.cwd });
      expect(reused.ok, reused.text).toBe(false);
      const row2 = await client.waitForSession((candidate) => candidate.id === existing.id);
      expect(row2.control?.drive?.state).toBe('observing');
      if (profile.driveEligibility === 'app-created') {
        const refused = await client.attach(agent, existing.id, { mode: 'resume', reason: 'create' });
        await refused.waitForKind('history');
        expect(refused.ofKind('attach-conflict').length).toBe(1);
        expect(prompted(existing)).toEqual([]);
        expect(lastSessionFrame(refused)?.authority?.canMutate).toBe(false);
        refused.close();
      }
    });

    // ------------------------------------------------------------------ C08
    scenario('C08', async () => {
      const session = await drivableSession('lazy resume');
      const mark = fake.ledger.mark();
      const stream = await openDrive(session);
      // Drive answers its catalogs from at most one child, which loads the exact id.
      const starts = childStarts(session, mark);
      expect(starts.length).toBeLessThanOrEqual(1);
      expect((await prompt(stream, 'lazy resume prompt')).kind).toBe('ack');
      const all = childStarts(session, mark);
      expect(all.length).toBe(1);
      const argv = all[0]!.argv ?? [];
      for (const flag of profile.driveArgv.required) expect(argv).toContain(flag);
      for (const flag of profile.driveArgv.forbidden) expect(argv).not.toContain(flag);
      if (profile.driveArgv.updaterGuard) {
        expect(all[0]!.autoUpdateDisabled).toBe('1');
        const probes = fake.ledger.since(mark).filter((entry) => entry.kind === 'version-probe');
        expect(probes.length).toBeGreaterThan(0);
        expect(probes.every((entry) => entry.autoUpdateDisabled === '1')).toBe(true);
      }
      const loads = fake.ledger.requests('session/load', mark).filter((entry) => entry.pid === all[0]!.pid);
      expect(loads.map((entry) => entry.frame?.params?.sessionId)).toEqual([nativeOf(session)]);
      expect(prompted(session, mark)).toEqual(['lazy resume prompt']);
      // The terminal hint names this native session, and says whether it joins the writer.
      const info = lastSessionFrame(stream)?.info;
      const hint = profile.terminal.resumeHint;
      if (hint === null) {
        expect(info?.terminalSyncHint ?? null).toBeNull();
      } else {
        // The hint rides `terminalSyncHint`, or the control's generic terminal tip (`terminalSync.command`).
        const command = info?.terminalSyncHint?.command ?? info?.control?.terminalSync?.command;
        expect(command).toContain(typeof hint === 'function' ? hint(session) : hint.replace('{id}', nativeOf(session)));
      }
      expect(info?.control?.terminalSync?.syncAvailable ?? false).toBe(profile.terminal.syncAvailable);
      stream.close();
    });

    // ------------------------------------------------------------------ C09
    scenario('C09', async () => {
      const session = await drivableSession('prompt echo');
      const stream = await openDrive(session);
      const from = stream.frames.length;
      const reply = await prompt(stream, 'echo me once', { clientMessageId: 'c09-client' });
      expect(reply.kind).toBe('ack');
      // An agent that acknowledges at turn start answers after the ack.
      await stream.waitForMessage((message) => message.type === 'model-output' && rowText(message)?.includes('echo me once') === true);
      const live = liveMessages(stream, from);
      // The sender's row (the queued row, or the agent's own echo) reached it before the agent answered.
      const queuedIndex = live.findIndex((message) => admitted(message, 'echo me once'));
      expect(queuedIndex).toBeGreaterThanOrEqual(0);
      const queued = live[queuedIndex];
      if (assertsFixed('C09', 'clientKey')) expect(queued.clientKey).toBe('c09-client');
      const answerIndex = live.findIndex((message) => message.type === 'model-output' && rowText(message)?.includes('echo me once'));
      expect(answerIndex).toBeGreaterThan(queuedIndex);
      // The turn settles done (the summary may land just after the ack), and
      // exactly one turn does: the sentinel is a second prompt's own summary.
      const summarised = assertsFixed('C09', 'summary');
      if (summarised) await stream.waitForMessage((message) => message.type === 'run-summary' && message.status === 'done');
      expect((await prompt(stream, 'sentinel turn')).kind).toBe('ack');
      await stream.waitForMessage((message) => message.type === 'model-output' && rowText(message) === 'answer: sentinel turn');
      if (summarised) {
        await eventually(() => new Set(liveMessages(stream, from)
          .filter((message) => message.type === 'run-summary' && message.status === 'done')
          .map((message) => message.key)).size === 2, { what: 'the sentinel turn summary' });
      }
      expect(liveMessages(stream, from).some((message) => message.type === 'run-summary' && message.status === 'error')).toBe(false);
      // The sender sees its own row leave the queue live, by the time a later turn answered.
      if (assertsFixed('C09')) {
        const own = liveMessages(stream, from).filter((message) => isUser(message, 'echo me once') && message.clientKey === 'c09-client');
        expect(own.at(-1)?.queued === true).toBe(false);
      }
      // The durable row reconciles to the queued row: same key and clientKey, shown once.
      const fresh = await client.attach(agent, session.id);
      const history = (await fresh.waitForKind('history')).messages as any[];
      const users = history.filter((message) => isUser(message, 'echo me once'));
      expect(users.length).toBe(1);
      if (assertsFixed('C09', 'replayKey')) expect(users[0].key).toBe(queued.key);
      if (profile.historyClientKey !== false && assertsFixed('C09', 'clientKey')) expect(users[0].clientKey).toBe('c09-client');
      expect(users[0].queued === true).toBe(false);
      expect(shown(fresh, 'user-message', 'echo me once')).toBe(1);
      stream.close();
      fresh.close();
    });

    // ------------------------------------------------------------------ C10
    scenario('C10', async () => {
      const session = await drivableSession('fifo');
      const stream = await openDrive(session);
      // A second tab on the same Drive owner, so the second prompt reaches the
      // adapter while the first is running (one socket already serializes).
      const tab = await client.attach(agent, session.id, driveOptions(session));
      expect((await tab.waitForKind('session')).authority?.canMutate).toBe(true);
      const mark = fake.ledger.mark();
      const first = prompt(stream, '[[hold:c10]] first in line');
      await fakeSaw(() => prompted(session, mark).length === 1, 'the first prompt reach the agent');
      if (profile.midTurnPrompt === 'refused') {
        // The agent takes one prompt at a time: a second is refused by name, and never reaches it.
        const refused = await prompt(tab, 'second in line');
        expect(refused.kind).toBe('nack');
        expect(String(refused.message)).toContain('another prompt while the session is working');
        expect(prompted(session, mark)).toEqual(['[[hold:c10]] first in line']);
        fake.release('c10');
        expect((await first).kind).toBe('ack');
        // The refusal left the session usable: once the turn has ended the same prompt is accepted, in order.
        expect((await prompt(tab, 'second in line')).kind).toBe('ack');
        await stream.waitForMessage((message) => message.type === 'model-output' && rowText(message) === 'answer: second in line');
        expect(prompted(session, mark)).toEqual(['[[hold:c10]] first in line', 'second in line']);
        stream.close();
        tab.close();
        return;
      }
      const second = prompt(tab, 'second in line');
      if (profile.midTurnPrompt === 'steered') {
        // Steered: it reaches the running turn at once, after the first, on the same writer.
        await fakeSaw(() => prompted(session, mark).length === 2, 'the steered prompt reach the agent');
        expect(prompted(session, mark)).toEqual(['[[hold:c10]] first in line', 'second in line']);
        await stream.waitForMessage((message) => admitted(message, 'second in line'));
      } else {
        // The second prompt is admitted (its queued row reached both tabs) and waits.
        if (assertsFixed('C10', 'queuedRow')) await stream.waitForMessage((message) => isUser(message, 'second in line') && message.queued === true);
        expect(prompted(session, mark)).toEqual(['[[hold:c10]] first in line']);
      }
      fake.release('c10');
      expect((await first).kind).toBe('ack');
      expect((await second).kind).toBe('ack');
      await stream.waitForMessage((message) => message.type === 'model-output' && rowText(message) === 'answer: second in line');
      expect(prompted(session, mark)).toEqual(['[[hold:c10]] first in line', 'second in line']);
      expect(childStarts(session, mark).length).toBeLessThanOrEqual(1);
      stream.close();
      tab.close();
    });

    // ------------------------------------------------------------------ C11
    scenario('C11', async () => {
      const session = await drivableSession('permission');
      const owner = await openDrive(session);
      const mark = fake.ledger.mark();
      const turn = prompt(owner, '[[permission]] run the tool');
      const card = await owner.waitForMessage((message) => message.type === 'permission-request');
      expect(card.requestId).toBeString();
      // A late tab on the same Drive owner receives the open card exactly once.
      const late = await client.attach(agent, session.id, driveOptions(session));
      await late.waitForKind('session');
      await late.waitForMessage((message) => message.type === 'permission-request' && message.requestId === card.requestId);
      const lateCards = late.messages().filter((message) => message.type === 'permission-request' && message.requestId === card.requestId).length;
      if (assertsFixed('C11', 'lateDuplicate')) expect(lateCards).toBe(1);
      else expect(lateCards).toBeGreaterThanOrEqual(1);
      // A forged decision never reaches the agent.
      if (assertsFixed('C11')) {
        const forged = await late.sendAndAwait({ kind: 'approve', requestId: `${card.requestId}-forged`, decision: 'approve' });
        expect(forged.kind).toBe('nack');
        expect(fake.ledger.replies('permission-', mark)).toEqual([]);
      }
      // Approve maps to the native allow-once option; both tabs see it resolved.
      const approved = await late.sendAndAwait({ kind: 'approve', requestId: card.requestId, decision: 'approve' });
      expect(approved.kind).toBe('ack');
      await fakeSaw(() => fake.ledger.replies('permission-', mark).length === 1, 'the permission reply');
      const approvedOnce = fake.ledger.replies('permission-', mark)[0]!.frame?.result;
      if (profile.permission) expect(approvedOnce?.outcome).toEqual(profile.permission.approveReply);
      else if (profile.nativePermission) expect(approvedOnce).toEqual(profile.nativePermission.approveOnce);
      else expect(approvedOnce?.outcome).toEqual({ outcome: 'selected', optionId: 'allow_once' });
      for (const stream of [owner, late]) {
        await stream.waitForMessage((message) => message.type === 'permission-resolved' && message.requestId === card.requestId);
      }
      // A second decision on a settled card is refused and never reaches the agent.
      if (assertsFixed('C11')) {
        const again = await owner.sendAndAwait({ kind: 'approve', requestId: card.requestId, decision: 'reject' });
        expect(again.kind).toBe('nack');
      }
      expect((await turn).kind).toBe('ack');
      expect(fake.ledger.replies('permission-', mark).length).toBe(1);
      const mentions = profile.permission?.answerMentions ?? profile.nativePermission?.answerMentions ?? 'allow_once';
      await owner.waitForMessage((message) => message.type === 'model-output' && rowText(message)?.includes(mentions) === true);
      owner.close();
      late.close();
    });

    // ------------------------------------------------------------------ C12
    scenario('C12', async () => {
      const session = await drivableSession('stop');
      const stream = await openDrive(session);
      const stop = profile.catalog.stopCommand!;
      const commands = (stream.ofKind('commands').at(-1)?.commands ?? []) as any[];
      expect(commands.some((command) => command.name === stop && command.kind === 'action')).toBe(true);
      const mark = fake.ledger.mark();
      const from = stream.frames.length;
      const turn = prompt(stream, '[[hold:c12]] a long turn');
      await fakeSaw(() => prompted(session, mark).length === 1, 'the held prompt reach the agent');
      const stopped = await sendStop(stream, stop);
      if (!assertsFixed('C12')) {
        // Known bug: the abort reaches the agent, but the app is not given a settled turn and a kept Drive.
        await fakeSaw(() => fake.ledger.requests('session/cancel', mark).length > 0, 'session/cancel');
        expect(fake.ledger.requests('session/cancel', mark).length).toBe(1);
        stream.close();
        return;
      }
      expect(stopped.kind).toBe('ack');
      await fakeSaw(() => fake.ledger.requests('session/cancel', mark).length > 0, 'session/cancel');
      expect((await turn).kind).toBe('ack');
      // The run closes cancelled, and Drive stays with this client.
      if (profile.stopSummary === false) {
        await stream.waitForFrame((frame) => frame.kind === 'notice' && /stop/i.test(String(frame.message)), { after: from, what: 'the stop notice' });
      } else {
        await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message.type === 'run-summary'
          && frame.message.status === 'cancelled', { after: from });
      }
      expect(fake.ledger.requests('session/cancel', mark).length).toBe(1);
      expect(lastSessionFrame(stream)?.authority?.canMutate).toBe(true);
      expect((await prompt(stream, 'after stop')).kind).toBe('ack');
      expect(liveMessages(stream, from).some((message) => message.type === 'permission-request')).toBe(false);
      stream.close();
    }, async () => {
      // Refused: no interrupt action is offered, and a crafted stop never reaches the agent.
      const session = await drivableSession('stop refused');
      const stream = await openDrive(session);
      const commands = (stream.ofKind('commands').at(-1)?.commands ?? []) as any[];
      expect(commands.some((command) => command.kind === 'action' && /^(stop|abort)$/.test(command.name))).toBe(false);
      const mark = fake.ledger.mark();
      const stopped = await stream.sendAndAwait({ kind: 'command', name: 'stop' });
      if (assertsFixed('C12', 'crafted')) expect(stopped.kind).toBe('nack');
      expect(fake.ledger.requests('session/cancel', mark)).toEqual([]);
      expect(prompted(session, mark)).toEqual([]);
      stream.close();
    });

    // ------------------------------------------------------------------ C13
    scenario('C13', async () => {
      const session = await drivableSession('join');
      const owner = await openDrive(session);
      const mark = fake.ledger.mark();
      const ownerTurn = prompt(owner, '[[hold:c13]] owner prompt', { clientMessageId: 'c13-owner' });
      await fakeSaw(() => prompted(session, mark).length === 1, 'the owner prompt reach the agent');
      const loadsBefore = fake.ledger.requests('session/load', mark).length;
      let observer: SessionStream | undefined;
      let joined: SessionStream;
      if (profile.driveFamily === 'live-host') {
        // A live host's writer IS the shared session: a bare reload reaches it directly (no Observe
        // twin, no join offer), and attaching starts no writer and loads nothing.
        // (An agent whose bare attach is Observe, and whose Drive is `mode=live`, joins the same way.)
        joined = await client.attach(agent, session.id, profile.driveAttach === 'live' ? driveOptions(session) : {});
        const joinedSession = await joined.waitForKind('session');
        expect(joinedSession.authority?.canMutate).toBe(true);
        expect(joinedSession.joinExisting).toBeUndefined();
      } else {
        // A bare reload is a separate Observe connection that cannot see the owner's queued row…
        observer = await client.attach(agent, session.id);
        const offer = await observer.waitForFrame((frame) => frame.kind === 'session');
        await observer.waitForKind('history');
        expect(offer.authority?.canMutate).toBe(false);
        expect(observer.messages().some((message) => message.type === 'user-message' && message.queued === true)).toBe(false);
        // …and is offered the existing owner.
        const revision = offer.joinExisting?.ownerRevision;
        expect(revision?.epoch).toBeString();
        // A stale owner revision fails closed onto Observe.
        const stale = await client.attach(agent, session.id, {
          mode: 'resume', reason: 'join-existing', ownerEpoch: revision.epoch, ownerSeq: revision.seq + 1000,
        });
        const conflict = await stale.waitForKind('attach-conflict');
        expect(conflict.code).toBe('JOIN_OWNER_STALE');
        stale.close();
        // Joining reuses the owner: no new child, no new native load, the queued row replays.
        joined = await client.attach(agent, session.id, {
          mode: 'resume', reason: 'join-existing', ownerEpoch: revision.epoch, ownerSeq: revision.seq,
        });
        const joinedSession = await joined.waitForKind('session');
        expect(joinedSession.authority?.canMutate).toBe(true);
        expect(joinedSession.joinExisting).toBeUndefined();
      }
      await joined.waitForMessage((message) => isUser(message, '[[hold:c13]] owner prompt')
        && (message.clientKey === 'c13-owner' || profile.historyClientKey === false || !assertsFixed('C13', 'clientKey')));
      // Both clients send in order through the one child.
      if (profile.midTurnPrompt === 'refused') {
        // One prompt at a time: the joined client's turn starts once the owner's has ended.
        fake.release('c13');
        expect((await ownerTurn).kind).toBe('ack');
        expect((await prompt(joined, 'joined prompt')).kind).toBe('ack');
      } else {
        const joinedTurn = prompt(joined, 'joined prompt');
        if (assertsFixed('C10', 'queuedRow')) await joined.waitForMessage((message) => admitted(message, 'joined prompt'));
        fake.release('c13');
        expect((await ownerTurn).kind).toBe('ack');
        expect((await joinedTurn).kind).toBe('ack');
      }
      expect(prompted(session, mark)).toEqual(['[[hold:c13]] owner prompt', 'joined prompt']);
      expect(childStarts(session, mark).length).toBeLessThanOrEqual(1);
      expect(fake.ledger.requests('session/load', mark).length).toBe(loadsBefore);
      // One shared live stream: each client sees the other's answer, and the
      // joined client got the writer's command catalog without a new child.
      await owner.waitForMessage((message) => message.type === 'model-output' && rowText(message) === 'answer: joined prompt');
      await joined.waitForMessage((message) => message.type === 'model-output' && rowText(message) === 'answer: owner prompt');
      if (profile.catalog.commands.length > 0) {
        const names = ((await joined.waitForKind('commands')).commands as any[]).map((command) => command.name);
        for (const name of profile.catalog.commands) expect(names).toContain(name);
      }
      owner.close();
      observer?.close();
      joined.close();
    });

    // ------------------------------------------------------------------ C14
    scenario('C14', async () => {
      // An agent whose Drive never notices a foreign write (known bug) has nothing left to assert here.
      if (!assertsFixed('C14')) return;
      const session = await drivableSession('foreign writer');
      const owner = await openDrive(session);
      expect((await prompt(owner, 'owned prompt')).kind).toBe('ack');
      // A live-attach agent has no Observe twin to offer the join: a second `mode=live` attach is the join.
      const live = profile.driveAttach === 'live';
      const observer = await client.attach(agent, session.id);
      const offer = await observer.waitForFrame((frame) => frame.kind === 'session');
      const revision = offer.joinExisting?.ownerRevision;
      const joined = await client.attach(agent, session.id, live ? driveOptions(session) : {
        mode: 'resume', reason: 'join-existing', ownerEpoch: revision.epoch, ownerSeq: revision.seq,
      });
      expect((await joined.waitForKind('session')).authority?.canMutate).toBe(true);
      // The joiner's history read adopts every row it finds; a foreign write must land after it, or it is adopted too.
      await joined.waitForKind('history');
      const fromOwner = owner.frames.length;
      const fromJoined = joined.frames.length;
      const mark = fake.ledger.mark();
      fake.appendForeignUser(session, 'typed in a terminal');
      // Every joined socket is told in the same session broadcast.
      const demoted = (frame: Frame) => frame.kind === 'session' && frame.info?.control?.drive?.state !== 'driving';
      await owner.waitForFrame(demoted, { after: fromOwner });
      await joined.waitForFrame(demoted, { after: fromJoined });
      // Later writes fail with no native call.
      const refused = await joined.sendAndAwait({ kind: 'prompt', text: 'after demotion' });
      expect(refused.kind).toBe('nack');
      expect(prompted(session, mark)).toEqual([]);
      const row = await client.waitForSession((candidate) => candidate.id === session.id
        && candidate.control?.drive?.state === 'observing');
      expect(row.sessionOwner?.state).not.toBe('drive');
      owner.close();
      observer.close();
      joined.close();
    });

    // ------------------------------------------------------------------ C15
    scenario('C15', async () => {
      // An agent whose Drive never notices a log change (known bug) has nothing left to assert here.
      if (!assertsFixed('C15', 'detect')) return;
      for (const change of profile.boundaryChanges ?? ['replaceLog', 'rewriteHistory'] as const) {
        const session = await drivableSession(`boundary ${change}`);
        const stream = await openDrive(session);
        await tailedPrompt(stream, `before ${change}`);
        const from = stream.frames.length;
        const mark = fake.ledger.mark();
        fake[change](session);
        const demoted = (frame: Frame) => frame.kind === 'session' && frame.info?.control?.drive?.state !== 'driving';
        // An in-place rewrite is seen live, so every tab learns before anyone writes.
        if (change === 'rewriteHistory' || assertsFixed('C15')) {
          await stream.waitForFrame(demoted, { after: from, what: `Drive demoted after ${change}` });
        }
        // Either way the next write is refused before it reaches the agent, and Drive ends.
        const refused = await stream.sendAndAwait({ kind: 'prompt', text: `after ${change}` });
        expect(refused.kind).toBe('nack');
        await stream.waitForFrame(demoted, { after: from, what: `Drive demoted after ${change}` });
        expect(prompted(session, mark)).toEqual([]);
        stream.close();
      }
    });

    // ------------------------------------------------------------------ C18
    const expectCatalog = (stream: SessionStream): void => {
      const options = stream.ofKind('options').at(-1)!;
      expect((options.models as any[]).map((model) => `${model.providerID}/${model.modelID}`)).toEqual(profile.catalog.models);
      expect(((options.modes ?? []) as any[]).map((mode) => mode.value)).toEqual(profile.catalog.modes);
    };
    scenario('C18', async () => {
      const session = await drivableSession('options');
      const stream = await openDrive(session);
      expectCatalog(stream);
      const target = profile.catalog.switchModel!;
      const mark = fake.ledger.mark();
      const from = stream.frames.length;
      expect((await prompt(stream, 'on another model', { model: target })).kind).toBe('ack');
      if (profile.modelSwitch === 'per-turn') {
        // The turn itself carries the selection, on the writer that was already there.
        expect(childStarts(session, mark)).toEqual([]);
        const turn = fake.ledger.requests('session/prompt', mark).find((entry) => entry.frame?.params?.sessionId === nativeOf(session));
        expect(JSON.stringify(turn?.frame)).toContain(target.modelID);
      } else {
        // The same session id is relaunched on the selected model.
        const starts = childStarts(session, mark);
        expect(starts.length).toBe(1);
        expect(starts[0]!.argv).toContain(target.modelID);
        expect(fake.ledger.requests('session/load', mark).filter((entry) => entry.pid === starts[0]!.pid)
          .map((entry) => entry.frame?.params?.sessionId)).toEqual([nativeOf(session)]);
      }
      expect(prompted(session, mark)).toEqual(['on another model']);
      // The session then reports the model it runs (an alias selection reports its concrete model).
      const running = profile.catalog.switchModelResolvesTo ?? target.modelID;
      await stream.waitForFrame((frame) => (frame.kind === 'session' && frame.info?.currentModel?.modelID === running)
        || (frame.kind === 'message' && frame.message.type === 'metadata-update'
          && frame.message.value?.currentModel?.modelID === running), { after: from });
      const row = await client.waitForSession((candidate) => candidate.id === session.id && candidate.currentModel?.modelID === running);
      expect(row.currentModel?.modelID).toBe(running);
      stream.close();
    }, async () => {
      // Switching is not offered, and a crafted switch never reaches the agent.
      const session = await drivableSession('options refused');
      const stream = await openDrive(session);
      expectCatalog(stream);
      const mark = fake.ledger.mark();
      const refused = await prompt(stream, 'switch model', { model: { providerID: 'provider', modelID: 'other' } });
      expect(refused.kind).toBe('nack');
      expect(prompted(session, mark)).toEqual([]);
      expect(childStarts(session, mark).length).toBe(0);
      stream.close();
    });

    // ------------------------------------------------------------------ C19
    scenario('C19', async () => {
      const session = await drivableSession('commands');
      const stream = await openDrive(session);
      const names = ((stream.ofKind('commands').at(-1)?.commands ?? []) as any[]).map((command) => command.name);
      for (const name of profile.catalog.commands) expect(names).toContain(name);
      const name = profile.catalog.commands[0]!;
      const mark = fake.ledger.mark();
      expect((await stream.sendAndAwait({ kind: 'command', name, args: 'the diff' })).kind).toBe('ack');
      await fakeSaw(() => prompted(session, mark).length > 0, 'the command');
      expect(prompted(session, mark)).toEqual([`/${name} the diff`]);
      const unknown = await stream.sendAndAwait({ kind: 'command', name: 'not-a-command' });
      if (profile.catalog.unknownCommandsForwarded) {
        // The agent owns its command namespace: an unlisted name is the agent's to answer.
        expect(unknown.kind).toBe('ack');
        await fakeSaw(() => prompted(session, mark).length > 1, 'the unlisted command');
        expect(prompted(session, mark)).toEqual([`/${name} the diff`, '/not-a-command']);
      } else {
        if (assertsFixed('C19')) expect(unknown.kind).toBe('nack');
        expect(prompted(session, mark)).toEqual([`/${name} the diff`]);
      }
      stream.close();
    });

    // ------------------------------------------------------------------ C21
    describe('C21 hostile store entries', () => {
      const buildable = profile.hostileStore.filter((entry) => !entry.unsupportedOn?.includes(process.platform));
      const optedIn = process.env.COSYNCING_E2E_KNOWN_BUGS === '1';
      // A string known bug withholds the whole case; an `{ aspect, bug }` one only that half of it.
      const asserted = (entry: HostileStoreCase) => !entry.knownBug || typeof entry.knownBug !== 'string' || optedIn;
      for (const entry of buildable.filter((candidate) => !asserted(candidate))) {
        test.skip(`C21 ${entry.name} — known bug not asserted: ${entry.knownBug as string}`, () => undefined);
      }
      const cases = buildable.filter(asserted);
      const caseName = (entry: HostileStoreCase) => typeof entry.knownBug === 'object' && !optedIn
        ? `${entry.name} (known bug not asserted: ${entry.knownBug.bug})` : entry.name;
      const asserts = (entry: HostileStoreCase, aspect: 'roster' | 'attach') =>
        optedIn || typeof entry.knownBug !== 'object' || entry.knownBug.aspect !== aspect;
      const attachNote = assertsFixed('C21') ? '' : ` — known bug not asserted: ${profile.knownBugs!.C21}`;
      test.each(cases.map((entry) => [caseName(entry), entry] as const))(`C21 %s is withheld, the roster survives${attachNote}`, async (_name, entry) => {
        const survivor = fake.seedSession({ title: 'survivor' });
        await client.waitForSession((row) => row.id === survivor.id);
        const hostile = entry.plant(fake);
        // A sentinel planted after the hostile entry: once it is listed, the
        // sweep that saw the hostile entry has run.
        const sentinel = fake.seedSession({ title: 'sentinel' });
        const rows = await eventuallyRows(client, (all) => all.some((row) => row.id === sentinel.id), 'the sentinel row');
        if (asserts(entry, 'roster')) expect(rows.some((row) => row.tool === agent && row.id === hostile)).toBe(false);
        expect(rows.some((row) => row.id === survivor.id)).toBe(true);
        if (!asserts(entry, 'attach')) return;
        const attach = await client.attach(agent, hostile).then(
          async (stream) => {
            const outcome = await stream.waitForFrame((frame) => frame.kind === 'history' || frame.kind === 'error')
              .catch(() => undefined);
            stream.close();
            return outcome?.kind;
          },
          () => 'refused',
        );
        // An id the roster withholds is not attachable either, and the refusal is prompt: an error frame,
        // or a socket refused outright. No answer at all is a hang.
        if (assertsFixed('C21')) expect(['error', 'refused']).toContain(String(attach));
        // An attach that opened a FIFO without O_NONBLOCK would have frozen the broker's event loop.
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const answered = await Promise.race([
          client.sessions({ refresh: true }).then((all) => all.some((row) => row.id === survivor.id)),
          new Promise<'no answer'>((resolve) => { deadline = setTimeout(() => resolve('no answer'), scaled(SOON_MS)); }),
        ]).finally(() => clearTimeout(deadline));
        expect(answered, 'the roster still answers after the attach').toBe(true);
      });
    });

    // ------------------------------------------------------------------ C22
    scenario('C22', async () => {
      const variants = {
        current: fake.doctorEnvironment({ version: profile.version.current }),
        below: fake.doctorEnvironment({ version: profile.version.below }),
        newer: fake.doctorEnvironment({ version: profile.version.newer }),
        missing: fake.doctorEnvironment({ missing: true }),
        ...(profile.binaryOverrideEnv
          ? { override: fake.doctorEnvironment({ version: profile.version.current, override: true }) }
          : {}),
      };
      const reports = await Promise.all(Object.entries(variants).map(async ([name, env]) =>
        [name, await doctorJson(broker, env)] as const));
      for (const [name, report] of reports) {
        const expected = profile.version.doctor[name === 'override' ? 'current' : name as keyof typeof profile.version.doctor];
        const check = report.checks.find((candidate: any) => candidate.id === `${agent}.${expected.check}`);
        expect(check, `${name}: ${JSON.stringify(report.checks)}`).toBeDefined();
        expect({ name, status: check.status, detailCode: check.detailCode })
          .toEqual({ name, status: expected.status, detailCode: expected.detailCode });
        expect(report.raw.includes(broker.token!), `${name} leaks the owner token`).toBe(false);
      }
    });

    // ------------------------------------------------------------------ C20
    scenario('C20', async () => {
      const kept = await drivableSession('restored');
      const keptStream = await openDrive(kept);
      expect((await prompt(keptStream, 'before restart')).kind).toBe('ack');
      keptStream.close();
      if (profile.driveEligibility === 'app-created') {
        const changed = await drivableSession('changed offline');
        const changedStream = await openDrive(changed);
        expect((await prompt(changedStream, 'before restart')).kind).toBe('ack');
        changedStream.close();
        // Handing Drive to the terminal gives up app ownership for good (an agent with no terminal to hand to has none).
        const handed = profile.terminal.handoff === false ? undefined : await drivableSession('handed to the terminal');
        if (handed) {
          const handedStream = await openDrive(handed);
          expect((await prompt(handedStream, 'before handoff')).kind).toBe('ack');
          expect((await handedStream.sendAndAwait({ kind: 'handoff' })).kind).toBe('ack');
          await client.waitForSession((row) => row.id === handed.id && row.control?.drive?.supported === false);
          handedStream.close();
        }
        await broker.stop({ keepState: true });
        // A terminal wrote to this session while the broker was down.
        fake.appendTurn(changed, 'written offline', 'answered offline');
        await broker.start();
        client = broker.client();
        await kit.ready?.({ broker, client, fake });
        const restored = await client.waitForSession((row) => row.id === kept.id);
        const keeps = profile.restartKeepsDrive !== false;
        expect(restored.control?.drive?.supported).toBe(keeps);
        const revoked = await client.waitForSession((row) => row.id === changed.id);
        // (An agent that only learns of the offline write when Drive is attached keeps offering it until then.)
        if (assertsFixed('C20', 'roster')) expect(revoked.control?.drive?.supported).toBe(false);
        if (handed) {
          const stillHanded = await client.waitForSession((row) => row.id === handed.id);
          expect(stillHanded.control?.drive?.supported).toBe(false);
        }
        if (keeps) {
          const reopened = await openDrive({ ...kept, reason: 'create' });
          expect((await prompt(reopened, 'after restart')).kind).toBe('ack');
          reopened.close();
        } else {
          // The host that wrote the session is gone with the old broker: nothing may drive on its say-so.
          const gone = await client.attach(agent, kept.id, driveOptions({ reason: 'create' }));
          await expectDriveRefused(gone, 'a session from the previous host');
          gone.close();
        }
        const refused = await client.attach(agent, changed.id, driveOptions({ reason: 'create' }));
        await expectDriveRefused(refused, 'a session changed offline');
        refused.close();
        return;
      }
      // Stored-idle agents: Drive is the native session's own state, so a
      // restart restores it, with the approval mode the agent persisted.
      const mode = profile.catalog.modes.at(-1)!;
      const modeStream = await openDrive(kept);
      expect((await prompt(modeStream, 'set the mode', { permissionMode: mode })).kind).toBe('ack');
      modeStream.close();
      await broker.restart();
      client = broker.client();
      await kit.ready?.({ broker, client, fake });
      const restored = await client.waitForSession((row) => row.id === kept.id
        && (row.currentMode === mode || !assertsFixed('C20', 'mode')));
      expect(restored.control?.drive?.supported).toBe(true);
      const reopened = await openDrive(kept);
      expect((await prompt(reopened, 'after restart')).kind).toBe('ack');
      reopened.close();
    });

    // ------------------------------------------------------------------ C16
    scenario('C16', async () => {
      const stored = fake.seedSession({ title: 'stored under a version change' });
      const drivable = await drivableSession('version gate');
      const versions: Array<{ label: string; version: string; output?: string; drives: boolean }> = [
        { label: 'below the floor', version: profile.version.below, drives: false },
        { label: 'unparseable', version: profile.version.current, output: `${agent} version unknown\n`, drives: false },
        {
          label: 'banner-polluted',
          version: profile.version.current,
          output: `Update available! Run \`${agent} update\`.\n${agent} ${profile.version.current}\n`,
          drives: true,
        },
        { label: 'newer than measured', version: profile.version.newer, drives: profile.version.newerDrives },
      ];
      try {
        for (const variant of versions) {
          fake.setVersion(variant.version, variant.output);
          if (profile.version.cachedByBroker) {
            await broker.restart();
            client = broker.client();
            await kit.ready?.({ broker, client, fake });
          }
          fake.prepareCreate();
          const created = await client.post(`/api/sessions/${agent}`, { directory: fake.workspace('gate') });
          if (variant.drives) {
            expect(created.status, `${variant.label}: ${created.text}`).toBe(200);
            continue;
          }
          if (!assertsFixed('C16')) continue;
          if (assertsFixed('C16', 'create')) {
            expect(created.status, variant.label).toBe(503);
            expect(created.body.code).toBe('SESSION_CREATE_TEMPORARILY_UNAVAILABLE');
          } else {
            expect(created.ok, variant.label).toBe(false);
          }
          const row = await client.waitForSession((candidate) => candidate.id === stored.id);
          expect(row.control?.drive?.supported, variant.label).toBe(false);
          const refused = await client.attach(agent, drivable.id, driveOptions(drivable));
          await expectDriveRefused(refused, variant.label);
          refused.close();
        }
      } finally {
        fake.setVersion(profile.version.current);
        if (profile.version.cachedByBroker) {
          await broker.restart();
          client = broker.client();
          await kit.ready?.({ broker, client, fake });
        }
      }
    });

    // ------------------------------------------------------------------ C17
    scenario('C17', async () => {
      const stored = fake.seedSession({ title: 'stored without a binary' });
      await client.waitForSession((row) => row.id === stored.id);
      // A session Drive could open while the binary is there; with it gone, nothing may start a writer.
      const drivable = profile.missingBinaryRoster === 'observe-only'
        ? await drivableSession('drive without a binary')
        : undefined;
      fake.setInstalled(false);
      try {
        if (profile.version.cachedByBroker) {
          await broker.restart();
          client = broker.client();
          await kit.ready?.({ broker, client, fake });
        }
        fake.prepareCreate();
        const created = await client.post(`/api/sessions/${agent}`, { directory: fake.workspace('missing') });
        if (assertsFixed('C17', 'create')) {
          expect(created.status).toBe(503);
          expect(created.body.code).toBe('SESSION_CREATE_TEMPORARILY_UNAVAILABLE');
          expect(created.body.retryable).toBe(true);
        } else {
          expect(created.ok).toBe(false);
        }
        if (profile.missingBinaryRoster === 'observe-only') {
          // Listed, Observe-only, and saying why: the reason is the text the client shows for it.
          const row = await client.waitForSession((candidate) => candidate.id === stored.id
            && (candidate.control?.drive?.supported === false || !assertsFixed('C17')));
          if (assertsFixed('C17')) {
            // Create's refusal names the missing binary, as the row does.
            expect(created.body.detailCode).toBe(`${agent}-binary-missing`);
            expect(row.control?.drive?.supported).toBe(false);
            expect(row.control?.drive?.takeoverAvailable).toBeUndefined();
            expect(String(row.control?.drive?.reason)).toMatch(/not installed/i);
            expect(row.attachMode).not.toBe('resume');
          }
          const observer = await client.attach(agent, stored.id);
          const history = await observer.waitForKind('history');
          expect((history.messages as any[]).some((message) => isUser(message, stored.texts[0]!))).toBe(true);
          if (assertsFixed('C17')) {
            // The Session Detail frame carries the same projection as the roster row.
            const detail = (await observer.waitForKind('session')).info;
            expect(detail?.control?.drive?.supported).toBe(false);
            expect(String(detail?.control?.drive?.reason)).toMatch(/not installed/i);
          }
          observer.close();
          if (assertsFixed('C17')) {
            const mark = fake.ledger.mark();
            const refused = await client.attach(agent, drivable!.id, driveOptions(drivable!));
            await expectDriveRefused(refused, 'Drive without a binary');
            refused.close();
            expect(fake.ledger.spawns(mark)).toEqual([]);
          }
        } else {
          // The registry skips an unavailable backend's discovery leg, so a
          // stored session nobody holds open leaves the roster until the
          // binary is back.
          await eventuallyRows(client, (rows) => !rows.some((row) => row.id === stored.id), 'the stored row to leave');
        }
        expect(fake.storeSnapshot().size).toBeGreaterThan(0);
      } finally {
        fake.setInstalled(true);
        if (profile.version.cachedByBroker) {
          await broker.restart();
          client = broker.client();
          await kit.ready?.({ broker, client, fake });
        }
      }
      // Restored binary, restored roster: nothing was deleted.
      await client.waitForSession((row) => row.id === stored.id);
    });

    // ------------------------------------------------------- kit extras
    const context: ConformanceContext = {
      get broker() { return broker; },
      get fake() { return fake; },
      get client() { return client; },
      drivableSession,
      openDrive,
      prompt,
      prompted,
      childStarts,
      async restart() {
        await broker.restart();
        client = broker.client();
        await kit.ready?.({ broker, client, fake });
      },
    };
    for (const extra of kit.extras ?? []) {
      test(`extra: ${extra.title}`, () => extra.run(context));
    }

    test('the fake saw no frame it could not handle', () => {
      expect(fake.ledger.faults()).toEqual([]);
    });

    /** Wait on the fake's ledger (an external process), never a fixed sleep. */
    async function fakeSaw(probe: () => boolean, what: string): Promise<void> {
      await eventually(probe, { what: `the fake to see ${what}` });
    }
  });
}

/**
 * Sends Stop the way a user does: an agent that has not reported the new turn yet answers "try Stop
 * again" (Codex waits 5 s for the turn id), and the user presses Stop again. Under load that answer
 * is real, so the scenario repeats Stop on it instead of assuming the first press reached the turn.
 */
async function sendStop(stream: SessionStream, stop: string): Promise<any> {
  for (let attempt = 1; ; attempt += 1) {
    const from = stream.frames.length;
    const answer = await stream.sendAndAwait({ kind: 'command', name: stop });
    const retry = stream.frames.slice(from)
      .some((frame) => frame.kind === 'notice' && /try Stop again/i.test(String(frame.message)));
    if (!retry || attempt >= 5) return answer;
  }
}

async function eventuallyRows(client: BrokerClient, done: (rows: any[]) => boolean, what: string): Promise<any[]> {
  let last: any[] = [];
  try {
    return await eventually(async () => {
      last = await client.sessions({ refresh: true });
      return done(last) ? last : undefined;
    }, { what });
  } catch (error) {
    const rows = last.map((row) => `${row.tool}/${row.id} ${row.control?.drive?.state ?? ''}`).join(', ');
    throw new Error(`${(error as Error).message}; last roster: [${rows}]`);
  }
}

/** `cosyncing doctor --json` from source against this broker's state, bounded. */
async function doctorJson(broker: Broker, env: Record<string, string>): Promise<{ checks: any[]; raw: string }> {
  const result = await runCli(['doctor', '--json'], { env: { ...broker.env, ...env }, timeoutMs: 60_000 });
  if (result.timedOut) throw new Error(`doctor --json outlived its deadline: ${result.output.slice(-2000)}`);
  let report: any;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`doctor --json printed no JSON (exit ${result.exitCode}): ${result.output.slice(0, 1500)}`);
  }
  const checks = (report.sections ?? []).flatMap((section: any) => section.checks ?? []);
  return { checks, raw: result.output };
}
