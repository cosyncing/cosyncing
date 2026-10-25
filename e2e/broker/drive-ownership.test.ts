/**
 * Drive ownership: who holds Drive, how it is restored, and how a contested
 * restore is answered.
 *
 * One real broker drives stored Codex sessions through a fake `codex` whose
 * `app-server --stdio` is the Resume owner (sync-server mode off), so every
 * owner the broker starts is a process the fake records. The zero-client
 * eviction grace is shortened through the source-mode hook, which makes "the
 * last client left" observable as that process exiting. A competing terminal
 * is staged in a fake `/proc`, and an OpenCode serve is faked for the one
 * agent whose bare attach is already a mutable owner. A fake `claude` drives app-created Claude
 * sessions the way Claude Code answers on stream-json, so its background tasks, interrupts and
 * setting changes are observable as what happens to its process.
 *
 * A second broker runs Codex with terminal sync on against a daemon that
 * crashed and left its control socket behind: that socket is no daemon, so
 * Take over starts a private owner, while a daemon that still listens but
 * does not answer keeps Take over refused. A third runs with sync off and no
 * daemon socket on disk at all: a restore still weighs the terminals it finds.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Broker, type BrokerClient, eventually, type Frame, type SessionStream, startBroker } from '../harness/index.ts';
import {
  CodexDriveFake,
  type CodexRollout,
  crashedDaemonSocket,
  installCodexDriveFake,
  unresponsiveDaemon,
} from '../harness/fakes/codex-drive.ts';
import { type ClaudeLaunch, type FakeClaudeCli, installFakeClaudeCli, promptTexts } from '../harness/fakes/claude-cli.ts';
import { type FakeCommand, installFakeCommand } from '../harness/fakes/command.ts';
import { type FakeOpenCodeServer, openCodeRows, startFakeOpenCode } from '../harness/fakes/opencode-server.ts';

const lastSession = (stream: SessionStream): Frame | undefined => stream.ofKind('session').at(-1);

/** The first session frame that grants mutation, i.e. the socket is Driving. */
const driving = (stream: SessionStream): Promise<Frame> =>
  stream.waitForFrame((frame) => frame.kind === 'session' && frame.authority?.canMutate === true, {
    what: 'a Driving session frame',
  });

async function prompt(stream: SessionStream, text: string): Promise<Frame> {
  return stream.sendAndAwait({ kind: 'prompt', text });
}

/**
 * Ask for a session stream the way the app does (a one-use ticket bound to the
 * attach parameters), but as plain HTTP: the answer is the broker's verdict on
 * the parameters, 426 meaning they passed and only the upgrade was missing.
 */
async function probeStream(
  client: BrokerClient,
  sessionId: string,
  params: Record<string, string>,
): Promise<{ status: number; code?: string }> {
  const ticket = await client.post('/api/ws-auth-tickets', { tool: 'codex', sessionId, params });
  expect(ticket.status, ticket.text).toBe(201);
  const response = await fetch(
    `${client.url}/api/sessions/codex/${encodeURIComponent(sessionId)}/stream?wsAuthTicket=${ticket.body.wsAuthTicket}`,
  );
  const body = await response.json().catch(() => undefined) as { code?: string } | undefined;
  return { status: response.status, code: body?.code };
}

describe('Drive ownership across clients, evictions and restarts', () => {
  let broker: Broker;
  let codex: CodexDriveFake;
  let opencode: FakeCommand;
  let serve: FakeOpenCodeServer;
  let client: BrokerClient;
  let worktree: string;
  let claude: FakeClaudeCli;
  let claudeWorkspace: string;

  async function createClaude(title: string): Promise<any> {
    const created = await client.post('/api/sessions/claude', { directory: claudeWorkspace, title });
    expect(created.status, created.text).toBe(200);
    return created.body.session;
  }

  /** The native session a launch drives: `--session-id` on a first launch, `--resume` after. */
  const nativeSession = (launch: ClaudeLaunch): string | undefined =>
    claude.option(launch, '--session-id') ?? claude.option(launch, '--resume');

  /** Every process the broker started for the Claude session that `launch` drives. */
  const claudeLaunches = (launch: ClaudeLaunch): ClaudeLaunch[] =>
    claude.launches().filter((candidate) => nativeSession(candidate) === nativeSession(launch));

  /** The process that received a prompt containing `marker`. */
  const claudeLaunchFor = (marker: string): Promise<ClaudeLaunch> =>
    eventually(() => claude.launches().find((launch) => promptTexts(launch).some((text) => text.includes(marker))), {
      what: `the Claude process given "${marker}"`,
    });

  /** The latest ledger view of a launch (its stdin grows as the broker writes). */
  const reread = (launch: ClaudeLaunch): ClaudeLaunch => claude.launches().find((candidate) => candidate.pid === launch.pid)!;

  const controlRequests = (launch: ClaudeLaunch): any[] =>
    reread(launch).stdin.filter((line) => line?.type === 'control_request').map((line) => line.request);

  const runSummaries = (stream: SessionStream, status: string): any[] =>
    stream.messages().filter((message) => message.type === 'run-summary' && message.status === status);

  beforeAll(async () => {
    worktree = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-drive-opencode-'));
    serve = startFakeOpenCode(worktree, 'ses_shared_live');
    broker = await startBroker({
      name: 'drive-ownership',
      token: true,
      setup: (paths) => {
        codex = installCodexDriveFake(paths);
        opencode = installFakeCommand(paths.bin, 'opencode', "if (argv[0] === '--version') console.log('1.17.19');");
        claude = installFakeClaudeCli(paths.bin);
        claudeWorkspace = join(paths.home, 'projects', 'claude-drive');
        mkdirSync(claudeWorkspace, { recursive: true });
      },
      env: (paths) => ({
        ...CodexDriveFake.environment(paths),
        OPENCODE_URL: serve.url,
        COSYNCING_CLAUDE_BIN: claude.path,
        COSYNCING_TEST_HUB_EVICT_GRACE_MS: '300',
        COSYNCING_TEST_CLAUDE_INTERRUPT_GRACE_MS: '1500',
      }),
    });
    client = broker.client();
  });

  afterAll(async () => {
    client?.closeAll();
    await broker?.stop();
    serve?.stop();
    if (worktree) rmSync(worktree, { recursive: true, force: true });
  });

  test('the last client leaving evicts the owner, and every reason-tagged reopen restores exactly one', async () => {
    const session = codex.rollout('evict');
    // The app opens a session it just created in Drive.
    const first = await client.attach('codex', session.id, { mode: 'resume', reason: 'create' });
    const created = await driving(first);
    expect(created.info.control.drive).toEqual({ supported: true, state: 'driving' });
    expect(created.info.sessionOwner.state).toBe('drive');
    expect((await prompt(first, 'first turn')).kind).toBe('ack');
    const [owner1] = codex.owners(session.threadId);
    expect(codex.prompts()).toContainEqual({ pid: owner1!, text: 'first turn' });
    await client.waitForSession((row) => row.id === session.id && row.sessionOwner?.state === 'drive');

    // The last client leaves: after the grace the owner process is closed and the roster says so.
    first.close();
    await eventually(() => codex.exited(owner1!), { what: 'the clientless owner to be evicted' });
    await client.waitForSession((row) => row.id === session.id && row.sessionOwner?.state === 'none');

    // The app reopens from its durable Drive preference: one new owner, Driving, prompt-capable.
    const reopened = await client.attach('codex', session.id, { mode: 'resume', reason: 'app-restore' });
    const restored = await driving(reopened);
    expect(reopened.ofKind('attach-conflict')).toEqual([]);
    expect(restored.authority).toEqual({ canMutate: true, prompt: 'full' });
    const owners = codex.owners(session.threadId);
    expect(owners).toHaveLength(2);
    expect((await prompt(reopened, 'after restore')).kind).toBe('ack');
    expect(codex.prompts()).toContainEqual({ pid: owners[1]!, text: 'after restore' });

    // The broker imposes no lease of its own: a later reopen restores the same way.
    reopened.close();
    await eventually(() => codex.exited(owners[1]!), { what: 'the second owner to be evicted' });
    const later = await client.attach('codex', session.id, { mode: 'resume', reason: 'lease-restore' });
    await driving(later);
    expect(codex.owners(session.threadId)).toHaveLength(3);
    later.close();
  });

  test('two clients restoring at once share one owner', async () => {
    const session = codex.rollout('concurrent');
    const [left, right] = await Promise.all([
      client.attach('codex', session.id, { mode: 'resume', reason: 'app-restore' }),
      client.attach('codex', session.id, { mode: 'resume', reason: 'app-restore' }),
    ]);
    await Promise.all([driving(left), driving(right)]);
    const owners = codex.owners(session.threadId);
    expect(owners).toHaveLength(1);
    expect((await prompt(left, 'from the left')).kind).toBe('ack');
    expect((await prompt(right, 'from the right')).kind).toBe('ack');
    expect(codex.prompts().filter((entry) => entry.text.startsWith('from the'))).toEqual([
      { pid: owners[0]!, text: 'from the left' },
      { pid: owners[0]!, text: 'from the right' },
    ]);
    left.close();
    right.close();
  });

  // Terminal presence is read from /proc on Linux (the fake one here); macOS scans processes another way.
  test.skipIf(process.platform !== 'linux')('a competing terminal turns an automatic restore into a structured conflict on the same socket', async () => {
    const session = codex.rollout('contested');
    const removeTerminal = codex.competingTerminal(session);
    try {
      const refused = await client.attach('codex', session.id, { mode: 'resume', reason: 'app-restore' });
      await refused.waitForKind('history');
      expect(refused.frames[0]?.kind).toBe('hello');
      const conflicts = refused.ofKind('attach-conflict');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        requestedMode: 'resume',
        reason: 'app-restore',
        code: 'DRIVE_OWNERSHIP_CONFLICT',
      });
      expect(conflicts[0]!.message).toContain('terminal');
      // The same socket carries on as Observe, and says why: a private terminal holds the session.
      const kinds = refused.frames.map((frame) => frame.kind);
      expect(kinds.indexOf('session')).toBeGreaterThan(kinds.indexOf('attach-conflict'));
      const observe = lastSession(refused)!;
      expect(observe.info.attachMode).toBe('observe');
      expect(observe.info.control.drive.state).toBe('observing');
      expect(observe.info.control.terminalSync.presence).toBe('private');
      expect(observe.authority).toEqual({ canMutate: false, prompt: 'none' });
      expect((await prompt(refused, 'must not reach codex')).kind).toBe('nack');
      expect(codex.owners(session.threadId)).toEqual([]);

      // A live takeover that cannot be honoured is reported as the live attach it was.
      const live = await client.attach('codex', session.id, { mode: 'live', reason: 'takeover' });
      await live.waitForKind('history');
      expect(live.ofKind('attach-conflict')).toHaveLength(1);
      expect(live.ofKind('attach-conflict')[0]).toMatchObject({ requestedMode: 'live', reason: 'takeover' });
      expect(lastSession(live)!.info.attachMode).toBe('observe');

      // A plain attach joins quietly.
      const bare = await client.attach('codex', session.id);
      await bare.waitForKind('history');
      expect(bare.ofKind('attach-conflict')).toEqual([]);
      expect(codex.owners(session.threadId)).toEqual([]);

      // The user can still confirm Take over explicitly.
      const takeover = await client.attach('codex', session.id, { mode: 'resume', reason: 'takeover' });
      await driving(takeover);
      expect(takeover.ofKind('attach-conflict')).toEqual([]);
      expect(codex.owners(session.threadId)).toHaveLength(1);
      expect((await prompt(takeover, 'taken over')).kind).toBe('ack');
      expect(codex.prompts().at(-1)).toEqual({ pid: codex.owners(session.threadId)[0]!, text: 'taken over' });
      client.closeAll();
    } finally {
      removeTerminal();
    }
  });

  test('attach reasons and owner revisions are validated before the upgrade', async () => {
    const session = codex.rollout('validation');
    const refusals: Array<[string, Record<string, string>]> = [
      ['an unknown reason', { mode: 'resume', reason: 'bogus' }],
      ['a reason without a Drive mode', { reason: 'app-restore' }],
      ['join-existing without an owner revision', { mode: 'resume', reason: 'join-existing' }],
      ['an owner revision without join-existing', { mode: 'resume', reason: 'app-restore', ownerEpoch: 'epoch', ownerSeq: '1' }],
      ['join-existing on a live attach', { mode: 'live', reason: 'join-existing', ownerEpoch: 'epoch', ownerSeq: '1' }],
      ['an owner revision on a live takeover', { mode: 'live', reason: 'takeover', ownerEpoch: 'epoch', ownerSeq: '1' }],
      ['create on a live attach', { mode: 'live', reason: 'create' }],
      ['app-restore on a live attach', { mode: 'live', reason: 'app-restore' }],
      ['lease-restore on a live attach', { mode: 'live', reason: 'lease-restore' }],
    ];
    for (const [label, params] of refusals) {
      expect({ label, ...(await probeStream(client, session.id, params)) }).toEqual({ label, status: 400, code: 'BAD_PARAM' });
    }
    // Every reason stays valid on resume, and takeover is the one reason live accepts.
    const accepted: Array<Record<string, string>> = [
      { mode: 'live', reason: 'takeover' },
      ...['create', 'app-restore', 'lease-restore', 'takeover'].map((reason) => ({ mode: 'resume', reason })),
    ];
    for (const params of accepted) {
      expect({ ...params, status: (await probeStream(client, session.id, params)).status })
        .toEqual({ ...params, status: 426 });
    }
    // join-existing keeps the authenticated Drive boundary.
    const unauthenticated = await fetch(
      `${broker.url}/api/sessions/codex/${session.id}/stream?mode=resume&reason=join-existing&ownerEpoch=epoch&ownerSeq=1`,
    );
    expect(unauthenticated.status).toBe(401);
    expect(codex.owners(session.threadId)).toEqual([]);
  });

  test('a socket that declares itself read-only is never given Drive or offered a join', async () => {
    const session = codex.rollout('read-only');
    // The same request that would take Drive, declared read-only: no owner is started.
    const readOnly = await client.attach('codex', session.id, { mode: 'resume', reason: 'takeover', readOnly: true });
    await readOnly.waitForKind('history');
    const hello = readOnly.ofKind('hello')[0]!;
    expect(hello.compatibility.readOnly).toBe(true);
    expect(hello.compatibility.status).toBe('compatible');
    expect(typeof hello.compatibility.reason).toBe('string');
    expect(readOnly.ofKind('notice')[0]?.message).toStartWith('This session is read-only.');
    expect(lastSession(readOnly)!.authority).toEqual({ canMutate: false, prompt: 'none' });
    expect(lastSession(readOnly)!.info.attachMode).toBe('observe');
    const refused = await prompt(readOnly, 'refused at the broker');
    expect(refused).toMatchObject({ kind: 'nack', code: 'CLIENT_MESSAGE_FAILED' });
    expect(refused.message).toContain('read-only session');
    expect(codex.owners(session.threadId)).toEqual([]);

    // Once another client drives, an ordinary socket is offered the owner to join; a read-only one is not.
    const driver = await client.attach('codex', session.id, { mode: 'resume', reason: 'takeover' });
    await driving(driver);
    const ordinary = await client.attach('codex', session.id);
    await ordinary.waitForFrame((frame) => frame.kind === 'session' && frame.joinExisting !== undefined);
    await readOnly.waitForFrame((frame) => frame.kind === 'session' && frame.info?.sessionOwner?.state === 'drive');
    const lateReadOnly = await client.attach('codex', session.id, { readOnly: true });
    await lateReadOnly.waitForKind('history');
    for (const stream of [readOnly, lateReadOnly]) {
      expect(stream.ofKind('session').every((frame) => frame.joinExisting === undefined)).toBe(true);
    }
    expect(codex.owners(session.threadId)).toHaveLength(1);
    expect(codex.prompts().map((entry) => entry.text)).not.toContain('refused at the broker');

    // Declared read-only AND genuinely incompatible: the incompatibility is the one reported.
    const both = await client.attach('codex', session.id, {
      readOnly: true,
      params: {
        clientVersion: '0.0.1',
        contractRevision: '15',
        minimumBrokerRevision: '999',
        contractSurfaceHash: 'fnv1a32:00000000',
      },
    });
    await both.waitForKind('session');
    expect(both.ofKind('hello')[0]!.compatibility).toMatchObject({ status: 'hard-incompatible', readOnly: true });
    expect(both.ofKind('notice')[0]?.message).toContain('incompatible');
    client.closeAll();
  });

  test('an already-mutable bare owner wins: a restore joins it instead of starting a rival', async () => {
    // Control: with no owner registered, a resume builds its own run owner.
    const rival = await client.attach('opencode', serve.sessionId, { mode: 'resume', reason: 'app-restore' });
    expect((await rival.waitForKind('session')).info.attachMode).toBe('resume');
    rival.close();

    // OpenCode's shared serve makes a plain attach the live, mutable owner.
    const shared = await client.attach('opencode', serve.sessionId);
    const live = await shared.waitForKind('session');
    expect(live.info.attachMode).toBe('live');
    expect(live.authority.canMutate).toBe(true);
    const restore = await client.attach('opencode', serve.sessionId, { mode: 'resume', reason: 'app-restore' });
    const joined = await restore.waitForKind('session');
    expect(restore.ofKind('attach-conflict')).toEqual([]);
    expect(joined.info.attachMode).toBe('live');
    expect(joined.authority.canMutate).toBe(true);
    // The joined tab still offers the terminal the way to join the same serve.
    expect(joined.info.control.terminalSync.action).toBe('join');
    expect(joined.info.control.terminalSync.command).toContain(`opencode attach '${serve.url}' -s '${serve.sessionId}'`);
    // Both sockets now hear the one owner.
    serve.announce(openCodeRows.user('msg_terminal', 10, 'typed in the shared serve'));
    await shared.waitForMessage((message) => message.text === 'typed in the shared serve');
    await restore.waitForMessage((message) => message.text === 'typed in the shared serve');

    // Here a plain attach IS Drive, so a socket that declared itself read-only must still get none of it,
    // without the session itself being reported any differently.
    const readOnly = await client.attach('opencode', serve.sessionId, { readOnly: true });
    const declared = await readOnly.waitForKind('session');
    expect(declared.authority).toEqual({ canMutate: false, prompt: 'none' });
    expect(declared.info.control.drive.state).toBe('driving');
    const posts = () => serve.requests.filter((request) => request.startsWith('POST')).length;
    const postsBefore = posts();
    expect((await readOnly.sendAndAwait({ kind: 'prompt', text: 'not from a read-only tab' })).kind).toBe('nack');
    expect(posts()).toBe(postsBefore);
    expect(opencode.calls().filter((call) => call.argv[0] === 'run')).toEqual([]);
    client.closeAll();
  });

  test('a native rename answers with the accepted title and reaches an attached Observe socket', async () => {
    const session = codex.rollout('rename');
    const watcher = await client.attach('codex', session.id);
    await watcher.waitForKind('history');
    const renamed = await client.request('PATCH', `/api/sessions/codex/${session.id}/rename`, { title: 'Accepted native title' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.title).toBe('Accepted native title');
    expect(renamed.body.session.title).toBe('Accepted native title');
    await watcher.waitForFrame((frame) => frame.kind === 'session' && frame.info?.title === 'Accepted native title');
    expect(codex.requests('thread/name/set').at(-1)?.params).toEqual({ threadId: session.threadId, name: 'Accepted native title' });
    watcher.close();
  });

  test.skipIf(process.platform !== 'linux')('with terminal sync off, a control socket a crashed daemon left behind is no daemon to drive through', async () => {
    // This broker names `<root>/codex-daemon.sock` and nothing was there; now a crash leaves a socket file.
    const socket = join(broker.paths.root, 'codex-daemon.sock');
    await crashedDaemonSocket(socket);
    try {
      const session = codex.rollout('sync-off-crashed');
      const takeover = await client.attach('codex', session.id, { mode: 'resume', reason: 'takeover' });
      expect((await driving(takeover)).info.attachMode).toBe('resume');
      expect(codex.owners(session.threadId)).toHaveLength(1);
      expect((await prompt(takeover, 'past the stale socket')).kind).toBe('ack');
      expect(lstatSync(socket).isSocket()).toBe(true);
      takeover.close();
    } finally {
      rmSync(socket, { force: true });
    }
  });

  test('a Claude process running background work outlives its last client, and is evicted when the work ends', async () => {
    const working = await createClaude('background work');
    const idle = await createClaude('no background work');
    const workingStream = await client.attach('claude', working.id, { mode: 'resume' });
    const idleStream = await client.attach('claude', idle.id, { mode: 'resume' });
    await driving(workingStream);
    await driving(idleStream);
    expect((await prompt(workingStream, 'watch for the eviction scenario [fake:bg]')).kind).toBe('ack');
    expect((await prompt(idleStream, 'answer once [fake:turn]')).kind).toBe('ack');
    const watcher = await claudeLaunchFor('watch for the eviction scenario');
    const answered = await claudeLaunchFor('answer once');
    await workingStream.waitForMessage((message) => message.type === 'run-summary' && message.status === 'done');
    await idleStream.waitForMessage((message) => message.type === 'run-summary' && message.status === 'done');

    // Both turns are over and both sockets leave, the working one first. The idle owner being
    // evicted proves the grace has passed for both; the process with background work is still there.
    workingStream.close();
    await workingStream.closed;
    idleStream.close();
    await eventually(() => !claude.alive(answered), { what: 'the idle Claude owner to be evicted' });
    expect(claude.alive(watcher)).toBe(true);

    // The user comes back to the same process and keeps going.
    const back = await client.attach('claude', working.id, { mode: 'resume' });
    await driving(back);
    expect((await prompt(back, 'and then [fake:turn]')).kind).toBe('ack');
    await eventually(() => promptTexts(reread(watcher)).some((text) => text.includes('and then')), {
      what: 'the returning prompt to reach the same process',
    });
    expect(claudeLaunches(watcher)).toHaveLength(1);
    back.close();
    await back.closed;

    // The background work ends while nobody is attached: the owner is evicted as usual.
    claude.endBackgroundWork(watcher);
    await eventually(() => !claude.alive(watcher), { what: 'the owner to be evicted once its background work ended' });
  });

  test('Stop interrupts a Claude turn and keeps its process; a process that ignores the interrupt is ended', async () => {
    const session = await createClaude('stop');
    const stream = await client.attach('claude', session.id, { mode: 'resume' });
    await driving(stream);
    expect((await prompt(stream, 'watch for the stop scenario [fake:bg]')).kind).toBe('ack');
    const child = await claudeLaunchFor('watch for the stop scenario');
    await stream.waitForMessage((message) => message.type === 'run-summary' && message.status === 'done');

    expect((await prompt(stream, 'long work [fake:hold]')).kind).toBe('ack');
    expect((await stream.sendAndAwait({ kind: 'command', name: 'stop' })).kind).toBe('ack');
    await eventually(() => runSummaries(stream, 'cancelled').length === 1, { what: 'the interrupted turn to end as cancelled' });
    expect(controlRequests(child)).toContainEqual({ subtype: 'interrupt', cancel_queued: true });
    expect(claude.alive(child)).toBe(true);
    expect(stream.messages().filter((message) => message.type === 'error')).toEqual([]);

    // A permission ask open when Stop lands is withdrawn by the agent, and its card goes with it.
    expect((await prompt(stream, 'needs approval [fake:permission]')).kind).toBe('ack');
    const ask = await stream.waitForMessage((message) => message.type === 'permission-request');
    expect((await stream.sendAndAwait({ kind: 'command', name: 'stop' })).kind).toBe('ack');
    await stream.waitForMessage((message) => message.type === 'permission-resolved' && message.requestId === ask.requestId);
    await eventually(() => runSummaries(stream, 'cancelled').length === 2, { what: 'the blocked turn to end as cancelled' });
    expect(claude.alive(child)).toBe(true);
    expect(claudeLaunches(child)).toHaveLength(1);

    // An agent that never answers the interrupt is ended after the grace, as Stop always did.
    expect((await prompt(stream, 'stuck [fake:deaf]')).kind).toBe('ack');
    expect((await stream.sendAndAwait({ kind: 'command', name: 'stop' })).kind).toBe('ack');
    await eventually(() => !claude.alive(child), { what: 'the unresponsive Claude process to be ended' });
    await eventually(() => runSummaries(stream, 'cancelled').length === 3, { what: 'the stuck turn to end as cancelled' });
    expect(stream.messages().filter((message) => message.type === 'error')).toEqual([]);
    stream.close();
  });

  test('Stop drops a prompt queued behind the Claude turn, and nothing then holds the process once its client leaves', async () => {
    const session = await createClaude('stop with a queued prompt');
    const stream = await client.attach('claude', session.id, { mode: 'resume' });
    await driving(stream);
    expect((await prompt(stream, 'busy for the queue scenario [fake:hold]')).kind).toBe('ack');
    const child = await claudeLaunchFor('busy for the queue scenario');
    expect((await prompt(stream, 'queued behind it [fake:turn]')).kind).toBe('ack');
    await stream.waitForMessage((message) => message.type === 'user-message' && message.queued === true && message.text.includes('queued behind it'));
    await eventually(() => promptTexts(reread(child)).some((text) => text.includes('queued behind it')), {
      what: 'the queued prompt to reach the agent',
    });

    expect((await stream.sendAndAwait({ kind: 'command', name: 'stop' })).kind).toBe('ack');
    await eventually(() => runSummaries(stream, 'cancelled').length === 1, { what: 'the interrupted turn to end as cancelled' });
    expect(runSummaries(stream, 'done')).toEqual([]);
    stream.close();
    await stream.closed;
    await eventually(() => !claude.alive(child), { what: 'the owner to be evicted after Stop dropped its queued prompt' });
  });

  test('a model, permission-mode or effort change reaches the running Claude process instead of restarting it', async () => {
    const session = await createClaude('switch');
    const stream = await client.attach('claude', session.id, { mode: 'resume' });
    await driving(stream);
    expect((await prompt(stream, 'watch for the switch scenario [fake:bg]')).kind).toBe('ack');
    const child = await claudeLaunchFor('watch for the switch scenario');
    await stream.waitForMessage((message) => message.type === 'run-summary' && message.status === 'done');

    const switched = await stream.sendAndAwait({
      kind: 'prompt',
      text: 'now on sonnet [fake:turn]',
      model: { providerID: 'anthropic', modelID: 'sonnet', reasoningEffort: 'low' },
      permissionMode: 'acceptEdits',
    });
    expect(switched.kind).toBe('ack');
    await eventually(() => promptTexts(reread(child)).some((text) => text.includes('now on sonnet')), {
      what: 'the switched prompt to reach the same process',
    });
    expect(controlRequests(child)).toEqual(expect.arrayContaining([
      { subtype: 'set_model', model: 'sonnet' },
      { subtype: 'set_permission_mode', mode: 'acceptEdits' },
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } },
    ]));
    // Each change is applied before the prompt that asked for it.
    const lines = reread(child).stdin;
    const promptAt = lines.findIndex((line) => line?.type === 'user' && promptTexts({ ...child, stdin: [line] }).some((text) => text.includes('now on sonnet')));
    expect(lines.findIndex((line) => line?.request?.subtype === 'set_model')).toBeLessThan(promptAt);
    expect(claudeLaunches(child)).toHaveLength(1);
    // Every client sees the session on the model, mode and effort the agent now runs.
    await stream.waitForFrame((frame: any) => frame.kind === 'session'
      && frame.info?.currentMode === 'acceptEdits'
      && frame.info?.currentModel?.modelID === 'claude-sonnet'
      && frame.info?.currentModel?.reasoningEffort === 'low');

    // A change the agent refuses would need a restart; while background work runs it is refused.
    expect((await prompt(stream, 'refuse changes from now [fake:refuse] [fake:turn]')).kind).toBe('ack');
    const refused = await stream.sendAndAwait({ kind: 'prompt', text: 'back to opus', model: { providerID: 'anthropic', modelID: 'opus' } });
    expect(refused.kind).toBe('nack');
    expect(String(refused.message)).toContain('background tasks');
    expect(claude.alive(child)).toBe(true);
    expect(promptTexts(reread(child)).some((text) => text.includes('back to opus'))).toBe(false);

    // With no background work left, the refused change restarts the agent with it, as before.
    claude.endBackgroundWork(child);
    await eventually(async () => {
      const restarted = await stream.sendAndAwait({ kind: 'prompt', text: 'opus after the work [fake:turn]', model: { providerID: 'anthropic', modelID: 'opus' } });
      return restarted.kind === 'ack';
    }, { what: 'the change to be accepted by a restart once background work ended' });
    const relaunched = await claudeLaunchFor('opus after the work');
    expect(relaunched.pid).not.toBe(child.pid);
    expect(claude.option(relaunched, '--model')).toBe('opus');
    await eventually(() => !claude.alive(child), { what: 'the replaced process to exit' });
    stream.close();
  });

  // Last: it restarts the broker.
  test('after a broker restart a reason-tagged reopen restores one owner, and a second reopen joins it', async () => {
    const session: CodexRollout = codex.rollout('restart');
    const before = await client.attach('codex', session.id, { mode: 'resume', reason: 'takeover' });
    await driving(before);
    before.close();
    await broker.restart();
    client = broker.client();
    const ownersBefore = codex.owners(session.threadId).length;

    const restored = await client.attach('codex', session.id, { mode: 'resume', reason: 'app-restore' });
    await driving(restored);
    expect(codex.owners(session.threadId)).toHaveLength(ownersBefore + 1);
    const again = await client.attach('codex', session.id, { mode: 'resume', reason: 'app-restore' });
    await driving(again);
    expect(codex.owners(session.threadId)).toHaveLength(ownersBefore + 1);
    expect((await prompt(again, 'after restart')).kind).toBe('ack');
    expect(codex.prompts().at(-1)).toEqual({ pid: codex.owners(session.threadId).at(-1)!, text: 'after restart' });
    client.closeAll();
  });
});

// Unix control sockets: Linux and macOS. Listener evidence for a plain socket file is Linux-only
// (`/proc/net/unix`); an alias whose target is gone is proof on any host.
describe.skipIf(process.platform === 'win32')('Take over after the Codex daemon crashed and left its control socket', () => {
  const linux = process.platform === 'linux';
  let broker: Broker;
  let codex: CodexDriveFake;
  let client: BrokerClient;
  let control: string;
  let runtime: string;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'drive-crashed-daemon',
      token: true,
      setup: (paths) => {
        codex = installCodexDriveFake(paths);
        control = join(paths.root, 'control', 'app-server-control.sock');
        runtime = join(paths.root, 'runtime');
        mkdirSync(join(paths.root, 'control'), { recursive: true });
        mkdirSync(runtime, { recursive: true });
      },
      env: (paths) => CodexDriveFake.environment(paths, { sync: true, daemonSocket: control }),
    });
    client = broker.client();
  });

  afterAll(async () => {
    client?.closeAll();
    await broker?.stop();
  });

  /** Take over (and then a restore) both start the broker's own app-server, and the socket is left as it was. */
  async function drivesWithoutTheDaemon(name: string): Promise<void> {
    const before = lstatSync(control);
    const session = codex.rollout(name);
    const takeover = await client.attach('codex', session.id, { mode: 'resume', reason: 'takeover' });
    const taken = await driving(takeover);
    expect(takeover.ofKind('attach-conflict')).toEqual([]);
    expect(taken.info.attachMode).toBe('resume');
    expect(codex.owners(session.threadId)).toHaveLength(1);
    expect((await prompt(takeover, `${name}: taken over`)).kind).toBe('ack');
    expect(codex.prompts().at(-1)).toEqual({ pid: codex.owners(session.threadId)[0]!, text: `${name}: taken over` });
    takeover.close();

    const later = codex.rollout(`${name}-restore`);
    const restored = await client.attach('codex', later.id, { mode: 'resume', reason: 'app-restore' });
    await driving(restored);
    expect(restored.ofKind('attach-conflict')).toEqual([]);
    expect(codex.owners(later.threadId)).toHaveLength(1);
    restored.close();

    // Read-only: the socket a crash left behind is neither removed nor replaced.
    const after = lstatSync(control);
    expect({ ino: after.ino, link: after.isSymbolicLink(), socket: after.isSocket() })
      .toEqual({ ino: before.ino, link: before.isSymbolicLink(), socket: before.isSocket() });
  }

  test.skipIf(!linux)('a socket file nothing listens on is no daemon', async () => {
    await crashedDaemonSocket(control);
    await drivesWithoutTheDaemon('crashed');
  });

  test.skipIf(!linux)('a symlinked control socket whose runtime socket nothing listens on is no daemon', async () => {
    rmSync(control, { force: true });
    await crashedDaemonSocket(join(runtime, 'crashed.sock'));
    symlinkSync(join(runtime, 'crashed.sock'), control);
    await drivesWithoutTheDaemon('crashed-alias');
  });

  test('a symlinked control socket whose runtime socket is gone is no daemon', async () => {
    rmSync(control, { force: true });
    symlinkSync(join(runtime, 'removed.sock'), control);
    await drivesWithoutTheDaemon('dangling-alias');
  });

  test('a daemon that still listens but does not answer keeps Take over refused', async () => {
    rmSync(control, { force: true });
    const daemon = await unresponsiveDaemon(control);
    try {
      const session = codex.rollout('unresponsive');
      const refused = await client.attach('codex', session.id, { mode: 'resume', reason: 'takeover' });
      await refused.waitForKind('history');
      expect(refused.ofKind('attach-conflict')).toHaveLength(1);
      expect(refused.ofKind('attach-conflict')[0]).toMatchObject({ requestedMode: 'resume', reason: 'takeover', code: 'DRIVE_OWNERSHIP_UNKNOWN' });
      expect(lastSession(refused)!.info.attachMode).toBe('observe');
      expect(codex.owners(session.threadId)).toEqual([]);
      refused.close();
    } finally {
      await daemon.close();
    }
  });
});

// Terminal presence is read from the fake `/proc` on Linux; macOS would scan the host's real processes.
describe.skipIf(process.platform !== 'linux')('Restoring Drive on a host with no Codex daemon socket', () => {
  let broker: Broker;
  let codex: CodexDriveFake;
  let client: BrokerClient;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'drive-no-daemon-socket',
      token: true,
      setup: (paths) => {
        codex = installCodexDriveFake(paths);
      },
      // Sync off, and no socket named: Codex's own control socket under the fixture CODEX_HOME is absent.
      env: (paths) => ({ ...CodexDriveFake.environment(paths, { daemonSocket: null }), COSYNCING_TEST_HUB_EVICT_GRACE_MS: '300' }),
    });
    client = broker.client();
  });

  afterAll(async () => {
    client?.closeAll();
    await broker?.stop();
  });

  test('with no terminal running the session, the saved Drive preference is restored', async () => {
    const session = codex.rollout('no-daemon-socket');
    const restored = await client.attach('codex', session.id, { mode: 'resume', reason: 'app-restore' });
    const frame = await driving(restored);
    expect(restored.ofKind('attach-conflict')).toEqual([]);
    expect(frame.info.control.terminalSync.presence).toBe('absent');
    expect(codex.owners(session.threadId)).toHaveLength(1);
    expect((await prompt(restored, 'restored without a daemon')).kind).toBe('ack');
    restored.close();
    await eventually(() => codex.exited(codex.owners(session.threadId)[0]!), { what: 'the restored owner to stop' });

    // A lease restore of the same session is decided the same way.
    const again = await client.attach('codex', session.id, { mode: 'resume', reason: 'lease-restore' });
    await driving(again);
    expect(codex.owners(session.threadId)).toHaveLength(2);
    again.close();
  });

  test('a terminal running the session still refuses an automatic restore, and Take over still works', async () => {
    const cases = [
      { name: 'remote', remote: true, presence: 'private' },
      { name: 'plain', remote: false, presence: 'unknown' },
    ];
    for (const [index, entry] of cases.entries()) {
      const session = codex.rollout(`no-daemon-socket-${entry.name}`);
      const removeTerminal = codex.competingTerminal(session, 5100 + index, { remote: entry.remote });
      try {
        const refused = await client.attach('codex', session.id, { mode: 'resume', reason: 'app-restore' });
        await refused.waitForKind('history');
        expect(refused.ofKind('attach-conflict')).toHaveLength(1);
        expect(refused.ofKind('attach-conflict')[0]).toMatchObject({ requestedMode: 'resume', reason: 'app-restore', code: 'DRIVE_OWNERSHIP_CONFLICT' });
        expect({ terminal: entry.name, presence: lastSession(refused)!.info.control.terminalSync.presence })
          .toEqual({ terminal: entry.name, presence: entry.presence });
        expect(lastSession(refused)!.info.attachMode).toBe('observe');
        expect(codex.owners(session.threadId)).toEqual([]);
        refused.close();

        const takeover = await client.attach('codex', session.id, { mode: 'resume', reason: 'takeover' });
        await driving(takeover);
        expect(codex.owners(session.threadId)).toHaveLength(1);
        takeover.close();
      } finally {
        removeTerminal();
      }
    }
  });
});
