/**
 * Drive moving between the app and the terminal.
 *
 * App → terminal: a client hands Drive back (`handoff`). The broker refuses
 * while another foreground client still drives, closes the broker-owned
 * Resume process before it answers, tells every attached client the session
 * left Drive, shows how to continue in the terminal, and fences new Drive
 * attaches while the handoff is in flight.
 *
 * Terminal → app: a Pi terminal whose bridge says hello takes over a session
 * the app was driving; the app's sockets keep working through the bridge and
 * the broker-owned Pi process is closed.
 *
 * Codex Resume owners come from a fake `codex app-server --stdio` (sync-server
 * mode off), Pi's from a fake `pi --mode rpc`; both record every process and
 * request. The zero-client eviction grace keeps its product default here.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Broker, type BrokerClient, eventually, type Frame, type SessionStream, startBroker } from '../harness/index.ts';
import { CodexDriveFake, installCodexDriveFake } from '../harness/fakes/codex-drive.ts';
import { installPiRpcFake, type PiRpcFake } from '../harness/fakes/pi-rpc.ts';
import { PiBridgeSession } from '../harness/fakes/pi-bridge-driver.ts';

const lastSession = (stream: SessionStream): Frame | undefined => stream.ofKind('session').at(-1);

const driving = (stream: SessionStream): Promise<Frame> =>
  stream.waitForFrame((frame) => frame.kind === 'session' && frame.authority?.canMutate === true, {
    what: 'a Driving session frame',
  });

const ownerLeftDrive = (stream: SessionStream, after = 0): Promise<Frame> =>
  stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.sessionOwner?.state === 'none', {
    after,
    what: 'a session frame saying Drive is gone',
  });

describe('handing Drive between the app and the terminal', () => {
  let broker: Broker;
  let codex: CodexDriveFake;
  let pi: PiRpcFake;
  let client: BrokerClient;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'drive-handoff',
      token: true,
      setup: (paths) => {
        codex = installCodexDriveFake(paths);
        pi = installPiRpcFake(paths);
      },
      env: (paths) => ({
        ...CodexDriveFake.environment(paths),
        // A Resume owner that ignores SIGTERM is waited on this long, so a test can hold a handoff open.
        COSYNCING_TEST_CODEX_RESUME_STOP_MS: '60000',
      }),
    });
    client = broker.client();
  });

  afterAll(async () => {
    codex?.releaseStop();
    client?.closeAll();
    await broker?.stop();
  });

  test('handoff waits for the last driver, closes the owner first, and tells every client', async () => {
    const session = codex.rollout('handoff');
    const resident = await client.attach('codex', session.id);
    await resident.waitForKind('history');
    const requester = await client.attach('codex', session.id, { mode: 'resume', reason: 'takeover' });
    await driving(requester);
    const [owner] = codex.owners(session.threadId);

    // A second client joins the same owner through the offer the resident observer was given.
    const offer = await resident.waitForFrame((frame) => frame.kind === 'session' && frame.joinExisting !== undefined);
    const revision = offer.joinExisting.ownerRevision;
    const peer = await client.attach('codex', session.id, {
      mode: 'resume',
      reason: 'join-existing',
      ownerEpoch: revision.epoch,
      ownerSeq: revision.seq,
    });
    await driving(peer);
    expect(codex.owners(session.threadId)).toEqual([owner!]);

    // Refused while the peer still drives: nothing changes for anyone.
    const refused = await requester.sendAndAwait({ kind: 'handoff' });
    expect(refused).toMatchObject({ kind: 'nack', code: 'DRIVE_OWNERSHIP_CONFLICT' });
    expect(refused.message).toContain('Another foreground client');
    expect(codex.exited(owner!)).toBe(false);
    expect((await requester.sendAndAwait({ kind: 'prompt', text: 'still driving' })).kind).toBe('ack');

    peer.close();
    await peer.closed;
    const before = requester.frames.length;
    const residentBefore = resident.frames.length;
    const accepted = await requester.sendAndAwait({ kind: 'handoff' });
    expect(accepted.kind).toBe('ack');
    // The Resume process was gone before the broker answered.
    expect(codex.exited(owner!)).toBe(true);
    // The requester is told Drive left before the ack, and loses mutation.
    const told = await ownerLeftDrive(requester, before);
    expect(requester.frames.indexOf(told)).toBeLessThan(requester.frames.indexOf(accepted));
    const sinceTold = requester.frames.slice(requester.frames.indexOf(told));
    expect(sinceTold.every((frame) => frame.kind !== 'session' || frame.info?.sessionOwner?.state !== 'drive')).toBe(true);
    expect(lastSession(requester)!.authority).toEqual({ canMutate: false, prompt: 'none' });
    expect(lastSession(requester)!.info.control.drive.state).toBe('observing');
    expect((await requester.sendAndAwait({ kind: 'prompt', text: 'after handoff' })).kind).toBe('nack');
    // The resident observer is told too, and is no longer offered anything to join.
    await ownerLeftDrive(resident, residentBefore);
    expect(lastSession(resident)!.joinExisting).toBeUndefined();
    await client.waitForSession((row) => row.id === session.id && row.sessionOwner?.state === 'none');
    expect(codex.prompts().map((entry) => entry.text)).not.toContain('after handoff');
    client.closeAll();
  });

  test('while a handoff is in flight, neither a restore nor a join can take Drive', async () => {
    const session = codex.rollout('fenced');
    const watcher = await client.attach('codex', session.id);
    await watcher.waitForKind('history');
    const requester = await client.attach('codex', session.id, { mode: 'resume', reason: 'takeover' });
    await driving(requester);
    const [owner] = codex.owners(session.threadId);
    const revision = (await watcher.waitForFrame((frame) => frame.kind === 'session' && frame.joinExisting !== undefined))
      .joinExisting.ownerRevision;

    codex.holdStop(true);
    try {
      const before = requester.frames.length;
      requester.send({ kind: 'handoff', clientMessageId: 'fenced-handoff' });
      await eventually(() => codex.stopHeld(owner!), { what: 'the handoff to be closing the Resume owner' });

      const restore = await client.attach('codex', session.id, { mode: 'resume', reason: 'app-restore' });
      await restore.waitForKind('history');
      expect(restore.ofKind('attach-conflict')).toHaveLength(1);
      expect(restore.ofKind('attach-conflict')[0]).toMatchObject({ reason: 'app-restore', code: 'DRIVE_OWNERSHIP_CONFLICT' });
      expect(lastSession(restore)!.authority.canMutate).toBe(false);

      const join = await client.attach('codex', session.id, {
        mode: 'resume',
        reason: 'join-existing',
        ownerEpoch: revision.epoch,
        ownerSeq: revision.seq,
      });
      await join.waitForKind('history');
      expect(join.ofKind('attach-conflict')[0]).toMatchObject({ reason: 'join-existing', code: 'JOIN_OWNER_NOT_FOUND' });
      expect(lastSession(join)!.authority.canMutate).toBe(false);
      expect(codex.owners(session.threadId)).toEqual([owner!]);
      // Until the Resume process has actually exited, the handoff is not answered and Drive is not given up.
      const sinceHandoff = requester.frames.slice(before);
      expect(sinceHandoff.some((frame) => frame.clientMessageId === 'fenced-handoff')).toBe(false);
      expect(sinceHandoff.some((frame) => frame.kind === 'session' && frame.info?.sessionOwner?.state === 'none')).toBe(false);

      codex.releaseStop();
      const answer = await requester.waitForFrame((frame) => frame.clientMessageId === 'fenced-handoff', { after: before });
      expect(answer.kind).toBe('ack');
      await ownerLeftDrive(requester, before);
      expect(codex.owners(session.threadId)).toEqual([owner!]);
    } finally {
      codex.holdStop(false);
      client.closeAll();
    }
  });

  test('a refresh inside the eviction grace rejoins the owner that is still running', async () => {
    const session = codex.rollout('refresh');
    const first = await client.attach('codex', session.id, { mode: 'resume', reason: 'takeover' });
    await driving(first);
    const [owner] = codex.owners(session.threadId);
    first.close();
    await first.closed;
    const refreshed = await client.attach('codex', session.id, { mode: 'resume', reason: 'app-restore' });
    await driving(refreshed);
    expect(codex.owners(session.threadId)).toEqual([owner!]);
    expect(codex.exited(owner!)).toBe(false);
    expect((await refreshed.sendAndAwait({ kind: 'prompt', text: 'same owner' })).kind).toBe('ack');
    expect(codex.prompts().at(-1)).toEqual({ pid: owner!, text: 'same owner' });
    refreshed.close();
  });

  test('a Pi handoff shows how to resume in the terminal, and the terminal coming back is shown synced', async () => {
    const session = pi.sessionFile('pi-handoff');
    const app = await client.attach('pi', session.id, { mode: 'resume', reason: 'takeover' });
    await driving(app);
    const [process1] = pi.spawns();
    expect(process1!.session).toBe(session.file);

    const before = app.frames.length;
    expect((await app.sendAndAwait({ kind: 'handoff' })).kind).toBe('ack');
    // Pi's stop is bounded rather than awaited to the end, so its exit is waited for, not assumed.
    await eventually(() => pi.exited(process1!.pid), { what: 'the broker-owned pi to exit' });
    const handedOff = await ownerLeftDrive(app, before);
    const hint = lastSession(app)!.info.control.terminalSync;
    expect(handedOff.authority.canMutate).toBe(false);
    expect(hint.active).toBe(false);
    expect(hint.command).toContain(`--session '${session.file}'`);

    // The user runs that command; the terminal's bridge announces the session.
    const terminal = await PiBridgeSession.open(client, { cwd: session.cwd, sessionFile: session.file, title: 'pi-handoff' });
    expect(terminal.id).toBe(session.id);
    const synced = await app.waitForFrame((frame) => frame.kind === 'session' && frame.info?.control?.terminalSync?.active === true);
    expect(synced.info.attachMode).toBe('live');
    expect(synced.authority.canMutate).toBe(true);
    expect(pi.spawns()).toHaveLength(1);
    await terminal.bye();
    client.closeAll();
  });

  test('a terminal bridge folds the app\'s Drive owner into itself, and later restores join the bridge', async () => {
    const session = pi.sessionFile('pi-fold');
    const observer = await client.attach('pi', session.id);
    await observer.waitForKind('history');
    const driver = await client.attach('pi', session.id, { mode: 'resume', reason: 'takeover' });
    await driving(driver);
    const owner = pi.spawns().find((spawn) => spawn.session === session.file)!;
    expect((await driver.sendAndAwait({ kind: 'prompt', text: 'to the broker-owned pi' })).kind).toBe('ack');
    expect(pi.commands('prompt').some((entry) => entry.pid === owner.pid && entry.command.message === 'to the broker-owned pi')).toBe(true);

    // The user resumes the same session in a terminal with the bridge installed.
    const terminal = await PiBridgeSession.open(client, {
      cwd: session.cwd,
      sessionFile: session.file,
      title: 'pi-fold',
      hello: { history: [{ t: 'user', key: 'hello-window', text: 'typed while the bridge connected' }] },
    });
    await eventually(() => pi.exited(owner.pid), { what: 'the broker-owned pi to be closed' });

    // Both sockets kept their identity and now hear the terminal, including what it said in its hello.
    await terminal.events({ t: 'user', key: 'terminal-1', text: 'typed in the terminal' });
    for (const stream of [driver, observer]) {
      await stream.waitForMessage((message) => message.text === 'typed in the terminal');
      await stream.waitForMessage((message) => message.text === 'typed while the bridge connected');
      expect(stream.isOpen).toBe(true);
    }
    // The driving socket's prompts now reach the terminal.
    expect((await driver.sendAndAwait({ kind: 'prompt', text: 'through the bridge' })).kind).toBe('ack');
    await terminal.nextCommand((command) => command.kind === 'prompt' && command.text === 'through the bridge');

    // A later restore joins the pinned bridge: no rival pi is started.
    const restored = await client.attach('pi', session.id, { mode: 'resume', reason: 'app-restore' });
    const joined = await driving(restored);
    expect(restored.ofKind('attach-conflict')).toEqual([]);
    expect(joined.info.attachMode).toBe('live');
    expect(pi.spawns().filter((spawn) => spawn.session === session.file)).toEqual([owner]);
    expect((await restored.sendAndAwait({ kind: 'prompt', text: 'from the restored tab' })).kind).toBe('ack');
    await terminal.nextCommand((command) => command.kind === 'prompt' && command.text === 'from the restored tab');
    await terminal.bye();
    client.closeAll();
  });
});
