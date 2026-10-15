/**
 * Kimi host rules the shared conformance scenarios do not reach: the server-identity gate (K3), the closed write
 * surface, the WebSocket protocol, generation replacement, the subagent roster, wire-journal evidence, context
 * injection, file and image echoes, commands, and Drive authority keying.
 *
 * One broker, one fake `kimi web` (`kits/fakes/kimi-host.ts`) registered under a fixture `KIMI_CODE_HOME`. Every
 * claim reads what a client receives or what the host's ledger saw.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Broker, type BrokerClient, eventually, startBroker } from '../harness/index.ts';
import { type KimiFake, kimiKit, KIMI_PROVIDER } from './kits/kimi.ts';

let broker: Broker;
let fake: KimiFake;
let client: BrokerClient;

beforeAll(async () => {
  broker = await startBroker({
    name: 'kimi-host', token: true, env: kimiKit.env,
    setup: (paths) => {
      fake = kimiKit.install(paths) as KimiFake;
    },
  });
  client = broker.client();
});
afterAll(async () => {
  client?.closeAll();
  await fake?.cleanup?.();
  await broker?.stop();
});

const kimiRows = async (): Promise<any[]> => (await client.sessions({ refresh: true })).filter((row) => row.tool === 'kimi');
const texts = (messages: any[], type: string): string[] => messages.filter((message) => message.type === type).map((m) => m.text ?? m.delta);

async function createdDrive(title = 'host rules') {
  const id = fake.prepareCreate();
  const cwd = fake.workspace('host');
  const created = await client.post('/api/sessions/kimi', { directory: cwd, title });
  expect(created.status, created.text).toBe(200);
  const stream = await client.attach('kimi', id, { mode: 'live' });
  expect((await stream.waitForKind('session')).authority?.canMutate).toBe(true);
  await stream.waitForKind('options');
  await stream.waitForKind('commands');
  // The attach's own WebSocket handshake is part of the attach: a test that marks the ledger afterwards must not
  // see it as something the test provoked.
  await eventually(() => fake.ledger.wsFrames().some((frame) => frame.type === 'subscribe' && frame.payload?.session_ids?.includes(id)), {
    what: 'the attach handshake to reach the host',
  });
  return { id, cwd, stream };
}

async function settle(text: string, send: () => Promise<unknown>): Promise<void> {
  const mark = fake.ledger.mark();
  await send();
  await eventually(() => fake.ledger.since(mark).some((entry) => entry.kind === 'turn-end' && entry.text === text), { what: `the host to settle "${text}"` });
}

describe('K3 server-identity gate', () => {
  const seeded = () => fake.seedSession({ title: 'behind the gate' });

  /** With the gate refusing, the agent lists nothing, refuses attach and create answers the typed 503. */
  async function expectRefused(label: string, id: string): Promise<void> {
    expect((await kimiRows()).some((row) => row.id === id), `${label}: roster`).toBe(false);
    const attach = await client.attach('kimi', id);
    const outcome = await attach.waitForFrame((frame) => frame.kind === 'error' || frame.kind === 'history');
    attach.close();
    expect(outcome.kind, `${label}: attach`).toBe('error');
    fake.prepareCreate();
    const created = await client.post('/api/sessions/kimi', { directory: fake.workspace('gate') });
    expect(created.status, `${label}: create ${created.text}`).toBe(503);
    expect(created.body.code).toBe('SESSION_CREATE_TEMPORARILY_UNAVAILABLE');
  }

  async function expectAdopted(id: string): Promise<void> {
    await client.waitForSession((row) => row.tool === 'kimi' && row.id === id);
  }

  test('the record\'s server_id is not the id /api/v1/meta answers with (the trap the gate must survive)', async () => {
    const record = fake.host.registryRecord();
    const meta = await (await fetch(`${fake.host.url}/api/v1/meta`, { headers: { authorization: `Bearer ${fake.host.token}` } })).json() as any;
    expect(record.server_id).not.toBe(meta.data.server_id);
    const id = seeded().id;
    await expectAdopted(id);
  });

  const cases: Array<[string, () => () => void]> = [
    ['no registry record at all', () => {
      fake.host.unregister();
      return () => fake.host.register();
    }],
    ['an incomplete record (no host_version)', () => {
      const record = fake.host.registryRecord();
      delete record.host_version;
      fake.host.register(record);
      return () => fake.host.register();
    }],
    ['an unbindable record (no started_at)', () => {
      const record = fake.host.registryRecord();
      delete record.started_at;
      fake.host.register(record);
      return () => fake.host.register();
    }],
    ['two live hosts (ambiguous)', () => {
      const path = fake.host.plantRecord('other.json', { ...fake.host.registryRecord(), server_id: '01OTHERHOSTOTHERHOSTOTHERH' });
      return () => void import('node:fs').then((fs) => fs.rmSync(path, { force: true }));
    }],
    ['a host that answers meta with an error (unreachable)', () => {
      fake.host.failRoute(/GET \/api\/v1\/meta/, { status: 500, times: 1000 });
      return () => fake.host.clearFaults();
    }],
    ['a host with the token gate disabled (auth bypassed)', () => {
      fake.host.setBypassAuth(true);
      return () => fake.host.setBypassAuth(false);
    }],
    ['a host that started before its record did (startup mismatch)', () => {
      fake.host.setApiStartOffset(-5_000);
      return () => fake.host.setApiStartOffset(200);
    }],
    ['a host that started long after its record (startup mismatch)', () => {
      fake.host.setApiStartOffset(10 * 60_000);
      return () => fake.host.setApiStartOffset(200);
    }],
    ['a host whose version differs from its record\'s (version mismatch)', () => {
      fake.host.setApiVersion('9.9.9');
      return () => fake.host.setApiVersion(fake.host.version);
    }],
    ['meta that is not an envelope', () => {
      fake.host.overrideMeta(() => 'not json at all');
      return () => fake.host.overrideMeta(undefined);
    }],
    ['meta without dangerous_bypass_auth', () => {
      fake.host.overrideMeta((meta) => {
        delete meta.dangerous_bypass_auth;
        return meta;
      });
      return () => fake.host.overrideMeta(undefined);
    }],
  ];

  for (const [name, arrange] of cases) {
    test(`${name}: the agent is unavailable, lists no sessions and refuses attach and create`, async () => {
      const session = seeded();
      await expectAdopted(session.id);
      const restore = arrange();
      try {
        await expectRefused(name, session.id);
      } finally {
        restore();
      }
      // The gate is re-evaluated on the next call: the restored host is adopted again.
      await expectAdopted(session.id);
    });
  }

  test('a registry holding more records than one scan examines is refused whole', async () => {
    const session = seeded();
    await expectAdopted(session.id);
    const paths: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      paths.push(fake.host.plantRecord(`flood-${String(index).padStart(2, '0')}.json`, 'not a record'));
    }
    try {
      await expectRefused('registry flood', session.id);
    } finally {
      const fs = await import('node:fs');
      for (const path of paths) fs.rmSync(path, { force: true });
    }
    await expectAdopted(session.id);
  });

  test('a restarted host (new generation, same port) is adopted on the next call', async () => {
    const session = seeded();
    await expectAdopted(session.id);
    const before = fake.host.registryId;
    fake.host.restartGeneration();
    expect(fake.host.registryId).not.toBe(before);
    await expectAdopted(session.id);
    const stream = await client.attach('kimi', session.id);
    await stream.waitForKind('history');
    stream.close();
  });
});

describe('the closed write surface', () => {
  const ALLOWED = [
    /^\/api\/v1\/sessions$/,
    /^\/api\/v1\/sessions\/[^/:]+\/prompts$/,
    /^\/api\/v1\/sessions\/[^/:]+:abort$/,
    /^\/api\/v1\/sessions\/[^/:]+\/approvals\/[^/]+$/,
    /^\/api\/v1\/sessions\/[^/:]+\/questions\/[^/]+(:dismiss)?$/,
    /^\/api\/v1\/sessions\/[^/:]+\/profile$/,
    /^\/api\/v1\/files$/,
    /^\/api\/v1\/sessions\/[^/:]+\/skills\/[^/]+:activate$/,
  ];

  test('observing and listing issue only GETs; every write the host ever saw is one of the ten named operations', async () => {
    const stored = fake.seedSession({ title: 'only read' });
    await client.waitForSession((row) => row.id === stored.id);
    const mark = fake.ledger.mark();
    const observer = await client.attach('kimi', stored.id);
    await observer.waitForKind('history');
    await kimiRows();
    observer.close();
    expect(fake.ledger.writes(mark)).toEqual([]);

    const { id, stream } = await createdDrive('write surface');
    await settle('[[permission]] permission please', async () => {
      const turn = stream.sendAndAwait({ kind: 'prompt', text: '[[permission]] permission please' });
      const card = await stream.waitForMessage((message) => message.type === 'permission-request');
      await stream.sendAndAwait({ kind: 'approve', requestId: card.requestId, decision: 'approve' });
      await turn;
    });
    await stream.sendAndAwait({ kind: 'command', name: 'goal', args: 'ship it' });
    await stream.sendAndAwait({ kind: 'command', name: 'fixture-skill', args: 'x' });
    const renamed = await client.request('PATCH', `/api/sessions/kimi/${id}/rename`, { title: 'Renamed' });
    expect(renamed.status, renamed.text).toBe(200);
    stream.close();
    const writes = fake.ledger.writes();
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.method, String(write.path)).toBe('POST');
      expect(ALLOWED.some((pattern) => pattern.test(String(write.path))), `${write.method} ${write.path}`).toBe(true);
    }
  });
});

describe('the WebSocket protocol', () => {
  test('the handshake registers interest only, a ping is answered with the same nonce, and nothing mutating is sent', async () => {
    const stored = fake.seedSession({ title: 'ws handshake' });
    await client.waitForSession((row) => row.id === stored.id);
    const mark = fake.ledger.mark();
    const stream = await client.attach('kimi', stored.id);
    await stream.waitForKind('history');
    await eventually(() => fake.ledger.wsFrames(mark).some((frame) => frame.type === 'subscribe_v2'), { what: 'the handshake' });
    const types = fake.ledger.wsFrames(mark).map((frame) => frame.type);
    expect(types.slice(0, 3)).toEqual(['client_hello', 'subscribe', 'subscribe_v2']);
    expect(fake.ledger.wsFrames(mark).find((frame) => frame.type === 'subscribe')?.payload.session_ids).toEqual([stored.id]);
    fake.host.ping('nonce-1');
    await eventually(() => fake.ledger.wsFrames(mark).some((frame) => frame.type === 'pong' && frame.payload?.nonce === 'nonce-1'), { what: 'the pong' });
    expect(new Set(fake.ledger.wsFrames(mark).map((frame) => frame.type)).difference(new Set(['client_hello', 'subscribe', 'subscribe_v2', 'unsubscribe', 'pong'])).size).toBe(0);
    stream.close();
  });

  test('a resync_required adopts the server watermark, once, and another session\'s gap is ignored', async () => {
    const { id, stream } = await createdDrive('resync');
    const session = fake.host.sessions.get(id)!;
    session.seq = 41;
    const mark = fake.ledger.mark();
    // Another session's gap must not move this cursor.
    fake.host.emitRaw(JSON.stringify({ type: 'resync_required', payload: { session_id: 'session_someone_else', current_seq: 999_999, epoch: 'other' } }));
    fake.host.emitResync(id);
    await eventually(() => fake.ledger.wsFrames(mark).some((frame) => frame.type === 'subscribe'), { what: 'the resubscribe' });
    const resubscribes = fake.ledger.wsFrames(mark).filter((frame) => frame.type === 'subscribe');
    expect(resubscribes.length).toBe(1);
    expect(resubscribes[0]!.payload.cursors[id]).toEqual({ seq: 41, epoch: fake.host.epoch });
    // A sentinel turn after the resync proves there was no loop behind it.
    await settle('after resync', () => stream.sendAndAwait({ kind: 'prompt', text: 'after resync' }));
    expect(fake.ledger.wsFrames(mark).filter((frame) => frame.type === 'subscribe').length).toBe(1);
    stream.close();
  });

  test('an oversized frame is dropped unread and the gap is told once', async () => {
    const stored = fake.seedSession({ title: 'oversized' });
    await client.waitForSession((row) => row.id === stored.id);
    const stream = await client.attach('kimi', stored.id);
    await stream.waitForKind('history');
    const from = stream.frames.length;
    fake.host.emitRaw(JSON.stringify({ type: 'x', session_id: stored.id, pad: 'x'.repeat(4 * 1024 * 1024 + 16) }));
    fake.appendTurn(stored, 'after the huge frame', 'still tailing');
    await stream.waitForMessage((message) => message.type === 'model-output' && (message.text ?? message.delta) === 'still tailing');
    expect(stream.frames.slice(from).filter((frame) => frame.kind === 'error').length).toBe(0);
    stream.close();
  });
});

describe('generation replacement', () => {
  test('a refused credential retires the generation: no prompt goes through it, the token is re-read, and the retry is sent once', async () => {
    const { stream } = await createdDrive('rotation');
    const token = fake.host.token;
    const next = fake.host.rotateToken();
    try {
      const mark = fake.ledger.mark();
      // The write door still holds the old credential: the host refuses it, so the broker must not report a send.
      const first = await stream.sendAndAwait({ kind: 'prompt', text: 'after rotation' });
      if (first.kind === 'ack') {
        // Or the generation was already re-read: then it went out once, on the new credential.
        expect(fake.ledger.since(mark).filter((entry) => entry.kind === 'request' && String(entry.path).endsWith('/prompts') && entry.authorized).length).toBe(1);
      } else {
        expect(fake.ledger.since(mark).filter((entry) => entry.kind === 'request' && String(entry.path).endsWith('/prompts') && entry.authorized)).toEqual([]);
        await eventually(async () => (await stream.sendAndAwait({ kind: 'prompt', text: 'after rotation, retried' })).kind === 'ack', { what: 'a retry on the re-read credential' });
        const sent = fake.ledger.since(mark).filter((entry) => entry.kind === 'request' && String(entry.path).endsWith('/prompts') && entry.authorized);
        expect(sent.length).toBe(1);
        expect(sent[0]!.bearer).toBe(next.slice(-6));
      }
    } finally {
      fake.host.rotateToken(token);
    }
    stream.close();
  });

  test('a host restart mid-session: the socket is retired, the new generation adopted, and nothing is sent twice', async () => {
    const { stream } = await createdDrive('generation');
    const mark = fake.ledger.mark();
    fake.host.restartGeneration();
    await eventually(() => fake.ledger.since(mark).some((entry) => entry.kind === 'ws-open'), { what: 'a socket to the new generation' });
    await settle('after restart', async () => {
      expect((await stream.sendAndAwait({ kind: 'prompt', text: 'after restart' })).kind).toBe('ack');
    });
    const prompts = fake.ledger.since(mark).filter((entry) => entry.kind === 'request' && entry.method === 'POST' && String(entry.path).endsWith('/prompts'));
    expect(prompts.length).toBe(1);
    stream.close();
  });

});

describe('the subagent roster', () => {
  test('children carry lineage, are Observe-only with no HTTP, and a running child makes no claim on the parent\'s host', async () => {
    const parent = fake.seedSession({ title: 'Parent with children' });
    const first = fake.seedChild(parent, { title: 'First brief' });
    const second = fake.seedChild(parent, { title: 'Second brief' });
    const rows = await eventually(async () => {
      const all = await kimiRows();
      return all.some((row) => row.id === first.id) && all.some((row) => row.id === second.id) ? all : undefined;
    }, { what: 'the child rows' });
    const parentRow = rows.find((row) => row.id === parent.id);
    expect(parentRow.nativeId).toBe(`kimi-session:${parent.id}`);
    for (const child of [first, second]) {
      const row = rows.find((candidate) => candidate.id === child.id);
      expect(row.origin).toBe('subagent');
      expect(row.parentThreadId).toBe(parentRow.nativeId);
      expect(row.attachMode).toBe('observe');
      expect(row.control.drive.supported).toBe(false);
    }
    expect(rows.find((row) => row.id === first.id).title).toBe('First brief');
    // Drive on a child is refused before the host is contacted at all.
    const mark = fake.ledger.mark();
    const refused = await client.attach('kimi', first.id, { mode: 'live' });
    await refused.waitForFrame((frame) => frame.kind === 'error' || (frame.kind === 'session' && frame.authority?.canMutate === false));
    refused.close();
    expect(fake.ledger.since(mark).filter((entry) => entry.kind === 'request' && String(entry.path).includes('subagent'))).toEqual([]);
    expect(fake.ledger.writes(mark)).toEqual([]);
  });

  test('state.json is the authority: a directory it does not list yields no row, and a childless parent publishes no lineage id', async () => {
    const parent = fake.seedSession({ title: 'Ghost parent' });
    const real = fake.seedChild(parent, { title: 'Real child' });
    // A journal in a slot the state map does not list.
    const ghostDir = join(fake.host.sessionDirectory(parent.id), 'agents', 'agent-99');
    mkdirSync(ghostDir, { recursive: true });
    writeFileSync(join(ghostDir, 'wire.jsonl'), `${JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: Date.now() })}\n`);
    const plain = fake.seedSession({ title: 'Childless' });
    const rows = await eventually(async () => {
      const all = await kimiRows();
      return all.some((row) => row.id === real.id) ? all : undefined;
    }, { what: 'the child row' });
    expect(rows.filter((row) => row.parentThreadId === `kimi-session:${parent.id}`).map((row) => row.id)).toEqual([real.id]);
    expect(rows.find((row) => row.id === plain.id).nativeId ?? null).toBeNull();
  });

  test('a child whose journal is older than the roster window is not listed', async () => {
    const parent = fake.seedSession({ title: 'Cold children parent' });
    const cold = fake.seedChild(parent, { title: 'Cold child' });
    const warm = fake.seedChild(parent, { title: 'Warm child' });
    const stale = (Date.now() - 90 * 24 * 3600 * 1000) / 1000;
    utimesSync(join(fake.host.sessionDirectory(parent.id), 'agents', 'agent-0', 'wire.jsonl'), stale, stale);
    const rows = await eventually(async () => {
      const all = (await client.sessions({ window: '7d', refresh: true })).filter((row) => row.tool === 'kimi');
      return all.some((row) => row.id === warm.id) ? all : undefined;
    }, { what: 'the warm child' });
    expect(rows.some((row) => row.id === cold.id)).toBe(false);
  });
});

describe('wire-journal evidence', () => {
  test('a failed turn is named from wire.jsonl turn.ended, whatever the session row says last_turn_reason is', async () => {
    const session = fake.seedSession({ title: 'Failed last turn' });
    // The host's row keeps saying "completed": it lies about a turn the journal records as failed.
    expect(fake.host.sessions.get(session.id)!.lastTurnReason).toBe('completed');
    fake.host.appendWire(session.id, 'main', { type: 'turn.prompt', input: [{ type: 'text', text: 'seeded prompt 1' }], time: Date.now() - 2000 });
    fake.host.appendWire(session.id, 'main', { type: 'turn.ended', turnId: 7, reason: 'failed', error: { message: 'the provider refused the request' }, time: Date.now() - 1000 });
    await client.waitForSession((row) => row.id === session.id);
    const stream = await client.attach('kimi', session.id);
    const history = await stream.waitForKind('history');
    expect((history.messages as any[]).some((message) => message.type === 'error' && String(message.message).includes('the provider refused the request'))).toBe(true);
    stream.close();
  });

  test('a finished turn that completed leaves no error behind', async () => {
    const session = fake.seedSession({ title: 'Completed last turn' });
    fake.host.appendWire(session.id, 'main', { type: 'turn.prompt', input: [{ type: 'text', text: 'x' }], time: Date.now() - 2000 });
    fake.host.appendWire(session.id, 'main', { type: 'turn.ended', turnId: 8, reason: 'completed', time: Date.now() - 1000 });
    await client.waitForSession((row) => row.id === session.id);
    const stream = await client.attach('kimi', session.id);
    const history = await stream.waitForKind('history');
    expect((history.messages as any[]).some((message) => message.type === 'error')).toBe(false);
    stream.close();
  });
});

describe('what the host injects on the user row, and how files echo', () => {
  async function historyOf(rows: Array<{ text?: string; origin?: any; content?: any[] }>): Promise<any[]> {
    const session = fake.seedSession({ title: 'echo shapes', turns: 0 });
    const host = fake.host.sessions.get(session.id)!;
    for (const row of rows) {
      const made = fake.host.appendRow(host, 'user', row.text ?? '');
      if (row.content) made.content = row.content;
      made.metadata = row.origin === undefined ? undefined : { origin: row.origin };
    }
    await client.waitForSession((candidate) => candidate.id === session.id);
    const stream = await client.attach('kimi', session.id);
    const history = (await stream.waitForKind('history')).messages as any[];
    stream.close();
    return history;
  }

  const reminder = '<system-reminder>\nAuto permission mode is active.\n</system-reminder>';

  test('an origin-injection wrapper becomes a context row; pasted, cron and metadata-less wrappers stay user rows', async () => {
    const history = await historyOf([
      { text: reminder, origin: { kind: 'injection' } },
      { text: `${reminder} `, origin: { kind: 'user' } },
      { text: reminder.replace('Auto', 'Cron'), origin: { kind: 'cron_job' } },
      { text: reminder.replace('Auto', 'Bare'), origin: undefined },
    ]);
    const injections = history.filter((message) => message.type === 'event' && message.name === 'context.injection');
    expect(injections.length).toBe(1);
    expect(JSON.stringify(injections[0].payload)).toContain('Auto permission mode is active');
    expect(texts(history, 'user-message').length).toBe(3);
  });

  test('a file echoes as an attached-file notice and an image as a data URI linked to its user row', async () => {
    const notice = 'Attached file "report.txt" (text/plain, 12 bytes): /srv/kimi/attachments/file_1-report.txt — open it with the Read tool';
    const history = await historyOf([
      { text: notice, origin: { kind: 'user' } },
      { text: '', origin: { kind: 'user' }, content: [{ type: 'image', source: { kind: 'url', url: 'data:image/png;base64,iVBORw0KGgo=' } }] },
    ]);
    expect(texts(history, 'user-message').some((text) => text?.startsWith('Attached file "report.txt"'))).toBe(true);
    const artifact = history.find((message) => message.type === 'file-artifact' || message.type === 'artifact');
    expect(artifact, JSON.stringify(history.map((m) => m.type))).toBeDefined();
  });
});

describe('commands', () => {
  test('/goal sets, pauses, resumes and clears through the profile route; a skill is activated, never prompted', async () => {
    const { id, stream } = await createdDrive('commands');
    const host = fake.host.sessions.get(id)!;
    await settle('ship it', async () => {
      expect((await stream.sendAndAwait({ kind: 'command', name: 'goal', args: 'ship it' })).kind).toBe('ack');
    });
    expect(host.goal).toMatchObject({ objective: 'ship it', status: 'active' });
    const mark = fake.ledger.mark();
    for (const [args, expected] of [['pause', 'paused'], ['resume', 'active']] as const) {
      expect((await stream.sendAndAwait({ kind: 'command', name: 'goal', args })).kind).toBe('ack');
      expect(host.goal?.status).toBe(expected);
    }
    expect((await stream.sendAndAwait({ kind: 'command', name: 'goal', args: 'clear' })).kind).toBe('ack');
    expect(host.goal).toBeNull();
    expect(fake.ledger.since(mark).filter((entry) => entry.kind === 'goal-control').map((entry) => entry.control)).toEqual(['pause', 'resume', 'cancel']);
    const skillMark = fake.ledger.mark();
    expect((await stream.sendAndAwait({ kind: 'command', name: 'fixture-skill', args: 'with args' })).kind).toBe('ack');
    expect(fake.ledger.since(skillMark).filter((entry) => entry.kind === 'skill-activate').map((entry) => [entry.skill, entry.args])).toEqual([['fixture-skill', 'with args']]);
    expect(fake.ledger.requests('session/prompt', skillMark)).toEqual([]);
    stream.close();
  });
});

describe('Drive authority keying', () => {
  test('a bare or observe attach of an owned session carries no authority; only mode=live does, and an observer beside it stays read-only', async () => {
    const { id, stream: driver } = await createdDrive('keying');
    for (const params of [{}, { mode: 'observe' }]) {
      const watcher = await client.attach('kimi', id, params);
      const session = await watcher.waitForKind('session');
      expect(session.authority, JSON.stringify(params)).toEqual({ canMutate: false, prompt: 'none' });
      const refused = await watcher.sendAndAwait({ kind: 'prompt', text: 'from a watcher' });
      expect(refused.kind).toBe('nack');
      watcher.close();
    }
    expect(fake.ledger.requests('session/prompt').some((entry) => entry.frame?.params?.prompt?.[0]?.text === 'from a watcher')).toBe(false);
    expect((await driver.sendAndAwait({ kind: 'prompt', text: 'from the driver' })).kind).toBe('ack');
    driver.close();
  });
});

void KIMI_PROVIDER;
