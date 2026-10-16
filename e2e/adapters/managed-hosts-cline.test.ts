/**
 * Cline's managed Hub as the product runs it: the daemon the broker launches and owns (argv, environment,
 * isolated profile and port, the owner-only discovery file and the health answer that must agree with it), what
 * the broker refuses to use (a loosened or contradicted discovery record), a Hub that is replaced (its sessions
 * lose Drive), runs that fail or are stopped (Stop keeps Drive), attention events (exactly one per outcome), and
 * the native title write rename escalates to.
 *
 * Every Hub here is the compiled fake `cline` (`kits/fakes/cline-program.ts`) on a leased loopback port, handed to
 * the broker through the product's own `COSYNCING_CLINE_HUB_PORT`, with its profile under the fixture root:
 * nothing in this file can reach the owner's Hub on 25463, `~/.cline` or a real `cline`. The Hub is a real process,
 * so the broker's ownership proof (pid, start time, command) runs against real process identity.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Broker, type BrokerClient, eventually, fixturePaths, startBroker } from '../harness/index.ts';
import { ClineAdapter, CLINE_MANAGED_HUB_PORT, CLINE_OWNER_DEFAULT_HUB_PORT } from '../../packages/typescript/adapters/cline/src/index.ts';
import { type ClineFake, clineKit, installCline } from './kits/cline.ts';
import { treeSnapshot } from './kits/kit.ts';

const posix = process.platform === 'win32' ? describe.skip : describe;

const started = (broker: Broker) => (broker.output().match(/started a managed cline host|restarted the managed cline host/g) ?? []).length;

interface Running {
  broker: Broker;
  client: BrokerClient;
  fake: ClineFake;
}

async function boot(name: string, env: Record<string, string> = {}): Promise<Running> {
  let fake!: ClineFake;
  const broker = await startBroker({
    name,
    token: true,
    env: (paths) => ({ ...clineKit.env(paths), ...env }),
    setup: async (paths) => {
      fake = await installCline(paths);
    },
  });
  const client = broker.client();
  await clineKit.ready?.({ broker, client, fake });
  return { broker, client, fake };
}

async function dispose(running: Running | undefined): Promise<void> {
  if (!running) return;
  running.client.closeAll();
  await running.fake.cleanup?.();
  await running.broker.stop();
}

const create = (running: Running, title: string, extra: Record<string, unknown> = {}) =>
  running.client.post('/api/sessions/cline', { directory: running.fake.workspace('hub'), title, ...extra });

posix('the Hub the broker launches and owns', () => {
  let running: Running;
  beforeAll(async () => {
    running = await boot('cline-managed');
  });
  afterAll(async () => dispose(running));

  test('one Hub is launched on the leased port with the daemon switch in its environment and the isolated profile as its data', () => {
    const { fake, broker } = running;
    expect(fake.hubs().length).toBe(1);
    const hub = fake.ledger.since(0).find((entry) => entry.kind === 'hub-started')!;
    expect(hub.argv).toEqual(['--cwd', broker.paths.home]);
    expect(hub.port).toBe(fake.port);
    expect(hub.port).not.toBe(CLINE_OWNER_DEFAULT_HUB_PORT);
    expect(hub.host).toBe('127.0.0.1');
    expect(hub.pathname).toBe('/hub');
    expect(hub.env).toEqual({
      CLINE_NO_AUTO_UPDATE: '1',
      CLINE_RUN_AS_HUB_DAEMON: '1',
      CLINE_HUB_PORT: String(fake.port),
      CLINE_HUB_HOST: '127.0.0.1',
      CLINE_SESSION_DATA_DIR: join(fake.profileDir, 'sessions'),
      CLINE_DATA_DIR: fake.profileDir,
    });
    expect(hub.discoveryPath).toBe(join(fake.profileDir, 'locks', 'hub', 'cosyncing.json'));
    // The owner's own Cline directories are not this Hub's: nothing of it lands there.
    expect([...treeSnapshot(fake.dataDir)]).toEqual([]);
    expect([...treeSnapshot(join(broker.paths.root, 'cline-home'))]).toEqual([]);
  });

  test('the discovery file is an owner-only regular file whose record the health answer repeats exactly', async () => {
    const { fake } = running;
    const path = join(fake.profileDir, 'locks', 'hub', 'cosyncing.json');
    const info = statSync(path);
    expect(info.isFile()).toBe(true);
    expect(info.mode & 0o077).toBe(0);
    expect(info.size).toBeLessThanOrEqual(64 * 1024);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    expect(record).toMatchObject({
      protocolVersion: 'v1',
      host: '127.0.0.1',
      port: fake.port,
      url: `ws://127.0.0.1:${fake.port}/hub`,
      pid: fake.hubs()[0]!.pid,
    });
    expect(record.capabilities).toEqual(expect.arrayContaining(['session.create', 'session.run', 'session.abort', 'run.enqueue', 'run.list', 'stream.replay']));
    expect(typeof record.authToken).toBe('string');
    expect(record.authToken.length).toBeGreaterThanOrEqual(32);
    const health = await (await fetch(`http://127.0.0.1:${fake.port}/health`)).json();
    expect(health).toEqual({ ok: true, draining: false, protocolVersion: 'v1', coreVersion: record.coreVersion, host: record.host, port: record.port, url: record.url });
    // The command socket answers only to the token in that file.
    const anonymous = await fetch(`http://127.0.0.1:${fake.port}/hub`, { headers: { upgrade: 'websocket', connection: 'upgrade' } });
    expect(anonymous.status).toBe(401);
    expect(fake.ledger.since(0).some((entry) => entry.kind === 'rejected' && entry.reason === 'auth')).toBe(true);
  });

  test('a loosened discovery file, a health answer that disagrees with it, or a draining Hub is not used, and each is retryable', async () => {
    const running_ = running;
    const { fake } = running_;
    const path = join(fake.profileDir, 'locks', 'hub', 'cosyncing.json');
    const refused = async (what: string) => {
      const response = await create(running_, what);
      expect(response.status, `${what}: ${response.text}`).toBe(503);
      expect(response.body).toMatchObject({ code: 'SESSION_CREATE_TEMPORARILY_UNAVAILABLE', retryable: true });
    };
    expect((await create(running_, 'baseline')).status).toBe(200);
    chmodSync(path, 0o644);
    await refused('group-readable discovery file');
    chmodSync(path, 0o600);
    expect((await create(running_, 'file restored')).status).toBe(200);
    for (const [what, body] of [
      ['another core version', { ok: true, draining: false, protocolVersion: 'v1', coreVersion: '0.0.99', host: '127.0.0.1', port: fake.port, url: `ws://127.0.0.1:${fake.port}/hub` }],
      ['another port', { ok: true, draining: false, protocolVersion: 'v1', coreVersion: '0.0.82', host: '127.0.0.1', port: fake.port + 1, url: `ws://127.0.0.1:${fake.port + 1}/hub` }],
      ['a draining Hub', { ok: true, draining: true, protocolVersion: 'v1', coreVersion: '0.0.82', host: '127.0.0.1', port: fake.port, url: `ws://127.0.0.1:${fake.port}/hub` }],
      ['another protocol', { ok: true, draining: false, protocolVersion: 'v2', coreVersion: '0.0.82', host: '127.0.0.1', port: fake.port, url: `ws://127.0.0.1:${fake.port}/hub` }],
    ] as const) {
      fake.command({ op: 'health', status: 200, body });
      await eventually(async () => (await create(running_, what)).status === 503, { what: `${what} to be refused` });
    }
    fake.command({ op: 'health', clear: true });
    await eventually(async () => (await create(running_, 'health restored')).status === 200, { what: 'the Hub to be used again' });
  });

  test('a completed turn and a failed one each raise exactly one attention event', async () => {
    const { client } = running;
    const created = await create(running, 'attention');
    expect(created.status).toBe(200);
    const id = created.body.session.id as string;
    const stream = await client.attach('cline', id, { mode: 'resume', reason: 'create' });
    await stream.waitForKind('options');
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'finish quietly' })).kind).toBe('ack');
    expect((await stream.sendAndAwait({ kind: 'prompt', text: '[[error]] fail loudly' })).kind).toBe('ack');
    const feed = async () => ((await client.get(`/api/attention-events?clientId=hub-test&limit=200`)).body.events as any[])
      .filter((event) => event.sessionId === id);
    const events = await eventually(async () => {
      const found = await feed();
      return found.some((event) => event.kind === 'run-failed') ? found : undefined;
    }, { what: 'the failed turn outcome' });
    expect(events.map((event) => event.kind)).toEqual(['run-finished', 'run-failed']);
    // Nothing more arrives for these two turns, however many times the feed is read.
    expect((await feed()).length).toBe(2);
    stream.close();
  });

  test('a rename the native command refuses is kept as a display alias only, and Drive is revoked for that session', async () => {
    const { fake, client } = running;
    const created = await create(running, 'rename refused');
    const id = created.body.session.id as string;
    const stream = await client.attach('cline', id, { mode: 'resume', reason: 'create' });
    await stream.waitForKind('options');
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'name me' })).kind).toBe('ack');
    const previous = fake.configure({ renameBehaviour: 'fail' });
    try {
      const renamed = await client.request('PATCH', `/api/sessions/cline/${id}/rename`, { title: 'Alias only' });
      expect(renamed.status, renamed.text).toBe(200);
      expect(fake.ledger.since(0).filter((entry) => entry.kind === 'history-update' && entry.title === 'Alias only').length).toBe(1);
      // The durable title is untouched: the new name is the broker's own alias.
      expect(JSON.parse(readFileSync(fake.filesOf(id)!.metadata, 'utf8')).metadata.title).toBe('rename refused');
      const row = await client.waitForSession((candidate) => candidate.id === id && candidate.control?.drive?.supported === false);
      expect(row.title).toBe('Alias only');
    } finally {
      fake.configure({ renameBehaviour: previous.renameBehaviour ?? 'persist' });
      stream.close();
    }
  });
});

posix('a replacement Hub revokes Drive', () => {
  let running: Running;
  beforeAll(async () => {
    running = await boot('cline-replaced', { COSYNCING_TEST_MANAGED_HOST_SUPERVISION_MS: '200' });
  });
  afterAll(async () => dispose(running));

  test('a session created under one Hub is observed but not driven under its replacement, and the replacement creates and drives', async () => {
    const { fake, client, broker } = running;
    const created = await create(running, 'Before the replacement');
    expect(created.status).toBe(200);
    const id = created.body.session.id as string;
    const first = await client.attach('cline', id, { mode: 'resume', reason: 'create' });
    await first.waitForKind('options');
    expect((await first.sendAndAwait({ kind: 'prompt', text: 'before the replacement' })).kind).toBe('ack');
    first.close();
    const [original] = fake.hubs();
    const announced = started(broker);
    fake.command({ op: 'exit', code: 1 });
    await eventually(() => !fake.isAlive(original!.pid), { what: 'the first Hub to exit', timeoutMs: 90_000 });
    await eventually(() => started(broker) > announced, { what: 'the broker to replace its Hub', timeoutMs: 90_000 });
    const replacement = fake.hubs().at(-1)!;
    expect(replacement.pid).not.toBe(original!.pid);
    expect(replacement.hubId).not.toBe(original!.hubId);
    // Its history is still readable (the replacement adopted the profile) but nothing may write on the old Hub's say-so.
    const row = await client.waitForSession((candidate) => candidate.id === id && candidate.control?.drive?.supported === false);
    expect(row.attachMode).toBe('observe');
    const refused = await client.attach('cline', id, { mode: 'resume', reason: 'create' });
    await refused.waitForKind('history');
    expect(refused.ofKind('session').at(-1)?.authority?.canMutate).toBe(false);
    expect(fake.ledger.commands('run.start').length).toBe(1);
    refused.close();
    // (A read that races the replacement is answered with a gap and no rows; the retry replays.)
    const replayed = await eventually(async () => {
      const reader = await client.attach('cline', id);
      const frame = await reader.waitForKind('history');
      reader.close();
      return frame.gap ? undefined : frame.messages as any[];
    }, { what: 'the history to be readable under the replacement' });
    expect(replayed.some((message) => message.text === 'before the replacement')).toBe(true);
    // A session created under the replacement drives.
    const fresh = await create(running, 'After the replacement');
    expect(fresh.status, fresh.text).toBe(200);
    const stream = await client.attach('cline', fresh.body.session.id, { mode: 'resume', reason: 'create' });
    await stream.waitForKind('options');
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'after the replacement' })).kind).toBe('ack');
    stream.close();
  });
});

posix('a stopped run settles', () => {
  let running: Running;
  beforeAll(async () => {
    running = await boot('cline-stop');
  });
  afterAll(async () => dispose(running));

  const heldTurn = async (title: string) => {
    const { fake, client } = running;
    const created = await create(running, title);
    const id = created.body.session.id as string;
    const stream = await client.attach('cline', id, { mode: 'resume', reason: 'create' });
    await stream.waitForKind('options');
    const turn = stream.sendAndAwait({ kind: 'prompt', text: `[[hold:${title}]] a long turn` });
    turn.catch(() => undefined);
    await eventually(() => fake.ledger.since(0).some((entry) => entry.kind === 'run-started' && String(entry.text).includes(`[[hold:${title}]]`)), { what: 'the held run' });
    return { id, stream, turn };
  };

  test('Stop against a Hub that never answers the aborted run proves the Hub idle, acks, and keeps Drive', async () => {
    const { fake, client } = running;
    const { id, stream } = await heldTurn('stop-keeps-drive');
    const stopped = await stream.sendAndAwait({ kind: 'command', name: 'stop' });
    expect(stopped.kind, JSON.stringify(stopped)).toBe('ack');
    expect(fake.ledger.since(0).filter((entry) => entry.kind === 'abort' && entry.sessionId === id).length).toBe(1);
    // The Hub never answered the aborted run.start, and nothing waited for it to.
    expect(fake.ledger.since(0).some((entry) => entry.kind === 'run-end' && entry.how === 'aborted' && String(entry.text).includes('[[hold:stop-keeps-drive]]'))).toBe(true);
    const row = await client.waitForSession((candidate) => candidate.id === id && candidate.status === 'idle');
    expect(row.control?.drive?.supported).toBe(true);
    expect(stream.ofKind('session').at(-1)?.authority?.canMutate).toBe(true);
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'after stop' })).kind).toBe('ack');
    await stream.waitForMessage((message) => message.type === 'model-output' && (message.text ?? message.delta) === 'answer: after stop');
    stream.close();
  });

  test('the prompt whose turn was stopped is answered (ack or nack) rather than left pending forever', async () => {
    const { stream, turn } = await heldTurn('stop-answers-the-turn');
    // Settlement is observed, not raced: a race against an already-resolved `false` always loses.
    let settled = false;
    void turn.then(() => { settled = true; }, () => { settled = true; });
    expect((await stream.sendAndAwait({ kind: 'command', name: 'stop' })).kind).toBe('ack');
    const answered = await eventually(() => settled, { what: 'the stopped prompt to be answered', timeoutMs: 8_000 });
    expect(answered).toBe(true);
    // Answered as stopped: the prompt is acked, never refused.
    expect((await turn).kind).toBe('ack');
    stream.close();
  });
});

posix('the owner\'s Hub port is never the managed one', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('a configured port that is the owner\'s default is refused: the Hub is described on the managed port', async () => {
    root = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-cline-port-'));
    const paths = fixturePaths(root);
    const fake = await installCline(paths);
    const describe = async (port: string) => {
      const adapter = new ClineAdapter({
        command: fake.executable,
        homeDir: paths.home,
        env: {
          PATH: paths.bin,
          HOME: paths.home,
          COSYNCING_CLINE_BIN: fake.executable,
          COSYNCING_CLINE_PROFILE_DIR: join(root, 'profile'),
          COSYNCING_CLINE_HUB_PORT: port,
          COSYNCING_CLINE_PROVIDER: 'p',
          COSYNCING_CLINE_MODEL: 'm',
        },
      });
      return adapter.describeManagedHost();
    };
    for (const configured of [String(CLINE_OWNER_DEFAULT_HUB_PORT), `  ${CLINE_OWNER_DEFAULT_HUB_PORT}  `, 'not-a-port', '0', '70000']) {
      const descriptor = await describe(configured);
      expect(descriptor.launch?.env?.CLINE_HUB_PORT, configured).toBe(String(CLINE_MANAGED_HUB_PORT));
      expect(descriptor.locator).toEqual({ kind: 'tcp-port', port: CLINE_MANAGED_HUB_PORT });
    }
    expect((await describe('25465')).launch?.env?.CLINE_HUB_PORT).toBe('25465');
    await fake.cleanup?.();
  });
});
