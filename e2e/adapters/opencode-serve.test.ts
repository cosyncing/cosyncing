/**
 * OpenCode's shared serve as the product runs it: the serve the broker launches and owns (its argv,
 * its config-driven restart, its teardown), what the broker does with a serve that is already
 * listening (reclaim its own orphan, leave a stranger's alone, replace one only when told to), and how
 * a live session survives a silent event stream and a serve that goes away.
 *
 * Every serve here is a fake on a leased loopback port, and every broker is given that URL
 * explicitly: nothing in this file can reach 4096 or the production broker. The managed serve is the
 * fixture's fake `opencode` binary (`harness/fakes/opencode.ts`), a real process, so the broker's
 * ownership proof (pid, start time, boot, command) runs against real process identity.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveLoopbackFixturePort } from '../../packages/typescript/broker/test/helpers/isolated-broker-fixture.ts';
import { type Broker, type BrokerClient, eventually, fixturePaths, never, startBroker } from '../harness/index.ts';
import { type FakeOpencode, installFakeOpencode, opencodeServeEnvironment } from '../harness/fakes/opencode.ts';
import { FakeOpenCodeServe } from './kits/fakes/opencode-serve.ts';
import { opencodeAllowsV1, opencodeGeneration } from '../../packages/typescript/adapters/opencode/src/generation.ts';
import {
  __setOpencodeBinOverrideForTest,
  ensureManagedOpencodeServe,
  stopManagedOpencodeServe,
} from '../../packages/typescript/adapters/opencode/src/managed-server.ts';

async function leasePort(): Promise<number> {
  const lease = await reserveLoopbackFixturePort();
  await lease.release();
  return lease.port;
}

/** Wait until the wall clock has passed `ms` after a serve started (the config watch compares mtimes in whole seconds). */
const settledAfter = (startedAt: number, ms: number) => eventually(() => Date.now() >= startedAt + ms, { what: 'the serve to be old enough for a config edit to look newer' });

const serveStartedAt = (opencode: FakeOpencode): number => {
  const entry = opencode.ledger().filter((candidate) => candidate.kind === 'serve-started').at(-1)!;
  return entry.at;
};

/** Edit the fixture user's OpenCode config, as a new provider or model does. */
function editConfig(broker: Broker): void {
  const directory = join(broker.paths.root, 'xdg-config', 'opencode');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'opencode.json');
  writeFileSync(file, JSON.stringify({ edited: Date.now() }));
  const now = new Date();
  utimesSync(file, now, now);
}

const deadline = (opencode: FakeOpencode, pid: number) => eventually(() => !opencode.isAlive(pid), { what: `serve ${pid} to exit` });

// Process identity (lsof, /proc) and the compiled fake serve are POSIX; the Windows run does not include this file.
const posix = process.platform === 'win32' ? describe.skip : describe;

posix('the serve the broker launches and owns', () => {
  let broker: Broker;
  let client: BrokerClient;
  let opencode: FakeOpencode;
  let port: number;
  let workspace: string;

  beforeAll(async () => {
    port = await leasePort();
    broker = await startBroker({
      name: 'opencode-managed',
      token: true,
      setup: (paths) => {
        workspace = join(paths.home, 'project');
        mkdirSync(workspace, { recursive: true });
        opencode = installFakeOpencode(paths, {
          installed: '1.17.19',
          sessions: [{ id: 'ses_managed', title: 'Managed session', directory: workspace }],
        });
      },
      env: {
        ...opencodeServeEnvironment(port),
        // Look at the config sooner than every 20 s (source builds only).
        COSYNCING_TEST_OPENCODE_CONFIG_WATCH_MS: '100',
        COSYNCING_OPENCODE_STARTUP_TIMEOUT_MS: '60000',
      },
    });
    client = broker.client();
  });
  afterAll(async () => {
    client?.closeAll();
    await broker?.stop({ keepState: true });
    opencode?.cleanup();
    await broker?.stop();
  });

  test('the broker launches one serve on the configured port, and its sessions are live and drivable', async () => {
    await eventually(() => opencode.serves().length === 1, { what: 'the managed serve to start' });
    const cli = opencode.ledger().filter((entry) => entry.kind === 'cli' && entry.argv?.[0] === 'serve');
    expect(cli.at(-1)!.argv).toEqual(['serve', '--hostname', '127.0.0.1', '--port', String(port)]);
    expect(opencode.ledger().find((entry) => entry.kind === 'serve-started')!.port).toBe(port);
    const row = await client.waitForSession((candidate) => candidate.id === 'ses_managed');
    expect(row.attachMode).toBe('live');
    expect(row.control.drive).toEqual({ supported: true, state: 'driving' });
    const stream = await client.attach('opencode', 'ses_managed');
    expect((await stream.waitForKind('session')).authority).toEqual({ canMutate: true, prompt: 'full' });
    stream.close();
  });

  test('a config edit restarts the serve onto the new config, and the roster survives it', async () => {
    const [first] = opencode.serves();
    await settledAfter(serveStartedAt(opencode), 1_500);
    editConfig(broker);
    await eventually(() => opencode.serves().length === 2, { what: 'the serve to restart after a config edit' });
    const replacement = opencode.serves().at(-1)!;
    expect(replacement.pid).not.toBe(first!.pid);
    await deadline(opencode, first!.pid);
    // One restart for one edit: the replacement is newer than the config.
    await client.waitForSession((candidate) => candidate.id === 'ses_managed');
    expect(opencode.serves().length).toBe(2);
  });

  test('a config edit waits for a running turn to finish, then restarts', async () => {
    const before = opencode.serves().length;
    opencode.configure({ sessions: [{ id: 'ses_managed', title: 'Managed session', directory: workspace, busy: true }] });
    await client.waitForSession((candidate) => candidate.id === 'ses_managed' && candidate.status === 'working');
    await settledAfter(serveStartedAt(opencode), 1_500);
    editConfig(broker);
    // The watch sees the newer config on every tick and defers while the session works.
    await never(() => opencode.serves().length > before, 1_500, 'a restart while a turn is running');
    opencode.configure({ sessions: [{ id: 'ses_managed', title: 'Managed session', directory: workspace }] });
    await client.waitForSession((candidate) => candidate.id === 'ses_managed' && candidate.status === 'idle');
    await eventually(() => opencode.serves().length === before + 1, { what: 'the deferred restart once idle' });
  });

  test('stopping the broker stops the serve it launched, and frees the port', async () => {
    const running = opencode.serves().at(-1)!;
    await broker.stop({ keepState: true });
    await deadline(opencode, running.pid);
    await expect(fetch(`http://127.0.0.1:${port}/session`, { signal: AbortSignal.timeout(2_000) })).rejects.toBeDefined();
  });
});

posix('a serve that is already listening when the broker starts', () => {
  const started: Array<{ opencode: FakeOpencode; broker: Broker; stranger?: Bun.Subprocess }> = [];
  afterEach(async () => {
    for (const entry of started.splice(0)) {
      entry.stranger?.kill('SIGKILL');
      await entry.stranger?.exited.catch(() => undefined);
      await entry.broker.stop({ keepState: true });
      entry.opencode.cleanup();
      await entry.broker.stop();
    }
  });

  /**
   * A broker with autoserve on at a leased port, and the fake `opencode` it would launch. With
   * `stranger`, the user's own `opencode serve` (the same fake binary, a real process the broker never
   * started) already listens on that port before the broker starts.
   */
  async function brokerAt(port: number, options: { env?: Record<string, string>; stranger?: boolean; installed?: string } = {}): Promise<{ broker: Broker; opencode: FakeOpencode; stranger?: Bun.Subprocess }> {
    let opencode!: FakeOpencode;
    let stranger: Bun.Subprocess | undefined;
    const broker = await startBroker({
      name: 'opencode-takeover',
      token: true,
      setup: async (paths) => {
        const workspace = join(paths.home, 'project');
        mkdirSync(workspace, { recursive: true });
        opencode = installFakeOpencode(paths, {
          installed: options.stranger ? '1.17.19' : options.installed ?? '1.17.19',
          sessions: [{ id: 'ses_listening', title: 'Listening session', directory: workspace }],
        });
        if (options.stranger) {
          stranger = Bun.spawn([opencode.executable, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
            stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
          });
          await eventually(() => opencode.serves().length === 1, { what: 'the stranger serve to listen' });
          if (options.installed) opencode.configure({ installed: options.installed });
        }
      },
      env: { ...opencodeServeEnvironment(port), COSYNCING_OPENCODE_STARTUP_TIMEOUT_MS: '60000', ...options.env },
    });
    started.push({ opencode, broker, ...(stranger ? { stranger } : {}) });
    return { broker, opencode, ...(stranger ? { stranger } : {}) };
  }

  test('a serve this broker started before it crashed is reclaimed, not duplicated', async () => {
    const port = await leasePort();
    const { broker, opencode } = await brokerAt(port);
    // The broker records ownership once it has seen its serve answer, which is after the serve starts.
    await eventually(() => broker.output().includes('managed opencode serve ready'), { what: 'the broker to own its serve' });
    const orphan = opencode.serves()[0]!;
    // Ownership is recorded durably when the serve is spawned; a crash leaves the serve running.
    await broker.crash();
    expect(opencode.isAlive(orphan.pid)).toBe(true);
    await broker.start();
    await eventually(() => opencode.serves().length === 2, { what: 'the replacement serve under the new broker' });
    await deadline(opencode, orphan.pid);
    expect(opencode.ledger().some((entry) => entry.kind === 'serve-exit' && entry.pid === orphan.pid)).toBe(true);
    const row = await broker.client().waitForSession((candidate) => candidate.id === 'ses_listening');
    expect(row.attachMode).toBe('live');
  });

  test('a serve the broker did not start is left untouched, and its sessions still work', async () => {
    const port = await leasePort();
    const { broker, opencode, stranger } = await brokerAt(port, { stranger: true });
    // The broker has looked at the port: its roster is served by the stranger, and it said why it did not take it.
    const row = await broker.client().waitForSession((candidate) => candidate.id === 'ses_listening');
    expect(row.attachMode).toBe('live');
    await eventually(() => broker.output().includes('did not start'), { what: 'the broker to say it left the serve alone' });
    expect(opencode.serves().map((serve) => serve.pid)).toEqual([stranger!.pid]);
    expect(opencode.isAlive(stranger!.pid)).toBe(true);
  });

  test('a serve the broker did not start is replaced only when the operator says so', async () => {
    const port = await leasePort();
    const { opencode, stranger } = await brokerAt(port, { stranger: true, env: { COSYNCING_OPENCODE_REPLACE_UNOWNED_SERVE: '1' } });
    await eventually(() => opencode.serves().length === 2, { what: 'the replacement serve' });
    await deadline(opencode, stranger!.pid);
    expect(opencode.serves().at(-1)!.pid).not.toBe(stranger!.pid);
  });

  test('with OpenCode 2.1.4 installed, startup launches nothing', async () => {
    const { broker, opencode } = await brokerAt(await leasePort(), { installed: '2.1.4' });
    await eventually(() => broker.output().includes('detected but not supported'), { what: 'the generation guard' });
    expect((await broker.client().agents()).find((agent) => agent.id === 'opencode')?.canCreateSession).toBe(false);
    expect(opencode.ledger().filter((entry) => entry.kind === 'cli' && entry.argv?.[0] !== '--version')).toEqual([]);
  });

  test('a proven V1 orphan is reclaimed after a V2 upgrade, without a replacement', async () => {
    const { broker, opencode } = await brokerAt(await leasePort());
    await eventually(() => broker.output().includes('managed opencode serve ready'), { what: 'the broker to record ownership' });
    const orphan = opencode.serves()[0]!;
    await broker.crash();
    opencode.configure({ installed: '2.1.4' });
    await broker.start();
    await deadline(opencode, orphan.pid);
    await eventually(() => broker.output().includes('detected but not supported'), { what: 'the post-reclaim guard' });
    expect(opencode.serves()).toHaveLength(1);
  });

  test('a V2 binary leaves an unowned V1 listener untouched', async () => {
    const { broker, opencode, stranger } = await brokerAt(await leasePort(), { stranger: true, installed: '2.1.4' });
    await eventually(() => broker.output().includes('did not start'), { what: 'the unowned-listener decision' });
    expect(opencode.isAlive(stranger!.pid)).toBe(true);
    expect(opencode.serves()).toHaveLength(1);
  });

  test('an unparsable version retains V1 autoserve behavior', async () => {
    const { broker, opencode } = await brokerAt(await leasePort(), { installed: 'development-build' });
    await eventually(() => broker.output().includes('managed opencode serve ready'), { what: 'the legacy unknown-version startup' });
    expect(opencode.serves()).toHaveLength(1);
    expect((await broker.client().waitForSession((row) => row.id === 'ses_listening')).attachMode).toBe('live');
  });

  test('with autoserve off, the broker launches nothing', async () => {
    const port = await leasePort();
    const { broker, opencode } = await brokerAt(port, { env: { COSYNCING_OPENCODE_NO_AUTOSERVE: '1' } });
    // A later event than the launch decision: the agent roster answers, and says the serve is not there.
    const agents = await broker.client().agents();
    expect(agents.find((agent) => agent.id === 'opencode')?.canCreateSession).toBe(false);
    await never(() => opencode.serves().length > 0, 750, 'a serve launched with autoserve off');
    expect(opencode.ledger().filter((entry) => entry.kind === 'cli' && entry.argv?.[0] === 'serve')).toEqual([]);
  });
});

describe('a live session when its serve misbehaves', () => {
  let broker: Broker;
  let client: BrokerClient;
  let serve: FakeOpenCodeServe;
  let cwd: string;
  let id: string;
  const requests: Array<{ method: string; path: string }> = [];
  let reconnectGate: Promise<void> | undefined;
  let releaseReconnect = () => {};
  let waitingReconnects = 0;

  beforeAll(async () => {
    serve = new FakeOpenCodeServe({
      intercept: async (request, next) => {
        const gate = reconnectGate;
        if (gate && new URL(request.url).pathname === '/global/event') {
          waitingReconnects += 1;
          await gate;
        }
        return next(request);
      },
      record: (entry) => {
        if (entry.kind === 'request') requests.push({ method: entry.method, path: entry.path });
      },
      models: [{ providerID: 'test-provider', modelID: 'model-a', name: 'Model A' }],
    });
    serve.start();
    broker = await startBroker({
      name: 'opencode-events',
      token: true,
      setup: (paths) => {
        cwd = join(paths.home, 'project');
        mkdirSync(cwd, { recursive: true });
        id = 'ses_events';
        serve.seed({ id, directory: cwd, title: 'Events', turns: 1 });
      },
      env: {
        OPENCODE_URL: serve.url,
        COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
        // The silence the adapter treats as a hung stream, and how soon it reconnects (production: 120 s and 15 s).
        COSYNCING_OPENCODE_SSE_IDLE_MS: '400',
        COSYNCING_OPENCODE_SSE_RECONNECT_MS: '50',
        // A session nobody holds open is dropped after this long (production: 15 s; source builds only).
        COSYNCING_TEST_HUB_EVICT_GRACE_MS: '300',
      },
    });
    client = broker.client();
  });
  afterAll(async () => {
    releaseReconnect();
    client?.closeAll();
    serve?.releaseAll();
    serve?.stop();
    await broker?.stop();
  });

  const connects = () => requests.filter((request) => request.method === 'GET' && request.path === '/global/event').length;

  test('a silent event stream reconnects, replays a turn completed in the gap, and keeps working', async () => {
    const stream = await client.attach('opencode', id);
    await stream.waitForKind('session');
    await stream.waitForKind('history');
    const first = connects();
    reconnectGate = new Promise<void>((resolve) => { releaseReconnect = resolve; });
    try {
      // Hold the replacement streams at the native HTTP boundary. The old
      // streams have gone silent and the broker has tried to replace them.
      await eventually(() => waitingReconnects >= 2, { what: 'replacement event streams waiting at the serve' });
      serve.appendTurn(id, 'during the reconnect', 'answer completed while disconnected');
    } finally {
      reconnectGate = undefined;
      releaseReconnect();
    }
    serve.setHeartbeat(100);
    await stream.waitForMessage((message) => message.type === 'model-output' && message.text === 'answer completed while disconnected');
    expect(connects()).toBeGreaterThanOrEqual(first + 2);
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'after the reconnect' })).kind).toBe('ack');
    await stream.waitForMessage((message) => message.type === 'model-output' && message.text === 'answer: after the reconnect');
    expect(stream.frames.filter((frame) => frame.kind === 'session' && frame.info?.control?.drive?.state === 'unavailable')).toEqual([]);
    serve.setHeartbeat(0);
    stream.close();
  });

  test('a serve that goes away leaves the session read-only, and a serve that comes back is driven again', async () => {
    serve.setHeartbeat(100);
    const stream = await client.attach('opencode', id);
    await stream.waitForKind('session');
    const port = serve.port;
    serve.stop();
    const from = stream.frames.length;
    await stream.waitForMessage((message) => message.type === 'error' && /shared server disconnected/i.test(String(message.message)));
    await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.control?.drive?.state === 'unavailable',
      { after: from, what: 'the control to turn unavailable' });
    const refused = await stream.sendAndAwait({ kind: 'prompt', text: 'nobody is listening' });
    expect(refused.kind).toBe('nack');
    stream.close();
    // The serve returns on the same port. The dead connection is dropped once nobody holds it, and a
    // fresh attach is then the writer again.
    serve.start(port);
    const again = await eventually(async () => {
      const candidate = await client.attach('opencode', id);
      const session = await candidate.waitForKind('session');
      if (session.authority?.canMutate === true) return candidate;
      candidate.close();
      return undefined;
      // Poll slower than the eviction grace, so the dead connection is let go between attempts.
    }, { what: 'a fresh attach to be the writer again', intervalMs: 600 });
    serve.setHeartbeat(100);
    await eventually(() => serve.openStreams().filter((open) => open.heartbeats >= 2).length >= 2, { what: 'the broker streams to hear the returned serve' });
    expect((await again.sendAndAwait({ kind: 'prompt', text: 'after the serve returned' })).kind).toBe('ack');
    await again.waitForMessage((message) => message.type === 'model-output' && message.text === 'answer: after the serve returned');
    again.close();
  });
});

// Narrow clock-driven policy exception (docs/development/testing.md): the broker subprocess
// has no public cache clock. An HTTP-only expiry test would need a real minute or a new test API.
// Keep this in the existing OpenCode suite, use a real fake CLI, and exercise the spawn boundary too.
test('a failed version probe expires, recovers V2, and prevents a managed spawn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-opencode-probe-recovery-'));
  const paths = fixturePaths(root);
  const opencode = installFakeOpencode(paths, { installed: '2.1.4', failFirstVersionProbe: true });
  const overrides = opencodeServeEnvironment(await leasePort());
  const previousEnv = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  const readGeneration = () => opencodeGeneration(process.env, process.platform, opencode.executable);
  const probes = () => opencode.ledger().filter((entry) => entry.kind === 'cli').map((entry) => entry.argv);
  const start = Date.UTC(2030, 0, 1);
  try {
    Object.assign(process.env, overrides);
    __setOpencodeBinOverrideForTest(opencode.executable);
    setSystemTime(start);
    const failed = readGeneration();
    expect(failed.kind).toBe('unparsable');
    expect(opencodeAllowsV1(failed)).toBe(true);
    setSystemTime(start + 59_999);
    expect(readGeneration().kind).toBe('unparsable');
    expect(probes()).toEqual([['--version']]);

    setSystemTime(start + 60_000);
    const recovered = readGeneration();
    expect(recovered).toMatchObject({ kind: 'v2', version: '2.1.4' });
    expect(opencodeAllowsV1(recovered)).toBe(false);
    setSystemTime(); // Keep the asynchronous launch boundary on the real clock.
    await ensureManagedOpencodeServe();
    expect(opencode.serves()).toEqual([]);
    expect(probes()).toEqual([['--version'], ['--version']]);

    // Successful probes have no expiry, whether recognized or unrecognized.
    setSystemTime(start + 86_400_000);
    expect(readGeneration()).toMatchObject({ kind: 'v2', version: '2.1.4' });
    expect(probes()).toHaveLength(2);
    opencode.configure({ installed: 'development-build' });
    expect(readGeneration()).toMatchObject({ kind: 'unparsable', version: 'development-build' });
    setSystemTime(start + 2 * 86_400_000);
    expect(readGeneration()).toMatchObject({ kind: 'unparsable', version: 'development-build' });
    expect(probes()).toHaveLength(3);

    // Startup must recover a transient probe failure before it can launch V2, without
    // waiting for the display cache to expire. Reuse the fake with a new binary identity.
    setSystemTime();
    opencode.configure({ installed: '2.1.4' });
    rmSync(join(opencode.state, 'failed-version-probe'));
    const startupOffset = probes().length;
    await ensureManagedOpencodeServe();
    expect(opencode.serves()).toEqual([]);
    expect(probes().slice(startupOffset)).toEqual([['--version'], ['--version']]);

    // The same launch check must bypass a failure already cached by a roster/display read.
    opencode.configure({ installed: '2.1.5' });
    rmSync(join(opencode.state, 'failed-version-probe'));
    const cachedFailureOffset = probes().length;
    expect(readGeneration().kind).toBe('unparsable');
    expect(readGeneration().kind).toBe('unparsable');
    expect(probes().slice(cachedFailureOffset)).toEqual([['--version']]);
    await ensureManagedOpencodeServe();
    expect(opencode.serves()).toEqual([]);
    expect(probes().slice(cachedFailureOffset)).toEqual([['--version'], ['--version']]);
  } finally {
    setSystemTime();
    try {
      await stopManagedOpencodeServe();
      opencode.cleanup();
    } finally {
      __setOpencodeBinOverrideForTest(null);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
});
