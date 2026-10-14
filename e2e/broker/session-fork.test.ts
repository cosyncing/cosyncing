/**
 * Forking a session from the app (`POST /api/sessions/:tool/:id/fork`).
 *
 * A session an agent spawned (`origin: 'subagent'`) has one writer, its
 * parent's run, so forking it could only produce another Observe-only thread.
 * The broker refuses it with a typed 409 rather than a retry-inviting 502,
 * both when the roster knows the source and when only the adapter can tell,
 * and the refusal never reaches Codex. An ordinary fork goes through Codex's
 * `thread/fork` and returns a new session the app can open and drive.
 *
 * Codex is a fake (`codex app-server --stdio` answering `thread/fork` by
 * writing the fork's rollout); its ledger shows every request it received.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { type Broker, type BrokerClient, startBroker } from '../harness/index.ts';
import { CodexDriveFake, type CodexRollout, installCodexDriveFake } from '../harness/fakes/codex-drive.ts';

const decode = (id: string): string => Buffer.from(id, 'base64url').toString('utf8');

describe('forking a session', () => {
  let broker: Broker;
  let codex: CodexDriveFake;
  let client: BrokerClient;
  let normal: CodexRollout;
  let child: CodexRollout;
  let hiddenChild: CodexRollout;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'session-fork',
      token: true,
      setup: (paths) => {
        codex = installCodexDriveFake(paths);
        normal = codex.rollout('parent');
        child = codex.rollout('child', { thread_source: 'subagent', parent_thread_id: normal.threadId });
        // The same kind of child, stored where discovery does not look: only the adapter can tell.
        hiddenChild = codex.hiddenRollout('hidden-child', { thread_source: 'subagent', parent_thread_id: normal.threadId });
      },
      env: (paths) => CodexDriveFake.environment(paths),
    });
    client = broker.client();
  });

  afterAll(async () => {
    client?.closeAll();
    await broker?.stop();
  });

  test('an agent-owned session is refused with a typed 409, and Codex is never asked', async () => {
    const listed = await client.waitForSession((row) => row.id === child.id);
    expect(listed.origin).toBe('subagent');
    const refused = await client.post(`/api/sessions/codex/${child.id}/fork`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SESSION_AGENT_OWNED');
    expect(refused.body.error).not.toBe('native session fork failed');
    expect(codex.requests('thread/fork')).toEqual([]);
  });

  test('the same refusal holds when only the adapter can see the source is agent-owned', async () => {
    const roster = await client.sessions({ refresh: true });
    expect(roster.some((row) => row.id === hiddenChild.id)).toBe(false);
    const refused = await client.post(`/api/sessions/codex/${hiddenChild.id}/fork`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SESSION_AGENT_OWNED');
    expect(codex.requests('thread/fork')).toEqual([]);
  });

  test('an ordinary session forks into a new session the app can open and drive', async () => {
    const forked = await client.post(`/api/sessions/codex/${normal.id}/fork`, {});
    expect(forked.status).toBe(200);
    expect(forked.body.ok).toBe(true);
    expect(codex.requests('thread/fork').map((entry) => entry.params.threadId)).toEqual([normal.threadId]);
    const session = forked.body.session;
    expect(session.id).not.toBe(normal.id);
    expect(existsSync(decode(session.id))).toBe(true);
    expect(session.lineageId).toBe(normal.threadId);
    expect(session.origin).not.toBe('subagent');
    expect(session.control.drive.supported).toBe(true);

    const opened = await client.attach('codex', session.id, { mode: 'resume', reason: 'create' });
    await opened.waitForFrame((frame) => frame.kind === 'session' && frame.authority?.canMutate === true);
    expect((await opened.sendAndAwait({ kind: 'prompt', text: 'in the fork' })).kind).toBe('ack');
    expect(codex.prompts().at(-1)?.text).toBe('in the fork');
    opened.close();
  });

  test('automated and IDE launches have no owning parent, so they fork like any other session', async () => {
    const launched = [
      codex.rollout('exec-launch', { originator: 'codex_exec' }),
      codex.rollout('ide-launch', { originator: 'codex_vscode' }),
    ];
    for (const source of launched) {
      const row = await client.waitForSession((candidate) => candidate.id === source.id);
      expect(['exec', 'vscode']).toContain(row.origin);
      const forked = await client.post(`/api/sessions/codex/${source.id}/fork`, {});
      expect({ origin: row.origin, status: forked.status }).toEqual({ origin: row.origin, status: 200 });
      expect(forked.body.session.lineageId).toBe(source.threadId);
    }
    expect(codex.requests('thread/fork').map((entry) => entry.params.threadId))
      .toEqual([normal.threadId, ...launched.map((source) => source.threadId)]);
  });
});
