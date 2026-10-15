/**
 * Kilo Code's managed serve as the product runs it: the `kilo serve` the broker launches and owns (argv,
 * credential, teardown), what it does with a listener it did not start, how a create that fails is reported
 * (retryable vs incompatible vs ambiguous), how a crashed serve is replaced and re-attached, and which SQLite
 * files the store honours (WAL rows, kilo-named databases before the legacy one, journal and symlink refusals).
 *
 * Every serve here is the compiled fake `kilo` (`kits/fakes/kilo-program.ts`) on a leased loopback port, handed
 * to the broker through the source-only `COSYNCING_TEST_KILO_SERVE_PORT`: nothing in this file can reach a real
 * Kilo on 4097, `~/.kilocode` or `~/.local/share/kilo*`. The managed serve is a real process, so the broker's
 * ownership proof (pid, start time, command) runs against real process identity.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Broker, type BrokerClient, eventually, never, startBroker } from '../harness/index.ts';
import { KILO_PROVIDER, type KiloFake, installKilo, kilocodeKit } from './kits/kilocode.ts';
import { KiloDb } from './kits/fakes/kilo-store.ts';

const posix = process.platform === 'win32' ? describe.skip : describe;

const MODEL = { providerID: KILO_PROVIDER, modelID: 'model-a' };
const started = (broker: Broker) => (broker.output().match(/started a managed kilo host|restarted the managed kilo host/g) ?? []).length;

async function createSession(client: BrokerClient, fake: KiloFake, title: string, extra: Record<string, unknown> = {}) {
  return client.post('/api/sessions/kilo', { directory: fake.workspace('create'), title, ...extra });
}

interface Running {
  broker: Broker;
  client: BrokerClient;
  fake: KiloFake;
}

async function boot(name: string, env: Record<string, string> = {}, options: { ready?: boolean; before?: (fake: KiloFake) => void | Promise<void> } = {}): Promise<Running> {
  let fake!: KiloFake;
  const broker = await startBroker({
    name,
    token: true,
    env: (paths) => ({ ...kilocodeKit.env(paths), ...env }),
    setup: async (paths) => {
      fake = await installKilo(paths);
      await options.before?.(fake);
    },
  });
  const client = broker.client();
  if (options.ready !== false) await kilocodeKit.ready?.({ broker, client, fake });
  return { broker, client, fake };
}

async function dispose(running: Running | undefined): Promise<void> {
  if (!running) return;
  running.client.closeAll();
  await running.fake.cleanup?.();
  await running.broker.stop();
}

posix('the serve the broker launches and owns', () => {
  let running: Running;
  beforeAll(async () => {
    running = await boot('kilo-managed');
  });
  afterAll(async () => dispose(running));

  test('the broker launches one serve on the leased port with its own argv and a minted credential', async () => {
    const { fake, client } = running;
    expect(fake.serves().length).toBe(1);
    const cli = fake.ledger.since(0).find((entry) => entry.kind === 'cli' && entry.argv?.[0] === 'serve')!;
    expect(cli.argv).toEqual(['serve', '--hostname', '127.0.0.1', '--port', String(fake.port)]);
    const serve = fake.ledger.since(0).find((entry) => entry.kind === 'serve-started')!;
    expect(serve.port).toBe(fake.port);
    expect(serve.credential).toMatchObject({ username: expect.any(String) });
    // Not a guessable password, and never the default the real binary falls back to.
    expect((serve.credential as { passwordLength: number }).passwordLength).toBeGreaterThanOrEqual(16);
    expect(serve.autoUpdateDisabled).toBe('1');
    // The roster serves the store's sessions as live and drivable only for what this broker created.
    const created = await createSession(client, fake, 'Owned session');
    expect(created.status).toBe(200);
    expect(created.body.session.attachMode).toBe('live');
  });

  test('the serve refuses a caller without the credential, and the broker never trips that guard itself', async () => {
    const { fake } = running;
    const url = `http://127.0.0.1:${fake.port}/global/health`;
    const rejectedBefore = fake.ledger.since(0).filter((entry) => entry.kind === 'rejected').length;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: `Basic ${Buffer.from('kilo:wrong').toString('base64')}` } })).status).toBe(401);
    const rejected = fake.ledger.since(0).filter((entry) => entry.kind === 'rejected');
    expect(rejected.slice(rejectedBefore).map((entry) => entry.credential)).toEqual(['missing', 'wrong']);
    // Everything the broker sent before and after those two probes carried the credential.
    expect(rejected.slice(0, rejectedBefore)).toEqual([]);
  });

  test('a create is one POST /session in the folder with the title, and the session row reaches the SQLite store', async () => {
    const { fake, client } = running;
    const mark = fake.ledger.mark();
    const workspace = fake.workspace('create-flow');
    const response = await client.post('/api/sessions/kilo', { directory: workspace, title: 'Create flow' });
    expect(response.status).toBe(200);
    const posts = fake.ledger.since(mark).filter((entry) => entry.kind === 'request' && entry.method === 'POST' && entry.path === '/session');
    expect(posts.length).toBe(1);
    expect((posts[0]!.query as Record<string, string>).directory).toBe(workspace);
    expect(posts[0]!.body).toMatchObject({ title: 'Create flow' });
    expect(fake.db.sessionIds()).toContain(response.body.session.id);
    expect(fake.db.load(response.body.session.id)?.info.directory).toBe(workspace);
  });

  test('an unhealthy answer is a retryable 503, a refused body an incompatible 500, and an ambiguous create is never retried', async () => {
    const { fake, client } = running;
    const settled = <T>(probe: () => Promise<T | false>, what: string) => eventually(probe, { what });
    // The health endpoint says "not now": the broker tells the app to retry.
    fake.command({ op: 'health', status: 503 });
    const temporary = await settled(async () => {
      const response = await createSession(client, fake, 'while 503');
      return response.status === 503 ? response : false;
    }, 'a 503 health answer to refuse the create');
    expect(temporary.body).toMatchObject({ code: 'SESSION_CREATE_TEMPORARILY_UNAVAILABLE', detailCode: 'kilo-server-unavailable', retryable: true });
    // The server answers but does not declare itself healthy: not retryable, not the same code.
    fake.command({ op: 'health', status: 200, body: { healthy: false } });
    const incompatible = await settled(async () => {
      const response = await createSession(client, fake, 'while unhealthy');
      return response.status === 500 ? response : false;
    }, 'an unhealthy health answer to refuse the create');
    expect(incompatible.body.error).toContain('not compatible with Drive');
    expect(incompatible.body.code).toBeUndefined();
    fake.command({ op: 'health', clear: true });
    await settled(async () => (await createSession(client, fake, 'recovered')).status === 200, 'the serve to be healthy again');
    // A 503 AFTER the serve may have accepted the create is ambiguous: one request, no blind retry, no phantom session.
    const mark = fake.ledger.mark();
    const sessionsBefore = fake.db.sessionIds().length;
    fake.command({ op: 'failNext', method: 'POST', status: 503 });
    const ambiguous = await settled(async () => {
      const response = await createSession(client, fake, 'ambiguous');
      return response.status === 500 ? response : false;
    }, 'the injected failure to reach a create');
    expect(ambiguous.body.error).toContain('may have been accepted');
    await never(() => fake.ledger.since(mark).filter((entry) => entry.kind === 'request' && entry.method === 'POST' && entry.path === '/session').length > 1,
      1_000, 'a second POST /session after an ambiguous failure');
    expect(fake.db.sessionIds().length).toBe(sessionsBefore);
  });

  // Not asserted here: an offline rewrite of the SQLite history is refused at the next prompt only once a settle
  // snapshot has recorded the rewritten row as settled, so the verdict depends on whether the turn's own settle read
  // ran first. The settled case is pinned deterministically by the adapter's drive suite; the unsettled case is the
  // known bug recorded as conformance C15.detect for Kilo.

  test('a model catalogue body beyond the bound is refused as an unavailable catalogue, never read as empty', async () => {
    const { fake, client } = running;
    const ok = await createSession(client, fake, 'catalogue ok', { model: MODEL });
    expect(ok.status).toBe(200);
    fake.command({ op: 'oversize', path: '/provider' });
    const refused = await eventually(async () => {
      const response = await createSession(client, fake, 'catalogue oversize', { model: MODEL });
      return response.status === 503 ? response : false;
    }, { what: 'the oversized catalogue to be refused' });
    expect(refused.body.code).toBe('MODEL_CATALOG_UNAVAILABLE');
    // The refusal is one-shot here: the next catalogue read is within bounds and the create goes through.
    expect((await createSession(client, fake, 'catalogue again', { model: MODEL })).status).toBe(200);
  });
});

posix('a serve that crashes is replaced and its sessions re-attached', () => {
  let running: Running;
  beforeAll(async () => {
    running = await boot('kilo-supervised', { COSYNCING_TEST_MANAGED_HOST_SUPERVISION_MS: '200' });
  });
  afterAll(async () => dispose(running));

  const crash = async () => {
    const { fake, broker } = running;
    const [original] = fake.serves().slice(-1);
    const announced = started(broker);
    fake.command({ op: 'exit', code: 1 });
    await eventually(() => !fake.isAlive(original!.pid), { what: 'the serve to exit', timeoutMs: 90_000 });
    await eventually(() => started(broker) > announced, { what: 'the broker to restart its serve', timeoutMs: 90_000 });
    const replacement = fake.serves().at(-1)!;
    expect(replacement.pid).not.toBe(original!.pid);
    return replacement;
  };

  test('the supervisor replaces a crashed serve, a session that was not open drives from the store the first serve wrote, and a new create works', async () => {
    const { fake, client } = running;
    const second = await createSession(client, fake, 'Created before the crash');
    const secondId = second.body.session.id as string;
    const serves = fake.serves().length;
    await crash();
    expect(fake.serves().length).toBe(serves + 1);
    // The session nobody had open: Drive resumes with the history the first serve wrote, and the replacement answers.
    const again = await client.attach('kilo', secondId, { mode: 'live' });
    expect((await again.waitForKind('session')).authority?.canMutate).toBe(true);
    expect((await again.sendAndAwait({ kind: 'prompt', text: 'after the crash' })).kind).toBe('ack');
    await again.waitForMessage((message) => message.type === 'model-output' && message.text === 'answer: after the crash');
    again.close();
    expect((await createSession(client, fake, 'Created after the crash')).status).toBe(200);
  });

  test.failing('a session that was open when the serve crashed can be driven again once the serve is replaced', async () => {
    const { fake, client } = running;
    const created = await createSession(client, fake, 'Open during the crash');
    const id = created.body.session.id as string;
    const open = await client.attach('kilo', id, { mode: 'live' });
    await open.waitForKind('options');
    expect((await open.sendAndAwait({ kind: 'prompt', text: 'while open' })).kind).toBe('ack');
    open.close();
    await crash();
    const row = await eventually(async () => {
      const found = (await client.sessions({ refresh: true })).find((candidate) => candidate.id === id);
      return found?.control?.drive?.supported === true ? found : undefined;
    }, { what: 'the session to be drivable again', timeoutMs: 8_000 });
    expect(row.control.drive.supported).toBe(true);
  });
});

posix('the model a session runs, across broker restarts', () => {
  let running: Running;
  beforeAll(async () => {
    running = await boot('kilo-model-evidence');
  });
  afterAll(async () => dispose(running));

  test('the create model is restored after a restart until the serve evidences another, and is never reasserted over it', async () => {
    const { broker, fake } = running;
    let client = running.client;
    const restart = async () => {
      await broker.restart();
      client = broker.client();
      await kilocodeKit.ready?.({ broker, client, fake });
    };
    const created = await createSession(client, fake, 'Model evidence', { model: { providerID: KILO_PROVIDER, modelID: 'model-b' } });
    expect(created.status, created.text).toBe(200);
    const id = created.body.session.id as string;
    expect(created.body.session.currentModel).toMatchObject({ providerID: KILO_PROVIDER, modelID: 'model-b' });
    await restart();
    const restored = await client.waitForSession((row) => row.id === id);
    expect(restored.currentModel?.modelID).toBe('model-b');
    // The first native turn runs on another model: the serve's own record of it is the evidence.
    const stream = await client.attach('kilo', id, { mode: 'live' });
    await stream.waitForKind('options');
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'on the native model', model: MODEL })).kind).toBe('ack');
    stream.close();
    await restart();
    const after = await client.waitForSession((row) => row.id === id && row.currentModel?.modelID === MODEL.modelID);
    expect(after.currentModel?.modelID).toBe('model-a');
    // And it stays there through a further restart.
    await restart();
    await never(async () => (await client.sessions({ refresh: true })).find((row) => row.id === id)?.currentModel?.modelID !== MODEL.modelID, 500, 'the create model to be reasserted');
  });
});

posix('shutdown and strangers', () => {
  let running: Running | undefined;
  let stranger: ReturnType<typeof Bun.serve> | undefined;
  afterEach(async () => {
    stranger?.stop(true);
    stranger = undefined;
    await dispose(running);
    running = undefined;
  });

  test('stopping the broker stops the serve it launched', async () => {
    running = await boot('kilo-shutdown');
    const { fake, broker } = running;
    const [serve] = fake.serves();
    expect(fake.isAlive(serve!.pid)).toBe(true);
    await broker.stop({ keepState: true });
    await eventually(() => !fake.isAlive(serve!.pid), { what: 'the serve to exit with the broker' });
    expect(broker.output()).toContain('stopped the managed kilo host');
    expect(fake.ledger.since(0).some((entry) => entry.kind === 'serve-exit' && entry.reason === 'SIGTERM')).toBe(true);
    await broker.stop();
  });

  test('a listener on the port that is not the broker\'s own serve is left alone, and nothing is created through it', async () => {
    running = await boot('kilo-stranger', {}, {
      ready: false,
      before: (fake) => {
        stranger = Bun.serve({ hostname: '127.0.0.1', port: fake.port, fetch: () => new Response('someone else', { status: 200 }) });
      },
    });
    const { broker, fake, client } = running;
    await eventually(() => /holds its address|already running|started nothing/.test(broker.output()), { what: 'the broker to decide about the occupied port' });
    expect(fake.serves()).toEqual([]);
    expect(started(broker)).toBe(0);
    const refused = await createSession(client, fake, 'through a stranger');
    expect(refused.status).toBeGreaterThanOrEqual(500);
    expect(fake.db.sessionIds()).toEqual([]);
    // Still answering after the broker has been asked to stop: it was never ours to kill.
    await broker.stop({ keepState: true });
    expect(await (await fetch(`http://127.0.0.1:${fake.port}/`)).text()).toBe('someone else');
    await broker.stop();
  });
});

posix('registration gates and the SQLite store, with no serve', () => {
  let running: Running | undefined;
  afterEach(async () => {
    await dispose(running);
    running = undefined;
  });
  const bare = (name: string, before?: (fake: KiloFake) => void | Promise<void>) =>
    boot(name, { COSYNCING_KILO_MANAGED_HOST: '0' }, { ready: false, before });
  const kiloRows = async (client: BrokerClient) => (await client.sessions({ refresh: true })).filter((row) => row.tool === 'kilo');

  test('with a store and the binary but no serve, sessions are listed observe-only and create is retryable', async () => {
    running = await bare('kilo-store-only', (fake) => {
      fake.seedSession({ title: 'Stored root' });
    });
    const { client, fake } = running;
    const rows = await eventually(async () => {
      const found = await kiloRows(client);
      return found.length > 0 ? found : false;
    }, { what: 'the stored session to be listed' });
    expect(rows[0]!.title).toBe('Stored root');
    expect(rows[0]!.attachMode).toBe('observe');
    expect(rows[0]!.control.drive.supported).toBe(false);
    expect(rows[0]!.terminalSyncHint).toBeUndefined();
    const agents = (await client.get('/api/agents')).body;
    const mine = (Array.isArray(agents) ? agents : agents.agents).find((row: { id: string }) => row.id === 'kilo');
    expect(mine).toBeDefined();
    const refused = await createSession(client, fake, 'no serve');
    expect(refused.status).toBe(503);
    expect(refused.body.retryable).toBe(true);
    expect(fake.serves()).toEqual([]);
  });

  test('without the binary and without a store there is nothing to list and nothing to create', async () => {
    running = await bare('kilo-absent', (fake) => {
      fake.setInstalled(false);
      fake.db.close();
      rmSync(fake.dataDir, { recursive: true, force: true });
    });
    const { client, fake } = running;
    const agents = (await client.get('/api/agents')).body;
    const mine = ((Array.isArray(agents) ? agents : agents.agents) as Array<{ id: string; canCreateSession: boolean }>).find((row) => row.id === 'kilo');
    expect(mine?.canCreateSession).toBe(false);
    expect(await kiloRows(client)).toEqual([]);
    expect((await createSession(client, fake, 'nothing here')).ok).toBe(false);
    expect(fake.serves()).toEqual([]);
  });

  test('rows only in the WAL are read, kilo-named databases win over the legacy one, and a journal or link is refused', async () => {
    running = await bare('kilo-databases', (fake) => {
      // Only the legacy name exists: it is used.
      fake.db.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(join(fake.dataDir, `kilo.db${suffix}`), { force: true });
    });
    const { client, fake } = running;
    const record = (id: string, title: string) => {
      const at = Date.now();
      return {
        info: { id, directory: fake.workspace('db'), title, time: { created: at, updated: at }, agent: 'code' },
        rows: [{ info: { id: `msg_${id}`, role: 'user', time: { created: at }, model: MODEL }, parts: [{ id: `prt_${id}`, type: 'text', text: title, time: { start: at, end: at } }] }],
      };
    };
    const titles = async () => (await kiloRows(client)).map((row) => row.title).sort();
    const legacy = new KiloDb(join(fake.dataDir, 'opencode.db'));
    legacy.putSessionRecord(record('ses_legacy000000001', 'Legacy only'));
    await eventually(async () => (await titles()).includes('Legacy only'), { what: 'the legacy database to be read when no kilo-named one exists' });
    // A kilo-named database appears: the legacy one is no longer consulted. Its rows live in the -wal file until
    // a checkpoint, and are still read.
    const primary = new KiloDb(join(fake.dataDir, 'kilo.db'));
    primary.putSessionRecord(record('ses_primary00000001', 'Primary in WAL'));
    expect(existsSync(join(fake.dataDir, 'kilo.db-wal'))).toBe(true);
    await eventually(async () => {
      const seen = await titles();
      return seen.includes('Primary in WAL') && !seen.includes('Legacy only');
    }, { what: 'the kilo-named database to replace the legacy one' });
    // Another kilo-named database is read too.
    const secondary = new KiloDb(join(fake.dataDir, 'kilo-extra.db'));
    secondary.putSessionRecord(record('ses_secondary000001', 'Secondary database'));
    await eventually(async () => (await titles()).includes('Secondary database'), { what: 'a second kilo-named database to be read' });
    // A rollback-journal database and a symlinked one are refused; the others stay listed.
    const journaled = new KiloDb(join(fake.dataDir, 'kilo-journal.db'), { journal: 'delete' });
    journaled.putSessionRecord(record('ses_journal00000001', 'Journal database'));
    journaled.close();
    writeFileSync(join(fake.dataDir, 'kilo-journal.db-journal'), 'leftover');
    const outside = new KiloDb(join(fake.paths.root, 'outside.db'));
    outside.putSessionRecord(record('ses_linked000000001', 'Linked database'));
    outside.close();
    symlinkSync(join(fake.paths.root, 'outside.db'), join(fake.dataDir, 'kilo-link.db'));
    const sentinel = new KiloDb(join(fake.dataDir, 'kilo-sentinel.db'));
    sentinel.putSessionRecord(record('ses_sentinel0000001', 'Sentinel database'));
    await eventually(async () => (await titles()).includes('Sentinel database'), { what: 'the sweep that saw the refused files to finish' });
    const seen = await titles();
    expect(seen).not.toContain('Journal database');
    expect(seen).not.toContain('Linked database');
    expect(seen).toEqual(expect.arrayContaining(['Primary in WAL', 'Secondary database', 'Sentinel database']));
    for (const database of [legacy, primary, secondary, sentinel]) database.close();
  });
});
