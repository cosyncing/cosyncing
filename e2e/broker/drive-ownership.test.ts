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
 * agent whose bare attach is already a mutable owner.
 *
 * Not here: a crashed Codex daemon whose socket was left behind (Take over
 * then fails with "ownership could not be verified"). Its expected behaviour
 * is an open owner decision.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Broker, type BrokerClient, eventually, type Frame, type SessionStream, startBroker } from '../harness/index.ts';
import { CodexDriveFake, type CodexRollout, installCodexDriveFake } from '../harness/fakes/codex-drive.ts';
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

  beforeAll(async () => {
    worktree = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-drive-opencode-'));
    serve = startFakeOpenCode(worktree, 'ses_shared_live');
    broker = await startBroker({
      name: 'drive-ownership',
      token: true,
      setup: (paths) => {
        codex = installCodexDriveFake(paths);
        opencode = installFakeCommand(paths.bin, 'opencode', "if (argv[0] === '--version') console.log('1.17.19');");
      },
      env: (paths) => ({
        ...CodexDriveFake.environment(paths),
        OPENCODE_URL: serve.url,
        COSYNCING_TEST_HUB_EVICT_GRACE_MS: '300',
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
