/**
 * Forking a session from the app (`POST /api/sessions/:tool/:id/fork`).
 *
 * A session an agent spawned (`origin: 'subagent'`) has one writer, its
 * parent's run, so forking it could only produce another Observe-only thread.
 * The broker refuses it with a typed 409 rather than a retry-inviting 502,
 * both when the roster knows the source and when only the adapter can tell,
 * and the refusal never reaches Codex. A source outside the Codex store is not
 * a session at all: 404 NOT_FOUND, and Codex is never asked. An ordinary fork
 * goes through Codex's `thread/fork` and returns a new session the app can
 * open and drive; one Codex answers with a session already in its store is
 * refused, and that session is neither named nor written.
 *
 * Codex is a fake (`codex app-server --stdio` answering `thread/fork` by
 * writing the fork's rollout); its ledger shows every request it received.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
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
  let unlistedChild: CodexRollout;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'session-fork',
      token: true,
      setup: (paths) => {
        codex = installCodexDriveFake(paths);
        normal = codex.rollout('parent');
        child = codex.rollout('child', { thread_source: 'subagent', parent_thread_id: normal.threadId });
        // The same kind of child, named by an id no roster row carries: only the adapter can tell.
        unlistedChild = codex.unlistedSpelling('unlisted-child', { thread_source: 'subagent', parent_thread_id: normal.threadId });
        // The same kind of child, stored outside the Codex store: not a session the adapter publishes.
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
    expect(roster.some((row) => row.id === unlistedChild.id)).toBe(false);
    const refused = await client.post(`/api/sessions/codex/${unlistedChild.id}/fork`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SESSION_AGENT_OWNED');
    expect(codex.requests('thread/fork')).toEqual([]);
  });

  test('a source outside the Codex store is not found, and Codex is never asked', async () => {
    const roster = await client.sessions({ refresh: true });
    expect(roster.some((row) => row.id === hiddenChild.id)).toBe(false);
    const refused = await client.post(`/api/sessions/codex/${hiddenChild.id}/fork`, {});
    expect({ status: refused.status, code: refused.body.code }).toEqual({ status: 404, code: 'NOT_FOUND' });
    const renamed = await client.post(`/api/sessions/codex/${hiddenChild.id}/rename`, { title: 'outside' });
    expect({ status: renamed.status, code: renamed.body.code }).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(codex.requests('thread/fork')).toEqual([]);
    expect(codex.requests('thread/name/set')).toEqual([]);
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

  test('a fork Codex answers with a session already in its store is refused, and that session is left alone', async () => {
    // One session stored before the fork is asked for (born more than the guard's clock slack earlier);
    // every other one is stored just now, so only what it says, not its age, gives it away.
    const settled = codex.rollout('settled');
    const born = statSync(settled.path);
    await Bun.sleep(Math.max(0, (born.birthtimeMs || born.mtimeMs) + 1_100 - Date.now()));
    const freshSource = codex.rollout('fresh-source');
    const forkOfAnother = codex.rollout('fork-of-another', { forked_from_id: settled.threadId });
    const namesAnother = codex.rollout('names-another');
    const answeredFromAnother = codex.rollout('answered-from-another');
    const cases = [
      { why: 'the source itself', source: freshSource, answer: { threadId: freshSource.threadId, path: freshSource.path } },
      { why: 'stored before the request', source: normal, answer: { threadId: settled.threadId, path: settled.path } },
      { why: 'its rollout forked from another session', source: normal, answer: { threadId: forkOfAnother.threadId, path: forkOfAnother.path } },
      { why: 'its rollout names another thread', source: normal, answer: { threadId: '00000000-0000-4000-8000-00000000f0f0', path: namesAnother.path } },
      {
        why: 'the answer says it forked from another session',
        source: normal,
        answer: { threadId: answeredFromAnother.threadId, path: answeredFromAnother.path, forkedFromId: settled.threadId },
      },
    ];
    try {
      for (const { why, source, answer } of cases) {
        codex.answerForkWith(answer);
        const before = readFileSync(answer.path);
        const named = codex.requests('thread/name/set').length;
        const refused = await client.post(`/api/sessions/codex/${source.id}/fork`, {});
        expect({ why, status: refused.status, ok: refused.body.ok }).toEqual({ why, status: 502, ok: undefined });
        // Never named (an index row would retitle the stored session) and never written.
        expect({ why, named: codex.requests('thread/name/set').length }).toEqual({ why, named });
        expect({ why, unchanged: readFileSync(answer.path).equals(before) }).toEqual({ why, unchanged: true });
      }
    } finally {
      codex.answerForkWith(null);
    }
    const forked = await client.post(`/api/sessions/codex/${normal.id}/fork`, {});
    expect(forked.status).toBe(200);
    expect(cases.map((entry) => entry.answer.path)).not.toContain(decode(forked.body.session.id));
  });
});
